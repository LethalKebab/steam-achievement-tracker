/**
 * The launcher speaks the interface language too
 * ------------------------------------------------
 * The launcher is a **separate process** with its own `node_modules`; it cannot import
 * `lib/messages.js`, and so for a long time it did not take part in the language switch at all.
 * Everything it puts on screen — the crash box, the start-up timeout, the tray menu and its
 * balloon, the update prompt — answered in Chinese whatever the Dashboard was set to.
 *
 * Two things are guarded here, and they fail in different ways:
 *
 *  - **The table**, in the same terms `i18n-boundary.test.js` uses for `lib/messages.js`: both
 *    halves present, each really in its own language, the same slots on both sides. A half missing
 *    or a pair with two identical members raises nothing at runtime — it simply answers in the
 *    wrong language, which is the whole failure being fixed.
 *  - **That the strings still come from it.** A sentence written straight into a `showErrorBox`
 *    call is invisible to every check above and is exactly how this started.
 *
 * `launcher/main.js` needs Electron to load, so that half is a source assertion — the same family
 * as `tray.test.js`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LAUNCHER_MESSAGES, lt, launcherLanguage, setLanguageResolver, htmlLang } from '../launcher/strings.js';
import { renderUpdatePromptHtml } from '../launcher/updater.js';

const CJK = /[一-鿿]/;
const cjkCount = (s) => (s.match(/[一-鿿]/g) ?? []).length;

const stripComments = (s) =>
  s
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const mainSrc = stripComments(readFileSync(new URL('../launcher/main.js', import.meta.url), 'utf8'));
const updaterSrc = stripComments(readFileSync(new URL('../launcher/updater.js', import.meta.url), 'utf8'));

/** `{slot}` names in a string, so the two halves can be compared without caring about their order */
const slots = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

