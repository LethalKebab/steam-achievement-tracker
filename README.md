# Steam Achievement Tracker

Track your Steam achievement progress automatically, without babysitting a spreadsheet — and without a Google account, a deployment step, or a single npm install.

Point it at your Steam account once. Your library and achievement progress live in a local SQLite file, and a local web Dashboard shows it all at a glance.

> **Coming from the Google Apps Script version?** It's been replaced — this is the same tool rebuilt to run entirely on your own machine. See [Migrating from the Sheet version](#migrating-from-the-sheet-version) to bring your ♥/★/family/Manual markers across, and [What changed](#what-changed-from-the-apps-script-version) for the full mapping. The old implementation is still in history at `7e29470` if you'd rather keep using it.

## What you get

- **Your whole library, always current** — every owned game, achievement counts, and completion % refreshed by one command (or automatically when you open the Dashboard).
- **A Dashboard for browsing** — the same web UI as before: skim your games, mark favorites (♥) and spotlights (★), see progress at a glance. Now served from `localhost` instead of a Google deployment.
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

That's the whole setup. There's no Sheet to create, no Apps Script editor, no `clasp`, no OAuth consent screen, no deployment, and no trigger installation.

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

**Scheduling is deliberately absent.** Opening the Dashboard triggers a background sync when the data is more than `syncStaleHours` (default 12) old, and `sync` is there when you want it now. Set `syncStaleHours: 0` in `config.json` to disable the automatic one. Note the tradeoff: unlike the old 2am/3am/4am Apps Script triggers, nothing runs while your machine is asleep — sync happens when you show up. If you'd rather have a real daily job, a launchd plist calling `node tracker.js sync` gets you there.

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

## Migrating from the Sheet version

Your ♥ favorites, ★ spotlights, family-shared flags, `Manual` rows and hand-entered achievement counts **cannot be recovered from Steam's API** — they only exist in your old Sheet. Bring them over before you start:

1. In the Google Sheet, for each of the `RAW DATA`, `ACHIEVEMENTS`, and `GUIDES` tabs: **File → Download → Comma-separated values (.csv)**.
2. Put all three CSVs in one folder.
3. `node tracker.js import ~/Downloads/steam-csvs`

Import reads by column position (not header text), understands `TRUE`/`FALSE`, `45.00%`, and `N/A`, and is idempotent — re-running it after fixing something in the Sheet just overwrites those columns again. Then run `node tracker.js sync` to refresh everything Steam *can* tell you.

## Data

`data/steam.db` — one SQLite file, gitignored. Open it with anything (`sqlite3 data/steam.db`):

| Table | Was | Holds |
|---|---|---|
| `games` | `RAW DATA` tab | one row per appid: name, achieved/total, rate, status, ♥/★/family flags |
| `achievements` | `ACHIEVEMENTS` tab | per-achievement detail, CN + EN names, hidden flag, icon URL |
| `guides` | `GUIDES` tab | appid → guide location, plus `kind` (`notion` or `local`) |
| `sync_log` | `Sync Log` tab | every checkbox change/skip/failure, for after-the-fact auditing |
| `meta` | Script Properties | last sync timestamp |

Two intentional differences from the Sheet schema:

- **No `'N/A'` string in a numeric column.** Games with no achievement system have `has_achievements = 0` and `NULL` counts.
- **`Manual` is split in two.** `status` is what you see and sort by; `sync_locked` is what actually makes the sync skip a row. They move together from the Dashboard, so nothing changes day to day — but the old "you can't lock a row against Unvetted flip-flopping without also killing its daily sync" bind (documented at length in the old `CLAUDE.md`) is now just `UPDATE games SET sync_locked = 0`.

Want a spreadsheet again for ad-hoc poking? `node tracker.js export` writes the three tables back out as CSV.

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
| `lib/rpc-shim.js` | Turns `google.script.run` into `fetch` so `Dashboard.html` needed no rewrite |
| `lib/guides.js` | Achievement↔checkbox matching rules + both guide backends |
| `lib/notion.js`, `lib/markdown.js` | The two guide backends |
| `lib/csv.js` | Sheet-export import + CSV export |
| `Dashboard.html` | Frontend, unchanged from the Apps Script version apart from one `<script>` tag |
| `test/` | `node --test` suite, focused on the matching rules |
| `guides/` | Example achievement guide write-ups |

## What changed from the Apps Script version

| Was | Now |
|---|---|
| Google Sheet (3 tabs + Sync Log) | `data/steam.db` (SQLite) |
| Script Properties | `config.json` / env vars |
| `HtmlService` + `google.script.run` | `node:http` + `POST /api/<method>` (via `lib/rpc-shim.js`) |
| 5 time-based triggers (2/3/4/7/8am) | sync-on-open + `node tracker.js sync` |
| `runBatch` cursor + 4.5-minute cap | one full pass — the cap only existed for Apps Script's 6-minute limit |
| `clasp push` / two deployments / access-swap dance | *nothing* |
| `steam_guides_sync.gs` HTTP endpoint + `SYNC_SECRET` | *nothing* — read `data/steam.db` or use the CLI directly |
| `steam_test_debug.gs` | plain `node -e` against `lib/steam.js` |

The old Apps Script implementation is still in git history — the last commit before the port is `7e29470`:

```bash
git show 7e29470:steam_achievement_sync.gs   # read a single old file
git checkout 7e29470                         # or check out the whole old tree
```

## Using this with Claude Code

`.claude/skills/` has task-scoped guides (local dev conventions, Steam API quirks, checkbox-sync gotchas, guide-writing workflow) — see `PROJECT_CONTEXT.md` for the index.

## License

MIT — see [LICENSE](LICENSE). Fork it, adapt it, make it yours.
