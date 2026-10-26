/**
 * Browser half of the dsh plugin, shown on the Plugins page:
 *
 * - The plugin's settings page: live status, how the guard is turned on, the decision backend
 *   with the OpenVulcan account, cloud endpoints, runtime packs and local models, and review of
 *   uncertain calls.
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

  'status.decision.local': '本机：{pack} 运行 {model}。模型在首次判定时加载；无法判定时，受管控的调用会询问你',
  'status.decision.localMissing': '本机：尚未选择运行包与模型，受管控的调用会询问你',
  'status.decision.cloud': 'OpenVulcan 云端：{model}',
  'status.decision.signedOut': 'OpenVulcan 云端：尚未登录，受管控的调用会询问你',
  'backend.cloud.hint': '默认方式，本机不安装任何运行库。工具调用的内容发送到 OpenVulcan 判定，需要登录 OpenVulcan 账号。',
  'backend.local.hint': '在本机运行 vulcan-decision-shell 模型，工具调用的内容不出本机。需先在下方安装运行包与模型。',
  'panel.unavailable': '无法读取本机状态：dsh 没有向本页面提供插件接口。',
  'account.title': 'OpenVulcan 账号',
  'account.signedOut': '未登录。登录后即可使用云端判定。',
  'account.signedIn': '已登录{site}，凭据有效期至 {expires}。',
  'account.reauth': '凭据轮换中断，需要重新登录。',
  'account.site': '站点',
  'account.site.cn': '中国站（openvulcan.cn）',
  'account.site.global': '国际站（openvulcan.com）',
  'account.signIn': '登录',
  'account.waiting': '已打开 OpenVulcan 授权页，批准后自动完成登录。',
  'account.openAgain': '打开授权页',
  'account.cancel': '取消',
  'account.signOut': '退出登录',
  'account.failed': '登录失败：',
  'account.stored': '凭据保存在 dsh 的凭据存储中，退出登录会同时注销本设备。',
  'cloud.model': '云端模型',
  'cloud.endpoints': '判定节点',
  'cloud.probe': '测速',
  'cloud.probing': '测速中…',
  'cloud.none': '尚未测速。登录后点「测速」列出可用节点。',
  'cloud.lock': '使用的节点',
  'cloud.auto': '自动选择最快的节点',
  'cloud.lock.hint': '固定节点后始终使用它，失败时也不切换到其他节点。',
  'cloud.rtt': '往返 {ms} ms',
  'cloud.compute': '计算 {ms} ms',
  'cloud.selected': '使用中',
  'cloud.excluded': '不可用',
  'hw.title': '本机硬件与建议',
  'hw.gpu': '{name} · {arch} · 计算能力 {cc} · 驱动 {driver}',
  'hw.fp16.tensor-cores': 'FP16 由张量核心加速',
  'hw.fp16.native': 'FP16 原生支持，较慢',
  'hw.fp16.slow': 'FP16 很慢，只适合 FP32',
  'hw.noGpu': '未发现可用的 NVIDIA 显卡。',
  'hw.npu': '发现 NPU：{name}。NPU 运行包等待对应的 ONNX 模型发布，目前还不能安装。',
  'hw.rec.cuda': '建议本机运行：PyTorch 模型安装 {torch}，ONNX 模型安装 {onnx}。',
  'hw.rec.cpu_only': '建议使用云端。也可以安装 {torch} 在 CPU 上运行，判定较慢。',
  'hw.rec.driver_update': '显卡支持 CUDA，但驱动低于运行包所需的版本。请自行从 NVIDIA 更新驱动（本插件不安装驱动），在此之前建议使用云端。',
  'hw.rec.gpu_too_old': '显卡计算能力低于 7.5（RTX 20 系列之前），现成的 CUDA 运行库不支持它，建议使用云端。',
  'packs.title': '运行包',
  'packs.hint': '运行包是预编译的 Python 运行时与官方 wheel，逐个按锁定的 SHA-256 校验后安装到 {home}。不编译任何东西，也不安装驱动。',
  'packs.source': '下载源',
  'packs.source.official': '官方（python-build-standalone、PyPI、PyTorch）',
  'packs.source.cn': '国内镜像（npmmirror、阿里云）',
  'packs.install': '安装',
  'packs.update': '更新',
  'packs.remove': '删除',
  'packs.installed': '已安装',
  'packs.outdated': '有更新',
  'packs.fit.ok': '可用',
  'packs.fit.no_build': '本平台无构建',
  'packs.fit.no_nvidia_gpu': '需要 NVIDIA 显卡',
  'packs.fit.gpu_too_old': '显卡过旧',
  'packs.fit.driver_too_old': '驱动需 ≥ {driver}',
  'packs.planned': '规划中：{id}（{accelerator}）',
  'job.download': '下载中 {percent}%',
  'job.unpack': '解压中…',
  'job.install': '安装中…',
  'job.probe': '检查运行时…',
  'job.verify': '校验中 {percent}%',
  'job.done': '已完成',
  'job.failed': '失败：{error}',
  'job.cancelled': '已取消',
  'job.cancel': '取消',
  'models.title': '本机模型',
  'models.none': '尚未安装模型。',
  'models.remove': '删除',
  'models.download': '下载',
  'models.notPublished': '下载地址尚未发布',
  'models.source.huggingface': 'Hugging Face',
  'models.source.modelscope-intl': '魔搭国际站',
  'models.source.modelscope-cn': '魔搭国内站',
  'models.dir': '从本地目录安装',
  'models.dir.placeholder': '模型包目录：PyTorch 发布仓库或 ONNX 交付目录',
  'models.dir.install': '安装',
  'local.pack': '使用的运行包',
  'local.model': '使用的模型',
  'local.pick': '请选择',
  'local.mismatch': '所选模型需要 {backend} 运行包。',
  'test.title': '试判定',
  'test.hint': '用已保存的设置判定一个示例调用。',
  'test.safe': '查看仓库状态（git status）',
  'test.risky': '强制推送到远程（git push --force）',
  'test.run': '判定',
  'test.running': '判定中…',
  'test.result': '{decision}，用时 {ms} ms（{backend} · {via}）',
  'test.failed': '判定失败：',

  'mode.title': '接入方式',
  'mode.auto-preset': '自动预设',
  'mode.auto-preset.hint': '在权限选择器中提供「自动审查」，只判定选择它的会话。该预设固定为完全权限，不使用文件沙箱。',
  'mode.standalone': '独立开关',
  'mode.standalone.hint': '判定所有会话，叠加在会话所选的权限预设之上，保留其文件沙箱。',
  'backend.title': '判定后端',
  'backend.cloud': 'OpenVulcan 云端',
  'backend.local': '本机模型',
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

  'status.decision.local': 'Local: {model} on {pack}. The model loads on the first decision; when it cannot judge, governed calls ask you',
  'status.decision.localMissing': 'Local: no runtime pack and model are chosen, so governed calls ask you',
  'status.decision.cloud': 'OpenVulcan cloud: {model}',
  'status.decision.signedOut': 'OpenVulcan cloud: not signed in, so governed calls ask you',
  'backend.cloud.hint': 'The default; nothing is installed on this machine. Tool calls are sent to OpenVulcan to be judged, with an OpenVulcan sign-in.',
  'backend.local.hint': 'Runs a vulcan-decision-shell model on this machine, so tool calls never leave it. Install a runtime pack and a model below first.',
  'panel.unavailable': 'Cannot read this machine\'s state: dsh offers this page no plugin routes.',
  'account.title': 'OpenVulcan account',
  'account.signedOut': 'Not signed in. Sign in to use cloud decisions.',
  'account.signedIn': 'Signed in to {site}, valid until {expires}.',
  'account.reauth': 'A credential rotation was interrupted; sign in again.',
  'account.site': 'Site',
  'account.site.cn': 'China (openvulcan.cn)',
  'account.site.global': 'Global (openvulcan.com)',
  'account.signIn': 'Sign in',
  'account.waiting': 'The OpenVulcan approval page is open; signing in finishes once you approve.',
  'account.openAgain': 'Open the approval page',
  'account.cancel': 'Cancel',
  'account.signOut': 'Sign out',
  'account.failed': 'Sign-in failed: ',
  'account.stored': 'The credential is kept in dsh\'s credential store; signing out also revokes this device.',
  'cloud.model': 'Cloud model',
  'cloud.endpoints': 'Endpoints',
  'cloud.probe': 'Measure',
  'cloud.probing': 'Measuring…',
  'cloud.none': 'Not measured yet. Sign in, then Measure to list the endpoints.',
  'cloud.lock': 'Endpoint to use',
  'cloud.auto': 'The fastest measured endpoint',
  'cloud.lock.hint': 'A chosen endpoint is always used and never replaced, even when it fails.',
  'cloud.rtt': 'round trip {ms} ms',
  'cloud.compute': 'compute {ms} ms',
  'cloud.selected': 'In use',
  'cloud.excluded': 'Unavailable',
  'hw.title': 'This machine and the recommendation',
  'hw.gpu': '{name} · {arch} · compute capability {cc} · driver {driver}',
  'hw.fp16.tensor-cores': 'FP16 on tensor cores',
  'hw.fp16.native': 'native FP16, slower',
  'hw.fp16.slow': 'slow FP16, FP32 only',
  'hw.noGpu': 'No usable NVIDIA card was found.',
  'hw.npu': 'NPU found: {name}. NPU runtime packs wait for an ONNX model exported for them and cannot be installed yet.',
  'hw.rec.cuda': 'Run locally: install {torch} for PyTorch models and {onnx} for ONNX models.',
  'hw.rec.cpu_only': 'Use the cloud. {torch} can also run models on the CPU, more slowly.',
  'hw.rec.driver_update': 'The card supports CUDA but its driver is older than the packs need. Update it from NVIDIA yourself (this plugin installs no drivers); until then, use the cloud.',
  'hw.rec.gpu_too_old': 'The card\'s compute capability is below 7.5 (older than RTX 20), which the prebuilt CUDA runtimes do not support; use the cloud.',
  'packs.title': 'Runtime packs',
  'packs.hint': 'A runtime pack is a prebuilt Python runtime with official wheels, each checked against its locked SHA-256 and installed under {home}. Nothing is compiled and no driver is installed.',
  'packs.source': 'Download from',
  'packs.source.official': 'Official hosts (python-build-standalone, PyPI, PyTorch)',
  'packs.source.cn': 'Mirrors in China (npmmirror, Aliyun)',
  'packs.install': 'Install',
  'packs.update': 'Update',
  'packs.remove': 'Remove',
  'packs.installed': 'Installed',
  'packs.outdated': 'Update available',
  'packs.fit.ok': 'Usable',
  'packs.fit.no_build': 'No build for this platform',
  'packs.fit.no_nvidia_gpu': 'Needs an NVIDIA card',
  'packs.fit.gpu_too_old': 'Card too old',
  'packs.fit.driver_too_old': 'Needs driver {driver} or newer',
  'packs.planned': 'Planned: {id} ({accelerator})',
  'job.download': 'Downloading {percent}%',
  'job.unpack': 'Unpacking…',
  'job.install': 'Installing…',
  'job.probe': 'Checking the runtime…',
  'job.verify': 'Verifying {percent}%',
  'job.done': 'Done',
  'job.failed': 'Failed: {error}',
  'job.cancelled': 'Cancelled',
  'job.cancel': 'Cancel',
  'models.title': 'Local models',
  'models.none': 'No model is installed.',
  'models.remove': 'Remove',
  'models.download': 'Download',
  'models.notPublished': 'Not published yet',
  'models.source.huggingface': 'Hugging Face',
  'models.source.modelscope-intl': 'ModelScope (international)',
  'models.source.modelscope-cn': 'ModelScope (China)',
  'models.dir': 'Install from a local directory',
  'models.dir.placeholder': 'Package directory: a PyTorch release repository or an ONNX delivery',
  'models.dir.install': 'Install',
  'local.pack': 'Runtime pack to use',
  'local.model': 'Model to use',
  'local.pick': 'Choose',
  'local.mismatch': 'The chosen model needs a {backend} runtime pack.',
  'test.title': 'Try a decision',
  'test.hint': 'Judges a sample call with the saved settings.',
  'test.safe': 'Show the repository status (git status)',
  'test.risky': 'Force-push to the remote (git push --force)',
  'test.run': 'Judge',
  'test.running': 'Judging…',
  'test.result': '{decision} in {ms} ms ({backend} · {via})',
  'test.failed': 'Decision failed: ',

  'mode.title': 'How the guard is turned on',
  'mode.auto-preset': 'Auto preset',
  'mode.auto-preset.hint': 'Adds Auto to the permission picker and judges only sessions that choose it. That preset always has full access and no file sandbox.',
  'mode.standalone': 'Standalone',
  'mode.standalone.hint': 'Judges every session on top of the permission preset it chose, keeping that preset\'s file sandbox.',
  'backend.title': 'Decision backend',
  'backend.cloud': 'OpenVulcan cloud',
  'backend.local': 'Local model',
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
  readonly cloudModel: string
  readonly cloudEndpoint?: string | undefined
  readonly localPack?: string | undefined
  readonly localModel?: string | undefined
  readonly downloadSource: 'official' | 'cn'
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

/** Browser-relative form of `ROUTE_PREFIX` in `src/panel.ts`. */
const ROUTE_BASE = 'api/vulcan-decision/'

