/**
 * The parts of dsh's browser runtime this client half uses.
 *
 * dsh serves these modules from its page module table; their packages are not published at the
 * Host's version, so the shapes are restated here from dsh 0.2.1-rc.2 source and must be checked
 * again when the supported dsh range moves:
 * - `packages/client/ui-plugin-manager/src/client/slot-contract.ts` (detail slots and subjects)
 * - `packages/boot/plugin-manager/src/types.ts` (`BundleInfo`, `ChangeResult`)
 * - `packages/client/ui-primitives/src/{Tag,Button}.tsx`, `settings-form/SettingsForm.tsx`
 * - `packages/client/ui-settings/src/client/config-form-types.ts` (`ConfigForm`)
 * - `packages/interaction/permission-presets/src/types.ts` (`PermissionCatalog`)
 * - `packages/client/ui-approval/src/client/contract/slots.ts` (`PendingApproval`)
 * - `packages/client/ui-conversation/src/client/contract/slots.ts` (composer chain, input slots)
 * - `packages/client/ui-settings/src/client/contract/slots.ts` (`settings.section`)
 * - `packages/client/ui-settings-general/src/client/{index,shell-store}.ts` (`sidebar.settings` store)
 * - `packages/client/locale/src/client/index.ts` (`bind`)
 * - `packages/client/ui-session/src/client/index.ts` (`sessionId`, `useProjection` props)
 * - `packages/api/session-controller/src/client/contract/{sessions,session}.ts` (`binding`, `command`)
 * - `packages/api/session-controller/src/types.ts` (`ModelCatalog`)
 */

/** Host operation result as the Remote layer returns it. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** A failure the plugin manager reports with a change. */
export interface ManagementError {
  readonly code: string
  readonly message?: string
}

/** One bundle as `pluginManager.listBundles()` reports it; only the fields read here. */
export interface BundleInfo {
  readonly name: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly availability: 'installation' | 'profile' | 'missing'
}

/** Outcome of `pluginManager.setBundleEnabled()`; only the fields read here. */
export interface ChangeResult {
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly error?: ManagementError
}

/** One bundle as a Plugins detail contribution sees it. */
export interface PluginPackageRef {
  readonly name: string
  readonly enabled: boolean
}

/** What an open Plugins detail page is about. */
export type PluginsSubject =
  | { readonly kind: 'bundle'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'row'; readonly pkg: PluginPackageRef; readonly row: unknown }
  | { readonly kind: 'item'; readonly id: string }

/** Props every detail contribution receives, plus the dictionary of its locale namespace. */
export interface DetailProps {
  readonly subject: PluginsSubject
  readonly t: (key: string) => string
}

/** Props of the bundle's own configuration page. */
export interface ConfigPageProps {
  readonly view: 'summary' | 'page'
  readonly t: (key: string) => string
}

/** One field write of a configuration namespace; `value` is JSON. */
export type ConfigOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** Accepted Host values of one configuration namespace. */
export interface ConfigFormSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: T | undefined
  readonly revision: number | undefined
  readonly writable: boolean
}

/** Reads and writes of one plugin entry's configuration namespace. */
export interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  /** @returns true when the Host accepted every operation. */
  mutate(ops: readonly ConfigOp[], expectedRevision?: number): Promise<boolean>
}

/** The selectable permission presets as `permissionPresets.catalog()` reports them; only the fields read here. */
export interface PermissionCatalog {
  readonly options: readonly { readonly value: string }[]
}

/** Text with an English fallback, resolved by the UI language. */
export interface LocalizedText {
  readonly en: string
  readonly [locale: string]: string
}

/** The pending approval a composer chain entry is offered; only the fields read here. */
export interface PendingApprovalFace {
  readonly kind: 'approval'
  readonly key: string
  readonly toolName: string
  readonly reason: string | undefined
  readonly displayReason: LocalizedText | undefined
  readonly answerable: boolean
  answer(outcome: 'allowed-once' | 'rejected'): Promise<void>
}

