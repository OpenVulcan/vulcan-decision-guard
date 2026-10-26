/**
 * Runtime packs: the optional local runtimes, installed on demand next to the cloud-only default.
 *
 * A pack is a prebuilt python-build-standalone interpreter plus the official wheels its lock file
 * (`runtime-packs/<pack>.json`, written by `scripts/lock_runtime.py`) pins for this platform.
 * Installing downloads exactly those files, verifies each against its size and SHA-256, unpacks
 * the interpreter, installs the wheels offline with the interpreter's own pip and checks that the
 * runtime imports. Nothing is compiled and no driver is installed: GPU packs bring their CUDA
 * libraries as NVIDIA's wheels and only need a recent enough driver.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchPinned, type DownloadSource, type PinnedFile } from '../download.js'
import { writeFileAtomic, type DecisionHome } from '../home.js'
import { WorkerProcess, type ProbeResult } from './worker.js'

/** Packs with a lock file, in the order they are offered. */
export const PACK_IDS = ['onnx-cpu', 'onnx-cuda', 'torch-cpu', 'torch-cu128'] as const
export type PackId = typeof PACK_IDS[number]

export type Backend = 'onnx' | 'torch'
export type Device = 'cpu' | 'cuda'

/**
 * Packs waiting for a release: an NPU needs an ONNX model exported for it, which is not
 * published yet. They are listed so a host can show what this machine will be able to use.
 */
export const PLANNED_PACKS = [
  { id: 'onnx-openvino', backend: 'onnx', accelerator: 'intel-npu' },
  { id: 'onnx-qnn', backend: 'onnx', accelerator: 'qualcomm-npu' },
] as const

/** Platforms a pack can target, named as in the lock files. */
export type Target = 'win-x64' | 'linux-x64' | 'linux-arm64' | 'mac-arm64'

export interface LockedFile extends PinnedFile {
  readonly kind: 'python' | 'wheel'
}

export interface PackLock {
  readonly format: 1
  /** Identity of the exact file set; an installed pack with another id is outdated. */
  readonly id: string
  readonly pack: PackId
  readonly backend: Backend
  readonly device: Device
  readonly python: string
  /** Lowest NVIDIA driver version and CUDA compute capability, for GPU packs. */
  readonly requires: { readonly nvidia_driver?: string; readonly compute_capability?: string }
  readonly targets: Readonly<Partial<Record<Target, { readonly bytes: number; readonly macos?: string; readonly files: readonly LockedFile[] }>>>
}

/** `pack.json` of an installed pack. */
export interface InstalledPack {
  readonly format: 1
  readonly pack: PackId
  readonly lock: string
  readonly target: Target
  readonly backend: Backend
  readonly device: Device
  /** Interpreter path relative to the pack directory. */
  readonly python: string
  readonly installed_at: string
  readonly probe: ProbeResult
}

const LOCK_DIR = fileURLToPath(new URL('../../runtime-packs/', import.meta.url))

/** The target this process runs on, or undefined when no pack supports it. */
export function currentTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Target | undefined {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  return undefined
}

export function isPackId(value: unknown): value is PackId {
  return typeof value === 'string' && (PACK_IDS as readonly string[]).includes(value)
}

/** The lock file shipped with this package for `pack`. */
export function readLock(pack: PackId): PackLock {
  const lock = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, `${pack}.json`), 'utf8')) as PackLock
  if (lock.format !== 1 || lock.pack !== pack) throw new Error(`the lock file of ${pack} is malformed`)
  return lock
}

/** The installed pack in `home`, or undefined when it is missing or unreadable. */
export function installedPack(home: DecisionHome, pack: PackId): InstalledPack | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(home.packs, pack, 'pack.json'), 'utf8')) as InstalledPack
    return record.format === 1 && record.pack === pack ? record : undefined
  } catch {
    return undefined
  }
}

/** The interpreter of an installed pack. */
export function packPython(home: DecisionHome, record: InstalledPack): string {
  return path.join(home.packs, record.pack, ...record.python.split('/'))
}

/** Installation progress, reported as it happens. */
export type InstallProgress =
  | { readonly phase: 'download'; readonly done: number; readonly total: number; readonly file: string }
  | { readonly phase: 'unpack' | 'install' | 'probe' }

export interface InstallOptions {
  readonly source?: DownloadSource
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: InstallProgress) => void
  readonly target?: Target
}

/**
 * Install `pack` for this platform, replacing an installed one only once the new one works.
 * @throws Error when the pack has no build for this platform, a download fails verification, or
 *   the installed runtime does not start.
 */
