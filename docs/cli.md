# Running from source, and the command line

The Windows app in [the README](../README.md) covers everyday use. This page is the other way in: running the project from source, and the full command reference.

The commands are the same either way. The packaged app bundles its own Node runtime and its own copy of the project, so you can run any command below from the app's folder without installing anything — `resources/tracker/` next to the exe.

Everything these commands print follows `uiLanguage` in `config.json` — the same setting as the Dashboard's, `"zh"` or `"en"`. See [configuration.md](configuration.md#uilanguage).

## Requirements

**Node.js 24 or newer** — check with `node --version`. The project uses Node built-ins only (`node:sqlite`, global `fetch`, `node:http`, `node:test`), so there is nothing to `npm install`.

## First run

You need two things from Steam, both one-time:

| | What | Where |
|---|---|---|
| ① | **Steam Web API Key** | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| ② | **SteamID64** | [steamid.io](https://steamid.io) — paste your profile URL |

```bash
node tracker.js init     # paste ① and ② when asked
node tracker.js sync     # pulls your library (a few minutes the first time)
node tracker.js serve    # open the Dashboard: http://127.0.0.1:8777
```

`init` writes your credentials to `config.json` and verifies them against Steam immediately, so a typo surfaces before the first sync rather than partway through it. `config.json` is gitignored and readable only by you.

The Dashboard and the CLI output default to Chinese; `uiLanguage` (above) switches both to English.

## Optional setup

Neither is needed for library tracking.

### Guide checkbox sync

If you keep achievement guides as checklists — Notion pages or local markdown — the program can tick the boxes for achievements you have unlocked.

```bash
node tracker.js init --notion --create   # builds the Notion database and saves its ID
node tracker.js notion-check             # read-only: is that side working?
node tracker.js guides                   # register your guide pages
```

Guides live in a Notion **database**, not a plain page. `--create` builds one under a page you pick, with the status options already correct, so you never copy a database ID by hand. Drop the flag and paste an ID instead if you already have one. Local markdown needs no setup.

How matching works: [guides.md](guides.md). Step-by-step Notion authorisation: [notion-setup.md](notion-setup.md).

### AI guide generation

An AI can research a game online and draft a guide, which is then checked against your real achievement data before it lands. This is the only part of the project that costs money.

```bash
node tracker.js init --ai            # pick a provider, paste a key; verified on the spot
node tracker.js ai-check             # confirms web search actually works
node tracker.js guide-gen <appid>    # asks once before it starts
```

Works with DeepSeek or Anthropic. The finished guide goes into Notion when Notion is configured, so machine-written and hand-written guides live in the same place; `--local` writes a `guides/*.md` file instead.

What the program guarantees is **format and data** — one checkbox per achievement, names matching Steam exactly, descriptions quoted verbatim, ticks matching your real unlock state. **Whether the advice is correct is not checked and cannot be** — read what it wrote.

Details: [guides.md](guides.md#having-one-written-for-you). Design notes: [ai-guide-writing.md](ai-guide-writing.md).

## Command reference

All commands are `node tracker.js <command>`. The **Network** column tells you which reach outside your machine.

### Library

| Command | What it does | Network |
|---|---|---|
| `init` | Steam API key and SteamID64; `--notion` and `--ai` add those | Steam |
| `sync` | Full refresh: library, achievement counts, achievement detail | Steam |
| `sync --fast` | Sampled refresh — the same work the Dashboard does | Steam |
| `sync --library` | Only check for new games, and fill in any missing English names | Steam |
| `sync --achievements` | Only refresh achievement counts | Steam |
| `sync --schema` | Only sync achievement detail, and backfill any missing English descriptions | Steam |
| `serve [--port 8777]` | Opens the Dashboard, syncing first if the data is stale | Steam + Notion |
| `status` | Completion stats and AGCR | — |
| `log [n]` | The last n sync-log entries | — |

### Data

| Command | What it does | Network |
|---|---|---|
| `export [dir]` | Three tables to CSV for spreadsheets (default `exports/`). One-way — this is not a backup | — |
| `backup [dir]` | One zip: database, guides, `config.json` (default `backups/`) | — |
| `backup --no-config` | Leaves `config.json` out, so the zip holds no plaintext keys | — |
| `restore <file.zip>` | Restores from a backup. **Overwrites existing data**, asks once first | — |
| `restore --keep-config` | Moves data only; leaves this machine's credentials alone | — |
| `restore --yes` | Skips the confirmation | — |

More on what is stored and what Steam does not expose: [data.md](data.md).

### Guides

| Command | What it does | Network |
|---|---|---|
| `guides [--notion\|--local\|--all]` | Discovers guide pages and registers them | Notion |
| `guides --force` | Registers a local `.md` over a same-appid Notion guide. One appid, one backend | Notion |
| `checkbox-sync [appid]` | Ticks boxes for unlocked achievements | Steam + Notion |
| `checkbox-sync --dry-run` | Previews which boxes would be ticked, writes nothing | Steam + Notion |
| `checkbox-sync --no-cascade` | Does not cascade into nested sub-step checkboxes | Steam + Notion |
| `guide-status` | Aligns guide page status with completion | Notion |
| `guide-status --dry-run` | Shows what would change, writes nothing | Notion |
| `audit [appid]` | Looks for boxes ticked while the achievement is still locked (read-only) | Steam + Notion |
| `guide-lint [appid]` | Checks guides for achievements with no checkbox, and formatting that blocks syncing | Notion |
| `guide-lint --checked` | Also validates tick state; queries Steam per game, so it is slow | Steam + Notion |
| `guide-to-notion <appid>` | Moves a local `.md` guide into Notion, verifying it arrived intact | Notion |
| `guide-to-notion --dry-run` | Previews the conversion, writes nothing | Notion |
| `notion-check` | Checks token, database, title property, status options, page count | Notion |
| `notion-check --fix` | Appends missing status options, sorts them into board columns, adds the board view, then re-reads to confirm | Notion |
| `notion-check --probe-write` | Creates and archives one page to prove write access | Notion |
| `drafts` | Lists what has piled up in `guides/.drafts/` | — |
| `drafts --clean` | Removes it; `--older-than N` limits to drafts older than N days | — |

Because ticking a Notion checkbox cannot be undone from here, run `checkbox-sync --dry-run` first when in doubt.

### AI

| Command | What it does | Network |
|---|---|---|
| `ai-check [appid]` | Checks the provider and that its web search really works | AI provider |
| `ai-check --dry` | Assembles the request without sending it; needs no key | — |
| `ai-check --models` | Asks the API which models the key can use (`deepseek-openai` only) | AI provider |
| `guide-gen <appid>` | Researches and writes a guide, validates it, files it | AI + Steam (+ Notion) |
| `guide-gen --dry-run` | Prints the prompt and the landing plan, sends no request | — |
| `guide-gen --overwrite` | Rewrites the whole guide — backs the old one up, shows what you lose, then asks | AI + Steam (+ Notion) |
| `guide-gen --only <what>` | Rewrites just the entries you name; every other byte stays as it is | AI + Steam (+ Notion) |
| `guide-gen --local` | Writes `guides/*.md` instead of going to Notion | AI + Steam |

Shared flags for `ai-check` and `guide-gen`:

| Flag | Effect |
|---|---|
| `--provider X` / `--model Y` | Uses them for this run only; `config.json` is not changed |
| `--effort low\|medium\|high` | How deep the research goes this run (default `high`). `low` is much faster; what it gives up is the middle-difficulty achievements — the hardest few come out thorough either way |

`guide-gen` also takes `--yes` (skip the confirmation), `--rounds N` (how many correction rounds), and `--file` (override the filename).

### Rewriting part of a guide

`--only` rewrites just the entries you name and leaves every other byte as it was, including passages you edited yourself. The old version is backed up first.

```bash
node tracker.js guide-gen <appid> --only rare --note "写清楚前置条件和易错过的地方"
node tracker.js guide-gen <appid> --only locked --dry-run   # see what it picked, spend nothing
node tracker.js guide-gen <appid> --only "成就名A,成就名B"
```

`--only` accepts:

| Selector | Selects |
|---|---|
| `rare` | Global unlock rate under 10%; `rare:5` sets a different threshold |
| `locked` | Achievements you have not earned yet |
| `section:<heading>` | Everything under that heading |
| `名A,名B` | A comma-separated list of achievement names |

Run it with `--dry-run` first — that prints the selected entries and the exact request, without sending anything.

The Dashboard offers the same selectors on its ♻ 重写 dialog, plus a per-achievement picker. The two surfaces deliberately offer the same set.

## What runs when

**There is no scheduler, and nothing runs on a timer.** Everything is triggered by starting `serve`, by pressing 立即同步 in the Dashboard, or by a command you run.

| | Starting `serve` | 立即同步 | Command line |
|---|---|---|---|
| **Find new guide pages** | every time | — | `guides` |
| **Library + achievement counts + detail** | only if data is stale | every press | `sync`, `sync --fast` |
| **Tick guide checkboxes** | after a sync, or if a new guide page turned up | after the sync | `checkbox-sync` |
| **Update guide page status** | every time | after the sync | `guide-status` |

The staleness check runs once, when the **server starts**, against `syncStaleHours` (12h by default). Leaving `serve` running for days does not keep the data fresh — press 立即同步, or restart. Refreshing the browser re-reads the local database only.

**`sync` never touches Notion.** Ticks and status changes happen only via `serve`, 立即同步, or `checkbox-sync` / `guide-status` run directly.

## Where things live

| Path | What |
|---|---|
| `config.json` | Credentials and settings. Gitignored, readable only by you |
| `data/steam.db` | The database. A single SQLite file — `sqlite3` opens it directly |
| `guides/` | Local markdown guides, plus `.drafts/`, `.backups/` and `.migrated/` |
| `exports/` | CSV output from `export` |
| `backups/` | Zips from `backup` |

Every option: [configuration.md](configuration.md).

`node tracker.js help` lists everything the CLI accepts.

## Working on the code

| | |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | Architecture, conventions, and the reasoning behind each decision |
| [launcher/README.md](../launcher/README.md) | How the Windows app is built and packaged |
| [self-update.md](self-update.md) | How the app updates itself |
| [ai-guide-writing.md](ai-guide-writing.md) | How guide generation works and why it is shaped this way |

Tests are `node --test`. There are no test dependencies either.
