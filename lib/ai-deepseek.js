/**
 * The DeepSeek provider
 * ------------------------------------------------
 * **This vendor has no server-side web search**, so its position differs from the other two.
 *
 * The design document makes "has server-side search" a hard admission requirement, on the grounds
 * that letting one without search in makes quality depend on which vendor the user picked, and
 * the user cannot see that difference. DeepSeek's API does not offer the capability (the chat
 * site does, the API does not), so it **does not meet the bar for being offered to users**.
 *
 * It was integrated for a different purpose: **getting the pipeline itself working end to end.**
 * Mechanical ticking, the validation gate, the feedback rewrite loop and landing had until then
 * only run against a fake provider — and **none of them needs the web**. Verifying the
 * orchestration with a cheap, stable model that a key is obtainable for was worth far more than
 * continuing to be blocked on quota.
 *
 * So `canSearch = false`, and that flag propagates all the way through:
 *   - `guide-gen` **refuses** to generate with it by default, unless `--no-research` is passed
 *   - The prompt switches to the "you have no web access, write nothing you are unsure of" variant
 *   - The CLI result states plainly that this guide involved no research
 * This makes "no web access this time" an unmissable fact rather than a quality difference the
 * user cannot see.
 *
 * The protocol is the OpenAI-compatible chat/completions, unlike both other vendors, so as usual
 * it is confined to this file. Field names came from memory (the web tools were still unavailable
 * when this was written), so **anything configurable is made configurable**, and
 * a wrong guess is fixed in configuration rather than in code.
 */
import { AiError, emptyUsage, addUsage, sseEvents, normalizeStop } from './ai.js';
import { msg } from './messages.js';
import { clog } from './cli-messages.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The OpenAI-compatible finish_reason → the project-wide vocabulary */
const STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
  tool_calls: 'end_turn',
  // DeepSeek's own addition: the server is out of resources, which is a transient condition
  // rather than anything to do with the content
  insufficient_system_resource: 'other',
};

/** The usage fields use OpenAI's naming */
export function mergeDeepseekUsage(target, u) {
  if (!u) return target;
  // Every chunk carrying usage reports this message's cumulative total — overwrite, never add
  if (typeof u.prompt_tokens === 'number') target.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') target.outputTokens = u.completion_tokens;
  // DeepSeek's on-disk context cache: the hit portion is reported separately and maps to our cacheRead
  const hit = u.prompt_cache_hit_tokens;
  if (typeof hit === 'number') {
    target.cacheReadTokens = hit;
    // inputTokens already includes the hit portion; subtract it so the same tokens are not counted twice
    if (typeof u.prompt_tokens === 'number') target.inputTokens = u.prompt_tokens - hit;
  }
  return target;
}

/**
 * Reassemble streamed chunks into one complete reply.
 *
 * **`reasoning_content` must never reach the prose** — deepseek-reasoner puts its chain of
 * thought in that field, alongside the prose in the same delta. Mixing it in means writing the
 * model's reasoning into the user's guide file.
 */
export function createDeepseekAccumulator() {
  const state = { text: '', thinking: '', stopReason: null, usage: emptyUsage(), model: null };

  return {
    state,
    push(chunk) {
      if (chunk?.usage) mergeDeepseekUsage(state.usage, chunk.usage);
      if (chunk?.model) state.model = chunk.model;
      const choice = chunk?.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) state.stopReason = choice.finish_reason;
      const d = choice.delta ?? {};
      if (typeof d.reasoning_content === 'string') state.thinking += d.reasoning_content;
      if (typeof d.content === 'string') state.text += d.content;
    },
    result() {
      return { ...state };
    },
  };
}

export class DeepseekProvider {
  #apiKey;

