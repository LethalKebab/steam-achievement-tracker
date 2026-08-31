---
name: achievement-guide-writing
description: Use when writing, rewriting, or editing a Steam achievement guide for this project (Notion page or local .md file like sultans_game_achievements.md) — covers the checkbox-per-achievement rule required by the daily sync job, when screenshots are worth embedding, and the full workflow for authoring a new guide from Steam + wiki data (pulling ground truth, sourcing wiki content, writing/replacing Notion content, verifying).
---

# Writing and editing a Steam achievement guide

Applies to any Notion guide page, and to local `*_achievements.md` files.

The rule identifiers below live in the headings as `[id]`, never in their wording. `SKILL_RULE_DISPOSITION` in `lib/guidegen.js` is keyed by them and cross-checked against this file both ways, so **adding a heading here turns `test/guidegen.test.js` red** — a new section is exactly the moment to say whether it went into the generator's prompt.

---

## [rule-1] Rule 1: every achievement gets its own checkbox line

`- [ ] **Achievement Name**` / `- [x] **Achievement Name**`. Never:
- several achievements merged onto one line (`- [x] **A** / [x] **B**`)
- a whole group of "all done, not very interesting" achievements written as a paragraph with no checkboxes

**Writing an unlocked achievement short is fine; leaving it out is not.** The generator gives an already-unlocked achievement a single `- [ ] **Name** — official description` line (see `docs/ai-guide-writing.md`), and that still satisfies this rule: one checkbox per achievement, just with no notes. What is forbidden is folding them into prose — without that line, `checkbox-sync` can never tick it again.
- a whole category ("39 reputation achievements") summarised as plain text

**Why**: in Notion markdown only the first `[ ]`/`[x]` on a line renders as a real interactive checkbox; anything after a `/` is escaped into the literal text `\[x\]`. And the daily job that syncs unlocked achievements into the guide page (`node tracker.js checkbox-sync`, see the `steam-checkbox-sync` skill) ticks boxes by matching the line's leading text against `- [ ] **Achievement Name**` exactly — a merged line or a prose summary is something the sync simply cannot find. This is also why guides are checkbox lists rather than Notion embedded databases: an embedded database cannot be parsed by the sync, and writing real guide prose entry by entry is worth more than a database table anyway (reference: the CK3 page, where 188 achievements were rewritten from an embedded database into checkbox form).

### [rule-1/notes-lines] The notes section: put prerequisites, steps and warnings on separate lines

`<br>` is a line break inside a checkbox. Use it to separate things of different kinds: prerequisites and material lists get their own line beginning "Prerequisite:"; anything past three steps goes **one step per line**; whatever causes a failure or a wrong turn gets its own line beginning "Careful:".

**The test is whether one line mixes two kinds of thing, not how long it is.** Six hundred words in a single block can be entirely correct and still leave the reader unable to tell which sentence is preparation, which is the action, and which is the trap. Read it back: **can you point straight at which sentences are prerequisites and which are steps?** If not, it is not yet broken up.

