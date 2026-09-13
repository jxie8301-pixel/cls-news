'use strict';

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');
const report = require('./report.js');
const cls = require('./cls.js');
const research = require('./research.js');
const schedule = require('./schedule.js');
const technical = require('./technical.js');

const ROOT = collectMod.ROOT;
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const state = {
  running: false,
  lastRunAt: null,
  lastDurationMs: null,
  stats: null,
  errors: [],
  error: null,
  startedAt: new Date().toISOString(),
  nextRunAt: null,
};

function cfg() {
  return collectMod.loadConfig();
}

function json(res, code, payload, extra) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' };
  if (extra) for (const k of Object.keys(extra)) headers[k] = extra[k];
  res.writeHead(code, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

async function refresh(reason) {
  if (state.running) return { ok: false, skipped: true, reason: 'already-running' };
  const c = cfg();
  state.running = true;
  state.error = null;
  const t0 = Date.now();
  console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] 开始抓取 (' + reason + ') ...');
  try {
    if (c.syncPoolsOnStart !== false && !state.poolsSynced) {
      const synced = await collectMod.syncPools({});
      state.poolsSynced = true;
      synced.forEach(function (s) {
        console.log('  股票池 ' + s.name + '：' + (s.ok ? s.count + ' 只' : '同步失败 ' + s.error));
      });
    }
    const res = await collectMod.collect({ days: c.days, fetchText: true, concurrency: c.concurrency, delayMs: c.requestDelayMs });
    state.stats = res.stats;
    state.errors = res.errors;
    state.lastRunAt = new Date().toISOString();
    state.lastDurationMs = Date.now() - t0;
    const wl = collectMod.loadWatchlist();
    const store = collectMod.loadStore();
    const nowSec = Math.floor(Date.now() / 1000);
    const poolList = collectMod.loadPools();
    const names = {};
    poolList.forEach(function (x) { names[x.key] = x.name; });
    const allRows = collectMod.rows(store, { days: c.days }).map(function (r) {
      r.poolNames = (r.pools || []).map(function (k) { return names[k] || k; });
      return r;
    });
    const rr = await research.enrichRows(allRows, {
      config: c,
      onProgress: function (s) {
        if (s.done === s.total || s.done % 25 === 0) console.log('  调研 ' + s.done + '/' + s.total + ' ｜ 缓存 ' + s.cached + ' ｜ 失败 ' + s.errors);
      },
    });
    state.research = { total: rr.total, refreshed: rr.refreshed, cached: rr.cached, errors: rr.errors };
    const trr = await technical.refresh(allRows, {
      config: c,
      onProgress: function (s) {
        if (s.done === s.total || s.done % 25 === 0) console.log('  技术面 ' + s.done + '/' + s.total + ' ｜ 缓存 ' + s.cached + ' ｜ 失败 ' + s.errors);
      },
    });
    state.technical = { total: trr.total, refreshed: trr.refreshed, cached: trr.cached, errors: trr.errors };
    const range = cls.fmtTime(nowSec - c.days * 86400).slice(0, 10) + ' ~ ' + cls.fmtTime(nowSec).slice(0, 10);
    report.exportAll(allRows, {
      title: '财联社 沪深A股 · 目标栏目新闻',
      range: range,
      poolLabel: poolList.map(function (x) { return x.name + '（' + x.count + ' 只）'; }).join(' / '),
      generatedAt: new Date().toLocaleString('zh-CN'),
    }, { fileBase: 'cls-news' });
    console.log('  完成：命中 ' + res.stats.matched + ' 条 / 表格 ' + allRows.length + ' 行 / ' + (state.lastDurationMs / 1000).toFixed(1) + 's');
    return { ok: true, stats: res.stats };
  } catch (err) {
    state.error = String((err && err.message) || err);
    console.error('  抓取失败: ' + state.error);
    return { ok: false, error: state.error };
  } finally {
    state.running = false;
    scheduleNext();
  }
}

let timer = null;
function armTimer(ms) {
  state.nextRunAt = new Date(Date.now() + ms).toISOString();
  if (timer) clearTimeout(timer);
  timer = setTimeout(function () { refresh('定时刷新'); }, ms);
}

