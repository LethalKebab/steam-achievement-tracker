/**
 * DeepSeek 供应商的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这一家最要紧的性质不是协议细节,是**它没有服务端联网搜索**——而设计文档把
 * "有服务端搜索"定成硬性准入,理由是"混进一家没有搜索的,会让质量取决于用户选了谁,
 * 而用户看不出这个差别"。
 *
 * 所以这个文件钉的第一件事就是 `canSearch === false` 一路传得下去:提示词会换成
 * "你没有联网能力"那一版,结果里带着 `researched` 标记。这条链断在任何一环,
 * 都会变成"用户拿到一份看起来正常、其实没查过任何资料的攻略"——正是那条准入要防的事。
 *
 * 其余钉的还是"记错了会悄悄错"的那类:
 *
 *  - **`reasoning_content` 混进正文**。deepseek-reasoner 把思维链和正文放在同一个 delta
 *    的两个字段上,漏判一次就把思考过程写进用户的攻略文件(和 Gemini 的 thought 同类)
 *  - **usage 字段映射**,以及缓存命中的 token 不能和输入重复计一遍
 *  - **认不出的 finish_reason 落到 other**,不当成功
 *  - **402 余额不足不可重试** —— 和限流完全不是一回事,重试永远不会好
 *
 * 全部离线。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { emptyUsage, checkResult, createSession } from '../lib/ai.js';
import { DeepseekProvider, createDeepseekAccumulator, mergeDeepseekUsage } from '../lib/ai-deepseek.js';
import { buildSystemPrompt } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function sseBody(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
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

const AI = { apiKey: 'test-key', model: 'deepseek-chat', maxTokens: 8000, maxRetries: 0 };

const reply = (text, finish = 'stop') => [
  { model: 'deepseek-chat', choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50 } },
];

// ---------------------------------------------------------------------------
// 没有联网:这是这一家最要紧的性质
// ---------------------------------------------------------------------------

describe('canSearch = false 要一路传得下去', () => {
  test('供应商自己声明没有联网,工具列表是空的', () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([]) });
    assert.equal(p.canSearch, false);
    assert.deepEqual(p.webTools(), []);
  });

  test('searchQueries 永远是空的,而且是结构性的空', async () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([okResponse(reply('好'))]) });
    const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.deepEqual(r.searchQueries, []);
  });

  test('提示词换成"你没有联网能力"那一版,而且要求宁可留空也别编', () => {
    const defs = [{ api_name: 'A', name_cn: '第一步', name_en: '', description: '完成第一关。' }];
    const online = buildSystemPrompt('测试游戏', '1', defs, { canSearch: true });
    const offline = buildSystemPrompt('测试游戏', '1', defs, { canSearch: false });

    assert.match(online, /先上网搜/);
    assert.doesNotMatch(online, /没有联网能力/);

    assert.match(offline, /没有搜索和抓取网页的工具/);
    assert.match(offline, /留空是合格的结果/, '不这么说的话,模型会为了显得完整而每条都编一段');
    assert.doesNotMatch(offline, /先上网搜/, '没有工具还叫它上网搜,只会让它假装查过');
  });

  test('两版提示词的硬规则部分完全一样(格式要求不因为没联网而放宽)', () => {
    const defs = [{ api_name: 'A', name_cn: '第一步', name_en: '', description: 'x' }];
    const head = (s) => s.slice(0, s.indexOf('## 怎么查资料') >= 0 ? s.indexOf('## 怎么查资料') : s.indexOf('## 你这次没有联网能力'));
    assert.equal(
      head(buildSystemPrompt('g', '1', defs, { canSearch: true })),
      head(buildSystemPrompt('g', '1', defs, { canSearch: false }))
    );
  });
});

// ---------------------------------------------------------------------------
// 思维链
// ---------------------------------------------------------------------------

test('reasoning_content 不能混进正文(否则思维链会被写进攻略文件)', () => {
  const acc = createDeepseekAccumulator();
  acc.push({ choices: [{ delta: { reasoning_content: '让我想想这个成就……' } }] });
  acc.push({ choices: [{ delta: { content: '- [ ] **第一步**' } }] });
  acc.push({ choices: [{ delta: { reasoning_content: '还要检查一下' } }] });
  acc.push({ choices: [{ delta: { content: '<br>完成第一关。' } }] });
  const r = acc.result();
  assert.equal(r.text, '- [ ] **第一步**<br>完成第一关。');
  assert.match(r.thinking, /让我想想/, '思维链本身留着,只是不进正文');
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe('usage', () => {
  test('字段映射对得上', () => {
    const u = emptyUsage();
    mergeDeepseekUsage(u, { prompt_tokens: 1200, completion_tokens: 800 });
    assert.equal(u.inputTokens, 1200);
    assert.equal(u.outputTokens, 800);
  });

  test('缓存命中的 token 不重复计进输入', () => {
    // prompt_tokens 已经含了命中部分,直接两边都记会让同一批 token 算两遍
    const u = emptyUsage();
    mergeDeepseekUsage(u, { prompt_tokens: 1000, prompt_cache_hit_tokens: 700, completion_tokens: 50 });
    assert.equal(u.cacheReadTokens, 700);
    assert.equal(u.inputTokens, 300);
  });

  test('每个 chunk 报累计值,所以是覆盖不是累加', () => {
    const u = emptyUsage();
    mergeDeepseekUsage(u, { completion_tokens: 10 });
    mergeDeepseekUsage(u, { completion_tokens: 900 });
    assert.equal(u.outputTokens, 900);
  });
});

// ---------------------------------------------------------------------------
// 终止原因
// ---------------------------------------------------------------------------

describe('finish_reason 归一化', () => {
  const run = async (chunks) => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([okResponse(chunks)]) });
    return p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  };

  test('stop → end_turn', async () => {
    const r = await run(reply('好的'));
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.text, '好的');
    assert.equal(checkResult(r).ok, true);
  });

  test('length → max_tokens,有正文也不算写完', async () => {
    const r = await run(reply('写到一半', 'length'));
    assert.equal(r.stopReason, 'max_tokens');
    assert.match(checkResult(r).reason, /截断/);
  });

  test('content_filter → refusal', async () => {
    const r = await run(reply('', 'content_filter'));
    assert.equal(r.stopReason, 'refusal');
    assert.equal(checkResult(r).ok, false);
  });

  test('认不出的终止原因落到 other,不当成功', async () => {
    const r = await run(reply('半截', 'some_future_reason'));
    assert.equal(r.stopReason, 'other');
    assert.equal(r.rawStopReason, 'some_future_reason');
    assert.equal(checkResult(r).ok, false);
  });
});

// ---------------------------------------------------------------------------
// 请求组装
// ---------------------------------------------------------------------------

describe('请求组装', () => {
  test('system 是 messages 里的一条,不是单独字段', () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([]) });
    const body = p.buildBody({
      system: '规则',
      messages: [
        { role: 'user', content: '写一份' },
        { role: 'assistant', content: '第一版' },
        { role: 'user', content: '重写' },
      ],
    });
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(body.messages[0].content, '规则');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true }, '不加这个流式模式下拿不到 usage');
  });

  test('key 走 Authorization 头', async () => {
    const fetchImpl = fakeFetch([okResponse(reply('好'))]);
    const p = new DeepseekProvider(AI, { fetchImpl });
    await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer test-key');
    assert.match(fetchImpl.calls[0].url, /\/chat\/completions$/);
  });

  test('baseUrl 可配置(兼容自建/代理端点)', () => {
    const p = new DeepseekProvider({ ...AI, baseUrl: 'https://proxy.example.com/v1/' }, { fetchImpl: fakeFetch([]) });
    assert.equal(p.baseUrl, 'https://proxy.example.com/v1');
  });
});

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

describe('错误', () => {
  test('402 余额不足不可重试 —— 和限流完全不是一回事', async () => {
    const p = new DeepseekProvider({ ...AI, maxRetries: 3 }, {
      fetchImpl: fakeFetch([errResponse(402, { error: { message: 'Insufficient Balance', type: 'insufficient_balance' } })]),
    });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.equal(e.retryable, false, '余额问题重试永远不会好');
      assert.match(e.message, /余额不足/);
      return true;
    });
  });

  test('错误信息里不会带上 API key', async () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([errResponse(401, { error: { message: 'bad key' } })]) });
    await assert.rejects(
      p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
      (e) => !e.message.includes('test-key')
    );
  });

  test('没有 key 就直接拒绝构造', () => {
    assert.throws(() => new DeepseekProvider({ model: 'deepseek-chat' }), /DEEPSEEK_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// 和公共层接得上
// ---------------------------------------------------------------------------

test('多轮会话:历史留着,用量跨轮累加', async () => {
  const fetchImpl = fakeFetch([okResponse(reply('第一版')), okResponse(reply('改好了'))]);
  const p = new DeepseekProvider(AI, { fetchImpl });
  const s = createSession(p, { system: '规则', tools: p.webTools() });

  await s.ask('写一份');
  await s.ask('这几条没过');

  assert.equal(s.messages.length, 4);
  assert.deepEqual(
    fetchImpl.calls[1].body.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user']
  );
  assert.equal(s.usage.requests, 2);
  assert.equal(s.usage.outputTokens, 100);
});
