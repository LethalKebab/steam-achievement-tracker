/**
 * The Google Gemini provider
 * ------------------------------------------------
 * The **immediate reason for adding this vendor was the free tier**: the Anthropic path had never
 * once been exercised for real, and this machine has no key. Gemini has a free allowance, which is
 * what let the whole pipeline run end to end for the first time. In the longer term it is also a
 * low-barrier option for users — the plan's goal has always been to let the people using this app
 * use their own key.
 *
 * ## This file was written without access to the official documentation
 *
 * The web tools were unavailable throughout (as on the day of the spike), so the field names,
 * model names and tool names below all came from memory and **were never checked against the
 * documentation**. The response was not to bet on memory but to make every uncertain point
 * **answerable at runtime**:
 *
 * - **The model name is configurable**, and `ai-check --models` asks the API for the list
 *   directly. A wrong guess needs no code change
 * - **Tool declarations are configurable** (`ai.geminiTools`), so a renamed tool, or one the free
 *   tier will not allow, is also a configuration change
 * - **Whether search actually happened is read off the response, not the documentation.**
 *   `groundingMetadata.webSearchQueries` holds the queries the model really issued; declaring the
 *   search tool and getting none means "this tier has no web access", and the caller sees that
 *   signal. This is far more reliable than reading a pricing page that may be out of date
 *
 * ## A failure mode Anthropic does not have
 *
 * `finishReason: 'RECITATION'` — the model blocked for reproducing large amounts of copyrighted
 * content. Guide writing is exactly the high-risk case: we **explicitly require verbatim copying
 * of official descriptions** and ask it to read wikis. So it gets its own class and an actionable
 * error message, rather than being swallowed alongside an ordinary refusal.
 */
import { AiError, emptyUsage, addUsage, sseEvents, normalizeStop } from './ai.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
/** When Google asks for a wait longer than this, stop waiting: failing now and saying why beats hanging */
const MAX_RETRY_WAIT_MS = 90000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini's finishReason → the project-wide vocabulary.
 * The casing and spelling are from memory; anything unrecognised falls to 'other' and carries the
 * raw value out rather than being guessed at.
 */
const STOP_MAP = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  BLOCKLIST: 'refusal',
  SPII: 'refusal',
  RECITATION: 'recitation',
};

/** usageMetadata → the generic usage shape. The field names are Gemini's own */
export function mergeGeminiUsage(target, meta) {
  if (!meta) return target;
  // Every chunk reports the cumulative total so far, so this overwrites rather than adds — the same as Anthropic
  if (typeof meta.promptTokenCount === 'number') target.inputTokens = meta.promptTokenCount;
  if (typeof meta.cachedContentTokenCount === 'number') target.cacheReadTokens = meta.cachedContentTokenCount;
  // Thinking tokens are reported separately but bill as output. Folding them into outputTokens keeps
  // the accounting consistent with the Anthropic side (where thinking is already counted in
  // output_tokens). Verify this on the first real run
  const out = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
  if (out) target.outputTokens = out;
  return target;
}

/**
 * Reassemble streamed chunks into one complete reply.
 *
 * Considerably simpler than the Anthropic side: no block indices, no delta types — each chunk is
 * one `candidates[0].content.parts`, and the text is simply appended.
 */
export function createGeminiAccumulator() {
  const state = {
    text: '',
    thinking: '',
    extraParts: [],
    stopReason: null,
    blockReason: null,
    usage: emptyUsage(),
    model: null,
    searchQueries: [],
  };

  return {
    state,
    push(chunk) {
      if (chunk?.usageMetadata) mergeGeminiUsage(state.usage, chunk.usageMetadata);
      if (chunk?.modelVersion) state.model = chunk.modelVersion;
      // When the whole prompt is blocked by a safety policy there are no candidates at all, only this field
      if (chunk?.promptFeedback?.blockReason) state.blockReason = chunk.promptFeedback.blockReason;

      const cand = chunk?.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) state.stopReason = cand.finishReason;

      for (const q of cand.groundingMetadata?.webSearchQueries ?? []) {
        if (!state.searchQueries.includes(q)) state.searchQueries.push(q);
      }

      for (const p of cand.content?.parts ?? []) {
        // A part with thought:true is reasoning, not prose. Mixing it in writes the reasoning into the guide file
        if (p?.thought) {
          state.thinking += p.text ?? '';
          continue;
        }
        if (typeof p?.text === 'string') {
          state.text += p.text;
          continue;
        }
        state.extraParts.push(p);
      }
    },
    result() {
      return { ...state };
    },
  };
}

