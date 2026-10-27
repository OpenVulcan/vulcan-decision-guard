# Vulcan Decision Guard 架构

> 状态：v1 预览版，只适配 dsh。宿主能力以各宿主源码与官方文档为准；标注“待调查”的条目在实现前必须先验证。

## 一、定位

Vulcan Decision Guard 是一个独立项目，为 Vulcan Code 之外的 AI 编码宿主（DeepSeek harness、Claude Code、
Codex 等）提供工具调用权限守卫。它使用 OpenVulcan 账号与 OpenVulcan 云端判定节点，拥有自己的配置与发布
节奏，不依赖 Vulcan Code 仓库。

与 Vulcan Code 的关系是**参考升级**：Vulcan Code 的权限判定实现只作为参考，本仓库按需移植并自行维护；
每次移植在提交说明中记录所参考的 Vulcan Code 提交，不建立代码依赖。

## 二、组成与版本

| 包 | 内容 |
| --- | --- |
| `@openvulcan/vulcan-decision` | 判定引擎（云端与本机两种后端）、OpenVulcan 账号、运行包与模型管理、命令行 `vulcan-decision` |
| `@openvulcan/dsh-decision-guard` | dsh 插件：Host 端 `src/`，浏览器端 `client/`（构建为 `lib/client.js`） |

两个包都是纯 TypeScript，运行在 Node ≥ 20.19 上，**没有任何原生依赖与安装脚本**（两个 npm 包合计约
110 KB）。本机推理所需的一切都放在可选的**运行包**里，由用户按需安装。

同一个仓库、同一个插件提供以下版本（“版本”指用户最终装到本机的内容，不是不同的 npm 包）：

| 版本 | 本机内容 | 说明 |
| --- | --- | --- |
| 云端（默认） | 只有两个 npm 包 | 登录 OpenVulcan 账号即可判定，本机不装任何运行库 |
| 本机 · ONNX CPU | + `onnx-cpu` 运行包 + ONNX 模型 | 任意 x64 / arm64 机器 |
| 本机 · ONNX CUDA | + `onnx-cuda` 运行包 + ONNX 模型 | NVIDIA 显卡（Turing 及以上） |
| 本机 · PyTorch CPU | + `torch-cpu` 运行包 + 发布版模型 | 任意 x64 / arm64 机器 |
| 本机 · PyTorch CUDA | + `torch-cu128` 运行包 + 发布版模型 | NVIDIA 显卡（Turing 及以上） |
| 本机 · NPU | 规划中（`onnx-openvino`、`onnx-qnn`） | 只保留接口，等待为 NPU 导出的 ONNX 模型 |

此前的“常驻判定服务 + `onnxruntime-node`”设计已移除：npm 包自带的 ONNX Runtime 在 Windows 上没有 CUDA，
也无法运行 PyTorch 发布版模型；改为宿主进程内的引擎加按需安装的 Python 运行包后，云端用户不必下载任何
运行库，本机用户只下载自己用得到的那一个包。

## 三、判定管线

每次受管控的工具调用依次经过：

1. **宿主换算**：宿主插件把自己的工具调用换算成模型训练时见过的工具形状（见第七节），可直接得出结论的
   调用（宿主内部工具、项目内的读写）不进入模型。
2. **判定模型**：云端或本机，给出 allow / review / block。
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

**任何错误都不得放行**：这是全项目唯一不可协商的规则。云端请求失败、未登录、本机运行包或模型缺失、
复核失败、流未以 `stop` 结束或输出不符合约定形状时，一律按“未放行”处理。

## 四、判定引擎

`DecisionEngine`（`src/engine.ts`）是宿主唯一的入口：`judge(call, settings)` 按 `settings.backend` 交给云端
或本机后端，返回 `{decision, logits, input_tokens, model_evaluated, backend, model, via, elapsed_ms}`
（`via` 为云端节点 id 或本机运行包 id）。所有失败都抛出带错误码的 `DecisionError`（`not_signed_in`、
`not_installed`、`backend_unavailable`、`model_failed`、`rate_limited`、`invalid_request` 等），宿主不得把其中
任何一个当作放行。

