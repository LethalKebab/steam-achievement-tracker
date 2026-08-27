/**
 * 第二阶段取样规则的回归测试
 * ------------------------------------------------
 * 跑法:node --test(零依赖,用 Node 内置的 node:test)
 *
 * 锁住的是"哪些游戏这次要跟 Steam 对账"。这里放宽或收紧都会**静默丢数据**——
 * 少查一行不会报错,只会让 Dashboard 上的数字悄悄停在旧值上,所以每条规则都钉住:
 *
 * - achieved 只有你玩了才会变 → rtime_last_played 没动就可以跳过
 * - total 是游戏的属性,开发者打补丁就能改 → 光看 rtime 会永远发现不了,
 *   必须靠轮换扫描兜底,完美游戏还要扫得更勤(掉出 100% 是最想早点知道的)
 * - 不在 owned 列表里的行拿不到 rtime → 只能每次都查,不许冻掉
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertGame, markStatsChecked, updateGameStats, setGameField } from '../lib/db.js';
import { selectStatsTargets } from '../lib/sync.js';

const DAY_MS = 86400000;
const agoIso = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

/** 每个用例一个独立的内存库,互不干扰,也不用收拾 */
const freshDb = () => ({ db: openDb(':memory:'), cleanup: () => {} });

/** 建一行"已经对过账"的游戏:checkedDaysAgo 天前查的,当时的 rtime 是 lastPlayed */
function seedGame(db, { appid, name = 'G' + appid, lastPlayed = 1000, checkedDaysAgo = 0, rate = null }) {
  insertGame(db, { appid, name });
  if (rate !== null) updateGameStats(db, appid, { achieved: rate === 1 ? 10 : 5, total: 10 });
  db.prepare('UPDATE games SET last_played = ?, stats_checked_at = ? WHERE appid = ?')
    .run(lastPlayed, agoIso(checkedDaysAgo), String(appid));
}

const names = (r) => r.targets.map((g) => g.appid).sort();
const SELECTION = { sweepBudget: 40, maxStatsAgeDays: 7, perfectGameMaxAgeDays: 3 };

describe('selectStatsTargets — 没有 playSnapshot 就是全量', () => {
  test('不传 snapshot → 所有没锁的行都查(CLI `sync` 靠这个保证不漏)', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    const r = selectStatsTargets(db, null, SELECTION);
    assert.deepEqual(names(r), ['1', '2']);
    assert.equal(r.gated, false);
    cleanup();
  });

  test('sync_locked 的行任何情况下都不查', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1' });
    insertGame(db, { appid: '2', name: '手动维护的', syncLocked: 1 });
    assert.deepEqual(names(selectStatsTargets(db, null, SELECTION)), ['1']);
    const snap = new Map([['1', 1000], ['2', 9999]]);
    assert.deepEqual(names(selectStatsTargets(db, snap, SELECTION)), []);
    cleanup();
  });
});

describe('selectStatsTargets — rtime 闸门(achieved 的正确性)', () => {
  test('rtime 没动、刚查过 → 跳过', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 0 });
    const r = selectStatsTargets(db, new Map([['1', 1000]]), SELECTION);
    assert.deepEqual(names(r), []);
    cleanup();
  });

  test('rtime 前进了 → 查(你玩过了,achieved 可能变了)', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 0 });
    const r = selectStatsTargets(db, new Map([['1', 2000]]), SELECTION);
    assert.deepEqual(names(r), ['1']);
    assert.equal(r.played, 1);
    cleanup();
  });

  test('还没建立基线的行必须查,而且不受扫描预算限制', () => {
    const { db, cleanup } = freshDb();
    const snap = new Map();
    for (let i = 0; i < 60; i++) {
      insertGame(db, { appid: String(i), name: 'G' + i }); // last_played / stats_checked_at 都是 NULL
      snap.set(String(i), 500);
    }
    const r = selectStatsTargets(db, snap, SELECTION);
    assert.equal(r.targets.length, 60, '升级后第一次跑是一次全量,基线得先有');
    assert.equal(r.played, 60);
    cleanup();
  });

  test('查过但 last_played 是 NULL(比如当时不在 owned 里)→ 仍然查', () => {
    const { db, cleanup } = freshDb();
    insertGame(db, { appid: '1', name: 'G1' });
    markStatsChecked(db, '1', null); // 有 stats_checked_at,没有 last_played
    const r = selectStatsTargets(db, new Map([['1', 800]]), SELECTION);
    assert.deepEqual(names(r), ['1']);
    cleanup();
  });
});

