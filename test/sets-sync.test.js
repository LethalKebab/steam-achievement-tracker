/**
 * Achievement sets: storing them, deciding which games to ask, and keeping out of everything else
 * ------------------------------------------------
 * Run with: node --test
 *
 * The feature records what Steam says about a game's sets and draws it. It is deliberately **not**
 * allowed to move anything the library already reports: `total`, `achieved`, `rate`, the average
 * completion rate, the 🔔 notices. The one reading that follows the sets is the completed count, and
 * a test below pins that it alone does. Recording is additive, and "additive" is the claim that most
 * needs a test, because a column written to the wrong row or a stamp that moves `updated_at` breaks
 * nothing that fails loudly.
 *
 * Three more things are easy to get wrong and invisible when they are:
 *  - **A failed request must not look like an answer.** A stamp written for a game that was never
 *    read hides it for a week.
 *  - **The pass has to stop.** The predicate that picks games decides whether one pass is enough or
 *    whether every game is re-asked on every sync, and both spellings produce a correct database.
 *  - **The phase is a supplement.** Sets are beta data on a shape that may still change; the phase
 *    failing must never turn a sync that landed its numbers into 「同步失败」.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb, insertGame, updateGameStats, allGames, getGame, deleteGame, replaceAchievements,
  replaceAchievementSets, achievementSetsFor, achievementSetMembersFor, allAchievementSets, countGamesWithSets,
} from '../lib/db.js';
import {
  selectSetsTargets, syncAchievementSets, fullSync, computeAgcrStats, SETS_STALE_DAYS, SETS_BREAKER,
} from '../lib/sync.js';
import { createApi } from '../lib/api.js';

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

/** A game the stats phase has already read: has_achievements = 1, which is what makes it a candidate */
function game(db, appid, { achieved = 1, total = 4, locked = false } = {}) {
  insertGame(db, { appid, name: 'G' + appid, nameEn: 'G' + appid, syncLocked: locked ? 1 : 0 });
  updateGameStats(db, appid, { achieved, total });
}
const stampSets = (db, appid, at) => db.prepare('UPDATE games SET sets_checked_at = ? WHERE appid = ?').run(at, appid);
const stampStats = (db, appid, at) => db.prepare('UPDATE games SET stats_checked_at = ? WHERE appid = ?').run(at, appid);

/** A stored row, as `buildSetRows` makes one */
const ROW = (setId, extra = {}) => ({
  setId, nameEn: 'S' + setId, nameCn: '', dlcAppid: null, position: 0, total: 5, need: 5,
  archived: false, visible: true, achievable: true, done: 0, completed: false, completedAt: null, ...extra,
});
/** Two stored sets for a game, read at `at` */
const storeSets = (db, appid, at) => replaceAchievementSets(db, appid, [ROW(0), ROW(1)], at);

/** A set as `parseGameSets` returns it */
const S = (id, name, extra = {}) => ({
  id, name, dlcAppid: null, position: 0, total: 10, need: 10, archived: false, visible: true, ...extra,
});
const OWN = (done = 0, extra = {}) => ({ achievable: true, done, completed: false, completedAt: null, ...extra });

/**
 * A Steam stub for the sets phase. `sets[appid]` is the English reply; `names[appid]` maps set id to
 * its Chinese name; `members[appid]` lists `[internal name, set id]` for the achievements the reply
 * files under a set. `fail` lists appids whose requests answer null, and `failOn` names which request.
 */
function fakeSteam({ sets = {}, names = {}, progress = {}, members = {}, fail = [], failOn = null } = {}) {
  const asked = [];
  const down = (appid, kind) => fail.includes(appid) && (!failOn || failOn === kind);
  return {
    asked,
    delay: 0,
    async fetchAchievementSets(appid, language) {
      asked.push(`sets:${appid}:${language}`);
      if (down(appid, language)) return null;
      const base = sets[appid] ?? [S(0, '')];
      return {
        sets: language === 'schinese' ? base.map((s) => ({ ...s, name: names[appid]?.[s.id] ?? s.name })) : base,
        members: new Map(members[appid] ?? []),
      };
    },
    async fetchAchievementSetProgress(appid) {
      asked.push(`progress:${appid}`);
      if (down(appid, 'progress')) return null;
      return progress[appid] ?? new Map((sets[appid] ?? [S(0, '')]).map((s) => [s.id, OWN()]));
    },
  };
}

const TWO_SETS = [S(0, '', { total: 40, need: 40 }), S(1, 'The Pale Reach', { dlcAppid: '2561440', total: 8, need: 8 })];

// ---------------------------------------------------------------------------
// The table and the column
// ---------------------------------------------------------------------------

