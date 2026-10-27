/**
 * The Host side of the settings panel: the OpenVulcan account, cloud endpoints, runtime packs and
 * local models, served as exact `/api/vulcan-decision/*` routes inside dsh's authenticated
 * connection. Only owner peers reach these routes.
 *
 * Data lives where dsh keeps its own: the OpenVulcan credential in dsh's credential store, packs
 * and models under `$DSH_HOME/vulcan-decision/`.
 */

import os from 'node:os'

import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  DecisionEngine, DecisionError, DOWNLOAD_SOURCES, MODEL_CATALOG, MODEL_FAMILIES, MODEL_SOURCES, PACK_IDS, PLANNED_PACKS,
  detectHardware, gpuGeneration, installModelFromDirectory, installPack, installedPack, isPackId, isSite, listModels, parseCredential,
  readLock, recommend, removeModel, removePack, downloadModel,
  type Credential, type CredentialStore, type DecisionHome, type DownloadSource, type EngineSettings, type ModelFamily, type ModelSource,
  type EndpointSnapshot, type PendingSignIn, type TestInput, type TestResult, type Verdict,
} from '@openvulcan/vulcan-decision'

/** Prefix of every panel route, below dsh's `/api`. Also restated in `client/index.tsx`. */
export const ROUTE_PREFIX = '/api/vulcan-decision/'

/** Where the OpenVulcan credential is kept in dsh's credential store. */
export const CREDENTIAL_KEY = credentialKey('vulcan-decision-guard', 'openvulcan')

/** The subset of dsh's credential service this plugin uses. */
export interface CredentialRecords {
  readRecord(key: typeof CREDENTIAL_KEY): Promise<CredentialRecord | undefined>
  modifyRecord(key: typeof CREDENTIAL_KEY, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  deleteRecord(key: typeof CREDENTIAL_KEY): Promise<void>
}

/**
 * The account credential as a dsh grant record. `records` is looked up on every use, so the
 * cloud backend reports "not signed in" rather than failing while dsh has no credential service.
 */
export class DshCredentialStore implements CredentialStore {
  constructor(private readonly records: () => CredentialRecords | undefined) {}

  async read(): Promise<Credential | undefined> {
    const record = await this.records()?.readRecord(CREDENTIAL_KEY)
    return record?.kind === 'grant' ? parseCredential(record.payload) : undefined
  }

  async write(credential: Credential): Promise<void> {
    const records = this.records()
    if (records === undefined) throw new DecisionError('not_signed_in', 'dsh offers no credential store to keep the sign-in in')
    await records.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: credential }))
  }

  async delete(): Promise<void> {
    await this.records()?.deleteRecord(CREDENTIAL_KEY)
  }
}

/** The device name OpenVulcan lists for this sign-in. */
export function deviceInfo(version: string) {
  return { display_name: `dsh on ${os.hostname()}`, client_version: `vulcan-decision-guard ${version}` }
}

/** A long-running install the panel started; one runs at a time. */
export interface Job {
  readonly kind: 'pack' | 'model-download' | 'model-directory'
  readonly target: string
  readonly phase: 'download' | 'unpack' | 'install' | 'probe' | 'verify' | 'done' | 'failed' | 'cancelled'
  readonly done?: number
  readonly total?: number
  readonly error?: string
  readonly startedAt: number
}

/** The panel's settings, as `src/index.ts` reads them for each request. */
export interface PanelSettings {
  readonly engine: () => EngineSettings
  readonly downloadSource: () => DownloadSource
}

export class Panel {
  private signIn: PendingSignIn | undefined
  private signInError: string | undefined
  private job: Job | undefined
  private jobAbort: AbortController | undefined

  constructor(readonly engine: DecisionEngine, private readonly settings: PanelSettings) {}

  get home(): DecisionHome {
    return this.engine.home
  }

