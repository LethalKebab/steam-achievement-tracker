/**
 * build 之后的收尾,四件事:
 *
 * 1. electron-builder 固定把解包目录叫 win-unpacked,改成产品名——放在仓库根目录的
 *    dist/ 下,总得让人一眼看出这是什么。
 * 2. **写更新清单**:这一版装了哪些文件。自更新靠它决定删什么(见下面的注释,
 *    以及 docs/self-update.md)。
 * 3. 把本机专属的 local.config.json 复制到 exe 旁边。源文件在 launcher/ 下,
 *    dist/ 每次 build 都重建,不复制的话每次都得手动放回去。
 *    没有这个文件(别人 clone 下来 build)就跳过——分发出去的包不该带任何人的本机路径。
 * 4. 在仓库根目录放一个快捷方式,双击即可,不用一层层点进 dist/。
 *    .lnk 里存的是绝对路径,所以它和 local.config.json 一样是本机专属、不进仓库的。
 *
 * **2 必须排在 3 前面。** 清单是照着 appDir 现有内容生成的,而 3 会往里面放一份
 * local.config.json —— 顺序反过来,那份本机配置就会进清单,下次更新时被当作
 * 程序文件删掉,用户的数据目录会静默地跳回默认位置。下面有一条断言守着这件事。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildManifest, machineLocalEntries } from './updater.js';

/** PowerShell 单引号字符串:内部的单引号写成两个 */
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');

// 和 package.json 的 build.productName 一致,必须是 ASCII——理由见那边的注释
const PRODUCT = 'SteamAchievementTracker';
const unpacked = join(distDir, 'win-unpacked');
const appDir = join(distDir, PRODUCT);
const exePath = join(appDir, `${PRODUCT}.exe`);

// --- 1. win-unpacked → 产品名 ---
if (existsSync(unpacked)) {
  // **删和改名要在同一个 try 里。** 程序开着的时候目录被占用,这两步会因为
  // 完全相同的原因失败,而先执行的是删 —— 以前只有改名有保护,于是真出问题时
  // 抛的是一句裸 EPERM 栈,而那句写好的提示("先关掉正在运行的…")永远轮不到。
  // 更糟的是 build 看起来"跑完了":dist/ 里躺着上一次的产物,时间戳都还挺新
  try {
    // 上一次 build 留下的同名目录先清掉,不然 rename 会失败
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
    renameSync(unpacked, appDir);
    console.log(`[postbuild] ${unpacked} → ${appDir}`);
  } catch (err) {
    console.error(
      `[postbuild] 收尾失败(${err.code}):先关掉正在运行的「${PRODUCT}」再 build。\n` +
        `           dist/ 里现在是**上一次**的产物,没有被这次 build 更新。`
    );
    process.exit(1);
  }
} else if (!existsSync(appDir)) {
  console.error('[postbuild] 没找到 build 产物,跳过收尾');
  process.exit(1);
}

// --- 2. 更新清单 ---
// 「上一版装了哪些文件」。自更新只按这份名单删,绝不按「保留名单」——用户数据和
// 程序文件同层(resources/tracker/),保留名单漏一项就是删掉用户的数据库,而清单
// 漏一项只是留下一个多余文件。两种写法的失败方向相反,这就是全部理由。
//
// 读的是解包目录而不是去解析 zip:那个目录**就是** zip 的内容,也正是用户解压
// 之后磁盘上的样子。清单本身不在 zip 里(zip 早在 electron-builder 那步就封好了,
// 让清单描述一个包含它自己的 zip 是循环的),所以它作为单独的发布附件跟 zip 一起
// 上传,由更新脚本在解压后写进 app 目录。副作用正好是想要的:全新解压的用户手上
// 没有清单,第一次更新自然退回覆盖,不需要为此写特例。
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
const manifest = buildManifest(appDir, version);

// local.config.json 进了清单就等于下次更新会删掉它。第 3 步还没跑,这里本该
// 干干净净——但顺序是人改的,所以显式验一次,别让它变成一个静默的坑
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

// --- 3. 本机数据目录配置 ---
const localCfg = join(here, 'local.config.json');
if (existsSync(localCfg)) {
  copyFileSync(localCfg, join(appDir, 'local.config.json'));
  console.log('[postbuild] 已复制 local.config.json 到 exe 旁边');
} else {
  console.log('[postbuild] 没有 local.config.json,跳过(分发用的 build 就该是这样)');
}

// --- 4. 仓库根目录的快捷方式 ---
const shortcut = join(repoRoot, `${PRODUCT}.lnk`);
try {
  // Node 建不了 .lnk(那是 COM 对象),借 PowerShell 的 WScript.Shell 来做。
  // **必须用 -EncodedCommand**:直接用 -Command 传参时,路径里的中文会按控制台
  // 代码页转换,产品名会变成一串 ?????,建出来的快捷方式指向一个不存在的路径。
  // -EncodedCommand 收的是 UTF-16LE 的 base64,和代码页完全无关。
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
  // 快捷方式只是方便,建不出来不该让整个 build 算失败——exe 本身好好的
  console.warn('[postbuild] 快捷方式没建成(不影响程序本身):', err.message);
}
