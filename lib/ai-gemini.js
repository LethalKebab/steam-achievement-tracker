/**
 * Google Gemini 供应商
 * ------------------------------------------------
 * 加这一家的**直接动机是免费层**:Anthropic 那条路一次都没真跑过,而本机没有 key。
 * Gemini 有免费额度,能让整条流水线第一次真正跑起来。长远看它也是给用户的一个
 * 低门槛选项——方案的目标本来就是"让用这个应用的人用他们自己的 key"。
 *
 * ## 这个文件是在拿不到官方文档的情况下写的
 *
 * 写它的时候网络工具连续不可用(和 spike 那天一样),所以下面的字段名、模型名、
 * 工具名都来自记忆,**没有对着文档核对过**。应对办法不是赌记性,是把每一个不确定的
 * 地方做成**运行时能自己回答**的:
 *
 * - **模型名可配置**,而且 `ai-check --models` 直接问 API 要列表。猜错了不用改代码
 * - **工具声明可配置**(`ai.geminiTools`),名字改了或者免费层不给用,也是改配置
 * - **搜索到底有没有发生,看回包不看文档**。`groundingMetadata.webSearchQueries` 是
 *   模型实际发出去的搜索词;声明了搜索工具却一条都没有,就是"这个层级没有联网",
 *   调用方会看到这个信号。这比读一份可能过期的定价页可靠得多
 *
 * ## 一个 Anthropic 那边没有的失败模式
 *
 * `finishReason: 'RECITATION'` —— 模型因为大段复述受版权保护的内容被拦下。
 * 写攻略正好是高危场景:我们**明确要求它原文照抄官方描述**,还要它读 wiki。
 * 所以它单独成一类,给一条能照着做的错误信息,不能和普通拒答混在一起吞掉。
 */
import { AiError, emptyUsage, addUsage, sseEvents, normalizeStop } from './ai.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini 的 finishReason → 全项目通用的那套词汇。
 * 大小写和拼写按记忆写,认不出来的一律落到 'other' 并把原值带出去,不猜。
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

/** usageMetadata → 通用 usage。字段名是 Gemini 自己那套 */
export function mergeGeminiUsage(target, meta) {
  if (!meta) return target;
  // 每个 chunk 报的都是"到目前为止"的累计值,所以是覆盖不是累加——和 Anthropic 同理
  if (typeof meta.promptTokenCount === 'number') target.inputTokens = meta.promptTokenCount;
  if (typeof meta.cachedContentTokenCount === 'number') target.cacheReadTokens = meta.cachedContentTokenCount;
  // 思考 token 单独报,但计费上算输出。合进 outputTokens 保持和 Anthropic 一边的口径一致
  // (那边 thinking 本来就计在 output_tokens 里)。第一次真跑要核对这条
  const out = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
  if (out) target.outputTokens = out;
  return target;
}

