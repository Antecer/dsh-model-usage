// dsh-model-usage · 市场索引静态元数据
// 与具体版本无关的展示字段（标题/描述/图标/作者/仓库等）集中在这里；
// 版本条目由 scripts/build-index.mjs 从 git tag 自动生成，site/index.json 不再入库。
export const MARKET_META = {
  format: 1,
  title: {
    en: 'Antecer DSH plugins',
    zh: 'Antecer 的 DSH 插件',
  },
  description: {
    en: 'Plugins maintained by Antecer for DeepSeek Harness.',
    zh: 'Antecer 维护的 DeepSeek Harness 插件。',
  },
  plugins: [
    {
      name: '@antecer/dsh-model-usage',
      title: {
        en: 'Model Usage',
        zh: '模型额度与用量',
      },
      description: {
        en: 'Live provider quotas and local token usage in the sidebar, with a two-column detail dialog.',
        zh: '侧栏常驻显示供应商额度与本机用量，点击打开双列详情弹窗。',
      },
      icon: 'icons/model-usage.svg',
      author: 'Antecer',
      homepage: 'https://github.com/Antecer/dsh-model-usage#readme',
      repository: {
        url: 'https://github.com/Antecer/dsh-model-usage',
      },
      // tag 的 package.json 缺 engines 时的兜底
      engines: {
        dsh: '>=0.2.0-rc.2 <0.3.0',
      },
    },
  ],
}
