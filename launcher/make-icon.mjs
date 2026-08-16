/**
 * 生成 icon.ico(托盘 + 应用图标)。
 *
 *   node launcher/make-icon.mjs
 *
 * ## 它现在做什么
 *
 * 读 `icon-source.png`(552×552 RGBA,已裁好、四角已切成透明),等比缩到
 * 16/24/32/48/64/128/256 七档,打成一个 .ico。**只用 node:zlib**,和项目其余部分
 * 一样不引依赖。
 *
 * ## 为什么从"纯代码画"改成"从一张图缩"
 *
 * 原来这里是用距离场直接画一个蓝底白勾 —— 好处是没有二进制资产,坏处是能画出来的
 * 东西极其有限。现在的图标(奖杯 + 光环 + 星)是设计出来的,不是几行 SDF 能表达的。
 *
 * **但"可重新生成"这条原则保住了**,这是当初写这个脚本的全部理由:仓库里存的是
 * `icon-source.png` 这一个可读的源文件,`.ico` 由它派生。换图标 = 换那张 PNG 再跑一遍,
 * 不需要任何外部工具,也不会出现"一个没人能重做的 .ico"。
 *
 * 源图必须是:**8 位、颜色类型 6(RGBA)、非隔行**。别的格式这里的解码器不认,
 * 而且会当场报错而不是默默画错 —— 见 decodePng 里的断言。
 *
 * ## 缩放为什么是面积平均而不是双线性
 *
 * 从 552 缩到 16 是 34 倍下采样。双线性只看邻近 2×2,会漏掉绝大多数源像素,细节
 * 直接丢成噪点;面积平均(box)把目标像素覆盖到的所有源像素都算进去,这才是大比例
 * 缩小的正确做法。**而且必须在预乘 alpha 下平均** —— 不预乘的话,四角透明区域里
 * 那些 RGB 值(GDI+ 留下的黑)会被平均进边缘,圆角上会出现一圈脏边。
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'icon-source.png');
const OUT = join(HERE, 'icon.ico');

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

// ---------- PNG 解码 ----------

/**
 * 只支持源图那一种格式,别的**当场抛错**。
 * 静默走一条错误的解码路径会得到一张看着像坏掉的图标,而不是一个能查的报错。
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

  // IDAT 可能被切成多块,要按顺序拼起来再解压
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

  // 反滤波。每行开头一个 filter 字节,五种滤波器都要实现 —— 编码器爱用哪种用哪种
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

// ---------- 缩放 ----------

/** 面积平均下采样,在预乘 alpha 下做 —— 理由见文件头 */
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
      const am = a / n;                       // 平均后的 alpha
      const un = am > 0 ? 255 / am : 0;       // 反预乘
      dst[o] = Math.round(Math.min(255, (r / n) * un));
      dst[o + 1] = Math.round(Math.min(255, (g / n) * un));
      dst[o + 2] = Math.round(Math.min(255, (b / n) * un));
      dst[o + 3] = Math.round(am);
    }
  }
  return dst;
}

// ---------- ICO 封装 ----------

// 16/32 是托盘实际用的;256 是 electron-builder 对应用图标的硬性下限。
// 中间几档留着,免得 Windows 在高 DPI 下自己缩放出糊边。
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

const ico = Buffer.concat([header, ...entries, ...pngs]);
writeFileSync(OUT, ico);
console.log(
  `[make-icon] ${OUT} —— 源 ${src.w}×${src.h},${SIZES.length} 档:${SIZES.join('/')},共 ${ico.length} 字节`
);
