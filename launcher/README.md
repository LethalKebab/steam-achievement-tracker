# Launcher

Electron shell around the existing CLI/server — for people who shouldn't need a terminal or Node installed. This directory is intentionally isolated from the root project: Electron and electron-builder live here as devDependencies so the core tracker stays at zero runtime dependencies.

## Layout

```
steam-achievement-tracker/
├── tracker.js, Dashboard.html, Setup.html, lib/   ← the tracker. Edit freely; packaging never needs to change
├── launcher/                                      ← this directory: the Electron wrap only
│   ├── main.js            spawn + window lifecycle
│   ├── postbuild.js       rename output, copy local config, make the root shortcut
│   └── local.config.json  gitignored, this machine only
├── dist/                                          ← build output (gitignored)
│   ├── SteamAchievementTracker/       the app folder
│   └── SteamAchievementTracker-<version>-win.zip   what you send people
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

The consequence is load-bearing and belongs next to any future updater: **user data is interleaved with program files.** Overwriting a build in place is safe only because extraction never deletes — `config.json`/`data/`/`guides/` aren't in the zip, so they survive. Anything that "cleans" the app folder before extracting would delete the user's database. Delete by a shipped manifest of what the previous build installed, never by a keep-list of what to spare: a wrong manifest leaves a junk file, a wrong keep-list destroys data.

To hand this to someone: send them `dist/SteamAchievementTracker-<version>-win.zip`. They unzip it somewhere permanent (not a temp/Downloads folder they'll clear out) and run the `.exe` inside. First launch shows the setup form; after that it opens straight to the Dashboard. The zip is built *before* `postbuild.js` runs, so it never contains your `local.config.json` — verified, but worth re-checking if you change the build order.

**Filenames are ASCII on purpose.** `productName` is `SteamAchievementTracker`, while the window title and every UI string stay Chinese (`main.js`, `Dashboard.html`, `Setup.html`). Chinese *filenames* get converted through the ANSI codepage by a surprising number of tools: `WScript.Shell` can't create or target them (which is what broke the root shortcut), `taskkill` reports the process as `Steam ?????.exe`, and running the exe by path from a shell needs careful quoting. None of that affects what the user sees. Don't "restore" the Chinese product name without re-testing the shortcut.

## Cutting a release

Releases exist so the people using the app can find updates by URL instead of waiting to be sent a file. The repo is public, so **a release is downloadable by anyone**, not only the people you meant to give it to — that's a known and accepted trade, not an oversight.

**The release version is `launcher/package.json`'s**, and every other version number in the repo must equal it. It names the zip, `app.getVersion()` reads it, and the tag must match it — bump it, and tag exactly that.

**There used to be two counters** (tracker 2.x in the root `package.json`, app 1.x here), on the reasoning that the tracker reached 2.0.0 long before any of this was packaged and the app started its own count at the first downloadable build. **Merged into one on 2026-08-14.** Every release from the first one on moved them in lockstep — 2.0.0/1.0.0, 2.1.0/1.1.0, … 2.1.3/1.1.3 — so across five releases the two numbers never differed by anything except the leading digit, and the second counter never once carried information. It did cost something: the root value is what `extraResources` copies to `resources/tracker/package.json`, which is the only place a user can read which code is actually on their disk, so a bug report had to be diagnosed against a number that looked like an independent fact and wasn't. The root version was moved *down* onto the app's counter rather than the reverse, so the release-tag line (`v1.0.0` … `v1.1.3`) stays continuous; nothing reads the root value at runtime, so there is no downgrade to worry about. `test/version.test.js` pins all four fields equal, and that test is the whole guardrail — a wrong version number does not error, it misdirects.

```bash
# 1. bump version in launcher/package.json, then match it in the root package.json
cd launcher && npm install --package-lock-only   # sync the lockfile (it carries the number twice)
( cd .. && node --test test/version.test.js )    # all four must agree — check before building
npm run build

# 2. verify the artifact before it goes anywhere public
unzip -l ../dist/SteamAchievementTracker-<version>-win.zip | grep -i local.config   # must find nothing
unzip -l ../dist/SteamAchievementTracker-<version>-win.zip | grep -iE "config.json|steam.db"  # must find nothing

# 3. tag the exact commit the artifact was built from, then publish
cd .. && git tag -a v<version> -m "..." && git push origin v<version>
gh release create v<version> "dist/SteamAchievementTracker-<version>-win.zip" --notes-file <notes>
```

Build from a clean, committed tree so the tag actually corresponds to the binary — `dist/` is gitignored, so nothing else ties them together.

Release notes must cover, at minimum: the **SmartScreen warning** (unsigned build — "更多信息 → 仍要运行"), that the app needs no Node install, that upgrading means **quitting from the tray** first (closing the window leaves the exe running, and Windows won't let it be replaced), and that the **CSV import only appears on the first-run form** — a user who clicks past it has to fall back to the CLI, and after the first sync the ♥/★/family/Manual columns can't be recovered at all.

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
- **No auto-update.** Cutting an actual release is a separate, later step — this only covers building the artifact locally.
