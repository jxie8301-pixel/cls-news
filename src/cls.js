'use strict';

/**
 * 财联社 (cls.cn) 数据客户端 —— 零依赖。
 *
 * 站点前端请求签名方式（逆向自 wwwjs.cls.cn 线上 JS，模块 36498）：
 *   sign = md5( sha1( 按 key 默认排序后的 query string ) )
 * 其中 query string 用 "&" 连接，嵌套对象写成 key[sub]、数组写成 key[0]/key[1]。
 *
 * 用到的两个接口：
 *   GET /es/quotes/articles     个股新闻列表（keyword=股票代码, lastTime=秒级时间戳, rn=条数）
 *   GET /articles/v1/detail     文章详情（未登录/VIP 受限时可能返回空壳）
 * 正文兜底：https://api3.cls.cn/share/article/{id}?os=web&sv=..&app=..&source=xk
 */

const crypto = require('node:crypto');

const WEB_HOST = 'https://www.cls.cn';
const SHARE_HOST = 'https://api3.cls.cn';
const APP = 'CailianpressWeb';
const SV = '8.7.9';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 可选登录态：填入 self 的 token/uid 后，可拉取订阅栏目正文 */
let AUTH = {};
function setAuth(auth) {
  AUTH = auth && typeof auth === 'object' ? auth : {};
}
function hasAuth() {
  return !!(AUTH.token || AUTH.cookie);
}

/* ------------------------------------------------------------------ 签名 */

function pair(prefix, value) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return prefix + '=' + String(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return prefix + '[]';
    return value
      .map((v, i) => pair(prefix + '[' + i + ']', v))
      .filter(Boolean)
      .join('&');
  }
  if (t === 'object') {
    return Object.keys(value)
      .sort()
      .map((k) => pair(prefix + '[' + k + ']', value[k]))
      .filter(Boolean)
      .join('&');
  }
  return null;
}

function queryString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => pair(k, params[k]))
    .filter(Boolean)
    .join('&');
}

function signQuery(qs) {
  const sha1 = crypto.createHash('sha1').update(qs, 'utf8').digest('hex');
  return crypto.createHash('md5').update(sha1, 'utf8').digest('hex');
}

/* --------------------------------------------------------------- 网络层 */

async function httpGet(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = {
    'User-Agent': UA,
    Referer: WEB_HOST + '/',
    Accept: 'application/json, text/plain, */*',
  };
  if (AUTH.cookie) headers.Cookie = AUTH.cookie;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: headers,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 调 cls.cn 网页 API（自动补 os/sv/app 并加签），带重试。 */
async function api(path, params = {}, { retries = 3, timeout = 20000 } = {}) {
  const p = Object.assign({ os: 'web', sv: SV }, params);
  if (!('app' in p)) p.app = APP;
  if (AUTH.token) p.token = AUTH.token;
  if (AUTH.uid) p.uid = AUTH.uid;
  const qs = queryString(p);
  const url = new URL(WEB_HOST + path);
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('sign', signQuery(qs));

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, text } = await httpGet(url.toString(), { timeout });
      if (status >= 400) throw new Error('HTTP ' + status);
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

const XQUOTE_HOST = 'https://x-quote.cls.cn';

/** 调行情域（x-quote.cls.cn）接口，签名规则与网页 API 相同。 */
async function xquote(path, params = {}, { retries = 3, timeout = 20000 } = {}) {
  const p = Object.assign({ os: 'web', sv: SV, app: APP }, params);
  const qs = queryString(p);
  const url = new URL(XQUOTE_HOST + path);
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('sign', signQuery(qs));

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, text } = await httpGet(url.toString(), { timeout });
      if (status >= 400) throw new Error('HTTP ' + status);
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * 取指数成分股（含名称）。page 在服务端相当于"取前 page*30 条"，
 * 传足够大的值可一次拿全（上证指数 2182 只、深证成指 500 只、创业板指 100 只）。
 */
async function fetchIndexConstituents(secuCode, { page = 100 } = {}) {
  const body = await xquote('/web_quote/web_stock/indCompoment', {
    secu_code: secuCode,
    way: 'change',
    page,
    rever: 1,
  });
  const data = body && body.data;
  const list = (data && data.data) || [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || !x.secu_code || seen.has(x.secu_code)) continue;
    seen.add(x.secu_code);
    out.push({ code: x.secu_code, name: x.secu_name || '' });
  }
  return { stocks: out, isAll: data && data.is_all };
}

/**
 * 取沪深两市全部上市公司（不含北交所）。
 * market=all 返回 5000+ 只，page 同样是"取前 page*30 条"，传 200 可一次拿全。
 */
