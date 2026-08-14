# Launcher

Electron shell around the existing CLI/server — for people who shouldn't need a terminal or Node installed. This directory is intentionally isolated from the root project: Electron and electron-builder live here as devDependencies so the core tracker stays at zero runtime dependencies.

## Layout

```
steam-achievement-tracker/
├── tracker.js, Dashboard.html, Setup.html, lib/   ← the tracker. Edit freely; packaging never needs to change
├── launcher/                                      ← this directory: the Electron wrap only
│   ├── main.js            spawn + window lifecycle + the update prompt
│   ├── updater.js         everything about updating except touching the disk (no Electron import)
│   ├── postbuild.js       rename output, write the manifest, copy local config, make the root shortcut
│   └── local.config.json  gitignored, this machine only
├── dist/                                          ← build output (gitignored)
│   ├── SteamAchievementTracker/       the app folder
│   ├── SteamAchievementTracker-<version>-win.zip        what you send people
│   └── SteamAchievementTracker-<version>-manifest.json  ships beside the zip; see "Self-update"
└── SteamAchievementTracker.lnk                    ← gitignored shortcut; double-click this
```

**The wrap never enumerates core files.** `extraResources` in `package.json` is a single rule with an *allow-list* filter (`tracker.js`, `package.json`, `*.html`, `lib/**/*`), so adding a Dashboard page or a `lib/` module is picked up automatically with no packaging edit. The allow-list is also the safety mechanism: `config.json` and `data/` can never be packaged, because they aren't on it — verify with `unzip -l dist/*.zip | grep config` after any change to that filter.

## How it works

`main.js` spawns `../tracker.js serve` as a child process, using Electron's own bundled Node (`ELECTRON_RUN_AS_NODE=1`) as the interpreter — confirmed this bundles a recent-enough Node with a working `node:sqlite`, so no separate Node runtime needs to be vendored. Once the child responds on `127.0.0.1:8777`, a `BrowserWindow` opens pointed at it. That's the entire app — no business logic lives here, only spawn/health-check/window-lifecycle glue.

First run with no `config.json` present: the server itself redirects `/` to `/setup` (see `lib/server.js`), which serves `Setup.html` — a plain form for the Steam API key + SteamID64, plus an optional CSV folder path (the GUI equivalent of `node tracker.js import`, for anyone migrating from a spreadsheet). `completeSetup` in `lib/api.js` validates Steam credentials, runs the import if a path was given, and only then writes anything — a bad import path fails the whole submission rather than saving half-finished state, since ♥/★/family/Manual fields can't be recovered from Steam once a sync has run. On success it patches the running process's in-memory `config`/`steam` state directly, so the same server process is immediately usable — no restart needed. `main.js` just polls `getSetupStatus` while parked on `/setup` and reloads the window once it flips true.

## Closing the window doesn't quit

The window hides into a tray icon; the process keeps running so syncing and guide generation survive a closed window. **The only real exit is the tray menu's 退出.**

Three details are load-bearing, and each of them fails silently rather than loudly:

- **`window-all-closed` is deliberately an empty handler.** With no listener at all Electron quits — which is precisely the old behaviour — so deleting the empty function reverts the feature while looking like a cleanup.
- **The `close` handler must let `app.isQuitting` through.** During a real quit the event fires again; swallowing that one with `preventDefault` makes the app impossible to exit by any route.
- **`before-quit` sets `isQuitting` *before* killing the child.** The child's `exit` listener reads that flag to tell a deliberate shutdown from a crash. Reversed, every normal quit first pops a 「后台服务意外退出」 error box. `before-quit` is also where cleanup lives now, because it is the one junction every exit path goes through.

`test/tray.test.js` pins all three as source assertions — this file needs Electron, so it cannot be imported by a test.

