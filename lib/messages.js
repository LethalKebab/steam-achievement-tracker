/**
 * The messages `lib/` hands to the user
 * ------------------------------------------------
 * Everything here renders **verbatim** in the Dashboard's floating bar, or as a line of CLI output.
 * These are not diagnostics — CLAUDE.md already forbids them from carrying command lines, because
 * the packaged app's user has no terminal. The same reasoning is why they are in a table now: the
 * person reading one is reading the rest of that interface in whichever language it is set to, and
 * a message is the one part of an interface that appears exactly when somebody is least able to
 * guess what it means.
 *
 * `[zh, en]` in that order. **Chinese is the source**; where the two disagree the Chinese is right.
 *
 * ## Why the language is module state rather than an argument
 *
 * Seventeen files throw these, and most of them — `zip.js`, `markdown.js`, `db.js` — have never
 * seen a config object and have no business growing a parameter for one. Threading config through
 * a ZIP reader to spell a checksum failure is disproportionate to what it buys.
 *
 * There is exactly one user and one interface language per process, so one module-level value is
 * the honest model. It is set once at startup (`serve`, and the CLI) and again by `saveUiLanguage`.
 * **Unset, it is Chinese** — the same default as everywhere else, so a caller that forgets to set
 * it degrades to the language this project has always been in rather than to English.
 *
 * ## A whole message is one entry
 *
 * Several of these were assembled from two or three concatenated pieces around an interpolated
 * value. That works only while one language is involved: word order moves, and a sentence spliced
 * from fragments comes out in the order the *other* language needed. Slots are `{name}`.
 *
 * ## What does not belong here
 *
 * The prompt in `guidegen.js` is not a message and does not live here: it forks by language inside
 * that file, one builder per language, because a rule is a paragraph rather than a sentence and the
 * two versions genuinely differ in content — which sites to search, what to do about an untranslated
 * name. Every prompt sent forks, the round-by-round messages included; `test/i18n-boundary.test.js`
 * holds that. **A prompt that forks only in part is the failure to watch for** — English rules with
 * Chinese instructions after them leaves the output language to whatever the model settles on. See
 * #86 section 4 for the split, and #121 for the pass that was missed by it.
 */
import { normalizeUiLanguage, achievementName, achievementDescription } from './lang.js';

/**
 * The interface language these are composed in.
 *
 * Chinese until told otherwise, deliberately: a path that forgets to set it — a test, a script, a
 * new entry point — falls back to what this project has always spoken, not to English.
 */
let LANG = 'zh';

export function setMessageLanguage(lang) {
  LANG = normalizeUiLanguage(lang);
}

/** For tests and for anything that has to agree with the messages without being handed the config */
export function messageLanguage() {
  return LANG;
}

/**
 * An Error whose text is a table entry, **with the entry it came from still attached**.
 *
 * The sentence is composed now, because that is what `err.message` has to hold. The key travels
 * beside it for whatever stores the error and shows it later: the generation panel keeps a failed
 * run on screen across a language switch, and a sentence composed at throw time cannot follow the
 * interface — `lib/server.js` composes from `msgKey` at read time instead.
 */
export function msgError(key, values) {
  const err = new Error(msg(key, values));
  err.msgKey = key;
  err.msgValues = values;
  return err;
}

/**
 * An achievement's name and description **in the language these messages are being composed in**.
 *
 * The preference `name_cn || name_en || api_name` was written out by hand at more than twenty call
 * sites — lint findings, sync-log reasons, progress labels, CLI lines. All of them are text a person
 * reads, and all of them sit in files that have no config object, for the same reason the messages
 * do. So they read the same ambient language rather than growing a parameter each.
 *
 * The two places that deliberately index **both** names — matching a model's output or a user's own
 * guide text back to an achievement — must never come through here: a match that depends on a
 * display setting is how a guide silently stops resolving after a toggle.
 */
export const achName = (row) => achievementName(row, LANG);
export const achDesc = (row) => achievementDescription(row, LANG);

