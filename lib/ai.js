/**
 * AI 供应商层(第一家:Anthropic)
 * ------------------------------------------------
 * 职责就三件事,和 docs/ai-guide-writing.md「架构」一节写的一样:
 * **请求组装、tool-call 循环、usage 统计**。攻略怎么写、写完怎么校验、不过关怎么回灌,
 * 全是 guidegen 的事,这一层一个字都不知道——加第二家(OpenAI)时要改的只有这个文件。
 *
 * 零依赖:原始 HTTP + 内置 fetch,不装 SDK。整个项目"没有安装步骤"是特性不是巧合。
 *
 * 几条踩不得的线(来源是 claude-api skill 的权威文档,不是回忆):
 *
 * - **必须流式**。`max_tokens` 是 thinking + 正文的**总**上限,而 Opus 5 默认就在思考;
 *   一份 60 个成就的攻略配上联网研究,非流式请求会先撞上 HTTP 超时(undici 默认 5 分钟),
 *   而不是撞上 token 上限。所以这里自己解析 SSE,没有别的选择。
 * - **绝对不要再单独声明 `code_execution`**。`_20260209` 版的 web_search/web_fetch
 *   内部已经跑代码做动态过滤,再加一个等于两套执行环境,把模型搞糊涂。
 * - **不要传 `temperature` / `top_p` / `top_k` / `budget_tokens`**。这四个在 Opus 5 上
 *   一律 400,不是"忽略"。想控制深浅用 `output_config.effort`。
 * - **不要用 assistant 结尾的 prefill**。同样 400。要固定输出格式用 structured outputs。
 * - **`stop_reason` 要先看再读 content**。Opus 5 带安全分类器,可能返回 HTTP 200 +
 *   `refusal`,content 是空的或半截的;`max_tokens` 则是内容被截断——一份截断的攻略
 *   比一次失败更糟,所以这两种都单独报,绝不当成正常结果往下传。
 * - **server 工具的错误不抛异常**,而是 HTTP 200 + content 里放一个错误对象;而且
 *   web_search 成功时 `content` 是**数组**、出错时是**对象**,取下标之前必须先分支。
 *
 * 缓存:system 最后一块打 `cache_control`。回灌重写最多 3 轮,每轮都要重发同一份
 * 规则 + 成就清单,命中缓存的部分按 0.1 倍计费。**别往 system 里插时间戳/UUID**——
 * 缓存是前缀匹配,前面变一个字节后面全作废(guidegen 拼 system 时注意)。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 服务端搜索/抓页工具。`_20260209` 这一版才有动态过滤,适用于 Opus 5 / 4.8 / 4.7 / 4.6、
 * Sonnet 5 / 4.6。换更老的模型要换回 `web_search_20250305`。
 */
const WEB_SEARCH_TOOL = 'web_search_20260209';
const WEB_FETCH_TOOL = 'web_fetch_20260209';

/**
 * 每百万 token 的美元单价。cache 写入是输入价的 1.25 倍、读取 0.1 倍。
 *
 * **表里没有的模型一律不估价**,而不是当 0 算——docs/ai-guide-writing.md 定的规矩是
 * "在花钱这件事上给错数字比不给更糟"。悄悄显示 $0.00 正是最糟的那种错数字。
 */
