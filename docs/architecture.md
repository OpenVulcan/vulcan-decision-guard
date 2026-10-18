# Vulcan Decision Guard 架构草案

> 状态：第一版骨架（仅 dsh），判定后端尚未实现。宿主能力以各宿主官方文档为准，标注“待调查”的条目在实现前必须先验证。

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

判定不能在每次工具调用时冷启动：本机模型加载需要数秒，云端连接也需要握手。因此判定由每个用户
唯一的常驻进程 `vulcan-decision serve` 承担，所有宿主插件共用它。

- **端点**：Windows 为 named pipe `\\.\pipe\vulcan-decision-<用户名>.sock`，Unix 为
  `~/.vulcan-decision/run/serve.sock`（目录权限 0700）。端点位置只在 `decision-core::endpoint_path`
  定义一次，其他语言通过 `vulcan-decision endpoint` 读取，不自行拼接。
- **协议**：每行一个 JSON 帧（上限 16 MiB），每个请求携带 `contract` 版本；版本不一致时服务返回
  `contract_mismatch`。`ensure` 发现旧版服务时先请求其退出，再启动当前版本。
- **单例**：`serve.lock` 文件锁保证同一用户只有一个服务进程。
- **生命周期**：无连接且空闲 30 分钟后退出。宿主插件运行期间保持一条 keepalive 连接，因此服务
  不会在宿主运行时退出；keepalive 断开时插件在下一次判定前重新拉起服务。
- **启动**：`ensure` 以完全脱离的方式启动 `serve`（Windows 还会取消标准句柄继承，否则读取 `ensure`
  输出的宿主会一直等到服务退出）。

子命令：

| 子命令 | 作用 |
| --- | --- |
| `serve` | 常驻判定服务 |
| `ensure` | 确保当前版本的服务在运行，必要时启动；失败返回非零 |
| `endpoint` | 输出 `{"endpoint","contract","version"}` |
| `status` / `stop` | 查询与停止服务 |
| `login` / `logout`（规划） | OpenVulcan 账号（OAuth）；令牌不写入日志、错误或命令输出 |
| `model list\|use\|install\|verify`（规划） | 完整版的模型包管理 |

实测（Windows，空判定）：插件首次 `ensure` + `endpoint` + keepalive 约 140 ms，只发生一次；之后每次
判定在宿主进程内约 0.2 ms（p95 0.4 ms）。云端精简版的 `serve` 只持有账号会话与连接，不加载模型。

当前尚无判定后端，服务对每个调用都返回拒绝。

## 五、宿主适配

每个宿主的能力不同，适配层负责把同一个判定结论映射为该宿主能执行的行为。**第一版只适配 dsh**；
Claude Code 与 Codex 的调查结论保留在下表供后续阶段参考，两者需要每次调用启动的 hook 客户端，
届时再加入。

| 能力 | DeepSeek harness（dsh，第一个适配） | Claude Code | Codex |
| --- | --- | --- | --- |
| 接入点 | 服务端插件监听 `tools/pre-execute` waterfall（`prepend`），覆盖每个原生工具调用与 PTC 内层调用 | `PreToolUse`（allow / deny / ask）、`PermissionRequest` | `PreToolUse`（allow / deny，`ask` 不支持）、`PermissionRequest`（仅升权请求） |
| 结论 | `allow` / `deny` / `ask` / `cancel` | allow / deny / ask | allow / deny |
| 询问用户 | 支持：`ask` 经 `ctx.approval`，只有 `allowed-once` 放行 | 支持 | 不支持 |
| 复核 LLM | 可经 `ctx.llm.stream` 直接使用当前 agent 的 provider 与模型 | 自有配置；可评估宿主 `prompt` hook | 必须自有配置与自定义复核标准，因为没有用户兜底 |
| 控制界面与登录 | 宿主内：设置页分节、UI slot、`dsh-authorization` 登录 flow | 命令行 | 命令行 |
| 进程模型 | 插件常驻宿主进程，在 effect 生命周期内管理 `serve`，无每次冷启动 | 每次调用启动 hook 客户端（后续阶段） | 每次调用启动 hook 客户端（后续阶段） |
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
  | 自动预设（`auto`） | dsh 原生权限选择器中选择 | 仅当前预设为 `auto` 的会话 | 无（Full access） | 实现简单 |
  | 独立开关 | 本插件设置页 | 开关打开时所有会话，叠加在所选预设之上 | 保留所选预设的沙箱 | 需处理与各预设的组合 |

