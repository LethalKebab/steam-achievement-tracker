/**
 * Auto-creating the guide database (`init --notion --create` / the setup page's 「新建一个攻略数据库」)
 * ------------------------------------------------
 * This file guards **a class of failure that surfaces very late**: the creation step reports
 * success, but what it created is not the kind of database the program can use. The user only
 * runs into 「「Status」属性里没有「In progress」这个选项」 at the first `guide-gen` — by which
 * point they no longer believe the problem has anything to do with the original setup.
 * Removing that wall is the entire reason auto-creation exists, so it must never push the wall
 * further back itself.
 *
 * Three rules:
 *
 * 1. **`GUIDE_STATUS_OPTIONS` has to cover every value the program will write.** Pure drift
 *    detection: change `newGuideStatus` or those two constants in guides.js without updating
 *    the option table and this goes red. One missing means the corresponding path is stopped
 *    by `planNotionTarget` at the moment it really wants to write.
 * 2. **The creation has to be verified by reading back; an HTTP 200 is not evidence.** Measured:
 *    Notion silently ignores a status property's `groups` — passed at creation or PATCHed
 *    afterwards, all three payload shapes come back 200 with nothing changed. So on this path
 *    "the call succeeded" simply does not constitute evidence that "the content is correct".
 * 3. **`searchPages` has to filter out database rows.** On the real workspace, 99 of the 100
 *    results `/search` returns are the guide database's own rows (`parent.type === 'database_id'`);
 *    without the filter, the parent-page picker is drowned in the user's own guides and the one
 *    usable page sits in position 100.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NotionClient,
  newGuideStatus,
  GUIDE_STATUS_OPTIONS,
  inspectGuideDb,
  repairGuideDb,
  probeGuideDbWrite,
  DB_PROBLEM,
} from '../lib/notion.js';
import { GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED } from '../lib/guides.js';
import { createApi } from '../lib/api.js';

// ---------------------------------------------------------------------------
// Scaffolding: swap out request, never touch the network
// ---------------------------------------------------------------------------

const statusProps = (options) => ({
  Name: { type: 'title', title: {} },
  Status: { type: 'status', status: { options: options.map((name) => ({ name })) } },
});

/** Fake client for creation. `sent` collects the payloads actually sent, so the assertion can be "the request really carried those four" */
function stubCreate({ readBackProps }) {
  const c = new NotionClient({ notion: { token: 't' } });
  c.sent = [];
  c.request = async (method, path, payload) => {
    if (method === 'post' && path === '/databases') {
      c.sent.push(payload);
      return { id: 'AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'https://notion.so/x' };
    }
    if (method === 'get' && path.startsWith('/databases/')) return { properties: readBackProps };
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  return c;
}

/** Fake client for /search, with pagination */
function stubSearch(pagesOfResults) {
  const c = new NotionClient({ notion: { token: 't' } });
  c.calls = 0;
  c.request = async (method, path) => {
    assert.equal(`${method} ${path}`, 'post /search');
    const i = c.calls++;
    const results = pagesOfResults[i] ?? [];
    const hasMore = i < pagesOfResults.length - 1;
    return { results, has_more: hasMore, next_cursor: hasMore ? `c${i}` : null };
  };
  return c;
}

const realPage = (id, title) => ({
  id,
  parent: { type: 'page_id', page_id: 'parent' },
  url: `https://notion.so/${id}`,
  properties: { title: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
});

const dbRow = (id, title) => ({
  id,
  parent: { type: 'database_id', database_id: 'd' },
  url: `https://notion.so/${id}`,
  properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
});

// ---------------------------------------------------------------------------

describe('the option table covers every value the program writes', () => {
  test('every case newGuideStatus produces is in GUIDE_STATUS_OPTIONS', () => {
    const written = [
      newGuideStatus({ achieved: 51, total: 51 }), // all achievements
      newGuideStatus({ achieved: 50, total: 51 }), // some unlocked
      newGuideStatus({ achieved: 0, total: 51 }), // none at all
      newGuideStatus(undefined), // not synced yet
    ];
    for (const v of written) {
      assert.ok(GUIDE_STATUS_OPTIONS.includes(v), `newGuideStatus writes 「${v}」, but it is not in the option table`);
    }
  });

  test('the two values guide-status converges on are in there too', () => {
    for (const v of [GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED]) {
      assert.ok(GUIDE_STATUS_OPTIONS.includes(v), `guide-status writes 「${v}」, but it is not in the option table`);
    }
  });

  test('the first three are the defaults a Notion status property comes with — a hand-built database is only missing Staged', () => {
    // Measured: create a status property without specifying options and Notion returns exactly
    // these three. The line in the docs saying "usually only Staged has to be added by hand"
    // rests on this
    for (const v of ['Not started', 'In progress', 'Done']) {
      assert.ok(GUIDE_STATUS_OPTIONS.includes(v));
    }
  });
});

describe('createGuideDatabase', () => {
  test('the options in the request are GUIDE_STATUS_OPTIONS, not a separately copied list', async () => {
    const c = stubCreate({ readBackProps: statusProps(GUIDE_STATUS_OPTIONS) });
    await c.createGuideDatabase({ parentPageId: 'p1' });
    const sentOptions = c.sent[0].properties.Status.status.options.map((o) => o.name);
    assert.deepEqual(sentOptions, GUIDE_STATUS_OPTIONS);
    assert.equal(c.sent[0].parent.page_id, 'p1');
  });

  test('a complete read-back → returns the hyphen-free lowercase id, matching the shape of a hand-entered one', async () => {
    const c = stubCreate({ readBackProps: statusProps(GUIDE_STATUS_OPTIONS) });
    const db = await c.createGuideDatabase({ parentPageId: 'p1' });
    assert.equal(db.id, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
    assert.equal(db.statusProperty, 'Status');
    assert.deepEqual(db.options, GUIDE_STATUS_OPTIONS);
  });

  test('the read-back finds an option missing → throws, and names the missing one', async () => {
    // This is exactly how Notion silently swallows a status property's groups, so this
    // read-back is not a formality
    const c = stubCreate({ readBackProps: statusProps(['Not started', 'In progress', 'Done']) });
    await assert.rejects(c.createGuideDatabase({ parentPageId: 'p1' }), /Staged/);
  });

  test('the read-back finds no status property at all → throws, and reports differently from "some options are missing"', async () => {
    // Two faults, two fixes (add a property vs add options); fusing them into one sentence
    // describes the former as "all four options are missing"
    const c = stubCreate({ readBackProps: { Name: { type: 'title', title: {} } } });
    await assert.rejects(c.createGuideDatabase({ parentPageId: 'p1' }), /没有状态属性/);
  });

  test('no parent page given → throws on the spot, no request sent', async () => {
    const c = stubCreate({ readBackProps: statusProps(GUIDE_STATUS_OPTIONS) });
    await assert.rejects(c.createGuideDatabase({ parentPageId: '' }), /父页面/);
    assert.equal(c.sent.length, 0);
  });
});

describe('createNotionGuideDb guardrails — all of them stop before a request goes out', () => {
  const apiWith = (notion) =>
    createApi({ db: null, steam: null, config: { notion }, syncState: null,
      startBackgroundSync: null, guideGenState: null, startGuideGen: null, planGuidePreflight: null });

  test('a guide database is already configured → refused', async () => {
    // The worst consequence: someone with hundreds of guides presses the button and their
    // config is repointed at an empty database. Not one guide is lost, but the tool can no
    // longer see any of them, and nothing on screen shows what happened
    const r = await apiWith({ token: 't', overviewDbId: 'aaaa' }).createNotionGuideDb('', 'p1', 'x');
    assert.match(r.error, /已经配了攻略库/);
  });

  test('no token → refused', async () => {
    const r = await apiWith({}).createNotionGuideDb('', 'p1', 'x');
    assert.match(r.error, /Access token/);
  });

  test('no parent page selected → refused', async () => {
    const r = await apiWith({ token: 't' }).createNotionGuideDb('', '', 'x');
    assert.match(r.error, /父页面/);
  });
});

describe('searchPages', () => {
  test('database rows are filtered out, leaving only what can really serve as a parent page', async () => {
    const c = stubSearch([[dbRow('r1', '空之轨迹'), realPage('p1', '成就'), dbRow('r2', '鬼谷八荒')]]);
    const { pages } = await c.searchPages();
    assert.deepEqual(pages.map((p) => p.title), ['成就']);
  });

  test('it keeps paging until there is no next page', async () => {
    const c = stubSearch([[realPage('p1', '一')], [realPage('p2', '二')]]);
    const { pages, truncated } = await c.searchPages();
    assert.deepEqual(pages.map((p) => p.title), ['一', '二']);
    assert.equal(truncated, false);
  });

  test('the page limit is reached before the end → truncated is reported honestly', async () => {
    // "not in the list" and "the list was truncated" are two completely different situations
    // for the user, and both must not render as the former
    const c = stubSearch([[realPage('p1', '一')], [realPage('p2', '二')], [realPage('p3', '三')]]);
    const { pages, truncated } = await c.searchPages({ maxPages: 2 });
    assert.equal(pages.length, 2);
    assert.equal(truncated, true);
  });

  test('a page with no title does not render as a blank', async () => {
    const c = stubSearch([[{ id: 'p1', parent: { type: 'workspace' }, url: 'u', properties: {} }]]);
    const { pages } = await c.searchPages();
    assert.equal(pages[0].title, '(无标题)');
  });
});

// ---------------------------------------------------------------------------
// The health check at connection time, plus repair
// ---------------------------------------------------------------------------

/**
 * This section guards **the word 「配好了」 having to be true**.
 *
 * Before this, `saveNotionConfig` only checked whether the token worked and whether that ID
 * could return rows — reading no schema at all, so properties, types and options were all
 * deferred to the first real write. Meanwhile `notion-check` checked nearly all of it and the
 * setup page never called it. **The two paths checked different things, and that is the shape
 * of that class of bug**; a missing option is only the symptom.
 *
 * On the repair half, the most dangerous failure is not "it cannot be done", it is
 * **"it reported success and changed nothing"**. That is not hypothetical: Notion returns 200
 * and leaves a status property's `groups` untouched whether they are passed at creation or
 * PATCHed afterwards. So in every repair case below, "the PATCH returned 200" is **not**
 * evidence of success — the read-back is.
 */

/** A fake client that keeps a ledger. `patchDb` decides which temperament Notion puts on this time */
function stubDb({
  properties,
  tokenFails = false,
  dbFails = false,
  patchDb = 'honors',
  createFails = false,
  archiveFails = false,
} = {}) {
  const c = new NotionClient({ notion: { token: 't', overviewDbId: 'db1' } });
  c.log = [];
  let current = properties;
  c.request = async (method, path, payload) => {
    c.log.push({ method, path, payload });
    if (path === '/users/me') {
      if (tokenFails) throw new Error('API token is invalid');
      return { name: '我的工作区' };
    }
    if (method === 'get' && path.startsWith('/databases/')) {
      if (dbFails) throw new Error('Could not find database');
      return { id: 'db1', title: [{ plain_text: '攻略库' }], url: 'https://notion.so/db1', properties: current };
    }
    if (method === 'patch' && path.startsWith('/databases/')) {
      const [prop, body] = Object.entries(payload.properties)[0];
      const type = Object.keys(body)[0];
      // Three temperaments. The second is the one this project actually ran into
      if (patchDb === 'honors') current = { ...current, [prop]: { type, [type]: body[type] } };
      else if (patchDb === 'clobbers')
        current = { ...current, [prop]: { type, [type]: { options: [{ name: 'Staged' }] } } };
      // 'silently-ignores': returns 200, current does not change one character
      return {};
    }
    if (method === 'post' && path === '/pages') {
      if (createFails) throw new Error('API token does not have access to insert content');
      return { id: 'pg1', url: 'https://notion.so/pg1' };
    }
    if (method === 'patch' && path.startsWith('/pages/')) {
      if (archiveFails) throw new Error('conflict');
      return {};
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  return c;
}

const full = () => statusProps(GUIDE_STATUS_OPTIONS);
const codes = (r) => r.problems.map((p) => p.code);
const hitDb = (c) => c.log.filter((r) => r.path.startsWith('/databases/')).length;
const pagesPosted = (c) => c.log.filter((x) => x.method === 'post' && x.path === '/pages');

describe('inspectGuideDb — ask everything worth asking at the moment the database is connected', () => {
  test('an all-green database: ok, not one problem', async () => {
    const r = await inspectGuideDb(stubDb({ properties: full() }), 'db1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    assert.equal(r.workspace, '我的工作区');
    assert.equal(r.database.title, '攻略库');
  });

  test('the token does not work → stop right there rather than asking about a database with an ID that is bound to fail', async () => {
    const c = stubDb({ properties: full(), tokenFails: true });
    const r = await inspectGuideDb(c, 'db1');
    assert.deepEqual(codes(r), [DB_PROBLEM.BAD_TOKEN]);
    assert.equal(hitDb(c), 0, 'reading the database when the token already fails only adds a misleading second error');
  });

  test('no ID entered → its own kind of problem, not lumped in with "the database cannot be read"', async () => {
    const c = stubDb({ properties: full() });
    const r = await inspectGuideDb(c, '');
    assert.deepEqual(codes(r), [DB_PROBLEM.NO_DB_ID]);
    assert.equal(hitDb(c), 0);
  });

  test('the database cannot be read → both causes, which have different fixes, have to be stated', async () => {
    const r = await inspectGuideDb(stubDb({ properties: full(), dbFails: true }), 'db1');
    assert.deepEqual(codes(r), [DB_PROBLEM.DB_UNREADABLE]);
    // A version fusing them into one sentence sends the person who typed the wrong ID off to
    // check Connections over and over
    assert.equal(r.problems[0].causes.length, 2);
    assert.ok(r.problems[0].causes.some((s) => s.includes('不是数据库')));
    assert.ok(r.problems[0].causes.some((s) => s.includes('Connections')));
  });

  test('missing options → error level, naming what is missing and what is there, and marked fixable', async () => {
    const c = stubDb({ properties: statusProps(['Not started', 'In progress', 'Done']) });
    const r = await inspectGuideDb(c, 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.fixable, true);
    const p = r.problems.find((x) => x.code === DB_PROBLEM.MISSING_OPTIONS);
    assert.deepEqual(p.missing, ['Staged']);
    assert.deepEqual(p.have, ['Not started', 'In progress', 'Done']);
    assert.equal(p.severity, 'error');
  });

  test('no status property at all → warn rather than error, and ok stays true (this is a legal configuration)', async () => {
    // Reporting it as an error calls a database that can create guides and tick boxes perfectly
    // well a broken one. But it must not stay silent either: turning guide-status off quietly
    // gives the user "the status never updates"
    const c = stubDb({ properties: { Name: { type: 'title', title: {} } } });
    const r = await inspectGuideDb(c, 'db1');
    assert.equal(r.ok, true);
    assert.equal(r.fixable, false, 'a missing property is not something adding options fixes, so marking it fixable means the button does nothing when pressed');
    const p = r.problems.find((x) => x.code === DB_PROBLEM.NO_STATUS_PROP);
    assert.equal(p.severity, 'warn');
    assert.deepEqual(p.wanted, GUIDE_STATUS_OPTIONS);
  });

  test('no title property → error (page creation gets a 400, and that 400 does not reveal the cause)', async () => {
    const c = stubDb({ properties: { Status: { type: 'status', status: { options: [] } } } });
    const r = await inspectGuideDb(c, 'db1');
    assert.ok(codes(r).includes(DB_PROBLEM.NO_TITLE_PROP));
    assert.equal(r.ok, false);
  });
});

describe('inspectGuideDb write probe — a read-only inspection cannot see "read permission only"', () => {
  test('with probeWrite off, not one page is created', async () => {
    const c = stubDb({ properties: full() });
    await inspectGuideDb(c, 'db1');
    assert.equal(pagesPosted(c).length, 0);
  });

  test('the probe passes → create a page, archive it immediately, ok', async () => {
    const c = stubDb({ properties: full() });
    const r = await inspectGuideDb(c, 'db1', { probeWrite: true });
    assert.equal(r.ok, true);
    assert.equal(pagesPosted(c).length, 1);
    const archive = c.log.find((x) => x.method === 'patch' && x.path.startsWith('/pages/'));
    assert.equal(archive.payload.archived, true, 'creating without archiving leaves junk in the user database');
  });

  test('read permission only → NO_WRITE, pointing at the integration permission setting', async () => {
    const c = stubDb({ properties: full(), createFails: true });
    const r = await inspectGuideDb(c, 'db1', { probeWrite: true });
    const p = r.problems.find((x) => x.code === DB_PROBLEM.NO_WRITE);
    assert.ok(p, 'this is precisely the kind of fault that goes green all the way and 403s at page creation');
    assert.match(p.hint, /Insert content/);
  });

  test('archiving fails → say so and give the link to that page (leaving the page silently is worse)', async () => {
    const c = stubDb({ properties: full(), archiveFails: true });
    const r = await inspectGuideDb(c, 'db1', { probeWrite: true });
    const p = r.problems.find((x) => x.code === DB_PROBLEM.STRANDED_PROBE_PAGE);
    assert.equal(p.severity, 'warn');
    assert.equal(p.url, 'https://notion.so/pg1');
  });

  test('no probe when an error-level problem is already present — do not push pages into a database known to be misconfigured', async () => {
    const c = stubDb({ properties: statusProps(['Not started']) });
    await inspectGuideDb(c, 'db1', { probeWrite: true });
    assert.equal(pagesPosted(c).length, 0);
  });

  test('with incomplete options the probe carries no status — otherwise "no write permission" and "a missing option" fuse into one error', async () => {
    const c = stubDb({ properties: statusProps(['Not started']) });
    const schema = {
      titleProperty: 'Name',
      status: { property: 'Status', type: 'status', options: ['Not started'] },
    };
    await probeGuideDbWrite(c, 'db1', schema);
    assert.equal(pagesPosted(c)[0].payload.properties.Status, undefined);
  });

  test('with complete options the probe carries the status — the probe has to exercise the real downstream path', async () => {
    const c = stubDb({ properties: full() });
    const schema = {
      titleProperty: 'Name',
      status: { property: 'Status', type: 'status', options: [...GUIDE_STATUS_OPTIONS] },
    };
    await probeGuideDbWrite(c, 'db1', schema);
    assert.equal(pagesPosted(c)[0].payload.properties.Status.status.name, newGuideStatus(undefined));
  });
});

describe('repairGuideDb — a 200 is not evidence of success, the read-back is', () => {
  const threeOfFour = () => statusProps(['Not started', 'In progress', 'Done']);

  test('Notion honours it → report which ones were added, ok', async () => {
    const r = await repairGuideDb(stubDb({ properties: threeOfFour() }), 'db1');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'repaired');
    assert.deepEqual(r.added, ['Staged']);
    assert.deepEqual(r.stillMissing, []);
  });

  test('the PATCH returns 200 but nothing changed → has to be reported as a failure', async () => {
    // This repository really hit it: a status property's groups are swallowed exactly this
    // silently. Trust the 200 and the user presses the button, sees success, and is stopped by
    // the next guide-gen all the same — now harder to diagnose
    const r = await repairGuideDb(stubDb({ properties: threeOfFour(), patchDb: 'silently-ignores' }), 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'silently-ignored');
    assert.deepEqual(r.stillMissing, ['Staged']);
  });

  test('the existing options were clobbered → report clobbered, which is far worse than an unsuccessful repair', async () => {
    const r = await repairGuideDb(stubDb({ properties: threeOfFour(), patchDb: 'clobbers' }), 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'clobbered');
    assert.deepEqual(r.clobbered, ['Not started', 'In progress', 'Done']);
  });

  test('strictly additive: the payload sent has to carry every existing option unchanged', async () => {
    const c = stubDb({ properties: threeOfFour() });
    await repairGuideDb(c, 'db1');
    const patch = c.log.find((x) => x.method === 'patch' && x.path.startsWith('/databases/'));
    const sent = patch.payload.properties.Status.status.options.map((o) => o.name);
    assert.deepEqual(sent, ['Not started', 'In progress', 'Done', 'Staged']);
  });

  test('already complete → not one PATCH is sent', async () => {
    const c = stubDb({ properties: full() });
    const r = await repairGuideDb(c, 'db1');
    assert.equal(r.reason, 'nothing-to-do');
    assert.equal(c.log.filter((x) => x.method === 'patch').length, 0);
  });

  test('no status property → no PATCH sent, and it says plainly that adding options does not fix this', async () => {
    const c = stubDb({ properties: { Name: { type: 'title', title: {} } } });
    const r = await repairGuideDb(c, 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-status-prop');
    assert.equal(c.log.filter((x) => x.method === 'patch').length, 0);
  });
});
