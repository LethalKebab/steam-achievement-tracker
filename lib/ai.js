/**
 * AI 供应商层 —— 公共部分
 * ------------------------------------------------
 * 各家的差异关在各自的文件里(`ai-anthropic.js` / `ai-gemini.js`),这里放它们共用的:
 * 用量记账、估价、会话、SSE 拆包、以及"这一轮结果能不能用"的判定。
 *
 * 加第三家要做的事就是:新写一个文件、实现下面这个接口、在 `createProvider` 里挂上。
 * 这个文件和 `guidegen.js` 都不该因此改动。
 *
 * ## 供应商接口
 *
 * ```
 * name                                 供应商标识
 * model                                当前模型名
 * webTools()                           这家自己的联网工具声明(形状各不相同)
 * buildBody({system, messages, tools}) 组装请求体;--dry 用它在不发送的前提下打印
 * send({system, messages, tools, onEvent}) → {
 *   content        这家原生的消息内容,原样存回会话再发回去
 *   text           抽出来的纯文本正文
 *   stopReason     **统一词汇**,见下
 *   rawStopReason  这家自己的原值,只用来诊断
 *   usage / model / continuations / toolErrors / searchQueries
 * }
 * ```
 *
 * ## 统一的 stopReason 词汇
 *
 * 各家说法不一样(Anthropic 是 `end_turn`/`max_tokens`/`refusal`,Gemini 是
 * `STOP`/`MAX_TOKENS`/`SAFETY`/`RECITATION`),**在供应商边界上就翻译成同一套**,
 * 免得 `checkResult` 和 `guidegen` 里到处写"如果是这家就……"。
 *
 * - `end_turn`   正常写完
 * - `max_tokens` 被截断。**有正文但只有半份**,是最危险的一种
 * - `refusal`    安全策略拒答
 * - `recitation` 因为大段复述受版权保护的内容被拦(目前只有 Gemini 有)
 * - `other`      认不出来。原值在 `rawStopReason` 里,不猜
 */

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
}

