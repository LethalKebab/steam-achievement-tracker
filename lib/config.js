/**
 * 配置读写
 * ------------------------------------------------
 * 敏感信息存在项目根目录的 config.json 里(已在 .gitignore),不写进源码。
 * 环境变量优先级更高,方便临时覆盖:STEAM_API_KEY / STEAM_ID / NOTION_TOKEN。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ROOT 是"代码在哪",始终跟着当前运行的这份文件(源码目录或打包后的 resources/tracker)——
// Dashboard.html / Setup.html / lib/rpc.js 必须继续从这里读,换成别处等于跑着一份代码、
// 展示着另一份代码。DATA_ROOT 是"数据在哪",默认等于 ROOT,但可以用 TRACKER_DATA_DIR
// 单独重定向——launcher 用它把打包版指回已有的 CLI 安装,而不是让打包文件夹自己长出
// 一份新数据。只有 launcher/local.config.json 这种不进仓库的本机专属配置会设这个变量,
// 分发给别人的包永远不设,拿到的行为和没有这个变量时完全一样。
export const DATA_ROOT = process.env.TRACKER_DATA_DIR ? resolve(process.env.TRACKER_DATA_DIR) : ROOT;
export const CONFIG_PATH = join(DATA_ROOT, 'config.json');

const DEFAULTS = {
  steamApiKey: '',
  steamId: '',
  // 语言:影响 Steam 返回的游戏名和成就名
  language: 'schinese',
  port: 8777,
  // serve 启动时数据超过这个小时数就自动后台同步一次(设 0 表示从不自动同步)
  syncStaleHours: 12,
  // serve 启动时顺带发现一次新攻略页(Notion + 本地 guides/)。设 false 关掉
  syncGuidesOnServe: true,
  // serve 启动和「立即同步」跑完之后,顺带把这轮变化涉及的游戏做一次 checkbox 勾选。
  // 这是唯一一处**不经 --dry-run 就往 Notion 写**的地方,所以留了开关:
  // 觉得勾错了就设 false,回到"只有手动跑 checkbox-sync 才写"。
  checkboxSyncOnServe: true,
  // 自动勾选是否联动嵌套子步骤。默认关,和 CLI 的默认(开)不一样,是故意的:
  // 联动是全项目唯一"宁可多勾"的地方,对"任意一个即可"型成就会勾错,
  // 而自动路径没有 --dry-run 这道人工闸门。要子步骤就手动跑 checkbox-sync。
  checkboxSyncOnServeCascade: false,
  // serve 启动和「立即同步」跑完之后,把已经打满的游戏的 Notion 攻略页标成 Done。
  // 按**当前状态**收敛,不是抓"刚好这一轮打满"的瞬间——那个瞬间只存在一次,
  // 错过就补不回来了。设 false 关掉。
  guideStatusOnServe: true,
  // 每次 Steam API 调用之间的间隔,防限流。被限流(429)多的话往上调
  requestDelayMs: 300,
  // --- 打开 Dashboard 时那次自动同步的取样(CLI 的 `sync` 不受影响,那个永远全量)---
  // 每次自动同步顺带复查多少款"没玩过但也该确认一下"的游戏。0 = 关掉轮换扫描
  // (关掉的话,开发者给游戏加了新成就就只能等你下次玩它才会发现)
  sweepBudget: 40,
  // 一款游戏最多多久没跟 Steam 对过账。超过就排进轮换扫描队列
  maxStatsAgeDays: 7,
  // 完美游戏(100%)用更短的:成就总数变多会让它掉出 100%,这个最想早点知道
  perfectGameMaxAgeDays: 3,
  dbPath: 'data/steam.db',
  guidesDir: 'guides',
  notion: {
    token: '',
    // 存放攻略页面的 Notion 数据库 ID(打开那个数据库,URL 里 32 位十六进制那段)
    overviewDbId: '',
  },
  // --- AI 攻略生成(见 docs/ai-guide-writing.md)。不用这个功能就一个字都不用填 ---
  ai: {
    // 'anthropic' | 'gemini' | 'deepseek'
    //   anthropic / gemini —— 有服务端联网搜索,能写出经过调研的攻略
    //   deepseek —— **没有联网**,只适合验证流水线本身,guide-gen 默认拒绝用它生成
    provider: 'anthropic',
    // **每家一套自己的 apiKey / model / baseUrl。**
    //
    //   "providers": {
    //     "anthropic": { "apiKey": "sk-ant-…", "model": "claude-opus-5" },
    //     "gemini":    { "apiKey": "AIza…",    "model": "" },
    //     "deepseek":  { "apiKey": "sk-…",     "model": "", "baseUrl": "" }
    //   }
    //
    // 供应商有三家而这三个字段原来各只有一个位子,于是"换一家试试"没有安全的写法:
    // 设置页每次都得重新粘一遍 key,而命令行的 `--provider` 连拒绝都没有 —— 它翻了
    // provider、留着上一家的 key 就发出去,换来一句「检查 ANTHROPIC_API_KEY」,而那个
    // 变量明明是对的。**一条指向反方向的报错比没有报错更费时间。**
    //
    // **进这里的字段是量出来的,不是拍的:被不止一家读、且各家的正确值不同。** 只有这
    // 三个符合。`maxTokens` / `effort` / `chunkSize` 这些是跨家预算(同一个值在哪家都
    // 对),留在外层;`geminiTools` / `webFetch` / `searchTool` / `anthropicExtras`
    // 这些只有一家会读,留着上一家的值只会被忽略、不会被误用,也留在外层。
    //
    // 别名收敛:google → gemini,deepseek-openai → deepseek(同一家的另一个端点,
    // 同一套配置)。取值顺序见 resolveAiKey
    providers: {},
    // **legacy 的扁平槽位,只属于上面那个 `provider`。** 老配置里它装的必然是当时那家
    // 的值,所以给那一家兜底是对的;问别家要时**不兜底** —— 兜底就是上面说的那个 bug。
    // 新配置写 `providers` 就行,这两个字段留着是为了老配置一个字都不用改
    //
    // 环境变量 ANTHROPIC_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY 也能填,
    // **按被问的那一家取**,而且压过文件里的两处
    apiKey: '',
    // **默认留空,让各家用各自的默认模型。** 这里不能填一个具体名字:模型名是
    // 供应商专属的(claude-* / gemini-* / deepseek-*),填了 anthropic 的名字就意味着
    // 换 provider 却没顺手改 model 的人一定会撞上"供应商和模型对不上"。
    // 想固定某个版本再填,不确定有哪些可用就跑 `node tracker.js ai-check --models`
    model: '',
    // **深浅旋钮,也是这条路上唯一真正管用的提速手段。** 'low' | 'medium' | 'high' | 'off'
    //
    // **它必须和 `thinking` 分开发。** 捆在 `anthropicExtras` 上就是个死旋钮:那个开关
    // 在设了 baseUrl 时恒为 false,而 `provider: "deepseek"` 预设总会设 baseUrl。
    //
    // 实测(DeepSeek /anthropic,同一段 10 个成就,带联网工具):
    //
    //   什么都不发   337 s  搜 8 次  255 字/成就   ← 发不出去时跑的就是这个
    //   high         (没单测,官方端点上是原来的默认)
    //   medium       219 s  搜 6 次  275 字/成就
    //   low           43 s  搜 2 次  211 字/成就
    //
    // **思考量、搜索次数、每成就字数三者同向移动** —— 这是一根旋钮,不是三根。
    // 调低换来的研究深度损失是看得见的:`searchQueries` 每次生成都会打在 CLI 和
    // Dashboard 上("能搜 ≠ 搜了")。所以这不是静默降级,是一个你能读到数字的取舍。
    //
    // **绝对数字别当准。** 同样 10 个成就,不发这个字段时跑三次是 76 / 174 / 337 秒 ——
    // 方差比档位之间的差还大。可信的是同一批背靠背跑出来的**比值**。
    //
    // 发不发看端点认不认,走 ai-anthropic.js 里那张实测表;那里没有的端点默认不发。
    effort: 'high',
    // thinking 字段:'adaptive' | 'disabled' | 'off'(不发)。默认只在官方端点发 adaptive。
    //
    // **'disabled' 快得离谱(6 秒对 337 秒),但它会把联网搜索一起关掉** —— 实测两次都是
    // 搜 0 次,也就是模型凭记忆写攻略,正是 canSearch 那套准入设计要防的东西。
    // 它留在这儿是为了能配,不是一个"更快的 high"。要快请调 effort。
    //
    // 也**永远不要指望 budget_tokens**:DeepSeek 的 /anthropic 收下它返回 200,然后
    // 朝反方向走(要 2000 得到 49653 字思考,要 8000 得到 62107 字,都比不发还多)。
    // 所以 buildBody 一律不发它
    thinking: null,
    // thinking + 正文的**总**上限,不是正文上限。给不够会写到一半被截断,
    // 而截断的攻略比生成失败更糟(校验器发现不了"后半段根本没写")
    maxTokens: 32000,
    // 超过这么多成就就拒绝生成。**这个上限管的是"跑多久、花多少",不是"技术上写不
    // 出来"** —— 超过一段的会自动分段写(guidegen.js 的 chunkDefs)。
    // 库里成就最多的一款是 408 个,500 留了点余量
    maxAchievements: 500,
    // 每段**最多**写多少个成就。切分的理由不是清单装不下(清单很小),是**正文写不了
    // 那么长**:一个成就三段式约 150 字,400 个就是六万字,超过任何一家的单次输出上限。
    // 而超了不会报错 —— 校验器只会说"后半段的成就都缺 checkbox"
    //
    // 是上限不是定长:程序先按这个数算出要几段,再把成就**均摊**到这几段上
    // (55 个成就配 50 是 28+27,不是 50+5)。所以调小它是在调小"单段正文的上限",
    // 段数只会按需增加。见 guidegen.js 的 chunkDefs
    chunkSize: 50,
    // 校验不过时最多回灌重写几轮。还不过就留成草稿,报告哪几条没过——
    // 丢弃等于烧掉钱和时间还什么都不剩,而"哪条没过"本身有信息量
    maxRounds: 3,
    // **第一轮同时写几段。** 各段内容互不相交,没有先后依赖 —— 会排队只可能是因为
    // 全篇共用了一个会话(一个会话就是一条链)。每段一条链,四段游戏的第一轮就从
    // "四段之和"变成"最慢那一段"。
    //
    // 只对第一轮生效。之后的重写轮是定点重问,通常只有一两段,而且切小过的段
    // 和它的母段共用会话 —— 并发会让两个请求同时写同一条 messages。收益小、
    // 失败方式脏,所以那几轮照旧顺序跑(见 guidegen.js 里那段注释)。
    //
    // 3 是保守的。往上调主要吃供应商的限流额度,撞 429 会走 maxRetries 那条退避路,
    // 不会丢段。设 1 就完全退回原来的顺序行为,排查问题时有用
    concurrency: 3,
    // **一次请求里最多搜几次。** 这是攻略深度的头号约束:实测 6 次搜 51 个成就
    // (8.5 个成就摊一次)出来的攻略每条只有几十字心得,难的成就完全没写透。
    // 生成攻略是"多搜比少搜值"的场景 —— 一次搜索比一段编出来的话便宜得多
    //
    // **不要在这里加金额上限。** 各家单价会变、我们核实不过来,而搜索工具怎么计费
    // 根本没实测 —— 任何"上限"都会建立在一个我们自己都不信的金额上,给用户几个他
    // 没法判断该填多少的旋钮,只是把不确定性转嫁过去。真要控制开销,
    // maxSearches / maxTokens / maxRounds 本来就在管用,而且它们量的是实打实的东西。
    maxSearches: 30,
    maxFetches: 10,
    // 单页抓回来最多多少 token。SKILL.md 8.3 那种大 wiki 页要往上调,
    // 但上限多少还没实测过(spike 三条待验之一)
    maxFetchTokens: 50000,
    // 非空 = **硬限制**搜索只能出现这些域名。默认空:中文攻略站的实际索引覆盖率
    // 还没量过,先锁死等于拿没验证的假设换质量。要偏向中文站先在提示词里说
    allowedDomains: [],
    // pause_turn 续跑上限(服务端工具循环撞到迭代上限时会发生)
    maxContinuations: 5,
    maxRetries: 3,
    // 高 effort + 联网研究,单次请求跑几分钟是常态,别按普通 HTTP 超时设
    requestTimeoutMs: 600000,
    // 被安全分类器拒答时,让服务端换个模型重跑同一个请求。要多带一个 beta 头,
    // 万一账号不认那个头会整个请求 400——报错里会提示关掉这个开关
    fallbacks: true,
    // 把思考摘要也流出来。调试"模型安静了四分钟"的时候有用,平时不用开
    showThinking: false,

    // --- 下面几条只对 gemini 生效 ---
    // 联网工具的声明名。做成可配置是因为这一家是在拿不到官方文档的情况下接的:
    // 工具改名、或者免费层不给用,改这里就行,不用改代码。
    // 想要"抓整页正文"(相当于 Anthropic 的 web_fetch)就加上 'url_context',
    // 但多声明一个没把握的工具会让请求整个 400,先跑通再加
    geminiTools: ['google_search'],
    // 思考预算。**不设就完全不发这个字段**,让模型用自己的默认值——
    // 发一个可能不被接受的字段,比不发更容易出错
    geminiThinkingBudget: null,
  },
};

/** 深合并:只合并普通对象,数组/标量直接覆盖 */
// ---------------------------------------------------------------------------
// AI 的 key:一家一个槽位
// ---------------------------------------------------------------------------

