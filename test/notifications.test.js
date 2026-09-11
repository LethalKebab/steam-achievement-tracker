/**
 * The bell's three kinds of notification
 * ------------------------------------------------
 * What this protects is a class of failure with **no second chance**: all three are transitions,
 * and once `updateGameStats`'s UPDATE has run the old value is gone — a wrong judgement, or no
 * judgement at all, can never be recovered from the current state. It does not present as an
 * error but as a bell that stays empty while the user concludes "nothing has happened recently".
 *
 * This is also **the one place in this project that deliberately detects transitions**, the exact
 * opposite of `guide-status`'s rule of "converge on current state, never detect a transition". The
 * difference is the question itself: that one asks "what status should this page be in now"
 * (current state suffices), while this asks "what happened recently" (which current state cannot
 * answer at all — a game that dropped below 100% and a game that was never complete look identical).
 *
 * The three kinds, and the stamp each one reads:
 *
 *  - **A finished game gained achievements** — `perfect_lost_date`. The 100% it had is gone.
 *  - **A game's achievement total went up** — `new_ach_date`, stamped on every rise, finished or
 *    not. A developer patch is a change you cannot notice on your own, and it is rare enough that
 *    listing every one is not crying wolf (the measurement is in docs/frontend.md).
 *  - **A game gained an achievement system** — `ach_added_date`.
 *
 * The boundaries easiest to get wrong, all pinned below:
 *
 *  1. **A lost 100% is for finished games only.** An unfinished game gaining achievements is the
 *     second kind, and must not be reported as losing a 100% it never had.
 *  2. **`has_achievements` being NULL is not the third kind.** NULL means "this row has not synced
 *     yet", not "this game added achievements". Confusing the two would stuff the whole library
 *     into the bell on the first full sync.
 *  3. **A recurrence refreshes the timestamp rather than keeping the first one.** The bell filters
 *     by "how many days ago", and keeping the old value would show something that just happened as
 *     three months old, and then filter it out.
 *  4. **One event is one moment.** A finished game gaining achievements stamps both
 *     `perfect_lost_date` and `new_ach_date`, and the bell lists it once by recognising the two
 *     stamps as one event — so they come from one clock reading, not two.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, insertGame, updateGameStats, markNoAchievements, getGame } from '../lib/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fresh = () => openDb(':memory:');

/** Creates a row and gives it a baseline state */
function seeded(db, appid, { achieved, total }) {
  insertGame(db, { appid, name: 'G' + appid });
  if (achieved !== undefined) updateGameStats(db, appid, { achieved, total });
  return appid;
}

describe('achievements added by the developer after completion (a lost 100%)', () => {
  test('10/10 → 10/12 fires, and is written to the database', () => {
    const db = fresh();
    seeded(db, '1', { achieved: 10, total: 10 });
    const r = updateGameStats(db, '1', { achieved: 10, total: 12 });
    assert.equal(r.perfectLost, true);
    assert.ok(getGame(db, '1').perfect_lost_date, 'judged correctly but never written — it cannot be recovered next time');
  });

  test('an unfinished game gaining achievements is not a lost 100%', () => {
    const db = fresh();
    seeded(db, '2', { achieved: 3, total: 10 });
    assert.equal(updateGameStats(db, '2', { achieved: 3, total: 12 }).perfectLost, false,
      'a 100% it never had cannot be lost; this game belongs under a rise in the total');
  });

  test('the first sync of this row does not fire (no baseline means no "before")', () => {
    const db = fresh();
    insertGame(db, { appid: '3', name: 'G3' });
    assert.equal(updateGameStats(db, '3', { achieved: 5, total: 10 }).perfectLost, false);
  });

  test('an unchanged total does not fire, even at exactly 100%', () => {
    const db = fresh();
    seeded(db, '4', { achieved: 10, total: 10 });
    assert.equal(updateGameStats(db, '4', { achieved: 10, total: 10 }).perfectLost, false);
  });

  test('a recurrence refreshes the timestamp rather than keeping the first one', () => {
    const db = fresh();
    seeded(db, '5', { achieved: 10, total: 10 });
    updateGameStats(db, '5', { achieved: 10, total: 12 });

    // Push the timestamp back to an obviously stale value before firing a second time.
    // **The two real writes cannot simply be compared** — they may land in the same
    // millisecond, `nowIso()` gives an identical string, and the assertion "it changed" fails
    // spuriously while the product behaviour is entirely correct. This test stepped on that
    // once
    const OLD = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE games SET perfect_lost_date = ? WHERE appid = ?').run(OLD, '5');

    // The total does not change in this middle step, so it should not be touched — which also
    // pins COALESCE's preserving semantics
    updateGameStats(db, '5', { achieved: 12, total: 12 });
    assert.equal(getGame(db, '5').perfect_lost_date, OLD, 'an existing timestamp should not move when there is no new event');

    // Achievements added once more → it has to refresh
    updateGameStats(db, '5', { achieved: 12, total: 15 });
    assert.notEqual(
      getGame(db, '5').perfect_lost_date, OLD,
      'keeping the old timestamp shows something that just happened as long ago, and the 30-day window then filters it out'
    );
  });
});

