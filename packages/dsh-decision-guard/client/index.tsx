/**
 * Browser half of the dsh plugin:
 *
 * - Settings › Auto approval: the whole configuration, in VulcanCode's look (`settings.tsx`).
 * - The composer pill left of the model selector, with a card for the category grants, the
 *   session's review prompt and unattended mode, and the settings changed most often (`quick.tsx`).
 * - The approval card that takes over the composer while one of this plugin's prompts waits.
 * - On the Plugins page: a pointer to the settings, and the Auto review conflict notice. dsh's own
 *   Auto review and Vulcan Decision both review every tool call before it runs and only one of
 *   them can provide the Auto permission preset, so the pair is a conflict, not a combination.
 *
 * dsh loads these files as one lazy factory; they may import only modules dsh serves to plugins.
 */

import { ApprovalCard, ConflictBadge, ConflictSection, guardApprovalOf, PluginPageSummary } from './approval'
import { en, NAMESPACE, zh, type Translate } from './i18n'
import { QuickSetting, type QuickInjected } from './quick'
import { SettingsPage } from './settings'
import {
  AUTO_PRESET, AUTO_REVIEW_PACKAGE, autoReviewEnabled, callPanel, ENTRY_ID, HostWatch, messageOf, PACKAGE_NAME, SETTINGS_SECTION,
  type EndpointSnapshot, type GuardSettings, type ModelList, type PanelState, type Services,
} from './shared'
import { installStyle } from './style'
import type { ClientContext, LocalizedText, ModelCatalog, SettingsShell } from './dsh-client'

export const inject = [
  'slots', 'locale', 'sessions', 'remote', 'remote.pluginManager', 'remote.permissionPresets', 'remote.session', 'configForms',
]

/** Mirror `UNATTENDED_COMMAND` and `REVIEW_PROMPT_COMMAND` in `src/session-state.ts`. */
const UNATTENDED_COMMAND = 'vulcan-unattended'
const REVIEW_PROMPT_COMMAND = 'vulcan-review-prompt'

/** Install the settings section, the composer pill, the approval card and the Plugins page notices. */
export function apply(ctx: ClientContext): void {
  const services: Services = {
    form: ctx.configForms.get<GuardSettings>(ENTRY_ID),
    autoReview: new HostWatch<boolean>(async () => {
      const result = await ctx.remote.pluginManager.listBundles()
      return result.ok ? autoReviewEnabled(result.value) : undefined
    }),
    autoListed: new HostWatch<boolean>(async () => {
      const result = await ctx.remote.permissionPresets.catalog()
      return result.ok ? result.value.options.some(option => option.value === AUTO_PRESET) : undefined
    }),
    panel: new HostWatch<PanelState | null>(() => callPanel<PanelState>('GET', 'state').catch(() => null)),
    endpoints: new HostWatch<EndpointSnapshot>(() => callPanel<EndpointSnapshot>('GET', 'cloud/endpoints')),
    cloudModels: new HostWatch<ModelList>(() => callPanel<string[]>('GET', 'cloud/models').then(
      (models): ModelList => ({ kind: 'ready', models }),
      (error: unknown): ModelList => ({ kind: 'failed', error: messageOf(error) }),
    )),
    modelCatalog: new HostWatch<ModelCatalog>(async () => {
      const result = await ctx.remote.session.modelCatalog()
      return result.ok ? result.value : undefined
    }),
    openSettings: () => {
      const shell = ctx.slots.entries('sidebar.settings')[0]?.store?.create() as SettingsShell | undefined
      shell?.actions.openSection(SETTINGS_SECTION)
    },
  }
  const watches = [services.autoReview, services.autoListed, services.panel, services.endpoints, services.cloudModels, services.modelCatalog]

  ctx.effect(() => installStyle(), 'vulcan-decision-guard: stylesheet')
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'vulcan-decision-guard: dictionaries')
  ctx.effect(() => {
    const refreshAll = (): void => {
      services.autoReview.refresh()
      services.autoListed.refresh()
      services.panel.refresh()
    }
    const stops = [
      ctx.remote.$on('plugin-manager/changed', () => { services.autoReview.refresh() }),
      ctx.remote.$on('permission-presets/catalog-changed', () => { services.autoListed.refresh() }),
      ctx.on('connection/reset', refreshAll),
    ]
    refreshAll()
    return () => {
      for (const stop of stops) stop()
      for (const watch of watches) watch.close()
    }
  }, 'vulcan-decision-guard: Host state')

  const withServices = () => ({ services })

  // After Agent presets (20), before Market (40).
  ctx.slots.inject('settings.section', () => ctx.slots.register<{ services: Services }>({
    name: 'settings.section',
    id: SETTINGS_SECTION,
    order: 22,
    label: () => ctx.locale.bind(NAMESPACE)('nav'),
    locale: NAMESPACE,
    inject: withServices,
  }, ({ t, services: injected }) => <SettingsPage services={injected} t={t as Translate} />))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register<{ services: Services }>({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    locale: NAMESPACE,
    inject: withServices,
  }, PluginPageSummary))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge',
    id: 'vulcan-decision-guard-conflict',
    locale: NAMESPACE,
    inject: withServices,
  }, ConflictBadge))
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'vulcan-decision-guard-conflict',
    locale: NAMESPACE,
    inject: () => ({ services, disableAutoReview: () => ctx.remote.pluginManager.setBundleEnabled(AUTO_REVIEW_PACKAGE, false) }),
  }, ConflictSection))
  // Ahead of dsh's own approval card (priority 1), and only for this plugin's prompts.
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 0,
    locale: NAMESPACE,
    select: ({ pendingInteraction }) => guardApprovalOf(pendingInteraction),
    inject: () => ({ resolveText: (text: LocalizedText) => ctx.locale.resolveText(text) }),
  }, ApprovalCard))
  // Left of the model selector, before other plugins' pills (liangshen uses 20).
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'vulcan-decision-guard-quick',
    order: 10,
    locale: NAMESPACE,
    inject: (sessionId: string): QuickInjected => {
      // The commands keep newlines after their first word, so a multi-line prompt arrives whole.
      const run = async (command: string, input: string): Promise<void> => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error('this session is not materialized yet')
        const result = await session.command(`/${command} ${input}`)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error(`the Host offers no /${command} command`)
      }
      return {
        services,
        setUnattended: policy => run(UNATTENDED_COMMAND, policy === null ? 'off' : `on ${policy}`.trimEnd()),
        setReviewPrompt: prompt => run(REVIEW_PROMPT_COMMAND, prompt === null ? 'default' : `set ${prompt}`.trimEnd()),
      }
    },
  }, QuickSetting))
}
