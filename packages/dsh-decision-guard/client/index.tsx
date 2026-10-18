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

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { Button, SettingsForm, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  BundleInfo, ClientContext, ComposerProps, ConfigForm, ConfigOp, ConfigPageProps, DetailProps, ModelCatalog,
  LocalizedText, PendingApprovalFace, SessionSlotProps,
} from './dsh-client'

/** Must equal this package's name and its `cordis.patch.yml` row. */
const PACKAGE_NAME = '@openvulcan/dsh-decision-guard'
/** The Host entry id from `cordis.patch.yml`, which names this plugin's configuration namespace. */
const ENTRY_ID = 'vulcan-decision-guard'
/** DeepSeek Harness's experimental Auto review bundle. */
const AUTO_REVIEW_PACKAGE = '@deepseek-ai/dsh-experimental-auto-review'
/** dsh's Auto permission preset value. */
const AUTO_PRESET = 'auto'
const NAMESPACE = 'vulcan-decision-guard'

export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.pluginManager', 'remote.permissionPresets', 'remote.session', 'configForms']

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
  'install.body': '在终端查看本机显卡、可用的运行设备（CUDA、DirectML 或 CPU）与推荐的模型尺寸和格式：',
  'install.download': '下载并安装推荐的模型（下载地址发布后可用）：',
  'install.local': '或从本地目录安装：',
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
  'review.title': 'LLM 二次审核',
  'review.session': '当前会话的模型',
  'review.session.hint': '判定模型未放行的调用先交给会话正在使用的模型审核。审核会消耗该模型的用量。',
  'review.custom': '指定模型',
  'review.custom.hint': '由下方选择的模型审核，与会话所用模型无关。',
  'review.off': '关闭',
  'review.off.hint': '不做 LLM 审核：有人在场时需确认与被拦截的调用都询问你，无人值守时一律拒绝。',
  'review.flow': '判定模型放行的调用直接执行，不经过 LLM。LLM 放行即执行；判定为「绝对禁止」时直接拒绝，不询问你；其他结论在有人时询问你，无人值守时拒绝。AI 可以先用 explain_tool_call 工具说明下一次调用的目的，说明会交给 LLM 并显示在确认框中。',
  'review.provider': '提供方',
  'review.model': '模型',
  'review.pick': '请选择',
  'review.catalogFailed': '无法读取模型列表。',
  'review.missing': '尚未选择审核模型，审核会失败并按失败处理。',
  'override.title': '允许 LLM 推翻拦截',
  'override.hint': '开启后，判定模型拦截（block）的调用也交给 LLM 审核，LLM 放行即执行。关闭时被拦截的调用不经 LLM：有人时询问你（默认选中拒绝），无人值守时拒绝。',
  'rules.title': 'LLM 审核规则',
  'rules.hint': '用自然语言描述，原样交给 LLM。优先级：绝对禁止 > 禁止 > 允许 > LLM 自行判断。规则只作用于判定模型未放行的调用；判定模型已放行的调用不会经过 LLM。',
  'rules.allow': '允许',
  'rules.allow.placeholder': '例如：运行项目内的测试与构建命令。',
  'rules.deny': '禁止',
  'rules.deny.placeholder': '例如：推送到远程仓库。有人时询问你并默认选中拒绝。',
  'rules.forbid': '绝对禁止',
  'rules.forbid.placeholder': '例如：删除或改写生产数据库。直接拒绝，不询问你。',
  'ask.title': '确认框',
  'ask.timeout': '倒计时自动拒绝',
  'ask.timeout.hint': '人不在电脑前又忘了打开无人值守时，确认框不会一直卡住：倒计时结束仍未选择就拒绝此次调用。关闭时确认框一直等待你。',
  'ask.seconds': '秒',
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

  'prompt.strip': 'Vulcan Decision 等待你确认',
  'prompt.stage.review': '需确认',
  'prompt.stage.block': '已拦截',
  'prompt.stage.unjudged': '无法判定',
  'prompt.review.review': 'LLM：交由你决定',
  'prompt.review.deny': 'LLM：未放行',
  'prompt.review.error': 'LLM 审核失败',
  'prompt.reason': 'LLM 理由',
  'prompt.intent': 'AI 说明的目的',
  'prompt.call': '调用 {tool}',
  'prompt.countdown': '{seconds} 秒后自动拒绝',
  'prompt.expired': '正在拒绝…',
  'prompt.allow': '允许一次',
  'prompt.reject': '拒绝',

  'unattended.label': '无人值守',
  'unattended.hint': '此会话无人值守：Vulcan Decision 不弹确认框，LLM 只在放行与拒绝之间选择，未放行的调用直接拒绝。',
  'unattended.failed': '切换失败',
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
  'install.body': 'Check the graphics cards of this machine, the usable devices (CUDA, DirectML or CPU) and the recommended model size and format in a terminal:',
  'install.download': 'Download and install the recommended model (once its address is published):',
  'install.local': 'Or install one from a local directory:',
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
  'review.title': 'LLM review',
  'review.session': 'The session\'s model',
  'review.session.hint': 'Calls the decision model did not allow are first reviewed by the model the session uses. Reviews count toward that model\'s usage.',
  'review.custom': 'A chosen model',
  'review.custom.hint': 'The model chosen below reviews, whatever the session uses.',
  'review.off': 'Off',
  'review.off.hint': 'No LLM review: when someone is there, calls that need confirmation and blocked calls ask you; unattended sessions deny them.',
  'review.flow': 'Calls the decision model allows run without the LLM. An LLM allow runs the call; "forbid" denies it without asking you; any other answer asks you when someone is there and denies the call when unattended. The AI can explain the purpose of its next call with the explain_tool_call tool first; the explanation goes to the LLM and appears in the prompt.',
  'review.provider': 'Provider',
  'review.model': 'Model',
  'review.pick': 'Choose',
  'review.catalogFailed': 'The model list cannot be read.',
  'review.missing': 'No review model is chosen, so reviews fail and are treated as failures.',
  'override.title': 'Let the LLM overturn blocks',
  'override.hint': 'When on, calls the decision model blocks also go to the LLM review, and an LLM allow runs them. When off, blocked calls skip the LLM: they ask you (with Reject focused) when someone is there and are denied when unattended.',
  'rules.title': 'LLM review rules',
  'rules.hint': 'Plain language, given to the LLM as written. Precedence: forbid > deny > allow > the LLM\'s own judgment. Rules only apply to calls the decision model did not allow; calls it allows never reach the LLM.',
  'rules.allow': 'Allow',
  'rules.allow.placeholder': 'For example: running the project\'s tests and builds.',
  'rules.deny': 'Deny',
  'rules.deny.placeholder': 'For example: pushing to a remote. You are asked, with Reject focused.',
  'rules.forbid': 'Forbid',
  'rules.forbid.placeholder': 'For example: deleting or rewriting the production database. Denied without asking you.',
  'ask.title': 'Approval prompt',
  'ask.timeout': 'Reject after a countdown',
  'ask.timeout.hint': 'When you are away from the machine but forgot to turn on unattended mode, the prompt does not hold the session: the call is rejected once the countdown ends without an answer. When off, the prompt waits for you.',
  'ask.seconds': 'seconds',
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

  'prompt.strip': 'Vulcan Decision is waiting for you',
  'prompt.stage.review': 'Needs confirmation',
  'prompt.stage.block': 'Blocked',
  'prompt.stage.unjudged': 'Not judged',
  'prompt.review.review': 'LLM: up to you',
  'prompt.review.deny': 'LLM: not allowed',
  'prompt.review.error': 'LLM review failed',
  'prompt.reason': 'LLM reason',
  'prompt.intent': 'Purpose stated by the AI',
  'prompt.call': 'Call to {tool}',
  'prompt.countdown': 'Rejects in {seconds} s',
  'prompt.expired': 'Rejecting…',
  'prompt.allow': 'Allow once',
  'prompt.reject': 'Reject',

  'unattended.label': 'Unattended',
  'unattended.hint': 'Nobody attends this session: Vulcan Decision shows no prompts, the LLM only allows or denies, and calls it does not allow are denied.',
  'unattended.failed': 'Could not switch',
}