const MODEL_PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** 429 / 5xx / 网络抖动的重试节奏。和 Steam 那边一样:400 是信号,不重试 */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export class AiError extends Error {
  constructor(message, { status = null, type = null, requestId = null, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.type = type;
    this.requestId = requestId;
    this.retryable = retryable;
  }

  /**
   * 非 200 响应 → AiError。
   *
   * 错误体是 `{type:'error', error:{type,message}, request_id}`。request_id 要带上:
   * 报障给 Anthropic 时那是唯一能定位这次请求的东西。**响应头和请求头一个都不带**——
   * 里面有 x-api-key。
   */
  static async fromResponse(res) {
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
    if (res.status === 401) hint = '\n  (API key 不对或已撤销:检查 config.json 的 ai.apiKey / 环境变量 ANTHROPIC_API_KEY)';
    // 400 里最容易踩的是 beta 头:fallbacks 要配 server-side-fallback beta,账号/版本对不上就整个请求挂掉。
    // 这条 hint 是故意写死的——出这个错的人手上没有别的线索能猜到关掉哪个开关。
    else if (res.status === 400 && /fallback|beta/i.test(detail)) {
      hint = '\n  (像是 fallbacks 的 beta 头不被接受:在 config.json 里设 "ai": { "fallbacks": false } 关掉再试)';
    } else if (res.status === 400) hint = '\n  (400 是请求本身的问题,重试没用——看上面的 message)';

    return new AiError(`Anthropic API HTTP ${res.status}${type ? ` ${type}` : ''}:${detail}${hint}`, {
      status: res.status,
      type,
      requestId,
      // 429 真限流、5xx/529 服务端问题 → 值得重试;其余(尤其 400/401)重试只是浪费时间
      retryable: res.status === 429 || res.status >= 500,
    });
  }
}

// ---------------------------------------------------------------------------
// usage 统计
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
 * **一条消息内**合并 usage:覆盖,不累加。
 *
 * 这是最容易悄悄算错的一处。`message_start` 和 `message_delta` 报的都是"这条消息到目前
 * 为止的累计值"——`message_start.usage.output_tokens` 是个很小的初值,`message_delta`
 * 那个才是最终值。两个相加会把输出 token 多算一遍,而多算出来的数没有任何地方会报错,
 * 只会让费用显示一直偏高。test/ai.test.js 钉住了这条。
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
 * **跨消息**累加 usage:相加。
 *
 * pause_turn 续跑、回灌重写的每一轮,都是各自独立的一条消息,各自有一份完整 usage,
 * 这时候才该加。"消息内覆盖、跨消息相加"两句话必须都对,错一半就是账不准。
 */
export function addUsage(target, more) {
  if (!more) return target;
  for (const k of Object.keys(target)) target[k] += more[k] ?? 0;
  return target;
}

/**
 * 估价。只算**模型 token**。
 *
 * 搜索工具本身怎么计费还没实测(见 docs/ai-guide-writing.md「spike 结果」里那三条待验),
 * 所以这里如实返回搜索次数、不折算成钱。把一个猜出来的搜索单价混进总额里,得到的是一个
 * 看起来精确、实际不知道错多少的数字——正是这个方案明令不做的事。
 *
 * @returns {{usd: number|null, priced: boolean, model: string, webSearches: number}}
 *          priced=false 表示这个模型没有价格表,usd 是 null 而不是 0
 */
export function estimateCost(usage, model) {
  const price = MODEL_PRICING[model];
  if (!price) return { usd: null, priced: false, model, webSearches: usage.webSearches };
  const usd =
    (usage.inputTokens * price.input +
      usage.cacheCreationTokens * price.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER +
      usage.outputTokens * price.output) /
    1_000_000;
  return { usd, priced: true, model, webSearches: usage.webSearches };
}

/** 给 CLI / 进度条用的一行摘要 */
export function formatUsage(usage, model) {
  const cost = estimateCost(usage, model);
  const tokens =
    `输入 ${usage.inputTokens}(缓存写 ${usage.cacheCreationTokens} / 读 ${usage.cacheReadTokens})` +
    `,输出 ${usage.outputTokens}`;
  const money = cost.priced ? `$${cost.usd.toFixed(4)}` : `无价格表(${model})`;
  return `${tokens} · 模型花费 ${money} · 联网搜索 ${usage.webSearches} 次(搜索计费未计入)`;
}

// ---------------------------------------------------------------------------
// content 读取小工具
// ---------------------------------------------------------------------------

/** 把所有 text 块拼起来。thinking / 工具块自动跳过 */
export function textOf(content) {
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
    const code = inner?.error_code ?? inner?.type ?? 'unknown';
    out.push({ tool: b.type, errorCode: code });
  }
  return out;
}

/** 服务端工具被调用了几次(server_tool_use 块的数量),用来判断"模型到底联网了没有" */
export function serverToolCalls(content) {
  return (content ?? []).filter((b) => b?.type === 'server_tool_use').length;
}

// ---------------------------------------------------------------------------
// 工具定义组装
// ---------------------------------------------------------------------------

/**
 * 组装联网研究要用的两个服务端工具。
 *
 * 分工不是"摘要还是全文"的二选一:**搜索负责找出候选 URL,web_fetch 负责把全文抓回来**,
 * `max_content_tokens` 是控制抓多少的旋钮。而且 web_fetch **只能抓已经出现在对话里的
 * URL**,所以必须先搜后抓——这是编排上的硬顺序,不是实现细节。
 *
 * `allowedDomains` 默认空 = 不限制。API 只提供 allowed/blocked 这种**硬过滤**,
 * 而"中文攻略站在搜索索引里的实际覆盖率"还没实测(spike 三条待验之一),
 * 默认就把搜索锁死在几个站上,是拿没量过的假设换质量。要偏向中文站,先在提示词里说,
 * 真需要硬锁再往这个数组里填。
 *
 * `citations` 显式关掉:开着会往 text 块里塞引用元数据,而 SKILL.md 规则七明确要求
 * 攻略正文里不写数据来源。
 */
