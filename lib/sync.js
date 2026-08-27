/**
 * 同步引擎:一次跑完整个库,分三个阶段
 * ------------------------------------------------
 * 没有游标、没有分批、没有单次运行时长上限——整个库一趟过完。库大的话就是慢一点,
 * 但不需要维护"上次跑到哪了"这种状态,也就没有"中途排序导致游标错位"这类问题。
 * 中途 Ctrl+C 也没关系:每款游戏是独立写库的,重跑一遍就是了。
 */
import {
  allGames, getGame, insertGame, setGameField, updateGameStats, markNoAchievements,
  markStatsChecked, appIdsWithAchievements, replaceAchievements, setMeta, nowIso,
} from './db.js';
import { sleep } from './steam.js';

const DAY_MS = 86400000;

/** 取样默认值。serve 会用 config 里的值覆盖;不传就是"全查",见 selectStatsTargets */
const SELECTION_DEFAULTS = {
  sweepBudget: 120,
  maxStatsAgeDays: 7,
  perfectGameMaxAgeDays: 3,
};

/**
 * 第一阶段:把 Steam 库和本地表对齐。
 * - 库里有、本地没有的 → 新增(顺带反查一次最好的中文名)
 * - 本地有、且是 owned 的 → 刷新 Unvetted 标记('Manual' 的行不动)
 * - 本地有、但不在 owned 列表里的行(家庭共享/已下架/手动加的)→ 完全不动。
 *   判断依据是"在不在 owned 列表里",跟 status 是什么无关
 */
export async function syncLibrary(db, steam, { onProgress = () => {} } = {}) {
  const { games, unvettedAppIds, playSnapshot } = await steam.fetchOwnedGamesWithUnvettedFlag();
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
      await sleep(steam.storeDelay); // fetchAppName 走的是商店接口,不是 Web API
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

  return { ownedCount: games.length, unvettedCount: unvettedAppIds.size, added, restamped, playSnapshot };
}

/**
 * 第二阶段查哪些行。**achieved 和 total 变化的原因不一样**,这是整个取样的出发点:
 * - achieved 是"你"的事实,不玩就不可能变 → 可以用 rtime_last_played 挡掉
 * - total   是"游戏"的事实,开发者打个补丁就能变,跟你玩没玩一点关系 → 挡不得
 *
 * 所以取三组的并集:
 * 1. played —— rtime_last_played 比上次对账时新。这一组保证 achieved 永远准
 * 2. unowned —— 不在 owned 列表里的行(家庭共享/已下架/手动加的),压根拿不到 rtime,
 *    每次都查。CLAUDE.md 记着:游戏能从 GetOwnedGames 消失但成就数据还在,不能冻掉。
 *    **但已经 100% 的 unowned 行走 sweep,不在这一组** —— 见 isPerfect 那里的理由
 * 3. sweep —— 按 stats_checked_at 最旧的轮着查,补的就是 total 被开发者改掉的情况。
 *    每次跑有预算上限,剩下的下次接着扫;久没开也不会突然跑一次两分钟的全量
 *
 * 完美游戏(rate=1)用更短的过期时间:成就总数变多会让它掉出 100%,而这正是最想
 * 第一时间知道的一类。它们还是双重盲区——syncAchievementSchema 故意跳过 rate=1,
 * 所以这些游戏连成就明细都没有,只能靠这里的定期复查发现变化。
 *
 * 没有 playSnapshot(单独跑 syncAchievementStats、或者 CLI 的全量 sync)→ 全查,
 * 保留一个"肯定什么都不漏"的入口。
 */
