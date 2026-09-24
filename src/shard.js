'use strict';

/**
 * 按 code 字典序均分为 shards 片；shard 为 0..shards-1。
 * 各片数量差不超过 1，便于 matrix 对照。
 */
function assignShard(stocks, shard, shards) {
  const n = Math.max(1, Number(shards) || 1);
  const i = Number(shard);
  if (!Number.isFinite(i) || i < 0 || i >= n) {
    throw new Error('invalid shard ' + shard + ' / ' + n);
  }
  const sorted = stocks.slice().sort(function (a, b) {
    return String(a.code).localeCompare(String(b.code));
  });
  const out = [];
  for (let k = 0; k < sorted.length; k++) {
    if (k % n === i) out.push(sorted[k]);
  }
  return out;
}

module.exports = { assignShard };
