'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cls = require('./cls.js');
const quotes = require('./quotes.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const POOLS_DIR = path.join(DATA_DIR, 'pools');
const STORE_FILE = path.join(DATA_DIR, 'news.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOCAL_CONFIG_FILE = path.join(ROOT, 'config.local.json');

/* ------------------------------------------------------------ 配置 */

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (fs.existsSync(LOCAL_CONFIG_FILE)) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8')));
  }
  return cfg;
}

/* --------------------------------------------------------- 股票池 */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadWatchlist() {
  return readJson(WATCHLIST_FILE) || { count: 0, stocks: [] };
}

function saveWatchlist(wl) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2), 'utf8');
}

/** 列出全部股票池（自选股 + data/pools/ 下的指数成分股）。 */
function loadPools() {
  const out = [];
  const w = readJson(WATCHLIST_FILE);
  if (w && Array.isArray(w.stocks)) {
    out.push({ key: 'watchlist', name: '自选股', code: 'watchlist', kind: 'watchlist', count: w.stocks.length, capturedAt: w.capturedAt });
  }
  if (fs.existsSync(POOLS_DIR)) {
    for (const f of fs.readdirSync(POOLS_DIR).filter(function (x) { return /\.json$/.test(x); }).sort()) {
      const p = readJson(path.join(POOLS_DIR, f));
      if (p && p.key && Array.isArray(p.stocks)) {
        out.push({ key: p.key, name: p.name || p.key, code: p.code || p.key, kind: p.kind || 'index', count: p.stocks.length, capturedAt: p.capturedAt });
      }
    }
  }
  return out;
}

/** 名称含 ST / *ST / 退市 等，涨跌幅规则不同，新闻扫描默认剔除。 */
function isStOrDelistName(name) {
  return /ST|退/.test(String(name || ''));
}

function poolAgeHours(pool) {
  if (!pool || !pool.capturedAt) return Infinity;
  const t = Date.parse(pool.capturedAt);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3600000;
}

function poolUsable(pool) {
  return !!(pool && Array.isArray(pool.stocks) && pool.stocks.length);
}

/**
 * 同步沪深两市全部上市公司到 data/pools/<key>.json（key 默认 all-a）。
 * - 默认 TTL 24h：未过期直接复用本地缓存，少打 CLS。
 * - 拉取失败时：若有缓存且未超过 stale 上限（默认 7 天），降级复用，避免 Action 空池 exit 1。
 */
async function syncMarketPool(opts) {
  opts = opts || {};
  const cfg = Object.assign(loadConfig(), opts);
  const mp = cfg.marketPool || {};
  if (mp.enabled === false) return null;
  const key = mp.key || 'all-a';
  const excludeSt = mp.excludeSt !== false && mp.exclude_st !== false;
  const name = mp.name || (excludeSt ? '沪深A股(非ST)' : '沪深A股');
  const ttlHours = Number(mp.ttlHours != null ? mp.ttlHours : (cfg.poolTtlHours != null ? cfg.poolTtlHours : 24));
  const staleHours = Number(mp.staleHours != null ? mp.staleHours : (cfg.poolStaleHours != null ? cfg.poolStaleHours : 168));
  const cached = loadPool(key);
  const ageH = poolAgeHours(cached);

  if (poolUsable(cached) && ageH <= ttlHours) {
    console.log('  [pool] ' + name + '：复用缓存 ' + cached.stocks.length + ' 只（年龄 '
      + ageH.toFixed(1) + 'h ≤ TTL ' + ttlHours + 'h）');
    return {
      key: key,
      name: cached.name || name,
      count: cached.stocks.length,
      droppedSt: cached.droppedSt || 0,
      ok: true,
      cached: true,
    };
  }

  const page = cfg.marketPageSize || 200;
  try {
    const res = await cls.fetchAllStocks({ page: page, market: mp.market || 'all', retries: 5, timeout: 60000 });
    const raw = res.stocks || [];
    const stocks = excludeSt
      ? raw.filter(function (s) { return s && s.code && !isStOrDelistName(s.name); })
      : raw;
    const dropped = raw.length - stocks.length;
    savePool(key, {
      key: key,
      name: name,
      code: key,
      kind: 'market',
      source: 'cls.cn /web_quote/web_stock/stock_list?market=all'
        + (excludeSt ? ' + name filter !/(ST|退)/' : ''),
      excludeSt: excludeSt,
      capturedAt: new Date().toISOString(),
      count: stocks.length,
      rawCount: raw.length,
      droppedSt: dropped,
      stocks: stocks,
    });
    console.log('  [pool] ' + name + '：全量 ' + raw.length + ' → 入池 ' + stocks.length
      + (excludeSt ? '（按名称剔除 ST/退市 ' + dropped + ' 只）' : ''));
    return { key: key, name: name, count: stocks.length, droppedSt: dropped, ok: true, cached: false };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (poolUsable(cached) && ageH <= staleHours) {
      console.warn('  [pool] ' + name + '：拉取失败（' + msg + '），降级复用缓存 '
        + cached.stocks.length + ' 只（年龄 ' + ageH.toFixed(1) + 'h ≤ stale ' + staleHours + 'h）');
      return {
        key: key,
        name: cached.name || name,
        count: cached.stocks.length,
        droppedSt: cached.droppedSt || 0,
        ok: true,
        cached: true,
        degraded: true,
        error: msg,
      };
    }
    throw err;
  }
}

