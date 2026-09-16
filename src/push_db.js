'use strict';

/**
 * 企微推送归档 —— SQLite（零 npm 依赖，调用系统 sqlite3 CLI）。
 *
 * 文件：data/pushes.db（GHA 存于 data 分支 / Pages）
 * 表：
 *   push       一文一条：article_id, ctime, prefix, title, brief, stock_count
 *   push_stock 一文多行：基础字段 + T0/T1～T5 涨幅（清晨任务写入）
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const collectMod = require('./collect.js');

const DB_FILE = path.join(collectMod.DATA_DIR, 'pushes.db');

const PERF_COLS = [
  ['t0_date', 'TEXT'],
  ['t0_close', 'REAL'],
  ['t1_pct', 'REAL'],
  ['t2_pct', 'REAL'],
  ['t3_pct', 'REAL'],
  ['t4_pct', 'REAL'],
  ['t5_pct', 'REAL'],
  ['cum5_pct', 'REAL'],
  ['realized_days', 'INTEGER'],
  ['perf_updated_at', 'TEXT'],
];

const SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS push (',
  '  article_id   TEXT PRIMARY KEY,',
  '  ctime        INTEGER NOT NULL DEFAULT 0,',
  '  prefix       TEXT,',
  '  title        TEXT,',
  '  brief        TEXT,',
  '  stock_count  INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS push_stock (',
  '  article_id   TEXT NOT NULL,',
  '  code         TEXT NOT NULL,',
  '  name         TEXT,',
  '  board        TEXT,',
  '  note         TEXT,',
  '  note_source  TEXT,',
  '  t0_date      TEXT,',
  '  t0_close     REAL,',
  '  t1_pct       REAL,',
  '  t2_pct       REAL,',
  '  t3_pct       REAL,',
  '  t4_pct       REAL,',
  '  t5_pct       REAL,',
  '  cum5_pct     REAL,',
  '  realized_days INTEGER,',
  '  perf_updated_at TEXT,',
  '  PRIMARY KEY (article_id, code)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_push_ctime ON push(ctime);',
  'CREATE INDEX IF NOT EXISTS idx_push_prefix ON push(prefix);',
  'CREATE INDEX IF NOT EXISTS idx_push_stock_code ON push_stock(code);',
].join('\n');

let resolvedBin = null;

function findSqlite3() {
  if (resolvedBin) return resolvedBin;
  const candidates = process.platform === 'win32'
    ? ['sqlite3.exe', 'sqlite3']
    : ['sqlite3'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
      if (r.status === 0) {
        resolvedBin = bin;
        return bin;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

function sqlQuote(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function runSql(dbPath, sql) {
  const bin = findSqlite3();
  if (!bin) {
    throw new Error('未找到 sqlite3 命令，请安装 SQLite CLI（Ubuntu: apt-get install -y sqlite3）');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execFileSync(bin, [dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function queryJson(dbPath, sql) {
  const bin = findSqlite3();
  if (!bin) throw new Error('未找到 sqlite3 命令');
  const out = execFileSync(bin, ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const t = String(out || '').trim();
  if (!t) return [];
  return JSON.parse(t);
}

function migratePerfColumns(dbPath) {
  const cols = queryJson(dbPath, 'PRAGMA table_info(push_stock)');
  const have = new Set(cols.map(function (c) { return c.name; }));
  const alters = [];
  for (const pair of PERF_COLS) {
    if (!have.has(pair[0])) {
      alters.push('ALTER TABLE push_stock ADD COLUMN ' + pair[0] + ' ' + pair[1] + ';');
    }
  }
  if (alters.length) runSql(dbPath, alters.join('\n'));
}

function initDb(dbPath) {
  dbPath = dbPath || DB_FILE;
  runSql(dbPath, SCHEMA_SQL);
  migratePerfColumns(dbPath);
  return dbPath;
}

/**
 * @param {object} row
 * @param {Array<{code,name,board,note,note_source}>} row.stocks
 */
