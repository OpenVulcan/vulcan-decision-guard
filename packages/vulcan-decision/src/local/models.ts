/**
 * Local model packages: the published catalog and the installed packages.
 *
 * Two package formats exist:
 * - `torch-release`: a published model repository (`manifest.json`, `decision.py`, `runtime/`,
 *   `tokenizer/`, `weights/`). Only the files needed to run it with its recommended fp32 weights
 *   are installed; training records, evaluation data and experimental weight formats are skipped.
 * - `onnx-delivery`: an ONNX package (`MANIFEST.json`, `runtime-config.json`, `assets/`, the graph
 *   and its weights), installed whole.
 *
 * Every installed file is checked against the package's own manifest while it is copied or
 * downloaded, into a staging directory that replaces the installed package only when complete.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { fetchPinned, matches, sha256Of } from '../download.js'
import { writeFileAtomic, type DecisionHome } from '../home.js'
import type { Backend } from './packs.js'
import { replaceDirectory } from './packs.js'
import type { ModelFormat } from './worker.js'

/** The model families published for local use. */
export const MODEL_FAMILIES = ['mini', 'flash', 'standard'] as const
export type ModelFamily = typeof MODEL_FAMILIES[number]

/** Where a published model can be downloaded from. */
export const MODEL_SOURCES = ['huggingface', 'modelscope-intl', 'modelscope-cn'] as const
export type ModelSource = typeof MODEL_SOURCES[number]

/** One published repository revision. */
export interface PublishedRepository {
  readonly repo: string
  /** A commit, never a branch, so the files cannot change under the pins. */
  readonly revision: string
  /** SHA-256 of the repository's `manifest.json`. */
  readonly manifestSha256: string
}

export interface CatalogModel {
  readonly family: ModelFamily
  readonly name: string
  readonly parameters: string
  readonly format: ModelFormat
  /** Peak GPU memory measured with the recommended format, when known. */
  readonly peakGpuMemoryGiB?: number
  /** Download addresses; null until the model is published there. */
  readonly sources: Readonly<Record<ModelSource, PublishedRepository | null>>
}

/** Published local models. The addresses are filled in when each model is released. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    family: 'mini', name: 'vulcan-decision-shell-v1-mini', parameters: '0.2B', format: 'torch-release', peakGpuMemoryGiB: 2.46,
    sources: { 'huggingface': null, 'modelscope-intl': null, 'modelscope-cn': null },
  },
  {
    family: 'flash', name: 'vulcan-decision-shell-v1-flash', parameters: '0.35B', format: 'torch-release',
    sources: { 'huggingface': null, 'modelscope-intl': null, 'modelscope-cn': null },
  },
  {
    family: 'standard', name: 'vulcan-decision-shell-v1', parameters: '0.8B', format: 'torch-release',
    sources: { 'huggingface': null, 'modelscope-intl': null, 'modelscope-cn': null },
  },
]

/** The backend a package format runs on. */
export function backendOf(format: ModelFormat): Backend {
  return format === 'onnx-delivery' ? 'onnx' : 'torch'
}

/** URL of one file of a published repository. */
export function repositoryFileUrl(source: ModelSource, published: PublishedRepository, file: string): string {
  const encoded = file.split('/').map(encodeURIComponent).join('/')
  switch (source) {
    case 'huggingface':
      return `https://huggingface.co/${published.repo}/resolve/${published.revision}/${encoded}`
    case 'modelscope-intl':
      return `https://www.modelscope.ai/models/${published.repo}/resolve/${published.revision}/${encoded}`
    case 'modelscope-cn':
      return `https://www.modelscope.cn/models/${published.repo}/resolve/${published.revision}/${encoded}`
  }
}

export interface FileDigest {
  readonly bytes: number
  readonly sha256: string
}

/** `model.json` of an installed package. */
export interface InstalledModel {
  readonly format: 1
  readonly id: string
  readonly name: string
  readonly family?: ModelFamily
  readonly package_format: ModelFormat
  readonly bytes: number
  readonly installed_at: string
  readonly source: { readonly kind: 'directory'; readonly path: string } | { readonly kind: 'download'; readonly source: ModelSource; readonly repo: string; readonly revision: string }
  readonly files: Readonly<Record<string, FileDigest>>
}