/** 同步全部股票池：沪深全量 + config.indexPools 里声明的指数。 */
async function syncPools(opts) {
  const out = [];
  try {
    const m = await syncMarketPool(opts);
    if (m) out.push(m);
  } catch (err) {
    out.push({ key: 'all-a', name: '沪深A股(非ST)', ok: false, error: String((err && err.message) || err) });
  }
  const idx = await syncIndexPools(opts);
  for (const x of idx) out.push(x);
  return out;
}

function loadPool(key) {
  if (key === 'watchlist') {
    const w = readJson(WATCHLIST_FILE);
    if (!w || !Array.isArray(w.stocks)) return null;
    return { key: 'watchlist', name: '自选股', code: 'watchlist', kind: 'watchlist', stocks: w.stocks };
  }
  const p = readJson(path.join(POOLS_DIR, key + '.json'));
  if (!p || !Array.isArray(p.stocks)) return null;
  return p;
}

function savePool(key, obj) {
  fs.mkdirSync(POOLS_DIR, { recursive: true });
  const f = path.join(POOLS_DIR, key + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return f;
}

/* ----------------------------------------------------------- 存储 */

/**
 * 从财联社行情接口同步指数成分股到 data/pools/<指数代码>.json。
 * config.indexPools 形如 [{ "code": "sz399006", "name": "创业板指" }]。
 */
async function syncIndexPools(opts) {
  opts = opts || {};
  const cfg = Object.assign(loadConfig(), opts);
  const list = cfg.indexPools || [];
  const page = cfg.constituentPageSize || 100;
  const out = [];
  for (const ix of list) {
    if (!ix || !ix.code) continue;
    try {
      const res = await cls.fetchIndexConstituents(ix.code, { page: page });
      savePool(ix.code, {
        key: ix.code,
        name: ix.name || ix.code,
        code: ix.code,
        kind: 'index',
        source: 'cls.cn /web_quote/web_stock/indCompoment',
        capturedAt: new Date().toISOString(),
        count: res.stocks.length,
        stocks: res.stocks,
      });
      out.push({ key: ix.code, name: ix.name || ix.code, count: res.stocks.length, ok: true });
    } catch (err) {
      out.push({ key: ix.code, name: ix.name || ix.code, ok: false, error: String((err && err.message) || err) });
    }
  }
  return out;
}

function loadStore() {
  const s = readJson(STORE_FILE);
  if (!s) return { updatedAt: null, articles: {}, lastRun: null };
  s.articles = s.articles || {};
  return s;
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 1), 'utf8');
}

/* ---------------------------------------------------------- 扫描节流 */

function classifyScanError(msg) {
  const s = String(msg || '');
  if (/aborted|timeout|TimeoutExpired|timed out/i.test(s)) return 'timeout';
  if (/fetch failed/i.test(s)) return 'fetch_failed';
  const http = /HTTP\s+(\d+)/i.exec(s);
  if (http) return 'http_' + http[1];
  if (/JSON|Unexpected token/i.test(s)) return 'parse';
  return 'other';
}

