'use strict';
/**
 * 行情增强：给「某篇文章 × 某只股票」补上价格表现。
 *
 * 数据来源（均为财联社 x-quote 接口）：
 *   /v2/quote/a/kline?code=<代码>&period=d&limit=N   历史日K（开/收/涨幅/换手率/成交量）
 *   /v2/quote/a/tline_5d?secu_code=<代码>            最近 5 个交易日的逐分钟行情
 *
 * 关键限制：逐分钟数据只有最近 5 个交易日，更早的新闻算不出「发布后 N 分钟涨幅」。
 */
const cls = require('./cls.js');

const dayCache = new Map(); // code -> { at, bars }
const minCache = new Map(); // code -> { at, byDay }
const CACHE_MS = 5 * 60 * 1000;

function fmtDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

/** 拉日K；返回 Map<'YYYYMMDD', bar> */
async function dailyBars(code, limit) {
  const hit = dayCache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bars;
  const body = await cls.xquote('/v2/quote/a/kline', { code: code, period: 'd', limit: limit || 20 });
  const list = (body && body.data) || [];
  const bars = new Map();
  for (const b of list) if (b && b.trade_date) bars.set(String(b.trade_date), b);
  dayCache.set(code, { at: Date.now(), bars: bars });
  return bars;
}

/** 拉最近 5 个交易日分时；返回 Map<'YYYYMMDD', [{minute,last_px}]>（已按交易分钟排序） */
async function minutes5d(code) {
  const hit = minCache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.byDay;
  const body = await cls.xquote('/v2/quote/a/tline_5d', { secu_code: code });
  const line = (body && body.data && body.data.line) || [];
  const byDay = new Map();
  for (const pt of line) {
    const k = String(pt.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push({ minute: pt.minute, px: pt.last_px, preclose: null });
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.minute - b.minute);
  minCache.set(code, { at: Date.now(), byDay: byDay });
  return byDay;
}

function bjParts(sec) {
  const d = new Date(sec * 1000);
  return { day: fmtDay(d), hm: d.getHours() * 100 + d.getMinutes() };
}

function prevDayKey(bars, dayKey) {
  const keys = Array.from(bars.keys()).sort();
  const i = keys.indexOf(dayKey);
  return i > 0 ? keys[i - 1] : null;
}

/**
 * 计算「发布后 N 分钟」。分时数组本身就是交易分钟序列（已跳过午休），
 * 所以 +N 个数组位置 = 之后第 N 个交易分钟。
 */
function afterNews(byDay, publishSec) {
  const p = bjParts(publishSec);
  const days = Array.from(byDay.keys()).sort();
  let dayKey = null;
  let arr = null;
  let idx = -1;

  if (byDay.has(p.day)) {
    const a = byDay.get(p.day);
    const i = a.findIndex(function (x) { return x.minute >= p.hm; });
    if (i >= 0) { dayKey = p.day; arr = a; idx = i; }
  }
  if (idx < 0) {
    // 盘前 / 收盘后 / 非交易日：顺延到下一个有分时数据的交易日开盘
    for (const k of days) {
      if (k > p.day) { dayKey = k; arr = byDay.get(k); idx = 0; break; }
    }
  }
  if (idx < 0 || !arr || !arr.length) return { tradeDate: null, refMinute: null, refPx: null };

  const at = function (n) {
    const j = idx + n;
    return j < arr.length ? arr[j].px : null;
  };
  const refPx = arr[idx].px;
  const pct = function (px) {
    if (px === null || px === undefined || !refPx) return null;
    return Math.round(((px - refPx) / refPx) * 10000) / 100;
  };
  return {
    tradeDate: dayKey,
    refMinute: arr[idx].minute,
    refPx: refPx,
    m5: pct(at(5)),
    m30: pct(at(30)),
    m120: pct(at(120)),
  };
}

/**
 * 给「某只股票 + 某篇文章发布时间」生成全部指标。
 * 返回对象字段全部可为 null（数据不足时）。
 */
async function enrich(code, publishSec) {
  const out = {
    tradeDate: null, refMinute: null, refPx: null,
    m5: null, m30: null, m120: null,
    open: null, close: null, changePct: null,
    volRatioPct: null, turnover: null, prevClose: null, maxAbsChange: null,
  };
  try {
    const byDay = await minutes5d(code);
    const a = afterNews(byDay, publishSec);
    Object.assign(out, { tradeDate: a.tradeDate, refMinute: a.refMinute, refPx: a.refPx, m5: a.m5, m30: a.m30, m120: a.m120 });
  } catch (e) { /* 分时拿不到就留空 */ }
  try {
    const bars = await dailyBars(code, 20);
    const dayKey = out.tradeDate || String(bjParts(publishSec).day);
    const bar = bars.get(dayKey);
    if (bar) {
      out.tradeDate = dayKey;
      out.open = bar.open_px;
      out.close = bar.close_px;
      out.changePct = bar.change;
      out.turnover = bar.tr;
      out.prevClose = bar.preclose_px;
      // 近 20 日最大单日绝对涨跌幅：用来判断该股实际适用哪一档涨跌幅限制
      let maxAbs = null;
      for (const b of bars.values()) {
        const a = Math.abs(b.change || 0);
        if (maxAbs === null || a > maxAbs) maxAbs = a;
      }
      out.maxAbsChange = maxAbs;
      const pk = prevDayKey(bars, dayKey);
      const pb = pk ? bars.get(pk) : null;
      if (pb && pb.business_amount) {
        out.volRatioPct = Math.round(((bar.business_amount - pb.business_amount) / pb.business_amount) * 10000) / 100;
      }
    }
  } catch (e) { /* 日K拿不到就留空 */ }
  return out;
}

function reset() { dayCache.clear(); minCache.clear(); }

async function runPool(items, worker, concurrency) {
  const queue = items.slice();
  let active = 0;
  return new Promise(function (resolve) {
    const next = function () {
      if (!queue.length && active === 0) return resolve();
      while (active < concurrency && queue.length) {
        const it = queue.shift();
        active++;
        Promise.resolve().then(function () { return worker(it); }).catch(function () {}).finally(function () { active--; next(); });
      }
    };
    next();
  });
}

/** 预热：并发拉取这些代码的日K与分时，之后 enrich 直接命中缓存。 */
async function prefetch(codes, concurrency) {
  const uniq = Array.from(new Set(codes));
  await runPool(uniq, async function (code) {
    try { await dailyBars(code, 20); } catch (e) {}
    try { await minutes5d(code); } catch (e) {}
  }, concurrency || 6);
  return uniq.length;
}

module.exports = { enrich, prefetch, dailyBars, minutes5d, afterNews, reset, fmtDay };
