'use strict';

/**
 * 批量个股研究摘要。
 *
 * 数据源：
 *   1) 财联社个股基础行情 /quote/stock/basic：PE/PB、价格、近 3 月走势
 *   2) 财联社公司资料静态 JSON：行业、概念、财务摘要
 *   3) 财联社公告 /quote/index/ann：重大事项、增持/减持动态
 *
 * 研究结果按股票缓存到 data/research.json。云端会继承上一轮 Pages 快照中的
 * 缓存，因此默认每 24 小时更新一次，而不是每 30 分钟重复请求数百家公司。
 */
const fs = require('node:fs');
const path = require('node:path');
const cls = require('./cls.js');
const collectMod = require('./collect.js');

const CACHE_FILE = path.join(collectMod.DATA_DIR, 'research.json');
const COMPANY_INFO_PREFIX = '/729c64f1fd5f64035b9b189c90432560/quote/company_info/';
const COMPANY_PREFIX_RE = /\/[a-f0-9]{32}\/quote\/company_info\//i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

let discoveredCompanyPrefix = COMPANY_INFO_PREFIX;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadCache() {
  const x = readJson(CACHE_FILE);
  const cache = x && x.stocks ? x : { version: 1, updatedAt: null, stocks: {} };
  // 早期缓存把接口 null 经 Number(null) 写成了 0；估值倍数为 0 没有分析意义。
  for (const r of Object.values(cache.stocks)) {
    if (!r || !r.valuation) continue;
    if (r.valuation.ttmPe === 0) r.valuation.ttmPe = null;
    if (r.valuation.dynamicPe === 0) r.valuation.dynamicPe = null;
    if (r.valuation.pb === 0) r.valuation.pb = null;
  }
  return cache;
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1), 'utf8');
}

function hourStamp(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours());
}

async function fetchJson(url, retries) {
  let last;
  for (let i = 0; i <= (retries || 2); i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 20000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Referer: 'https://www.cls.cn/' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < (retries || 2)) await cls.sleep(350 * (i + 1));
    }
  }
  throw last;
}

async function discoverCompanyPrefix(code) {
  try {
    const res = await fetch('https://www.cls.cn/stock?code=' + encodeURIComponent(code), {
      headers: { 'User-Agent': UA, Referer: 'https://www.cls.cn/' },
    });
    const html = await res.text();
    const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+stock-[^"]+\.js)"/g), function (m) { return m[1]; });
    for (const src of scripts) {
      const js = await (await fetch(src, { headers: { 'User-Agent': UA } })).text();
      const m = COMPANY_PREFIX_RE.exec(js);
      if (m) return m[0];
    }
  } catch (_) { /* 保留内置路径 */ }
  return COMPANY_INFO_PREFIX;
}

async function fetchCompanyInfo(code) {
  const makeUrl = function (prefix) {
    return 'https://www.cls.cn' + prefix + encodeURIComponent(code) + '.json?time=' + hourStamp(new Date());
  };
  try {
    return await fetchJson(makeUrl(discoveredCompanyPrefix), 1);
  } catch (first) {
    discoveredCompanyPrefix = await discoverCompanyPrefix(code);
    return fetchJson(makeUrl(discoveredCompanyPrefix), 2);
  }
}

function n(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function parsePct(v) {
  if (v === null || v === undefined) return null;
  const m = /-?[\d.]+/.exec(String(v));
  return m ? n(m[0]) : null;
}

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const p = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(Number(v) * p) / p;
}

function cleanList(v, limit) {
  return String(v || '')
    .split(/[，,、]/)
    .map(function (x) { return x.trim(); })
    .filter(Boolean)
    .slice(0, limit || 4);
}

const EVENT_RE = /增持|减持|回购|业绩预告|业绩快报|季度报告|半年度报告|年度报告|中标|合同|订单|定增|非公开发行|发行股份|并购|重组|收购|诉讼|处罚|立案|风险提示|异常波动|解除限售|限售股|股权激励|分红|权益分派|控制权|停牌|复牌/;
const POS_RE = /增持|回购|预增|扭亏|增长|中标|签订.{0,8}合同|重大合同|获批|股权激励/;
const NEG_RE = /减持|预亏|亏损|下降|下滑|立案|处罚|诉讼|终止|退市|风险提示/;

