import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { DEFAULT_OPTIONS, DecisionError, POLICY_VERSION } from '../protocol.js'
import { OpenVulcanAccount, type Credential, type CredentialStore } from './account.js'
import { EdgeClient, TEST_ATTEMPTS, isEndpointOrigin, parseJudgeAnswer, parseServerTiming, selectEndpoint, testCommand, type EdgeEndpoint, type ProbeResult } from './edge.js'
import { startMockOpenVulcan } from './mock-openvulcan.test.helper.js'

class MemoryStore implements CredentialStore {
  value: Credential | undefined
  async read() { return this.value }
  async write(credential: Credential) { this.value = credential }
  async delete() { this.value = undefined }
}

const mock = await startMockOpenVulcan({ edges: [{ id: 'slow', delayMs: 60 }, { id: 'fast' }] })
after(() => mock.close())

async function client(): Promise<EdgeClient> {
  const account = new OpenVulcanAccount(new MemoryStore(), { display_name: 'test', client_version: 'test 0' }, mock.origin)
  const pending = await account.signIn('cn')
  await mock.approve(pending.approvalUrl)
  await pending.done
  return new EdgeClient(account)
}

const SAFE = { settings: DEFAULT_OPTIONS, rendered: 'Tool: shell_command\nArguments: {"command":"git status"}' }
const RISKY = { settings: DEFAULT_OPTIONS, rendered: 'Tool: shell_command\nArguments: {"command":"psql -c \'DROP DATABASE production\'"}' }

test('lists the account\'s models', async () => {
  assert.deepEqual(await (await client()).models(), [mock.model])
})

test('measures the endpoints and uses the fastest', async () => {
  const edge = await client()
  const snapshot = await edge.probe(mock.model)
  assert.equal(snapshot.selectedEndpointId, 'fast')
  assert.equal(snapshot.mode, 'auto')
  assert.equal(snapshot.endpoints.length, 2)
  assert.ok(snapshot.endpoints.every(row => row.ready === true && row.acceptsSite === true && row.region === 'test' && row.scoreMs !== undefined))
  assert.equal(snapshot.nextProbeAtMs! - snapshot.probedAtMs!, 10 * 60_000)
  const { results, endpoint } = await edge.judge(mock.model, [SAFE, RISKY])
  assert.equal(endpoint, 'fast')
  assert.deepEqual(results.map(result => result.decision), ['allow', 'review'])
})

test('an empty saved model resolves to the first model OpenVulcan lists', async () => {
  const edge = await client()
  assert.equal(await edge.resolveModel(''), mock.model)
  assert.equal(await edge.resolveModel('saved-model'), 'saved-model')
})

test('a model OpenVulcan does not enable fails with its name and shows in the snapshot', async () => {
  const edge = await client()
  await assert.rejects(edge.probe('not-enabled'), (error: unknown) => error instanceof DecisionError && error.code === 'backend_unavailable' && error.message.includes('not-enabled'))
  const snapshot = edge.snapshot('not-enabled')
  assert.deepEqual(snapshot.endpoints, [])
  assert.match(snapshot.error ?? '', /not-enabled/)
})

