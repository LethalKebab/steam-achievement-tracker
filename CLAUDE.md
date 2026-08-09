# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Steam achievement auto-tracker, running **entirely locally**: SQLite data store + Node CLI + a local HTTP server for the HTML Dashboard. Tracks achievement completion across the user's whole Steam library.

User-facing docs live in `docs/` (`configuration.md`, `data.md`, `guides.md`). `README.md` covers **setup and everyday use** — including "What runs when", the trigger/cadence table for the automatic jobs, since knowing what the tool does on its own is part of using it day to day. Reference material (every config option, the data model, how matching works) goes in `docs/`. Task-scoped guides for specific jobs are in `.claude/skills/`.

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
| `tracker.js` | CLI dispatch: `init`, `sync`, `serve`, `status`, `guides`, `checkbox-sync`, `guide-status`, `audit`, `import`, `export`, `log` |
| `lib/config.js` | `config.json` load/save, env-var overrides, required-field errors with setup hints |
| `lib/db.js` | SQLite schema + all table accessors. `openDb()` is idempotent (safe `CREATE TABLE IF NOT EXISTS`) |
| `lib/steam.js` | `SteamClient`: owned games (+Unvetted diff), player achievements, schema, name lookup, store search |
| `lib/sync.js` | `syncLibrary` → `syncAchievementStats` → `syncAchievementSchema`, `fullSync`, `computeAgcrStats` |
| `lib/server.js` | HTTP server (127.0.0.1 only), `/api/*` dispatch, background sync state + staleness check, guide discovery on start, auto checkbox tick after each sync |
| `lib/api.js` | The 11 Dashboard methods. **Names and return shapes must match what `Dashboard.html` calls** |
| `lib/rpc.js` | Served at `/_rpc.js`. Proxies `rpc.…` chains to `fetch('/api/…')`, plus the sync status bar |
| `lib/guides.js` | Achievement↔checkbox matching (both directions), both guide backends, guide discovery, `auditGuideTicks`, `syncGuideStatuses` |
| `lib/notion.js` | Notion API client, page-ID normalization, `to_do` block walking, status-property read/write |
| `lib/markdown.js` | Local markdown guide backend (`- [ ]` → `- [x]`), indentation → `parent` linkage, path containment check |
| `lib/csv.js` | CSV parse/serialize, spreadsheet import, CSV export |
| `Dashboard.html` | Frontend SPA. Reads via `rpc.getDashboardData()`, renders a sortable/filterable table |
| ↳ row order | Two pin layers over the chosen sort: **★ priority beats 🎮 recently-played** — the manual choice always outranks the automatic signal. `RECENT_PLAY_DAYS` (14) governs both the pin and the badge; keep them on one constant or a row can sort to the top with nothing explaining why. Recently-played rows sort by `playedDaysAgo` among themselves. |
| `docs/` | User-facing docs: `configuration.md`, `data.md`, `guides.md`. README covers setup + everyday use; reference material goes here |

### The frontend ↔ backend contract

`Dashboard.html` makes 12 calls shaped like `rpc.withSuccessHandler(fn).withFailureHandler(fn).method(args)`, served by `lib/rpc.js`. **Keep the contract:** a method that returns `{error: '...'}` is a *successful* call (the frontend inspects `result.error` itself); only network/thrown failures reach the failure handler. Adding a Dashboard method means adding it to `lib/api.js` — `rpc.js` proxies any name and needs no changes.

## Key config

`config.json` (gitignored, mode 600), read via `lib/config.js`. Env vars `STEAM_API_KEY` / `STEAM_ID` / `NOTION_TOKEN` / `PORT` override it.

