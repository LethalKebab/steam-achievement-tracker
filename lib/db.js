/**
 * The SQLite data layer
 * ------------------------------------------------
 *   games        — one row per appid: name (localised) and name_en, unlocked/total, completion rate,
 *                  status, ♥/★/family marks
 *   achievements — per-achievement detail (Chinese and English names, hidden flag, icon)
 *   guides       — appid → where the guide is (a Notion link or a local md filename)
 *   sync_log     — per-entry results of checkbox sync, for review afterwards
 *   meta         — miscellaneous state (the last sync time, for example)
 *
 * Two design points that are easy to get wrong:
 * 1. "This game has no achievement system" is has_achievements=0 plus total=NULL — neither a
 *    string in a numeric column nor total=0. A string in a numeric column would force every
 *    statistic to type-check first
 * 2. status (the classification: ''/Unvetted/Manual) and sync_locked (skip automatic syncing)
 *    are **two columns**. They usually move together, but the classification can be pinned
 *    while daily syncing continues — those are genuinely two different things
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  appid            TEXT PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT '',
  name_en          TEXT NOT NULL DEFAULT '',
  achieved         INTEGER,
  total            INTEGER,
  has_achievements INTEGER,
  rate             REAL,
  status           TEXT NOT NULL DEFAULT '',
  sync_locked      INTEGER NOT NULL DEFAULT 0,
  favorite         INTEGER NOT NULL DEFAULT 0,
  priority         INTEGER NOT NULL DEFAULT 0,
  family           INTEGER NOT NULL DEFAULT 0,
  new_ach_date     TEXT,
  updated_at       TEXT,
  last_played      INTEGER,
  stats_checked_at TEXT,
  perfect_lost_date TEXT,
  ach_added_date    TEXT
);
CREATE TABLE IF NOT EXISTS achievements (
  appid       TEXT NOT NULL,
  api_name    TEXT NOT NULL,
  game_name   TEXT,
  name_cn     TEXT,
  name_en     TEXT,
  description TEXT,
  hidden      INTEGER NOT NULL DEFAULT 0,
  icon        TEXT,
  PRIMARY KEY (appid, api_name)
);
CREATE TABLE IF NOT EXISTS guides (
  appid   TEXT PRIMARY KEY,
  name    TEXT,
  url     TEXT,
  kind    TEXT NOT NULL DEFAULT 'notion',
  updated TEXT,
  -- The section intros **we ourselves** wrote last time (a JSON array).
  -- Used as a reverse lookup on overwrite: an intro on the page that is found here was
  -- written by us and may be replaced; one that is not found was written or edited by the
  -- user and is kept. Without this column the only option is a heuristic (see carriesPointer)
  gen_prose TEXT
);
CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  appid      TEXT,
  game_name  TEXT,
  achievement TEXT,
  result     TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_ach_appid ON achievements(appid);
`;

/**
 * Columns added later. SCHEMA is CREATE TABLE IF NOT EXISTS and has no effect whatsoever on
 * a table that **already exists**, so a new column must additionally go through ALTER TABLE.
 * Both paths are needed: a new database takes SCHEMA, an existing one takes this.
 * Adding a column means appending one row to this table; ADD COLUMN neither locks the table
 * nor rewrites data.
 */
const ADDED_COLUMNS = [
  ['last_played', 'INTEGER'],
  ['stats_checked_at', 'TEXT'],
  // The two notification events. **These record the moment a transition happened, not
  // something derivable from current state** — see the tests in updateGameStats, which is
  // the only place the previous value is still visible
  ['perfect_lost_date', 'TEXT'],
  ['ach_added_date', 'TEXT'],
  // The **actual** store header URL, obtained from Steam (see resolveCover in api.js).
  // Only set for games whose URL cannot be guessed — see that function; in one sentence,
  // newer games' assets sit under an unguessable hash path, so URL assembly must fail for them
  ['cover_url', 'TEXT'],
  // The English store title, kept **beside** name rather than instead of it: name is deliberately
  // the localised one (fetchAppName hunts for a Chinese title), and an English search term is
  // `indexOf === -1` against it. Both search tests in the Dashboard match either column.
  // `NOT NULL DEFAULT ''` so a migrated row reads the same as a freshly inserted one — '' is the
  // single "no English title on record" value, with no NULL to test for as well.
  ['name_en', "TEXT NOT NULL DEFAULT ''"],
];

