/**
 * The sync engine: one pass over the whole library, in three phases
 * ------------------------------------------------
 * No cursor, no batching, no per-run time limit — the whole library in one pass.
 * A large library is simply slower, but there is no "where did we get to last time"
 * state to maintain, and therefore no "the sort order changed and the cursor moved"
 * class of problem. Ctrl+C mid-run is fine too: each game is committed on its own,
 * so re-running just redoes what was in flight.
 */
import {
  allGames, getGame, insertGame, setGameField, updateGameStats, markNoAchievements,
  markStatsChecked, appIdsWithAchievements, appIdsMissingEnglishDescriptions,
  replaceAchievements, setMeta, nowIso,
} from './db.js';
import { sleep } from './steam.js';

const DAY_MS = 86400000;

/** Sampling defaults. serve overrides them from config; omitting them means "check everything", see selectStatsTargets */
const SELECTION_DEFAULTS = {
  sweepBudget: 120,
  maxStatsAgeDays: 7,
  perfectGameMaxAgeDays: 3,
};

/**
 * Phase one: reconcile the Steam library against the local table.
 * - In the library, not local → insert (with a lookup for the best Chinese name)
 * - Local and currently *owned* → refresh the Unvetted stamp ('Manual' rows are left alone)
 * - Local but absent from the owned list (family-shared / delisted / hand-added) → status and
 *   stats left completely untouched. The test is "is it in the owned list", not what status says
 *
 * Every row additionally gets name_en, the English title the Dashboard's search matches alongside
 * the localised name. Owned rows take it from the owned-list response for free; the rest cost one
 * store call each, once.
 */
export async function syncLibrary(db, steam, { onProgress = () => {} } = {}) {
  const { games, unvettedAppIds, playSnapshot } = await steam.fetchOwnedGamesWithUnvettedFlag();
  const localRows = allGames(db);
  const existing = new Set(localRows.map((g) => g.appid));

  const added = [];
  let restamped = 0;
  let namedEn = 0;

  for (const g of games) {
    const appid = String(g.appid);
    const isUnvetted = unvettedAppIds.has(appid);

    if (!existing.has(appid)) {
      onProgress({ phase: 'library', name: g.name, added: added.length + 1 });
      const best = (await steam.fetchAppName(appid)) || g.name;
      insertGame(db, { appid, name: best, nameEn: g.name, status: isUnvetted ? 'Unvetted' : '' });
      added.push({ appid, name: best });
      await sleep(steam.storeDelay); // fetchAppName goes to the store endpoint, not the Web API
      continue;
    }

    // Owned rows: keep the Unvetted stamp in step with Steam's current verdict, but never touch a manual 'Manual' lock
    const row = getGame(db, appid);
    const want = isUnvetted ? 'Unvetted' : '';
    if (row.status !== 'Manual' && row.status !== want) {
      setGameField(db, appid, 'status', want);
      restamped++;
    }
    // **GetOwnedGames ignores `l=` and answers in English either way**, so g.name is the English
    // title and it is already here — the whole owned library gets one, in a response already being
    // received, with no store call at all. name itself is never touched: fetchAppName deliberately
    // chose the localised title for it, and this is the other column
    if (g.name && row.name_en !== g.name) {
      setGameField(db, appid, 'name_en', g.name);
      namedEn++;
    }
  }

  // Rows the owned list never mentions (family-shared, delisted, hand-added) are skipped by the
  // loop above entirely, so their English title has to be asked for — one appdetails call each,
  // paced like every other store call.
  //
  // **Self-limiting rather than budgeted**: a row that answers is never a candidate again. What
  // keeps coming back is a row with no store page left at all, and that is one call per sync.
  // Note it does not have to answer in Latin script — a game published only in Japanese answers
  // with its Japanese title under l=english, and recording that is what stops it being asked again
  const ownedIds = new Set(games.map((g) => String(g.appid)));
  const missingEn = localRows.filter((r) => !ownedIds.has(r.appid) && !r.name_en);
  for (const [i, r] of missingEn.entries()) {
    onProgress({ phase: 'library-en', done: i + 1, total: missingEn.length, name: r.name });
    const en = await steam.fetchAppNameEn(r.appid);
    if (en) {
      setGameField(db, r.appid, 'name_en', en);
      namedEn++;
    }
    await sleep(steam.storeDelay); // appdetails is the store endpoint, not the Web API
  }

  return { ownedCount: games.length, unvettedCount: unvettedAppIds.size, added, restamped, namedEn, playSnapshot };
}

