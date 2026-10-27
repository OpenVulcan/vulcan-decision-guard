/**
 * Per-session unattended switch. The state lives in the session's own log as a plugin record, so
 * it follows the session through restarts, forks and resumes; a session projection folds it and
 * serves it to the composer quick card, and the `/vulcan-unattended` command is the one write path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Record type of one switch of the unattended state. */
export const UNATTENDED_RECORD = 'plugin:vulcan-decision-guard/unattended'

/** Projection key the client reads; also restated in `client/index.tsx`. */
export const PROJECTION_KEY = 'vulcanDecision'

/** Slash command that switches the state; also restated in `client/index.tsx`. */
export const UNATTENDED_COMMAND = 'vulcan-unattended'

/** One switch, as logged. */
export interface UnattendedRecord {
  readonly enabled: boolean
}

/** What the session projection holds and serves. */
export interface GuardSessionView {
  readonly unattended: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** The session's unattended switch; the latest record wins. */
    'plugin:vulcan-decision-guard/unattended': UnattendedRecord
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

const ATTENDED: GuardSessionView = Object.freeze({ unattended: false })
const UNATTENDED: GuardSessionView = Object.freeze({ unattended: true })

/**
 * Validator of the state and the wire view. dsh only calls `parse`; a hand-written one keeps this
 * package off dsh's zod version, whose schema type the definition names.
 */
const viewSchema = {
  parse(value: unknown): GuardSessionView {
    if (typeof value === 'object' && value !== null && typeof (value as { unattended?: unknown }).unattended === 'boolean') {
      return (value as GuardSessionView).unattended ? UNATTENDED : ATTENDED
    }
    throw new TypeError('vulcanDecision projection: expected { unattended: boolean }')
  },
} as unknown as ProjectionDefinition<'vulcanDecision'>['stateSchema']

/**
 * Fold one event into the state. Records are validated because a restored record carries whatever
 * an earlier build wrote; one that does not parse leaves the state unchanged.
 */
export function applyUnattended(state: GuardSessionView, event: SessionEvent): GuardSessionView {
  const record = pluginRecordOf(event)
  if (record === undefined || record.type !== UNATTENDED_RECORD) return state
  const data = record.data
  if (typeof data !== 'object' || data === null || typeof (data as { enabled?: unknown }).enabled !== 'boolean') return state
  const next = (data as UnattendedRecord).enabled ? UNATTENDED : ATTENDED
  return next.unattended === state.unattended ? state : next
}

/** Register the projection and the command; returns the reader the gate uses. */
export function installUnattended(ctx: Context): (session: Session) => boolean {
  const projections = ctx.sessionProjections
  projections.register<'vulcanDecision', GuardSessionView>({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: viewSchema,
    init: () => ATTENDED,
    apply: applyUnattended,
    wire: { viewSchema, view: state => state },
  })

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      definitionId: CommandDefinitionId('@openvulcan/dsh-decision-guard'),
      name: UNATTENDED_COMMAND,
      description: 'Turn Vulcan Decision\'s unattended mode on or off for this session',
      input: { hint: 'on | off' },
      handler: ({ agent, rawInput }) => {
        const word = rawInput.trim().toLowerCase()
        const current = projections.stateOf(agent.session, PROJECTION_KEY)?.unattended ?? false
        if (word === '') return { kind: 'success', text: `unattended ${current ? 'on' : 'off'}` }
        if (word !== 'on' && word !== 'off') return { kind: 'error', text: `expected "on" or "off", got "${word}"` }
        const enabled = word === 'on'
        if (enabled !== current) appendPluginRecord(agent.session, UNATTENDED_RECORD, { enabled })
        return { kind: 'success', text: `unattended ${word}` }
      },
    })
  })

  return session => projections.stateOf(session, PROJECTION_KEY)?.unattended ?? false
}
