/**
 * A game has two names, and search has to match either
 * ------------------------------------------------
 * Run with: node --test
 *
 * `games.name` is deliberately the **localised** title: `fetchAppName` hunts for a Chinese one
 * across two endpoints and only falls back to English when neither yields it. Measured over a
 * 317-game library, 101 rows are stored under a Chinese title that does not contain the English
 * one as a substring — so an English search term is `indexOf === -1` against every one of them.
 *
 * That miss is not merely a blank table. `libHit === false` is the switch that sends the query on
 * to the store, the store matches the English term perfectly well, and the game the user already
 * owns comes back under 「Steam 上的结果」 as though it were not owned. Clicking it is then
 * refused as a duplicate. The two halves of one search box contradict each other.
 *
 * So `name_en` is carried beside `name`, and the tests below pin the three things that make it
 * work and the two ways it silently would not:
 *
 * - **The English name is free for owned rows.** GetOwnedGames ignores `l=` and answers in English
 *   either way, so one response fills the whole owned library with no store call at all. A version
 *   that goes to the store for those is not wrong, it is 295 needless requests against the
 *   endpoint that answers abuse with an IP-level block.
 * - **The rest cost one store call each, once.** A row that answers is never asked again. The
 *   thing that would break that is treating a non-Latin answer as a failure: a game published only
 *   in Japanese answers `l=english` with its Japanese title, and that is the right answer.
 * - **Both search tests have to come through one function.** They used to be two copies of the
 *   same `indexOf`; separately edited, one says the row is in the table and the other says the
 *   library is empty.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Script, createContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, insertGame, getGame, allGames } from '../lib/db.js';
import { syncLibrary } from '../lib/sync.js';
import { createApi } from '../lib/api.js';
import { SteamClient } from '../lib/steam.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
/** Line comments first, then block comments — the other way round, a `/*` inside a `//` eats real code */
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

