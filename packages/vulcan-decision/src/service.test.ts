import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { DecisionClient, exchange, ping } from './client.js'
import { endpointPath, HOME_ENV } from './paths.js'
import { CONTRACT_VERSION, DecisionError, type JudgeSettings, type Verdict } from './protocol.js'
import { serve } from './service.js'
import type { ModelInput } from './model/runtime.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-decision-service-'))
process.env[HOME_ENV] = scratch

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const SETTINGS: JudgeSettings = {
  backend: 'local',
  options: { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' },
}

/** A model host that blocks anything mentioning DROP and records what it was asked. */
function fakeModels() {
  const seen: ModelInput[] = []
  return {
    seen,
    host: {
      async judge(_size: unknown, input: ModelInput): Promise<Verdict> {
        seen.push(input)
        if (input.rendered.includes('explode')) throw new Error('session failed')
        return { decision: input.rendered.includes('DROP') ? 'block' : 'allow', model: 'fake' }
      },
      status: () => [],
      close: async () => {},
    },
  }
}

test('answers ping, judge, status and errors, then shuts down', async () => {
  const models = fakeModels()
  let stopped = false
  const handle = await serve({ models: models.host, onStopped: () => { stopped = true } })
  assert.ok(handle)
  try {
    const signal = AbortSignal.timeout(5_000)
    const endpoint = endpointPath()
    assert.equal((await ping(endpoint, signal)).type, 'pong')
    assert.equal(await serve({ models: models.host, onStopped: () => {} }), undefined, 'a second service must not take the endpoint')

    const client = new DecisionClient()
    try {
      const allow = await client.judge({ host: 'dsh', project: '/p', tool: 'bash', arguments: { command: 'ls' } }, SETTINGS, signal)
      assert.equal(allow.decision, 'allow')
      assert.equal(models.seen[0]?.rendered, 'Project: /p\nTool: bash\nArguments: {"command":"ls"}')
      assert.deepEqual(models.seen[0]?.options, SETTINGS.options)
      const block = await client.judge({ host: 'dsh', tool: 'bash', arguments: { command: 'psql -c "DROP DATABASE x"' } }, SETTINGS, signal)
      assert.equal(block.decision, 'block')

      await assert.rejects(client.judge({ host: 'dsh', tool: 'bash', arguments: { command: 'ls' } }, { ...SETTINGS, backend: 'cloud' }, signal), hasCode('backend_unavailable'))
      await assert.rejects(client.judge({ host: 'dsh', tool: 'bash', arguments: [] as unknown as Record<string, unknown> }, SETTINGS, signal), hasCode('invalid_request'))
      await assert.rejects(client.judge({ host: 'dsh', tool: 'bash', arguments: { command: 'explode' } }, SETTINGS, signal), hasCode('model_failed'))

      const status = await client.status(signal)
      assert.equal(status.judged, 2)
      assert.equal(status.pid, process.pid)
    } finally {
      client.close()
    }

    const mismatch = await exchange(endpoint, { type: 'ping', contract: CONTRACT_VERSION + 1 }, signal)
    assert.deepEqual(mismatch, { type: 'contract_mismatch', contract: CONTRACT_VERSION })
    assert.equal((await exchange(endpoint, { type: 'shutdown' }, signal)).type, 'shutting_down')
    await waitFor(() => stopped)
    await assert.rejects(ping(endpoint, AbortSignal.timeout(1_000)))
  } finally {
    await handle.stop()
  }
})

test('stops after the idle limit once no connection is open', async () => {
  let stopped = false
  const handle = await serve({ models: fakeModels().host, idleShutdownMs: 200, onStopped: () => { stopped = true } })
  assert.ok(handle)
  try {
    await waitFor(() => stopped)
  } finally {
    await handle.stop()
  }
})

test('answers a malformed frame with invalid_request', async () => {
  const handle = await serve({ models: fakeModels().host, onStopped: () => {} })
  assert.ok(handle)
  try {
    const net = await import('node:net')
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(endpointPath())
      let text = ''
      socket.on('data', (chunk) => { text += chunk.toString('utf8') })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
      socket.write('not json\n')
    })
    assert.equal((JSON.parse(answer) as { code: string }).code, 'invalid_request')
  } finally {
    await handle.stop()
  }
})

function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof DecisionError && error.code === code
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
