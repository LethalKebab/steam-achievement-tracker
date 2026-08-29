/**
 * 「打开文件夹」 — the one place in this project that launches an external process
 * ------------------------------------------------
 * So the failure class this file guards is **the arguments being assembled wrong, and
 * something else being executed as a result**. That kind of error cannot be found by
 * running it once and watching for a window: a window opens either way, just not the one
 * you expected; and the case with a `&` in the path only appears once some game name
 * happens to carry one.
 *
 * Nothing is ever really spawned: the command and the arguments are decided by pure
 * functions, and injecting spawnImpl shows exactly what it wanted to execute.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { revealCommand, revealInFileManager } from '../lib/reveal.js';

describe('revealCommand', () => {
  test('on Windows /select and the path are **one argument**', () => {
    const c = revealCommand('D:\\guides\\a.md', 'win32');
    assert.equal(c.cmd, 'explorer.exe');
    // Split into two arguments as ['/select,', path], Explorer opens Documents instead, and
    // raises no error — the comma is part of that switch's syntax rather than a separator
    assert.deepEqual(c.args, ['/select,D:\\guides\\a.md']);
    assert.equal(c.args.length, 1);
  });

  test('macOS uses -R to locate the file rather than open it', () => {
    assert.deepEqual(revealCommand('/g/a.md', 'darwin'), { cmd: 'open', args: ['-R', '/g/a.md'] });
  });

  test('Linux has no universal "locate the file", so it falls back to opening the directory', () => {
    assert.deepEqual(revealCommand('/g/a.md', 'linux'), { cmd: 'xdg-open', args: ['/g'] });
  });

  test('an unrecognised platform returns null rather than guessing a command', () => {
    assert.equal(revealCommand('/g/a.md', 'sunos'), null);
  });

  /**
   * **The injection surface.** A guide's file name is derived from the game name, and the
   * game name comes from Steam and can look like anything. What has to be proved here is
   * not "we escape well" but that **there is nothing needing escaping**: the arguments are
   * handed to spawn as an array (shell defaults to false) and pass through no shell
   * parsing at all.
   */
  test('shell metacharacters in the path stay in the argument verbatim, with no concatenation', () => {
    const nasty = 'D:\\guides\\a & calc.exe "x" ; rm -rf.md';
    const c = revealCommand(nasty, 'win32');
    assert.equal(c.args.length, 1, 'there is always exactly one argument — one more means something is splitting');
    assert.ok(c.args[0].endsWith(nasty), 'the path has to be carried through verbatim and must not be trimmed');
    // The command name is a hardcoded constant and is unaffected by the path
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

  test('never goes through a shell — the premise of "nothing needs escaping"', () => {
    const spawnImpl = fakeSpawn();
    revealInFileManager('D:\\g\\a.md', { platform: 'win32', spawnImpl });
    const opts = spawnImpl.calls[0].opts;
    assert.notEqual(opts.shell, true, 'shell: true turns the metacharacters above back into syntax');
    assert.equal(opts.detached, true, 'the server process should not be dragged along waiting for it');
    assert.equal(opts.stdio, 'ignore');
  });

  test('an unrecognised platform reports honestly rather than silently doing nothing', () => {
    const spawnImpl = fakeSpawn();
    const r = revealInFileManager('/g/a.md', { platform: 'sunos', spawnImpl });
    assert.match(r.error, /sunos/);
    assert.equal(spawnImpl.calls.length, 0);
  });

  test('spawn throwing on the spot (a missing command, say) becomes an error rather than blowing up upwards', () => {
    const r = revealInFileManager('D:\\g\\a.md', {
      platform: 'win32',
      spawnImpl: () => { throw new Error('ENOENT'); },
    });
    assert.match(r.error, /ENOENT/);
  });

  test('an error listener is attached — an unhandled error event takes the whole server process down', () => {
    let listened = null;
    revealInFileManager('D:\\g\\a.md', {
      platform: 'win32',
      spawnImpl: () => ({ on(ev) { listened = ev; }, unref() {} }),
    });
    assert.equal(listened, 'error');
  });

  test('launching at all counts as success — **the exit code is not consulted**', () => {
    // explorer.exe /select frequently returns 1 while opening the window perfectly well, and judging success by it reports "it opened" as "it failed"
    const r = revealInFileManager('D:\\g\\a.md', { platform: 'win32', spawnImpl: fakeSpawn() });
    assert.deepEqual(r, { ok: true });
  });
});
