/**
 * Queueing for guide generation
 * ------------------------------------------------
 * This file guards two things: **a task silently disappearing** and **the queue wedging**.
 *
 * Generating one guide takes 2–4 minutes, so "queue three and go do something else" is real
 * usage. And every failure on this path is silent: a task quietly dropped, the queue never
 * advancing again after some failure, the same game queued twice and therefore written twice —
 * not one of them raises an error, they merely leave someone coming back twenty minutes later
 * to find the work not done.
 *
 * The original behaviour was to **refuse** the second one (`{error: '已经有一个攻略在生成了'}`),
 * and that error was overwritten three seconds later by the poll with the name of the game
 * currently running — from the user's position, "clicking did nothing".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGuideGenState, serve } from '../lib/server.js';
import { openDb, insertGame, replaceAchievements } from '../lib/db.js';

describe('basic queue semantics', () => {
  test('while idle the queue is empty, and the snapshot carries it', () => {
    const s = createGuideGenState();
    assert.deepEqual(s.snapshot().queue, []);
    assert.equal(s.queueLength(), 0);
  });

  test('enqueue returns the position, first in first out', () => {
    const s = createGuideGenState();
    assert.equal(s.enqueue({ appid: '1', game: 'A' }), 1);
    assert.equal(s.enqueue({ appid: '2', game: 'B' }), 2);
    assert.equal(s.dequeue().appid, '1');
    assert.equal(s.dequeue().appid, '2');
    assert.equal(s.dequeue(), null, 'an empty queue has to return null rather than undefined — the caller uses it to decide whether to continue');
  });

  test('the queue is handed out with the snapshot — the page has to show how many are waiting', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: '空之轨迹', overwrite: true });
    const snap = s.snapshot();
    assert.deepEqual(snap.queue, [{ appid: '1', game: '空之轨迹' }]);
    // overwrite is for scheduling and should not leak to the frontend — the page has no use for it
    assert.equal('overwrite' in snap.queue[0], false);
  });

  test('the snapshot queue is a copy, so the outside cannot change internal state', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    s.snapshot().queue.push({ appid: '999', game: '假的' });
    assert.equal(s.queueLength(), 1);
  });
});

describe('isPending — stopping a repeated click', () => {
  test('the one currently running counts as pending', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    assert.equal(s.isPending('1'), true);
    assert.equal(s.isPending('2'), false);
  });

  test('one waiting in the queue counts as pending too', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.enqueue({ appid: '2', game: 'B' });
    assert.equal(s.isPending('2'), true);
  });

  test('a numeric and a string appid are both recognised — the frontend sends a string and so does the database', () => {
    const s = createGuideGenState();
    s.begin(1, 'A', 3);
    assert.equal(s.isPending('1'), true);
    s.enqueue({ appid: 2, game: 'B' });
    assert.equal(s.isPending('2'), true);
  });

  test('once finished it no longer counts as pending — otherwise not even one retry is possible', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.end(null, { ok: true });
    assert.equal(s.isPending('1'), false);
  });
});

describe('a failure must not wedge the queue', () => {
  test('after one failure the next can still be taken', () => {
    // This is the most important one: drainNext has to hang off both .then and .catch.
    // With only .then, one failure leaves everything queued behind it waiting forever, and
    // **raises no error**
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.enqueue({ appid: '2', game: 'B' });
    s.end(new Error('供应商挂了'));
    assert.equal(s.snapshot().error, '供应商挂了');
    assert.equal(s.dequeue().appid, '2', 'the previous one failed and the next still has to be able to start');
  });

  test('a total failure clears the queue and hands back what was cleared — nothing may disappear silently', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    s.enqueue({ appid: '2', game: 'B' });
    const dropped = s.clearQueue();
    assert.deepEqual(dropped.map((d) => d.game), ['A', 'B'],
      'what was dropped has to be returned, so the caller can write which ones were cancelled into the log');
    assert.equal(s.queueLength(), 0);
  });
});

/**
 * Claiming — stopping "the same game let through twice"
 * ------------------------------------------------------------------
 * `isPending` looks only at `running` and `queue`, while between "decide to generate this one"
 * and `begin()` sit the preflight (`planGuide` makes two Steam calls) and building the provider,
 * both of which await. During that window this game is neither running nor queued — so a second
 * click sees a blank slate and passes.
 *
 * Measured: with a 200 ms delay on the steam calls (real network is of that order), two
 * simultaneous `startGuideGen` requests gave one `started: true` and one `queued: position 1` —
 * the same game generated twice, paid for twice. The `startBackgroundSync` path does not have
 * this problem, because its check and its `begin()` are **two adjacent synchronous lines**.
 */
