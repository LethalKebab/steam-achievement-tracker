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

```bash
node tracker.js serve     # the Dashboard (re-syncs on startup if data is over 12h old)
node tracker.js sync      # refresh now
node tracker.js status    # quick stats, no network
```

There is no scheduled job. Data refreshes when you start `serve`, when you press **立即同步** on the Dashboard, or when you run `sync` on the command line. Nothing runs while your machine is asleep.

The staleness check runs when the **server starts**, not on every page view: refreshing the browser re-reads the local database but does not contact Steam. If you leave `serve` running for days, use the Dashboard's 立即同步 button to pull fresh data. `node tracker.js help` lists every command.

## Optional: guide checkboxes

If you keep achievement guides as checklists, in Notion or as local markdown, `checkbox-sync` ticks the boxes for achievements you have unlocked:

```bash
node tracker.js init --notion            # only if you use Notion
node tracker.js guides                   # find your guide pages
node tracker.js checkbox-sync --dry-run  # preview; always do this first
node tracker.js checkbox-sync            # apply
```

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
