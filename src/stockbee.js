'use strict';
/**
 * Stockbee Momentum Burst —— A股近 N 个月信号 + 前瞻收益研究
 *
 * 与 skill (stockbee-momentum-burst-screener) 的对应关系：
 *   4% 突破       close/prevClose >= 4%，且成交量大于前一日并高于流动性下限
 *   绝对涨幅突破   close-open >= 阈值（默认 0.90 元）且量能达标
 *   区间扩张       当日振幅大于前 3 日振幅最大值，且前一日未被拉爆、量能确认
 *   评分结构       触发强度 / 量能扩张 / 前期收缩基底 / 收盘位置 / 风险距离 / 失败过滤 / 市场闸门
 *
 * A 股适配：
 *   - 价格为人民币，腾讯前复权日线（qfq），成交量统一换算成「股」；
 *   - 市场闸门用上证指数（sh000001）收盘对 20/50 日均线的位置逐日判定；
 *   - 默认剔除 ST / *ST / 退市整理股（涨跌幅限制不同，4% 突破含义失真）。
 *
 * 输出：
 *   out/stockbee.json         结构化结果（含逐条信号、前瞻收益与汇总统计）
 *   out/stockbee.csv          可直接用 Excel 打开的表格
 *   out/stockbee/index.html   移动端可看的表格页（GitHub Pages 发布 stockbee/）
 *
 * 用法：
 *   node src/stockbee.js                              # 扫描近 3 个月
 *   node src/stockbee.js --limit 80                   # 只跑前 80 只（试跑）
 *   node src/stockbee.js --skip-if-fresh              # 已发布数据覆盖最新交易日的，跳过抓取
 *   node src/stockbee.js --months 3 --concurrency 16
 */
const fs = require('node:fs');
const path = require('node:path');
const collect = require('./collect.js');

const OUT_DIR = path.join(collect.ROOT, 'out');
const JSON_FILE = path.join(OUT_DIR, 'stockbee.json');
const CSV_FILE = path.join(OUT_DIR, 'stockbee.csv');
const HTML_FILE = path.join(OUT_DIR, 'stockbee', 'index.html');
const BARS_CACHE = path.join(OUT_DIR, 'stockbee-bars.json');

const TX_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const SINA_URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const INDEX_CODE = 'sh000001';

const DEFAULTS = {
  months: 3,
  pool: 'all-a',
  concurrency: 12,
  datalen: 150,
  minPrice: 3,
  minVolume: 1000000,
  nineMillion: 9000000,
  fourPct: 4,
  dollar: 0.9,
  maxPrevDayGainForRange: 2,
  minBaseDays: 3,
  maxBaseDays: 20,
  maxBaseWidth: 15,
  maxPriorAvgRange: 5,
  narrowPriorRange: 3,
  maxRiskPct: 10,
  breakdownLookback: 5,
  breakdownPct: 4,
  minScore: 70,
  require4pct: true,
  maxRows: 12000,
  maxScanMinutes: 25,
};

/* ------------------------------------------------------------ 工具 */

function parseArgs(argv) {
  const o = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = function () { return argv[++i]; };
    if (a === '--months') o.months = Number(next());
    else if (a === '--pool') o.pool = next();
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--datalen') o.datalen = Number(next());
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--min-score') o.minScore = Number(next());
    else if (a === '--max-rows') o.maxRows = Number(next());
    else if (a === '--any-trigger') o.require4pct = false;
    else if (a === '--max-scan-minutes') o.maxScanMinutes = Number(next());
    else if (a === '--include-st') o.includeSt = true;
    else if (a === '--skip-if-fresh') o.skipIfFresh = true;
    else if (a === '--force') o.force = true;
    else if (a === '--no-cache') o.noCache = true;
    else if (a === '--quiet') o.quiet = true;
  }
  return o;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function shanghaiParts(d) {
  const t = d || new Date();
  const s = t.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
  const m = /(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/.exec(s);
  if (!m) return { day: '1970-01-01', hhmm: 0 };
  const pad = function (x) { return String(x).padStart(2, '0'); };
  return {
    day: m[3] + '-' + pad(m[1]) + '-' + pad(m[2]),
    hhmm: Number(m[4]) * 100 + Number(m[5]),
  };
}

function monthsBefore(day, months) {
  const p = day.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1 - months, p[2]));
  const pad = function (x) { return String(x).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

async function fetchJson(url, tries) {
  const maxTry = tries === undefined ? 3 : tries;
  let last;
  for (let i = 0; i <= maxTry; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 20000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < maxTry) await new Promise(function (r) { setTimeout(r, 400 * (i + 1)); });
    }
  }
  throw last || new Error('fetch failed');
}

/* ------------------------------------------------------------ 取数 */

/** 腾讯前复权日线；返回 {day,o,c,h,l,v}，v 已换算成股。 */
async function fetchTencent(code, n) {
  const url = TX_URL + '?param=' + encodeURIComponent(code + ',day,,,' + n + ',qfq');
  const j = await fetchJson(url, 2);
  const d = j && j.data && j.data[code];
  const arr = (d && (d.qfqday || d.day)) || [];
  return arr.map(function (x) {
    return { day: String(x[0]), o: Number(x[1]), c: Number(x[2]), h: Number(x[3]), l: Number(x[4]), v: Number(x[5]) * 100 };
  }).filter(function (x) { return x.day && x.c > 0 && x.h >= x.l; });
}