/** 间隔默认 80–150ms；配置 >150 时用配置值（便于临时放慢）。 */
function nextScanDelayMs(cfg) {
  const n = Number(cfg && (cfg.delayMs != null ? cfg.delayMs : cfg.requestDelayMs));
  if (Number.isFinite(n) && n > 150) return n;
  const lo = Number.isFinite(n) && n >= 80 ? n : 80;
  return lo + Math.floor(Math.random() * (151 - lo));
}

function scanTimeoutMs(cfg) {
  const m = Number(cfg && cfg.scanTimeoutMinutes);
  const minutes = Number.isFinite(m) && m > 0 ? m : 10;
  return minutes * 60 * 1000;
}

function logScanSummary(stats) {
  const kinds = stats.errorKinds || {};
  const order = ['fetch_failed', 'timeout', 'parse', 'other'];
  console.log('[scan] ── 错误分类');
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    console.log('[scan]   ' + k + '  ' + (kinds[k] || 0));
  }
  Object.keys(kinds).sort().forEach(function (k) {
    if (order.indexOf(k) >= 0) return;
    console.log('[scan]   ' + k + '  ' + kinds[k]);
  });
  console.log('[scan] ── 本轮');
  console.log('[scan]   已抓 ' + stats.scanned + ' / ' + stats.stocks
    + '  失败 ' + stats.errors
    + (stats.aborted ? '  超时作废（不入库/不推送）' : ''));
}

/* ---------------------------------------------------------- 并发池 */

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

/* ---------------------------------------------------------- 抓取 */

function upsertArticle(store, stock, poolKeys, item) {
  const id = String(item.id);
  const rec = store.articles[id] || {
    id: id,
    ctime: item.ctime,
    title: item.title,
    brief: (item.share_info && item.share_info.brief) || '',
    column: '',
    text: '',
    textSource: '',
    url: 'https://www.cls.cn/detail/' + id,
    stocks: [],
    pools: [],
    firstSeen: new Date().toISOString(),
  };
  rec.title = item.title;
  if (!rec.brief) rec.brief = (item.share_info && item.share_info.brief) || '';
  rec.pools = rec.pools || [];
  for (const k of poolKeys) if (rec.pools.indexOf(k) < 0) rec.pools.push(k);
  if (!rec.stocks.some(function (s) { return s.code === stock.code; })) {
    rec.stocks.push({ code: stock.code, name: stock.name });
  }
  for (const q of item.quotes_info || []) {
    if (q && q.code && !rec.stocks.some(function (s) { return s.code === q.code; })) {
      rec.stocks.push({ code: q.code, name: q.name || '' });
    }
  }
  store.articles[id] = rec;
  return rec;
}

/**
 * 拉取指定股票池在近 N 天内命中目标栏目的新闻。
 * 同一只股票若属于多个池只抓一次，命中会同时记在所属各池上。
 */
