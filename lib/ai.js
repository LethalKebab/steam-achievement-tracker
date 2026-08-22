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
 * canSearch                            **有没有服务端联网搜索**。见下
 * webTools()                           这家自己的联网工具声明(形状各不相同)
 * buildBody({system, messages, tools}) 组装请求体;--dry 用它在不发送的前提下打印
 * send({system, messages, tools, onEvent}) → {
 *   content        这家原生的消息内容,原样存回会话再发回去
 *   text           抽出来的纯文本正文
 *   stopReason     **统一词汇**,见下
 *   rawStopReason  这家自己的原值,只用来诊断
 *   usage / model / continuations / searchQueries
 *   toolErrors     `[{tool, errorCode}]`。`tool` 也是**统一词汇**:`search` / `fetch`,
 *                  不外泄各家的块名 —— 因为两者的严重程度不同,见 `checkResult`
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
 *
 * ## canSearch
 *
 * 设计文档把「有服务端搜索」定成硬性准入,理由是"混进一家没有搜索的,会让质量取决于
 * 用户选了谁,而用户看不出这个差别"。所以这件事不能靠人记住,得是个供应商自己声明、
 * 上层能读到的属性:
 *
 * - `guide-gen` 对 `canSearch === false` 的供应商**默认拒绝生成**,要显式 `--no-research`
 * - 提示词换成"你没有联网能力,不确定的一律别写"那一版
 * - 结果里明写这份攻略没经过任何调研
 *
 * 于是"这次没联网"是藏不住的,而不是一个用户看不出来的质量差别。
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
 * 给 CLI / 进度条用的一行摘要。
 *
 * **只报 token,不报钱,而且不要把估价加回来。** 各家单价会变、我们没有一份核实得
 * 过来的表,搜索工具怎么计费更是从头到尾没实测过。**一个不知道错多少的金额,比不给
 * 金额更糟**;而"这个模型没有价格表"这种话对用户既不是信息也不是选择。
 *
 * token 数留着,因为它跟估算不是一回事 —— 那是 API 自己回的硬数字,也是拿去和
 * 供应商账单对照时唯一对得上的东西。
 */
export function formatUsage(usage) {
  const cache =
    usage.cacheCreationTokens || usage.cacheReadTokens
      ? `(缓存写 ${usage.cacheCreationTokens} / 读 ${usage.cacheReadTokens})`
      : '';
  const search = usage.webSearches ? ` · 联网搜索 ${usage.webSearches} 次` : '';
  return `${usage.requests} 次请求 · 输入 ${usage.inputTokens}${cache},输出 ${usage.outputTokens}${search}`;
}

// ---------------------------------------------------------------------------
// 供应商注册
// ---------------------------------------------------------------------------

/**
 * 模型名前缀 → 它属于哪一家。只列**确定**的,认不出来的不猜(别名、自建端点、
 * 代理服务的模型名可以是任意形状)。
 */
/** DeepSeek 的 Anthropic 兼容端点 —— 有服务端 web_search 的那个 */
const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

const MODEL_FAMILY = [
  { re: /^claude-/i, provider: 'anthropic' },
  { re: /^(gemini|gemma|nano-banana|lyria|deep-research|antigravity)/i, provider: 'gemini' },
  { re: /^deepseek-/i, provider: 'deepseek' },
];

/**
 * 供应商和模型对不对得上。
 *
 * **只拦"这个模型明确属于另一家"这一种情况**,不认识的名字一律放行 —— 那可能是别名或者
 * 自建端点。而跨家不匹配一定是配错了,没有例外。
 *
 * 值得单独拦是因为不拦的话报出来的是供应商那边的 404("模型名可能不对"),
 * 而真正的原因是 provider 和 model 只改了一半 —— 那个 404 完全指不到这个方向。
 * 实测踩过:config.json 写着 deepseek,环境变量 AI_PROVIDER 还留着 gemini,
 * 于是拿 gemini 的端点去请求 deepseek-chat。
 */
export function assertModelMatchesProvider(provider, model, { baseUrl = '' } = {}) {
  if (!model) return;
  // 自定义端点上模型名可以是任何形状 —— 比如 provider=anthropic 指向
  // DeepSeek 的 Anthropic 兼容端点时,模型就叫 deepseek-v4-flash。
  // 这时候前缀检查只会误报,直接不查
  if (baseUrl) return;
  const hit = MODEL_FAMILY.find((f) => f.re.test(model));
  if (!hit || hit.provider === provider) return;
  // **正文只说"配错在哪"**,不写命令行 —— 这句话会原样出现在 Dashboard 上,
  // 而那边改这两项的入口是设置页。终端专属的排查步骤(尤其"环境变量会盖掉配置文件"
  // 那条,只有终端里才可能踩)由 tracker.js 接住 `provider-model-mismatch` 自己补
  const err = new AiError(
    `供应商选的是 ${provider},模型名 "${model}" 却是 ${hit.provider} 的 —— ` +
      '多半是只改了其中一项。去设置页把两者对齐。'
  );
  err.code = 'provider-model-mismatch';
  err.detail = { provider, model, belongsTo: hit.provider };
  throw err;
}

/**
 * 按 config.ai.provider 建供应商。加一家只动这个函数和一个新文件。
 *
 * 动态 import:没用到的那家不进内存,也不会因为它自己的模块级错误连累另一家。
 */
export async function createProvider(config, opts = {}) {
  const ai = config?.ai ?? {};
  const provider = (ai.provider ?? 'anthropic').toLowerCase() === 'google'
    ? 'gemini'
    : (ai.provider ?? 'anthropic').toLowerCase();
  assertModelMatchesProvider(provider, ai.model, { baseUrl: ai.baseUrl });
  if (provider === 'anthropic') {
    const { AnthropicProvider } = await import('./ai-anthropic.js');
    return new AnthropicProvider(ai, opts);
  }
  if (provider === 'gemini') {
    const { GeminiProvider } = await import('./ai-gemini.js');
    return new GeminiProvider(ai, opts);
  }
  // **DeepSeek 有两个端点,能力不一样,默认必须给好的那个。**
  //
  //   /anthropic          Anthropic 兼容 —— **有服务端 web_search**
  //   /chat/completions   OpenAI 兼容   —— 没有搜索
  //
  // 用户写 `provider: "deepseek"` 想要的显然是"能用的那个 DeepSeek",所以这里直接
  // 装配成前者。在这之前,好路径要写成 `provider: "anthropic"` + 一个 DeepSeek 的 URL,
  // 看起来像配错了;而直觉上的写法反而给的是没有联网的差路径 —— 好路径不该藏在
  // 反直觉的配置后面。
  if (provider === 'deepseek') {
    const { AnthropicProvider } = await import('./ai-anthropic.js');
    const p = new AnthropicProvider(
      {
        ...ai,
        // 用户显式配了就用他的。注意不能靠展开顺序 —— ai.model 可能是空字符串,
        // 那样会让 AnthropicProvider 退回 claude-opus-5
        baseUrl: ai.baseUrl || DEEPSEEK_ANTHROPIC_BASE,
        model: ai.model || DEEPSEEK_DEFAULT_MODEL,
        // 报错里要说对是哪一家、该查哪个环境变量 —— 否则用户会看到
        // "Anthropic API HTTP 401,检查 ANTHROPIC_API_KEY",而他配的是 DeepSeek
        providerName: 'deepseek',
        providerEnvVar: 'DEEPSEEK_API_KEY',
      },
      opts
    );
    return p;
  }
  // OpenAI 兼容的那个端点。**没有联网搜索**,留着是因为它是很多服务(本地模型、
  // 各种代理)的通用形状,而且它是 canSearch=false 那条闸门唯一的真实用例
  if (provider === 'deepseek-openai') {
    const { DeepseekProvider } = await import('./ai-deepseek.js');
    return new DeepseekProvider(ai, opts);
  }
  throw new AiError(
    `还没接入的供应商:${provider}\n` +
      '  可选:anthropic、gemini、deepseek(都有联网搜索)、deepseek-openai(没有联网搜索)'
  );
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
    /**
     * 把最近一轮(user + 它引出的 assistant)从历史里摘掉,当它没发生过。
     *
     * **只有一种用法:这一轮的结果不能用,而调用方要在同一个 session 上重问。**
     * 不摘掉的话那半份废稿会一直躺在上下文里,而重问的提示词多半会说"别重复
     * 前面写过的" —— 于是模型绕开它已经写了一半的那部分,**产出看着正常但是缺东西**。
     * 这比直接失败糟得多:失败会报出来,缺东西不会。
     *
     * `ask` 是先 push user、拿到回复再 push assistant,所以失败可能停在两种形状上
     * (发请求就炸了 = 只有 user;回复不可用 = 两条都在)。按角色从尾部摘,两种都对。
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
// 结果判定
// ---------------------------------------------------------------------------

const uniqueCodes = (errs) => [...new Set(errs.map((e) => e.errorCode))].join('、');

/**
 * 把一轮结果判成"能用 / 不能用",顺带给出人话原因,外加一串**不拦路但要说出来**的警告。
 *
 * 单独抽出来是因为**这几种失败都长得像成功**:拒答是 HTTP 200、截断有正文只是被砍了
 * 一半、工具报错也是 200。谁调用谁写一遍分支,迟早有一处漏掉。
 *
 * **联网工具的失败要分两档,一刀切两个方向都错:**
 *
 * - **搜索失败 ⇒ 整轮不可用。** 搜索是研究的入口,它没成,模型就是凭记忆在写 ——
 *   正是 `canSearch` 那套准入设计要防的、用户看不出来的质量差别。
 * - **抓页失败 ⇒ 只报,不枪毙。** web_fetch 是**逐个 URL** 的:`url_not_allowed`
 *   (它只能抓已经出现在对话里的 URL,模型自己拼一个就是这个码)和 `url_not_accessible`
 *   (404 / 反爬 / 超时,中文攻略站尤其常见)在一次正常的研究里几乎必然出现几条。
 *   搜了十个页面、抓失败两个,资料是够的;为此作废整轮是把常态当故障 ——
 *   而作废的代价是用户已经付过的那几分钟和那笔 token。
 *
 * 认不出 `tool` 的错误按**拦路**处理:新供应商接进来时,宁可多拦一次也不要默认放行。
 *
 * @returns {{ok: boolean, reason: string|null, warnings: string[]}}
 */
export function checkResult(r) {
  const toolErrors = r.toolErrors ?? [];
  const fetchErrs = toolErrors.filter((e) => e.tool === 'fetch');
  const warnings = fetchErrs.length
    ? [`${fetchErrs.length} 次抓页失败(${uniqueCodes(fetchErrs)})——这几页只能靠搜索摘要写`]
    : [];
  // 失败也带上 warnings:形状恒定,调用方不用记"什么时候有这个字段"。
  // **`code` 是给程序看的,`reason` 是给人看的** —— 调用方要分辨"这种失败我能补救吗"
  // (只有截断能:切小再问)。靠 reason 的文字去匹配等于把一句人话变成接口,
  // 改个措辞就悄悄失灵
  const bad = (code, reason) => ({ ok: false, code, reason, warnings });

  if (r.stopReason === 'refusal') {
    const cat = r.stopDetails?.category ? `(类别 ${r.stopDetails.category})` : '';
    return bad('refusal', `模型拒答${cat}——换个问法,或者换个模型`);
  }
  if (r.stopReason === 'recitation') {
    // 写攻略是这条的高危场景:我们明确要求原文照抄官方描述,还要它读 wiki
    return bad(
      'recitation',
      '被判为大段复述受版权保护的内容(RECITATION)而中断。这类任务容易撞上——' +
        '可以换一款游戏或换个模型试。注意"官方描述原文照抄"是这个功能的硬要求,' +
        '不能为了绕开这条限制而改掉它'
    );
  }
  if (r.stopReason === 'max_tokens') {
    // **这个数是用量,不是上限,措辞必须说清楚。** 它原来写作"现在 N token"、
    // 后面跟一句"调大 ai.maxTokens" —— 读起来就是"上限是 N",而 N 其实是
    // `addUsage` 跨 pause_turn 续跑**累加**出来的整轮产出,可以远大于单次请求的
    // max_tokens。实测撞到过 61445,而当时的上限是 32000:照那句话去调,基准就错了。
    // 而且 max_tokens 管的是 thinking + 正文,调大多半被思考吃掉(CLAUDE.md 有实测),
    // 所以这里只陈述事实,不再给那条建议 —— 该怎么补救是调用方的事(guidegen 会切小重问)
    return bad(
      'max_tokens',
      `模型这一段没写完就被输出上限截断了(本轮已产出 ${r.usage.outputTokens} token,` +
        '这是用量不是上限)'
    );
  }
  if (r.stopReason === 'other') {
    return bad('other', `认不出的停止原因:${r.rawStopReason}`);
  }
  const hardErrs = toolErrors.filter((e) => e.tool !== 'fetch');
  if (hardErrs.length) {
    return bad('tool-error', `联网工具报错(${uniqueCodes(hardErrs)}),这轮的资料是不完整的`);
  }
  const leaked = leakedControlToken(r.text);
  if (leaked) {
    // **供应商把自己的内部控制符吐进了正文。** 停止原因正常、正文非空、工具没报错 ——
    // 三样表面全对,所以在这之前一个分支都拦不住它,而正文其实是从那个位置**断掉**的。
    //
    // 实测(KINGDOM HEARTS,DeepSeek):第 173 个成就写到一半变成
    // `**The Warrior: Ventus</｜｜DSML｜｜parameter>` 然后 `</｜｜DSML｜｜invoke>`、
    // `</｜｜DSML｜｜tool_calls>`,输出到此为止,后面 10 个成就再没写。三轮都断在同一处。
    //
    // **不能只把这几行删掉接着用。** 正文是断的,删了标记只会得到一份看起来完整、
    // 实际少了一截的攻略 —— 而那正是这个项目最防的失败方式:失败会报出来,少东西不会。
    // 所以整轮判死,交给 guidegen 的重试阶梯(原样重问 → 切小 → 记下来接着跑)。
    return bad('control-token', `模型把内部控制符写进了正文(${leaked}),这一轮的正文是断的`);
  }
  if (!r.text.trim()) {
    // **"没有正文"这句话本身没有诊断价值,必须带上"那到底回来了什么"。**
    //
    // 这是这条路上最难查的一种失败:HTTP 200、没有工具报错、停止原因也正常,
    // 就是一个 text 块都没有。而这三条事实各指向完全不同的处置:
    //   thinking×1 + 几万 token  ⇒ 额度被思考吃光了,和截断是一回事(该切小)
    //   什么都没有 + 0 token     ⇒ 这一次抽风(原样再问一遍就好)
    //   有 server_tool_use 没 text ⇒ 模型光搜没写
    // 少了这几个数字,下一次撞上还是只能猜 —— 而这条路上的每一次猜都要花掉用户
    // 几分钟和一笔 token 才能验一遍。实测撞到过三次(最近一次 KINGDOM HEARTS,
    // 197 个成就第 3/4 段),每次都是拿一句话去反推
    return bad(
      'empty',
      `模型没有输出任何正文(停止原因 ${r.rawStopReason ?? '未知'}、` +
        `产出 ${r.usage?.outputTokens ?? 0} token、回包里 ${describeBlocks(r.content)})`
    );
  }
  return { ok: true, code: null, reason: null, warnings };
}

/**
 * 各家模型的内部控制符。**判据必须是「markdown 正文里绝不可能出现」**,
 * 因为误判一次就是白花一轮的钱,而攻略正文里合法地带着 `<br>`、`<details>`、
 * `<summary>`、`<table>`、`<span underline="true">` 这些真 HTML。
 *
 * 所以这里只认两类不可能撞车的形状:
 *
 * 1. **尖括号里出现全角竖线 `｜`(U+FF5C)** —— DeepSeek 那一家的记号
 *    (`<｜tool▁calls▁begin｜>`、`</｜｜DSML｜｜invoke>`)。全角竖线在中文正文里
 *    本来就极罕见,再要求它出现在尖括号里,基本不可能是真内容。
 * 2. **`<|…|>`** —— Llama / OpenAI 那一系(`<|im_start|>`、`<|eot_id|>`)。
 *    `<|` 不是任何合法 HTML 的开头。
 * 3. **几个成对的工具调用标签的闭合形式** —— 只认闭合式(`</invoke>`),
 *    因为开标签形式(`<parameter …>`)和正文里的 HTML 长得更像,不值得冒这个险。
 *
 * 故意**不**认 `<function_calls>` 之类的开标签、也不做模糊匹配:这个函数的错判
 * 方向是有代价的,宁可漏掉一种没见过的写法(下次它会在缺 checkbox 上暴露),
 * 也不要让一份正常的攻略卡在一条谁也看不懂的错误上。
 */
const CONTROL_TOKEN_RES = [
  [/<[^>\n]{0,60}｜[^>\n]{0,60}>/, '全角竖线记号'],
  [/<\|[^|>\n]{0,60}\|>/, '<|…|> 记号'],
  [/<\/(invoke|function_calls|tool_calls|parameter|antml:\w+)>/i, '工具调用闭合标签'],
];

/** 正文里有没有混进控制符。返回撞上的那一条的描述,没有就返回 null */
export function leakedControlToken(text) {
  const s = String(text ?? '');
  for (const [re, label] of CONTROL_TOKEN_RES) {
    const m = s.match(re);
    if (m) return `${label}:${m[0].slice(0, 40)}`;
  }
  return null;
}

/**
 * 回包里各类块各有几个。**`text` 一个都没有这件事本身就是要报的现象**,
 * 所以这里数的是全部块型,不是只挑认识的那几个。
 */
function describeBlocks(content) {
  const tally = new Map();
  for (const b of content ?? []) {
    const t = b?.type ?? 'unknown';
    tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  if (!tally.size) return '一个块都没有';
  return [...tally].map(([t, n]) => `${t}×${n}`).join('、');
}

// ---------------------------------------------------------------------------
// 花费上限
// ---------------------------------------------------------------------------

