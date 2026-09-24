'use strict';

const cls = require('./cls.js');
const { loadConfig } = require('./config.js');
const { assignShard } = require('./shard.js');
const { loadPool } = require('./pool.js');

function classifyScanError(msg) {
  const s = String(msg || '');
  if (/aborted|timeout|TimeoutExpired|timed out/i.test(s)) return 'timeout';
  if (/fetch failed/i.test(s)) return 'fetch_failed';
  const http = /HTTP\s+(\d+)/i.exec(s);
  if (http) return 'http_' + http[1];
  if (/JSON|Unexpected token/i.test(s)) return 'parse';
  return 'other';
}

function nextScanDelayMs(cfg) {
  const n = Number(cfg && cfg.requestDelayMs);
  if (Number.isFinite(n) && n > 150) return n;
  const lo = Number.isFinite(n) && n >= 80 ? n : 80;
  return lo + Math.floor(Math.random() * (151 - lo));
}

function scanTimeoutMs(cfg) {
  const m = Number(cfg && cfg.scanTimeoutMinutes);
  const minutes = Number.isFinite(m) && m > 0 ? m : 10;
  return minutes * 60 * 1000;
}

async function runPool(items, worker, concurrency) {
  const queue = items.slice();
  let active = 0;
  return new Promise(function (resolve) {
    const next = function () {
      if (!queue.length && active === 0) return resolve();
      while (active < concurrency && queue.length) {
        const item = queue.shift();
        active++;
        Promise.resolve()
          .then(function () { return worker(item); })
          .catch(function () {})
          .finally(function () {
            active--;
            next();
          });
      }
    };
    next();
  });
}

function upsertArticle(articles, stock, item) {
  const id = String(item.id);
  const rec = articles[id] || {
    id: id,
    ctime: item.ctime,
    title: item.title,
    brief: (item.share_info && item.share_info.brief) || '',
    url: 'https://www.cls.cn/detail/' + id,
    stocks: [],
  };
  rec.title = item.title;
  if (!rec.brief) rec.brief = (item.share_info && item.share_info.brief) || '';
  if (!rec.stocks.some(function (s) { return s.code === stock.code; })) {
    rec.stocks.push({ code: stock.code, name: stock.name || '' });
  }
  for (const q of item.quotes_info || []) {
    if (q && q.code && !rec.stocks.some(function (s) { return s.code === q.code; })) {
      rec.stocks.push({ code: q.code, name: q.name || '' });
    }
  }
  articles[id] = rec;
  return rec;
}

function logScanSummary(stats) {
  const kinds = stats.errorKinds || {};
  console.log('[crawler] ── 错误分类');
  ['fetch_failed', 'timeout', 'parse', 'other'].forEach(function (k) {
    console.log('[crawler]   ' + k + '  ' + (kinds[k] || 0));
  });
  Object.keys(kinds).sort().forEach(function (k) {
    if (k === 'fetch_failed' || k === 'timeout' || k === 'parse' || k === 'other') return;
    console.log('[crawler]   ' + k + '  ' + kinds[k]);
  });
  console.log('[crawler] ── 本片');
  console.log('[crawler]   shard ' + stats.shard + '/' + stats.shards
    + '  已抓 ' + stats.scanned + '/' + stats.stocks
    + '  失败 ' + stats.errors
    + '  命中 ' + stats.matched
    + (stats.aborted ? '  超时作废' : ''));
}

/**
 * @param {{ shard: number, shards: number, poolFile?: string, onProgress?: Function }} opts
 */
async function scanShard(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const shard = Number(opts.shard);
  const shards = Math.max(1, Number(opts.shards));
  const prefixes = cfg.prefixes || [];
  const cutoff = Math.floor(Date.now() / 1000) - (cfg.days || 1) * 86400;
  const pool = loadPool(opts.poolFile || cfg.poolFile || 'data/pools/all-a.json');
  const slice = assignShard(pool.stocks, shard, shards);

  const articles = {};
  const stats = {
    shard: shard,
    shards: shards,
    poolTotal: pool.stocks.length,
    stocks: slice.length,
    scanned: 0,
    listed: 0,
    prefixed: 0,
    matched: 0,
    errors: 0,
    aborted: false,
    errorKinds: {},
  };
  const errors = [];
  const timeoutMs = scanTimeoutMs(cfg);
  const deadline = Date.now() + timeoutMs;
  const concurrency = Math.max(1, cfg.concurrency || 5);

  console.log('[crawler] shard ' + shard + '/' + shards
    + ' 本片 ' + slice.length + ' 只 / 池 ' + pool.stocks.length
    + '  并发 ' + concurrency + '  间隔 80–150ms  超时 ' + (timeoutMs / 60000) + ' 分钟');

  await runPool(
    slice,
    async function (stock) {
      if (Date.now() >= deadline) {
        stats.aborted = true;
        return;
      }
      try {
        const list = await cls.fetchStockArticles(stock.code, { sinceSec: cutoff });
        stats.listed += list.length;
        for (const item of list) {
          if (!cls.titlePrefix(item.title)) continue;
          stats.prefixed++;
          const pf = cls.matchPrefix(item.title, prefixes);
          const rec = upsertArticle(articles, stock, item);
          rec.column = cls.titlePrefix(item.title);
          rec.matchedConfig = !!pf;
          if (pf) stats.matched++;
        }
      } catch (err) {
        const msg = String((err && err.message) || err);
        const kind = classifyScanError(msg);
        stats.errors++;
        stats.errorKinds[kind] = (stats.errorKinds[kind] || 0) + 1;
        errors.push({ code: stock.code, name: stock.name, error: msg, kind: kind });
      } finally {
        stats.scanned++;
        if (opts.onProgress) opts.onProgress(stats);
        await cls.sleep(nextScanDelayMs(cfg));
      }
    },
    concurrency
  );

  logScanSummary(stats);
  const finishedAt = new Date().toISOString();
  if (stats.aborted) {
    console.log('[crawler] 本片超时作废（不写合并结果；整轮 merge 应失败）');
  }

  return {
    meta: {
      finishedAt: finishedAt,
      cutoff: cutoff,
      pool: pool.name,
      shard: shard,
      shards: shards,
    },
    stats: stats,
    errors: errors,
    aborted: stats.aborted ? 'timeout' : null,
    articles: stats.aborted ? {} : articles,
  };
}

module.exports = { scanShard, classifyScanError };