**输入格式**（`src/render.ts`，与训练格式一致，不额外补充任务描述、历史消息或文件状态）：

```text
Project: <项目根目录>          （未知时省略）
Tool: <工具名>
Arguments: <实际参数的紧凑 JSON，键保持原顺序>
```

模型另有三项授权选项（`cross_project_writes`、`database_reset`、`project_reset`），对应设置页的“授权选项”。

**数据目录**（`src/home.ts`）：由宿主指定。dsh 插件使用 `$DSH_HOME/vulcan-decision/`；命令行默认
`~/.vulcan-decision/`，可用 `VULCAN_DECISION_HOME` 改到别处。其下 `packs/<运行包>/`、`models/<模型 id>/` 与
`downloads/`（未完成的下载，中断后续传）。目录仅属主可访问。

### 4.1 云端后端（默认）

- **账号**（`src/cloud/account.ts`）：OpenVulcan 有中国站（`openvulcan.cn`）与国际站（`openvulcan.com`），登录时
  选定。登录为 PKCE（S256）加本机回环回调：宿主打开授权页，用户批准后浏览器被重定向到
  `http://127.0.0.1:<端口>/vulcancode/auth/callback`，授权码换取一次设备凭据。凭据有效期 14 天，剩余不足一天
  时以一次性刷新轮换；轮换可能中断时要求重新登录，不猜测哪个令牌有效。退出登录同时注销本设备。
- **凭据存放**：由宿主提供 `CredentialStore`。dsh 插件存入 dsh 自己的凭据存储（`$DSH_HOME/.credentials.yaml`，
  键 `vulcan-decision-guard/openvulcan`，类型 `grant`）；命令行存入数据目录下仅属主可读的 `account.json`。
  任何接口、日志与面板应答都不包含令牌本身。
- **节点**（`src/cloud/edge.ts`）：设备凭据向本站认证服务取得可用模型（`edge-models`）与按模型签发的短期访问
  授权（`edge-access`，10 分钟，含节点列表）。判定直接发往一个节点的 `POST /v1/judge`。
- **节点选择**：按测量，不按单次请求。启动时、每 10 分钟及失败后（至多每 30 秒）各测 3 次每个节点的公开
  `/v1/status`；得分为往返中位数加节点报告的计算中位数（有节点未报告计算时只比往返），新节点须好 20% 才替换
  当前节点。用户可锁定节点，锁定后始终使用它、失败也不切换。请求失败即报错，不在其他节点上重试。
- **云端模型**：`vulcan-decision-shell-v1-mini-preview`（默认）、`-flash-preview`、`v1-preview`。

### 4.2 本机后端（可选）

- **运行包**（`src/local/packs.ts`）：一个 python-build-standalone 预编译解释器加官方 wheel，全部由仓库内的锁文件
  （`runtime-packs/<运行包>.json`）按平台固定 URL、大小与 SHA-256。安装时逐个下载并校验，解开解释器，
  用它自带的 pip 离线安装这些 wheel（`--no-index --no-deps`），再启动工作进程探测运行库能否导入；全部通过后
  才换入。**不编译任何东西，也不安装或更新驱动**：CUDA 运行包的 CUDA 库来自 NVIDIA 官方 wheel，只要求驱动
  版本足够。没有现成可下载运行库的设备（AMD、Intel、Apple 显卡）一律不提供 GPU 运行包，改用 CPU 运行包或云端。
- **锁文件生成**：`scripts/lock_runtime.py` 读取 `runtime-packs/spec.json`，用 uv 为每个平台解析出确切的 wheel，
  写出锁文件。修改 spec 后必须重新生成；锁文件随 npm 包发布，`spec.json` 不发布。
