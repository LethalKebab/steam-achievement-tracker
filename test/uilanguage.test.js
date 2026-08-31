/**
 * Choosing which of two stored languages to show
 * ------------------------------------------------
 * Run with: node --test
 *
 * The data has been bilingual at rest for a while; what did not exist was anything that **chose**
 * between the two. The choice was written out by hand as `d.name_cn || d.name_en || …` at every
 * call site — a preference spelled as a literal. `lib/lang.js` is that preference written once.
 *
 * Three failures this pins, none of which produces an error:
 *
 * - **`uiLanguage` merged back into `config.language`.** That key decides what is *fetched* from
 *   Steam, so a toggle pointed at it either appears to do nothing or silently requires a full
 *   re-sync to undo. They are two different questions and are allowed different answers.
 * - **The search field named by language.** The Dashboard matches a game by the name it shows and
 *   by the stored name it does not; if that second field is "the English one" rather than "the
 *   other one", then switching the interface to English makes every Chinese name unfindable —
 *   #84 again, arriving from the opposite side.
 * - **The fallback going loud.** English mode falls back to whatever was stored, with no badge and
 *   no marker. It is not a rare defensive branch either: one game in a 317-game library has no
 *   English title at all, and every game synced before `description_en` existed has Chinese
 *   descriptions until the next sync reaches it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UI_LANGUAGES, DEFAULT_UI_LANGUAGE, normalizeUiLanguage,
  achievementName, achievementDescription, gameName, gameNamePair,
} from '../lib/lang.js';
import { openDb, insertGame, upsertGuide, setGuideLang, getGuide } from '../lib/db.js';

// **saveUiLanguage really writes config.json**, and CONFIG_PATH is fixed at the moment
// lib/config.js is imported — so TRACKER_DATA_DIR has to be set before the **dynamic** import of
// anything that reaches it. Without this the suite edits the developer's own configuration, which
// is not a failure anyone would see: saveConfig merges, so nothing is lost and nothing reports
// anything. Same pattern as config-ai-providers.test.js
const DIR = mkdtempSync(join(tmpdir(), 'uilang-'));
process.env.TRACKER_DATA_DIR = DIR;
writeFileSync(join(DIR, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y' }));
const { createApi } = await import('../lib/api.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
/** Line comments first, then block comments — the other way round, a `/*` inside a `//` eats real code */
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('normalizeUiLanguage', () => {
  test('the two it knows pass through', () => {
    assert.deepEqual(UI_LANGUAGES, ['zh', 'en']);
    assert.equal(normalizeUiLanguage('zh'), 'zh');
    assert.equal(normalizeUiLanguage('en'), 'en');
  });

  test('anything else reads as the default rather than throwing', () => {
    // A hand-edited config, or one written by an older version, must not stop the app opening —
    // there is nothing a stack trace at startup tells anyone that a sane default does not
    for (const bad of ['', 'EN', 'schinese', 'fr', null, undefined, 42, {}]) {
      assert.equal(normalizeUiLanguage(bad), DEFAULT_UI_LANGUAGE);
    }
  });
});

