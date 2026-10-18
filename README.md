# Vulcan Decision Guard

为 AI 编码工具提供的权限守卫插件。AI 代理每次调用工具前，先由 Vulcan Decision 模型判断这次调用：
安全的直接放行，拿不准的交给复核 LLM 或由你确认，危险的拦截。

> 状态：v1 预览版，目前只支持 DeepSeek harness（dsh `0.2.1-rc.2`）。模型暂时从本地目录安装，下载与
> OpenVulcan 云端判定尚未开放。设计与验证记录见 [docs/architecture.md](docs/architecture.md)。

## 组成

| 包 | 作用 |
| --- | --- |
| [`@openvulcan/vulcan-decision`](packages/vulcan-decision) | 常驻判定服务与命令行：在本机用 ONNX Runtime 运行 `vulcan-decision-shell` 模型，所有宿主插件共用 |
| [`@openvulcan/dsh-decision-guard`](packages/dsh-decision-guard) | dsh 插件：拦截工具调用、换算成模型的输入格式、执行判定结论，并提供设置页 |

两者都是纯 Node 包（Node ≥ 20.19），不需要 Rust、Python 或单独下载 ONNX Runtime：
`onnxruntime-node` 自带 Windows、macOS 与 Linux 的 CPU 运行库（Windows 另带 DirectML）。

## 安装（dsh）

1. 安装插件：

   ```sh
   dsh plugin add @openvulcan/dsh-decision-guard
   ```

   pnpm 会拦下 `onnxruntime-node` 的安装脚本，dsh 插件页随之提示“允许这些脚本并重试”。该脚本只在
   Linux x64 上下载 CUDA 执行库，在 Windows 与 macOS 上什么也不做，本插件也不使用 CUDA。允许或在
   profile 的 `pnpm-workspace.yaml` 中写入 `allowBuilds: { onnxruntime-node: false }` 都可以完成安装；
   Linux x64 上建议写入 `false`，以免下载用不到的 CUDA 库。

2. 安装模型（从本地模型目录）：

   ```sh
   npx @openvulcan/vulcan-decision model install <模型目录> --size 0.2b
   npx @openvulcan/vulcan-decision status
   ```

3. 在 dsh 权限选择器中选择“自动审查”，或在插件设置页把接入方式改为“独立开关”。

## 判定结论如何执行

| 判定模型 | 复核 LLM（默认开启） | 结果 |
| --- | --- | --- |
| allow | — | 执行 |
| review | 放行 | 执行 |
| review | 未放行、失败或已关闭 | 询问你 |
| block | 认为已获授权 | 询问你（复核不能单独放行被拦截的调用） |
| block | 未放行、失败或已关闭 | 拒绝，理由返回给 AI |
| 无法判定（模型未安装、服务或模型故障） | — | 询问你 |

超过模型输入上限（由模型包的 `runtime-config.json` 规定，0.2B 预览版为 32768 个 token）的调用按 block 处理。任何错误都不会被当作放行。会话的审批策略不允许询问时（例如无人值守），dsh 把“询问”按拒绝处理。

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