/**
 * Which rows phase two checks. **achieved and total change for different reasons**,
 * and that is where the whole sampling design starts:
 * - achieved is a fact about *you*; it cannot change unless you played → gating on
 *   rtime_last_played is correct for it
 * - total is a fact about *the game*; a developer patch changes it with no play
 *   involved → it must not be gated that way
 *
 * So the union of three groups:
 * 1. played — rtime_last_played is newer than what we last recorded. This group is
 *    what keeps achieved exact
 * 2. unowned — rows absent from the owned list (family-shared / delisted / hand-added).
 *    There is no rtime for them at all, so they are checked every run. CLAUDE.md records
 *    it: a game can vanish from GetOwnedGames while its achievement data keeps working,
 *    so they must not be frozen out.
 *    **But unowned rows already at 100% go to sweep instead** — see the reasoning at isPerfect
 * 3. sweep — the oldest stats_checked_at rows in rotation, which is what catches a
 *    developer changing total. Capped per run, with the rest picked up next time; being
 *    away for a while never turns into one sudden two-minute full pass
 *
 * Perfect games (rate=1) get a shorter expiry: more achievements drops them below 100%,
 * and that is exactly the event you most want to hear about promptly. They are also a
 * double blind spot — syncAchievementSchema deliberately skips rate=1, so those games have
 * no achievement detail either, and this periodic re-check is the only thing that notices.
 *
 * With no playSnapshot (running syncAchievementStats alone, or the CLI's full sync) →
 * check everything, keeping one entry point that provably misses nothing.
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

  // **Both conditions must hold to count as 100%, not rate alone.** This is a *skip*
  // decision, and the two error directions are not symmetric: if rate is stale while the
  // game is not actually complete, testing rate alone freezes a still-moving achieved for
  // three days (selection.test.js exists precisely because "skipping a row silently freezes
  // a number"); the other way round, a disagreement just leaves it in unowned and costs a
  // few extra requests. So take the stricter side.
  const isPerfect = (g) => g.rate === 1 && typeof g.total === 'number' && g.total > 0 && g.achieved === g.total;

  const played = [];
  const unowned = [];
  const sweepPool = [];

  for (const g of rows) {
    if (!playSnapshot.has(g.appid)) {
      // A 100% unowned row need not be checked every run. **The rtime gate exists to protect
      // the accuracy of achieved, and once achieved is at the ceiling it can only stay there**
      // — no amount of further play raises it. The only thing left that can move is total
      // (a developer adding achievements), which is exactly sweep's job, and
      // perfectGameMaxAgeDays (3 days) was tuned for "new achievements drop it below 100%".
      // The owned copy of the same game already took this route (it lands in sweepPool below),
      // while the unowned one was checked every run purely because it has no rtime — and for
      // a fully completed row, rtime is precisely the input that does not matter.
      // With stats_checked_at null, ageDays is Infinity, so it still enters the pool and sorts
      // first; nothing is missed.
      if (isPerfect(g)) {
        if (ageDays(g.stats_checked_at) >= maxAge(g)) sweepPool.push(g);
        continue;
      }
      unowned.push(g);
      continue;
    }
    // A row with no baseline must be checked: with no last_played there is nothing to compare
    // against, and skipping would be guesswork. The first run after upgrading is therefore a
    // full pass (fast only afterwards), which is intended — the baseline has to exist first.
    const rtime = playSnapshot.get(g.appid);
    if (g.stats_checked_at == null || g.last_played == null || rtime > g.last_played) {
      played.push(g);
      continue;
    }
    if (ageDays(g.stats_checked_at) >= maxAge(g)) sweepPool.push(g);
  }

  // Sort by "how overdue", not by absolute age. The two are not equivalent here: perfect games
  // expire in 3 days and ordinary ones in 7, so comparing raw age lets an 8-day-old ordinary
  // game jump ahead of a 4-day-old perfect one, which makes the shorter deadline pointless.
  // Divided by their own deadlines, 4/3 correctly sorts ahead of 8/7.
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
 * Phase two: refresh each game's achievement completion counts (formerly runBatch, minus the cursor).
 * sync_locked rows are skipped (the hand-maintained ones, where an automatic sync would
 * overwrite the numbers a person typed).
 * Which rows get checked is selectStatsTargets' decision; the rules are in its comment.
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
  // The appids whose achieved or total genuinely moved this run. serve's automatic checkbox
  // sync visits only these rows, not the whole candidate set — a full pass is 40-odd Notion
  // page reads plus 40-odd Steam calls, and on the vast majority of Dashboard opens not a
  // single box changes.
  const changedAppids = [];

  for (const [i, g] of targets.entries()) {
    onProgress({ phase: 'achievements', done: i + 1, total: targets.length, name: g.name });

    if (!g.name) {
      const official = await steam.fetchAppName(g.appid);
      if (official) setGameField(db, g.appid, 'name', official);
      await sleep(steam.storeDelay); // as above: the store endpoint
    }

    // Rows with no rtime (not in the owned list) pass null, and markStatsChecked keeps the old value
    const rtime = playSnapshot?.get(g.appid) ?? null;

    const res = await steam.fetchAchievementStats(g.appid);
    if (res.noAchievementSystem) {
      markNoAchievements(db, g.appid);
      markStatsChecked(db, g.appid, rtime);
      noSystem++;
    } else if (res.retry) {
      retried++; // Leave it for next time and write nothing — **including no stats_checked_at**.
                 // Recording it would mark this row as just-checked, so the next run skips it,
                 // and rate limiting quietly turns into lost data
    } else {
      const { bumped: didBump, gained } = updateGameStats(db, g.appid, res);
      if (didBump) bumped.push(g.name || g.appid);
      // A rise in total counts too: achievements added by a patch often already have a box
      // written in the guide, just not ticked
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
 * Phase three: achievement detail (Chinese/English names and descriptions, icons) → the
 * achievements table. Which games it visits, and why each gate is where it is, is in
 * selectSchemaTargets; games confirmed to have no achievement system are never visited.
 */
