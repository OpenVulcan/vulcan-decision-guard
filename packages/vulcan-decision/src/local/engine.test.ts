import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeRequests, splitResults } from './engine.js'

test('merged calls are split at the package limit and keep their order', () => {
  assert.deepEqual(mergeRequests([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(mergeRequests([1, 2, 3], undefined), [[1, 2, 3]])
  assert.deepEqual(mergeRequests([], 4), [])
})

test('each caller gets back its own slice of the merged results', () => {
  const groups = [['a'], ['b', 'c'], [], ['d']]
  assert.deepEqual(splitResults(groups, [1, 2, 3, 4]), [[1], [2, 3], [], [4]])
})
