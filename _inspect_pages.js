'use strict';
const fs = require('fs');
const p = process.argv[2];
const h = fs.readFileSync(p, 'utf8');
console.log('页面字节: ' + h.length);
console.log('标题: ' + ((h.match(/<h1>([^<]*)<\/h1>/) || [])[1] || '').trim());
const meta = (h.match(/<div class="meta">([\s\S]*?)<\/div>/) || [])[1];
console.log('页头信息: ' + String(meta || '').replace(/<[^>]+>/g, '').trim());
const th = [...h.matchAll(/<th>([^<]*)<\/th>/g)].map(function (m) { return m[1]; });
console.log('列头(' + th.length + '): ' + th.join(' | '));
console.log('tbody 行数: ' + [...h.matchAll(/<tr>/g)].length + ' (含表头 1 行)');
const links = [...h.matchAll(/<a href="([^"]+)"/g)].map(function (m) { return m[1]; });
console.log('链接数: ' + links.length);
console.log('链接示例: ' + (links[0] || '无'));
const hosts = {};
for (const l of links) { let hh = '?'; try { hh = new URL(l).host; } catch (e) {} hosts[hh] = (hosts[hh] || 0) + 1; }
console.log('链接域名: ' + JSON.stringify(hosts));
console.log('移动端媒体查询: ' + h.includes('@media (max-width:760px)'));
console.log('是否有搜索/筛选控件: ' + /<input|<select|<button/.test(h));
console.log('是否有脚本: ' + /<script/.test(h));
const row = (h.match(/<tbody>\s*<tr>([\s\S]*?)<\/tr>/) || [])[1];
console.log('首行 HTML 片段: ' + String(row || '').replace(/\s+/g, ' ').slice(0, 420));

