---
name: steam-achievement-guide-writing
description: Author or rewrite a game's Notion achievement-guide page from Steam + wiki data (e.g. converting an embedded Notion database to a standard checkbox list, or writing a fresh guide for a game that has none). Use whenever the task is "write/redo the achievement guide for <game>".
---

# Writing/rewriting a Notion achievement guide page

Reference implementation: the Crusader Kings III rewrite (188 achievements, embedded-database → checkbox format), done because writing real strategy content per achievement was judged higher-value than teaching the daily-sync script to read embedded Notion databases.

## Steps

1. Pull ground truth: call the [[steam-guide-sync]] endpoint's `getAllAchievementsForGame('<appid>')` to get every achievement's zh/en name, description, and real `achieved` boolean. If it errors saying the game isn't in ACHIEVEMENTS yet, run `syncAchievementSchema` first.
2. Pull external strategy content (e.g. a wiki's achievements page). **Plain `WebFetch` truncates large wiki pages** (observed cutoff, likely a 15-min-cache + summarization-model limit) — instead open the Browser pane and use `get_page_text(max_chars=400000)`, saving to a file if it's near/over that cap.
3. Match each Steam achievement (by English name) to its wiki entry. Condense — don't transcribe — the wiki's strategy/hints into 2-4 sentences per achievement, and carry over the wiki's difficulty rating if it has one. For a large game (100+ achievements) this step is high-volume, low-context-value work: delegate it to a background sub-agent (sonnet is sufficient) that reads the full wiki dump, matches, and writes the guide text, rather than doing it inline in the main conversation.
4. Format each line as: `- [x/ ] 成就中文名：成就描述。**攻略提示**：提示内容（难度：X）` — **name and description joined by a full-width colon "：" on one line, no line break**. This is not cosmetic: `steam_daily_checkbox_sync.gs`'s exact-match title-candidate splitter (see [[steam-daily-checkbox-sync]]) treats a colon within a line as a title/description boundary. Breaking this format silently breaks the daily sync for this page.
5. To replace an old page's content, use `notion-update-page` — `replace_content` (with `allow_deleting_content=true` to actually clear the old embedded database/other blocks) for the bulk rewrite; if the content is large enough to approach the single-call length limit, split it into a `replace_content` + a follow-up `insert_content` continuing where it left off, rather than risking a truncated single call.
6. If the user wants achievements grouped (e.g. by DLC), prefer `update_content`'s `content_updates` (targeted old_str/new_str search-replace to drop a `##` heading in front of each group's first line) over re-transcribing the whole page — far lower risk of a transcription error across tens of KB of content, at the cost of one small edit per group boundary.

## Verification (do this, don't assume the write succeeded correctly)

- Confirm every achievement's checked state matches its real `achieved` value from step 1 — a sub-agent doing the matching/writing should self-check this programmatically before handing back.
- Confirm group boundaries/headings land on the right achievement if grouping was requested.
- Re-fetch the page after any edit that inserts HTML-like syntax (e.g. `<details>`) — Notion's API can round-trip `<`/`>` as literal escaped text (`&lt;`/`&gt;`) instead of the intended block, and the only way to catch that is to read back what actually landed.
- If the source page had content the API can't preserve (e.g. bookmark blocks where the API only exposes a self-referential anchor, not the real target URL), flag this loss to the user before discarding it, not after.