/** What a package directory or repository declares. */
interface PackageDeclaration {
  readonly id: string
  readonly name: string
  readonly format: ModelFormat
  readonly family?: ModelFamily
  /** Files to install, with their declared digests. */
  readonly files: Readonly<Record<string, FileDigest>>
}

/** Files of a torch release that running it needs, besides the recommended weights. */
const TORCH_RUNTIME_PATHS = [/^decision\.py$/, /^runtime\//, /^tokenizer\//, /^weights\/formats\.json$/, /^weights\/fp32\//,
  /^(LICENSE|LICENSE-DATA\.md|NOTICE\.md|README(\.zh)?\.md|config\.json|configuration\.json)$/, /^licenses\//]

/** Parse a package's manifest into what to install. */
export function declarationOf(manifestName: string, text: string): PackageDeclaration {
  const manifest = JSON.parse(text) as Record<string, unknown>
  const files = manifestFiles(manifest)
  if (manifestName === 'manifest.json') {
    const name = manifest.model
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) throw new Error('manifest.json names no model')
    const selected = Object.fromEntries(Object.entries(files).filter(([file]) => TORCH_RUNTIME_PATHS.some(pattern => pattern.test(file))))
    for (const required of ['decision.py', 'weights/formats.json', 'weights/fp32/model.safetensors']) {
      if (selected[required] === undefined) throw new Error(`manifest.json does not list ${required}`)
    }
    return { id: name, name, format: 'torch-release', files: selected }
  }
  const modelFile = manifest.model_file
  if (typeof modelFile !== 'string' || files[modelFile] === undefined) throw new Error('MANIFEST.json names no listed model file')
  for (const required of ['runtime-config.json', 'assets/policy-v2.json', 'assets/tokenizer.json']) {
    if (files[required] === undefined) throw new Error(`MANIFEST.json does not list ${required}`)
  }
  const stem = path.posix.basename(modelFile).replace(/\.onnx$/, '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-')
  return { id: `${stem}-${files[modelFile].sha256.slice(0, 8)}`, name: stem, format: 'onnx-delivery', files }
}

/** The files a manifest lists, refusing any path that is not a plain relative path with `/`. */
export function manifestFiles(manifest: Record<string, unknown>): Record<string, FileDigest> {
  const listed = manifest.files
  if (typeof listed !== 'object' || listed === null) throw new Error('the manifest lists no files')
  const files: Record<string, FileDigest> = {}
  for (const [relative, entry] of Object.entries(listed as Record<string, { bytes?: unknown; sha256?: unknown }>)) {
    const segments = relative.split('/')
    if (relative === '' || relative.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..' || /^[A-Za-z]:/.test(segment))) {
      throw new Error(`the manifest lists an unsafe path ${relative}`)
    }
    if (typeof entry.bytes !== 'number' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      throw new Error(`the manifest entry ${relative} is malformed`)
    }
    files[relative] = { bytes: entry.bytes, sha256: entry.sha256.toLowerCase() }
  }
  return files
}

