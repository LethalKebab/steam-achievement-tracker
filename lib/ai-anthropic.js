/**
 * The Anthropic provider
 * ------------------------------------------------
 * Split out of lib/ai.js (which would exceed 800 lines once a second vendor was added). The shared
 * parts — usage accounting, pricing, sessions, result verdicts — stay in ai.js; this file holds
 * only what is specific to Anthropic: what the request looks like, how SSE blocks are assembled,
 * and how the server-side tool loop resumes.
 *
 * Several lines that must not be crossed (sourced from the authoritative API documentation, not
 * from memory):
 *
 * - **Streaming is mandatory.** `max_tokens` is the **combined** ceiling for thinking plus prose,
 *   and Opus 5 thinks by default; a 60-achievement guide with web research hits the HTTP timeout
 *   (undici's default of 5 minutes) before it hits the token ceiling on a non-streaming request.
 * - **Never declare `code_execution` separately again.** The `_20260209` web tools already run
 *   code internally for dynamic filtering, and adding one produces two execution environments.
 * - **Do not send `temperature` / `top_p` / `top_k` / `budget_tokens`** — all four are a 400 on
 *   Opus 5, not "ignored". Depth is controlled with `output_config.effort`.
 * - **Do not use a trailing assistant prefill**, likewise a 400.
 * - **Server tool errors do not throw**; they arrive as HTTP 200 with an error object in content.
 *   And **the success shapes of the two tools differ**: web_search succeeds with an **array**,
 *   web_fetch with an **object**. Do not take either as the general rule — see the table on
 *   `serverToolErrors` and the defect it records.
 */
import {
  AiError, emptyUsage, mergeMessageUsage, addUsage, sseEvents, normalizeStop,
} from './ai.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The server-side search/fetch tools. Dynamic filtering exists only from `_20260209` onwards, which
 * applies to Opus 5 / 4.8 / 4.7 / 4.6 and Sonnet 5 / 4.6. An older model needs
 * `web_search_20250305` instead.
 */
const WEB_SEARCH_TOOL = 'web_search_20260209';
const WEB_FETCH_TOOL = 'web_fetch_20260209';

/**
 * Endpoints measured to accept `output_config.effort`. **Only measured ones are listed.**
 *
 * This table exists because of what was wrong with the inference it replaced: that used
 * `!ai.baseUrl` as the test, and that expression asks "is this the official endpoint" while the
 * question being answered is "may this field be sent". DeepSeek's /anthropic answers those two
 * oppositely — it is not the official endpoint, yet it accepts the field, and this is the only
 * effective speed control in guide generation (see the measured table in the constructor).
 *
 * Before adding a vendor here, send one real request to its endpoint and check for a 200; do not
 * infer it from "it is Anthropic-compatible".
 */
const EFFORT_ENDPOINTS = [/^https:\/\/api\.anthropic\.com\b/, /^https:\/\/api\.deepseek\.com\b/];

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Anthropic's stop_reason → the project-wide vocabulary */
const STOP_MAP = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'end_turn',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

