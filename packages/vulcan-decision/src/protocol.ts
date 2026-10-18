/**
 * Messages exchanged between host plugins and the resident service. Every message is one line of
 * JSON (see `frame.ts`); each request gets exactly one response line.
 */

/**
 * Version of the client/service contract. Bump it on any incompatible message change.
 *
 * A service that receives a different version answers `contract_mismatch`; the client then stops
 * it with `shutdown` and starts the service shipped next to itself.
 */
export const CONTRACT_VERSION = 2

/** Coding hosts the service knows; it records them for diagnostics only. */
export type Host = 'dsh'

/** One tool call to judge before it runs. */
export interface JudgeCall {
  readonly host: Host
  /** Host session identifier, when the host provides one. */
  readonly session_id?: string
  /** Root of the project the call works on, when the host knows it. Never guessed. */
  readonly project?: string
  /** Tool name exactly as the host reports it. */
  readonly tool: string
  /**
   * Tool arguments exactly as the host reports them, in their original key order, except for
   * file bodies that a host plugin removes from edit and write calls.
   */
  readonly arguments: Readonly<Record<string, unknown>>
}

/** The fixed authorization options the decision model was trained with; see the model's policy. */
export interface DecisionOptions {
  /** Ordinary writes outside the project: run them, or ask first. */
  readonly cross_project_writes: 'allow' | 'review'
  /** Database drops, truncations and unrestricted data writes. */
  readonly database_reset: 'confirm' | 'allow'
  /** Deleting or resetting the whole current project or its source history. */
  readonly project_reset: 'confirm' | 'allow'
}

/** Model sizes of `vulcan-decision-shell`. */
export const MODEL_SIZES = ['0.2b', '0.4b', '0.6b'] as const
export type ModelSize = typeof MODEL_SIZES[number]

/** How the host wants this call judged. */
export interface JudgeSettings {
  /** Only the local model is served today; `cloud` is answered with `backend_unavailable`. */
  readonly backend: 'local' | 'cloud'
  /** Absent means the size recommended for this device among the installed models. */
  readonly model_size?: ModelSize
  readonly options: DecisionOptions
}

/** The model's three candidate decisions, in classifier order. */
export type Decision = 'allow' | 'review' | 'block'

/** The model's answer for one call. */
export interface Verdict {
  readonly decision: Decision
  /** Installed model that answered. */
  readonly model: string
  /** Set when a rule decided without evaluating the model. */
  readonly reason_code?: 'input_token_limit'
  /** Raw allow/review/block scores; not calibrated probabilities. */
  readonly logits?: readonly [number, number, number]
  readonly input_tokens?: number
}

/** Machine-readable failure kinds; hosts must never treat any of them as an allow. */
export type ErrorCode =
  | 'invalid_request'
  | 'backend_unavailable'
  | 'model_not_installed'
  | 'model_failed'

/** One installed model as `status` reports it. */
export interface ModelStatus {
  readonly id: string
  readonly size: ModelSize
  readonly loaded: boolean
  /** Execution provider of the loaded session, when loaded. */
  readonly device?: string
}

export interface ServiceStatus {
  readonly version: string
  readonly pid: number
  readonly uptime_ms: number
  readonly judged: number
  readonly models: readonly ModelStatus[]
}

export type Request =
  | { readonly type: 'ping'; readonly contract: number }
  | { readonly type: 'judge'; readonly contract: number; readonly call: JudgeCall; readonly settings: JudgeSettings }
  | { readonly type: 'status'; readonly contract: number }
  /** Accepted regardless of contract version so upgrades can replace the service. */
  | { readonly type: 'shutdown' }

export type Response =
  | { readonly type: 'pong'; readonly contract: number; readonly version: string }
  | { readonly type: 'verdict'; readonly verdict: Verdict }
  | { readonly type: 'status'; readonly status: ServiceStatus }
  | { readonly type: 'contract_mismatch'; readonly contract: number }
  | { readonly type: 'shutting_down' }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string }

/** A failure carrying the code the service reports for it. */
export class DecisionError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'DecisionError'
  }
}
