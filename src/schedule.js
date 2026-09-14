'use strict';
/**
 * 刷新节奏策略（云端定时任务与本地程序共用同一套判断）。
 *
 *   非交易日                -> 每 6 小时刷新一次
 *   交易日 07:00-16:00      -> 每 10 分钟刷新一次
 *   交易日 其他时段          -> 每 2 小时刷新一次
 *
 * 交易日怎么判断：
 *   1. 周六/周日直接算非交易日（不联网）；
 *   2. 周一至周五用行情数据核对：取上证指数最近几根日K，如果最新一根的交易日就是今天，说明今天有交易；
 *      A 股节假日（如国庆、春节调休）在这条规则下会自动归为非交易日，不需要维护假期表；
 *   3. 09:45 之前当天日K可能还没生成，此时无法判断，按“交易日”处理——宁可多刷，不可漏刷。
 *
 * 什么时候真正刷新：
 *   盘中每 10 分钟这一档由定时触发本身决定（cronDriven）：全市场抓取一次要 4 分钟左右，
 *   若再按“距上次多久”判断，会被自己的抓取耗时误判成“还没到时间”而白白跳过一轮，
 *   所以盘中只要触发就刷新，节奏＝触发节奏。
 *   2 小时 / 6 小时这两档则以“上一次发布时间”为基准，达到要求时长才刷新，
 *   这样即使平台延后触发或某一轮被跳过，下一轮也能立刻补上，不会长时间不更新。
 */

const quotes = require('./quotes.js');

const TZ_OFFSET_MINUTES = 8 * 60; // 上海时间 = UTC+8
const PROBE_CODE = 'sh000001'; // 上证指数，用于核对“今天有没有交易”
const PROBE_READY_HOUR = 9; // 09:45 之后才认为当日日K可信
const PROBE_READY_MINUTE = 45;
const GRACE_MINUTES = 10; // 抓取耗时 + 平台调度延迟的余量

const INTERVAL_MINUTES = {
  tradingWindow: 10, // 交易日 07:00-16:00
  tradingOffHours: 120, // 交易日其他时段
  closed: 360, // 非交易日
};

const STATUS_URL_DEFAULT = 'https://jxie8301-pixel.github.io/cls-news/status.json';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 把时间戳换算成上海时间的各个字段（不依赖运行机器的时区）。 */
function shanghaiParts(epochMs) {
  const t = epochMs === undefined || epochMs === null ? Date.now() : Number(epochMs);
  const d = new Date(t + TZ_OFFSET_MINUTES * 60000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    epochMs: t,
    dateKey: String(y) + pad(m) + pad(day),
    year: y,
    month: m,
    day: day,
    hour: hour,
    minute: minute,
    weekday: d.getUTCDay(), // 0=周日
    text: y + '-' + pad(m) + '-' + pad(day) + ' ' + pad(hour) + ':' + pad(minute) + '（上海时间）',
  };
}

function isWeekend(parts) {
  return parts.weekday === 0 || parts.weekday === 6;
}

/** 09:45 之后才能用当日日K判断是否有交易。 */
function probeReady(parts) {
  return parts.hour * 60 + parts.minute >= PROBE_READY_HOUR * 60 + PROBE_READY_MINUTE;
}

/**
 * 判断今天是不是交易日。周一至周五且已过 09:45 时用上证指数日K核对。
 * 探测失败一律按交易日处理，避免漏刷。
 */
async function detectTradingDay(parts) {
  if (isWeekend(parts)) return { isTradingDay: false, how: '周末' };
  if (!probeReady(parts)) return { isTradingDay: true, how: '交易日早盘（未到 09:45，按交易日处理）' };
  try {
    const bars = await quotes.dailyBars(PROBE_CODE, 5);
    const keys = Array.from(bars.keys()).sort();
    const latest = keys.length ? keys[keys.length - 1] : null;
    if (!latest) return { isTradingDay: true, how: '行情未取到，按交易日处理' };
    const isTradingDay = latest === parts.dateKey;
    return { isTradingDay: isTradingDay, how: isTradingDay ? '今日已有行情（' + latest + '）' : '今日无行情，最新交易日 ' + latest };
  } catch (e) {
    return { isTradingDay: true, how: '行情探测失败（' + String((e && e.message) || e) + '），按交易日处理' };
  }
}

/** 该时段的刷新间隔与说明。 */
function policyFor(parts, isTradingDay) {
  if (!isTradingDay) {
    return { intervalMinutes: INTERVAL_MINUTES.closed, label: '非交易日（每 6 小时）' };
  }
  if (parts.hour >= 7 && parts.hour < 16) {
    return { intervalMinutes: INTERVAL_MINUTES.tradingWindow, cronDriven: true, label: '交易时段 07:00-16:00（每 ' + INTERVAL_MINUTES.tradingWindow + ' 分钟）' };
  }
  return { intervalMinutes: INTERVAL_MINUTES.tradingOffHours, label: '交易日非交易时段（每 2 小时）' };
}

