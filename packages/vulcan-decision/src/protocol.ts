/**
 * Shapes shared by the cloud and local backends and the host plugins.
 */

/** The model's three candidate decisions, in classifier order. */
export const DECISIONS = ['allow', 'review', 'block'] as const
export type Decision = typeof DECISIONS[number]

/** The fixed authorization options the decision model was trained with; see the model's policy. */
export interface DecisionOptions {
  /** Ordinary writes outside the project: run them, or ask first. */
  readonly cross_project_writes: 'allow' | 'review'
  /** Database drops, truncations and unrestricted data writes. */
  readonly database_reset: 'confirm' | 'allow'
  /** Deleting or resetting the whole current project or its source history. */
  readonly project_reset: 'confirm' | 'allow'
}

/** The policy's defaults. */
export const DEFAULT_OPTIONS: DecisionOptions = { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' }

/** Version of the fixed policy every backend must answer with. */
export const POLICY_VERSION = 'fixed-options-no-intent-v2-critical-writes'

/** One tool call to judge before it runs. */
export interface JudgeCall {
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

/** One model input: the options and the rendered call (see `renderCall`). */
export interface JudgeInput {
  readonly settings: DecisionOptions
  readonly rendered: string
}

/** One model answer, as the local worker and the cloud endpoint produce it. */
export interface ModelResult {
  readonly decision: Decision
  /** Raw allow/review/block scores; not calibrated probabilities. */
  readonly logits?: readonly number[]
  readonly input_tokens?: number
  readonly model_evaluated: boolean
  /** Set when a rule decided without evaluating the model. */
  readonly reason_code?: string
}

export type BackendKind = 'cloud' | 'local'

/** The answer for one call, with where it came from. */
export interface Verdict extends ModelResult {
  readonly backend: BackendKind
  /** Cloud model id or installed local model id. */
  readonly model: string
  /** Cloud endpoint id, or the local runtime pack. */
  readonly via: string
  readonly elapsed_ms: number
}

/**
 * Machine-readable failure kinds; hosts must never treat any of them as an allow.
 * - `invalid_request`: the call cannot be rendered or the options are unknown.
 * - `not_signed_in`: the cloud backend needs an OpenVulcan sign-in.
 * - `backend_unavailable`: the cloud cannot be reached or the local process is not running.
 * - `rate_limited`: the cloud refused for now; `retry_after_ms` may say for how long.
 * - `not_installed`: the selected local runtime pack or model is not installed.
 * - `model_failed`: the model or the endpoint answered something unusable.
 */
export type ErrorCode = 'invalid_request' | 'not_signed_in' | 'backend_unavailable' | 'rate_limited' | 'not_installed' | 'model_failed'

/** A failure with its code. */
export class DecisionError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'DecisionError'
  }
}

/** Check a model result before anyone acts on it. */
export function checkResult(value: unknown): ModelResult {
  const result = value as Partial<ModelResult> | null
  if (typeof result !== 'object' || result === null || !(DECISIONS as readonly unknown[]).includes(result.decision)) {
    throw new DecisionError('model_failed', 'the model answered without a decision')
  }
  if (result.logits !== undefined && (!Array.isArray(result.logits) || result.logits.length !== 3 || !result.logits.every(Number.isFinite))) {
    throw new DecisionError('model_failed', 'the model answered malformed scores')
  }
  return result as ModelResult
}
