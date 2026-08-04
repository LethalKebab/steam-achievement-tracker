/**
 * Dashboard 的后端方法(原 steam_dashboard.gs 里被 google.script.run 调用的那些函数)
 * ------------------------------------------------
 * 函数名、参数顺序、返回值结构都和 Apps Script 版本保持一致——这样 Dashboard.html
 * 里那 11 处调用一行都不用改,只需要一个把 google.script.run 转成 fetch 的 shim。
 */
import {
  allGames, getGame, insertGame, deleteGame as dbDeleteGame, setGameField,
  updateGameStats, markNoAchievements, achievementsFor, guideUrlMap, getMeta,
} from './db.js';
import { computeAgcrStats } from './sync.js';

const DAY_MS = 86400000;
const bool = (v) => v === 1 || v === true;

/** games 表的一行 → Dashboard 前端要的那个 game 对象 */
function toDashboardGame(row, guideUrls) {
  return {
    appid: row.appid || '',
    name: row.name || '(未命名)',
    achieved: typeof row.achieved === 'number' ? row.achieved : null,
    total: row.has_achievements === 0 ? 'N/A' : typeof row.total === 'number' ? row.total : null,
    rate: typeof row.rate === 'number' ? row.rate : null,
    unvetted: row.status === 'Unvetted',
    manual: row.status === 'Manual',
    family: bool(row.family),
    favorite: bool(row.favorite),
    priority: bool(row.priority),
    newAchDaysAgo: row.new_ach_date
      ? Math.floor((Date.now() - new Date(row.new_ach_date).getTime()) / DAY_MS)
      : null,
    guideUrl: guideUrls[row.appid] || '',
  };
}

/**
 * 切换某一列的布尔标记,返回 {<key>: 新值}。
 * toggleFavorite / togglePriority / toggleFamily 三个接口共用这一份逻辑。
 */
function toggleFlag(db, appid, column, key) {
  const row = getGame(db, appid);
  if (!row) return { error: '没有找到这个appid' };
  const next = !bool(row[column]);
  setGameField(db, appid, column, next ? 1 : 0);
  return { [key]: next };
}

