'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./collect.js');

const OUT_DIR = path.join(ROOT, 'out');
const Q = String.fromCharCode(34);

const HEADERS = ['新闻发布时间', '涉及股票', '同篇其他股票', '前缀类型', '新闻标题',
  '发布时价格', '发布后5min涨幅', '发布后30min涨幅', '发布后2h涨幅',
  '当天开盘价', '当天收盘价', '当天涨幅', '成交量较前日', '换手率', '交易日',
  '股票代码', '文章链接', '调研结论'];

// 网页表格用的列（把 9 个指标并成两列，便于阅读）
const HTML_HEADERS = ['新闻发布时间', '涉及股票', '前缀类型', '新闻标题', '发布后表现', '当日行情', '换手率', '量较前日', '调研结论'];
// 发布时间列要能放下一整行日期（否则会在“2026-09-12”中间断开），所以在窄屏适配下也有足够宽度
const HTML_COL_WIDTHS = [11, 10, 6, 12, 9, 9, 6, 6, 31];

function pct(v) { return v === null || v === undefined ? '' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function num(v, d) { return v === null || v === undefined ? '' : Number(v).toFixed(d === undefined ? 2 : d); }
function afterText(r) {
  const p = [];
  if (r.m5 !== null && r.m5 !== undefined) p.push('+5m ' + pct(r.m5));
  if (r.m30 !== null && r.m30 !== undefined) p.push('+30m ' + pct(r.m30));
  if (r.m120 !== null && r.m120 !== undefined) p.push('+2h ' + pct(r.m120));
  if (p.length) return p.join('  ');
  return r.refPx === null || r.refPx === undefined ? '—' : '—（已收盘/数据不足）';
}
/**
 * 该股适用的涨跌幅限制：
 *   创业板(sz30) / 科创板(sh688) -> 20%
 *   主板：名称含 ST 且近 20 日最大单日涨跌幅不超过 5.6% -> 5%，其余 10%
 * 名称可能过期（已摘帽但仍显示 *ST），所以用实际行情校验。
 */
function inferLimit(code, name, maxAbs) {
  const c = String(code || '');
  if (/^sz30/.test(c) || /^sh688/.test(c)) return 20;
  if (/ST/i.test(String(name || '')) && maxAbs !== null && maxAbs !== undefined && maxAbs <= 5.6) return 5;
  return 10;
}
/** 涨停 = 收盘价达到该股涨停价，且涨跌幅与该档限额偏离不超过 1.2 个百分点 */
function isLimitUp(r) {
  if (r.close === null || r.close === undefined) return false;
  if (r.prevClose === null || r.prevClose === undefined || !r.prevClose) return false;
  if (r.changePct === null || r.changePct === undefined) return false;
  const nm = String(r.stockName || '');
  if (/^[NC]/.test(nm)) return false; // 新股上市初期无涨跌幅限制
  const lim = inferLimit(r.stockCode, nm, r.maxAbsChange);
  if (Math.abs(r.changePct - lim) > 1.2) return false;
  const target = Math.round(r.prevClose * (1 + lim / 100) * 100) / 100;
  return r.close >= target - 0.005;
}
function dayHtml(r) {
  const p = [];
  if (r.open !== null && r.open !== undefined) p.push('开 ' + num(r.open));
  if (r.close !== null && r.close !== undefined) p.push('收 ' + num(r.close));
  if (r.changePct !== null && r.changePct !== undefined) {
    const txt = '日 ' + pct(r.changePct);
    if (isLimitUp(r)) p.push('<span class="up-limit">' + txt + ' 涨停</span>');
    else if (r.changePct > 5) p.push('<span class="up-strong">' + txt + '</span>');
    else p.push(txt);
  }
  return p.length ? p.join('  ') : '—';
}

// 换手率配色：10~15 绿、15~20 蓝、>20 红
function turnLevel(v) {
  if (v === null || v === undefined) return '';
  if (v > 20) return 'v-red';
  if (v >= 15) return 'v-blue';
  if (v >= 10) return 'v-green';
  return '';
}
// 量较前日配色：20~30 绿、30~40 蓝、>40 红
function volLevel(v) {
  if (v === null || v === undefined) return '';
  if (v > 40) return 'v-red';
  if (v >= 30) return 'v-blue';
  if (v >= 20) return 'v-green';
  return '';
}
function turnText(r) { return r.turnover === null || r.turnover === undefined ? '—' : num(r.turnover) + '%'; }
function volText(r) { return r.volRatioPct === null || r.volRatioPct === undefined ? '—' : pct(r.volRatioPct); }
const TEXT_SOURCE_LABEL = { share: '财联社正文（公开页）', detail: '财联社正文（接口）', brief: '栏目摘要', gated: '需订阅登录（点击标题查看全文）', none: '未取到' };

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return Q + s.split(Q).join(Q + Q).replace(/\r?\n/g, '\n') + Q;
}

