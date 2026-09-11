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
| `hltb` | appid → its HowLongToBeat entry and how many hours finishing it takes |
| `hltb_history` | one row per reading taken from HowLongToBeat, so a figure's movement can be measured rather than guessed at |
| `sync_log` | every checkbox change, skip and failure, for after-the-fact auditing |
| `meta` | last sync timestamp and other odds and ends |

### `games` columns

`appid` (primary key) / `name` / `name_en` / `achieved` / `total` / `has_achievements` / `rate` / `status` / `sync_locked` / `favorite` / `priority` / `family` / `hidden` / `new_ach_date` / `updated_at` / `last_played` / `playtime_forever` / `stats_checked_at` / `perfect_lost_date` / `ach_added_date` / `cover_url`

Six decisions worth knowing before you write queries:

- **"This game has no achievements" is `has_achievements = 0` with `NULL` counts** — not a `0` total, and not a string like `N/A` sitting in a numeric column. `total IS NULL AND has_achievements IS NULL` means "not synced yet", which is a different thing.
- **`status` and `sync_locked` are separate columns.** `status` is the label you see and sort by (`''`, `Unvetted`, `Manual`); `sync_locked` is what actually makes a sync skip the row. The Dashboard moves both together, but you can keep the label while re-enabling the daily refresh:

  ```sql
  UPDATE games SET sync_locked = 0 WHERE appid = '...';
  ```

  If a row stubbornly won't update, check `sync_locked` first — that's almost always why.

- **`last_played` and `stats_checked_at` drive which rows the automatic sync bothers to check** (see `sweepBudget` in [configuration.md](configuration.md)). `last_played` is Steam's `rtime_last_played` as it stood the last time we successfully read that game; `stats_checked_at` is when that read happened.

  For a family-shared game there is no such field anywhere in Steam's API, so `last_played` is **worked out** instead: `playtime_forever` holds the minutes as of the previous sync, and when the number goes up the game was played somewhere in between — the moment that is noticed becomes the date. It is only ever set for rows the owned list does not mention, and the first sighting of one records the minutes without a date, since a single reading shows no change. That is why a shared game has to be seen twice before its 🎮 badge can appear, and why the one-off import above fills both columns in directly. Both are written **only after a real answer from Steam** — a rate-limited game leaves them alone, so it stays first in line next time rather than being recorded as "already checked".

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

`appid` + `api_name` (composite primary key) / `game_name` / `name_cn` / `name_en` / `description` / `description_en` / `hidden` / `icon` / `unlocked` / `rarity` / `rarity_checked_at`

- **Both languages come from one sync, not two.** `fetchGameSchema` calls `GetSchemaForGame` twice, once per language, because the name has always been stored in both. The English description arrives in the response fetched for the English *name*, so storing it costs no extra request.

- **A hidden achievement stores `''` for both descriptions.** The description is the spoiler; blanking one language and not the other would publish it in the other. `hidden = 1` with both empty is the normal, correct state for those rows — not a failed fetch.

- **`description_en = ''` on a row whose `description` is set means that game's detail predates the column.** That is the whole backfill signal: `selectSchemaTargets` re-fetches any game with Chinese descriptions and not one English one, **including games at 100%**, which the other two fetch reasons deliberately skip. It is one pass per game and then never again. To force one game through it:

  ```sql
  UPDATE achievements SET description_en = '' WHERE appid = '...';
  ```

  The test is per game rather than per row on purpose: an individual achievement can come back without an English description, and asking per row would put its game in the queue on every sync forever.

- **`game_name` is a denormalised copy of `games.name`,** used only as a fallback when the `games` row is gone. It is not a second name to keep bilingual — resolve a display name from `games.name_en || games.name` instead.

- **`unlocked` says whether this account holds the achievement.** It costs no extra request: the achievement sync already receives the whole list with a flag on each entry. `NULL` means never observed, which is a different fact from `0` (observed, still locked) — a game whose detail has never been fetched has no rows to write to, so the sync carries the set forward for the schema pass to apply the moment it makes them.

- **`rarity` is the share of all owners holding the achievement, 0–100**, from `GetGlobalAchievementPercentagesForApp`. It is **an input to the hours estimate, never displayed on its own** — `remainingDifficulty` weights each achievement by `−log(p)` so a game's completionist hours are apportioned by difficulty rather than by count. `rarity_checked_at` gates the refresh: the figure is computed across every owner and barely moves, so a game asked within the last 30 days is skipped, and a finished game is never asked at all.

  Do not simplify the apportionment to `1 − rate`. That assumes every achievement costs the same, and what is left in a part-finished game is by definition the tail nobody else finished either. The weight is the correction, and it is measured: across 101 of this library's finished games, `Σ −log(p)` predicts a game's completionist hours with R² 0.54, against 0.15 for the achievement count.

  **The apportionment step itself is unverified.** That fit says the weight tracks time *between* games; using it to divide one game's hours assumes the same law holds *within* one. No data here can test it — a finished game has nothing left to measure.

