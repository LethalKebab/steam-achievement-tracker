# Self-update (design and handover)

> How the code is written is in `launcher/README.md`'s Self-update section; **why it can only be written that way** is here.
> The implementation is `launcher/updater.js`, `launcher/main.js` and `launcher/postbuild.js`; the tests are `test/selfupdate.test.js`.

**Read this in order**: the verified facts first — those cost real effort to establish, do not re-derive them; then the three constraints that must not be violated, which are the safety boundary; the design only after that.

---

## 1. What this solves

The friction was never "not knowing there is a new version", it is that **re-downloading is tedious** (download → quit → unzip over the top, three steps). So a notification alone is not enough; it has to be one click.

But the real driver is something else, and it matters far more than convenience:

> **An overwrite-style update never deletes anything.** The day a version drops a file, that file stays on the user's machine forever. An Electron version bump swaps out a large batch of DLLs and locales, and old and new end up mixed together. Eventually every user's folder is **the union of every version they ever installed** — nobody can reproduce their state, and **"a clean unzip runs" stops meaning "it runs on their machine"**.

This is no longer hypothetical. See "the file set has already changed once" below.

---

## 2. Verified facts (do not re-derive)

| Fact | How it was verified | Consequence |
|---|---|---|
| **`electron-updater` on Windows has only `NsisUpdater`** | Listed `electron-userland/electron-builder`'s `packages/electron-updater/src`; the platform implementations are `NsisUpdater` / `MacUpdater` / a few Linux ones. Zip updating exists only on macOS | Using the off-the-shelf solution = abandoning the `zip` target for NSIS |
| **The GitHub Releases API carries a sha256 per asset** | Hit the real API: `assets[].digest` = `sha256:6f4fa98e…` | A hand-rolled updater gets integrity verification for free, with no extra infrastructure |
| **User data lives in `resources/tracker/`, on the same level as program files** | Imported **the packaged copy** of `lib/config.js` and printed `CONFIG_PATH` | See constraint 1 below — this is the single most important fact here |
| **The zip contains no user data at all** | `unzip -l` for `config.json` / `steam.db` / `local.config` returns 0 for each | The manifest cannot contain user data; the safety is constructed, not filtered |
| **`launcher/` has zero runtime dependencies** | Read `package.json` — devDependencies only | Installing `electron-updater` would be the first one |
| **`app.getVersion()` is exactly the tag minus the `v`** | `launcher/package.json`'s version is where the tag comes from | Version comparison is direct; no extra metadata needed |
| **The file set has already changed once** | The v1.1.3 release had 102 entries; adding the tray icon made it 104 | "Four releases, the same 102 entries" is no longer a property that holds |
| **`extraResources`' `lib/**/*` will package *any* file under `lib/`** | Two `.mutbak` files left behind by a mutation script once made it into the zip | Junk files entering the package raise no error whatsoever |

### Why not switch to NSIS

It collides head-on with **two decisions this project has already paid for**:

1. `launcher/README.md` states explicitly that no NSIS-family target is used, because self-extracting to a temp directory loses `config.json` and the database between runs.
2. Data lives in the program directory rather than `userData` deliberately, because `userData` gets silently redirected inside sandboxed/virtualised processes — the same absolute path points at different content for different processes. The README notes this "costs a long debugging session".

Switching to NSIS means moving the data into a managed directory, walking straight back into that hole, and owing every existing user a data migration on top.

---

## 3. Three constraints that must not be violated

### 1. Never delete by a keep-list

User data and program files sit on the same level, so "empty the folder, then extract" deletes the database.

**The two designs fail in opposite directions, and that is the entire argument for the manifest:**

| Approach | What happens when it's wrong |
|---|---|
| Keep-list: "delete everything except these" | **Destroys the user's database.** And `dbPath` / `guidesDir` are configurable, so the list can never be complete |
| Manifest: "delete only the files the previous build installed" | **Leaves one junk file behind** — i.e. exactly today's status quo |

Same root as this project's existing bias: *prefer a missed checkbox over a wrong one.*

### 2. A missing manifest falls back to overwrite — never guess

