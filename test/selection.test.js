/**
 * Regression tests for the phase-two sampling rules
 * ------------------------------------------------
 * Run with: node --test (zero dependencies, using Node's built-in node:test)
 *
 * What is pinned is "which games get reconciled against Steam this run". Loosening or
 * tightening it here **loses data silently** — one row not checked raises no error, it
 * merely leaves a number on the Dashboard quietly stuck at its old value. So every rule is
 * pinned:
 *
 * - achieved only changes if you played → rtime_last_played not moving means it can be
 *   skipped
 * - total is a property of the game and a developer patch can change it → looking at rtime
 *   alone would never discover that, so the rotating sweep has to cover it, and perfect
 *   games have to be swept more often (dropping below 100% is what one most wants to know
 *   early)
 * - a row not in the owned list has no rtime → it can only be checked every time and must
 *   never be frozen out
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertGame, markStatsChecked, updateGameStats, setGameField } from '../lib/db.js';
import { selectStatsTargets } from '../lib/sync.js';

const DAY_MS = 86400000;
const agoIso = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

/** One independent in-memory database per case: no interference and nothing to clean up */
const freshDb = () => ({ db: openDb(':memory:'), cleanup: () => {} });

/** Builds a row that has "already been reconciled": checked checkedDaysAgo days ago, with rtime at lastPlayed then */
function seedGame(db, { appid, name = 'G' + appid, lastPlayed = 1000, checkedDaysAgo = 0, rate = null }) {
  insertGame(db, { appid, name });
  if (rate !== null) updateGameStats(db, appid, { achieved: rate === 1 ? 10 : 5, total: 10 });
  db.prepare('UPDATE games SET last_played = ?, stats_checked_at = ? WHERE appid = ?')
    .run(lastPlayed, agoIso(checkedDaysAgo), String(appid));
}

const names = (r) => r.targets.map((g) => g.appid).sort();
const SELECTION = { sweepBudget: 40, maxStatsAgeDays: 7, perfectGameMaxAgeDays: 3 };

describe('selectStatsTargets — no playSnapshot means a full pass', () => {
  test('no snapshot → every unlocked row is checked (what the CLI `sync` relies on to miss nothing)', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    const r = selectStatsTargets(db, null, SELECTION);
    assert.deepEqual(names(r), ['1', '2']);
    assert.equal(r.gated, false);
    cleanup();
  });

  test('a sync_locked row is never checked under any circumstances', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1' });
    insertGame(db, { appid: '2', name: '手动维护的', syncLocked: 1 });
    assert.deepEqual(names(selectStatsTargets(db, null, SELECTION)), ['1']);
    const snap = new Map([['1', 1000], ['2', 9999]]);
    assert.deepEqual(names(selectStatsTargets(db, snap, SELECTION)), []);
    cleanup();
  });
});

describe('selectStatsTargets — the rtime gate (achieved\'s correctness)', () => {
  test('rtime unmoved and checked just now → skipped', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 0 });
    const r = selectStatsTargets(db, new Map([['1', 1000]]), SELECTION);
    assert.deepEqual(names(r), []);
    cleanup();
  });

  test('rtime moved forward → checked (you played, so achieved may have changed)', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 0 });
    const r = selectStatsTargets(db, new Map([['1', 2000]]), SELECTION);
    assert.deepEqual(names(r), ['1']);
    assert.equal(r.played, 1);
    cleanup();
  });

  test('a row with no baseline yet has to be checked, and is not subject to the sweep budget', () => {
    const { db, cleanup } = freshDb();
    const snap = new Map();
    for (let i = 0; i < 60; i++) {
      insertGame(db, { appid: String(i), name: 'G' + i }); // last_played / stats_checked_at are both NULL
      snap.set(String(i), 500);
    }
    const r = selectStatsTargets(db, snap, SELECTION);
    assert.equal(r.targets.length, 60, 'the first run after upgrading is a full pass; the baseline has to exist first');
    assert.equal(r.played, 60);
    cleanup();
  });

  test('checked but last_played is NULL (it was not in owned at the time) → still checked', () => {
    const { db, cleanup } = freshDb();
    insertGame(db, { appid: '1', name: 'G1' });
    markStatsChecked(db, '1', null); // has a stats_checked_at, has no last_played
    const r = selectStatsTargets(db, new Map([['1', 800]]), SELECTION);
    assert.deepEqual(names(r), ['1']);
    cleanup();
  });
});

