'use strict';

const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');
const report = require('./report.js');
const cls = require('./cls.js');
const research = require('./research.js');
const notify = require('./notify.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function withPoolNames(rows, names) {
  return rows.map(function (r) {
    r.poolNames = (r.pools || []).map(function (k) { return names[k] || k; });
    return r;
  });
}

function rangeLabel(days) {
  const nowSec = Math.floor(Date.now() / 1000);
  return cls.fmtTime(nowSec - days * 86400).slice(0, 10) + ' ~ ' + cls.fmtTime(nowSec).slice(0, 10);
}

// 发布到 Pages 时两个版本互跳；本地导出保持无链接
function siteLinks() { return process.argv.includes('--site-links'); }

(async () => {
  const cfg = collectMod.loadConfig();
  const days = parseInt(arg('days', cfg.days || 7), 10);
  const limit = parseInt(arg('limit', 0), 10) || 0;
  const wantExportOnly = process.argv.includes('--export');

  // ── VIP 差集门控（默认开启）────────────────────────────────
  // 相对上轮 lastVipIds 无新增有效 VIP 时 exit 3，跳过抓取/推送/发布。
  // --no-gate 强制全量；--export 不做门控。
  let curVipIds = [];
  const wantGate = !process.argv.includes('--no-gate');
  if (!wantExportOnly) {
    try {
      const statusPath = path.join(report.OUT_DIR, 'status.json');
      let lastVipIds = [];
      try {
        const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        lastVipIds = Array.isArray(st.lastVipIds) ? st.lastVipIds : [];
      } catch (_) { /* 首次运行无 status.json */ }

      const vipItems = await cls.fetchVipArticles({});
      const skipTitleKws = ['玩转ETF'];
      const eligible = vipItems.filter(function (it) {
        if (!cls.vipHasStock(it)) return false;
        const title = String(it.title || '');
        if (skipTitleKws.some(function (kw) { return title.indexOf(kw) !== -1; })) return false;
        return true;
      });
      curVipIds = eligible.map(function (it) { return String(it.id); });

      const lastIdSet = new Set(lastVipIds);
      const newIds = curVipIds.filter(function (id) { return !lastIdSet.has(id); });
      console.log('VIP 列表：' + vipItems.length + ' 条'
        + ' ｜ 有效（带个股且非ETF）' + eligible.length + ' 条'
        + ' ｜ 相对上轮新增 ' + newIds.length + ' 条'
        + (wantGate ? ' ｜ VIP 差集门控开启' : ' ｜ --no-gate 强制全量'));

      if (wantGate && newIds.length === 0) {
        console.log('  ⏭  无新的带个股 VIP 新闻，本轮跳过抓取与发布。');
        process.exit(3);
      }
    } catch (e) {
      console.log('  ⚠️  VIP 列表异常，继续抓取：' + (e && e.message ? e.message : e));
    }
  }

  if (!wantExportOnly && cfg.syncPoolsOnStart !== false && !process.argv.includes('--no-sync')) {
    const synced = await collectMod.syncPools({});
    synced.forEach(function (s) {
      console.log('  股票池 ' + s.name + '：' + (s.ok ? s.count + ' 只' : '同步失败 ' + s.error));
    });
  }

  const pools = collectMod.loadPools();
  if (!pools.length) {
    console.error('没有可用股票池：请检查 config.json 的 marketPool / indexPools，或 data/watchlist.json');
    process.exit(1);
  }
  const only = arg('pool', null);
  const selected = only && only !== true ? pools.filter(function (p) { return p.key === String(only); }) : pools;
  const names = {};
  pools.forEach(function (p) { names[p.key] = p.name; });
  console.log('股票池：' + selected.map(function (p) { return p.name + '(' + p.count + ')'; }).join('、'));
  console.log('回溯 ' + days + ' 天 ｜ 目标栏目: ' + cfg.prefixes.join('、'));

  if (!wantExportOnly) {
    const t0 = Date.now();
    let lastLog = 0;
    const res = await collectMod.collect({
      days: days,
      limit: limit,
      pools: selected.map(function (p) { return p.key; }),
      fetchText: !process.argv.includes('--no-text'),
      onProgress: function (stats) {
        const now = Date.now();
        if (now - lastLog < 2000 && stats.scanned < stats.stocks) return;
        lastLog = now;
        process.stdout.write('\r进度 ' + stats.scanned + '/' + stats.stocks
          + ' ｜ 新闻 ' + stats.listed
          + ' ｜ 带栏目前缀 ' + stats.prefixed
          + ' ｜ 命中目标 ' + stats.matched
          + ' ｜ 正文 ' + stats.newText
          + ' ｜ 失败 ' + stats.errors
          + (stats.aborted ? ' ｜ 超时作废' : '')
          + '   ');
      },
    });
    const st = res.stats;
    console.log('');
    console.log((res.aborted ? '作废：' : '完成：')
      + '去重后 ' + st.stocks + ' 只股票 ｜ 读取新闻 ' + st.listed + ' 条 ｜ 带栏目前缀 ' + st.prefixed
      + ' 条 ｜ 命中目标栏目 ' + st.matched + ' 条 ｜ 抓到正文 ' + st.newText + ' 条 ｜ 失败 ' + st.errors
      + ' 只 ｜ 用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
    if (res.errors.length) {
      const byKind = {};
      res.errors.forEach(function (e) {
        const k = e.kind || 'other';
        (byKind[k] = byKind[k] || []).push(e);
      });
      console.log('[scan] ── 失败明细（每类最多 5 条）');
      Object.keys(byKind).sort().forEach(function (k) {
        byKind[k].slice(0, 5).forEach(function (e) {
          console.log('[scan]   [' + k + '] ' + e.code + ' ' + e.name + ' -> ' + e.error);
        });
        if (byKind[k].length > 5) {
          console.log('[scan]   [' + k + '] …另有 ' + (byKind[k].length - 5) + ' 条');
        }
      });
    }
    if (res.aborted) {
      console.log('[scan] 本轮作废：不推送、不写水位、不发布。下轮全量重抓后再对照未推送新闻。');
      process.exit(4);
    }
    console.log('');
  }

  const store = collectMod.loadStore();
  const rows = withPoolNames(collectMod.rows(store, { days: days, pool: (only && only !== true) ? String(only) : 'all' }), names);
  if (!process.argv.includes('--no-research')) {
    let lastResearchLog = 0;
    const rr = await research.enrichRows(rows, {
      config: cfg,
      onProgress: function (s) {
        const now = Date.now();
        if (now - lastResearchLog < 1500 && s.done < s.total) return;
        lastResearchLog = now;
        process.stdout.write('\r调研 ' + s.done + '/' + s.total + ' ｜ 缓存 ' + s.cached + ' ｜ 失败 ' + s.errors + '   ');
      },
    });
    if (rr.refreshed) console.log('');
    console.log('调研结论：股票 ' + rr.total + ' 只 ｜ 本轮更新 ' + rr.refreshed + ' ｜ 使用缓存 ' + rr.cached + ' ｜ 失败 ' + rr.errors);
  } else {
    research.attachRows(rows);
  }
  const meta = {
    title: '财联社 沪深A股(非ST) · 目标栏目新闻',
    range: rangeLabel(days),
    poolLabel: selected.map(function (p) { return p.name + '（' + p.count + ' 只）'; }).join(' / '),
    generatedAt: new Date().toLocaleString('zh-CN'),
  };
  const out = report.exportAll(rows, meta, {
    fileBase: 'cls-news',
    layout: 'table',
    // Pages 上主页面是表格版，附带一个「卡片版」子页面；本地导出不加互跳链接，避免 file:// 打开时链接失效
    links: siteLinks() ? [{ href: 'cards/', label: '卡片版' }] : [],
    alsoCards: true,
    cardsLinks: siteLinks() ? [{ href: '../', label: '表格版' }] : [],
  });
  console.log('表格共 ' + rows.length + ' 条，已导出：');
  console.log('  ' + out.csvPath);
  console.log('  ' + out.htmlPath);
  console.log('  ' + out.jsonPath);
  if (out.cardsPath) console.log('  ' + out.cardsPath + '  （卡片版）');

  // 发布状态（供 Pages / 外部对照；不再用于本仓库定时差集门控）
  const nowMs = Date.now();
  const statusPath = path.join(report.OUT_DIR, 'status.json');
  fs.writeFileSync(statusPath, JSON.stringify({
    publishedAt: nowMs,
    publishedAtShanghai: cls.fmtTime(Math.floor(nowMs / 1000)),
    range: meta.range,
    poolLabel: meta.poolLabel,
    days: days,
    rows: rows.length,
    // 本轮 VIP 有效 id；未拉取到时保留上一轮，避免回退为空
    lastVipIds: curVipIds.length ? curVipIds : (function () {
      try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')).lastVipIds || []; }
      catch (_) { return []; }
    })(),
  }, null, 2), 'utf8');
  console.log('  ' + statusPath + '  （发布状态）');

  // 企业微信推送开关：config.notify.enabled=false 或 --no-push 时关闭；--dry-run-push 只打印不发。
  const notifyEnabled = !cfg.notify || cfg.notify.enabled !== false;
  console.log('[minimax] cli before notify enabled=' + notifyEnabled +
    ' noPush=' + process.argv.includes('--no-push') +
    ' rows=' + rows.length);
  if (notifyEnabled && !process.argv.includes('--no-push')) {
    await notify.pushNew(rows, {
      config: cfg,
      dryRun: process.argv.includes('--dry-run-push'),
    });
  } else {
    console.log('[minimax] cli skip notify (disabled or --no-push)');
    console.log('  微信推送已关闭（config.notify.enabled=false 或 --no-push）');
  }
})().catch(function (e) { console.error('运行失败:', e); process.exit(1); });
