import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { RUN_CODE_NAME, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

import { binaryPath } from './binary.js'
import { DecisionClient, type Verdict } from './decision-client.js'

export const name = 'vulcan-decision-guard'
export const inject = ['permissionPresets', 'sessions', 'tools', 'workingDirectory']

/**
 * How users turn the guard on.
 *
 * - `auto-preset`: register dsh's single `auto` permission preset; sessions that select it are
 *   judged and run with the preset's Full access sandbox.
 * - `standalone`: judge every session on top of whatever preset it selected.
 */
export type Mode = 'auto-preset' | 'standalone'

/** Where verdicts come from: the OpenVulcan cloud, or the model running on this machine. */
export type Backend = 'cloud' | 'local'

/** Size of the local `vulcan-decision-shell` model. */
export type ModelSize = '0.2b' | '0.4b' | '0.6b'

/**
 * What happens to a call the decision model is unsure about.
 *
 * - `host-model`: the current session's model reviews it; the user is asked when it still does not allow.
 * - `off`: the user is asked directly.
 */
export type Review = 'host-model' | 'off'

/**
 * Every field is volatile: dsh's settings forms expose only volatile fields, and a change applies
 * without restarting the plugin. Read each value when an operation starts.
 */
export interface Config {
  mode: Volatile<Mode>
  backend: Volatile<Backend>
  /** Absent means the size recommended for this device. */
  modelSize: Volatile<ModelSize | undefined>
  review: Volatile<Review>
}

export const Config = Schema.object({
  mode: Schema.union(['auto-preset', 'standalone'] as const)
    .default('auto-preset')
    .description('auto-preset: appears as the Auto permission preset. standalone: judges every session on top of its preset.')
    .volatile(),
  backend: Schema.union(['cloud', 'local'] as const)
    .default('cloud')
    .description('cloud: OpenVulcan judges calls and needs an OpenVulcan sign-in. local: the model runs on this machine.')
    .volatile(),
  modelSize: Schema.union(['0.2b', '0.4b', '0.6b'] as const)
    .description('Local model size; omitted means the size recommended for this device.')
    .volatile(),
  review: Schema.union(['host-model', 'off'] as const)
    .default('host-model')
    .description('host-model: the session model reviews uncertain calls before the user is asked. off: uncertain calls go to the user.')
    .volatile(),
})

/** Preset that sessions still on `auto` move to when the guard is removed. */
const FALLBACK_PRESET = 'workspace-write'

/** Install the Vulcan Decision gate and, in `auto-preset` mode, the Auto preset. */
export function apply(ctx: Context, config: Config): void {
  // Retain the injected services while this context drains on disposal.
  const permissionPresets = ctx.permissionPresets
  const sessions = ctx.sessions
  const client = new DecisionClient(binaryPath)
  const lifecycle = new AbortController()
  let accepting = true
  let releasing = false
  let ownsAuto = false

  const governs = (exec: ToolExecution): boolean => {
    const agent = exec.agent
    if (agent === undefined) return false
    // The outer run_code transport is not an action; its inner tool calls are judged.
    if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return false
    if (config.mode.get() === 'standalone') return true
    return ownsAuto && permissionPresets.current(agent.session) === AUTO_PRESET
  }

  const judge = async (exec: ToolExecution, signal: AbortSignal): Promise<Verdict> => {
    try {
      const agent = exec.agent
      const cwd = agent === undefined ? undefined : await ctx.workingDirectory.ensure(agent, signal)
      return await client.judge({
        host: 'dsh',
        ...agent === undefined ? {} : { session_id: String(agent.session.id) },
        ...cwd === undefined ? {} : { cwd },
        tool: exec.name,
        arguments: exec.arguments,
      }, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        decision: 'deny',
        reason: `Vulcan Decision could not judge tool "${exec.name}", so it was blocked: ${message}`,
      }
    }
  }

  let stopAuto: (() => Promise<void>) | undefined
  let claiming = false
  let reportedHeld = false

  /**
   * Register `auto` unless another integration (usually Auto review) already holds it. Called at
   * start, whenever the catalog changes and when the mode switches to `auto-preset`, so the slot is
   * taken once the other integration leaves.
   */
  const claimAuto = (): void => {
    if (config.mode.get() !== 'auto-preset' || !accepting || releasing || stopAuto !== undefined || claiming) return
    if (permissionPresets.catalog().options.some(option => option.value === AUTO_PRESET)) {
      if (!reportedHeld) {
        reportedHeld = true
        ctx.logger.warn('the Auto permission preset is held by another integration, usually Auto review; Vulcan Decision takes it once that integration is disabled')
      }
      return
    }
    claiming = true
    try {
      const stop = permissionPresets.registerAuto(() => {
        if (!accepting || releasing) throw new Error('vulcan-decision-guard: the Auto preset is being withdrawn')
      })
      ownsAuto = true
      reportedHeld = false
      stopAuto = async () => {
        ownsAuto = false
        await stop()
      }
    } catch (error) {
      // A concurrent registration won the slot; the plugin keeps loading.
      ctx.logger.warn(`cannot register the Auto permission preset: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      claiming = false
    }
  }

  /** Move sessions still on `auto` to the fallback preset, then withdraw the registration. */
  const releaseAuto = async (): Promise<void> => {
    const stop = stopAuto
    if (stop === undefined || releasing) return
    releasing = true
    try {
      for (const session of sessions.list()) {
        if (permissionPresets.current(session) === AUTO_PRESET) permissionPresets.set(session, FALLBACK_PRESET)
      }
      stopAuto = undefined
      await stop()
    } finally {
      releasing = false
    }
  }

  /** Apply a mode switch made in the settings form. */
  const syncMode = (): void => {
    if (config.mode.get() === 'auto-preset') {
      claimAuto()
      return
    }
    releaseAuto().catch((error: unknown) => {
      ctx.logger.warn(`cannot withdraw the Auto permission preset: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // This plugin ships its own settings page, so schema-generated pages are turned off.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.effect(function* () {
    const stopListener = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (!governs(exec)) return next()
      if (!accepting || lifecycle.signal.aborted) return { kind: 'cancel' }
      const signal = AbortSignal.any([exec.signal, lifecycle.signal])
      const verdict = await judge(exec, signal)
      if (signal.aborted) return { kind: 'cancel' }
      switch (verdict.decision) {
        case 'allow':
          return next()
        case 'deny':
          return { kind: 'deny', reason: verdict.reason }
        case 'ask': {
          // A later listener's denial, cancellation or own question takes precedence.
          const downstream = await next()
          if (downstream.kind !== 'allow') return downstream
          return {
            kind: 'ask',
            reason: verdict.reason,
            displayReason: {
              en: `Vulcan Decision asks you to confirm this call: ${verdict.reason}`,
              zh: `Vulcan Decision 需要你确认此调用：${verdict.reason}`,
            },
          }
        }
      }
    }, { prepend: true })
    yield stopListener

    yield ctx.on('permission-presets/catalog-changed', claimAuto)
    yield ctx.on('loader/volatile-update', syncMode)
    claimAuto()

    // Start the service now so the first tool call does not wait for it.
    client.start().catch((error: unknown) => {
      ctx.logger.warn(`decision service did not start: ${error instanceof Error ? error.message : String(error)}`)
    })

    // Disposers start in reverse order, so this runs first.
    yield async () => {
      accepting = false
      try {
        await releaseAuto()
      } finally {
        lifecycle.abort(new Error('vulcan-decision-guard integration disposed'))
        client.close()
      }
    }
  }, 'vulcan-decision-guard lifecycle')
}