  /** Everything the panel shows, in one answer. */
  async state() {
    const hardware = detectHardware()
    const recommendation = recommend(hardware)
    const settings = this.settings.engine()
    return {
      account: await this.engine.account.status(),
      signIn: this.signIn === undefined ? null : { approvalUrl: this.signIn.approvalUrl, expiresAt: this.signIn.expiresAt },
      ...this.signInError === undefined ? {} : { signInError: this.signInError },
      cloud: this.engine.cloud.snapshot(settings.cloudModel === '' ? undefined : settings.cloudModel, settings.cloudEndpoint),
      hardware: {
        ...hardware,
        gpus: hardware.gpus.map(gpu => ({
          ...gpu,
          ...gpu.computeCapability === undefined ? {} : { generation: gpuGeneration(gpu.computeCapability) },
        })),
      },
      recommendation,
      packs: PACK_IDS.map((pack) => {
        const lock = readLock(pack)
        const installed = installedPack(this.home, pack)
        const fit = recommendation.packs.find(item => item.pack === pack)!
        return {
          id: pack, backend: lock.backend, device: lock.device, fit: fit.fit,
          ...fit.bytes === undefined ? {} : { bytes: fit.bytes },
          ...fit.needsDriver === undefined ? {} : { needsDriver: fit.needsDriver },
          installed: installed === undefined ? null : { outdated: installed.lock !== lock.id, installedAt: installed.installed_at },
        }
      }),
      planned: PLANNED_PACKS,
      models: listModels(this.home).map(model => ({
        id: model.id, name: model.name, format: model.package_format, bytes: model.bytes, installedAt: model.installed_at,
        ...model.family === undefined ? {} : { family: model.family },
      })),
      catalog: MODEL_CATALOG.map(model => ({
        family: model.family, name: model.name, parameters: model.parameters, format: model.format,
        sources: MODEL_SOURCES.filter(source => model.sources[source] !== null),
      })),
      local: this.engine.local.status(),
      job: this.job ?? null,
      home: this.home.root,
    }
  }

  async startSignIn(site: string): Promise<{ approvalUrl: string }> {
    if (!isSite(site)) throw new DecisionError('invalid_request', 'site must be cn or global')
    this.signIn?.cancel()
    this.signInError = undefined
    const pending = await this.engine.account.signIn(site)
    this.signIn = pending
    pending.done.then(() => {
      this.engine.cloud.reset()
    }, (error: unknown) => {
      if (this.signIn === pending) this.signInError = messageOf(error)
    }).finally(() => {
      if (this.signIn === pending) this.signIn = undefined
    })
    return { approvalUrl: pending.approvalUrl }
  }

  cancelSignIn(): void {
    this.signIn?.cancel()
    this.signIn = undefined
    this.signInError = undefined
  }

  async signOut(): Promise<void> {
    this.cancelSignIn()
    try {
      await this.engine.account.signOut()
    } finally {
      this.engine.cloud.reset()
    }
  }

  /** The models OpenVulcan lists for this account; the first is the default. */
  async cloudModels(): Promise<string[]> {
    return await this.engine.cloud.models()
  }

  /** The endpoint table of the saved (or default) model, without measuring. */
  async endpoints(): Promise<EndpointSnapshot> {
    const settings = this.settings.engine()
    if (!(await this.engine.account.status()).signedIn) return { mode: 'auto', endpoints: [] }
    let model: string
    try {
      model = await this.engine.cloud.resolveModel(settings.cloudModel)
    } catch (error) {
      return { mode: 'auto', error: messageOf(error), endpoints: [] }
    }
    this.engine.cloud.refreshIfStale(model)
    return this.engine.cloud.snapshot(model, settings.cloudEndpoint)
  }

  /** Measure the endpoints of the saved (or default) model now. */
  async probe(): Promise<EndpointSnapshot> {
    const settings = this.settings.engine()
    const model = await this.engine.cloud.resolveModel(settings.cloudModel)
    try {
      return await this.engine.cloud.probe(model, settings.cloudEndpoint)
    } catch (error) {
      if (error instanceof DecisionError && error.code !== 'not_signed_in') return this.engine.cloud.snapshot(model, settings.cloudEndpoint)
      throw error
    }
  }

