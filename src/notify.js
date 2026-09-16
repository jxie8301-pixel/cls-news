'use strict';

/**
 * 企业微信群机器人推送 —— 零依赖（dashboard / GitHub Actions）。
 *
 * 流程：
 *   1. 个股扫描得到文章×股票 rows，按 articleId 聚合成一文一条
 *   2. 用 VIP 列表中同 id 的 title / brief 覆盖推送标题与摘要（个股侧标题摘要不准）
 *   3. 调用 MiniMax 为每只标的生成一句话（独特标签+热点+硬连接+边界）；失败则回退 research 题材
 *   4. 按板块分组，以 markdown 推送到企业微信
 *   5. 发送成功后写入 data/pushes.db（新闻时间/栏目/标题/摘要/个股一句话）
 *
 * 文本格式示例（msgtype=markdown）：
 *   **[09-15 10:51]【盘中宝】**完整标题正文（仅时间+栏目加粗）
 *
 *   > 摘要: 完整摘要（不截断）
 *
 *   **主板：**
 *   - **东材科技**(601208)：一句话描述
 *
 * 去重：data/pushed.json（文章 id）
 * 归档：data/pushes.db（SQLite，存于 data 分支）
 * webhook：环境变量 WECOM_WEBHOOK > config.wecomWebhook
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const collectMod = require('./collect.js');
const research = require('./research.js');
const cls = require('./cls.js');
const minimax = require('./minimax.js');
const pushDb = require('./push_db.js');

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

/** 企微 markdown 官方上限 4096 字节；预留页眉/续页标记余量 */
const WECOM_MD_MAX_BYTES = 4096;
const WECOM_MD_SAFE_BYTES = 3800;

function utf8Len(s) {
  return Buffer.byteLength(String(s == null ? '' : s), 'utf8');
}

/** 按 UTF-8 字节截断，不拆多字节字符 */
function truncateUtf8(s, maxBytes) {
  const str = String(s == null ? '' : s);
  if (utf8Len(str) <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf8');
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.slice(0, end).toString('utf8').replace(/\uFFFD$/g, '') + '…';
}

function fmtPushTime(sec) {
  const d = new Date(sec * 1000);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return '[' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ']';
}

/**
 * 拆出标题开头的 【栏目】 / [栏目]，其余为正文。
 * 无括号前缀时，用 article.prefix 补成 【prefix】。
 */
function splitTitleLead(title, prefixHint) {
  const t = String(title || '').trim();
  const m = /^([【\[][^】\]]{1,40}[】\]])\s*/.exec(t);
  if (m) {
    return { lead: m[1], rest: t.slice(m[0].length) };
  }
  const hint = String(prefixHint || '').trim();
  if (hint) {
    return { lead: '【' + hint + '】', rest: t };
  }
  return { lead: '', rest: t };
}

function buildHeadBlock(article) {
  const title = String(article.title || '').trim();
  const time = fmtPushTime(article.ctime);
  const parts = splitTitleLead(title, article.prefix);
  const headLine = parts.lead
    ? ('**' + time + parts.lead + '**' + parts.rest)
    : ('**' + time + '**' + parts.rest);
  const brief = String(article.text || '').replace(/\s+/g, ' ').trim();
  // 摘要后必须空行，结束 `>` 引用，避免后续板块/个股被续进摘要块
  return headLine + '\n\n> 摘要: ' + brief + '\n\n';
}

function buildStockLines(article, cache, notes) {
  notes = notes || {};
  const groups = {};
  for (const s of article.stocks || []) {
    const b = boardOf(s.code);
    (groups[b] = groups[b] || []).push(s);
  }
  const ordered = BOARD_ORDER.filter(function (b) { return groups[b] && groups[b].length; });
  Object.keys(groups).forEach(function (b) { if (ordered.indexOf(b) < 0) ordered.push(b); });

  const lines = [];
  for (const board of ordered) {
    lines.push('**' + board + '：**');
    for (const s of groups[board]) {
      const code = pureCode(s.code);
      const name = s.name || '';
      const ai = (code && notes[code]) || '';
      const fallback = themeOf(cache, s.code) || '';
      let desc = ai || fallback;
      const mark = ai ? '' : (fallback ? '<font color="comment">(题材)</font> ' : '');
      const tag = code
        ? '**' + name + '**(' + code + ')'
        : '**' + name + '**';
      let line = '- ' + tag + '：' + mark + desc;
      // 单行也不允许超过安全上限（极端长一句话）
      if (utf8Len(line) > WECOM_MD_SAFE_BYTES - 80) {
        const budget = Math.max(40, WECOM_MD_SAFE_BYTES - 80 - utf8Len('- ' + tag + '：' + mark));
        desc = truncateUtf8(desc, budget);
        line = '- ' + tag + '：' + mark + desc;
      }
      lines.push(line);
    }
    lines.push('');
  }
  return lines;
}

