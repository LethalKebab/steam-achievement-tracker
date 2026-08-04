---
name: steam-guide-sync
description: Read/write the Notion GUIDES table (appid <-> guide link) and pull authoritative Steam achievement data via the steam_guides_sync.gs HTTP endpoint. Use when matching game names to appids, upserting guide links, adding a manually-tracked game, or fetching a game's unlocked/full achievement list for guide-writing.
---

# Steam guide-sync HTTP endpoint

`steam_guides_sync.gs`'s `doPost(e)` is a **separate, standalone Web App deployment** (not the Dashboard deployment) meant for HTTP calls from Claude Code — not `clasp run` (that needs a bound GCP project). Auth is a `SYNC_SECRET` token, stored in Script Properties (never in source) and as sensitive as the Steam API key: never commit it or paste it into chat.

## Available actions (all reuse existing functions in steam_guides_sync.gs — don't rewrite them)

- `listOwnedGames` — every appid+name in RAW DATA. Use to match a game name to its appid.
- `listGuideRows` — current GUIDES table rows (appid/name/link/updated date).
- `upsertGuideLinks(entries)` — batch write/update guide links, matched by appid. `entries: [{appid, name, url}]`.
  **Must overwrite column B (name) together with the link/date, not just the link** — otherwise renamed games never get their name column fixed. (Already fixed once; don't regress.)
- `addManualGame(entry)` — adds a RAW DATA row with `Status=Manual` (family-shared / not in the Steam owned list). `entry: {appid, name, achieved?, total?}`. Errors if appid already exists — never overwrites.
- `setGameStatus(appid, status)` — directly corrects a row's Status (column A). `status` is `''`/`'Unvetted'`/`'Manual'`.
- `migrateFamilyGames(appids)` — batch-reclassifies appids from `Manual` to the family-shared pattern: clears Status (hands the row back to `runBatch`) and checks column J (`FAMILY_COL`). Use when a `Manual` row turns out to have real achievement data after all — see `PROJECT_CONTEXT.md`'s "已经踩过的坑" for the diagnostic method.
- `getUnlockedAchievements(appid)` — only the **unlocked** achievements for an appid, zh+en names/descriptions, from the ACHIEVEMENTS table. Use for "sync Steam's real unlock state into a Notion checkbox page."
- `getAllAchievementsForGame(appid)` — **all** achievements for an appid with real `achieved` booleans on each. Use for "rewrite/author an achievement guide from scratch." Errors if ACHIEVEMENTS has no row for this appid yet — run `syncAchievementSchema` first.
- `deleteGuideRow(appid)` — removes a row from GUIDES by appid. Only removes the first match — if duplicate rows share an appid, call it once per duplicate.
- `syncGuidesFromNotion` — no payload. Queries the Notion "Overview" database in full, matches pages to GUIDES by a normalized Notion page ID (not raw URL text — Notion sometimes prefixes URLs with a title slug, which makes the same page's URL differ between calls), and for any page not yet linked, reads its content for a leading `appid: NNNNNN` line and upserts it into GUIDES via `upsertGuideLinks`. Installed as a **daily 7am trigger** via `installAutoGuideSyncTrigger` (below) — usually you don't need to call this manually. A page with no `appid:` line is silently skipped every run, not retried with an error; it needs the guide actually written first (see `achievement-guide-writing` skill).
- `installAutoGuideSyncTrigger` — no payload. (Re)installs the daily 7am trigger for `syncGuidesFromNotion`, replacing any existing one for that handler. One-time setup call.

Adding a new action = add the function to `steam_guides_sync.gs` + wire it into the `doPost` switch, then redeploy (see below).

## Deploying changes to this endpoint

This deployment's access must be `ANYONE_ANONYMOUS` (so it works without a browser login), while `appsscript.json`'s `webapp.access` defaults to `MYSELF` (that default is for the Dashboard's own separate deployment). Every time you change this endpoint's code:

1. Temporarily set `access` to `ANYONE_ANONYMOUS` in `appsscript.json`
2. `clasp push`
3. `clasp deploy -i <this-endpoint's-deploymentId>`
4. Set `access` back to `MYSELF`
5. `clasp push` again

Skipping this dance either breaks the endpoint's permissions or accidentally makes the Dashboard's own production deployment public — don't shortcut it.

## Calling the endpoint over HTTP

Apps Script Web App POST requests return a 302 redirect to `script.googleusercontent.com/macros/echo?...`. **The redirect must be followed with GET, not POST** (that echo endpoint just returns an already-computed result; a POST there 405s). `curl -L` / `--post302`-style tools mishandle this. In PowerShell, use `HttpClientHandler(AllowAutoRedirect=false)`, read the `Location` header, then issue your own GET — and set UTF-8 explicitly on both request and response to avoid mangling Chinese text.
