# Steam Achievement Tracker

Tracks Steam achievement progress across your library. It stores your games, achievement counts and completion percentage in a local SQLite database, and serves a web Dashboard for browsing them.

Everything runs on your own machine: the database is a file next to the program, credentials sit in a config file beside it, and the Dashboard is served by a local HTTP server bound to `127.0.0.1`.

> **Note:** the Dashboard UI is in Chinese (the language this project was built in). Setup and daily use don't require reading Chinese, but the on-screen text is Chinese.

## Requirements

Two ways to run this, with different requirements:

- **The Windows app** — nothing to install; it bundles its own Node runtime.
- **From source** — **Node.js 24 or newer**, check with `node --version`. The project uses Node built-ins only, so there are no packages to install.

## Setup

Either way, you'll need two things from Steam, both one-time:

| | What | Where |
|---|---|---|
| ① | **Steam Web API Key** | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| ② | **SteamID64** | [steamid.io](https://steamid.io) — paste your profile URL |

### The Windows app

1. Download the `-win.zip` from [the latest release](https://github.com/LethalKebab/steam-achievement-tracker/releases/latest) (~133 MB)
2. Unzip somewhere permanent — the database is created inside that folder, so moving or deleting the folder moves or deletes your data
3. Run `SteamAchievementTracker.exe`

The build is unsigned, so the first launch shows *"Windows protected your PC"*. Click **More info → Run anyway**; it doesn't appear on later launches.

**The app lives in the tray.** Closing the window only hides it — syncing and guide generation keep running. To get the panel back, click the tray icon or simply run the exe again: a second launch raises the window that is already there instead of starting a second copy.

**Updating:** from 1.1.4 the app does it itself — it checks for a new version shortly after launch and then once a day, and offers to download, replace and restart. The prompt has a "don't remind me about this version" checkbox; to turn checking off entirely, put `"autoUpdate": false` in `local.config.json` next to the exe.

Updating by hand still works and is the only way to make the jump *to* 1.1.4, since older builds have no updater in them: **quit from the tray icon** (closing the window only hides it, and Windows won't replace a running program), then unzip the new release into the same folder and replace files when asked.

Either way your data is untouched — the zip contains program files only, and `config.json` and `data/` are not in it. Those two are the whole of your data if you want a copy first.

Until credentials are saved, a form is served in place of the Dashboard: the same two fields above, checked against Steam before anything is written. Save it and the Dashboard opens, with the first sync running in the background. Every later launch goes straight to the Dashboard.

### From source

```bash
node tracker.js init     # paste ① and ② when asked; checks them against Steam right away
node tracker.js sync     # pulls your library (a few minutes the first time)
node tracker.js serve    # open the Dashboard: http://127.0.0.1:8777
```

`init` writes your credentials to `config.json` (gitignored, readable only by you) and verifies them against Steam immediately, so a typo surfaces before the first sync rather than partway through it.

### Optional, either way

**Moving from another machine?** `node tracker.js backup` writes one zip holding the database, your guides and `config.json`; `node tracker.js restore <file.zip>` puts it back. The credentials travel with it, so the new machine opens straight to the Dashboard — the app offers the same two steps on its first-run screen and under the settings page's **备份** tab. The zip has your API keys in plain text unless you pass `--no-config`. See [docs/data.md](docs/data.md#backup-and-restore).

**Guide checkboxes.** If you keep achievement guides as checklists (Notion pages or local markdown), this also ticks boxes for achievements you've unlocked. The setup form covers Notion (step 3) and stays reachable afterwards from the gear button in the Dashboard's top-right corner. From source:

```bash
node tracker.js init --notion --create   # builds the Notion database for you and saves its ID
node tracker.js notion-check             # read-only: is that side actually working?
node tracker.js guides                   # register your guide pages
```

Guides live in a Notion **database**, not a plain page. `--create` builds one under a page you pick, with the status options already right, so you never copy a database ID by hand — drop the flag and paste an ID instead if you already have one. Local markdown needs no setup at all.

Details, and how matching works: [docs/guides.md](docs/guides.md).

**Having guides written for you.** If you'd rather not write a guide from scratch, an AI can research the game online and draft one, which is then checked against your real achievement data before it lands. This is the only part of the project that costs money, and it's entirely optional — nothing else needs it.

```bash
node tracker.js init --ai            # pick a provider, paste a key; verified on the spot
node tracker.js ai-check             # confirms web search actually works
node tracker.js guide-gen <appid>    # asks once before it starts
node tracker.js guide-gen <appid> --effort low   # fast, shallower research
```

Works with DeepSeek, Anthropic or Gemini. The same choice is offered in the Dashboard, in the confirmation before each run. The finished guide goes **into Notion** when Notion is configured, so machine-written and hand-written guides live in the same place; `--local` writes a `guides/*.md` file instead. What the machine guarantees is **format and data** — one checkbox per achievement, names matching Steam exactly, descriptions quoted verbatim, ticks matching your real unlock state. **Whether the advice is correct is not checked and cannot be** — read what it wrote. See [docs/guides.md](docs/guides.md#having-one-written-for-you).

**Changing part of a guide instead of all of it.** Once a guide exists, `--only` rewrites just the entries you name and leaves every other byte exactly as it was — including passages you edited yourself:

```bash
node tracker.js guide-gen <appid> --only rare --note "写清楚前置条件和易错过的地方"
node tracker.js guide-gen <appid> --only locked --dry-run   # see what it picked, spend nothing
node tracker.js guide-gen <appid> --only "成就名A,成就名B"
```

`--only` takes `rare` (below 10% global unlock rate), `locked` (ones you haven't earned yet), `section:<heading>`, or a comma-separated list of achievement names. **Run it with `--dry-run` first** — that prints the entries it selected and the exact request, without sending anything. The Dashboard offers the same thing on the ♻ 重写 dialog, plus a per-achievement picker; the two surfaces deliberately offer the same set. Full reference: [docs/guides.md](docs/guides.md#having-one-written-for-you).

## Everyday use

This section is the source install. In the app, opening it does what `serve` does and **立即同步** does what `sync` does, which covers everyday use — the rest of the table is available by running the commands in the app's own folder.

All commands are `node tracker.js <command>`. The **Network** column tells you which will be slow and which reach outside your machine.

| Command | What it does | Network |
|---|---|---|
| `serve` | Opens the Dashboard on `127.0.0.1:8777`, syncing first if the data is stale | Steam + Notion |
| `sync` | Full refresh of the whole library | Steam |
| `sync --fast` | Sampled refresh — the same work the Dashboard does | Steam |
| `status` | Completion stats and AGCR | — |
| `log 30` | The last 30 things written to a guide | — |
| `guide-lint [appid]` | Checks guides for achievements with no checkbox, and for formatting that blocks syncing | Notion |
| `checkbox-sync --dry-run` | Previews which guide checkboxes would be ticked, writes nothing | Steam + Notion |
| `checkbox-sync` | Ticks them | Steam + Notion |
| `guide-status` | Aligns guide page status with completion | Notion |
| `audit` | Looks for boxes ticked while the achievement is still locked | Steam + Notion |
| `notion-check` | Checks the Notion side: token, database, title property, status options, page count. Writes nothing unless you pass `--fix` (append missing options) or `--probe-write` (create + archive one page to prove write access) | Notion |
| `ai-check` | Checks the AI provider and that its web search really works | AI provider |
| `guide-gen <appid>` | Has an AI research and write a guide, then validates it and files it | AI + Steam (+ Notion) |
| `guide-gen <appid> --overwrite` | Regenerates the **whole** guide — backs the old one up, shows what you lose, then asks | AI + Steam (+ Notion) |
| `guide-gen <appid> --only <what>` | Rewrites **just the entries you name**; every other byte stays as it is. `--note "…"` says what to change | AI + Steam (+ Notion) |
| `guide-to-notion <appid>` | Moves a local `.md` guide into Notion, checking it arrived intact | Notion |
| `drafts` | Lists what's piled up in `guides/.drafts/`; `--clean` removes it | — |

`node tracker.js help` lists the rest.

## What runs when

**There is no scheduler, and nothing runs on a timer.** Everything is triggered by one of three things: starting `serve`, pressing **立即同步**, or running a command yourself. Nothing happens while your machine is asleep, and nothing happens while `serve` merely sits running — the Dashboard polls every 3 seconds, but only to redraw the progress bar, never to fetch anything.

Opening the packaged app counts as starting `serve`: it runs the same server as a background process and stops it when you close the window. Everything below applies unchanged.

| | Starting `serve` | 立即同步 | Command line |
|---|---|---|---|
| **Find new guide pages** | every time | — | `guides` |
| **Library + achievement counts + detail** | only if data is stale | every press | `sync`, `sync --fast` |
| **Tick guide checkboxes** | after a sync, or if a new guide page turned up | after the sync | `checkbox-sync` |
| **Update guide page status** | every time | after the sync | `guide-status` |

Refreshing the browser does none of it — that re-reads the local database only. The staleness check runs once, when the **server starts**, against `syncStaleHours` (12h by default). So leaving `serve` running for days does not keep it fresh: press 立即同步, or restart.

**The one gotcha:** `sync` never touches Notion — ticks and status changes only happen via `serve`, 立即同步, or `checkbox-sync` / `guide-status` run directly. Sampling, the guide jobs, and every config switch are covered in [docs/guides.md](docs/guides.md) and [docs/configuration.md](docs/configuration.md).

## More

| | |
|---|---|
| [docs/notion-setup.md](docs/notion-setup.md) | 连接 Notion 攻略库 —— 分步图解,含最容易漏的授权步骤和数据库 ID 的取法 |
| [docs/configuration.md](docs/configuration.md) | every `config.json` option, environment variables, changing the port |
| [docs/data.md](docs/data.md) | what's in the database, backup/restore, CSV export, what Steam can't tell us |
| [docs/guides.md](docs/guides.md) | guide checkbox sync, Notion setup, how matching works |
| [CLAUDE.md](CLAUDE.md) | architecture and conventions, for working on the code |
| [launcher/README.md](launcher/README.md) | how the Windows app is built and packaged, for working on it |
| [Releases](https://github.com/LethalKebab/steam-achievement-tracker/releases) | published builds and their notes |

## License

MIT — see [LICENSE](LICENSE).
