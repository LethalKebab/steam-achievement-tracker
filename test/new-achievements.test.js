/**
 * Which achievements a patch added
 * ------------------------------------------------
 * Run with: node --test
 *
 * The bell says a game's achievement total went up; this is what says **which** achievements are
 * the new ones. It rests on one stamp — `achievements.first_seen`, written when a row is first
 * inserted and never after — and on reading it the right way: a game's first schema sync writes its
 * whole set in one moment, so anything stamped later arrived with an update.
 *
 * Every failure here is silent, and each has a different shape:
 *  - a stamp that moves on a description refresh makes a game's whole set look newly added;
 *  - a stamp never written leaves the panel with nothing to mark, while the bell still says there
 *    is something new;
 *  - a NULL read as "recent" marks every achievement in a library that predates the column.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { openDb, replaceAchievements, achievementsFor } from '../lib/db.js';
import { createApi } from '../lib/api.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ach = (apiName) => ({ apiName, nameCn: apiName, nameEn: apiName, description: 'd' });
const stamp = (db, appid, apiName) =>
  db.prepare('SELECT first_seen FROM achievements WHERE appid = ? AND api_name = ?').get(appid, apiName).first_seen;
const OLD = '2026-01-01T00:00:00.000Z';

describe('the first-seen stamp', () => {
  test('a new row gets it, and a refresh of an existing row leaves it where it was', () => {
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [ach('A')]);
    assert.ok(stamp(db, '1', 'A'), 'an inserted row has to record when it appeared');
    db.prepare("UPDATE achievements SET first_seen = ? WHERE appid = '1'").run(OLD);
    // The same achievement arriving again, as every description refresh delivers it
    replaceAchievements(db, '1', [{ ...ach('A'), description: 'reworded' }]);
    assert.equal(stamp(db, '1', 'A'), OLD,
      'a refresh moved the stamp, so every game would look as if its whole set had just been added');
    assert.equal(achievementsFor(db, '1')[0].description, 'reworded', 'while the text itself is still refreshed');
  });

  test("one call writes one moment, so a game's original set shares a single stamp", () => {
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [ach('A'), ach('B'), ach('C')]);
    const stamps = new Set(achievementsFor(db, '1').map((r) => r.first_seen));
    assert.equal(stamps.size, 1, 'the set a game shipped with has to be one moment, or part of it reads as added later');

    // **The line above cannot see the edit worth guarding against**: clock reads a microsecond apart
    // nearly always land in the same millisecond, so it stays green whether the call reads the clock
    // once or once per row. What has to hold is structural
    const src = readFileSync(join(ROOT, 'lib', 'db.js'), 'utf8');
    const open = src.indexOf('export function replaceAchievements');
    const close = src.indexOf('export function', open + 10);
    assert.ok(open !== -1 && close > open, 'both anchors must exist, or the slice below is vacuous');
    const body = src.slice(open, close)
      // Line comments first: a `//` here can hold a `/*`, and the other order eats code
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((body.match(/nowIso\(\)/g) ?? []).length, 1, 'replaceAchievements reads the clock once per call');
  });

  test('an existing database gains the column, and its rows stay unknown rather than new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'firstseen-'));
    try {
      const path = join(dir, 'steam.db');
      // A database from before the column: the achievements table as it first stood
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE achievements (appid TEXT NOT NULL, api_name TEXT NOT NULL, game_name TEXT,
        name_cn TEXT, name_en TEXT, description TEXT, hidden INTEGER NOT NULL DEFAULT 0, icon TEXT,
        PRIMARY KEY (appid, api_name))`);
      old.prepare("INSERT INTO achievements (appid, api_name) VALUES ('1', 'A')").run();
      old.close();

      const db = openDb(path);
      assert.equal(stamp(db, '1', 'A'), null,
        'a row that predates the column has no recorded moment, and guessing one would mark the whole library new');
      replaceAchievements(db, '1', [ach('A'), ach('B')]);
      assert.equal(stamp(db, '1', 'A'), null, 'a refresh must not invent a moment for it either');
      assert.ok(stamp(db, '1', 'B'), 'while an addition written since is stamped');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the panel marks as added', () => {
  // getMissingAchievements through the real API with only Steam replaced. Every achievement below is
  // locked, so each one is in the list and each one's flag is on show
  const api = (db, apiNames) => createApi({
    db,
    config: { uiLanguage: 'en', language: 'english' },
    steam: {
      fetchPlayerAchievements: async () => ({ achievements: apiNames.map((apiname) => ({ apiname, achieved: 0 })) }),
    },
  });
  const flags = async (db, apiNames) => {
    const r = await api(db, apiNames).getMissingAchievements('1');
    return Object.fromEntries(r.missing.map((m) => [m.name, m.addedDaysAgo]));
  };

  test('the set a game shipped with is not new', async () => {
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [ach('A'), ach('B')]);
    assert.deepEqual(await flags(db, ['A', 'B']), { A: null, B: null });
  });

  test('an achievement added later is, with how long ago it arrived', async () => {
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [ach('A'), ach('B')]);
    db.prepare("UPDATE achievements SET first_seen = ? WHERE appid = '1'").run(OLD);
    replaceAchievements(db, '1', [ach('A'), ach('B'), ach('C')]);
    assert.deepEqual(await flags(db, ['A', 'B', 'C']), { A: null, B: null, C: 0 });
  });

  test('an addition to a game whose rows predate the stamp is still new', async () => {
    // How an existing library looks after the migration: the original rows have no moment at all
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [ach('A'), ach('B')]);
    db.prepare("UPDATE achievements SET first_seen = NULL WHERE appid = '1'").run();
    replaceAchievements(db, '1', [ach('A'), ach('B'), ach('C')]);
    assert.deepEqual(await flags(db, ['A', 'B', 'C']), { A: null, B: null, C: 0 });
  });

  test('nothing is new in a game that predates the stamp and has had no addition since', async () => {
    const db = openDb(':memory:');
    replaceAchievements(db, '1', [ach('A'), ach('B')]);
    db.prepare("UPDATE achievements SET first_seen = NULL WHERE appid = '1'").run();
    assert.deepEqual(await flags(db, ['A', 'B']), { A: null, B: null },
      'a NULL read as recent would mark every achievement in the library');
  });
});
