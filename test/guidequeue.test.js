/**
 * 攻略生成的排队
 * ------------------------------------------------
 * 这个文件保的是**任务静默消失**和**队列卡死**两件事。
 *
 * 生成一份攻略要 2–4 分钟,所以「排了三个然后去干别的」是真实用法。而这条路上的
 * 失败全都不出声:任务被悄悄丢掉、队列在某个失败之后再也不往下走、同一款游戏被排
 * 两次于是写两遍 —— 没有一个会报错,只会让人过二十分钟回来发现事情没做。
 *
 * 原来的行为是**拒绝**第二个(`{error: '已经有一个攻略在生成了'}`),而那条错误
 * 会在 3 秒后被轮询用正在跑的那个游戏名覆盖掉 —— 从用户的位置看就是「点了没反应」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createGuideGenState } from '../lib/server.js';

describe('队列的基本语义', () => {
  test('空闲时队列是空的,快照里带着它', () => {
    const s = createGuideGenState();
    assert.deepEqual(s.snapshot().queue, []);
    assert.equal(s.queueLength(), 0);
  });

  test('入队返回的是位置,先进先出', () => {
    const s = createGuideGenState();
    assert.equal(s.enqueue({ appid: '1', game: 'A' }), 1);
    assert.equal(s.enqueue({ appid: '2', game: 'B' }), 2);
    assert.equal(s.dequeue().appid, '1');
    assert.equal(s.dequeue().appid, '2');
    assert.equal(s.dequeue(), null, '空队列要返回 null,不能是 undefined —— 调用方靠它判断该不该继续');
  });

  test('队列跟着 snapshot 一起交出去 —— 页面要显示「还有几个排队」', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: '空之轨迹', overwrite: true });
    const snap = s.snapshot();
    assert.deepEqual(snap.queue, [{ appid: '1', game: '空之轨迹' }]);
    // overwrite 是调度用的,不该漏给前端 —— 页面上没有它的用处
    assert.equal('overwrite' in snap.queue[0], false);
  });

  test('snapshot 的队列是拷贝,外面改不动内部状态', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    s.snapshot().queue.push({ appid: '999', game: '假的' });
    assert.equal(s.queueLength(), 1);
  });
});

describe('isPending —— 挡住重复点击', () => {
  test('正在跑的那一款算 pending', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    assert.equal(s.isPending('1'), true);
    assert.equal(s.isPending('2'), false);
  });

  test('排在队列里的也算 pending', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.enqueue({ appid: '2', game: 'B' });
    assert.equal(s.isPending('2'), true);
  });

  test('appid 是数字还是字符串都认得 —— 前端传的是字符串,库里也是', () => {
    const s = createGuideGenState();
    s.begin(1, 'A', 3);
    assert.equal(s.isPending('1'), true);
    s.enqueue({ appid: 2, game: 'B' });
    assert.equal(s.isPending('2'), true);
  });

  test('跑完之后那一款不再算 pending —— 否则重试一次都不行', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.end(null, { ok: true });
    assert.equal(s.isPending('1'), false);
  });
});

describe('失败不能卡死队列', () => {
  test('一个失败之后,后面的还取得出来', () => {
    // 这是最要紧的一条:drainNext 必须挂在 .then 和 .catch 两边。
    // 只挂 .then 的话,一次失败就让后面排着的永远等下去,而且**不报错**
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.enqueue({ appid: '2', game: 'B' });
    s.end(new Error('供应商挂了'));
    assert.equal(s.snapshot().error, '供应商挂了');
    assert.equal(s.dequeue().appid, '2', '前一个失败了,后面那个照样要能开跑');
  });

  test('整体故障时清空队列,并把清掉的交出去 —— 不能静默消失', () => {
    const s = createGuideGenState();
    s.enqueue({ appid: '1', game: 'A' });
    s.enqueue({ appid: '2', game: 'B' });
    const dropped = s.clearQueue();
    assert.deepEqual(dropped.map((d) => d.game), ['A', 'B'],
      '要把丢掉的还回去,调用方才能把「取消了哪几个」写进日志');
    assert.equal(s.queueLength(), 0);
  });
});

describe('取下一个的接线', () => {
  /**
   * **源码断言,不是行为测试。**
   *
   * 「跑完接下一个」这段挂在 `runGuideGen` 里、住在 `serve()` 的闭包中,单测够不着 ——
   * 而它恰好是这条路上最危险的一处:`drainNext()` 只挂在 `.then` 上的话,一次生成失败
   * 就让后面排着的全部永远等下去,**不报错、不超时、什么都不会发生**。
   *
   * 上面那条「失败不能卡死队列」测的是状态模块本身,`dequeue()` 无论接线对不对都能过。
   * 所以真正保这件事的是下面这一条。
   */
  test('drainNext 必须同时挂在 .then 和 .catch 上', () => {
    const src = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8');
    const start = src.indexOf('const drainNext');
    assert.ok(start > 0, '找不到 drainNext —— 这条检查失去了目标,不是通过了');
    // **切到「我要看的那一段」,而不是往后数 2600 个字符。**
    //
    // 原来就是那个字节数,而 2026-08-17 给 onProgress 多接了三个进度相之后,
    // `.then` 被推到了窗口外面 —— 报的是"找不到 then/catch",而 then/catch 明明在。
    // 一条按字节数取范围的源码断言,会随着它守的那个函数长大而慢慢瞄不准:
    // 往大调只是把同一个雷挪远一点,而危险的方向是反过来 —— 窗口恰好还罩得住
    // 两个标记、中间的代码却已经变了。锚点用真实存在的代码,少了就当场报错
    const end = src.indexOf('return { started: true', start);
    assert.ok(end > start, '找不到 runGuideGen 的收尾 —— 锚点没了,这条检查该重写而不是放宽');
    const body = src.slice(start, end);
    const thenIdx = body.indexOf('.then((r) =>');
    const catchIdx = body.indexOf('.catch((err) =>');
    assert.ok(thenIdx > 0 && catchIdx > thenIdx, '找不到 generateGuide 的 then/catch');
    assert.match(body.slice(thenIdx, catchIdx), /drainNext\(\)/, '.then 里没有取下一个');
    assert.match(body.slice(catchIdx), /drainNext\(\)/,
      '.catch 里没有取下一个 —— 一次失败会把整条队列永久卡住,而且完全不出声');
  });
});

describe('begin 不会清掉队列', () => {
  test('开跑下一个时,还没轮到的那些必须留着', () => {
    // begin() 是 `{ ...idle, ... }`,而 idle 里没有 queue —— 队列要是也放在
    // 那个对象里,每开跑一个就会把剩下的全抹掉,表现是「排了五个只跑了两个」
    const s = createGuideGenState();
    s.enqueue({ appid: '2', game: 'B' });
    s.enqueue({ appid: '3', game: 'C' });
    s.begin('1', 'A', 3);
    assert.equal(s.queueLength(), 2, 'begin() 把队列一起重置了');
    s.end(null, { ok: true });
    s.begin('2', 'B', 3);
    assert.equal(s.queueLength(), 2);
  });
});
