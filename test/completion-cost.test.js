/**
 * What finishing a game would cost
 * ------------------------------------------------
 * Run with: node --test
 *
 * Three sources answer "what is left and what will it take": which achievements this account
 * holds (`achievements.unlocked`), how rare each one is globally (`achievements.rarity`), and how
 * many hours the whole game takes at 100% (the `hltb` table). None of them is a count the reader
 * can re-derive by looking at the screen, so a silent loss shows up as an interface that has
 * quietly stopped saying anything useful rather than as an error.
 *
 * The dangerous edits this file pins, in order of how easy each is to make by accident:
 *
 * 1. **Putting `replaceAchievements` back to DELETE-then-INSERT.** It reads as a tidier way to
 *    write the same thing, and it would erase `unlocked` and `rarity` on every description
 *    refresh — which is most syncs. Two tests below: that the volatile columns survive, and that
 *    a removed achievement still goes away, because the second is what the DELETE was for.
 * 2. **Letting an unverified HowLongToBeat match through.** Searching a name returns sequels
 *    ahead of the game asked for, so a "best effort" fallback would report the wrong hours with
 *    no sign anything is wrong. `resolve` must answer with no hours at all.
 * 3. **Dropping the recorded miss.** A game HowLongToBeat has never heard of must be asked once,
 *    not once per sync at four queries each.
 * 4. **Overwriting a hand-pinned id.** Pinning happens precisely because the search failed or
 *    was wrong; an automatic pass that clobbers it undoes the reader's only remedy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, insertGame, updateGameStats, replaceAchievements, achievementsFor,
  setAchievementUnlocks, setAchievementRarity, hardestRemaining,
  upsertHltb, getHltb, allHltb,
} from '../lib/db.js';
import { selectHltbTargets, selectRarityTargets, syncHltb } from '../lib/sync.js';
import { HltbClient, searchQueries, stripCJK } from '../lib/hltb.js';
import { SteamClient } from '../lib/steam.js';

const ach = (apiName, extra = {}) => ({ apiName, nameCn: apiName, description: 'd', ...extra });

/** A database with one unfinished game whose three achievements are on record */
function seeded() {
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: 'Game One', nameEn: 'Game One' });
  updateGameStats(db, '1', { achieved: 1, total: 3 });
  replaceAchievements(db, '1', [ach('A'), ach('B'), ach('C')]);
  setAchievementUnlocks(db, '1', ['A']);
  setAchievementRarity(db, '1', new Map([['A', 55], ['B', 30], ['C', 2.5]]));
  return db;
}

describe('replaceAchievements keeps what it does not own', () => {
  test('a description refresh does not clear unlocked or rarity', () => {
    const db = seeded();
    // The same three achievements arriving again, as a schema refresh delivers them
    replaceAchievements(db, '1', [ach('A'), ach('B'), ach('C')]);
    const rows = Object.fromEntries(achievementsFor(db, '1').map((r) => [r.api_name, r]));
    assert.equal(rows.A.unlocked, 1, 'the unlock flag came from GetPlayerAchievements, not from this schema');
    assert.equal(rows.B.unlocked, 0);
    assert.equal(rows.C.rarity, 2.5, 'rarity came from the global percentages endpoint');
    assert.equal(rows.A.rarity, 55);
  });

  test('an achievement the developer removed still disappears', () => {
    const db = seeded();
    replaceAchievements(db, '1', [ach('A'), ach('B')]);
    const names = achievementsFor(db, '1').map((r) => r.api_name).sort();
    assert.deepEqual(names, ['A', 'B'], 'C is gone from the schema, so it must be gone from the table');
  });

  test('the descriptive columns are still overwritten', () => {
    const db = seeded();
    replaceAchievements(db, '1', [ach('A', { nameCn: '新名字', description: '新描述' })]);
    const row = achievementsFor(db, '1').find((r) => r.api_name === 'A');
    assert.equal(row.name_cn, '新名字');
    assert.equal(row.description, '新描述');
    assert.equal(row.unlocked, 1, 'and the volatile columns are still untouched alongside');
  });
});

describe('the rarest thing still in the way', () => {
  test('hardestRemaining reports the lowest rarity among locked achievements only', () => {
    const db = seeded();
    const [row] = hardestRemaining(db);
    assert.equal(row.appid, '1');
    assert.equal(row.min_rarity, 2.5, 'C is locked and rarest; A is rarer than B but already held');
    assert.equal(row.locked_known, 2);
  });

  test('an achievement with no rarity on record is left out rather than counted as easy', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '9', name: 'Sparse' });
    updateGameStats(db, '9', { achieved: 0, total: 2 });
    replaceAchievements(db, '9', [ach('X'), ach('Y')]);
    setAchievementUnlocks(db, '9', []);
    setAchievementRarity(db, '9', new Map([['X', 40]]));
    const [row] = hardestRemaining(db);
    assert.equal(row.locked_known, 1, 'Y has no figure, so it contributes nothing in either direction');
    assert.equal(row.min_rarity, 40);
  });
});