- **下载源**（`src/download.ts`）：`official`（GitHub、PyPI、download.pytorch.org）或 `cn`（npmmirror 的
  python-build-standalone 镜像、阿里云 PyPI 与 pytorch-wheels 镜像）。镜像必须提供同样的字节，按同一组 SHA-256
  校验；镜像失败直接报错，不偷偷改用官方地址。下载经 `.part` 文件续传。
- **工作进程**（`python/vulcan_decision_worker.py`，`src/local/worker.ts`）：以运行包的解释器 `python -I -B` 启动，
  标准输入输出逐行 JSON（`probe`、`load`、`judge`、`shutdown`）。一个运行包与模型组合对应一个进程，判定按到达
  顺序串行；选择变化时重启，空闲 30 分钟后退出以释放内存。进程退出、超时或应答不合形状都是错误。
- **Windows 路径长度**：运行包内最深的路径约 144 个字符（`python\Lib\site-packages\` 下的 torch 头文件），
  安装前按 150 预留；数据目录过深、会超过 259 字符时在下载前就报错，并给出可用的最大长度。默认的
  `~/.dsh/vulcan-decision` 不受影响。

| 运行包 | 内容 | Python | win-x64 | linux-x64 | linux-arm64 | mac-arm64 | 要求 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `onnx-cpu` | onnxruntime 1.30.0、tokenizers、numpy | 3.12 | 56 MiB | 82 MiB | 73 MiB | 59 MiB | — |
| `onnx-cuda` | onnxruntime-gpu 1.30.0（含 NVIDIA CUDA 13 与 cuDNN 9 wheel） | 3.12 | 1307 MiB | 1532 MiB | — | — | 驱动 ≥ 580.65，计算能力 ≥ 7.5 |
| `torch-cpu` | torch 2.9.1+cpu、transformers、laya、tokenizers、safetensors | 3.11 | 173 MiB | 254 MiB | 175 MiB | 133 MiB | — |
| `torch-cu128` | torch 2.9.1+cu128（含 CUDA 12.8 wheel）及同上 | 3.11 | 2797 MiB | 3949 MiB | — | — | 驱动 ≥ 570.65，计算能力 ≥ 7.5 |
| `onnx-openvino` | 规划中（Intel NPU） | | | | | | 等待 NPU 版 ONNX 模型 |
| `onnx-qnn` | 规划中（Qualcomm NPU） | | | | | | 等待 NPU 版 ONNX 模型 |

### 4.3 硬件检测与推荐

`src/hardware.ts` 经 `nvidia-smi` 读取 NVIDIA 显卡、驱动版本与计算能力，经系统设备列表读取其他显卡与 NPU
（Windows 的 `ComputeAccelerator` 设备类，Linux 的 `/sys/class/accel`；Apple Silicon 记为 Neural Engine）。
每个运行包得到一个适配结论：`ok`、`no_build`（本平台无构建）、`no_nvidia_gpu`、`gpu_too_old`、
`driver_too_old`（附所需驱动版本，请用户自行从 NVIDIA 更新）。

| NVIDIA 架构（计算能力） | 代表型号 | FP16 | BF16 | 建议 |
| --- | --- | --- | --- | --- |
| Blackwell（12.x） | RTX 50 系列 | 张量核心 | 支持 | `torch-cu128` / `onnx-cuda` |
| Ada Lovelace（8.9） | RTX 40 系列 | 张量核心 | 支持 | 同上 |
| Ampere（8.0–8.7） | RTX 30 系列、A100 | 张量核心 | 支持 | 同上 |
| Turing（7.5） | RTX 20 系列、GTX 16 系列 | 张量核心 | 不支持 | 同上（最低支持的一代） |
| Volta（7.0）、Pascal（6.x）及更早 | Titan V、GTX 10 系列等 | Volta 有张量核心，Pascal 及更早无 | 不支持 | 低于运行包的最低要求：CPU 运行包或云端 |

模型一律不使用 BF16（这些模型在 BF16 下精度下降）。PyTorch 发布版按发布物推荐的 fp32 权重运行；ONNX 交付包
按包内 `runtime-config.json` 指定的图运行。推荐规则：有适配的 NVIDIA 显卡时推荐本机 CUDA 运行包，
否则保持云端；发现 NPU 时只提示“等待 NPU 模型发布”。

## 五、模型

| 系列 | 云端模型 id | 本机发布名 | 参数量 |
| --- | --- | --- | --- |
| mini | `vulcan-decision-shell-v1-mini-preview` | `vulcan-decision-shell-v1-mini` | 0.2B |
| flash | `vulcan-decision-shell-v1-flash-preview` | `vulcan-decision-shell-v1-flash` | 0.35B |
| standard | `vulcan-decision-shell-v1-preview` | `vulcan-decision-shell-v1` | 0.8B |

**本机模型包**（`src/local/models.ts`）有两种格式：

- `torch-release`：已发布的模型仓库（`manifest.json`、`decision.py`、`runtime/`、`tokenizer/`、`weights/`）。只安装
  运行所需的文件与推荐的 fp32 权重，跳过训练记录、评测数据与实验性权重格式；推理由仓库自带的
  `decision.py` 完成，结果与发布物一致。在 `torch-*` 运行包上运行。
- `onnx-delivery`：ONNX 交付包（`MANIFEST.json`、`runtime-config.json`、`assets/`、图与权重），整体安装，id 为
  `<图文件名>-<图 SHA-256 前 8 位>`。在 `onnx-*` 运行包上运行。

安装（从本地目录或下载）时每个文件都按包自带清单的大小与 SHA-256 校验，写入临时目录，全部通过才换入；
清单中的路径只允许普通相对路径。

**下载点**：每个系列各有三处——Hugging Face、魔搭国际站（modelscope.ai）、魔搭国内站（modelscope.cn）。
目录中按提交（不是分支）固定仓库与 `manifest.json` 的 SHA-256，地址发布前为空，此时下载报错并指向从本地
目录安装。

## 六、命令行

`npx @openvulcan/vulcan-decision …`（数据目录见第四节）：

| 子命令 | 作用 |
| --- | --- |
| `hardware` | 显卡、NPU、每个运行包的适配结论与推荐 |
| `login [--site cn\|global]` / `logout` / `account` | OpenVulcan 登录、退出（注销设备）、查看账号 |
| `cloud models` / `cloud probe [--model <id>]` | 账号可用的云端模型；测量节点 |
| `packs` / `packs install <运行包> [--source official\|cn]` / `packs remove <运行包>` | 运行包管理 |
| `models` / `models install <目录>` / `models download <mini\|flash\|standard> --from <来源>` / `models remove <id>` | 模型管理 |
| `judge --tool <名> --args <json> [--project <目录>] [--cloud <模型> \| --pack <运行包> --model <id>]` | 判定一次调用 |
| `eval --input <文件> --pack <运行包> --model <id>` | 在本机对已渲染的输入批量打分（调试与对照） |

## 七、宿主适配

每个宿主的能力不同，适配层负责把同一个判定结论映射为该宿主能执行的行为。**目前只适配 dsh**；Claude Code
与 Codex 的调查结论保留在下表，两者需要每次调用启动的 hook 客户端，届时再加入。

| 能力 | DeepSeek harness（dsh） | Claude Code | Codex |
| --- | --- | --- | --- |
| 接入点 | 服务端插件监听 `tools/pre-execute` waterfall（`prepend`），覆盖每个原生工具调用与 PTC 内层调用 | `PreToolUse`（allow / deny / ask）、`PermissionRequest` | `PreToolUse`（allow / deny，`ask` 不支持）、`PermissionRequest`（仅升权请求） |
| 结论 | `allow` / `deny` / `ask` / `cancel` | allow / deny / ask | allow / deny |
| 询问用户 | 支持：`ask` 经审批服务，只有“允许一次”放行；审批策略为 `never` 时按拒绝处理 | 支持 | 不支持 |
| 复核 LLM | 经 `ctx.llm.stream` 使用当前会话或用户指定的 provider 与模型 | 自有配置；可评估宿主 `prompt` hook | 必须自有配置与复核标准，因为没有用户兜底 |
| 进程模型 | 插件常驻宿主进程，判定引擎在插件进程内 | 每次调用启动 hook 客户端（后续阶段） | 同左 |
| 失败语义 | 插件抛错或返回 `deny` 均不执行 | `command`/`http` 必须设 `onFailure: "block"`；`mcp_tool` 失败时放行，不得用作闸门 | hook 超时语义待调查 |

### dsh 适配

依据 dsh `0.2.1-rc.2` 源码（`D:\dsh\deepseek-harness`）；dsh 升级后需回读源码核对。

- **形态**：Cordis 插件，以 npm 组合包分发（`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
  通过 `dsh plugin add` 安装到 profile。`engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0`，dsh 包一律作为 peer 依赖。
