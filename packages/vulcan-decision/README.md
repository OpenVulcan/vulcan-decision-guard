# @openvulcan/vulcan-decision

Vulcan Decision 的判定引擎与命令行。它判断 AI 编码工具的一次工具调用应当放行（allow）、确认（review）还是
拦截（block），供各宿主插件共用。判定默认走 OpenVulcan 云端节点；也可以按需安装本机运行包，在本机运行
`vulcan-decision-shell` 模型。本包没有原生依赖与安装脚本。

```sh
npx @openvulcan/vulcan-decision login --site cn          # 或 global
npx @openvulcan/vulcan-decision cloud probe
npx @openvulcan/vulcan-decision judge --tool shell_command --args '{"command":"git status"}'

npx @openvulcan/vulcan-decision hardware                 # 显卡、NPU 与推荐的运行包
npx @openvulcan/vulcan-decision packs install torch-cu128 --source cn
npx @openvulcan/vulcan-decision models install <模型目录>
npx @openvulcan/vulcan-decision judge --tool shell_command --args '{"command":"git status"}' --pack torch-cu128 --model <模型 id>
```

运行包（`onnx-cpu`、`onnx-cuda`、`torch-cpu`、`torch-cu128`）是预编译的 Python 与官方 wheel，按锁定的 SHA-256
校验，不编译任何东西，也不安装驱动。数据目录默认为 `~/.vulcan-decision`，可用 `VULCAN_DECISION_HOME` 改到别处；
宿主插件使用自己的目录与凭据存储。设计与验证记录见仓库的
[docs/architecture.md](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/docs/architecture.md)。

许可：MIT
