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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
});
