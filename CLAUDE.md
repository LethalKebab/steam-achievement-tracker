# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Steam achievement auto-tracker, running **entirely locally**: SQLite data store + Node CLI + a local HTTP server for the HTML Dashboard. Tracks achievement completion across the user's whole Steam library.

This was a Google Apps Script + Google Sheet project until it was ported to run locally (the Apps Script implementation is in git history on `main`). If you find documentation, comments, or skills still referring to `clasp`, Script Properties, `doPost`, or Sheet tabs, that's stale — fix it.

See `PROJECT_CONTEXT.md` for background, task lists, and known issues.

## Stack constraints

- **Zero dependencies, by design.** Node built-ins only: `node:sqlite` for storage, global `fetch` for HTTP, `node:http` for the server, `node:test` for tests. Do not add an npm dependency without a strong reason — "no install step" is a feature of this project, not an accident.
- Requires **Node 24+** (`node:sqlite` availability).
- ES modules (`"type": "module"`). Real `import`/`export` — unlike the Apps Script version, files do *not* share a global scope.

## Development workflow

```bash
node tracker.js <command>   # everything is a subcommand; see tracker.js header or `node tracker.js help`
node --test                 # test suite (test/matching.test.js)
node --check lib/foo.js     # syntax check
```

There is no build, no push, no deploy. Editing a file and re-running the command is the whole loop. `serve` does not hot-reload — restart it after changing `lib/` (`Dashboard.html` and `lib/rpc-shim.js` are re-read per request, so a browser refresh picks those up).

## File architecture

| File | Role |
|---|---|
| `tracker.js` | CLI dispatch: `init`, `sync`, `serve`, `status`, `guides`, `checkbox-sync`, `import`, `export`, `log` |
| `lib/config.js` | `config.json` load/save, env-var overrides, required-field errors with setup hints |
| `lib/db.js` | SQLite schema + all table accessors. `openDb()` is idempotent (safe `CREATE TABLE IF NOT EXISTS`) |
| `lib/steam.js` | `SteamClient`: owned games (+Unvetted diff), player achievements, schema, name lookup, store search |
| `lib/sync.js` | `syncLibrary` → `syncAchievementStats` → `syncAchievementSchema`, `fullSync`, `computeAgcrStats` |
| `lib/server.js` | HTTP server (127.0.0.1 only), `/api/*` dispatch, background sync state + staleness check |
| `lib/api.js` | The 10 Dashboard methods. **Names and return shapes must match what `Dashboard.html` calls** |
| `lib/rpc-shim.js` | Served at `/_rpc.js`. Proxies `google.script.run.…` chains to `fetch('/api/…')` |
| `lib/guides.js` | Achievement↔checkbox matching rules, both guide backends, guide discovery |
| `lib/notion.js` | Notion API client, page-ID normalization, `to_do` block walking |
| `lib/markdown.js` | Local markdown guide backend (`- [ ]` → `- [x]`), path containment check |
| `lib/csv.js` | CSV parse/serialize, Sheet-export import, CSV export |
| `Dashboard.html` | Frontend SPA. Unchanged from the Apps Script version except one `<script src="/_rpc.js">` tag |

### Why the shim exists

`Dashboard.html` has ~1000 lines of app code making 11 calls shaped like
`google.script.run.withSuccessHandler(fn).withFailureHandler(fn).method(args)`. Rather than rewrite all of it, `lib/rpc-shim.js` provides an object with that exact shape backed by `fetch`. **Keep the contract:** a method that returns `{error: '...'}` is a *successful* call (the frontend inspects `result.error` itself); only network/thrown failures go to the failure handler. If you add a Dashboard method, add it to `lib/api.js` — the shim needs no changes, it proxies any name.

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
- **`sync_locked` is what the sync actually checks**, not `status`. This is the fix for a documented Apps Script wart where `'Manual'` conflated "skip daily sync" with "lock against Unvetted re-classification" and you couldn't have one without the other. The Dashboard still moves both together (`setManualStatus` sets both), so default behavior is unchanged; the columns can now diverge deliberately.
- `family` is purely informational and never affects sync behavior. It exists because "not in `GetOwnedGames`" and "should skip achievement sync" are two *different* facts.

## Sync behavior

`fullSync` runs three phases in order, with no cursor and no runtime cap — those existed only to work around Apps Script's 6-minute execution limit, and removing them also removed the old "sorting shifts what the cursor points at" hazard.

1. **`syncLibrary`** — new owned games get inserted (with a name lookup); existing *owned* rows get their `Unvetted` stamp refreshed, except `'Manual'` ones. Rows whose appid is **not** in the current `GetOwnedGames` snapshot are left completely untouched — that's the preservation rule (it keys off ownership, not `status`).
2. **`syncAchievementStats`** — every row with `sync_locked = 0` gets its counts refreshed. A total higher than last time stamps `new_ach_date` (the Dashboard's "new achievements" badge).
3. **`syncAchievementSchema`** — per-achievement detail for games that are new to the `achievements` table or bumped in the last 7 days; skips games at exactly 100% and games with no achievement system.

There is no destructive rebuild/hard-reset command. `syncLibrary` subsumes the useful half of the old `rebuildSheetFromApi()`, and the old `hardResetFromApi()` (which silently dropped every family-shared/manual row) is deliberately not ported.

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

Matching an unlocked achievement to a guide checkbox is **exact equality against extracted title candidate segments**. Never substring, never prefix. Two separate rounds of false positives were only fixed by this rule:

1. an achievement name appearing inside an unrelated achievement's *description*, and
2. a short achievement name being a strict *prefix* of a different, harder achievement's name — which mis-ticked the harder one once the short one's own box was already checked.

`extractTitleCandidates()` splits checkbox text into candidates (by line, then by colon/dash, plus the `中文名(English Name)` pattern) and requires the achievement name to *equal* one of them. Adding a new candidate-extraction rule is fine; weakening the equality check is not. `test/matching.test.js` pins both failure modes — run `node --test` after touching `lib/guides.js`.

The design deliberately prefers a missed checkbox over a wrong one.

## Known pitfalls

- **Games with `has_achievements = 0` are retried on every sync**, not permanently excluded. They get re-marked if Steam still says no stats; harmless.
- **`sync_locked = 1` rows are never touched by any sync phase.** If a row "won't update," check that first.
- **Notion page identity must use the normalized UUID**, never raw URL text — Notion sometimes prefixes URLs with a title slug, so the same page's URL differs between queries. Comparing raw URLs once caused already-linked pages to be treated as new and overwrite curated names (`normalizeNotionId` in `lib/notion.js`).
- **One appid, one guide backend.** Markdown discovery won't overwrite a registered Notion guide unless `--force`.
- **Local guide paths are contained to `guidesDir`** (`resolveGuidePath`). Keep that check if you touch it — `guides.url` is data.
- **Documentation drifting from code is a real failure mode here.** `SYNC_SECRET` sat hardcoded in a public repo for months while three docs claimed it was in Script Properties, because nobody checked the source. Verify against code, not docs.
- **`localDate()` not `toISOString().slice(0,10)`** for user-facing dates — the latter is UTC and will be off by a day in the evening.
