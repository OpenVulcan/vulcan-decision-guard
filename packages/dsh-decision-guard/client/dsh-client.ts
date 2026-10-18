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

/** One field write of a configuration namespace. */
export type ConfigOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: string }
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

/** The browser plugin context services this client half injects. */
export interface ClientContext {
  effect(execute: () => () => void, label?: string): void
  on(name: 'connection/reset', listener: () => void): () => void
  readonly locale: {
    register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
  }
  readonly slots: {
    inject(name: string, callback: () => () => void): void
    register(
      options: { readonly name: string; readonly id: string; readonly locale: string },
      component: (props: DetailProps) => import('react').ReactNode,
    ): () => void
    register(
      options: { readonly name: 'plugins.bundle.config'; readonly key: string; readonly locale: string },
      component: (props: ConfigPageProps) => import('react').ReactNode,
    ): () => void
  }
  readonly configForms: {
    get<T>(entryId: string): ConfigForm<T>
  }
  readonly remote: {
    $on(name: 'plugin-manager/changed' | 'permission-presets/catalog-changed', listener: () => void): () => void
    readonly permissionPresets: {
      catalog(): Promise<RemoteResult<PermissionCatalog>>
    }
    readonly pluginManager: {
      listBundles(): Promise<RemoteResult<BundleInfo[]>>
      setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResult<ChangeResult>>
    }
  }
}