function toCsv(rows) {
  const out = [HEADERS.map(csvCell).join(',')];
  for (const r of rows) {
    out.push([r.time, r.stock || r.stocks, r.others || '', r.prefix, r.title,
      r.refPx === null || r.refPx === undefined ? '' : num(r.refPx),
      r.m5, r.m30, r.m120,
      r.open, r.close, r.changePct, r.volRatioPct, r.turnover,
      r.tradeDate || '',
      r.stockCodes.join(' '), r.url, r.researchConclusion || ''].map(csvCell).join(','));
  }
  return '\ufeff' + out.join('\r\n');
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RESEARCH_LABEL_RE = /(题材|估值(?:（截至[^）]+）)?|未来三个月潜力|目前大事|未来三个月|股东动向)：/g;
const RESEARCH_RISK_RE = /(利润同比下滑|营收承压|盈利为负\/PE失真|估值较高|负面公告事项|退市风险)/g;
const RESEARCH_EVENT_RE = /(重大资产重组|重大合同|控制权变更|发行股份|收购|重组|中标|立案|行政处罚|诉讼|股权质押|股份质押|解除限售|限售股|增减持|增持|减持|回购)/g;

function highlightedResearchValue(label, value) {
  const majorLine = label === '目前大事' && RESEARCH_EVENT_RE.test(value) ||
    label === '股东动向' && !/未检索到|待下一轮/.test(value) && RESEARCH_EVENT_RE.test(value);
  RESEARCH_EVENT_RE.lastIndex = 0;
  if (majorLine) return '<span class="research-impact">' + esc(value) + '</span>';
  const re = label === '未来三个月潜力' ? RESEARCH_RISK_RE : label === '未来三个月' ? RESEARCH_EVENT_RE : null;
  if (!re) return esc(value);
  re.lastIndex = 0;
  return String(value).split(re).map(function (part, i) {
    return i % 2 ? '<span class="research-impact">' + esc(part) + '</span>' : esc(part);
  }).join('');
}

function researchHtml(value) {
  const source = String(value || '—').replace(/\r?\n/g, ' ').trim();
  const fields = [];
  RESEARCH_LABEL_RE.lastIndex = 0;
  let match;
  while ((match = RESEARCH_LABEL_RE.exec(source)) !== null) fields.push({ label: match[1], index: match.index, start: RESEARCH_LABEL_RE.lastIndex });
  if (!fields.length) return esc(source);
  return fields.map(function (field, i) {
    const end = i + 1 < fields.length ? fields[i + 1].index : source.length;
    const text = source.slice(field.start, end).replace(/^[\s。]+|[\s。]+$/g, '');
    return '<div class="research-item"><strong class="research-key">' + esc(field.label) + '：</strong><span>' + highlightedResearchValue(field.label, text) + '</span></div>';
  }).join('');
}

const CSS_BASE = "body{font-family:'Microsoft YaHei',system-ui,sans-serif;margin:24px;color:#1c1c1e;background:#fafafa}h1{font-size:20px;margin:0 0 6px}.meta{color:#666;font-size:13px;margin-bottom:16px}.meta a{white-space:nowrap}.hint{color:#888;font-size:12.5px}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;table-layout:fixed}th,td{border:1px solid #e5e5e5;padding:8px 10px;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word}th{background:#f2f3f5;position:sticky;top:0;z-index:2}td.t{white-space:normal;color:#555;font-variant-numeric:tabular-nums}td.txt{line-height:1.6;white-space:pre-wrap}td.src{white-space:nowrap;color:#888;font-size:12px}.pf{display:inline-block;background:#fff1e6;color:#c2410c;border:1px solid #ffd7bd;border-radius:3px;padding:1px 6px;white-space:nowrap}.pl{display:inline-block;background:#eef4fb;color:#1257a8;border:1px solid #cfe0f2;border-radius:3px;padding:1px 6px;white-space:nowrap;font-size:12px;margin:0 3px 2px 0}a{color:#1257a8;text-decoration:none}a:hover{text-decoration:underline}.tw{background:#fff}" ;

// 表格版：手机上仍然是表格，靠横向滚动保证列宽，避免挤压与文字重叠
// 表格版：手机上不生成窄屏布局，而是把页面宽度声明为表格设计宽度（1080），
// 由浏览器整页适配并按原生方式自由缩放（双指/双击），页面内部不再需要横向滚动。
// 下面这段样式只在浏览器忽略该宽度声明时兜底（例如个别旧内核），保证仍可左右查看。
const CSS_MOBILE_TABLE = "@media (max-width:760px){html,body{max-width:100%}body{margin:10px}h1{font-size:16px}.meta{font-size:12px;margin-bottom:10px}.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid #e5e5e5;border-radius:8px}table{width:1080px;min-width:1080px}th,td{font-size:12.5px;padding:6px 8px}th{position:static}td.t{font-size:12px}.research-item{margin-bottom:6px}}";

// 卡片版：窄屏把每行折叠成一张卡片（手机上更好读，作为独立链接保留）
const CSS_MOBILE_CARDS = "@media (max-width:760px){html,body{max-width:100%;overflow-x:hidden}body{margin:10px}h1{font-size:16px}.meta{font-size:12px;margin-bottom:10px}.tw{overflow:visible;border:0;border-radius:0}table,tbody{display:block;width:100%;min-width:0}table{border:0;background:transparent;table-layout:auto}colgroup{display:none}thead{display:none}tbody tr{display:flex;width:100%;min-width:0;flex-direction:column;background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:10px 12px;margin-bottom:10px}tbody td{display:block;width:100%;min-width:0;max-width:100%;border:0;padding:2px 0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}tbody td::before{content:attr(data-label);display:block;color:#888;font-size:11.5px;line-height:1.5}td[data-label=\"新闻标题\"]{order:1;font-size:15px;font-weight:600;padding-bottom:6px}td[data-label=\"新闻标题\"]::before{display:none}td[data-label=\"涉及股票\"]{order:2}td.txt{order:3;padding-top:6px;white-space:pre-wrap}td[data-label=\"新闻发布时间\"]{order:4;padding-top:6px}td[data-label=\"前缀类型\"]{order:5}td.src{order:6}td[data-label=\"所属股票池\"]{order:7}.research-item{margin-bottom:7px}}";

const BAR_CSS = ".bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px}.bar input[type=search]{flex:1 1 240px;min-width:0;font:inherit;font-size:13px;padding:7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e}.bar select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e;max-width:220px}.cnt{color:#888;font-size:12px;white-space:nowrap}@media (max-width:760px){.bar input[type=search]{flex:1 1 100%}.bar select{flex:1 1 40%}}";

const EXTRA_CSS = "td.perf,td.day{font-variant-numeric:tabular-nums;font-size:12.5px;line-height:1.7;color:#3b4149}td.turn,td.vol{font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600}td.research{font-size:12.5px;line-height:1.7;color:#3b4149}.research-item{display:block;margin:0 0 5px}.research-item:last-child{margin-bottom:0}.research-key{font-weight:700;color:#20252b}.research-impact{color:#c62828;font-weight:700}.v-green{color:#0f9d58}.v-blue{color:#1a73e8}.v-red{color:#d93025}.up-strong{color:#d93025;font-weight:600}.up-limit{color:#8b0000;font-weight:700}@media (max-width:760px){td[data-label=\"发布后表现\"]{order:3}td[data-label=\"当日行情\"]{order:4}td[data-label=\"换手率\"]{order:5}td[data-label=\"量较前日\"]{order:6}td[data-label=\"调研结论\"]{order:7;padding-top:7px}td[data-label=\"新闻发布时间\"]{order:8}td[data-label=\"前缀类型\"]{order:9}.research-item{margin-bottom:7px}}";

/**
 * opts.layout: 'table'（默认，任何屏幕都保持表格，窄屏横向滚动）| 'cards'（窄屏折叠成卡片）
 * opts.links: 附加在标题栏的互跳链接，形如 [{href,label}]
 */
function toHtml(rows, meta, opts) {
  opts = opts || {};
  const layout = opts.layout === 'cards' ? 'cards' : 'table';
  const mobileCss = layout === 'cards' ? CSS_MOBILE_CARDS : CSS_MOBILE_TABLE;
  const links = (opts.links || []).map(function (l) {
    return ' <a href=' + Q + esc(l.href) + Q + '>' + esc(l.label) + '</a>';
  }).join('');
  // 表格版把页面宽度声明为表格设计宽度：手机浏览器会整页缩放到屏幕并允许自由缩放（双指/双击），
  // 桌面浏览器会忽略 viewport 声明，因此桌面依旧是满宽表格。
  const viewportContent = layout === 'cards' ? 'width=device-width, initial-scale=1' : 'width=1080';
  const hintHtml = layout === 'cards' ? '' : '<div class=' + Q + 'hint' + Q + ' id=' + Q + 'hint' + Q + ' style=' + Q + 'display:none' + Q + '></div>';
  // 只渲染数据行实际存在的列，避免表头多出两列空列
  const th = HTML_HEADERS.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('');
  const colgroup = '<colgroup>' + HTML_COL_WIDTHS.map(function (w) { return '<col style=' + Q + 'width:' + w + '%' + Q + '>'; }).join('') + '</colgroup>';
  const body = rows.map(function (r) {
    const stockText = esc(r.stock || r.stocks);
    const stockHtml = r.stockCode
      ? '<a href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(r.stockCode) + '.html' + Q +
        ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q +
        ' title=' + Q + '在东方财富查看行情与K线' + Q + '>' + stockText + '</a>'
      : stockText;
    return '<tr data-prefix=' + Q + esc(r.prefix) + Q + '>' +
      '<td class=' + Q + 't' + Q + ' data-label=' + Q + '新闻发布时间' + Q + '>' + esc(r.time) + '</td>' +
      '<td data-label=' + Q + '涉及股票' + Q + '>' + stockHtml + '</td>' +
      '<td data-label=' + Q + '前缀类型' + Q + '><span class=' + Q + 'pf' + Q + '>' + esc(r.prefix) + '</span></td>' +
      '<td data-label=' + Q + '新闻标题' + Q + '><a href=' + Q + esc(r.url) + Q + ' target=' + Q + '_blank' + Q + '>' + esc(r.title) + '</a></td>' +
      '<td class=' + Q + 'perf' + Q + ' data-label=' + Q + '发布后表现' + Q + '>' + esc(afterText(r)) + '</td>' +
      '<td class=' + Q + 'day' + Q + ' data-label=' + Q + '当日行情' + Q + '>' + dayHtml(r) + '</td>' +
      '<td class=' + Q + 'turn ' + turnLevel(r.turnover) + Q + ' data-label=' + Q + '换手率' + Q + '>' + esc(turnText(r)) + '</td>' +
      '<td class=' + Q + 'vol ' + volLevel(r.volRatioPct) + Q + ' data-label=' + Q + '量较前日' + Q + '>' + esc(volText(r)) + '</td>' +
      '<td class=' + Q + 'research' + Q + ' data-label=' + Q + '调研结论' + Q + '>' + researchHtml(r.researchConclusion) + '</td>' +
      '</tr>';
  }).join('\n');
  const toolbar = [
    '<div class=' + Q + 'bar' + Q + '>',
    '<input id=' + Q + 'q' + Q + ' type=' + Q + 'search' + Q + ' placeholder=' + Q + '搜索股票、标题或正文…' + Q + '>',
    '<select id=' + Q + 'pf' + Q + '><option value=' + Q + Q + '>全部栏目</option></select>',
    '<span class=' + Q + 'cnt' + Q + ' id=' + Q + 'cnt' + Q + '></span>',
    '</div>',
  ].join('');
  const script = '<script>' + "(function(){\n  var rows = [].slice.call(document.querySelectorAll('tbody tr'));\n  var q = document.getElementById('q');\n  var pf = document.getElementById('pf');\n  var cnt = document.getElementById('cnt');\n  var hint = document.getElementById('hint');\n  if (hint && screen && screen.width && screen.width <= 760) {\n    hint.textContent = '已按屏幕整页适配：双指缩放或双击可放大查看细节';\n    hint.style.display = 'block';\n  }\n  if (!rows.length || !q || !pf) return;\n  var initialQuery = new URLSearchParams(location.search).get('q');\n  if (initialQuery) q.value = initialQuery;\n  var counts = {};\n  rows.forEach(function(tr){ var p = tr.getAttribute('data-prefix') || ''; counts[p] = (counts[p] || 0) + 1; });\n  Object.keys(counts).sort(function(a,b){ return counts[b] - counts[a]; }).forEach(function(p){\n    var o = document.createElement('option');\n    o.value = p; o.textContent = p + '（' + counts[p] + '）';\n    pf.appendChild(o);\n  });\n  var cache = rows.map(function(tr){ return (tr.textContent || '').toLowerCase(); });\n  function apply(){\n    var kw = q.value.trim().toLowerCase();\n    var p = pf.value;\n    var n = 0;\n    for (var i = 0; i < rows.length; i++) {\n      var ok = (!p || rows[i].getAttribute('data-prefix') === p) && (!kw || cache[i].indexOf(kw) > -1);\n      rows[i].style.display = ok ? '' : 'none';\n      if (ok) n++;\n    }\n    cnt.textContent = '显示 ' + n + ' / ' + rows.length + ' 条';\n  }\n  q.addEventListener('input', apply);\n  pf.addEventListener('change', apply);\n  apply();\n})();" + '<' + '/script>';
  return [
    '<!doctype html>',
    '<html lang=' + Q + 'zh-CN' + Q + '><head><meta charset=' + Q + 'utf-8' + Q + '><meta name=' + Q + 'viewport' + Q + ' content=' + Q + viewportContent + Q + '>',
    '<title>财联社栏目新闻 ' + esc(meta.title || '') + '</title>',
    '<style>' + CSS_BASE + mobileCss + BAR_CSS + EXTRA_CSS + '</style></head><body>',
    '<h1>' + esc(meta.title || '财联社自选股 · 目标栏目新闻') + '</h1>',
    '<div class=' + Q + 'meta' + Q + '>区间 ' + esc(meta.range) + ' ｜ 共 ' + rows.length + ' 条 ｜ 股票池 ' + esc(meta.poolLabel) + ' ｜ 生成于 ' + esc(meta.generatedAt) + links + '</div>',
    hintHtml,
    toolbar,
    '<div class=' + Q + 'tw' + Q + '><table>' + colgroup + '<thead><tr>' + th + '</tr></thead><tbody>',
    body,
    '</tbody></table></div>',
    script,
    '</body></html>',
  ].join('\n');
}

function stamp(d) {
  d = d || new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/**
 * 导出表格。opts.fileBase 决定文件名前缀，例如 "cls-news" 或 "cls-news-sz399006"。
 * 同时写一份 <fileBase>-latest.* 便于固定路径引用，并只保留最近 5 组带时间戳的导出。
 */
function exportAll(rows, meta, opts) {
  opts = opts || {};
  const base = opts.fileBase || 'cls-news';
  if (opts.stamp === false) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const fix = {
      csv: path.join(OUT_DIR, base + '-latest.csv'),
      html: path.join(OUT_DIR, base + '-latest.html'),
      json: path.join(OUT_DIR, base + '-latest.json'),
    };
    fs.writeFileSync(fix.csv, toCsv(rows), 'utf8');
    fs.writeFileSync(fix.html, toHtml(rows, meta, opts), 'utf8');
    fs.writeFileSync(fix.json, JSON.stringify({ meta: meta, rows: rows }, null, 1), 'utf8');
    pruneExports(base, 5);
    return { csvPath: fix.csv, htmlPath: fix.html, jsonPath: fix.json, cardsPath: writeCardsVariant(rows, meta, opts, base) };
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = stamp();
  const csvPath = path.join(OUT_DIR, base + '-' + tag + '.csv');
  const htmlPath = path.join(OUT_DIR, base + '-' + tag + '.html');
  const jsonPath = path.join(OUT_DIR, base + '-' + tag + '.json');
  fs.writeFileSync(csvPath, toCsv(rows), 'utf8');
  fs.writeFileSync(htmlPath, toHtml(rows, meta, opts), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: meta, rows: rows }, null, 1), 'utf8');
  fs.copyFileSync(csvPath, path.join(OUT_DIR, base + '-latest.csv'));
  fs.copyFileSync(htmlPath, path.join(OUT_DIR, base + '-latest.html'));
  fs.copyFileSync(jsonPath, path.join(OUT_DIR, base + '-latest.json'));
  pruneExports(base, 5);
  return { csvPath: csvPath, htmlPath: htmlPath, jsonPath: jsonPath, cardsPath: writeCardsVariant(rows, meta, opts, base) };
}