describe('HowLongToBeat — a name is a candidate, an appid is the answer', () => {
  test('stripCJK leaves the English half of a bilingual title', () => {
    assert.equal(stripCJK('鬼谷八荒 Tale of Immortal'), 'Tale of Immortal');
    assert.equal(stripCJK('风信楼'), '', 'nothing left to search with — this one has to be pinned by hand');
  });

  test('searchQueries splits on the slash and drops the useless remnants', () => {
    const qs = searchQueries("Roman's Christmas / 罗曼圣诞探案集", "Roman's Christmas / 罗曼圣诞探案集");
    assert.ok(qs.includes("Roman's Christmas"), 'the half that has a chance of matching');
    assert.ok(qs.every((q) => q.length >= 3), 'a one- or two-character query matches everything');
    assert.ok(qs.length <= 4, 'each query costs a search plus up to three page fetches');
  });

  test('resolve reports nothing at all when no candidate names this appid', async () => {
    const c = new HltbClient({ hltbRequestDelayMs: 0 });
    c.session = { token: 't', hpKey: 'k', hpVal: 'v' };
    // The search finds a plausible neighbour — this is the Cities: Skylines II case
    c.search = async () => [{ game_id: 555, game_name: 'Cities: Skylines II' }];
    c.detail = async () => ({ hltbId: 555, steam: 949230, steamAlt: 0, comp100: 360000, comp100Med: 350000 });
    const out = await c.resolve({ appid: '255710', nameEn: 'Cities: Skylines' });
    assert.equal(out.verified, false);
    assert.equal(out.comp100, undefined, 'a near miss must not be passed on as an estimate');
    assert.equal(out.comp100Med, undefined);
  });

  test('resolve accepts a match on the alternate appid', async () => {
    const c = new HltbClient({ hltbRequestDelayMs: 0 });
    c.session = { token: 't', hpKey: 'k', hpVal: 'v' };
    c.search = async () => [{ game_id: 77, game_name: 'Game One' }];
    c.detail = async () => ({ hltbId: 77, steam: 999999, steamAlt: 1, comp100: 3600, comp100Med: 3600 });
    const out = await c.resolve({ appid: '1', nameEn: 'Game One' });
    assert.equal(out.verified, true, 'a re-release carries the original appid in the alternate slot');
    assert.equal(out.hltbId, 77);
  });
});

describe('reading from a host nobody here controls', () => {
  /**
   * A body that never ends, and counts what was actually pulled out of it.
   *
   * **The counter is the whole assertion.** A first version streamed 5 MB and checked that
   * `detail` returned null — which it does either way, because 5 MB of padding contains no
   * `profile_steam` and fails to parse regardless. Removing the cap left that test green.
   * What separates the two is whether the read *stops*, so that is what is measured, and an
   * endless body means an uncapped read cannot pass by finishing early.
   */
  function endlessBody() {
    const state = { pulled: 0 };
    const stream = new ReadableStream({
      pull(c) {
        state.pulled += 65536;
        c.enqueue(new Uint8Array(65536));
      },
    });
    return { stream, state };
  }

  // An explicit timeout, because the regression this guards **hangs** rather than erroring: with
  // no cap the endless body above is read until memory runs out. Without this the failure mode
  // is a CI run that never finishes, which reads as infrastructure trouble rather than a bug
  test('an oversized page is abandoned part-way rather than read to the end', { timeout: 15000 }, async () => {
    const c = new HltbClient({ hltbRequestDelayMs: 0 });
    const original = globalThis.fetch;
    const { stream, state } = endlessBody();
    globalThis.fetch = async () => new Response(stream, { status: 200 });
    try {
      assert.equal(await c.detail(1), null, 'nothing usable came back');
      // Generous: the cap is 4 MB and a stream can be a chunk or two ahead of the reader
      assert.ok(state.pulled < 8 * 1024 * 1024,
        `the read did not stop — ${state.pulled} bytes were pulled from a body that never ends`);
    } finally { globalThis.fetch = original; }
  });

  test('a page under the cap still parses', async () => {
    const c = new HltbClient({ hltbRequestDelayMs: 0 });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"profile_steam":753640,"comp_100":104784,"comp_100_med":99000}', { status: 200 });
    try {
      const d = await c.detail(57527);
      assert.equal(d.steam, 753640);
      assert.equal(d.comp100Med, 99000);
    } finally { globalThis.fetch = original; }
  });

  test('a 403 refreshes the session and retries exactly once', async () => {
    // A 403 cannot be told apart from a real block, so a loop here would hammer a host that has
    // already said no. One retry covers the expired token, which is the only recoverable cause
    const c = new HltbClient({ hltbRequestDelayMs: 0 });
    const original = globalThis.fetch;
    let searches = 0;
    let inits = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/init')) {
        inits++;
        return new Response(JSON.stringify({ token: 't', hpKey: 'k', hpVal: 'v' }), { status: 200 });
      }
      searches++;
      return new Response('{"error":"Session expired or invalid fingerprint"}', { status: 403 });
    };
    try {
      assert.deepEqual(await c.search('anything'), []);
      assert.equal(searches, 2, 'the first attempt and one retry, and no more');
      assert.equal(inits, 2, 'the lazy first handshake, then the one the 403 forced');
    } finally { globalThis.fetch = original; }
  });

  test('a page that loads without profile_steam is a failure, not "no steam id"', async () => {
    // A throttled or error page parses fine and yields nothing. Reading that as an answer would
    // cache a wrong miss against the game permanently
    const c = new HltbClient({ hltbRequestDelayMs: 0 });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html><body>Too many requests</body></html>', { status: 200 });
    try {
      assert.equal(await c.detail(1), null);
    } finally { globalThis.fetch = original; }
  });
});

