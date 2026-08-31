/**
 * Backup / restore
 * ------------------------------------------------
 * One .zip holding data/steam.db + guides/ + config.json. Restore it on another machine and
 * it opens as the same Dashboard, without even re-entering the credentials.
 *
 * Why not "export CSV and import it back" (that path was removed entirely, see lib/csv.js):
 * CSV holds three tables, and **half of what genuinely cannot be recovered is not in them** —
 * the keys in config.json, and the AI-generated guide prose under guides/, which cost real
 * money. A migration feature that omits those raises no error; it simply lets someone discover
 * on the new machine that the guides are gone. The database file is self-contained, so moving
 * it is **structurally lossless**, rather than lossless only as long as column order is
 * maintained by discipline.
 *
 * Three hazards, each of them silent:
 *
 * 1. **The database must not be copied.** It runs in WAL mode, so recent writes are still in
 *    steam.db-wal and copying steam.db yields something stale or broken. Measured, in addition:
 *    while the program runs in the tray that file is **locked** (PowerShell's Get-FileHash
 *    cannot read it). Hence VACUUM INTO — SQLite writes out a complete copy with the WAL
 *    merged in, without touching the lock.
 *
 * 2. **Restore must not replace the file.** The server process holds a handle to this
 *    database, and Windows will not delete an open file. So restore ATTACHes the backup
 *    database and moves the tables across inside a transaction; the handle stays valid
 *    throughout, and no child process has to be restarted.
 *
 * 3. **Columns are copied by intersection, not SELECT *.** An older backup is short a column
 *    (cover_url was added later), and INSERT INTO games SELECT * FROM bak.games fails
 *    outright on the column count; the reverse — restoring a newer backup into an older
 *    program — is worse, misaligning silently. Take the intersection of both sides and leave
 *    the extra columns at their defaults.
 *
 * config.json is included **together with its credentials** (the Steam key, Notion token and
 * AI key, all in plain text). This is deliberate: the entire value of the feature is "open it
 * on the new machine and it works", and without the credentials only half of that remains.
 * The cost has to be stated at the moment of export rather than avoided by quietly removing
 * the feature — whoever holds this file can spend the owner's AI allowance.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { zipWrite, zipRead } from './zip.js';
import { containedPath } from './pathsafe.js';
import { msg } from './messages.js';

export const BACKUP_VERSION = 1;
const DB_ENTRY = 'steam.db';
const CONFIG_ENTRY = 'config.json';
const GUIDE_PREFIX = 'guides/';
const MANIFEST = 'manifest.json';

/** Which tables to move. sqlite_sequence is not among them: it is AUTOINCREMENT's internal bookkeeping and follows the rows */
const TABLES = ['games', 'achievements', 'guides', 'sync_log', 'meta'];

/** Drafts are excluded — they are unfinished intermediate output, and tracker.js has drafts --clean for removing them */
const SKIP_DIRS = new Set(['.drafts']);

/** In a SQLite string literal, a single quote is escaped by doubling it */
const sqlPath = (p) => p.replace(/'/g, "''");

// ---------------------------------------------------------------------------
// Backup
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

/** Have SQLite write out a complete copy (see hazard 1 above: it must not be copied) */
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

/** The default name for a backup file. Timestamped, because "back up again" should not overwrite the previous one */
export function backupName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `steam-tracker-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

// ---------------------------------------------------------------------------
// Reading / validation
// ---------------------------------------------------------------------------

/**
 * Look before acting — a restore overwrites existing data, so the interface has to be able to
 * state **before** anything happens what this file contains (when it was made, how many games,
 * whether it carries credentials).
 */
export function inspectBackup(buf) {
  const files = zipRead(buf);
  if (!files.has(DB_ENTRY)) throw new Error(msg('backup.notOurs'));

  let manifest = null;
  if (files.has(MANIFEST)) {
    try {
      manifest = JSON.parse(files.get(MANIFEST).toString('utf8'));
    } catch {
      manifest = null; // An unreadable manifest must not block a restore: the real data is in steam.db
    }
  }
  if (manifest && manifest.format > BACKUP_VERSION) {
    throw new Error(msg('backup.tooNew', { format: manifest.format, supported: BACKUP_VERSION }));
  }

  const guideFiles = [...files.keys()].filter((k) => k.startsWith(GUIDE_PREFIX));
  return { files, manifest, hasConfig: files.has(CONFIG_ENTRY), guideFiles };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** The columns present on both sides. See hazard 3 above: the column count differs between versions */
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
 * A path inside the zip cannot be written to disk as-is: one `../` writes a file outside
 * `guides/` (zip-slip). This accepts only relative paths that stay inside `guides/` and
 * returns null for everything else.
 *
 * **Both separators count, not just `/`.** The ZIP spec says entry names use forward slashes,
 * but that is a specification, not a validator — an attacker writing `guides/..\..\x.md` by
 * hand is entirely legal, and on Windows `join()` treats a backslash as a separator too.
 * Splitting on `/` alone makes `..\..` a single "filename", which passes a `.includes('..')`
 * check and is then resolved by `join` into a genuine climb. Measured: it landed outside the
 * repository.
 *
 * **The final `containedPath` is the primary check, not a fallback.** The conditions above
 * produce comprehensible refusal reasons, while that one covers every shape nobody anticipated
 * — and an unanticipated shape is exactly why this function had a defect in the first place.
 * The predicate is shared with the other three containment checks; see the table in
 * `lib/pathsafe.js`.
 */
function safeGuidePath(guidesDir, entryName) {
  const rel = entryName.slice(GUIDE_PREFIX.length);
  if (!rel || /^[/\\]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split(/[/\\]+/);
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
  return containedPath(guidesDir, ...parts);
}

/**
 * Guide files are **overwritten, never deleted**. A restore does mean "switch to the set in the
 * backup", but deleting the user's existing .md files is irreversible, whereas a few extra
 * files at worst go unregistered in the guides table. The costs of the two errors are so far
 * apart that this only writes.
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
 * Restore in place. The db handle stays valid throughout (see hazard 2 above), so the caller
 * does not need to reopen the database.
 * With restoreConfig false, only the data is moved and the credentials remain this machine's.
 */
export function applyBackup({ db, buf, configPath, guidesDir, restoreConfig = true }) {
  const { files, manifest, hasConfig } = inspectBackup(buf);

  const tmp = join(tmpdir(), `sat-restore-${process.pid}-${Date.now()}.db`);
  writeFileSync(tmp, files.get(DB_ENTRY));

  let moved;
  try {
    // ATTACH must happen outside a transaction (SQLite does not permit attaching inside one),
    // so the order is ATTACH → BEGIN → move → COMMIT → DETACH
    db.exec(`ATTACH DATABASE '${sqlPath(tmp)}' AS bak`);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        moved = copyTables(db);
        db.exec('COMMIT');
      } catch (err) {
        // As in db.js: letting ROLLBACK throw would mask the real cause
        try { db.exec('ROLLBACK'); } catch { /* the one below is what should be reported */ }
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