describe('claiming: the check and the reservation have to be in one synchronous block', () => {
  test('a successful claim returns true and counts as pending immediately', () => {
    const s = createGuideGenState();
    assert.equal(s.isPending('1'), false);
    assert.equal(s.claim('1'), true);
    assert.equal(s.isPending('1'), true, 'not pending after a claim means the claim does nothing at all');
  });

  test('**a second claim on the same one fails** — this is the whole point', () => {
    const s = createGuideGenState();
    assert.equal(s.claim('1'), true);
    assert.equal(s.claim('1'), false);
  });

  test('other appids are unaffected — a claim is per appid, not one global lock', () => {
    const s = createGuideGenState();
    assert.equal(s.claim('1'), true);
    assert.equal(s.claim('2'), true, 'claiming one and blocking all others amounts to abolishing the queue');
  });

  test('a number and a string are the same one — the frontend sends a string and so does the database', () => {
    const s = createGuideGenState();
    assert.equal(s.claim(730), true);
    assert.equal(s.claim('730'), false);
  });

  test('after a release it can be claimed again — being unable to retry once is worse than letting two through', () => {
    const s = createGuideGenState();
    s.claim('1');
    s.release('1');
    assert.equal(s.isPending('1'), false);
    assert.equal(s.claim('1'), true);
  });

  test('one that is running cannot be claimed', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    assert.equal(s.claim('1'), false);
  });

  test('one waiting in the queue cannot be claimed either', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.enqueue({ appid: '2', game: 'B' });
    assert.equal(s.claim('2'), false);
  });

  test('**after a release, the queue itself keeps it pending**', () => {
    // This is the premise that lets startGuideGen release unconditionally in its finally: once
    // enqueued the queue takes over, so there is no window of "released but nobody has picked it up"
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.claim('2');
    s.enqueue({ appid: '2', game: 'B' });
    s.release('2');
    assert.equal(s.isPending('2'), true, 'after the release this one becomes something anyone can queue again');
  });

  test('releasing the claim after begin() still leaves it pending', () => {
    const s = createGuideGenState();
    s.claim('1');
    s.begin('1', 'A', 3);
    s.release('1');
    assert.equal(s.isPending('1'), true);
  });

  /**
   * **A source assertion.** Everything above proves the state module is correct, but what
   * actually went wrong was **how the caller was written** — "check isPending, then await, then
   * start" leaks even with a perfectly correct `isPending`.
   */
  test('startGuideGen uses claim, and there is no other await between the claim and the first await', () => {
    const src = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const start = src.indexOf('async function startGuideGen(');
    assert.ok(start > 0, 'cannot find startGuideGen — this check has lost its target');
    const end = src.indexOf('async function startGuideGenClaimed(', start);
    assert.ok(end > start, 'cannot find startGuideGenClaimed — the anchor is gone, so this should be rewritten rather than loosened');
    const body = src.slice(start, end);

    assert.match(body, /guideGenState\.claim\(appid\)/,
      'the gate is not claim — checking without reserving lets two clicks through together');
    assert.doesNotMatch(body, /guideGenState\.isPending\(/,
      'isPending is still being used as the gate: it reserves nothing, so both clicks pass');
    // Only synchronous code is allowed **before** the claim. An await means the reservation
    // happens after the event loop has been yielded at least once
    const claimIdx = body.indexOf('guideGenState.claim(appid)');
    assert.doesNotMatch(body.slice(0, claimIdx), /\bawait\b/,
      'there is an await before the claim — during that window a second click sees nothing');
    assert.match(body, /finally\s*\{[\s\S]*guideGenState\.release\(appid\)/,
      'release is not in a finally — a preflight exception makes this game ungeneratable forever');
  });
});

