# 变更日志

本工程 fork 自 [patlux/pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) v0.7.0，本文件只记录 fork 之后的变更；上游完整历史见其 [CHANGELOG](https://github.com/patlux/pi-commandcode-provider/blob/main/CHANGELOG.md)。

## 未发布

- 修复交互模式 `/commandcode-usage` 配额表过暗：pi 将 info 通知渲染为主题 dim 前景，现于消息开头注入 SGR 39 前景重置码，pi-tui 解析后回落到终端默认前景色（深浅色终端均适配）；文本内容与格式不变。
- 斜杠命令 `/commandcode-quota` 更名为 `/commandcode-usage`，功能与输出不变；内部模块与标识符（quota.ts、registerCommandCodeQuota 等）保持原名。
- 重做 `/commandcode-usage` 输出：精简为 5 小时 / 周 / 月三条限额用量比例，以进度条（█/░）+ 百分比 + 已用/总额 + 重置/续订倒计时展示；移除 Credits 明细、Plan、Usage、Account 段落。
- 移除 `/commandcode-plan refresh` 子命令：套餐重识别统一由 `/commandcode-refresh` 承担（auto 模式下刷新模型目录前会强制重识别套餐），`/commandcode-plan` 只保留查看与 `auto|go|goat|pro|max` 设置。
- 修复套餐自动识别失败：线上 `/alpha/billing/subscriptions` 返回的 `planId` 带前缀（如 `individual-goat`），`normalizePlanId` 仅做整串精确匹配导致识别为 `unknown` 并 fail-closed 到 Go 档；改为按分隔符切分后整词匹配（多命中取最低档），保持未知标识不提升权限的不变量。
- 模型最低套餐快照补充 `z-ai/glm-5.3-flashx` 与 `meituan/LongCat-2.0`（均为 go 档，依据 commandcode.ai/docs 的 Go/GOAT 套餐页核对，Go 档 46 款与文档计数一致）；此前两个线上模型因快照缺失被 fail-closed 隐藏。
- 修复 `/commandcode-plan refresh|auto` 与 `/commandcode-refresh` 前置套餐刷新崩溃：`refreshPlan(true)` 将 `true` 误传给 apiKey 参数（签名为 `(apiKey, force)`），导致 sha256 指纹计算抛出 “data argument must be of type string … Received type boolean (true)”，套餐识别失败后无法手动恢复；改为 `refreshPlan(undefined, true)` 并补 pi-local 回归用例。
- 新增套餐感知模型过滤：模型列表按当前 API key 的 Command Code 套餐（Go/GOAT/Pro/Max）限制。自动识别经 `/alpha/whoami` 与 `/alpha/billing/subscriptions` 读取账户订阅，结果按 key 的 sha256 指纹缓存到 `<agent-dir>/commandcode-plans.json`，不保存明文 key；识别失败时 fail-closed 仅暴露 Go 档模型；官方目录中无最低套餐元数据的模型默认隐藏。
- 新增 `/commandcode-plan [auto|go|goat|pro|max|refresh]` 命令：查看或修改当前 key 绑定的套餐并立即刷新模型列表；新增 `COMMANDCODE_PLAN` 与 `COMMANDCODE_PLAN_CACHE` 环境变量。
- `/commandcode-status` 现在输出生效套餐、来源与 catalog/filtered 模型计数。
- 新增模型最低套餐元数据快照（`command-code@1.56.0`，71 个模型），供过滤逻辑使用。
- 修正安装与发版说明：`pi-commandcode-provider` 的 npm 包名属于上游，安装改用 git 源；RELEASE 补充包名冲突的两种发版方案。
- 移除上游专属文件：`.github/CODEOWNERS` 与 GitHub Actions 工作流配置（引用上游仓库，与本仓库 dev 分支不符）。
- 文档中文化重写（README、CONTRIBUTING、RELEASE、CHANGELOG、AGENTS）。
- 清理上游开发设施：移除 `.agents/` 技能、`.github/scripts/` 目录同步脚本、semgrep/gitleaks 配置、live E2E 脚本与对应 npm 命令及测试引用，仓库仅保留运行/测试/开发所必需的自有文件；模型快照改为按上游 CLI 目录手动刷新（方法见 CONTRIBUTING.md）。
- 上游历史：本工程代码基于 patlux/pi-commandcode-provider（MIT，v0.7.0）开发，LICENSE 保留上游版权声明（MIT 许可要求）。
