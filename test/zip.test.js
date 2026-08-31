/**
 * Regression tests for the minimal ZIP container
 * ------------------------------------------------
 * Every failure at this layer is **silent**: a zip that no other extraction tool can open
 * (while we read it back perfectly well, so a round-trip test stays green), or bytes read
 * back quietly misaligned.
 * So there is almost no happy path here; what is tested are several ways of being wrong
 * that "look right".
 *
 * While this file was being written, the artefact itself was separately verified by two
 * **independent implementations**: Python's zipfile (testzip() passing, Chinese entry names
 * read correctly, steam.db's sha256 matching the original) and PowerShell's Expand-Archive
 * (which is what the packaged build's self-update uses). Those were a one-off
 * cross-verification rather than a regression test — this file is the regression test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { zipWrite, zipRead, crc32 } from '../lib/zip.js';

const buf = (s) => Buffer.from(s, 'utf8');

describe('the ZIP container', () => {
  test('round trip: an empty file, binary, a Chinese name, and both compressible and incompressible data all come back verbatim', () => {
    const entries = [
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'bin.dat', data: Buffer.from([0, 255, 13, 10, 26, 0, 127, 128]) },
      { name: 'guides/苏丹的游戏 攻略.md', data: buf('# 标题\n- [ ] 第一步\n'.repeat(40)) },
      // Random bytes will not compress and take the store path — both paths have to be covered
      { name: 'noise.bin', data: Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 2654435761) % 256)) },
    ];
    const back = zipRead(zipWrite(entries));
    assert.equal(back.size, entries.length);
    for (const e of entries) {
      assert.ok(back.get(e.name)?.equals(e.data), `${e.name} came back different`);
    }
  });

  test('an entry that does not shrink is stored, and must not end up larger', () => {
    // Already-compressed data (images and the like) grows **larger** after deflate. Compressing
    // blindly makes a backup bigger than the original files, and that raises no error — it
    // merely makes the feature look bad
    const incompressible = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 256));
    const z = zipWrite([{ name: 'a.bin', data: incompressible }]);
    assert.ok(z.length < incompressible.length + 300, `wrote ${z.length} for an original of ${incompressible.length} — it did not take the store path`);
    assert.ok(zipRead(z).get('a.bin').equals(incompressible));
  });

  test('the file name\'s UTF-8 flag has to be set, or a Chinese name is mojibake in other tools', () => {
    // General purpose bit 11 (0x0800). Unset, extraction tools guess by local code page, which
    // on Windows means a run of question marks — while we read it as hard-coded utf8, so a
    // self-test cannot find it
    const z = zipWrite([{ name: '中文.md', data: buf('x') }]);
    assert.equal(z.readUInt16LE(6) & 0x0800, 0x0800, 'the local header does not set the UTF-8 bit');
    // The copy in the central directory needs it too: many tools only look at the central directory
    const eocd = z.length - 22;
    const cd = z.readUInt32LE(eocd + 16);
    assert.equal(z.readUInt16LE(cd + 8) & 0x0800, 0x0800, 'the central directory does not set the UTF-8 bit');
  });

  test('the data offset is computed from the local header and must not jump by the central directory\'s length', () => {
    // The same entry's extra field **may differ in length** between the local header and the
    // central directory (many ZIP writers put alignment padding in the local header only).
    // Jumping by the central directory misaligns, and usually not with an error on the spot but
    // with inflate failing somewhere else and reporting something unrelated to the real cause.
    // This hand-builds a zip whose local header has 4 bytes of extra and whose central
    // directory has none.
    const z = zipWrite([{ name: 'a.txt', data: buf('hello') }]);
    const nameLen = z.readUInt16LE(26);
    const extra = Buffer.from([0x99, 0x99, 0x00, 0x00]);

    const local = Buffer.from(z.subarray(0, 30 + nameLen));
    local.writeUInt16LE(extra.length, 28); // only the local header's extra length is changed
    const body = z.subarray(30 + nameLen, z.readUInt32LE(z.length - 22 + 16));
    const tail = Buffer.from(z.subarray(z.readUInt32LE(z.length - 22 + 16)));

    const shifted = Buffer.concat([local, extra, body, tail]);
    // The central directory entry's offset is unchanged (still 0), but the extra length it records is still 0
    const eocdAt = shifted.length - 22;
    shifted.writeUInt32LE(local.length + extra.length + body.length, eocdAt + 16);

    const back = zipRead(shifted);
    assert.equal(back.get('a.txt').toString('utf8'), 'hello');
  });

  test('altered content has to be stopped at the checksum and must not be handed over as good data', () => {
    // This is the only place "the file arrived corrupt" can be discovered. Without it, a corrupt
    // backup runs all the way to the database write before blowing up — by which point the
    // user's data is already being overwritten
    const z = zipWrite([{ name: 'a.txt', data: buf('hello world, 这是一段够长的内容,能压缩') }]);
    const copy = Buffer.from(z);
    // Flip a byte inside the data area (past the local header and the file name)
    const at = 30 + copy.readUInt16LE(26) + 2;
    copy[at] = copy[at] ^ 0xff;
    assert.throws(() => zipRead(copy), /校验失败|ZIP/);
  });

  test('not a zip, or a truncated central directory, both have to raise clearly', () => {
    assert.throws(() => zipRead(Buffer.from('这根本不是 zip'.repeat(10))), /不是一个 ZIP/);
    const z = zipWrite([{ name: 'a.txt', data: buf('x') }]);
    // Keep the EOCD and cut the central directory out — nastier than truncating the whole thing, because the signature is still there
    const holed = Buffer.concat([z.subarray(0, z.length - 60), z.subarray(z.length - 22)]);
    assert.throws(() => zipRead(holed));
  });

  test('crc32 matches published known values', () => {
    // A round trip computed by ourselves is self-consistent rather than correct — these are the standard CRC-32/ISO-HDLC test vectors
    assert.equal(crc32(buf('')), 0);
    assert.equal(crc32(buf('123456789')), 0xcbf43926);
    assert.equal(crc32(buf('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });
});
