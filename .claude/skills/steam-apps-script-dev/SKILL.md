---
name: steam-apps-script-dev
description: Project-wide dev/deploy conventions and Steam Web API gotchas for this Google Apps Script project (clasp workflow, dual deployments, sheet schema, rate limits, debug tools). Use when touching any .gs file, deploying, or debugging a Steam API call that returns unexpected data.
---

# Steam Achievement Tracker — Apps Script project conventions

## Stack constraints

Everything here is **Google Apps Script (.gs) + native HTML/JS** — not Node/npm. No modern `import` syntax; every `.gs` file in the project shares one global scope, so functions/constants in `steam_achievement_sync.gs` (notably the `CONFIG` object) are callable from any other file without importing anything.

Secrets (`STEAM_API_KEY`, `STEAM_ID`, `SYNC_SECRET`) are never hardcoded — they're read via `PropertiesService.getScriptProperties()` at load time, set once per-project under Project Settings → Script Properties. This is what makes the repo safe to publish: cloning it and pushing to your own Apps Script project requires filling in your own properties, nothing personal ships in the code.

## Two separate deployments — don't confuse them

- **Dashboard** (`steam_dashboard.gs` + `Dashboard.html`, filename must stay exactly `Dashboard`, no extension, referenced via `HtmlService.createTemplateFromFile('Dashboard')`): access `MYSELF`, this is `appsscript.json`'s committed default.
- **Guide-sync HTTP endpoint** (`steam_guides_sync.gs`'s `doPost`): access `ANYONE_ANONYMOUS`, requires the temporary-flip-and-flip-back dance documented in [[steam-guide-sync]]. Never leave `appsscript.json` checked in with `ANYONE_ANONYMOUS` — that's the Dashboard's manifest too.

After any push, redeploy the specific deployment you changed with `clasp deploy -i <that-deploymentId>` — pushing alone updates the underlying script but not a fixed-URL deployment.

## Steam Web API quirks (verified, don't re-discover)

1. The store `appdetails` endpoint's `name` field **ignores the `l=` language param** — getting the Chinese game name requires scraping the store page HTML itself (`fetchAppNameFromStorePage`).
2. Store page scraping gets rate-limited; keep the matching regex loose (the relevant class attribute can carry multiple classes) and send an age-verification cookie to bypass age-gated games.
3. `GetPlayerAchievements` returning HTTP 400 means "no stats for this account on this game" — a normal signal, not an error, don't retry. Only 429 means real rate-limiting and warrants a retry/backoff.
4. Google Sheets cells split pasted multi-line text across rows — this is why the GUIDES table stores only links, never long text content.
5. Apps Script's `DocumentApp` API can't create a native checkable checklist — guide content lives in an external tool (Notion; pasting markdown auto-converts to checkboxes) rather than a generated Google Doc.
6. Before touching `rebuildSheetFromApi` (full table rebuild from the Steam API): it already protects manually-marked `Manual` rows (family-shared / not-owned games) from being overwritten — read that protection logic before changing it, don't reintroduce a regression.

## Debugging Steam API responses

`steam_test_debug.gs` has ready-made functions — reuse them instead of writing ad hoc `UrlFetchApp` calls:
- `debugRawAchievements()` / `debugRawAppDetails()` / `debugRawOwnedGames()` — dump raw API responses for a given appid.
- `debugCompareUnvetted()` — diff `skip_unvetted_apps=true` vs `false` to see which games Steam hides by default.
- `debugStorePageHtml()` — diagnose store-page scraping failures (status code, page length, presence of `apphub_AppName`, `<title>`).
- `debugDumpAchievementSchema()` — dump a game's full achievement schema (names/descriptions/hidden flags) for building a guide checklist by hand.

## Sheet schema (RAW DATA tab, current column order)

A=Status(Unvetted/Manual) / B=AppID / C=Name / D=Achieved count / E=Total achievements / F=Completion % / G=Favorite(♥) / H=Spotlight(★) / I=Achievements-last-updated date
