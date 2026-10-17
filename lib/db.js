/**
 * The SQLite data layer
 * ------------------------------------------------
 *   games        — one row per appid: name (localised) and name_en, unlocked/total, completion rate,
 *                  status, ♥/★/family marks
 *   achievements — per-achievement detail (Chinese and English names and descriptions, hidden flag, icon)
 *   achievement_sets — the sets a game's achievements are grouped into, with this account's progress in each
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
import { msg } from './messages.js';

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
  hidden           INTEGER NOT NULL DEFAULT 0,
  new_ach_date     TEXT,
  updated_at       TEXT,
  last_played      INTEGER,
  playtime_forever INTEGER,
  stats_checked_at TEXT,
  perfect_lost_date TEXT,
  ach_added_date    TEXT,
  cover_url         TEXT,
  -- When this game's achievement sets were last read from Steam. NULL means never asked, which is
  -- not the same fact as "asked, and there are none" (that is a stamp with no rows)
  sets_checked_at   TEXT
);
CREATE TABLE IF NOT EXISTS achievements (
  appid       TEXT NOT NULL,
  api_name    TEXT NOT NULL,
  game_name   TEXT,
  name_cn     TEXT,
  name_en     TEXT,
  description TEXT,
  description_en TEXT NOT NULL DEFAULT '',
  hidden      INTEGER NOT NULL DEFAULT 0,
  icon        TEXT,
  -- Whether this account holds it. NULL means never observed, which is a different fact from 0
  unlocked    INTEGER,
  -- The share of all owners holding it, 0-100, from Steam's global percentages
  rarity      REAL,
  rarity_checked_at TEXT,
  -- When this row was first written, and never after: a patch's additions carry the moment they
  -- arrived, which is how the list tells them from the set a game shipped with. NULL means the row
  -- predates the column and its moment was never recorded
  first_seen  TEXT,
  PRIMARY KEY (appid, api_name)
);
-- The sets a developer has split a game's achievements into, and how far along this account is in
-- each. Rows exist only for a game Steam reports with more than one group; a game without sets has
-- none, and games.sets_checked_at is what records that it was asked.
--
-- Everything in a row comes from one reading, so a game's rows are replaced together and carry the
-- stamp they share with games.sets_checked_at. Nothing here feeds games.total, games.achieved or the
-- average completion rate: the flat list those come from still counts every achievement, DLC the
-- account does not own included. Two figures are computed from these rows: the readout's completed
-- count, which counts a finished set as a unit (completedUnits in lib/sets.js), and the remaining
-- count in the panel of a game with sets, which leaves out the sets the account cannot earn.
CREATE TABLE IF NOT EXISTS achievement_sets (
  appid        TEXT NOT NULL,
  -- Steam's groupid. 0 is the base game, and it can be empty (a game that moved every achievement
  -- into other sets)
  set_id       INTEGER NOT NULL,
  -- Both languages are kept, as the achievements table keeps them. '' for the base game, which has
  -- no name of its own: the page words it
  name_en      TEXT NOT NULL DEFAULT '',
  name_cn      TEXT NOT NULL DEFAULT '',
  -- The DLC's appid when this is a DLC set, NULL otherwise
  dlc_appid    TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  -- How many achievements the set holds, and how many of them complete it (archived ones excluded)
  total        INTEGER NOT NULL DEFAULT 0,
  need         INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  -- 0 for a set the developer keeps to themselves; the page never draws one
  visible      INTEGER NOT NULL DEFAULT 1,
  -- This account. 0 for a set Steam left out of its answer, which is a DLC the account cannot play
  achievable   INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  -- Steam's own flag. A completed set stays completed after the developer adds to it
  completed    INTEGER NOT NULL DEFAULT 0,
  -- Unix seconds, as Steam sends it
  completed_at INTEGER,
  checked_at   TEXT NOT NULL,
  PRIMARY KEY (appid, set_id)
);
-- Which set each achievement of a game with sets is in, by internal name (achievements.api_name).
-- A separate table rather than a column of achievements: that table is written by the schema phase,
-- which skips a finished game, while these come from the same reading as achievement_sets and are
-- replaced in the same write. Rows exist only for a game that holds sets. A name the table does not
-- hold is one no reading placed, and the list draws it outside every set.
CREATE TABLE IF NOT EXISTS achievement_set_members (
  appid    TEXT NOT NULL,
  api_name TEXT NOT NULL,
  set_id   INTEGER NOT NULL,
  PRIMARY KEY (appid, api_name)
);
CREATE TABLE IF NOT EXISTS guides (
  appid   TEXT PRIMARY KEY,
  name    TEXT,
  url     TEXT,
  kind    TEXT NOT NULL DEFAULT 'notion',
  updated TEXT,
  -- Which language the guide is written in. A guide is written once and never retranslated, so a
  -- library holds both at the same time and the interface has to be able to say which is which.
  -- **Display only**: reverse-resolution and the lint rule both accept either language's
  -- description, deliberately, so that neither depends on this value being right
  lang    TEXT NOT NULL DEFAULT 'zh',
  -- The section intros **we ourselves** wrote last time (a JSON array).
  -- Used as a reverse lookup on overwrite: an intro on the page that is found here was
  -- written by us and may be replaced; one that is not found was written or edited by the
  -- user and is kept. Without this column the only option is a heuristic (see carriesPointer)
  gen_prose TEXT,
  -- When this page's status was last weighed against play. The comparison that decides whether
  -- the game has been played since is against this, never against a fixed recency window --
  -- see shouldMarkInProgress
  status_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  appid      TEXT,
  game_name  TEXT,
  achievement TEXT,
  result     TEXT
);
CREATE TABLE IF NOT EXISTS hltb (
  appid          TEXT PRIMARY KEY,
  -- NULL with a checked_at set is the recorded miss: searched, nothing on HowLongToBeat carries
  -- this appid. It is a real answer and stops the search being repeated every sync
  hltb_id        INTEGER,
  -- The candidate's own page named this appid. An unverified row never stores hours, so this is
  -- 1 for every row that has any, except one the reader pinned by hand
  verified       INTEGER NOT NULL DEFAULT 0,
  -- The reader supplied the id. Never overwritten by a search, and never cleared by a miss
  manual         INTEGER NOT NULL DEFAULT 0,
  -- Seconds, all four. The spread is stored alongside the midpoint because a single number is
  -- measured to land within ±30% of the truth only about seven times in ten, and a range that
  -- says so is worth more than a point estimate that does not
  comp_100       INTEGER,
  comp_100_med   INTEGER,
  comp_100_lo    INTEGER,
  comp_100_hi    INTEGER,
  -- How many people reported a completionist time. Single digits mean the figure is one
  -- stranger's afternoon, and the interface says so rather than ranking on it
  comp_100_count INTEGER,
  checked_at     TEXT
);
-- One row per reading taken from HowLongToBeat, so how fast a figure is moving is a question
-- the database can answer. hltb holds only the latest reading, and a refresh overwrites it —
-- which makes "did this number change, and how much" unanswerable from the table that stores it.
--
-- **The refresh interval is fixed at HLTB_STALE_DAYS for every game, and this table exists to
-- find out whether it should be.** A completionist figure is a median over submissions: at 500
-- submissions a month's worth of new ones cannot move it, and at 3 a single one halves it. That
-- argues for spending the request budget by how fast a row actually moves — but nothing here has
-- ever measured how fast that is, so the readings are collected first and the policy decided
-- against them.
--
-- **comp_100_count is the signal, and its rate of change rather than its size.** A count of 0
-- usually means nobody will ever report one, not that the game is new; a count that jumps is a
-- game whose content just changed. That distinction needs two readings, which is this table.
CREATE TABLE IF NOT EXISTS hltb_history (
  appid          TEXT NOT NULL,
  -- The same stamp written to hltb.checked_at by the write this row records, so the two join
  checked_at     TEXT NOT NULL,
  comp_100       INTEGER,
  comp_100_med   INTEGER,
  comp_100_count INTEGER,
  -- One reading per game per moment. It is also what makes the seeding below safe to re-run
  PRIMARY KEY (appid, checked_at)
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
  // Minutes played, for rows GetOwnedGames does not list. **Only those rows** — an owned game
  // carries rtime_last_played in a response already being received, so recording its playtime as
  // well would be a second answer to a question that already has one. NULL means "no baseline
  // yet", which recordUnownedPlaytime reads as "first observation, nothing to compare".
  ['playtime_forever', 'INTEGER'],
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
  // Kept out of the Dashboard's table by the reader's own choice. **A view mark and nothing
  // more**: it does not reach the readout, the sync, or Steam. Note the name is also a column on
  // `achievements`, where it means something unrelated (a spoiler achievement, whose description
  // Steam withholds) — the two never meet, but a grep for `hidden` finds both.
  ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
  // When the achievement sets were last read. Like stats_checked_at it is never `updated_at`: reading
  // a game's sets and finding nothing new is not a change to the game
  ['sets_checked_at', 'TEXT'],
];

function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${type}`);
  }
  // guides and achievements each have a later column too. **An existing database never re-runs
  // CREATE TABLE**, so adding one has to be explicit, or reads come back undefined — and
  // "no record" versus "a record that is empty" are two different behaviours downstream
  const guideCols = new Set(db.prepare('PRAGMA table_info(guides)').all().map((c) => c.name));
  if (!guideCols.has('gen_prose')) db.exec('ALTER TABLE guides ADD COLUMN gen_prose TEXT');
  if (!guideCols.has('status_seen_at')) db.exec('ALTER TABLE guides ADD COLUMN status_seen_at TEXT');
  // The English description. Carries a default so a migrated row reads '' rather than NULL, which
  // is what lets "we have a Chinese description but no English one" be a single test — see
  // selectSchemaTargets, which uses exactly that to decide what still needs fetching
  if (!guideCols.has('lang')) db.exec("ALTER TABLE guides ADD COLUMN lang TEXT NOT NULL DEFAULT 'zh'");
  const achCols = new Set(db.prepare('PRAGMA table_info(achievements)').all().map((c) => c.name));
  if (!achCols.has('description_en')) {
    db.exec("ALTER TABLE achievements ADD COLUMN description_en TEXT NOT NULL DEFAULT ''");
  }
  // Whether **this account** has this one. The sync already receives it — fetchAchievementStats
  // counts the array and discards it — so recording it costs no extra request, and it is what
  // lets "23 left" become "these 23, and here is the rarest of them".
  // NULL means "never observed", which is not the same as 0 ("observed, still locked")
  if (!achCols.has('unlocked')) db.exec('ALTER TABLE achievements ADD COLUMN unlocked INTEGER');
  // The share of all owners who have it, 0-100, from Steam's global percentages. The only
  // universal difficulty signal there is: a game with four left at 40% is an evening, and a game
  // with four left where one sits at 0.8% has a wall in it that no per-game hour figure can see
  if (!achCols.has('rarity')) db.exec('ALTER TABLE achievements ADD COLUMN rarity REAL');
  if (!achCols.has('rarity_checked_at')) {
    db.exec('ALTER TABLE achievements ADD COLUMN rarity_checked_at TEXT');
  }
  // When each achievement first appeared, so a patch's additions can be told from the set a game
  // shipped with. **Rows already present stay NULL**: their moment was never recorded, and stamping
  // them now would mark the whole library as newly added
  if (!achCols.has('first_seen')) db.exec('ALTER TABLE achievements ADD COLUMN first_seen TEXT');
  // Seed hltb_history with the reading the hltb table is already holding.
  //
  // **Without it the first delta is two refresh cycles away, not one.** Every row in an existing
  // database was stamped by a resolve that predates this table, so the first refresh would write
  // reading #1 with nothing to compare it against and the measurement would not start until the
  // refresh after that — sixty days rather than thirty, for a question already being asked.
  //
  // It converges on state instead of firing once, which is the same choice syncGuideStatuses is
  // written around: a row a reader pinned by hand, or one restored from a backup taken before
  // this table existed, is seeded the next time the database is opened rather than never. That is
  // only safe because the primary key makes a re-run a no-op — a reading already recorded is
  // ignored, and one written by a later refresh has a different stamp and is not touched
  db.exec(
    `INSERT OR IGNORE INTO hltb_history (appid, checked_at, comp_100, comp_100_med, comp_100_count)
     SELECT appid, checked_at, comp_100, comp_100_med, comp_100_count
       FROM hltb
      WHERE hltb_id IS NOT NULL AND checked_at IS NOT NULL`
  );
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
  // **One clock reading for every stamp in this write.** A finished game gaining achievements
  // stamps perfect_lost_date and new_ach_date in the same moment, and the bell lists it once by
  // recognising the two as one event — which needs them to be one value, not two readings that
  // usually, but not always, land in the same millisecond
  const now = nowIso();

  db.prepare(
    `UPDATE games SET achieved = ?, total = ?, has_achievements = 1, rate = ?,
       new_ach_date = COALESCE(?, new_ach_date),
       perfect_lost_date = COALESCE(?, perfect_lost_date),
       ach_added_date = COALESCE(?, ach_added_date),
       updated_at = ?
     WHERE appid = ?`
  ).run(
    achieved, total, rate,
    bumped ? now : null,
    perfectLost ? now : null,
    achAdded ? now : null,
    now, String(appid)
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

/**
 * Playtime for a row GetOwnedGames does not list, and the `last_played` derived from it.
 *
 * These rows have no `rtime_last_played` anywhere in the Web API, so "when was this played" can
 * only be answered by watching the total move: a playtime above the one recorded last run means
 * it was played between the two, and the moment of noticing is the closest timestamp that exists.
 * The Dashboard's five-day recency window then works on it unchanged, which taking
 * `playtime_2weeks` as the signal would not have allowed.
 *
 * **A row with no recorded playtime takes the baseline and no stamp.** Same rule as the two
 * notification columns, for the same reason: with no previous value there is no transition, only
 * a first observation — and stamping one would date every family row to whenever this column
 * arrived. The cost is that a game already being played is not marked recent until it is played
 * once more, which is the honest answer rather than a guessed one.
 *
 * @returns {boolean} whether the playtime moved, i.e. whether last_played was stamped
 */
