# Configuration

Everything lives in `config.json` in the project root, created by `node tracker.js init` — or by the first-run form in the packaged app, which writes the same file. It's gitignored and written with mode `600` (only your user can read it), because it holds your API credentials. (`TRACKER_DATA_DIR`, below, can move where that file lives.)

Only `steamApiKey` and `steamId` are required. Everything else has a working default — the file `init` writes contains just those two.

```jsonc
{
  "steamApiKey": "…",         // from https://steamcommunity.com/dev/apikey
  "steamId": "…",             // your SteamID64, 17 digits

  "language": "schinese",     // language for game + achievement names from Steam
  "port": 8777,               // Dashboard port
  "syncStaleHours": 12,       // auto-sync when opening the Dashboard if data is older; 0 = never
  "syncGuidesOnServe": true,  // also look for new guide pages when opening the Dashboard
  "checkboxSyncOnServe": true,        // also tick guide checkboxes for games that changed
  "checkboxSyncOnServeCascade": false,// let that also tick nested sub-steps; off on purpose
  "guideStatusOnServe": true,         // guide page Status ⇄ completion (Done / Staged)
  "requestDelayMs": 100,      // pause between official Web API calls
  "storeRequestDelayMs": 300, // pause between store calls (name lookup, cover art, search)
  "sweepBudget": 120,         // how many "not played, but check anyway" games per auto-sync; 0 = off
  "maxStatsAgeDays": 7,       // re-verify a game at least this often even if untouched
  "perfectGameMaxAgeDays": 3, // 100% games re-verified sooner — they're the ones that can drop
  "dbPath": "data/steam.db",  // relative to the project root
  "guidesDir": "guides",      // where local markdown guides live

  "notion": {                 // only needed for guide checkbox sync
    "token": "…",
    "overviewDbId": "…"
  },

  "ai": {                     // only needed for AI guide generation; `init --ai` writes it
    "provider": "deepseek",   // "deepseek" | "anthropic" | "gemini" | "deepseek-openai"
                              // ↑ which of the blocks below is active right now

    "providers": {            // one block per vendor; keep several configured at once
      "deepseek":  { "apiKey": "…", "model": "" },
      "anthropic": { "apiKey": "…", "model": "" },
      "gemini":    { "apiKey": "…", "model": "" }
    },
    "effort": "high",         // low | medium | high | off — research depth; also settable per run
    "thinking": null,         // "adaptive" | "disabled" | "off"; blank = per-endpoint default
    "maxTokens": 32000,       // caps thinking AND prose together, not prose alone
    "maxAchievements": 500,   // refuse to generate above this
    "chunkSize": 50,          // max achievements per writing pass; passes are evenly sized
    "maxRounds": 3,           // rewrite rounds before the draft is kept as-is
    "concurrency": 3,         // how many passes are written at once; 1 = one at a time

    "maxSearches": 8,         // web_search calls per request
    "maxFetches": 10,         // web_fetch calls per request
    "maxFetchTokens": 50000,  // how much of one page to pull back
    "allowedDomains": [],     // non-empty = hard restrict search to these; empty = no limit
    "maxContinuations": 5,    // server-tool loop resumes before giving up
    "maxRetries": 3,
    "requestTimeoutMs": 600000,
    "fallbacks": true,        // anthropic: re-run on another model if a classifier declines
    "showThinking": false,    // stream a summary of the reasoning; debugging only

    "geminiTools": ["google_search"],  // gemini: which server-side tools to declare
    "geminiThinkingBudget": null       // gemini: unset means "don't send the field at all"
  }
}
```

## Notes on individual options

**`ai.provider` and `ai.providers`** — `providers` holds one block per vendor and `provider` names which one is live. Switching between them is a one-word edit, and each vendor keeps its own `apiKey` and `model` across the switch.

You do not have to edit the file by hand: the settings page (设置 → Step 2) writes into these blocks. Pick a vendor, paste its key, save — then switching to another vendor and back needs no key at all. Vendors that already have one are marked `· 已配置` in the dropdown, and the key field's 「已配置,留空则不改」 badge follows whichever vendor is selected. Saving one vendor never touches another's block. Changing the dropdown clears anything half-typed in the key field, since that text was meant for the vendor you just left.

