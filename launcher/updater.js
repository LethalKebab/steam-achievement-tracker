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

function Log($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Out-File -FilePath $LogPath -Append -Encoding utf8 }

try {
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

/** 写 helper 脚本。**BOM 是必需的**,理由见 renderHelperScript 的注释 */
export function writeHelperScript(path, source) {
  writeFileSync(path, `﻿${source}`, 'utf8');
  return path;
}
