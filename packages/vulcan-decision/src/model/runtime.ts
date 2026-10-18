/** One loaded decision model: tokenizer, policy heads and an ONNX Runtime session. */

import os from 'node:os'
import path from 'node:path'

import ort from 'onnxruntime-node'

import type { Decision, DecisionOptions, Verdict } from '../protocol.js'
import { CallEncoder, decide, planBatches, TokenLimitError, type EncodedCall } from './encoder.js'
import { readRuntimeConfig, type DeviceClass, type GraphVariant, type InstalledModel, type RuntimeConfig } from './package.js'

/** Selects the execution provider; `cpu` unless set. GPU providers are experimental. */
export const DEVICE_ENV = 'VULCAN_DECISION_DEVICE'

/** Execution providers the service can request from onnxruntime-node. */
type Provider = 'cpu' | 'dml' | 'cuda'

/** One call to judge, already rendered in the model's text format. */
export interface ModelInput {
  readonly options: DecisionOptions
  readonly rendered: string
}

export class LoadedModel {
  readonly #session: ort.InferenceSession
  readonly #encoder: CallEncoder
  readonly #config: RuntimeConfig
  /** Runs are serialized to bound the session's memory arena. */
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly model: InstalledModel,
    readonly provider: Provider,
    readonly variant: GraphVariant,
    session: ort.InferenceSession,
    encoder: CallEncoder,
    config: RuntimeConfig,
  ) {
    this.#session = session
    this.#encoder = encoder
    this.#config = config
  }

  static async load(model: InstalledModel): Promise<LoadedModel> {
    const config = readRuntimeConfig(model.root)
    const provider = requestedProvider()
    const deviceClass: DeviceClass = provider === 'cpu' ? 'cpu' : 'gpu'
    const variant = model.manifest.variants.find(item => item.devices.includes(deviceClass))
    if (variant === undefined) throw new Error(`${model.manifest.id} has no graph verified on ${deviceClass}`)
    const encoder = await CallEncoder.load(model.root, config)
    const session = await ort.InferenceSession.create(path.join(model.root, variant.file), {
      executionProviders: [provider],
      // `all` adds layout transforms that crash onnxruntime-node 1.30 on the fp16-projection
      // graphs; `extended` keeps the fusions and loads every published graph.
      graphOptimizationLevel: 'extended',
      intraOpNumThreads: Math.max(1, Math.min(4, os.availableParallelism())),
    })
    const missing = config.input_fields.filter(name => !session.inputNames.includes(name))
    if (missing.length > 0 || !session.outputNames.includes('logits')) {
      await session.release()
      throw new Error(`${variant.file} does not match the model's tensor contract`)
    }
    return new LoadedModel(model, provider, variant, session, encoder, config)
  }

  /** Judge calls in caller order. Calls over the token budget are blocked without running the model. */
  async predict(inputs: readonly ModelInput[]): Promise<Verdict[]> {
    const id = this.model.manifest.id
    const output: (Verdict | undefined)[] = new Array(inputs.length)
    const encoded: EncodedCall[] = []
    const positions: number[] = []
    for (const [index, input] of inputs.entries()) {
      try {
        encoded.push(await this.#encoder.encode(input.options, input.rendered))
        positions.push(index)
      } catch (error) {
        if (!(error instanceof TokenLimitError)) throw error
        output[index] = { decision: 'block', model: id, reason_code: 'input_token_limit' }
      }
    }
    for (const batch of planBatches(encoded, this.#config)) {
      const rows = batch.map(index => encoded[index]!)
      const scores = await this.#serialized(() => this.#run(rows))
      batch.forEach((index, row) => {
        const logits = scores[row]!
        output[positions[index]!] = {
          decision: decide(logits, this.#config) as Decision,
          model: id,
          logits,
          input_tokens: rows[row]!.ids.length,
        }
      })
    }
    return output as Verdict[]
  }

  async release(): Promise<void> {
    await this.#queue.catch(() => {})
    await this.#session.release()
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => {})
    return run
  }

  async #run(rows: readonly EncodedCall[]): Promise<[number, number, number][]> {
    const count = rows.length
    const length = Math.max(...rows.map(row => row.ids.length))
    if (count * length > this.#config.max_tokens) throw new Error('the batch exceeds the padded token budget')
    const labels = this.#config.labels.length
    const inputIds = new BigInt64Array(count * length).fill(BigInt(this.#encoder.special['[PAD]']))
    const attention = new BigInt64Array(count * length)
    const markers = new BigInt64Array(count * labels)
    rows.forEach((row, b) => {
      row.ids.forEach((id, s) => {
        inputIds[b * length + s] = BigInt(id)
        attention[b * length + s] = 1n
      })
      row.markers.forEach((position, m) => {
        if (position < 0 || position >= length) throw new Error('a choice marker is outside the input')
        markers[b * labels + m] = BigInt(position)
      })
    })
    const result = await this.#session.run({
      input_ids: new ort.Tensor('int64', inputIds, [count, length]),
      attention_mask: new ort.Tensor('int64', attention, [count, length]),
      marker_pos: new ort.Tensor('int64', markers, [count, labels]),
      marker_mask: new ort.Tensor('bool', new Uint8Array(count * labels).fill(1), [count, labels]),
      qtype: new ort.Tensor('int64', new BigInt64Array(count), [count]),
    })
    const logits = result.logits
    if (logits === undefined || logits.dims.length !== 2 || logits.dims[0] !== count || logits.dims[1] !== labels) {
      throw new Error('the model returned logits of an unexpected shape')
    }
    const data = Array.from(logits.data as Float32Array, Number)
    if (!data.every(Number.isFinite)) throw new Error('the model returned non-finite scores')
    return rows.map((_, b) => [data[b * labels]!, data[b * labels + 1]!, data[b * labels + 2]!])
  }
}

function requestedProvider(): Provider {
  const value = process.env[DEVICE_ENV] ?? 'cpu'
  if (value === 'cpu' || value === 'dml' || value === 'cuda') return value
  throw new Error(`${DEVICE_ENV} must be cpu, dml or cuda, not ${value}`)
}
