/**
 * Tests for the DeepSeek provider
 * ------------------------------------------------
 * Run with: node --test
 *
 * This vendor's most important property is not a protocol detail but that **it has no
 * server-side web search** — and the design doc makes "has server-side search" a hard
 * admission criterion, on the grounds that "letting one without search in makes quality
 * depend on which vendor the user picked, and the user cannot see that difference".
 *
 * So the first thing this file pins is `canSearch === false` propagating all the way
 * through: the prompt switches to the "you have no network access" version, and the result
 * carries a `researched` flag. Breaking that chain anywhere turns into "the user receives a
 * guide that looks normal and in fact researched nothing" — precisely what that admission
 * criterion exists to prevent.
 *
 * The rest is still the "get it wrong and it goes wrong silently" class:
 *
 *  - **`reasoning_content` mixed into the prose**. deepseek-reasoner puts the chain of
 *    thought and the prose in two fields of the same delta, and missing it once writes the
 *    reasoning into the user's guide file
 *  - **usage field mapping**, and cache-hit tokens not being counted twice with the input
 *  - **an unrecognised finish_reason falling to other** rather than counting as success
 *  - **a 402 insufficient balance is not retryable** — an entirely different thing from a
 *    rate limit, and retrying never helps
 *
 * All offline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { emptyUsage, checkResult, createSession } from '../lib/ai.js';
import { DeepseekProvider, createDeepseekAccumulator, mergeDeepseekUsage } from '../lib/ai-deepseek.js';
import { buildSystemPrompt } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// Scaffolding
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
// No web access: this vendor's most important property
// ---------------------------------------------------------------------------

describe('canSearch = false has to propagate all the way through', () => {
  test('the provider declares it has no web access itself, and the tool list is empty', () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([]) });
    assert.equal(p.canSearch, false);
    assert.deepEqual(p.webTools(), []);
  });

  test('searchQueries is always empty, and structurally so', async () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([okResponse(reply('好'))]) });
    const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.deepEqual(r.searchQueries, []);
  });

  test('the prompt switches to the "you have no network access" version and asks it to leave things blank rather than invent', () => {
    const defs = [{ api_name: 'A', name_cn: '第一步', name_en: '', description: '完成第一关。' }];
    const online = buildSystemPrompt('测试游戏', '1', defs, { canSearch: true });
    const offline = buildSystemPrompt('测试游戏', '1', defs, { canSearch: false });

    assert.match(online, /先上网搜/);
    assert.doesNotMatch(online, /没有联网能力/);

    assert.match(offline, /没有搜索和抓取网页的工具/);
    assert.match(offline, /留空是合格的结果/, 'without saying so, the model invents a passage for every entry to look complete');
    assert.doesNotMatch(offline, /先上网搜/, 'telling it to search the web with no tools only makes it pretend it did');
  });

  test('the hard-rules part of both prompts is identical (the format requirements are not relaxed just because there is no web access)', () => {
    const defs = [{ api_name: 'A', name_cn: '第一步', name_en: '', description: 'x' }];
    const head = (s) => s.slice(0, s.indexOf('## 怎么查资料') >= 0 ? s.indexOf('## 怎么查资料') : s.indexOf('## 你这次没有联网能力'));
    assert.equal(
      head(buildSystemPrompt('g', '1', defs, { canSearch: true })),
      head(buildSystemPrompt('g', '1', defs, { canSearch: false }))
    );
  });
});

// ---------------------------------------------------------------------------
// The chain of thought
// ---------------------------------------------------------------------------

test('reasoning_content must not mix into the prose (or the chain of thought gets written into the guide file)', () => {
  const acc = createDeepseekAccumulator();
  acc.push({ choices: [{ delta: { reasoning_content: '让我想想这个成就……' } }] });
  acc.push({ choices: [{ delta: { content: '- [ ] **第一步**' } }] });
  acc.push({ choices: [{ delta: { reasoning_content: '还要检查一下' } }] });
  acc.push({ choices: [{ delta: { content: '<br>完成第一关。' } }] });
  const r = acc.result();
  assert.equal(r.text, '- [ ] **第一步**<br>完成第一关。');
  assert.match(r.thinking, /让我想想/, 'the chain of thought itself is kept, it simply does not enter the prose');
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe('usage', () => {
  test('the field mapping lines up', () => {
    const u = emptyUsage();
    mergeDeepseekUsage(u, { prompt_tokens: 1200, completion_tokens: 800 });
    assert.equal(u.inputTokens, 1200);
    assert.equal(u.outputTokens, 800);
  });

  test('cache-hit tokens are not counted into the input twice', () => {
    // prompt_tokens already includes the hit portion, so recording both sides directly counts the same tokens twice
    const u = emptyUsage();
    mergeDeepseekUsage(u, { prompt_tokens: 1000, prompt_cache_hit_tokens: 700, completion_tokens: 50 });
    assert.equal(u.cacheReadTokens, 700);
    assert.equal(u.inputTokens, 300);
  });

  test('each chunk reports a running total, so it overwrites rather than accumulates', () => {
    const u = emptyUsage();
    mergeDeepseekUsage(u, { completion_tokens: 10 });
    mergeDeepseekUsage(u, { completion_tokens: 900 });
    assert.equal(u.outputTokens, 900);
  });
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

describe('finish_reason normalisation', () => {
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

  test('length → max_tokens, and prose present still does not count as finished', async () => {
    const r = await run(reply('写到一半', 'length'));
    assert.equal(r.stopReason, 'max_tokens');
    assert.match(checkResult(r).reason, /截断/);
  });

  test('content_filter → refusal', async () => {
    const r = await run(reply('', 'content_filter'));
    assert.equal(r.stopReason, 'refusal');
    assert.equal(checkResult(r).ok, false);
  });

  test('an unrecognised stop reason falls to other rather than counting as success', async () => {
    const r = await run(reply('半截', 'some_future_reason'));
    assert.equal(r.stopReason, 'other');
    assert.equal(r.rawStopReason, 'some_future_reason');
    assert.equal(checkResult(r).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

describe('request assembly', () => {
  test('system is an entry in messages rather than a separate field', () => {
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
    assert.deepEqual(body.stream_options, { include_usage: true }, 'without this, usage is unavailable in streaming mode');
  });

  test('the key goes in the Authorization header', async () => {
    const fetchImpl = fakeFetch([okResponse(reply('好'))]);
    const p = new DeepseekProvider(AI, { fetchImpl });
    await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer test-key');
    assert.match(fetchImpl.calls[0].url, /\/chat\/completions$/);
  });

  test('baseUrl is configurable (for self-hosted and proxy endpoints)', () => {
    const p = new DeepseekProvider({ ...AI, baseUrl: 'https://proxy.example.com/v1/' }, { fetchImpl: fakeFetch([]) });
    assert.equal(p.baseUrl, 'https://proxy.example.com/v1');
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('errors', () => {
  test('a 402 insufficient balance is not retryable — an entirely different thing from a rate limit', async () => {
    const p = new DeepseekProvider({ ...AI, maxRetries: 3 }, {
      fetchImpl: fakeFetch([errResponse(402, { error: { message: 'Insufficient Balance', type: 'insufficient_balance' } })]),
    });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.equal(e.retryable, false, 'retrying a balance problem never helps');
      assert.match(e.message, /余额不足/);
      return true;
    });
  });

  test('the error message never carries the API key', async () => {
    const p = new DeepseekProvider(AI, { fetchImpl: fakeFetch([errResponse(401, { error: { message: 'bad key' } })]) });
    await assert.rejects(
      p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
      (e) => !e.message.includes('test-key')
    );
  });

  test('with no key, construction is refused outright', () => {
    assert.throws(() => new DeepseekProvider({ model: 'deepseek-chat' }), /DEEPSEEK_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// It fits the shared layer
// ---------------------------------------------------------------------------

test('a multi-turn session: the history is kept and usage accumulates across turns', async () => {
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

// ---------------------------------------------------------------------------
// Cancellation — the Dashboard Cancel button, mirroring ai.test.js exactly
// ---------------------------------------------------------------------------

/** Never resolves on its own; only reacts to whichever AbortController owns init.signal */
function hangingFetch() {
  return (url, init) => new Promise((_resolve, reject) => {
    const onAbort = () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    if (init.signal.aborted) return onAbort();
    init.signal.addEventListener('abort', onAbort);
  });
}

test('an external signal aborts the request and is reported cancelled, not a timeout', async () => {
  const ac = new AbortController();
  const p = new DeepseekProvider(AI, { fetchImpl: hangingFetch() });
  const sent = p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] , signal: ac.signal });
  ac.abort();
  await assert.rejects(sent, (err) => {
    assert.equal(err.cancelled, true);
    assert.equal(err.retryable, false);
    return true;
  });
});

test('the idle timeout with no external signal is not mistaken for a cancellation', async () => {
  const p = new DeepseekProvider({ ...AI, requestTimeoutMs: 5 }, { fetchImpl: hangingFetch() });
  await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (err) => {
    assert.equal(err.cancelled, false);
    return true;
  });
});
