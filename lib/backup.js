/**
 * 备份 / 恢复
 * ------------------------------------------------
 * 一个 .zip,装着 data/steam.db + guides/ + config.json,拿到另一台机器上恢复,
 * 打开就是原来那个 Dashboard —— 连密钥都不用重填。
 *
 * 为什么不是"导出 CSV 再导回来"( 把那条路整个删了,见 lib/csv.js):
 * CSV 只装得下三张表,而**真正搬不回来的东西有一半不在里面** —— config.json 里的
 * 密钥、guides/ 下 AI 生成的攻略正文(那是花过钱的)。一个漏掉这些的"迁移"功能
 * 不会报错,只会让人在新机器上发现攻略没了。数据库文件本身是自包含的,搬它是
 * **结构上无损**,不像列序对齐那样要靠纪律维持。
 *
 * 三个坑,每个都静默:
 *
 * 1. **数据库不能用复制的。** 库跑在 WAL 模式,最近的写还在 steam.db-wal 里,
 *    直接拷 steam.db 拿到的是旧的甚至坏的。而且实测:程序在托盘里跑着的时候,
 *    这个文件是**被锁的**(PowerShell 的 Get-FileHash 直接读不动)。所以走
 *    VACUUM INTO —— 让 SQLite 自己写出一份合并好 WAL 的完整副本,不碰锁。
 *
 * 2. **恢复不能替换文件。** 服务进程手里攥着这个库的句柄,Windows 上开着的文件
 *    删不掉。所以恢复是 ATTACH 上备份库、在一个事务里把表搬过来,句柄全程有效,
 *    也不需要重启子进程。
 *
 * 3. **列是按交集搬的,不是 SELECT *。** 早一点的备份少几列(cover_url 是后加的),
 *    INSERT INTO games SELECT * FROM bak.games 会直接报列数不匹配;
 *    而反过来 —— 新备份恢复到老程序上 —— 更糟,会静默错位。取两边的交集,
 *    多出来的列留默认值。
 *
 * config.json 是**连密钥一起**装进去的(明文的 Steam key、Notion token、AI key)。
 * 这是刻意的:整个功能的价值就是"在新电脑上打开就能用",少了密钥就只剩一半。
 * 代价必须在导出那一刻说清楚,而不是靠悄悄砍掉功能来回避 —— 谁拿到这个文件,
 * 谁就能花你的 AI 额度。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { zipWrite, zipRead } from './zip.js';
import { containedPath } from './pathsafe.js';

export const BACKUP_VERSION = 1;
const DB_ENTRY = 'steam.db';
const CONFIG_ENTRY = 'config.json';
const GUIDE_PREFIX = 'guides/';
const MANIFEST = 'manifest.json';

/** 搬哪些表。sqlite_sequence 不在里面:它是 AUTOINCREMENT 的内部记账,跟着行走就行 */
const TABLES = ['games', 'achievements', 'guides', 'sync_log', 'meta'];

/** 草稿不进备份 —— 它是没写完的中间产物,tracker.js 自己就有 drafts --clean 在删它 */
const SKIP_DIRS = new Set(['.drafts']);

/** SQLite 的字符串字面量里,单引号靠翻倍转义 */
const sqlPath = (p) => p.replace(/'/g, "''");

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

function walkGuides(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkGuides(full, base, out);
    else out.push({ rel: relative(base, full).split(sep).join('/'), full });
  }
  return out;
}

