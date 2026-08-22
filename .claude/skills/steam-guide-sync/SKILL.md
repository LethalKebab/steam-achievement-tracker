---
name: steam-guide-sync
description: Read/write the guides table (appid <-> guide location) and pull authoritative Steam achievement data for guide-writing. Use when matching game names to appids, registering guide pages, adding a manually-tracked game, fixing a row's status, or fetching a game's unlocked/full achievement list.
---

# Guide + game data access

Everything lives in `data/steam.db`, so read it with SQL or call `lib/*` directly — there's no service or API layer in between.

## Reading data — prefer SQL

```bash
# match a game name to its appid
sqlite3 data/steam.db "SELECT appid, name, status, achieved, total FROM games WHERE name LIKE '%苏丹%'"

# current guide registrations
sqlite3 data/steam.db "SELECT appid, name, kind, url, updated FROM guides ORDER BY appid"

# why isn't this row syncing?  → sync_locked, not status, is what the sync checks
sqlite3 data/steam.db "SELECT appid, name, status, sync_locked FROM games WHERE appid = '999999'"

# a game's achievement definitions (definitions only — unlock state is a live Steam call)
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

| Task | How |
|---|---|
| register/update a guide link | `upsertGuide(db, {appid, name, url, kind})` in `lib/db.js` — **writes name and url together**; writing only the url leaves renamed games with stale names (this regressed once) |
| discover new Notion guide pages | `node tracker.js guides --notion` |
| remove a guide | `DELETE FROM guides WHERE appid = ?` |
| add a game Steam doesn't list | Dashboard "添加新游戏" box, or `insertGame(db, {appid, name, family: 1})` |
| stop syncing a row (hand-maintained) | `setManualStatus` via the Dashboard's 🔒, or `insertGame(..., {status: 'Manual', syncLocked: 1})` — a **separate** decision from adding, see below |
| change a row's label | `setGameField(db, appid, 'status', ...)` — remember `sync_locked` is a separate column |
| reclassify as family-shared | `UPDATE games SET status = '', sync_locked = 0, family = 1 WHERE appid IN (...)` |

**Adding a game does not lock it, and hasn't since 2026-08-13.** Added rows used to get `status: 'Manual', syncLocked: 1` automatically, on the reasoning that a hand-added game is one Steam has no data for. That reasoning is backwards for the common case: the games people add by hand are family-shared ones, which is precisely where Steam *does* return real progress — locking them freezes the numbers at whatever they were the moment the row was created. `addGame` now inserts with `family` set and sync left on; locking is a separate, explicit act (the 🔒 on the row) for when Steam turns out to have nothing.

Before reclassifying a `Manual` row as family-shared, confirm the account can actually see real data: call `fetchPlayerAchievements` for that appid and check whether the `achieved` numbers are *your* progress (all zeros usually means a different family member plays it). See the `status` / `sync_locked` / `family` notes in `docs/data.md`.

## Guide registration rules

A page/file counts as a guide iff its content starts with an `appid: NNNNNN` line. `node tracker.js guides` discovers both backends:

- `--notion` queries `notion.overviewDbId`, skips pages already registered (compared by **normalized page ID**, never raw URL text — Notion adds title slugs to URLs, and comparing raw URLs once caused already-linked pages to be re-added and overwrite curated names), then reads the first 10 blocks of each new page looking for the `appid:` line. Notion's search API only indexes titles, not body blocks, which is why it must read blocks instead of searching.
- `--local` scans `guides/*.md` for the same line. **It will not overwrite a Notion registration for the same appid unless you pass `--force`** — one appid, one backend, and Notion is the primary setup.

A page with no `appid:` line is silently skipped every run, not retried as an error — it needs the guide actually written first (see `achievement-guide-writing`).