/** Concatenate the text blocks (thinking and tool blocks are skipped) */
function textOfBlocks(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/**
 * What a server tool's result block looks like — **the two tools' success shapes differ, and that
 * is the one thing to be careful about here**:
 *
 * | Tool | `content` on success | `content` on error |
 * |---|---|---|
 * | web_search | an **array** (the result list) | `{type:'web_search_tool_result_error', error_code}` |
 * | web_fetch | an **object** `{type:'web_fetch_result', url, content:{document}}` | `{type:'web_fetch_tool_result_error', error_code}` |
 *
 * **Because the success shapes differ, one `Array.isArray` cannot judge both tools.** That rule
 * holds for web_search only; applying it to web_fetch records every **successful** page fetch as an
 * error (with the error code being the success block's own type, `web_fetch_result`), and
 * `checkResult` treats any tool error as making the whole round unusable — so a successful fetch
 * becomes a failed generation. This defect also **hides until the official endpoint**: web_fetch is
 * only enabled by default there (see `webTools`), and is off by default on compatibility endpoints.
 *
 * Success is always recognised **positively**, and an unrecognised shape is reported as an
 * `unknown` error rather than waved through: a rate-limited search read as "the search returned
 * nothing" makes the model write the guide empty-handed, and that class of silent degradation is
 * exactly what this project guards against. The cost of that strictness is absorbed by
 * `checkResult`'s grading — the fetch side no longer kills the round.
 */
const RESULT_KINDS = {
  web_search_tool_result: { tool: 'search', ok: (inner) => Array.isArray(inner) },
  web_fetch_tool_result: { tool: 'fetch', ok: (inner) => inner?.type === 'web_fetch_result' },
};

/**
 * One result block → `null` (success, or not a tool block) or `{tool, errorCode}`.
 *
 * `serverToolErrors` and the progress events **share this one predicate**. They each had their own
 * copy, so the same bug existed twice: one reported "the research for this round is incomplete"
 * while the progress bar simultaneously displayed every successful fetch as 失败(unknown).
 */
export function toolResultError(block) {
  const kind = RESULT_KINDS[block?.type];
  if (!kind) return null;
  const inner = block.content;
  if (kind.ok(inner)) return null;
  return { tool: kind.tool, errorCode: inner?.error_code ?? inner?.type ?? 'unknown' };
}

/** Collect every server tool failure in this round. `tool` uses neutral words (`search`/`fetch`) rather than leaking Anthropic's block names */
export function serverToolErrors(content) {
  const out = [];
  for (const b of content ?? []) {
    const err = toolResultError(b);
    if (err) out.push(err);
  }
  return out;
}

/** The queries the model actually issued. An empty array means it never went to the web, which is a signal that should be visible */
export function searchQueriesOf(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'server_tool_use' && b?.name === 'web_search')
    .map((b) => b.input?.query)
    .filter(Boolean);
}

/**
 * Reassemble the SSE event stream into one complete message.
 *
 * The deltas differ per block type: text uses `text_delta`, thinking uses `thinking_delta` plus
 * `signature_delta`, and tool input uses `input_json_delta` (assembled, then JSON.parse'd).
 * A server tool's **result** block has no deltas — `content_block_start` already carries it whole.
 */
export function createAccumulator() {
  const content = [];
  const state = { stopReason: null, stopDetails: null, usage: emptyUsage(), model: null, id: null };

  return {
    content,
    state,
    push(ev) {
      switch (ev?.type) {
        case 'message_start': {
          const m = ev.message ?? {};
          state.model = m.model ?? state.model;
          state.id = m.id ?? state.id;
          mergeMessageUsage(state.usage, m.usage);
          break;
        }
        case 'content_block_start': {
          const block = structuredClone(ev.content_block ?? {});
          // The input arrives in stream fragments; hold a scratch field and parse it at content_block_stop
          if ('input' in block) block.__json = '';
          content[ev.index] = block;
          break;
        }
        case 'content_block_delta': {
          const b = content[ev.index];
          const d = ev.delta ?? {};
          if (!b) break;
          if (d.type === 'text_delta') b.text = (b.text ?? '') + (d.text ?? '');
          else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (d.thinking ?? '');
          else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + (d.signature ?? '');
          else if (d.type === 'input_json_delta') b.__json = (b.__json ?? '') + (d.partial_json ?? '');
          break;
        }
        case 'content_block_stop': {
          const b = content[ev.index];
          if (!b) break;
          if (typeof b.__json === 'string') {
            // Keep the original value rather than throwing when the assembled text is not valid
            // JSON — this block is the model's input to a server tool and we only forward it, so a
            // parse failure must not fail the round
            if (b.__json) {
              try {
                b.input = JSON.parse(b.__json);
              } catch {
                /* keep the original value */
              }
            }
            delete b.__json;
          }
          break;
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason) state.stopReason = ev.delta.stop_reason;
          if (ev.delta?.stop_details !== undefined) state.stopDetails = ev.delta.stop_details;
          mergeMessageUsage(state.usage, ev.usage);
          break;
        }
        case 'error': {
          const e = ev.error ?? {};
          throw new AiError(`流中断:${e.type ?? 'error'} ${e.message ?? ''}`, {
            type: e.type ?? null,
            retryable: e.type === 'overloaded_error' || e.type === 'api_error',
          });
        }
        default:
          break;
      }
    },
    /** A block that never received its content_block_stop leaves a hole in the array; filter those out */
    result() {
      return { content: content.filter(Boolean), ...state };
    },
  };
}

