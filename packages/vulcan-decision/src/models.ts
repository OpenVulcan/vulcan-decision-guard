/** Keeps the models the service has loaded, loading on first use and unloading when idle. */

import { DecisionError, type ModelSize, type ModelStatus, type Verdict } from './protocol.js'
import { listInstalled, selectModel } from './model/package.js'
import { LoadedModel, type ModelInput } from './model/runtime.js'

/** A model nobody has used for this long is unloaded to return its memory. */
const UNLOAD_AFTER_MS = 15 * 60 * 1000

interface Slot {
  readonly loading: Promise<LoadedModel>
  /** Set once loading succeeded. */
  model?: LoadedModel
  lastUsed: number
}

export class ModelHost {
  readonly #slots = new Map<string, Slot>()
  readonly #timer: NodeJS.Timeout

  constructor() {
    this.#timer = setInterval(() => { void this.#unloadIdle() }, 60_000)
    this.#timer.unref()
  }

  /**
   * Judge one rendered call with the model for `size`.
   * @throws DecisionError when no model can answer.
   */
  async judge(size: ModelSize | undefined, input: ModelInput): Promise<Verdict> {
    const model = selectModel(size)
    const id = model.manifest.id
    let slot = this.#slots.get(id)
    if (slot === undefined) {
      const loading = LoadedModel.load(model)
      const created: Slot = { loading, lastUsed: Date.now() }
      this.#slots.set(id, created)
      loading.then((loaded) => { created.model = loaded }, () => {
        // A failed load is forgotten so the next call retries, for example after a reinstall.
        if (this.#slots.get(id) === created) this.#slots.delete(id)
      })
      slot = created
    }
    slot.lastUsed = Date.now()
    let loaded: LoadedModel
    try {
      loaded = await slot.loading
    } catch (error) {
      throw new DecisionError('model_failed', `cannot load ${id}: ${messageOf(error)}`)
    }
    try {
      const [verdict] = await loaded.predict([input])
      return verdict!
    } catch (error) {
      if (error instanceof DecisionError) throw error
      throw new DecisionError('model_failed', `${id} could not judge the call: ${messageOf(error)}`)
    }
  }

  /** Installed models and whether each is loaded. */
  status(): ModelStatus[] {
    const models: ModelStatus[] = []
    for (const model of listInstalled()) {
      const loaded = this.#slots.get(model.manifest.id)?.model
      models.push({
        id: model.manifest.id,
        size: model.manifest.size,
        loaded: loaded !== undefined,
        ...loaded === undefined ? {} : { device: loaded.provider },
      })
    }
    return models
  }

  async close(): Promise<void> {
    clearInterval(this.#timer)
    const slots = [...this.#slots.values()]
    this.#slots.clear()
    await Promise.all(slots.map(slot => slot.loading.then(model => model.release(), () => {})))
  }

  async #unloadIdle(): Promise<void> {
    const now = Date.now()
    for (const [id, slot] of this.#slots) {
      if (now - slot.lastUsed < UNLOAD_AFTER_MS) continue
      this.#slots.delete(id)
      await slot.loading.then(model => model.release(), () => {})
    }
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