  constructor(ai, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!ai?.apiKey) {
      throw new AiError(
        msg('ai.noKeyConfigured', { vendor: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' })
      );
    }
    // Distinct from the `provider: 'deepseek'` preset — that one uses the Anthropic-compatible
    // endpoint and does have web access
    this.name = 'deepseek-openai';
    this.ai = ai;
    this.model = ai.model || 'deepseek-chat';
    // Both the context window and the single-response output ceiling are considerably smaller
    // than the other two vendors', so the default is conservative. Exceeding it surfaces as a
    // 400 rather than a silent truncation — if it genuinely is not enough, raise ai.maxTokens or
    // switch vendor
    this.maxTokens = ai.maxTokens ?? 8000;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    this.baseUrl = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  /**
   * Whether there is web access is **derived from configuration, never hardcoded**.
   *
   * The understanding when this file was written was that DeepSeek's API offers no server-side
   * search (the chat site does, the API does not), so `deepseekTools` defaults to empty and
   * canSearch is false. But that is **a fact with an expiry date**, and it was reached without
   * access to the documentation — the same session had already been caught out twice asserting
   * an API surface from memory.
   *
   * So it is built this way: if server-side search does exist, put its declaration in
   * `ai.deepseekTools`, and canSearch becomes true, the prompt switches back to the web-enabled
   * variant, and guide-gen's gate opens. One line of configuration, no code change.
   */
  get canSearch() {
    return this.webTools().length > 0;
  }

  webTools() {
    return this.ai.deepseekTools ?? [];
  }

  /** `ai-check --models`: the OpenAI-compatible GET /models. Asking the API is more reliable than consulting memory */
  async listModels() {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.#headers() });
    if (!res.ok) throw await errorFromResponse(res, this.model, this.#apiKey);
    const data = await res.json();
    return (data.data ?? []).map((m) => ({
      name: String(m.id ?? ''),
      display: m.owned_by ? `(${m.owned_by})` : '',
      inputLimit: null,
      outputLimit: null,
    }));
  }

  #headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` };
  }

  /** The generic message shape → OpenAI-compatible messages. Here system is one entry in messages */
  #toMessages(system, messages) {
    const out = system ? [{ role: 'system', content: system }] : [];
    for (const m of messages ?? []) {
      out.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : String(m.content?.[0]?.text ?? ''),
      });
    }
    return out;
  }

  buildBody({ system, messages }) {
    return {
      model: this.model,
      messages: this.#toMessages(system, messages),
      stream: true,
      // Without this, streaming mode returns no usage and the accounting is impossible
      stream_options: { include_usage: true },
      max_tokens: this.maxTokens,
    };
  }

  async #once(body, { onEvent, signal: externalSignal } = {}) {
    const ac = new AbortController();
    // Aborting is only permitted once the stream has started; see the explanation in the catch below
    let streaming = false;
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    // **The external signal and the idle timeout share one AbortController** — see the identical
    // comment in ai-anthropic.js's #once, which this mirrors exactly.
    const onExternalAbort = () => ac.abort();
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort);
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, this.model, this.#apiKey);
      streaming = true;

      const acc = createDeepseekAccumulator();
      for await (const ev of sseEvents(res.body)) {
        emitProgress(ev, onEvent);
        acc.push(ev);
      }
      const out = acc.result();
      out.usage.requests = 1;
      return out;
    } catch (err) {
      // **Only abort while the stream is still open.** Aborting after the request has returned
      // completely (a 4xx, say, whose body has already been consumed by text()) triggers a libuv
      // assertion at process exit on Windows:
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
      if (streaming) ac.abort();
      if (err instanceof AiError) throw err;
      if (err?.name === 'AbortError') {
        if (externalSignal?.aborted) {
          throw new AiError(msg('ai.cancelled'), { retryable: false, cancelled: true });
        }
        // **States only what happened** — see the identical comment in ai-anthropic.js
        const timeoutErr = new AiError(
          msg('ai.timedOut', { seconds: Math.round(this.timeoutMs / 1000) }),
          { retryable: false }
        );
        timeoutErr.code = 'ai-timeout';
        throw timeoutErr;
      }
      throw new AiError(msg('ai.requestFailed', { reason: err?.message ?? err }), { retryable: true });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
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
        this.log(clog('ai.retrying', {
          attempt: attempt + 1, reason: err.message.slice(0, 60), wait,
        }));
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /** One conversation round. There are no server-side tools, so there is no continuation loop and `continuations` is always 0 */
  async send({ system, messages, onEvent, signal } = {}) {
    const usage = emptyUsage();
    const r = await this.#withRetry(this.buildBody({ system, messages }), { onEvent, signal });
    addUsage(usage, r.usage);

    return {
      content: r.text,
      text: r.text,
      stopReason: normalizeStop(STOP_MAP, r.stopReason),
      rawStopReason: r.stopReason,
      stopDetails: null,
      usage,
      model: r.model ?? this.model,
      continuations: 0,
      toolErrors: [],
      // Always empty, and **structurally** so: this vendor has no web access
      searchQueries: [],
      thinking: r.thinking,
    };
  }
}

