import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session'
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

export interface Config {
  mode: Mode
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['auto-preset', 'standalone'] as const)
    .default('auto-preset')
    .description('auto-preset: appears as the Auto permission preset. standalone: judges every session on top of its preset.'),
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
  let ownsAuto = false

  const governs = (exec: ToolExecution): boolean => {
    const agent = exec.agent
    if (agent === undefined) return false
    // The outer run_code transport is not an action; its inner tool calls are judged.
    if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return false
    if (config.mode === 'standalone') return true
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
   * start and whenever the catalog changes, so the slot is taken once the other integration leaves.
   */
  const claimAuto = (): void => {
    if (config.mode !== 'auto-preset' || !accepting || stopAuto !== undefined || claiming) return
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
        if (!accepting) throw new Error('vulcan-decision-guard: integration is closing')
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

    yield async () => {
      const stop = stopAuto
      stopAuto = undefined
      await stop?.()
    }
    yield ctx.on('permission-presets/catalog-changed', claimAuto)
    claimAuto()

    // Start the service now so the first tool call does not wait for it.
    client.start().catch((error: unknown) => {
      ctx.logger.warn(`decision service did not start: ${error instanceof Error ? error.message : String(error)}`)
    })

    // Disposers start in reverse order, so this runs before the Auto preset is withdrawn.
    yield async () => {
      accepting = false
      try {
        if (ownsAuto) {
          for (const session of sessions.list()) {
            if (permissionPresets.current(session) === AUTO_PRESET) permissionPresets.set(session, FALLBACK_PRESET)
          }
        }
      } finally {
        lifecycle.abort(new Error('vulcan-decision-guard integration disposed'))
        client.close()
      }
    }
  }, 'vulcan-decision-guard lifecycle')
}
