# Configuration

Everything lives in `config.json` in the project root, created by `node tracker.js init` — or by the first-run form in the packaged app, which writes the same file. It's gitignored and written with mode `600` (only your user can read it), because it holds your API credentials. (`TRACKER_DATA_DIR`, below, can move where that file lives.)

Only `steamApiKey` and `steamId` are required. Everything else has a working default — the file `init` writes contains just those two.

```jsonc
{
  "steamApiKey": "…",         // from https://steamcommunity.com/dev/apikey
  "steamId": "…",             // your SteamID64, 17 digits

  "language": "schinese",     // language for game + achievement names from Steam
  "port": 8777,               // Dashboard port
  "syncStaleHours": 12,       // auto-sync when opening the Dashboard if data is older; 0 = never
  "syncGuidesOnServe": true,  // also look for new guide pages when opening the Dashboard
  "checkboxSyncOnServe": true,        // also tick guide checkboxes for games that changed
  "checkboxSyncOnServeCascade": false,// let that also tick nested sub-steps; off on purpose
  "guideStatusOnServe": true,         // guide page Status ⇄ completion (Done / Staged)
  "requestDelayMs": 300,      // pause between Steam API calls
  "sweepBudget": 40,          // how many "not played, but check anyway" games per auto-sync; 0 = off
  "maxStatsAgeDays": 7,       // re-verify a game at least this often even if untouched
  "perfectGameMaxAgeDays": 3, // 100% games re-verified sooner — they're the ones that can drop
  "dbPath": "data/steam.db",  // relative to the project root
  "guidesDir": "guides",      // where local markdown guides live

  "notion": {                 // only needed for guide checkbox sync
    "token": "…",
    "overviewDbId": "…"
  }
}
```

## Notes on individual options

**`language`** — passed to Steam as the `l=` parameter, so it changes the names you see for games and achievements. Steam's store API has a quirk where it sometimes ignores this for game *titles*, which is why the code falls back to scraping the store page for a localised name.

**`syncStaleHours`** — `serve` checks how long ago the last successful sync finished. If it's longer ago than this, it kicks off a sync in the background and shows a progress bar in the corner of the page. Note this check happens **once, when the server starts** — refreshing the page in your browser re-reads the local database but never re-checks Steam. Set it to `0` if you'd rather only ever sync manually.

Either way, the **立即同步** button next to the "上次同步" line on the Dashboard starts a sync on demand, ignoring `syncStaleHours` entirely. It's the same background sync, so the usual progress bar and automatic refresh apply, and the button greys out while one is running — including a sync you started from the CLI or another tab.

**`syncGuidesOnServe`** — when `serve` starts it also runs guide discovery, the same thing `node tracker.js guides` does: scan `guides/*.md` and the Notion guide database for pages carrying an `appid:` line, and register any new ones so their links appear on the Dashboard. Deliberately **not** gated by `syncStaleHours` — you often create a guide page minutes after a sync, when achievement data is still fresh, and the link needs to show up now rather than in twelve hours. It needs no Steam credentials, and a failure (expired Notion token, API down) is logged and otherwise ignored. Costs a couple of Notion API calls per start, plus one page read per not-yet-registered page; set it to `false` to skip it.

**`checkboxSyncOnServe`** — after the background sync finishes, tick guide checkboxes for the achievements it just found. Applies both to the sync that runs when `serve` starts and to the one behind the 立即同步 button. This is the only place in the project that writes to Notion without a `--dry-run` in front of it, which is why it is scoped tightly: it visits **only the games that changed in that run** — your unlocked count went up, the developer added achievements, or a guide page was registered for the first time that run. Nothing changed means no Notion calls at all, which is the common case. A full pass over every eligible game costs ~40 page reads and stays a manual `node tracker.js checkbox-sync`.

Every tick is written to `sync_log` just like the manual command's, so `node tracker.js log 30` is the review path; the Dashboard also shows a notice naming the first few, which doesn't auto-dismiss. A Notion failure here is soft — it shows as its own notice and never turns into "sync failed", since the achievement data synced fine. Set to `false` to tick only when you run the command yourself.

One deliberate exception to the usual rules: a game already at 100% is normally skipped, but one that hit 100% *in that run* is still visited. Without it, the achievement that completes a game could never have its box ticked automatically — by the next run the game is at 100% and would be skipped every time.

**`checkboxSyncOnServeCascade`** — whether the automatic tick also cascades to nested sub-step checkboxes under an unlocked achievement. Defaults to `false`, unlike the manual command, which cascades unless you pass `--no-cascade`. The cascade assumes "parent unlocked ⇒ every sub-step listed under it was done", which is right for all-of achievements and wrong for any-of ones — nine endings listed under "reach an ending" would get eight false ticks. The manual command lets you check a `--dry-run` first; the automatic path has no such gate, so it stays off here.

**`guideStatusOnServe`** — after the tick pass, keep each Notion guide page's `Status` in step with completion: `Done` when a game reaches 100%, back to `Staged` when it drops below. Runs on Dashboard open and after 立即同步, and standalone as `node tracker.js guide-status` (with `--dry-run`).

Dropping below 100% means a developer patched in new achievements — the one kind of change that happens without you playing, and so the one you'd otherwise never spot.

