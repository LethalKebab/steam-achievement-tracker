/**
 * The four numbers in the Dashboard's top-right readout
 * ------------------------------------------------------------------------
 * 游戏 / 已解锁成就 / 平均完成率 / 已完成. Three of them come from the API and one
 * (游戏) is counted in the browser from the same rows, so only the API's three
 * are testable here.
 *
 * **Three of the four are Steam's profile statistics, and they share one rule
 * about Unvetted games: they are left out.** `computeProfileStats` gives the
 * unlocked total and the completed count; `computeAgcrStats` gives the average,
 * which also drops games with nothing unlocked. The completed count is the one
 * that reads achievement sets: a game divided into sets counts once per finished
 * set, any other game once when everything in it is unlocked. Routing any one of
 * the three around the shared rule would look like a cleanup and would quietly
 * make it disagree with the other two.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb, insertGame, updateGameStats, replaceAchievementSets, setGameField, markNoAchievements,
} from '../lib/db.js';

// TRACKER_DATA_DIR before the dynamic import, for the reason spelled out in uilanguage.test.js
const DIR = mkdtempSync(join(tmpdir(), 'readout-'));
process.env.TRACKER_DATA_DIR = DIR;
writeFileSync(join(DIR, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y' }));
const { createApi } = await import('../lib/api.js');
const { agcrPercent, computeProfileStats, computeAgcrStats } = await import('../lib/sync.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Source with its JavaScript comments removed, so the comment explaining a line cannot satisfy an
// assertion looking for that line; every assertion here looks for a JavaScript statement. Line
// comments go before block comments: a `//` line can hold `/api/` and a star, which a block strip
// run first reads as an opening delimiter
const code = (s) => s
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** A stored set, in the shape `replaceAchievementSets` takes */
const setRow = (setId, extra = {}) => ({
  setId, nameEn: '', nameCn: '', dlcAppid: null, position: 0, total: 10, need: 10, archived: false,
  visible: true, achievable: true, done: 0, completed: false, completedAt: null, ...extra,
});
const finished = (setId) => setRow(setId, { done: 10, completed: true });

/**
 * A library holding one of every case the readings disagree about:
 *   ordinary   12/20 — counts everywhere
 *   perfect     8/8  — counts everywhere, and is one finished game
 *   unvetted    5/10 — left out of all three profile readings
 *   untouched   0/30 — out of the average, contributes 0 to the total
 *   noStats    null  — has no achievement system at all
 * and, with `sets`, three games that are divided into sets:
 *   limited     4/4  — Unvetted, with two finished sets: left out of the completed count
 *   expansion  30/40 — not at 100%, yet two of its three sets are finished: two units
 *   trilogy    60/60 — three finished sets: three units
 */
function build({ sets = false } = {}) {
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: 'ordinary' });
  insertGame(db, { appid: '2', name: 'perfect' });
  insertGame(db, { appid: '3', name: 'unvetted', status: 'Unvetted' });
  insertGame(db, { appid: '4', name: 'untouched' });
  insertGame(db, { appid: '5', name: 'noStats' });
  updateGameStats(db, '1', { achieved: 12, total: 20 });
  updateGameStats(db, '2', { achieved: 8, total: 8 });
  updateGameStats(db, '3', { achieved: 5, total: 10 });
  updateGameStats(db, '4', { achieved: 0, total: 30 });
  if (sets) {
    insertGame(db, { appid: '6', name: 'limited', status: 'Unvetted' });
    insertGame(db, { appid: '7', name: 'expansion' });
    insertGame(db, { appid: '8', name: 'trilogy' });
    updateGameStats(db, '6', { achieved: 4, total: 4 });
    updateGameStats(db, '7', { achieved: 30, total: 40 });
    updateGameStats(db, '8', { achieved: 60, total: 60 });
    replaceAchievementSets(db, '6', [finished(0), finished(1)]);
    replaceAchievementSets(db, '7', [finished(0), finished(1), setRow(2)]);
    replaceAchievementSets(db, '8', [finished(0), finished(1), finished(2)]);
  }
  const api = createApi({
    db, steam: {}, config: { uiLanguage: 'zh' }, syncState: { snapshot: () => ({}) },
    startBackgroundSync: null, guideGenState: null, startGuideGen: null,
    planGuidePreflight: null, maybeAutoSync: null,
  });
  return { db, api };
}
const data = (opts) => build(opts).api.getDashboardData();

