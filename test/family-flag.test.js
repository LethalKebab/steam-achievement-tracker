/**
 * The family badge's whole life: put on by being played, taken off by being owned
 * ------------------------------------------------
 * Run with: node --test
 *
 * `family` means "this row is not something I bought". `syncLibrary` is both ends of it —
 * `GetRecentlyPlayedGames` names a shared game the moment it is played and the row is created
 * with the badge, and `GetOwnedGames` naming that same appid later is what takes the badge off.
 * Nothing else writes the column except `addGame` and the badge on the row.
 *
 * **Detection has no other source.** A shared title is invisible to `GetOwnedGames` forever, so
 * the recently-played list is the only thing standing between "played it" and "tracked". Two ways
 * that goes quiet without erroring: skipping a game because it is *owned* is right, skipping one
 * because the endpoint returned nothing is not, and both look like "no new games" from outside.
 *
 * **`last_played` for these rows is derived, not read.** The response has no `rtime_last_played`,
 * only playtime, so it is the playtime *moving* that dates the row — which means the first
 * observation can never stamp one, and a test that skips the baseline run will assert the wrong
 * thing and pass.
 *
 * **The dangerous edit is clearing it unconditionally**, because the loop this lives in reads
 * like it is already scoped to owned rows — it is not the only pass over the table, and the rows
 * that matter most here are exactly the ones `GetOwnedGames` never mentions. A version that
 * clears every row still passes a test that only checks "the bought game lost its badge", so the
 * preservation case below is the one carrying the weight, and it is asserted through a sync that
 * returns a *non-empty* owned list — an empty one would pass against code that clears everything
 * it iterates, since it would iterate nothing.
 *
 * The count is asserted separately from the column: `familyCleared` reaches a terminal line, and
 * a counter that moves without a write (or a write that does not move it) is how that line starts
 * lying about what happened.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertGame, getGame } from '../lib/db.js';
import { syncLibrary } from '../lib/sync.js';

/** Owned rows come back with the English name already on them, as the real response does */
function fakeSteam({ owned = [], recent = [] } = {}) {
  return {
    storeDelay: 0,
    delay: 0,
    async fetchOwnedGamesWithUnvettedFlag() {
      return {
        games: owned,
        unvettedAppIds: new Set(),
        playSnapshot: new Map(owned.map((g) => [String(g.appid), 0])),
      };
    },
    async fetchRecentlyPlayedGames() { return recent; },
    async fetchAppName() { return null; },
    async fetchAppNameEn() { return null; },
  };
}

describe('syncLibrary clears the family flag on rows that became owned', () => {
  test('a family row that now appears in GetOwnedGames loses the badge, and is counted', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '3117820', name: '苏丹的游戏', nameEn: "Sultan's Game", family: 1 });

    const r = await syncLibrary(db, fakeSteam({ owned: [{ appid: 3117820, name: "Sultan's Game" }] }));

    assert.equal(getGame(db, '3117820').family, 0, 'bought after being played through the family library');
    assert.equal(r.familyCleared, 1);
  });

  test('a family row absent from the owned list keeps the badge', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1584090', name: '东方夜雀食堂', nameEn: 'Touhou Mystia', family: 1 });

    // A non-empty owned list, deliberately: against code that clears every row it walks, an empty
    // one walks nothing and passes while proving nothing
    const r = await syncLibrary(db, fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }] }));

    assert.equal(getGame(db, '1584090').family, 1, 'still shared, still not bought — this is the whole point of the flag');
    assert.equal(r.familyCleared, 0);
  });

  test('an owned row that never had the flag is not written', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1366540', name: '戴森球计划', nameEn: 'Dyson Sphere Program' });

    const r = await syncLibrary(db, fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }] }));

    assert.equal(r.familyCleared, 0, 'setGameField moves updated_at; a row already at 0 has nothing to say');
  });

  test('a second run over the same library clears nothing more', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '3117820', name: '苏丹的游戏', nameEn: "Sultan's Game", family: 1 });
    const steam = fakeSteam({ owned: [{ appid: 3117820, name: "Sultan's Game" }] });

    await syncLibrary(db, steam);
    const second = await syncLibrary(db, steam);

    assert.equal(second.familyCleared, 0);
  });

  test('a locked row is cleared too — the lock is about achievement numbers, not about metadata', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '3117820', name: '苏丹的游戏', nameEn: "Sultan's Game", family: 1, status: 'Manual' });

    const r = await syncLibrary(db, fakeSteam({ owned: [{ appid: 3117820, name: "Sultan's Game" }] }));

    assert.equal(getGame(db, '3117820').family, 0);
    assert.equal(getGame(db, '3117820').status, 'Manual', 'the status restamp still leaves a Manual lock alone');
    assert.equal(r.familyCleared, 1);
  });
});

