/**
 * Browser half of the dsh plugin: tells the person when DeepSeek Harness's own Auto review is
 * enabled next to Vulcan Decision. Both review every tool call before it runs and only one of them
 * can provide the Auto permission preset, so the pair is a conflict, not a combination. The notice
 * appears as a tag and a section on both plugins' pages, with a control that disables Auto review.
 *
 * dsh loads this file as one lazy factory; it may import only modules dsh serves to plugins.
 */

import { useState, useSyncExternalStore } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BundleInfo, ClientContext, DetailProps } from './dsh-client'

/** Must equal this package's name and its `cordis.patch.yml` row. */
const PACKAGE_NAME = '@openvulcan/dsh-decision-guard'
/** DeepSeek Harness's experimental Auto review bundle. */
const AUTO_REVIEW_PACKAGE = '@deepseek-ai/dsh-experimental-auto-review'
const NAMESPACE = 'vulcan-decision-guard'

export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager']

const zh = {
  'conflict.tag': '冲突',
  'conflict.title.guard': '与「自动授权审查」冲突',
  'conflict.title.review': '与 Vulcan Decision 冲突',
  'conflict.body.guard': '「自动授权审查」也已启用。两者都在每次工具调用前审查，功能重复；权限选择器中的「自动审查」只能由其中一个提供，另一个不会生效。请停用「自动授权审查」，由 Vulcan Decision 接管。',
  'conflict.body.review': 'Vulcan Decision 已启用。两者都在每次工具调用前审查，功能重复；权限选择器中的「自动审查」只能由其中一个提供，另一个不会生效。请停用本插件，由 Vulcan Decision 接管。',
  'conflict.disable': '停用自动授权审查',
  'conflict.disabling': '正在停用…',
  'conflict.restart': '已停用，重启 dsh 后生效。',
  'conflict.failed': '停用失败：',
}

const en: Record<keyof typeof zh, string> = {
  'conflict.tag': 'Conflict',
  'conflict.title.guard': 'Conflicts with Auto review',
  'conflict.title.review': 'Conflicts with Vulcan Decision',
  'conflict.body.guard': 'Auto review is also enabled. Both review every tool call before it runs, so they duplicate each other, and only one of them can provide Auto in the permission picker; the other has no effect. Disable Auto review to let Vulcan Decision take over.',
  'conflict.body.review': 'Vulcan Decision is enabled. Both review every tool call before it runs, so they duplicate each other, and only one of them can provide Auto in the permission picker; the other has no effect. Disable this plugin to let Vulcan Decision take over.',
  'conflict.disable': 'Disable Auto review',
  'conflict.disabling': 'Disabling…',
  'conflict.restart': 'Disabled; restart dsh for it to take effect.',
  'conflict.failed': 'Could not disable it: ',
}

/** What the page knows about Auto review: unknown until the first answer arrives. */
type AutoReviewState = { readonly known: false } | { readonly known: true; readonly enabled: boolean }

/** Latest-answer-wins view of whether Auto review is enabled, shared by every rendered entry. */
class AutoReviewWatch {
  #state: AutoReviewState = { known: false }
  #listeners = new Set<() => void>()
  #generation = 0

