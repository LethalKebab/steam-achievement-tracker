/**
 * lib/ai.js 的测试
 * ------------------------------------------------
 * 这个文件防的是一类特定的失败:**长得像成功的失败**。
 *
 * 前五个测试文件各自守一样东西(matching 守笔记、selection 守数据、checkbox-selection
 * 守调用量、guide-status 守幂等、guidelint 守假阳性)。这一个守**账和"以为成功了"**:
 *
 *  - usage 在一条消息内是覆盖、跨消息才是累加。搞反了费用永远偏高,而且没有任何地方会报错
 *  - 没有价格表的模型必须报 null,不能报 $0.00——悄悄显示 0 是最糟的那种错数字
 *  - web_search 出错时 content 是**对象**、成功时是**数组**。不分支就把"被限流"读成
 *    "搜到空结果",模型接着空手写攻略
 *  - refusal 和 max_tokens 都是 HTTP 200。前者 content 空、后者正文被砍一半,
 *    而一份截断的攻略比一次失败更糟
 *  - pause_turn 续跑不能补一句"继续"(会打断服务端的工具循环),前几轮的 content
 *    也不能丢(资料就在里面)
 *
 * 全部离线:fetch 是注入的,一个字节都不发出去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnthropicProvider,
  createAccumulator,
  emptyUsage,
  mergeMessageUsage,
  addUsage,
  estimateCost,
  serverToolErrors,
  buildWebTools,
  checkResult,
  createSession,
} from '../lib/ai.js';

// ---------------------------------------------------------------------------
// 假的 fetch:把事件数组变成一条 SSE 流
// ---------------------------------------------------------------------------

/** 故意切成 7 字节一块——既拆开事件、也拆开多字节汉字,顺带验解码器 */
function sseBody(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7);
  })();
}

function okResponse(events) {
  return { ok: true, status: 200, headers: new Headers(), body: sseBody(events) };
}

function errResponse(status, body) {
  return {
    ok: false,
    status,
    headers: new Headers({ 'request-id': 'req_test' }),
    text: async () => JSON.stringify(body),
  };
}

/** 记下每次调用的请求体,按顺序返回预设响应 */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[calls.length - 1];
    if (!r) throw new Error(`没有为第 ${calls.length} 次调用准备响应`);
    return r;
  };
  fn.calls = calls;
  return fn;
}

const AI = {
  apiKey: 'test-key',
  model: 'claude-opus-5',
  effort: 'high',
  maxTokens: 32000,
  maxSearches: 8,
  maxFetches: 10,
  maxFetchTokens: 50000,
  allowedDomains: [],
  maxContinuations: 5,
  maxRetries: 0,
};

/** 一条最简单的完整消息 */
function simpleMessage({ text = '好', stopReason = 'end_turn', usage = {} } = {}) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 50, ...usage } },
  ];
}

// ---------------------------------------------------------------------------
// usage:消息内覆盖,跨消息累加
// ---------------------------------------------------------------------------

test('一条消息内的 usage 是覆盖不是累加(output_tokens 不能算两遍)', () => {
  const u = emptyUsage();
  // message_start 报的 output_tokens 是个初值,message_delta 那个才是最终值
  mergeMessageUsage(u, { input_tokens: 1000, output_tokens: 1 });
  mergeMessageUsage(u, { output_tokens: 800 });
  assert.equal(u.outputTokens, 800, '相加会变成 801,费用就一路偏高');
  assert.equal(u.inputTokens, 1000, 'message_delta 没报 input,不能被清零');
});

test('跨消息的 usage 是累加(pause_turn 续跑的每一段都要算钱)', () => {
  const total = emptyUsage();
  addUsage(total, { ...emptyUsage(), inputTokens: 100, outputTokens: 50, requests: 1 });
  addUsage(total, { ...emptyUsage(), inputTokens: 200, outputTokens: 70, requests: 1 });
  assert.equal(total.inputTokens, 300);
  assert.equal(total.outputTokens, 120);
  assert.equal(total.requests, 2);
});

test('搜索次数从 server_tool_use 里读出来', () => {
  const u = emptyUsage();
  mergeMessageUsage(u, { output_tokens: 10, server_tool_use: { web_search_requests: 3 } });
  assert.equal(u.webSearches, 3);
});

// ---------------------------------------------------------------------------
// 估价
// ---------------------------------------------------------------------------

