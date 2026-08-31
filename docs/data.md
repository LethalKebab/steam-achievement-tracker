# The data

Everything is in `data/steam.db`, a single SQLite file (gitignored). `openDb()` creates the tables if they're missing and is safe to call repeatedly, so there is no separate migration step to run. Open the file with anything:

```bash
sqlite3 data/steam.db "SELECT name, achieved, total FROM games ORDER BY rate DESC LIMIT 10"
```

**What that path is relative to depends on how the program was started**, and `config.json` and `guides/` follow it:

| Started as | Rooted at |
|---|---|
| `node tracker.js …`, or `npm start` in `launcher/` | the checkout |
| a build you made yourself (`npm run build`) | the checkout as well — `postbuild.js` leaves a pointer next to the exe |
| the release zip | `resources\tracker\` inside the extracted folder |

Only the third is a surprise, and it is why the whole extracted folder is the thing to move or back up. `TRACKER_DATA_DIR` overrides all three; `dataDir` in `launcher/local.config.json` is what sets it for a packaged build.

## Tables

| Table | Holds |
|---|---|
| `games` | one row per appid: both names, achieved/total, completion rate, status, ♥/★/family flags |
| `achievements` | per-achievement detail — CN + EN names, CN + EN descriptions, hidden flag, icon URL |
| `guides` | appid → guide location, plus `kind` (`notion` or `local`) and `lang` (which language the guide is written in) |
| `sync_log` | every checkbox change, skip and failure, for after-the-fact auditing |
| `meta` | last sync timestamp and other odds and ends |

### `games` columns

`appid` (primary key) / `name` / `name_en` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` / `priority` / `family` / `new_ach_date` / `updated_at` / `last_played` / `stats_checked_at` / `perfect_lost_date` / `ach_added_date` / `cover_url`

Six decisions worth knowing before you write queries:

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

- **`perfect_lost_date` and `ach_added_date` record two things that happened, not two things that are true.** They feed the 🔔 notifications on the Dashboard: a game you had at 100% that the developer then added achievements to, and a game Steam previously reported as having no achievement system that now has one.

  Both are stamped inside `updateGameStats`, which is the only moment the previous values are still visible. A row that has dropped below 100% looks exactly like a row that was never at 100%, and `has_achievements` is overwritten with `1` the instant new stats arrive — so neither event can be reconstructed afterwards from the row itself. That is also why the notifications start out empty on an existing database: nothing recorded these events before the columns existed, and there is no way to backfill them.

  A repeat of either event overwrites the stamp with the newer time, so "how long ago" always refers to the most recent occurrence.

- **`name` is the localised title and `name_en` is the English one.** The sync hunts for a Chinese name for `name`; roughly a third of a Chinese-language library ends up stored under a title that contains no English at all. Which of the two a row *displays* is `uiLanguage`'s decision (see [configuration.md](configuration.md)); search matches either, whichever is on screen.

  Owned games get it free: `GetOwnedGames` ignores `l=` and answers in English either way, so one response fills the whole owned library. Rows that never appear there (family-shared, delisted, hand-added) cost one `appdetails?l=english` call each, once.

  `''` means "no English title on record", and it is deliberately not a copy of `name` — those are two different facts, and a display layer needs to tell them apart to know whether a second name exists. `name_en = name` is a real and normal state: it is what an English-titled game stores, and also what a game published only in Japanese stores, since `l=english` answers with its Japanese title. Clearing it is safe — the next sync re-fills it:

  ```sql
  UPDATE games SET name_en = '' WHERE appid = '...';
  ```