/** Every installed model with a readable `model.json`. */
export function listModels(home: DecisionHome): InstalledModel[] {
  const models: InstalledModel[] = []
  for (const entry of fs.readdirSync(home.models, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const model = readModel(home, entry.name)
    if (model !== undefined) models.push(model)
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

export function readModel(home: DecisionHome, id: string): InstalledModel | undefined {
  try {
    const model = JSON.parse(fs.readFileSync(path.join(home.models, id, 'model.json'), 'utf8')) as InstalledModel
    return model.format === 1 && model.id === id ? model : undefined
  } catch {
    return undefined
  }
}

export function modelRoot(home: DecisionHome, id: string): string {
  return path.join(home.models, id)
}

export interface ModelInstallOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (done: number, total: number, file: string) => void
}

/**
 * Install the package in `dir`, a torch release repository or an ONNX delivery, verifying every
 * file against the package's manifest.
 */
export async function installModelFromDirectory(home: DecisionHome, dir: string, options: ModelInstallOptions = {}): Promise<InstalledModel> {
  const root = path.resolve(dir)
  const manifestName = ['manifest.json', 'MANIFEST.json'].find(name => fs.readdirSync(root).includes(name))
  if (manifestName === undefined) throw new Error(`${root} has no manifest.json or MANIFEST.json`)
  const manifestText = fs.readFileSync(path.join(root, manifestName), 'utf8')
  const declaration = declarationOf(manifestName, manifestText)
  return await installPackage(home, declaration, manifestName, manifestText, { kind: 'directory', path: root }, async (file, dest) => {
    fs.copyFileSync(path.join(root, ...file.split('/')), dest)
  }, options)
}

/**
 * Download and install a published catalog model from `source`.
 * @throws Error when the model has no address at that source yet.
 */
export async function downloadModel(home: DecisionHome, family: ModelFamily, source: ModelSource, options: ModelInstallOptions = {}): Promise<InstalledModel> {
  const entry = MODEL_CATALOG.find(model => model.family === family)
  const published = entry?.sources[source]
  if (entry === undefined || published === null || published === undefined) {
    throw new Error(`${family} is not published on ${source} yet; install it from a directory instead`)
  }
  const response = await fetch(repositoryFileUrl(source, published, 'manifest.json'), options.signal === undefined ? {} : { signal: options.signal })
  if (!response.ok) throw new Error(`cannot download manifest.json: HTTP ${response.status}`)
  const manifestText = await response.text()
  const digest = createHash('sha256').update(manifestText, 'utf8').digest('hex')
  if (digest !== published.manifestSha256) throw new Error('the published manifest.json does not match its pin')
  const declaration = declarationOf('manifest.json', manifestText)
  const work = path.join(home.downloads, `model-${published.manifestSha256.slice(0, 16)}`)
  return await installPackage(home, { ...declaration, family }, 'manifest.json', manifestText,
    { kind: 'download', source, repo: published.repo, revision: published.revision },
    async (file, dest, digest) => {
      const cached = path.join(work, ...file.split('/'))
      await fetchPinned({ name: file, url: repositoryFileUrl(source, published, file), ...digest }, cached,
        options.signal === undefined ? {} : { signal: options.signal })
      fs.renameSync(cached, dest)
    }, options).finally(() => fs.rmSync(work, { recursive: true, force: true }))
}

async function installPackage(
  home: DecisionHome,
  declaration: PackageDeclaration,
  manifestName: string,
  manifestText: string,
  source: InstalledModel['source'],
  place: (file: string, dest: string, digest: FileDigest) => Promise<void>,
  options: ModelInstallOptions,
): Promise<InstalledModel> {
  const staging = path.join(home.models, `.staging-${declaration.id}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    const total = Object.values(declaration.files).reduce((sum, file) => sum + file.bytes, 0)
    let done = 0
    for (const [file, digest] of Object.entries(declaration.files)) {
      options.signal?.throwIfAborted()
      options.onProgress?.(done, total, file)
      const dest = path.join(staging, ...file.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      await place(file, dest, digest)
      if (!await matches(dest, digest)) throw new Error(`${file} does not match the package manifest`)
      done += digest.bytes
    }
    options.onProgress?.(total, total, '')
    fs.writeFileSync(path.join(staging, manifestName), manifestText)
    const family = declaration.family ?? MODEL_CATALOG.find(model => model.name === declaration.name)?.family
    const model: InstalledModel = {
      format: 1, id: declaration.id, name: declaration.name, ...family === undefined ? {} : { family },
      package_format: declaration.format, bytes: total, installed_at: new Date().toISOString(), source, files: declaration.files,
    }
    writeFileAtomic(path.join(staging, 'model.json'), `${JSON.stringify(model, null, 2)}\n`)
    replaceDirectory(staging, modelRoot(home, declaration.id))
    return model
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/** Remove an installed model. */
export function removeModel(home: DecisionHome, id: string): boolean {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) return false
  const dir = modelRoot(home, id)
  const existed = fs.existsSync(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return existed
}

/** Verify every file of an installed model again. @returns the files that no longer match. */
export async function verifyModel(home: DecisionHome, model: InstalledModel): Promise<string[]> {
  const root = modelRoot(home, model.id)
  const broken: string[] = []
  for (const [file, digest] of Object.entries(model.files)) {
    const local = path.join(root, ...file.split('/'))
    const stat = fs.statSync(local, { throwIfNoEntry: false })
    if (stat?.size !== digest.bytes || await sha256Of(local) !== digest.sha256) broken.push(file)
  }
  return broken
}
