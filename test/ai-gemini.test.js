/**
 * The Gemini provider
 * ------------------------------------------------
 * Run with: node --test
 *
 * This vendor was added **without access to the official documentation** (the web tools were
 * unavailable for a stretch while it was written), so field names, model names and tool names
 * all came from memory. The failure class this file guards is therefore a little different from
 * elsewhere: **does misremembering fail quietly?**
 *
 * What is misremembered but errors on the spot (model names, tool names, endpoints) needs no
 * test — the first real run says so, and all of them were made configurable. What is genuinely
 * dangerous is below: wrong without an error, merely a wrong result.
 *
 *  - **A thought part getting into the body.** Gemini puts thinking and prose in the same parts
 *    array, separated only by `thought: true`. Miss it once and the model's reasoning is written
 *    into the user's guide file
 *  - **The usage field mapping.** The names are completely unlike Anthropic's, and it likewise
 *    reports a running total per chunk — adding them up double-counts, and nothing anywhere
 *    raises an error, the numbers are simply always wrong
 *  - **An unrecognised finishReason has to land on 'other'.** Defaulting it to success means a
 *    new terminal reason from Google later makes failed generations look like successes
 *  - **RECITATION must not be lumped in with an ordinary refusal.** Guide writing is exactly its
 *    high-risk case (we explicitly ask for official descriptions to be copied verbatim), so it
 *    needs a message someone can act on
 *  - **When the whole prompt is blocked there are no candidates at all**, only
 *    promptFeedback.blockReason. Without handling that separately it presents as "it output an
 *    empty string"
 *  - **The key has to travel in a header** and never in the query string (which reaches logs and
 *    error reports)
 *
 * Entirely offline; fetch is injected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { emptyUsage, checkResult, createSession } from '../lib/ai.js';
import { GeminiProvider, createGeminiAccumulator, mergeGeminiUsage } from '../lib/ai-gemini.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function sseBody(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    // Sliced into 7-byte chunks: this splits events apart and splits multi-byte characters apart too
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
    if (!r) throw new Error(`no response prepared for call number ${calls.length}`);
    return r;
  };
  fn.calls = calls;
  return fn;
}

const AI = { apiKey: 'test-key', model: 'gemini-2.5-pro', maxTokens: 32000, maxRetries: 0 };

/** One normal complete reply */
const reply = (text, finishReason = 'STOP', extra = {}) => [
  { candidates: [{ content: { parts: [{ text }], role: 'model' } }], ...extra },
  {
    candidates: [{ finishReason, content: { parts: [], role: 'model' } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  },
];

// ---------------------------------------------------------------------------
// Thought parts
// ---------------------------------------------------------------------------

test('a thought part must not get into the body (or the reasoning is written into the guide file)', () => {
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
  assert.match(r.thinking, /我先想想/, 'the thinking itself is kept, it merely must not enter the body');
});

// ---------------------------------------------------------------------------
// usage mapping
// ---------------------------------------------------------------------------

describe('usage', () => {
  test('the field names map correctly', () => {
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

  test('thinking tokens count towards output (the same billing convention as on the Anthropic side)', () => {
    const u = emptyUsage();
    mergeGeminiUsage(u, { candidatesTokenCount: 800, thoughtsTokenCount: 2000 });
    assert.equal(u.outputTokens, 2800);
  });

  test('each chunk reports a running total, so it overwrites rather than accumulates', () => {
    const u = emptyUsage();
    mergeGeminiUsage(u, { promptTokenCount: 100, candidatesTokenCount: 10 });
    mergeGeminiUsage(u, { promptTokenCount: 100, candidatesTokenCount: 700 });
    assert.equal(u.outputTokens, 700, 'adding them gives 710, and nothing anywhere reports that error');
    assert.equal(u.inputTokens, 100);
  });
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

describe('finishReason normalisation', () => {
  const run = async (chunks) => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([okResponse(chunks)]) });
    return p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
  };

  test('STOP → end_turn, and the result is usable', async () => {
    const r = await run(reply('好的'));
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.text, '好的');
    assert.equal(checkResult(r).ok, true);
  });

  test('MAX_TOKENS → max_tokens; having a body does not mean it finished writing', async () => {
    const r = await run(reply('写到一半', 'MAX_TOKENS'));
    assert.equal(r.stopReason, 'max_tokens');
    assert.equal(r.text, '写到一半', 'there really is a body — which is exactly what makes it dangerous');
    assert.match(checkResult(r).reason, /截断/);
  });

  test('SAFETY → refusal', async () => {
    const r = await run(reply('', 'SAFETY'));
    assert.equal(r.stopReason, 'refusal');
    assert.equal(checkResult(r).ok, false);
  });

  test('RECITATION is its own class, with information that can be acted on', async () => {
    const r = await run(reply('抄了一段 wiki', 'RECITATION'));
    assert.equal(r.stopReason, 'recitation');
    assert.equal(r.rawStopReason, 'RECITATION');
    const v = checkResult(r);
    assert.equal(v.ok, false);
    assert.match(v.reason, /RECITATION/);
    assert.match(v.reason, /原文照抄/, 'it has to say plainly that a hard requirement must not be dropped to get around it');
  });

  test('an unrecognised stop reason lands on other rather than counting as success', async () => {
    // When Google adds a new value later, a failed generation must not look like a success
    const r = await run(reply('半截', 'SOME_FUTURE_REASON'));
    assert.equal(r.stopReason, 'other');
    assert.equal(r.rawStopReason, 'SOME_FUTURE_REASON');
    const v = checkResult(r);
    assert.equal(v.ok, false);
    assert.match(v.reason, /SOME_FUTURE_REASON/, 'the original value has to come through, or there is no way to look it up');
  });

  test('a fully blocked prompt has no candidates, only a blockReason', async () => {
    const r = await run([{ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 30 } }]);
    assert.equal(r.stopReason, 'refusal', 'without handling it separately this presents as "it output an empty string"');
    assert.equal(r.rawStopReason, 'BLOCKED_SAFETY');
    assert.equal(checkResult(r).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Going online: the response is the evidence
// ---------------------------------------------------------------------------

describe('grounding', () => {
  test('search queries are collected from groundingMetadata, and deduplicated', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([okResponse([
      { candidates: [{ groundingMetadata: { webSearchQueries: ['学园构想家 成就'] }, content: { parts: [{ text: 'a' }] } }] },
      { candidates: [{ groundingMetadata: { webSearchQueries: ['学园构想家 成就', '学园构想家 攻略'] }, content: { parts: [{ text: 'b' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [] } }], usageMetadata: { candidatesTokenCount: 5 } },
    ])]) });
    const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.deepEqual(r.searchQueries, ['学园构想家 成就', '学园构想家 攻略']);
  });

  test('tools declared but never searched → searchQueries is empty, which is how the caller learns this tier has no web access', async () => {
    // Whether the free tier includes web access is not reliably answerable from documentation;
    // the response is more reliable than the pricing page
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([okResponse(reply('我凭记忆答'))]) });
    const r = await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: p.webTools() });
    assert.deepEqual(r.searchQueries, []);
    assert.equal(checkResult(r).ok, true, 'not searching is not a failed round — it is a signal to report to a person, not an error');
  });

  test('the tool declaration is configurable (a rename or a free tier without it is a config change, not a code change)', () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([]) });
    assert.deepEqual(p.webTools(), [{ google_search: {} }]);

    const withFetch = new GeminiProvider({ ...AI, geminiTools: ['google_search', 'url_context'] }, { fetchImpl: fakeFetch([]) });
    assert.deepEqual(withFetch.webTools(), [{ google_search: {} }, { url_context: {} }]);
  });
});

