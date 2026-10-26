/**
 * What this machine offers the local model, and which runtime pack to recommend for it.
 *
 * Only ready-made runtimes are considered. NVIDIA cards run the CUDA packs, whose CUDA libraries
 * come as NVIDIA's own wheels, so only the driver has to be recent enough; this package never
 * installs or updates a driver. AMD, Intel and Apple graphics have no published runtime for these
 * models, so they get the CPU pack or the cloud. An NPU is reported, but it needs an ONNX model
 * exported for it, which is not published yet.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

import { currentTarget, readLock, type PackId, type Target } from './local/packs.js'

/** One graphics card. */
export interface GpuInfo {
  readonly name: string
  readonly vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'
  /** Dedicated memory, when the driver reports it. */
  readonly memoryBytes?: number
  /** CUDA compute capability such as `8.9`, NVIDIA only. */
  readonly computeCapability?: string
  readonly driver?: string
}

/** One neural processing unit. */
export interface NpuInfo {
  readonly name: string
  readonly vendor: 'intel' | 'amd' | 'qualcomm' | 'apple' | 'other'
}

export interface Hardware {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly target?: Target
  readonly totalMemory: number
  readonly cpus: number
  readonly gpus: readonly GpuInfo[]
  readonly npus: readonly NpuInfo[]
}

/** Raw observations, injectable for tests. */
export interface Probes {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly totalMemory: number
  readonly cpus: number
  /** NVIDIA cards from `nvidia-smi`; undefined when no NVIDIA driver answered. */
  readonly nvidia: readonly GpuInfo[] | undefined
  /** Display adapter names the system reports. */
  readonly adapters: readonly string[]
  /** NPU device names the system reports. */
  readonly npus: readonly string[]
}

/** Adapters that are not graphics hardware: the software renderer and remote or virtual displays. */
const NON_GPU_ADAPTER = /microsoft basic (display|render)|remote display|virtual|indirect display|idd ?driver|parsec|citrix/i

export function assess(probes: Probes): Hardware {
  const nvidia = probes.nvidia ?? []
  const others = probes.adapters
    .filter(name => !NON_GPU_ADAPTER.test(name) && !nvidia.some(gpu => gpu.name === name) && !(probes.nvidia !== undefined && /nvidia/i.test(name)))
    .map((name): GpuInfo => ({ name, vendor: vendorOf(name) }))
  const target = currentTarget(probes.platform, probes.arch)
  const npus = probes.npus.map((name): NpuInfo => ({ name, vendor: npuVendorOf(name) }))
  if (probes.platform === 'darwin' && probes.arch === 'arm64') npus.push({ name: 'Apple Neural Engine', vendor: 'apple' })
  return {
    platform: probes.platform, arch: probes.arch, ...target === undefined ? {} : { target },
    totalMemory: probes.totalMemory, cpus: probes.cpus, gpus: [...nvidia, ...others], npus,
  }
}

function vendorOf(name: string): GpuInfo['vendor'] {
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(name)) return 'nvidia'
  if (/amd|radeon/i.test(name)) return 'amd'
  if (/intel/i.test(name)) return 'intel'
  if (/apple/i.test(name)) return 'apple'
  return 'other'
}

function npuVendorOf(name: string): NpuInfo['vendor'] {
  if (/intel|ai boost/i.test(name)) return 'intel'
  if (/amd|ryzen/i.test(name)) return 'amd'
  if (/qualcomm|hexagon|snapdragon/i.test(name)) return 'qualcomm'
  return 'other'
}

/** How an NVIDIA generation handles the model's arithmetic. */
export interface GpuGeneration {
  /** Architecture name, such as `Ada Lovelace`. */
  readonly architecture: string
  /** Fast half precision; the recommended format computes in fp16 on the GPU. */
  readonly fp16: 'tensor-cores' | 'native' | 'slow'
  /** Whether bf16 is supported; it is never used for these models, which lose accuracy in it. */
  readonly bf16: boolean
  /** Whether the CUDA packs run on it. */
  readonly supported: boolean
}

