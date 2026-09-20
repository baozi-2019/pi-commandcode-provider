# 开发指南

## 环境准备

```sh
npm install
```

要求 Node.js ≥ 22（与官方 `command-code` CLI 一致）。`@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 是宿主 pi 打包提供的可选 peer 包，本仓库**不安装**它们——`tests/test-package-manifest.ts` 会校验它们没有出现在 `dependencies`/`devDependencies` 中。入口 `index.ts` 在 `tsconfig.json` 的 include 中，peer 包类型由 `types/peer-shims.d.ts` 的窄化 ambient shim 提供（宿主 pi 升级时按其 d.ts 手动同步签名），运行时包仍不安装、由宿主加载期解析；`npm run typecheck` 覆盖 `index.ts`、`src/` 与 `tests/`。

## 常用命令

| 命令                                      | 作用                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `npm test`                                | 完整检查：typecheck + 全部单测 + pi mock 集成测试 |
| `npm run test:unit`                       | 只跑 `tsx` 单元测试（不访问外网、无 pi 依赖）     |
| `npm run typecheck`                       | `tsc --noEmit`                                    |
| `npm run format:check` / `npm run format` | Prettier 检查/修复                                |
| `npm run pi:isolated`                     | 隔离 pi 配置启动当前工程调试，退出时清理临时目录  |
| `npm run test:e2e:live`                   | 真实 Command Code 付费 E2E（默认跳过，见下）      |

`npm test` 末尾的 `test-pi-isolated`/`test-pi-local` 需要 `pi` 在 `PATH` 上，缺失时自动 SKIP；`test-omp-compat` 需要 `omp`，同样自动 SKIP。测试脚本支持 `PI_LOCAL_REQUIRED=1` / `OMP_COMPAT_REQUIRED=1` 环境变量：设置后 pi/omp 缺失将视为失败而非跳过，供自建 CI 使用。

## 测试约定

- 单元测试用 Node 内置 `node:test` + `node:assert/strict`，直接用 `npx tsx tests/test-xxx.ts` 运行，风格参考 `tests/test-models.ts`。
- 测试必须 hermetic：不访问真实网络。用注入的 `fetchImpl` mock；套餐识别测试参考 `tests/test-plan-resolver.ts` 的 URL 分发写法。
- `tests/test-pi-local.mjs` 是真实 pi 进程的集成测试：mock 服务器按 pathname 匹配（新版 pi 会给 Anthropic 端点加 query string，不能用完整 URL 比较）。**修改套餐相关逻辑时必须保留 `/alpha/whoami` 与 `/alpha/billing/subscriptions` 两个 mock 端点**，否则启动识别失败会改变可见模型集合。
- mock 模型目录优先使用 `src/commandcode-plan-catalog.ts` 中存在的真实模型 ID；假 ID 会被套餐过滤按"未知元数据"隐藏。
- 只服务当前改动的临时测试在通过后删除，不进仓库。

## 安全红线

- 任何文件（含测试夹具、文档、日志样例）不得包含真实 API key、token 或账号信息；测试统一用 `mock-key` 这类虚构值。
- 套餐缓存与模型缓存只存 key 的 sha256 指纹，禁止存明文。
- 错误与诊断输出必须脱敏（`src/runtime.ts` 的 `redactDiagnosticText`、`src/plan-resolver.ts` 的 `safeErrorMessage`）；新增输出路径时同步补脱敏测试。
- live E2E 的 key 只经 `*_API_KEY_FILE` 指向的受保护文件传入，不进 shell 历史、不进仓库。

## 提交规范

使用 Conventional Commits：`<type>(<scope>): <subject>`，type 取值 `feat`/`fix`/`docs`/`style`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`/`revert`；scope 优先用现有领域：`plan`、`models`、`auth`、`stream`、`tests`、`docs`、`release`、`deps`、`ci`。subject 用祈使句、小写开头、结尾不加句号。破坏性变更加 `!` 或 `BREAKING CHANGE:` 脚注。

改动用户可见行为时同步更新 `README.md` 与 `CHANGELOG.md`；涉及发版步骤的更新 `RELEASE.md`。

## 变更审查清单

- [ ] `npm test` 与 `npm run format:check` 通过。
- [ ] 改动文件无 LSP error 级诊断。
- [ ] 新行为有对应测试（单测或 pi-local 用例）。
- [ ] 套餐过滤不变量未被破坏：不明文存 key、未知 planId 不提升权限、未知模型 fail-closed。
- [ ] 未提交 key、`.env`、真实 auth 文件等敏感内容。
