/**
 * The per-game 「已隐藏」 mark
 * ------------------------------------------------
 * One boolean on `games`, in the same family as favorite / priority / family, that keeps a row
 * out of the Dashboard's table.
 *
 * **What this file is really guarding is how little the mark does.** It was deliberately scoped
 * to the table and nothing else: the readings in the top-right corner still count a hidden game,
 * the rotating sweep still reconciles it against Steam, and Steam is never told. Each of those is
 * a place where "surely a hidden game shouldn't count" is a plausible-sounding change that would
 * silently alter numbers the reader trusts, so each is pinned here rather than left to memory.
 *
 * The chip itself (its position, and that it starts excluded) is pinned in `html-smoke`, next to
 * the other five.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, insertGame, updateGameStats, setGameField, getGame } from '../lib/db.js';
import { exportAll } from '../lib/csv.js';

const DIR = mkdtempSync(join(tmpdir(), 'hidden-'));
process.env.TRACKER_DATA_DIR = DIR;
writeFileSync(join(DIR, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y' }));
const { createApi } = await import('../lib/api.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const apiFor = (db) => createApi({
  db, steam: {}, config: { uiLanguage: 'zh' }, syncState: { snapshot: () => ({}) },
  startBackgroundSync: null, guideGenState: null, startGuideGen: null,
  planGuidePreflight: null, maybeAutoSync: null,
});

function env() {
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: 'kept' });
  insertGame(db, { appid: '2', name: 'hiddenOne' });
  updateGameStats(db, '1', { achieved: 12, total: 20 });
  updateGameStats(db, '2', { achieved: 8, total: 8 });
  return { db, api: apiFor(db) };
}

describe('the column', () => {
  test('an existing database gains it, defaulting to not hidden', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidmig-'));
    const path = join(dir, 'old.db');
    try {
      // The games table as it stood before the mark existed
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE games (
        appid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', achieved INTEGER, total INTEGER,
        has_achievements INTEGER, rate REAL, status TEXT NOT NULL DEFAULT '',
        sync_locked INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0, family INTEGER NOT NULL DEFAULT 0,
        new_ach_date TEXT, updated_at TEXT
      )`);
      old.exec("INSERT INTO games (appid, name) VALUES ('7', '旧库里的游戏')");
      old.close();

      const db = openDb(path);
      const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
      assert.ok(cols.includes('hidden'), 'the migration did not add the column');
      // 0 rather than NULL: every reader treats this as a boolean, and a NULL would leave an
      // upgraded library's rows neither hidden nor shown until something wrote to each one
      assert.equal(getGame(db, '7').hidden, 0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setGameField lets it through — that allow-list is the injection gate, not a formality', () => {
    const { db } = env();
    // Without the registration the write throws at runtime and the toggle is dead on arrival,
    // which no type or build step would have caught
    assert.doesNotThrow(() => setGameField(db, '1', 'hidden', 1));
    assert.equal(getGame(db, '1').hidden, 1);
  });
});

describe('toggleHidden', () => {
  test('flips, persists, and reports the value it settled on', () => {
    const { db, api } = env();
    assert.deepEqual(api.toggleHidden('2'), { hidden: true });
    assert.equal(getGame(db, '2').hidden, 1);
    assert.deepEqual(api.toggleHidden('2'), { hidden: false });
    assert.equal(getGame(db, '2').hidden, 0);
  });

  test('an unknown appid is an error rather than a silent no-op', () => {
    const { api } = env();
    assert.ok(api.toggleHidden('999').error, 'a toggle on a row that is not there has to say so');
  });

  test('the mark reaches the Dashboard on every row, hidden or not', () => {
    const { api } = env();
    api.toggleHidden('2');
    const rows = api.getDashboardData().games;
    // **Both rows are still sent.** The filtering happens in the browser, against this field —
    // dropping hidden rows here instead would make them unreachable, since the 「已隐藏」 chip has
    // nothing to reveal if the row never arrived
    assert.equal(rows.length, 2);
    assert.equal(rows.find((g) => g.appid === '1').hidden, false);
    assert.equal(rows.find((g) => g.appid === '2').hidden, true);
  });
});

describe('what hiding deliberately does not touch', () => {
  test('the four readings count a hidden game exactly as before', () => {
    const { api } = env();
    const before = api.getDashboardData();
    api.toggleHidden('2');
    const after = api.getDashboardData();
    // 「已隐藏」 is a statement about the table, not about the library. Making the readings follow
    // it is the tempting change: it would mean hiding a game silently moved the completion
    // average, and a number that moves when you tidy the view is a number nobody can trust
    assert.equal(after.totalGames, before.totalGames);
    assert.equal(after.achievedTotal, before.achievedTotal);
    assert.equal(after.avgRounded, before.avgRounded);
    assert.equal(after.perfectCount, before.perfectCount);
  });

  test('it is orthogonal to sync_locked, which is the column that actually stops a sync', () => {
    const { db, api } = env();
    api.toggleHidden('1');
    // The same separation `status` and `sync_locked` already keep: one is what you see, the other
    // is what runs. A hidden game goes on being reconciled, so unhiding it never shows stale data
    assert.equal(getGame(db, '1').sync_locked, 0);
  });

  test('the CSV carries it, appended so the existing column order is unchanged', () => {
    const { db, api } = env();
    api.toggleHidden('2');
    const dir = mkdtempSync(join(tmpdir(), 'hidcsv-'));
    try {
      exportAll(db, dir);
      const rows = readFileSync(join(dir, 'RAW DATA.csv'), 'utf8').trim().split('\n');
      const header = rows[0].split(',');
      const last = header.length - 1;
      assert.equal(header[last], '已隐藏', 'the new column has to be the last one');
      assert.equal(header.indexOf('喜爱'), 6, 'an existing column moved — the export is read by position');
      const byName = Object.fromEntries(rows.slice(1).map((r) => [r.split(',')[2], r.split(',')]));
      assert.equal(byName.hiddenOne[last], 'TRUE');
      assert.equal(byName.kept[last], 'FALSE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Dashboard wiring', () => {
  const page = read('Dashboard.html');

  test('the row menu offers the toggle, and names the direction this row goes', () => {
    // A single 「隐藏」 that toggles would be one word for two opposite outcomes, on a control
    // most people meet once per game
    assert.ok(page.includes("game.hidden ? t('menu.unhide') : t('menu.hide')"),
      'the menu label has to branch on the row it opened over');
    assert.ok(page.includes('toggleHiddenFlag(appid)'), 'the menu item has to call the toggle');
  });

  test('the toggle puts the mark back when the write fails', () => {
    // Optimistic, like the family toggle beside it: a mark that appears to take and is then gone
    // on the next reload is worse than one that visibly refuses
    const at = page.indexOf('function toggleHiddenFlag(');
    assert.ok(at > 0, 'cannot find toggleHiddenFlag');
    const body = page.slice(at, page.indexOf('.toggleHidden(appid)', at));
    assert.ok(body.includes('withFailureHandler'), 'a failed write has to be handled');
    assert.ok(body.includes('game.hidden = !game.hidden;'),
      'the failure path has to flip the mark back');
    assert.ok(body.lastIndexOf('render();') > body.indexOf('withFailureHandler'),
      'and repaint, or the row stays gone while the database says otherwise');
  });
});