describe('games.name_en', () => {
  test('an existing database gains the column, and its rows read as "" rather than NULL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nameen-'));
    const path = join(dir, 'old.db');
    try {
      // A database from before the column existed. Only the shape matters here, so the table is
      // the minimum `insertGame` needs rather than a copy of the whole schema
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE games (
        appid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
        sync_locked INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0, family INTEGER NOT NULL DEFAULT 0, updated_at TEXT
      )`);
      old.exec(`INSERT INTO games (appid, name) VALUES ('2358720', '黑神话:悟空')`);
      old.close();

      const db = openDb(path);
      const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
      assert.ok(cols.includes('name_en'), 'the migration did not add the column');
      // '' and NULL would be two spellings of the same fact, and every reader would have to
      // handle both. ALTER TABLE ADD COLUMN can carry a default, so a migrated row is
      // indistinguishable from a freshly inserted one
      assert.equal(getGame(db, '2358720').name_en, '', 'a migrated row should read the same as a new one');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('insertGame stores it verbatim — original case, no folding', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '2358720', name: '黑神话:悟空', nameEn: 'Black Myth: Wukong' });
    // Folding here would make the column display-useless, and folding is a comparison-time
    // concern anyway — nameMatches lowercases both sides itself
    assert.equal(getGame(db, '2358720').name_en, 'Black Myth: Wukong');
  });

  test('omitting it is "" and never a copy of name', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '294100', name: 'RimWorld' });
    // `name_en === name` is a real state (the English title happens to be what is displayed) and
    // `name_en === ''` is a different one (nothing on record). Filling the second with the first
    // destroys the distinction, and a later display layer cannot tell whether a second name exists
    assert.equal(getGame(db, '294100').name_en, '');
  });
});

// ---------------------------------------------------------------------------
// Where it gets filled: phase one
// ---------------------------------------------------------------------------

/** A Steam stub for syncLibrary. storeDelay is 0 so the pacing does not slow the suite down */
function fakeSteam({ owned = [], vetted = null, appNames = {}, enNames = {}, recent = [] } = {}) {
  const calls = { fetchAppName: [], fetchAppNameEn: [] };
  return {
    calls,
    storeDelay: 0,
    delay: 0,
    async fetchOwnedGamesWithUnvettedFlag() {
      const ids = new Set((vetted ?? owned.map((g) => g.appid)).map(String));
      return {
        games: owned,
        unvettedAppIds: new Set(owned.map((g) => String(g.appid)).filter((a) => !ids.has(a))),
        playSnapshot: new Map(owned.map((g) => [String(g.appid), 0])),
      };
    },
    async fetchRecentlyPlayedGames() {
      return recent;
    },
    async fetchAppName(appid) {
      calls.fetchAppName.push(String(appid));
      return appNames[String(appid)] ?? null;
    },
    async fetchAppNameEn(appid) {
      calls.fetchAppNameEn.push(String(appid));
      return enNames[String(appid)] ?? null;
    },
  };
}

describe('syncLibrary fills name_en', () => {
  test('a newly inserted owned row keeps the Chinese title to display and the English one to search', async () => {
    const db = openDb(':memory:');
    const steam = fakeSteam({
      owned: [{ appid: 2358720, name: 'Black Myth: Wukong' }],
      appNames: { 2358720: '黑神话:悟空' },
    });

    await syncLibrary(db, steam);

    const row = getGame(db, '2358720');
    assert.equal(row.name, '黑神话:悟空', 'the displayed name is still the localised one');
    assert.equal(row.name_en, 'Black Myth: Wukong', 'the name on the left of the `||` used to be thrown away');
    assert.deepEqual(steam.calls.fetchAppNameEn, [], 'the owned list already carried it; asking the store as well is a needless request');
  });

  test('rows already in the table are backfilled from the owned list with no store call at all', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1366540', name: '戴森球计划' });
    insertGame(db, { appid: '1771300', name: '天国:拯救2' });
    const steam = fakeSteam({
      owned: [
        { appid: 1366540, name: 'Dyson Sphere Program' },
        { appid: 1771300, name: 'Kingdom Come: Deliverance II' },
      ],
    });

    const r = await syncLibrary(db, steam);

    assert.equal(getGame(db, '1366540').name_en, 'Dyson Sphere Program');
    assert.equal(getGame(db, '1771300').name_en, 'Kingdom Come: Deliverance II');
    assert.equal(r.namedEn, 2);
    // This is the whole point of taking it from GetOwnedGames: a 300-game library backfills in
    // the response it was already receiving, not in 300 store calls
    assert.deepEqual(steam.calls.fetchAppName, []);
    assert.deepEqual(steam.calls.fetchAppNameEn, []);
  });

  test('a second run over unchanged rows writes nothing', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1366540', name: '戴森球计划' });
    const steam = fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }] });

    await syncLibrary(db, steam);
    const second = await syncLibrary(db, steam);
    assert.equal(second.namedEn, 0, 'the column is already in step; rewriting it every sync moves updated_at for nothing');
  });

  test('a rename on Steam comes through, and never touches the displayed name', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1771300', name: '天国:拯救2', nameEn: 'Kingdom Come: Deliverance' });
    const steam = fakeSteam({ owned: [{ appid: 1771300, name: 'Kingdom Come: Deliverance II' }] });

    await syncLibrary(db, steam);

    assert.equal(getGame(db, '1771300').name_en, 'Kingdom Come: Deliverance II');
    assert.equal(getGame(db, '1771300').name, '天国:拯救2', 'name is chosen by fetchAppName and is not this column’s business');
  });
});

describe('syncLibrary and the rows the owned list never mentions', () => {
  test('family-shared / delisted / hand-added rows get one appdetails call each', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '2185060', name: '双点博物馆' });   // not owned
    insertGame(db, { appid: '736190', name: '中国式家长' });     // not owned
    const steam = fakeSteam({
      owned: [],
      enNames: { 2185060: 'Two Point Museum', 736190: 'Chinese Parents' },
    });

    const r = await syncLibrary(db, steam);

    assert.equal(getGame(db, '2185060').name_en, 'Two Point Museum');
    assert.equal(getGame(db, '736190').name_en, 'Chinese Parents');
    assert.equal(r.namedEn, 2);
    assert.deepEqual(steam.calls.fetchAppNameEn.sort(), ['2185060', '736190']);
  });

  test('a row that answered is not asked again', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '2185060', name: '双点博物馆' });
    const steam = fakeSteam({ owned: [], enNames: { 2185060: 'Two Point Museum' } });

    await syncLibrary(db, steam);
    await syncLibrary(db, steam);
    // Unbounded, this pass would put one store call per unowned row on every single sync
    assert.deepEqual(steam.calls.fetchAppNameEn, ['2185060'], 'the pass has to extinguish itself');
  });

  test('an English-locale answer that is not English is still an answer', async () => {
    const db = openDb(':memory:');
    // The one row in a 317-game library with no English title: l=english returns the same
    // Japanese string. Rejecting it as "not really English" would re-ask it on every sync forever
    insertGame(db, { appid: '4327530', name: 'ギルド探求団へようこそ！' });
    const steam = fakeSteam({ owned: [], enNames: { 4327530: 'ギルド探求団へようこそ！' } });

    await syncLibrary(db, steam);
    await syncLibrary(db, steam);

    assert.equal(getGame(db, '4327530').name_en, 'ギルド探求団へようこそ！');
    assert.deepEqual(steam.calls.fetchAppNameEn, ['4327530']);
  });

  test('nothing back is left empty and asked again — a rate limit is not a fact about the game', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '999999', name: '下架了的' });
    const steam = fakeSteam({ owned: [], enNames: {} });   // fetchAppNameEn resolves null

    await syncLibrary(db, steam);
    assert.equal(getGame(db, '999999').name_en, '', 'a miss must not be papered over with a copy of name');
    await syncLibrary(db, steam);
    assert.deepEqual(steam.calls.fetchAppNameEn, ['999999', '999999'], 'caching a "no" pins a temporary state as a permanent one');
  });

  test('owned rows are not dragged into that pass', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1366540', name: '戴森球计划' });
    const steam = fakeSteam({ owned: [{ appid: 1366540, name: 'Dyson Sphere Program' }] });

    await syncLibrary(db, steam);
    assert.deepEqual(steam.calls.fetchAppNameEn, [], 'this row was already filled for free one loop earlier');
  });
});

// ---------------------------------------------------------------------------
// The other way a row is created
// ---------------------------------------------------------------------------

describe('addGame', () => {
  /** Supplies only what addGame touches and nulls the rest, so the test cannot drift into depending on something else */
  function envWith(steam) {
    const db = openDb(':memory:');
    const api = createApi({
      db, steam, config: {}, syncState: { snapshot: () => ({}) },
      startBackgroundSync: null, guideGenState: null, startGuideGen: null,
      planGuidePreflight: null, maybeAutoSync: null,
    });
    return { db, api };
  }

  const steamFor = (calls) => ({
    storeDelay: 0,
    async fetchAppName() { calls.push('cn'); return '双点博物馆'; },
    async fetchAppNameEn() { calls.push('en'); return 'Two Point Museum'; },
    async fetchAchievementStats() { return { retry: true }; },
  });

  test('a game added by hand is searchable by its English name straight away', async () => {
    const calls = [];
    const { db, api } = envWith(steamFor(calls));

    const r = await api.addGame('2185060', '双点博物馆');

    assert.equal(getGame(db, '2185060').name_en, 'Two Point Museum');
    // The frontend pushes this object straight into allGames and re-renders, so a missing nameEn
    // here means the game just added cannot be found by English until the page is reloaded
    assert.equal(r.nameAlt, 'Two Point Museum');
    assert.equal(r.name, '双点博物馆');
  });

  test('the name coming from the store search does not answer the English question', async () => {
    const calls = [];
    const { api } = envWith(steamFor(calls));
    // searchStore asks with l=<configured language>, so what the user clicked is the localised
    // title. Skipping the English lookup because "a name was supplied" leaves the column empty
    await api.addGame('2185060', '双点博物馆');
    assert.deepEqual(calls, ['en'], 'the supplied name spares the Chinese hunt, not the English lookup');
  });

  test('with no name supplied both lookups run', async () => {
    const calls = [];
    const { api } = envWith(steamFor(calls));
    await api.addGame('2185060');
    assert.deepEqual(calls, ['cn', 'en']);
  });

  test('the English lookup failing still adds the game', async () => {
    const { db, api } = envWith({
      storeDelay: 0,
      async fetchAppName() { return '双点博物馆'; },
      async fetchAppNameEn() { return null; },
      async fetchAchievementStats() { return { retry: true }; },
    });

    const r = await api.addGame('2185060');
    assert.ok(!r.error, 'a name is supplementary; not getting one must not fail the add');
    assert.equal(getGame(db, '2185060').name_en, '');
  });

  test('it goes out with getDashboardData', async () => {
    const calls = [];
    const { api } = envWith(steamFor(calls));
    await api.addGame('2185060', '双点博物馆');
    const g = api.getDashboardData().games.find((x) => x.appid === '2185060');
    assert.equal(g.nameAlt, 'Two Point Museum');
  });

  test('a row with nothing on record reports "" rather than undefined', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '294100', name: 'RimWorld' });
    const api = createApi({
      db, steam: {}, config: {}, syncState: { snapshot: () => ({}) },
      startBackgroundSync: null, guideGenState: null, startGuideGen: null,
      planGuidePreflight: null, maybeAutoSync: null,
    });
    // nameMatches does `(g.nameAlt || '')`, so undefined would not throw — it would silently
    // never match, which is the failure being fixed, wearing a different hat
    assert.equal(api.getDashboardData().games.find((x) => x.appid === '294100').nameAlt, '');
  });
});

// ---------------------------------------------------------------------------
// The store call itself
// ---------------------------------------------------------------------------

describe('fetchAppNameEn', () => {
  const withFetch = async (fn) => {
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return { ok: true, async json() { return { 2185060: { success: true, data: { name: 'Two Point Museum' } } }; } };
    };
    try { await fn(seen); } finally { globalThis.fetch = real; }
  };

  test('asks appdetails in English', async () => {
    await withFetch(async (seen) => {
      const c = new SteamClient({ language: 'schinese' });
      assert.equal(await c.fetchAppNameEn('2185060'), 'Two Point Museum');
      assert.match(seen[0], /l=english/);
    });
  });

  test('fetchAppName still asks in the configured language — it is filling the other column', async () => {
    await withFetch(async (seen) => {
      const c = new SteamClient({ language: 'schinese' });
      await c.fetchAppNameFromJson('2185060');
      assert.match(seen[0], /l=schinese/, 'the Chinese hunt is what chooses the displayed name and must not drift to English');
    });
  });
});

// ---------------------------------------------------------------------------
// The two search tests in the Dashboard
// ---------------------------------------------------------------------------

/** Lift one top-level function out of Dashboard.html and run it for real. No DOM is involved in this one */
function liftFunction(name) {
  const src = read('Dashboard.html');
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is gone from Dashboard.html`);
  let depth = 0;
  let i = src.indexOf('{', at);
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  assert.ok(depth === 0, `could not find the end of ${name}`);
  const body = src.slice(at, i + 1);
  const ctx = createContext({});
  new Script(`${body}; this.fn = ${name};`).runInContext(ctx);
  return ctx.fn;
}

