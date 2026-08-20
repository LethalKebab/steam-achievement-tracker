/**
 * CSV 导出
 * ------------------------------------------------
 * 把三张表写成 CSV,给想用表格软件排序/筛选/画图的时候用。
 *
 * **这不是备份,别当备份用。** 导出是单向的 —— 2026-08-19 之前这里还有一整套
 * 导入,和导出共用列定义,那时候「导出 → 改 → 导回来」是成立的。导入删掉之后
 * 这个文件写出去的东西**没有任何路径能读回来**,而且它本来也只装得下三张表:
 * config.json 里的密钥、guides/ 下的本地攻略正文、sync_log 全都不在里面。
 * 要能还原的东西请走备份(见 docs/data.md),那边搬的是 data/steam.db 本身。
 *
 * 导入为什么整个删掉:它是为**一次性迁移**写的(作者自己的 Google Sheet → 这个
 * 工具),那次迁移早就做完了。留下来的是一条没人走的路加三个空模板 —— 而空模板
 * 要求一个新用户按位置手打几百行 CSV,这件事不会发生。换机/重装的正解是搬数据库,
 * 不是搬一种格式。历史实现在 git 里:`git log -- lib/csv.js`。
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

/** 三张表的表头。列序就是下面 exportAll 写行的顺序,改一个必须改另一个。 */
export const CSV_HEADERS = {
  'RAW DATA': ['Status', 'AppID', '游戏名', '完成数', '成就总数', '完成率', '喜爱', '重点关注', '成就更新日期', '家庭共享(非自购)'],
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