- **闸门**（`src/index.ts`）：以 `prepend` 注册 `tools/pre-execute` 监听，调用 `engine.judge`，会话中止时随之放弃。
  外层 `run_code` 与 PTC 程序内直接的 Node 副作用不经过该 waterfall，与 dsh 自带 Auto review 的限制相同。
  dsh 先执行该 waterfall、后校验工具参数，因此参数不合法的调用也会被判定（与询问），随后才被 dsh 以参数错误拒绝。
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
- **配置**（`Config`，全部 `.volatile()`，每次操作开始时读取，保存后无需重启；存入 profile 的
  `cordis.patch.yml`）：`mode`（接入方式）、`backend`（`cloud` / `local`，默认 `cloud`）、`cloudModel`（默认 mini）、
  `cloudEndpoint`（锁定的节点，空为自动）、`localPack` 与 `localModel`（本机后端使用的运行包与模型）、
  `downloadSource`（`official` / `cn`）、`review`（`session` / `custom` / `off`，默认 `session`）、`reviewProvider` 与
  `reviewModel`、`allowRules` / `denyRules` / `forbidRules`（自然语言，默认空）、`llmOverridesBlock`（默认
  `false`）、`askTimeout`（秒，0 表示一直等待，最大 3600）、`crossProjectWrites`（默认 `allow`）、
  `databaseReset` 与 `projectReset`（默认 `confirm`）。
