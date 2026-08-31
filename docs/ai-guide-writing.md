# AI guide generation

This document records **why it is the way it is** and **which approaches have already been excluded**. Read it before changing anything and do not re-derive — every line below was paid for.

Prompt text and UI strings are quoted verbatim in Chinese, because that is what the code actually sends and shows.

## What this solves

Writing a guide used to require a Claude Code session: pull the Steam achievement data, read wikis, digest and rewrite entry by entry, write it into Notion, then read it back to verify (the full procedure is in `.claude/skills/achievement-guide-writing/SKILL.md`). The goal is to let **the people using this app** generate guides with their own AI API key, without going through a conversation.

## Settled decisions

| | Decision | Why |
|---|---|---|
| Audience | Packaged into the app, for users | Not a CLI tool for the author alone |
| Web research | **Use the vendor's own server-side search** | Building "search API + page fetch + HTML→text" is the single biggest piece of the whole design; with a vendor's own tools that piece drops to zero |
| Providers | "Has server-side search" is a **hard admission requirement** | Letting one without search in makes quality depend on which vendor the user picked, and the user cannot see that difference |
| Quality target | A finished product, not a first draft | Achieved through machine gates, not by "making the model write better" |
| Scale | **Written in shards, ceiling 500** | The real constraint is not that the list doesn't fit (the list is small), it's that **the prose doesn't** — 400 achievements is roughly 60,000 characters, past every vendor's single-response ceiling, and exceeding it doesn't error: it just looks like "every achievement in the second half is missing a checkbox" |
| Output backend | **Notion when connected; `--local` to opt out** | The user's hand-written guides are all in Notion, so landing machine-written ones elsewhere splits one set of notes across two places. The converter only has to cover the block types **we generate**, not general markdown |
| Landing gate | **Split by reversibility, not by backend**: new = written automatically once the machine gates pass; overwrite = requires human confirmation | Adding a backend needs no rule rewrite — a new backend naturally lands in the "irreversible" tier |
| Spending | **Only a pre-run confirmation plus a token count afterwards** — no amounts, no caps | A cap needs an amount it cannot estimate honestly. There is no trustworthy price for DeepSeek or Gemini, and **how server-side search is billed has never been measured, start to finish**. **An untrustworthy cap is worse than no cap: it looks like protection while protecting nothing.** To bring it back, go measure search billing first |
| Checked state | **The model only ever writes `- [ ]`; we tick mechanically from the database afterwards** | Turns "checked state must equal real `achieved`" from something to be checked into something structurally impossible to violate |
| Unlock state | **Not fed to the model** | A corollary of the previous row. It also fits SKILL.md 3.1: a guide is a record of *how the game was played*, not a list of what's left |
| Failing the gate | At most 3 rewrite rounds; still failing ⇒ **keep it as a draft** and report which entries failed | Discarding burns the money and the time and leaves nothing; and "which entry failed" carries information |
| Overwriting | Allowed, but requires a backup + diff preview + human confirmation | |
| Rewrite granularity | Beyond whole-guide there is **`--only`, rewriting just the named entries** | A full rewrite has two costs unrelated to writing quality: **every hand-edited passage and every hand-ticked sub-step box is voided**, and the parts that were already right get re-rolled. The criterion is not saving money, it is **preserving what wasn't named** — and that has to be guaranteed by the program (splicing back by line number / block id), never by "telling the model not to touch the rest" |
| Interruption | Completed parts are kept as a draft | The draft is written after every shard, see below |
| Language | **A generated guide follows the interface language**, and changing an existing guide's language is done by switching the interface and pressing 「重写」 | One guide per game, so a separate "generate in English" action would be a second button spending the same money on the same guide. See the section below |

## What is guaranteed and what is not

This is the most important section in the design, and the UI must state it honestly.

**Machine-verifiable (all against real local data):** every achievement has its own checkbox line · no merged lines · checked state equals real `achieved` · **whether the description is copied verbatim** (compared directly against `achievements.description`) · whether same-named achievements quoted their descriptions · the local md carries the `# 游戏名` line · section headings carry no 「共 N 个」 counts · no "data source" note.

**Not machine-verifiable: whether the guide's content is correct.** Whether the steps work, whether the difficulty ratings are right, whether the "easy to miss" flags are true, whether the mutual-exclusion relationships are real — and that is the entire value of a guide.

So what this system guarantees is **"the format and the data are correct"**, not **"the guide is correct"**. The UI must say the content is unverified. Forcing the model to supply source URLs for spot-checking: **decided against.**

**Why this has to be taken seriously:** `audit` measured a batch of already-ticked boxes that could not be reverse-resolved, and every cause was the guide having paraphrased the official description — which is exactly what an LLM does by default when generating unsupervised. Without this gate the feature would be steadily poisoning the matching system, and those matching rules took three rounds of false positives to get right.

## Architecture

```
lib/ai.js         Provider abstraction: request assembly, the tool-call loop, usage accounting.
                  Every vendor differs in request structure, tool declaration format, response
                  body and error codes; this layer exists to keep those differences inside it
lib/ai-anthropic.js  Anthropic's request format, block assembly, pause_turn continuation
lib/ai-gemini.js     Gemini's request format, chunk assembly, grounding
lib/guidegen.js   Orchestration: fetch achievement data → research + write → mechanical ticking →
                  hand to the linter → feed specific errors back and rewrite (max 3 rounds) → land
lib/guidepatch.js Partial rewrite (`--only`). **A separate path, not a branch in generateGuide**
lib/guidelint.js  The linter, reusing what guides.js / markdown.js already have rather than rewriting it
```

Long server-side jobs copy `startBackgroundSync` in `lib/server.js`: **one function, one concurrency guard, progress by polling.** Do not build a second state machine for this — the lesson from the sync side is that two entry points means two concurrency guards.

### Drafts must never go into `guides/`

`syncGuidesFromMarkdown` scans `guides/*.md` and **registers any file carrying an `appid:` line into the guides table**. A draft that hasn't passed the gate would be registered automatically, and then `checkbox-sync` would start ticking the user's boxes from an unverified guide — precisely what this design forbids.

Drafts go in `guides/.drafts/` and backups in `guides/.backups/`. Both are safe because `syncGuidesFromMarkdown` uses a **non-recursive** `readdirSync` and only accepts `.md`, so subdirectories are outside its view. The test runs the real discovery function over the draft directory and asserts `files === 0` — the single most important assertion in `guidegen.test.js`.

## Web research

### Two tools, and the division of labour is the answer

