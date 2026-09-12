'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./collect.js');

const OUT_DIR = path.join(ROOT, 'out');
const Q = String.fromCharCode(34);

const HEADERS = ['新闻发布时间', '涉及股票', '同篇其他股票', '前缀类型', '新闻标题', '新闻正文',
  '发布时价格', '发布后5min涨幅', '发布后30min涨幅', '发布后2h涨幅',
  '当天开盘价', '当天收盘价', '当天涨幅', '成交量较前日', '换手率', '交易日',
  '正文来源', '所属股票池', '股票代码', '文章链接'];

// 网页表格用的列（把 9 个指标并成两列，便于阅读）
const HTML_HEADERS = ['新闻发布时间', '涉及股票', '前缀类型', '新闻标题', '发布后表现', '当日行情', '新闻正文', '正文来源', '所属股票池'];

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
function dayText(r) {
  const p = [];
  if (r.open !== null && r.open !== undefined) p.push('开 ' + num(r.open));
  if (r.close !== null && r.close !== undefined) p.push('收 ' + num(r.close));
  if (r.changePct !== null && r.changePct !== undefined) p.push('日 ' + pct(r.changePct));
  if (r.turnover !== null && r.turnover !== undefined) p.push('换手 ' + num(r.turnover) + '%');
  if (r.volRatioPct !== null && r.volRatioPct !== undefined) p.push('量较前日 ' + pct(r.volRatioPct));
  return p.length ? p.join('  ') : '—';
}
const TEXT_SOURCE_LABEL = { share: '财联社正文（公开页）', detail: '财联社正文（接口）', brief: '栏目摘要', gated: '需订阅登录（点击标题查看全文）', none: '未取到' };

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return Q + s.split(Q).join(Q + Q).replace(/\r?\n/g, '\n') + Q;
}

