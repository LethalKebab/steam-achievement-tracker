/**
 * 封面地址:先猜、猜不中再问、问到就记下
 * ------------------------------------------------
 * 背景(2026-08-16 实测,库里 314 款):Dashboard 一直是拼
 * `cdn.akamai.steamstatic.com/steam/apps/<appid>/header.jpg` —— 对 305 款有效,
 * 9 款怎么都拿不到,四种替代域名写法全部 404。真因是 Steam 把商店素材迁到了
 * 带内容哈希的路径(`store_item_assets/steam/apps/<appid>/<40 位哈希>/header.jpg`),
 * 那段哈希猜不出来,而且每个素材各有各的哈希。失败的清一色是近两年的 appid,
 * **这个数只会越变越大**。
 *
 * 所以不再想办法猜得更准,改成问 appdetails 要权威地址,并且把结果记下来。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, insertGame, getGame } from '../lib/db.js';
import { createApi } from '../lib/api.js';
import { fetchGameIcon } from '../lib/steam.js';

const REAL = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2149010/8f1da1/header.jpg';

/** 只给 resolveCover 用得到的那几样,别的一律 null —— 免得测试悄悄依赖上别的东西 */
function envWith(steam) {
  const db = openDb(':memory:');
  insertGame(db, { appid: '2149010', name: '小小梦魇 强化版' });
  const api = createApi({
    db, steam, config: {}, syncState: { snapshot: () => ({}) },
    startBackgroundSync: null, guideGenState: null, startGuideGen: null,
    planGuidePreflight: null, maybeAutoSync: null,
  });
  return { db, api };
}

describe('resolveCover', () => {
  test('问到真地址就返回并落库', async () => {
    let asked = 0;
    const { db, api } = envWith({
      async fetchStoreHeaderImage() { asked++; return REAL; },
    });

    assert.deepEqual(await api.resolveCover('2149010'), { url: REAL });
    assert.equal(asked, 1);
    assert.equal(getGame(db, '2149010').cover_url, REAL, '没落库的话下次开页面还要再问一遍');
  });

  test('落过库就不再问 Steam —— 商店接口限流很严,问一次够了', async () => {
    let asked = 0;
    const { api } = envWith({
      async fetchStoreHeaderImage() { asked++; return REAL; },
    });

    await api.resolveCover('2149010');
    await api.resolveCover('2149010');
    await api.resolveCover('2149010');
    assert.equal(asked, 1, '缓存没生效,每次开页面都会去敲商店接口');
  });

  test('拿不到就**不写库** —— 写个空值等于永远不再重试', async () => {
    let asked = 0;
    const { db, api } = envWith({
      async fetchStoreHeaderImage() { asked++; return null; },
    });

    assert.deepEqual(await api.resolveCover('2149010'), { url: null });
    assert.equal(getGame(db, '2149010').cover_url, null);
    // 拿不到的原因多半是限流、或者商店页还没建好 —— 那都是会变的。
    // 缓存一个"没有"就是把一个临时状态钉成永久事实
    await api.resolveCover('2149010');
    assert.equal(asked, 2, '失败之后应该还会再试');
  });

  test('Steam 那边抛异常也只是拿不到,不能把这个请求打成 500', async () => {
    const { api } = envWith({
      async fetchStoreHeaderImage() { throw new Error('ECONNRESET'); },
    });
    assert.deepEqual(await api.resolveCover('2149010'), { url: null });
  });

  test('库里没有的 appid 如实报错,不去敲 Steam', async () => {
    let asked = 0;
    const { api } = envWith({
      async fetchStoreHeaderImage() { asked++; return REAL; },
    });
    const r = await api.resolveCover('999999999');
    assert.ok(r.error, '应该报错');
    assert.equal(asked, 0, '不在库里的东西没有理由去问 Steam');
  });

  test('落过库的封面会跟着 getDashboardData 一起发出去', async () => {
    const { api } = envWith({ async fetchStoreHeaderImage() { return REAL; } });
    await api.resolveCover('2149010');
    const g = api.getDashboardData().games.find((x) => x.appid === '2149010');
    // 前端据此**直接**用真地址,不必再演一遍"先加载失败再来问"
    assert.equal(g.coverUrl, REAL);
  });
});

// ---------------------------------------------------------------------------
// Notion 图标是同一个毛病的另一个出口
// ---------------------------------------------------------------------------
// fetchGameIcon 的兜底也是拼那条老路径,HEAD 一下拿不到就返回 null。它一直在
// "老实工作",只是结论错了:真相不是"这游戏没有图标",而是"图不在我们猜的地方"。
// 于是那 9 款游戏的 Notion 页同样没有图标,而且同样是静默的。

describe('fetchGameIcon 猜不中的时候会去问', () => {
  const steamWith = (headerImage) => ({
    async fetchOwnedGames() { return []; },       // 不在 owned 里 —— 方形图标这条路走不通
    async fetchStoreHeaderImage() { return headerImage; },
  });

  test('猜的地址 404 时退到 appdetails,而不是当作没有图标', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      assert.equal(await fetchGameIcon(steamWith(REAL), '2149010'), REAL);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('猜中了就不多问一次 —— 97% 的游戏走的是这条路', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    let asked = 0;
    const steam = {
      async fetchOwnedGames() { return []; },
      async fetchStoreHeaderImage() { asked++; return REAL; },
    };
    try {
      const url = await fetchGameIcon(steam, '2149010');
      assert.match(url, /cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/2149010\/header\.jpg$/);
      assert.equal(asked, 0, '猜中还去问,等于给每款游戏白加一次商店接口调用');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('两条路都拿不到就还是 null —— 没有图标的页面照样是好页面', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      assert.equal(await fetchGameIcon(steamWith(null), '2149010'), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
