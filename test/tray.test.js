/**
 * Living in the tray, plus the freshness sync when the window is shown
 * ------------------------------------------------
 * This file guards four things that **break without a sound**:
 *
 * 1. Closing the window quits again — the whole feature is undone, and it looks "normal"
 *    (that was the behaviour before).
 * 2. It cannot be quit — the preventDefault in close leaves no way out, the tray's 「退出」
 *    does nothing when pressed, and the user is left with Task Manager.
 * 3. Every switch back to the window runs a full sync — if `maybeSync` degrades into an alias
 *    for `startSync`, the freshness gate is gone. This raises no error; it merely multiplies
 *    Steam requests by dozens, quietly.
 * 4. Double-clicking the exe a second time pops a bogus 「后台服务意外退出」 — this one is a
 *    direct consequence of the first three: the program lives in the tray, so "click the icon
 *    again" goes from a rare event to a daily action.
 *
 * `launcher/main.js` needs Electron to load and a unit test cannot reach it, so that part is a
 * **source assertion**, the same family as the drainNext one in `guidequeue.test.js`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApi } from '../lib/api.js';
import { LAUNCHER_MESSAGES } from '../launcher/strings.js';

/**
 * Strip comments before matching.
 *
 * **Without this the assertion gets satisfied by its own comment.** That is not hypothetical:
 * in the first version the "does server.js inject maybeAutoSync" check ran empty — the word
 * `maybeAutoSync` appeared in the comment beside the injection line, so deleting the real code
 * left the assertion passing. Mutation testing caught it; reading the code did not. This
 * repository has a high comment density, so that is the rule rather than the exception.
 *
 * The `[^:]` part is there to avoid hitting `http://` — the double slash in a protocol is not
 * a comment, and those lines often carry `${...}`, so deleting through them would break brace
 * balancing too.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

const mainSrc = stripComments(readFileSync(new URL('../launcher/main.js', import.meta.url), 'utf8'));
const serverSrc = stripComments(readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8'));

/**
 * Slice out a whole block from `needle` by brace balancing.
 *
 * A fixed-length slice (`slice(start, start + 2600)`) drifts as the surrounding code grows and
 * shrinks, and the consequence of drifting is that the assertion ends up matching against half
 * a piece of code — possibly always true, possibly always false, and neither is testing
 * anything.
 */
