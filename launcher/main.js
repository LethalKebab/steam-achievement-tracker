/**
 * Electron launcher main process
 * ------------------------------------------------
 * Holds no business logic of its own — it just spawns the existing `tracker.js serve` as a child
 * process and opens a window pointed at its local address. The real server, database and
 * Steam/Notion calls all run inside that child process exactly as `node tracker.js serve` does.
 *
 * The child runs on Electron's bundled Node (ELECTRON_RUN_AS_NODE=1 makes electron.exe behave like
 * an ordinary node executable) — node:sqlite has been verified to work along that path, so no
 * separate Node runtime needs packaging.
 */
import { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALIVE_MARKER_NAME,
  MANIFEST_NAME,
  RELEASES_PAGE,
  STATE_NAME,
  downloadVerified,
  fetchRelease,
  fallbackLaunch,
  parseManifest,
  parsePromptChoice,
  primaryLaunch,
  pickAssets,
  renderUpdatePromptHtml,
  readUpdateState,
  renderHelperScript,
  shouldOffer,
  writeHelperScript,
  writeUpdateState,
} from './updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8777;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

/** Wait a while after launch before checking, so it does not compete with the server starting and the first sync */
const UPDATE_CHECK_DELAY_MS = 10_000;
/**
 * Then once a day. **Checking only at startup is not enough** — once it lives in the tray the
 * process can run for days, making "startup" a very rare event (the same reason maybeAutoSync was
 * forced to move from process start to window show). Hanging it off window show is too noisy: ten
 * open/close cycles a day should not mean ten checks.
 */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * With no window built yet there is nothing to check against (it is needed as the dialog's parent),
 * so come back in a minute — jumping straight to 24 hours is not acceptable: when the server starts
 * slowly (waitForServer waits up to 15 seconds) the window appears after the first check, and that
 * would throw away the day's only opportunity with no sign of it at all.
 */
const UPDATE_CHECK_RETRY_MS = 60_000;
/**
 * The limit for the helper reporting in. A PowerShell cold start commonly takes a second or two, so
 * this allows 15; failing that it tries the fallback route, and failing that it reports an error and
 * **does not exit**.
 */
const HELPER_ALIVE_TIMEOUT_MS = 15_000;

// In dev mode (`npm start`) the core files are one directory up; once packaged, electron-builder's
// extraResources copies them into resources/tracker (see the build config in package.json).
const TRACKER_ROOT = app.isPackaged ? join(process.resourcesPath, 'tracker') : join(__dirname, '..');

/**
 * The switch that points the packaged build at an existing CLI data set. **The copy next to the exe
 * is looked for first**, rather than app.getPath('userData') (%APPDATA%\<productName>): userData
 * looks more "official", but it sits under the user profile directory where any number of
 * sandboxing/virtualisation mechanisms can redirect it — the same absolute path can hold different
 * content depending on which process is looking, and that is extremely painful to diagnose (a trap
 * genuinely stepped on once). The copy next to the exe travels with the program itself, so whoever
 * launches it sees the same file and there is no second interpretation.
 *
 * userData is still kept as a fallback: put it there to have the config survive "delete the whole
 * folder and unzip again". With neither present (which is the case for a build handed to somebody
 * else) it returns null and the data lands next to the exe, exactly as it would without this
 * feature.
 *
 * dist/ is rebuilt on every build, and **postbuild.js always leaves one next to the exe**: where
 * launcher/local.config.json exists it is copied, and where it does not, one pointing at the
 * repository root with auto-update off is generated. Both keep a local build's data outside the
 * directory the rename step deletes. The source file under launcher/ is unaffected by the build.
 */
function localConfigCandidates() {
  return [
    join(dirname(process.execPath), 'local.config.json'),
    join(app.getPath('userData'), 'local.config.json'),
    join(__dirname, 'local.config.json'),
  ];
}

function loadDataDirOverride() {
  for (const path of localConfigCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const dataDir = JSON.parse(readFileSync(path, 'utf8')).dataDir || null;
      if (!dataDir) continue;
      // Pointing at a directory that does not exist is treated as not configured. That is what it
      // looks like when the whole folder was copied to another machine, or the CLI checkout was moved
      // away — and in that case falling back to "data next to the exe" opens normally, which beats
      // taking a dead path, creating a database there and failing to start.
      if (!existsSync(dataDir)) {
        console.warn(`[launcher] local.config.json 指向的目录不存在,忽略:${dataDir}`);
        continue;
      }
      return dataDir;
    } catch (err) {
      console.warn(`[launcher] ${path} 读取失败,跳过:`, err.message);
    }
  }
  return null;
}

