# Steam Achievement Tracker

Tracks Steam achievement progress across your library. It stores your games, achievement counts and completion percentage in a local SQLite database, and shows them in a Dashboard.

Everything runs on your own machine: the database is a file next to the program, credentials sit in a config file beside it, and the Dashboard is served by a local HTTP server bound to `127.0.0.1`.

> **Note:** the Dashboard is in Chinese (the language this project was built in). Setup and daily use don't require reading Chinese, but the on-screen text is Chinese.

## Install

Windows. Nothing to install — the app bundles everything it needs.

1. Download the `-win.zip` from [the latest release](https://github.com/LethalKebab/steam-achievement-tracker/releases/latest) (~133 MB)
2. Unzip somewhere permanent — the database is created inside that folder, so moving or deleting the folder moves or deletes your data
3. Run `SteamAchievementTracker.exe`

The build is unsigned, so the first launch shows *"Windows protected your PC"*. Click **More info → Run anyway**; it doesn't appear on later launches.

## First run

You need two things from Steam, both one-time:

| | What | Where |
|---|---|---|
| ① | **Steam Web API Key** | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| ② | **SteamID64** | [steamid.io](https://steamid.io) — paste your profile URL |

Until they're saved, the app serves a form in place of the Dashboard: those same two fields, checked against Steam before anything is written. Save it and the Dashboard opens, with the first sync running in the background — a few minutes the first time. Every later launch goes straight to the Dashboard.

## Living in the tray

**Closing the window only hides it.** Syncing and guide generation keep running. To get the panel back, click the tray icon, or simply run the exe again — a second launch raises the window that is already there instead of starting a second copy.

To actually stop the program, quit from the tray icon.

## Updating

From 1.1.4 the app updates itself: it checks shortly after launch and then once a day, and offers to download, replace and restart. The prompt has a "don't remind me about this version" checkbox. To turn checking off entirely, put `"autoUpdate": false` in `local.config.json` next to the exe.

Updating by hand still works, and is the only way to make the jump *to* 1.1.4, since older builds have no updater in them:

1. **Quit from the tray icon** — closing the window only hides it, and Windows won't replace a running program
2. Unzip the new release into the same folder, replacing files when asked

Either way your data is untouched. The zip contains program files only; `config.json` and `data/` are not in it. Those two are the whole of your data if you want a copy first.

## What you can do

### Track your library

The Dashboard lists your games with completion percentage, and **立即同步** refreshes from Steam on demand. Games you've played in the last 5 days are pinned to the top.

### Tick guide checkboxes for you

Optional. If you keep achievement guides as checklists — Notion pages or local markdown — the app can tick the boxes for achievements you've unlocked.

Notion is set up on the first-run form (step 3), and stays reachable afterwards from the gear button in the Dashboard's top-right corner. It builds the Notion database for you, so you never copy a database ID by hand. Local markdown needs no setup at all.

Details, and how matching works: [docs/guides.md](docs/guides.md). Step-by-step Notion authorisation, including the step most people miss: [docs/notion-setup.md](docs/notion-setup.md).

### Have a guide written for you

Optional. If you'd rather not write a guide from scratch, an AI can research the game online and draft one, which is then checked against your real achievement data before it lands.

**This is the only part of the app that costs money**, and it's entirely optional — nothing else needs it. Works with DeepSeek, Anthropic or Gemini; you supply your own API key, and the app tells you what each run used.

What the app guarantees is **format and data** — one checkbox per achievement, names matching Steam exactly, descriptions quoted verbatim, ticks matching your real unlock state. **Whether the advice is correct is not checked and cannot be** — read what it wrote.

### Rewrite part of a guide

Once a guide exists, the ♻ 重写 dialog rewrites just the entries you pick and leaves every other byte exactly as it was, including passages you edited yourself. You can select rare achievements, ones you haven't earned yet, a single section, or pick achievements individually.

### Go back to an earlier version

Past versions of a guide — the copy taken before each overwrite, the local original left behind by a move to Notion, and failed drafts — sit behind the **备份** button at the end of that game's row, which appears only when there is something there. Any of them can be read, written back over the current guide, or deleted. Writing one back backs up what it replaces, so it is itself undoable.

Settings → Step 4 has the same files sorted by size, for pruning. See [docs/guides.md](docs/guides.md#guide-archive).

### Move to another machine

The settings page's **备份** tab writes one zip holding the database, your guides and `config.json`, and restores from it. The credentials travel with it, so the new machine opens straight to the Dashboard — the first-run screen offers the same two steps.

The zip has your API keys in plain text unless you exclude the config. See [docs/data.md](docs/data.md#backup-and-restore).

## What runs when

**There is no scheduler, and nothing runs on a timer.** Everything is triggered by opening the app or by pressing **立即同步**. Nothing happens while your machine is asleep, and nothing happens while the app merely sits in the tray — the Dashboard polls every 3 seconds, but only to redraw the progress bar, never to fetch anything.

| | Opening the app | 立即同步 |
|---|---|---|
| **Find new guide pages** | every time | — |
| **Library + achievement counts + detail** | only if the data is stale | every press |
| **Tick guide checkboxes** | after a sync, or if a new guide page turned up | after the sync |
| **Update guide page status** | every time | after the sync |

The staleness check runs once, when the app **starts**, against a 12-hour threshold. Leaving the app open for days does not keep the data fresh — press 立即同步, or restart it. Refreshing the browser does none of the above; that re-reads the local database only.

## More

| | |
|---|---|
| [docs/notion-setup.md](docs/notion-setup.md) | 连接 Notion 攻略库 —— 分步图解,含最容易漏的授权步骤和数据库 ID 的取法 |
| [docs/guides.md](docs/guides.md) | Guide checkbox sync, how matching works, having one written for you |
| [docs/data.md](docs/data.md) | What's in the database, backup and restore, CSV export, what Steam can't tell us |
| [docs/configuration.md](docs/configuration.md) | Every setting, including changing the port |
| [docs/cli.md](docs/cli.md) | Running from source, and the full command reference |
| [Releases](https://github.com/LethalKebab/steam-achievement-tracker/releases) | Published builds and their notes |

## License

MIT — see [LICENSE](LICENSE).
