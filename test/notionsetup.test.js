/**
 * 自动建攻略库(`init --notion --create` / 设置页的「帮我建一个」)
 * ------------------------------------------------
 * 这个文件保的是**一类会拖到很晚才暴露的失败**:建库这一步报了成功,但建出来的库
 * 其实不是程序能用的那一种。用户要到第一次 `guide-gen` 才撞上「「Status」属性里
 * 没有「In progress」这个选项」—— 而那时候他早就不认为问题出在当初的设置上了。
 * 自动建库存在的全部理由就是消灭这堵墙,所以它自己绝不能把墙往后挪。
 *
 * 三条:
 *
 * 1. **`GUIDE_STATUS_OPTIONS` 必须覆盖程序会写的每一个值。** 纯漂移检测:谁动了
 *    `newGuideStatus` 或 guides.js 那两个常量而没同步选项表,这里就红。少一个,
 *    对应那条路就会在真要写的时候被 `planNotionTarget` 拦下。
 * 2. **建完必须回读验证,不能信 HTTP 200。** 实测过 Notion 会对 status 属性的
 *    `groups` 静默忽略 —— 建时传、事后 PATCH,三种 payload 形状全是 200 加原样不动。
 *    所以在这条路上"调用成功"根本不构成"内容正确"的证据。
 * 3. **`searchPages` 必须滤掉数据库的行。** 真机上 `/search` 返回的 100 条里 99 条
 *    是攻略库自己的行(`parent.type === 'database_id'`);不滤的话,选父页面的列表
 *    会被用户自己的攻略淹没,而唯一能用的那个页面排在第 100 位。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { NotionClient, newGuideStatus, GUIDE_STATUS_OPTIONS } from '../lib/notion.js';
import { GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED } from '../lib/guides.js';
import { createApi } from '../lib/api.js';

// ---------------------------------------------------------------------------
// 脚手架:把 request 换掉,不碰网络
// ---------------------------------------------------------------------------

const statusProps = (options) => ({
  Name: { type: 'title', title: {} },
  Status: { type: 'status', status: { options: options.map((name) => ({ name })) } },
});

/** 建库用的假客户端。`sent` 收下真正发出去的 payload,好断言"请求里带的就是那四个" */
function stubCreate({ readBackProps }) {
  const c = new NotionClient({ notion: { token: 't' } });
  c.sent = [];
  c.request = async (method, path, payload) => {
    if (method === 'post' && path === '/databases') {
      c.sent.push(payload);
      return { id: 'AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'https://notion.so/x' };
    }
    if (method === 'get' && path.startsWith('/databases/')) return { properties: readBackProps };
    throw new Error(`意外的请求:${method} ${path}`);
  };
  return c;
}

/** /search 用的假客户端,支持翻页 */
function stubSearch(pagesOfResults) {
  const c = new NotionClient({ notion: { token: 't' } });
  c.calls = 0;
  c.request = async (method, path) => {
    assert.equal(`${method} ${path}`, 'post /search');
    const i = c.calls++;
    const results = pagesOfResults[i] ?? [];
    const hasMore = i < pagesOfResults.length - 1;
    return { results, has_more: hasMore, next_cursor: hasMore ? `c${i}` : null };
  };
  return c;
}

const realPage = (id, title) => ({
  id,
  parent: { type: 'page_id', page_id: 'parent' },
  url: `https://notion.so/${id}`,
  properties: { title: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
});

const dbRow = (id, title) => ({
  id,
  parent: { type: 'database_id', database_id: 'd' },
  url: `https://notion.so/${id}`,
  properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
});

// ---------------------------------------------------------------------------

describe('选项表覆盖程序会写的每一个值', () => {
  test('newGuideStatus 的每一档都在 GUIDE_STATUS_OPTIONS 里', () => {
    const written = [
      newGuideStatus({ achieved: 51, total: 51 }), // 满成就
      newGuideStatus({ achieved: 50, total: 51 }), // 解锁了一部分
      newGuideStatus({ achieved: 0, total: 51 }), // 一个都没有
      newGuideStatus(undefined), // 还没同步
    ];
    for (const v of written) {
      assert.ok(GUIDE_STATUS_OPTIONS.includes(v), `newGuideStatus 会写「${v}」,但它不在选项表里`);
    }
  });

  test('guide-status 收敛写的两个也在里面', () => {
    for (const v of [GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED]) {
      assert.ok(GUIDE_STATUS_OPTIONS.includes(v), `guide-status 会写「${v}」,但它不在选项表里`);
    }
  });

  test('前三个是 Notion status 属性的自带默认 —— 手工建库只差一个 Staged', () => {
    // 实测:建一个不指定 options 的 status 属性,Notion 回的就是这三个。
    // 文档里"通常只差 Staged 要自己加"那句话立在这条上面
    for (const v of ['Not started', 'In progress', 'Done']) {
      assert.ok(GUIDE_STATUS_OPTIONS.includes(v));
    }
  });
});

describe('createGuideDatabase', () => {
  test('请求里带的选项就是 GUIDE_STATUS_OPTIONS,不是另抄的一份', async () => {
    const c = stubCreate({ readBackProps: statusProps(GUIDE_STATUS_OPTIONS) });
    await c.createGuideDatabase({ parentPageId: 'p1' });
    const sentOptions = c.sent[0].properties.Status.status.options.map((o) => o.name);
    assert.deepEqual(sentOptions, GUIDE_STATUS_OPTIONS);
    assert.equal(c.sent[0].parent.page_id, 'p1');
  });

  test('回读齐了 → 返回去掉连字符的小写 id,好和手工填的那种形状对齐', async () => {
    const c = stubCreate({ readBackProps: statusProps(GUIDE_STATUS_OPTIONS) });
    const db = await c.createGuideDatabase({ parentPageId: 'p1' });
    assert.equal(db.id, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
    assert.equal(db.statusProperty, 'Status');
    assert.deepEqual(db.options, GUIDE_STATUS_OPTIONS);
  });

  test('回读发现少了一个选项 → 抛,而且把缺的那个说出来', async () => {
    // Notion 对 status 的 groups 就是这么静默吞掉的,所以这条回读不是走过场
    const c = stubCreate({ readBackProps: statusProps(['Not started', 'In progress', 'Done']) });
    await assert.rejects(c.createGuideDatabase({ parentPageId: 'p1' }), /Staged/);
  });

  test('回读发现压根没建出状态属性 → 抛,而且和「选项少了几个」报得不一样', async () => {
    // 两种毛病两种修法(加属性 vs 补选项),合成一句话会把前者说成"缺了全部四个选项"
    const c = stubCreate({ readBackProps: { Name: { type: 'title', title: {} } } });
    await assert.rejects(c.createGuideDatabase({ parentPageId: 'p1' }), /没有状态属性/);
  });

  test('没给父页面 → 当场抛,不发请求', async () => {
    const c = stubCreate({ readBackProps: statusProps(GUIDE_STATUS_OPTIONS) });
    await assert.rejects(c.createGuideDatabase({ parentPageId: '' }), /父页面/);
    assert.equal(c.sent.length, 0);
  });
});

describe('createNotionGuideDb 的护栏 —— 全都在发请求之前拦下', () => {
  const apiWith = (notion) =>
    createApi({ db: null, steam: null, config: { notion }, syncState: null,
      startBackgroundSync: null, guideGenState: null, startGuideGen: null, planGuidePreflight: null });

  test('已经配了攻略库 → 拒绝', async () => {
    // 最坏的那个后果:有上百篇攻略的人点一下按钮,配置被改指到一个空库。
    // 攻略一篇不丢,但工具全都看不见了,而且界面上看不出发生过什么
    const r = await apiWith({ token: 't', overviewDbId: 'aaaa' }).createNotionGuideDb('', 'p1', 'x');
    assert.match(r.error, /已经配了攻略库/);
  });

  test('没 token → 拒绝', async () => {
    const r = await apiWith({}).createNotionGuideDb('', 'p1', 'x');
    assert.match(r.error, /Integration Secret/);
  });

  test('没选父页面 → 拒绝', async () => {
    const r = await apiWith({ token: 't' }).createNotionGuideDb('', '', 'x');
    assert.match(r.error, /父页面/);
  });
});

describe('searchPages', () => {
  test('数据库的行被滤掉,只留真正能当父页面的', async () => {
    const c = stubSearch([[dbRow('r1', '空之轨迹'), realPage('p1', '成就'), dbRow('r2', '鬼谷八荒')]]);
    const { pages } = await c.searchPages();
    assert.deepEqual(pages.map((p) => p.title), ['成就']);
  });

  test('会一直翻到没有下一页', async () => {
    const c = stubSearch([[realPage('p1', '一')], [realPage('p2', '二')]]);
    const { pages, truncated } = await c.searchPages();
    assert.deepEqual(pages.map((p) => p.title), ['一', '二']);
    assert.equal(truncated, false);
  });

  test('翻到上限还没完 → truncated 如实上报', async () => {
    // "列表里没有"和"列表被截断了"对用户是两个完全不同的处境,不能都显示成前者
    const c = stubSearch([[realPage('p1', '一')], [realPage('p2', '二')], [realPage('p3', '三')]]);
    const { pages, truncated } = await c.searchPages({ maxPages: 2 });
    assert.equal(pages.length, 2);
    assert.equal(truncated, true);
  });

  test('没有标题的页面不会显示成空白', async () => {
    const c = stubSearch([[{ id: 'p1', parent: { type: 'workspace' }, url: 'u', properties: {} }]]);
    const { pages } = await c.searchPages();
    assert.equal(pages[0].title, '(无标题)');
  });
});