/** 兜底：新浪日线（不复权，成交量单位本身是股）。 */
async function fetchSina(code, n) {
  const url = SINA_URL + '?symbol=' + encodeURIComponent(code) + '&scale=240&ma=no&datalen=' + n;
  const j = await fetchJson(url, 2);
  if (!Array.isArray(j)) return [];
  return j.map(function (x) {
    return { day: String(x.day), o: Number(x.open), c: Number(x.close), h: Number(x.high), l: Number(x.low), v: Number(x.volume) };
  }).filter(function (x) { return x.day && x.c > 0 && x.h >= x.l; });
}

async function fetchBars(code, n) {
  try {
    const b = await fetchTencent(code, n);
    if (b.length >= 30) return { bars: b, src: 'tencent-qfq' };
  } catch (_) { /* 落到新浪 */ }
  const s = await fetchSina(code, n);
  return { bars: s, src: 'sina-raw' };
}

/* ------------------------------------------------------------ 指标 */

function avg(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const x of list) s += x;
  return s / list.length;
}

function closeLocation(bar) {
  const r = bar.h - bar.l;
  if (r <= 0) return 50;
  return ((bar.c - bar.l) / r) * 100;
}

/** 与 skill 一致的基底识别：在触发日之前找宽度 <= maxWidth 且平均振幅 <= maxAvgRange 的最长窗口。 */
function detectBase(bars, i, o) {
  const longest = Math.min(o.maxBaseDays, i);
  let best = null;
  for (let w = o.minBaseDays; w <= longest; w++) {
    const prior = bars.slice(i - w, i);
    const ref = prior[0].c;
    if (!(ref > 0)) continue;
    let hi = -Infinity, lo = Infinity, sum = 0;
    for (const b of prior) {
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
      if (b.c > 0) sum += ((b.h - b.l) / b.c) * 100;
    }
    const width = ((hi - lo) / ref) * 100;
    const avgRange = sum / prior.length;
    if (width > o.maxBaseWidth || avgRange > o.maxPriorAvgRange) continue;
    const older = bars.slice(Math.max(0, i - w * 2), i - w);
    const baseVol = avg(prior.map(function (b) { return b.v; }));
    const olderVol = older.length ? avg(older.map(function (b) { return b.v; })) : 0;
    const dry = !!(olderVol && baseVol <= olderVol * 0.85);
    if (!best || w > best.days || (w === best.days && width < best.width)) {
      best = { days: w, width: width, avgRange: avgRange, dry: dry };
    }
  }
  if (best) return best;
  const w = Math.min(longest, Math.max(o.minBaseDays, 1), i);
  const prior = bars.slice(i - w, i);
  const ref = prior.length ? prior[0].c : 1;
  let hi = -Infinity, lo = Infinity, sum = 0;
  for (const b of prior) {
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
    if (b.c > 0) sum += ((b.h - b.l) / b.c) * 100;
  }
  return {
    days: 0,
    width: prior.length ? ((hi - lo) / ref) * 100 : 0,
    avgRange: prior.length ? sum / prior.length : 0,
    dry: false,
  };
}

function detectTrigger(bars, i, o) {
  const cur = bars[i], prev = bars[i - 1], prev2 = bars[i - 2];
  const gain = (cur.c / prev.c - 1) * 100;
  const dollar = cur.c - cur.o;
  const range = cur.h - cur.l;
  const rangePct = (range / cur.c) * 100;
  const priorMax = Math.max(bars[i - 1].h - bars[i - 1].l, bars[i - 2].h - bars[i - 2].l, bars[i - 3].h - bars[i - 3].l);
  const prevGain = (prev.c / prev2.c - 1) * 100;
  const vr1 = prev.v > 0 ? cur.v / prev.v : 0;
  const avg20 = avg(bars.slice(Math.max(0, i - 20), i).map(function (b) { return b.v; }));
  const vr20 = avg20 > 0 ? cur.v / avg20 : 0;

  const volOk = cur.v >= o.minVolume;
  const expanded = cur.v > prev.v;
  const tags = [];
  if (gain >= o.fourPct && expanded && volOk) tags.push('4pct_breakout');
  if (dollar >= o.dollar && volOk) tags.push('dollar_breakout');
  if (range > priorMax && prevGain <= o.maxPrevDayGainForRange && expanded && volOk) tags.push('range_expansion');
  if (cur.v >= o.nineMillion) tags.push('9m_volume');

  return {
    tags: tags,
    gain: gain,
    dollar: dollar,
    rangePct: rangePct,
    vr1: vr1,
    vr20: vr20,
    closeLoc: closeLocation(cur),
    prevGain: prevGain,
  };
}

