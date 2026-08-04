# Steam Achievement Tracker

Track your Steam achievement progress automatically, without babysitting a spreadsheet — and without a Google account, a deployment step, or a single npm install.

Point it at your Steam account once. Your library and achievement progress live in a local SQLite file, and a local web Dashboard shows it all at a glance.

## What you get

- **Your whole library, always current** — every owned game, achievement counts, and completion % refreshed by one command (or automatically when you open the Dashboard).
- **A Dashboard for browsing** — skim your games, mark favorites (♥) and spotlights (★), see progress at a glance. Served from `localhost`, so it opens instantly and no one else can reach it.
- **Full per-achievement detail** — names, descriptions, unlock status for your whole library, queryable with plain SQL or exportable to CSV.
- **Guide links in one place** — an optional daily sync that ticks off guide checkboxes as you actually unlock achievements in-game. Works against Notion pages (the primary setup) or plain local markdown files.
- **Handles the edge cases Steam's API can't** — shared-library games and manually-corrected entries are tracked without being overwritten by the sync, editable right from the Dashboard. See [Known limitations](#known-limitations).

Everything is local: one SQLite file, one config file, no accounts, no service watching your library but you.

> **Heads up:** the Dashboard UI and the guide files are in Chinese (the language this project was built in), not English. Nothing about setup or daily use requires reading Chinese, but expect to see it on screen.

## Requirements

- **Node.js 24 or newer** (`node --version`). That's it — no npm install, no dependencies. Data storage uses Node's built-in `node:sqlite`, HTTP uses the built-in server and `fetch`.

## Setup

Two browser visits and one command. Takes about two minutes.

```bash
node tracker.js init     # asks for your Steam API key + SteamID64, then verifies them
node tracker.js sync     # pulls your whole library (a few minutes for a large library)
node tracker.js serve    # opens the Dashboard at http://127.0.0.1:8777
```

`init` asks for exactly two things, both one-time:

| # | What | Where to get it |
|---|---|---|
| ① | **Steam Web API Key** | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| ② | **SteamID64** | [steamid.io](https://steamid.io) (paste your profile URL) |

They're written to `config.json` (mode `600`, gitignored) and validated against Steam immediately, so a typo surfaces right away instead of halfway through your first sync. If you'd rather not have them on disk, `STEAM_API_KEY` / `STEAM_ID` environment variables override the file.

That's the whole setup — no account to create, no deployment, no scheduler to install.

## Daily use

```bash
node tracker.js serve            # Dashboard; auto-syncs in the background if data is >12h old
node tracker.js sync             # full sync: library + achievement counts + achievement detail
node tracker.js sync --library   # just check for newly-owned games
node tracker.js status           # quick stats + AGCR, no network calls
node tracker.js checkbox-sync    # tick guide checkboxes for newly-unlocked achievements
node tracker.js guides           # discover guide pages (Notion database + local guides/*.md)
node tracker.js export           # dump all three tables to CSV in exports/
node tracker.js log 30           # recent sync log
node --test                      # run the test suite
```

**Scheduling is deliberately absent.** Opening the Dashboard triggers a background sync when the data is more than `syncStaleHours` (default 12) old, and `sync` is there when you want it now. Set `syncStaleHours: 0` in `config.json` to disable the automatic one. The tradeoff: nothing runs while your machine is asleep — sync happens when you show up. If you'd rather have a real daily job, a launchd plist calling `node tracker.js sync` gets you there.

## Configuration

`config.json`, created by `init`. Everything except the two Steam credentials is optional:

```jsonc
{
  "steamApiKey": "…",
  "steamId": "…",
  "language": "schinese",   // affects game + achievement names from Steam
  "port": 8777,
  "syncStaleHours": 12,     // 0 disables auto-sync-on-open
  "requestDelayMs": 300,    // gap between Steam API calls; raise it if you get rate-limited
  "notion": {
    "token": "…",           // Notion internal integration secret (guide sync only)
    "overviewDbId": "…"     // the Notion database holding your guide pages
  }
}
```

## Importing from a spreadsheet

If you already track this in a spreadsheet, `import` brings it in. Worth doing before your first sync, because ♥ favorites, ★ spotlights, family-shared flags, `Manual` rows and hand-entered achievement counts **cannot be recovered from Steam's API** — importing is the only way to keep them.

1. Export each sheet as CSV, with `RAW DATA`, `ACHIEVEMENTS`, or `GUIDES` in the filename.
2. Put them in one folder.
3. `node tracker.js import ~/Downloads/steam-csvs`

Expected columns, read **by position** rather than by header text:

| Sheet | Columns |
|---|---|
| `RAW DATA` | Status, AppID, Name, Achieved, Total, Rate, Favorite, Spotlight, NewAchDate, Family |
| `ACHIEVEMENTS` | AppID, Game, ApiName, NameCN, NameEN, Description, Hidden, IconURL |
| `GUIDES` | AppID, Game, URL, (type), Updated |

It understands `TRUE`/`FALSE`, `45.00%`, `1,000` and `N/A`, and is idempotent — fix something in the spreadsheet, re-run, and those columns are overwritten again. Then `node tracker.js sync` fills in everything Steam *can* tell you. `node tracker.js export` writes the same three files back out.

## Data

`data/steam.db` — one SQLite file, gitignored. Open it with anything (`sqlite3 data/steam.db`):

| Table | Holds |
|---|---|
| `games` | one row per appid: name, achieved/total, rate, status, ♥/★/family flags |
| `achievements` | per-achievement detail, CN + EN names, hidden flag, icon URL |
| `guides` | appid → guide location, plus `kind` (`notion` or `local`) |
| `sync_log` | every checkbox change/skip/failure, for after-the-fact auditing |
| `meta` | last sync timestamp and other odds and ends |

Two schema decisions worth knowing before you write queries against it:

- **"No achievement system" is `has_achievements = 0` with `NULL` counts** — not a `0` total, and not a string in a numeric column.
- **`status` and `sync_locked` are separate columns.** `status` is the label you see and sort by (`''` / `Unvetted` / `Manual`); `sync_locked` is what actually makes a sync skip the row. The Dashboard moves both together, but you can lock the label while keeping the daily refresh: `UPDATE games SET sync_locked = 0 WHERE appid = '...'`.

Want a spreadsheet for ad-hoc poking? `node tracker.js export` writes all three tables out as CSV.

## Guides

Guide *content* lives outside this tool — the `guides` table only stores a pointer. Two backends, and a given appid uses exactly one:

- **Notion** (primary): a page whose body starts with an `appid: NNNNNN` line. `node tracker.js guides` queries your guide database (`notion.overviewDbId`), finds pages not yet registered, reads each one's first few blocks for that `appid:` line, and links it up. Requires `notion.token` and the pages (or their shared parent) added to that integration's connections.
- **Local markdown**: a `.md` file in `guides/` with the same `appid: NNNNNN` line. Discovered by the same command, no token needed. Checkboxes are ordinary `- [ ]` lines, ticked in place to `- [x]`.

`node tracker.js checkbox-sync [appid]` then ticks whatever you've actually unlocked on Steam. If a game already has a Notion guide registered, a same-appid local `.md` is left alone unless you pass `--force` — Notion doesn't get silently replaced.

Matching an achievement to a checkbox is **exact, never substring or prefix** — see [Known limitations](#known-limitations) and `test/matching.test.js`, which locks that behavior in.

## Known limitations

Steam's API is the source of truth for almost everything, but a few things can't be pulled automatically and are tracked via `status` or the family flag instead:

- **`Unvetted`** — games Steam hides from the owned-games API by default. Still auto-synced, just excluded from your aggregate stats (matching Steam's own AGCR methodology).
- **`Manual`** — for the rare case where Steam genuinely can't give *your* account real data for a game: most commonly a Family Library Sharing title that a *different* family member actually plays (Steam tracks achievements per playing account, not per license, so your own account will always read 0). These rows are edited by hand from the Dashboard and always skipped by the sync.
- **Family flag** (the Dashboard's "家庭" badge) — a purely informational marker for the more common shared/gifted-game case: one *you* actually play, so Steam does return your real progress even though the game isn't in your owned list. Use this instead of `Manual` so the game keeps getting auto-synced; the flag just reminds you it's not self-purchased.
- Games with no in-game achievements are recorded as "no achievement system," not 0/0.
- The checkbox sync only ticks a box on an **exact** title match, to avoid ever marking the wrong achievement. This deliberately prefers a missed checkbox over a wrong one; guide pages with unusual formatting may need spot-checking.
- A game can vanish from `GetOwnedGames` (delisted free title, lapsed family sharing) while its achievement stats remain available forever. "Not owned" never means "not trackable."

## Repo layout

| Path | Purpose |
|---|---|
| `tracker.js` | CLI entry point — every command lives here |
| `lib/steam.js` | Steam Web API + store wrappers, with all the documented quirk handling |
| `lib/sync.js` | The sync engine: library → achievement counts → achievement detail, plus AGCR |
| `lib/db.js` | SQLite schema and accessors |
| `lib/server.js` | Local HTTP server: serves the Dashboard, dispatches `/api/*` |
| `lib/api.js` | Dashboard backend methods (same names/shapes the frontend already called) |
| `lib/rpc.js` | Served to the browser; turns `rpc.…method(args)` calls into `POST /api/method` |
| `lib/guides.js` | Achievement↔checkbox matching rules + both guide backends |
| `lib/notion.js`, `lib/markdown.js` | The two guide backends |
| `lib/csv.js` | Sheet-export import + CSV export |
| `Dashboard.html` | Frontend: sortable/filterable table, favorites, per-game achievement detail |
| `test/` | `node --test` suite, focused on the matching rules |
| `guides/` | Example achievement guide write-ups |

## Using this with Claude Code

`.claude/skills/` has task-scoped guides (local dev conventions, Steam API quirks, checkbox-sync gotchas, guide-writing workflow) — see `PROJECT_CONTEXT.md` for the index.

## License

MIT — see [LICENSE](LICENSE). Fork it, adapt it, make it yours.
