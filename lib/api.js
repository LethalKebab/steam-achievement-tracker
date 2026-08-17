/**
 * Dashboard 的后端方法
 * ------------------------------------------------
 * 这里的函数名和返回值结构是和 Dashboard.html 的约定:前端通过 lib/rpc.js 按名字调用
 * (rpc....someMethod(args) → POST /api/someMethod),改名或改返回结构会直接把前端弄坏。
 * 加新方法只需要往这里加,rpc 那边不用动。
 */
import {
  allGames, getGame, insertGame, deleteGame as dbDeleteGame, setGameField,
  updateGameStats, markNoAchievements, achievementsFor, guideUrlMap, allGuides, getGuide, getMeta,
} from './db.js';
import { backendFor, mapAchievementGuides, stripGuideEcho } from './guides.js';
import { computeAgcrStats } from './sync.js';
import { saveConfig } from './config.js';
import { SteamClient } from './steam.js';
import { importAll } from './csv.js';
import { NotionClient, inspectGuideDb, repairGuideDb, DB_PROBLEM } from './notion.js';
import { createProvider, checkResult } from './ai.js';
import { planMigration, migrateGuideToNotion as migrate } from './guidemigrate.js';

const DAY_MS = 86400000;
const bool = (v) => v === 1 || v === true;

/** 攻略链接:Notion 是完整 URL 直接用;本地是文件名,要走服务端的 /guide/ 路由 */
function toGuideHref(appid, url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `/guide/${encodeURIComponent(appid)}`;
}

/**
 * 攻略里**某一条**的深链。Notion 的 block id 去掉横线就是页面锚点,而
 * fetchAllToDoBlocks 返回的 `key` 本来就是 block id,所以这里不用额外存任何东西。
 *
 * 本地 markdown 的 `key` 是行号,没有等价的锚点,返回 null —— 前端据此只显示正文
 * 不显示跳转,而不是拼一个点了没反应的链接出来。
 */
function toGuideAnchor(guide, key) {
  if (!guide || guide.kind !== 'notion') return null;
  const id = String(key).replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(id) ? `${guide.url}#${id}` : null;
}

