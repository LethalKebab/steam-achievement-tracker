/**
 * 最小 ZIP 读写(只用 node:zlib,不引任何依赖)
 * ------------------------------------------------
 * 备份文件用 ZIP 而不是自定义容器,理由只有一条,但够硬:**双击就能打开,而且
 * 二十年后还能打开。** 这个项目在 docs/data.md 里写过「不用这个工具也读得懂」是
 * 数据格式的目标之一,一个自研格式做不到,tar 在 Windows 上也不是双击就开。
 * 代价是这个文件 —— 大约一百行的容器读写,换来的是格式本身不需要被维护。
 *
 * 支持的范围是**故意窄**的:单卷、无加密、无 zip64、只有 deflate 和 store。
 * 备份是我们自己写自己读的,不需要吃下野生 ZIP 的所有变体。真遇到超过 4 GB 的
 * 备份(zip64 的门槛)再说 —— 那时候的问题也不是格式。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
// 通用标记位 11 = 文件名是 UTF-8。攻略文件名有中文,不置这一位的话
// 解压工具会按本地代码页去猜,Windows 上就是一串乱码
const UTF8_FLAG = 0x0800;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** JS Date → DOS 的时间/日期两个 16 位字段(1980 起算,秒只有 2 秒精度) */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * entries: [{ name, data }] —— name 用 / 分隔,data 是 Buffer
 * 压不小的条目按 store 存(steam.db 压得动,已经压过的图片之类压不动),
 * 免得为了省不到的字节反而把文件写大
 */
export function zipWrite(entries, now = new Date()) {
  const { time, date } = dosTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(UTF8_FLAG, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * → Map<name, Buffer>。
 *
 * **数据的起点必须回到本地头去算,不能用中央目录里的那个偏移直接加固定长度** ——
 * 同一个条目的 extra 字段在本地头和中央目录里长度可以不一样(很多写 ZIP 的程序
 * 只在本地头塞对齐用的 extra)。按中央目录的长度去跳,读出来的就是错位的字节流,
 * 而 inflate 多半还是会失败在别的地方,报一个跟真实原因无关的错。
 */
export function zipRead(buf) {
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocdAt = i; break; }
  }
  if (eocdAt < 0) throw new Error('不是一个 ZIP 文件(找不到中央目录)');

  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localAt) !== LOCAL) throw new Error(`ZIP 条目损坏: ${name}`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    // 校验和是这里唯一能发现「文件传坏了」的地方 —— 少了它,一个被截断的备份
    // 会一路走到写库那一步才炸,而那时候已经开始改用户的数据了
    if (crc32(data) !== crc) throw new Error(`ZIP 条目校验失败(文件可能损坏): ${name}`);
    out.set(name, data);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
