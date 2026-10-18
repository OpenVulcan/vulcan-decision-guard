import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assess, parseNvidiaRows, recommendedPrecision, recommendedProvider, recommendedSizeFor, type Probes } from './hardware.js'

const GIB = 1024 ** 3

/** Observations of a machine with nothing but a CPU; each test changes what it needs. */
function probes(change: Partial<Probes>): Probes {
  return {
    platform: 'linux',
    arch: 'x64',
    totalMemory: 16 * GIB,
    nvidia: undefined,
    adapters: [],
    bindingHas: () => false,
    systemLibraries: () => new Set(),
    ...change,
  }
}

const RTX = parseNvidiaRows('NVIDIA GeForce RTX 4060, 591.86, 8188\n', ['8.9'])

test('a CPU-only machine runs fp32 on the CPU', () => {
  const hardware = assess(probes({}))
  assert.equal(recommendedProvider(hardware), 'cpu')
  assert.equal(recommendedPrecision('cpu', hardware), 'fp32')
  assert.equal(recommendedSizeFor(hardware, 'cpu'), '0.4b')
})

test('CUDA needs the driver, the provider library and every CUDA 12 and cuDNN 9 library', () => {
  const noProvider = assess(probes({ nvidia: RTX }))
  assert.equal(noProvider.providers.find(state => state.provider === 'cuda')?.unavailable, 'cuda_provider')
  assert.equal(recommendedProvider(noProvider), 'cpu')

  const partial = assess(probes({ nvidia: RTX, bindingHas: () => true, systemLibraries: () => new Set(['libcudart.so.12']) }))
  const cuda = partial.providers.find(state => state.provider === 'cuda')
  assert.equal(cuda?.unavailable, 'cuda_libraries')
  assert.ok(cuda?.missing?.includes('libcudnn.so.9'))

  const ready = assess(probes({ nvidia: RTX, bindingHas: () => true, systemLibraries: names => new Set(names) }))
  assert.equal(recommendedProvider(ready), 'cuda')
  assert.equal(recommendedPrecision('cuda', ready), 'fp16-mixed')
  // 8 GiB of card memory allows the largest size, but 16 GiB of RAM still limits it.
  assert.equal(recommendedSizeFor(ready, 'cuda'), '0.4b')
})

test('old CUDA cards without half-precision arithmetic get fp32', () => {
  const old = assess(probes({
    nvidia: parseNvidiaRows('Tesla K80, 470.00, 11441\n', ['3.7']),
    bindingHas: () => true,
    systemLibraries: names => new Set(names),
  }))
  assert.equal(recommendedPrecision('cuda', old), 'fp32')
})

test('Windows uses DirectML on a real adapter and never CUDA', () => {
  const windows = assess(probes({
    platform: 'win32',
    nvidia: RTX,
    adapters: ['NVIDIA GeForce RTX 4060', 'Microsoft Basic Display Adapter', 'OrayIddDriver Device'],
    bindingHas: file => file === 'DirectML.dll',
  }))
  assert.equal(windows.providers.find(state => state.provider === 'cuda')?.unavailable, 'unsupported_platform')
  assert.equal(recommendedProvider(windows), 'dml')
  assert.equal(recommendedPrecision('dml', windows), 'fp16-mixed')
  assert.deepEqual(windows.gpus.map(gpu => gpu.name), ['NVIDIA GeForce RTX 4060'])

  const softwareOnly = assess(probes({ platform: 'win32', adapters: ['Microsoft Basic Display Adapter'], bindingHas: () => true }))
  assert.equal(softwareOnly.providers.find(state => state.provider === 'dml')?.unavailable, 'no_gpu')
  assert.equal(recommendedProvider(softwareOnly), 'cpu')
})

test('a small card limits the size on its GPU only', () => {
  const small = assess(probes({
    platform: 'win32',
    totalMemory: 64 * GIB,
    nvidia: parseNvidiaRows('NVIDIA GeForce GTX 1650, 591.86, 4096\n'),
    bindingHas: () => true,
  }))
  assert.equal(recommendedSizeFor(small, 'dml'), '0.4b')
  assert.equal(recommendedSizeFor(small, 'cpu'), '0.6b')
})

test('nvidia-smi rows keep unreported fields absent', () => {
  const [gpu] = parseNvidiaRows('NVIDIA RTX A2000, 591.86, [N/A]\n', ['[N/A]'])
  assert.equal(gpu?.name, 'NVIDIA RTX A2000')
  assert.equal(gpu?.memoryBytes, undefined)
  assert.equal(gpu?.computeCapability, undefined)
})
