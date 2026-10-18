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
  'status.decision.local': '{model}。服务在首次判定时启动；模型未安装或无法判定时，受管控的调用会询问你',
  'status.decision.cloud': 'OpenVulcan 云端尚未开放，受管控的调用会询问你。请改用本机模型',
  'status.decision.recommended': '本机模型，按本机配置选择已安装的尺寸',
  'status.decision.size': '本机模型 {size}',
  'status.auto': 'Auto 权限预设',
  'status.auto.provided': '由 Vulcan Decision 提供，在权限选择器中选择「自动审查」即可启用',
  'status.auto.held': '被「自动授权审查」占用，见下方冲突提示',
  'status.auto.pending': '正在注册',
  'status.auto.standalone': '独立开关方式不使用 Auto 预设，所有会话都受判定',
  'status.unknown': '读取中…',
  'tone.ok': '正常',
  'tone.warn': '注意',
  'tone.ask': '询问中',
  'tone.off': '未使用',

  'install.title': '安装本机模型',
  'install.body': '模型目前从本地目录安装，下载功能尚未开放。在终端执行下列命令安装或查看状态：',
  'install.status': '查看服务与已安装模型：',
  'mode.title': '接入方式',
  'mode.auto-preset': '自动预设',
  'mode.auto-preset.hint': '在权限选择器中提供「自动审查」，只判定选择它的会话。该预设固定为完全权限，不使用文件沙箱。',
  'mode.standalone': '独立开关',
  'mode.standalone.hint': '判定所有会话，叠加在会话所选的权限预设之上，保留其文件沙箱。',
  'backend.title': '判定后端',
  'backend.cloud': 'OpenVulcan 云端',
  'backend.cloud.hint': '尚未开放。工具调用的内容将发送到 OpenVulcan 判定，需要登录 OpenVulcan 账号。',
  'backend.local': '本机模型',
  'backend.local.hint': '在本机运行 vulcan-decision-shell 模型，工具调用的内容不出本机。',
  'model.title': '模型尺寸',
  'model.recommended': '按本机配置推荐',
  'model.hint': '尺寸越大判定越准确，占用的内存与时间也越多。所选尺寸必须已安装。',
  'review.title': '模型未放行的调用',
  'review.host-model': '先由当前会话的模型复核',
  'review.host-model.hint': '需确认的调用经复核放行后直接执行，否则询问你；被拦截的调用复核最多改为询问你。复核会消耗当前会话所用模型的用量。',
  'review.off': '不复核',
  'review.off.hint': '需确认的调用直接询问你，被拦截的调用直接拒绝。',
  'options.title': '授权选项',
  'options.hint': '判定模型按这三项设置判断，以下是模型训练时使用的固定选项。',
  'cross.title': '项目外的普通写入',
  'cross.allow': '允许',
  'cross.allow.hint': '在项目外创建或修改文件可以直接执行；大范围删除不在此列。',
  'cross.review': '先确认',
  'cross.review.hint': '在项目外的写入需要确认。',
  'database.title': '数据库重置',
  'database.confirm': '先确认',
  'database.confirm.hint': '删除库表、清空数据或不受限的数据写入需要确认。',
  'database.allow': '允许',
  'database.allow.hint': '允许这类数据库操作。不同环境的数据库请分别考虑。',
  'project.title': '重置当前项目',
  'project.confirm': '先确认',
  'project.confirm.hint': '删除或重置整个当前项目、改写其版本历史需要确认。',
  'project.allow': '允许',
  'project.allow.hint': '只允许针对当前项目；其他项目、上级目录与系统不在此列。',
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
  'status.decision.local': '{model}. The service starts on the first decision; when the model is not installed or cannot judge, governed calls ask you',
  'status.decision.cloud': 'OpenVulcan cloud is not available yet, so governed calls ask you. Choose the local model',
  'status.decision.recommended': 'Local model, the installed size this machine suits',
  'status.decision.size': 'Local model {size}',
  'status.auto': 'Auto permission preset',
  'status.auto.provided': 'Provided by Vulcan Decision; choose Auto in the permission picker to use it',
  'status.auto.held': 'Held by Auto review; see the conflict notice below',
  'status.auto.pending': 'Registering',
  'status.auto.standalone': 'Not used in standalone mode; every session is judged',
  'status.unknown': 'Loading…',
  'tone.ok': 'OK',
  'tone.warn': 'Attention',
  'tone.ask': 'Asking',
  'tone.off': 'Not used',

  'install.title': 'Install the local model',
  'install.body': 'Models are installed from a local directory for now; downloads are not available yet. Run this in a terminal to install one:',
  'install.status': 'Check the service and installed models:',
  'mode.title': 'How the guard is turned on',
  'mode.auto-preset': 'Auto preset',
  'mode.auto-preset.hint': 'Adds Auto to the permission picker and judges only sessions that choose it. That preset always has full access and no file sandbox.',
  'mode.standalone': 'Standalone',
  'mode.standalone.hint': 'Judges every session on top of the permission preset it chose, keeping that preset\'s file sandbox.',
  'backend.title': 'Decision backend',
  'backend.cloud': 'OpenVulcan cloud',
  'backend.cloud.hint': 'Not available yet. Tool calls will be sent to OpenVulcan to be judged, with an OpenVulcan sign-in.',
  'backend.local': 'Local model',
  'backend.local.hint': 'Runs the vulcan-decision-shell model on this machine, so tool calls never leave it.',
  'model.title': 'Model size',
  'model.recommended': 'Recommended for this machine',
  'model.hint': 'Larger sizes judge more accurately and use more memory and time. The chosen size must be installed.',
  'review.title': 'Calls the model did not allow',
  'review.host-model': 'Review with the session\'s model first',
  'review.host-model.hint': 'A call that needs confirmation runs when the review allows it, otherwise you are asked; a blocked call can at most be turned into a question. Reviews count toward the session model\'s usage.',
  'review.off': 'No review',
  'review.off.hint': 'Calls that need confirmation ask you; blocked calls are denied.',
  'options.title': 'Authorization options',
  'options.hint': 'The decision model judges with these three settings; they are the fixed options it was trained with.',
  'cross.title': 'Ordinary writes outside the project',
  'cross.allow': 'Allow',
  'cross.allow.hint': 'Creating or changing files outside the project runs directly; broad deletion is not covered.',
  'cross.review': 'Confirm first',
  'cross.review.hint': 'Writes outside the project need confirmation.',
  'database.title': 'Database resets',
  'database.confirm': 'Confirm first',
  'database.confirm.hint': 'Dropping tables, truncating data or unrestricted data writes need confirmation.',
  'database.allow': 'Allow',
  'database.allow.hint': 'These database operations are allowed. Consider each environment\'s database separately.',
  'project.title': 'Resetting the current project',
  'project.confirm': 'Confirm first',
  'project.confirm.hint': 'Deleting or resetting the whole current project, or rewriting its history, needs confirmation.',
  'project.allow': 'Allow',
  'project.allow.hint': 'Only for the current project; other projects, parent directories and the system are not covered.',
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
  readonly crossProjectWrites: 'allow' | 'review'
  readonly databaseReset: 'confirm' | 'allow'
  readonly projectReset: 'confirm' | 'allow'
}