describe('syncLibrary picks up shared games from the recently-played list', () => {
  test('a played game the owned list does not mention is added, flagged family', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam({
      owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }],
      recent: [{ appid: 2624670, name: "Find Matt's Cats", playtime_forever: 2936, playtime_2weeks: 1898 }],
    });

    const r = await syncLibrary(db, steam);

    const row = getGame(db, '2624670');
    assert.equal(row.family, 1, 'recently played and not owned is exactly what the badge means');
    assert.equal(row.name_en, "Find Matt's Cats", 'the response carries the canonical title; it costs no store call');
    assert.deepEqual(r.familyAdded.map((a) => a.appid), ['2624670']);
  });

  test('a recently played game that is owned is left entirely alone', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam({
      owned: [{ appid: 1086940, name: "Baldur's Gate 3" }],
      recent: [{ appid: 1086940, name: "Baldur's Gate 3", playtime_forever: 843 }],
    });

    const r = await syncLibrary(db, steam);

    assert.equal(getGame(db, '1086940').family, 0, 'an owned game is not a family game');
    assert.equal(getGame(db, '1086940').last_played, null, 'owned rows take their timestamp from playSnapshot, not from here');
    assert.deepEqual(r.familyAdded, []);
    assert.equal(r.familyPlayed, 0);
  });

  test('the first sighting records a baseline and dates nothing', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam({
      owned: [],
      recent: [{ appid: 2624670, name: "Find Matt's Cats", playtime_forever: 2936 }],
    });

    const r = await syncLibrary(db, steam);

    assert.equal(getGame(db, '2624670').playtime_forever, 2936);
    assert.equal(getGame(db, '2624670').last_played, null,
      'with no previous playtime there is no transition — stamping here would date every row to whenever the column arrived');
    assert.equal(r.familyPlayed, 0);
  });

  test('playtime growing between runs is what stamps last_played', async () => {
    const db = openDb(':memory:');
    const owned = [];
    await syncLibrary(db, fakeSteam({ owned, recent: [{ appid: 2624670, name: "Find Matt's Cats", playtime_forever: 2936 }] }));

    const r = await syncLibrary(db, fakeSteam({ owned, recent: [{ appid: 2624670, name: "Find Matt's Cats", playtime_forever: 3000 }] }));

    const row = getGame(db, '2624670');
    assert.equal(row.playtime_forever, 3000);
    assert.equal(typeof row.last_played, 'number');
    assert.ok(Math.abs(row.last_played - Math.floor(Date.now() / 1000)) < 60, 'stamped at the moment of noticing, in seconds like rtime_last_played');
    assert.equal(r.familyPlayed, 1);
  });

  test('an unchanged playtime stamps nothing on the run after', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam({ owned: [], recent: [{ appid: 2624670, name: "Find Matt's Cats", playtime_forever: 2936 }] });

    await syncLibrary(db, steam);
    await syncLibrary(db, steam);
    const third = await syncLibrary(db, steam);

    assert.equal(getGame(db, '2624670').last_played, null, 'the number never moved, so the game was never played');
    assert.equal(third.familyPlayed, 0);
  });

  test('a row that becomes owned gives up the stand-in timestamp along with the badge', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '3117820', name: '苏丹的游戏', nameEn: "Sultan's Game", family: 1 });
    const shared = { owned: [], recent: [{ appid: 3117820, name: "Sultan's Game", playtime_forever: 100 }] };

    // Two shared runs, so the row ends up carrying both a playtime and a derived date
    await syncLibrary(db, fakeSteam(shared));
    await syncLibrary(db, fakeSteam({ ...shared, recent: [{ appid: 3117820, name: "Sultan's Game", playtime_forever: 160 }] }));
    assert.equal(getGame(db, '3117820').playtime_forever, 160, 'precondition: the row was dated the derived way');

    await syncLibrary(db, fakeSteam({ owned: [{ appid: 3117820, name: "Sultan's Game" }] }));

    const row = getGame(db, '3117820');
    assert.equal(row.family, 0);
    assert.equal(row.playtime_forever, null,
      '"there is no rtime here" must not stay on a row where there now is — the same defect the badge just lost');
  });

  test('a row that never had one is not written to, so updated_at does not move', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1366540', name: '戴森球计划', nameEn: 'Dyson Sphere Program' });
    const steam = fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }] });

    // **Pinned to an old value, not read back after a first sync.** `setGameField` stamps
    // `updated_at` with a millisecond ISO string, and two syncs inside one test land in the same
    // millisecond — so comparing two live stamps cannot tell a write from no write at all.
    db.prepare("UPDATE games SET updated_at = ? WHERE appid = ?").run('2020-01-01T00:00:00.000Z', '1366540');

    await syncLibrary(db, steam);

    // There is no counter on this clear, so updated_at is the only thing that separates an
    // unconditional write from a guarded one — and an unconditional one touches every owned row
    // on every sync, forever
    assert.equal(getGame(db, '1366540').updated_at, '2020-01-01T00:00:00.000Z');
  });

  test('a response with no playtime field records nothing, so the next real one is not read as a play', async () => {
    const db = openDb(':memory:');

    // Steam omits the field: not a reading of zero, and not a baseline
    await syncLibrary(db, fakeSteam({ owned: [], recent: [{ appid: 2624670, name: "Find Matt's Cats" }] }));
    assert.equal(getGame(db, '2624670').playtime_forever, null, 'absence is not zero');

    const r = await syncLibrary(db, fakeSteam({ owned: [], recent: [{ appid: 2624670, name: "Find Matt's Cats", playtime_forever: 90 }] }));

    assert.equal(getGame(db, '2624670').playtime_forever, 90, 'the first real number is the baseline');
    assert.equal(getGame(db, '2624670').last_played, null,
      'a first observation never stamps — recording 0 earlier would have made this look like 0 → 90');
    assert.equal(r.familyPlayed, 0);
  });

  test('the endpoint failing costs the family check and not the sync', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }] });
    steam.fetchRecentlyPlayedGames = async () => null; // what SteamClient returns on a non-200

    const r = await syncLibrary(db, steam);

    assert.equal(r.ownedCount, 1, 'the rest of phase one still ran');
    assert.deepEqual(r.familyAdded, []);
    assert.equal(r.familyPlayed, 0);
    assert.equal(r.familyChecked, false,
      'the two counters read zero for a quiet fortnight as well; without this a throttled key reports "nothing new" forever');
  });

  test('a genuinely empty fortnight is reported as a check that happened', async () => {
    const db = openDb(':memory:');

    const r = await syncLibrary(db, fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }], recent: [] }));

    assert.equal(r.familyChecked, true);
    assert.equal(r.familyPlayed, 0);
  });
});
