/**
 * 自更新 —— 除「真正动磁盘」以外的全部逻辑
 * ------------------------------------------------
 * 这个文件**不 import electron**,所以 `node --test` 能直接加载它。设计文档
 * (docs/self-update.md 第五节)列出的「可单测的」四件事全在这里:清单生成、
 * 版本比对、sha256 校验、跳过版本的记忆。main.js 只负责把它接上对话框和退出。
 *
 * 三条硬约束(同文档第三节)在这里的落点:
 *
 * 1. **删除只按清单**(上一版装了哪些文件),绝不按「保留名单」。用户数据和
 *    程序文件同层(`resources/tracker/`),保留名单漏一项就是删掉用户的数据库,
 *    而清单漏一项只是留下一个多余文件 —— 两种写法的失败方向相反,这是全部理由。
 * 2. **清单缺失时退回覆盖**,绝不推断哪些文件是程序文件。
 * 3. **替换必须发生在进程真的退出之后**,由 helper 等 PID 完成。托盘之后
 *    「关掉窗口」不等于退出,exe 还锁着。
 *
 * 清单为什么是**单独的发布附件**而不是打进 zip:zip 由 electron-builder 生成,
 * postbuild 拿到它时已经封好了,清单又要描述这个 zip 的内容 —— 打进去是循环的。
 * 于是清单跟 zip 一起发布,由 helper 在解压后写进 app 目录。副作用正好是想要的:
 * 全新解压的用户手上没有清单,第一次更新自然走约束 2 的覆盖路径,不需要特例。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 换成自己的仓库就改这一行。公开仓库,不需要 token(未认证 60 次/小时,一天查一次绰绰有余) */
export const REPO = 'LethalKebab/steam-achievement-tracker';

/** 装在 app 目录里的那份清单 —— 描述「当前这一版装了什么」 */
export const MANIFEST_NAME = 'update-manifest.json';

/**
 * helper 起来之后**头一件事**写的标记文件。
 *
 * 存在的理由是一次真实事故:app 退了,helper 没接上,用户面对一个自己关掉、
 * 再也不回来的程序 —— 而 app 那边日志还写着「helper 已启动」,因为 `spawn()`
 * 返回从来就不代表进程真的起来了(启动失败走的是 `error` 事件)。
 *
 * 现在的顺序是:启动 helper → **等这个文件出现** → 才 app.quit()。等不到就
 * 不退,报错给用户看。最坏结果从「程序没了」降级成「更新没成,但程序还在」。
 */
export const ALIVE_MARKER_NAME = 'helper-alive.txt';
/** 跳过的版本记在这里。不在任何清单里,所以更新永远不会删掉它 */
export const STATE_NAME = 'update-state.json';

