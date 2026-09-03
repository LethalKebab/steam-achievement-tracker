/**
 * The Dashboard's backend methods
 * ------------------------------------------------
 * The function names and return shapes here are a contract with Dashboard.html: the frontend calls
 * them by name through lib/rpc.js (rpc....someMethod(args) → POST /api/someMethod), so renaming one
 * or changing its return shape breaks the frontend directly.
 * Adding a method means adding it here only; rpc needs no change.
 */
import {
  allGames, getGame, insertGame, deleteGame as dbDeleteGame, setGameField, countGames,
  updateGameStats, markNoAchievements, achievementsFor, guideUrlMap, allGuides, getGuide, getMeta,
} from './db.js';
import { backendFor, mapAchievementGuides, stripGuideEcho } from './guides.js';
import { computeAgcrStats } from './sync.js';
import {
  saveConfig, loadConfig, resolveAiKey, canonicalAiProvider, AI_KEY_ENV, CONFIG_PATH, DATA_ROOT,
  VENDOR_SCOPED_AI_FIELDS,
} from './config.js';
import { SteamClient, sleep } from './steam.js';
import {
  achievementName, achievementDescription, gameNamePair, normalizeUiLanguage, UI_LANGUAGES,
} from './lang.js';
import { msg, setMessageLanguage } from './messages.js';
import { createBackup, applyBackup, inspectBackup, backupName } from './backup.js';
import { NotionClient, inspectGuideDb, repairGuideDb, DB_PROBLEM } from './notion.js';
import { createProvider, checkResult } from './ai.js';
import { planMigration, migrateGuideToNotion as migrate } from './guidemigrate.js';
import { listArchives, readArchive, restoreArchive, deleteArchive, deleteArchives } from './guidearchive.js';
import { resolveGuidePath } from './markdown.js';
import { revealInFileManager } from './reveal.js';
import { isInside } from './pathsafe.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DAY_MS = 86400000;
const bool = (v) => v === 1 || v === true;

/** The guide link: a Notion URL is complete and used as-is; a local one is a filename and must go through the server's /guide/ route */
function toGuideHref(appid, url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `/guide/${encodeURIComponent(appid)}`;
}

/**
 * A deep link to **one entry** in a guide. A Notion block id with the hyphens removed is the page
 * anchor, and the `key` returned by fetchAllToDoBlocks is already the block id, so nothing extra has
 * to be stored here.
 *
 * A local markdown `key` is a line number with no equivalent anchor, so this returns null — the
 * frontend then shows the prose without a jump control, rather than assembling a link that does
 * nothing when clicked.
 */
function toGuideAnchor(guide, key) {
  if (!guide || guide.kind !== 'notion') return null;
  const id = String(key).replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(id) ? `${guide.url}#${id}` : null;
}

/** One row of the games table → the game object the Dashboard frontend expects */
function toDashboardGame(row, guideUrls, guideKinds, lang) {
  const { shown, alt } = gameNamePair(row, lang);
  return {
    appid: row.appid || '',
    name: shown || msg('game.unnamed'),
    // The stored name this row is **not** showing — search only, and empty when there is no
    // distinct second one. See gameNamePair for why it is not called nameEn
    nameAlt: alt,
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
    // The two notification events. **The moment the transition happened**, stamped by
    // updateGameStats at the one point where the previous value is still visible; the frontend only
    // filters by age — do not try to compute these from achieved/total, as the current state cannot
    // answer either question
    perfectLostDaysAgo: row.perfect_lost_date
      ? Math.floor((Date.now() - new Date(row.perfect_lost_date).getTime()) / DAY_MS)
      : null,
    achAddedDaysAgo: row.ach_added_date
      ? Math.floor((Date.now() - new Date(row.ach_added_date).getTime()) / DAY_MS)
      : null,
    // The raw timestamps are supplied too: the notification panel uses them as the "this one has
    // been read" key. Day counts cannot serve as the key — they change daily, so a stored
    // "read" set stops matching overnight and the marker reappears every morning
    perfectLostAt: row.perfect_lost_date ?? null,
    achAddedAt: row.ach_added_date ?? null,
    // last_played is Steam's rtime_last_played (in seconds), recorded during the sync.
    // Only owned rows have it; for family-shared and delisted rows Steam supplies no such field at
    // all, so it can only be null
    playedDaysAgo:
      typeof row.last_played === 'number' && row.last_played > 0
        ? Math.floor((Date.now() - row.last_played * 1000) / DAY_MS)
        : null,
    // A local guide is stored in the guides table as a **bare filename**, and using that as an href
    // has the browser resolve it to http://127.0.0.1:8777/<filename> — a route the server does not
    // have, so clicking it is a 404.
    // It is translated here into /guide/<appid>, which the server reads by the path in the table
    guideUrl: toGuideHref(row.appid, guideUrls[row.appid]),
    // A local guide can be moved to Notion and a Notion one cannot, so the frontend needs to offer the button on local rows only
    guideKind: guideKinds[row.appid] ?? null,
    // The real cover URL as looked up, **set only for the games whose URL cannot be guessed** (see
    // resolveCover). Where it is set it is used directly, saving the frontend's "fail to load, then
    // ask" round — that round is a necessary means of discovery, but it should happen once rather
    // than being replayed on every page open
    coverUrl: row.cover_url || null,
  };
}

/**
 * Toggle a boolean column, returning {<key>: newValue}.
 * toggleFavorite / togglePriority / toggleFamily share this one implementation.
 */