async function fetchAllStocks({ page = 200, market = 'all' } = {}) {
  const body = await xquote('/web_quote/web_stock/stock_list', {
    types: 'last_px,change,tr,main_fund_diff,cmc,trade_status',
    market: market,
    way: 'change',
    page: page,
    rever: 1,
  });
  const data = body && body.data;
  const list = (data && data.data) || [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const code = String(x.secu_code || '');
    if (!/^(sh|sz)\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code: code, name: x.secu_name || '' });
  }
  return { stocks: out, isAll: data && data.is_all };
}

/* ------------------------------------------------------- 个股新闻列表 */

/**
 * 拉取单只股票在 [sinceSec, now] 区间内的新闻列表。
 * 分页靠 lastTime 往回翻，直到越过 sinceSec 或列表取尽。
 */
async function fetchStockArticles(code, { sinceSec, maxPages = 60, onPage } = {}) {
  const cutoff = sinceSec || Math.floor(Date.now() / 1000) - 7 * 86400;
  const out = [];
  const seen = new Set();
  let lastTime = Math.floor(Date.now() / 1000);

  for (let page = 0; page < maxPages; page++) {
    const body = await api('/es/quotes/articles', {
      keyword: code,
      lastTime,
      rn: 10,
    });
    const list = body && body.data;
    if (!Array.isArray(list) || list.length === 0) break;

    let oldest = Infinity;
    for (const item of list) {
      if (!item || !item.id) continue;
      if (item.ctime < oldest) oldest = item.ctime;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    if (onPage) onPage(page + 1, list.length);
    if (list.length < 10) break;
    if (!isFinite(oldest) || oldest <= cutoff) break;
    lastTime = oldest;
    await sleep(80);
  }

  return out.filter((it) => it.ctime >= cutoff);
}

/* ----------------------------------------------------------- 正文抓取 */

function extractContentDiv(html) {
  const marker = '<div class="content">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  let depth = 1;
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(i, m.index);
  }
  return html.slice(i);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—',
  middot: '·', times: '×', copy: '©', reg: '®', deg: '°',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
}

function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 取文章正文。优先走 share 页（服务端直出全文），失败再用 /articles/v1/detail。
 * 返回 { text, source, truncated }
 */
async function fetchArticleText(id, { timeout = 20000 } = {}) {
  const urls = [
    SHARE_HOST + '/share/article/' + encodeURIComponent(id) +
      '?os=web&sv=' + SV + '&app=' + APP + '&source=xk',
    SHARE_HOST + '/share/article/' + encodeURIComponent(id) + '?os=web&sv=' + SV + '&app=' + APP,
  ];

  let sawPaywall = false;
  for (const url of urls) {
    try {
      const { status, text: html } = await httpGet(url, { timeout });
      if (status !== 200) continue;
      const raw = extractContentDiv(html);
      const text = htmlToText(raw);
      if (text && text.length > 120) return { text, source: 'share', truncated: isTruncated(text) };
      if (raw !== null) sawPaywall = true;
    } catch (_) {
      /* 换下一个源 */
    }
  }

  try {
    const body = await api('/articles/v1/detail', { id, app: 0 });
    const d = body && (body.data || body);
    if (d && d.content) {
      const text = htmlToText(d.content);
      if (text) return { text, source: 'detail', truncated: isTruncated(text) };
    }
    if (d && d.column && d.column.columnName) sawPaywall = true;
  } catch (_) {
    /* ignore */
  }

  return { text: '', source: sawPaywall ? 'gated' : 'none', truncated: false };
}

function isTruncated(text) {
  return /订阅|开通VIP|登录后查看|查看全文|成为会员/.test(text.slice(-80));
}

/* ------------------------------------------------------------- 工具 */

function fmtTime(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

/** 从标题里抽出 【xxx】 前缀（若有）。 */
function titlePrefix(title) {
  const m = /^\s*[【\[]([^】\]]{1,20})[】\]]/.exec(title || '');
  return m ? m[1].trim() : '';
}

/**
 * 标题是否命中目标前缀。
 * 规则：完全相等；或栏目名带副标题（如「风口研报·行业」「盘中宝·记者一线」）；
 * 不做互相包含匹配，避免「龙虎榜」被「解读龙虎榜」误收。
 */
function matchPrefix(title, prefixes) {
  const p = titlePrefix(title);
  if (!p) return '';
  for (const want of prefixes) {
    if (p === want) return p;
    if (p.length > want.length && /^[\s·・\-—_]/.test(p.slice(want.length))) return p;
  }
  return '';
}

module.exports = {
  WEB_HOST,
  SHARE_HOST,
  setAuth,
  hasAuth,
  signQuery,
  queryString,
  api,
  xquote,
  fetchIndexConstituents,
  fetchAllStocks,
  fetchStockArticles,
  fetchArticleText,
  extractContentDiv,
  htmlToText,
  fmtTime,
  titlePrefix,
  matchPrefix,
  sleep,
};