/** 每家的环境变量名。**这张表是按被问的那一家查的**,不是按配置里写的那一家 */
export const AI_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * 供应商别名收敛到"一家"。
 *
 * `google` 是 `gemini` 的别名(`createProvider` 也这么认),`deepseek-openai` 是
 * DeepSeek 的另一个端点 —— **端点不同、key 相同**,分成两个槽位只会让人粘两遍。
 *
 * **不认识的名字原样返回,不猜。** 自建端点和代理服务可以叫任何名字,猜错的后果是
 * 去读一个不存在的环境变量,那比"这一家我不认识"难查得多。
 */
export function canonicalAiProvider(provider) {
  const p = String(provider ?? '').toLowerCase();
  if (p === 'google') return 'gemini';
  if (p === 'deepseek-openai') return 'deepseek';
  return p;
}

/**
 * 一家一个值的那三个字段。**这份名单是量出来的**:被不止一家读,而且各家的正确值不同。
 * `baseUrl` 在列是因为 anthropic 和 deepseek 两家都读它,而一个 DeepSeek 兼容端点的
 * 地址送给 anthropic 就是在拿别人的地址发请求。
 */
export const VENDOR_SCOPED_AI_FIELDS = ['apiKey', 'model', 'baseUrl'];

/**
 * 从某一家自己的那套里取一个字段,取不到就落到 legacy 的扁平字段。
 *
 * 落回 legacy 有个硬条件:**只有问的就是 `ai.provider` 那一家时才兜底。** 老配置的扁平
 * 槽位装的必然是当时那个 provider 的值,给它兜底是对的;拿它去应付别家,就是
 * 「DeepSeek 的 key 被发去 api.anthropic.com」那个 bug —— 换来的 401 写着
 * 「检查 ANTHROPIC_API_KEY」,把人指向一个本来就设对了的变量。**宁可返回空**:
 * 空会走到 HINTS.ai,那句话说得出是哪一家没配。
 */