export class AnthropicProvider {
  /** The key lives in a private field so that console.log(provider) or an error object cannot carry it out */
  #apiKey;

  constructor(ai, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!ai?.apiKey) {
      throw new AiError(
        'Anthropic API key 没配置。填 config.json 的 ai.apiKey,或者用环境变量 ANTHROPIC_API_KEY=...'
      );
    }
    // The display name is overridable — this layer also drives DeepSeek's Anthropic-compatible
    // endpoint, where an error saying "Anthropic API" and pointing at ANTHROPIC_API_KEY sends the
    // reader somewhere entirely wrong
    this.name = ai.providerName || 'anthropic';
    this.envVar = ai.providerEnvVar || 'ANTHROPIC_API_KEY';
    this.ai = ai;
    this.model = ai.model || 'claude-opus-5';
    this.maxTokens = ai.maxTokens ?? 32000;
    this.maxContinuations = ai.maxContinuations ?? 5;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    // **The endpoint is configurable.** Not only for proxying: measured, DeepSeek's
    // Anthropic-compatible endpoint `https://api.deepseek.com/anthropic` supports **server-side
    // web_search** — declaring the tool produces server_tool_use / web_search_tool_result blocks in
    // the response and a web_search_requests count in usage, while the same model without tools
    // honestly answers that it cannot find anything.
    // In other words this layer gives DeepSeek web access unchanged, with nothing else to write.
    // (Note: DeepSeek's **OpenAI-compatible** /chat/completions does not have this capability, see
    //  ai-deepseek.js — one vendor, two endpoints, different capabilities; do not carry a conclusion
    //  about one over to the other.)
    this.baseUrl = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Anthropic-proprietary extensions are only sent to the official endpoint. **This is not a
    // master switch** — see the lines below.
    this.extras = ai.anthropicExtras ?? !ai.baseUrl;

    // -----------------------------------------------------------------------
    // Reasoning depth: **sent separately from thinking, because the two have different fates**
    //
    // **`thinking` / `output_config` / `fallbacks` must each be independent and must not be bundled
    // onto `extras`.** `extras` asks "is this the official endpoint", which is a judgement about
    // **endpoint identity**; "will this field be accepted" is a different question. Bundling them
    // fails silently: the `provider: "deepseek"` preset always sets baseUrl, so `ai.effort` (the
    // depth control documented in config.js, defaulting to 'high') was never once transmitted.
    //
    // Measured on DeepSeek's /anthropic, the same 10-achievement shard with web tools:
    //
    //   nothing sent          337 s  thinking 145955 chars  8 searches   ← what had been running
    //   output_config low      43 s  thinking  15523 chars  2 searches
    //   thinking:adaptive
    //     + output_config low  87 s  thinking  34150 chars  5 searches   ← what bundling produces
    //   thinking:disabled       6 s  thinking      0 chars  **0** searches
    //
    // Two conclusions. **adaptive overrides effort** — with the same effort:low, sending adaptive as
    // well doubles the thinking and halves the gain, so they must be separately sendable. And
    // **thinking:disabled turns off web search along with it** (run twice, 0 searches both times),
    // which is precisely the "write from memory" the `canSearch` admission design guards against —
    // so it is not a tier that should be recommended: configurable, but never treated as "a faster high".
    //
    // **Whether an endpoint accepts output_config is a per-endpoint measurement, not something
    // derivable from baseUrl.** Hence a table listing only measured endpoints (EFFORT_ENDPOINTS),
    // with nothing sent to anything unmeasured — those endpoints are not receiving this field today,
    // and sending them a parameter that may be rejected trades someone else's availability for our
    // speed. Both escape hatches remain: a self-hosted endpoint that does accept it takes
    // anthropicExtras: true, and effort: 'off' sends it nowhere.
    const effortOk = this.extras || EFFORT_ENDPOINTS.some((re) => re.test(this.baseUrl));
    this.effort = effortOk && ai.effort && ai.effort !== 'off' ? ai.effort : null;
    // 'adaptive' | 'disabled' | 'off' (send no field). adaptive is sent by default only on the
    // official endpoint — omitting thinking there means **no thinking at all** on 4.8/4.7, and since
    // model is configurable, being explicit is more reliable than relying on a default happening to
    // be right. Nothing is sent by default on compatibility endpoints, because sending it overrides effort.
    //
    // Turning it off uses `'off'` rather than `null`: `null ?? default` falls back to the default, so
    // "I do not want this field" and "I did not write anything" would be inexpressible in the config
    // — the same word as effort uses, so the two controls do not need two different conventions
    const t = ai.thinking ?? (this.extras ? 'adaptive' : 'off');
    this.thinking = t === 'off' ? null : t;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  /** Has server-side search. See the note on canSearch at the top of ai.js */
  get canSearch() {
    return true;
  }