  /** Check an endpoint the user is about to lock against the model it will be saved with. */
  async checkLock(model: unknown, endpoint: unknown): Promise<void> {
    if (typeof endpoint !== 'string' || endpoint === '') throw new DecisionError('invalid_request', 'endpoint is required')
    await this.engine.cloud.checkEndpoint(await this.engine.cloud.resolveModel(typeof model === 'string' ? model : this.settings.engine().cloudModel), endpoint)
  }

  /** Time five real judgements of a sample call on one endpoint. */
  async requestTest(endpoint: unknown, input: unknown): Promise<TestResult> {
    if (typeof endpoint !== 'string' || endpoint === '') throw new DecisionError('invalid_request', 'endpoint is required')
    if (typeof input !== 'object' || input === null) throw new DecisionError('invalid_request', 'input is required')
    const model = await this.engine.cloud.resolveModel(this.settings.engine().cloudModel)
    return await this.engine.cloud.requestTest(model, endpoint, input as TestInput)
  }

  installPack(pack: string | null, source: string | null): Job {
    if (!isPackId(pack)) throw new DecisionError('invalid_request', `pack must be one of ${PACK_IDS.join(', ')}`)
    const from = this.source(source)
    return this.run('pack', pack, signal => installPack(this.home, pack, {
      source: from, signal,
      onProgress: progress => this.update(progress.phase === 'download'
        ? { phase: 'download', done: progress.done, total: progress.total }
        : { phase: progress.phase }),
    }))
  }

  removePack(pack: string | null): boolean {
    if (!isPackId(pack)) throw new DecisionError('invalid_request', `pack must be one of ${PACK_IDS.join(', ')}`)
    this.assertIdle()
    // A running worker of this pack holds files open.
    if (this.engine.local.status().selection?.pack === pack) this.engine.local.stop()
    return removePack(this.home, pack)
  }

  downloadModel(family: string | null, source: string | null): Job {
    if (!(MODEL_FAMILIES as readonly (string | null)[]).includes(family)) throw new DecisionError('invalid_request', `model must be one of ${MODEL_FAMILIES.join(', ')}`)
    if (!(MODEL_SOURCES as readonly (string | null)[]).includes(source)) throw new DecisionError('invalid_request', `source must be one of ${MODEL_SOURCES.join(', ')}`)
    return this.run('model-download', family!, signal => downloadModel(this.home, family as ModelFamily, source as ModelSource, {
      signal,
      onProgress: (done, total) => this.update({ phase: 'download', done, total }),
    }))
  }

  installModelDirectory(dir: unknown): Job {
    if (typeof dir !== 'string' || dir.trim() === '') throw new DecisionError('invalid_request', 'dir must name a model package directory')
    return this.run('model-directory', dir, signal => installModelFromDirectory(this.home, dir.trim(), {
      signal,
      onProgress: (done, total) => this.update({ phase: 'verify', done, total }),
    }))
  }

  removeModel(id: string | null): boolean {
    if (id === null || id === '') throw new DecisionError('invalid_request', 'id is required')
    this.assertIdle()
    if (this.engine.local.status().selection?.model === id) this.engine.local.stop()
    return removeModel(this.home, id)
  }

  cancelJob(): void {
    this.jobAbort?.abort(new DecisionError('invalid_request', 'cancelled'))
  }

  /** Judge a sample call with the saved settings, so the user sees the backend answer. */
  async test(tool: unknown, args: unknown): Promise<Verdict> {
    if (typeof tool !== 'string' || tool === '' || typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new DecisionError('invalid_request', 'tool must be a name and args an object')
    }
    return await this.engine.judge({ tool, arguments: args as Record<string, unknown> }, this.settings.engine())
  }

  close(): void {
    this.cancelSignIn()
    this.cancelJob()
  }

  private source(value: string | null): DownloadSource {
    if (value === null) return this.settings.downloadSource()
    if (!(DOWNLOAD_SOURCES as readonly string[]).includes(value)) throw new DecisionError('invalid_request', `source must be one of ${DOWNLOAD_SOURCES.join(', ')}`)
    return value as DownloadSource
  }

  private assertIdle(): void {
    if (this.running()) throw new DecisionError('invalid_request', 'another install is running')
  }