describe('picking a name', () => {
  const ach = { name_cn: '下降尘凡第一难', name_en: 'Home is Behind', api_name: 'ACH_1', description: '听罢老猴子的故事', description_en: 'The old monkey has told his tale' };

  test('each language gets its own', () => {
    assert.equal(achievementName(ach, 'zh'), '下降尘凡第一难');
    assert.equal(achievementName(ach, 'en'), 'Home is Behind');
    assert.equal(achievementDescription(ach, 'zh'), '听罢老猴子的故事');
    assert.equal(achievementDescription(ach, 'en'), 'The old monkey has told his tale');
  });

  test('a missing one falls back to the other, silently', () => {
    // Every game synced before description_en existed is in this state until a sync reaches it.
    // A marker here would put a badge on most of the library on the day the column shipped
    assert.equal(achievementDescription({ description: '只有中文' }, 'en'), '只有中文');
    assert.equal(achievementName({ name_en: 'Only English', api_name: 'X' }, 'zh'), 'Only English');
  });

  test('api_name is the last resort and is not a language', () => {
    assert.equal(achievementName({ api_name: 'ACH_1' }, 'en'), 'ACH_1');
    assert.equal(achievementName({}, 'zh'), '');
  });

  test('an empty description stays empty — it is a real answer', () => {
    // Hidden achievements store '' in both languages on purpose, because the description is the
    // spoiler. Inventing text here would leak it back through the resolver
    assert.equal(achievementDescription({ description: '', description_en: '' }, 'zh'), '');
    assert.equal(achievementDescription({ description: '', description_en: '' }, 'en'), '');
  });

  test('a game name is "stored" versus "English", not "Chinese" versus "English"', () => {
    // games.name holds whatever fetchAppName found — Chinese usually, English for the many games
    // with no Chinese title, Japanese for at least one
    assert.equal(gameName({ name: '黑神话:悟空', name_en: 'Black Myth: Wukong' }, 'en'), 'Black Myth: Wukong');
    assert.equal(gameName({ name: 'RimWorld', name_en: 'RimWorld' }, 'zh'), 'RimWorld');
    assert.equal(gameName({ name: 'ギルド探求団へようこそ！', name_en: '' }, 'en'), 'ギルド探求団へようこそ！');
  });
});

describe('gameNamePair — what is shown, and what search still has to match', () => {
  const wukong = { name: '黑神话:悟空', name_en: 'Black Myth: Wukong' };

  test('in Chinese the English name is the spare', () => {
    assert.deepEqual(gameNamePair(wukong, 'zh'), { shown: '黑神话:悟空', alt: 'Black Myth: Wukong' });
  });

  test('in English the **Chinese** name is the spare', () => {
    // The whole reason the field is not called nameEn. Carrying the English name in both modes
    // would make every Chinese-titled game unfindable the moment the interface switched
    assert.deepEqual(gameNamePair(wukong, 'en'), { shown: 'Black Myth: Wukong', alt: '黑神话:悟空' });
  });

  test('no distinct second name means no spare, in either language', () => {
    const only = { name: 'ギルド探求団へようこそ！', name_en: '' };
    assert.deepEqual(gameNamePair(only, 'en'), { shown: 'ギルド探求団へようこそ！', alt: '' });
    const same = { name: 'RimWorld', name_en: 'RimWorld' };
    assert.equal(gameNamePair(same, 'zh').alt, '', 'the same string twice is not a second name');
    assert.equal(gameNamePair(same, 'en').alt, '');
  });
});

// ---------------------------------------------------------------------------
// Through the API the Dashboard actually calls
// ---------------------------------------------------------------------------

function envWith(uiLanguage) {
  const db = openDb(':memory:');
  insertGame(db, { appid: '2358720', name: '黑神话:悟空', nameEn: 'Black Myth: Wukong' });
  insertGame(db, { appid: '4327530', name: 'ギルド探求団へようこそ！' });
  const config = { uiLanguage };
  const api = createApi({
    db, steam: {}, config, syncState: { snapshot: () => ({}) },
    startBackgroundSync: null, guideGenState: null, startGuideGen: null,
    planGuidePreflight: null, maybeAutoSync: null,
  });
  return { db, api, config };
}

const row = (api, appid) => api.getDashboardData().games.find((g) => g.appid === appid);

describe('getDashboardData', () => {
  test('Chinese is what an unconfigured install gets', () => {
    const { api } = envWith(undefined);
    assert.equal(api.getDashboardData().uiLanguage, 'zh');
    assert.equal(row(api, '2358720').name, '黑神话:悟空');
  });

  test('English switches the displayed name and moves the other one to nameAlt', () => {
    const { api } = envWith('en');
    assert.equal(api.getDashboardData().uiLanguage, 'en');
    assert.deepEqual(
      { name: row(api, '2358720').name, nameAlt: row(api, '2358720').nameAlt },
      { name: 'Black Myth: Wukong', nameAlt: '黑神话:悟空' }
    );
  });

  test('the one game with no English title shows what was stored, with no marker', () => {
    const { api } = envWith('en');
    const g = row(api, '4327530');
    assert.equal(g.name, 'ギルド探求団へようこそ！');
    assert.equal(g.nameAlt, '');
    // Not "(no English name)", not an asterisk, not a badge. Show a state, do not narrate it
    assert.equal(JSON.stringify(g).includes('*'), false);
  });
});

