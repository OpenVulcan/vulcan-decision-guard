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
  /** Judgements run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly home: DecisionHome, private readonly idleMs: number = LOCAL_IDLE_MS) {}

  status(): LocalStatus {
    return {
      running: this.worker?.running === true,
      ...this.current === undefined ? {} : { selection: this.current.selection },
      ...this.current?.loaded === undefined ? {} : { loaded: this.current.loaded },
    }
  }

  /** Judge `inputs` with `selection`, loading it first when needed. */
  judge(selection: LocalSelection, inputs: readonly JudgeInput[]): Promise<ModelResult[]> {
    const run = this.queue.then(() => this.run(selection, inputs))
    this.queue = run.catch(() => {})
    return run
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

  private async run(selection: LocalSelection, inputs: readonly JudgeInput[]): Promise<ModelResult[]> {
    await this.ensure(selection)
    const worker = this.worker
    if (worker === undefined) throw new DecisionError('backend_unavailable', 'the local model process is not running')
    try {
      const results = await worker.judge(inputs)
      if (!Array.isArray(results) || results.length !== inputs.length) throw new DecisionError('model_failed', 'the local model did not answer every call')
      return results.map(checkResult)
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
