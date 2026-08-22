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

/**
 * 一款游戏的图标 URL。拿不到返回 null:**没有图标的页面照样是好页面**,
 * 别为了个图标把建页/搬家卡住。
 *
 * (放在这里而不是 guidegen.js 里,是因为它纯粹是一次 Steam 查询 —— 生成攻略和
 * 搬运攻略都要用,而那两件事之间不该为了一个 URL 拼接产生依赖。)
 *
 * ## 两个来源,因为第一个有一整类盲区
 *
 * 首选是方形小图标,但它的 hash **只有 `GetOwnedGames` 给**。而这个接口会漏掉
 * 家庭共享和已下架的游戏(见文件头那条"不在 owned 里 ≠ 没有成就数据")——
 * 于是这一整类游戏永远拿不到图标,而且是静默的:函数返回 null,建页照常成功,
 * 只有人打开 Notion 才看得见少了一样东西。实测踩到:《中国式家长》(736190)
 * 生成的页面没有图标,原因就是它不在 owned 列表里。
 *
 * 所以退一步用商店头图 —— 它**只要 appid 就能拼出来**,不依赖任何账号状态。
 * 退回来的这个要**先确认真的存在**再交出去:前一个 URL 是 Steam 给的数据拼的,
 * 这一个是我们猜的,猜错了 Notion 上就是一个碎图标,比没有图标更难看。
 *
 * ## 猜错的时候还有第三步
 *
 * 那个 HEAD 检查一直在老实工作,只是它的结论是"没有图标",而**真实结论是
 * "这张图不在我们猜的地方"** —— Steam 把新游戏的商店素材搬到了带内容哈希的
 * 路径下(见 `fetchStoreHeaderImage`)。库里 9 款是这样,全是近两年的游戏。
 * 于是这一整类游戏的 Notion 页照样没图标,而且和上面那个盲区一样是静默的。
 *
 * 所以 HEAD 失败之后不再直接放弃,而是问一次 appdetails 要真地址。
 * 顺序是有讲究的:**先猜后问**,因为猜中的时候(97%)一次网络请求都不用多花,
 * 而商店接口的限流比 Web API 严得多。
 */
export async function fetchGameIcon(steam, appid) {
  const games = await steam.fetchOwnedGames(true).catch(() => []);
  const hit = games.find((g) => String(g.appid) === String(appid));
  if (hit?.img_icon_url) {
    return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${hit.img_icon_url}.jpg`;
  }

  const guess = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
  try {
    const res = await fetch(guess, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    if (res.ok) return guess;
  } catch {
    // 网络本身出问题也走下面那条路,让 appdetails 再试一次
  }
  return steam.fetchStoreHeaderImage(appid).catch(() => null);
}

/** 单次 Steam 请求的上限。见 `#get` —— 不给的话吃的是 undici 那个 5 分钟的默认值 */
const STEAM_TIMEOUT_MS = 30_000;

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

  async #get(url, init = {}) {
    // fetch 本身不会因为 4xx/5xx 抛错,和 muteHttpExceptions:true 的语义天然一致。
    //
    // **超时得自己给。** 不给就是 undici 的默认值 —— 每次请求 5 分钟。一次全库同步
    // 要打几百次,Steam 那边卡住一次,界面上就是「同步中」停在那里不动、也不报错。
    // `notion.js` 一直带着 30 秒,封面探测那条带着 10 秒,这里是漏掉的一处。
    // `...init` 放在后面:调用方自己给了 signal 就听调用方的
    return fetch(url, { signal: AbortSignal.timeout(STEAM_TIMEOUT_MS), ...init });
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
   * 本来就有这个字段。第二阶段靠它跳过"根本没玩过所以不可能变"的行。
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
  /**
   * 全球解锁率(每个成就有百分之多少的玩家拿到)。
   *
   * **不需要 API key**,也和账号无关——这是一个关于游戏本身的公开事实。
   *
   * 用处是给攻略生成一个**难度信号**:模型光看名字和描述分不出哪条难,于是会把力气
   * 平摊在所有成就上。实测《部落幸存者》最难的 1.1% 和最容易的 64.5% 差 60 倍,
   * 而生成出来的心得字数只差不到一倍。
   *
   * 拿不到就返回 null —— 这是锦上添花的数据,不该因为它挂掉就不给人生成攻略。
   *
   * @returns {Promise<Map<string, number>|null>} api_name → 百分比
   */
  async fetchGlobalAchievementPercentages(appid) {
    const url =
      'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/' +
      `?gameid=${appid}`;
    try {
      const res = await this.#get(url);
      if (!res.ok) return null;
      const rows = (await res.json())?.achievementpercentages?.achievements;
      if (!Array.isArray(rows) || !rows.length) return null;
      // percent 有时是字符串,统一成数字;转不出来的丢掉而不是当 0
      const out = new Map();
      for (const r of rows) {
        const pct = Number(r?.percent);
        if (r?.name && Number.isFinite(pct)) out.set(r.name, pct);
      }
      return out.size ? out : null;
    } catch {
      return null;
    }
  }

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

  /**
   * 商店头图的**真实**地址。拿不到返回 null。
   *
   * **为什么不能拼:** `cdn.akamai.steamstatic.com/steam/apps/<appid>/header.jpg`
   * 这条老路径对库里 97% 的游戏还有效,但 Steam 把商店素材迁到了带内容哈希的路径:
   *
   *   .../store_item_assets/steam/apps/<appid>/<40 位哈希>/header.jpg
   *
   * 那段哈希猜不出来,而且**每个素材各有各的哈希**(header 和 capsule 不一样),
   * 所以也不能从一个推另一个。有些还是 `header_schinese.jpg` —— 按语言分文件。
   * 实测(314 款):9 款拿不到,四种替代域名写法全部 404,
   * 清一色是 2023 年之后的 appid。**这个数只会越变越大**,新买的游戏都在新路径上。
   *
   * appdetails 是权威来源,它直接给完整 URL,不需要我们知道任何路径规则。
   * 代价是一次商店接口调用(限流比 Web API 严),所以调用方要缓存,而且只对
   * 真的拿不到图的那些游戏问 —— 见 api.js 的 resolveCover。
   */
  async fetchStoreHeaderImage(appid) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${this.lang}`;
    const res = await this.#get(url);
    if (!res.ok) {
      this.log(`appid ${appid} -> 查封面失败 HTTP ${res.status}(商店接口限流比较严格)`);
      return null;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      this.log(`appid ${appid} -> 查封面失败,返回内容不是合法 JSON(大概率被限流了)`);
      return null;
    }
    const entry = data?.[String(appid)];
    // success=false 是"这个 appid 没有商店页"(已下架、区域限制、playtest 过期),
    // 不是错误 —— 这类游戏就是没有封面可拿,如实返回 null
    if (!entry?.success) return null;
    return entry.data?.header_image || null;
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