describe('a game whose achievement total went up', () => {
  test('a rise is stamped whether or not the game was finished', () => {
    const db = fresh();
    seeded(db, '20', { achieved: 3, total: 10 });
    const r = updateGameStats(db, '20', { achieved: 3, total: 12 });
    assert.equal(r.bumped, true);
    assert.ok(getGame(db, '20').new_ach_date,
      'judged correctly but never written — the bell reads the column, not the return value');
  });

  test('the first sync of a row does not stamp it — no baseline means no rise', () => {
    const db = fresh();
    insertGame(db, { appid: '21', name: 'G21' });
    updateGameStats(db, '21', { achieved: 0, total: 30 });
    assert.equal(getGame(db, '21').new_ach_date, null,
      'every row would otherwise arrive in the bell on its first sync');
  });

  test('a total that holds or falls does not stamp it', () => {
    const db = fresh();
    seeded(db, '22', { achieved: 3, total: 12 });
    updateGameStats(db, '22', { achieved: 4, total: 12 });
    updateGameStats(db, '22', { achieved: 4, total: 11 });
    assert.equal(getGame(db, '22').new_ach_date, null);
  });
});

describe('had no achievement system before and has one now', () => {
  test('has_achievements 0 → 1 fires, and is written to the database', () => {
    const db = fresh();
    insertGame(db, { appid: '6', name: 'G6' });
    markNoAchievements(db, '6');
    const r = updateGameStats(db, '6', { achieved: 0, total: 5 });
    assert.equal(r.achAdded, true);
    assert.ok(getGame(db, '6').ach_added_date);
  });

  test('has_achievements being NULL does not fire — NULL means "not synced yet", not "achievements added"', () => {
    const db = fresh();
    insertGame(db, { appid: '7', name: 'G7' });
    // Get this one backwards and the first full sync stuffs the whole library into the bell
    assert.equal(updateGameStats(db, '7', { achieved: 1, total: 5 }).achAdded, false);
  });

  test('a row that always had achievements does not fire', () => {
    const db = fresh();
    seeded(db, '8', { achieved: 1, total: 5 });
    assert.equal(updateGameStats(db, '8', { achieved: 2, total: 5 }).achAdded, false);
  });
});

describe('the kinds do not interfere, and one event is one moment', () => {
  test('one sync should only hit the kinds that belong to it', () => {
    const db = fresh();
    seeded(db, '9', { achieved: 10, total: 10 });
    const r = updateGameStats(db, '9', { achieved: 10, total: 12 });
    assert.equal(r.perfectLost, true);
    assert.equal(r.achAdded, false);

    insertGame(db, { appid: '10', name: 'G10' });
    markNoAchievements(db, '10');
    const r2 = updateGameStats(db, '10', { achieved: 0, total: 5 });
    assert.equal(r2.achAdded, true);
    assert.equal(r2.perfectLost, false);
  });

  test('the existing bumped / gained semantics are untouched', () => {
    const db = fresh();
    seeded(db, '11', { achieved: 3, total: 10 });
    const r = updateGameStats(db, '11', { achieved: 5, total: 12 });
    assert.equal(r.bumped, true);
    assert.equal(r.gained, true);
  });

  test('a finished game gaining achievements stamps both dates with one moment', () => {
    const db = fresh();
    seeded(db, '30', { achieved: 10, total: 10 });
    updateGameStats(db, '30', { achieved: 10, total: 12 });
    const g = getGame(db, '30');
    assert.ok(g.perfect_lost_date && g.new_ach_date, 'both stamps have to be written for this event');
    assert.equal(g.perfect_lost_date, g.new_ach_date,
      'the bell lists this game once by recognising the two stamps as one event');

    // **The line above cannot see the edit worth guarding against.** Two clock reads a microsecond
    // apart nearly always give the same millisecond, so the equality holds whether the stamps
    // share one reading or take one each — the same shape as upsertHltb's stamp, where exactly
    // that edit left a runtime check green. What has to hold is structural: one clock reading
    const src = readFileSync(join(ROOT, 'lib', 'db.js'), 'utf8');
    const open = src.indexOf('export function updateGameStats');
    const close = src.indexOf('export function markNoAchievements');
    assert.ok(open !== -1 && close > open, 'both anchors must exist, or the slice below is empty and vacuous');
    const body = src.slice(open, close)
      // Line comments first: a `//` here can hold a `/*`, and the other order eats code
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((body.match(/nowIso\(\)/g) ?? []).length, 1,
      'updateGameStats reads the clock once and gives every stamp in the write that value');
  });
});
