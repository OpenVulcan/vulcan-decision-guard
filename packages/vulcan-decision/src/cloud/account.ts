/**
 * The OpenVulcan account of this device.
 *
 * Signing in is a PKCE (S256) flow with a loopback callback: the host opens the approval page in a
 * browser, the user approves, the browser is sent back to `http://127.0.0.1:<port>/vulcancode/auth/callback`
 * and the code is exchanged once for a device credential. The credential is an opaque token sent as
 * `Authorization: Auth <token>` to the site's own auth host only. It lasts 14 days and is rotated
 * by a single-use refresh once less than a day remains; a rotation that may have been interrupted
 * forces a fresh sign-in instead of guessing which token is current.
 *
 * Where the credential is kept is up to the host: dsh keeps it in its credential store, the command
 * line in an owner-only file. This module never logs or returns the token itself.
 */

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'

import { writeFileAtomic } from '../home.js'
import { DecisionError } from '../protocol.js'

/** OpenVulcan deployments. The account's site is fixed when it signs in. */
export const SITES = {
  cn: { auth: 'https://auth.openvulcan.cn', api: 'https://api.openvulcan.cn' },
  global: { auth: 'https://auth.openvulcan.com', api: 'https://api.openvulcan.com' },
} as const
export type Site = keyof typeof SITES

export function isSite(value: unknown): value is Site {
  return value === 'cn' || value === 'global'
}

/** The stored device credential. */
export interface Credential {
  readonly site: Site
  /** Origin of the auth host, kept so tests can sign in against a local authority. */
  readonly auth_origin: string
  readonly access_token: string
  readonly authorization_id: string
  /** RFC 3339. */
  readonly expires_at: string
  /** Set while a refresh is in flight; still set afterwards means the rotation was interrupted. */
  readonly rotation_pending?: boolean
}

/** Where a host keeps the credential. */
export interface CredentialStore {
  read(): Promise<Credential | undefined>
  write(credential: Credential): Promise<void>
  delete(): Promise<void>
}