describe('saveUiLanguage', () => {
  test('it writes the live object, so the next read sees it without a restart', () => {
    const { api, config } = envWith('zh');
    assert.deepEqual(api.saveUiLanguage('en'), { ok: true, uiLanguage: 'en' });
    assert.equal(config.uiLanguage, 'en');
    // The whole point: /setup and the Dashboard are served by one process, and the toggle has to
    // take effect on the next request rather than the next launch
    assert.equal(api.getDashboardData().uiLanguage, 'en');
  });

  test('an unknown value is refused, not quietly normalised', () => {
    const { api, config } = envWith('zh');
    for (const bad of ['', 'EN', 'schinese', 'fr']) {
      assert.ok(api.saveUiLanguage(bad).error, `${JSON.stringify(bad)} should be refused`);
    }
    // Normalising instead would read on screen as the toggle having had no effect, and there is
    // nothing to diagnose from that
    assert.equal(config.uiLanguage, 'zh');
  });

  test('it touches uiLanguage and nothing else — config.language is a different question', () => {
    const { api, config } = envWith('zh');
    config.language = 'schinese';
    api.saveUiLanguage('en');
    // Pointing the toggle at config.language means the stored data is now the wrong language, and
    // insertGame is ON CONFLICT DO NOTHING, so existing rows would not even update
    assert.equal(config.language, 'schinese');
  });
});

// ---------------------------------------------------------------------------
// The seams the tests above cannot reach
// ---------------------------------------------------------------------------

describe('the two keys stay two', () => {
  const lang = strip(read('lib/lang.js'));
  const api = strip(read('lib/api.js'));

  test('lib/lang.js never reads config.language', () => {
    assert.doesNotMatch(lang, /config\.language/, 'the display resolver has no business with the fetch language');
  });

  test('the live-schema fallback still asks Steam in config.language', () => {
    // getMissingAchievements has a branch with nothing stored to choose between, so it is a fetch —
    // and a fetch is the other key's business. Swapping it for uiLanguage would ask Steam for
    // English and store it as Chinese
    assert.match(api, /fetchAchievementSchema\(appid, config\.language\)/);
  });

  test('Setup.html offers exactly the two languages, each written in itself', () => {
    const html = read('Setup.html');
    assert.match(html, /<input type="radio" name="uiLang" value="zh"><span>中文<\/span>/);
    assert.match(html, /<input type="radio" name="uiLang" value="en"><span>English<\/span>/);
    // Each option has to be readable *before* the setting it changes has taken effect, which is
    // the one label on that page that cannot be translated into the language being left
  });

  test('the language control is not hidden behind edit mode', () => {
    // Setup.html is also the first-run page. Somebody who cannot read the wizard needs this
    // control before the wizard, not after finishing it
    const html = strip(read('Setup.html'));
    const block = html.slice(html.indexOf('<div class="lang"'), html.indexOf('</div>', html.indexOf('<div class="lang"')));
    assert.doesNotMatch(block, /hidden/, 'the language group must not start hidden');
    assert.doesNotMatch(html, /isEditMode[^\n]*\.lang\b/, 'and must not be gated on isEditMode');
  });
});

// ---------------------------------------------------------------------------
// Setup.html's own string table
// ---------------------------------------------------------------------------

/** Pull STRINGS out of a page and evaluate just that object — no DOM is involved in the table itself */
function pageStrings(file) {
  const html = read(file);
  const at = html.indexOf('const STRINGS = {');
  assert.ok(at > 0, 'STRINGS is gone from ' + file);
  const open = html.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  // eslint-disable-next-line no-new-func
  return new Function('return ' + html.slice(open, i + 1))();
}