- `steamApiKey` / `steamId` — required for anything touching Steam
- `language` (default `schinese`) — affects game and achievement names
- `port` (8777), `syncStaleHours` (12, `0` disables sync-on-open), `requestDelayMs` (300)
- `sweepBudget` (40), `maxStatsAgeDays` (7), `perfectGameMaxAgeDays` (3) — phase 2 sampling, see "Sync behavior". Only the Dashboard auto-sync and `sync --fast` read these; plain `sync` ignores them.
- `checkboxSyncOnServe` (true), `checkboxSyncOnServeCascade` (false) — the automatic tick pass, see "Automatic checkbox ticking". The cascade default deliberately differs from the CLI's.
- `guideStatusOnServe` (true) — keep a guide page's `Status` in step with completion in both directions, see "Guide page status".
- `notion.token`, `notion.overviewDbId` — guide sync only. The DB ID used to be hardcoded in source; it's config now.

**Never hardcode credentials, and never commit `config.json` or `data/`.** Both are gitignored. The repo is public.

## Data model (`games` table)

`appid` (PK) / `name` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` / `priority` / `family` / `new_ach_date` / `updated_at` / `last_played` / `stats_checked_at`

- `status`: `''` (normal), `'Unvetted'` (Steam Profile Features Limited), `'Manual'` (hand-maintained).
- `has_achievements = 0` replaces the old `'N/A'` string in the numeric total column. `NULL` means "not synced yet".
- **`sync_locked` is what the sync actually checks**, not `status`. They are separate columns because "skip the daily achievement sync" and "pin this row's label against Steam re-classifying it Unvetted" are different wishes — conflate them and you cannot have one without the other. The Dashboard moves both together (`setManualStatus` sets both); diverge them by hand when you actually want to.
- `family` is purely informational and never affects sync behavior. It exists because "not in `GetOwnedGames`" and "should skip achievement sync" are two *different* facts.
- **`last_played` / `stats_checked_at` are the sampling state for phase 2** (see below). `last_played` is `rtime_last_played` as of the last *successful* read; `stats_checked_at` is when that read happened. `updated_at` cannot substitute — it moves on any row change, including a ♥ toggle from the Dashboard, so it can't answer "when did we last ask Steam". Written by `markStatsChecked()`, never on a `retry`.
- New columns need `ALTER TABLE`, not just an edit to `SCHEMA`. `SCHEMA` is `CREATE TABLE IF NOT EXISTS` and does nothing to an existing table — `migrate()` in `lib/db.js` walks `ADDED_COLUMNS` against `PRAGMA table_info`. Add to **both** when adding a column.

## Sync behavior

`fullSync` runs three phases in order over the whole library, with no cursor and no runtime cap. Ctrl+C mid-run is safe — each game is committed as it completes, so re-running only redoes work that was in flight.

1. **`syncLibrary`** — new owned games get inserted (with a name lookup); existing *owned* rows get their `Unvetted` stamp refreshed, except `'Manual'` ones. Rows whose appid is **not** in the current `GetOwnedGames` snapshot are left completely untouched — that's the preservation rule (it keys off ownership, not `status`).
2. **`syncAchievementStats`** — refreshes counts for rows with `sync_locked = 0`. A total higher than last time stamps `new_ach_date` (the Dashboard's "new achievements" badge). **Which rows get checked is decided by `selectStatsTargets()` — see "Phase 2 sampling" below.**
3. **`syncAchievementSchema`** — per-achievement detail for games that are new to the `achievements` table or bumped in the last 7 days; skips games at exactly 100% and games with no achievement system.

**`serve` also runs guide discovery on start** (`syncGuides()` in `lib/server.js`, off via `syncGuidesOnServe: false`) — the same work as `node tracker.js guides`. It is deliberately **outside** the `syncStaleHours` gate and needs no Steam credentials: a guide page created minutes after a sync must show its Dashboard link immediately, and gating it on staleness would hide new pages for hours. `fullSync` itself does **not** touch guides — a new Notion page will never be discovered by achievement syncing alone, which is why this hook exists at all. Failures are logged and swallowed; a dead Notion token must not take the Dashboard down with it.

**The three startup jobs are sequenced, not concurrent** (`startupJobs()`). They used to be two fire-and-forget calls; they can't be any more, because each step feeds the next: discovery must finish before the sync knows which guide pages are new, and the tick pass must run after the achievement refresh or it matches against last run's unlock state. Still off the `listen` callback's critical path — the page opens immediately either way.

### Phase 2 sampling — `achieved` and `total` do not change for the same reasons

This is the whole design, and getting it wrong loses data *silently* (a skipped row doesn't error, it just leaves a stale number on the Dashboard forever):

- **`achieved` is a fact about the account.** It cannot change unless you played. Gating on `rtime_last_played` is exactly correct for it.
- **`total` is a fact about the game.** A developer patch adds achievements with zero playtime, which drops a 100% game below 100%. **Gating that on `rtime` is simply wrong**, and was the flaw in the first version of this design.

So `selectStatsTargets()` unions three groups:

1. **played** — `rtime_last_played` exceeds the stored `last_played`. Keeps `achieved` exact.
2. **unowned** — appid absent from the `GetOwnedGames` snapshot (family-shared / delisted / hand-added). No timestamp exists for these, so they are checked every run. Freezing them out would contradict the "a game can vanish from `GetOwnedGames` while `GetPlayerAchievements` keeps working" quirk below.
3. **sweep** — rows overdue for a re-check, capped at `sweepBudget` per run. This is the only thing that catches a retro-added achievement, so **do not remove it as an optimisation.**

Details that are load-bearing:

- **The sweep sorts by *overdue ratio* (`age / itsOwnDeadline`), not by absolute age.** Perfect games expire in 3 days and everything else in 7; sorting by raw age lets an 8-day-old ordinary game jump ahead of a 4-day-old perfect one, which makes the shorter deadline decorative. Pinned in `test/selection.test.js`.
- **`markStatsChecked` is never called on a `retry`.** Recording a rate-limited game as "just checked" would push it to the back of the queue and turn throttling into silent data loss.
- **A row with no baseline (`stats_checked_at IS NULL`) is always checked, uncapped.** The first run after this migration is therefore a full ~160 s sync; every run after is ~8 s. That is intended — there is nothing to compare against until the baseline exists.
- **No `playSnapshot` ⇒ check everything.** `node tracker.js sync` deliberately stays a true full sync; `sync --fast` and the Dashboard's auto-sync opt in by passing `selection`. Keep that escape hatch.
- **Thresholds are targets, not guarantees** — `sweepBudget` binds first. At 40 with the Dashboard opened ~twice daily the cycle lands on the intended 3/7 days; at once daily it stretches to ~5/11.5. Measured, not estimated.

### The 「立即同步」 button

A page refresh only re-reads SQLite — `getDashboardData()` never touches Steam — so the Dashboard has a manual sync button next to the "上次同步" line. It calls `api.startSync()` → `startBackgroundSync()` in `lib/server.js`, **the same function the startup auto-sync uses**. Keep it that way: one function means one concurrency guard, and the guard is the only thing stopping a click that lands during the startup sync from running two `fullSync`es over the same database.

Two deliberate asymmetries with `maybeAutoSync`: the button **ignores `syncStaleHours`** (that gate answers "should we sync unprompted", and a click has already answered it), and it still passes `selection`, so it's the ~8 s sampled sync, not the ~160 s full one. `node tracker.js sync` remains the way to force a true full pass.

Sharing one function is also what gives the button its checkbox ticking for free — the tick pass hangs off `startBackgroundSync`'s completion, so both the startup sync and the button get it without a second call site.

The button owns no progress UI of its own — `lib/rpc.js`'s existing 3-second poll drives its label and disabled state through a `window.onSyncState` hook, alongside the status bar and the post-sync `reloadDashboard()`. That hook fires **before** every branch in the poll handler, because two of those branches (sync failed, user mid-edit) return early; hanging it off the end would strand the button on "同步中..." forever. Same reasoning as `reloadDashboard`: the frontend reflects the server's real sync state rather than tracking its own, so a sync started from the CLI or a second tab greys the button out too.

**`stats.bumped` must stay visible.** It was computed and thrown away on the Dashboard path for a while (only the CLI printed it) — which is backwards, since a retro-added achievement is precisely the change you cannot notice on your own. It now reaches `syncState` → the status bar, and that notice deliberately does **not** auto-dismiss.

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

**Always `checkbox-sync --dry-run` before a manual full run.** Ticking a Notion box can't be undone automatically, and failure mode 3 above was caught by a dry run before it wrote anything. Sync only ever ticks, never unticks, so it cannot repair its own mistakes.

### Automatic checkbox ticking (the one unattended write path)

`serve` and the 立即同步 button both run a tick pass after the achievement sync (`runCheckboxSync` in `lib/server.js`, off via `checkboxSyncOnServe: false`). **This is the only place in the project that writes to Notion without a dry-run in front of it**, so every narrowing below is load-bearing — do not widen one without replacing the safety it provided:

- **`appids` whitelist, not the full candidate set.** Only rows whose `achieved`/`total` actually moved this run (`stats.changedAppids`, fed by the new `gained` flag out of `updateGameStats`) plus guide pages registered for the first time this run. A full pass is ~40 games × (1 Steam call + 1 Notion page read + 350 ms) on *every* Dashboard open, nearly always to find nothing. **`appids: []` means "run nothing", never "no filter"** — writing `appids?.length ? … : everything` turns the common case (nothing changed) into a full scan and silently undoes the whole design. Pinned in `test/checkbox-selection.test.js`.
- **`gained` is false when there's no baseline.** On the first sync of a row, `achieved` goes `NULL → n`; counting that as "gained" would make the entire library a candidate on the run where that's most expensive.
- **Cascade off by default here** (`checkboxSyncOnServeCascade`), unlike the CLI. The cascade is the one deliberately over-ticking path, and this route has no human gate in front of it.
- **A game that hit 100% *this run* is still visited.** The 100%-skip used to be coupled to `cascade` in one expression; decoupling it was a real bug fix, not a tidy-up. With cascade off, the achievement that *completes* a game could never be ticked automatically — by the next run the game is at 100% and is skipped, forever. The `achievementsFor(...).length > 0` guard still applies (the 55/55 no-schema case), so this costs nothing on the games that rationale was about.
- **Failures are soft and separate.** Errors go to `syncState.tickError`, never `syncState.error`. A dead Notion token must not present as "achievement sync failed" when the achievement data synced fine.

Review is `sync_log` + `node tracker.js log` — the auto path writes the same rows the CLI does. The Dashboard also raises a notice naming the first few ticks, and like the `bumped` notice it **does not auto-dismiss**: it is reporting a write to the user's own notes.

### Guide page status (`Done` ⇄ `Staged`)

The Notion guide page's `Status` property is kept in step with completion, **both directions** — `syncGuideStatuses` in `lib/guides.js`, run by `node tracker.js guide-status` and, on the serve path, right after the tick pass (`guideStatusOnServe`).

- 100% and not `Done` → **`Done`**.
- Below 100% and currently `Done` → **`Staged`**. Effectively always a developer patch adding achievements, which is the one kind of change that happens without you playing.

Load-bearing details:

- **It converges on state; it does not watch for the transition.** Crossing 100% (in either direction) exists only for the instant `updateGameStats` writes it. Any run that observes it but cannot write — a CLI `sync` on a box with no Notion token, an interrupted process, an expired token — loses it permanently, because every later run sees the same value on both sides and can infer nothing. The rules are therefore stated over current state, which is idempotent, self-healing and re-runnable. **Do not "optimise" this into transition detection.** Measured proof: the one page that needed demoting (Supermarket Together, 28/51) has `new_ach_date = NULL`, so a rule gated on "we saw `total` grow" would never have fired for it at all.
- Convergence is nearly free because `queryGuideDatabase` already pages through the whole database; it just used to throw the `Status` property away. Cost is ~3 API calls per run total, not per game.
- **The two directions are deliberately asymmetric in how aggressive they are.** Promotion overwrites *everything* except `Done`, `Differed` included — completion beats a hand-set workflow state. Demotion touches *only* `Done`. A sub-100% page sitting at `Paused` / `In progress` / `Not started` / `Differed` is a state you chose, and rewriting it on every Dashboard open would put you and the tool in a loop overwriting each other. Pinned in `test/guide-status.test.js`.
- The two rules are mutually exclusive by construction (`achieved >= total` vs `<`), so a page can never satisfy both and oscillate.
- **A `total` of `NULL` is not "dropped below 100%".** `markNoAchievements` clears `total` when Steam says a game has no stats, and rate-limits/403s take the `retry` path and write nothing at all — so the `total > 0` guard is what stops a Steam hiccup from demoting a finished page.
- **The property's *type* is read, never assumed.** Notion's `status` and `select` are different property types whose write payloads differ (`{status:{name}}` vs `{select:{name}}`), and the wrong one is rejected. `fetchGuideStatusSchema` reads name, type and options; **both** `Done` and `Staged` are validated up front, so a database missing one fails with a readable message instead of a Notion 400 halfway through.
- Notion-kind guides only — local markdown has no status property. Failures are soft and land in `syncState.statusError`; `syncGuideStatuses` returns `applied` (writes that actually succeeded) so callers report direction without parsing log text.

Ordering matters: status runs **after** the tick pass, so a game that just completed gets its last boxes ticked before the page is marked done. Marking a page `Done` over unticked boxes is the wrong end state.

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

- **The 🎮 recently-played badge can never appear on a family-shared / delisted row.** It derives from `last_played`, which comes from `GetOwnedGames`; rows absent from that response have no timestamp at all and Steam offers no other source. Looks like a bug, isn't one.
- **Games with `has_achievements = 0` are retried**, not permanently excluded. They get re-marked if Steam still says no stats; harmless. `GetOwnedGames`'s `has_community_visible_stats` flag predicts this set exactly (verified 26/26 on the real library) and skipping them would save 26 calls per full pass — **this was considered and deliberately rejected.** The moment a game adds achievements is the moment that flag flips, and by then we'd have stopped asking. Trading a permanent blind spot for ~11 s is a bad deal.
- **The four test files cover different failure classes.** `matching.test.js` protects the user's *notes* (a wrong tick corrupts a guide). `selection.test.js` protects the user's *data* (a skipped row silently freezes a number). `checkbox-selection.test.js` protects *which guide pages get opened* — too wide burns dozens of Notion/Steam calls per Dashboard open, too narrow silently never ticks. `guide-status.test.js` protects *idempotency* — the status pass runs on every Dashboard open, so a rule that isn't a no-op the second time means repeated writes to Notion. All four fail quietly in production, which is why all four are pinned.
- **`syncGuidesFromMarkdown`'s `added` includes re-registrations, not just new guides.** It re-upserts every local `.md` on each run and pushes all of them, with `action: 'appended' | 'updated'` telling them apart. `syncGuides` filters to `'appended'` before feeding the tick pass — without that filter every local guide looks newly-discovered on every start and the targeted tick degrades into a full local scan. The Notion side's `added` is already genuinely new-only (filtered by `existingIds`).
- **`sync_locked = 1` rows are never touched by any sync phase.** If a row "won't update," check that first.
- **Notion page identity must use the normalized UUID**, never raw URL text — Notion sometimes prefixes URLs with a title slug, so the same page's URL differs between queries. Comparing raw URLs once caused already-linked pages to be treated as new and overwrite curated names (`normalizeNotionId` in `lib/notion.js`).
- **One appid, one guide backend.** Markdown discovery won't overwrite a registered Notion guide unless `--force`.
- **Local guide paths are contained to `guidesDir`** (`resolveGuidePath`). Keep that check if you touch it — `guides.url` is data.
- **Documentation drifting from code is a real failure mode here.** A secret once sat hardcoded in this public repo for months while three separate docs claimed it was read from config, because nobody checked the source. Verify against code, not docs.
- **`localDate()` not `toISOString().slice(0,10)`** for user-facing dates — the latter is UTC and will be off by a day in the evening.
- **Guide text never goes in the database** — only a pointer. Guides have to stay human-editable and tickable where they live; the `guides` table tracks *where*, never *what*.

## Current state and open items

The core pipeline (library sync, achievement counts, achievement detail, Dashboard, ♥/★ flags) is done and in daily use. Guide sync works against both backends, Notion is configured, and the whole guide corpus has been audited. Checkbox ticking now also happens automatically on Dashboard open and on 立即同步, scoped to what changed — see "Automatic checkbox ticking" for the constraints that keep that safe — and the same chain keeps each guide page's `Status` in step with completion, `Done` when a game is finished and back to `Staged` when a patch drops it below 100% (see "Guide page status").

**Verified baseline as of 2026-08-09** — every number below was re-measured on that date, not carried forward. Re-derive rather than trust if a lot has changed since, but don't redo this work blindly:

- `checkbox-sync --dry-run` across all 44 eligible games proposes **0** ticks and produces 0 log lines — no skips, no failures, no ambiguous-name warnings. Notion and Steam agree.
- `audit` covers **44/44** games and **1,190** ticked boxes: **0** confirmed-wrong, **64** undetermined. The undetermined ones paraphrase the official description instead of quoting it, so the reverse lookup can't attribute them. They tick fine by name; they just can't be verified. Fixing that means editing those guide pages, not the code. (The audit set is games *below* 100%, so this total falls as games complete — it is not a running tally of every box in the corpus.)
- **The previous baseline (2026-08-04) had gone stale, and the drift was invisible.** By 2026-08-09, 空之轨迹 the 1st (appid 3447040, 28/43) had 10 unlocked achievements whose boxes were never ticked, because the only machine in use had no Notion token configured. Nothing errored — `checkbox-sync` simply never ran. **A clean recorded baseline is not evidence that the sync is running**; check `sync_log` has recent rows before believing it.
- **Guide page `Status`:** 105 pages — 59 `Done`, 24 `Paused`, 12 `Not started`, 4 `In progress`, 3 `Staged`, 3 `Differed`. Of the 55 `Done` pages that map to a game with achievement data, **54 were already exactly at 100%** — the evidence that `Status` tracks game completion here rather than guide-writing progress. The first `guide-status` run exercised both directions once each, and **`--dry-run` now reports 0 either way**:
  - Palworld (1623730, 75/75) `Staged` → `Done`
  - Supermarket Together (2709570, 28/51) `Done` → `Staged`
  The distribution above is *post-run* and happens to equal the pre-run one — the two swaps cancel. Don't read that as "nothing happened". The other 43 non-Done pages are genuinely unfinished games; status was kept current by hand before the feature existed, so don't assume a backlog.
- **`config.json` is per-machine and gitignored.** The Windows checkout went without a Notion token for a while, which is what caused the drift above; `notion.overviewDbId` there is `<see config.json>` (the `🎯 Overview` database under the `Entertainment` page). An empty `sync_log` plus a suspiciously quiet Notion feature means the token, not a bug — check `notion.token` first. Note `saveConfig` requests mode `600`, which Windows does not honour.
- **Three boxes were ticked wrongly and have been un-ticked** (Civ VI 亦敌亦友, CK3 春风得意, 古剑奇谭 新年快乐) — recorded in `sync_log` as `人工修正`. The first two were same-name mis-ticks; don't be surprised by un-ticks in the log's history.
- **Same-name collisions, re-measured 2026-08-09: 12 games.** Count by achievement pair, not by name string — a bilingual pair (`妙手空空` / `Skilled Thief`) is one collision seen twice, and counting strings returns a misleading 15. **Most are not genuine same-names at all**, which is the part worth knowing:
  - **Genuinely identical in both languages — 3:** 鬼谷八荒 (`妙手空空`/`Skilled Thief`), 古剑奇谭二 (`助人为乐`, `美食家` — no English localization at all, the `name_en` field just repeats the Chinese), 了不起的修仙模拟器 (`阴阳之道`/`Yin-Yang Rule`).
  - **Chinese localization bugs, English distinct — 8:** Civ VI (`Frenemy`/`Frenemies`), CK3 (`Going Places`/`Flying Colors`), Plague Inc (`Nano-Virus Master`/`Bioweapon Master`), PUBG, Cities: Skylines, 雨世界, Sword and Fairy 6, and Farm Together — whose two English names differ *only* by a typographic vs straight apostrophe.
  - **English localization bug, Chinese distinct — 1:** 犹格索托斯的庭院, four achievements whose `name_en` is the placeholder `Text`.
- **Only 4 of the 12 have a guide** (Civ VI, CK3, 鬼谷八荒, Plague Inc), and **all 8 of their colliding achievements resolve** — verified 2026-08-09 by running the real `resolveTodoToAchievement` against the live pages, not by reading the guides: 3 boxes already ticked, the other 5 will tick on unlock. **No existing guide needs a description added.** Plague Inc was never broken; it just wasn't recorded. **Don't "fix" these pages again.**
- Note a description cannot make an achievement stop being ambiguous — `isAmbiguous()` reads names only, and no guide edit changes that. Quoting the description satisfies the *one path* an ambiguous achievement is given (pass 1); it does not reopen name matching.
- **The ambiguity gate is per-achievement, not per-name — and that is stricter than the data requires.** `isAmbiguous()` in `matchAchievements` returns true when *either* name is in `unsafeNames`, so an achievement whose Chinese name collides is routed into the description-only pass and **never gets name-matched on its unique English name**. Demonstrated on Plague Inc: a checkbox reading exactly `Nano-Virus Master` — unique in that game, and *not* in `unsafeNames` — still fails to match. So the three localization-bug guides above tick only because they happen to quote descriptions; strip the description and they would silently never tick. 犹格索托斯的庭院 would hit the same wall in reverse if a guide is written for it. Safe, but it leaves real disambiguating signal unused; narrowing the gate to the offending name is a live option, not a bug to fix blindly.
- **Quoting the verbatim description is the fix for a collision game, and it works for 11 of the 12** — every colliding achievement there has a description that is non-empty and unique in its game (checked 2026-08-09). **The exception is 雨世界**: both of its colliding achievements have an *empty* description on Steam's side, so no amount of careful guide writing can disambiguate them. It has no guide today. If one is ever written, it is the single case where narrowing the ambiguity gate is the only possible fix — its English names (`Pilgrimage` / `The Pilgrim`) are distinct and currently discarded.

Known outstanding items:

- **Guides not yet written** — these pages exist in the Notion guide database but have no `appid:` line yet, so guide discovery skips them every run (expected, not an error): Xenoblade Chronicles X, 三相奇谈, 以闪亮之名, 最强祖师, 月圆之夜, 燕云十六声.
- **Leftover spreadsheet automation** — a few daily jobs still update an old Google Sheet as a secondary backup. When they're no longer wanted, delete them from that project's Apps Script triggers page; run `node tracker.js export` first, since the sheet stops updating afterwards.
- **Ideas, not commitments** — write the missing guides, enrich the Dashboard, or add a launchd plist if sync-on-open isn't enough.

## Working on this efficiently

1. **Bulk repetitive external calls are disproportionately expensive.** Notion has no batch-update API, so "add one line to forty pages" is forty round trips — and each one carries the whole conversation history. Before starting that kind of job, say roughly how many calls it will take and offer to do it in a fresh session.
2. **Rule of thumb for a fresh session:** if the content to read/write clearly exceeds what's already in context, or the task is purely repetitive and needs no history, suggest starting clean. Small one-off edits are fine inline.
3. **Verification beats assumption.** A successful tool call does not mean the content is right — see the Notion page-ID and documentation-drift pitfalls above. Re-read results after bulk writes or overwrites, and prefer a read-only preview (`--dry-run`, a SELECT) before anything that writes outside this repo.

