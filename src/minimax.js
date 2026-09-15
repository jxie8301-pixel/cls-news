'use strict';

/**
 * MiniMax 为一篇新闻的目标标的生成「一句话描述」。
 * 仅供 dashboard（GitHub Actions）推送链路使用；零 npm 依赖。
 *
 * 必须走 Responses API：POST {base_url}/responses
 *   + tools: [{type: web_search}]
 *   + tool_choice 强制先联网检索，再总结特色/护城河/题材热点。
 * /chat/completions 无托管联网，旧实现不会搜索。
 *
 * 失败/未配置时返回 {}，由 notify 回退到 research 题材描述。
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_BASE = 'https://api.minimaxi.com/v1';

const PROMPT_TEMPLATE = `你是一名A股短线投研助理。请先对下列每只个股**联网搜索**核实：
主营/产品卡位、护城河或壁垒（客户/技术/产能/资质等，无把握写“壁垒一般”）、近期相关题材热点与公告要点。
再结合本条 VIP 新闻，为每只个股写**一句**描述。

句式要求（约 45 字内，三点都要点到，极短）：
「特色/卡位 + 护城河或壁垒 + 对接本条新闻/当下热点」
禁止只堆行业词、禁止复述标题、禁止编造未检索到的护城河。

## 新闻标题
{title}

## 新闻摘要
{brief}

## 涉及个股（代码 名称）——请逐只联网检索后再写
{stock_lines}

## 输出要求
检索并归纳后，只输出一个 JSON 代码块，键为6位股票代码，值为该股一句话，例如：
\`\`\`json
{"301189": "音视频终端切算力服务，交付/客户能力是壁垒，贴合Token工厂与算力通道主题", "300657": "FPC+算力硬件卡位，工厂落地形成先发，受益Token工厂景气"}
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
    // 联网搜索更慢，默认 180s
    timeout: Math.max(30, Number(n.timeout) || 180) * 1000,
    webSearch: n.web_search !== false && n.webSearch !== false,
    maxOutputTokens: Number(n.max_output_tokens || n.maxOutputTokens || 4096) || 4096,
  };
}

function pureCode(code) {
  return String(code || '').replace(/^[a-zA-Z]+/, '');
}

function stripThink(text) {
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
    const msg = c0.message || {};
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map(function (b) {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        if (b && typeof b.content === 'string') return b.content;
        return '';
      }).join('');
    }
    if (typeof c0.text === 'string') return c0.text;
  }
  if (typeof data.reply === 'string') return data.reply;
  return '';
}

/** 从 Responses API 响应提取最终文本 */
function extractResponsesText(data) {
  if (!data || typeof data !== 'object') return '';
  const ot = data.output_text;
  if (typeof ot === 'string' && ot.trim()) return ot.trim();
  if (Array.isArray(ot)) {
    const joined = ot.map(String).join('').trim();
    if (joined) return joined;
  }

  const parts = [];
  for (const item of data.output || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if (block && (block.type === 'output_text' || block.type === 'text') && block.text) {
          parts.push(block.text);
        }
      }
    } else if ((item.type === 'output_text' || item.type === 'text') && item.text) {
      parts.push(item.text);
    }
  }
  if (parts.length) return parts.join('').trim();

  const chat = extractChatText(data);
  if (chat) return chat;

  // 仅有 reasoning 时兜底
  const reasoning = [];
  for (const item of data.output || []) {
    if (item && item.type === 'reasoning') {
      for (const block of item.content || []) {
        if (block && block.type === 'reasoning_text' && block.text) reasoning.push(block.text);
      }
    }
  }
  return reasoning.join('').trim();
}

/** 收集首轮检索证据，供第二轮不联网收尾 */
function extractResponsesEvidence(data) {
  const parts = [];
  for (const item of (data && data.output) || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if (!block || typeof block !== 'object') continue;
        if ((block.type === 'output_text' || block.type === 'text') && block.text) {
          parts.push(String(block.text).trim());
        }
        for (const ann of block.annotations || []) {
          if (ann && ann.type === 'url_citation') {
            const cite = [ann.title, ann.url].filter(Boolean).join(' ');
            const content = String(ann.content || '').slice(0, 800);
            if (cite || content) parts.push('[来源] ' + (cite + (content ? '\n' + content : '')).trim());
          }
        }
      }
    } else if (item.type === 'web_search_call') {
      const action = item.action || {};
      if (action.query) parts.push('[搜索] ' + action.query);
      if (Array.isArray(action.queries) && action.queries.length) {
        parts.push('[搜索] ' + action.queries.filter(Boolean).join('；'));
      }
    }
  }
  return parts.filter(Boolean).join('\n\n').slice(0, 12000);
}