function scoreCandidate(trigger, base, bars, i, o, gateScore) {
  const cur = bars[i], prev = bars[i - 1];
  let triggerScore = 0;
  if (trigger.tags.indexOf('4pct_breakout') >= 0) {
    triggerScore += 14;
    if (trigger.gain >= 7) triggerScore += 3;
  }
  if (trigger.tags.indexOf('range_expansion') >= 0) triggerScore += 10;
  if (trigger.tags.indexOf('dollar_breakout') >= 0) triggerScore += 8;
  if (trigger.tags.indexOf('9m_volume') >= 0) triggerScore += 2;
  triggerScore = Math.min(20, triggerScore);

  const best = Math.max(trigger.vr1, trigger.vr20);
  const volumeScore = best >= 3 ? 15 : best >= 2 ? 12 : best >= 1.5 ? 9 : best >= 1 ? 6 : 0;

  let setup = 0;
  if (base.days >= 10) setup += 10;
  else if (base.days >= 5) setup += 8;
  else if (base.days >= 3) setup += 6;
  else if (base.days > 0) setup += 3;
  if (base.width && base.width <= 8) setup += 7;
  else if (base.width <= 12) setup += 5;
  else if (base.width <= o.maxBaseWidth) setup += 3;
  const prevRangePct = prev.c > 0 ? ((prev.h - prev.l) / prev.c) * 100 : 0;
  if (prevRangePct <= o.narrowPriorRange) setup += 5;
  else if (prev.c < prev.o) setup += 4;
  if (base.dry) setup += 3;
  setup = Math.min(25, setup);

  const loc = trigger.closeLoc;
  const closeScore = loc >= 90 ? 10 : loc >= 80 ? 9 : loc >= 70 ? 7 : loc >= 60 ? 5 : loc >= 50 ? 3 : 0;

  const riskPct = ((cur.c - cur.l) / cur.c) * 100;
  const riskScore = riskPct <= 2.5 ? 15 : riskPct <= 4 ? 12 : riskPct <= 6 ? 8 : riskPct <= 8 ? 5 : riskPct <= 10 ? 2 : 0;

  let streak = 0;
  for (let k = 1; k <= 5 && i - k - 1 >= 0; k++) {
    if (bars[i - k].c > bars[i - k - 1].c) streak++;
    else break;
  }
  let breakdown = false;
  for (let k = 1; k <= o.breakdownLookback && i - k - 1 >= 0; k++) {
    if (((bars[i - k].c / bars[i - k - 1].c) - 1) * 100 <= -Math.abs(o.breakdownPct)) { breakdown = true; break; }
  }
  let fail = 10;
  const soft = [];
  if (streak >= 3) { fail -= 4; soft.push('prior_3day_runup'); }
  if (breakdown) { fail -= 4; soft.push('recent_4pct_breakdown'); }
  if (base.width > o.maxBaseWidth) { fail -= 3; soft.push('wide_prior_base'); }
  if (loc < 50) { fail -= 2; soft.push('weak_close_location'); }
  fail = Math.max(0, fail);

  const score = triggerScore + volumeScore + setup + closeScore + riskScore + fail + gateScore;
  return {
    score: score,
    riskPct: riskPct,
    streak: streak,
    breakdown: breakdown,
    soft: soft,
    parts: { trigger: triggerScore, volume: volumeScore, setup: setup, close: closeScore, risk: riskScore, fail: fail, gate: gateScore },
  };
}

function ratingOf(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 70) return 'B';
  if (score >= 55) return 'Watch';
  return 'Reject';
}

const TAG_LABEL = {
  '4pct_breakout': '4%突破',
  dollar_breakout: '绝对涨幅突破',
  range_expansion: '区间扩张',
  '9m_volume': '巨量',
};

function patternOf(tags) {
  const order = ['4pct_breakout', 'range_expansion', 'dollar_breakout', '9m_volume'];
  return order.filter(function (t) { return tags.indexOf(t) >= 0; })
    .map(function (t) { return TAG_LABEL[t]; }).join(' + ');
}

function round(x, n) {
  const p = Math.pow(10, n === undefined ? 2 : n);
  return Math.round(x * p) / p;
}

/* ------------------------------------------------------------ 市场闸门 */

function buildGate(indexBars, lastCompleteDay) {
  const map = new Map();
  const closes = [];
  for (let i = 0; i < indexBars.length; i++) {
    const b = indexBars[i];
    if (b.day > lastCompleteDay) continue;
    closes.push(b.c);
    const ma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;
    const ma50 = closes.length >= 50 ? avg(closes.slice(-50)) : null;
    let gate = 3, label = '中性';
    if (ma20 && b.c > ma20) { gate = 5; label = '允许'; }
    else if (ma50 && b.c > ma50) { gate = 3; label = '中性'; }
    else { gate = 0; label = '收紧'; }
    map.set(b.day, { score: gate, label: label });
  }
  return map;
}

/* ------------------------------------------------------------ 主流程 */

