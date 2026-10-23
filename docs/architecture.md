# dsh-model-usage 架构

> DSH Web 插件：Host（Node）负责取数与缓存，Client（浏览器）负责展示。
> 跨端数据走带认证的 `/model-usage` 前缀路由；凭据只在 Host 内存。

## 整体结构

```mermaid
flowchart TB
  subgraph Browser["浏览器（Client）"]
    Footer["侧栏底部入口<br/>sidebar.footer.action"]
    Modal["双列详情弹窗<br/>左: 供应商卡片 / 右: 固定摘要 + 四分区统计"]
    Footer -->|点击| Modal
  end

  subgraph Host["Host（dsh-model-usage 插件）"]
    Route["/model-usage 前缀路由<br/>webServer.register + connection.admit"]
    Snap["快照编排<br/>并行取数 · TTL 缓存 · 单飞 · 退避 · 代际失效"]
    Adapters["供应商适配器<br/>lib/adapters.mjs"]
    Probe["sub2api 探测<br/>lib/profile.mjs → profile 配置"]
    Ledger["本机用量账本<br/>lib/ledger.mjs（按日/按会话聚合）"]
    ZAuth["ZCode 会话<br/>lib/zcode/auth.mjs（共享凭据 enc:v1）"]
    ZReset["GLM 额度重置<br/>lib/zcode/reset.mjs + login.mjs"]
    Route --> Snap
    Snap --> Adapters
    Adapters --> Probe
    Route --> ZReset
    ZReset --> ZAuth
  end

  subgraph DSH["DSH 宿主"]
    LLM["ctx.llm.listProviders()"]
    Cred["ctx.credentials.resolve()"]
    Events["session/event"]
    Acct["ctx.deepseekAccount（可选）"]
  end

  subgraph Upstream["服务商接口"]
    DeepSeek["api.deepseek.com/user/balance"]
    GLM["open.bigmodel.cn · api.z.ai"]
    Kimi["api.kimi.com/coding/v1/usages"]
    Others["OpenRouter / MiniMax / OpenCode / 小米 / Copilot…"]
    Sub2["sub2api 中继 · {baseURL}/v1/usage"]
  end

  Footer -.->|POST snapshot / current| Route
  Modal -.->|POST stats / resetUse / zcode*| Route
  Browser -.->|GET style.css / icons| Route
  Snap --> LLM
  Adapters --> Cred
  Adapters --> Acct
  Events --> Ledger
  Events -->|调用后触发刷新| Snap
  Adapters --> DeepSeek & GLM & Kimi & Others
  Probe --> Sub2
  ZReset -->|zcode.z.ai reset status/use| GLM
  Route --> Modal
```

## 适配器解析流程

```mermaid
flowchart TD
  Start([供应商路由 route]) --> Explicit{config.adapters<br/>显式指定?}
  Explicit -->|是| Known{适配器名已知?}
  Known -->|是| Use[使用该适配器]
  Known -->|否| Hide[不显示]
  Explicit -->|否| Url{profile baseURL<br/>匹配内置模板?<br/>host 精确匹配}
  Url -->|是| Use
  Url -->|否| Builtin{内置路由名匹配?<br/>deepseek/zai/kimi/openrouter…}
  Builtin -->|是| Use
  Builtin -->|否| Sub{sub2api 探测}
  Sub -->|config.sub2api 有 baseURL| SubUse[sub2api 适配器]
  Sub -->|profile 供应商有 baseURL| SubUse
  Sub -->|都没有| Hide
  SubUse --> Fetch["GET {baseURL}/v1/usage"]
  Fetch --> Resp{响应含 mode + isValid?}
  Resp -->|是| Use
  Resp -->|否 404/非JSON| Hide
  Resp -->|401 INVALID_API_KEY| CredErr[needs-credential]
```

凭据引用优先级：`config.credentials[route]` 显式覆盖 > provider 在 profile 中的 `apiKeyEnv`（存在即唯一来源，多账号不串号）> 适配器默认环境变量 > 路由名派生。

## sub2api 协议（GET {baseURL}/v1/usage，Bearer 认证）

```mermaid
flowchart LR
  Req["GET {base}/v1/usage<br/>Authorization: Bearer key"] --> Mode{mode}
  Mode -->|quota_limited| Q["quota: limit/used/remaining<br/>rate_limits: 5h/1d/7d 窗口<br/>expires_at"]
  Mode -->|"unrestricted + 订阅组"| S["subscription:<br/>daily/weekly/monthly usage+limit<br/>remaining（不采用 planName 营销文案）"]
  Mode -->|"unrestricted + 余额组"| B["balance / remaining<br/>unit: USD"]
```

解析口径（与 sub2api 官方 CC Switch 脚本一致）：`remaining ?? quota.remaining ?? balance`，`unit ?? "USD"`。

## 内置适配器查询方式

