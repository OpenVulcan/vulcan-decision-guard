/**
 * The cloud backend: OpenVulcan's decision endpoints, as VulcanCode uses them.
 *
 * The signed-in device asks its auth host for the models it may use (`edge-models`; the server
 * decides, nothing is hard-coded) and, per model, for a short-lived access grant (`edge-access`):
 * an EdDSA token valid on every endpoint of that model, the account's site and the endpoint list.
 * Calls go straight to one endpoint's `POST /v1/judge` with `Authorization: Bearer` and
 * `X-OpenVulcan-Site`.
 *
 * The endpoint is chosen by measurement, never per request: each endpoint's public `/v1/status` is
 * fetched three times in a row, endpoint after endpoint, at start, every 10 minutes and at most
 * every 30 seconds after a failure. The score is the median round trip plus the reported median
 * compute time (round trip alone when any eligible endpoint has not measured compute yet), and a
 * new endpoint wins only when it scores below 80% of the current one. A user lock always uses its
 * endpoint and never fails over. A request that fails is an error, never an allow, and is never
 * retried on another endpoint.
 */

import { randomUUID } from 'node:crypto'

import { DecisionError, DECISIONS, POLICY_VERSION, type Decision, type DecisionOptions, type JudgeInput, type ModelResult } from '../protocol.js'
import { renderCall } from '../render.js'
import { HttpError, requestJson, retryAfter, postJson, type OpenVulcanAccount, type Site } from './account.js'

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
  /** The last failure of an unreachable endpoint. */
  readonly error?: string
  readonly at: number
}

/** One row of the endpoint table, as hosts show it. */
export interface EndpointRow {
  readonly endpointId: string
  readonly endpoint: string
  readonly priority: number
  readonly online: boolean
  readonly region?: string
  readonly ready?: boolean
  readonly acceptsSite?: boolean
  readonly rttMs?: number
  readonly computeP50Ms?: number
  readonly scoreMs?: number
  readonly error?: string
}

/** The endpoint table of the current model. */
export interface EndpointSnapshot {
  readonly modelId?: string
  readonly site?: string
  readonly mode: 'auto' | 'locked'
  readonly lockedEndpointId?: string
  readonly selectedEndpointId?: string
  readonly probedAtMs?: number
  readonly nextProbeAtMs?: number
  /** Why there is no table: no sign-in, no model, or the grant was refused. */
  readonly error?: string
  readonly endpoints: readonly EndpointRow[]
}

/** The sample calls a request test can send, besides a custom command. */
export const TEST_PRESETS = ['ordinary', 'destructive', 'database_reset', 'oversized'] as const
export type TestPreset = typeof TEST_PRESETS[number]
export type TestInput = { readonly kind: 'preset'; readonly preset: TestPreset } | { readonly kind: 'custom'; readonly command: string }

/** One timed request of a request test. Times are milliseconds; absent when not reported. */
export interface TestAttempt {
  readonly requestId: string
  readonly totalMs: number
  readonly networkMs?: number
  readonly endpointMs?: number
  readonly nodeMs?: number
  readonly queueMs?: number
  readonly computeMs?: number
  readonly httpStatus?: number
  readonly tokenRenewed: boolean
  readonly answer?: JudgeAnswer
  readonly errorCode?: string
  readonly error?: string
}

export interface TestResult {
  readonly modelId: string
  readonly endpointId: string
  readonly endpoint: string
  readonly site: string
  readonly renderedChars: number
  readonly attempts: readonly TestAttempt[]
  readonly succeeded: number
  readonly minMs?: number
  readonly medianMs?: number
  readonly maxMs?: number
}

/** A checked `/v1/judge` answer. */
export interface JudgeAnswer {
  readonly region?: string
  readonly model?: string
  readonly checkpointSha256: string
  readonly policyVersion: string
  readonly results: readonly ModelResult[]
}