async function loadBarsMap(codes, o, log) {
  const cache = o.noCache ? {} : (readJson(BARS_CACHE) || {});
  const out = new Map();
  const started = Date.now();
  const deadline = started + o.maxScanMinutes * 60 * 1000;
  let done = 0, fetched = 0, fromCache = 0, failed = 0;
  const queue = codes.slice();

  async function worker() {
    for (;;) {
      if (Date.now() > deadline) return;
      const code = queue.shift();
      if (!code) return;
      const hit = cache[code];
      if (hit && Array.isArray(hit.bars) && hit.bars.length >= 30) {
        out.set(code, hit.bars);
        fromCache++;
        done++;
        continue;
      }
      try {
        const r = await fetchBars(code, o.datalen);
        if (r.bars.length >= 30) { out.set(code, r.bars); cache[code] = { src: r.src, bars: r.bars }; }
        else failed++;
      } catch (_) { failed++; }
      fetched++;
      done++;
      if (!o.quiet && done % 250 === 0) {
        log('  已处理 ' + done + '/' + codes.length + '（新抓 ' + fetched + '，缓存 ' + fromCache + '，失败 ' + failed + '）');
      }
      if (Date.now() > deadline) return;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, o.concurrency); i++) workers.push(worker());
  await Promise.all(workers);

  if (!o.noCache) {
    try { writeJson(BARS_CACHE, cache); } catch (_) { /* 缓存写失败不影响结果 */ }
  }
  log('  取数完成：成功 ' + out.size + '，失败 ' + failed + '，用时 ' + Math.round((Date.now() - started) / 1000) + 's');
  return { bars: out, failed: failed };
}

function analyzeStock(stock, bars, o, gateMap, windowStart) {
  const found = [];
  const lastIdx = bars.length - 1;
  for (let i = 40; i <= lastIdx; i++) {
    const day = bars[i].day;
    if (day < windowStart) continue;
    if (i + 5 > lastIdx) { /* 前瞻不足 5 天，仍记录但不完整 */ }
    const trigger = detectTrigger(bars, i, o);
    if (!trigger.tags.length) continue;
    const executable = trigger.tags.filter(function (t) { return t !== '9m_volume'; });
    if (!executable.length) continue;
    const cur = bars[i];
    if (cur.c < o.minPrice || cur.v < o.minVolume) continue;
    const base = detectBase(bars, i, o);
    const gate = gateMap.get(day) || { score: 3, label: '中性' };
    const sc = scoreCandidate(trigger, base, bars, i, o, gate.score);
    if (sc.riskPct > o.maxRiskPct) continue;

    const fwd = [];
    for (let k = 1; k <= 5; k++) {
      if (i + k > lastIdx) { fwd.push(null); continue; }
      fwd.push(((bars[i + k].c / bars[i + k - 1].c) - 1) * 100);
    }
    const have = fwd.filter(function (x) { return x !== null; });
    const cum5 = i + 5 <= lastIdx ? ((bars[i + 5].c / cur.c) - 1) * 100 : null;
    const winDays = have.filter(function (x) { return x > 0; }).length;
    const winRate = have.length ? (winDays / have.length) * 100 : null;

    found.push({
      date: day,
      code: stock.code,
      name: stock.name,
      pattern: patternOf(trigger.tags),
      dayGain: round(trigger.gain),
      t1: fwd[0] === null ? null : round(fwd[0]),
      t2: fwd[1] === null ? null : round(fwd[1]),
      t3: fwd[2] === null ? null : round(fwd[2]),
      t4: fwd[3] === null ? null : round(fwd[3]),
      t5: fwd[4] === null ? null : round(fwd[4]),
      cum5: cum5 === null ? null : round(cum5),
      winDays: winDays,
      haveDays: have.length,
      winRate: winRate === null ? null : round(winRate, 1),
      complete: i + 5 <= lastIdx,
      score: sc.score,
      rating: ratingOf(sc.score),
      close: round(cur.c),
      low: round(cur.l),
      riskPct: round(sc.riskPct),
      vr1: round(trigger.vr1),
      vr20: round(trigger.vr20),
      closeLoc: round(trigger.closeLoc, 1),
      baseDays: base.days,
      baseWidth: round(base.width, 1),
      volume: Math.round(cur.v / 100),
      soft: sc.soft,
      gate: gate.label,
    });
  }
  return found;
}

