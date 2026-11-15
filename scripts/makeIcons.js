// Renders the app icon (same design as public/icons/icon.svg) to PNG files without any dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

function roundedRect(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Signed-distance layers in the 512 × 512 design space, painted back to front.
function shade(x, y, full) {
  const layers = [];
  const t = (x + y) / 1024;
  const bg = [100 + (63 - 100) * t, 112 + (74 - 112) * t, 232 + (192 - 232) * t];
  layers.push([full ? Math.max(Math.abs(x - 256), Math.abs(y - 256)) - 256 : roundedRect(x, y, 0, 0, 512, 512, 112), bg, 1]);
  layers.push([roundedRect(x, y, 150, 104, 248, 300, 36), [255, 255, 255], 0.45]);
  layers.push([roundedRect(x, y, 114, 140, 248, 300, 36), [255, 255, 255], 1]);
  const check = Math.min(segment(x, y, 178, 292, 224, 338), segment(x, y, 224, 338, 314, 234)) - 17;
  layers.push([check, [47, 158, 68], 1]);
  let rgb = [0, 0, 0];
  let alpha = 0;
  for (const [d, color, opacity] of layers) {
    if (d > 0) continue;
    const a = opacity;
    rgb = rgb.map((c, i) => c * (1 - a) + color[i] * a);
    alpha = alpha + a * (1 - alpha);
  }
  return [...rgb, alpha];
}

function render(size, full = false) {
  const ss = 4;
  const scale = 512 / size;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = shade((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale, full);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = ss * ss;
      const o = 1 + px * 4;
      row[o] = a ? Math.round(r / a) : 0;
      row[o + 1] = a ? Math.round(g / a) : 0;
      row[o + 2] = a ? Math.round(b / a) : 0;
      row[o + 3] = Math.round((a / n) * 255);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), render(192));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), render(512));
// iOS rounds the corners itself, so the touch icon is a full square.
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), render(180, true));
console.log(`Icons geschrieben nach ${outDir}`);