function vendorField(ai, want, field) {
  const pick = (v) => String(v ?? '').trim();
  const slot = pick(ai?.providers?.[want]?.[field]);
  if (slot) return slot;
  if (want && canonicalAiProvider(ai?.provider) === want) return pick(ai?.[field]);
  return '';
}

/**
 * 取某一家的 key。顺序:**环境变量 → `ai.providers[那家].apiKey` → legacy `ai.apiKey`**。
 *
 * 三条来路都 `trim()`:复制粘贴带上换行是 401 最常见的原因,而漏掉任何一条,
 * 这个保护就只在某些写法下成立。
 */
export function resolveAiKey(ai, provider, env = process.env) {
  const want = canonicalAiProvider(provider);
  const envName = AI_KEY_ENV[want];
  const fromEnv = String(env?.[envName] ?? '').trim();
  if (envName && fromEnv) return fromEnv;
  return vendorField(ai, want, 'apiKey');
}

/**
 * 换一家:**provider 和它那一整套一起换**,返回新对象(不改原来那份)。
 *
 * `applyAiFlags` 原来只换了三分之二 —— 翻了 provider、清了 model,唯独把 key 留在原地。
 * 而 `model` 需要的其实不是"清掉",是"换成这一家自己的那个":上一家的模型名
 * (claude-* / gemini-* / deepseek-*)带过去会撞 `assertModelMatchesProvider`,可
 * **一律清空同样有代价** —— 给 Anthropic pin 的版本在切去 Gemini 再切回来之后就没了,
 * 而且不报错,只是悄悄用回默认值。各家存各家的,两个问题一起没了。
 *
 * 跨家的预算旋钮(maxTokens / effort / chunkSize …)原样带着走 —— 同一个值在哪家都对。
 */