/**
 * 另存一份「卡片版」页面（窄屏折叠成卡片）。
 * 主页面保持表格形式，卡片版作为独立链接保留同一套数据。
 */
function writeCardsVariant(rows, meta, opts, base) {
  if (!opts.alsoCards) return null;
  const p = path.join(OUT_DIR, base + '-cards.html');
  fs.writeFileSync(p, toHtml(rows, meta, { layout: 'cards', links: opts.cardsLinks || [] }), 'utf8');
  return p;
}

/** 只保留最近 keepSets 组带时间戳的导出，避免定期刷新把 out/ 撑爆。 */
function pruneExports(base, keepSets) {
  if (!fs.existsSync(OUT_DIR)) return;
  const re = new RegExp('^' + base.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&') + '-(\\d{8}-\\d{4})\\.(csv|html|json)$');
  const tags = {};
  for (const f of fs.readdirSync(OUT_DIR)) {
    const m = re.exec(f);
    if (m) tags[m[1]] = true;
  }
  const keep = new Set(Object.keys(tags).sort().slice(-keepSets));
  for (const f of fs.readdirSync(OUT_DIR)) {
    const m = re.exec(f);
    if (m && !keep.has(m[1])) fs.unlinkSync(path.join(OUT_DIR, f));
  }
}

module.exports = { exportAll: exportAll, toCsv: toCsv, toHtml: toHtml, HEADERS: HEADERS, TEXT_SOURCE_LABEL: TEXT_SOURCE_LABEL, OUT_DIR: OUT_DIR };