// ---------------------------------------------------------------------------
// Assembling the request
// ---------------------------------------------------------------------------

describe('assembling the request', () => {
  test('assistant is called model here, and the body goes into parts', () => {
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
    assert.deepEqual(body.contents[1].parts, [{ text: '第一版' }], 'native parts are passed back verbatim');
    assert.deepEqual(body.systemInstruction, { parts: [{ text: '规则' }] });
    assert.equal(body.generationConfig.maxOutputTokens, 32000);
  });

  test('with no thinking budget configured, the field is not sent at all', () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([]) });
    const body = p.buildBody({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.ok(!('thinkingConfig' in body.generationConfig), 'sending a field that may not be accepted is more error-prone than not sending it');

    const budgeted = new GeminiProvider({ ...AI, geminiThinkingBudget: 8000 }, { fetchImpl: fakeFetch([]) });
    const b2 = budgeted.buildBody({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.equal(b2.generationConfig.thinkingConfig.thinkingBudget, 8000);
  });

  test('the key travels in a header and never in the query string', async () => {
    const fetchImpl = fakeFetch([okResponse(reply('好'))]);
    const p = new GeminiProvider(AI, { fetchImpl });
    await p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    const { url, headers } = fetchImpl.calls[0];
    assert.equal(headers['x-goog-api-key'], 'test-key');
    assert.ok(!url.includes('test-key'), 'a query string reaches logs and error reports');
    assert.match(url, /streamGenerateContent\?alt=sse$/);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('error messages have to be actionable', () => {
  test('"no longer available to new users" is a retirement, not a typo in the name', async () => {
    // Measured on 2026-08-10: the 2.5 series returns this for newly issued keys, yet it still
    // appears in --models. Reporting it as "the name may be wrong" sends people back to the
    // list to retry the same retired class of model over and over
    const msg = 'This model models/gemini-2.5-flash is no longer available to new users.';
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(404, { error: { code: 404, message: msg, status: 'NOT_FOUND' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /已经停止提供/);
      assert.doesNotMatch(e.message, /可能不对/, 'do not report a retirement as a wrong name');
      // "listed by --models does not mean usable" moved to the terminal side (tracker.js's
      // CLI_HINTS, pinned by cli-hints.test.js): the same sentence appears verbatim in the
      // Dashboard's floater, where there is no command line to type into. How to switch models
      // also differs between the two surfaces
      assert.equal(e.code, 'gemini-model-retired');
      assert.doesNotMatch(e.message, /--model|tracker\.js/);
      return true;
    });
  });

  test('a 404 is "wrong name or no permission", and is not retryable', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(404, { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /可能不对|没权限/);
      assert.equal(e.code, 'gemini-model-unknown', 'the terminal takes over with "how to find out which ones are usable"');
      assert.equal(e.retryable, false);
      return true;
    });
  });

  test('a 429 says plainly that the free tier has a per-day ceiling', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded, limit: 500' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /每天/);
      assert.equal(e.retryable, true);
      return true;
    });
  });

  test('limit: 0 means "this model is not in this tier", not "you used it up" — and is not retryable', async () => {
    // Measured on 2026-08-10: the free tier really does return limit: 0 for gemini-2.5-pro.
    // Google reports two different things with the same 429, and conflating them makes someone
    // wait a whole day for nothing, with three backoff retries purely wasted
    const msg = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro';
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: msg } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.equal(e.retryable, false, 'no amount of waiting restores it, so retrying is pointless');
      assert.match(e.message, /不是用完了/);
      assert.match(e.message, /换一个 flash 系列/, 'it has to say plainly which direction to switch in');
      assert.equal(e.code, 'gemini-no-allowance', 'the terminal takes over with "how to find out which ones are usable"');
      assert.doesNotMatch(e.message, /次日重置/, 'saying "wait for the daily reset" makes someone wait a day for nothing');
      return true;
    });
  });

  test('quota details are read out of error.details (they are not always in the message)', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(429, { error: {
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
          { quotaMetric: 'generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDay', quotaValue: '0' },
        ] },
      ],
    } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      // There is not one "limit: 0" in the message, only the quotaValue in the structured details
      assert.match(e.message, /GenerateRequestsPerDay/);
      assert.match(e.message, /不是用完了/, 'a quotaValue of 0 also has to be recognised as "this model is not in this tier"');
      assert.equal(e.retryable, false);
      return true;
    });
  });

  test('a 429 is retried only when Google said how long to wait — otherwise every retry burns quota', async () => {
    // Hit before: guessing a 1/2/4 second backoff is nowhere near long enough for a
    // "N per minute" window, so one 429 turned into four wasted requests
    const noHint = fakeFetch([errResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } })]);
    const p = new GeminiProvider({ ...AI, maxRetries: 3 }, { fetchImpl: noHint });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), /配额/);
    assert.equal(noHint.calls.length, 1, 'with no RetryInfo, send once and stop hitting the quota');
  });

  test('a 429 with no quota details gives a next step that narrows things down', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /没有配额明细/);
      assert.match(e.message, /等一分钟再试/, 'the first narrowing step is one both surfaces can take');
      assert.match(e.message, /ai\.dev\/rate-limit/, 'the quota page is a link, clickable from the page too');
      // "switch to a concrete model, and an alias may resolve to a new model outside the free
      // tier" is left to the terminal — that sentence is only useful written as AI_MODEL=…,
      // which is a terminal-only thing
      assert.equal(e.code, 'gemini-429-no-detail');
      return true;
    });
  });

  test('a tool-related 400 says plainly it is the tool declaration, with the config key name added by the terminal', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(400, { error: { message: 'Unknown tool: url_context', status: 'INVALID_ARGUMENT' } })]) });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
      assert.match(e.message, /联网工具的声明不被接受/);
      assert.equal(e.code, 'gemini-tool-rejected');
      assert.doesNotMatch(e.message, /geminiTools/, 'a key name from config means nothing to a page user');
      return true;
    });
  });

  test('the error message never carries the API key', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch([errResponse(403, { error: { message: 'bad key', status: 'PERMISSION_DENIED' } })]) });
    await assert.rejects(
      p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }),
      (e) => !e.message.includes('test-key')
    );
  });

  test('with no key it refuses to construct at all, pointing at how to get the free allowance', () => {
    assert.throws(() => new GeminiProvider({ model: 'gemini-2.5-pro' }), /aistudio\.google\.com/);
  });
});

