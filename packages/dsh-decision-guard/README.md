<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/OpenVulcan/vulcan-decision-guard/main/docs/assets/openvulcan-logo-dark.svg">
  <img src="https://raw.githubusercontent.com/OpenVulcan/vulcan-decision-guard/main/docs/assets/openvulcan-logo-light.svg" alt="OpenVulcan" width="360">
</picture>

# @openvulcan/dsh-decision-guard

[简体中文](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.md) | [English](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.en.md) | [繁體中文](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.zh-TW.md) | [日本語](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.ja.md) | [한국어](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.ko.md) | [Español](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.es.md) | [Français](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.fr.md) | [Deutsch](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.de.md) | [Русский](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.ru.md) | [Português](https://github.com/OpenVulcan/vulcan-decision-guard/blob/main/README.pt-BR.md)

```sh
dsh plugin add @openvulcan/dsh-decision-guard
```

## 简体中文

DeepSeek harness（dsh）的 Vulcan Decision 权限守卫插件。每次工具调用执行前，专用判定模型只看项目目录、工具名
与参数，给出放行、需确认或拦下；未放行的调用可先交复核 LLM 按你写的规则复核，再询问你或拒绝，无人值守的会话
从不询问。任何错误都不会被当作放行。

- **云端命令判定模型永久免费提供**（2026 年 10 月 27 日承诺），登录 OpenVulcan 账号即可使用；也可以切到本机模型。
- 它防的是 AI 执行命令时的**失误**，不防 AI **刻意绕过**（例如先写一个脚本再运行它）。
- 自动审批只降低事故概率，不保证拒绝一切风险；请同时使用沙箱、Git 与备份。

这是唯一需要安装的包，判定引擎已打包在内。安装后打开 dsh 的「设置 › 自动审批」登录，再在权限选择器中选择
“自动审查”，或把接入方式改为“独立开关”。完整说明（判定逻辑、整体流程、LLM 复核方式、评测、使用的组件）见上方
各语言版本。感谢 [LINUX DO](https://linux.do/) 社区的支持与交流。

## English

A Vulcan Decision permission guard plugin for DeepSeek harness (dsh). Before every tool call runs, a dedicated
decision model looks only at the project folder, the tool name and the arguments, and answers allow, review or
block. Calls that are not allowed can first go to a review LLM that follows your rules, then to you or a denial;
unattended sessions never ask. No error is ever treated as allow.

- **The cloud command decision model is free, permanently** (committed on October 27, 2026); sign in to an
  OpenVulcan account to use it, or switch to a local model.
- It guards against the AI's **mistakes** when running commands, not against the AI **deliberately getting
  around it** (for example by writing a script and then running it).
- Auto approval lowers the odds of an accident; it does not guarantee that every risk is refused. Keep using a
  sandbox, Git and backups.

This is the only package to install; the decision engine is bundled inside. After installing, open dsh's
"Settings › Auto approval" to sign in, then choose "Auto review" in the permission picker or switch the integration
to "Standalone switch". The full guide (decision logic, overall flow, how the LLM review works, evaluation, the
components used) is in the language versions linked above. Thanks to the [LINUX DO](https://linux.do/) community
for its support and discussions.

License: MIT
