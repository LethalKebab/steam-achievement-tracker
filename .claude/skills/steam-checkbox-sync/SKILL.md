---
name: steam-checkbox-sync
description: Set up, debug, or reason about the checkbox sync (node tracker.js checkbox-sync) that ticks guide checkboxes — in Notion or local markdown — based on real Steam unlock state. Use when configuring the Notion token, auditing the sync_log table, or investigating a mismatched/missing checkbox.
---

# Checkbox sync (`node tracker.js checkbox-sync [appid]`)

Ticks guide checkboxes to match real Steam achievement unlock state. Two backends, same matching rules: **Notion** `to_do` blocks (the primary setup) and **local markdown** `- [ ]` lines. Implemented in `lib/guides.js` (`checkboxSync` → `syncGameCheckboxes`), backends in `lib/notion.js` / `lib/markdown.js`.

Pass an appid to do just one game — that's the replacement for the old `testSyncOneGameCheckboxSync()`, and it's the right way to try things before running the whole library.

## How it decides which games to sync

Not by Notion's Status property (Staged/Paused/Done). It uses the local `games` row's own "achieved < total" (and skips games with no achievement system, and anything without a `guides` entry). Re-running against an already-100% game is a harmless no-op, so there's no need to consult Notion's Status first.

## Name-matching: exact match only, never substring/prefix

See [[feedback_achievement_exact_match]] (global memory) for the incident history. Summary: two rounds of false positives —

1. an achievement name appearing as a substring inside an unrelated achievement's *description*, and
2. a short achievement name being a strict *prefix* of a different, harder achievement's name, which mis-ticked the harder one once the short one's own box was already checked

— were only fully fixed by `extractTitleCandidates()`, which splits each checkbox's text into title *candidate segments* and requires the achievement name to **exactly equal** one of them. Partial/substring/prefix matching on this data reintroduces both bug classes. **Do not reach for it again, here or in any other tool touching this data.**

Candidate segments are split by: line breaks (including literal `<br>`), then the first colon or dash within a line (half-width ` - ` and full-width ` — ` / ` – ` / `——`), plus the whole string, plus — for the `中文名(English Name)` shape common in the local markdown guides — the Chinese and English halves separately. Adding a new *extraction* rule is fine; weakening the *equality* check is not.

`test/matching.test.js` pins both historical failure modes plus the extraction rules. **Run `node --test` after touching `lib/guides.js`.**

The design deliberately prefers a missed checkbox (no match found) over a wrong one.

## Setup

**Notion backend** (needs a token — this is the only part of the project that talks to a third party):

1. Create an Internal Integration at notion.so/my-integrations (e.g. "Steam Achievement Sync"), copy its secret.
2. Put it in `config.json` as `notion.token`, or export `NOTION_TOKEN`. **Never in source** — the repo is public.
3. Also set `notion.overviewDbId` to the database holding your guide pages (open it in Notion; the 32-hex chunk in the URL).
4. In Notion, open the shared parent page of all guide pages (e.g. "Entertainment") → `•••` → Connections → add the integration once; child pages inherit access. Without this, the API returns 404/no-permission.

**Local markdown backend**: no token, no setup. Drop a `.md` file in `guides/` with an `appid: NNNNNN` line near the top and run `node tracker.js guides --local`.

## Usage

```bash
node tracker.js checkbox-sync 3117820   # one game — start here
node tracker.js checkbox-sync           # every eligible game
node tracker.js log 30                  # what it did (also in the sync_log table)
```

Every run — change, skip, or failure — is appended to the `sync_log` table (the old "Sync Log" sheet tab) for after-the-fact auditing. Nothing is scheduled: this runs when you run it.

## Known structural cases

- Pages with no `to_do` blocks at all (an external spreadsheet link, a pure walkthrough with no checklist) are skipped and logged — expected, not a bug.
- Nested sub-checkboxes that are *conditions of* one achievement (not separate achievements) will be considered for matching; they just won't match anything, since matching requires exact equality with an achievement name.
- Achievements living in nested Notion child pages are handled via a title-regex (`成就|achievement`) recursive search in `fetchAllToDoBlocks`. Unrelated child pages are deliberately not searched.
- `child_database` and `link_to_page` blocks are skipped entirely — a Notion database with a "Done" checkbox *property* needs different logic (update page properties, not blocks) and isn't supported.
- One appid uses exactly one backend. Markdown discovery won't clobber a registered Notion guide without `--force`.
