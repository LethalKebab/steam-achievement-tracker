/**
 * 铃铛的两类通知
 * ------------------------------------------------
 * 保的是一类**没有第二次机会**的失败:这两件事都是跃迁,而 `updateGameStats` 的
 * 那条 UPDATE 一旦跑过,旧值就没了 —— 判定错、或者压根没判,当前状态里再也
 * 找不回来。表现出来不是报错,是铃铛永远空着,而用户以为"最近确实没事发生"。
 *
 * 这也是这个项目里**唯一一处刻意做跃迁检测**的地方,和 `guide-status` 那条
 * 「只收敛当前状态、不检测跃迁」的规矩正好相反。区别在于问题本身:那边问
 * "这一页现在该是什么状态"(当前状态就够),这边问"最近发生了什么"(当前状态
 * 根本答不出来 —— 一个掉出 100% 的游戏,和一个从来没打满过的游戏,长得一模一样)。
 *
 * 三条边界最容易写错,都在下面钉着:
 *
 *  1. **没打满时被补成就不算第一类。** 那是家常便饭,报出来就是狼来了。
 *  2. **`has_achievements` 是 NULL 不算第二类。** NULL 是"这一行还没同步过",
 *     不是"这游戏加了成就"。搞混的话第一次全量同步会把整个库塞进铃铛。
 *  3. **再次发生要刷新时间戳,不是留着第一次的。** 铃铛按"多少天前"筛,
 *     留旧值会让一件刚发生的事显示成三个月前,然后被筛掉。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertGame, updateGameStats, markNoAchievements, getGame } from '../lib/db.js';

const fresh = () => openDb(':memory:');

/** 建一行并给它一个基线状态 */
function seeded(db, appid, { achieved, total }) {
  insertGame(db, { appid, name: 'G' + appid });
  if (achieved !== undefined) updateGameStats(db, appid, { achieved, total });
  return appid;
}

describe('打满之后被开发者补了成就(第一类)', () => {
  test('10/10 → 10/12 触发,并落盘', () => {
    const db = fresh();
    seeded(db, '1', { achieved: 10, total: 10 });
    const r = updateGameStats(db, '1', { achieved: 10, total: 12 });
    assert.equal(r.perfectLost, true);
    assert.ok(getGame(db, '1').perfect_lost_date, '判定对了但没落盘 —— 下次就找不回来了');
  });

  test('没打满时被补成就不触发 —— 那是常事,报出来就是狼来了', () => {
    const db = fresh();
    seeded(db, '2', { achieved: 3, total: 10 });
    assert.equal(updateGameStats(db, '2', { achieved: 3, total: 12 }).perfectLost, false);
  });

  test('第一次同步这一行不触发(没有基线就没有"之前")', () => {
    const db = fresh();
    insertGame(db, { appid: '3', name: 'G3' });
    assert.equal(updateGameStats(db, '3', { achieved: 5, total: 10 }).perfectLost, false);
  });

  test('总数没变就不触发,哪怕正好打满', () => {
    const db = fresh();
    seeded(db, '4', { achieved: 10, total: 10 });
    assert.equal(updateGameStats(db, '4', { achieved: 10, total: 10 }).perfectLost, false);
  });

  test('再次发生会刷新时间戳,不是留着第一次的', () => {
    const db = fresh();
    seeded(db, '5', { achieved: 10, total: 10 });
    updateGameStats(db, '5', { achieved: 10, total: 12 });

    // 把时间戳按回一个明显陈旧的值再触发第二次。**不能直接比两次真实写入** ——
    // 它们可能落在同一毫秒,`nowIso()` 给出一模一样的字符串,于是断言"变了"会假失败,
    // 而产品行为其实完全正确。这条测试自己踩过一次
    const OLD = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE games SET perfect_lost_date = ? WHERE appid = ?').run(OLD, '5');

    // 中间这一步总数没变,不该动它 —— 顺带把 COALESCE 的保留语义也钉住
    updateGameStats(db, '5', { achieved: 12, total: 12 });
    assert.equal(getGame(db, '5').perfect_lost_date, OLD, '没有新事件时不该动已有的时间戳');

    // 再被补一次成就 → 必须刷新
    updateGameStats(db, '5', { achieved: 12, total: 15 });
    assert.notEqual(
      getGame(db, '5').perfect_lost_date, OLD,
      '留着旧时间戳的话,刚发生的事会显示成很久以前,然后被 30 天窗口筛掉'
    );
  });
});

describe('以前没有成就系统,现在有了(第二类)', () => {
  test('has_achievements 0 → 1 触发,并落盘', () => {
    const db = fresh();
    insertGame(db, { appid: '6', name: 'G6' });
    markNoAchievements(db, '6');
    const r = updateGameStats(db, '6', { achieved: 0, total: 5 });
    assert.equal(r.achAdded, true);
    assert.ok(getGame(db, '6').ach_added_date);
  });

  test('has_achievements 是 NULL 不触发 —— NULL 是"还没同步过",不是"加了成就"', () => {
    const db = fresh();
    insertGame(db, { appid: '7', name: 'G7' });
    // 这一条要是反了,第一次全量同步会把整个库塞进铃铛
    assert.equal(updateGameStats(db, '7', { achieved: 1, total: 5 }).achAdded, false);
  });

  test('本来就有成就的行不触发', () => {
    const db = fresh();
    seeded(db, '8', { achieved: 1, total: 5 });
    assert.equal(updateGameStats(db, '8', { achieved: 2, total: 5 }).achAdded, false);
  });
});

describe('两类互不干扰', () => {
  test('一次同步里只该命中它自己那一类', () => {
    const db = fresh();
    seeded(db, '9', { achieved: 10, total: 10 });
    const r = updateGameStats(db, '9', { achieved: 10, total: 12 });
    assert.equal(r.perfectLost, true);
    assert.equal(r.achAdded, false);

    insertGame(db, { appid: '10', name: 'G10' });
    markNoAchievements(db, '10');
    const r2 = updateGameStats(db, '10', { achieved: 0, total: 5 });
    assert.equal(r2.achAdded, true);
    assert.equal(r2.perfectLost, false);
  });

  test('已有的 bumped / gained 语义没被动到', () => {
    const db = fresh();
    seeded(db, '11', { achieved: 3, total: 10 });
    const r = updateGameStats(db, '11', { achieved: 5, total: 12 });
    assert.equal(r.bumped, true);
    assert.equal(r.gained, true);
  });
});
