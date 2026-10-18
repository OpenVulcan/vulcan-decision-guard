/**
 * How the decision model's verdict, the optional LLM review and the session's attendance combine
 * into what dsh does with a call. Nothing that fails or cannot be judged ever runs without either
 * the LLM review or the user allowing it.
 */

import type { Verdict } from '@openvulcan/vulcan-decision/client'

/** The decision model's answer, or why there is none. */
export type FirstStage =
  | { readonly kind: 'verdict'; readonly verdict: Verdict }
  | { readonly kind: 'error'; readonly message: string }

/**
 * The LLM review's answer.
 *
 * - `review`: the reviewer cannot confirm authorization and leaves it to the user (attended only).
 * - `deny`: unsafe, unauthorized or matching a deny rule.
 * - `forbid`: matching a rule the user absolutely forbids; refused without asking anyone.
 */
export type SecondStage =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'allow' }
  | { readonly kind: 'review'; readonly reason?: string }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'forbid'; readonly reason?: string }
  | { readonly kind: 'error'; readonly message: string }

/** What the decision model made of a call it did not allow; `unjudged` means it could not judge. */
export type Stage = 'review' | 'block' | 'unjudged'

/** Localized text for the approval prompt; dsh picks the entry for the UI locale. */
export interface DisplayText {
  readonly [locale: string]: string
  readonly en: string
  readonly zh: string
}

/** What the approval prompt shows besides its headline; the client reads it to set focus and badges. */
export interface PromptDetail {
  readonly stage: Stage
  /** The LLM review's answer, when one was made. */
  readonly review?: 'review' | 'deny' | 'error'
  /** Reviewer's reason or failure message. */
  readonly reviewReason?: string
  /** The button focused when the prompt opens. */
  readonly focus: 'allow' | 'reject'
}

export type Outcome =
  | { readonly kind: 'run' }
  | { readonly kind: 'ask'; readonly reason: string; readonly display: DisplayText; readonly detail: PromptDetail }
  | { readonly kind: 'deny'; readonly reason: string }

/** The settings and session facts {@link decide} needs. */
export interface Situation {
  /** Whether a human can be asked in this session. */
  readonly attended: boolean
  /** Whether the LLM review is turned on. */
  readonly llm: boolean
  /** Whether a `block` verdict also goes to the LLM review, which may then allow it. */
  readonly llmOverridesBlock: boolean
}

/** Name of the tool through which the agent explains its next call; see `intent.ts`. */
export const INTENT_TOOL = 'explain_tool_call'

/** The stage of a call the decision model did not allow, or undefined when it runs. */
export function stageOf(first: FirstStage): Stage | undefined {
  if (first.kind === 'error') return 'unjudged'
  if (first.verdict.decision === 'allow') return undefined
  return first.verdict.decision
}

/** Whether the LLM review looks at a call of this stage. */
export function wantsReview(stage: Stage, situation: Situation): boolean {
  return situation.llm && (stage !== 'block' || situation.llmOverridesBlock)
}

/**
 * - `allow` runs.
 * - With the LLM review on, it decides first: allow runs, forbid is refused outright, and anything
 *   else asks the user when someone is there and is refused otherwise.
 * - A `block` the LLM may not override, and every stage with the LLM review off, asks the user
 *   when someone is there and is refused otherwise.
 */