/** Lowest compute capability the CUDA packs run on (Turing). */
export const MIN_COMPUTE_CAPABILITY = 7.5

export function gpuGeneration(computeCapability: string): GpuGeneration {
  const capability = Number(computeCapability)
  const supported = capability >= MIN_COMPUTE_CAPABILITY
  if (capability >= 12) return { architecture: 'Blackwell', fp16: 'tensor-cores', bf16: true, supported }
  if (capability >= 10) return { architecture: 'Blackwell (data center)', fp16: 'tensor-cores', bf16: true, supported }
  if (capability >= 9) return { architecture: 'Hopper', fp16: 'tensor-cores', bf16: true, supported }
  if (capability >= 8.9) return { architecture: 'Ada Lovelace', fp16: 'tensor-cores', bf16: true, supported }
  if (capability >= 8) return { architecture: 'Ampere', fp16: 'tensor-cores', bf16: true, supported }
  if (capability >= 7.5) return { architecture: 'Turing', fp16: 'tensor-cores', bf16: false, supported }
  if (capability >= 7) return { architecture: 'Volta', fp16: 'tensor-cores', bf16: false, supported }
  if (capability === 6 || capability === 5.3 || capability === 6.2) return { architecture: 'Pascal', fp16: 'native', bf16: false, supported }
  if (capability >= 6) return { architecture: 'Pascal', fp16: 'slow', bf16: false, supported }
  return { architecture: 'Maxwell or older', fp16: 'slow', bf16: false, supported }
}

/**
 * Why a pack is or is not usable here.
 * - `ok`: everything it needs was found.
 * - `no_build`: the pack has no build for this platform.
 * - `no_nvidia_gpu`: no NVIDIA card answered `nvidia-smi`.
 * - `gpu_too_old`: the card's compute capability is below {@link MIN_COMPUTE_CAPABILITY}.
 * - `driver_too_old`: the driver is older than the pack needs; update it from NVIDIA.
 */
export type PackFit = 'ok' | 'no_build' | 'no_nvidia_gpu' | 'gpu_too_old' | 'driver_too_old'

export interface PackAssessment {
  readonly pack: PackId
  readonly fit: PackFit
  /** Download size for this platform. */
  readonly bytes?: number
  /** The driver version the pack needs, for `driver_too_old`. */
  readonly needsDriver?: string
}

/** Whether `pack` can run here. */
export function assessPack(hardware: Hardware, pack: PackId): PackAssessment {
  const lock = readLock(pack)
  const build = hardware.target === undefined ? undefined : lock.targets[hardware.target]
  if (build === undefined) return { pack, fit: 'no_build' }
  const base = { pack, bytes: build.bytes }
  if (lock.device === 'cpu') return { ...base, fit: 'ok' }
  const cards = hardware.gpus.filter(gpu => gpu.vendor === 'nvidia' && gpu.driver !== undefined)
  if (cards.length === 0) return { ...base, fit: 'no_nvidia_gpu' }
  const best = cards.reduce((a, b) => Number(b.computeCapability ?? 0) > Number(a.computeCapability ?? 0) ? b : a)
  const minimum = Number(lock.requires.compute_capability ?? MIN_COMPUTE_CAPABILITY)
  if (best.computeCapability !== undefined && Number(best.computeCapability) < minimum) return { ...base, fit: 'gpu_too_old' }
  const needed = lock.requires.nvidia_driver
  if (needed !== undefined && best.driver !== undefined && compareVersions(best.driver, needed) < 0) {
    return { ...base, fit: 'driver_too_old', needsDriver: needed }
  }
  return { ...base, fit: 'ok' }
}

