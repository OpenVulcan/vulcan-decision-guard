# Vulcan Decision Guard

为 AI 编码工具提供的权限守卫插件。AI 代理每次调用工具前，先由 Vulcan Decision 模型判断这次调用：
安全的直接放行，拿不准的交给复核 LLM 或由你确认，危险的拦截。

> 状态：v1 预览版，目前只支持 DeepSeek harness（dsh `0.2.1-rc.2`）。模型下载已就绪但下载地址尚未发布，
> 暂时从本地目录安装；OpenVulcan 云端判定尚未开放。设计与验证记录见 [docs/architecture.md](docs/architecture.md)。

## 组成

| 包 | 作用 |
| --- | --- |
| [`@openvulcan/vulcan-decision`](packages/vulcan-decision) | 常驻判定服务与命令行：在本机用 ONNX Runtime 运行 `vulcan-decision-shell` 模型，所有宿主插件共用 |
| [`@openvulcan/dsh-decision-guard`](packages/dsh-decision-guard) | dsh 插件：拦截工具调用、换算成模型的输入格式、执行判定结论，并提供设置页 |

两者都是纯 Node 包（Node ≥ 20.19），不需要 Rust、Python 或单独下载 ONNX Runtime：
`onnxruntime-node` 自带 Windows、macOS 与 Linux 的 CPU 运行库（Windows 另带 DirectML），Linux x64 上
的 CUDA 执行库由它的安装脚本下载。

## 运行设备与模型格式

服务默认自动选择运行设备：Linux x64 上 CUDA 可用时用 CUDA，Windows 上有显卡时用 DirectML，其余用 CPU；
环境变量 `VULCAN_DECISION_DEVICE=cpu|dml|cuda` 可指定设备，指定的设备不可用时直接报错，不改用其他设备。
GPU 上推荐半精度权重（`fp16-mixed`），CPU 与计算能力低于 5.3 的旧 NVIDIA 显卡推荐全精度（`fp32`）；推荐尺寸
取总内存与显存中较小的一档。`npx @openvulcan/vulcan-decision hardware` 列出本机显卡、各设备是否可用及缺少
什么，以及推荐的尺寸与格式。

CUDA 需要：Linux x64、NVIDIA 驱动（`nvidia-smi` 可用）、允许 `onnxruntime-node` 的安装脚本（它下载 CUDA
执行库），以及系统中的 CUDA 12 与 cuDNN 9（`libcudart.so.12`、`libcublas.so.12`、`libcublasLt.so.12`、
`libcufft.so.11`、`libcurand.so.10`、`libcudnn.so.9`）。onnxruntime-node 在 Windows 上不提供 CUDA，
NVIDIA 显卡在 Windows 上经 DirectML 运行。

## 安装（dsh）

1. 安装插件：

   ```sh
   dsh plugin add @openvulcan/dsh-decision-guard
   ```

   pnpm 会拦下 `onnxruntime-node` 的安装脚本，dsh 插件页随之提示“允许这些脚本并重试”。该脚本只在
   Linux x64 上下载 CUDA 执行库，在 Windows 与 macOS 上什么也不做。Linux x64 上要用 NVIDIA 显卡就允许它；
   不用 CUDA 时在 profile 的 `pnpm-workspace.yaml` 中写入 `allowBuilds: { onnxruntime-node: false }`
   同样可以完成安装。

2. 安装模型：

   ```sh
   npx @openvulcan/vulcan-decision hardware        # 查看推荐的设备、尺寸与格式
   npx @openvulcan/vulcan-decision model download  # 下载推荐的模型（下载地址发布后可用）
   npx @openvulcan/vulcan-decision model install <模型目录> --size 0.2b   # 或从本地目录安装
   npx @openvulcan/vulcan-decision status
   ```

3. 在 dsh 权限选择器中选择“自动审查”，或在插件设置页把接入方式改为“独立开关”。

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

超过模型输入上限（由模型包的 `runtime-config.json` 规定，0.2B 预览版为 32768 个 token）的调用按 block 处理。任何错误都不会被当作放行。

## 模型

`vulcan-decision-shell`，规划 0.2B、0.4B、0.6B 三种尺寸，当前提供 0.2B v1 预览版。预览版的判定仍在校准，
它是沙盒之上的一道防线，不能取代沙盒。

## 开发

```sh
pnpm install
pnpm -r run typecheck
pnpm -r test
```

## 许可

[MIT](LICENSE)
