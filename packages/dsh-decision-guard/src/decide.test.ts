import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Decision, Verdict } from '@openvulcan/vulcan-decision/client'

import { decide, wantsReview, type FirstStage, type SecondStage } from './decide.js'

function verdict(decision: Decision, extra: Partial<Verdict> = {}): FirstStage {
  return { kind: 'verdict', verdict: { decision, model: 'test', ...extra } }
}

const SKIPPED: SecondStage = { kind: 'skipped' }

test('allow runs without review', () => {
  assert.equal(wantsReview(verdict('allow')), false)
  assert.deepEqual(decide('bash', verdict('allow'), SKIPPED), { kind: 'run' })
})

test('review runs only when the review allows it, otherwise the user is asked', () => {
  assert.equal(wantsReview(verdict('review')), true)
  assert.deepEqual(decide('bash', verdict('review'), { kind: 'allow' }), { kind: 'run' })
  for (const second of [SKIPPED, { kind: 'deny', reason: 'no instruction' }, { kind: 'error', message: 'offline' }] as SecondStage[]) {
    assert.equal(decide('bash', verdict('review'), second).kind, 'ask')
  }
})

test('block never runs on its own', () => {
  assert.equal(wantsReview(verdict('block')), true)
  assert.equal(decide('bash', verdict('block'), { kind: 'allow' }).kind, 'ask')
  for (const second of [SKIPPED, { kind: 'deny' }, { kind: 'error', message: 'offline' }] as SecondStage[]) {
    assert.equal(decide('bash', verdict('block'), second).kind, 'deny')
  }
  const tooLong = decide('bash', verdict('block', { reason_code: 'input_token_limit' }), SKIPPED)
  assert.equal(tooLong.kind, 'deny')
})

test('a failure to judge asks the user and is never reviewed', () => {
  const failed: FirstStage = { kind: 'error', message: 'model_not_installed' }
  assert.equal(wantsReview(failed), false)
  const outcome = decide('bash', failed, SKIPPED)
  assert.equal(outcome.kind, 'ask')
  assert.ok(outcome.kind === 'ask' && outcome.display.en !== '' && outcome.display.zh !== '')
})
