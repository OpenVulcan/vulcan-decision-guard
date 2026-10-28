/**
 * The local backend: keeps one worker process with the selected model loaded, restarts it when
 * the selection changes and stops it after a quiet period.
 */

import { DecisionError, checkResult, type JudgeInput, type ModelResult } from '../protocol.js'
import type { DecisionHome } from '../home.js'
import { backendOf, modelRoot, readModel } from './models.js'
import { installedPack, packPython, type PackId } from './packs.js'
import { WorkerProcess, type LoadResult } from './worker.js'

/** Which installed pack runs which installed model. */
export interface LocalSelection {
  readonly pack: PackId
  readonly model: string
}

/** One caller waiting for its inputs to be judged. */
interface Waiting {
  readonly selection: LocalSelection
  readonly inputs: readonly JudgeInput[]
  readonly resolve: (results: ModelResult[]) => void
  readonly reject: (error: unknown) => void
}

function selectionKey(selection: LocalSelection): string {
  return `${selection.pack}\n${selection.model}`
}

/** Split `inputs` into requests of at most `limit` inputs, in order; no limit means one request. */
export function mergeRequests<T>(inputs: readonly T[], limit: number | undefined): T[][] {
  const size = limit === undefined || limit < 1 ? Math.max(inputs.length, 1) : limit
  const requests: T[][] = []
  for (let start = 0; start < inputs.length; start += size) requests.push(inputs.slice(start, start + size))
  return requests
}

/** Hand each caller back its own slice of the merged results. */
export function splitResults<T>(groups: readonly (readonly unknown[])[], results: readonly T[]): T[][] {
  let offset = 0
  return groups.map(group => {
    const slice = results.slice(offset, offset + group.length)
    offset += group.length
    return slice
  })
}

/** Stop the process after this long without a judgement, to give its memory back. */
export const LOCAL_IDLE_MS = 30 * 60_000

export interface LocalStatus {
  readonly running: boolean
  readonly selection?: LocalSelection
  readonly loaded?: LoadResult
}

export class LocalEngine {
  private worker: WorkerProcess | undefined
  private current: { readonly key: string; readonly selection: LocalSelection; loading: Promise<LoadResult>; loaded?: LoadResult } | undefined
  private idleTimer: NodeJS.Timeout | undefined
  /** Loads and merged judgements run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Callers waiting for the next merged judgement. */
  private waiting: Waiting[] = []
  /** Whether a drain of `waiting` is already queued behind the running work. */
  private drainQueued = false

  constructor(private readonly home: DecisionHome, private readonly idleMs: number = LOCAL_IDLE_MS) {}

  status(): LocalStatus {
    return {
      running: this.worker?.running === true,
      ...this.current === undefined ? {} : { selection: this.current.selection },
      ...this.current?.loaded === undefined ? {} : { loaded: this.current.loaded },
    }
  }

  /**
   * Judge `inputs` with `selection`, loading it first when needed. Calls that arrive while the
   * worker is busy wait together and go out as one merged request, split into requests of at most
   * the package's `max_request_items` calls.
   */
  judge(selection: LocalSelection, inputs: readonly JudgeInput[]): Promise<ModelResult[]> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ selection, inputs, resolve, reject })
      if (this.drainQueued) return
      this.drainQueued = true
      const run = this.queue.then(() => {
        this.drainQueued = false
        return this.drain()
      })
      this.queue = run.catch(() => {})
    })
  }

  /** Load `selection` ahead of the first judgement. */
  async warm(selection: LocalSelection): Promise<LoadResult> {
    const run = this.queue.then(() => this.ensure(selection))
    this.queue = run.catch(() => {})
    return await run
  }

  stop(): void {
    clearTimeout(this.idleTimer)
    void this.worker?.stop()
    this.worker = undefined
    this.current = undefined
  }

  /** Answer every waiting caller, one selection at a time in arrival order. */
  private async drain(): Promise<void> {
    for (let first = this.waiting[0]; first !== undefined; first = this.waiting[0]) {
      const key = selectionKey(first.selection)
      const group = this.waiting.filter(entry => selectionKey(entry.selection) === key)
      this.waiting = this.waiting.filter(entry => selectionKey(entry.selection) !== key)
      try {
        const results = await this.run(first.selection, group.map(entry => entry.inputs))
        group.forEach((entry, index) => entry.resolve(results[index] ?? []))
      } catch (error) {
        for (const entry of group) entry.reject(error)
      }
    }
  }

  /** Judge several callers' inputs with `selection` in merged requests; answers per caller. */
  private async run(selection: LocalSelection, groups: readonly (readonly JudgeInput[])[]): Promise<ModelResult[][]> {
    const loaded = await this.ensure(selection)
    const worker = this.worker
    if (worker === undefined) throw new DecisionError('backend_unavailable', 'the local model process is not running')
    try {
      const flat = groups.flat()
      const results: ModelResult[] = []
      for (const request of mergeRequests(flat, loaded.limits?.max_request_items)) {
        const answered = await worker.judge(request)
        if (!Array.isArray(answered) || answered.length !== request.length) throw new DecisionError('model_failed', 'the local model did not answer every call')
        results.push(...answered.map(checkResult))
      }
      return splitResults(groups, results)
    } finally {
      this.armIdle()
    }
  }

  private async ensure(selection: LocalSelection): Promise<LoadResult> {
    const key = `${selection.pack}\n${selection.model}`
    if (this.current?.key === key && this.worker?.running === true) return await this.current.loading
    this.stop()
    const pack = installedPack(this.home, selection.pack)
    if (pack === undefined) throw new DecisionError('not_installed', `the runtime pack ${selection.pack} is not installed`)
    const model = readModel(this.home, selection.model)
    if (model === undefined) throw new DecisionError('not_installed', `the model ${selection.model} is not installed`)
    if (backendOf(model.package_format) !== pack.backend) {
      throw new DecisionError('invalid_request', `${model.id} needs a ${backendOf(model.package_format)} runtime pack, not ${pack.pack}`)
    }
    const worker = new WorkerProcess(packPython(this.home, pack))
    this.worker = worker
    const current: NonNullable<typeof this.current> = {
      key, selection,
      loading: worker.load(model.package_format, modelRoot(this.home, model.id), pack.device),
    }
    this.current = current
    try {
      current.loaded = await current.loading
      return current.loaded
    } catch (error) {
      if (this.current === current) this.stop()
      throw error
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs)
    this.idleTimer.unref()
  }
}
