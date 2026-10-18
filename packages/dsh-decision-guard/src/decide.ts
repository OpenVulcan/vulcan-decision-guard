/**
 * How the model's verdict and the optional LLM review combine into what dsh does with a call.
 * Nothing that fails or cannot be judged ever runs without the user's confirmation.
 */

import type { Verdict } from '@openvulcan/vulcan-decision/client'

/** The decision model's answer, or why there is none. */
export type FirstStage =
  | { readonly kind: 'verdict'; readonly verdict: Verdict }
  | { readonly kind: 'error'; readonly message: string }

/** The LLM review's answer for a `review` or `block` verdict. */
export type SecondStage =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'error'; readonly message: string }

/** Localized text for the approval prompt; dsh picks the entry for the UI locale. */
export interface DisplayText {
  readonly [locale: string]: string
  readonly en: string
  readonly zh: string
}

export type Outcome =
  | { readonly kind: 'run' }
  | { readonly kind: 'ask'; readonly reason: string; readonly display: DisplayText }
  | { readonly kind: 'deny'; readonly reason: string }

/** Whether the verdict is one the LLM review looks at. */
export function wantsReview(first: FirstStage): boolean {
  return first.kind === 'verdict' && first.verdict.decision !== 'allow'
}

/**
 * - `allow` runs.
 * - `review` runs when the LLM review allows it; otherwise the user is asked.
 * - `block` is denied; when the LLM review finds it authorized, the user is asked instead. The
 *   review can never make a blocked call run on its own.
 * - A model or service failure asks the user.
 */
export function decide(tool: string, first: FirstStage, second: SecondStage): Outcome {
  if (first.kind === 'error') {
    return ask(
      `Vulcan Decision could not judge tool "${tool}": ${first.message}`,
      { en: `Vulcan Decision could not judge this call: ${first.message}`, zh: `Vulcan Decision 无法判定此调用：${first.message}` },
    )
  }
  const { verdict } = first
  if (verdict.decision === 'allow') return { kind: 'run' }
  if (verdict.decision === 'review') {
    switch (second.kind) {
      case 'allow':
        return { kind: 'run' }
      case 'skipped':
        return ask(
          `Vulcan Decision asks the user to confirm tool "${tool}"`,
          { en: 'Vulcan Decision asks you to confirm this call.', zh: 'Vulcan Decision 需要你确认此调用。' },
        )
      case 'deny':
        return ask(
          withReason(`Vulcan Decision and its review did not allow tool "${tool}"`, second.reason),
          withDisplayReason(
            { en: 'The review did not allow this call', zh: '复核未放行此调用' },
            second.reason,
          ),
        )
      case 'error':
        return ask(
          `Vulcan Decision asks the user to confirm tool "${tool}"; its review failed: ${second.message}`,
          { en: `Vulcan Decision asks you to confirm this call; the review failed: ${second.message}`, zh: `Vulcan Decision 需要你确认此调用；复核失败：${second.message}` },
        )
    }
  }
  const blocked = verdict.reason_code === 'input_token_limit'
    ? `Vulcan Decision blocked tool "${tool}" because the call is too long to judge`
    : `Vulcan Decision blocked tool "${tool}" as unsafe`
  if (second.kind === 'allow') {
    return ask(
      `${blocked}; its review found the call authorized, so the user decides`,
      { en: 'The decision model blocked this call, but the review found it authorized. Run it?', zh: '判定模型拦截了此调用，但复核认为已获授权。是否执行？' },
    )
  }
  const detail = second.kind === 'deny' && second.reason !== undefined ? `: ${second.reason}` : ''
  return { kind: 'deny', reason: `${blocked}${detail}. The call was not executed; do not retry it in another form without the user's explicit instruction.` }
}

function ask(reason: string, display: DisplayText): Outcome {
  return { kind: 'ask', reason, display }
}

function withReason(text: string, reason: string | undefined): string {
  return reason === undefined ? text : `${text}: ${reason}`
}

function withDisplayReason(text: DisplayText, reason: string | undefined): DisplayText {
  return reason === undefined
    ? { en: `${text.en}.`, zh: `${text.zh}。` }
    : { en: `${text.en}: ${reason}`, zh: `${text.zh}：${reason}` }
}
