/**
 * 自动 checkbox 勾选的候选规则 + gained 标记
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 锁的是"打开 Dashboard 那次自动勾选会去读哪些攻略页"。这一层两个方向都会静默出错,
 * 而且都不报异常:
 *
 * - **放宽** → 每次打开 Dashboard 白烧几十次 Notion 页面读 + 几十次 Steam 调用。
 *   功能看起来完全正常,只是慢、只是费,不看日志根本发现不了。
 * - **收紧** → 该勾的框不勾,而 checkbox 同步本来就只勾不取消,漏掉就一直漏着。
 *
 * 最要命的一条是 `appids: []`:空数组必须表示"一款都不跑"。任何把它当成 falsy
 * 退回全量的写法(`appids?.length ? … : 全部`)都会把最常见的情况——这次打开
 * 什么都没变——翻译成全量扫描,定向同步直接失效。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, insertGame, upsertGuide, updateGameStats, replaceAchievements,
} from '../lib/db.js';
import { selectCheckboxCandidates } from '../lib/guides.js';

const freshDb = () => openDb(':memory:');

/** 一行"有攻略、有成就系统、还没打满"的普通候选 */
function seedGame(db, { appid, name = 'G' + appid, achieved = 5, total = 10, guide = true }) {
  insertGame(db, { appid, name });
  if (total !== null) updateGameStats(db, appid, { achieved, total });
  if (guide) upsertGuide(db, { appid, name, url: 'https://notion.so/' + appid, kind: 'notion' });
}

/** 给某个 appid 塞一条成就详情(100% 游戏要靠它才可能进候选) */
function seedAchievement(db, appid) {
  replaceAchievements(db, appid, [
    {
      apiName: 'ACH_1', gameName: 'G' + appid, nameCn: '成就一',
      nameEn: 'Ach One', description: '描述', hidden: false, icon: '',
    },
  ]);
}

const ids = (db, opts) => selectCheckboxCandidates(db, opts).games.map((g) => g.appid).sort();

describe('selectCheckboxCandidates — 基础条件', () => {
  test('没登记攻略的游戏不进候选', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2', guide: false });
    assert.deepEqual(ids(db), ['1']);
  });

  test('没有成就系统的游戏不进候选(total 是 NULL)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2', total: null });
    assert.deepEqual(ids(db), ['1']);
  });

  test('已经 100% 的游戏:不联动子步骤时直接跳过', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2', achieved: 10, total: 10 });
    seedAchievement(db, '2');
    assert.deepEqual(ids(db, { cascade: false }), ['1']);
  });

  test('已经 100% 且有成就详情:联动开着时进候选(子步骤可能还空着)', () => {
    const db = freshDb();
    seedGame(db, { appid: '2', achieved: 10, total: 10 });
    seedAchievement(db, '2');
    assert.deepEqual(ids(db, { cascade: true }), ['2']);
  });

  test('已经 100% 但没有成就详情:联动开着也不进——认不出父成就,读了也白读', () => {
    const db = freshDb();
    seedGame(db, { appid: '2', achieved: 10, total: 10 });
    assert.deepEqual(ids(db, { cascade: true }), []);
  });
});

describe('selectCheckboxCandidates — 刚刚打满的游戏', () => {
  // 这一组锁的是一个很容易漏的洞:"让游戏通关的那个成就",它的框如果只靠
  // 100%-跳过规则来判断,就**永远**勾不上——等下一轮来看时游戏已经是 100%,
  // 直接被挡在候选之外。点名进来(appids 白名单)意味着"这一行这轮刚变过",
  // 那它就是刚打满的,最后几个框八成还空着。
  test('这轮点名进来的 100% 游戏:不联动子步骤也要进(最后那个成就的框还空着)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', achieved: 10, total: 10 });
    seedAchievement(db, '1');
    assert.deepEqual(ids(db, { appids: ['1'], cascade: false }), ['1']);
  });

  test('没点名的 100% 游戏,不联动时照旧跳过(CLI 全量 --no-cascade 的行为不变)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', achieved: 10, total: 10 });
    seedAchievement(db, '1');
    assert.deepEqual(ids(db, { appids: null, cascade: false }), []);
  });

  test('点名了但没有成就详情:还是不进——55/55 那批白读的闸门不能被绕过', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', achieved: 10, total: 10 });
    assert.deepEqual(ids(db, { appids: ['1'], cascade: false }), []);
  });
});

describe('selectCheckboxCandidates — appids 白名单(serve 的定向勾选)', () => {
  test('不传 appids(null)→ 不限制,所有符合条件的都进', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    assert.deepEqual(ids(db, { appids: null }), ['1', '2']);
  });

  test('**空数组 = 一款都不跑**,不是"不限制" —— 这次打开没有变化就该零外部调用', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    assert.deepEqual(ids(db, { appids: [] }), []);
  });

  test('只跑白名单里的行', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    seedGame(db, { appid: '3' });
    assert.deepEqual(ids(db, { appids: ['1', '3'] }), ['1', '3']);
  });

  test('白名单里的数字 appid 也认(appid 列是 TEXT,来源不一定是字符串)', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    assert.deepEqual(ids(db, { appids: [1] }), ['1']);
  });

  test('白名单不能绕过基础条件:没攻略的行进了白名单也不读', () => {
    const db = freshDb();
    seedGame(db, { appid: '1', guide: false });
    assert.deepEqual(ids(db, { appids: ['1'] }), []);
  });

  test('CLI 的单个 appid 参数照旧有效,和 appids 互不干扰', () => {
    const db = freshDb();
    seedGame(db, { appid: '1' });
    seedGame(db, { appid: '2' });
    assert.deepEqual(ids(db, { appid: '2' }), ['2']);
  });
});

describe('updateGameStats — gained 标记(定向勾选的输入)', () => {
  test('解锁数变多 → gained', () => {
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 3, total: 10 });
    const r = updateGameStats(db, '1', { achieved: 4, total: 10 });
    assert.equal(r.gained, true);
    assert.equal(r.bumped, false);
  });

  test('解锁数没变 → 不是候选', () => {
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 3, total: 10 });
    assert.equal(updateGameStats(db, '1', { achieved: 3, total: 10 }).gained, false);
  });

  test('第一次同步这一行(没有基线)→ gained 是 false', () => {
    // 这条是防止定向勾选退化成全量的关键:首次同步时整库每一行的 achieved 都是
    // NULL→数字,当成"变多了"的话几百行会一起变成候选,把省下来的调用又全花回去
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    assert.equal(updateGameStats(db, '1', { achieved: 7, total: 10 }).gained, false);
  });

  test('只有 total 变多(开发者加了新成就)→ bumped,但没新解锁', () => {
    const db = freshDb();
    insertGame(db, { appid: '1', name: 'G' });
    updateGameStats(db, '1', { achieved: 10, total: 10 });
    const r = updateGameStats(db, '1', { achieved: 10, total: 12 });
    assert.equal(r.bumped, true);
    assert.equal(r.gained, false);
  });
});
