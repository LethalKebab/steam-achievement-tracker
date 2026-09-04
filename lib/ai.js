/**
 * The AI provider layer — the shared half
 * ------------------------------------------------
 * Each vendor's differences are confined to its own file (`ai-anthropic.js` / `ai-deepseek.js`);
 * this holds what they share: usage accounting, pricing, sessions, SSE unpacking, and the verdict
 * on whether a round's result is usable.
 *
 * Adding a third vendor means writing one new file, implementing the interface below, and
 * registering it in `createProvider`. Neither this file nor `guidegen.js` should change for it.
 *
 * ## The provider interface
 *
 * ```
 * name                                 the provider's identifier
 * model                                the current model name
 * canSearch                            **whether it has server-side web search**. See below
 * webTools()                           this vendor's own web tool declarations (the shapes all differ)
 * buildBody({system, messages, tools}) assemble the request body; --dry prints it without sending
 * send({system, messages, tools, onEvent, signal}) → {
 *   content        this vendor's native message content, stored back into the session verbatim and resent
 *   text           the extracted plain-text prose
 *   stopReason     **the unified vocabulary**, see below
 *   rawStopReason  this vendor's own value, for diagnosis only
 *   usage / model / continuations / searchQueries
 *   toolErrors     `[{tool, errorCode}]`. `tool` is **also unified vocabulary**: `search` / `fetch`,
 *                  never leaking a vendor's block names — because the two differ in severity, see `checkResult`
 * }
 * ```
 *
 * `signal` is optional and comes from the caller (guidegen.js's Cancel button plumbing); a
 * provider that receives one must abort the in-flight request when it fires and reject with an
 * `AiError` carrying `cancelled: true`, distinct from its own idle-timeout error — see `#once` in
 * any of the three provider files for the combined-signal shape.
 *
 * ## The unified stopReason vocabulary
 *
 * The vendors phrase it differently (Anthropic uses `end_turn`/`max_tokens`/`refusal`, the
 * OpenAI-compatible ones `stop`/`length`/`content_filter`), and it is **translated to one set at
 * the provider boundary** so that `checkResult` and `guidegen` are not littered with "if it is
 * this vendor then…".
 *
 * - `end_turn`   finished normally
 * - `max_tokens` truncated. **Prose exists but only half of it**, the most dangerous kind
 * - `refusal`    refused by a safety policy
 * - `recitation` blocked for reproducing copyrighted content at length. **No vendor here maps to
 *                it today** — it stays in the set because the vocabulary is the contract, not a
 *                census of what the vendors currently send
 * - `other`      unrecognised. The raw value is in `rawStopReason`; nothing is guessed
 *
 * ## canSearch
 *
 * The design document makes "has server-side search" a hard admission requirement, on the grounds
 * that letting one without search in makes quality depend on which vendor the user picked, and the
 * user cannot see that difference. So this cannot rest on someone remembering it; it has to be a
 * property the provider declares and the layers above can read:
 *
 * - `guide-gen` **refuses to generate by default** for a provider with `canSearch === false`,
 *   requiring an explicit `--no-research`
 * - The prompt switches to the "you have no web access, write nothing you are unsure of" variant
 * - The result states plainly that this guide involved no research
 *
 * So "no web access this time" is unmissable, rather than a quality difference the user cannot see.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * **The only import in this file, and it earns its place.** Everything here is otherwise
 * self-contained, which is the shape the provider contract wants. But `checkResult`'s `reason`
 * is the sentence the generation panel shows when a round fails, and `formatUsage` is the one
 * line saying what a run cost — both are read by a person, in whichever language the interface
 * is set to. `messages.js` imports only `lang.js`, so nothing here becomes circular.
 */
import { msg } from './messages.js';

