/**
 * lib/ai.js
 * ------------------------------------------------
 * This file guards one specific class of failure: **failures that look like successes**.
 *
 * The first five test files each guard one thing (matching guards the notes, selection guards
 * the data, checkbox-selection guards the call volume, guide-status guards idempotency,
 * guidelint guards against false positives). This one guards **the bill and "I thought it
 * worked"**:
 *
 *  - usage overwrites within one message and only accumulates across messages. Reverse that and
 *    the cost is permanently too high, with nothing anywhere raising an error
 *  - a model with no price table has to report null, never $0.00 — quietly showing 0 is the
 *    worst kind of wrong number
 *  - when web_search fails, content is an **object**; when it succeeds it is an **array**.
 *    Without that branch, "rate limited" reads as "found nothing" and the model goes on to write
 *    the guide empty-handed
 *  - and **when web_fetch succeeds, content is also an object**. Apply the web_search rule to it
 *    and every successful fetch reads as a failure — the same bug in the opposite direction, and
 *    the one that really blew up
 *  - refusal and max_tokens are both HTTP 200. The former has empty content, the latter has the
 *    body cut in half, and a truncated guide is worse than a failed run
 *  - resuming a pause_turn must not add a "continue" message (it interrupts the server-side tool
 *    loop), and the earlier rounds' content must not be dropped (the research is inside it)
 *
 * Entirely offline: fetch is injected and not one byte goes out.
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
// A fake fetch: turn an array of events into one SSE stream
// ---------------------------------------------------------------------------

/** Deliberately sliced into 7-byte chunks — splitting events apart and multi-byte characters apart, verifying the decoder along the way */
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

/** Records the request body of every call and returns the prepared responses in order */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[calls.length - 1];
    if (!r) throw new Error(`no response prepared for call number ${calls.length}`);
    return r;
  };
  fn.calls = calls;
  return fn;
}

/** The web tool declaration now hangs off the provider (the shape differs per vendor), so this wrapper saves a `new` everywhere */
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

/** The simplest possible complete message */
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
// usage: overwrite within a message, accumulate across messages
// ---------------------------------------------------------------------------

test('usage within one message overwrites rather than accumulates (output_tokens must not be counted twice)', () => {
  const u = emptyUsage();
  // The output_tokens reported by message_start is an initial value; the one in message_delta is final
  mergeMessageUsage(u, { input_tokens: 1000, output_tokens: 1 });
  mergeMessageUsage(u, { output_tokens: 800 });
  assert.equal(u.outputTokens, 800, 'adding them gives 801, and the cost runs high forever after');
  assert.equal(u.inputTokens, 1000, 'message_delta reports no input, which must not zero it out');
});

test('usage across messages accumulates (every segment of a pause_turn resumption costs money)', () => {
  const total = emptyUsage();
  addUsage(total, { ...emptyUsage(), inputTokens: 100, outputTokens: 50, requests: 1 });
  addUsage(total, { ...emptyUsage(), inputTokens: 200, outputTokens: 70, requests: 1 });
  assert.equal(total.inputTokens, 300);
  assert.equal(total.outputTokens, 120);
  assert.equal(total.requests, 2);
});

test('the search count is read out of server_tool_use', () => {
  const u = emptyUsage();
  mergeMessageUsage(u, { output_tokens: 10, server_tool_use: { web_search_requests: 3 } });
  assert.equal(u.webSearches, 3);
});

// ---------------------------------------------------------------------------
// The usage summary
// ---------------------------------------------------------------------------

// There used to be three cost-estimation tests here (a built-in price table, a model missing
// from the table reporting null rather than 0, search counts not converted into money).
// **The whole estimation was removed**: vendor rates change, we cannot verify them, and how the
// search tool is billed was never measured — an amount wrong by an unknown margin is worse than
// no amount at all. What is left is tokens, and tokens are hard numbers the API returns, with
// nothing to estimate.
test('the summary reports only tokens and request counts, with no money in it', () => {
  const u = { ...emptyUsage(), requests: 2, inputTokens: 1234, outputTokens: 567, webSearches: 3 };
  const line = formatUsage(u);
  assert.match(line, /1234/);
  assert.match(line, /567/);
  assert.match(line, /联网搜索 3 次/);
  assert.ok(!line.includes('$'), 'a dollar sign must not appear again — that is exactly why it was removed');
});

// ---------------------------------------------------------------------------
// The SSE accumulator
// ---------------------------------------------------------------------------

