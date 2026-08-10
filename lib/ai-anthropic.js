/**
 * Anthropic 供应商
 * ------------------------------------------------
 * 从 lib/ai.js 拆出来的(加第二家之后那个文件会超过 800 行)。共用的部分——用量记账、
 * 估价、会话、结果判定——留在 ai.js;这里只装 Anthropic 独有的东西:请求长什么样、
 * SSE 里的块怎么拼、服务端工具循环怎么续跑。
 *
 * 几条踩不得的线(来源是权威 API 文档,不是回忆):
 *
 * - **必须流式**。`max_tokens` 是 thinking + 正文的**总**上限,而 Opus 5 默认就在思考;
 *   一份 60 个成就的攻略配上联网研究,非流式请求会先撞上 HTTP 超时(undici 默认 5 分钟)
 *   而不是撞上 token 上限。
 * - **绝对不要再单独声明 `code_execution`**。`_20260209` 版的 web 工具内部已经跑代码做
 *   动态过滤,再加一个等于两套执行环境。
 * - **不要传 `temperature` / `top_p` / `top_k` / `budget_tokens`**,四个在 Opus 5 上
 *   一律 400,不是"忽略"。深浅用 `output_config.effort`。
 * - **不要用 assistant 结尾的 prefill**,同样 400。
 * - **server 工具的错误不抛异常**,而是 HTTP 200 + content 里放一个错误对象;而且
 *   web search 成功时 `content` 是**数组**、出错时是**对象**,取下标之前必须先分支。
 */
import {
  AiError, emptyUsage, mergeMessageUsage, addUsage, sseEvents, normalizeStop,
} from './ai.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 服务端搜索/抓页工具。`_20260209` 这一版才有动态过滤,适用于 Opus 5 / 4.8 / 4.7 / 4.6、
 * Sonnet 5 / 4.6。换更老的模型要换回 `web_search_20250305`。
 */
const WEB_SEARCH_TOOL = 'web_search_20260209';
const WEB_FETCH_TOOL = 'web_fetch_20260209';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Anthropic 的 stop_reason → 全项目通用的那套词汇 */
const STOP_MAP = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'end_turn',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

/** 把 text 块拼起来(thinking / 工具块跳过) */
function textOfBlocks(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/**
 * 挑出服务端工具的失败。
 *
 * **必须先分支再取下标**:web_search 成功时 `content` 是结果数组,出错时是
 * `{type:'web_search_tool_result_error', error_code}` 这样一个对象。直接 `content[0]`
 * 在出错分支上拿到的是 undefined,于是一次"搜索被限流了"会被读成"搜到了空结果",
 * 模型接着按空手写攻略——这类静默降级正是这个项目最防的东西。
 */
export function serverToolErrors(content) {
  const out = [];
  for (const b of content ?? []) {
    if (b?.type !== 'web_search_tool_result' && b?.type !== 'web_fetch_tool_result') continue;
    const inner = b.content;
    if (Array.isArray(inner)) continue; // 数组 = 成功
    out.push({ tool: b.type, errorCode: inner?.error_code ?? inner?.type ?? 'unknown' });
  }
  return out;
}

/** 模型实际发出去的搜索词。空数组 = 它根本没联网,是个该被看见的信号 */
export function searchQueriesOf(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'server_tool_use' && b?.name === 'web_search')
    .map((b) => b.input?.query)
    .filter(Boolean);
}

/**
 * 把 SSE 事件流还原成一条完整消息。
 *
 * 各种块的增量长得不一样:text 走 `text_delta`,thinking 走 `thinking_delta` +
 * `signature_delta`,工具入参走 `input_json_delta`(拼完再 JSON.parse)。
 * 服务端工具的**结果**块不走增量,`content_block_start` 里就是完整内容。
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
          // 入参是流式拼出来的,先挂个草稿字段,content_block_stop 时解析掉
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
            // 拼出来的不是合法 JSON 就保留原值,不要抛——这块是模型发给服务端工具的入参,
            // 我们只是转发,解析失败不该整轮失败
            if (b.__json) {
              try {
                b.input = JSON.parse(b.__json);
              } catch {
                /* 保留原值 */
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
    /** 中间有块没收到 content_block_stop 时数组会留空洞,过滤掉 */
    result() {
      return { content: content.filter(Boolean), ...state };
    },
  };
}

