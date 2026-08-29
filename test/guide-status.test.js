/**
 * The guide page status convergence rules (complete → Done)
 * ------------------------------------------------
 * Run with: node --test
 *
 * This layer's design point is that it **judges from the current state, never from "it just
 * hit 100% this round"**.
 * The instant of 100% exists only for as long as updateGameStats writes it, and any run
 * that fails to write it (the machine running the sync has no Notion configured, the
 * process is interrupted, the token expires) loses that change forever: next time round,
 * both the old and the new value read 100% and nothing can be inferred.
 *
 * So every case below feeds only "the current state" and no change history at all — which
 * is itself pinning that design.
 * Running it twice has to give the same result (idempotence), or repeatedly opening the
 * Dashboard would repeatedly write to Notion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertGame, upsertGuide, updateGameStats } from '../lib/db.js';
import {
  selectGuideStatusUpdates,
  syncGuideStatuses,
  GUIDE_STATUS_DONE,
  GUIDE_STATUS_STAGED,
} from '../lib/guides.js';

const freshDb = () => openDb(':memory:');
const PAGE = (n) => `3af1fee6252b8073883ecea59b4d83${String(n).padStart(2, '0')}`;

/** One game row plus its Notion guide page */
function seed(db, { appid, achieved, total, kind = 'notion', page = null }) {
  insertGame(db, { appid, name: 'G' + appid });
  if (total !== null) updateGameStats(db, appid, { achieved, total });
  upsertGuide(db, {
    appid,
    name: 'G' + appid,
    url: kind === 'notion' ? 'https://app.notion.com/' + (page ?? PAGE(appid)) : 'g.md',
    kind,
  });
}

const pageRow = (n, status) => ({ id: PAGE(n), title: 'G' + n, url: 'https://app.notion.com/' + PAGE(n), status });
const targets = (db, pages) => selectGuideStatusUpdates(db, pages).map((u) => u.appid).sort();

describe('selectGuideStatusUpdates — the basic criteria', () => {
  test('complete and not yet Done → has to change', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    const r = selectGuideStatusUpdates(db, [pageRow('1', 'Staged')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].from, 'Staged');
    assert.equal(r[0].to, GUIDE_STATUS_DONE);
  });

  test('not yet complete → untouched, even one achievement short', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 9, total: 10 });
    assert.deepEqual(targets(db, [pageRow('1', 'In progress')]), []);
  });

  test('already Done → untouched (idempotent: another run does not write again)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    assert.deepEqual(targets(db, [pageRow('1', 'Done')]), []);
  });

  test('an empty status is changed too', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    assert.deepEqual(targets(db, [pageRow('1', null)]), ['1']);
  });
});

describe('selectGuideStatusUpdates — which statuses are overwritten', () => {
  // Per the user's choice: everything but Done itself is overwritten, including Differed,
  // which Notion groups under "complete". The criterion is completion, not a hand-set
  // workflow status.
  for (const from of ['Not started', 'Staged', 'In progress', 'Paused', 'Differed']) {
    test(`${from} → Done`, () => {
      const db = freshDb();
      seed(db, { appid: '1', achieved: 10, total: 10 });
      assert.deepEqual(targets(db, [pageRow('1', from)]), ['1']);
    });
  }
});

describe('selectGuideStatusUpdates — what must not be touched', () => {
  test('a game with no achievement system (total is NULL) → untouched', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: null, total: null });
    assert.deepEqual(targets(db, [pageRow('1', 'Paused')]), []);
  });

  test('a local markdown guide → untouched (there is no such thing as a status property)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10, kind: 'local' });
    assert.deepEqual(targets(db, [pageRow('1', 'Paused')]), []);
  });

  test('a guide page with no registered appid yet (the guide is unwritten) → untouched', () => {
    const db = freshDb();
    assert.deepEqual(targets(db, [pageRow('99', 'Not started')]), []);
  });

  test('page identity is compared by normalised ID, so a URL with a title slug is still recognised', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    // Notion sometimes prefixes a URL with the title, so the same page's text differs between two queries
    const slugged = { id: PAGE('1'), title: 'G1', url: 'https://app.notion.com/My-Game-' + PAGE('1'), status: 'Paused' };
    assert.deepEqual(targets(db, [slugged]), ['1']);
  });

  test('with several pages, only the ones that should change are picked', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    seed(db, { appid: '2', achieved: 5, total: 10 });
    seed(db, { appid: '3', achieved: 7, total: 7 });
    const pages = [pageRow('1', 'Paused'), pageRow('2', 'Paused'), pageRow('3', 'Done')];
    assert.deepEqual(targets(db, pages), ['1']);
  });
});