- **Neither column survives a `SELECT *`-style rewrite.** `replaceAchievements` upserts the descriptive columns and deletes only the rows the new schema no longer names. Clearing the game's rows first would discard both columns on every description refresh — which is most syncs — silently.

### `hltb` columns

`appid` (primary key) / `hltb_id` / `verified` / `manual` / `comp_100` / `comp_100_med` / `comp_100_lo` / `comp_100_hi` / `comp_100_count` / `checked_at`

How long a game takes to finish at 100%, from HowLongToBeat's **Completionist** figure. The tracker knows how many achievements are left but nothing about what they cost, and "4 left" is not a smaller job than "40 left" if the 4 are a multi-playthrough grind.

- **The four hour columns are seconds, and there are four because one number would be overclaiming.** `comp_100_med` is the median and the one shown; `comp_100` is the site's own headline figure, which is neither the mean nor the median; `comp_100_lo` and `comp_100_hi` are its rushed and leisurely ends. A single point estimate lands within ±30% of the truth about seven times in ten (measured against 101 of this library's finished games), which is why the spread is kept and shown rather than discarded.

- **`hltb_id` is resolved by appid, never by name.** Searching "Cities: Skylines" returns *Cities: Skylines II* ahead of it and "Slay the Spire" returns the sequel too, and a wrong match reports the wrong number of hours with nothing to show for it. The search only produces candidates; the answer is whichever candidate's own page carries this appid in `profile_steam`. `verified` records that this happened.

- **`hltb_id` NULL with `checked_at` set is a recorded miss** — searched, and nothing there carries this appid. It is a real answer and stops the search repeating every sync at up to four queries a game. Titles that are Chinese in every language (风信楼) have no English string to search with at all and can only be pinned by hand.

- **`manual` means the id was supplied by hand, and an automatic pass never overwrites it.** That is the entire point of pinning one: the search has already failed, or has already got it wrong.

- **`comp_100_count` is how many people reported a completionist time.** Single digits mean the figure is one stranger's playthrough rather than a measurement, and the Dashboard dims it instead of ranking on it as though it were evidence.

### `hltb_history` columns

`appid` + `checked_at` (primary key together) / `comp_100` / `comp_100_med` / `comp_100_count`

One row per reading taken from HowLongToBeat. The `hltb` table holds only the latest figures and a refresh overwrites them, so without this table "did this number change, and by how much" cannot be asked of the database that stores it.

- **The refresh interval is one fixed number for every game, and this table is what a better one would be built from.** A completionist figure is a median over submissions: at 500 submissions a month of new ones cannot move it, and at 3 a single one halves it — which argues for spending the refresh budget by how fast a row actually moves. How fast that is has never been measured, so the readings are collected first.

- **The signal is `comp_100_count`'s rate of change, not its size.** A count of 0 almost always means nobody will ever report one rather than that the game is new, so "few submissions ⇒ check often" spends the most requests on the rows worth the fewest. A count that *jumps* is a game whose content just changed. Telling those apart needs two readings, which is what this table is.

- **`checked_at` is the same stamp as the `hltb` row the reading came from**, so the two join. It is also half the primary key, which makes seeding and re-seeding safe: a reading already recorded is ignored rather than duplicated.

- **A miss records nothing.** A row with no `hltb_id` has no entry behind it and therefore no figure that could move; a row of nulls would only dilute the counts this table exists to produce.

- **An existing database is seeded with the figures it already holds**, on open, as that game's first reading. Without it the first refresh writes reading #1 with nothing to compare against and the first delta arrives two refresh cycles out instead of one.

Each game's oldest and newest reading side by side, once more than one has been taken:

```sql
WITH ordered AS (
  SELECT appid, checked_at, comp_100_med, comp_100_count,
         ROW_NUMBER() OVER (PARTITION BY appid ORDER BY checked_at)      AS oldest,
         ROW_NUMBER() OVER (PARTITION BY appid ORDER BY checked_at DESC) AS newest,
         COUNT(*)     OVER (PARTITION BY appid)                          AS readings
    FROM hltb_history
)
SELECT g.name,
       f.readings,
       julianday(l.checked_at) - julianday(f.checked_at) AS days_apart,
       f.comp_100_count AS count_then, l.comp_100_count AS count_now,
       f.comp_100_med   AS med_then,   l.comp_100_med   AS med_now
  FROM ordered f
  JOIN ordered l ON l.appid = f.appid AND l.newest = 1
  LEFT JOIN games g ON g.appid = f.appid
 WHERE f.oldest = 1 AND f.readings > 1
 ORDER BY (l.comp_100_count - f.comp_100_count) DESC;
```

