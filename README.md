# Vulcan Decision Guard

为 AI 编码工具提供的权限守卫插件。AI 代理每次调用工具前，先由 Vulcan Decision 模型判断这次调用：
安全的直接放行，拿不准的交给复核 LLM 或由你确认，危险的拦截。

> 状态：v1 预览版，目前只支持 DeepSeek harness（dsh `0.2.1-rc.2`）。OpenVulcan 云端服务与本机模型的下载地址
> 尚未发布，本机模型暂时从本地目录安装。设计与验证记录见 [docs/architecture.md](docs/architecture.md)。

## 组成

| 包 | 作用 |
| --- | --- |
| [`@openvulcan/vulcan-decision`](packages/vulcan-decision) | 判定引擎（OpenVulcan 云端或本机模型）、账号、运行包与模型管理、命令行 |
| [`@openvulcan/dsh-decision-guard`](packages/dsh-decision-guard) | dsh 插件：拦截工具调用、换算成模型的输入格式、执行判定结论，并提供设置面板；发布时内含判定引擎 |

两者都是纯 Node 包（Node ≥ 20.19），没有原生依赖与安装脚本。dsh 用户只安装插件这一个包（约 110 KB）。

## 云端与本机

默认安装只有云端判定：在插件设置页登录 OpenVulcan 账号（中国站或国际站）即可使用，本机不安装任何运行库。
需要工具调用内容不出本机时，可在设置页切到“本机模型”，按需安装一个**运行包**：

| 运行包 | 适用 | Windows x64 下载量 |
| --- | --- | --- |
| `onnx-cpu` | 任意电脑，运行 ONNX 模型 | 56 MiB |
| `onnx-cuda` | NVIDIA 显卡（RTX 20 系列及以上），运行 ONNX 模型 | 1307 MiB |
| `torch-cpu` | 任意电脑，运行 PyTorch 发布版模型 | 173 MiB |
| `torch-cu128` | NVIDIA 显卡（RTX 20 系列及以上），运行 PyTorch 发布版模型 | 2797 MiB |

运行包是预编译的 Python 与官方 wheel，每个文件按锁定的 SHA-256 校验；**不编译任何东西，也不安装或更新
驱动**，CUDA 库来自 NVIDIA 官方 wheel，只要求显卡驱动版本足够。没有现成运行库的显卡（AMD、Intel、Apple）
使用 CPU 运行包或云端。NPU（Intel、Qualcomm）运行包已预留，等待为 NPU 导出的模型发布。设置页会检测显卡、
驱动与计算能力并给出建议。国内网络可选“国内镜像”下载源（npmmirror、阿里云）。

## 安装（dsh）

```sh
dsh plugin add @openvulcan/dsh-decision-guard
```

只需安装这一个包：判定引擎已打包在插件里。npm 发布之前，可在本仓库执行 `pnpm install && pnpm run pack:dsh`，
再用 `dsh plugin add <仓库>/dist/openvulcan-dsh-decision-guard-0.1.0.tgz` 安装同一个包。

1. 在 dsh 的插件页打开本插件，登录 OpenVulcan；或切到“本机模型”，安装运行包与模型并选择它们。
2. 在 dsh 权限选择器中选择“自动审查”，或在插件设置页把接入方式改为“独立开关”。
3. 用设置页的“试判定”确认判定可用。

也可以用命令行完成同样的操作：`npx @openvulcan/vulcan-decision --help`。

## 判定结论如何执行

判定模型放行的调用直接执行。其余调用（review、block、无法判定）先交复核 LLM，再按会话是否有人值守处理：

| 复核 LLM 的结论 | 有人值守 | 无人值守 |
| --- | --- | --- |
| allow | 执行 | 执行 |
| review（仅有人值守时可选） | 询问你，默认焦点“允许” | — |
| deny | 询问你，默认焦点“拒绝” | 拒绝 |
| forbid（仅有人值守时可选） | 拒绝，不询问 | — |
| 失败或复核已关闭 | 询问你；判定为 review 时默认焦点“允许”，否则“拒绝” | 拒绝 |

- **block 默认不交复核**：被判定模型拦截的调用直接询问你（无人值守时拒绝）。设置页打开“允许 LLM 推翻拦截”后，
  这类调用同样先交复核 LLM，复核放行即执行。
- **复核模型**：当前会话的模型、设置页指定的服务与模型，或关闭。
- **规则**：设置页的“绝对禁止”“拒绝”“允许”三组规则用自然语言书写，交给复核 LLM 按此优先级执行；规则只作用于
  判定模型未放行的调用。复核理由按界面语言书写。
- **询问倒计时**：可设置询问卡片等待的秒数，超时按拒绝处理；0 表示一直等你回答。
- **无人值守**：输入框旁的“无人值守”勾选框按会话保存（也可用 `/vulcan-unattended on|off`）；会话审批策略为
  `never` 时同样按无人值守处理。此时从不弹出询问，复核 LLM 只能放行或拒绝。
- **说明意图**：复核开启时，AI 可调用 `explain_tool_call` 说明下一次调用的目的。说明只交给复核 LLM 并显示在询问
  卡片上，不交给判定模型，也不能单独构成授权。每次被复核拒绝时，AI 都会收到理由并被提示可以先说明再重试。

任何错误（未登录、网络失败、运行包或模型缺失）都不会被当作放行。

## 模型

`vulcan-decision-shell` v1 有三个系列：mini（0.2B，默认）、flash（0.35B）、standard（0.8B），云端与本机都可用。
本机模型将发布在 Hugging Face、魔搭国际站与魔搭国内站。预览版的判定仍在校准，它是沙盒之上的一道防线，
不能取代沙盒。

## 开发

```sh
pnpm install
pnpm -r run typecheck
pnpm test
```

运行包锁文件由 `python -I -B scripts/lock_runtime.py` 生成（需要 uv）。

## 许可

[MIT](LICENSE)
