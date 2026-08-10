/**
 * Gemini 供应商的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这一家是在**拿不到官方文档**的情况下接的(写的时候网络工具连续不可用),字段名、
 * 模型名、工具名全来自记忆。所以这个文件守的失败类和别处不太一样:**记错了会不会
 * 悄悄地错**。
 *
 * 记错了但会当场报错的(模型名、工具名、端点),不需要测——第一次真跑就知道了,
 * 而且都做成了可配置。真正危险的是下面这些:错了不报错,只是结果不对。
 *
 *  - **thought 分片混进正文**。Gemini 把思考和正文放在同一个 parts 数组里,只差一个
 *    `thought: true`。漏判一次,模型的思考过程就被写进用户的攻略文件里
 *  - **usage 字段映射**。名字和 Anthropic 完全不同,而且同样是"每个 chunk 报累计值",
 *    加起来就重复计数 —— 没有任何地方会报错,只是数字一直不对
 *  - **认不出的 finishReason 必须落到 'other'**。默认当成功处理的话,Google 以后加一个
 *    新的终止原因,失败的生成会看起来像成功
 *  - **RECITATION 不能和普通拒答混为一谈**。写攻略正好是它的高危场景(我们明确要求
 *    原文照抄官方描述),需要一条能照着做的信息
 *  - **整个 prompt 被挡下时根本没有 candidates**,只有 promptFeedback.blockReason。
 *    不单独处理就会表现成"输出了个空字符串"
 *  - **key 必须走请求头**,不能进查询串(会进日志、进错误上报)
 *
 * 全部离线,fetch 是注入的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { emptyUsage, checkResult, createSession } from '../lib/ai.js';
import { GeminiProvider, createGeminiAccumulator, mergeGeminiUsage } from '../lib/ai-gemini.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function sseBody(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    // 切成 7 字节一块:既拆开事件,也拆开多字节汉字
    for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7);
  })();
}

const okResponse = (chunks) => ({ ok: true, status: 200, headers: new Headers(), body: sseBody(chunks) });

const errResponse = (status, body) => ({
  ok: false,
  status,
  headers: new Headers(),
  text: async () => JSON.stringify(body),
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    const r = responses[calls.length - 1];
    if (!r) throw new Error(`没有为第 ${calls.length} 次调用准备响应`);
    return r;
  };
  fn.calls = calls;
  return fn;
}

const AI = { apiKey: 'test-key', model: 'gemini-2.5-pro', maxTokens: 32000, maxRetries: 0 };

/** 一条正常的完整回复 */
const reply = (text, finishReason = 'STOP', extra = {}) => [
  { candidates: [{ content: { parts: [{ text }], role: 'model' } }], ...extra },
  {
    candidates: [{ finishReason, content: { parts: [], role: 'model' } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  },
];

// ---------------------------------------------------------------------------
// 思考分片
// ---------------------------------------------------------------------------

test('thought 分片不能混进正文(否则思考过程会被写进攻略文件)', () => {
  const acc = createGeminiAccumulator();
  acc.push({
    candidates: [{
      content: {
        parts: [
          { text: '我先想想这个成就怎么拿……', thought: true },
          { text: '- [ ] **第一步**' },
          { text: '再想想有没有漏的', thought: true },
          { text: '<br>完成第一关。' },
        ],
      },
    }],
  });
  const r = acc.result();
  assert.equal(r.text, '- [ ] **第一步**<br>完成第一关。');
  assert.match(r.thinking, /我先想想/, '思考本身要留着,只是不能进正文');
});

// ---------------------------------------------------------------------------
// usage 映射
// ---------------------------------------------------------------------------

describe('usage', () => {
  test('字段名映射对得上', () => {
    const u = emptyUsage();
    mergeGeminiUsage(u, {
      promptTokenCount: 1200,
      candidatesTokenCount: 800,
      cachedContentTokenCount: 300,
    });
    assert.equal(u.inputTokens, 1200);
    assert.equal(u.outputTokens, 800);
    assert.equal(u.cacheReadTokens, 300);
  });

  test('思考 token 计进输出(计费口径和 Anthropic 那边一致)', () => {
    const u = emptyUsage();
    mergeGeminiUsage(u, { candidatesTokenCount: 800, thoughtsTokenCount: 2000 });
    assert.equal(u.outputTokens, 2800);
  });

  test('每个 chunk 报的是累计值,所以是覆盖不是累加', () => {
    const u = emptyUsage();
    mergeGeminiUsage(u, { promptTokenCount: 100, candidatesTokenCount: 10 });
    mergeGeminiUsage(u, { promptTokenCount: 100, candidatesTokenCount: 700 });
    assert.equal(u.outputTokens, 700, '相加会变成 710,而这个错没有任何地方会报出来');
    assert.equal(u.inputTokens, 100);
  });
});

// ---------------------------------------------------------------------------
// 终止原因
// ---------------------------------------------------------------------------

describe('finishReason 归一化', () => {
  const run = async (chunks) => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([okResponse(chunks)]) });
    return p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  };

  test('STOP → end_turn,结果可用', async () => {
    const r = await run(reply('好的'));
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.text, '好的');
    assert.equal(checkResult(r).ok, true);
  });

  test('MAX_TOKENS → max_tokens,有正文也不算写完了', async () => {
    const r = await run(reply('写到一半', 'MAX_TOKENS'));
    assert.equal(r.stopReason, 'max_tokens');
    assert.equal(r.text, '写到一半', '正文确实有 —— 这正是它危险的地方');
    assert.match(checkResult(r).reason, /截断/);
  });

  test('SAFETY → refusal', async () => {
    const r = await run(reply('', 'SAFETY'));
    assert.equal(r.stopReason, 'refusal');
    assert.equal(checkResult(r).ok, false);
  });

  test('RECITATION 单独成一类,给的是能照着做的信息', async () => {
    const r = await run(reply('抄了一段 wiki', 'RECITATION'));
    assert.equal(r.stopReason, 'recitation');
    assert.equal(r.rawStopReason, 'RECITATION');
    const v = checkResult(r);
    assert.equal(v.ok, false);
    assert.match(v.reason, /RECITATION/);
    assert.match(v.reason, /原文照抄/, '得说清楚不能为了绕开它而改掉硬要求');
  });

  test('认不出的终止原因落到 other,不当成功', async () => {
    // Google 以后加一个新值时,失败的生成不能看起来像成功
    const r = await run(reply('半截', 'SOME_FUTURE_REASON'));
    assert.equal(r.stopReason, 'other');
    assert.equal(r.rawStopReason, 'SOME_FUTURE_REASON');
    const v = checkResult(r);
    assert.equal(v.ok, false);
    assert.match(v.reason, /SOME_FUTURE_REASON/, '原值要带出来,不然没法查');
  });

  test('整个 prompt 被挡下时没有 candidates,只有 blockReason', async () => {
    const r = await run([{ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 30 } }]);
    assert.equal(r.stopReason, 'refusal', '不单独处理的话会表现成"输出了个空字符串"');
    assert.equal(r.rawStopReason, 'BLOCKED_SAFETY');
    assert.equal(checkResult(r).ok, false);
  });
});

