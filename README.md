# Vulcan Decision Guard

为 Claude Code、Codex、DeepSeek harness 等 AI 编码工具提供的权限守卫插件。AI 代理每次调用工具前，
先由 Vulcan Decision 模型判断这次调用是否安全：安全的直接放行，危险的拦截，拿不准的交给复核模型
或由你确认。

> 状态：设计阶段，尚不可用。架构草案见 [docs/architecture.md](docs/architecture.md)。

## 特点

- **两个版本**
  - 云端精简版：通过 OpenVulcan 云端判定，安装轻量，无本机算力要求。
  - 完整版：在本机运行 ONNX 模型（支持 CPU 与 CUDA），数据不出本机，也可切换到云端。
- **失败即拒绝**：判定服务无法连接、超时或出错时一律不放行，绝不静默放过。
- **按宿主适配**：同一判定结论按各宿主能力执行，例如支持询问的宿主可以把拿不准的调用交给你确认，
  不支持询问的宿主改由复核模型按自定义标准决定。
- **一次安装**：通过 npm 分发预编译的 Rust 可执行文件，不需要安装 Rust 或 Python。
- **独立账号**：使用 OpenVulcan 账号登录（OAuth）。

## 模型

`vulcan-decision-shell`，提供 0.2B、0.4B、0.6B 三种尺寸，当前为 v1 预览版。预览版的判定结果仍在校准，
它是沙盒之上的一道防线，不能取代沙盒。

## 许可

[MIT](LICENSE)
