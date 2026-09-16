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
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const EVIDENCE_MAX_CHARS = 12000;
const RETRIABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const PROMPT_TEMPLATE = `你是一名A股短线投研助理。推送行已带「公司名(代码)-」，你只写破折号后的**一句话**，不要再写公司名/代码。

核心目标：让人一眼看懂——它凭什么特殊、为什么现在和这个热点有关、关联有多真。
公式：**独特标签 + 当前热点标签 + 硬连接/受益路径 + 验证点或边界**。
禁止「AI+教育」「机器人+新能源」这类概念拼接；删掉热点词后公司仍应有特色，删掉公司名后不能套到任意题材股。

## 写作前请联网检索核实（逐只）
1. 公司层：主营/收入构成、核心产品、客户、产能、技术、市占、资质；找出唯一性（少数/唯一/龙头/首家/独家供应/隐形冠军/转型卡位等）。
2. 热点层：结合本条 VIP，只提炼 1—2 个最相关热点词（政策/产业事件/订单/涨价/国产替代等），不要堆砌。
3. 连接层：热点与公司如何连？直接收入/订单/客户，还是参股/试点/概念？尽量用可检索事实（订单、产能、客户名、收入占比、公告进度）。无硬证据只能写「概念关联」。

## 句式（100 字以内，四要素尽量齐全；优先写清，勿注水）
优先模板：「【独特标签】+【热点标签】+【受益路径】+【验证点/边界】」
可套用：稀缺卡位型 / 订单催化型 / 转型重估型 / 卖铲人型。
有可核实数据时尽量点出（客户/收入占比/订单或产能量级/公告进度），仍须控制在 100 字内。
边界词必用其一（当连接不硬时更要写）：直接/间接、参股、小批量、试点、占比低、尚在验证、暂无正式订单、概念关联。
禁止：复述标题、编造未检索到的市占/客户/订单、把蹭概念写成核心受益、只写热点不写特色、空话注水凑字数。

## 新闻标题
{title}

## 新闻摘要
{brief}

## 涉及个股（代码 名称）——请逐只联网检索后再写
{stock_lines}

## 输出要求
联网检索并归纳后，只输出**一个** JSON 代码块，键为 6 位股票代码，值为该股一句话。
下方仅为**格式示意**，内容不得复用、不得照抄：
\`\`\`json
{"000001": "<按四要素填写，不少于 30 字，不超过 100 字>"}
\`\`\`
不要输出 JSON 以外的任何内容。`;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function sanitize(s, maxLen) {
  maxLen = maxLen == null ? 2000 : maxLen;
  return String(s == null ? '' : s)
    .replace(/```/g, '')
    .replace(/<\/?(?:system|user|assistant|think|thinking)\w*>/gi, '')
    .replace(/===[^=]{0,40}===/g, '')
    .slice(0, maxLen);
}

function loadCfg(config) {
  const n = (config && config.notify && config.notify.minimax) || {};
  const apiKey = process.env.MINIMAX_API_KEY || n.api_key || n.apiKey || '';
  const maxTok = Number(n.max_output_tokens || n.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS);
  return {
    enabled: n.enabled !== false,
    apiKey: String(apiKey || '').trim(),
    model: n.model || DEFAULT_MODEL,
    baseUrl: String(n.base_url || n.baseUrl || DEFAULT_BASE).replace(/\/$/, ''),
    // 联网搜索更慢，默认 180s
    timeout: Math.max(30, Number(n.timeout) || 180) * 1000,
    webSearch: n.web_search !== false && n.webSearch !== false,
    maxOutputTokens: Number.isFinite(maxTok) && maxTok > 0 ? maxTok : DEFAULT_MAX_OUTPUT_TOKENS,
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

/** 多 fence 时优先取靠近文末的块，避免抄到 prompt 里的格式示例 */
function extractJson(text) {
  text = stripThink(text);
  if (!text) return null;
  const fences = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/gi) || [];
  for (let i = fences.length - 1; i >= 0; i--) {
    const inner = fences[i]
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!inner.startsWith('{') || !inner.endsWith('}')) continue;
    try { return JSON.parse(inner); } catch (_) { /* try earlier */ }
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

/** 收集首轮检索证据：去重 + 按单元截断，供第二轮不联网收尾 */
function extractResponsesEvidence(data) {
  const seen = new Set();
  const out = [];

  function pushUnique(key, text) {
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  }

  for (const item of (data && data.output) || []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'web_search_call') {
      const action = item.action || {};
      const qs = []
        .concat(action.query || [], action.queries || [])
        .filter(Boolean);
      for (const q of qs) pushUnique('q:' + q, '[搜索] ' + q);
    } else if (item.type === 'message') {
      for (const block of item.content || []) {
        if (!block || typeof block !== 'object') continue;
        if ((block.type === 'output_text' || block.type === 'text') && block.text) {
          const t = String(block.text).trim();
          pushUnique('t:' + t.slice(0, 80), t);
        }
        for (const ann of block.annotations || []) {
          if (!ann || ann.type !== 'url_citation') continue;
          const cite = [ann.title, ann.url].filter(Boolean).join(' ');
          const key = 'c:' + (ann.url || cite);
          if (!cite && !ann.content) continue;
          const body = cite + (ann.content ? '\n' + String(ann.content).slice(0, 800) : '');
          pushUnique(key, '[来源] ' + body.trim());
        }
      }
    }
  }

  let len = 0;
  const truncated = [];
  for (const p of out) {
    if (len + p.length + 2 > EVIDENCE_MAX_CHARS) break;
    truncated.push(p);
    len += p.length + 2;
  }
  return truncated.join('\n\n');
}

function countWebSearchCalls(data) {
  let n = 0;
  for (const item of (data && data.output) || []) {
    if (item && item.type === 'web_search_call') n++;
  }
  return n;
}

function assertOk(data) {
  if (data && data.error) {
    throw new Error('API error: ' + JSON.stringify(data.error).slice(0, 300));
  }
  const br = data && data.base_resp;
  if (br && Number(br.status_code) !== 0) {
    throw new Error('业务错误 base_resp=' + JSON.stringify(br).slice(0, 300));
  }
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

function buildResponsesPayload(cfg, prompt, webSearch, maxOutputTokens) {
  const payload = {
    model: cfg.model,
    input: prompt,
    max_output_tokens: maxOutputTokens != null ? maxOutputTokens : cfg.maxOutputTokens,
  };
  if (webSearch) {
    payload.tools = [{ type: 'web_search' }];
    payload.tool_choice = { type: 'web_search' };
  }
  return payload;
}

async function callWithRetry(cfg, payload, retries) {
  retries = retries == null ? 2 : retries;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const data = await httpPostJson(
        cfg.baseUrl + '/responses',
        { Authorization: 'Bearer ' + cfg.apiKey },
        payload,
        cfg.timeout
      );
      assertOk(data);
      return data;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const m = msg.match(/HTTP (\d+)/);
      const code = m ? Number(m[1]) : 0;
      const retriable = (code && RETRIABLE_HTTP.has(code))
        || /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg);
      if (!retriable || i === retries) break;
      const delay = 1000 * Math.pow(2, i) + Math.random() * 400;
      console.warn('[minimax] ' + msg.slice(0, 80) + ' → ' + Math.floor(delay) + 'ms 后重试 ' + (i + 1) + '/' + retries);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function callResponses(cfg, prompt, webSearch, maxOutputTokens) {
  return callWithRetry(cfg, buildResponsesPayload(cfg, prompt, webSearch, maxOutputTokens));
}

/** 收尾轮：只发精简指令 + 证据，不再复用首轮全文 prompt */
function buildFinalizePrompt(stocks, evidence) {
  const codes = (stocks || [])
    .filter(function (s) { return s && s.code; })
    .map(function (s) {
      return pureCode(s.code) + (s.name ? ' ' + sanitize(s.name, 60) : '');
    })
    .join('\n');
  return [
    '现在请基于下方「已联网检索得到的资料」，为以下每只 A 股各写一句 100 字内的描述。',
    '严格遵守四要素：独特标签 + 当前热点标签 + 硬连接/受益路径 + 验证点或边界。',
    '若证据不足，宁可写「概念关联/暂无正式订单」等边界词，不得编造客户/订单/市占。',
    '只输出一个 JSON 代码块，键为 6 位股票代码；下方仅为格式示意，内容不得复用：',
    '```json',
    '{"000001": "<按四要素填写>"}',
    '```',
    '',
    '## 涉及个股',
    codes,
    '',
    '## 已联网检索资料（请据此填写，禁止二次检索）',
    evidence || '（无可用资料，按「概念关联」处理）',
  ].join('\n');
}

