import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

import { parseAnswer, reviewCall, reviewInput, type ReviewRequest } from './review.js'

test('accepts only the closed answer shapes', () => {
  assert.deepEqual(parseAnswer('{"decision":"allow"}'), { kind: 'allow' })
  assert.deepEqual(parseAnswer(' ```json\n{"decision":"deny","reason":"not asked"}\n``` '), { kind: 'deny', reason: 'not asked' })
  assert.deepEqual(parseAnswer('{"decision":"deny"}'), { kind: 'deny' })
  for (const text of ['allow', '{"decision":"allow","reason":"x"}', '{"decision":"yes"}', '[]', '{"decision":"deny","reason":1}']) {
    assert.equal(parseAnswer(text).kind, 'error', text)
  }
})

const REQUEST: ReviewRequest = {
  provider: 'p',
  model: 'm',
  project: '/work/demo',
  options: { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' },
  stage: 'review',
  tool: 'bash',
  arguments: { command: 'psql -c "DROP DATABASE orders"' },
  history: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Drop the orders database.' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool output must not appear' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
  ] as unknown as Message[],
}

test('the review input carries instructions and calls, not tool output', () => {
  const input = reviewInput(REQUEST)
  assert.match(input, /Drop the orders database/)
  assert.match(input, /"tool": "bash"/)
  assert.doesNotMatch(input, /tool output must not appear/)
  assert.match(input, /DROP DATABASE orders/)
})

function llmAnswering(chunks: StreamChunk[], seen?: GenerateOptions[]) {
  return {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen?.push(options)
      yield* chunks
    },
  }
}

test('reads the streamed answer from the session route', async () => {
  const seen: GenerateOptions[] = []
  const llm = llmAnswering([
    { type: 'text-delta', index: 0, text: '{"decision":' },
    { type: 'text-delta', index: 0, text: '"allow"}' },
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ], seen)
  assert.deepEqual(await reviewCall(llm, REQUEST, new AbortController().signal), { kind: 'allow' })
  assert.equal(seen[0]?.provider, 'p')
  assert.equal(seen[0]?.model, 'm')
})

test('an unfinished or failed stream is an error, never an allow', async () => {
  const unfinished = llmAnswering([{ type: 'text-delta', index: 0, text: '{"decision":"allow"}' }])
  assert.equal((await reviewCall(unfinished, REQUEST, new AbortController().signal)).kind, 'error')
  const truncated = llmAnswering([
    { type: 'text-delta', index: 0, text: '{"decision":"allow"}' },
    { type: 'finish', reason: { kind: 'length' } } as unknown as StreamChunk,
  ])
  assert.equal((await reviewCall(truncated, REQUEST, new AbortController().signal)).kind, 'error')
  const throwing = { stream(): AsyncIterable<StreamChunk> { throw new Error('no route') } }
  assert.deepEqual(await reviewCall(throwing, REQUEST, new AbortController().signal), { kind: 'error', message: 'no route' })
})