| Tool | Returns | Key parameters |
|---|---|---|
| `web_search_20260209` | `web_search_tool_result` → a **result list** (summary form) | `max_uses`, `allowed_domains`/`blocked_domains`, `user_location` |
| `web_fetch_20260209` | `web_fetch_tool_result` → a **`document` block, the page's full text** | `max_uses`, `allowed_domains`, `citations`, `max_content_tokens` |

"Summaries or full text" is a false choice: search finds the candidates, **`web_fetch` brings the full text back**, and `max_content_tokens` is the knob for how much.

Three hard constraints:

1. **`web_fetch` can only fetch URLs that already appeared in the conversation.** Search has to surface the URL first. This is a hard ordering constraint on the orchestration, not an implementation detail.
2. **`allowed_domains` is a hard filter only** — there is no soft preference. To bias toward Chinese guide sites, say so in the prompt.
3. **Never declare `code_execution` separately again.** The `_20260209` versions already run code internally for dynamic filtering; adding one produces two execution environments and confuses the model. This is the bug you write if you don't read the docs.

### Two defaults are deliberately conservative

- **`allowedDomains` defaults to empty (unrestricted).** "How well Chinese guide sites are actually covered in the search index" has never been measured, and locking search to a handful of sites by default trades quality for an unmeasured assumption. Fill the array if a hard lock is genuinely needed.
- **`maxFetchTokens` defaults to 50000.** SKILL.md 8.3 wants something on the order of `get_page_text(400000)`, but `max_content_tokens`'s real ceiling has not been verified. Raising it is a knob, not a code change.

`fallbacks` defaults **on** (the server retries the same request with a different model when the classifier refuses). The cost is one extra beta header; if an account doesn't recognise it the whole request 400s — which is why the 400 message says where to turn it off.

### Not built yet: fetching full page text

Compatibility endpoints have no `web_fetch`, so the model **only ever sees search-result summaries, start to finish**. A raw fetch was probed once: 游民星空 and 3DM return usable text, **Fandom wikis 403 outright**, and Steam Community needs a valid URL; on top of that raw fetching drags in a lot of navigation junk, roughly half signal. Wiring it in properly would need a **client-side tool loop** in the provider layer (only server-side tools are supported today) — which is exactly the piece this design deliberately avoided.

## Hard constraints at the request layer

