// Draws the city's home-screen icons and writes them as PNGs into
// public/icons: 192 and 512 for the web manifest, 180 for iPhones. No image
// library (sharp is switched off for the whole repo): a few rectangles and
// circles, sampled 4×4 per pixel for smooth edges, and PNG written by hand
// with zlib. Run it again after changing the drawing:
//   pnpm --filter @bp/city icons

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// The city's palette (app/globals.css): evergreen, paper, and the warm light
// of a party in one window.
const EVERGREEN = [0x23, 0x4b, 0x3f];
const DEEP = [0x18, 0x36, 0x2d];
const PAPER = [0xf3, 0xf1, 0xeb];
const LIGHT = [0xef, 0x9f, 0x27];

// The mark, on a unit square: three blocks of a skyline on a street, one
// window lit. Everything sits in the middle 60%, so a phone that crops the
// icon to a circle or a squircle (a "maskable" icon) cuts none of it.
const shapes = [];
const block = (x0, y0, x1, y1) => shapes.push({ x0, y0, x1, y1, r: 0.018, color: PAPER });
const windows = (x0, y0, x1, y1, cols, rows) => {
  const w = (x1 - x0) / (cols * 2 + 1);
  const h = (y1 - y0) / (rows * 2 + 1);
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) shapes.push({ x0: x0 + w * (c * 2 + 1), y0: y0 + h * (r * 2 + 1), x1: x0 + w * (c * 2 + 2), y1: y0 + h * (r * 2 + 2), r: 0.004, color: DEEP });
};
block(0.25, 0.43, 0.41, 0.71);
windows(0.25, 0.45, 0.41, 0.69, 2, 3);
block(0.43, 0.27, 0.59, 0.71);
windows(0.43, 0.29, 0.59, 0.69, 2, 5);
block(0.61, 0.51, 0.75, 0.71);
windows(0.61, 0.53, 0.75, 0.69, 2, 2);
// The party: one window lit in the tall block, and a lantern over the street.
const lit = shapes.filter((s) => s.color === DEEP)[9];
lit.color = LIGHT;
shapes.push({ cx: 0.68, cy: 0.4, r: 0.03, color: LIGHT });
// The street.
shapes.push({ x0: 0.21, y0: 0.73, x1: 0.79, y1: 0.76, r: 0.012, color: PAPER });

function inside(s, x, y) {
  if ("cx" in s) return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2;
  if (x < s.x0 || x > s.x1 || y < s.y0 || y > s.y1) return false;
  // Rounded corners: outside the quarter circle in each corner is out.
  const dx = Math.max(s.x0 + s.r - x, 0, x - (s.x1 - s.r));
  const dy = Math.max(s.y0 + s.r - y, 0, y - (s.y1 - s.r));
  return dx * dx + dy * dy <= s.r * s.r;
}

function colorAt(x, y) {
  let c = EVERGREEN; // full bleed: the phone rounds the corners
  for (const s of shapes) if (inside(s, x, y)) c = s.color;
  return c;
}

function draw(size) {
  const N = 4; // samples per pixel, each way
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < N; sy++)
        for (let sx = 0; sx < N; sx++) {
          const c = colorAt((px + (sx + 0.5) / N) / size, (py + (sy + 0.5) / N) / size);
          sum[0] += c[0];
          sum[1] += c[1];
          sum[2] += c[2];
        }
      const i = (py * size + px) * 3;
      for (let k = 0; k < 3; k++) rgb[i + k] = Math.round(sum[k] / (N * N));
    }
  return rgb;
}

// --- PNG -----------------------------------------------------------------------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 2; // RGB: the icon is opaque
  // Each row starts with its filter type (0: none).
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(new URL(name, out), png(size, draw(size)));
  console.log(`wrote public/icons/${name} (${size}×${size})`);
}
