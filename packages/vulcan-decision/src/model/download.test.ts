import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { HOME_ENV } from '../paths.js'
import { chooseDownload, downloadModel, manifestFiles, type PublishedModel } from './download.js'
import { listInstalled, removeInstalled } from './package.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-decision-download-'))
process.env[HOME_ENV] = path.join(scratch, 'home')

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex')

/** A delivery package: the files and the `MANIFEST.json` that pins them. */
const FILES: Record<string, string> = {
  'runtime-config.json': JSON.stringify({ model_file: 'models/graph.onnx', precision: 'fp32', max_tokens: 64 }),
  'models/graph.onnx': 'graph',
  'assets/tokenizer.json': '{}',
}
const MANIFEST = JSON.stringify({
  files: Object.fromEntries(Object.entries(FILES).map(([name, body]) => [name, { bytes: Buffer.byteLength(body), sha256: sha256(body) }])),
})
const TOTAL = Object.values(FILES).reduce((sum, body) => sum + Buffer.byteLength(body), 0)

/** Loopback server publishing the package under `/models/`, recording each requested path. */
const requests: string[] = []
const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '').replace(/^\/models\//, ''))
  requests.push(name)
  const body = name === 'MANIFEST.json' ? MANIFEST : FILES[name]
  if (body === undefined) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/models/`

test.after(() => {
  server.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

function catalog(change: Partial<PublishedModel['download'] & object> = {}): PublishedModel[] {
  return [
    { size: '0.2b', precision: 'fp32', download: { baseUrl, manifestSha256: sha256(MANIFEST), totalBytes: TOTAL, ...change } },
    { size: '0.2b', precision: 'fp16-mixed', download: null },
  ]
}

test('a model without a published address is refused with a pointer to install', async () => {
  await assert.rejects(downloadModel({ size: '0.2b', precision: 'fp16-mixed', catalog: catalog() }), /no download address is published/)
  await assert.rejects(downloadModel({ size: '0.6b', precision: 'fp32', catalog: catalog() }), /no 0\.6b model is published/)
})

test('a download verifies every file, installs it and reuses verified files', async () => {
  requests.length = 0
  const model = await downloadModel({ size: '0.2b', precision: 'fp32', catalog: catalog() })
  assert.equal(model.manifest.size, '0.2b')
  assert.equal(fs.readFileSync(path.join(model.root, 'models', 'graph.onnx'), 'utf8'), 'graph')
  assert.equal(requests.length, Object.keys(FILES).length + 1)
  assert.deepEqual(fs.readdirSync(path.join(process.env[HOME_ENV]!, 'models')).filter(name => name.startsWith('.')), [])
  assert.ok(removeInstalled('0.2b'))

  // An interrupted download left the graph behind; only the rest is fetched again.
  const work = path.join(process.env[HOME_ENV]!, 'models', `.download-0.2b-fp32-${sha256(MANIFEST).slice(0, 12)}`)
  fs.mkdirSync(path.join(work, 'models'), { recursive: true })
  fs.writeFileSync(path.join(work, 'models', 'graph.onnx'), 'graph')
  requests.length = 0
  await downloadModel({ size: '0.2b', precision: 'fp32', catalog: catalog() })
  assert.ok(!requests.includes('models/graph.onnx'))
  assert.equal(listInstalled().length, 1)
  assert.ok(removeInstalled('0.2b'))
})

test('the pinned manifest digest and size guard the download', async () => {
  await assert.rejects(downloadModel({ size: '0.2b', precision: 'fp32', catalog: catalog({ manifestSha256: '0'.repeat(64) }) }), /pinned digest/)
  await assert.rejects(downloadModel({ size: '0.2b', precision: 'fp32', catalog: catalog({ totalBytes: TOTAL + 1 }) }), /pinned size/)
  assert.deepEqual(listInstalled(), [])
})

test('the default download is the largest fitting size, in the recommended format when published', () => {
  const published: PublishedModel[] = [
    { size: '0.2b', precision: 'fp16-mixed', download: null },
    { size: '0.2b', precision: 'fp32', download: null },
    { size: '0.4b', precision: 'fp16-mixed', download: null },
  ]
  assert.deepEqual(chooseDownload('0.6b', 'fp16-mixed', published), published[2])
  assert.deepEqual(chooseDownload('0.6b', 'fp32', published), published[2])
  assert.deepEqual(chooseDownload('0.2b', 'fp32', published), published[1])
  assert.equal(chooseDownload('0.2b', 'fp32', []), undefined)
})

test('manifest entries must stay inside the package', () => {
  for (const unsafe of ['../x', 'a\\b', '/abs', 'C:/x', 'a//b']) {
    assert.throws(() => manifestFiles(JSON.stringify({ files: { [unsafe]: { bytes: 1, sha256: '00' } } })), /unsafe path/)
  }
  assert.deepEqual(Object.keys(manifestFiles(MANIFEST)), Object.keys(FILES))
})
