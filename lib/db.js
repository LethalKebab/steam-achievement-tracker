/**
 * SQLite 数据层(替代 Google Sheet)
 * ------------------------------------------------
 * 原来的三个标签页 → 三张表:
 *   RAW DATA     → games
 *   ACHIEVEMENTS → achievements
 *   GUIDES       → guides
 * 另外 Sync Log 标签页 → sync_log 表,Script Properties 里的杂项状态 → meta 表。
 *
 * 和 Sheet 版本的两个有意区别:
 * 1. 成就总数不再用字符串 'N/A' 混在数字列里,改成 has_achievements(1/0/NULL)+ total(NULL)
 * 2. 'Manual' 拆成两件事:status(展示/分类)和 sync_locked(是否跳过自动同步)。
 *    导入/新建时 Manual 一律 sync_locked=1,行为和原版完全一致;想要"锁定 Unvetted 判定
 *    但保留每日同步"的话,现在可以单独把 sync_locked 关掉(原版做不到,见 CLAUDE.md)
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  appid            TEXT PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT '',
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
  updated_at       TEXT
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
  updated TEXT
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

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------

export const nowIso = () => new Date().toISOString();

/** yyyy-MM-dd,按**本地**时区(对应原版的 Session.getScriptTimeZone(),不是 UTC) */
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

/** 新增一行游戏。已存在则什么都不做(不覆盖已有的人工标记),返回是否真的插入了 */
export function insertGame(db, { appid, name = '', status = '', syncLocked = 0, family = 0 }) {
  const res = db
    .prepare(
      `INSERT INTO games (appid, name, status, sync_locked, family, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(appid) DO NOTHING`
    )
    .run(String(appid), name, status, syncLocked ? 1 : 0, family ? 1 : 0, nowIso());
  return res.changes > 0;
}

/** 写入一次成就统计结果(achieved/total/rate),顺带处理"成就总数变多了"的日期标记 */
export function updateGameStats(db, appid, { achieved, total }) {
  const prev = getGame(db, appid);
  const rate = total > 0 ? achieved / total : 0;
  // 成就总数比上次记录的多 → 游戏更新加了新成就,记一下日期(Dashboard 用来提醒)
  const bumped = typeof prev?.total === 'number' && total > prev.total;
  db.prepare(
    `UPDATE games SET achieved = ?, total = ?, has_achievements = 1, rate = ?,
       new_ach_date = COALESCE(?, new_ach_date), updated_at = ?
     WHERE appid = ?`
  ).run(achieved, total, rate, bumped ? nowIso() : null, nowIso(), String(appid));
  return { rate, bumped };
}

/** Steam 明确说这游戏对这账号没有 stats(原版写 'N/A' 那种情况) */
export function markNoAchievements(db, appid) {
  db.prepare(
    `UPDATE games SET has_achievements = 0, total = NULL, achieved = NULL, rate = NULL, updated_at = ?
     WHERE appid = ?`
  ).run(nowIso(), String(appid));
}

export function setGameField(db, appid, field, value) {
  const allowed = ['name', 'status', 'sync_locked', 'favorite', 'priority', 'family'];
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
    db.exec('ROLLBACK');
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

export function getGuide(db, appid) {
  return db.prepare('SELECT * FROM guides WHERE appid = ?').get(String(appid));
}

export function deleteGuide(db, appid) {
  return db.prepare('DELETE FROM guides WHERE appid = ?').run(String(appid)).changes > 0;
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
    db.exec('ROLLBACK');
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
