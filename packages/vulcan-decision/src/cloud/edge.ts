/**
 * The cloud backend: OpenVulcan's decision endpoints.
 *
 * The signed-in device asks its auth host for the models it may use (`edge-models`) and, per
 * model, for a short-lived access grant (`edge-access`): an EdDSA token valid on every endpoint of
 * that model for 10 minutes, the account's site and the endpoint list. Calls go straight to one
 * endpoint's `POST /v1/judge` with `Authorization: Bearer` and `X-OpenVulcan-Site`.
 *
 * The endpoint is chosen by measurement, never per request: each endpoint's public `/v1/status`
 * is fetched three times at start, every 10 minutes and at most every 30 seconds after a failure;
 * the score is the median round trip plus the reported median compute time (round trip alone when
 * any endpoint has not measured compute yet), and a new endpoint wins only when it is 20% better.
 * A user lock always uses its endpoint and never fails over. A request that fails is an error,
 * never an allow, and is never retried on another endpoint.
 */

import { randomUUID } from 'node:crypto'

import { DecisionError, DECISIONS, POLICY_VERSION, type JudgeInput, type ModelResult } from '../protocol.js'
import { HttpError, requestJson, retryAfter, postJson, type OpenVulcanAccount, type Site } from './account.js'

/** Official cloud model ids, smallest first. */
export const CLOUD_MODELS = [
  'vulcan-decision-shell-v1-mini-preview',
  'vulcan-decision-shell-v1-flash-preview',
  'vulcan-decision-shell-v1-preview',
] as const

export interface EdgeEndpoint {
  readonly endpoint_id: string
  readonly endpoint: string
  readonly priority: number
  readonly online: boolean
}

export interface EdgeGrant {
  readonly model_id: string
  readonly site: Site | string
  readonly endpoints: readonly EdgeEndpoint[]
  readonly access_token: string
  readonly expires_at: string
}

/** One endpoint's `/v1/status` answer, reduced to what selection reads. */
export interface EndpointStatus {
  readonly endpoint_id: string
  readonly model_id: string
  readonly region?: string
  readonly sites: readonly string[]
  readonly ready: boolean
  readonly compute_ms: { readonly p50: number; readonly p95: number } | null
}

/** One probe of one endpoint. */
export interface ProbeResult {
  readonly endpoint_id: string
  /** Lower median round trip of the successful attempts, undefined when all failed. */
  readonly rtt_ms?: number
  readonly status?: EndpointStatus
  /** Why it cannot be used, when it cannot. */
  readonly excluded?: 'unreachable' | 'wrong_endpoint' | 'wrong_model' | 'site_not_served' | 'not_ready'
  readonly at: number
}

/** Renew the grant once less than this remains. */
const GRANT_RENEW_MS = 2 * 60_000
export const PROBE_INTERVAL_MS = 10 * 60_000
const PROBE_AFTER_FAILURE_MS = 30_000
const PROBE_ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 5_000
const JUDGE_TIMEOUT_MS = 15_000
/** A challenger must score below this percentage of the current endpoint to replace it. */
const SWITCH_PERCENT = 80
const SITE = /^[a-z0-9-]{1,32}$/
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,64}$/

export interface CloudStatus {
  readonly model?: string
  readonly site?: string
  readonly endpoints: readonly (EdgeEndpoint & { readonly probe?: ProbeResult; readonly score?: number })[]
  readonly selected?: string
  readonly locked?: string
  readonly probedAt?: number
}

export class EdgeClient {
  private grant: EdgeGrant | undefined
  private grantKey: string | undefined
  private probes = new Map<string, ProbeResult>()
  private probedFor: string | undefined
  private probedAt = 0
  private lastFailureProbe = 0
  private selected: string | undefined
  private probing: Promise<void> | undefined