/** games 表的一行 → Dashboard 前端要的那个 game 对象 */
function toDashboardGame(row, guideUrls, guideKinds) {
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
    // 铃铛的两类。**跃迁发生的时刻**,由 updateGameStats 在唯一还看得见旧值的地方盖下,
    // 前端只是按天数筛一下 —— 别试图从 achieved/total 现算,现在的状态答不出这两个问题
    perfectLostDaysAgo: row.perfect_lost_date
      ? Math.floor((Date.now() - new Date(row.perfect_lost_date).getTime()) / DAY_MS)
      : null,
    achAddedDaysAgo: row.ach_added_date
      ? Math.floor((Date.now() - new Date(row.ach_added_date).getTime()) / DAY_MS)
      : null,
    // 原始时间戳也给出去:铃铛拿它当"这条读过了"的键。用天数当键不行 ——
    // 天数每天都在变,存下来的"已读"第二天就对不上,红点会天天复活
    perfectLostAt: row.perfect_lost_date ?? null,
    achAddedAt: row.ach_added_date ?? null,
    // last_played 是 Steam 的 rtime_last_played(秒),同步时顺手记下来的。
    // 只有 owned 的行有;家庭共享/已下架的行 Steam 根本不给这个字段,只能是 null
    playedDaysAgo:
      typeof row.last_played === 'number' && row.last_played > 0
        ? Math.floor((Date.now() - row.last_played * 1000) / DAY_MS)
        : null,
    // 本地攻略在 guides 表里存的是**裸文件名**,直接当 href 会被浏览器解析成
    // http://127.0.0.1:8777/<文件名> —— 服务端没这个路由,点了就是 404。
    // 这里翻译成 /guide/<appid>,由服务端按表里的路径去读
    guideUrl: toGuideHref(row.appid, guideUrls[row.appid]),
    // 本地攻略可以搬去 Notion,Notion 的不行 —— 前端要能只给本地的那几行出按钮
    guideKind: guideKinds[row.appid] ?? null,
    // 问出来的真实封面地址,**只有猜不出来的那些游戏才有值**(见 resolveCover)。
    // 有值就直接用,省掉前端"先加载失败再来问一次"的那一轮 —— 那一轮是必要的
    // 发现手段,但只该发生一次,不该每次开页面都重演
    coverUrl: row.cover_url || null,
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

export function createApi({
  db, steam, config, syncState, startBackgroundSync,
  guideGenState, startGuideGen, planGuidePreflight,
  maybeAutoSync,
}) {
  const api = {
    getDashboardData() {
      const guideUrls = guideUrlMap(db);
      const guideKinds = Object.fromEntries(allGuides(db).map((g) => [g.appid, g.kind]));
      const games = allGames(db).map((r) => toDashboardGame(r, guideUrls, guideKinds));
      const agcr = computeAgcrStats(db);
      const lastSync = getMeta(db, 'last_sync');
      return {
        avgRounded: Math.floor(agcr.avg * 100) + '%',
        avgPrecise: (agcr.avg * 100).toFixed(3) + '%',
        // 这里**曾经**还有一个原始比值 `avg`,专门给顶栏底边那条完成率进度条用。
        // 进度条 2026-08-16 拆了(见 Dashboard.html 的 .topbar),没有第二个调用方,
        // 所以这个字段跟着一起删——留着就是一个没人读的数,下一个人得先证明它没用
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
    async addGame(appid, name, family = false) {
      appid = String(appid ?? '').trim();
      if (!/^\d+$/.test(appid)) return { error: 'AppID必须是纯数字' };
      if (getGame(db, appid)) return { error: '这个appid已经在表格里了' };

      const isFamily = Boolean(family);
      const resolved =
        (name && String(name).trim()) || (await steam.fetchAppName(appid)) || `AppID ${appid}`;
      // **不再一律设 Manual(改动于 2026-08-13)。** 以前手动添加的行全部
      // `status:'Manual', syncLocked:1`,理由是「手动加的多半是 Steam 查不到数据的」。
      // 那个理由对家庭共享的游戏正好是反的:家庭标记的含义就是**你自己在玩、Steam
      // 照常返回真实进度**,把它锁住等于让它永远停在加进来那一刻的数字上。
      // 现在默认保持自动同步;真的拿不到数据,行上那把锁一点就停。
      insertGame(db, { appid, name: resolved, family: isFamily ? 1 : 0 });

      const result = {
        appid, name: resolved, achieved: null, total: null, rate: null,
        unvetted: false, manual: false, family: isFamily, favorite: false, priority: false,
        newAchDaysAgo: null, playedDaysAgo: null, guideUrl: '',
        perfectLostDaysAgo: null, achAddedDaysAgo: null, perfectLostAt: null, achAddedAt: null,
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

    /**
     * 问 Steam 要这款游戏封面的真实地址,存进库里。
     *
     * **前端猜不到的时候才会调到这里。** Dashboard 拼的是
     * `.../steam/apps/<appid>/header.jpg`,这条路对库里 97% 的游戏有效,
     * 剩下那些新游戏的素材在一段猜不出的哈希路径下(理由见
     * `steam.fetchStoreHeaderImage`)。所以流程是**先猜、猜不中再问、问到就记下**:
     *
     * - 猜中(绝大多数):一次多余的请求都没有
     * - 猜不中:图片 onerror 触发这个方法,拿到真地址换上,同时落库
     * - 下次开页面:`getDashboardData` 直接把 `coverUrl` 带出去,不再走这条路
     *
     * **失败不写库。** 写一个空值当"问过了、没有"会让它永远不再重试,而
     * 拿不到的原因多半是限流或者商店页还没建好 —— 那都是会变的。代价是这类
     * 游戏每次开页面多一次请求,而实测这类只有个位数,可以接受。
     */
    async resolveCover(appid) {
      appid = String(appid ?? '').trim();
      const row = getGame(db, appid);
      if (!row) return { error: '没有找到这个appid' };
      if (row.cover_url) return { url: row.cover_url };

      const url = await steam.fetchStoreHeaderImage(appid).catch(() => null);
      if (!url) return { url: null };
      setGameField(db, appid, 'cover_url', url);
      return { url };
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

      // 这条成就在你自己的攻略里是怎么写的。
      //
      // 整段**软失败**:Notion token 过期、页面被删、网络不通,都只让这一层没有东西
      // 可显示,绝不能把「还差哪些成就」这个面板一起弄挂 —— 和 serve 路径上所有攻略
      // 动作同一条规矩。
      //
      // 只在 achievements 表已经有明细时才试:反查要读 api_name/name_cn/name_en/
      // description,而上面那条"表里没有就实时查 schema"的兜底给不出这个形状。
      // 实测这不吃亏——有攻略且没满的 50 个游戏,成就明细 50/50 都同步过了。
      // 削复述要拿**原始行**的 description,不能拿上面那个 display 用的:隐藏成就在
      // 那边是「(隐藏成就,解锁前不显示描述)」这句占位符。原始行里它是空的,于是
      // 什么都匹配不上、什么都不删 —— 而那正是对的,隐藏成就攻略里的那行描述通常是
      // 整张卡片唯一写着达成条件的地方
      const rowByApiName = new Map(cached.map((c) => [c.api_name, c]));
      const guideRow = getGuide(db, appid);
      let guideInfo = null;
      let guideByApiName = new Map();
      if (guideRow && cached.length > 0) {
        guideInfo = { url: toGuideHref(appid, guideRow.url), kind: guideRow.kind };
        try {
          const backend = backendFor(guideRow, { notion: new NotionClient(config), config });
          guideByApiName = mapAchievementGuides(await backend.loadTodos(), cached);
        } catch (err) {
          guideInfo.error = '读不到攻略:' + err.message;
        }
      }

      return {
        total: defs.length,
        missingCount: missing.length,
        // null = 这个游戏根本没登记攻略(或者成就明细还没同步,那种情况下我们无从判断
        // 攻略里写没写这条,所以什么都不说,而不是冤枉一句"攻略里还没写")
        guide: guideInfo,
        missing: missing.map((a) => {
          const g = guideByApiName.get(a.name); // defs 里的 name 就是 api_name
          const row = rowByApiName.get(a.name);
          return {
            name: a.displayName,
            description: a.description,
            icon: a.icon,
            guide: g
              ? {
                  // 卡片上方已经有成就名和描述了,攻略正文开头对它们的复述要削掉,
                  // 否则同一份信息印两遍,还把真正的打法挤出预览窗口
                  text: stripGuideEcho(g.text, {
                    names: [a.displayName, row?.name_cn, row?.name_en],
                    description: row?.description ?? '',
                  }),
                  subSteps: g.subSteps,
                  url: toGuideAnchor(guideRow, g.key),
                }
              : null,
          };
        }),
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

    /**
     * 「过期了才同步」—— 和 startSync 的区别就是那道 `syncStaleHours` 闸门。
     *
     * 这条是给 launcher 用的,不是给 Dashboard 的:收进托盘后进程能连着跑几天,
     * 而 maybeAutoSync 原本只在服务器启动时被调一次(`startupJobs`),所以
     * 「开一次 app = 查一次是否过期」这个触发会随着后台常驻一起消失。launcher
     * 在窗口显示时打这里,把触发点搬回来。
     *
     * **不能用 startSync 代替**:那个是手动按钮用的,故意绕开新鲜度判断
     * (点击本身已经回答了"要不要同步")。拿它当窗口显示的钩子,就变成每次
     * 切回窗口都全量同步一遍。
     */
    maybeSync() {
      if (!maybeAutoSync) return { started: false, reason: 'unavailable' };
      return { started: maybeAutoSync() };
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

    /**
     * 设置页加载时读当前状态。**密钥只回答"配没配",不回传原文**——
     * 页面上没有任何地方需要显示它,回传了只是白白多一个泄漏面。
     * 非密钥的值(SteamID、数据库 ID)照常回填,不然改一个字段要把另一个重打一遍。
     */
    getSettings: () => ({
      steamId: config.steamId || '',
      hasSteamKey: Boolean(config.steamApiKey),
      notionDbId: config.notion?.overviewDbId || '',
      hasNotionToken: Boolean(config.notion?.token),
      aiProvider: config.ai?.provider || '',
      aiModel: config.ai?.model || '',
      hasAiKey: Boolean(config.ai?.apiKey),
    }),

    /**
     * AI 攻略生成的配置,GUI 版的 `node tracker.js init --ai`。
     *
     * **验证是发一次真请求**,不是看格式。这个功能的失败模式全都要发一次请求才知道:
     * key 无效、模型已停售、这一档额度是 0、端点不认某个工具——没有一个能从字符串
     * 本身看出来。让人在设置页花几分钱撞上,好过在生成攻略跑到一半才撞上。
     *
     * **key 留空 = 沿用已经存着的那个**,和 Steam / Notion 一致。设置页会回填
     * provider 和 model,如果把"空 key"理解成"清除",那么有人只想换个模型、
     * 顺手提交一下就会把 key 抹掉。要停用就去 config.json 清空 ai.apiKey。
     *
     * 只改 `config.ai` 就够了——供应商对象是每次调用现建的(和 NotionClient 一样),
     * 不像 SteamClient 会在构造时把凭据抄进实例字段。
     */
    async saveAiConfig(provider, apiKey, model) {
      provider = String(provider ?? '').trim();
      apiKey = String(apiKey ?? '').trim();
      model = String(model ?? '').trim();
      if (!provider) return { error: '还没选供应商' };

      const effective = apiKey || (provider === config.ai?.provider ? config.ai?.apiKey : '') || '';
      if (!effective) return { error: '还没填 API Key' };

      const ai = { ...config.ai, provider, apiKey: effective, model };
      let probe;
      try {
        probe = await createProvider({ ai });
      } catch (err) {
        return { error: String(err.message ?? err) };
      }

      try {
        const r = await probe.send({ messages: [{ role: 'user', content: '回复一个字:好' }] });
        const verdict = checkResult(r);
        if (!verdict.ok) return { error: `验证没通过:${verdict.reason}` };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }

      config.ai = ai;
      saveConfig({ ai: { provider, apiKey: effective, model } });
      return { ok: true, provider: probe.name, model: probe.model, canSearch: probe.canSearch !== false };
    },

    /** 开始后台生成一份攻略。**页面必须先弹确认框**——这是唯一会花钱的动作 */
    startGuideGen: (appid, overwrite) => startGuideGen(String(appid), Boolean(overwrite)),

    /**
     * 重写已有攻略之前的预检。**只读**,给前端弹确认框用。
     *
     * 和 `previewGuideToNotion` 一个道理:确认必须建立在"知道会失去什么"之上,
     * 而覆盖唯一真正丢掉的东西(手动勾上的子步骤框)只有算过才知道。
     * 返回的是数字,句子由前端自己组 —— 共用的是那次计算,不是措辞。
     */
    async previewGuideRewrite(appid) {
      try {
        return await planGuidePreflight(String(appid), { overwrite: true });
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    guideGenStatus: () => guideGenState.snapshot(),

    /**
     * 本地 markdown 攻略 → Notion。
     *
     * **同步返回,不走后台任务。** 和 guide-gen 不一样:这里没有模型调用,
     * 全程就是几次 Notion 请求(建页、写块、回读、发现),几秒钟的事,
     * 为它再搭一套状态机、轮询和进度条,复杂度换不回什么。
     *
     * 两段是分开的,因为它们的失败含义不同:`preview` 只读,给页面弹确认框用;
     * `migrate` 才写。前端必须先拿到 preview(尤其是 `unconverted`)再问用户,
     * 否则"确认"是在不知道会损失什么的情况下点的。
     *
     * 按 rpc 的约定,拒绝理由一律 `{error}` 返回 —— 那是**成功的调用**,前端自己看。
     */
    async previewGuideToNotion(appid) {
      try {
        const plan = await planMigration(db, { notion: new NotionClient(config), config, appid });
        return {
          game: plan.game,
          path: plan.path,
          todos: plan.todos.length,
          checked: plan.todos.filter((t) => t.checked).length,
          unconverted: plan.unconverted,
          existingPage: plan.target.existingPage?.url ?? null,
        };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    async migrateGuideToNotion(appid) {
      try {
        const r = await migrate(db, { notion: new NotionClient(config), steam, config, appid });
        return { ok: true, url: r.url, count: r.count, game: r.game, archivedTo: r.archivedTo };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * Notion 攻略同步的配置,GUI 版的 `node tracker.js init --notion`。
     *
     * **token 和数据库分开验证、分开报错**,这一点是照搬 CLI 的:两者的修法完全不同
     * ——token 不对要回 my-integrations 重新复制,数据库访问不了则是没在页面上加
     * connection(Notion 会返回 404,看起来却像 ID 填错了)。合并成一句"配置失败"
     * 会让人对着正确的 token 反复重填。
     *
     * **token 留空 = 沿用已经存着的那个**,和 Steam API Key 的规则一致。设置页上
     * 数据库 ID 是回填的,如果把"空 token"理解成"清除",那么有人只想改 SteamID、
     * 顺手提交一下,就会把 Notion token 抹掉——改一个字段不该毁掉另一个。
     * 要停用 Notion 同步,去 config.json 把 notion.token 清空;界面上不提供这个动作。
     */
    async saveNotionConfig(token, dbId) {
      token = String(token ?? '').trim();
      dbId = String(dbId ?? '').trim();

      const effective = token || config.notion?.token || '';
      if (!effective) return { error: '还没填 Integration Secret' };
      token = effective;

      const probe = new NotionClient({ notion: { token, overviewDbId: dbId } });

      // **接库这一刻就把 schema 问完。** 在这之前这里只查两件事:token 通不通、
      // 这个 ID 能不能查出行来 —— 属性、类型、状态选项一个字不看,全推迟到真写的时候。
      // 于是用户在这个页面看到「配好了」,几天后第一次 guide-gen 才撞上「没有「XX」这个
      // 选项」,而那时他早就不认为问题出在设置上了。同一时期 `notion-check` 查得很全,
      // 只是这个页面从来没调过它 —— **两条路查的东西不一样,这才是那类 bug 的形状**。
      // 现在两边共用 inspectGuideDb,谁也漂不开。
      //
      // 试写(建一页再立刻归档)也在这里:只读体检查不出「这个 integration 只有读权限」,
      // 而那恰好是另一条能一路绿灯、到建页才 403 的毛病。
      const verdict = await inspectGuideDb(probe, dbId, { probeWrite: Boolean(dbId) });
      if (verdict.problems.some((p) => p.code === DB_PROBLEM.BAD_TOKEN)) {
        return { error: `token 不可用:${verdict.problems[0].message.replace(/^token 不可用:/, '')}` };
      }
      const workspace = verdict.workspace ?? '';

      let pageCount = null;
      if (dbId) {
        const unreadable = verdict.problems.find((p) => p.code === DB_PROBLEM.DB_UNREADABLE);
        if (unreadable) {
          // **两个完全不同的毛病以前共用这一句话**,而它只指向其中一个:
          // 「填的是页面 ID 而不是数据库 ID」和「忘了加 Connections」报的一模一样,
          // 于是填错 ID 的人会被这句话赶去反复检查 Connections。两条都说出来。
          return {
            error:
              `token 没问题,但这个 ID 读不出数据库:${unreadable.message}\n` +
              `两种可能,修法不一样:\n` +
              unreadable.causes.map((c) => `  · ${c}`).join('\n') +
              `\n没有现成的数据库的话,把这一栏留空,用「帮我建一个」。`,
          };
        }
        pageCount = (await probe.queryGuideDatabase(dbId)).length;
      }

      saveConfig({ notion: { token, overviewDbId: dbId } });
      // NotionClient 在每个调用点都是现建的(new NotionClient(config)),所以
      // 改掉 config.notion 就够了,不用像 steam 那样再去补实例字段
      config.notion = { ...(config.notion ?? {}), token, overviewDbId: dbId };

      // **schema 有毛病不挡保存。** ID 本身是对的,拒绝保存等于让用户白填一次,
      // 而且他下次进来还得重填。该做的是存下来 + 把毛病和确切修法一起交出去
      return {
        ok: true,
        workspace,
        pageCount,
        problems: verdict.problems,
        dbOk: verdict.ok,
        fixable: verdict.fixable,
      };
    },

    /**
     * 「帮我补上缺的状态选项」。**永远是用户按出来的**,不在保存时静默改他的数据库。
     *
     * 补选项是可加操作(已有的连 id 和颜色一起原样带过去,只往后接),这是它能被允许
     * 写用户数据库的前提 —— 改名或删掉别人的选项不是,而且 Notion 没有撤销。
     *
     * 成功与否由 `repairGuideDb` 回读判定,不看 HTTP 状态码:Notion 对 status 属性
     * 有静默无效的先例(见 `repairGuideDb` 上面那段),而"报告修好了、其实一个字没动"
     * 比"修不了"难查得多。
     */
    async repairNotionGuideDb() {
      const token = config.notion?.token;
      const dbId = config.notion?.overviewDbId;
      if (!token) return { error: '还没配 Notion token' };
      if (!dbId) return { error: '还没配攻略数据库 ID' };

      const notion = new NotionClient(config);
      try {
        const r = await repairGuideDb(notion, dbId);
        if (r.reason === 'clobbered') {
          return {
            error:
              `补选项把已有的选项冲掉了:${r.clobbered.join(' / ')}。` +
              '这是比没修好严重得多的情况,请去 Notion 里把它们加回来,并把这件事报给作者。',
          };
        }
        if (r.reason === 'no-status-prop') {
          return { error: '这个库没有状态属性,补选项解决不了 —— 要先在 Notion 里加一个 Status 属性。' };
        }
        if (r.reason === 'silently-ignored') {
          return {
            error:
              `Notion 收下了请求但选项没落地,还缺:${r.stillMissing.join(' / ')}。` +
              `${r.type === 'status' ? 'status 类型的属性选项多半只能在 Notion 界面里加:' : ''}` +
              '打开那个库 → 点这个属性 → 手动加上这几个选项,名字要一模一样(注意大小写)。',
          };
        }
        return { ok: true, added: r.added, property: r.property, type: r.type };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * 「帮我建一个」第一步:列出这个 integration 能当父页面用的页面。
     *
     * **一个页面都没有不是错误,是诊断** —— 它精确地说明「Connections 那一步还没做」,
     * 而那一步以前只能靠一句和「ID 填错了」共用的报错去猜。
     *
     * token 留空 = 用已经存着的那个,和这一页其它地方的规矩一致。
     */
    async listNotionParents(token) {
      const effective = String(token ?? '').trim() || config.notion?.token || '';
      if (!effective) return { error: '还没填 Integration Secret' };
      try {
        const probe = new NotionClient({ notion: { token: effective } });
        const { pages, truncated } = await probe.searchPages();
        return { ok: true, pages, truncated };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * 「帮我建一个」第二步:在选中的页面下建库,**并把 ID 直接存进配置**。
     *
     * 存盘放在这里而不是让页面回填后再走一次 `saveNotionConfig`,是因为库已经建出来了 ——
     * 这时候再要求用户按一次保存,忘按的人就得到一个「Notion 里多了个空库、工具却说没配」
     * 的状态,而那个库看不出是谁建的。建了就记下来。
     */
    async createNotionGuideDb(token, parentPageId, title) {
      const effective = String(token ?? '').trim() || config.notion?.token || '';
      if (!effective) return { error: '还没填 Integration Secret' };
      if (!String(parentPageId ?? '').trim()) return { error: '还没选父页面' };
      // **已经配了库就不许建。** 这个按钮存下的 ID 会盖掉现有的那个,而那意味着一个
      // 有上百篇攻略的人点一下就被改指到一个空库 —— 攻略一篇没丢,但工具全都找不着了,
      // 而且看不出发生过什么。真要换库是「清空那一栏、保存、再建」,三步都是明示的
      if (config.notion?.overviewDbId) {
        return {
          error:
            `已经配了攻略库(${config.notion.overviewDbId})。「帮我建一个」是给还没有库的人用的 —— ` +
            `建了会把这一栏改指到新库,现有攻略就都不在工具的视野里了。` +
            `真要换:先把「攻略数据库 ID」清空并保存,再回来建。`,
        };
      }
      try {
        const probe = new NotionClient({ notion: { token: effective } });
        const db = await probe.createGuideDatabase({
          parentPageId: String(parentPageId).trim(),
          title: String(title ?? '').trim() || 'Steam 攻略',
        });
        saveConfig({ notion: { token: effective, overviewDbId: db.id } });
        config.notion = { ...(config.notion ?? {}), token: effective, overviewDbId: db.id };
        return { ok: true, ...db };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },
  };

  return api;
}
