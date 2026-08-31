/**
 * The English achievement description, and the one pass that backfills it
 * ------------------------------------------------
 * Run with: node --test
 *
 * `fetchGameSchema` fetches the achievement schema **twice**, once per language, and has always
 * kept both names from it. It kept only the Chinese description. The English one arrived in the
 * same response and was dropped on the floor — the third instance of a pattern this repository has
 * now hit three times (see #86: game names owned, game names unowned, and this).
 *
 * Two things make it worth its own file rather than a line in the sync tests:
 *
 * - **The backfill has to reach games phase three otherwise skips.** A game at 100% is skipped
 *   because it needs no checklist, and on a library that has been played a while those are most of
 *   it. Gating the backfill the same way would leave the majority of the library with English
 *   names above Chinese descriptions, which is the exact state the column exists to prevent.
 * - **The backfill has to stop.** Its predicate is what decides whether one pass is enough or
 *   whether a game is re-fetched on every sync forever, and the difference is invisible — both
 *   spellings look like working code and produce a correct database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, replaceAchievements, achievementsFor, insertGame, updateGameStats,
  markNoAchievements, appIdsMissingEnglishDescriptions } from '../lib/db.js';
import { fetchGameSchema, selectSchemaTargets } from '../lib/sync.js';

/** One achievement as GetSchemaForGame returns it */
const ach = (name, displayName, description, extra = {}) => ({ name, displayName, description, icon: 'i.jpg', ...extra });

