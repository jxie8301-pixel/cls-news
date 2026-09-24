'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOCAL_CONFIG_FILE = path.join(ROOT, 'config.local.json');

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (fs.existsSync(LOCAL_CONFIG_FILE)) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8')));
  }
  return cfg;
}

module.exports = { ROOT, loadConfig };