async function collect(opts) {
  opts = opts || {};
  const cfg = Object.assign(loadConfig(), opts);
  cls.setAuth(cfg.auth || {});
  const prefixes = cfg.prefixes || [];
  const cutoff = Math.floor(Date.now() / 1000) - (cfg.days || 7) * 86400;

  const wantedKeys = opts.pools && opts.pools.length ? opts.pools : loadPools().map(function (p) { return p.key; });
  const targets = new Map();
  const poolNames = {};
  for (const key of wantedKeys) {
    const pool = loadPool(key);
    if (!pool) continue;
    poolNames[key] = pool.name || key;
    for (const s of pool.stocks) {
      if (!targets.has(s.code)) targets.set(s.code, { code: s.code, name: s.name || '', pools: [] });
      const t = targets.get(s.code);
      if (t.pools.indexOf(key) < 0) t.pools.push(key);
    }
  }

  const store = loadStore();
  const stats = {
    stocks: targets.size,
    scanned: 0,
    listed: 0,
    prefixed: 0,
    matched: 0,
    newText: 0,
    errors: 0,
    aborted: false,
    errorKinds: {},
    pools: {},
  };
  for (const k of wantedKeys) stats.pools[k] = { name: poolNames[k] || k, matched: 0 };
  const errors = [];
  const matchedIds = new Set();
  const timeoutMs = scanTimeoutMs(cfg);
  const deadline = Date.now() + timeoutMs;
  const items = Array.from(targets.values());
  console.log('[scan] 并发 ' + Math.max(1, cfg.concurrency || 5)
    + ' 间隔 80–150ms 超时 ' + (timeoutMs / 60000) + ' 分钟（超时则本轮作废）');

  await runPool(
    items,
    async function (stock) {
      if (Date.now() >= deadline) {
        stats.aborted = true;
        return;
      }
      try {
        const articles = await cls.fetchStockArticles(stock.code, { sinceSec: cutoff });
        stats.listed += articles.length;
        for (const item of articles) {
          const anyPrefix = cls.titlePrefix(item.title);
          if (!anyPrefix) continue;
          stats.prefixed++;
          const pf = cls.matchPrefix(item.title, prefixes);
          const rec = upsertArticle(store, stock, stock.pools, item);
          rec.column = anyPrefix;
          rec.matchedConfig = !!pf;
          if (!pf) continue;
          stats.matched++;
          matchedIds.add(String(item.id));
          for (const k of stock.pools) stats.pools[k].matched++;
          if (cfg.fetchText !== false && !rec.text) {
            const t = await cls.fetchArticleText(item.id);
            if (t.text) {
              rec.text = t.text;
              rec.textSource = t.source;
              stats.newText++;
            } else {
              rec.textSource = t.source === 'gated' ? 'gated' : (rec.brief ? 'brief' : 'none');
            }
          }
        }
      } catch (err) {
        const msg = String((err && err.message) || err);
        const kind = classifyScanError(msg);
        stats.errors++;
        stats.errorKinds[kind] = (stats.errorKinds[kind] || 0) + 1;
        errors.push({ code: stock.code, name: stock.name, error: msg, kind: kind });
      } finally {
        stats.scanned++;
        if (cfg.onProgress) cfg.onProgress(stats, stock);
        await cls.sleep(nextScanDelayMs(cfg));
      }
    },
    Math.max(1, cfg.concurrency || 5)
  );

  logScanSummary(stats);
  if (stats.aborted) {
    console.log('[scan] 超过 scanTimeoutMinutes=' + (timeoutMs / 60000)
      + ' 分钟，本轮作废：不入库、不推送、不抬 VIP 水位');
    return { aborted: 'timeout', store: null, stats: stats, errors: errors };
  }

  store.lastRun = { at: new Date().toISOString(), cutoff: cutoff, pools: wantedKeys, stats: stats, errors: errors.slice(0, 20) };

  // 行情增强：给「命中文章 x 涉及股票」补上价格表现
  if (cfg.enrichQuotes !== false && matchedIds.size) {
    const recs = Array.from(matchedIds).map(function (id) { return store.articles[id]; }).filter(Boolean);
    const codes = [];
    for (const r of recs) for (const s of r.stocks || []) codes.push(s.code);
    try {
      const uniq = await quotes.prefetch(codes, cfg.quotesConcurrency || 6);
      stats.quoteCodes = uniq;
    } catch (e) {
      stats.quoteError = String((e && e.message) || e);
    }
    let enriched = 0;
    for (const r of recs) {
      r.metrics = r.metrics || {};
      for (const s of r.stocks || []) {
        try {
          r.metrics[s.code] = await quotes.enrich(s.code, r.ctime);
          enriched++;
        } catch (e) { /* 单只失败不影响整体 */ }
      }
    }
    stats.enriched = enriched;
  }
  prune(store, cutoff);
  prunePoolKeys(store);
  saveStore(store);
  return { store: store, stats: stats, errors: errors };
}

/** 去掉记录里已经不存在（被删除）的股票池标记，避免旧池名残留。 */
function prunePoolKeys(store) {
  const valid = new Set(loadPools().map(function (p) { return p.key; }));
  if (!valid.size) return;
  for (const id of Object.keys(store.articles)) {
    const rec = store.articles[id];
    if (!Array.isArray(rec.pools)) continue;
    const kept = rec.pools.filter(function (k) { return valid.has(k); });
    if (kept.length !== rec.pools.length) rec.pools = kept;
  }
}

