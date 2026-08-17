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
 *  - 而 **web_fetch 成功时 content 也是对象**。把 web_search 那条规则套到它身上,
 *    每一次成功抓页都会被读成失败 —— 反方向的同一个 bug,而且是真炸过的那个
 *  - refusal 和 max_tokens 都是 HTTP 200。前者 content 空、后者正文被砍一半,
 *    而一份截断的攻略比一次失败更糟
 *  - pause_turn 续跑不能补一句"继续"(会打断服务端的工具循环),前几轮的 content
 *    也不能丢(资料就在里面)
 *
 * 全部离线:fetch 是注入的,一个字节都不发出去。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyUsage,
  formatUsage,
  mergeMessageUsage,
  addUsage,
  checkResult,
  createSession,
} from '../lib/ai.js';
import { AnthropicProvider, createAccumulator, serverToolErrors } from '../lib/ai-anthropic.js';

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

/** 联网工具声明现在挂在供应商身上(每家形状不同),测试里包一层省得到处 new */
const webTools = (ai) => new AnthropicProvider(ai, { fetchImpl: fakeFetch([]) }).webTools();

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
// 用量摘要
// ---------------------------------------------------------------------------

// 这里以前有三条估价测试(内置单价表、表里没有的模型报 null 而不是 0、
// 搜索次数不折算成钱)。**估价整套删了**:各家单价会变、我们核实不过来,
// 搜索工具怎么计费也从没实测 —— 一个不知道错多少的金额比不给金额更糟。
// 剩下的只有 token,而 token 是 API 回的硬数字,没什么可估的。
test('摘要只报 token 和请求数,不出现金额', () => {
  const u = { ...emptyUsage(), requests: 2, inputTokens: 1234, outputTokens: 567, webSearches: 3 };
  const line = formatUsage(u);
  assert.match(line, /1234/);
  assert.match(line, /567/);
  assert.match(line, /联网搜索 3 次/);
  assert.ok(!line.includes('$'), '不能再出现美元 —— 那正是删掉的原因');
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
// 服务端工具:**两个工具的「成功」形状不一样**
// ---------------------------------------------------------------------------

/** 成功抓页的真实形状:一个**对象**。整个 bug 就长在这一行上 */
const FETCH_OK = {
  type: 'web_fetch_tool_result',
  content: {
    type: 'web_fetch_result',
    url: 'https://www.3dmgame.com/gl/1.html',
    retrieved_at: '2026-08-13T00:00:00Z',
    content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '页面全文' } },
  },
};

test('web_search 失败时 content 是对象,不能当数组取下标', () => {
  const content = [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
  ];
  const errs = serverToolErrors(content);
  assert.equal(errs.length, 2, '成功那条不该被算成失败');
  assert.deepEqual(errs.map((e) => e.errorCode), ['max_uses_exceeded', 'url_not_accessible']);
  assert.deepEqual(errs.map((e) => e.tool), ['search', 'fetch'], 'tool 是中立词,不外泄块名');
});

test('web_fetch 成功时 content 也是对象——判成功不能靠 Array.isArray', () => {
  // 回归测试。曾经两个工具共用 `Array.isArray` 判成功,于是每一次**成功**抓页都被记成
  // 一条错误,错误码是成功块自己的 type(`web_fetch_result`),而 checkResult 见到
  // 任何工具错误就枪毙整轮。web_fetch 只在官方端点默认开着,而此前跑通的实盘全在
  // DeepSeek 兼容端点上(那里它默认关着)—— 所以这个 bug 一路跑到用户手上才炸
  assert.deepEqual(serverToolErrors([FETCH_OK]), []);
});

test('认不出的结果形状按失败算,不默认放行', () => {
  // 方向是故意的:少写一次攻略,好过悄悄拿半份资料写一份看着正常的攻略
  const errs = serverToolErrors([{ type: 'web_fetch_tool_result', content: { type: '将来某个新形状' } }]);
  assert.deepEqual(errs, [{ tool: 'fetch', errorCode: '将来某个新形状' }]);
});

