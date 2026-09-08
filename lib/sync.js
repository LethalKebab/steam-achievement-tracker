/**
 * The sync engine: one pass over the whole library, in five phases
 * ------------------------------------------------
 * No cursor, no batching, no per-run time limit — the whole library in one pass.
 * A large library is simply slower, but there is no "where did we get to last time"
 * state to maintain, and therefore no "the sort order changed and the cursor moved"
 * class of problem. Ctrl+C mid-run is fine too: each game is committed on its own,
 * so re-running just redoes what was in flight.
 *
 * Phases four and five differ from the first three in one way worth knowing: they are about
 * **what finishing a game would cost**, not what the account has done, so they visit only
 * unfinished games and they cache hard. Rarity is re-asked monthly and HowLongToBeat ids are
 * resolved once per game for as long as the game exists.
 */
import {
  allGames, getGame, insertGame, setGameField, updateGameStats, markNoAchievements,
  markStatsChecked, appIdsWithAchievements, appIdsMissingEnglishDescriptions, recordUnownedPlaytime,
  replaceAchievements, setMeta, nowIso, setAchievementUnlocks, setAchievementRarity,
  allHltb, upsertHltb,
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
  let familyCleared = 0;

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

    // **Arriving in GetOwnedGames clears the family flag.** The badge means "not bought by me", and
    // a game bought after being played through the family library contradicts it — while nothing
    // else would ever take it off, the flag being written only by `addGame` and by the badge itself.
    // Guarded on the current value rather than written unconditionally: `setGameField` moves
    // `updated_at`, and a row already at 0 has nothing to say.
    //
    // The cost is a **gift**, which is equally owned and equally not self-purchased, so it loses the
    // badge here and has to be re-marked by hand. `GetOwnedGames` cannot tell the two apart — it
    // reports the licence, not how it was acquired — and the shared-library case is the one that
    // actually accumulates stale flags.
    if (row.family) {
      setGameField(db, appid, 'family', 0);
      familyCleared++;
    }

    // **The stand-in goes when the real thing arrives.** `playtime_forever` exists only to date a
    // row that has no `rtime_last_played`; this row now has one, and leaving the column set is the
    // same defect the badge above just lost — a value whose meaning is "there is no rtime here"
    // sitting on a row where there is. Nothing reads it for an owned row today, which is exactly
    // why it would go unnoticed. Not counted: a badge disappearing is something the user sees, a
    // column nobody reads is not, and the library line has to stay readable.
    if (row.playtime_forever !== null) setGameField(db, appid, 'playtime_forever', null);
  }

  // ---- The family library, as far as the Web API can see it ----
  //
  // **`GetRecentlyPlayedGames` is the only key-authenticated endpoint that lists a shared game.**
  // A title absent from `GetOwnedGames` appears there as soon as it is played, which is what lets
  // this run unattended; the family-group interface sees the whole shared library but takes a
  // browser token good for about a day, so nothing on a timer can use it.
  //
  // Two things happen here and they are deliberately not the same one:
  // - a played game **not in the table** is added, flagged `family` because "recently played and
  //   not in `GetOwnedGames`" is exactly what that flag means. It is added rather than offered:
  //   the row is local, visible and deletable, and an offer nobody sees is a game that never gets
  //   tracked. **A row deleted by hand and still being played comes back** — hide it instead,
  //   which is what `hidden` is for.
  // - a game **already in the table** has its playtime compared, which is the only way these rows
  //   can ever get a `last_played` (see `recordUnownedPlaytime`).
  //
  // Owned appids are skipped outright: they take their timestamp from `playSnapshot`, and a second
  // source for one fact is a disagreement waiting to happen.
  const recent = await steam.fetchRecentlyPlayedGames();
  const familyAdded = [];
  let familyPlayed = 0;
  // **A failed request and a quiet fortnight must not report the same thing.** Both leave the two
  // counters at zero, so without this flag a throttled key reads as "nothing new" on every run
  // forever — the shape of silence this project keeps paying for elsewhere. `steam.js` already
  // logs the reason; this is what lets a caller say the check did not happen.
  const familyChecked = recent !== null;
  if (recent) {
    const ownedNow = new Set(games.map((g) => String(g.appid)));
    for (const g of recent) {
      const appid = String(g.appid);
      if (ownedNow.has(appid)) continue;
      if (!existing.has(appid)) {
        onProgress({ phase: 'library-family', name: g.name, added: familyAdded.length + 1 });
        // Same shape as the owned insert above: the response carries the canonical (English)
        // title, and the localised one still costs one store call
        const best = (await steam.fetchAppName(appid)) || g.name;
        insertGame(db, { appid, name: best, nameEn: g.name, family: 1 });
        familyAdded.push({ appid, name: best });
        await sleep(steam.storeDelay);
      }
      // **A missing playtime is not a reading of zero.** Recording 0 puts a baseline on the row,
      // and the next real number then reads as growth against it — a play event invented out of
      // the field's absence, which is the one thing the first-observation rule exists to prevent.
      if (g.playtime_forever == null) continue;
      // A row inserted a line ago has no baseline, so this records one and stamps nothing
      if (recordUnownedPlaytime(db, appid, Number(g.playtime_forever))) familyPlayed++;
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

  return { ownedCount: games.length, unvettedCount: unvettedAppIds.size, added, restamped, namedEn, familyCleared, familyAdded, familyPlayed, familyChecked, playSnapshot };
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
  // Rows Steam refuses outright — named rather than folded into `retried`, since one is
  // "ask again later" and the other is "this will never answer again"
  const forbidden = [];
  // The appids whose achieved or total genuinely moved this run. serve's automatic checkbox
  // sync visits only these rows, not the whole candidate set — a full pass is 40-odd Notion
  // page reads plus 40-odd Steam calls, and on the vast majority of Dashboard opens not a
  // single box changes.
  const changedAppids = [];
  // appid → the api_names this account holds, handed to the schema phase so a game whose detail
  // is being fetched for the first time gets its unlock flags in the same run rather than the next
  const unlocks = new Map();

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
      // **A 403 is counted here as well and must stay that way.** It is reported separately because
      // it will never succeed, but writing `stats_checked_at` for it would be the same defect the
      // line above exists to prevent — and the row can start answering again the moment a licence
      // comes back, which nothing here would notice if it had been stamped as checked.
      if (res.forbidden) forbidden.push(g.name || g.appid);
    } else {
      const { bumped: didBump, gained } = updateGameStats(db, g.appid, res);
      if (didBump) bumped.push(g.name || g.appid);
      // A rise in total counts too: achievements added by a patch often already have a box
      // written in the guide, just not ticked
      if (didBump || gained) changedAppids.push(g.appid);
      // Which ones, not just how many. Writing it here reaches every row that already exists;
      // a game whose detail has never been fetched has no rows to update yet, which is why the
      // set is also carried out of this phase for the schema phase to apply once it makes them
      if (res.unlocked) {
        unlocks.set(g.appid, res.unlocked);
        setAchievementUnlocks(db, g.appid, res.unlocked);
      }
      markStatsChecked(db, g.appid, rtime);
      updated++;
    }
    await sleep(steam.delay);
  }

  return {
    updated, noSystem, retried, bumped, forbidden, changedAppids, unlocks,
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

export async function syncAchievementSchema(db, steam, { onProgress = () => {}, unlocks = null } = {}) {
  const targets = selectSchemaTargets(db);

  let processed = 0;
  let skippedNoSchema = 0;

  for (const [i, g] of targets.entries()) {
    onProgress({ phase: 'schema', done: i + 1, total: targets.length, name: g.name });

    if (await fetchGameSchema(db, steam, g)) {
      processed++;
      // The rows exist only now. Phase two saw this account's unlock flags but had nothing to
      // write them to, so they are applied here — otherwise a game's first appearance would
      // show a completion count with no idea which achievements it refers to until the next sync
      const held = unlocks?.get(g.appid);
      if (held) setAchievementUnlocks(db, g.appid, held);
    } else skippedNoSchema++;
    await sleep(steam.delay);
  }

  return { processed, skippedNoSchema, candidates: targets.length };
}

/**
 * How rare each achievement is, globally.
 *
 * One request per game, and the answer barely moves — a percentage computed across every owner
 * shifts by fractions over months — so a game that has been asked within RARITY_STALE_DAYS is
 * skipped. Finished games are skipped outright: rarity exists to say what is still in the way,
 * and nothing is.
 */
const RARITY_STALE_DAYS = 30;

export function selectRarityTargets(db) {
  const cutoff = Date.now() - RARITY_STALE_DAYS * DAY_MS;
  const checked = new Map(
    db
      .prepare('SELECT appid, MAX(rarity_checked_at) AS at FROM achievements GROUP BY appid')
      .all()
      .map((r) => [r.appid, r.at])
  );
  return allGames(db).filter((g) => {
    if (g.has_achievements === 0 || !g.total) return false;
    if (g.rate === 1) return false;
    const at = checked.get(g.appid);
    return !at || new Date(at).getTime() < cutoff;
  });
}

export async function syncAchievementRarity(db, steam, { onProgress = () => {} } = {}) {
  const targets = selectRarityTargets(db);
  let processed = 0;
  let missing = 0;

  for (const [i, g] of targets.entries()) {
    onProgress({ phase: 'rarity', done: i + 1, total: targets.length, name: g.name });
    const pct = await steam.fetchGlobalAchievementPercentages(g.appid);
    // Steam publishes nothing for some games. Not an error and not worth retrying next run —
    // but nothing is stamped either, so it is re-asked after the stale window like everything else
    if (pct) {
      setAchievementRarity(db, g.appid, pct);
      processed++;
    } else missing++;
    await sleep(steam.delay);
  }

  return { processed, missing, candidates: targets.length };
}

/**
 * How long each unfinished game takes to finish, from HowLongToBeat.
 *
 * Two different jobs, and the cheap one is the common one:
 *
 * - **Resolving** an appid to an HLTB id costs a search plus up to three page fetches, and is
 *   done **once per game, ever**. A miss is recorded as a miss so it is not retried.
 * - **Refreshing** the hours for an already-resolved id is a single page fetch, and is done only
 *   after HLTB_STALE_DAYS.
 *
 * Finished games are skipped: there is nothing left to cost. That also keeps the first run
 * proportional to the backlog rather than to the whole library.
 */
const HLTB_STALE_DAYS = 30;

export function selectHltbTargets(db) {
  const cutoff = Date.now() - HLTB_STALE_DAYS * DAY_MS;
  const known = new Map(allHltb(db).map((r) => [r.appid, r]));
  const resolve = [];
  const refresh = [];
  for (const g of allGames(db)) {
    if (g.has_achievements === 0 || !g.total) continue;
    if (g.rate === 1) continue;
    const row = known.get(g.appid);
    if (!row) { resolve.push(g); continue; }
    // Searched before and found nothing. Asking again would repeat four queries for an answer
    // that has already been given; a reader who disagrees pins the id by hand
    if (!row.hltb_id) continue;
    if (!row.checked_at || new Date(row.checked_at).getTime() < cutoff) refresh.push({ g, row });
  }
  return { resolve, refresh };
}

export async function syncHltb(db, hltb, { onProgress = () => {} } = {}) {
  const { resolve, refresh } = selectHltbTargets(db);
  const total = resolve.length + refresh.length;
  let resolved = 0;
  let notFound = 0;
  let refreshed = 0;
  let done = 0;

  for (const g of resolve) {
    onProgress({ phase: 'hltb', done: ++done, total, name: g.name });
    const hit = await hltb.resolve({ appid: g.appid, nameEn: g.name_en, name: g.name });
    // Written either way — a recorded miss is what stops this search happening again
    upsertHltb(db, g.appid, hit.verified ? hit : {});
    if (hit.verified) resolved++;
    else notFound++;
  }

  for (const { g, row } of refresh) {
    onProgress({ phase: 'hltb', done: ++done, total, name: g.name });
    const hit = await hltb.refresh(row.hltb_id);
    // A failed refresh leaves the previous figures in place and no stamp, so it is tried again
    // next run. Overwriting good hours with nothing because a page timed out helps no one
    if (hit) {
      upsertHltb(db, g.appid, { ...hit, hltbId: row.hltb_id, manual: row.manual });
      refreshed++;
    }
  }

  return { resolved, notFound, refreshed, candidates: total };
}

/**
 * Run the three phases in order and record the finish time (serve uses it to judge data freshness).
 *
 * Phase two's sampling is enabled only when selection is passed (which is what opening the
 * Dashboard through serve does); without it the behaviour is the old one — check the entire
 * library. The CLI's `sync` deliberately stays the latter: there has to be one entry point that
 * provably misses nothing, and `sync --fast` is the one that samples per config.
 */
export async function fullSync(db, steam, { onProgress = () => {}, selection = null, hltb = null } = {}) {
  const library = await syncLibrary(db, steam, { onProgress });
  const stats = await syncAchievementStats(db, steam, {
    onProgress,
    playSnapshot: selection ? library.playSnapshot : null,
    selection: selection ?? {},
  });
  const schema = await syncAchievementSchema(db, steam, { onProgress, unlocks: stats.unlocks });
  const rarity = await syncAchievementRarity(db, steam, { onProgress });
  // **Only when a client was supplied.** HowLongToBeat is a third party the tracker has no
  // account with, and a reader who would rather not talk to it turns it off in config; passing
  // no client is how that arrives here, and it must leave the first three phases untouched
  const hours = hltb ? await syncHltb(db, hltb, { onProgress }) : null;
  setMeta(db, 'last_sync', nowIso());
  return { library, stats, schema, rarity, hours };
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