**Divide by `days_apart`, never compare the raw deltas.** Refreshes are capped per run and taken stalest-first, so one game's two readings are not the same distance apart as another's, and a count that grew by 4 over 30 days is not the observation that one which grew by 4 over 90 days is.

### `guides` columns

`appid` (primary key) / `name` / `url` / `kind` / `updated` / `lang` / `gen_prose` / `status_seen_at`

`kind` is `notion` or `local`, and `url` means different things in each: a Notion page URL, or a **bare filename** inside `guidesDir`. The filename is not usable as a link — a browser would resolve it against the server's own address and get a 404 — so the Dashboard is served `/guide/<appid>` instead, which the server resolves through the table.

- **`gen_prose` holds the section intros this program wrote last time**, as a JSON array. It exists for one job: on an overwrite, an intro found on the page that also appears here was written by us and may be replaced, while one that is not found was written or edited by you and is kept. Without the column the only alternative is a heuristic, and the cost of guessing wrong is deleting your own writing.

- **The guide's text is never in this table.** Only a pointer to where it lives, because a guide has to stay human-editable and tickable where it is. This table records *where*, never *what*.
- **`status_seen_at` is when this page's status was last settled against play.** The guide status pass promotes a part-finished game to `In progress` when its `last_played` is newer than this stamp — never on a fixed recency window, which would move a hand-set `Paused` back on every Dashboard open for as long as the window lasted. Setting a status by hand does not move `last_played`, so nothing re-triggers; playing the game again does, which is what lifts it back out of `Paused`.

  A page the pass left alone is stamped too, or one set by hand would keep a null stamp forever and could never be promoted. A page whose write failed is not, so the next run retries. `NULL` means never looked at. On that first sight the test is not play at all but whether the page's own claim still holds: only `Not started` is promoted, and only when something is unlocked — a game can carry unlocks and no `last_played` whatsoever, so requiring play evidence there would strand those pages for good.

### `guides.lang`

Which language a guide is written in — `'zh'` or `'en'`, defaulting to `'zh'`. It is written after a guide is successfully generated or rewritten, and never by guide *discovery*, which registers pages it found and knows nothing about their contents.

**It is a display fact and has no correctness role.** Two surfaces read it: the marker in the achievement panel's header, and the wording of the rewrite dialog's title. Matching does not — the reverse lookup, the `paraphrased-description` check and the same-name ambiguity rule all accept either language's description — so a row carrying the wrong value costs a marker, never a tick. That is deliberate, because the rows that predate the column carry an assumed value rather than a recorded one: every guide in the library at the time was Chinese.

Anything other than `'en'` is stored as `'zh'`. A third value would make the marker unreachable rather than wrong, which is the harder failure to notice.

## What Steam can't tell us

Steam's API is the source of truth for nearly everything, but a few situations need a human, and those are what `status` and `family` exist for.

**`Unvetted`** — games Steam hides from the owned-games API by default (its "Profile Features Limited" classification). They're still synced normally; they're just excluded from the aggregate completion average, which matches Steam's own AGCR methodology.

**`Manual`** — for when Steam genuinely can't give *your* account real data. The usual case is a Family Library Sharing title that a *different* family member actually plays: Steam records achievements against the playing account, not the licence holder, so your own account will permanently read 0 on it. These rows are edited by hand and always skipped by the sync.

On the Dashboard this is **the 🔒 lock on each row**, not the word "Manual" — locking a row is exactly "stop syncing this one, I'll keep the numbers myself", which is what the column has always meant. The database still calls it `Manual`; only the on-screen vocabulary changed.