function buildContinueHeader(article, page, totalPages) {
  const title = String(article.title || '').trim();
  const time = fmtPushTime(article.ctime);
  const parts = splitTitleLead(title, article.prefix);
  const lead = parts.lead || '';
  const restShort = truncateUtf8(parts.rest || title, 60);
  return '**(续 ' + page + '/' + totalPages + ')** **' + time + lead + '**' + restShort + '\n\n';
}

/**
 * 将一文拆成多条 markdown，每条 UTF-8 字节 ≤ WECOM_MD_SAFE_BYTES。
 * @returns {string[]}
 */
function splitWecomMarkdownMessages(article, cache, notes) {
  let head = buildHeadBlock(article);
  if (utf8Len(head) > WECOM_MD_SAFE_BYTES) {
    // 摘要过长：保标题，压摘要
    const title = String(article.title || '').trim();
    const time = fmtPushTime(article.ctime);
    const parts = splitTitleLead(title, article.prefix);
    const headLine = parts.lead
      ? ('**' + time + parts.lead + '**' + parts.rest)
      : ('**' + time + '**' + parts.rest);
    const fixed = headLine + '\n\n> 摘要: ';
    const budget = WECOM_MD_SAFE_BYTES - utf8Len(fixed) - 2;
    const brief = truncateUtf8(String(article.text || '').replace(/\s+/g, ' ').trim(), Math.max(20, budget));
    head = fixed + brief + '\n\n';
  }

  const stockLines = buildStockLines(article, cache, notes);
  // 先估算需要几页：用占位续页头的保守长度
  const probeHdr = buildContinueHeader(article, 99, 99);
  const bodyBudgetFirst = WECOM_MD_SAFE_BYTES - utf8Len(head);
  const bodyBudgetCont = WECOM_MD_SAFE_BYTES - utf8Len(probeHdr);

  const pages = [];
  let cur = [];
  let curLen = 0;
  let isFirst = true;
  let budget = bodyBudgetFirst;

  function flush() {
    if (!cur.length && pages.length) return;
    pages.push(cur);
    cur = [];
    curLen = 0;
    isFirst = false;
    budget = bodyBudgetCont;
  }

  for (const line of stockLines) {
    const add = utf8Len(line) + (cur.length ? 1 : 0); // +1 for \n
    if (cur.length && curLen + add > budget) flush();
    // 空板块行等极短行
    if (!cur.length && add > budget) {
      cur.push(truncateUtf8(line, budget));
      curLen = utf8Len(cur[0]);
      flush();
      continue;
    }
    cur.push(line);
    curLen += add;
  }
  if (cur.length || !pages.length) pages.push(cur);

  const total = pages.length;
  const out = [];
  for (let i = 0; i < total; i++) {
    const body = pages[i].join('\n').replace(/\s+$/, '');
    if (i === 0) {
      out.push((head + (body ? body + '\n' : '')).replace(/\s+$/, '') + '\n');
    } else {
      out.push((buildContinueHeader(article, i + 1, total) + body + '\n').replace(/\s+$/, '') + '\n');
    }
    // 最终兜底再截一次（理论上不应触发）
    if (utf8Len(out[i]) > WECOM_MD_MAX_BYTES) {
      out[i] = truncateUtf8(out[i], WECOM_MD_MAX_BYTES - 3) + '…\n';
    }
  }
  return out;
}

/**
 * @param {object} article
 * @param {object} cache      research 缓存
 * @param {Record<string,string>} notes  MiniMax 一句话 {纯数字code: desc}
 */
function formatArticle(article, cache, notes) {
  return splitWecomMarkdownMessages(article, cache, notes).join('\n');
}

/** 推送成功后写入 SQLite 的个股行。 */
function buildStockArchiveRows(article, cache, notes) {
  notes = notes || {};
  const out = [];
  for (const s of article.stocks || []) {
    const code = pureCode(s.code);
    if (!code) continue;
    const ai = notes[code] || '';
    const fallback = themeOf(cache, s.code) || '';
    out.push({
      code: code,
      name: s.name || '',
      board: boardOf(s.code),
      note: ai || fallback,
      note_source: ai ? 'ai' : (fallback ? 'theme' : ''),
    });
  }
  return out;
}

function resolvePrefix(article) {
  const fromTitle = cls.titlePrefix(article && article.title);
  if (fromTitle) return fromTitle;
  if (article && article.prefix) return String(article.prefix).trim();
  return '';
}

function archivePush(article, cache, notes) {
  try {
    pushDb.upsertPush({
      article_id: String(article.id),
      ctime: Number(article.ctime) || 0,
      prefix: resolvePrefix(article),
      title: String(article.title || '').trim(),
      brief: String(article.text || '').replace(/\s+/g, ' ').trim(),
      stocks: buildStockArchiveRows(article, cache, notes),
    });
    console.log('  [notify] 已归档 pushes.db article=' + article.id);
  } catch (e) {
    console.error('  [notify] 归档 SQLite 失败（不影响推送去重）: ' + (e && e.message ? e.message : e));
  }
}