/**
 * The two copies of the i18n mechanism are one copy
 * ------------------------------------------------
 * **Zero dependencies allows no shared script** (CLAUDE.md's stack constraints: no build step, a
 * page is one big string), so `t` / `applyStrings` / `REPAINT` are stored once in each page — the
 * same arrangement the `:root` design tokens already live under, and pinned the same way.
 *
 * Two hand-copied things will certainly diverge, and the divergence is silent: a fix to the slot
 * substitution or the attribute list lands on one page, the other keeps the old behaviour, and
 * nothing anywhere reports it. What is compared is the text with whitespace collapsed — both pages
 * indent this block identically, but a reflow should not be a false alarm.
 */
describe('the i18n mechanism in the two pages is one copy', () => {
  const block = (file) => {
    const html = read(file);
    const a = html.indexOf("    let LANG = 'zh';");
    assert.ok(a > 0, `cannot find the mechanism in ${file}`);
    const b = html.indexOf('function repaintInterpolated', a);
    assert.ok(b > a, `cannot find the end of the mechanism in ${file}`);
    const end = html.indexOf('    }', b) + '    }'.length;
    return html.slice(a, end).replace(/\s+/g, ' ').trim();
  };

  test('Setup.html and Dashboard.html carry the same mechanism', () => {
    const a = block('Setup.html');
    const b = block('Dashboard.html');
    assert.ok(a.length > 800, `only ${a.length} characters were caught; the extraction is broken, not the rule satisfied`);
    assert.equal(a, b,
      'the i18n mechanism has diverged between the two pages — one was fixed and the other forgotten, '
      + 'and the symptom is that a slot stops being substituted, or an attribute stops being repainted, on one page only');
  });
});

