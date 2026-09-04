/**
 * Cover addresses: guess first, ask when the guess misses, and record what comes back
 * ------------------------------------------------
 * Background (measured 2026-08-16 over 314 games in the library): the Dashboard has always
 * assembled `cdn.akamai.steamstatic.com/steam/apps/<appid>/header.jpg` — which works for
 * 305 and cannot be made to work for 9, with all four alternative domain spellings 404ing.
 * The real cause is that Steam moved store assets to a content-hash path
 * (`store_item_assets/steam/apps/<appid>/<40-char hash>/header.jpg`), and that hash cannot
 * be guessed, with every asset carrying its own. The failures are uniformly appids from
 * the last two years, so **this number only grows**.
 *
 * So instead of trying to guess more accurately, it asks appdetails for the authoritative
 * address and records the result.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openDb, insertGame, getGame } from '../lib/db.js';
import { createApi } from '../lib/api.js';
import { fetchGameIcon } from '../lib/steam.js';

const REAL = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2149010/8f1da1/header.jpg';

/** Supplies only what resolveCover needs and nulls everything else — so the test cannot quietly come to depend on something else */
function envWith(steam) {
  const db = openDb(':memory:');
  insertGame(db, { appid: '2149010', name: '小小梦魇 强化版' });
  const api = createApi({
    db, steam, config: {}, syncState: { snapshot: () => ({}) },
    startBackgroundSync: null, guideGenState: null, startGuideGen: null,
    planGuidePreflight: null, maybeAutoSync: null,
  });
  return { db, api };
}

describe('resolveCover', () => {
  test('a real address obtained is returned and written to the database', async () => {
    let asked = 0;
    const { db, api } = envWith({
      async fetchStoreHeaderImage() { asked++; return REAL; },
    });

    assert.deepEqual(await api.resolveCover('2149010'), { url: REAL });
    assert.equal(asked, 1);
    assert.equal(getGame(db, '2149010').cover_url, REAL, 'without writing it to the database the next page load asks all over again');
  });

  test('once recorded it stops asking Steam — the store endpoint is heavily rate-limited and one ask is enough', async () => {
    let asked = 0;
    const { api } = envWith({
      async fetchStoreHeaderImage() { asked++; return REAL; },
    });

    await api.resolveCover('2149010');
    await api.resolveCover('2149010');
    await api.resolveCover('2149010');
    assert.equal(asked, 1, 'the cache is not working, so every page load hits the store endpoint');
  });

  test('a failure **is not written to the database** — writing an empty value means never retrying', async () => {
    let asked = 0;
    const { db, api } = envWith({
      async fetchStoreHeaderImage() { asked++; return null; },
    });

    assert.deepEqual(await api.resolveCover('2149010'), { url: null });
    assert.equal(getGame(db, '2149010').cover_url, null);
    // The reason for a failure is usually a rate limit, or a store page not built yet — both
    // of which change.
    // Caching a "no" pins a temporary state as a permanent fact
    await api.resolveCover('2149010');
    assert.equal(asked, 2, 'it should try again after a failure');
  });

  test('Steam throwing is still only a failure to obtain one and must not turn this request into a 500', async () => {
    const { api } = envWith({
      async fetchStoreHeaderImage() { throw new Error('ECONNRESET'); },
    });
    assert.deepEqual(await api.resolveCover('2149010'), { url: null });
  });

  test('an appid not in the library reports honestly and does not hit Steam', async () => {
    let asked = 0;
    const { api } = envWith({
      async fetchStoreHeaderImage() { asked++; return REAL; },
    });
    const r = await api.resolveCover('999999999');
    assert.ok(r.error, 'it should report an error');
    assert.equal(asked, 0, 'there is no reason to ask Steam about something not in the library');
  });

  test('a recorded cover goes out with getDashboardData', async () => {
    const { api } = envWith({ async fetchStoreHeaderImage() { return REAL; } });
    await api.resolveCover('2149010');
    const g = api.getDashboardData().games.find((x) => x.appid === '2149010');
    // The frontend uses the real address **directly** from this, with no need to replay "load, fail, then ask"
    assert.equal(g.coverUrl, REAL);
  });
});

// ---------------------------------------------------------------------------
// The Notion icon is another outlet for the same fault
// ---------------------------------------------------------------------------
// fetchGameIcon's fallback likewise assembles that old path, and returns null when a HEAD
// gets nothing. It has been "working honestly" all along; only its conclusion was wrong —
// the truth is not "this game has no icon" but "the image is not where we guessed".
// So those 9 games' Notion pages likewise have no icon, and likewise silently.