describe('the launcher table', () => {
  const entries = Object.entries(LAUNCHER_MESSAGES);

  test('every entry has both languages, and the Chinese half really is Chinese', () => {
    for (const [key, pair] of entries) {
      assert.ok(Array.isArray(pair) && pair.length === 2, `${key} is not a pair`);
      assert.ok(pair[0] && pair[1], `${key} is missing one of its two languages`);
      // 'app.name' is the product name: 「Steam 成就追踪器」 — Chinese, with a Latin brand in front
      assert.ok(CJK.test(pair[0]), `${key}'s Chinese half has no Chinese in it: ${pair[0]}`);
    }
  });

  test('the English half carries no Chinese', () => {
    for (const [key, pair] of entries) {
      assert.equal(cjkCount(pair[1]), 0, `${key}'s English half still has Chinese in it: ${pair[1]}`);
    }
  });

  test('no entry answers the same thing in both languages', () => {
    // Two identical halves pass every other check here and simply answer in the wrong language
    for (const [key, pair] of entries) {
      assert.notEqual(pair[0], pair[1], `${key} is the same string twice, so it never switches`);
    }
  });

  test('a slot in one language is a slot in the other', () => {
    // A slot dropped from one half renders as nothing at all in that language, with no error
    for (const [key, pair] of entries) {
      assert.deepEqual([...slots(pair[0])].sort(), [...slots(pair[1])].sort(),
        `${key}'s two halves do not take the same slots`);
    }
  });

  test('every key defined is one the launcher asks for', () => {
    const src = mainSrc + updaterSrc;
    for (const key of Object.keys(LAUNCHER_MESSAGES)) {
      assert.ok(src.includes(`'${key}'`), `${key} is defined but nothing asks for it`);
    }
  });

  test('every key the launcher asks for is defined', () => {
    for (const m of (mainSrc + updaterSrc).matchAll(/\blt\('([\w.]+)'/g)) {
      assert.ok(LAUNCHER_MESSAGES[m[1]], `${m[1]} is asked for but not defined — it renders as its own key`);
    }
  });
});

describe('which language a launcher string comes out in', () => {
  /** Leave the module as it was found: it is shared with whatever ran before */
  const withResolver = (fn, body) => {
    try {
      setLanguageResolver(fn);
      body();
    } finally {
      setLanguageResolver(null);
    }
  };

  test('it follows the resolver, in both directions', () => {
    withResolver(() => 'zh', () => {
      assert.equal(lt('tray.quit'), '退出');
      assert.equal(htmlLang(), 'zh-CN');
    });
    withResolver(() => 'en', () => {
      assert.equal(lt('tray.quit'), 'Exit');
      assert.equal(htmlLang(), 'en');
    });
  });

  test('slots are filled from the values', () => {
    withResolver(() => 'en', () => {
      assert.equal(lt('update.downloading', { version: 'v1.2.5' }), 'Downloading v1.2.5');
    });
  });

  test('anything unrecognised falls back to Chinese rather than to nothing', () => {
    // Including the state before a resolver is installed at all, and a config.json that will not parse
    withResolver(() => 'de', () => assert.equal(lt('tray.quit'), '退出'));
    withResolver(() => { throw new Error('config.json is half-written'); },
      () => assert.equal(lt('tray.quit'), '退出'));
    withResolver(() => null, () => assert.equal(lt('tray.quit'), '退出'));
  });

  test('an unknown key renders as the key, not as a blank', () => {
    withResolver(() => 'en', () => assert.equal(lt('no.such.key'), 'no.such.key'));
  });

  /**
   * **The point of the whole exercise.** The language is written by the *other* process, at any
   * moment, and this one is never told. A value read once at startup is what made the launcher
   * answer in the language it happened to open in for the rest of the session.
   */
  test('a language changed while the launcher is running is picked up', () => {
    const realNow = Date.now;
    let current = 'zh';
    try {
      setLanguageResolver(() => current);
      assert.equal(lt('tray.quit'), '退出');

      current = 'en';
      // Past the cache window — inside it the old answer is deliberately reused
      Date.now = () => realNow() + 60_000;
      assert.equal(launcherLanguage(), 'en');
      assert.equal(lt('tray.quit'), 'Exit',
        'the launcher kept the language it started in, which is the bug this table exists to fix');
    } finally {
      Date.now = realNow;
      setLanguageResolver(null);
    }
  });
});

describe('the update prompt is a page, and pages have a language too', () => {
  const render = (lang) => {
    try {
      setLanguageResolver(() => lang);
      return renderUpdatePromptHtml({ version: '1.2.5', sizeMb: '42' });
    } finally {
      setLanguageResolver(null);
    }
  };

  test('the English one has no Chinese left on it, lang attribute included', () => {
    const html = render('en');
    assert.match(html, /<html lang="en"/);
    assert.equal(cjkCount(html), 0, `the prompt page still has Chinese on it: ${html.match(/[一-鿿].{0,40}/)?.[0]}`);
    assert.match(html, /Version 1\.2\.5 is available/);
    assert.match(html, /Update now/);
  });

  test('the Chinese one is unchanged, lang attribute included', () => {
    // Pointed the other way for the reason the prompt fork's pair gives: one sweeping translation
    // satisfies the assertion above everywhere, and only this one notices
    const html = render('zh');
    assert.match(html, /<html lang="zh-CN"/);
    assert.match(html, /有新版本 1\.2\.5/);
    assert.match(html, /立即更新/);
  });

  test('the buttons the main process listens for keep their ids in both languages', () => {
    // The answer travels back through document.title, and main.js finds the buttons by id — a
    // translation that touched those would leave a prompt whose buttons do nothing
    for (const lang of ['zh', 'en']) {
      const html = render(lang);
      for (const id of ['skip', 'later', 'now']) {
        assert.match(html, new RegExp(`id="${id}"`), `${lang}: the ${id} control lost its id`);
      }
    }
  });
});

describe('nothing the launcher shows is written into the call any more', () => {
  /** The argument list of `name(`, by paren balancing — signatures and calls both wrap */
  const callArgs = (src, name) => {
    const out = [];
    let i = 0;
    while ((i = src.indexOf(name + '(', i)) !== -1) {
      let depth = 0;
      let j = i + name.length;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      out.push(src.slice(i, j + 1));
      i = j + 1;
    }
    return out;
  };

  /**
   * The surfaces a person sees. Log lines are deliberately not on this list: they are read by
   * whoever is diagnosing a fault, not by the user, and they go to a file rather than the screen.
   */
  const UI_CALLS = ['dialog.showErrorBox', 'displayBalloon', 'Menu.buildFromTemplate', 'setToolTip'];

  test('no dialog, balloon, menu or tooltip carries its own Chinese', () => {
    for (const name of UI_CALLS) {
      for (const call of callArgs(mainSrc, name)) {
        assert.equal(cjkCount(call), 0,
          `${name} still spells out its own text, so it cannot answer in English:\n${call.slice(0, 200)}`);
      }
    }
  });

  test('a window title comes from the table', () => {
    for (const m of mainSrc.matchAll(/title: ('[^']*'|`[^`]*`)/g)) {
      assert.equal(cjkCount(m[1]), 0, `a window title is written out rather than looked up: ${m[1]}`);
    }
  });

  test('the launcher reads the language from the file the tracker writes', () => {
    // Spelled any other way, a packaged build reads a config file nobody writes, and the launcher
    // sits in Chinese for ever while the page is in English
    assert.match(mainSrc, /join\(loadDataDirOverride\(\) \?\? TRACKER_ROOT, 'config\.json'\)/,
      'readUiLanguage does not resolve config.json the way lib/config.js does');
    assert.match(mainSrc, /setLanguageResolver\(readUiLanguage\)/,
      'the resolver is never installed, so every string falls back to the default');
  });
});
