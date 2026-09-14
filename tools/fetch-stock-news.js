'use strict';

/**
 * 个股新闻抓取测试脚本（复用 src/cls.js 的接口与签名）。
 *
 * 底层接口：GET https://www.cls.cn/es/quotes/articles
 *   参数：keyword=<股票代码> & lastTime=<秒级时间戳> & rn=<每页条数>
 *   签名：sign = md5( sha1( 按 key 排序后的 querystring ) )（见 src/cls.js）
 *
 * 用法（在 dashboard 目录下运行）：
 *   node tools/fetch-stock-news.js 688519            # 默认回溯 7 天
 *   node tools/fetch-stock-news.js sz300750 --days 3 # 指定回溯天数
 *   node tools/fetch-stock-news.js 688519 --raw      # 打印每条的原始字段(含关联股票 quotes_info)
 *
 * 代码可带或不带市场前缀：688519 会自动补成 sh688519 / sz688519 猜测；
 * 建议直接传带前缀的代码（sh600000 / sz300750 / bj830799）最准确。
 */

const cls = require('../src/cls.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

// 根据 6 位数字推断市场前缀（沪 6/68/9 -> sh，其余 -> sz；北交所需自行带 bj）
function guessPrefixed(code) {
  const c = String(code).trim();
  if (/^(sh|sz|bj)\d{6}$/i.test(c)) return c.toLowerCase();
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('6') || c.startsWith('9')) return 'sh' + c;
    if (c.startsWith('8') || c.startsWith('4')) return 'bj' + c;
    return 'sz' + c;
  }
  return c;
}

(async () => {
  const rawCode = process.argv[2];
  if (!rawCode || rawCode.startsWith('--')) {
    console.error('用法: node tools/fetch-stock-news.js <股票代码> [--days N] [--raw]');
    console.error('示例: node tools/fetch-stock-news.js 688519 --days 7');
    process.exit(1);
  }

  const code = guessPrefixed(rawCode);
  const days = parseInt(arg('days', 7), 10) || 7;
  const showRaw = process.argv.includes('--raw');
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;

  console.log(`抓取个股新闻：${code} ｜ 回溯 ${days} 天`);
  console.log('接口: https://www.cls.cn/es/quotes/articles');
  console.log('='.repeat(70));

  let articles;
  try {
    articles = await cls.fetchStockArticles(code, { sinceSec });
  } catch (e) {
    console.error('抓取失败:', e && e.message ? e.message : e);
    process.exit(1);
  }

  console.log(`共 ${articles.length} 条（时间倒序）：\n`);

  // 按时间倒序
  articles.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));

  articles.forEach((it, i) => {
    const t = cls.fmtTime(it.ctime || 0);
    const prefix = cls.titlePrefix(it.title || '');
    const tag = prefix ? `【${prefix}】` : '';
    console.log(`[${i + 1}] ${t}  ${tag}${it.title || ''}`);
    console.log(`    id=${it.id}  链接: https://www.cls.cn/detail/${it.id}`);

    // 关联股票（财联社官方标注，即 pipeline 本地匹配依赖的 quotes_info）
    const qs = it.quotes_info || it.stock_list || [];
    if (Array.isArray(qs) && qs.length) {
      const names = qs.map((q) => `${q.name || q.secu_name || ''}(${q.code || q.secu_code || ''})`).join('、');
      console.log(`    关联股票: ${names}`);
    }
    if (it.brief) console.log(`    摘要: ${String(it.brief).slice(0, 80)}`);

    if (showRaw) {
      console.log('    原始字段: ' + JSON.stringify(it).slice(0, 500));
    }
    console.log('');
  });
})();
