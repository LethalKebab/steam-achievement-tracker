/**
 * 两个限流旋钮不许被合回一个
 * ------------------------------------------------
 * 跑法:node --test
 *
 * `requestDelayMs` 管 api.steampowered.com,`storeRequestDelayMs` 管
 * store.steampowered.com。它们**曾经是同一个值**,而这正是问题所在:
 * Web API 实测能扛住 11 次/秒(400 个请求、间隔 0ms、36 秒、零 429),
 * 商店接口严得多,而且撞上去是 **IP 级封禁**,不是 key 级限流。
 *
 * 所以危险的改动不是「调错数字」,是**把商店那条路的 sleep 换回 this.delay**:
 * 什么都不会报错,同步照跑,只是商店接口从每 300ms 一次变成每 100ms 一次,
 * 后果要等到被封了才看得见。下面的源码断言钉的就是这件事。
 *
 * 注释必须先剥,而且**先剥行注释再剥块注释**(见 CLAUDE.md):这个文件要断言的
 * 两个标识符都在解释性注释里出现过,不剥的话断言会被注释本身满足。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SteamClient } from '../lib/steam.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** 先行注释、再块注释 —— 反过来的话 `//` 里的 `/*` 会吃掉真代码 */
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** 在 from 之后、to 之前那一段。两个锚点都必须真的存在,少一个就是响亮的失败 */
function between(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `锚点不见了: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `锚点不见了: ${to}`);
  return src.slice(a, b);
}

describe('SteamClient — 两个独立的间隔', () => {
  test('默认值:Web API 100ms,商店 300ms', () => {
    const c = new SteamClient({ steamApiKey: 'k', steamId: 's' });
    assert.equal(c.delay, 100, 'Web API 实测能扛 11 次/秒,100ms 留了一半余量');
    assert.equal(c.storeDelay, 300, '商店那条没有实测数据,保持保守');
  });

  test('两个字段各读各的配置项,不会互相串', () => {
    const c = new SteamClient({ requestDelayMs: 42, storeRequestDelayMs: 999 });
    assert.equal(c.delay, 42);
    assert.equal(c.storeDelay, 999);
  });

  test('只给一个,另一个仍回落到自己的默认值', () => {
    const onlyWeb = new SteamClient({ requestDelayMs: 5 });
    assert.equal(onlyWeb.delay, 5);
    assert.equal(onlyWeb.storeDelay, 300, '调快 Web API 不该顺手把商店也调快');

    const onlyStore = new SteamClient({ storeRequestDelayMs: 5000 });
    assert.equal(onlyStore.delay, 100);
    assert.equal(onlyStore.storeDelay, 5000);
  });

  test('0 是合法值,不该被 ?? 当成"没给"', () => {
    const c = new SteamClient({ requestDelayMs: 0, storeRequestDelayMs: 0 });
    assert.equal(c.delay, 0);
    assert.equal(c.storeDelay, 0);
  });
});

describe('商店那条路必须用 storeDelay(源码断言)', () => {
  test('fetchAppName 里两次商店调用之间用的是 storeDelay', () => {
    const src = strip(read('../lib/steam.js'));
    const body = between(src, 'async fetchAppName(appid) {', 'async fetchStoreHeaderImage(');
    assert.match(body, /sleep\(this\.storeDelay\)/, 'appdetails 和商店页 HTML 都在 store.steampowered.com');
    assert.doesNotMatch(body, /sleep\(this\.delay\)/, 'Web API 的间隔不该用在商店调用上');
  });

  test('sync.js 里每个 fetchAppName 之后的那次 sleep 都是 storeDelay', () => {
    const src = strip(read('../lib/sync.js'));
    const calls = [...src.matchAll(/steam\.fetchAppName\(/g)];
    assert.ok(calls.length >= 2, `sync.js 里应当有至少两处 fetchAppName,实际 ${calls.length}`);
    for (const m of calls) {
      // 从这次调用往后找**下一个** sleep —— 不用固定字节窗口,代码长胖也不会漂
      const rest = src.slice(m.index);
      const s = rest.match(/await sleep\(([^)]*)\)/);
      assert.ok(s, `fetchAppName(位置 ${m.index})后面没有 sleep`);
      assert.equal(s[1].trim(), 'steam.storeDelay',
        `fetchAppName 走的是商店接口,后面该是 steam.storeDelay,实际是 ${s[1]}`);
    }
  });

  test('Web API 的两个循环仍然用快的那个', () => {
    const src = strip(read('../lib/sync.js'));
    // 第二阶段:成就计数。GetPlayerAchievements,就是实测过的那个接口
    const stats = between(src, 'export async function syncAchievementStats(', 'export async function');
    assert.match(stats, /await sleep\(steam\.delay\)/, '第二阶段是 Web API,该用快的');
    // 第三阶段:成就明细。GetSchemaForGame,同样是 Web API
    const schema = between(src, 'export async function syncAchievementSchema(', 'export async function');
    assert.match(schema, /await sleep\(steam\.delay\)/, '第三阶段也是 Web API');
  });

  test('两个旋钮在 steam.js 里都真的被读了 —— 少读一个等于悄悄合并', () => {
    const src = strip(read('../lib/steam.js'));
    assert.match(src, /cfg\.requestDelayMs/);
    assert.match(src, /cfg\.storeRequestDelayMs/);
  });
});
