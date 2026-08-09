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

There is a **third** variant that exact matching cannot fix, found 2026-08-03: some games contain two distinct achievements with *identical* names in both languages. 鬼谷八荒 has two `妙手空空 / Skilled Thief` (steal stealthily 10× — unlocked; clear game + steal 100× — not unlocked). The unlocked one's checkbox was already ticked and therefore out of the candidate pool, so its achievement matched the *other*, still-unearned checkbox. `findAmbiguousNames()` now refuses any name shared by several achievements unless *all* of them are unlocked, and logs the skip. Re-measured 2026-08-09: **13 collisions across 12 games** — CK3, Civ VI, Cities: Skylines, PUBG, 古剑奇谭二 (two), 雨世界, Plague Inc, Farm Together, Sword and Fairy 6, 了不起的修仙模拟器, 鬼谷八荒, 犹格索托斯的庭院 — so this gate is load-bearing, not defensive clutter. Count collisions by achievement pair, not by name string: a bilingual pair (`妙手空空` / `Skilled Thief`) is one collision seen twice, and counting strings returns a misleading 15.

Only **4** of those 12 have a registered guide (CK3, Civ VI, 鬼谷八荒, Plague Inc), and all four already quote unique official descriptions, so the description-first pass resolves them. The other 8 cost nothing until someone writes a guide for them — worth re-checking with the ambiguity query if a new guide lands for one.

**Most collisions are localization bugs, not real same-names.** Only 3 of the 12 collide in *both* languages (鬼谷八荒, 古剑奇谭二, 了不起的修仙模拟器); 8 are Chinese-side bugs with distinct English names (Civ VI `Frenemy`/`Frenemies`, Plague Inc `Nano-Virus Master`/`Bioweapon Master`, Farm Together differing only by apostrophe glyph…), and 犹格索托斯的庭院 is the reverse — four achievements whose `name_en` is the placeholder `Text`.

That distinction has teeth because **`isAmbiguous()` is per-achievement, not per-name**: if *either* name is in `unsafeNames`, the achievement skips name matching entirely, so a unique English name goes unused. Verified — a box reading exactly `Nano-Virus Master` does not match, even though that string is not in `unsafeNames`. Those guides tick only via their description quotes. Narrowing the gate to the specific colliding name would recover the signal without weakening the equality rule; it has not been done, and it touches the code with the worst false-positive history in the project, so treat it as a decision rather than a cleanup.

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
node tracker.js checkbox-sync --dry-run # read-only preview — ALWAYS do this first
node tracker.js checkbox-sync 3117820   # one game
node tracker.js checkbox-sync           # every eligible game
node tracker.js log 30                  # what it did (also in the sync_log table)
```

Every run — change, skip, or failure — is appended to the `sync_log` table (the old "Sync Log" sheet tab) for after-the-fact auditing.

## The automatic path (`serve`)

Since the auto-tick wiring, `checkboxSync` also runs from `lib/server.js` — once when `serve` starts and again after every 「立即同步」 click, chained onto the end of `startBackgroundSync()`. That is the **only** place in the project that writes to Notion without a `--dry-run` in front of it, so it is deliberately narrowed:

- `appids` whitelist — only games whose `achieved`/`total` moved in that run (`stats.changedAppids`, fed by the new `gained` flag from `updateGameStats`) plus guide pages registered for the first time that run. Empty whitelist means zero external calls, and `appids: []` must never be read as "no filter" — see `selectCheckboxCandidates`.
- `cascade: false` by default (`config.checkboxSyncOnServeCascade`), because the cascade is the one deliberately over-ticking path and the automatic route has no human gate.
- Errors never propagate — they land in `syncState.tickError` and show as a Dashboard notice, separate from `syncState.error`, so a dead Notion token doesn't present as "achievement sync failed".
- Kill switch: `config.checkboxSyncOnServe: false`.

## Guide page status (`node tracker.js guide-status`)

`syncGuideStatuses` keeps the Notion page's `Status` in step with completion, both ways: 100% → `Done`, below 100% → `Staged` (a patch added achievements). Also chained into the serve path after the tick pass (`guideStatusOnServe`) — that order matters, so a just-completed game gets its last boxes ticked before the page reads done.

**Convergence, not transition.** Both rules are stated over current state, never over "a game that just crossed 100%". The crossing exists only inside the one sync that writes it; a run that observes it but can't write loses it forever, since later runs see the same value on both sides. This isn't theoretical — the one page needing demotion (Supermarket Together, 28/51) has `new_ach_date = NULL`, so a rule keyed on "we saw `total` grow" would never fire for it. Idempotency is pinned in `test/guide-status.test.js`: the pass runs on every Dashboard open, so a non-idempotent rule means repeated Notion writes.

**Asymmetric by design.** Promotion overwrites everything but `Done`, `Differed` included. Demotion touches **only** `Done` — other sub-100% statuses are the user's workflow state, and rewriting them every run would make user and tool fight. Both are pinned.

Property name/type/options come from `fetchGuideStatusSchema`, never hardcoded: Notion's `status` and `select` are distinct types with different write payloads (`{status:{name}}` vs `{select:{name}}`) and the wrong shape is rejected. Both `Done` and `Staged` are validated up front. This workspace's is `Status`, type `status`, options `Not started / Staged / Paused / In progress / Differed / Done`.

`test/checkbox-selection.test.js` pins the candidate rules. Two of them are easy to break and fail silently: the empty-whitelist semantics above, and the rule that a game which *just* hit 100% is still visited (otherwise the completing achievement's box can never be ticked — by the next run the game is at 100% and gets skipped forever).

## Known structural cases

- Pages with no `to_do` blocks at all (an external spreadsheet link, a pure walkthrough with no checklist) are skipped and logged — expected, not a bug.
- Nested sub-checkboxes that are *conditions of* one achievement (not separate achievements) will be considered for matching; they just won't match anything, since matching requires exact equality with an achievement name.
- Achievements living in nested Notion child pages are handled via a title-regex (`成就|achievement`) recursive search in `fetchAllToDoBlocks`. Unrelated child pages are deliberately not searched.
- `child_database` and `link_to_page` blocks are skipped entirely — a Notion database with a "Done" checkbox *property* needs different logic (update page properties, not blocks) and isn't supported.
- One appid uses exactly one backend. Markdown discovery won't clobber a registered Notion guide without `--force`.