function shortTitle(title, name, max) {
  let s = String(title || '').replace(/\s+/g, ' ').trim();
  if (name) s = s.replace(new RegExp('^' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');
  s = s.replace(/^.{2,32}?(?:股份有限公司|集团有限公司|有限公司)/, '');
  s = s.replace(/^关于/, '').replace(/的(?:自愿性披露)?公告$/, '').trim();
  const m = max || 42;
  return s.length > m ? s.slice(0, m - 1) + '…' : s;
}

function recentAnnouncements(list, nowSec) {
  return (Array.isArray(list) ? list : [])
    .filter(function (x) { return x && x.timestamp && nowSec - x.timestamp <= 190 * 86400; })
    .map(function (x) { return { time: x.time, timestamp: x.timestamp, title: x.title || '', url: x.url || '' }; });
}

function pickKeyEvents(anns) {
  return anns.filter(function (x) { return EVENT_RE.test(x.title); }).slice(0, 3);
}

function holdingText(record) {
  const list = (record.announcements || []).filter(function (x) { return /增持|减持/.test(x.title); });
  if (!list.length) return '近半年未检索到增/减持公告';
  const x = list[0];
  let action = /增持/.test(x.title) ? '增持' : '减持';
  if (/未减持|未实施.{0,8}减持|提前终止.{0,8}减持|减持计划.{0,8}终止/.test(x.title)) action = '减持计划未实施/终止';
  else if (/不减持|无减持计划|承诺.{0,6}不减持/.test(x.title)) action = '不减持承诺';
  return action + '：' + String(x.time || '').slice(0, 10) + ' ' + shortTitle(x.title, record.name, 34);
}

function valuationText(record) {
  const v = record.valuation || {};
  const parts = [];
  if (v.ttmPe !== null && v.ttmPe !== undefined && v.ttmPe > 0) parts.push('PE(TTM) ' + v.ttmPe.toFixed(1) + '倍');
  else parts.push('PE不适用/暂无');
  if (v.pb !== null && v.pb !== undefined && v.pb > 0) parts.push('PB ' + v.pb.toFixed(2) + '倍');
  if (v.marketCapYi !== null && v.marketCapYi !== undefined) parts.push('市值约' + v.marketCapYi.toFixed(0) + '亿元');
  return parts.join('、');
}

function scorePotential(record) {
  let score = 50;
  const f = record.financial || {};
  const v = record.valuation || {};
  const m = record.momentum || {};
  if (f.profitYoy !== null) score += f.profitYoy >= 30 ? 12 : f.profitYoy >= 0 ? 5 : f.profitYoy <= -30 ? -12 : -6;
  if (f.revenueYoy !== null) score += f.revenueYoy >= 15 ? 7 : f.revenueYoy >= 0 ? 3 : f.revenueYoy <= -15 ? -7 : -3;
  if (f.roe !== null) score += f.roe >= 12 ? 7 : f.roe >= 6 ? 3 : f.roe < 2 ? -5 : 0;
  if (f.debtRatio !== null && f.debtRatio > 70) score -= 6;
  if (v.ttmPe !== null) {
    if (v.ttmPe <= 0) score -= 8;
    else if (v.ttmPe <= 20) score += 7;
    else if (v.ttmPe <= 40) score += 3;
    else if (v.ttmPe > 100) score -= 8;
    else if (v.ttmPe > 60) score -= 5;
  }
  if (v.pb !== null) score += v.pb <= 2 ? 3 : v.pb > 8 ? -5 : v.pb > 5 ? -3 : 0;
  if (m.change3m !== null) score += m.change3m >= 25 ? 7 : m.change3m >= 0 ? 3 : m.change3m <= -25 ? -8 : -3;
  const signal = (record.keyEvents || []).find(function (x) { return POS_RE.test(x.title) || NEG_RE.test(x.title); });
  if (signal && POS_RE.test(signal.title) && !/质押式回购/.test(signal.title)) score += 5;
  if (signal && NEG_RE.test(signal.title)) score -= 7;
  const hold = holdingText(record);
  if (/^增持/.test(hold)) score += 4;
  if (/^减持/.test(hold)) score -= 5;
  score = Math.max(15, Math.min(85, Math.round(score)));
  const level = score >= 68 ? '较高' : score >= 58 ? '中等偏高' : score >= 45 ? '中等' : score >= 35 ? '偏低' : '较低';
  return { score: score, level: level };
}

function nextReportEvent(now) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m <= 4 && !(m === 4 && d > 30)) return '预计4月底前披露年报/一季报';
  if (m <= 8 && !(m === 8 && d > 31)) return '预计8月底前披露半年报';
  if (m <= 10 && !(m === 10 && d > 31)) return '预计10月底前披露三季报';
  return '未来三个月关注年度经营数据及业绩预告（如触发披露条件）';
}