test('估价按 Opus 5 单价算,缓存写 1.25 倍、读 0.1 倍', () => {
  const u = { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  const c = estimateCost(u, 'claude-opus-5');
  assert.equal(c.priced, true);
  // 5 + 5*1.25 + 5*0.1 + 25 = 36.75
  assert.equal(Number(c.usd.toFixed(2)), 36.75);
});

test('价格表里没有的模型报 null,不报 0', () => {
  const u = { ...emptyUsage(), inputTokens: 999_999, outputTokens: 999_999 };
  const c = estimateCost(u, 'some-future-model');
  assert.equal(c.priced, false);
  assert.equal(c.usd, null, '报 0 等于告诉用户这次不花钱,那是最糟的错数字');
});

test('搜索次数如实返回,但不折算成钱(搜索计费还没实测)', () => {
  const c = estimateCost({ ...emptyUsage(), outputTokens: 1000, webSearches: 5 }, 'claude-opus-5');
  assert.equal(c.webSearches, 5);
  // 1000 output token = $0.025,和搜索次数无关
  assert.equal(Number(c.usd.toFixed(3)), 0.025);
});

// ---------------------------------------------------------------------------
// SSE 累加器
// ---------------------------------------------------------------------------

test('文本增量拼得回来,工具入参的流式 JSON 解析得出来', () => {
  const acc = createAccumulator();
  for (const ev of [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先搜' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '再抓' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"空之轨迹 成就"}' } },
    { type: 'content_block_stop', index: 1 },
  ]) acc.push(ev);

  const { content } = acc.result();
  assert.equal(content[0].text, '先搜再抓');
  assert.deepEqual(content[1].input, { query: '空之轨迹 成就' });
  assert.ok(!('__json' in content[1]), '拼 JSON 的草稿字段必须删掉,不然会被原样回传给 API');
});

test('流里的 error 事件按可重试/不可重试分类', () => {
  const acc = createAccumulator();
  assert.throws(
    () => acc.push({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    (e) => e.retryable === true
  );
});

// ---------------------------------------------------------------------------
// 服务端工具的错误:成功是数组,失败是对象
// ---------------------------------------------------------------------------

test('web_search 失败时 content 是对象,不能当数组取下标', () => {
  const content = [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
  ];
  const errs = serverToolErrors(content);
  assert.equal(errs.length, 2, '成功那条不该被算成失败');
  assert.deepEqual(errs.map((e) => e.errorCode), ['max_uses_exceeded', 'url_not_accessible']);
});

// ---------------------------------------------------------------------------
// 请求组装
// ---------------------------------------------------------------------------

test('请求体不带那四个会 400 的参数,而且必须是流式', () => {
  const p = new AnthropicProvider(AI, { fetchImpl: fakeFetch([]) });
  const body = p.buildBody({ system: '规则', messages: [{ role: 'user', content: '写' }], tools: buildWebTools(AI) });

  for (const banned of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(banned in body), `${banned} 在 Opus 5 上是 400,不是被忽略`);
  }
  assert.ok(!('budget_tokens' in body.thinking), 'budget_tokens 同样是 400');
  assert.equal(body.stream, true, '非流式会先撞上 HTTP 超时,不是撞上 token 上限');
  assert.equal(body.output_config.effort, 'high');
});

test('system 最后一块打了 cache_control(回灌重写靠它省钱)', () => {
  const p = new AnthropicProvider(AI, { fetchImpl: fakeFetch([]) });
  const body = p.buildBody({ system: '一大段规则', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(body.system.at(-1).cache_control, { type: 'ephemeral' });
});

test('联网工具用 _20260209 版,而且绝不额外声明 code_execution', () => {
  const tools = buildWebTools(AI);
  assert.deepEqual(tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.ok(!tools.some((t) => String(t.type).startsWith('code_execution')),
    '这版工具内部已经跑代码做动态过滤,再加一个等于两套执行环境');
  assert.deepEqual(tools[1].citations, { enabled: false }, 'SKILL.md 规则七:攻略里不写数据来源');
});

test('allowedDomains 为空时不下发(空数组会被当成"什么都不许搜")', () => {
  const tools = buildWebTools({ ...AI, allowedDomains: [] });
  assert.ok(!('allowed_domains' in tools[0]));
  const locked = buildWebTools({ ...AI, allowedDomains: ['gamersky.com'] });
  assert.deepEqual(locked[0].allowed_domains, ['gamersky.com']);
});

// ---------------------------------------------------------------------------
// 整条循环
// ---------------------------------------------------------------------------

test('普通一轮:拿到正文和用量,只发一次请求', async () => {
  const fetchImpl = fakeFetch([okResponse(simpleMessage({ text: '按 F 键' }))]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: buildWebTools(AI) });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(r.text, '按 F 键');
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.usage.inputTokens, 100);
  assert.equal(r.usage.outputTokens, 50);
  assert.equal(r.usage.requests, 1);
  assert.equal(checkResult(r).ok, true);
});

test('pause_turn 续跑:不补"继续",前一轮的 content 也不丢', async () => {
  const first = [
    { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"a"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } } },
  ];
  const fetchImpl = fakeFetch([okResponse(first), okResponse(simpleMessage({ text: '结论' }))]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: buildWebTools(AI) });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(r.continuations, 1);

  // 第二次请求:user 之后必须紧接着 assistant,中间不能塞一条"继续"
  const second = fetchImpl.calls[1].body.messages;
  assert.equal(second.length, 2);
  assert.equal(second[0].role, 'user');
  assert.equal(second[1].role, 'assistant', '多塞一条 user 会打断服务端的工具循环');

  // 两段 content 都要在,搜索那段丢了就等于把资料丢了
  assert.equal(r.content.filter((b) => b.type === 'server_tool_use').length, 1);
  assert.equal(r.text, '结论');
  // 用量是两次相加
  assert.equal(r.usage.inputTokens, 200);
  assert.equal(r.usage.outputTokens, 90);
  assert.equal(r.usage.requests, 2);
});

