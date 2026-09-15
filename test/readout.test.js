/**
 * The four numbers in the Dashboard's top-right readout
 * ------------------------------------------------------------------------
 * 游戏 / 已解锁成就 / 平均完成率 / 完美. Three of them come from the API and one
 * (游戏) is counted in the browser from the same rows, so only the API's three
 * are testable here.
 *
 * **The point of this file is that the four do not share one eligibility rule**,
 * and that the difference is deliberate rather than an oversight waiting to be
 * tidied away. `computeAgcrStats` follows Steam's published AGCR method and so
 * drops Unvetted games and games with nothing unlocked yet; `achievedTotal` is a
 * plain sum over the whole library. Routing the total through the same filter
 * would look like a cleanup and would silently make it disagree with the number
 * on the player's own Steam profile — downwards, which reads as lost progress.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, insertGame, updateGameStats } from '../lib/db.js';

// TRACKER_DATA_DIR before the dynamic import, for the reason spelled out in uilanguage.test.js
const DIR = mkdtempSync(join(tmpdir(), 'readout-'));
process.env.TRACKER_DATA_DIR = DIR;
writeFileSync(join(DIR, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y' }));
const { createApi } = await import('../lib/api.js');
const { agcrPercent } = await import('../lib/sync.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Source with its JavaScript comments removed, so the comment explaining a line cannot satisfy an
// assertion looking for that line; every assertion here looks for a JavaScript statement. Line
// comments go before block comments: a `//` line can hold `/api/` and a star, which a block strip
// run first reads as an opening delimiter
const code = (s) => s
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * A library holding one of every case the two rules disagree about:
 *   ordinary   12/20 — counts everywhere
 *   perfect     8/8  — counts everywhere, and is the one 完美 counts
 *   unvetted    5/10 — excluded from the average, **included in the total**
 *   untouched   0/30 — excluded from the average, contributes 0 to the total
 *   noStats    null  — has no achievement system at all
 */
function env() {
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
  const api = createApi({
    db, steam: {}, config: { uiLanguage: 'zh' }, syncState: { snapshot: () => ({}) },
    startBackgroundSync: null, guideGenState: null, startGuideGen: null,
    planGuidePreflight: null, maybeAutoSync: null,
  });
  return api.getDashboardData();
}

describe('achievedTotal', () => {
  test('is every unlocked achievement in the library, Unvetted games included', () => {
    // 12 + 8 + 5 + 0 = 25. Dropping the Unvetted game would give 20, and that is exactly the
    // "tidy-up" this asserts against: Steam's own profile counts it, so this has to as well
    assert.equal(env().achievedTotal, 25);
  });

  test('a game with no achievement system contributes nothing and does not make it null', () => {
    // achieved is null on that row, and `null + n` is not a number — one such game used to be
    // enough to blank the whole readout rather than to be skipped
    const total = env().achievedTotal;
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
  });
});

describe('the average and the perfect count keep their own rule', () => {
  test('the average is over started, vetted games only', () => {
    // 12/20 and 8/8 → (0.6 + 1) / 2 = 0.8. The Unvetted 5/10 and the untouched 0/30 are both out,
    // and including either would move this
    assert.equal(env().avgRounded, '80%');
  });

  test('so the two numbers are read off different populations by design', () => {
    const data = env();
    assert.equal(data.perfectCount, 1);
    // The guard that matters: if someone ever makes achievedTotal share AGCR's filter, this
    // stops holding — 25 counts a game the 80% does not
    assert.equal(data.achievedTotal, 25);
    assert.equal(data.totalGames, 5);
  });

  test('the precise figure is the same average, to two places', () => {
    assert.equal(env().avgPrecise, '80.00%');
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
    for (const id of ['cardTotal', 'cardAchieved', 'cardAvg', 'cardPerfect']) {
      assert.ok(page.includes('id="' + id + '"'), id + ' is missing from the readout markup');
      assert.ok(page.includes(assigns(id)),
        id + ' is drawn but never assigned, so it would sit on its – placeholder for ever');
    }
  });

  test('the counts are formatted together', () => {
    // 9,796 beside 143 beside 317: one of them separated by a different rule reads as a bug.
    // fmtCount is the single place that decides, so all three counts have to go through it
    for (const id of ['cardTotal', 'cardAchieved', 'cardPerfect']) {
      assert.ok(page.includes(assigns(id) + ' = fmtCount('),
        id + ' skips fmtCount, so it loses the thousands separator the others have');
    }
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
