/**
 * The Steam family group, and the one-time backfill it makes possible
 * ------------------------------------------------
 * `syncLibrary` notices a shared game the moment you play it, through
 * `GetRecentlyPlayedGames`. That window is a **fixed fortnight**, so it can only ever see what
 * you are playing now — a library set up today recovers the games in flight and nothing else.
 * Measured on a live account: 18 shared games had been played, 2 of them within the fortnight.
 * The other 16 included 189 hours of one game and 94 of another, and no amount of waiting brings
 * them back.
 *
 * `IFamilyGroupsService` answers the whole question in two requests — every app in the shared
 * library, with the asking account's own playtime and last-played time on each. That is what this
 * file is for, and it is a **deliberate one-off** rather than part of the sync, because of how it
 * authenticates.
 *
 * **The credential is not the Web API key.** Measured: the key is refused in every position
 * (`key=`, `access_token=`), on every method, and the interface does not appear in
 * `GetSupportedAPIList` for a key at all. What it takes is the browser `access_token` from
 * `store.steampowered.com/pointssummary/ajaxgetasyncconfig`, which lasts about a day. So:
 *
 * - **it can never run unattended**, and must not be wired into `fullSync`;
 * - **the token is used and dropped.** It is never written to `config.json` — it would be a third
 *   secret inside the backup zip, and an expired one there is worse than none.
 *
 * Two fields carry the value, and both were checked against the same account's `GetOwnedGames`
 * over the apps that appear in both: `rt_playtime` equalled `playtime_forever` on 122 of 122 rows,
 * and `rt_last_played` equalled `rtime_last_played` on 102 of 102 that had one. They are the
 * asking account's own numbers, not the owner's — which is the fact the whole import rests on, and
 * the one that is least obvious from the field names.
 */
import { msg, msgError } from './messages.js';
import { allGames, insertGame, setGameField } from './db.js';
import { sleep } from './steam.js';

const FAMILY_API = 'https://api.steampowered.com/IFamilyGroupsService';
const TIMEOUT_MS = 30_000;

/**
 * `access_token` goes in the query string because that is the only place this interface reads it
 * from. It is a bearer credential in a URL, so it must never reach a log line or an error message:
 * every throw below names the method and the status and quotes no part of the request.
 */