Three fields live inside those blocks — `apiKey`, `model`, and `baseUrl` — and the reason is the same for all three: **more than one provider reads them, and the right value differs per vendor.** A model name is vendor-specific (`claude-*` / `gemini-*` / `deepseek-*`), so one shared `model` field has to be wiped every time you switch, which silently discards a version you pinned. `baseUrl` is read by both the Anthropic and DeepSeek paths, and one vendor's endpoint address is meaningless to the other. Everything else stays at the `ai.*` level: the budgets (`maxTokens`, `chunkSize`, `effort`, …) are correct at the same value for every vendor, and the single-vendor knobs (`geminiTools`, `webFetch`, `searchTool`, `anthropicExtras`, …) are only ever read by the one provider they belong to, so a leftover value is ignored rather than misapplied.

The older flat `ai.apiKey` / `ai.model` still work and need no edit. They are treated as belonging to whatever `ai.provider` says in the file — so on load they are adopted into that vendor's block, and they are **never** offered to a different vendor. That refusal is the point: handing DeepSeek's key to `api.anthropic.com` produces a 401 whose message says to check `ANTHROPIC_API_KEY`, sending you after a variable that was set correctly all along. An empty key instead reports which vendor is unconfigured.

Environment variables win over both, and they are looked up **by the vendor being asked for** rather than by the one written in the file.

**`language`** — passed to Steam as the `l=` parameter, so it changes the names you see for games and achievements. Steam's store API has a quirk where it sometimes ignores this for game *titles*, which is why the code falls back to scraping the store page for a localised name.

**`syncStaleHours`** — `serve` checks how long ago the last successful sync finished. If it's longer ago than this, it kicks off a sync in the background and shows a progress bar in the corner of the page. Note this check happens **once, when the server starts** — refreshing the page in your browser re-reads the local database but never re-checks Steam. Set it to `0` if you'd rather only ever sync manually.

Either way, the **立即同步** button next to the "上次同步" line on the Dashboard starts a sync on demand, ignoring `syncStaleHours` entirely. It's the same background sync, so the usual progress bar and automatic refresh apply, and the button greys out while one is running — including a sync you started from the CLI or another tab.

**`syncGuidesOnServe`** — when `serve` starts it also runs guide discovery, the same thing `node tracker.js guides` does: scan `guides/*.md` and the Notion guide database for pages carrying an `appid:` line, and register any new ones so their links appear on the Dashboard. Deliberately **not** gated by `syncStaleHours` — you often create a guide page minutes after a sync, when achievement data is still fresh, and the link needs to show up now rather than in twelve hours. It needs no Steam credentials, and a failure (expired Notion token, API down) is logged and otherwise ignored. Costs a couple of Notion API calls per start, plus one page read per not-yet-registered page; set it to `false` to skip it.

**`checkboxSyncOnServe`** — after the background sync finishes, tick guide checkboxes for the achievements it just found. Applies both to the sync that runs when `serve` starts and to the one behind the 立即同步 button. This is the only place in the project that writes to Notion without a `--dry-run` in front of it, which is why it is scoped tightly: it visits **only the games that changed in that run** — your unlocked count went up, the developer added achievements, or a guide page was registered for the first time that run. Nothing changed means no Notion calls at all, which is the common case. A full pass over every eligible game costs ~40 page reads and stays a manual `node tracker.js checkbox-sync`.

Every tick is written to `sync_log` just like the manual command's, so `node tracker.js log 30` is the review path; the Dashboard also shows a notice naming the first few, which doesn't auto-dismiss. A Notion failure here is soft — it shows as its own notice and never turns into "sync failed", since the achievement data synced fine. Set to `false` to tick only when you run the command yourself.

One deliberate exception to the usual rules: a game already at 100% is normally skipped, but one that hit 100% *in that run* is still visited. Without it, the achievement that completes a game could never have its box ticked automatically — by the next run the game is at 100% and would be skipped every time.

