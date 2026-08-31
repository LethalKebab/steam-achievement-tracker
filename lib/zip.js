/**
 * Minimal ZIP read/write (node:zlib only, no dependencies)
 * ------------------------------------------------
 * Backups are ZIP rather than a bespoke container for one reason, but a solid one:
 * **double-clicking opens them, and will still open them in twenty years.** docs/data.md
 * states that being readable without this tool is a goal of the data format, which a
 * home-grown format cannot meet and tar does not meet on Windows either. The cost is this
 * file — about a hundred lines of container read/write — and what it buys is a format that
 * never has to be maintained.
 *
 * The supported subset is **deliberately narrow**: single volume, no encryption, no zip64,
 * store and deflate only. We write these backups and we read them; there is no need to
 * swallow every variant of ZIP in the wild. If a backup ever exceeds 4 GB (zip64's
 * threshold) we can revisit it — and by then the format won't be the problem.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { msg } from './messages.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
// General-purpose bit 11 = the filename is UTF-8. Guide filenames contain Chinese, and
// without this bit an extractor guesses using the local codepage, which on Windows means
// a string of mojibake
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

/** JS Date → DOS's two 16-bit time/date fields (epoch 1980, seconds only to 2-second precision) */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * entries: [{ name, data }] — name uses / as the separator, data is a Buffer.
 * Entries that don't get smaller are stored rather than deflated (steam.db compresses,
 * already-compressed images don't), so we never grow a file chasing bytes that aren't there
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
 * → Map<name, Buffer>.
 *
 * **The data offset must be computed back from the local header, never by adding a fixed
 * length to the central directory's offset** — the same entry's extra field can differ in
 * length between the local header and the central directory (many ZIP writers put
 * alignment padding in the local header only). Jumping by the central directory's length
 * misreads the byte stream, and inflate will most likely then fail somewhere else, raising
 * an error unrelated to the actual cause.
 */
export function zipRead(buf) {
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocdAt = i; break; }
  }
  if (eocdAt < 0) throw new Error(msg('zip.notAZip'));

  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error(msg('zip.badDirectory'));
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localAt) !== LOCAL) throw new Error(msg('zip.badEntry', { name }));
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    // The checksum is the only place a corrupted transfer can be caught here — without it a
    // truncated backup runs all the way to writing the database before failing, and by then
    // it has already started changing the user's data
    if (crc32(data) !== crc) throw new Error(msg('zip.badChecksum', { name }));
    out.set(name, data);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
