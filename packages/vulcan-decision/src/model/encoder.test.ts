import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide, planBatches, type EncodedCall } from './encoder.js'

const LABELS = { labels: ['allow', 'review', 'block'], allow_margin: 1 }

test('takes the highest score', () => {
  assert.equal(decide([5, 1, 0], LABELS), 'allow')
  assert.equal(decide([0, 3, 1], LABELS), 'review')
  assert.equal(decide([0, 1, 3], LABELS), 'block')
})

test('turns a narrow allow into review', () => {
  assert.equal(decide([2, 1.5, 0], LABELS), 'review')
  assert.equal(decide([2, 0, 1.5], LABELS), 'review')
  assert.equal(decide([2, 1, 0], LABELS), 'allow')
})

test('keeps the first label on ties', () => {
  assert.equal(decide([0, 3, 3], LABELS), 'review')
})

test('refuses scores that do not match the labels', () => {
  assert.throws(() => decide([1, 2], LABELS))
  assert.throws(() => decide([1, Number.NaN, 0], LABELS))
})

function calls(...lengths: number[]): EncodedCall[] {
  return lengths.map(length => ({ ids: new Array<number>(length).fill(1), markers: [1, 2, 3] }))
}

test('batches calls by length within the batch size', () => {
  const batches = planBatches(calls(30, 10, 20, 40, 50), { micro_batch: 2, max_request_items: 256, max_tokens: 32768 })
  assert.deepEqual(batches, [[1, 2], [0, 3], [4]])
})

test('keeps each padded batch within the token budget', () => {
  const config = { micro_batch: 16, max_request_items: 256, max_tokens: 100 }
  const input = calls(40, 40, 40, 10)
  const batches = planBatches(input, config)
  assert.deepEqual(batches.flat().sort(), [0, 1, 2, 3])
  for (const batch of batches) {
    const longest = Math.max(...batch.map(index => input[index]!.ids.length))
    assert.ok(batch.length * longest <= config.max_tokens)
  }
})
