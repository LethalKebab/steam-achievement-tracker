/**
 * Dashboard 的后端方法
 * ------------------------------------------------
 * 这里的函数名和返回值结构是和 Dashboard.html 的约定:前端通过 lib/rpc.js 按名字调用
 * (rpc....someMethod(args) → POST /api/someMethod),改名或改返回结构会直接把前端弄坏。
 * 加新方法只需要往这里加,rpc 那边不用动。
 */
import {
  allGames, getGame, insertGame, deleteGame as dbDeleteGame, setGameField,
  updateGameStats, markNoAchievements, achievementsFor, guideUrlMap, allGuides, getMeta,
} from './db.js';
import { computeAgcrStats } from './sync.js';
import { saveConfig } from './config.js';
import { SteamClient } from './steam.js';
import { importAll } from './csv.js';
import { NotionClient } from './notion.js';
import { createProvider, checkResult } from './ai.js';
import { planMigration, migrateGuideToNotion as migrate } from './guidemigrate.js';

const DAY_MS = 86400000;
const bool = (v) => v === 1 || v === true;

/** 攻略链接:Notion 是完整 URL 直接用;本地是文件名,要走服务端的 /guide/ 路由 */
function toGuideHref(appid, url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `/guide/${encodeURIComponent(appid)}`;
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
      let workspace = '';
      try {
        const me = await probe.request('get', '/users/me');
        workspace = me.name || me.bot?.workspace_name || '未命名';
      } catch (err) {
        return { error: `token 不可用:${err.message}` };
      }

      let pageCount = null;
      if (dbId) {
        try {
          pageCount = (await probe.queryGuideDatabase(dbId)).length;
        } catch (err) {
          // **两个完全不同的毛病以前共用这一句话**,而它只指向其中一个:
          // 「填的是页面 ID 而不是数据库 ID」和「忘了加 Connections」报的一模一样,
          // 于是填错 ID 的人会被这句话赶去反复检查 Connections。两条都说出来。
          return {
            error:
              `token 没问题,但这个 ID 读不出数据库:${err.message}\n` +
              `两种可能,修法不一样:\n` +
              `  · 它不是数据库 —— 数据库要整页打开,取 URL 里 ?v= 前面那 32 位十六进制;` +
              `页面 ID、视图 ID(?v= 后面那段)、整条链接都不行\n` +
              `  · 还没共享给 integration —— 在 Notion 里打开它(或它的父页面)→ 右上角 ••• → Connections → 加上这个 integration\n` +
              `没有现成的数据库的话,把这一栏留空,用「帮我建一个」。`,
          };
        }
      }

      saveConfig({ notion: { token, overviewDbId: dbId } });
      // NotionClient 在每个调用点都是现建的(new NotionClient(config)),所以
      // 改掉 config.notion 就够了,不用像 steam 那样再去补实例字段
      config.notion = { ...(config.notion ?? {}), token, overviewDbId: dbId };
      return { ok: true, workspace, pageCount };
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
