/**
 * Pinned downloads: every file has a known size and SHA-256, is fetched through a partial file
 * that resumes after an interruption, and is refused unless both match.
 *
 * The `cn` source rewrites the official hosts to mirrors reachable from mainland China. A mirror
 * serves the same bytes, so the same pins apply; a failing mirror is reported, never silently
 * replaced by the official host.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

/** Where runtime downloads come from. */
export const DOWNLOAD_SOURCES = ['official', 'cn'] as const
export type DownloadSource = typeof DOWNLOAD_SOURCES[number]

/** Official prefix → mainland China mirror prefix. */
const CN_MIRRORS: readonly (readonly [string, string])[] = [
  ['https://github.com/astral-sh/python-build-standalone/releases/download/', 'https://registry.npmmirror.com/-/binary/python-build-standalone/'],
  ['https://files.pythonhosted.org/packages/', 'https://mirrors.aliyun.com/pypi/packages/'],
  ['https://download-r2.pytorch.org/whl/', 'https://mirrors.aliyun.com/pytorch-wheels/'],
  ['https://download.pytorch.org/whl/', 'https://mirrors.aliyun.com/pytorch-wheels/'],
]

/** The URL to fetch `url` from with `source`. */
export function sourceUrl(url: string, source: DownloadSource): string {
  if (source === 'official') return url
  for (const [official, mirror] of CN_MIRRORS) {
    // The PyTorch mirror stores file names unescaped, like `torch-2.9.1+cu128-...whl`.
    if (url.startsWith(official)) return mirror + (official.includes('pytorch') ? decodeURIComponent(url.slice(official.length)) : url.slice(official.length))
  }
  throw new Error(`no mirror is known for ${new URL(url).host}`)
}

/** One file with its pins. */
export interface PinnedFile {
  readonly name: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

export interface FetchOptions {
  readonly source?: DownloadSource
  readonly signal?: AbortSignal
  /** Called with the number of new bytes as they arrive. */
  readonly onBytes?: (bytes: number) => void
}

/**
 * Make `dest` hold exactly `file`: kept when it already matches, otherwise fetched (resuming a
 * `.part` file left by an earlier attempt) and verified.
 * @throws Error on HTTP failure or when the size or digest does not match.
 */
export async function fetchPinned(file: PinnedFile, dest: string, options: FetchOptions = {}): Promise<void> {
  if (await matches(dest, file)) {
    options.onBytes?.(file.bytes)
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const partial = `${dest}.part`
  let have = fs.statSync(partial, { throwIfNoEntry: false })?.size ?? 0
  if (have > file.bytes) {
    fs.rmSync(partial, { force: true })
    have = 0
  }
  const url = sourceUrl(file.url, options.source ?? 'official')
  if (have < file.bytes) {
    const response = await fetch(url, {
      ...options.signal === undefined ? {} : { signal: options.signal },
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
    })
    const resumed = response.status === 206
    if (!response.ok || response.body === null) throw new Error(`cannot download ${file.name} from ${new URL(url).host}: HTTP ${response.status}`)
    if (!resumed) have = 0
    options.onBytes?.(have)
    const counter = new CountingStream(options.onBytes)
    // The DOM and node:stream/web declarations of ReadableStream differ only in their typings.
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      counter,
      fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' }),
      ...options.signal === undefined ? [] : [{ signal: options.signal }],
    )
  } else {
    options.onBytes?.(have)
  }
  if (!await matches(partial, file)) {
    fs.rmSync(partial, { force: true })
    throw new Error(`${file.name} does not match its pinned size and SHA-256`)
  }
  fs.renameSync(partial, dest)
}

/** Whether `local` is a file of the pinned size and digest. */
export async function matches(local: string, file: Pick<PinnedFile, 'bytes' | 'sha256'>): Promise<boolean> {
  const stat = fs.statSync(local, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile() || stat.size !== file.bytes) return false
  return await sha256Of(local) === file.sha256.toLowerCase()
}

/** SHA-256 of a file, as lowercase hex. */
export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

class CountingStream extends Transform {
  constructor(private readonly onBytes: ((bytes: number) => void) | undefined) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null, data?: Buffer) => void): void {
    this.onBytes?.(chunk.length)
    done(null, chunk)
  }
}