function followUpFor(events) {
  const t = (events || []).map(function (x) { return x.title; }).join(' ');
  if (/重组|定增|发行股份|收购/.test(t)) return '并购/融资审批与实施进度';
  if (/中标|合同|订单/.test(t)) return '订单执行与收入确认';
  if (/质押式回购|股份质押|股权质押/.test(t)) return '股权质押及偿付风险';
  if (/回购|增持|减持/.test(t)) return '增减持/回购计划实施进度';
  if (/解除限售|限售股/.test(t)) return '限售股流通后的供给压力';
  if (/立案|处罚|诉讼/.test(t)) return '监管或诉讼进展';
  return '业绩兑现与行业景气变化';
}

function riskText(record) {
  const f = record.financial || {};
  const v = record.valuation || {};
  const risks = [];
  if (f.profitYoy !== null && f.profitYoy < 0) risks.push('利润同比下滑');
  if (f.revenueYoy !== null && f.revenueYoy < 0) risks.push('营收承压');
  if (v.ttmPe !== null && v.ttmPe > 60) risks.push('估值较高');
  if (v.ttmPe !== null && v.ttmPe <= 0) risks.push('盈利为负/PE失真');
  if ((record.keyEvents || []).some(function (x) { return NEG_RE.test(x.title); })) risks.push('负面公告事项');
  return risks.slice(0, 2).join('、') || '主要看业绩与催化兑现';
}

function latestNewsText(rows) {
  if (!rows || !rows.length) return '';
  const x = rows.slice().sort(function (a, b) { return b.ctime - a.ctime; })[0];
  return shortTitle(String(x.title || '').replace(/^\s*[【\[][^】\]]+[】\]]\s*/, ''), x.stockName, 38);
}

function displayEvent(record) {
  const list = record.keyEvents || [];
  return list.find(function (x) { return !/股票交易异常波动/.test(x.title); }) || list[0] || null;
}

function conclusionFor(record, rows) {
  if (!record || record.errorOnly) {
    return [
      '题材：数据暂未取到',
      '估值：数据暂未取到',
      '未来三个月潜力：暂无法可靠评估，当前关注表内新闻催化及后续定期报告',
      '目前大事：待下一轮数据恢复后补充',
      '未来三个月：关注后续定期报告与新闻催化',
      '股东动向：待下一轮数据恢复后补充',
    ].join('\n');
  }
  const themes = [record.industry].concat(record.concepts || []).filter(Boolean).slice(0, 5).join('、') || '资料暂缺';
  const p = scorePotential(record);
  const ev = displayEvent(record);
  const current = ev ? String(ev.time || '').slice(5, 10) + ' ' + shortTitle(ev.title, record.name, 42) : '近半年未检索到重大事项类公告';
  const news = latestNewsText(rows);
  const future = nextReportEvent(new Date()) + '，并关注' + followUpFor(record.keyEvents);
  return [
    '题材：' + themes,
    '估值（截至' + (record.asOfDate || String(record.researchedAt || '').slice(0, 10)) + '抓取的最近收盘）：' + valuationText(record),
    '未来三个月潜力：' + p.level + '（模型' + p.score + '/100），' + (news ? '近期催化为“' + news + '”，' : '') + '主要风险为' + riskText(record),
    '目前大事：' + current,
    '未来三个月：' + future,
    '股东动向：' + holdingText(record),
  ].join('\n');
}