export function buildWebTools(ai = {}) {
  const search = { type: WEB_SEARCH_TOOL, name: 'web_search' };
  if (ai.maxSearches > 0) search.max_uses = ai.maxSearches;
  if (ai.allowedDomains?.length) search.allowed_domains = ai.allowedDomains;

  const fetchTool = { type: WEB_FETCH_TOOL, name: 'web_fetch', citations: { enabled: false } };
  if (ai.maxFetches > 0) fetchTool.max_uses = ai.maxFetches;
  if (ai.maxFetchTokens > 0) fetchTool.max_content_tokens = ai.maxFetchTokens;
  if (ai.allowedDomains?.length) fetchTool.allowed_domains = ai.allowedDomains;

  return [search, fetchTool];
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** 逐个吐出 SSE 事件。事件之间用空行分隔,一个事件可能被拆在两个 chunk 里 */
async function* sseEvents(body) {
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
      if (!data) continue;
      yield JSON.parse(data);
    }
  }
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
            // 拼出来的不是合法 JSON 就保留 content_block_start 给的原值,不要抛——
            // 这块是模型发给服务端工具的入参,我们只是转发,解析失败不该整轮失败
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
            // overloaded/api_error 是服务端临时状况,值得重试
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

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AnthropicProvider {
  /** key 放私有字段,免得 console.log(provider) 或者错误对象把它带出去 */
  #apiKey;

  /**
   * @param {object} ai      config.ai
   * @param {object} [opts]
   * @param {Function} [opts.fetchImpl] 注入用,测试靠它跑完整循环而不联网
   * @param {Function} [opts.log]
   */
  constructor(ai, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!ai?.apiKey) {
      throw new AiError(
        'Anthropic API key 没配置。填 config.json 的 ai.apiKey,或者用环境变量 ANTHROPIC_API_KEY=...'
      );
    }
    this.name = 'anthropic';
    this.ai = ai;
    this.model = ai.model;
    this.maxTokens = ai.maxTokens ?? 32000;
    this.maxContinuations = ai.maxContinuations ?? 5;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.#apiKey = ai.apiKey;
  }

  #headers() {
    const h = {
      'content-type': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    // Opus 5 的分类器可能直接拒答(HTTP 200 + refusal)。fallbacks 是**选择加入**的:
    // 不开的话被拒就到此为止,开了则由服务端换一个模型重跑同一个请求。
    // "default" 按拒答类别自动选降级模型,比写死一个型号省一次将来的迁移。
    if (this.ai.fallbacks !== false) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return h;
  }

  /** 组装请求体。单独抽出来是为了 `ai-check --dry` 能在不发请求的前提下打出来看 */
  buildBody({ system, messages, tools }) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      stream: true,
      // thinking 显式写出来:Opus 5 省略等于 adaptive,但 4.8/4.7 省略等于**不思考**,
      // 而 model 是可配置的。显式比"靠默认值恰好对"可靠
      thinking: this.ai.showThinking
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'adaptive' },
      output_config: { effort: this.ai.effort ?? 'high' },
    };
    if (system) {
      // 数组形式 + 最后一块打 cache_control:回灌重写要重发同一份规则和成就清单,
      // 命中缓存按 0.1 倍计费。Opus 5 的最小可缓存前缀是 512 token
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (tools?.length) body.tools = tools;
    if (this.ai.fallbacks !== false) body.fallbacks = 'default';
    return body;
  }

  /** 发一次,解析流,返回一条完整消息。不管 pause_turn,那是上层的事 */
  async #once(body, { onEvent } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(API_URL, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw await AiError.fromResponse(res);

      const acc = createAccumulator();
      for await (const ev of sseEvents(res.body)) {
        onEvent?.(ev);
        acc.push(ev);
      }
      const out = acc.result();
      out.usage.requests = 1;
      return out;
    } catch (err) {
      // 流读到一半失败(比如流内 error 事件)时连接还开着。重试会再开一条,
      // 不主动断掉就每重试一次漏一个 socket
      ac.abort();
      if (err instanceof AiError) throw err;
      if (err?.name === 'AbortError') {
        throw new AiError(
          `请求超过 ${Math.round(this.timeoutMs / 1000)} 秒没结束。高 effort + 联网研究本来就慢,` +
            '不够就调大 config.json 的 ai.requestTimeoutMs',
          { retryable: false }
        );
      }
      // 网络层抖动(DNS、连接重置)算可重试
      throw new AiError(`请求失败:${err?.message ?? err}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 429 / 5xx / 网络问题退避重试。400 一类直接抛——重试改变不了请求本身写错了 */
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
   * **这里的"tool-call 循环"不是客户端执行工具**——web_search / web_fetch 都在
   * Anthropic 那边跑完了,我们这边没有工具要执行。要循环是因为服务端的采样循环有
   * 迭代上限(默认 10 次),撞上了就返回 `stop_reason: 'pause_turn'`,把 assistant
   * 这一轮原样加回 messages 再发一次,服务端会自己接着跑。
   *
   * **不要额外加一句 "继续"**:服务端认的是结尾那个 server_tool_use 块,多塞一条
   * user 消息反而打断它。
   *
   * @returns {{content, text, stopReason, stopDetails, usage, model, continuations, toolErrors}}
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
    // 否则 guidegen 收到的是"最后一次续跑写了什么",前面搜到的东西全丢了
    const full = [];
    for (const m of convo.slice(messages.length)) full.push(...m.content);
    full.push(...last.content);

    return {
      content: full,
      text: textOf(full),
      stopReason: last.stopReason,
      stopDetails: last.stopDetails,
      usage,
      model: last.model ?? this.model,
      continuations,
      toolErrors: serverToolErrors(full),
    };
  }
}

/** 按 config.ai.provider 建供应商。加 OpenAI 时只动这个函数和一个新文件 */
export function createProvider(config, opts = {}) {
  const ai = config?.ai ?? {};
  const provider = ai.provider ?? 'anthropic';
  if (provider !== 'anthropic') {
    throw new AiError(`还没接入的供应商:${provider}(目前只有 anthropic;OpenAI 是「动手顺序」第 4 步)`);
  }
  return new AnthropicProvider(ai, opts);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/**
 * 多轮会话:攒 messages、攒 usage。
 *
 * 回灌重写(校验不过 → 把具体错误发回去 → 最多 3 轮)就是多轮,所以历史必须留着——
 * 而且留着还更便宜:前缀命中缓存。usage 在这里跨消息累加,费用上限那一步(第 5 步)
 * 直接读 `session.usage` 就行,不用再去各处埋点。
 */
export function createSession(provider, { system = null, tools = null } = {}) {
  const messages = [];
  const usage = emptyUsage();

  return {
    provider,
    messages,
    usage,
    /** 发一句话,拿回这一轮的完整结果。assistant 回复自动进历史 */
    async ask(userText, { onEvent } = {}) {
      messages.push({ role: 'user', content: userText });
      const r = await provider.send({ system, messages, tools, onEvent });
      addUsage(usage, r.usage);
      // 把 assistant 这轮原样存回去(thinking 块也要,同模型续聊必须原样回传)
      messages.push({ role: 'assistant', content: r.content });
      return r;
    },
    cost() {
      return estimateCost(usage, provider.model);
    },
    summary() {
      return formatUsage(usage, provider.model);
    },
  };
}

/**
 * 把一轮结果判成"能用 / 不能用",顺带给出人话原因。
 *
 * 单独抽出来是因为**这三种失败都长得像成功**:refusal 是 HTTP 200、max_tokens 有正文
 * 只是被砍了一半、工具报错也是 200。谁调用谁写一遍分支,迟早有一处漏掉。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkResult(r) {
  if (r.stopReason === 'refusal') {
    const cat = r.stopDetails?.category ? `(类别 ${r.stopDetails.category})` : '';
    return { ok: false, reason: `模型拒答${cat}——换个问法,或者开 fallbacks` };
  }
  if (r.stopReason === 'max_tokens') {
    return {
      ok: false,
      reason: `输出被 max_tokens 截断(现在 ${r.usage.outputTokens} token)。截断的攻略比没有更糟,` +
        '调大 config.json 的 ai.maxTokens 重来',
    };
  }
  if (r.toolErrors.length) {
    const codes = [...new Set(r.toolErrors.map((e) => e.errorCode))].join('、');
    return { ok: false, reason: `联网工具报错(${codes}),这轮的资料是不完整的` };
  }
  if (!r.text.trim()) return { ok: false, reason: '模型没有输出任何正文' };
  return { ok: true, reason: null };
}
