# Configuration

Everything lives in `config.json` in the project root, created by `node tracker.js init`. It's gitignored and written with mode `600` (only your user can read it), because it holds your API credentials.

Only `steamApiKey` and `steamId` are required. Everything else has a working default — the file `init` writes contains just those two.

```jsonc
{
  "steamApiKey": "…",         // from https://steamcommunity.com/dev/apikey
  "steamId": "…",             // your SteamID64, 17 digits

  "language": "schinese",     // language for game + achievement names from Steam
  "port": 8777,               // Dashboard port
  "syncStaleHours": 12,       // auto-sync when opening the Dashboard if data is older; 0 = never
  "syncGuidesOnServe": true,  // also look for new guide pages when opening the Dashboard
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

**`syncStaleHours`** — `serve` checks how long ago the last successful sync finished. If it's longer ago than this, it kicks off a full sync in the background and shows a progress bar in the corner of the page. Set it to `0` if you'd rather only ever sync manually.

**`syncGuidesOnServe`** — when `serve` starts it also runs guide discovery, the same thing `node tracker.js guides` does: scan `guides/*.md` and the Notion guide database for pages carrying an `appid:` line, and register any new ones so their links appear on the Dashboard. Deliberately **not** gated by `syncStaleHours` — you often create a guide page minutes after a sync, when achievement data is still fresh, and the link needs to show up now rather than in twelve hours. It needs no Steam credentials, and a failure (expired Notion token, API down) is logged and otherwise ignored. Costs a couple of Notion API calls per start, plus one page read per not-yet-registered page; set it to `false` to skip it.

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

## Changing the port

Either set `port` in `config.json`, or pass it per-run:

```bash
node tracker.js serve --port 9000
```

The server only ever listens on `127.0.0.1`, so the Dashboard is reachable from your machine and nowhere else. That's also why there's no login on it.

## Scheduling

There is no built-in scheduler. Two ways to get regular updates:

- **Do nothing** — opening the Dashboard syncs in the background when data is stale (see `syncStaleHours` above).
- **A real daily job** — on macOS, a launchd plist running `node tracker.js sync`. Note it only fires while the machine is awake; launchd will run a missed job on wake, but a machine that's off for a week syncs nothing.
