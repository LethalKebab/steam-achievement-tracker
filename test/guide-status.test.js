/**
 * 攻略页状态收敛(打满 → Done)的规则
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这一层的设计要点是**按当前状态判断,不按"这一轮刚好打满"**。
 * 100% 那个瞬间只在 updateGameStats 写的那一下存在,任何一次没写成
 * (跑同步的机器没配 Notion、进程中断、token 过期)这条变化就永远补不回来了:
 * 下次再看,旧值和新值都是 100%,推不出任何东西。
 *
 * 所以下面每条用例都只喂"当前状态",不喂任何变化历史 —— 这本身就是在钉住那个设计。
 * 跑两次结果必须一样(幂等),否则重复打开 Dashboard 就会重复写 Notion。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertGame, upsertGuide, updateGameStats } from '../lib/db.js';
import { selectGuideStatusUpdates, GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED } from '../lib/guides.js';

const freshDb = () => openDb(':memory:');
const PAGE = (n) => `3af1fee6252b8073883ecea59b4d83${String(n).padStart(2, '0')}`;

/** 一行游戏 + 它的 Notion 攻略页 */
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

describe('selectGuideStatusUpdates — 基本判据', () => {
  test('打满了且还不是 Done → 要改', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    const r = selectGuideStatusUpdates(db, [pageRow('1', 'Staged')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].from, 'Staged');
    assert.equal(r[0].to, GUIDE_STATUS_DONE);
  });

  test('还没打满 → 不动,哪怕只差一个成就', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 9, total: 10 });
    assert.deepEqual(targets(db, [pageRow('1', 'In progress')]), []);
  });

  test('已经是 Done → 不动(幂等:再跑一次不会重复写)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    assert.deepEqual(targets(db, [pageRow('1', 'Done')]), []);
  });

  test('状态是空的也照改', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    assert.deepEqual(targets(db, [pageRow('1', null)]), ['1']);
  });
});

describe('selectGuideStatusUpdates — 覆盖哪些状态', () => {
  // 按用户的选择:除了 Done 本身,其余一律覆盖,包括 Notion 归在"完成"组里的 Differed。
  // 判据是完成度,不是人工标记的工作流状态。
  for (const from of ['Not started', 'Staged', 'In progress', 'Paused', 'Differed']) {
    test(`${from} → Done`, () => {
      const db = freshDb();
      seed(db, { appid: '1', achieved: 10, total: 10 });
      assert.deepEqual(targets(db, [pageRow('1', from)]), ['1']);
    });
  }
});

describe('selectGuideStatusUpdates — 不该碰的', () => {
  test('没有成就系统的游戏(total 是 NULL)→ 不动', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: null, total: null });
    assert.deepEqual(targets(db, [pageRow('1', 'Paused')]), []);
  });

  test('本地 markdown 攻略 → 不动(没有状态属性这回事)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10, kind: 'local' });
    assert.deepEqual(targets(db, [pageRow('1', 'Paused')]), []);
  });

  test('攻略页还没登记 appid(攻略没写完)→ 不动', () => {
    const db = freshDb();
    assert.deepEqual(targets(db, [pageRow('99', 'Not started')]), []);
  });

  test('页面身份按规范化 ID 比,URL 带标题 slug 也认得出', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    // Notion 有时会在 URL 里塞标题前缀,同一页两次查询拿到的文本不一样
    const slugged = { id: PAGE('1'), title: 'G1', url: 'https://app.notion.com/My-Game-' + PAGE('1'), status: 'Paused' };
    assert.deepEqual(targets(db, [slugged]), ['1']);
  });

  test('多个页面时只挑该改的那些', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    seed(db, { appid: '2', achieved: 5, total: 10 });
    seed(db, { appid: '3', achieved: 7, total: 7 });
    const pages = [pageRow('1', 'Paused'), pageRow('2', 'Paused'), pageRow('3', 'Done')];
    assert.deepEqual(targets(db, pages), ['1']);
  });
});

describe('selectGuideStatusUpdates — 掉出 100% 退回 Staged', () => {
  // 开发者打补丁加新成就,会把满成就的游戏顶下 100%。这是唯一一种"你不玩也会发生"
  // 的变化,页面停在 Done 就等于把它藏起来了。
  test('Done 但已经不到 100% → 退回 Staged', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 28, total: 51 });
    const r = selectGuideStatusUpdates(db, [pageRow('1', 'Done')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].from, GUIDE_STATUS_DONE);
    assert.equal(r[0].to, GUIDE_STATUS_STAGED);
    assert.equal(r[0].reason, 'incomplete');
  });

  test('退回之后再跑一次不再动它(幂等,不会和人来回改)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 28, total: 51 });
    assert.deepEqual(targets(db, [pageRow('1', GUIDE_STATUS_STAGED)]), []);
  });

  // 回退方向**只动 Done**。不到 100% 的其它状态都是人自己排的工作流,
  // 每次打开 Dashboard 都覆盖一遍的话,人跟机器会一直互相改。
  for (const from of ['Not started', 'Staged', 'In progress', 'Paused', 'Differed']) {
    test(`不到 100% 且状态是 ${from} → 不动`, () => {
      const db = freshDb();
      seed(db, { appid: '1', achieved: 5, total: 10 });
      assert.deepEqual(targets(db, [pageRow('1', from)]), []);
    });
  }

  test('total 被清成 NULL(Steam 说没有成就系统)→ 不动,不算掉出 100%', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: null, total: null });
    assert.deepEqual(targets(db, [pageRow('1', 'Done')]), []);
  });

  test('两个方向可以同一轮一起发生,互不干扰', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 }); // 打满了,还是 Paused
    seed(db, { appid: '2', achieved: 28, total: 51 }); // 掉出 100%,还挂着 Done
    const r = selectGuideStatusUpdates(db, [pageRow('1', 'Paused'), pageRow('2', 'Done')]);
    assert.deepEqual(
      r.map((u) => `${u.appid}:${u.from}→${u.to}`).sort(),
      ['1:Paused→Done', '2:Done→Staged']
    );
  });

  test('两条规则互斥,同一页不可能同时命中(不会来回翻)', () => {
    const db = freshDb();
    seed(db, { appid: '1', achieved: 10, total: 10 });
    // 打满 + 已经是 Done → 完全不动
    assert.deepEqual(targets(db, [pageRow('1', GUIDE_STATUS_DONE)]), []);
  });
});