function countWebSearchCalls(data) {
  let n = 0;
  for (const item of (data && data.output) || []) {
    if (item && item.type === 'web_search_call') n++;
  }
  return n;
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

function buildResponsesPayload(cfg, prompt, webSearch) {
  const payload = {
    model: cfg.model,
    input: prompt,
    max_output_tokens: cfg.maxOutputTokens,
  };
  if (webSearch) {
    payload.tools = [{ type: 'web_search' }];
    payload.tool_choice = { type: 'web_search' };
  }
  return payload;
}

async function callResponses(cfg, prompt, webSearch) {
  const data = await httpPostJson(
    cfg.baseUrl + '/responses',
    { Authorization: 'Bearer ' + cfg.apiKey },
    buildResponsesPayload(cfg, prompt, webSearch),
    cfg.timeout
  );
  const br = data && data.base_resp;
  if (br && Number(br.status_code) !== 0) {
    throw new Error('业务错误 base_resp=' + JSON.stringify(br));
  }
  return data;
}

function notesFromText(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const code = pureCode(k);
    if (code && typeof v === 'string' && v.trim()) out[code] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @returns {Promise<Record<string,string>>} {纯数字代码: 一句话}
 */
async function generateStockNotes(title, brief, stocks, config) {
  const cfg = loadCfg(config);
  if (!cfg.enabled) {
    console.log('[minimax] 未启用（notify.minimax.enabled=false），跳过');
    return {};
  }
  if (!cfg.apiKey) {
    console.log('[minimax] 未配置 Key：请把 MINIMAX_API_KEY 配在 Repository secrets（build 读不到 Environment secrets）');
    return {};
  }
  if (!stocks || !stocks.length) {
    console.log('[minimax] 无标的列表，跳过');
    return {};
  }

  const stockLines = stocks
    .filter(function (s) { return s && s.code; })
    .map(function (s) { return pureCode(s.code) + ' ' + (s.name || ''); })
    .join('\n');

  const prompt = PROMPT_TEMPLATE
    .replace('{title}', title || '')
    .replace('{brief}', brief || '')
    .replace('{stock_lines}', stockLines);

  const useSearch = cfg.webSearch;
  console.log(
    '[minimax] 开始推理(responses' + (useSearch ? '+web_search强制' : '') + ')：stocks=' +
    stocks.length + ' keyLen=' + cfg.apiKey.length + ' model=' + cfg.model +
    ' timeoutMs=' + cfg.timeout
  );

  let data;
  try {
    data = await callResponses(cfg, prompt, useSearch);
  } catch (e) {
    console.error('[minimax] 调用失败: ' + (e && e.message ? e.message : e));
    return {};
  }

  const searchCalls = countWebSearchCalls(data);
  console.log('[minimax] 首轮完成 web_search_calls=' + searchCalls + ' status=' + (data.status || ''));

  let text = extractResponsesText(data);
  let notes = notesFromText(text);

  // 首轮只搜不写 JSON：回喂证据做不联网收尾（与本地 deepseek/minimax 质证策略一致）
  if (!notes && useSearch) {
    console.log('[minimax] 首轮未产出 JSON，发起收尾调用（不联网，回喂检索证据）');
    const evidence = extractResponsesEvidence(data) || text || '（无额外资料）';
    const finalizePrompt =
      prompt +
      '\n\n=== 你在上一轮联网检索中已获取的资料（请据此直接给出最终 JSON，无需再检索） ===\n' +
      evidence +
      '\n\n=== 现在请立即只输出最终 JSON 代码块 ===';
    try {
      const data2 = await callResponses(cfg, finalizePrompt, false);
      text = extractResponsesText(data2) || text;
      notes = notesFromText(text);
      console.log('[minimax] 收尾完成 web_search_calls=' + countWebSearchCalls(data2));
    } catch (e) {
      console.error('[minimax] 收尾调用失败: ' + (e && e.message ? e.message : e));
    }
  }

  if (!notes) {
    console.error('[minimax] 回复无法解析为有效 JSON，前200字: ' + String(text || '').slice(0, 200));
    return {};
  }

  console.log('[minimax] 一句话描述生成成功：' + Object.keys(notes).length + ' 条 → ' + Object.keys(notes).join(','));
  return notes;
}

module.exports = {
  loadCfg: loadCfg,
  pureCode: pureCode,
  extractJson: extractJson,
  extractResponsesText: extractResponsesText,
  generateStockNotes: generateStockNotes,
};