/**
 * 下一次刷新时间：按刷新节奏策略（交易日盘中 10 分钟 / 交易日其他时段 2 小时 / 非交易日 6 小时，
 * 见 src/schedule.js），用「间隔 - 本轮抓取耗时」计算，让开始到开始的间距符合该档。
 * 把 config.schedulePolicy 设为 false 可退回固定的 refreshMinutes。
 */
function scheduleNext() {
  const c = cfg();
  const fixedMs = Math.max(1, c.refreshMinutes || 10) * 60000;
  if (c.schedulePolicy === false) {
    armTimer(fixedMs);
    return;
  }
  const parts = schedule.shanghaiParts(Date.now());
  schedule
    .detectTradingDay(parts)
    .then(function (t) {
      const policy = schedule.policyFor(parts, t.isTradingDay);
      const spent = state.lastDurationMs || 0;
      const ms = Math.max(60000, policy.intervalMinutes * 60000 - spent);
      armTimer(ms);
      console.log('  下次刷新约 ' + Math.max(1, Math.round(ms / 60000)) + ' 分钟后 ｜ ' + policy.label + ' ｜ ' + (t.isTradingDay ? '交易日' : '非交易日'));
    })
    .catch(function () { armTimer(fixedMs); });
}

function listExports() {
  const dir = report.OUT_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(function (f) { return /\.(csv|html)$/.test(f); })
    .map(function (f) {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString(), url: '/exports/' + encodeURIComponent(f) };
    })
    .sort(function (a, b) { return b.mtime < a.mtime ? -1 : 1; });
}