/** 认不出来的停止原因一律落到 'other' 并保留原值,不猜 */
export function normalizeStop(map, raw) {
  if (!raw) return null;
  return map[raw] ?? 'other';
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * 逐个吐出 SSE 事件。两家都是 `data:` 行 + 空行分隔,所以这段共用。
 * 一个事件可能被拆在两个 chunk 里,多字节汉字也可能被切开(TextDecoder 的
 * stream 模式负责接回来)。
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
 * **一条消息内**合并 usage:覆盖,不累加。(Anthropic 的字段名)
 *
 * 这是最容易悄悄算错的一处。`message_start` 和 `message_delta` 报的都是"这条消息到目前
 * 为止的累计值"——前者的 `output_tokens` 是个很小的初值,后者那个才是最终值。两个相加会
 * 把输出 token 多算一遍,而多算出来的数没有任何地方会报错,只会让费用显示一直偏高。
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
 * pause_turn 续跑、回灌重写的每一轮都是各自独立的一条消息、各有一份完整 usage,
 * 这时候才该加。"消息内覆盖、跨消息相加"两句话必须都对,错一半就是账不准。
 */
export function addUsage(target, more) {
  if (!more) return target;
  for (const k of Object.keys(target)) target[k] += more[k] ?? 0;
  return target;
}

// ---------------------------------------------------------------------------
// 估价
// ---------------------------------------------------------------------------

/**
 * 每百万 token 的美元单价。cache 写入是输入价的 1.25 倍、读取 0.1 倍。
 *
 * **表里没有的模型一律不估价**,而不是当 0 算——"在花钱这件事上给错数字比不给更糟"。
 * 悄悄显示 $0.00 正是最糟的那种错数字。
 *
 * Gemini 的模型故意不在表里:免费层确实是 0,但付费层的单价没核实过,而这个项目的规矩
 * 是不给没核实的数字。跑在免费层上时看请求数和 token 数就够了——那才是配额的计量单位。
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

/**
 * 只算**模型 token**。搜索工具怎么计费还没实测,所以如实返回次数、不折算成钱——
 * 把一个猜出来的单价混进总额,得到的是看起来精确、实际不知道错多少的数字。
 *
 * @returns {{usd: number|null, priced: boolean, model: string, webSearches: number}}
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
  const cache =
    usage.cacheCreationTokens || usage.cacheReadTokens
      ? `(缓存写 ${usage.cacheCreationTokens} / 读 ${usage.cacheReadTokens})`
      : '';
  const money = cost.priced
    ? `模型花费 $${cost.usd.toFixed(4)}`
    : `无价格表(${model})—— 免费层看请求数和 token 数就够了`;
  return `${usage.requests} 次请求 · 输入 ${usage.inputTokens}${cache},输出 ${usage.outputTokens} · ${money}`;
}

// ---------------------------------------------------------------------------
// 供应商注册
// ---------------------------------------------------------------------------

/**
 * 按 config.ai.provider 建供应商。加一家只动这个函数和一个新文件。
 *
 * 动态 import:没用到的那家不进内存,也不会因为它自己的模块级错误连累另一家。
 */
export async function createProvider(config, opts = {}) {
  const ai = config?.ai ?? {};
  const provider = (ai.provider ?? 'anthropic').toLowerCase();
  if (provider === 'anthropic') {
    const { AnthropicProvider } = await import('./ai-anthropic.js');
    return new AnthropicProvider(ai, opts);
  }
  if (provider === 'gemini' || provider === 'google') {
    const { GeminiProvider } = await import('./ai-gemini.js');
    return new GeminiProvider(ai, opts);
  }
  throw new AiError(`还没接入的供应商:${provider}(目前支持 anthropic、gemini)`);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/**
 * 多轮会话:攒 messages、攒 usage。
 *
 * 回灌重写(校验不过 → 把具体错误发回去 → 最多 3 轮)就是多轮,所以历史必须留着——
 * 而且留着还更便宜:前缀命中缓存。usage 在这里跨消息累加,费用上限那一步直接读
 * `session.usage` 就行,不用再去各处埋点。
 *
 * 消息用中立形状 `{role: 'user'|'assistant', content}`,`content` 要么是字符串、
 * 要么是那一家自己的原生内容。翻译成各家的请求格式是供应商 `buildBody` 的事。
 */
export function createSession(provider, { system = null, tools = null } = {}) {
  const messages = [];
  const usage = emptyUsage();

  return {
    provider,
    messages,
    usage,
    async ask(userText, { onEvent } = {}) {
      messages.push({ role: 'user', content: userText });
      const r = await provider.send({ system, messages, tools, onEvent });
      addUsage(usage, r.usage);
      // 原样存回去(thinking 块也要,同模型续聊必须原样回传)
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

// ---------------------------------------------------------------------------
// 结果判定
// ---------------------------------------------------------------------------

/**
 * 把一轮结果判成"能用 / 不能用",顺带给出人话原因。
 *
 * 单独抽出来是因为**这几种失败都长得像成功**:拒答是 HTTP 200、截断有正文只是被砍了
 * 一半、工具报错也是 200。谁调用谁写一遍分支,迟早有一处漏掉。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkResult(r) {
  if (r.stopReason === 'refusal') {
    const cat = r.stopDetails?.category ? `(类别 ${r.stopDetails.category})` : '';
    return { ok: false, reason: `模型拒答${cat}——换个问法,或者换个模型` };
  }
  if (r.stopReason === 'recitation') {
    // 写攻略是这条的高危场景:我们明确要求原文照抄官方描述,还要它读 wiki
    return {
      ok: false,
      reason:
        '被判为大段复述受版权保护的内容(RECITATION)而中断。这类任务容易撞上——' +
        '可以换一款游戏或换个模型试。注意"官方描述原文照抄"是这个功能的硬要求,' +
        '不能为了绕开这条限制而改掉它',
    };
  }
  if (r.stopReason === 'max_tokens') {
    return {
      ok: false,
      reason:
        `输出被 max_tokens 截断(现在 ${r.usage.outputTokens} token)。` +
        '截断的攻略比没有更糟,调大 config.json 的 ai.maxTokens 重来',
    };
  }
  if (r.stopReason === 'other') {
    return { ok: false, reason: `认不出的停止原因:${r.rawStopReason}` };
  }
  if (r.toolErrors?.length) {
    const codes = [...new Set(r.toolErrors.map((e) => e.errorCode))].join('、');
    return { ok: false, reason: `联网工具报错(${codes}),这轮的资料是不完整的` };
  }
  if (!r.text.trim()) return { ok: false, reason: '模型没有输出任何正文' };
  return { ok: true, reason: null };
}