  constructor(private readonly account: OpenVulcanAccount, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Models this account may use. */
  async models(): Promise<string[]> {
    const credential = await this.account.credential()
    const answer = await this.call(() => requestJson(`${credential.auth_origin}/api/v1/vulcancode/edge-models`, credential.access_token, { method: 'GET' })) as { models?: unknown }
    if (!Array.isArray(answer.models)) throw new DecisionError('model_failed', 'OpenVulcan answered a malformed model list')
    return answer.models.flatMap(model => typeof model?.model_id === 'string' && IDENTIFIER.test(model.model_id) ? [model.model_id as string] : [])
  }

  /** What the panel shows: the current grant's endpoints with their last probes. */
  status(lock?: string): CloudStatus {
    const grant = this.grant
    return {
      ...grant === undefined ? {} : { model: grant.model_id, site: grant.site },
      endpoints: (grant?.endpoints ?? []).map(endpoint => {
        const probe = this.probes.get(endpoint.endpoint_id)
        const score = probe === undefined ? undefined : scoreOf(probe, this.compareCompute())
        return { ...endpoint, ...probe === undefined ? {} : { probe }, ...score === undefined ? {} : { score } }
      }),
      ...this.selected === undefined ? {} : { selected: this.selected },
      ...lock === undefined ? {} : { locked: lock },
      ...this.probedAt === 0 ? {} : { probedAt: this.probedAt },
    }
  }

  /** Forget grants and measurements, after a sign-out or account change. */
  reset(): void {
    this.grant = undefined
    this.grantKey = undefined
    this.probes.clear()
    this.probedFor = undefined
    this.probedAt = 0
    this.selected = undefined
  }

  /**
   * Measure every endpoint of `model` now and update the selection.
   * @param lock the endpoint id the user locked, which is never replaced.
   */
  async probe(model: string, lock?: string): Promise<CloudStatus> {
    const grant = await this.access(model)
    this.probing ??= this.measure(grant).finally(() => {
      this.probing = undefined
    })
    await this.probing
    return this.status(lock)
  }

  /**
   * Judge `inputs` with `model` on the selected (or locked) endpoint.
   * @throws DecisionError for every failure; a failure never carries a decision.
   */
  async judge(model: string, inputs: readonly JudgeInput[], lock?: string): Promise<{ results: ModelResult[]; endpoint: string }> {
    let grant = await this.access(model)
    if (this.probedFor !== model || Date.now() - this.probedAt > PROBE_INTERVAL_MS) this.background(grant)
    const endpoint = this.choose(grant, lock)
    try {
      return { results: await this.send(grant, endpoint, inputs), endpoint: endpoint.endpoint_id }
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        // The grant may have been rotated out; renew it once and retry once.
        this.grant = undefined
        grant = await this.access(model)
        const again = this.choose(grant, lock)
        return { results: await this.send(grant, again, inputs), endpoint: again.endpoint_id }
      }
      throw error
    }
  }

