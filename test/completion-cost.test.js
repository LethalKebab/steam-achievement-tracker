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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, insertGame, updateGameStats, replaceAchievements, achievementsFor,
  setAchievementUnlocks, setAchievementRarity, remainingDifficulty,
  upsertHltb, getHltb, allHltb,
} from '../lib/db.js';
import { selectHltbTargets, selectRarityTargets, syncHltb, fullSync } from '../lib/sync.js';
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

describe('how much of the difficulty is still ahead', () => {
  const shareOf = (db, appid) => {
    const r = remainingDifficulty(db).find((x) => x.appid === appid);
    return r.left_weight / r.all_weight;
  };

  test('the share is weighted by rarity, not by how many are left', () => {
    // Two games, each with one of three achievements left. The one whose remaining achievement is
    // rare must read as far more work than the one whose remaining achievement is common — a
    // count-based apportionment calls both exactly one third
    const db = openDb(':memory:');
    for (const [id, remainingRarity] of [['hard', 0.5], ['easy', 90]]) {
      insertGame(db, { appid: id, name: id });
      updateGameStats(db, id, { achieved: 2, total: 3 });
      replaceAchievements(db, id, [ach('A'), ach('B'), ach('C')]);
      setAchievementUnlocks(db, id, ['A', 'B']);
      setAchievementRarity(db, id, new Map([['A', 80], ['B', 70], ['C', remainingRarity]]));
    }
    const hard = shareOf(db, 'hard');
    const easy = shareOf(db, 'easy');
    assert.ok(hard > 0.85, `a 0.5% achievement is nearly all the work left, got ${hard.toFixed(3)}`);
    assert.ok(easy < 0.2, `a 90% achievement is nearly none of it, got ${easy.toFixed(3)}`);
    assert.ok(hard > easy * 4, 'and the two must not land anywhere near the 1/3 a count would give');
  });

  test('an achievement nobody at all holds is clamped, not infinite', () => {
    // Steam does publish 0. Left unclamped the weight is infinite, every other achievement in the
    // game rounds to nothing beside it, and the share pins to exactly 1 however much is done
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'Zero' });
    updateGameStats(db, '1', { achieved: 1, total: 2 });
    replaceAchievements(db, '1', [ach('A'), ach('B')]);
    setAchievementUnlocks(db, '1', ['A']);
    setAchievementRarity(db, '1', new Map([['A', 50], ['B', 0]]));
    const share = shareOf(db, '1');
    assert.ok(Number.isFinite(share), 'a finite number, not NaN or Infinity');
    assert.ok(share > 0.8 && share < 1, `dominant but not total, got ${share}`);
  });

  test('a row missing either column contributes to neither sum', () => {
    // An absent rarity is not evidence of anything. Counting it as easy would flatter exactly the
    // games least is known about, and counting it as hard would do the opposite
    const db = openDb(':memory:');
    insertGame(db, { appid: '9', name: 'Sparse' });
    updateGameStats(db, '9', { achieved: 0, total: 2 });
    replaceAchievements(db, '9', [ach('X'), ach('Y')]);
    setAchievementUnlocks(db, '9', []);
    setAchievementRarity(db, '9', new Map([['X', 40]]));
    const [row] = remainingDifficulty(db);
    assert.equal(row.known, 1, 'Y has no rarity, so it is in neither the numerator nor the denominator');
    assert.equal(row.left_weight, row.all_weight, 'X is the only one counted and it is locked');
  });

  test('a game with nothing unlocked has all of its difficulty ahead of it', () => {
    const db = seeded();
    setAchievementUnlocks(db, '1', []);
    assert.equal(shareOf(db, '1'), 1);
  });
});

