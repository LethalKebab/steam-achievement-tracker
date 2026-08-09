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
| `serve` | Opens the Dashboard on `127.0.0.1:8777`, syncing first if the data is stale | Steam + Notion |
| `sync` | Full refresh of the whole library | Steam |
| `sync --fast` | Sampled refresh — the same work the Dashboard does | Steam |
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

Refreshing the browser does none of it — that re-reads the local database only. The staleness check runs once, when the **server starts**, against `syncStaleHours` (12h by default). So leaving `serve` running for days does not keep it fresh: press 立即同步, or restart.

What the table can't show:

- **The Steam sync is sampled** — games you've played since last time, games Steam gives no play time for, and a rotating batch of the rest. Seconds rather than minutes. Only `sync` skips sampling and checks everything.
- **Guide discovery ignores the staleness check**, so a page you created five minutes ago shows up now rather than in twelve hours.
- **Automatic ticking only visits games that changed in that run**, so most Dashboard opens make no Notion calls at all. It also skips nested sub-steps; the command handles those.
- **Status is derived from current completion, not from the moment of crossing** — which is why it runs even when the sync is skipped.
- **`sync` never touches Notion.** Ticks and status changes come only from `serve`, 立即同步, or the two commands run directly.
- Both Notion jobs need a token and can be switched off — `checkboxSyncOnServe`, `guideStatusOnServe`, and the sampling thresholds are all in [docs/configuration.md](docs/configuration.md).
- Everything written to Notion lands in the `sync_log` table.

## Optional: guide checkboxes

If you keep achievement guides as checklists — Notion pages or local markdown — the tracker ticks the boxes for achievements you've unlocked and marks a finished game's page `Done`. One-time setup:

```bash
node tracker.js init --notion   # Notion only; local markdown needs no setup
node tracker.js guides          # register your guide pages
```

After that it keeps up on its own, or on demand via the commands above. Ticking a Notion checkbox cannot be undone automatically, so preview a manual full run with `--dry-run` first.

How matching works, and why it is deliberately strict: [docs/guides.md](docs/guides.md).

## More

| | |
|---|---|
| [docs/configuration.md](docs/configuration.md) | every `config.json` option, environment variables, changing the port |
| [docs/data.md](docs/data.md) | what's in the database, importing/exporting CSV, what Steam can't tell us |
| [docs/guides.md](docs/guides.md) | guide checkbox sync, Notion setup, how matching works |
| [CLAUDE.md](CLAUDE.md) | architecture and conventions, for working on the code |

## License

MIT — see [LICENSE](LICENSE).
