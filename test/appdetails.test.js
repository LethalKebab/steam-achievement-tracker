/**
 * Finding one app in an `appdetails` reply
 * ------------------------------------------------
 * Run with: node --test
 *
 * The reply is an object keyed by appid, and the key is normally the appid that was asked for.
 * For some titles it is not: `appids=4225980` is answered under `4975960` (an appid from that
 * game's own DLC list) while `data.steam_appid` inside still says `4225980`. Indexing the reply
 * with the appid asked for then finds nothing, and every consumer reads that as "this app has no
 * store page" — no cover, no name, no header image for its Notion page icon — with no error
 * anywhere.
 *
 * Four things are pinned, because each fails quietly:
 *
 * - **The entry is found when the key differs but `steam_appid` matches**, on every path that
 *   reads a reply: the header address, the name in either language, and the Notion icon built
 *   on top of them.
 * - **Finding it costs no further request.** The store endpoint is the strictly rate-limited
 *   one, so the tests assert the exact requests made. A stub that throws on a stray request is
 *   not enough: the icon chain swallows errors on purpose, and the stray one would vanish there.
 * - **An entry naming some other app is never taken for being the only one present.** The
 *   callers store what they get (a page icon, `games.name_en`), so a neighbour's cover is worse
 *   than none.
 * - **Every request for `appdetails` is read through the one lookup.** A hand-written
 *   `reply[String(appid)]` in a third place would bring the defect back for whatever it serves.
 *   The two source assertions at the end are a tripwire on the literal spelling, not a proof;
 *   the behaviour tests above them are what pin the two readers.
 *
 * The replies for the real cases carry the shape Steam sends — the key a string, `steam_appid` a
 * number — and nothing more, so a lookup that only works on a friendlier object does not pass.
 * The refusal and edge-case replies further down are synthetic, because Steam has not been seen
 * to send them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { SteamClient, fetchGameIcon, appDetailsOf } from '../lib/steam.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Line comments first, then block comments — the other way round, a `/*` inside a `//` eats real code */
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const ASKED = '4225980';
const ANSWERED_UNDER = '4975960';
const NAME = '空之轨迹 the 2nd';
const HEADER =
  'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4225980/7e2f29dcf817ea28698ed1e27f4b86c98ebf1aa3/header_schinese.jpg?t=1790212357';

/** The reply as it comes off the wire: one key, `success`, and `steam_appid` as a number */
const replyUnder = (key, data) => ({ [key]: { success: true, data } });
const ourData = { type: 'game', name: NAME, steam_appid: 4225980, header_image: HEADER };

/** `METHOD url-without-query` for each request that was seen, in order */
const shape = (seen) => seen.map((r) => `${r.method} ${r.url.replace(/\?.*$/, '')}`);
const STORE = 'https://store.steampowered.com/api/appdetails';

/**
 * Serve the store endpoint from `body` and answer the guessed-header HEAD with a 404. Anything
 * else throws, but callers here swallow errors on purpose (`fetchGameIcon` most of all), so the
 * tests read `seen` instead of relying on that throw being noticed
 */
