/**
 * Installed model packages: `<models dir>/<id>/` holding `model.json`, the model's
 * `runtime-config.json`, its policy and tokenizer under `assets/`, and one or more ONNX graphs
 * with their external weights.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DecisionError, MODEL_SIZES, type ModelSize } from '../protocol.js'
import { modelsDir } from '../paths.js'

/** Format of `model.json`; a package with another value is refused. */
export const MODEL_FORMAT = 1

/** Numeric precision of a graph's weights and arithmetic. */
export type Precision = 'fp32' | 'fp16-mixed'

/** Device class a graph has been verified on. */
export type DeviceClass = 'cpu' | 'gpu'

export interface GraphVariant {
  /** Graph path relative to the package root; external weights sit where the graph names them. */
  readonly file: string
  readonly precision: Precision
  /** Device classes this graph is verified on, in no particular order. */
  readonly devices: readonly DeviceClass[]
}

export interface FileDigest {
  readonly bytes: number
  readonly sha256: string
}

/** Contents of `model.json`. */
export interface ModelManifest {
  readonly format: typeof MODEL_FORMAT
  readonly id: string
  readonly size: ModelSize
  /** Graphs in order of preference for each device class. */
  readonly variants: readonly GraphVariant[]
  /** Every file of the package except `model.json` itself. */
  readonly files: Readonly<Record<string, FileDigest>>
}

/** The fields of the model's `runtime-config.json` the runtime reads. */
export interface RuntimeConfig {
  readonly max_tokens: number
  readonly head_tokens: number
  readonly option_tokens: number
  readonly max_request_items: number
  readonly micro_batch: number
  readonly allow_margin: number
  readonly labels: readonly string[]
  readonly input_fields: readonly string[]
  readonly model_file: string
  readonly precision: string
}

export interface InstalledModel {
  readonly root: string
  readonly manifest: ModelManifest
}

/** Model id used for a size when the installer is not given one. */
export function defaultModelId(size: ModelSize): string {
  return `vulcan-decision-shell-${size}-v1-preview`
}

/** Every installed model with a readable `model.json`; broken packages are skipped. */
export function listInstalled(): InstalledModel[] {
  const root = modelsDir()
  const models: InstalledModel[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    try {
      models.push({ root: dir, manifest: readManifest(dir) })
    } catch {
      // A package without a valid manifest is not installed; `model install` replaces it.
    }
  }
  return models.sort((a, b) => MODEL_SIZES.indexOf(a.manifest.size) - MODEL_SIZES.indexOf(b.manifest.size))
}

/**
 * Pick the installed model for a requested size, or the device recommendation when absent.
 * @throws DecisionError `model_not_installed` when nothing suitable is installed.
 */
export function selectModel(size: ModelSize | undefined, installed = listInstalled()): InstalledModel {
  if (size !== undefined) {
    const exact = installed.find(model => model.manifest.size === size)
    if (exact) return exact
    throw new DecisionError('model_not_installed', `the ${size} decision model is not installed; install it with "npx @openvulcan/vulcan-decision model install <dir> --size ${size}" or choose an installed size`)
  }
  if (installed.length === 0) {
    throw new DecisionError('model_not_installed', 'no decision model is installed; install one with "npx @openvulcan/vulcan-decision model install <dir> --size <size>"')
  }
  const limit = MODEL_SIZES.indexOf(recommendedSize())
  const fitting = installed.filter(model => MODEL_SIZES.indexOf(model.manifest.size) <= limit)
  // Installed is sorted by size, so the last fitting model is the largest one this device suits.
  return fitting.at(-1) ?? installed[0]!
}

/** The largest size this device is expected to run comfortably, from its total memory. */
export function recommendedSize(totalMemory = os.totalmem()): ModelSize {
  const gib = totalMemory / 1024 ** 3
  if (gib < 12) return '0.2b'
  if (gib < 24) return '0.4b'
  return '0.6b'
}

export function readManifest(root: string): ModelManifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'model.json'), 'utf8')) as ModelManifest
  if (manifest.format !== MODEL_FORMAT) throw new Error(`model.json format ${String(manifest.format)} is not supported`)
  if (!MODEL_SIZES.includes(manifest.size)) throw new Error(`model.json size ${String(manifest.size)} is unknown`)
  if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) throw new Error('model.json lists no graph')
  return manifest
}

