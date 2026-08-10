/**
 * CSV 导入 / 导出
 * ------------------------------------------------
 * 导入:从表格软件(Google Sheets / Excel 等)导出的 CSV 把数据搬进来。
 * 喜爱(♥)、重点关注(★)、家庭共享标记、Manual 行和手工填的成就数,
 * 这些都不是 Steam API 能查出来的,只能靠导入带过来。
 *   每个工作表导出成 CSV(文件名含 RAW DATA / ACHIEVEMENTS / GUIDES),放同一个目录
 *   然后 node tracker.js import <那个目录>
 *
 * 导出:把三张表写回 CSV,想用表格软件排序/筛选/画图的时候用
 * (本地化之后少掉的"顺手在 Sheet 里翻数据"那点便利,靠这个补上)。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allGames, allGuides, insertGame, setGameField, updateGameStats, markNoAchievements, replaceAchievements, upsertGuide, achievementsFor } from './db.js';

// ---------------------------------------------------------------------------
// 解析 / 序列化
// ---------------------------------------------------------------------------

/** 标准 CSV 解析:处理引号包裹、字段内逗号/换行、"" 转义 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 单元格取值:适配 Sheet 导出的各种写法
// ---------------------------------------------------------------------------

const truthy = (v) => /^(true|1|yes|是|✓)$/i.test(String(v ?? '').trim());

/**
 * 千位分隔符要先去掉:Sheet 导出的 CSV 用的是**显示值**,所以一个有 1000 个成就的游戏
 * 导出来是 "1,000",直接 Number() 会变 NaN、整行成就数丢掉。(真实数据里踩到过。)
 */
const stripSeparators = (v) => String(v ?? '').trim().replace(/,/g, '');