async function withStore(body, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET' });
    if (/store\.steampowered\.com\/api\/appdetails/.test(url)) {
      return { ok: true, status: 200, async json() { return body; } };
    }
    if (init?.method === 'HEAD') return { ok: false, status: 404 };
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

describe('a reply keyed under another appid', () => {
  test('the header address is found through steam_appid, in one store request', async () => {
    await withStore(replyUnder(ANSWERED_UNDER, ourData), async (seen) => {
      const c = new SteamClient({ language: 'schinese' });
      assert.equal(await c.fetchStoreHeaderImage(ASKED), HEADER);
      assert.deepEqual(shape(seen), [`GET ${STORE}`], 'finding the entry must not cost a second store request');
      assert.match(seen[0].url, /appids=4225980&l=schinese$/);
    });
  });

  test('the name is found in the configured language and in English, one store request each', async () => {
    await withStore(replyUnder(ANSWERED_UNDER, ourData), async (seen) => {
      const c = new SteamClient({ language: 'schinese' });
      assert.equal(await c.fetchAppNameFromJson(ASKED), NAME);
      assert.equal(await c.fetchAppNameEn(ASKED), NAME);
      assert.deepEqual(shape(seen), [`GET ${STORE}`, `GET ${STORE}`]);
      assert.deepEqual(seen.map((r) => r.url.match(/l=(\w+)$/)?.[1]), ['schinese', 'english']);
    });
  });

  test('the Notion icon resolves in exactly two requests: the guessed header, then appdetails', async () => {
    await withStore(replyUnder(ANSWERED_UNDER, ourData), async (seen) => {
      const c = new SteamClient({ steamApiKey: 'k', steamId: 's' });
      assert.equal(await fetchGameIcon(c, ASKED), HEADER);
      assert.deepEqual(
        shape(seen),
        ['HEAD https://cdn.cloudflare.steamstatic.com/steam/apps/4225980/header.jpg', `GET ${STORE}`],
        'the owned list is the last resort, and a second store request is the expensive kind of extra'
      );
    });
  });
});

describe('a reply keyed by the appid asked for', () => {
  const plain = replyUnder(ASKED, ourData);

  test('is read exactly as before', async () => {
    await withStore(plain, async (seen) => {
      const c = new SteamClient({ language: 'schinese' });
      assert.equal(await c.fetchStoreHeaderImage(ASKED), HEADER);
      assert.equal(await c.fetchAppNameFromJson(ASKED), NAME);
      assert.deepEqual(shape(seen), [`GET ${STORE}`, `GET ${STORE}`]);
    });
  });

  test('success: false is still "no store page"', async () => {
    await withStore({ [ASKED]: { success: false } }, async () => {
      const c = new SteamClient({ language: 'schinese' });
      assert.equal(await c.fetchStoreHeaderImage(ASKED), null);
      assert.equal(await c.fetchAppNameFromJson(ASKED), null);
    });
  });
});

describe('a reply that answers for a different app', () => {
  const someoneElse = replyUnder('999999', {
    type: 'game', name: 'Somebody Else', steam_appid: 999999, header_image: 'https://example.invalid/other.jpg',
  });

  test('is not taken for being the only entry there', async () => {
    await withStore(someoneElse, async () => {
      const c = new SteamClient({ language: 'schinese' });
      assert.equal(await c.fetchStoreHeaderImage(ASKED), null, 'another game\'s cover on this game\'s page is worse than none');
      assert.equal(await c.fetchAppNameFromJson(ASKED), null);
    });
  });
});

describe('appDetailsOf', () => {
  test('returns the data of the entry under the appid asked for', () => {
    assert.deepEqual(appDetailsOf(replyUnder(ASKED, ourData), ASKED), ourData);
  });

  test('returns the data of the entry that names the appid, whatever its key', () => {
    assert.deepEqual(appDetailsOf(replyUnder(ANSWERED_UNDER, ourData), ASKED), ourData);
  });

  test('the key alone is enough when the entry does not name itself', () => {
    assert.deepEqual(appDetailsOf({ [ASKED]: { success: true, data: { name: 'Bare' } } }, ASKED), { name: 'Bare' });
  });

  test('takes the appid as a number or as a string', () => {
    assert.deepEqual(appDetailsOf(replyUnder(ANSWERED_UNDER, ourData), 4225980), ourData);
    assert.deepEqual(appDetailsOf(replyUnder(ASKED, ourData), 4225980), ourData);
  });

  test('a steam_appid that arrives as a string names the app too', () => {
    const data = { ...ourData, steam_appid: '4225980' };
    assert.deepEqual(appDetailsOf(replyUnder(ANSWERED_UNDER, data), ASKED), data);
  });

  test('refuses an entry under another key that names another app', () => {
    const reply = replyUnder('999999', { steam_appid: 999999, name: 'Somebody Else' });
    assert.equal(appDetailsOf(reply, ASKED), null);
  });

  test('refuses an entry that does not say which app it is, for an appid that was never given', () => {
    // `String(undefined)` is a string like any other, so without a presence check an entry with
    // no `steam_appid` at all would be "named" by a caller passing nothing
    const reply = replyUnder(ANSWERED_UNDER, { name: 'Nameless' });
    assert.equal(appDetailsOf(reply, undefined), null);
  });

  test('success: false is null even when the entry names the appid', () => {
    assert.equal(appDetailsOf({ [ANSWERED_UNDER]: { success: false, data: ourData } }, ASKED), null);
    assert.equal(appDetailsOf({ [ASKED]: { success: false, data: ourData } }, ASKED), null);
  });

  test('an entry that carries no success flag is not taken', () => {
    assert.equal(appDetailsOf({ [ANSWERED_UNDER]: { data: ourData } }, ASKED), null);
    assert.equal(appDetailsOf({ [ASKED]: { data: ourData } }, ASKED), null);
  });

  test('a successful entry with no data is null, not undefined', () => {
    assert.equal(appDetailsOf({ [ASKED]: { success: true } }, ASKED), null);
  });

  test('anything that is not an object of entries gives null and does not throw', () => {
    for (const junk of [null, undefined, [], {}, 'html', 42, true]) {
      assert.equal(appDetailsOf(junk, ASKED), null, `threw or answered for ${JSON.stringify(junk)}`);
    }
  });
});

describe('appdetails replies are read through appDetailsOf (source assertions)', () => {
  const count = (src, re) => (src.match(re) ?? []).length;
  const REQUEST = /store\.steampowered\.com\/api\/appdetails/g;
  const steamSrc = strip(read('../lib/steam.js'));

  test('steam.js never indexes a reply with the appid it asked for', () => {
    assert.doesNotMatch(steamSrc, /\[String\(appid\)\]/, 'that spelling is the defect — read the entry through appDetailsOf');
  });

  test('no file in lib/ names the appdetails request more often than it calls appDetailsOf', () => {
    const files = readdirSync(new URL('../lib/', import.meta.url), { recursive: true })
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => /\.m?js$/.test(f));
    assert.ok(files.includes('steam.js'), 'this check has lost its target rather than passed');
    for (const f of files) {
      const src = strip(read(`../lib/${f}`));
      const requests = count(src, REQUEST);
      const reads = count(src, /appDetailsOf\(/g) - count(src, /function appDetailsOf\(/g);
      assert.ok(requests <= reads, `${f} names the appdetails request ${requests}x but calls appDetailsOf ${reads}x`);
    }
    assert.ok(count(steamSrc, REQUEST) >= 1, 'the request pattern no longer matches, so the loop above would pass without looking at anything');
  });
});
