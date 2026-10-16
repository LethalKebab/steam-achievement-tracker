/**
 * Achievement sets: reading Steam's replies, choosing what a player is shown, and what is counted
 * ------------------------------------------------
 * A developer can split a game's achievements into **sets** — the base game, a mode, a character,
 * each DLC — and Steam shows each with its own progress. Steam's own name for a set is `group`
 * (`groupid`, `dlcappid`), and the Chinese interface calls it 「集合」.
 *
 * Two replies carry them, both from `IPlayerService`:
 *
 * - `GetGameAchievements` — public, no key. Every set of the game with its name, its size and the
 *   DLC it belongs to. **A game without sets answers with exactly one group, id 0, holding
 *   everything**, so "has sets" is "has more than one group", not "has any".
 * - `GetUserAchievements` — one account. The sets **this account can earn**, with how far along
 *   each is. **A DLC set the account cannot play is left out of the reply rather than flagged**, so
 *   absence is the fact, and `buildSetRows` records it as such.
 *
 * The three endpoints `lib/steam.js` used before (`GetPlayerAchievements`, `GetSchemaForGame`,
 * `GetGlobalAchievementPercentagesForApp`) still answer one flat list with no trace of a set, which
 * is why none of this can be recovered from them.
 *
 * Everything here is pure: no network and no database, so every way a reply can be shaped, and every
 * rule about what is drawn or counted, is testable without either.
 */

/**
 * What a reply may carry, and nothing past it. Steam sends these as 32-bit integers, so a value
 * beyond that is not Steam's. **The bound is the database's, not only a tidy one**: `node:sqlite`
 * stores an integer of 2^53 or more without complaint and then throws when it is read back, and the
 * Dashboard reads every set of the library in one query — so a single such value in one reply would
 * stop the page loading for every game until that game was read again.
 */
const MAX_UINT = 0xffffffff;
const MAX_INT = 0x7fffffff;
/** Steam documents 40 sets to a game. This is five times that: a guard against a broken reply, not a rule about games */
const MAX_SETS = 200;
const MAX_NAME = 200;

const isId = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_UINT;
const count = (n) => (Number.isSafeInteger(n) && n > 0 && n <= MAX_UINT ? n : 0);
const text = (s) => (typeof s === 'string' ? s.trim().slice(0, MAX_NAME) : '');

/**
 * `GetGameAchievements` → the game's sets, or null when the reply is not one.
 *
 * **Null and an empty list are different answers.** Null is "this was not a usable reply"; an empty
 * list is a reply that names no set at all. This function reports each faithfully and decides
 * nothing about them — the sync treats the second as a glitch rather than as "no sets", because a
 * game with achievements always answers at least its base group.
 *
 * Steam's JSON drops fields it considers default, so nothing here is hidden on a field's absence:
 * `visible` is false only when the reply says the set is not public or is the developer's alone.
 * When `completion_achievements` is missing the whole set is what completes it — true until an
 * achievement is archived, and the field is there whenever one is.
 *
 * A group id repeated in one reply keeps its first entry: the id is the primary key it is stored
 * under, and a second row for it would fail the whole write.
 *
 * @returns {{ sets: Array<{ id: number, name: string, dlcAppid: string|null, position: number,
 *   total: number, need: number, archived: boolean, visible: boolean }> } | null}
 */
export function parseGameSets(body) {
  const r = body?.response;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (r.groups !== undefined && !Array.isArray(r.groups)) return null;

  const seen = new Set();
  const sets = [];
  for (const g of (r.groups ?? []).slice(0, MAX_SETS)) {
    if (!g || typeof g !== 'object' || !isId(g.groupid) || seen.has(g.groupid)) continue;
    seen.add(g.groupid);
    const total = count(g.total_achievements);
    sets.push({
      id: g.groupid,
      name: text(g.localized_name),
      // 0 means "not a DLC set". An appid stays a string, like every other one in this program
      dlcAppid: isId(g.dlcappid) && g.dlcappid > 0 ? String(g.dlcappid) : null,
      position: Number.isSafeInteger(g.order) && Math.abs(g.order) <= MAX_INT ? g.order : 0,
      total,
      need: isId(g.completion_achievements) ? g.completion_achievements : total,
      archived: g.archived === true,
      visible: g.ispublic !== false && g.developeronly !== true,
    });
  }
  return { sets };
}

/**
 * `GetUserAchievements` → this account's progress by set id, or null when the reply is not one.
 *
 * **A reply with no list of groups is null, never an empty map.** An empty map is read downstream as
 * "this account can earn none of these", and writing that over a game's sets because a reply was
 * malformed would erase the one fact this call exists to record. A list that is present and empty is
 * an answer.
 *
 * @returns {Map<number, { achievable: boolean, done: number, completed: boolean, completedAt: number|null }> | null}
 *   `completedAt` is Steam's own unix seconds
 */
export function parseUserSets(body) {
  const groups = body?.response?.groups;
  if (!Array.isArray(groups)) return null;

  const out = new Map();
  for (const g of groups.slice(0, MAX_SETS)) {
    if (!g || typeof g !== 'object' || !isId(g.groupid) || out.has(g.groupid)) continue;
    out.set(g.groupid, {
      achievable: g.is_achievable === true,
      done: count(g.completed_achievements),
      completed: g.is_completed === true,
      // 0 is "not completed yet", never a date in 1970
      completedAt: isId(g.time_completed) && g.time_completed > 0 ? g.time_completed : null,
    });
  }
  return out;
}

