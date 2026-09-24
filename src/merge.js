'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readShardFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mergeArticles(target, source) {
  for (const id of Object.keys(source || {})) {
    const src = source[id];
    if (!target[id]) {
      target[id] = JSON.parse(JSON.stringify(src));
      continue;
    }
    const dst = target[id];
    for (const s of src.stocks || []) {
      if (!dst.stocks.some(function (x) { return x.code === s.code; })) {
        dst.stocks.push(s);
      }
    }
    if (src.matchedConfig) dst.matchedConfig = true;
  }
}

/**
 * @param {string[]} shardPaths  各片 scan 输出 JSON 路径
 */
function mergeShards(shardPaths) {
  const parts = shardPaths.map(readShardFile);
  const shards = parts[0] && parts[0].meta ? parts[0].meta.shards : parts.length;
  const aborted = parts.filter(function (p) { return p.aborted; });
  const stats = {
    shards: shards,
    parts: parts.length,
    abortedParts: aborted.length,
    poolTotal: parts[0] && parts[0].stats ? parts[0].stats.poolTotal : null,
    stocksAssigned: 0,
    scanned: 0,
    listed: 0,
    prefixed: 0,
    matched: 0,
    errors: 0,
    errorKinds: {},
  };

  for (const p of parts) {
    const s = p.stats || {};
    stats.stocksAssigned += s.stocks || 0;
    stats.scanned += s.scanned || 0;
    stats.listed += s.listed || 0;
    stats.prefixed += s.prefixed || 0;
    stats.matched += s.matched || 0;
    stats.errors += s.errors || 0;
    for (const [k, v] of Object.entries(s.errorKinds || {})) {
      stats.errorKinds[k] = (stats.errorKinds[k] || 0) + v;
    }
  }

  console.log('[crawler] ── 合并');
  console.log('[crawler]   分片 ' + stats.parts + '/' + stats.shards
    + '  超时作废片 ' + stats.abortedParts);
  console.log('[crawler]   合计已抓 ' + stats.scanned + '  失败 ' + stats.errors
    + '  命中 ' + stats.matched);

  if (aborted.length) {
    console.log('[crawler] 存在超时作废分片，整轮视为失败，不产出 merged articles');
    return {
      ok: false,
      reason: 'shard_timeout',
      stats: stats,
      articles: {},
      parts: parts.map(function (p) {
        return { shard: p.meta && p.meta.shard, aborted: p.aborted, stats: p.stats };
      }),
    };
  }

  if (parts.length !== shards) {
    console.log('[crawler] 分片数量不足 ' + parts.length + ' < ' + shards);
    return {
      ok: false,
      reason: 'missing_shards',
      stats: stats,
      articles: {},
      parts: [],
    };
  }

  const articles = {};
  for (const p of parts) {
    mergeArticles(articles, p.articles);
  }

  const matchedArticles = Object.values(articles).filter(function (a) {
    return a.matchedConfig;
  }).length;

  console.log('[crawler]   合并后文章 ' + Object.keys(articles).length
    + '  其中命中栏目 ' + matchedArticles);

  return {
    ok: true,
    stats: Object.assign({}, stats, { matchedArticles: matchedArticles }),
    articles: articles,
    parts: parts.map(function (p) {
      return { shard: p.meta.shard, stats: p.stats };
    }),
  };
}

module.exports = { mergeShards, mergeArticles };
