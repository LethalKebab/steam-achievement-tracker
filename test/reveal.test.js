/**
 * 「打开文件夹」—— 这个项目唯一一处拉起外部进程的地方
 * ------------------------------------------------
 * 所以这个文件守的失败类是**参数拼错了,于是执行了别的东西**。这类错跑一次看窗口
 * 开没开是发现不了的:窗口照样会开,只是开的不是你以为的那个;而路径里带 `&` 的
 * 那种情况要等某个游戏名恰好带上它才会出现。
 *
 * 一律不真的 spawn:命令和参数由纯函数决定,注入 spawnImpl 就能看到它到底想执行什么。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { revealCommand, revealInFileManager } from '../lib/reveal.js';

describe('revealCommand', () => {
  test('Windows 的 /select 和路径**是一个参数**', () => {
    const c = revealCommand('D:\\guides\\a.md', 'win32');
    assert.equal(c.cmd, 'explorer.exe');
    // 拆成 ['/select,', path] 两个参数的话资源管理器会打开「我的文档」,而且不报错 ——
    // 逗号是这个开关语法的一部分,不是分隔符
    assert.deepEqual(c.args, ['/select,D:\\guides\\a.md']);
    assert.equal(c.args.length, 1);
  });

  test('macOS 用 -R 定位到文件,不是打开文件', () => {
    assert.deepEqual(revealCommand('/g/a.md', 'darwin'), { cmd: 'open', args: ['-R', '/g/a.md'] });
  });

  test('Linux 没有通用的"定位到文件",退一步打开所在目录', () => {
    assert.deepEqual(revealCommand('/g/a.md', 'linux'), { cmd: 'xdg-open', args: ['/g'] });
  });

  test('不认识的平台返回 null,而不是猜一个命令出来', () => {
    assert.equal(revealCommand('/g/a.md', 'sunos'), null);
  });

  /**
   * **注入面。** 攻略文件名是从游戏名削出来的,而游戏名是 Steam 给的,可以长成
   * 任何样子。这里要证明的不是"我们转义得好",而是**根本没有需要转义的地方** ——
   * 参数以数组形式交给 spawn(shell 默认 false),不经过任何 shell 解析。
   */
  test('路径里的 shell 元字符原样留在参数里,不做任何拼接', () => {
    const nasty = 'D:\\guides\\a & calc.exe "x" ; rm -rf.md';
    const c = revealCommand(nasty, 'win32');
    assert.equal(c.args.length, 1, '永远只有一个参数 —— 多一个就意味着有地方在切分');
    assert.ok(c.args[0].endsWith(nasty), '路径要原样带过去,不许被削');
    // 命令名是写死的常量,不受路径影响
    assert.equal(c.cmd, 'explorer.exe');
  });
});

describe('revealInFileManager', () => {
  const fakeSpawn = () => {
    const calls = [];
    const fn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    };
    fn.calls = calls;
    return fn;
  };

  test('不经过 shell —— 这是"不需要转义"的前提', () => {
    const spawnImpl = fakeSpawn();
    revealInFileManager('D:\\g\\a.md', { platform: 'win32', spawnImpl });
    const opts = spawnImpl.calls[0].opts;
    assert.notEqual(opts.shell, true, 'shell: true 会把上面那些元字符重新变成语法');
    assert.equal(opts.detached, true, '不该拖着服务进程一起等它');
    assert.equal(opts.stdio, 'ignore');
  });

  test('平台不认识时如实报错,不静悄悄什么都不做', () => {
    const spawnImpl = fakeSpawn();
    const r = revealInFileManager('/g/a.md', { platform: 'sunos', spawnImpl });
    assert.match(r.error, /sunos/);
    assert.equal(spawnImpl.calls.length, 0);
  });

  test('spawn 当场抛(比如命令不存在)→ 变成 error,不往上炸', () => {
    const r = revealInFileManager('D:\\g\\a.md', {
      platform: 'win32',
      spawnImpl: () => { throw new Error('ENOENT'); },
    });
    assert.match(r.error, /ENOENT/);
  });

  test('挂了 error 监听 —— 没人接的 error 事件会把整个服务进程带崩', () => {
    let listened = null;
    revealInFileManager('D:\\g\\a.md', {
      platform: 'win32',
      spawnImpl: () => ({ on(ev) { listened = ev; }, unref() {} }),
    });
    assert.equal(listened, 'error');
  });

  test('拉起来了就算成功 —— **不看退出码**', () => {
    // explorer.exe /select 常常返回 1 却正常开了窗口,拿它判断成败会把"打开了"报成"失败"
    const r = revealInFileManager('D:\\g\\a.md', { platform: 'win32', spawnImpl: fakeSpawn() });
    assert.deepEqual(r, { ok: true });
  });
});
