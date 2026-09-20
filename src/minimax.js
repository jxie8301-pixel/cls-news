'use strict';

/**
 * MiniMax 为一篇新闻的目标标的生成「一句话描述」。
 * 仅供 dashboard（GitHub Actions）推送链路使用；零 npm 依赖。
 *
 * 必须走 Responses API：POST {base_url}/responses
 *   + tools: [{type: web_search}]
 *   + tool_choice 强制联网
 * 句式固定三截：身份 + 本条匹配 + 一到两个事实。
 * 事实必须是该股当下热点 / 当前主业 / 当前核心卡点，且最新仍有效。
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
/** 后处理：拦截「××年起累计/签订」类存量起笔（不在提示词里点名，以免诱发） */
const CUM_FROM_YEAR_RE = /((?:19|20)\d{2})\s*年(?:起|以来)(?:累计|合计|签订|已签|批产)/;

const PROMPT_TEMPLATE = `你是 A 股短线推送助理。推送行已有「公司名(代码)-」，你只写破折号后**一句话**（50–120 字），不要重复公司名/代码。

{asof_block}

## 任务
对每只股票按三截写成一句（可用分号或逗号衔接，仍算一句）：

1. **身份（必有）**：当前主业或平台定位，让人立刻认出是哪家。一文多股时必须能区分开。

2. **本条匹配（必有）**：它和本条新闻具体对上哪一点（产品/客户/环节）。不要复述整段标题。

3. **一到两个事实（必有，本句成败在此）**：必须同时满足下面全部条件——
   - **针对该股当下**：只允许写当前热点、当前主要业务、或当前核心卡点（产能/客户/在手订单/份额/管线进度/最新业绩兑现）
   - **最新且仍有效**：以本条新闻、下方近端资料、联网检索到的最近一期财报/公告/互动易为准；过期订单、已结束项目、边角业务、多年前经营史一律不用
   - 最多 2 个；宁缺一个合格事实，不要用旧故事凑数
   - 平台型累计数据（在手合作、在研管线）仅当检索显示它仍是**当前**核心卡点才可写，写成「目前/已累计」现状，不要写「某某年起」
   - 搜不到合格事实：只保留身份+本条匹配，并写「待验证」，禁止编造市占/订单/客户

## 检索（联网，逐只）
优先 query：「公司名 + 本条核心事件词」；再补「公司名 + 最新半年报/年报」。
只采信对该股此刻仍生效的公开信息。数字尽量带披露时点（本年×月公告、最新季报/半年报）。

## 禁止
- 用行业/概念标签堆砌冒充事实（如「锂电池、CRO、人工智能」）
- 复述标题凑字；与本条无关的历史故事
- 编造客户/订单/市占/独家
- 多段研报、双票对比、风险长文、尾部追问

## 本条新闻标题
{title}

## 本条新闻摘要
{brief}

## 个股（代码 名称；近端资料供挑选事实，不要照抄标签）
{stock_lines}

## 输出
只输出一个 JSON 代码块：键为 6 位代码，值为该股一句话。不要输出其它文字。
\`\`\`json
{"000001": "<身份；本条匹配；一到两个最新有效事实>"}
\`\`\`
`;

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

function researchOf(stock, cache) {
  if (!stock || !cache || !cache.stocks) return null;
  return cache.stocks[stock.code] || cache.stocks[pureCode(stock.code)] || null;
}

function pctBit(v, label) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  const num = Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(1);
  return label + (n > 0 ? '+' : '') + num + '%';
}

/** 拼进 prompt 的近端资料：最新财务 + 最近事项，供模型挑「仍有效」的事实。 */
function formatStockLine(stock, cache) {
  const code = pureCode(stock && stock.code);
  if (!code) return '';
  let line = code + (stock.name ? ' ' + sanitize(stock.name, 60) : '');
  const rec = researchOf(stock, cache);
  if (!rec || rec.errorOnly) return line;
  const bits = [];
  if (rec.industry) bits.push('主业口径:' + sanitize(rec.industry, 40));
  const f = rec.financial || {};
  const fin = [pctBit(f.revenueYoy, '营收同比'), pctBit(f.profitYoy, '利润同比')].filter(Boolean);
  if (fin.length) {
    bits.push('最新财务' + (rec.asOfDate ? '(截至' + rec.asOfDate + ')' : '') + ':' + fin.join('、'));
  }
  const ev = pickNearEvent(rec);
  if (ev && ev.title) {
    bits.push('近端事项:' + String(ev.time || '').slice(0, 10) + ' ' + sanitize(shortTitleLike(ev.title), 42));
  }
  if (bits.length) line += '\n  ' + bits.join('；');
  return line;
}

