'use strict';
/**
 * 技术面结论（周线）——把 technical-analyst skill 的判定框架做成可批量执行的版本。
 *
 * 与 skill 的对应关系：
 *   趋势分析      -> 近 26 周摆动高低点结构（HH/HL vs LH/LL）+ 均线排列
 *   支撑阻力      -> 5 周枢轴摆动点 + 52 周高低
 *   均线分析      -> 20 / 50 / 200 周均线（位置、斜率、是否测试）
 *   成交量        -> 当周量比（对 20 周均量）与当周涨跌方向
 *   形态与价格行为 -> 收盘位置、连续阴阳、偏离 20 周均线幅度
 *   情景与概率    -> 按规则打分映射为倾向 + 主导情景概率 + 失效位
 *
 * 数据源：新浪长历史日线（最多 1023 根，约 4 年，不复权），聚合为周线。
 * 不复权相对前复权在最近一年的价位上差距约 1%，200 周均线约 3%，趋势与量能判定不受影响。
 * 结果按股票缓存到 data/technical.json（默认 24 小时刷新一次）。
 */
const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');
const cls = require('./cls.js');

const CACHE_FILE = path.join(collectMod.DATA_DIR, 'technical.json');
const SINA = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

/* ------------------------------------------------------------ 取数 */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadCache() {
  const x = readJson(CACHE_FILE);
  return x && x.stocks ? x : { version: 1, source: 'sina-unadjusted', updatedAt: null, stocks: {} };
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

async function fetchDaily(code, retries) {
  const url = SINA + '?symbol=' + encodeURIComponent(code) + '&scale=240&ma=no&datalen=1023';
  let last;
  const maxTry = retries === undefined ? 3 : retries;
  for (let i = 0; i <= maxTry; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 20000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } });
      clearTimeout(timer);
      // 456 是新浪的限流码，退避后重试
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!Array.isArray(body) || !body.length) throw new Error('空数据');
      return body.map(function (x) {
        return { day: String(x.day), o: Number(x.open), h: Number(x.high), l: Number(x.low), c: Number(x.close), v: Number(x.volume) };
      }).filter(function (x) { return Number.isFinite(x.c) && x.c > 0; });
    } catch (e) {
      last = e;
      if (i < maxTry) {
        const throttled = /456/.test(String(e && e.message || e));
        const wait = throttled ? 1500 * (i + 1) : 400 * (i + 1);
        await new Promise(function (r) { setTimeout(r, wait); });
      }
    }
  }
  throw last;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** 兜底数据源：财联社日线（约 200 根），用于新浪没有数据的次新股。 */
async function fetchDailyCls(code) {
  const body = await cls.xquote('/v2/quote/a/kline', { code: code, period: 'd', limit: 300 });
  const list = (body && body.data) || [];
  if (!list.length) throw new Error('财联社无数据');
  return list.map(function (x) {
    const d = String(x.trade_date);
    return {
      day: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
      o: Number(x.open_px), h: Number(x.high_px), l: Number(x.low_px), c: Number(x.close_px),
      v: Number(x.business_amount) || 0,
    };
  }).filter(function (x) { return Number.isFinite(x.c) && x.c > 0; });
}

/** 先新浪（长历史），次新股退回财联社。 */
async function fetchDailyAny(code) {
  try {
    return { rows: await fetchDaily(code), source: 'sina' };
  } catch (e) {
    return { rows: await fetchDailyCls(code), source: 'cls', note: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------ 周线聚合 */

/** 周一为一周开始，返回该周最后一个交易日（周五）的日期键。 */
function weekKey(day) {
  const dt = new Date(day + 'T00:00:00Z');
  const dow = (dt.getUTCDay() + 6) % 7; // 周一=0
  dt.setUTCDate(dt.getUTCDate() - dow + 4); // 该周周五
  return dt.toISOString().slice(0, 10);
}

function toWeekly(daily) {
  const out = [];
  let cur = null;
  for (const x of daily) {
    const k = weekKey(x.day);
    if (!cur || cur.week !== k) {
      cur = { week: k, o: x.o, h: x.h, l: x.l, c: x.c, v: 0, days: 0 };
      out.push(cur);
    }
    cur.h = Math.max(cur.h, x.h);
    cur.l = Math.min(cur.l, x.l);
    cur.c = x.c;
    cur.v += x.v;
    cur.days++;
  }
  // 去掉本周未走完的那根（最后一个键在未来或不完整时保留，因为盘中也有参考价值）
  return out;
}

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const p = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(v * p) / p;
}

/* -------------------------------------------------- 指标与摆动点 */

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
}

function swings(w, span) {
  const half = Math.floor((span || 5) / 2);
  const highs = [];
  const lows = [];
  for (let i = half; i < w.length - half; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - half; j <= i + half; j++) {
      if (w[j].h > w[i].h) isHigh = false;
      if (w[j].l < w[i].l) isLow = false;
    }
    if (isHigh) highs.push({ week: w[i].week, price: w[i].h });
    if (isLow) lows.push({ week: w[i].week, price: w[i].l });
  }
  return { highs: highs, lows: lows };
}