export function selectStatsTargets(db, playSnapshot, selection = {}) {
  const cfg = { ...SELECTION_DEFAULTS, ...selection };
  const rows = allGames(db).filter((g) => !g.sync_locked);
  if (!playSnapshot) {
    return { targets: rows, played: rows.length, unowned: 0, swept: 0, sweepPending: 0, gated: false };
  }

  const now = Date.now();
  const ageDays = (iso) => (iso ? (now - new Date(iso).getTime()) / DAY_MS : Infinity);
  const maxAge = (g) => (g.rate === 1 ? cfg.perfectGameMaxAgeDays : cfg.maxStatsAgeDays);

  // **两个条件都要满足才算 100%,不是只看 rate。** 这是个 *跳过* 判断,两个方向的
  // 代价不对称:rate 万一是旧的而实际没满,只看 rate 就会把一个还在动的 achieved
  // 冻上三天(selection.test.js 存在的理由正是「跳过一行等于静默冻结一个数字」);
  // 反过来两者不一致时留在 unowned 里,只是少省几个请求。所以取更严的那一侧。
  const isPerfect = (g) => g.rate === 1 && typeof g.total === 'number' && g.total > 0 && g.achieved === g.total;

  const played = [];
  const unowned = [];
  const sweepPool = [];

  for (const g of rows) {
    if (!playSnapshot.has(g.appid)) {
      // 100% 的 unowned 行不必每次都查。**rtime 那道闸门是为了保护 achieved 的准确性,
      // 而 achieved 到顶之后只可能不变** —— 玩得再多也涨不上去了。剩下唯一还能变的是
      // total(开发者加成就),那正是 sweep 的职责,而 perfectGameMaxAgeDays(3 天)
      // 本来就是为「成就变多会让它掉出 100%」这一类调的。
      // 同一个游戏 owned 时早就走这条路了(它落进下面的 sweepPool),unowned 却每次都查,
      // 差别只来自「有没有 rtime」—— 而对满成就的行 rtime 恰恰是不需要的那个东西。
      // stats_checked_at 为 null 时 ageDays 是 Infinity,照样进池且排最前,不会漏。
      if (isPerfect(g)) {
        if (ageDays(g.stats_checked_at) >= maxAge(g)) sweepPool.push(g);
        continue;
      }
      unowned.push(g);
      continue;
    }
    // 还没建立基线的行必须查:没有 last_played 就没有可比的东西,跳过等于瞎猜。
    // 升级后第一次跑因此是一次全量(之后才快),这是有意的——基线得先有。
    const rtime = playSnapshot.get(g.appid);
    if (g.stats_checked_at == null || g.last_played == null || rtime > g.last_played) {
      played.push(g);
      continue;
    }
    if (ageDays(g.stats_checked_at) >= maxAge(g)) sweepPool.push(g);
  }

  // 按"超期倍数"排,不是按绝对时间排。两者在这里不等价:完美游戏 3 天到期、
  // 普通游戏 7 天到期,单纯比谁更旧的话,8 天的普通游戏会插到 4 天的完美游戏前面,
  // 那条更短的期限就白设了。除以各自的期限之后,4/3 才排在 8/7 前面。
  const overdue = (g) => ageDays(g.stats_checked_at) / maxAge(g);
  sweepPool.sort((a, b) => overdue(b) - overdue(a));
  const swept = cfg.sweepBudget > 0 ? sweepPool.slice(0, cfg.sweepBudget) : [];

  return {
    targets: [...played, ...unowned, ...swept],
    played: played.length,
    unowned: unowned.length,
    swept: swept.length,
    sweepPending: sweepPool.length - swept.length,
    gated: true,
  };
}

/**
 * 第二阶段:刷新每款游戏的成就完成数(原 runBatch,去掉游标)。
 * sync_locked 的行跳过(手动维护成就数的那些,自动同步会把人工数据冲掉)。
 * 查哪些行由 selectStatsTargets 决定,规则见那边的注释。
 */