**Streaming is mandatory, and not for performance.** `max_tokens` is the **combined** ceiling for thinking plus prose, and reasoning models think by default; a 60-achievement guide with web research will hit the HTTP timeout (undici's default 5 minutes) before it hits the token ceiling on a non-streaming request. So this layer parses SSE itself.

**The server-side tool loop is not client-side tool execution.** `web_search` / `web_fetch` run entirely on the vendor's side. The loop exists because the server's sampling loop has an iteration cap (10 by default); hitting it returns `stop_reason: 'pause_turn'`, and you resume by appending the assistant turn back into `messages` **verbatim**. **Never add a "continue" message** — the server resumes off the trailing `server_tool_use` block, and an extra user turn interrupts it. Earlier rounds' content must also be concatenated back into what the caller receives, or all the research is silently lost.

**Several parameters are a 400 on the official endpoint, not ignored**: `temperature`, `top_p`, `top_k`, `thinking.budget_tokens`. Depth can only be controlled with `output_config.effort`. A trailing assistant prefill is likewise a 400.

### A parameter that lies: `thinking.budget_tokens`

On the official endpoint it is a 400. On DeepSeek's `/anthropic` it is **worse than a 400**: HTTP 200, and it moves in the opposite direction — asking for 2000 produced 49,653 characters of thinking, asking for 8000 produced 62,107, while **omitting the field entirely produced 38,196**. A parameter whose entire purpose is to impose a ceiling raises the floor at exactly the endpoint where you'd most want it, and doesn't error.

`buildBody` never sends it, and `ai.test.js` pins that on both endpoint shapes. Same family as Notion silently swallowing a status property's `groups`: **a 200 does not mean it did what you asked.**

### One vendor, two endpoints, different capabilities

| Endpoint | Server-side search | web_fetch |
|---|---|---|
| `api.deepseek.com/chat/completions` (OpenAI-compatible) | ❌ | ❌ |
| `api.deepseek.com/anthropic` (Anthropic-compatible) | ✅ | ❌ rejected |

**Capability is a per-endpoint measured fact and cannot be inferred from a company name or a baseUrl.** So only endpoints that were actually probed are listed, and anything unmeasured is sent none of those extension fields — sending them a parameter that might be rejected trades someone else's availability for our convenience.

Both accompanying switches were taught by 400s: `ai.webFetch` (not sent on compatibility endpoints by default — they reject it and the whole request dies), and independent switches for `thinking` / `output_config` / `fallbacks`. **Those three must be separately sendable**: with the same `effort: low`, adding `thinking: {type:'adaptive'}` goes from 43 s to 87 s and doubles the thinking — adaptive overrides effort. Bundled behind one switch, the only knob that works either cannot be sent or gets overridden by its companion.

## Five failures that look like success

All of them are HTTP 200, and missing one branch passes a bad result downstream, so they are collected in `checkResult()`:

| Case | On the surface | Actually |
|---|---|---|
| `stop_reason: 'refusal'` | 200 | The safety classifier refused; content is empty or half-written |
| `stop_reason: 'max_tokens'` | 200, **with prose** | The prose is cut in half — a truncated guide is worse than a failed run |
| Normal stop reason but **not one `text` block** | 200, no tool error, normal stop reason | This round wrote nothing. The hardest to diagnose, because all three surface signals look fine |
| **The vendor's own control tokens** in the prose | 200, normal stop reason, prose **non-empty** | The prose is **cut off** at that point. Looks even more normal than the previous row |
| Tool error | 200, `stop_reason: 'end_turn'` | The result block contains an error object |

**The two tools' "success" shapes differ**: `web_search` succeeds with an **array**, `web_fetch` with an **object** (`{type:'web_fetch_result'}`). Taking either as the general rule breaks in both directions — using `Array.isArray` as the success test records every **successful** fetch as an error, and since `web_fetch` only defaults on at the official endpoint, that bug hides all the way until a user's first run with an official key. Both call sites (validation and progress events) must share `toolResultError()`, or the same bug exists in two copies.

### Severity has to be graded; treating them alike is wrong in both directions

- **Search failure ⇒ the round is unusable.** Search is the entry point to research; without it the model is writing from memory — precisely the invisible quality gap the `canSearch` admission rule exists to prevent.
- **Fetch failure ⇒ reported, but not blocking.** `web_fetch` is per-URL: `url_not_allowed` (any URL the model constructs itself trips this) and `url_not_accessible` (404 / anti-bot / timeout, routine on Chinese guide sites) appear a few times in any normal research session. Ten pages searched with two fetches failed is enough material; voiding the round for that treats the normal case as a fault.

Not blocking ≠ silent: they go into `warnings`, reach the user through progress events, and `ai-check` lists each one marked as not affecting the round.

### The control-token detector is deliberately narrow

One false positive wastes a paid round. Guide prose legitimately contains `<br>`, `<details>`, `<summary>`, `<table>` and `<span underline="true">`, so it matches only three shapes that cannot collide:

| Shape | Whose |
|---|---|
| A fullwidth pipe `｜` (U+FF5C) inside angle brackets | DeepSeek (`<｜tool▁calls▁begin｜>`) |
| `<\|…\|>` | Llama / OpenAI (`<\|im_start\|>`) |
| The closing forms `</invoke>` `</tool_calls>` `</parameter>` | Generic |

**Opening tags are deliberately not matched** (`<function_calls …>` and friends): they look too much like real HTML. Missing a novel variant re-surfaces as "missing checkbox", which is a far cheaper direction.

When it fires, **you cannot just strip the markers and carry on**. The prose is **truncated**, not merely dirty: stripping yields a guide that looks complete and is short a section, and this project's bias is consistently "a reported failure beats a silent omission".

## A three-rung ladder for a shard that won't write

**Ask again as-is → split in half → record it and carry on.** Each rung treats a different illness, and the order cannot change.

**Why retry afterwards rather than compute the size up front.** What fills a single request is thinking plus prose. Prose can be estimated (~150 characters per achievement); thinking cannot — it varies with how obscure the game is, with the model and with the endpoint, and on compatibility endpoints the parameter that would cap it cannot even be sent. Any shard size computed before the run is predicting that term, whereas **a truncation is a measured fact** that says outright this shard crossed the line. **Report what was measured, not what was inferred.**

### Rung 1: ask again as-is

"Not one `text` block" is the only genuinely **transient** failure on this path: the request was fine, the shard length was fine, the research happened, and this one response just carried no prose. Asking again identically is likely to work and costs one request; not asking costs the whole run and a dozen wasted web searches.

`EMPTY_RETRIES` = 1, not more: a second empty is not a hiccup, and the right move is to change technique rather than keep hitting the same wall.

**A second empty is treated as a length problem and split in half.** This step is a guess, but a reasoned one: on compatibility endpoints we can neither send the parameter that caps thinking **nor assume the endpoint honestly reports "the budget was eaten by thinking" as `max_tokens`** — `api.deepseek.com/anthropic` is somebody else's implementation of the Messages API, and stop-reason fidelity is not ours to rely on. Guessing wrong costs one request. At the floor the error code is rewritten to `chunk-too-small`, with `err.detail.was` preserving the pre-rewrite code — "was truncated" and "produced nothing" carry very different weight for the advice "try a different model".

**"No prose" has to be diagnosable.** The message carries the raw stop reason, the output token count, and a per-type tally of the response blocks, because those three point at completely different responses:

| Response | What it means | What to do |
|---|---|---|
| `thinking×1`, 30k tokens | Thinking ate the budget — the same thing as truncation | Split smaller |
| No blocks at all, 0 tokens | A one-off hiccup | Ask again as-is |
| `server_tool_use×2`, no text | Searched but never wrote | Look at the prompt / search budget |

Saying only "the model produced no prose" leaves every occurrence to guesswork, and each guess costs the user minutes and a pile of tokens to test.

### Rung 2: split in half

On a truncation, split **this shard** in two and re-ask only the halves, until it fits or reaches 5 achievements (`MIN_CHUNK`). Each split at least halves, so it necessarily terminates. All three boundaries have reasons:

- **`session.dropLastTurn()` before re-asking is a precondition.** `ask` pushes the assistant turn before judging the result, so the unusable half-draft is already in the context, and the shard prompt says 「不要重复前面已经写过的成就」 — leave it there and the model skips the achievements it half-wrote. **The output looks completely normal, it just has entries missing.** A failure is reported; missing entries are not.
- **Refusal, RECITATION and search errors get no rungs at all.** None is a length problem, splitting hits the same wall, and each has a completely different correct response. `checkResult` returns a `code` alongside the message for this: callers need to distinguish "is this failure recoverable", and using human-readable prose as an interface means a reworded sentence silently breaks it.
- **Only round 1 splits.** Later rounds are targeted rewrites keyed to `lint.findings`, and the indices are bound to those findings, so changing the shard count mid-flight invalidates the mapping. `chunkFloorAdvice` therefore **does not rewrite the error code** outside round 1.

When it still fails at the floor, the message deliberately **does not suggest raising `ai.maxTokens`**: prose this short still overflowing means thinking is what ate the budget, and raising it only lets it think longer. That message must also not print `r.usage.outputTokens` — that is the **whole round's** output accumulated by `addUsage` across pause_turns, can be far larger than a single request's ceiling, and reads as though the ceiling were 61445.

### Rung 3: one shard is voided, the whole guide is not

Once the options are exhausted, the shard is recorded in `chunkFailures` and **round 1 keeps writing the remaining shards**. Discarding the whole run buys nothing, and the missing shard has a ready-made recovery path: all its achievements are reported by the linter as `missing-checkbox` (carrying `apiName`), so `chunksNeedingRewrite` picks exactly that shard and the next round re-asks only it. The re-ask uses `buildChunkMessage` ("write this shard") rather than `buildChunkFeedback` — a shard that was never written is missing the shard itself, not corrections.

Leniency needs boundaries, and there are three:

- **Grade the failure first: `CHUNK_LOCAL`.** Only the verdicts `checkResult` can return are about **this shard** (all HTTP 200). A 401, a dead network, or exhausted `maxContinuations` is a **global** fault and rethrows immediately — carrying on means hitting the same wall once per remaining shard, and the real cause gets buried under a list of "shard N didn't come back" while its own terminal hint never reaches `tracker.js`'s top-level catch.
- **If every shard fails in round 1, throw the first real cause** rather than linting an empty draft into "all 197 achievements are missing a checkbox" and then paying for two more rounds of it. Report the cause, not the symptom.
- **`ok` requires `chunkFailures` to be empty.** Once we know a shard is missing, it never lands — even if the linter were to wave it through some day.

Both the CLI and the Dashboard print failed shards **above** the blocking list. The Dashboard side also gained a `warnings` array on the generation state: `note` is "what is happening now" and the next progress event overwrites it three seconds later, while "shard 3 didn't come back" has to persist until the result arrives — the same design as `syncState.bumped`.

### The draft is written after every shard

`writeFileSync(draftPath, …)` must be **inside** the shard loop. Placed after it, any mid-loop throw discards the completed shards along with their web research — which is exactly where "the draft survives in `.drafts/` anyway" stops being true for the failure that actually happens.

Writing per shard is negligible next to a two-to-three-minute network call. The write sits **outside** the `try`: a disk error is our fault, not "the model didn't write this shard", and must not be fed into the retry ladder.

Note that the end-of-round `writeDraft()` overwrites what most tests observe, so **the per-shard write is only observable on a path that aborts the round** — it takes a provider-level exception to pin it.

## Concurrent shards

The shards' contents are disjoint — each shard's prompt names its numbered range and its first and last achievement. Sharing one session made them one chain, so each shard now gets its own, turning round 1 from "the sum of the shards" into "the slowest shard". `ai.concurrency` defaults to 3; set it to 1 for the old sequential behaviour.

The shared session had been buying two things, and both are accounted for after the split:

- **Achievements don't repeat** — that was never down to the session. Each shard is given its own range; this is a structural guarantee.
- **Section headings do repeat** — this one is real, and it is more than "two adjacent shards both wrote `## 主线`". **Two shards each inventing their own taxonomy produce a mess when merged**: the same thing gets two names (「社交与恋爱」 / 「社交与好感」), and the same name appears at different positions in two shards. **「别把小节标题再写一遍」 is actively harmful under concurrency**: it tells a model that cannot see the previous shard to omit a heading only it can write, leaving those entries dangling under the previous shard's section. Hence the pass described below.

## Already-unlocked achievements get a one-line entry

On a **fresh** guide, achievements the player has already unlocked are asked for as `- [ ] **名字** — 官方描述` and nothing else — no research, no method. A guide is something you follow, and the ones already done don't need a method: the name, the official description and a tickable box are all of them that still gets used.

What this saves is not characters but **their web research and thinking** — which is the only place this feature actually costs money (see the Obra Dinn A/B in CLAUDE.md: almost none of the 8× time difference sat in length). On a game that is 80% done, only a fifth still has to be written in full.

The decision is in `briefApiNames`, the prompt line in `briefInstruction`, both in `lib/guidegen.js`. The prompt names **the smaller half**: most games are already mostly unlocked, so listing "write these few in full" is far shorter than listing forty to skip, and it reads as exactly the work the model has to do in this shard.

Three guards, each pinned by a test:

- **A fully-unlocked game skips nothing.** What you'd save there is the entire guide, leaving a list of names and official descriptions that the Steam page already has. Someone generating a guide for a 100% game wants precisely the content.
- **An overwrite skips nothing.** The guide already holds prose that was paid for, and "they unlocked it since" is not a reason to delete that text — there is nowhere to get it back. Only a fresh guide writes brief entries.
- **A one-line entry is still a checkbox.** SKILL.md rule-1 forbids merging a group of achieved entries into checkbox-less prose; brief entries keep each `- [ ]` line and simply omit the body. Without that line `checkbox-sync` can never tick it, and the linter reports `missing-checkbox` immediately.

Asking a shard what to write has **exactly one exit** (`chunkMessage`). With the two call sites each passing it separately, the one that forgot the skip-list would not error and would not lose content — that shard's list would just quietly vanish, on the path that is hardest to reach (a whole shard has to fail first).

## Classification: one more pass, after the whole guide is written

**Runs only when the guide was actually sharded** (`chunks.length > 1`). A single-shard guide has no cross-shard consistency problem, and that shard already had the descriptions and rarity in hand, so it classifies better than any after-the-fact pass.

1. **Each shard opens its own headings as before**, and `joinBodies` merges duplicates at the seam during assembly.
2. **After the whole guide is written, ticked and past the gate, ask for a classification** (`buildRegroupPrompt`). This pass has the names, the official descriptions, **and which section each shard put each entry in** — that being the judgement made after the research. It addresses achievements **by number, never by name**: a name has to match to the character (duplicates, punctuation, full/half-width all defeat it), an index does not.
3. **Re-arrange by that mapping** (`regroupByAssignment`). The prose is already written, so this step can genuinely move entries into the right section rather than merely merging same-named headings.

**Why not classify before writing.** That pass only has the achievement *names*, and names are often jokes: in 《马特的寻猫游戏》 「海拉鲁老流氓」 is actually smashing 100 pots, and 「半条命4」 is prying a crate with a crowbar. A names-only pass returns themed labels like 「自然与美食」 or 「囤积狂的自我修养」; adding the descriptions and running it again still lost genuinely important structure like 「难度模式」. **The information was missing, not the prompt** — classification needs "having researched this, what does the player actually do", and that does not exist until the prose does.

### Losslessness is a hard requirement, not best-effort

`regroupByAssignment` has three exit assertions; failing any of them throws and rolls the whole pass back:

1. The multiset of achievement `api_name`s is exactly equal before and after;
2. Every non-heading line of text occurs the same number of times before and after;
3. **No toggle block was emptied.**

The third came out of a real run: the first two count *text* and cannot see *structure*. Tearing a toggle into "an empty shell plus its former contents as loose siblings" loses not one character and passes assertions 1 and 2 — which is exactly how 《破晓传奇》 slipped through.

An achievement the mapping didn't cover **stays in the section it was already in** — not dropped, not swept into a miscellaneous bucket: when the model omits one, "leave it alone" is the only response that cannot invent a new error.

**A section the classification list never mentions stays on its original side of the achievement list.** That pass only lists sections holding achievements, so a pure-prose section (rule 3.5's 「机制速查」) is never mentioned at all; appending everything unmentioned would move a quick-reference meant to be read **before** the list to the very end of the guide, dangling under the last achievement. The test is taken from the original text: the heading appeared before any achievement had been seen ⇒ it goes in front, and stays in front after the re-arrangement. A trailing 「备注」 was at the end before and stays at the end.

**A failure in this pass degrades to "don't re-arrange" and never aborts.** The prose is already written, ticked and past the gate; throwing that away for a cosmetic re-grouping is a bad trade. The degradation must be audible (`regroup-failed`, reported by both the CLI and the Dashboard).

### Same-family clusters: the half a closed list cannot catch

A closed list of section names stops *invented* headings. It does not stop **choosing between two defensible destinations that are both on the list.** Measured on 《马特的寻猫游戏》's four "replace the mascot" achievements: two landed in 「宝石与商店」 (because you buy them in the shop) and two in 「吉祥物替换」. The model was not confused — it genuinely holds that these are two kinds of thing. That is a **defensible but wrong** editorial judgement, a prompt cannot argue it out, and it needs a programmatic rule.

The rule is **the common prefix of the official description** (`lib/guidecluster.js`). Descriptions are not jokes; developers batch-write them from one template: 「将吉祥物替换为一只 X」, 「成为一名新手 X」. Two gates:

- **The prefix must be at least half the mean description length.** Terraria has 22 「Defeat …」 achievements whose early-game and hardmode bosses genuinely belong apart — `Defeat ` doesn't reach half, while 「将吉祥物替换」 does.
- **A cluster is 3–8 entries and at most a quarter of the game.** In a small game 8 entries could be half the guide, and force-merging that flattens the structure.

Measured across the real library: **251 clusters over 151 games, 1.66 per game**, and they read as genuine families (「狩猎5只鹿/狼/鸭」, 「成为一名新手厨师/饮品师/铁匠」). There is also an **absorption pass**, which is not optional: the greedy longest-prefix-first claim orphans a near-miss, and the near-miss is exactly the case this exists for — three of 马特's four write 「替换**为**」 and the fourth writes 「替换**成**」, and the orphan was precisely the one that had been split into a different section.

Clusters go down two roads, **tell the model first, then back it up ourselves**: they go into the prompt because the model can see the prose and picks better than plurality would; and `mergeSplitClusters` merges any still-split cluster into whichever section holds most of it after parsing. **Merging wrongly and splitting wrongly do not cost the same** — putting 「扩建房间/卧室/客厅/卫生间」 together is at worst coarse, splitting them is the bug the user reported — and it only acts on a cluster that is **already** split.

### An achievement must never be hidden inside a collapse

Rule 五 only says "fold content once it reaches 10 lines"; it never said "but never the achievements themselves". Measured on 马特: the whole `## 世界全清` section's 13 achievements were packed into a toggle called 「世界 1~12 全清与通关」. Sync still recognised them (90/90), but that section opens empty in Notion.

`unwrapAchievementToggles` flattens them **before** the re-arrangement (afterwards, assertion 3 would read it as "the regroup tore a toggle open" and roll the whole pass back). Two conditions must both hold, and either alone leaves it untouched: **the toggle is at top level (not indented)**, and **it contains a checkbox that resolves to a real achievement**. Group-label collapses (前置/步骤/注意) are always indented under an achievement, so they fail the first gate and can't be caught by accident. The unwrapped draft is re-linted, and rolled back if it no longer passes.

## Structural guarantees, not checks

1. **Checked state** — the prompt orders `- [ ]` only, and `computeCheckedKeys` fills them from the database afterwards. Unlock state is not fed to the model either.
2. **The `# 游戏名` and `appid:` lines are written by the program**, and any model-written versions are **actively stripped**. Both lines are pure data already in the database; having the model transcribe them adds a chance to get them wrong for nothing, and **one wrong digit in the appid registers the guide against a different game** — with neither side erroring. The prompt says not to write them too, but a structural guarantee cannot rest on the model complying.
3. **Drafts always go to `guides/.drafts/`** — see "Drafts must never go into `guides/`" above.

## Same-named achievements: a shape that makes a guide fail forever

`computeCheckedKeys` skips any achievement whose name collides (it cannot tell which is which, and a missed tick beats a wrong one), so those achievements **stay unticked even when unlocked**, while `checked-mismatch` keeps reporting — three rewrite rounds burned on an error **the model cannot possibly fix** (it isn't allowed to write checkboxes at all).

`unnameableApiNames(defs)` handles it: when neither of an achievement's names is unique in this game, its `checked-mismatch` counts as **expected** and does not block. The exemption must be computed **per name** — a colliding Chinese name with a unique English one still ticks fine (most collisions are Steam single-language localization bugs), and over-exempting hides real defects.

**The same shape has a second exit.** `ambiguous-no-description` requires same-named achievements to quote the description verbatim, but **if Steam's description is itself an empty string there is nothing to quote** — nobody can fix it. A guide with 197/197 coverage can be held at the door by 15 such findings, with all three rounds spent asking the model to copy a description that does not exist.

**The test is: is there any action, by anyone, that would clear this finding?** No ⇒ it belongs in `expected`, reported but not blocking. The fix is **splitting it into two codes**, not adding a boolean field:

| code | Meaning | Blocks? | Fed back to the model? |
|---|---|---|---|
| `ambiguous-no-description` | A description exists, the guide didn't quote it | **Yes** | **Yes** (a rewrite genuinely fixes it) |
| `ambiguous-empty-description` | Steam's description is empty | No (goes to `expected`) | No |

Why a code rather than a boolean: in this project "is this failure recoverable" is dispatched on `code` everywhere (`MODEL_FIXABLE`, `splitFindings`, `CLI_HINTS`), and adding a boolean only this one rule sets means a second mechanism answering the same question — and **the second mechanism not being wired up** is precisely what the original fault was: no production code read that boolean, and the only thing referencing it was a test asserting it had been set.

Two details:

- **This exemption does not consult `unnameable`**, unlike the `checked-mismatch` one. That rule fires for any achievement so it needs the gate; this rule's own precondition already includes the name collision, making it strictly narrower — adding the gate would be a tautology.
- **Not blocking ≠ not mentioning.** Those boxes will **never** be ticked automatically, so the CLI lists the names and the Dashboard's **success** line carries them too (`unsyncable`). Without that, "15 boxes haven't moved in months" reads as the sync being broken. The message uses `d.name_cn || d.name_en` rather than the `byName` key — that key has been through `normalizeText` and displays as `proud player` where Steam says `Proud Player`.

### Only feed back what the model can act on

`checked-mismatch` **never enters the feedback list**. Sending it back asks the model to write `- [x]`, and "the model only writes `- [ ]`, the program ticks from the database" is the foundation of this design. A genuinely non-exempt `checked-mismatch` means *our* ticking is broken — stop and say so, don't ask the model again.

## Landing gates

Split by reversibility, not by backend:

- **A new file** + the machine gates passed ⇒ written automatically. Afterwards it is **read back and verified again** — "the call succeeded ≠ the content is right" is a hole this project has fallen into. Registration then calls **the real discovery logic** (`syncGuidesFromMarkdown`) rather than upserting directly, so two places can't drift on "how is the title taken" and "what happens on a backend conflict".
- **Overwriting an existing guide** ⇒ **refused** by default; `--overwrite` allows it. Even then the order is "be able to roll back before acting": read the old guide → back it up (copy the `.md` locally, store raw block JSON for Notion) → state clearly what will be lost → human confirmation → only then write. **If the backup fails, nothing is written** — the exact opposite of `guidemigrate`, where a failed archive is not a failed migration.
- **On Notion it deletes exactly the blocks in the backup**, never re-reading the page, or something edited in between produces "a deleted block that isn't in the backup".
- **An overwrite writes back to the guide's own backend**, never switching backend along the way.
- **Every refusal reason is given at once in `planGuide()`** (no achievement detail, too many achievements, an existing Notion page, the file exists, Steam can't supply unlock state) — never halfway through, after money has been spent.

**No generation if Steam can't supply unlock state.** A guide with nothing ticked is a wrong guide, and the linter reports it as a pile of `checked-mismatch` that looks like the model got it wrong.

The diff preview comes in two parts: before spending, only the old half can be described (including the one irreversible loss — hand-ticked sub-step boxes revert to unticked); the genuine old-vs-new comparison comes after writing.

### A same-titled Notion page: refuse, don't overwrite

A same-titled page with content is refused; an empty one is treated as "the page to fill"; two same-titled pages are refused. **In an irreversible operation, not doing it is safer than asking** — a confirmation box only guarantees the user clicked, not that they understood what they were agreeing to destroy. `--overwrite` is allowed to exist precisely because it backs up the original first and computes "what will be lost" into the confirmation: **"don't" is upgraded to "you may, but only with a rollback in hand", not to "ask a question".**

## Partial rewrite (`--only`)

`lib/guidescope.js` (selection set / entry location / fault attribution) + `lib/guidepatch.js` (orchestration) + `markdown.js`'s `todoSpans` / `spliceLines`. The entry point is `guide-gen <appid> --only <selector> [--note "…"]`.

**It is not a branch of `generateGuide`, it is a separate path.** `generateGuide` is 500+ lines, almost all of it sharded-concurrency machinery (a session per shard, the three-rung split ladder, failed-shard bookkeeping, the flattened shard-index mapping), and a partial rewrite needs none of it. What the two genuinely share is **the prompt and the gate**, and both are imported.

Four non-obvious trade-offs:

- **The guarantee comes from the program splicing only the entries it asked for**, never from "telling the model not to touch the rest". Anything extra the model returns is reported and discarded — the same move as mechanical ticking replacing "check whether the model wrote `- [x]` correctly". This is the one genuinely important line in the whole design: if the model returns the whole document claiming it only changed three entries, **there is no way to verify it left the rest alone.**
- **A range must eat one line too few rather than one too many** (`todoSpans`). An achievement = itself plus the immediately following, more-deeply-indented lines, stopping at the first non-checkbox line — toggles, tables and section notes are not part of it. Eating one line too many silently deletes text; eating one too few surfaces as a duplicate-entry lint error, which is visible.
- **Problems the old guide already had are not charged to this run** (`classifyFindings`) — the one genuinely new failure mode partial rewrite introduces. In a full rewrite every finding belongs to it; in a partial rewrite, naming 3 entries while entry 40 has been missing its description for months means blocking a correct change over a problem the user did not ask to fix and we were not authorised to touch. Two criteria: the finding is in the selection set, or it was not there before. **But "not blocking" is never "not mentioning".**
- **Notion is patched block by block, not by deleting the page and rewriting it.** The latter destroys everything the converter cannot represent (images, embeds, sub-pages, hand-made tables), and `unconverted`'s existence is an admission that there is a batch of those. A "partial rewrite" that rewrites the whole page is precisely the bug this feature exists to fix. Surviving block ids also preserve links pointing at individual achievements.

The preflight **asks the opposite question**: a full rewrite's preflight says "what you will lose", a partial rewrite's says "what stays" (how many boxes are untouched, how many hand-ticks are preserved). Hence `patchPreflight` rather than a parameter on `overwritePreflight` — one wording serving two questions comes out wrong on both sides.

**Mechanical ticking must run before validation, and the computed set must be passed to the landing.** `applyPatchToTodos` marks every rewritten achievement `checked: false` (correct — what the model returns is always `- [ ]`), while `lintGuide` runs before landing and sees that unticked version — so any **unlocked** achievement reports `checked-mismatch`, which is not in `MODEL_FIXABLE`, and it throws on the spot. **The consequence is that this path is unusable for any unlocked achievement.** The reverse is equally fatal: the landing must not recompute, because `computeCheckedKeys` skips entries that are already ticked, so recomputing over the ticked version yields an empty set and the Notion path would then **untick** the boxes it just ticked, using `checked: false`.

### The Dashboard entry point

In the ♻ 重写 confirmation, the scope is an either/or — 「整篇」 or 「自选」. 自选 expands a list of the guide's achievements grouped by section (`pickableEntries`, delivered by `previewGuidePatch`), with two **filters** at the top (rare / locked, both pressed = intersection), a 「全选」 beside the count — **which takes whatever is currently displayed** — and a 「清空」. The filters only change what is shown and never touch the selection, so a pressed state means exactly "I pressed it". **What goes out is always a list of named `api_name`s**, taking the backend `resolveScope`'s explicit-list branch — the UI needs no selector kinds of its own, and same-named achievements can't be picked by name anyway.

Two things deliberately not built into the UI:

- **The computed selectors are not offered as scope options.** `rare` / `locked` / `section` are selectors on the CLI and **filters** in the UI, because the properties **overlap** (the one locked achievement also happens to be rare): as "select a batch" toggles you get "nobody pressed it and it lit up by itself", and as add-only actions they can only express unions, never intersections. Filters have neither problem, and "both pressed = AND" comes for free.
- **Natural language → selection set** — the one step where a misparse is only discovered after paying, so it comes after all the computed selectors work. The existing ones cover the overwhelming majority of real cases and need no model call at all.

## The provider layer

### Hard admission requirement: server-side search

One option with a free tier is far more useful than a second paid one — the goal is "let the people using this app use their own key", and a provider with no free allowance blocks both the user and our own verification. Gemini's Google Search grounding *is* server-side search, so the requirement was not relaxed.

### Make the uncertain parts runtime-answerable

`lib/ai-gemini.js` was written without access to the official docs, and the response was not to bet on memory:

- **The model name is configurable**, and `node tracker.js ai-check --models` asks the API for the list directly. A wrong guess needs no code change.
- **Tool declarations are configurable** (`ai.geminiTools`). A renamed tool, or one the free tier won't allow, is also a config change.
- **The thinking budget isn't sent at all unless configured** — sending a field that might not be accepted is more error-prone than not sending it.
- **Whether search actually happened is read off the response, not the docs.** `groundingMetadata.webSearchQueries` holds the queries the model really issued; declaring the tool and getting none produces a dedicated warning line from `ai-check`. **That is far more reliable than reading a pricing page that may be out of date.**

Error messages follow the same idea: a 404 points at `--models`, a tool-related 400 points at `ai.geminiTools`, and a 429 spells out that the free tier has both a per-minute and a per-day ceiling.

**There are two kinds of 429, and the only difference in the message is the words `limit: 0`.** `limit: 0` does not mean "used up", it means this model is not in the free tier at all and will never recover at the daily reset — backing off as though it were a retryable 429 is waiting for nothing. The default model uses an **alias** (`gemini-flash-latest`) rather than a pinned version: version numbers inevitably expire while Google maintains the alias; the cost is that behaviour can change quietly, so pin a specific version when you need reproducibility.

### A failure mode Anthropic doesn't have

`finishReason: 'RECITATION'` — the model blocked for reproducing large amounts of copyrighted content. **Guide writing is exactly the high-risk case**: we explicitly require verbatim copying of official descriptions and ask it to read wikis. So it gets its own class (`stopReason: 'recitation'`) and an actionable message rather than being lumped in with ordinary refusals. That message says explicitly: **do not relax "copy the official description verbatim" in order to dodge this limit** — that rule is the foundation of the entire matching system.

### The vocabulary is unified at the provider boundary

- **`stopReason` is translated into one set** (`end_turn` / `max_tokens` / `refusal` / `recitation` / `other`), with the original kept in `rawStopReason`. **Anything unrecognised falls to `other` and is judged unusable** — defaulting to success means that when a vendor adds a new terminal state, failed generations start looking like successes.
- **Progress events are normalised too** (`text` / `tool` / `tool-result` / `search`). The CLI's live output and `guidegen`'s progress bar therefore know no vendor's raw format, and adding a third provider needs no display-code change.
- Web tool declarations are a provider method, `provider.webTools()`, not a module-level function — the shapes differ completely per vendor and the orchestration layer should not know them.

### Accounting

**Overwrite within a message, accumulate across messages.** Both `message_start` and `message_delta` report "the cumulative total for this message so far", so adding them double-counts output tokens; whereas a pause_turn continuation and each feedback rewrite round are separate messages, which *is* when to add. The accounting is only correct when both halves are right, and getting half of it wrong errors nowhere — it just keeps the reported cost permanently too high.

**Only tokens and request counts are reported, never an amount.** Those are hard numbers the API returned, and the only thing that reconciles against a bill. `thoughtsTokenCount` is folded into `outputTokens` (on the grounds that thinking bills as output, consistent with Anthropic) — **that is an inference, not something verified.**

## Quality: what can be measured and what can't

### The difficulty signal: Steam's global unlock rate

`GetGlobalAchievementPercentagesForApp`, **no API key required**, returns each achievement's global unlock rate. Within one game the hardest and easiest can differ by tens of times.

Without that signal the model can't tell which entries are hard from the name and description alone and spreads its effort evenly. Each entry is now tagged `🔴 全球仅 1.1% —— 这类要写深` / `⚪ 64.5% —— 一两句带过`, with an explicit instruction to allocate effort accordingly. **The effect shows up in what gets searched**: the queries go from one generic "全成就攻略" to specific questions aimed at the hard achievements.

### Raising the budget does nothing; `effort` is the knob

`maxSearches` 6 → 30 and `maxTokens` 16000 → 32000: output tokens +79%, while **the guide's actual character count went up 7%**, and the mean note length on the hardest entries did not move at all. Almost all the extra tokens went into thinking. **A budget is a ceiling, and the thinking was never hitting it** — raising it naturally buys nothing.

What actually decides how long it thinks is `output_config.effort`. The same 10-achievement shard, back to back:

| Sent | Wall clock | Thinking | Searches | Prose/achievement |
|---|---|---|---|---|
| Nothing | 337 s | 145,955 chars | 8 | 255 chars |
| `effort: medium` | 219 s | 94,104 chars | 6 | 275 chars |
| `effort: low` | **43 s** | 15,523 chars | 2 | 211 chars |
| `thinking: disabled` | 6 s | 0 | **0** | 117 chars |

**`thinking: disabled` is not "a faster high".** It turns off web search along with it, i.e. the model writes the guide from memory — precisely the invisible quality gap the `canSearch` admission rule exists to prevent. It stays configurable, but it should never appear in any recommended tier.

**Why lowering effort is allowed.** Because the cost is visible: thinking volume, search count and characters-per-achievement all move together, and `searchQueries` ("can search ≠ did search") is already printed on both the CLI and the Dashboard every run. Lowering effort is not a silent degradation, it is a trade-off the user reads numbers for on every generation — quite unlike `thinking: disabled`, which zeroes search and says nothing.

### What effort trades away is **breadth**, not depth

The same game, the same prompt, only effort changed, run back to back, with both texts read by **someone who has finished the game**:

| Tier | Template sentences | Total prose | Hardest 5 | Searches | Wall clock |
|---|---|---|---|---|---|
| `high` | 0 | 1643 | 856 | 5 | 280 s |
| `medium` | 0 | 2393 | 1061 | 4 | 262 s |
| `low` | **9 / 16** | 1633 | 1007 | 2 | **35 s** |

**Eight times the speed at nearly identical total prose — every automatically computed number here says "there is no cost".** Weighted by difficulty, the numbers even suggest `low` allocates effort better. **Both readings are wrong. The real difference is only visible by reading the prose: 9 of `low`'s 16 entries are template sentences, and `high` has none.**

```
low :  第 III 章(凶案)全体查证正确即解锁。
       第 IV 章(召唤)全体查证正确即解锁。          ← nine of these, one pattern with the chapter number swapped

high:  召唤    —— 叛变者劫走宝箱、乘救生艇离船的一章,死亡多发生在海上
       邪恶俘虏 —— 本章起海妖登场,死因列表里开始出现「被怪物」类选项
```

Those nine template sentences **need no research at all** — the material is entirely in the achievement list we sent. And that maps directly onto the extra searches: what `high` additionally searched for was "what happens in each chapter", and the product of that search is exactly the nine entries `low` is missing.

So what this knob really controls is: **whether to spend effort understanding the game itself.** It trades away the guide's **breadth**, not the **depth** on the hardest entries.

**The three tiers are not evenly spaced in effect; the cliff is only between `medium` and `low`.** `medium` and `high` are indistinguishable on both axes, by far less than this path's variance. That directly determines the control shape: **three discrete buttons, not a slider** — a slider's shape itself implies even spacing. (With one sample per tier, this cannot say `medium` beats `high`; all it can say is that the non-low tiers are indistinguishable.)

**The default stays `high`.** SKILL.md 3.1 defines a guide as a record of how the game was played, and by that definition nine template sentences are a real loss. `low` is the switch for "I just want the hard parts", not a cheaper default.

### "Character count" is the wrong metric, and this has cost three times

Character count, coverage and warning counts all measure **format and data**. The same change can leave the character count untouched while the author (who has played the game) judges it clearly better — after search improved, **the same 100 characters carry different content**, and a character count cannot see that. The third time was worse: **even rarity-weighted character count still pointed at the wrong conclusion.**

Only one thing surfaces the difference: **read both texts end to end, side by side.** The next time an automatically computable number is tempting for judging "did this change hurt quality", come back and read this section first.

### Absolute timings are not reproducible; ratios are

The same 10-achievement shard, the same prompt, the same model, nothing sent, run three times: **76 s / 174 s / 337 s**, with 18,158 / 38,196 / 145,955 characters of thinking. Identical input, an 8× spread.

So any single number is one draw from a very wide distribution, and extrapolating it linearly produces estimates that differ threefold. **Compare back to back within one batch and report the ratio, never the absolute.** This also answers "why can't the progress bar estimate a finish time": the variance is not in the network, it is in how long the model decides to think each time.

### Sharding solves "can't finish", not "can't go deep"

The model allocates attention across **the whole list**, so one line among 51 is inherently short. Sharding exists to solve **not fitting**: each shard has no independent search budget, and there is no "produce a section plan first, then generate section by section" step. The available "smaller batches write deeper" comparison is **confounded** (different game, different amount of researchable material) and cannot be taken as a conclusion. Verifying it needs the same game and the same configuration, varying only the shard size, comparing characters per note. **Do not claim sharding improved quality before that number exists.**

### Verification scripts have to take the real path

Both of these were hit while measuring quality:

- **100% games have no schema in the library.** `syncAchievementSchema` deliberately skips completed games, and "completed, so you're best placed to judge whether the guide is right" is the same set of games — so an A/B script reading the `achievements` table directly exits immediately. The production path doesn't have this problem: `planGuide` calls `fetchGameSchema` on the spot.
- **A bare single request has none of production's retry ladder**, so judging tiers with one takes measurements on a path more fragile than production.

## The guide's language

A generated guide is written in the interface language (`config.uiLanguage`). The language is resolved **once**, in `planGuide`, and travels on the plan alongside `target` — full generation, partial rewrite and `--dry-run`'s preview all have to send the same prompt, and a caller resolving it for itself is where the three first diverge. The preview exists precisely to show what will be sent.

**There is one builder; the rule text is per-language.** A translation is a different string all the way down, so the two prompts cannot share sentences. What they share is the shape: `PROMPT_SECTIONS` in `lib/guidegen.js` pairs the `##` sections of the two languages in the order they appear, and `test/guidegen.test.js` requires each prompt to carry its own half, in that order, with no heading missing from the table on either side. A section added to one language and forgotten in the other is a failing test rather than an English guide quietly written to a shorter rule set.

### The four rules that genuinely differ

| | |
|---|---|
| The output language | Stated outright rather than left to the surrounding language to imply |
| Which achievement name is preferred | The official English one, with the list putting it first. Where a game ships only a Chinese name, that name is kept rather than translated — a translated name matches nothing, and rule 3 requires the bold name to equal one in the list |
| The two rules about a game having no Chinese name | Gone. In an English guide they have no subject, and a rule with no subject still costs the model attention |
| Citations | Follow whatever source was actually read, rather than naming Bilibili by default |

**The research sources are deliberately not one of them.** They were Chinese-*first*, never Chinese-only: `lib/guidegen.js` already tells the model to search Steam community guides, TrueAchievements and Fandom alongside 游民星空 / 3DM / NGA / B站. For a Chinese-developed game the best guide really is on NGA or Bilibili, and a model that can read it can write English from it. Dropping those sites would make English guides worst exactly where guides are hardest to find.

### Changing an existing guide's language

There is no separate action. One appid has one guide, so a second button beside 「重写」 doing the same work with a different output is two ways to spend the same money on the one thing a game is allowed. Switching the interface and pressing 「重写」 is the whole mechanism — which is why the rewrite dialog's **title** names the language when it differs from the guide being replaced. That dialog has no body, by four rounds of deliberate cutting, so the title is the only place the language can be said.

### `guides.lang` is a display fact

The column feeds exactly two surfaces: the marker in the achievement panel's header, and the wording of that rewrite title. **Nothing about matching reads it.** Stage 1 of `resolveTodoToAchievement` and the `paraphrased-description` lint rule both accept *either* language's description, which was chosen so that a wrong value here costs a marker and never a tick — and it has to be, because the rows that predate the column carry an assumed value rather than a recorded one.

It is written after a **successful** landing only. A failed rewrite leaves the old guide in place, and stamping the new language on at that point would have the panel describe a guide in a language it is not written in.

The marker appears in the achievement panel and nowhere else: that panel is the one place the guide's own text is on screen, so it is the one place the mismatch is about to matter. On the row button it would be a badge on most rows carrying the same word, which stops being information the second time it is seen.

### The density guard is parameterised, not exempted

`test/i18n-boundary.test.js` requires the Chinese prompt to be more than 40% Chinese **and** the English one to be almost free of it. Exempting the English variant instead would leave the one real hole open — a pass that translates both and reports itself fine — because the Chinese prompt would then be English with nothing looking at it. Two assertions pointing in opposite directions cannot both be satisfied by one sweeping translation.

## Explicitly not doing

- **Screenshots** (SKILL.md rule-2) — the model cannot produce reliable in-game screenshots.
- **Cost estimation** — waiting on measured data for search billing.
- **Mandatory source citations** — decided against.
- **Resuming across a process boundary** (Ctrl+C, a crash) — would require persisting the shard boundaries along with the prose, and the session context cannot be reused. With per-shard draft writes, one failure loses at most one shard, so the remaining value is small.