function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${type}`);
  }
  // guides has a later column too. **An existing database never re-runs CREATE TABLE**, so
  // adding it has to be explicit, or reads come back undefined — and "no record" versus
  // "a record that is empty" are two different behaviours downstream
  const guideCols = new Set(db.prepare('PRAGMA table_info(guides)').all().map((c) => c.name));
  if (!guideCols.has('gen_prose')) db.exec('ALTER TABLE guides ADD COLUMN gen_prose TEXT');
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------

export const nowIso = () => new Date().toISOString();

/** yyyy-MM-dd in **local** time (not UTC — running in the evening would be off by a day) */
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function allGames(db) {
  return db.prepare('SELECT * FROM games ORDER BY rate IS NULL, rate DESC, total DESC').all();
}

export function getGame(db, appid) {
  return db.prepare('SELECT * FROM games WHERE appid = ?').get(String(appid));
}

export function countGames(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM games').get().n;
}

/**
 * Insert a game row. Does nothing if it already exists (never overwrites existing manual marks);
 * returns whether a row was actually inserted.
 *
 * `nameEn` is the English store title, stored **verbatim** — original case, no folding, no
 * concatenation with `name`. '' means "no English title on record", which is not the same fact as
 * `nameEn === name` ("the English title happens to be what is displayed"), so an unknown one is
 * left empty rather than filled with a copy of `name`.
 */
export function insertGame(db, { appid, name = '', nameEn = '', status = '', syncLocked = 0, family = 0 }) {
  const res = db
    .prepare(
      `INSERT INTO games (appid, name, name_en, status, sync_locked, family, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(appid) DO NOTHING`
    )
    .run(String(appid), name, nameEn ?? '', status, syncLocked ? 1 : 0, family ? 1 : 0, nowIso());
  return res.changes > 0;
}

/** Write one achievement-statistics result (achieved/total/rate), handling the "the total went up" date stamp along the way */
export function updateGameStats(db, appid, { achieved, total }) {
  const prev = getGame(db, appid);
  const rate = total > 0 ? achieved / total : 0;
  // The total is higher than last recorded → a game update added achievements; stamp the date (the Dashboard uses it for the notice)
  const bumped = typeof prev?.total === 'number' && total > prev.total;
  // More unlocked than last time → this row may have guide checkboxes that should now be
  // ticked. Used only to select candidates for serve's automatic checkbox sync (see
  // runCheckboxSync in server.js); never written to any column.
  // With no baseline (prev.achieved is NULL, this row's first sync) this is false: "went up"
  // is meaningless there, and every one of several hundred rows would become a candidate,
  // degrading the targeted sync into a full one.
  const gained = typeof prev?.achieved === 'number' && achieved > prev.achieved;

  // ---- The two notification events -----------------------------------------
  //
  // Both are **transitions**, and the previous value is gone after this UPDATE — so they
  // must be decided and written here. This is the exact opposite of guide-status's rule of
  // "converge on state, never detect transitions", and deliberately so: that rule answers
  // "what should this page's status be now" (current state suffices), while this answers
  // "what changed recently" (current state cannot answer it at all). The price is accepted —
  // if the run that observes a transition fails to write, that notice is lost permanently.
  // The only mitigation is that the decision and the write are in one statement, with no
  // intervening step that can fail.
  //
  // A completed game that a developer added achievements to. The current state is "not
  // complete", which looks identical to "was never complete", so past this line the two
  // become indistinguishable
  const wasPerfect =
    typeof prev?.total === 'number' && typeof prev?.achieved === 'number' &&
    prev.total > 0 && prev.achieved >= prev.total;
  const perfectLost = bumped && wasPerfect;
  // Steam previously said this game had no achievement system (has_achievements = 0) and now
  // returns data. The line below writes 1, and the old value disappears at that moment.
  // **Only an explicit 0 counts** — NULL means "never synced", which is seeing this row for
  // the first time, not "the game added achievements"
  const achAdded = prev?.has_achievements === 0;

  db.prepare(
    `UPDATE games SET achieved = ?, total = ?, has_achievements = 1, rate = ?,
       new_ach_date = COALESCE(?, new_ach_date),
       perfect_lost_date = COALESCE(?, perfect_lost_date),
       ach_added_date = COALESCE(?, ach_added_date),
       updated_at = ?
     WHERE appid = ?`
  ).run(
    achieved, total, rate,
    bumped ? nowIso() : null,
    perfectLost ? nowIso() : null,
    achAdded ? nowIso() : null,
    nowIso(), String(appid)
  );
  return { rate, bumped, gained, perfectLost, achAdded };
}

/** Steam states explicitly that this game has no stats for this account: mark it as having no achievement system, not as 0 */
export function markNoAchievements(db, appid) {
  db.prepare(
    `UPDATE games SET has_achievements = 0, total = NULL, achieved = NULL, rate = NULL, updated_at = ?
     WHERE appid = ?`
  ).run(nowIso(), String(appid));
}

/**
 * Record that this row was just reconciled against Steam. The sync's sampling logic rests
 * entirely on these two columns:
 * - stats_checked_at: the rotating sweep sorts by it (oldest first)
 * - last_played: the rtime_last_played at the moment of reconciliation, compared against a
 *   fresh value next time to decide whether to check again
 *
 * Call this only after **a result was genuinely read** (success, or a confirmed absence of an
 * achievement system). It **must not** be called for a retry such as a 429 — that row would
 * be treated as just-checked and skipped next time.
 * Rows with no rtime (absent from the owned list) pass null, and COALESCE preserves the
 * existing value rather than clearing it.
 * updated_at is deliberately untouched: that column means "the data changed", and checking
 * and finding nothing changed is not a change.
 */
export function markStatsChecked(db, appid, lastPlayed = null) {
  db.prepare(
    `UPDATE games SET stats_checked_at = ?, last_played = COALESCE(?, last_played) WHERE appid = ?`
  ).run(nowIso(), lastPlayed, String(appid));
}

export function setGameField(db, appid, field, value) {
  // field is interpolated straight into SQL, so this allow-list is an injection gate rather
  // than a matter of style — a new column has to register here. cover_url is on the list
  // because api.resolveCover looks it up at runtime and writes it back
  const allowed = ['name', 'name_en', 'status', 'sync_locked', 'favorite', 'priority', 'family', 'cover_url'];
  if (!allowed.includes(field)) throw new Error(`不允许直接改这一列: ${field}`);
  const res = db
    .prepare(`UPDATE games SET ${field} = ?, updated_at = ? WHERE appid = ?`)
    .run(value, nowIso(), String(appid));
  return res.changes > 0;
}

export function deleteGame(db, appid) {
  return db.prepare('DELETE FROM games WHERE appid = ?').run(String(appid)).changes > 0;
}

// ---------------------------------------------------------------------------
// achievements
// ---------------------------------------------------------------------------

export function achievementsFor(db, appid) {
  return db.prepare('SELECT * FROM achievements WHERE appid = ? ORDER BY rowid').all(String(appid));
}

export function appIdsWithAchievements(db) {
  return new Set(db.prepare('SELECT DISTINCT appid FROM achievements').all().map((r) => r.appid));
}

export function replaceAchievements(db, appid, rows) {
  const del = db.prepare('DELETE FROM achievements WHERE appid = ?');
  const ins = db.prepare(
    `INSERT INTO achievements (appid, api_name, game_name, name_cn, name_en, description, hidden, icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(appid, api_name) DO UPDATE SET
       game_name = excluded.game_name, name_cn = excluded.name_cn, name_en = excluded.name_en,
       description = excluded.description, hidden = excluded.hidden, icon = excluded.icon`
  );
  db.exec('BEGIN');
  try {
    del.run(String(appid));
    for (const r of rows) {
      ins.run(
        String(appid),
        r.apiName,
        r.gameName ?? '',
        r.nameCn ?? '',
        r.nameEn ?? '',
        r.description ?? '',
        r.hidden ? 1 : 0,
        r.icon ?? ''
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    // ROLLBACK can throw as well — when a statement fails, SQLite may already have closed the
    // transaction, and rolling back then raises "no transaction is active". Letting that
    // escape would mask the real cause with an unrelated error, and the real cause is the
    // only thing anyone wants to see here
    try { db.exec('ROLLBACK'); } catch { /* the one below is what should be reported */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// guides
// ---------------------------------------------------------------------------

export function allGuides(db) {
  return db.prepare('SELECT * FROM guides ORDER BY appid').all();
}

export function guideUrlMap(db) {
  const map = {};
  for (const g of allGuides(db)) if (g.url) map[g.appid] = g.url;
  return map;
}

export function upsertGuide(db, { appid, name, url, kind = 'notion' }) {
  const existed = db.prepare('SELECT 1 FROM guides WHERE appid = ?').get(String(appid));
  db.prepare(
    `INSERT INTO guides (appid, name, url, kind, updated) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(appid) DO UPDATE SET name = excluded.name, url = excluded.url,
       kind = excluded.kind, updated = excluded.updated`
  ).run(String(appid), name ?? '', url ?? '', kind, localDate());
  return existed ? 'updated' : 'appended';
}

/**
 * Record the section intros **we wrote ourselves this time**.
 *
 * Call this only after a generation or overwrite has successfully landed. A path such as
 * `syncGuidesFromNotion`, which discovers an existing guide, must never touch it — that path
 * wrote nothing, and clearing this would discard the provenance, so the next overwrite would
 * treat our own passages as hand-written and keep them, accumulating indefinitely.
 */
export function setGuideProse(db, appid, prose) {
  db.prepare('UPDATE guides SET gen_prose = ? WHERE appid = ?')
    .run(prose == null ? null : JSON.stringify(prose), String(appid));
}

/** Read back the last recorded section intros. Returns `null` when there is no record (which must stay distinct from "recorded, but empty") */
export function getGuideProse(db, appid) {
  const row = db.prepare('SELECT gen_prose FROM guides WHERE appid = ?').get(String(appid));
  if (!row?.gen_prose) return null;
  try {
    const v = JSON.parse(row.gen_prose);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function getGuide(db, appid) {
  return db.prepare('SELECT * FROM guides WHERE appid = ?').get(String(appid));
}

// ---------------------------------------------------------------------------
// sync_log / meta
// ---------------------------------------------------------------------------

export function appendSyncLog(db, entries) {
  if (!entries?.length) return;
  const ins = db.prepare(
    'INSERT INTO sync_log (ts, appid, game_name, achievement, result) VALUES (?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      ins.run(e.ts ?? nowIso(), e.appid ?? '', e.gameName ?? '', e.achievement ?? '', e.result ?? '');
    }
    db.exec('COMMIT');
  } catch (err) {
    // ROLLBACK can throw as well — when a statement fails, SQLite may already have closed the
    // transaction, and rolling back then raises "no transaction is active". Letting that
    // escape would mask the real cause with an unrelated error, and the real cause is the
    // only thing anyone wants to see here
    try { db.exec('ROLLBACK'); } catch { /* the one below is what should be reported */ }
    throw err;
  }
}

export function recentSyncLog(db, limit = 30) {
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit);
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
