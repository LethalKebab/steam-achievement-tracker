# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Steam achievement auto-tracker, running **entirely locally**: SQLite data store + Node CLI + a local HTTP server for the HTML Dashboard. Tracks achievement completion across the user's whole Steam library.

User-facing docs live in `docs/` (`configuration.md`, `data.md`, `guides.md`); `README.md` is deliberately setup-only. Task-scoped guides for specific jobs are in `.claude/skills/`.

## Stack constraints

- **Zero dependencies, by design.** Node built-ins only: `node:sqlite` for storage, global `fetch` for HTTP, `node:http` for the server, `node:test` for tests. Do not add an npm dependency without a strong reason — "no install step" is a feature of this project, not an accident.
- Requires **Node 24+** (`node:sqlite` availability).
- ES modules (`"type": "module"`).

## Development workflow

```bash
node tracker.js <command>   # everything is a subcommand; see tracker.js header or `node tracker.js help`
node --test                 # test suite (test/matching.test.js)
node --check lib/foo.js     # syntax check
```

Commit messages are Chinese or English, whichever suits the change. This is settled — don't raise it.

There is no build, no push, no deploy. Editing a file and re-running the command is the whole loop. `serve` does not hot-reload — restart it after changing `lib/` (`Dashboard.html` and `lib/rpc.js` are re-read per request, so a browser refresh picks those up).

## File architecture

| File | Role |
|---|---|
| `tracker.js` | CLI dispatch: `init`, `sync`, `serve`, `status`, `guides`, `checkbox-sync`, `import`, `export`, `log` |
| `lib/config.js` | `config.json` load/save, env-var overrides, required-field errors with setup hints |
| `lib/db.js` | SQLite schema + all table accessors. `openDb()` is idempotent (safe `CREATE TABLE IF NOT EXISTS`) |
| `lib/steam.js` | `SteamClient`: owned games (+Unvetted diff), player achievements, schema, name lookup, store search |
| `lib/sync.js` | `syncLibrary` → `syncAchievementStats` → `syncAchievementSchema`, `fullSync`, `computeAgcrStats` |
| `lib/server.js` | HTTP server (127.0.0.1 only), `/api/*` dispatch, background sync state + staleness check, guide discovery on start |
| `lib/api.js` | The 10 Dashboard methods. **Names and return shapes must match what `Dashboard.html` calls** |
| `lib/rpc.js` | Served at `/_rpc.js`. Proxies `rpc.…` chains to `fetch('/api/…')`, plus the sync status bar |
| `lib/guides.js` | Achievement↔checkbox matching (both directions), both guide backends, guide discovery, `auditGuideTicks` |
| `lib/notion.js` | Notion API client, page-ID normalization, `to_do` block walking |
| `lib/markdown.js` | Local markdown guide backend (`- [ ]` → `- [x]`), indentation → `parent` linkage, path containment check |
| `lib/csv.js` | CSV parse/serialize, spreadsheet import, CSV export |
| `Dashboard.html` | Frontend SPA. Reads via `rpc.getDashboardData()`, renders a sortable/filterable table |
| `docs/` | User-facing docs: `configuration.md`, `data.md`, `guides.md`. README stays setup-only — put reference material here |

### The frontend ↔ backend contract

`Dashboard.html` makes 11 calls shaped like `rpc.withSuccessHandler(fn).withFailureHandler(fn).method(args)`, served by `lib/rpc.js`. **Keep the contract:** a method that returns `{error: '...'}` is a *successful* call (the frontend inspects `result.error` itself); only network/thrown failures reach the failure handler. Adding a Dashboard method means adding it to `lib/api.js` — `rpc.js` proxies any name and needs no changes.

## Key config

`config.json` (gitignored, mode 600), read via `lib/config.js`. Env vars `STEAM_API_KEY` / `STEAM_ID` / `NOTION_TOKEN` / `PORT` override it.

- `steamApiKey` / `steamId` — required for anything touching Steam
- `language` (default `schinese`) — affects game and achievement names
- `port` (8777), `syncStaleHours` (12, `0` disables sync-on-open), `requestDelayMs` (300)
- `notion.token`, `notion.overviewDbId` — guide sync only. The DB ID used to be hardcoded in source; it's config now.

**Never hardcode credentials, and never commit `config.json` or `data/`.** Both are gitignored. The repo is public.

## Data model (`games` table)