/**
 * End to end: really start a server and click twice at once.
 *
 * The cases above test the parts and the way they are written; this one tests **what the bug
 * originally looked like** — which is how it was found. The key is the delay on the two steam
 * calls: without it, the two HTTP requests are naturally staggered by connection-setup timing,
 * the first has already reached `begin()` before the second arrives, and **the hole cannot be
 * detected**. The real `fetchPlayerAchievements` / `fetchGlobalAchievementPercentages` are two
 * round trips across the public internet, and 200 ms is a conservative estimate.
 */
describe('end to end: two simultaneous clicks on the same game', () => {
  const boot = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sat-queue-'));
    const db = openDb(join(dir, 'steam.db'));
    insertGame(db, { appid: '730', name: '测试游戏', status: '' });
    replaceAchievements(db, '730', [
      { apiName: 'A1', gameName: '测试游戏', nameCn: '成就一', description: 'x' },
    ]);
    const lag = (v) => new Promise((r) => setTimeout(() => r(v), 200));
    const server = await serve({
      db,
      steam: {
        fetchPlayerAchievements: () => lag([]),
        fetchGlobalAchievementPercentages: () => lag(null),
      },
      config: {
        port: 0,
        guidesDir: join(dir, 'guides'),
        steamApiKey: 'k',
        steamId: '1',
        // **Deliberately configure a provider that cannot be built** (the model name does not
        // match the vendor, so `assertModelMatchesProvider` throws on the spot), so the step
        // after the gate fails right there and **not one network request goes out**.
        // A fake key that can be built would make generation really start and really connect to
        // api.anthropic.com, and that request would land after the test has torn down the db —
        // an unhandled rejection.
        // This test looks at exactly one thing: **how many times the gate let something through**
        ai: { provider: 'anthropic', apiKey: 'NOT_A_REAL_KEY_LOCAL_TEST', model: 'gemini-2.5-pro' },
      },
      log: () => {},
    });
    const port = server.address().port;
    const start = () =>
      fetch(`http://127.0.0.1:${port}/api/startGuideGen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: ['730', false, null, null] }),
      }).then((r) => r.json());
    return { start, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
  };

  /**
   * **The criterion is "how many got the dedup sentence", not "how many are started".**
   *
   * The step after the gate fails (the provider is deliberately misconfigured), so even the one
   * let through returns `started: false`, differing only in the error content. Using `started`
   * as the criterion makes a broken gate (both let through, both hitting the provider) look
   * exactly like a working one — that assertion would be testing the provider, not the dedup.
   * **Exactly one blocked** is the thing itself.
   */
  const dedupCount = (rs) =>
    rs.filter((x) => /已经在生成或排队/.test(String(x.result?.error ?? ''))).length;

  test('**two simultaneous clicks, exactly one blocked by the dedup**', async () => {
    const { start, cleanup } = await boot();
    try {
      const rs = await Promise.all([start(), start()]);
      assert.equal(
        dedupCount(rs), 1,
        `${dedupCount(rs)} were blocked, there should be exactly 1 — 0 means the same game was let through twice ` +
        `(generated twice, paid for twice). A=${JSON.stringify(rs[0].result)} B=${JSON.stringify(rs[1].result)}`
      );
    } finally {
      cleanup();
    }
  });

  test('three simultaneous clicks, two blocked', async () => {
    const { start, cleanup } = await boot();
    try {
      const rs = await Promise.all([start(), start(), start()]);
      assert.equal(dedupCount(rs), 2, `only ${dedupCount(rs)} of three concurrent requests were blocked`);
    } finally {
      cleanup();
    }
  });
});

describe('the wiring that takes the next one', () => {
  /**
   * **A source assertion, not a behaviour test.**
   *
   * The "when finished, take the next" section lives inside `runGuideGen`, in `serve()`'s
   * closure, out of a unit test's reach — and it happens to be the most dangerous spot on this
   * path: with `drainNext()` hanging off only `.then`, one failed generation leaves everything
   * queued behind it waiting forever, **with no error, no timeout, nothing happening at all**.
   *
   * The "a failure must not wedge the queue" case above tests the state module itself, and
   * `dequeue()` passes whether the wiring is right or not. So what really guards this is the
   * case below.
   */
  test('drainNext has to hang off both .then and .catch', () => {
    const src = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8');
    const start = src.indexOf('const drainNext');
    assert.ok(start > 0, 'cannot find drainNext — this check has lost its target rather than passed');
    // **Slice to the section meant, rather than counting 2600 bytes forward.**
    //
    // That byte count is what it used to be, and after three more progress phases were wired
    // into onProgress on 2026-08-17, `.then` was pushed outside the window — reporting
    // "cannot find then/catch" while then/catch were plainly there.
    // A source assertion that takes a range by byte count slowly loses its aim as the function
    // it guards grows: enlarging it only moves the same mine further away, and the dangerous
    // direction is the reverse — the window still covers both markers while the code between
    // them has changed. Anchor on code that really exists, and error out when it is gone
    const end = src.indexOf('return { started: true', start);
    assert.ok(end > start, 'cannot find the tail of runGuideGen — the anchor is gone, so this check should be rewritten rather than loosened');
    const body = src.slice(start, end);
    const thenIdx = body.indexOf('.then((r) =>');
    const catchIdx = body.indexOf('.catch((err) =>');
    assert.ok(thenIdx > 0 && catchIdx > thenIdx, 'cannot find generateGuide then/catch');
    assert.match(body.slice(thenIdx, catchIdx), /drainNext\(\)/, '.then does not take the next one');
    assert.match(body.slice(catchIdx), /drainNext\(\)/,
      '.catch does not take the next one — one failure wedges the whole queue permanently, and entirely silently');
  });
});

describe('begin does not clear the queue', () => {
  test('when the next one starts, the ones not yet reached have to stay', () => {
    // begin() is `{ ...idle, ... }`, and idle has no queue — if the queue lived in that object
    // too, starting each one would wipe the rest, presenting as "five queued and only two ran"
    const s = createGuideGenState();
    s.enqueue({ appid: '2', game: 'B' });
    s.enqueue({ appid: '3', game: 'C' });
    s.begin('1', 'A', 3);
    assert.equal(s.queueLength(), 2, 'begin() reset the queue along with everything else');
    s.end(null, { ok: true });
    s.begin('2', 'B', 3);
    assert.equal(s.queueLength(), 2);
  });
});

describe('begin must not erase the previous result either', () => {
  /**
   * When generating from a queue, between one finishing and the next `begin()` sit only
   * `drainNext()` and one dynamic import in `createProvider()` (cached, no network) — a single
   * microtask. The page polls every three seconds, so the result in `state.result` is
   * **practically impossible to see**: it presents as five queued with only the last one's
   * result ever appearing, the guide links for the first four never showing up and those four
   * rows staying greyed out, which looks like "it finished but the interface does not refresh".
   *
   * So a finished result has to live outside state. The same reason as the queue, only harder —
   * a missing queue entry is "one never ran", a missing result here is "it ran and nobody knows".
   */
  test('after the next one starts, the previous result is still there', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.end(null, { ok: true, covered: 12, total: 12 });
    s.begin('2', 'B', 3);
    assert.equal(s.snapshot().result, null, 'state.result is supposed to be reset by begin');
    const done = s.snapshot().finished;
    assert.equal(done.length, 1, 'begin() erased the previous result along with everything else');
    assert.equal(done[0].game, 'A');
    assert.equal(done[0].appid, '1');
    assert.equal(done[0].result.covered, 12);
  });

  test('a failure has to go in there too — that row also has to stop being greyed out', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.end(new Error('供应商 500'));
    s.begin('2', 'B', 3);
    const done = s.snapshot().finished;
    assert.equal(done.length, 1, 'missing the failed one leaves that row greyed out forever');
    assert.equal(done[0].appid, '1');
    assert.match(done[0].error, /供应商 500/);
  });

  test('the notes that have to survive completion travel with the result', () => {
    // warnings say **what the finished product is missing** (segment 3 was not written), and
    // they are gone the moment the next begin() starts — while they have to stay on screen with
    // that result
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.warn('第 3 段未生成');
    s.end(null, { ok: true });
    s.begin('2', 'B', 3);
    assert.deepEqual(s.snapshot().finished[0].warnings, ['第 3 段未生成']);
    assert.deepEqual(s.snapshot().warnings, [], 'after begin the current round should not carry the previous round warnings');
  });

  test('seq increases monotonically — the page uses it to fetch increments', () => {
    const s = createGuideGenState();
    for (const id of ['1', '2', '3']) {
      s.begin(id, 'G' + id, 3);
      s.end(null, { ok: true });
    }
    const seqs = s.snapshot().finished.map((f) => f.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'out of order and the page misses entries');
    assert.equal(new Set(seqs).size, 3, 'a duplicate number makes the page treat one as already received');
  });

  test('there is a cap — queueing dozens at once must not blow up the snapshot', () => {
    const s = createGuideGenState();
    for (let i = 0; i < 25; i++) {
      s.begin(String(i), 'G' + i, 3);
      s.end(null, { ok: true });
    }
    const done = s.snapshot().finished;
    assert.equal(done.length, 20);
    assert.equal(done[done.length - 1].game, 'G24', 'what gets trimmed has to be the old end');
  });
});

describe('the finished screen has to be able to get the backup id', () => {
  /**
   * The 「删除备份」 on the "generation succeeded" screen relies on `result.backup.id`. Both
   * `generateGuide` and `patchGuide` return `backup`, but **this part of `server.js` used to
   * drop it** — and the symptom of dropping it is not an error, it is that the action never
   * appears, a kind of absence nothing calls out.
   *
   * What is handed out has to be the **archive id**, not an absolute path: the page takes it to
   * call `deleteGuideArchive`, and that endpoint accepts only an id. Assembling the id is
   * `archiveIdOf`'s job, and no string concatenation is allowed here — the id format is defined
   * by `parseArchiveId`, and a second copy written elsewhere will eventually disagree.
   */
  const src = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const result = src.slice(
    src.indexOf('guideGenState.end(null, {'),
    src.indexOf('for (const c of r.chunkFailures')
  );

  test('the result carries backup', () => {
    assert.ok(result.length > 0 && result.length < 3000, 'what was sliced should be that result');
    assert.match(result, /backup:/, 'drop it and 「删除备份」 never appears, without any error');
  });

  test('what is handed out is an id, not a path — and the id comes from archiveIdOf', () => {
    assert.match(result, /archiveIdOf\(config, r\.backup\.path\)/,
      'assembling the string by hand will eventually disagree with parseArchiveId');
    assert.doesNotMatch(result, /backup:\s*r\.backup\.path/, 'a path fed to the delete endpoint is a button that does nothing');
  });

  test('with no backup it is null — a whole new generation has no old copy to store', () => {
    assert.match(result, /r\.backup\?\.path\s*\n?\s*\?/,
      'without that check the new-generation screen shows a button that is bound to fail');
  });
});

/**
 * Cancelling — issue #79. Two shapes, and `cancelGuideGen` in server.js picks between them by
 * asking `snapshot()`, not by trying one then the other: **the running job and a queued one are
 * different objects with different recovery paths** (an AbortController to fire vs. an array
 * entry to remove), and conflating them risks the same mistake `isPending`/`claim` already made
 * once — a check that is true for the wrong reason.
 */
describe('cancelRunning / cancelQueued — the state module half', () => {
  test('cancelRunning is false when nothing is running: nothing to abort, nothing pretends otherwise', () => {
    const s = createGuideGenState();
    assert.equal(s.cancelRunning(), false);
  });

  test('cancelRunning aborts the controller that was set, and only that one', () => {
    const s = createGuideGenState();
    const ac = new AbortController();
    s.setController(ac);
    assert.equal(s.cancelRunning(), true);
    assert.equal(ac.signal.aborted, true);
  });

  test('the controller is one slot, not a stack — setController(null) really clears it', () => {
    // This is what runGuideGen's .finally does after every job, win or lose. Leaving the old
    // controller behind would let a *later* job's Cancel button reach back and abort a request
    // that already finished
    const s = createGuideGenState();
    const first = new AbortController();
    s.setController(first);
    s.setController(null);
    assert.equal(s.cancelRunning(), false, 'a cleared controller must not still be abortable');
    assert.equal(first.signal.aborted, false);
  });

  test('cancelQueued removes exactly the named appid, in place — the rest keep their order', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    s.enqueue({ appid: '2', game: 'B' });
    s.enqueue({ appid: '3', game: 'C' });
    assert.equal(s.cancelQueued('2'), true);
    assert.deepEqual(s.snapshot().queue.map((q) => q.appid), ['1', '3']);
  });

  test('cancelQueued on an appid not in the queue returns false and touches nothing', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    assert.equal(s.cancelQueued('999'), false);
    assert.equal(s.queueLength(), 1);
  });

  test('cancelQueued still un-greys the row: it synthesises a finished record', () => {
    // Without this, the row that started it stays greyed out forever — setGuideBusy(appid,
    // false) on the Dashboard only ever fires off an entry appearing in `finished`, and a job
    // that never reaches begin() would otherwise produce none
    const s = createGuideGenState();
    s.enqueue({ appid: '5', game: '空之轨迹' });
    assert.equal(s.cancelQueued('5'), true);
    const done = s.snapshot().finished;
    assert.equal(done.length, 1);
    assert.equal(done[0].appid, '5');
    assert.equal(done[0].game, '空之轨迹');
    assert.equal(done[0].error, null, 'a cancellation is not an error — the run did exactly what was asked');
    assert.deepEqual(done[0].result, { ok: false, cancelled: true });
  });

  test('cancelling one queued job leaves the others queued and cancellable', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    s.enqueue({ appid: '2', game: 'B' });
    s.cancelQueued('1');
    assert.equal(s.isPending('1'), false, 'appid 1 is free again — it can be queued afresh');
    assert.equal(s.isPending('2'), true, 'appid 2 is still queued and must still block a repeat click');
  });
});

/**
 * End to end: a real server, a real running job, cancelled through the real HTTP endpoint.
 *
 * The unit tests above prove the state module; this proves the **whole path** a click actually
 * takes — `/api/cancelGuideGen` → `cancelGuideGen` → `guideGenState.cancelRunning()` → the
 * controller's `abort()` → the fake provider's in-flight `send()` rejecting → `runGuideGen`'s
 * `.catch` recognising `err.cancelled` → a `finished` entry the next `/api/guideGenStatus` poll
 * picks up. Any one of those links silently missing (the commonest way: `signal` dropped
 * somewhere on its way from `runGuideGen` down into `provider.send`) leaves the button doing
 * nothing forever, indistinguishable from a slow network unless someone actually waits for it.
 */
describe('end to end: cancelling a real running job', () => {
  /**
   * Replaces globalThis.fetch wholesale (see the comment in boot() for why), so it also has to
   * carry the test's own calls to the local server through untouched. **The signal is what tells
   * the two apart**: `#once` always passes one, whether idle-timeout or Cancel-driven, and this
   * test's own `call()` helper below never does — so "no signal" reliably means "not the request
   * under test" rather than a guess about URLs or ports.
   */
  function hangingFetch(realFetch) {
    return (url, init) => {
      if (!init?.signal) return realFetch(url, init);
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (init.signal.aborted) return onAbort();
        init.signal.addEventListener('abort', onAbort);
      });
    };
  }

  const boot = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sat-cancel-'));
    const db = openDb(join(dir, 'steam.db'));
    insertGame(db, { appid: '730', name: '测试游戏', status: '' });
    replaceAchievements(db, '730', [
      { apiName: 'A1', gameName: '测试游戏', nameCn: '成就一', description: 'x' },
    ]);
    // **The real AnthropicProvider, with the real network call intercepted.** createProvider is
    // called inside server.js with no injectable fetchImpl, so the only way to reach a genuinely
    // running job — one whose in-flight request this test can then cancel — is to replace
    // globalThis.fetch, which is AnthropicProvider's own default when none is given.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch(originalFetch);
    const server = await serve({
      db,
      steam: {
        fetchPlayerAchievements: async () => ({ achievements: [{ apiname: 'A1', achieved: 0 }] }),
        fetchGlobalAchievementPercentages: async () => null,
      },
      config: {
        port: 0,
        guidesDir: join(dir, 'guides'),
        steamApiKey: 'k',
        steamId: '1',
        ai: { provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5' },
      },
      log: () => {},
    });
    const port = server.address().port;
    // **Unwrapped to the method's own return value.** The endpoint wraps every call as
    // `{ok, result}` (`ok` reflects only whether the body carries an `{error}` field, not HTTP
    // status) — the earlier "two simultaneous clicks" test above reaches into `.result` itself
    // for the same reason
    const call = (method, args) =>
      fetch(`http://127.0.0.1:${port}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args }),
      }).then((r) => r.json()).then((j) => j.result);
    return {
      call,
      cleanup: () => {
        globalThis.fetch = originalFetch;
        server.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  /** Polls guideGenStatus until running flips false, the same signal the Dashboard's fetchGen waits on */
  const untilFinished = async (call, tries = 50) => {
    for (let i = 0; i < tries; i++) {
      const s = await call('guideGenStatus', []);
      if (!s.running) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the job never stopped running — cancel did not reach the in-flight request');
  };

  test('cancelling a running job reports cancelled:true, and the finished record says so', async () => {
    const { call, cleanup } = await boot();
    try {
      const started = await call('startGuideGen', ['730', false, null, null]);
      assert.equal(started.started, true, `setup failed before the real test began: ${JSON.stringify(started)}`);

      const cancelled = await call('cancelGuideGen', ['730']);
      assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));

      const status = await untilFinished(call);
      const entry = status.finished.find((f) => f.appid === '730');
      assert.ok(entry, 'the cancelled job never produced a finished record — the row would stay greyed out forever');
      assert.equal(entry.error, null, 'a cancellation is not an error');
      assert.deepEqual(entry.result, { ok: false, cancelled: true });
    } finally {
      cleanup();
    }
  });

  test('cancelling an appid that is neither running nor queued reports cancelled:false', async () => {
    const { call, cleanup } = await boot();
    try {
      const r = await call('cancelGuideGen', ['999999']);
      assert.equal(r.cancelled, false);
      assert.ok(r.error, 'a false result with no explanation reads as "did it even try"');
    } finally {
      cleanup();
    }
  });
});

describe('reserving the run slot: one at a time means *any* two, not the same one twice', () => {
  /**
   * `claim()` is per appid and deliberately lets a second appid through — that is what makes a
   * queue possible at all. The one-at-a-time rule therefore needs a second, global gate, and it
   * has to close in the same synchronous block that decides to run, for exactly the reason
   * `claim()` does: `state.running` is not set until `begin()`, which is two awaits away
   * (the preflight, then building the provider). Two different games racing through that window
   * both read an idle state, both start, and both are paid for.
   */
  test('the first reservation succeeds and the second is refused', () => {
    const s = createGuideGenState();
    assert.equal(s.reserveRun(), true);
    assert.equal(s.reserveRun(), false, 'two reservations at once is two generations at once, and two bills');
  });

  test('**a different appid is refused too** — this is the whole difference from claim()', () => {
    const s = createGuideGenState();
    assert.equal(s.claim('1'), true);
    assert.equal(s.claim('2'), true, 'claim stays per appid, or there is no queue');
    assert.equal(s.reserveRun(), true);
    assert.equal(s.reserveRun(), false, 'both games hold their own claim and would both start');
  });

  test('one that is running holds the slot', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    assert.equal(s.reserveRun(), false);
  });

  test('begin() takes the slot over from the reservation, so the next one still cannot have it', () => {
    const s = createGuideGenState();
    assert.equal(s.reserveRun(), true);
    s.begin('1', 'A', 3);
    assert.equal(s.reserveRun(), false, 'the handover left the slot free between reserve and begin');
  });

  test('after the running one ends the slot is free again', () => {
    const s = createGuideGenState();
    s.reserveRun();
    s.begin('1', 'A', 3);
    s.end(null, { ok: true });
    assert.equal(s.reserveRun(), true, 'not freeing it on end wedges every later run, silently');
  });

  test('releaseRun gives it back when the reserving path never reached begin()', () => {
    const s = createGuideGenState();
    s.reserveRun();
    s.releaseRun();
    assert.equal(s.reserveRun(), true,
      'a reservation held by a job that failed before begin() means nothing ever runs again');
  });
});

describe('the wiring that decides to run rather than queue', () => {
  /**
   * **Source assertions**, for the same reason as `drainNext` above: both sites live inside
   * `serve()`'s closure. They are what stops the fix being quietly reverted to the
   * `snapshot().running` test it replaced, which reads correct and is wrong only under a race
   * no unit test observes.
   */
  const src = () => readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8');

  test('startGuideGenClaimed reserves the slot instead of asking whether one is running', () => {
    const s = src();
    const start = s.indexOf('async function startGuideGenClaimed');
    assert.ok(start > 0, 'cannot find startGuideGenClaimed — this check has lost its target rather than passed');
    const end = s.indexOf('async function runGuideGen', start);
    assert.ok(end > start, 'cannot find the tail of startGuideGenClaimed — rewrite this check rather than loosening it');
    const body = s.slice(start, end);
    assert.match(body, /guideGenState\.reserveRun\(\)/,
      'the enqueue decision does not reserve — two different appids both pass it and both start');
    assert.doesNotMatch(body, /snapshot\(\)\.running/,
      'still deciding on snapshot().running: that is read after an await, so it answers about a moment that has passed');
  });

  test('drainNext reserves the slot before taking a job off the queue', () => {
    const s = src();
    const start = s.indexOf('const drainNext');
    assert.ok(start > 0, 'cannot find drainNext — this check has lost its target rather than passed');
    const body = s.slice(start, s.indexOf('};', start));
    const reserveIdx = body.indexOf('reserveRun()');
    const dequeueIdx = body.indexOf('dequeue()');
    assert.ok(reserveIdx > 0, 'drainNext does not reserve — end() has already cleared running, so an incoming request starts alongside the one being drained');
    assert.ok(reserveIdx < dequeueIdx,
      'reserved after dequeuing: a job taken off the queue that then cannot start has nowhere to go back to, and losing it raises no error');
    assert.match(body, /releaseRun\(\)/,
      'nothing gives the slot back when the queue turns out to be empty, so the next request queues forever');
  });

  test('the one exit between reserving and begin() gives the slot back', () => {
    const s = src();
    const start = s.indexOf('provider = await createProvider(runConfig);');
    assert.ok(start > 0, 'cannot find the createProvider call — this check has lost its target rather than passed');
    const body = s.slice(start, s.indexOf('guideGenState.begin(', start));
    assert.match(body, /releaseRun\(\)/,
      'a provider that cannot be built leaves the slot held by a job that never ran — every later request queues behind a queue that never drains');
  });
});
