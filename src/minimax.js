'use strict';

/**
 * MiniMax 为一篇新闻的目标标的生成「一句话描述」。
 * 仅供 dashboard（GitHub Actions）推送链路使用；零 npm 依赖。
 *
 * 必须走 Responses API：POST {base_url}/responses
 *   + tools: [{type: web_search}]
 *   + tool_choice 强制先联网检索，再写「可核实特色+热点+硬连接+边界」。
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

/** 模型偶发把句型标签写进正文，推送前剥离 */
const STYLE_PREFIX_RE = /^(?:稀缺卡位型|订单催化型|转型重估型|卖铲人型)[，,：:\s]*/;
/** 强词告警（不自动作废，便于日志复查） */
const STRONG_CLAIM_RE = /独家|唯一|首家|市占第一|超九成|全球仅有|业绩弹性直接|量价齐升|(?:6G|5G-A).{0,12}(?:直接供货|批量供货|量产)/;

const PROMPT_TEMPLATE = `你是一名A股短线投研助理。推送行已带「公司名(代码)-」，你只写破折号后的**一句话**，不要再写公司名/代码。

核心目标：让人一眼看懂——它凭什么特殊、为什么现在和这个热点有关、关联有多真。
公式：**可核实特色 + 当前热点标签 + 硬连接/受益路径 + 验证点或边界**。
禁止「AI+教育」「机器人+新能源」这类概念拼接；删掉热点词后公司仍应有特色，删掉公司名后不能套到任意题材股。
篇幅优先服务「本条新闻为什么现在看它」，不要把一句话写成旧年报摘录。

## 写作前请联网检索核实（逐只，按此顺序）
1. 本条 VIP：涨价/订单/政策/评级等与该股最相关的增量与进度。
2. 公司最新已披露材料：优先最近一份年报或半年报（及之后的公告/互动易）；再补主营/产品/客户等特色。
3. 热点层：结合本条 VIP，只提炼 1—2 个最相关热点词，不要堆砌。
4. 连接硬度：先判断本条新闻对该股是「直接订单 / 客户验证 / 技术储备·预研 / 纯主题提及」哪一档；**一句话语气不得超过该硬度**（本条若写储备/探索，不得升格为量产供货或业绩弹性直接）。
5. 连接层：尽量用可检索事实。无硬证据只能写「概念关联」。

## 进度用词（必须遵守）
- 技术储备/预研/跟踪 → 写「预研储备、跟踪标准」；禁止写「6G器件直接供货、6G量产」。
- 样品/小批量/试点 → 写「样品验证、试点」；禁止写「核心受益、业绩弹性直接」。
- 批量供货/中标/收入确认 → 才可写「直接供货、订单落地」。

## 数字与报告期（必须遵守）
- 收入、市占、件量、成本、订单金额、产能利用率等经营数字：必须有年报/半年报/公告/互动易依据，并**写明报告期**（如「2025年」「2026H1」）。
- **优先最新已披露报告期**；当前日历年已过半年时，禁止把两年前的全年年报数字当作主句锚点（例如已是 2026 下半年仍主写裸「2024年××亿」）。
- 一句话里经营数字**最多 1 个**；其余篇幅留给热点标签 + 与本条 VIP 的连接/边界。无可靠新数字时，宁可不写数字，改写业务卡位。
- 「独家/唯一/首家/市占第一/全球仅有」：无原文依据禁止使用；可改用「滤波器龙头之一」「主设备商供应商」等可核表述。

## 句式（100 字以内；优先写清，勿注水）
直接写业务内容：特色 + 热点 + 路径 + 边界。
可在内心组织叙事，但**正文不得出现**「稀缺卡位型」「订单催化型」「转型重估型」「卖铲人型」等类型名，也不要以类型名开头。
验证点只能来自本条 VIP 已写明的进度，或检索到的公告/财报节点；没有就写边界（预研阶段、贡献尚早、概念关联偏强、取决于运营商资本开支等）。
禁止：复述标题、编造未检索到的市占/客户/订单/占比、把蹭概念写成核心受益、空话注水凑字数、堆砌过时财报数字。

## 新闻标题
{title}

## 新闻摘要
{brief}

## 涉及个股（代码 名称）——请逐只联网检索后再写
{stock_lines}

## 输出要求
联网检索并归纳后，只输出**一个** JSON 代码块，键为 6 位股票代码，值为该股一句话。
下方仅为**格式示意**，内容不得复用、不得照抄；第一句直接写业务特色：
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

/** 剥句型标签前缀；强词/过旧报告期仅告警不丢弃 */
function bjYearNow() {
  return Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(new Date()));
}

function warnStaleFiscalYears(code, text) {
  const nowY = bjYearNow();
  const staleBefore = nowY - 1; // 例如 2026 年仍主写 2024 及更早 → 告警
  const re = /((?:19|20)\d{2})\s*年/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(text)) !== null) {
    const y = Number(m[1]);
    if (!Number.isFinite(y) || seen.has(y)) continue;
    seen.add(y);
    if (y < staleBefore) {
      console.warn('[minimax] 过旧报告期告警 code=' + code + ' year=' + y +
        ' note=' + text.slice(0, 80));
    }
  }
}

function polishNote(code, raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  const stripped = text.replace(STYLE_PREFIX_RE, '').trim();
  if (stripped !== text) {
    console.warn('[minimax] 已剥离句型标签前缀 code=' + code + ' → ' + stripped.slice(0, 40));
    text = stripped;
  }
  if (STRONG_CLAIM_RE.test(text)) {
    console.warn('[minimax] 强词告警 code=' + code + ' note=' + text.slice(0, 80));
  }
  warnStaleFiscalYears(code, text);
  return text;
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

/** 收尾轮：精简指令 + 证据，规则与首轮一致 */
function buildFinalizePrompt(stocks, evidence) {
  const codes = (stocks || [])
    .filter(function (s) { return s && s.code; })
    .map(function (s) {
      return pureCode(s.code) + (s.name ? ' ' + sanitize(s.name, 60) : '');
    })
    .join('\n');
  return [
    '现在请基于下方「已联网检索得到的资料」，为以下每只 A 股各写一句 100 字内的描述。',
    '公式：可核实特色 + 热点 + 硬连接/路径 + 验证点或边界。',
    '语气不得超过本条新闻连接硬度；储备/预研不得写成量产供货或业绩弹性直接。',
    '无出处禁止写收入占比/市占/产能利用率等数字；禁止独家/唯一等无依据绝对化。',
    '正文不得出现「稀缺卡位型」等句型类型名；第一句直接写业务特色。',
    '若证据不足，写「概念关联/预研阶段/贡献尚早」等边界词，不得编造。',
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
    const polished = polishNote(code, v);
    if (polished) out[code] = polished;
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
  polishNote: polishNote,
  extractJson: extractJson,
  extractResponsesText: extractResponsesText,
  extractResponsesEvidence: extractResponsesEvidence,
  notesFromText: notesFromText,
  generateStockNotes: generateStockNotes,
};
