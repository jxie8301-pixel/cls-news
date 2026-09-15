'use strict';

/**
 * 企业微信群机器人推送 —— 零依赖（dashboard / GitHub Actions）。
 *
 * 流程：
 *   1. 个股扫描得到文章×股票 rows，按 articleId 聚合成一文一条
 *   2. 用 VIP 列表中同 id 的 title / brief 覆盖推送标题与摘要（个股侧标题摘要不准）
 *   3. 调用 MiniMax 为每只标的生成一句话（主业+特点+与新闻匹配点）；失败则回退 research 题材
 *   4. 按板块分组推送到企业微信
 *
 * 文本格式示例：
 *   [09-15 10:51]【盘中宝】覆铜板介电性能与耐热可靠性的核心骨架…
 *
 *   摘要:
 *
 *   主板：
 *    东材科技(601208)-一句话描述
 *    圣泉集团(605589)-一句话描述
 *
 * 去重：data/pushed.json（文章 id）
 * webhook：环境变量 WECOM_WEBHOOK > config.wecomWebhook
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const collectMod = require('./collect.js');
const research = require('./research.js');
const cls = require('./cls.js');
const minimax = require('./minimax.js');

const PUSHED_FILE = path.join(collectMod.DATA_DIR, 'pushed.json');
const RETENTION_DAYS = 60;

const BOARD_ORDER = ['主板', '创业板', '科创板', '北交所', '其他'];

/* --------------------------------------------------------------- 板块判定 */

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

function pureCode(code) {
  return String(code || '').replace(/^[a-zA-Z]+/, '');
}

/* ------------------------------------------------------------- 题材取用 */

/** research 题材串（MiniMax 失败时的回退描述）。 */
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
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  for (const id of Object.keys(store.ids)) {
    if ((store.ids[id] || 0) < cutoff) delete store.ids[id];
  }
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(PUSHED_FILE, JSON.stringify(store, null, 1), 'utf8');
}

/* ----------------------------------------------------------- 行聚合与 VIP */

/**
 * rows → 一文一条。
 * 返回 [{ id, ctime, prefix, title, text, url, stocks:[{code,name}] }]
 */
function groupByArticle(rows) {
  const map = new Map();
  for (const r of rows) {
    const aid = String(r.articleId || r.id || '');
    if (!aid) continue;
    // 聚合键用纯文章 id（去掉可能的 #code 后缀）
    const pureId = aid.includes('#') ? aid.split('#')[0] : aid;
    if (!map.has(pureId)) {
      map.set(pureId, {
        id: pureId,
        ctime: r.ctime || 0,
        prefix: r.prefix || '',
        title: r.title || '',
        text: r.text || '',
        url: r.url || '',
        stocks: [],
      });
    }
    const g = map.get(pureId);
    if (r.stockCode && !g.stocks.some(function (s) { return s.code === r.stockCode; })) {
      g.stocks.push({ code: r.stockCode, name: r.stockName || '' });
    }
  }
  return Array.from(map.values()).sort(function (a, b) { return b.ctime - a.ctime; });
}

/** 拉取 VIP 列表，建成 id → {title, brief, ctime} 映射。失败返回空 Map。 */
async function loadVipMap() {
  const map = new Map();
  try {
    const items = await cls.fetchVipArticles({});
    for (const it of items || []) {
      const id = String(it.id || '').trim();
      if (!id) continue;
      map.set(id, {
        title: String(it.title || ''),
        brief: String(it.brief || it.summary || ''),
        ctime: Number(it.ctime) || 0,
      });
    }
    console.log('  [notify] VIP 标题/摘要映射：' + map.size + ' 条');
  } catch (e) {
    console.error('  [notify] 拉取 VIP 失败，推送将沿用个股侧标题摘要: ' + (e && e.message ? e.message : e));
  }
  return map;
}

/** 用 VIP 的 title/brief 覆盖文章；无对应 VIP 时保持原样。 */
function applyVipOverlay(articles, vipMap) {
  let hit = 0;
  for (const a of articles) {
    const v = vipMap.get(String(a.id));
    if (!v) continue;
    if (v.title) a.title = v.title;
    // 摘要：始终用 VIP brief（允许空串，符合「摘要:」后可为空）
    a.text = v.brief || '';
    if (v.ctime) a.ctime = v.ctime;
    a.fromVip = true;
    hit++;
  }
  console.log('  [notify] 已用 VIP 覆盖标题/摘要：' + hit + '/' + articles.length + ' 篇');
  return articles;
}

/* ----------------------------------------------------------- 格式化 */

function fmtPushTime(sec) {
  const d = new Date(sec * 1000);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return '[' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ']';
}

/**
 * @param {object} article
 * @param {object} cache      research 缓存
 * @param {Record<string,string>} notes  MiniMax 一句话 {纯数字code: desc}
 */
function formatArticle(article, cache, notes) {
  notes = notes || {};
  let title = article.title || '';
  if (title.length > 50) title = title.slice(0, 50) + '…';

  const lines = [];
  lines.push(fmtPushTime(article.ctime) + title);
  lines.push('');
  const brief = String(article.text || '').replace(/\s+/g, ' ').trim();
  lines.push('摘要: ' + brief);
  lines.push('');

  const groups = {};
  for (const s of article.stocks) {
    const b = boardOf(s.code);
    (groups[b] = groups[b] || []).push(s);
  }
  const ordered = BOARD_ORDER.filter(function (b) { return groups[b] && groups[b].length; });
  Object.keys(groups).forEach(function (b) { if (ordered.indexOf(b) < 0) ordered.push(b); });

  for (const board of ordered) {
    lines.push(board + '：');
    for (const s of groups[board]) {
      const code = pureCode(s.code);
      const tag = code ? s.name + '(' + code + ')' : s.name;
      // MiniMax 一句话优先；失败则回退 research 题材
      const desc = (code && notes[code]) || themeOf(cache, s.code) || '';
      lines.push(' ' + tag + '-' + desc);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

/* --------------------------------------------------------------- 网络发送 */

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
 * @param {Array} rows
 * @param {Object} opts  { config, dryRun, vipMap? }
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
  let articles = groupByArticle(rows);

  // VIP 标题/摘要覆盖
  const vipMap = opts.vipMap || await loadVipMap();
  articles = applyVipOverlay(articles, vipMap);

  let pushed = 0;
  let skipped = 0;
  for (const a of articles) {
    if (pushedStore.ids[a.id]) { skipped++; continue; }

    let notes = {};
    try {
      notes = await minimax.generateStockNotes(a.title, a.text, a.stocks, cfg);
    } catch (e) {
      console.error('  [notify] MiniMax 异常，回退题材描述: ' + (e && e.message ? e.message : e));
      notes = {};
    }

    const content = formatArticle(a, cache, notes);

    if (dryRun) {
      console.log('----- [dry-run] 将推送 -----\n' + content);
      pushed++;
      continue;
    }

    const ok = await sendWecomText(webhook, content);
    if (ok) {
      pushedStore.ids[a.id] = a.ctime || Math.floor(Date.now() / 1000);
      pushed++;
      await sleep(500);
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
  loadVipMap: loadVipMap,
  applyVipOverlay: applyVipOverlay,
  pushNew: pushNew,
};