export function decide(tool: string, first: FirstStage, second: SecondStage, situation: Situation): Outcome {
  const stage = stageOf(first)
  if (stage === undefined) return { kind: 'run' }
  const subject = subjectOf(tool, first, stage)

  if (second.kind === 'allow') return { kind: 'run' }
  if (second.kind === 'forbid') {
    return { kind: 'deny', reason: `${subject}, and its review found that it breaks a rule the user absolutely forbids${detail(second.reason)}. ${retryHint(tool)}` }
  }

  if (!situation.attended) {
    switch (second.kind) {
      case 'deny':
        return { kind: 'deny', reason: `${subject}, and its review denied it${detail(second.reason)}. ${retryHint(tool)}` }
      case 'review':
        // The unattended reviewer is told it has only two answers; a third is still not an allow.
        return { kind: 'deny', reason: `${subject}, and its review did not allow it${detail(second.reason)}. ${retryHint(tool)}` }
      case 'error':
        return { kind: 'deny', reason: `${subject}, and its review failed: ${second.message}. No one is available to confirm the call in this unattended session, so it was not executed.` }
      case 'skipped':
        return { kind: 'deny', reason: `${subject}. No one is available to confirm the call in this unattended session, so it was not executed.` }
    }
  }

  const display = displayOf(first, stage, second)
  switch (second.kind) {
    case 'review':
      return ask(`${subject}; its review leaves the decision to the user${detail(second.reason)}`, display, {
        stage, review: 'review', focus: 'allow', ...reasonOf(second.reason),
      })
    case 'deny':
      return ask(`${subject}; its review denied it${detail(second.reason)}`, display, {
        stage, review: 'deny', focus: 'reject', ...reasonOf(second.reason),
      })
    case 'error':
      return ask(`${subject}; its review failed: ${second.message}`, display, {
        stage, review: 'error', reviewReason: second.message, focus: stage === 'review' ? 'allow' : 'reject',
      })
    case 'skipped':
      return ask(`${subject}; the user decides`, display, { stage, focus: stage === 'review' ? 'allow' : 'reject' })
  }
}

function subjectOf(tool: string, first: FirstStage, stage: Stage): string {
  if (first.kind === 'error') return `Vulcan Decision could not judge tool "${tool}" (${first.message})`
  if (stage === 'review') return `Vulcan Decision flagged tool "${tool}" as needing confirmation`
  return first.verdict.reason_code === 'input_token_limit'
    ? `Vulcan Decision blocked tool "${tool}" because the call is too long to judge`
    : `Vulcan Decision blocked tool "${tool}" as unsafe`
}

function displayOf(first: FirstStage, stage: Stage, second: SecondStage): DisplayText {
  const model: DisplayText = first.kind === 'error'
    ? { en: `Vulcan Decision could not judge this call (${first.message})`, zh: `Vulcan Decision 无法判定此调用（${first.message}）` }
    : stage === 'review'
      ? { en: 'Vulcan Decision asks you to confirm this call', zh: 'Vulcan Decision 需要你确认此调用' }
      : first.verdict.reason_code === 'input_token_limit'
        ? { en: 'Vulcan Decision blocked this call because it is too long to judge', zh: '此调用过长，Vulcan Decision 无法判定，已拦截' }
        : { en: 'Vulcan Decision blocked this call as unsafe', zh: 'Vulcan Decision 认为此调用不安全，已拦截' }
  switch (second.kind) {
    case 'review':
      return { en: `${model.en}; the LLM review leaves it to you.`, zh: `${model.zh}；LLM 复核交由你决定。` }
    case 'deny':
      return { en: `${model.en}; the LLM review denied it.`, zh: `${model.zh}；LLM 复核未放行。` }
    case 'error':
      return { en: `${model.en}; the LLM review failed.`, zh: `${model.zh}；LLM 复核失败。` }
    default:
      return { en: `${model.en}.`, zh: `${model.zh}。` }
  }
}

function ask(reason: string, display: DisplayText, detail: PromptDetail): Outcome {
  return { kind: 'ask', reason, display, detail }
}

function detail(reason: string | undefined): string {
  return reason === undefined ? '' : `: ${reason}`
}

function reasonOf(reason: string | undefined): { reviewReason?: string } {
  return reason === undefined ? {} : { reviewReason: reason }
}

/** Every LLM denial tells the agent how to explain itself and ask again. */
function retryHint(tool: string): string {
  return `The call was not executed. If it is needed and the reviewer misread it, call ${INTENT_TOOL} with tool "${tool}" and the purpose of the call, then make the call again.`
}