/** Compare dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

/** The recommendation for this machine. */
export interface Recommendation {
  /** Cloud stays the default; local is recommended only with a usable NVIDIA card. */
  readonly backend: 'cloud' | 'local'
  /** The pack to install for torch-release models (the published format). */
  readonly torchPack: PackId
  /** The pack to install for ONNX deliveries. */
  readonly onnxPack: PackId
  /**
   * Why: `cuda` (a supported NVIDIA card), `cpu_only` (no usable GPU runtime),
   * `driver_update` (a supported card whose driver is too old), `gpu_too_old`.
   */
  readonly reason: 'cuda' | 'cpu_only' | 'driver_update' | 'gpu_too_old'
  /** Set when an NPU was found; it waits for an ONNX model exported for it. */
  readonly npuWaiting: boolean
  readonly packs: readonly PackAssessment[]
}

export function recommend(hardware: Hardware): Recommendation {
  const packs = (['onnx-cpu', 'onnx-cuda', 'torch-cpu', 'torch-cu128'] as const).map(pack => assessPack(hardware, pack))
  const fit = (pack: PackId) => packs.find(item => item.pack === pack)?.fit
  const torchCuda = fit('torch-cu128') === 'ok'
  const onnxCuda = fit('onnx-cuda') === 'ok'
  const cudaFits = [fit('torch-cu128'), fit('onnx-cuda')]
  const reason: Recommendation['reason'] = torchCuda || onnxCuda ? 'cuda'
    : cudaFits.includes('driver_too_old') ? 'driver_update'
      : cudaFits.includes('gpu_too_old') ? 'gpu_too_old' : 'cpu_only'
  return {
    backend: torchCuda || onnxCuda ? 'local' : 'cloud',
    torchPack: torchCuda ? 'torch-cu128' : 'torch-cpu',
    onnxPack: onnxCuda ? 'onnx-cuda' : 'onnx-cpu',
    reason,
    npuWaiting: hardware.npus.length > 0,
    packs,
  }
}

/** Longest wait for one probing command. */
const PROBE_TIMEOUT_MS = 15_000

let cached: Hardware | undefined

/** Probe this machine once per process; blocking, a few seconds at most. */
export function detectHardware(): Hardware {
  cached ??= assess(systemProbes())
  return cached
}

function systemProbes(): Probes {
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemory: os.totalmem(),
    cpus: os.availableParallelism(),
    nvidia: probeNvidia(),
    adapters: process.platform === 'win32' ? windowsDevices('Win32_VideoController', 'Name') : linuxAdapters(),
    npus: process.platform === 'win32' ? windowsNpus() : linuxNpus(),
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
      vendor: 'nvidia',
      ...driver ? { driver } : {},
      ...Number.isFinite(mib) && mib > 0 ? { memoryBytes: mib * 1024 ** 2 } : {},
      ...capability !== undefined && /^\d+\.\d+$/.test(capability) ? { computeCapability: capability } : {},
    }
  })
}

function windowsDevices(cimClass: string, field: string, filter = ''): string[] {
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance ${cimClass}${filter}).${field}`])
  return output === undefined ? [] : output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/** NPUs: Windows lists them in the `ComputeAccelerator` device class (Intel AI Boost, AMD IPU, Qualcomm Hexagon). */
function windowsNpus(): string[] {
  return windowsDevices('Win32_PnPEntity', 'Name', ` -Filter "PNPClass='ComputeAccelerator'"`)
}

/** Linux exposes accelerators under `/sys/class/accel` (Intel `intel_vpu`, AMD `amdxdna`). */
function linuxNpus(): string[] {
  if (process.platform !== 'linux') return []
  try {
    return fs.readdirSync('/sys/class/accel').map(device => {
      try {
        const driver = fs.readlinkSync(`/sys/class/accel/${device}/device/driver`).split('/').at(-1) ?? device
        return driver === 'intel_vpu' ? 'Intel NPU' : driver === 'amdxdna' ? 'AMD NPU' : driver
      } catch {
        return device
      }
    })
  } catch {
    return []
  }
}

function linuxAdapters(): string[] {
  if (process.platform !== 'linux') return []
  const output = run('lspci', [])
  if (output === undefined) return []
  return output.split(/\r?\n/).filter(line => /VGA compatible controller|3D controller|Display controller/.test(line))
    .map(line => line.replace(/^.*?controller:\s*/, '').trim())
}
