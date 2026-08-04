/**
 * 同步引擎:一次跑完整个库,分三个阶段
 * ------------------------------------------------
 * 没有游标、没有分批、没有单次运行时长上限——整个库一趟过完。库大的话就是慢一点,
 * 但不需要维护"上次跑到哪了"这种状态,也就没有"中途排序导致游标错位"这类问题。
 * 中途 Ctrl+C 也没关系:每款游戏是独立写库的,重跑一遍就是了。
 */
import {
  allGames, getGame, insertGame, setGameField, updateGameStats, markNoAchievements,
  appIdsWithAchievements, replaceAchievements, setMeta, nowIso,
} from './db.js';
import { sleep } from './steam.js';

const DAY_MS = 86400000;

/**
 * 第一阶段:把 Steam 库和本地表对齐。
 * - 库里有、本地没有的 → 新增(顺带反查一次最好的中文名)
 * - 本地有、且是 owned 的 → 刷新 Unvetted 标记('Manual' 的行不动)
 * - 本地有、但不在 owned 列表里的行(家庭共享/已下架/手动加的)→ 完全不动。
 *   判断依据是"在不在 owned 列表里",跟 status 是什么无关
 */
export async function syncLibrary(db, steam, { onProgress = () => {} } = {}) {
  const { games, unvettedAppIds } = await steam.fetchOwnedGamesWithUnvettedFlag();
  const existing = new Set(allGames(db).map((g) => g.appid));

  const added = [];
  let restamped = 0;

  for (const g of games) {
    const appid = String(g.appid);
    const isUnvetted = unvettedAppIds.has(appid);

    if (!existing.has(appid)) {
      onProgress({ phase: 'library', name: g.name, added: added.length + 1 });
      const best = (await steam.fetchAppName(appid)) || g.name;
      insertGame(db, { appid, name: best, status: isUnvetted ? 'Unvetted' : '' });
      added.push({ appid, name: best });
      await sleep(steam.delay);
      continue;
    }

    // owned 的行:让 Unvetted 标记跟着 Steam 的最新判定走,但不碰人工锁定的 Manual
    const row = getGame(db, appid);
    const want = isUnvetted ? 'Unvetted' : '';
    if (row.status !== 'Manual' && row.status !== want) {
      setGameField(db, appid, 'status', want);
      restamped++;
    }
  }

  return { ownedCount: games.length, unvettedCount: unvettedAppIds.size, added, restamped };
}

/**
 * 第二阶段:刷新每款游戏的成就完成数(原 runBatch,去掉游标)。
 * sync_locked 的行跳过(手动维护成就数的那些,自动同步会把人工数据冲掉)。
 */
export async function syncAchievementStats(db, steam, { onProgress = () => {} } = {}) {
  const targets = allGames(db).filter((g) => !g.sync_locked);
  let updated = 0;
  let noSystem = 0;
  let retried = 0;
  const bumped = [];

  for (const [i, g] of targets.entries()) {
    onProgress({ phase: 'achievements', done: i + 1, total: targets.length, name: g.name });

    if (!g.name) {
      const official = await steam.fetchAppName(g.appid);
      if (official) setGameField(db, g.appid, 'name', official);
      await sleep(steam.delay);
    }

    const res = await steam.fetchAchievementStats(g.appid);
    if (res.noAchievementSystem) {
      markNoAchievements(db, g.appid);
      noSystem++;
    } else if (res.retry) {
      retried++; // 留着下次再试,不写任何东西
    } else {
      const { bumped: didBump } = updateGameStats(db, g.appid, res);
      if (didBump) bumped.push(g.name || g.appid);
      updated++;
    }
    await sleep(steam.delay);
  }

  return { updated, noSystem, retried, bumped };
}

/**
 * 第三阶段:成就详情(中英文名/描述/图标)→ achievements 表。原 syncAchievementSchema。
 * 刷新条件:这个 appid 还没有任何记录,或者最近 7 天内成就总数变多过(说明游戏更新加了成就)。
 * 跳过条件也一致:确认没有成就系统的、以及完成率刚好 100% 的(已经全成就,不需要 checklist)。
 */
export async function syncAchievementSchema(db, steam, { onProgress = () => {} } = {}) {
  const known = appIdsWithAchievements(db);
  const targets = allGames(db).filter((g) => {
    if (g.has_achievements === 0) return false;
    if (g.rate === 1) return false;
    const recentlyUpdated =
      g.new_ach_date && Date.now() - new Date(g.new_ach_date).getTime() < 7 * DAY_MS;
    return recentlyUpdated || !known.has(g.appid);
  });

  let processed = 0;
  let skippedNoSchema = 0;

  for (const [i, g] of targets.entries()) {
    onProgress({ phase: 'schema', done: i + 1, total: targets.length, name: g.name });

    const cn = await steam.fetchAchievementSchema(g.appid, 'schinese');
    if (!cn?.length) {
      skippedNoSchema++;
      await sleep(steam.delay);
      continue;
    }
    await sleep(steam.delay);
    const en = (await steam.fetchAchievementSchema(g.appid, 'english')) ?? [];
    const enByApiName = Object.fromEntries(en.map((a) => [a.name, a]));

    replaceAchievements(
      db,
      g.appid,
      cn.map((a) => {
        const hidden = a.hidden === 1;
        return {
          apiName: a.name,
          gameName: g.name,
          nameCn: a.displayName || a.name,
          nameEn: enByApiName[a.name]?.displayName || enByApiName[a.name]?.name || '',
          description: hidden ? '' : a.description || '',
          hidden,
          icon: hidden ? a.icongray || a.icon || '' : a.icon || '',
        };
      })
    );
    processed++;
    await sleep(steam.delay);
  }

  return { processed, skippedNoSchema, candidates: targets.length };
}

/** 全量同步:三个阶段依次跑完,记下完成时间(serve 靠它判断数据新鲜度) */
export async function fullSync(db, steam, { onProgress = () => {} } = {}) {
  const library = await syncLibrary(db, steam, { onProgress });
  const stats = await syncAchievementStats(db, steam, { onProgress });
  const schema = await syncAchievementSchema(db, steam, { onProgress });
  setMeta(db, 'last_sync', nowIso());
  return { library, stats, schema };
}

/**
 * AGCR(Average Game Completion Rate),按 Steam 社区文档记录的算法:
 * 只算"至少解锁过 1 个成就"的游戏,每款权重相同取算术平均,Unvetted 的排除在外。
 * https://steamcommunity.com/sharedfiles/filedetails/?id=650166273
 */
export function computeAgcrStats(db) {
  let sum = 0;
  let eligibleCount = 0;
  let perfectCount = 0;

  for (const g of allGames(db)) {
    if (g.status === 'Unvetted') continue;
    if (typeof g.total !== 'number' || g.total <= 0) continue;
    if (!g.achieved || g.achieved <= 0) continue;
    sum += g.achieved / g.total;
    eligibleCount++;
    if (g.achieved === g.total) perfectCount++;
  }

  return { eligibleCount, avg: eligibleCount > 0 ? sum / eligibleCount : 0, perfectCount };
}