for (const PAGE of ['Setup.html', 'Dashboard.html']) describe('the ' + PAGE + ' string table', () => {
  const STRINGS = pageStrings(PAGE);
  const html = read(PAGE);
  const script = strip(html.slice(html.indexOf('<script>', html.indexOf('</style>'))));
  /**
   * The script **with the STRINGS table cut out of it**.
   *
   * Without that cut the "defined but never used" check below is vacuous: every key appears as a
   * quoted literal in the very table that defines it, so the catch-all sweep matches all of them
   * and `keys - used` is empty whatever else is true. Measured — a key wired to nothing passed.
   */
  const scriptNoTable = (() => {
    const at = script.indexOf('const STRINGS = {');
    if (at < 0) return script;
    let depth = 0, i = script.indexOf('{', at);
    for (; i < script.length; i++) {
      if (script[i] === '{') depth++;
      else if (script[i] === '}' && --depth === 0) break;
    }
    return script.slice(0, at) + script.slice(i + 1);
  })();
  const keys = Object.keys(STRINGS);

  test('every entry carries both languages', () => {
    // A one-element entry falls back to Chinese and looks like a working page in English. This is
    // the shape of a half-finished translation, and nothing at runtime reports it
    const bad = keys.filter((k) => {
      const v = STRINGS[k];
      return !Array.isArray(v) || v.length !== 2 || !String(v[0]).length || !String(v[1]).length;
    });
    assert.deepEqual(bad, [], 'these entries are not a [zh, en] pair of non-empty strings');
  });

  test('a slot in one language is a slot in the other', () => {
    // `{n}` dropped from one side does not throw — it renders the brace-less sentence, missing the
    // number it existed to carry
    const slots = (s) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
    const mismatched = keys.filter((k) => slots(STRINGS[k][0]) !== slots(STRINGS[k][1]));
    assert.deepEqual(mismatched, [], 'the two languages of these entries interpolate different things');
  });

  test('every key the page asks for exists', () => {
    const asked = new Set();
    for (const m of script.matchAll(/\bt\('([^']+)'/g)) asked.add(m[1]);
    for (const m of html.matchAll(/data-t(?:-[a-z-]+)?="([^"]+)"/g)) asked.add(m[1]);
    const missing = [...asked].filter((k) => !STRINGS[k]);
    // t() returns the key itself for a miss, so this surfaces on screen as a dotted identifier
    // rather than as an error — visible, but only to whoever happens to open that step
    assert.deepEqual(missing, [], 'these keys are asked for but not defined');
  });

  test('every key defined is used', () => {
    const used = new Set();
    for (const m of script.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-t(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
    // Set through dataset rather than written in the markup
    for (const m of script.matchAll(/dataset\.t = '([^']+)'/g)) used.add(m[1]);
    // Keys are also reached indirectly — `t(cond ? 'a' : 'b')`, a lookup table of keys, a
    // dataset assignment. Rather than enumerate every shape, count a key as used if the script
    // mentions it as a quoted string at all: the question here is whether an entry is dead
    // weight, and a key that appears nowhere in the file certainly is
    for (const m of scriptNoTable.matchAll(/'([a-z][\w.]*)'/g)) used.add(m[1]);
    for (const m of script.matchAll(/setPageCopy\('([^']+)', '([^']*)', '([^']+)'\)/g)) {
      used.add(m[1]); if (m[2]) used.add(m[2]); used.add(m[3]);
    }
    const orphans = keys.filter((k) => !used.has(k));
    assert.deepEqual(orphans, [], 'these entries are translated but never shown — either wire them up or delete them');
  });

  test('no runtime Chinese is left loose in the script', () => {
    // The table is the only place a user-facing string may live now. One left in the code is
    // invisible in Chinese and shows up as a single Chinese line in an otherwise English page
    const at = script.indexOf('const STRINGS = {');
    const open = script.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < script.length; i++) {
      if (script[i] === '{') depth++;
      else if (script[i] === '}' && --depth === 0) break;
    }
    const outside = script.slice(0, at) + script.slice(i + 1);
    const loose = [...outside.matchAll(/'([^'\n]*[一-鿿][^'\n]*)'|`([^`]*[一-鿿][^`]*)`/g)].map((m) => m[1] ?? m[2]);
    assert.deepEqual(loose, [], 'these strings have to move into STRINGS');
  });

  test('every Chinese run in the markup is keyed', () => {
    // <style> has to go first: the CSS comments in this page quote Chinese labels to explain the
    // rules they belong to, and a scan that keeps them is fed by the explanation rather than by
    // the markup — the pit CLAUDE.md records for every source assertion in this repo
    const markup = html
      .slice(0, html.indexOf('<script>', html.indexOf('</style>')))
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const unkeyed = [];
    // Each element that owns Chinese text of its own has to carry data-t, or it is frozen in
    // Chinese however the interface is set
    for (const m of markup.matchAll(/<(\w+)([^>]*)>([^<]*[一-鿿][^<]*)</g)) {
      const [, tag, attrs, text] = m;
      if (tag === 'title') continue;                       // set by applyStrings through docTitleKey
      if (/data-t=/.test(attrs)) continue;
      if (text.trim() === '中文') continue;                 // the language option, written in its own language on purpose
      unkeyed.push(tag + ': ' + text.trim().slice(0, 40));
    }
    assert.deepEqual(unkeyed, [], 'these markup strings are not in the table');
  });
});

/**
 * A guide has a language of its own, and it is **only** a display fact
 * ----------------------------------------------------------------------
 * The column exists so two surfaces can say something true: the achievement panel marks a guide
 * written in the other language, and the rewrite dialog names what it is about to write.
 *
 * **Nothing about matching reads it.** Stage 1 and `paraphrased-description` both accept either
 * language's description, which was chosen precisely so that a wrong value here cannot mis-tick a
 * box — the 115 guides that predate the column carry an assumed value, not a recorded one. The
 * tests below are the counterpart of that decision: they pin the two consumers, and pin that the
 * default is a fact about this library rather than a guess.
 */
describe("a guide's own language", () => {
  const withGuide = (lang) => {
    const db = openDb(':memory:');
    upsertGuide(db, { appid: '400', name: 'Portal', url: 'portal.md', kind: 'local' });
    if (lang) setGuideLang(db, '400', lang);
    return db;
  };

  test('a guide registered before the column existed reads as Chinese', () => {
    // Not a default in the "had to pick something" sense: every guide in this library at the time
    // the column was added was Chinese, so the migration's value is the recorded truth
    assert.equal(getGuide(withGuide(null), '400').lang, 'zh');
  });

  test('the language round-trips, both ways', () => {
    const db = withGuide('en');
    assert.equal(getGuide(db, '400').lang, 'en');
    setGuideLang(db, '400', 'zh');
    assert.equal(getGuide(db, '400').lang, 'zh');
  });

  test('anything that is not en is stored as zh', () => {
    // The column feeds a two-way comparison; a third value would make the marker unreachable
    // rather than wrong, which is the harder failure to notice
    for (const junk of ['EN', 'english', '', null, undefined, 'fr']) {
      assert.equal(getGuide(withGuide(junk), '400').lang, 'zh', String(junk));
    }
  });

  test('writing to an appid with no guide reports that it changed nothing', () => {
    assert.equal(setGuideLang(openDb(':memory:'), '400', 'en'), false);
  });

  describe('the marker in the achievement panel', () => {
    const html = read('Dashboard.html');
    const body = strip(html);

    test('is drawn only when the guide disagrees with the interface', () => {
      // Both halves matter and only one of them is obvious. Rendering it unconditionally would
      // put 「中文攻略」 on every guide in a Chinese interface: a label that is always present is
      // read once and then never again, which is the state this marker exists to escape
      assert.match(body, /data\.guide\.lang\s*&&\s*data\.guide\.lang\s*!==\s*LANG/);
    });

    test('names the guide\'s language rather than the interface\'s', () => {
      assert.match(body, /data\.guide\.lang\s*===\s*'en'\s*\?\s*'ach\.guideLangEn'\s*:\s*'ach\.guideLangZh'/);
    });

    test('both keys name both languages in both halves', () => {
      // The trap this closes: a table holding only 「英文攻略」/「Chinese guide」 reads correctly
      // today purely because of the mismatch condition guarding it. Move the render and the string
      // silently starts lying. Each entry has to be true standing on its own
      const table = html.slice(html.indexOf("'ach.guideLangZh'"), html.indexOf("'ach.searchGuide'"));
      assert.match(table, /'ach\.guideLangZh':\s*\['中文攻略'/);
      assert.match(table, /'ach\.guideLangZh':\s*\[[^\]]*'Chinese guide'\]/);
      assert.match(table, /'ach\.guideLangEn':\s*\['英文攻略'/);
      assert.match(table, /'ach\.guideLangEn':\s*\[[^\]]*'English guide'\]/);
    });

    test('is read in the panel header and nowhere else', () => {
      // Decided rather than overlooked: on the row button it would be one word repeated down the
      // column. Sliced between two real anchors rather than counted — a count is satisfied by the
      // right number of occurrences in the wrong places
      const open = body.indexOf('const hasGuide');
      const close = body.indexOf('class=\"ach-grid\"');
      assert.ok(open > 0 && close > open, 'both anchors still exist');
      const header = body.slice(open, close);
      const reads = [...body.matchAll(/'ach\.guideLang(?:Zh|En)'/g)].map((m) => m.index);
      const table = body.indexOf("'ach.guideLangZh':");
      const outside = reads.filter((i) => (i < table || i > table + 200) && (i < open || i > close));
      assert.deepEqual(outside, [], 'the marker is read outside the panel header');
      assert.match(header, /ach\.guideLang/, 'and it really is read inside it');
    });
  });

  describe('the rewrite dialog', () => {
    const body = strip(read('Dashboard.html'));

    // That it goes in the **title** rather than a new sentence is html-smoke.test.js's
    // 「the rewrite confirmation writes no body」, which owns that claim for every dialog
    test('names the language when the existing guide is in the other one', () => {
      assert.match(body, /p\.existing\.lang\s*!==\s*LANG\s*\?\s*'rw\.titleLang'\s*:\s*'rw\.title'/);
    });

  });

  test('the panel is handed the language, defaulted at the boundary', () => {
    // `guides.lang` is NOT NULL DEFAULT 'zh', so the `|| 'zh'` is for a row that predates the
    // migration in someone else's restored backup rather than for a column that can be null
    assert.match(strip(read('lib/api.js')), /lang:\s*guideRow\.lang\s*\|\|\s*'zh'/);
    assert.match(strip(read('lib/server.js')), /lang:\s*plan\.existing\.lang\s*\|\|\s*'zh'/);
  });
});
