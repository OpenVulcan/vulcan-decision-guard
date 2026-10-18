/**
 * Browser half of the dsh plugin, shown on the Plugins page:
 *
 * - The plugin's settings page: live status, how the guard is turned on, the decision backend,
 *   review of uncertain calls, and the OpenVulcan account.
 * - The Auto review conflict notice. dsh's own Auto review and Vulcan Decision both review every
 *   tool call before it runs and only one of them can provide the Auto permission preset, so the
 *   pair is a conflict, not a combination. The notice appears as a tag and a section on both
 *   plugins' pages, with a control that disables Auto review.
 *
 * dsh loads this file as one lazy factory; it may import only modules dsh serves to plugins.
 */

import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, SettingsForm, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BundleInfo, ClientContext, ConfigForm, ConfigOp, ConfigPageProps, DetailProps } from './dsh-client'

/** Must equal this package's name and its `cordis.patch.yml` row. */
const PACKAGE_NAME = '@openvulcan/dsh-decision-guard'
/** The Host entry id from `cordis.patch.yml`, which names this plugin's configuration namespace. */
const ENTRY_ID = 'vulcan-decision-guard'
/** DeepSeek Harness's experimental Auto review bundle. */
const AUTO_REVIEW_PACKAGE = '@deepseek-ai/dsh-experimental-auto-review'
/** dsh's Auto permission preset value. */
const AUTO_PRESET = 'auto'
const NAMESPACE = 'vulcan-decision-guard'

export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.permissionPresets', 'configForms']

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

  'summary': '每次工具调用前由 Vulcan Decision 判定是否放行。',
  'status.title': '状态',
  'status.decision': '判定',
  'status.decision.none': '当前版本尚未提供判定后端，受管控的工具调用一律拒绝',
  'status.auto': 'Auto 权限预设',
  'status.auto.provided': '由 Vulcan Decision 提供，在权限选择器中选择「自动审查」即可启用',
  'status.auto.held': '被「自动授权审查」占用，见下方冲突提示',
  'status.auto.pending': '正在注册',
  'status.auto.standalone': '独立开关方式不使用 Auto 预设，所有会话都受判定',
  'status.unknown': '读取中…',
  'tone.ok': '正常',
  'tone.warn': '注意',
  'tone.blocked': '拒绝中',
  'tone.off': '未使用',

  'preview': '判定后端、复核与账号仍在开发中：这里的选择会保存，相应功能上线后生效。',
  'mode.title': '接入方式',
  'mode.auto-preset': '自动预设',
  'mode.auto-preset.hint': '在权限选择器中提供「自动审查」，只判定选择它的会话。该预设固定为完全权限，不使用文件沙箱。',
  'mode.standalone': '独立开关',
  'mode.standalone.hint': '判定所有会话，叠加在会话所选的权限预设之上，保留其文件沙箱。',
  'backend.title': '判定后端',
  'backend.cloud': 'OpenVulcan 云端',
  'backend.cloud.hint': '工具调用的内容发送到 OpenVulcan 判定，需要登录 OpenVulcan 账号。本机无需额外算力。',
  'backend.local': '本机模型',
  'backend.local.hint': '在本机运行 vulcan-decision-shell 模型，数据不出本机。首次使用时下载模型。',
  'model.title': '模型尺寸',
  'model.recommended': '按本机配置推荐',
  'model.hint': '尺寸越大判定越准确，占用的内存与时间也越多。',
  'review.title': '拿不准的调用',
  'review.host-model': '先由当前会话的模型复核',
  'review.host-model.hint': '复核仍未放行时再询问你。复核会消耗当前会话所用模型的用量。',
  'review.off': '直接询问我',
  'review.off.hint': '不调用其他模型，由你决定是否放行。',
  'account.title': 'OpenVulcan 账号',
  'account.none': '尚未开放。云端判定上线后在这里登录。',
  'account.signIn': '登录',

  'form.unavailable': 'dsh 未提供本插件的设置。',
  'form.readOnly': '当前配置为只读，无法保存。',
  'form.saveFailed': '保存失败，设置已恢复为 dsh 当前保存的值。',
  'form.save': '保存',
  'form.saving': '正在保存…',
}

