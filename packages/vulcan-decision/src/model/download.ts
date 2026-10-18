/**
 * Published decision models and their download.
 *
 * Each published model is one size in one weight format, served as a delivery package directory:
 * `MANIFEST.json` with the size and SHA-256 of every file, next to the files. The catalog pins the
 * directory, the manifest digest and the total size, so nothing unverified is installed. Files
 * verified by an interrupted download are kept and reused; the finished directory goes through
 * {@link installFromDirectory}, which verifies every file again while copying.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { modelsDir } from '../paths.js'
import { MODEL_SIZES, type ModelSize } from '../protocol.js'
import { digestOf, installFromDirectory, type FileDigest, type InstalledModel, type Precision } from './package.js'

/** Where one published model is served from. */
export interface PublishedDownload {
  /** HTTPS directory holding `MANIFEST.json` and the files it lists, ending with `/`. */
  readonly baseUrl: string
  /** SHA-256 of the published `MANIFEST.json`. */
  readonly manifestSha256: string
  /** Sum of the sizes of the files `MANIFEST.json` lists. */
  readonly totalBytes: number
}

/** One published size and weight format. */
export interface PublishedModel {
  readonly size: ModelSize
  readonly precision: Precision
  /** Null until a download address is published. */
  readonly download: PublishedDownload | null
}

/**
 * Every published model. The 0.2B preview has both graphs; their download addresses are not
 * published yet, so they are installed from a directory with `model install` for now.
 */
export const PUBLISHED_MODELS: readonly PublishedModel[] = [
  { size: '0.2b', precision: 'fp16-mixed', download: null },
  { size: '0.2b', precision: 'fp32', download: null },
]

/**
 * The published model to download by default: the largest size up to `limit`, in `precision` when
 * that size is published in it, otherwise in the format it is published in.
 */
export function chooseDownload(limit: ModelSize, precision: Precision, catalog: readonly PublishedModel[] = PUBLISHED_MODELS): PublishedModel | undefined {
  const fitting = catalog.filter(model => MODEL_SIZES.indexOf(model.size) <= MODEL_SIZES.indexOf(limit))
  const largest = fitting.reduce<ModelSize | undefined>(
    (best, model) => best === undefined || MODEL_SIZES.indexOf(model.size) > MODEL_SIZES.indexOf(best) ? model.size : best,
    undefined,
  )
  const candidates = fitting.filter(model => model.size === largest)
  return candidates.find(model => model.precision === precision) ?? candidates[0]
}

/** Options for {@link downloadModel}. */
export interface DownloadOptions {
  readonly size: ModelSize
  readonly precision: Precision
  /** Overrides {@link PUBLISHED_MODELS}, for tests. */
  readonly catalog?: readonly PublishedModel[]
  /** Progress lines for the command line. */
  readonly log?: (line: string) => void
  /** Runs once every file is verified, right before the installed model is replaced. */
  readonly beforeInstall?: () => Promise<void>
}

/**
 * Download and install one published model, replacing the installed model of its size.
 * @throws Error when it is not published, has no download address yet, or fails verification.
 */
export async function downloadModel(options: DownloadOptions): Promise<InstalledModel> {
  const log = options.log ?? (() => {})
  const catalog = options.catalog ?? PUBLISHED_MODELS
  const published = catalog.find(model => model.size === options.size && model.precision === options.precision)
  if (published === undefined) {
    const formats = catalog.filter(model => model.size === options.size).map(model => model.precision)
    throw new Error(formats.length === 0
      ? `no ${options.size} model is published`
      : `the ${options.size} model is published as ${formats.join(' and ')}, not ${options.precision}`)
  }
  const pin = published.download
  if (pin === null) {
    throw new Error(`no download address is published for the ${options.size} ${options.precision} model yet; install it from a directory with "model install <dir> --size ${options.size}"`)
  }
  if (!/^https?:\/\/.+\/$/.test(pin.baseUrl)) throw new Error(`invalid download address ${pin.baseUrl}`)

  // The work directory is named by the manifest digest, so an interrupted download resumes.
  const work = path.join(modelsDir(), `.download-${options.size}-${options.precision}-${pin.manifestSha256.slice(0, 12)}`)
  fs.mkdirSync(work, { recursive: true })
  const manifestPath = path.join(work, 'MANIFEST.json')
  log('downloading MANIFEST.json')
  await fetchTo(new URL('MANIFEST.json', pin.baseUrl), manifestPath)
  const manifestDigest = await digestOf(manifestPath)
  if (manifestDigest.sha256 !== pin.manifestSha256) throw new Error('the published MANIFEST.json does not match the pinned digest')
  const files = manifestFiles(fs.readFileSync(manifestPath, 'utf8'))
  const total = Object.values(files).reduce((sum, file) => sum + file.bytes, 0)
  if (total !== pin.totalBytes) throw new Error('the published MANIFEST.json does not list the pinned size')

  let done = 0
  for (const [relative, expected] of Object.entries(files)) {
    const local = path.join(work, ...relative.split('/'))
    if (!await matches(local, expected)) {
      log(`downloading ${relative} (${(expected.bytes / 1024 ** 2).toFixed(1)} MiB, ${percent(done, total)} done)`)
      fs.mkdirSync(path.dirname(local), { recursive: true })
      await fetchTo(new URL(relative.split('/').map(encodeURIComponent).join('/'), pin.baseUrl), local)
      if (!await matches(local, expected)) {
        fs.rmSync(local, { force: true })
        throw new Error(`${relative} does not match the published manifest`)
      }
    }
    done += expected.bytes
  }
  await options.beforeInstall?.()
  log('installing')
  const model = await installFromDirectory(work, { size: options.size, log })
  fs.rmSync(work, { recursive: true, force: true })
  return model
}

/**
 * The files a delivery `MANIFEST.json` lists, refusing any path that is not a plain relative path
 * with `/` separators.
 */
export function manifestFiles(text: string): Record<string, FileDigest> {
  const manifest = JSON.parse(text) as { readonly files?: Readonly<Record<string, { bytes?: unknown; sha256?: unknown }>> }
  if (typeof manifest.files !== 'object' || manifest.files === null) throw new Error('MANIFEST.json lists no files')
  const files: Record<string, FileDigest> = {}
  for (const [relative, entry] of Object.entries(manifest.files)) {
    const segments = relative.split('/')
    if (relative === '' || relative.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..' || /^[A-Za-z]:/.test(segment))) {
      throw new Error(`MANIFEST.json lists an unsafe path ${relative}`)
    }
    if (typeof entry.bytes !== 'number' || typeof entry.sha256 !== 'string') throw new Error(`MANIFEST.json entry ${relative} is malformed`)
    files[relative] = { bytes: entry.bytes, sha256: entry.sha256.toLowerCase() }
  }
  return files
}

async function matches(file: string, expected: FileDigest): Promise<boolean> {
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile() || stat.size !== expected.bytes) return false
  const actual = await digestOf(file)
  return actual.sha256 === expected.sha256
}

/** Stream `url` into `file` through a partial file, so an interrupted body never looks complete. */
async function fetchTo(url: URL, file: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || response.body === null) throw new Error(`cannot download ${url.href}: HTTP ${response.status}`)
  const partial = `${file}.part`
  // The DOM and node:stream/web declarations of ReadableStream differ only in their typings.
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), fs.createWriteStream(partial))
  fs.renameSync(partial, file)
}

function percent(done: number, total: number): string {
  return `${total === 0 ? 100 : Math.floor((done / total) * 100)}%`
}
