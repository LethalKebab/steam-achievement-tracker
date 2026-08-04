---
name: steam-local-dev
description: Project-wide dev conventions and Steam Web API gotchas for this local Node project (zero-dependency stack, CLI commands, SQLite schema, sync phases, rate limits, debugging a Steam call that returns unexpected data). Use when touching tracker.js or lib/*, or debugging a Steam API response.
---

# Steam Achievement Tracker — local project conventions

## Stack constraints

**Zero dependencies, deliberately.** Node built-ins only: `node:sqlite` (storage), global `fetch` (HTTP), `node:http` (Dashboard server), `node:test` (tests). Requires Node 24+. Adding an npm dependency needs a strong justification — "no install step" is one of this project's selling points.

ES modules with real `import`/`export`. Unlike the Apps Script version this replaced, files do **not** share a global scope.

Secrets (`steamApiKey`, `steamId`, `notion.token`) live in `config.json` — mode 600, gitignored, overridable by `STEAM_API_KEY` / `STEAM_ID` / `NOTION_TOKEN` env vars. **The repo is public; never hardcode them, never commit `config.json` or `data/`.**

## Dev loop

```bash
node tracker.js <cmd>    # init | sync | serve | status | guides | checkbox-sync | import | export | log
node --test              # test/matching.test.js
node --check lib/x.js    # syntax check
```

No build, no push, no deploy — edit and re-run. `serve` doesn't hot-reload `lib/`; restart it. `Dashboard.html` and `lib/rpc-shim.js` are read per request, so a browser refresh is enough for those.

**`lib/api.js` method names and return shapes are a contract with `Dashboard.html`** (which calls them through `lib/rpc-shim.js`). A method returning `{error: '...'}` is a *successful* call — the frontend checks `result.error` itself; only thrown/network errors hit the failure handler. New Dashboard method = add it to `lib/api.js`; the shim proxies any name and needs no change.

## Sync phases (`lib/sync.js`)

`fullSync` = `syncLibrary` → `syncAchievementStats` → `syncAchievementSchema`. No cursor, no runtime cap — both existed only for Apps Script's 6-minute limit, and dropping the cursor also dropped the old "re-sorting shifts what the cursor points at" hazard.

- Rows whose appid is **not** in the current `GetOwnedGames` snapshot are left entirely untouched by `syncLibrary`. The preservation rule keys off *ownership*, not `status`.
- `syncAchievementStats` skips rows on **`sync_locked = 1`**, not on `status`. If a row won't update, check that first.
- No destructive rebuild exists. The old `hardResetFromApi()` (which silently dropped every family-shared/manual row) was deliberately not ported.

## Steam Web API quirks (verified, don't re-discover)

1. `appdetails`'s `name` field **ignores the `l=` param** — Chinese names require scraping the store page HTML (`fetchAppNameFromStorePage`).
2. Store page scraping gets rate-limited; keep the regex loose (the class attribute can carry multiple classes) and send the age-verification cookie to get past age-gated games.
3. `GetPlayerAchievements` HTTP **400** = "no stats for this account on this game" — a normal signal, not an error, don't retry. Only **429** is real rate limiting; everything else non-200 is also retried next cycle.
4. HTTP **403** `"Profile is not public"` can come back for one *specific* game even when the overall profile is public — a per-game "Game Details" privacy toggle on Steam's side, not fixable in code. Retrying is pointless until that setting changes.
5. A game can vanish from `GetOwnedGames` entirely (delisted free titles, lapsed family-sharing) while `GetPlayerAchievements` still returns its full permanent stats forever. Absence from `GetOwnedGames` ≠ "no achievement data" — check achievements directly before concluding a game can't be tracked.
6. Whether an *owned* appid is currently Unvetted requires the exact two-call comparison in `fetchOwnedGamesWithUnvettedFlag()` (`skip_unvetted_apps=false` minus `=true`). A single plain `GetOwnedGames` call silently returns the vetted-only view and won't tell you.
7. `GetOwnedGames` omits free games unless `include_played_free_games=true` (already set).
8. Family Sharing achievements are recorded per **playing** account, not per license owner. A shared game actually played on a different family member's account will correctly and permanently show 0 progress for your `steamId` — expected, not a bug to chase.
9. Guide content stays out of the database (only a pointer is stored). Originally because Sheets split multi-line pastes across rows; still true because guides need to be human-editable and checkable in Notion.
10. **`Manual` used to do two unrelated jobs** — "skip the daily sync" and "lock the row against Steam's Unvetted re-classification" — with no way to get one without the other. That's now split into `status` (classification) and `sync_locked` (behavior). The Dashboard still toggles both together, so day-to-day behavior is unchanged, but they can be diverged on purpose. The `family` column is separate from both: purely informational, never affects sync.

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

`appid` (PK) / `name` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` (♥) / `priority` (★) / `family` / `new_ach_date` / `updated_at`

- `status`: `''` normal, `'Unvetted'`, `'Manual'`
- `has_achievements = 0` replaces the old `'N/A'` string in a numeric column; `NULL` = not synced yet
- Toggle `family` from the Dashboard's "家庭" badge — see quirk #10 for why it's a separate column
