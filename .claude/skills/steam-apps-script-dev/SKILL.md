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

**If another local checkout of this same Apps Script project exists** (same `scriptId`, different folder/file set), `clasp push` will silently delete from the live project any file that's missing from the folder you're pushing from — it does not just add/update, it makes the remote match local exactly. Diff the two folders' file lists before pushing from either one. (This deleted `steam_daily_checkbox_sync.gs` from production for about an hour on 2026-08-03 before being caught.)

## Steam Web API quirks (verified, don't re-discover)

1. The store `appdetails` endpoint's `name` field **ignores the `l=` language param** — getting the Chinese game name requires scraping the store page HTML itself (`fetchAppNameFromStorePage`).
2. Store page scraping gets rate-limited; keep the matching regex loose (the relevant class attribute can carry multiple classes) and send an age-verification cookie to bypass age-gated games.
3. `GetPlayerAchievements` returning HTTP 400 means "no stats for this account on this game" — a normal signal, not an error, don't retry. Only 429 means real rate-limiting and warrants a retry/backoff; everything else (including 403, below) should also be retried next cycle rather than treated as permanent.
4. `GetPlayerAchievements` can return HTTP **403** `"Profile is not public"` for one specific game even when the account's overall profile is public — that's a per-game "Game Details" privacy toggle on Steam's side, not fixable in code. Retrying is pointless until the privacy setting changes on Steam itself.
5. A game can vanish from `GetOwnedGames` entirely (delisted free titles, lapsed family-sharing access) while `GetPlayerAchievements` still returns its full permanent stats forever. Absence from `GetOwnedGames` ≠ "no achievement data exists" — always check `GetPlayerAchievements` directly before concluding a game can't be tracked.
6. Determining whether Steam currently classifies an *owned* appid as Unvetted requires the exact two-call comparison `fetchOwnedGamesWithUnvettedFlag()` does (`skip_unvetted_apps=false` minus `=true`) — a single plain `GetOwnedGames` call silently defaults to the vetted-only view and won't tell you this. `debugCompareUnvetted()` below already wraps it correctly.
7. Family Sharing achievements are recorded per **playing** account, not per license owner. If a shared game is actually played on a different family member's account, `GetPlayerAchievements` for *your* configured `STEAM_ID` will correctly and permanently show 0 progress on it — expected behavior, not a bug to chase.
8. Google Sheets cells split pasted multi-line text across rows — this is why the GUIDES table stores only links, never long text content.
9. Apps Script's `DocumentApp` API can't create a native checkable checklist — guide content lives in an external tool (Notion; pasting markdown auto-converts to checkboxes) rather than a generated Google Doc.
10. **`'Manual'` status does two unrelated jobs, and this bites people:** `runBatch` skips a row purely on `Status === 'Manual'`; separately, `rebuildSheetFromApi()` re-stamps `'Manual'` onto any appid found in `manualStatusAppIds` specifically to override Steam's live Unvetted classification on rebuild. For an *owned* game, `'Manual'` is the only way to lock it against Unvetted flip-flopping, but that also kills its daily achievement sync — there's no way to get one without the other today. What actually determines whether a row *survives* `rebuildSheetFromApi()` is unrelated to Status — it's purely `!ownedAppIdSet.has(appid)`, so a non-owned (family-shared) row is preserved regardless of whether Status is `'Manual'`, `'Unvetted'`, or empty. `hardResetFromApi()` has no such preservation at all and drops every non-owned row unconditionally — confirm before running it. Column J (`FAMILY_COL`, see schema below) exists precisely to let a row be "not self-owned" *and* normally auto-synced at the same time, which Status alone can't express.

## Debugging Steam API responses

`steam_test_debug.gs` has ready-made functions — reuse them instead of writing ad hoc `UrlFetchApp` calls:
- `debugRawAchievements()` / `debugRawAppDetails()` / `debugRawOwnedGames()` — dump raw API responses for a given appid.
- `debugCompareUnvetted()` — diff `skip_unvetted_apps=true` vs `false` to see which games Steam hides by default.
- `debugStorePageHtml()` — diagnose store-page scraping failures (status code, page length, presence of `apphub_AppName`, `<title>`).
- `debugDumpAchievementSchema()` — dump a game's full achievement schema (names/descriptions/hidden flags) for building a guide checklist by hand.

## Sheet schema (RAW DATA tab, current column order)

A=Status(Unvetted/Manual) / B=AppID / C=Name / D=Achieved count / E=Total achievements / F=Completion % / G=Favorite(♥) / H=Spotlight(★) / I=Achievements-last-updated date / J=Family-shared(not self-owned)

Column J is a plain informational boolean, fully decoupled from Status — it never affects `runBatch`/`rebuildSheetFromApi` behavior. Toggle it from the Dashboard's "家庭" badge, or via the `migrateFamilyGames` HTTP action in `steam_guides_sync.gs`. See quirk #10 above for why it's a separate column instead of another Status value.