- **面板接口**（`src/panel.ts`）：插件经 `connection.fetch.register` 在 dsh 自己的 HTTP 服务上注册
  `/api/vulcan-decision/*`，浏览器端以相对路径调用，沿用 dsh 的访问令牌，不另开端口。GET：`state`、
  `cloud/models`；POST：`signin?site`、`signin/cancel`、`signout`、`cloud/probe?model`、`packs/install?pack&source`、
  `packs/remove?pack`、`models/download?family&source`、`models/install-dir {dir}`、`models/remove?id`、`job/cancel`、
  `test {tool, args}`。应答为 `{ok, value}` 或 `{ok:false, error:{code, message}}`（400 `invalid_request`、
  401 `not_signed_in`、429 `rate_limited`，其余 500）。同一时间只运行一个后台任务（安装运行包或模型），
  阶段为 download / unpack / install / probe / verify / done / failed / cancelled，可取消。`state` 不含任何令牌。
- **设置页**（`client/index.tsx`）：插件自带页面，经 `settings.configure({ auto: false })` 关闭 dsh 自动生成的
  表单，浏览器端注册到 `plugins.bundle.config`，经 `configForms.get('vulcan-decision-guard')` 读写。页面依次为：
  状态（由 `state` 实时得出）、接入方式、判定后端；云端时为 OpenVulcan 账号（站点、登录与取消、退出）、云端
  模型、判定节点（测速、往返与计算耗时、锁定）；本机时为硬件与建议、运行包（适配标签、大小、安装 / 更新 /
  删除与进度、下载源）、本机模型（已安装、按来源下载、从本地目录安装）、使用的运行包与模型（格式不匹配时
  提示）；随后为试判定（安全与高风险两个示例）、授权选项、模型未放行的调用（复核模型，指定模型时从
  `remote.session.modelCatalog()` 选择；允许 LLM 推翻拦截；绝对禁止、拒绝、允许三组规则；询问倒计时）。
  登录或后台任务进行中时每秒刷新一次状态。
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
  时同样撤回，改回自动预设时立即重新注册。插件卸载时停止本机工作进程与后台任务；已安装的运行包与模型
  留在 `$DSH_HOME/vulcan-decision/`，可在面板中删除。

