# Vulcan Decision Guard 架构

> 状态：v1 预览版，只适配 dsh。宿主能力以各宿主源码与官方文档为准；标注“待调查”的条目在实现前必须先验证。

## 一、定位

Vulcan Decision Guard 是一个独立项目，为 Vulcan Code 之外的 AI 编码宿主（DeepSeek harness、Claude Code、
Codex 等）提供工具调用权限守卫。它拥有自己的账号体系（OpenVulcan 账号与 OAuth 登录，尚未开放）、配置与
发布节奏，不依赖 Vulcan Code 仓库。

与 Vulcan Code 的关系是**参考升级**：Vulcan Code 的权限判定实现只作为参考，本仓库按需移植并自行维护；
每次移植在提交说明中记录所参考的 Vulcan Code 提交，不建立代码依赖。

## 二、组成

| 包 | 内容 |
| --- | --- |
| `@openvulcan/vulcan-decision` | 常驻判定服务、宿主共用的客户端（`/client`）与命令行 `vulcan-decision` |
| `@openvulcan/dsh-decision-guard` | dsh 插件：Host 端 `src/`，浏览器端 `client/`（构建为 `lib/client.js`） |

全部用 TypeScript 编写，运行在 Node ≥ 20.19 上。推理依赖 `onnxruntime-node`（版本见
`packages/vulcan-decision/package.json`），它的 npm 包自带 Windows x64/arm64、macOS x64/arm64 与 Linux
x64/arm64 的 CPU 运行库，Windows 另带 DirectML；分词用 `tokenizers` 的 Node 绑定。因此用户不需要 Rust、
Python，也不需要单独下载 ONNX Runtime。

此前的 Rust 原生服务与按平台分发的 npm 包已移除：用户的 CPU 与系统组合太多，原生构建矩阵与 ONNX Runtime
下载的维护成本高于收益，而 Node 已是每个宿主的运行环境。

## 三、判定管线

每次受管控的工具调用依次经过：

1. **宿主换算**：宿主插件把自己的工具调用换算成模型训练时见过的工具形状（见第六节），可直接得出结论的
   调用（宿主内部工具、项目内的读写）不进入模型。
2. **判定模型**：给出 allow / review / block。
3. **复核 LLM**：处理模型未放行的调用（review、无法判定；block 仅在用户打开“允许 LLM 推翻拦截”时），
   依据用户写的自然语言规则与对话中的用户指令作答。复核模型为会话模型、用户指定的模型或关闭。
4. **用户**：仅在有人值守时存在；无人值守的会话从不询问。

结论映射（dsh 适配，`packages/dsh-decision-guard/src/decide.ts`；判定模型 allow 直接执行，下表是其余调用）：

| 复核 LLM | 有人值守 | 无人值守 |
| --- | --- | --- |
| allow | 执行 | 执行 |
| review（仅有人值守可答） | 询问，默认焦点“允许” | — |
| deny | 询问，默认焦点“拒绝” | 拒绝 |
| forbid（仅有人值守可答，只用于“绝对禁止”规则） | 拒绝，不询问 | — |
| 失败、关闭或未送复核（block） | 询问；判定为 review 时默认焦点“允许”，否则“拒绝” | 拒绝 |

被拒绝的调用把理由返回给 AI，并提示它可以经 `explain_tool_call` 说明目的后重试，不限重试次数。询问可设
倒计时，超时按拒绝处理。

**任何错误都不得放行**：这是全项目唯一不可协商的规则。复核失败、流未以 `stop` 结束或输出不符合约定形状时，
一律按“未放行”处理。

## 四、判定服务

判定不能在每次工具调用时冷启动：加载模型需要数百毫秒到数秒。因此判定由每个用户唯一的常驻服务
`vulcan-decision serve` 承担，所有宿主插件共用它。

- **数据目录**：`~/.vulcan-decision/`（仅属主可访问），环境变量 `VULCAN_DECISION_HOME` 可改到别处，用于测试
  与隔离环境。模型包在 `models/<模型 id>/`，服务日志在 `serve.log`。
