/**
 * The **seam** between providers and guide generation
 * ------------------------------------------------
 * Run with: node --test
 *
 * This file fills a hole that really existed: **`guidegen.js` had never been driven by a real
 * provider.**
 *
 * `ai.test.js` / `ai-gemini.test.js` test the providers themselves (assembling the request,
 * unpacking the stream, judging failures), and `guidegen.test.js` tests the orchestration — but
 * with a hand-written `fakeProvider`, a stub that happens to implement the few fields the
 * orchestration layer uses today. So **each side is green on its own while the contract between
 * them is verified by nobody**: the shape the stub returns was written from the orchestration
 * layer, not from the providers. A real provider with one field more, one field fewer, or a
 * different field name turns not one of the 749 tests red.
 *
 * That hole sits exactly over the place that has already blown up once: a successful web_fetch
 * read as a failure, **on by default only on the official endpoint**, while every real run went
 * through DeepSeek's compatible endpoint — so it reached the user before it blew up. A pit of
 * the same shape is still there: the official endpoint is the only path that sends `thinking` /
 * `output_config` / `fallbacks`, and that path has never run end to end.
 *
 * So this goes through the **real** `createProvider` → the real provider → the real
 * `createSession` → the real `generateGuide`, swapping out only `fetch` and feeding in bytes in
 * each vendor's **real wire format**.
 *
 * Entirely offline: not one byte goes out, and no API key is needed.
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
// Scaffolding
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
  // The default for `effort` lives in `lib/config.js`'s DEFAULTS (not exported), and the
  // providers themselves have **no** default — `this.effort` only holds when `ai.effort` has a
  // value. So constructing a provider directly, bypassing loadConfig, does not get that knob.
  // Written out explicitly here, matching the default in config.js
  return { db, config: { guidesDir: dir, ai: { maxAchievements: 100, maxRetries: 0, effort: 'high', ...ai } } };
}

const fakeSteam = (unlocked = ['A']) => ({
  async fetchPlayerAchievements() {
    return { achievements: DEFS.map((d) => ({ apiname: d.api_name, achieved: unlocked.includes(d.api_name) ? 1 : 0 })) };
  },
  async fetchGlobalAchievementPercentages() { return null; },
});

/** The body the model writes. One checkbox per achievement, all `- [ ]` — ticking is the program's job */
const BODY = [
  '```markdown',
  '## 主线',
  '',
  '- [ ] **第一步**<br>完成第一关。<br>开局就能拿',
  '- [ ] **第二步**<br>完成第二关。<br>接着打',
  '```',
].join('\n');

/** Sliced into 7-byte chunks: this splits events apart and splits multi-byte characters apart too */
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

// --- The Anthropic wire format ----------------------------------------------

/**
 * One complete message in its real shape: first a server-side search (with streaming JSON
 * input), then a **successful** fetch (whose content is an **object**, not an array — exactly
 * the shape that blew up in the user's hands), then the body.
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

// --- The Gemini wire format -------------------------------------------------

/** Thought parts and prose share one parts array, separated only by `thought: true` */
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
// All three vendors have to carry the same guide through the whole pipeline
// ---------------------------------------------------------------------------

/**
 * The three vendors' **output has to be byte-identical** — the guide content is written by the
 * model, and everything else on this pipeline (stripping the markdown fence, joining segments,
 * writing the header, mechanical ticking, registration) should not know which vendor is which.
 * Any vendor producing a different result here means the orchestration layer missed that
 * vendor's shape.
 */
const CASES = [
  { name: 'anthropic (official endpoint)', ai: { provider: 'anthropic', apiKey: 'k' }, sse: anthropicSse },
  { name: 'deepseek (Anthropic-compatible endpoint preset)', ai: { provider: 'deepseek', apiKey: 'k' }, sse: anthropicSse },
  { name: 'gemini', ai: { provider: 'gemini', apiKey: 'k' }, sse: geminiSse },
];