describe('selectGuideStatusUpdates — dropping below 100% goes back to Staged', () => {
  // A developer patch adding achievements knocks a completed game below 100%. This is the
  // one change that "happens without you playing", and a page left at Done hides it.
  test('Done but no longer at 100% → back to Staged', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 28, total: 51 });
    const r = selectGuideStatusUpdates(db, [pageRow('1', 'Done')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].from, GUIDE_STATUS_DONE);
    assert.equal(r[0].to, GUIDE_STATUS_STAGED);
    assert.equal(r[0].reason, 'incomplete');
  });

  test('once demoted, another run leaves it alone (idempotent, with no tug of war with the user)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 28, total: 51 });
    assert.deepEqual(targets(db, [pageRow('1', GUIDE_STATUS_STAGED)]), []);
  });

  // The demotion direction **only touches Done**. Every other status below 100% is a
  // workflow the person arranged themselves, and overwriting it on every Dashboard open
  // would put them and the machine in a loop.
  for (const from of ['Not started', 'Staged', 'In progress', 'Paused', 'Differed']) {
    test(`below 100% with status ${from} → untouched`, () => {
      const db = freshDb();
      seed(db, { appid: '1', achieved: 5, total: 10 });
      assert.deepEqual(targets(db, [pageRow('1', from)]), []);
    });
  }

  test('total cleared to NULL (Steam says there is no achievement system) → untouched, and not counted as dropping below 100%', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: null, total: null });
    assert.deepEqual(targets(db, [pageRow('1', 'Done')]), []);
  });

  test('both directions can happen in the same round without interfering', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 }); // complete and still Paused
    seed(db, { appid: '2', achieved: 28, total: 51 }); // dropped below 100% and still Done
    const r = selectGuideStatusUpdates(db, [pageRow('1', 'Paused'), pageRow('2', 'Done')]);
    assert.deepEqual(
      r.map((u) => `${u.appid}:${u.from}→${u.to}`).sort(),
      ['1:Paused→Done', '2:Done→Staged']
    );
  });

  test('the two rules are mutually exclusive and one page can never hit both (so it cannot oscillate)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    // Complete and already Done → entirely untouched
    assert.deepEqual(targets(db, [pageRow('1', GUIDE_STATUS_DONE)]), []);
  });
});

// ---------------------------------------------------------------------------
// The network half: with options missing from the database, it has to stop before the first write
// ---------------------------------------------------------------------------

/**
 * Everything above is a pure function. This section guards the "say which one is missing"
 * precheck inside `syncGuideStatuses`, and **it previously had not one test** — deleting the
 * whole block left the full suite green (caught by mutation testing on 2026-08-14).
 *
 * Deleting it raises no error for anyone; it merely degrades into writing page by page and
 * getting a barely readable Notion 400 per page, and that 400 is swept into `sync_log` by
 * this path's own `catch` before carrying on to the next page. And this path happens to be
 * **automatic** — it runs on every Dashboard open and every 立即同步 click — so the degraded
 * form is 「日志里天天堆一句读不懂的 400,界面上什么都看不出来」.
 *
 * This is the same failure class as the 1.1.2 report of 2026-08-14: the status options do not
 * line up and the error message does not speak plainly. The page-creation path
 * (`planNotionTarget`) has long been pinned; the convergence path was a gap.
 *
 * **Both sides have to be pinned.** Pinning only "a missing option throws" would also pass
 * with the condition written as always-true — and always-true means a properly configured
 * database can never be used again.
 */
describe('syncGuideStatuses — a missing option has to be blocked before writing', () => {
  /** Implements only the three methods this path actually calls; `writes` collects each real write */
  const stubNotion = (options) => {
    const writes = [];
    return {
      writes,
      fetchGuideStatusSchema: async () => ({ property: 'Status', type: 'status', options }),
      queryGuideDatabase: async () => [pageRow('1', 'Not started')],
      setPageStatus: async (_pageId, { value }) => void writes.push(value),
    };
  };

  /** Complete while the page still reads Not started — that is, "there really is a write pending" */
  const dbWithPendingWrite = () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    return db;
  };

  for (const missing of [GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED]) {
    test(`${missing} missing from the options → throws naming it, and not one write happens`, async () => {
      const notion = stubNotion(['Not started', 'In progress', 'Staged', 'Done'].filter((o) => o !== missing));
      await assert.rejects(
        syncGuideStatuses(dbWithPendingWrite(), { notion }),
        (err) => err.message.includes(missing) && err.message.includes('缺少'),
        `the error has to name 「${missing}」 as the missing one rather than only saying "something is wrong"`
      );
      // The check has to finish **before any request goes out**. Later, and the first few pages
      // are already written — and this is the path that runs automatically, with nobody watching
      assert.deepEqual(notion.writes, [], `nothing should be written when ${missing} is missing`);
    });
  }

  test('a missing Staged blocks too — even when this round is writing Done', async () => {
    // Both directions' options have to be checked up front: checking only "the one being written
    // this time" leaves a database missing Staged working perfectly until the day some game
    // drops below 100% and it blows up for the first time — by which point nobody remembers the
    // setup was incomplete
    const notion = stubNotion(['Not started', 'In progress', 'Done']);
    await assert.rejects(syncGuideStatuses(dbWithPendingWrite(), { notion }), /Staged/);
    assert.deepEqual(notion.writes, []);
  });

  test('with every option present → it writes normally (the other side: the check must not become always-true)', async () => {
    const notion = stubNotion(['Not started', 'In progress', 'Staged', 'Done']);
    await syncGuideStatuses(dbWithPendingWrite(), { notion });
    assert.deepEqual(notion.writes, [GUIDE_STATUS_DONE]);
  });

  test('a dry run writes nothing either', async () => {
    const notion = stubNotion(['Not started', 'In progress', 'Staged', 'Done']);
    await syncGuideStatuses(dbWithPendingWrite(), { notion, dryRun: true });
    assert.deepEqual(notion.writes, []);
  });
});