- **端点**：唯一定义在 `src/paths.ts` 的 `endpointPath()`。Windows 为 named pipe
  `\\.\pipe\vulcan-decision-<用户名>-<数据目录哈希>`，不同数据目录各有一个服务；Unix 为数据目录下的
  `run/serve.sock`。
- **协议**（`src/protocol.ts`）：每行一个 JSON 帧（上限 16 MiB）。请求为 `ping`、`judge`、`status` 与
  `shutdown`，都携带 `contract` 版本（`shutdown` 除外，以便升级时替换旧服务）；版本不一致时服务返回
  `contract_mismatch`，客户端先请求旧服务退出、等待其消失，再启动当前版本。错误码为 `invalid_request`、
  `backend_unavailable`、`model_not_installed`、`model_failed`，宿主不得把其中任何一个当作放行。
- **启动**：客户端（`DecisionClient`）以 `process.execPath` 完全脱离地运行本包的 `bin/vulcan-decision.js serve`，
  并设置 `ELECTRON_RUN_AS_NODE=1`，因此在 Electron 宿主内同样可用。启动最多等待 15 秒。
- **生命周期**：宿主插件运行期间保持一条 keepalive 连接；服务在没有连接且空闲 30 分钟后退出，模型空闲
  15 分钟后卸载。传输失败时客户端重试一次（必要时重新拉起服务）。
- **推理**：同一模型的推理串行执行以限制内存；一次请求中的多个调用按模型的 `micro_batch` 分批。
  执行设备默认 CPU，环境变量 `VULCAN_DECISION_DEVICE=dml|cuda` 可试用 GPU（实验性）。

命令行（`npx @openvulcan/vulcan-decision …`）：

| 子命令 | 作用 |
| --- | --- |
| `serve` | 常驻判定服务 |
| `start` / `stop` / `status` | 启动、停止、查看服务与已安装模型（`status` 不会启动服务） |
| `model list` / `model install <目录> --size <尺寸> [--id <id>]` / `model remove <id 或尺寸>` | 模型包管理；安装与删除前先停止服务 |
| `judge --input <文件>` | 经服务判定（调试） |
| `eval --input <文件> [--size <尺寸>]` | 在当前进程内对已渲染的输入打分（调试与对照） |

## 五、模型与模型包

模型：`vulcan-decision-shell-{0.2b|0.4b|0.6b}-v1-preview`，当前只有 0.2B。尺寸是用户设置；省略时选择
已安装的、本机内存适合的最大尺寸（总内存 < 12 GiB 为 0.2B，< 24 GiB 为 0.4B，其余 0.6B）。

**输入格式**（`src/render.ts`，与训练格式一致，不额外补充任务描述、历史消息或文件状态）：

```text
Project: <项目根目录>          （未知时省略）
Tool: <工具名>
Arguments: <实际参数的紧凑 JSON，键保持原顺序>
```

模型另有三项授权选项（`cross_project_writes`、`database_reset`、`project_reset`），对应设置页的“授权选项”。
图的输入为 `input_ids`、`attention_mask`、`marker_pos`、`marker_mask` 与 `qtype`，输出 `logits`
（allow / review / block）；取最大值为结论，allow 领先不足 `allow_margin` 时改为 review。超过
`max_tokens` 的调用不进入模型，直接以 `input_token_limit` 判为 block。

**模型包**（`src/model/package.ts`）：一个目录，包含

- `model.json`：`format`（当前为 1，其他值拒绝）、`id`、`size`、按偏好排序的图变体（文件、精度
  `fp32` / `fp16-mixed`、验证过的设备 `cpu` / `gpu`），以及除 `model.json` 外每个文件的字节数与 SHA-256。
- `runtime-config.json`：模型自带的推理参数（`max_tokens`、`micro_batch`、`allow_margin` 等）。
- `assets/`：分词器与策略文件；ONNX 图及其外部权重。

`model install` 校验每个文件的大小与 SHA-256，先复制到临时目录，全部通过后才换入；模型 id 只允许安全字符。
下载与签名分发尚未实现。

