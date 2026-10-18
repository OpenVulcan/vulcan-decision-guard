# Vulcan Decision Guard 架构草案

> 状态：草案，尚未实现。宿主能力以各宿主官方文档为准，标注“待调查”的条目在实现前必须先验证。

## 一、定位

Vulcan Decision Guard 是一个独立项目，为 Vulcan Code 之外的 AI 编码宿主（Claude Code、Codex、
DeepSeek harness 等）提供工具调用权限守卫。它拥有自己的账号体系（OpenVulcan 账号与 OAuth 登录）、
配置与发布节奏，不依赖 Vulcan Code 仓库。

与 Vulcan Code 的关系是**参考升级**：Vulcan Code 的权限判定实现只作为参考，本仓库按需移植并自行维护；
每次移植在提交说明中记录所参考的 Vulcan Code 提交，不建立代码依赖。

## 二、两个版本

| 版本 | 判定后端 | 分发内容 | 适用 |
| --- | --- | --- | --- |
| 云端精简版 | OpenVulcan 云端判定 | 仅客户端可执行文件，不含 ONNX Runtime 与模型 | 安装最快，无本机算力要求 |
| 完整版 | 本机 ONNX 模型，或 OpenVulcan 云端 | 可执行文件 + ONNX Runtime 动态库；模型包首次使用时下载并校验 | 数据不出本机，可离线 |

两个版本是同一份源码按 Cargo feature 构建的结果，判定协议、结论映射与失败语义完全一致。

模型：`vulcan-decision-shell-{0.2b|0.4b|0.6b}-v1-preview`。尺寸是用户设置，默认依设备探测推荐；
版本号与尺寸不进入仓库名、包名或代码常量之外的任何位置。

## 三、判定管线

每次受管控的工具调用依次经过：

1. **确定性规则**：可直接得出结论的调用（如工作区内只读操作）不进入模型。
2. **判定模型**：给出 allow / review / block。
3. **复核 LLM**：只处理判定模型给出 review 的调用。复核模型与标准由宿主适配决定（见第五节）。
4. **用户**：仅在宿主支持“询问用户”时存在。

**失败即拒绝**：任何一层出错、超时、无法连接或输入超限，都不得放行。这是全项目唯一不可协商的规则，
各宿主适配必须用该宿主的机制落实（见第五节“失败语义”）。

## 四、进程结构

宿主的 `command` hook 每次工具调用都会启动新进程，本机模型不能在其中加载。因此可执行文件
`vulcan-decision` 提供两类子命令：

- `serve`：常驻进程，持有已加载的模型与账号会话，经本机 named pipe / Unix socket 提供判定。
- `hook <host>`：hook 实际调用的轻量客户端。读取宿主 stdin JSON，转交 `serve`，再按宿主格式输出结论；
  找不到 `serve` 时自动拉起；任何失败输出拒绝。
- `login` / `logout` / `status`：OpenVulcan 账号（OAuth）。令牌存入系统钥匙串，不写入日志、错误或命令输出。
- `model list|use|install|verify`：完整版的模型包管理。

云端精简版的 `serve` 只持有账号会话与连接，不加载模型。

## 五、宿主适配

每个宿主的能力不同，适配层负责把同一个判定结论映射为该宿主能执行的行为。

| 能力 | DeepSeek harness（dsh，第一个适配） | Claude Code | Codex |
| --- | --- | --- | --- |
| 接入点 | 服务端插件监听 `tools/pre-execute` waterfall（`prepend`），覆盖每个原生工具调用与 PTC 内层调用 | `PreToolUse`（allow / deny / ask）、`PermissionRequest` | `PreToolUse`（allow / deny，`ask` 不支持）、`PermissionRequest`（仅升权请求） |
| 结论 | `allow` / `deny` / `ask` / `cancel` | allow / deny / ask | allow / deny |
| 询问用户 | 支持：`ask` 经 `ctx.approval`，只有 `allowed-once` 放行 | 支持 | 不支持 |
| 复核 LLM | 可经 `ctx.llm.stream` 直接使用当前 agent 的 provider 与模型 | 自有配置；可评估宿主 `prompt` hook | 必须自有配置与自定义复核标准，因为没有用户兜底 |
| 控制界面与登录 | 宿主内：设置页分节、UI slot、`dsh-authorization` 登录 flow | 命令行 | 命令行 |
| 进程模型 | 插件常驻宿主进程，在 effect 生命周期内管理 `serve`，无每次冷启动 | 每次调用启动 `hook` 客户端 | 每次调用启动 `hook` 客户端 |
| 失败语义 | 插件抛错或返回 `deny` 均不执行；审批无应答为 `unavailable`，即拒绝 | `command`/`http` 必须设 `onFailure: "block"`；`mcp_tool` 失败时放行，不得用作闸门 | hook 超时语义待实测 |

结论映射：

- **allow**：放行。
- **block**：拒绝，并把理由返回给模型。
- **review**：交复核 LLM；复核仍未放行时，支持询问的宿主询问用户，不支持的宿主直接拒绝。