export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const API_ROOT = `https://api.github.com/repos/${REPO}/releases`;
const FETCH_TIMEOUT_MS = 20_000;
/**
 * 下载的上限,给得很宽(133MB / 30 分钟 ≈ 75 KB/s)。存在的意义不是"够不够快",
 * 而是**卡住的连接必须有个头**:没有上限的话 checkForUpdate 会永远停在 await 上,
 * 那个自己续自己的定时器也就再也不续了 —— 更新从此静默停止,直到重启程序。
 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------- 版本比对

/** `v1.1.3` / `1.1.3-beta.2` → `[1, 1, 3]`。预发布后缀直接丢掉 */
function versionParts(v) {
  return String(v ?? '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0);
}

/** a 比 b 新返回正数,旧返回负数,一样返回 0 */
export function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 该不该弹这个版本。
 *
 * 跳过是**按版本记**而不是「今天别烦我」:设计文档把「记住用户跳过的版本」
 * 列为三个死细节之一 —— 每次开都弹一遍,两天就被训练成无视了。跳过 1.2.0
 * 之后 1.2.1 出来照样弹,因为那是另一个版本。
 */
export function shouldOffer({ currentVersion, remoteVersion, skippedVersion = null }) {
  if (!remoteVersion) return false;
  if (compareVersions(remoteVersion, currentVersion) <= 0) return false;
  if (skippedVersion && compareVersions(remoteVersion, skippedVersion) <= 0) return false;
  return true;
}

// ---------------------------------------------------------------- 发布附件

/**
 * 从 release 的附件里挑出 zip 和清单。
 *
 * 清单挑不到不是错 —— 1.1.3 及以前的发布本来就没有。那种情况下这次更新照常做,
 * 只是做完之后 app 目录里不留清单,下一次更新再走一遍覆盖。
 */
export function pickAssets(assets = []) {
  const nameOf = (a) => String(a?.name ?? '');
  return {
    zip: assets.find((a) => /-win\.zip$/i.test(nameOf(a))) ?? null,
    manifest: assets.find((a) => /-manifest\.json$/i.test(nameOf(a))) ?? null,
  };
}

/**
 * GitHub 每个附件自带 `digest: "sha256:…"`。认不出来就返回 null,而**调用方必须
 * 因此拒绝更新** —— 校验不了就等于要用户执行一份没验过的 133MB 可执行文件。
 * 宁可更新不了,不要装一份来路不明的。
 */
export function sha256FromDigest(digest) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export async function hashFile(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

// ---------------------------------------------------------------- 清单

/**
 * 清单里的路径必须是**规规矩矩的相对路径**。
 *
 * 清单是从网上下来的,而它唯一的用途是喂给一个删除循环。盘符、开头的斜杠、
 * `..` 任何一样都可能让删除跑到 app 目录外面去。helper 里还有一道边界检查,
 * 这里是第一道 —— 不合格的清单整份拒收,而不是逐条过滤:一份带越界路径的清单
 * 本身就说明它不是我们发的,剩下的部分同样不可信。
 */
export function isSafeManifestPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // 盘符
  if (/^[/\\]/.test(p)) return false; // 绝对路径 / UNC
  return p.split(/[/\\]/).every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** 解析并校验一份清单文本。不合格直接抛 —— 调用方据此放弃更新 */
export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('清单不是合法的 JSON');
  }
  const files = raw?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('清单里没有文件列表');
  const bad = files.find((f) => !isSafeManifestPath(f));
  if (bad !== undefined) throw new Error(`清单里有越界路径:${String(bad)}`);
  return { version: typeof raw.version === 'string' ? raw.version : '', files };
}

/**
 * 本机专属、绝不属于程序本体的文件。
 *
 * 目前只有一个:`local.config.json`(把打包版指回一份已有 CLI 数据的指针)。
 * 它进了清单就等于下次更新会把它当程序文件删掉 —— 用户的数据目录会静默地
 * 跳回默认位置,表现是"我的数据全没了"。postbuild 生成清单时排在复制它之前,
 * 顺序是机制,这个检查是安全网 —— 顺序是人改的。
 */
export const MACHINE_LOCAL_FILES = ['local.config.json'];

/** 清单里混进了哪些本机专属文件(空数组 = 干净) */
export function machineLocalEntries(files = []) {
  return files.filter((f) => {
    const base = String(f).split(/[/\\]/).pop()?.toLowerCase();
    return MACHINE_LOCAL_FILES.includes(base);
  });
}

/**
 * 走一遍目录,列出所有文件的相对路径 —— 打包时用来生成清单。
 *
 * 读的是 electron-builder 解包出来的目录,而不是去解析 zip:那个目录**就是**
 * zip 的内容,而且正是用户解压之后磁盘上的样子。只收文件不收目录,因为删除
 * 阶段只删文件;目录靠「空了才删」清理,这样 `resources/tracker/data/` 这种
 * 装着数据库的目录永远不会被碰到。
 */
export function buildManifest(rootDir, version) {
  const files = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(rootDir, '');
  return { version: String(version), files };
}

// ---------------------------------------------------------------- 跳过的版本

