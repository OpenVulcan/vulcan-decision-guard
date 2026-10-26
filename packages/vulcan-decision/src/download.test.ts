import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { fetchPinned, sourceUrl } from './download.js'

test('the cn source maps each official host to its mirror', () => {
  assert.equal(
    sourceUrl('https://files.pythonhosted.org/packages/ab/cd/numpy-2.2.5-cp311-cp311-win_amd64.whl', 'cn'),
    'https://mirrors.aliyun.com/pypi/packages/ab/cd/numpy-2.2.5-cp311-cp311-win_amd64.whl',
  )
  assert.equal(
    sourceUrl('https://download-r2.pytorch.org/whl/cu128/torch-2.9.1%2Bcu128-cp311-cp311-win_amd64.whl', 'cn'),
    'https://mirrors.aliyun.com/pytorch-wheels/cu128/torch-2.9.1+cu128-cp311-cp311-win_amd64.whl',
  )
  assert.match(sourceUrl('https://github.com/astral-sh/python-build-standalone/releases/download/20261021/x.tar.gz', 'cn'), /^https:\/\/registry\.npmmirror\.com\//)
})

test('an unknown host has no mirror and is refused rather than fetched from the official host', () => {
  assert.throws(() => sourceUrl('https://example.com/file.whl', 'cn'), /no mirror/)
  assert.equal(sourceUrl('https://example.com/file.whl', 'official'), 'https://example.com/file.whl')
})

test('pinned downloads resume a partial file and refuse a digest mismatch', async () => {
  const content = Buffer.from('x'.repeat(100_000))
  const ranges: (string | undefined)[] = []
  const server = http.createServer((request, response) => {
    ranges.push(request.headers.range)
    const start = Number(/bytes=(\d+)-/.exec(request.headers.range ?? '')?.[1] ?? 0)
    response.writeHead(start === 0 ? 200 : 206).end(content.subarray(start))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-decision-download-'))
  try {
    const dest = path.join(dir, 'file.bin')
    fs.writeFileSync(`${dest}.part`, content.subarray(0, 40_000))
    const sha256 = createHash('sha256').update(content).digest('hex')
    await fetchPinned({ name: 'file.bin', url, bytes: content.length, sha256 }, dest)
    assert.equal(ranges[0], 'bytes=40000-')
    assert.deepEqual(fs.readFileSync(dest), content)

    await assert.rejects(fetchPinned({ name: 'other.bin', url, bytes: content.length, sha256: '0'.repeat(64) }, path.join(dir, 'other.bin')))
    assert.equal(fs.existsSync(path.join(dir, 'other.bin')), false)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
