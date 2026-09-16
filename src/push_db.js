'use strict';

/**
 * 企微推送归档 —— SQLite（零 npm 依赖，调用系统 sqlite3 CLI）。
 *
 * 文件：data/pushes.db（GHA 存于 data 分支）
 * 表：
 *   push       一文一条：article_id, ctime, prefix, title, brief, stock_count
 *   push_stock 一文多行：article_id, code, name, board, note, note_source
 *
 * 不含 pushed_at / content_md。仅在企微发送成功后写入。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const collectMod = require('./collect.js');

const DB_FILE = path.join(collectMod.DATA_DIR, 'pushes.db');

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
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
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
    maxBuffer: 8 * 1024 * 1024,
  });
}

function initDb(dbPath) {
  dbPath = dbPath || DB_FILE;
  runSql(dbPath, SCHEMA_SQL);
  return dbPath;
}

/**
 * @param {object} row
 * @param {string} row.article_id
 * @param {number} row.ctime
 * @param {string} row.prefix
 * @param {string} row.title
 * @param {string} row.brief
 * @param {Array<{code,name,board,note,note_source}>} row.stocks
 * @param {string} [dbPath]
 */
function upsertPush(row, dbPath) {
  dbPath = dbPath || DB_FILE;
  if (!row || !row.article_id) throw new Error('upsertPush: 缺少 article_id');
  initDb(dbPath);

  const stocks = Array.isArray(row.stocks) ? row.stocks : [];
  const aid = String(row.article_id);
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
  parts.push('DELETE FROM push_stock WHERE article_id = ' + sqlQuote(aid) + ';');
  for (const s of stocks) {
    const code = String((s && s.code) || '').replace(/^[a-zA-Z]+/, '');
    if (!code) continue;
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
  parts.push('COMMIT;');
  runSql(dbPath, parts.join('\n'));
}

module.exports = {
  DB_FILE: DB_FILE,
  initDb: initDb,
  upsertPush: upsertPush,
  findSqlite3: findSqlite3,
};
