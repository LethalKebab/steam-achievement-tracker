/**
 * 供应商 × 攻略生成的**接缝**测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件补的是一个真实存在的空洞:**`guidegen.js` 从来没有被真的供应商驱动过。**
 *
 * `ai.test.js` / `ai-gemini.test.js` 测的是供应商自己(组装请求、拆流、判错),
 * `guidegen.test.js` 测的是编排,但它用的是手写的 `fakeProvider` —— 一个恰好实现了
 * 编排层当下会用到的那几个字段的桩。于是**两边各自都是绿的,而它们之间的约定谁也没验**:
 * 桩返回什么形状,是照着编排层写的,不是照着供应商写的。真供应商多一个字段、少一个
 * 字段、或者字段名不一样,749 个测试一个都不会红。
 *
 * 这个空洞正好对着已经炸过一次的地方:web_fetch 成功被读成失败,**只在官方端点默认
 * 开着**,而所有实盘都跑在 DeepSeek 的兼容端点上,于是它一路跑到用户手上才炸。
 * 同一个形状的坑还在:官方端点是唯一会发 `thinking` / `output_config` / `fallbacks`
 * 的路径,而那条路径从来没有端到端跑过。
 *
 * 所以这里走的是**真** `createProvider` → 真供应商 → 真 `createSession` → 真
 * `generateGuide`,只把 `fetch` 换掉,喂进各家**真实线格式**的字节。
 *
 * 全部离线:一个字节都不发出去,也不需要任何 API key。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertGame, replaceAchievements, allGuides } from '../lib/db.js';
import { createProvider } from '../lib/ai.js';
import { generateGuide } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const DEFS = [
  { api_name: 'A', name_cn: '第一步', name_en: '', description: '完成第一关。', game_name: '测试游戏', hidden: 0, icon: '' },
  { api_name: 'B', name_cn: '第二步', name_en: '', description: '完成第二关。', game_name: '测试游戏', hidden: 0, icon: '' },
];

const toRow = (d) => ({
  apiName: d.api_name, gameName: d.game_name, nameCn: d.name_cn,
  nameEn: d.name_en, description: d.description, hidden: 0, icon: '',
});

function freshEnv(ai) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'));
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  replaceAchievements(db, '1', DEFS.map(toRow));
  // `effort` 的默认值住在 `lib/config.js` 的 DEFAULTS 里(没导出),供应商自己**没有**
  // 默认值 —— `this.effort` 只在 `ai.effort` 有值时才成立。所以绕过 loadConfig 直接
  // new 一个供应商,是拿不到那个旋钮的。这里显式写上,和 config.js 的默认保持一致
  return { db, config: { guidesDir: dir, ai: { maxAchievements: 100, maxRetries: 0, effort: 'high', ...ai } } };
}

const fakeSteam = (unlocked = ['A']) => ({
  async fetchPlayerAchievements() {
    return { achievements: DEFS.map((d) => ({ apiname: d.api_name, achieved: unlocked.includes(d.api_name) ? 1 : 0 })) };
  },
  async fetchGlobalAchievementPercentages() { return null; },
});

/** 模型写的正文。两个成就各一个 checkbox,全是 `- [ ]` —— 打勾是程序的事 */
const BODY = [
  '```markdown',
  '## 主线',
  '',
  '- [ ] **第一步**<br>完成第一关。<br>开局就能拿',
  '- [ ] **第二步**<br>完成第二关。<br>接着打',
  '```',
].join('\n');

/** 切成 7 字节一块:既拆开事件,也拆开多字节汉字 */
function streamOf(text) {
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7);
  })();
}

function fakeFetch(bodyFor) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, headers: new Headers(), body: streamOf(bodyFor(calls.length - 1)) };
  };
  fn.calls = calls;
  return fn;
}

// --- Anthropic 的线格式 -----------------------------------------------------

/**
 * 一条真实形状的完整消息:先一次服务端搜索(带流式 JSON 入参),再一次**成功**的抓页
 * (它的 content 是**对象**,不是数组 —— 那正是炸到用户手上的那个形状),然后是正文。
 */
const anthropicSse = (text) => [
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"测试游戏 成就"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x/1' }] } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://x/1', retrieved_at: '2026-08-20T00:00:00Z', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '页面全文' } } } } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500, server_tool_use: { web_search_requests: 1 } } },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join('');

// --- Gemini 的线格式 --------------------------------------------------------

/** 思考分片和正文在同一个 parts 数组里,只差一个 `thought: true` */
const geminiSse = (text) => [
  {
    candidates: [{
      content: { role: 'model', parts: [{ text: '先查一下这游戏的成就。', thought: true }, { text }] },
      groundingMetadata: { webSearchQueries: ['测试游戏 成就'] },
    }],
  },
  {
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500, thoughtsTokenCount: 50 },
  },
]
  .map((c) => `data: ${JSON.stringify(c)}\n\n`)
  .join('');