  constructor(private readonly ctx: ClientContext) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): AutoReviewState => this.#state

  /** Re-read the bundle list; an older answer never replaces a newer one. */
  refresh(): void {
    const generation = ++this.#generation
    this.ctx.remote.pluginManager.listBundles().then((result) => {
      if (generation !== this.#generation) return
      // A failed read shows nothing rather than a guess.
      this.#set(result.ok ? { known: true, enabled: isEnabled(result.value) } : { known: false })
    }, () => {
      if (generation === this.#generation) this.#set({ known: false })
    })
  }

  /** Stop publishing answers that are still in flight. */
  close(): void {
    ++this.#generation
    this.#listeners.clear()
  }

  #set(state: AutoReviewState): void {
    const previous = this.#state
    if (previous.known === state.known && (!state.known || (previous.known && previous.enabled === state.enabled))) return
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}

function isEnabled(bundles: readonly BundleInfo[]): boolean {
  const bundle = bundles.find(item => item.name === AUTO_REVIEW_PACKAGE)
  return bundle !== undefined && bundle.enabled && bundle.availability !== 'missing'
}

/** Which side of the conflict an open page shows, or null when it is about another plugin. */
function pageSide(subject: DetailProps['subject']): 'guard' | 'review' | null {
  if (subject.kind !== 'bundle') return null
  if (subject.pkg.name === PACKAGE_NAME) return 'guard'
  if (subject.pkg.name === AUTO_REVIEW_PACKAGE) return 'review'
  return null
}

/** Install the conflict tag and section while this plugin is enabled. */
export function apply(ctx: ClientContext): void {
  const watch = new AutoReviewWatch(ctx)

  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'vulcan-decision-guard: dictionaries')
  ctx.effect(() => {
    const stops = [
      ctx.remote.$on('plugin-manager/changed', () => { watch.refresh() }),
      ctx.on('connection/reset', () => { watch.refresh() }),
    ]
    watch.refresh()
    return () => {
      for (const stop of stops) stop()
      watch.close()
    }
  }, 'vulcan-decision-guard: Auto review state')

  const useConflict = (subject: DetailProps['subject']): 'guard' | 'review' | null => {
    const state = useSyncExternalStore(watch.subscribe, watch.getSnapshot)
    const side = pageSide(subject)
    return side !== null && state.known && state.enabled ? side : null
  }

  function ConflictBadge({ subject, t }: DetailProps) {
    return useConflict(subject) === null ? null : <Tag tone="warning">{t('conflict.tag')}</Tag>
  }

  function ConflictSection({ subject, t }: DetailProps) {
    const side = useConflict(subject)
    const [phase, setPhase] = useState<{ readonly kind: 'idle' | 'busy' | 'restart' } | { readonly kind: 'failed'; readonly reason: string }>({ kind: 'idle' })
    if (side === null) return null

    const disable = (): void => {
      setPhase({ kind: 'busy' })
      ctx.remote.pluginManager.setBundleEnabled(AUTO_REVIEW_PACKAGE, false).then((result) => {
        if (!result.ok) {
          setPhase({ kind: 'failed', reason: result.error.message })
        } else if (result.value.error !== undefined || result.value.application === 'failed') {
          setPhase({ kind: 'failed', reason: result.value.error?.message ?? result.value.error?.code ?? result.value.application })
        } else {
          setPhase(result.value.application === 'restart-required' ? { kind: 'restart' } : { kind: 'idle' })
        }
        watch.refresh()
      }, (error: unknown) => {
        setPhase({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
      })
    }

    return (
      <section
        role="status"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 16,
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-state-warn-secondary)',
          background: 'var(--dsw-alias-state-warn-tertiary)',
        }}
      >
        <h4 style={{ margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-state-warn-label)' }}>
          {t(side === 'guard' ? 'conflict.title.guard' : 'conflict.title.review')}
        </h4>
        <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>
          {t(side === 'guard' ? 'conflict.body.guard' : 'conflict.body.review')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="outline" size="sm" disabled={phase.kind === 'busy'} onClick={disable}>
            {t(phase.kind === 'busy' ? 'conflict.disabling' : 'conflict.disable')}
          </Button>
          {phase.kind === 'restart'
            ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('conflict.restart')}</span>
            : null}
          {phase.kind === 'failed'
            ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{t('conflict.failed')}{phase.reason}</span>
            : null}
        </div>
      </section>
    )
  }

  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge',
    id: 'vulcan-decision-guard-conflict',
    locale: NAMESPACE,
  }, ConflictBadge))
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'vulcan-decision-guard-conflict',
    locale: NAMESPACE,
  }, ConflictSection))
}