export function switchAiProvider(ai, provider, env = process.env, { model } = {}) {
  const want = canonicalAiProvider(provider);
  return {
    ...ai,
    provider,
    apiKey: resolveAiKey(ai, provider, env),
    model: model ?? vendorField(ai, want, 'model'),
    baseUrl: vendorField(ai, want, 'baseUrl'),
  };
}

/**
 * 把 legacy 的扁平字段归户到它真正的主人名下。
 *
 * **必须在任何 provider 覆盖(AI_PROVIDER / `--provider`)生效之前跑。** 扁平槽位的主人
 * 是**文件里写着的那个 provider**,先覆盖再归户等于把上一家的 key 认成新一家的 ——
 * 也就是这套改动要修的那个 bug,只是换个地方重新长出来。
 */
function adoptLegacyAiFields(ai) {
  const own = canonicalAiProvider(ai?.provider);
  if (!own) return ai;
  const slot = { ...(ai?.providers?.[own] ?? {}) };
  const out = { ...ai };
  for (const f of VENDOR_SCOPED_AI_FIELDS) {
    if (!String(slot[f] ?? '').trim() && String(ai?.[f] ?? '').trim()) slot[f] = String(ai[f]).trim();
    // **归户之后必须把扁平字段清掉。** 留着的话它就成了一个没有主人的值:下一行
    // `AI_PROVIDER` 一改 `provider`,`vendorField` 的 legacy 兜底会认为它属于**新**
    // 那一家 —— DeepSeek 的 key 就这样被认成 Anthropic 的,正是要修的那个 bug 换个
    // 地方长回来。清掉之后主人只有一个,就是刚写进去的那个槽位
    out[f] = '';
  }
  return { ...out, providers: { ...(ai?.providers ?? {}), [own]: slot } };
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig({ required = [] } = {}) {
  let onDisk = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`config.json 不是合法 JSON:${err.message}`);
    }
  }

  const cfg = merge(DEFAULTS, onDisk);
  if (process.env.STEAM_API_KEY) cfg.steamApiKey = process.env.STEAM_API_KEY;
  if (process.env.STEAM_ID) cfg.steamId = process.env.STEAM_ID;
  if (process.env.NOTION_TOKEN) cfg.notion.token = process.env.NOTION_TOKEN;
  // provider / model 也能用环境变量覆盖。**必须在读 key 之前**——读哪个 key 是由
  // provider 决定的,顺序反了就会出现"设了 AI_PROVIDER=gemini 却还在找 ANTHROPIC_API_KEY"。
  // 有这两个才能完全不碰 config.json 试一家新的:
  //   AI_PROVIDER=gemini GEMINI_API_KEY=... node tracker.js ai-check --models
  // **归户在覆盖之前** —— 见 adoptLegacyAiFields 顶上那段,顺序反了 bug 就长回来
  cfg.ai = adoptLegacyAiFields(cfg.ai);
  if (process.env.AI_PROVIDER) cfg.ai.provider = process.env.AI_PROVIDER;

  // **把当前这一家的 apiKey / model / baseUrl 摊平到 `cfg.ai` 上,下游一个字都不用改。**
  // 几家同时配着也不会串;`ai.providers` 原样留着,设置页要靠它知道哪几家配好了
  cfg.ai = switchAiProvider(cfg.ai, cfg.ai.provider);
  // AI_MODEL 压在最后:它是"这一次用哪个"的临时覆盖,该盖过存着的那个
  if (process.env.AI_MODEL) cfg.ai.model = process.env.AI_MODEL;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);

  cfg.dbPath = join(DATA_ROOT, cfg.dbPath);
  cfg.guidesDir = join(DATA_ROOT, cfg.guidesDir);

  // 密钥一律去掉首尾空白。复制粘贴带上换行/空格是 401 最常见的原因,而报出来的
  // 错误("key 无效")完全指不到这个方向 —— 肉眼也看不出 JSON 里那个字符串结尾多了个空格
  cfg.steamApiKey = String(cfg.steamApiKey ?? '').trim();
  cfg.steamId = String(cfg.steamId ?? '').trim();
  cfg.notion.token = String(cfg.notion.token ?? '').trim();
  cfg.ai.apiKey = String(cfg.ai.apiKey ?? '').trim();

  for (const field of required) {
    const missing =
      (field === 'steam' && (!cfg.steamApiKey || !cfg.steamId)) ||
      (field === 'notion' && !cfg.notion.token) ||
      (field === 'ai' && !cfg.ai.apiKey);
    if (missing) throw new Error(HINTS[field]);
  }
  return cfg;
}