describe('the storage', () => {
  test('a new database has the table and the games column', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(achievement_sets)').all().map((c) => c.name);
    for (const c of ['appid', 'set_id', 'name_en', 'name_cn', 'dlc_appid', 'position', 'total', 'need',
      'archived', 'visible', 'achievable', 'done', 'completed', 'completed_at', 'checked_at']) {
      assert.ok(cols.includes(c), `achievement_sets has no ${c} column`);
    }
    assert.ok(db.prepare('PRAGMA table_info(games)').all().some((c) => c.name === 'sets_checked_at'));
  });

  test('an existing database gains the column, and its games read as never checked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sets-old-'));
    try {
      const path = join(dir, 'steam.db');
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE games (appid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', achieved INTEGER, total INTEGER,
        has_achievements INTEGER, rate REAL, status TEXT NOT NULL DEFAULT '', sync_locked INTEGER NOT NULL DEFAULT 0)`);
      old.exec("INSERT INTO games (appid, name, achieved, total, has_achievements, rate) VALUES ('1', 'Old', 3, 4, 1, 0.75)");
      old.close();

      const db = openDb(path);
      const g = getGame(db, '1');
      assert.equal(g.sets_checked_at, null, 'a row that predates the column has never been asked');
      assert.deepEqual(selectSetsTargets(db).map((x) => x.appid), ['1'], 'and so it is asked on the next sync');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replacing a game\'s sets writes the rows and stamps the game with the same moment', () => {
    const db = openDb(':memory:');
    game(db, '1');
    const at = '2026-10-15T12:00:00.000Z';
    replaceAchievementSets(db, '1', [
      { setId: 0, nameEn: '', nameCn: '', dlcAppid: null, position: 0, total: 40, need: 40, archived: false, visible: true,
        achievable: true, done: 40, completed: true, completedAt: 1700000000 },
      { setId: 1, nameEn: 'The Pale Reach', nameCn: '皓寒之渚', dlcAppid: '2561440', position: 0, total: 8, need: 8, archived: false,
        visible: true, achievable: false, done: 0, completed: false, completedAt: null },
    ], at);
    const rows = achievementSetsFor(db, '1');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.checked_at), [at, at]);
    assert.equal(getGame(db, '1').sets_checked_at, at, 'the stamp and the rows are one reading');
    assert.deepEqual(
      [rows[1].name_cn, rows[1].dlc_appid, rows[1].achievable, rows[1].completed, rows[0].completed, rows[0].completed_at],
      ['皓寒之渚', '2561440', 0, 0, 1, 1700000000],
      'booleans are stored as 0/1 and the completion time as Steam\'s own seconds'
    );
  });

  test('replacing drops a set the developer removed and keeps the others', () => {
    const db = openDb(':memory:');
    game(db, '1');
    const row = (setId) => ({ setId, nameEn: 'S' + setId, nameCn: '', dlcAppid: null, position: 0, total: 5, need: 5,
      archived: false, visible: true, achievable: true, done: 0, completed: false, completedAt: null });
    replaceAchievementSets(db, '1', [row(0), row(1), row(2)]);
    replaceAchievementSets(db, '1', [row(0), row(2)]);
    assert.deepEqual(achievementSetsFor(db, '1').map((r) => r.set_id), [0, 2]);
  });

  test('replacing with nothing clears the rows and still stamps — "no sets" is an answer', () => {
    const db = openDb(':memory:');
    game(db, '1');
    replaceAchievementSets(db, '1', [{ setId: 0, nameEn: '', nameCn: '', dlcAppid: null, position: 0, total: 5, need: 5,
      archived: false, visible: true, achievable: true, done: 0, completed: false, completedAt: null }]);
    replaceAchievementSets(db, '1', [], '2026-10-16T00:00:00.000Z');
    assert.equal(achievementSetsFor(db, '1').length, 0);
    assert.equal(getGame(db, '1').sets_checked_at, '2026-10-16T00:00:00.000Z');
  });

  test('another game\'s sets are left alone', () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    const row = { setId: 0, nameEn: '', nameCn: '', dlcAppid: null, position: 0, total: 5, need: 5, archived: false,
      visible: true, achievable: true, done: 0, completed: false, completedAt: null };
    replaceAchievementSets(db, '1', [row]);
    replaceAchievementSets(db, '2', [row, { ...row, setId: 1 }]);
    replaceAchievementSets(db, '1', []);
    assert.equal(achievementSetsFor(db, '2').length, 2);
    assert.equal(allAchievementSets(db).length, 2);
  });

  test('writing sets moves nothing else on the games row, not even updated_at', () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 3, total: 10 });
    db.prepare("UPDATE games SET updated_at = '2026-01-01T00:00:00.000Z' WHERE appid = '1'").run();
    const before = { ...getGame(db, '1') };
    replaceAchievementSets(db, '1', []);
    const after = { ...getGame(db, '1') };
    delete before.sets_checked_at; delete after.sets_checked_at;
    assert.deepEqual(after, before, '`updated_at` means the data changed, and a set being read is not a change to the count');
  });

  test('a write that fails leaves the previous rows and the previous stamp, never half of the new ones', () => {
    const db = openDb(':memory:');
    game(db, '1');
    storeSets(db, '1', '2026-10-01T00:00:00.000Z');
    // The same set twice: the second insert fails after the first has already gone in
    assert.throws(() => replaceAchievementSets(db, '1', [ROW(5), ROW(5)], '2026-10-09T00:00:00.000Z'), /UNIQUE/);
    assert.deepEqual(achievementSetsFor(db, '1').map((r) => r.set_id), [0, 1], 'the old rows were replaced by part of the new');
    assert.equal(getGame(db, '1').sets_checked_at, '2026-10-01T00:00:00.000Z', 'the stamp moved with a write that did not land');
  });

  test('a game that is not in the table gets nothing written for it', () => {
    const db = openDb(':memory:');
    assert.equal(replaceAchievementSets(db, '404', [ROW(0), ROW(1)]), false);
    assert.equal(allAchievementSets(db).length, 0, 'sets for a game that is not there are counted and never drawn');
  });

  test('deleting a game deletes its sets, so a game added again is not shown them as current', () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    storeSets(db, '1', ago(1));
    storeSets(db, '2', ago(1));
    assert.equal(deleteGame(db, '1'), true);
    assert.deepEqual([...new Set(allAchievementSets(db).map((r) => r.appid))], ['2']);
  });

  test('games with sets are counted through the games table, so a leftover row is not', () => {
    const db = openDb(':memory:');
    game(db, '1');
    storeSets(db, '1', ago(1));
    db.prepare("INSERT INTO achievement_sets (appid, set_id, checked_at) VALUES ('gone', 0, 'x')").run();
    assert.equal(countGamesWithSets(db), 1);
  });
});

// ---------------------------------------------------------------------------
// Which games are asked
// ---------------------------------------------------------------------------

describe('selectSetsTargets', () => {
  const ids = (db, opts) => selectSetsTargets(db, opts).map((g) => g.appid).sort();

  test('a game the stats phase has read, and nobody has asked about, is a target', () => {
    const db = openDb(':memory:');
    game(db, '1');
    assert.deepEqual(ids(db), ['1']);
  });

  test('a game with no achievement system, or no reading yet, is not', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'Unread' });
    insertGame(db, { appid: '2', name: 'None' });
    db.prepare('UPDATE games SET has_achievements = 0 WHERE appid = ?').run('2');
    assert.deepEqual(ids(db), []);
  });

  test('a locked row is never touched by any sync phase, this one included', () => {
    const db = openDb(':memory:');
    game(db, '1', { locked: true });
    assert.deepEqual(ids(db), []);
  });

  test('a game asked within the window is not asked again', () => {
    const db = openDb(':memory:');
    game(db, '1');
    stampSets(db, '1', ago(SETS_STALE_DAYS - 1));
    assert.deepEqual(ids(db), []);
  });

  test('a game asked longer ago than the window is, oldest first, and only up to the budget', () => {
    const db = openDb(':memory:');
    for (const [id, days] of [['1', SETS_STALE_DAYS + 3], ['2', SETS_STALE_DAYS + 9], ['3', SETS_STALE_DAYS + 5], ['4', SETS_STALE_DAYS + 1]]) {
      game(db, id);
      stampSets(db, id, ago(days));
    }
    assert.deepEqual(selectSetsTargets(db, { refreshBudget: 2 }).map((g) => g.appid), ['2', '3'],
      'the two longest overdue — the cap spreads the refreshes so they do not all fall due together again');
  });

  test('the budget caps the refreshes and never the games nobody has asked about', () => {
    const db = openDb(':memory:');
    for (const id of ['1', '2', '3']) game(db, id);          // never asked
    game(db, '4'); stampSets(db, '4', ago(SETS_STALE_DAYS + 2));
    game(db, '5'); stampSets(db, '5', ago(SETS_STALE_DAYS + 1));
    const got = selectSetsTargets(db, { refreshBudget: 1 }).map((g) => g.appid);
    assert.deepEqual(got.slice(0, 3).sort(), ['1', '2', '3'], 'a game with no reading at all always gets one');
    assert.deepEqual(got.slice(3), ['4']);
  });

  test('a game with sets is asked again once its stats have been read since — progress moves with play', () => {
    const db = openDb(':memory:');
    game(db, '1');
    storeSets(db, '1', ago(1));
    stampStats(db, '1', ago(2));
    assert.deepEqual(ids(db), [], 'stats older than the sets reading: nothing has moved');
    stampStats(db, '1', ago(0.5));
    assert.deepEqual(ids(db), ['1'], 'stats read after the sets: the progress may have moved');
  });

  test('a game that is both overdue and played is not charged to the capped group', () => {
    const db = openDb(':memory:');
    game(db, '1');
    storeSets(db, '1', ago(SETS_STALE_DAYS + 2));
    stampStats(db, '1', ago(0.5));
    assert.deepEqual(selectSetsTargets(db, { refreshBudget: 0 }).map((g) => g.appid), ['1'],
      'a budget of nothing dropped a game whose progress has moved');
  });

  test('a game with no sets is not re-asked just because its stats were read', () => {
    const db = openDb(':memory:');
    game(db, '1');
    replaceAchievementSets(db, '1', [], ago(1));
    stampStats(db, '1', ago(0.5));
    assert.deepEqual(ids(db), [], 'there is no progress to refresh, and the definitions are fresh for the whole window');
  });
});

// ---------------------------------------------------------------------------
// The phase
// ---------------------------------------------------------------------------

describe('syncAchievementSets', () => {
  test('a game with no sets costs one request, and is recorded as asked', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    const steam = fakeSteam();
    const r = await syncAchievementSets(db, steam);
    assert.deepEqual(steam.asked, ['sets:1:english']);
    assert.equal(r.checked, 1);
    assert.equal(achievementSetsFor(db, '1').length, 0);
    assert.ok(getGame(db, '1').sets_checked_at, 'asked, and the answer was none');
  });

  test('a game with sets costs three: the English reply, the Chinese names, and this account\'s progress', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    const steam = fakeSteam({
      sets: { 1: TWO_SETS },
      names: { 1: { 1: '皓寒之渚' } },
      progress: { 1: new Map([[0, OWN(40, { completed: true, completedAt: 1700000000 })], [1, OWN(3)]]) },
    });
    const r = await syncAchievementSets(db, steam);
    assert.deepEqual(steam.asked, ['sets:1:english', 'sets:1:schinese', 'progress:1']);
    const rows = achievementSetsFor(db, '1');
    assert.deepEqual(rows.map((x) => [x.set_id, x.name_en, x.name_cn, x.done, x.completed]),
      [[0, '', '', 40, 1], [1, 'The Pale Reach', '皓寒之渚', 3, 0]]);
    assert.equal(r.withSets, 1);
  });

  test('a request that fails writes nothing and stamps nothing, so the game is asked again', async () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    const r = await syncAchievementSets(db, fakeSteam({ sets: { 1: TWO_SETS, 2: TWO_SETS }, fail: ['1'], failOn: 'english' }));
    assert.equal(r.failed, 1);
    assert.equal(r.checked, 1, 'the other game was still read');
    assert.equal(getGame(db, '1').sets_checked_at, null);
    assert.deepEqual(selectSetsTargets(db).map((g) => g.appid), ['1']);
  });

  test('a failure on the second or third request of a game writes none of it', async () => {
    for (const failOn of ['schinese', 'progress']) {
      const db = openDb(':memory:');
      game(db, '1');
      const r = await syncAchievementSets(db, fakeSteam({ sets: { 1: TWO_SETS }, fail: ['1'], failOn }));
      assert.equal(r.failed, 1, failOn);
      assert.equal(achievementSetsFor(db, '1').length, 0, `half a game (failing on ${failOn}) must not be stored`);
      assert.equal(getGame(db, '1').sets_checked_at, null, failOn);
    }
  });

  test('a game that lost its sets loses the rows', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    await syncAchievementSets(db, fakeSteam({ sets: { 1: TWO_SETS } }));
    assert.equal(achievementSetsFor(db, '1').length, 2);
    stampSets(db, '1', ago(SETS_STALE_DAYS + 1));
    await syncAchievementSets(db, fakeSteam({ sets: { 1: [S(0, '')] } }));
    assert.equal(achievementSetsFor(db, '1').length, 0);
  });

  test('the pass ends: asked once, it is not asked again until the window or a stats reading says so', async () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    stampStats(db, '1', ago(3));
    await syncAchievementSets(db, fakeSteam({ sets: { 1: TWO_SETS } }));
    const again = fakeSteam({ sets: { 1: TWO_SETS } });
    const r = await syncAchievementSets(db, again);
    assert.deepEqual(again.asked, [], 'a second pass straight after asks nothing');
    assert.equal(r.candidates, 0);
  });

  test('five failures in a row stop the phase, so an outage is not walked through game by game', async () => {
    const db = openDb(':memory:');
    const all = [];
    for (let i = 1; i <= SETS_BREAKER + 3; i++) { game(db, String(i)); all.push(String(i)); }
    const steam = fakeSteam({ fail: all });
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.stopped, true);
    assert.equal(r.failed, SETS_BREAKER);
    assert.equal(steam.asked.length, SETS_BREAKER, 'it did not go on to the games after the fifth');
  });

  test('a success in between starts the count again', async () => {
    const db = openDb(':memory:');
    const failing = [];
    // 4 down, 1 up, 4 down: nine games, never five in a row. A palindrome, so it does not matter
    // which end the phase starts from — it asks in the library's own order, which is by rate
    const order = [1, 1, 1, 1, 0, 1, 1, 1, 1];
    order.forEach((down, i) => {
      const id = String(i + 1);
      game(db, id, { achieved: 1, total: 100 - i }); // a distinct rate per game, so the order is fixed
      if (down) failing.push(id);
    });
    const steam = fakeSteam({ fail: failing });
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.stopped, false);
    assert.equal(r.failed, 8);
    assert.equal(r.checked, 1);
  });

  test('a game whose account request is refused does not stop the phase, and the games behind it are still read', async () => {
    // A 403 for a licence the account no longer holds answers that request and nothing else. Counted
    // as an outage, enough of them at the head of the queue would stop the phase on every run, with
    // the healthy games behind them never reached
    const db = openDb(':memory:');
    const refused = [];
    for (let i = 1; i <= SETS_BREAKER + 1; i++) {
      game(db, String(i), { achieved: 1, total: 2 + i }); // a higher rate than the healthy game, so these come first
      refused.push(String(i));
    }
    game(db, '99', { achieved: 1, total: 500 });
    const steam = fakeSteam({
      sets: Object.fromEntries([...refused, '99'].map((id) => [id, TWO_SETS])),
      fail: refused,
      failOn: 'progress',
    });
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.stopped, false, 'a refusal was counted as Steam being down');
    assert.equal(r.failed, refused.length);
    assert.equal(r.checked, 1);
    assert.equal(achievementSetsFor(db, '99').length, 2, 'the game behind the refused ones was never reached');
    assert.equal(getGame(db, '1').sets_checked_at, null, 'and a refused game is asked again next run');
  });

  test('an empty English reply is not "no sets": the stored sets stay and the game is read again', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    await syncAchievementSets(db, fakeSteam({ sets: { 1: TWO_SETS } }));
    stampSets(db, '1', ago(SETS_STALE_DAYS + 1)); // overdue, so it is asked again
    const old = getGame(db, '1').sets_checked_at;
    const r = await syncAchievementSets(db, fakeSteam({ sets: { 1: [] } }));
    assert.equal(r.failed, 1);
    assert.equal(r.stopped, false, 'a game that answered is not an outage');
    assert.equal(achievementSetsFor(db, '1').length, 2, 'an empty reply wiped the sets the game has');
    assert.equal(getGame(db, '1').sets_checked_at, old, 'and it was stamped as if it had been read');
  });

  test('a Chinese reply that leaves a set out leaves the game unread', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    const steam = fakeSteam({ sets: { 1: TWO_SETS } });
    const english = steam.fetchAchievementSets;
    steam.fetchAchievementSets = async (appid, language) => {
      const reply = await english.call(steam, appid, language);
      return language === 'schinese' ? { sets: reply.sets.slice(0, 1) } : reply;
    };
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.failed, 1);
    assert.equal(achievementSetsFor(db, '1').length, 0, 'a week of Chinese pages would show English names for the set it left out');
    assert.equal(getGame(db, '1').sets_checked_at, null);
  });

  test('a set the account\'s answer leaves out is stored as one it cannot earn', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    await syncAchievementSets(db, fakeSteam({ sets: { 1: TWO_SETS }, progress: { 1: new Map([[0, OWN(40)]]) } }));
    assert.deepEqual(achievementSetsFor(db, '1').map((r) => [r.set_id, r.achievable, r.done]), [[0, 1, 40], [1, 0, 0]]);
  });

  test('a game that answered but could not be read starts the count again, as a success does', async () => {
    const db = openDb(':memory:');
    // 4 outages, 1 refused account request, 4 outages: never five outages in a row. A palindrome, so
    // the order the phase asks in does not matter
    const kinds = ['out', 'out', 'out', 'out', 'refused', 'out', 'out', 'out', 'out'];
    const outage = [];
    const refused = [];
    kinds.forEach((kind, i) => {
      const id = String(i + 1);
      game(db, id, { achieved: 1, total: 100 - i });
      (kind === 'out' ? outage : refused).push(id);
    });
    const base = fakeSteam({ sets: Object.fromEntries(kinds.map((_, i) => [String(i + 1), TWO_SETS])) });
    const steam = {
      ...base,
      async fetchAchievementSets(appid, language) { return outage.includes(appid) ? null : base.fetchAchievementSets(appid, language); },
      async fetchAchievementSetProgress(appid) { return refused.includes(appid) ? null : base.fetchAchievementSetProgress(appid); },
    };
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.stopped, false, 'a game Steam answered for did not end the streak of outages');
    assert.equal(r.failed, 9);
  });

  test('a game that throws is isolated, and the games behind it are still read', async () => {
    // A game that throws is never stamped, so it stays first in line: letting it end the phase would
    // starve every game behind it on every run
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 2 });
    game(db, '2', { achieved: 1, total: 3 });
    const steam = fakeSteam({ sets: { 2: TWO_SETS } });
    const original = steam.fetchAchievementSets;
    steam.fetchAchievementSets = async (appid, language) => {
      if (appid === '1') throw new Error('odd reply');
      return original.call(steam, appid, language);
    };
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.error, 'odd reply', 'the phase reports what threw');
    assert.equal(r.failed, 1);
    assert.equal(r.checked, 1);
    assert.equal(r.stopped, false);
    assert.equal(achievementSetsFor(db, '2').length, 2);
  });

  test('the same throw for five games in a row does stop it', async () => {
    const db = openDb(':memory:');
    for (let i = 1; i <= SETS_BREAKER + 2; i++) game(db, String(i), { achieved: 1, total: 10 + i });
    const steam = fakeSteam();
    steam.fetchAchievementSets = async () => { throw new Error('same bug'); };
    const r = await syncAchievementSets(db, steam);
    assert.equal(r.stopped, true);
    assert.equal(r.failed, SETS_BREAKER);
    assert.equal(r.error, 'same bug');
  });

  test('it reports each game as it goes', async () => {
    const db = openDb(':memory:');
    game(db, '1');
    const events = [];
    await syncAchievementSets(db, fakeSteam(), { onProgress: (e) => events.push(e) });
    assert.deepEqual(events.map((e) => [e.phase, e.done, e.total]), [['sets', 1, 1]]);
    assert.equal(events[0].name, 'G1');
  });

  test('none of it moves a count, a rate or the average completion rate', async () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 7, total: 20 });
    game(db, '2', { achieved: 60, total: 60 });
    game(db, '3', { achieved: 0, total: 30 });
    const snapshot = () => ({
      games: allGames(db).map((g) => { const x = { ...g }; delete x.sets_checked_at; return x; }),
      agcr: computeAgcrStats(db),
    });
    const before = snapshot();
    await syncAchievementSets(db, fakeSteam({
      sets: { 1: TWO_SETS, 2: TWO_SETS },
      progress: { 1: new Map([[0, OWN(46)]]), 2: new Map([[0, OWN(40, { completed: true })], [1, OWN(8, { completed: true })]]) },
    }));
    assert.deepEqual(snapshot(), before);
  });
});

// ---------------------------------------------------------------------------
// Inside a whole sync
// ---------------------------------------------------------------------------

describe('fullSync', () => {
  /** What the other phases need to run, plus the two requests this one makes */
  const steamFor = (extra = {}) => ({
    fetchOwnedGamesWithUnvettedFlag: async () => ({ games: [], unvettedAppIds: new Set(), playSnapshot: new Map() }),
    fetchRecentlyPlayedGames: async () => null,
    fetchAppName: async () => '',
    fetchAppNameEn: async () => '',
    fetchAchievementStats: async () => ({ total: 4, achieved: 1, unlocked: ['A'] }),
    fetchGlobalAchievementPercentages: async () => null,
    fetchAchievementSchema: async () => null,
    delay: 0, storeDelay: 0,
    ...fakeSteam({ sets: { 1: TWO_SETS } }),
    ...extra,
  });

  test('a game the stats phase has only just read is asked in the same run', async () => {
    // Its has_achievements is NULL until phase two reads it, so the sets phase has to come after
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'New' });
    const steam = steamFor();
    const r = await fullSync(db, steam);
    assert.ok(steam.asked.includes('sets:1:english'), 'the new game was not asked about its sets');
    assert.equal(r.sets.checked, 1);
    assert.equal(achievementSetsFor(db, '1').length, 2);
  });

  test('the phase runs after the achievement phases and before the hours estimate', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'New' });
    const phases = [];
    const hltb = { stopped: null, resolve: async () => ({ verified: false }), refresh: async () => null };
    await fullSync(db, steamFor(), { hltb, onProgress: (e) => phases.push(e.phase) });
    const seen = [...new Set(phases)];
    const at = (phase) => seen.indexOf(phase);
    assert.ok(at('achievements') !== -1 && at('rarity') !== -1 && at('hltb') !== -1, `a phase did not run: ${seen.join(' > ')}`);
    assert.ok(at('achievements') < at('rarity') && at('rarity') < at('sets') && at('sets') < at('hltb'),
      `order was ${seen.join(' > ')}`);
  });

  test('a throw inside the phase does not fail the sync', async () => {
    // Sets are beta data on a shape that may still change. Anything in the phase throwing that the
    // client does not catch must not turn a run that landed its numbers into 「同步失败」
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'New' });
    const exploding = steamFor({ fetchAchievementSets: async () => { throw new Error('boom'); } });
    const r = await fullSync(db, exploding);
    assert.equal(r.sets.error, 'boom', 'the phase reports its own failure');
    assert.equal(r.sets.failed, 1);
    assert.equal(r.stats.updated, 1, 'and the phases before it keep their results');
    assert.equal(getGame(db, '1').achieved, 1, 'and their data');
  });

  test('a failure the per-game catch cannot see is caught here, and ends the phase', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'New' });
    db.exec('DROP TABLE achievement_sets'); // choosing the targets reads it, before any game is asked
    const r = await fullSync(db, steamFor());
    assert.equal(r.sets.stopped, true);
    assert.match(r.sets.error, /achievement_sets/);
    assert.equal(r.stats.updated, 1, 'the phases before it keep their results');
  });
});

// ---------------------------------------------------------------------------
// What the Dashboard gets
// ---------------------------------------------------------------------------

describe('getDashboardData', () => {
  const apiFor = (db, uiLanguage = 'en') => createApi({
    db, steam: {}, config: { uiLanguage }, syncState: { snapshot: () => ({}) },
    startBackgroundSync: null, guideGenState: null, startGuideGen: null, planGuidePreflight: null, maybeAutoSync: null,
  });
  const rowsFor = (names) => names.map(([setId, nameEn, nameCn, extra = {}]) => ({
    setId, nameEn, nameCn, dlcAppid: null, position: 0, total: 10, need: 10, archived: false, visible: true,
    achievable: true, done: 0, completed: false, completedAt: null, ...extra,
  }));

  test('a game without sets carries null, and a game with them carries what to draw', () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    replaceAchievementSets(db, '2', rowsFor([
      [0, '', '', { total: 40, need: 40, done: 40, completed: true, completedAt: 1700000000 }],
      [1, 'The Pale Reach', '皓寒之渚', { dlcAppid: '2561440', total: 8, need: 8, done: 3 }],
    ]));
    const games = Object.fromEntries(apiFor(db, 'zh').getDashboardData().games.map((g) => [g.appid, g]));
    assert.equal(games['1'].sets, null);
    assert.deepEqual(games['2'].sets.map((s) => [s.id, s.base, s.name, s.dlc, s.done, s.need, s.complete]),
      [[0, true, '', false, 40, 40, true], [1, false, '皓寒之渚', true, 3, 8, false]]);
    assert.equal(apiFor(db, 'en').getDashboardData().games.find((g) => g.appid === '2').sets[1].name, 'The Pale Reach',
      'the name follows the interface language');
  });

  test('a finished game keeps its sets — a complete set is the thing there is to see', () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 60, total: 60 });
    replaceAchievementSets(db, '1', rowsFor([[0, '', '', { total: 40, need: 40, done: 40, completed: true }],
      [1, 'The Iron Rig', '', { dlcAppid: '2561450', total: 20, need: 20, done: 20, completed: true }]]));
    const g = apiFor(db).getDashboardData().games[0];
    assert.equal(g.rate, 1);
    assert.equal(g.sets.length, 2);
  });

  test('sets that complete nothing change nothing the readout shows', () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 7, total: 20 });
    game(db, '2', { achieved: 60, total: 60 });
    const strip = (d) => ({ ...d, games: d.games.map(({ sets, ...rest }) => rest) });
    const without = strip(apiFor(db).getDashboardData());
    replaceAchievementSets(db, '1', rowsFor([[0, '', '', { total: 56, need: 56, done: 46 }], [8, 'Khans of the Steppe', '', { dlcAppid: '3315510', achievable: false }]]));
    const withSets = strip(apiFor(db).getDashboardData());
    assert.deepEqual(withSets, without);
  });

  test('a completed set moves the completed count and no other number', () => {
    // 75 of 198 on the flat list: three DLC sets this account does not own are in the 198. One of
    // the sets it can earn is finished, and that is a unit on Steam's profile
    const db = openDb(':memory:');
    game(db, '1', { achieved: 75, total: 198 });
    game(db, '2', { achieved: 60, total: 60 });
    const strip = ({ completedCount, ...d }) => ({ ...d, games: d.games.map(({ sets, ...rest }) => rest) });
    const without = apiFor(db).getDashboardData();
    replaceAchievementSets(db, '1', rowsFor([
      [0, '', '', { total: 56, need: 56, done: 46 }],
      [2, 'Royal Court', '', { dlcAppid: '1303182', total: 20, need: 20, done: 20, completed: true }],
      [8, 'Khans of the Steppe', '', { dlcAppid: '3315510', achievable: false }],
    ]));
    const withSets = apiFor(db).getDashboardData();
    assert.equal(without.completedCount, 1, 'the finished game alone');
    assert.equal(withSets.completedCount, 2, 'and the finished set');
    assert.deepEqual(strip(withSets), strip(without),
      'the unlocked total, the average and every game row stay on the flat list');
  });
});

// ---------------------------------------------------------------------------
// Which achievement is in which set
// ---------------------------------------------------------------------------

describe('the set of each achievement', () => {
  const MEMBERS = new Map([['A', 0], ['B', 1], ['C', 1]]);
  const members = (db, appid) => [...achievementSetMembersFor(db, appid)];

  test('is stored with the sets, in the same write', () => {
    const db = openDb(':memory:');
    game(db, '1');
    assert.equal(replaceAchievementSets(db, '1', [ROW(0), ROW(1)], '2026-10-15T12:00:00.000Z', MEMBERS), true);
    assert.deepEqual(members(db, '1'), [['A', 0], ['B', 1], ['C', 1]]);
  });

  test('a new reading replaces the last one, and an achievement that moved to another set is in that one', () => {
    const db = openDb(':memory:');
    game(db, '1');
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], undefined, MEMBERS);
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], undefined, new Map([['A', 1], ['D', 0]]));
    assert.deepEqual(members(db, '1').sort(), [['A', 1], ['D', 0]], 'B and C left the list, so they leave the table');
  });

  test('a game whose sets are cleared loses them too, and a write with no sets ignores the members it is handed', () => {
    const db = openDb(':memory:');
    game(db, '1');
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], undefined, MEMBERS);
    replaceAchievementSets(db, '1', [], undefined, MEMBERS);
    assert.deepEqual(members(db, '1'), [], 'with no set to file them under, they would be rows nothing can draw');
  });

  test('a game that is not in the table writes nothing, members included', () => {
    const db = openDb(':memory:');
    assert.equal(replaceAchievementSets(db, '404', [ROW(0), ROW(1)], undefined, MEMBERS), false);
    assert.deepEqual(members(db, '404'), []);
  });

  test("one game's members are not another's", () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], undefined, MEMBERS);
    replaceAchievementSets(db, '2', [ROW(0), ROW(1)], undefined, new Map([['A', 1]]));
    assert.equal(members(db, '1').length, 3);
    assert.deepEqual(members(db, '2'), [['A', 1]]);
  });

  test('are deleted with the game', () => {
    const db = openDb(':memory:');
    game(db, '1'); game(db, '2');
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], undefined, MEMBERS);
    replaceAchievementSets(db, '2', [ROW(0), ROW(1)], undefined, MEMBERS);
    deleteGame(db, '1');
    assert.deepEqual(members(db, '1'), []);
    assert.equal(members(db, '2').length, 3, 'the other game keeps its own');
  });

  test('a write that fails halfway leaves the last reading whole, members and all', () => {
    const db = openDb(':memory:');
    game(db, '1');
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], undefined, MEMBERS);
    // A set id that is null breaks the INSERT of a row after the old rows are already gone
    assert.throws(() => replaceAchievementSets(db, '1', [ROW(0), { ...ROW(1), setId: null }], undefined, new Map([['Z', 0]])));
    assert.equal(achievementSetsFor(db, '1').length, 2, 'the rows came back');
    assert.deepEqual(members(db, '1').sort(), [['A', 0], ['B', 1], ['C', 1]], 'and so did the members');
  });

  test('a member that cannot be written rolls the whole reading back: the rows, the stamp and the members', () => {
    const db = openDb(':memory:');
    game(db, '1');
    const before = '2026-10-10T00:00:00.000Z';
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], before, MEMBERS);
    // The same name twice, as pairs: the second insert breaks the primary key after the rows are written
    assert.throws(() => replaceAchievementSets(db, '1', [ROW(0)], '2026-10-16T00:00:00.000Z', [['A', 0], ['A', 1]]));
    assert.equal(achievementSetsFor(db, '1').length, 2, 'the rows of the last reading are back');
    assert.equal(getGame(db, '1').sets_checked_at, before, 'and so is the stamp');
    assert.deepEqual(members(db, '1').sort(), [['A', 0], ['B', 1], ['C', 1]], 'and the members');
  });

  test('the sync stores what the English reply files under each set', async () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    const steam = fakeSteam({ sets: { 1: TWO_SETS }, members: { 1: [['A', 0], ['B', 1]] } });
    await syncAchievementSets(db, steam);
    assert.deepEqual(members(db, '1').sort(), [['A', 0], ['B', 1]]);
  });

  test('a game that answers one group has none, and loses any it had', async () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], ago(10), MEMBERS);
    const steam = fakeSteam({ sets: { 1: [S(0, '', { total: 4, need: 4 })] }, members: { 1: [['A', 0]] } });
    await syncAchievementSets(db, steam);
    assert.deepEqual(members(db, '1'), []);
    assert.equal(achievementSetsFor(db, '1').length, 0);
  });

  test('a game left unread keeps the members it had', async () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    replaceAchievementSets(db, '1', [ROW(0), ROW(1)], ago(10), MEMBERS);
    const steam = fakeSteam({ sets: { 1: TWO_SETS }, members: { 1: [['Z', 0]] }, fail: ['1'], failOn: 'progress' });
    await syncAchievementSets(db, steam);
    assert.deepEqual(members(db, '1').sort(), [['A', 0], ['B', 1], ['C', 1]], 'a reading that could not be completed replaces nothing');
  });
});

describe('selectSetsTargets: a rise in the achievement total', () => {
  const asked = (db) => selectSetsTargets(db).map((g) => g.appid).sort();

  test('asks a game again when its total rose after it was last read, whether or not it holds sets', () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    game(db, '2', { achieved: 1, total: 4 });
    stampSets(db, '1', ago(2));
    storeSets(db, '2', ago(2));
    assert.deepEqual(asked(db), [], 'nothing is due: both were read two days ago');
    updateGameStats(db, '1', { achieved: 1, total: 6 });
    updateGameStats(db, '2', { achieved: 1, total: 6 });
    assert.deepEqual(asked(db), ['1', '2'], 'a patch added achievements, and a DLC set is the usual way one does');
  });

  test('does not when the rise came before the last reading, so the reading that saw it is not repeated', () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    stampSets(db, '1', ago(1));
    db.prepare('UPDATE games SET new_ach_date = ? WHERE appid = ?').run(ago(3), '1');
    assert.deepEqual(asked(db), []);
  });

  test('is read again once and then rests: the reading that follows the rise ends it', async () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    stampSets(db, '1', ago(2));
    updateGameStats(db, '1', { achieved: 1, total: 6 });
    assert.deepEqual(asked(db), ['1']);
    await syncAchievementSets(db, fakeSteam({ sets: { 1: [S(0, '', { total: 6, need: 6 })] } }));
    assert.deepEqual(asked(db), [], 'it was stamped by the reading, which is later than the rise');
  });

  test('a game that never grew is left to the weekly re-read', () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 1, total: 4 });
    stampSets(db, '1', ago(SETS_STALE_DAYS - 1));
    assert.deepEqual(asked(db), []);
    stampSets(db, '1', ago(SETS_STALE_DAYS + 1));
    assert.deepEqual(asked(db), ['1']);
  });

  test('is not charged to the capped group, so a rise is never left waiting behind a backlog', () => {
    const db = openDb(':memory:');
    for (let i = 1; i <= 5; i++) { game(db, String(i), { achieved: 1, total: 4 }); stampSets(db, String(i), ago(40 + i)); }
    // Stale as well as grown, and the newest of the stale ones: in the capped group it would lose to
    // every game with an older stamp
    game(db, '9', { achieved: 1, total: 4 });
    stampSets(db, '9', ago(SETS_STALE_DAYS + 3));
    db.prepare('UPDATE games SET new_ach_date = ? WHERE appid = ?').run(ago(1), '9');
    const picked = selectSetsTargets(db, { refreshBudget: 1 }).map((g) => g.appid);
    assert.ok(picked.includes('9'), 'the grown game was squeezed out by a budget that is for the stale ones');
    assert.equal(picked.length, 2, 'one grown, and the oldest stale one within the budget of 1');
  });
});

describe('getMissingAchievements for a game with sets', () => {
  const ach = (apiName, nameEn = apiName) => ({ apiName, nameCn: apiName, nameEn, description: 'd' });
  const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const FILED = new Map([['A', 0], ['B', 0], ['C', 0], ['D', 0], ['E', 1], ['F', 1], ['G', 2], ['H', 2]]);

  /** Base game A-D, an owned pack E-F, and a pack the account does not own G-H. Unlocked: A and E */
  function fixture({ members = FILED } = {}) {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 2, total: 8 });
    replaceAchievements(db, '1', NAMES.map((n) => ach(n)));
    replaceAchievementSets(db, '1', [
      ROW(0, { nameEn: '', nameCn: '', total: 4, need: 4, done: 1 }),
      ROW(1, { nameEn: 'Pale Reach', nameCn: '皓寒之渚', dlcAppid: '2561440', total: 2, need: 2, done: 1 }),
      ROW(2, { nameEn: 'Iron Rig', nameCn: '铁钻机', dlcAppid: '2561450', total: 2, need: 2, achievable: false }),
    ], undefined, members);
    return db;
  }
  const api = (db, uiLanguage = 'en') => createApi({
    db,
    config: { uiLanguage, language: 'english' },
    steam: { fetchPlayerAchievements: async () => ({ achievements: NAMES.map((apiname) => ({ apiname, achieved: apiname === 'A' || apiname === 'E' ? 1 : 0 })) }) },
  });

  test('files each unfinished achievement under its set, in the order the strip draws them', async () => {
    const r = await api(fixture()).getMissingAchievements('1');
    assert.deepEqual(r.groups.map((g) => [g.id, g.earnable, g.count]), [[0, true, 3], [1, true, 1], [2, false, 2]]);
    assert.deepEqual(Object.fromEntries(r.missing.map((m) => [m.name, m.setId])), { B: 0, C: 0, D: 0, F: 1, G: 2, H: 2 });
  });

  test('says how many can be earned, and how many sit in a set the account cannot earn', async () => {
    const r = await api(fixture()).getMissingAchievements('1');
    assert.equal(r.total, 8);
    assert.equal(r.missingCount, 4, 'three in the base game and one in the pack, not the two that cannot be earned');
    assert.equal(r.notOwnedCount, 2);
  });

  test('names the sets in the interface language', async () => {
    const db = fixture();
    assert.deepEqual((await api(db, 'zh').getMissingAchievements('1')).groups.map((g) => g.name), ['', '皓寒之渚', '铁钻机']);
    assert.deepEqual((await api(db, 'en').getMissingAchievements('1')).groups.map((g) => g.name), ['', 'Pale Reach', 'Iron Rig']);
  });

  test('a game without sets is the flat list', async () => {
    const db = openDb(':memory:');
    game(db, '1', { achieved: 2, total: 8 });
    replaceAchievements(db, '1', NAMES.map((n) => ach(n)));
    const r = await api(db).getMissingAchievements('1');
    assert.equal(r.groups, null);
    assert.equal(r.missingCount, 6);
    assert.equal(r.notOwnedCount, 0);
    assert.ok(r.missing.every((m) => m.setId === null));
  });

  test('a game whose reading carries no members yet is the flat list too, rather than one lump called a set', async () => {
    const r = await api(fixture({ members: new Map() })).getMissingAchievements('1');
    assert.equal(r.groups, null);
    assert.equal(r.missingCount, 6, 'counted as before: nothing says which of these can be earned');
    assert.equal(r.notOwnedCount, 0);
  });
});