## 八、仓库结构

```
packages/
  vulcan-decision/      @openvulcan/vulcan-decision
    src/                引擎、渲染、硬件检测、下载；cloud/ 账号与节点；local/ 运行包、模型、工作进程
    python/             本机工作进程（随 npm 包发布，由运行包的解释器执行）
    runtime-packs/      运行包锁文件（发布）与 spec.json（不发布）
  dsh-decision-guard/   @openvulcan/dsh-decision-guard：Host 端 src/、浏览器端 client/
scripts/lock_runtime.py 生成运行包锁文件
docs/
```

- **宿主插件**（`packages/<宿主>-decision-guard`）只含宿主适配逻辑，依赖 `@openvulcan/vulcan-decision`，按宿主的
  插件机制安装。
- **判定引擎**（`@openvulcan/vulcan-decision`）为所有宿主共用；后续加入的宿主插件引用同一个包。

## 九、发布与安装

1. **dsh 插件是单个自包含的包。** `pnpm run pack:dsh` 构建两个包后由 `scripts/pack-dsh-plugin.mjs` 生成
   `dist/openvulcan-dsh-decision-guard-<版本>.tgz`：判定引擎以 `bundleDependencies` 打进插件自己的
   `node_modules/`，安装时不再到任何 registry 查找引擎。发布插件时发布这个 tgz（`npm publish <tgz>`），不要在
   `packages/dsh-decision-guard` 里直接 `pnpm publish`，否则引擎会变成外部依赖。`@openvulcan/vulcan-decision`
   另行发布，只供命令行与日后的其他宿主使用。两个包都没有安装脚本，dsh 不会弹出“允许脚本”提示。
2. 用户执行 `dsh plugin add @openvulcan/dsh-decision-guard`（发布前可直接 `dsh plugin add <tgz 路径>`），只装这一个
   包；在插件设置页登录 OpenVulcan 即可使用云端判定。
3. 需要本机判定时，在设置页切到“本机模型”，按硬件建议安装运行包，再下载模型（地址发布后）或从本地目录
   安装，最后选择运行包与模型并保存。

运行包与模型权重都不进入 npm 包，也不使用 `postinstall` 下载；可执行文件与大文件一律不提交到仓库。

## 十、验证记录

2026-10-26，Windows 11、RTX 5080（驱动 610.88）、dsh `0.2.1-rc.2`：

- **单元测试**：核心包 32 项、插件 26 项全部通过。覆盖登录（回环、取消、刷新、轮换中断后要求重新登录、
  退出注销）、节点（模型、测速选择与滞回、锁定、401 续期重试、429 / 503、未登录、应答校验）、硬件推荐
  （CUDA、驱动过旧、显卡过旧、仅 CPU 与 NPU、无构建）、下载（镜像改写、无镜像拒绝、`.part` 续传、摘要不符
  拒绝）、模型清单（不安全路径、torch 发布版子集、ONNX id）、面板（经路由登录、凭据存为 dsh grant 记录、
  状态不含令牌、测速与试判定、参数校验、退出后 401）。云端部分全部使用本地模拟的 OpenVulcan 与节点。
