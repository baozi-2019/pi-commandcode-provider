obsidian-project: pi-commandcode-provider

# 工程协作规则

## 工程事实

- 本工程是 pi 的 Command Code provider 扩展，fork 自 patlux/pi-commandcode-provider（MIT，v0.7.0），新增套餐感知模型过滤。
- 运行时复用宿主 pi 打包的核心包：`@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 只能以 optional peerDependencies 声明，禁止写入 `dependencies`/`devDependencies`（`tests/test-package-manifest.ts` 会校验）。
- 入口 `index.ts` 在 `tsconfig.json` 的 include 中；peer 包类型由 `types/peer-shims.d.ts` 窄化 shim 提供（签名按宿主 pi d.ts 手动同步），运行时包仍由宿主 pi 加载期解析、本仓库不安装；`npm run typecheck` 覆盖 `index.ts`、`src/` 与 `tests/`。
- 模型能力快照（`src/commandcode-catalog.ts`）与最低套餐快照（`src/commandcode-plan-catalog.ts`）按上游 `command-code` CLI 目录手动刷新，刷新方法见 CONTRIBUTING.md。
- 模型最低套餐元数据快照在 `src/commandcode-plan-catalog.ts`（command-code@1.56.0），上游目录变化时需同步。

## 开发与验证

- 改动代码、测试、文档或提交信息前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；发版流程见 [RELEASE.md](RELEASE.md)。
- 交付前至少运行 `npm run typecheck` 与 `npm test`（本地无 omp 时相关用例自动 SKIP）。
- 全项目 LSP 零 error 是交付基线：`index.ts` 已入 tsconfig include，peer 包类型面由 `types/peer-shims.d.ts` 的窄化 ambient shim 提供（只覆盖 `index.ts` 桥接面，宿主升级时按其 d.ts 手动同步）；peer 运行时包仍不安装（`tests/test-package-manifest.ts` 不变量不变），不得为消除类型错误安装 peer 包或将其写入 `dependencies`/`devDependencies`。
- 改动套餐或模型目录逻辑时，保持 `tests/test-pi-local.mjs` 中 `/alpha/whoami`、`/alpha/billing/subscriptions` mock 端点可用。
- 套餐过滤核心不变量：不保存或输出明文 API key；未知 planId 不提升权限；官方目录外的模型 fail-closed 隐藏。

## 版本控制

- 主开发分支为 `dev`，远程 `origin` = `git@github.com:baozi-2019/pi-commandcode-provider.git`；release PR 目标分支与 tag 均基于 `dev`。
- 未获明确授权不执行 `git commit`、`git push`、打 tag 或发布 npm。
- 提交信息遵循 Conventional Commits（见 CONTRIBUTING.md）。

## 文档

- Obsidian 工程文档由全局 AGENTS.md 第 3 节规则自动维护；工程内开发过程文档放 `.project/plans/`，不写入 Obsidian 文档区。