/** A Steam stub for fetchGameSchema: one schema per language, and a record of what was asked for */
function fakeSteam(schemas) {
  const asked = [];
  return {
    asked,
    delay: 0,
    async fetchAchievementSchema(appid, lang) {
      asked.push(`${appid}:${lang}`);
      return schemas[lang] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

describe('achievements.description_en', () => {
  test('an existing database gains the column, and its rows read "" rather than NULL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'descen-'));
    const path = join(dir, 'old.db');
    try {
      // The achievements table as it stood before the column existed
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE achievements (
        appid TEXT NOT NULL, api_name TEXT NOT NULL, game_name TEXT, name_cn TEXT, name_en TEXT,
        description TEXT, hidden INTEGER NOT NULL DEFAULT 0, icon TEXT,
        PRIMARY KEY (appid, api_name)
      )`);
      old.exec(`INSERT INTO achievements (appid, api_name, name_cn, description)
                VALUES ('1', 'A', '第一个', '解锁第一个成就。')`);
      old.close();

      const db = openDb(path);
      const cols = db.prepare('PRAGMA table_info(achievements)').all().map((c) => c.name);
      assert.ok(cols.includes('description_en'), 'the migration did not add the column');
      // NULL and '' would be two spellings of one fact, and the backfill predicate below tests
      // exactly this column — a NULL there makes `<> ''` neither true nor false
      assert.equal(achievementsFor(db, '1')[0].description_en, '');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replaceAchievements stores it, and omitting it is ""', () => {
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [
      { apiName: 'A', nameCn: '第一个', nameEn: 'The First', description: '解锁。', descriptionEn: 'Unlock it.' },
      { apiName: 'B', nameCn: '第二个', nameEn: 'The Second', description: '再来一次。' },
    ]);
    const [a, b] = achievementsFor(db, '1').sort((x, y) => x.api_name.localeCompare(y.api_name));
    assert.equal(a.description_en, 'Unlock it.');
    assert.equal(b.description_en, '', 'an unknown English description is empty, never a copy of the Chinese one');
    assert.equal(b.description, '再来一次。', 'and the Chinese one is untouched by its absence');
  });
});

// ---------------------------------------------------------------------------
// Filling it
// ---------------------------------------------------------------------------

describe('fetchGameSchema keeps the English description', () => {
  const schemas = {
    schinese: [ach('A', '下降尘凡第一难', '听罢老猴子的故事,该起程了。')],
    english: [ach('A', 'Home is Behind', 'The old monkey has told his tale. Onward')],
  };

  test('both descriptions are stored, from the two schemas already being fetched', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam(schemas);

    assert.equal(await fetchGameSchema(db, steam, { appid: '2358720', name: '黑神话:悟空' }), true);

    const [a] = achievementsFor(db, '2358720');
    assert.equal(a.description, '听罢老猴子的故事,该起程了。');
    assert.equal(a.description_en, 'The old monkey has told his tale. Onward');
    // The point of the whole change: the English schema was already being fetched for the name
    assert.deepEqual(steam.asked, ['2358720:schinese', '2358720:english']);
  });

  test('a hidden achievement is blank in both languages — the description is the spoiler either way', async () => {
    const db = openDb(':memory:');
    await fetchGameSchema(db, fakeSteam({
      schinese: [ach('A', '隐藏的', '剧透内容', { hidden: 1 })],
      english: [ach('A', 'Hidden One', 'A spoiler', { hidden: 1 })],
    }), { appid: '1', name: 'G' });

    const [a] = achievementsFor(db, '1');
    assert.equal(a.description, '');
    assert.equal(a.description_en, '', 'blanking only the Chinese half would publish the spoiler in English');
  });

  test('an achievement the English schema does not carry gets "", not the Chinese description', async () => {
    const db = openDb(':memory:');
    await fetchGameSchema(db, fakeSteam({
      schinese: [ach('A', '第一个', '中文描述'), ach('B', '第二个', '另一段中文')],
      english: [ach('A', 'The First', 'An English description')],
    }), { appid: '1', name: 'G' });

    const b = achievementsFor(db, '1').find((r) => r.api_name === 'B');
    assert.equal(b.description_en, '');
    assert.equal(b.description, '另一段中文');
  });

  test('no English schema at all still stores the Chinese one', async () => {
    const db = openDb(':memory:');
    // fetchAchievementSchema returns null on a failed request; the Chinese half must not be lost
    // with it, and the game must still count as fetched
    assert.equal(
      await fetchGameSchema(db, fakeSteam({ schinese: [ach('A', '第一个', '中文描述')], english: null }), { appid: '1', name: 'G' }),
      true
    );
    const [a] = achievementsFor(db, '1');
    assert.equal(a.description, '中文描述');
    assert.equal(a.description_en, '');
  });
});

// ---------------------------------------------------------------------------
// The backfill: which games it reaches, and that it stops
// ---------------------------------------------------------------------------

/** A game plus its stored achievements, in one line */
function withGame(db, appid, { rate = 0.5, total = 2, rows = [] } = {}) {
  insertGame(db, { appid, name: 'G' + appid });
  updateGameStats(db, appid, { achieved: Math.round(rate * total), total });
  if (rows.length) replaceAchievements(db, appid, rows);
}

const ids = (db) => selectSchemaTargets(db).map((g) => g.appid).sort();

describe('selectSchemaTargets — the backfill reason', () => {
  test('a game whose stored detail predates the column is a target', () => {
    const db = openDb(':memory:');
    withGame(db, '1', { rows: [{ apiName: 'A', description: '中文描述' }] });
    assert.deepEqual(ids(db), ['1']);
    assert.deepEqual([...appIdsMissingEnglishDescriptions(db)], ['1']);
  });

  test('**even at 100%** — the description shows whether or not the game is finished', () => {
    const db = openDb(':memory:');
    withGame(db, '1', { rate: 1, total: 2, rows: [{ apiName: 'A', description: '中文描述' }] });
    // Without this, a played-through library keeps Chinese descriptions under English names for
    // most of its rows, and the completed games are exactly the ones with guides written for them
    assert.deepEqual(ids(db), ['1'], 'the 100% skip must not apply to the one-time backfill');
  });

  test('once filled it stops being a target', () => {
    const db = openDb(':memory:');
    withGame(db, '1', { rate: 1, total: 2, rows: [{ apiName: 'A', description: '中文描述', descriptionEn: 'English' }] });
    assert.deepEqual(ids(db), []);
  });

  test('one English description is enough for the whole game', () => {
    const db = openDb(':memory:');
    // Steam does not always answer for every achievement. Testing this per row rather than per
    // game would put this game back in the queue on every sync, forever, for the one that is blank
    withGame(db, '1', { rate: 1, total: 2, rows: [
      { apiName: 'A', description: '中文描述', descriptionEn: 'English' },
      { apiName: 'B', description: '另一段中文' },
    ] });
    assert.deepEqual(ids(db), []);
  });

  test('a game of nothing but hidden achievements is not dragged in', () => {
    const db = openDb(':memory:');
    // Hidden rows are '' in both languages by design, so "has Chinese but no English" is false
    // for them — otherwise every such game would be re-fetched on every sync
    withGame(db, '1', { rate: 1, total: 2, rows: [{ apiName: 'A', description: '', hidden: 1 }] });
    assert.deepEqual(ids(db), []);
  });
});

describe('selectSchemaTargets — the gates that were already there', () => {
  test('a game with no detail stored yet is a target', () => {
    const db = openDb(':memory:');
    withGame(db, '1');
    assert.deepEqual(ids(db), ['1']);
  });

  test('a finished game with its detail already stored is not', () => {
    const db = openDb(':memory:');
    withGame(db, '1', { rate: 1, total: 2, rows: [{ apiName: 'A', description: '中文', descriptionEn: 'en' }] });
    assert.deepEqual(ids(db), []);
  });

  test('a game with no achievement system is never a target, even holding rows that want backfilling', () => {
    const db = openDb(':memory:');
    withGame(db, '1', { rows: [{ apiName: 'A', description: '中文描述' }] });
    // **This state is reachable**: markNoAchievements leaves the achievement rows alone, so a game
    // synced once and later reported by Steam as having no achievement system keeps Chinese-only
    // descriptions on disk forever. There is no schema left to fetch, so the has_achievements gate
    // has to be tested **before** the backfill reason — behind it, this game becomes a target on
    // every sync, never fills, and never stops
    markNoAchievements(db, '1');
    assert.ok(appIdsMissingEnglishDescriptions(db).has('1'), 'the rows really do still want backfilling');
    assert.deepEqual(ids(db), []);
  });

  test('a recent achievement-count rise still forces a refresh', () => {
    const db = openDb(':memory:');
    withGame(db, '1', { rate: 0.5, total: 2, rows: [{ apiName: 'A', description: '中文', descriptionEn: 'en' }] });
    updateGameStats(db, '1', { achieved: 1, total: 5 });   // stamps new_ach_date
    assert.deepEqual(ids(db), ['1']);
  });
});
