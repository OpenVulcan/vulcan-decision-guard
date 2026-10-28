import assert from 'node:assert/strict'
import { test } from 'node:test'

import { declarationOf, manifestFiles } from './models.js'

const digest = (bytes: number) => ({ bytes, sha256: 'ab'.repeat(32) })

test('manifests may list only plain relative paths', () => {
  for (const unsafe of ['../evil', 'a/../b', '/abs', 'C:/x', 'a\\b', 'a//b', './a']) {
    assert.throws(() => manifestFiles({ files: { [unsafe]: digest(1) } }), /unsafe path/, unsafe)
  }
  assert.throws(() => manifestFiles({ files: { 'a.bin': { bytes: 1, sha256: 'short' } } }), /malformed/)
})

test('a torch release installs its runtime subset with the fp32 weights only', () => {
  const declaration = declarationOf('manifest.json', JSON.stringify({
    model: 'vulcan-decision-shell-v1-mini',
    files: {
      'decision.py': digest(1), 'runtime/runtime-config.json': digest(1), 'tokenizer/tokenizer.json': digest(1),
      'weights/formats.json': digest(1), 'weights/fp32/model.safetensors': digest(9), 'weights/fp16/model.safetensors': digest(5),
      'training/v65/rows.jsonl': digest(7), 'README.md': digest(1),
    },
  }))
  assert.equal(declaration.format, 'torch-release')
  assert.equal(declaration.id, 'vulcan-decision-shell-v1-mini')
  assert.deepEqual(Object.keys(declaration.files).sort(), [
    'README.md', 'decision.py', 'runtime/runtime-config.json', 'tokenizer/tokenizer.json', 'weights/formats.json', 'weights/fp32/model.safetensors',
  ])
})

test('a runtime package is named after its family and format', () => {
  const declaration = declarationOf('MANIFEST.json', JSON.stringify({
    format_version: 2, family: 'flash', format: 'fp16',
    files: {
      'model.onnx': digest(9), 'runtime-config.json': digest(1), 'assets/policy-v2.json': digest(1), 'assets/tokenizer.json': digest(1),
    },
  }))
  assert.equal(declaration.format, 'onnx-delivery')
  assert.equal(declaration.id, 'vulcan-decision-shell-v1-flash-fp16')
  assert.equal(declaration.family, 'flash')
  const older = { format_version: 1, family: 'flash', format: 'fp16', files: {} }
  assert.throws(() => declarationOf('MANIFEST.json', JSON.stringify(older)), /format 1 is not supported/)
  const unknown = { format_version: 2, family: 'huge', format: 'fp16', files: {} }
  assert.throws(() => declarationOf('MANIFEST.json', JSON.stringify(unknown)), /no known family/)
})
