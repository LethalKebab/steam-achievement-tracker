# Steam Achievement Tracker

Track your Steam achievement progress automatically, without babysitting a spreadsheet.

Connect your Steam account once, and every day your library and achievement progress stay up to date on their own. Browse it as a clean Google Sheet or a lightweight web Dashboard — whichever you prefer.

## What you get

- **Your whole library, always current** — every owned game, achievement counts, and completion % refresh daily with no manual updates.
- **A Dashboard for browsing** — a simple web page to skim your games, mark favorites (♥) and spotlights (★), and see progress at a glance without opening a spreadsheet.
- **A spreadsheet for digging in** — full per-achievement detail (names, descriptions, unlock status) if you want to sort, filter, or build your own views.
- **Guide links in one place** — an optional tab that points at your written achievement guides (e.g. in Notion), plus an optional daily sync that checks off guide steps as you actually unlock them in-game.
- **Handles the edge cases Steam's API can't** — shared-library games and manually-corrected entries are tracked without being overwritten by the daily sync, editable right from the Dashboard. See [Known limitations](#known-limitations) below.

It's entirely self-hosted on Google's free tier — your Sheet, your Apps Script project, your data. No accounts to make anywhere else, no service watching your library but you.

> **Heads up:** the Sheet's column headers and the Dashboard UI are in Chinese (the language this project was originally built in), not English. Nothing about setup or daily use requires reading Chinese, but expect to see it on screen — see [Sheet schema](#sheet-schema-raw-data-tab) below for the exact labels you'll actually get.

## Setup

Takes about 10 minutes, one-time.

### What you'll generate

You need 3 IDs — two from Steam, one from Google. Here's exactly where each one ends up:

| # | What | Generate at | Put it in |
|---|---|---|---|
| ① | **Steam Web API Key** | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) | Apps Script editor → **Project Settings → Script Properties** → add property `STEAM_API_KEY` |
| ② | **SteamID64** | [steamid.io](https://steamid.io) (paste your profile URL) | Apps Script editor → **Project Settings → Script Properties** → add property `STEAM_ID` |
| ③ | **Google Script ID** | Apps Script editor → **Project Settings** → copy the Script ID | Your local `.clasp.json` (copy from `.clasp.json.example` and paste it in) |

> **Never put ① or ② in source files.** The code reads them from Script Properties at runtime. The `.clasp.json` with your Script ID (③) is gitignored — it won't be committed.

**You'll also need:**
- A Google account
- [`clasp`](https://github.com/google/clasp) (`npm i -g @google/clasp`, then `clasp login`)

### Steps

1. Create a Google Sheet with a `RAW DATA` tab (see [schema](#sheet-schema-raw-data-tab) below). `ACHIEVEMENTS` and `GUIDES` tabs are created automatically the first time they're needed — no need to add them yourself.
2. In the Sheet: **Extensions → Apps Script** to create the bound script project.
3. Add your Steam credentials to the project:
   - In the Apps Script editor, go to **Project Settings** (the gear icon).
   - Under **Script Properties**, click **Add script property** and add:
     - Property: `STEAM_API_KEY` / Value: your Steam Web API key (from ① above)
     - Property: `STEAM_ID` / Value: your SteamID64 (from ② above)
4. Set up `.clasp.json` with your Script ID (from ③ above):
   ```bash
   cp .clasp.json.example .clasp.json
   # Edit .clasp.json and paste your Script ID in, then:
   clasp push
   ```
5. Run these once from the Apps Script editor (each will prompt you to authorize on first run):
   - `setup()`
   - `rebuildSheetFromApi()` — pulls your full library in
   - `createTrigger()` — turns on the daily auto-sync (2am/3am/4am, in the project's timezone — `America/Los_Angeles` by default; change it under **Project Settings → Time zone** first if you want the sync to land at specific local hours)
6. *(Optional)* **Deploy → New deployment → Web app** to get your Dashboard URL. Set **Execute as: Me** and **Who has access: Only myself** unless you specifically want to share the link — and your Steam data — with someone else. Take note of the deployment ID (`clasp deployments`), you'll use it to update the Dashboard without changing the URL: `clasp deploy -i <your-deployment-id>`.

That's it — from here it just runs.

## Sheet schema (`RAW DATA` tab)

Column meaning on the left, the actual header text you'll see on the right (most are Chinese — see the note above):

| Col | Meaning | Actual header |
|---|---|---|
| A | Status (`Unvetted`/`Manual`, see [Known limitations](#known-limitations)) | `Status` |
| B | AppID | `AppID` |
| C | Name | `游戏名` |
| D | Achieved count | `完成数` |
| E | Total achievements | `成就总数` |
| F | Completion % | `完成率` |
| G | Favorite (♥) | `喜爱` |
| H | Spotlight (★) | `重点关注` |
| I | Last updated | `成就更新日期` |
| J | Family-shared (not self-owned) | `家庭共享(非自购)` |

## Known limitations

Steam's API is the source of truth for almost everything, but a few things can't be pulled automatically and are tracked via the Status column (`A`) or the Family flag (`J`) instead:

- **`Unvetted`** (Status) — games Steam hides from the owned-games API by default. Still auto-synced, just excluded from your aggregate stats.
- **`Manual`** (Status) — for the rare case where Steam genuinely can't give *your* account real data for a game: most commonly a Family Library Sharing title that a *different* family member actually plays (Steam tracks achievements per account, not per license, so your own account will always read 0 on it). These rows are entered and edited by hand from the Dashboard, and the daily sync always skips them.
- **Family (`J`, the Dashboard's "家庭" badge)** — a separate, purely informational flag for the more common shared/gifted-game case: one *you* actually play, so Steam's API does return your real progress even though the game isn't in your owned-games list. Use this instead of `Manual` so the game keeps getting auto-synced like any other — the flag just reminds you it's not self-purchased.
- Games with no in-game achievements are left as "no achievement system," not 0/0.
- The optional Notion checkbox sync only ticks a box on an *exact* title match, to avoid ever marking the wrong achievement — guide pages with unusual formatting may need spot-checking.

## Repo layout

| File | Purpose |
|---|---|
| `steam_achievement_sync.gs` | Core daily sync + trigger setup |
| `steam_achievements_detail.gs` | Fills in full per-achievement detail |
| `steam_dashboard.gs` + `Dashboard.html` | The web Dashboard |
| `steam_guides_sync.gs` | Optional: HTTP endpoint for external tools (e.g. Claude Code) to read/write `GUIDES` and query achievement data (needs `SYNC_SECRET`, plus its own separately-configured deployment — see `CLAUDE.md` for the exact steps) |
| `steam_daily_checkbox_sync.gs` | Optional: ticks Notion guide checkboxes as you unlock achievements (needs `NOTION_TOKEN`) |
| `steam_test_debug.gs` | Steam API debugging helpers |
| `guides/` | Example achievement guide write-ups |

## Using this with Claude Code

Editing with [Claude Code](https://claude.com/claude-code)? `.claude/skills/` has task-scoped guides (deploy conventions, Notion sync gotchas, guide-writing workflow) — see `PROJECT_CONTEXT.md` for the index.

## License

MIT — see [LICENSE](LICENSE). Fork it, adapt it, make it yours.
