import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionId } from '@deepseek-ai/dsh-session'

import { IntentStore } from './intent.js'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId

test('a statement is taken once, by the next call of its tool in its session', () => {
  const store = new IntentStore()
  store.put(A, 'bash', 'first')
  store.put(A, 'bash', 'second')
  store.put(A, 'write', 'notes')
  assert.equal(store.take(B, 'bash'), undefined)
  assert.equal(store.take(A, 'pwsh'), undefined)
  assert.equal(store.take(A, 'bash'), 'second')
  assert.equal(store.take(A, 'bash'), undefined)
  assert.equal(store.take(A, 'write'), 'notes')
})