/** 读取线上已发布页面的发布时刻（作为“上次刷新时间”的基准）。 */
async function fetchLastPublishedAt(url) {
  const target = url || STATUS_URL_DEFAULT;
  try {
    const res = await fetch(target + (target.indexOf('?') === -1 ? '?t=' + Date.now() : ''), { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    const at = Number(body && body.publishedAt);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch (e) {
    return null;
  }
}

/**
 * 综合判断这一轮要不要抓取。
 * opts: { now, isTradingDay, lastPublishedAt, statusUrl }
 */
async function decide(opts) {
  opts = opts || {};
  const parts = shanghaiParts(opts.now);
  let trading = { isTradingDay: null, how: '' };
  if (opts.isTradingDay === true || opts.isTradingDay === false) {
    trading = { isTradingDay: opts.isTradingDay, how: '调用方指定' };
  } else {
    trading = await detectTradingDay(parts);
  }
  const policy = policyFor(parts, trading.isTradingDay);
  const last = opts.lastPublishedAt === undefined ? await fetchLastPublishedAt(opts.statusUrl) : opts.lastPublishedAt;
  // 盘中档由触发驱动，不设等待门槛；其余档位留出抓取耗时与调度延迟的余量
  const thresholdMinutes = policy.cronDriven ? policy.intervalMinutes : Math.max(1, policy.intervalMinutes - GRACE_MINUTES);
  const ageMinutes = last ? Math.floor((parts.epochMs - last) / 60000) : null;
  const remainingMs = last === null || last === undefined ? 0 : Math.max(0, thresholdMinutes * 60000 - (parts.epochMs - last));
  const run = policy.cronDriven === true || last === null || last === undefined || remainingMs === 0;
  return {
    run: run,
    cronDriven: policy.cronDriven === true,
    parts: parts,
    isTradingDay: trading.isTradingDay,
    tradingReason: trading.how,
    policy: policy,
    intervalMinutes: policy.intervalMinutes,
    thresholdMinutes: thresholdMinutes,
    lastPublishedAt: last === undefined ? null : last,
    ageMinutes: ageMinutes,
    remainingMs: remainingMs,
    label: policy.label,
  };
}

function describe(result) {
  const lines = [];
  lines.push('时间 ' + result.parts.text + ' ｜ ' + result.label);
  lines.push('交易日判定 ' + (result.isTradingDay ? '是' : '否') + '（' + result.tradingReason + '）');
  if (result.cronDriven) {
    lines.push('刷新方式 每次定时触发都执行（目标间隔 ' + result.intervalMinutes + ' 分钟）');
  } else {
    lines.push('要求间隔 ' + result.intervalMinutes + ' 分钟（含 ' + (result.intervalMinutes - result.thresholdMinutes) + ' 分钟余量，实际达到 ' + result.thresholdMinutes + ' 分钟即刷新）');
  }
  if (result.lastPublishedAt) {
    const d = new Date(result.lastPublishedAt);
    lines.push('上次发布 ' + d.toISOString() + '（距今 ' + result.ageMinutes + ' 分钟）');
  } else {
    lines.push('上次发布 未知（视为需要刷新）');
  }
  lines.push('结论 ' + (result.run ? '本轮执行抓取' : '本轮跳过，约 ' + Math.ceil(result.remainingMs / 60000) + ' 分钟后到期'));
  return lines.join('\n');
}

module.exports = {
  shanghaiParts: shanghaiParts,
  detectTradingDay: detectTradingDay,
  policyFor: policyFor,
  fetchLastPublishedAt: fetchLastPublishedAt,
  decide: decide,
  describe: describe,
  INTERVAL_MINUTES: INTERVAL_MINUTES,
  GRACE_MINUTES: GRACE_MINUTES,
  PROBE_CODE: PROBE_CODE,
  STATUS_URL_DEFAULT: STATUS_URL_DEFAULT,
};

/* ------------------------------------------------------------ 命令行 */

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** 支持 none / ISO 时间 / -45m / -3h / -2d 这类相对写法，方便本地验证；相对值以 base 为基准。 */
function parseMoment(raw, base) {
  if (raw === undefined) return undefined;
  if (raw === 'none') return null;
  if (typeof raw !== 'string') return undefined;
  const rel = /^-([0-9]+)([mhd])$/.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] === 'm' ? 60000 : rel[2] === 'h' ? 3600000 : 86400000;
    return (base === undefined ? Date.now() : base) - n * unit;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

async function cli() {
  const at = parseMoment(arg('at'));
  const base = at === undefined ? undefined : at;
  const td = arg('trading-day');
  const result = await decide({
    now: at === undefined ? undefined : at,
    isTradingDay: td === 'yes' ? true : td === 'no' ? false : undefined,
    lastPublishedAt: parseMoment(arg('last-published'), base),
    statusUrl: typeof arg('status-url') === 'string' ? arg('status-url') : undefined,
  });
  console.log(describe(result));
  process.exit(result.run ? 0 : 3);
}

if (require.main === module) {
  cli().catch(function (e) {
    // 出错时按“需要刷新”退出，避免因为脚本异常而整天不更新
    console.error('调度判断失败（按需要刷新处理）: ' + String((e && e.message) || e));
    process.exit(0);
  });
}