**0.2B v1 预览版来源**：训练运行 `permission-pairs199-v63` 的 `pair_zero` 对照组，`step-0004` 全精度权重
（SHA-256 `f571e5cf01ff1348cfeb35b56549905bbbc83ea32bb6272f7afbb37eec031e0c`）。另一组 `pair` 与对照组的
诊断结果完全相同，但正常调用被误拦截的回归更多（12 组对 7 组），因此采用对照组。导出沿用训练仓库的
发布流水线：fp32 在 CPU 导出，fp16 在 CUDA 导出，再经注意力掩码展开、旋转位置缓存展开、注意力内存上限、
窗口掩码压缩与权重转换折叠，生成两个变体：

| 变体 | 精度 | 设备 | 权重大小 |
| --- | --- | --- | --- |
| `risk199-fp32-runtime.onnx` | fp32 | CPU | 约 760 MiB |
| `risk199-attention-fp32.onnx` | fp16 权重，注意力 fp32 | GPU / CPU | 约 460 MiB |

## 六、宿主适配

每个宿主的能力不同，适配层负责把同一个判定结论映射为该宿主能执行的行为。**目前只适配 dsh**；Claude Code
与 Codex 的调查结论保留在下表，两者需要每次调用启动的 hook 客户端，届时再加入。

| 能力 | DeepSeek harness（dsh） | Claude Code | Codex |
| --- | --- | --- | --- |
| 接入点 | 服务端插件监听 `tools/pre-execute` waterfall（`prepend`），覆盖每个原生工具调用与 PTC 内层调用 | `PreToolUse`（allow / deny / ask）、`PermissionRequest` | `PreToolUse`（allow / deny，`ask` 不支持）、`PermissionRequest`（仅升权请求） |
| 结论 | `allow` / `deny` / `ask` / `cancel` | allow / deny / ask | allow / deny |
| 询问用户 | 支持：`ask` 经审批服务，只有“允许一次”放行；审批策略为 `never` 时按拒绝处理 | 支持 | 不支持 |
| 复核 LLM | 经 `ctx.llm.stream` 使用当前会话或用户指定的 provider 与模型 | 自有配置；可评估宿主 `prompt` hook | 必须自有配置与复核标准，因为没有用户兜底 |
| 进程模型 | 插件常驻宿主进程，持有服务的 keepalive 连接 | 每次调用启动 hook 客户端（后续阶段） | 同左 |
| 失败语义 | 插件抛错或返回 `deny` 均不执行 | `command`/`http` 必须设 `onFailure: "block"`；`mcp_tool` 失败时放行，不得用作闸门 | hook 超时语义待调查 |

### dsh 适配

依据 dsh `0.2.1-rc.2` 源码（`D:\dsh\deepseek-harness`）；dsh 升级后需回读源码核对。