export async function syncAchievementStats(
  db,
  steam,
  { onProgress = () => {}, playSnapshot = null, selection = {} } = {}
) {
  const picked = selectStatsTargets(db, playSnapshot, selection);
  const targets = picked.targets;
  let updated = 0;
  let noSystem = 0;
  let retried = 0;
  const bumped = [];
  // 这一轮 achieved 或 total 真的变了的 appid。serve 那次自动 checkbox 同步只查这些行,
  // 不是整个候选集——一次全量要 40 多个 Notion 页面读 + 40 多次 Steam 调用,
  // 而绝大多数打开 Dashboard 的时候一个框都不会变。
  const changedAppids = [];

  for (const [i, g] of targets.entries()) {
    onProgress({ phase: 'achievements', done: i + 1, total: targets.length, name: g.name });

    if (!g.name) {
      const official = await steam.fetchAppName(g.appid);
      if (official) setGameField(db, g.appid, 'name', official);
      await sleep(steam.storeDelay); // 同上:商店接口
    }

    // 拿不到 rtime 的行(不在 owned 里)传 null,markStatsChecked 会保住原值
    const rtime = playSnapshot?.get(g.appid) ?? null;

    const res = await steam.fetchAchievementStats(g.appid);
    if (res.noAchievementSystem) {
      markNoAchievements(db, g.appid);
      markStatsChecked(db, g.appid, rtime);
      noSystem++;
    } else if (res.retry) {
      retried++; // 留着下次再试,不写任何东西——**包括不记 stats_checked_at**,
                 // 记了的话这一行会被当成刚查过,下一轮直接跳过,限流就变成了静默丢数据
    } else {
      const { bumped: didBump, gained } = updateGameStats(db, g.appid, res);
      if (didBump) bumped.push(g.name || g.appid);
      // total 变多也算:补丁加的新成就往往攻略里已经写好了框,只是还没勾
      if (didBump || gained) changedAppids.push(g.appid);
      markStatsChecked(db, g.appid, rtime);
      updated++;
    }
    await sleep(steam.delay);
  }

  return {
    updated, noSystem, retried, bumped, changedAppids,
    selection: {
      total: targets.length,
      played: picked.played,
      unowned: picked.unowned,
      swept: picked.swept,
      sweepPending: picked.sweepPending,
      gated: picked.gated,
    },
  };
}

/**
 * 第三阶段:成就详情(中英文名/描述/图标)→ achievements 表。原 syncAchievementSchema。
 * 刷新条件:这个 appid 还没有任何记录,或者最近 7 天内成就总数变多过(说明游戏更新加了成就)。
 * 跳过条件也一致:确认没有成就系统的、以及完成率刚好 100% 的(已经全成就,不需要 checklist)。
 */
/**
 * 取一款游戏的成就详情写进 achievements 表。拿不到返回 false(那游戏没有 schema)。
 *
 * **单独抽出来是因为有第二个调用方:生成攻略。** 批量同步跳过的两类游戏
 * (完成率 100%、以及刚加进来还没轮到同步的),恰恰是用户点「生成攻略」时会碰上的
 * 那两类 —— 那条路需要**只补这一个**,而不是让人先跑一次全库同步。
 * 两处各写一份取 schema 的逻辑,迟早在字段映射上分家(隐藏成就的描述和图标就有两套取法)。
 */
export async function fetchGameSchema(db, steam, game) {
  const cn = await steam.fetchAchievementSchema(game.appid, 'schinese');
  if (!cn?.length) return false;
  await sleep(steam.delay);
  const en = (await steam.fetchAchievementSchema(game.appid, 'english')) ?? [];
  const enByApiName = Object.fromEntries(en.map((a) => [a.name, a]));

  replaceAchievements(
    db,
    game.appid,
    cn.map((a) => {
      const hidden = a.hidden === 1;
      return {
        apiName: a.name,
        gameName: game.name,
        nameCn: a.displayName || a.name,
        nameEn: enByApiName[a.name]?.displayName || enByApiName[a.name]?.name || '',
        description: hidden ? '' : a.description || '',
        hidden,
        icon: hidden ? a.icongray || a.icon || '' : a.icon || '',
      };
    })
  );
  return true;
}

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

    if (await fetchGameSchema(db, steam, g)) processed++;
    else skippedNoSchema++;
    await sleep(steam.delay);
  }

  return { processed, skippedNoSchema, candidates: targets.length };
}

/**
 * 三个阶段依次跑完,记下完成时间(serve 靠它判断数据新鲜度)。
 *
 * 传了 selection 才会启用第二阶段的取样(serve 打开 Dashboard 走这条);
 * 不传就是老行为——整个库全查一遍。CLI 的 `sync` 故意留成后者:得有一个
 * "跑完肯定什么都不漏"的入口,`sync --fast` 才是按 config 取样的那个。
 */
export async function fullSync(db, steam, { onProgress = () => {}, selection = null } = {}) {
  const library = await syncLibrary(db, steam, { onProgress });
  const stats = await syncAchievementStats(db, steam, {
    onProgress,
    playSnapshot: selection ? library.playSnapshot : null,
    selection: selection ?? {},
  });
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