function buildStats(rows) {
  const complete = rows.filter(function (r) { return r.complete; });
  const cums = complete.map(function (r) { return r.cum5; }).sort(function (a, b) { return a - b; });
  const median = cums.length ? (cums.length % 2 ? cums[(cums.length - 1) / 2] : (cums[cums.length / 2 - 1] + cums[cums.length / 2]) / 2) : null;
  const byPattern = {};
  for (const r of rows) {
    const k = r.pattern || '其他';
    if (!byPattern[k]) byPattern[k] = { n: 0, complete: 0, wins: 0, sum5: 0 };
    byPattern[k].n++;
    if (r.complete) { byPattern[k].complete++; byPattern[k].sum5 += r.cum5; if (r.cum5 > 0) byPattern[k].wins++; }
  }
  const patterns = Object.keys(byPattern).map(function (k) {
    const v = byPattern[k];
    return {
      pattern: k, n: v.n, complete: v.complete,
      winRate: v.complete ? round((v.wins / v.complete) * 100, 1) : null,
      avg5: v.complete ? round(v.sum5 / v.complete, 2) : null,
    };
  }).sort(function (a, b) { return b.n - a.n; });

  const byRating = {};
  for (const r of rows) {
    if (!byRating[r.rating]) byRating[r.rating] = { n: 0, complete: 0, wins: 0, sum5: 0 };
    byRating[r.rating].n++;
    if (r.complete) { byRating[r.rating].complete++; byRating[r.rating].sum5 += r.cum5; if (r.cum5 > 0) byRating[r.rating].wins++; }
  }
  const ratings = ['A', 'A-', 'B', 'Watch'].filter(function (k) { return byRating[k]; }).map(function (k) {
    const v = byRating[k];
    return {
      rating: k, n: v.n, complete: v.complete,
      winRate: v.complete ? round((v.wins / v.complete) * 100, 1) : null,
      avg5: v.complete ? round(v.sum5 / v.complete, 2) : null,
    };
  });

  const wins = complete.filter(function (r) { return r.cum5 > 0; }).length;
  const dayWins = rows.reduce(function (s, r) { return s + r.winDays; }, 0);
  const dayTotal = rows.reduce(function (s, r) { return s + r.haveDays; }, 0);
  return {
    signals: rows.length,
    stocks: new Set(rows.map(function (r) { return r.code; })).size,
    complete: complete.length,
    winRate5d: complete.length ? round((wins / complete.length) * 100, 1) : null,
    avg5: complete.length ? round(complete.reduce(function (s, r) { return s + r.cum5; }, 0) / complete.length, 2) : null,
    median5: median === null ? null : round(median, 2),
    best5: complete.length ? round(Math.max.apply(null, complete.map(function (r) { return r.cum5; })), 2) : null,
    worst5: complete.length ? round(Math.min.apply(null, complete.map(function (r) { return r.cum5; })), 2) : null,
    dayWinRate: dayTotal ? round((dayWins / dayTotal) * 100, 1) : null,
    patterns: patterns,
    ratings: ratings,
  };
}

