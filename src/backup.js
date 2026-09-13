'use strict';
/**
 * 每日备份：把「数据 + 配置 + 代码 + 最新导出」打包成一份带清单的快照。
 *
 * 默认写到 OneDrive 目录（能自动同步到云端），因此不需要电脑一直开着、也不会把自选股传到公开仓库。
 * 每份快照就是一个日期文件夹，直接打开就能看到内容；只保留最近 N 天，更早的自动清理。
 *
 *   node src/backup.js                  每天第一次运行；当天已备份过则跳过
 *   node src/backup.js --force          强制再备份一份（覆盖当天快照）
 *   node src/backup.js --list           查看已有快照
 *   node src/backup.js --restore 2026-09-12        只预览会恢复哪些文件
 *   node src/backup.js --restore 2026-09-12 --yes  真正恢复
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOCAL_CONFIG_FILE = path.join(ROOT, 'config.local.json');

/** 快照里要收进去的内容（相对项目根目录）。目录会被递归收集。 */
const INCLUDE = [
  'data',
  'src',
  'public',
  '.github',
  'config.json',
  'config.local.json',
  'config.example.json',
  'package.json',
  '.gitignore',
  'README.md',
  'out/cls-news-latest.csv',
  'out/cls-news-latest.html',
  'out/cls-news-latest.json',
  'out/cls-news-cards.html',
];

/** 这些目录/文件名即使落在收集范围内也跳过。 */
const SKIP_NAMES = new Set(['.git', 'node_modules', 'backups', 'out']);

const DEFAULT_KEEP_DAYS = 30;

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** 用上海时间（UTC+8）算日期与时间戳，不受本机时区影响。 */
function shanghai() {
  const d = new Date(Date.now() + 8 * 3600000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const ss = d.getUTCSeconds();
  return {
    date: y + '-' + pad(m) + '-' + pad(day),
    stamp: y + '-' + pad(m) + '-' + pad(day) + ' ' + pad(hh) + ':' + pad(mm) + ':' + pad(ss),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadConfig() {
  const cfg = readJson(CONFIG_FILE) || {};
  const local = fs.existsSync(LOCAL_CONFIG_FILE) ? readJson(LOCAL_CONFIG_FILE) : null;
  return local ? Object.assign(cfg, local) : cfg;
}

/** 备份目录：优先配置里的 dir，其次 OneDrive，最后退回项目同级目录。 */
function backupDir(cfg) {
  // 便于临时验证或换位置：环境变量优先
  if (process.env.CLS_BACKUP_DIR) return process.env.CLS_BACKUP_DIR;
  const b = cfg.backup || {};
  if (b.dir) return b.dir;
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
  if (oneDrive && fs.existsSync(oneDrive)) return path.join(oneDrive, '财联社备份');
  return path.join(path.dirname(ROOT), path.basename(ROOT) + '-backups');
}

function keepDays(cfg) {
  const envKeep = Number(process.env.CLS_BACKUP_KEEP);
  if (Number.isFinite(envKeep) && envKeep > 0) return Math.floor(envKeep);
  const n = Number((cfg.backup || {}).keepDays);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_KEEP_DAYS;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 把一个文件或目录下的文件递归收进来，返回 [{rel, size, sha256}]。 */
function collectFiles(rel, out) {
  const abs = path.join(ROOT, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { return out; }
  if (stat.isDirectory()) {
    if (SKIP_NAMES.has(path.basename(abs)) && rel !== 'out') return out;
    for (const name of fs.readdirSync(abs).sort()) {
      if (SKIP_NAMES.has(name)) continue;
      if (/^_.*\.(log|err|ps1)$/i.test(name)) continue;
      collectFiles(path.join(rel, name), out);
    }
    return out;
  }
  if (!stat.isFile()) return out;
  if (stat.size === 0) return out;
  out.push({ rel: rel.split(path.sep).join('/'), size: stat.size, sha256: sha256(abs) });
  return out;
}

/** 快照里数据部分的一句话摘要，方便一眼看出备份内容。 */
function dataSummary() {
  const news = readJson(path.join(ROOT, 'data', 'news.json'));
  const research = readJson(path.join(ROOT, 'data', 'research.json'));
  const watchlist = readJson(path.join(ROOT, 'data', 'watchlist.json'));
  const poolsDir = path.join(ROOT, 'data', 'pools');
  const pools = fs.existsSync(poolsDir)
    ? fs.readdirSync(poolsDir).filter(function (f) { return /\.json$/.test(f); }).map(function (f) {
        const p = readJson(path.join(poolsDir, f));
        return { file: f, name: p && p.name, count: Array.isArray(p && p.stocks) ? p.stocks.length : null };
      })
    : [];
  return {
    articles: news && news.articles ? Object.keys(news.articles).length : null,
    researchStocks: research && research.stocks ? Object.keys(research.stocks).length : null,
    watchlistStocks: watchlist && Array.isArray(watchlist.stocks) ? watchlist.stocks.length : null,
    pools: pools,
  };
}

function appendLog(dir, line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'backup.log'), '[' + shanghai().stamp + '] ' + line + '\n', 'utf8');
  } catch (_) { /* 日志写不进去不影响备份本体 */ }
}

function listSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (f) { return /^\d{4}-\d{2}-\d{2}$/.test(f) && fs.existsSync(path.join(dir, f, 'manifest.json')); })
    .sort();
}

