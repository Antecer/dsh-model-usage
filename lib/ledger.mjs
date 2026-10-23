// 本机模型用量账本（DSH 插件 Host 端）
// 零依赖，仅用 Node 内置模块；只记录实时事件，不做历史回填/会话日志/余额观测
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const RETAIN_DAYS = 180; // days 数据保留天数
const RECENT_MAX = 300; // recent 事件上限
const STATS_RECENT = 100; // stats 返回的 recent 条数
const FLUSH_DEBOUNCE_MS = 3000; // 写盘防抖间隔

// DSH 数据根目录：优先 DSH_HOME 环境变量
function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh');
}

// 本地日期键 YYYY-MM-DD（本地年月日拼接，避免时区偏移）
function dateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 枚举最近 N 天的日期键：用 new Date(y, m, d - i) 逐日回推，
// 禁止用 86400000 毫秒平移，避免夏令时跨天错误；索引 0 为今天
function lastNDays(n) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
}

// 空累计桶
function emptyBucket() {
  return { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// 向桶累加（requests 自增 1）
function addTo(bucket, parts) {
  bucket.requests += 1;
  bucket.tokens += parts.tokens;
  bucket.input += parts.input;
  bucket.output += parts.output;
  bucket.cacheRead += parts.cacheRead;
  bucket.cacheWrite += parts.cacheWrite;
}

// 桶求和（用于汇总，不重复计 requests 之外字段）
function sumInto(dst, src) {
  dst.requests += src.requests || 0;
  dst.tokens += src.tokens || 0;
  dst.input += src.input || 0;
  dst.output += src.output || 0;
  dst.cacheRead += src.cacheRead || 0;
  dst.cacheWrite += src.cacheWrite || 0;
}

// 兼容 usage 字段别名，统一取四项非负整数
function normalizeUsage(usage = {}) {
  const pick = (...names) => {
    for (const n of names) {
      const v = usage[n];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
    }
    return 0;
  };
  return {
    input: pick('input', 'inputTokens', 'promptTokens', 'input_tokens'),
    output: pick('output', 'outputTokens', 'completionTokens', 'output_tokens'),
    cacheRead: pick('cacheRead', 'cacheReadTokens', 'cachedTokens', 'cache_read_input_tokens'),
    cacheWrite: pick('cacheWrite', 'cacheWriteTokens', 'cache_creation_input_tokens'),
  };
}

// 创建账本实例；options.file 可覆盖默认存储路径
export function createLedger(options = {}) {
  const file = options.file || path.join(dshHome(), 'model-usage', 'ledger.json');

  // 私有状态放闭包
  let data = { version: 1, days: {}, recent: [] };
  let dirty = false;
  let writeChain = Promise.resolve(); // 串行化写盘链
  let flushTimer = null;

  // 删除 180 天前的 days
  function prune() {
    const keep = new Set(lastNDays(RETAIN_DAYS));
    for (const k of Object.keys(data.days)) {
      if (!keep.has(k)) delete data.days[k];
    }
  }

  // 原子写：先写 .tmp 再 rename；Promise 链串行化，前次未写完则后次排队，
  // 完成后写最新快照；dirty 只在成功后清除，失败保持脏标待下次重写
  function flush() {
    writeChain = writeChain.then(async () => {
      if (!dirty) return;
      prune(); // flush 前执行清理
      const snapshot = JSON.stringify(data, null, 2);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
      dirty = false;
    }).catch(() => { /* 失败保持 dirty，不中断链 */ });
    return writeChain;
  }

  // 标脏并做 3 秒防抖 flush
  function markDirty() {
    dirty = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
  }

  // 归一化 days 结构：旧版账本的 provider 条目把桶字段（requests/tokens/...）
  // 直接平铺在条目上，没有 { total, models } 包装；stats/record 读取 pv.total
  // 会抛 TypeError，导致 stats 端点整体报错（前端表现为永远「加载中」）。
  // 加载时统一迁移为新结构，flush 后文件即完成升级。
  function normalizeDays(days) {
    for (const dk of Object.keys(days)) {
      const day = days[dk];
      if (!day || typeof day !== 'object') { delete days[dk]; continue; }
      if (!day.hours || typeof day.hours !== 'object') day.hours = {};
      const providers = day.providers && typeof day.providers === 'object' ? day.providers : {};
      for (const [p, pv] of Object.entries(providers)) {
        if (!pv || typeof pv !== 'object') { delete providers[p]; continue; }
        if (!pv.total || typeof pv.total !== 'object') {
          const models = pv.models && typeof pv.models === 'object' ? pv.models : {};
          const total = emptyBucket();
          for (const k of ['requests', 'tokens', 'input', 'output', 'cacheRead', 'cacheWrite']) {
            const v = Number(pv[k]);
            if (Number.isFinite(v)) total[k] = v;
          }
          providers[p] = { total, models };
        }
        if (!providers[p].models || typeof providers[p].models !== 'object') providers[p].models = {};
      }
      day.providers = providers;
    }
    return days;
  }

  // 加载已有 JSON（失败按空数据），随后 prune
  async function ready() {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = {
          version: 1,
          days: normalizeDays(parsed.days && typeof parsed.days === 'object' ? parsed.days : {}),
          recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        };
      }
    } catch { /* 文件缺失或损坏：按空数据继续 */ }
    prune();
  }

  // 记录一条实时用量事件；session 为会话 id（有则按对话维度聚合）
  function record({ time, provider = 'unknown', model = 'unknown', usage, session } = {}) {
    const t = time ? new Date(time) : new Date();
    if (Number.isNaN(t.getTime())) return; // 非法时间忽略
    const parts = normalizeUsage(usage);
    parts.tokens = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;

    const dk = dateKey(t);
    const hour = String(t.getHours()).padStart(2, '0');
    const day = data.days[dk] || (data.days[dk] = { hours: {}, providers: {} });
    addTo(day.hours[hour] || (day.hours[hour] = emptyBucket()), parts);
    const prov = day.providers[provider] || (day.providers[provider] = { total: emptyBucket(), models: {} });
    addTo(prov.total, parts);
    addTo(prov.models[model] || (prov.models[model] = emptyBucket()), parts);

    // 按对话聚合：days[dk].sessions[sid] = { total, providers, lastAt }
    if (session) {
      if (!day.sessions || typeof day.sessions !== 'object') day.sessions = {};
      const sv = day.sessions[session] || (day.sessions[session] = { total: emptyBucket(), providers: {}, lastAt: 0 });
      addTo(sv.total, parts);
      addTo(sv.providers[provider] || (sv.providers[provider] = emptyBucket()), parts);
      sv.lastAt = t.getTime();
    }

    data.recent.push({
      t: t.getTime(), p: provider, m: model, s: session || undefined,
      i: parts.input, o: parts.output, cr: parts.cacheRead, cw: parts.cacheWrite,
    });
    while (data.recent.length > RECENT_MAX) data.recent.shift();
    markDirty();
  }

  // 汇总日期键集合内的排行：iter 产出 [名称, 桶] 列表，按 tokens 降序
  function collectRank(keys, iter) {
    const map = new Map();
    for (const dk of keys) {
      const day = data.days[dk];
      if (!day) continue;
      for (const [name, bucket] of iter(day)) {
        const cur = map.get(name) || emptyBucket();
        sumInto(cur, bucket);
        map.set(name, cur);
      }
    }
    return [...map.entries()].map(([name, b]) => ({ name, ...b }))
      .sort((a, b) => b.tokens - a.tokens);
  }

  // 汇总日期键集合内的总计与缓存命中率
  function sumRange(keys) {
    const total = emptyBucket();
    for (const dk of keys) {
      const day = data.days[dk];
      if (!day) continue;
      for (const pv of Object.values(day.providers || {})) sumInto(total, pv.total);
    }
    const hitBase = total.cacheRead + total.input;
    return {
      requests: total.requests,
      tokens: total.tokens,
      input: total.input,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
      // 命中率 = cacheRead / (cacheRead + input)，无数据为 null，保留 1 位小数
      cacheHitRate: hitBase > 0 ? Math.round((total.cacheRead / hitBase) * 1000) / 10 : null,
    };
  }

  /** 本周（周一 00:00 起）到今天的日期键。 */
  function weekKeys() {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // 周一为一周起点
    const out = [];
    for (let i = dow; i >= 0; i -= 1) {
      out.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    return out;
  }

  /** 本月 1 号到今天的日期键。 */
  function monthKeys() {
    const now = new Date();
    const out = [];
    for (let d = 1; d <= now.getDate(); d += 1) {
      out.push(dateKey(new Date(now.getFullYear(), now.getMonth(), d)));
    }
    return out;
  }

  // 读取统计；days 为向前回看天数，scope 为日历口径（week=本周/month=本月）。
  // today/week/month/total/heatmap 与选中范围无关，供右栏顶部固定摘要使用；
  // conversations 为选中范围内的按对话聚合（标题由前端经 sessions 服务解析）。
  function stats({ days = 7, scope } = {}) {
    const keys = scope === 'week' ? weekKeys() : scope === 'month' ? monthKeys() : lastNDays(days);
    const dayTotals = (dk) => {
      const day = data.days[dk];
      const out = { tokens: 0, requests: 0 };
      if (day) {
        for (const pv of Object.values(day.providers || {})) {
          const b = pv && pv.total;
          if (!b) continue;
          out.tokens += b.tokens || 0;
          out.requests += b.requests || 0;
        }
      }
      return out;
    };
    const monthPrefix = dateKey(new Date()).slice(0, 7); // YYYY-MM
    const conversations = (() => {
      const acc = new Map();
      for (const dk of keys) {
        const day = data.days[dk];
        if (!day) continue;
        for (const [sid, sv] of Object.entries(day.sessions || {})) {
          if (!sv || typeof sv !== 'object') continue;
          const total = sv.total || {};
          const cur = acc.get(sid) || { session: sid, requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastAt: 0, providers: new Set() };
          cur.requests += total.requests || 0;
          cur.tokens += total.tokens || 0;
          cur.input += total.input || 0;
          cur.output += total.output || 0;
          cur.cacheRead += total.cacheRead || 0;
          cur.cacheWrite += total.cacheWrite || 0;
          cur.lastAt = Math.max(cur.lastAt, Number(sv.lastAt) || 0);
          for (const p of Object.keys(sv.providers || {})) cur.providers.add(p);
          acc.set(sid, cur);
        }
      }
      return [...acc.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 20)
        .map((c) => ({
          session: c.session, requests: c.requests, tokens: c.tokens,
          input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite,
          lastAt: c.lastAt, providers: [...c.providers],
        }));
    })();
    return {
      generatedAt: new Date().toISOString(),
      rangeDays: days,
      today: sumRange([dateKey(new Date())]),
      week: sumRange(weekKeys()),
      month: sumRange(Object.keys(data.days).filter((k) => k.startsWith(monthPrefix))),
      total: sumRange(Object.keys(data.days)),
      heatmap: lastNDays(364).reverse().map((dk) => ({ date: dk, ...dayTotals(dk) })),
      conversations,
      range: sumRange(keys),
      days: keys.map((dk) => {
        const total = emptyBucket();
        const day = data.days[dk];
        if (day) for (const pv of Object.values(day.providers || {})) sumInto(total, pv.total);
        // 完整桶字段：历史统计（请求数/输入/缓存/输出 tokens）与热力图共用
        return { date: dk, requests: total.requests, tokens: total.tokens, input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite };
      }),
      providers: collectRank(keys, (day) => Object.entries(day.providers || {})
        .map(([p, pv]) => [p, pv.total])),
      models: collectRank(keys, (day) => Object.entries(day.providers || {})
        .flatMap(([p, pv]) => Object.entries(pv.models || {})
          .map(([m, b]) => [`${p}/${m}`, b]))),
      recent: data.recent.slice(-STATS_RECENT).reverse(), // 最近 100 条，新在前
    };
  }

  return { ready, record, stats, flush };
}

export default createLedger;