function compute(weekly) {
  const w = weekly.filter(function (x) { return x.days >= 1; });
  if (!w.length) return null;
  // 次新股：周线样本太少，不做方向判断，只标注上市周数
  if (w.length < 30) {
    const last0 = w[w.length - 1];
    return { young: true, weeks: w.length, week: last0.week, close: round(last0.c, 2) };
  }
  const closes = w.map(function (x) { return x.c; });
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  const at = function (n) { return closes.length >= n ? mean(closes.slice(-n)) : null; };
  const ma20 = at(20);
  const ma50 = at(50);
  const ma200 = at(200);
  const maBack = function (n, back) {
    const end = closes.length - back;
    return closes.length >= end && end >= n ? mean(closes.slice(end - n, end)) : null;
  };
  const slopeOf = function (n, back) {
    const now = maBack(n, 0);
    const then = maBack(n, back);
    return now === null || then === null ? null : now - then;
  };
  const vma20 = w.length >= 20 ? mean(w.slice(-20).map(function (x) { return x.v; })) : null;
  const volRatio = vma20 ? last.v / vma20 : null;

  let up = 0;
  let dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const a = 1 / 14;
    up = up * (1 - a) + Math.max(ch, 0) * a;
    dn = dn * (1 - a) + Math.max(-ch, 0) * a;
  }
  const rsi = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);

  const win52 = w.slice(-52);
  const win104 = w.slice(-104);
  const high52 = Math.max.apply(null, win52.map(function (x) { return x.h; }));
  const low52 = Math.min.apply(null, win52.map(function (x) { return x.l; }));
  const high52w = win52[win52.reduce(function (bi, x, i, a) { return x.h > a[bi].h ? i : bi; }, 0)].week;
  const low52w = win52[win52.reduce(function (bi, x, i, a) { return x.l < a[bi].l ? i : bi; }, 0)].week;
  const rangePos = high52 > low52 ? (last.c - low52) / (high52 - low52) : null;

  const sw = swings(w, 5);
  const recentHighs = sw.highs.slice(-5);
  const recentLows = sw.lows.slice(-5);

  // 近 26 周结构：比较最近两个摆动高/低
  let structure = 'mixed';
  const hh = recentHighs.length >= 2 ? recentHighs[recentHighs.length - 1].price > recentHighs[recentHighs.length - 2].price : null;
  const hl = recentLows.length >= 2 ? recentLows[recentLows.length - 1].price > recentLows[recentLows.length - 2].price : null;
  if (hh === true && hl === true) structure = 'up';
  else if (hh === false && hl === false) structure = 'down';

  const slope20 = slopeOf(20, 4);
  const slope50 = slopeOf(50, 4);
  const slope200 = slopeOf(200, 4);
  const chgPct = prev && prev.c ? (last.c / prev.c - 1) * 100 : null;

  return {
    week: last.week,
    weeks: w.length,
    close: round(last.c, 2),
    prevClose: round(prev.c, 2),
    open: round(last.o, 2),
    high: round(last.h, 2),
    low: round(last.l, 2),
    chgPct: round(chgPct, 2),
    ma20: round(ma20, 2),
    ma50: round(ma50, 2),
    ma200: round(ma200, 2),
    slope20: round(slope20, 3),
    slope50: round(slope50, 3),
    slope200: round(slope200, 3),
    volRatio: round(volRatio, 2),
    rsi14: round(rsi, 1),
    high52: round(high52, 2),
    low52: round(low52, 2),
    high52Week: high52w,
    low52Week: low52w,
    rangePos: round(rangePos, 3),
    structure: structure,
    swingHighs: recentHighs.map(function (x) { return { week: x.week, price: round(x.price, 2) }; }),
    swingLows: recentLows.map(function (x) { return { week: x.week, price: round(x.price, 2) }; }),
    high104: round(Math.max.apply(null, win104.map(function (x) { return x.h; })), 2),
    low104: round(Math.min.apply(null, win104.map(function (x) { return x.l; })), 2),
  };
}

/* ---------------------------------------------------- 结论（倾向） */

function pct(v) { return v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function num(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2); }