describe('achievedTotal', () => {
  test('is what the player unlocked, with Unvetted games left out as Steam\'s profile leaves them', () => {
    // 12 + 8 + 0 = 20. The Unvetted game's 5 is not in it
    assert.equal(data().achievedTotal, 20);
  });

  test('a game with no achievement system contributes nothing and does not make it null', () => {
    // achieved is null on that row, and `null + n` is not a number — one such game used to be
    // enough to blank the whole readout rather than to be skipped
    const total = data().achievedTotal;
    assert.equal(typeof total, 'number');
    assert.ok(Number.isFinite(total), 'a row with no stats must not turn the sum into NaN');
  });

  test('an empty library reads 0, not null', () => {
    const db = openDb(':memory:');
    const api = createApi({
      db, steam: {}, config: { uiLanguage: 'zh' }, syncState: { snapshot: () => ({}) },
      startBackgroundSync: null, guideGenState: null, startGuideGen: null,
      planGuidePreflight: null, maybeAutoSync: null,
    });
    assert.equal(api.getDashboardData().achievedTotal, 0);
    assert.equal(api.getDashboardData().completedCount, 0);
  });
});

describe('completedCount', () => {
  test('a game without sets counts once, when everything in it is unlocked', () => {
    // perfect 8/8. ordinary 12/20 does not count, and neither does untouched 0/30
    assert.equal(data().completedCount, 1);
  });

  test('a game divided into sets counts once per finished set', () => {
    // perfect 1 + expansion 2 + trilogy 3. The expansion is at 30 of 40 and still adds two
    assert.equal(data({ sets: true }).completedCount, 6);
  });

  test('a game Steam has stopped answering for adds nothing, whatever sets it once stored', () => {
    // markNoAchievements clears the game's numbers and leaves its set rows, so without a check the
    // sets would go on counting beside a row that reads N/A
    const { db, api } = build({ sets: true });
    markNoAchievements(db, '8');
    const after = api.getDashboardData();
    assert.equal(after.completedCount, 3, "the trilogy's three finished sets are gone");
    assert.equal(after.achievedTotal, 50, 'and so are its 60 unlocked achievements');
  });

  test('a locked game keeps counting the sets it holds, which are what Steam last said', () => {
    // The sync never asks a locked row about its sets again, so they cannot go stale against anything
    // newer; the numbers typed beside them are the owner's
    const { db, api } = build({ sets: true });
    setGameField(db, '7', 'sync_locked', 1);
    assert.equal(api.getDashboardData().completedCount, 6);
  });
});

describe('the three profile readings leave Unvetted games out, all alike', () => {
  test('clearing the mark on a finished game moves the total, the average and the completed count together', () => {
    const { db, api } = build({ sets: true });
    const before = api.getDashboardData();
    assert.equal(before.achievedTotal, 110, '12 + 8 + 0 + 30 + 60');
    assert.equal(before.completedCount, 6);
    assert.equal(before.avgPrecise, '83.75%', 'over 12/20, 8/8, 30/40 and 60/60');

    // The Unvetted game is 4/4 with two finished sets
    setGameField(db, '6', 'status', '');
    const after = api.getDashboardData();
    assert.equal(after.achievedTotal, 114, 'its 4 unlocked achievements are in');
    assert.equal(after.completedCount, 8, 'and so are its two finished sets');
    assert.equal(after.avgPrecise, '87.00%', 'and it is one more finished game in the mean');
  });

  test('a hand-kept game still counts: the rule is about Unvetted, not about anything unusual', () => {
    const { db, api } = build({ sets: true });
    const before = api.getDashboardData();
    setGameField(db, '1', 'status', 'Manual');
    setGameField(db, '2', 'status', 'Manual');
    const after = api.getDashboardData();
    assert.equal(after.achievedTotal, before.achievedTotal);
    assert.equal(after.completedCount, before.completedCount);
    assert.equal(after.avgPrecise, before.avgPrecise);
  });
});

describe('the average keeps its own rule', () => {
  test('the average is over started, vetted games only', () => {
    // 12/20 and 8/8 → (0.6 + 1) / 2 = 0.8. The Unvetted 5/10 and the untouched 0/30 are both out,
    // and including either would move this
    assert.equal(data().avgRounded, '80%');
  });

  test('the library total counts every game, whatever the other readings leave out', () => {
    const d = data();
    assert.equal(d.totalGames, 5);
    assert.equal(data({ sets: true }).totalGames, 8, 'an Unvetted game is still a game in the library');
  });

  test('the precise figure is the same average, to two places', () => {
    assert.equal(data().avgPrecise, '80.00%');
  });

  test('the average carries no perfect count of its own', () => {
    // The completed count is `computeProfileStats`'s. A second count of finished games beside it
    // would be a second answer to the same question, and the two would drift
    assert.equal('perfectCount' in computeAgcrStats(build().db), false);
  });
});

