/**
 * CSV export
 * ------------------------------------------------
 * Writes three tables out as CSV, for sorting, filtering or charting in a spreadsheet.
 *
 * **This is not a backup; don't use it as one.** Export is one-way now — there used to
 * be a whole import path sharing the column definitions with it, and back then
 * "export → edit → import back" held. With the import gone, **nothing can read back**
 * what this file writes, and it only ever held three tables anyway: the keys in
 * config.json, the local guide prose under guides/, and sync_log are all absent.
 * For anything that has to be restorable, use the backup (see docs/data.md), which
 * moves data/steam.db itself.
 *
 * Why the import was deleted outright: it was written for a **one-off migration** (the
 * author's own Google Sheet → this tool), and that migration finished long ago. What it
 * left behind was a path nobody walked plus three blank templates — and a blank template
 * asks a new user to hand-type hundreds of CSV rows by column position, which is not
 * going to happen. The right answer for a new machine or a reinstall is to move the
 * database, not a format. The old implementation is in git: `git log -- lib/csv.js`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allGames, allGuides, achievementsFor } from './db.js';

export function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

/** Headers for the three tables. The column order is the order exportAll writes rows below — change one and you must change the other. */
export const CSV_HEADERS = {
  // 已隐藏 is appended rather than filed beside 喜爱 — the order here is a compatibility surface,
  // and a column inserted in the middle silently shifts every one after it for anything reading
  // the export by position
  'RAW DATA': ['Status', 'AppID', '游戏名', '完成数', '成就总数', '完成率', '喜爱', '重点关注', '成就更新日期', '家庭共享(非自购)', '已隐藏'],
  ACHIEVEMENTS: ['AppID', '游戏名', '成就APIName', '成就名称(中文)', '成就名称(英文,搜攻略用)', '成就描述', '是否隐藏成就', '图标URL'],
  GUIDES: ['AppID', '游戏名', '攻略链接', '类型', '更新日期'],
};

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
      g.hidden ? 'TRUE' : 'FALSE',
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