**`checkboxSyncOnServeCascade`** — whether the automatic tick also cascades to nested sub-step checkboxes under an unlocked achievement. Defaults to `false`, unlike the manual command, which cascades unless you pass `--no-cascade`. The cascade assumes "parent unlocked ⇒ every sub-step listed under it was done", which is right for all-of achievements and wrong for any-of ones — nine endings listed under "reach an ending" would get eight false ticks. The manual command lets you check a `--dry-run` first; the automatic path has no such gate, so it stays off here.

**`guideStatusOnServe`** — after the tick pass, keep each Notion guide page's `Status` in step with completion: `Done` when a game reaches 100%, back to `Staged` when it drops below. Runs on Dashboard open and after 立即同步, and standalone as `node tracker.js guide-status` (with `--dry-run`).

Dropping below 100% means a developer patched in new achievements — the one kind of change that happens without you playing, and so the one you'd otherwise never spot.

Both rules are written over *current state* rather than over the moment of crossing. Crossing happens once, inside one sync; if that particular run can't write to Notion, a transition-based rule would lose it permanently, because every later run only ever sees the same value on both sides. Checking current state makes the pass idempotent and self-repairing. It costs about three API calls per run regardless of library size — the page listing was already being fetched for guide discovery.

The directions are not equally aggressive, on purpose. Promotion overwrites anything that isn't already `Done`, `Differed` included: completion wins over a hand-set workflow state. Demotion touches **only** `Done` — a sub-100% page you've marked `Paused` or `In progress` is a decision you made, and overwriting it on every Dashboard open would leave you and the tool fighting. A game whose achievement total becomes unknown isn't treated as a drop.

Notion-kind guides only; local markdown has no status property. Set to `false` to leave the property alone.

**`requestDelayMs` / `storeRequestDelayMs`** — how long to wait between calls to Steam. These are two separate settings because Steam has two very different services behind them.

`requestDelayMs` (100 ms) paces the official Web API at `api.steampowered.com`, which is where almost every request in a sync goes: your library, achievement counts, achievement details. This one is generous — a measurement of 400 back-to-back requests with no pause at all, sustained at 11 per second for 36 seconds, produced no rate limiting whatsoever, so 100 ms leaves plenty of room.

`storeRequestDelayMs` (300 ms) paces the store at `store.steampowered.com`, used only for looking up a game's Chinese name, fetching cover art, and searching. It is deliberately slower and **should not be lowered to match the other one**: the store is far more strictly limited, and exceeding it can get your IP blocked rather than merely throttling your API key. It is also a small share of any sync, so keeping it slow costs almost nothing.

If a sync reports games as "留待重试" (left for retry) you are being rate-limited: raise `requestDelayMs` to 300–800 and run again.

**`sweepBudget` / `maxStatsAgeDays` / `perfectGameMaxAgeDays`** — these three control how much work the *automatic* sync does when you open the Dashboard. (`node tracker.js sync` ignores them and always checks everything; `sync --fast` uses them.)

The auto-sync does not walk the whole library. It checks a game when any of these is true:

1. **You played it** since the last check — Steam's `rtime_last_played` says so. Your unlocked count can't change without this, so this group is what keeps `achieved` exactly right.
2. **It isn't in your `GetOwnedGames` list** — family-shared, delisted, or hand-added rows have no play timestamp to check, so they're refreshed every time.
3. **It's overdue for a re-check** — because the *total* achievement count is a property of the game, not of you: a developer patch can add achievements while you're not looking, which would silently drop a 100% game below 100%. `maxStatsAgeDays` (and the shorter `perfectGameMaxAgeDays` for games at 100%) is what catches that. `sweepBudget` caps how many of these run per sync, so coming back after a long break doesn't produce one enormous sync — the backlog just drains over the next few.

On a 310-game library this takes a routine sync from **~160 s to ~8 s**, rising to ~25 s on syncs that include a full sweep batch.

**The thresholds are targets, not guarantees** — `sweepBudget` is the real constraint. How many rows fall due per day is the sum of `1 / each game's own deadline`, so it depends on how much of your library is finished: a 313-game library with 143 games at 100% needs about **72 rows a day**. The default of **120** covers that even if you open the Dashboard only once a day.