// ---------------------------------------------------------------------------
// 联网:回包才是证据
// ---------------------------------------------------------------------------

describe('grounding', () => {
  test('搜索词从 groundingMetadata 收集,而且去重', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([okResponse([
      { candidates: [{ groundingMetadata: { webSearchQueries: ['学园构想家 成就'] }, content: { parts: [{ text: 'a' }] } }] },
      { candidates: [{ groundingMetadata: { webSearchQueries: ['学园构想家 成就', '学园构想家 攻略'] }, content: { parts: [{ text: 'b' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [] } }], usageMetadata: { candidatesTokenCount: 5 } },
    ])]) });
    const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.deepEqual(r.searchQueries, ['学园构想家 成就', '学园构想家 攻略']);
  });

  test('声明了工具但一次没搜 → searchQueries 为空,调用方靠这个发现"这层没联网"', async () => {
    // 免费层带不带联网是文档上查不准的事,回包比定价页可靠
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([okResponse(reply('我凭记忆答'))]) });
    const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: p.webTools() });
    assert.deepEqual(r.searchQueries, []);
    assert.equal(checkResult(r).ok, true, '没搜不算这一轮失败 —— 是个要报给人看的信号,不是错误');
  });

  test('工具声明可配置(改名或免费层不给用时改配置,不改代码)', () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([]) });
    assert.deepEqual(p.webTools(), [{ google_search: {} }]);

    const withFetch = new GeminiProvider({ ...AI, geminiTools: ['google_search', 'url_context'] }, { fetchImpl: fakeFetch([]) });
    assert.deepEqual(withFetch.webTools(), [{ google_search: {} }, { url_context: {} }]);
  });
});