export class AnthropicProvider {
  /** key 放私有字段,免得 console.log(provider) 或者错误对象把它带出去 */
  #apiKey;

  constructor(ai, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!ai?.apiKey) {
      throw new AiError(
        'Anthropic API key 没配置。填 config.json 的 ai.apiKey,或者用环境变量 ANTHROPIC_API_KEY=...'
      );
    }
    this.name = 'anthropic';
    this.ai = ai;
    this.model = ai.model || 'claude-opus-5';
    this.maxTokens = ai.maxTokens ?? 32000;
    this.maxContinuations = ai.maxContinuations ?? 5;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    // **端点可配置。** 不只是为了代理:实测(2026-08-10)DeepSeek 的 Anthropic 兼容端点
    // `https://api.deepseek.com/anthropic` 支持**服务端 web_search** —— 声明工具后
    // 回包里有 server_tool_use / web_search_tool_result 块,usage 里有
    // web_search_requests 计数,而同一个模型不给工具时会老实回答"查不到"。
    // 也就是说这一层原封不动就能给 DeepSeek 用上联网,不用另写一套。
    // (注意:DeepSeek **OpenAI 兼容**的 /chat/completions 没有这个能力,见 ai-deepseek.js
    //  —— 同一家、两个端点、能力不同,别把一个的结论套到另一个上。)
    this.baseUrl = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  /** 有服务端搜索。见 ai.js 顶部关于 canSearch 的说明 */
  get canSearch() {
    return true;
  }

  /**
   * 联网研究要用的两个服务端工具。
   *
   * 分工不是"摘要还是全文"的二选一:**搜索负责找出候选 URL,web_fetch 负责把全文抓回来**,
   * `max_content_tokens` 是控制抓多少的旋钮。而且 web_fetch **只能抓已经出现在对话里的
   * URL**,所以必须先搜后抓——这是编排上的硬顺序,不是实现细节。
   *
   * `allowedDomains` 默认空 = 不限制。API 只提供 allowed/blocked 这种**硬过滤**,
   * 而"中文攻略站在搜索索引里的实际覆盖率"还没实测,默认就把搜索锁死在几个站上,
   * 是拿没量过的假设换质量。
   *
   * `citations` 显式关掉:开着会往 text 块里塞引用元数据,而 SKILL.md 规则七明确要求
   * 攻略正文里不写数据来源。
   */
  webTools() {
    const ai = this.ai;
    const search = { type: WEB_SEARCH_TOOL, name: 'web_search' };
    if (ai.maxSearches > 0) search.max_uses = ai.maxSearches;
    if (ai.allowedDomains?.length) search.allowed_domains = ai.allowedDomains;

    const fetchTool = { type: WEB_FETCH_TOOL, name: 'web_fetch', citations: { enabled: false } };
    if (ai.maxFetches > 0) fetchTool.max_uses = ai.maxFetches;
    if (ai.maxFetchTokens > 0) fetchTool.max_content_tokens = ai.maxFetchTokens;
    if (ai.allowedDomains?.length) fetchTool.allowed_domains = ai.allowedDomains;

    return [search, fetchTool];
  }

  #headers() {
    const h = {
      'content-type': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    // Opus 5 的分类器可能直接拒答(HTTP 200 + refusal)。fallbacks 是**选择加入**的:
    // 开了则由服务端换一个模型重跑同一个请求。
    if (this.ai.fallbacks !== false) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return h;
  }

