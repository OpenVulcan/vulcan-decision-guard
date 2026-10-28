/**
 * The host side of `python/vulcan_decision_worker.py`: one child process per runtime pack and
 * model, answering JSON-line requests in order. Any failure, timeout or exit becomes an error;
 * none of them is ever an answer.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { DecisionError, type JudgeInput, type ModelResult } from '../protocol.js'

/** The worker script shipped with this package. */
export const WORKER_SCRIPT = fileURLToPath(new URL('../../python/vulcan_decision_worker.py', import.meta.url))

/** What `probe` reports about a pack's interpreter. */
export interface ProbeResult {
  readonly python: string
  readonly machine: string
  readonly system: string
  readonly onnxruntime?: string
  readonly onnx_providers?: readonly string[]
  readonly torch?: string
  readonly torch_cuda?: string | null
  readonly cuda_devices?: readonly { readonly name: string; readonly capability: string }[]
}

export type ModelFormat = 'onnx-delivery' | 'torch-release'

/** Request and batch limits an ONNX package declares in its `runtime-config.json`. */
export interface BatchLimits {
  /** Longest call in tokens; longer calls are answered as over the limit, not evaluated. */
  readonly max_tokens: number
  /** Most calls one `judge` request may carry; the host splits larger groups. */
  readonly max_request_items: number
  /** Most rows one graph run takes. */
  readonly micro_batch: number
  /** Most padded tokens (rows times the longest row) one graph run takes. */
  readonly padded_batch_tokens: number
}

export interface LoadResult {
  readonly load_seconds: number
  readonly format: ModelFormat
  readonly root: string
  readonly device: string
  /** Present for ONNX packages; a torch release batches on its own. */
  readonly limits?: BatchLimits
}

/** Longest wait for a probe. */
const PROBE_TIMEOUT_MS = 120_000
/** Longest wait for loading a model; the first CUDA start can take a while. */
const LOAD_TIMEOUT_MS = 600_000
/** Longest wait for one judgement, which may hold up to the model's full token limit on a CPU. */
const JUDGE_TIMEOUT_MS = 180_000

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export class WorkerProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderr = ''

  constructor(private readonly python: string) {}

  get running(): boolean {
    return this.child !== undefined
  }

  probe(): Promise<ProbeResult> {
    return this.request('probe', {}, PROBE_TIMEOUT_MS) as Promise<ProbeResult>
  }

  load(format: ModelFormat, root: string, device: string): Promise<LoadResult> {
    return this.request('load', { format, root, device }, LOAD_TIMEOUT_MS) as Promise<LoadResult>
  }

  judge(inputs: readonly JudgeInput[]): Promise<ModelResult[]> {
    return this.request('judge', { inputs }, JUDGE_TIMEOUT_MS) as Promise<ModelResult[]>
  }

  /** Kill the process; pending requests fail. Resolves once the process has exited. */
  stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.failAll(new DecisionError('backend_unavailable', 'the local model process was stopped'))
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill()
    return exited
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child
    const child = spawn(this.python, ['-I', '-B', WORKER_SCRIPT], {
      // Outside the pack, so a running process never keeps the pack directory busy.
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
    })
    createInterface({ input: child.stdout }).on('line', line => this.receive(line))
    const ended = (reason: string) => {
      if (this.child === child) this.child = undefined
      this.failAll(new DecisionError('backend_unavailable', `the local model process ${reason}${this.lastError()}`))
    }
    child.on('error', error => ended(`could not start: ${error.message}`))
    child.on('exit', code => ended(`exited with code ${code}`))
    return child
  }

  private request(op: string, fields: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A request that never answers leaves the process in an unknown state.
        void this.stop()
        reject(new DecisionError('backend_unavailable', `the local model did not answer ${op} within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`)
    })
  }

  private receive(line: string): void {
    let message: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      void this.stop()
      return
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (pending === undefined) return
    this.pending.delete(message.id as number)
    clearTimeout(pending.timer)
    if (message.ok === true) {
      pending.resolve(message.result)
    } else {
      const code = message.error?.code
      const text = typeof message.error?.message === 'string' ? message.error.message : 'unknown error'
      pending.reject(new DecisionError(code === 'invalid_request' ? 'invalid_request' : 'model_failed', `${String(code)}: ${text}`))
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private lastError(): string {
    const lines = this.stderr.trim().split(/\r?\n/).filter(Boolean)
    return lines.length === 0 ? '' : `: ${lines.at(-1)}`
  }
}