/**
 * 把流式 chunk 还原成一条完整回复。
 *
 * 比 Anthropic 那边简单得多:没有块索引、没有增量类型,每个 chunk 就是一份
 * `candidates[0].content.parts`,文本直接往后接。
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
      // 整个 prompt 被安全策略挡下时根本不会有 candidates,只有这个字段
      if (chunk?.promptFeedback?.blockReason) state.blockReason = chunk.promptFeedback.blockReason;

      const cand = chunk?.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) state.stopReason = cand.finishReason;

      for (const q of cand.groundingMetadata?.webSearchQueries ?? []) {
        if (!state.searchQueries.includes(q)) state.searchQueries.push(q);
      }

      for (const p of cand.content?.parts ?? []) {
        // thought:true 的是思考过程,不是正文。混进去会把思考写进攻略文件
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
          '  (免费额度在 https://aistudio.google.com/apikey 申请)'
      );
    }
    this.name = 'gemini';
    this.ai = ai;
    this.model = ai.model || 'gemini-2.5-pro';
    this.maxTokens = ai.maxTokens ?? 32000;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  /**
   * 联网工具。名字做成可配置的,因为这个文件是在没有文档的情况下写的——
   * 工具改名、或者免费层不给用,都是改配置而不是改代码。
   *
   * 默认只声明 `google_search`。`url_context`(相当于 Anthropic 的 web_fetch)
   * 要显式加进 `ai.geminiTools`:多声明一个没把握的工具,请求会整个 400,
   * 而第一次能跑起来比一次就跑到最优更重要。
   */
  webTools() {
    const names = this.ai.geminiTools?.length ? this.ai.geminiTools : ['google_search'];
    return names.map((n) => ({ [n]: {} }));
  }

  #headers() {
    // key 走请求头,不走 ?key= 查询串——查询串会进日志、进浏览器历史、进错误上报
    return { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey };
  }

  /**
   * 通用消息形状 → Gemini 的 contents。
   * 两处不一样:assistant 在这边叫 model;正文装在 parts 里而不是 content 里。
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
    // thinking 预算不确定当前默认值是多少,所以**不配就完全不发**——
    // 让模型用自己的默认值,比发一个可能不被接受的字段安全
    if (typeof this.ai.geminiThinkingBudget === 'number') {
      body.generationConfig.thinkingConfig = {
        thinkingBudget: this.ai.geminiThinkingBudget,
        includeThoughts: Boolean(this.ai.showThinking),
      };
    }
    return body;
  }

  /** `ai-check --models`:直接问 API 有哪些模型可用,不猜名字 */
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

  async #once(body, { onEvent } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const url = `${BASE_URL}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, this.model);

      const acc = createGeminiAccumulator();
      // 搜索词会在后续每个 chunk 里重复出现,进度输出只报第一次见到的
      const seenQueries = new Set();
      for await (const ev of sseEvents(res.body)) {
        emitProgress(ev, onEvent, seenQueries);
        acc.push(ev);
      }
      const out = acc.result();
      out.usage.requests = 1;
      return out;
    } catch (err) {
      ac.abort();
      if (err instanceof AiError) throw err;
      if (err?.name === 'AbortError') {
        throw new AiError(
          `请求超过 ${Math.round(this.timeoutMs / 1000)} 秒没结束。不够就调大 config.json 的 ai.requestTimeoutMs`,
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
   * 一轮对话。
   *
   * **没有 pause_turn 那套**:grounding 在服务端一轮之内做完,所以 `continuations`
   * 恒为 0。这不是没实现,是这一家不需要。
   */
  async send({ system, messages, tools, onEvent } = {}) {
    const usage = emptyUsage();
    const r = await this.#withRetry(this.buildBody({ system, messages, tools }), { onEvent });
    addUsage(usage, r.usage);

    // 整个 prompt 被挡下时没有 candidates,也就没有 finishReason,只有 blockReason
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
      // Gemini 的联网失败不会单独报成一个工具错误块;"搜了没有"看 searchQueries
      toolErrors: [],
      searchQueries: r.searchQueries,
      thinking: r.thinking,
    };
  }
}

/**
 * 原始 chunk → 通用进度事件,和 Anthropic 那边发出来的是同一套词汇。
 * 调用方因此不用认识任何一家的格式。
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

async function errorFromResponse(res, model) {
  let status = null;
  let detail = '';
  const raw = await res.text().catch(() => '');
  try {
    const body = JSON.parse(raw);
    const e = Array.isArray(body) ? body[0]?.error : body?.error;
    status = e?.status ?? null;
    detail = e?.message ?? '';
  } catch {
    detail = raw.slice(0, 300);
  }

  let hint = '';
  if (res.status === 404 || /not found|not supported/i.test(detail)) {
    hint = `\n  (模型名 "${model}" 可能不对,或者你的 key 没权限用它。` +
      '跑 `node tracker.js ai-check --models` 看看实际有哪些可用)';
  } else if (res.status === 429) {
    // 免费层是按每分钟/每天配额算的,撞上每日上限的话当天重试多少次都没用
    hint = '\n  (配额用完了。免费层有每分钟和每天两道上限——如果是每天那道,得等次日重置,' +
      '或者换成配额更宽的 flash 系列模型)';
  } else if (res.status === 400 && /tool|function/i.test(detail)) {
    hint = '\n  (像是工具声明不被接受:改 config.json 的 ai.geminiTools,' +
      '默认值是 ["google_search"];去掉 url_context 再试)';
  } else if (res.status === 403) {
    hint = '\n  (key 无效,或者这个 API 在你的地区/项目里没启用)';
  }

  return new AiError(`Gemini API HTTP ${res.status}${status ? ` ${status}` : ''}:${detail}${hint}`, {
    status: res.status,
    type: status,
    retryable: res.status === 429 || res.status >= 500,
  });
}