export function recordUnownedPlaytime(db, appid, playtime) {
  const id = String(appid);
  const prev = db.prepare('SELECT playtime_forever FROM games WHERE appid = ?').get(id)?.playtime_forever;
  if (typeof prev === 'number' && playtime > prev) {
    db.prepare('UPDATE games SET playtime_forever = ?, last_played = ? WHERE appid = ?')
      .run(playtime, Math.floor(Date.now() / 1000), id);
    return true;
  }
  // Nothing to say when the number has not moved: this runs every sync, and rewriting an
  // unchanged value would move updated_at on every family row forever
  if (prev !== playtime) db.prepare('UPDATE games SET playtime_forever = ? WHERE appid = ?').run(playtime, id);
  return false;
}

export function setGameField(db, appid, field, value) {
  // field is interpolated straight into SQL, so this allow-list is an injection gate rather
  // than a matter of style — a new column has to register here. cover_url is on the list
  // because api.resolveCover looks it up at runtime and writes it back
  const allowed = ['name', 'name_en', 'status', 'sync_locked', 'favorite', 'priority', 'family', 'hidden', 'cover_url', 'playtime_forever', 'last_played'];
  if (!allowed.includes(field)) throw new Error(msg('db.columnNotAllowed', { field }));
  const res = db
    .prepare(`UPDATE games SET ${field} = ?, updated_at = ? WHERE appid = ?`)
    .run(value, nowIso(), String(appid));
  return res.changes > 0;
}