function shortTitleLike(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .replace(/^.{2,32}?(?:股份有限公司|集团有限公司|有限公司)/, '')
    .replace(/^关于/, '')
    .replace(/的(?:自愿性披露)?公告$/, '')
    .trim();
}

function pickNearEvent(rec) {
  const lists = [rec && rec.keyEvents, rec && rec.announcements];
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    if (!Array.isArray(list)) continue;
    for (let j = 0; j < list.length; j++) {
      const x = list[j];
      if (x && x.title && !/股票交易异常波动/.test(x.title)) return x;
    }
  }
  return null;
}

function buildStockBlock(stocks, cache) {
  return (stocks || [])
    .filter(function (s) { return s && s.code; })
    .map(function (s) { return formatStockLine(s, cache); })
    .filter(Boolean)
    .join('\n');
}

/**
 * 北京时间「今天」——只注入时点，正提示；年份闸在后处理，不写进提示词以免诱发「选年份」。
 */
function asOfShanghai() {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const year = Number(String(ymd).slice(0, 4));
  const month = Number(String(ymd).slice(5, 7)) || 1;
  const floorYear = month >= 5 ? year - 1 : year - 2;
  const asofBlock = [
    '写作时点：北京时间 **' + ymd + '**。',
    '一到两个事实必须是该股当前仍有效的热点、主业或核心卡点，不要用过期信息。',
  ].join('\n');
  return {
    ymd: ymd,
    year: year,
    month: month,
    floorYear: floorYear,
    asofBlock: asofBlock,
  };
}

/**
 * 不合格判定：兜底拦截明显非「当前最新资料」的写法；主约束在提示词检索顺序。
 * @returns {string|null}
 */
function staleNoteReason(text, asof) {
  asof = asof || asOfShanghai();
  const s = String(text || '');

  // 1) 旧起点累计/签订：一律视为非「最新资料」叙事
  const cum = CUM_FROM_YEAR_RE.exec(s);
  if (cum) {
    const y = Number(cum[1]);
    if (Number.isFinite(y) && y < asof.year) {
      return '旧起点累计/签订叙事（' + y + '年起，今天' + asof.ymd + '）';
    }
  }

  // 2) 早于最新披露窗口的「××年」——不可能是当前最新主锚
  const re = /((?:19|20)\d{2})\s*年/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const y = Number(m[1]);
    if (Number.isFinite(y) && y < asof.floorYear) {
      return '早于最新披露窗口的报告期' + y + '（窗口≥' + asof.floorYear + '，今天' + asof.ymd + '）';
    }
  }
  return null;
}

