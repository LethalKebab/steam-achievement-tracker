/**
 * The two rate-limit knobs must not be merged back into one
 * ------------------------------------------------
 * Run with: node --test
 *
 * `requestDelayMs` governs api.steampowered.com and `storeRequestDelayMs` governs
 * store.steampowered.com. They **used to be the same value**, and that is the problem:
 * the Web API is measured to withstand 11 requests/second (400 requests, 0ms apart, 36
 * seconds, zero 429s), while the store endpoint is far stricter and hitting it earns an
 * **IP-level ban** rather than a key-level throttle.
 *
 * So the dangerous edit is not "the wrong number", it is **putting this.delay back on the
 * store path's sleep**: nothing errors, the sync runs, and the store endpoint simply goes
 * from once per 300ms to once per 100ms, with the consequence invisible until something is
 * banned. The source assertions below pin exactly that.
 *
 * Comments have to be stripped first, and **line comments before block comments** (see
 * CLAUDE.md): both identifiers this file asserts on appear in explanatory comments, and
 * without stripping, the assertions would be satisfied by the comments themselves.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SteamClient } from '../lib/steam.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Line comments first, then block comments — the other way round, a `/*` inside a `//` eats real code */
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The span after from and before to. Both anchors have to genuinely exist; a missing one is a loud failure */
function between(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `anchor gone: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `anchor gone: ${to}`);
  return src.slice(a, b);
}

describe('SteamClient — two independent delays', () => {
  test('defaults: 100ms for the Web API, 300ms for the store', () => {
    const c = new SteamClient({ steamApiKey: 'k', steamId: 's' });
    assert.equal(c.delay, 100, 'the Web API is measured to withstand 11/s, and 100ms leaves a 2x margin');
    assert.equal(c.storeDelay, 300, 'the store path has no measurement, so it stays conservative');
  });

  test('the two fields read their own config options and never cross', () => {
    const c = new SteamClient({ requestDelayMs: 42, storeRequestDelayMs: 999 });
    assert.equal(c.delay, 42);
    assert.equal(c.storeDelay, 999);
  });

  test('giving only one still leaves the other at its own default', () => {
    const onlyWeb = new SteamClient({ requestDelayMs: 5 });
    assert.equal(onlyWeb.delay, 5);
    assert.equal(onlyWeb.storeDelay, 300, 'speeding up the Web API must not speed up the store in passing');

    const onlyStore = new SteamClient({ storeRequestDelayMs: 5000 });
    assert.equal(onlyStore.delay, 100);
    assert.equal(onlyStore.storeDelay, 5000);
  });

  test('0 is a legal value and must not be read as "not given" by ??', () => {
    const c = new SteamClient({ requestDelayMs: 0, storeRequestDelayMs: 0 });
    assert.equal(c.delay, 0);
    assert.equal(c.storeDelay, 0);
  });
});

describe('the store path has to use storeDelay (source assertions)', () => {
  test('the delay between the two store calls in fetchAppName is storeDelay', () => {
    const src = strip(read('../lib/steam.js'));
    const body = between(src, 'async fetchAppName(appid) {', 'async fetchStoreHeaderImage(');
    assert.match(body, /sleep\(this\.storeDelay\)/, 'both appdetails and the store page HTML are on store.steampowered.com');
    assert.doesNotMatch(body, /sleep\(this\.delay\)/, 'the Web API delay must not be used on a store call');
  });

  test('every sleep after a fetchAppName in sync.js is storeDelay', () => {
    const src = strip(read('../lib/sync.js'));
    const calls = [...src.matchAll(/steam\.fetchAppName\(/g)];
    assert.ok(calls.length >= 2, `sync.js should hold at least two fetchAppName calls, found ${calls.length}`);
    for (const m of calls) {
      // Look forward from this call for the **next** sleep — no fixed byte window, so it does not drift as the code grows
      const rest = src.slice(m.index);
      const s = rest.match(/await sleep\(([^)]*)\)/);
      assert.ok(s, `no sleep after fetchAppName (at offset ${m.index})`);
      assert.equal(s[1].trim(), 'steam.storeDelay',
        `fetchAppName goes to the store endpoint, so this should be steam.storeDelay, found ${s[1]}`);
    }
  });

  test('the two Web API loops still use the fast one', () => {
    const src = strip(read('../lib/sync.js'));
    // Phase two: achievement counts. GetPlayerAchievements, the endpoint that was measured
    const stats = between(src, 'export async function syncAchievementStats(', 'export async function');
    assert.match(stats, /await sleep\(steam\.delay\)/, 'phase two is the Web API and should use the fast one');
    // Phase three: achievement detail. GetSchemaForGame, likewise the Web API
    const schema = between(src, 'export async function syncAchievementSchema(', 'export async function');
    assert.match(schema, /await sleep\(steam\.delay\)/, 'phase three is the Web API too');
  });

  test('both knobs are genuinely read in steam.js — reading one fewer is a silent merge', () => {
    const src = strip(read('../lib/steam.js'));
    assert.match(src, /cfg\.requestDelayMs/);
    assert.match(src, /cfg\.storeRequestDelayMs/);
  });
});
