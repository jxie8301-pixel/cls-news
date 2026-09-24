'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config.js');

function loadPool(relPath) {
  const file = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stocks = (raw.stocks || []).filter(function (s) {
    return s && s.code;
  });
  return {
    key: raw.key || 'pool',
    name: raw.name || raw.key || 'pool',
    count: stocks.length,
    stocks: stocks,
  };
}

module.exports = { loadPool };
