---
name: steam-guide-sync
description: Read/write the guides table (appid <-> guide location) and pull authoritative Steam achievement data for guide-writing. Use when matching game names to appids, registering guide pages, adding a manually-tracked game, fixing a row's status, or fetching a game's unlocked/full achievement list.
---

# Guide + game data access

There is no HTTP endpoint any more. The old `steam_guides_sync.gs` `doPost` Web App (with its `SYNC_SECRET`, its `ANYONE_ANONYMOUS` deployment, and the redirect-following dance) existed **only** because Claude Code was outside Google's sandbox and needed a way in. Everything now runs locally, so read the SQLite file or call `lib/*` directly.

## Reading data — prefer SQL

```bash
# match a game name to its appid (was: listOwnedGames)
sqlite3 data/steam.db "SELECT appid, name, status, achieved, total FROM games WHERE name LIKE '%苏丹%'"

# current guide registrations (was: listGuideRows)
sqlite3 data/steam.db "SELECT appid, name, kind, url, updated FROM guides ORDER BY appid"

# why isn't this row syncing?  → sync_locked, not status, is what the sync checks
sqlite3 data/steam.db "SELECT appid, name, status, sync_locked FROM games WHERE appid = '999999'"

# a game's achievement definitions (was: getAllAchievementsForGame, minus live unlock state)
sqlite3 data/steam.db "SELECT api_name, name_cn, name_en, hidden FROM achievements WHERE appid = '3117820'"
```

`node tracker.js status` and `node tracker.js guides` give the same information in summary form.

## Live unlock state (needs a Steam call)

`achievements` holds the *definitions*; whether **you** unlocked each one is a live query. `lib/guides.js`'s `getUnlockedAchievements(db, steam, appid)` combines both — unlocked-only, with CN+EN names pulled from the `achievements` table. Use it for "sync Steam's real unlock state into a guide."

```bash
node --input-type=module -e "
import {loadConfig} from './lib/config.js'; import {openDb} from './lib/db.js';
import {SteamClient} from './lib/steam.js'; import {getUnlockedAchievements} from './lib/guides.js';
const c = loadConfig(); const db = openDb(c.dbPath);
console.log(await getUnlockedAchievements(db, new SteamClient(c), '3117820'));"
```

For "rewrite a guide's whole checklist from scratch" you want *all* achievements with real `achieved` flags: read `achievements` for the definitions and `SteamClient.fetchPlayerAchievements(appid)` for the flags, then join on `api_name`/`apiname`. If `achievements` has no rows for that appid yet, run `node tracker.js sync --schema` first.

## Writing data

| Old HTTP action | Now |
|---|---|
| `upsertGuideLinks(entries)` | `upsertGuide(db, {appid, name, url, kind})` in `lib/db.js` — **overwrites name and url together**, don't write only the url or renamed games keep stale names (this was a real regression once) |
| `syncGuidesFromNotion` | `node tracker.js guides --notion` |
| `deleteGuideRow(appid)` | `deleteGuide(db, appid)`, or `DELETE FROM guides WHERE appid = ?` |
| `addManualGame(entry)` | Dashboard "添加游戏" box, or `insertGame(db, {appid, name, status: 'Manual', syncLocked: 1})` |
| `setGameStatus(appid, status)` | `setGameField(db, appid, 'status', ...)` — remember `sync_locked` is a separate column now |
| `migrateFamilyGames(appids)` | `UPDATE games SET status = '', sync_locked = 0, family = 1 WHERE appid IN (...)` |
| `installAutoGuideSyncTrigger` | gone — there are no schedulers; run `node tracker.js guides` when you want it |

Before reclassifying a `Manual` row as family-shared, confirm the account can actually see real data: call `fetchPlayerAchievements` for that appid and check whether the `achieved` numbers are *your* progress (all zeros usually means a different family member plays it). See `PROJECT_CONTEXT.md` pitfall #6.

## Guide registration rules

A page/file counts as a guide iff its content starts with an `appid: NNNNNN` line. `node tracker.js guides` discovers both backends:

- `--notion` queries `notion.overviewDbId`, skips pages already registered (compared by **normalized page ID**, never raw URL text — Notion adds title slugs to URLs, and comparing raw URLs once caused already-linked pages to be re-added and overwrite curated names), then reads the first 10 blocks of each new page looking for the `appid:` line. Notion's search API only indexes titles, not body blocks, which is why it must read blocks instead of searching.
- `--local` scans `guides/*.md` for the same line. **It will not overwrite a Notion registration for the same appid unless you pass `--force`** — one appid, one backend, and Notion is the primary setup.

A page with no `appid:` line is silently skipped every run, not retried as an error — it needs the guide actually written first (see `achievement-guide-writing`).
