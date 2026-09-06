/**
 * The one-time family-library import decides three things, and two of them look redundant
 * ------------------------------------------------
 * Run with: node --test
 *
 * The sync's own family check reads `GetRecentlyPlayedGames`, whose window is a fixed fortnight.
 * This import exists for everything older: measured on a live account, 18 shared games had been
 * played and 2 of them fell inside that fortnight. So the rules below are what stands between a
 * fresh library and permanently missing the other 16.
 *
 * **`include_own=0` is not the ownership check.** It drops apps only *you* hold; one held by you
 * *and* by another member comes back regardless — 122 of them on the measured account. Those rows
 * already carry an `rtime_last_played`, and letting the import write a second source into the same
 * columns is how the two begin to disagree. A test built only from unowned fixtures passes against
 * code with no ownership gate at all, so the owned cases here are the point rather than padding.
 *
 * **`rt_playtime > 0` is the filter and the achievement count is not.** Over 764 untracked
 * candidates, unlocking something without playtime happened zero times; the reverse — real hours,
 * nothing unlocked — was 4 of the 5 hits. The achievement rule would have imported the one game
 * already at 7/7 and skipped the one with 22 hours against 42 untouched achievements.
 *
 * **A row already here is filled in, not rewritten.** Only the two columns nothing else can fill
 * for a shared row. A backfill that also touched the name would undo a hand-corrected title, and
 * one that ran unconditionally would rewrite every row on every press.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planFamilyImport } from '../lib/family.js';

/** A GetSharedLibraryApps entry, with only the fields the planner reads */
const app = (appid, over = {}) => ({
  appid,
  name: `Game ${appid}`,
  exclude_reason: 0,
  rt_playtime: 100,
  rt_last_played: 1_700_000_000,
  ...over,
});

const plan = (apps, { existing = [], owned = [] } = {}) => planFamilyImport({
  apps,
  existing: new Map(existing.map((r) => [String(r.appid), r])),
  ownedIds: new Set(owned.map(String)),
});

describe('planFamilyImport', () => {
  test('a played shared game that is not in the table is added', () => {
    const r = plan([app('477740', { name: 'Zero Escape', rt_playtime: 2401 })]);

    assert.deepEqual(r.add.map((a) => [a.appid, a.name, a.playtime]), [['477740', 'Zero Escape', 2401]]);
    assert.deepEqual(r.backfill, []);
  });

  test('a shared game with no playtime is not imported', () => {
    const r = plan([app('620', { rt_playtime: 0 })]);

    assert.deepEqual(r.add, [], 'the family library is 900-odd games; only the played ones are yours');
    assert.deepEqual(r.backfill, []);
  });

  test('an app you also own is skipped even though include_own asked for it not to come back', () => {
    const r = plan([app('1086940')], { owned: ['1086940'] });

    assert.deepEqual(r.add, [], 'it already has an rtime_last_played from GetOwnedGames');
    assert.deepEqual(r.backfill, []);
  });

  test('ownership outranks being absent from the table', () => {
    // The shape that catches a planner checking the table first and returning early
    const r = plan([app('1086940')], { owned: ['1086940'], existing: [] });

    assert.deepEqual(r.add, []);
  });

  test('a row already in the table is filled in rather than added', () => {
    const r = plan([app('1584090', { rt_playtime: 2743, rt_last_played: 1_717_561_285 })], {
      existing: [{ appid: '1584090', name: '东方夜雀食堂', playtime_forever: null, last_played: null }],
    });

    assert.deepEqual(r.add, []);
    assert.deepEqual(r.backfill.map((b) => [b.appid, b.playtime, b.lastPlayed]), [['1584090', 2743, 1_717_561_285]]);
    assert.equal(r.backfill[0].name, '东方夜雀食堂', 'the stored name, not the one Steam just sent — a hand-corrected title stays');
  });

  test('a row already carrying both values is left alone, so a second press writes nothing', () => {
    const r = plan([app('1584090', { rt_playtime: 2743, rt_last_played: 1_717_561_285 })], {
      existing: [{ appid: '1584090', name: '东方夜雀食堂', playtime_forever: 2743, last_played: 1_717_561_285 }],
    });

    assert.deepEqual(r.backfill, [], 'setGameField moves updated_at; an unchanged row has nothing to say');
  });

  test('a row whose playtime has moved since is filled in again', () => {
    const r = plan([app('1584090', { rt_playtime: 3000 })], {
      existing: [{ appid: '1584090', name: '东方夜雀食堂', playtime_forever: 2743, last_played: 1_717_561_285 }],
    });

    assert.equal(r.backfill.length, 1);
    assert.equal(r.backfill[0].playtime, 3000);
  });

  test('an excluded app is counted, never imported', () => {
    const r = plan([
      app('570', { name: 'Dota 2', exclude_reason: 3 }),
      app('365590', { name: 'The Division', exclude_reason: 1 }),
    ]);

    assert.deepEqual(r.add, [], 'the family cannot actually share these');
    assert.equal(r.excluded.length, 2, 'counted rather than dropped, so the total the user sees adds up');
  });

  test('a never-played timestamp becomes null, not 1970', () => {
    const r = plan([app('477740', { rt_last_played: 0 })]);

    assert.equal(r.add[0].lastPlayed, null,
      'zero is Steam saying "never"; stored as-is it would date the row to 1970 and sort above everything');
  });

  test('an app with no name at all still imports under something addressable', () => {
    const r = plan([app('999999', { name: undefined })]);

    assert.equal(r.add[0].name, 'AppID 999999');
  });
});