export class GeminiProvider {
  #apiKey;

  constructor(ai, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!ai?.apiKey) {
      throw new AiError(
        'Gemini API key 没配置。填 config.json 的 ai.apiKey,或者用环境变量 GEMINI_API_KEY=...\n' +
          '  (key 在 https://aistudio.google.com/apikey 申请)'
      );
    }
    this.name = 'gemini';
    this.ai = ai;
    // The default is a `-latest` alias rather than a specific version: a specific version expires,
    // and that is exactly how the previous default failed (gemini-2.5-pro hardcoded, and three
    // months later it was both outdated and **Pro turned out not to be in the free tier**, with a
    // free allowance of limit: 0). The alias is maintained by Google and always points at the
    // current flash.
    // The cost is that behaviour can change quietly — **pin a specific version in config.json when
    // reproducibility is needed**, and run `ai-check --models` to see what exists
    this.model = ai.model || 'gemini-flash-latest';
    this.maxTokens = ai.maxTokens ?? 32000;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  /** Has server-side search. See the note on canSearch at the top of ai.js */
  get canSearch() {
    return true;
  }

  /**
   * The web tools. The names are configurable because this file was written without documentation
   * — a renamed tool, or one the free tier will not allow, is a configuration change rather than a
   * code change.
   *
   * Only `google_search` is declared by default. `url_context` (the equivalent of Anthropic's
   * web_fetch) has to be added to `ai.geminiTools` explicitly: declaring one more tool we are not
   * sure of makes the whole request 400, and getting it working at all matters more than getting
   * it optimal on the first attempt.
   */
  webTools() {
    const names = this.ai.geminiTools?.length ? this.ai.geminiTools : ['google_search'];
    return names.map((n) => ({ [n]: {} }));
  }

