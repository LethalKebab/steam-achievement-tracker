# The data

Everything is in `data/steam.db`, a single SQLite file (gitignored). `openDb()` creates the tables if they're missing and is safe to call repeatedly, so there is no separate migration step to run. Open the file with anything:

```bash
sqlite3 data/steam.db "SELECT name, achieved, total FROM games ORDER BY rate DESC LIMIT 10"
```

## Tables

| Table | Holds |
|---|---|
| `games` | one row per appid: name, achieved/total, completion rate, status, ♥/★/family flags |
| `achievements` | per-achievement detail — CN + EN names, description, hidden flag, icon URL |
| `guides` | appid → guide location, plus `kind` (`notion` or `local`) |
| `sync_log` | every checkbox change, skip and failure, for after-the-fact auditing |
| `meta` | last sync timestamp and other odds and ends |

### `games` columns

`appid` (primary key) / `name` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` / `priority` / `family` / `new_ach_date` / `updated_at` / `last_played` / `stats_checked_at`

Three decisions worth knowing before you write queries:

- **"This game has no achievements" is `has_achievements = 0` with `NULL` counts** — not a `0` total, and not a string like `N/A` sitting in a numeric column. `total IS NULL AND has_achievements IS NULL` means "not synced yet", which is a different thing.
- **`status` and `sync_locked` are separate columns.** `status` is the label you see and sort by (`''`, `Unvetted`, `Manual`); `sync_locked` is what actually makes a sync skip the row. The Dashboard moves both together, but you can keep the label while re-enabling the daily refresh:

  ```sql
  UPDATE games SET sync_locked = 0 WHERE appid = '...';
  ```

  If a row stubbornly won't update, check `sync_locked` first — that's almost always why.

- **`last_played` and `stats_checked_at` drive which rows the automatic sync bothers to check** (see `sweepBudget` in [configuration.md](configuration.md)). `last_played` is Steam's `rtime_last_played` as it stood the last time we successfully read that game; `stats_checked_at` is when that read happened. Both are written **only after a real answer from Steam** — a rate-limited game leaves them alone, so it stays first in line next time rather than being recorded as "already checked".

  `stats_checked_at` is deliberately not `updated_at`: `updated_at` moves whenever the row changes at all, including when you toggle ♥ or ★ from the Dashboard, so it can't answer "when did we last ask Steam about this". To force a game back to the front of the queue:

  ```sql
  UPDATE games SET stats_checked_at = NULL WHERE appid = '...';
  ```

## What Steam can't tell us

Steam's API is the source of truth for nearly everything, but a few situations need a human, and those are what `status` and `family` exist for.

**`Unvetted`** — games Steam hides from the owned-games API by default (its "Profile Features Limited" classification). They're still synced normally; they're just excluded from the aggregate completion average, which matches Steam's own AGCR methodology.

**`Manual`** — for when Steam genuinely can't give *your* account real data. The usual case is a Family Library Sharing title that a *different* family member actually plays: Steam records achievements against the playing account, not the licence holder, so your own account will permanently read 0 on it. These rows are edited by hand from the Dashboard and always skipped by the sync.

**The family flag** (the Dashboard's 家庭 badge) — purely informational, and a different situation from `Manual`: a shared or gifted game that *you* actually play, so Steam does return your real progress even though it isn't in your owned-games list. Use this rather than `Manual` so the game keeps syncing automatically; the flag just reminds you it wasn't self-purchased.

Two more things that look like bugs and aren't:

- A game can disappear from your owned-games list — a delisted free title, lapsed family sharing — while its achievement stats stay available forever. "Not owned" never means "not trackable."
- If a shared game is played on someone else's account, your progress on it will correctly read 0 forever. That's the only account this tool can see.

## Importing from a spreadsheet

If you already track this in a spreadsheet, import it **before your first sync**. Favorites (♥), spotlights (★), family flags, `Manual` rows and hand-entered achievement counts **cannot be recovered from Steam's API** — importing is the only way to keep them.

1. Export each sheet as CSV, with `RAW DATA`, `ACHIEVEMENTS`, or `GUIDES` somewhere in the filename.
2. Put them all in one folder.
3. `node tracker.js import ~/Downloads/steam-csvs`

The packaged app ([launcher/README.md](../launcher/README.md)) exposes the same step as an optional folder-path field under **③ 从表格导入** on the setup page, since it has no terminal to run the command from. It runs this identical import, offers blank templates for the three files, and fails the whole form if the folder can't be read rather than saving credentials and reporting success. The setup page stays reachable from the **设置** button on the Dashboard, so a skipped import can be done later.

**"Before your first sync" is a recommendation, not a deadline.** Import overwrites `status`, `sync_locked`, `family`, `favorite`, `priority`, `name` and the counts on every run — it is written to be re-runnable, so importing after a sync still restores those columns. Going in the recommended order just avoids a sync's fresh Steam numbers being replaced by older spreadsheet ones. What is genuinely unrecoverable is the spreadsheet itself: Steam's API cannot supply ♥/★/family/`Manual`, so keep the CSVs until you have confirmed the import landed.

Columns are read **by position**, not by header text, so translated or renamed headers are fine:

| Sheet | Columns, in order |
|---|---|
| `RAW DATA` | Status, AppID, Name, Achieved, Total, Rate, Favorite, Spotlight, NewAchDate, Family |
| `ACHIEVEMENTS` | AppID, Game, ApiName, NameCN, NameEN, Description, Hidden, IconURL |
| `GUIDES` | AppID, Game, URL, (type), Updated |

It handles `TRUE`/`FALSE`, `45.00%`, `1,000` and `N/A`, skips rows without a numeric AppID, and is idempotent — fix something in the spreadsheet, re-run, and those columns are simply overwritten again.

Then run `node tracker.js sync` to fill in everything Steam *can* tell you.

> If your spreadsheet is named something like "Steam Achievement Tracker", the exported filenames all contain the word "achievement". Import only looks at the part after the last ` - `, so `... - RAW DATA.csv` is still recognised correctly.

## Exporting

```bash
node tracker.js export            # writes to exports/
node tracker.js export ~/backups  # or anywhere
```

Writes `RAW DATA.csv`, `ACHIEVEMENTS.csv` and `GUIDES.csv` — the same layout `import` reads, so a round trip is lossless. Handy for poking at the data in a spreadsheet, or as a backup you can read in twenty years without this tool.
