'use strict';

/**
 * GHA：gate → 并行分片 scan → merge → post → D1
 *
 * SHARDS / FORCE / ASSUME_NEW_VIP / D1_* / POOL_URL
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const POOL = path.join(ROOT, 'data', 'pools', 'all-a.json');
const DEFAULT_POOL_URL =
  'https://raw.githubusercontent.com/jxie8301-pixel/cls-news/data/pools/all-a.json';

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function runNode(args) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', function (code) {
      resolve(code == null ? 1 : code);
    });
  });
}

function download(url, dest) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(url, function (res) {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + url));
          return;
        }
        res.pipe(file);
        file.on('finish', function () {
          file.close(resolve);
        });
      })
      .on('error', function (e) {
        try {
          fs.unlinkSync(dest);
        } catch (_) {}
        reject(e);
      });
  });
}

async function ensurePool() {
  if (fs.existsSync(POOL) && fs.statSync(POOL).size > 1000) {
    console.log('[gha] pool ok');
    return;
  }
  const url = process.env.POOL_URL || DEFAULT_POOL_URL;
  console.log('[gha] download pool ← ' + url);
  await download(url, POOL);
}

async function main() {
  process.chdir(ROOT);
  if (!fs.existsSync(path.join(ROOT, 'config.json'))) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(ROOT, 'config.json'));
  }
  fs.mkdirSync(OUT, { recursive: true });
  await ensurePool();

  if (!process.env.D1_WRITE_TOKEN) {
    console.error('[gha] missing D1_WRITE_TOKEN');
    process.exit(1);
  }

  const shards = Math.max(1, parseInt(process.env.SHARDS || '4', 10) || 4);
  const force = envBool('FORCE', false);
  const assume = envBool('ASSUME_NEW_VIP', false);

  const gateArgs = ['src/cli.js', 'gate'];
  if (force) gateArgs.push('--force');
  if (assume) gateArgs.push('--assume-new-vip');

  console.log('[gha] === gate ===');
  const gateCode = await runNode(gateArgs);
  if (gateCode === 3) {
    console.log('[gha] gate skip (no new VIP)');
    process.exit(0);
  }
  if (gateCode !== 0) process.exit(gateCode);

  console.log('[gha] === scan x' + shards + ' ===');
  const scans = [];
  for (let i = 0; i < shards; i++) {
    scans.push(runNode(['src/cli.js', 'scan', '--shard', String(i), '--shards', String(shards)]));
  }
  const scanCodes = await Promise.all(scans);
  if (scanCodes.some(function (c) {
    return c !== 0;
  })) {
    console.error('[gha] scan failed ' + scanCodes.join(','));
    process.exit(1);
  }

  console.log('[gha] === merge ===');
  const mergeCode = await runNode(['src/cli.js', 'merge', '--shards', String(shards)]);
  if (mergeCode !== 0) process.exit(mergeCode);

  console.log('[gha] === post → D1 ===');
  const postCode = await runNode(['src/cli.js', 'post']);
  if (postCode !== 0) process.exit(postCode);

  console.log('[gha] done.');
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