Users coming from ≤1.1.3 have no manifest. **In that case it must fall back to today's overwrite behaviour and write the manifest afterwards**, never attempt to infer which files are program files. Existing users get one last dirty overwrite and are clean forever after — that price is explicitly accepted.

### 3. It must genuinely quit before replacing anything

**Since the tray change, "closing the app" does not mean it exited.** Closing the window only hides it; the exe is still locked. The update flow must go through `app.quit()` (or the tray's exit), or Windows refuses to replace the files and the failure message is hard to read.

---

## 4. The design

### At build time

`postbuild.js` writes the zip's file list into a manifest and publishes it alongside. The manifest holds only program files — user data is not in the zip, so it cannot reach the manifest.

### At runtime

```
launch (or the timer) → hit the GitHub API and compare versions
  ↓ newer version exists
main-process dialog asks whether to update
  ↓ yes
download the zip to temp → verify against the sha256 the API returned
  ↓ passes
write a .ps1 to temp, launch it detached
app.quit()
  ↓ the helper takes over
wait for the PID to exit → delete by the old manifest → Expand-Archive → write the new manifest → restart the exe
```

Still zero runtime dependencies: `Expand-Archive` ships with PowerShell, and `postbuild.js` already uses `WScript.Shell`, so there is precedent.

**The failure mode is unexpectedly benign**: the zip contains no user data, so even if extraction blows up halfway, only program files are damaged — one more download restores them, and the data is never touched.

### Where the notification lives

**In the launcher, not the tracker.** The author himself uses the CLI plus `git pull`, while friends use the packaged build; putting it in the server would show CLI users a zip-download prompt for something they never use.

The main process's `dialog` **is** usable — CLAUDE.md's "no `window.confirm`" rule is about the renderer, and native dialogs belong to the main process; that is the boundary between the two. `main.js` already uses `dialog.showErrorBox`.

Three details are fixed:

- Failure must be **silent** (being offline is the normal case; no network should not raise an error box)
- It must be switchable off
- **Remember the version the user skipped**, or it prompts on every launch and trains itself into being ignored within two days

> **Note:** point one about `dialog` was later proved wrong — see "the rehearsals were worth more than the rehearsal" below. The prompt is a web page for that reason.

---

## 5. How to test it

The hard part of an updater is not the code, it is the verification — the whole path needs two real releases before it can run at all.

**The rehearsal trick: point it at v1.1.2 and perform a "downgrade".** That exercises the complete download → verify → delete-by-manifest → extract → restart path without publishing anything.

Unit-testable: manifest generation, version comparison, sha256 verification, skipped-version memory.
Not unit-testable: the actual file replacement (that is what the rehearsal is for).

All four unit-testable pieces live in `test/selfupdate.test.js`, each mutation-verified. The generated PowerShell is additionally parsed with `[Parser]::ParseFile` (Windows only) — that script runs in a process with no console and nobody watching, so a syntax error would be seen by no one; the symptom is simply "the program quit itself and never came back".

The whole path has been walked on a real release, including the final step where a **new release carrying a manifest ⇒ the helper installs the new manifest** (`Copy-Item $NewManifest`), which requires **two consecutive manifest-carrying versions** to reach at all.

**But "the update succeeded" is not the same as "the manifest step landed correctly"**, and that distinction matters: it is the last step, failing it does not make the update look failed, and the consequence only appears at the **next** update (deleting by a stale manifest, leaving a pile of obsolete files) — another silent degradation. **To confirm it, check that `resources/tracker/update-manifest.json` exists and names the right version.**

### The rehearsals were worth more than the rehearsal

Three rehearsals failed, and each exposed a silent failure that **neither unit tests nor a local rehearsal could reach**. These three are worth more than the updater's code:

1. **Native dialogs cannot stand up in this app.** `dialog.showMessageBox` returns instantly with `response: 420` (outside the button range), which reads as "later". Ten call shapes all gave 420, while a plain Win32 MessageBox on the same machine worked fine. This is the **second** time the repo hit this class of thing — the first was `window.confirm` making "generate guide" completely dead in the packaged build. The conclusion recorded then, "native dialogs belong to the main process", **was too narrow**: the main process fails too. **The boundary is native-vs-page, not renderer-vs-main.**
2. **`detached` does not let the helper outlive `app.quit()`.** Electron puts child processes in a kill-on-close job object, while `DETACHED_PROCESS` governs the console and cannot escape the job. Measured: only `cmd /c start` and WMI survive.
3. **Blind-quitting is what upgrades number 2 from "annoying" to "catastrophic".** The helper's first act is now to report in, and the app waits for that report before quitting; if it never arrives, the app shows an error and keeps running.

One methodological lesson goes with them: **say "I can't test that here" out loud, at the time.** One round took a conclusion from the sandbox and extrapolated it to the real environment — and the sandbox kills the whole process tree when the parent exits, so that environment simply cannot test "outlives the parent", and the conclusion drawn from it was wrong. What actually settled it was having **the user run a four-way probe in their own session**.

`launcher/main.js` needs Electron to import, so that part can only be covered by **source assertions** — see `test/tray.test.js` and the `drainNext` case in `test/guidequeue.test.js`.

⚠️ **A source assertion must strip comments before matching.** `test/tray.test.js` has a ready-made `stripComments`. Without it the assertion is satisfied by the comment sitting beside the code — this has already happened once, caught by mutation testing, invisible to reading.

---

## 6. A few non-obvious decisions

- **Check frequency: once 10 seconds after launch, then once a day.** Checking only at startup is not enough, for exactly the reason `maybeAutoSync` had to move from "process start" to "window shown": once the app lives in the tray the process can run for days, "startup" becomes a rare event, and a missed check raises no error — the prompt simply never arrives. Hanging it on "window shown" is too noisy: opening and closing ten times a day should not mean ten checks, which is precisely why the `syncStaleHours` gate exists. The 10-second delay keeps it from competing with server startup and the first sync for bandwidth.
- **Data stays in `resources/tracker/` rather than moving beside the exe.** The manifest has already removed the "deletion can touch user data" risk, so moving it is purely hygiene. It would need its own data migration on user machines, with its own independent risk — evaluate that separately, don't stack it on top of the updater.
- **"No unexpected files in the package" was only implemented for one specific case, not generally.** `postbuild.js` fails the build outright if `local.config.json` appears in the manifest. That is the **only** kind of junk in this gap that causes harm (it in the manifest = the next update deletes the user's data-directory pointer); any other junk file merely gets formally recorded as junk, the same as today. A general "what shouldn't be in the package" check still does not exist — it would need a definition of "unexpected", and the `lib/**/*` gap cannot supply one today.

### Three decisions that only surfaced during implementation

- **The manifest is a separate release asset, not a file inside the zip.** Not a style choice: the zip is produced by electron-builder and is already sealed by the time `postbuild.js` sees it, while the manifest has to describe that zip's contents — putting it inside is circular. The benefit is free: a user with a fresh unzip has no manifest, so their first update naturally takes constraint 2's overwrite path, and no special case has to be written for existing users.
- **An unrecognised `digest` refuses the update rather than skipping verification.** "Can't verify, so don't" means making the user execute an unverified 133 MB executable, and that degradation has no visible symptom — the update still "succeeds". Better to not update.
- **"Must be switchable off" landed as `autoUpdate` in `local.config.json`, not a new configuration surface.** That is already the launcher's only per-machine config file, and a second one for a single boolean is not worth it. The dialog's "don't tell me about this version again" is a different thing, recorded in `update-state.json` beside the exe.

---

## 7. Project conventions to know before starting

- **Branch before writing code**, not at commit time.
- **A new assertion must be mutation-verified** — break it deliberately and confirm the test goes red. This repo has produced several checks that silently passed nothing.
- **Keep UI copy short**: one unambiguous control beats a row of similar ones. Explanatory paragraphs go in `docs/`, not on screen.
- **Documentation is not updated on request**: every doc surface a change touches gets updated with it (`CLAUDE.md`, `launcher/README.md`, the release-notes checklist).
- Commit messages may be Chinese or English.
- The release-notes checklist is in `launcher/README.md`'s "Cutting a release" section, and already includes "quit from the tray before upgrading".