- **形态**：Cordis 插件，以 npm 组合包分发（`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
  通过 `dsh plugin add` 安装到 profile。`engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0`，dsh 包一律作为 peer 依赖。
- **闸门**（`src/index.ts`）：以 `prepend` 注册 `tools/pre-execute` 监听。外层 `run_code` 与 PTC 程序内直接的
  Node 副作用不经过该 waterfall，与 dsh 自带 Auto review 的限制相同。dsh 先执行该 waterfall、后校验工具参数，
  因此参数不合法的调用也会被判定（与询问），随后才被 dsh 以参数错误拒绝。
- **工具换算**（`src/calls.ts`）：

  | dsh 工具 | 送给模型 |
  | --- | --- |
  | `bash` / `pwsh`（含持久会话变体） | `shell_command {command, cwd?, shell}`；`cwd` 只在给出 `workdir` 时出现，按项目根解析 |
  | `terminal_send` | `shell_command {command: text}` |
  | `write` / `edit` | `write_file` / `edit_file {path}`；项目内直接放行 |
  | `str_replace_editor` | `view` → `read_file`，`create` → `create_file`，`str_replace` / `insert` → `edit_file` |
  | `read` / `read_image` / `glob` / `grep` / `lsp` | `read_file {path}`；项目内直接放行 |
  | 宿主内部工具（提问、目标、待办、会话检索、子代理通信等） | 不判定，直接放行 |
  | 其他工具（MCP、`web_fetch`、计划任务等） | 原样送给模型 |

  项目是会话的工作目录。项目根为文件系统根或用户主目录时，不视为“项目内”；路径以 `..` 开头或经过
  `.git` 的目标也不视为项目内。编辑类调用只把路径交给模型，这与模型训练时的工具形状一致。
- **复核 LLM**（`src/review.ts`）：`review` 为 `session` 时使用会话请求头中的 provider 与模型，为 `custom` 时
  使用设置中的 `reviewProvider` 与 `reviewModel`；`temperature` 为 0，复核请求不进入会话记录。系统提示按
  有人值守与无人值守分为两套：有人值守可答 allow / review / deny / forbid，无人值守只可答 allow / deny 并
  被告知不存在人工复核。理由按界面语言书写（读取 dsh `locale` 设置的 `preference`；未设置时界面跟随浏览器，
  Host 端无从得知，改用用户指令的语言）。输入分为 ENVIRONMENT（项目与授权选项）、USER_RULES（用户的
  三组规则，优先级 forbid > deny > allow）、USER_INSTRUCTIONS（最近 6 条用户与代理指令，每条最多
  4000 字符）、RECENT_TOOL_CALLS（最近 12 次工具调用，参数最多 1500 字符）、AGENT_INTENT（代理经意图工具
  给出的说明，只是声明而非授权）与 PENDING_CALL（判定阶段、工具与参数）。输出必须是当前模式的封闭 JSON
  形状，理由最多保留 300 字符。
- **意图工具**（`src/intent.ts`）：`explain_tool_call {tool, purpose}`，复核开启时注册（保存设置后即时增减），
  属于不判定的内部工具。说明按会话与工具名暂存，由下一次同名调用取走，只送给复核 LLM 与询问卡片。
- **询问**：插件经 `approval.request` 自行询问（先 `await next()`，下游非放行结论优先），信号叠加倒计时，
  超时按拒绝处理。`displayReason` 的 `x-vulcan-decision` 键携带卡片数据（阶段、复核理由、意图、预览、
  默认焦点、倒计时）；浏览器端以优先级 0 注册 `conversation.composer`，遇到带该键的审批时显示本插件的
  卡片（标签、命令预览、LLM 理由、意图、倒计时，Esc 拒绝）。拒绝时附带
  `info {name: 'VulcanDecisionDeniedError', code: 'VULCAN_DECISION_DENIED'}`。
- **无人值守**（`src/unattended.ts`）：按会话保存为插件记录 `plugin:vulcan-decision-guard/unattended`，
  投影为会话状态 `vulcanDecision`，由命令 `/vulcan-unattended on|off` 写入（状态未变时不写）。浏览器端在
  `conversation.input.left` 显示勾选框（独立开关模式，或当前预设为 `auto` 时）。审批策略为 `never` 的会话
  同样按无人值守处理。
- **配置**（`Config`，全部 `.volatile()`，每次操作开始时读取，保存后无需重启）：`mode`（接入方式）、
  `backend`（`local` / `cloud`，默认 `local`；`cloud` 尚未开放，选中时受管控的调用按无法判定处理）、`modelSize`
  （省略即按设备选择）、`review`（`session` / `custom` / `off`，默认 `session`）、`reviewProvider` 与
  `reviewModel`、`allowRules` / `denyRules` / `forbidRules`（自然语言，默认空）、`llmOverridesBlock`（默认
  `false`）、`askTimeout`（秒，0 表示一直等待，最大 3600）、`crossProjectWrites`（默认 `allow`）、
  `databaseReset` 与 `projectReset`（默认 `confirm`）。
- **设置页**（`client/index.tsx`）：插件自带页面，经 `settings.configure({ auto: false })` 关闭 dsh 自动生成的
  表单，浏览器端注册到 `plugins.bundle.config`，经 `configForms.get('vulcan-decision-guard')` 读写。页面依次为：
  状态、接入方式、判定后端（本机模型时显示模型尺寸与安装命令）、授权选项、模型未放行的调用（复核模型，
  指定模型时从 `remote.session.modelCatalog()` 选择；允许 LLM 推翻拦截；绝对禁止、拒绝、允许三组规则；询问
  倒计时）、OpenVulcan 账号（尚未开放）。
- **状态区的来源**：第三方插件无法新增 Remote（dsh 的 Remote 在构建时由 Typert 生成并静态组装），浏览器端
  拿不到 Host 端的实时状态（服务是否运行、模型是否已安装），因此状态只由浏览器可读的事实推出：判定一行
  由已保存的后端与尺寸推出，并给出 `status` 命令；Auto 预设一行由 `mode`、`pluginManager.listBundles()` 与
  `permissionPresets.catalog()` 推出，收到 `plugin-manager/changed`、`permission-presets/catalog-changed`
  或连接重置时重读。
- **与权限预设的关系**：dsh 的权限预设表只有配置预设与一个固定的 `auto` 槽位；`auto` 同时只能由一个集成
  注册，组合固定为 `danger-full-access` 沙箱加 `ask` 审批。`registerAuto(admit)` 不接受说明文字，选择 Auto
  时的确认对话框文字由 dsh 固定，描述的是 dsh 自带 Auto review 的行为。
- **接入方式（用户设置，二选一）**：

  | 方式 | 启用位置 | 判定范围 | 沙箱 |
  | --- | --- | --- | --- |
  | 自动预设（`auto`） | dsh 权限选择器中选择“自动审查” | 仅当前预设为 `auto` 的会话 | 无（完全权限） |
  | 独立开关 | 本插件设置页 | 所有会话，叠加在所选预设之上 | 保留所选预设的沙箱 |

- **与 Auto review 的关系：替代，不共存。** 两者功能相同，只做冲突检测与提示：
  - 冲突：dsh 的 Auto review 组合包（`@deepseek-ai/dsh-experimental-auto-review`）与本插件同时启用。
  - 提示：浏览器端经 `pluginManager.listBundles()` 读取，冲突时在两个插件的详情页标题旁显示“冲突”标签，
    并在页内提供“停用自动授权审查”按钮（`pluginManager.setBundleEnabled(…, false)`）。
  - 接管：Host 端在启动及每次 `permission-presets/catalog-changed` 时尝试注册 `auto`；被占用则跳过，
    对方停用后自动接管。`registerAuto` 因竞态抛错时按“已占用”处理，插件加载绝不因冲突失败。
- **卸载与切换**：先停止接收，把仍处于 `auto` 的会话迁回 `workspace-write`，再撤回注册；设置页改为独立开关
  时同样撤回，改回自动预设时立即重新注册。插件卸载时关闭 keepalive 连接，服务随后自行空闲退出。

## 七、仓库结构

```
packages/
  vulcan-decision/      @openvulcan/vulcan-decision：服务、客户端、命令行、模型包与推理（src/model/）
  dsh-decision-guard/   @openvulcan/dsh-decision-guard：Host 端 src/、浏览器端 client/