/** Owner props of the `conversation.composer` chain. */
export interface ComposerChainProps {
  readonly pendingInteraction: unknown
}

/** Props of a composer takeover, plus what this plugin injects. */
export interface ComposerProps<M> {
  readonly matched: M
  readonly t: (key: string) => string
  readonly resolveText: (text: LocalizedText) => string
}

/** Owner props of a Settings dialog section, plus the dictionary of its locale namespace. */
export interface SettingsSectionProps {
  /** Close the Settings dialog. */
  readonly close: () => void
  readonly t: (key: string) => string
}

/** The Settings dialog store's actions this client uses. */
export interface SettingsShell {
  readonly actions: { openSection(id: string): void }
}

/** Session-scoped props every session slot entry receives; only the fields read here. */
export interface SessionSlotProps {
  readonly sessionId: string
  readonly useProjection: (key: string) => unknown
  readonly t: (key: string) => string
}

/** One provider group of the model catalog. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** The Host's model catalog; only the fields read here. */
export interface ModelCatalog {
  readonly groups: readonly ModelProviderGroup[]
}

/** The browser plugin context services this client half injects. */
export interface ClientContext {
  effect(execute: () => () => void, label?: string): void
  on(name: 'connection/reset', listener: () => void): () => void
  readonly locale: {
    register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
    resolveText(text: LocalizedText): string
    /** The current dictionary of one namespace. */
    bind(namespace: string): (key: string) => string
  }
  readonly slots: {
    inject(name: string, callback: () => () => void): void
    /** Registered entries of a slot; the settings shell's carries the dialog's store. */
    entries(name: string): readonly { readonly store?: { create(): unknown } | undefined }[]
    register<I extends object>(
      options: { readonly name: string; readonly id: string; readonly locale: string; readonly inject: () => I },
      component: (props: DetailProps & I) => import('react').ReactNode,
    ): () => void
    register<I extends object>(
      options: { readonly name: 'plugins.bundle.config'; readonly key: string; readonly locale: string; readonly inject: () => I },
      component: (props: ConfigPageProps & I) => import('react').ReactNode,
    ): () => void
    register<I extends object>(
      options: {
        readonly name: 'settings.section'
        readonly id: string
        readonly order: number
        /** Read by the shell on every render, so it follows the interface language. */
        readonly label: () => string
        readonly locale: string
        readonly inject: () => I
      },
      component: (props: SettingsSectionProps & I) => import('react').ReactNode,
    ): () => void
    register<M, I extends object>(
      options: {
        readonly name: 'conversation.composer'
        readonly priority?: number
        readonly locale: string
        readonly select: (owner: ComposerChainProps) => M | null
        readonly inject: () => I
      },
      component: (props: ComposerProps<M> & I) => import('react').ReactNode,
    ): () => void
    register<I extends object>(
      options: {
        readonly name: 'conversation.input.right'
        readonly id: string
        readonly order?: number
        readonly locale: string
        readonly inject: (sessionId: string) => I
      },
      component: (props: SessionSlotProps & I) => import('react').ReactNode,
    ): () => void
  }
  readonly sessions: {
    binding(sessionId: string): { readonly session: { command(line: string): Promise<RemoteResult<{ readonly matched: boolean }>> } } | undefined
  }
  readonly configForms: {
    get<T>(entryId: string): ConfigForm<T>
  }
  readonly remote: {
    $on(name: 'plugin-manager/changed' | 'permission-presets/catalog-changed', listener: () => void): () => void
    readonly permissionPresets: {
      catalog(): Promise<RemoteResult<PermissionCatalog>>
    }
    readonly session: {
      modelCatalog(): Promise<RemoteResult<ModelCatalog>>
    }
    readonly pluginManager: {
      listBundles(): Promise<RemoteResult<BundleInfo[]>>
      setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResult<ChangeResult>>
    }
  }
}
