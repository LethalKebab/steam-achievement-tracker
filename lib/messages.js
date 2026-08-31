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
 * The prompt in `guidegen.js` is not a message and must never be translated — it encodes a Chinese
 * reader's research strategy (which sites to search, what to do about untranslated names), and a
 * translated prompt asks the model for something different. See #86, section 4.
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
    'The token is fine, but no database can be read from this ID: {reason}\nTwo possibilities, with different fixes:\n{causes}\nIf you do not have a database yet, save this field empty and then use 「新建一个攻略数据库」.',
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
  'gp.planChunks':        ['{n} 个成就,分 {chunks} 段', '{n} achievements in {chunks} parts'],
  'gp.regroup':           ['正文写完,统一分区', 'body written; grouping it into sections'],
  'gp.regroupDone':       ['分区统一好了({n} 个)', 'grouped into {n} sections'],
  'gp.regroupFailed':     ['分区统一失败,同类成就可能散在几个小节里', 'grouping failed; related achievements may be spread across sections'],
  'gp.regroupMerged':     ['{n} 组同类成就合到了一起', '{n} groups of related achievements merged'],
  'gp.unwrapped':         ['摊开了 {n} 个折叠', '{n} toggles unwrapped'],
  'gp.unwrapFailed':      ['有一节的成就藏在折叠里,页面上看不见', 'one section’s achievements are inside a toggle and invisible on the page'],
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