export class AiError extends Error {
  constructor(message, { status = null, type = null, requestId = null, retryable = false, cancelled = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.type = type;
    this.requestId = requestId;
    this.retryable = retryable;
    // **Set only when an external signal (not our own idle timeout) tore down the request.** The
    // distinction matters at both ends: the message must not accuse the network of being slow when
    // the user pressed Cancel, and the retry ladder in guidegen.js must never retry a deliberate
    // cancellation — it already won't, since `retryable` stays false here too, but a caller that
    // wants to tell "the user stopped this" apart from "the network died" needs its own flag rather
    // than parsing the message text.
    this.cancelled = cancelled;
  }
}

/** An unrecognised stop reason always falls to 'other' and keeps the raw value; nothing is guessed */
export function normalizeStop(map, raw) {
  if (!raw) return null;
  return map[raw] ?? 'other';
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * Yield SSE events one at a time. Both vendors use `data:` lines separated by a blank line, so this
 * is shared.
 * One event can be split across two chunks, and a multi-byte character can be cut in half
 * (TextDecoder's stream mode reassembles those).
 */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
}

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearches: 0,
    requests: 0,
  };
}

const FIELD_MAP = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cache_creation_input_tokens: 'cacheCreationTokens',
  cache_read_input_tokens: 'cacheReadTokens',
};

/**
 * Merge usage **within one message**: overwrite, never add. (Anthropic's field names.)
 *
 * This is the easiest place to get the accounting quietly wrong. Both `message_start` and
 * `message_delta` report "the cumulative total for this message so far" — the former's
 * `output_tokens` is a small initial value and the latter's is the final one. Adding them
 * double-counts the output tokens, and the excess raises no error anywhere; it simply keeps the
 * reported cost permanently too high.
 */
export function mergeMessageUsage(target, raw) {
  if (!raw) return target;
  for (const [from, to] of Object.entries(FIELD_MAP)) {
    if (typeof raw[from] === 'number') target[to] = raw[from];
  }
  const searches = raw.server_tool_use?.web_search_requests;
  if (typeof searches === 'number') target.webSearches = searches;
  return target;
}

/**
 * Accumulate usage **across messages**: add.
 *
 * A pause_turn continuation and each feedback rewrite round are separate messages, each with its
 * own complete usage, and that is when adding is correct. Both halves — overwrite within a message,
 * add across messages — have to be right; getting either wrong makes the accounting wrong.
 */
