import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

import { parseAnswer, reviewCall, reviewInput, reviewPolicy, type ReviewRequest } from './review.js'

test('accepts only the closed answer shapes of each attendance mode', () => {
  assert.deepEqual(parseAnswer('{"decision":"allow"}', true), { kind: 'allow' })
  assert.deepEqual(parseAnswer(' ```json\n{"decision":"deny","reason":"not asked"}\n``` ', true), { kind: 'deny', reason: 'not asked' })
  assert.deepEqual(parseAnswer('{"decision":"review","reason":"scope unclear"}', true), { kind: 'review', reason: 'scope unclear' })
  assert.deepEqual(parseAnswer('{"decision":"forbid","reason":"rule 1"}', true), { kind: 'forbid', reason: 'rule 1' })
  assert.deepEqual(parseAnswer('{"decision":"deny"}', false), { kind: 'deny' })
  for (const text of ['allow', '{"decision":"allow","reason":"x"}', '{"decision":"yes"}', '[]', '{"decision":"deny","reason":1}']) {
    assert.equal(parseAnswer(text, true).kind, 'error', text)
  }
  // Unattended reviewers have only allow and deny.
  for (const text of ['{"decision":"review","reason":"x"}', '{"decision":"forbid","reason":"x"}']) {
    assert.equal(parseAnswer(text, false).kind, 'error', text)
  }
})

test('the unattended policy offers only allow and deny', () => {
  assert.match(reviewPolicy(true, undefined), /"forbid"/)
  assert.doesNotMatch(reviewPolicy(false, undefined), /"review","reason"|"forbid","reason"/)
})

test('the policy names the interface language for reasons when it is known', () => {
  assert.match(reviewPolicy(true, 'zh-TW'), /"zh-TW"/)
  assert.doesNotMatch(reviewPolicy(true, undefined), /BCP 47 tag "/)
})

const REQUEST: ReviewRequest = {
  provider: 'p',
  model: 'm',
  attended: true,
  language: 'zh',
  project: '/work/demo',
  options: { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' },
  rules: { allow: 'Reading logs is fine.', deny: '', forbid: 'Never touch the billing database.' },
  stage: 'review',
  tool: 'bash',
  arguments: { command: 'psql -c "DROP DATABASE orders"' },
  intent: 'Reset the local test database before the migration test.',
  history: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Drop the orders database.' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool output must not appear' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
  ] as unknown as Message[],
}

test('the review input carries rules, instructions, calls and intent, not tool output', () => {
  const input = reviewInput(REQUEST)
  assert.match(input, /Never touch the billing database/)
  assert.match(input, /Reset the local test database/)
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
