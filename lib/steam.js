/**
 * Steam Web API / store endpoint wrapper
 * ------------------------------------------------
 * Every point below was learned the hard way and is not available for casual simplification:
 * - HTTP 400 from GetPlayerAchievements is Steam's standard signal (this game has no stats for
 *   this account); it is not an error and must not be retried. 429 is the real rate limit, and
 *   every other non-200 is left for the next run to retry
 * - appdetails' name field ignores the l= parameter (a known Steam quirk); a Chinese name
 *   requires scraping the store page as well
 * - Scraping the store page needs the age-verification cookie, and the regex must be loose (the
 *   class attribute can carry several classes)
 * - GetOwnedGames must be called twice (skip_unvetted_apps true/false) and differenced to
 *   determine which games are Unvetted
 */
import { msg } from './messages.js';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const hasChineseChars = (s) => /[一-鿿]/.test(String(s));

/**
 * A game's icon URL. Returns null when unavailable: **a page without an icon is still a good
 * page**, and creating or migrating one must not be blocked over an icon.
 *
 * (It lives here rather than in guidegen.js because it is purely a Steam query — both guide
 * generation and guide migration need it, and those two should not acquire a dependency on each
 * other over one URL.)
 *
 * ## Two sources, because the first has an entire blind spot
 *
 * The preferred source is the square icon, but its hash **comes only from `GetOwnedGames`**,
 * which omits family-shared and delisted games (see the note in the file header: absent from
 * owned ≠ no achievement data). So that whole class of game could never get an icon, silently:
 * the function returned null, page creation succeeded as normal, and the omission was visible
 * only on opening Notion. Hit for real: the generated page for 中国式家长 (736190) had no icon,
 * because that game is not in the owned list.
 *
 * The fallback is the store header image, which **can be assembled from the appid alone** and
 * depends on no account state. That fallback is **confirmed to exist before being returned**:
 * the first URL is assembled from data Steam gave us, this one is a guess, and a wrong guess
 * renders in Notion as a broken image, which is worse than no icon at all.
 *
 * ## There is a third step for when the guess is wrong
 *
 * The HEAD check had been working correctly all along; it simply reached the conclusion "there
 * is no icon" when **the true conclusion was "the image is not where we guessed"** — Steam moved
 * newer games' store assets to a content-hash path (see `fetchStoreHeaderImage`). Nine games in
 * the library are in that state, all of them recent. So that whole class of game had Notion pages
 * without icons, and, as with the blind spot above, silently.
 *
 * So a failed HEAD no longer gives up; it asks appdetails for the real address. The order matters:
 * **guess first, ask second**, because when the guess is right (97% of the time) no extra request
 * is spent at all, and the store endpoint is rate limited far more strictly than the Web API.
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
    // A network-level problem takes the same path, giving appdetails one more attempt
  }
  return steam.fetchStoreHeaderImage(appid).catch(() => null);
}

/** The ceiling for a single Steam request. See `#get` — omitting it means accepting undici's 5-minute default */
const STEAM_TIMEOUT_MS = 30_000;

const AGE_COOKIE =
  'birthtime=189302401; mature_content=1; wants_mature_content=1; lastagecheckage=1-January-1976';

export class SteamClient {
  constructor(cfg, { log = () => {} } = {}) {
    this.key = cfg.steamApiKey;
    this.steamId = cfg.steamId;
    this.lang = cfg.language || 'schinese';
    // **The two routes are rate limited very differently, hence two knobs.**
    // `delay` paces the official Web API at api.steampowered.com. Measured once:
    // GetPlayerAchievements, 400 consecutive requests at 0 ms interval, sustained at 11/s for
    // 36 seconds, with **not a single 429** (plus a 300→0 ms ladder of 30 requests per step,
    // equally clean). So 100 ms here already carries a factor-of-two margin.
    // `storeDelay` paces store.steampowered.com, which serves store page HTML, is far more
    // strictly limited, and answers abuse with an IP-level block rather than a key-level one.
    // **That one is deliberately not measured**: hammering the store to establish a number is
    // completely disproportionate in risk to what it would buy. It stays at 300 ms, and anyone
    // changing it should read this sentence first.
    this.delay = cfg.requestDelayMs ?? 100;
    this.storeDelay = cfg.storeRequestDelayMs ?? 300;
    this.log = log;
  }

