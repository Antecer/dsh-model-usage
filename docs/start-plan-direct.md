# ZCode Start Plan（赠送额度）接入

`glm-gift` 使用当前用户已有的 ZCode 登录会话直连 Start Plan，不启动 ZCode、app-server 或桥接插件。该路径依赖已验证的客户端请求约定，不是公开、稳定的第三方 API。

## 前提与边界

- 需要有效 ZCode JWT 和本机 ZCode 记录中的 `deviceMid`；缺任一项时适配器不发请求。设备标识只读复用，不生成替代标识。
- 仅支持文本输入；DSH 图片附件按文本能力投影为占位内容，适配器不发送图片字节。
- 2026-10-31 已验证 `GLM-5.3-Flash` 的文本、工具调用和工具结果回放，正文、usage 与同一赠额桶扣减一致。其他赠送模型未逐一真实验证，上游版本或策略变化可能使调用失败。

## 请求约定

端点：`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，使用 Anthropic Messages SSE。

- 认证同时发送 `Authorization: Bearer <ZCode JWT>` 与 `x-api-key`，不是 BigModel OAuth access token。
- 保留已验证的设备、平台、语言、时区、系统版本、发布渠道、主对话类型和来源请求头；会话 / query / request / trace ID 每次调用重新生成。
- 使用 DSH 自身的 `user-agent: dsh-model-usage/<version>`、`x-title: DSH`、`x-zcode-agent: dsh`；`anthropic-version` 为 `2023-06-01`。
- 请求体含 `stream: true`、`thinking: { type: 'enabled' }`、`output_config.effort` 和 `metadata.user_id`（设备及本次会话信息）；模型 id 转为已知 canonical 大小写。

模型元数据与请求侧 `max_tokens` 上限：

| 模型 | contextWindow | max_tokens 上限 |
|---|---:|---:|
| GLM-5.3-Flash / GLM-5.2 | 1,000,000 | 128,000 |
| GLM-5-Turbo | 200,000 | 64,000 |
| 其他 `glm-*`（实现的默认值） | 1,000,000 | 128,000 |
| 非 GLM 的未知模型（保守默认值） | 128,000 | 16,384 |

已知模型值参考 ZCode 内置配置；默认值不表示该未知模型已验证可用。未指定或无效的 `max_tokens` 使用对应上限，超限则截断。

## system 上下文

当前实现保留 ZCode 3.17.1 桌面端主对话捕获的三个 system 文本块，以及块 2、3 的 `cache_control: { type: 'ephemeral' }`。所测的简短替换、自写三块、仅保留首句及新增第四块方案曾返回 HTTP 405 / 业务码 3012；这些样本没有穷尽服务端可接受的上下文，也不能证明三块原文是唯一必要条件或保证调用成功的充分条件。

`composeStartPlanSystem()` 返回三块副本，把调用方 system 追加到第三块末尾，这是插件采用的兼容策略。适配器先合并 `options.system` 与 `messages` 中 `role='system'` 的文本，再交给该函数；system 消息不重复放入普通消息数组。

捕获快照见 [测试 fixture](../test/fixtures/start-plan-system-context.json)。三块内嵌文本来自 zai-org/ZCode，按 [Apache-2.0](../lib/zcode/ZCode-LICENSE) 保留许可；原创适配器与组合逻辑仍适用本项目 [MIT 许可](../LICENSE)。该快照不包含账户凭据、设备标识或用户对话，插件不构造或重放客户端签名、一次性验证材料。

## 账户自动关联与排序

[account-binding.mjs](../lib/zcode/account-binding.mjs) 使用按 `oauth:active_provider` 解析的当前 ZCode 账户业务 token，在固定官方域名以 GET 查询账户个人项目、列举 API Key，并只对候选 ID 读取现有 Key 的 secret。完整 `id.secret` 相等且匹配唯一路由时自动设置父路由；列表已返回完整 Key 时直接比较。`family` 仅区分业务域，Key 前缀只用于定位查询，不作为账户身份证明。当前只复用一份 ZCode active 会话，多个不同 GLM 账户无需默认手工配置。

同一账户匹配多个 provider 时不选第一项；可用 `glm.giftProvider` 显式覆盖或解决路由歧义。该配置指定额度展示和到期回退的父路由，本身不核验归属、不切换 ZCode 登录。自动查询不创建 Key、不签发项目 token、不调用模型；仅支持个人项目及完整 `id.secret` 凭据，未实现分页，BigModel 列表的 `total` 只有等于返回数组长度时才视为完整。协议不足或查询失败时不自动绑定。

关联结果缓存 5 分钟，查询失败缓存 30 秒；登录会话或候选 Key 变化会失效，旧请求结果不得跨账户生效。查询限制为最多 32 个个人项目、全程 15 秒、单响应 2 MiB。

Host 通过 `snapshot.giftProvider = { route: 'glm-gift', parentRoute, bindingStatus }` 传递关联；`bindingStatus` 为 `matched`、`ambiguous`、`unmatched`、`unavailable` 或 `configured`，不包含凭据。无匹配、歧义或不可用时 `parentRoute` 为 `null`；显式路由无效也不兜底选择。存在 GLM 卡片且已获取有效赠额时，关联不明确不阻止模型调用。关联后分组名为「<GLM 名称> · 赠送」。紧邻排序依赖宿主内部 `llm.adapters` Map，兼容检查不通过时保留宿主顺序。

BigModel 已通过真实账户的只读查询验证完整 Key 匹配；Z.ai 目前仅有源码协议与 mock 验证，尚未用真实 Z.ai 账户验证。同区域多 provider 中选择唯一匹配路由已有 Host 运行时 mock 回归；这些验证不代表同时维护多个 ZCode 登录会话。

## 到期回退

- 对普通已挂载会话，只有已保存的该模型 token 桶均有明确截止且全部到期，才尝试回退。额度用尽、查询失败、未知截止不构成触发条件。
- 必须有明确父路由，并能在其模型目录确定同名目标；匹配可忽略大小写，切换使用父目录的原始模型 id。下一请求使用父 provider 的配置与额度，全局默认与已发出的生成请求不变。
- 找不到目标或宿主内部选模接口不兼容时保留原选择；不主动恢复未挂载会话，后续挂载时可重新检查。
- 截止证据保存在 Host 内存中。重启后若上游已不再返回过期桶，插件缺少到期证据，不会据此猜测并切换。

## 实现与验证

- [start-plan-context.mjs](../lib/zcode/start-plan-context.mjs)：端点 / 版本常量、三块文本和副本组合。
- [gift-adapter.mjs](../lib/zcode/gift-adapter.mjs)：鉴权、请求构造、SSE 转换与 usage 上报；由 Host 注册到 `glm-gift`。
- usage 按事件中实际存在的字段更新，后续值覆盖此前值，0 也是有效值；缓存读取 / 写入单独上报。所测响应曾在 `message_start` 返回 0，末尾 `message_delta` 才给出实际用量。

运行 `node --test test/` 检查请求形状、协议和凭据缺失等回归。真实宿主契约测试需要可用的 `@deepseek-ai/dsh-llm`，可由 `DSH_LLM_ENTRY` 指定入口；缺失时相关用例跳过。fixture 一致性与 mock 测试不替代真实上游调用，也不代表已完成 GUI 端到端验证。

更新 Host 代码后在插件列表重启本插件；如仍加载旧模块，再重载宿主。真实对话复验需在 DSH 选择 `glm-gift` 模型进行。