/** 剥句型标签；强词告警；非最新资料口径不合格则返回空串 */
function polishNote(code, raw, asof) {
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
  const stale = staleNoteReason(text, asof);
  if (stale) {
    console.warn('[minimax] 非最新资料口径已丢弃 code=' + code + ' reason=' + stale +
      ' note=' + text.slice(0, 80));
    return '';
  }
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
function buildFinalizePrompt(stocks, evidence, asof, cache) {
  asof = asof || asOfShanghai();
  return [
    '根据下方已检索资料，为每只股票各写一句 50–120 字描述。',
    asof.asofBlock,
    '固定三截写进一句：身份 + 本条匹配 + 一到两个事实。',
    '事实必须是该股当前热点、当前主业或当前核心卡点，且最新仍有效；没有合格事实就写待验证，禁止编造。',
    '不要写多段对比、风险长文或追问。',
    '只输出 JSON：键为 6 位代码，值为一句话。',
    '```json',
    '{"000001": "<身份；本条匹配；一到两个最新有效事实>"}',
    '```',
    '',
    '## 涉及个股',
    buildStockBlock(stocks, cache) || '（无个股）',
    '',
    '## 已联网检索资料',
    evidence || '（无可用资料：只写身份+本条匹配，事实写待验证）',
  ].join('\n');
}

/** 不合格个股重写（不联网） */
function buildRepairPrompt(stocks, badNotes, evidence, asof, cache) {
  asof = asof || asOfShanghai();
  const lines = (stocks || []).map(function (s) {
    const base = formatStockLine(s, cache);
    const code = pureCode(s.code);
    const bad = badNotes[code] || '';
    return (base || code) + (bad ? '\n  需改写: ' + sanitize(bad, 120) : '');
  }).join('\n');
  return [
    '下列句子时效或口径不合格，请重写。',
    asof.asofBlock,
    '仍用三截一句：身份 + 本条匹配 + 一到两个事实。',
    '事实必须是该股当前热点/主业/核心卡点且仍有效；去掉过期经营史。',
    '只输出 JSON，键为 6 位代码。',
    '```json',
    '{"000001": "<身份；本条匹配；一到两个最新有效事实>"}',
    '```',
    '',
    '## 待重写',
    lines,
    '',
    '## 资料',
    evidence || '（无额外资料：身份+本条匹配，事实写待验证）',
  ].join('\n');
}

/**
 * @param {string} text
 * @param {Set<string>|null} allowCodes
 * @param {object} [asof]
 * @returns {{notes: Record<string,string>, rejected: Record<string,string>}|null}
 */
function notesFromText(text, allowCodes, asof) {
  asof = asof || asOfShanghai();
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') return null;
  const notes = {};
  const rejected = {};
  for (const [k, v] of Object.entries(obj)) {
    const code = pureCode(k);
    if (!code || typeof v !== 'string' || !v.trim()) continue;
    if (allowCodes && !allowCodes.has(code)) continue;
    const raw = String(v).trim();
    const polished = polishNote(code, raw, asof);
    if (polished) notes[code] = polished;
    else if (staleNoteReason(raw, asof)) rejected[code] = raw;
  }
  if (!Object.keys(notes).length && !Object.keys(rejected).length) return null;
  return { notes: notes, rejected: rejected };
}

/**
 * @returns {Promise<Record<string,string>>} {纯数字代码: 一句话}
 */
async function generateStockNotes(title, brief, stocks, config, cache) {
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

  const asof = asOfShanghai();
  console.log('[minimax] 写作时点 asof=' + asof.ymd + ' latestFloorYear=' + asof.floorYear);

  const allowCodes = new Set();
  stocks.forEach(function (s) {
    const code = pureCode(s && s.code);
    if (code) allowCodes.add(code);
  });
  const stockLines = buildStockBlock(stocks, cache);

  const prompt = PROMPT_TEMPLATE
    .replace('{asof_block}', asof.asofBlock)
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
  let parsed = notesFromText(text, allowCodes, asof);
  let evidence = extractResponsesEvidence(data) || text || '（无额外资料）';

  if ((!parsed || !Object.keys(parsed.notes).length) && useSearch) {
    console.log('[minimax] 首轮未产出合格 JSON，发起收尾调用（不联网）');
    const finalizePrompt = buildFinalizePrompt(stocks, evidence, asof, cache);
    try {
      const data2 = await callResponses(cfg, finalizePrompt, false, cfg.maxOutputTokens);
      text = extractResponsesText(data2) || text;
      parsed = notesFromText(text, allowCodes, asof);
      console.log('[minimax] 收尾完成 web_search_calls=' + countWebSearchCalls(data2));
    } catch (e) {
      console.error('[minimax] 收尾调用失败: ' + (e && e.message ? e.message : e));
    }
  }

  let notes = (parsed && parsed.notes) || {};
  let rejected = (parsed && parsed.rejected) || {};

  // 过旧不合格：单次重写；仍失败则缺省，由 notify 回退题材句
  const rejectCodes = Object.keys(rejected);
  if (rejectCodes.length) {
    console.warn('[minimax] 非最新口径不合格 codes=' + rejectCodes.join(',') + ' → 尝试重写一次');
    const repairStocks = stocks.filter(function (s) {
      return rejectCodes.indexOf(pureCode(s.code)) >= 0;
    });
    const repairAllow = new Set(rejectCodes);
    try {
      const data3 = await callResponses(
        cfg,
        buildRepairPrompt(repairStocks, rejected, evidence, asof, cache),
        false,
        cfg.maxOutputTokens
      );
      const repaired = notesFromText(extractResponsesText(data3), repairAllow, asof);
      if (repaired) {
        Object.assign(notes, repaired.notes);
        rejected = repaired.rejected;
      }
    } catch (e) {
      console.error('[minimax] 过旧重写失败: ' + (e && e.message ? e.message : e));
    }
    const stillBad = Object.keys(rejected);
    if (stillBad.length) {
      console.warn('[minimax] 重写后仍非最新口径，回退题材句 codes=' + stillBad.join(','));
    }
  }

  if (!Object.keys(notes).length) {
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
  asOfShanghai: asOfShanghai,
  staleNoteReason: staleNoteReason,
  extractJson: extractJson,
  extractResponsesText: extractResponsesText,
  extractResponsesEvidence: extractResponsesEvidence,
  notesFromText: notesFromText,
  formatStockLine: formatStockLine,
  generateStockNotes: generateStockNotes,
};