  /**
   * The two server-side tools used for web research.
   *
   * The division of labour is not a choice between summaries and full text: **search finds the
   * candidate URLs and web_fetch brings the full text back**, with `max_content_tokens` as the
   * control for how much. And web_fetch **can only fetch URLs that already appeared in the
   * conversation**, so search must come first — a hard ordering constraint, not an implementation
   * detail.
   *
   * `allowedDomains` defaults to empty, meaning unrestricted. The API offers only allowed/blocked
   * **hard filtering**, and how well Chinese guide sites are actually covered in the search index
   * has never been measured, so locking search to a handful of sites by default trades quality for
   * an unmeasured assumption.
   *
   * `citations` is explicitly disabled: enabled, it inserts citation metadata into the text blocks,
   * while SKILL.md rule 七 explicitly requires that a guide's prose not state where its data came from.
   */
  webTools() {
    const ai = this.ai;
    // The search tool version is configurable: a compatibility endpoint may only accept the older one
    const search = { type: ai.searchTool || WEB_SEARCH_TOOL, name: 'web_search' };
    if (ai.maxSearches > 0) search.max_uses = ai.maxSearches;
    if (ai.allowedDomains?.length) search.allowed_domains = ai.allowedDomains;

    // **web_fetch is not available on every endpoint.** Measured: DeepSeek's /anthropic accepts
    // web_search only (the 400 reads: expected `web_search_20250305` or `web_search_20260209`), and
    // declaring web_fetch kills the whole request. So it is only sent to the official endpoint by
    // default.
    // The cost is that a compatibility endpoint sees search-result summaries only and never a full
    // page, giving guides one grade lower quality — but that difference is visible in ai-check's
    // output rather than happening silently
    if (ai.webFetch ?? !ai.baseUrl) {
      const fetchTool = { type: WEB_FETCH_TOOL, name: 'web_fetch', citations: { enabled: false } };
      if (ai.maxFetches > 0) fetchTool.max_uses = ai.maxFetches;
      if (ai.maxFetchTokens > 0) fetchTool.max_content_tokens = ai.maxFetchTokens;
      if (ai.allowedDomains?.length) fetchTool.allowed_domains = ai.allowedDomains;
      return [search, fetchTool];
    }
    return [search];
  }

  #headers() {
    const h = {
      'content-type': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    // Opus 5's classifier can refuse outright (HTTP 200 plus refusal). fallbacks is **opt-in**:
    // when enabled, the server retries the same request with a different model.
    if (this.extras && this.ai.fallbacks !== false) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return h;
  }