let serverProcess = null;
let mainWindow = null;
let setupPollTimer = null;
let tray = null;
let hideHintShown = false;
let updateTimer = null;
let updateBusy = false;

const ICON_PATH = join(__dirname, 'icon.ico');

function startServer() {
  const dataDir = loadDataDirOverride();
  if (dataDir) console.log('[launcher] using external data dir:', dataDir);

  serverProcess = spawn(
    process.execPath,
    [join(TRACKER_ROOT, 'tracker.js'), 'serve', '--port', String(PORT)],
    {
      cwd: TRACKER_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(dataDir ? { TRACKER_DATA_DIR: dataDir } : {}),
      },
      /**
       * stderr goes through a pipe rather than inherit. **A packaged build has no console at all** —
       * the sentence the child prints before dying lands verbatim in a terminal that does not exist,
       * leaving the launcher holding only an exit code, so the error box can only say 「代码 1」 while
       * that sentence was the one thing capable of explaining the cause.
       * It is captured solely to be repeated in the box; stdout stays on inherit, so dev-mode logging
       * is unchanged.
       */
      stdio: ['inherit', 'inherit', 'pipe'],
    }
  );

  // setEncoding is not incidental: when a Chinese error message is cut at a byte boundary,
  // concatenating strings produces mojibake
  serverProcess.stderr.setEncoding('utf8');
  let stderrTail = '';
  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(chunk); // still visible in `npm start`'s terminal in dev mode
    stderrTail = (stderrTail + chunk).slice(-2000); // keep only the tail; what matters is the last sentence
  });

  serverProcess.on('exit', (code) => {
    // On a deliberate shutdown app.isQuitting is already set, so this only handles "the child died on
    // its own" — with no server there is no Dashboard to look at, and leaving an empty window open is
    // worse than exiting and saying why
    if (app.isQuitting) return;
    const reason = lastErrorLine(stderrTail);
    dialog.showErrorBox(
      'Steam 成就追踪器',
      reason
        ? `后台服务意外退出(代码 ${code}):\n\n${reason}\n\n看不懂或者反复出现,请联系开发者。`
        : `后台服务意外退出(代码 ${code})。请重新打开程序;如果反复出现,请联系开发者。`
    );
    app.quit();
  });
}

/**
 * Picks **one sentence fit for a person to read** out of the child's stderr.
 *
 * `tracker.js`'s top-level catch prints `❌ <message>` (a taken port, an unreadable config, an
 * unopenable database all go through it), so when there is a ❌ the last one is taken.
 *
 * No ❌ means Node itself crashed, and there what is wanted is the stack's **first** line
 * (`Error: …`). "Take the last non-empty line" is precisely the worst choice here, measured: the end
 * of a stack is `at Module._load` or a bare `}`, which says where it broke, not what broke — using
 * that as the error box's body skips over the one human sentence there is. The last line is the
 * fallback only when both fail: **better one incomprehensible line than nothing but 「代码 1」**, since
 * the former can be searched and pasted to a developer while the latter cannot even be searched.
 */