In normal use the cap does not bind at all — once every game is inside its deadline there are only a few dozen rows due, so a sync checks them and stops. The cap matters after you have been away: it is what stops a fortnight's backlog from becoming one enormous sync, letting it drain over the next few instead. At roughly half a second per row, 120 is about a minute in the worst case, and it runs in the background — the Dashboard is usable immediately.

Raising it further has diminishing returns and one real cost: if every sync clears the whole backlog, every game ends up last-checked at the same moment, so they all fall due together and the work arrives in spikes rather than spread out. Setting it to `0` disables the sweep entirely — then a game that adds achievements is only noticed the next time you actually play it.

**`notion.overviewDbId`** — the Notion **database** holding your guide pages; a plain page will not work. Easiest route is `node tracker.js init --notion --create`, which builds one with the right properties and fills this in for you. To point at an existing database instead, open it as a full page and take the 32-character hex string from the URL, *before* the `?v=` (that part is the view ID, not the database). Its status property, if it has one, needs the options `Not started` / `In progress` / `Staged` / `Done`; `node tracker.js notion-check` tells you what's missing without writing anything. See [guides.md](guides.md).

**`ai.*`** — settings for AI guide generation ([design and status](ai-guide-writing.md)); nothing reads them unless you run `node tracker.js ai-check` or `node tracker.js guide-gen`. It is the one part of this project that spends money, so a few of the defaults are deliberately conservative and `guide-gen` asks for confirmation before it starts.

`maxAchievements` (500) is a refusal threshold, not a truncation: a game above it is rejected with an explanation rather than given a worse guide. A game with more achievements than `chunkSize` (50) is written in several passes rather than refused, and validation always runs over the assembled guide. What the limit protects now is your time and spend, not feasibility: a 400-achievement game is nine passes.

**`concurrency` (3) is how many of those passes are written at the same time.** Each pass covers a different set of achievements and none depends on another, so the first round takes about as long as its slowest pass instead of the sum of all of them — the difference on a large game is most of the total time. Set it to `1` to go back to one pass at a time, which is worth doing if you are trying to reproduce a problem. Raising it mostly spends your provider's rate limit; being throttled is retried automatically and doesn't lose a pass. Only the first round runs in parallel: later rounds re-ask just the passes that failed validation, usually one or two, where there is nothing to gain.

One visible consequence: because several passes are being written at once, progress reports **how many passes are finished** rather than which one is in progress. `maxRounds` (3) is how many times a failed validation gets fed back to the model before the attempt is kept as a draft under `guides/.drafts/` — that directory is invisible to guide discovery, so an unvalidated draft can never be registered and can never be used to tick your checkboxes.

**`chunkSize` is a ceiling, not a pass length.** The number of passes is computed from it and the achievements are then spread evenly, so 55 achievements at the default become two passes of 28 and 27 — not 50 and 5. Lowering it therefore shortens every pass and adds passes only as needed; it can never make a pass longer.

`maxTokens` caps thinking **and** prose together, not prose alone. A pass that runs out mid-way is not silently accepted — the generator halves that pass and re-asks the two halves, repeating until the writing fits or the pass is down to five achievements. **So a truncation is usually not something you need to act on**, and reaching for a bigger `maxTokens` is usually the wrong reflex: the budget is shared with thinking, and raising it has been measured to buy thinking rather than prose (16000 → 32000 moved output tokens +79% and guide text +7%). If a five-achievement pass still won't fit, the message says so, and the thing to change is the endpoint or model. There is no temperature setting, because the models this targets reject it outright.

**`effort` decides how much research goes into a guide, and it is the only setting here that changes how long a run takes.** You can set it three ways, in increasing order of scope: pick it in the confirmation that appears before each generation on the Dashboard; pass `--effort low` to `guide-gen` or `ai-check`; or change this value to move the default.

Measured over one identical game (16 achievements, same prompt, back to back), which is the comparison worth quoting because absolute timings on this path vary by up to 8× run to run:

| `effort` | wall time | searches | entries written from a template |
|---|---|---|---|
| `high` (default) | 280 s | 5 | **0 of 16** |
| `medium` | 262 s | 4 | **0 of 16** |
| `low` | **35 s** | 2 | **9 of 16** |

**What a lower setting costs is breadth, not depth.** At `low` the hardest achievements are still written properly — it is the large middle of the list that degrades, into lines like "clear every fate in Chapter III to unlock", which could have been written without looking anything up. Total guide length barely moves, so length is not a way to tell whether you lost something; the number of searches actually issued is printed after every run, in the terminal and on the Dashboard, and that is.

`high` and `medium` were not distinguishable here — the gap between them is inside the run-to-run noise. The real step is between `medium` and `low`.

The default is `high` because a guide is meant to be a lasting record of how a game is played, and nine content-free entries is over half of one. `low` is worth choosing when you only want the hard parts solved and want them now.

`off` stops the field being sent at all — use it if an endpoint rejects it, which the error message will tell you.

`thinking` is a separate switch and is normally left alone. `"disabled"` makes a pass finish in seconds and **also stops the model searching the web at all**, so it writes from memory — the exact failure this tool otherwise refuses to allow. Use `effort` to go faster, not this.

Neither setting is sent to endpoints that haven't been tested with it, since acceptance varies by endpoint and an untested one is left exactly as it was. Set `"anthropicExtras": true` to force them on for a custom endpoint you know accepts them.

`allowedDomains` defaults to empty, meaning no restriction. Filling it in **hard-restricts** search to those domains — the API offers no way to merely prefer one. It's tempting to lock search onto Chinese guide sites (3DM, 游民星空, NGA, B站), but how well those are actually indexed hasn't been measured yet, so the default doesn't trade measured quality for an unmeasured assumption.

`fallbacks` lets Anthropic re-run a request on a different model when a safety classifier declines it. It costs one extra beta header, and if your account doesn't accept that header the whole request fails with a 400 — the error message says to set `"fallbacks": false`, which is the fix.

Token usage is reported after every run — requests, input, output, and how many web searches the model actually issued. **No dollar figure.**

**You don't normally write this block by hand — `node tracker.js init --ai` does it**, and verifies the key with a real request before saving.

### There are no spend caps, and that's deliberate

An earlier version had four: `maxTokensPerRun`, `maxSpendPerRunUsd`, `maxTokensPerDay`, `maxSpendPerDayUsd`, backed by a built-in price table and a `ai_usage` ledger. All of it is gone.

The dollar half never worked honestly. Rates change, there was no verified table for DeepSeek or Gemini — the two providers you're most likely to use — and **how server-side web search is billed was never measured at all**. So a "$5 cap" was a number computed from an amount nobody could stand behind. A cap you can't trust is worse than no cap: it reads as protection while protecting nothing.

The token half worked, but it asked you to pick a number you had no basis for choosing, in a unit that doesn't map to anything you care about.

What actually bounds a run is still there and measures real things: `maxSearches`, `maxFetches`, `maxTokens` and `maxRounds`. And `guide-gen` asks before it starts.

For what you actually spent, read your provider's own dashboard. The token counts printed after each run are the API's own figures, so they're what you'd reconcile against a bill.

