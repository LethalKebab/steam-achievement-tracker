# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Steam Achievement Tracker — a Google Apps Script project that auto-syncs a Google Sheet with Steam API achievement data and serves a web Dashboard. Managed with `clasp`; all `.gs` files in the project share one global scope (no `import`/`require`).

## Common commands

```bash
clasp push        # Push local .gs/.html changes to the bound Apps Script project
clasp pull        # Pull remote changes (if any were made in the web editor)
clasp deploy -i <deploymentId>  # Redeploy a specific deployment after code changes
clasp open        # Open the Apps Script project in the browser
```

After `clasp push`, code is live immediately for script functions, but Web App deployments (Dashboard, guide-sync endpoint) need a separate `clasp deploy -i <id>` to update their fixed URLs.

## Architecture: two separate Web App deployments

The project has TWO independent Web App deployments, both built from the same Apps Script project but serving different audiences and access levels:

1. **Dashboard** (`steam_dashboard.gs` + `Dashboard.html`) — `doGet(e)`, access `MYSELF`. The user-facing dashboard.
2. **Guide-sync HTTP endpoint** (`steam_guides_sync.gs`'s `doPost(e)`) — access `ANYONE_ANONYMOUS`. Called by Claude Code to sync guide links and fetch achievement data.

`appsscript.json`'s `webapp.access` defaults to `MYSELF` (for the Dashboard). Deploying the guide-sync endpoint requires a temporary flip-and-restore dance:
1. Set `webapp.access` to `ANYONE_ANONYMOUS` in `appsscript.json`
2. `clasp push` → `clasp deploy -i <guideSyncDeploymentId>`
3. Set `webapp.access` back to `MYSELF` → `clasp push` again

Never leave `appsscript.json` checked in with `ANYONE_ANONYMOUS`.

## Secrets

All secrets live in Script Properties (`Project Settings → Script Properties` in the Apps Script editor), never in code:

| Property | Used by |
|---|---|
| `STEAM_API_KEY` | Core sync (all Steam API calls) |
| `STEAM_ID` | Core sync (SteamID64) |
| `SYNC_SECRET` | Guide-sync HTTP endpoint auth |
| `NOTION_TOKEN` | Daily checkbox sync (Notion Internal Integration) |

`clasp push` does NOT push Script Properties — they stay in the bound project.

## Steam API quirks (verified, don't re-discover)

1. `store.steampowered.com/api/appdetails`'s `name` field **ignores the `l=` param** — Chinese names require scraping the store page HTML (`fetchAppNameFromStorePage`).
2. Store-page scraping rate-limits aggressively; send an age-verification cookie or age-gated games return empty pages.
3. `GetPlayerAchievements` returning HTTP 400 = "no stats for this account" (normal signal, don't retry). Only HTTP 429 is real rate-limiting.
4. The Google Sheets UI splits pasted multi-line text across cells — why GUIDES stores only links, never long text.

## Sheet schema (RAW DATA tab)

Col A=Status (Unvetted/Manual) · B=AppID · C=Name · D=Achieved count · E=Total achievements · F=Completion % · G=Favorite (♥) · H=Spotlight (★) · I=Achievements-last-updated date

Data starts at row 2 (row 1 = headers). AppID is the primary key.

## Critical: achievement name matching is exact-match only

When matching Steam achievement names to Notion guide-page checkboxes, **only exact equality against a title-candidate segment** is allowed — never substring or prefix matching. Two rounds of false positives (substring match hitting an unrelated description; prefix match grabbing a different, harder achievement's checkbox) were only resolved by `extractTitleCandidates_()` in `steam_daily_checkbox_sync.gs`. See `[[feedback_achievement_exact_match]]` in memory for the full history. Any tool touching this Notion data must follow this rule.

## Guide page format constraint

Each achievement line in a Notion guide must follow this exact format (name and description joined by full-width colon `：`, no line break between them):
```
- [x/ ] 成就中文名：成就描述。**攻略提示**：提示内容（难度：X）
```
Breaking this format silently breaks the daily checkbox sync, which uses a colon within a single line as a title/description boundary for exact-match candidate extraction.

## Where to find more detail

- `PROJECT_CONTEXT.md` — project background, file responsibilities, lessons learned
- `.claude/skills/steam-apps-script-dev/` — clasp conventions, debugging tools, full schema
- `.claude/skills/steam-guide-sync/` — HTTP endpoint usage, deployment dance, HTTP client gotchas
- `.claude/skills/steam-daily-checkbox-sync/` — checkbox sync setup, name-matching algorithm, known structural cases
- `.claude/skills/steam-achievement-guide-writing/` — guide authoring workflow, verification checklist
- `README.md` — user-facing setup instructions and repo layout
