/**
 * Steam Web API / 商店接口封装
 * ------------------------------------------------
 * 下面这几条都是踩出来的,不是可以"顺手简化"的地方:
 * - GetPlayerAchievements 的 HTTP 400 是 Steam 的标准信号(这游戏对这账号没有 stats),
 *   不是错误、不该重试;429 才是真限流;其他非 200 一律留给下次重试
 * - appdetails 的 name 字段不受 l= 参数影响(Steam 已知怪癖),要中文名必须再抓一次商店网页
 * - 抓商店网页要带年龄验证 cookie,正则要写宽松(class 属性可能有多个 class)
 * - GetOwnedGames 必须发两次(skip_unvetted_apps true/false)做差集才能判断 Unvetted
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const hasChineseChars = (s) => /[一-鿿]/.test(String(s));

const AGE_COOKIE =
  'birthtime=189302401; mature_content=1; wants_mature_content=1; lastagecheckage=1-January-1976';

export class SteamClient {
  constructor(cfg, { log = () => {} } = {}) {
    this.key = cfg.steamApiKey;
    this.steamId = cfg.steamId;
    this.lang = cfg.language || 'schinese';
    this.delay = cfg.requestDelayMs ?? 300;
    this.log = log;
  }

  async #get(url, init) {
    // fetch 本身不会因为 4xx/5xx 抛错,和 muteHttpExceptions:true 的语义天然一致
    return fetch(url, init);
  }

  // ---------- owned games ----------

  async fetchOwnedGames(skipUnvettedApps) {
    const url =
      'https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/' +
      `?key=${this.key}&steamid=${this.steamId}` +
      `&include_appinfo=true&include_played_free_games=true&format=json&l=${this.lang}` +
      `&skip_unvetted_apps=${skipUnvettedApps}`;
    const res = await this.#get(url);
    if (!res.ok) {
      throw new Error(
        `GetOwnedGames 失败 HTTP ${res.status}` +
          (res.status === 401 || res.status === 403 ? '(API key 或 SteamID 不对?)' : '')
      );
    }
    const data = await res.json();
    return data?.response?.games ?? [];
  }

  /**
   * 完整 owned 列表 + 哪些被 Steam 判成 Unvetted(Profile Features Limited)。
   * 必须两次请求做差集,单次请求默认是"只要 vetted 的",不能据此下结论。
   *
   * 顺带返回 playSnapshot(appid → rtime_last_played)。这是**白拿的**:同一份响应里
   * 本来就有这个字段,以前直接丢掉了。第二阶段靠它跳过"根本没玩过所以不可能变"的行。
   * 没玩过的游戏该字段是 0(实测和 playtime_forever=0 完全重合),用 0 而不是 null,
   * 省得下游还要分"没这个字段"和"没玩过"两种情况。
   */
  async fetchOwnedGamesWithUnvettedFlag() {
    const fullList = await this.fetchOwnedGames(false);
    await sleep(this.delay);
    const vettedList = await this.fetchOwnedGames(true);
    const vetted = new Set(vettedList.map((g) => String(g.appid)));
    const unvettedAppIds = new Set(
      fullList.filter((g) => !vetted.has(String(g.appid))).map((g) => String(g.appid))
    );
    const playSnapshot = new Map(
      fullList.map((g) => [String(g.appid), g.rtime_last_played ?? 0])
    );
    return { games: fullList, unvettedAppIds, playSnapshot };
  }

  // ---------- achievements ----------

  /** 返回 {total, achieved} | {noAchievementSystem:true} | {retry:true} */
  async fetchAchievementStats(appid) {
    const raw = await this.fetchPlayerAchievements(appid);
    if (raw.noAchievementSystem || raw.retry) return raw;
    const total = raw.achievements.length;
    const achieved = raw.achievements.filter((a) => a.achieved === 1).length;
    return { total, achieved };
  }

  /** 原始逐条成就解锁状态,给 checkbox 同步和"还差哪些成就"用 */
  async fetchPlayerAchievements(appid) {
    const url =
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/' +
      `?appid=${appid}&key=${this.key}&steamid=${this.steamId}&format=json`;
    const res = await this.#get(url);

    if (res.status === 429) {
      this.log(`appid ${appid} -> HTTP 429 限流,下次重试`);
      return { retry: true };
    }
    // 400 是 Steam 的标准信号:这游戏对这账号没有 stats 数据,不要重试
    if (res.status === 400) {
      this.log(`appid ${appid} -> HTTP 400(Steam 判定无成就数据,标记无成就系统)`);
      return { noAchievementSystem: true };
    }
    if (!res.ok) {
      // 403 "Profile is not public" 也走这一支:是 Steam 侧的单游戏隐私开关,
      // 重试永远不会成功,但也不该当成"没有成就系统"永久标记掉
      this.log(`appid ${appid} -> HTTP ${res.status}(临时错误,下次重试)`);
      return { retry: true };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { retry: true };
    }
    const stats = data?.playerstats;
    if (!stats || !stats.success) {
      this.log(`appid ${appid} -> ${stats?.error || '未知原因'}(标记无成就系统,不再重试)`);
      return { noAchievementSystem: true };
    }
    if (!stats.achievements) {
      this.log(`appid ${appid} -> 确认无成就系统`);
      return { noAchievementSystem: true };
    }
    return { achievements: stats.achievements };
  }

  /** 官方成就定义(不需要 steamid,纯按 appid 查的公开数据) */
  async fetchAchievementSchema(appid, lang) {
    const url =
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/' +
      `?key=${this.key}&appid=${appid}&l=${lang}&format=json`;
    const res = await this.#get(url);
    if (!res.ok) return null;
    try {
      const data = await res.json();
      return data?.game?.availableGameStats?.achievements ?? null;
    } catch {
      return null;
    }
  }

  // ---------- 名字反查 ----------

  /** 两层查:JSON 接口优先,没拿到中文再抓商店网页 HTML */
  async fetchAppName(appid) {
    const apiName = await this.fetchAppNameFromJson(appid);
    if (apiName && hasChineseChars(apiName)) return apiName;
    await sleep(this.delay);
    const pageName = await this.fetchAppNameFromStorePage(appid);
    if (pageName && hasChineseChars(pageName)) return pageName;
    return apiName; // 两边都没中文,只能返回 JSON 给的(可能是英文)
  }

  async fetchAppNameFromJson(appid) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${this.lang}`;
    const res = await this.#get(url);
    if (!res.ok) {
      this.log(`appid ${appid} -> 反查名字失败 HTTP ${res.status}(商店接口限流比较严格)`);
      return null;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      this.log(`appid ${appid} -> 反查名字失败,返回内容不是合法 JSON(大概率被限流了)`);
      return null;
    }
    const entry = data?.[String(appid)];
    return entry?.success && entry?.data?.name ? entry.data.name : null;
  }

  /** 抓商店网页本身的本地化标题(apphub_AppName),属于尽力而为的兜底 */
  async fetchAppNameFromStorePage(appid) {
    const url = `https://store.steampowered.com/app/${appid}/?l=${this.lang}`;
    const res = await this.#get(url, { redirect: 'follow', headers: { Cookie: AGE_COOKIE } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<div[^>]*class="[^"]*apphub_AppName[^"]*"[^>]*>([^<]+)<\/div>/);
    return m?.[1]?.trim() ?? null;
  }

  /** 商店搜索(不需要 API key),给 Dashboard 的"添加游戏"用 */
  async searchStore(term) {
    const url =
      'https://store.steampowered.com/api/storesearch/' +
      `?term=${encodeURIComponent(term)}&l=${this.lang}&cc=US`;
    const res = await this.#get(url);
    if (!res.ok) return [];
    try {
      const data = await res.json();
      return (data.items ?? [])
        .filter((i) => i.type === 'app')
        .slice(0, 10)
        .map((i) => ({ appid: String(i.id), name: i.name }));
    } catch {
      return [];
    }
  }
}
