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

import {
  NotionClient,
  newGuideStatus,
  GUIDE_STATUS_OPTIONS,
  inspectGuideDb,
  repairGuideDb,
  probeGuideDbWrite,
  DB_PROBLEM,
} from '../lib/notion.js';
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

// ---------------------------------------------------------------------------
// 接库时的体检 + 修复
// ---------------------------------------------------------------------------

/**
 * 这一段守的是**「配好了」这三个字必须说的是真话**。
 *
 * 在这之前 `saveNotionConfig` 只查 token 通不通、这个 ID 能不能查出行来,schema 一个字
 * 不看 —— 属性、类型、选项全推迟到真写的时候才发现。而同一时期 `notion-check` 查得很全,
 * 只是设置页从来没调过它。**两条路查的东西不一样,这才是那类 bug 的形状**;
 * 缺一个选项只是症状。
 *
 * 修复那半边最危险的失败不是"改不了",是**"报告改好了、其实一个字没动"**。这不是假想:
 * Notion 对 status 属性的 `groups` 就是无论建时传还是事后 PATCH 一律 200 + 原样不动。
 * 所以下面每一条修复用例里,「PATCH 返回 200」都**不构成**成功的证据,回读才是。
 */

/** 一个能记账的假客户端。`patchDb` 决定 Notion 这次装成什么脾气 */
function stubDb({
  properties,
  tokenFails = false,
  dbFails = false,
  patchDb = 'honors',
  createFails = false,
  archiveFails = false,
} = {}) {
  const c = new NotionClient({ notion: { token: 't', overviewDbId: 'db1' } });
  c.log = [];
  let current = properties;
  c.request = async (method, path, payload) => {
    c.log.push({ method, path, payload });
    if (path === '/users/me') {
      if (tokenFails) throw new Error('API token is invalid');
      return { name: '我的工作区' };
    }
    if (method === 'get' && path.startsWith('/databases/')) {
      if (dbFails) throw new Error('Could not find database');
      return { id: 'db1', title: [{ plain_text: '攻略库' }], url: 'https://notion.so/db1', properties: current };
    }
    if (method === 'patch' && path.startsWith('/databases/')) {
      const [prop, body] = Object.entries(payload.properties)[0];
      const type = Object.keys(body)[0];
      // 三种脾气。第二种是这个项目真撞过的那一种
      if (patchDb === 'honors') current = { ...current, [prop]: { type, [type]: body[type] } };
      else if (patchDb === 'clobbers')
        current = { ...current, [prop]: { type, [type]: { options: [{ name: 'Staged' }] } } };
      // 'silently-ignores':返回 200,current 一个字不动
      return {};
    }
    if (method === 'post' && path === '/pages') {
      if (createFails) throw new Error('API token does not have access to insert content');
      return { id: 'pg1', url: 'https://notion.so/pg1' };
    }
    if (method === 'patch' && path.startsWith('/pages/')) {
      if (archiveFails) throw new Error('conflict');
      return {};
    }
    throw new Error(`意外的请求:${method} ${path}`);
  };
  return c;
}

const full = () => statusProps(GUIDE_STATUS_OPTIONS);
const codes = (r) => r.problems.map((p) => p.code);
const hitDb = (c) => c.log.filter((r) => r.path.startsWith('/databases/')).length;
const pagesPosted = (c) => c.log.filter((x) => x.method === 'post' && x.path === '/pages');

