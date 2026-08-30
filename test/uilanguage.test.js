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
import { openDb, insertGame } from '../lib/db.js';

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