- **`cover_url` is a cache, and it is normally `NULL`.** The Dashboard builds a cover URL from the appid — `cdn.akamai.steamstatic.com/steam/apps/<appid>/header.jpg` — which works for the large majority of a library and costs no extra request. It fails for games whose store art Steam has moved under a content-hash path (`store_item_assets/steam/apps/<appid>/<hash>/header.jpg`); that hash cannot be derived from anything we hold, and it differs per asset, so the header's hash tells you nothing about the capsule's. Measured over 314 games in August 2026: 9 failed, every one of them a recent appid, and four alternative host/path spellings 404'd for all of them.

  So a broken image triggers one `appdetails` lookup, and the authoritative URL it returns is stored here. Only those games ever get a value. Clearing it is safe — the next page view re-discovers it:

  ```sql
  UPDATE games SET cover_url = NULL WHERE appid = '...';
  ```

  A failed lookup is deliberately **not** cached. Rate limiting and not-yet-published store pages both produce "no cover" and both stop being true later; recording that as a fact would retire the game's artwork permanently.

### `achievements` columns

`appid` + `api_name` (composite primary key) / `game_name` / `name_cn` / `name_en` / `description` / `description_en` / `hidden` / `icon`

- **Both languages come from one sync, not two.** `fetchGameSchema` calls `GetSchemaForGame` twice, once per language, because the name has always been stored in both. The English description arrives in the response fetched for the English *name*, so storing it costs no extra request.

- **A hidden achievement stores `''` for both descriptions.** The description is the spoiler; blanking one language and not the other would publish it in the other. `hidden = 1` with both empty is the normal, correct state for those rows — not a failed fetch.

- **`description_en = ''` on a row whose `description` is set means that game's detail predates the column.** That is the whole backfill signal: `selectSchemaTargets` re-fetches any game with Chinese descriptions and not one English one, **including games at 100%**, which the other two fetch reasons deliberately skip. It is one pass per game and then never again. To force one game through it:

  ```sql
  UPDATE achievements SET description_en = '' WHERE appid = '...';
  ```

  The test is per game rather than per row on purpose: an individual achievement can come back without an English description, and asking per row would put its game in the queue on every sync forever.

- **`game_name` is a denormalised copy of `games.name`,** used only as a fallback when the `games` row is gone. It is not a second name to keep bilingual — resolve a display name from `games.name_en || games.name` instead.

### `guides.lang`

Which language a guide is written in — `'zh'` or `'en'`, defaulting to `'zh'`. It is written after a guide is successfully generated or rewritten, and never by guide *discovery*, which registers pages it found and knows nothing about their contents.

**It is a display fact and has no correctness role.** Two surfaces read it: the marker in the achievement panel's header, and the wording of the rewrite dialog's title. Matching does not — both the reverse lookup and the `paraphrased-description` check accept either language's description — so a row carrying the wrong value costs a marker, never a tick. That is deliberate, because the rows that predate the column carry an assumed value rather than a recorded one: every guide in the library at the time was Chinese.

Anything other than `'en'` is stored as `'zh'`. A third value would make the marker unreachable rather than wrong, which is the harder failure to notice.

## What Steam can't tell us

Steam's API is the source of truth for nearly everything, but a few situations need a human, and those are what `status` and `family` exist for.

**`Unvetted`** — games Steam hides from the owned-games API by default (its "Profile Features Limited" classification). They're still synced normally; they're just excluded from the aggregate completion average, which matches Steam's own AGCR methodology.

**`Manual`** — for when Steam genuinely can't give *your* account real data. The usual case is a Family Library Sharing title that a *different* family member actually plays: Steam records achievements against the playing account, not the licence holder, so your own account will permanently read 0 on it. These rows are edited by hand and always skipped by the sync.

On the Dashboard this is **the 🔒 lock on each row**, not the word "Manual" — locking a row is exactly "stop syncing this one, I'll keep the numbers myself", which is what the column has always meant. The database still calls it `Manual`; only the on-screen vocabulary changed.