/** 让 SQLite 自己写一份完整副本出来(见文件头第 1 条:不能用复制的) */
function snapshotDb(db) {
  const tmp = join(tmpdir(), `sat-backup-${process.pid}-${Date.now()}.db`);
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
  try {
    return readFileSync(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function createBackup({ db, configPath, guidesDir, appVersion = '', now = new Date() }) {
  const entries = [{ name: DB_ENTRY, data: snapshotDb(db) }];

  const guideFiles = walkGuides(guidesDir);
  for (const g of guideFiles) entries.push({ name: GUIDE_PREFIX + g.rel, data: readFileSync(g.full) });

  const hasConfig = Boolean(configPath && existsSync(configPath));
  if (hasConfig) entries.push({ name: CONFIG_ENTRY, data: readFileSync(configPath) });

  const counts = Object.fromEntries(
    TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c])
  );
  const manifest = {
    format: BACKUP_VERSION,
    appVersion,
    createdAt: now.toISOString(),
    hasConfig,
    guideFiles: guideFiles.length,
    counts,
  };
  entries.unshift({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  return { zip: zipWrite(entries, now), manifest };
}

/** 备份文件的默认名字。带时间戳,因为"再备份一次"不该覆盖上一次 */
export function backupName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `steam-tracker-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

// ---------------------------------------------------------------------------
// 读 / 校验
// ---------------------------------------------------------------------------

/**
 * 先看清楚再动手 —— 恢复会覆盖现有数据,所以界面上必须能在**动手之前**
 * 告诉用户这个文件里是什么(什么时候备的、多少款游戏、带不带密钥)。
 */
export function inspectBackup(buf) {
  const files = zipRead(buf);
  if (!files.has(DB_ENTRY)) throw new Error('这个 zip 里没有 steam.db,不是本工具的备份文件');

  let manifest = null;
  if (files.has(MANIFEST)) {
    try {
      manifest = JSON.parse(files.get(MANIFEST).toString('utf8'));
    } catch {
      manifest = null; // 清单读不动不该挡住恢复:真正的数据在 steam.db 里
    }
  }
  if (manifest && manifest.format > BACKUP_VERSION) {
    throw new Error(`这个备份来自更新的版本(格式 ${manifest.format},本程序只认到 ${BACKUP_VERSION})。升级后再恢复。`);
  }

  const guideFiles = [...files.keys()].filter((k) => k.startsWith(GUIDE_PREFIX));
  return { files, manifest, hasConfig: files.has(CONFIG_ENTRY), guideFiles };
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/** 两边都有的列。见文件头第 3 条:版本之间列数会差 */
function sharedColumns(db, table) {
  const cols = (schema) => db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map((r) => r.name);
  const main = new Set(cols('main'));
  return cols('bak').filter((c) => main.has(c));
}

function tableExists(db, schema, table) {
  return Boolean(
    db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table)
  );
}

function copyTables(db) {
  const moved = {};
  for (const t of TABLES) {
    if (!tableExists(db, 'bak', t) || !tableExists(db, 'main', t)) continue;
    const cols = sharedColumns(db, t);
    if (!cols.length) continue;
    const list = cols.map((c) => `"${c}"`).join(', ');
    db.exec(`DELETE FROM main.${t}`);
    db.exec(`INSERT INTO main.${t} (${list}) SELECT ${list} FROM bak.${t}`);
    moved[t] = db.prepare(`SELECT COUNT(*) c FROM main.${t}`).get().c;
  }
  return moved;
}

/**
 * zip 里的路径不能直接拿去写盘:一个 `../` 就能把文件写到 `guides/` 外面去(zip-slip)。
 * 这里只接受留在 `guides/` 里面的相对路径,别的一律返回 null。
 *
 * **分隔符按两种算,不是只按 `/`。** zip 规范说条目名用正斜杠,但那是规范,不是校验器 ——
 * 攻击者手写一个 `guides/..\..\x.md` 完全合法,而 Windows 上 `join()` 把反斜杠也
 * 当分隔符。只按 `/` 拆的话,`..\..` 整个是一个"文件名",过得了 `.includes('..')`
 * 这一关,然后被 `join` 解析成真正的上跳。实测能落到 `D:\GitHub\` 下。
 *
 * **最后那道 `containedPath` 是主检查,不是兜底。** 上面几条是"看得懂的拒绝理由",
 * 而它管的是所有没想到的形状 —— 而没想到的形状正是这个函数出过事的原因。
 * 判据和另外三处包含性检查共用一份,见 `lib/pathsafe.js` 的表。
 */
function safeGuidePath(guidesDir, entryName) {
  const rel = entryName.slice(GUIDE_PREFIX.length);
  if (!rel || /^[/\\]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split(/[/\\]+/);
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
  return containedPath(guidesDir, ...parts);
}

/**
 * 攻略文件是**覆盖写,不删除**。恢复本身是"换成备份里的那一套",但删掉用户
 * 现有的 .md 是不可撤销的,而多留几个文件最坏也只是 guides 表里没登记它 ——
 * 两种错的代价差太远,所以只往里写。
 */
function restoreGuides(files, guidesDir) {
  let written = 0;
  for (const [name, data] of files) {
    if (!name.startsWith(GUIDE_PREFIX)) continue;
    const dest = safeGuidePath(guidesDir, name);
    if (!dest) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    written++;
  }
  return written;
}

/**
 * 就地恢复。db 的句柄全程有效(见文件头第 2 条),调用方不需要重开库。
 * restoreConfig 为 false 时只搬数据,密钥保持当前这台机器的。
 */
export function applyBackup({ db, buf, configPath, guidesDir, restoreConfig = true }) {
  const { files, manifest, hasConfig } = inspectBackup(buf);

  const tmp = join(tmpdir(), `sat-restore-${process.pid}-${Date.now()}.db`);
  writeFileSync(tmp, files.get(DB_ENTRY));

  let moved;
  try {
    // ATTACH 必须在事务外(SQLite 不允许在事务里挂库),所以顺序是
    // ATTACH → BEGIN → 搬 → COMMIT → DETACH
    db.exec(`ATTACH DATABASE '${sqlPath(tmp)}' AS bak`);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        moved = copyTables(db);
        db.exec('COMMIT');
      } catch (err) {
        // 同 db.js:ROLLBACK 抛出去会盖掉真正的原因
        try { db.exec('ROLLBACK'); } catch { /* 要报的是下面那个 */ }
        throw err;
      }
    } finally {
      db.exec('DETACH DATABASE bak');
    }
  } finally {
    rmSync(tmp, { force: true });
  }

  const guideFiles = restoreGuides(files, guidesDir);

  let config = false;
  if (restoreConfig && hasConfig && configPath) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, files.get(CONFIG_ENTRY));
    config = true;
  }

  return { manifest, tables: moved, guideFiles, config };
}