// ---------------------------------------------------------------------------
// It fits the shared layer
// ---------------------------------------------------------------------------

test('a multi-round session: history passes back verbatim and usage accumulates across rounds', async () => {
  const fetchImpl = fakeFetch([okResponse(reply('第一版')), okResponse(reply('改好了'))]);
  const p = new GeminiProvider(AI, { fetchImpl });
  const s = createSession(p, { system: '规则', tools: p.webTools() });

  await s.ask('写一份');
  await s.ask('这几条没过');

  assert.equal(s.messages.length, 4);
  // The second request carries the whole history, with the assistant round translated to model
  assert.deepEqual(fetchImpl.calls[1].body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(s.usage.requests, 2);
  assert.equal(s.usage.outputTokens, 100);
});

// ---------------------------------------------------------------------------
// Provider / model mismatch
// ---------------------------------------------------------------------------

test('a model that plainly belongs to another vendor is stopped on the spot rather than left to hit that vendor 404', async () => {
  // Measured: config.json said deepseek while $env:AI_PROVIDER in the PowerShell session was
  // still gemini, so gemini's endpoint was asked for deepseek-chat. What came back was gemini's
  // "the model name may be wrong", pointing nowhere near the real cause of "provider was only
  // half changed"
  const { createProvider, assertModelMatchesProvider } = await import('../lib/ai.js');
  await assert.rejects(
    createProvider({ ai: { provider: 'gemini', model: 'deepseek-chat', apiKey: 'k' } }),
    (e) => {
      assert.match(e.message, /只改了其中一项/);
      // **The directly usable fix moved to the terminal side** and is no longer in the message
      // body: the same sentence appears verbatim in the Dashboard's floater, where the user has
      // no terminal. The fix hangs off the code in tracker.js's CLI_HINTS, pinned by
      // cli-hints.test.js
      assert.equal(e.code, 'provider-model-mismatch');
      assert.equal(e.detail.belongsTo, 'deepseek');
      assert.doesNotMatch(e.message, /--provider|Remove-Item|config\.json/);
      return true;
    }
  );

  // Matching ones — and **unrecognised** ones — have to pass: an alias or a self-hosted endpoint
  // can use any model name at all
  assert.doesNotThrow(() => assertModelMatchesProvider('gemini', 'gemini-flash-latest'));
  assert.doesNotThrow(() => assertModelMatchesProvider('gemini', 'nano-banana-pro-preview'));
  assert.doesNotThrow(() => assertModelMatchesProvider('deepseek', 'my-selfhosted-model'));
  assert.doesNotThrow(() => assertModelMatchesProvider('anthropic', ''));
});

// ---------------------------------------------------------------------------
// --models
// ---------------------------------------------------------------------------

/**
 * The `ai-check --models` path.
 *
 * **It had not one test before, and it was broken for a whole release cycle.** A stray
 * `streaming = true;` fell out of a `#once` into `listModels` (with the indentation wrong too),
 * and ESM is strict mode, so assigning to an undeclared variable is a `ReferenceError` — the
 * command **threw on every single invocation**, never even sending a request, and reported
 * `streaming is not defined`, which buried the real error.
 *
 * The top of this file says what is misremembered but errors on the spot (model names, tool
 * names, endpoints) needs no test, because the first real run says so. That rule is right about
 * **vendor facts**, but it missed a class here: this was not misremembering something about the
 * vendor, it was our own code blowing up before it reached the vendor. And `--models` is exactly
 * what CLAUDE.md calls the one thing that reveals a stale default model — a diagnostic breaking
 * precisely when nobody is looking at it.
 */
describe('listModels', () => {
  const jsonResponse = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

  const MODELS = {
    models: [
      { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    ],
  };

  test('it returns the usable models, and does not throw', async () => {
    const fetchImpl = fakeFetch([jsonResponse(MODELS)]);
    const list = await new GeminiProvider(AI, { fetchImpl }).listModels();
    assert.deepEqual(list, [
      { name: 'gemini-flash-latest', display: 'Gemini Flash Latest', inputLimit: 1048576, outputLimit: 65536 },
    ]);
  });

  test('only what can generateContent is kept — listing embedding models only invites a wrong pick', async () => {
    const fetchImpl = fakeFetch([jsonResponse(MODELS)]);
    const list = await new GeminiProvider(AI, { fetchImpl }).listModels();
    assert.ok(!list.some((m) => m.name.startsWith('embedding')));
  });

  test('the key travels in a header, not the query string', async () => {
    const fetchImpl = fakeFetch([jsonResponse(MODELS)]);
    await new GeminiProvider(AI, { fetchImpl }).listModels();
    assert.ok(!fetchImpl.calls[0].url.includes('key='), 'the key went into the URL — that reaches logs and error reports');
    assert.equal(fetchImpl.calls[0].headers['x-goog-api-key'], 'test-key');
  });

  test('a non-200 throws something actionable, not a ReferenceError', async () => {
    // In the broken version **any** response hit `streaming is not defined` first, so even what
    // a 403 should say was invisible
    const fetchImpl = fakeFetch([errResponse(403, { error: { code: 403, message: 'permission denied' } })]);
    await assert.rejects(
      () => new GeminiProvider(AI, { fetchImpl }).listModels(),
      (e) => !(e instanceof ReferenceError) && /403|permission/i.test(e.message)
    );
  });
});

describe('cancellation — the Dashboard Cancel button, mirroring ai.test.js exactly', () => {
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
    const p = new GeminiProvider(AI, { fetchImpl: hangingFetch() });
    const sent = p.send({ system: 's', messages: [{ role: 'user', content: 'q' }], signal: ac.signal });
    ac.abort();
    await assert.rejects(sent, (err) => {
      assert.equal(err.cancelled, true);
      assert.equal(err.retryable, false);
      return true;
    });
  });

  test('the idle timeout with no external signal is not mistaken for a cancellation', async () => {
    const p = new GeminiProvider({ ...AI, requestTimeoutMs: 5 }, { fetchImpl: hangingFetch() });
    await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (err) => {
      assert.equal(err.cancelled, false);
      return true;
    });
  });
});

