'use strict';

/**
 * 企业微信群机器人推送 —— 零依赖。
 *
 * 用途：把本轮命中目标栏目、且尚未推送过的文章，按板块分组推送到企业微信。
 * 文本格式：
 *   [MM-DD HH:MM]【栏目】标题…（过长截断）
 *
 *   摘要: ...
 *
 *   主板：
 *    五洲新春(603667)-题材（行业+概念，取自 research 调研结论）
 *   创业板：
 *    震裕科技(300953)-题材...
 *
 * 去重：以文章 id 为键，记录在 data/pushed.json；已推送过的不再推送。
 * webhook 地址优先级：环境变量 WECOM_WEBHOOK > config.wecomWebhook。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const collectMod = require('./collect.js');
const research = require('./research.js');

const PUSHED_FILE = path.join(collectMod.DATA_DIR, 'pushed.json');
const RETENTION_DAYS = 60; // 已推送记录保留天数，避免文件无限增长

// 板块显示顺序
const BOARD_ORDER = ['主板', '创业板', '科创板', '北交所', '其他'];

/* --------------------------------------------------------------- 板块判定 */

/** 按股票代码规则判定所属板块。code 形如 sh600000 / sz300750 / bj830799。 */
function boardOf(code) {
  const c = String(code || '').toLowerCase().trim();
  if (c.startsWith('bj')) return '北交所';
  if (c.startsWith('sh')) {
    const n = c.slice(2);
    if (n.startsWith('688') || n.startsWith('689')) return '科创板';
    if (n.startsWith('60')) return '主板';
    return '其他';
  }
  if (c.startsWith('sz')) {
    const n = c.slice(2);
    if (n.startsWith('300') || n.startsWith('301')) return '创业板';
    if (n.startsWith('00')) return '主板';
    if (n.startsWith('8') || n.startsWith('4')) return '北交所';
    return '其他';
  }
  return '其他';
}

/** 去掉市场前缀（sh/sz/bj），只保留 6 位数字代码。 */
function pureCode(code) {
  return String(code || '').replace(/^[a-zA-Z]+/, '');
}

/* ------------------------------------------------------------- 题材取用 */

/** 从 research 缓存取某只股票的「题材」（行业 + 概念，最多 5 个）。取不到返回空串。 */
function themeOf(cache, code) {
  const rec = cache && cache.stocks ? cache.stocks[code] : null;
  if (!rec) return '';
  const items = [rec.industry].concat(rec.concepts || []).filter(Boolean).slice(0, 5);
  return items.join('、');
}

/* ------------------------------------------------------------- 去重记录 */

function loadPushed() {
  try {
    const x = JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf8'));
    return x && x.ids ? x : { updatedAt: null, ids: {} };
  } catch (_) {
    return { updatedAt: null, ids: {} };
  }
}

function savePushed(store) {
  fs.mkdirSync(path.dirname(PUSHED_FILE), { recursive: true });
  // 清理过期记录
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  for (const id of Object.keys(store.ids)) {
    if ((store.ids[id] || 0) < cutoff) delete store.ids[id];
  }
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(PUSHED_FILE, JSON.stringify(store, null, 1), 'utf8');
}

/* ----------------------------------------------------------- 行聚合与格式化 */

/**
 * 把 rows（文章×股票多行）按 articleId 聚合为「一文一条」。
 * 返回 [{ id, ctime, prefix, title, text, url, stocks:[{code,name}] }]
 */
function groupByArticle(rows) {
  const map = new Map();
  for (const r of rows) {
    const aid = r.articleId || r.id;
    if (!aid) continue;
    if (!map.has(aid)) {
      map.set(aid, {
        id: aid,
        ctime: r.ctime || 0,
        prefix: r.prefix || '',
        title: r.title || '',
        text: r.text || '',
        url: r.url || '',
        stocks: [],
      });
    }
    const g = map.get(aid);
    if (r.stockCode && !g.stocks.some(function (s) { return s.code === r.stockCode; })) {
      g.stocks.push({ code: r.stockCode, name: r.stockName || '' });
    }
  }
  return Array.from(map.values()).sort(function (a, b) { return b.ctime - a.ctime; });
}

