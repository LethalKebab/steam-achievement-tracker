---
name: steam-local-dev
description: Project-wide dev conventions and Steam Web API gotchas for this local Node project (no-install-step runtime, CLI commands, SQLite schema, sync phases, rate limits, debugging a Steam call that returns unexpected data). Use when touching tracker.js or lib/*, or debugging a Steam API response.
---

# Steam Achievement Tracker — local project conventions

## Stack constraints

**The runtime has no npm dependencies** — `dependencies: {}`, no root `node_modules`, Node built-ins only: `node:sqlite` (storage), global `fetch` (HTTP), `node:http` (Dashboard server), `node:test` (tests). Requires Node 24+. Keeping it that way is worth something concrete: `git clone && node tracker.js` just runs, and the packaged build's `extraResources` stays an allow-list of plain files.

**The blanket "never add a dependency" rule was lifted 2026-08-16** (owner's call) — do not re-impose it or cite it to refuse work. npm is fine as a *build-time* tool: `assets/fonts/` was fetched with `npm install @fontsource-variable/noto-sans-sc`, the files were committed, and the package was discarded. Prefer that shape — fetch, vendor the artefact, keep the runtime clean. A genuine runtime dependency is now allowed but should still come with a reason.

**Do not describe this project as "offline".** It has never been: the Dashboard loads game capsule art from `cdn.akamai.steamstatic.com` on every page. What is actually local is the *data* — SQLite on disk, no telemetry, server bound to 127.0.0.1.

ES modules with real `import`/`export`.

Secrets (`steamApiKey`, `steamId`, `notion.token`) live in `config.json` — mode 600, gitignored, overridable by `STEAM_API_KEY` / `STEAM_ID` / `NOTION_TOKEN` env vars. **The repo is public; never hardcode them, never commit `config.json` or `data/`.**

## Dev loop

```bash
node tracker.js <cmd>    # init | sync | serve | status | guides | checkbox-sync | guide-status | guide-lint
                         #   | notion-check | ai-check | guide-gen | guide-to-notion | drafts | audit
                         #   | export | backup | restore | log
node --test --test-reporter=dot   # the whole suite (dot prints no summary — green = exit code, no X)
node --check lib/x.js    # syntax check
```

No build step, nothing to deploy — edit and re-run. `serve` doesn't hot-reload `lib/`; restart it. `Dashboard.html` and `lib/rpc.js` are read per request, so a browser refresh is enough for those. (`launcher/` — the packaged Electron app — does have a build, but it only wraps this server and never needs touching to change the tracker; its packaging picks up new `*.html` and `lib/` files automatically. See `launcher/README.md`.)

**`lib/api.js` method names and return shapes are a contract with `Dashboard.html`** (which calls them through `lib/rpc.js`). A method returning `{error: '...'}` is a *successful* call — the frontend checks `result.error` itself; only thrown/network errors hit the failure handler. New Dashboard method = add it to `lib/api.js`; `rpc.js` proxies any name and needs no change.

`Setup.html` (served at `/setup` when credentials are missing) uses the same `/api/<method>` contract, but with a plain `fetch` rather than `rpc.js`. Its two methods are the only ones in `lib/api.js` that mutate `config` and `steam` in place instead of just touching `db`: `SteamClient` copies `steamApiKey`/`steamId` into instance fields when it's constructed, so writing `config.json` alone would leave the already-running server unable to sync until restarted. Any future path that accepts credentials at runtime hits the same trap.

**A page refresh never touches Steam.** `getDashboardData()` is a pure DB read, and the `syncStaleHours` check runs once at `serve` startup. Steam-facing syncs come from exactly one function, `startBackgroundSync()` in `lib/server.js` — used by both the startup auto-sync and the Dashboard's 立即同步 button (`api.startSync`). **Keep it one function:** it holds the only concurrency guard, and two entry points into `fullSync` would let a click during the startup sync run two of them over the same database. The button skips the staleness gate but keeps `selection`, so it's the sampled ~8 s sync.

## Sync phases (`lib/sync.js`)

`fullSync` = `syncLibrary` → `syncAchievementStats` → `syncAchievementSchema`, over the whole library in one pass. No cursor, no runtime cap; Ctrl+C is safe because each game is committed as it completes.

- Rows whose appid is **not** in the current `GetOwnedGames` snapshot are left entirely untouched by `syncLibrary`. The preservation rule keys off *ownership*, not `status`.
- `syncAchievementStats` skips rows on **`sync_locked = 1`**, not on `status`. If a row won't update, check that first.
- **Which rows phase 2 checks is decided by `selectStatsTargets()`**, and only when a `selection` is passed (the Dashboard auto-sync and `sync --fast`; plain `node tracker.js sync` stays a true full pass). It unions *played* (`rtime_last_played` moved), *unowned* (absent from `GetOwnedGames`, so no timestamp exists), and a budgeted *sweep*. The split exists because `achieved` and `total` change for different reasons: `achieved` is a fact about the account and can't move without playing, but `total` is a fact about the *game* — a developer patch adds achievements with zero playtime — so gating `total` on `rtime` is simply wrong. The sweep is the only thing that catches that; don't remove it as an optimisation.
- No destructive rebuild exists, deliberately: a "wipe and repopulate from `GetOwnedGames`" helper would silently drop every family-shared and manually-maintained row, and the API cannot give that data back.

## Steam Web API quirks (verified, don't re-discover)

1. `appdetails`'s `name` field **ignores the `l=` param** — Chinese names require scraping the store page HTML (`fetchAppNameFromStorePage`).
2. Store page scraping gets rate-limited; keep the regex loose (the class attribute can carry multiple classes) and send the age-verification cookie to get past age-gated games.
3. `GetPlayerAchievements` HTTP **400** = "no stats for this account on this game" — a normal signal, not an error, don't retry. Only **429** is real rate limiting; everything else non-200 is also retried next cycle.
4. HTTP **403** `"Profile is not public"` can come back for one *specific* game even when the overall profile is public — a per-game "Game Details" privacy toggle on Steam's side, not fixable in code. Retrying is pointless until that setting changes.
5. A game can vanish from `GetOwnedGames` entirely (delisted free titles, lapsed family-sharing) while `GetPlayerAchievements` still returns its full permanent stats forever. Absence from `GetOwnedGames` ≠ "no achievement data" — check achievements directly before concluding a game can't be tracked.
6. Whether an *owned* appid is currently Unvetted requires the exact two-call comparison in `fetchOwnedGamesWithUnvettedFlag()` (`skip_unvetted_apps=false` minus `=true`). A single plain `GetOwnedGames` call silently returns the vetted-only view and won't tell you.
7. `GetOwnedGames` omits free games unless `include_played_free_games=true` (already set).
8. Family Sharing achievements are recorded per **playing** account, not per license owner. A shared game actually played on a different family member's account will correctly and permanently show 0 progress for your `steamId` — expected, not a bug to chase.
9. Guide content stays out of the database — only a pointer is stored. Guides need to be human-editable and tickable in Notion, so the database tracks *where* a guide is, never its text.
10. **`status` and `sync_locked` are separate columns on purpose.** "Skip the daily achievement sync" and "pin this row's label so Steam can't re-classify it Unvetted" are different wishes; a single flag cannot express one without the other. The Dashboard toggles both together, but they can be diverged by hand. `family` is separate from both again: purely informational, never affects sync.

## Debugging Steam API responses

The old `steam_test_debug.gs` helpers are gone — `lib/steam.js` is directly callable, which is simpler:

```bash
# raw achievement stats for one appid
node --input-type=module -e "
import {loadConfig} from './lib/config.js'; import {SteamClient} from './lib/steam.js';
const s = new SteamClient(loadConfig(), {log: console.log});
console.log(JSON.stringify(await s.fetchPlayerAchievements(3117820), null, 2));"

# which games Steam hides by default (the two-call Unvetted diff)
node --input-type=module -e "
import {loadConfig} from './lib/config.js'; import {SteamClient} from './lib/steam.js';
const s = new SteamClient(loadConfig());
const r = await s.fetchOwnedGamesWithUnvettedFlag();
console.log('owned', r.games.length, 'unvetted', [...r.unvettedAppIds]);"

# store page scraping / name lookup
node --input-type=module -e "
import {loadConfig} from './lib/config.js'; import {SteamClient} from './lib/steam.js';
const s = new SteamClient(loadConfig(), {log: console.log});
console.log(await s.fetchAppName(3117820));"
```

For data questions, query SQLite directly — faster than writing JS:

```bash
sqlite3 data/steam.db "SELECT appid, name, achieved, total, status, sync_locked FROM games WHERE family = 1"
sqlite3 data/steam.db "SELECT COUNT(*) FROM achievements WHERE appid = '3117820'"
```

## `games` table schema

`appid` (PK) / `name` / `name_en` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` (♥) / `priority` (★) / `family` / `new_ach_date` / `updated_at` / `last_played` / `stats_checked_at` / `perfect_lost_date` / `ach_added_date` (the 🔔 transition stamps) / `cover_url`

- `status`: `''` normal, `'Unvetted'`, `'Manual'`
- `has_achievements = 0` replaces the old `'N/A'` string in a numeric column; `NULL` = not synced yet
- Toggle `family` from the Dashboard's "家庭" badge — see quirk #10 for why it's a separate column
- `last_played` / `stats_checked_at` are the phase-2 sampling state. `updated_at` cannot substitute: it moves on *any* row change, including a ♥ toggle, so it can't answer "when did we last ask Steam about this game".
- Adding a column needs an `ALTER TABLE`, not just an edit to `SCHEMA` — `SCHEMA` is `CREATE TABLE IF NOT EXISTS` and does nothing to an existing DB. Add to **both** `SCHEMA` and `ADDED_COLUMNS` in `lib/db.js`.
