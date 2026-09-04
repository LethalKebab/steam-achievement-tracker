/**
 * Re-iconing guide pages: the narrowness is the feature
 * ------------------------------------------------
 * `guide-icons` exists because `fetchGameIcon` used to prefer Steam's 32×32 square icon, so the
 * pages this program had already written carry one. Measured on a real library: four of six.
 *
 * Everywhere else in this codebase the rule is **never overwrite an icon** (`fillMissingIcon`
 * fills only an empty slot, and will not touch even an emoji). This is the one place that writes
 * over something, so what it refuses to touch is the whole of its safety, and none of those
 * refusals announces itself: overwriting somebody's chosen emoji fails no request, throws nothing,
 * and is noticed only by opening Notion and finding a decision gone.
 *
 * So each refusal is pinned separately rather than as one "leaves other icons alone" case: they
 * are four different `icon` shapes from the API, and a predicate can regress on one while staying
 * correct on the other three.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertGame, upsertGuide } from '../lib/db.js';
import { isSquareGameIcon, SQUARE_ICON_RE, refreshGuideIcons } from '../lib/guideicons.js';

const SQUARE = 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/730/abc123def456.jpg';
const HEADER = 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg';
const PAGE = 'https://www.notion.so/3af1fee6252b8073883ecea59b4d83d6';

const external = (url) => ({ type: 'external', external: { url } });

/** A db holding one Notion guide, so a sweep has exactly one page to consider */
function dbWithGuide({ appid = '730', kind = 'notion', url = PAGE } = {}) {
  const db = openDb(':memory:');
  insertGame(db, { appid, name: '测试游戏' });
  upsertGuide(db, { appid, name: '测试游戏', url, kind });
  return db;
}

/** Records every write, so "left alone" can be asserted as *no request*, not merely as an unchanged value */
function notionWith(icon) {
  const writes = [];
  return {
    writes,
    async fetchPageIcon() { return icon; },
    async setPageIcon(id, url) { writes.push({ id, url }); },
  };
}

const steamWith = (header) => ({
  async fetchOwnedGames() { return [{ appid: 730, img_icon_url: 'abc123def456' }]; },
  async fetchStoreHeaderImage() { return header; },
});

