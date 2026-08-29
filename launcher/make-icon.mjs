/**
 * Generates icon.ico (the tray and application icon).
 *
 *   node launcher/make-icon.mjs
 *
 * ## What it does now
 *
 * Reads `icon-source.png` (552×552 RGBA, already cropped, with the corners already cut to
 * transparent), scales it proportionally to the seven sizes 16/24/32/48/64/128/256, and packs them
 * into one .ico. **node:zlib only**, dependency-free like the rest of the project.
 *
 * ## Why it changed from "drawn purely in code" to "scaled from an image"
 *
 * This used to draw a blue background with a white tick directly from a distance field — the
 * advantage being no binary asset, the disadvantage being that what can be drawn that way is
 * extremely limited. The current icon (a trophy plus a halo and a star) was designed, and is not
 * something a few lines of SDF can express.
 *
 * **But "regenerable" is preserved**, which was the whole reason for writing this script: what the
 * repository stores is one readable source file, `icon-source.png`, and the `.ico` is derived from
 * it. Changing the icon = change that PNG and run this again, with no external tool required and no
 * chance of ending up with a `.ico` nobody can reproduce.
 *
 * The source image has to be **8-bit, colour type 6 (RGBA), non-interlaced**. The decoder here does
 * not accept any other format, and it raises an error on the spot rather than quietly drawing the
 * wrong thing — see the assertions in decodePng.
 *
 * ## Why the scaling is an area average rather than bilinear
 *
 * Going from 552 to 16 is a 34× downsample. Bilinear looks only at the neighbouring 2×2 and misses
 * the vast majority of source pixels, turning detail straight into noise; an area (box) average
 * counts every source pixel the destination pixel covers, which is the correct approach for a large
 * reduction. **And it has to average over premultiplied alpha** — without premultiplying, the RGB
 * values in the transparent corners (the black GDI+ left behind) get averaged into the edge and
 * produce a dirty fringe around the rounded corners.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'icon-source.png');
const OUT = join(HERE, 'icon.ico');

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: a Uint8Array of length w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10/11/12 = compression/filter/interlace, all 0

  // Each row is preceded by one filter byte (0 = None)
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- PNG decoding ----------

/**
 * Supports only the source image's format and **throws on the spot** for anything else.
 * Quietly taking a wrong decoding path produces an icon that merely looks broken, rather than an
 * error somebody can investigate.
 */
function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('icon-source.png 不是 PNG');

  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const [depth, color, , , interlace] = [buf[24], buf[25], buf[26], buf[27], buf[28]];
  if (depth !== 8) throw new Error(`只支持 8 位,源图是 ${depth} 位`);
  if (color !== 6) throw new Error(`只支持颜色类型 6(RGBA),源图是 ${color}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');

  // IDAT may be split across several chunks, which have to be joined in order before inflating
  const parts = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') parts.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));

  // Unfiltering. Each row starts with one filter byte, and all five filters have to be implemented —
  // an encoder uses whichever it likes
  const stride = w * 4;
  const out = new Uint8Array(w * h * 4);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= 4 ? up[i - 4] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error(`未知的 PNG 滤波类型 ${ft}`);
      cur[i] = v & 0xff;
    }
  }
  return { w, h, rgba: out };
}

// ---------- Scaling ----------

/** Area-average downsampling, done over premultiplied alpha — the reasoning is in the file header */
function resize(src, sw, sh, size) {
  const dst = new Uint8Array(size * size * 4);
  const sx = sw / size, sy = sh / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al;
          a += src[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const am = a / n;                       // the averaged alpha
      const un = am > 0 ? 255 / am : 0;       // un-premultiply
      dst[o] = Math.round(Math.min(255, (r / n) * un));
      dst[o + 1] = Math.round(Math.min(255, (g / n) * un));
      dst[o + 2] = Math.round(Math.min(255, (b / n) * un));
      dst[o + 3] = Math.round(am);
    }
  }
  return dst;
}

// ---------- ICO packing ----------

// 16/32 are what the tray actually uses; 256 is electron-builder's hard minimum for an application
// icon.
// The intermediate sizes stay so Windows does not produce blurry edges scaling on its own at high DPI.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const src = decodePng(readFileSync(SRC));
if (src.w !== src.h) throw new Error(`源图必须是正方形,现在是 ${src.w}×${src.h}`);

const pngs = SIZES.map((s) => encodePng(s, s, resize(src.rgba, src.w, src.h, s)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(SIZES.length, 4);

let offset = 6 + SIZES.length * 16;
const entries = SIZES.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s; // 0 means 256
  e[1] = s >= 256 ? 0 : s;
  e[2] = 0; // number of palette colours
  e[3] = 0; // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});

const ico = Buffer.concat([header, ...entries, ...pngs]);
writeFileSync(OUT, ico);
console.log(
  `[make-icon] ${OUT} —— 源 ${src.w}×${src.h},${SIZES.length} 档:${SIZES.join('/')},共 ${ico.length} 字节`
);