describe('selectStatsTargets — 不在 owned 列表里的行', () => {
  test('拿不到 rtime → 每次都查,哪怕刚刚才查过', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 0 }); // 在 owned 里
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 0 }); // 家庭共享/已下架
    const r = selectStatsTargets(db, new Map([['1', 1000]]), SELECTION);
    assert.deepEqual(names(r), ['77'], '游戏能从 GetOwnedGames 消失但成就数据还在');
    assert.equal(r.unowned, 1);
    cleanup();
  });

  test('已经 100% 的 → 不再每次都查,交给轮换扫描', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 0, rate: 1 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), [], 'achieved 已经到顶,玩得再多也涨不上去');
    assert.equal(r.unowned, 0, '不该再算进「每次都查」那一组');
    cleanup();
  });

  test('100% 的用的是 perfectGameMaxAgeDays(3 天),不是 7 天', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 5, rate: 1 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77'], '5 天 > 3 天,该扫了');
    assert.equal(r.swept, 1, '走的是 sweep,不是 unowned');
    assert.equal(r.unowned, 0);
    // 反过来:2 天还不到期
    const { db: db2, cleanup: c2 } = freshDb();
    seedGame(db2, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 2, rate: 1 });
    assert.deepEqual(names(selectStatsTargets(db2, new Map(), SELECTION)), []);
    cleanup(); c2();
  });

  test('100% 但没有 stats_checked_at → 照查,不会被这条规则漏掉', () => {
    const { db, cleanup } = freshDb();
    insertGame(db, { appid: '77', name: '没基线的' });
    updateGameStats(db, '77', { achieved: 10, total: 10 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77'], 'ageDays(null) 是 Infinity,进池且排最前');
    cleanup();
  });

  test('没满的照旧每次都查 —— achieved 还在动,rtime 又拿不到', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '77', lastPlayed: 1000, checkedDaysAgo: 0, rate: 0.5 });
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77']);
    assert.equal(r.unowned, 1);
    cleanup();
  });

  // 跳过判断取两个条件里更严的那一侧:rate 万一是旧的,宁可白查几次,
  // 也不能把一个还在动的 achieved 冻上三天
  test('rate 说满了但 achieved !== total → 当作没满,留在每次都查里', () => {
    const { db, cleanup } = freshDb();
    insertGame(db, { appid: '77', name: 'rate 过时的' });
    updateGameStats(db, '77', { achieved: 5, total: 10 });
    // 只把 rate 改成 1,计数保持 5/10 —— setGameField 不让写 rate(注入闸门),走原始 SQL
    db.prepare('UPDATE games SET rate = 1, stats_checked_at = ? WHERE appid = ?').run(agoIso(0), '77');
    const r = selectStatsTargets(db, new Map(), SELECTION);
    assert.deepEqual(names(r), ['77'], '两个条件不一致时走安全的那一边');
    assert.equal(r.unowned, 1);
    cleanup();
  });
});