/**
 * @param {string} text
 * @param {Set<string>|null} allowCodes 若给定，只保留请求标的代码
 */
function notesFromText(text, allowCodes) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const code = pureCode(k);
    if (!code || typeof v !== 'string' || !v.trim()) continue;
    if (allowCodes && !allowCodes.has(code)) continue;
    out[code] = v.trim();
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

  const allowCodes = new Set();
  const stockLines = stocks
    .filter(function (s) { return s && s.code; })
    .map(function (s) {
      const code = pureCode(s.code);
      if (code) allowCodes.add(code);
      return code + ' ' + sanitize(s.name, 60);
    })
    .join('\n');

  const prompt = PROMPT_TEMPLATE
    .replace('{title}', sanitize(title, 2000))
    .replace('{brief}', sanitize(brief, 4000))
    .replace('{stock_lines}', stockLines);

  const useSearch = cfg.webSearch;
  console.log(
    '[minimax] 开始推理(responses' + (useSearch ? '+web_search强制' : '') + ')：stocks=' +
    stocks.length + ' keyLen=' + cfg.apiKey.length + ' model=' + cfg.model +
    ' timeoutMs=' + cfg.timeout + ' maxOut=' + cfg.maxOutputTokens
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
  let notes = notesFromText(text, allowCodes);

  if (!notes && useSearch) {
    console.log('[minimax] 首轮未产出 JSON，发起收尾调用（不联网，精简指令+检索证据）');
    const evidence = extractResponsesEvidence(data) || text || '（无额外资料）';
    const finalizePrompt = buildFinalizePrompt(stocks, evidence);
    try {
      const data2 = await callResponses(cfg, finalizePrompt, false, cfg.maxOutputTokens);
      text = extractResponsesText(data2) || text;
      notes = notesFromText(text, allowCodes);
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
  sanitize: sanitize,
  extractJson: extractJson,
  extractResponsesText: extractResponsesText,
  extractResponsesEvidence: extractResponsesEvidence,
  notesFromText: notesFromText,
  generateStockNotes: generateStockNotes,
};