function blockFrom(src, needle, label = needle) {
  const start = src.indexOf(needle);
  assert.ok(start > 0, `cannot find ${label} — this check has lost its target rather than passed`);
  const open = src.indexOf('{', start);
  assert.ok(open > start, `there is no code block after ${label}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`the code block for ${label} does not close`);
}

describe('window lifecycle — closing is not quitting', () => {
  test('window-all-closed must not quit the program again', () => {
    // This is the switch for the whole feature. Restore app.quit() here and living in the
    // background is gone, while the appearance is "everything is fine" — because that is
    // exactly the behaviour before the change
    const body = blockFrom(mainSrc, "app.on('window-all-closed'");
    assert.doesNotMatch(body, /app\.quit\(\)/,
      'window-all-closed quits again — living in the tray is undone, and nothing will report it');
  });

  test('close has to make way for a real quit', () => {
    const body = blockFrom(mainSrc, "mainWindow.on('close'");
    assert.match(body, /isQuitting/,
      'close has no isQuitting branch letting the quit through — preventDefault makes the program impossible to quit');
    assert.match(body, /preventDefault/, 'without intercepting the close, the window really is destroyed');
    assert.match(body, /hide\(\)/, 'intercepted but not hidden, the window sits there refusing to close');
  });

  test('before-quit has to set isQuitting first, then kill the child process', () => {
    // The other order: the child's exit listener sees isQuitting still false, so every normal
    // quit first pops a 「后台服务意外退出」 error box
    const body = blockFrom(mainSrc, "app.on('before-quit'");
    const flag = body.indexOf('isQuitting');
    const kill = body.indexOf('.kill()');
    assert.ok(flag > 0, 'before-quit does not set isQuitting');
    assert.ok(kill > 0, 'before-quit does not shut down the child process — the server is left orphaned in the background');
    assert.ok(flag < kill,
      'the order is reversed: kill comes before the flag is set, so every normal quit pops a bogus crash box');
  });
});

describe('the tray — the only way out once the window is closed', () => {
  const trayBlock = () => blockFrom(mainSrc, 'function createTray');
  // The menu itself moved into `paintTray`, which `createTray` calls and which is also what repaints
  // it after a language switch. The item and its wiring are still what this asks about
  const menuBlock = () => blockFrom(mainSrc, 'function paintTray');

  test('the menu has to carry 「退出」, and it has to really call app.quit', () => {
    const body = menuBlock();
    assert.match(body, /label: lt\('tray\.quit'\)/,
      'the tray menu has no quit item — the user is left with Task Manager');
    assert.match(body, /app\.quit\(\)/, 'there is a quit item but it is not wired to app.quit');
    // The label is a key now, so the word the user actually looks for is one step away
    assert.equal(LAUNCHER_MESSAGES['tray.quit'][0], '退出');
    assert.equal(LAUNCHER_MESSAGES['tray.quit'][1], 'Exit');
  });

  test('the menu is repainted when the interface language moves under it', () => {
    // A context menu is handed to Windows once and drawn by Windows from then on, so unlike every
    // other string in this process it cannot resolve its own language when it is read. Without the
    // repaint the tray keeps the language the launcher started in, for ever
    const body = trayBlock();
    assert.match(body, /launcherLanguage\(\) !== trayLanguage/,
      'nothing notices the language changing, so the tray menu keeps the one it was built with');
    assert.match(body, /paintTray\(\)/, 'the change is noticed but the menu is never rebuilt');
    assert.match(stripComments(mainSrc), /if \(trayLanguageTimer\) clearInterval\(trayLanguageTimer\)/,
      'the repaint timer is never cleared, so quitting leaves it running');
  });

  test('an empty icon has to be reported rather than passing silently', () => {
    // An empty nativeImage is an **invisible** icon in the tray. Combined with "closing does
    // not quit", the result is a program you can neither see nor close
    assert.match(trayBlock(), /isEmpty\(\)/,
      'no empty-icon check — a failed icon load yields a program that is invisible and cannot be quit');
  });

  test('the tray has to be built before the window', () => {
    // Closing the window uses the tray to show a balloon; in the other order that first
    // close-the-window notice is lost
    const ready = blockFrom(mainSrc, 'app.whenReady()');
    const tray = ready.indexOf('createTray');
    const win = ready.indexOf('createWindow');
    assert.ok(tray > 0 && win > 0, 'whenReady is missing createTray or createWindow');
    assert.ok(tray < win, 'createTray has to come before createWindow');
  });
});

describe('single instance — a second double-click on the exe must not become an error box', () => {
  test('the branch that fails to take the lock may only quit, never start anything', () => {
    // Start anything and the guard was for nothing: that child process hits EADDRINUSE and
    // exits at once, and the bogus crash box is back exactly as before
    const body = blockFrom(mainSrc, 'if (!app.requestSingleInstanceLock())');
    assert.match(body, /app\.quit\(\)/, 'the second instance does not quit — it just hangs around');
    for (const forbidden of ['startServer', 'createTray', 'createWindow']) {
      assert.doesNotMatch(body, new RegExp(forbidden),
        `the second instance still calls ${forbidden} — the single-instance lock is decorative`);
    }
  });

  test('the lock has to sit in front of the whenReady registration', () => {
    // app.quit() before ready only queues, and the ready callback still runs startServer once.
    // So the check has to wrap the **registration**; it cannot move inside the callback
    const lock = mainSrc.indexOf('requestSingleInstanceLock');
    const ready = mainSrc.indexOf('app.whenReady()');
    assert.ok(lock > 0, 'no single-instance lock — a second double-click on the exe pops 「后台服务意外退出(代码 1)」');
    assert.ok(ready > 0, 'whenReady is gone');
    assert.ok(lock < ready, 'whenReady is registered before the lock — the second instance still starts a child process first');
  });

  test('the first instance has to bring the window out rather than pretend it saw nothing', () => {
    assert.match(mainSrc, /app\.on\('second-instance',\s*showWindow\)/,
      'second-instance is not wired to showWindow — double-clicking the exe becomes "nothing happened", which reads as more broken than an error');
  });

  test('the child process stderr has to be kept, or the error box cannot state a cause', () => {
    // Going back to stdio: 'inherit' only breaks in the **packaged** build: there is no console
    // there, so the sentence the child says before dying evaporates and the error box degrades
    // into a 「代码 1」 with nothing to search for. Dev mode is fine throughout
    const body = blockFrom(mainSrc, 'function startServer');
    assert.match(body, /stdio:\s*\['inherit',\s*'inherit',\s*'pipe'\]/,
      'stderr no longer goes through a pipe — the child process error message is lost in the packaged build');
    assert.match(body, /lastErrorLine\(/, 'the error box does not repeat the reason the child process gave');
  });

  test('the startup error listener has to be removed once listen succeeds', () => {
    // Left attached, a real error after listen rejects an already-settled promise — no crash,
    // no report, an error simply gone
    // This targets the listen callback itself — `new Promise((resolve, reject)` appears more
    // than once in this file (readBody too), so using that as an anchor slices into somebody
    // else's block
    const block = blockFrom(serverSrc, 'server.listen(config.port');
    assert.match(block, /removeListener\('error'/,
      'the startup listener is not removed after listen succeeds — later server errors are swallowed silently');
  });
});

describe('maybeSync — the freshness gate must not be bypassed', () => {
  const nulls = {
    db: null, steam: null, config: {}, syncState: null,
    guideGenState: null, startGuideGen: null, planGuidePreflight: null,
  };

  test('it goes through maybeAutoSync, not startBackgroundSync', () => {
    let stale = 0;
    let forced = 0;
    const api = createApi({
      ...nulls,
      startBackgroundSync: () => { forced++; return { started: true }; },
      maybeAutoSync: () => { stale++; return true; },
    });

    const r = api.maybeSync();
    assert.equal(stale, 1, 'maybeSync did not call maybeAutoSync');
    assert.equal(forced, 0,
      'maybeSync went through startBackgroundSync — that one deliberately bypasses syncStaleHours, ' +
      'so every switch back to the window runs a full sync');
    assert.deepEqual(r, { started: true });
  });

  test('when the gate says no sync is needed, false is returned honestly', () => {
    const api = createApi({ ...nulls, startBackgroundSync: null, maybeAutoSync: () => false });
    assert.deepEqual(api.maybeSync(), { started: false });
  });

  test('not injected does not throw — a serve started from the CLI should not 500 over this', () => {
    const api = createApi({ ...nulls, startBackgroundSync: null });
    assert.doesNotThrow(() => api.maybeSync());
    assert.equal(api.maybeSync().started, false);
  });

  test('server.js really does wire maybeAutoSync into createApi', () => {
    // Source assertion: the injection point is inside serve()'s closure, out of a unit test's
    // reach. Miss it and maybeSync always returns unavailable, showing the window never
    // triggers a sync again — and nothing reports it at all
    const block = blockFrom(serverSrc, 'const api = createApi(');
    assert.match(block, /maybeAutoSync\s*:/,
      'server.js does not inject maybeAutoSync — maybeSync silently becomes a no-op');
  });
});

describe('icon assets', () => {
  test('icon.ico exists and is a valid ICO containing a 256 entry', () => {
    const buf = readFileSync(new URL('../launcher/icon.ico', import.meta.url));
    assert.equal(buf.readUInt16LE(0), 0, 'the reserved field of an ICO header has to be 0');
    assert.equal(buf.readUInt16LE(2), 1, 'type has to be 1 (icon, not cursor)');

    const count = buf.readUInt16LE(4);
    assert.ok(count > 0, 'the ICO contains no images at all');

    const sizes = [];
    for (let i = 0; i < count; i++) sizes.push(buf[6 + i * 16] || 256);
    assert.ok(sizes.includes(16), 'no 16x16 — that is the size the tray actually uses');
    assert.ok(sizes.includes(256), 'no 256x256 — electron-builder requires it for the app icon');
  });

  test('the packaging config has to carry icon.ico', () => {
    // Miss it and only the **packaged** build has no icon; dev mode (npm start) is fine
    // throughout — precisely the kind of problem that waits until release to appear
    const pkg = JSON.parse(readFileSync(new URL('../launcher/package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.build.files.includes('icon.ico'), 'not in build.files means the file is not in the asar');
    assert.ok(pkg.build.asarUnpack?.includes('icon.ico'),
      'no asarUnpack — the tray reads this file from a real path and cannot read it from inside the asar');
    assert.equal(pkg.build.win.icon, 'icon.ico', 'win.icon is unset, so the exe keeps the default Electron icon');
  });
});