| 适配器 | 请求 | 认证 | 关键响应字段 |
|---|---|---|---|
| deepseek-balance | `GET api.deepseek.com/user/balance` | Bearer | `balance_infos[]`（total/granted/topped_up） |
| deepseek-account | `ctx.deepseekAccount.getBalance()` | DSH 登录态 | `value[] / bonusWallets[]` |
| glm-coding | `GET {host}/api/monitor/usage/quota/limit` | raw key（401 回退 Bearer） | `data.limits[]` 按 type+unit 选窗口；nextResetTime 兼容秒级/ISO 字符串，MCP/月缺省时按次月 1 日 00:00 UTC 补算；0% 滚动窗无重置时间属正常（调用后开始计时） |
| kimi-coding | `GET api.kimi.com/coding/v1/usages` | Bearer | `usage`（周）+ `limits[].detail`（滚动） |
| moonshot-balance | `GET api.moonshot.{ai,cn}/v1/users/me/balance` | Bearer | `data.available_balance` |
| openrouter | `GET openrouter.ai/api/v1/credits`（兜底 `/key`） | Bearer | `total_credits - total_usage` |
| minimax-plan | `GET {host}/v1/token_plan/remains` | Bearer | `*_remaining_percent` |
| opencode-go | `GET opencode.ai/zen/go/v1/usage` | Bearer | `usage.{rolling,weekly,monthly}.percent` |
| xiaomi-balance | `GET platform.xiaomimimo.com/api/v1/balance` | Bearer | `balance` |
| github-copilot | `GET api.github.com/copilot_internal/user` | Bearer | `quota_snapshots.*` |

## 快照生命周期

```mermaid
sequenceDiagram
  participant C as Client
  participant H as Host 快照编排
  participant A as 适配器
  C->>H: POST snapshot { refresh?, route? }
  H->>H: TTL 命中 → 直接返回缓存（保留原 fetchedAt）
  par 并行取数（按路由）
    H->>A: 未命中：单飞请求（全程超时）
    A-->>H: 归一化 { status, kind, balance/quota/windows }
  end
  H->>H: 代际校验：配置已变则丢弃结果；<br/>本轮新数据 fetchedAt 统一为响应完成时刻
  H->>H: 窗口排序：5h → 日 → 周 → 月；<br/>GLM 供应商挂载重置机会（resets）
  H-->>C: { providers[] }（错误脱敏）
  Note over H: 失败 → 退避 60s→120s→300s<br/>保留上次成功值并标 stale
  Note over H: session/event(assistant/message)<br/>→ 记账（含会话 id）+ 触发对应供应商刷新
```

## RPC 端点（POST /model-usage，body { endpoint, payload }）

| endpoint | 说明 |
|---|---|
| `snapshot` | 额度快照；`{refresh: true, route?}` 强制刷新（可限定路由） |
| `stats` | 本机用量统计；`{days}` 或 `{scope: 'week'\|'month'}`（日历口径） |
| `current` | 最近一次真实模型调用的供应商（前端跟随兜底） |
| `config` | refreshSeconds / footer / card.template |
| `resetUse` | GLM 额度核销；`{type: 'FIVE_HOUR'\|'WEEK'}`（幂等，失败复用同一 key） |
| `zcodeAuthState` | ZCode 会话连接状态（重置功能用） |
| `zcodeLoginStart / zcodeLoginComplete / zcodeDisconnect` | 内嵌 OAuth 登录 / 断开（共享凭据） |

## GLM 额度重置链路（ZCode 同款）

```mermaid
flowchart LR
  Card["GLM 卡片窗口行<br/>「重置 N」按钮"] --> Dialog["「可重置额度」弹窗<br/>额度卡片 + 重置行（二次确认）"]
  Dialog -->|点行内重置| Rpc["POST resetUse { type }"]
  Rpc --> Session["lib/zcode/auth.mjs<br/>~/.zcode/v2/credentials.json<br/>enc:v1 AES-256-GCM 共享凭据"]
  Session --> Reset["lib/zcode/reset.mjs"]
  Reset -->|GET status<br/>POST opportunity/use| ZServer["zcode.z.ai<br/>/api/v1/coding-plan/reset/*"]
  Rpc -->|核销成功| Refresh["作废 GLM 额度缓存<br/>强制对账 status"]
```

- **凭据共享**：存储路径与格式与 ZCode 客户端完全一致（enc:v1，密钥由本机信息推导）；ZCode 已登录即开即用，插件内嵌 OAuth 登录（lib/zcode/login.mjs，授权码手动粘贴回调）写回同一文件，双向共用登录态
- **机会状态**：GET /status（5 分钟 TTL 缓存）；无有效机会时 POST /opportunity 触发服务端资格判断（3301 限流按 next_try_at 冷却）
- **鉴权**：`Authorization: Bearer <zcodeJwt>` + `X-Bigmodel-Authorization: <业务JWT>`（直传不套 Bearer），PERSONAL scope
- **401**：视为会话失效，前端提示经 GLM 卡片 Logo（账户入口）重新连接

## 配置结构

```yaml
- id: model-usage
  name: dsh-model-usage
  config:
    refreshSeconds: 60        # 刷新间隔
    footer: true              # 侧栏入口
    credentials: {}           # 按路由覆盖凭据引用（可选；缺省复用 provider 的 apiKeyEnv）
    adapters: {}              # 按路由显式适配器（可选；缺省按 baseURL 自动识别模板）
    sub2api: {}               # 按路由显式 sub2api 端点 { baseURL, keyRef }
    glm: {}                   # GLM organization / project / planType
    card:
      template: ""            # 卡片摘要模板字符串
```

## 安全边界

1. 凭据只在 Host 内存；RPC 响应不含密钥，错误信息统一脱敏
2. 内置适配器只请求写死域名；sub2api 只访问 profile 中用户自己配置的 baseURL（凭据本就会发往该地址）
3. 静态资源（style.css / icons）只读包内固定路径，slug 白名单字符
4. 账本只存聚合数字，不含对话内容