/** An owner-only JSON file, for the command line. */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly file: string) {}

  async read(): Promise<Credential | undefined> {
    try {
      return parseCredential(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch {
      return undefined
    }
  }

  async write(credential: Credential): Promise<void> {
    writeFileAtomic(this.file, `${JSON.stringify(credential, null, 2)}\n`)
  }

  async delete(): Promise<void> {
    fs.rmSync(this.file, { force: true })
  }
}

/** Accept a stored credential only when every field has its expected shape. */
export function parseCredential(value: unknown): Credential | undefined {
  const record = value as Partial<Credential> | null
  if (typeof record !== 'object' || record === null) return undefined
  if (!isSite(record.site) || typeof record.auth_origin !== 'string' || typeof record.access_token !== 'string'
    || typeof record.authorization_id !== 'string' || typeof record.expires_at !== 'string' || Number.isNaN(Date.parse(record.expires_at))) {
    return undefined
  }
  return {
    site: record.site, auth_origin: record.auth_origin, access_token: record.access_token,
    authorization_id: record.authorization_id, expires_at: record.expires_at,
    ...record.rotation_pending === true ? { rotation_pending: true } : {},
  }
}

/** Refresh once less than this remains. */
export const REFRESH_AHEAD_MS = 24 * 60 * 60_000
const CALLBACK_PATH = '/vulcancode/auth/callback'
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/
const REQUEST_TIMEOUT_MS = 15_000

/** What the user sees about the device on the approval page. */
export interface DeviceInfo {
  readonly display_name: string
  readonly client_version: string
}

/** The account as a host shows it; never contains the token. */
export interface AccountStatus {
  readonly signedIn: boolean
  readonly site?: Site
  readonly authorizationId?: string
  readonly expiresAt?: string
  /** A refresh was interrupted; the user has to sign in again. */
  readonly reauthRequired?: boolean
}

/** A sign-in waiting for the user's approval. */
export interface PendingSignIn {
  readonly approvalUrl: string
  readonly expiresAt: string
  /** Settles when the user approved (the credential is stored) or the sign-in failed. */
  readonly done: Promise<AccountStatus>
  /** Stop waiting; a credential that already arrived is revoked. */
  cancel(): void
}

export class OpenVulcanAccount {
  private refreshing: Promise<Credential> | undefined

  constructor(
    private readonly store: CredentialStore,
    private readonly device: DeviceInfo,
    /** Overrides the auth origin of every site; tests point it at a local authority. */
    private readonly authOrigin?: string,
  ) {}

  async status(): Promise<AccountStatus> {
    const credential = await this.store.read()
    if (credential === undefined) return { signedIn: false }
    return {
      signedIn: credential.rotation_pending !== true && Date.parse(credential.expires_at) > Date.now(),
      site: credential.site,
      authorizationId: credential.authorization_id,
      expiresAt: credential.expires_at,
      ...credential.rotation_pending === true ? { reauthRequired: true } : {},
    }
  }

  /** Begin signing in to `site`. */
  async signIn(site: Site): Promise<PendingSignIn> {
    const origin = this.authOrigin ?? SITES[site].auth
    const state = base64url(randomBytes(32))
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())

    let settle!: { resolve: (code: string) => void; reject: (error: Error) => void }
    const callback = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const keys = [...url.searchParams.keys()].sort()
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH || keys.join(',') !== 'code,state' || url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid sign-in callback.')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><title>Vulcan Decision</title><p>Signed in. You can close this page.</p>')
      settle.resolve(url.searchParams.get('code') ?? '')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const close = () => server.close()

    let begin: { request_id: string; approval_url: string; expires_at: string }
    try {
      begin = await postJson(`${origin}/api/v1/vulcancode/authorize`, undefined, {
        callback_uri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        device: {
          display_name: this.device.display_name.slice(0, 64),
          operating_system: operatingSystem(),
          architecture: architecture(),
          client_version: this.device.client_version.slice(0, 32),
        },
      }) as typeof begin
      checkApprovalUrl(begin.approval_url, origin, state)
    } catch (error) {
      close()
      throw error
    }

    let cancelled = false
    const timeout = setTimeout(() => settle.reject(new DecisionError('not_signed_in', 'the sign-in request expired')),
      Math.max(0, Date.parse(begin.expires_at) - Date.now()) || 600_000)
    const done = (async (): Promise<AccountStatus> => {
      try {
        const code = await callback
        const answer = await postJson(`${origin}/api/v1/vulcancode/token`, undefined, { code, code_verifier: verifier })
        const credential = tokenAnswer(answer, site, origin)
        if (cancelled) {
          await revoke(credential)
          throw new DecisionError('not_signed_in', 'the sign-in was cancelled')
        }
        await this.store.write(credential)
        return await this.status()
      } finally {
        clearTimeout(timeout)
        close()
      }
    })()
    done.catch(() => {})
    return {
      approvalUrl: begin.approval_url,
      expiresAt: begin.expires_at,
      done,
      cancel: () => {
        cancelled = true
        settle.reject(new DecisionError('not_signed_in', 'the sign-in was cancelled'))
      },
    }
  }

  /** Revoke the credential on the server and forget it here. */
  async signOut(): Promise<void> {
    const credential = await this.store.read()
    await this.store.delete()
    if (credential !== undefined) await revoke(credential)
  }

  /**
   * A usable credential, refreshed first when less than a day remains.
   * @throws DecisionError `not_signed_in` when there is none or it can no longer be trusted.
   */
  async credential(): Promise<Credential> {
    const credential = await this.store.read()
    if (credential === undefined) throw new DecisionError('not_signed_in', 'not signed in to OpenVulcan')
    if (credential.rotation_pending === true) throw new DecisionError('not_signed_in', 'a credential rotation was interrupted; sign in to OpenVulcan again')
    const remaining = Date.parse(credential.expires_at) - Date.now()
    if (remaining <= 0) throw new DecisionError('not_signed_in', 'the OpenVulcan sign-in expired; sign in again')
    if (remaining > REFRESH_AHEAD_MS) return credential
    this.refreshing ??= this.refresh(credential).finally(() => {
      this.refreshing = undefined
    })
    return await this.refreshing
  }

  private async refresh(credential: Credential): Promise<Credential> {
    await this.store.write({ ...credential, rotation_pending: true })
    let answer: unknown
    try {
      answer = await postJson(`${credential.auth_origin}/api/v1/vulcancode/token/refresh`, credential.access_token, {})
    } catch (error) {
      // A refusal means the credential is gone; anything else leaves the rotation pending.
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) await this.store.delete()
      throw new DecisionError('not_signed_in', `refreshing the OpenVulcan sign-in failed: ${(error as Error).message}`)
    }
    const next = tokenAnswer(answer, credential.site, credential.auth_origin)
    if (next.authorization_id !== credential.authorization_id) {
      await this.store.delete()
      throw new DecisionError('not_signed_in', 'the refreshed credential belongs to another device authorization')
    }
    await this.store.write(next)
    return next
  }
}