test('续跑超过上限就报错,不无限转', async () => {
  const paused = () => okResponse([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } },
  ]);
  const fetchImpl = fakeFetch([paused(), paused(), paused()]);
  const p = new AnthropicProvider({ ...AI, maxContinuations: 1 }, { fetchImpl });
  await assert.rejects(
    p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
    /续跑/
  );
});

// ---------------------------------------------------------------------------
// "长得像成功"的三种失败
// ---------------------------------------------------------------------------

test('refusal 是 HTTP 200,必须先看 stop_reason 再读正文', async () => {
  const fetchImpl = fakeFetch([okResponse([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 10 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 0 } },
  ])]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.stopReason, 'refusal');
  const v = checkResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /拒答/);
});

test('max_tokens 截断:有正文,但不能当成写完了', async () => {
  const fetchImpl = fakeFetch([okResponse(simpleMessage({ text: '前半段', stopReason: 'max_tokens' }))]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.text, '前半段', '正文确实有——这正是它危险的地方');
  const v = checkResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /截断/);
});

test('工具报错也是 HTTP 200,这轮的资料是不完整的', async () => {
  const fetchImpl = fakeFetch([okResponse([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我猜是这样' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
  ])]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.stopReason, 'end_turn', '停止原因是正常的,骗人的正是这一点');
  assert.equal(checkResult(r).ok, false);
});

// ---------------------------------------------------------------------------
// HTTP 错误分类
// ---------------------------------------------------------------------------

test('400 不重试(请求本身写错了,重试改不了),错误信息带得出 API 原话', async () => {
  const fetchImpl = fakeFetch([errResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected beta' }, request_id: 'req_x' })]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  await assert.rejects(
    p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
    (e) => {
      assert.equal(e.retryable, false);
      assert.equal(e.requestId, 'req_x');
      assert.match(e.message, /unexpected beta/);
      assert.match(e.message, /fallbacks/, 'beta 头相关的 400 要提示关掉哪个开关');
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1, '不该重试');
});

test('429 / 5xx 判成可重试', async () => {
  for (const status of [429, 500, 529]) {
    const fetchImpl = fakeFetch([errResponse(status, { type: 'error', error: { type: 'x', message: 'y' } })]);
    const p = new AnthropicProvider(AI, { fetchImpl });
    await assert.rejects(
      p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
      (e) => e.retryable === true
    );
  }
});

test('错误信息里不会带上 API key', async () => {
  const fetchImpl = fakeFetch([errResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  await assert.rejects(
    p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
    (e) => !e.message.includes(AI.apiKey)
  );
});

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

test('多轮会话:历史留着(回灌重写要用),用量跨轮累加', async () => {
  const fetchImpl = fakeFetch([
    okResponse(simpleMessage({ text: '第一版' })),
    okResponse(simpleMessage({ text: '改好了' })),
  ]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const s = createSession(p, { system: '规则', tools: buildWebTools(AI) });

  await s.ask('写一份');
  await s.ask('这几条没过:...');

  assert.equal(s.messages.length, 4, 'user/assistant 各两条');
  // 第二次请求带着完整历史,才能命中前缀缓存、也才知道上一版写了什么
  assert.equal(fetchImpl.calls[1].body.messages.length, 3);
  assert.equal(s.usage.requests, 2);
  assert.equal(s.usage.outputTokens, 100);
  assert.equal(s.cost().priced, true);
});
