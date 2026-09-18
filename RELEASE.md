# 发版流程

本项目按 npm semver 发版。预发布先验证，稳定版通过后手动发布。

> **包名冲突**：`pi-commandcode-provider` 的 npm 包名属于上游 patlux，本 fork 不能用它发布。发版前需二选一：
>
> 1. 确定一个新的 npm 包名（如 `@baozi-2019/pi-commandcode-provider`），并同步改 `package.json` 的 `name` 与本文中的冒烟命令；
> 2. 不发布 npm，仅通过 git tag 分发（`pi install git:github.com/baozi-2019/pi-commandcode-provider@<tag>`），此时跳过所有 `npm publish`/`npm view` 步骤。
>
> 下文命令沿用 `pi-commandcode-provider` 占位，执行前按所选方案替换。

## 预发布（next）

用于 beta/手工验证构建：

```sh
npm version prepatch --preid next --no-git-tag-version
npm test
npm run format:check
npm pack --dry-run
npm publish --tag next --access public
```

npm 若要求浏览器或 OTP 认证，手动执行发布命令完成验证。

核对 registry 状态（仅方案 1 需要；方案 2 跳过本节）：

```sh
npm view pi-commandcode-provider@next version dist-tags --json
```

预期：`next` 指向预发版本，`latest` 仍指向上一个稳定版。

## 在 pi 中冒烟测试预发布包

用 git 源安装测试，不要用本地 checkout（npm 包名属于上游，见顶部说明）。先创建并推送预发布 tag，再让 pi 按该 tag 安装：

```sh
git tag v0.1.1-next.0
git push origin v0.1.1-next.0
```

（把 `v0.1.1-next.0` 换成 `npm version` 实际产生的版本号对应的 tag。）

### 1. 模型发现冒烟

```sh
PI_SKIP_VERSION_CHECK=1 \
pi --no-extensions \
  -e git:github.com/baozi-2019/pi-commandcode-provider@v0.1.1-next.0 \
  --list-models commandcode
```

预期：出现 `commandcode` provider，且模型列表被当前 key 的套餐过滤（可用 `COMMANDCODE_PLAN=max` 验证全量，用 `=go` 验证只剩 Go 档模型）。

### 2. 隔离配置下手动 `/login`

使用临时目录，避免污染真实 pi 配置：

```sh
export PI_CC_TEST_AGENT_DIR="$(mktemp -d)"
export PI_CC_TEST_SESSION_DIR="$(mktemp -d)"
export PI_CODING_AGENT_DIR="$PI_CC_TEST_AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$PI_CC_TEST_SESSION_DIR"
export PI_SKIP_VERSION_CHECK=1

pi --no-extensions \
  -e git:github.com/baozi-2019/pi-commandcode-provider@v0.1.1-next.0 \
  --provider commandcode \
  --model deepseek/deepseek-v4-flash
```

在 pi 中执行 `/login`，选择 **Use a subscription** → **Command Code** 完成浏览器授权（回传失败就粘贴 key），然后发送：

```txt
Reply exactly: manual-git-ok
```

预期：登录成功；临时目录的认证文件中有 Command Code 凭据；套餐自动识别后模型列表立即更新；模型精确回复 `manual-git-ok`。

### 3. 登录后的 print 模式

沿用上面的临时环境变量：

```sh
pi --no-extensions \
  -e git:github.com/baozi-2019/pi-commandcode-provider@v0.1.1-next.0 \
  --no-session \
  -p \
  --provider commandcode \
  --model deepseek/deepseek-v4-flash \
  "Reply exactly: manual-git-ok"
```

预期输出 `manual-git-ok`。

### 4. 清理

仅在临时变量由本次测试创建时执行：

```sh
rm -rf "$PI_CC_TEST_AGENT_DIR" "$PI_CC_TEST_SESSION_DIR"
unset PI_CC_TEST_AGENT_DIR PI_CC_TEST_SESSION_DIR
unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR PI_SKIP_VERSION_CHECK
```

## 稳定版

`next` 包验证通过后（方案 2 为预发布 tag 冒烟通过后），设置目标版本：

```sh
npm version 0.1.1 --no-git-tag-version
```

（把 `0.1.1` 换成目标版本号。）更新 `CHANGELOG.md` 后执行检查：

```sh
npm test
npm run format:check
npm pack --dry-run
git diff --check
```

在 release 分支提交并开 PR（目标分支 dev），确认 `npm test` 通过后合并；然后在 `dev` 上打 tag：

```sh
git checkout -b release/0.1.1
git add .
git commit -m "Release 0.1.1"
git push origin release/0.1.1
gh pr create --title "chore(release): publish 0.1.1" --base dev
# 检查通过后合并，然后：
git checkout dev
git pull origin dev
git tag -a v0.1.1 -m "Release 0.1.1"
git push origin v0.1.1
```

> 注：本仓库暂未配置 CI，合并前以本地 `npm test`、`npm run format:check` 结果为准。

发布稳定版（仅方案 1 需要；方案 2 的“发布”即上一步推送 tag，无需额外操作）：

```sh
npm publish --tag latest --access public
```

验证（同样仅方案 1 需要；方案 2 用 `git ls-remote --tags origin` 确认 tag 已推送）：

```sh
npm view pi-commandcode-provider version dist-tags --json
npm view pi-commandcode-provider@0.1.1 version --json
```

预期：`latest` 指向新版本，registry 上存在该版本。

## 发布后跟进

仅在版本实际包含对应改动时，到相关 PR/issue 留言：

```sh
gh pr comment <number> --body "Shipped in pi-commandcode-provider@0.1.1 / tag v0.1.1（或 git 源 tag v0.1.1，按所选发版方案填写）。"
gh issue comment <number> --body "Shipped in pi-commandcode-provider@0.1.1 / tag v0.1.1（同上）。"
```