export function createApi({ db, steam, config, syncState }) {
  const api = {
    getDashboardData() {
      const guideUrls = guideUrlMap(db);
      const games = allGames(db).map((r) => toDashboardGame(r, guideUrls));
      const agcr = computeAgcrStats(db);
      const lastSync = getMeta(db, 'last_sync');
      return {
        avgRounded: Math.floor(agcr.avg * 100) + '%',
        avgPrecise: (agcr.avg * 100).toFixed(3) + '%',
        perfectCount: agcr.perfectCount,
        totalGames: games.length,
        games,
        lastUpdated: lastSync
          ? new Date(lastSync).toLocaleString('zh-CN')
          : '还没同步过,跑一次 `node tracker.js sync`',
        // 本地版新增:后台同步状态,给注入的 shim 显示一行提示用
        sync: syncState.snapshot(),
      };
    },

    toggleFavorite: (appid) => toggleFlag(db, appid, 'favorite', 'favorite'),
    togglePriority: (appid) => toggleFlag(db, appid, 'priority', 'priority'),
    toggleFamily: (appid) => toggleFlag(db, appid, 'family', 'family'),

    /**
     * Manual 会同时关掉这一行的自动同步——本地版把这两件事拆成了 status 和 sync_locked
     * 两列,但从 Dashboard 点这个按钮仍然是两个一起变,保持和原版一样的直觉。
     */
    setManualStatus(appid, isManual) {
      const row = getGame(db, appid);
      if (!row) return { error: '没有找到这个appid' };
      setGameField(db, appid, 'status', isManual ? 'Manual' : '');
      setGameField(db, appid, 'sync_locked', isManual ? 1 : 0);
      return { manual: !!isManual };
    },

    setManualAchievements(appid, achieved, total) {
      achieved = Number(achieved);
      total = Number(total);
      if (!Number.isFinite(achieved) || !Number.isFinite(total) || achieved < 0 || total < 0) {
        return { error: '数值无效' };
      }
      if (achieved > total) return { error: '完成数不能大于成就总数' };

      const row = getGame(db, appid);
      if (!row) return { error: '没有找到这个appid' };
      if (row.status !== 'Manual') return { error: '只能编辑Manual状态的游戏' };

      const { rate } = updateGameStats(db, appid, { achieved, total });
      return { achieved, total, rate };
    },

    async searchSteamGames(query) {
      query = String(query ?? '').trim();
      if (!query) return [];
      return steam.searchStore(query);
    },

    /**
     * 手动添加一个游戏。和原版一样标成 Manual(原版源码就是这么做的,尽管它的注释写着
     * "Status留空"——以代码为准),顺便实时查一次成就数据,查不到就留空等下次同步重试。
     */
    async addGame(appid, name) {
      appid = String(appid ?? '').trim();
      if (!/^\d+$/.test(appid)) return { error: 'AppID必须是纯数字' };
      if (getGame(db, appid)) return { error: '这个appid已经在表格里了' };

      const resolved =
        (name && String(name).trim()) || (await steam.fetchAppName(appid)) || `AppID ${appid}`;
      insertGame(db, { appid, name: resolved, status: 'Manual', syncLocked: 1 });

      const result = {
        appid, name: resolved, achieved: null, total: null, rate: null,
        unvetted: false, manual: true, family: false, favorite: false, priority: false,
        newAchDaysAgo: null, guideUrl: '',
      };

      const stats = await steam.fetchAchievementStats(appid);
      if (stats.noAchievementSystem) {
        markNoAchievements(db, appid);
        result.total = 'N/A';
      } else if (!stats.retry) {
        const { rate } = updateGameStats(db, appid, stats);
        Object.assign(result, { achieved: stats.achieved, total: stats.total, rate });
      }
      return result;
    },

    /** 只删 games 这一行;achievements/guides 里同 appid 的数据留着,重新添加时能复用 */
    deleteGame(appid) {
      if (!getGame(db, appid)) return { error: '没有找到这个appid' };
      dbDeleteGame(db, appid);
      return { deleted: true, appid: String(appid) };
    },

    /**
     * 某个 appid 还差哪些成就没解锁。优先用 achievements 表里已同步好的定义,
     * 表里没有再实时查一次 GetSchemaForGame。
     */
    async getMissingAchievements(appid) {
      const raw = await steam.fetchPlayerAchievements(appid);
      if (raw.retry) return { error: '暂时获取不到你的成就进度(限流或 Steam 侧隐私设置),稍后再试' };
      if (raw.noAchievementSystem) return { error: '该游戏没有成就系统,或者Steam判定这个账号没有stats' };

      const achievedSet = new Set(
        raw.achievements.filter((a) => a.achieved === 1).map((a) => a.apiname)
      );

      const cached = achievementsFor(db, appid);
      let defs;
      if (cached.length > 0) {
        defs = cached.map((a) => ({
          name: a.api_name,
          displayName: a.name_cn || a.name_en || a.api_name,
          description: a.hidden ? '(隐藏成就,解锁前不显示描述)' : a.description,
          icon: a.icon,
        }));
      } else {
        const schema = await steam.fetchAchievementSchema(appid, config.language);
        if (!schema?.length) return { error: '无法获取该游戏的成就定义' };
        defs = schema.map((d) => ({
          name: d.name,
          displayName: d.displayName || d.name,
          description: d.hidden === 1 ? '(隐藏成就,解锁前不显示描述)' : d.description || '',
          icon: d.hidden === 1 ? d.icongray || d.icon || '' : d.icon || '',
        }));
      }

      const missing = defs.filter((a) => !achievedSet.has(a.name));
      return {
        total: defs.length,
        missingCount: missing.length,
        missing: missing.map((a) => ({
          name: a.displayName,
          description: a.description,
          icon: a.icon,
        })),
      };
    },

    /** 本地版新增:shim 轮询后台同步进度用 */
    syncStatus: () => syncState.snapshot(),
  };

  return api;
}
