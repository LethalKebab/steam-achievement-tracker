/**
 * The family badge is cleared by ownership, and by nothing else
 * ------------------------------------------------
 * Run with: node --test
 *
 * `family` means "this row is not something I bought". It is written by `addGame` and by the
 * badge on the row, and `syncLibrary` is the only thing that ever takes it off: a game that has
 * arrived in `GetOwnedGames` is owned, which contradicts the badge, and nothing else would ever
 * notice.
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
function fakeSteam({ owned = [] } = {}) {
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