/** "45.00%" / "0.45" / "" → 0.45 / null */
function parseRate(v) {
  const s = stripSeparators(v);
  if (!s) return null;
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(v) {
  const s = stripSeparators(v);
  if (!s || s.toUpperCase() === 'N/A') return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

function parseDateOrNull(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/**
 * 从文件名里认出这是哪个工作表导出的 CSV。
 *
 * 表格软件导出的文件名通常是 "<表格名> - <工作表名>.csv",**表格名本身可能含关键词**——
 * 比如表格叫 "Steam Achievement Tracker",那 "Steam Achievement Tracker - RAW DATA.csv"
 * 里也有 "achievement",光看整个文件名会把 RAW DATA 认成 ACHIEVEMENTS,
 * 导入之后整张表都是垃圾数据。所以有 " - " 的时候只看最后那一段(工作表名)。
 */
export function tabName(file) {
  const base = file.replace(/\.csv$/i, '');
  const parts = base.split(/\s+-\s+/);
  return (parts.length > 1 ? parts.at(-1) : base).toLowerCase().replace(/[\s_-]/g, '');
}

function findFile(dir, ...keywords) {
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
  // 关键词按给定顺序优先:先找最具体的(rawdata),再退到宽松的(raw)
  for (const k of keywords) {
    const hit = files.find((f) => tabName(f).includes(k));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * RAW DATA.csv → games 表。列顺序按原表:
 * A=Status B=AppID C=游戏名 D=完成数 E=成就总数 F=完成率 G=喜爱 H=重点关注 I=成就更新日期 J=家庭共享
 * 按列位置读(不按表头文字),因为表头是中文、而且可能被改过。
 */
export function importGames(db, csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).slice(1); // 跳过表头行
  let imported = 0;
  const skipped = [];

  for (const r of rows) {
    const appid = String(r[1] ?? '').trim();
    if (!/^\d+$/.test(appid)) {
      skipped.push(r[2] || r[1] || '(空行)');
      continue;
    }
    const status = String(r[0] ?? '').trim();
    const totalRaw = String(r[4] ?? '').trim();
    const achieved = parseIntOrNull(r[3]);
    const total = parseIntOrNull(r[4]);

    insertGame(db, { appid, name: String(r[2] ?? '').trim(), status });

    // CSV 是这几列的权威来源,已存在的行也要覆盖写(insertGame 遇到已存在的 appid 不动),
    // 这样重复导入(比如在 Sheet 里改完再导一次)是幂等的,不会有的列更新有的列不更新
    setGameField(db, appid, 'status', status);
    // Manual 意味着这行的成就数是手动维护的,自动同步必须跳过它,否则人工数据会被冲掉
    setGameField(db, appid, 'sync_locked', status === 'Manual' ? 1 : 0);
    setGameField(db, appid, 'family', truthy(r[9]) ? 1 : 0);
    setGameField(db, appid, 'favorite', truthy(r[6]) ? 1 : 0);
    setGameField(db, appid, 'priority', truthy(r[7]) ? 1 : 0);
    if (String(r[2] ?? '').trim()) setGameField(db, appid, 'name', String(r[2]).trim());

    if (totalRaw.toUpperCase() === 'N/A') {
      markNoAchievements(db, appid);
    } else if (achieved !== null && total !== null) {
      updateGameStats(db, appid, { achieved, total });
    }

    const newAchDate = parseDateOrNull(r[8]);
    if (newAchDate) {
      db.prepare('UPDATE games SET new_ach_date = ? WHERE appid = ?').run(newAchDate, appid);
    }
    imported++;
  }
  return { imported, skipped };
}

/** ACHIEVEMENTS.csv → achievements 表 */
export function importAchievements(db, csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).slice(1);
  const byApp = new Map();
  for (const r of rows) {
    const appid = String(r[0] ?? '').trim();
    const apiName = String(r[2] ?? '').trim();
    if (!appid || !apiName) continue;
    if (!byApp.has(appid)) byApp.set(appid, []);
    byApp.get(appid).push({
      apiName,
      gameName: r[1] ?? '',
      nameCn: r[3] ?? '',
      nameEn: r[4] ?? '',
      description: r[5] ?? '',
      hidden: truthy(r[6]),
      icon: r[7] ?? '',
    });
  }
  for (const [appid, list] of byApp) replaceAchievements(db, appid, list);
  return { games: byApp.size, rows: rows.length };
}

/**
 * GUIDES.csv → guides 表。
 * 只有 4 列(AppID/游戏名/攻略链接/更新日期)的时候,链接一律当成 Notion 页面;
 * 本工具自己 export 出来的多一列"类型",第 4 列是 notion/local 时按它走——
 * 这样 export → import 是无损的,本地 markdown 攻略不会被当成 Notion 链接。
 */
export function importGuides(db, csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).slice(1);
  let imported = 0;
  for (const r of rows) {
    const appid = String(r[0] ?? '').trim();
    const url = String(r[2] ?? '').trim();
    if (!appid || !url) continue;
    const declared = String(r[3] ?? '').trim();
    const kind = declared === 'local' || declared === 'notion' ? declared : 'notion';
    upsertGuide(db, { appid, name: r[1] ?? '', url, kind });
    imported++;
  }
  return { imported };
}

export function importAll(db, dir) {
  const result = {};
  const raw = findFile(dir, 'rawdata', 'raw');
  const ach = findFile(dir, 'achievement');
  const guides = findFile(dir, 'guide');

  if (raw) result.games = { file: raw, ...importGames(db, join(dir, raw)) };
  if (ach) result.achievements = { file: ach, ...importAchievements(db, join(dir, ach)) };
  if (guides) result.guides = { file: guides, ...importGuides(db, join(dir, guides)) };
  if (!raw && !ach && !guides) {
    throw new Error(
      `${dir} 里没找到可识别的 CSV。文件名里需要含 "RAW DATA" / "ACHIEVEMENTS" / "GUIDES" 之一` +
        '(表格软件导出的默认文件名就是这个形式)'
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 三张表的表头。导出和"下载空模板"共用这一份定义,不能各写各的——
 * 导入是**按列的位置**读的(见 importGames),模板的列序一旦和导出对不上,
 * 用模板填出来的表格导进来就会整体错位,而且不会报错,只会写进错误的字段。
 */
export const CSV_HEADERS = {
  'RAW DATA': ['Status', 'AppID', '游戏名', '完成数', '成就总数', '完成率', '喜爱', '重点关注', '成就更新日期', '家庭共享(非自购)'],
  ACHIEVEMENTS: ['AppID', '游戏名', '成就APIName', '成就名称(中文)', '成就名称(英文,搜攻略用)', '成就描述', '是否隐藏成就', '图标URL'],
  GUIDES: ['AppID', '游戏名', '攻略链接', '类型', '更新日期'],
};

/** 只有表头的 CSV,给设置页的"下载模板"用 */
export function templateCsv(kind) {
  const header = CSV_HEADERS[kind];
  if (!header) return null;
  return toCsv([header]);
}

export function exportAll(db, dir) {
  const games = allGames(db);
  const gameRows = [
    CSV_HEADERS['RAW DATA'],
    ...games.map((g) => [
      g.status,
      g.appid,
      g.name,
      g.achieved ?? '',
      g.has_achievements === 0 ? 'N/A' : g.total ?? '',
      g.rate === null || g.rate === undefined ? '' : (g.rate * 100).toFixed(2) + '%',
      g.favorite ? 'TRUE' : 'FALSE',
      g.priority ? 'TRUE' : 'FALSE',
      g.new_ach_date ? g.new_ach_date.slice(0, 10) : '',
      g.family ? 'TRUE' : 'FALSE',
    ]),
  ];

  const achRows = [CSV_HEADERS.ACHIEVEMENTS];
  for (const g of games) {
    for (const a of achievementsFor(db, g.appid)) {
      achRows.push([a.appid, a.game_name, a.api_name, a.name_cn, a.name_en, a.description, a.hidden ? 'TRUE' : 'FALSE', a.icon]);
    }
  }

  const guideRows = [
    CSV_HEADERS.GUIDES,
    ...allGuides(db).map((g) => [g.appid, g.name, g.url, g.kind, g.updated]),
  ];

  const files = [
    ['RAW DATA.csv', gameRows],
    ['ACHIEVEMENTS.csv', achRows],
    ['GUIDES.csv', guideRows],
  ];
  for (const [name, rows] of files) writeFileSync(join(dir, name), toCsv(rows));
  return files.map(([name, rows]) => ({ file: name, rows: rows.length - 1 }));
}