function toCsv(rows) {
  const out = [HEADERS.map(csvCell).join(',')];
  for (const r of rows) {
    out.push([r.time, r.stock || r.stocks, r.others || '', r.prefix, r.title, r.text,
      r.refPx === null || r.refPx === undefined ? '' : num(r.refPx),
      r.m5, r.m30, r.m120,
      r.open, r.close, r.changePct, r.volRatioPct, r.turnover,
      r.tradeDate || '',
      TEXT_SOURCE_LABEL[r.textSource] || r.textSource,
      (r.poolNames || []).join(' / '), r.stockCodes.join(' '), r.url].map(csvCell).join(','));
  }
  return '\ufeff' + out.join('\r\n');
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CSS = "body{font-family:'Microsoft YaHei',system-ui,sans-serif;margin:24px;color:#1c1c1e;background:#fafafa}h1{font-size:20px;margin:0 0 6px}.meta{color:#666;font-size:13px;margin-bottom:16px}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;table-layout:fixed}th,td{border:1px solid #e5e5e5;padding:8px 10px;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word}th{background:#f2f3f5;position:sticky;top:0;z-index:2}td.t{white-space:nowrap;color:#555}td.txt{line-height:1.6;white-space:pre-wrap}td.src{white-space:nowrap;color:#888;font-size:12px}.pf{display:inline-block;background:#fff1e6;color:#c2410c;border:1px solid #ffd7bd;border-radius:3px;padding:1px 6px;white-space:nowrap}.pl{display:inline-block;background:#eef4fb;color:#1257a8;border:1px solid #cfe0f2;border-radius:3px;padding:1px 6px;white-space:nowrap;font-size:12px;margin:0 3px 2px 0}a{color:#1257a8;text-decoration:none}a:hover{text-decoration:underline}@media (max-width:760px){body{margin:10px}h1{font-size:16px}.meta{font-size:12px;margin-bottom:10px}table{border:0;background:transparent;table-layout:auto}thead{display:none}tbody tr{display:flex;flex-direction:column;background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:10px 12px;margin-bottom:10px}tbody td{display:block;border:0;padding:2px 0}tbody td::before{content:attr(data-label);display:block;color:#888;font-size:11.5px;line-height:1.5}td[data-label=\"新闻标题\"]{order:1;font-size:15px;font-weight:600;padding-bottom:6px}td[data-label=\"新闻标题\"]::before{display:none}td[data-label=\"涉及股票\"]{order:2}td.txt{order:3;padding-top:6px;white-space:pre-wrap}td[data-label=\"新闻发布时间\"]{order:4;padding-top:6px;white-space:normal}td[data-label=\"前缀类型\"]{order:5}td.src{order:6;white-space:normal}td[data-label=\"所属股票池\"]{order:7}}" ;

const BAR_CSS = ".bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px}.bar input[type=search]{flex:1 1 240px;min-width:0;font:inherit;font-size:13px;padding:7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e}.bar select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e;max-width:220px}.cnt{color:#888;font-size:12px;white-space:nowrap}@media (max-width:760px){.bar input[type=search]{flex:1 1 100%}.bar select{flex:1 1 40%}}";

const EXTRA_CSS = "td.perf,td.day{font-variant-numeric:tabular-nums;font-size:12.5px;line-height:1.7;color:#3b4149}@media (max-width:760px){td[data-label=\"发布后表现\"]{order:3}td[data-label=\"当日行情\"]{order:4}td.txt{order:5}td[data-label=\"新闻发布时间\"]{order:6}td[data-label=\"前缀类型\"]{order:7}td.src{order:8}td[data-label=\"所属股票池\"]{order:9}}";

function toHtml(rows, meta) {
  // 只渲染数据行实际存在的列，避免表头多出两列空列
  const th = HTML_HEADERS.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('');
  const body = rows.map(function (r) {
    const pools = (r.poolNames || []).map(function (p) { return '<span class=' + Q + 'pl' + Q + '>' + esc(p) + '</span>'; }).join('');
    return '<tr data-prefix=' + Q + esc(r.prefix) + Q + '>' +
      '<td class=' + Q + 't' + Q + ' data-label=' + Q + '新闻发布时间' + Q + '>' + esc(r.time) + '</td>' +
      '<td data-label=' + Q + '涉及股票' + Q + '>' + esc(r.stock || r.stocks) + '</td>' +
      '<td data-label=' + Q + '前缀类型' + Q + '><span class=' + Q + 'pf' + Q + '>' + esc(r.prefix) + '</span></td>' +
      '<td data-label=' + Q + '新闻标题' + Q + '><a href=' + Q + esc(r.url) + Q + ' target=' + Q + '_blank' + Q + '>' + esc(r.title) + '</a></td>' +
      '<td class=' + Q + 'perf' + Q + ' data-label=' + Q + '发布后表现' + Q + '>' + esc(afterText(r)) + '</td>' +
      '<td class=' + Q + 'day' + Q + ' data-label=' + Q + '当日行情' + Q + '>' + esc(dayText(r)) + '</td>' +
      '<td class=' + Q + 'txt' + Q + ' data-label=' + Q + '新闻正文' + Q + '>' + esc(r.text) + '</td>' +
      '<td class=' + Q + 'src' + Q + ' data-label=' + Q + '正文来源' + Q + '>' + esc(TEXT_SOURCE_LABEL[r.textSource] || r.textSource) + '</td>' +
      '<td data-label=' + Q + '所属股票池' + Q + '>' + pools + '</td>' +
      '</tr>';
  }).join('\n');
  const toolbar = [
    '<div class=' + Q + 'bar' + Q + '>',
    '<input id=' + Q + 'q' + Q + ' type=' + Q + 'search' + Q + ' placeholder=' + Q + '搜索股票、标题或正文…' + Q + '>',
    '<select id=' + Q + 'pf' + Q + '><option value=' + Q + Q + '>全部栏目</option></select>',
    '<span class=' + Q + 'cnt' + Q + ' id=' + Q + 'cnt' + Q + '></span>',
    '</div>',
  ].join('');
  const script = '<script>' + "(function(){\n  var rows = [].slice.call(document.querySelectorAll('tbody tr'));\n  var q = document.getElementById('q');\n  var pf = document.getElementById('pf');\n  var cnt = document.getElementById('cnt');\n  if (!rows.length || !q || !pf) return;\n  var counts = {};\n  rows.forEach(function(tr){ var p = tr.getAttribute('data-prefix') || ''; counts[p] = (counts[p] || 0) + 1; });\n  Object.keys(counts).sort(function(a,b){ return counts[b] - counts[a]; }).forEach(function(p){\n    var o = document.createElement('option');\n    o.value = p; o.textContent = p + '（' + counts[p] + '）';\n    pf.appendChild(o);\n  });\n  var cache = rows.map(function(tr){ return (tr.textContent || '').toLowerCase(); });\n  function apply(){\n    var kw = q.value.trim().toLowerCase();\n    var p = pf.value;\n    var n = 0;\n    for (var i = 0; i < rows.length; i++) {\n      var ok = (!p || rows[i].getAttribute('data-prefix') === p) && (!kw || cache[i].indexOf(kw) > -1);\n      rows[i].style.display = ok ? '' : 'none';\n      if (ok) n++;\n    }\n    cnt.textContent = '显示 ' + n + ' / ' + rows.length + ' 条';\n  }\n  q.addEventListener('input', apply);\n  pf.addEventListener('change', apply);\n  apply();\n})();" + '<' + '/script>';
  return [
    '<!doctype html>',
    '<html lang=' + Q + 'zh-CN' + Q + '><head><meta charset=' + Q + 'utf-8' + Q + '>',
    '<title>财联社栏目新闻 ' + esc(meta.title || '') + '</title>',
    '<style>' + CSS + BAR_CSS + EXTRA_CSS + '</style></head><body>',
    '<h1>' + esc(meta.title || '财联社自选股 · 目标栏目新闻') + '</h1>',
    '<div class=' + Q + 'meta' + Q + '>区间 ' + esc(meta.range) + ' ｜ 共 ' + rows.length + ' 条 ｜ 股票池 ' + esc(meta.poolLabel) + ' ｜ 生成于 ' + esc(meta.generatedAt) + '</div>',
    toolbar,
    '<table><thead><tr>' + th + '</tr></thead><tbody>',
    body,
    '</tbody></table>',
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
    fs.writeFileSync(fix.html, toHtml(rows, meta), 'utf8');
    fs.writeFileSync(fix.json, JSON.stringify({ meta: meta, rows: rows }, null, 1), 'utf8');
    pruneExports(base, 5);
    return { csvPath: fix.csv, htmlPath: fix.html, jsonPath: fix.json };
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = stamp();
  const csvPath = path.join(OUT_DIR, base + '-' + tag + '.csv');
  const htmlPath = path.join(OUT_DIR, base + '-' + tag + '.html');
  const jsonPath = path.join(OUT_DIR, base + '-' + tag + '.json');
  fs.writeFileSync(csvPath, toCsv(rows), 'utf8');
  fs.writeFileSync(htmlPath, toHtml(rows, meta), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: meta, rows: rows }, null, 1), 'utf8');
  fs.copyFileSync(csvPath, path.join(OUT_DIR, base + '-latest.csv'));
  fs.copyFileSync(htmlPath, path.join(OUT_DIR, base + '-latest.html'));
  fs.copyFileSync(jsonPath, path.join(OUT_DIR, base + '-latest.json'));
  pruneExports(base, 5);
  return { csvPath: csvPath, htmlPath: htmlPath, jsonPath: jsonPath };
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
