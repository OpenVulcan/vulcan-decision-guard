/** Shapes and Host reads shared by the settings page, the composer card and the approval card. */

import type { BundleInfo, ConfigForm, ConfigOp, ModelCatalog } from './dsh-client'

/** Must equal this package's name and its `cordis.patch.yml` row. */
export const PACKAGE_NAME = '@openvulcan/dsh-decision-guard'
/** The Host entry id from `cordis.patch.yml`, which names this plugin's configuration namespace. */
export const ENTRY_ID = 'vulcan-decision-guard'
/** The Settings dialog entry this plugin adds. */
export const SETTINGS_SECTION = 'vulcan-auto-approval'
/** DeepSeek Harness's experimental Auto review bundle. */
export const AUTO_REVIEW_PACKAGE = '@deepseek-ai/dsh-experimental-auto-review'
/** dsh's Auto permission preset value. */
export const AUTO_PRESET = 'auto'

/** Configuration values as the Host's schema resolves them; mirrors `Config` in `src/index.ts`. */
export interface GuardSettings {
  readonly mode: 'auto-preset' | 'standalone'
  readonly backend: 'cloud' | 'local'
  readonly cloudModel: string
  readonly cloudEndpoint?: string | undefined
  readonly localPack?: string | undefined
  readonly localModel?: string | undefined
  readonly downloadSource: 'official' | 'cn'
  readonly review: 'session' | 'custom' | 'off'
  readonly reviewProvider?: string | undefined
  readonly reviewModel?: string | undefined
  readonly allowRules: string
  readonly denyRules: string
  readonly forbidRules: string
  readonly llmOverridesBlock: boolean
  readonly askTimeout: number
  readonly crossProjectWrites: 'allow' | 'review'
  readonly databaseReset: 'confirm' | 'allow'
  readonly projectReset: 'confirm' | 'allow'
}

export type Field = keyof GuardSettings
/** A field change; `undefined` clears the field so it falls back to its default. */
export type Change = Partial<Record<Field, string | number | boolean | undefined>>

/** Countdown offered when the switch is turned on; the Host accepts 1 to {@link MAX_ASK_TIMEOUT}. */
export const DEFAULT_ASK_TIMEOUT = 60
/** Mirrors `MAX_ASK_TIMEOUT` in `src/index.ts`. */
export const MAX_ASK_TIMEOUT = 3600

/** Mirrors `EndpointSnapshot` in the engine's `cloud/edge.ts`. */
export interface EndpointSnapshot {
  readonly modelId?: string
  readonly site?: string
  readonly mode: 'auto' | 'locked'
  readonly lockedEndpointId?: string
  readonly selectedEndpointId?: string
  readonly probedAtMs?: number
  readonly nextProbeAtMs?: number
  readonly error?: string
  readonly endpoints: readonly {
    readonly endpointId: string
    readonly endpoint: string
    readonly online: boolean
    readonly region?: string
    readonly ready?: boolean
    readonly acceptsSite?: boolean
    readonly rttMs?: number
    readonly computeP50Ms?: number
    readonly scoreMs?: number
    readonly error?: string
  }[]
}

/** Mirrors `TestResult` in the engine's `cloud/edge.ts`. */
export interface TestResult {
  readonly modelId: string
  readonly endpointId: string
  readonly endpoint: string
  readonly site: string
  readonly renderedChars: number
  readonly succeeded: number
  readonly minMs?: number
  readonly medianMs?: number
  readonly maxMs?: number
  readonly attempts: readonly {
    readonly requestId: string
    readonly totalMs: number
    readonly networkMs?: number
    readonly endpointMs?: number
    readonly nodeMs?: number
    readonly queueMs?: number
    readonly computeMs?: number
    readonly httpStatus?: number
    readonly tokenRenewed: boolean
    readonly errorCode?: string
    readonly error?: string
    readonly answer?: {
      readonly region?: string
      readonly model?: string
      readonly checkpointSha256: string
      readonly policyVersion: string
      readonly results: readonly {
        readonly decision: 'allow' | 'review' | 'block'
        readonly logits?: readonly number[]
        readonly input_tokens?: number
        readonly model_evaluated: boolean
        readonly reason_code?: string
      }[]
    }
  }[]
}

