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
 * - **server 工具的错误不抛异常**,而是 HTTP 200 + content 里放一个错误对象。而**成功的
 *   形状两个工具并不一样**:web_search 成功是**数组**,web_fetch 成功是**对象**。
 *   别把其中一条当成通用规则 —— 见 `serverToolErrors` 上的表和它踩过的坑。
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

/**
 * 实测认得 `output_config.effort` 的端点。**只列量过的。**
 *
 * 这张表存在的理由,就是它取代的那个推断错在哪:原来用 `!ai.baseUrl` 当判据,
 * 而那个式子问的是"这是不是官方端点",答的却是"这个字段发得发不得"。DeepSeek 的
 * /anthropic 两个答案相反 —— 它不是官方端点,但它认这个字段,而且这是攻略生成
 * 唯一有效的提速旋钮(见构造函数里的实测表)。
 *
 * 加一家之前先拿真端点发一次看是不是 200,别照着"它兼容 Anthropic"推。
 */
const EFFORT_ENDPOINTS = [/^https:\/\/api\.anthropic\.com\b/, /^https:\/\/api\.deepseek\.com\b/];

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
 * 服务端工具的结果块长什么样 —— **两个工具的「成功」形状不一样,这是这里唯一要小心的事**:
 *
 * | 工具 | 成功时 `content` | 出错时 `content` |
 * |---|---|---|
 * | web_search | **数组**(结果列表) | `{type:'web_search_tool_result_error', error_code}` |
 * | web_fetch | **对象** `{type:'web_fetch_result', url, content:{document}}` | `{type:'web_fetch_tool_result_error', error_code}` |
 *
 * **两边的成功形状不一样,所以不能用一个 `Array.isArray` 判两个工具。** 那条规则只对
 * web_search 成立;拿它判 web_fetch,每一次**成功**抓页都会被记成一条错误(错误码正是
 * 成功块自己的 type,`web_fetch_result`),而 `checkResult` 见到任何一条工具错误就判整轮
 * 不可用 —— 抓页成功 == 生成失败。这种错还会**躲到官方端点才炸**:web_fetch 只在那里
 * 默认开启(见 `webTools`),兼容端点上默认关着。
 *
 * 判据一律**正面认成功**,认不出的形状宁可报成一条 `unknown` 错误也不默认放行:
 * 一次"搜索被限流"被读成"搜到了空结果",模型就按空手写攻略,而这类静默降级正是
 * 这个项目最防的东西。为此付的代价由 `checkResult` 的分级兜着 —— 抓页那侧不再枪毙整轮。
 */
const RESULT_KINDS = {
  web_search_tool_result: { tool: 'search', ok: (inner) => Array.isArray(inner) },
  web_fetch_tool_result: { tool: 'fetch', ok: (inner) => inner?.type === 'web_fetch_result' },
};

/**
 * 一个结果块 → `null`(成功 / 不是工具块)或 `{tool, errorCode}`。
 *
 * `serverToolErrors` 和进度事件**共用这一个判断**。它们本来各写了一份,于是同一个 bug
 * 有两份拷贝:上面报"这轮资料不完整",进度条同时把每次成功抓页显示成 `失败(unknown)`。
 */
export function toolResultError(block) {
  const kind = RESULT_KINDS[block?.type];
  if (!kind) return null;
  const inner = block.content;
  if (kind.ok(inner)) return null;
  return { tool: kind.tool, errorCode: inner?.error_code ?? inner?.type ?? 'unknown' };
}