export const MESSAGES = {
  // ---- Rows and the games table -------------------------------------------
  'game.notFound':        ['没有找到这个appid', 'No game with that appid'],
  'game.badNumbers':      ['数值无效', 'Those are not valid numbers'],
  'game.achievedTooHigh': ['完成数不能大于成就总数', 'The unlocked count cannot exceed the total'],
  'game.notLocked':       ['只能编辑已锁定的游戏', 'Only a locked row can be edited by hand'],
  'game.appidNotNumeric': ['AppID 必须是纯数字', 'An AppID is digits only'],
  'game.alreadyHere':     ['这个appid已经在表格里了', 'That appid is already in the table'],

  // ---- Guides --------------------------------------------------------------
  'guide.none':           ['这个游戏还没有登记攻略', 'No guide is registered for this game'],
  'guide.notLocal':       ['这份攻略在 Notion 上,没有本地文件', 'This guide lives on Notion; there is no local file'],
  'guide.fileGone':       ['攻略文件不在了:{path}', 'The guide file is gone: {path}'],

  // ---- Steam ---------------------------------------------------------------
  'steam.progressRetry':  ['暂时获取不到成就进度(限流或 Steam 侧隐私设置),稍后再试', 'Cannot read achievement progress right now (rate limiting, or Steam-side privacy settings). Try again shortly.'],
  'steam.noAchSystem':    ['该游戏没有成就系统,或者 Steam 判定这个账号没有成就数据', 'This game has no achievement system, or Steam reports no achievement data for this account'],
  'steam.noSchema':       ['无法获取该游戏的成就定义', 'Cannot fetch this game’s achievement definitions'],
  'steam.bothFields':     ['两项都要填写', 'Both fields are needed'],
  'steam.badSteamId':     ['SteamID64 应该是 17 位数字,去 steamid.io 查一下', 'A SteamID64 is 17 digits — look yours up at steamid.io'],
  'steam.verifyFailed':   ['验证失败:{reason}', 'Verification failed: {reason}'],
  'steam.notConfigured':  ['Steam 凭据还没配置', 'Steam credentials are not configured yet'],

  // ---- AI ------------------------------------------------------------------
  'ai.noProvider':        ['还没选供应商', 'No provider chosen yet'],
  'ai.noKey':             ['{provider} 还没填 API Key', 'No API key for {provider} yet'],
  'ai.verifyFailed':      ['验证没通过:{reason}', 'Verification did not pass: {reason}'],
  'ai.notConfigured':     ['还没配置 AI —— 去设置页填写供应商和密钥', 'AI is not configured — set a provider and key on the settings page'],
  // Bounds are a sanity check, not a measured ceiling — nobody has timed how long a request can
  // legitimately run. The floor mainly catches a stray "6" (600 read as seconds, typed as minutes)
  'ai.usage':             ['{requests} 次请求 · 输入 {input}{cache},输出 {output}{search}', '{requests} requests · {input} in{cache}, {output} out{search}'],
  'ai.usageCache':        ['(缓存写 {written} / 读 {read})', ' (cache: {written} written / {read} read)'],
  'ai.usageSearch':       [' · 联网搜索 {n} 次', ' · {n} web searches'],
  'ai.providerModelMismatch': ['供应商选的是 {provider},模型名 "{model}" 却是 {belongsTo} 的 —— 多半是只改了其中一项。去设置页把两者对齐。', 'The provider is set to {provider} but the model name "{model}" belongs to {belongsTo} — most likely only one of the two was changed. Line them up on the settings page.'],
  'ai.unknownProvider':   ['还没接入的供应商:{provider}\n  可选:anthropic、gemini、deepseek(都有联网搜索)、deepseek-openai(没有联网搜索)', 'No such provider: {provider}\n  Available: anthropic, gemini, deepseek (all three can search the web), deepseek-openai (cannot)'],
  'ai.refused':           ['模型拒答{category}——换个问法,或者换个模型', 'The model refused to answer{category} — try asking differently, or a different model'],
  'ai.refusedCategory':   ['(类别 {category})', ' (category {category})'],
  'ai.recitation':        ['因大段复述受版权保护的内容(RECITATION)被中断。这类任务容易撞上——可以换一款游戏或换个模型试。注意"官方描述原文照抄"是这个功能的硬要求,不能为了绕开这条限制而改掉它', 'Stopped for reciting copyrighted material at length (RECITATION). This kind of task runs into it readily — try a different game, or a different model. Note that copying official descriptions verbatim is a hard requirement of this feature and must not be changed to get around the limit'],
  'ai.maxTokens':         ['模型这一段没写完就被输出上限截断了(本轮已产出 {tokens} token,这是用量不是上限)', 'The model was cut off by the output ceiling before finishing this part ({tokens} tokens produced this round — that is consumption, not the ceiling)'],
  'ai.unknownStop':       ['认不出的停止原因:{reason}', 'Unrecognised stop reason: {reason}'],
  'ai.toolError':         ['联网工具报错({codes}),这轮的资料是不完整的', 'A web tool reported an error ({codes}), so this round researched incompletely'],
  'ai.controlToken':      ['模型把内部控制符写进了正文({leaked}),这一轮的正文是断的', 'The model wrote its own internal control tokens into the prose ({leaked}), so this round\u2019s prose is cut off'],
  'ai.leakedSample':      ['{label}:{sample}', '{label}: {sample}'],
  'ai.leakFullwidthBar':  ['全角竖线记号', 'a fullwidth vertical-bar marker'],
  'ai.leakPipeBracket':   ['<|…|> 记号', 'a <|…|> marker'],
  'ai.leakToolCloseTag':  ['工具调用闭合标签', 'a tool-call closing tag'],
  'ai.emptyProse':        ['模型没有输出任何正文(停止原因 {stop}、产出 {tokens} token、回包里 {blocks})', 'The model produced no prose at all (stop reason {stop}, {tokens} tokens produced, blocks in the response: {blocks})'],
  'ai.stopUnknown':       ['未知', 'unknown'],
  'ai.noBlocks':          ['一个块都没有', 'not one block'],
  'ai.blockSep':          ['、', ', '],
  'ai.noKeyConfigured':   ['{vendor} API key 没配置。填 config.json 的 ai.apiKey,或者用环境变量 {envVar}=...', 'No {vendor} API key configured. Put one in ai.apiKey in config.json, or set the environment variable {envVar}=...'],
  'ai.geminiKeyWhere':    ['\n  (key 在 https://aistudio.google.com/apikey 申请)', '\n  (get a key at https://aistudio.google.com/apikey)'],
  'ai.cancelled':         ['已取消', 'Cancelled'],
  'ai.timedOut':          ['请求超过 {seconds} 秒没结束。', 'The request ran past {seconds} seconds without finishing.'],
  'ai.timedOutSlowNote':  ['高 effort + 联网研究本来就慢。', 'High effort plus web research is slow by nature.'],
  'ai.requestFailed':     ['请求失败:{reason}', 'The request failed: {reason}'],
  'ai.httpError':         ['{vendor} API HTTP {status}{type}:{detail}{hint}', '{vendor} API HTTP {status}{type}: {detail}{hint}'],
  'ai.anthContinuations': ['服务端工具循环续跑了 {n} 次还没结束(ai.maxContinuations)。多半是模型在反复搜索:把 ai.maxSearches 调小,或者把任务拆细', 'The server-side tool loop carried on {n} times without ending (ai.maxContinuations). Most likely the model is searching over and over: lower ai.maxSearches, or break the task up'],
  'ai.anthStreamBroke':   ['流中断:{type} {reason}', 'The stream broke off: {type} {reason}'],
  'ai.anthBadKey':        ['\n  (API key 不对或已撤销:检查 config.json 的 ai.apiKey / 环境变量 {envVar})', '\n  (the API key is wrong or has been revoked: check ai.apiKey in config.json, or the {envVar} environment variable)'],
  'ai.anthBetaHeader':    ['\n  (多半是 fallbacks 的 beta 头不被接受:在 config.json 里设 "ai": { "fallbacks": false } 关掉再试)', '\n  (most likely the beta header for fallbacks is not accepted: set "ai": { "fallbacks": false } in config.json and try again)'],
  'ai.anthToolRejected':  ['\n  (这个端点不认某个工具声明——上面的 message 通常会列出它接受哪些。\n   常见修法:config.json 里设 "webFetch": false(只用搜索,不抓整页正文),\n   或者 "searchTool": "web_search_20250305" 换成老版本的搜索工具)', '\n  (this endpoint does not recognise one of the tool declarations \u2014 the message above usually lists which it accepts.\n   The usual fixes: set "webFetch": false in config.json (search only, no full-page fetching),\n   or "searchTool": "web_search_20250305" for the older search tool)'],
  'ai.anthEffortRejected': ['\n  (这个端点不认推理深浅的参数。config.json 里设 "ai": { "effort": "off" } 关掉 output_config,\n   或者设 "thinking": "off" 不发 thinking。两个是分开的开关,报错里提到哪个就关哪个)', '\n  (this endpoint does not recognise the reasoning-depth parameters. Set "ai": { "effort": "off" } in config.json to drop output_config,\n   or "thinking": "off" to stop sending thinking. They are separate switches \u2014 turn off whichever the error names)'],
  'ai.anthBadRequest':    ['\n  (400 是请求本身的问题,重试没用——看上面的 message)', '\n  (a 400 is a problem with the request itself, so retrying will not help \u2014 read the message above)'],
  'ai.dsNoBalance':       ['\n  ⚠️  账户余额不足(HTTP 402)。这不是限流,重试没有意义 —— 去 DeepSeek 后台充值。', '\n  ⚠️  The account balance is exhausted (HTTP 402). This is not rate limiting and retrying is pointless \u2014 top up in the DeepSeek console.'],
  'ai.dsBadKey':          ['\n  (API key 无效。实际发出去的 key:{shape}\n   DeepSeek 的 key 形如 sk- 加 32 位十六进制。对不上的话:\n     · 是不是粘成了别家的 key\n     · 是不是漏了一截,或者带了多余的引号/空格\n     · 去设置页重新填一次)', '\n  (the API key is not valid. What was actually sent: {shape}\n   A DeepSeek key is sk- followed by 32 hex characters. If that does not match:\n     · it may be another vendor\u2019s key\n     · part of it may be missing, or it may carry stray quotes or spaces\n     · enter it again on the settings page)'],
  'ai.dsBadModel':        ['\n  (模型名 "{model}" 可能不对。常用的是 deepseek-chat 和 deepseek-reasoner)', '\n  (the model name "{model}" may be wrong. The usual ones are deepseek-chat and deepseek-reasoner)'],
  'ai.dsTooLong':         ['\n  (上下文或输出长度超了 —— DeepSeek 的上限比另外两家小,换一款成就少一点的游戏,或者换个供应商)', '\n  (the context or the output ran past its limit \u2014 DeepSeek\u2019s ceilings are lower than the other two. Try a game with fewer achievements, or another provider)'],
  'ai.keyEmpty':          ['(空)', '(empty)'],
  'ai.keyLength':         ['长度 {n}', '{n} characters long'],
  'ai.keyStartsSk':       ['以 sk- 开头', 'starts with sk-'],
  'ai.keyStartsOther':    ['以 "{prefix}" 开头(不是 sk-)', 'starts with "{prefix}", not sk-'],
  'ai.keyHasSpace':       ['**首尾有空白**', '**has whitespace at one end**'],
  'ai.keyHasQuotes':      ['**首尾有引号**', '**has quotes at one end**'],
  'ai.keyShapeSep':       [',', ', '],
  'ai.gemRetired':        ['\n  ⚠️  {model} 对新 key 已经停止提供了(不是名字写错)。\n      换一个新一代的 flash 模型,比如 gemini-flash-latest。', '\n  ⚠️  {model} is no longer offered to newly issued keys (the name is not the problem).\n      Use a current-generation flash model instead, such as gemini-flash-latest.'],
  'ai.gemUnknownModel':   ['\n  (模型名 "{model}" 可能不对,或者你的 key 没权限用它)', '\n  (the model name "{model}" may be wrong, or this key has no access to it)'],
  'ai.gemNoAllowance':    ['\n  ⚠️  这一档对 {model} 的额度是 **0** —— 不是用完了,是这个模型不在你这一档里。\n      等多久都不会恢复,重试也没有意义。换一个 flash 系列模型(Pro 通常不在免费层)。', '\n  ⚠️  This tier\u2019s allowance for {model} is **0** \u2014 not used up, simply not included. \n      No amount of waiting brings it back and retrying is pointless. Use a flash-series model (Pro is usually outside the free tier).'],
  'ai.gemQuota':          ['\n  (配额用完了。免费层有每分钟和每天两道上限——每分钟那道等一会儿就行,每天那道要等次日重置)', '\n  (the quota is used up. The free tier has a per-minute and a per-day ceiling \u2014 the per-minute one clears after a short wait, the per-day one resets the next day)'],
  'ai.gemRetryAfter':     ['\n  Google 说 {seconds} 秒后可以再试。', '\n  Google says it can be retried in {seconds} seconds.'],
  'ai.gemNoQuotaDetail':  ['\n  这次的响应里**没有配额明细**,分不清是哪一道。缩小范围:\n    · 等一分钟再试 —— 还失败就不是每分钟那道\n    · 去 https://ai.dev/rate-limit 看这个 key 实际有哪些配额', '\n  This response carries **no quota detail**, so there is no telling which ceiling it was. To narrow it down:\n    · wait a minute and try again \u2014 if it still fails it is not the per-minute one\n    · check what this key actually has at https://ai.dev/rate-limit'],
  'ai.gemToolRejected':   ['\n  (像是联网工具的声明不被接受 —— 这一项在设置页可以改)', '\n  (it looks like the web tool declaration is not accepted \u2014 that setting can be changed on the settings page)'],
  'ai.gemForbidden':      ['\n  (key 无效,或者这个 API 在你的地区/项目里没启用)', '\n  (the key is not valid, or this API is not enabled for your region or project)'],
  'ai.gemQuotaDetail':    ['\n  配额明细:\n{lines}', '\n  Quota detail:\n{lines}'],
  'ai.gemQuotaLine':      ['    · {metric}{id} 上限 {value}', '    · {metric}{id} limit {value}'],
  'ai.timeoutTooLow':     ['请求超时不能低于 30 秒', 'Request timeout cannot be under 30 seconds'],
  'ai.timeoutTooHigh':    ['请求超时不能超过 60 分钟', 'Request timeout cannot exceed 60 minutes'],

  // ---- Notion --------------------------------------------------------------
  'notion.noToken':       ['还没填 Access token', 'No access token entered'],
  'notion.noTokenSaved':  ['还没配 Notion token', 'No Notion token configured'],
  'notion.noDbSaved':     ['还没配攻略数据库 ID', 'No guide database ID configured'],
  'notion.noParent':      ['还没选父页面', 'No parent page chosen'],
  'notion.tokenBad':      ['token 不可用:{reason}', 'The token does not work: {reason}'],
  // One entry, not four concatenated pieces: the list sits in the middle and the closing advice
  // reads differently on either side of it
  'notion.dbUnreadable':  [
    'token 没问题,但这个 ID 读不出数据库:{reason}\n两种可能,修法不一样:\n{causes}\n没有现成的数据库的话,把这一栏留空保存,再点「新建一个攻略数据库」。',
    'The token is fine, but no database can be read from this ID: {reason}\nTwo possibilities, with different fixes:\n{causes}\nIf you do not have a database yet, save this field empty and then use “＋ Create a guide database”.',
  ],
  'notion.clobbered':     [
    '补选项把已有的选项冲掉了:{list}。这是比没修好严重得多的情况,请去 Notion 里把它们加回来,并把这件事报给作者。',
    'Filling in the options overwrote existing ones: {list}. That is considerably worse than not having fixed it — add them back in Notion, and report this.',
  ],
  'notion.noStatusProp':  ['这个库没有状态属性,补选项解决不了 —— 要先在 Notion 里加一个 Status 属性。', 'This database has no status property, so filling in options cannot help — add a Status property in Notion first.'],
  'notion.silentIgnore':  [
    'Notion 收下了请求但选项没落地,还缺:{list}。{hint}打开那个库 → 点这个属性 → 手动加上这几个选项,名字要一模一样(注意大小写)。',
    'Notion accepted the request but the options did not take. Still missing: {list}. {hint}Open that database → click the property → add these options by hand, spelled exactly the same, case included.',
  ],
  // Only for a status property, hence its own entry rather than a branch inside the sentence above
  'notion.statusHint':    ['status 类型的属性选项多半只能在 Notion 界面里加:', 'Options on a status property can usually only be added in Notion’s own interface. '],
  'notion.dbAlreadySet':  [
    '已经配了攻略库({id})。「新建一个攻略数据库」是给还没有库的人用的 —— 建了会把这一栏改指到新库,现有攻略就都不在工具的视野里了。真要换:先把「攻略数据库 ID」清空并保存,再回来建。',
    'A guide database is already configured ({id}). Creating one is for people who have none — it would repoint this field at the new database, and every existing guide would fall out of view. To switch deliberately: clear the guide database ID, save, then come back and create one.',
  ],

  // ---- Backups and files ---------------------------------------------------
  'file.outsideBackups':  ['只能定位备份文件夹里的文件', 'Only files inside the backup folder can be located'],
  'file.gone':            ['文件不在了:{path}', 'That file is gone: {path}'],
  'file.notABuffer':      ['内部错误:恢复要的是文件本身', 'Internal error: restore needs the file itself'],
  'file.noOpener':        ['不知道在 {platform} 上怎么打开文件夹', 'Do not know how to open a folder on {platform}'],

  // ---- The server ----------------------------------------------------------
  'http.bodyTooBig':      ['请求体太大', 'The request body is too large'],
  'http.fileTooBig':      ['文件太大', 'That file is too large'],
  'http.unknownMethod':   ['未知方法: {method}', 'Unknown method: {method}'],
  'serve.portTaken':      [
    '端口 {port} 已被占用 —— 多半是另一个 serve 还在跑(启动器自己就带一个)。先退掉那个,或者给 CLI 加 --port 换一个端口。',
    'Port {port} is already in use — most likely another serve is still running (the launcher carries one of its own). Quit that first, or pass --port to the CLI to use a different one.',
  ],
  'sync.running':         ['同步正在进行', 'A sync is already running'],

  // ---- HTTP responses the browser shows directly -----------------------------
  'http.readFailed':      ['读不到文件: {reason}', 'Cannot read that file: {reason}'],
  'http.notLocal':        ['只接受本机页面的请求', 'Only requests from a page on this machine are accepted'],
  'http.badEscape':       ['路径里的转义解不动', 'The escaping in that path cannot be decoded'],
  'http.noLocalGuide':    ['这个 appid 没有本地攻略', 'That appid has no local guide'],
  'http.guideReadFailed': ['读不到攻略文件:{reason}', 'Cannot read the guide file: {reason}'],
  'http.notAFont':        ['不是字体资源', 'Not a font resource'],
  'http.outOfBounds':     ['路径越界', 'That path is out of bounds'],
  'http.serverError':     ['服务器内部错误', 'Internal server error'],

  // ---- Progress notes shown in the Dashboard's generation panel ---------------
  'gp.patchScope':        ['只改 {n}/{of} 条', 'changing {n} of {of}'],
  'gp.patchAsk':          ['查资料 + 重写 {n} 条', 'researching and rewriting {n}'],
  'gp.rewriteOnce':       ['按校验结果再改一次', 'one more pass against the check results'],
  'gp.askAgain':          ['没拿到正文,再问一次', 'no body came back — asking again'],
  'gp.missing':           ['模型少写了 {n} 条,正在重问', 'the model left {n} out; asking again'],
  'gp.extra':             ['模型多写了 {n} 条没要求的,已忽略', 'the model wrote {n} that were not asked for; ignored'],
  'gp.checkWrote':        ['交回 {wrote}/{of} 条,校验', '{wrote} of {of} came back; checking'],
  'gp.lintPatch':         ['本次要改 {caused} 条,原有问题 {pre} 条', '{caused} to fix from this change, {pre} pre-existing'],
  'gp.notionPatch':       ['改「{name}」', 'changing “{name}”'],
  'gp.notionVerify':      ['回读整页校验', 'reading the whole page back to check it'],
  'gp.segment':           ['{chunk}/{chunks} 段 · ', 'part {chunk} of {chunks} · '],
  'gp.segmentLabel':      ['第 {n}/{of} 段', 'part {n} of {of}'],
  'gp.searchQuery':       ['搜索「{query}」', 'searching for “{query}”'],
  'gp.toolSearch':        ['正在联网搜索', 'searching the web'],
  'gp.toolFetch':         ['正在读取网页', 'reading a page'],
  'gp.toolFilter':        ['正在筛选结果', 'sifting the results'],
  'ai.gemUnavailable':    ['{model} 这会儿没有容量(Gemini 返回 503),不是你的 key 或模型设置有问题。已经退避重试过,还是没排上。', '{model} has no capacity right now (Gemini answers 503). Nothing is wrong with your key or your model setting. It was already retried with backoff and still did not get through.'],
  'gp.fetchFailed':       ['{n} 次抓页失败({codes})——这几页只能靠搜索摘要写', '{n} page fetches failed ({codes}) — those pages can only be written from search summaries'],
  'gp.splitAdvice':       ['\n这次点了 {n} 条,一次写不完。分两次改会好过一次 ——这条路不会自己替你砍一半。', '\n{n} entries were picked, which is more than one pass can write. Two smaller rewrites will go better than one large one — this path will not halve it for you.'],
  'gp.planChunks':        ['{n} 个成就,分 {chunks} 段', '{n} achievements in {chunks} parts'],
  'gp.regroup':           ['正文写完,统一分区', 'body written; grouping it into sections'],
  'gp.regroupDone':       ['分区统一好了({n} 个)', 'grouped into {n} sections'],
  'gp.regroupFailed':     ['分区统一失败,同类成就可能散在几个小节里', 'grouping failed; related achievements may be spread across sections'],
  'gp.regroupMerged':     ['{n} 组同类成就合到了一起', '{n} groups of related achievements merged'],
  'gp.unwrapped':         ['摊开了 {n} 个折叠', '{n} toggles unwrapped'],
  'gp.unwrapFailed':      ['有一节的成就藏在折叠里,页面上看不见', 'one section’s achievements are inside a toggle and invisible on the page'],
  'patch.recheckFailed':  ['把剧透折起来之后校验没过({n} 条),这一步已撤回,改动本身照常', 'Folding the spoilers away no longer passes the checks ({n} findings); that step was rolled back and the rewrite itself stands'],
  'gp.spoiler':           ['在找剧透', 'looking for spoilers'],
  'gp.spoilerDone':       ['折起了 {n} 处剧透', '{n} spoilers folded away'],
  'gp.spoilerFailed':     ['剧透没有折起来,内容直接写在条目里', 'the spoilers were not folded and are written out in the open'],
  'gp.askWrite':          ['{prog}查资料 + 撰写', '{prog}researching and writing'],
  'gp.rewriteChunks':     ['重写 {n}/{of} 段', 'rewriting part {n} of {of}'],
  'gp.askAgainSeg':       ['{seg}没拿到正文,再问一次', '{seg}no body came back — asking again'],
  'gp.resplit':           ['第 {chunk} 段太长,拆成 {to} 个成就重问', 'part {chunk} was too long; re-asking in groups of {to}'],
  'gp.chunkFailed':       ['第 {chunk} 段({count} 个成就)未生成,先写了后面的', 'part {chunk} ({count} achievements) was not generated; the rest was written first'],
  'gp.check':             ['校验', 'checking'],
  'gp.lintTicked':        ['勾上 {ticked} 个,还剩 {blocking} 条要改', '{ticked} ticked, {blocking} left to fix'],
  'gp.progress':          ['已写完 {done}/{chunks} 段 · ', '{done} of {chunks} parts written · '],

  // ---- Guide lint findings, shown in the Dashboard's generation panel ---------
  'lint.missingCheckbox': ['成就没有对应的 checkbox 行,永远勾不上:{name}', 'No checkbox line for this achievement, so it can never be ticked: {name}'],
  'lint.paraphrased':     ['描述不是原文照抄,audit 无法反查这个框:{name}', 'The description is paraphrased rather than copied, so an audit cannot trace this box back: {name}'],
  'lint.unlockedNotTicked': ['成就已解锁但框没勾:{name}', 'Unlocked, but the box is not ticked: {name}'],
  'lint.tickedNotUnlocked': ['框勾上了但成就并没解锁:{name}', 'The box is ticked, but the achievement is not unlocked: {name}'],
  'lint.orphanTodo':      ['顶层 checkbox 认不出是哪个成就,永远勾不上:{text}', 'This top-level checkbox matches no achievement, so it can never be ticked: {text}'],
  'lint.mergedLine':      ['一行里写了多个 checkbox,后面几个不会渲染成真 checkbox:{text}', 'Several checkboxes on one line; all but the first will not render as real checkboxes: {text}'],
  'lint.ambiguousNoDesc': ['同名成就「{name}」没抄描述原文,靠名字分不出是哪一个,永远同步不上', '“{name}” shares its name with another achievement and its description is not copied, so nothing can tell the two apart and it will never sync'],
  'lint.ambiguousEmptyDesc': ['同名成就「{name}」在 Steam 上的描述是空的,无法区分——它注定同步不上,而这不是攻略能修的', '“{name}” shares its name with another achievement and has no description on Steam, so the two cannot be told apart. It will never sync, and no guide can fix that'],
  'lint.missingTitle':    ['本地攻略前 15 行里没有 `# 游戏名`,登记进 guides 表时名字会取错', 'No `# Game name` in the first 15 lines of this local guide, so the name recorded in the guides table will be the wrong one'],
  'lint.statsInHeading':  ['节标题里有统计数字,会随进度过期:{text}', 'A section heading carries a count, which goes stale as progress moves: {text}'],
  'lint.dataSourceNote':  ['攻略里写了勾选状态的数据来源,SKILL.md rule-7要求去掉', 'The guide explains where the tick state comes from; SKILL.md rule 7 asks for that to be removed'],
  'lint.spoilerSummaryForm': ['第 {line} 行的剧透折叠,<summary> 里写了固定标签以外的字,标签本身就可能把要遮的东西说出来:{label}', 'The spoiler fold on line {line} has a <summary> carrying more than the fixed label, which can give away the very thing it folds: {label}'],
  'lint.spoilerFoldCheckbox': ['第 {line} 行的剧透折叠里有 checkbox,会当成子步骤处理,父成就一解锁就连带勾上', 'The spoiler fold on line {line} holds a checkbox, which is read as a sub-step and ticked along with the parent achievement'],
  'lint.spoilerFoldDetached': ['第 {line} 行的剧透折叠没有紧跟在某条成就下面,局部重写不会带上它', 'The spoiler fold on line {line} does not sit immediately under an achievement, so a partial rewrite will not carry it along'],
  'guide.unreadable':     ['读不到攻略:{reason}', 'The guide could not be read: {reason}'],
  'guide.noUnlockState':  ['Steam 查不到解锁状态,稍后再试', 'Steam has no unlock state for this game; try again shortly'],
  'guide.localBackend':   ['本地 markdown', 'a local markdown file'],
  'schema.notInLibrary':  ['这个 appid 不在库里', 'That appid is not in the library'],
  'schema.noAchSystem':   ['这个游戏没有成就系统', 'This game has no achievement system'],
  'schema.perfectSkipped': ['已经打满了,批量同步刻意不取它的成就详情(生成攻略时会自己去取)', 'Already at 100%, so the bulk sync deliberately does not fetch its achievement detail; generating a guide fetches it on the spot'],
  'schema.notSyncedYet':  ['还没同步成就详情,下次同步会带上它', 'Its achievement detail has not been synced yet; the next sync will pick it up'],
  'migrate.countMismatch': ['条目数对不上:文件里 {a} 个,Notion 上 {b} 个', 'The entry counts disagree: {a} in the file, {b} on Notion'],
  'migrate.textMismatch': ['第 {n} 条文字对不上:\n    文件:{a}\n    Notion:{b}', 'Entry {n} does not match:\n    file:   {a}\n    Notion: {b}'],
  'migrate.tickMismatch': ['第 {n} 条勾选状态变了({from} → {to}):{text}', 'Entry {n} changed its tick state ({from} → {to}): {text}'],
  'migrate.ticked':       ['已勾', 'ticked'],
  'migrate.unticked':     ['未勾', 'unticked'],
  'migrate.andMore':      ['…… 后面的不再列了', '… the rest are not listed'],

  // ---- Checkbox-sync log lines -----------------------------------------------
  'sync.ambiguousName':   ['跳过 - 有多个同名成就且只解锁了一部分,攻略里也没抄成就描述原文,靠名字分不出该勾哪个;需人工核对(很可能已解锁那个的框早就勾上了、剩下的本来就不该勾)', 'Skipped — several achievements share this name, only some are unlocked, and the guide does not quote the descriptions, so the name alone cannot say which box to tick. Check by hand; most likely the unlocked one is already ticked and the rest should not be.'],
  'sync.wouldTick':       ['【预演】会勾选: {text}', '[dry run] would tick: {text}'],
  'sync.ticked':          ['已勾选: {text}', 'Ticked: {text}'],
  'sync.tickedSub':       ['已勾选子步骤(父成就已解锁): {text}', 'Ticked a sub-step, its achievement being unlocked: {text}'],
  'sync.wouldTickSub':    ['【预演】会勾选子步骤: {text}', '[dry run] would tick a sub-step: {text}'],
  'sync.tickFailed':      ['勾选失败: {reason}', 'Ticking failed: {reason}'],
  'sync.skipNoSteam':     ['跳过 - 无法获取Steam解锁数据: {reason}', 'Skipped — cannot read unlock data from Steam: {reason}'],
  'sync.skipBadPath':     ['跳过 - 攻略链接/路径无法解析: {reason}', 'Skipped — the guide link or path cannot be resolved: {reason}'],
  'sync.skipUnreadable':  ['跳过 - 无法读取{label}攻略(Notion 需检查 connection 是否连接到该页面): {reason}', 'Skipped — cannot read the {label} guide. For Notion, check the connection is added to that page: {reason}'],
  'sync.guideLinksAdded': ['Guide Sync - 新增 {n} 条攻略链接', 'Guide Sync - {n} guide links added'],
  'sync.guidePagesFailed': [' / 读取失败 {n} 个页面', ' / {n} pages could not be read'],
  'sync.skipNoCheckbox':  ['跳过 - 攻略里没找到checkbox(可能是纯数据库/纯笔记页面,需要手动处理)', 'Skipped — no checkbox found in the guide. It may be a database or notes page, which has to be handled by hand.'],
  'status.wouldChange':   ['【预演】会把攻略状态从 {from} 改成 {to}({why})', '[dry run] would change the guide status from {from} to {to} ({why})'],
  'status.changed':       ['攻略状态 {from} → {to}({why})', 'Guide status {from} → {to} ({why})'],
  'status.changeFailed':  ['攻略状态改失败: {reason}', 'Could not change the guide status: {reason}'],
  'status.whyComplete':   ['成就已打满', 'every achievement is unlocked'],
  'status.whyIncomplete': ['成就总数变多,掉出 100%', 'the achievement total rose, dropping it below 100%'],
  'status.emptyFrom':     ['(空)', '(empty)'],
  'lang.unknown':         ['不认识这个界面语言:{lang}', 'Not an interface language I know: {lang}'],
  'lang.empty':           ['(空)', '(empty)'],

  // ---- Strings the Dashboard receives as **data** rather than as an error -----
  // The guard below reaches `new Error` and `{error:}`; these arrive in ordinary fields, which
  // is exactly why one of them was still Chinese in an otherwise English page until a browser
  // showed it. They are user-facing all the same
  'sync.never':           ['还没同步过', 'Never synced'],
  'game.unnamed':         ['(未命名)', '(unnamed)'],
  'ach.hiddenDesc':       ['(隐藏成就,解锁前不显示描述)', '(hidden achievement — no description until it is unlocked)'],
  'guide.unreadable':     ['读不到攻略:{reason}', 'Cannot read the guide: {reason}'],
  'guidegen.queued':      ['这款游戏已经在生成或排队了', 'This game is already generating or queued'],

  // ---- Config, database, Steam ---------------------------------------------
  'config.badJson':       ['config.json 不是合法 JSON:{reason}', 'config.json is not valid JSON: {reason}'],
  'db.columnNotAllowed':  ['不允许直接改这一列: {field}', 'That column may not be written directly: {field}'],
  'steam.ownedFailed':    ['GetOwnedGames 失败 HTTP {status}{hint}', 'GetOwnedGames failed, HTTP {status}{hint}'],
  'steam.ownedAuthHint':  ['(API key 或 SteamID 不对?)', ' (wrong API key or SteamID?)'],

  // ---- Backups and the ZIP container ---------------------------------------
  'backup.notOurs':       ['这个 zip 里没有 steam.db,不是本工具的备份文件', 'There is no steam.db in this zip — it is not a backup made by this tool'],
  'backup.tooNew':        ['这个备份来自更新的版本(格式 {format},本程序只认到 {supported})。升级后再恢复。', 'This backup came from a newer version (format {format}; this build only understands up to {supported}). Upgrade first, then restore.'],
  'zip.notAZip':          ['不是一个 ZIP 文件(找不到中央目录)', 'Not a ZIP file — there is no central directory'],
  'zip.badDirectory':     ['ZIP 中央目录损坏', 'The ZIP central directory is damaged'],
  'zip.badEntry':         ['ZIP 条目损坏: {name}', 'Damaged ZIP entry: {name}'],
  'zip.badChecksum':      ['ZIP 条目校验失败(文件可能损坏): {name}', 'A ZIP entry failed its checksum, so the file may be damaged: {name}'],

  // ---- Guide files on disk -------------------------------------------------
  'guide.pathEscapes':    ['攻略路径越出了 guides 目录: {url}', 'That guide path leaves the guides directory: {url}'],
  'guide.fileMissing':    ['找不到攻略文件: {path}', 'Guide file not found: {path}'],

  // ---- Guide archives ------------------------------------------------------
  'arc.badDir':           ['存档编号里的目录不认识:{raw}', 'Unrecognised directory in the archive id: {raw}'],
  'arc.badFile':          ['存档编号里的文件名不合法:{raw}', 'Invalid file name in the archive id: {raw}'],
  'arc.outOfRange':       ['存档编号越界了:{raw}', 'That archive id is out of range: {raw}'],
  'arc.noAppidLine':      ['{file} 的开头没有 `appid: NNNNNN` 行 —— 就算恢复过去,攻略发现逻辑也不会登记它,等于放了个看不见的文件。先在文件里补上那一行。', '{file} has no `appid: NNNNNN` line at the top — restoring it would leave guide discovery unable to register it, so the file would sit there invisible. Add that line first.'],
  'arc.noPageUrl':        ['这份备份里没记页面地址,没法知道该恢复到哪一页。', 'This backup records no page address, so there is no way to know which page to restore it to.'],
  'arc.notionMissing':    ['要把攻略写回 Notion,但 Notion 还没配置 —— 去设置页填 Notion 的 access token。', 'Writing a guide back to Notion, but Notion is not configured — enter the Notion access token on the settings page.'],
  'arc.noBlocks':         ['这份备份里没有一个能写回去的块,那一页不动。', 'There is not one writable block in this backup, so that page is left alone.'],
  'arc.readbackMismatch': ['写回去之后回读对不上({url}):\n  {problems}\n  刚才那一版存在 {path},页面自己看一眼决定怎么办。', 'The read-back does not match what was written ({url}):\n  {problems}\n  The previous version is at {path} — look at the page and decide what to do.'],
  'arc.gone':             ['这份存档已经不在了:{path}', 'That archive is no longer there: {path}'],

  // ---- Guide backups -------------------------------------------------------
  'bk.guideFileGone':     ['要备份的攻略文件不见了:{path}', 'The guide file to back up is gone: {path}'],
  'bk.notionMissing':     ['要备份 Notion 上的攻略,但 Notion 没配置', 'Backing up a guide from Notion, but Notion is not configured'],
  'bk.emptyPage':         ['{url} 上一个 block 都没读到 —— 备份空文件等于没备份,先确认这一页还在', 'Not one block could be read from {url} — an empty backup is no backup, so check that the page is still there'],

  // ---- Generating a guide --------------------------------------------------
  'gen.regroupLostAch':   ['重排把成就弄丢了或弄重了:进去 {before} 条,出来 {after} 条。已停止,正文未改动。', 'Regrouping lost or duplicated achievements: {before} went in, {after} came out. Stopped; the text is unchanged.'],
  'gen.regroupLostText':  ['重排丢了正文:「{text}」进去 {n} 次、出来 {got} 次。已停止,正文未改动。', 'Regrouping lost body text: “{text}” went in {n} times and came out {got}. Stopped; the text is unchanged.'],
  'gen.regroupBrokeToggles': ['重排把折叠块拆开了(进去 {in} 个、出来 {out} 个,内容对不上)。已停止,正文未改动。', 'Regrouping pulled the toggles apart ({in} went in, {out} came out, and the contents do not match). Stopped; the text is unchanged.'],
  'gen.badRounds':        ['rounds 要是 ≥1 的整数,拿到的是 {rounds}', 'rounds has to be an integer of 1 or more; got {rounds}'],
  // Two whole sentences rather than a sentence plus a parenthesis fragment. The fragment version
  // had no Chinese in its Chinese half at all — it was pure punctuation — so it could not be
  // checked, and the space before the English bracket had to live somewhere unprincipled
  'gen.roundFailed':      ['第 {round} 轮没拿到可用结果:{reason}', 'Round {round} produced nothing usable: {reason}'],
  'gen.roundFailedLabelled': ['第 {round} 轮({label})没拿到可用结果:{reason}', 'Round {round} ({label}) produced nothing usable: {reason}'],
  'gen.nothingModelCanFix': ['校验没过,但没有一条是模型能改的(多半是机械打勾本身出了问题)。草稿留在 {path},先看这几条:\n  {problems}', 'The checks did not pass, and not one of the failures is something the model can fix — most likely the mechanical ticking itself went wrong. The draft is at {path}; start with these:\n  {problems}'],
  'gen.noGroups':         ['回复里挑不出成形的分组', 'No usable grouping could be read out of the reply'],
  'gen.chunkFloor':       ['\n这一段已经切到 {n} 个成就仍未生成,换个模型或供应商可能更合适。', '\nThis part is down to {n} achievements and still did not come back; a different model or provider may suit it better.'],
  'gen.untitledToggle':   ['(无标题)', '(untitled)'],
  'gen.unwrapRecheckFailed': ['拆折叠之后校验没过({n} 条阻断)', 'The checks did not pass after unwrapping the toggles ({n} blocking)'],
  'gen.whereNotion':      ['Notion 页面', 'a Notion page'],
  'gen.whereLocal':       ['本地文件', 'a local file'],
  'gen.recheckFailed':    ['重排之后校验没过({n} 条阻断)', 'The checks did not pass after regrouping ({n} blocking)'],
  'gen.finalRecheckFailed': ['落盘后重新校验又出问题了({path}):{problems}', 'Re-checking after writing to disk found problems again ({path}): {problems}'],
  'gen.noBackupBeforeOverwrite': ['覆盖 Notion 攻略前没有拿到备份,拒绝删除页面内容', 'No backup was obtained before overwriting the Notion guide, so the page contents will not be deleted'],
  'gen.notionRecheckFailed': ['写进 Notion 之后回读校验没过({url}):{problems}\n页面已经建好了,内容也在上面,自己看一眼决定是留是删。', 'The read-back check did not pass after writing to Notion ({url}): {problems}\nThe page exists and the content is on it — look at it and decide whether to keep or delete it.'],
  'gen.appidNotFound':    ['页面写好了({url}),但攻略发现逻辑没能从上面读出 appid:{appid}。页面在,内容在,只是 Dashboard 上暂时不会出现链接 —— 检查正文第一行的 `appid:`。', 'The page was written ({url}), but guide discovery could not read an appid from it: {appid}. The page and its content are there; only the link on the Dashboard is missing — check the `appid:` on the first line.'],
  'gen.notInList':        ['这个游戏不在列表里', 'That game is not in the list'],
  'gen.noAchList':        ['Steam 上查不到这个游戏的成就清单,没有可写的内容。', 'Steam has no achievement list for this game, so there is nothing to write.'],
  'gen.tooManyAch':       ['这个游戏有 {n} 个成就,超过了一次生成的上限 {max},没有开始。', 'This game has {n} achievements, over the per-run limit of {max}. Nothing was started.'],
  'gen.alreadyHasGuide':  ['《{game}》已经有攻略了({where}:{url})。', '{game} already has a guide ({where}: {url}).'],
  'gen.fileExists':       ['已经有一个同名文件了:{path}', 'A file of that name already exists: {path}'],
  'gen.guideFileMissing': ['guides 表指着 {path},但那个文件不在了', 'The guides table points at {path}, but that file is gone'],
  'gen.noUnlockState':    ['Steam 没给出 {id} 的解锁状态(限流或临时故障),等会儿再试', 'Steam gave no unlock state for {id} (rate limiting, or a temporary fault). Try again shortly.'],
  'gen.noAchData':        ['Steam 说 {id} 这个账号没有成就数据,没法机械打勾', 'Steam reports no achievement data for {id} on this account, so nothing can be ticked mechanically'],
  'gen.cancelNotFound':   ['这个游戏现在既没在生成也没排队', 'This game is not currently generating or queued'],

  // ---- Moving a guide to Notion --------------------------------------------
  'mig.noGuide':          ['appid {id} 在 guides 表里没有登记的攻略', 'No guide is registered in the guides table for appid {id}'],
  'mig.alreadyNotion':    ['《{name}》的攻略已经在 Notion 上了({url}),不用搬', 'The guide for {name} is already on Notion ({url}); there is nothing to move'],
  'mig.notionMissing':    ['还没配置 Notion —— 去设置页填 Notion 的 access token 和攻略数据库 ID', 'Notion is not configured — enter the access token and the guide database ID on the settings page'],
  'mig.fileMissing':      ['攻略文件不见了:{path}', 'The guide file is gone: {path}'],
  'mig.noCheckboxes':     ['{path} 里一个 checkbox 都没有,搬过去也没法勾。先确认这是不是想搬的文件。', 'There is not one checkbox in {path}, so nothing could be ticked after moving it. Check that this is the file you meant.'],
  'mig.readbackMismatch': ['搬过去之后回读对不上,本地文件原样没动({url}):\n  {problems}\n  Notion 上那一页自己看一眼决定留不留。', 'The read-back does not match after moving it; the local file is untouched ({url}):\n  {problems}\n  Look at that page on Notion and decide whether to keep it.'],
  'mig.appidNotFound':    ['页面写好了({url}),但攻略发现逻辑没能从上面读出 appid:{appid}。本地文件原样没动,guides 表还指着它 —— 检查页面正文里的 `appid:` 行。', 'The page was written ({url}), but guide discovery could not read an appid from it: {appid}. The local file is untouched and the guides table still points at it — check the `appid:` line in the page body.'],

  // ---- Rewriting part of a guide -------------------------------------------
  'patch.noGuide':        ['《{game}》还没有攻略,没有可以局部重写的内容。', '{game} has no guide yet, so there is nothing to rewrite in part.'],
  'patch.namesNotFound':  ['这几个名字在《{game}》的成就里找不到:{list}', 'These names match no achievement in {game}: {list}'],
  'patch.selectorEmpty':  ['按「{selector}」挑下来一条成就都没有,没有开始。', '“{selector}” selected no achievements at all. Nothing was started.'],
  'patch.noCheckboxes':   ['点名的 {n} 条成就在现有攻略里都找不到对应的 checkbox,局部重写没有可以替换的位置。', 'None of the {n} named achievements has a matching checkbox in the existing guide, so a partial rewrite has nothing to replace.'],
  'patch.nothingModelCanFix': ['这次改动没过校验,而且没有一条是模型能改的(多半是拼接本身出了问题)。原攻略一个字都没动,先看这几条:\n  {problems}', 'This change did not pass the checks, and not one of the failures is something the model can fix — most likely the splicing itself went wrong. The original guide is untouched; start with these:\n  {problems}'],
  'patch.noCheckboxBlock': ['《{game}》的「{apiName}」转不出 checkbox 块,已停止,页面未改动的部分保持原样', '“{apiName}” in {game} could not be turned into a checkbox block. Stopped; the untouched parts of the page are as they were'],
  'patch.notionRecheckFailed': ['写进 Notion 之后回读校验又出问题了({url}):{problems}', 'The read-back check found problems again after writing to Notion ({url}): {problems}'],

  // ---- Ticking checkboxes --------------------------------------------------
  'guides.noUnlockData':  ['appid {appid} 暂时查不到解锁数据(限流/隐私设置),稍后再试', 'No unlock data for appid {appid} right now (rate limiting, or privacy settings). Try again shortly.'],
  'guides.noAchData':     ['appid {appid} 查不到成就数据(可能没有成就系统)', 'No achievement data for appid {appid} — it may have no achievement system'],
  'guides.noStatusProp':  ['攻略数据库里没有 status/select 类型的属性,没法标记完成状态', 'The guide database has no status or select property, so completion cannot be marked'],
  'guides.missingOptions': ['攻略数据库的「{property}」属性缺少这些选项:{missing}(现有:{existing})', 'The “{property}” property of the guide database is missing these options: {missing} (it has: {existing})'],

  // ---- Choosing what to rewrite --------------------------------------------
  'scope.nothingNamed':   ['没说要重写哪些成就。', 'No achievements were named for rewriting.'],
  'scope.badRare':        ['rare: 后面要跟一个百分比数字,拿到的是「{arg}」', 'rare: has to be followed by a percentage; got “{arg}”'],
  'scope.noGlobalRates':  ['Steam 没给出全球解锁率,这次没法按稀有度挑成就。', 'Steam gave no global unlock rates, so achievements cannot be chosen by rarity this time.'],
  'scope.badSection':     ['section: 后面要跟小节标题。', 'section: has to be followed by a section heading.'],
  'scope.needsLocalText': ['这条路按小节挑成就需要本地攻略全文。', 'Choosing by section on this path needs the full local guide text.'],

  // ---- Notion ---------------------------------------------------------------
  'notion.noConnection':  ['还没连接 Notion —— 去设置页填一个 integration token', 'Notion is not connected — enter an integration token on the settings page'],
  'notion.notJson':       ['Notion API 返回内容不是 JSON(HTTP {status}): {body}', 'The Notion API returned something that is not JSON (HTTP {status}): {body}'],
  'notion.apiError':      ['Notion API 错误 {status}: {message}', 'Notion API error {status}: {message}'],
  'notion.noDb':          ['还没选攻略数据库 —— 去设置页连一个,或者让它替你新建一个', 'No guide database chosen — connect one on the settings page, or have it create one for you'],
  'notion.needParent':    ['建攻略库要指定父页面', 'Creating a guide database needs a parent page'],
  'notion.createdNoStatus': ['库建出来了({url})但里面没有状态属性 —— Notion 把传过去的 Status 吞了。去那个库上手动加一个 Status 属性(选项:{options}),或者删掉这个库重来。', 'The database was created ({url}) but has no status property — Notion swallowed the Status that was sent. Add a Status property to it by hand (options: {options}), or delete the database and start again.'],
  'notion.createdMissingOptions': ['库建出来了({url})但状态选项没落全,缺:{missing}。现有:{existing}。去 Notion 里把缺的补上,或者删掉这个库重来。', 'The database was created ({url}) but not every status option took. Missing: {missing}. It has: {existing}. Add the missing ones in Notion, or delete the database and start again.'],
  'notion.noDataSource':  ['这个库读不出数据源,建不了看板视图', 'No data source can be read from this database, so no board view can be created'],
  'notion.noDbIdYet':     ['还没填攻略数据库 ID(也可以让程序帮你建一个)', 'No guide database ID entered yet — or have the program create one for you'],
  'notion.dbIdUnreadable': ['这个 ID 读不出数据库:{reason}', 'No database can be read from that ID: {reason}'],
  'notion.causeNotADb':   ['它不是数据库 —— 要把库整页打开,取 URL 里 ?v= 前面那 32 位十六进制;页面 ID、视图 ID、整条链接都不行', 'It is not a database — open the database as a full page and take the 32 hex characters before `?v=` in the URL. A page ID, a view ID or the whole link will not do'],
  'notion.causeNotShared': ['还没共享给 integration —— 在 Notion 里打开它(或父页面)→ ••• → Connections → 加上这个 integration', 'It has not been shared with the integration — open it (or its parent page) in Notion → ••• → Connections → add this integration'],
  'notion.noTitleProp':   ['这个库没有标题属性,建攻略页时会被 Notion 拒绝', 'This database has no title property, so Notion will refuse a new guide page'],
  'notion.statusPropAbsent': ['这个库没有状态属性,guide-status 那套没东西可写', 'This database has no status property, so there is nothing for the guide-status pass to write'],
  'notion.missingOptions': ['状态属性缺这些选项:{missing}', 'The status property is missing these options: {missing}'],
  'notion.outdatedFormat': ['这个库还是旧模版,要套用新的吗?', 'This database still uses the old template. Apply the new one?'],
  'notion.writeProbeFailed': ['建页试写没通过:{reason}', 'The trial page could not be created: {reason}'],
  'notion.writeProbeHint': ['多半是这个 integration 只有读权限 —— 在 Notion 的 integration 设置里把 Insert content / Update content 打开', 'Most likely this integration has read access only — turn on Insert content / Update content in its settings in Notion'],
  'notion.strandedProbePage': ['试写的页面建出来了但没能归档,请手动删掉', 'The trial page was created but could not be archived; delete it by hand'],
  'notion.summaryFallback': ['展开', 'Expand'],
  'notion.untitled':      ['(无标题)', '(untitled)'],
  'notion.unnamedWorkspace': ['未命名', 'unnamed'],
  'notion.boardViewName': ['看板', 'Board'],
  'notion.probePageTitle': ['⚙️ 连接测试 {when}(可删)', '⚙️ Connection test {when} (safe to delete)'],
  'notion.defaultDbTitle': ['Steam 攻略', 'Steam guides'],
  'notion.noStatusForBoard': ['这个库读不出状态属性,建不了看板视图', 'No status property can be read from this database, so no board view can be created'],
  'notion.noAppendIds':   ['追加后拿不到新块的 id,折叠块里的内容没能补上', 'No ids came back for the appended blocks, so the contents of the toggles could not be filled in'],
  'notion.partialWrite':  ['正文只写进去 {written}/{total} 块就失败了,页面现在是半篇攻略:{reason}', 'Only {written} of {total} blocks were written before it failed, so the page now holds half a guide: {reason}'],
  'notion.badUrl':        ['无法从URL中提取Notion页面ID: {url}', 'No Notion page ID could be read from that URL: {url}'],
  'notion.missingStatusOption': ['Notion 攻略库的「{property}」属性里没有「{value}」这个选项。现有选项:{options} —— 去设置页补一下,或者在 Notion 里加上。', 'The “{property}” property of the Notion guide database has no “{value}” option. It has: {options} — add it from the settings page, or in Notion.'],
  'notion.duplicatePages': ['Notion 攻略库里有 {n} 个都叫《{game}》的页面,分不清该写哪个。先在 Notion 里把重复的处理掉。', 'The Notion guide database has {n} pages all called {game}, so there is no telling which to write to. Deal with the duplicates in Notion first.'],
  'notion.pageHasContent': ['Notion 里已经有《{game}》这一页而且**里面有内容**({count} 个块):{url}\n往里面追加会把你手写的笔记和生成的内容拼成一份四不像,而且撤不回来。要重写就先把那一页清空,或者删掉它。', 'Notion already has a page for {game}, **and it has content on it** ({count} blocks): {url}\nAppending would splice your own notes and the generated text into something that is neither, and it cannot be undone. To rewrite, empty that page first or delete it.'],
  'notion.noOptions':     ['无', 'none'],
};

/**
 * One message, with `{slot}` filled from `values`.
 *
 * **An unknown key returns the key.** An empty error message is the worst possible outcome here —
 * something failed and the bar says nothing — while a dotted identifier on screen at least names
 * what is missing. A missing translation falls back to the Chinese, for the same reason the rest of
 * the app does: the other language beats nothing.
 */
export function msg(key, values) {
  const pair = MESSAGES[key];
  if (!pair) return key;
  let s = pair[LANG === 'en' ? 1 : 0] || pair[0];
  if (values) for (const k in values) s = s.split('{' + k + '}').join(values[k]);
  return s;
}