/** What `Panel.state()` in `src/panel.ts` answers. */
export interface PanelState {
  readonly account: { readonly signedIn: boolean; readonly site?: 'cn' | 'global'; readonly expiresAt?: string; readonly reauthRequired?: boolean }
  readonly signIn: { readonly approvalUrl: string; readonly expiresAt: string } | null
  readonly signInError?: string
  readonly cloud: EndpointSnapshot
  readonly hardware: {
    readonly gpus: readonly {
      readonly name: string
      readonly vendor: string
      readonly computeCapability?: string
      readonly driver?: string
      readonly generation?: { readonly architecture: string; readonly fp16: 'tensor-cores' | 'native' | 'slow'; readonly supported: boolean }
    }[]
    readonly npus: readonly { readonly name: string }[]
  }
  readonly recommendation: {
    readonly torchPack: string
    readonly onnxPack: string
    readonly reason: 'cuda' | 'cpu_only' | 'driver_update' | 'gpu_too_old'
    readonly npuWaiting: boolean
  }
  readonly packs: readonly {
    readonly id: string
    readonly backend: 'onnx' | 'torch'
    readonly device: string
    readonly fit: 'ok' | 'no_build' | 'no_nvidia_gpu' | 'gpu_too_old' | 'driver_too_old'
    readonly bytes?: number
    readonly needsDriver?: string
    readonly installed: { readonly outdated: boolean } | null
  }[]
  readonly planned: readonly { readonly id: string; readonly accelerator: string }[]
  readonly models: readonly { readonly id: string; readonly name: string; readonly format: 'onnx-delivery' | 'torch-release'; readonly bytes: number }[]
  readonly catalog: readonly { readonly family: string; readonly name: string; readonly parameters: string; readonly sources: readonly string[] }[]
  readonly job: Job | null
  readonly home: string
}

export interface Job {
  readonly kind: 'pack' | 'model-download' | 'model-directory'
  readonly target: string
  readonly phase: 'download' | 'unpack' | 'install' | 'probe' | 'verify' | 'done' | 'failed' | 'cancelled'
  readonly done?: number
  readonly total?: number
  readonly error?: string
}

/** Browser-relative form of `ROUTE_PREFIX` in `src/panel.ts`. */
const ROUTE_BASE = 'api/vulcan-decision/'

/** Call one panel route; rejects with the Host's message when it fails. */
export async function callPanel<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ROUTE_BASE}${route}`, {
    method,
    ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
  const answer = await response.json().catch(() => undefined) as { ok?: boolean; value?: T; error?: { message?: string } } | undefined
  if (answer?.ok !== true) throw new Error(answer?.error?.message ?? `HTTP ${response.status}`)
  return answer.value as T
}

export function running(job: Job | null): boolean {
  return job !== null && !['done', 'failed', 'cancelled'].includes(job.phase)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Latest-answer-wins view of one Host fact, shared by every rendered entry. `undefined` means
 * unknown: before the first answer, or after a failed read, so nothing is shown as a guess.
 */
export class HostWatch<T> {
  #value: T | undefined
  #listeners = new Set<() => void>()
  #generation = 0

  constructor(private readonly read: () => Promise<T | undefined>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): T | undefined => this.#value

  /** Re-read the fact; an older answer never replaces a newer one. */
  refresh(): void {
    const generation = ++this.#generation
    this.read().then((value) => {
      if (generation === this.#generation) this.#set(value)
    }, () => {
      if (generation === this.#generation) this.#set(undefined)
    })
  }

  /** Stop publishing answers that are still in flight. */
  close(): void {
    ++this.#generation
    this.#listeners.clear()
  }

  #set(value: T | undefined): void {
    if (Object.is(value, this.#value)) return
    this.#value = value
    for (const listener of this.#listeners) listener()
  }
}

/** A model list read: loading, the list, or why it failed. */
export type ModelList = { readonly kind: 'ready'; readonly models: readonly string[] } | { readonly kind: 'failed'; readonly error: string }

/** The Host reads and writes every view of the plugin shares. */
export interface Services {
  readonly form: ConfigForm<GuardSettings>
  readonly autoReview: HostWatch<boolean>
  readonly autoListed: HostWatch<boolean>
  /** null: the routes did not answer (no connection, or an older Host). */
  readonly panel: HostWatch<PanelState | null>
  readonly endpoints: HostWatch<EndpointSnapshot>
  readonly cloudModels: HostWatch<ModelList>
  readonly modelCatalog: HostWatch<ModelCatalog>
  /** Open the Settings dialog on this plugin's entry. */
  openSettings(): void
}

/** Save `changes` at the accepted revision; resolves false when the Host refused them. */
export async function saveSettings(form: ConfigForm<GuardSettings>, changes: Change): Promise<boolean> {
  const snapshot = form.getSnapshot()
  const ops: ConfigOp[] = (Object.entries(changes) as [Field, Change[Field]][]).map(([field, next]) => (
    next === undefined ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: next }
  ))
  return await form.mutate(ops, snapshot.revision)
}

export function autoReviewEnabled(bundles: readonly BundleInfo[]): boolean {
  const bundle = bundles.find(item => item.name === AUTO_REVIEW_PACKAGE)
  return bundle !== undefined && bundle.enabled && bundle.availability !== 'missing'
}

export function mebibytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 2)} MiB`
}
