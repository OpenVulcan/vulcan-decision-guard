import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { RUN_CODE_NAME, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { DecisionClient, type DecisionOptions, type JudgeSettings } from '@openvulcan/vulcan-decision/client'

import { translateCall } from './calls.js'
import { decide, wantsReview, type FirstStage, type SecondStage } from './decide.js'
import { reviewCall } from './review.js'

export const name = 'vulcan-decision-guard'
export const inject = ['llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

/**
 * How users turn the guard on.
 *
 * - `auto-preset`: register dsh's single `auto` permission preset; sessions that select it are
 *   judged and run with the preset's Full access sandbox.
 * - `standalone`: judge every session on top of whatever preset it selected.
 */
export type Mode = 'auto-preset' | 'standalone'

/** Where verdicts come from: the OpenVulcan cloud (not open yet), or the model on this machine. */
export type Backend = 'cloud' | 'local'

/** Size of the local `vulcan-decision-shell` model. */
export type ModelSize = '0.2b' | '0.4b' | '0.6b'

/**
 * What happens to a call the decision model did not allow.
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
  /** Absent means the largest installed size this device suits. */
  modelSize: Volatile<ModelSize | undefined>
  review: Volatile<Review>
  crossProjectWrites: Volatile<DecisionOptions['cross_project_writes']>
  databaseReset: Volatile<DecisionOptions['database_reset']>
  projectReset: Volatile<DecisionOptions['project_reset']>
}

export const Config = Schema.object({
  mode: Schema.union(['auto-preset', 'standalone'] as const)
    .default('auto-preset')
    .description('auto-preset: appears as the Auto permission preset. standalone: judges every session on top of its preset.')
    .volatile(),
  backend: Schema.union(['cloud', 'local'] as const)
    .default('local')
    .description('local: the model runs on this machine. cloud: OpenVulcan judges calls; not available yet.')
    .volatile(),
  modelSize: Schema.union(['0.2b', '0.4b', '0.6b'] as const)
    .description('Local model size; omitted means the largest installed size this device suits.')
    .volatile(),
  review: Schema.union(['host-model', 'off'] as const)
    .default('host-model')
    .description('host-model: the session model reviews calls the decision model did not allow before the user is asked. off: those calls go to the user.')
    .volatile(),
  crossProjectWrites: Schema.union(['allow', 'review'] as const)
    .default('allow')
    .description('Ordinary writes outside the project: allow them, or ask first.')
    .volatile(),
  databaseReset: Schema.union(['confirm', 'allow'] as const)
    .default('confirm')
    .description('Database drops, truncations and unrestricted data writes: confirm first, or allow.')
    .volatile(),
  projectReset: Schema.union(['confirm', 'allow'] as const)
    .default('confirm')
    .description('Deleting or resetting the whole current project or its history: confirm first, or allow.')
    .volatile(),
})

/** Preset that sessions still on `auto` move to when the guard is removed. */
const FALLBACK_PRESET = 'workspace-write'

/** Structured error identity of a final denial. */
const DENIED_INFO = { name: 'VulcanDecisionDeniedError', code: 'VULCAN_DECISION_DENIED' } as const

/** Install the Vulcan Decision gate and, in `auto-preset` mode, the Auto preset. */
export function apply(ctx: Context, config: Config): void {
  // Retain the injected services while this context drains on disposal.
  const permissionPresets = ctx.permissionPresets
  const sessions = ctx.sessions
  const llm = ctx.llm
  const client = new DecisionClient()
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

  const options = (): DecisionOptions => ({
    cross_project_writes: config.crossProjectWrites.get(),
    database_reset: config.databaseReset.get(),
    project_reset: config.projectReset.get(),
  })

  const gate = async (exec: ToolExecution, signal: AbortSignal): Promise<PreToolDecision | 'next'> => {
    // `governs` established that the call has an agent.
    const agent = exec.agent!
    const project = await ctx.workingDirectory.ensure(agent, signal).catch(() => undefined)
    const translation = translateCall(exec.name, exec.arguments, project)
    if (translation.kind === 'allow') return 'next'

    const decisionOptions = options()
    const modelSize = config.modelSize.get()
    const settings: JudgeSettings = {
      backend: config.backend.get(),
      ...modelSize === undefined ? {} : { model_size: modelSize },
      options: decisionOptions,
    }
    const first: FirstStage = await client.judge({
      host: 'dsh',
      session_id: String(agent.session.id),
      ...project === undefined ? {} : { project },
      tool: translation.tool,
      arguments: translation.arguments,
    }, settings, signal).then(
      verdict => ({ kind: 'verdict', verdict }),
      (error: unknown) => ({ kind: 'error', message: messageOf(error) }),
    )
    if (signal.aborted) return { kind: 'cancel' }

    let second: SecondStage = { kind: 'skipped' }
    if (first.kind === 'verdict' && wantsReview(first) && config.review.get() === 'host-model') {
      const route = agent.session.requestHeader()?.config
      second = route === undefined
        ? { kind: 'error', message: 'the session has no model route to review with' }
        : await reviewCall(llm, {
          provider: route.provider,
          model: route.model,
          project,
          options: decisionOptions,
          stage: first.verdict.decision === 'block' ? 'block' : 'review',
          tool: exec.name,
          arguments: exec.arguments,
          history: agent.session.deriveMessages(),
        }, signal)
      if (signal.aborted) return { kind: 'cancel' }
    }

    const outcome = decide(exec.name, first, second)
    switch (outcome.kind) {
      case 'run':
        return 'next'
      case 'deny':
        return { kind: 'deny', reason: outcome.reason, info: DENIED_INFO }
      case 'ask':
        return { kind: 'ask', reason: outcome.reason, displayReason: outcome.display }
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
      ctx.logger.warn(`cannot register the Auto permission preset: ${messageOf(error)}`)
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
      ctx.logger.warn(`cannot withdraw the Auto permission preset: ${messageOf(error)}`)
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
      const decision = await gate(exec, signal)
      if (decision === 'next') return next()
      if (decision.kind !== 'ask') return decision
      // A later listener's denial, cancellation or own question takes precedence.
      const downstream = await next()
      return downstream.kind === 'allow' ? decision : downstream
    }, { prepend: true })
    yield stopListener

    yield ctx.on('permission-presets/catalog-changed', claimAuto)
    yield ctx.on('loader/volatile-update', syncMode)
    claimAuto()

    // Start the service now so the first tool call does not wait for it.
    client.start().catch((error: unknown) => {
      ctx.logger.warn(`decision service did not start: ${messageOf(error)}`)
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
