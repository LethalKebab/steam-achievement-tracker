# Steam Achievement Tracker

Tracks Steam achievement progress across your library. It stores your games, achievement counts and completion percentage in a local SQLite database, and serves a web Dashboard for browsing them.

Everything runs on your own machine: the database is a file in this folder, credentials sit in a config file beside it, and the Dashboard is served by a local HTTP server bound to `127.0.0.1`.

> **Note:** the Dashboard UI is in Chinese (the language this project was built in). Setup and daily use don't require reading Chinese, but the on-screen text is Chinese.

## Requirements

**Node.js 24 or newer** — check with `node --version`. The project uses Node built-ins only, so there is nothing to install.

## Setup

You'll need two things from Steam, both one-time:

| | What | Where |
|---|---|---|
| ① | **Steam Web API Key** | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| ② | **SteamID64** | [steamid.io](https://steamid.io) — paste your profile URL |

Then, in this folder:

```bash
node tracker.js init     # paste ① and ② when asked; checks them against Steam right away
node tracker.js sync     # pulls your library (a few minutes the first time)
node tracker.js serve    # open the Dashboard: http://127.0.0.1:8777
```

`init` writes your credentials to `config.json` (gitignored, readable only by you) and verifies them against Steam immediately, so a typo surfaces before the first sync rather than partway through it.

If you already track this in a spreadsheet, run `node tracker.js import <folder-of-csvs>` **before** your first sync. Favorites, spotlights and hand-edited rows cannot be recovered from Steam afterwards — see [docs/data.md](docs/data.md#importing-from-a-spreadsheet).

## Everyday use

All commands are `node tracker.js <command>`. The **Network** column tells you which will be slow and which reach outside your machine.

| Command | What it does | Network |
|---|---|---|
| `serve` | Opens the Dashboard on `127.0.0.1:8777`, and syncs in the background if the data is over 12h old | Steam + Notion |
| `sync` | Refreshes the whole library, no sampling — slower, misses nothing | Steam |
| `sync --fast` | Sampled refresh: the same work the Dashboard does on startup | Steam |
| `status` | Completion stats and AGCR | — |
| `log 30` | The last 30 things written to a guide | — |
| `checkbox-sync --dry-run` | Previews which guide checkboxes would be ticked, writes nothing | Steam + Notion |
| `checkbox-sync` | Ticks them | Steam + Notion |
| `guide-status` | Aligns guide page status with completion | Notion |
| `audit` | Looks for boxes ticked while the achievement is still locked | Steam + Notion |

`node tracker.js help` lists the rest.

## What runs when

**There is no scheduler, and nothing runs on a timer.** Everything is triggered by one of three things: starting `serve`, pressing **立即同步**, or running a command yourself. Nothing happens while your machine is asleep, and nothing happens while `serve` merely sits running — the Dashboard polls every 3 seconds, but only to redraw the progress bar, never to fetch anything.

| | Starting `serve` | 立即同步 | Command line |
|---|---|---|---|
| **Find new guide pages** | every time | — | `guides` |
| **Library + achievement counts + detail** | only if data is stale | every press | `sync`, `sync --fast` |
| **Tick guide checkboxes** | after a sync, or if a new guide page turned up | after the sync | `checkbox-sync` |
| **Update guide page status** | every time | after the sync | `guide-status` |

Refreshing the browser does none of it — that re-reads the local database only. The staleness check happens once, when the **server starts**.

### What each one does

| Job | What it does | How much it covers |
|---|---|---|
| **Find new guide pages** | Registers Notion pages and `guides/*.md` files carrying an `appid:` line | Every page, every `serve` start. Not gated by the staleness check, so a page you made five minutes ago appears now rather than in twelve hours |
| **Library + achievement counts + detail** | The Steam sync, in three phases | Sampled: games you've played since last time, games Steam gives no play time for, and a rotating batch of the rest. A few seconds instead of a few minutes. `sync` skips the sampling and checks everything |
| **Tick guide checkboxes** | Ticks boxes for achievements you've unlocked | Automatically: only games that changed in that run, so most Dashboard opens make no Notion calls at all. Nested sub-steps are not cascaded there — the command does that |
| **Update guide page status** | `Done` once a game hits 100%, back to `Staged` if a patch adds achievements and drops it below | Every page, every `serve` start. It compares current state rather than watching for the moment of change, so it still runs when the sync is skipped |

Sampling thresholds and every switch above are in [docs/configuration.md](docs/configuration.md).

### Worth knowing

- **`node tracker.js sync` does not touch Notion.** It writes to the local database only — no checkbox ticks, no status changes. Those come from `serve`, from 立即同步, or from `checkbox-sync` / `guide-status` run directly.
- **Leaving `serve` running for days does not keep it fresh.** Press 立即同步, or restart it.
- The two Notion jobs need a token, and both can be turned off — see `checkboxSyncOnServe` and `guideStatusOnServe` in [docs/configuration.md](docs/configuration.md).
- Everything written to Notion is recorded in the `sync_log` table: `node tracker.js log 30`.

## Optional: guide checkboxes

If you keep achievement guides as checklists, in Notion or as local markdown, `checkbox-sync` ticks the boxes for achievements you have unlocked:

```bash
node tracker.js init --notion            # only if you use Notion
node tracker.js guides                   # find your guide pages
node tracker.js checkbox-sync --dry-run  # preview; always do this first
node tracker.js checkbox-sync            # apply
node tracker.js guide-status             # mark finished games' pages Done
```

Once set up, both of these also run on their own — see [What runs when](#what-runs-when). Ticking a Notion checkbox cannot be undone automatically, so preview a manual full run with `--dry-run` first.

Setup and behaviour: [docs/guides.md](docs/guides.md).

## More

| | |
|---|---|
| [docs/configuration.md](docs/configuration.md) | every `config.json` option, environment variables, changing the port |
| [docs/data.md](docs/data.md) | what's in the database, importing/exporting CSV, what Steam can't tell us |
| [docs/guides.md](docs/guides.md) | guide checkbox sync, Notion setup, how matching works |
| [CLAUDE.md](CLAUDE.md) | architecture and conventions, for working on the code |

## License

MIT — see [LICENSE](LICENSE).