describe('fetchGameIcon asks when the guess misses', () => {
  const steamWith = (headerImage) => ({
    async fetchOwnedGames() { return []; },       // not in owned — so the square-icon route is unavailable
    async fetchStoreHeaderImage() { return headerImage; },
  });

  test('a 404 on the guessed address falls back to appdetails rather than being treated as no icon', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      assert.equal(await fetchGameIcon(steamWith(REAL), '2149010'), REAL);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a correct guess asks nothing further — 97% of games take this route', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    let asked = 0;
    const steam = {
      async fetchOwnedGames() { return []; },
      async fetchStoreHeaderImage() { asked++; return REAL; },
    };
    try {
      const url = await fetchGameIcon(steam, '2149010');
      assert.match(url, /cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/2149010\/header\.jpg$/);
      assert.equal(asked, 0, 'asking after a correct guess adds a store-endpoint call to every game for nothing');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('with neither route working it is still null — a page with no icon is still a good page', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      assert.equal(await fetchGameIcon(steamWith(null), '2149010'), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Which source wins, and why it is not the free one
// ---------------------------------------------------------------------------
/**
 * `GetOwnedGames` carries an `img_icon_url` hash, and using it costs no extra request — which is
 * exactly why it was the first choice. The asset behind it is **32×32**, and Notion draws a page
 * icon several times larger, so nearly every generated page carried a visibly soft icon. Measured
 * on pages already written: four in six were the 32×32; the sharp ones were the games that missed
 * the owned list and fell through to the 460×215 store header.
 *
 * **The failure is silent and looks like a Notion problem**, which is what makes the ordering
 * worth pinning: no request fails, no branch errors, the icon is simply the wrong one. Swapping
 * these three lines back turns nothing else in the suite red.
 */
describe('fetchGameIcon prefers resolution over the free request', () => {
  const SQUARE = /steamcommunity\/public\/images\/apps\/2149010\//;
  const owned = [{ appid: 2149010, img_icon_url: 'abc123' }];

  test('an owned game takes the store header, not the 32×32 square icon it could have for free', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    try {
      const url = await fetchGameIcon({
        async fetchOwnedGames() { return owned; },
        async fetchStoreHeaderImage() { return REAL; },
      }, '2149010');
      assert.doesNotMatch(url, SQUARE, 'the square icon is 32×32 and too small for Notion\'s icon slot');
      assert.match(url, /\/steam\/apps\/2149010\/header\.jpg$/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the content-hash header also outranks it — the appdetails answer is still a header', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      const url = await fetchGameIcon({
        async fetchOwnedGames() { return owned; },
        async fetchStoreHeaderImage() { return REAL; },
      }, '2149010');
      assert.equal(url, REAL);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the square icon is still the last resort — a soft icon beats no icon', async () => {
    // Demoting it must not mean deleting it. This is the family-shared / delisted case inverted:
    // there the square icon is missing, here the store asset is
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      const url = await fetchGameIcon({
        async fetchOwnedGames() { return owned; },
        async fetchStoreHeaderImage() { return null; },
      }, '2149010');
      assert.match(url, SQUARE, 'with no store asset at all, 32×32 is the only thing left');
      assert.match(url, /abc123\.jpg$/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a steam client without fetchStoreHeaderImage degrades instead of throwing', async () => {
    // `steam.fetchStoreHeaderImage(appid).catch(...)` throws **synchronously** when the method is
    // absent — there is no promise yet for `.catch` to attach to, so the whole resolution rejects
    // rather than falling through. The caller supplies this object, and a client missing a method
    // must cost an icon, never the call
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      const url = await fetchGameIcon({ async fetchOwnedGames() { return owned; } }, '2149010');
      assert.match(url, SQUARE, 'it should have gone on to the last resort');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a resolved header asks the owned list nothing — the common path got no slower', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    let askedOwned = 0;
    try {
      await fetchGameIcon({
        async fetchOwnedGames() { askedOwned++; return owned; },
        async fetchStoreHeaderImage() { return REAL; },
      }, '2149010');
      assert.equal(askedOwned, 0, 'the owned list is only needed for the fallback, so it is only fetched there');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('a new column has to be declared in both places', () => {
  /**
   * `SCHEMA` is `CREATE TABLE IF NOT EXISTS`, so it does nothing at all to a table that already
   * exists, and `ADDED_COLUMNS` is what carries a new column to installed databases. Both are
   * needed, and db.js says so in its own comment.
   *
   * A column present only in `ADDED_COLUMNS` still works — `migrate` runs on a fresh database
   * too — which is exactly why this drifts: nothing fails, and the next column added by copying
   * the example inherits the omission. `cover_url` was that column.
   */
  test('every ADDED_COLUMNS entry also appears in the games CREATE TABLE', () => {
    const src = readFileSync(new URL('../lib/db.js', import.meta.url), 'utf8');
    const table = src.match(/CREATE TABLE IF NOT EXISTS games \(([\s\S]*?)\n\);/);
    assert.ok(table, 'cannot find the games CREATE TABLE — this check has lost its target rather than passed');
    const declared = new Set(
      table[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((w) => /^[a-z_]+$/.test(w))
    );
    const block = src.match(/const ADDED_COLUMNS = \[([\s\S]*?)\n\];/);
    assert.ok(block, 'cannot find ADDED_COLUMNS — this check has lost its target rather than passed');
    const added = [...block[1].matchAll(/\[\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(added.length >= 5, `only ${added.length} added columns parsed — the shape changed and this check is no longer reading it`);
    const missing = added.filter((c) => !declared.has(c));
    assert.deepEqual(missing, [],
      `${missing.join(', ')} reach an installed database through the migration but are absent from the CREATE TABLE, contradicting the rule stated above ADDED_COLUMNS`);
  });

  test('cover_url is readable on a fresh database', () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1', name: 'x' });
    assert.equal('cover_url' in getGame(db, '1'), true);
  });
});