const LOGIN_HTML = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>需要口令</title><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;font:14px/1.6 'Microsoft YaHei',system-ui,sans-serif}form{background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:26px 28px;width:min(340px,86vw)}h1{font-size:16px;margin:0 0 4px}p{color:#7a8290;font-size:12.5px;margin:0 0 16px}input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid #e6e8eb;border-radius:7px}button{width:100%;margin-top:12px;font:inherit;padding:9px;border:0;border-radius:7px;background:#c2410c;color:#fff;cursor:pointer}</style></head><body><form method=\"get\" action=\"/\"><h1>财联社盯盘面板</h1><p>请输入访问口令</p><input name=\"k\" type=\"password\" placeholder=\"访问口令\" autofocus autocomplete=\"current-password\"><button>进入</button></form></body></html>";

function cookieHash(token) {
  return crypto.createHash('sha256').update('cls-news|' + token).digest('hex').slice(0, 32);
}

function sameString(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** 配了 accessToken 就启用口令；返回 true 表示放行，false 表示已经响应过。 */
function passAuth(req, res, u) {
  const token = cfg().accessToken;
  if (!token) return true;
  const want = cookieHash(token);
  if (sameString(readCookie(req, 'cls_auth'), want)) return true;
  const k = u.searchParams.get('k');
  if (k && sameString(k, token)) {
    // 带上口令认证后回到原本请求的地址（而不是一律跳首页），便于直接打开导出的文件
    const keep = new URLSearchParams(u.search);
    keep.delete('k');
    const qs = keep.toString();
    res.writeHead(302, {
      'Set-Cookie': 'cls_auth=' + want + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
      Location: u.pathname + (qs ? '?' + qs : ''),
    });
    res.end();
    return false;
  }
  if (u.pathname.indexOf('/api/') === 0) {
    json(res, 401, { error: 'unauthorized', hint: '带上 ?k=口令，或先访问 /?k=口令 建立会话' });
    return false;
  }
  const body = Buffer.from(LOGIN_HTML, 'utf8');
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
  return false;
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  if (p === '/sw.js' || p === '/manifest.webmanifest' || p === '/public/icon-192.png' || p === '/public/icon-512.png') {
    console.log('  [' + new Date().toLocaleTimeString('zh-CN') + '] PWA ' + req.method + ' ' + p);
  }
  if (!passAuth(req, res, u)) return;
  const c = cfg();

  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (p === '/manifest.webmanifest') return serveFile(res, path.join(PUBLIC_DIR, 'manifest.webmanifest'));
  // Service Worker 必须由根路径提供，否则作用域被限制在 /public/ 下
  if (p === '/sw.js') {
    const swBody = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'));
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-cache',
      'Content-Length': swBody.length,
    });
    return res.end(swBody);
  }
  if (p.startsWith('/public/')) return serveFile(res, path.join(ROOT, p.slice(1)));

  if (p === '/api/rows') {
    const all = u.searchParams.get('all') === '1';
    const days = parseFloat(u.searchParams.get('days') || c.days);
    const pool = u.searchParams.get('pool') || 'all';
    const store = collectMod.loadStore();
    const wl = collectMod.loadWatchlist();
    const pools = collectMod.loadPools();
    const names = {};
    pools.forEach(function (x) { names[x.key] = x.name; });
    const rows = collectMod.rows(store, { days: days, all: all, pool: pool }).map(function (r) {
      r.poolNames = (r.pools || []).map(function (k) { return names[k] || k; });
      return r;
    });
    research.attachRows(rows);
    technical.attachRows(rows);
    const nowSec = Math.floor(Date.now() / 1000);
    return json(res, 200, {
      rows: rows,
      total: rows.length,
      days: days,
      all: all,
      pool: pool,
      pools: pools,
      prefixes: c.prefixes,
      stockCount: wl.count,
      windowFrom: cls.fmtTime(nowSec - days * 86400),
      windowTo: cls.fmtTime(nowSec),
      serverTime: cls.fmtTime(nowSec),
      lastRunAt: state.lastRunAt,
      storeUpdatedAt: store.updatedAt,
    });
  }

  if (p === '/api/status') return json(res, 200, Object.assign({}, state, { config: c, watchlistCount: collectMod.loadWatchlist().count, exports: listExports().slice(0, 12) }));

  if (p === '/api/pools') return json(res, 200, collectMod.loadPools());

  if (p === '/api/pool/sync') {
    return collectMod.syncPools({}).then(function (out) {
      refresh('同步成分股后刷新');
      return json(res, 200, { ok: true, pools: out });
    }).catch(function (e) {
      return json(res, 500, { ok: false, error: String((e && e.message) || e) });
    });
  }

  if (p === '/api/refresh') {
    const out = refresh('手动刷新');
    return json(res, 200, { started: true });
  }

  if (p === '/api/watchlist') return json(res, 200, collectMod.loadWatchlist());

  if (p === '/api/watchlist/import') {
    const CORS2 = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS2);
      return res.end();
    }
    return readBody(req).then(function (body) {
      var data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }, CORS2); }
      var stocks = (data.stocks || []).filter(function (s) { return s && /^[a-z]{2}\d{6}$/.test(s.code); });
      if (!stocks.length) return json(res, 400, { ok: false, error: '没有解析到股票代码' }, CORS2);
      var seen = {};
      var list = [];
      stocks.forEach(function (s) { if (!seen[s.code]) { seen[s.code] = 1; list.push({ code: s.code, name: s.name || '' }); } });
      collectMod.saveWatchlist({ source: 'cls.cn 自选股（页面导入）', capturedAt: new Date().toISOString(), count: list.length, stocks: list });
      console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] 自选股已更新：' + list.length + ' 只');
      refresh('自选股更新后刷新');
      return json(res, 200, { ok: true, count: list.length, note: '自选股已更新为 ' + list.length + ' 只，正在重新抓取' }, CORS2);
    });
  }

  if (p === '/api/pool/import') {
    const CORS3 = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS3);
      return res.end();
    }
    return readBody(req).then(function (body) {
      var data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }, CORS3); }
      var key = String(data.key || '').trim();
      if (!/^[a-z]{2}\d{6}$/.test(key)) return json(res, 400, { ok: false, error: '缺少合法 key（指数代码）' }, CORS3);
      var stocks = (data.stocks || []).filter(function (s) { return s && /^[a-z]{2}\d{6}$/.test(s.code); });
      if (!stocks.length) return json(res, 400, { ok: false, error: '没有解析到成分股' }, CORS3);
      var seen = {};
      var list = [];
      stocks.forEach(function (s) { if (!seen[s.code]) { seen[s.code] = 1; list.push({ code: s.code, name: s.name || '' }); } });
      var saved = collectMod.savePool(key, {
        key: key,
        name: data.name || key,
        code: key,
        kind: data.kind || 'index',
        source: data.source || 'cls.cn /ind 页面导入',
        capturedAt: new Date().toISOString(),
        count: list.length,
        stocks: list,
      });
      console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] 股票池已更新：' + (data.name || key) + ' ' + list.length + ' 只');
      return json(res, 200, { ok: true, key: key, count: list.length, saved: saved, note: '已保存 ' + list.length + ' 只' }, CORS3);
    });
  }

  if (p === '/api/session') {
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === 'GET') {
      return json(res, 200, { enabled: cls.hasAuth(), mode: cls.hasAuth() ? '已启用订阅登录态' : '未启用（仅公开内容）' }, CORS);
    }
    return readBody(req).then(function (body) {
      var data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }, CORS); }
      var tokenValue = String(data.token || '').trim();
      var uidValue = String(data.uid || '').trim();
      var cookieValue = String(data.cookie || '').trim();
      if (!tokenValue && !cookieValue) return json(res, 400, { ok: false, error: '需要 token 或 cookie' }, CORS);
      var localPath = path.join(ROOT, 'config.local.json');
      var cfg;
      try { cfg = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch (e) { cfg = {}; }
      cfg.auth = { token: tokenValue, uid: uidValue, cookie: cookieValue };
      fs.writeFileSync(localPath, JSON.stringify(cfg, null, 2), 'utf8');
      cls.setAuth(cfg.auth);
      refresh('启用登录态后回填正文');
      return json(res, 200, { ok: true, saved: localPath, note: '已保存到 config.local.json（仅本机），正在回填正文' }, CORS);
    });
  }

  if (p.startsWith('/exports/')) {
    const name = path.basename(p.slice('/exports/'.length));
    return serveFile(res, path.join(report.OUT_DIR, name));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

const port = Number(process.env.CLS_PORT || cfg().port || 8848);
const wl = collectMod.loadWatchlist();

/** 监听地址：始终包含回环；开启 tailscale 时额外绑定 Tailscale 网卡的 100.x 地址（局域网不可达）。 */
function bindAddresses() {
  const addrs = ['127.0.0.1'];
  if (cfg().tailscale === false) return addrs;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (!/tailscale/i.test(name)) continue;
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal && /^100\./.test(a.address)) addrs.push(a.address);
    }
  }
  return Array.from(new Set(addrs));
}