/** Configuration values as the Host's schema resolves them; mirrors `Config` in `src/index.ts`. */
interface GuardSettings {
  readonly mode: 'auto-preset' | 'standalone'
  readonly backend: 'cloud' | 'local'
  readonly modelSize?: '0.2b' | '0.4b' | '0.6b' | undefined
  readonly review: 'session' | 'custom' | 'off'
  readonly reviewProvider?: string | undefined
  readonly reviewModel?: string | undefined
  readonly allowRules: string
  readonly denyRules: string
  readonly forbidRules: string
  readonly llmOverridesBlock: boolean
  readonly askTimeout: number
  readonly crossProjectWrites: 'allow' | 'review'
  readonly databaseReset: 'confirm' | 'allow'
  readonly projectReset: 'confirm' | 'allow'
}

type Field = keyof GuardSettings

/** A staged field value; `undefined` clears the field so it falls back to its default. */
type Staged = string | number | boolean | undefined

/** Countdown offered when the switch is turned on; the Host accepts 1 to {@link MAX_ASK_TIMEOUT}. */
const DEFAULT_ASK_TIMEOUT = 60
/** Mirrors `MAX_ASK_TIMEOUT` in `src/index.ts`. */
const MAX_ASK_TIMEOUT = 3600

/** Mirrors `PROMPT_KEY` and `PromptPayload` in `src/index.ts`. */
const PROMPT_KEY = 'x-vulcan-decision'
interface PromptPayload {
  readonly v: 1
  readonly stage: 'review' | 'block' | 'unjudged'
  readonly review?: 'review' | 'deny' | 'error'
  readonly reviewReason?: string
  readonly focus: 'allow' | 'reject'
  readonly intent?: string
  readonly preview: string
  readonly timeoutMs?: number
}