/** What `Panel.state()` in `src/panel.ts` answers. */
interface PanelState {
  readonly account: { readonly signedIn: boolean; readonly site?: 'cn' | 'global'; readonly expiresAt?: string; readonly reauthRequired?: boolean }
  readonly signIn: { readonly approvalUrl: string; readonly expiresAt: string } | null
  readonly signInError?: string
  readonly cloud: {
    readonly models: readonly string[]
    readonly endpoints: readonly {
      readonly endpoint_id: string
      readonly online: boolean
      readonly probe?: {
        readonly rtt_ms?: number
        readonly excluded?: string
        readonly status?: { readonly region?: string; readonly compute_ms: { readonly p50: number } | null }
      }
    }[]
    readonly selected?: string
  }
  readonly hardware: {
    readonly gpus: readonly {
      readonly name: string
      readonly vendor: string
      readonly computeCapability?: string
      readonly driver?: string
      readonly generation?: { readonly architecture: string; readonly fp16: 'tensor-cores' | 'native' | 'slow'; readonly supported: boolean }
    }[]
    readonly npus: readonly { readonly name: string }[]
  }
  readonly recommendation: {
    readonly torchPack: string
    readonly onnxPack: string
    readonly reason: 'cuda' | 'cpu_only' | 'driver_update' | 'gpu_too_old'
    readonly npuWaiting: boolean
  }
  readonly packs: readonly {
    readonly id: string
    readonly backend: 'onnx' | 'torch'
    readonly device: string
    readonly fit: 'ok' | 'no_build' | 'no_nvidia_gpu' | 'gpu_too_old' | 'driver_too_old'
    readonly bytes?: number
    readonly needsDriver?: string
    readonly installed: { readonly outdated: boolean } | null
  }[]
  readonly planned: readonly { readonly id: string; readonly accelerator: string }[]
  readonly models: readonly { readonly id: string; readonly name: string; readonly format: 'onnx-delivery' | 'torch-release'; readonly bytes: number }[]
  readonly catalog: readonly { readonly family: string; readonly name: string; readonly parameters: string; readonly sources: readonly string[] }[]
  readonly job: {
    readonly kind: 'pack' | 'model-download' | 'model-directory'
    readonly target: string
    readonly phase: 'download' | 'unpack' | 'install' | 'probe' | 'verify' | 'done' | 'failed' | 'cancelled'
    readonly done?: number
    readonly total?: number
    readonly error?: string
  } | null
  readonly home: string
}