async function call(method, params, token) {
  const query = new URLSearchParams({ access_token: token, ...params });
  const res = await fetch(`${FAMILY_API}/${method}/v1/?${query}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw msgError('family.tokenBad');
  if (!res.ok) throw msgError('family.failed', { method, status: res.status });
  try {
    return (await res.json())?.response ?? {};
  } catch {
    throw msgError('family.failed', { method, status: 'JSON' });
  }
}

/**
 * Which family group this account is in, and who else is in it.
 *
 * `include_family_group_response` folds the membership list into the same reply, so this is one
 * request rather than two. `is_not_member_of_any_group` is a real answer and not a failure — an
 * account with no family group is the ordinary case for most users of this program.
 */
export async function fetchFamilyGroup(token, steamId) {
  const r = await call('GetFamilyGroupForUser', {
    steamid: String(steamId),
    include_family_group_response: '1',
  }, token);
  if (r.is_not_member_of_any_group || !r.family_groupid) return { member: false, groupId: null, members: [] };
  return {
    member: true,
    groupId: String(r.family_groupid),
    name: r.family_group?.name ?? '',
    members: (r.family_group?.members ?? []).map((m) => String(m.steamid)),
  };
}

/**
 * Every app in the shared library.
 *
 * `include_excluded` is **on**: a game the family cannot actually share still has to be counted,
 * because the alternative is silently dropping something the user played. `planFamilyImport`
 * filters on `exclude_reason` where the reason can be stated, rather than never seeing the row.
 */
export async function fetchSharedLibrary(token, groupId, steamId, language = 'schinese') {
  const r = await call('GetSharedLibraryApps', {
    family_groupid: String(groupId),
    steamid: String(steamId),
    include_own: '0',
    include_excluded: '1',
    include_non_games: '0',
    language,
    max_apps: '5000',
  }, token);
  return r.apps ?? [];
}

/**
 * Split the shared library into what to add, what to fill in, and what to leave alone. Pure, so
 * the decisions are testable without a token or a network.
 *
 * **Ownership is the first gate, and it is not redundant with `include_own=0`.** That parameter
 * drops the apps only *you* hold; one that you and another member both own comes back regardless —
 * measured, 122 of them. Those rows already carry an `rtime_last_played` from `GetOwnedGames`, and
 * writing a second source into the same two columns is how the two start disagreeing.
 *
 * **`rt_playtime > 0` is the filter, and the achievement count is not.** Over 764 untracked
 * candidates, unlocking an achievement without playtime happened **zero** times, while the reverse
 * — real playtime, nothing unlocked — was 4 of the 5 hits. Selecting on achievements would have
 * imported the one game already finished and skipped the one with 22 hours and 42 achievements
 * untouched.
 */
export function planFamilyImport({ apps, existing, ownedIds }) {
  const add = [];
  const backfill = [];
  const excluded = [];
  for (const a of apps) {
    const appid = String(a.appid);
    if ((a.exclude_reason ?? 0) !== 0) { excluded.push({ appid, name: a.name, reason: a.exclude_reason }); continue; }
    if (ownedIds.has(appid)) continue;
    const playtime = Number(a.rt_playtime ?? 0);
    if (!(playtime > 0)) continue;
    // 0 is Steam's "never", and it must not become a 1970 date on the row
    const lastPlayed = Number(a.rt_last_played ?? 0) || null;
    const row = existing.get(appid);
    if (!row) add.push({ appid, name: a.name ?? `AppID ${appid}`, playtime, lastPlayed });
    else if (row.playtime_forever !== playtime || (lastPlayed && row.last_played !== lastPlayed)) {
      backfill.push({ appid, name: row.name, playtime, lastPlayed });
    }
  }
  return { add, backfill, excluded };
}

/** Both requests, as one step, so a caller never holds a group id it has to remember what to do with */
export async function fetchFamilyLibrary(token, steamId, language) {
  if (!String(token ?? '').trim()) throw msgError('family.tokenMissing');
  const group = await fetchFamilyGroup(token, steamId);
  if (!group.member) return { ...group, apps: [] };
  return { ...group, apps: await fetchSharedLibrary(token, group.groupId, steamId, language) };
}

/**
 * Fetch, plan and apply, as one call. **Both surfaces come through here** — the settings page via
 * `api.importFamilyLibrary` and the CLI's `family-import` — because the interesting part is the
 * plan, and two callers each assembling their own would eventually disagree about what counts as
 * importable.
 *
 * A business failure comes back as `{error}` rather than thrown: the page inspects `result.error`
 * itself, which is the contract every other method here follows.
 */
export async function runFamilyImport({ db, steam, config, token }) {
  const steamId = config.steamId;
  if (!steamId) return { error: msg('steam.notConfigured') };
  let lib;
  try {
    lib = await fetchFamilyLibrary(token, steamId, config.language || 'schinese');
  } catch (err) {
    return { error: err.message };
  }
  if (!lib.member) return { error: msg('family.notMember') };

  // `include_own=0` still returns apps a family member holds *as well as* you, so ownership has to
  // be asked separately — those rows already have an rtime and must not be given a second source
  const ownedIds = new Set((await steam.fetchOwnedGames(false)).map((g) => String(g.appid)));
  const existing = new Map(allGames(db).map((r) => [String(r.appid), r]));
  const { add, backfill, excluded } = planFamilyImport({ apps: lib.apps, existing, ownedIds });

  const added = [];
  for (const a of add) {
    // The store call is what every other insert path pays for a localised title; the name Steam
    // just sent is the fallback and also goes into name_en, where the sync's own backfill would
    // otherwise spend a second store call on it
    const best = (await steam.fetchAppName(a.appid)) || a.name;
    insertGame(db, { appid: a.appid, name: best, nameEn: a.name, family: 1 });
    setGameField(db, a.appid, 'playtime_forever', a.playtime);
    if (a.lastPlayed) setGameField(db, a.appid, 'last_played', a.lastPlayed);
    added.push({ appid: a.appid, name: best });
    await sleep(steam.storeDelay);
  }
  for (const b of backfill) {
    setGameField(db, b.appid, 'playtime_forever', b.playtime);
    if (b.lastPlayed) setGameField(db, b.appid, 'last_played', b.lastPlayed);
  }

  return {
    members: lib.members.length,
    added,
    backfilled: backfill.map((b) => ({ appid: b.appid, name: b.name })),
    excluded: excluded.length,
    scanned: lib.apps.length,
  };
}