test('text deltas join back together, and the streaming JSON of a tool input parses out', () => {
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
  assert.ok(!('__json' in content[1]), 'the JSON-assembly scratch field has to be deleted, or it goes back to the API verbatim');
});

test('an error event in the stream is classified as retryable or not', () => {
  const acc = createAccumulator();
  assert.throws(
    () => acc.push({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    (e) => e.retryable === true
  );
});

// ---------------------------------------------------------------------------
// Server-side tools: **the two tools' "success" shapes differ**
// ---------------------------------------------------------------------------

/** The real shape of a successful fetch: an **object**. The whole bug grew on this one line */
const FETCH_OK = {
  type: 'web_fetch_tool_result',
  content: {
    type: 'web_fetch_result',
    url: 'https://www.3dmgame.com/gl/1.html',
    retrieved_at: '2026-08-13T00:00:00Z',
    content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '页面全文' } },
  },
};

test('when web_search fails, content is an object and must not be indexed as an array', () => {
  const content = [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
  ];
  const errs = serverToolErrors(content);
  assert.equal(errs.length, 2, 'the successful one should not be counted as a failure');
  assert.deepEqual(errs.map((e) => e.errorCode), ['max_uses_exceeded', 'url_not_accessible']);
  assert.deepEqual(errs.map((e) => e.tool), ['search', 'fetch'], 'tool is a neutral word and does not leak the block name');
});

test('when web_fetch succeeds, content is an object too — success cannot be judged by Array.isArray', () => {
  // A regression test. The two tools once shared `Array.isArray` to judge success, so every
  // **successful** fetch was recorded as an error whose error code was the success block's own
  // type (`web_fetch_result`), and checkResult kills the whole round on seeing any tool error.
  // web_fetch is on by default only on the official endpoint, while every working real run was on
  // the DeepSeek compatible endpoint (where it is off by default) — so this bug ran all the way
  // to the user before it blew up
  assert.deepEqual(serverToolErrors([FETCH_OK]), []);
});

test('an unrecognised result shape counts as a failure rather than passing by default', () => {
  // The direction is deliberate: one guide not written beats quietly writing a normal-looking
  // guide from half the research
  const errs = serverToolErrors([{ type: 'web_fetch_tool_result', content: { type: '将来某个新形状' } }]);
  assert.deepEqual(errs, [{ tool: 'fetch', errorCode: '将来某个新形状' }]);
});

test('progress events: a successful fetch is ok, not "failed (unknown)"', async () => {
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
    'the judgement shares one copy with serverToolErrors, and should not be written twice again'
  );
});

// ---------------------------------------------------------------------------
// Assembling the request
// ---------------------------------------------------------------------------

test('the request body carries none of the four parameters that 400, and has to be streaming', () => {
  const p = new AnthropicProvider(AI, { fetchImpl: fakeFetch([]) });
  const body = p.buildBody({ system: '规则', messages: [{ role: 'user', content: '写' }], tools: webTools(AI) });

  for (const banned of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(banned in body), `${banned} is a 400 on Opus 5, not something ignored`);
  }
  assert.ok(!('budget_tokens' in body.thinking), 'budget_tokens is likewise a 400');
  assert.equal(body.stream, true, 'non-streaming hits the HTTP timeout first, not the token ceiling');
  assert.equal(body.output_config.effort, 'high');
});

/**
 * `thinking` / `output_config` / `fallbacks` used to ride one `anthropicExtras` switch, and that
 * switch asked "is this the official endpoint". The `provider: "deepseek"` preset always sets a
 * baseUrl, so `ai.effort` — the one the comment in config.js calls the depth knob — **was never
 * sent even once**.
 *
 * What is pinned is the separation itself. Merging them back raises no error: the request still
 * goes out and the guide is still written, only ten times slower, which is exactly why this bug
 * lived so long.
 */