/** Renew the grant once less than this remains. */
const GRANT_RENEW_MS = 2 * 60_000
export const PROBE_INTERVAL_MS = 10 * 60_000
const PROBE_AFTER_FAILURE_MS = 30_000
const PROBE_ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 5_000
const JUDGE_TIMEOUT_MS = 15_000
/** How long a model list answers "which model is the default". */
const MODELS_TTL_MS = 10 * 60_000
/** A challenger must score below this percentage of the current endpoint to replace it. */
const SWITCH_PERCENT = 80
export const TEST_ATTEMPTS = 5
export const MAX_TEST_COMMAND = 65_536
const OVERSIZED_DIGITS = 120_000
const SITE = /^[a-z0-9-]{1,32}$/
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,64}$/

/** The policy options a request test sends: the cloud policy's defaults. */
const TEST_SETTINGS: DecisionOptions = { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' }

export class EdgeClient {
  private grant: EdgeGrant | undefined
  private grantKey: string | undefined
  private grantError: { model: string; message: string } | undefined
  private modelList: { key: string; at: number; models: string[] } | undefined
  private probes = new Map<string, ProbeResult>()
  private probedFor: string | undefined
  private probedAt = 0
  private lastFailureProbe = 0
  private selected: string | undefined
  private probing: Promise<void> | undefined

  constructor(private readonly account: OpenVulcanAccount, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Models this account may use, sorted; the first is the default. */
  async models(): Promise<string[]> {
    const credential = await this.account.credential()
    const answer = await this.call(() => requestJson(`${credential.auth_origin}/api/v1/vulcancode/edge-models`, credential.access_token, { method: 'GET' })) as { models?: unknown }
    if (!Array.isArray(answer.models)) throw new DecisionError('model_failed', 'OpenVulcan answered a malformed model list')
    const models = [...new Set(answer.models.flatMap(model => typeof model?.model_id === 'string' && IDENTIFIER.test(model.model_id) ? [model.model_id as string] : []))].sort()
    this.modelList = { key: credential.authorization_id, at: Date.now(), models }
    return models
  }

  /**
   * The model to use: the saved one, or else the first one OpenVulcan lists for this account.
   * @throws DecisionError when nothing is saved and the account has no model.
   */
  async resolveModel(saved: string | undefined): Promise<string> {
    if (saved !== undefined && saved !== '') return saved
    const credential = await this.account.credential()
    const cached = this.modelList
    const models = cached !== undefined && cached.key === credential.authorization_id && Date.now() - cached.at < MODELS_TTL_MS ? cached.models : await this.models()
    if (models[0] === undefined) throw new DecisionError('backend_unavailable', 'OpenVulcan offers no cloud decision model to this account')
    return models[0]
  }

  /** The endpoint table of `model` with the last measurements, without measuring. */
  snapshot(model: string | undefined, lock?: string): EndpointSnapshot {
    const locked = lock === undefined || lock === '' ? undefined : lock
    const base = { mode: locked === undefined ? 'auto' as const : 'locked' as const, ...locked === undefined ? {} : { lockedEndpointId: locked } }
    const grant = this.grant
    if (grant === undefined || grant.model_id !== model) {
      const error = this.grantError !== undefined && this.grantError.model === model ? this.grantError.message : undefined
      return { ...base, ...model === undefined ? {} : { modelId: model }, ...error === undefined ? {} : { error }, endpoints: [] }
    }
    const withCompute = this.compareCompute()
    const measured = this.probedFor === grant.model_id
    return {
      ...base,
      modelId: grant.model_id,
      site: grant.site,
      ...this.selected === undefined ? {} : { selectedEndpointId: this.selected },
      ...measured ? { probedAtMs: this.probedAt, nextProbeAtMs: this.probedAt + PROBE_INTERVAL_MS } : {},
      endpoints: [...grant.endpoints].sort(byPriority).map((endpoint) => {
        const probe = measured ? this.probes.get(endpoint.endpoint_id) : undefined
        const score = probe === undefined ? undefined : scoreOf(probe, withCompute)
        const status = probe?.status
        return {
          endpointId: endpoint.endpoint_id, endpoint: endpoint.endpoint, priority: endpoint.priority, online: endpoint.online,
          ...status?.region === undefined ? {} : { region: status.region },
          ...status === undefined ? {} : { ready: status.ready, acceptsSite: status.sites.includes(grant.site) },
          ...probe?.rtt_ms === undefined ? {} : { rttMs: probe.rtt_ms },
          ...status?.compute_ms == null ? {} : { computeP50Ms: status.compute_ms.p50 },
          ...score === undefined ? {} : { scoreMs: score },
          ...probe?.error === undefined ? {} : { error: probe.error },
        }
      }),
    }
  }

  /** Forget grants, model lists and measurements, after a sign-out or account change. */
  reset(): void {
    this.grant = undefined
    this.grantKey = undefined
    this.grantError = undefined
    this.modelList = undefined
    this.probes.clear()
    this.probedFor = undefined
    this.probedAt = 0
    this.selected = undefined
  }

  /**
   * Measure every endpoint of `model` now and update the selection.
   * @param lock the endpoint id the user locked, which is never replaced.
   */
  async probe(model: string, lock?: string): Promise<EndpointSnapshot> {
    const grant = await this.access(model)
    await this.measureOnce(grant)
    return this.snapshot(model, lock)
  }

  /** Measure `model` in the background when its last measurement is older than the interval. */
  refreshIfStale(model: string): void {
    if (this.probing !== undefined) return
    if (this.probedFor === model && Date.now() - this.probedAt < PROBE_INTERVAL_MS) return
    void this.access(model).then(grant => this.measureOnce(grant)).catch(() => {})
  }

  /** Check that `endpointId` serves `model`, for a lock the user is about to save. */
  async checkEndpoint(model: string, endpointId: string): Promise<void> {
    const grant = await this.access(model)
    if (!grant.endpoints.some(endpoint => endpoint.endpoint_id === endpointId)) {
      throw new DecisionError('invalid_request', `${endpointId} does not serve ${model}`)
    }
  }

  /**
   * Judge `inputs` with `model` on the selected (or locked) endpoint.
   * @throws DecisionError for every failure; a failure never carries a decision.
   */
  async judge(model: string, inputs: readonly JudgeInput[], lock?: string): Promise<{ results: ModelResult[]; endpoint: string }> {
    let grant = await this.access(model)
    this.refreshIfStale(model)
    const endpoint = this.choose(grant, lock)
    try {
      return { results: await this.send(grant, endpoint, inputs), endpoint: endpoint.endpoint_id }
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        // The grant may have been rotated out; renew it once and retry once.
        grant = await this.access(model, true)
        const again = this.choose(grant, lock)
        return { results: await this.send(grant, again, inputs), endpoint: again.endpoint_id }
      }
      throw error
    }
  }

  /**
   * Send {@link TEST_ATTEMPTS} real judgements of one sample call to one endpoint, one after
   * another, and time each. The grant is fetched first so its call is not timed. Nothing changes
   * the selection.
   */
  async requestTest(model: string, endpointId: string, input: TestInput): Promise<TestResult> {
    const command = testCommand(input)
    let grant = await this.access(model)
    let endpoint = grant.endpoints.find(item => item.endpoint_id === endpointId)
    if (endpoint === undefined) throw new DecisionError('invalid_request', `${endpointId} does not serve ${model}`)
    const rendered = renderCall({ tool: 'shell_command', arguments: { command } })
    const attempts: TestAttempt[] = []
    for (let index = 0; index < TEST_ATTEMPTS; index++) {
      const requestId = `permission-judge-test-${randomUUID()}`
      const body = { request_id: requestId, inputs: [{ settings: TEST_SETTINGS, rendered }] }
      let reply = await this.post(grant, endpoint, body)
      let renewed = false
      if (reply.status === 401) {
        grant = await this.access(model, true)
        endpoint = grant.endpoints.find(item => item.endpoint_id === endpointId) ?? endpoint
        reply = await this.post(grant, endpoint, body)
        renewed = true
      }
      attempts.push(testAttempt(requestId, reply, renewed))
      if (reply.status === undefined) break
    }
    const times = attempts.filter(attempt => attempt.answer !== undefined && attempt.error === undefined).map(attempt => attempt.totalMs).sort((a, b) => a - b)
    return {
      modelId: model, endpointId, endpoint: endpoint.endpoint, site: grant.site, renderedChars: rendered.length, attempts,
      succeeded: times.length,
      ...times.length === 0 ? {} : { minMs: times[0]!, medianMs: times[Math.floor((times.length - 1) / 2)]!, maxMs: times[times.length - 1]! },
    }
  }

  private async post(grant: EdgeGrant, endpoint: EdgeEndpoint, body: unknown): Promise<Reply> {
    const started = performance.now()
    try {
      const response = await this.fetchImpl(`${endpoint.endpoint}/v1/judge`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${grant.access_token}`,
          'X-OpenVulcan-Site': grant.site,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, text, headers: response.headers, totalMs: performance.now() - started }
    } catch (error) {
      return { text: '', totalMs: performance.now() - started, failure: (error as Error).message }
    }
  }

  private async send(grant: EdgeGrant, endpoint: EdgeEndpoint, inputs: readonly JudgeInput[]): Promise<ModelResult[]> {
    const requestId = `permission-judge-${randomUUID()}`
    const reply = await this.post(grant, endpoint, { request_id: requestId, inputs })
    if (reply.status === undefined) {
      this.afterFailure(grant)
      throw new DecisionError('backend_unavailable', `${endpoint.endpoint_id} cannot be reached: ${reply.failure}`)
    }
    if (reply.status < 200 || reply.status >= 300) {
      const code = endpointErrorCode(reply.text)
      if (reply.status === 401) throw new HttpError(401, code, 'the access grant was refused')
      if (reply.status === 429) {
        const wait = retryAfter(reply.headers?.get('Retry-After') ?? null)
        throw new DecisionError('rate_limited', `${endpoint.endpoint_id} is rate limiting this account`, wait)
      }
      if (reply.status >= 500 || code === 'site_not_accepted') this.afterFailure(grant)
      throw new DecisionError(reply.status >= 500 ? 'backend_unavailable' : 'model_failed',
        `${endpoint.endpoint_id} answered HTTP ${reply.status}${code === undefined ? '' : ` (${code})`}`)
    }
    return parseJudgeEnvelope(reply.text, requestId, inputs.length).results as ModelResult[]
  }

  /** The current grant for `model`, renewed when it is about to expire or `renew` is set. */
  private async access(model: string, renew = false): Promise<EdgeGrant> {
    const credential = await this.account.credential()
    const key = `${credential.authorization_id}\n${model}`
    if (!renew && this.grant !== undefined && this.grantKey === key && Date.parse(this.grant.expires_at) - Date.now() > GRANT_RENEW_MS) return this.grant
    let answer: unknown
    try {
      answer = await this.call(() => postJson(`${credential.auth_origin}/api/v1/vulcancode/edge-access`, credential.access_token,
        { model_id: model, client_id: credential.authorization_id }), model)
    } catch (error) {
      this.grantError = { model, message: (error as Error).message }
      throw error
    }
    const grant = parseGrant(answer, model)
    if (this.grantKey !== key) {
      this.probes.clear()
      this.selected = undefined
      this.probedFor = undefined
      this.probedAt = 0
    }
    this.grant = grant
    this.grantKey = key
    this.grantError = undefined
    return grant
  }

  private choose(grant: EdgeGrant, lock?: string): EdgeEndpoint {
    if (lock !== undefined && lock !== '') {
      const locked = grant.endpoints.find(endpoint => endpoint.endpoint_id === lock)
      if (locked === undefined) throw new DecisionError('backend_unavailable', `the locked endpoint ${lock} is not offered for ${grant.model_id}`)
      return locked
    }
    const selected = grant.endpoints.find(endpoint => endpoint.endpoint_id === this.selected)
    if (selected !== undefined) return selected
    // Before any measurement, the deployment's own preference.
    return [...grant.endpoints].sort(byPriority)[0]!
  }

  private measureOnce(grant: EdgeGrant): Promise<void> {
    this.probing ??= this.measure(grant).finally(() => {
      this.probing = undefined
    })
    return this.probing
  }

  private afterFailure(grant: EdgeGrant): void {
    if (Date.now() - this.lastFailureProbe < PROBE_AFTER_FAILURE_MS) return
    this.lastFailureProbe = Date.now()
    this.measureOnce(grant).catch(() => {})
  }

  private async measure(grant: EdgeGrant): Promise<void> {
    const results: ProbeResult[] = []
    for (const endpoint of [...grant.endpoints].sort(byPriority)) results.push(await this.probeEndpoint(endpoint, grant))
    // A grant renewed for another account or model meanwhile makes these results stale.
    if (this.grant?.model_id !== grant.model_id) return
    this.probes = new Map(results.map(result => [result.endpoint_id, result]))
    this.probedFor = grant.model_id
    this.probedAt = Date.now()
    this.selected = selectEndpoint(grant.endpoints, results, this.selected)
  }

  private async probeEndpoint(endpoint: EdgeEndpoint, grant: EdgeGrant): Promise<ProbeResult> {
    const rtts: number[] = []
    let status: EndpointStatus | undefined
    let failure: string | undefined
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      const started = performance.now()
      try {
        const response = await this.fetchImpl(`${endpoint.endpoint}/v1/status`, {
          redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'Cache-Control': 'no-store' },
        })
        const body = await response.json() as unknown
        if (!response.ok) {
          failure = `HTTP ${response.status}`
          continue
        }
        const parsed = parseStatus(body)
        if (parsed === undefined) {
          failure = 'malformed status'
          continue
        }
        rtts.push(performance.now() - started)
        status = parsed
      } catch (error) {
        failure = (error as Error).message
      }
    }
    const at = Date.now()
    if (rtts.length === 0 || status === undefined) return { endpoint_id: endpoint.endpoint_id, excluded: 'unreachable', ...failure === undefined ? {} : { error: failure }, at }
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
  private async call<T>(work: () => Promise<T>, model?: string): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof DecisionError) throw error
      if (error instanceof HttpError) {
        if (error.status === 401) throw new DecisionError('not_signed_in', 'OpenVulcan refused the sign-in; sign in again')
        if (error.status === 429) throw new DecisionError('rate_limited', error.message, error.retryAfterMs)
        if (error.status === 404 && error.code === 'model_unavailable' && model !== undefined) {
          throw new DecisionError('backend_unavailable', `OpenVulcan does not currently enable the cloud model ${model}`)
        }
        if (error.status === 404) throw new DecisionError('invalid_request', error.message)
        throw new DecisionError('backend_unavailable', `OpenVulcan refused: ${error.message}`)
      }
      throw new DecisionError('backend_unavailable', `OpenVulcan cannot be reached: ${(error as Error).message}`)
    }
  }
}

/** One `/v1/judge` exchange; `status` is absent when no HTTP answer arrived. */
interface Reply {
  readonly status?: number
  readonly text: string
  readonly headers?: Headers
  readonly totalMs: number
  readonly failure?: string
}

/** The command a request test sends. */
export function testCommand(input: TestInput): string {
  if (input.kind === 'custom') {
    if (typeof input.command !== 'string' || input.command.trim() === '') throw new DecisionError('invalid_request', 'the command is empty')
    if (input.command.length > MAX_TEST_COMMAND) throw new DecisionError('invalid_request', `the command is longer than ${MAX_TEST_COMMAND} characters`)
    return input.command
  }
  switch (input.preset) {
    case 'ordinary': return 'git status'
    case 'destructive': return 'rm -rf ~'
    case 'database_reset': return 'psql -d app -c \'DROP SCHEMA public CASCADE\''
    case 'oversized': {
      const hex = '0123456789abcdef'
      let digits = ''
      for (let i = 0; i < OVERSIZED_DIGITS; i++) digits += hex[(i * 7 + Math.floor(i / 16)) % 16]
      return `echo ${digits} > payload.hex`
    }
    default: throw new DecisionError('invalid_request', `unknown preset ${String((input as { preset?: unknown }).preset)}`)
  }
}

function testAttempt(requestId: string, reply: Reply, tokenRenewed: boolean): TestAttempt {
  const totalMs = Math.round(reply.totalMs)
  const base = { requestId, totalMs, tokenRenewed }
  if (reply.status === undefined) return { ...base, errorCode: 'unreachable', error: reply.failure ?? 'no answer' }
  const timing = parseServerTiming(reply.headers?.get('Server-Timing') ?? null)
  const timed = {
    ...base, httpStatus: reply.status,
    ...timing.edge === undefined ? {} : { endpointMs: timing.edge, networkMs: Math.max(totalMs - timing.edge, 0) },
    ...timing.node === undefined ? {} : { nodeMs: timing.node },
    ...timing.queue === undefined ? {} : { queueMs: timing.queue },
    ...timing.compute === undefined ? {} : { computeMs: timing.compute },
  }
  if (reply.status < 200 || reply.status >= 300) {
    const code = endpointErrorCode(reply.text)
    return { ...timed, ...code === undefined ? {} : { errorCode: code }, error: `HTTP ${reply.status}` }
  }
  try {
    return { ...timed, answer: parseJudgeEnvelope(reply.text, requestId, 1) }
  } catch (error) {
    return { ...timed, errorCode: 'malformed_answer', error: (error as Error).message }
  }
}

/** The `edge`, `node`, `queue` and `compute` durations of a `Server-Timing` header. */
export function parseServerTiming(header: string | null): Partial<Record<'edge' | 'node' | 'queue' | 'compute', number>> {
  const timing: Partial<Record<'edge' | 'node' | 'queue' | 'compute', number>> = {}
  for (const metric of (header ?? '').split(',')) {
    const [name, ...params] = metric.split(';').map(part => part.trim())
    if (name !== 'edge' && name !== 'node' && name !== 'queue' && name !== 'compute') continue
    const dur = params.find(param => param.startsWith('dur='))
    const value = dur === undefined ? Number.NaN : Number(dur.slice(4))
    if (Number.isFinite(value) && value >= 0) timing[name] = value
  }
  return timing
}

function endpointErrorCode(text: string): string | undefined {
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error
    return typeof error === 'string' ? error : undefined
  } catch {
    return undefined
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
    const origin = typeof endpoint.endpoint === 'string' ? endpoint.endpoint.replace(/\/$/, '') : ''
    if (!isEndpointOrigin(origin)) throw fail(`endpoint ${endpoint.endpoint_id}`)
    return {
      endpoint_id: endpoint.endpoint_id, endpoint: origin,
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
  return parseJudgeEnvelope(text, requestId, count).results as ModelResult[]
}

/** {@link parseJudgeAnswer} with the answer's region, model and checkpoint. */
export function parseJudgeEnvelope(text: string, requestId: string, count: number): JudgeAnswer {
  const fail = (what: string) => new DecisionError('model_failed', `the endpoint answered ${what}`)
  let answer: { request_id?: unknown; region?: unknown; model?: unknown; checkpoint_sha256?: unknown; policy_version?: unknown; results?: unknown }
  try {
    answer = JSON.parse(text) as typeof answer
  } catch {
    throw fail('invalid JSON')
  }
  if (answer.request_id !== requestId) throw fail('another request id')
  if (typeof answer.checkpoint_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(answer.checkpoint_sha256)) throw fail('no checkpoint')
  if (answer.policy_version !== POLICY_VERSION) throw fail(`policy ${String(answer.policy_version)}`)
  if (!Array.isArray(answer.results) || answer.results.length !== count) throw fail('the wrong number of results')
  const results = answer.results.map((item: { label?: unknown; logits?: unknown; input_tokens?: unknown; model_evaluated?: unknown; reason_code?: unknown }) => {
    if (!(DECISIONS as readonly unknown[]).includes(item.label)) throw fail('no decision')
    const logits = Array.isArray(item.logits) && item.logits.length === 3 && item.logits.every(Number.isFinite) ? item.logits as number[] : undefined
    return {
      decision: item.label as Decision,
      ...logits === undefined ? {} : { logits },
      ...typeof item.input_tokens === 'number' ? { input_tokens: item.input_tokens } : {},
      model_evaluated: item.model_evaluated !== false,
      ...typeof item.reason_code === 'string' ? { reason_code: item.reason_code } : {},
    }
  })
  return {
    ...typeof answer.region === 'string' ? { region: answer.region } : {},
    ...typeof answer.model === 'string' ? { model: answer.model } : {},
    checkpointSha256: answer.checkpoint_sha256, policyVersion: answer.policy_version, results,
  }
}
