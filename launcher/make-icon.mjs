/**
 * 生成 icon.ico(托盘 + 应用图标)。
 *
 * 为什么是脚本而不是直接提交一个二进制:图标要改的时候(换配色、换字形),
 * 一个没人能重新生成的 .ico 只能靠外部工具重做,而那正是资产腐烂的方式。
 * 这里只用 node:zlib,跟项目其余部分一样不引依赖。
 *
 *   node launcher/make-icon.mjs
 *
 * 字形选择:16×16 下能读出来的东西非常有限,勾号是唯一在这个尺寸上还认得出、
 * 又跟"成就追踪"对得上的形状(奖杯在 16px 下是一坨)。底色用 Dashboard 的
 * --accent(#66c0f4)填满而不是透明:任务栏可能是深色也可能是浅色,亮蓝色
 * 在两种底上都看得见,而透明背景配深色字形在深色任务栏上会直接消失。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'icon.ico');

const ACCENT = [0x66, 0xc0, 0xf4]; // --accent,Steam 蓝
const INK = [0x17, 0x1a, 0x21]; // --bg,深色勾号

// ---------- PNG 编码 ----------

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

/** rgba: Uint8Array,长度 = w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10/11/12 = compression/filter/interlace,全 0

  // 每行前面加一个 filter 字节(0 = None)
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

// ---------- 画图 ----------

/** 点到线段的距离 —— 勾号是两段折线,用距离场画能自然得到圆角端点 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 圆角矩形的有符号距离(<0 在内部) */
function roundedRectSdf(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * 画一个尺寸的图标。
 *
 * 用 4×4 超采样求覆盖率来抗锯齿 —— 16px 下不做抗锯齿,勾号的斜边会是明显的
 * 阶梯,在任务栏里看起来像坏掉的位图。
 */
function draw(size) {
  const rgba = new Uint8Array(size * size * 4);
  const S = 4; // 每轴超采样数
  const c = size / 2;
  const half = size * 0.46;
  const radius = size * 0.24;
  const stroke = size * 0.13;

  // 勾号的三个折点,按尺寸比例给
  const p = [
    [size * 0.30, size * 0.52],
    [size * 0.44, size * 0.66],
    [size * 0.72, size * 0.35],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inShape = 0;
      let inCheck = 0;

      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          if (roundedRectSdf(px - c, py - c, half, radius) < 0) inShape++;
          const d = Math.min(
            distToSegment(px, py, p[0][0], p[0][1], p[1][0], p[1][1]),
            distToSegment(px, py, p[1][0], p[1][1], p[2][0], p[2][1])
          );
          if (d < stroke / 2) inCheck++;
        }
      }

      const total = S * S;
      const shapeA = inShape / total;
      const checkA = inCheck / total;
      const i = (y * size + x) * 4;

      // 勾号压在底色上;底色之外的勾号部分不画(否则会溢出圆角)
      const ca = checkA * shapeA;
      rgba[i] = Math.round(ACCENT[0] * (1 - ca) + INK[0] * ca);
      rgba[i + 1] = Math.round(ACCENT[1] * (1 - ca) + INK[1] * ca);
      rgba[i + 2] = Math.round(ACCENT[2] * (1 - ca) + INK[2] * ca);
      rgba[i + 3] = Math.round(shapeA * 255);
    }
  }

  return rgba;
}

// ---------- ICO 封装 ----------

// 16/32 是托盘实际用的;256 是 electron-builder 对应用图标的硬性下限。
// 中间几档留着,免得 Windows 在高 DPI 下自己缩放出糊边。
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const pngs = SIZES.map((s) => encodePng(s, s, draw(s)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(SIZES.length, 4);

let offset = 6 + SIZES.length * 16;
const entries = SIZES.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s; // 0 表示 256
  e[1] = s >= 256 ? 0 : s;
  e[2] = 0; // 调色板色数
  e[3] = 0; // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});

writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs]));
console.log(`[make-icon] ${OUT} —— ${SIZES.length} 档:${SIZES.join('/')},共 ${Buffer.concat([header, ...entries, ...pngs]).length} 字节`);