**The family flag** (the Dashboard's 家庭 badge) — purely informational, and a different situation from `Manual`: a shared or gifted game that *you* actually play, so Steam does return your real progress even though it isn't in your owned-games list. Use this rather than the lock so the game keeps syncing automatically; the flag just reminds you it wasn't self-purchased.

**The sync puts the flag on by itself, too.** `GetRecentlyPlayedGames` is the one endpoint that lists a family-shared title, so each sync asks it: anything you played in the last fortnight that isn't in your owned list and isn't in the table yet is added on the spot, flagged family, and named in a Dashboard notice. Nothing is asked first — the row is local and one click from deleted, and a prompt nobody reads is a game that never gets tracked. **A row you delete and keep playing comes back**; use 已隐藏 rather than delete if you want it gone from the table but not re-added. Games you last played more than a fortnight ago are outside that window and still need adding by hand.

That same reading is what gives these rows a play date at all. Steam publishes no "last played" timestamp for a shared game, so the tracker watches the playtime instead: when it is higher than last sync's, the game was played in between, and that moment becomes the date. The consequence is that **a shared game has to be seen twice before its 🎮 badge can appear** — the first sync only records a starting number. And when you later buy that game, the recorded minutes are cleared along with the badge: Steam supplies a real play date for a game you own, and two answers to one question is how they start disagreeing.

**Games you played before all this can be fetched once.** The window above is two weeks wide, so a shared game you last played months ago is invisible to the sync and always will be. `node tracker.js family-import`, or the third field of step 1 on the settings page, reads the family library directly and adds them — and gives the ones already tracked the play dates the sync could not work out on its own. It needs a browser token rather than your API key, which is why it is something you run rather than something that happens; [cli.md](cli.md) has the details.

**The sync takes the flag off once you own the game.** A title you bought after playing it through the family library turns up in `GetOwnedGames`, which settles the question the badge was answering, and the next sync clears it — the count appears on the library line as 「清除家庭标记 N 款」. Nothing else removes it, so a row Steam never lists keeps its badge indefinitely. The one case this gets wrong is a **gift**: it is owned too, so it loses the badge and needs marking again by hand. Steam reports the licence, not how it was acquired, and the two cannot be told apart.

Adding a game by hand asks whether it's a family-library title, **defaulting to yes**, because a game you bought is normally in `GetOwnedGames` already and never needed adding. **Normally, not always** — a free game Steam has recorded no playtime for is absent from that list too, and so is a delisted one, and neither is family-shared. So the badge can land on a game that is entirely yours; it is informational, and one click on it puts that right. Added rows are **not** locked: family sharing is precisely the case where Steam does return your progress, so locking them would freeze the numbers at whatever they were the moment you added the row. Lock a row later if it turns out Steam has nothing for it.

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

Four things about it are load-bearing, and each fails silently if changed:

- **The database is snapshotted with `VACUUM INTO`, never file-copied.** It runs in WAL mode, so recent writes live in `data/steam.db-wal` until a checkpoint and a plain copy can be stale. Measured separately: while the app is running in the tray, `steam.db` is **locked** — PowerShell's `Get-FileHash` cannot even read it, while `VACUUM INTO` works fine.
- **Restore does not replace the database file.** The server is holding an open handle and Windows will not let an open file be deleted. It attaches the backup as a second database and copies the tables across inside one transaction, so the handle stays valid and nothing needs restarting.
- **Tables are copied column by shared column, not `SELECT *`.** An older backup has fewer columns (`cover_url` was added later), and `SELECT *` would fail outright on that — or, worse in the other direction, silently misalign. Missing columns take their default.
- **Which tables move is a written list, and a table missing from it is silently skipped.** The zip always holds the whole database, so the data is in the file either way — but the restore copies only the tables it names, and one left out is not an error. It is a restore that finishes, reports success, and leaves that table holding whatever this machine already had. `hltb` sat outside the list for a month exactly that way. A test now checks the list against the schema, so a table added later fails CI instead of going missing. **A backup taken before that fix still restores its HowLongToBeat rows** — they were always inside the zip.

Restoring **replaces** the tables — it is a restore, not a merge, so rows on this machine that aren't in the backup are gone. Guide *files* are the exception: they are written over, never deleted, because losing a hand-written `.md` is unrecoverable while an extra unreferenced file costs nothing.

`guides/.drafts/` is left out (unfinished AI output, which `node tracker.js drafts --clean` exists to delete). `guides/.backups/` is kept — those are previous versions of real guides, and any of them can be written back from that game's 备份 button on the Dashboard, so they are worth carrying to a new machine. It also means the zip grows with every overwrite (a Notion page dumps as ~120 KB of block JSON); 设置 → 第 4 步 → 攻略备份 lists them biggest-first for pruning, with a 全部删除 at the foot of the list.

## Exporting to a spreadsheet

```bash
node tracker.js export            # writes to exports/
node tracker.js export ~/Desktop  # or anywhere
```

Writes `RAW DATA.csv`, `ACHIEVEMENTS.csv` and `GUIDES.csv`. Handy for sorting, filtering and charting the data in a spreadsheet.

**This is one-way, and it is not a backup.** There is no import, so nothing reads these files back. They also hold three tables and nothing else: your credentials in `config.json`, the local guide bodies under `guides/`, and `sync_log` are all absent. Use `node tracker.js backup` for anything you might need to restore.