export function deleteGame(db, appid) {
  const id = String(appid);
  const removed = db.prepare('DELETE FROM games WHERE appid = ?').run(id).changes > 0;
  // The sets go with the game, unlike the rows other tables keep for a game added again. What says
  // they were read, games.sets_checked_at, went with the row: sets kept without it would be drawn
  // as current on a re-added game until the next sync read them again. Which achievement is in which
  // set is part of the same reading
  db.prepare('DELETE FROM achievement_sets WHERE appid = ?').run(id);
  db.prepare('DELETE FROM achievement_set_members WHERE appid = ?').run(id);
  return removed;
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

/**
 * Appids holding Chinese achievement descriptions but not a single English one — the games whose
 * detail was stored before description_en existed.
 *
 * **The test is per game, not per row.** An individual achievement can legitimately have no English
 * description while the rest of its game does, and a per-row test would put that game back in the
 * queue on every sync for as long as Steam keeps answering the same way. "Did this game come back
 * with any English description at all" makes one pass enough. See selectSchemaTargets.
 */
export function appIdsMissingEnglishDescriptions(db) {
  const rows = db
    .prepare(
      `SELECT appid FROM achievements
       GROUP BY appid
       HAVING SUM(CASE WHEN COALESCE(description, '') <> '' THEN 1 ELSE 0 END) > 0
          AND SUM(CASE WHEN COALESCE(description_en, '') <> '' THEN 1 ELSE 0 END) = 0`
    )
    .all();
  return new Set(rows.map((r) => r.appid));
}

export function replaceAchievements(db, appid, rows) {
  // **Upsert, then delete what is gone** — not delete-then-insert.
  //
  // The descriptive columns here all come from one place (the game's schema) and are safe to
  // overwrite wholesale. `unlocked` and `rarity` do not: they arrive from two other endpoints on
  // their own schedules, and this function runs whenever a description needs refreshing. Clearing
  // the row first would discard them every time, silently, and the interface would go back to
  // "23 left" with nothing to say about which 23 — with nothing failing to show why.
  //
  // An achievement the developer removed still has to disappear, so the delete stays; it is just
  // narrowed to the rows this schema no longer names.
  //
  // **first_seen is written by the INSERT and absent from the UPDATE.** It is the moment the
  // achievement first appeared, and a later refresh of its text must not move it — or every game
  // would look as if its whole set had just been added. One clock reading for the whole call, so
  // the set a game shipped with shares a single moment and anything later reads as later
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO achievements (appid, api_name, game_name, name_cn, name_en, description, description_en, hidden, icon, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(appid, api_name) DO UPDATE SET
       game_name = excluded.game_name, name_cn = excluded.name_cn, name_en = excluded.name_en,
       description = excluded.description, description_en = excluded.description_en,
       hidden = excluded.hidden, icon = excluded.icon`
  );
  const keep = new Set(rows.map((r) => r.apiName));
  // Prepared once, not once per row. A game can hold several hundred achievements, and preparing
  // inside the loop re-parses the same statement that many times per game per sync
  const del = db.prepare('DELETE FROM achievements WHERE appid = ? AND api_name = ?');
  const existing = db.prepare('SELECT api_name FROM achievements WHERE appid = ?').all(String(appid));
  db.exec('BEGIN');
  try {
    for (const row of existing) {
      if (!keep.has(row.api_name)) del.run(String(appid), row.api_name);
    }
    for (const r of rows) {
      ins.run(
        String(appid),
        r.apiName,
        r.gameName ?? '',
        r.nameCn ?? '',
        r.nameEn ?? '',
        r.description ?? '',
        r.descriptionEn ?? '',
        r.hidden ? 1 : 0,
        r.icon ?? '',
        now
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

/**
 * Record which achievements this account holds.
 *
 * `unlockedApiNames` is the complete set for the game, so anything absent is explicitly locked
 * rather than unknown — that is why every row is written, not only the unlocked ones. A row that
 * has never been observed keeps NULL, and "still locked" and "never asked" stay distinguishable.
 */
export function setAchievementUnlocks(db, appid, unlockedApiNames) {
  const on = new Set(unlockedApiNames);
  const stmt = db.prepare('UPDATE achievements SET unlocked = ? WHERE appid = ? AND api_name = ?');
  db.exec('BEGIN');
  try {
    for (const r of db.prepare('SELECT api_name FROM achievements WHERE appid = ?').all(String(appid))) {
      stmt.run(on.has(r.api_name) ? 1 : 0, String(appid), r.api_name);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the one below is what should be reported */ }
    throw err;
  }
}

/** Store global unlock percentages. `percentages` is api_name → percent (0-100) */
export function setAchievementRarity(db, appid, percentages) {
  const at = nowIso();
  const stmt = db.prepare(
    'UPDATE achievements SET rarity = ?, rarity_checked_at = ? WHERE appid = ? AND api_name = ?'
  );
  db.exec('BEGIN');
  try {
    for (const [apiName, pct] of percentages) stmt.run(pct, at, String(appid), apiName);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the one below is what should be reported */ }
    throw err;
  }
}

/**
 * What share of a game's difficulty is still ahead of this account, per game.
 *
 * **This is the number that turns hours-to-finish into hours-still-to-go.** The obvious
 * apportionment — `1 − rate` — assumes every achievement costs the same, and that is measurably
 * wrong: what is left in a part-finished game is by definition the tail nobody else got either.
 *
 * Each achievement is weighted by `−log(p)`, its unlikeliness, and the share is the weighted
 * remainder over the weighted whole. Measured across 101 of this library's finished games, that
 * weight predicts a game's completionist hours far better than its achievement count does
 * (R² 0.54 against 0.15), which is the evidence for using it as an apportionment inside one game.
 * Against the flat `1 − rate` it raised every one of 60 unfinished games, by a median of 1.2× and
 * up to 2.3× — and it raised the nearly-finished ones most, which is exactly the shape expected.
 *
 * **The logarithm's base does not matter**: the answer is a ratio of two sums of logs, so any
 * base cancels. SQLite's `log` is base 10; nothing here depends on that.
 *
 * A rarity of 0 (an achievement literally nobody holds) is clamped rather than allowed to make
 * the weight infinite, and a row missing either column contributes to neither sum — an absent
 * figure is not evidence, and counting it as easy would flatter the games least is known about.
 */
export function remainingDifficulty(db) {
  return db
    .prepare(
      `SELECT appid,
              SUM(log(100.0 / MAX(rarity, 0.01)))                     AS all_weight,
              SUM(CASE WHEN unlocked = 0
                       THEN log(100.0 / MAX(rarity, 0.01)) ELSE 0 END) AS left_weight,
              COUNT(*)                                                AS known
         FROM achievements
        WHERE rarity IS NOT NULL AND unlocked IS NOT NULL
        GROUP BY appid`
    )
    .all();
}

// ---------------------------------------------------------------------------
// achievement sets
// ---------------------------------------------------------------------------

/** One game's sets, in id order. Empty for a game Steam reports without any */
export function achievementSetsFor(db, appid) {
  return db.prepare('SELECT * FROM achievement_sets WHERE appid = ? ORDER BY set_id').all(String(appid));
}

/** Every stored set, for the Dashboard's one pass over the library */
export function allAchievementSets(db) {
  return db.prepare('SELECT * FROM achievement_sets ORDER BY appid, set_id').all();
}

/** The games that have sets stored — the only ones whose progress there is anything to refresh for */
export function appIdsWithSets(db) {
  return new Set(db.prepare('SELECT DISTINCT appid FROM achievement_sets').all().map((r) => r.appid));
}

/**
 * Which set each achievement of one game is in: internal name (`achievements.api_name`) → set id.
 * Empty for a game without sets, and for one whose reading carried no list of achievements
 */
export function achievementSetMembersFor(db, appid) {
  const rows = db.prepare('SELECT api_name, set_id FROM achievement_set_members WHERE appid = ?').all(String(appid));
  return new Map(rows.map((r) => [r.api_name, r.set_id]));
}

/**
 * Store one reading of a game's sets, replacing the last one, and stamp the game with the moment.
 *
 * **Delete, then insert, in one transaction** — the opposite of `replaceAchievements`, and for the
 * opposite reason. That table's columns arrive from several endpoints on their own schedules, so a
 * clean slate would discard the ones this call does not carry. Every column here comes from the
 * same reading, so a set the developer has removed has to disappear with the rest of the old one.
 *
 * `rows` may be empty: "this game has no sets" is an answer, and it clears whatever was stored and
 * stamps the game all the same. **The stamp is written in the same transaction as the rows**, so a
 * game can never be recorded as asked without its answer, or answered without the record.
 * `updated_at` is deliberately untouched — it means the game's numbers changed.
 *
 * `members` says which set each achievement is in (internal name → set id, or pairs of them) and
 * belongs to the same reading, so it is replaced in the same write and rolled back with it. **Written
 * only beside rows**: with no set to file them under they would be rows nothing can draw.
 *
 * @returns {boolean} false when the game is not in the table, in which case nothing was written
 */
export function replaceAchievementSets(db, appid, rows, checkedAt = nowIso(), members = new Map()) {
  const id = String(appid);
  const ins = db.prepare(
    `INSERT INTO achievement_sets
       (appid, set_id, name_en, name_cn, dlc_appid, position, total, need, archived, visible,
        achievable, done, completed, completed_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insMember = db.prepare('INSERT INTO achievement_set_members (appid, api_name, set_id) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM achievement_sets WHERE appid = ?').run(id);
    db.prepare('DELETE FROM achievement_set_members WHERE appid = ?').run(id);
    for (const r of rows) {
      ins.run(
        id, r.setId, r.nameEn ?? '', r.nameCn ?? '', r.dlcAppid ?? null, r.position ?? 0,
        r.total ?? 0, r.need ?? 0, r.archived ? 1 : 0, r.visible === false ? 0 : 1,
        r.achievable ? 1 : 0, r.done ?? 0, r.completed ? 1 : 0, r.completedAt ?? null, checkedAt
      );
    }
    if (rows.length) for (const [apiName, setId] of members) insMember.run(id, apiName, setId);
    const stamped = db.prepare('UPDATE games SET sets_checked_at = ? WHERE appid = ?').run(checkedAt, id).changes > 0;
    // A game that has left the table (deleted while the sync ran) has no row to record the reading
    // against, and sets with no game behind them are counted and never drawn
    if (!stamped) {
      db.exec('ROLLBACK');
      return false;
    }
    db.exec('COMMIT');
    return true;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the one below is what should be reported */ }
    throw err;
  }
}

/** How many games in the table have sets stored. A join, so a set left behind by a game that has gone is not counted */
export function countGamesWithSets(db) {
  return db
    .prepare('SELECT COUNT(DISTINCT s.appid) AS n FROM achievement_sets s JOIN games g ON g.appid = s.appid')
    .get().n;
}

// ---------------------------------------------------------------------------
// hltb
// ---------------------------------------------------------------------------

export function allHltb(db) {
  return db.prepare('SELECT * FROM hltb').all();
}

export function getHltb(db, appid) {
  return db.prepare('SELECT * FROM hltb WHERE appid = ?').get(String(appid));
}

/**
 * Store a resolution result, verified or not.
 *
 * A miss is written too — `hltb_id` NULL with a `checked_at` — because "we looked and there is
 * nothing" is an answer worth keeping. Without it the eight or so titles HowLongToBeat has never
 * heard of would be searched again on every sync, forever, at four queries each.
 *
 * A row the reader pinned by hand is never overwritten here. That is the whole point of pinning
 * it: the automatic search already failed, or already got it wrong.
 */
export function upsertHltb(db, appid, data = {}) {
  const existing = getHltb(db, appid);
  if (existing?.manual && !data.manual) return false;
  // One stamp for both writes, so a history row joins the `hltb` row it was taken from. Calling
  // nowIso() twice would put two timestamps a millisecond apart on one reading
  const checkedAt = nowIso();
  db.prepare(
    `INSERT INTO hltb (appid, hltb_id, verified, manual, comp_100, comp_100_med, comp_100_lo, comp_100_hi, comp_100_count, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(appid) DO UPDATE SET
       hltb_id = excluded.hltb_id, verified = excluded.verified, manual = excluded.manual,
       comp_100 = excluded.comp_100, comp_100_med = excluded.comp_100_med,
       comp_100_lo = excluded.comp_100_lo, comp_100_hi = excluded.comp_100_hi,
       comp_100_count = excluded.comp_100_count, checked_at = excluded.checked_at`
  ).run(
    String(appid),
    data.hltbId ?? null,
    data.verified ? 1 : 0,
    data.manual ? 1 : 0,
    data.comp100 ?? null,
    data.comp100Med ?? null,
    data.comp100Lo ?? null,
    data.comp100Hi ?? null,
    data.comp100Count ?? null,
    checkedAt
  );
  // **A miss records nothing.** There is no entry behind it, so there is no figure that could
  // move; a row of nulls in the history would only dilute the very counts it exists to produce
  if (data.hltbId) {
    db.prepare(
      `INSERT OR IGNORE INTO hltb_history (appid, checked_at, comp_100, comp_100_med, comp_100_count)
       VALUES (?, ?, ?, ?, ?)`
    ).run(String(appid), checkedAt, data.comp100 ?? null, data.comp100Med ?? null, data.comp100Count ?? null);
  }
  return true;
}

/** Every reading of one game, oldest first. The `hltb` row is the last of these */
export function hltbHistory(db, appid) {
  return db
    .prepare('SELECT * FROM hltb_history WHERE appid = ? ORDER BY checked_at')
    .all(String(appid));
}

/** Forget one row so the next sync searches for it again. Used when the reader clears a bad pin */
export function deleteHltb(db, appid) {
  db.prepare('DELETE FROM hltb WHERE appid = ?').run(String(appid));
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
 * Record which language a guide was written in.
 *
 * **Separate from `upsertGuide` on purpose.** That function is called by the two *discovery* paths,
 * which register a guide they found and know nothing about its language — routing this through it
 * would have every discovery pass reset the value to a default. The generator knows, and only the
 * generator, so only the generator says.
 *
 * The default is `'zh'` rather than empty: every guide written before this column existed is
 * Chinese, which is a fact about the library rather than a guess.
 */
export function setGuideLang(db, appid, lang) {
  return db.prepare('UPDATE guides SET lang = ? WHERE appid = ?')
    .run(lang === 'en' ? 'en' : 'zh', String(appid)).changes > 0;
}

/**
 * Mark this page's status as weighed against play, as of now.
 *
 * **Written when a status was actually settled, never merely because the page was looked at.** A
 * run that decided to promote and then failed to write must not stamp: the stamp is what makes the
 * next run skip, so stamping a failure loses that promotion until the game is played again. Both
 * "changed it" and "looked and nothing was needed" are settled; a failed write is not.
 */
export function setGuideStatusSeen(db, appid, when = nowIso()) {
  return db.prepare('UPDATE guides SET status_seen_at = ? WHERE appid = ?')
    .run(when, String(appid)).changes > 0;
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
