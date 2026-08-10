# Guide checkbox sync

Optional feature. If you keep achievement guides as checklists, `checkbox-sync` ticks off the boxes for achievements you've actually unlocked on Steam.

Guide *content* stays wherever you write it — the database only stores a pointer to it. Two backends are supported, and each game uses exactly one.

## Notion

A guide is any page whose body starts with a line like `appid: 3117820`. That's how a page gets matched to a game.

**One-time setup:**

1. Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy its secret.
2. Find your guide database's ID: open it as a full page, and take the 32-character hex string from the URL — the part *before* `?v=`, which is the view ID rather than the database.
3. Run `node tracker.js init --notion`. It prompts for both (the token isn't echoed), verifies the token and the database access separately, and only saves once the token works.
4. In Notion, open the guide pages' shared parent → `•••` → **Connections** → add your integration. Child pages inherit it. Without this the API returns 404s.

In the packaged app, step 3 is the **④ Notion 攻略同步** section of the setup page instead — reachable on first run, and afterwards from the **设置** button on the Dashboard. It performs the same two checks and reports them separately, because the fixes differ: a rejected token means re-copying it from `my-integrations`, while a token that works but a database it cannot read means step 4 above was skipped. Leaving the secret blank there keeps whatever is already saved rather than clearing it.

Then:

```bash
node tracker.js guides --notion   # finds pages not yet registered and links them up
```

Pages without an `appid:` line are skipped quietly every run — they're guides you haven't written yet, not errors.

## Local markdown

A `.md` file in `guides/` with the same `appid: NNNNNN` line near the top. No token, no setup:

```bash
node tracker.js guides --local
```

Checkboxes are ordinary markdown — `- [ ]` becomes `- [x]`, in place, with the rest of the line untouched. Since these are files in the repo, `git diff` shows you exactly what changed and `git checkout guides/` undoes it.

If a game already has a Notion guide registered, a same-appid local `.md` is left alone unless you pass `--force`. One appid, one backend.

### Having one written for you

`node tracker.js guide-gen <appid>` has an AI research the game online and write the file, then validates the result against your actual achievement data and registers it. It needs an API key ([configuration](configuration.md#notes-on-individual-options)) and it costs money, so it asks before starting — `--dry-run` shows you the prompt and where the file would land without sending anything.

The checkboxes are **not** written by the model. It only ever emits `- [ ]`; the ticks are applied afterwards from your real unlock data, which makes "checked state equals real unlock state" impossible to get wrong rather than merely checkable. The `# 游戏名` and `appid:` header lines are written by the program too — a mis-transcribed appid would file the guide under a different game.

What the machine checks is **format and data**: every achievement has its own checkbox row, no merged rows, names match Steam exactly, descriptions are quoted verbatim, ticks match reality. If that fails it feeds the specific errors back and asks for a rewrite, up to three times; still failing, the attempt is kept under `guides/.drafts/`, which guide discovery cannot see — so a draft that didn't pass can never end up ticking your notes.

**What it cannot check is whether the guide is right.** Whether the steps work, whether a difficulty rating is fair, whether "easy to miss" is actually true — that's the whole value of a guide and no machine verifies it. Read what it wrote.

## Running the sync

```bash
node tracker.js checkbox-sync --dry-run   # read-only preview — do this first
node tracker.js checkbox-sync 3117820     # one game
node tracker.js checkbox-sync             # everything eligible
node tracker.js log 30                    # what it did
```

**Dry-run before any manual full run.** `--dry-run` reads the pages, runs the identical matching, prints exactly which boxes it would tick, and writes nothing — not even to `sync_log`. It earns the wait because the sync only ever **ticks**, never unticks: a wrongly ticked box cannot be undone automatically and has to be fixed by hand.

A game is eligible if it has a registered guide, has an achievement system, and isn't already at 100%. Every run appends to `sync_log`, including skips and failures.

## Automatic ticking

Opening the Dashboard, and the 「立即同步」 button on it, both run a tick pass once the achievement sync finishes. It is deliberately narrower than the manual command:

- **Only games that changed in that run** — ones where your unlocked count went up, ones where the developer added achievements, and guide pages registered for the first time that run. Nothing changed means zero Notion calls, which is the usual case.
- **No sub-step cascade.** Nested boxes under an achievement are only ticked by the manual command, where a dry-run is available first. See the cascade section below for why.
- **Failures are soft.** An expired Notion token shows a notice on the Dashboard; it doesn't fail the achievement sync or take the page down.

Every tick lands in `sync_log` exactly as the manual command's do, so `node tracker.js log 30` is the review path. The Dashboard also shows a notice naming the first few boxes it ticked, and that notice does not auto-dismiss.

Both halves can be turned off in `config.json`:

```json
{ "checkboxSyncOnServe": false, "checkboxSyncOnServeCascade": true }
```

Set the first to `false` to go back to ticking only when you run the command yourself. The second turns the sub-step cascade *on* for the automatic path — off by default on purpose.

One consequence worth knowing: a game that reaches 100% is normally skipped, but a game that reached 100% *in that run* is still visited. Otherwise the achievement that completes a game would never get its box ticked — by the next run the game is already at 100% and would be skipped forever.

## Keeping guide status in step with completion

A Notion guide page's `Status` property is kept aligned with how complete the game is, in both directions:

- Reach 100% → **`Done`**
- Drop below 100% → back to **`Staged`**

```bash
node tracker.js guide-status --dry-run   # what it would change
node tracker.js guide-status             # do it
```

It also runs on the serve path, right after the checkbox tick — that ordering is deliberate, so a game that just completed gets its last boxes ticked *before* the page is marked done. Turn it off with `"guideStatusOnServe": false`.

Dropping below 100% happens when a developer patches in new achievements. It's the one kind of change that occurs without you playing, so a page stuck on `Done` is exactly the case you'd never notice on your own.

**The rules are written over current state, not over the moment of crossing.** That distinction is the whole design. Crossing 100% exists only once, inside a single sync; a run that sees it but can't write to Notion — no token on that machine, expired credentials, an interrupted process — would lose it forever, since every later run just sees the same value on both sides. Checking current state instead means the pass is idempotent, re-runnable, and repairs itself next time.

The two directions are deliberately not equally aggressive:

| | Touches | Leaves alone |
|---|---|---|
| Promote to `Done` | every status except `Done`, `Differed` included | — |
| Demote to `Staged` | only `Done` | `Paused`, `In progress`, `Not started`, `Differed` |

Promotion is safe to be blunt about: reaching 100% is objective. Demotion is narrow on purpose — a sub-100% page you've set to `Paused` is a decision you made, and rewriting it on every Dashboard open would have you and the tool overwriting each other indefinitely.

Notion-kind guides only; local markdown has no status property. A game whose `total` becomes unknown — Steam reporting no achievement system — is never treated as having dropped below 100%.

## Auditing for wrong ticks

`checkbox-sync` only ever ticks, so it can't repair a box that was ticked wrongly. `audit` looks in the opposite direction — for boxes that are ticked while the achievement is still locked:

```bash
node tracker.js audit            # everything
node tracker.js audit 570780     # one game
```

Read-only; it never writes, so there's no `--dry-run`. It only examines games below 100%, since every box in a fully-completed game is legitimately ticked.

To decide *which* achievement a given checkbox refers to, it needs an unambiguous handle, and it will only use one of two:

1. the achievement's **full description**, quoted in the checkbox text, when that description is unique in the game;
2. the achievement's **name**, when that name maps to exactly one achievement.

If neither applies, the box is counted as undetermined and reported as such — never guessed. That's why output distinguishes "confirmed wrong" from "couldn't tell": on a 310-game library, 1,175 ticked boxes resolved cleanly and 65 didn't, and claiming the latter were fine would have been a lie. Writing guides so they quote the official description verbatim is what keeps that second number small.

## How matching works, and why it's strict

An unlocked achievement is matched to a checkbox by **exact equality** against candidate segments extracted from the checkbox text. Never substring, never prefix.

Candidates are split out by line break, by the first colon or dash, and from the `中文名(English Name)` pattern — plus the whole line. The achievement's Chinese *or* English name must equal one of those candidates exactly.

This strictness is deliberate and was arrived at the hard way. Loose matching produced two separate rounds of wrong ticks:

1. an achievement name appearing inside an unrelated achievement's *description*, and
2. a short achievement name being a strict *prefix* of a different, harder achievement — which mis-ticked the harder one once the short one's own box was already checked.

There's a third case exact matching can't solve on its own: some games contain **two different achievements with identical names**. If only one is unlocked, names alone can't say which checkbox belongs to it. If both are unlocked, any assignment is correct and it proceeds normally.

A name is disqualified individually, not the achievement as a whole. Most collisions are localization slips where only one language is affected — Plague Inc ships two achievements called 生化武器大师 whose English names are `Nano-Virus Master` and `Bioweapon Master` — so if the other language's name is unique, matching still uses it. The colliding name itself is never used either way.

**The fix for that is in how you write the guide, not in the code.** If a checkbox quotes the achievement's official description verbatim, and that description is unique in the game, the box is unambiguously about that achievement — so the sync can tick it correctly even though the names collide. That's why the recommended shape is:

```
- [ ] **成就名**
      official description, copied verbatim
      your own notes and tips
```

The name (on its own line, or followed by a colon or dash) is what lets the box be ticked; the verbatim description is what lets it be *verified*, and what rescues same-name pairs. Paraphrasing the description costs you both. Do **not** disambiguate by adding a suffix to the name (`妙手空空·通关100次版`) — that stops the name matching exactly, so neither box can ever be ticked.

The rule throughout: **a missed checkbox is better than a wrong one.** If you tighten or loosen any of this, run `node --test` — `test/matching.test.js` pins all three failure modes.

## When something doesn't get ticked

Roughly in order of likelihood:

- The achievement isn't actually unlocked on Steam. Check the Dashboard's per-game detail.
- The guide's wording doesn't match the achievement name closely enough to produce an exact candidate. Matching is intentionally unforgiving here; adjust the checkbox text.
- The game has two identically-named achievements — see above. `node tracker.js log` will say so explicitly.
- The page has no checkbox blocks at all (a pure walkthrough, or an embedded database using a "Done" property instead of checkboxes). Databases aren't supported; that needs different logic.
- The achievement detail hasn't been synced yet, so the tool doesn't know the achievement's names: `node tracker.js sync --schema`.
