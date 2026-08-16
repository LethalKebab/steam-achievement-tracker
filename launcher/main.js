/**
 * Electron 启动器主进程
 * ------------------------------------------------
 * 本身不含任何业务逻辑——只是把已有的 tracker.js serve 当子进程拉起来,
 * 起一个窗口指向它的本地地址。真正的服务器、数据库、Steam/Notion 调用
 * 全部原样跑在子进程里,和 `node tracker.js serve` 完全一样。
 *
 * 子进程用 Electron 自带的 Node(ELECTRON_RUN_AS_NODE=1 让 electron.exe
 * 表现得像普通 node 可执行文件)——已经验证过 node:sqlite 在这条路径下能跑,
 * 不需要额外打包一份独立的 Node 运行时。
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

/** 启动后隔一会儿再查,别和服务器启动、首次同步抢带宽 */
const UPDATE_CHECK_DELAY_MS = 10_000;
/**
 * 之后每天查一次。**不能只在启动时查** —— 收进托盘之后进程可以连着跑几天,
 * 「启动」变成了很稀少的事件(和 maybeAutoSync 当初被迫从进程启动搬到窗口显示
 * 是同一个原因)。挂在窗口显示上则太吵:一天开合十次不该查十次。
 */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * 窗口还没建好就查不了(要拿它当对话框的父窗口),过一分钟再来 —— 不能直接
 * 跳到 24 小时后:服务器启动慢的时候(waitForServer 最多等 15 秒)窗口会晚于
 * 第一次检查出现,那样等于白白丢掉这一天唯一的机会,而且不会有任何征兆。
 */
const UPDATE_CHECK_RETRY_MS = 60_000;
/**
 * 等 helper 报到的上限。PowerShell 冷启动一两秒是常事,给到 15 秒;
 * 等不到就换备用路子,再等不到就报错并且**不退出**。
 */
const HELPER_ALIVE_TIMEOUT_MS = 15_000;

// 开发模式(`npm start`)下核心文件就在上一级目录;打包后由 electron-builder 的
// extraResources 复制进 resources/tracker(见 package.json 的 build 配置)。
const TRACKER_ROOT = app.isPackaged ? join(process.resourcesPath, 'tracker') : join(__dirname, '..');