export async function installPack(home: DecisionHome, pack: PackId, options: InstallOptions = {}): Promise<InstalledPack> {
  const lock = readLock(pack)
  const target = options.target ?? currentTarget()
  const build = target === undefined ? undefined : lock.targets[target]
  if (target === undefined || build === undefined) {
    throw new Error(`${pack} has no build for ${process.platform}-${process.arch}`)
  }
  const downloads = path.join(home.downloads, `pack-${lock.id}`)
  const staging = path.join(home.packs, `.staging-${pack}`)
  if (target === 'win-x64' && staging.length + DEEPEST_PACK_PATH > WINDOWS_MAX_PATH) {
    throw new Error(`the data directory ${home.root} is too deep for Windows paths: a pack's files would exceed `
      + `${WINDOWS_MAX_PATH} characters; use a data directory at most ${WINDOWS_MAX_PATH - DEEPEST_PACK_PATH - (staging.length - home.root.length)} characters long`)
  }
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  try {
    let done = 0
    for (const file of build.files) {
      const start = done
      await fetchPinned(file, path.join(downloads, file.name), {
        ...options.source === undefined ? {} : { source: options.source },
        ...options.signal === undefined ? {} : { signal: options.signal },
        onBytes: bytes => {
          done += bytes
          options.onProgress?.({ phase: 'download', done, total: build.bytes, file: file.name })
        },
      })
      done = start + file.bytes
    }

    options.onProgress?.({ phase: 'unpack' })
    const interpreter = build.files.find(file => file.kind === 'python')
    if (interpreter === undefined) throw new Error(`the lock file of ${pack} has no interpreter`)
    await run(tarCommand(), ['-xzf', path.join(downloads, interpreter.name), '-C', staging], options.signal)
    const python = target === 'win-x64' ? 'python/python.exe' : 'python/bin/python3'
    const pythonPath = path.join(staging, ...python.split('/'))
    if (!fs.existsSync(pythonPath)) throw new Error('the interpreter archive did not contain python')

    options.onProgress?.({ phase: 'install' })
    const wheels = build.files.filter(file => file.kind === 'wheel').map(file => path.join(downloads, file.name))
    await run(pythonPath, ['-I', '-m', 'pip', 'install', '--no-index', '--no-deps', '--disable-pip-version-check',
      '--no-warn-script-location', '--quiet', ...wheels], options.signal)

    options.onProgress?.({ phase: 'probe' })
    const worker = new WorkerProcess(pythonPath)
    let probe: ProbeResult
    try {
      probe = await worker.probe()
    } finally {
      await worker.stop()
    }
    const missing = lock.backend === 'onnx' ? probe.onnxruntime === undefined : probe.torch === undefined
    if (missing) throw new Error(`${pack} installed but its ${lock.backend} runtime does not import`)

    const record: InstalledPack = {
      format: 1, pack, lock: lock.id, target, backend: lock.backend, device: lock.device, python,
      installed_at: new Date().toISOString(), probe,
    }
    writeFileAtomic(path.join(staging, 'pack.json'), `${JSON.stringify(record, null, 2)}\n`)
    replaceDirectory(staging, path.join(home.packs, pack))
    fs.rmSync(downloads, { recursive: true, force: true })
    return record
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/** Longest Windows path pip can write without long-path support, without the terminating NUL. */
const WINDOWS_MAX_PATH = 259
/**
 * Longest path inside a pack directory, with room to spare: `python\Lib\site-packages\` plus
 * torch's deepest header (144 characters for torch 2.9.1).
 */
const DEEPEST_PACK_PATH = 150

/** Remove an installed pack and any partial download of it. */
export function removePack(home: DecisionHome, pack: PackId): boolean {
  const dir = path.join(home.packs, pack)
  const existed = fs.existsSync(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(home.downloads, `pack-${readLock(pack).id}`), { recursive: true, force: true })
  return existed
}

/** Move `staging` to `dest`, keeping the old `dest` until the move succeeded. */
export function replaceDirectory(staging: string, dest: string): void {
  const old = `${dest}.old-${process.pid}`
  const hadOld = fs.existsSync(dest)
  if (hadOld) fs.renameSync(dest, old)
  try {
    fs.renameSync(staging, dest)
  } catch (error) {
    if (hadOld) fs.renameSync(old, dest)
    throw error
  }
  if (hadOld) fs.rmSync(old, { recursive: true, force: true })
}

/**
 * The archive tool: Windows' own bsdtar, so a GNU tar earlier on PATH (Git Bash, MSYS) cannot
 * mistake a drive letter for a remote host.
 */
function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar'
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...signal === undefined ? {} : { signal } })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} failed (exit ${code}): ${stderr.trim()}`))
    })
  })
}