**The tray icon is a prerequisite, not decoration.** `new Tray()` with an unreadable path produces an *invisible* icon, and an invisible icon plus "closing doesn't quit" is a program the user can neither see nor exit except via Task Manager. The load is therefore checked with `isEmpty()` and reported. `icon.ico` comes from `make-icon.mjs` (`node:zlib`, no dependency) rather than being committed as an opaque binary, so it survives a palette change; it must appear in **both** `build.files` and `build.asarUnpack`, since missing the latter breaks only the packaged build while `npm start` stays perfect.

**This changes the upgrade instruction.** "Close the app before unzipping over it" now means *quit from the tray* — closing the window leaves the exe running and Windows will refuse to replace it. Say that explicitly in release notes rather than the older "close the app".

**Auto-sync had to move.** `maybeAutoSync` runs once per server start (`startupJobs`), so while every launch was a fresh process, opening the app *was* the staleness check. A process that lives in the tray for days removes that trigger and nothing errors — the Dashboard simply stops updating. The trigger now hangs off the window's `show` event via `api.maybeSync`. That method exists instead of reusing `startSync` because `startSync` intentionally ignores `syncStaleHours` (a button press has already decided), which as a window-raise hook would mean a full sync every time you look at the app.

## Self-update

The app checks GitHub Releases 10 seconds after launch and then once a day, offers the new version in a native dialog, and on acceptance downloads, verifies, quits, replaces itself and restarts. The full rationale — including why `electron-updater` is unusable here and why NSIS is not an option — is in [docs/self-update.md](../docs/self-update.md). **Read that before changing any of this.** What follows is what the code does.

```
每天一次 → GitHub API 比版本
  ↓ 有新版
网页提示(不是原生对话框):立即更新 / 以后再说 □ 不再提示这个版本
  ↓ 立即更新
下载 zip + 清单到 temp → 用 API 给的 sha256 校验
  ↓ 通过
写 apply-update.ps1 → cmd /c start 拉起 → **等它报到** → app.quit()
  ↓ helper 接管
等 PID 退出 → 按旧清单删 → Expand-Archive → 写新清单 → 重启 exe
```

Still zero runtime dependencies: `Expand-Archive` ships with PowerShell, and `postbuild.js` already borrowed `WScript.Shell` for the shortcut.

Three things on that diagram look like incidental detail and are not. Each was found by a real rehearsal, and each failed **silently** — the app looked fine and simply did nothing.

**The prompt is a web page, not `dialog.showMessageBox`.** Native dialogs do not survive in this app: the call returns instantly with `response: 420`, a value outside the button range, which reads as "user declined". Ten variants were measured (bare `{message}`, `showMessageBoxSync`, with and without a parent window, …) — all 420, while a plain Win32 `MessageBox` on the same machine stayed up indefinitely. This is the **second** time this project has been bitten by it; the first was `window.confirm` in `Dashboard.html`, which left 「生成攻略」 dead in the packaged build. The conclusion recorded back then — "native dialogs belong to the main process" — was too narrow: the main process is no better. The boundary is native-vs-page. The prompt returns its result through `document.title`, so the window needs no preload and no privileges.

**`detached: true` does not make the helper outlive the app.** Measured in a real session, four strategies each launching a dummy helper and then quitting immediately:

| 启动方式 | 活过 `app.quit()` |
|---|---|
| `detached: true` + `unref()` | **否** |
| 普通 `spawn` + `unref()` | **否** |
| `cmd /c start` | 是 |
| WMI `Win32_Process.Create` | 是 |

That is a **Job Object**: Electron puts its children in one with kill-on-close, and Windows' `DETACHED_PROCESS` — what Node's `detached` maps to — governs the console, not job membership, so it cannot escape. Only strategies that don't create the process as our child work. The primary is `cmd /c start`; WMI is kept as a fallback because *a broken updater is already on the user's machine and the fix has to travel through it*, so if the primary ever fails somewhere it fails **there, permanently**. The primary uses `-File` rather than `-EncodedCommand` because cmd's command line caps at 8191 characters and the encoded script is ~10 700.