test('进度事件:成功抓页是 ok,不是「失败(unknown)」', async () => {
  const fetchImpl = fakeFetch([okResponse([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: FETCH_OK },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ])]);
  const events = [];
  const p = new AnthropicProvider(AI, { fetchImpl });
  await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], onEvent: (ev) => events.push(ev) });
  assert.deepEqual(
    events.filter((e) => e.type === 'tool-result').map((e) => ({ ok: e.ok, tool: e.tool, errorCode: e.errorCode })),
    [{ ok: true, tool: 'fetch', errorCode: null }],
    '判断和 serverToolErrors 共用一份,两边不该再各写一次'
  );
});

// ---------------------------------------------------------------------------
// 请求组装
// ---------------------------------------------------------------------------

test('请求体不带那四个会 400 的参数,而且必须是流式', () => {
  const p = new AnthropicProvider(AI, { fetchImpl: fakeFetch([]) });
  const body = p.buildBody({ system: '规则', messages: [{ role: 'user', content: '写' }], tools: webTools(AI) });

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
  const tools = webTools(AI);
  assert.deepEqual(tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.ok(!tools.some((t) => String(t.type).startsWith('code_execution')),
    '这版工具内部已经跑代码做动态过滤,再加一个等于两套执行环境');
  assert.deepEqual(tools[1].citations, { enabled: false }, 'SKILL.md 规则七:攻略里不写数据来源');
});

test('allowedDomains 为空时不下发(空数组会被当成"什么都不许搜")', () => {
  const tools = webTools({ ...AI, allowedDomains: [] });
  assert.ok(!('allowed_domains' in tools[0]));
  const locked = webTools({ ...AI, allowedDomains: ['gamersky.com'] });
  assert.deepEqual(locked[0].allowed_domains, ['gamersky.com']);
});

// ---------------------------------------------------------------------------
// 整条循环
// ---------------------------------------------------------------------------

test('普通一轮:拿到正文和用量,只发一次请求', async () => {
  const fetchImpl = fakeFetch([okResponse(simpleMessage({ text: '按 F 键' }))]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: webTools(AI) });

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
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: webTools(AI) });

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

test('抓页失败只报不拦——但必须报', () => {
  // `url_not_allowed`(模型自己拼的 URL,只能抓已出现在对话里的)和 `url_not_accessible`
  // (404 / 反爬 / 超时)在一次正常研究里几乎必然出现几条。搜了十页、抓失败两页,
  // 资料是够的;作废整轮等于把常态当故障,而代价是用户已经付掉的几分钟和 token
  const v = checkResult({
    stopReason: 'end_turn',
    text: '- [ ] **成就**',
    usage: emptyUsage(),
    toolErrors: [
      { tool: 'fetch', errorCode: 'url_not_allowed' },
      { tool: 'fetch', errorCode: 'url_not_accessible' },
    ],
  });
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 1, '不拦路不等于可以不吭声');
  assert.match(v.warnings[0], /url_not_allowed、url_not_accessible/);
});

