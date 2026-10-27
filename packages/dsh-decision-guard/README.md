# @openvulcan/dsh-decision-guard

DeepSeek harness（dsh）的 Vulcan Decision 权限守卫插件：每次工具调用执行前，由 `vulcan-decision-shell` 模型
判定（默认 OpenVulcan 云端，可选本机），模型未放行的调用可先交复核 LLM（会话模型或指定模型）按你写的规则
复核，再询问你或拒绝；无人值守的会话从不询问。它替代 dsh 自带的实验插件 Auto review，两者不能同时启用。

```sh
dsh plugin add @openvulcan/dsh-decision-guard
```

这是唯一需要安装的包，判定引擎 `@openvulcan/vulcan-decision` 已打包在内。

安装后打开 dsh 的「设置 › 自动审批」：登录 OpenVulcan 账号即可使用云端判定，判定模型与节点由 OpenVulcan
按账号提供；需要本机判定时切到“本机模型”，按硬件建议一键安装运行包与模型。输入框模型选择器左侧的“自动审批”
标签可快速勾选类别授权，设置本会话的复核附加提示词与无人值守，并调整常用设置。设置页可打开“记录判定”，
查看、标记并导出判定记录（只保存在本机）。登录凭据保存在 dsh 的凭据存储中，运行包与模型保存在
`$DSH_HOME/vulcan-decision/`。然后在权限选择器中选择“自动审查”，或把接入方式改为“独立开关”。说明见仓库
[README](https://github.com/OpenVulcan/vulcan-decision-guard#readme)。

许可：MIT