describe('nameMatches', () => {
  const nameMatches = liftFunction('nameMatches');
  const wukong = { name: '黑神话:悟空', nameAlt: 'Black Myth: Wukong' };

  test('the reported bug: an English term finds a game stored under its Chinese title', () => {
    assert.equal(nameMatches(wukong, 'Black Myth'), true);
  });

  test('the Chinese name still finds it', () => {
    assert.equal(nameMatches(wukong, '悟空'), true);
  });

  test('case does not matter on either side', () => {
    assert.equal(nameMatches(wukong, 'BLACK myth'), true);
    assert.equal(nameMatches({ name: 'RimWorld', nameAlt: '' }, 'rimworld'), true);
  });

  test('a game with nothing on record still matches by the name it has', () => {
    assert.equal(nameMatches({ name: 'RimWorld', nameAlt: '' }, 'rim'), true);
    assert.equal(nameMatches({ name: 'RimWorld' }, 'rim'), true, 'a row from before the column existed must not throw');
  });

  test('something in neither name is still a miss', () => {
    assert.equal(nameMatches(wukong, 'silksong'), false);
  });

  test('no term matches everything — the search box being empty is not a filter', () => {
    assert.equal(nameMatches(wukong, ''), true);
  });
});

describe('the two search tests must not drift apart', () => {
  const src = strip(read('Dashboard.html'));

  test('both come through nameMatches', () => {
    // hidingFilter decides what the table draws; libHit decides whether to go to Steam at all.
    // Two copies of the same indexOf is what they were, and it is what produced a row plainly in
    // the table while the code reported the library as empty
    const uses = [...src.matchAll(/nameMatches\(/g)];
    assert.ok(uses.length >= 3, `expected the definition plus both call sites, found ${uses.length}`);
    assert.match(src, /return nameMatches\(g, f\.search\)/, 'hidingFilter no longer uses the shared test');
    assert.match(src, /libHit = allGames\.some\([\s\S]{0,80}?nameMatches\(g, query\)/, 'libHit no longer uses the shared test');
  });

  test('neither has grown its own name comparison back', () => {
    // The specific shape being guarded: a bare substring test against `name` alone, which is
    // exactly what both sites held and what an English term cannot match
    const own = [...src.matchAll(/g\.name\.toLowerCase\(\)\.indexOf\(/g)];
    assert.equal(own.length, 1, 'the only place allowed to compare a game name is inside nameMatches');
  });

  test('nameEn reaches the frontend at all', () => {
    // The two above pass perfectly well with the column never leaving the backend, and then
    // every nameEn is undefined and the search behaves exactly as it did before the fix
    assert.match(strip(read('lib/api.js')), /nameAlt: alt/);
  });
});