describe('computeProfileStats', () => {
  test('gives the unlocked total and the completed count', () => {
    assert.deepEqual(computeProfileStats(build({ sets: true }).db), { achieved: 110, completed: 6 });
  });
});

/**
 * The readout prints the whole number and hovering it shows the precise one, so the precise one
 * has to begin with the whole one. Rounded, a mean of 78.996% hovers as 79.00% beside a 78%;
 * floored straight off the double, an exact 29% prints as 28.
 */
describe('agcrPercent keeps the whole and the precise figure in agreement', () => {
  test('it truncates rather than rounds', () => {
    assert.deepEqual(agcrPercent(0.78996, 2), { whole: 78, precise: '78.99' });
  });

  test('a figure a double cannot hold exactly is not printed one lower', () => {
    // 0.29 * 100 * 100 is 2899.9999999999995
    assert.deepEqual(agcrPercent(0.29, 2), { whole: 29, precise: '29.00' });
  });

  test('the ends of the range, 0% and 100%', () => {
    assert.deepEqual(agcrPercent(0, 2), { whole: 0, precise: '0.00' });
    assert.deepEqual(agcrPercent(1, 2), { whole: 100, precise: '100.00' });
  });

  test("the terminal's three places follow the same rule", () => {
    assert.deepEqual(agcrPercent(0.789996, 3), { whole: 78, precise: '78.999' });
  });
});

describe('the readout is wired to what the API actually sends', () => {
  const page = readFileSync(join(ROOT, 'Dashboard.html'), 'utf8');

  const assigns = (id) => "getElementById('" + id + "').textContent";

  test('every reading has an element and every element is filled', () => {
    for (const id of ['cardTotal', 'cardAchieved', 'cardAvg', 'cardCompleted']) {
      assert.ok(page.includes('id="' + id + '"'), id + ' is missing from the readout markup');
      assert.ok(page.includes(assigns(id)),
        id + ' is drawn but never assigned, so it would sit on its – placeholder for ever');
    }
  });

  test('the counts are formatted together', () => {
    // 9,796 beside 143 beside 317: one of them separated by a different rule reads as a bug.
    // fmtCount is the single place that decides, so all three counts have to go through it
    for (const id of ['cardTotal', 'cardAchieved', 'cardCompleted']) {
      assert.ok(page.includes(assigns(id) + ' = fmtCount('),
        id + ' skips fmtCount, so it loses the thousands separator the others have');
    }
  });

  test('the completed reading is filled from the field the API sends', () => {
    assert.ok(code(page).includes(assigns('cardCompleted') + ' = fmtCount(data.completedCount)'),
      'cardCompleted is assigned from something other than completedCount');
  });

  test('hovering the average shows the precise figure', () => {
    assert.ok(code(page).includes("getElementById('cardAvg').title = data.avgPrecise"),
      'avgPrecise is computed and sent, and nothing on the page shows it');
  });
});

describe('every surface turns the average into a percentage through agcrPercent', () => {
  // A copy of that arithmetic anywhere else can round where agcrPercent truncates, and the terminal
  // and the readout then print different figures for one average. Two checks, because each misses
  // what the other catches: the count drops when a call is replaced outright, and the pattern finds
  // a copy written beside a call that is still there, in either operand order
  for (const [file, calls] of [['lib/api.js', 1], ['tracker.js', 2]]) {
    test(file, () => {
      const src = code(readFileSync(join(ROOT, file), 'utf8'));
      assert.equal(src.split('agcrPercent(agcr.avg, ').length - 1, calls,
        file + ' calls agcrPercent a different number of times than the ' + calls + ' expected');
      assert.ok(!/avg\s*\*\s*100|100\s*\*\s*[\w.]*avg\b/.test(src),
        file + ' turns the average into a percentage itself');
    });
  }
});

describe('every surface takes the completed count from computeProfileStats', () => {
  // The terminal's status line and the sync summary print the same figure the readout does. A count
  // written beside them from the games alone would leave the sets out and count fewer than the
  // readout does. The calls are counted, as for agcrPercent above: tracker.js feeds two lines from
  // it, and a presence check keeps passing when one of them is pointed somewhere else, or at another
  // property of the result
  for (const [file, call, calls] of [
    ['lib/api.js', 'computeProfileStats(db)', 1],
    ['tracker.js', 'computeProfileStats(db).completed', 2],
  ]) {
    test(file, () => {
      const src = code(readFileSync(join(ROOT, file), 'utf8'));
      assert.equal(src.split(call).length - 1, calls,
        file + ' reads ' + call + ' a different number of times than the ' + calls + ' expected');
      assert.ok(!src.includes('perfectCount'), file + ' reads perfectCount, which nothing computes');
    });
  }
});
