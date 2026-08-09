/**
 * SQLite 数据层
 * ------------------------------------------------
 *   games        —— 一行一个 appid:名字、完成数/总数、完成率、状态、♥/★/家庭标记
 *   achievements —— 逐条成就详情(中英文名、是否隐藏、图标)
 *   guides       —— appid → 攻略位置(Notion 链接或本地 md 文件名)
 *   sync_log     —— checkbox 同步的逐条结果,事后复查用
 *   meta         —— 杂项状态(比如上次同步时间)
 *
 * 两个容易踩的设计点:
 * 1. "这游戏没有成就系统"是 has_achievements=0 + total=NULL,既不是往数字列里塞字符串,
 *    也不是 total=0——字符串混进数字列会让所有统计都要先做类型判断
 * 2. status(分类:''/Unvetted/Manual)和 sync_locked(是否跳过自动同步)是**两列**。
 *    平时一起变,但可以只锁分类、保留每日同步——这两件事本来就是两回事
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
  updated_at       TEXT,
  last_played      INTEGER,
  stats_checked_at TEXT
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

/**
 * 后加的列。SCHEMA 是 CREATE TABLE IF NOT EXISTS,对**已经存在**的表完全没作用,
 * 所以新列必须再走一遍 ALTER TABLE —— 两条路都要留:建库走 SCHEMA,老库走这里。
 * 加新列往这个表里追加一行就行,ADD COLUMN 不会锁表也不会重写数据。
 */
const ADDED_COLUMNS = [
  ['last_played', 'INTEGER'],
  ['stats_checked_at', 'TEXT'],
];

function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${type}`);
  }
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

/** yyyy-MM-dd,按**本地**时区(不是 UTC——晚上跑的时候 UTC 会差一天) */
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
  // 解锁数比上次多 → 这一行可能有攻略 checkbox 该勾了。只用来挑 serve 那次自动
  // checkbox 同步的候选(见 server.js 的 runCheckboxSync),不写进任何列。
  // 没有基线(prev.achieved 是 NULL,第一次同步这一行)时算 false:那种情况下
  // "变多了"没有意义,整库几百行会全部变成候选,把定向同步退化成全量。
  const gained = typeof prev?.achieved === 'number' && achieved > prev.achieved;
  db.prepare(
    `UPDATE games SET achieved = ?, total = ?, has_achievements = 1, rate = ?,
       new_ach_date = COALESCE(?, new_ach_date), updated_at = ?
     WHERE appid = ?`
  ).run(achieved, total, rate, bumped ? nowIso() : null, nowIso(), String(appid));
  return { rate, bumped, gained };
}

/** Steam 明确说这游戏对这账号没有 stats:标记成没有成就系统,不是 0 */
export function markNoAchievements(db, appid) {
  db.prepare(
    `UPDATE games SET has_achievements = 0, total = NULL, achieved = NULL, rate = NULL, updated_at = ?
     WHERE appid = ?`
  ).run(nowIso(), String(appid));
}

/**
 * 记一笔"这一行刚跟 Steam 对过账"。同步的取样逻辑全靠这两列:
 * - stats_checked_at:轮换扫描按它排序(最旧的先扫)
 * - last_played:对账那一刻的 rtime_last_played,下次拿新值跟它比,决定要不要再查
 *
 * 只在**真的读到结果**之后调用(成功 / 确认无成就系统),429 之类的重试**不能**调——
 * 否则那一行会被当成"刚查过",下次直接跳过。
 * 拿不到 rtime 的行(不在 owned 列表里)传 null,COALESCE 保住原值不被抹掉。
 * 故意不动 updated_at:那一列的意思是"数据变了",查完发现没变不算变。
 */
export function markStatsChecked(db, appid, lastPlayed = null) {
  db.prepare(
    `UPDATE games SET stats_checked_at = ?, last_played = COALESCE(?, last_played) WHERE appid = ?`
  ).run(nowIso(), lastPlayed, String(appid));
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
