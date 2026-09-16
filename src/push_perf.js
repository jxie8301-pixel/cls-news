'use strict';

/**
 * 推送复盘：按 push_stock 计算 T0 收盘基准与 T+1～T+5 单日涨幅，写回同一库。
 *
 * 口径：
 *   - T0 = 新闻所属交易日；盘后(≥15:00 上海)或非交易日 → 下一交易日
 *   - 基准价 = T0 收盘；tN_pct = (TN 收盘 / T{N-1} 收盘 - 1) * 100
 *   - cum5_pct = (T5 收盘 / T0 收盘 - 1) * 100（未满 5 日则为已实现末日累计）
 *
 * 用法：
 *   node src/push_perf.js
 *   node src/push_perf.js --db data/pushes.db --concurrency 8
 */

const path = require('node:path');
const quotes = require('./quotes.js');
const pushDb = require('./push_db.js');

const INDEX_CODE = 'sh000001';
const CLOSE_HM = 1500; // 上海 15:00 视为盘后

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function bjParts(sec) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(sec * 1000));
  const get = function (t) {
    const hit = parts.find(function (p) { return p.type === t; });
    return hit ? hit.value : '00';
  };
  const day = get('year') + get('month') + get('day');
  const hm = Number(get('hour')) * 100 + Number(get('minute'));
  return { day: day, hm: hm };
}

function fullCode(code) {
  const raw = String(code || '').trim();
  if (/^(sh|sz|bj)\d{6}$/i.test(raw)) return raw.toLowerCase();
  const c = raw.replace(/^[a-zA-Z]+/, '');
  if (/^6\d{5}$/.test(c) || /^9\d{5}$/.test(c)) return 'sh' + c;
  if (/^[03]\d{5}$/.test(c)) return 'sz' + c;
  if (/^[48]\d{5}$/.test(c)) return 'bj' + c;
  return 'sz' + c;
}

function pureCode(code) {
  return String(code || '').replace(/^[a-zA-Z]+/, '');
}

function round2(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function barClose(bar) {
  if (!bar) return null;
  const v = bar.close_px != null ? bar.close_px : bar.close;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function barChangePct(bar) {
  if (!bar) return null;
  if (bar.change != null && Number.isFinite(Number(bar.change))) return round2(Number(bar.change));
  const close = barClose(bar);
  const prev = bar.preclose_px != null ? Number(bar.preclose_px) : null;
  if (close == null || prev == null || !prev) return null;
  return round2(((close / prev) - 1) * 100);
}

/** 交易日列表升序 YYYYMMDD */
async function loadTradeDays() {
  const bars = await quotes.dailyBars(INDEX_CODE, 60);
  return Array.from(bars.keys()).sort();
}

function resolveT0Date(ctime, tradeDays) {
  const p = bjParts(ctime);
  const afterClose = p.hm >= CLOSE_HM;
  if (afterClose) {
    for (let i = 0; i < tradeDays.length; i++) {
      if (tradeDays[i] > p.day) return tradeDays[i];
    }
    return null;
  }
  for (let i = 0; i < tradeDays.length; i++) {
    if (tradeDays[i] >= p.day) return tradeDays[i];
  }
  return null;
}

async function runPool(items, worker, concurrency) {
  const queue = items.slice();
  let active = 0;
  return new Promise(function (resolve) {
    const next = function () {
      if (!queue.length && active === 0) return resolve();
      while (active < concurrency && queue.length) {
        const it = queue.shift();
        active++;
        Promise.resolve()
          .then(function () { return worker(it); })
          .catch(function () {})
          .finally(function () { active--; next(); });
      }
    };
    next();
  });
}

async function main() {
  const dbPath = path.resolve(String(arg('db', pushDb.DB_FILE)));
  const concurrency = Math.max(1, Number(arg('concurrency', 8)) || 8);
  pushDb.initDb(dbPath);

  const pending = pushDb.listPendingPerf(dbPath);
  console.log('[push-perf] db=' + dbPath + ' pending=' + pending.length);

  if (!pending.length) {
    console.log('[push-perf] 无待更新记录，结束');
    return;
  }

  let tradeDays;
  try {
    tradeDays = await loadTradeDays();
  } catch (e) {
    console.error('[push-perf] 拉取交易日历失败: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
  console.log('[push-perf] 交易日样本=' + tradeDays.length +
    ' 最近=' + (tradeDays[tradeDays.length - 1] || ''));

  const codes = Array.from(new Set(pending.map(function (r) { return fullCode(r.code); })));
  const barMap = new Map(); // fullCode -> Map day->bar
  let fetchFail = 0;
  await runPool(codes, async function (fc) {
    try {
      const bars = await quotes.dailyBars(fc, 40);
      barMap.set(fc, bars);
    } catch (e) {
      fetchFail++;
    }
  }, concurrency);
  console.log('[push-perf] 日K拉取 codes=' + codes.length + ' ok=' + barMap.size + ' fail=' + fetchFail);

  let updated = 0;
  let skipped = 0;
  for (const row of pending) {
    const fc = fullCode(row.code);
    const code = pureCode(row.code);
    const bars = barMap.get(fc);
    if (!bars || !bars.size) {
      skipped++;
      continue;
    }
    // 个股自己的交易日序列（停牌日可能缺）——用指数日历对齐，缺 bar 则中断后续 Tn
    const t0 = resolveT0Date(Number(row.ctime) || 0, tradeDays);
    if (!t0) {
      skipped++;
      continue;
    }
    const t0Bar = bars.get(t0);
    const t0Close = t0Bar ? barClose(t0Bar) : null;
    if (t0Close == null) {
      skipped++;
      continue;
    }

    const rebuilt = {
      t0_date: t0,
      t0_close: t0Close,
      t1_pct: null,
      t2_pct: null,
      t3_pct: null,
      t4_pct: null,
      t5_pct: null,
      cum5_pct: null,
      realized_days: 0,
      perf_updated_at: new Date().toISOString(),
    };
    const i0 = tradeDays.indexOf(t0);
    let prevClose = t0Close;
    let lastClose = t0Close;
    let nDone = 0;
    for (let n = 1; n <= 5; n++) {
      const di = i0 + n;
      if (di < 0 || di >= tradeDays.length) break;
      const day = tradeDays[di];
      const bar = bars.get(day);
      if (!bar) break; // 停牌：后续不再填
      const close = barClose(bar);
      if (close == null || !prevClose) break;
      let dayPct = barChangePct(bar);
      if (dayPct == null) dayPct = round2(((close / prevClose) - 1) * 100);
      rebuilt['t' + n + '_pct'] = dayPct;
      prevClose = close;
      lastClose = close;
      nDone = n;
    }
    rebuilt.realized_days = nDone;
    if (nDone > 0) rebuilt.cum5_pct = round2(((lastClose / t0Close) - 1) * 100);

    pushDb.updateStockPerf(dbPath, row.article_id, code, rebuilt);
    updated++;
  }

  console.log('[push-perf] 完成 updated=' + updated + ' skipped=' + skipped);
}

main().catch(function (e) {
  console.error('[push-perf] 失败:', e);
  process.exit(1);
});