function lastErrorLine(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const marked = lines.filter((l) => l.startsWith('❌'));
  const thrown = lines.find((l) => /^[\w.$]*Error\b/.test(l));
  // Strip the ❌ once picked: it is what the CLI uses to mark this line out in a screen of logs, while
  // the error box comes with its own red cross, so keeping it says the same thing twice
  const line = (marked.at(-1) ?? thrown ?? lines.at(-1)).replace(/^❌\s*/, '');
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Polls until the server responds (the status code does not matter; connecting at all counts as alive) */
async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(BASE_URL);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

/**
 * While stopped on the /setup page, polls getSetupStatus and jumps back to the Dashboard as soon as
 * configuration is complete.
 * The child process does not need restarting: lib/api.js's completeSetup updates config/steam's
 * in-memory state on the spot, so the running child is immediately usable.
 */
function pollSetupStatus() {
  setupPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${BASE_URL}api/getSetupStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      const body = await res.json();
      if (body.ok && body.result?.configured) {
        clearInterval(setupPollTimer);
        setupPollTimer = null;
        console.log('[launcher] setup complete, returning to dashboard');
        mainWindow?.loadURL(BASE_URL);
      }
    } catch {
      // One failed poll (the server is busy) is skipped; the next round tries again
    }
  }, 1000);
}

async function createWindow() {
  const up = await waitForServer();
  if (!up) {
    dialog.showErrorBox('Steam 成就追踪器', '后台服务启动超时,请重新打开程序。');
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Steam 成就追踪器',
    autoHideMenuBar: true,
    icon: ICON_PATH,
  });

  /**
   * Links in the page with `target="_blank"` (guides, Notion pages) always go to the system browser.
   *
   * **Without this Electron opens a bare window of its own**, and that window: falls back to the
   * title `steam-achievement-tracker-launcher` from package.json (which is what the user sees), has
   * no address bar and no back button, and worst of all **carries none of the user's Notion login
   * state** — so a guide page will not open in it and only shows the login wall. These links point at
   * off-site content in the first place, which is the browser's business.
   *
   * Only http/https is let through: besides `deny`, protocols like file:// have to be blocked so a
   * local file is never handed to the system to execute.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(BASE_URL);

  // / 302s to /setup when unconfigured — after loadURL completes, getURL() is the final address after
  // the redirect
  if (mainWindow.webContents.getURL().includes('/setup')) {
    console.log('[launcher] landed on /setup, polling for completion');
    pollSetupStatus();
  }

  /**
   * Closing the window = going to the tray, not exiting. The only real exit is through the tray menu,
   * and `app.isQuitting` is the boundary between the two — during the exit flow this close event
   * fires once more, and that time it must be allowed through, or preventDefault leaves the app stuck
   * "impossible to quit".
   */
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWindow.hide();

    // The classic complaint about background operation is "I closed it, why is it still running". On
    // Windows the tray icon is collapsed into the overflow area by default, and without saying so
    // once the user has no idea where to look for it. Shown only once.
    if (!hideHintShown) {
      hideHintShown = true;
      tray?.displayBalloon({
        icon: ICON_PATH,
        title: 'Steam 成就追踪器还在后台运行',
        content: '同步和攻略生成会继续。要完全退出,右键任务栏托盘图标选「退出」。',
      });
    }
  });

  /**
   * **The automatic sync's trigger is "the window is shown", not "the process started".** The one at
   * server startup (`maybeAutoSync` inside `startupJobs`) fires only when the process is new, and once
   * it lives in the tray the process can run for days — so that trigger never fires again and the
   * data stays frozen at the day it was opened, with no error, just numbers that stop moving on the
   * Dashboard.
   *
   * Hanging it off window show keeps the semantics: check freshness when the panel is opened. The
   * `syncStaleHours` gate is still inside maybeAutoSync, so opening and closing the window frequently
   * does not become syncing frequently.
   */
  mainWindow.on('show', () => {
    fetch(`${BASE_URL}api/maybeSync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    }).catch(() => {
      // The server is busy or has only just started; it will be picked up the next time the window is
      // shown — not something the user needs to know
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * The auto-update switch — the "it has to be turnable off" of the design doc's three hard details.
 *
 * It lives in local.config.json: that is already the launcher's only per-machine config file, and one
 * boolean does not justify opening a second.
 * Absent means on.
 */
function autoUpdateEnabled() {
  for (const path of localConfigCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')).autoUpdate;
      if (typeof v === 'boolean') return v;
    } catch {
      // A broken file is skipped, the same attitude as loadDataDirOverride
    }
  }
  return true;
}

/**
 * The updater's half of the logging.
 *
 * The helper has had logging from the start and the app half had none — so in the first real
 * rehearsal 「弹窗闪了一下就没了」 could only be guessed at, and it took a round trip to establish
 * which branch it had actually taken. This log exists so the next failure is evidence straight away.
 * It is written next to the helper's log, so a problem means looking in one directory.
 *
 * A failed write is simply dropped: logging must never be what breaks the update.
 */
function logUpdater(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  console.log(`[updater] ${msg}`);
  try {
    const dir = join(app.getPath('temp'), 'steam-tracker-update');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'updater.log'), `${line}\n`);
  } catch {
    // It has to carry on without a log
  }
}

/**
 * Asks the user whether to update.
 *
 * Uses a small BrowserWindow holding a web page, **not `dialog.showMessageBox`** — that does not
 * hold up in this project; the measurement is in the comment on renderUpdatePromptHtml in updater.js.
 * This window is an ordinary web page, the same kind of thing as the Dashboard, so there is no "it
 * behaves differently in the packaged build".
 *
 * Closing the window (clicking X) counts as 「以后再说」: asking a question and then hanging because
 * the user closed the window is worse than not asking at all.
 */
function askUpdate({ version, sizeMb }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 400,
      height: 250,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: 'Steam 成就追踪器',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.destroy();
      resolve(choice);
    };

    // The page returns the choice by writing it into document.title — no preload, and therefore no
    // privileges to grant this window at all. An unrecognised title change is simply ignored (the
    // page's own <title> arrives first)
    win.webContents.on('page-title-updated', (e, title) => {
      const choice = parsePromptChoice(title);
      if (choice) {
        e.preventDefault();
        finish(choice);
      }
    });
    win.on('closed', () => finish({ update: false, skip: false }));

    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(renderUpdatePromptHtml({ version, sizeMb }))}`
    );
  });
}

