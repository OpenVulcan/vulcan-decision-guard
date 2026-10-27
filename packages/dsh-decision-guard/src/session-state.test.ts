import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { applySessionRecord, REVIEW_PROMPT_RECORD, UNATTENDED_RECORD, type GuardSessionView } from './session-state.js'

function record(data: unknown, type: string = UNATTENDED_RECORD): SessionEvent {
  return { type, seq: 1, time: 0, data, ignorable: true } as unknown as SessionEvent
}

const INITIAL: GuardSessionView = { unattended: false, denyPolicy: '', reviewPrompt: null }

test('the latest switch record sets unattended mode and its deny policy', () => {
  const on = applySessionRecord(INITIAL, record({ enabled: true, denyPolicy: 'never push' }))
  assert.deepEqual(on, { unattended: true, denyPolicy: 'never push', reviewPrompt: null })
  const off = applySessionRecord(on, record({ enabled: false }))
  assert.deepEqual(off, INITIAL)
})

test('a switch record written before deny policies existed turns unattended on without one', () => {
  assert.deepEqual(applySessionRecord(INITIAL, record({ enabled: true })), { unattended: true, denyPolicy: '', reviewPrompt: null })
})

test('the latest review prompt record sets the session prompt, and null follows the default again', () => {
  const own = applySessionRecord(INITIAL, record({ prompt: 'ask before network calls' }, REVIEW_PROMPT_RECORD))
  assert.equal(own.reviewPrompt, 'ask before network calls')
  assert.equal(applySessionRecord(own, record({ prompt: null }, REVIEW_PROMPT_RECORD)).reviewPrompt, null)
})

test('unrelated events, malformed records and repeated values keep the same state reference', () => {
  assert.equal(applySessionRecord(INITIAL, { type: 'turn/start', seq: 1, time: 0, data: {} } as unknown as SessionEvent), INITIAL)
  assert.equal(applySessionRecord(INITIAL, record({ enabled: 'yes' })), INITIAL)
  assert.equal(applySessionRecord(INITIAL, record({ enabled: true, denyPolicy: 3 })), INITIAL)
  assert.equal(applySessionRecord(INITIAL, record({ enabled: true }, 'plugin:someone-else/unattended')), INITIAL)
  assert.equal(applySessionRecord(INITIAL, record({ enabled: false })), INITIAL)
  assert.equal(applySessionRecord(INITIAL, record({ prompt: 7 }, REVIEW_PROMPT_RECORD)), INITIAL)
  assert.equal(applySessionRecord(INITIAL, record({ prompt: null }, REVIEW_PROMPT_RECORD)), INITIAL)
})
