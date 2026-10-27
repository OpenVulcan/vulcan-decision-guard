/**
 * Per-session state of the guard: the unattended switch with the deny policy the user confirmed
 * for it, and the session's own additional review prompt. The state lives in the session's own log
 * as plugin records, so it follows the session through restarts, forks and resumes; a session
 * projection folds it and serves it to the composer quick card, and two slash commands are the
 * only write paths.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Record type of one switch of the unattended state. */
export const UNATTENDED_RECORD = 'plugin:vulcan-decision-guard/unattended'

/** Record type of one change of the session's additional review prompt. */
export const REVIEW_PROMPT_RECORD = 'plugin:vulcan-decision-guard/review-prompt'

/** Projection key the client reads; also restated in `client/quick.tsx`. */
export const PROJECTION_KEY = 'vulcanDecision'

/** Slash command that switches unattended mode; also restated in `client/index.tsx`. */
export const UNATTENDED_COMMAND = 'vulcan-unattended'

/** Slash command that sets the session's review prompt; also restated in `client/index.tsx`. */
export const REVIEW_PROMPT_COMMAND = 'vulcan-review-prompt'

/**
 * Longest review prompt or deny policy, in characters; the settings schema, both commands and
 * the client (`MAX_PROMPT_CHARS` in `client/shared.ts`) use this limit.
 */
export const MAX_PROMPT_CHARS = 4000

/** One switch, as logged; `denyPolicy` is the policy confirmed when it was turned on. */
export interface UnattendedRecord {
  readonly enabled: boolean
  readonly denyPolicy?: string
}

/** One review prompt change, as logged; null follows the system default again. */
export interface ReviewPromptRecord {
  readonly prompt: string | null
}

/** What the session projection holds and serves. */
export interface GuardSessionView {
  readonly unattended: boolean
  /** The deny policy of unattended mode; empty while off or when none was given. */
  readonly denyPolicy: string
  /** The session's own review prompt; null follows the system default. */
  readonly reviewPrompt: string | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** The session's unattended switch; the latest record wins. */
    'plugin:vulcan-decision-guard/unattended': UnattendedRecord
    /** The session's own review prompt; the latest record wins. */
    'plugin:vulcan-decision-guard/review-prompt': ReviewPromptRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    vulcanDecision: GuardSessionView
  }
  interface SessionProjectionMap {
    /** Vulcan Decision's per-session state for the composer controls. */
    vulcanDecision: GuardSessionView
  }
}

const INITIAL: GuardSessionView = Object.freeze({ unattended: false, denyPolicy: '', reviewPrompt: null })

/**
 * Validator of the state and the wire view. dsh only calls `parse`; a hand-written one keeps this
 * package off dsh's zod version, whose schema type the definition names.
 */
const viewSchema = {
  parse(value: unknown): GuardSessionView {
    const view = value as Partial<GuardSessionView> | null
    if (
      typeof view === 'object' && view !== null && typeof view.unattended === 'boolean' && typeof view.denyPolicy === 'string'
      && (view.reviewPrompt === null || typeof view.reviewPrompt === 'string')
    ) {
      return Object.freeze({ unattended: view.unattended, denyPolicy: view.denyPolicy, reviewPrompt: view.reviewPrompt })
    }
    throw new TypeError('vulcanDecision projection: expected { unattended: boolean, denyPolicy: string, reviewPrompt: string | null }')
  },
} as unknown as ProjectionDefinition<'vulcanDecision'>['stateSchema']

/**
 * Fold one event into the state. Records are validated because a restored record carries whatever
 * an earlier build wrote; one that does not parse leaves the state unchanged.
 */
export function applySessionRecord(state: GuardSessionView, event: SessionEvent): GuardSessionView {
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  const data = record.data as Record<string, unknown> | null
  if (typeof data !== 'object' || data === null) return state
  if (record.type === UNATTENDED_RECORD) {
    if (typeof data['enabled'] !== 'boolean') return state
    const policy = data['denyPolicy']
    if (policy !== undefined && typeof policy !== 'string') return state
    const unattended = data['enabled']
    const denyPolicy = unattended ? policy ?? '' : ''
    return unattended === state.unattended && denyPolicy === state.denyPolicy ? state : Object.freeze({ ...state, unattended, denyPolicy })
  }
  if (record.type === REVIEW_PROMPT_RECORD) {
    const prompt = data['prompt']
    if (prompt !== null && typeof prompt !== 'string') return state
    return prompt === state.reviewPrompt ? state : Object.freeze({ ...state, reviewPrompt: prompt })
  }
  return state
}

