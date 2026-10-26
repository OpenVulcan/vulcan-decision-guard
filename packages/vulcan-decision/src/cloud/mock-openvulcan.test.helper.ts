/**
 * A loopback stand-in for OpenVulcan in tests: the auth host's device sign-in and edge-access
 * endpoints, and any number of edge endpoints. Nothing here talks to a real service.
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { POLICY_VERSION, type JudgeInput } from '../protocol.js'

export interface MockEdgeOptions {
  readonly id: string
  /** Delay before every answer, so probes rank endpoints. */
  readonly delayMs?: number
  /** Reported compute time; null reports none. */
  readonly computeP50?: number | null
}

export interface MockEdge {
  readonly id: string
  readonly origin: string
  judged: number
  /** Answer the next judgement with this HTTP status instead. */
  failNext: number | undefined
}

export interface MockOpenVulcan {
  readonly origin: string
  readonly site: 'cn' | 'global'
  readonly model: string
  readonly edges: readonly MockEdge[]
  /** How long issued credentials last. */
  credentialLifetimeMs: number
  /** Answer refreshes with this status instead. */
  refreshStatus: number | undefined
  readonly revoked: string[]
  readonly grantsIssued: () => number
  /** Approve a pending sign-in the way a browser would: follow the approval page to the callback. */
  approve(approvalUrl: string): Promise<void>
  close(): Promise<void>
}

/** The decision the mock endpoints answer: review for database drops, allow for the rest. */
export function mockDecision(input: JudgeInput): 'allow' | 'review' {
  return /DROP DATABASE/i.test(input.rendered) ? 'review' : 'allow'
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text === '' ? {} : JSON.parse(text) as Record<string, unknown>
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
}

