'use strict';
/**
 * 生成 PWA 图标（零依赖，用 node:zlib 手写 PNG）。
 *   node tools/make-icons.js
 * 输出 public/icon-192.png、public/icon-512.png
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function make(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角矩形背景（品牌橙）
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const outside = Math.sqrt(dx * dx + dy * dy) > radius;
      set(x, y, 194, 65, 12, outside ? 0 : 255);
    }
  }
  // 三根白色柱状图
  const barW = Math.round(size * 0.13);
  const gap = Math.round(size * 0.075);
  const baseY = Math.round(size * 0.76);
  const heights = [0.30, 0.46, 0.62].map((h) => Math.round(size * h));
  const totalW = barW * 3 + gap * 2;
  let x0 = Math.round((size - totalW) / 2);
  for (let i = 0; i < 3; i++) {
    const top = baseY - heights[i];
    for (let y = top; y <= baseY; y++) {
      for (let x = x0; x < x0 + barW; x++) set(x, y, 255, 255, 255, 255);
    }
    x0 += barW + gap;
  }
  return png(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const data = make(size);
  const file = path.join(outDir, 'icon-' + size + '.png');
  fs.writeFileSync(file, data);
  console.log('wrote ' + file + '  ' + data.length + ' bytes');
}

