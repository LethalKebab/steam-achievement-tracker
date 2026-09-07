/**
 * "Ask again later" and "this will never answer again" are different sentences
 * ------------------------------------------------
 * Run with: node --test
 *
 * `GetPlayerAchievements` answers 403 `"Profile is not public"` when this account holds no licence
 * for the game any more — a family member left the group, or it was refunded — and also when the
 * per-game achievement privacy toggle is off. The two are byte-identical, and neither ever succeeds
 * on a retry. 429 is the opposite: it always will.
 *
 * Both used to collapse into one `{retry: true}` and one `retried` count, so a row that Steam will
 * refuse forever was indistinguishable from a throttled one — its number sat frozen on the
 * Dashboard with nothing saying so, and every sync spent a request re-asking. What this file pins:
 *
 * - **`retry` stays true on a 403.** Seven call sites read this shape and six are
 *   `if (raw.retry) → error / throw / skip`; dropping it sends all six into the success branch to
 *   read an `achievements` array that is not there. The flag is additive, never a replacement.
 * - **A 403 still writes no `stats_checked_at`.** That rule is what stops throttling turning into
 *   silent data loss, and it protects this case too: a licence can come back, and a row stamped as
 *   checked would never be looked at again.
 * - **429 must not be reported as permanent.** A test built only from 403 fixtures passes against
 *   code that names every retry, which would put a rate-limited row in front of the user with an
 *   instruction to switch it to manual.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertGame, getGame } from '../lib/db.js';
import { SteamClient, sleep } from '../lib/steam.js';
import { syncAchievementStats } from '../lib/sync.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const clientAnswering = (status, body = '') => {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(body || '{}'); },
    async text() { return body; },
  });
  return new SteamClient({ steamApiKey: 'k', steamId: '1' });
};

describe('SteamClient.fetchPlayerAchievements classifies the refusal', () => {
  test('403 is permanent, and says so alongside retry rather than instead of it', async () => {
    const r = await clientAnswering(403, '{"playerstats":{"error":"Profile is not public","success":false}}')
      .fetchPlayerAchievements('1');

    assert.equal(r.forbidden, true);
    assert.equal(r.retry, true,
      'six call sites branch on retry; without it they fall through to read achievements that are not there');
    assert.equal(r.noAchievementSystem, undefined, 'a licence problem is not "this game has no achievements"');
  });

  test('429 is the transient one and carries no permanence', async () => {
    const r = await clientAnswering(429).fetchPlayerAchievements('1');

    assert.equal(r.retry, true);
    assert.ok(!r.forbidden, 'rate limiting always succeeds later — telling the user to switch to manual would be wrong');
  });

  test('a server error is transient too', async () => {
    const r = await clientAnswering(500).fetchPlayerAchievements('1');

    assert.equal(r.retry, true);
    assert.ok(!r.forbidden);
  });

  test('400 keeps meaning "no achievement system", not a refusal', async () => {
    const r = await clientAnswering(400).fetchPlayerAchievements('1');

    assert.equal(r.noAchievementSystem, true);
    assert.ok(!r.forbidden);
  });
});

/** Only the two methods phase two touches; `fetchAchievementStats` passes the flag straight through */
const fakeSteam = (perApp) => ({
  delay: 0,
  storeDelay: 0,
  async fetchAppName() { return null; },
  async fetchAchievementStats(appid) { return perApp[String(appid)]; },
});

describe('phase two names the rows that will never answer', () => {
  test('a refused row is named, counted as a retry, and left unstamped', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '242760', name: 'The Forest' });

    const r = await syncAchievementStats(db, fakeSteam({ 242760: { retry: true, forbidden: true } }));

    assert.deepEqual(r.forbidden, ['The Forest']);
    assert.equal(r.retried, 1, 'still a retry — the row is not written off, only reported');
    assert.equal(getGame(db, '242760').stats_checked_at, null,
      'stamping it would skip the row next run, and a licence can come back');
  });

  test('a throttled row is counted but never named', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '620', name: 'Portal 2' });

    const r = await syncAchievementStats(db, fakeSteam({ 620: { retry: true } }));

    assert.deepEqual(r.forbidden, [], 'it will succeed on its own; asking the user to act would be a false alarm');
    assert.equal(r.retried, 1);
  });

  test('a mixed run separates the two', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '242760', name: 'The Forest' });
    insertGame(db, { appid: '651490', name: '昨日难留' });
    insertGame(db, { appid: '620', name: 'Portal 2' });

    const r = await syncAchievementStats(db, fakeSteam({
      242760: { retry: true, forbidden: true },
      651490: { retry: true, forbidden: true },
      620: { retry: true },
    }));

    assert.deepEqual(r.forbidden.sort(), ['The Forest', '昨日难留'].sort());
    assert.equal(r.retried, 3, 'all three are retries; only two are permanent');
  });

  test('a successful row is neither', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '620', name: 'Portal 2' });

    const r = await syncAchievementStats(db, fakeSteam({ 620: { achieved: 3, total: 51 } }));

    assert.deepEqual(r.forbidden, []);
    assert.equal(r.retried, 0);
    assert.equal(getGame(db, '620').achieved, 3);
  });
});
