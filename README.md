# dsh-model-usage

DSH（DeepSeek Harness）Web 插件：在侧栏底部常驻显示模型供应商的额度与本机用量，点击打开双列详情弹窗。

作者：Antecer · 许可：MIT

## 功能

- **侧栏底部入口**：当前（或最紧急）供应商的图标、名称与一行额度摘要
- **双列详情弹窗**：左列供应商列表，右列选中供应商的额度详情与本机用量（限高 74vh，内容滚动）
- **额度数据**：服务商接口返回的真实余额 / 剩余额度 / 订阅窗口（5h、日、周、月）与重置倒计时
- **本机用量**：今日与近 7 天的模型调用数、消耗 Tokens、缓存命中率、使用趋势与最近请求
- **sub2api 中继自动识别**：从 DSH profile 读取供应商 baseURL 与凭据引用，自动探测 `GET /v1/usage`，无需手动配置
- **零配置凭据复用**：查询模板按 profile 中的 baseURL 自动匹配（host 精确匹配），凭据直接复用 provider 的 `apiKeyEnv`，多账号互不串号；`credentials` / `adapters` 只在需要覆盖默认行为时才配置。插件 Host 进程没有 profile 环境变量时，按当前 llm 路由命中数自动识别正在运行的 profile
- **模板字符串**：卡片摘要可用 `card.template` 自定义排列

## 安装

要求 DSH `>= 0.2.0-rc.2 < 0.3.0`。

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-model-usage
```

安装后重启宿主并刷新页面。

## 改动生效方式

- **`lib/client.js`（界面）**：刷新页面即可
- **`lib/index.mjs` / `lib/adapters.mjs` / `lib/profile.mjs`（Host 取数）**：在插件列表里重启本插件即可，无需重启整个应用
- **profile 配置（`cordis.patch.yml`）**：插件侧 60 秒内自动感知；聊天侧的 provider 变更需重载宿主

## 供应商支持

| 供应商 | 接口 | 展示 |
|---|---|---|
| DeepSeek API | `api.deepseek.com/user/balance` | 余额（总/充值/赠金） |
| DeepSeek 账号 | DSH `deepseekAccount` 服务 | 账号钱包 |
| GLM Coding Plan | `open.bigmodel.cn` / `api.z.ai` 额度接口 | 5h / 周 / 每月 MCP 次数 |
| Kimi Coding | `api.kimi.com/coding/v1/usages` | 周 + 滚动窗口 |
| Moonshot / Kimi 平台 | `api.moonshot.{ai,cn}/v1/users/me/balance` | 余额 |
| OpenRouter | `openrouter.ai/api/v1/credits` | credits 余额 |
| MiniMax Token Plan | `api.minimax.io` / `api.minimaxi.com` `/v1/token_plan/remains` | 5h + 周 |
| OpenCode Go | `opencode.ai/zen/go/v1/usage` | 5h / 周 / 月 |
| 小米 MiMo | `platform.xiaomimimo.com/api/v1/balance` | 余额 |
| GitHub Copilot | `api.github.com/copilot_internal/user` | Premium / Chat / 补全配额 |
| **sub2api 中继** | `{baseURL}/v1/usage`（自动识别） | 剩余额度 / 速率窗口 / 订阅限额 / 余额 |

没有公开额度接口的供应商（OpenAI、Anthropic 等）自动隐藏，不报错。

## 配置

`cordis.patch.yml` 中 `model-usage` 行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `refreshSeconds` | 60 | 额度刷新间隔（秒，最小 1） |
| `footer` | true | 是否显示侧栏底部入口 |
| `credentials` | `{}` | 按路由覆盖凭据引用（可选；缺省复用 provider 在 profile 中的 `apiKeyEnv`） |
| `adapters` | `{}` | 按路由显式指定查询模板（可选；缺省按 profile 的 baseURL 自动识别，见下） |
| `sub2api` | `{}` | 按路由显式指定 sub2api 端点：`{ baseURL, keyRef }`（缺省自动从 profile 探测） |
| `glm` | `{}` | GLM 高级参数：`organization` / `project` / `planType` |
| `card.template` | `""` | 卡片摘要模板字符串（见下） |

### 适配器自动识别

查询模板按以下优先级解析：**`adapters` 显式指定 → profile 中 provider 的 `baseURL` 匹配内置模板（host 精确匹配）→ 内置路由名匹配 → sub2api 探测**。

内置模板覆盖 Kimi Coding（`api.kimi.com/coding/*`）、Moonshot、GLM Coding（`api.z.ai` / `open.bigmodel.cn`）、DeepSeek、OpenRouter、MiniMax、OpenCode Go、小米 MiMo 等。用量接口地址与响应解析都内置在插件代码里，profile 中的 provider 只需有 `baseURL` + `apiKeyEnv` 即可显示额度，无需在插件配置里重复书写凭据。

凭据引用优先级：`credentials` 显式覆盖 > provider 自己的 `apiKeyEnv`（一旦配置即为唯一来源，不回退到共享默认值，多账号不串号）> 适配器默认环境变量 > 路由名派生。

### 卡片模板

```yaml
config:
  card:
    template: "{name} 剩 {remaining}（{window} {leftPct}）"
```

可用变量：`{name}` `{route}` `{plan}` `{remaining}` `{limit}` `{used}` `{usedPct}` `{window}` `{leftPct}` `{resetIn}` `{balance}` `{currency}`。

默认布局（不配置模板时）按 **剩余额度 → 订阅窗口 → 余额** 的顺序自动选择，即优先剩余模式，API 没有剩余数据时退化到余额模式。

## 数据口径

- **额度**：服务商接口返回的真实值（剩余额度 / 余额 / 窗口已用百分比）
- **本机用量**：`assistant/message` 事件中服务商回传的 usage（input + cacheRead + cacheWrite + output）
- **缓存命中率**：cacheRead / (cacheRead + input)
- **统计范围**：本机、插件启用后写入会话日志的调用；其他设备与旁路调用不计
- 账本文件：`$DSH_HOME/model-usage/ledger.json`（按日聚合，保留 120 天）
- **不做金额估算**：订阅套餐按套餐额度计费，金额以服务商账单为准

## 安全

- API Key 只在 Host 内存中解析使用，不进入浏览器，任何 RPC 响应都不含密钥
- 内置适配器只请求写死的服务商域名；sub2api 探测只访问 profile 中用户自己配置的供应商 baseURL
- 错误信息脱敏（`sk-*` / `Bearer *` 等凭据形态会被打码）
- 账本只存用量聚合数字，不含对话内容

## 开发

```bash
node --check lib/index.mjs lib/adapters.mjs lib/profile.mjs lib/ledger.mjs lib/client.js
node --test test/
```

注意：插件客户端必须单文件交付（DSH ModuleLoader 按包名注册模块，不支持相对路径 require），浏览器侧只有 `lib/client.js` 一个文件，`trackCurrentRoute`（会话跟随）与 `createTicker`（秒级 ticker）等逻辑直接内联其中，即唯一实现；client 测试通过抽取内联函数的方式直接回归发布产物。Host 侧文件统一使用 `.mjs` 后缀，与浏览器脚本区分。

架构与 API 查询方式详见 [docs/architecture.md](docs/architecture.md)。
