/**
 * What the launcher says, in both languages
 * ------------------------------------------------
 * The launcher is a **separate process from the tracker**, with its own `package.json` and its own
 * `node_modules`, and it cannot import `lib/messages.js` — that file is loaded by `tracker.js`
 * inside the child process, not here. So everything this process puts on screen — the crash box,
 * the tray menu, the close-to-tray balloon, the update prompt — sat outside the language switch
 * entirely and answered in Chinese whatever the Dashboard was set to.
 *
 * This is that table, in the same shape as `lib/messages.js`: `[zh, en]` per key, Chinese first
 * because Chinese is what this project answers when nothing has said otherwise.
 *
 * **The language is resolved per string, not at startup.** `uiLanguage` is written by the *other*
 * process, whenever somebody saves it on /setup, and this one is never told. Resolving it as a
 * string is composed is what stops a dialog opened after the switch from speaking the language the
 * launcher started in — the same failure `warn` in `lib/server.js` describes for a stored warning,
 * one process over.
 */

/** How long a resolved language is trusted before `config.json` is consulted again */
const CACHE_MS = 2000;

/**
 * Where the language comes from. `main.js` installs this, because knowing where `config.json` lives
 * means knowing about `local.config.json` and `TRACKER_DATA_DIR`, and none of that belongs in a
 * string table. Until it is installed, and if it ever throws, the answer is the default.
 */
let resolver = null;
let cached = 'zh';
let cachedAt = 0;

export function setLanguageResolver(fn) {
  resolver = fn;
  cachedAt = 0;
}

/** The language a string composed **now** should be in */
export function launcherLanguage() {
  const now = Date.now();
  if (resolver && now - cachedAt >= CACHE_MS) {
    try {
      cached = resolver() === 'en' ? 'en' : 'zh';
    } catch {
      // A missing or half-written config.json is not a reason to fail to open a dialog
      cached = 'zh';
    }
    cachedAt = now;
  }
  return cached;
}

/**
 * **The Chinese halves are the sentences that were in `main.js` and `updater.js`, unchanged.** They
 * were moved, not rewritten: this is a translation, and a copy edit smuggled in alongside it is
 * invisible in the diff.
 *
 * `app.name` is `title.page` in the Dashboard's own table — the window title, every dialog title
 * and the tray tooltip are the same name as the page, and they have to match to the letter or the
 * taskbar and the page disagree about what the program is called.
 */
export const LAUNCHER_MESSAGES = {
  'app.name':               ['Steam 成就追踪器', 'Steam Achievement Tracker'],

  'serve.crashed':          ['后台服务意外退出(代码 {code})。请重新打开程序;如果反复出现,请联系开发者。',
                             'The background service exited unexpectedly (code {code}). Open the program again; if it keeps happening, contact the developer.'],
  'serve.crashedWhy':       ['后台服务意外退出(代码 {code}):\n\n{reason}\n\n看不懂或者反复出现,请联系开发者。',
                             'The background service exited unexpectedly (code {code}):\n\n{reason}\n\nIf that means nothing to you, or it keeps happening, contact the developer.'],
  'serve.startTimeout':     ['后台服务启动超时,请重新打开程序。',
                             'The background service took too long to start. Open the program again.'],

  'tray.open':              ['打开面板', 'Open the dashboard'],
  'tray.quit':              ['退出', 'Exit'],
  'tray.hintTitle':         ['Steam 成就追踪器还在后台运行', 'Steam Achievement Tracker is still running in the background'],
  'tray.hintBody':          ['同步和攻略生成会继续。要完全退出,右键任务栏托盘图标选「退出」。',
                             'Syncing and guide generation carry on. To leave for good, right-click the tray icon and choose Exit.'],
  'tray.iconFailed':        ['托盘图标加载失败({path})。程序会继续运行,但关闭窗口后需要在任务管理器里结束进程。',
                             'The tray icon could not be loaded ({path}). The program keeps running, but once the window is closed you will have to end the process in Task Manager.'],

  'update.downloading':     ['正在下载 {version}', 'Downloading {version}'],
  'update.downloadingBody': ['下载完会自动重启,期间可以继续用。',
                             'It restarts by itself once the download finishes; carry on using it meanwhile.'],
  'update.failed':          ['更新失败:{reason}\n\n数据没有受到影响。可以稍后再试,或到 {url} 手动下载。',
                             'The update failed: {reason}\n\nYour data is untouched. Try again later, or download it by hand from {url}.'],
  'update.helperFailed':    ['更新没能开始:更新程序起不来。\n\n数据和程序都没有被改动。可以到 {url} 手动下载。\n\n诊断信息:{log}',
                             'The update did not start: the updater could not launch.\n\nNeither your data nor the program was changed. You can download it by hand from {url}.\n\nDiagnostics: {log}'],

  'prompt.heading':         ['有新版本 {version}', 'Version {version} is available'],
  'prompt.size':            ['下载约 {mb} MB,完成后会自动重启。',
                             'About {mb} MB to download. It restarts by itself when that finishes.'],
  'prompt.skip':            ['不再提示这个版本', 'Stop asking about this version'],
  'prompt.later':           ['以后再说', 'Later'],
  'prompt.now':             ['立即更新', 'Update now'],
};

/**
 * One string, with `{slot}` filled from `values`.
 *
 * An unknown key returns the key, for the reason the Dashboard's `t` gives: a blank label reads as
 * a layout fault and sends the reader into the CSS, while the key on screen names what is missing.
 */
export function lt(key, values) {
  const pair = LAUNCHER_MESSAGES[key];
  if (!pair) return key;
  let s = pair[launcherLanguage() === 'en' ? 1 : 0] || pair[0];
  if (values) for (const k of Object.keys(values)) s = s.split(`{${k}}`).join(String(values[k]));
  return s;
}

/** The document language for the one page this process serves — see `renderUpdatePromptHtml` */
export function htmlLang() {
  return launcherLanguage() === 'en' ? 'en' : 'zh-CN';
}
