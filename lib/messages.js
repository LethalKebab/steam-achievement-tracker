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
import { normalizeUiLanguage } from './lang.js';

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
  'lang.unknown':         ['不认识这个界面语言:{lang}', 'Not an interface language I know: {lang}'],
  'lang.empty':           ['(空)', '(empty)'],
  'guidegen.queued':      ['这款游戏已经在生成或排队了', 'This game is already generating or queued'],
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