describe('reasoning depth is an independent knob and does not follow the endpoint identity', () => {
  const KEY = { apiKey: 'k' };
  const DEEPSEEK = { ...KEY, baseUrl: 'https://api.deepseek.com/anthropic' };
  const build = (ai) =>
    new AnthropicProvider(ai, { fetchImpl: fakeFetch([]) })
      .buildBody({ system: 's', messages: [{ role: 'user', content: 'x' }] });

  test('on the compatible endpoint effort has to go out, while thinking does not', () => {
    const body = build({ ...DEEPSEEK, effort: 'low' });
    assert.deepEqual(body.output_config, { effort: 'low' },
      'effort is the only effective speed knob on this path and must not be swallowed just because the endpoint is not the official one');
    assert.ok(!('thinking' in body),
      'sending adaptive as well displaces effort: measured at the same effort:low, 43 seconds became 87');
  });

  test('the official endpoint behaviour has not changed by one character', () => {
    const body = build({ ...KEY, effort: 'high' });
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.fallbacks, 'default');
  });

  test('an unmeasured endpoint sends nothing by default — do not trade someone else availability for our speed', () => {
    const body = build({ ...KEY, baseUrl: 'https://someones-proxy.example/v1', effort: 'high' });
    assert.ok(!('output_config' in body) && !('thinking' in body),
      'whether a field is accepted is measured per endpoint and cannot be inferred. These endpoints are not taking it today');
    const opted = build({
      ...KEY, baseUrl: 'https://someones-proxy.example/v1', effort: 'high', anthropicExtras: true,
    });
    assert.deepEqual(opted.output_config, { effort: 'high' }, 'a self-hosted endpoint that does accept it needs a way in');
  });

  test('both knobs can be turned off individually', () => {
    assert.ok(!('output_config' in build({ ...KEY, effort: 'off' })), 'effort: off');
    assert.ok(!('thinking' in build({ ...KEY, effort: 'high', thinking: 'off' })), 'thinking: off');
  });

  test('thinking: disabled can be sent — but it turns search off along with it, so it is not a "faster high"', () => {
    const body = build({ ...DEEPSEEK, thinking: 'disabled', effort: 'low' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
  });

  test('budget_tokens is never sent — it returns 200 and then goes the other way', () => {
    for (const ai of [{ ...KEY, effort: 'high' }, { ...DEEPSEEK, thinking: 'adaptive' }]) {
      const body = build(ai);
      if (body.thinking) {
        assert.ok(!('budget_tokens' in body.thinking),
          'on the official endpoint it is a 400; DeepSeek accepts it, returns 200, and then thinks more '
          + '(asking for 2000 produced 49653 characters, while not sending it produced 38196) — and nothing reports any of it');
      }
    }
  });
});

test('the last system block carries cache_control (the feedback rewrite relies on it to save money)', () => {
  const p = new AnthropicProvider(AI, { fetchImpl: fakeFetch([]) });
  const body = p.buildBody({ system: '一大段规则', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(body.system.at(-1).cache_control, { type: 'ephemeral' });
});

test('the web tools are the _20260209 version, and code_execution is never declared alongside', () => {
  const tools = webTools(AI);
  assert.deepEqual(tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.ok(!tools.some((t) => String(t.type).startsWith('code_execution')),
    'this version of the tools already runs code internally for dynamic filtering, so adding one more is two execution environments');
  assert.deepEqual(tools[1].citations, { enabled: false }, 'SKILL.md rule-7: a guide does not carry sources');
});

test('allowedDomains is not sent when empty (an empty array reads as "nothing may be searched")', () => {
  const tools = webTools({ ...AI, allowedDomains: [] });
  assert.ok(!('allowed_domains' in tools[0]));
  const locked = webTools({ ...AI, allowedDomains: ['gamersky.com'] });
  assert.deepEqual(locked[0].allowed_domains, ['gamersky.com']);
});

// ---------------------------------------------------------------------------
// The whole loop
// ---------------------------------------------------------------------------

test('an ordinary round: the body and the usage come back, with exactly one request sent', async () => {
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

test('resuming a pause_turn: no "continue" is added, and the previous round content is not dropped', async () => {
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

  // The second request: the user turn has to be followed directly by the assistant turn, with no
  // "continue" squeezed in between
  const second = fetchImpl.calls[1].body.messages;
  assert.equal(second.length, 2);
  assert.equal(second[0].role, 'user');
  assert.equal(second[1].role, 'assistant', 'one extra user message interrupts the server-side tool loop');

  // Both content segments have to be there; losing the search segment means losing the research
  assert.equal(r.content.filter((b) => b.type === 'server_tool_use').length, 1);
  assert.equal(r.text, '结论');
  // Usage is the sum of both
  assert.equal(r.usage.inputTokens, 200);
  assert.equal(r.usage.outputTokens, 90);
  assert.equal(r.usage.requests, 2);
});

test('resuming past the limit raises rather than spinning forever', async () => {
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
// The three failures that "look like success"
// ---------------------------------------------------------------------------

test('a refusal is HTTP 200, so the stop_reason has to be read before the body', async () => {
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

test('a max_tokens truncation: there is a body, but it must not count as finished', async () => {
  const fetchImpl = fakeFetch([okResponse(simpleMessage({ text: '前半段', stopReason: 'max_tokens' }))]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.text, '前半段', 'there really is a body — which is exactly what makes it dangerous');
  const v = checkResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /截断/);
});

test('a tool error is HTTP 200 too, and this round research is incomplete', async () => {
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
  assert.equal(r.stopReason, 'end_turn', 'the stop reason is normal, which is precisely the deception');
  assert.equal(checkResult(r).ok, false);
});

test('a failed fetch is reported but does not block — and it has to be reported', () => {
  // `url_not_allowed` (a URL the model assembled itself; it may only fetch ones already present
  // in the conversation) and `url_not_accessible` (404 / anti-scraping / timeout) are almost
  // certain to appear a few times in one normal round of research. Ten pages searched with two
  // fetches failed is enough research; voiding the whole round treats the normal case as a
  // fault, at the cost of the minutes and tokens the user has already paid
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
  assert.equal(v.warnings.length, 1, 'not blocking is not the same as staying silent');
  assert.match(v.warnings[0], /url_not_allowed、url_not_accessible/);
});

test('a failed search still kills the round, even when a fetch failed in the same round', () => {
  // Search is the entrance to research: if it did not succeed, the model wrote from memory. When
  // the two kinds of error are mixed, the blocking reason must not mix in the non-blocking one —
  // or the error points at the wrong problem
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
  assert.ok(!v.reason.includes('url_not_accessible'), 'the blocking reason should not mix in the non-blocking one');
});

describe('a vendor writing internal control tokens into the body', () => {
  // Measured on 2026-08-17, one game on DeepSeek: the 173rd achievement turned mid-line into
  //   `- [ ] **The Warrior: Ventus</｜｜DSML｜｜parameter>`
  //   `</｜｜DSML｜｜invoke>` `</｜｜DSML｜｜tool_calls>`
  // and then the output simply ended, with the remaining 10 achievements never written.
  // **The stop reason was normal, the body was non-empty and no tool reported an error** — all
  // three surfaces correct, so not one branch stopped it before this, and those three garbage
  // lines landed straight in the user's draft.
  // Had it not happened to be 10 checkboxes short and blocked indirectly by the validator, it
  // would have been written into the Notion page.
  const ok = (text) => checkResult({
    stopReason: 'end_turn', rawStopReason: 'end_turn', text,
    usage: { ...emptyUsage(), outputTokens: 900 }, toolErrors: [], content: [{ type: 'text' }],
  });

  test('the markers of each vendor are recognised', () => {
    const cases = [
      ['a<｜tool▁calls▁begin｜>b', 'the DeepSeek fullwidth-bar marker'],
      ['x</｜｜DSML｜｜invoke>y', 'the one really hit in production'],
      ['<|im_start|>assistant', 'the Llama / OpenAI family'],
      ['正文 </invoke> 正文', 'a tool-call closing tag'],
    ];
    for (const [text, why] of cases) {
      const v = ok(text);
      assert.equal(v.ok, false, why + ' was not stopped');
      assert.equal(v.code, 'control-token');
    }
  });

  test('**a normal guide must not be misjudged** — one false positive burns a whole paid round', () => {
    // Guide bodies legitimately carry real HTML, so the criterion has to be narrow enough that a
    // collision is impossible
    const legit = [
      '- [ ] **成就名**<br>官方描述<br>心得',
      '<details><summary>全结局对照</summary>正文</details>',
      '<table><tr><td>A</td><td>B</td></tr></table>',
      '<span underline="true">如果进行此动作则无法获得X成就。</span>',
      '解锁率 a<b 这种写法也不能炸',
      '正文里出现一个全角竖线 ｜,但不在尖括号里',
      '| 表格 | 用的是 ASCII 竖线 |',
    ];
    for (const text of legit) {
      assert.equal(ok(text).ok, true, `normal content was misjudged: ${text}`);
    }
  });

  test('"strip the markers and carry on" is not allowed — the body is truncated, not merely dirty', () => {
    // Removing only those lines yields a guide that looks complete and is actually missing a
    // chunk. A failure is reported; missing content is not — and the latter is what this project
    // guards against most
    const v = ok('- [ ] **A**<br>desc<br>note\n- [ ] **B</｜｜DSML｜｜parameter>');
    assert.equal(v.ok, false, 'half the content is still not a pass');
    assert.match(v.reason, /正文是断的/);
  });

  test('the error carries the segment that was hit, or the next time is another guess', () => {
    const v = ok('x</｜｜DSML｜｜invoke>y');
    assert.match(v.reason, /DSML/, 'the marker actually hit has to be echoed back');
  });
});

describe('"no body" has to carry "then what did come back"', () => {
  // This is the hardest failure on this path to diagnose: HTTP 200, no tool errors, a normal stop
  // reason, and not one text block. And the response shape points at completely different
  // handling — with only a sentence saying "no body was output", the next occurrence is another
  // guess, and every guess costs the user minutes and a pile of tokens to verify.
  // Measured three times (most recently one game, segments 3 and 4 of 197 achievements)
  const empty = (over) => checkResult({
    stopReason: 'end_turn', rawStopReason: 'end_turn', text: '   ',
    usage: { ...emptyUsage(), outputTokens: 0 }, toolErrors: [], content: [], ...over,
  });

  test('the allowance eaten by thinking: a thinking block plus a large output-token count', () => {
    const v = empty({
      usage: { ...emptyUsage(), outputTokens: 31980 },
      content: [{ type: 'thinking', thinking: '想了很久' }],
    });
    assert.equal(v.code, 'empty');
    // Those three numbers together are the diagnosis: thinking present, no text, output close to
    // the ceiling ⇒ the same thing as truncation, so shard smaller rather than "ask again"
    assert.match(v.reason, /thinking×1/);
    assert.match(v.reason, /31980 token/);
  });

  test('a plain glitch: not one block and 0 tokens — this has to stay distinguishable from the above', () => {
    const v = empty();
    assert.match(v.reason, /一个块都没有/);
    assert.match(v.reason, /0 token/);
  });

  test('searched but never wrote: it can report the number of server_tool_use blocks', () => {
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

  test('the raw stop reason has to come through verbatim — the normalised word cannot say which vendor said what', () => {
    // STOP_MAP folds tool_use and stop_sequence both into end_turn, and a compatible endpoint may
    // give a word we have never seen. The normalised value cannot answer "what exactly did the
    // vendor say"
    assert.match(empty({ rawStopReason: 'COMPLETE' }).reason, /COMPLETE/);
    assert.match(empty({ rawStopReason: undefined }).reason, /未知/);
  });
});

test('a tool error with an unrecognised tool is treated as blocking', () => {
  const v = checkResult({
    stopReason: 'end_turn',
    text: '有正文',
    usage: emptyUsage(),
    toolErrors: [{ tool: '将来某个新工具', errorCode: 'boom' }],
  });
  assert.equal(v.ok, false, 'when a new vendor is wired in, block one time too many rather than pass by default');
});

// ---------------------------------------------------------------------------
// HTTP error classification
// ---------------------------------------------------------------------------

test('a 400 is not retried (the request itself is wrong and retrying cannot fix it), and the error carries the API own words', async () => {
  const fetchImpl = fakeFetch([errResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected beta' }, request_id: 'req_x' })]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  await assert.rejects(
    p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
    (e) => {
      assert.equal(e.retryable, false);
      assert.equal(e.requestId, 'req_x');
      assert.match(e.message, /unexpected beta/);
      assert.match(e.message, /fallbacks/, 'a 400 about a beta header has to say which switch to turn off');
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1, 'it should not retry');
});

test('429 / 5xx are judged retryable', async () => {
  for (const status of [429, 500, 529]) {
    const fetchImpl = fakeFetch([errResponse(status, { type: 'error', error: { type: 'x', message: 'y' } })]);
    const p = new AnthropicProvider(AI, { fetchImpl });
    await assert.rejects(
      p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
      (e) => e.retryable === true
    );
  }
});

test('the error message never carries the API key', async () => {
  const fetchImpl = fakeFetch([errResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  await assert.rejects(
    p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
    (e) => !e.message.includes(AI.apiKey)
  );
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a multi-round session: history is kept (the feedback rewrite needs it) and usage accumulates across rounds', async () => {
  const fetchImpl = fakeFetch([
    okResponse(simpleMessage({ text: '第一版' })),
    okResponse(simpleMessage({ text: '改好了' })),
  ]);
  const p = new AnthropicProvider(AI, { fetchImpl });
  const s = createSession(p, { system: '规则', tools: webTools(AI) });

  await s.ask('写一份');
  await s.ask('这几条没过:...');

  assert.equal(s.messages.length, 4, 'two user and two assistant');
  // The second request carries the whole history, which is what hits the prefix cache and what
  // makes the previous version knowable
  assert.equal(fetchImpl.calls[1].body.messages.length, 3);
  assert.equal(s.usage.requests, 2);
  assert.equal(s.usage.outputTokens, 100);
});

// ---------------------------------------------------------------------------
// Custom endpoints
// ---------------------------------------------------------------------------

test('baseUrl is configurable — an Anthropic-compatible endpoint uses it rather than a hardcoded address', async () => {
  // Measured on 2026-08-10: DeepSeek's https://api.deepseek.com/anthropic supports **server-side
  // web_search** (the response carries server_tool_use / web_search_tool_result, and usage carries
  // a count). Which means this layer gives DeepSeek web access untouched, with no second
  // implementation
  const fetchImpl = fakeFetch([okResponse(simpleMessage({ text: '好' }))]);
  const p = new AnthropicProvider({ ...AI, baseUrl: 'https://api.deepseek.com/anthropic/' }, { fetchImpl });
  await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages', 'the trailing slash has to be trimmed');
});

test('with a baseUrl configured, the model name is not checked against the vendor', async () => {
  // With provider=anthropic pointed at DeepSeek's compatible endpoint, the model really is called
  // deepseek-v4-flash. A prefix check can only produce a false alarm in that case
  const { assertModelMatchesProvider } = await import('../lib/ai.js');
  assert.throws(
    () => assertModelMatchesProvider('anthropic', 'deepseek-v4-flash'),
    (err) => {
      assert.match(err.message, /只改了其中一项/);
      // The body appears verbatim in the Dashboard's floater, where the user has no terminal —
      // terminal-only advice such as "add --provider X" hangs off the code and is supplied by
      // tracker.js's CLI_HINTS
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
// Provider presets: the good path has to be the default
// ---------------------------------------------------------------------------

test('provider: deepseek goes to the endpoint that **has web access**', async () => {
  // DeepSeek has two endpoints: /anthropic has server-side search, /chat/completions does not.
  // Before this preset, the good path had to be written as provider: "anthropic" plus a DeepSeek
  // URL (which looks like a misconfiguration), while the intuitive provider: "deepseek" gave the
  // one with no web access. The good path should not hide behind a counter-intuitive config
  const { createProvider } = await import('../lib/ai.js');
  const p = await createProvider({ ai: { provider: 'deepseek', apiKey: 'k' } });
  assert.equal(p.canSearch, true);
  assert.equal(p.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.match(p.model, /^deepseek-/, 'the default model has to be a DeepSeek one too');
  assert.equal(p.name, 'deepseek', 'the error has to name the right vendor');

  // The one without web access is still reachable, but has to be named explicitly
  const openai = await createProvider({ ai: { provider: 'deepseek-openai', apiKey: 'k' } });
  assert.equal(openai.canSearch, false);
  assert.equal(openai.name, 'deepseek-openai', 'the two must not share a name, or an error cannot tell them apart');
});

test('a preset does not overwrite a model / baseUrl the user configured explicitly', async () => {
  const { createProvider } = await import('../lib/ai.js');
  const p = await createProvider({
    ai: { provider: 'deepseek', apiKey: 'k', model: 'deepseek-v4-pro[1m]', baseUrl: 'https://proxy.example.com' },
  });
  assert.equal(p.model, 'deepseek-v4-pro[1m]');
  assert.equal(p.baseUrl, 'https://proxy.example.com');
});

test('the default model in config has to be empty — a concrete name is vendor-specific', async () => {
  // Hit before: the default was claude-opus-5, so anyone who configured provider: deepseek without
  // filling in model was certain to hit "the provider is deepseek while the model name is an
  // anthropic one"
  const { loadConfig } = await import('../lib/config.js');
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(loadConfig().ai.model, '', 'filling in any vendor concrete model name traps whoever uses another one');
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

test('a 401 names the real vendor and its env var, not a hardcoded Anthropic', async () => {
  // This layer is also used to hit DeepSeek's compatible endpoint. Sending someone to check
  // ANTHROPIC_API_KEY points them the wrong way
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
// Spend caps
// ---------------------------------------------------------------------------