async function researchOne(stock) {
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.allSettled([
    cls.xquote('/quote/stock/basic', { secu_code: stock.code }),
    fetchCompanyInfo(stock.code),
    cls.xquote('/quote/index/ann', { secu_code: stock.code, page: 1 }),
  ]);
  const basic = results[0].status === 'fulfilled' && results[0].value ? (results[0].value.data || {}) : {};
  const company = results[1].status === 'fulfilled' && results[1].value ? results[1].value : {};
  const annBody = results[2].status === 'fulfilled' && results[2].value ? results[2].value : {};
  if (!Object.keys(basic).length && !Object.keys(company).length && !Array.isArray(annBody.data)) {
    throw new Error(results.map(function (x) { return x.status === 'rejected' ? String(x.reason && x.reason.message || x.reason) : ''; }).filter(Boolean).join('; ') || 'all sources failed');
  }
  const bi = company.basic_info || {};
  const fi = company.financial_analysis || {};
  const anns = recentAnnouncements(annBody.data, now);
  return {
    code: stock.code,
    name: stock.name || basic.secu_name || bi.SecuAbbr || '',
    researchedAt: new Date().toISOString(),
    asOfDate: cls.fmtTime(now).slice(0, 10),
    industry: bi.IndustryName || '',
    concepts: cleanList(bi.plate_names, 5),
    valuation: {
      ttmPe: round(n(basic.ttm_pe), 2),
      dynamicPe: round(n(basic.dynamic_pe), 2),
      pb: round(n(basic.pb), 3),
      marketCapYi: basic.mc === null || basic.mc === undefined ? null : round(Number(basic.mc) / 1e8, 2),
      lastPrice: round(n(basic.last_px), 3),
    },
    momentum: {
      change3m: basic.change_3 === null || basic.change_3 === undefined ? null : round(Number(basic.change_3) * 100, 2),
      change5d: basic.change_5 === null || basic.change_5 === undefined ? null : round(Number(basic.change_5) * 100, 2),
    },
    financial: {
      revenueYoy: parsePct(fi.yoy_revenue),
      profitYoy: parsePct(fi.yoy_net_profit),
      roe: parsePct(fi.roe),
      debtRatio: parsePct(fi.debt_ratio),
    },
    announcements: anns.filter(function (x) { return EVENT_RE.test(x.title) || /增持|减持/.test(x.title); }).slice(0, 10),
    keyEvents: pickKeyEvents(anns),
    sources: {
      quote: 'https://www.cls.cn/stock?code=' + stock.code,
      announcements: 'https://www.cls.cn/stock?code=' + stock.code + '&tab=notice',
    },
  };
}

function isFresh(record, hours) {
  if (!record || !record.researchedAt) return false;
  return Date.now() - new Date(record.researchedAt).getTime() < hours * 3600000;
}

function attachRows(rows, cache) {
  const c = cache || loadCache();
  const grouped = {};
  for (const r of rows) {
    if (!r.stockCode) continue;
    if (!grouped[r.stockCode]) grouped[r.stockCode] = [];
    grouped[r.stockCode].push(r);
  }
  for (const r of rows) {
    const rec = c.stocks[r.stockCode];
    r.researchConclusion = conclusionFor(rec, grouped[r.stockCode] || []);
    r.researchAt = rec && rec.researchedAt || null;
  }
  return rows;
}

async function enrichRows(rows, opts) {
  opts = opts || {};
  const config = opts.config || {};
  if (config.research && config.research.enabled === false) return attachRows(rows);
  const hours = Number(config.research && config.research.refreshHours || 24);
  const concurrency = Number(config.research && config.research.concurrency || 5);
  const cache = loadCache();
  const targets = new Map();
  for (const r of rows) if (r.stockCode && !targets.has(r.stockCode)) targets.set(r.stockCode, { code: r.stockCode, name: r.stockName || '' });
  const stale = Array.from(targets.values()).filter(function (s) { return !isFresh(cache.stocks[s.code], hours); });
  let done = 0;
  let errors = 0;
  await collectMod.runPool(stale, async function (stock) {
    try {
      cache.stocks[stock.code] = await researchOne(stock);
    } catch (e) {
      errors++;
      if (!cache.stocks[stock.code]) cache.stocks[stock.code] = { code: stock.code, name: stock.name, researchedAt: new Date().toISOString(), errorOnly: true, error: String(e && e.message || e) };
    }
    done++;
    if (opts.onProgress) opts.onProgress({ done: done, total: stale.length, errors: errors, cached: targets.size - stale.length }, stock);
    if (done % 25 === 0) saveCache(cache);
  }, Math.max(1, concurrency));
  saveCache(cache);
  attachRows(rows, cache);
  return { rows: rows, total: targets.size, refreshed: stale.length, cached: targets.size - stale.length, errors: errors };
}

module.exports = {
  CACHE_FILE: CACHE_FILE,
  loadCache: loadCache,
  saveCache: saveCache,
  fetchCompanyInfo: fetchCompanyInfo,
  researchOne: researchOne,
  conclusionFor: conclusionFor,
  attachRows: attachRows,
  enrichRows: enrichRows,
  scorePotential: scorePotential,
};
