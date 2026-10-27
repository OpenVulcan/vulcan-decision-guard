import path from 'node:path'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { RUN_CODE_NAME, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  DecisionEngine, DecisionHome, DOWNLOAD_SOURCES, PACK_IDS,
  type DecisionOptions, type DownloadSource, type EngineSettings, type PackId,
} from '@openvulcan/vulcan-decision'

import { translateCall } from './calls.js'
import { decide, stageOf, wantsReview, type FirstStage, type Outcome, type SecondStage, type Situation } from './decide.js'
import { IntentStore, intentTool } from './intent.js'
import { reviewCall } from './review.js'
import { deviceInfo, DshCredentialStore, handle, Panel, ROUTE_PREFIX, ROUTES } from './panel.js'
import { installUnattended } from './unattended.js'
import { VERSION } from './version.js'

export { PROJECTION_KEY, UNATTENDED_COMMAND, UNATTENDED_RECORD, type GuardSessionView } from './unattended.js'

export const name = 'vulcan-decision-guard'
export const inject = ['llm', 'permissionPresets', 'sessionProjections', 'sessions', 'tools', 'workingDirectory']

/**
 * How users turn the guard on.
 *
 * - `auto-preset`: register dsh's single `auto` permission preset; sessions that select it are
 *   judged and run with the preset's Full access sandbox.
 * - `standalone`: judge every session on top of whatever preset it selected.
 */
export type Mode = 'auto-preset' | 'standalone'

/**
 * Where verdicts come from: OpenVulcan's cloud endpoints (the default, needing only a sign-in), or
 * a model on this machine run by an installed runtime pack.
 */
export type Backend = 'cloud' | 'local'

/**
 * Which LLM reviews calls the decision model did not allow.
 *
 * - `session`: the session's current model.
 * - `custom`: `reviewProvider` and `reviewModel`.
 * - `off`: no LLM review; the user is asked, or the call is refused when nobody can be asked.
 */
export type Review = 'session' | 'custom' | 'off'

/**
 * Every field is volatile: dsh's settings forms expose only volatile fields, and a change applies
 * without restarting the plugin. Read each value when an operation starts.
 */
export interface Config {
  mode: Volatile<Mode>
  backend: Volatile<Backend>
  /** Cloud model id; empty uses the first model OpenVulcan lists for the account. */
  cloudModel: Volatile<string>
  /** Endpoint id the user locked; absent uses the measured best one. */
  cloudEndpoint: Volatile<string | undefined>
  /** Installed runtime pack for the local backend. */
  localPack: Volatile<PackId | undefined>
  /** Installed model id for the local backend. */
  localModel: Volatile<string | undefined>
  /** Download host for runtime packs: the official hosts, or mirrors in China. */
  downloadSource: Volatile<DownloadSource>
  review: Volatile<Review>
  reviewProvider: Volatile<string | undefined>
  reviewModel: Volatile<string | undefined>
  allowRules: Volatile<string>
  denyRules: Volatile<string>
  forbidRules: Volatile<string>
  llmOverridesBlock: Volatile<boolean>
  /** Seconds an approval prompt waits before the call is refused; 0 waits for the user. */
  askTimeout: Volatile<number>
  crossProjectWrites: Volatile<DecisionOptions['cross_project_writes']>
  databaseReset: Volatile<DecisionOptions['database_reset']>
  projectReset: Volatile<DecisionOptions['project_reset']>
}

/** Longest approval countdown the settings accept, in seconds. */
const MAX_ASK_TIMEOUT = 3600