function toggleFlag(db, appid, column, key) {
  const row = getGame(db, appid);
  if (!row) return { error: msg('game.notFound') };
  const next = !bool(row[column]);
  setGameField(db, appid, column, next ? 1 : 0);
  return { [key]: next };
}

export function createApi({
  db, steam, config, syncState, startBackgroundSync,
  guideGenState, startGuideGen, cancelGuideGen, planGuidePreflight, previewGuidePatch,
  maybeAutoSync, appVersion = '',
}) {
  const api = {
    getDashboardData() {
      const guideUrls = guideUrlMap(db);
      const guideKinds = Object.fromEntries(allGuides(db).map((g) => [g.appid, g.kind]));
      const lang = normalizeUiLanguage(config.uiLanguage);
      const games = allGames(db).map((r) => toDashboardGame(r, guideUrls, guideKinds, lang));
      const agcr = computeAgcrStats(db);
      const lastSync = getMeta(db, 'last_sync');
      return {
        avgRounded: Math.floor(agcr.avg * 100) + '%',
        avgPrecise: (agcr.avg * 100).toFixed(3) + '%',
        perfectCount: agcr.perfectCount,
        totalGames: games.length,
        games,
        uiLanguage: lang,
        // Dashboard copy never mentions the command line — a user of the packaged build has no
        // terminal available, and the 「立即同步」 button sits right beside this line, making the
        // action obvious
        // **The date format follows the interface, not the machine.** A page reading in English
        // with a zh-CN timestamp on it is the one line that looks like a bug rather than a choice
        lastUpdated: lastSync
          ? new Date(lastSync).toLocaleString(lang === 'en' ? 'en-GB' : 'zh-CN')
          : msg('sync.never'),
        // Added for the local build: the background sync state, for the injected shim's status line
        sync: syncState.snapshot(),
      };
    },

    toggleFavorite: (appid) => toggleFlag(db, appid, 'favorite', 'favorite'),
    togglePriority: (appid) => toggleFlag(db, appid, 'priority', 'priority'),
    toggleFamily: (appid) => toggleFlag(db, appid, 'family', 'family'),

    /**
     * status and sync_locked are two columns (the classification, and whether to skip syncing), but
     * pressing this button on the Dashboard moves both — marking a row Manual in the interface
     * should simultaneously mean stopping automatic syncing for it.
     * When they genuinely need to differ, edit that column in the database directly.
     */
    setManualStatus(appid, isManual) {
      const row = getGame(db, appid);
      if (!row) return { error: msg('game.notFound') };
      setGameField(db, appid, 'status', isManual ? 'Manual' : '');
      setGameField(db, appid, 'sync_locked', isManual ? 1 : 0);
      return { manual: !!isManual };
    },

    setManualAchievements(appid, achieved, total) {
      achieved = Number(achieved);
      total = Number(total);
      if (!Number.isFinite(achieved) || !Number.isFinite(total) || achieved < 0 || total < 0) {
        return { error: msg('game.badNumbers') };
      }
      if (achieved > total) return { error: msg('game.achievedTooHigh') };

      const row = getGame(db, appid);
      if (!row) return { error: msg('game.notFound') };
      if (row.status !== 'Manual') return { error: msg('game.notLocked') };

      const { rate } = updateGameStats(db, appid, { achieved, total });
      return { achieved, total, rate };
    },

    async searchSteamGames(query) {
      query = String(query ?? '').trim();
      if (!query) return [];
      return steam.searchStore(query);
    },

    /**
     * Add a game by hand, looking up its achievement data at the same time and leaving it blank for
     * the next sync to retry if nothing comes back.
     */
    async addGame(appid, name, family = false) {
      appid = String(appid ?? '').trim();
      if (!/^\d+$/.test(appid)) return { error: msg('game.appidNotNumeric') };
      if (getGame(db, appid)) return { error: msg('game.alreadyHere') };

      const isFamily = Boolean(family);
      // The name the caller passes comes from the store search, which asks in the configured
      // language — so it is the localised title, and the English one still has to be asked for
      // separately. This row will never appear in GetOwnedGames if it is family-shared or
      // delisted, which is where an owned row gets its English name for free
      const given = name && String(name).trim();
      const hunted = given ? null : await steam.fetchAppName(appid);
      if (!given) await sleep(steam.storeDelay); // fetchAppName went to the store endpoint
      const nameEn = (await steam.fetchAppNameEn(appid)) || '';
      const resolved = given || hunted || `AppID ${appid}`;
      // **Do not set `status:'Manual', syncLocked:1` unconditionally.** The reasoning that "a
      // hand-added game is usually one Steam has no data for" is exactly inverted for a
      // family-shared game: the family flag means **you are playing it yourself and Steam returns
      // real progress as normal**, so locking it freezes the numbers at the moment it was added.
      // Automatic syncing stays on by default; if the data genuinely cannot be fetched, the lock on
      // the row is one click away.
      insertGame(db, { appid, name: resolved, nameEn, family: isFamily ? 1 : 0 });

      // Through the same pair as every other row: this object is pushed straight into the
      // Dashboard's games array without a reload, so a different shape here means the game just
      // added searches differently from its neighbours until the page is refreshed
      const { shown, alt } = gameNamePair({ name: resolved, name_en: nameEn }, normalizeUiLanguage(config.uiLanguage));
      const result = {
        appid, name: shown || resolved, nameAlt: alt, achieved: null, total: null, rate: null,
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
     * Ask Steam for this game's real cover URL and store it.
     *
     * **This is only reached when the frontend's guess fails.** The Dashboard assembles
     * `.../steam/apps/<appid>/header.jpg`, which works for 97% of the library; the remaining, newer
     * games have their assets under an unguessable hash path (the reasoning is in
     * `steam.fetchStoreHeaderImage`). So the flow is **guess, ask if the guess misses, record the answer**:
     *
     * - Guess correct (the vast majority): not one extra request
     * - Guess wrong: the image's onerror calls this method, the real URL replaces it, and it is stored
     * - Next page open: `getDashboardData` supplies `coverUrl` directly and this path is not taken
     *
     * **A failure is not written.** Writing an empty value to mean "asked, none exists" would stop
     * it ever retrying, while the usual reason for a failure is rate limiting or a store page not
     * yet published — both of which change. The cost is one extra request per page open for those
     * games, and measured they number in the single digits, which is acceptable.
     */
    async resolveCover(appid) {
      appid = String(appid ?? '').trim();
      const row = getGame(db, appid);
      if (!row) return { error: msg('game.notFound') };
      if (row.cover_url) return { url: row.cover_url };

      const url = await steam.fetchStoreHeaderImage(appid).catch(() => null);
      if (!url) return { url: null };
      setGameField(db, appid, 'cover_url', url);
      return { url };
    },

    /**
     * Locate this **local** guide in the system file manager.
     *
     * It exists because a local guide served through `/guide/` comes out as **plain-text markdown
     * source** (a deliberate XSS precaution, see server.js), and reading it properly means opening
     * the file in an editor — while "where is the file" is precisely the information most easily
     * lost at the moment generation finishes.
     *
     * **The path is never accepted from the caller.** It takes an appid only, looks the path up in
     * the guides table itself, and passes it through `resolveGuidePath` (which forbids leaving
     * guidesDir). This is the one place in the project that launches an external process, and
     * letting the page supply the path would mean handing that process's arguments to the page
     */
    revealGuideFile(appid) {
      const row = getGuide(db, String(appid ?? '').trim());
      if (!row) return { error: msg('guide.none') };
      if (row.kind !== 'local') return { error: msg('guide.notLocal') };
      let path;
      try {
        path = resolveGuidePath(config.guidesDir, row.url);
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
      if (!existsSync(path)) return { error: msg('guide.fileGone', { path }) };
      return revealInFileManager(path);
    },

    /** Deletes the games row only; data for the same appid in achievements/guides stays, and is reused if it is added again */
    deleteGame(appid) {
      if (!getGame(db, appid)) return { error: msg('game.notFound') };
      dbDeleteGame(db, appid);
      return { deleted: true, appid: String(appid) };
    },

    /**
     * Which achievements are still locked for an appid. It prefers the definitions already synced
     * into the achievements table, falling back to a live GetSchemaForGame when the table has none.
     */
    async getMissingAchievements(appid) {
      const raw = await steam.fetchPlayerAchievements(appid);
      if (raw.retry) return { error: msg('steam.progressRetry') };
      if (raw.noAchievementSystem) return { error: msg('steam.noAchSystem') };

      const achievedSet = new Set(
        raw.achievements.filter((a) => a.achieved === 1).map((a) => a.apiname)
      );

      const cached = achievementsFor(db, appid);
      let defs;
      if (cached.length > 0) {
        const lang = normalizeUiLanguage(config.uiLanguage);
        defs = cached.map((a) => ({
          name: a.api_name,
          displayName: achievementName(a, lang),
          description: a.hidden ? msg('ach.hiddenDesc') : achievementDescription(a, lang),
          icon: a.icon,
        }));
      } else {
        // **config.language, not uiLanguage.** This branch has nothing stored to choose between,
        // so it is a fetch, and a fetch is the other key's business
        const schema = await steam.fetchAchievementSchema(appid, config.language);
        if (!schema?.length) return { error: msg('steam.noSchema') };
        defs = schema.map((d) => ({
          name: d.name,
          displayName: d.displayName || d.name,
          description: d.hidden === 1 ? msg('ach.hiddenDesc') : d.description || '',
          icon: d.hidden === 1 ? d.icongray || d.icon || '' : d.icon || '',
        }));
      }

      const missing = defs.filter((a) => !achievedSet.has(a.name));

      // What this achievement says in the user's own guide.
      //
      // The whole section **fails soft**: an expired Notion token, a deleted page or no network each
      // leave this layer with nothing to display, and must never take the "what is still missing"
      // panel down with them — the same rule as every guide action on the serve path.
      //
      // It is only attempted when the achievements table already has detail: the reverse lookup
      // reads api_name/name_cn/name_en/description, and the "fall back to a live schema" branch
      // above cannot produce that shape. Measured, this costs nothing — of the 50 games with a guide
      // and below 100%, all 50 have their achievement detail synced.
      // Stripping the echo needs the **raw row's** description, not the display one above: for a
      // hidden achievement the display value is the placeholder 「(隐藏成就,解锁前不显示描述)」.
      // In the raw row it is empty, so nothing matches and nothing is stripped — which is correct,
      // since for a hidden achievement that line in the guide is usually the only place on the whole
      // card stating the unlock condition
      const rowByApiName = new Map(cached.map((c) => [c.api_name, c]));
      const guideRow = getGuide(db, appid);
      let guideInfo = null;
      let guideByApiName = new Map();
      if (guideRow && cached.length > 0) {
        // `lang` is a **display** fact and nothing else — the panel marks a guide written in the
        // other language, and the rewrite dialog names what it is about to write. Matching never
        // reads it: stage 1 and the lint rule both accept either language's description, so a row
        // carrying the wrong value costs a marker, never a tick
        guideInfo = { url: toGuideHref(appid, guideRow.url), kind: guideRow.kind, lang: guideRow.lang || 'zh' };
        try {
          const backend = backendFor(guideRow, { notion: new NotionClient(config), config });
          guideByApiName = mapAchievementGuides(await backend.loadTodos(), cached);
        } catch (err) {
          guideInfo.error = msg('guide.unreadable', { reason: err.message });
        }
      }

      return {
        total: defs.length,
        missingCount: missing.length,
        // null = this game has no registered guide at all (or its achievement detail has not been
        // synced, in which case there is no way to judge whether the guide covers this entry, so
        // nothing is said rather than falsely claiming "the guide hasn't written this one")
        guide: guideInfo,
        missing: missing.map((a) => {
          const g = guideByApiName.get(a.name); // name in defs is the api_name
          const row = rowByApiName.get(a.name);
          return {
            name: a.displayName,
            description: a.description,
            icon: a.icon,
            guide: g
              ? {
                  // The card already shows the achievement name and description above, so the guide
                  // prose's opening echo of them is stripped — otherwise the same information is
                  // printed twice and the actual method is pushed out of the preview window
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
     * The Dashboard's 「立即同步」 button. It only starts the work and returns immediately — the
     * progress display and the automatic refresh afterwards are handled by lib/rpc.js's polling,
     * shared with the automatic sync at startup.
     *
     * "Already syncing" and "no credentials configured" are returned as business errors ({error})
     * rather than thrown: the frontend branches on result.error, and throwing would only become an
     * uninformative "request failed".
     */
    startSync() {
      const r = startBackgroundSync();
      return r.started ? { started: true } : { error: r.error };
    },

    /**
     * "Sync only if stale" — the difference from startSync is exactly the `syncStaleHours` gate.
     *
     * This one is for the launcher rather than the Dashboard: once the app lives in the tray the
     * process can run for days, while the `maybeAutoSync` in `startupJobs` fires only at server
     * startup, so "opening the app = checking whether the data is stale" no longer holds for a
     * resident process. The launcher calls this on window show to restore that trigger.
     *
     * **startSync cannot be used instead**: that one is for the manual button and deliberately
     * bypasses the freshness test (the click itself has answered "should we sync"). Using it as the
     * window-show hook would mean a full sync every time the window is brought forward.
     */
    maybeSync() {
      if (!maybeAutoSync) return { started: false, reason: 'unavailable' };
      return { started: maybeAutoSync() };
    },

    /** Added for the local build: the shim polls background sync progress with this */
    syncStatus: () => syncState.snapshot(),

    /**
     * First-time setup for the packaged build (the Electron launcher) — the GUI equivalent of
     * `node tracker.js init` (without --notion, which is handled separately). **Verify before
     * writing**: credentials that fail verification must not reach config.json, or the "redirect to
     * /setup when unconfigured" test at `/` would be satisfied by a non-empty but unusable value,
     * leaving the user on a Dashboard that looks configured and can never sync.
     *
     * **The verify-then-write order must not be simplified away** — a non-empty but unusable key
     * passes `/`'s redirect test, leaving the user on a Dashboard that looks configured and can
     * never sync.
     */
    async completeSetup(apiKey, steamId) {
      apiKey = String(apiKey ?? '').trim();
      steamId = String(steamId ?? '').trim();
      if (!apiKey || !steamId) return { error: msg('steam.bothFields') };
      if (!/^\d{17}$/.test(steamId)) return { error: msg('steam.badSteamId') };

      const probe = new SteamClient({ steamApiKey: apiKey, steamId, language: config.language });
      let games;
      try {
        games = await probe.fetchOwnedGames(false);
      } catch (err) {
        return { error: msg('steam.verifyFailed', { reason: err.message }) };
      }

      saveConfig({ steamApiKey: apiKey, steamId });
      // Writing to disk is not enough: the config and steam objects this process holds were built at
      // startup and do not follow a change to config.json — steam especially, since SteamClient's
      // constructor copies the key and steamId into its own instance fields (see lib/steam.js)
      // rather than keeping a reference to config.
      // Updating both here makes the current process usable immediately, with no child restart.
      config.steamApiKey = apiKey;
      config.steamId = steamId;
      steam.key = apiKey;
      steam.steamId = steamId;
      return { ok: true, gameCount: games.length };
    },

    /** Polled by Electron: is it configured yet, so it knows when to send the window back to the Dashboard (with no child restart) */
    getSetupStatus: () => ({ configured: Boolean(config.steamApiKey && config.steamId) }),

    /**
     * Read the current state when the settings page loads. **Secrets answer only "is one
     * configured" and are never returned** — nothing on the page needs to display one, and returning
     * it merely adds an exposure surface.
     * Non-secret values (the SteamID, the database ID) are pre-filled as normal, or changing one
     * field would require retyping the other.
     */
    getSettings: () => ({
      steamId: config.steamId || '',
      uiLanguage: normalizeUiLanguage(config.uiLanguage),
      hasSteamKey: Boolean(config.steamApiKey),
      notionDbId: config.notion?.overviewDbId || '',
      hasNotionToken: Boolean(config.notion?.token),
      aiProvider: config.ai?.provider || '',
      aiModel: config.ai?.model || '',
      hasAiKey: Boolean(config.ai?.apiKey),
      // Minutes, not raw ms — nothing about this field is naturally millisecond-scale to a
      // person typing it in. `?? 600000` mirrors the same default every provider file falls back
      // to, so the page shows the number actually in effect even when config.json is silent on it
      aiTimeoutMin: Math.round((config.ai?.requestTimeoutMs ?? 600000) / 60000),
      // **Per-vendor state.** With one set per vendor, "switch vendor" should no longer require
      // retyping a key, and the page can only draw that with this information: which vendors are
      // configured, and which model each has pinned.
      // **A key still answers only "is one configured"** and is never returned; model is not a
      // secret and is returned as-is.
      aiProviders: Object.fromEntries(
        Object.keys(AI_KEY_ENV).map((p) => [
          p,
          { hasKey: Boolean(resolveAiKey(config.ai, p)), model: config.ai?.providers?.[p]?.model || '' },
        ])
      ),
    }),

    /**
     * Configuration for AI guide generation, the GUI equivalent of `node tracker.js init --ai`.
     *
     * **Verification sends a real request** rather than checking the format. Every failure mode of
     * this feature requires a request to discover: an invalid key, a withdrawn model, a tier
     * allowance of 0, an endpoint rejecting a tool — none of them is visible from the string itself.
     * Costing a few cents on the settings page beats hitting it halfway through generating a guide.
     *
     * **An empty key means keep the stored one**, consistent with Steam and Notion. The settings
     * page pre-fills the provider and model, and if "empty key" meant "clear", then someone wanting
     * only to change the model and submitting in passing would wipe the key. To disable one, clear
     * that vendor's slot in config.json.
     *
     * **"The stored one" is per vendor.** This line used to read
     * `provider === config.ai?.provider ? config.ai?.apiKey : ''` — which had already worked out
     * that the previous vendor's key must not be reused, but with nowhere to store a second key,
     * switching vendor meant retyping. Now `ai.keys` has a slot per vendor and the same rule is
     * enforced centrally by `resolveAiKey`, so switching requires no retyping.
     *
     * Updating `config.ai` alone is sufficient — a provider object is constructed at each call site
     * (like NotionClient) rather than copying credentials into instance fields at construction the
     * way SteamClient does.
     */
    async saveAiConfig(provider, apiKey, model) {
      provider = String(provider ?? '').trim();
      apiKey = String(apiKey ?? '').trim();
      model = String(model ?? '').trim();
      if (!provider) return { error: msg('ai.noProvider') };

      const effective = apiKey || resolveAiKey(config.ai, provider) || '';
      if (!effective) return { error: msg('ai.noKey', { provider }) };

      // Stored under the **canonical** name: google and gemini are one vendor, and DeepSeek's two
      // endpoints share one set. Storing them as given would give one vendor two sets, and "but I
      // definitely entered it" is the hardest state of all to diagnose
      const canon = canonicalAiProvider(provider);
      const slot = { ...(config.ai?.providers?.[canon] ?? {}), apiKey: effective, model };
      const providers = { ...(config.ai?.providers ?? {}), [canon]: slot };
      const ai = { ...config.ai, provider, apiKey: effective, model, providers };
      let probe;
      try {
        probe = await createProvider({ ai });
      } catch (err) {
        return { error: String(err.message ?? err) };
      }

      try {
        const r = await probe.send({ messages: [{ role: 'user', content: '回复一个字:好' }] });
        const verdict = checkResult(r);
        if (!verdict.ok) return { error: msg('ai.verifyFailed', { reason: verdict.reason }) };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }

      config.ai = ai;
      // **What is written is the shape the process is holding, flat fields included.**
      //
      // `adoptLegacyAiFields` runs on every load: it moves a pre-`providers{}` file's flat
      // `ai.apiKey`/`ai.model`/`ai.baseUrl` into the slot of the provider that file names, and
      // clears the flat ones. That rewrite has always lived only in memory. Saving without it
      // leaves the flat key on disk while `provider` moves on, and it then belongs to nobody: the
      // previous vendor's key is unreachable — its adopted slot was never written — and the next
      // load clears it. The symptom is a key that has to be typed again although it was never
      // wrong, so writing them cleared is what makes the adoption real.
      //
      // `saveConfig`'s merge is recursive, so handing it the whole `providers` map merges each
      // vendor's set rather than replacing the map — saving Gemini cannot wipe Anthropic. The
      // in-memory map is a superset of the file's (load merges the file in, adoption only adds),
      // which is what makes handing over all of it safe rather than merely convenient.
      saveConfig({
        ai: {
          provider,
          ...Object.fromEntries(VENDOR_SCOPED_AI_FIELDS.map((f) => [f, ''])),
          providers,
        },
      });
      return { ok: true, provider: probe.name, model: probe.model, canSearch: probe.canSearch !== false };
    },

    /**
     * Just the request-timeout knob, split from `saveAiConfig` deliberately: that call sends a
     * real (paid) verification request on every save, and this is a pure latency setting someone
     * may want to change on its own — folding it in would mean paying to save a number. Shared
     * across all three vendors (`lib/ai-anthropic.js` / `ai-deepseek.js` / `ai-gemini.js` all read
     * `ai.requestTimeoutMs` the same way), so it stays a flat field, never per-provider.
     */
    saveAiTimeout(ms) {
      ms = Number(ms);
      if (!Number.isFinite(ms) || ms < 30000) return { error: msg('ai.timeoutTooLow') };
      if (ms > 3600000) return { error: msg('ai.timeoutTooHigh') };
      ms = Math.round(ms);
      config.ai = { ...config.ai, requestTimeoutMs: ms };
      saveConfig({ ai: { requestTimeoutMs: ms } });
      return { ok: true, minutes: Math.round(ms / 60000) };
    },

    /** Start generating a guide in the background. **The page must show a confirmation first** — this is the only action that costs money */
    // effort's value is not validated here: the tier names differ per vendor, and a hardcoded
    // allow-list would reject a legitimate value the day a vendor adds a tier. A wrong value becomes
    // a 400 from the vendor, and that path has its own dedicated hint
    // A non-empty `scope` = a partial rewrite (`{selector, note}`). **The server does not supply
    // overwrite for it** — a partial rewrite already requires an existing guide inside planPatch,
    // and that check is stricter than this boolean
    startGuideGen: (appid, overwrite, effort, scope) =>
      startGuideGen(String(appid), Boolean(overwrite), effort || null, scope || null),

    /**
     * Cancels a generation or partial rewrite in progress or still queued — see cancelGuideGen in
     * server.js for which of the two it turns out to be. `{cancelled: true}` on success, or
     * `{cancelled: false, error}` when the appid is neither running nor queued (see the narrow
     * claim/begin window documented there); either shape is a **successful call** by this file's
     * own contract (an `{error}` field is data, not a thrown failure) — the actual outcome always
     * arrives through the next `guideGenStatus` poll's `finished` entry, same as a normal run.
     */
    cancelGuideGen: (appid) => cancelGuideGen(String(appid)),

    /**
     * The preflight before rewriting an existing guide. **Read-only**, for the frontend's confirmation dialog.
     *
     * The same reasoning as `previewGuideToNotion`: a confirmation has to rest on knowing what will
     * be lost, and the one thing an overwrite genuinely destroys (hand-ticked sub-step boxes) is only
     * knowable by computing it.
     * It returns numbers, and the frontend composes the sentence — what is shared is the
     * computation, not the wording.
     */
    async previewGuideRewrite(appid) {
      try {
        return await planGuidePreflight(String(appid), { overwrite: true });
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * The preflight for a partial rewrite: how many entries each preset scope would change, and how
     * many boxes stay untouched.
     *
     * This and the one above are **two different questions**, hence two methods rather than one with
     * a parameter: a whole-guide rewrite asks "what will you lose", a partial one asks "what stays".
     * What is shared is the computation, not the wording — a rule this project has independently
     * reached on `inspectGuideDb` and on `previewGuideRewrite`
     */
    async previewGuidePatch(appid) {
      try {
        return await previewGuidePatch(String(appid));
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    guideGenStatus: () => guideGenState.snapshot(),

    /**
     * A local markdown guide → Notion.
     *
     * **Returns synchronously rather than as a background task.** Unlike guide-gen: there is no
     * model call here, only a few Notion requests (create the page, write the blocks, read back,
     * discover), a matter of seconds — and building a state machine, polling and a progress bar for
     * that buys nothing for the complexity.
     *
     * The two stages are separate because their failures mean different things: `preview` is
     * read-only, for the page's confirmation dialog, and only `migrate` writes. The frontend must
     * obtain the preview (especially `unconverted`) before asking the user, or the "confirm" is
     * clicked without knowing what will be lost.
     *
     * By rpc's contract, every refusal is returned as `{error}` — that is a **successful call**, and
     * the frontend inspects it.
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
     * Guide archives: listing, previewing, restoring and deleting the three archive directories
     * under `guides/`.
     *
     * **The listing carries no content.** A Notion backup is a block dump of a hundred-odd KB, and
     * all the listing needs is which game, when, and how large; the content is fetched separately
     * when 「看」 is clicked.
     *
     * Passing an appid returns only that game's, which is how the ⋯ menu on the Dashboard uses it;
     * omitting it returns everything, which the settings page uses to compute the total size and
     * find orphans.
     */
    listGuideArchives: (appid = null) => listArchives(db, config, { appid }),

    readGuideArchive(id) {
      try {
        return readArchive(config, id);
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * Restore. **Returns synchronously rather than as a background task** — the same reasoning as
     * moving to Notion: no model call, and even the slowest variant (delete a whole page and rewrite
     * it) is a few dozen Notion requests.
     */
    async restoreGuideArchive(id) {
      try {
        return await restoreArchive(db, { config, notion: new NotionClient(config), id });
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    deleteGuideArchive(id) {
      try {
        return deleteArchive(config, id);
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * The settings page's 「全部删除」. **It takes a list of ids, not "clear the directories"** — the
     * reasoning is at the top of `deleteArchives`: between the page being drawn and the click, a
     * background rewrite can store another one.
     *
     * The outer try is still needed: when `ids` is not iterable, `for...of` throws on the spot, and
     * that throw is outside the try inside the loop.
     */
    deleteGuideArchives(ids) {
      try {
        return deleteArchives(config, ids);
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * Set the language the interface is in. Writes `uiLanguage`, and **nothing else** — in
     * particular not `config.language`, which decides what Steam is asked for and is the reason
     * this is a separate key at all (see lib/lang.js).
     *
     * No network, no re-sync, nothing to invalidate: both languages are already on disk, so this is
     * a write and a re-render. `/setup` returns to `/` after every save, which is what makes that
     * re-render complete — nothing is left on screen in the previous language.
     */
    saveUiLanguage(lang) {
      lang = String(lang ?? '').trim();
      // Refused rather than normalised: a value that silently became 'zh' would read on screen as
      // the toggle having had no effect, and there is nothing to diagnose from that
      if (!UI_LANGUAGES.includes(lang)) return { error: msg('lang.unknown', { lang: lang || msg('lang.empty') }) };
      // The live object is what every reader consults, and the file is what survives a restart.
      // Both, or the setting lasts exactly one of the two
      config.uiLanguage = lang;
      // **lib/'s messages follow the same switch.** They are composed server-side from their own
      // table, so without this the interface changes language and every error stays in the old one
      setMessageLanguage(lang);
      saveConfig({ uiLanguage: lang });
      return { ok: true, uiLanguage: lang };
    },

    /**
     * Configuration for Notion guide sync, the GUI equivalent of `node tracker.js init --notion`.
     *
     * **The token and the database are validated and reported separately**, copied from the CLI:
     * the remedies are completely different — a wrong token means going back to the developer page
     * and copying it again, while an unreachable database means the connection was never added to
     * the page (Notion returns a 404, which looks like a mistyped ID). Merging them into one
     * "configuration failed" makes people retype a perfectly correct token repeatedly.
     *
     * **An empty token means keep the stored one**, consistent with the Steam API key rule. The
     * settings page pre-fills the database ID, and if "empty token" meant "clear", then someone
     * wanting only to change the SteamID and submitting in passing would wipe the Notion token —
     * changing one field must not destroy another.
     * To disable Notion sync, clear notion.token in config.json; the interface offers no such action.
     */
    async saveNotionConfig(token, dbId) {
      token = String(token ?? '').trim();
      dbId = String(dbId ?? '').trim();

      const effective = token || config.notion?.token || '';
      if (!effective) return { error: msg('notion.noToken') };
      token = effective;

      const probe = new NotionClient({ notion: { token, overviewDbId: dbId } });

      // **The schema is fully checked at the moment the database is connected.** Before this, only
      // two things were checked here: does the token work, and does this ID return any rows — with
      // the properties, types and status options not examined at all, deferred to the first real
      // write. So the user saw 「配好了」 on this page and hit "there is no 「XX」 option" days later
      // on the first guide-gen, by which time they no longer believed the problem lay in the setup.
      // In the same period `notion-check` checked nearly all of it, and this page simply never
      // called it — **the two paths checking different things is the shape of that class of bug**.
      // They now share inspectGuideDb, and neither can drift.
      //
      // The write probe (create a page and immediately archive it) is here too: a read-only
      // inspection cannot detect "this integration only has read permission", and that is another
      // fault that stays green all the way to a 403 at page creation.
      const verdict = await inspectGuideDb(probe, dbId, { probeWrite: Boolean(dbId) });
      if (verdict.problems.some((p) => p.code === DB_PROBLEM.BAD_TOKEN)) {
        return { error: msg('notion.tokenBad', { reason: verdict.problems[0].message.replace(/^token 不可用:/, '') }) };
      }
      const workspace = verdict.workspace ?? '';

      let pageCount = null;
      if (dbId) {
        const unreadable = verdict.problems.find((p) => p.code === DB_PROBLEM.DB_UNREADABLE);
        if (unreadable) {
          // **Both possibilities must be stated.** "A page ID was entered instead of a database ID"
          // and "the Connections step was skipped" report identically from Notion, and mentioning
          // only one sends someone who mistyped an ID off to check permissions repeatedly.
          return {
            error: msg('notion.dbUnreadable', {
              reason: unreadable.message,
              causes: unreadable.causes.map((c) => `  · ${c}`).join('\n'),
            }),
          };
        }
        pageCount = (await probe.queryGuideDatabase(dbId)).length;
      }

      saveConfig({ notion: { token, overviewDbId: dbId } });
      // NotionClient is constructed fresh at every call site (new NotionClient(config)), so updating
      // config.notion is sufficient and no instance fields need patching the way steam's do
      config.notion = { ...(config.notion ?? {}), token, overviewDbId: dbId };

      // **A schema problem does not block saving.** The ID itself is correct, and refusing to save
      // would waste the user's entry and make them retype it next time. The right thing is to store
      // it and hand over the problems together with their exact remedies
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
     * "Add the missing status options for me". **Always pressed by the user**, never silently
     * changing their database on save.
     *
     * Adding options is a purely additive operation (existing ones are carried over with their ids
     * and colours, appended to only), which is the precondition for it being allowed to write a
     * user's database at all — renaming or deleting someone's options is not, and Notion has no undo.
     *
     * Success is decided by `repairGuideDb`'s read-back rather than by the HTTP status: Notion has
     * form for silently ignoring status property edits (see the note above `repairGuideDb`), and
     * "reported success and changed nothing" is far harder to diagnose than "could not be fixed".
     */
    async repairNotionGuideDb() {
      const token = config.notion?.token;
      const dbId = config.notion?.overviewDbId;
      if (!token) return { error: msg('notion.noTokenSaved') };
      if (!dbId) return { error: msg('notion.noDbSaved') };

      const notion = new NotionClient(config);
      try {
        const r = await repairGuideDb(notion, dbId);
        if (r.reason === 'clobbered') {
          return { error: msg('notion.clobbered', { list: r.clobbered.join(' / ') }) };
        }
        if (r.reason === 'no-status-prop') {
          return { error: msg('notion.noStatusProp') };
        }
        if (r.reason === 'silently-ignored') {
          return {
            error: msg('notion.silentIgnore', {
              list: r.stillMissing.join(' / '),
              hint: r.type === 'status' ? msg('notion.statusHint') : '',
            }),
          };
        }
        // **regrouped / boardView have to travel back with the rest.** Without them the page can
        // only say something empty after a repair: an older database is missing no option, so
        // `added` is blank, and everything that actually happened lives in these fields.
        return {
          ok: true,
          added: r.added,
          regrouped: r.regrouped,
          boardView: r.boardView,
          colour: r.colour,
          wrongColour: r.wrongColour,
          property: r.property,
          type: r.type,
        };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * Step one of "create one for me": list the pages this integration can use as a parent.
     *
     * **No pages at all is not an error but a diagnosis** — it states precisely that the Connections
     * step has not been done, which cannot be inferred from a single error message shared with
     * "the ID is wrong".
     *
     * An empty token means use the stored one, consistent with the rest of this page.
     */
    async listNotionParents(token) {
      const effective = String(token ?? '').trim() || config.notion?.token || '';
      if (!effective) return { error: msg('notion.noToken') };
      try {
        const probe = new NotionClient({ notion: { token: effective } });
        const { pages, truncated } = await probe.searchPages();
        return { ok: true, pages, truncated };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * Step two of "create one for me": create the database under the selected page, **and store the
     * ID into the configuration directly**.
     *
     * Saving happens here rather than having the page fill it in and run `saveNotionConfig` again,
     * because the database already exists by this point — requiring the user to press save then
     * leaves anyone who forgets with "an empty database in Notion and a tool saying nothing is
     * configured", and that database gives no clue who created it. Created means recorded.
     */
    async createNotionGuideDb(token, parentPageId, title) {
      const effective = String(token ?? '').trim() || config.notion?.token || '';
      if (!effective) return { error: msg('notion.noToken') };
      if (!String(parentPageId ?? '').trim()) return { error: msg('notion.noParent') };
      // **Not permitted once a database is configured.** The ID this button stores would overwrite
      // the existing one, which means someone with a hundred guides could press it once and be
      // repointed at an empty database — not one guide lost, but all of them invisible to the tool,
      // with no sign of what happened. Genuinely changing database is "clear that field, save,
      // create", three explicit steps
      if (config.notion?.overviewDbId) {
        return { error: msg('notion.dbAlreadySet', { id: config.notion.overviewDbId }) };
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

    /**
     * Write the backup to disk, **returning the path rather than the file itself**.
     *
     * The interface offers no "click to download": `launcher/main.js` has no `will-download` handler,
     * so Electron falls back to its own native save dialog — and native dialogs are dead in this
     * program (see docs/self-update.md; `showMessageBox` returns 420 immediately). A download button
     * that does nothing when clicked is far worse than a path that can be copied. A revealBackup is
     * enough.
     */
    makeBackup({ includeConfig = true } = {}) {
      try {
        const dir = join(DATA_ROOT, 'backups');
        mkdirSync(dir, { recursive: true });
        const { zip, manifest } = createBackup({
          db,
          configPath: includeConfig ? CONFIG_PATH : null,
          guidesDir: config.guidesDir,
          appVersion,
        });
        const path = join(dir, backupName());
        writeFileSync(path, zip);
        return { ok: true, path, dir, manifest, sizeBytes: zip.length };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /** Locate the freshly made backup in the file manager. **The path must fall inside backups/** —
     *  this method is reachable directly through /api/ with an argument from outside, the same
     *  discipline as revealGuideFolder */
    revealBackup(path) {
      const dir = join(DATA_ROOT, 'backups');
      const full = resolve(String(path ?? ''));
      if (!isInside(dir, full)) return { error: msg('file.outsideBackups') };
      if (!existsSync(full)) return { error: msg('file.gone', { path: full }) };
      return revealInFileManager(full);
    },

    /** Look before acting: report what the backup contains, writing nothing to disk */
    inspectBackupFile(buf) {
      if (!Buffer.isBuffer(buf)) return { error: msg('file.notABuffer') };
      try {
        const { manifest, hasConfig, guideFiles } = inspectBackup(buf);
        return { ok: true, manifest, hasConfig, guideFiles: guideFiles.length, currentGames: countGames(db) };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },

    /**
     * Restore. After writing config.json, **the config and steam objects this process holds must
     * also be updated** — the same hazard as completeSetup: both were built at startup, and
     * SteamClient in particular copied the key and steamId into its own instance fields (see
     * lib/steam.js). Without updating them here, the user gets a program that reports a successful
     * restore while every Steam request uses the old credentials (or none).
     */
    applyRestore(buf, { keepConfig = false } = {}) {
      if (!Buffer.isBuffer(buf)) return { error: msg('file.notABuffer') };
      try {
        const r = applyBackup({
          db,
          buf,
          configPath: CONFIG_PATH,
          guidesDir: config.guidesDir,
          restoreConfig: !keepConfig,
        });
        if (r.config) {
          Object.assign(config, loadConfig());
          steam.key = config.steamApiKey;
          steam.steamId = config.steamId;
        }
        return { ok: true, ...r, configured: Boolean(config.steamApiKey && config.steamId) };
      } catch (err) {
        return { error: String(err.message ?? err) };
      }
    },
  };

  return api;
}
