/**
 * Dashboard 的后端方法
 * ------------------------------------------------
 * 这里的函数名和返回值结构是和 Dashboard.html 的约定:前端通过 lib/rpc.js 按名字调用
 * (rpc....someMethod(args) → POST /api/someMethod),改名或改返回结构会直接把前端弄坏。
 * 加新方法只需要往这里加,rpc 那边不用动。
 */
import {
  allGames, getGame, insertGame, deleteGame as dbDeleteGame, setGameField,
  updateGameStats, markNoAchievements, achievementsFor, guideUrlMap, getMeta,
} from './db.js';
import { computeAgcrStats } from './sync.js';
import { saveConfig } from './config.js';
import { SteamClient } from './steam.js';
import { importAll } from './csv.js';

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
    // last_played 是 Steam 的 rtime_last_played(秒),同步时顺手记下来的。
    // 只有 owned 的行有;家庭共享/已下架的行 Steam 根本不给这个字段,只能是 null
    playedDaysAgo:
      typeof row.last_played === 'number' && row.last_played > 0
        ? Math.floor((Date.now() - row.last_played * 1000) / DAY_MS)
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

export function createApi({ db, steam, config, syncState, startBackgroundSync }) {
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
        // Dashboard 上的文案不提命令行——打包版的用户根本没有终端可用,
        // 而「立即同步」按钮就在这行字旁边,该做什么一目了然
        lastUpdated: lastSync ? new Date(lastSync).toLocaleString('zh-CN') : '还没同步过',
        // 本地版新增:后台同步状态,给注入的 shim 显示一行提示用
        sync: syncState.snapshot(),
      };
    },

    toggleFavorite: (appid) => toggleFlag(db, appid, 'favorite', 'favorite'),
    togglePriority: (appid) => toggleFlag(db, appid, 'priority', 'priority'),
    toggleFamily: (appid) => toggleFlag(db, appid, 'family', 'family'),

    /**
     * status 和 sync_locked 是两列(分类 / 是否跳过同步),但从 Dashboard 点这个按钮
     * 是两个一起变——界面上标成 Manual 就该同时意味着别再自动同步这行。
     * 需要拆开的时候直接改数据库那一列。
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
     * 手动添加一个游戏,标成 Manual(手动加的行通常就是 Steam 查不到真实数据的那种,
     * 交给自动同步只会被覆盖),顺便实时查一次成就数据,查不到就留空等下次同步重试。
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
        newAchDaysAgo: null, playedDaysAgo: null, guideUrl: '',
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

    /**
     * Dashboard 上的「立即同步」按钮。只负责发起,立刻返回——进度提示和跑完后的
     * 自动刷新都由 lib/rpc.js 的轮询接管,和启动时的自动同步共用同一套。
     *
     * "已经在同步了" / "没配凭据" 都按业务错误返回 {error},不抛异常:
     * 前端靠 result.error 分支,抛出去只会变成一句没信息量的"请求失败"。
     */
    startSync() {
      const r = startBackgroundSync();
      return r.started ? { started: true } : { error: r.error };
    },

    /** 本地版新增:shim 轮询后台同步进度用 */
    syncStatus: () => syncState.snapshot(),

    /**
     * 打包版(Electron 启动器)首次设置用——GUI 版的 `node tracker.js init`(不含 --notion,
     * 那部分先按下不表)。**先验证再写盘**:验证失败就不能把凭据存进 config.json,
     * 不然 `/` 那个"没配置就跳 /setup"的判断会被一个非空但打不通的值糊弄过去,
     * 用户就卡在一个看起来配置成功、实际永远同步不了的 Dashboard 上。
     *
     * csvFolder 可选——对应 README 里"先导入表格数据再首次同步"那条:♥/★/家庭/Manual
     * 这些字段 Steam 根本没有,同步一旦跑过就再也导不回来了(见 importAll 的调用方)。
     * GUI 版没有终端可以事后补跑 `node tracker.js import`,所以这一步必须卡在
     * "凭据存盘、Dashboard 可用、立即同步按钮可点"之前——三者是同一个事件(见下面的
     * config/steam 就地修改),晚一步都等于把导入窗口关上了。导入失败就整个提交都失败、
     * 凭据也不存,免得用户以为"设置完成"了其实导入没做成,回头点了同步才发现回不去了。
     */
    async completeSetup(apiKey, steamId, csvFolder) {
      apiKey = String(apiKey ?? '').trim();
      steamId = String(steamId ?? '').trim();
      csvFolder = String(csvFolder ?? '').trim();
      if (!apiKey || !steamId) return { error: '两个都得填' };
      if (!/^\d{17}$/.test(steamId)) return { error: 'SteamID64 应该是 17 位数字,去 steamid.io 查一下' };

      const probe = new SteamClient({ steamApiKey: apiKey, steamId, language: config.language });
      let games;
      try {
        games = await probe.fetchOwnedGames(false);
      } catch (err) {
        return { error: `验证失败:${err.message}` };
      }

      let imported = null;
      if (csvFolder) {
        try {
          imported = importAll(db, csvFolder);
        } catch (err) {
          return { error: `CSV 导入失败:${err.message}(凭据还没保存,改好路径再提交一次,或者清空这一栏跳过导入)` };
        }
      }

      saveConfig({ steamApiKey: apiKey, steamId });
      // 光写盘不够:这个进程手里的 config 和 steam 是启动时就建好的旧对象,
      // 不会因为 config.json 变了就自动跟着变——steam 尤其如此,SteamClient 的构造函数
      // 是把 key/steamId 复制成自己的实例字段(见 lib/steam.js),不是存一份 config 的引用。
      // 当场把这两处都改掉,当前进程立刻可用,不需要重启子进程。
      config.steamApiKey = apiKey;
      config.steamId = steamId;
      steam.key = apiKey;
      steam.steamId = steamId;
      return { ok: true, gameCount: games.length, imported };
    },

    /** Electron 轮询用:配置好了没有,好决定什么时候把窗口跳回 Dashboard(不需要重启子进程)*/
    getSetupStatus: () => ({ configured: Boolean(config.steamApiKey && config.steamId) }),
  };

  return api;
}
