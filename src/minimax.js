'use strict';

/**
 * MiniMax 为一篇新闻的目标标的生成「一句话描述」。
 * 仅供 dashboard（GitHub Actions）推送链路使用；零 npm 依赖。
 * 走 OpenAI 兼容：POST {base_url}/chat/completions
 * 失败/未配置时返回 {}，由 notify 回退到 research 题材描述。
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_BASE = 'https://api.minimaxi.com/v1';

const PROMPT_TEMPLATE = `你是一名A股投研助理。下面是一条财联社 VIP 新闻，以及该新闻涉及的若干只A股个股。
请为每只个股写一句话描述，说明「公司主业/产品特点 + 与本条新闻的匹配点」，每条不超过40字，简洁精准，不要编造。

## 新闻标题
{title}

## 新闻摘要
{brief}

## 涉及个股（代码 名称）
{stock_lines}

## 输出要求
只输出一个 JSON 代码块，键为6位股票代码，值为该股的一句话描述，例如：
\`\`\`json
{"601208": "覆铜板用特种树脂主力，对接 AI 算力材料升级", "605589": "电子级酚醛/环氧树脂供应商，受益覆铜板迭代"}
\`\`\`
不要输出 JSON 以外的任何内容。`;

function loadCfg(config) {
  const n = (config && config.notify && config.notify.minimax) || {};
  const apiKey = process.env.MINIMAX_API_KEY || n.api_key || n.apiKey || '';
  return {
    enabled: n.enabled !== false,
    apiKey: String(apiKey || '').trim(),
    model: n.model || DEFAULT_MODEL,
    baseUrl: String(n.base_url || n.baseUrl || DEFAULT_BASE).replace(/\/$/, ''),
    timeout: Math.max(10, Number(n.timeout) || 60) * 1000,
  };
}

function pureCode(code) {
  return String(code || '').replace(/^[a-zA-Z]+/, '');
}

function stripThink(text) {
  // MiniMax-M3 常在 content 前带 <think>…</think>，干扰 JSON 截取
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function extractJson(text) {
  text = stripThink(text);
  if (!text) return null;
  const fences = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/gi) || [];
  for (const block of fences) {
    const inner = block.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      try { return JSON.parse(inner); } catch (_) { /* continue */ }
    }
  }
  // 从后往前找最后一个完整 JSON 对象，避免思考正文里的 { } 干扰
  const j = text.lastIndexOf('}');
  if (j === -1) return null;
  let depth = 0;
  for (let i = j; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(i, j + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function extractChatText(data) {
  if (!data || typeof data !== 'object') return '';
  const c0 = data.choices && data.choices[0];
  if (c0) {
    if (c0.message && typeof c0.message.content === 'string') return c0.message.content;
    if (typeof c0.text === 'string') return c0.text;
  }
  if (typeof data.reply === 'string') return data.reply;
  if (data.output_text) return String(data.output_text);
  return '';
}

function httpPostJson(urlStr, headers, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        }, headers),
        timeout: timeoutMs,
      },
      function (res) {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
            return;
          }
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (e) {
            reject(new Error('响应非 JSON: ' + data.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('MiniMax 调用超时 (' + timeoutMs + 'ms)'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * @returns {Promise<Record<string,string>>} {纯数字代码: 一句话}
 */
async function generateStockNotes(title, brief, stocks, config) {
  const cfg = loadCfg(config);
  if (!cfg.enabled) {
    console.log('  [minimax] 未启用，跳过');
    return {};
  }
  if (!cfg.apiKey) {
    console.log('  [minimax] 未配置 MINIMAX_API_KEY / notify.minimax.api_key，跳过');
    return {};
  }
  if (!stocks || !stocks.length) return {};

  const stockLines = stocks
    .filter(function (s) { return s && s.code; })
    .map(function (s) { return pureCode(s.code) + ' ' + (s.name || ''); })
    .join('\n');

  const prompt = PROMPT_TEMPLATE
    .replace('{title}', title || '')
    .replace('{brief}', brief || '')
    .replace('{stock_lines}', stockLines);

  let data;
  try {
    data = await httpPostJson(
      cfg.baseUrl + '/chat/completions',
      { Authorization: 'Bearer ' + cfg.apiKey },
      {
        model: cfg.model,
        messages: [
          { role: 'system', content: '你是一名专业的A股投资研究员，严格按用户要求输出 JSON。' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        temperature: 0.2,
      },
      cfg.timeout
    );
  } catch (e) {
    console.error('  [minimax] 调用失败: ' + (e && e.message ? e.message : e));
    return {};
  }

  const text = extractChatText(data);
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') {
    console.error('  [minimax] 回复无法解析为 JSON，前120字: ' + String(text || '').slice(0, 120));
    return {};
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const code = pureCode(k);
    if (code && typeof v === 'string' && v.trim()) out[code] = v.trim();
  }
  console.log('  [minimax] 一句话描述生成成功：' + Object.keys(out).length + ' 条');
  return out;
}

module.exports = {
  loadCfg: loadCfg,
  pureCode: pureCode,
  extractJson: extractJson,
  generateStockNotes: generateStockNotes,
};
