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

仓库的 [Pages 工作流](../.github/workflows/pages.yml) 在 `main` 的指定路径变更时触发，并通过版本门禁决定是否部署；也可手动运行（见第四节）。

1. 打开仓库 Settings → Pages → Build and deployment。
2. Source 选择 **GitHub Actions**。
3. **先启用 Pages 再触发部署**。工作流在 `actions/configure-pages@v6` 前检查 Pages 状态；收到 404 时会停止并给出启用指引。启用后手动 Run workflow 补部署。
4. 等 Actions 里的 `Deploy plugin market` 跑完（或手动 Run workflow）。
5. 确认索引可访问：https://antecer.github.io/dsh-model-usage/index.json 返回 200 且为 JSON。

在 DSH 里验证：

1. 插件页 → 实验性插件旁的「更多」→ 打开「自定义插件市场」。
2. 切到「发现」→「添加索引源」→ 粘贴 `https://antecer.github.io/dsh-model-usage/index.json`。
3. 搜索 `Model Usage`，确认卡片能安装，安装后侧栏出现入口。

## 四、维护索引

市场索引 `site/index.json` 的格式是官方 format 1，字段含义见官方文档。

**`site/index.json` 不再入库**（已加入 `.gitignore`），完全由构建脚本在部署产物中生成；仓库里只需要维护两样东西：

- `scripts/market-meta.mjs`：与版本无关的展示元数据（市场标题/描述、插件标题/描述/图标/作者/homepage/repository、engines 兜底）
- git tag：每个已发布版本一个 `v<版本>` tag（CI 在发版时自动创建）

Pages 部署工作流在部署前自动：

1. 若 `package.json` 的版本还没有对应的 `v<版本>` tag，自动创建并推送该 tag；
2. 运行 `scripts/build-index.mjs`：静态字段取自 `scripts/market-meta.mjs`，版本条目从各 tag 读取（版本号取该 tag 的 `package.json`、commit 取 tag 提交、发布时间取 tag 提交时间、engines 取该 tag 的 `package.json`），按 SemVer 从新到旧排序，**生成** `site/index.json`；
3. 以生成后的 `site/` 作为部署产物上传到 GitHub Pages（**不产生任何提交**，主分支保持干净，本地无需 pull）。

因此日常发版只需：

```bash
# 1. 改 package.json 的 version 与 CHANGELOG.md
# 2. 提交并推送
git add -A && git commit -m "chore: 发布 x.y.z" && git push
```

**部署记录清理（可选）：** 每次部署都会在 GitHub Deployments 留下一条 `github-pages` 记录；workflow 在部署成功后会自动删除除最新一条以外的历史记录。删除 deployment 需要仓库 admin 权限，而 `GITHUB_TOKEN` 不具备，因此需配置一个 secret：

1. 创建 fine-grained PAT（Settings → Developer settings → Fine-grained tokens），仓库仅选本仓库，权限：**Administration: Read and write**、**Deployments: Read and write**、**Contents: Read**；
   - 注意：GitHub 规定「仓库存在多个 deployment 时只能删除 inactive 的」，因此脚本会先给旧记录补一个 `inactive` 状态再触发删除；
2. 仓库 Settings → Secrets and variables → Actions → New repository secret，名称 `DEPLOY_CLEANUP_TOKEN`；
3. 未配置时清理步骤会静默跳过（仅记录 notice），已上线的站点不受影响。

**严格发版门禁：只有版本号变化才会部署。** 工作流触发后先比较 `package.json` 版本与 `v<版本>` tag：

- **tag 不存在 = 新版本** → 打 tag、生成索引、部署
- **tag 已存在 = 版本未变** → 跳过部署（只改 `site/**` 元数据不会触发线上更新）
- 需要只更新市场元数据（描述、图标、新增插件）而不发版时，到仓库 **Actions → Deploy plugin market → Run workflow** 手动触发（`workflow_dispatch` 会绕过门禁强制执行一次）

因此版本未变时推送不会重复部署；要发布新代码必须升版本号。其余约定：

- `publishTimestamp` 取该版本 tag 首次出现的提交时间；`engines.dsh` 与该 tag 的 `package.json` 一致。
- 索引的 git 源必须写**小写 40 位 commit SHA**（官方 schema 校验），不能写 tag/分支名；tag 只是用来让 CI 找到 commit。
- 若之后改为发布 npm 包，把 `scripts/build-index.mjs` 生成的 `source` 改成 `{ "type": "npm" }` 即可（仍需改脚本）；npm 源同样支持自动生成。
- 新增插件时把图标放到 `site/icons/`，在 `scripts/market-meta.mjs` 的 `plugins` 里加一条（图标写相对路径 `icons/<name>.svg`）。
- 需要补历史版本时，给对应提交打 `v<版本>` tag 并推送，下次部署会自动出现在索引里；本地可用 `node scripts/build-index.mjs` 预览生成的 `site/index.json`（该文件被忽略，不会进入提交）。

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
见仓库 README 的插件界面截图（docs/panel.webp）。

### 补充说明
凭据仅在 Host 解析使用，不返回浏览器。网络请求包括服务商额度、ZCode 登录/重置/赠额及模型生成、profile 配置的 baseURL，以及版本、价格和节假日数据源；账本不含对话内容。
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
- [ ] 部署工作流成功：已自动创建 `v<版本>` tag，且 `index.json` 的 `source` 指向该 tag 的提交（npm，或 git 固定 40 位提交）。
- [ ] 在 DSH「发现」中添加索引后能搜索并安装。
- [ ] 已提交 dsh.so / dsh-plugin.org。