- **运行包**：`onnx-cpu`、`torch-cpu` 从官方源完整下载、校验、安装与探测通过。`onnx-cpu` 运行 164M ONNX 交付包
  （`risk164-attention-fp32-5a4c35b5`）：加载 0.6 秒，4 条样例 0.4 秒，结论 allow / allow / review / allow、
  token 数 260 / 247 / 230 / 231，与交付包自带的验证结果一致。`torch-cpu` 运行 mini 发布版：加载 13 秒，6 条
  样例 1.7 秒，结论 allow / allow / review / allow / allow / review。`onnx-cuda`（1307 MiB）安装后工作进程探测到
  CUDA 执行器；运行同一 164M 包时会话强制使用 CUDA（禁用回退到 CPU），加载 1.4 秒，6 条样例 0.21 秒，结论与
  token 数与 CPU 相同，logits 最大差 0.004。`torch-cu128`（2797 MiB）安装后 torch 2.9.1+cu128 识别 RTX 5080
  （计算能力 12.0）；运行 mini 发布版加载 16.6 秒，6 条样例 0.41 秒，结论与 token 数与 `torch-cpu` 相同，logits
  最大差 0.0008。四个运行包均从官方源下载，Windows x64 上安装与运行通过。
- **dsh 端到端**：在隔离的 `DSH_HOME` 中用 `dsh plugin add` 安装打包后的插件，用本地脚本化的 Messages 模拟
  服务代替付费模型、用本地模拟的 OpenVulcan（中国站，两个节点，其中一个加 40 ms 延迟）代替真实服务：
  设置页默认云端；经面板登录（授权页、回环回调）后状态显示云端模型“正常”，凭据写入 dsh 的
  `.credentials.yaml`；测速选中较快的节点；试判定 allow。Auto 预设会话中 `git status` 经云端放行并执行（未经
  复核 LLM）；`DROP DATABASE` 判为 review，复核 LLM 答 review 后显示本插件的询问卡片（含 LLM 理由），拒绝后
  模型收到“未执行”。切到本机后经面板下载安装 `onnx-cpu`（进度、阶段、单任务锁定）、从目录安装 164M 模型，
  试判定 `git status` allow（首次 881 ms，含加载）、`DROP DATABASE` review（190 ms）。
- **单包安装**（2026-10-27）：`pack:dsh` 生成的 110 KiB tgz 在全新的隔离 `DSH_HOME` 中经 `dsh plugin add` 安装，
  pnpm 只新增这一个包、不需要任何 `overrides`；dsh 启动后插件加载，面板 `state` 从内置引擎读出四个运行包、
  NPU 规划项与模型目录。
- **Windows 路径长度**：数据目录较深时 torch 运行包的 pip 安装因路径超过 259 字符失败，已改为安装前检查并
  报告可用长度。
- **此前已验证、本次未改动的部分**：复核、规则与无人值守的结论映射，冲突提示与 Auto 接管，设置页深色模式，
  接入方式切换（见提交历史中的验证记录）。
- **尚未验证**：真实 OpenVulcan 服务与真实模型下载地址（均未发布）；Linux 与 macOS；国内镜像下载源的完整
  安装（只验证了地址改写，阿里云镜像在本机实测约 0.3 MB/s）；复核 LLM 对真实模型的调用（只用模拟服务与单元测试验证）。

已知的模型行为（0.2B 预览版，按当前训练数据）：`iwr … | iex` 这类下载后直接执行的命令被判为 allow；
未在训练中出现的工具（如 `web_fetch`、计划任务、MCP 工具）多判为 allow。

## 十一、待决定与待调查

1. 本机模型三个系列在三处下载点的地址（发布后填入 `MODEL_CATALOG`）。
2. NPU 运行包：等待为 Intel（OpenVINO）与 Qualcomm（QNN）导出的 ONNX 模型；AMD NPU 暂无计划。
3. dsh 接入方式的默认值：目前为自动预设。
4. 运行包锁文件的更新节奏（Python、onnxruntime、torch 的安全更新）。
5. （后续阶段）Codex hook 超时与崩溃时的行为，以及 Codex 桌面版与 IDE 扩展是否执行 hook。
