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
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGuideGenState, serve } from '../lib/server.js';
import { openDb, insertGame, replaceAchievements } from '../lib/db.js';

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

/**
 * 认领 —— 挡住「同一款被放行两次」
 * ------------------------------------------------------------------
 * `isPending` 只看 `running` 和 `queue`,而从「决定要生成这一款」到 `begin()`
 * 之间隔着预检(`planGuide` 会打两次 Steam)和建供应商,两个都是 await。
 * 那段时间里这一款既不在跑也不在队列里 —— 于是第二次点击看到一片空白、照样通过。
 *
 * 实测:steam 调用带 200 ms 延迟(真实网络就是这个量级),同时发两次
 * `startGuideGen`,一个 `started: true`、另一个 `queued: position 1` —— 同一款
 * 游戏生成两遍,钱付两遍。而 `startBackgroundSync` 那条路没有这个问题,
 * 因为它的检查和 `begin()` 是**贴在一起的同步两行**。
 */
describe('认领:检查和占位必须在同一个同步块里', () => {
  test('认领得到就返回 true,并且立刻算 pending', () => {
    const s = createGuideGenState();
    assert.equal(s.isPending('1'), false);
    assert.equal(s.claim('1'), true);
    assert.equal(s.isPending('1'), true, '认领之后不算 pending —— 那这个认领没有任何作用');
  });

  test('**第二次认领同一个拿不到** —— 这是整件事的全部', () => {
    const s = createGuideGenState();
    assert.equal(s.claim('1'), true);
    assert.equal(s.claim('1'), false);
  });

  test('别的 appid 不受影响 —— 认领是按 appid,不是一把全局锁', () => {
    const s = createGuideGenState();
    assert.equal(s.claim('1'), true);
    assert.equal(s.claim('2'), true, '认领了一个就挡住别的,等于把队列废掉了');
  });

  test('数字和字符串是同一个 —— 前端传字符串,库里也是', () => {
    const s = createGuideGenState();
    assert.equal(s.claim(730), true);
    assert.equal(s.claim('730'), false);
  });

  test('放开之后可以再认领 —— 失败重试一次都不行的话比放行两次还糟', () => {
    const s = createGuideGenState();
    s.claim('1');
    s.release('1');
    assert.equal(s.isPending('1'), false);
    assert.equal(s.claim('1'), true);
  });

  test('正在跑的认领不到', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    assert.equal(s.claim('1'), false);
  });

  test('排在队列里的也认领不到', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.enqueue({ appid: '2', game: 'B' });
    assert.equal(s.claim('2'), false);
  });

  test('**放开认领之后,队列自己接着让它算 pending**', () => {
    // 这是 startGuideGen 的 finally 敢无条件 release 的前提:入队之后
    // queue 顶上了,不会出现"放开了但还没人接手"的空档
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.claim('2');
    s.enqueue({ appid: '2', game: 'B' });
    s.release('2');
    assert.equal(s.isPending('2'), true, '放开认领之后这一款变成谁都能再排一次');
  });

  test('begin() 之后放开认领,仍然算 pending', () => {
    const s = createGuideGenState();
    s.claim('1');
    s.begin('1', 'A', 3);
    s.release('1');
    assert.equal(s.isPending('1'), true);
  });

  /**
   * **源码断言。** 上面那些证明状态模块是对的,但真正出事的是**调用方的写法** ——
   * 「先 isPending 再 await 再开跑」用一个正确的 `isPending` 照样漏。
   */
  test('startGuideGen 用的是 claim,而且 claim 和第一个 await 之间没有别的 await', () => {
    const src = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const start = src.indexOf('async function startGuideGen(');
    assert.ok(start > 0, '找不到 startGuideGen —— 这条检查失去了目标');
    const end = src.indexOf('async function startGuideGenClaimed(', start);
    assert.ok(end > start, '找不到 startGuideGenClaimed —— 锚点没了,该重写而不是放宽');
    const body = src.slice(start, end);

    assert.match(body, /guideGenState\.claim\(appid\)/,
      '闸门不是 claim —— 只查不占的话两次点击会一起通过');
    assert.doesNotMatch(body, /guideGenState\.isPending\(/,
      '还在用 isPending 当闸门:它不占位,两次点击都能过');
    // 认领**之前**只允许有同步代码。有 await 就说明占位晚于某次让出事件循环
    const claimIdx = body.indexOf('guideGenState.claim(appid)');
    assert.doesNotMatch(body.slice(0, claimIdx), /\bawait\b/,
      '认领之前就 await 了 —— 那段时间里第二次点击什么都看不见');
    assert.match(body, /finally\s*\{[\s\S]*guideGenState\.release\(appid\)/,
      'release 不在 finally 里 —— 预检抛异常就再也生成不了这一款了');
  });
});