describe('inspectGuideDb —— 接库那一刻就把该问的问完', () => {
  test('全绿的库:ok,一条毛病都没有', async () => {
    const r = await inspectGuideDb(stubDb({ properties: full() }), 'db1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    assert.equal(r.workspace, '我的工作区');
    assert.equal(r.database.title, '攻略库');
  });

  test('token 不通 → 就此打住,不再拿一个必然失败的 ID 去问库', async () => {
    const c = stubDb({ properties: full(), tokenFails: true });
    const r = await inspectGuideDb(c, 'db1');
    assert.deepEqual(codes(r), [DB_PROBLEM.BAD_TOKEN]);
    assert.equal(hitDb(c), 0, 'token 都不通了还去读库,只会多一条误导人的错误');
  });

  test('没填 ID → 单独一种毛病,不和「读不出库」混为一谈', async () => {
    const c = stubDb({ properties: full() });
    const r = await inspectGuideDb(c, '');
    assert.deepEqual(codes(r), [DB_PROBLEM.NO_DB_ID]);
    assert.equal(hitDb(c), 0);
  });

  test('库读不出来 → 两个修法不同的原因都要说出来', async () => {
    const r = await inspectGuideDb(stubDb({ properties: full(), dbFails: true }), 'db1');
    assert.deepEqual(codes(r), [DB_PROBLEM.DB_UNREADABLE]);
    // 合成一句话的版本会把「填错 ID」的人赶去反复检查 Connections
    assert.equal(r.problems[0].causes.length, 2);
    assert.ok(r.problems[0].causes.some((s) => s.includes('不是数据库')));
    assert.ok(r.problems[0].causes.some((s) => s.includes('Connections')));
  });

  test('缺选项 → error 级,报出缺哪些、还有哪些,并标成可修', async () => {
    const c = stubDb({ properties: statusProps(['Not started', 'In progress', 'Done']) });
    const r = await inspectGuideDb(c, 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.fixable, true);
    const p = r.problems.find((x) => x.code === DB_PROBLEM.MISSING_OPTIONS);
    assert.deepEqual(p.missing, ['Staged']);
    assert.deepEqual(p.have, ['Not started', 'In progress', 'Done']);
    assert.equal(p.severity, 'error');
  });

  test('压根没有状态属性 → warn 而不是 error,ok 仍然是 true(这是合法配置)', async () => {
    // 报成 error 会把一个能正常建攻略、能正常勾选的库说成坏的。
    // 但也不能不吭声:默默关掉 guide-status,用户看到的是"状态永远不更新"
    const c = stubDb({ properties: { Name: { type: 'title', title: {} } } });
    const r = await inspectGuideDb(c, 'db1');
    assert.equal(r.ok, true);
    assert.equal(r.fixable, false, '没有属性不是补选项能解决的,标成可修等于按钮按下去什么都不发生');
    const p = r.problems.find((x) => x.code === DB_PROBLEM.NO_STATUS_PROP);
    assert.equal(p.severity, 'warn');
    assert.deepEqual(p.wanted, GUIDE_STATUS_OPTIONS);
  });

  test('没有标题属性 → error(建页会被 400,而那个 400 看不出根因)', async () => {
    const c = stubDb({ properties: { Status: { type: 'status', status: { options: [] } } } });
    const r = await inspectGuideDb(c, 'db1');
    assert.ok(codes(r).includes(DB_PROBLEM.NO_TITLE_PROP));
    assert.equal(r.ok, false);
  });
});

describe('inspectGuideDb 的试写 —— 只读体检看不出「只有读权限」', () => {
  test('probeWrite 关着时一页都不建', async () => {
    const c = stubDb({ properties: full() });
    await inspectGuideDb(c, 'db1');
    assert.equal(pagesPosted(c).length, 0);
  });

  test('试写通过 → 建一页、立刻归档,ok', async () => {
    const c = stubDb({ properties: full() });
    const r = await inspectGuideDb(c, 'db1', { probeWrite: true });
    assert.equal(r.ok, true);
    assert.equal(pagesPosted(c).length, 1);
    const archive = c.log.find((x) => x.method === 'patch' && x.path.startsWith('/pages/'));
    assert.equal(archive.payload.archived, true, '建了不归档就是在用户库里留垃圾');
  });

  test('只有读权限 → NO_WRITE,并指向 integration 的权限设置', async () => {
    const c = stubDb({ properties: full(), createFails: true });
    const r = await inspectGuideDb(c, 'db1', { probeWrite: true });
    const p = r.problems.find((x) => x.code === DB_PROBLEM.NO_WRITE);
    assert.ok(p, '这正是能一路绿灯、到建页才 403 的那类毛病');
    assert.match(p.hint, /Insert content/);
  });

  test('归档失败 → 说出来并给出那一页的链接(留页面而不吭声更糟)', async () => {
    const c = stubDb({ properties: full(), archiveFails: true });
    const r = await inspectGuideDb(c, 'db1', { probeWrite: true });
    const p = r.problems.find((x) => x.code === DB_PROBLEM.STRANDED_PROBE_PAGE);
    assert.equal(p.severity, 'warn');
    assert.equal(p.url, 'https://notion.so/pg1');
  });

  test('已经有 error 级毛病时不试写 —— 别往一个已知配错的库里塞页面', async () => {
    const c = stubDb({ properties: statusProps(['Not started']) });
    await inspectGuideDb(c, 'db1', { probeWrite: true });
    assert.equal(pagesPosted(c).length, 0);
  });

  test('选项不齐时试写不带状态 —— 否则「没写权限」和「缺选项」会混成一条错误', async () => {
    const c = stubDb({ properties: statusProps(['Not started']) });
    const schema = {
      titleProperty: 'Name',
      status: { property: 'Status', type: 'status', options: ['Not started'] },
    };
    await probeGuideDbWrite(c, 'db1', schema);
    assert.equal(pagesPosted(c)[0].payload.properties.Status, undefined);
  });

  test('选项齐全时试写会带上状态 —— 试写要走通下游真正那条路', async () => {
    const c = stubDb({ properties: full() });
    const schema = {
      titleProperty: 'Name',
      status: { property: 'Status', type: 'status', options: [...GUIDE_STATUS_OPTIONS] },
    };
    await probeGuideDbWrite(c, 'db1', schema);
    assert.equal(pagesPosted(c)[0].payload.properties.Status.status.name, newGuideStatus(undefined));
  });
});

describe('repairGuideDb —— 200 不是成功的证据,回读才是', () => {
  const threeOfFour = () => statusProps(['Not started', 'In progress', 'Done']);

  test('Notion 认账 → 报出补上了哪些,ok', async () => {
    const r = await repairGuideDb(stubDb({ properties: threeOfFour() }), 'db1');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'repaired');
    assert.deepEqual(r.added, ['Staged']);
    assert.deepEqual(r.stillMissing, []);
  });

  test('PATCH 返回 200 但一个字没动 → 必须报失败', async () => {
    // 这个仓库真撞过:status 的 groups 就是这么被静默吞掉的。信 200 的话,
    // 用户按了按钮、看到成功、下次 guide-gen 照样被拦 —— 而且更难查了
    const r = await repairGuideDb(stubDb({ properties: threeOfFour(), patchDb: 'silently-ignores' }), 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'silently-ignored');
    assert.deepEqual(r.stillMissing, ['Staged']);
  });

  test('把已有选项冲掉了 → 报 clobbered,这比没修好严重得多', async () => {
    const r = await repairGuideDb(stubDb({ properties: threeOfFour(), patchDb: 'clobbers' }), 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'clobbered');
    assert.deepEqual(r.clobbered, ['Not started', 'In progress', 'Done']);
  });

  test('只增不减:发出去的载荷必须原样带着全部已有选项', async () => {
    const c = stubDb({ properties: threeOfFour() });
    await repairGuideDb(c, 'db1');
    const patch = c.log.find((x) => x.method === 'patch' && x.path.startsWith('/databases/'));
    const sent = patch.payload.properties.Status.status.options.map((o) => o.name);
    assert.deepEqual(sent, ['Not started', 'In progress', 'Done', 'Staged']);
  });

  test('本来就齐 → 一个 PATCH 都不发', async () => {
    const c = stubDb({ properties: full() });
    const r = await repairGuideDb(c, 'db1');
    assert.equal(r.reason, 'nothing-to-do');
    assert.equal(c.log.filter((x) => x.method === 'patch').length, 0);
  });

  test('没有状态属性 → 不发 PATCH,如实说这不是补选项能解决的', async () => {
    const c = stubDb({ properties: { Name: { type: 'title', title: {} } } });
    const r = await repairGuideDb(c, 'db1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-status-prop');
    assert.equal(c.log.filter((x) => x.method === 'patch').length, 0);
  });
});
