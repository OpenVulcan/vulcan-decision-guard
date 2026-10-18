# @openvulcan/dsh-decision-guard

DeepSeek harness（dsh）的 Vulcan Decision 权限守卫插件：每次工具调用执行前，由本机的
`vulcan-decision-shell` 模型判定，模型未放行的调用可先交当前会话的模型复核，再询问你或拒绝。
它替代 dsh 自带的实验插件 Auto review，两者不能同时启用。

```sh
dsh plugin add @openvulcan/dsh-decision-guard
npx @openvulcan/vulcan-decision model install <模型目录> --size 0.2b
```

安装后在权限选择器中选择“自动审查”，或在插件设置页把接入方式改为“独立开关”。安装时 dsh 会提示是否允许
`onnxruntime-node` 的安装脚本，说明见仓库 [README](https://github.com/OpenVulcan/vulcan-decision-guard#readme)。

许可：MIT