**The family flag** (the Dashboard's 家庭 badge) — purely informational, and a different situation from `Manual`: a shared or gifted game that *you* actually play, so Steam does return your real progress even though it isn't in your owned-games list. Use this rather than the lock so the game keeps syncing automatically; the flag just reminds you it wasn't self-purchased.

Adding a game by hand asks whether it's a family-library title, **defaulting to yes** — anything you bought yourself is already in `GetOwnedGames` and never needed adding. Added rows are **not** locked: family sharing is precisely the case where Steam does return your progress, so locking them would freeze the numbers at whatever they were the moment you added the row. Lock a row later if it turns out Steam has nothing for it.

Two more things that look like bugs and aren't:

- A game can disappear from your owned-games list — a delisted free title, lapsed family sharing — while its achievement stats stay available forever. "Not owned" never means "not trackable."
- If a shared game is played on someone else's account, your progress on it will correctly read 0 forever. That's the only account this tool can see.

## Backup and restore

One zip holding `data/steam.db`, everything under `guides/`, and `config.json`. Restore it on another machine and the app opens straight to the Dashboard — the credentials travel too, so there is no setup wizard to sit through.

```bash
node tracker.js backup                    # writes to backups/
node tracker.js backup ~/Dropbox          # or anywhere
node tracker.js backup --no-config        # leave the credentials out

node tracker.js restore <file.zip>        # asks before overwriting
node tracker.js restore <file.zip> --keep-config   # data only, keep this machine's credentials
```

In the app: the first-run screen offers **从备份恢复** before the setup wizard, and the settings page's **备份** tab has both halves. The backup is written to disk and its path shown — deliberately not offered as a browser download, because Electron would fall back to its native save dialog and [native dialogs do not work in this app](self-update.md).

**The zip contains your credentials in plain text** — the Steam API key, the Notion token and the AI key — unless you pass `--no-config` (or untick the box). That is the point of including them, and it is also the risk: anyone who gets the file can spend your AI credit. Treat it like a password file.

Three things about it are load-bearing, and each fails silently if changed:

- **The database is snapshotted with `VACUUM INTO`, never file-copied.** It runs in WAL mode, so recent writes live in `data/steam.db-wal` until a checkpoint and a plain copy can be stale. Measured separately: while the app is running in the tray, `steam.db` is **locked** — PowerShell's `Get-FileHash` cannot even read it, while `VACUUM INTO` works fine.
- **Restore does not replace the database file.** The server is holding an open handle and Windows will not let an open file be deleted. It attaches the backup as a second database and copies the tables across inside one transaction, so the handle stays valid and nothing needs restarting.
- **Tables are copied column by shared column, not `SELECT *`.** An older backup has fewer columns (`cover_url` was added later), and `SELECT *` would fail outright on that — or, worse in the other direction, silently misalign. Missing columns take their default.

Restoring **replaces** the tables — it is a restore, not a merge, so rows on this machine that aren't in the backup are gone. Guide *files* are the exception: they are written over, never deleted, because losing a hand-written `.md` is unrecoverable while an extra unreferenced file costs nothing.

`guides/.drafts/` is left out (unfinished AI output, which `node tracker.js drafts --clean` exists to delete). `guides/.backups/` is kept — those are previous versions of real guides, and any of them can be written back from that game's 备份 button on the Dashboard, so they are worth carrying to a new machine. It also means the zip grows with every overwrite (a Notion page dumps as ~120 KB of block JSON); 设置 → 第 4 步 → 攻略备份 lists them biggest-first for pruning, with a 全部删除 at the foot of the list.

## Exporting to a spreadsheet

```bash
node tracker.js export            # writes to exports/
node tracker.js export ~/Desktop  # or anywhere
```

Writes `RAW DATA.csv`, `ACHIEVEMENTS.csv` and `GUIDES.csv`. Handy for sorting, filtering and charting the data in a spreadsheet.

**This is one-way, and it is not a backup.** There is no import, so nothing reads these files back. They also hold three tables and nothing else: your credentials in `config.json`, the local guide bodies under `guides/`, and `sync_log` are all absent. Use `node tracker.js backup` for anything you might need to restore.