/**
 * 端到端:真起一个服务器,同时点两次。
 *
 * 上面那些测的是零件和写法,这一条测的是**这个 bug 本来的样子** —— 它就是这么
 * 被发现的。关键是 steam 的两个调用带延迟:不带延迟时两个 HTTP 请求会被连接
 * 建立的时序自然错开,第一个已经 `begin()` 了第二个才进来,于是**漏洞测不出来**。
 * 真实的 `fetchPlayerAchievements` / `fetchGlobalAchievementPercentages` 是两次
 * 跨公网往返,200 ms 是保守估计。
 */
describe('端到端:同时点两次同一款', () => {
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
        // **故意配一个建不起来的供应商**(模型名和厂商对不上,`assertModelMatchesProvider`
        // 当场抛),这样闸门后面那一步就地失败,**一个网络请求都不会发出去**。
        // 用一把能建起来的假 key 会让生成真的开跑、真的去连 api.anthropic.com,
        // 而那次请求会在测试拆完 db 之后才落地 —— 一条没人接的 rejection。
        // 这条测试要看的只有一件事:**闸门放行了几次**
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
   * **判据是「有几个拿到了去重那句话」,不是「有几个 started」。**
   *
   * 闸门后面那一步会失败(供应商是故意配坏的),所以放行的那个也返回
   * `started: false`,只是错误内容不同。用 `started` 当判据的话,坏掉的闸门
   * (两个都放行、两个都撞供应商)和好的闸门看起来一模一样 —— 那条断言
   * 测的是供应商,不是去重。**恰好一个被挡**才是这件事本身。
   */
  const dedupCount = (rs) =>
    rs.filter((x) => /已经在生成或排队/.test(String(x.result?.error ?? ''))).length;

  test('**同时点两次,恰好一个被去重挡下**', async () => {
    const { start, cleanup } = await boot();
    try {
      const rs = await Promise.all([start(), start()]);
      assert.equal(
        dedupCount(rs), 1,
        `被挡下的有 ${dedupCount(rs)} 个,应该恰好 1 个 —— 0 个意味着同一款放行了两次` +
        `(生成跑两遍、钱付两遍)。A=${JSON.stringify(rs[0].result)} B=${JSON.stringify(rs[1].result)}`
      );
    } finally {
      cleanup();
    }
  });

  test('同时点三次,挡下两个', async () => {
    const { start, cleanup } = await boot();
    try {
      const rs = await Promise.all([start(), start(), start()]);
      assert.equal(dedupCount(rs), 2, `三次并发只挡下 ${dedupCount(rs)} 个`);
    } finally {
      cleanup();
    }
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

describe('begin 也不能抹掉上一个的结果', () => {
  /**
   * 排队生成时,一个跑完到下一个 `begin()` 之间只隔着 `drainNext()` 和
   * `createProvider()` 的一次动态 import(已缓存、不联网)—— 一个微任务。
   * 页面三秒轮询一次,所以 `state.result` 里那份结果**基本不可能被看到**:
   * 表现是排了五个,只有最后一个的结果露过面,前四个的攻略链接不出现、
   * 那四行的按钮一直灰着,看起来像"生成完了但界面不刷新"。
   *
   * 所以跑完的结果必须活在 state 外面。和 queue 同一个理由,只是更硬 ——
   * queue 少一个是"漏跑",这个少一条是"跑了但没人知道"。
   */
  test('下一个开跑之后,上一个的结果还在', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.end(null, { ok: true, covered: 12, total: 12 });
    s.begin('2', 'B', 3);
    assert.equal(s.snapshot().result, null, 'state.result 本来就该被 begin 重置');
    const done = s.snapshot().finished;
    assert.equal(done.length, 1, 'begin() 把上一个的结果一起抹掉了');
    assert.equal(done[0].game, 'A');
    assert.equal(done[0].appid, '1');
    assert.equal(done[0].result.covered, 12);
  });

  test('失败也要进去 —— 那一行同样要解除置灰', () => {
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.end(new Error('供应商 500'));
    s.begin('2', 'B', 3);
    const done = s.snapshot().finished;
    assert.equal(done.length, 1, '失败的那条漏掉,那一行会一直灰着');
    assert.equal(done[0].appid, '1');
    assert.match(done[0].error, /供应商 500/);
  });

  test('跑完还要留着的那几句跟着结果一起走', () => {
    // warnings 说的是**成品缺了什么**(第 3 段没写出来),下一个 begin() 一开跑
    // 就没了 —— 而它必须跟着那份结果一直留在屏幕上
    const s = createGuideGenState();
    s.begin('1', 'A', 3);
    s.warn('第 3 段没写出来');
    s.end(null, { ok: true });
    s.begin('2', 'B', 3);
    assert.deepEqual(s.snapshot().finished[0].warnings, ['第 3 段没写出来']);
    assert.deepEqual(s.snapshot().warnings, [], 'begin 之后当前这轮不该带着上一轮的');
  });

  test('seq 单调递增 —— 页面靠它取增量', () => {
    const s = createGuideGenState();
    for (const id of ['1', '2', '3']) {
      s.begin(id, 'G' + id, 3);
      s.end(null, { ok: true });
    }
    const seqs = s.snapshot().finished.map((f) => f.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '乱序的话页面会漏收');
    assert.equal(new Set(seqs).size, 3, '重号会让页面把一条当成收过的');
  });

  test('有上限 —— 一次排几十个不能把快照撑爆', () => {
    const s = createGuideGenState();
    for (let i = 0; i < 25; i++) {
      s.begin(String(i), 'G' + i, 3);
      s.end(null, { ok: true });
    }
    const done = s.snapshot().finished;
    assert.equal(done.length, 20);
    assert.equal(done[done.length - 1].game, 'G24', '砍的必须是旧的那头');
  });
});

describe('跑完那一屏要能拿到备份编号', () => {
  /**
   * 「生成成功」那一屏上的「删除备份」靠 `result.backup.id`。`generateGuide` 和
   * `patchGuide` 两边都返回 `backup`,但 **`server.js` 这一段以前把它丢掉了** ——
   * 丢掉的症状不是报错,是那个动作永远不出现,而这种缺失没有任何东西会喊一声。
   *
   * 交出去的必须是**存档编号**,不是绝对路径:页面拿它去调 `deleteGuideArchive`,
   * 而那个接口只认编号。拼编号的活归 `archiveIdOf`,不许在这里手拼字符串 ——
   * 编号格式由 `parseArchiveId` 定义,两处各写一份迟早对不上。
   */
  const src = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const result = src.slice(
    src.indexOf('guideGenState.end(null, {'),
    src.indexOf('for (const c of r.chunkFailures')
  );

  test('结果里带着 backup', () => {
    assert.ok(result.length > 0 && result.length < 3000, '切到的应该是那个 result');
    assert.match(result, /backup:/, '丢了它,「删除备份」永远不出现,而且不会报错');
  });

  test('交的是编号,不是路径 —— 而且编号由 archiveIdOf 生成', () => {
    assert.match(result, /archiveIdOf\(config, r\.backup\.path\)/,
      '手拼字符串的话,和 parseArchiveId 迟早对不上');
    assert.doesNotMatch(result, /backup:\s*r\.backup\.path/, '路径喂给删除接口是点不动的');
  });

  test('没有备份时是 null —— 整篇新生成没有旧的可存', () => {
    assert.match(result, /r\.backup\?\.path\s*\n?\s*\?/,
      '不判断的话,新生成那一屏会摆一个必然失败的按钮');
  });
});