  private async send(grant: EdgeGrant, endpoint: EdgeEndpoint, inputs: readonly JudgeInput[]): Promise<ModelResult[]> {
    const requestId = randomUUID()
    let response: Response
    try {
      response = await this.fetchImpl(`${endpoint.endpoint}/v1/judge`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${grant.access_token}`,
          'X-OpenVulcan-Site': grant.site,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ request_id: requestId, inputs }),
      })
    } catch (error) {
      this.afterFailure(grant)
      throw new DecisionError('backend_unavailable', `${endpoint.endpoint_id} cannot be reached: ${(error as Error).message}`)
    }
    const text = await response.text()
    if (!response.ok) {
      let code: string | undefined
      try {
        code = (JSON.parse(text) as { error?: unknown }).error as string | undefined
      } catch {
        // No error code to report.
      }
      if (response.status === 401) throw new HttpError(401, code, 'the access grant was refused')
      if (response.status === 429) {
        const wait = retryAfter(response.headers.get('Retry-After'))
        throw new DecisionError('rate_limited', `${endpoint.endpoint_id} is rate limiting this account`, wait)
      }
      if (response.status >= 500 || code === 'site_not_accepted') this.afterFailure(grant)
      throw new DecisionError(response.status >= 500 ? 'backend_unavailable' : 'model_failed',
        `${endpoint.endpoint_id} answered HTTP ${response.status}${code === undefined ? '' : ` (${code})`}`)
    }
    return parseJudgeAnswer(text, requestId, inputs.length)
  }

  /** The current grant for `model`, renewed when it is about to expire. */
  private async access(model: string): Promise<EdgeGrant> {
    const credential = await this.account.credential()
    const key = `${credential.authorization_id}\n${model}`
    if (this.grant !== undefined && this.grantKey === key && Date.parse(this.grant.expires_at) - Date.now() > GRANT_RENEW_MS) return this.grant
    const answer = await this.call(() => postJson(`${credential.auth_origin}/api/v1/vulcancode/edge-access`, credential.access_token,
      { model_id: model, client_id: credential.authorization_id }))
    const grant = parseGrant(answer, model)
    if (this.grantKey !== key) {
      this.probes.clear()
      this.selected = undefined
      this.probedFor = undefined
    }
    this.grant = grant
    this.grantKey = key
    return grant
  }

  private choose(grant: EdgeGrant, lock?: string): EdgeEndpoint {
    if (lock !== undefined && lock !== '') {
      const locked = grant.endpoints.find(endpoint => endpoint.endpoint_id === lock)
      if (locked === undefined) throw new DecisionError('backend_unavailable', `the locked endpoint ${lock} does not serve ${grant.model_id}`)
      return locked
    }
    const selected = grant.endpoints.find(endpoint => endpoint.endpoint_id === this.selected)
    if (selected !== undefined) return selected
    // Before any measurement, the deployment's own preference.
    return [...grant.endpoints].sort(byPriority)[0]!
  }

  private background(grant: EdgeGrant): void {
    this.probing ??= this.measure(grant).catch(() => {}).finally(() => {
      this.probing = undefined
    })
  }

  private afterFailure(grant: EdgeGrant): void {
    if (Date.now() - this.lastFailureProbe < PROBE_AFTER_FAILURE_MS) return
    this.lastFailureProbe = Date.now()
    this.background(grant)
  }

  private async measure(grant: EdgeGrant): Promise<void> {
    const results = await Promise.all(grant.endpoints.map(endpoint => this.probeEndpoint(endpoint, grant)))
    this.probes = new Map(results.map(result => [result.endpoint_id, result]))
    this.probedFor = grant.model_id
    this.probedAt = Date.now()
    this.selected = selectEndpoint(grant.endpoints, results, this.selected)
  }

  private async probeEndpoint(endpoint: EdgeEndpoint, grant: EdgeGrant): Promise<ProbeResult> {
    const rtts: number[] = []
    let status: EndpointStatus | undefined
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      const started = performance.now()
      try {
        const response = await this.fetchImpl(`${endpoint.endpoint}/v1/status`, { redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        const body = await response.json() as unknown
        if (!response.ok) continue
        rtts.push(performance.now() - started)
        status = parseStatus(body) ?? status
      } catch {
        // A failed attempt only counts against the median.
      }
    }
    const at = Date.now()
    if (rtts.length === 0 || status === undefined) return { endpoint_id: endpoint.endpoint_id, excluded: 'unreachable', at }
    const sorted = rtts.sort((a, b) => a - b)
    const rtt = Math.round(sorted[Math.floor((sorted.length - 1) / 2)]!)
    const base = { endpoint_id: endpoint.endpoint_id, rtt_ms: rtt, status, at }
    if (status.endpoint_id !== endpoint.endpoint_id) return { ...base, excluded: 'wrong_endpoint' }
    if (status.model_id !== grant.model_id) return { ...base, excluded: 'wrong_model' }
    if (!status.sites.includes(grant.site)) return { ...base, excluded: 'site_not_served' }
    if (!status.ready) return { ...base, excluded: 'not_ready' }
    return base
  }

  private compareCompute(): boolean {
    const usable = [...this.probes.values()].filter(probe => probe.excluded === undefined)
    return usable.length > 0 && usable.every(probe => probe.status?.compute_ms != null)
  }

  /** Map account-host failures to decision errors. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof DecisionError) throw error
      if (error instanceof HttpError) {
        if (error.status === 401) throw new DecisionError('not_signed_in', 'OpenVulcan refused the sign-in; sign in again')
        if (error.status === 429) throw new DecisionError('rate_limited', error.message, error.retryAfterMs)
        if (error.status === 404) throw new DecisionError('invalid_request', error.message)
      }
      throw new DecisionError('backend_unavailable', `OpenVulcan cannot be reached: ${(error as Error).message}`)
    }
  }
}

function byPriority(a: EdgeEndpoint, b: EdgeEndpoint): number {
  return a.priority - b.priority || a.endpoint_id.localeCompare(b.endpoint_id)
}

function scoreOf(probe: ProbeResult, withCompute: boolean): number | undefined {
  if (probe.excluded !== undefined || probe.rtt_ms === undefined) return undefined
  return probe.rtt_ms + (withCompute ? probe.status?.compute_ms?.p50 ?? 0 : 0)
}

/**
 * The endpoint to use after a measurement: the lowest score (ties by priority, then id), unless
 * the current one is still usable and the best is not 20% better.
 */
export function selectEndpoint(endpoints: readonly EdgeEndpoint[], probes: readonly ProbeResult[], current: string | undefined): string | undefined {
  const usable = probes.filter(probe => probe.excluded === undefined && probe.rtt_ms !== undefined)
  if (usable.length === 0) return current
  const withCompute = usable.every(probe => probe.status?.compute_ms != null)
  const ranked = usable
    .map(probe => ({ probe, score: scoreOf(probe, withCompute)!, endpoint: endpoints.find(endpoint => endpoint.endpoint_id === probe.endpoint_id) }))
    .filter((item): item is typeof item & { endpoint: EdgeEndpoint } => item.endpoint !== undefined)
    .sort((a, b) => a.score - b.score || byPriority(a.endpoint, b.endpoint))
  const best = ranked[0]
  if (best === undefined) return current
  const kept = ranked.find(item => item.endpoint.endpoint_id === current)
  if (kept !== undefined && !(best.score * 100 < kept.score * SWITCH_PERCENT)) return current
  return best.endpoint.endpoint_id
}

export function parseGrant(value: unknown, model: string): EdgeGrant {
  const grant = value as Partial<EdgeGrant> | null
  const fail = (what: string) => new DecisionError('model_failed', `OpenVulcan answered a malformed access grant: ${what}`)
  if (typeof grant !== 'object' || grant === null) throw fail('not an object')
  if (grant.model_id !== model) throw fail('another model')
  if (typeof grant.site !== 'string' || !SITE.test(grant.site)) throw fail('site')
  if (typeof grant.access_token !== 'string' || grant.access_token === '') throw fail('token')
  if (typeof grant.expires_at !== 'string' || Number.isNaN(Date.parse(grant.expires_at))) throw fail('expiry')
  if (!Array.isArray(grant.endpoints) || grant.endpoints.length === 0) throw fail('no endpoints')
  const ids = new Set<string>()
  const endpoints = grant.endpoints.map((endpoint: Partial<EdgeEndpoint>) => {
    if (typeof endpoint.endpoint_id !== 'string' || !IDENTIFIER.test(endpoint.endpoint_id) || ids.has(endpoint.endpoint_id)) throw fail('endpoint id')
    ids.add(endpoint.endpoint_id)
    if (typeof endpoint.endpoint !== 'string' || !isEndpointOrigin(endpoint.endpoint)) throw fail(`endpoint ${endpoint.endpoint_id}`)
    return {
      endpoint_id: endpoint.endpoint_id, endpoint: endpoint.endpoint,
      priority: typeof endpoint.priority === 'number' ? endpoint.priority : 0, online: endpoint.online === true,
    }
  })
  return { model_id: model, site: grant.site, endpoints, access_token: grant.access_token, expires_at: grant.expires_at }
}

/** A bare https origin, or http on a loopback address. */
export function isEndpointOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.origin !== value) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
}

export function parseStatus(value: unknown): EndpointStatus | undefined {
  const status = value as Partial<EndpointStatus> | null
  if (typeof status !== 'object' || status === null || typeof status.endpoint_id !== 'string' || typeof status.model_id !== 'string'
    || !Array.isArray(status.sites) || typeof status.ready !== 'boolean') {
    return undefined
  }
  const compute = status.compute_ms
  return {
    endpoint_id: status.endpoint_id, model_id: status.model_id,
    ...typeof status.region === 'string' ? { region: status.region } : {},
    sites: status.sites.filter((site): site is string => typeof site === 'string'),
    ready: status.ready,
    compute_ms: compute !== null && typeof compute === 'object' && Number.isFinite(compute.p50) && Number.isFinite(compute.p95)
      ? { p50: compute.p50, p95: compute.p95 } : null,
  }
}

/** Check a `/v1/judge` answer against the request before anyone acts on it. */
export function parseJudgeAnswer(text: string, requestId: string, count: number): ModelResult[] {
  const fail = (what: string) => new DecisionError('model_failed', `the endpoint answered ${what}`)
  let answer: { request_id?: unknown; checkpoint_sha256?: unknown; policy_version?: unknown; results?: unknown }
  try {
    answer = JSON.parse(text) as typeof answer
  } catch {
    throw fail('invalid JSON')
  }
  if (answer.request_id !== requestId) throw fail('another request id')
  if (typeof answer.checkpoint_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(answer.checkpoint_sha256)) throw fail('no checkpoint')
  if (answer.policy_version !== POLICY_VERSION) throw fail(`policy ${String(answer.policy_version)}`)
  if (!Array.isArray(answer.results) || answer.results.length !== count) throw fail('the wrong number of results')
  return answer.results.map((item: { label?: unknown; logits?: unknown; input_tokens?: unknown; model_evaluated?: unknown; reason_code?: unknown }) => {
    if (!(DECISIONS as readonly unknown[]).includes(item.label)) throw fail('no decision')
    const logits = Array.isArray(item.logits) && item.logits.length === 3 && item.logits.every(Number.isFinite) ? item.logits as number[] : undefined
    return {
      decision: item.label as ModelResult['decision'],
      ...logits === undefined ? {} : { logits },
      ...typeof item.input_tokens === 'number' ? { input_tokens: item.input_tokens } : {},
      model_evaluated: item.model_evaluated !== false,
      ...typeof item.reason_code === 'string' ? { reason_code: item.reason_code } : {},
    }
  })
}