/** 丢弃远超窗口的旧记录，避免文件无限膨胀。 */
function prune(store, cutoff) {
  const keepFrom = cutoff - 3 * 86400;
  for (const id of Object.keys(store.articles)) {
    const rec = store.articles[id];
    if (rec.ctime && rec.ctime < keepFrom) delete store.articles[id];
  }
}

/** 整理成按时间倒序的行；options: { days, pool, all } */
const METRIC_KEYS = ['tradeDate', 'refMinute', 'refPx', 'm5', 'm30', 'm120', 'open', 'close', 'changePct', 'volRatioPct', 'turnover', 'prevClose', 'maxAbsChange'];

function emptyMetrics() {
  const o = {};
  for (const k of METRIC_KEYS) o[k] = null;
  return o;
}

/**
 * 整理成行。默认「一篇文章 x 一只股票」一行（因为价格指标是逐股票的）。
 * options: { days, pool, all, perStock=true }
 */
function rows(store, options) {
  options = options || {};
  const days = options.days || 7;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const pool = options.pool && options.pool !== 'all' ? options.pool : null;
  const perStock = options.perStock !== false;
  const out = [];
  const arts = Object.values(store.articles)
    .filter(function (r) { return r.ctime >= cutoff; })
    .filter(function (r) {
      const pools = r.pools && r.pools.length ? r.pools : ['watchlist'];
      if (pool && pools.indexOf(pool) < 0) return false;
      return options.all ? true : r.matchedConfig !== false;
    })
    .sort(function (a, b) { return b.ctime - a.ctime; });

  for (const r of arts) {
    const pools = r.pools && r.pools.length ? r.pools : ['watchlist'];
    const base = {
      time: cls.fmtTime(r.ctime),
      ctime: r.ctime,
      stocks: (r.stocks || []).map(function (s) { return s.name + '(' + s.code + ')'; }).join('、'),
      pools: pools,
      prefix: cls.titlePrefix(r.title) || r.column || '',
      title: r.title,
      text: r.text || r.brief || '',
      textSource: r.textSource || (r.brief ? 'brief' : 'none'),
      url: r.url,
    };
    const list = (r.stocks || []);
    if (!perStock || !list.length) {
      out.push(Object.assign({ id: r.id, stock: base.stocks, stockCode: '', stockCodes: list.map(function (s) { return s.code; }) }, base, emptyMetrics()));
      out.push(Object.assign({ id: r.id, stock: base.stocks, stockCode: '', others: '', stockCodes: list.map(function (s) { return s.code; }) }, base, emptyMetrics()));
      continue;
    }
    for (const s of list) {
      const m = (r.metrics && r.metrics[s.code]) || null;
      out.push(Object.assign({
        id: r.id + '#' + s.code,
        articleId: r.id,
        stock: s.name + '(' + s.code + ')',
        stockName: s.name,
        stockCode: s.code,
        stockCodes: [s.code],
        alsoIn: list.length - 1,
        others: list.filter(function (x) { return x.code !== s.code; }).map(function (x) { return x.name + '(' + x.code + ')'; }).join('、'),
      }, base, m ? Object.assign(emptyMetrics(), m) : emptyMetrics()));
    }
  }
  return out;
}

module.exports = {
  ROOT: ROOT,
  DATA_DIR: DATA_DIR,
  POOLS_DIR: POOLS_DIR,
  STORE_FILE: STORE_FILE,
  WATCHLIST_FILE: WATCHLIST_FILE,
  loadConfig: loadConfig,
  loadPools: loadPools,
  loadPool: loadPool,
  savePool: savePool,
  syncIndexPools: syncIndexPools,
  syncMarketPool: syncMarketPool,
  syncPools: syncPools,
  isStOrDelistName: isStOrDelistName,
  loadWatchlist: loadWatchlist,
  saveWatchlist: saveWatchlist,
  loadStore: loadStore,
  saveStore: saveStore,
  collect: collect,
  rows: rows,
  runPool: runPool,
};