// ---------------------------------------------------------------------------
// 三家都要能把同一份攻略走完整条流水线
// ---------------------------------------------------------------------------

/**
 * 三家的**产出必须逐字节相同** —— 攻略内容是模型写的,而这条流水线上其余的一切
 * (剥 markdown 围栏、拼段、写头、机械打勾、登记)都不该认识供应商是谁。
 * 任何一家在这里跑出不一样的结果,都是编排层漏了某家的形状。
 */
const CASES = [
  { name: 'anthropic(官方端点)', ai: { provider: 'anthropic', apiKey: 'k' }, sse: anthropicSse },
  { name: 'deepseek(Anthropic 兼容端点预设)', ai: { provider: 'deepseek', apiKey: 'k' }, sse: anthropicSse },
  { name: 'gemini', ai: { provider: 'gemini', apiKey: 'k' }, sse: geminiSse },
];

describe('真供应商驱动整条流水线', () => {
  for (const c of CASES) {
    test(`${c.name}:一轮过关、落盘、机械打勾、登记`, async () => {
      const { db, config } = freshEnv(c.ai);
      const fetchImpl = fakeFetch(() => c.sse(BODY));
      const provider = await createProvider(config, { fetchImpl });

      const events = [];
      const r = await generateGuide(db, {
        config, provider, steam: fakeSteam(['A']), appid: '1',
        onProgress: (e) => events.push(e),
      });

      assert.equal(r.ok, true, r.reason ?? '');
      assert.equal(r.rounds, 1);
      assert.equal(fetchImpl.calls.length, 1, '两个成就只该发一次请求');
      assert.ok(existsSync(r.path));

      const text = readFileSync(r.path, 'utf8');
      assert.match(text, /- \[x\] \*\*第一步\*\*/, '已解锁的要被机械打勾');
      assert.match(text, /- \[ \] \*\*第二步\*\*/, '没解锁的不许勾');
      assert.match(text, /^# 测试游戏/);
      assert.match(text, /^appid: 1$/m);
      assert.ok(!text.includes('```'), 'markdown 围栏必须剥掉');

      assert.equal(allGuides(db).length, 1);
      assert.ok(r.registered);

      // **「能搜 ≠ 搜了」是这套准入设计的关键读数**,而它要穿过供应商 → session →
      // 编排层三层才到得了调用方。桩不返回这个字段,所以此前没有任何测试覆盖它。
      // **收尾报表这一路三家是齐的**;实时进度不是,见下面那条
      assert.deepEqual(r.searchQueries, ['测试游戏 成就']);
      assert.ok(events.some((e) => e.phase === 'tool'), '联网工具至少要变成一条进度事件');
    });
  }

  /**
   * **进度事件的归一化只做了一半,而这半边是三家里唯二的行为差异。**
   *
   * `ai.js` 顶上写着「进度事件也归一化(text / tool / tool-result / search),CLI 的
   * 实时输出和 guidegen 的进度条因此不认识任何一家的原始格式」。`search` 这一档
   * **只有 Gemini 在发**:它的 `groundingMetadata.webSearchQueries` 在每个 chunk 里
   * 都重复出现,所以边流边报得出查询词。Anthropic 那边查询词是 `server_tool_use` 块的
   * **流式 JSON 入参**,`content_block_start` 的时候还没到,于是 `emitProgress` 只发得出
   * `{type:'tool', name:'web_search'}` —— 一个原始的、英文的线格式工具名,直接进了
   * 进度条。
   *
   * 后果两条,都不报错:跑 Claude / DeepSeek 时进度条上滚的是 `web_search` 而不是
   * 「搜索「怎么拿到XX成就」」,**并且看不出模型在搜什么**;而同一个界面在 Gemini 上
   * 是中文加查询词。收尾的 `searchQueries` 三家一致,所以事后报表看不出这个差。
   *
   * 这里钉的是**当下真实的行为**,不是应该的行为 —— 改 `emitProgress` 让 Anthropic 也
   * 在 `content_block_stop` 时补一条 `search` 事件是另一件事,改完把这条测试翻过来。
   */
  test('实时搜索词只有 gemini 报得出,anthropic 系报的是原始工具名', async () => {
    const seen = {};
    for (const c of CASES) {
      const { db, config } = freshEnv(c.ai);
      const provider = await createProvider(config, { fetchImpl: fakeFetch(() => c.sse(BODY)) });
      const events = [];
      await generateGuide(db, {
        config, provider, steam: fakeSteam(), appid: '1', onProgress: (e) => events.push(e),
      });
      seen[c.ai.provider] = events.filter((e) => e.phase === 'tool').map((e) => e.name);
    }
    assert.deepEqual(seen.gemini, ['搜索「测试游戏 成就」']);
    assert.deepEqual(seen.anthropic, ['web_search'], '线格式的工具名漏进了进度条');
    assert.deepEqual(seen.deepseek, ['web_search'], '和 anthropic 同一个类,同一个行为');
  });

  test('三家产出的攻略正文逐字节相同', async () => {
    const texts = [];
    for (const c of CASES) {
      const { db, config } = freshEnv(c.ai);
      const provider = await createProvider(config, { fetchImpl: fakeFetch(() => c.sse(BODY)) });
      const r = await generateGuide(db, { config, provider, steam: fakeSteam(['A']), appid: '1' });
      texts.push(readFileSync(r.path, 'utf8'));
    }
    assert.equal(texts[0], texts[1], 'anthropic 和 deepseek 预设走的是同一个类,不该有差');
    assert.equal(texts[0], texts[2], 'gemini 的产出和 anthropic 不一致 —— 编排层认出了供应商');
  });

  /**
   * **模型没写 markdown 围栏的时候,思考分片才真的会落进文件。**
   *
   * 这条测试的第一版用的是带围栏的 BODY,于是它**永远是绿的**:`extractMarkdown`
   * 只取围栏里的那一段,思考在围栏外,怎么漏都到不了文件。变异验证当场发现了 ——
   * 把 `ai-gemini.js` 里的 `if (p?.thought)` 改成恒假,9 个测试照样全绿。
   *
   * 而围栏不是保证:`extractMarkdown` 自己就留着「一个围栏都没有 ⇒ 整段当正文」这条
   * 兜底。两件事一叠加,思考过程就写进了用户的攻略,而**校验器抓不到** —— 那几行
   * 既不是 checkbox 也不违反任何规则。所以这里故意不发围栏。
   */
  test('gemini 的思考分片不能混进攻略文件(模型没写围栏时)', async () => {
    const bare = BODY.replace(/^```markdown\n/, '').replace(/\n```$/, '');
    assert.ok(!bare.includes('```'), '这条测试的前提就是没有围栏,有围栏它验不到东西');

    const { db, config } = freshEnv({ provider: 'gemini', apiKey: 'k' });
    const provider = await createProvider(config, { fetchImpl: fakeFetch(() => geminiSse(bare)) });
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1' });

    const text = readFileSync(r.path, 'utf8');
    assert.match(text, /- \[ \] \*\*第二步\*\*/, '正文本身要照常落盘');
    assert.ok(!text.includes('先查一下'), '模型的思考过程被写进了用户的攻略');
  });
});

// ---------------------------------------------------------------------------
// 官方端点专属的那几个字段 —— 唯一一条没有实盘跑过的路径
// ---------------------------------------------------------------------------

describe('官方 Anthropic 端点发出去的请求', () => {
  /** 跑一轮,把真正发出去的那个请求体和请求头拿回来 */
  async function capture(ai) {
    const { db, config } = freshEnv(ai);
    const fetchImpl = fakeFetch(() => anthropicSse(BODY));
    const provider = await createProvider(config, { fetchImpl });
    await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1' });
    return fetchImpl.calls[0];
  }

  test('两个联网工具都声明,而且是 _20260209 那一版', async () => {
    const { body } = await capture({ provider: 'anthropic', apiKey: 'k' });
    assert.deepEqual(
      body.tools.map((t) => t.type),
      ['web_search_20260209', 'web_fetch_20260209'],
      'web_fetch 只在官方端点默认开 —— 它成功时的形状曾经被读成失败,那个 bug 就藏在这条路径上'
    );
    assert.ok(
      !body.tools.some((t) => /code_execution/.test(t.type)),
      '_20260209 自带动态过滤,再声明 code_execution 会让模型看到两个执行环境'
    );
  });

  test('thinking / output_config / fallbacks 三个字段各发各的', async () => {
    const { body, headers } = await capture({ provider: 'anthropic', apiKey: 'k' });
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.ok(!('budget_tokens' in body.thinking), 'budget_tokens 在官方端点是 400,在兼容端点更糟(200 但反向)');
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.fallbacks, 'default');
    assert.equal(
      headers['anthropic-beta'], 'server-side-fallback-2026-07-01',
      'scalar 形态的 fallbacks 配 -2026-07-01;和数组形态的 -2026-06-01 配错会 400'
    );
    assert.equal(body.stream, true, 'max_tokens 管的是 thinking + 正文,不流式会先撞 HTTP 超时');
  });

  test('兼容端点上这三个字段的命运不一样,不能捆在一个开关上', async () => {
    const { body, headers } = await capture({ provider: 'deepseek', apiKey: 'k' });
    assert.equal(body.thinking, undefined, '兼容端点默认不发 thinking');
    assert.deepEqual(body.output_config, { effort: 'high' }, 'DeepSeek 的 /anthropic 实测认得 effort —— 唯一有效的那个旋钮');
    assert.equal(body.fallbacks, undefined);
    assert.equal(headers['anthropic-beta'], undefined);
    assert.deepEqual(body.tools.map((t) => t.type), ['web_search_20260209'], '兼容端点声明 web_fetch 会整个请求 400');
  });
});
