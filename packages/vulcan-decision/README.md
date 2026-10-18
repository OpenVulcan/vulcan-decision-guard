# @openvulcan/vulcan-decision

Vulcan Decision 的常驻判定服务与命令行。它在本机用 ONNX Runtime 运行 `vulcan-decision-shell` 模型，
判断 AI 编码工具的一次工具调用应当放行（allow）、确认（review）还是拦截（block），供各宿主插件共用。

```sh
npx @openvulcan/vulcan-decision hardware
npx @openvulcan/vulcan-decision model download
npx @openvulcan/vulcan-decision model install <模型目录> --size 0.2b
npx @openvulcan/vulcan-decision status
npx @openvulcan/vulcan-decision stop
```

`hardware` 列出本机显卡、CUDA / DirectML / CPU 是否可用（CUDA 还需 Linux x64、CUDA 12 与 cuDNN 9），
以及推荐的模型尺寸与格式；`model download` 默认下载推荐的模型，逐个文件按固定的清单摘要校验，中断后可续传。
下载地址尚未发布，目前用 `model install` 从本地目录安装。运行设备默认自动选择，可用
`VULCAN_DECISION_DEVICE=cpu|dml|cuda` 指定。

数据目录默认为 `~/.vulcan-decision`，可用 `VULCAN_DECISION_HOME` 改到别处。宿主插件通过 `/client` 入口的
`DecisionClient` 连接服务，服务不存在时自动拉起。协议、模型包格式与验证记录见仓库的
[docs/architecture.md](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/docs/architecture.md)。

许可：MIT