/** 挑出这一轮所有服务端工具的失败。`tool` 用中立词(`search`/`fetch`),不外泄 Anthropic 的块名 */
export function serverToolErrors(content) {
  const out = [];
  for (const b of content ?? []) {
    const err = toolResultError(b);
    if (err) out.push(err);
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
    // 显示名可被覆盖 —— 这一层也用来打 DeepSeek 的 Anthropic 兼容端点,那时候错误里
    // 写"Anthropic API"、让人去查 ANTHROPIC_API_KEY 是把人指到完全错的地方
    this.name = ai.providerName || 'anthropic';
    this.envVar = ai.providerEnvVar || 'ANTHROPIC_API_KEY';
    this.ai = ai;
    this.model = ai.model || 'claude-opus-5';
    this.maxTokens = ai.maxTokens ?? 32000;
    this.maxContinuations = ai.maxContinuations ?? 5;
    this.maxRetries = ai.maxRetries ?? 3;
    this.timeoutMs = ai.requestTimeoutMs ?? 600000;
    // **端点可配置。** 不只是为了代理:实测DeepSeek 的 Anthropic 兼容端点
    // `https://api.deepseek.com/anthropic` 支持**服务端 web_search** —— 声明工具后
    // 回包里有 server_tool_use / web_search_tool_result 块,usage 里有
    // web_search_requests 计数,而同一个模型不给工具时会老实回答"查不到"。
    // 也就是说这一层原封不动就能给 DeepSeek 用上联网,不用另写一套。
    // (注意:DeepSeek **OpenAI 兼容**的 /chat/completions 没有这个能力,见 ai-deepseek.js
    //  —— 同一家、两个端点、能力不同,别把一个的结论套到另一个上。)
    this.baseUrl = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // 打官方端点才发 Anthropic 专有扩展。**这不是一个总开关** —— 见下面几行。
    this.extras = ai.anthropicExtras ?? !ai.baseUrl;

    // -----------------------------------------------------------------------
    // 推理深浅:**和 thinking 分开发,这两件事的命运不一样**
    //
    // **`thinking` / `output_config` / `fallbacks` 必须各自独立,不能捆在 `extras` 上。**
    // `extras` 问的是"这是不是官方端点",那是关于**端点身份**的判断;"这个字段它认不认"
    // 是另一个问题。捆在一起的后果是静默的:`provider: "deepseek"` 预设总会设 baseUrl,
    // 于是 `ai.effort`(config.js 里的「深浅旋钮」,默认 'high')一次都发不出去。
    //
    // 实测:DeepSeek 的 /anthropic,同一段 10 个成就带联网工具:
    //
    //   什么都不发            337 s  思考 145955 字  搜 8 次   ← 之前跑的就是这个
    //   output_config low     43 s  思考  15523 字  搜 2 次
    //   thinking:adaptive
    //     + output_config low  87 s  思考  34150 字  搜 5 次   ← 捆在一起时的样子
    //   thinking:disabled       6 s  思考      0 字  搜 **0** 次
    //
    // 两条结论。**adaptive 会把 effort 顶掉** —— 同一个 effort:low,多发一个 adaptive
    // 思考量翻倍、提速砍半;所以它们必须能分开发。而 **thinking:disabled 会把联网搜索
    // 一起关掉**(跑了两次,都是 0 次),那正是 `canSearch` 那套准入设计要防的
    // "凭记忆写攻略",所以它不是一个该被推荐的档位 —— 留着能配,但别当成"更快的 high"。
    //
    // **"这个端点认不认 output_config"是逐个端点量出来的事实,不是能从 baseUrl 推的。**
    // 所以走一张只列实测过的表(EFFORT_ENDPOINTS),没量过的一律不发 —— 那些端点
    // 今天就没在收这个字段,给它们新发一个可能被拒的参数是拿别人的可用性换我们的速度。
    // 两个出口都留着:自建端点确实认,写 anthropicExtras: true;哪儿都不想发,写 effort: 'off'
    const effortOk = this.extras || EFFORT_ENDPOINTS.some((re) => re.test(this.baseUrl));
    this.effort = effortOk && ai.effort && ai.effort !== 'off' ? ai.effort : null;
    // 'adaptive' | 'disabled' | 'off'(不发这个字段)。默认只在官方端点发 adaptive ——
    // 那里省略 thinking 在 4.8/4.7 上等于**不思考**,而 model 是可配置的,
    // 所以显式比"靠默认值恰好对"可靠。兼容端点上默认不发,因为发了会顶掉 effort。
    //
    // 关掉用 `'off'` 而不是 `null`:`null ?? 默认值` 会落回默认值,于是"我不要这个字段"
    // 和"我没写"在配置里根本表达不出区别 —— 和 effort 用同一个词,免得两个旋钮两套写法
    const t = ai.thinking ?? (this.extras ? 'adaptive' : 'off');
    this.thinking = t === 'off' ? null : t;
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
    // 搜索工具版本可配置:兼容端点可能只认老版本
    const search = { type: ai.searchTool || WEB_SEARCH_TOOL, name: 'web_search' };
    if (ai.maxSearches > 0) search.max_uses = ai.maxSearches;
    if (ai.allowedDomains?.length) search.allowed_domains = ai.allowedDomains;

    // **web_fetch 不是每个端点都有。** 实测 DeepSeek 的 /anthropic 只认 web_search
    // (400 原文:expected `web_search_20250305` or `web_search_20260209`),
    // 声明 web_fetch 会让整个请求挂掉。所以默认只在官方端点带它。
    // 代价是兼容端点只能拿搜索结果摘要、抓不到整页正文,攻略质量低一档 ——
    // 但这个差别在 ai-check 的输出里看得见,不是悄悄发生的
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
    // Opus 5 的分类器可能直接拒答(HTTP 200 + refusal)。fallbacks 是**选择加入**的:
    // 开了则由服务端换一个模型重跑同一个请求。
    if (this.extras && this.ai.fallbacks !== false) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return h;
  }

  /** 组装请求体。单独抽出来是为了 `--dry` 能在不发请求的前提下打出来看 */
  buildBody({ system, messages, tools }) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      stream: true,
    };
    if (system) {
      // 最后一块打 cache_control:回灌重写要重发同一份规则和成就清单,命中缓存按 0.1 倍计费
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (tools?.length) body.tools = tools;

    // **三个字段各自决定发不发,不再共用一个开关** —— 理由和实测数据见构造函数里
    // `this.effort` 上面那段。捆在一起时,唯一真正管用的那个旋钮(effort)被
    // 另外两个的准入条件挡住了,而且和 thinking 同时发还会被它顶掉。
    //
    // 兼容端点多发一个它不认的字段就是整个请求 400,而那类报错通常只说"字段无效",
    // 指不到"你在拿官方专有参数打第三方端点"这个真因上 —— 所以 errorFromResponse
    // 对这两个字段各留了一句提示。
    if (this.thinking) {
      // **绝不带 budget_tokens。** 官方端点上是 400;而 DeepSeek 的 /anthropic 更糟 ——
      // 它返回 200 然后**朝反方向走**:实测要 2000 得到 49653 字思考、要 8000 得到 62107 字,
      // 都比不发这个字段时的 38196 字还多。一个"设了上限反而更慢"的参数,没有任何东西会报错
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
    } else if (RESULT_KINDS[b.type]) {
      // 成功/失败的判断走 toolResultError,和 serverToolErrors 同一份 —— 各写一份的后果见那里
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
 * 非 200 响应 → AiError。
 *
 * 错误体是 `{type:'error', error:{type,message}, request_id}`。request_id 要带上:
 * 报障时那是唯一能定位这次请求的东西。**响应头和请求头一个都不带**——里面有 x-api-key。
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
    // 400 里最容易踩的是 beta 头。出这个错的人手上没有别的线索能猜到关掉哪个开关
    hint = '\n  (像是 fallbacks 的 beta 头不被接受:在 config.json 里设 "ai": { "fallbacks": false } 关掉再试)';
  } else if (res.status === 400 && /unknown variant|web_fetch|web_search/i.test(detail)) {
    // 兼容端点常见:只实现了一部分工具。报错原文一般会直接列出它认哪些,照着配就行。
    // 实测 DeepSeek 的 /anthropic 只认 web_search,声明 web_fetch 会让整个请求 400
    hint =
      '\n  (这个端点不认某个工具声明——上面的 message 通常会列出它接受哪些。\n' +
      '   常见修法:config.json 里设 "webFetch": false(只用搜索,不抓整页正文),\n' +
      '   或者 "searchTool": "web_search_20250305" 换成老版本的搜索工具)';
  } else if (res.status === 400 && /output_config|effort|thinking/i.test(detail)) {
    // 这两个字段现在会发到 EFFORT_ENDPOINTS 里的端点和显式开了 anthropicExtras 的自建端点。
    // 撞上这个 400 的人手上没有别的线索能猜到该关哪个 —— 尤其 effort 的默认值来自
    // 一张端点表,不是他自己写进 config 的
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
