# 变更日志

本工程 fork 自 [patlux/pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) v0.7.0，本文件只记录 fork 之后的变更；上游完整历史见其 [CHANGELOG](https://github.com/patlux/pi-commandcode-provider/blob/main/CHANGELOG.md)。

## 未发布

- 新增套餐感知模型过滤：模型列表按当前 API key 的 Command Code 套餐（Go/GOAT/Pro/Max）限制。自动识别经 `/alpha/whoami` 与 `/alpha/billing/subscriptions` 读取账户订阅，结果按 key 的 sha256 指纹缓存到 `<agent-dir>/commandcode-plans.json`，不保存明文 key；识别失败时 fail-closed 仅暴露 Go 档模型；官方目录中无最低套餐元数据的模型默认隐藏。
- 新增 `/commandcode-plan [auto|go|goat|pro|max|refresh]` 命令：查看或修改当前 key 绑定的套餐并立即刷新模型列表；新增 `COMMANDCODE_PLAN` 与 `COMMANDCODE_PLAN_CACHE` 环境变量。
- `/commandcode-status` 现在输出生效套餐、来源与 catalog/filtered 模型计数。
- 新增模型最低套餐元数据快照（`command-code@1.56.0`，71 个模型），供过滤逻辑使用。
- 修正安装与发版说明：`pi-commandcode-provider` 的 npm 包名属于上游，安装改用 git 源；RELEASE 补充包名冲突的两种发版方案。
- 移除上游专属文件：`.github/CODEOWNERS` 与 GitHub Actions 工作流配置（引用上游仓库，与本仓库 dev 分支不符）。
- 文档中文化重写（README、CONTRIBUTING、RELEASE、CHANGELOG、AGENTS）。
- 清理上游开发设施：移除 `.agents/` 技能、`.github/scripts/` 目录同步脚本、semgrep/gitleaks 配置、live E2E 脚本与对应 npm 命令及测试引用，仓库仅保留运行/测试/开发所必需的自有文件；模型快照改为按上游 CLI 目录手动刷新（方法见 CONTRIBUTING.md）。
- 上游历史：本工程代码基于 patlux/pi-commandcode-provider（MIT，v0.7.0）开发，LICENSE 保留上游版权声明（MIT 许可要求）。
