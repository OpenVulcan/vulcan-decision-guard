/**
 * The parts of dsh's browser runtime this client half uses.
 *
 * dsh serves these modules from its page module table; their packages are not published at the
 * Host's version, so the shapes are restated here from dsh 0.2.1-rc.2 source and must be checked
 * again when the supported dsh range moves:
 * - `packages/client/ui-plugin-manager/src/client/slot-contract.ts` (detail slots and subjects)
 * - `packages/boot/plugin-manager/src/types.ts` (`BundleInfo`, `ChangeResult`)
 * - `packages/client/ui-primitives/src/{Tag,Button}.tsx`
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
  }
  readonly remote: {
    $on(name: 'plugin-manager/changed', listener: () => void): () => void
    readonly pluginManager: {
      listBundles(): Promise<RemoteResult<BundleInfo[]>>
      setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResult<ChangeResult>>
    }
  }
}