function upsertPush(row, dbPath) {
  dbPath = dbPath || DB_FILE;
  if (!row || !row.article_id) throw new Error('upsertPush: 缺少 article_id');
  initDb(dbPath);

  const stocks = Array.isArray(row.stocks) ? row.stocks : [];
  const aid = String(row.article_id);
  const keepCodes = [];
  const parts = [];
  parts.push('BEGIN;');
  parts.push(
    'INSERT INTO push (article_id, ctime, prefix, title, brief, stock_count) VALUES (' +
    [
      sqlQuote(aid),
      sqlQuote(Number(row.ctime) || 0),
      sqlQuote(row.prefix || ''),
      sqlQuote(row.title || ''),
      sqlQuote(row.brief || ''),
      sqlQuote(stocks.length),
    ].join(', ') +
    ') ON CONFLICT(article_id) DO UPDATE SET ' +
    'ctime=excluded.ctime, prefix=excluded.prefix, title=excluded.title, ' +
    'brief=excluded.brief, stock_count=excluded.stock_count;'
  );

  for (const s of stocks) {
    const code = String((s && s.code) || '').replace(/^[a-zA-Z]+/, '');
    if (!code) continue;
    keepCodes.push(code);
    // 保留已有 T0/T1～T5，只更新展示字段
    parts.push(
      'INSERT INTO push_stock (article_id, code, name, board, note, note_source) VALUES (' +
      [
        sqlQuote(aid),
        sqlQuote(code),
        sqlQuote((s && s.name) || ''),
        sqlQuote((s && s.board) || ''),
        sqlQuote((s && s.note) || ''),
        sqlQuote((s && s.note_source) || ''),
      ].join(', ') +
      ') ON CONFLICT(article_id, code) DO UPDATE SET ' +
      'name=excluded.name, board=excluded.board, note=excluded.note, note_source=excluded.note_source;'
    );
  }

  if (keepCodes.length) {
    parts.push(
      'DELETE FROM push_stock WHERE article_id = ' + sqlQuote(aid) +
      ' AND code NOT IN (' + keepCodes.map(sqlQuote).join(',') + ');'
    );
  } else {
    parts.push('DELETE FROM push_stock WHERE article_id = ' + sqlQuote(aid) + ';');
  }
  parts.push('COMMIT;');
  runSql(dbPath, parts.join('\n'));
}

/** 待计算 / 未满 T+5 的 (article, code, ctime) */
function listPendingPerf(dbPath) {
  dbPath = dbPath || DB_FILE;
  initDb(dbPath);
  return queryJson(
    dbPath,
    'SELECT s.article_id AS article_id, s.code AS code, s.name AS name, p.ctime AS ctime, ' +
    's.realized_days AS realized_days ' +
    'FROM push_stock s JOIN push p ON p.article_id = s.article_id ' +
    'WHERE s.realized_days IS NULL OR s.realized_days < 5 ' +
    'ORDER BY p.ctime DESC'
  );
}

function updateStockPerf(dbPath, articleId, code, perf) {
  dbPath = dbPath || DB_FILE;
  initDb(dbPath);
  const sql =
    'UPDATE push_stock SET ' +
    [
      't0_date=' + sqlQuote(perf.t0_date),
      't0_close=' + sqlQuote(perf.t0_close),
      't1_pct=' + sqlQuote(perf.t1_pct),
      't2_pct=' + sqlQuote(perf.t2_pct),
      't3_pct=' + sqlQuote(perf.t3_pct),
      't4_pct=' + sqlQuote(perf.t4_pct),
      't5_pct=' + sqlQuote(perf.t5_pct),
      'cum5_pct=' + sqlQuote(perf.cum5_pct),
      'realized_days=' + sqlQuote(perf.realized_days),
      'perf_updated_at=' + sqlQuote(perf.perf_updated_at || new Date().toISOString()),
    ].join(', ') +
    ' WHERE article_id = ' + sqlQuote(articleId) +
    ' AND code = ' + sqlQuote(code) + ';';
  runSql(dbPath, sql);
}

module.exports = {
  DB_FILE: DB_FILE,
  initDb: initDb,
  upsertPush: upsertPush,
  findSqlite3: findSqlite3,
  queryJson: queryJson,
  runSql: runSql,
  listPendingPerf: listPendingPerf,
  updateStockPerf: updateStockPerf,
  sqlQuote: sqlQuote,
};
