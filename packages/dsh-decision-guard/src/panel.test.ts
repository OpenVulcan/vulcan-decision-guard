import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { DecisionEngine, DecisionHome, DEFAULT_OPTIONS, type EngineSettings } from '@openvulcan/vulcan-decision'

import { startMockOpenVulcan } from '../../vulcan-decision/lib/cloud/mock-openvulcan.test.helper.js'
import { CREDENTIAL_KEY, DshCredentialStore, handle, Panel, ROUTES, type CredentialRecords } from './panel.js'

/** dsh's credential service, reduced to one in-memory record per key. */
class Records implements CredentialRecords {
  readonly values = new Map<string, CredentialRecord>()
  async readRecord(key: string) { return this.values.get(key) }
  async modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const next = await mutate(this.values.get(key))
    if (next !== undefined) this.values.set(key, next)
    return next ?? this.values.get(key)
  }
  async deleteRecord(key: string) { this.values.delete(key) }
}

const mock = await startMockOpenVulcan({ site: 'global' })
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-decision-panel-'))
after(async () => {
  await mock.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const records = new Records()
const engine = new DecisionEngine({
  home: new DecisionHome(root),
  credentials: new DshCredentialStore(() => records),
  device: { display_name: 'test', client_version: 'test 0' },
  authOrigin: mock.origin,
})
const settings: EngineSettings = { backend: 'cloud', cloudModel: mock.model, options: DEFAULT_OPTIONS }
const panel = new Panel(engine, { engine: () => settings, downloadSource: () => 'official' })

async function route(method: 'GET' | 'POST', name: string, query = '', body?: unknown): Promise<{ status: number; answer: { ok: boolean; value?: unknown; error?: { code: string } } }> {
  const entry = ROUTES.find(([m, n]) => m === method && n === name)
  assert.ok(entry, `${method} ${name} is a route`)
  const request = new Request(`http://127.0.0.1/api/vulcan-decision/${name}${query}`, {
    method,
    ...body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  })
  const response = await handle(panel, entry[2], request)
  return { status: response.status, answer: await response.json() as never }
}

test('signs in from the panel and keeps the credential as a dsh grant record', async () => {
  const { answer } = await route('POST', 'signin', '?site=global')
  const { approvalUrl } = answer.value as { approvalUrl: string }
  await mock.approve(approvalUrl)
  for (let attempt = 0; attempt < 50 && !(await engine.account.status()).signedIn; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const record = records.values.get(CREDENTIAL_KEY)
  assert.equal(record?.kind, 'grant')
  assert.equal((record as { payload: { site: string } }).payload.site, 'global')
  const { answer: state } = await route('GET', 'state')
  const value = state.value as { account: { signedIn: boolean }; signIn: unknown; packs: { id: string }[] }
  assert.equal(value.account.signedIn, true)
  assert.equal(value.signIn, null)
  assert.deepEqual(value.packs.map(pack => pack.id), ['onnx-cpu', 'onnx-cuda', 'torch-cpu', 'torch-cu128'])
  // No answer carries the token.
  assert.equal(JSON.stringify(state).includes((record as { payload: { access_token: string } }).payload.access_token), false)
})

test('measures endpoints and judges a sample call with the saved settings', async () => {
  const probe = await route('POST', 'cloud/probe')
  assert.equal(probe.answer.ok, true)
  const { answer } = await route('POST', 'test', '', { tool: 'shell_command', args: { command: 'psql -c "DROP DATABASE production"' } })
  assert.equal(answer.ok, true)
  assert.deepEqual({ ...(answer.value as object), elapsed_ms: 0 }, {
    decision: 'review', logits: [1, 0, -1], input_tokens: 12, model_evaluated: true,
    backend: 'cloud', model: mock.model, via: 'edge-a', elapsed_ms: 0,
  })
})

test('requests are checked and failures carry a code', async () => {
  assert.equal((await route('POST', 'packs/install', '?pack=nope')).status, 400)
  assert.equal((await route('POST', 'models/install-dir', '', { dir: '' })).answer.error?.code, 'invalid_request')
  assert.equal((await route('POST', 'signin', '?site=mars')).status, 400)
})

test('signing out revokes the device and deletes the record', async () => {
  await route('POST', 'signout')
  assert.equal(records.values.has(CREDENTIAL_KEY), false)
  assert.equal(mock.revoked.length, 1)
  const { status, answer } = await route('POST', 'test', '', { tool: 'shell_command', args: { command: 'ls' } })
  assert.equal(status, 401)
  assert.equal(answer.error?.code, 'not_signed_in')
})
