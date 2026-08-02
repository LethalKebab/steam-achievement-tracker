# Steam Achievement Tracker

A self-hosted system for automatically tracking your Steam achievement progress. Steam's API is the source of truth for almost everything — but a few edge cases (see [Known limitations](#known-limitations-manual-data) below) fall outside what the API can tell you, and those rows are handled manually by design, not automatically.

It's three pieces, all free, all yours to host:

1. **A Google Sheet** — the single source of truth. A `RAW DATA` tab (one row per owned game: appid, name, achieved/total counts, completion %, favorite/spotlight flags), plus an `ACHIEVEMENTS` tab (full per-achievement detail, EN+localized name/description) and a `GUIDES` tab (just links out to wherever you keep written guides, e.g. Notion).
2. **Google Apps Script** — the automation backend, bound to that Sheet. Pulls from the Steam Web API on a daily trigger, no server to run or pay for.
3. **A web Dashboard** — an Apps Script Web App (plain HTML/JS), deployed to its own URL, for browsing/favoriting/spotlighting games without opening the spreadsheet.

Everything runs inside Google's free tier. No secrets are committed to this repo — you provide your own Steam API key and (optionally) Notion integration token as Apps Script *Script Properties*, never as code.

## Setup

### 1. Prerequisites
- A Google account (for the Sheet + Apps Script)
- A Steam Web API key: https://steamcommunity.com/dev/apikey
- Your SteamID64: https://steamid.io
- [`clasp`](https://github.com/google/clasp) installed (`npm i -g @google/clasp`) and logged in (`clasp login`)

### 2. Create the Sheet + Apps Script project
1. Create a new Google Sheet. Add a tab named `RAW DATA` with a header row (see schema below); add empty `ACHIEVEMENTS` and `GUIDES` tabs if you plan to use those features.
2. In the Sheet: **Extensions → Apps Script** to create the bound script project.
3. Note the project's Script ID (**Project Settings** in the Apps Script editor), then locally:
   ```bash
   cp .clasp.json.example .clasp.json
   # edit .clasp.json and paste your Script ID in
   clasp push
   ```

### 3. Configure secrets (Script Properties, not code)
In the Apps Script editor: **Project Settings (gear icon) → Script Properties**, add:
| Property | Value |
|---|---|
| `STEAM_API_KEY` | your Steam Web API key |
| `STEAM_ID` | your SteamID64 |
| `SYNC_SECRET` | a random string you generate yourself (e.g. `openssl rand -hex 32`) — only needed if you use the optional HTTP guide-sync endpoint |

If you want the optional Notion checkbox auto-sync (`steam_daily_checkbox_sync.gs`), also add `NOTION_TOKEN` — see `.claude/skills/steam-daily-checkbox-sync/SKILL.md` for the full setup.

### 4. Bootstrap the sheet
In the Apps Script editor, run these functions once (Apps Script will prompt you to authorize on first run):
1. `setup()`
2. `rebuildSheetFromApi()` — pulls your full owned-games list and fills the sheet
3. `createTrigger()` — installs the daily sync trigger so it stays current automatically

### 5. Deploy the Dashboard (optional)
**Deploy → New deployment → Web app**, execute as yourself, access "Only myself" (or "Anyone" if you want to share the read-only dashboard link). Visit the deployment URL.

## Repo layout

| File | Purpose |
|---|---|
| `steam_achievement_sync.gs` | Core sync: `runBatch`/`syncNewGames`/`rebuildSheetFromApi`, trigger setup |
| `steam_achievements_detail.gs` | Bulk-fetches full per-achievement detail into `ACHIEVEMENTS` |
| `steam_dashboard.gs` + `Dashboard.html` | Dashboard backend + frontend (filename must stay exactly `Dashboard`) |
| `steam_guides_sync.gs` | Optional: HTTP endpoint for syncing external guide links into `GUIDES` |
| `steam_daily_checkbox_sync.gs` | Optional: daily job that ticks Notion guide-page checkboxes to match real unlock state |
| `steam_test_debug.gs` | Steam API debugging helpers |
| `guides/` | Example achievement guide write-ups (Markdown, checkbox format) |

## Sheet schema (`RAW DATA` tab)

`A`=Status (`Unvetted`/`Manual` flag) · `B`=AppID · `C`=Name · `D`=Achieved count · `E`=Total achievements · `F`=Completion % · `G`=Favorite (♥) · `H`=Spotlight (★) · `I`=Achievements-last-updated date

## Known limitations (manual data)

This is "mostly automatic," not "100% automatic" — a few situations genuinely can't be resolved from the Steam API alone, and the Status column (`A`) is how the sheet tracks that:

- **`Unvetted`** — games Steam's `GetOwnedGames` hides by default (its own "unvetted"/limited-profile-features flag). Auto-detected, excluded from your aggregate completion stats, but otherwise still auto-synced like any other row.
- **`Manual`** — rows the automation has been told to leave alone, added via `addManualGame()` rather than discovered from the owned-games API. Real cases where this comes up:
  - **Family Library Sharing** games. Steam's API only reports games *you* own, not ones shared to you — a shared game's achievement counts have to be entered/updated by hand, since there's no API call that returns them.
  - **Data you've manually corrected** because it drifted from the API for some reason and you don't want the next sync to stomp your correction.
  - `rebuildSheetFromApi()` (a full table rebuild) explicitly protects `Manual` rows from being overwritten or dropped — that protection is load-bearing, don't remove it without a replacement plan for these cases.
- **Achievement counts reflect whatever Steam itself reports** — if `GetPlayerAchievements` returns HTTP 400 for a game, that means Steam has no stats for it on your account (common for games with no achievement-tracking, or that you haven't launched), and the row is left as "no achievement system" rather than 0/0.
- **The optional Notion checkbox sync is intentionally conservative**: it only ticks a checkbox when an achievement's title is an *exact* match to a title segment on the guide page (see `.claude/skills/steam-daily-checkbox-sync/SKILL.md`). A guide page that doesn't follow the expected title-formatting convention will under-sync (skip real unlocks) rather than risk ticking the wrong box — if you use this feature, expect to spot-check pages that don't fit the standard format.

## Using this with Claude Code

If you're editing this project with [Claude Code](https://claude.com/claude-code), `.claude/skills/` has task-scoped guides (deploy conventions, the Notion sync gotchas, the achievement-guide-writing workflow, Steam API quirks) instead of one giant context file — see `PROJECT_CONTEXT.md` for the index.

## License

MIT — see [LICENSE](LICENSE). Fork it, adapt it, make it yours.