**The app confirms the handoff before it quits.** The helper's first statement writes an alive-marker; the app polls for it, tries the fallback launcher if it doesn't appear, and only then quits — otherwise it reports the failure and **keeps running**. Without this the `detached` bug was catastrophic instead of merely annoying: the app closed itself and never came back, while its own log read 「helper 已启动」, because `spawn()` returning says nothing about whether the process started (launch failure arrives as an async `error` event, which had no listener). Keep both halves: the marker *and* the refusal to quit without it.

**The manifest is the whole safety mechanism.** It lists what the *installed* build put on disk, and the helper deletes exactly those paths — never a keep-list of what to spare. The two get the failure direction backwards from each other: a wrong manifest leaves a junk file behind, a wrong keep-list deletes `resources/tracker/data/steam.db`. Three properties keep it honest, and each is pinned in `test/selfupdate.test.js`:

- **Deletion runs before extraction.** That is what makes over-deleting program files self-repairing — the zip puts them back. It is also why a stale manifest is merely untidy rather than dangerous.
- **Only files are deleted, and only directories that are already empty.** `resources/tracker/data/` holds the database, so it is never empty, so it is never removed. Nothing is matched by name.
- **The manifest never contains user data**, because it is generated from the unpacked build, and `config.json`/`data/` were never in the build (the `extraResources` allow-list is what guarantees that). Safety here is constructed, not filtered.

**The manifest is a separate release asset, not a file inside the zip.** It has to be, and this is not a stylistic choice: electron-builder seals the zip before `postbuild.js` runs, and a manifest describing a zip that contains itself is circular. So it ships beside the zip and the helper writes it into the app folder after extracting. That gives the fallback for free — a fresh unzip has no manifest, so the first update after it is a plain overwrite, which is exactly the required behaviour for anyone coming from ≤1.1.3. **Never try to infer which files are program files when the manifest is missing.** Those users get one last dirty overwrite and are clean forever after; that cost is deliberately accepted.

**`postbuild.js` must generate the manifest before it copies `local.config.json`.** Reversed, that file lands in the manifest and the next update deletes it — the user's data directory silently reverts to the default and it reads as "all my data is gone". The ordering is guarded by an explicit check that fails the build, because ordering alone is the kind of thing a later edit undoes without noticing.

**Integrity is not optional.** GitHub returns a `sha256:…` digest on every asset, and both downloads are verified against it. If a digest is missing or unparseable the update is *refused* rather than installed unverified — silently skipping the check would mean executing 133 MB of unverified code, and nothing about the resulting install would look wrong.

**Failure directions, deliberately different:** the *check* is silent (offline is the normal case, and an error box every morning trains you to dismiss it), while a *download or verification failure after the user clicked 立即更新* says so out loud — they are standing there waiting for it. If the helper itself fails, only program files are damaged (no user data is in the zip), so the message points at a manual re-download and the log in `%TEMP%\steam-tracker-update\apply-update.log`.

**Turning it off:** `"autoUpdate": false` in `local.config.json` (same file, same three lookup locations as `dataDir`). Per-version dismissal is the checkbox in the dialog, remembered in `update-state.json` next to the exe.

### Rehearsing it

The replace step cannot be unit-tested — it needs a real release and a real packaged build. Point it at an older release and let it "downgrade":

```powershell
$env:TRACKER_UPDATE_FORCE_TAG = 'v1.1.2'
& .\dist\SteamAchievementTracker\SteamAchievementTracker.exe
```

A forced tag skips the is-it-newer check, so the whole path runs without cutting a release. **Set the rehearsal up from the zip, never by copying `dist/SteamAchievementTracker/`** — `postbuild.js` drops your `local.config.json` into that folder, which points at your real CLI data directory, and the rehearsal would then operate on your actual database. Plant fake `config.json` / `data/steam.db` / a guide inside `resources/tracker/`, plus a file the target version doesn't have, and write an `update-manifest.json` listing the zip's contents plus that extra file. Then check afterwards that the extra file is gone and the planted data is byte-identical.

