import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Decision, Verdict } from '@openvulcan/vulcan-decision'

import { decide, INTENT_TOOL, stageOf, wantsReview, type FirstStage, type SecondStage, type Situation } from './decide.js'

function verdict(decision: Decision, extra: Partial<Verdict> = {}): FirstStage {
  return { kind: 'verdict', verdict: { decision, model_evaluated: true, backend: 'local', model: 'test', via: 'onnx-cpu', elapsed_ms: 1, ...extra } }
}

const FAILED: FirstStage = { kind: 'error', message: 'model_not_installed' }
const SKIPPED: SecondStage = { kind: 'skipped' }
const ATTENDED_LLM: Situation = { attended: true, llm: true, llmOverridesBlock: false }
const ATTENDED_NO_LLM: Situation = { attended: true, llm: false, llmOverridesBlock: false }
const UNATTENDED_LLM: Situation = { attended: false, llm: true, llmOverridesBlock: false }
const UNATTENDED_NO_LLM: Situation = { attended: false, llm: false, llmOverridesBlock: false }

test('allow runs without review in every situation', () => {
  assert.equal(stageOf(verdict('allow')), undefined)
  for (const situation of [ATTENDED_LLM, ATTENDED_NO_LLM, UNATTENDED_LLM, UNATTENDED_NO_LLM]) {
    assert.deepEqual(decide('bash', verdict('allow'), SKIPPED, situation), { kind: 'run' })
  }
})

test('the LLM reviews review and unjudged calls, and blocks only when it may override them', () => {
  assert.equal(wantsReview('review', ATTENDED_LLM), true)
  assert.equal(wantsReview('unjudged', UNATTENDED_LLM), true)
  assert.equal(wantsReview('block', ATTENDED_LLM), false)
  assert.equal(wantsReview('block', { ...ATTENDED_LLM, llmOverridesBlock: true }), true)
  assert.equal(wantsReview('review', ATTENDED_NO_LLM), false)
  assert.equal(stageOf(FAILED), 'unjudged')
})

test('an LLM allow runs, even for a block it may override', () => {
  assert.deepEqual(decide('bash', verdict('review'), { kind: 'allow' }, ATTENDED_LLM), { kind: 'run' })
  assert.deepEqual(decide('bash', verdict('block'), { kind: 'allow' }, { ...UNATTENDED_LLM, llmOverridesBlock: true }), { kind: 'run' })
  assert.deepEqual(decide('bash', FAILED, { kind: 'allow' }, UNATTENDED_LLM), { kind: 'run' })
})

test('forbid is refused without asking, with the reason and the intent hint', () => {
  for (const situation of [ATTENDED_LLM, UNATTENDED_LLM]) {
    const outcome = decide('bash', verdict('review'), { kind: 'forbid', reason: 'production database' }, situation)
    assert.equal(outcome.kind, 'deny')
    assert.ok(outcome.kind === 'deny' && outcome.reason.includes('production database') && outcome.reason.includes(INTENT_TOOL))
  }
})

test('attended: anything the LLM does not allow asks the user, focused by its answer', () => {
  const focus = (stage: FirstStage, second: SecondStage, situation = ATTENDED_LLM) => {
    const outcome = decide('bash', stage, second, situation)
    assert.equal(outcome.kind, 'ask')
    return outcome.kind === 'ask' ? outcome.detail.focus : undefined
  }
  assert.equal(focus(verdict('review'), { kind: 'review', reason: 'unclear scope' }), 'allow')
  assert.equal(focus(verdict('review'), { kind: 'deny', reason: 'not asked' }), 'reject')
  assert.equal(focus(verdict('review'), { kind: 'error', message: 'offline' }), 'allow')
  assert.equal(focus(verdict('block'), { kind: 'error', message: 'offline' }, { ...ATTENDED_LLM, llmOverridesBlock: true }), 'reject')
  // A block the LLM may not override is not reviewed and asks with rejecting focused.
  assert.equal(focus(verdict('block'), SKIPPED), 'reject')
  const outcome = decide('bash', verdict('review'), { kind: 'deny', reason: 'not asked' }, ATTENDED_LLM)
  assert.ok(outcome.kind === 'ask' && outcome.detail.review === 'deny' && outcome.detail.reviewReason === 'not asked')
  assert.ok(outcome.kind === 'ask' && outcome.display.en !== '' && outcome.display.zh !== '')
})

test('attended without the LLM: review asks with allowing focused, block with rejecting focused', () => {
  const review = decide('bash', verdict('review'), SKIPPED, ATTENDED_NO_LLM)
  const block = decide('bash', verdict('block'), SKIPPED, ATTENDED_NO_LLM)
  assert.ok(review.kind === 'ask' && review.detail.focus === 'allow')
  assert.ok(block.kind === 'ask' && block.detail.focus === 'reject')
})

test('unattended: nothing asks; whatever is not allowed is denied', () => {
  const cases: [FirstStage, SecondStage, Situation][] = [
    [verdict('review'), { kind: 'deny', reason: 'not asked' }, UNATTENDED_LLM],
    [verdict('review'), { kind: 'review' }, UNATTENDED_LLM],
    [verdict('review'), { kind: 'error', message: 'offline' }, UNATTENDED_LLM],
    [verdict('block'), SKIPPED, UNATTENDED_LLM],
    [verdict('review'), SKIPPED, UNATTENDED_NO_LLM],
    [verdict('block', { reason_code: 'input_token_limit' }), SKIPPED, UNATTENDED_NO_LLM],
    [FAILED, SKIPPED, UNATTENDED_NO_LLM],
  ]
  for (const [first, second, situation] of cases) {
    assert.equal(decide('bash', first, second, situation).kind, 'deny')
  }
  const denied = decide('bash', verdict('review'), { kind: 'deny', reason: 'not asked' }, UNATTENDED_LLM)
  assert.ok(denied.kind === 'deny' && denied.reason.includes('not asked') && denied.reason.includes(INTENT_TOOL))
})
