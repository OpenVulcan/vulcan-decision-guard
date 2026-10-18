/**
 * What this machine offers the decision model: its graphics cards, which ONNX Runtime execution
 * providers can run here, and the provider, weight format and size recommended from them.
 *
 * onnxruntime-node 1.30 ships CPU everywhere and DirectML on Windows; its CUDA provider exists
 * only on Linux x64, downloaded by the package's install script, and needs CUDA 12 and cuDNN 9
 * from the system. A provider is recommended only when everything it needs was found.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { MODEL_SIZES, type ModelSize } from '../protocol.js'
import type { DeviceClass, Precision } from './package.js'

/** Execution providers the service can request from onnxruntime-node. */
export type Provider = 'cpu' | 'dml' | 'cuda'

/** Providers in preference order: CUDA is fastest, DirectML runs on any DirectX 12 GPU, CPU always works. */
export const PROVIDER_PREFERENCE: readonly Provider[] = ['cuda', 'dml', 'cpu']

/** Shared libraries the CUDA provider of onnxruntime-node 1.30 loads from the system (CUDA 12, cuDNN 9). */
export const CUDA_LIBRARIES = [
  'libcudart.so.12',
  'libcublas.so.12',
  'libcublasLt.so.12',
  'libcufft.so.11',
  'libcurand.so.10',
  'libcudnn.so.9',
] as const

/** The CUDA provider library onnxruntime-node's install script places next to its binding. */
const CUDA_PROVIDER_LIBRARY = 'libonnxruntime_providers_cuda.so'

/** Longest wait for one probing command. */
const PROBE_TIMEOUT_MS = 15_000

/** One graphics card. */
export interface GpuInfo {
  readonly name: string
  /** Dedicated memory, when the driver reports it. */
  readonly memoryBytes?: number
  /** CUDA compute capability such as `8.9`, NVIDIA only. */
  readonly computeCapability?: string
  readonly driver?: string
}

/**
 * Why a provider cannot run here.
 * - `unsupported_platform`: onnxruntime-node has no such provider on this platform.
 * - `no_gpu`: no graphics card that can run it was found.
 * - `nvidia_driver`: no NVIDIA driver answered `nvidia-smi`.
 * - `cuda_provider`: onnxruntime-node's CUDA provider library is not installed.
 * - `cuda_libraries`: CUDA 12 or cuDNN 9 libraries are missing; `missing` names them.
 */
export type Unavailable = 'unsupported_platform' | 'no_gpu' | 'nvidia_driver' | 'cuda_provider' | 'cuda_libraries'

export interface ProviderState {
  readonly provider: Provider
  readonly unavailable?: Unavailable
  /** Missing library file names for `cuda_libraries`. */
  readonly missing?: readonly string[]
}

export interface Hardware {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly totalMemory: number
  readonly gpus: readonly GpuInfo[]
  readonly providers: readonly ProviderState[]
}

/** Raw observations, injectable for tests. */
export interface Probes {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly totalMemory: number
  /** NVIDIA cards from `nvidia-smi`; undefined when no NVIDIA driver answered. */
  readonly nvidia: readonly GpuInfo[] | undefined
  /** Display adapter names Windows reports; empty elsewhere. */
  readonly adapters: readonly string[]
  /** Whether onnxruntime-node's binding directory holds `file`. */
  readonly bindingHas: (file: string) => boolean
  /** Which of `names` the system library search finds. */
  readonly systemLibraries: (names: readonly string[]) => ReadonlySet<string>
}

/** Adapters that cannot run DirectML work: the software renderer and remote or virtual displays. */
const NON_GPU_ADAPTER = /microsoft basic (display|render)|remote display|virtual|indirect display|idd ?driver|parsec|citrix/i

/** Derive provider readiness from observations. */
export function assess(probes: Probes): Hardware {
  const gpus = probes.nvidia ?? []
  const providers: ProviderState[] = PROVIDER_PREFERENCE.map((provider): ProviderState => {
    switch (provider) {
      case 'cpu':
        return { provider }
      case 'dml': {
        if (probes.platform !== 'win32' || !probes.bindingHas('DirectML.dll')) return { provider, unavailable: 'unsupported_platform' }
        const real = probes.adapters.filter(name => !NON_GPU_ADAPTER.test(name))
        return real.length > 0 || gpus.length > 0 ? { provider } : { provider, unavailable: 'no_gpu' }
      }
      case 'cuda': {
        if (probes.platform !== 'linux' || probes.arch !== 'x64') return { provider, unavailable: 'unsupported_platform' }
        if (probes.nvidia === undefined) return { provider, unavailable: 'nvidia_driver' }
        if (gpus.length === 0) return { provider, unavailable: 'no_gpu' }
        if (!probes.bindingHas(CUDA_PROVIDER_LIBRARY)) return { provider, unavailable: 'cuda_provider' }
        const found = probes.systemLibraries(CUDA_LIBRARIES)
        const missing = CUDA_LIBRARIES.filter(name => !found.has(name))
        return missing.length === 0 ? { provider } : { provider, unavailable: 'cuda_libraries', missing }
      }
    }
  })
  const adapters = probes.adapters
    .filter(name => !NON_GPU_ADAPTER.test(name) && !gpus.some(gpu => gpu.name === name))
    .map((name): GpuInfo => ({ name }))
  return { platform: probes.platform, arch: probes.arch, totalMemory: probes.totalMemory, gpus: [...gpus, ...adapters], providers }
}