describe('selectStatsTargets — rows not in the owned list', () => {
  test('no rtime available → checked every time, even if just checked', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 0 }); // in owned
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 0 }); // family-shared / delisted
    const r = selectStatsTargets(db, new Map([['1', 1000]]), SELECTION);
    assert.deepEqual(names(r), ['77'], 'a game can disappear from GetOwnedGames while its achievement data remains');
    assert.equal(r.unowned, 1);
    cleanup();
  });

  test('already at 100% → no longer checked every time, handed to the rotating sweep', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 0, rate: 1 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), [], 'achieved is at the ceiling and cannot rise however much more is played');
    assert.equal(r.unowned, 0, 'it should no longer count in the "checked every time" group');
    cleanup();
  });

  test('a 100% game uses perfectGameMaxAgeDays (3 days), not 7', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 5, rate: 1 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77'], '5 days > 3 days, so it is due');
    assert.equal(r.swept, 1, 'it goes through sweep rather than unowned');
    assert.equal(r.unowned, 0);
    // And the other way: 2 days is not yet due
    const { db: db2, cleanup: c2 } = freshDb();
    seedGame(db2, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 2, rate: 1 });
    assert.deepEqual(names(selectStatsTargets(db2, new Map(), SELECTION)), []);
    cleanup(); c2();
  });

  test('100% with no stats_checked_at → checked anyway, and not missed by this rule', () => {
    const { db, cleanup } = freshDb();
    insertGame(db, { appid: '77', name: '没基线的' });
    updateGameStats(db, '77', { achieved: 10, total: 10 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77'], 'ageDays(null) is Infinity, so it enters the pool and sorts first');
    cleanup();
  });

  test('an unfinished one is still checked every time — achieved is still moving and rtime is unavailable', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 0, rate: 0.5 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77']);
    assert.equal(r.unowned, 1);
    cleanup();
  });

  // The skip decision takes the stricter of the two conditions: if rate happens to be
  // stale, better a few wasted checks than freezing a still-moving achieved for three days
  test('rate says complete but achieved !== total → treated as incomplete and left in the check-every-time group', () => {
    const { db, cleanup } = freshDb();
    insertGame(db, { appid: '77', name: 'rate 过时的' });
    updateGameStats(db, '77', { achieved: 5, total: 10 });
    // Only rate is set to 1 while the counts stay 5/10 — setGameField refuses to write rate (the injection gate), so raw SQL is used
    db.prepare('UPDATE games SET rate = 1, stats_checked_at = ? WHERE appid = ?').run(agoIso(0), '77');
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77'], 'when the two conditions disagree, take the safe side');
    assert.equal(r.unowned, 1);
    cleanup();
  });
});

describe('selectStatsTargets — the rotating sweep (total\'s safety net)', () => {
  test('unchecked for longer than maxStatsAgeDays → queued for the sweep, even if never played', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 8 });
    const r = selectStatsTargets(db, new Map([['1', 1000]]), SELECTION);
    assert.deepEqual(names(r), ['1'], 'a developer adding achievements does not require you to play, and only a periodic re-check finds it');
    assert.equal(r.swept, 1);
    cleanup();
  });

  test('not yet due, so not swept', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 6 });
    assert.deepEqual(names(selectStatsTargets(db, new Map([['1', 1000]]), SELECTION)), []);
    cleanup();
  });

  test('the budget caps it, the most overdue go first, and the rest are recorded in sweepPending for next time', () => {
    const { db, cleanup } = freshDb();
    const snap = new Map();
    for (let i = 0; i < 10; i++) {
      seedGame(db, { appid: String(i), lastPlayed: 1000, checkedDaysAgo: 10 + i });
      snap.set(String(i), 1000);
    }
    const r = selectStatsTargets(db, snap, { ...SELECTION, sweepBudget: 3 });
    assert.equal(r.swept, 3);
    assert.equal(r.sweepPending, 7);
    // With identical deadlines (none of them perfect games), sorting by overdue ratio degenerates to oldest-first → 9/8/7
    assert.deepEqual(names(r), ['7', '8', '9']);
    cleanup();
  });

  test('sorted by "overdue ratio" rather than absolute time — otherwise the 3-day deadline is decorative', () => {
    const { db, cleanup } = freshDb();
    // The perfect game is 4/3 = 1.33x overdue; the ordinary one is 8/7 = 1.14x. The latter
    // is older in absolute terms, but the former has failed its own deadline by more and
    // should be swept first
    seedGame(db, { appid: 'perfect', lastPlayed: 1000, checkedDaysAgo: 4, rate: 1 });
    seedGame(db, { appid: 'normal', lastPlayed: 1000, checkedDaysAgo: 8, rate: 0.5 });
    const snap = new Map([['perfect', 1000], ['normal', 1000]]);
    const r = selectStatsTargets(db, snap, { ...SELECTION, sweepBudget: 1 });
    assert.deepEqual(names(r), ['perfect']);
    cleanup();
  });

  test('sweepBudget=0 → the rotating sweep is off and only the rtime gate remains', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 99 });
    const r = selectStatsTargets(db, new Map([['1', 1000]]), { ...SELECTION, sweepBudget: 0 });
    assert.deepEqual(names(r), []);
    assert.equal(r.sweepPending, 1, 'even switched off it has to report honestly how many are queued');
    cleanup();
  });

  test('a perfect game uses the shorter expiry (3 days) while an ordinary one is not yet due', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 4, rate: 1 }); // 100%
    seedGame(db, { appid: '2', lastPlayed: 1000, checkedDaysAgo: 4, rate: 0.5 });
    const r = selectStatsTargets(db, new Map([['1', 1000], ['2', 1000]]), SELECTION);
    assert.deepEqual(names(r), ['1'], 'a higher achievement total drops a 100% game below it, so it has to be swept more often');
    cleanup();
  });
});

describe('markStatsChecked', () => {
  test('passing null when rtime is unavailable does not erase an existing last_played', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 4242, checkedDaysAgo: 5 });
    markStatsChecked(db, '1', null);
    const row = db.prepare('SELECT * FROM games WHERE appid = ?').get('1');
    assert.equal(row.last_played, 4242);
    assert.ok(row.stats_checked_at > agoIso(1), 'stats_checked_at should have been refreshed to now');
    cleanup();
  });

  test('updated_at is not touched — checking and finding nothing changed is not a data change', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000 });
    setGameField(db, '1', 'favorite', 1);
    const before = db.prepare('SELECT updated_at FROM games WHERE appid = ?').get('1').updated_at;
    markStatsChecked(db, '1', 1000);
    const after = db.prepare('SELECT updated_at FROM games WHERE appid = ?').get('1').updated_at;
    assert.equal(after, before);
    cleanup();
  });
});
