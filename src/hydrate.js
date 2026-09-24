'use strict';

/**
 * 将 Matrix merge 结果注入 collect store，并补正文 / 行情。
 * 扫描本身由 scanShard 完成；本模块只做后置 hydrate。
 */

const fs = require('node:fs');
const path = require('node:path');
const cls = require('./cls.js');
const quotes = require('./quotes.js');
const collectMod = require('./collect.js');
const { ROOT } = require('./config.js');

const DEFAULT_MERGED = path.join(ROOT, 'out', 'merged.json');

function readMerged(filePath) {
  const p = filePath || DEFAULT_MERGED;
  if (!fs.existsSync(p)) throw new Error('缺少 merge 结果: ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {{
 *   mergedPath?: string,
 *   poolKey?: string,
 *   fetchText?: boolean,
 *   enrichQuotes?: boolean,
 *   onProgress?: Function,
 * }} opts
 */
async function hydrateFromMerged(opts) {
  opts = opts || {};
  const cfg = collectMod.loadConfig();
  const merged = readMerged(opts.mergedPath);
  if (!merged.ok) {
    return {
      ok: false,
      reason: merged.reason || 'merge_failed',
      stats: merged.stats || {},
      store: null,
    };
  }

  const poolKey = opts.poolKey || 'all-a';
  const wantText = opts.fetchText !== false && cfg.fetchText !== false;
  const wantQuotes = opts.enrichQuotes !== false && cfg.enrichQuotes !== false;

  const store = collectMod.loadStore();
  store.articles = store.articles || {};

  const articles = merged.articles || {};
  let injected = 0;
  let matched = 0;
  const matchedIds = [];

  for (const id of Object.keys(articles)) {
    const src = articles[id];
    const rec = store.articles[id] || {
      id: id,
      ctime: src.ctime,
      title: src.title,
      brief: src.brief || '',
      url: src.url || ('https://www.cls.cn/detail/' + id),
      stocks: [],
      pools: [],
    };
    rec.ctime = src.ctime || rec.ctime;
    rec.title = src.title || rec.title;
    if (src.brief) rec.brief = src.brief;
    if (src.url) rec.url = src.url;
    if (src.column) rec.column = src.column;
    rec.matchedConfig = !!src.matchedConfig;

    for (const s of src.stocks || []) {
      if (s && s.code && !rec.stocks.some(function (x) { return x.code === s.code; })) {
        rec.stocks.push({ code: s.code, name: s.name || '' });
      }
    }
    if (!Array.isArray(rec.pools)) rec.pools = [];
    if (rec.pools.indexOf(poolKey) < 0) rec.pools.push(poolKey);

    store.articles[id] = rec;
    injected++;
    if (rec.matchedConfig) {
      matched++;
      matchedIds.push(id);
    }
  }

  const stats = {
    injected: injected,
    matched: matched,
    newText: 0,
    enriched: 0,
    textErrors: 0,
  };

  if (wantText && matchedIds.length) {
    let done = 0;
    for (const id of matchedIds) {
      const rec = store.articles[id];
      done++;
      if (opts.onProgress) {
        opts.onProgress({ phase: 'text', done: done, total: matchedIds.length, stats: stats });
      }
      if (rec.text) continue;
      try {
        const t = await cls.fetchArticleText(id);
        if (t.text) {
          rec.text = t.text;
          rec.textSource = t.source;
          stats.newText++;
        } else {
          rec.textSource = t.source === 'gated' ? 'gated' : (rec.brief ? 'brief' : 'none');
        }
      } catch (_) {
        stats.textErrors++;
        if (!rec.textSource) rec.textSource = rec.brief ? 'brief' : 'none';
      }
      await cls.sleep(80 + Math.floor(Math.random() * 70));
    }
  }

  if (wantQuotes && matchedIds.length) {
    const recs = matchedIds.map(function (id) { return store.articles[id]; }).filter(Boolean);
    const codes = [];
    for (const r of recs) for (const s of r.stocks || []) codes.push(s.code);
    try {
      await quotes.prefetch(codes, cfg.quotesConcurrency || 6);
    } catch (_) { /* 单轮失败不阻断 */ }
    let enriched = 0;
    for (const r of recs) {
      r.metrics = r.metrics || {};
      for (const s of r.stocks || []) {
        try {
          r.metrics[s.code] = await quotes.enrich(s.code, r.ctime);
          enriched++;
        } catch (_) { /* ignore */ }
      }
    }
    stats.enriched = enriched;
  }

  store.lastRun = {
    at: new Date().toISOString(),
    source: 'matrix-hydrate',
    mergeStats: merged.stats || null,
    hydrate: stats,
  };
  collectMod.saveStore(store);

  return { ok: true, store: store, stats: stats, mergeStats: merged.stats };
}

module.exports = {
  hydrateFromMerged: hydrateFromMerged,
  readMerged: readMerged,
  DEFAULT_MERGED: DEFAULT_MERGED,
};
