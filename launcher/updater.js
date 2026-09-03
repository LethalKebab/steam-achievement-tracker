/**
 * Self-update — everything except actually touching the disk
 * ------------------------------------------------
 * This file **does not import electron**, so `node --test` can load it directly. All four of the
 * "unit-testable" things the design doc lists (docs/self-update.md, section five) live here: manifest
 * generation, version comparison, sha256 verification and remembering the skipped version. main.js
 * only wires it up to the dialog and the exit.
 *
 * Where the three hard constraints (same doc, section three) land here:
 *
 * 1. **Deletion goes strictly by the manifest** (which files the previous version installed), never
 *    by a "keep list". User data sits at the same level as the program files
 *    (`resources/tracker/`), so a keep list missing one entry deletes the user's database, while a
 *    manifest missing one entry merely leaves a spare file behind — the two forms fail in opposite
 *    directions, and that is the entire reason.
 * 2. **A missing manifest falls back to overwriting**, never to inferring which files are program
 *    files.
 * 3. **The replacement has to happen after the process has genuinely exited**, which the helper
 *    handles by waiting on the PID. Since the tray change, 「关掉窗口」 does not mean exiting and the
 *    exe is still locked.
 *
 * Why the manifest is a **separate release asset** rather than something packed into the zip: the
 * zip is produced by electron-builder and is already sealed by the time postbuild gets it, while the
 * manifest has to describe that zip's contents — packing it in is circular. So the manifest is
 * published alongside the zip and written into the app directory by the helper after extraction. The
 * side effect is exactly the one wanted: a user with a fresh extraction has no manifest, so their
 * first update naturally takes constraint 2's overwrite path with no special case needed.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { lt, htmlLang } from './strings.js';

/** Change this one line for your own repository. A public repo needs no token (60 unauthenticated requests an hour is ample for one check a day) */
export const REPO = 'LethalKebab/steam-achievement-tracker';

/** The manifest installed in the app directory — it describes "what the current version installed" */
export const MANIFEST_NAME = 'update-manifest.json';

/**
 * The marker file the helper writes as **the very first thing** it does.
 *
 * It exists because of a real incident: the app exited, the helper never took over, and the user
 * faced a program that closed itself and never came back — while the app's log said 「helper 已启动」,
 * because `spawn()` returning has never meant the process actually started (a launch failure comes
 * through the `error` event).
 *
 * The order now is: launch the helper → **wait for this file to appear** → only then app.quit().
 * Failing to see it means not exiting and reporting the error to the user. The worst outcome degrades
 * from "the program is gone" to "the update did not happen, but the program is still here".
 */
export const ALIVE_MARKER_NAME = 'helper-alive.txt';
/** The skipped version is recorded here. It is in no manifest, so an update can never delete it */
export const STATE_NAME = 'update-state.json';