function analyse(m) {
  const c = m.close;
  let score = 0;

  // 结构
  if (m.structure === 'up') score += 1.5;
  else if (m.structure === 'down') score -= 1.5;

  const above20 = m.ma20 !== null && c > m.ma20;
  const above50 = m.ma50 !== null && c > m.ma50;
  const above200 = m.ma200 !== null && c > m.ma200;
  const at50 = m.ma50 !== null && Math.abs(c / m.ma50 - 1) <= 0.01;
  const bullAlign = above20 && above50 && above200 && m.ma20 >= m.ma50 && m.ma50 >= m.ma200 && (m.slope50 || 0) >= 0;
  const bearAlign = m.ma20 !== null && m.ma50 !== null && c < m.ma20 && m.ma20 < m.ma50;
  if (bullAlign) score += 2;
  else if (above20 && above200) score += 1;
  else if (bearAlign) score -= 1.5;

  if (at50) score += 0;
  else if (above50) score += 0.5;
  else score -= 0.5;

  const up = (m.chgPct || 0) > 0;
  if (m.volRatio !== null && m.volRatio >= 1.8) score += up ? 1 : -1;

  if (m.rsi14 !== null && m.rsi14 >= 75) score -= 1;
  else if (m.rsi14 !== null && m.rsi14 <= 30) score += 1;

  if (m.ma20 !== null && c > m.ma20 * 1.25) score -= 0.75;
  else if (m.ma20 !== null && c < m.ma20 * 0.8) score += 0.5;

  if (m.rangePos !== null && m.rangePos >= 0.75) score += 1;
  else if (m.rangePos !== null && m.rangePos <= 0.25) score -= 1;

  // 趋势标签
  let trend;
  if (bullAlign && m.structure === 'up') trend = '上升趋势';
  else if (score >= 2 && m.structure === 'up') trend = '上升趋势（形成中）';
  else if (above20 && above200 && m.ma20 !== null && m.ma50 !== null && m.ma20 < m.ma50) trend = '下降末段的反转尝试';
  else if (score <= -1.5 || m.structure === 'down') trend = '下降趋势';
  else trend = '区间震荡';

  // 位置
  const posBits = [];
  posBits.push(above20 ? '高于 20 周均线 ' + num(m.ma20) : '低于 20 周均线 ' + num(m.ma20));
  if (m.ma50 !== null) posBits.push(at50 ? '正在测试 50 周均线 ' + num(m.ma50) : (above50 ? '站上 50 周均线 ' + num(m.ma50) : '受制于 50 周均线 ' + num(m.ma50)));
  if (m.ma200 !== null) posBits.push(above200 ? '远在 200 周均线 ' + num(m.ma200) + ' 之上' : '低于 200 周均线 ' + num(m.ma200));
  const position = posBits.join('；');

  // 量能
  let volume;
  if (m.volRatio === null) volume = '量能数据不足';
  else volume = '当周量比 ' + num(m.volRatio) + ' 倍（' + (m.volRatio >= 1.8 ? (up ? '放量上攻' : '放量下跌') : m.volRatio <= 0.7 ? '明显缩量' : '量能平稳') + '）';

  // 关键位：离现价最近的摆动支撑 / 阻力（并纳入 200 周均线与 52 周高低）
  const uniq = function (list) {
    const seen = {};
    return list.filter(function (p) { return Number.isFinite(p) && !seen[p] && (seen[p] = 1); });
  };
  const supCand = uniq(m.swingLows.map(function (x) { return x.price; })
    .concat(m.ma200 !== null && m.ma200 < c ? [m.ma200] : [])
    .filter(function (p) { return p < c * 0.995; })).sort(function (a, b) { return b - a; });
  const resCand = uniq(m.swingHighs.map(function (x) { return x.price; })
    .concat([m.high52])
    .filter(function (p) { return p > c * 1.005; })).sort(function (a, b) { return a - b; });
  const supText = supCand.length ? supCand.slice(0, 2).map(num).join(' / ') : num(m.low52);
  const resText = resCand.length ? resCand.slice(0, 2).map(num).join(' / ') : num(m.high52);
  const keyLevels = '支撑 ' + supText + ' ｜ 阻力 ' + resText;

  // 倾向与概率
  let tilt;
  let prob;
  if (score >= 3) { tilt = '偏多'; prob = 55; }
  else if (score >= 1.75) { tilt = '偏多'; prob = 50; }
  else if (score >= 0.6) { tilt = '中性偏多'; prob = 45; }
  else if (score > -0.6) { tilt = '中性（区间为主）'; prob = 45; }
  else if (score > -1.75) { tilt = '中性偏空'; prob = 45; }
  else { tilt = '偏空'; prob = 50; }

  const invalidation = tilt.indexOf('多') >= 0 ? (supCand[0] || m.low52) : (resCand[0] || m.high52);
  const text = [
    '趋势：' + trend + '（周线）',
    '位置：' + position,
    '量能：' + volume + '，当周 ' + pct(m.chgPct) + ' 收 ' + num(m.close),
    '关键位：' + keyLevels,
    '倾向：' + tilt + '（主导情景 ' + prob + '%）｜' + (tilt.indexOf('多') >= 0 ? ' 失效位 ' : ' 转强位 ') + num(invalidation),
  ].join('\n');
  return { score: round(score, 2), trend: trend, tilt: tilt, prob: prob, invalidation: round(invalidation, 2), text: text };
}