type Key = keyof typeof zh

const en: Record<Key, string> = {
  'conflict.tag': 'Conflict',
  'conflict.title.guard': 'Conflicts with Auto review',
  'conflict.title.review': 'Conflicts with Vulcan Decision',
  'conflict.body.guard': 'Auto review is also enabled. Both review every tool call before it runs, so they duplicate each other, and only one of them can provide Auto in the permission picker; the other has no effect. Disable Auto review to let Vulcan Decision take over.',
  'conflict.body.review': 'Vulcan Decision is enabled. Both review every tool call before it runs, so they duplicate each other, and only one of them can provide Auto in the permission picker; the other has no effect. Disable this plugin to let Vulcan Decision take over.',
  'conflict.disable': 'Disable Auto review',
  'conflict.disabling': 'Disabling…',
  'conflict.restart': 'Disabled; restart dsh for it to take effect.',
  'conflict.failed': 'Could not disable it: ',

  'summary': 'Vulcan Decision judges every tool call before it runs.',
  'status.title': 'Status',
  'status.decision': 'Decisions',
  'status.decision.none': 'This version has no decision backend yet, so every governed tool call is denied',
  'status.auto': 'Auto permission preset',
  'status.auto.provided': 'Provided by Vulcan Decision; choose Auto in the permission picker to use it',
  'status.auto.held': 'Held by Auto review; see the conflict notice below',
  'status.auto.pending': 'Registering',
  'status.auto.standalone': 'Not used in standalone mode; every session is judged',
  'status.unknown': 'Loading…',
  'tone.ok': 'OK',
  'tone.warn': 'Attention',
  'tone.blocked': 'Denying',
  'tone.off': 'Not used',

  'preview': 'The decision backend, review and account are still in development: choices made here are saved and take effect when those features ship.',
  'mode.title': 'How the guard is turned on',
  'mode.auto-preset': 'Auto preset',
  'mode.auto-preset.hint': 'Adds Auto to the permission picker and judges only sessions that choose it. That preset always has full access and no file sandbox.',
  'mode.standalone': 'Standalone',
  'mode.standalone.hint': 'Judges every session on top of the permission preset it chose, keeping that preset\'s file sandbox.',
  'backend.title': 'Decision backend',
  'backend.cloud': 'OpenVulcan cloud',
  'backend.cloud.hint': 'Tool calls are sent to OpenVulcan to be judged; requires an OpenVulcan sign-in. Needs no extra computing power here.',
  'backend.local': 'Local model',
  'backend.local.hint': 'Runs the vulcan-decision-shell model on this machine, so nothing leaves it. The model downloads on first use.',
  'model.title': 'Model size',
  'model.recommended': 'Recommended for this machine',
  'model.hint': 'Larger sizes judge more accurately and use more memory and time.',
  'review.title': 'Calls the model is unsure about',
  'review.host-model': 'Review with the session\'s model first',
  'review.host-model.hint': 'You are asked only when the review does not allow the call. Reviews count toward the session model\'s usage.',
  'review.off': 'Ask me directly',
  'review.off.hint': 'No other model is called; you decide whether the call runs.',
  'account.title': 'OpenVulcan account',
  'account.none': 'Not available yet. Sign in here once cloud decisions ship.',
  'account.signIn': 'Sign in',

  'form.unavailable': 'dsh does not serve this plugin\'s settings.',
  'form.readOnly': 'The configuration is read-only, so changes cannot be saved.',
  'form.saveFailed': 'Saving failed; the settings show what dsh has stored.',
  'form.save': 'Save',
  'form.saving': 'Saving…',
}

/** Configuration values as the Host's schema resolves them; mirrors `Config` in `src/index.ts`. */
interface GuardSettings {
  readonly mode: 'auto-preset' | 'standalone'
  readonly backend: 'cloud' | 'local'
  readonly modelSize?: '0.2b' | '0.4b' | '0.6b' | undefined
  readonly review: 'host-model' | 'off'
}

type Field = keyof GuardSettings

/** The model sizes offered, in order; `''` stands for the device recommendation (field unset). */
const MODEL_SIZES = ['', '0.2b', '0.4b', '0.6b'] as const

