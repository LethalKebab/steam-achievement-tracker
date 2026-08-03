# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Steam achievement auto-tracker: Google Sheet (data store) + Google Apps Script (backend, multiple `.gs` files) + HTML Dashboard (frontend). Tracks achievement completion across the user's entire Steam library.

See `PROJECT_CONTEXT.md` for full background, task lists, and known issues.

## Development workflow

```bash
clasp push     # Push local .gs/.html files to Apps Script (does NOT preserve triggers)
clasp pull     # Pull latest from Apps Script
```

- All `.gs` files in the project share a single global scope in Apps Script — functions call each other across files without imports.
- This is NOT a Node.js project. No `import`/`export`, no `require`, no npm.
- After `clasp push`, triggers persist but if you recreate them, run `createTrigger()` in the Apps Script editor.
- The script is bound to a Google Sheet. `SpreadsheetApp.getActive()` is the entry point to all sheet operations.

## File architecture

| File | Role |
|---|---|
| `steam_achievement_sync.gs` | Core sync: `runBatch()` (daily cursor-based achievement refresh), `syncNewGames()`, `updateRowForGame()`, `rebuildSheetFromApi()`/`hardResetFromApi()`, Steam API wrappers, trigger setup |
| `steam_achievements_detail.gs` | `syncAchievementSchema()` — pulls full achievement definitions (CN+EN) into ACHIEVEMENTS sheet |
| `steam_dashboard.gs` | `doGet()` serves Dashboard; `getDashboardData()`, `searchSteamGames()`, `addGame()`, `deleteGame()`, `toggleFavorite()`, `togglePriority()`, `setManualStatus()`, `setManualAchievements()`, `toggleFamily()`, `getMissingAchievements()` |
| `Dashboard.html` | Frontend SPA — reads via `google.script.run.getDashboardData()`, renders sortable/filterable table |
| `steam_guides_sync.gs` | Separate Web App (`doPost`) for HTTP-based remote calls (Notion↔GUIDES sync, plus RAW DATA read/fix actions — `listOwnedGames`, `addManualGame`, `setGameStatus`, `migrateFamilyGames`, `getUnlockedAchievements`, `getAllAchievementsForGame`). Deployed with `ANYONE_ANONYMOUS` access |
| `steam_daily_checkbox_sync.gs` | Independent daily trigger (`dailyCheckboxSync`, installed via `installDailyCheckboxSyncTrigger()`): auto-checks Notion guide checkboxes for achievements unlocked on Steam. Calls Notion's API directly using a `NOTION_TOKEN` Script Property (not in source). See file header for exact-match rules. |
| `steam_test_debug.gs` | Debug helpers for raw Steam API inspection |

## Key config

Defined in `steam_achievement_sync.gs` `CONFIG` object:
- `STEAM_API_KEY` / `STEAM_ID` — real credentials (never commit publicly)
- `SHEET_NAME: 'RAW DATA'` — primary data sheet
- `HEADER_ROW: 2` — data starts at row 2
- `MAX_RUNTIME_MS: 4.5 * 60 * 1000` — per-trigger time cap

## RAW DATA sheet layout

A=Status / B=AppID / C=Game Name / D=Achieved / E=Total / F=Rate / G=Favorite(♥) / H=Priority(★) / I=New Ach Date / J=Family-shared (not self-owned)

Status values: empty (normal), `'Unvetted'` (Steam Profile Features Limited), `'Manual'` (hand-added, never auto-synced by `runBatch`).

Column J (`FAMILY_COL`) is a plain informational boolean, fully decoupled from Status — it never affects sync behavior. It exists because "not in `GetOwnedGames`" and "should skip achievement auto-sync" are two *different* facts that Status alone can't represent (see "Manual vs Unvetted are two separate concerns" below). Toggle it from the Dashboard's "家庭" badge, or via the `migrateFamilyGames` HTTP action.

## Daily triggers

Set up by `createTrigger()`:
- `runBatch` at 2am — cycles through all games, updates achievement counts
- `syncNewGames` at 3am — detects and adds newly owned games
- `syncAchievementSchema` at 4am — refreshes ACHIEVEMENTS detail sheet

Triggers use a **cursor** (stored in ScriptProperties) to resume where the last run left off. `runBatch` wraps around when it reaches the end.

## Deployment notes

There are **two** separate Web App deployments. Use `clasp deploy -i <id>` to update in-place (keeps the same URL). Never use bare `clasp deploy` — it creates a new deployment with a new URL.

| Deployment | Access | Purpose |
|---|---|---|
| Dashboard | `MYSELF` | Browser Dashboard (`doGet`) |
| Guides sync | `ANYONE_ANONYMOUS` | HTTP endpoint (`doPost`) |

Get your deployment IDs with `clasp deployments` after creating each one via the Apps Script editor (Deploy → New deployment → Web app).

**After any Dashboard change** (HTML or `steam_dashboard.gs`):
```bash
clasp push
clasp deploy -i <your-dashboard-deployment-id>
```

**After any Guides sync change** (see procedure below — requires access swap):
```bash
# Edit appsscript.json: change access to ANYONE_ANONYMOUS
clasp push
clasp deploy -i <your-guides-sync-deployment-id>
# Edit appsscript.json: change access back to MYSELF
clasp push
```