/**
 * 把打包版指回一份已有 CLI 数据的开关。**优先找 exe 旁边那份**,而不是
 * app.getPath('userData')(%APPDATA%\<productName>):userData 看着更"正规",
 * 但它在用户配置文件目录下,容易被各种沙箱/虚拟化机制重定向——同一个绝对路径,
 * 不同来源的进程看到的内容可能不一样,排查起来极其费劲(这个坑真踩过一次)。
 * exe 旁边这份跟着程序本体走,谁启动都是同一个文件,没有第二种解释。
 *
 * userData 仍然作为备选保留:想让配置活过"删掉整个文件夹重新解压"的话可以放那儿。
 * 两处都没有(分发给别人的包就是这种情况)就返回 null,数据落在 exe 旁边,
 * 和没有这个功能时完全一样。
 *
 * dist/ 每次 build 都会重建,所以 exe 旁边那份由 package.json 的 build 脚本
 * 从 launcher/local.config.json 自动复制过去——源文件在 launcher/ 下,不受 build 影响。
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
      // 指到一个不存在的目录就当没配过。整个文件夹被拷到另一台机器、或者那份 CLI
      // checkout 被移走时会是这样——这时候退回"数据放 exe 旁边"能正常打开,
      // 总好过拿着一个死路径去建数据库然后启动失败。
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
       * stderr 走管子而不是 inherit。**打包版根本没有控制台** —— 子进程死之前
       * 打的那句话原样落进一个不存在的终端,于是启动器手里只剩一个退出码,
       * 错误框也就只能说「代码 1」,而那句话本来是唯一说得清原因的东西。
       * 收下来只为了在框里复述它;stdout 仍然 inherit,dev 模式的日志照旧。
       */
      stdio: ['inherit', 'inherit', 'pipe'],
    }
  );

  // setEncoding 不是顺手写的:中文报错在字节边界上被切开时,拼字符串会拼出乱码
  serverProcess.stderr.setEncoding('utf8');
  let stderrTail = '';
  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(chunk); // dev 模式下 `npm start` 的终端照样看得见
    stderrTail = (stderrTail + chunk).slice(-2000); // 只留尾巴,要的是最后那句话
  });

  serverProcess.on('exit', (code) => {
    // 主动关闭时 app.isQuitting 已经置位,这里只处理"子进程自己意外挂了"的情况——
    // 没有服务器就没有 Dashboard 可看,留着空窗口不如直接退出并说明原因
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
 * 从子进程 stderr 里挑出**一句能给人看的话**。
 *
 * `tracker.js` 的顶层 catch 打的是 `❌ <message>`(端口被占、配置读不了、
 * 数据库打不开都走这条),所以有 ❌ 就取最后一条 ❌。
 *
 * 没有 ❌ 的是 Node 自己崩了那种,这时候要的是堆栈的**头一行**(`Error: …`)。
 * 「取最后一行非空」在这里恰恰是最差的选择,实测过:堆栈的末尾是 `at Module._load`
 * 或者一个光秃秃的 `}`,说的是崩在哪儿,不是崩了什么 —— 拿它当错误框的正文,
 * 等于把唯一那句人话跳过去。两条都落空才退回最后一行:**宁可给一行看不懂的东西,
 * 也好过只给一个「代码 1」**,前者能搜、能贴给开发者,后者连搜都没得搜。
 */
function lastErrorLine(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const marked = lines.filter((l) => l.startsWith('❌'));
  const thrown = lines.find((l) => /^[\w.$]*Error\b/.test(l));
  // 挑完就把 ❌ 去掉:它是 CLI 用来在一屏日志里标出这行的,而错误框自带一个红叉,
  // 留着就是同一句话说两遍
  const line = (marked.at(-1) ?? thrown ?? lines.at(-1)).replace(/^❌\s*/, '');
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** 轮询直到服务器有响应(不关心状态码,能连上就算活着) */
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
 * 停在 /setup 页面时轮询 getSetupStatus——一旦配置完成就跳回 Dashboard。
 * 不需要重启子进程:lib/api.js 的 completeSetup 会当场把 config/steam 的内存状态
 * 也改掉,这个正在跑的子进程立刻就是可用状态。
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
      // 单次轮询失败(服务器正忙)跳过,下一轮再试
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
   * 页面里 `target="_blank"` 的链接(攻略、Notion 页面)一律交给系统浏览器。
   *
   * **不设这个的话 Electron 会自己开一个裸窗口**,而那个窗口:标题回落成
   * package.json 里的 `steam-achievement-tracker-launcher`(用户看到的就是这个),
   * 没有地址栏、没有后退,更要命的是**没有用户的 Notion 登录态** —— 攻略页在里面
   * 打不开,只会显示登录墙。这些链接指向的本来就是站外内容,归浏览器管。
   *
   * 只放行 http/https:`deny` 之外还要挡住 file:// 之类的协议,别把本地文件
   * 交给系统去执行。
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(BASE_URL);

  // / 在没配置时会 302 到 /setup——loadURL 完成后 getURL() 是跳转后的最终地址
  if (mainWindow.webContents.getURL().includes('/setup')) {
    console.log('[launcher] landed on /setup, polling for completion');
    pollSetupStatus();
  }

  /**
   * 关窗口 = 收进托盘,不退出。真正的退出只有托盘菜单那一条路,`app.isQuitting`
   * 是两者的分界 —— 退出流程里这个 close 事件还会再来一次,那次必须放行,
   * 否则 preventDefault 会把 app 卡在"永远退不掉"。
   */
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWindow.hide();

    // 后台运行最经典的抱怨是"我关了它怎么还在跑"。托盘图标在 Windows 上默认被
    // 折叠进溢出区,不主动说一次,用户根本不知道该去哪找它。只提示一次。
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
   * 自动同步原本挂在服务器启动上(`startupJobs` 里的 `maybeAutoSync`,全项目
   * 唯一调用点)。以前每次开 app 都是一次新进程,所以"开一次 app = 查一次是否
   * 过期"。收进托盘之后进程可以连着跑几天,那条触发就再也不会响 —— 数据会一直
   * 停在打开那天,而且不报错,只是 Dashboard 上的数字不动了。
   *
   * 所以把触发点从"进程启动"搬到"窗口显示",语义保持原样:打开面板时查一次
   * 新鲜度。`syncStaleHours` 的闸门还在 maybeAutoSync 里,所以频繁开关窗口
   * 不会变成频繁同步。
   */
  mainWindow.on('show', () => {
    fetch(`${BASE_URL}api/maybeSync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    }).catch(() => {
      // 服务器正忙或刚起来,下次显示窗口再说——这不是用户需要知道的事
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
 * 自动更新的开关 —— 设计文档三个死细节里的「要能关掉」。
 *
 * 放在 local.config.json:那已经是 launcher 唯一的本机配置文件,不值得为一个
 * 布尔值再开第二处。没写就是开着。
 */
function autoUpdateEnabled() {
  for (const path of localConfigCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')).autoUpdate;
      if (typeof v === 'boolean') return v;
    } catch {
      // 坏文件跳过,和 loadDataDirOverride 一个态度
    }
  }
  return true;
}

/**
 * 更新器这一半的日志。
 *
 * helper 从一开始就有日志,app 这一半没有 —— 于是第一次真实排练里「弹窗闪了
 * 一下就没了」只能靠猜,一个来回才问出它到底走了哪个分支。这条日志就是为了
 * 让下一次失败直接变成证据。写在 helper 日志旁边,出事只要看一个目录。
 *
 * 写不进去就算了:日志失败绝不能反过来把更新弄挂。
 */
function logUpdater(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  console.log(`[updater] ${msg}`);
  try {
    const dir = join(app.getPath('temp'), 'steam-tracker-update');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'updater.log'), `${line}\n`);
  } catch {
    // 没日志也得继续
  }
}

/**
 * 问用户要不要更新。
 *
 * 用一个小的 BrowserWindow 装一张网页,**不用 `dialog.showMessageBox`** ——
 * 那个在这个项目里立不住,实测见 updater.js 里 renderUpdatePromptHtml 的注释。
 * 这个窗口就是普通网页,和 Dashboard 是同一种东西,不存在"打包版里不一样"。
 *
 * 关掉窗口(点 X)当作「以后再说」:问一个问题却因为用户关了窗口就卡住,
 * 比问都不问更糟。
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

    // 页面把选择写进 document.title 回传 —— 不用 preload,也就不用给这个窗口
    // 开任何特权。认不出来的标题变化直接忽略(页面自己的 <title> 就会先来一次)
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
 * 查一次更新;有新版就问,答应了就下载、校验、交给 helper、退出。
 *
 * 整条路径见 docs/self-update.md 第四节。这里只做到「写好 helper 脚本并退出」,
 * 真正的删除和解压发生在进程死掉之后 —— 因为 Windows 不让替换正在运行的 exe,
 * 而托盘改动之后「关掉窗口」并不等于退出(约束 3)。
 *
 * 返回 false 表示「这一轮根本没查成」(窗口还没建好),调用方据此早点再来一次。
 */
async function checkForUpdate() {
  // dev 模式(npm start)根本没有可替换的 zip 目录,整套逻辑无从谈起
  if (!app.isPackaged || updateBusy || app.isQuitting) return true;

  const appDir = dirname(process.execPath);
  const manifestPath = join(appDir, MANIFEST_NAME);
  const statePath = join(appDir, STATE_NAME);
  const userAgent = `SteamAchievementTracker/${app.getVersion()}`;

  /**
   * 排练开关(设计文档第五节):指定 tag 时跳过「是不是更新」的判断,于是可以
   * 让它「降级」到 v1.1.2,不发新版就把整条路径跑一遍。
   *
   *   $env:TRACKER_UPDATE_FORCE_TAG = 'v1.1.2'
   *   & .\dist\SteamAchievementTracker\SteamAchievementTracker.exe
   */
  const forcedTag = process.env.TRACKER_UPDATE_FORCE_TAG || null;

  /**
   * 对话框必须挂在一个**已经显示出来的**窗口上。
   *
   * 第一版是无父窗口的 `dialog.showMessageBox(options)`,理由是「窗口多半藏在
   * 托盘里,挂上去就是个看不见的模态框」。顾虑没错,解法错了 —— 打包版里那个
   * 没有归属的框**自己闪一下就消失**,promise 立刻带着一个非法的 response 返回
   * (实测在拿不到交互桌面时会返回 420 这种根本不在按钮范围里的值),于是代码
   * 读成「以后再说」,静默地什么也没做。这正是 CLAUDE.md 里 `window.confirm`
   * 那道疤的同一种病:原生对话框需要一个归属,没有归属就立不住。
   *
   * 正确的解法是把两件事都做了:先把窗口叫到前面来,再挂一个正经的模态框。
   * 顺带也更合理 —— 要问用户问题,一个在托盘里躺了几天的程序本来就该自己
   * 冒出来,而不是从背后弹一个孤儿框。
   */
  if (!mainWindow) {
    // 服务器起得慢的时候会走到这儿(createWindow 还在 waitForServer 里)
    logUpdater('窗口还没建好,这一轮跳过,过一分钟再来');
    return false;
  }

  let release;
  try {
    release = await fetchRelease({ tag: forcedTag, userAgent });
  } catch (err) {
    // **检查失败必须静默。** 离线是常态,没网不该弹错误框——这是设计文档
    // 三个死细节的第一条
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

  // 复用托盘「打开面板」那条路径,别把 restore/show/focus 再抄一遍 ——
  // 上面已经确认过 mainWindow 存在,所以这里不会走进它建窗口的分支
  showWindow();

  const choice = await askUpdate({
    version: remoteVersion,
    sizeMb: Math.round((zip.size ?? 0) / 1024 / 1024),
  });
  logUpdater(`用户选择:${choice.update ? '立即更新' : '以后再说'}${choice.skip ? '(并勾了不再提示)' : ''}`);

  if (!choice.update) {
    // 记住跳过的版本(第三个死细节)。不记的话每次开都弹一遍,两天就被训练成无视
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
    // 校验在退出之前做完:验不过就当无事发生,程序还好好地开着
    await downloadVerified(zip, zipPath, { userAgent });
    if (manifest) {
      await downloadVerified(manifest, newManifestPath, { userAgent });
      // 整份校验一次再让它落到 app 目录里。清单唯一的用途是喂删除循环,
      // 有一条越界路径就整份拒收,而不是逐条过滤
      parseManifest(readFileSync(newManifestPath, 'utf8'));
    }
  } catch (err) {
    updateBusy = false;
    logUpdater(`下载/校验失败:${err.message}`);
    // **这一步的失败不静默。** 静默那条规则管的是"检查"——离线是常态;
    // 这里是用户自己点的更新,他正在等结果,没有回音才是最坏的
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
  rmSync(aliveMarkerPath, { force: true }); // 上一次留下的标记不能算数

  /**
   * 启动 helper,**并且确认它真的活着**,然后才退出。
   *
   * 「启动了」和「活着」是两回事,这一条是拿一次真实事故换来的:第一版用
   * `spawn(..., { detached: true })`,日志写着「helper 已启动」,实际上它随着
   * app.quit() 一起被杀了(Electron 的子进程在一个 kill-on-close 的作业对象里,
   * `detached` 逃不出去)。用户得到的是一个自己关掉、再也不回来的程序。
   *
   * 现在:helper 起来的第一件事是写一个标记文件,我们等到那个文件出现才退出。
   * 等不到就**不退**,把失败说出来 —— 更新没成、程序还在,这个降级是可接受的。
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

/** 等标记文件出现,最多 timeoutMs */
async function waitForAlive(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 两条启动路子,主路不行就换备用 —— 理由见 updater.js 里 fallbackLaunch 的注释:
 * 这个组件坏掉的那一版已经在用户机器上了,修复要靠它自己送过去。
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
      // spawn 的启动失败是**异步**的 error 事件,不是抛异常。没有这个监听,
      // 「找不到 powershell」会表现成"启动成功"然后石沉大海
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
 * 自己续自己的定时器:一次只会有一个检查在跑,也只需要清理一个句柄。
 *
 * 没查成(窗口还没建好)就用短间隔重来,别把这一天唯一的机会丢掉。
 */
function scheduleUpdateCheck(delayMs) {
  updateTimer = setTimeout(async () => {
    const checked = await checkForUpdate();
    scheduleUpdateCheck(checked ? UPDATE_CHECK_INTERVAL_MS : UPDATE_CHECK_RETRY_MS);
  }, delayMs);
}

function createTray() {
  // createFromPath 而不是把路径直接交给 Tray:路径错了它会返回一张空图,
  // 而空图在托盘里是**看不见的图标** —— 那时候关窗口又不退出,用户就只剩
  // 任务管理器一条路了。所以这里显式检查。
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
 * 只允许一个实例。**这不是洁癖,是 8777 写死带来的硬约束**(见 README 的
 * 「已知取舍」):第二个实例照样会去 spawn 一份 `serve`,那份必然撞 EADDRINUSE
 * 秒退,而 `serverProcess.on('exit')` 分不清「端口被自己的另一份占着」和
 * 「服务真的崩了」—— 于是双击第二次 exe 得到的是一个
 * 「后台服务意外退出(代码 1)」的错误框。那条信息哪一半都不成立:它没说原因,
 * 而照它说的「请重新打开程序」做,只会一模一样地再来一次。更难看的是弹框之前
 * `waitForServer` 会**连上第一个实例的服务器**并且真把窗口开出来,所以用户看到的
 * 是"窗口闪一下,然后一个报错" —— 程序看起来是坏的,其实它好好地在托盘里跑着。
 *
 * 判断必须包住 `whenReady` 的**注册**,不能挪进回调里去判:ready 之前调
 * `app.quit()` 只是排了个队,ready 回调照样会先跑一遍 `startServer`,那就白防了。
 *
 * 双击 exe 的人想要的是「把面板拿出来」,不是「再开一个」,所以第一个实例收到
 * `second-instance` 就走托盘那条 `showWindow` —— restore/show/focus 只此一份,
 * 两个入口共用,不会有一天走岔。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    startServer();
    createTray(); // 必须在窗口之前:关窗口会去读 tray 发气泡提示
    createWindow();
    // dev 模式没有可替换的目录,连定时器都不用起
    if (app.isPackaged && autoUpdateEnabled()) scheduleUpdateCheck(UPDATE_CHECK_DELAY_MS);
  });
}

/**
 * 窗口全关了不再等于退出 —— 那只是收进了托盘。留成空实现是有意的:
 * Electron 在没有这个监听时的默认行为(非 macOS)就是退出,而那正是要改掉的。
 */
app.on('window-all-closed', () => {});

/**
 * 所有退出路径的唯一汇合点:托盘「退出」、子进程意外挂掉后的 app.quit()、
 * Windows 关机。清理放这里而不是 window-all-closed,后者现在根本不再触发退出。
 *
 * 顺序是死的:**先置 isQuitting 再 kill**。子进程的 exit 监听靠这个标志区分
 * "我们主动关的"和"它自己挂了",反过来的话每次正常退出都会先弹一个
 * 「后台服务意外退出」的错误框。
 */
app.on('before-quit', () => {
  app.isQuitting = true;
  if (setupPollTimer) clearInterval(setupPollTimer);
  if (updateTimer) clearTimeout(updateTimer);
  serverProcess?.kill();
  tray?.destroy();
});