async function revoke(credential: Credential): Promise<void> {
  try {
    await postJson(`${credential.auth_origin}/api/v1/vulcancode/logout`, credential.access_token, {})
  } catch (error) {
    // An already invalid credential is as good as revoked.
    if (!(error instanceof HttpError && error.status === 401)) throw error
  }
}

function tokenAnswer(value: unknown, site: Site, origin: string): Credential {
  const answer = value as { access_token?: unknown; token_type?: unknown; expires_at?: unknown; authorization_id?: unknown; site?: unknown }
  if (typeof answer?.access_token !== 'string' || !ACCESS_TOKEN.test(answer.access_token) || answer.token_type !== 'Auth'
    || typeof answer.expires_at !== 'string' || Number.isNaN(Date.parse(answer.expires_at))
    || typeof answer.authorization_id !== 'string' || answer.authorization_id === '') {
    throw new DecisionError('not_signed_in', 'OpenVulcan answered a malformed credential')
  }
  if (answer.site !== undefined && answer.site !== site) throw new DecisionError('not_signed_in', 'OpenVulcan answered for another site')
  return { site, auth_origin: origin, access_token: answer.access_token, authorization_id: answer.authorization_id, expires_at: answer.expires_at }
}

function checkApprovalUrl(value: unknown, origin: string, state: string): void {
  if (typeof value !== 'string') throw new DecisionError('not_signed_in', 'OpenVulcan answered no approval page')
  const url = new URL(value)
  const keys = [...url.searchParams.keys()].sort().join(',')
  if (url.origin !== origin || url.pathname !== '/authorize' || keys !== 'request_id,state' || url.searchParams.get('state') !== state) {
    throw new DecisionError('not_signed_in', 'OpenVulcan answered an unexpected approval page')
  }
}

/** An HTTP answer outside 2xx. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'HttpError'
  }
}

/** POST JSON, with `Authorization: Auth <token>` when a token is given. */
export async function postJson(url: string, token: string | undefined, body: unknown): Promise<unknown> {
  return await requestJson(url, token, { method: 'POST', body: JSON.stringify(body) })
}

export async function requestJson(url: string, token: string | undefined, init: { method: string; body?: string }): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Accept': 'application/json',
      ...init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...token === undefined ? {} : { Authorization: `Auth ${token}` },
    },
    ...init.body === undefined ? {} : { body: init.body },
  })
  const text = await response.text()
  if (!response.ok) {
    let code: string | undefined
    let message = `HTTP ${response.status}`
    try {
      const envelope = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } | string; message?: unknown }
      if (typeof envelope.error === 'object' && envelope.error !== null) {
        code = typeof envelope.error.code === 'string' ? envelope.error.code : undefined
        if (typeof envelope.error.message === 'string') message += `: ${envelope.error.message}`
      } else if (typeof envelope.error === 'string') {
        code = envelope.error
        if (typeof envelope.message === 'string') message += `: ${envelope.message}`
      }
    } catch {
      // A non-JSON error body carries nothing more.
    }
    throw new HttpError(response.status, code, code === undefined ? message : `${message} (${code})`, retryAfter(response.headers.get('Retry-After')))
  }
  return text === '' ? {} : JSON.parse(text)
}

export function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function operatingSystem(): string {
  const name = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform as string] ?? process.platform
  return `${name} ${os.release()}`.slice(0, 64)
}

function architecture(): string {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64'
}