/**
 * Latest-answer-wins view of one Host fact, shared by every rendered entry. `undefined` means
 * unknown: before the first answer, or after a failed read, so nothing is shown as a guess.
 */
class HostWatch<T> {
  #value: T | undefined
  #listeners = new Set<() => void>()
  #generation = 0

  constructor(private readonly read: () => Promise<T | undefined>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): T | undefined => this.#value

  /** Re-read the fact; an older answer never replaces a newer one. */
  refresh(): void {
    const generation = ++this.#generation
    this.read().then((value) => {
      if (generation === this.#generation) this.#set(value)
    }, () => {
      if (generation === this.#generation) this.#set(undefined)
    })
  }

  /** Stop publishing answers that are still in flight. */
  close(): void {
    ++this.#generation
    this.#listeners.clear()
  }

  #set(value: T | undefined): void {
    if (Object.is(value, this.#value)) return
    this.#value = value
    for (const listener of this.#listeners) listener()
  }
}

function autoReviewEnabled(bundles: readonly BundleInfo[]): boolean {
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

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  heading: { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  card: {
    display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l2)', overflow: 'hidden',
  },
  statusRow: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '12px 16px',
  },
  statusLabel: { fontSize: 13, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)', flexShrink: 0 },
  statusText: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', textAlign: 'right' },
  option: {
    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', cursor: 'pointer',
  },
  optionTitle: { display: 'block', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
  radio: { margin: '3px 0 0', accentColor: 'var(--dsw-alias-state-business-primary)' },
  divider: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
  select: { alignSelf: 'flex-start', minWidth: 220, padding: '6px 8px', borderRadius: 8, fontSize: 13 },
  notice: {
    margin: 0, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
  },
} as const satisfies Record<string, import('react').CSSProperties>

/** Install the settings page and the conflict notice while this plugin is enabled. */
export function apply(ctx: ClientContext): void {
  const autoReview = new HostWatch<boolean>(async () => {
    const result = await ctx.remote.pluginManager.listBundles()
    return result.ok ? autoReviewEnabled(result.value) : undefined
  })
  const autoListed = new HostWatch<boolean>(async () => {
    const result = await ctx.remote.permissionPresets.catalog()
    return result.ok ? result.value.options.some(option => option.value === AUTO_PRESET) : undefined
  })
  const form: ConfigForm<GuardSettings> = ctx.configForms.get<GuardSettings>(ENTRY_ID)
  // The form's methods are class methods; React calls store functions without a receiver.
  const subscribeForm = (listener: () => void): (() => void) => form.subscribe(listener)
  const formSnapshot = () => form.getSnapshot()

  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'vulcan-decision-guard: dictionaries')
  ctx.effect(() => {
    const refreshAll = (): void => {
      autoReview.refresh()
      autoListed.refresh()
    }
    const stops = [
      ctx.remote.$on('plugin-manager/changed', () => { autoReview.refresh() }),
      ctx.remote.$on('permission-presets/catalog-changed', () => { autoListed.refresh() }),
      ctx.on('connection/reset', refreshAll),
    ]
    refreshAll()
    return () => {
      for (const stop of stops) stop()
      autoReview.close()
      autoListed.close()
    }
  }, 'vulcan-decision-guard: Host state')

  const useConflict = (subject: DetailProps['subject']): 'guard' | 'review' | null => {
    const enabled = useSyncExternalStore(autoReview.subscribe, autoReview.getSnapshot)
    const side = pageSide(subject)
    return side !== null && enabled === true ? side : null
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
        autoReview.refresh()
      }, (error: unknown) => {
        setPhase({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
      })
    }

    return (
      <section
        role="status"
        style={{
          ...styles.section,
          padding: 16,
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-state-warn-secondary)',
          background: 'var(--dsw-alias-state-warn-tertiary)',
        }}
      >
        <h4 style={{ ...styles.heading, color: 'var(--dsw-alias-state-warn-label)' }}>
          {t(side === 'guard' ? 'conflict.title.guard' : 'conflict.title.review')}
        </h4>
        <p style={{ ...styles.hint, fontSize: 13, lineHeight: '20px' }}>
          {t(side === 'guard' ? 'conflict.body.guard' : 'conflict.body.review')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="outline" size="sm" disabled={phase.kind === 'busy'} onClick={disable}>
            {t(phase.kind === 'busy' ? 'conflict.disabling' : 'conflict.disable')}
          </Button>
          {phase.kind === 'restart' ? <span style={styles.hint}>{t('conflict.restart')}</span> : null}
          {phase.kind === 'failed'
            ? <span style={{ ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }}>{t('conflict.failed')}{phase.reason}</span>
            : null}
        </div>
      </section>
    )
  }

  function StatusRow({ label, tone, toneLabel, children }: {
    label: string
    tone: TagTone
    toneLabel: string
    children: ReactNode
  }) {
    return (
      <div style={styles.statusRow}>
        <span style={styles.statusLabel}>{label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={styles.statusText}>{children}</span>
          <Tag tone={tone}>{toneLabel}</Tag>
        </span>
      </div>
    )
  }

  /** What the page shows about the Auto preset, from the saved mode and the live Host facts. */
  function autoStatus(mode: GuardSettings['mode'] | undefined, heldByReview: boolean | undefined, listed: boolean | undefined) {
    if (mode === undefined || heldByReview === undefined || listed === undefined) {
      return { tone: 'quiet', text: 'status.unknown', toneText: 'status.unknown' } as const
    }
    if (mode === 'standalone') return { tone: 'neutral', text: 'status.auto.standalone', toneText: 'tone.off' } as const
    if (heldByReview) return { tone: 'warning', text: 'status.auto.held', toneText: 'tone.warn' } as const
    if (listed) return { tone: 'success', text: 'status.auto.provided', toneText: 'tone.ok' } as const
    return { tone: 'quiet', text: 'status.auto.pending', toneText: 'status.auto.pending' } as const
  }

  function StatusSection({ t, mode }: { t: (key: Key) => string; mode: GuardSettings['mode'] | undefined }) {
    const heldByReview = useSyncExternalStore(autoReview.subscribe, autoReview.getSnapshot)
    const listed = useSyncExternalStore(autoListed.subscribe, autoListed.getSnapshot)
    const auto = autoStatus(mode, heldByReview, listed)
    return (
      <section style={styles.section}>
        <h4 style={styles.heading}>{t('status.title')}</h4>
        <div style={styles.card}>
          <StatusRow label={t('status.decision')} tone="danger" toneLabel={t('tone.blocked')}>
            {t('status.decision.none')}
          </StatusRow>
          <div style={styles.divider} />
          <StatusRow label={t('status.auto')} tone={auto.tone} toneLabel={t(auto.toneText)}>
            {t(auto.text)}
          </StatusRow>
        </div>
      </section>
    )
  }

  function Choice<V extends string>({ name, value, current, title, hint, disabled, onChoose, first }: {
    name: string
    value: V
    current: V
    title: string
    hint: string
    disabled: boolean
    onChoose: (value: V) => void
    first: boolean
  }) {
    return (
      <label style={{ ...styles.option, ...(first ? {} : styles.divider), ...(disabled ? { cursor: 'default' } : {}) }}>
        <input
          type="radio"
          name={name}
          value={value}
          checked={current === value}
          disabled={disabled}
          onChange={() => { onChoose(value) }}
          style={styles.radio}
        />
        <span>
          <span style={styles.optionTitle}>{title}</span>
          <span style={styles.hint}>{hint}</span>
        </span>
      </label>
    )
  }

  function ChoiceGroup<V extends string>({ title, values, current, disabled, onChoose, t, prefix }: {
    title: string
    values: readonly V[]
    current: V
    disabled: boolean
    onChoose: (value: V) => void
    t: (key: Key) => string
    prefix: 'mode' | 'backend' | 'review'
  }) {
    const name = useId()
    return (
      <fieldset style={{ ...styles.section, margin: 0, padding: 0, border: 0, minWidth: 0 }}>
        <legend style={{ ...styles.heading, padding: 0, marginBottom: 12 }}>{title}</legend>
        <div style={styles.card}>
          {values.map((value, index) => (
            <Choice
              key={value}
              name={name}
              value={value}
              current={current}
              title={t(`${prefix}.${value}` as Key)}
              hint={t(`${prefix}.${value}.hint` as Key)}
              disabled={disabled}
              onChoose={onChoose}
              first={index === 0}
            />
          ))}
        </div>
      </fieldset>
    )
  }

  function SettingsPage({ view, t: translate }: ConfigPageProps) {
    const t = translate as (key: Key) => string
    const accepted = useSyncExternalStore(subscribeForm, formSnapshot)
    const [draft, setDraft] = useState<Partial<Record<Field, string>>>({})
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)
    const modelId = useId()
    if (view === 'summary') return t('summary')

    const value = accepted.value
    // A staged value wins over the accepted one; '' stands for an unset model size.
    const current = <F extends Field>(field: F): string => draft[field] ?? (value?.[field] ?? '')
    const edit = (field: Field, next: string): void => {
      setFailed(false)
      setDraft((staged) => {
        const { [field]: _dropped, ...rest } = staged
        return (value?.[field] ?? '') === next ? rest : { ...rest, [field]: next }
      })
    }
    const save = (): void => {
      const ops: ConfigOp[] = Object.entries(draft).map(([field, next]) => (
        next === '' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: next }
      ))
      setSaving(true)
      form.mutate(ops, accepted.revision).then((landed) => {
        setFailed(!landed)
        setDraft({})
      }, () => {
        setFailed(true)
      }).finally(() => { setSaving(false) })
    }
    const disabled = !accepted.writable || saving
    const mode = current('mode') as GuardSettings['mode']
    const backend = current('backend') as GuardSettings['backend']

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <StatusSection t={t} mode={value?.mode} />
        <SettingsForm
          labels={{
            unavailable: t('form.unavailable'),
            readOnly: t('form.readOnly'),
            saveFailed: t('form.saveFailed'),
            save: t('form.save'),
            saving: t('form.saving'),
          }}
          state={{
            available: accepted.status === 'ready',
            writable: accepted.writable,
            dirty: Object.keys(draft).length > 0,
            invalid: false,
            saving,
            failed,
          }}
          onSave={save}
          onDiscard={() => { setDraft({}) }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <ChoiceGroup
              title={t('mode.title')}
              prefix="mode"
              values={['auto-preset', 'standalone'] as const}
              current={mode}
              disabled={disabled}
              onChoose={(next) => { edit('mode', next) }}
              t={t}
            />
            <p style={styles.notice}>{t('preview')}</p>
            <ChoiceGroup
              title={t('backend.title')}
              prefix="backend"
              values={['cloud', 'local'] as const}
              current={backend}
              disabled={disabled}
              onChoose={(next) => { edit('backend', next) }}
              t={t}
            />
            {backend === 'local'
              ? (
                <div style={styles.section}>
                  <label htmlFor={modelId} style={styles.heading}>{t('model.title')}</label>
                  <select
                    id={modelId}
                    style={styles.select}
                    value={current('modelSize')}
                    disabled={disabled}
                    onChange={(event) => { edit('modelSize', event.target.value) }}
                  >
                    {MODEL_SIZES.map(size => (
                      <option key={size} value={size}>{size === '' ? t('model.recommended') : size.toUpperCase()}</option>
                    ))}
                  </select>
                  <p style={styles.hint}>{t('model.hint')}</p>
                </div>
              )
              : null}
            <ChoiceGroup
              title={t('review.title')}
              prefix="review"
              values={['host-model', 'off'] as const}
              current={current('review') as GuardSettings['review']}
              disabled={disabled}
              onChoose={(next) => { edit('review', next) }}
              t={t}
            />
            <section style={styles.section}>
              <h4 style={styles.heading}>{t('account.title')}</h4>
              <div style={{ ...styles.card, ...styles.statusRow, flexDirection: 'row', alignItems: 'center' }}>
                <span style={styles.hint}>{t('account.none')}</span>
                <Button variant="outline" size="sm" disabled>{t('account.signIn')}</Button>
              </div>
            </section>
          </div>
        </SettingsForm>
      </div>
    )
  }

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    locale: NAMESPACE,
  }, SettingsPage))
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