/**
 * The rows to store for one game: the English reply's structure, the Chinese reply's names, and this
 * account's progress.
 *
 * The structure comes from one reply, so a set that only the other language names is not invented.
 * **A set absent from the account's answer is one it cannot earn** — not unknown, and not zero
 * progress — and is stored as exactly that. The caller passes a progress map only when it has a real
 * reply (`parseUserSets` returned one), which is what makes the absence mean something.
 */
export function buildSetRows({ en, cn = [], progress }) {
  const cnName = new Map(cn.map((s) => [s.id, s.name]));
  return en.map((s) => {
    const p = progress.get(s.id);
    return {
      setId: s.id,
      nameEn: s.name,
      nameCn: cnName.get(s.id) ?? '',
      dlcAppid: s.dlcAppid,
      position: s.position,
      total: s.total,
      need: s.need,
      archived: s.archived,
      visible: s.visible,
      achievable: p?.achievable ?? false,
      done: p?.done ?? 0,
      completed: p?.completed ?? false,
      completedAt: p?.completedAt ?? null,
    };
  });
}

/**
 * Stored rows → what the Dashboard draws for one game, or null when there is nothing to draw.
 *
 * "Nothing to draw" is **fewer than two sets a player would see**: one set is the whole game, which
 * the row's own numbers already say. A set is left out when
 * - the developer keeps it to themselves (`visible` is 0),
 * - it is empty — the base game set is, in a game that moved every achievement into others, or
 * - it is archived and this account has no progress in it: Steam shows an archived set only to
 *   players who unlocked something in it.
 *
 * Order: the developer's own `position`, then the id. That is the order Steam's page uses, and it
 * puts the base game (id 0) first wherever the developer has not moved it — a rule of its own here
 * ("the base game first") would be a second answer to a question Steam has already answered.
 *
 * `complete` is **Steam's flag, not `done >= need`**: a completed set stays completed after the
 * developer adds to it, so 9 of 10 can be a finished set, and a second answer computed here would
 * disagree with the first. A set the account cannot earn draws no progress at all, whatever a stale
 * row still says.
 *
 * @param {object[]} rows  `achievement_sets` rows for one game
 * @param {string} lang    `'zh'` or `'en'`; the name falls back to the other when one is empty
 * @returns {Array<{ id: number, base: boolean, name: string, dlc: boolean, earnable: boolean,
 *   done: number, need: number, complete: boolean, completedAt: number|null }> | null}
 *   `name` is '' for the base game, which the page names itself; `completedAt` is epoch milliseconds
 */
export function displaySets(rows, lang) {
  const shown = (rows ?? []).filter(
    (r) => r.visible !== 0 && r.total > 0 && !(r.archived === 1 && !(r.done > 0))
  );
  if (shown.length < 2) return null;

  shown.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.set_id - b.set_id);

  return shown.map((r) => {
    const earnable = r.achievable !== 0;
    // Numbers whatever the column holds, since the page writes these straight into markup. A column
    // is not guaranteed to hold what the parser wrote: a restored backup is any file the user picks
    const done = Number(r.done) || 0;
    const at = Number(r.completed_at);
    return {
      id: r.set_id,
      base: r.set_id === 0,
      name: lang === 'en' ? r.name_en || r.name_cn || '' : r.name_cn || r.name_en || '',
      dlc: Boolean(r.dlc_appid),
      earnable,
      done: earnable ? done : 0,
      need: Number(r.need) || 0,
      complete: r.completed === 1,
      completedAt: at > 0 ? at * 1000 : null,
    };
  });
}

/**
 * Stored rows → one list per game, in the order the rows arrive. A game with no rows is absent from
 * the map, which is how the readers below tell "divided into sets" from "not".
 */
export function groupSetsByGame(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.appid)) out.set(r.appid, []);
    out.get(r.appid).push(r);
  }
  return out;
}

/**
 * What one game adds to the readout's **completed** count. Steam's profile counts finished games
 * *and* finished sets, one each: a game divided into sets is one unit per finished set, and any
 * other game is one unit when everything in it is unlocked.
 *
 * Two clauses are shared with `displaySets`: `completed` is **Steam's flag, never `done >= need`**,
 * and a set the developer keeps to themselves, or one holding nothing, is not a unit.
 *
 * **A game with stored sets is judged by them alone.** Its flat count can include a DLC the account
 * cannot earn, so "finished" on the flat list and "finished" set by set are different questions — a
 * game with a DLC the account does not own can finish every set it can earn and still sit short of
 * 100% — and the strip drawn on the same row answers the second. The cost is that a reading older
 * than the game's stats is wrong until the next sync asks again, which `selectSetsTargets` does for
 * exactly that case.
 *
 * Two rows are the exception to "the sets decide". A game Steam has stopped answering for
 * (`has_achievements` 0) adds nothing whatever it once stored: its numbers are cleared, so nothing
 * on the row can be called finished. And a locked row is never asked about its sets again, so the
 * ones it holds are as old as the lock; they still decide, so the figure stays what Steam last said
 * rather than what was typed beside it.
 *
 * @param {{ achieved: number|null, total: number|null, has_achievements?: number|null }} game
 *   the `games` row
 * @param {object[]|undefined} rows  that game's `achievement_sets` rows, when any are stored
 * @returns {number}
 */
export function completedUnits(game, rows) {
  if (game.has_achievements === 0) return 0;
  if (rows?.length) return rows.filter((r) => r.completed === 1 && r.visible !== 0 && r.total > 0).length;
  return game.total > 0 && game.achieved === game.total ? 1 : 0;
}