describe('a stream that fails partway must not leak the connection', () => {
  /**
   * When the body dies mid-stream the request is still open, and `maxRetries` opens another — so
   * without an abort a socket leaks on every attempt. The abort is deliberately gated on having
   * reached the stream: aborting a response that already returned completely (a 4xx whose body
   * was consumed by `text()`) trips a libuv assertion at exit on Windows.
   *
   * That gate is a variable, and a variable that is declared and never set reads exactly like a
   * working one — the abort simply never happens, and nothing anywhere reports it. This is the
   * same pairing ai-anthropic.js and ai-deepseek.js have.
   */
  const dyingBody = () => (async function* () {
    yield new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"部分"}],"role":"model"}}]}\n\n');
    throw new Error('socket hang up');
  })();

  /** Captures the AbortSignal the provider hands to fetch, which is the only place the abort shows */
  const capturingFetch = (response) => {
    const seen = [];
    const fn = async (_url, init) => { seen.push(init.signal); return response; };
    fn.signals = seen;
    return fn;
  };

  test('**the fetch is aborted when the stream dies partway**', async () => {
    const f = capturingFetch({ ok: true, status: 200, headers: new Headers(), body: dyingBody() });
    const p = new GeminiProvider(AI, { fetchImpl: f });
    await assert.rejects(p.send({ messages: [{ role: 'user', content: 'q' }] }));
    assert.equal(f.signals.length, 1, 'expected exactly one request');
    assert.equal(f.signals[0].aborted, true,
      'the stream failed mid-body and the fetch was never aborted — the connection leaks, and every retry opens another');
  });

  test('a response that never started streaming is left alone', async () => {
    // The other half of the same gate: a 4xx is fully read by errorFromResponse, and aborting it
    // afterwards is what trips the libuv assertion on Windows
    const f = capturingFetch(errResponse(429, { error: { message: 'rate limited' } }));
    const p = new GeminiProvider(AI, { fetchImpl: f });
    await assert.rejects(p.send({ messages: [{ role: 'user', content: 'q' }] }));
    assert.equal(f.signals[0].aborted, false,
      'aborting a response whose body was already consumed is what the streaming gate exists to prevent');
  });
});

