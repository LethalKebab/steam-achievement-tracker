---
name: steam-daily-checkbox-sync
description: Set up, debug, or reason about the automated daily job (steam_daily_checkbox_sync.gs) that ticks Notion guide-page checkboxes based on real Steam unlock state. Use when installing/uninstalling the trigger, auditing the Sync Log tab, or investigating a mismatched/missing checkbox.
---

# Daily automatic checkbox sync (steam_daily_checkbox_sync.gs)

Fully automated, no Claude Code involvement once installed — ticks Notion `to_do` checkboxes on guide pages to match real Steam achievement unlock state, once a day.

## How it decides which games to sync

Not by Notion's Status property (Staged/Paused/Done). It uses RAW DATA's own "completed count < total achievements" (and skips games with no achievement system). Re-running against an already-100%/Done game is a harmless no-op, so there's no need to query Notion's Status first.

## Name-matching: exact match only, never substring/prefix

See [[feedback_achievement_exact_match]] (global memory) for the full incident history. Summary: two rounds of false positives (an achievement name appearing as a substring inside an unrelated achievement's description; a short achievement name being a strict prefix of a different, harder achievement's name) were only fully fixed by `extractTitleCandidates_`, which splits each checkbox's text into title *candidate segments* (split on `<br>` first, then on the first colon/dash within a line) and requires the achievement name to **exactly equal** one candidate segment. Partial/substring/prefix matching on this data will reintroduce both bug classes — do not reach for it again, here or in any other tool touching this Notion data.

This design deliberately prefers a missed checkbox (no match found) over a wrong one (matched to the wrong achievement).

## Setup (independent of Claude Code's Notion MCP — this script calls the Notion API directly)

1. Create an Internal Integration at notion.so/my-integrations (e.g. "Steam Achievement Sync"), copy its secret token.
2. In the Apps Script editor: Project Settings (gear icon) → Script Properties → add `NOTION_TOKEN` = that token. **Never put this token in the .gs source** — script properties aren't pushed by `clasp push`.
3. In Notion, open the shared parent page of all guide pages (e.g. "Entertainment") → `•••` → Connections → add the integration once; all child pages inherit access.

## Usage

- Test one game first: run `testSyncOneGameCheckboxSync('<appid>')` in the Apps Script editor, check the **Sync Log** tab and execution logs.
- Once confirmed: run `installDailyCheckboxSyncTrigger()` — installs a daily 08:00 (project timezone) trigger for `dailyCheckboxSync`. Safe to re-run to change the time; it clears the old trigger first, never stacks duplicates.
- Stop it with `uninstallDailyCheckboxSyncTrigger()`.
- Every run (change, skip, or failure) is appended to the **Sync Log** tab for after-the-fact auditing.

## Known structural cases

- Pages with no `to_do` blocks at all (an external spreadsheet link, or a pure walkthrough with no achievement checklist) are skipped — expected, not a bug.
- Nested sub-checkboxes that are *conditions of* one achievement (not separate achievements) must be excluded when counting — they'll make totals look off if counted as independent achievements.
- Achievements living in nested child pages are handled via a title-regex (`成就|achievement`) recursive page search in `fetchAllToDoBlocks_`.