  /** 组装请求体。单独抽出来是为了 `--dry` 能在不发请求的前提下打出来看 */
  buildBody({ system, messages, tools }) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      stream: true,
      // thinking 显式写出来:Opus 5 省略等于 adaptive,但 4.8/4.7 省略等于**不思考**,
      // 而 model 是可配置的。显式比"靠默认值恰好对"可靠
      thinking: this.ai.showThinking ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' },
      output_config: { effort: this.ai.effort ?? 'high' },
    };
    if (system) {
      // 最后一块打 cache_control:回灌重写要重发同一份规则和成就清单,命中缓存按 0.1 倍计费
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (tools?.length) body.tools = tools;
    if (this.ai.fallbacks !== false) body.fallbacks = 'default';
    return body;
  }

  async #once(body, { onEvent } = {}) {
    const ac = new AbortController();
    // 流开始读之后才允许 abort,见下面 catch 里的说明
    let streaming = false;
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
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
      // 流读到一半失败时连接还开着,重试会再开一条,不主动断掉就每次漏一个 socket
      // **只有流还开着才需要断。** 请求已经完整返回时(比如 4xx —— body 已经被 text()
      // 读完了)再 abort,Windows 上会在进程退出时触发 libuv 断言:
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
   * 跑完一整轮对话回合,包括服务端工具循环。
   *
   * **这里的循环不是客户端执行工具**——web_search / web_fetch 都在 Anthropic 那边跑完了。
   * 要循环是因为服务端的采样循环有迭代上限(默认 10 次),撞上了就返回
   * `stop_reason: 'pause_turn'`,把 assistant 这一轮原样加回 messages 再发一次。
   *
   * **不要额外加一句 "继续"**:服务端认的是结尾那个 server_tool_use 块,
   * 多塞一条 user 消息反而打断它。
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

    // pause_turn 续跑时,最后一条消息只带这一段的 content。要把整轮拼起来还给调用方,
    // 否则前面搜到的东西全丢了
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
 * 原始 SSE 事件 → 通用进度事件。
 *
 * 调用方(CLI 的实时输出、guidegen 的进度条)不该认识任何一家的事件格式,
 * 否则每加一家供应商就要改一遍所有的展示代码。原始事件挂在 `.raw` 上备查。
 */
function emitProgress(ev, onEvent) {
  if (!onEvent) return;
  if (ev.type === 'content_block_start') {
    const b = ev.content_block ?? {};
    if (b.type === 'server_tool_use') {
      onEvent({ type: 'tool', name: b.name, raw: ev });
    } else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') {
      const ok = Array.isArray(b.content);
      onEvent({ type: 'tool-result', ok, errorCode: ok ? null : b.content?.error_code ?? 'unknown', raw: ev });
    }
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    onEvent({ type: 'text', text: ev.delta.text ?? '', raw: ev });
  }
}

/**
 * 非 200 响应 → AiError。
 *
 * 错误体是 `{type:'error', error:{type,message}, request_id}`。request_id 要带上:
 * 报障时那是唯一能定位这次请求的东西。**响应头和请求头一个都不带**——里面有 x-api-key。
 */
async function errorFromResponse(res) {
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
    hint = '\n  (API key 不对或已撤销:检查 config.json 的 ai.apiKey / 环境变量 ANTHROPIC_API_KEY)';
  } else if (res.status === 400 && /fallback|beta/i.test(detail)) {
    // 400 里最容易踩的是 beta 头。出这个错的人手上没有别的线索能猜到关掉哪个开关
    hint = '\n  (像是 fallbacks 的 beta 头不被接受:在 config.json 里设 "ai": { "fallbacks": false } 关掉再试)';
  } else if (res.status === 400) {
    hint = '\n  (400 是请求本身的问题,重试没用——看上面的 message)';
  }

  return new AiError(`Anthropic API HTTP ${res.status}${type ? ` ${type}` : ''}:${detail}${hint}`, {
    status: res.status,
    type,
    requestId,
    retryable: res.status === 429 || res.status >= 500,
  });
}