/** The first word of a command's input and the text after it. */
function splitInput(rawInput: string): { word: string; rest: string } {
  const trimmed = rawInput.trim()
  const match = /^(\S*)\s*([\s\S]*)$/.exec(trimmed)!
  return { word: match[1]!.toLowerCase(), rest: match[2]!.trim() }
}

/** Register the projection and the commands; returns the reader the gate uses. */
export function installSessionState(ctx: Context): (session: Session) => GuardSessionView {
  const projections = ctx.sessionProjections
  projections.register<'vulcanDecision', GuardSessionView>({
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: viewSchema,
    init: () => INITIAL,
    apply: applySessionRecord,
    wire: { viewSchema, view: state => state },
  })
  const read = (session: Session): GuardSessionView => projections.stateOf(session, PROJECTION_KEY) ?? INITIAL
  // UTF-16 length, as the configuration schema counts it.
  const tooLong = (text: string): boolean => text.length > MAX_PROMPT_CHARS

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      definitionId: CommandDefinitionId('@openvulcan/dsh-decision-guard'),
      name: UNATTENDED_COMMAND,
      description: 'Turn Vulcan Decision\'s unattended mode on, with an optional deny policy, or off for this session',
      input: { hint: 'on [deny policy] | off' },
      handler: ({ agent, rawInput }) => {
        const { word, rest } = splitInput(rawInput)
        const current = read(agent.session)
        if (word === '') return { kind: 'success', text: `unattended ${current.unattended ? 'on' : 'off'}` }
        if (word === 'off') {
          if (rest !== '') return { kind: 'error', text: '"off" takes no deny policy' }
          if (current.unattended) appendPluginRecord(agent.session, UNATTENDED_RECORD, { enabled: false })
          return { kind: 'success', text: 'unattended off' }
        }
        if (word !== 'on') return { kind: 'error', text: `expected "on" or "off", got "${word}"` }
        if (tooLong(rest)) return { kind: 'error', text: `the deny policy is longer than ${MAX_PROMPT_CHARS} characters` }
        if (!current.unattended || current.denyPolicy !== rest) {
          appendPluginRecord(agent.session, UNATTENDED_RECORD, { enabled: true, denyPolicy: rest })
        }
        return { kind: 'success', text: 'unattended on' }
      },
    })
    child.commands.register({
      definitionId: CommandDefinitionId('@openvulcan/dsh-decision-guard'),
      name: REVIEW_PROMPT_COMMAND,
      description: 'Set this session\'s additional review prompt for Vulcan Decision, or follow the system default again',
      input: { hint: 'set <prompt> | default' },
      handler: ({ agent, rawInput }) => {
        const { word, rest } = splitInput(rawInput)
        const current = read(agent.session).reviewPrompt
        if (word === '') return { kind: 'success', text: current === null ? 'review prompt follows the system default' : 'review prompt set for this session' }
        if (word === 'default') {
          if (rest !== '') return { kind: 'error', text: '"default" takes no prompt' }
          if (current !== null) appendPluginRecord(agent.session, REVIEW_PROMPT_RECORD, { prompt: null })
          return { kind: 'success', text: 'review prompt follows the system default' }
        }
        if (word !== 'set') return { kind: 'error', text: `expected "set" or "default", got "${word}"` }
        if (tooLong(rest)) return { kind: 'error', text: `the review prompt is longer than ${MAX_PROMPT_CHARS} characters` }
        if (current !== rest) appendPluginRecord(agent.session, REVIEW_PROMPT_RECORD, { prompt: rest })
        return { kind: 'success', text: 'review prompt set for this session' }
      },
    })
  })

  return read
}