Counter-example, generated 2026-08-21 for 苏丹的游戏 (Sultan's Game), achievement 「创造」: 613 characters in one block. It had in fact written out "前置准备:…" and "流程:1)…6)", but all inside the same `<br>` segment, so none of that structure reached the page.

### [rule-1/sub-labels] Group labels on sub-checkboxes

When there are enough entries to need grouping, **the label goes on its own line; do not repeat it in front of every entry**. Writing "Prerequisite:" and "Steps:" onto fourteen lines puts one word on screen fourteen times to say two things.

**The label line itself should not be a checkbox.** "Prerequisite" is not a thing that can be finished, so ticking it means nothing. Following the same test one step further, **entries under "Careful" should not be checkboxes either** — a warning is something you come back to when things go wrong, not a task, so it can never be ticked off and only holds this achievement's progress down for good. **A checkbox is for a line the reader can actually finish and tick.**

There are two spellings, one per backend, and neither works in the other's place.

#### Notion pages (the default backend, see 8.0): labels carried on `<details>`

```
- [ ] **创造**<br>你可以创造一切，包括你自己。<br>走「打磨龙眼→创世线」……
	<details>
	<summary>**前置** — 开局前先备齐</summary>
	- [ ] 命运商店花 40 点数买「神之侧身像」
	- [ ] 玛希尔两次「项目投资」完成后入队
	</details>
	<details>
	<summary>**注意** — 走岔就掉别的结局</summary>
	- 魔力熔炉别放人，放追随者会被直接烧死
	</details>
```

`fetchAllToDoBlocks` (`lib/notion.js`) treats toggle and column blocks as **transparent containers** — `parent` is passed straight through, so a sub-checkbox inside a fold is still recorded under this achievement and `--cascade`'s parent/child relationship is unaffected. Folding also solves something else in passing: a thirty-line list collapses to three, and the page becomes scannable again.

Demoting "Careful" entries to plain bullets buys one concrete thing as well: they stop being `to_do` blocks, so they never enter the sync's candidate pool and `--cascade` cannot tick a run of warnings into a set of false records — which is the real answer to the cost noted at the end of this rule.

**`guide-gen` gives this rule per backend too.** `buildSystemPrompt({ target })` takes `'notion'` / `'local'`: a Notion target gets the folded form above, a local md target gets the checkbox-label form below. **When `target` does not reach it, it falls back to the checkbox-label form** — a fold written into local md silently truncates a range, while a checkbox label written into Notion is merely a bit ugly, and the costs of guessing wrong are not symmetric. The group label is the only rule in the whole prompt that branches on the backend; nothing else does (see the comment on `groupLabelRule`).

#### Local `*_achievements.md`: the label line has to stay a `- [ ]`

```
- [ ] **创造**<br>……
	- [ ] **前置**
		- [ ] 命运商店花 40 点数买「神之侧身像」
```

This one is a mechanical requirement rather than a matter of style: `todoSpans` (`lib/markdown.js`) decides which lines an achievement occupies by taking the run of **consecutive**, more deeply indented checkbox lines, and one non-checkbox line in the middle — a plain bullet, a `<details>`, a sentence of section commentary — cuts that range short on the spot. Measured: a seven-line structure was read as one line, the partial rewrite pasted the new entry in, and the old six lines stayed where they were as a duplicate. **So this layer of a local md cannot use a fold, and the label cannot be a plain bullet.**

Group only when there are enough entries to need grouping; five or six go flat, with no extra layer.

### [rule-1/nesting] Sub-tasks and sub-collectibles: nesting needs three conditions

Sub-checkboxes are **off by default**. All three of these have to hold **at once**:

1. **Each line has an identity of its own** — a shrine's name, a recipe, a side quest, a collectible's location: a specific thing to go and find, look up or recognise. **A number is not an identity**: `Day 1`/`Day 2`, `Level 1`/`Level 2`, `1/10`, `Step one`/`Step two` only spell a number out and add nothing.
2. **The line has something to say beyond "which one it is".** The test is **not whether the game has a counter** — a counter only tells the player how many are left, never how to get the one they are missing, and the second is the entire value of a guide. `Day 1`…`Day 7` has no method to state, so it is not nested; thirty encyclopedia entries each obtained a different way **are** nested, each line saying how that entry is obtained. Ten collectibles that all drop the same way are not nested either — those ten lines say one thing ten times.
3. **Every line has to be done**, not one of them chosen. Where the lines are **alternatives** (nine endings under "reach any ending", five classes under "finish with any class"), **do not nest** and write them flat in the notes — nesting means "the parent unlocked ⇒ every line below it was done", and putting exclusive options there creates eight false records.

**An achievement that takes several stages to reach: write the process itself as sub-checkboxes.** The three conditions hold for a long process just as well: each step is a **specific action** (what to place in which ritual, where to trigger which event), it has a method to state, and every step has to be done. Nesting is not only for collectibles — the reader does this across several sittings in one playthrough and wants to tick it off step by step. **Three steps or fewer belong in the notes and need no breakdown.**

When all three hold, nesting is not merely allowed but required — in that case the reader really does tick them off one at a time:

```
- [x] **水火不容**<br>完成所有差事<br>一共五个支线：
  - [x] 1.【二手灵魂】：第一次水位下降后...
  - [x] 2.【法夫纳的宝藏】：离开精灵国时...
```

Counter-example, generated 2026-08-11 for Wrap House Simulator:

```
- [ ] **7天的悠闲**<br>在轻松模式下游玩7天。<br>...
  - [ ] 第1天
  - [ ] 第2天   ← up to 第7天, one set under each of four difficulty achievements: 28 in all
```

None of the three holds: a number is not an identity, the game counts the days itself, and deleting them costs the guide nothing.

**One self-check: delete those lines — does the guide lose any information?** If not, do not write them.

There is one more cost, real but not visible in the guide: `checkbox-sync --cascade` ticks sub-boxes on the rule "the parent achievement is unlocked ⇒ its sub-steps were all done" (see the `steam-checkbox-sync` skill). Meaningless sub-boxes hanging under an unlocked achievement get ticked automatically into a run of records that record nothing.

### [rule-1/duplicate-names] Achievements with duplicate names

One game really can carry **two achievements with identical names** (identical in Chinese and English alike, differing only in description). These **must have the official description copied in verbatim**, because it is the only thing that tells them apart.

```
- [ ] **妙手空空**<br>成功偷窃了其他修仙者的物品10次，并且尚未被察觉。<br>开局就能做
- [ ] **妙手空空**<br>通关且成功偷窃其他修仙者100次<br>需要二周目
```

**Do not tell them apart by adding a suffix to the bold name** (「·隐秘10次版」/「·通关100次版」). It looks clearer and it stops the name being exactly equal to any candidate segment, so **neither box syncs any more**:

- the sync matches on "the achievement name is exactly equal to one of the candidates", and `妙手空空·隐秘10次版` ≠ `妙手空空`
- while same-named achievements are not all unlocked, the sync already refuses to guess by name (see the `steam-checkbox-sync` skill)

With the description copied in, the sync can tell which is which by description and ticks normally. Anything you want to add of the "the stealth-10 one" kind goes in the third part with your own notes; leave the bold name alone.

### [rule-1/verify] Verify after writing

When you are done, **fetch the page again and confirm the checkboxes really landed**. Do not assume that `notion-update-page` returning success means the content is right. The fuller verification steps are at the end of rule 9.

---

## [rule-2] Rule 2: only embed screenshots that carry information

### [rule-2/worth-shots] Screenshots worth embedding
- map positions and route markings
- UI screens and menu options (a decisive dialogue choice, an equipment screen)
- the exact location of a hidden path or entrance
- a boss mechanic demonstration, where prose struggles to describe it
- the precise location of a key item

### [rule-2/video-instead] When a screenshot is not possible: a video link with a timestamp

In hunting and puzzle games a location often can only be shown on screen, and the `guide-gen` pipeline **cannot produce a reliable in-game screenshot** — the model cannot take one and cannot see one, so it has no way to check that what it embedded is right. The substitute is a video link **with a timestamp**: "compare against the 5-2 chapter of <video> (01:56)". **This subsection is the only part of rule 2 that went into the generator's prompt.**

**A generality is not an answer.** "check the corners" and "look for anything obscured" are true of every level ever made and give the reader nothing new. Where you cannot give the actual location, give a timestamp; where you have neither, say plainly why this one is hard to find ("it is not on the to-find list, so the hint system cannot locate it") — that is information too.

### [rule-2/no-shots] Screenshots not to embed
- the achievement unlock popup — beyond its own title text it carries nothing
- purely decorative cover art and promotional images
- anything where you are unsure what is actually being shown; link to a reference guide instead

### [rule-2/source-images] When the source guide has images
Where the guide you worked from (a wiki, TrueAchievements, a Steam guide) had map, UI or menu screenshots of its own, provide equivalent images rather than prose alone.

---

## [rule-3] Rule 3: how an achievement entry is written

### [3.1] 3.1 The format of a single entry

**The standard form**: `- [x] **Achievement Name**<br>official description (copied verbatim, strongly preferred)<br>your own notes (optional)`

All three parts go in the same bullet separated by `<br>`, never under their own sub-headings.

**Why the description is copied rather than reworded** — the two pieces of text each have a machine use, not only a human one:

| This part | Who uses it | What breaks without it |
|---|---|---|
| **The achievement name** (bold, at the start of the line, followed immediately by `<br>` or a colon or a dash) | `checkbox-sync` ticks by it | it never ticks |
| **The official description, verbatim** | `audit` traces a box back to its achievement by it; duplicate names are told apart by it | the audit cannot account for that box, and duplicate-named achievements never sync |

A reworded description ("隐秘偷窃10次" for "成功偷窃了其他修仙者的物品10次,并且尚未被察觉") no longer matches. Anything you want to add goes in the third part; leave the second alone. Where the wiki you worked from gives an explicit difficulty rating, carry a mention of it into your own notes rather than creating a field for it.

**How much to write**:
- **an achievement that unlocks automatically as the story progresses**: the name is enough
- **an achievement with a mechanic but a simple one**: the official description, or a one-line note
- **an achievement with a trap, a trick, or something easy to miss**: write out the steps, the prerequisites, the decisive choices and where it goes wrong. This is the most valuable part of a guide
- **whether or not the achievement is unlocked, write down anything worth recording** — this is a record of how the game was played, not a to-do list of what is left

**Additional notations**:
- **Location**: for anything tied to a specific place on the map, begin the entry with `位置 XXX`
- **Prerequisite**: where a background, skill or perk is required, use `※需要有背景X`
- **Mutually exclusive**: where two achievements conflict, warn with `<span underline="true">如果进行此动作则无法获得X成就。</span>`
- **Missable**: where passing some point loses the achievement permanently, mark it `易错过!!`
- **DLC excluded**: where an achievement does not include DLC content, mark it `※除去追加内容`

### [3.2] 3.2 Working from an external guide

A reference guide (a wiki, TrueAchievements, a Steam guide, a video) is there so you can **understand the mechanics and then rewrite them in your own words**, not to be copied.

In the rare case where the original phrasing of a timing window or a trigger condition is unusually precise and easily lost in translation, keeping the original sentence is fine, provided it is short and preceded by a note giving the context.

A collectible guide may cite a video by its identifier or link; embedding the video is not needed.

### [3.3] 3.3 "Addendum": something found after the guide is written

Where a new detail or condition turns up once the guide is largely done, append it to the existing entry as `补充1`, `补充2`.

### [3.4] 3.4 Sub-pages and embedded tracking tools

For a game with a great many collectibles, a sub-page may hold the detailed guide while the main page keeps the achievement list plus a link.

A Notion database may also be embedded at the foot of the page as a tracker — a table of every cheat found, or of every ending branch.

### [3.5] 3.5 Game-mechanic quick reference

Where a game has operating details worth looking up repeatedly (cocktail recipes, pottery controls), a short section of mechanics may go before the achievement list. Reference tables (co-op priorities, class unlock conditions) may go at the top too. This is a functional reference, not documentation wrapping.

---

## [rule-4] Rule 4: page structure

### [4.1] 4.1 The opening: minimal

**One line, `appid: NNNNNN`**, on its own at the very top. The guide sync (`syncGuidesFromNotion`, see the `steam-guide-sync` skill) matches a Notion page to a Steam appid by this line; without it the page is never picked up into the guides table and never appears as a guide link on the Dashboard.

**Never** open with a title, achievement statistics, a spoiler warning, a note on where the Chinese names came from, a paragraph of sources, or advice for new players.

**"No top-level heading" holds for Notion pages only.** A local `*_achievements.md` **must** carry a `# Game Name` line — `syncGuidesFromMarkdown` takes the first `^#` in the first 15 lines as the guide's name (falling back to the file name), while a Notion page's name comes from its title property and does not need repeating in the body. Without that line the name in the guides table becomes the first section heading; this has happened, and the guide registered as `# 一、店铺日常与鉴定`.

Where there really is an important reference guide, a link or two may go under the `appid` line, but not organised into a "sources" section.

### [4.2] 4.2 Sections: follow the game's own achievement categories

Divide into sections along the game's own categories (main story / side content / collectibles / combat / miscellaneous), following how the game itself divides them.

**Things of the same kind belong in the same section, judged by the official description, not by how they unlock.** The four 「将吉祥物替换为 X」 achievements in 《马特的寻猫游戏》 were once split across two sections — two are bought in a shop and went under 「宝石与商店」, the other two are easter eggs and went under 「吉祥物替换」. Each half made sense on its own, and together they meant the reader had to look in two sections for one thing. Likewise the "unlock every X" group, and the 100/500/1000 tiers of the same thing, are each one group and are not scattered.

On the generated path the program has a backstop (`lib/guidecluster.js` identifies same-kind clusters by the common prefix of the official descriptions and merges a split cluster back into whichever section holds the most of it), but **it only runs when the guide was sharded** — a game with fewer achievements than `ai.chunkSize` is written in one pass and never makes that trip, so it rests entirely on this rule. A hand-written guide has no backstop either.

Section headings carry no counts ("12 total, 3 remaining").

To group an existing achievement list by category (by DLC, say), prefer the `update_content` targeted insertion described in rule 9 over re-transcribing the whole page.

### [4.3] 4.3 The ending: stop when you are done

No closing note, no summary. Nothing about what the guide is still missing, where it came from, or a collected list of links. Finish the last achievement and stop.

### [4.4] 4.4 Handling DLC

Treat DLC achievements as an ordinary section of the game. Do not label them with parenthetical notes about the release they came from; a section heading naming the DLC is enough.

---

## [rule-5] Rule 5: fold long content into `<details><summary>`

Applies to: full ending comparison tables, complete collectible lists, bestiary lists grouped by region, the full walkthrough of a side quest chain, complete collection tables.

A folded block may hold: a nested checkbox list, an HTML `<table>`, images with captions.

**A fold holds the supporting material under an achievement, never the achievement list itself — an achievement's own line never goes inside a fold.** Fold a whole section's achievements away and opening that section in Notion shows nothing. Measured on 《马特的寻猫游戏》: all 13 achievements of the `## 世界全清` section were put inside a fold titled 「世界 1~12 全清与通关」; the sync still recognised them, and what the reader saw was an empty section. `unwrapAchievementToggles` (`lib/guidegen.js`) takes that kind of fold apart — the test is "a top-level fold whose checkboxes resolve back to real achievements", so a group-label fold indented under an achievement (rule 1) is unaffected.

**The floor: fold it once it reaches 10 lines, or once it is longer than the body of the achievement it belongs to.** Under that, leave it open — a fold costs a click, and a three-line table folded away is just information hidden.

Group labels (rule 1) do not go by line count: the fold there is **the carrier for the label** (a label cannot be a checkbox) rather than a way to save space, so the two rules are not measuring the same thing.

**Only a Notion page can put a fold between an achievement and its sub-steps.** In a local `*_achievements.md` that truncates `todoSpans`' range — see rule 1, "group labels on sub-checkboxes". A fold in a local md is only for long content that contains no achievement sub-steps (ending tables, bestiary lists).

### [rule-5/tables] Using tables

Where there are many columns and plain text will not align, an HTML `<table>` may be used inside a `<details>` or in the body. Prefer a checkbox list wherever one says it clearly.

### [rule-5/strikethrough] Using strikethrough

`~~text~~` may mark content that is obsolete or already unlocked. Do not overuse it.

---

## [rule-6] Rule 6: mixing languages

- **A Chinese guide**: where the game has no official Chinese, keep the achievement name in English and write the description and notes in Chinese; where it does, use the Chinese name.
- **An English guide**: use the official English name; where a game ships only a Chinese name, keep that name as it stands rather than translating it — a translated name matches nothing.
- Terms of art (build, boss, DLC, NPC) stay in English in either language and are not forced into translation.
- Where the achievement name is already in the guide's own language, the other name is not added.

The guide's language follows the interface language and is recorded in `guides.lang`; see `docs/ai-guide-writing.md`.

---

## [rule-7] Rule 7: do not mention where the data came from

The body of a guide never explains that ticked state comes from Steam's real unlock data, or anything of that kind.

---

## [rule-8] Rule 8: preparation before writing

### [8.0] 8.0 Decide the backend first — Notion by default

**As long as Notion is connected** (`config.json` holds a `notion.token`), a new guide is **created in Notion's Overview database** rather than defaulting to a local `guides/*.md`. Unless told otherwise:

- set `Status` to **`Not started`**. That property records the **game's** progress, not whether the guide has been written (several games marked Done in the database have no guide yet)
- set the page **icon** to the game's image. The reliable source is `img_icon_url` from `GetOwnedGames` (a hash), assembled into
  `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/<appid>/<hash>.jpg` — do not guess CDN paths, and HEAD the URL first to confirm 200 plus `image/*`, or all you get is a broken icon
- once the page exists, run `node tracker.js guides --notion` to register it, then **fetch the page again** to verify (end of rule 9)

Why: the Overview database is where guides live (getting on for a hundred pages; only two early files are local). **One appid can have only one backend**, so writing a local md first means deleting it and rewriting it as a Notion page — a wasted trip.

### [8.1] 8.1 Establish the achievement list and the unlock state

1. Read the `achievements` table for the game's full list of names, then take the real unlock state from `SteamClient.fetchPlayerAchievements(appid)` and join the two on `api_name` (the commands are in the `steam-guide-sync` skill)
2. Where the achievements table has no rows for this appid, it reports that `syncAchievementSchema` has to run first
3. Use that data to fill the `[x]`/`[ ]` state — it is the only authoritative source, and it is never guessed from memory

### [8.2] 8.2 Establish the categories

- start from the game's own in-game achievement categories (visible in the Steam client)
- where there is no clear division, judge by the game's mechanics
- TrueAchievements and Steam community guides are worth consulting for how they divide it

### [8.3] 8.3 Gather material

- Steam community guides, in Chinese and English
- TrueAchievements / PlayStationTrophies
- wikis (Fandom and others)
- Chinese guide sites (3DM, Gamersky, 18183, doyo.cn, dvg.cn)
- Bilibili video guides, particularly suited to collectible achievements
- NGA and Tieba community discussion
- prefer guides with high information density and concrete steps

**Fetching a large wiki page**: `WebFetch` on a large page is easily truncated (observed; most likely the summarising model plus a 15-minute cache). Use the Browser pane's `get_page_text(max_chars=400000)` instead, and where the content approaches or exceeds that ceiling, save it to a file and read it from there rather than expecting one tool call to return all of it.

### [8.4] 8.4 Large games: delegate the matching to a sub-agent

For a game with a great many achievements (100+), the step of matching each Steam achievement to its wiki entry and rewriting it as guide prose is bulky and adds no judgement the main conversation needs. It suits a background sub-agent (sonnet is enough) that reads the full wiki content, matches entry by entry and writes the prose, rather than being done one at a time in the main conversation. **Before it hands anything back, the sub-agent should run the verification at the end of rule 9 on its own output**, particularly whether the ticked state matches the real `achieved` data from 8.1 — do not assume its matching and rewriting came through clean.

---

## [rule-9] Rule 9: writing content with `notion-update-page`

### [9.1] 9.1 Pick the right command

- **Rewriting the whole page** (converting an embedded database into a checkbox list, replacing a guide wholesale): `replace_content`. Where the page holds an embedded database or other blocks to clear, `allow_deleting_content=true` is required or the call refuses.
- **Inserting or appending** (adding the `appid:` line at the top): `insert_content`, with `position={"type":"start"}` for the top and `{"type":"end"}` to append.
- **A targeted replacement** (inserting DLC group headings into an existing list, correcting individual checkboxes, changing a sentence or two): `update_content` with `content_updates`, each giving old_str/new_str for an exact match. Far lower risk than re-transcribing the page — re-transcribing tens of KB carries a much higher chance of a transcription error than inserting at a few group boundaries.

### [9.2] 9.2 Write large content in batches

Where the content approaches the per-call length limit, do not force it into one `replace_content`. Split it into a leading `replace_content` followed by `insert_content` calls, so nothing is truncated.

### [9.3] 9.3 Verification afterwards — a successful call is not a correct page

- **the checkboxes really landed**: fetch the page again and confirm (rule 1 mentions this; this is the full version)
- **the ticked state matches the real data**: check entry by entry against the real `achieved` booleans from 8.1, never against a guess or a wiki's description
- **group headings landed in front of the right achievements**: where grouping was done, fetch again and confirm no heading shifted
- **HTML-like syntax (such as `<details>`) was not escaped**: Notion's API sometimes turns `<`/`>` in the content into the literal text `&lt;`/`&gt;` rather than producing the corresponding block, and only reading the page back reveals it. Never assume what landed is the markdown that was sent
- **content the API cannot preserve is discussed before it is discarded**: a bookmark block, for instance, where the API sometimes exposes only a self-referencing anchor and not the real target URL. Where a block is going to be replaced and cannot be recovered, say so before the operation rather than discovering it afterwards

---

## [rule-10] Rule 10: the self-check list

1. [ ] Is every achievement its own `- [x]` / `- [ ]` checkbox line?
2. [ ] Are there no merged lines (`[x] A / [x] B / [x] C`)?
3. [ ] Is no group of achievements written as a prose summary?
4. [ ] Does the page open with `appid: NNNNNN` alone — no title, statistics, spoiler warning or note on sources?
5. [ ] Do the section headings carry no counts?
6. [ ] Is there no closing "notes" / "sources" / "summary" section?
7. [ ] Is there nothing about where the ticked state came from?
8. [ ] Are there no documentation-style asides — "no translation yet", "presumably", "to be confirmed"?
9. [ ] Are long lists folded into `<details><summary>`? Are the group labels (prerequisite / steps / careful) and the warning entries kept off checkboxes?
       Notion pages use `<details>`; local md uses a `- [ ]` label line.
       Does each fold hold supporting material rather than the achievements themselves — is every section's achievements visible the moment it is opened?
10. [ ] Are there no pointless achievement-popup screenshots?
11. [ ] Where the source guide had map or UI screenshots, are there equivalent images?
12. [ ] Was the page fetched again afterwards to confirm the checkboxes landed?
13. [ ] Do the nested sub-checkboxes meet all three conditions (an identity, a method to state, every line required)? Does deleting them cost the guide information?
       And check it from the other side: **has a complete-collection achievement been written as one vague sentence?** Where each item is obtained a different way, it is one line per item, folded if long, rather than concatenated into something like "unlocked gradually as you progress", which says nothing.
14. [ ] Are conflicting achievements marked with the mutual-exclusion warning?
15. [ ] Are achievements requiring a background or perk marked with their prerequisite?
16. [ ] Was the ticked state checked entry by entry against the real `achieved` data, rather than judged from memory or from a wiki description?
17. [ ] Where HTML-like syntax such as `<details>` was used, was the page fetched again to confirm it was not escaped into literal text?
18. [ ] Where the original page held content the API cannot preserve (a bookmark block), was the user told?