- **与 Auto review 的关系：替代，不共存。** 两者功能相同（逐调用审查后放行），本插件安装后 Auto review
  没有存在意义，因此不实现让出、协调或双重审查逻辑，只做冲突检测与提示：
  - 冲突的判定：dsh 的 Auto review 组合包（`@deepseek-ai/dsh-experimental-auto-review`）与本插件同时启用。
    与谁占用 `auto` 无关：无论先后，总有一方不生效。
  - 提示（插件的浏览器端，`client/index.tsx`）：经 `pluginManager.listBundles()` 读取 Auto review 是否启用，
    收到 `plugin-manager/changed` 或连接重置时重读。冲突时在两个插件的详情页标题旁显示“冲突”标签
    （`plugins.detail.badge`），并在页内显示说明与“停用自动授权审查”按钮（`plugins.detail.section`），
    按钮调用 `pluginManager.setBundleEnabled(…, false)`。dsh 固定 Auto 选项的名称与说明，无法在权限选择器内标注。
  - 接管：Host 端在启动及每次 `permission-presets/catalog-changed` 时尝试注册 `auto`；被占用则跳过，
    对方停用、槽位释放后自动接管，无需重启或重装。
  - 插件加载绝不因冲突失败：`auto` 被占用时不注册；`registerAuto` 因竞态抛错时捕获，按“已占用”处理。
    若本插件先注册，后加载的 Auto review 会在它自己的注册处报错（插件页显示“异常”），这是预期的冲突结果。
- **自动预设方式的卸载与切换**：参照 Auto review：先停止接收，把仍处于 `auto` 的会话迁回配置预设，
  再撤回注册。

## 六、仓库结构

```
crates/
  decision-core/        协议、帧格式、端点位置（所有组件共用）
  decision-cli/         vulcan-decision 可执行文件：serve / ensure / endpoint / status / stop
  decision-cloud/       （规划）OpenVulcan 账号与 OAuth、云端判定客户端
  decision-local/       （规划）ONNX 推理、模型包校验、设备探测（仅完整版）
packages/
  dsh-decision-guard/   dsh 插件 @openvulcan/dsh-decision-guard：Host 端 src/、浏览器端 client/（构建为 lib/client.js）
scripts/
  stage-native.mjs      生成各平台 npm 包
docs/
```

一个仓库同时容纳两类产物：

- **宿主插件**（`packages/<宿主>-decision-guard`）：只含宿主适配逻辑，体积小，按宿主的插件机制安装。
- **原生服务**（`vulcan-decision`）：所有宿主共用的常驻判定服务，以平台 npm 包分发，由宿主插件的
  `optionalDependencies` 引入。后续加入的宿主插件引用同一组平台包，不重复打包。

## 七、发布与安装

平台包的集合只定义一次：dsh 插件 `package.json` 的 `optionalDependencies`
（`@openvulcan/vulcan-decision-<os>-<cpu>`，os/cpu 采用 Node 的 `process.platform` / `process.arch`）。
`scripts/stage-native.mjs` 只维护它们到 Rust target 的映射，两边不一致时拒绝执行。

| 平台包 | Rust target |
| --- | --- |
| `win32-x64` | `x86_64-pc-windows-msvc` |
| `linux-x64` | `x86_64-unknown-linux-gnu` |
| `linux-arm64` | `aarch64-unknown-linux-gnu` |
| `darwin-arm64` | `aarch64-apple-darwin` |
| `darwin-x64` | `x86_64-apple-darwin` |

发布顺序：

1. 各平台执行 `cargo build --release --target <triple>`。
2. `node scripts/stage-native.mjs` 在 `dist/npm/` 生成平台包：`bin/vulcan-decision[.exe]` 与带
   `os`/`cpu`（Linux 另加 `libc: glibc`）的 `package.json`。脚本校验 Cargo 工作区版本、插件版本与
   平台包依赖版本三者相同，任一缺少构建即失败。
3. 先发布全部平台包，再发布 `@openvulcan/dsh-decision-guard`；否则用户安装插件时会解析不到平台包。

安装：

```
dsh plugin add @openvulcan/dsh-decision-guard
```

`dsh plugin add` 在 profile 内通过 pnpm 安装，pnpm 依据 `os`/`cpu` 只下载当前机器的平台包；插件也可
列入 dsh 插件市场的 JSON 索引。插件声明 `engines.dsh`（当前 `>=0.2.1-rc.2 <0.3.0`），dsh 包一律作为
peer 依赖。插件加载时按 `@openvulcan/vulcan-decision-<platform>-<arch>/package.json` 解析执行文件，
没有当前平台的构建时不阻止插件加载，而是让每次判定失败即拒绝。开发时可用环境变量
`VULCAN_DECISION_BIN` 指向本地构建。

不使用 `postinstall` 下载；模型权重与 CUDA 执行库不进入 npm 包。

## 八、待决定与待调查

1. 云端精简版与完整版是两个 npm 包，还是同一个包按需下载本机运行时。
2. OpenVulcan OAuth 的登录方式：设备码流程，还是本机回环重定向。
3. 复核 LLM 的默认提供方与配置位置。
4. dsh 接入方式的默认值：骨架暂定自动预设，尚未最终决定。
5. Windows named pipe 目前使用默认 ACL，需要收紧为仅当前用户。
6. 已在 dsh 0.2.1-rc.2（npm `next`）中验证：`dsh plugin add` 安装打包后的插件、插件加载并拉起服务、
   权限选择器出现 Auto；两种加载顺序下的冲突提示、“停用自动授权审查”按钮及停用后自动接管 Auto。
   尚未验证实际工具调用的拦截（需要模型调用）。
7. （后续阶段）Codex hook 超时与崩溃时的行为，以及 Codex 桌面版与 IDE 扩展是否执行 hook。
