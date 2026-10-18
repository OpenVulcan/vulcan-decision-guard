/**
 * The model's input contract, ported from the reference Python adapter (`risk_inputs.py`):
 * a fixed English policy head chosen by the three options, three choice markers, then the
 * rendered call, all tokenized without truncation.
 */

import fs from 'node:fs'
import path from 'node:path'

import { Tokenizer } from 'tokenizers'

import type { DecisionOptions } from '../protocol.js'
import type { RuntimeConfig } from './package.js'

/** The fields of the model's `assets/policy-v2.json` the encoder reads. */
interface Policy {
  readonly core_instructions: string
  readonly criteria: Readonly<Record<string, string>>
  readonly options: Readonly<Record<string, { readonly modes: Readonly<Record<string, string>> }>>
}

/** One call ready for the model. */
export interface EncodedCall {
  readonly ids: readonly number[]
  /** Positions of the allow/review/block choice markers. */
  readonly markers: readonly number[]
}

/** Thrown when a complete input exceeds the token budget; the call must not run. */
export class TokenLimitError extends Error {}

const SPECIAL_TOKENS = ['[CLS]', '[SEP]', '[MASK]', '[PAD]'] as const

export class CallEncoder {
  readonly #tokenizer: Tokenizer
  readonly #config: RuntimeConfig
  readonly #optionKeys: readonly string[]
  readonly #heads = new Map<string, EncodedCall>()
  readonly special: Readonly<Record<typeof SPECIAL_TOKENS[number], number>>

  private constructor(tokenizer: Tokenizer, config: RuntimeConfig, optionKeys: readonly string[], special: Record<typeof SPECIAL_TOKENS[number], number>) {
    this.#tokenizer = tokenizer
    this.#config = config
    this.#optionKeys = optionKeys
    this.special = special
  }

  /** Load the tokenizer and policy of a model package and precompute every policy head. */
  static async load(root: string, config: RuntimeConfig): Promise<CallEncoder> {
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'policy-v2.json'), 'utf8')) as Policy
    const tokenizer = Tokenizer.fromFile(path.join(root, 'assets', 'tokenizer.json'))
    tokenizer.disableTruncation()
    tokenizer.disablePadding()
    const special = {} as Record<typeof SPECIAL_TOKENS[number], number>
    for (const name of SPECIAL_TOKENS) {
      const id = tokenizer.tokenToId(name)
      if (id === null) throw new Error(`the tokenizer lacks ${name}`)
      special[name] = id
    }
    if (JSON.stringify(Object.keys(policy.criteria)) !== JSON.stringify(config.labels)) {
      throw new Error('the policy criteria differ from the classifier labels')
    }
    const encoder = new CallEncoder(tokenizer, config, Object.keys(policy.options), special)
    for (const modes of product(encoder.#optionKeys.map(key => Object.keys(policy.options[key]!.modes)))) {
      const fragments = [policy.core_instructions, ...encoder.#optionKeys.map((key, index) => policy.options[key]!.modes[modes[index]!]!)]
      const head = await encoder.#tokens(`choice question: ${fragments.join(' ')}`)
      const options: number[][] = []
      for (const [label, text] of Object.entries(policy.criteria)) {
        options.push([special['[MASK]'], ...(await encoder.#tokens(` ${label}: ${text}`)).slice(0, config.option_tokens)])
      }
      const budget = config.head_tokens - options.reduce((total, option) => total + option.length, 0)
      if (budget < 16 || new Set(options.map(option => option.join(','))).size !== options.length) {
        throw new Error('the fixed policy exceeds the verified head budget')
      }
      const ids = [special['[CLS]'], ...head.slice(0, Math.max(8, budget)), special['[SEP]']]
      const markers: number[] = []
      for (const option of options) {
        markers.push(ids.length)
        ids.push(...option)
      }
      ids.push(special['[SEP]'])
      encoder.#heads.set(modes.join('\u0000'), { ids, markers })
    }
    return encoder
  }

  /**
   * Encode one rendered call under the given options.
   * @throws TokenLimitError when the complete input exceeds `max_tokens`.
   */
  async encode(options: DecisionOptions, rendered: string): Promise<EncodedCall> {
    const values = options as unknown as Readonly<Record<string, unknown>>
    if (Object.keys(values).length !== this.#optionKeys.length) throw new Error('the decision options do not match the model policy')
    const head = this.#heads.get(this.#optionKeys.map(key => String(values[key])).join('\u0000'))
    if (head === undefined) throw new Error('unsupported decision option value')
    const ids = [...head.ids, ...(await this.#tokens(rendered)), this.special['[SEP]']]
    if (ids.length > this.#config.max_tokens) {
      throw new TokenLimitError(`the call needs ${ids.length} tokens; the model reads at most ${this.#config.max_tokens}`)
    }
    return { ids, markers: head.markers }
  }

  async #tokens(text: string): Promise<number[]> {
    // The reference adapter blanks literal mask tokens so caller text cannot fake a marker.
    const encoding = await this.#tokenizer.encode(text.replaceAll('[MASK]', ' '), null, { addSpecialTokens: false })
    return encoding.getIds()
  }
}

/**
 * Split calls into batches bounded by item count and padded token budget, shortest first.
 * @returns indices into `calls`, grouped per batch.
 */
export function planBatches(calls: readonly EncodedCall[], config: Pick<RuntimeConfig, 'micro_batch' | 'max_request_items' | 'max_tokens'>): number[][] {
  const order = calls.map((_, index) => index).sort((a, b) => calls[a]!.ids.length - calls[b]!.ids.length)
  const limit = Math.min(config.micro_batch, config.max_request_items)
  const batches: number[][] = []
  let current: number[] = []
  for (const index of order) {
    const length = calls[index]!.ids.length
    if (current.length > 0 && (current.length >= limit || (current.length + 1) * length > config.max_tokens)) {
      batches.push(current)
      current = []
    }
    current.push(index)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Apply the frozen allow margin to three logits.
 * @throws when the scores are not three finite numbers.
 */
export function decide(scores: readonly number[], config: Pick<RuntimeConfig, 'labels' | 'allow_margin'>): string {
  if (scores.length !== config.labels.length || !scores.every(Number.isFinite)) throw new Error('invalid model scores')
  let choice = 0
  for (let index = 1; index < scores.length; index++) if (scores[index]! > scores[choice]!) choice = index
  if (choice === 0 && scores[0]! - Math.max(...scores.slice(1)) < config.allow_margin) choice = 1
  return config.labels[choice]!
}

function product(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap(prefix => list.map(item => [...prefix, item])), [[]])
}
