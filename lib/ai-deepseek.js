/**
 * DeepSeek 供应商
 * ------------------------------------------------
 * **这一家没有服务端联网搜索**,所以它和另外两家不是一个定位。
 *
 * 设计文档的准入规则是「有服务端搜索」是硬性准入,理由是"混进一家没有搜索的,会让质量
 * 取决于用户选了谁,而用户看不出这个差别"。DeepSeek 的 API 不提供这个能力
 * (聊天网站有,API 没有),所以它**不满足给用户用的门槛**。
 *
 * 接它是为了另一件事:**把流水线本身跑通**。机械打勾、校验闸门、回灌重写循环、落盘,
 * 这些到接它为止只在假供应商上跑过——而它们**一个都不需要联网**。用一家便宜、稳定、
 * 拿得到 key 的模型把编排验完,比继续在配额问题上耗着有价值得多。
 *
 * 所以 `canSearch = false`,而且这个标记会一路传到:
 *   - `guide-gen` 默认**拒绝**用它生成,除非显式加 `--no-research`
 *   - 提示词换成"你没有联网能力,不确定的一律别写"那一版
 *   - CLI 结果里明写这份攻略没有经过任何调研
 * 让"这次没联网"变成藏不住的事实,而不是一个用户看不出来的质量差别。
 *
 * 协议是 OpenAI 兼容的 chat/completions,和另外两家都不一样,所以照例关在这个文件里。
 * 字段名来自记忆(写的时候网络工具仍不可用),因此和 Gemini 一样:**能配置的都做成配置**,
 * 猜错了改配置不改代码。
 */
import { AiError, emptyUsage, addUsage, sseEvents, normalizeStop } from './ai.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OpenAI 兼容的 finish_reason → 全项目通用的那套词汇 */
const STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
  tool_calls: 'end_turn',
  // DeepSeek 自己加的:服务端资源不够,属于临时状况而不是内容问题
  insufficient_system_resource: 'other',
};

/** usage 字段是 OpenAI 那套命名 */
export function mergeDeepseekUsage(target, u) {
  if (!u) return target;
  // 每个带 usage 的 chunk 报的都是这条消息的累计值 —— 覆盖,不累加
  if (typeof u.prompt_tokens === 'number') target.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') target.outputTokens = u.completion_tokens;
  // DeepSeek 的上下文硬盘缓存:命中的部分单独报,对应我们的 cacheRead
  const hit = u.prompt_cache_hit_tokens;
  if (typeof hit === 'number') {
    target.cacheReadTokens = hit;
    // inputTokens 已经含了命中部分,减掉免得同一批 token 被算两遍
    if (typeof u.prompt_tokens === 'number') target.inputTokens = u.prompt_tokens - hit;
  }
  return target;
}

/**
 * 把流式 chunk 还原成一条完整回复。
 *
 * **`reasoning_content` 绝对不能进正文** —— deepseek-reasoner 会把思维链放在这个字段里,
 * 和正文并排出现在同一个 delta 上。混进去就等于把模型的思考过程写进用户的攻略文件,
 * 和 Gemini 那边 `thought: true` 是同一类坑。
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
        'DeepSeek API key 没配置。填 config.json 的 ai.apiKey,或者用环境变量 DEEPSEEK_API_KEY=...'
      );
    }
    this.name = 'deepseek';
    this.ai = ai;
    this.model = ai.model || 'deepseek-chat';
    // 上下文和单次输出上限都比另外两家小不少,默认给保守值。不够会以 400 报出来,
    // 不是静默截断 —— 真不够就调 ai.maxTokens,或者换一家
    this.maxTokens = ai.maxTokens ?? 8000;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    this.baseUrl = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  /**
   * **没有服务端搜索。** 这不是"还没实现",是这家 API 不提供。
   * 上层靠这个标记决定要不要拦、以及换哪一版提示词。
   */
  get canSearch() {
    return false;
  }

  webTools() {
    return [];
  }

  #headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` };
  }

  /** 通用消息形状 → OpenAI 兼容的 messages。system 在这边是 messages 里的一条 */
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
      // 不加这个的话流式模式下拿不到 usage,账就没法记
      stream_options: { include_usage: true },
      max_tokens: this.maxTokens,
    };
  }

  async #once(body, { onEvent } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, this.model);

      const acc = createDeepseekAccumulator();
      for await (const ev of sseEvents(res.body)) {
        emitProgress(ev, onEvent);
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

  /** 一轮对话。没有服务端工具,所以没有续跑那套,`continuations` 恒为 0 */
  async send({ system, messages, onEvent } = {}) {
    const usage = emptyUsage();
    const r = await this.#withRetry(this.buildBody({ system, messages }), { onEvent });
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
      // 永远是空的,而且是**结构性**的空:这家没有联网能力
      searchQueries: [],
      thinking: r.thinking,
    };
  }
}

/** 原始 chunk → 通用进度事件 */
function emitProgress(chunk, onEvent) {
  if (!onEvent) return;
  const d = chunk?.choices?.[0]?.delta;
  if (typeof d?.content === 'string' && d.content) onEvent({ type: 'text', text: d.content, raw: chunk });
}

async function errorFromResponse(res, model) {
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

  let hint = '';
  if (res.status === 402) {
    // DeepSeek 特有:余额不够。和限流完全不是一回事,重试永远不会好
    hint = '\n  ⚠️  账户余额不足(HTTP 402)。这不是限流,重试没有意义 —— 去 DeepSeek 后台充值。';
  } else if (res.status === 401) {
    hint = '\n  (API key 不对:检查 config.json 的 ai.apiKey / 环境变量 DEEPSEEK_API_KEY)';
  } else if (res.status === 404 || /model/i.test(detail)) {
    hint = `\n  (模型名 "${model}" 可能不对。常用的是 deepseek-chat 和 deepseek-reasoner)`;
  } else if (res.status === 400 && /max_tokens|context|length/i.test(detail)) {
    hint = '\n  (上下文或输出长度超了。DeepSeek 的上限比另外两家小,' +
      '把 config.json 的 ai.maxTokens 调小,或者换一款成就少一点的游戏试)';
  }

  return new AiError(`DeepSeek API HTTP ${res.status}${type ? ` ${type}` : ''}:${detail}${hint}`, {
    status: res.status,
    type,
    // 402 是余额问题,重试永远不会好
    retryable: (res.status === 429 || res.status >= 500) && res.status !== 402,
  });
}