/* ------------------------------------------------------------ 输出 */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(rows) {
  const head = ['日期', '代码', '名称', '形态', '当日涨幅%', 'T+1%', 'T+2%', 'T+3%', 'T+4%', 'T+5%', '5日累计%', '五日胜率%', '上涨天数', '已实现天数', '评分', '评级', '收盘', '止损参考', '风险%', '量比(昨)', '量比(20日)', '收盘位置%', '基底天数', '基底宽度%', '成交量(手)', '市场闸门'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.date, r.code, r.name, r.pattern, r.dayGain, r.t1, r.t2, r.t3, r.t4, r.t5, r.cum5,
      r.winRate, r.winDays, r.haveDays, r.score, r.rating, r.close, r.low, r.riskPct,
      r.vr1, r.vr20, r.closeLoc, r.baseDays, r.baseWidth, r.volume, r.gate,
    ].map(csvCell).join(','));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CSV_FILE, '\ufeff' + lines.join('\n'), 'utf8');
}

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f172a">
<title>Stockbee 动量爆发 · A股近三个月信号与前瞻收益</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--line:#e5e7eb;--ink:#1b1f24;--dim:#7a8290;--up:#d92b2b;--down:#0f9d58;--brand:#0f172a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 "Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--brand);color:#fff;padding:14px 16px 12px}
h1{font-size:17px;margin:0;font-weight:600}
.sub{font-size:12px;opacity:.82;margin-top:4px}
.wrap{padding:12px 10px 40px;max-width:1500px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.card .k{font-size:11.5px;color:var(--dim)}
.card .v{font-size:19px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);max-width:100%}
input[type=search]{min-width:170px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.tab{border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 11px;font-size:12.5px;cursor:pointer}
.tab.on{background:var(--brand);color:#fff;border-color:var(--brand)}
.scroll{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:auto;max-height:76vh}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px;white-space:nowrap}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
th{position:sticky;top:0;background:#f0f2f5;z-index:3;font-weight:600;cursor:pointer;user-select:none}
th.c,td.c{text-align:center}
th.l,td.l{text-align:left}
td.name,th.name{position:sticky;left:0;background:#fff;z-index:2}
th.name{background:#f0f2f5;z-index:4}
tr:hover td{background:#fafbfc}
tr:hover td.name{background:#fafbfc}
.up{color:var(--up)}
.down{color:var(--down)}
.tag{display:inline-block;font-size:11.5px;border-radius:4px;padding:1px 6px;background:#eef2f7;color:#33415c}
.rA{background:#fde8e8;color:#b91c1c}
.rAm{background:#fdeede;color:#b45309}
.rB{background:#e8f2fd;color:#1d4ed8}
.rW{background:#eef0f3;color:#4b5563}
.muted{color:var(--dim)}
.foot{font-size:12px;color:var(--dim);margin-top:10px;line-height:1.8}
.more{display:block;margin:10px auto 0;padding:9px 18px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}
@media (max-width:640px){h1{font-size:15.5px}.card .v{font-size:16.5px}th,td{padding:6px 7px}}
</style>
</head>
<body>
<header>
  <h1>Stockbee 动量爆发 · A股近三个月信号与前瞻收益</h1>
  <div class="sub" id="meta">加载中…</div>
</header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <div class="panel">
    <div class="row">
      <input type="search" id="q" placeholder="搜索代码 / 名称">
      <select id="from"></select>
      <select id="to"></select>
      <select id="rating">
        <option value="">全部评级</option>
        <option value="A">A（90+）</option>
        <option value="A-">A-（80-89）</option>
        <option value="B">B（70-79）</option>
        <option value="Watch">Watch（55-69）</option>
      </select>
      <select id="minScore">
        <option value="0">评分不限</option>
        <option value="70">评分 ≥70</option>
        <option value="80">评分 ≥80</option>
        <option value="90">评分 ≥90</option>
      </select>
      <select id="complete">
        <option value="">样本不限</option>
        <option value="done">仅完整 5 日样本</option>
        <option value="pending">仅待更新</option>
      </select>
      <button class="tab" id="compact">仅核心列</button>
      <span class="muted" id="count"></span>
    </div>
    <div class="tabs" id="patterns"></div>
  </div>
  <div class="scroll">
    <table id="tbl">
      <thead></thead>
      <tbody></tbody>
    </table>
  </div>
  <button class="more" id="more">显示更多</button>
  <div class="foot" id="foot"></div>
</div>
<script>
(function(){
  var PAYLOAD = null, ROWS = [], VIEW = [], PATTERN = '', SHOWN = 150, COMPACT = false;
  var COLS = [
    {k:'date',t:'日期',c:'c'},{k:'code',t:'代码',c:'c'},{k:'name',t:'名称',c:'l',sticky:1},
    {k:'pattern',t:'形态',c:'l'},{k:'dayGain',t:'当日涨幅',p:1},{k:'t1',t:'T+1',p:1},{k:'t2',t:'T+2',p:1},
    {k:'t3',t:'T+3',p:1},{k:'t4',t:'T+4',p:1},{k:'t5',t:'T+5',p:1},{k:'cum5',t:'5日累计',p:1,b:1},
    {k:'winRate',t:'五日胜率',suf:'%'},{k:'score',t:'评分',b:1},{k:'rating',t:'评级',c:'c'},
    {k:'close',t:'收盘价'},{k:'low',t:'止损参考'},{k:'riskPct',t:'风险',p:1,suf:'%'},
    {k:'vr1',t:'量比(昨)',suf:'x'},{k:'vr20',t:'量比(20日)',suf:'x'},{k:'closeLoc',t:'收盘位置',p:1,suf:'%'},
    {k:'baseDays',t:'基底天数'},{k:'baseWidth',t:'基底宽度',p:1,suf:'%'},{k:'volume',t:'成交量(手)'},{k:'gate',t:'市场闸门',c:'c'}
  ];
  var CORE = ['date','code','name','pattern','dayGain','t1','t2','t3','t4','t5','cum5','winRate','score'];
  var SORT = { k:'date', dir:-1 };
  var fmt = function(v, c){
    if (v === null || v === undefined) return '<span class="muted">—</span>';
    if (typeof v === 'number') {
      var s = c.p ? v.toFixed(c.p) : String(v);
      var cls = (c.b && v > 0) ? 'up' : (c.b && v < 0) ? 'down' : '';
      return '<span class="' + cls + '">' + s + (c.suf || '') + '</span>';
    }
    return String(v);
  };
  function rcls(r){ return r === 'A' ? 'rA' : r === 'A-' ? 'rAm' : r === 'B' ? 'rB' : 'rW'; }
  function render(){
    var cols = COLS.filter(function(c){ return !COMPACT || CORE.indexOf(c.k) >= 0; });
    var q = document.getElementById('q').value.trim().toLowerCase();
    var from = document.getElementById('from').value, to = document.getElementById('to').value;
    var rating = document.getElementById('rating').value, minScore = Number(document.getElementById('minScore').value) || 0;
    var complete = document.getElementById('complete').value;
    VIEW = ROWS.filter(function(r){
      if (PATTERN && r.pattern !== PATTERN) return false;
      if (complete === 'done' && !r.complete) return false;
      if (complete === 'pending' && r.complete) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      if (rating && r.rating !== rating) return false;
      if (r.score < minScore) return false;
      if (q && (r.code + r.name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    VIEW.sort(function(a,b){
      var x = a[SORT.k], y = b[SORT.k];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'string') return SORT.dir * x.localeCompare(y);
      return SORT.dir * (x - y);
    });
    var head = '<tr>' + cols.map(function(c){
      var cls = c.c === 'l' ? 'l' : c.c === 'c' ? 'c' : '';
      if (c.sticky) cls += ' name';
      return '<th class="' + cls + '" data-k="' + c.k + '">' + c.t + (SORT.k === c.k ? (SORT.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    }).join('') + '</tr>';
    document.querySelector('#tbl thead').innerHTML = head;
    var slice = VIEW.slice(0, SHOWN);
    document.querySelector('#tbl tbody').innerHTML = slice.map(function(r){
      return '<tr>' + cols.map(function(c){
        var cls = c.c === 'l' ? 'l' : c.c === 'c' ? 'c' : '';
        if (c.sticky) cls += ' name';
        if (c.k === 'date') return '<td class="' + cls + '">' + r.date + (r.complete ? '' : ' <span class="tag rW">待更新</span>') + '</td>';
        if (c.k === 'name') return '<td class="' + cls + '" title="基底 ' + r.baseDays + ' 天 / 宽 ' + r.baseWidth + '%">' + r.name + '</td>';
        if (c.k === 'pattern') return '<td class="' + cls + '"><span class="tag">' + r.pattern + '</span></td>';
        if (c.k === 'rating') return '<td class="' + cls + '"><span class="tag ' + rcls(r.rating) + '">' + r.rating + '</span></td>';
        if (c.k === 'winRate') return '<td class="' + cls + '">' + (r.winRate === null ? '—' : r.winRate + '% <span class="muted">(' + r.winDays + '/' + r.haveDays + ')</span>') + '</td>';
        return '<td class="' + cls + '">' + fmt(r[c.k], c) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    document.getElementById('count').textContent = '命中 ' + VIEW.length + ' 条 / 共 ' + ROWS.length + ' 条';
    document.getElementById('more').style.display = VIEW.length > SHOWN ? 'block' : 'none';
    document.getElementById('more').textContent = '显示更多（还有 ' + (VIEW.length - SHOWN) + ' 条）';
  }
  function init(){
    var s = PAYLOAD.stats || {};
    document.getElementById('meta').textContent = '数据更新：' + PAYLOAD.generatedAt + '　窗口：' + PAYLOAD.window.start + ' 起　最新交易日：' + PAYLOAD.lastCompleteDay + '　来源：' + PAYLOAD.source;
    document.getElementById('cards').innerHTML = [
      ['信号数', s.signals], ['涉及股票', s.stocks], ['完整5日样本', s.complete],
      ['5日累计均值', (s.avg5 === null ? '—' : s.avg5 + '%')], ['5日中位数', (s.median5 === null ? '—' : s.median5 + '%')],
      ['5日正收益率', (s.winRate5d === null ? '—' : s.winRate5d + '%')], ['单日胜率', (s.dayWinRate === null ? '—' : s.dayWinRate + '%')]
    ].map(function(x){ return '<div class="card"><div class="k">' + x[0] + '</div><div class="v">' + (x[1] === undefined || x[1] === null ? '—' : x[1]) + '</div></div>'; }).join('');
    var dates = Array.from(new Set(ROWS.map(function(r){ return r.date; }))).sort();
    var fo = document.getElementById('from'), toSel = document.getElementById('to');
    toSel.innerHTML = fo.innerHTML = '<option value="">全部日期</option>' + dates.map(function(d){ return '<option>' + d + '</option>'; }).join('');
    var pats = Array.from(new Set(ROWS.map(function(r){ return r.pattern; })));
    document.getElementById('patterns').innerHTML = '<span class="tab on" data-p="">全部形态</span>' + pats.map(function(p){ return '<span class="tab" data-p="' + p + '">' + p + '</span>'; }).join('');
    document.getElementById('foot').innerHTML = (PAYLOAD.note || '') +
      '<br>按形态统计：' + (s.patterns || []).map(function(p){ return p.pattern + ' ' + p.n + ' 条，5日正收益 ' + (p.winRate === null ? '—' : p.winRate + '%') + '，均值 ' + (p.avg5 === null ? '—' : p.avg5 + '%'); }).join('；') +
      '<br>按评级统计：' + (s.ratings || []).map(function(p){ return p.rating + ' ' + p.n + ' 条，5日正收益 ' + (p.winRate === null ? '—' : p.winRate + '%') + '，均值 ' + (p.avg5 === null ? '—' : p.avg5 + '%'); }).join('；');
    render();
  }
  document.querySelector('#tbl thead').addEventListener('click', function(e){
    var th = e.target.closest('th'); if (!th) return;
    var k = th.getAttribute('data-k');
    if (SORT.k === k) SORT.dir = -SORT.dir; else { SORT.k = k; SORT.dir = -1; }
    render();
  });
  document.getElementById('q').addEventListener('input', function(){ SHOWN = 150; render(); });
  ['from','to','rating','minScore','complete'].forEach(function(id){ document.getElementById(id).addEventListener('change', function(){ SHOWN = 150; render(); }); });
  document.getElementById('patterns').addEventListener('click', function(e){
    var t = e.target.closest('.tab'); if (!t) return;
    PATTERN = t.getAttribute('data-p'); SHOWN = 150;
    Array.prototype.forEach.call(this.querySelectorAll('.tab'), function(x){ x.classList.toggle('on', x === t); });
    render();
  });
  document.getElementById('more').addEventListener('click', function(){ SHOWN += 300; render(); });
  document.getElementById('compact').addEventListener('click', function(){ COMPACT = !COMPACT; this.classList.toggle('on', COMPACT); render(); });
  function load(){
    fetch('stockbee.json').then(function(r){ return r.json(); }).then(function(j){
      PAYLOAD = j; ROWS = j.rows || [];
      if (!document.getElementById('cards').innerHTML) init(); else { SHOWN = Math.max(SHOWN, 150); render(); }
      document.getElementById('meta').textContent = '数据更新：' + j.generatedAt + '　窗口：' + j.window.start + ' 起　最新交易日：' + j.lastCompleteDay + '　来源：' + j.source;
    }).catch(function(){});
  }
  load();
  setInterval(load, 600000);
})();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------ main */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = function (s) { if (!o.quiet) console.log(s); };
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('=== Stockbee Momentum Burst · A股 ===');
  const indexBars = (await fetchBars(INDEX_CODE, 400)).bars;
  if (!indexBars.length) throw new Error('无法获取上证指数日线，无法判定交易日与市场闸门');
  const bj = shanghaiParts();
  let lastIdxDay = indexBars[indexBars.length - 1].day;
  if (lastIdxDay === bj.day && bj.hhmm < 1505) lastIdxDay = indexBars[indexBars.length - 2].day;
  const windowStart = monthsBefore(lastIdxDay, o.months);

  if (o.skipIfFresh && !o.force) {
    const published = readJson(JSON_FILE);
    if (published && published.lastCompleteDay === lastIdxDay && Array.isArray(published.rows)) {
      log('  已发布数据已覆盖最新交易日 ' + lastIdxDay + '，跳过抓取，仅重新生成页面');
      fs.mkdirSync(path.dirname(HTML_FILE), { recursive: true });
      fs.writeFileSync(HTML_FILE, renderHtml(), 'utf8');
      writeCsv(published.rows);
      return;
    }
  }

  const pool = collect.loadPool(o.pool);
  if (!pool || !Array.isArray(pool.stocks) || !pool.stocks.length) {
    throw new Error('股票池为空：先运行 node src/cli.js 或 node src/collect.js 同步 ' + o.pool);
  }
  let universe = pool.stocks.filter(function (s) { return s && s.code && s.name; })
    .map(function (s) { return { code: s.code, name: String(s.name).trim() }; });
  if (!o.includeSt) universe = universe.filter(function (s) { return !/ST|退/.test(s.name); });
  if (o.limit) universe = universe.slice(0, o.limit);
  log('  股票池 ' + pool.key + '：' + universe.length + ' 只；窗口 ' + windowStart + ' ~ ' + lastIdxDay);

  const gateMap = buildGate(indexBars, lastIdxDay);
  const fetched = await loadBarsMap(universe.map(function (s) { return s.code; }), o, log);

  const rows = [];
  let scanned = 0;
  for (const s of universe) {
    const bars = fetched.bars.get(s.code);
    if (!bars || bars.length < 45) continue;
    scanned++;
    for (const r of analyzeStock(s, bars, o, gateMap, windowStart)) {
      if (r.score < o.minScore) continue;
      if (o.require4pct && r.pattern.indexOf('4%突破') < 0) continue;
      rows.push(r);
    }
  }
  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.score - a.score;
  });

  const truncated = rows.length > o.maxRows;
  if (truncated) rows.length = o.maxRows;

  const stats = buildStats(rows);
  const payload = {
    version: 1,
    skill: 'stockbee-momentum-burst-screener',
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    source: '腾讯前复权日线(qfq) + 新浪兜底；市场闸门用上证指数',
    window: { start: windowStart, end: lastIdxDay, months: o.months },
    lastCompleteDay: lastIdxDay,
    thresholds: {
      minPrice: o.minPrice, minVolumeShares: o.minVolume, fourPct: o.fourPct, dollar: o.dollar,
      maxRiskPct: o.maxRiskPct, minScore: o.minScore, maxBaseWidth: o.maxBaseWidth,
    },
    coverage: { pool: pool.key, universe: universe.length, scanned: scanned, barsOk: fetched.bars.size, failed: fetched.failed },
    truncated: truncated,
    stats: stats,
    note: '纳入标准：触发日含 4% 突破，且评分 ≥ ' + o.minScore + '（B 及以上）；已剔除 ST / *ST / 退市整理股，不含北交所。口径：以触发日收盘价为基准（T0 收盘 = 入场参考），T+N 为之后第 N 个交易日的单日涨幅，5日累计 = T+5 收盘 / T0 收盘 - 1；五日胜率 = 已实现交易日中收涨天数占比，标「待更新」的信号其后交易日尚未走完。价格为前复权，成交量按股计算、表中显示为手。仅为人工复核候选，不构成投资建议。',
    rows: rows,
  };

  writeJson(JSON_FILE, payload);
  writeJson(path.join(path.dirname(HTML_FILE), 'stockbee.json'), payload);
  writeCsv(rows);
  fs.mkdirSync(path.dirname(HTML_FILE), { recursive: true });
  fs.writeFileSync(HTML_FILE, renderHtml(), 'utf8');

  log('  信号 ' + stats.signals + ' 条，涉及 ' + stats.stocks + ' 只；完整 5 日样本 ' + stats.complete);
  log('  5 日累计：均值 ' + stats.avg5 + '%，中位数 ' + stats.median5 + '%，正收益率 ' + stats.winRate5d + '%，单日胜率 ' + stats.dayWinRate + '%');
  log('  输出：' + JSON_FILE);
  log('        ' + CSV_FILE);
  log('        ' + HTML_FILE);
  log('  总用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
}

if (require.main === module) {
  main().catch(function (e) { console.error('ERROR: ' + ((e && e.stack) || e)); process.exit(1); });
}

module.exports = { main: main, detectTrigger: detectTrigger, detectBase: detectBase, analyzeStock: analyzeStock };