Done once on 2026-08-14 (1.1.4 → v1.1.2): 101 files deleted by manifest, extract, restart, and every planted user file intact. Compare against the two logs in `%TEMP%\steam-tracker-update\` — `updater.log` is the app's half, `apply-update.log` is the helper's. **Which of the two is missing tells you which half failed**, which is the whole reason both exist.

Deleting by manifest is exercised by this rehearsal, because deletion reads the manifest **already on disk**. What it does *not* reach is the branch where the incoming release ships a manifest and the helper installs it — v1.1.2 has none, so the run takes the "clear the stale manifest" path instead. Covering that needs two releases that both carry one.

## Dev mode

```
npm install
npm start
```

Runs against the parent project's files directly (`../tracker.js`, `../lib`, etc.) — edit-and-rerun like the CLI itself.

## Building a distributable

```
npm run build
```

Output goes to the **repo root** `dist/`, not inside `launcher/` — the built app is what you actually open, so it shouldn't be buried under the wrapper's source. `postbuild.js` then renames electron-builder's `win-unpacked` to the product name and drops a `SteamAchievementTracker.lnk` at the repo root, so launching is one double-click from the top level.

`zip` is the target deliberately, **not** electron-builder's `portable` target — the NSIS `portable` target self-extracts to a temp directory on every launch, which would silently lose `config.json` and the SQLite database between runs. The `zip` target ships a real, stable folder: unzip once anywhere and the data persists across runs, exactly like running the CLI from a normal checkout.

**Where it actually persists is `resources/tracker/`, *not* beside the exe** — this said "next to the exe" for a while and that was simply wrong. `DATA_ROOT` defaults to `ROOT` (`lib/config.js`), and in a packaged build `ROOT` is the folder the tracker's code was copied into, so a distributed build with no `local.config.json` writes `resources/tracker/config.json` and `resources/tracker/data/steam.db`. Verified by importing the *packaged* `lib/config.js` and printing `CONFIG_PATH`, which is the only way to settle it — reading the source alone is what produced the wrong claim.

The consequence is load-bearing and is what shapes the updater below: **user data is interleaved with program files.** Overwriting a build in place is safe only because extraction never deletes — `config.json`/`data/`/`guides/` aren't in the zip, so they survive. Anything that "cleans" the app folder before extracting would delete the user's database. Delete by a shipped manifest of what the previous build installed, never by a keep-list of what to spare: a wrong manifest leaves a junk file, a wrong keep-list destroys data.

To hand this to someone: send them `dist/SteamAchievementTracker-<version>-win.zip`. They unzip it somewhere permanent (not a temp/Downloads folder they'll clear out) and run the `.exe` inside. First launch shows the setup form; after that it opens straight to the Dashboard. The zip is built *before* `postbuild.js` runs, so it never contains your `local.config.json` — verified, but worth re-checking if you change the build order.

**Filenames are ASCII on purpose.** `productName` is `SteamAchievementTracker`, while the window title and every UI string stay Chinese (`main.js`, `Dashboard.html`, `Setup.html`). Chinese *filenames* get converted through the ANSI codepage by a surprising number of tools: `WScript.Shell` can't create or target them (which is what broke the root shortcut), `taskkill` reports the process as `Steam ?????.exe`, and running the exe by path from a shell needs careful quoting. None of that affects what the user sees. Don't "restore" the Chinese product name without re-testing the shortcut.

## Cutting a release

Releases exist so the people using the app can find updates by URL instead of waiting to be sent a file. The repo is public, so **a release is downloadable by anyone**, not only the people you meant to give it to — that's a known and accepted trade, not an oversight.

**The release version is `launcher/package.json`'s**, and every other version number in the repo must equal it. It names the zip **and the manifest**, `app.getVersion()` reads it, and the tag must match it — bump it, and tag exactly that.

**There used to be two counters** (tracker 2.x in the root `package.json`, app 1.x here), on the reasoning that the tracker reached 2.0.0 long before any of this was packaged and the app started its own count at the first downloadable build. **Merged into one on 2026-08-14.** Every release from the first one on moved them in lockstep — 2.0.0/1.0.0, 2.1.0/1.1.0, … 2.1.3/1.1.3 — so across five releases the two numbers never differed by anything except the leading digit, and the second counter never once carried information. It did cost something: the root value is what `extraResources` copies to `resources/tracker/package.json`, which is the only place a user can read which code is actually on their disk, so a bug report had to be diagnosed against a number that looked like an independent fact and wasn't. The root version was moved *down* onto the app's counter rather than the reverse, so the release-tag line (`v1.0.0` … `v1.1.3`) stays continuous; nothing reads the root value at runtime, so there is no downgrade to worry about. `test/version.test.js` pins all four fields equal, and that test is the whole guardrail — a wrong version number does not error, it misdirects.

```bash
# 1. bump version in launcher/package.json, then match it in the root package.json
cd launcher && npm install --package-lock-only   # sync the lockfile (it carries the number twice)
( cd .. && node --test test/version.test.js )    # all four must agree — check before building
npm run build

