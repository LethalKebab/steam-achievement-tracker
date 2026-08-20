/**
 * 最小 ZIP 容器的回归测试
 * ------------------------------------------------
 * 这一层的失败**全部是安静的**:写出去的 zip 别的解压工具打不开(而我们自己
 * 读得回来,所以往返测试一片绿),或者读进来的字节悄悄错位。
 * 所以这里几乎不测 happy path,测的是几种"看起来对"的错法。
 *
 * 写这个文件的时候,产物本身另外用两个**独立实现**验过:Python 的 zipfile
 * (testzip() 通过、中文条目名读得对、steam.db 的 sha256 和原文件一致)和
 * PowerShell 的 Expand-Archive(打包版自更新用的就是它)。那两次是一次性的
 * 交叉验证,不是回归测试 —— 这个文件才是。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { zipWrite, zipRead, crc32 } from '../lib/zip.js';

const buf = (s) => Buffer.from(s, 'utf8');

describe('ZIP 容器', () => {
  test('往返:空文件、二进制、中文名、压得动和压不动的都要原样回来', () => {
    const entries = [
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'bin.dat', data: Buffer.from([0, 255, 13, 10, 26, 0, 127, 128]) },
      { name: 'guides/苏丹的游戏 攻略.md', data: buf('# 标题\n- [ ] 第一步\n'.repeat(40)) },
      // 随机字节压不动,会走 store 那条路 —— 两条路都要覆盖到
      { name: 'noise.bin', data: Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 2654435761) % 256)) },
    ];
    const back = zipRead(zipWrite(entries));
    assert.equal(back.size, entries.length);
    for (const e of entries) {
      assert.ok(back.get(e.name)?.equals(e.data), `${e.name} 读回来不一致`);
    }
  });

  test('压不小的条目按 store 存,不能反而写得更大', () => {
    // 已经压过的数据(图片之类)deflate 之后会**变大**。无脑压缩的话备份体积
    // 比原始文件还大,而这件事不会报错,只会让人觉得这个功能很差
    const incompressible = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 256));
    const z = zipWrite([{ name: 'a.bin', data: incompressible }]);
    assert.ok(z.length < incompressible.length + 300, `写出 ${z.length},原始 ${incompressible.length} —— 没走 store`);
    assert.ok(zipRead(z).get('a.bin').equals(incompressible));
  });

  test('文件名的 UTF-8 标记位必须置上,否则中文名在别的工具里是乱码', () => {
    // 通用标记位第 11 位(0x0800)。不置的话解压工具按本地代码页猜,
    // Windows 上就是一串问号 —— 而我们自己读是按 utf8 硬解的,自测发现不了
    const z = zipWrite([{ name: '中文.md', data: buf('x') }]);
    assert.equal(z.readUInt16LE(6) & 0x0800, 0x0800, '本地头没置 UTF-8 位');
    // 中央目录里那份也要有:很多工具只看中央目录
    const eocd = z.length - 22;
    const cd = z.readUInt32LE(eocd + 16);
    assert.equal(z.readUInt16LE(cd + 8) & 0x0800, 0x0800, '中央目录没置 UTF-8 位');
  });

  test('数据起点要按本地头算,不能拿中央目录的长度去跳', () => {
    // 同一个条目的 extra 字段,在本地头和中央目录里长度**可以不一样**
    // (很多写 ZIP 的程序只在本地头塞对齐用的 extra)。按中央目录去跳就会错位,
    // 而且多半不是当场报错,是 inflate 在别处失败、报一个跟真实原因无关的错。
    // 这里手工造一个「本地头有 4 字节 extra、中央目录没有」的 zip。
    const z = zipWrite([{ name: 'a.txt', data: buf('hello') }]);
    const nameLen = z.readUInt16LE(26);
    const extra = Buffer.from([0x99, 0x99, 0x00, 0x00]);

    const local = Buffer.from(z.subarray(0, 30 + nameLen));
    local.writeUInt16LE(extra.length, 28); // 只改本地头的 extra 长度
    const body = z.subarray(30 + nameLen, z.readUInt32LE(z.length - 22 + 16));
    const tail = Buffer.from(z.subarray(z.readUInt32LE(z.length - 22 + 16)));

    const shifted = Buffer.concat([local, extra, body, tail]);
    // 中央目录的条目偏移不变(还是 0),但它记的 extra 长度仍是 0
    const eocdAt = shifted.length - 22;
    shifted.writeUInt32LE(local.length + extra.length + body.length, eocdAt + 16);

    const back = zipRead(shifted);
    assert.equal(back.get('a.txt').toString('utf8'), 'hello');
  });

  test('内容被改过要在校验和这一关拦下,不能当成好数据交出去', () => {
    // 这是"文件传坏了"唯一能被发现的地方。少了它,一个损坏的备份会一路走到
    // 写库那步才炸 —— 而那时候用户的数据已经开始被覆盖了
    const z = zipWrite([{ name: 'a.txt', data: buf('hello world, 这是一段够长的内容,能压缩') }]);
    const copy = Buffer.from(z);
    // 改数据区里的一个字节(跳过本地头和文件名)
    const at = 30 + copy.readUInt16LE(26) + 2;
    copy[at] = copy[at] ^ 0xff;
    assert.throws(() => zipRead(copy), /校验失败|ZIP/);
  });

  test('不是 zip、或者中央目录被截断,都要明确报错', () => {
    assert.throws(() => zipRead(Buffer.from('这根本不是 zip'.repeat(10))), /不是一个 ZIP/);
    const z = zipWrite([{ name: 'a.txt', data: buf('x') }]);
    // 留着 EOCD、把中央目录挖掉 —— 比整个截断更阴,因为签名还在
    const holed = Buffer.concat([z.subarray(0, z.length - 60), z.subarray(z.length - 22)]);
    assert.throws(() => zipRead(holed));
  });

  test('crc32 对得上公开的已知值', () => {
    // 自己算的往返是自洽的,不是正确的 —— 这两个是 CRC-32/ISO-HDLC 的标准测试向量
    assert.equal(crc32(buf('')), 0);
    assert.equal(crc32(buf('123456789')), 0xcbf43926);
    assert.equal(crc32(buf('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });
});