const HINTS = {
  steam:
    'Steam 凭据没配置。跑一次 `node tracker.js init` 填进去,或者临时用环境变量:\n' +
    '  STEAM_API_KEY=<https://steamcommunity.com/dev/apikey 拿到的 key>\n' +
    '  STEAM_ID=<https://steamid.io 查到的 SteamID64>',
  notion:
    // 「Internal Integration secret」是概念名,Notion 界面上没有这几个字。照抄控件:
    // New integration 是按钮,Internal 是里面 Type 那一栏的值。走查在 docs/notion-setup.md
    'NOTION_TOKEN 没配置。密钥在 notion.so/my-integrations 点 New integration 生成(Type 选 Internal),\n' +
    '填进 config.json 的 notion.token(或者用环境变量 NOTION_TOKEN=...),\n' +
    '并且把攻略页面/它们的父页面授权给它(页面 ••• → 连接 / Connections)。完整步骤见 docs/notion-setup.md。',
  ai:
    'AI 的 API key 没配置。在 config.json 的 ai.providers 里按供应商填 —— 几家可以同时\n' +
    '存着,各自记住自己的 key 和 model,换 provider 不用再动配置:\n' +
    '  "ai": {\n' +
    '    "provider": "anthropic",\n' +
    '    "providers": {\n' +
    '      "anthropic": { "apiKey": "sk-ant-...", "model": "" },\n' +
    '      "gemini":    { "apiKey": "AIza...",    "model": "" },\n' +
    '      "deepseek":  { "apiKey": "sk-...",     "model": "" }\n' +
    '    }\n' +
    '  }\n' +
    '或者用环境变量(按当前 provider 取对应那个,压过文件):\n' +
    '  ANTHROPIC_API_KEY=...  (provider 为 anthropic)\n' +
    '  GEMINI_API_KEY=...     (provider 为 gemini)\n' +
    '  DEEPSEEK_API_KEY=...   (provider 为 deepseek)\n' +
    '三个都有服务端联网搜索。deepseek-openai 没有,只适合验证流水线。\n' +
    '先跑 `node tracker.js ai-check --dry` 看清楚会发出去什么再说。',
};

export function saveConfig(patch) {
  const onDisk = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const next = merge(onDisk, patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
