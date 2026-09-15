'use strict';

/**
 * MiniMax 为一篇新闻的目标标的生成「一句话描述」。
 * 仅供 dashboard（GitHub Actions）推送链路使用；零 npm 依赖。
 *
 * 必须走 Responses API：POST {base_url}/responses
 *   + tools: [{type: web_search}]
 *   + tool_choice 强制先联网检索，再写「独特标签+热点+硬连接+边界」。
 * /chat/completions 无托管联网，旧实现不会搜索。
 *
 * 失败/未配置时返回 {}，由 notify 回退到 research 题材描述。
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_BASE = 'https://api.minimaxi.com/v1';

const PROMPT_TEMPLATE = `你是一名A股短线投研助理。推送行已带「公司名(代码)-」，你只写破折号后的**一句话**，不要再写公司名/代码。

核心目标：让人一眼看懂——它凭什么特殊、为什么现在和这个热点有关、关联有多真。
公式：**独特标签 + 当前热点标签 + 硬连接/受益路径 + 验证点或边界**。
禁止「AI+教育」「机器人+新能源」这类概念拼接；删掉热点词后公司仍应有特色，删掉公司名后不能套到任意题材股。

## 写作前请联网检索核实（逐只）
1. 公司层：主营/收入构成、核心产品、客户、产能、技术、市占、资质；找出唯一性（少数/唯一/龙头/首家/独家供应/隐形冠军/转型卡位等）。
2. 热点层：结合本条 VIP，只提炼 1—2 个最相关热点词（政策/产业事件/订单/涨价/国产替代等），不要堆砌。
3. 连接层：热点与公司如何连？直接收入/订单/客户，还是参股/试点/概念？尽量用可检索事实（订单、产能、客户名、收入占比、公告进度）。无硬证据只能写「概念关联」。

## 句式（约 50—60 字，四要素尽量齐全；信息不够可略压缩，但不可空泛）
优先短模板：「【独特标签】+【热点标签】+【受益路径】+【验证点/边界】」
可套用：稀缺卡位型 / 订单催化型 / 转型重估型 / 卖铲人型。
边界词必用其一（当连接不硬时更要写）：直接/间接、参股、小批量、试点、占比低、尚在验证、暂无正式订单、概念关联。
禁止：复述标题、编造未检索到的市占/客户/订单、把蹭概念写成核心受益、只写热点不写特色。

## 新闻标题
{title}

## 新闻摘要
{brief}

## 涉及个股（代码 名称）——请逐只联网检索后再写
{stock_lines}

## 输出要求
检索并归纳后，只输出一个 JSON 代码块，键为6位股票代码，值为该股一句话，例如：
\`\`\`json
{"603270": "精密冲压切液冷板/柔轮初坯，卡位算力散热与机器人，样品验证阶段、新建产能暂无正式订单", "002491": "光棒—光纤—光缆一体化，对接万兆光网与机构净买入，关键看运营商集采与光棒扩产落地"}
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