**Choosing a provider.** `deepseek`, `anthropic` and `gemini` all do server-side web search, which is what the research step needs. Pricing, rate limits and free allowances are the vendors' to state and change, so they aren't reproduced here — `ai-check --models` asks your key which models it can use, and `ai-check` confirms search works before you spend a run. (`deepseek-openai` is the same vendor's OpenAI-compatible endpoint, which has **no** search — it exists for the no-research path and for future OpenAI-shaped providers, and `guide-gen` refuses to use it without an explicit `--no-research`.)

**Leave `ai.model` blank unless you want to pin a version.** Model names are not portable between providers, so there is no sensible cross-provider default — each provider supplies its own. Filling in one vendor's name is exactly how you end up with "供应商是 deepseek，模型名却是 anthropic 的". If you want to know what your key can actually use, ask the API rather than guessing:

```bash
node tracker.js ai-check --models
```

**On Gemini's free tier, pick a `flash` model.** The Pro models return `limit: 0` for the free-tier quota — that is not "you used it up", it means the model isn't in that tier at all, and waiting for a reset will never help. The error message says so and doesn't retry. The default (`gemini-flash-latest`) is an alias rather than a version number, because a pinned version goes stale — that exact default was wrong within three months. Pin a concrete version if you want reproducible output.

**`geminiTools`** declares which server-side tools to hand Gemini; it's configurable rather than hard-coded because that provider was written without access to the API docs, so a renamed tool — or one your tier doesn't grant — is a config edit, not a code change. `google_search` alone is the default; adding `url_context` gets full page text rather than search results, at the risk of the whole request failing if your tier doesn't offer it. After any run, `ai-check` reports the search queries the model actually issued — declaring the tools and getting zero searches back is the real answer to "does my tier include grounding", and it's more reliable than any pricing page.

Note that free tiers generally mean **your prompts may be used to improve the vendor's models**. For this project that would be your game library and achievement names. If that matters to you, use a paid tier.

## Environment variables

These override the file, which is useful for one-off runs or if you'd rather not keep credentials on disk:

| Variable | Overrides |
|---|---|
| `STEAM_API_KEY` | `steamApiKey` |
| `STEAM_ID` | `steamId` |
| `NOTION_TOKEN` | `notion.token` |
| `AI_PROVIDER` | `ai.provider` |
| `AI_MODEL` | `ai.model` |
| `ANTHROPIC_API_KEY` | the key used when the active provider is `anthropic` |
| `GEMINI_API_KEY` | the key used when the active provider is `gemini` (or `google`) |
| `DEEPSEEK_API_KEY` | the key used when the active provider is `deepseek` (either endpoint) |
| `PORT` | `port` |

```bash
STEAM_API_KEY=xxx STEAM_ID=yyy node tracker.js sync
```

`AI_PROVIDER` is read **before** the key, which is what makes it possible to try a provider without editing `config.json` at all — otherwise the key lookup would still be going after the old provider's variable:

```bash
AI_PROVIDER=gemini GEMINI_API_KEY=xxx node tracker.js ai-check --models
```

**`TRACKER_DATA_DIR`** works differently from the four above: it doesn't override a value inside `config.json`, it changes *where* `config.json`, `data/` and `guidesDir` are read from and written to. Without it, all three sit next to the code, which is what the sections above assume.

It exists for the packaged Windows app ([launcher/README.md](../launcher/README.md)), which is a second copy of the code in its own folder and would otherwise keep its own separate database. Pointing it at an existing checkout makes both the app and the CLI read and write the same files:

```bash
TRACKER_DATA_DIR=/path/to/steam-achievement-tracker node tracker.js status
```

Code assets (`Dashboard.html`, `Setup.html`, `lib/rpc.js`) are never affected — they always load from wherever the running code is, so the variable cannot make one copy of the code serve another copy's pages. A path that doesn't exist is ignored by the launcher rather than used. Don't run the CLI and the packaged app against the same directory at the same time; the two will both write to one SQLite file.

The launcher reads that path from its own `local.config.json`, which is **not** part of `config.json` and is documented with the launcher rather than here — it holds `dataDir` (the value above) and `autoUpdate` (set `false` to stop the app checking for new versions). See [launcher/README.md](../launcher/README.md).

## Changing the port

Either set `port` in `config.json`, or pass it per-run:

```bash
node tracker.js serve --port 9000
```

The server only ever listens on `127.0.0.1`, so the Dashboard is reachable from your machine and nowhere else. That's also why there's no login on it.

## Scheduling

There is no built-in scheduler. Two ways to get regular updates:

- **Do nothing** — starting `serve` syncs in the background when data is stale (see `syncStaleHours` above), ticks the guide checkboxes for whatever that sync turned up (see `checkboxSyncOnServe`), and the Dashboard's **立即同步** button covers the rest. Leaving `serve` running for days does *not* keep syncing: the staleness check only runs at startup.
- **A real daily job** — on macOS, a launchd plist running `node tracker.js sync`. Note it only fires while the machine is awake; launchd will run a missed job on wake, but a machine that's off for a week syncs nothing.
