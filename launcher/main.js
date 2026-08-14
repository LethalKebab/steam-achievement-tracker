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
import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8777;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

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
function loadDataDirOverride() {
  const candidates = [
    join(dirname(process.execPath), 'local.config.json'),
    join(app.getPath('userData'), 'local.config.json'),
    join(__dirname, 'local.config.json'),
  ];

  for (const path of candidates) {
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
      stdio: 'inherit',
    }
  );

  serverProcess.on('exit', (code) => {
    // 主动关闭时 app.isQuitting 已经置位,这里只处理"子进程自己意外挂了"的情况——
    // 没有服务器就没有 Dashboard 可看,留着空窗口不如直接退出并说明原因
    if (app.isQuitting) return;
    dialog.showErrorBox(
      'Steam 成就追踪器',
      `后台服务意外退出(代码 ${code})。请重新打开程序;如果反复出现,请联系开发者。`
    );
    app.quit();
  });
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  app.isQuitting = true;
  if (setupPollTimer) clearInterval(setupPollTimer);
  serverProcess?.kill();
  app.quit();
});
