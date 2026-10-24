# 发布到 DSH 插件市场

本文记录 dsh-model-usage 的发布与上架流程。结论先说：**DSH 目前没有可申请收录的「官方插件库」**，官方插件市场只是一个读取用户自行添加的 format 1 索引的客户端；因此「上架」等于：发布自己的索引，并提交到社区聚合市场。

## 背景

- 官方文档《插件市场》（https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market.md）写明「DSH 不内置任何索引源」：用户在「插件 → 更多 → 自定义插件市场 → 发现」里自行添加索引 URL。
- 本机安装的 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 的 README 也写着「目前没有官方插件市场；发现标签页只列出用户添加的索引源」。
- 官方插件（`@deepseek-ai/*`）随安装包发布，名单由 `dsh-app-boot` 的 `OPTIONAL_BUNDLES` / `ON_DEMAND_BUNDLES` 硬编码，没有第三方提交入口。
- 因此本仓库自带一个 format 1 索引 `site/index.json`，通过 GitHub Pages 发布；任何 DSH 用户添加该 URL 后即可在插件页发现并安装。

## 一、发布 npm 包

```bash
npm login
npm publish --access public
```

发布前确认：`package.json` 的 `version` 已递增、`engines.dsh` 覆盖目标 DSH 版本、`files` 包含 `lib` / `assets` / `cordis.patch.yml` / `docs`。

发布后验证：

```bash
npm view @antecer/dsh-model-usage version
```

## 二、给仓库加 topic

dsh.so 依赖 GitHub topic 自动索引，dsh-plugin.org 也把 topic 列为收录要求：

```bash
gh repo edit Antecer/dsh-model-usage --add-topic dsh-plugin
```

也可以在仓库首页右侧 Add topics 手动添加。

## 三、启用 GitHub Pages（发布市场索引）

仓库已包含 `.github/workflows/pages.yml`，push 到 `main` 后会自动部署 `site/` 目录。

1. 打开仓库 Settings → Pages → Build and deployment。
2. Source 选择 **GitHub Actions**。
3. 注意：**必须先启用 Pages 再触发部署**。若尚未启用就推送了 `site/` 变更，`Deploy plugin market` 会在
   `actions/configure-pages@v5` 步骤失败并报 `Get Pages site failed ... Not Found`——这是 Pages 站点不存在
   （未启用）导致的，不是工作流配置错误；工作流已内置启用检查，会直接给出启用指引。启用后手动 Run workflow
   即可补部署。
4. 等 Actions 里的 `Deploy plugin market` 跑完（或手动 Run workflow）。
5. 确认索引可访问：https://antecer.github.io/dsh-model-usage/index.json 返回 200 且为 JSON。

在 DSH 里验证：

1. 插件页 → 实验性插件旁的「更多」→ 打开「自定义插件市场」。
2. 切到「发现」→「添加索引源」→ 粘贴 `https://antecer.github.io/dsh-model-usage/index.json`。
3. 搜索 `Model Usage`，确认卡片能安装，安装后侧栏出现入口。

## 四、维护索引

`site/index.json` 的格式是官方 format 1，字段含义见官方文档。发新版本时：

- 在 `plugins[0].versions` 里**追加**新版本条目，保留旧版本；版本顺序由 DSH 按 SemVer 自动排序。
- `publishTimestamp` 用发布时间的 Unix 秒（`date +%s`）。
- `engines.dsh` 与该版本包的 `engines.dsh` 一致。
- npm 发布后把 `source` 从 git 固定提交改成 npm：

```json
"source": { "type": "npm" }
```

- 索引当前用 git 源固定提交 `d90145b…`（发布提交）；之后每次发布都要用 `git rev-parse HEAD` 更新 `source.commit`，否则市场安装到的是旧提交。npm 发布后改用 npm 源即可不再维护 commit。
- 新增插件时把图标放到 `site/icons/`，索引里写相对路径 `icons/<name>.svg`。

## 五、提交社区市场（非官方，但能被搜到）

### dsh.so

提交页：https://www.dsh.so/zh/submit/

粘贴仓库地址 `https://github.com/Antecer/dsh-model-usage`（或 npm 包名 `@antecer/dsh-model-usage`），检查器会自动识别渠道、校验 schema 并做安全扫描。接受标准：package.json 的 `dsh` 字段、README 安装说明、开源许可证、插件 id 规范、可扫描源码、无阻断级安全发现。通过后点「提交到 dsh.so」，条目以 Issue 形式进入审核。

### DSH Plugin Hub（dsh-plugin.org）

收录要求：公开仓库、`dsh-plugin` topic、README 含安装命令、根目录 `package.json`、插件导出 `apply(ctx)`；想出现在其「插件中心」必须有 npm 包。

提交标题：

```text
[插件提交] Antecer/dsh-model-usage — 侧栏实时显示模型供应商额度与本机用量
```

提交正文：

```text
### 仓库地址
https://github.com/Antecer/dsh-model-usage

### 一句话价值
在 DSH 侧栏常驻显示各供应商的剩余额度与本机 token 用量，点击展开双列详情弹窗。

### 能力分类
界面与体验

### 安装命令
dsh plugin --profile web add @antecer/dsh-model-usage

### 兼容与运行要求
DSH >= 0.2.0-rc.2 < 0.3.0；Web 平台；需要对应供应商的 apiKeyEnv 才能显示额度。

### 许可证
MIT

### 截图 / 演示
见仓库 README（docs/card.webp、docs/main.webp）。

### 补充说明
凭据只在插件 Host 内存中使用，不进入浏览器；仅访问各服务商官方额度接口与 profile 中配置的 baseURL；账本只记录 token 聚合数字，不含对话内容。
```

### Open Plugin Market（dshopen.org）

索引：`https://dshopen.org/index.json`，收录 800+ 社区插件；提交入口在其站点（底层仓库：polang233/dsh-plugin-index）。

### awesome-dsh-plugin

按仓库 README 的贡献说明提 PR，把插件加入列表。

## 六、官方渠道

当前没有公开的官方插件收录入口。若希望成为官方插件，只能向官方仓库贡献并由 DeepSeek 随版本发布，或在官方 Discussions 询问收录计划；提交社区市场**不会**让插件自动进入官方分发。

## 七、发布检查清单

- [ ] `package.json` 的 `version` 已递增，`repository` / `homepage` / `bugs` / `keywords` 完整。
- [ ] `npm publish --access public` 成功，`npm view` 能查到版本。
- [ ] 仓库 topics 含 `dsh-plugin`。
- [ ] GitHub Pages 已启用，`index.json` 返回 200。
- [ ] `site/index.json` 的 `source` 与版本正确（npm，或 git 固定 40 位提交）。
- [ ] 在 DSH「发现」中添加索引后能搜索并安装。
- [ ] 已提交 dsh.so / dsh-plugin.org。