test('a request test times five real judgements of one endpoint', async () => {
  const edge = await client()
  const result = await edge.requestTest(mock.model, 'fast', { kind: 'preset', preset: 'ordinary' })
  assert.equal(result.attempts.length, TEST_ATTEMPTS)
  assert.equal(result.succeeded, TEST_ATTEMPTS)
  const [first] = result.attempts
  assert.equal(first?.httpStatus, 200)
  assert.equal(first?.endpointMs, 4)
  assert.equal(first?.computeMs, 2.5)
  assert.equal(first?.answer?.region, 'test')
  assert.equal(first?.answer?.results[0]?.decision, 'allow')
  assert.ok(result.minMs! <= result.medianMs! && result.medianMs! <= result.maxMs!)
  await assert.rejects(edge.requestTest(mock.model, 'missing', { kind: 'preset', preset: 'ordinary' }), (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request')
})

test('request test commands and Server-Timing parsing', () => {
  assert.equal(testCommand({ kind: 'preset', preset: 'destructive' }), 'rm -rf ~')
  assert.ok(testCommand({ kind: 'preset', preset: 'oversized' }).length > 120_000)
  assert.throws(() => testCommand({ kind: 'custom', command: '  ' }), (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request')
  assert.deepEqual(parseServerTiming('edge;dur=45, node;dur=40.5, queue;dur=-1, other;dur=3, compute;dur=x'), { edge: 45, node: 40.5 })
})

test('a locked endpoint is used even when it is slower', async () => {
  const edge = await client()
  await edge.probe(mock.model)
  const { endpoint } = await edge.judge(mock.model, [SAFE], 'slow')
  assert.equal(endpoint, 'slow')
  await assert.rejects(edge.judge(mock.model, [SAFE], 'missing'), (error: unknown) => error instanceof DecisionError && error.code === 'backend_unavailable')
})

test('a refused grant is renewed once and the call retried', async () => {
  const edge = await client()
  await edge.judge(mock.model, [SAFE], 'fast')
  const grants = mock.grantsIssued()
  mock.edges.find(item => item.id === 'fast')!.failNext = 401
  const { results } = await edge.judge(mock.model, [SAFE], 'fast')
  assert.equal(results[0]?.decision, 'allow')
  assert.equal(mock.grantsIssued(), grants + 1)
})

test('rate limits and server failures never become decisions', async () => {
  const edge = await client()
  const fast = mock.edges.find(item => item.id === 'fast')!
  fast.failNext = 429
  await assert.rejects(edge.judge(mock.model, [SAFE], 'fast'), (error: unknown) => error instanceof DecisionError && error.code === 'rate_limited')
  fast.failNext = 503
  await assert.rejects(edge.judge(mock.model, [SAFE], 'fast'), (error: unknown) => error instanceof DecisionError && error.code === 'backend_unavailable')
})

test('judging without a sign-in fails as not signed in', async () => {
  const edge = new EdgeClient(new OpenVulcanAccount(new MemoryStore(), { display_name: 'test', client_version: 'test 0' }, mock.origin))
  await assert.rejects(edge.judge(mock.model, [SAFE]), (error: unknown) => error instanceof DecisionError && error.code === 'not_signed_in')
})

const ENDPOINTS: EdgeEndpoint[] = [
  { endpoint_id: 'a', endpoint: 'https://a.example', priority: 0, online: true },
  { endpoint_id: 'b', endpoint: 'https://b.example', priority: 1, online: true },
]
function probe(id: string, rtt: number, compute: number | null, excluded?: ProbeResult['excluded']): ProbeResult {
  return {
    endpoint_id: id, rtt_ms: rtt, at: 0,
    status: { endpoint_id: id, model_id: 'm', sites: ['cn'], ready: true, compute_ms: compute === null ? null : { p50: compute, p95: compute } },
    ...excluded === undefined ? {} : { excluded },
  }
}

test('selection adds compute time only when every endpoint reports it', () => {
  assert.equal(selectEndpoint(ENDPOINTS, [probe('a', 10, 50), probe('b', 30, 5)], undefined), 'b')
  assert.equal(selectEndpoint(ENDPOINTS, [probe('a', 10, 50), probe('b', 30, null)], undefined), 'a')
})

test('selection keeps the current endpoint unless the best is clearly better', () => {
  assert.equal(selectEndpoint(ENDPOINTS, [probe('a', 100, 0), probe('b', 90, 0)], 'a'), 'a')
  assert.equal(selectEndpoint(ENDPOINTS, [probe('a', 100, 0), probe('b', 50, 0)], 'a'), 'b')
  assert.equal(selectEndpoint(ENDPOINTS, [probe('a', 10, 0, 'not_ready'), probe('b', 90, 0)], 'a'), 'b')
})

test('judge answers must match the request, the checkpoint form and the policy', () => {
  const answer = (patch: Record<string, unknown>) => JSON.stringify({
    request_id: 'r1', checkpoint_sha256: 'f'.repeat(64), policy_version: POLICY_VERSION, results: [{ label: 'block' }], ...patch,
  })
  assert.equal(parseJudgeAnswer(answer({}), 'r1', 1)[0]?.decision, 'block')
  for (const bad of [{ request_id: 'r2' }, { checkpoint_sha256: 'x' }, { policy_version: 'other' }, { results: [] }, { results: [{ label: 'maybe' }] }]) {
    assert.throws(() => parseJudgeAnswer(answer(bad), 'r1', 1), (error: unknown) => error instanceof DecisionError && error.code === 'model_failed')
  }
})

test('endpoint origins are bare https origins or loopback http', () => {
  assert.equal(isEndpointOrigin('https://edge.example'), true)
  assert.equal(isEndpointOrigin('http://127.0.0.1:8080'), true)
  assert.equal(isEndpointOrigin('http://edge.example'), false)
  assert.equal(isEndpointOrigin('https://edge.example/v1'), false)
})
