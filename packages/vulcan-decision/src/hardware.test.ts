import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assess, compareVersions, gpuGeneration, parseNvidiaRows, recommend, type Probes } from './hardware.js'

function machine(patch: Partial<Probes>): Probes {
  return { platform: 'win32', arch: 'x64', totalMemory: 32 * 1024 ** 3, cpus: 16, nvidia: undefined, adapters: [], npus: [], ...patch }
}

function card(computeCapability: string, driver: string) {
  return { name: `card ${computeCapability}`, vendor: 'nvidia' as const, computeCapability, driver }
}

test('a supported NVIDIA card with a recent driver is recommended the CUDA packs', () => {
  const recommendation = recommend(assess(machine({ nvidia: [card('12.0', '610.88')] })))
  assert.equal(recommendation.backend, 'local')
  assert.equal(recommendation.reason, 'cuda')
  assert.equal(recommendation.torchPack, 'torch-cu128')
  assert.equal(recommendation.onnxPack, 'onnx-cuda')
})

test('an old driver asks for a driver update and keeps the cloud', () => {
  const recommendation = recommend(assess(machine({ nvidia: [card('8.6', '531.18')] })))
  assert.equal(recommendation.backend, 'cloud')
  assert.equal(recommendation.reason, 'driver_update')
  assert.equal(recommendation.packs.find(pack => pack.pack === 'torch-cu128')?.fit, 'driver_too_old')
})

test('cards before Turing are not offered the CUDA packs', () => {
  const recommendation = recommend(assess(machine({ nvidia: [card('6.1', '610.88')] })))
  assert.equal(recommendation.reason, 'gpu_too_old')
  assert.equal(recommendation.torchPack, 'torch-cpu')
})

test('no NVIDIA card keeps the cloud and the CPU packs; an NPU waits for its model', () => {
  const recommendation = recommend(assess(machine({ adapters: ['AMD Radeon(TM) Graphics', 'Microsoft Basic Display Adapter'], npus: ['Intel(R) AI Boost'] })))
  assert.equal(recommendation.backend, 'cloud')
  assert.equal(recommendation.reason, 'cpu_only')
  assert.equal(recommendation.npuWaiting, true)
  assert.equal(recommendation.packs.find(pack => pack.pack === 'onnx-cuda')?.fit, 'no_nvidia_gpu')
})

test('platforms without a build are reported, not guessed', () => {
  const recommendation = recommend(assess(machine({ platform: 'darwin', arch: 'x64' })))
  assert.ok(recommendation.packs.every(pack => pack.fit === 'no_build'))
})

test('generations describe their half-precision strength', () => {
  assert.equal(gpuGeneration('7.5').architecture, 'Turing')
  assert.equal(gpuGeneration('7.5').bf16, false)
  assert.equal(gpuGeneration('8.9').fp16, 'tensor-cores')
  assert.equal(gpuGeneration('6.1').fp16, 'slow')
  assert.equal(gpuGeneration('6.1').supported, false)
})

test('parses nvidia-smi rows and compares driver versions numerically', () => {
  const [gpu] = parseNvidiaRows('NVIDIA GeForce RTX 5080, 610.88, 16303\n', ['12.0'])
  assert.deepEqual(gpu, { name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia', driver: '610.88', memoryBytes: 16303 * 1024 ** 2, computeCapability: '12.0' })
  assert.equal(compareVersions('580.65', '580.9'), 1)
  assert.equal(compareVersions('570.65', '570.65'), 0)
})