/**
 * 状态文件放在 exe 旁边,不放 `app.getPath('userData')`。
 * 理由和 local.config.json 那条一样(launcher/README.md):userData 在
 * 沙箱/虚拟化进程里会被静默重定向,同一个绝对路径对不同进程指向不同内容。
 *
 * 读写失败一律当作「没记住」—— app 目录只读(比如解压到 Program Files)时
 * 不该因此弹任何东西出来。
 */
export function readUpdateState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return { skippedVersion: typeof s?.skippedVersion === 'string' ? s.skippedVersion : null };
  } catch {
    return { skippedVersion: null };
  }
}

export function writeUpdateState(path, state) {
  try {
    writeFileSync(path, `${JSON.stringify({ skippedVersion: state?.skippedVersion ?? null }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 网络

function ghHeaders(userAgent) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': userAgent, // GitHub API 不带 UA 直接 403
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * 取一个 release。`tag` 为空取 latest。
 *
 * 指定 tag 是**排练用的**:设计文档第五节的验证办法是让它指向 v1.1.2 做一次
 * 「降级」,不用发新版就能把「下载 → 校验 → 按清单删 → 解压 → 重启」整条路径
 * 跑一遍。main.js 从 `TRACKER_UPDATE_FORCE_TAG` 读这个值。
 */
export async function fetchRelease({ tag = null, userAgent = 'SteamAchievementTracker', fetchImpl = fetch } = {}) {
  const url = tag ? `${API_ROOT}/tags/${encodeURIComponent(tag)}` : `${API_ROOT}/latest`;
  const res = await fetchImpl(url, {
    headers: ghHeaders(userAgent),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

export async function downloadTo(url, dest, { userAgent = 'SteamAchievementTracker', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  if (!res.body) throw new Error('下载失败:响应没有内容');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/**
 * 下载并按 GitHub 给的 digest 校验。digest 认不出来就拒绝,理由见 sha256FromDigest。
 *
 * 失败时把半截文件删掉:这里下的是 133MB,反复失败会在 temp 里堆出好几百兆,
 * 而且一个校验不过的包留在磁盘上没有任何用处。
 */
export async function downloadVerified(asset, dest, opts = {}) {
  const want = sha256FromDigest(asset?.digest);
  if (!want) throw new Error(`${asset?.name ?? '附件'} 没有可用的 sha256,拒绝安装`);
  try {
    await downloadTo(asset.browser_download_url, dest, opts);
    const got = await hashFile(dest);
    if (got !== want) {
      throw new Error(`${asset.name} 校验不通过(期望 ${want.slice(0, 12)}…,实际 ${got.slice(0, 12)}…)`);
    }
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
  return dest;
}

// ---------------------------------------------------------------- 更新提示界面

/** 选择结果通过 document.title 回传,这是标题的前缀 */
export const PROMPT_TITLE_PREFIX = 'choice:';

/**
 * 更新提示是**一个真正的网页**,不是原生对话框。
 *
 * 这不是偏好问题,是实测:`dialog.showMessageBox` 在这个项目里根本立不住 ——
 * 框闪一下就消失,promise 立刻返回一个不在按钮范围里的 `response: 420`。
 * 把选项拆到只剩 `{ message }`、换成同步版 `showMessageBoxSync`、挂父窗口、
 * 不挂父窗口,十种组合全是 420;而同一台机器上纯 Win32 的 MessageBox 立得好好的。
 * 所以问题出在 Electron 这一层,不是系统。
 *
 * **这是这个仓库第二次撞上同一类事。** 第一次是渲染进程的 `window.confirm`,
 * 「生成攻略」在打包版里整个是死的(CLAUDE.md 有记录),当时的结论写成了
 * 「原生对话框归主进程所有」—— 那个结论太窄了,主进程的一样不能用。仓库当时
 * 给出的解法是 `askConfirm`,一个页面内的组件,「在浏览器和打包版里完全一致」。
 * 这里走的是同一条路。
 *
 * 结果靠 `document.title` 回传,不用 preload、不用 IPC:窗口里没有任何需要
 * 特权的东西,而 `page-title-updated` 是一定会触发的。
 */
export function renderUpdatePromptHtml({ version, sizeMb }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Steam 成就追踪器</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #f7f7f8; --muted: #6b6b70; --line: #d8d8dc; --accent: #2f6fed; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eaeaec; --bg: #26262a; --muted: #a0a0a8; --line: #3d3d44; --accent: #5a8cf5; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 22px 24px; font: 14px/1.6 "Microsoft YaHei", system-ui, sans-serif;
         color: var(--fg); background: var(--bg); user-select: none; }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
  p { margin: 0 0 18px; color: var(--muted); }
  label { display: flex; align-items: center; gap: 7px; margin-bottom: 18px; color: var(--muted); cursor: pointer; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  button { font: inherit; padding: 7px 18px; border-radius: 6px; border: 1px solid var(--line);
           background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style></head>
<body>
  <h1>有新版本 ${esc(version)}</h1>
  <p>下载约 ${esc(sizeMb)} MB,完成后会自动重启。</p>
  <label><input type="checkbox" id="skip">不再提示这个版本</label>
  <div class="row">
    <button id="later">以后再说</button>
    <button id="now" class="primary">立即更新</button>
  </div>
<script>
  // 结果走 document.title —— 主进程监听 page-title-updated。不需要 preload,
  // 也就不需要给这个窗口开任何特权
  var sent = false;
  function choose(what) {
    if (sent) return;
    sent = true;
    document.title = ${JSON.stringify(PROMPT_TITLE_PREFIX)} + what + ':' + (document.getElementById('skip').checked ? '1' : '0');
  }
  document.getElementById('now').onclick = function () { choose('update'); };
  document.getElementById('later').onclick = function () { choose('later'); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') choose('later'); });
  document.getElementById('now').focus();
</script>
</body></html>`;
}

/** 解析上面那个页面回传的标题。认不出来返回 null(普通的标题变化会走到这儿) */
export function parsePromptChoice(title) {
  const m = new RegExp(`^${PROMPT_TITLE_PREFIX}(update|later):(0|1)$`).exec(String(title ?? ''));
  return m ? { update: m[1] === 'update', skip: m[2] === '1' } : null;
}

// ---------------------------------------------------------------- helper 脚本

/** PowerShell 单引号字符串:内部的单引号写成两个。和 postbuild.js 里那个同源 */
const psQuote = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

/**
 * 生成那份接管替换的 PowerShell 脚本。
 *
 * 依然零运行时依赖 —— `Expand-Archive` 是 PowerShell 自带的,`postbuild.js`
 * 早就在借 `WScript.Shell` 建快捷方式,有先例。
 *
 * **参数是烤进脚本里的,不走命令行。** 路径里可能有中文和空格,而命令行参数要
 * 再经过一层引号规则;烤进去只需要 psQuote 一种转义,少一整类 bug。脚本是
 * 一次性的,写在 temp 里,用完就没人再看。
 *
 * 脚本本身**必须带 BOM 存成 UTF-8**(见 writeHelperScript):PowerShell 5.1
 * 没有 BOM 时按 ANSI 代码页读 .ps1,中文路径和中文提示会全变成问号。
 */
export function renderHelperScript({
  processId,
  appDir,
  exePath,
  zipPath,
  manifestPath,
  newManifestPath = '',
  logPath,
  aliveMarkerPath,
  releasesPage = RELEASES_PAGE,
}) {
  return `$ErrorActionPreference = 'Stop'

# 注意:不能叫 $Pid —— 那是 PowerShell 的只读自动变量
$ProcessId   = ${Number(processId)}
$AppDir      = ${psQuote(appDir)}
$ExePath     = ${psQuote(exePath)}
$ZipPath     = ${psQuote(zipPath)}
$Manifest    = ${psQuote(manifestPath)}
$NewManifest = ${psQuote(newManifestPath)}
$LogPath     = ${psQuote(logPath)}
$AliveMarker = ${psQuote(aliveMarkerPath)}

function Log($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Out-File -FilePath $LogPath -Append -Encoding utf8 }

try {
  # --- 0. 报到 ---
  # app 会等这个文件出现才退出。**必须是第一件事**:在此之前 app 什么都不做,
  # 所以哪怕 PowerShell 起不来,最坏也只是"更新没成,程序还在",而不是
  # "程序自己退了,再也没回来" —— 后者真的发生过一次
  Set-Content -LiteralPath $AliveMarker -Value 'alive'
  Log '已报到,开始接手'

  # --- 1. 等进程真的退出 ---
  # 约束 3:托盘改动之后关窗口只是隐藏,exe 还锁着。没等干净就替换,Windows
  # 会拒绝,而且报出来的错跟真正的原因毫无关系
  Log "等待主进程 $ProcessId 退出"
  try { Wait-Process -Id $ProcessId -Timeout 120 -ErrorAction Stop } catch { }

  # 文件锁比进程退出晚半拍。轮询到 exe 能以独占方式打开为止,最多 20 秒
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $fs = [System.IO.File]::Open($ExePath, 'Open', 'ReadWrite', 'None')
      $fs.Close()
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }

  # --- 2. 按清单删 ---
  # 只删「上一版装了哪些文件」。清单不在(从 <=1.1.3 升上来的用户)就整段跳过,
  # 退回今天的覆盖行为 —— 绝不推断哪些文件是程序文件(约束 2)。
  # 老用户会有最后一次脏覆盖,之后永远干净,这个代价是明确接受的
  if (Test-Path -LiteralPath $Manifest -PathType Leaf) {
    $AppDirFull = [System.IO.Path]::GetFullPath($AppDir)
    if (-not $AppDirFull.EndsWith('\\')) { $AppDirFull += '\\' }
    $entries = (Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json).files
    $removed = 0
    foreach ($rel in $entries) {
      $full = [System.IO.Path]::GetFullPath((Join-Path $AppDir $rel))
      # 越界的直接跳过。JS 那边已经整份校验过一次,这是删除循环自己的最后一道
      if (-not $full.StartsWith($AppDirFull, [StringComparison]::OrdinalIgnoreCase)) {
        Log "越界,跳过:$rel"
        continue
      }
      # PathType Leaf:**只删文件**。目录从来不进清单,真出现了也不删
      if (Test-Path -LiteralPath $full -PathType Leaf) {
        Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
        $removed++
      }
    }
    Log "按清单删除 $removed 个文件"

    # 空目录才删。resources/tracker/data 里躺着用户的数据库,永远不会空 ——
    # 「只删空目录」就是这里全部的安全边界,别改成按名字删
    Get-ChildItem -LiteralPath $AppDir -Recurse -Directory -ErrorAction SilentlyContinue |
      Sort-Object { $_.FullName.Length } -Descending |
      ForEach-Object {
        if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue)) {
          Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
      }
  } else {
    Log '没有清单,退回覆盖(约束 2)'
  }

  # --- 3. 解压 ---
  Log "解压 $ZipPath"
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $AppDir -Force

  # --- 4. 写新清单 ---
  if ($NewManifest -and (Test-Path -LiteralPath $NewManifest -PathType Leaf)) {
    Copy-Item -LiteralPath $NewManifest -Destination $Manifest -Force
    Log '已写入新清单'
  } elseif (Test-Path -LiteralPath $Manifest -PathType Leaf) {
    # 这次发布没带清单(升到一个老版本,或者发布时漏传了)。留着旧的等于留下
    # 一份说谎的清单 —— 下次更新会按它去删,删多了其实无害(删在解压之前,
    # 解压会补回来),但排查起来会指向错误的方向。宁可退回覆盖
    Remove-Item -LiteralPath $Manifest -Force -ErrorAction SilentlyContinue
    Log '这次发布没有清单,已清掉旧的'
  }

  Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
  if ($NewManifest) { Remove-Item -LiteralPath $NewManifest -Force -ErrorAction SilentlyContinue }

  Log '完成,重启'
  Start-Process -FilePath $ExePath -WorkingDirectory $AppDir
} catch {
  Log "失败:$($_.Exception.Message)"
  # zip 里没有任何用户数据,所以哪怕炸在一半,坏掉的也只是程序文件 —— 重新下载
  # 一次就恢复,数据碰不到。但用户此刻面对的是一个自己退掉又没起来的程序,
  # 必须说一句,不能静默(静默只适用于"检查更新"那一步)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "更新没做完,程序文件可能不完整。\`n\`n请到 ${releasesPage} 重新下载完整包,解压覆盖即可 —— 你的配置和数据库不在包里,不会受影响。\`n\`n日志:$LogPath",
      'Steam 成就追踪器') | Out-Null
  } catch { }
  try {
    if (Test-Path -LiteralPath $ExePath -PathType Leaf) { Start-Process -FilePath $ExePath -WorkingDirectory $AppDir }
  } catch { }
}
`;
}

/**
 * Windows 上 PowerShell 的绝对路径。
 *
 * 不靠 PATH:PATH 里找不到时 `spawn` 报的是异步的 `error` 事件,而不是抛异常 ——
 * 正是那种"看起来启动了"的失败。
 */
export function powershellPath(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * **helper 必须活过 app.quit(),而这在 Electron 里不是默认行为。**
 *
 * 实测(在真实会话里,四种方式各起一个假 helper 然后立刻 app.quit()):
 *
 * | 方式                          | 活下来了吗 |
 * |------------------------------|-----------|
 * | `detached: true` + unref      | **否**    |
 * | 普通 spawn + unref            | **否**    |
 * | `cmd /c start`                | 是        |
 * | WMI `Win32_Process.Create`    | 是        |
 *
 * 这是**作业对象**(Job Object)的特征:Electron 把子进程放进一个带
 * kill-on-close 的 job,job 一关全家一起走。Windows 的 `DETACHED_PROCESS`
 * (也就是 Node 的 `detached`)**逃不出 job** —— 它管的是控制台,不是 job。
 * 能逃出来的只有"根本不是我们的子进程"这一类办法,上面两种都属于这类。
 *
 * 第一版就是用 `detached` 的,于是 app 退了、helper 没接上、程序再也没回来。
 * 别改回去。
 */
export function primaryLaunch({ scriptPath, psPath = powershellPath() }) {
  // `""` 是 start 的窗口标题参数,必须给 —— 不给的话 start 会把后面第一个
  // 带引号的路径当成标题,然后什么都不启动
  return {
    file: 'cmd',
    args: [
      '/c', 'start', '""', '/min',
      psPath, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ],
  };
}

/**
 * 备用:让 WMI 去建这个进程,建出来的不是我们的子进程,同样逃出 job。
 *
 * 为什么留一条备用而不是只用一种 —— 这个组件有个别处没有的性质:
 * **坏掉的那一版已经在用户机器上了,而修好的那一版要靠它送过去。** 主路一旦
 * 在某台机器上不灵,那台机器就再也收不到修复。所以这里的冗余是值得的。
 *
 * 两条路的失败原因是正交的:主路怕的是 `start` 的引号规则和脚本执行策略
 * (GPO 下发的 Restricted 会挡掉 `-File`);备用路把整段脚本用
 * `-EncodedCommand` 传进去,执行策略管不着,但要求 WMI 可用。
 */
export function fallbackLaunch({ script, psPath = powershellPath() }) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const commandLine = `"${psPath}" -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  return {
    file: psPath,
    args: [
      '-NoProfile', '-NonInteractive', '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
        `-Arguments @{CommandLine=${psQuote(commandLine)}}; exit $r.ReturnValue`,
    ],
  };
}

/** 写 helper 脚本。**BOM 是必需的**,理由见 renderHelperScript 的注释 */
export function writeHelperScript(path, source) {
  writeFileSync(path, `﻿${source}`, 'utf8');
  return path;
}