/** Mirrors `PROJECTION_KEY`, `GuardSessionView` and `UNATTENDED_COMMAND` in `src/unattended.ts`. */
const PROJECTION_KEY = 'vulcanDecision'
interface GuardSessionView {
  readonly unattended: boolean
}
const UNATTENDED_COMMAND = 'vulcan-unattended'

/** One of this plugin's approval prompts, as offered to the composer chain. */
interface GuardApproval {
  readonly pending: PendingApprovalFace
  readonly payload: PromptPayload
}

/** Recognize this plugin's prompts by their payload; other approvals stay with dsh's own card. */
function guardApprovalOf(interaction: unknown): GuardApproval | null {
  if (typeof interaction !== 'object' || interaction === null) return null
  const pending = interaction as Partial<PendingApprovalFace>
  if (pending.kind !== 'approval' || typeof pending.answer !== 'function') return null
  const raw = pending.displayReason?.[PROMPT_KEY]
  if (typeof raw !== 'string') return null
  try {
    const payload = JSON.parse(raw) as PromptPayload
    return payload.v === 1 ? { pending: pending as PendingApprovalFace, payload } : null
  } catch {
    return null
  }
}

/** Terminal commands shown for choosing, installing a model and checking the service. */
const HARDWARE_COMMAND = 'npx @openvulcan/vulcan-decision hardware'
const DOWNLOAD_COMMAND = 'npx @openvulcan/vulcan-decision model download'
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
  textarea: {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, fontSize: 13, lineHeight: '20px',
    resize: 'vertical', fontFamily: 'inherit',
  },
  toggle: {
    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
  },
  promptRoot: { display: 'flex', flexDirection: 'column', padding: '0 0 8px' },
  promptCard: {
    display: 'flex', flexDirection: 'column', borderRadius: 16, overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
  },
  promptStrip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 14px', fontSize: 12,
    lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
  },
  promptBody: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', maxHeight: 320, overflow: 'auto' },
  promptActions: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 14px 12px',
  },
  notice: {
    margin: 0, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
  },
} as const satisfies Record<string, import('react').CSSProperties>

/** What the unattended checkbox registration injects. */
interface UnattendedInjected {
  /** Switch the session through the Host command; rejects when the Host does not accept it. */
  readonly toggle: (unattended: boolean) => Promise<void>
}

