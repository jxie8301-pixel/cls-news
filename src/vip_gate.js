'use strict';

/**
 * VIP 差集门控 —— 水位只认 Cloudflare D1（共享）。
 * 分片数 / matrix 由各仓流水线自行控制，与本模块无关。
 *
 * 环境变量：
 *   D1_API_BASE / D1_WRITE_TOKEN  （写权限 token 亦可读 vip-gate）
 */

const cls = require('./cls.js');
const { loadConfig } = require('./config.js');
const d1 = require('./d1_client.js');

const SKIP_TITLE_KWS = ['玩转ETF'];

/**
 * @returns {Promise<string[]>}
 */
async function loadLastVipIds() {
  if (!process.env.D1_WRITE_TOKEN) {
    throw new Error('VIP 门控需要 D1_WRITE_TOKEN（水位只存 D1，不再读 GitHub status.json）');
  }
  const g = await d1.getVipGate();
  const ids = Array.isArray(g.lastVipIds) ? g.lastVipIds.map(String) : [];
  console.log('[vip] 水位 ← D1 count=' + ids.length + ' by=' + (g.updatedBy || '?'));
  return ids;
}

function eligibleVipItems(items) {
  return (items || []).filter(function (it) {
    if (!cls.vipHasStock(it)) return false;
    const title = String(it.title || '');
    if (SKIP_TITLE_KWS.some(function (kw) { return title.indexOf(kw) !== -1; })) return false;
    return true;
  });
}

/**
 * @returns {Promise<{
 *   shouldRun: boolean,
 *   vipTotal: number,
 *   eligible: number,
 *   newCount: number,
 *   newIds: string[],
 *   lastCount: number,
 *   curIds: string[],
 * }>}
 */
async function checkVipGate(opts) {
  opts = opts || {};
  loadConfig(); // 确保 config 侧载入；门控本身不读 statusUrl
  const force = !!opts.force || !!opts.noGate;
  const assumeNewVip = !!opts.assumeNewVip;

  let lastIds = [];
  try {
    lastIds = await loadLastVipIds();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (force || assumeNewVip) {
      console.warn('[vip] D1 水位不可用，force/assume 下视为空水位: ' + msg);
      lastIds = [];
    } else {
      throw e;
    }
  }

  let items;
  try {
    if (assumeNewVip) {
      items = await cls.fetchVipArticles({ preferFallback: true, timeout: 15000 });
    } else {
      items = await cls.fetchVipArticles({});
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (assumeNewVip || force) {
      console.warn('[vip] 拉取 VIP 失败，外部已判定有新 VIP / --force，软继续: ' + msg);
      return {
        shouldRun: true,
        forced: force,
        assumeNewVip: true,
        fetchError: msg,
        vipTotal: 0,
        eligible: 0,
        newCount: 0,
        newIds: [],
        lastCount: lastIds.length,
        curIds: [],
        sampleTitles: [],
      };
    }
    throw e;
  }

  const eligible = eligibleVipItems(items);
  const curIds = eligible.map(function (it) { return String(it.id); });

  const lastSet = new Set(lastIds);
  const newIds = curIds.filter(function (id) { return !lastSet.has(id); });
  const shouldRun = force || assumeNewVip || newIds.length > 0;

  return {
    shouldRun: shouldRun,
    forced: force,
    assumeNewVip: assumeNewVip,
    vipTotal: items.length,
    eligible: eligible.length,
    newCount: newIds.length,
    newIds: newIds,
    lastCount: lastIds.length,
    curIds: curIds,
    sampleTitles: eligible
      .filter(function (it) { return newIds.indexOf(String(it.id)) >= 0; })
      .slice(0, 5)
      .map(function (it) {
        return { id: String(it.id), title: String(it.title || '').slice(0, 80) };
      }),
  };
}

module.exports = {
  checkVipGate,
  eligibleVipItems,
  loadLastVipIds,
};