/**
 * Fetch one game's achievement detail into the achievements table. Returns false when there is
 * nothing to fetch (that game has no schema).
 *
 * **This is a separate function because there is a second caller: guide generation.** The two
 * classes of game the batch sync skips (100% complete, and just added and not yet reached by a
 * sync) are exactly the two a user runs into when pressing 「生成攻略」 — that path needs to fill
 * in **just this one**, rather than making someone run a full library sync first.
 * Two separate copies of "fetch a schema" would eventually diverge on field mapping (hidden
 * achievements already have their own handling for description and icon).
 */
export async function fetchGameSchema(db, steam, game) {
  const cn = await steam.fetchAchievementSchema(game.appid, 'schinese');
  if (!cn?.length) return false;
  await sleep(steam.delay);
  const en = (await steam.fetchAchievementSchema(game.appid, 'english')) ?? [];
  const enByApiName = Object.fromEntries(en.map((a) => [a.name, a]));

  // **Steam's description is sometimes whitespace and nothing else** (Factorio's 咸鱼翻身 is a single
  // space). Stored as it comes it is truthy everywhere and empty everywhere it is compared, so it
  // reads as "this achievement has a description" while offering nothing to quote. That is the same
  // thing as having no description, and it gets stored as no description. Rows already written this
  // way stay until their game's schema is synced again, so the matcher guards it too
  const desc = (raw) => (String(raw ?? '').trim() ? raw : '');

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
        description: hidden ? '' : desc(a.description),
        // The English schema was already fetched two lines up for the name, so its description
        // comes free and is stored as well. Same '' for a hidden achievement, for the same reason:
        // the description is the spoiler, in either language
        descriptionEn: hidden ? '' : desc(enByApiName[a.name]?.description),
        hidden,
        icon: hidden ? a.icongray || a.icon || '' : a.icon || '',
      };
    })
  );
  return true;
}

/**
 * Which rows phase three fetches. Three reasons to fetch, and they are not equally gated:
 *
 * 1. **No detail stored yet** — the ordinary case.
 * 2. **The total rose within the last 7 days** — a game update added achievements.
 * 3. **The stored detail predates description_en** — every achievement carries a Chinese
 *    description and none carries an English one.
 *
 * The first two are skipped for a game at 100%: it needs no checklist, so refreshing its detail
 * buys nothing. **The third is not**, and deliberately: the description is shown in the achievement
 * panel whether or not the game is finished, and on a library that has been played a while the
 * completed games are most of it — gating this the same way would leave the majority of the
 * library with English names above Chinese descriptions, which is the exact state this column
 * exists to prevent. It costs one pass per game, once.
 */
export function selectSchemaTargets(db) {
  const known = appIdsWithAchievements(db);
  const missingEn = appIdsMissingEnglishDescriptions(db);
  return allGames(db).filter((g) => {
    if (g.has_achievements === 0) return false;
    if (missingEn.has(g.appid)) return true;
    if (g.rate === 1) return false;
    const recentlyUpdated =
      g.new_ach_date && Date.now() - new Date(g.new_ach_date).getTime() < 7 * DAY_MS;
    return recentlyUpdated || !known.has(g.appid);
  });
}

export async function syncAchievementSchema(db, steam, { onProgress = () => {} } = {}) {
  const targets = selectSchemaTargets(db);

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
 * Run the three phases in order and record the finish time (serve uses it to judge data freshness).
 *
 * Phase two's sampling is enabled only when selection is passed (which is what opening the
 * Dashboard through serve does); without it the behaviour is the old one — check the entire
 * library. The CLI's `sync` deliberately stays the latter: there has to be one entry point that
 * provably misses nothing, and `sync --fast` is the one that samples per config.
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
 * AGCR (Average Game Completion Rate), by the algorithm documented on the Steam community:
 * count only games with at least 1 achievement unlocked, weight every game equally as an
 * arithmetic mean, and exclude Unvetted ones.
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
