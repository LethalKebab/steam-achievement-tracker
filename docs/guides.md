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

## Running the sync

```bash
node tracker.js checkbox-sync --dry-run   # read-only preview — do this first
node tracker.js checkbox-sync 3117820     # one game
node tracker.js checkbox-sync             # everything eligible
node tracker.js log 30                    # what it did
```

**Always dry-run first.** Ticking a Notion checkbox can't be undone automatically, and a preview costs nothing but time. `--dry-run` reads the pages, runs the identical matching, prints exactly which boxes it would tick, and writes nothing — not even to `sync_log`.

A game is eligible if it has a registered guide, has an achievement system, and isn't already at 100%. Every run appends to `sync_log`, including skips and failures, so you can audit it later.

Note the sync only ever **ticks** boxes, never unticks. It can't undo a box that was ticked wrongly — that's a manual fix.

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