describe('a real provider driving the whole pipeline', () => {
  for (const c of CASES) {
    test(`${c.name}: one round passes, lands, is mechanically ticked and registered`, async () => {
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
      assert.equal(fetchImpl.calls.length, 1, 'two achievements should take exactly one request');
      assert.ok(existsSync(r.path));

      const text = readFileSync(r.path, 'utf8');
      assert.match(text, /- \[x\] \*\*第一步\*\*/, 'the unlocked one has to be mechanically ticked');
      assert.match(text, /- \[ \] \*\*第二步\*\*/, 'the locked one must not be ticked');
      assert.match(text, /^# 测试游戏/);
      assert.match(text, /^appid: 1$/m);
      assert.ok(!text.includes('```'), 'the markdown fence has to be stripped');

      assert.equal(allGuides(db).length, 1);
      assert.ok(r.registered);

      // **"can search ≠ did search" is the key reading of this admission design**, and it has to
      // cross three layers — provider → session → orchestration — to reach the caller. The stub
      // does not return this field, so nothing covered it before.
      // **The closing report is consistent across all three**; the live progress is not, see the
      // case below
      assert.deepEqual(r.searchQueries, ['测试游戏 成就']);
      assert.ok(events.some((e) => e.phase === 'tool'), 'a web tool has to become at least one progress event');
    });
  }

  /**
   * **Progress-event normalisation is only half done, and this half is one of the only two
   * behavioural differences among the three vendors.**
   *
   * The top of `ai.js` says progress events are normalised too (text / tool / tool-result /
   * search), so the CLI's live output and guidegen's progress bar know no vendor's raw format.
   * The `search` case is **emitted only by Gemini**: its
   * `groundingMetadata.webSearchQueries` repeats in every chunk, so the query can be reported
   * while streaming. On Anthropic the query lives in the `server_tool_use` block's **streaming
   * JSON input**, which has not arrived at `content_block_start`, so `emitProgress` can only
   * emit `{type:'tool', name:'web_search'}` — a raw, English, wire-format tool name that goes
   * straight into the progress bar.
   *
   * Two consequences, neither of which raises an error: running Claude / DeepSeek scrolls
   * `web_search` past the progress bar rather than a searching-for line, **and gives no way to
   * see what the model is searching for**; while the same interface on Gemini shows the query.
   * The closing `searchQueries` is consistent across all three, so an after-the-fact report
   * cannot reveal this difference.
   *
   * What is pinned here is **current real behaviour**, not what it ought to be — changing
   * `emitProgress` so Anthropic also emits a `search` event at `content_block_stop` is a
   * separate matter, and this test gets inverted when that happens.
   */
  test('only gemini can report a live search query; the anthropic family reports the raw tool name', async () => {
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
    assert.deepEqual(seen.anthropic, ['web_search'], 'a wire-format tool name leaked into the progress bar');
    assert.deepEqual(seen.deepseek, ['web_search'], 'the same class as anthropic, so the same behaviour');
  });

  test('the guide body the three vendors produce is byte-identical', async () => {
    const texts = [];
    for (const c of CASES) {
      const { db, config } = freshEnv(c.ai);
      const provider = await createProvider(config, { fetchImpl: fakeFetch(() => c.sse(BODY)) });
      const r = await generateGuide(db, { config, provider, steam: fakeSteam(['A']), appid: '1' });
      texts.push(readFileSync(r.path, 'utf8'));
    }
    assert.equal(texts[0], texts[1], 'the anthropic and deepseek presets go through the same class and should not differ');
    assert.equal(texts[0], texts[2], 'gemini output differs from anthropic — the orchestration layer recognised the vendor');
  });

  /**
   * **Thought parts only really land in the file when the model writes no markdown fence.**
   *
   * The first version of this test used the fenced BODY, which made it **permanently green**:
   * `extractMarkdown` takes only what is inside the fence, the thoughts are outside it, and no
   * amount of leaking reaches the file. Mutation testing found it immediately — turning
   * `if (p?.thought)` in `ai-gemini.js` into a constant false left all 9 tests green.
   *
   * And a fence is no guarantee: `extractMarkdown` itself keeps a "no fence at all ⇒ treat the
   * whole thing as body" fallback. Stack those two and the chain of thought is written into the
   * user's guide while **the validator cannot catch it** — those lines are neither checkboxes
   * nor a violation of any rule. So no fence is sent here on purpose.
   */
  test('gemini thought parts must not get into the guide file (when the model writes no fence)', async () => {
    const bare = BODY.replace(/^```markdown\n/, '').replace(/\n```$/, '');
    assert.ok(!bare.includes('```'), 'the premise of this test is that there is no fence; with one it verifies nothing');

    const { db, config } = freshEnv({ provider: 'gemini', apiKey: 'k' });
    const provider = await createProvider(config, { fetchImpl: fakeFetch(() => geminiSse(bare)) });
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1' });

    const text = readFileSync(r.path, 'utf8');
    assert.match(text, /- \[ \] \*\*第二步\*\*/, 'the body itself still has to land');
    assert.ok(!text.includes('先查一下'), 'the model chain of thought was written into the user guide');
  });
});

// ---------------------------------------------------------------------------
// The fields exclusive to the official endpoint — the one path no real run has exercised
// ---------------------------------------------------------------------------

describe('the request sent to the official Anthropic endpoint', () => {
  /** Run one round and hand back the request body and headers actually sent */
  async function capture(ai) {
    const { db, config } = freshEnv(ai);
    const fetchImpl = fakeFetch(() => anthropicSse(BODY));
    const provider = await createProvider(config, { fetchImpl });
    await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1' });
    return fetchImpl.calls[0];
  }

  test('both web tools are declared, and at the _20260209 version', async () => {
    const { body } = await capture({ provider: 'anthropic', apiKey: 'k' });
    assert.deepEqual(
      body.tools.map((t) => t.type),
      ['web_search_20260209', 'web_fetch_20260209'],
      'web_fetch is on by default only on the official endpoint — its success shape was once read as a failure, and that bug hid on this path'
    );
    assert.ok(
      !body.tools.some((t) => /code_execution/.test(t.type)),
      '_20260209 carries dynamic filtering, so declaring code_execution as well shows the model two execution environments'
    );
  });

  test('thinking / output_config / fallbacks are each sent on their own terms', async () => {
    const { body, headers } = await capture({ provider: 'anthropic', apiKey: 'k' });
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.ok(!('budget_tokens' in body.thinking), 'budget_tokens is a 400 on the official endpoint, and worse on the compatible one (200, but inverted)');
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.fallbacks, 'default');
    assert.equal(
      headers['anthropic-beta'], 'server-side-fallback-2026-07-01',
      'the scalar form of fallbacks pairs with -2026-07-01; pairing it with the array form -2026-06-01 is a 400'
    );
    assert.equal(body.stream, true, 'max_tokens caps thinking plus prose, so without streaming the HTTP timeout comes first');
  });

  test('these three fields have different fates on the compatible endpoint and cannot ride one switch', async () => {
    const { body, headers } = await capture({ provider: 'deepseek', apiKey: 'k' });
    assert.equal(body.thinking, undefined, 'the compatible endpoint does not send thinking by default');
    assert.deepEqual(body.output_config, { effort: 'high' }, 'DeepSeek /anthropic is measured to understand effort — the one knob that has any effect');
    assert.equal(body.fallbacks, undefined);
    assert.equal(headers['anthropic-beta'], undefined);
    assert.deepEqual(body.tools.map((t) => t.type), ['web_search_20260209'], 'declaring web_fetch on the compatible endpoint 400s the whole request');
  });
});
