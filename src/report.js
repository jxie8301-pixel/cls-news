'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./collect.js');

const OUT_DIR = path.join(ROOT, 'out');
const Q = String.fromCharCode(34);

const HEADERS = ['新闻发布时间', '涉及股票', '前缀类型', '新闻标题', '新闻正文', '正文来源', '所属股票池', '股票代码', '文章链接'];
const TEXT_SOURCE_LABEL = { share: '财联社正文（公开页）', detail: '财联社正文（接口）', brief: '栏目摘要', gated: '需订阅登录（点击标题查看全文）', none: '未取到' };

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return Q + s.split(Q).join(Q + Q).replace(/\r?\n/g, '\n') + Q;
}

function toCsv(rows) {
  const out = [HEADERS.map(csvCell).join(',')];
  for (const r of rows) {
    out.push([r.time, r.stocks, r.prefix, r.title, r.text,
      TEXT_SOURCE_LABEL[r.textSource] || r.textSource,
      (r.poolNames || []).join(' / '), r.stockCodes.join(' '), r.url].map(csvCell).join(','));
  }
  return '\ufeff' + out.join('\r\n');
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CSS = "body{font-family:'Microsoft YaHei',system-ui,sans-serif;margin:24px;color:#1c1c1e;background:#fafafa}h1{font-size:20px;margin:0 0 6px}.meta{color:#666;font-size:13px;margin-bottom:16px}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{border:1px solid #e5e5e5;padding:8px 10px;vertical-align:top;text-align:left}th{background:#f2f3f5;position:sticky;top:0;z-index:2}td.t{white-space:nowrap;color:#555}td.txt{max-width:560px;line-height:1.6;white-space:pre-wrap}td.src{white-space:nowrap;color:#888;font-size:12px}.pf{display:inline-block;background:#fff1e6;color:#c2410c;border:1px solid #ffd7bd;border-radius:3px;padding:1px 6px;white-space:nowrap}.pl{display:inline-block;background:#eef4fb;color:#1257a8;border:1px solid #cfe0f2;border-radius:3px;padding:1px 6px;white-space:nowrap;font-size:12px;margin:0 3px 2px 0}a{color:#1257a8;text-decoration:none}a:hover{text-decoration:underline}";

function toHtml(rows, meta) {
  const th = HEADERS.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('');
  const body = rows.map(function (r) {
    const pools = (r.poolNames || []).map(function (p) { return '<span class=' + Q + 'pl' + Q + '>' + esc(p) + '</span>'; }).join('');
    return '<tr>' +
      '<td class=' + Q + 't' + Q + '>' + esc(r.time) + '</td>' +
      '<td>' + esc(r.stocks) + '</td>' +
      '<td><span class=' + Q + 'pf' + Q + '>' + esc(r.prefix) + '</span></td>' +
      '<td><a href=' + Q + esc(r.url) + Q + ' target=' + Q + '_blank' + Q + '>' + esc(r.title) + '</a></td>' +
      '<td class=' + Q + 'txt' + Q + '>' + esc(r.text) + '</td>' +
      '<td class=' + Q + 'src' + Q + '>' + esc(TEXT_SOURCE_LABEL[r.textSource] || r.textSource) + '</td>' +
      '<td>' + pools + '</td>' +
      '</tr>';
  }).join('\n');
  return [
    '<!doctype html>',
    '<html lang=' + Q + 'zh-CN' + Q + '><head><meta charset=' + Q + 'utf-8' + Q + '>',
    '<title>财联社栏目新闻 ' + esc(meta.title || '') + '</title>',
    '<style>' + CSS + '</style></head><body>',
    '<h1>' + esc(meta.title || '财联社自选股 · 目标栏目新闻') + '</h1>',
    '<div class=' + Q + 'meta' + Q + '>区间 ' + esc(meta.range) + ' ｜ 共 ' + rows.length + ' 条 ｜ 股票池 ' + esc(meta.poolLabel) + ' ｜ 生成于 ' + esc(meta.generatedAt) + '</div>',
    '<table><thead><tr>' + th + '</tr></thead><tbody>',
    body,
    '</tbody></table></body></html>',
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