export async function startMockOpenVulcan(options: {
  readonly site?: 'cn' | 'global'
  readonly model?: string
  readonly edges?: readonly MockEdgeOptions[]
} = {}): Promise<MockOpenVulcan> {
  const site = options.site ?? 'cn'
  const model = options.model ?? 'vulcan-decision-shell-v1-mini-preview'
  const pending = new Map<string, { callback: string; state: string; challenge: string; code?: string }>()
  const credentials = new Map<string, string>()
  const grants = new Set<string>()
  let grantCount = 0
  const servers: http.Server[] = []

  const edges: MockEdge[] = []
  for (const edgeOptions of options.edges ?? [{ id: 'edge-a' }]) {
    const edge: MockEdge = { id: edgeOptions.id, origin: '', judged: 0, failNext: undefined }
    const server = http.createServer((request, response) => {
      setTimeout(() => {
        void (async () => {
          const url = new URL(request.url ?? '/', edge.origin)
          if (request.method === 'GET' && url.pathname === '/v1/status') {
            const compute = edgeOptions.computeP50 === undefined ? 5 : edgeOptions.computeP50
            json(response, 200, {
              endpoint_id: edge.id, model_id: model, region: 'test', sites: [site], ready: true,
              compute_ms: compute === null ? null : { p50: compute, p95: compute * 2 },
            })
            return
          }
          if (request.method === 'POST' && url.pathname === '/v1/judge') {
            const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
            const payload = await body(request) as { request_id: string; inputs: JudgeInput[] }
            if (edge.failNext !== undefined) {
              const status = edge.failNext
              edge.failNext = undefined
              json(response, status, { error: status === 401 ? 'invalid_token' : 'failed' })
              return
            }
            if (!grants.has(bearer) || request.headers['x-openvulcan-site'] !== site) {
              json(response, 401, { error: 'invalid_token' })
              return
            }
            edge.judged += payload.inputs.length
            json(response, 200, {
              request_id: payload.request_id,
              checkpoint_sha256: 'a'.repeat(64),
              policy_version: POLICY_VERSION,
              results: payload.inputs.map(input => ({ label: mockDecision(input), logits: [1, 0, -1], input_tokens: 12, model_evaluated: true })),
            })
            return
          }
          json(response, 404, { error: 'not_found' })
        })()
      }, edgeOptions.delayMs ?? 0)
    })
    servers.push(server)
    edges.push(Object.assign(edge, { origin: await listen(server) }))
  }

  const mock = {
    origin: '', site, model, edges, credentialLifetimeMs: 14 * 24 * 3_600_000,
    refreshStatus: undefined as number | undefined, revoked: [] as string[],
    grantsIssued: () => grantCount,
    async approve(approvalUrl: string) {
      const response = await fetch(approvalUrl)
      if (!response.ok) throw new Error(`approval failed: HTTP ${response.status}`)
    },
    async close() {
      await Promise.all(servers.map(server => new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })))
    },
  }

  const issue = (authorization: string) => {
    const access = token()
    credentials.set(access, authorization)
    return { access_token: access, token_type: 'Auth', expires_at: new Date(Date.now() + mock.credentialLifetimeMs).toISOString(), authorization_id: authorization, site }
  }
  const signedIn = (request: http.IncomingMessage): string | undefined => {
    const access = request.headers.authorization?.replace(/^Auth /, '')
    return access === undefined ? undefined : credentials.get(access)
  }

  const auth = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', mock.origin)
      const route = `${request.method} ${url.pathname}`
      if (route === 'POST /api/v1/vulcancode/authorize') {
        const payload = await body(request) as { callback_uri: string; state: string; code_challenge: string }
        const requestId = token()
        pending.set(requestId, { callback: payload.callback_uri, state: payload.state, challenge: payload.code_challenge })
        json(response, 200, {
          request_id: requestId,
          approval_url: `${mock.origin}/authorize?request_id=${requestId}&state=${encodeURIComponent(payload.state)}`,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
      } else if (route === 'GET /authorize') {
        const entry = pending.get(url.searchParams.get('request_id') ?? '')
        if (entry === undefined) return json(response, 404, { error: 'unknown_request' })
        entry.code = token()
        response.writeHead(302, { Location: `${entry.callback}?code=${entry.code}&state=${encodeURIComponent(entry.state)}` }).end()
      } else if (route === 'POST /api/v1/vulcancode/token') {
        const payload = await body(request) as { code: string; code_verifier: string }
        const found = [...pending.entries()].find(([, entry]) => entry.code === payload.code)
        const challenge = createHash('sha256').update(payload.code_verifier).digest('base64url')
        if (found === undefined || found[1].challenge !== challenge) return json(response, 400, { error: 'invalid_grant' })
        pending.delete(found[0])
        json(response, 200, issue(`auth-${token().slice(0, 8)}`))
      } else if (route === 'POST /api/v1/vulcancode/token/refresh') {
        const authorization = signedIn(request)
        if (authorization === undefined) return json(response, 401, { error: 'invalid_token' })
        if (mock.refreshStatus !== undefined) return json(response, mock.refreshStatus, { error: 'unavailable' })
        credentials.delete(request.headers.authorization!.replace(/^Auth /, ''))
        json(response, 200, issue(authorization))
      } else if (route === 'POST /api/v1/vulcancode/logout') {
        const authorization = signedIn(request)
        if (authorization === undefined) return json(response, 401, { error: 'invalid_token' })
        credentials.delete(request.headers.authorization!.replace(/^Auth /, ''))
        mock.revoked.push(authorization)
        json(response, 200, {})
      } else if (route === 'GET /api/v1/vulcancode/edge-models') {
        if (signedIn(request) === undefined) return json(response, 401, { error: 'invalid_token' })
        json(response, 200, { models: [{ model_id: model }] })
      } else if (route === 'POST /api/v1/vulcancode/edge-access') {
        const authorization = signedIn(request)
        const payload = await body(request) as { model_id: string; client_id: string }
        if (authorization === undefined || payload.client_id !== authorization) return json(response, 401, { error: 'invalid_token' })
        if (payload.model_id !== model) return json(response, 404, { error: 'unknown_model' })
        const grant = token()
        grants.add(grant)
        grantCount++
        json(response, 200, {
          model_id: model, site, access_token: grant, expires_at: new Date(Date.now() + 600_000).toISOString(),
          endpoints: edges.map((edge, index) => ({ endpoint_id: edge.id, endpoint: edge.origin, priority: index, online: true })),
        })
      } else {
        json(response, 404, { error: 'not_found' })
      }
    })()
  })
  servers.push(auth)
  return Object.assign(mock, { origin: await listen(auth) })
}
