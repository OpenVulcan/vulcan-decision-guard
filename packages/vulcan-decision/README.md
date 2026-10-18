# @openvulcan/vulcan-decision

Vulcan Decision 的常驻判定服务与命令行。它在本机用 ONNX Runtime 运行 `vulcan-decision-shell` 模型，
判断 AI 编码工具的一次工具调用应当放行（allow）、确认（review）还是拦截（block），供各宿主插件共用。

```sh
npx @openvulcan/vulcan-decision model install <模型目录> --size 0.2b
npx @openvulcan/vulcan-decision status
npx @openvulcan/vulcan-decision stop
```

数据目录默认为 `~/.vulcan-decision`，可用 `VULCAN_DECISION_HOME` 改到别处。宿主插件通过 `/client` 入口的
`DecisionClient` 连接服务，服务不存在时自动拉起。协议、模型包格式与验证记录见仓库的
[docs/architecture.md](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/docs/architecture.md)。

许可：MIT