/**
 * Checks for an update once; asks when there is a new version, and on a yes downloads, verifies,
 * hands over to the helper and exits.
 *
 * The whole path is in section four of docs/self-update.md. This only goes as far as "write the
 * helper script and exit"; the actual deletion and extraction happen after the process is dead —
 * because Windows will not let a running exe be replaced, and since the tray change 「关掉窗口」 no
 * longer means exiting (constraint 3).
 *
 * Returning false means "this round never got to check at all" (the window is not built yet), and the
 * caller uses that to come back sooner.
 */
async function checkForUpdate() {
  // Dev mode (npm start) has no replaceable zip directory at all, so none of this logic applies
  if (!app.isPackaged || updateBusy || app.isQuitting) return true;

  const appDir = dirname(process.execPath);
  const manifestPath = join(appDir, MANIFEST_NAME);
  const statePath = join(appDir, STATE_NAME);
  const userAgent = `SteamAchievementTracker/${app.getVersion()}`;

  /**
   * The rehearsal switch (design doc, section five): naming a tag skips the "is this an update"
   * decision, so it can be made to "downgrade" to v1.1.2 and run the whole path without cutting a
   * release.
   *
   *   $env:TRACKER_UPDATE_FORCE_TAG = 'v1.1.2'
   *   & .\dist\SteamAchievementTracker\SteamAchievementTracker.exe
   */
  const forcedTag = process.env.TRACKER_UPDATE_FORCE_TAG || null;

  /**
   * The dialog has to hang off a window that is **already displayed**.
   *
   * The first version used a parentless `dialog.showMessageBox(options)`, justified by "the window is
   * probably hidden in the tray, and attaching to it would be an invisible modal". The concern was
   * right and the solution was wrong — in a packaged build that unowned box **flashes and disappears
   * by itself**, and the promise returns immediately with an invalid response (measured: with no
   * interactive desktop available it returns values like 420, entirely outside the button range), so
   * the code reads it as 「以后再说」 and silently does nothing. This is the same illness as the
   * `window.confirm` scar in CLAUDE.md: a native dialog needs an owner, and without one it does not
   * hold up.
   *
   * The correct fix does both: bring the window to the front first, then attach a proper modal. It is
   * also more reasonable — a program that has been sitting in the tray for days and wants to ask the
   * user something should surface itself rather than pop an orphan box from behind.
   */
  if (!mainWindow) {
    // This is reached when the server starts slowly (createWindow is still inside waitForServer)
    logUpdater('窗口还没建好,这一轮跳过,过一分钟再来');
    return false;
  }

  let release;
  try {
    release = await fetchRelease({ tag: forcedTag, userAgent });
  } catch (err) {
    // **A failed check has to be silent.** Being offline is normal and having no network should not
    // raise an error box — this is the first of the design doc's three hard details
    logUpdater(`检查更新失败(忽略):${err.message}`);
    return true;
  }

  const remoteVersion = String(release?.tag_name ?? '').replace(/^v/i, '');
  const { skippedVersion } = readUpdateState(statePath);
  logUpdater(
    `当前 ${app.getVersion()},远端 ${release?.tag_name}` +
      `${forcedTag ? '(强制指定 tag,跳过版本比较)' : ''}` +
      `${skippedVersion ? `,已跳过 ${skippedVersion}` : ''}`
  );
  if (
    !forcedTag &&
    !shouldOffer({ currentVersion: app.getVersion(), remoteVersion, skippedVersion })
  ) {
    logUpdater('不需要更新');
    return true;
  }

  const { zip, manifest } = pickAssets(release?.assets);
  if (!zip) {
    logUpdater(`${release?.tag_name} 没有 win zip 附件,跳过`);
    return true;
  }
  logUpdater(`附件:${zip.name}${manifest ? ` + ${manifest.name}` : '(没有清单,会走覆盖回退)'}`);

  // Reuse the tray's 「打开面板」 path rather than copying restore/show/focus out again — mainWindow
  // has been confirmed to exist above, so this cannot fall into its window-creating branch
  showWindow();

  const choice = await askUpdate({
    version: remoteVersion,
    sizeMb: Math.round((zip.size ?? 0) / 1024 / 1024),
  });
  logUpdater(`用户选择:${choice.update ? '立即更新' : '以后再说'}${choice.skip ? '(并勾了不再提示)' : ''}`);

  if (!choice.update) {
    // Remember the skipped version (the third hard detail). Without it the prompt appears on every
    // open, and within two days the user is trained to ignore it
    if (choice.skip) writeUpdateState(statePath, { skippedVersion: remoteVersion });
    return true;
  }

  updateBusy = true;
  tray?.displayBalloon({
    icon: ICON_PATH,
    title: `正在下载 ${remoteVersion}`,
    content: '下载完会自动重启,期间可以继续用。',
  });

  const stageDir = join(app.getPath('temp'), 'steam-tracker-update');
  const zipPath = join(stageDir, zip.name);
  const newManifestPath = manifest ? join(stageDir, manifest.name) : '';

  try {
    mkdirSync(stageDir, { recursive: true });
    // Verification finishes before the exit: a failed check is treated as nothing having happened,
    // with the program still running perfectly well
    await downloadVerified(zip, zipPath, { userAgent });
    if (manifest) {
      await downloadVerified(manifest, newManifestPath, { userAgent });
      // Validate the whole thing once before letting it reach the app directory. The manifest's only
      // use is feeding the deletion loop, so one out-of-bounds path rejects the whole file rather than
      // being filtered out entry by entry
      parseManifest(readFileSync(newManifestPath, 'utf8'));
    }
  } catch (err) {
    updateBusy = false;
    logUpdater(`下载/校验失败:${err.message}`);
    // **A failure at this step is not silent.** The silence rule governs the *check* — being offline
    // is normal; here the user clicked update themselves and is waiting for a result, and no answer
    // is the worst outcome
    dialog.showErrorBox(
      'Steam 成就追踪器',
      `更新失败:${err.message}\n\n数据没有受到影响。可以稍后再试,或到 ${RELEASES_PAGE} 手动下载。`
    );
    return true;
  }
  logUpdater(`下载并校验通过:${zipPath}`);

  const scriptPath = join(stageDir, 'apply-update.ps1');
  const aliveMarkerPath = join(stageDir, ALIVE_MARKER_NAME);
  const renderedScript = renderHelperScript({
    processId: process.pid,
    appDir,
    exePath: process.execPath,
    zipPath,
    manifestPath,
    newManifestPath,
    logPath: join(stageDir, 'apply-update.log'),
    aliveMarkerPath,
  });
  writeHelperScript(scriptPath, renderedScript);
  rmSync(aliveMarkerPath, { force: true }); // a marker left over from last time must not count

  /**
   * Launch the helper, **and confirm it is really alive**, and only then exit.
   *
   * "Launched" and "alive" are two different things, and this one was bought with a real incident:
   * the first version used `spawn(..., { detached: true })`, the log said 「helper 已启动」, and in
   * fact it was killed along with app.quit() (Electron's child processes sit in a kill-on-close job
   * object, which `detached` cannot escape). What the user got was a program that closed itself and
   * never came back.
   *
   * Now: the first thing the helper does is write a marker file, and we wait for that file to appear
   * before exiting. Failing to see it means **not exiting** and saying the failure out loud — the
   * update did not happen and the program is still here, which is an acceptable degradation.
   */
  const launched = await launchHelper({ scriptPath, renderedScript, aliveMarkerPath });
  if (!launched) {
    updateBusy = false;
    dialog.showErrorBox(
      'Steam 成就追踪器',
      `更新没能开始:更新程序起不来。\n\n数据和程序都没有被改动。可以到 ${RELEASES_PAGE} 手动下载。\n\n诊断信息:${join(stageDir, 'updater.log')}`
    );
    return true;
  }

  logUpdater('helper 已确认接手,退出等待替换');
  app.quit();
  return true;
}