/** A raw chunk → a generic progress event */
function emitProgress(chunk, onEvent) {
  if (!onEvent) return;
  const d = chunk?.choices?.[0]?.delta;
  if (typeof d?.content === 'string' && d.content) onEvent({ type: 'text', text: d.content, raw: chunk });
}

/**
 * Describe a key's **shape** without disclosing its content.
 * On a 401 the most useful information is what was actually sent, and these few facts are enough
 * to identify the overwhelming majority of paste accidents.
 */
export function describeKey(k) {
  const s = String(k ?? '');
  if (!s) return msg('ai.keyEmpty');
  const bits = [msg('ai.keyLength', { n: s.length })];
  bits.push(s.startsWith('sk-')
    ? msg('ai.keyStartsSk')
    : msg('ai.keyStartsOther', { prefix: s.slice(0, 3) }));
  if (s !== s.trim()) bits.push(msg('ai.keyHasSpace'));
  if (/^["']|["']$/.test(s)) bits.push(msg('ai.keyHasQuotes'));
  return bits.join(msg('ai.keyShapeSep'));
}

async function errorFromResponse(res, model, apiKey = '') {
  let type = null;
  let detail = '';
  const raw = await res.text().catch(() => '');
  try {
    const body = JSON.parse(raw);
    type = body?.error?.type ?? body?.error?.code ?? null;
    detail = body?.error?.message ?? '';
  } catch {
    detail = raw.slice(0, 300);
  }

  // **Keep the diagnosis, drop the command line.** These sentences appear verbatim in the
  // Dashboard's floating bar, where (especially in the packaged build) there is no terminal to
  // type into and no config.json being edited. Facts such as what the key looked like are useful
  // on both surfaces and stay; "which command clears the environment variable" is meaningful only
  // in a terminal and is attached by code to tracker.js's CLI_HINTS (see that table)
  let hint = '';
  let code = null;
  if (res.status === 402) {
    // Specific to DeepSeek: insufficient balance. Entirely unlike rate limiting, and retrying never helps
    hint = msg('ai.dsNoBalance');
  } else if (res.status === 401) {
    // On a 401 what a person most wants to know is what was actually sent. The key cannot be
    // printed, but its **shape** can, and the shape identifies the two commonest mistakes:
    // pasting another vendor's key, or pasting an incomplete one
    code = 'bad-api-key';
    hint = msg('ai.dsBadKey', { shape: describeKey(apiKey) });
  } else if (res.status === 404 || /model/i.test(detail)) {
    hint = msg('ai.dsBadModel', { model });
  } else if (res.status === 400 && /max_tokens|context|length/i.test(detail)) {
    code = 'deepseek-length';
    hint = msg('ai.dsTooLong');
  }

  const err = new AiError(msg('ai.httpError', {
    vendor: 'DeepSeek', status: res.status, type: type ? ` ${type}` : '', detail, hint,
  }), {
    status: res.status,
    type,
    // 402 is a balance problem, and retrying never helps
    retryable: (res.status === 429 || res.status >= 500) && res.status !== 402,
  });
  if (code) {
    err.code = code;
    err.detail = { envVar: 'DEEPSEEK_API_KEY' };
  }
  return err;
}