describe('what finishing a game is worth', () => {
  /**
   * The gain half, through the real `getDashboardData`.
   *
   * **A game with nothing unlocked is not in the average at all.** Steam's method counts only
   * games with at least one achievement, so finishing an untouched one adds a term *and* grows the
   * divisor — `(1 − avg) / (N + 1)` — while finishing a started one only moves its own term,
   * `(1 − rate) / N`. One formula for both overstates the untouched game about fourfold, and
   * nothing on screen would look wrong: it is a plausible number in a column of plausible numbers.
   */
  async function dashboard(seed) {
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
    process.env.TRACKER_DATA_DIR = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y' }));
    const { createApi } = await import('../lib/api.js');
    const db = openDb(':memory:');
    seed(db);
    const api = createApi({ db, steam: {}, config: {}, syncState: { snapshot: () => ({}) } });
    const data = api.getDashboardData();
    rmSync(dir, { recursive: true, force: true });
    return Object.fromEntries(data.games.map((g) => [g.appid, g]));
  }

  test('an untouched game and a started one do not share a formula', async () => {
    const games = await dashboard((db) => {
      // Twenty games already at 50%, so the average and the divisor are both real
      for (let i = 0; i < 20; i++) {
        insertGame(db, { appid: 'e' + i, name: 'E' + i });
        updateGameStats(db, 'e' + i, { achieved: 5, total: 10 });
      }
      // One started, one never touched, both with the same completionist figure on record
      insertGame(db, { appid: 'started', name: 'Started' });
      updateGameStats(db, 'started', { achieved: 5, total: 10 });
      insertGame(db, { appid: 'untouched', name: 'Untouched' });
      updateGameStats(db, 'untouched', { achieved: 0, total: 10 });
      for (const id of ['started', 'untouched']) upsertHltb(db, id, { hltbId: 1, verified: true, comp100Med: 36000 });
    });

    // 21 eligible games all at 50%, so avg = 0.5 and N = 21
    const started = games.started.cost.gain;
    const untouched = games.untouched.cost.gain;
    assert.ok(Math.abs(started - (0.5 / 21) * 100) < 0.001, `started should be (1-rate)/N, got ${started}`);
    assert.ok(Math.abs(untouched - (0.5 / 22) * 100) < 0.001, `untouched should be (1-avg)/(N+1), got ${untouched}`);
    assert.ok(untouched < started, 'the untouched game is worth less, because finishing it also grows the divisor');
  });

  test('remaining hours are apportioned by rarity when it is known', async () => {
    const games = await dashboard((db) => {
      insertGame(db, { appid: '1', name: 'Weighted' });
      updateGameStats(db, '1', { achieved: 2, total: 3 });
      replaceAchievements(db, '1', [ach('A'), ach('B'), ach('C')]);
      setAchievementUnlocks(db, '1', ['A', 'B']);
      // The one left is rare, so it is most of the work despite being one achievement of three
      setAchievementRarity(db, '1', new Map([['A', 80], ['B', 70], ['C', 0.5]]));
      upsertHltb(db, '1', { hltbId: 1, verified: true, comp100Med: 36000 }); // 10h
    });
    const flat = (1 - 2 / 3) * 10;
    assert.ok(games['1'].cost.remaining > flat * 2,
      `a 0.5% achievement is far more than a third of a 10h game, got ${games['1'].cost.remaining}h against a flat ${flat.toFixed(1)}h`);
  });

  test('with no rarity on record it falls back to the flat share rather than to nothing', async () => {
    const games = await dashboard((db) => {
      insertGame(db, { appid: '1', name: 'Bare' });
      updateGameStats(db, '1', { achieved: 5, total: 10 });
      upsertHltb(db, '1', { hltbId: 1, verified: true, comp100Med: 36000 });
    });
    assert.equal(games['1'].cost.remaining, 5, 'half of ten hours — no weighting available, so no correction');
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

describe('a third party being down is not this program failing', () => {
  /** A client whose every request throws, the way a timeout or a dead DNS arrives */
  const deadNetwork = () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); };
    return () => { globalThis.fetch = original; };
  };

  test('a network error never escapes the client', async () => {
    // It used to. Every `fetch` was unguarded, so a timeout travelled out of resolve, out of
    // syncHltb and out of fullSync — and the Dashboard reported 「同步失败」 for a run whose Steam
    // data had already landed. The same rule the Notion tick pass follows
    const restore = deadNetwork();
    try {
      const c = new HltbClient({ hltbRequestDelayMs: 0 });
      assert.deepEqual(await c.search('anything'), [], 'a search answers empty rather than throwing');
      assert.equal(await c.detail(1), null);
      const out = await c.resolve({ appid: '1', nameEn: 'Game' });
      assert.equal(out.verified, false);
    } finally { restore(); }
  });

  test('three consecutive unreachable answers stop the phase for the run', async () => {
    // Counted across games, not within one. A single resolve against a dead network makes one
    // request — the handshake — and gives up, so the breaker is reached on the third game rather
    // than the first. That is the intent: one unlucky title must not stop the phase
    const restore = deadNetwork();
    try {
      const c = new HltbClient({ hltbRequestDelayMs: 0 });
      for (const n of ['Game One', 'Game Two', 'Game Three']) {
        await c.resolve({ appid: '1', nameEn: n });
      }
      assert.ok(c.stopped, `the breaker did not trip after ${c.failures} failures`);
      assert.match(c.stopped, /fetch failed|网络错误|请求超时/);
    } finally { restore(); }
  });

  test('a game HowLongToBeat has never heard of does not count towards the breaker', async () => {
    // The distinction the breaker rests on: "the service is not answering" against "the service
    // answered, and the answer is no". A run of obscure Chinese titles must not look like an outage
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => (String(url).includes('/init')
      ? new Response(JSON.stringify({ token: 't', hpKey: 'k', hpVal: 'v' }), { status: 200 })
      : new Response('{"data":[]}', { status: 200 }));
    try {
      const c = new HltbClient({ hltbRequestDelayMs: 0 });
      for (const n of ['One', 'Two', 'Three', 'Four', 'Five']) await c.resolve({ appid: '1', nameEn: n });
      assert.equal(c.stopped, null, 'five clean "not found" answers tripped a breaker meant for outages');
      assert.equal(c.failures, 0);
    } finally { globalThis.fetch = original; }
  });

  test('a tripped breaker stops before writing a recorded miss for every remaining game', async () => {
    // **The expensive half.** A recorded miss is permanent — the game is never searched for again —
    // so continuing through an outage would quietly retire the rest of the library
    const db = openDb(':memory:');
    for (const id of ['1', '2', '3', '4', '5']) {
      insertGame(db, { appid: id, name: 'G' + id });
      updateGameStats(db, id, { achieved: 1, total: 4 });
    }
    const client = {
      stopped: null,
      resolve: async function () {
        this.stopped = '请求超时';
        return { verified: false, stopped: this.stopped };
      },
      refresh: async () => null,
    };
    const out = await syncHltb(db, client);
    assert.equal(out.stopped, '请求超时', 'the reason travels out so a surface can name it');
    assert.ok(allHltb(db).length <= 1, `wrote ${allHltb(db).length} rows through an outage`);
  });

  test('a breaker that trips on the last query still stops the next game', async () => {
    // **Two guards, and this is the one the other cannot cover.** `resolve` reports `stopped` only
    // when it gives up *before* a query; tripping during the last query's page fetches leaves it
    // finishing normally and answering a plain "not found". Without the check at the top of the
    // loop the run then walks the rest of the library writing a recorded miss for every game —
    // and a recorded miss is permanent, so those games would never be searched for again.
    //
    // A single mutation cannot show this: deleting either guard leaves the other covering the
    // common case. Hence a test for the shape only the top one sees.
    const db = openDb(':memory:');
    for (const id of ['1', '2', '3', '4', '5']) {
      insertGame(db, { appid: id, name: 'G' + id });
      updateGameStats(db, id, { achieved: 1, total: 4 });
    }
    const client = {
      stopped: null,
      calls: 0,
      // Answers "not found" cleanly, and only then admits it has given up — exactly what the real
      // client does when the third failure lands inside the final query
      resolve: async function () { this.calls++; this.stopped = '请求超时'; return { verified: false }; },
      refresh: async () => null,
    };
    await syncHltb(db, client);
    assert.equal(client.calls, 1, `kept going through an outage — ${client.calls} games attempted`);
    assert.equal(allHltb(db).length, 1, 'and wrote a permanent miss for each one it attempted');
  });

  test('the phase failing does not fail the sync', async () => {
    // A backstop against anything in the phase throwing that the client does not catch itself
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 1, total: 4 });
    const exploding = { get stopped() { return null; }, resolve: async () => { throw new Error('boom'); }, refresh: async () => null };
    const steam = {
      fetchOwnedGamesWithUnvettedFlag: async () => ({ games: [], unvettedAppIds: new Set(), playSnapshot: new Map() }),
      fetchRecentlyPlayedGames: async () => null,
      fetchAppName: async () => '',
      fetchAppNameEn: async () => '',
      // Real stats, not 'no achievement system' — that marks has_achievements = 0 and the game
      // stops being a phase-five target, so the throw under test would never be reached
      fetchAchievementStats: async () => ({ total: 4, achieved: 1, unlocked: ['A'] }),
      fetchGlobalAchievementPercentages: async () => null,
      fetchAchievementSchema: async () => null,
      delay: 0, storeDelay: 0,
    };
    const r = await fullSync(db, steam, { hltb: exploding });
    assert.equal(r.hours.stopped, 'boom', 'the phase reports its own failure');
    assert.ok(r.library && r.stats, 'and the phases that already succeeded still return their results');
  });
});

