---
name: steam-guide-sync
description: Read/write the Notion GUIDES table (appid <-> guide link) and pull authoritative Steam achievement data via the steam_guides_sync.gs HTTP endpoint. Use when matching game names to appids, upserting guide links, adding a manually-tracked game, or fetching a game's unlocked/full achievement list for guide-writing.
---

# Steam guide-sync HTTP endpoint

`steam_guides_sync.gs`'s `doPost(e)` is a **separate, standalone Web App deployment** (not the Dashboard deployment) meant for HTTP calls from Claude Code — not `clasp run` (that needs a bound GCP project). Auth is a `SYNC_SECRET` token, as sensitive as the Steam API key: never commit it or paste it into chat.

## Available actions (all reuse existing functions in steam_guides_sync.gs — don't rewrite them)

- `listOwnedGames` — every appid+name in RAW DATA. Use to match a game name to its appid.
- `listGuideRows` — current GUIDES table rows (appid/name/link/updated date).
- `upsertGuideLinks(entries)` — batch write/update guide links, matched by appid. `entries: [{appid, name, url}]`.
  **Must overwrite column B (name) together with the link/date, not just the link** — otherwise renamed games never get their name column fixed. (Already fixed once; don't regress.)
- `addManualGame(entry)` — adds a RAW DATA row with `Status=Manual` (family-shared / not in the Steam owned list). `entry: {appid, name, achieved?, total?}`. Errors if appid already exists — never overwrites.
- `getUnlockedAchievements(appid)` — only the **unlocked** achievements for an appid, zh+en names/descriptions, from the ACHIEVEMENTS table. Use for "sync Steam's real unlock state into a Notion checkbox page."
- `getAllAchievementsForGame(appid)` — **all** achievements for an appid with real `achieved` booleans on each. Use for "rewrite/author an achievement guide from scratch." Errors if ACHIEVEMENTS has no row for this appid yet — run `syncAchievementSchema` first.

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