type Field = keyof GuardSettings

/** Terminal commands shown for installing a model and checking the service. */
const INSTALL_COMMAND = 'npx @openvulcan/vulcan-decision model install <model directory> --size 0.2b'
const STATUS_COMMAND = 'npx @openvulcan/vulcan-decision status'

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
  command: {
    display: 'block', padding: '6px 8px', borderRadius: 6, fontSize: 12, lineHeight: '18px', overflowWrap: 'anywhere',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
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

  /**
   * What the page shows about decisions. Whether a model is installed is known only to the
   * service on this machine, which dsh offers no channel to read from here, so the row states the
   * saved choice and what happens when the model is missing.
   */
  function decisionStatus(value: GuardSettings | undefined, t: (key: Key) => string) {
    if (value === undefined) return { tone: 'quiet', text: t('status.unknown'), toneText: t('status.unknown') } as const
    if (value.backend === 'cloud') return { tone: 'warning', text: t('status.decision.cloud'), toneText: t('tone.ask') } as const
    const model = value.modelSize === undefined ? t('status.decision.recommended') : t('status.decision.size').replace('{size}', value.modelSize.toUpperCase())
    return { tone: 'success', text: t('status.decision.local').replace('{model}', model), toneText: t('tone.ok') } as const
  }

  function StatusSection({ t, value }: { t: (key: Key) => string; value: GuardSettings | undefined }) {
    const heldByReview = useSyncExternalStore(autoReview.subscribe, autoReview.getSnapshot)
    const listed = useSyncExternalStore(autoListed.subscribe, autoListed.getSnapshot)
    const auto = autoStatus(value?.mode, heldByReview, listed)
    const decision = decisionStatus(value, t)
    return (
      <section style={styles.section}>
        <h4 style={styles.heading}>{t('status.title')}</h4>
        <div style={styles.card}>
          <StatusRow label={t('status.decision')} tone={decision.tone} toneLabel={decision.toneText}>
            {decision.text}
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

  function ChoiceGroup<V extends string>({ title, values, current, disabled, unavailable = [], onChoose, t, prefix }: {
    title: string
    values: readonly V[]
    current: V
    disabled: boolean
    /** Values shown but not selectable yet. */
    unavailable?: readonly V[]
    onChoose: (value: V) => void
    t: (key: Key) => string
    prefix: 'mode' | 'backend' | 'review' | 'cross' | 'database' | 'project'
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
              disabled={disabled || unavailable.includes(value)}
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
        <StatusSection t={t} value={value} />
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
            <ChoiceGroup
              title={t('backend.title')}
              prefix="backend"
              values={['local', 'cloud'] as const}
              current={backend}
              disabled={disabled}
              unavailable={['cloud']}
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
                  <div style={{ ...styles.notice, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <strong style={{ fontWeight: 500 }}>{t('install.title')}</strong>
                    <span>{t('install.body')}</span>
                    <code style={styles.command}>{INSTALL_COMMAND}</code>
                    <span>{t('install.status')}</span>
                    <code style={styles.command}>{STATUS_COMMAND}</code>
                  </div>
                </div>
              )
              : null}
            <section style={styles.section}>
              <h4 style={styles.heading}>{t('options.title')}</h4>
              <p style={styles.hint}>{t('options.hint')}</p>
              <ChoiceGroup
                title={t('cross.title')}
                prefix="cross"
                values={['allow', 'review'] as const}
                current={current('crossProjectWrites') as GuardSettings['crossProjectWrites']}
                disabled={disabled}
                onChoose={(next) => { edit('crossProjectWrites', next) }}
                t={t}
              />
              <ChoiceGroup
                title={t('database.title')}
                prefix="database"
                values={['confirm', 'allow'] as const}
                current={current('databaseReset') as GuardSettings['databaseReset']}
                disabled={disabled}
                onChoose={(next) => { edit('databaseReset', next) }}
                t={t}
              />
              <ChoiceGroup
                title={t('project.title')}
                prefix="project"
                values={['confirm', 'allow'] as const}
                current={current('projectReset') as GuardSettings['projectReset']}
                disabled={disabled}
                onChoose={(next) => { edit('projectReset', next) }}
                t={t}
              />
            </section>
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