  private running(): boolean {
    return this.job !== undefined && !['done', 'failed', 'cancelled'].includes(this.job.phase)
  }

  private run(kind: Job['kind'], target: string, work: (signal: AbortSignal) => Promise<unknown>): Job {
    this.assertIdle()
    const abort = new AbortController()
    this.jobAbort = abort
    this.job = { kind, target, phase: kind === 'model-directory' ? 'verify' : 'download', startedAt: Date.now() }
    const job = this.job
    work(abort.signal).then(() => {
      this.finish(job, { phase: 'done' })
    }, (error: unknown) => {
      this.finish(job, abort.signal.aborted ? { phase: 'cancelled' } : { phase: 'failed', error: messageOf(error) })
    })
    return job
  }

  private update(change: Pick<Job, 'phase'> & Partial<Pick<Job, 'done' | 'total'>>): void {
    if (this.job !== undefined && this.running()) this.job = { ...this.job, ...change }
  }

  private finish(started: Job, change: Pick<Job, 'phase'> & Partial<Pick<Job, 'error'>>): void {
    if (this.job?.startedAt !== started.startedAt) return
    const { done: _done, total: _total, ...rest } = this.job
    this.job = { ...rest, ...change }
    this.jobAbort = undefined
  }
}

/** Fetch-shaped handler of one panel route. */
type Handler = (panel: Panel, request: Request, url: URL) => Promise<unknown>

/** Every panel route: method, path below {@link ROUTE_PREFIX}, handler. */
export const ROUTES: readonly (readonly ['GET' | 'POST', string, Handler])[] = [
  ['GET', 'state', panel => panel.state()],
  ['POST', 'signin', (panel, _request, url) => panel.startSignIn(url.searchParams.get('site') ?? '')],
  ['POST', 'signin/cancel', async panel => panel.cancelSignIn()],
  ['POST', 'signout', panel => panel.signOut()],
  ['GET', 'cloud/models', panel => panel.cloudModels()],
  ['GET', 'cloud/endpoints', panel => panel.endpoints()],
  ['POST', 'cloud/probe', panel => panel.probe()],
  ['POST', 'cloud/check-lock', async (panel, request) => {
    const body = await bodyOf(request)
    return await panel.checkLock(body['model'], body['endpoint'])
  }],
  ['POST', 'cloud/test', async (panel, request) => {
    const body = await bodyOf(request)
    return await panel.requestTest(body['endpoint'], body['input'])
  }],
  ['POST', 'packs/install', async (panel, _request, url) => panel.installPack(url.searchParams.get('pack'), url.searchParams.get('source'))],
  ['POST', 'packs/remove', async (panel, _request, url) => panel.removePack(url.searchParams.get('pack'))],
  ['POST', 'models/download', async (panel, _request, url) => panel.downloadModel(url.searchParams.get('family'), url.searchParams.get('source'))],
  ['POST', 'models/install-dir', async (panel, request) => panel.installModelDirectory((await bodyOf(request))['dir'])],
  ['POST', 'models/remove', async (panel, _request, url) => panel.removeModel(url.searchParams.get('id'))],
  ['POST', 'job/cancel', async panel => panel.cancelJob()],
  ['POST', 'test', async (panel, request) => {
    const body = await bodyOf(request)
    return await panel.test(body['tool'], body['args'])
  }],
]

/** Answer one panel request; failures carry their code, never a stack. */
export async function handle(panel: Panel, handler: Handler, request: Request): Promise<Response> {
  try {
    const value = await handler(panel, request, new URL(request.url))
    return Response.json({ ok: true, value: value ?? null }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    const code = error instanceof DecisionError ? error.code : 'failed'
    const status = code === 'invalid_request' ? 400 : code === 'not_signed_in' ? 401 : code === 'rate_limited' ? 429 : 500
    return Response.json({ ok: false, error: { code, message: messageOf(error) } }, { status, headers: { 'cache-control': 'no-store' } })
  }
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => undefined)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecisionError('invalid_request', 'the body must be a JSON object')
  return value as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
