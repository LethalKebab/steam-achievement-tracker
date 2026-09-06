/**
 * The import end to end: two requests in, rows on disk out
 * ------------------------------------------------
 * Run with: node --test
 *
 * `family-import.test.js` covers the decisions; this covers everything around them — the request
 * shape, the credential, and what actually lands in the table. Only `fetch` is swapped, so the real
 * `fetchFamilyLibrary`, the real planner and the real writes all run.
 *
 * Three things here are load-bearing and none of them is visible from the planner:
 *
 * - **The token goes in the query string and nowhere else.** It is a bearer credential; if it ever
 *   reaches a thrown message it reaches the Dashboard's floater and the server log with it.
 * - **A row is inserted with the localised name and the sent name side by side.** Getting that pair
 *   backwards is invisible until somebody searches in the other language.
 * - **`last_played` is written on the way in.** It is the only column the sync can never fill for a
 *   shared row without two further play sessions, and it is the whole reason the backfill exists.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertGame, getGame, allGames } from '../lib/db.js';
import { runFamilyImport } from '../lib/family.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const GROUP = {
  response: {
    family_groupid: '1234567890',
    family_group: { name: 'Test Family', members: [{ steamid: '111' }, { steamid: '222' }] },
  },
};

/** Records every URL asked for, so the credential and the parameters can be asserted */
function stubFetch(apps, { group = GROUP } = {}) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('GetFamilyGroupForUser') ? group : { response: { apps } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return urls;
}

const fakeSteam = ({ owned = [] } = {}) => ({
  storeDelay: 0,
  async fetchOwnedGames() { return owned; },
  async fetchAppName() { return '东方夜雀食堂'; },
});

const app = (appid, over = {}) => ({
  appid, name: `Game ${appid}`, exclude_reason: 0,
  rt_playtime: 100, rt_last_played: 1_700_000_000, ...over,
});

const config = { steamId: '76561190000000000', language: 'schinese' };

describe('runFamilyImport', () => {
  test('a played shared game lands as a family row carrying both names and its play history', async () => {
    const db = openDb(':memory:');
    stubFetch([app('1584090', { name: 'Touhou Mystia', rt_playtime: 2743, rt_last_played: 1_717_561_285 })]);

    const r = await runFamilyImport({ db, steam: fakeSteam(), config, token: 'tok' });

    const row = getGame(db, '1584090');
    assert.equal(row.family, 1);
    assert.equal(row.name, '东方夜雀食堂', 'the localised title, fetched the way every other insert path fetches it');
    assert.equal(row.name_en, 'Touhou Mystia', 'the name Steam sent, so the sync spends no store call filling it');
    assert.equal(row.playtime_forever, 2743);
    assert.equal(row.last_played, 1_717_561_285);
    assert.deepEqual(r.added.map((a) => a.appid), ['1584090']);
  });

  test('the token travels in the query string and appears nowhere else', async () => {
    const db = openDb(':memory:');
    const urls = stubFetch([]);

    await runFamilyImport({ db, steam: fakeSteam(), config, token: 'secret-token-value' });

    assert.equal(urls.length, 2, 'one request for the group, one for the library');
    for (const u of urls) assert.ok(u.includes('access_token=secret-token-value'), u);
    assert.ok(urls[0].includes('include_family_group_response=1'), 'members come back in the same reply, not a third request');
    assert.ok(urls[1].includes('family_groupid=1234567890'));
  });

  test('an existing row is filled in without its name or flags being rewritten', async () => {
    const db = openDb(':memory:');
    insertGame(db, { appid: '1584090', name: '我改过的名字', nameEn: 'Touhou Mystia', family: 1 });
    stubFetch([app('1584090', { name: 'Touhou Mystia', rt_playtime: 2743, rt_last_played: 1_717_561_285 })]);

    const r = await runFamilyImport({ db, steam: fakeSteam(), config, token: 'tok' });

    const row = getGame(db, '1584090');
    assert.equal(row.name, '我改过的名字', 'a hand-corrected title survives the import');
    assert.equal(row.playtime_forever, 2743);
    assert.equal(row.last_played, 1_717_561_285);
    assert.deepEqual(r.added, [], 'it was already here');
    assert.deepEqual(r.backfilled.map((b) => b.appid), ['1584090']);
  });

  test('an owned game is neither added nor written to', async () => {
    const db = openDb(':memory:');
    stubFetch([app('1086940')]);

    const r = await runFamilyImport({
      db, steam: fakeSteam({ owned: [{ appid: 1086940 }] }), config, token: 'tok',
    });

    assert.equal(allGames(db).length, 0);
    assert.deepEqual(r.added, []);
  });

  test('an account in no family group is told so rather than shown an empty result', async () => {
    const db = openDb(':memory:');
    stubFetch([], { group: { response: { is_not_member_of_any_group: true } } });

    const r = await runFamilyImport({ db, steam: fakeSteam(), config, token: 'tok' });

    assert.ok(r.error, 'zero games imported and "you have no family group" are different answers');
    assert.deepEqual(allGames(db), []);
  });

  test('a rejected token comes back as an error, not a throw', async () => {
    const db = openDb(':memory:');
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });

    const r = await runFamilyImport({ db, steam: fakeSteam(), config, token: 'expired' });

    assert.ok(r.error);
    assert.ok(!r.error.includes('expired'), 'the rejected credential must not be quoted back into a message');
  });

  test('no steamId configured is refused before any request goes out', async () => {
    const db = openDb(':memory:');
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };

    const r = await runFamilyImport({ db, steam: fakeSteam(), config: {}, token: 'tok' });

    assert.ok(r.error);
    assert.equal(called, false);
  });
});
