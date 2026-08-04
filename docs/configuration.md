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
  "requestDelayMs": 300,      // pause between Steam API calls
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

**`requestDelayMs`** — the pause between Steam API calls. If a sync reports games "留待重试" (left for retry), you're being rate-limited: raise this to 500–800 and run again. Lowering it makes syncs faster but risks HTTP 429s.

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
