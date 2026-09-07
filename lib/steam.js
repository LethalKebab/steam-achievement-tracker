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
 * ## The store header first, because the square icon is 32×32
 *
 * `GetOwnedGames` hands out an `img_icon_url` hash for free, needing no extra request — but the
 * asset behind it is **32×32**, and Notion renders a page icon several times larger than that,
 * larger again on a HiDPI screen. Measured on pages this program had already written: four icons
 * in six were that 32×32 and visibly soft; the sharp ones were the games that had fallen through
 * to the store header. **The free source is the wrong one**, so it is the last resort here rather
 * than the first choice.
 *
 * The store header is 460×215 and **can be assembled from the appid alone**, depending on no
 * account state — which also closes the blind spot the owned-list route has: `GetOwnedGames`
 * omits family-shared and delisted games (see the note in the file header: absent from owned ≠
 * no achievement data), and for that whole class the square icon does not exist at all.
 *
 * It is **confirmed to exist before being returned**, because a guessed URL that is wrong renders
 * in Notion as a broken image, which is worse than no icon at all.
 *
 * ## When the guess is wrong, ask
 *
 * Steam moved newer games' store assets to a content-hash path (see `fetchStoreHeaderImage`), and
 * that hash cannot be guessed. **Every asset carries its own hash**, so `capsule_616x353.jpg` and
 * `library_600x900_2x.jpg` cannot be derived from a header address that has been resolved —
 * measured: on a content-hash path those two 404 while `header.jpg` returns 200. That is why the
 * header is the one size used for every game rather than something larger for the games that
 * would allow it: one shape everywhere beats a sharper icon on 97% and a different shape on the
 * rest.
 *
 * The order matters: **guess first, ask second**, because when the guess is right (97% of the
 * time) no store-endpoint request is spent at all, and that endpoint is rate limited far more
 * strictly than the Web API. Every game now pays one HEAD where an owned one used to pay none —
 * one conditional CDN request per page written, for roughly fourteen times the pixels.
 */
export async function fetchGameIcon(steam, appid) {
  const guess = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
  try {
    const res = await fetch(guess, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    if (res.ok) return guess;
  } catch {
    // A network-level problem takes the same path, giving appdetails one more attempt
  }

  // try/catch rather than `.catch()`: a `steam` without the method throws **synchronously**, before
  // there is a promise to attach to, and the caller supplies that object. A client missing a method
  // has to degrade to the next source, not take the whole resolution down
  let header = null;
  try {
    header = await steam.fetchStoreHeaderImage(appid);
  } catch {
    // Same path as "appdetails had nothing"
  }
  if (header) return header;

  // Last resort, and the only source that needs no store asset to exist. 32×32 is too small for
  // Notion's icon slot, but a soft icon beats none — the alternative here is null
  const games = await steam.fetchOwnedGames(true).catch(() => []);
  const hit = games.find((g) => String(g.appid) === String(appid));
  return hit?.img_icon_url
    ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${hit.img_icon_url}.jpg`
    : null;
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

  /**
   * Games played in the last two weeks.
   *
   * **The one Web API endpoint that sees family-shared titles.** A game absent from
   * `GetOwnedGames` shows up here as soon as it is played, on the same key — measured against a
   * live account, 2 of 11 recently-played games were shared rather than owned, one of them with
   * 31 hours in the fortnight. That is what makes an unattended family check possible at all:
   * `IFamilyGroupsService` answers the same question more completely, but authenticates with a
   * browser `access_token` that expires in about a day and will not take an API key, so nothing
   * running on its own can call it.
   *
   * **There is no `rtime_last_played` in the response** — the fields are `playtime_2weeks` and
   * `playtime_forever`. So it answers "was this played recently" and never "when", and the
   * fortnight is fixed: it cannot stand in for the Dashboard's own five-day recency window
   * without quietly giving that badge two meanings. A `last_played` for these rows is derived
   * from the total moving instead, in `recordUnownedPlaytime`.
   *
   * Returns null on failure rather than throwing. This is supplementary — losing it must cost
   * the family check and never the sync.
   */
  async fetchRecentlyPlayedGames() {
    const url =
      'https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/' +
      `?key=${this.key}&steamid=${this.steamId}&format=json`;
    try {
      const res = await this.#get(url);
      if (!res.ok) {
        this.log(msg('steam.recentFailed', { status: res.status }));
        return null;
      }
      const data = await res.json();
      return data?.response?.games ?? [];
    } catch {
      this.log(msg('steam.recentFailed', { status: '—' }));
      return null;
    }
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
    // **403 is permanent, and saying so is the whole point of the flag.** Steam answers
    // `"Profile is not public"` both when this account holds no licence for the game any more — a
    // family member left the group, or the game was refunded — and when the per-game achievement
    // privacy toggle is off. The two are byte-identical and the API cannot separate them; what they
    // share is that no amount of retrying helps, which is exactly what distinguishes them from 429.
    //
    // **`retry` stays true.** Seven call sites read this shape and six of them are
    // `if (raw.retry) → error / throw / skip`; a `{forbidden: true}` without it would send every one
    // of them into the success branch to read an `achievements` array that is not there. The flag is
    // additive so nothing downstream changes behaviour — it only lets a caller that cares say which
    // rows will never answer again.
    if (res.status === 403) {
      this.log(`appid ${appid} -> HTTP 403(Steam 拒绝提供该账号的进度,重试无用)`);
      return { retry: true, forbidden: true };
    }
    if (!res.ok) {
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