/** Waits for the marker file to appear, for at most timeoutMs */
async function waitForAlive(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Two launch routes, falling back to the second when the first fails — the reasoning is in the
 * comment on fallbackLaunch in updater.js: the version where this component is broken is already on
 * users' machines, and the fix has to be delivered by that same component.
 */
async function launchHelper({ scriptPath, renderedScript, aliveMarkerPath }) {
  const attempts = [
    ['start', primaryLaunch({ scriptPath })],
    ['wmi', fallbackLaunch({ script: renderedScript })],
  ];

  for (const [name, { file, args }] of attempts) {
    logUpdater(`启动 helper(${name})`);
    try {
      const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
      // A spawn launch failure is an **async** error event, not a throw. Without this listener,
      // "powershell not found" presents as a successful launch and then nothing more
      child.on('error', (err) => logUpdater(`${name} 启动失败:${err.message}`));
      child.unref();
    } catch (err) {
      logUpdater(`${name} 启动抛异常:${err.message}`);
      continue;
    }

    if (await waitForAlive(aliveMarkerPath, HELPER_ALIVE_TIMEOUT_MS)) {
      logUpdater(`helper 报到了(${name})`);
      return true;
    }
    logUpdater(`${name} 没等到 helper 报到`);
  }
  return false;
}

/**
 * The timer renews itself: only one check ever runs at a time, and only one handle needs cleaning up.
 *
 * A round that never got to check (no window yet) comes back on the short interval, so the day's only
 * opportunity is not thrown away.
 */
function scheduleUpdateCheck(delayMs) {
  updateTimer = setTimeout(async () => {
    const checked = await checkForUpdate();
    scheduleUpdateCheck(checked ? UPDATE_CHECK_INTERVAL_MS : UPDATE_CHECK_RETRY_MS);
  }, delayMs);
}

function createTray() {
  // createFromPath rather than handing the path straight to Tray: given a wrong path it returns an
  // empty image, and an empty image in the tray is an **invisible icon** — combined with closing the
  // window not exiting, the user is left with nothing but Task Manager. So this checks explicitly.
  const icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) {
    dialog.showErrorBox(
      'Steam 成就追踪器',
      `托盘图标加载失败(${ICON_PATH})。程序会继续运行,但关闭窗口后需要在任务管理器里结束进程。`
    );
  }

  tray = new Tray(icon);
  tray.setToolTip('Steam 成就追踪器');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开面板', click: showWindow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

/**
 * Only one instance is allowed. **This is not fastidiousness, it is a hard constraint imposed by the
 * hardcoded 8777** (see 「已知取舍」 in the README): a second instance would spawn its own `serve`,
 * that one necessarily hits EADDRINUSE and dies instantly, and `serverProcess.on('exit')` cannot tell
 * "the port is held by another copy of ourselves" from "the service really crashed" — so
 * double-clicking the exe a second time produces a 「后台服务意外退出(代码 1)」 error box. Neither
 * half of that message holds: it does not state the cause, and doing what it says — 「请重新打开程序」
 * — produces exactly the same thing again. Worse still, before the box appears `waitForServer`
 * **connects to the first instance's server** and really does open a window, so what the user sees is
 * "a window flashes, then an error" — the program looks broken while it is running perfectly well in
 * the tray.
 *
 * The check has to wrap the `whenReady` **registration** and cannot be moved inside the callback:
 * calling `app.quit()` before ready only queues it, and the ready callback still runs `startServer`
 * first, defeating the whole guard.
 *
 * Somebody double-clicking the exe wants 「把面板拿出来」, not 「再开一个」, so the first instance
 * receiving `second-instance` goes down the tray's `showWindow` path — restore/show/focus exists in
 * exactly one copy, shared by both entry points, so they cannot diverge one day.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    startServer();
    createTray(); // must come before the window: closing the window reads tray to show the balloon
    createWindow();
    // Dev mode has no replaceable directory, so not even the timer is needed
    if (app.isPackaged && autoUpdateEnabled()) scheduleUpdateCheck(UPDATE_CHECK_DELAY_MS);
  });
}

/**
 * All windows being closed no longer means exiting — it only means going to the tray. Leaving this
 * an empty implementation is deliberate: Electron's default behaviour without this listener (outside
 * macOS) is to quit, and that is exactly what has to be changed.
 */
app.on('window-all-closed', () => {});

/**
 * The single convergence point for every exit path: the tray's 「退出」, the app.quit() after the
 * child dies unexpectedly, and a Windows shutdown. The cleanup lives here rather than in
 * window-all-closed, which no longer triggers an exit at all.
 *
 * The order is fixed: **set isQuitting before kill**. The child's exit listener uses that flag to
 * separate "we closed it deliberately" from "it died on its own", and the other way round every
 * normal exit would first pop a 「后台服务意外退出」 error box.
 */
app.on('before-quit', () => {
  app.isQuitting = true;
  if (setupPollTimer) clearInterval(setupPollTimer);
  if (updateTimer) clearTimeout(updateTimer);
  serverProcess?.kill();
  tray?.destroy();
});
