# Security Policy

## Supported versions

The current release only. The app checks GitHub Releases on launch and once a day after
that, and offers the new version in-app, so "update first" is a realistic first step rather
than a brush-off. Fixes ship in a new release; there are no backports.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything older | Update first, then report if it survives |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this
repository. It is private between you and the maintainer.

**Please do not open a public issue for a security problem.** Everything else is welcome as an
issue — this is the one exception.

Whatever you send, **do not attach `config.json` or a backup zip**. Both carry your own Steam
API key, Notion token and AI keys in plain text. `node tracker.js status` is safe to paste.

One person maintains this, so expect a human pace rather than a service level: an
acknowledgement when it is read, and a fix in the next release once there is one. Say in the
report whether you want crediting in the release note.

## What this program actually is

Worth knowing before you spend time on it, because it changes what counts as a finding.

It runs **entirely on one machine**. There is no server anybody operates, no accounts, no
telemetry, and no multi-user boundary to cross. Data lives in a local SQLite file, and the
only network calls are outbound to Steam, Notion and an AI provider, using keys the user
supplied.

So the interesting surface is narrow and specific:

- **The local HTTP server** (`127.0.0.1:8777`). This is the big one. Binding to loopback keeps
  the LAN out but **not the browser** — any page the user has open can send requests to it, and
  a `text/plain` POST is a CORS simple request with no preflight, so side effects land even
  when the response cannot be read. `isLocalCaller` in `lib/server.js` checks `Host` and
  `Origin` to cover that and DNS rebinding. Ways around it are in scope.
- **Anything that gets script into the Dashboard page**, because that script is *same origin*
  with the local API and so walks straight past the check above.
- **Path containment** — guide files, archive ids and zip entry names all arrive from outside
  and are resolved against a root. Reading or writing outside it is in scope, restore included.
- **The self-update path** — it downloads a zip from GitHub Releases, verifies it against the
  `sha256` digest the release carries, then replaces the running app. Anything that lands
  unverified bytes on disk is in scope.
- **The published zip** — it must never contain the user's `config.json`, database or notes.

## Out of scope

Design, not defects:

- **`config.json` holds the keys in plain text**, mode `0600`, in the user's own data
  directory. This is a single-user local program: anyone who can read that file can already
  read the database and run code as that user. Encrypting it against an attacker who is
  already that user buys nothing. See `docs/configuration.md`.
- **Anything that presupposes code execution as the user, or filesystem access to their data
  directory.** That is past the boundary, not a way through it.
- **What an AI-written guide says.** The program checks format and data — one checkbox per
  achievement, names matching Steam, descriptions quoted, ticks matching real unlock state —
  and explicitly not whether the advice is correct. The README says so too.
- **Denial of service against your own instance**, and rate limits on your own API keys.
- Findings from an automated scanner with no working path through the above.

## What is already guarded

Not to discourage a report — to save you rediscovering these. Each has tests, named here so you
can read the threat model rather than infer it:

| Area | Where |
|---|---|
| Local server: CSRF, DNS rebinding, a malformed escape that killed the process | `test/server-guard.test.js` |
| Path containment, and the sibling-prefix leak | `test/pathsafe.test.js` |
| Zip-slip on restore | `test/backup.test.js` |
| Update download: sha256, manifest path validation | `test/selfupdate.test.js` |
| Per-vendor key isolation | `test/config-ai-providers.test.js` |
| The published zip carrying user data | `launcher/verify-artifact.mjs` |
| Escaping into the Dashboard's progress bar | `test/html-smoke.test.js` |

If you find a way past one of them, that is exactly the report worth sending.