/** Unix 秒 -> [MM-DD HH:MM]（北京时间；ctime 为绝对时间戳，本地按东八区展示）。 */
function fmtPushTime(sec) {
  const d = new Date(sec * 1000);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return '[' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ']';
}

/** 组装单篇文章的推送文本。cache 用于取题材。 */
function formatArticle(article, cache) {
  let title = article.title || '';
  if (title.length > 50) title = title.slice(0, 50) + '…';

  const lines = [];
  lines.push(fmtPushTime(article.ctime) + title);
  lines.push('');
  const brief = (article.text || '').replace(/\s+/g, ' ').trim();
  lines.push('摘要: ' + brief);
  lines.push('');

  // 按板块分组
  const groups = {};
  for (const s of article.stocks) {
    const b = boardOf(s.code);
    (groups[b] = groups[b] || []).push(s);
  }
  const ordered = BOARD_ORDER.filter(function (b) { return groups[b] && groups[b].length; });
  // BOARD_ORDER 之外的板块兜底
  Object.keys(groups).forEach(function (b) { if (ordered.indexOf(b) < 0) ordered.push(b); });

  for (const board of ordered) {
    lines.push(board + '：');
    for (const s of groups[board]) {
      const code = pureCode(s.code);
      const tag = code ? s.name + '(' + code + ')' : s.name;
      const theme = themeOf(cache, s.code); // 一句话描述：用调研结论的题材填充
      lines.push(' ' + tag + '-' + theme);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

/* --------------------------------------------------------------- 网络发送 */

/** 向企业微信机器人发送 text 消息，返回 Promise<boolean>。 */
function sendWecomText(webhook, content) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(webhook); } catch (_) { resolve(false); return; }
    const body = Buffer.from(JSON.stringify({ msgtype: 'text', text: { content: content } }), 'utf8');
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: 10000,
      },
      function (res) {
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          try {
            const j = JSON.parse(data);
            if (j.errcode && j.errcode !== 0) {
              console.error('  [notify] 推送失败: ' + j.errmsg);
              resolve(false);
              return;
            }
            resolve(true);
          } catch (_) { resolve(false); }
        });
      }
    );
    req.on('error', function (e) { console.error('  [notify] 网络错误: ' + e.message); resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* --------------------------------------------------------------- 主入口 */

/**
 * 推送本轮命中、未推送过的文章。
 * @param {Array} rows      report 用的行（文章×股票展开）
 * @param {Object} opts     { config, dryRun }
 * @returns {Promise<{pushed:number, skipped:number, total:number}>}
 */
async function pushNew(rows, opts) {
  opts = opts || {};
  const cfg = opts.config || {};
  const webhook = process.env.WECOM_WEBHOOK || cfg.wecomWebhook || '';
  const dryRun = !!opts.dryRun;

  if (!webhook && !dryRun) {
    console.log('  [notify] 未配置 WECOM_WEBHOOK，跳过推送');
    return { pushed: 0, skipped: 0, total: 0 };
  }

  const cache = research.loadCache();
  const pushedStore = loadPushed();
  const articles = groupByArticle(rows);

  let pushed = 0;
  let skipped = 0;
  for (const a of articles) {
    if (pushedStore.ids[a.id]) { skipped++; continue; } // 已推送过
    const content = formatArticle(a, cache);

    if (dryRun) {
      console.log('----- [dry-run] 将推送 -----\n' + content);
      pushed++;
      continue;
    }

    const ok = await sendWecomText(webhook, content);
    if (ok) {
      pushedStore.ids[a.id] = a.ctime || Math.floor(Date.now() / 1000);
      pushed++;
      await sleep(500); // 轻微限速，避免触发企业微信频率限制
    }
  }

  if (!dryRun) savePushed(pushedStore);
  console.log('  [notify] 推送完成：新增 ' + pushed + ' 条，跳过（已推送）' + skipped + ' 条，本轮文章 ' + articles.length + ' 篇');
  return { pushed: pushed, skipped: skipped, total: articles.length };
}

module.exports = {
  PUSHED_FILE: PUSHED_FILE,
  boardOf: boardOf,
  pureCode: pureCode,
  themeOf: themeOf,
  groupByArticle: groupByArticle,
  formatArticle: formatArticle,
  loadPushed: loadPushed,
  savePushed: savePushed,
  pushNew: pushNew,
};
