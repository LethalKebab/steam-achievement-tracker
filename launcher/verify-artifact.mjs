/**
 * Is anything of the user's inside the shipped artifact?
 * ------------------------------------------------
 * `extraResources` in `package.json` is an **allow-list** (`tracker.js`, `package.json`, `*.html`,
 * `lib/**`, `assets/**`), and that allow-list is the only thing keeping `config.json` — which holds
 * the Steam, Notion and AI keys in plain text — out of a zip that then goes to everybody who
 * downloads a release. Widen the filter by one glob and the next release publishes those keys, with
 * nothing anywhere reporting it: the build succeeds, the app runs, and the zip is merely bigger.
 *
 * The release checklist has asked for this by hand since the beginning. It is automated here
 * because a hand-run check is skipped precisely on the release where something was rushed.
 *
 * **The decoys are the whole design.** `config.json` and `data/` are gitignored, so a CI checkout
 * has neither, and `unzip -l | grep config.json` on a fresh clone passes whether the filter is
 * correct or wide open — it is testing that the file does not exist, not that the filter excludes
 * it. So the caller plants one of every path first, and this script **refuses to run** if they are
 * not there. A green with no decoys is the failure this file exists to prevent.
 *
 * The predicates come from `updater.js` rather than being written again here: `USER_DATA_PATHS` is
 * already the answer to "which paths are the user's", and two copies of that list is how one of
 * them stops being updated.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipRead } from '../lib/zip.js';
import { USER_DATA_PATHS, MACHINE_LOCAL_FILES, machineLocalEntries } from './updater.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');

const die = (...lines) => {
  for (const l of lines) console.error(l);
  process.exit(1);
};

/**
 * One file under each of `USER_DATA_PATHS`, at the repo root, where `extraResources.from` points.
 * A directory is not enough: a zip stores files, so an empty `data/` could be absent from the
 * listing for a reason that has nothing to do with the filter.
 */
export const DECOYS = [
  'config.json',
  join('data', 'steam.db'),
  join('guides', 'decoy.md'),
  join('backups', 'decoy.zip'),
  join('exports', 'decoy.csv'),
];

// ---- --plant: put the decoys down ----
//
// **This lives here rather than in the workflow because of what these paths are on a real machine.**
// `config.json` and `data/steam.db` are the developer's own, holding their keys and their library,
// and a workflow step that writes them is one copy-pasted command away from destroying both. So
// planting refuses outright the moment any of the five already exists, and says which.
if (process.argv.includes('--plant')) {
  const present = DECOYS.filter((rel) => existsSync(join(repoRoot, rel)));
  if (present.length) {
    die(
      `[verify-artifact] ${present.join(', ')} 已经存在,拒绝覆盖。`,
      '           这些是真实数据的位置:config.json 里是密钥,data/steam.db 是整个库。',
      '           这一步只该在干净的检出里跑(CI 就是),不该在你自己的工作树里跑。'
    );
  }
  for (const rel of DECOYS) {
    const full = join(repoRoot, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `decoy ${rel} — planted by verify-artifact.mjs, must never reach the zip
`);
  }
  console.log(`[verify-artifact] 种下 ${DECOYS.length} 个诱饵:${DECOYS.join(', ')}`);
  process.exit(0);
}

// ---- 0. The decoys have to be there, or nothing below means anything ----
const missing = DECOYS.filter((rel) => !existsSync(join(repoRoot, rel)));
if (missing.length) {
  die(
    `[verify-artifact] 没找到诱饵文件(${missing.join(', ')}),拒绝继续。`,
    '           这些路径本来就在 .gitignore 里,所以干净的检出根本没有它们——',
    '           不种下去就直接查,查的是「文件不存在」,不是「过滤器把它挡住了」,',
    '           过滤器写成 ** 也一样是绿的。先种再查。'
  );
}

// ---- 1. Locate the artifacts ----
const zips = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith('-win.zip')) : [];
if (zips.length !== 1) {
  die(`[verify-artifact] dist/ 里有 ${zips.length} 个 -win.zip,应该正好 1 个:${zips.join(', ') || '(空)'}`);
}
const zipPath = join(distDir, zips[0]);
const manifests = readdirSync(distDir).filter((f) => f.endsWith('-manifest.json'));
if (manifests.length !== 1) {
  die(`[verify-artifact] dist/ 里有 ${manifests.length} 个 -manifest.json,应该正好 1 个`);
}

// ---- 2. Nothing of the user's inside the zip ----
// Entry names are used as they come: the ZIP spec mandates '/' as the separator regardless of the
// machine that wrote the file, and the real artifact was checked against that before relying on it
const names = [...zipRead(readFileSync(zipPath)).keys()];
if (names.length < 50) {
  die(`[verify-artifact] zip 里只有 ${names.length} 个条目,不像一次完整打包——先确认构建本身是好的`);
}

const underUserPath = (name) =>
  USER_DATA_PATHS.some((p) => name === p || name.startsWith(`${p}/`));
const isMachineLocal = (name) =>
  MACHINE_LOCAL_FILES.includes(name.split('/').pop().toLowerCase());

const leakedData = names.filter(underUserPath);
const leakedLocal = names.filter(isMachineLocal);
if (leakedData.length || leakedLocal.length) {
  die(
    `[verify-artifact] zip 里出现了不该发出去的文件:${[...leakedData, ...leakedLocal].join(', ')}`,
    '           config.json 里是明文的 Steam / Notion / AI 密钥,而这个 zip 是发布给所有人下载的。',
    '           看 launcher/package.json 的 extraResources.filter——它是白名单,被放宽了。'
  );
}

// ---- 3. Nothing machine-specific in the update manifest ----
// postbuild.js checks this too, at the moment it writes the file. Repeated here because this reads
// what actually landed on disk, and the two answer different questions: that one is "was it built
// correctly", this one is "is the thing about to be published correct"
const manifest = JSON.parse(readFileSync(join(distDir, manifests[0]), 'utf8'));
const leakedManifest = machineLocalEntries(manifest.files ?? []);
if (leakedManifest.length) {
  die(`[verify-artifact] 清单里有本机专属文件:${leakedManifest.join(', ')}`);
}

console.log(`[verify-artifact] ${zips[0]}:${names.length} 个条目`);
console.log(`[verify-artifact] 种了 ${DECOYS.length} 个诱饵,一个都没进 zip`);
console.log(`[verify-artifact] 清单 ${manifest.files.length} 个文件,没有本机专属文件`);

// Cleared only on the way out of a green run: a failed one leaves them where they are, so whoever
// looks next can see exactly what was planted and where it ended up
for (const rel of DECOYS) rmSync(join(repoRoot, rel), { force: true });
