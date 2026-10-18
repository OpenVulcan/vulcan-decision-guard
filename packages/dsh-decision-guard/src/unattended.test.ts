import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { applyUnattended, UNATTENDED_RECORD, type GuardSessionView } from './unattended.js'

function record(data: unknown, type: string = UNATTENDED_RECORD): SessionEvent {
  return { type, seq: 1, time: 0, data, ignorable: true } as unknown as SessionEvent
}

const OFF: GuardSessionView = { unattended: false }

test('the latest switch record sets the state', () => {
  const on = applyUnattended(OFF, record({ enabled: true }))
  assert.equal(on.unattended, true)
  assert.equal(applyUnattended(on, record({ enabled: false })).unattended, false)
})

test('unrelated events and malformed records keep the same state reference', () => {
  assert.equal(applyUnattended(OFF, { type: 'turn/start', seq: 1, time: 0, data: {} } as unknown as SessionEvent), OFF)
  assert.equal(applyUnattended(OFF, record({ enabled: 'yes' })), OFF)
  assert.equal(applyUnattended(OFF, record({ enabled: true }, 'plugin:someone-else/unattended')), OFF)
  assert.equal(applyUnattended(OFF, record({ enabled: false })), OFF)
})