To update the Guides endpoint: temporarily set `webapp.access` to `ANYONE_ANONYMOUS` in `appsscript.json` → push → deploy → change back to `MYSELF` → push again. If you skip the access swap, the Dashboard deployment will also become public, or the Guides endpoint won't work for HTTP calls.

## Steam API quirks

- `GetPlayerAchievements` returns HTTP **400** = game genuinely has no stats for this account. All other non-200 codes are treated as transient and retried.
- `GetPlayerAchievements` returns HTTP **403** `"Profile is not public"` for a *specific game* even when the overall Steam profile is public — this is a per-game "Game Details" privacy toggle on Steam's side, not a code bug and not fixable here. It falls into the same "treated as transient, retried" bucket as any other non-200/non-400 code, but retrying will never succeed until the privacy setting is changed on Steam itself (Edit Profile → Privacy Settings).
- `appdetails` JSON endpoint's `name` field ignores `l=` param (Steam bug) — `fetchAppName()` falls back to scraping the store page HTML for Chinese titles.
- Store page scraping needs age-verification cookies (`birthtime`, `mature_content`, etc.).
- `GetPlayerAchievements` 429 = rate limit, retried. 400 = no stats, marked N/A. Everything else (403 included) = retried next cycle.
- A game can vanish from `GetOwnedGames` entirely (e.g. a small free title gets delisted, or family-sharing access to it lapses) while `GetPlayerAchievements` still returns its full, permanent stats forever. "Not in `GetOwnedGames`" does **not** imply "no real achievement data" — always check `GetPlayerAchievements` directly before assuming a game can't be tracked.
- Determining whether Steam currently classifies an *owned* appid as "Unvetted" requires replicating `fetchOwnedGamesWithUnvettedFlag()`'s exact two-call comparison (`skip_unvetted_apps=false` minus `skip_unvetted_apps=true`) — a single plain `GetOwnedGames` call does not tell you this, and silently defaults to the vetted-only view. `steam_test_debug.gs`'s `debugCompareUnvetted()` already does exactly this — run that instead of re-deriving it with raw API calls.
- Family Sharing achievements are recorded per **playing** account, not per license owner. If a shared game is actually played by a different family member's Steam account, `CONFIG.STEAM_ID`'s `GetPlayerAchievements` call will correctly and permanently show 0 progress on it — that's not a bug to fix, it's the only account this tool can ever see.

## Known pitfalls

- **Games marked `'N/A'`** (column E) are retried every `runBatch` cycle — not permanent. They get `'N/A'` again if Steam still says no stats; harmless.
- **`'Manual'` status** games are never touched by `runBatch` or `syncNewGames`.
- **`sortSheetByCompletion()`** changes physical row order. The cursor is a row index, so sorting shifts which game the cursor points to. This self-corrects after a full cycle.
- **Multi-line paste** into Google Sheets splits into multiple rows — GUIDES sheet only stores URLs to avoid this.
- **Apps Script `DocumentApp`** can't create native checkable checklists — guides live in Notion, not Google Docs.
- **A one-off tool called `detectAndLockManualEdits()` (deleted 2026-08-03, was `steam_detect_manual_edits.gs`) is almost certainly why so many non-owned games ended up incorrectly `'Manual'` in the first place** — it unconditionally locked any appid not in `GetOwnedGames` to `'Manual'`, with no check for whether `GetPlayerAchievements` could still return real data for it. If a similar "auto-lock non-owned rows" script ever gets rewritten, it must check achievement data first, not just ownership — that's the whole reason `FAMILY_COL` exists now instead.
- **`'Manual'` vs Unvetted-lock are two different concerns that currently share one flag.** `runBatch` skips a row purely on `Status === 'Manual'`. Separately, `rebuildSheetFromApi()` re-stamps `'Manual'` onto any row whose appid is found in `manualStatusAppIds` *specifically to override Steam's live Unvetted classification* ([steam_achievement_sync.gs:121](steam_achievement_sync.gs)). That means for a game you **own**, setting `'Manual'` is the only way to lock it against Unvetted flip-flopping — but doing so also disables its daily achievement sync, with no way to get one without the other today. If you need both, that requires a real code change (a separate lock column), not just clearing/setting Status.
- **What actually survives `rebuildSheetFromApi()` is *not* Status.** The preservation rule is purely `!ownedAppIdSet.has(appid)` — any row whose appid isn't in the current `GetOwnedGames` snapshot gets carried over verbatim, regardless of whether Status is `'Manual'`, `'Unvetted'`, or empty. So clearing `'Manual'` on a non-owned (e.g. family-shared) row does **not** put it at risk of being dropped on rebuild.
- **`hardResetFromApi()` has zero preservation for anything** — it rewrites the whole sheet purely from `GetOwnedGames`, silently dropping every family-shared/manual/non-owned row regardless of Status. Confirm before ever running it; there's no flag that protects a row from it.
- **The `(dev)` and non-`(dev)` project folders are two separate git repos pointing at the same Apps Script `scriptId`.** `clasp push` does not preserve files that exist live but not in the folder you're pushing from — it silently deletes them from the live project. Before pushing from either folder, diff its file list against the other; a file present only in the sibling folder (e.g. `steam_daily_checkbox_sync.gs`, which as of 2026-08 exists in both) can be wiped from production by a routine push from the other side. When in doubt, `clasp pull` into a throwaway scratch folder first to see what's actually live.