/** fetchGameIcon HEADs the guessed address; this decides whether that guess is taken to exist */
function withFetch(ok, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 404 });
  return run().finally(() => { globalThis.fetch = real; });
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe('isSquareGameIcon', () => {
  test('recognises the square-icon address this program writes', () => {
    assert.equal(isSquareGameIcon(external(SQUARE)), true);
    assert.equal(isSquareGameIcon(external(SQUARE.replace('cdn.cloudflare', 'shared.akamai'))), true);
  });

  test('an emoji is a decision, not a slot to reclaim', () => {
    assert.equal(isSquareGameIcon({ type: 'emoji', emoji: '🎮' }), false);
  });

  test('a Notion-hosted file means somebody uploaded one — this program only ever sets external', () => {
    assert.equal(isSquareGameIcon({ type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/x/image.png' } }), false);
  });

  test('the type is checked as well as the address — a file icon is a human edit whatever it points at', () => {
    // Not redundant with the address check, and the reason is a direction of travel: this program
    // sets `external` icons only, so `file` means a person put it there. If that ever stops being
    // true — icons uploaded rather than linked, or Notion re-hosting what we link — the address
    // alone would start matching pages nobody wants rewritten. The type is what says "ours"
    assert.equal(isSquareGameIcon({ type: 'file', file: { url: SQUARE } }), false);
  });

  test('another external address is an image somebody found, and is not ours', () => {
    // Measured on a real library: one page carried a 225×225 from Google Images — sharper than
    // what we would put there, and in any case not ours to replace
    assert.equal(isSquareGameIcon(external('https://encrypted-tbn0.gstatic.com/images?q=abc')), false);
    assert.equal(isSquareGameIcon(external(HEADER)), false, 'a header is already the good icon');
  });

  test('no icon at all is fillMissingIcon\'s job, on its own rule', () => {
    assert.equal(isSquareGameIcon(null), false);
    assert.equal(isSquareGameIcon(undefined), false);
    assert.equal(isSquareGameIcon({ type: 'external' }), false, 'an external icon with no url must not throw');
  });

  test('the address is matched whole, so a community link merely containing that path is not a match', () => {
    // A loose `includes('steamcommunity')` would catch a link pasted from a community page. That
    // is the one direction that destroys something, so the pattern is anchored at both ends
    assert.equal(SQUARE_ICON_RE.test(`https://steamcommunity.com/redirect?to=${SQUARE}`), false);
    assert.equal(isSquareGameIcon(external('https://steamcommunity.com/app/730')), false);
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('refreshGuideIcons', () => {
  test('a page on the square icon is given the store header', async () => {
    const db = dbWithGuide();
    const notion = notionWith(external(SQUARE));
    const r = await withFetch(true, () => refreshGuideIcons(db, steamWith(HEADER), { notion }));

    assert.equal(r.replaced, 1);
    assert.equal(notion.writes.length, 1);
    assert.match(notion.writes[0].url, /\/steam\/apps\/730\/header\.jpg$/);
    assert.equal(r.logs[0].result, 'replaced');
  });

  for (const [label, icon] of [
    ['an emoji', { type: 'emoji', emoji: '🎮' }],
    ['an uploaded file', { type: 'file', file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/x/i.png' } }],
    ['another external image', external('https://encrypted-tbn0.gstatic.com/images?q=abc')],
    ['no icon', null],
  ]) {
    test(`${label} is left alone — no write goes out at all`, async () => {
      const db = dbWithGuide();
      const notion = notionWith(icon);
      const r = await withFetch(true, () => refreshGuideIcons(db, steamWith(HEADER), { notion }));

      assert.equal(notion.writes.length, 0, 'the only real damage this command can do is writing here');
      assert.equal(r.replaced, 0);
      assert.equal(r.logs.length, 0, 'a page nobody touched should not be reported as considered');
    });
  }

  test('resolving back to the same square icon is not a replacement', async () => {
    // A game with no store asset falls back to the square icon — that is the fallback's purpose.
    // Writing it again spends a request to store an identical string and reports a page as fixed
    // while it stays exactly as soft
    const db = dbWithGuide();
    const notion = notionWith(external(SQUARE));
    const r = await withFetch(false, () => refreshGuideIcons(db, steamWith(null), { notion }));

    assert.equal(notion.writes.length, 0);
    assert.equal(r.replaced, 0);
    assert.equal(r.logs[0].result, 'no-better-source');
  });

  test('--dry-run counts what would change and writes nothing', async () => {
    const db = dbWithGuide();
    const notion = notionWith(external(SQUARE));
    const r = await withFetch(true, () => refreshGuideIcons(db, steamWith(HEADER), { notion, dryRun: true }));

    assert.equal(r.replaced, 1, 'the rehearsal has to report the same number the real run would');
    assert.equal(notion.writes.length, 0);
    assert.equal(r.logs[0].result, 'would-replace');
  });

  test('one unreadable page does not end the sweep', async () => {
    // A page the integration was never given access to is ordinary, and the remaining hundred are
    // still fixable. Throwing here would make one stale share block the whole library
    const db = openDb(':memory:');
    for (const appid of ['730', '440']) {
      insertGame(db, { appid, name: 'g' + appid });
      upsertGuide(db, { appid, name: 'g' + appid, url: PAGE, kind: 'notion' });
    }
    let n = 0;
    const notion = {
      writes: [],
      async fetchPageIcon() {
        if (++n === 1) throw new Error('404 object_not_found');
        return external(SQUARE);
      },
      async setPageIcon(id, url) { this.writes.push({ id, url }); },
    };
    const r = await withFetch(true, () => refreshGuideIcons(db, steamWith(HEADER), { notion }));

    assert.equal(r.replaced, 1, 'the second page still got fixed');
    assert.deepEqual(r.logs.map((l) => l.result).sort(), ['replaced', 'unreadable']);
  });

  test('a local markdown guide is not a Notion page and is never asked about', async () => {
    const db = dbWithGuide({ kind: 'local', url: 'guides/730.md' });
    let asked = 0;
    const notion = { async fetchPageIcon() { asked++; return null; }, async setPageIcon() {} };
    const r = await withFetch(true, () => refreshGuideIcons(db, steamWith(HEADER), { notion }));

    assert.equal(asked, 0);
    assert.equal(r.pages, 0);
  });

  test('a write that fails is reported, not swallowed into the replaced count', async () => {
    const db = dbWithGuide();
    const notion = {
      async fetchPageIcon() { return external(SQUARE); },
      async setPageIcon() { throw new Error('502'); },
    };
    const r = await withFetch(true, () => refreshGuideIcons(db, steamWith(HEADER), { notion }));

    assert.equal(r.replaced, 0, 'the count has to mean "this page got sharper"');
    assert.equal(r.logs[0].result, 'write-failed');
  });
});