/* --------------------------------------------------------------- 网络发送 */

function sendWecomMarkdown(webhook, content) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(webhook); } catch (_) { resolve(false); return; }
    const body = Buffer.from(JSON.stringify({
      msgtype: 'markdown',
      markdown: { content: content },
    }), 'utf8');
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

  console.log('[minimax] notify.pushNew enter rows=' + (rows && rows.length) +
    ' webhook=' + (webhook ? 'yes' : 'no') +
    ' dryRun=' + dryRun +
    ' envKeyLen=' + String(process.env.MINIMAX_API_KEY || '').length);

  if (!webhook && !dryRun) {
    console.log('[minimax] notify abort: WECOM_WEBHOOK missing（整段推送含 MiniMax 均跳过）');
    console.log('  [notify] 未配置 WECOM_WEBHOOK，跳过推送');
    return { pushed: 0, skipped: 0, total: 0 };
  }

  const cache = research.loadCache();
  const pushedStore = loadPushed();
  let articles = groupByArticle(rows);

  // VIP 标题/摘要覆盖
  const vipMap = opts.vipMap || await loadVipMap();
  articles = applyVipOverlay(articles, vipMap);

  const already = articles.filter(function (a) { return !!pushedStore.ids[a.id]; }).length;
  const pending = articles.length - already;
  console.log('[minimax] notify articles=' + articles.length +
    ' alreadyPushed=' + already + ' pendingMiniMax=' + pending);

  let pushed = 0;
  let skipped = 0;
  for (const a of articles) {
    if (pushedStore.ids[a.id]) {
      skipped++;
      continue;
    }

    console.log('[minimax] will call API for article id=' + a.id +
      ' stocks=' + (a.stocks && a.stocks.length) +
      ' title=' + String(a.title || '').slice(0, 40));

    let notes = {};
    try {
      notes = await minimax.generateStockNotes(a.title, a.text, a.stocks, cfg);
    } catch (e) {
      console.error('[minimax] notify exception: ' + (e && e.message ? e.message : e));
      notes = {};
    }
    const noteCount = Object.keys(notes || {}).length;
    if (!noteCount) {
      console.log('[minimax] article ' + a.id + ' no AI notes → fallback theme (题材)');
    } else {
      console.log('[minimax] article ' + a.id + ' AI notes=' + noteCount);
    }

    const messages = splitWecomMarkdownMessages(a, cache, notes);
    const totalBytes = messages.reduce(function (n, m) { return n + utf8Len(m); }, 0);
    console.log('  [notify] article ' + a.id + ' wecom parts=' + messages.length +
      ' bytes=' + totalBytes +
      messages.map(function (m, i) { return ' p' + (i + 1) + '=' + utf8Len(m); }).join(''));

    if (dryRun) {
      messages.forEach(function (m, i) {
        console.log('----- [dry-run] 将推送 (' + (i + 1) + '/' + messages.length + ') -----\n' + m);
      });
      pushed++;
      continue;
    }

    let okAll = true;
    for (let i = 0; i < messages.length; i++) {
      const ok = await sendWecomMarkdown(webhook, messages[i]);
      if (!ok) {
        okAll = false;
        console.log('[minimax] wecom send failed for article ' + a.id +
          ' part ' + (i + 1) + '/' + messages.length + '（未写入 pushed，下次仍会重试）');
        break;
      }
      if (i + 1 < messages.length) await sleep(500);
    }
    if (okAll) {
      pushedStore.ids[a.id] = a.ctime || Math.floor(Date.now() / 1000);
      archivePush(a, cache, notes);
      pushed++;
      await sleep(500);
    }
  }

  if (!dryRun) savePushed(pushedStore);
  console.log('[minimax] notify done pushed=' + pushed + ' skipped=' + skipped + ' total=' + articles.length);
  console.log('  [notify] 推送完成：新增 ' + pushed + ' 条，跳过（已推送）' + skipped + ' 条，本轮文章 ' + articles.length + ' 篇');
  return { pushed: pushed, skipped: skipped, total: articles.length };
}

module.exports = {
  PUSHED_FILE: PUSHED_FILE,
  WECOM_MD_MAX_BYTES: WECOM_MD_MAX_BYTES,
  WECOM_MD_SAFE_BYTES: WECOM_MD_SAFE_BYTES,
  boardOf: boardOf,
  pureCode: pureCode,
  themeOf: themeOf,
  utf8Len: utf8Len,
  truncateUtf8: truncateUtf8,
  groupByArticle: groupByArticle,
  formatArticle: formatArticle,
  splitWecomMarkdownMessages: splitWecomMarkdownMessages,
  buildStockArchiveRows: buildStockArchiveRows,
  loadPushed: loadPushed,
  savePushed: savePushed,
  loadVipMap: loadVipMap,
  applyVipOverlay: applyVipOverlay,
  pushNew: pushNew,
};
