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
const DATA_ROOT = process.env.TRACKER_DATA_DIR ? resolve(process.env.TRACKER_DATA_DIR) : ROOT;
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
    // 环境变量 ANTHROPIC_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY 也能填
    // (按 provider 取对应那个)
    apiKey: '',
    // **默认留空,让各家用各自的默认模型。** 这里不能填一个具体名字:模型名是
    // 供应商专属的(claude-* / gemini-* / deepseek-*),填了 anthropic 的名字就意味着
    // 换 provider 却没顺手改 model 的人一定会撞上"供应商和模型对不上"。
    // 想固定某个版本再填,不确定有哪些可用就跑 `node tracker.js ai-check --models`
    model: '',
    // 深浅旋钮。写攻略是"联网研究 + 逐条消化改写",属于该给足的那类活
    effort: 'high',
    // thinking + 正文的**总**上限,不是正文上限。给不够会写到一半被截断,
    // 而截断的攻略比生成失败更糟(校验器发现不了"后半段根本没写")
    maxTokens: 32000,
    // 超过这么多成就就拒绝生成。**这个上限现在管的是"跑多久、花多少",
    // 不再是"技术上写不出来"** —— 超过一段的会自动分段写(guidegen.js 的 chunkDefs)。
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
    // **一次请求里最多搜几次。** 这是攻略深度的头号约束:实测 6 次搜 51 个成就
    // (8.5 个成就摊一次)出来的攻略每条只有几十字心得,难的成就完全没写透。
    // 生成攻略是"多搜比少搜值"的场景 —— 一次搜索比一段编出来的话便宜得多
    //
    // 这里曾经有一组花费上限(token 和美元各两条)和一张模型单价表。**整套删掉了。**
    // 各家单价会变、我们核实不过来,而搜索工具怎么计费根本没实测 —— 于是"上限"
    // 建立在一个我们自己都不信的金额上。给用户几个他没法判断该填多少的旋钮,
    // 只是把不确定性转嫁过去。真要控制开销,maxSearches / maxTokens / maxRounds
    // 这几条本来就在管用,而且它们量的是实打实的东西。
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
  if (process.env.AI_PROVIDER) cfg.ai.provider = process.env.AI_PROVIDER;
  if (process.env.AI_MODEL) cfg.ai.model = process.env.AI_MODEL;

  // 两家各有各的环境变量名,按当前 provider 取。两个都设着也不会串,
  // 切 provider 的时候不用再去改 key
  const AI_KEY_ENV = {
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    google: 'GEMINI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
  };
  const aiKeyEnv = AI_KEY_ENV[String(cfg.ai.provider ?? '').toLowerCase()];
  if (aiKeyEnv && process.env[aiKeyEnv]) cfg.ai.apiKey = process.env[aiKeyEnv];
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
    'AI 的 API key 没配置。在 config.json 的 ai.apiKey 里填上,或者用环境变量:\n' +
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