const addrs = bindAddresses();
const bound = new Set();
const listeners = [];

/** 每个地址一个独立 server 实例；新出现的地址（Tailscale 上线后分到的 100.x）由轮询自动补上。 */
function bindAll() {
  for (const addr of bindAddresses()) {
    if (bound.has(addr)) continue;
    bound.add(addr);
    const srv = http.createServer(handleRequest);
    srv.on('error', function (e) {
      bound.delete(addr);
      console.error('  绑定 ' + addr + ':' + port + ' 失败: ' + ((e && e.message) || e));
    });
    srv.listen(port, addr, function () {
      listeners.push(srv);
      console.log('  监听 http://' + addr + ':' + port + (addr === '127.0.0.1' ? '  （本机）' : '  （Tailscale 私有网络）'));
    });
  }
}

bindAll();

// Tailscale 的地址可能在运行中才出现或发生变化，定期补绑
setInterval(bindAll, 30000).unref();

setTimeout(function () {
  const store = collectMod.loadStore();
  console.log('');
  console.log('  财联社自选股 · 栏目新闻实时盯盘');
  console.log('  ------------------------------------------------');
  console.log('  自选股 ' + wl.count + ' 只 ｜ 目标栏目 ' + cfg().prefixes.join('、'));
  console.log('  回溯窗口 ' + cfg().days + ' 天 ｜ 刷新节奏 ' + (cfg().schedulePolicy === false
    ? '固定每 ' + cfg().refreshMinutes + ' 分钟'
    : '交易日盘中' + schedule.INTERVAL_MINUTES.tradingWindow + '分钟 · 交易日其他时段' + (schedule.INTERVAL_MINUTES.tradingOffHours / 60) + '小时 · 非交易日' + (schedule.INTERVAL_MINUTES.closed / 60) + '小时'));
  console.log('  已缓存文章 ' + Object.keys(store.articles || {}).length + ' 条');
  console.log('');
  console.log('  按 Ctrl+C 退出');
  console.log('');
  const first = !state.lastRunAt;
  refresh(first ? '启动首次抓取' : '启动刷新');
}, 1500);

process.on('SIGINT', function () {
  console.log('\n已停止。');
  process.exit(0);
});