/** 只清理自家生成的日期目录，其余内容一概不动。 */
function prune(dir, keep) {
  const all = listSnapshots(dir);
  const remove = all.slice(0, Math.max(0, all.length - keep));
  for (const d of remove) {
    fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  }
  return remove;
}

function copyInto(snapshotDir, files) {
  for (const f of files) {
    const dest = path.join(snapshotDir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f.rel), dest);
  }
}

function gitCommit() {
  try {
    return require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
  } catch (_) { return null; }
}

/** 校验快照：文件都在、大小一致、JSON 能解析。 */
function verify(snapshotDir, manifest) {
  const problems = [];
  for (const f of manifest.files) {
    const p = path.join(snapshotDir, f.rel);
    if (!fs.existsSync(p)) { problems.push('缺失 ' + f.rel); continue; }
    const size = fs.statSync(p).size;
    if (size !== f.size) problems.push('大小不符 ' + f.rel + '（' + size + '≠' + f.size + '）');
    if (/\.json$/.test(f.rel)) {
      try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { problems.push('JSON 无法解析 ' + f.rel); }
    }
  }
  return problems;
}

function doBackup(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  if ((cfg.backup || {}).enabled === false) {
    console.log('备份已关闭（config.json 里 backup.enabled = false）');
    return 0;
  }
  const dir = backupDir(cfg);
  const today = opts.date || shanghai().date;
  const target = path.join(dir, today);

  if (!opts.force && fs.existsSync(path.join(target, 'manifest.json'))) {
    const old = readJson(path.join(target, 'manifest.json'));
    console.log('今天（' + today + '）已经备份过了：' + target);
    if (old) console.log('  备份时间 ' + old.createdAtShanghai + ' ｜ 文件 ' + old.files.length + ' 个 ｜ ' + formatBytes(old.totalBytes));
    console.log('需要再来一份就加 --force');
    return 0;
  }

  const files = [];
  for (const rel of INCLUDE) collectFiles(rel, files);

  const staging = path.join(dir, today + '.tmp');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  copyInto(staging, files);

  const manifest = {
    date: today,
    createdAt: new Date().toISOString(),
    createdAtShanghai: shanghai().stamp,
    host: os.hostname(),
    projectRoot: ROOT,
    gitCommit: gitCommit(),
    files: files,
    totalBytes: files.reduce(function (a, f) { return a + f.size; }, 0),
    data: dataSummary(),
  };
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const problems = verify(staging, manifest);
  if (problems.length) {
    console.error('备份校验失败，已保留现场目录 ' + staging);
    problems.slice(0, 10).forEach(function (p) { console.error('  ' + p); });
    appendLog(dir, '失败：' + problems.length + ' 项校验不通过');
    return 1;
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);

  // 第二份拷贝（可选）：配了 backup.secondDir 才会做，失败不影响主备份
  const second = (cfg.backup || {}).secondDir;
  let secondNote = '';
  if (second) {
    try {
      fs.mkdirSync(second, { recursive: true });
      const d2 = path.join(second, today);
      fs.rmSync(d2, { recursive: true, force: true });
      fs.cpSync(target, d2, { recursive: true });
      prune(second, keepDays(cfg));
      secondNote = ' ｜ 第二份：' + d2;
    } catch (e) {
      secondNote = ' ｜ 第二份失败：' + String((e && e.message) || e);
    }
  }

  const removed = prune(dir, keepDays(cfg));
  const line = '成功：' + target + ' ｜ 文件 ' + files.length + ' 个 ｜ ' + formatBytes(manifest.totalBytes) +
    ' ｜ 清理 ' + removed.length + ' 份旧快照' + secondNote;
  console.log(line);
  const d = manifest.data;
  console.log('  内容：文章 ' + (d.articles === null ? '—' : d.articles) + ' 条 ｜ 调研缓存 ' + (d.researchStocks === null ? '—' : d.researchStocks) + ' 只 ｜ 自选股 ' + (d.watchlistStocks === null ? '—' : d.watchlistStocks) + ' 只 ｜ 股票池 ' + d.pools.map(function (p) { return (p.name || p.file) + '(' + p.count + ')'; }).join('、'));
  console.log('  保留最近 ' + keepDays(cfg) + ' 天：' + listSnapshots(dir).join('、'));
  appendLog(dir, line);
  return 0;
}

function formatBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function doList() {
  const cfg = loadConfig();
  const dir = backupDir(cfg);
  const all = listSnapshots(dir);
  console.log('备份目录：' + dir);
  if (!all.length) { console.log('（还没有快照）'); return 0; }
  all.slice().reverse().forEach(function (d) {
    const m = readJson(path.join(dir, d, 'manifest.json')) || {};
    console.log('  ' + d + ' ｜ ' + (m.files ? m.files.length + ' 个文件' : '?') + ' ｜ ' + formatBytes(m.totalBytes) + ' ｜ ' + (m.createdAtShanghai || ''));
  });
  console.log('共 ' + all.length + ' 份，保留 ' + keepDays(cfg) + ' 天内的快照');
  return 0;
}

/** 恢复：默认只预览，加 --yes 才真正覆盖写入。 */
function doRestore(date) {
  const cfg = loadConfig();
  const dir = backupDir(cfg);
  const src = path.join(dir, String(date));
  const manifest = readJson(path.join(src, 'manifest.json'));
  if (!manifest) {
    console.error('找不到快照：' + src);
    console.error('可用快照：' + (listSnapshots(dir).join('、') || '（无）'));
    return 1;
  }
  const apply = arg('yes') === true;
  const target = typeof arg('target') === 'string' ? arg('target') : ROOT;
  console.log('快照 ' + date + '（' + manifest.createdAtShanghai + '，' + manifest.files.length + ' 个文件）');
  console.log((apply ? '恢复' : '预览') + '目标：' + target);
  for (const f of manifest.files) {
    const from = path.join(src, f.rel);
    const to = path.join(target, f.rel);
    const exists = fs.existsSync(to);
    console.log('  ' + (apply ? '写入 ' : '将覆盖 ') + f.rel + (exists ? '' : '（当前不存在）'));
    if (apply) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  if (!apply) console.log('确认无误后，加 --yes 执行恢复（会覆盖当前文件）。');
  return 0;
}

function main() {
  const restoreDate = arg('restore');
  if (typeof restoreDate === 'string') return doRestore(restoreDate);
  if (arg('list') === true) return doList();
  return doBackup({ force: arg('force') === true, date: typeof arg('date') === 'string' ? arg('date') : undefined });
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { backupDir: backupDir, listSnapshots: listSnapshots, doBackup: doBackup, INCLUDE: INCLUDE };