`appid` (PK) / `name` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` / `priority` / `family` / `new_ach_date` / `updated_at`

- `status`: `''` (normal), `'Unvetted'` (Steam Profile Features Limited), `'Manual'` (hand-maintained).
- `has_achievements = 0` replaces the old `'N/A'` string in the numeric total column. `NULL` means "not synced yet".
- **`sync_locked` is what the sync actually checks**, not `status`. They are separate columns because "skip the daily achievement sync" and "pin this row's label against Steam re-classifying it Unvetted" are different wishes — conflate them and you cannot have one without the other. The Dashboard moves both together (`setManualStatus` sets both); diverge them by hand when you actually want to.
- `family` is purely informational and never affects sync behavior. It exists because "not in `GetOwnedGames`" and "should skip achievement sync" are two *different* facts.

## Sync behavior

`fullSync` runs three phases in order over the whole library, with no cursor and no runtime cap. Ctrl+C mid-run is safe — each game is committed as it completes, so re-running only redoes work that was in flight.

1. **`syncLibrary`** — new owned games get inserted (with a name lookup); existing *owned* rows get their `Unvetted` stamp refreshed, except `'Manual'` ones. Rows whose appid is **not** in the current `GetOwnedGames` snapshot are left completely untouched — that's the preservation rule (it keys off ownership, not `status`).
2. **`syncAchievementStats`** — every row with `sync_locked = 0` gets its counts refreshed. A total higher than last time stamps `new_ach_date` (the Dashboard's "new achievements" badge).
3. **`syncAchievementSchema`** — per-achievement detail for games that are new to the `achievements` table or bumped in the last 7 days; skips games at exactly 100% and games with no achievement system.

**`serve` also runs guide discovery on start** (`syncGuides()` in `lib/server.js`, off via `syncGuidesOnServe: false`) — the same work as `node tracker.js guides`. It is deliberately **outside** the `syncStaleHours` gate and needs no Steam credentials: a guide page created minutes after a sync must show its Dashboard link immediately, and gating it on staleness would hide new pages for hours. `fullSync` itself does **not** touch guides — a new Notion page will never be discovered by achievement syncing alone, which is why this hook exists at all. Failures are logged and swallowed; a dead Notion token must not take the Dashboard down with it.

There is deliberately no destructive rebuild/reset command. `syncLibrary` reconciles against Steam without discarding rows, and a "wipe and repopulate from `GetOwnedGames`" helper would silently drop every family-shared and manually-maintained row — data the API cannot give back.

## Steam API quirks

These are verified and hard-won — don't re-derive them, and don't "simplify" the handling:

- `GetPlayerAchievements` HTTP **400** = this game genuinely has no stats for this account. A normal signal, **not** an error, do not retry.
- HTTP **429** = real rate limiting, retry next cycle. Everything else non-200 is also treated as transient.
- HTTP **403** `"Profile is not public"` can come back for *one specific game* even when the profile is public — a per-game "Game Details" privacy toggle on Steam's side. Falls in the retry bucket, but retrying never succeeds until the setting changes on Steam.
- `appdetails`'s `name` field **ignores the `l=` param** (Steam bug) — Chinese names require scraping the store page HTML (`fetchAppNameFromStorePage`), with age-verification cookies and a deliberately loose regex (the class attribute can carry multiple classes).
- Determining whether an owned appid is currently Unvetted **requires two `GetOwnedGames` calls** (`skip_unvetted_apps=false` minus `=true`). A single plain call silently returns the vetted-only view. `fetchOwnedGamesWithUnvettedFlag()` is the only correct way to ask.
- `GetOwnedGames` omits free games unless `include_played_free_games=true` (already set).
- A game can disappear from `GetOwnedGames` while `GetPlayerAchievements` keeps returning its full permanent stats. "Not owned" ≠ "no achievement data" — check achievements directly before concluding a game can't be tracked.
- Family Sharing achievements are recorded per **playing** account. If a shared game is actually played on someone else's account, your `steamId` will correctly and permanently show 0 on it. Not a bug to chase.

## Guide checkbox matching — do not loosen this

Matching an unlocked achievement to a guide checkbox is **exact equality against extracted title candidate segments**. Never substring, never prefix. Three rounds of false positives produced this rule:

1. an achievement name appearing inside an unrelated achievement's *description*;
2. a short achievement name being a strict *prefix* of a different, harder achievement's name — which mis-ticked the harder one once the short one's own box was already checked; and
3. **two achievements in the same game with genuinely identical names.** Exact matching cannot fix this one: the unlocked twin's box gets ticked, leaves the candidate pool, and the same name then matches the *other*, still-unearned box. `findAmbiguousNames()` therefore refuses any name shared by several achievements unless *all* of them are unlocked, and logs the skip rather than staying silent. This is not rare — a 310-game library had 12 such collisions across 11 games.

`extractTitleCandidates()` splits checkbox text into candidates (by line, then by colon/dash, plus the `中文名(English Name)` pattern) and requires the achievement name to *equal* one of them. Adding a new candidate-extraction rule is fine; weakening the equality check or removing the ambiguity gate is not. `test/matching.test.js` pins all three failure modes — run `node --test` after touching `lib/guides.js`.

**The one way out of case 3 is the description.** `matchAchievements` runs two passes: ambiguous names first, resolvable *only* by the checkbox quoting the achievement's full description when that description is unique in the game (then the box is unambiguously about that achievement); then exact name matching for everything else. Description-first is deliberate — it is the more precise signal, so it claims its box before name matching could take it. This is why the guide-writing convention is `**name**` / verbatim official description / your own notes, and why paraphrasing the description has a real cost. See `.claude/skills/achievement-guide-writing/SKILL.md`.

The design deliberately prefers a missed checkbox over a wrong one.

**Always `checkbox-sync --dry-run` before a real run.** Ticking a Notion box can't be undone automatically, and failure mode 3 above was caught by a dry run before it wrote anything. Sync only ever ticks, never unticks, so it cannot repair its own mistakes.

### Nested sub-step checkboxes (`collectSubStepTicks`)

Guides nest sub-steps under an achievement — individual shrines, individual techniques, one line per side-quest. Two things were true and both were wrong:

1. **The backends disagreed.** `loadTodos`'s regex is `/^\s*[-*]\s*\[/`, so local markdown always read indented boxes; `fetchAllToDoBlocks` pushed a `to_do` and `continue`d, so Notion never descended into one. Identical guide content behaved differently by backend. Notion now recurses, and both backends set `parent` on each todo (Notion: the enclosing to-do's block id; markdown: inferred from an indentation stack). Containers like `toggle` pass `parent` through unchanged — a checkbox inside a toggle inside an achievement is still that achievement's sub-step.
2. **Sub-steps could never be auto-ticked.** They aren't achievements; Steam has no data for them and their names match nothing. Name matching can't reach them, ever.

So `collectSubStepTicks` ticks them by **inheritance**: if the parent achievement is known unlocked, its nested boxes get ticked. Evidence of "known unlocked" is only ever (a) a match made this run, or (b) an already-ticked box that `resolveTodoToAchievement` maps to a uniquely-identified, genuinely unlocked achievement. Without (b) the feature would be useless — most achievements were ticked in earlier runs.

**This is the one place in the codebase that prefers over-ticking, and it is deliberately inconsistent with the rule above.** The assumption "parent unlocked ⇒ every listed sub-step was done" holds for *all-of* achievements ("fail every technique at least once") and **fails for *any-of* achievements** — "reach an ending" with nine endings listed underneath would falsely tick eight. The code cannot distinguish them. Mitigations, all of which should stay: cascade is skippable with `--no-cascade`, every cascaded tick is logged as `已勾选子步骤(父成就已解锁)` so `sync_log` can be re-read afterwards, and `--dry-run` lists them separately. If you write a guide whose sub-steps are alternatives rather than requirements, don't nest them under the achievement.

Two consequences elsewhere. `checkboxSync` will consider a 100%-complete game when cascade is on — all achievements unlocked is exactly when sub-steps are most likely ticked-worthy — **but only if that game has rows in `achievements`**, because recognising a parent needs `resolveTodoToAchievement`, which needs names/descriptions. `syncAchievementSchema` deliberately skips games at exactly 100%, and measured against the real database **55 of 55** guide-having perfect games have no schema at all. Widening the filter unconditionally cost 55 wasted page reads plus 55 Steam calls per run and could never tick anything; the `achievementsFor(...).length > 0` guard keeps the candidate count at 42 and starts including a perfect game automatically if its schema ever gets synced. Second, `auditGuideTicks` ignores ticked sub-step boxes that resolve to no achievement — counting them as "undetermined" would drown the one number that measures real audit coverage. A nested box that *does* resolve to an achievement is still audited normally.

## Reverse lookup (the `audit` command)

`checkbox-sync` asks "where does this achievement go?"; `audit` asks the opposite — "which achievement is this ticked box about, and is it actually unlocked?" That's `resolveTodoToAchievement()`, and it accepts only two unambiguous handles: the achievement's full description when unique in the game, or a name that maps to exactly one achievement. Anything else is reported as undetermined rather than guessed, and **the undetermined count is always printed** — "0 wrong" would otherwise imply coverage the audit doesn't have.

**Never map by description *prefix*.** A first draft of this matched the first 14 characters, which collapses tiered achievement families ("deal 100/500/1000 damage", "fill in every page of X's report card"): a correctly-ticked easy tier gets attributed to its locked harder sibling. On real data that produced 4 false findings out of 5 — the same bug class as the name-prefix one above, in a different disguise. `test/matching.test.js` pins the tiered-family case.

## Don't cry wolf in the log

When the sync can't act, think about whether that's *actionable* before logging it. Ambiguous-name groups whose boxes are already correctly ticked used to log "needs manual review" on every single run — a permanent false alarm, which is worse than no alarm because it trains you to ignore the log. `nameGroupAlreadySatisfied()` now silences those, and they speak up again if a second same-named achievement gets unlocked without its box ticked.

That helper uses loose substring matching, which is banned in the tick path. The distinction is intentional and commented at the call site: **it decides whether to print a line, never whether to write.** Getting it wrong costs one log line; getting the tick path wrong corrupts the user's notes. Keep new heuristics on the correct side of that line.

## Known pitfalls

- **Games with `has_achievements = 0` are retried on every sync**, not permanently excluded. They get re-marked if Steam still says no stats; harmless.
- **`sync_locked = 1` rows are never touched by any sync phase.** If a row "won't update," check that first.
- **Notion page identity must use the normalized UUID**, never raw URL text — Notion sometimes prefixes URLs with a title slug, so the same page's URL differs between queries. Comparing raw URLs once caused already-linked pages to be treated as new and overwrite curated names (`normalizeNotionId` in `lib/notion.js`).
- **One appid, one guide backend.** Markdown discovery won't overwrite a registered Notion guide unless `--force`.
- **Local guide paths are contained to `guidesDir`** (`resolveGuidePath`). Keep that check if you touch it — `guides.url` is data.
- **Documentation drifting from code is a real failure mode here.** A secret once sat hardcoded in this public repo for months while three separate docs claimed it was read from config, because nobody checked the source. Verify against code, not docs.
- **`localDate()` not `toISOString().slice(0,10)`** for user-facing dates — the latter is UTC and will be off by a day in the evening.
- **Guide text never goes in the database** — only a pointer. Guides have to stay human-editable and tickable where they live; the `guides` table tracks *where*, never *what*.

## Current state and open items

The core pipeline (library sync, achievement counts, achievement detail, Dashboard, ♥/★ flags) is done and in daily use. Guide sync works against both backends, Notion is configured, and the whole guide corpus has been audited.

**Verified baseline as of 2026-08-04** — re-derive rather than trust if a lot has changed since, but don't redo this work blindly:

- `checkbox-sync --dry-run` across all eligible games proposes **0** ticks, and `audit` reports **0** confirmed-wrong out of ~1,175 ticked boxes. Notion and Steam agree.
- **~65 ticked boxes are permanently undetermined** by `audit` (out of ~1,240). They paraphrase the official description instead of quoting it, so the reverse lookup can't attribute them. They tick fine by name; they just can't be verified. Fixing that means editing those guide pages, not the code.
- **Three boxes were ticked wrongly and have been un-ticked** (Civ VI 亦敌亦友, CK3 春风得意, 古剑奇谭 新年快乐) — recorded in `sync_log` as `人工修正`. The first two were same-name mis-ticks; don't be surprised by un-ticks in the log's history.
- **Same-name guide formatting is already handled:** Civ VI and CK3 already quote descriptions verbatim, and 鬼谷八荒's two `妙手空空` boxes were rewritten from suffixed names to name + verbatim description. All three now resolve correctly and will tick automatically when a second twin unlocks. **Don't "fix" these pages again.**

Known outstanding items:

- **Guides not yet written** — these pages exist in the Notion guide database but have no `appid:` line yet, so guide discovery skips them every run (expected, not an error): Xenoblade Chronicles X, 三相奇谈, 以闪亮之名, 最强祖师, 月圆之夜, 燕云十六声.
- **A duplicate Notion page** for 苏丹的游戏 (the older one, URL contains `1d31fee6…`) needs deleting by hand.
- **Leftover spreadsheet automation** — a few daily jobs still update an old Google Sheet as a secondary backup. When they're no longer wanted, delete them from that project's Apps Script triggers page; run `node tracker.js export` first, since the sheet stops updating afterwards.
- **Ideas, not commitments** — write the missing guides, enrich the Dashboard, or add a launchd plist if sync-on-open isn't enough.

## Working on this efficiently

1. **Bulk repetitive external calls are disproportionately expensive.** Notion has no batch-update API, so "add one line to forty pages" is forty round trips — and each one carries the whole conversation history. Before starting that kind of job, say roughly how many calls it will take and offer to do it in a fresh session.
2. **Rule of thumb for a fresh session:** if the content to read/write clearly exceeds what's already in context, or the task is purely repetitive and needs no history, suggest starting clean. Small one-off edits are fine inline.
3. **Verification beats assumption.** A successful tool call does not mean the content is right — see the Notion page-ID and documentation-drift pitfalls above. Re-read results after bulk writes or overwrites, and prefer a read-only preview (`--dry-run`, a SELECT) before anything that writes outside this repo.

