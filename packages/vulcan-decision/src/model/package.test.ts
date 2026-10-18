import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { HOME_ENV } from '../paths.js'
import { DecisionError, type ModelSize } from '../protocol.js'
import { installFromDirectory, listInstalled, MODEL_FORMAT, recommendedSize, removeInstalled, selectModel, type InstalledModel } from './package.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-decision-package-'))
process.env[HOME_ENV] = path.join(scratch, 'home')

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const GIB = 1024 ** 3

test('recommends a size from total memory', () => {
  assert.equal(recommendedSize(8 * GIB), '0.2b')
  assert.equal(recommendedSize(16 * GIB), '0.4b')
  assert.equal(recommendedSize(64 * GIB), '0.6b')
})

function installed(...sizes: ModelSize[]): InstalledModel[] {
  return sizes.map(size => ({
    root: size,
    manifest: { format: MODEL_FORMAT, id: `model-${size}`, size, variants: [{ file: 'model.onnx', precision: 'fp32', devices: ['cpu'] }], files: {} },
  }))
}

test('selects the requested size or refuses', () => {
  assert.equal(selectModel('0.4b', installed('0.2b', '0.4b')).manifest.id, 'model-0.4b')
  assert.throws(() => selectModel('0.6b', installed('0.2b')), isNotInstalled)
  assert.throws(() => selectModel(undefined, []), isNotInstalled)
})

test('without a size, selects the largest installed model this device suits', () => {
  const limit = recommendedSize()
  const chosen = selectModel(undefined, installed('0.2b', '0.4b', '0.6b')).manifest.size
  assert.equal(chosen, limit)
})

function isNotInstalled(error: unknown): boolean {
  return error instanceof DecisionError && error.code === 'model_not_installed'
}

/** Write a package source with a model.json covering the given files. */
function writeSource(name: string, files: Record<string, string>, digestOverride?: Record<string, string>): string {
  const root = path.join(scratch, name)
  const digests: Record<string, { bytes: number; sha256: string }> = {}
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
    const sha256 = digestOverride?.[relative] ?? createHash('sha256').update(content).digest('hex')
    digests[relative] = { bytes: Buffer.byteLength(content), sha256 }
  }
  const manifest = { format: MODEL_FORMAT, id: 'source', size: '0.2b', variants: [{ file: 'model.onnx', precision: 'fp32', devices: ['cpu'] }], files: digests }
  fs.writeFileSync(path.join(root, 'model.json'), JSON.stringify(manifest))
  return root
}

const PACKAGE_FILES = { 'runtime-config.json': '{"max_tokens":32768}', 'model.onnx': 'graph', 'assets/tokenizer.json': '{}' }

test('installs a package under the size and id it is given, replacing the same size', async () => {
  const source = writeSource('good', PACKAGE_FILES)
  await installFromDirectory(source, { size: '0.4b', id: 'first' })
  const second = await installFromDirectory(source, { size: '0.4b' })
  assert.deepEqual(listInstalled().map(model => model.manifest.id), [second.manifest.id])
  assert.equal(second.manifest.size, '0.4b')
  assert.equal(fs.readFileSync(path.join(second.root, 'model.onnx'), 'utf8'), 'graph')
  assert.ok(removeInstalled('0.4b'))
  assert.deepEqual(listInstalled(), [])
})

test('installs nothing when a file does not match its digest', async () => {
  const source = writeSource('bad', PACKAGE_FILES, { 'model.onnx': '0'.repeat(64) })
  await assert.rejects(installFromDirectory(source, { size: '0.2b' }), /does not match/)
  assert.deepEqual(listInstalled(), [])
  assert.deepEqual(fs.readdirSync(path.join(process.env[HOME_ENV]!, 'models')), [])
})

test('refuses an unsafe model id', async () => {
  const source = writeSource('unsafe', PACKAGE_FILES)
  await assert.rejects(installFromDirectory(source, { size: '0.2b', id: '../escape' }), /invalid model id/)
})
