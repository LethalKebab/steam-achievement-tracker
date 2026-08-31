# Contributing

[`README.md`](README.md) addresses one reader: someone running the packaged Windows app. This page is for the other one — someone changing the code.

It is deliberately short. Almost everything here is a pointer, because the rules and the reasoning behind them are already written down elsewhere and a second copy would only drift out of date.

## Running it from source

Node 24 or newer, and nothing to install — the runtime uses Node built-ins only.

```bash
node tracker.js init     # Steam Web API key + SteamID64, verified against Steam immediately
node tracker.js sync     # pulls your library (a few minutes the first time)
node tracker.js serve    # Dashboard on http://127.0.0.1:8777
```

Full setup, including the optional Notion and AI halves, and the complete command reference: [docs/cli.md](docs/cli.md).

### Working on the pages without a Steam key

`init` verifies the key against Steam, and `/` redirects to `/setup` while `steamApiKey` and `steamId` are unset — so `Dashboard.html` cannot be opened at all until something fills them. What the redirect tests is only that both are **non-empty**, so for interface work they need not be real:

```bash
mkdir -p /tmp/sat-dev
cat > /tmp/sat-dev/config.json <<'JSON'
{
  "steamApiKey": "dummy",
  "steamId": "76561190000000000",
  "syncStaleHours": 0,
  "syncGuidesOnServe": false,
  "checkboxSyncOnServe": false,
  "guideStatusOnServe": false
}
JSON
TRACKER_DATA_DIR=/tmp/sat-dev PORT=8779 node tracker.js serve
```

`TRACKER_DATA_DIR` moves `config.json`, the database and `guides/` together, so this cannot reach a real install; `PORT` keeps it clear of a packaged build already holding 8777. The four switches turn off `serve`'s startup jobs, which would otherwise go to Steam and Notion with credentials that are not real.

The Dashboard comes up empty. That is enough for layout, copy, theming and interaction work, and not enough for anything that needs real rows — for that you need a key and a `sync`.

There is no build step and no deploy. Edit a file, re-run the command. `serve` does **not** hot-reload `lib/` — restart it after changing anything there. `Dashboard.html` and `lib/rpc.js` are read per request, so a browser refresh is enough for those.

## Where things are written down

[`CLAUDE.md`](CLAUDE.md) states the current rules for the whole repository — stack constraints, file architecture, the data model, sync behaviour, Steam API quirks, known pitfalls. Read it before changing anything. It is addressed to an AI agent, but nothing in it is agent-specific.

`docs/` carries the derivations that `CLAUDE.md` leaves out: **which alternatives were excluded, and what was measured**. A rule that reads as arbitrary usually has a measurement behind it.

| Changing | Read first |
|---|---|
| `Dashboard.html`, `Setup.html` | [docs/frontend.md](docs/frontend.md) |
| AI guide generation | [docs/ai-guide-writing.md](docs/ai-guide-writing.md) |
| Guide checkbox matching | [docs/guides.md](docs/guides.md) |
| Config fields | [docs/configuration.md](docs/configuration.md) |
| The database, backup and restore | [docs/data.md](docs/data.md) |
| The CLI | [docs/cli.md](docs/cli.md) |
| Self-update, packaging, releases | [docs/self-update.md](docs/self-update.md), [launcher/README.md](launcher/README.md) |

If your change touches a surface with a record above, update that record in the same pull request. The records are the reason a later reader does not redo work that was already tried and rejected.

## Constraints a change must not break

Two of these fail **silently** — the language boundary and checkbox matching. Nothing errors, CI can be green, and the damage shows up in someone's Dashboard or in someone's own notes. The other two announce themselves.

1. **Node 24+**, ES modules. `node:sqlite` is the reason.
2. **The language boundary.** Anything a *user* reads at runtime comes from a `[zh, en]` message table and follows `uiLanguage` — Dashboard and Setup copy, messages thrown from `lib/`, CLI output, and the prompt sent to the model each keep both languages side by side, with Chinese as the source text. Anything a *developer* reads is English: comments, documentation, test names. Never leave a user-facing string as a loose literal in `lib/` or the pages. `test/i18n-boundary.test.js` and `test/uilanguage.test.js` guard this, because the failures are invisible — a literal renders in one language whatever the interface is set to, and a table entry missing its other half falls back silently.
3. **Guide checkbox matching is not to be loosened.** It decides whether someone's own notes get ticked; a looser rule ticks the wrong achievement and nothing reports it. See the section of that name in `CLAUDE.md`.
4. **Never commit `config.json`, `data/`, `backups/` or `guides/`.** This repository is public and those hold plaintext Steam, Notion and AI credentials, your database, and your personal notes. All four are gitignored — keep it that way.

