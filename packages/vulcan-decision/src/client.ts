/**
 * Client of the resident service for host plugins running in Node. It starts the service when
 * needed, keeps one connection open so the service stays loaded while the host runs, and sends
 * each request over its own short-lived connection.
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

import { encodeFrame, readFrames } from './frame.js'
import { endpointPath } from './paths.js'
import {
  CONTRACT_VERSION,
  DecisionError,
  type JudgeCall,
  type JudgeSettings,
  type Request,
  type Response,
  type ServiceStatus,
  type Verdict,
} from './protocol.js'

export { CONTRACT_VERSION, DecisionError }
export type { Decision, DecisionOptions, ErrorCode, JudgeCall, JudgeSettings, ModelSize, ServiceStatus, Verdict } from './protocol.js'

/** How long a starting service may take before the start counts as failed. */
const START_TIMEOUT_MS = 15_000
const START_POLL_MS = 100

/** The command-line entry that runs `serve`; resolved next to this file. */
const CLI_ENTRY = fileURLToPath(new URL('../bin/vulcan-decision.js', import.meta.url))

export class DecisionClient {
  #starting: Promise<string> | undefined
  #keepalive: net.Socket | undefined
  #closed = false

  /** Start the service when needed and open the keepalive connection. @returns the endpoint. */
  start(): Promise<string> {
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined
      throw error
    })
    return this.#starting
  }

  /**
   * Judge one call. A failed exchange restarts the service once before giving up.
   * @throws DecisionError for answers the service gave, other errors for transport failures;
   * callers must never treat either as an allow.
   */
  async judge(call: JudgeCall, settings: JudgeSettings, signal: AbortSignal): Promise<Verdict> {
    const response = await this.#request({ type: 'judge', contract: CONTRACT_VERSION, call, settings }, signal)
    if (response.type === 'verdict') return response.verdict
    throw unexpected(response)
  }

  /** The running service's status, starting it when needed. */
  async status(signal: AbortSignal): Promise<ServiceStatus> {
    const response = await this.#request({ type: 'status', contract: CONTRACT_VERSION }, signal)
    if (response.type === 'status') return response.status
    throw unexpected(response)
  }

  /** Close the keepalive connection; the service then idles out on its own. */
  close(): void {
    this.#closed = true
    this.#reset()
  }

  async #request(request: Request, signal: AbortSignal): Promise<Response> {
    try {
      return await exchange(await this.start(), request, signal)
    } catch (error) {
      if (signal.aborted || this.#closed || error instanceof DecisionError) throw error
      this.#reset()
      return await exchange(await this.start(), request, signal)
    }
  }

  async #start(): Promise<string> {
    if (this.#closed) throw new Error('the decision client is closed')
    const endpoint = endpointPath()
    const signal = AbortSignal.timeout(START_TIMEOUT_MS)
    let pong = await ping(endpoint, signal).catch(() => undefined)
    if (pong?.type === 'contract_mismatch') {
      // An older or newer service owns the endpoint; replace it with the one shipped here.
      await exchange(endpoint, { type: 'shutdown' }, signal).catch(() => {})
      await waitUntilGone(endpoint, signal)
      pong = undefined
    }
    if (pong === undefined) {
      spawnService()
      pong = await waitForService(endpoint, signal)
    }
    if (pong.type !== 'pong') throw unexpected(pong)
    this.#openKeepalive(endpoint)
    return endpoint
  }

  #openKeepalive(endpoint: string): void {
    const socket = net.connect(endpoint)
    socket.unref()
    // A lost keepalive means the service may be gone; the next call starts it again.
    const lost = (): void => {
      if (this.#keepalive === socket) this.#reset()
    }
    socket.on('error', lost)
    socket.on('close', lost)
    this.#keepalive = socket
  }

  #reset(): void {
    this.#starting = undefined
    const socket = this.#keepalive
    this.#keepalive = undefined
    socket?.destroy()
  }
}

/** Start `vulcan-decision serve` detached from the caller, with the caller's Node runtime. */
export function spawnService(): void {
  const child = spawn(process.execPath, [CLI_ENTRY, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Lets an Electron-hosted caller run the entry as plain Node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
}

/** Send `ping` and return the answer. */
export function ping(endpoint: string, signal: AbortSignal): Promise<Response> {
  return exchange(endpoint, { type: 'ping', contract: CONTRACT_VERSION }, signal)
}

async function waitForService(endpoint: string, signal: AbortSignal): Promise<Response> {
  for (;;) {
    const answer = await ping(endpoint, signal).catch(() => undefined)
    if (answer !== undefined) return answer
    if (signal.aborted) throw new Error('the decision service did not start in time')
    await sleep(START_POLL_MS)
  }
}

async function waitUntilGone(endpoint: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && await ping(endpoint, signal).then(() => true, () => false)) await sleep(START_POLL_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Send one request over its own connection and read the single response line.
 * @throws DecisionError when the service answered with an error.
 */
export function exchange(endpoint: string, request: Request, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const socket = net.connect(endpoint)
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      outcome()
    }
    const fail = (error: unknown): void => finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    const onAbort = (): void => fail(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('the decision service closed the connection')))
    readFrames(socket, (frame) => {
      const response = frame as Response
      if (response.type === 'error') finish(() => reject(new DecisionError(response.code, response.message)))
      else finish(() => resolve(response))
    }, fail)
    socket.write(encodeFrame(request))
  })
}

function unexpected(response: Response): Error {
  if (response.type === 'contract_mismatch') {
    return new Error(`the decision service speaks contract ${response.contract}, this client speaks ${CONTRACT_VERSION}`)
  }
  return new Error(`the decision service answered ${JSON.stringify(response)}`)
}