# 2. verify the artifact before it goes anywhere public
unzip -l ../dist/SteamAchievementTracker-<version>-win.zip | grep -i local.config   # must find nothing
unzip -l ../dist/SteamAchievementTracker-<version>-win.zip | grep -iE "config.json|steam.db"  # must find nothing
grep -i local.config ../dist/SteamAchievementTracker-<version>-manifest.json       # must find nothing

# 3. tag the exact commit the artifact was built from, then publish
#    BOTH files — the manifest is what the *next* update deletes by
cd .. && git tag -a v<version> -m "..." && git push origin v<version>
gh release create v<version> \
  "dist/SteamAchievementTracker-<version>-win.zip" \
  "dist/SteamAchievementTracker-<version>-manifest.json" \
  --notes-file <notes>
```

**Upload the manifest every time.** Forgetting it is not loud: that release installs fine, and the damage shows up one release later as an update that leaves stale files behind. The updater treats a missing manifest as "fall back to overwrite" precisely so a slip here degrades instead of breaking, but the degradation is silent.

### Publish as a prerelease first, then flip — and flip *both* switches

`/releases/latest` **skips prereleases** (measured, not assumed: an empty prerelease was published and `latest` still returned the older tag). That is what makes it safe to rehearse a real release on this public repo without any existing user being offered it.

```bash
# publish for rehearsal — invisible to /releases/latest, so no user sees it
gh release create v<version> --prerelease --notes-file <notes> \
  "dist/SteamAchievementTracker-<version>-win.zip" \
  "dist/SteamAchievementTracker-<version>-manifest.json"

# …rehearse against it (see "Rehearsing it" above)…