## Dependencies: a default, not a ban

The runtime currently has none — `dependencies: {}`, no root `node_modules`, Node built-ins only (`node:sqlite`, global `fetch`, `node:http`, `node:test`). That is what makes `git clone && node tracker.js` work with no install step, and it is worth keeping for its own sake.

It is **not** a prohibition. The blanket "never add a dependency" rule was lifted; a genuine runtime dependency is allowed and needs an argument, not permission.

Two things follow if you add one:

- **Prefer vendoring where that fits.** npm as a *build-time* tool costs the runtime nothing — the bundled font was fetched with npm, the files committed, and the package thrown away. Where an artefact can be fetched once and committed, do that instead.
- **The CI workflow has to change with you.** [`.github/workflows/tests.yml`](.github/workflows/tests.yml) runs no `npm install`, deliberately, so that an *accidental* dependency fails immediately rather than quietly becoming a requirement. A deliberate one means adding that step in the same pull request — otherwise CI fails and says nothing about why.

## Tests

```bash
node --test --test-reporter=dot     # the whole suite
node --check lib/foo.js             # syntax check, silent on success
```

**Use `--test-reporter=dot`.** The default reporter prints a line per test and buries the one that matters.

**`dot` prints no summary line.** The green signal is the exit code and the absence of an `X`, not a sentence. Two consequences: never pipe it through `tail` and conclude "all tests pass" because nothing looked wrong — a failure block sits *above* the dots and `tail` hides it; and when you actually want a count, use the default reporter for that run.

The suite is a few dozen files (`ls test/*.test.js` for the current count — a number written here would only drift). Many exist because an existing rule was mutated until it failed, so a test here is often pinning a specific past mistake rather than a happy path. A behaviour change is expected to arrive with one.

CI runs the same suite on every pull request and every push to `main`, on `windows-latest` with Node 24, and there is no `npm install` step — see the section above for what that absence is doing and what it means if you add a dependency on purpose.

## Branches, commits and pull requests

`main` is protected by a ruleset: pull requests are required, the `test` check must pass, and force-pushes and deletion are blocked. A direct push to `main` is rejected regardless of permissions.

- Work on a branch, open a pull request against `main`.
- **A first pull request from a fork does not start CI by itself.** GitHub holds workflow runs from first-time contributors until a maintainer approves them, so the checks sit unstarted — nothing is wrong with your branch and re-pushing does not help. Once you have one merged pull request here, later ones start on their own.
- Commit messages take a conventional prefix (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`) and are **English**, subject and body alike. So are pull request titles and bodies. The reader of a commit message is whoever is bisecting, not the app's user — the user-facing half is bilingual and unaffected.
- **`git log` is mixed, and the log is not the rule.** Commits from before this was settled are Chinese and stay that way; history here is not rewritten.
- Say in the body what changed and why the alternative was not taken. Commit bodies here are long on purpose; they are where a decision is recoverable from six months later.

## Packaging

Building the Windows app is not part of an ordinary change. `dist/` is gitignored, and a rebuild is not a release — no version bump, no tag, no upload. The build steps and the release checklist are in [launcher/README.md](launcher/README.md).

A build you make yourself reads **this checkout's** `config.json` and `data/`, the same ones `node tracker.js serve` uses: `postbuild.js` leaves a `local.config.json` beside the exe pointing back here. That is not a convenience — the rename step deletes the previous build's directory, which is where a packaged build would otherwise be keeping your database. It also switches auto-update off, so a build from your branch cannot offer to replace itself with the published release and leave you testing code that no longer contains your change. A zip handed to somebody else carries neither setting; it is sealed before that file is written.

## Reporting a bug

Issues are welcome. **Do not paste `config.json` or a backup zip into one** — both carry your Steam API key, Notion token and AI keys in plain text, and this repository is public. The output of `node tracker.js status` is safe to share.
