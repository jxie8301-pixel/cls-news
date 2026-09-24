'use strict';

/**
 * Cloudflare cls-news-api 客户端（CNB / 本地共用）
 *
 * 环境变量：
 *   D1_API_BASE     默认 https://cls-news.jxie.ccwu.cc（国内可达；勿用 *.workers.dev）
 *   D1_WRITE_TOKEN  必填（写接口）
 */

const DEFAULT_BASE = 'https://cls-news.jxie.ccwu.cc';

function baseUrl() {
  return String(process.env.D1_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function token() {
  return String(process.env.D1_WRITE_TOKEN || '').trim();
}

async function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = baseUrl() + path;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: method,
        headers: headers,
        body: payload,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text || '{}');
      } catch (_) {
        throw new Error('D1 API 非 JSON HTTP ' + res.status + ': ' + text.slice(0, 200));
      }
      if (!res.ok || data.ok === false) {
        throw new Error('D1 API ' + path + ' HTTP ' + res.status + ': ' + (data.error || text.slice(0, 200)));
      }
      return data;
    } catch (e) {
      lastErr = e;
      console.warn('[d1] ' + method + ' ' + path + ' attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

function getVipGate() {
  return request('GET', '/api/vip-gate');
}

function setVipGate(lastVipIds, updatedBy) {
  return request('POST', '/api/vip-gate', {
    lastVipIds: lastVipIds || [],
    updatedBy: updatedBy || 'cnb',
  });
}

async function upsertArticles(articles, source) {
  const list = articles || [];
  const src = source || 'cnb';
  // 单次 Worker 调用 D1 语句上限约 1000；按文章分批，每批独立 HTTP 请求
  const CHUNK = 25;
  let nArt = 0;
  let nStock = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const res = await request('POST', '/api/upsert', {
      articles: chunk,
      source: src,
    });
    nArt += Number(res.articles) || chunk.length;
    nStock += Number(res.stocks) || 0;
    console.log('[d1] upsert batch ' + Math.min(i + CHUNK, list.length) + '/' + list.length
      + ' articles=' + (res.articles || 0) + ' stocks=' + (res.stocks || 0));
  }
  return { ok: true, articles: nArt, stocks: nStock, source: src };
}

function perfPending() {
  return request('GET', '/api/perf/pending');
}

function perfUpdate(rows) {
  return request('POST', '/api/perf/update', { rows: rows || [] });
}

function ingestDone(payload) {
  return request('POST', '/api/ingest-done', payload || {});
}

/**
 * 从 collect store 抽 D1 upsert 载荷（matched 文 + 个股）
 */
function articlesFromStore(store, opts) {
  opts = opts || {};
  const days = opts.days || 7;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const out = [];
  const arts = store && store.articles ? store.articles : {};
  for (const id of Object.keys(arts)) {
    const r = arts[id];
    if (!r || r.matchedConfig === false) continue;
    if ((r.ctime || 0) < cutoff) continue;
    out.push({
      article_id: String(r.id || id),
      ctime: Number(r.ctime) || 0,
      prefix: r.column || '',
      title: r.title || '',
      brief: (r.brief || r.text || '').replace(/\s+/g, ' ').trim(),
      url: r.url || ('https://www.cls.cn/detail/' + id),
      stocks: (r.stocks || []).map(function (s) {
        return {
          code: s.code,
          name: s.name || '',
          board: s.board || '',
        };
      }),
    });
  }
  return out;
}

module.exports = {
  DEFAULT_BASE: DEFAULT_BASE,
  baseUrl: baseUrl,
  getVipGate: getVipGate,
  setVipGate: setVipGate,
  upsertArticles: upsertArticles,
  perfPending: perfPending,
  perfUpdate: perfUpdate,
  ingestDone: ingestDone,
  articlesFromStore: articlesFromStore,
};