export const Config = Schema.object({
  mode: Schema.union(['auto-preset', 'standalone'] as const)
    .default('auto-preset')
    .description('auto-preset: appears as the Auto permission preset. standalone: judges every session on top of its preset.')
    .volatile(),
  backend: Schema.union(['cloud', 'local'] as const)
    .default('cloud')
    .description('cloud: OpenVulcan judges calls after you sign in. local: an installed model runs on this machine.')
    .volatile(),
  cloudModel: Schema.string()
    .default('')
    .description('Cloud decision model id; empty uses the first model OpenVulcan lists for the account.')
    .volatile(),
  cloudEndpoint: Schema.string()
    .description('Cloud endpoint id to always use; omitted uses the fastest measured one.')
    .volatile(),
  localPack: Schema.union(PACK_IDS)
    .description('Runtime pack that runs the local model.')
    .volatile(),
  localModel: Schema.string()
    .description('Installed local model id.')
    .volatile(),
  downloadSource: Schema.union(DOWNLOAD_SOURCES)
    .default('official')
    .description('Where runtime packs download from: official hosts, or cn mirrors.')
    .volatile(),
  review: Schema.union(['session', 'custom', 'off'] as const)
    .default('session')
    .description('LLM review of calls the decision model did not allow. session: the session model. custom: reviewProvider and reviewModel. off: no review.')
    .volatile(),
  reviewProvider: Schema.string()
    .description('Provider of the review model when review is custom.')
    .volatile(),
  reviewModel: Schema.string()
    .description('Review model when review is custom.')
    .volatile(),
  allowRules: Schema.string().role('textarea').default('')
    .description('Natural-language rules for calls the LLM review should allow.')
    .volatile(),
  denyRules: Schema.string().role('textarea').default('')
    .description('Natural-language rules for calls the LLM review should deny; the user is still asked when present.')
    .volatile(),
  forbidRules: Schema.string().role('textarea').default('')
    .description('Natural-language rules for calls the LLM review refuses without asking anyone.')
    .volatile(),
  llmOverridesBlock: Schema.boolean()
    .default(false)
    .description('Whether calls the decision model blocks also go to the LLM review, which may then allow them.')
    .volatile(),
  askTimeout: Schema.natural().max(MAX_ASK_TIMEOUT)
    .default(0)
    .description('Seconds an approval prompt waits before the call is refused; 0 waits for the user.')
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

/** Settings namespace of dsh's locale plugin, whose `preference` is the chosen interface language. */
const LOCALE_SETTINGS = 'locale'

/** Preset that sessions still on `auto` move to when the guard is removed. */
const FALLBACK_PRESET = 'workspace-write'

/** Structured error identity of a final denial. */
const DENIED_INFO = { name: 'VulcanDecisionDeniedError', code: 'VULCAN_DECISION_DENIED' } as const

/**
 * Key of the approval prompt's `displayReason` entry that carries {@link PromptPayload} as JSON.
 * dsh resolves the prompt text by locale and never reads this key; this plugin's composer card
 * does. Also restated in `client/index.tsx`.
 */
export const PROMPT_KEY = 'x-vulcan-decision'

/** What this plugin's approval card reads from {@link PROMPT_KEY}. */
export interface PromptPayload {
  readonly v: 1
  readonly stage: 'review' | 'block' | 'unjudged'
  readonly review?: 'review' | 'deny' | 'error'
  readonly reviewReason?: string
  readonly focus: 'allow' | 'reject'
  readonly intent?: string
  /** The call's command or arguments, shortened. */
  readonly preview: string
  /** Countdown length; absent when the prompt waits for the user. */
  readonly timeoutMs?: number
}

/** A call the gate finished with, and the purpose the agent stated for it. */
interface Gated {
  readonly outcome: Outcome
  readonly intent: string | undefined
}

/** Install the Vulcan Decision gate and, in `auto-preset` mode, the Auto preset. */
export function apply(ctx: Context, config: Config): void {
  // Retain the injected services while this context drains on disposal.
  const permissionPresets = ctx.permissionPresets
  const sessions = ctx.sessions
  const llm = ctx.llm
  const tools = ctx.tools
  const engine = new DecisionEngine({
    home: new DecisionHome(path.join(resolveDshHome(), 'vulcan-decision')),
    credentials: new DshCredentialStore(() => ctx.get('credentials')),
    device: deviceInfo(VERSION),
    // Tests point sign-in at a local stand-in, as with the command line.
    ...process.env['VULCAN_DECISION_AUTH_ORIGIN'] === undefined ? {} : { authOrigin: process.env['VULCAN_DECISION_AUTH_ORIGIN'] },
  })
  const intents = new IntentStore()
  const lifecycle = new AbortController()
  let accepting = true
  let releasing = false
  let ownsAuto = false

  const markedUnattended = installUnattended(ctx)

  const governs = (exec: ToolExecution): boolean => {
    const agent = exec.agent
    if (agent === undefined) return false
    // The outer run_code transport is not an action; its inner tool calls are judged.
    if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return false
    if (config.mode.get() === 'standalone') return true
    return ownsAuto && permissionPresets.current(agent.session) === AUTO_PRESET
  }

  /** Nobody can be asked: the session is marked unattended, or its approval policy never asks. */
  const unattended = (agent: Agent): boolean => {
    if (markedUnattended(agent.session)) return true
    const approval = ctx.get('approval')
    return approval !== undefined && (approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never'
  }

  const options = (): DecisionOptions => ({
    cross_project_writes: config.crossProjectWrites.get(),
    database_reset: config.databaseReset.get(),
    project_reset: config.projectReset.get(),
  })

  const engineSettings = (): EngineSettings => {
    const pack = config.localPack.get()
    const model = config.localModel.get()
    const endpoint = config.cloudEndpoint.get()
    return {
      backend: config.backend.get(),
      cloudModel: config.cloudModel.get(),
      ...endpoint === undefined || endpoint === '' ? {} : { cloudEndpoint: endpoint },
      ...pack === undefined || model === undefined || model === '' ? {} : { local: { pack, model } },
      options: options(),
    }
  }

  const panel = new Panel(engine, { engine: engineSettings, downloadSource: () => config.downloadSource.get() })

  /**
   * The interface language the user chose in dsh's settings, or undefined when it follows the
   * browser, which the Host cannot see.
   */
  const interfaceLanguage = (): string | undefined => {
    const descriptor = ctx.get('settings')?.describe().find(item => item.ns === LOCALE_SETTINGS)
    const value = descriptor?.value
    const preference = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['preference'] : undefined
    return typeof preference === 'string' && preference !== '' ? preference : undefined
  }

  /** The provider and model that review this agent's calls. */
  const reviewRoute = (agent: Agent): { provider: string; model: string } | string => {
    if (config.review.get() === 'custom') {
      const provider = config.reviewProvider.get()
      const model = config.reviewModel.get()
      return provider === undefined || model === undefined || provider === '' || model === ''
        ? 'no review model is chosen in the settings'
        : { provider, model }
    }
    const route = agent.session.requestHeader()?.config
    return route === undefined ? 'the session has no model route to review with' : { provider: route.provider, model: route.model }
  }

  const gate = async (exec: ToolExecution, signal: AbortSignal): Promise<Gated | 'run' | 'cancel'> => {
    // `governs` established that the call has an agent.
    const agent = exec.agent!
    const project = await ctx.workingDirectory.ensure(agent, signal).catch(() => undefined)
    const translation = translateCall(exec.name, exec.arguments, project)
    if (translation.kind === 'allow') return 'run'
    // The statement belongs to this call whatever happens to it.
    const intent = intents.take(agent.session.id, exec.name)

    const settings = engineSettings()
    const decisionOptions = settings.options
    const first: FirstStage = await abortable(engine.judge({
      ...project === undefined ? {} : { project },
      tool: translation.tool,
      arguments: translation.arguments,
    }, settings), signal).then(
      verdict => ({ kind: 'verdict', verdict }),
      (error: unknown) => ({ kind: 'error', message: messageOf(error) }),
    )
    if (signal.aborted) return 'cancel'
    const stage = stageOf(first)
    if (stage === undefined) return 'run'

    const situation: Situation = {
      attended: !unattended(agent),
      llm: config.review.get() !== 'off',
      llmOverridesBlock: config.llmOverridesBlock.get(),
    }
    let second: SecondStage = { kind: 'skipped' }
    if (wantsReview(stage, situation)) {
      const route = reviewRoute(agent)
      second = typeof route === 'string'
        ? { kind: 'error', message: route }
        : await reviewCall(llm, {
          provider: route.provider,
          model: route.model,
          attended: situation.attended,
          language: interfaceLanguage(),
          project,
          options: decisionOptions,
          rules: { allow: config.allowRules.get(), deny: config.denyRules.get(), forbid: config.forbidRules.get() },
          stage,
          tool: exec.name,
          arguments: exec.arguments,
          intent,
          history: agent.session.deriveMessages(),
        }, signal)
      if (signal.aborted) return 'cancel'
    }
    return { outcome: decide(exec.name, first, second, situation), intent }
  }

  /** Ask the user through dsh's approval service, refusing the call when the countdown runs out. */
  const askUser = async (
    exec: ToolExecution,
    ask: Extract<Outcome, { kind: 'ask' }>,
    intent: string | undefined,
    signal: AbortSignal,
  ): Promise<PreToolDecision> => {
    const approval = ctx.get('approval')
    if (approval === undefined) {
      return denied(`${ask.reason}. No approval channel is available, so the call was not executed.`)
    }
    const seconds = config.askTimeout.get()
    const countdown = seconds > 0 ? AbortSignal.timeout(seconds * 1000) : undefined
    const payload: PromptPayload = {
      v: 1,
      ...ask.detail,
      ...intent === undefined ? {} : { intent },
      preview: previewOf(exec.arguments),
      ...countdown === undefined ? {} : { timeoutMs: seconds * 1000 },
    }
    let result
    try {
      result = await approval.request({
        agent: exec.agent!,
        toolName: exec.name,
        callId: exec.callId,
        reason: ask.reason,
        displayReason: { ...ask.display, [PROMPT_KEY]: JSON.stringify(payload) },
        signal: countdown === undefined ? signal : AbortSignal.any([signal, countdown]),
      })
    } catch (error) {
      return denied(`${ask.reason}. The user could not be asked (${messageOf(error)}), so the call was not executed.`)
    }
    if (signal.aborted) return { kind: 'cancel' }
    switch (result) {
      case 'allowed-once':
        return { kind: 'allow' }
      case 'rejected':
        return denied(`The user rejected tool "${exec.name}". The call was not executed.`)
      case 'cancelled':
        return countdown?.aborted === true
          ? denied(`${ask.reason}. Nobody answered the approval prompt within ${seconds} seconds, so the call was not executed.`)
          : denied(`${ask.reason}. The approval prompt was withdrawn, so the call was not executed.`)
      case 'unavailable':
        return denied(`${ask.reason}. No approval channel answered, so the call was not executed.`)
    }
  }

  let stopIntentTool: (() => void) | undefined
  /** The intent tool is offered while the LLM review is on. */
  const syncIntentTool = (): void => {
    const wanted = accepting && config.review.get() !== 'off'
    if (wanted && stopIntentTool === undefined) {
      stopIntentTool = tools.register(intentTool(intents, exec => governs(exec) && config.review.get() !== 'off'))
    } else if (!wanted && stopIntentTool !== undefined) {
      stopIntentTool()
      stopIntentTool = undefined
      intents.clear()
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

  /** Apply a settings change that affects what is registered. */
  const syncSettings = (): void => {
    syncIntentTool()
    if (config.mode.get() === 'auto-preset') {
      claimAuto()
      return
    }
    releaseAuto().catch((error: unknown) => {
      ctx.logger.warn(`cannot withdraw the Auto permission preset: ${messageOf(error)}`)
    })
  }

  // The settings panel's routes live inside dsh's authenticated connection, when there is one.
  ctx.inject(['connection'], (child) => {
    for (const [method, route, handler] of ROUTES) {
      child.effect(() => child.connection.fetch.register({
        path: `${ROUTE_PREFIX}${route}`,
        methods: [method],
        requestBody: 'buffered',
        fetch: request => handle(panel, handler, request),
      }))
    }
  })

  // This plugin ships its own page under Settings › Auto approval, so schema-generated pages are turned off.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.effect(function* () {
    const stopListener = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (!governs(exec)) return next()
      if (!accepting || lifecycle.signal.aborted) return { kind: 'cancel' }
      const signal = AbortSignal.any([exec.signal, lifecycle.signal])
      const gated = await gate(exec, signal)
      if (gated === 'cancel') return { kind: 'cancel' }
      if (gated === 'run') return next()
      const { outcome, intent } = gated
      switch (outcome.kind) {
        case 'run':
          return next()
        case 'deny':
          return denied(outcome.reason)
        case 'ask': {
          // A later listener's denial, cancellation or own question takes precedence over asking.
          const downstream = await next()
          if (downstream.kind !== 'allow') return downstream
          return await askUser(exec, outcome, intent, signal)
        }
      }
    }, { prepend: true })
    yield stopListener

    yield ctx.on('permission-presets/catalog-changed', claimAuto)
    yield ctx.on('loader/volatile-update', syncSettings)
    claimAuto()
    syncIntentTool()

    // Measure the cloud endpoints at start and again once a measurement is older than its interval.
    const measure = (): void => {
      if (config.backend.get() === 'cloud') panel.endpoints().catch(() => {})
    }
    measure()
    const measuring = setInterval(measure, 60_000)
    yield () => clearInterval(measuring)

    // Load the local model now so the first tool call does not wait for it.
    const warm = engineSettings()
    if (warm.backend === 'local' && warm.local !== undefined) {
      engine.local.warm(warm.local).catch((error: unknown) => {
        ctx.logger.warn(`local decision model did not load: ${messageOf(error)}`)
      })
    }

    // Disposers start in reverse order, so this runs first.
    yield async () => {
      accepting = false
      syncIntentTool()
      try {
        await releaseAuto()
      } finally {
        lifecycle.abort(new Error('vulcan-decision-guard integration disposed'))
        panel.close()
        engine.stop()
      }
    }
  }, 'vulcan-decision-guard lifecycle')
}

/** Longest call preview the approval card shows. */
const MAX_PREVIEW_CHARS = 1200

/** A shell command as it was written, otherwise the arguments as JSON. */
function previewOf(args: unknown): string {
  const command = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['command'] : undefined
  const text = typeof command === 'string' ? command : JSON.stringify(args, null, 2) ?? ''
  return text.length <= MAX_PREVIEW_CHARS ? text : `${text.slice(0, MAX_PREVIEW_CHARS)}…`
}

/** Settle with `promise`, or reject as soon as `signal` aborts; the work itself is not stopped. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason as Error)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function denied(reason: string): PreToolDecision {
  return { kind: 'deny', reason, info: DENIED_INFO }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