/** Install the settings page, the conflict notice, the approval card and the unattended checkbox. */
export function apply(ctx: ClientContext): void {
  const autoReview = new HostWatch<boolean>(async () => {
    const result = await ctx.remote.pluginManager.listBundles()
    return result.ok ? autoReviewEnabled(result.value) : undefined
  })
  const autoListed = new HostWatch<boolean>(async () => {
    const result = await ctx.remote.permissionPresets.catalog()
    return result.ok ? result.value.options.some(option => option.value === AUTO_PRESET) : undefined
  })
  const modelCatalog = new HostWatch<ModelCatalog>(async () => {
    const result = await ctx.remote.session.modelCatalog()
    return result.ok ? result.value : undefined
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
      modelCatalog.close()
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

  /** Provider and model pickers for a chosen review model, from the Host's model catalog. */
  function ReviewModelPicker({ t, provider, model, disabled, onChange }: {
    t: (key: Key) => string
    provider: string
    model: string
    disabled: boolean
    onChange: (provider: string, model: string) => void
  }) {
    const catalog = useSyncExternalStore(modelCatalog.subscribe, modelCatalog.getSnapshot)
    const providerId = useId()
    const modelId = useId()
    useEffect(() => { modelCatalog.refresh() }, [])
    if (catalog === undefined) return <p style={styles.hint}>{t('review.catalogFailed')}</p>
    const groups = catalog.groups
    const group = groups.find(item => item.id === provider)
    // A saved choice the catalog no longer lists stays visible instead of silently changing.
    const providers = group === undefined && provider !== '' ? [{ id: provider, name: provider, models: [] }, ...groups] : groups
    const models = group?.models ?? []
    const modelList = models.some(item => item.id === model) || model === '' ? models : [{ id: model, name: model }, ...models]
    return (
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...styles.section, gap: 6 }}>
          <label htmlFor={providerId} style={styles.hint}>{t('review.provider')}</label>
          <select
            id={providerId}
            style={styles.select}
            value={provider}
            disabled={disabled}
            onChange={(event) => { onChange(event.target.value, '') }}
          >
            <option value="">{t('review.pick')}</option>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div style={{ ...styles.section, gap: 6 }}>
          <label htmlFor={modelId} style={styles.hint}>{t('review.model')}</label>
          <select
            id={modelId}
            style={styles.select}
            value={model}
            disabled={disabled || provider === ''}
            onChange={(event) => { onChange(provider, event.target.value) }}
          >
            <option value="">{t('review.pick')}</option>
            {modelList.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
      </div>
    )
  }

  function RuleField({ id, title, placeholder, value, disabled, onChange }: {
    id: string
    title: string
    placeholder: string
    value: string
    disabled: boolean
    onChange: (value: string) => void
  }) {
    return (
      <div style={{ ...styles.section, gap: 6 }}>
        <label htmlFor={id} style={styles.optionTitle}>{title}</label>
        <textarea
          id={id}
          rows={3}
          style={styles.textarea}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => { onChange(event.target.value) }}
        />
      </div>
    )
  }

  function SettingsPage({ view, t: translate }: ConfigPageProps) {
    const t = translate as (key: Key) => string
    const accepted = useSyncExternalStore(subscribeForm, formSnapshot)
    const [draft, setDraft] = useState<Partial<Record<Field, Staged>>>({})
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)
    const modelId = useId()
    const ruleId = useId()
    const timeoutId = useId()
    if (view === 'summary') return t('summary')

    const value = accepted.value
    // A staged value wins over the accepted one.
    const current = (field: Field): Staged => (field in draft ? draft[field] : value?.[field])
    const text = (field: Field): string => {
      const staged = current(field)
      return typeof staged === 'string' ? staged : ''
    }
    const edit = (changes: Partial<Record<Field, Staged>>): void => {
      setFailed(false)
      setDraft((staged) => {
        const next = { ...staged }
        for (const [field, change] of Object.entries(changes) as [Field, Staged][]) {
          if (Object.is(value?.[field], change)) delete next[field]
          else next[field] = change
        }
        return next
      })
    }
    const save = (): void => {
      const ops: ConfigOp[] = (Object.entries(draft) as [Field, Staged][]).map(([field, next]) => (
        next === undefined ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: next }
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
    const review = (current('review') ?? 'session') as GuardSettings['review']
    const askTimeout = typeof current('askTimeout') === 'number' ? current('askTimeout') as number : 0
    const timeoutInvalid = askTimeout !== 0 && (!Number.isInteger(askTimeout) || askTimeout < 1 || askTimeout > MAX_ASK_TIMEOUT)

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
            invalid: timeoutInvalid,
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
              onChoose={(next) => { edit({ mode: next }) }}
              t={t}
            />
            <ChoiceGroup
              title={t('backend.title')}
              prefix="backend"
              values={['local', 'cloud'] as const}
              current={backend}
              disabled={disabled}
              unavailable={['cloud']}
              onChoose={(next) => { edit({ backend: next }) }}
              t={t}
            />
            {backend === 'local'
              ? (
                <div style={styles.section}>
                  <label htmlFor={modelId} style={styles.heading}>{t('model.title')}</label>
                  <select
                    id={modelId}
                    style={styles.select}
                    value={text('modelSize')}
                    disabled={disabled}
                    onChange={(event) => { edit({ modelSize: event.target.value === '' ? undefined : event.target.value }) }}
                  >
                    {MODEL_SIZES.map(size => (
                      <option key={size} value={size}>{size === '' ? t('model.recommended') : size.toUpperCase()}</option>
                    ))}
                  </select>
                  <p style={styles.hint}>{t('model.hint')}</p>
                  <div style={{ ...styles.notice, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <strong style={{ fontWeight: 500 }}>{t('install.title')}</strong>
                    <span>{t('install.body')}</span>
                    <code style={styles.command}>{HARDWARE_COMMAND}</code>
                    <span>{t('install.download')}</span>
                    <code style={styles.command}>{DOWNLOAD_COMMAND}</code>
                    <span>{t('install.local')}</span>
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
                onChoose={(next) => { edit({ crossProjectWrites: next }) }}
                t={t}
              />
              <ChoiceGroup
                title={t('database.title')}
                prefix="database"
                values={['confirm', 'allow'] as const}
                current={current('databaseReset') as GuardSettings['databaseReset']}
                disabled={disabled}
                onChoose={(next) => { edit({ databaseReset: next }) }}
                t={t}
              />
              <ChoiceGroup
                title={t('project.title')}
                prefix="project"
                values={['confirm', 'allow'] as const}
                current={current('projectReset') as GuardSettings['projectReset']}
                disabled={disabled}
                onChoose={(next) => { edit({ projectReset: next }) }}
                t={t}
              />
            </section>
            <section style={styles.section}>
              <ChoiceGroup
                title={t('review.title')}
                prefix="review"
                values={['session', 'custom', 'off'] as const}
                current={review}
                disabled={disabled}
                onChoose={(next) => { edit({ review: next }) }}
                t={t}
              />
              <p style={styles.notice}>{t('review.flow')}</p>
              {review === 'custom'
                ? (
                  <>
                    <ReviewModelPicker
                      t={t}
                      provider={text('reviewProvider')}
                      model={text('reviewModel')}
                      disabled={disabled}
                      onChange={(provider, model) => {
                        edit({ reviewProvider: provider === '' ? undefined : provider, reviewModel: model === '' ? undefined : model })
                      }}
                    />
                    {text('reviewProvider') === '' || text('reviewModel') === ''
                      ? <p style={{ ...styles.hint, color: 'var(--dsw-alias-state-warn-label)' }}>{t('review.missing')}</p>
                      : null}
                  </>
                )
                : null}
            </section>
            {review === 'off'
              ? null
              : (
                <>
                  <section style={styles.section}>
                    <label style={{ ...styles.option, ...styles.card, flexDirection: 'row' }}>
                      <input
                        type="checkbox"
                        checked={current('llmOverridesBlock') === true}
                        disabled={disabled}
                        onChange={(event) => { edit({ llmOverridesBlock: event.target.checked }) }}
                        style={styles.radio}
                      />
                      <span>
                        <span style={styles.optionTitle}>{t('override.title')}</span>
                        <span style={styles.hint}>{t('override.hint')}</span>
                      </span>
                    </label>
                  </section>
                  <section style={styles.section}>
                    <h4 style={styles.heading}>{t('rules.title')}</h4>
                    <p style={styles.hint}>{t('rules.hint')}</p>
                    <RuleField
                      id={`${ruleId}-forbid`}
                      title={t('rules.forbid')}
                      placeholder={t('rules.forbid.placeholder')}
                      value={text('forbidRules')}
                      disabled={disabled}
                      onChange={(next) => { edit({ forbidRules: next }) }}
                    />
                    <RuleField
                      id={`${ruleId}-deny`}
                      title={t('rules.deny')}
                      placeholder={t('rules.deny.placeholder')}
                      value={text('denyRules')}
                      disabled={disabled}
                      onChange={(next) => { edit({ denyRules: next }) }}
                    />
                    <RuleField
                      id={`${ruleId}-allow`}
                      title={t('rules.allow')}
                      placeholder={t('rules.allow.placeholder')}
                      value={text('allowRules')}
                      disabled={disabled}
                      onChange={(next) => { edit({ allowRules: next }) }}
                    />
                  </section>
                </>
              )}
            <section style={styles.section}>
              <h4 style={styles.heading}>{t('ask.title')}</h4>
              <div style={{ ...styles.card, ...styles.option, cursor: 'default', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: disabled ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={askTimeout > 0}
                    disabled={disabled}
                    onChange={(event) => { edit({ askTimeout: event.target.checked ? DEFAULT_ASK_TIMEOUT : 0 }) }}
                    style={styles.radio}
                  />
                  <span>
                    <span style={styles.optionTitle}>{t('ask.timeout')}</span>
                    <span style={styles.hint}>{t('ask.timeout.hint')}</span>
                  </span>
                </label>
                {askTimeout > 0 || timeoutInvalid
                  ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 26 }}>
                      <input
                        id={timeoutId}
                        type="number"
                        min={1}
                        max={MAX_ASK_TIMEOUT}
                        step={1}
                        value={askTimeout}
                        disabled={disabled}
                        aria-invalid={timeoutInvalid}
                        onChange={(event) => { edit({ askTimeout: event.target.value === '' ? 0 : Number(event.target.value) }) }}
                        style={{ ...styles.select, minWidth: 0, width: 96 }}
                      />
                      <label htmlFor={timeoutId} style={styles.hint}>{t('ask.seconds')}</label>
                    </span>
                  )
                  : null}
              </div>
            </section>
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

  /** Seconds left until the Host rejects an unanswered prompt, counted from when it appeared. */
  function useCountdown(timeoutMs: number | undefined): number | undefined {
    const [now, setNow] = useState(() => Date.now())
    const [start] = useState(() => Date.now())
    useEffect(() => {
      if (timeoutMs === undefined) return undefined
      const timer = setInterval(() => { setNow(Date.now()) }, 250)
      return () => { clearInterval(timer) }
    }, [timeoutMs])
    return timeoutMs === undefined ? undefined : Math.max(0, Math.ceil((start + timeoutMs - now) / 1000))
  }

  function ApprovalCard({ matched, t: translate, resolveText }: ComposerProps<GuardApproval>) {
    return <ApprovalFlow key={matched.pending.key} approval={matched} t={translate as (key: Key) => string} resolveText={resolveText} />
  }

  function ApprovalFlow({ approval, t, resolveText }: {
    approval: GuardApproval
    t: (key: Key) => string
    resolveText: ComposerProps<GuardApproval>['resolveText']
  }) {
    const { pending, payload } = approval
    const [answered, setAnswered] = useState(false)
    const allowRef = useRef<HTMLButtonElement>(null)
    const rejectRef = useRef<HTMLButtonElement>(null)
    const left = useCountdown(payload.timeoutMs)
    useEffect(() => {
      (payload.focus === 'allow' ? allowRef : rejectRef).current?.focus()
    }, [payload.focus])
    const answer = (outcome: 'allowed-once' | 'rejected'): void => {
      if (answered || !pending.answerable) return
      setAnswered(true)
      pending.answer(outcome).catch(() => {
        if (pending.answerable) setAnswered(false)
      })
    }
    const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      answer('rejected')
    }
    const headline = pending.displayReason === undefined ? pending.reason ?? '' : resolveText(pending.displayReason)
    const tone: TagTone = payload.stage === 'review' ? 'warning' : 'danger'
    return (
      <div style={styles.promptRoot} aria-busy={answered} onKeyDown={keydown}>
        <div style={styles.promptCard}>
          <div style={styles.promptStrip}>
            <span>{t('prompt.strip')}</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag tone={tone}>{t(`prompt.stage.${payload.stage}` as Key)}</Tag>
              {payload.review === undefined ? null : <Tag tone="neutral">{t(`prompt.review.${payload.review}` as Key)}</Tag>}
            </span>
          </div>
          <div style={styles.promptBody} role="group" aria-label={t('prompt.strip')}>
            <div style={styles.optionTitle}>{headline}</div>
            <div style={styles.hint}>{t('prompt.call').replace('{tool}', pending.toolName)}</div>
            <code style={{ ...styles.command, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{payload.preview}</code>
            {payload.reviewReason === undefined
              ? null
              : <p style={styles.hint}><strong style={{ display: 'block', fontWeight: 500 }}>{t('prompt.reason')}</strong>{payload.reviewReason}</p>}
            {payload.intent === undefined
              ? null
              : <p style={styles.hint}><strong style={{ display: 'block', fontWeight: 500 }}>{t('prompt.intent')}</strong>{payload.intent}</p>}
          </div>
          <div style={styles.promptActions}>
            {left === undefined
              ? <span />
              : (
                <span role="timer" style={{ ...styles.hint, color: 'var(--dsw-alias-state-warn-label)' }}>
                  {left > 0 ? t('prompt.countdown').replace('{seconds}', String(left)) : t('prompt.expired')}
                </span>
              )}
            <span style={{ display: 'flex', gap: 8 }}>
              <Button ref={rejectRef} variant={payload.focus === 'reject' ? 'primary' : 'outline'} disabled={answered} onClick={() => { answer('rejected') }}>
                {t('prompt.reject')}
              </Button>
              <Button ref={allowRef} variant={payload.focus === 'allow' ? 'primary' : 'outline'} disabled={answered} onClick={() => { answer('allowed-once') }}>
                {t('prompt.allow')}
              </Button>
            </span>
          </div>
        </div>
      </div>
    )
  }

  /** The composer checkbox that marks a governed session unattended. */
  function UnattendedToggle({ useProjection, t: translate, toggle }: SessionSlotProps & UnattendedInjected) {
    const t = translate as (key: Key) => string
    const view = useProjection(PROJECTION_KEY) as GuardSessionView | undefined
    const permissions = useProjection('permissions') as { readonly currentValue?: string } | undefined
    const settings = useSyncExternalStore(subscribeForm, formSnapshot)
    const [pending, setPending] = useState<boolean | undefined>(undefined)
    const [failed, setFailed] = useState(false)
    if (view === undefined || settings.value === undefined) return null
    const governed = settings.value.mode === 'standalone' || permissions?.currentValue === AUTO_PRESET
    if (!governed) return null
    const checked = pending ?? view.unattended
    const change = (next: boolean): void => {
      setPending(next)
      setFailed(false)
      toggle(next).then(() => { setPending(undefined) }, () => {
        setPending(undefined)
        setFailed(true)
      })
    }
    return (
      <label title={failed ? t('unattended.failed') : t('unattended.hint')} style={styles.toggle}>
        <input
          type="checkbox"
          aria-label={t('unattended.label')}
          checked={checked}
          disabled={pending !== undefined}
          onChange={(event) => { change(event.target.checked) }}
          style={styles.radio}
        />
        <span style={failed ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined}>{t('unattended.label')}</span>
      </label>
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
  // Ahead of dsh's own approval card (priority 1), and only for this plugin's prompts.
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 0,
    locale: NAMESPACE,
    select: ({ pendingInteraction }) => guardApprovalOf(pendingInteraction),
    inject: () => ({ resolveText: (text: LocalizedText) => ctx.locale.resolveText(text) }),
  }, ApprovalCard))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'vulcan-decision-guard-unattended',
    locale: NAMESPACE,
    inject: (sessionId: string): UnattendedInjected => ({
      toggle: async (unattended) => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error('this session is not materialized yet')
        const result = await session.command(`/${UNATTENDED_COMMAND} ${unattended ? 'on' : 'off'}`)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error(`the Host offers no /${UNATTENDED_COMMAND} command`)
      },
    }),
  }, UnattendedToggle))
}