describe('the hltb table', () => {
  test('a miss is recorded, and stops the search happening again', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'Nowhere' });
    updateGameStats(db, '1', { achieved: 0, total: 5 });
    assert.equal(selectHltbTargets(db).resolve.length, 1, 'nothing on record yet, so it is asked');

    upsertHltb(db, '1', {}); // searched, found nothing
    const after = selectHltbTargets(db);
    assert.equal(after.resolve.length, 0, 'the miss is an answer; asking again would repeat four queries');
    assert.equal(after.refresh.length, 0, 'and there is no id to refresh');
    assert.equal(getHltb(db, '1').checked_at !== null, true, 'the stamp is what makes it a recorded miss');
  });

  test('a hand-pinned row survives an automatic pass', () => {
    const db = openDb(':memory:');
    upsertHltb(db, '1', { hltbId: 42, verified: true, manual: true, comp100Med: 7200 });
    const clobbered = upsertHltb(db, '1', { hltbId: 999, verified: true });
    assert.equal(clobbered, false, 'the automatic write reports that it declined');
    assert.equal(getHltb(db, '1').hltb_id, 42);
    assert.equal(getHltb(db, '1').comp_100_med, 7200);
  });

  test('a finished game is never a target — there is nothing left to cost', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'Done' });
    updateGameStats(db, '1', { achieved: 5, total: 5 });
    assert.equal(selectHltbTargets(db).resolve.length, 0);
    assert.equal(selectRarityTargets(db).length, 0);
  });

  test('a failed refresh keeps the hours it already had', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'Stale' });
    updateGameStats(db, '1', { achieved: 1, total: 5 });
    upsertHltb(db, '1', { hltbId: 42, verified: true, comp100Med: 7200 });
    // Push checked_at past the staleness window so it lands in the refresh list
    db.prepare("UPDATE hltb SET checked_at = '2000-01-01T00:00:00.000Z' WHERE appid = '1'").run();
    assert.equal(selectHltbTargets(db).refresh.length, 1);

    const failing = { resolve: async () => ({ verified: false }), refresh: async () => null };
    const out = await syncHltb(db, failing);
    assert.equal(out.refreshed, 0);
    assert.equal(getHltb(db, '1').comp_100_med, 7200, 'a timed-out page must not overwrite good hours with nothing');
  });

  test('syncHltb writes both outcomes and counts them apart', async () => {
    const db = openDb(':memory:');
    for (const id of ['1', '2']) {
      insertGame(db, { appid: id, name: 'G' + id });
      updateGameStats(db, id, { achieved: 0, total: 4 });
    }
    const client = {
      resolve: async ({ appid }) =>
        appid === '1'
          ? { verified: true, hltbId: 11, comp100Med: 25200, comp100Lo: 18000, comp100Hi: 54000, comp100Count: 120 }
          : { verified: false },
      refresh: async () => null,
    };
    const out = await syncHltb(db, client);
    assert.equal(out.resolved, 1);
    assert.equal(out.notFound, 1);
    assert.equal(allHltb(db).length, 2, 'the miss gets a row too, or it is searched again next run');
    assert.equal(getHltb(db, '1').comp_100_hi, 54000, 'the spread is stored, not just the midpoint');
    assert.equal(getHltb(db, '2').hltb_id, null);
  });
});

describe('the unlock list rides along for free', () => {
  test('fetchAchievementStats carries the api_names it was already counting', async () => {
    const c = new SteamClient({ steamApiKey: 'k', steamId: 's' });
    c.fetchPlayerAchievements = async () => ({
      achievements: [
        { apiname: 'A', achieved: 1 },
        { apiname: 'B', achieved: 0 },
        { apiname: 'C', achieved: 1 },
      ],
    });
    const res = await c.fetchAchievementStats('1');
    assert.equal(res.total, 3);
    assert.equal(res.achieved, 2, 'the count still means what it always meant');
    assert.deepEqual(res.unlocked, ['A', 'C']);
  });

  test('a game with no achievement system still short-circuits', async () => {
    const c = new SteamClient({ steamApiKey: 'k', steamId: 's' });
    c.fetchPlayerAchievements = async () => ({ noAchievementSystem: true });
    const res = await c.fetchAchievementStats('1');
    assert.equal(res.noAchievementSystem, true);
    assert.equal(res.unlocked, undefined, 'nothing to carry, and callers test the flag first');
  });
});
