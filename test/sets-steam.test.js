/**
 * Achievement sets: the two requests the Steam client makes for them
 * ------------------------------------------------
 * Run with: node --test
 *
 * `GetGameAchievements` is public data about a game and needs no key; `GetUserAchievements` is about
 * one account and needs the key and the steamid. Which request carries what is the point of this
 * file: a key sent where none is needed is a credential in a URL for nothing, and the account's
 * request without one is a 401 that reads as "no sets".
 *
 * Both are supplementary and answer `null` on any failure instead of throwing, so one dead response
 * costs a retry next sync and never a sync. Only `fetch` is replaced.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SteamClient } from '../lib/steam.js';

const KEY = 'SECRETKEY0123456789';
const SID = '76561190000000001';

/** Swap fetch for the length of one test; `answer(url, init)` returns the Response */
async function withFetch(answer, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return answer(String(url), init);
  };
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const client = (logs = []) => new SteamClient({ steamApiKey: KEY, steamId: SID, requestDelayMs: 0 }, { log: (m) => logs.push(m) });

const GAME_REPLY = {
  response: {
    achievements: [{ internal_name: 'A', internal_key: 1, groupid: 1 }],
    groups: [
      { groupid: 0, localized_name: '', dlcappid: 0, order: 0, ispublic: true, total_achievements: 40, completion_achievements: 40 },
      { groupid: 1, localized_name: 'The Pale Reach', dlcappid: 2561440, order: 0, ispublic: true, total_achievements: 8, completion_achievements: 8 },
    ],
  },
};
const USER_REPLY = {
  response: {
    achievements: [{ internal_key: 1, unlocked: true, unlock_time: 1700000000 }],
    groups: [
      { groupid: 0, is_achievable: true, completed_achievements: 40, is_completed: true, time_completed: 1700000000 },
      { groupid: 1, is_achievable: true, completed_achievements: 3, is_completed: false },
    ],
  },
};

describe('fetchAchievementSets', () => {
  test('asks IPlayerService for the game, in the language given, and sends no credential', async () => {
    await withFetch(() => json(GAME_REPLY), async (seen) => {
      const out = await client().fetchAchievementSets('1562430', 'schinese');
      assert.equal(seen.length, 1);
      const u = new URL(seen[0].url);
      assert.equal(u.origin + u.pathname, 'https://api.steampowered.com/IPlayerService/GetGameAchievements/v1/');
      assert.equal(u.searchParams.get('appid'), '1562430');
      assert.equal(u.searchParams.get('language'), 'schinese');
      assert.equal(seen[0].url.includes(KEY), false, 'the game\'s sets are public; a key in the address is a secret for nothing');
      assert.equal(seen[0].url.includes(SID), false);
      assert.deepEqual(out.sets.map((s) => [s.id, s.name, s.dlcAppid]), [[0, '', null], [1, 'The Pale Reach', '2561440']]);
      assert.deepEqual([...out.members], [['A', 1]],
        'the same reply files each achievement under its set, so which set it is in costs no request of its own');
    });
  });

  test('carries a timeout, like every other request this client makes', async () => {
    await withFetch(() => json(GAME_REPLY), async (seen) => {
      await client().fetchAchievementSets('1', 'english');
      assert.ok(seen[0].init?.signal instanceof AbortSignal, 'without one the ceiling is undici\'s five minutes per call');
    });
  });

  test('answers null for a failed status, a body that is not JSON, a shape that is not a reply, and a dead network', async () => {
    for (const [label, answer] of [
      ['429', () => json({}, 429)],
      ['500', () => json({}, 500)],
      ['html', () => new Response('<html>busy</html>', { status: 200 })],
      ['no response object', () => json({ nope: true })],
      ['groups not a list', () => json({ response: { groups: 'x' } })],
      ['network', () => { throw new TypeError('fetch failed'); }],
    ]) {
      await withFetch(answer, async () => {
        assert.equal(await client().fetchAchievementSets('1', 'english'), null, label);
      });
    }
  });

  test('a reply of "nothing for this app" is an empty list, which is not a failure', async () => {
    await withFetch(() => json({ response: {} }), async () => {
      assert.deepEqual(await client().fetchAchievementSets('1', 'english'), { sets: [], members: new Map() });
    });
  });
});

describe('fetchAchievementSetProgress', () => {
  test('asks for this account\'s progress with the key and the steamid, and keys the answer by set', async () => {
    await withFetch(() => json(USER_REPLY), async (seen) => {
      const m = await client().fetchAchievementSetProgress('1562430');
      const u = new URL(seen[0].url);
      assert.equal(u.origin + u.pathname, 'https://api.steampowered.com/IPlayerService/GetUserAchievements/v1/');
      assert.equal(u.searchParams.get('key'), KEY);
      assert.equal(u.searchParams.get('steamid'), SID);
      assert.equal(u.searchParams.get('appid'), '1562430');
      assert.deepEqual(m.get(0), { achievable: true, done: 40, completed: true, completedAt: 1700000000 });
      assert.equal(m.get(1).done, 3);
    });
  });

  test('answers null for 403 (no licence any more), 429, a broken body, and a dead network', async () => {
    for (const [label, answer] of [
      ['403', () => json({}, 403)],
      ['429', () => json({}, 429)],
      ['html', () => new Response('<html>no</html>', { status: 200 })],
      ['no groups', () => json({ response: {} })],
      ['network', () => { throw new TypeError('fetch failed'); }],
    ]) {
      await withFetch(answer, async () => {
        assert.equal(await client().fetchAchievementSetProgress('1'), null, label);
      });
    }
  });

  test('carries a timeout as well', async () => {
    await withFetch(() => json(USER_REPLY), async (seen) => {
      await client().fetchAchievementSetProgress('1');
      assert.ok(seen[0].init?.signal instanceof AbortSignal);
    });
  });

  test('an appid that is not digits is never put into an address the key is sent with', async () => {
    await withFetch(() => json(USER_REPLY), async (seen) => {
      const c = client();
      assert.equal(await c.fetchAchievementSetProgress('1&steamid=7'), null);
      assert.equal(await c.fetchAchievementSetProgress('1/../2'), null);
      assert.equal(await c.fetchAchievementSets('1&key=x', 'english'), null);
      assert.equal(seen.length, 0, 'a request went out for an appid that is not one');
    });
  });

  test('nothing it logs, on any failure, contains the key or the steamid', async () => {
    const logs = [];
    for (const answer of [() => json({}, 403), () => { throw new TypeError(`fetch failed ${KEY} ${SID}`); }]) {
      await withFetch(answer, async () => {
        await client(logs).fetchAchievementSetProgress('1');
        await client(logs).fetchAchievementSets('1', 'english');
      });
    }
    for (const line of logs) {
      assert.equal(line.includes(KEY) || line.includes(SID), false, `a log line carried a credential: ${line}`);
    }
  });
});