  async #get(url, init = {}) {
    // fetch itself does not throw on 4xx/5xx, which matches muteHttpExceptions:true semantics.
    //
    // **The timeout has to be supplied.** Without it the value is undici's default of five
    // minutes per request. A full library sync makes several hundred, so one hung Steam response
    // presents as the interface sitting on 「同步中」 indefinitely without erroring.
    // `notion.js` has carried 30 seconds all along and the cover probe carries 10; this was the
    // one place it was missing.
    // `...init` comes last: a caller supplying its own signal wins
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
      throw new Error(msg('steam.ownedFailed', {
        status: res.status,
        hint: res.status === 401 || res.status === 403 ? msg('steam.ownedAuthHint') : '',
      }));
    }
    const data = await res.json();
    return data?.response?.games ?? [];
  }

  /**
   * The full owned list plus which games Steam classifies as Unvetted (Profile Features Limited).
   * Two requests differenced are required; a single request defaults to the vetted-only view, and
   * no conclusion can be drawn from it.
   *
   * It additionally returns playSnapshot (appid → rtime_last_played). This is **free**: the field
   * is already in the same response. Phase two uses it to skip rows that cannot have changed
   * because they were never played.
   * A game never played has 0 in that field (measured to coincide exactly with
   * playtime_forever=0), and 0 is used rather than null so downstream code need not distinguish
   * "the field is absent" from "never played".
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

  /** Returns {total, achieved} | {noAchievementSystem:true} | {retry:true} */
  /**
   * The global unlock rate (what percentage of players have each achievement).
   *
   * **No API key required**, and unrelated to the account — this is a public fact about the game.
   *
   * Its purpose is to give guide generation a **difficulty signal**: from names and descriptions
   * alone the model cannot tell which entries are hard and spreads its effort evenly. Measured on
   * 部落幸存者, the hardest at 1.1% and the easiest at 64.5% differ by a factor of 60, while the
   * generated notes differed in length by less than a factor of two.
   *
   * Returns null when unavailable — this is supplementary data, and its absence must not prevent
   * a guide from being generated.
   *
   * @returns {Promise<Map<string, number>|null>} api_name → percentage
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
      // percent is sometimes a string; normalise to a number, and drop anything unconvertible rather than treating it as 0
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

  /** The raw per-achievement unlock state, used by checkbox sync and the "what is still missing" panel */
  async fetchPlayerAchievements(appid) {
    const url =
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/' +
      `?appid=${appid}&key=${this.key}&steamid=${this.steamId}&format=json`;
    const res = await this.#get(url);

    if (res.status === 429) {
      this.log(`appid ${appid} -> HTTP 429 限流,下次重试`);
      return { retry: true };
    }
    // 400 is Steam's standard signal: this game has no stats for this account. Do not retry
    if (res.status === 400) {
      this.log(`appid ${appid} -> HTTP 400(Steam 判定无成就数据,标记无成就系统)`);
      return { noAchievementSystem: true };
    }
    if (!res.ok) {
      // 403 "Profile is not public" takes this branch as well: it is a per-game privacy toggle on
      // Steam's side, where retrying never succeeds — but it must not be permanently marked as
      // "has no achievement system" either
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

  /** The official achievement definitions (no steamid needed; public data keyed on appid alone) */
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

  // ---------- name lookup ----------

  /** A two-stage lookup: the JSON endpoint first, then the store page HTML if no Chinese name came back */
  async fetchAppName(appid) {
    const apiName = await this.fetchAppNameFromJson(appid);
    if (apiName && hasChineseChars(apiName)) return apiName;
    // Both are store.steampowered.com (appdetails and the store page HTML), so use storeDelay
    await sleep(this.storeDelay);
    const pageName = await this.fetchAppNameFromStorePage(appid);
    if (pageName && hasChineseChars(pageName)) return pageName;
    return apiName; // Neither yielded Chinese, so return whatever the JSON gave (possibly English)
  }

  /**
   * The **actual** address of the store header image. Returns null when unavailable.
   *
   * **Why it cannot be assembled:** the old path
   * `cdn.akamai.steamstatic.com/steam/apps/<appid>/header.jpg` still works for 97% of the
   * library, but Steam moved store assets to a content-hash path:
   *
   *   .../store_item_assets/steam/apps/<appid>/<40 hex characters>/header.jpg
   *
   * That hash cannot be guessed, and **each asset has its own** (the header's differs from the
   * capsule's), so one cannot be derived from another. Some are `header_schinese.jpg` as well —
   * one file per language. Measured across 314 games: 9 unreachable, with four alternative
   * host/path spellings returning 404 for every one of them, all of them appids from 2023 onwards.
   * **That number only grows**, as newly bought games are all on the new path.
   *
   * appdetails is the authoritative source and returns the complete URL, requiring no knowledge of
   * any path rule. The cost is one store-endpoint call (rate limited more strictly than the Web
   * API), so the caller must cache the answer and ask only for games whose image genuinely cannot
   * be reached — see resolveCover in api.js.
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
    // success=false means "this appid has no store page" (delisted, region locked, an expired
    // playtest) rather than an error — those games simply have no cover, so return null honestly
    if (!entry?.success) return null;
    return entry.data?.header_image || null;
  }

  /** @param lang the store locale to ask in; defaults to the configured one (Chinese) */
  async fetchAppNameFromJson(appid, lang = this.lang) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${lang}`;
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

  /**
   * The title Steam serves in the **English** locale, for the `name_en` search column.
   *
   * Deliberately not the same question as `fetchAppName`, which hunts for a *Chinese* title across
   * two endpoints and fills the displayed `name`. This one asks once, in English, and reports what
   * came back — so a game published only in Japanese answers with its Japanese title, and that is
   * the correct answer rather than a miss. There is exactly one such game measured in a 317-game
   * library, so treating it as a failure and retrying it every sync would be wrong.
   *
   * Only needed for rows GetOwnedGames does not cover (family-shared, delisted, hand-added):
   * for owned games the English name is already in that response and costs nothing.
   * Returns null when the endpoint gives nothing back — a delisted appid has no store page at all.
   */
  async fetchAppNameEn(appid) {
    return this.fetchAppNameFromJson(appid, 'english');
  }

  /** Scrape the store page's own localised title (apphub_AppName); a best-effort fallback */
  async fetchAppNameFromStorePage(appid) {
    const url = `https://store.steampowered.com/app/${appid}/?l=${this.lang}`;
    const res = await this.#get(url, { redirect: 'follow', headers: { Cookie: AGE_COOKIE } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<div[^>]*class="[^"]*apphub_AppName[^"]*"[^>]*>([^<]+)<\/div>/);
    return m?.[1]?.trim() ?? null;
  }

  /** Store search (no API key required), used by the Dashboard's add-a-game field */
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