export function addUsage(target, more) {
  if (!more) return target;
  for (const k of Object.keys(target)) target[k] += more[k] ?? 0;
  return target;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * A one-line summary for the CLI and the progress bar.
 *
 * **Report tokens only, never money, and do not bring the estimate back.** Vendor rates change, no
 * table exists that we can verify, and how the search tool bills has never been measured at all.
 * **An amount that is wrong by an unknown margin is worse than no amount**; and "this model has no
 * price entry" is neither information nor a choice as far as the user is concerned.
 *
 * The token counts stay, because they are a different kind of thing from an estimate — they are
 * hard numbers the API itself returned, and the only figures that reconcile against a vendor's bill.
 */
export function formatUsage(usage) {
  const cache =
    usage.cacheCreationTokens || usage.cacheReadTokens
      ? msg('ai.usageCache', { written: usage.cacheCreationTokens, read: usage.cacheReadTokens })
      : '';
  const search = usage.webSearches ? msg('ai.usageSearch', { n: usage.webSearches }) : '';
  return msg('ai.usage', {
    requests: usage.requests, input: usage.inputTokens, cache, output: usage.outputTokens, search,
  });
}

// ---------------------------------------------------------------------------
// The provider registry
// ---------------------------------------------------------------------------

/**
 * Model name prefix → which vendor it belongs to. Only **certain** cases are listed, and anything
 * unrecognised is not guessed at (aliases, self-hosted endpoints and proxy services can use any
 * model name at all).
 */
/** DeepSeek's Anthropic-compatible endpoint — the one with server-side web_search */
const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

const MODEL_FAMILY = [
  { re: /^claude-/i, provider: 'anthropic' },
  { re: /^deepseek-/i, provider: 'deepseek' },
];

/**
 * Whether the provider and the model agree.
 *
 * **It only blocks the case where a model plainly belongs to another vendor**, letting every
 * unrecognised name through — those may be aliases or self-hosted endpoints. A cross-vendor
 * mismatch, however, is always a misconfiguration, without exception.
 *
 * It is worth blocking separately because otherwise what surfaces is the vendor's own 404 ("the
 * model name may be wrong"), while the real cause is provider and model having been half-updated —
 * and that 404 points nowhere near it. Hit for real: config.json said deepseek while the
 * environment variable AI_PROVIDER still said anthropic, so deepseek-chat was requested from
 * Anthropic's endpoint.
 */
export function assertModelMatchesProvider(provider, model, { baseUrl = '' } = {}) {
  if (!model) return;
  // On a custom endpoint the model name can take any shape — with provider=anthropic pointed at
  // DeepSeek's Anthropic-compatible endpoint, for instance, the model is called deepseek-v4-flash.
  // A prefix check there can only produce false positives, so skip it entirely
  if (baseUrl) return;
  const hit = MODEL_FAMILY.find((f) => f.re.test(model));
  if (!hit || hit.provider === provider) return;
  // **The message states only what is misconfigured** and names no command line — this sentence
  // appears verbatim on the Dashboard, where these two settings are changed on the settings page.
  // Terminal-specific troubleshooting (especially "an environment variable overrides the config
  // file", which can only be hit in a terminal) is added by tracker.js catching
  // `provider-model-mismatch`
  const err = new AiError(
    msg('ai.providerModelMismatch', { provider, model, belongsTo: hit.provider })
  );
  err.code = 'provider-model-mismatch';
  err.detail = { provider, model, belongsTo: hit.provider };
  throw err;
}

/**
 * Construct a provider from config.ai.provider. Adding a vendor touches only this function and one
 * new file.
 *
 * A dynamic import: the unused vendor never enters memory, and a module-level error in one cannot
 * take the other down.
 */
export async function createProvider(config, opts = {}) {
  const ai = config?.ai ?? {};
  const provider = (ai.provider ?? 'anthropic').toLowerCase();
  assertModelMatchesProvider(provider, ai.model, { baseUrl: ai.baseUrl });
  if (provider === 'anthropic') {
    const { AnthropicProvider } = await import('./ai-anthropic.js');
    return new AnthropicProvider(ai, opts);
  }
  // **DeepSeek has two endpoints with different capabilities, and the default must be the good one.**
  //
  //   /anthropic          Anthropic-compatible — **has server-side web_search**
  //   /chat/completions   OpenAI-compatible    — no search
  //
  // Someone writing `provider: "deepseek"` plainly wants the DeepSeek that works, so this assembles
  // the former directly. Before this, the good path had to be written as `provider: "anthropic"`
  // plus a DeepSeek URL, which reads like a misconfiguration, while the intuitive spelling gave the
  // search-less path — and the good path must not be hidden behind counter-intuitive configuration.
  if (provider === 'deepseek') {
    const { AnthropicProvider } = await import('./ai-anthropic.js');
    const p = new AnthropicProvider(
      {
        ...ai,
        // An explicit configuration wins. Note this cannot rely on spread order — ai.model may be
        // an empty string, which would make AnthropicProvider fall back to claude-opus-5
        baseUrl: ai.baseUrl || DEEPSEEK_ANTHROPIC_BASE,
        model: ai.model || DEEPSEEK_DEFAULT_MODEL,
        // The errors must name the right vendor and the right environment variable — otherwise the
        // user sees "Anthropic API HTTP 401, check ANTHROPIC_API_KEY" while they configured DeepSeek
        providerName: 'deepseek',
        providerEnvVar: 'DEEPSEEK_API_KEY',
      },
      opts
    );
    return p;
  }
  // The OpenAI-compatible endpoint. **No web search.** It stays because it is the generic shape for
  // many services (local models, various proxies), and because it is the only genuine use case for
  // the canSearch=false gate
  if (provider === 'deepseek-openai') {
    const { DeepseekProvider } = await import('./ai-deepseek.js');
    return new DeepseekProvider(ai, opts);
  }
  throw new AiError(msg('ai.unknownProvider', { provider }));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A multi-round conversation: accumulate messages, accumulate usage.
 *
 * A feedback rewrite (validation fails → send the specific errors back → at most 3 rounds) is
 * multi-round, so the history has to be kept — and keeping it is cheaper anyway, since the prefix
 * hits the cache. Usage accumulates across messages here, so the spend-ceiling step can simply read
 * `session.usage` rather than instrumenting several places.
 *
 * Messages use the neutral shape `{role: 'user'|'assistant', content}`, where `content` is either a
 * string or that vendor's own native content. Translating to each vendor's request format is the
 * provider's `buildBody`'s job.
 */
export function createSession(provider, { system = null, tools = null, effort = null } = {}) {
  const messages = [];
  const usage = emptyUsage();

  return {
    provider,
    messages,
    usage,
    async ask(userText, { onEvent, signal } = {}) {
      messages.push({ role: 'user', content: userText });
      const r = await provider.send({ system, messages, tools, onEvent, signal, effort });
      addUsage(usage, r.usage);
      // Stored back verbatim (including the thinking blocks, which must be returned unchanged to continue with the same model)
      messages.push({ role: 'assistant', content: r.content });
      return r;
    },
    /**
     * Remove the most recent turn (the user message and the assistant reply it produced) from the
     * history, as though it never happened.
     *
     * **There is exactly one use for this: this round's result is unusable and the caller wants to
     * re-ask on the same session.** Left in place, that half-finished draft stays in the context,
     * while the re-ask prompt almost certainly says "do not repeat what you have already written" —
     * so the model skips the part it half-wrote, and **the output looks normal while missing
     * entries**. That is far worse than a plain failure: a failure is reported, missing entries are not.
     *
     * `ask` pushes the user message, waits for the reply, then pushes the assistant message, so a
     * failure can leave either shape (the request itself failed = user only; the reply was unusable
     * = both present). Removing from the tail by role handles both.
     */
    dropLastTurn() {
      if (messages.at(-1)?.role === 'assistant') messages.pop();
      if (messages.at(-1)?.role === 'user') messages.pop();
    },
    summary() {
      return formatUsage(usage);
    },
  };
}

// ---------------------------------------------------------------------------
// The result verdict
// ---------------------------------------------------------------------------

const uniqueCodes = (errs) => [...new Set(errs.map((e) => e.errorCode))].join('、');

/**
 * Judge a round's result usable or not, with a reason in plain language, plus a list of warnings
 * that **do not block but must be stated**.
 *
 * It is extracted because **all of these failures look like success**: a refusal is HTTP 200,
 * truncation has prose that is merely cut in half, and a tool error is also a 200. Every caller
 * writing the branches itself would eventually miss one.
 *
 * **Web tool failures need two grades; treating them alike is wrong in both directions:**
 *
 * - **Search failure ⇒ the whole round is unusable.** Search is the entry point to research, and
 *   without it the model is writing from memory — precisely the invisible quality difference the
 *   `canSearch` admission design exists to prevent.
 * - **Fetch failure ⇒ reported, not fatal.** web_fetch is **per URL**: `url_not_allowed` (it can
 *   only fetch URLs already present in the conversation, so any URL the model constructs itself
 *   trips this) and `url_not_accessible` (404 / anti-bot / timeout, especially common on Chinese
 *   guide sites) will almost inevitably occur a few times in any normal research session.
 *   Ten pages searched with two fetches failed is enough material; voiding the round for that
 *   treats the normal case as a fault — and what is voided is the minutes and tokens the user has
 *   already paid for.
 *
 * An error with an unrecognised `tool` is treated as **blocking**: when a new provider is
 * integrated, over-blocking once is better than waving something through by default.
 *
 * @returns {{ok: boolean, reason: string|null, warnings: string[]}}
 */
export function checkResult(r) {
  const toolErrors = r.toolErrors ?? [];
  const fetchErrs = toolErrors.filter((e) => e.tool === 'fetch');
  // **The entry, not the sentence.** This one is shown as a warning, and a warning outlives the
  // run it came from; see `warn` in lib/server.js for why that rules out composing it here
  const warnings = fetchErrs.length
    ? [{ key: 'gp.fetchFailed', values: { n: fetchErrs.length, codes: uniqueCodes(fetchErrs) } }]
    : [];
  // Failures carry warnings too: a constant shape means callers need not remember when the field is
  // present.
  // **`code` is for the program, `reason` is for a person** — callers need to distinguish "is this
  // failure recoverable" (only truncation is: split smaller and re-ask). Matching on reason's text
  // turns a human sentence into an interface, which breaks silently on a rewording
  const bad = (code, reason) => ({ ok: false, code, reason, warnings });

  if (r.stopReason === 'refusal') {
    const cat = r.stopDetails?.category
      ? msg('ai.refusedCategory', { category: r.stopDetails.category })
      : '';
    return bad('refusal', msg('ai.refused', { category: cat }));
  }
  if (r.stopReason === 'recitation') {
    // Guide writing is the high-risk case for this: we explicitly require verbatim copying of official descriptions and ask it to read wikis
    return bad('recitation', msg('ai.recitation'));
  }
  if (r.stopReason === 'max_tokens') {
    // **This number is consumption, not a ceiling, and the wording has to say so.** It used to read
    // "currently N tokens" followed by "raise ai.maxTokens" — which reads as "the ceiling is N",
    // while N is in fact the whole round's output **accumulated** by `addUsage` across pause_turn
    // continuations, and can be far larger than a single request's max_tokens. Measured at 61,445
    // when the ceiling was 32,000: following that advice starts from the wrong baseline.
    // And max_tokens governs thinking plus prose, so raising it is mostly eaten by thinking
    // (measured in CLAUDE.md) — so this states the fact only and no longer offers that advice; how
    // to recover is the caller's concern (guidegen splits smaller and re-asks)
    return bad('max_tokens', msg('ai.maxTokens', { tokens: r.usage.outputTokens }));
  }
  if (r.stopReason === 'other') {
    return bad('other', msg('ai.unknownStop', { reason: r.rawStopReason }));
  }
  const hardErrs = toolErrors.filter((e) => e.tool !== 'fetch');
  if (hardErrs.length) {
    return bad('tool-error', msg('ai.toolError', { codes: uniqueCodes(hardErrs) }));
  }
  const leaked = leakedControlToken(r.text);
  if (leaked) {
    // **The provider wrote its own internal control tokens into the prose.** The stop reason is
    // normal, the prose is non-empty and no tool reported an error — all three surface signals are
    // correct, so no branch before this one catches it, while the prose is in fact **cut off** at
    // that point.
    //
    // Measured (KINGDOM HEARTS, DeepSeek): achievement 173 broke off mid-line into
    // `**The Warrior: Ventus</｜｜DSML｜｜parameter>` followed by `</｜｜DSML｜｜invoke>` and
    // `</｜｜DSML｜｜tool_calls>`, with the output ending there and the remaining 10 achievements
    // never written. All three rounds broke at the same place.
    //
    // **The markers cannot simply be stripped so the rest can be used.** The prose is truncated, so
    // stripping yields a guide that looks complete and is short a section — which is precisely the
    // failure mode this project guards against hardest: a failure is reported, a missing piece is
    // not. So the whole round is failed and handed to guidegen's retry ladder (re-ask as-is, split
    // smaller, record it and carry on).
    return bad('control-token', msg('ai.controlToken', { leaked }));
  }
  if (!r.text.trim()) {
    // **"There is no prose" has no diagnostic value on its own and must carry what did come back.**
    //
    // This is the hardest failure to diagnose on this path: HTTP 200, no tool error, a normal stop
    // reason, and simply not one text block. And those three facts point at completely different
    // responses:
    //   thinking×1 plus tens of thousands of tokens ⇒ thinking ate the budget, the same as truncation (split smaller)
    //   nothing at all plus 0 tokens                ⇒ a one-off hiccup (re-ask as-is)
    //   server_tool_use present but no text         ⇒ it searched without writing
    // Without those figures the next occurrence is guesswork again — and every guess on this path
    // costs the user minutes and a pile of tokens to test. Hit three times (most recently KINGDOM
    // HEARTS, shard 3 of 4 across 197 achievements), each time reasoned backwards from one sentence
    return bad('empty', msg('ai.emptyProse', {
      stop: r.rawStopReason ?? msg('ai.stopUnknown'),
      tokens: r.usage?.outputTokens ?? 0,
      blocks: describeBlocks(r.content),
    }));
  }
  return { ok: true, code: null, reason: null, warnings };
}

/**
 * The various models' internal control tokens. **The test must be "this can never appear in
 * markdown prose"**, because one false positive wastes a paid round, while guide prose legitimately
 * contains real HTML such as `<br>`, `<details>`, `<summary>`, `<table>` and
 * `<span underline="true">`.
 *
 * So only shapes that cannot collide are matched:
 *
 * 1. **A fullwidth pipe (U+FF5C) inside angle brackets** — DeepSeek's family of markers
 *    (`<｜tool▁calls▁begin｜>`, `</｜｜DSML｜｜invoke>`). A fullwidth pipe is already very rare in
 *    Chinese prose, and additionally requiring it inside angle brackets makes real content
 *    essentially impossible.
 * 2. **`<|…|>`** — the Llama / OpenAI family (`<|im_start|>`, `<|eot_id|>`). `<|` opens no valid HTML.
 * 3. **The closing forms of a few tool-call tags** — closing forms only (`</invoke>`), because the
 *    opening forms (`<parameter …>`) look far more like prose HTML and are not worth the risk.
 *
 * Opening tags such as `<function_calls>` are deliberately **not** matched, and there is no fuzzy
 * matching: this function's error directions have different costs, so it is better to miss an
 * unseen variant (which will surface next time as a missing checkbox) than to hold a perfectly good
 * guide behind an error nobody can interpret.
 */
const CONTROL_TOKEN_RES = [
  [/<[^>\n]{0,60}｜[^>\n]{0,60}>/, 'ai.leakFullwidthBar'],
  [/<\|[^|>\n]{0,60}\|>/, 'ai.leakPipeBracket'],
  [/<\/(invoke|function_calls|tool_calls|parameter|antml:\w+)>/i, 'ai.leakToolCloseTag'],
];

/** Whether a control token got into the prose. Returns a description of whichever matched, or null */
export function leakedControlToken(text) {
  const s = String(text ?? '');
  for (const [re, key] of CONTROL_TOKEN_RES) {
    const m = s.match(re);
    if (m) return msg('ai.leakedSample', { label: msg(key), sample: m[0].slice(0, 40) });
  }
  return null;
}

/**
 * How many blocks of each type came back. **The absence of any `text` block is itself the phenomenon
 * being reported**, so this tallies every block type rather than only the recognised ones.
 */
function describeBlocks(content) {
  const tally = new Map();
  for (const b of content ?? []) {
    const t = b?.type ?? 'unknown';
    tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  if (!tally.size) return msg('ai.noBlocks');
  return [...tally].map(([t, n]) => `${t}×${n}`).join(msg('ai.blockSep'));
}

// ---------------------------------------------------------------------------
// Spend ceilings
// ---------------------------------------------------------------------------