  #headers() {
    // The key goes in a header, not a ?key= query string — a query string reaches logs, browser history and error reports
    return { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey };
  }

  /**
   * The generic message shape → Gemini's contents.
   * Two differences: assistant is called model here, and the body goes in parts rather than content.
   */
  #toContents(messages) {
    return (messages ?? []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content,
    }));
  }

  buildBody({ system, messages, tools }) {
    const body = {
      contents: this.#toContents(messages),
      generationConfig: { maxOutputTokens: this.maxTokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools?.length) body.tools = tools;
    // The current default thinking budget is unknown, so **nothing is sent unless it is configured**
    // — letting the model use its own default is safer than sending a field that may not be accepted
    if (typeof this.ai.geminiThinkingBudget === 'number') {
      body.generationConfig.thinkingConfig = {
        thinkingBudget: this.ai.geminiThinkingBudget,
        includeThoughts: Boolean(this.ai.showThinking),
      };
    }
    return body;
  }

  /** `ai-check --models`: ask the API which models are available rather than guessing names */
  async listModels() {
    const res = await this.fetchImpl(`${BASE_URL}/models`, { headers: this.#headers() });
    if (!res.ok) throw await errorFromResponse(res, this.model);
    const data = await res.json();
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({
        name: String(m.name ?? '').replace(/^models\//, ''),
        display: m.displayName ?? '',
        inputLimit: m.inputTokenLimit ?? null,
        outputLimit: m.outputTokenLimit ?? null,
      }));
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
    const url = `${BASE_URL}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, this.model);
      // Set **after** the !res.ok check and before the first read: from here on the body is open,
      // which is exactly the window in which the catch below is allowed to abort. The same line
      // sits in the same place in ai-anthropic.js and ai-deepseek.js
      streaming = true;

      const acc = createGeminiAccumulator();
      // A search query repeats in every subsequent chunk; the progress output reports only the first sighting
      const seenQueries = new Set();
      for await (const ev of sseEvents(res.body)) {
        emitProgress(ev, onEvent, seenQueries);
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
          throw new AiError('已取消', { retryable: false, cancelled: true });
        }
        // **States only what happened** — see the identical comment in ai-anthropic.js
        const timeoutErr = new AiError(
          `请求超过 ${Math.round(this.timeoutMs / 1000)} 秒没结束。`,
          { retryable: false }
        );
        timeoutErr.code = 'ai-timeout';
        throw timeoutErr;
      }
      throw new AiError(`请求失败:${err?.message ?? err}`, { retryable: true });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * How long to wait before retrying. Returns null for "do not retry".
   *
   * **A 429 is retried only when Google states how long to wait.** On the free tier every request
   * consumes quota, and a self-chosen backoff (1/2/4 seconds) is nowhere near long enough for a
   * "N per minute" window — the result is three wasted attempts that also burn the remaining quota.
   * Hit for real: one 429 turned into 4 requests.
   * Google supplies an exact value in `RetryInfo.retryDelay`; follow it when present, and fail on
   * the spot when it is absent.
   */
  #retryDelayFor(err, attempt) {
    if (err.status === 429) {
      if (!err.retryAfterMs || err.retryAfterMs > MAX_RETRY_WAIT_MS) return null;
      return err.retryAfterMs;
    }
    return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  }

  async #withRetry(body, opts) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.#once(body, opts);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof AiError) || !err.retryable || attempt === this.maxRetries) throw err;
        const wait = this.#retryDelayFor(err, attempt);
        if (wait === null) throw err;
        this.log(`  第 ${attempt + 1} 次失败(${err.message.slice(0, 60)}),${wait}ms 后重试`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /**
   * One conversation round.
   *
   * **There is no pause_turn loop**: grounding completes server-side within a single round, so
   * `continuations` is always 0. That is not an omission — this vendor does not need one.
   */
  async send({ system, messages, tools, onEvent, signal } = {}) {
    const usage = emptyUsage();
    const r = await this.#withRetry(this.buildBody({ system, messages, tools }), { onEvent, signal });
    addUsage(usage, r.usage);

    // A wholly blocked prompt has no candidates, and therefore no finishReason, only a blockReason
    const raw = r.stopReason ?? (r.blockReason ? `BLOCKED_${r.blockReason}` : null);
    const stopReason = r.blockReason && !r.stopReason ? 'refusal' : normalizeStop(STOP_MAP, r.stopReason);

    return {
      content: [{ text: r.text }],
      text: r.text,
      stopReason,
      rawStopReason: raw,
      stopDetails: r.blockReason ? { category: r.blockReason } : null,
      usage,
      model: r.model ?? this.model,
      continuations: 0,
      // A Gemini web failure is not reported as a separate tool-error block; "searched and found nothing" is read from searchQueries
      toolErrors: [],
      searchQueries: r.searchQueries,
      thinking: r.thinking,
    };
  }
}

/**
 * A raw chunk → a generic progress event, in the same vocabulary the Anthropic side emits.
 * Callers therefore need to know no vendor's format.
 */
function emitProgress(chunk, onEvent, seenQueries) {
  if (!onEvent) return;
  const cand = chunk?.candidates?.[0];
  if (!cand) return;
  for (const q of cand.groundingMetadata?.webSearchQueries ?? []) {
    if (seenQueries.has(q)) continue;
    seenQueries.add(q);
    onEvent({ type: 'search', query: q, raw: chunk });
  }
  for (const p of cand.content?.parts ?? []) {
    if (p?.thought || typeof p?.text !== 'string') continue;
    onEvent({ type: 'text', text: p.text, raw: chunk });
  }
}

/** `"40.48s"` → 40483. Returns null for anything unrecognised rather than guessing */
function parseDuration(s) {
  const m = /^([\d.]+)s$/.exec(String(s ?? ''));
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

async function errorFromResponse(res, model) {
  let status = null;
  let detail = '';
  let retryAfterMs = null;
  const violations = [];
  const raw = await res.text().catch(() => '');
  try {
    const body = JSON.parse(raw);
    const e = Array.isArray(body) ? body[0]?.error : body?.error;
    status = e?.status ?? null;
    detail = e?.message ?? '';

    // **The structured quota information is in error.details, not in message.**
    // message sometimes carries per-metric detail and sometimes only a generic "quota exceeded",
    // so reading message alone works intermittently — while this is the only place that states
    // which quota, what the limit is, and how long to wait
    for (const d of e?.details ?? []) {
      const type = String(d['@type'] ?? '');
      if (type.endsWith('QuotaFailure')) {
        for (const v of d.violations ?? []) {
          violations.push({
            metric: v.quotaMetric ?? v.subject ?? '?',
            id: v.quotaId ?? '',
            value: v.quotaValue ?? null,
          });
        }
      } else if (type.endsWith('RetryInfo')) {
        retryAfterMs = parseDuration(d.retryDelay);
      }
    }
  } catch {
    detail = raw.slice(0, 300);
  }

  // `limit: 0` and "the quota is used up" are **two completely different things**, and Google
  // reports both as the same 429: the former means this model has no allowance at all on this tier
  // (no amount of waiting restores it, and the only remedy is a different model), the latter means
  // it genuinely ran out (wait a while, or wait for the daily reset). Conflating them makes someone
  // wait a whole day for nothing. Measured: the free tier gives gemini-2.5-pro limit: 0
  // The structured detail takes precedence, with the wording in message as a fallback (both shapes have been seen)
  const noAllowance =
    res.status === 429 &&
    (violations.some((v) => String(v.value) === '0') || /limit:\s*0\b/.test(detail));

  let hint = '';
  let code = null;
  // "no longer available to new users" means **withdrawn**, not a mistyped model name. Measured:
  // the 2.5 series is no longer offered to newly issued keys, yet still appears in the model
  // listing — being listed is not the same as being usable
  // **Keep the diagnosis, drop "which command to run".** These sentences appear verbatim in the
  // Dashboard's floating bar. How to change model differs between the two surfaces (a --model flag
  // in the terminal, the settings page in the interface), so that is attached by code to
  // tracker.js's CLI_HINTS, and the body only states what is wrong with this model
  if (/no longer available|deprecated|retired/i.test(detail)) {
    code = 'gemini-model-retired';
    hint = `\n  ⚠️  ${model} 对新 key 已经停止提供了(不是名字写错)。\n` +
      '      换一个新一代的 flash 模型,比如 gemini-flash-latest。';
  } else if (res.status === 404 || /not found|not supported/i.test(detail)) {
    code = 'gemini-model-unknown';
    hint = `\n  (模型名 "${model}" 可能不对,或者你的 key 没权限用它)`;
  } else if (noAllowance) {
    code = 'gemini-no-allowance';
    hint = `\n  ⚠️  这一档对 ${model} 的额度是 **0** —— 不是用完了,是这个模型不在你这一档里。\n` +
      '      等多久都不会恢复,重试也没有意义。换一个 flash 系列模型(Pro 通常不在免费层)。';
  } else if (res.status === 429) {
    hint = '\n  (配额用完了。免费层有每分钟和每天两道上限——每分钟那道等一会儿就行,' +
      '每天那道要等次日重置)';
    if (retryAfterMs) hint += `\n  Google 说 ${Math.ceil(retryAfterMs / 1000)} 秒后可以再试。`;
    if (!violations.length) {
      // A 429 with no detail is the hardest to diagnose: per-minute, per-day, and "this key has no
      // free tier at all" are indistinguishable. Rather than guess, give the next step that narrows
      // it down — and both of these hold on either surface
      code = 'gemini-429-no-detail';
      hint += '\n  这次的响应里**没有配额明细**,分不清是哪一道。缩小范围:\n' +
        '    · 等一分钟再试 —— 还失败就不是每分钟那道\n' +
        '    · 去 https://ai.dev/rate-limit 看这个 key 实际有哪些配额';
    }
  } else if (res.status === 400 && /tool|function/i.test(detail)) {
    code = 'gemini-tool-rejected';
    hint = '\n  (像是联网工具的声明不被接受 —— 这一项在设置页可以改)';
  } else if (res.status === 403) {
    hint = '\n  (key 无效,或者这个 API 在你的地区/项目里没启用)';
  }

  const detailLines = violations.length
    ? '\n  配额明细:\n' +
      violations.map((v) => `    · ${v.metric}${v.id ? ` (${v.id})` : ''} 上限 ${v.value ?? '?'}`).join('\n')
    : '';

  const err = new AiError(
    `Gemini API HTTP ${res.status}${status ? ` ${status}` : ''}:${detail}${detailLines}${hint}`,
    {
      status: res.status,
      type: status,
      // limit: 0 is explicitly **not retryable** — three rounds of backoff only waste time and make it look like a transient problem
      retryable: (res.status === 429 && !noAllowance) || res.status >= 500,
    }
  );
  err.retryAfterMs = retryAfterMs;
  // How to change model differs between the two surfaces, so the code lets the terminal add its own advice (see CLI_HINTS in tracker.js)
  if (code) {
    err.code = code;
    err.detail = { model };
  }
  return err;
}
