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

test('an ONNX delivery is named after its model file and digest', () => {
  const declaration = declarationOf('MANIFEST.json', JSON.stringify({
    model_file: 'models/risk164-attention-fp32.onnx',
    files: {
      'models/risk164-attention-fp32.onnx': { bytes: 1, sha256: '5a4c35b5'.padEnd(64, '0') },
      'runtime-config.json': digest(1), 'assets/policy-v2.json': digest(1), 'assets/tokenizer.json': digest(1),
    },
  }))
  assert.equal(declaration.format, 'onnx-delivery')
  assert.equal(declaration.id, 'risk164-attention-fp32-5a4c35b5')
  assert.throws(() => declarationOf('MANIFEST.json', JSON.stringify({ model_file: 'missing.onnx', files: {} })), /names no listed model file/)
})