export function readRuntimeConfig(root: string): RuntimeConfig {
  return JSON.parse(fs.readFileSync(path.join(root, 'runtime-config.json'), 'utf8')) as RuntimeConfig
}

/** Options for {@link installFromDirectory}. */
export interface InstallOptions {
  readonly size: ModelSize
  /** Defaults to {@link defaultModelId} for the size. */
  readonly id?: string
  /** Progress lines for the command line. */
  readonly log?: (line: string) => void
}

/**
 * Install a model package from a local directory, replacing any installed model of the same id
 * or size. The source is either a Vulcan model package (with `model.json`) or a delivery package
 * (with `runtime-config.json` and a `MANIFEST.json` of SHA-256 digests). Every copied file is
 * verified against its digest; nothing is installed on a mismatch.
 * @returns the installed model.
 */
export async function installFromDirectory(source: string, options: InstallOptions): Promise<InstalledModel> {
  const log = options.log ?? (() => {})
  const id = options.id ?? defaultModelId(options.size)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`invalid model id ${id}`)
  const plan = planInstall(path.resolve(source), id, options.size)

  const root = modelsDir()
  const staging = path.join(root, `.staging-${id}-${process.pid}`)
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    for (const [relative, digest] of Object.entries(plan.manifest.files)) {
      const from = path.join(plan.source, relative)
      const to = path.join(staging, relative)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      log(`copying ${relative} (${(digest.bytes / 1024 ** 2).toFixed(1)} MiB)`)
      fs.copyFileSync(from, to)
      const actual = await digestOf(to)
      if (actual.bytes !== digest.bytes || actual.sha256 !== digest.sha256) {
        throw new Error(`${relative} does not match its manifest digest`)
      }
    }
    fs.writeFileSync(path.join(staging, 'model.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`)
    readRuntimeConfig(staging)

    for (const model of listInstalled()) {
      if (model.manifest.id === id || model.manifest.size === options.size) {
        log(`replacing ${model.manifest.id}`)
        fs.rmSync(model.root, { recursive: true, force: true })
      }
    }
    const target = path.join(root, id)
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(staging, target)
    return { root: target, manifest: plan.manifest }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** Remove an installed model by id or size. @returns whether anything was removed. */
export function removeInstalled(idOrSize: string): boolean {
  let removed = false
  for (const model of listInstalled()) {
    if (model.manifest.id === idOrSize || model.manifest.size === idOrSize) {
      fs.rmSync(model.root, { recursive: true, force: true })
      removed = true
    }
  }
  return removed
}

interface InstallPlan {
  readonly source: string
  readonly manifest: ModelManifest
}

function planInstall(source: string, id: string, size: ModelSize): InstallPlan {
  const ownManifest = path.join(source, 'model.json')
  if (fs.existsSync(ownManifest)) {
    const manifest = readManifest(source)
    return { source, manifest: { ...manifest, id, size } }
  }
  // A delivery package: the declared graph, its weights, the assets and the runtime config,
  // all digested by MANIFEST.json.
  const delivery = JSON.parse(fs.readFileSync(path.join(source, 'MANIFEST.json'), 'utf8')) as {
    readonly files: Readonly<Record<string, FileDigest>>
  }
  const config = readRuntimeConfig(source)
  const wanted = Object.keys(delivery.files).filter(relative => (
    relative === 'runtime-config.json' || relative.startsWith('assets/') || relative.startsWith('models/')
  ))
  if (!wanted.includes(config.model_file)) throw new Error(`MANIFEST.json does not cover ${config.model_file}`)
  const files: Record<string, FileDigest> = {}
  for (const relative of wanted) files[relative] = delivery.files[relative]!
  const precision: Precision = config.precision.startsWith('fp16') ? 'fp16-mixed' : 'fp32'
  return {
    source,
    manifest: {
      format: MODEL_FORMAT,
      id,
      size,
      variants: [{ file: config.model_file, precision, devices: ['cpu', 'gpu'] }],
      files,
    },
  }
}

/** Size and SHA-256 of a file, streamed. */
export function digestOf(file: string): Promise<FileDigest> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    fs.createReadStream(file)
      .on('data', (chunk) => {
        bytes += chunk.length
        hash.update(chunk)
      })
      .on('error', reject)
      .on('end', () => resolve({ bytes, sha256: hash.digest('hex') }))
  })
}