# then go live — BOTH of these, see below
gh release edit v<version> --prerelease=false
gh release edit v<version> --latest
```

**`--prerelease=false` alone is not enough, and the failure is silent.** GitHub decides `/releases/latest` from a separate `make_latest` flag, not from the prerelease bit; a release created as a prerelease has it off, and clearing `prerelease` does not turn it on. The release page then looks completely normal — not marked prerelease, both assets attached — while `/releases/latest`, *which is the only endpoint the updater reads*, still points at the previous version. Nobody is ever offered the update and nothing errors. Hit for real on v1.1.4. **Always verify by asking the endpoint the app actually asks:**

```bash
gh api repos/<owner>/<repo>/releases/latest --jq .tag_name
```

Note it can lag: the app calls `api.github.com` **unauthenticated**, and that path is CDN-cached for about a minute, so an immediate check can still show the old tag while an authenticated `gh` call already shows the new one. Wait a minute and re-check before concluding something is wrong.

Build from a clean, committed tree so the tag actually corresponds to the binary — `dist/` is gitignored, so nothing else ties them together.

Release notes must cover, at minimum: the **SmartScreen warning** (unsigned build — "更多信息 → 仍要运行"), that the app needs no Node install, that a **manual** upgrade means **quitting from the tray** first (closing the window leaves the exe running, and Windows won't let it be replaced), and that the **CSV import only appears on the first-run form** — a user who clicks past it has to fall back to the CLI, and after the first sync the ♥/★/family/Manual columns can't be recovered at all.

From 1.1.4 on the app updates itself, so the manual instruction is a fallback rather than the main path — but it still has to be there: everyone on ≤1.1.3 has to make that one hop by hand, since those builds have no updater in them at all.

## Personal use: pointing the launcher at an existing CLI checkout

If you already have a `data/`/`config.json` from running the CLI directly and don't want the launcher keeping a second, separate copy, create `launcher/local.config.json`:

```json
{ "dataDir": "D:/GitHub/steam-achievement-tracker" }
```

It's gitignored, and `npm run build` copies it next to the built exe automatically (`postbuild.js`) — `dist/` is wiped on every rebuild, so the source of truth deliberately lives in `launcher/` where builds can't touch it.

At startup `main.js` looks for `local.config.json` in three places, first hit wins:

1. **next to the exe** — where the build copies it; this is the one that actually gets used
2. `app.getPath('userData')` (`%APPDATA%\steam-achievement-tracker-launcher\`) — survives deleting and re-extracting the whole app folder
3. `launcher/` itself — dev mode (`npm start`)

Whichever matches is passed to the child process as `TRACKER_DATA_DIR`. `lib/config.js` honors that env var for `config.json`/`data/`/`guidesDir` **only** — never for code assets (`Dashboard.html`, `Setup.html`, `lib/rpc.js`), which always load from wherever the running code physically is. A `dataDir` pointing at a folder that doesn't exist is ignored rather than used, so copying the app folder to another machine degrades to normal beside-the-exe storage instead of failing to start.

**Why exe-adjacent is first, not `userData`:** `userData` lives under the user profile, which sandboxed or virtualized processes can silently redirect — the same absolute path resolving to different content depending on which process asks. That cost a long debugging session here: a file created by one tool was invisible to the real desktop session while every check insisted it existed. The exe-adjacent copy travels with the app and has exactly one interpretation.

None of this exists on a friend's machine — no file in any of the three locations, so `TRACKER_DATA_DIR` never gets set and `DATA_ROOT` falls back to `ROOT`, i.e. `resources/tracker/`, same as if the feature weren't there. (This paragraph also used to say "beside their exe". It isn't — see the note under "Why `zip`" above, and mind it before writing anything that deletes files in the app folder.)

## Known scope limitations (deliberate, not oversights)

- **Windows only.** No macOS/Linux build target configured.
- **Turning Notion sync back off** needs `config.json` — the settings page treats an empty Integration Secret as "keep the current one", the same rule the Steam API Key follows, so that changing a SteamID can't silently wipe a token. Everything else about Notion is configurable in the app.
- **Port 8777 is hardcoded**, matching the project's default. If that port is already taken on someone's machine, the launcher will fail to start rather than pick another port.
- **No code signing.** Windows SmartScreen will show an "Unknown Publisher" warning on first run — expected, not a bug. Warn recipients in advance.
- **Updating from ≤1.1.3 leaves stale files once.** Those builds shipped no manifest, so the first self-update off them is a plain overwrite — anything a later version deleted stays on disk until the *next* update, which has a manifest to work from. Deliberate: see "Self-update" above, and never replace it with a guess about which files are program files.
- **Self-update is Windows-only and PowerShell-based**, like the rest of the packaging. `Expand-Archive` and `Wait-Process` are the whole runtime.