  /** Assemble the request body. Extracted so that `--dry` can print it without sending anything */
  buildBody({ system, messages, tools }) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      stream: true,
    };
    if (system) {
      // cache_control on the last block: a feedback rewrite resends the same rules and achievement
      // list, and a cache hit bills at a tenth of the rate
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (tools?.length) body.tools = tools;

    // **Each of the three fields decides for itself whether to be sent; they no longer share one
    // switch** — the reasoning and the measurements are in the passage above `this.effort` in the
    // constructor. Bundled, the only control that actually works (effort) was blocked by the other
    // two's admission condition, and sending it alongside thinking had it overridden anyway.
    //
    // Sending a compatibility endpoint one field it does not recognise makes the whole request 400,
    // and that class of error usually says only "invalid field", pointing nowhere near the real
    // cause of sending a proprietary parameter to a third-party endpoint — hence errorFromResponse
    // carries a dedicated hint for each of these two fields.
    if (this.thinking) {
      // **Never include budget_tokens.** It is a 400 on the official endpoint; on DeepSeek's
      // /anthropic it is worse — it returns 200 and then **moves in the opposite direction**:
      // measured, asking for 2000 produced 49,653 characters of thinking and asking for 8000
      // produced 62,107, both more than the 38,196 produced by omitting the field. A parameter that
      // makes things slower by setting a ceiling, with nothing raising an error
      body.thinking = this.thinking === 'disabled'
        ? { type: 'disabled' }
        : this.ai.showThinking
          ? { type: 'adaptive', display: 'summarized' }
          : { type: 'adaptive' };
    }
    if (this.effort) body.output_config = { effort: this.effort };
    if (this.extras && this.ai.fallbacks !== false) body.fallbacks = 'default';
    return body;
  }

  async #once(body, { onEvent } = {}) {
    const ac = new AbortController();
    // Aborting is only permitted once the stream has started; see the explanation in the catch below
    let streaming = false;
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, this.name, this.envVar);
      streaming = true;

      const acc = createAccumulator();
      for await (const ev of sseEvents(res.body)) {
        emitProgress(ev, onEvent);
        acc.push(ev);
      }
      const out = acc.result();
      out.usage.requests = 1;
      return out;
    } catch (err) {
      // When the stream fails partway the connection is still open, and a retry opens another, so
      // without aborting a socket leaks on every attempt.
      // **Only abort while the stream is still open.** Aborting after the request has returned
      // completely (a 4xx, say, whose body has already been consumed by text()) triggers a libuv
      // assertion at process exit on Windows:
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
      if (streaming) ac.abort();
      if (err instanceof AiError) throw err;
      if (err?.name === 'AbortError') {
        throw new AiError(
          `请求超过 ${Math.round(this.timeoutMs / 1000)} 秒没结束。高 effort + 联网研究本来就慢,` +
            '不够就调大 config.json 的 ai.requestTimeoutMs',
          { retryable: false }
        );
      }
      throw new AiError(`请求失败:${err?.message ?? err}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async #withRetry(body, opts) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.#once(body, opts);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof AiError) || !err.retryable || attempt === this.maxRetries) throw err;
        const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
        this.log(`  第 ${attempt + 1} 次失败(${err.message.slice(0, 60)}),${wait}ms 后重试`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /**
   * Run one complete conversation turn, including the server-side tool loop.
   *
   * **This loop is not client-side tool execution** — web_search and web_fetch both run to
   * completion on Anthropic's side. The loop exists because the server's sampling loop has an
   * iteration cap (10 by default); hitting it returns `stop_reason: 'pause_turn'`, and the assistant
   * turn is appended back into messages verbatim before sending again.
   *
   * **Never add a "continue" message**: the server resumes off the trailing server_tool_use block,
   * and an extra user message interrupts it.
   */
  async send({ system, messages, tools, onEvent } = {}) {
    const convo = [...messages];
    const usage = emptyUsage();
    let last = null;
    let continuations = 0;

    for (;;) {
      last = await this.#withRetry(this.buildBody({ system, messages: convo, tools }), { onEvent });
      addUsage(usage, last.usage);
      if (last.stopReason !== 'pause_turn') break;
      if (continuations >= this.maxContinuations) {
        throw new AiError(
          `服务端工具循环续跑了 ${continuations} 次还没结束(ai.maxContinuations)。` +
            '多半是模型在反复搜索:把 ai.maxSearches 调小,或者把任务拆细',
          { retryable: false }
        );
      }
      convo.push({ role: 'assistant', content: last.content });
      continuations++;
    }

    // On a pause_turn continuation the final message carries only that segment's content. The whole
    // turn has to be concatenated back for the caller, or everything found by the earlier searches
    // is lost
    const full = [];
    for (const m of convo.slice(messages.length)) full.push(...m.content);
    full.push(...last.content);

    return {
      content: full,
      text: textOfBlocks(full),
      stopReason: normalizeStop(STOP_MAP, last.stopReason),
      rawStopReason: last.stopReason,
      stopDetails: last.stopDetails,
      usage,
      model: last.model ?? this.model,
      continuations,
      toolErrors: serverToolErrors(full),
      searchQueries: searchQueriesOf(full),
    };
  }
}

/**
 * A raw SSE event → a generic progress event.
 *
 * Callers (the CLI's live output, guidegen's progress bar) should know no vendor's event format, or
 * every additional provider would mean editing all the display code. The raw event is attached at
 * `.raw` for reference.
 */
function emitProgress(ev, onEvent) {
  if (!onEvent) return;
  if (ev.type === 'content_block_start') {
    const b = ev.content_block ?? {};
    if (b.type === 'server_tool_use') {
      onEvent({ type: 'tool', name: b.name, raw: ev });
    } else if (RESULT_KINDS[b.type]) {
      // Success and failure are judged by toolResultError, shared with serverToolErrors — the
      // consequence of separate copies is recorded there
      const err = toolResultError(b);
      onEvent({
        type: 'tool-result',
        ok: !err,
        tool: RESULT_KINDS[b.type].tool,
        errorCode: err?.errorCode ?? null,
        raw: ev,
      });
    }
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    onEvent({ type: 'text', text: ev.delta.text ?? '', raw: ev });
  }
}

/**
 * A non-200 response → an AiError.
 *
 * The error body is `{type:'error', error:{type,message}, request_id}`. request_id must be carried:
 * it is the only thing that identifies this request when reporting a fault. **No response or
 * request header is included** — they contain x-api-key.
 */
async function errorFromResponse(res, providerName = 'anthropic', envVar = 'ANTHROPIC_API_KEY') {
  let type = null;
  let detail = '';
  let requestId = res.headers.get('request-id');
  const raw = await res.text().catch(() => '');
  try {
    const body = JSON.parse(raw);
    type = body?.error?.type ?? null;
    detail = body?.error?.message ?? '';
    requestId = body?.request_id ?? requestId;
  } catch {
    detail = raw.slice(0, 300);
  }

  let hint = '';
  if (res.status === 401) {
    hint = `\n  (API key 不对或已撤销:检查 config.json 的 ai.apiKey / 环境变量 ${envVar})`;
  } else if (res.status === 400 && /fallback|beta/i.test(detail)) {
    // The beta header is the easiest 400 to hit. Someone seeing this error has no other clue as to which switch to turn off
    hint = '\n  (像是 fallbacks 的 beta 头不被接受:在 config.json 里设 "ai": { "fallbacks": false } 关掉再试)';
  } else if (res.status === 400 && /unknown variant|web_fetch|web_search/i.test(detail)) {
    // Common on compatibility endpoints, which implement only some of the tools. The error text
    // usually lists which ones it accepts, and the configuration can follow that. Measured:
    // DeepSeek's /anthropic accepts web_search only, and declaring web_fetch 400s the whole request
    hint =
      '\n  (这个端点不认某个工具声明——上面的 message 通常会列出它接受哪些。\n' +
      '   常见修法:config.json 里设 "webFetch": false(只用搜索,不抓整页正文),\n' +
      '   或者 "searchTool": "web_search_20250305" 换成老版本的搜索工具)';
  } else if (res.status === 400 && /output_config|effort|thinking/i.test(detail)) {
    // These two fields are now sent to the endpoints in EFFORT_ENDPOINTS and to self-hosted
    // endpoints that explicitly enable anthropicExtras. Someone hitting this 400 has no other clue
    // as to which to turn off — especially since effort's default comes from an endpoint table
    // rather than from anything they wrote into their config
    hint =
      '\n  (这个端点不认推理深浅的参数。config.json 里设 "ai": { "effort": "off" } 关掉 output_config,\n' +
      '   或者设 "thinking": "off" 不发 thinking。两个是分开的开关,报错里提到哪个就关哪个)';
  } else if (res.status === 400) {
    hint = '\n  (400 是请求本身的问题,重试没用——看上面的 message)';
  }

  return new AiError(`${providerName} API HTTP ${res.status}${type ? ` ${type}` : ''}:${detail}${hint}`, {
    status: res.status,
    type,
    requestId,
    retryable: res.status === 429 || res.status >= 500,
  });
}