describe('the pace is set in one place', () => {
  test('every request waits, including the refresh path that used to have no sleep at all', async () => {
    // The defect: `resolve` slept after each request and `refresh` slept never, so a monthly pass
    // over a resolved library fired one request per game back to back. The delay lives in #get now,
    // where no call site can be written without it
    const original = globalThis.fetch;
    const at = [];
    globalThis.fetch = async () => { at.push(Date.now()); return new Response('{"profile_steam":1,"comp_100":3600}', { status: 200 }); };
    try {
      const c = new HltbClient({ hltbRequestDelayMs: 120 });
      await c.refresh(1);
      await c.refresh(2);
      await c.refresh(3);
      assert.equal(at.length, 3);
      for (let i = 1; i < at.length; i++) {
        assert.ok(at[i] - at[i - 1] >= 110, `requests ${i} and ${i + 1} were ${at[i] - at[i - 1]}ms apart, not paced`);
      }
    } finally { globalThis.fetch = original; }
  });
});

describe('the monthly refresh does not herd', () => {
  test('the refresh set is capped and spends its budget on the stalest rows', () => {
    // Everything resolved in the first sync is stamped within minutes, so a month later the whole
    // library falls due on one run — the spike sweepBudget exists to prevent, reproduced here
    const db = openDb(':memory:');
    for (let i = 0; i < 10; i++) {
      const id = String(i);
      insertGame(db, { appid: id, name: 'G' + i });
      updateGameStats(db, id, { achieved: 1, total: 4 });
      upsertHltb(db, id, { hltbId: 100 + i, verified: true, comp100Med: 3600 });
      // Oldest first: row 0 is the stalest
      db.prepare('UPDATE hltb SET checked_at = ? WHERE appid = ?').run(`2000-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, id);
    }
    const { refresh, refreshPending } = selectHltbTargets(db, { refreshBudget: 3 });
    assert.equal(refresh.length, 3, 'the budget is a cap, not a suggestion');
    assert.equal(refreshPending, 7, 'and what it left behind is reported rather than silently dropped');
    assert.deepEqual(refresh.map((r) => r.g.appid), ['0', '1', '2'], 'stalest first');
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