### dsh 适配要点

依据 dsh `0.2.1-rc.2` 源码（`D:\dsh\deepseek-harness`）的插件文档与实现；dsh 升级后需回读源码核对。

- **形态**：Cordis 插件，以 npm 组合包分发（`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
  通过 `dsh plugin add` 安装到 profile，也可列入插件市场 JSON 索引。客户端界面以 `dsh.client` 声明的
  client 模块加载。
- **闸门**：参考 `packages/experimental/auto-review`：在 effect 中以 `prepend` 注册 `tools/pre-execute`
  监听，判定 allow 时继续 `next()`，block 时返回 `deny`，review 时交复核 LLM，仍未放行则返回 `ask`。
  外层 `run_code` 与 PTC 程序内直接的 Node 副作用不经过该 waterfall，与 Auto review 的限制相同。
- **复核 LLM**：`ctx.llm.stream` 使用当前 agent 的 provider 与模型，复核请求不进入会话日志。
- **登录**：向 `dsh-authorization` 注册 OpenVulcan 的 OAuth flow，令牌存入宿主凭据存储
  （`dsh-credentials-local`），设置页发起登录与登出。
- **界面**：设置页分节（`settings.section`）放置后端选择、模型尺寸、复核设置与账号；会话内的判定
  理由显示在工具卡片；其他入口经 `ctx.slots.inject` 贡献到已声明的 slot。
- **与权限预设的关系**：dsh 的权限预设表只允许配置预设与一个固定的 `auto` 槽位；`auto` 同时只能
  由一个集成注册（重复注册会抛错），官方实验插件 Auto review 使用它。`auto` 的组合固定为
  `danger-full-access` 沙箱加 `ask` 审批，即选中 `auto` 的会话没有文件沙箱。
- **接入方式（用户设置，二选一）**：

  | 方式 | 启用位置 | 判定范围 | 沙箱 | 代价 |
  | --- | --- | --- | --- | --- |
  | 自动预设（`auto`） | dsh 原生权限选择器中选择 | 仅当前预设为 `auto` 的会话 | 无（Full access） | 与 Auto review 互斥；实现简单 |
  | 独立开关 | 本插件设置页 | 开关打开时所有会话，叠加在所选预设之上 | 保留所选预设的沙箱 | 需自行处理与各预设、Auto review 的共存 |

- **自动预设方式**：
  - 注册前读取 `ctx.permissionPresets.catalog().options`；`auto` 已被其他集成占用时不注册，设置页说明
    占用情况并建议改用独立开关或停用对方；`registerAuto` 仍可能因竞态抛错，捕获后按“已占用”处理。
    插件加载本身绝不因此失败。
  - 本插件先注册后，再加载的 Auto review 会在它自己的注册处报错，本插件无法阻止，设置页注明两者互斥。
  - 卸载或改为独立开关时，参照 Auto review：先停止接收，把仍处于 `auto` 的会话迁回配置预设，再撤回注册。
- **独立开关方式与 `auto` 共存**：
  - 检测：`catalog().options` 含 `auto` 即表示该槽位已被接管；订阅 `permission-presets/catalog-changed`
    后重新读取目录，跟踪安装与卸载。
  - 调整：会话的 `ctx.permissionPresets.current(session)` 为 `auto` 时，本插件的闸门让出（直接 `next()`），
    由该会话选择的自动审查负责，避免同一调用被两个模型重复审查、产生冲突结论与双倍费用。其他预设下
    照常判定。
  - 提示：开关打开且检测到 `auto` 已被接管时，设置页显示说明；会话切换到 `auto` 时在该会话提示
    一次“本会话由自动审查负责，Vulcan Decision 暂不判定”。

## 六、仓库结构（规划）

```
crates/
  decision-core/     判定协议、调用渲染、结论映射、失败语义（两版共用）
  decision-cloud/    OpenVulcan 账号与 OAuth、云端判定客户端
  decision-local/    ONNX 推理、模型包校验、设备探测（仅完整版）
  decision-cli/      vulcan-decision 可执行文件
hosts/
  claude-code/       插件清单与 hooks 配置
  codex/             插件与 hooks 配置
  dsh/               DeepSeek harness 插件（Cordis 服务端插件 + client 模块）
npm/                 启动脚本与各平台二进制包
docs/
```

npm 采用平台子包分发预编译二进制（`optionalDependencies` + `os`/`cpu`），不使用 `postinstall` 下载。
模型权重与 CUDA 执行库不进入 npm 包。

## 七、待决定与待调查

1. 云端精简版与完整版是两个 npm 包，还是同一个包按需下载本机运行时。
2. OpenVulcan OAuth 的登录方式：设备码流程，还是本机回环重定向。
3. Codex hook 超时与崩溃时的行为，以及 Codex 桌面版与 IDE 扩展是否执行 hook。
4. 复核 LLM 的默认提供方与在各宿主中的配置位置。
5. dsh 接入方式的默认值：自动预设（`auto` 未被占用时）还是独立开关。