test('搜索失败照样枪毙整轮,哪怕同一轮里抓页也失败了', () => {
  // 搜索是研究的入口:它没成,模型就是凭记忆写的。两种错误混在一起时,
  // 拦路的原因里也不该混进不拦路的那条——否则报错指向的是错的那个问题
  const v = checkResult({
    stopReason: 'end_turn',
    text: '有正文',
    usage: emptyUsage(),
    toolErrors: [
      { tool: 'fetch', errorCode: 'url_not_accessible' },
      { tool: 'search', errorCode: 'max_uses_exceeded' },
    ],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /max_uses_exceeded/);
  assert.ok(!v.reason.includes('url_not_accessible'), '拦路原因里不该混进不拦路的那条');
});

describe('「没有正文」必须带上「那到底回来了什么」', () => {
  // 这是这条路上最难查的一种失败:HTTP 200、没有工具错误、停止原因也正常,就是一个
  // text 块都没有。而回包的形状指向完全不同的处置 —— 光一句"没有输出任何正文",
  // 下一次撞上还是只能猜,而每一次猜都要花掉用户几分钟和一笔 token 才能验一遍。
  // 实测撞到过三次(最近一次 KINGDOM HEARTS,197 个成就第 3/4 段)
  const empty = (over) => checkResult({
    stopReason: 'end_turn', rawStopReason: 'end_turn', text: '   ',
    usage: { ...emptyUsage(), outputTokens: 0 }, toolErrors: [], content: [], ...over,
  });

  test('额度被思考吃光:thinking 块 + 一大笔 output token', () => {
    const v = empty({
      usage: { ...emptyUsage(), outputTokens: 31980 },
      content: [{ type: 'thinking', thinking: '想了很久' }],
    });
    assert.equal(v.code, 'empty');
    // 这三个数字合起来就是诊断:有 thinking、没有 text、产出接近上限
    // ⇒ 和截断是一回事,该切小,而不是"再问一次"
    assert.match(v.reason, /thinking×1/);
    assert.match(v.reason, /31980 token/);
  });

  test('单纯抽风:一个块都没有、0 token —— 和上面那种要能分得开', () => {
    const v = empty();
    assert.match(v.reason, /一个块都没有/);
    assert.match(v.reason, /0 token/);
  });

  test('光搜没写:报得出 server_tool_use 的个数', () => {
    const v = empty({
      content: [
        { type: 'server_tool_use', name: 'web_search' },
        { type: 'web_search_tool_result', content: [] },
        { type: 'server_tool_use', name: 'web_search' },
      ],
    });
    assert.match(v.reason, /server_tool_use×2/);
    assert.match(v.reason, /web_search_tool_result×1/);
  });

  test('原始停止原因要原样带上 —— 归一化之后那个词看不出是哪家说的什么', () => {
    // STOP_MAP 把 tool_use / stop_sequence 都归到 end_turn,而兼容端点还可能给出
    // 我们没见过的词。归一化后的值答不了"供应商到底说了什么"
    assert.match(empty({ rawStopReason: 'COMPLETE' }).reason, /COMPLETE/);
    assert.match(empty({ rawStopReason: undefined }).reason, /未知/);
  });
});

test('认不出 tool 的工具错误按拦路处理', () => {
  const v = checkResult({
    stopReason: 'end_turn',
    text: '有正文',
    usage: emptyUsage(),
    toolErrors: [{ tool: '将来某个新工具', errorCode: 'boom' }],
  });
  assert.equal(v.ok, false, '新供应商接进来时,宁可多拦一次也不要默认放行');
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
  const s = createSession(p, { system: '规则', tools: webTools(AI) });

  await s.ask('写一份');
  await s.ask('这几条没过:...');

  assert.equal(s.messages.length, 4, 'user/assistant 各两条');
  // 第二次请求带着完整历史,才能命中前缀缓存、也才知道上一版写了什么
  assert.equal(fetchImpl.calls[1].body.messages.length, 3);
  assert.equal(s.usage.requests, 2);
  assert.equal(s.usage.outputTokens, 100);
});

// ---------------------------------------------------------------------------
// 自定义端点
// ---------------------------------------------------------------------------

test('baseUrl 可配置 —— 指向 Anthropic 兼容端点时用它,不用写死的地址', async () => {
  // 实测(2026-08-10):DeepSeek 的 https://api.deepseek.com/anthropic 支持**服务端
  // web_search**(回包里有 server_tool_use / web_search_tool_result,usage 里有计数)。
  // 也就是说这一层原封不动就能给 DeepSeek 用上联网,不用另写一套
  const fetchImpl = fakeFetch([okResponse(simpleMessage({ text: '好' }))]);
  const p = new AnthropicProvider({ ...AI, baseUrl: 'https://api.deepseek.com/anthropic/' }, { fetchImpl });
  await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages', '结尾多余的斜杠要削掉');
});

test('配了 baseUrl 就不查模型名和供应商对不对得上', async () => {
  // provider=anthropic 指向 DeepSeek 的兼容端点时,模型就叫 deepseek-v4-flash。
  // 前缀检查在这种情况下只会误报
  const { assertModelMatchesProvider } = await import('../lib/ai.js');
  assert.throws(
    () => assertModelMatchesProvider('anthropic', 'deepseek-v4-flash'),
    (err) => {
      assert.match(err.message, /只改了其中一项/);
      // 正文会原样出现在 Dashboard 的浮窗上,那边的用户没有终端 —— 「加 --provider X」
      // 这类终端专属建议挂在 code 上,由 tracker.js 的 CLI_HINTS 补
      assert.equal(err.code, 'provider-model-mismatch');
      assert.deepEqual(err.detail, {
        provider: 'anthropic', model: 'deepseek-v4-flash', belongsTo: 'deepseek',
      });
      assert.doesNotMatch(err.message, /--provider|--model|config\.json|Remove-Item/);
      return true;
    }
  );
  assert.doesNotThrow(() =>
    assertModelMatchesProvider('anthropic', 'deepseek-v4-flash', { baseUrl: 'https://api.deepseek.com/anthropic' })
  );
});

// ---------------------------------------------------------------------------
// 供应商预设:好路径必须是默认
// ---------------------------------------------------------------------------

test('provider: deepseek 走的是**有联网**的那个端点', async () => {
  // DeepSeek 有两个端点:/anthropic 有服务端搜索,/chat/completions 没有。
  // 在这个预设之前,好路径要写成 provider: "anthropic" + 一个 DeepSeek 的 URL
  // (看起来像配错了),而直觉写法 provider: "deepseek" 反而给没联网的那个。
  // 好路径不该藏在反直觉的配置后面
  const { createProvider } = await import('../lib/ai.js');
  const p = await createProvider({ ai: { provider: 'deepseek', apiKey: 'k' } });
  assert.equal(p.canSearch, true);
  assert.equal(p.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.match(p.model, /^deepseek-/, '默认模型也要是 deepseek 的');
  assert.equal(p.name, 'deepseek', '报错里得说对是哪一家');

  // 没联网的那个仍然可达,但要显式点名
  const openai = await createProvider({ ai: { provider: 'deepseek-openai', apiKey: 'k' } });
  assert.equal(openai.canSearch, false);
  assert.equal(openai.name, 'deepseek-openai', '两个不能重名,否则报错时分不清');
});

test('预设不会盖掉用户显式配的 model / baseUrl', async () => {
  const { createProvider } = await import('../lib/ai.js');
  const p = await createProvider({
    ai: { provider: 'deepseek', apiKey: 'k', model: 'deepseek-v4-pro[1m]', baseUrl: 'https://proxy.example.com' },
  });
  assert.equal(p.model, 'deepseek-v4-pro[1m]');
  assert.equal(p.baseUrl, 'https://proxy.example.com');
});

test('config 的默认 model 必须是空的 —— 具体名字是供应商专属的', async () => {
  // 踩过:默认填 claude-opus-5,于是配了 provider: deepseek 但没填 model 的人,
  // 一定会撞上"供应商是 deepseek,模型名却是 anthropic 的"
  const { loadConfig } = await import('../lib/config.js');
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(loadConfig().ai.model, '', '填任何一家的具体模型名都会坑到用另一家的人');
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

test('401 报的是真实供应商和对应的环境变量,不是写死的 Anthropic', async () => {
  // 这一层也用来打 DeepSeek 的兼容端点。让人去查 ANTHROPIC_API_KEY 是指错方向
  const fetchImpl = fakeFetch([errResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'bad' } })]);
  const p = new AnthropicProvider(
    { ...AI, providerName: 'deepseek', providerEnvVar: 'DEEPSEEK_API_KEY' },
    { fetchImpl }
  );
  await assert.rejects(p.send({ messages: [{ role: 'user', content: 'q' }] }), (e) => {
    assert.match(e.message, /^deepseek API HTTP 401/);
    assert.match(e.message, /DEEPSEEK_API_KEY/);
    assert.doesNotMatch(e.message, /ANTHROPIC_API_KEY/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 花费上限
// ---------------------------------------------------------------------------