docs/
```

- **宿主插件**（`packages/<宿主>-decision-guard`）只含宿主适配逻辑，依赖 `@openvulcan/vulcan-decision` 的
  `/client` 入口，按宿主的插件机制安装。
- **判定服务**（`@openvulcan/vulcan-decision`）为所有宿主共用；后续加入的宿主插件引用同一个包。

## 八、发布与安装

1. 先发布 `@openvulcan/vulcan-decision`，再发布 `@openvulcan/dsh-decision-guard`（插件以 `workspace:*`
   引用前者，发布时由 pnpm 换成实际版本）。
2. 用户执行 `dsh plugin add @openvulcan/dsh-decision-guard`。pnpm 11 默认拦下依赖的安装脚本，dsh 把
   `onnxruntime-node` 记为待决定并提示“允许这些脚本并重试”。该脚本只在 Linux x64 上下载 CUDA 执行库，在
   其他平台上直接退出；本项目不使用 CUDA，因此在 profile 的 `pnpm-workspace.yaml` 中写入
   `allowBuilds: { onnxruntime-node: false }` 同样可以完成安装，Linux x64 上推荐这样做。
3. 用户执行 `npx @openvulcan/vulcan-decision model install <目录> --size <尺寸>` 安装模型。

模型权重不进入 npm 包，也不使用 `postinstall` 下载。

## 九、验证记录

在 Windows 11、dsh `0.2.1-rc.2`（npm `next`）、onnxruntime-node 1.30.0 上验证：

- **数值一致性**：37 条调用（含 dsh 形状的调用）对照 PyTorch fp32 CPU 参考实现：CPU fp32 变体 37/37 结论
  相同，logits 最大差 0.0001；DirectML 上的 fp16 变体 37/37 结论相同，最大差 0.16。分词与 Python 参考
  21/21 完全相同。
- **延迟**（CPU，经常驻服务，0.2B fp32）：首次判定约 0.8 秒（含拉起服务与加载模型），之后中位数约 107 ms。
- **dsh 端到端**：在隔离的 `DSH_HOME` 中用 `dsh plugin add` 安装打包后的插件，用本地脚本化的 Messages 模拟
  服务代替付费模型，在 Auto 预设下逐一确认：`git status` 放行并执行；`Remove-Item -Recurse -Force .` 被
  拦截，复核未放行后拒绝，理由返回给模型；`git push --force` 需确认，复核未放行后显示询问卡片（中文理由），
  “允许一次”与“拒绝”都按预期生效；`git reset --hard HEAD~3` 需确认，复核放行后直接执行；项目外写入经
  模型放行；项目内写入不经模型直接放行。插件加载时拉起服务，`status` 显示的判定次数与调用次数一致。
- **复核、规则与无人值守**（同上环境，模拟服务按场景脚本应答）：有人值守时，block 不交复核，弹出卡片（默认
  焦点“拒绝”），倒计时结束后按拒绝返回；`git push` 经复核答 review 后弹出卡片（默认焦点“允许”，显示 LLM
  理由），回车放行；`explain_tool_call` 记录意图后，复核收到该意图并放行；复核答 forbid 时直接拒绝、不弹卡片，
  理由附带重试提示。勾选“无人值守”后，block 直接拒绝，复核收到无人值守提示词，deny 拒绝、allow 执行，
  全程无卡片；该勾选在 dsh 重启后保持。设置页的倒计时、规则与指定复核模型均写入 profile，指定模型后复核
  请求使用该模型而非会话模型。
- **此前已验证**：`dsh plugin add` 安装与加载、权限选择器出现 Auto；两种加载顺序下的冲突提示、停用
  Auto review 后自动接管；设置页显示（含深色模式）与保存写入 profile 的 `cordis.patch.yml`；接入方式切换后
  Auto 的出现与消失；模型尺寸的设定与清除。
- **尚未验证**：复核 LLM 对真实模型的调用（只用模拟服务与单元测试验证）；Linux 与 macOS；GPU 执行设备在
  CUDA 上的表现。

已知的模型行为（0.2B 预览版，按当前训练数据）：`iwr … | iex` 这类下载后直接执行的命令被判为 allow；
未在训练中出现的工具（如 `web_fetch`、计划任务、MCP 工具）多判为 allow。

## 十、待决定与待调查

1. 模型的下载与签名分发：来源、校验与版本更新方式。
2. OpenVulcan 云端判定与 OAuth 登录方式（设备码流程，还是本机回环重定向）。
3. dsh 接入方式的默认值：目前为自动预设。
4. Windows named pipe 目前使用默认 ACL，需要收紧为仅当前用户。
5. dsh 若开放第三方插件的 Remote，设置页改为显示服务与模型的实时状态。
6. （后续阶段）Codex hook 超时与崩溃时的行为，以及 Codex 桌面版与 IDE 扩展是否执行 hook。
