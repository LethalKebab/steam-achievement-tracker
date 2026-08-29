/**
 * The automatic checkbox pass's candidate rules + the gained flag
 * ------------------------------------------------
 * Run with: node --test
 *
 * What is pinned is "which guide pages the automatic tick pass reads when the Dashboard is
 * opened". This layer fails silently in both directions, and neither raises an exception:
 *
 * - **Too loose** → every Dashboard open burns dozens of Notion page reads plus dozens of
 *   Steam calls for nothing. The feature looks entirely normal, it is merely slow and
 *   expensive, and without reading the log it is undiscoverable.
 * - **Too tight** → boxes that should be ticked are not, and since the checkbox sync only
 *   ever ticks and never unticks, a miss stays missed.
 *
 * The most critical of all is `appids: []`: an empty array has to mean "run nothing". Any
 * form that treats it as falsy and falls back to everything
 * (`appids?.length ? … : everything`) translates the most common case — nothing changed
 * this time — into a full scan, and the targeted sync stops working outright.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, insertGame, upsertGuide, updateGameStats, replaceAchievements,
} from '../lib/db.js';
import { selectCheckboxCandidates } from '../lib/guides.js';

const freshDb = () => openDb(':memory:');

/** An ordinary candidate row: has a guide, has an achievement system, not yet complete */
function seedGame(db, { appid, name = 'G' + appid, achieved = 5, total = 10, guide = true }) {
  insertGame(db, { appid, name });
  if (total !== null) updateGameStats(db, appid, { achieved, total });
  if (guide) upsertGuide(db, { appid, name, url: 'https://notion.so/' + appid, kind: 'notion' });
}

/** Puts one achievement definition under an appid (a 100% game needs it to be a candidate at all) */
function seedAchievement(db, appid) {
  replaceAchievements(db, appid, [
    {
      apiName: 'ACH_1', gameName: 'G' + appid, nameCn: '成就一',
      nameEn: 'Ach One', description: '描述', hidden: false, icon: '',
    },
  ]);
}

const ids = (db, opts) => selectCheckboxCandidates(db, opts).games.map((g) => g.appid).sort();

describe('selectCheckboxCandidates — the basic conditions', () => {
  test('a game with no registered guide is not a candidate', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2', guide: false });
    assert.deepEqual(ids(db), ['1']);
  });

  test('a game with no achievement system is not a candidate (total is NULL)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2', total: null });
    assert.deepEqual(ids(db), ['1']);
  });

  test('a game already at 100%: skipped outright when sub-steps do not cascade', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2', achieved: 10, total: 10 });
    seedAchievement(db, '2');
    assert.deepEqual(ids(db, { cascade: false }), ['1']);
  });

  test('already at 100% with achievement detail: a candidate when cascade is on (sub-steps may still be empty)', () => {
    const db = freshDb();
    seedGame(db, { appid: '2', achieved: 10, total: 10 });
    seedAchievement(db, '2');
    assert.deepEqual(ids(db, { cascade: true }), ['2']);
  });

  test('already at 100% with no achievement detail: not a candidate even with cascade on — the parent achievement cannot be recognised, so reading it achieves nothing', () => {
    const db = freshDb();
    seedGame(db, { appid: '2', achieved: 10, total: 10 });
    assert.deepEqual(ids(db, { cascade: true }), []);
  });
});

describe('selectCheckboxCandidates — a game that just hit 100%', () => {
  // This group pins a hole that is very easy to miss: "the achievement that completed the
  // game" — if its box relies solely on the 100%-skip rule, it can **never** be ticked,
  // because by the next round the game is already at 100% and is blocked from being a
  // candidate at all. Being named (the appids whitelist) means "this row changed this
  // round", and that means it just completed, so the last few boxes are most likely empty.
  test('a 100% game named this round: a candidate even without cascade (the last achievement\'s box is still empty)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', achieved: 10, total: 10 });
    seedAchievement(db, '1');
    assert.deepEqual(ids(db, { appids: ['1'], cascade: false }), ['1']);
  });

  test('an unnamed 100% game is still skipped without cascade (the CLI\'s full --no-cascade behaviour is unchanged)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', achieved: 10, total: 10 });
    seedAchievement(db, '1');
    assert.deepEqual(ids(db, { appids: null, cascade: false }), []);
  });

  test('named but with no achievement detail: still not a candidate — the gate that stops the 55/55 batch of wasted reads must not be bypassed', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', achieved: 10, total: 10 });
    assert.deepEqual(ids(db, { appids: ['1'], cascade: false }), []);
  });
});

describe('selectCheckboxCandidates — the appids whitelist (serve\'s targeted ticking)', () => {
  test('no appids (null) → no restriction, and everything qualifying is a candidate', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    assert.deepEqual(ids(db, { appids: null }), ['1', '2']);
  });

  test('**an empty array = run nothing**, not "no restriction" — with nothing changed this open, there should be zero external calls', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    assert.deepEqual(ids(db, { appids: [] }), []);
  });

  test('only the rows in the whitelist are run', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    seedGame(db, { appid: '3' });
    assert.deepEqual(ids(db, { appids: ['1', '3'] }), ['1', '3']);
  });

  test('a numeric appid in the whitelist is recognised too (the appid column is TEXT and the source is not necessarily a string)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    assert.deepEqual(ids(db, { appids: [1] }), ['1']);
  });

  test('the whitelist cannot bypass the basic conditions: a row with no guide is not read even when whitelisted', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', guide: false });
    assert.deepEqual(ids(db, { appids: ['1'] }), []);
  });

  test('the CLI\'s single-appid argument still works and does not interfere with appids', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    assert.deepEqual(ids(db, { appid: '2' }), ['2']);
  });
});

describe('updateGameStats — the gained flag (the targeted pass\'s input)', () => {
  test('the unlock count rose → gained', () => {
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 3, total: 10 });
    const r = updateGameStats(db, '1', { achieved: 4, total: 10 });
    assert.equal(r.gained, true);
    assert.equal(r.bumped, false);
  });

  test('the unlock count did not change → not a candidate', () => {
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 3, total: 10 });
    assert.equal(updateGameStats(db, '1', { achieved: 3, total: 10 }).gained, false);
  });

  test('the first sync of this row (no baseline) → gained is false', () => {
    // This is the key to stopping the targeted pass degenerating into a full one: on a first
    // sync every row in the library goes NULL→a number for achieved, and treating that as "it
    // rose" would make several hundred rows candidates at once, spending back every call saved
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    assert.equal(updateGameStats(db, '1', { achieved: 7, total: 10 }).gained, false);
  });

  test('only total rose (a developer added achievements) → bumped, with nothing newly unlocked', () => {
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 10, total: 10 });
    const r = updateGameStats(db, '1', { achieved: 10, total: 12 });
    assert.equal(r.bumped, true);
    assert.equal(r.gained, false);
  });
});
