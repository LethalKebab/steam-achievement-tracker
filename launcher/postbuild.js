/**
 * The post-build wrap-up, four things:
 *
 * 1. electron-builder always names the unpacked directory win-unpacked; rename it to the product
 *    name — sitting under dist/ in the repository root, it has to be recognisable at a glance.
 *    The previous build's directory is deleted to make room, and **that delete is refused while any
 *    of the user's own files are still inside it**.
 * 2. **Write the update manifest**: which files this version installed. Self-update uses it to decide
 *    what to delete (see the comments below, and docs/self-update.md).
 * 3. Write the local.config.json naming this build's data directory. launcher/'s own copy wins when
 *    there is one; otherwise one pointing at the repository root is generated, which is what keeps a
 *    local build's data out of dist/ and therefore out of step 1's way.
 * 4. Put a shortcut in the repository root, so it can be double-clicked without navigating into
 *    dist/. A .lnk stores absolute paths, so like local.config.json it is machine-specific and does
 *    not go into the repository.
 *
 * **2 has to come before 3.** The manifest is generated from appDir's existing contents, and 3 puts a
 * local.config.json into it — the other way round, that machine-specific config would enter the
 * manifest and be deleted as a program file at the next update, silently reverting the user's data
 * directory to its default location. There is an assertion below guarding exactly this.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildManifest, generatedLocalConfig, machineLocalEntries, userDataEntries } from './updater.js';

/** A PowerShell single-quoted string: an inner single quote is written twice */
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');

// Matches build.productName in package.json and has to be ASCII — the reasoning is in the comment
// there
const PRODUCT = 'SteamAchievementTracker';
const unpacked = join(distDir, 'win-unpacked');
const appDir = join(distDir, PRODUCT);
const exePath = join(appDir, `${PRODUCT}.exe`);

// --- 1. win-unpacked → the product name ---
if (existsSync(unpacked)) {
  // **A build is not allowed to destroy data on its way to succeeding.** The delete below takes the
  // whole previous app directory, and user data sits inside it at resources/tracker/ — so it is
  // refused up front rather than reported afterwards, when there is nothing left to report about.
  // Step 3 keeps data out of dist/ in the first place, which leaves two ways to arrive here: a
  // directory built before step 3 did that, or one whose dataDir had gone missing, sending main.js
  // back to storing beside the exe. Both want a person, not a default.
  const stranded = userDataEntries(appDir);
  if (stranded.length > 0) {
    console.error(
      `[postbuild] ${appDir} 里有用户数据,拒绝删除:\n` +
        stranded.map((p) => `             ${p}`).join('\n') +
        '\n           本地构建的数据现在统一放在仓库根目录,这几项是旧布局留下的。\n' +
        '           要留就把它们移到仓库根目录,不要就删掉整个目录,然后重新 build。'
    );
    process.exit(1);
  }

  // **The delete and the rename have to be in the same try.** With the program running the directory
  // is in use and both steps fail for exactly the same reason, and the delete runs first — so
  // guarding only the rename means a real problem throws a bare EPERM stack and the message written
  // for it ("close the running … first") never gets its turn.
  // Worse, the build then looks like it "finished": dist/ holds the previous build's output, with
  // reasonably fresh timestamps
  try {
    // Clear the same-named directory left by the previous build first, or the rename fails
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
    renameSync(unpacked, appDir);
    console.log(`[postbuild] ${unpacked} → ${appDir}`);
  } catch (err) {
    console.error(
      `[postbuild] 收尾失败(${err.code}):先关掉正在运行的「${PRODUCT}」再 build。\n` +
        `           dist/ 里现在还是**上一次**的产物,这次 build 没有更新它。`
    );
    process.exit(1);
  }
} else if (!existsSync(appDir)) {
  console.error('[postbuild] 没找到 build 产物,跳过收尾');
  process.exit(1);
}