// ---------------------------------------------------------------------------
// 请求组装
// ---------------------------------------------------------------------------

describe('请求组装', () => {
  test('assistant 在这边叫 model,正文装在 parts 里', () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([]) });
    const body = p.buildBody({
      system: '规则',
      messages: [
        { role: 'user', content: '写一份' },
        { role: 'assistant', content: [{ text: '第一版' }] },
        { role: 'user', content: '这几条没过' },
      ],
    });
    assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
    assert.deepEqual(body.contents[0].parts, [{ text: '写一份' }]);
    assert.deepEqual(body.contents[1].parts, [{ text: '第一版' }], '原生 parts 原样回传');
    assert.deepEqual(body.systemInstruction, { parts: [{ text: '规则' }] });
    assert.equal(body.generationConfig.maxOutputTokens, 32000);
  });

  test('没配思考预算就完全不发这个字段', () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([]) });
    const body = p.buildBody({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.ok(!('thinkingConfig' in body.generationConfig), '发一个可能不被接受的字段比不发更容易出错');

    const budgeted = new GeminiProvider({ ...AI, geminiThinkingBudget: 8000 }, { fetchImpl: fakeFetch([]) });
    const b2 = budgeted.buildBody({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.equal(b2.generationConfig.thinkingConfig.thinkingBudget, 8000);
  });

  test('key 走请求头,绝不进查询串', async () => {
    const fetchImpl = fakeFetch([okResponse(reply('好'))]);
    const p = new GeminiProvider(AI, { fetchImpl });
    await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    const { url, headers } = fetchImpl.calls[0];
    assert.equal(headers['x-goog-api-key'], 'test-key');
    assert.ok(!url.includes('test-key'), '查询串会进日志、进错误上报');
    assert.match(url, /streamGenerateContent\?alt=sse$/);
  });
});

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

describe('错误信息要能照着做', () => {
  test('404 指向 --models,而不是让人去猜模型名', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(404, { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /--models/);
      assert.equal(e.retryable, false);
      return true;
    });
  });

  test('429 说清楚免费层有每天那道上限', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded, limit: 500' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /每天/);
      assert.equal(e.retryable, true);
      return true;
    });
  });

  test('limit: 0 是"这个模型不在这一档",不是"用完了" —— 而且不可重试', async () => {
    // 实测踩到的(2026-08-10):免费层对 gemini-2.5-pro 就是 limit: 0。
    // 两件事 Google 用同一个 429 报回来,混为一谈会让人白等一天,
    // 而且退避重试三次纯属浪费
    const msg = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro';
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: msg } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.equal(e.retryable, false, '等多久都不会恢复,重试没有意义');
      assert.match(e.message, /不是用完了/);
      assert.match(e.message, /--models/, '得告诉人怎么找一个能用的模型');
      assert.doesNotMatch(e.message, /次日重置/, '说"等次日重置"会让人白等一天');
      return true;
    });
  });

  test('工具相关的 400 指向 geminiTools 这个配置项', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(400, { error: { message: 'Unknown tool: url_context', status: 'INVALID_ARGUMENT' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), /geminiTools/);
  });

  test('错误信息里不会带上 API key', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(403, { error: { message: 'bad key', status: 'PERMISSION_DENIED' } })]) });
    await assert.rejects(
      p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
      (e) => !e.message.includes('test-key')
    );
  });

  test('没有 key 就直接拒绝构造,并指到免费额度怎么申请', () => {
    assert.throws(() => new GeminiProvider({ model: 'gemini-2.5-pro' }), /aistudio\.google\.com/);
  });
});

// ---------------------------------------------------------------------------
// 和公共层接得上
// ---------------------------------------------------------------------------

test('多轮会话:历史原样回传,用量跨轮累加', async () => {
  const fetchImpl = fakeFetch([okResponse(reply('第一版')), okResponse(reply('改好了'))]);
  const p = new GeminiProvider(AI, { fetchImpl });
  const s = createSession(p, { system: '规则', tools: p.webTools() });

  await s.ask('写一份');
  await s.ask('这几条没过');

  assert.equal(s.messages.length, 4);
  // 第二次请求带着完整历史,assistant 那轮被翻译成 model
  assert.deepEqual(fetchImpl.calls[1].body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(s.usage.requests, 2);
  assert.equal(s.usage.outputTokens, 100);
  assert.equal(s.cost().priced, false, 'Gemini 故意不进价格表:免费层是 0,付费层单价没核实过');
});