function conclusionFor(record) {
  if (!record || !record.metrics) return '技术面数据暂未取到（下一轮自动补齐）';
  const m = record.metrics;
  if (m.young) {
    return ['趋势：上市不足 ' + m.weeks + ' 周，周线样本不足',
      '位置：—',
      '量能：—',
      '关键位：—',
      '倾向：新股暂不做周线技术面判断'].join('\n');
  }
  return analyse(m).text;
}

/* -------------------------------------------------------- 缓存刷新 */

function isFresh(record, hours) {
  if (!record || !record.at) return false;
  const age = Date.now() - new Date(record.at).getTime();
  // 失败记录 1 小时后重试，避免偶尔的接口抖动把某只股票长期钉在“取不到”
  if (record.error) return age < 3600000;
  return age < hours * 3600000;
}

function attachRows(rows, cache) {
  const c = cache || loadCache();
  for (const r of rows) {
    const rec = c.stocks[r.stockCode];
    r.technicalConclusion = conclusionFor(rec);
    r.technicalAt = rec && rec.at || null;
    r.technicalWeek = rec && rec.metrics && rec.metrics.week || null;
  }
  return rows;
}

function runPool(items, worker, concurrency) {
  return collectMod.runPool(items, worker, concurrency);
}

async function refresh(rows, opts) {
  opts = opts || {};
  const cfg = opts.config || collectMod.loadConfig();
  const tcfg = cfg.technical || {};
  if (tcfg.enabled === false) return attachRows(rows);
  const hours = Number(tcfg.refreshHours || 24);
  const concurrency = Number(tcfg.concurrency || 3);
  const delayMs = Number(tcfg.requestDelayMs === undefined ? 120 : tcfg.requestDelayMs);
  const cache = loadCache();
  const codes = new Map();
  for (const r of rows) if (r.stockCode && !codes.has(r.stockCode)) codes.set(r.stockCode, r.stockName || '');
  let stale = Array.from(codes.keys()).filter(function (code) { return !isFresh(cache.stocks[code], hours); });
  // 每轮最多刷新多少只：云端用它可以避免一次抓几百只被数据源限流（0 = 不限）
  const maxPerRun = Number(tcfg.maxPerRun || 0);
  const deferred = maxPerRun > 0 && stale.length > maxPerRun ? stale.length - maxPerRun : 0;
  if (deferred) {
    stale = stale.slice().sort(function (a, b) {
      const ta = cache.stocks[a] && cache.stocks[a].at ? new Date(cache.stocks[a].at).getTime() : 0;
      const tb = cache.stocks[b] && cache.stocks[b].at ? new Date(cache.stocks[b].at).getTime() : 0;
      return ta - tb;
    }).slice(0, maxPerRun);
  }
  let done = 0;
  let errors = 0;
  await runPool(stale, async function (code) {
    try {
      if (delayMs > 0) await sleep(delayMs);
      const got = await fetchDailyAny(code);
      const metrics = compute(toWeekly(got.rows));
      if (!metrics) throw new Error('周线数据不足');
      cache.stocks[code] = { code: code, name: codes.get(code) || '', at: new Date().toISOString(), source: got.source, metrics: metrics };
    } catch (e) {
      errors++;
      if (!cache.stocks[code]) cache.stocks[code] = { code: code, name: codes.get(code) || '', at: new Date().toISOString(), error: String((e && e.message) || e) };
    }
    done++;
    if (opts.onProgress) opts.onProgress({ done: done, total: stale.length, errors: errors, cached: codes.size - stale.length });
    if (done % 25 === 0) saveCache(cache);
  }, Math.max(1, concurrency));
  saveCache(cache);
  attachRows(rows, cache);
  return { rows: rows, total: codes.size, refreshed: stale.length, cached: codes.size - stale.length - deferred, errors: errors, deferred: deferred };
}

module.exports = {
  CACHE_FILE: CACHE_FILE,
  loadCache: loadCache,
  saveCache: saveCache,
  fetchDaily: fetchDaily,
  fetchDailyCls: fetchDailyCls,
  fetchDailyAny: fetchDailyAny,
  toWeekly: toWeekly,
  compute: compute,
  analyse: analyse,
  conclusionFor: conclusionFor,
  attachRows: attachRows,
  refresh: refresh,
};