// --- 2. The update manifest ---
// "Which files the previous version installed". Self-update deletes strictly by this list, never by a
// "keep list" — user data sits at the same level as the program files (resources/tracker/), so a keep
// list missing one entry deletes the user's database while a manifest missing one entry merely leaves
// a spare file behind. The two forms fail in opposite directions, and that is the entire reason.
//
// It reads the unpacked directory rather than parsing the zip: that directory **is** the zip's
// contents, and it is exactly what ends up on disk after the user extracts it. The manifest itself is
// not inside the zip (the zip was sealed back at the electron-builder step, and having a manifest
// describe a zip containing itself is circular), so it is uploaded alongside the zip as a separate
// release asset and written into the app directory by the update script after extraction. The side
// effect is exactly the one wanted: a user with a fresh extraction has no manifest, so their first
// update naturally falls back to overwriting with no special case needed.
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
const manifest = buildManifest(appDir, version);

// local.config.json entering the manifest means the next update deletes it. Step 3 has not run yet, so
// this should be clean — but orderings get changed by people, so verify explicitly rather than
// letting it become a silent trap
const leaked = machineLocalEntries(manifest.files);
if (leaked.length > 0) {
  console.error(
    `[postbuild] 清单里出现了本机专属文件(${leaked.join(', ')}),拒绝写出。\n` +
      '           进了清单就等于下次更新会把它当程序文件删掉,用户的数据目录\n' +
      '           会静默地跳回默认位置——看起来就像"数据全没了"。\n' +
      '           两种可能:(a) 生成清单被挪到了第 3 步复制之后;\n' +
      '           (b) 单独跑了 postbuild,dist/ 里是上一次 build 留下的目录。\n' +
      '           (b) 的话跑一次完整的 npm run build 就好。'
  );
  process.exit(1);
}

const manifestPath = join(distDir, `${PRODUCT}-${version}-manifest.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[postbuild] 更新清单:${manifest.files.length} 个文件 → ${manifestPath}`);

// --- 3. The data directory this build reads ---
// **Without this file a local build stores its data inside the directory step 1 deletes.** DATA_ROOT
// falls back to ROOT, which in a packaged build is resources/tracker/ — so config.json and the
// database land in dist/, and the next build takes them with it. Pointing it at the repository root
// removes that, and makes `node tracker.js serve`, `npm start` and the built exe read one dataset,
// in the place CONTRIBUTING.md and .gitignore already name.
//
// **Auto-update is off in the generated file, and that is about code rather than data.** A build made
// from a working tree offering to replace itself with the published release ends with somebody
// testing a change against code that no longer contains it. The update path itself is safe for data
// (no manifest in the app directory ⇒ overwrite, never delete), so this is not a second guard for
// step 1. A hand-written launcher/local.config.json says nothing about autoUpdate and is copied
// verbatim — that file is the machine owner's answer, not ours.
//
// **None of this reaches anyone else's machine**: the zip was sealed back at the electron-builder
// step and does not contain it, and a copy of this folder carried elsewhere finds the path missing,
// which loadDataDirOverride ignores rather than uses.
const localCfg = join(here, 'local.config.json');
const appLocalCfg = join(appDir, 'local.config.json');
if (existsSync(localCfg)) {
  copyFileSync(localCfg, appLocalCfg);
  console.log('[postbuild] 已复制 local.config.json 到 exe 旁边');
} else {
  const generated = generatedLocalConfig(repoRoot);
  writeFileSync(appLocalCfg, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`[postbuild] 已生成 local.config.json:数据目录 ${generated.dataDir},自动更新关闭`);
}

// --- 4. The shortcut in the repository root ---
const shortcut = join(repoRoot, `${PRODUCT}.lnk`);
try {
  // Node cannot create a .lnk (that is a COM object), so PowerShell's WScript.Shell does it.
  // **-EncodedCommand is mandatory**: passing arguments through -Command directly converts Chinese
  // characters in the path through the console code page, turning the product name into a run of
  // ????? and producing a shortcut pointing at a path that does not exist.
  // -EncodedCommand takes UTF-16LE base64, which is entirely independent of the code page.
  const ps =
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcut)});` +
    `$s.TargetPath = ${psQuote(exePath)};` +
    `$s.WorkingDirectory = ${psQuote(appDir)};` +
    `$s.Save()`;
  execFileSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(ps, 'utf16le').toString('base64'),
  ]);
  console.log(`[postbuild] 快捷方式已放在仓库根目录:${PRODUCT}.lnk`);
} catch (err) {
  // The shortcut is only a convenience, and failing to create it should not fail the whole build —
  // the exe itself is fine
  console.warn('[postbuild] 快捷方式没建成(不影响程序本身):', err.message);
}