describe('selectStatsTargets — 轮换扫描(total 的兜底)', () => {
  test('超过 maxStatsAgeDays 没查过 → 排进扫描,哪怕根本没玩过', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 8 });
    const r = selectStatsTargets(db, new Map([['1', 1000]]), SELECTION);
    assert.deepEqual(names(r), ['1'], '开发者加成就不需要你玩,只能靠定期复查发现');
    assert.equal(r.swept, 1);
    cleanup();
  });

  test('没到期就不扫', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 6 });
    assert.deepEqual(names(selectStatsTargets(db, new Map([['1', 1000]]), SELECTION)), []);
    cleanup();
  });

  test('预算封顶,超期最多的先扫,剩下的记进 sweepPending 等下次', () => {
    const { db, cleanup } = freshDb();
    const snap = new Map();
    for (let i = 0; i < 10; i++) {
      seedGame(db, { appid: String(i), lastPlayed: 1000, checkedDaysAgo: 10 + i });
      snap.set(String(i), 1000);
    }
    const r = selectStatsTargets(db, snap, { ...SELECTION, sweepBudget: 3 });
    assert.equal(r.swept, 3);
    assert.equal(r.sweepPending, 7);
    // 期限都一样(都不是完美游戏)时,超期倍数排序就退化成按最旧排 → 9/8/7
    assert.deepEqual(names(r), ['7', '8', '9']);
    cleanup();
  });

  test('排序按"超期倍数"而不是绝对时间 —— 否则 3 天那条期限形同虚设', () => {
    const { db, cleanup } = freshDb();
    // 完美游戏超期 4/3 = 1.33 倍;普通游戏超期 8/7 = 1.14 倍。虽然后者绝对时间更久,
    // 但前者更对不起自己的期限,应该先扫
    seedGame(db, { appid: 'perfect', lastPlayed: 1000, checkedDaysAgo: 4, rate: 1 });
    seedGame(db, { appid: 'normal', lastPlayed: 1000, checkedDaysAgo: 8, rate: 0.5 });
    const snap = new Map([['perfect', 1000], ['normal', 1000]]);
    const r = selectStatsTargets(db, snap, { ...SELECTION, sweepBudget: 1 });
    assert.deepEqual(names(r), ['perfect']);
    cleanup();
  });

  test('sweepBudget=0 → 关掉轮换扫描,只剩 rtime 闸门', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 99 });
    const r = selectStatsTargets(db, new Map([['1', 1000]]), { ...SELECTION, sweepBudget: 0 });
    assert.deepEqual(names(r), []);
    assert.equal(r.sweepPending, 1, '关掉了也要如实报还有多少排队');
    cleanup();
  });

  test('完美游戏用更短的过期时间(3 天),普通游戏还没到期', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000, checkedDaysAgo: 4, rate: 1 }); // 100%
    seedGame(db, { appid: '2', lastPlayed: 1000, checkedDaysAgo: 4, rate: 0.5 });
    const r = selectStatsTargets(db, new Map([['1', 1000], ['2', 1000]]), SELECTION);
    assert.deepEqual(names(r), ['1'], '成就总数变多会让 100% 掉下来,要扫得更勤');
    cleanup();
  });
});

describe('markStatsChecked', () => {
  test('拿不到 rtime 时传 null,不会抹掉已有的 last_played', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 4242, checkedDaysAgo: 5 });
    markStatsChecked(db, '1', null);
    const row = db.prepare('SELECT * FROM games WHERE appid = ?').get('1');
    assert.equal(row.last_played, 4242);
    assert.ok(row.stats_checked_at > agoIso(1), 'stats_checked_at 应该被刷新到现在');
    cleanup();
  });

  test('不碰 updated_at —— 查过发现没变不算数据变了', () => {
    const { db, cleanup } = freshDb();
    seedGame(db, { appid: '1', lastPlayed: 1000 });
    setGameField(db, '1', 'favorite', 1);
    const before = db.prepare('SELECT updated_at FROM games WHERE appid = ?').get('1').updated_at;
    markStatsChecked(db, '1', 1000);
    const after = db.prepare('SELECT updated_at FROM games WHERE appid = ?').get('1').updated_at;
    assert.equal(after, before);
    cleanup();
  });
});