let cached: Hardware | undefined

/** Probe this machine once per process; blocking, a few seconds at most. */
export function detectHardware(): Hardware {
  cached ??= assess(systemProbes())
  return cached
}

/** The first provider in preference order that can run here. */
export function recommendedProvider(hardware: Hardware): Provider {
  return hardware.providers.find(state => state.unavailable === undefined)?.provider ?? 'cpu'
}

export function deviceClassOf(provider: Provider): DeviceClass {
  return provider === 'cpu' ? 'cpu' : 'gpu'
}

/** Lowest CUDA compute capability with native half-precision arithmetic. */
const FP16_MIN_COMPUTE_CAPABILITY = 5.3

/**
 * The weight format to recommend: half-precision weights on a GPU, full precision on the CPU,
 * where the fp32 graph matches the reference most closely. CUDA cards older than compute
 * capability 5.3 lack half-precision arithmetic, so they get full precision too.
 */
export function recommendedPrecision(provider: Provider, hardware?: Hardware): Precision {
  if (deviceClassOf(provider) === 'cpu') return 'fp32'
  if (provider === 'cuda' && hardware !== undefined) {
    const capabilities = hardware.gpus.flatMap(gpu => gpu.computeCapability === undefined ? [] : [Number(gpu.computeCapability)])
    if (capabilities.length > 0 && Math.min(...capabilities) < FP16_MIN_COMPUTE_CAPABILITY) return 'fp32'
  }
  return 'fp16-mixed'
}

/** The largest size the given memory runs comfortably; GPU memory needs less headroom than RAM. */
export function sizeForMemory(bytes: number, kind: 'ram' | 'gpu'): ModelSize {
  const gib = bytes / 1024 ** 3
  const [small, medium] = kind === 'ram' ? [12, 24] : [4, 8]
  if (gib < small) return '0.2b'
  if (gib < medium) return '0.4b'
  return '0.6b'
}

/**
 * The largest size this machine suits with `provider`: by total memory, and on a GPU also by the
 * smallest reported card memory.
 */
export function recommendedSizeFor(hardware: Hardware, provider: Provider): ModelSize {
  const byRam = sizeForMemory(hardware.totalMemory, 'ram')
  if (deviceClassOf(provider) === 'cpu') return byRam
  const memories = hardware.gpus.flatMap(gpu => gpu.memoryBytes === undefined ? [] : [gpu.memoryBytes])
  if (memories.length === 0) return byRam
  const byGpu = sizeForMemory(Math.min(...memories), 'gpu')
  return MODEL_SIZES[Math.min(MODEL_SIZES.indexOf(byRam), MODEL_SIZES.indexOf(byGpu))]!
}

function systemProbes(): Probes {
  const bindingDir = onnxruntimeBindingDir()
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemory: os.totalmem(),
    nvidia: probeNvidia(),
    adapters: process.platform === 'win32' ? probeWindowsAdapters() : [],
    bindingHas: file => bindingDir !== undefined && fs.existsSync(path.join(bindingDir, file)),
    systemLibraries: findSystemLibraries,
  }
}

/** Directory of onnxruntime-node's native binding for this platform. */
function onnxruntimeBindingDir(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve('onnxruntime-node/package.json')
    return path.join(path.dirname(manifest), 'bin', 'napi-v6', process.platform, process.arch)
  } catch {
    return undefined
  }
}

function run(command: string, args: readonly string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout : undefined
}

function probeNvidia(): GpuInfo[] | undefined {
  const rows = run('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'])
  if (rows === undefined) return undefined
  // Older drivers reject the field, which leaves the capability unknown.
  const capabilities = run('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader'])?.split(/\r?\n/).filter(Boolean)
  return parseNvidiaRows(rows, capabilities)
}

/** Parse `name,driver_version,memory.total` rows (memory in MiB) and optional `compute_cap` rows. */
export function parseNvidiaRows(rows: string, capabilities?: readonly string[]): GpuInfo[] {
  return rows.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index): GpuInfo => {
    const [name = '', driver, memory] = line.split(',').map(field => field.trim())
    const mib = Number(memory)
    const capability = capabilities?.[index]?.trim()
    return {
      name,
      ...driver ? { driver } : {},
      ...Number.isFinite(mib) && mib > 0 ? { memoryBytes: mib * 1024 ** 2 } : {},
      ...capability !== undefined && /^\d+\.\d+$/.test(capability) ? { computeCapability: capability } : {},
    }
  })
}

function probeWindowsAdapters(): string[] {
  const output = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_VideoController).Name',
  ])
  return output === undefined ? [] : output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/** Libraries the dynamic loader can find: the `ldconfig` cache, `LD_LIBRARY_PATH` and the CUDA default. */
function findSystemLibraries(names: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>()
  const cache = run('ldconfig', ['-p']) ?? run('/sbin/ldconfig', ['-p']) ?? ''
  for (const name of names) if (cache.includes(name)) found.add(name)
  const dirs = [...(process.env.LD_LIBRARY_PATH ?? '').split(':').filter(Boolean), '/usr/local/cuda/lib64']
  for (const name of names) {
    if (dirs.some(dir => fs.existsSync(path.join(dir, name)))) found.add(name)
  }
  return found
}