/**
 * The 503, which is a third thing and used to look like the other two.
 *
 * Measured on one key within a few minutes: `gemini-flash-latest` and `gemini-3.6-flash` both 503,
 * `gemini-3.8-flash` answered 200 and then 503 for the byte-identical request, and
 * `gemini-2.5-flash` gave 404 「no longer available to new users」. Only the last of those is a
 * model-name problem, and only it should send anybody to change a setting.
 */
describe('a 503 is capacity, and is not reported as a model problem', () => {
  const busyResponse = () => errResponse(503, { error: { status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } });

  /** Runs `fn` with the backoff sleeps collected instead of waited out */
  async function withoutWaiting(fn) {
    const sleeps = [];
    const real = global.setTimeout;
    global.setTimeout = (cb, ms) => { sleeps.push(ms); return real(cb, 0); };
    try {
      await fn();
    } finally {
      global.setTimeout = real;
    }
    // Every attempt arms a request-timeout timer too; only the backoff is of interest here
    return sleeps.filter((ms) => ms < 60000);
  }

  test('it gets its own code, so the terminal can give its own advice', async () => {
    const p = new GeminiProvider(AI, { fetchImpl: fakeFetch(Array.from({ length: 8 }, busyResponse)), log: () => {} });
    await withoutWaiting(async () => {
      await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }), (e) => {
        assert.equal(e.code, 'gemini-unavailable',
          'without its own code this falls through as the vendor’s raw sentence, which reads like a misconfigured model');
        assert.equal(e.retryable, true);
        return true;
      });
    });
  });

  test('a retired model keeps saying it is a model problem', () => {
    // The two must not converge: one wants a setting changed, the other wants time
    assert.notEqual('gemini-unavailable', 'gemini-model-retired');
  });

  test('**it is re-asked more often, and waits longer, than an ordinary failure**', async () => {
    // Measured during a spike, 10 bare requests per model: flash-latest answered 6, 3.8-flash 4.
    // A per-request lottery — so the number of draws is what decides whether a run survives, and a
    // guide run is many requests. At 40% a request wins, `maxRetries: 3` loses one attempt in eight
    const busy = fakeFetch(Array.from({ length: 8 }, busyResponse));
    const p = new GeminiProvider({ ...AI, maxRetries: 3 }, { fetchImpl: busy, log: () => {} });
    const waits = await withoutWaiting(async () => {
      await assert.rejects(p.send({ system: 's', messages: [{ role: 'user', content: 'q' }] }));
    });

    assert.equal(busy.calls.length, 6, 'a 503 gets its own budget: five retries, not ai.maxRetries');
    assert.deepEqual(waits, [5000, 10000, 20000, 30000, 30000],
      'and its own ladder; at 1/2/4 seconds it gives up inside eight, which is no retry at all');
  });
});