export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const API_ROOT = `https://api.github.com/repos/${REPO}/releases`;
const FETCH_TIMEOUT_MS = 20_000;
/**
 * The download limit, set very generously (133MB / 30 minutes ≈ 75 KB/s). Its point is not "is that
 * fast enough" but that **a stalled connection has to have an end**: without a limit checkForUpdate
 * would sit on that await forever, and the self-renewing timer would then never renew — updates
 * silently stop from that moment until the program is restarted.
 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------- Version comparison

/** `v1.1.3` / `1.1.3-beta.2` → `[1, 1, 3]`. The prerelease suffix is simply dropped */
function versionParts(v) {
  return String(v ?? '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0);
}

/** Positive when a is newer than b, negative when older, 0 when equal */
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
 * Whether to offer this version.
 *
 * Skipping is recorded **per version** rather than as "leave me alone today": the design doc lists
 * "remember the version the user skipped" as one of the three hard details — prompting on every open
 * trains people to ignore it within two days. Having skipped 1.2.0, 1.2.1 is still offered when it
 * appears, because that is a different version.
 */
export function shouldOffer({ currentVersion, remoteVersion, skippedVersion = null }) {
  if (!remoteVersion) return false;
  if (compareVersions(remoteVersion, currentVersion) <= 0) return false;
  if (skippedVersion && compareVersions(remoteVersion, skippedVersion) <= 0) return false;
  return true;
}

// ---------------------------------------------------------------- Release assets

/**
 * Picks the zip and the manifest out of a release's assets.
 *
 * Not finding a manifest is not an error — releases up to and including 1.1.3 simply have none. In
 * that case the update proceeds as usual, only leaving no manifest in the app directory afterwards,
 * so the next update takes the overwrite path again.
 */
export function pickAssets(assets = []) {
  const nameOf = (a) => String(a?.name ?? '');
  return {
    zip: assets.find((a) => /-win\.zip$/i.test(nameOf(a))) ?? null,
    manifest: assets.find((a) => /-manifest\.json$/i.test(nameOf(a))) ?? null,
  };
}

/**
 * Every GitHub asset carries its own `digest: "sha256:…"`. An unrecognised one returns null, and
 * **the caller must refuse the update because of it** — not being able to verify means asking the
 * user to run an unverified 133MB executable. Better not to update at all than to install something
 * of unknown origin.
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

// ---------------------------------------------------------------- Manifest

/**
 * A path in the manifest has to be **a well-behaved relative path**.
 *
 * The manifest comes off the internet, and its only use is feeding a deletion loop. A drive letter, a
 * leading slash or a `..` could each let the deletion run outside the app directory. The helper has a
 * boundary check of its own; this is the first one — and a non-conforming manifest is rejected in
 * full rather than filtered entry by entry: a manifest carrying an out-of-bounds path is itself proof
 * that we did not publish it, and the rest of it is equally untrustworthy.
 */
export function isSafeManifestPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // a drive letter
  if (/^[/\\]/.test(p)) return false; // absolute path / UNC
  return p.split(/[/\\]/).every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Parses and validates a manifest's text. Throws outright when it does not conform — the caller abandons the update on that basis */
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
 * Files that are specific to this machine and are never part of the program itself.
 *
 * There is only one today: `local.config.json` (the pointer naming the build's data directory).
 * Letting it into the manifest means the next update deletes it as a program
 * file — the user's data directory silently reverts to the default location, presenting as "all my
 * data is gone". postbuild generates the manifest before copying it in, so the ordering is the
 * mechanism and this check is the safety net — orderings get changed by people.
 */
export const MACHINE_LOCAL_FILES = ['local.config.json'];

/** Which machine-specific files slipped into the manifest (an empty array = clean) */
export function machineLocalEntries(files = []) {
  return files.filter((f) => {
    const base = String(f).split(/[/\\]/).pop()?.toLowerCase();
    return MACHINE_LOCAL_FILES.includes(base);
  });
}

/**
 * The user's own files inside an app directory, at their default locations, relative to it.
 *
 * `lib/config.js` puts all of them under `DATA_ROOT`, which without a `local.config.json` is
 * `resources/tracker/` — the same directory the program files were copied into. **A build cannot
 * produce any of these paths**: `extraResources` in `launcher/package.json` is an allow-list of
 * `tracker.js`, `package.json`, `*.html`, `lib/**` and `assets/**`, so a path named here is the
 * user's or does not exist.
 *
 * **That is what makes a fixed list usable here and not for deletion.** Deciding what to *delete*
 * from a list like this is the keep-list the updater refuses to have: one missing entry destroys
 * data. Deciding what to *refuse to delete* fails the other way — one missing entry lets a build
 * proceed that should have stopped, which is the situation that already exists without the check.
 *
 * It covers the defaults, not every configuration: `dbPath` and `guidesDir` are settable, and a
 * database moved elsewhere is not found by this.
 */
export const USER_DATA_PATHS = [
  'resources/tracker/config.json',
  'resources/tracker/data',
  'resources/tracker/guides',
  'resources/tracker/backups',
  'resources/tracker/exports',
];

/** Which of `USER_DATA_PATHS` are present under `appDir` (an empty array = none of the user's files are in there) */
export function userDataEntries(appDir) {
  return USER_DATA_PATHS.filter((rel) => existsSync(join(appDir, ...rel.split('/'))));
}

/**
 * The `local.config.json` a build writes for itself when `launcher/` holds none.
 *
 * **`dataDir` is what keeps a local build's data out of dist/**, where the next build's directory
 * swap would delete it. It also puts `config.json` and `data/` where CONTRIBUTING.md and .gitignore
 * already say they are, so the CLI, `npm start` and the built exe read one dataset instead of three.
 *
 * **`autoUpdate: false` is about code, not data.** A build made from a working tree that offers to
 * replace itself with the published release ends with somebody testing a change against code that no
 * longer contains it.
 *
 * Forward slashes because that is what a JSON path is read as everywhere here, and it needs no
 * escaping. It lives in this file rather than in postbuild so the decision can be tested; postbuild
 * itself acts on the real repository and cannot be run by a test.
 */
export function generatedLocalConfig(repoRoot) {
  return { dataDir: String(repoRoot).replace(/\\/g, '/'), autoUpdate: false };
}

/**
 * Walks a directory and lists every file's relative path — used at build time to generate the
 * manifest.
 *
 * It reads the directory electron-builder unpacked rather than parsing the zip: that directory **is**
 * the zip's contents, and it is exactly what ends up on disk after the user extracts it. Only files
 * are collected, never directories, because the deletion stage only deletes files; directories are
 * cleaned up by "delete it once it is empty", so a directory like `resources/tracker/data/` holding
 * the database is never touched.
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

// ---------------------------------------------------------------- The skipped version

/**
 * The state file sits next to the exe, not in `app.getPath('userData')`.
 * The reason is the same as for local.config.json (launcher/README.md): userData is silently
 * redirected in sandboxed/virtualised processes, so the same absolute path points at different
 * content for different processes.
 *
 * A failed read or write always counts as "not remembered" — an app directory that is read-only (it
 * was extracted into Program Files, say) must not cause anything to be raised.
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

// ---------------------------------------------------------------- Network

function ghHeaders(userAgent) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': userAgent, // the GitHub API 403s outright without a UA
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Fetches one release. An empty `tag` fetches latest.
 *
 * Naming a tag is **for rehearsals**: the design doc's section five verifies this by pointing it at
 * v1.1.2 to perform a "downgrade", running the whole 「下载 → 校验 → 按清单删 → 解压 → 重启」 path
 * without cutting a release. main.js reads that value from `TRACKER_UPDATE_FORCE_TAG`.
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
 * Downloads and verifies against the digest GitHub supplies. An unrecognised digest is refused; the
 * reasoning is on sha256FromDigest.
 *
 * On failure the partial file is deleted: this downloads 133MB, and repeated failures would pile up
 * hundreds of megabytes in temp — while a package that fails verification is of no use on disk at
 * all.
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

// ---------------------------------------------------------------- The update prompt UI

/** The choice comes back through document.title; this is that title's prefix */
export const PROMPT_TITLE_PREFIX = 'choice:';

/**
 * The update prompt is **a real web page**, not a native dialog.
 *
 * This is not a preference, it is measured: `dialog.showMessageBox` simply does not hold up in this
 * project — the box flashes and disappears, and the promise immediately returns a
 * `response: 420` that is outside the button range. Stripping the options down to `{ message }`,
 * switching to the synchronous `showMessageBoxSync`, attaching a parent window, not attaching one —
 * ten combinations, all 420; while a plain Win32 MessageBox on the same machine holds up perfectly.
 * So the problem is at the Electron layer, not in the system.
 *
 * **This is the second time this repository has hit the same class of thing.** The first was the
 * renderer's `window.confirm`, which made 「生成攻略」 entirely dead in the packaged build (recorded in
 * CLAUDE.md), and the conclusion drawn then was 「原生对话框归主进程所有」 — that conclusion was too
 * narrow, since the main process's are equally unusable. The solution the repository gave at the time
 * was `askConfirm`, an in-page component that is 「在浏览器和打包版里完全一致」. This takes the same
 * route.
 *
 * The result comes back through `document.title` with no preload and no IPC: there is nothing in the
 * window that needs privileges, and `page-title-updated` is guaranteed to fire.
 */
export function renderUpdatePromptHtml({ version, sizeMb }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="${htmlLang()}"><head><meta charset="utf-8"><title>${esc(lt('app.name'))}</title>
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
  <h1>${esc(lt('prompt.heading', { version }))}</h1>
  <p>${esc(lt('prompt.size', { mb: sizeMb }))}</p>
  <label><input type="checkbox" id="skip">${esc(lt('prompt.skip'))}</label>
  <div class="row">
    <button id="later">${esc(lt('prompt.later'))}</button>
    <button id="now" class="primary">${esc(lt('prompt.now'))}</button>
  </div>
<script>
  // The answer travels through document.title - the main process listens for page-title-updated.
  // No preload is needed, and so this window needs no privileges of any kind
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

/** Parses the title that page sends back. An unrecognised one returns null (ordinary title changes land here) */
export function parsePromptChoice(title) {
  const m = new RegExp(`^${PROMPT_TITLE_PREFIX}(update|later):(0|1)$`).exec(String(title ?? ''));
  return m ? { update: m[1] === 'update', skip: m[2] === '1' } : null;
}

// ---------------------------------------------------------------- The helper script

/** A PowerShell single-quoted string: an inner single quote is written twice. Same origin as the one in postbuild.js */
const psQuote = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

/**
 * Generates the PowerShell script that takes over the replacement.
 *
 * Still zero runtime dependencies — `Expand-Archive` ships with PowerShell, and `postbuild.js` has
 * long been borrowing `WScript.Shell` to create shortcuts, so there is precedent.
 *
 * **The parameters are baked into the script rather than passed on the command line.** Paths may
 * contain Chinese characters and spaces, and a command-line argument goes through another layer of
 * quoting rules; baking them in needs only psQuote's one form of escaping, removing a whole class of
 * bug. The script is single-use, written into temp, and nobody looks at it again.
 *
 * The script itself **has to be saved as UTF-8 with a BOM** (see writeHelperScript): without a BOM,
 * PowerShell 5.1 reads a .ps1 in the ANSI code page, and Chinese paths and Chinese messages all turn
 * into question marks.
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
 * PowerShell's absolute path on Windows.
 *
 * PATH is not relied on: when it cannot be found there, `spawn` reports an asynchronous `error` event
 * rather than throwing — precisely the "it looked like it started" kind of failure.
 */
export function powershellPath(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * **The helper has to outlive app.quit(), and in Electron that is not the default behaviour.**
 *
 * Measured (in a real session, starting a fake helper four different ways and immediately calling
 * app.quit()):
 *
 * | Method                        | Survived? |
 * |-------------------------------|-----------|
 * | `detached: true` + unref       | **no**    |
 * | plain spawn + unref            | **no**    |
 * | `cmd /c start`                 | yes       |
 * | WMI `Win32_Process.Create`     | yes       |
 *
 * This is the signature of a **job object**: Electron puts its child processes into a job with
 * kill-on-close, and closing the job takes the whole family with it. Windows's `DETACHED_PROCESS`
 * (which is Node's `detached`) **cannot escape a job** — it governs the console, not the job. The only
 * ways out are the ones where the process is not our child at all, and both of the above are of that
 * kind.
 *
 * The first version used `detached`, so the app exited, the helper never took over and the program
 * never came back. Do not change it back.
 */
export function primaryLaunch({ scriptPath, psPath = powershellPath() }) {
  // `""` is start's window-title argument and has to be given — without it, start takes the first
  // quoted path after it as the title and then launches nothing
  return {
    file: 'cmd',
    args: [
      '/c', 'start', '""', '/min',
      psPath, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ],
  };
}

/**
 * The fallback: have WMI create the process, so what is created is not our child and likewise escapes
 * the job.
 *
 * Why keep a fallback rather than a single route — this component has a property nothing else here
 * does: **the version where it is broken is already on users' machines, and the fixed version has to
 * be delivered by it.** Once the primary route fails on some machine, that machine can never receive
 * the fix again. So the redundancy is worth it.
 *
 * The two routes fail for orthogonal reasons: the primary is vulnerable to `start`'s quoting rules
 * and to the script execution policy (a Restricted policy pushed by GPO blocks `-File`); the fallback
 * passes the whole script through `-EncodedCommand`, which the execution policy does not govern, but
 * it requires WMI to be available.
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

/** Writes the helper script. **The BOM is required**; the reasoning is on renderHelperScript */
export function writeHelperScript(path, source) {
  writeFileSync(path, `﻿${source}`, 'utf8');
  return path;
}