Both rules are written over *current state* rather than over the moment of crossing. Crossing happens once, inside one sync; if that particular run can't write to Notion, a transition-based rule would lose it permanently, because every later run only ever sees the same value on both sides. Checking current state makes the pass idempotent and self-repairing. It costs about three API calls per run regardless of library size — the page listing was already being fetched for guide discovery.

The directions are not equally aggressive, on purpose. Promotion overwrites anything that isn't already `Done`, `Differed` included: completion wins over a hand-set workflow state. Demotion touches **only** `Done` — a sub-100% page you've marked `Paused` or `In progress` is a decision you made, and overwriting it on every Dashboard open would leave you and the tool fighting. A game whose achievement total becomes unknown isn't treated as a drop.

Notion-kind guides only; local markdown has no status property. Set to `false` to leave the property alone.

**`requestDelayMs`** — the pause between Steam API calls. If a sync reports games "留待重试" (left for retry), you're being rate-limited: raise this to 500–800 and run again. Lowering it makes syncs faster but risks HTTP 429s.

**`sweepBudget` / `maxStatsAgeDays` / `perfectGameMaxAgeDays`** — these three control how much work the *automatic* sync does when you open the Dashboard. (`node tracker.js sync` ignores them and always checks everything; `sync --fast` uses them.)

The auto-sync no longer walks the whole library. It checks a game when any of these is true:

1. **You played it** since the last check — Steam's `rtime_last_played` says so. Your unlocked count can't change without this, so this group is what keeps `achieved` exactly right.
2. **It isn't in your `GetOwnedGames` list** — family-shared, delisted, or hand-added rows have no play timestamp to check, so they're refreshed every time.
3. **It's overdue for a re-check** — because the *total* achievement count is a property of the game, not of you: a developer patch can add achievements while you're not looking, which would silently drop a 100% game below 100%. `maxStatsAgeDays` (and the shorter `perfectGameMaxAgeDays` for games at 100%) is what catches that. `sweepBudget` caps how many of these run per sync, so coming back after a long break doesn't produce one enormous sync — the backlog just drains over the next few.

On a 310-game library this takes a routine sync from **~160 s to ~8 s**, rising to ~25 s on syncs that include a full sweep batch.

**The thresholds are targets, not guarantees** — `sweepBudget` is the real constraint. With the default 40 and the Dashboard opened about twice a day, 100% games get re-verified every ~3 days and the rest every ~7, as intended. Opening only once a day stretches that to roughly 5 and 11 days. If you want the stated cadence at once-a-day use, raise `sweepBudget` to about 67 (which costs ~34 s per sync instead of ~23 s). Setting it to `0` disables the sweep entirely — then a game that adds achievements is only noticed the next time you actually play it.

**`notion.overviewDbId`** — the Notion database holding your guide pages. Open that database as a full page; the ID is the 32-character hex string in the URL, *before* the `?v=` (that part is the view ID, not the database). See [guides.md](guides.md).

## Environment variables

These override the file, which is useful for one-off runs or if you'd rather not keep credentials on disk:

| Variable | Overrides |
|---|---|
| `STEAM_API_KEY` | `steamApiKey` |
| `STEAM_ID` | `steamId` |
| `NOTION_TOKEN` | `notion.token` |
| `PORT` | `port` |

```bash
STEAM_API_KEY=xxx STEAM_ID=yyy node tracker.js sync
```

**`TRACKER_DATA_DIR`** works differently from the four above: it doesn't override a value inside `config.json`, it changes *where* `config.json`, `data/` and `guidesDir` are read from and written to. Without it, all three sit next to the code, which is what the sections above assume.

It exists for the packaged Windows app ([launcher/README.md](../launcher/README.md)), which is a second copy of the code in its own folder and would otherwise keep its own separate database. Pointing it at an existing checkout makes both the app and the CLI read and write the same files:

```bash
TRACKER_DATA_DIR=/path/to/steam-achievement-tracker node tracker.js status
```

Code assets (`Dashboard.html`, `Setup.html`, `lib/rpc.js`) are never affected — they always load from wherever the running code is, so the variable cannot make one copy of the code serve another copy's pages. A path that doesn't exist is ignored by the launcher rather than used. Don't run the CLI and the packaged app against the same directory at the same time; the two will both write to one SQLite file.

## Changing the port

Either set `port` in `config.json`, or pass it per-run:

```bash
node tracker.js serve --port 9000
```

The server only ever listens on `127.0.0.1`, so the Dashboard is reachable from your machine and nowhere else. That's also why there's no login on it.

## Scheduling

There is no built-in scheduler. Two ways to get regular updates:

- **Do nothing** — starting `serve` syncs in the background when data is stale (see `syncStaleHours` above), ticks the guide checkboxes for whatever that sync turned up (see `checkboxSyncOnServe`), and the Dashboard's **立即同步** button covers the rest. Leaving `serve` running for days does *not* keep syncing: the staleness check only runs at startup.
- **A real daily job** — on macOS, a launchd plist running `node tracker.js sync`. Note it only fires while the machine is awake; launchd will run a missed job on wake, but a machine that's off for a week syncs nothing.