type Job = NonNullable<PanelState['job']>

/** Download points of the published models, as `MODEL_SOURCES` in the core package lists them. */
const MODEL_SOURCES = ['modelscope-cn', 'modelscope-intl', 'huggingface'] as const

/** Sample calls for trying the backend. */
const TEST_CALLS = {
  safe: { tool: 'shell_command', args: { command: 'git status', shell: 'bash' } },
  risky: { tool: 'shell_command', args: { command: 'git push --force origin main', shell: 'bash' } },
} as const

/** Call one panel route; rejects with the Host's message when it fails. */
async function callPanel<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ROUTE_BASE}${route}`, {
    method,
    ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
  const answer = await response.json().catch(() => undefined) as { ok?: boolean; value?: T; error?: { message?: string } } | undefined
  if (answer?.ok !== true) throw new Error(answer?.error?.message ?? `HTTP ${response.status}`)
  return answer.value as T
}

function running(job: PanelState['job']): boolean {
  return job !== null && !['done', 'failed', 'cancelled'].includes(job.phase)
}

/** Replace `{name}` placeholders. */
function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}

function mebibytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 2)} MiB`
}

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
  // null: the routes did not answer (no connection, or an older Host).
  const panelState = new HostWatch<PanelState | null>(() => callPanel<PanelState>('GET', 'state').catch(() => null))
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
      panelState.close()
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

  /** What the page shows about decisions, from the saved settings and this machine's state. */
  function decisionStatus(value: GuardSettings | undefined, live: PanelState | null | undefined, t: (key: Key) => string) {
    if (value === undefined || live == null) return { tone: 'quiet', text: t('status.unknown'), toneText: t('status.unknown') } as const
    if (value.backend === 'cloud') {
      return live.account.signedIn
        ? { tone: 'success', text: fill(t('status.decision.cloud'), { model: value.cloudModel }), toneText: t('tone.ok') } as const
        : { tone: 'warning', text: t('status.decision.signedOut'), toneText: t('tone.ask') } as const
    }
    const pack = live.packs.find(item => item.id === value.localPack && item.installed !== null)
    const model = live.models.find(item => item.id === value.localModel)
    if (pack === undefined || model === undefined) return { tone: 'warning', text: t('status.decision.localMissing'), toneText: t('tone.ask') } as const
    return { tone: 'success', text: fill(t('status.decision.local'), { pack: pack.id, model: model.name }), toneText: t('tone.ok') } as const
  }

  function StatusSection({ t, value }: { t: (key: Key) => string; value: GuardSettings | undefined }) {
    const heldByReview = useSyncExternalStore(autoReview.subscribe, autoReview.getSnapshot)
    const listed = useSyncExternalStore(autoListed.subscribe, autoListed.getSnapshot)
    const live = useSyncExternalStore(panelState.subscribe, panelState.getSnapshot)
    const auto = autoStatus(value?.mode, heldByReview, listed)
    const decision = decisionStatus(value, live, t)
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

  /** Run panel actions one at a time, keeping the last failure to show next to them. */
  function useAction() {
    const [busy, setBusy] = useState<string | undefined>(undefined)
    const [error, setError] = useState<string | undefined>(undefined)
    const act = (name: string, work: () => Promise<unknown>): void => {
      setBusy(name)
      setError(undefined)
      work().catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => {
        setBusy(undefined)
        panelState.refresh()
      })
    }
    return { busy, error, act }
  }

  function ErrorLine({ text }: { text: string | undefined }) {
    return text === undefined ? null : <p style={{ ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }}>{text}</p>
  }

  /** The listed values, plus a saved one the list no longer has, so a saved choice never silently changes. */
  function withSaved(values: readonly string[], saved: string): string[] {
    return saved === '' || values.includes(saved) ? [...values] : [saved, ...values]
  }

  type PanelField = 'cloudModel' | 'cloudEndpoint' | 'localPack' | 'localModel' | 'downloadSource'

  interface SectionProps {
    readonly t: (key: Key) => string
    readonly live: PanelState
    readonly text: (field: Field) => string
    readonly disabled: boolean
    readonly edit: (field: PanelField, next: string | undefined) => void
  }

  /** The live part of the settings: the account and endpoints for the cloud, packs and models for local. */
  function RuntimePanel({ t, backend, text, disabled, edit }: Omit<SectionProps, 'live'> & { backend: GuardSettings['backend'] }) {
    const live = useSyncExternalStore(panelState.subscribe, panelState.getSnapshot)
    const active = live != null && (live.signIn !== null || running(live.job))
    useEffect(() => { panelState.refresh() }, [])
    useEffect(() => {
      if (!active) return undefined
      const timer = setInterval(() => { panelState.refresh() }, 1000)
      return () => { clearInterval(timer) }
    }, [active])
    if (live === undefined) return <p style={styles.hint}>{t('status.unknown')}</p>
    if (live === null) return <p style={styles.notice}>{t('panel.unavailable')}</p>
    return (
      <>
        {backend === 'cloud'
          ? <CloudSection t={t} live={live} text={text} disabled={disabled} edit={edit} />
          : <LocalSection t={t} live={live} text={text} disabled={disabled} edit={edit} />}
        <TestSection t={t} />
      </>
    )
  }

  function CloudSection({ t, live, text, disabled, edit }: SectionProps) {
    const account = live.account
    const [site, setSite] = useState<'cn' | 'global'>(account.site ?? (navigator.language.toLowerCase().startsWith('zh') ? 'cn' : 'global'))
    const { busy, error, act } = useAction()
    const siteId = useId()
    const modelId = useId()
    const lockId = useId()
    const signIn = (): void => {
      // Opened during the click, so no popup blocker stops it, and pointed at the page once known.
      const popup = window.open('about:blank', '_blank')
      act('signin', async () => {
        try {
          const { approvalUrl } = await callPanel<{ approvalUrl: string }>('POST', `signin?site=${site}`)
          if (popup !== null) {
            popup.opener = null
            popup.location.href = approvalUrl
          }
        } catch (failure) {
          popup?.close()
          throw failure
        }
      })
    }
    const lock = text('cloudEndpoint')
    const endpoints = live.cloud.endpoints
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const
    return (
      <>
        <section style={styles.section}>
          <h4 style={styles.heading}>{t('account.title')}</h4>
          <div style={{ ...styles.card, padding: '12px 16px', gap: 10 }}>
            {account.signedIn
              ? (
                <span style={styles.optionTitle}>
                  {fill(t('account.signedIn'), {
                    site: t(`account.site.${account.site ?? 'global'}` as Key),
                    expires: account.expiresAt === undefined ? '' : new Date(account.expiresAt).toLocaleString(),
                  })}
                </span>
              )
              : <span style={styles.hint}>{t(account.reauthRequired === true ? 'account.reauth' : 'account.signedOut')}</span>}
            {live.signIn !== null
              ? (
                <div style={row}>
                  <span style={styles.hint}>{t('account.waiting')}</span>
                  <a href={live.signIn.approvalUrl} target="_blank" rel="noopener noreferrer" style={styles.hint}>{t('account.openAgain')}</a>
                  <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { act('cancel', () => callPanel('POST', 'signin/cancel')) }}>
                    {t('account.cancel')}
                  </Button>
                </div>
              )
              : account.signedIn
                ? (
                  <div style={row}>
                    <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { act('signout', () => callPanel('POST', 'signout')) }}>
                      {t('account.signOut')}
                    </Button>
                  </div>
                )
                : (
                  <div style={row}>
                    <label htmlFor={siteId} style={styles.hint}>{t('account.site')}</label>
                    <select id={siteId} style={styles.select} value={site} onChange={(event) => { setSite(event.target.value === 'cn' ? 'cn' : 'global') }}>
                      <option value="cn">{t('account.site.cn')}</option>
                      <option value="global">{t('account.site.global')}</option>
                    </select>
                    <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={signIn}>{t('account.signIn')}</Button>
                  </div>
                )}
            <ErrorLine text={live.signInError === undefined ? undefined : t('account.failed') + live.signInError} />
            <ErrorLine text={error} />
            <span style={styles.hint}>{t('account.stored')}</span>
          </div>
        </section>
        <section style={styles.section}>
          <label htmlFor={modelId} style={styles.heading}>{t('cloud.model')}</label>
          <select id={modelId} style={styles.select} value={text('cloudModel')} disabled={disabled} onChange={(event) => { edit('cloudModel', event.target.value) }}>
            {withSaved(live.cloud.models, text('cloudModel')).map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </section>
        <section style={styles.section}>
          <div style={{ ...row, justifyContent: 'space-between' }}>
            <h4 style={styles.heading}>{t('cloud.endpoints')}</h4>
            <Button
              variant="outline"
              size="sm"
              disabled={!account.signedIn || busy !== undefined}
              onClick={() => { act('probe', () => callPanel('POST', `cloud/probe?model=${encodeURIComponent(text('cloudModel'))}`)) }}
            >
              {t(busy === 'probe' ? 'cloud.probing' : 'cloud.probe')}
            </Button>
          </div>
          {endpoints.length === 0
            ? <p style={styles.hint}>{t('cloud.none')}</p>
            : (
              <div style={styles.card}>
                {endpoints.map((endpoint, index) => {
                  const probe = endpoint.probe
                  const compute = probe?.status?.compute_ms
                  const facts = [
                    probe?.status?.region,
                    probe?.rtt_ms === undefined ? undefined : fill(t('cloud.rtt'), { ms: Math.round(probe.rtt_ms) }),
                    compute == null ? undefined : fill(t('cloud.compute'), { ms: Math.round(compute.p50) }),
                  ].filter(fact => fact !== undefined).join(' · ')
                  return (
                    <div key={endpoint.endpoint_id} style={{ ...styles.statusRow, ...(index === 0 ? {} : styles.divider) }}>
                      <span style={styles.statusLabel}>{endpoint.endpoint_id}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={styles.statusText}>{facts}</span>
                        {endpoint.endpoint_id === live.cloud.selected ? <Tag tone="success">{t('cloud.selected')}</Tag> : null}
                        {probe?.excluded !== undefined || !endpoint.online ? <Tag tone="warning">{t('cloud.excluded')}</Tag> : null}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          <label htmlFor={lockId} style={styles.hint}>{t('cloud.lock')}</label>
          <select
            id={lockId}
            style={styles.select}
            value={lock}
            disabled={disabled}
            onChange={(event) => { edit('cloudEndpoint', event.target.value === '' ? undefined : event.target.value) }}
          >
            <option value="">{t('cloud.auto')}</option>
            {withSaved(endpoints.map(endpoint => endpoint.endpoint_id), lock).map(id => <option key={id} value={id}>{id}</option>)}
          </select>
          <p style={styles.hint}>{t('cloud.lock.hint')}</p>
        </section>
      </>
    )
  }

  function JobLine({ t, job, onCancel }: { t: (key: Key) => string; job: Job; onCancel: () => void }) {
    const percent = job.total === undefined || job.total === 0 ? 0 : Math.floor(((job.done ?? 0) / job.total) * 100)
    const failed = job.phase === 'failed'
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {job.phase === 'download' || job.phase === 'verify' ? <progress max={100} value={percent} style={{ flex: 1 }} /> : null}
        <span style={{ ...styles.hint, ...failed ? { color: 'var(--dsw-alias-state-error-primary)' } : {} }}>
          {fill(t(`job.${job.phase}` as Key), { percent, error: job.error ?? '' })}
        </span>
        {running(job) ? <Button variant="outline" size="sm" onClick={onCancel}>{t('job.cancel')}</Button> : null}
      </span>
    )
  }

  function LocalSection({ t, live, text, disabled, edit }: SectionProps) {
    const { busy, error, act } = useAction()
    const [dir, setDir] = useState('')
    const [modelSource, setModelSource] = useState<typeof MODEL_SOURCES[number]>(MODEL_SOURCES[0])
    const sourceId = useId()
    const modelSourceId = useId()
    const dirId = useId()
    const packId = useId()
    const modelId = useId()
    const job = live.job
    const idle = !running(job) && busy === undefined
    const source = text('downloadSource') === 'cn' ? 'cn' : 'official'
    const recommendation = live.recommendation
    const cards = live.hardware.gpus.filter(gpu => gpu.generation !== undefined)
    const chosenPack = live.packs.find(item => item.id === text('localPack'))
    const chosenModel = live.models.find(item => item.id === text('localModel'))
    const needed = chosenModel === undefined ? undefined : chosenModel.format === 'onnx-delivery' ? 'onnx' : 'torch'
    const cancel = (): void => { act('cancel', () => callPanel('POST', 'job/cancel')) }
    const jobOf = (kind: Job['kind'], target?: string) => (
      job === null || job.kind !== kind || (target !== undefined && job.target !== target) ? null : <JobLine t={t} job={job} onCancel={cancel} />
    )
    const between = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } as const
    const inline = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const
    const item = (index: number) => ({ ...styles.option, cursor: 'default', flexDirection: 'column', gap: 6, ...index === 0 ? {} : styles.divider } as const)
    return (
      <>
        <section style={styles.section}>
          <h4 style={styles.heading}>{t('hw.title')}</h4>
          <div style={{ ...styles.notice, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {cards.length === 0
              ? <span>{t('hw.noGpu')}</span>
              : cards.map(gpu => (
                <span key={gpu.name}>
                  {fill(t('hw.gpu'), { name: gpu.name, arch: gpu.generation!.architecture, cc: gpu.computeCapability ?? '?', driver: gpu.driver ?? '?' })}
                  {' · '}
                  {t(`hw.fp16.${gpu.generation!.fp16}` as Key)}
                </span>
              ))}
            {live.hardware.npus.map(npu => <span key={npu.name}>{fill(t('hw.npu'), { name: npu.name })}</span>)}
            <strong style={{ fontWeight: 500 }}>
              {fill(t(`hw.rec.${recommendation.reason}` as Key), { torch: recommendation.torchPack, onnx: recommendation.onnxPack })}
            </strong>
          </div>
        </section>
        <section style={styles.section}>
          <h4 style={styles.heading}>{t('packs.title')}</h4>
          <p style={styles.hint}>{fill(t('packs.hint'), { home: live.home })}</p>
          <div style={inline}>
            <label htmlFor={sourceId} style={styles.hint}>{t('packs.source')}</label>
            <select id={sourceId} style={styles.select} value={source} disabled={disabled} onChange={(event) => { edit('downloadSource', event.target.value) }}>
              <option value="official">{t('packs.source.official')}</option>
              <option value="cn">{t('packs.source.cn')}</option>
            </select>
          </div>
          <div style={styles.card}>
            {live.packs.map((pack, index) => (
              <div key={pack.id} style={item(index)}>
                <div style={between}>
                  <span style={inline}>
                    <span style={styles.optionTitle}>{pack.id}</span>
                    <Tag tone={pack.fit === 'ok' ? 'neutral' : 'warning'}>{fill(t(`packs.fit.${pack.fit}` as Key), { driver: pack.needsDriver ?? '' })}</Tag>
                    {pack.installed === null
                      ? null
                      : <Tag tone={pack.installed.outdated ? 'warning' : 'success'}>{t(pack.installed.outdated ? 'packs.outdated' : 'packs.installed')}</Tag>}
                    {pack.bytes === undefined ? null : <span style={styles.hint}>{mebibytes(pack.bytes)}</span>}
                  </span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    {pack.installed === null || pack.installed.outdated
                      ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pack.fit !== 'ok' || !idle}
                          onClick={() => { act('install', () => callPanel('POST', `packs/install?pack=${pack.id}&source=${source}`)) }}
                        >
                          {t(pack.installed === null ? 'packs.install' : 'packs.update')}
                        </Button>
                      )
                      : null}
                    {pack.installed === null
                      ? null
                      : (
                        <Button variant="outline" size="sm" disabled={!idle} onClick={() => { act('remove', () => callPanel('POST', `packs/remove?pack=${pack.id}`)) }}>
                          {t('packs.remove')}
                        </Button>
                      )}
                  </span>
                </div>
                {jobOf('pack', pack.id)}
              </div>
            ))}
          </div>
          {live.planned.map(pack => <p key={pack.id} style={styles.hint}>{fill(t('packs.planned'), { id: pack.id, accelerator: pack.accelerator })}</p>)}
        </section>
        <section style={styles.section}>
          <h4 style={styles.heading}>{t('models.title')}</h4>
          <div style={styles.card}>
            {live.models.length === 0
              ? <div style={styles.statusRow}><span style={styles.hint}>{t('models.none')}</span></div>
              : live.models.map((model, index) => (
                <div key={model.id} style={{ ...styles.statusRow, ...index === 0 ? {} : styles.divider }}>
                  <span style={{ ...styles.statusLabel, flexShrink: 1, overflowWrap: 'anywhere' }}>{model.name}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={styles.statusText}>{model.id} · {model.format === 'onnx-delivery' ? 'ONNX' : 'PyTorch'} · {mebibytes(model.bytes)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!idle}
                      onClick={() => { act('remove', () => callPanel('POST', `models/remove?id=${encodeURIComponent(model.id)}`)) }}
                    >
                      {t('models.remove')}
                    </Button>
                  </span>
                </div>
              ))}
          </div>
          <div style={inline}>
            <label htmlFor={modelSourceId} style={styles.hint}>{t('packs.source')}</label>
            <select
              id={modelSourceId}
              style={styles.select}
              value={modelSource}
              onChange={(event) => { setModelSource(MODEL_SOURCES.find(value => value === event.target.value) ?? MODEL_SOURCES[0]) }}
            >
              {MODEL_SOURCES.map(value => <option key={value} value={value}>{t(`models.source.${value}` as Key)}</option>)}
            </select>
          </div>
          <div style={styles.card}>
            {live.catalog.map((model, index) => (
              <div key={model.family} style={item(index)}>
                <div style={between}>
                  <span style={styles.optionTitle}>{model.name} · {model.parameters}</span>
                  {model.sources.includes(modelSource)
                    ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!idle}
                        onClick={() => { act('download', () => callPanel('POST', `models/download?family=${model.family}&source=${modelSource}`)) }}
                      >
                        {t('models.download')}
                      </Button>
                    )
                    : <span style={styles.hint}>{t('models.notPublished')}</span>}
                </div>
                {jobOf('model-download', model.family)}
              </div>
            ))}
          </div>
          <label htmlFor={dirId} style={styles.hint}>{t('models.dir')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id={dirId}
              style={{ ...styles.select, flex: 1, minWidth: 0 }}
              value={dir}
              placeholder={t('models.dir.placeholder')}
              onChange={(event) => { setDir(event.target.value) }}
            />
            <Button variant="outline" size="sm" disabled={dir.trim() === '' || !idle} onClick={() => { act('dir', () => callPanel('POST', 'models/install-dir', { dir })) }}>
              {t('models.dir.install')}
            </Button>
          </div>
          {jobOf('model-directory')}
        </section>
        <section style={styles.section}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ ...styles.section, gap: 6 }}>
              <label htmlFor={packId} style={styles.hint}>{t('local.pack')}</label>
              <select
                id={packId}
                style={styles.select}
                value={text('localPack')}
                disabled={disabled}
                onChange={(event) => { edit('localPack', event.target.value === '' ? undefined : event.target.value) }}
              >
                <option value="">{t('local.pick')}</option>
                {withSaved(live.packs.filter(pack => pack.installed !== null).map(pack => pack.id), text('localPack')).map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <div style={{ ...styles.section, gap: 6 }}>
              <label htmlFor={modelId} style={styles.hint}>{t('local.model')}</label>
              <select
                id={modelId}
                style={styles.select}
                value={text('localModel')}
                disabled={disabled}
                onChange={(event) => { edit('localModel', event.target.value === '' ? undefined : event.target.value) }}
              >
                <option value="">{t('local.pick')}</option>
                {withSaved(live.models.map(model => model.id), text('localModel')).map(id => (
                  <option key={id} value={id}>{live.models.find(model => model.id === id)?.name ?? id}</option>
                ))}
              </select>
            </div>
          </div>
          {needed !== undefined && chosenPack !== undefined && chosenPack.backend !== needed
            ? <p style={{ ...styles.hint, color: 'var(--dsw-alias-state-warn-label)' }}>{fill(t('local.mismatch'), { backend: needed === 'onnx' ? 'ONNX' : 'PyTorch' })}</p>
            : null}
        </section>
        <ErrorLine text={error} />
      </>
    )
  }

  function TestSection({ t }: { t: (key: Key) => string }) {
    const { busy, error, act } = useAction()
    const [sample, setSample] = useState<keyof typeof TEST_CALLS>('safe')
    const [verdict, setVerdict] = useState<{ decision: string; elapsed_ms: number; backend: string; via: string } | undefined>(undefined)
    return (
      <section style={styles.section}>
        <h4 style={styles.heading}>{t('test.title')}</h4>
        <p style={styles.hint}>{t('test.hint')}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select aria-label={t('test.title')} style={styles.select} value={sample} onChange={(event) => { setSample(event.target.value === 'risky' ? 'risky' : 'safe') }}>
            <option value="safe">{t('test.safe')}</option>
            <option value="risky">{t('test.risky')}</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => {
              setVerdict(undefined)
              act('test', async () => { setVerdict(await callPanel('POST', 'test', TEST_CALLS[sample])) })
            }}
          >
            {t(busy === undefined ? 'test.run' : 'test.running')}
          </Button>
        </div>
        {verdict === undefined
          ? null
          : <p style={styles.optionTitle}>{fill(t('test.result'), { decision: verdict.decision, ms: verdict.elapsed_ms, backend: verdict.backend, via: verdict.via })}</p>}
        <ErrorLine text={error === undefined ? undefined : t('test.failed') + error} />
      </section>
    )
  }

  function SettingsPage({ view, t: translate }: ConfigPageProps) {
    const t = translate as (key: Key) => string
    const accepted = useSyncExternalStore(subscribeForm, formSnapshot)
    const [draft, setDraft] = useState<Partial<Record<Field, Staged>>>({})
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)
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
              onChoose={(next) => { edit({ backend: next }) }}
              t={t}
            />
            <RuntimePanel
              t={t}
              backend={backend}
              text={text}
              disabled={disabled}
              edit={(field, next) => { edit({ [field]: next }) }}
            />
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
