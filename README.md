# pi-commandcode-provider

为 [pi](https://github.com/earendil-works/pi) 提供的 [Command Code](https://commandcode.ai) 模型适配器，在标准 provider 能力之上提供**套餐感知模型过滤**：`/model` 中只显示当前 API key 对应套餐可用的模型。

> **免责声明**：这是非官方的社区维护集成，与 Command Code 无隶属、背书或支持关系。你需要自己的 Command Code 账户、API key 以及含 Provider API 访问权限的套餐，并遵守 Command Code 的条款、可用性与价格政策。

## 安装

> 注意：`pi-commandcode-provider` 的 npm 包名属于上游 patlux，从 npm 安装得到的是不含套餐过滤的上游版本。本 fork 通过 git 源安装。

```sh
pi install git:github.com/baozi-2019/pi-commandcode-provider@dev
```

启动或重载 pi 后执行 `/login`：选择 **Use a subscription** → **Command Code**，可浏览器登录或直接粘贴 API key，然后用 `/model` 选择模型。

更新与卸载：

```sh
pi update --extensions
pi remove git:github.com/baozi-2019/pi-commandcode-provider
```

## 套餐感知模型过滤

模型列表按当前 API key 的 Command Code 套餐（Go / GOAT / Pro / Max）过滤，`/model`、`--list-models`、模型循环及直接指定模型都不会暴露套餐外模型。

**自动识别**：扩展启动时用当前 key 请求 `/alpha/whoami` 与 `/alpha/billing/subscriptions` 读取订阅套餐，结果按 key 的 sha256 指纹缓存到 `<agent-dir>/commandcode-plans.json`——**只存指纹，永不保存明文 key**。`/login` 登录成功后也会自动识别并立即刷新模型列表，无需重启。

**失败降级（fail-closed）**：

- 自动识别失败但有缓存：继续使用缓存套餐并提示 stale；
- 无缓存：仅暴露 Go 档模型（而不是全部模型）；
- 官方目录中没有最低套餐元数据的模型默认隐藏，并在 `/commandcode-status` 中报告数量。

**手动指定**：

```txt
/commandcode-plan            # 查看当前套餐、来源、识别时间
/commandcode-plan auto       # 恢复自动识别
/commandcode-plan go|goat|pro|max   # 为当前 key 手动绑定套餐
/commandcode-refresh         # 重新拉取模型目录并强制重识别套餐
```

手动绑定只对当前 key 指纹生效，换 key 不会继承。按量付费的 Provider API key 会被识别为 `provider` 档位，不限制模型。

无交互环境（CI、print/RPC 模式）可用环境变量指定：

```sh
export COMMANDCODE_PLAN="goat"   # auto | go | goat | pro | max
```

## 认证

### 登录对话框

在 pi 中执行 `/login`，选择 **Use a subscription** → **Command Code**：直接回车走浏览器登录，输入 `key` 打开粘贴提示，或直接粘贴 API key。凭据保存在宿主认证文件中。

浏览器自动回传失败时，从 Command Code 页面复制 API key 粘贴到终端提示符即可。

### 环境变量

```sh
export COMMAND_CODE_API_KEY="user_..."
```

### 认证文件

按顺序读取：

- `~/.commandcode/auth.json`
- `~/.pi/agent/auth.json`
- `~/.omp/agent/auth.json`

## 使用

用 `/model` 选择 Command Code 模型；其他扩展（后台 agent、memory worker 等）共用同一连接与凭据。终端可列出模型：

```sh
pi --list-models commandcode
```

非交互模式使用 provider 限定模型 ID：

```sh
pi -p "hello" --model commandcode/deepseek/deepseek-v4-flash
```

**Reasoning**：thinking 档位按官方 CLI 目录注册，只有模型支持的档位可选；部分模型由 Command Code 自动决定推理深度。

**图片输入**：只为官方目录标记了图像输入的模型开启，其余模型按纯文本处理。

## 命令

| 命令                                           | 作用                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/commandcode-plan [auto\|go\|goat\|pro\|max]` | 查看或修改当前 key 的套餐策略，修改后立即刷新模型列表                                                                   |
| `/commandcode-refresh`                         | 刷新动态模型目录；auto 模式同时重识别套餐；失败保留上次可用目录                                                         |
| `/commandcode-status`                          | 脱敏诊断：transport、目录来源/数量、plan 来源、过滤计数、缓存路径                                                       |
| `/commandcode-usage`                           | 5 小时 / 周 / 月限额用量比例（进度条展示），agent 运行中输入也立即返回；TUI 走持久卡片，print/json 输出到 stdout/stderr |

## 环境变量

| 变量                            | 用途                                                                           | 默认值                                |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `COMMAND_CODE_API_KEY`          | Command Code API key                                                           | 无                                    |
| `COMMANDCODE_PLAN`              | 套餐模式：`auto`/`go`/`goat`/`pro`/`max`                                       | `auto`                                |
| `COMMANDCODE_PLAN_CACHE`        | 套餐缓存路径覆盖                                                               | `<agent-dir>/commandcode-plans.json`  |
| `COMMANDCODE_API_BASE`          | 测试/兼容端点覆盖                                                              | 官方地址                              |
| `COMMANDCODE_MODELS_URL`        | 模型目录端点覆盖                                                               | `<api-base>/models`                   |
| `COMMANDCODE_MODELS_CACHE`      | 模型缓存路径覆盖                                                               | `<agent-dir>/commandcode-models.json` |
| `COMMANDCODE_MODELS_TIMEOUT_MS` | 模型目录请求超时                                                               | `10000`                               |
| `CMD_ZDR`                       | 值为 `1` 时发送 `x-cmd-zdr: 1` 零数据保留头（旧别名 `COMMANDCODE_ZDR` 仍生效） | 未启用                                |

`COMMANDCODE_API_BASE`、`COMMANDCODE_MODELS_URL`、`COMMANDCODE_MODELS_CACHE`、`COMMANDCODE_MODELS_TIMEOUT_MS` 仅用于测试与本地 mock。

## 离线行为

模型目录缓存到 `<agent-dir>/commandcode-models.json`：有缓存时立即注册并后台刷新，网络不可用时沿用缓存；首次离线启动则等网络恢复后 `/commandcode-refresh` 成功。套餐识别同理（见上文失败降级）。

## 开发

```sh
npm install
npm test                 # typecheck + 全部单元测试 + pi mock 集成测试
npm run pi:isolated      # 隔离配置启动 pi 调试（退出时清理临时目录）
```

集成测试 `tests/test-pi-local.mjs` 需要 `pi` 在 `PATH` 上，缺失时自动跳过。详见 [CONTRIBUTING.md](CONTRIBUTING.md)；发版流程见 [RELEASE.md](RELEASE.md)。

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。本工程代码基于 patlux 的 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)（MIT）开发，致谢原作者；上游变更历史见其 [CHANGELOG](https://github.com/patlux/pi-commandcode-provider/blob/main/CHANGELOG.md)。模型能力元数据与价格随官方 `command-code` CLI 目录同步。Command Code 的用量与计费以官方为准。
