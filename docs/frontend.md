# Frontend (design record)

The decisions behind `Dashboard.html` and `Setup.html`: **what was tried, why it was reverted, and what must not be proposed again.**

Same genre as [ai-guide-writing.md](ai-guide-writing.md) and [self-update.md](self-update.md) — this records reasons, not usage. CLAUDE.md keeps a one-line rule and a link here; read this before changing the frontend rather than re-deriving it.

Both pages are one big string each: the project has zero dependencies and no build step, so there is no shared stylesheet and no component framework. Many of the constraints below follow directly from that.

**Verification has a hard boundary.** `test/html-smoke.test.js` has no DOM — clicks, focus and the cascade cannot be checked there. It pins referential integrity (every `getElementById` target exists, every CSS type selector has a tag) plus source assertions distilled from shipped bugs. **Do not read its green as "the UI is fine"** — half the defects recorded here were found in a browser.

---

## 1. Design tokens

`:root` holds the whole visual system: a 4-step surface ramp, a 3-level line hierarchy, 3 text levels, the accent, a 4-step progress ramp, the UI font stack, and scales for type / spacing / radius / elevation / motion.

**The same block exists byte-for-byte in `Setup.html`**, and `html-smoke.test.js` compares them declaration by declaration. The failure it prevents is silent in the worst way: **an undefined CSS variable doesn't error**, it makes that one declaration fail and the value quietly falls back to whatever was inherited.

There *is* a shared stylesheet now (`/fonts/noto-sans-sc.css`), and the tokens still are not in it, deliberately: that file is 101 machine-generated `@font-face` rules, and burying the design system inside a vendored asset means the next re-vendor loses it. Duplication plus a parity test remains the right shape.

`--topbar-h` is deliberately **not** in this block: it's a runtime measurement, not a design token. A test pins that too — otherwise the cheapest way to make the parity check pass is to paste a useless `--topbar-h` into Setup, and the block starts collecting non-design junk.

### Lines are alpha, never a fixed hex

The old `--border` was literally the same value as `--panel-alt`, so every border drawn on a hover surface vanished. An alpha white is correct against all four surfaces by construction, not by tuning.

### `--page-pad` exists because the topbar's negative margin has to equal `body`'s padding

Written twice, they drift.

### The three text levels are pinned to WCAG AA, and they are equally spaced on purpose — that's arithmetic, not taste

`--text-3` must clear AA on **all four surfaces**. `#6d7f95` does not: 4.46 on `--bg`, 3.95 on `--surface`, 3.43 on `--surface-2`, **2.94 on `--surface-3`** — while carrying, despite a token comment reading 「占位、禁用、时间戳」, the table headers, the `无成就系统` data value, the guide/rewrite button labels, the 11px achievement descriptions and `#gen-bar`'s warning text. **The warning message was the least readable string on the page.**

The binding constraint is arithmetic and worth writing down: to clear 4.5:1 on `--surface-3` (OKLCH L=0.333) a text colour needs L ≥ 0.698, and `--text` sits at L=0.921 — so **all three levels have to fit inside 0.223 of lightness**. The old ramp stepped 0.192 / 0.139; the new one steps 0.110 / 0.111, which is the only even split that fits.

Hence `--text-2` moved too (`#98a9be` → `#b4c3d5`) even though it already passed. **Raising only `--text-3` is not a smaller version of this fix, it is a broken one** — the third level lands on the AA floor right underneath the second, collapsing their separation from 0.139 to 0.028 and turning three tiers into two.

Values were computed in OKLCH (hue 253.6) and written as hex. **OKLCH is the arithmetic, not a runtime dependency.**

Re-measure with a contrast sweep over the live page rather than trusting these numbers, and re-run it after any surface change — `--surface-3` is what sets the floor, and **darkening it does not help** (at `#222c3b` it becomes contrast 1.00 against `--surface-2`, i.e. the same colour, before it buys enough headroom).

---

## 2. The font

Self-hosted **Noto Sans SC Variable** (OFL-1.1): `assets/fonts/noto-sans-sc.css` + 101 `files/*.woff2` + `LICENSE`, 4.7 MB, served at `/fonts/` by `lib/server.js`.

Vendored from `@fontsource-variable/noto-sans-sc` — **regenerate by re-installing that package and re-copying, not by hand-editing.**

### Why it exists: two measurements, not a preference

**(1) Nobody could say what font the Chinese rendered in.** The old stack was `"Segoe UI", -apple-system, BlinkMacSystemFont, "Noto Sans SC", sans-serif`; measured by canvas ink coverage on the dev machine, the CJK glyphs came from *neither* Microsoft YaHei (different ink curve) *nor* the `Noto Sans SC` named in the stack — it fell through to Chromium's own CJK fallback, which differs per machine, while every font size, letter-spacing and line-height in the page was tuned against whatever that happened to be.

**(2) `600` / `650` / `700` were the same weight in Chinese.** Ink coverage of 成 at 96px: 300→2116, 400→3120, 500→3776, then **600/650/700 all → 4517**. `.wordmark` is 700, `h1` is 650, `.ach-name`/`.badge`/`.reading .value` are 600 — three declared tiers rendering as one. After the swap all three differ (4204 / 4428 / 4601), because the file carries a real `wght` axis of 100–900.

**Beware `document.fonts.check()` when re-testing this** — it returned `true` for MiSans and HarmonyOS Sans SC, both of which were provably absent (ink identical to a font name that does not exist). **Measure ink, not availability.**

### The 101 files are the point, not an accident

Fontsource splits the face by `unicode-range`, so the browser fetches only the subsets whose characters are actually on screen. Measured on the real 312-game library: **24 requests / 1.37 MB, 28.5% of the 4.7 MB**, and `DOMContentLoaded` stayed at 55 ms (was 51).

Served with `Cache-Control: public, max-age=31536000, immutable` — the **one** exception to `sendFile`'s `no-store`, because everything else in this server is edit-and-refresh while a font is immutable and would otherwise re-download ~40 subsets on every open.

**Do not "simplify" this into one big font file**: that trades a lazy 1.37 MB for an eager 4.7 MB.

### The `/fonts/` route

An extension allow-list (`.css` / `.woff2`) **and** a containment check against `assets/fonts` — same reasoning as `resolveGuidePath`, since the path comes from the URL. Both branches were verified against the running server, including that a traversal ending in a *permitted* extension (`/fonts/%2e%2e%2fnope.css`) actually reaches the 403 rather than being caught earlier by the extension test.

### Four silent failure modes, all pinned

A missing `<link>`, a fallback-first `--font-ui`, a missing `.woff2`, and a packaging filter without `assets/**/*` **all render a perfectly normal-looking page** that has quietly reverted to system fonts — i.e. straight back to the two problems above. `html-smoke.test.js` pins all four plus the OFL `LICENSE` (this repo is public). All five assertions were mutation-tested.

The packaging one is worth pinning especially: it breaks **only** the packaged build while `npm start` looks perfect — the same trap as `icon.ico` and `updater.js`.

---

## 3. The wordmark

### Current design (do not revert)

`Steam 成就追踪器` in one `<h1>`, three roles by three means:

- 「Steam」 is the platform — 0.86em, **weight 500**, wide tracking, `--text-3`
- 「成就」 is the keyword — accent colour
- the rest is plain

The body is **weight 800** at 27px.

**800 rather than 900 on purpose:** this wordmark only ever appears at 27px, and 900 starts closing up the strokes of CJK glyphs at that size — it looks better enlarged, which does not count.

**There is no underline, and it should not come back.** The weight contrast already says "this is the title", so a rule under it is the same statement made twice — and a hand-drawn mark matches nothing in a topbar whose icons are all 24-grid regular strokes. `.wm-text` lost `position: relative` with it (that existed solely to anchor the absolutely-positioned rule).

**None of this was possible before the self-hosted font** — the old stack rendered 600/650/700 as one weight in Chinese, so the only way to push 「Steam」 back was to dim it, and dimming is what drove `--text-3` into its contrast failure. Weight and colour now do one job each. **If 「Steam」 ever needs to recede further, use a lighter weight, never a darker colour.**

**`.wm-latin` is `0.86em`, and the number is not the size it looks.** Latin capitals reach cap-height while Han glyphs nearly fill the em box — measured at 0.593 on this font — so 0.86em renders STEAM at about **0.51 of the Chinese ink height**. That compounding is the whole reason the value looks arbitrary: it is chosen for the product, not for the declaration. Below roughly 0.8em the product falls under 0.45 and STEAM stops reading as subordinate and starts reading as a mistake.

**In English the compounding does not apply.** The whole wordmark is Latin there, so it is a plain 0.86-against-1 comparison and the weight gap (500 against 800) carries most of the hierarchy. Any future change has to be looked at in both languages — a value tuned against Han ink alone will be wrong in the one where nothing compounds.

**The two scripts share a baseline — no vertical nudge.** A length `vertical-align` resolves against the element's own font-size, so any lift on `.wm-latin` scales with STEAM and drifts whenever the size changes. Measured on this font at the shipping sizes, ink relative to each own baseline — STEAM (23.22px/500) 18.0 up and 1.0 down, 成就追踪器 (27px/800) 24.0 up and 3.0 down. A shared baseline sets the bottoms flush and leaves the Han taller at the top, which is what a smaller Latin word beside larger Han is supposed to look like. **If the wordmark ever reads as tilted, look for a reintroduced lift before adjusting the size.**

**The word gap is a real character, not a margin.** 成就追踪器 is one uninterrupted phrase and its two spans sit flush; in English the same markup produced 「AchievementTracker」. It is fixed with a `.wm-gap` span holding a non-breaking space, shown only under `:root[lang="en"]`. A margin would have looked right and left the *text* still running the two words together — which is what a screen reader announces and what copying the heading puts on the clipboard.

### Three attempts at a *drawn* wordmark were reverted

The title got dressed up three times and undressed three times; the record is here so nobody spends the day again.

**This does not contradict the section above:** the shipped design changes font *weight*, which redraws nothing. The prohibition is specifically on generating letterforms.

1. **Ink Free** — a Windows handwriting font. Wrong twice over: it is **Latin-only, so it carries no Chinese glyphs at all**, and it ships only on Windows, so every other machine silently fell back.
2. **Hand-authored SVG glyph paths** — produced *wrong characters*, not merely ugly ones: 成 lost its interior, 就 lost 口 and 尤. A Chinese glyph is 8–15 strokes and coordinates written from memory get the structure wrong.
3. **Auto-tracing the font bitmap** (marching squares) then rippling the outline — structure came out right, but the contour chaining broke and `fill-rule: evenodd` over broken loops rendered a field of shards.

A fourth version did work technically — real text with an `feTurbulence`/`feDisplacementMap` ink filter, which keeps glyph correctness with the font and makes only the edges ours — but at 27px the effect is too slight to be worth the machinery, and it was reverted with the rest.

**The durable lesson: glyph correctness belongs to the font.** Anything that redraws CJK letterforms is re-running attempt 2 or 3. Choosing a different weight, size, colour or tracking of a real font is fine and is what the current design does; *generating outlines* is not.

If a distinctive title is ever wanted beyond that, the only realistic routes are an externally-produced asset (a designer or a calligraphy generator hands over an SVG) or the ink filter at a much larger display size.

---

## 4. The topbar

### The frozen top bar

`.topbar` wraps the title and the action row in one `position: sticky` block. Three details are load-bearing:

- The **negative margins** (now `calc(var(--page-pad) * -1)`) cancel `body`'s padding so the bar spans edge to edge — without them the table scrolls through the gutters on either side and it reads as a rendering bug.
- The background must stay **opaque** or the scrolling table shows through. It is a stack — `radial-gradient(…), linear-gradient(…), var(--bg)` — and **`var(--bg)` has to stay last**: in CSS the last layer paints at the bottom, so it is the opaque base holding the two translucent tints up. Drop it and the bar goes see-through; move it first and it covers the tints.
- **`z-index: 100` deliberately sits below the two bottom-anchored floaters** (`#gen-bar` at 9990, `lib/rpc.js`'s sync bar at 9999) — they never overlap it, so competing for layers buys nothing.

That gradient stack is the whole "banner" — **deliberately no image, no glass, no texture**, because the bar is permanently on screen and anything patterned there gets tiring by the third look.

### The bottom edge is a separator, not a progress bar

**An AGCR track there should not come back.** The idea is sound in the abstract (make something already occupying space say something, at no extra height) and wrong in practice, for a reason that belongs to the *data* rather than the drawing:

**AGCR over a several-hundred-game library is close to immovable.** It is a mean over every started game, so finishing a whole game moves it a fraction of a percent — meaning the bar renders as a permanently one-third-full slot. **A progress bar that never visibly advances does not report progress, it reports incompleteness**, and it says so on every single page load.

The number itself was never the problem and is untouched: 平均完成率 still prints in the readout, where a figure that changes slowly reads as a *statistic*. What was deleted is the decision to give that figure the shape of "how far from full", because that shape makes a promise about movement the data cannot keep.

**Before re-proposing any always-on progress indicator here, check how far its number moves in a week.**

The edge is now `border-bottom: 1px solid var(--line-3)` on `.topbar` — a border rather than the old absolutely-positioned child, so `offsetHeight` includes it and `--topbar-h` stays correct for free. The token moved with the meaning: the progress track was `--line-2` (a control surface), and a plain topbar edge is what `--line-3` is defined for (「区块边界 —— 顶栏底边」).

The sync sweep (`.topbar::after`) survives unchanged in purpose but moved to `bottom: -1px`: `bottom` resolves against the *padding* box while the border paints outside it, so at `0` the sweep would float above the separator and the edge would read as two lines during a sync.

`data.avg` in `getDashboardData` went with it — it had no other caller.

---

## 5. Icons

Inline SVG, not emoji. One `<symbol>` sprite at the top of `<body>`, reached through the `icon(name, filled)` helper; 24-unit grid, `stroke-width: 1.75`, `currentColor`.

**Do not reintroduce an emoji anywhere in the UI.** Emoji carry their own colour (CSS `color` cannot touch them), render differently per OS, and do not sit on the text baseline. This project surrendered to that twice: the row menu's trigger had to stay a plain text `⋮` because `✏️` stayed a bright yellow pencil however far the opacity was pushed, and the sync icon could not spin because 🔄 on Windows is one glyph of "blue rounded square + white arrow", so rotating it rotates the plate.

Both constraints are gone now, and the sync icon does spin (`.spinning` on the button). The only remaining emoji on screen come from **game names**, which are user data.

**`onSyncState` must still never write `syncBtn.textContent`** — that was how the old text button showed 「同步中...」, and doing it now would delete the inner `.icon-glyph` span the spin animation hangs off. State goes through `class` and `title`, both of which leave the button's contents alone.

---

## 6. Table rows

The row is grouped into three blocks — `.row-marks` (star, heart), the identity (cover, name, badges), and `.row-actions` (guide, rewrite, notion, backups, more).

They were previously one flat run of equally-spaced siblings, and `margin-left: auto` sat on the *last* button alone, so the guide buttons floated in the middle of nowhere.

### Row actions: 🔒 out, ✏️ in

The row carries 🔒 and ✏️, not the old `Manual` text toggle beside a 🗑.

**Delete is irreversible and sat next to a button people press routinely** — that arrangement mis-fires eventually. Now the two *destructive-or-consequential* actions (edit the counts, delete) live behind one ✏️ menu, and the *reversible, frequently-used* one (lock) is promoted to a direct 🔒/🔓 icon.

That is the ordering rule to keep: **depth buys safety, so spend it on the actions that need it.**

Choosing 「编辑」 **locks the row as a side effect** and must — `setManualAchievements` refuses unlocked rows, and that guard is correct: without it the next sync silently overwrites the numbers you typed. The lock lighting up is the feedback; the consequence is stated in the menu item's `title`, not its label.

One shared `#rowEditMenu` element is repositioned per click rather than one menu per row (a 300-row library would otherwise carry 300 hidden menus).

The trigger glyph now comes from the sprite. **It cannot be an emoji** — `.delete-btn` dims it with `color` + `opacity`, and an emoji carries its own colours. That constraint died with the emoji; what survives it is the *requirement*, which is that this glyph must dim.

### Editing counts is a *mode*, not a state

Permanent number inputs on a locked row mean any stray click while scrolling changes a count with no confirmation and no undo.

Now `editingAppid` gates them: entered only from the menu, left when focus leaves the row **or** when a click lands outside it. **Both exits are needed** — clicking blank space doesn't move focus in every browser, so `focusout` alone can strand a row in edit mode, which is the exact hazard this removed.

While editing, the change handler updates only the rate cell instead of calling `render()`: a full re-render rebuilds `innerHTML` and takes the focus with it, so tabbing from 完成数 to 成就总数 would swap the second field out from under the cursor.

The menu items call `stopPropagation()`, without which the document-level click handler would see the menu click and close edit mode in the same tick it opened.

### Row order: two pin layers over the chosen sort

**★ priority beats 🎮 recently-played** — the manual choice always outranks the automatic signal. Recently-played rows sort by `playedDaysAgo` among themselves.

### The badge and the pin share one window, but are not the same predicate

`RECENT_PLAY_DAYS` (5) is the shared window — **never give the badge and the pin separate windows**, or a row sorts to the top with nothing explaining why.

They are **not** the same predicate though: `isRecentlyPlayed` drives the badge; `pinsToTop` also requires `typeof total === 'number' && total > 0` and drives the pin. Pinning means "you played this, go see what's left", which is meaningless with no progress to show.

**Test the positive condition, not `!== 'N/A'`** — "nothing to track" has three shapes (`'N/A'` no system, `null` not synced yet, `0` none exist), and `null` is the common one because a newly-added game is exactly the case that is both freshly played and not yet counted. The row still shows 🎮 in its normal position and re-enters the pin by itself once `total` arrives.

**Asymmetry is safe in this direction only** — badge-without-pin explains itself, pin-without-badge doesn't.

### 🔔 replaced the new-achievements table

The old `#newAchSection` table listed anything whose `total` had grown. The bell instead shows two specific events sourced from `perfect_lost_date` / `ach_added_date`.

"Read" is stored in `localStorage` keyed on the **raw ISO timestamps**, not the day counts the UI renders — day counts change daily, so a seen-set keyed on them stops matching overnight and the red dot resurrects itself every morning.

Opening the panel marks everything read: the dot answers "is there anything new", not "have you dealt with it".

---

## 7. The filter row

Six **tri-state** chips, not checkboxes. Each chip is one attribute (喜爱 / 家庭 / 已完成 / 受限 / 无成就 / 已隐藏) cycling 中立 → 只看 → 排除 → 中立.

Two states cannot express that, which forces the direction into the label (`隐藏已完成` vs `只看喜爱`) and leaves the other direction unreachable. Names are bare nouns, because a direction-carrying name reads as `只看隐藏已完成` in the other state.

**The cycle direction is derived, not a taste call**: three states form a ring, so 中立 has exactly one cheap predecessor. 喜爱/家庭 start neutral and their usual next step is 只看; the other four start excluded and theirs is back to 中立 — this order gives both one click. Returning to a state you just left costs two clicks; that is the ring's topology, not a defect, and a reverse gesture (right-click) was considered and deliberately not built.

**The state lives in the leading mark; the label text is never touched.** Shape is the primary signal (dot / lit dot / dash) with colour secondary — WCAG forbids encoding by colour alone, and the four surface levels are only ~15% apart, so tint cannot separate three states on a 30px chip. A strikethrough on the excluded label is ruled out: this row gets scanned dozens of times a day, and a mark changing shape reads far quieter than five labels sometimes wearing a line. The dash is one step brighter than its own label (`--text-2` over `--text-3`) so the eye lands on the mark rather than the word.

**The mark's box is a fixed 9×9 with the stroke drawn in `::before`** — animating the element's own width widens the chip, and chips sit in a row, so one cycle nudges every chip to its right.

**Excluded is not red**: red is `--danger` here and four of six chips sit excluded at rest, so red would be a permanent alarm.

已隐藏 is the odd one of the six, and the difference is worth stating. The other five describe what a game **is** — read off its own data, true whether or not anyone looked. 已隐藏 records what the reader **decided**, stored in `games.hidden` and set from the row's ⋯ menu. Three consequences follow, all deliberate:

- **It is scoped to this table and nothing else.** The four readings in the top-right still count a hidden game, the rotating sweep still reconciles it against Steam, and Steam is never told — hiding is not a lightweight `删除`, and a mark that quietly moved the completion average would make that number untrustworthy. `hidden-games.test.js` pins each of those.
- **The chip is the only way back**, which is why it exists at all rather than the mark being an implicit filter. Hiding a row makes it disappear on the spot; without a control saying 「这里还有一类」 the games would be reachable only by searching for one by name. (Search does reach them — a search term makes every chip yield — but that requires already knowing what you hid.)
- **It is orthogonal to `sync_locked`**, the same separation `status` already keeps from it: one is what you see, the other is what runs.

Multiple non-neutral chips **intersect** (只看喜爱 + 只看家庭 can legitimately be empty; the row count reports it and nothing rescues it).

`FILTERS` is the single source of truth for the filter, the chip order and the wording of 「被「排除已完成」挡住了」 — spreading that over markup, state, and an id array in the wiring makes a missed spot show up as "clicking does nothing" rather than as an error, so the click handler is delegated. `html-smoke.test.js` pins the cycle direction, the opening states, and chip↔`FILTERS` name-and-order agreement.

One asymmetry worth keeping: the 「被…挡住了,点这里查看」 jump resets the blocking chip to **中立, not one step round the cycle** — advancing from 排除 lands on 只看, which swaps the table for its complement when the user only asked to see one row.

---

## 8. The search boxes

The Dashboard's 搜索游戏名… and the rewrite dialog's 搜索成就 share one shape: `.search-field` wraps the input, `.field-clear` is absolutely positioned over its right inset, and Esc is the keyboard equivalent.

**Three things are load-bearing and each fails silently:**

- **Both inputs must keep a `placeholder`** — the ✕ is shown by `:placeholder-shown`, which is the input's own state rather than a second copy of it. That matters because both fields have code paths that assign `value` directly (the dialog wipes the filter on every open) and a direct assignment fires no `input` event. The price is that swapping a placeholder for a visible label, which this page does elsewhere, leaves the ✕ hanging on an empty box.
- **The button is positioned over the input, never appended after it**, and the right padding it needs is unconditional — laying it out in flow shoves the row sideways on every keystroke, and padding that appears only when there is text makes the first character jump.
- **Clearing dispatches an `input` event rather than calling the handlers by name** — `#searchBox` carries `render` and `onSearchInput`, `#askPickFilter` carries its own `oninput`, and a named call missing one reads as 「清空了,结果还在屏幕上」.

Esc only intercepts when the field has text, so an empty filter still lets the dialog close. `html-smoke.test.js` pins all four, mutation-tested.

### A game has two names, and 搜索游戏名… matches either

A game row carries two: `name`, whichever one the interface is currently showing, and `nameAlt`, the stored name it is not showing. Matching only `name` misses about a third of a library either way round — in Chinese an English term finds nothing, and in English a Chinese one finds nothing. The miss is not a blank table: `libHit === false` is the switch that sends the query on to the store, the store matches perfectly well, and a game already owned comes back under 「Steam 上的结果」, where clicking it is refused as a duplicate.

**`nameAlt` is "the other one", not "the English one",** and that distinction is load-bearing. A field named by language carries the English name in both modes, so the day the interface could be switched to English every Chinese title stopped being findable — the same bug arriving from the opposite side. `lib/lang.js`'s `gameNamePair` decides both values together, and `addGame` returns them through it too, because its result is pushed straight into the table without a reload.

**Both search tests go through `nameMatches`**: `hidingFilter` decides what the table draws, `libHit` decides whether to go to Steam at all. Judged separately they drift, and the drift presents as a row plainly in the table while the code reports the library as empty. `gamename.test.js` and `uilanguage.test.js` pin the shared route and the matching itself, mutation-tested.

---

## 9. The achievement panel

### 「还差哪些成就」 shows your own guide, not a search box

Expanding a row shows the user's own guide text per achievement. **Not a search link out of the tool** — the thing being looked for is usually already written.

Each card carries the matching checkbox's own text from the guide (name + verbatim description + notes are **one** Notion block, which `notionblocks.js` deliberately guarantees, so that text *is* the solution — no prose scraping needed) plus a link to that exact block.

**Three things are load-bearing:**

- **Attribution is `resolveTodoToAchievement`, unchanged** — the same reverse lookup `audit` uses, which demands a unique verbatim description or an unambiguous name and otherwise returns null. **The pull to loosen it is much stronger here than in the tick path**, because a blank card *looks* like a bug while a wrong one looks fine; and it is the same function that decides what gets written into the user's notes, so loosening it for display loosens it for writing. `mapAchievementGuides` is therefore a pure assembly layer over it (`matching.test.js` pins first-wins on a repeated achievement, that a sub-step which is itself an achievement is not filed under its neighbour, and that a same-name collision yields **no** entry).
- **An achievement it cannot attribute says 「攻略里还没写这条」 and keeps the search link** — chosen over silence because the blanks are the actionable half: each uncovered achievement says so on its own card, which makes the panel a coverage map that previously needed `guide-lint` across the whole corpus to produce. **The header does not also count them** — it states `剩余 8 个成就` and stops, because a tally of what the cards below already show is the header narrating the panel rather than adding to it.
- **The guide read is soft-failed**: a dead Notion token puts its message in the header and leaves the achievement list untouched, verified by running a real server with a bogus `NOTION_TOKEN`.

A game with no registered guide is untouched (search link only) — and so is one whose achievement schema hasn't synced, because `resolveTodoToAchievement` needs `api_name`/`name_cn`/`name_en`/`description` and `getMissingAchievements`'s live-schema fallback can't produce that shape; claiming 「攻略里还没写」 there would be a guess.

### A guide in the other language is marked in this header, and nowhere else

When `guides.lang` disagrees with the interface language, the header gains one more segment: 「· 英文攻略」 / 「· Chinese guide」. It is symmetric, and it names the **guide's** language rather than the interface's.

**This panel is the only place it appears.** It is the one place the guide's own text is on screen, so it is the one place the mismatch is about to matter. On the row button it would be a badge on most rows carrying the same word, which stops being information the second time it is seen.

Both keys spell out both languages in both halves, which is not redundancy: a table holding only 「英文攻略」/`Chinese guide` would be correct *because of the condition guarding it* rather than because of what it says, and moving the render would silently make it lie.

The dialog behind ♻ 重写 names the language in its **title** when the guide being replaced is in the other one — 「用中文重写《…》的攻略?」 / `Rewrite the guide for … in English?`. That dialog has no body (§10), so the title is the only place it can be said, and it needs saying: switching the interface and pressing 重写 is the whole mechanism for changing a guide's language.

### The guide text is stripped of its echo of the name and description (`stripGuideEcho`)

By the writing convention a checkbox opens with the achievement's name and its **verbatim** official description — both of which the card already prints above, from Steam. Left alone, every card said everything twice and pushed the actual tips out of the window.

**Stripping runs only from the top, and only on lines that are *entirely* the echo.**

**Do not judge the name line with `extractTitleCandidates`** — that function slices `知识(Rationality) — "…" 集齐全部百科全书条目` down to `知识`, so using it here deletes the whole tip. It exists to *find a match*, not to prove a line is nothing but a name.

**A paraphrased description is always kept**: it is the user's own wording, and on a *hidden* achievement that line is usually the only place the unlock condition appears at all (Steam returns nothing) — 夏洛克家's 「处理酸奶丢失的情况。」 survives for exactly that reason, which is also why the comparison uses the raw row's `description` and not the display string, whose hidden-achievement value is a placeholder.

**Stripping to nothing returns an empty string and the window simply isn't drawn.** It first returned the original text on empty, justified as "never show an empty card" — wrong, because the name, the description and the jump icon are all still there, and the actual effect was that an entry which had *only* copied the official text became the most redundant card on screen (measured: 资本家, 成就达人).

Two of this rule's tests were mutation-tested into existence; one of them, the `知识` case, was **passing vacuously** because a single-line guide stripped to empty hit the old fallback and came back unchanged no matter how wrong the stripping was. It now carries a second line so over-stripping is observable.

### The card equalises, the guide block does not — that sentence is the whole layout rule

The accent rule down the left of `.ach-guide` is a **measure**: it traces the text, so its length reads as how much text there is. A rule running past the text into blank space reads as "there is more below".

The card is a **container** — fill and border, so leftover room inside it reads as padding.

So the container carries the alignment and the measure never does: `.ach-grid` is `align-items: stretch` so card outlines line up per row, while `.ach-guide` is `max-height`-capped and otherwise sized by its content, so the rule stops where the text stops.

**Never give the text block a height it did not earn** — a length an element is forced to adopt is not the same as one it earned, and the accent rule is only honest at the second kind.

Four rules hold the rest up:

- **The cap is on the container that holds text *and* sub-steps**, not on the text: `.ach-substep` divs are the text's siblings and would escape a cap set on the text, growing the card past its row-mates. **Verify that on a game that actually has sub-steps** — a library where every guide has `subSteps: []` cannot show the defect.
- **The window is written `calc(var(--fs-xs) * 1.6 * 6)`**, not in `em`: `em` on a container re-bases onto whatever font-size the container inherits, so the window silently means "six lines of the table's type" rather than six lines of the guide.
- **`align-items: stretch` holds while a guide is expanded as well**, so the row grows to the expanded card and takes its row-mates with it. Letting that row fall back to `align-self: start` is **rejected, and should not be re-proposed**: a row is the one place cards are read side by side, so several different bottom edges in it read as breakage, whereas the room left over inside a card reads as padding — the container/measure split this whole section rests on.
- **The fade and the pointer hang on a `.clamped` class** JS adds only where `scrollHeight` really exceeds the box, never on `:not(.expanded)`: gated the other way, a guide that already fits gets a gradient over nothing and a cursor promising an interaction it cannot perform.

**Read `scrollHeight` for every card before writing any class** — interleaving them forces a reflow per card, on a library whose biggest guide is 408 achievements.

Expansion is `classList.toggle('expanded')`; the single-argument toggle is a deliberate flip that `html-smoke.test.js` exempts (`args.length < 2`) from its boolean-coercion rule.

The jump to Notion is an **icon beside the achievement name**, not a labelled link under the guide — under the guide it competes with the window for space and has to be kept out of the clip by hand.

---

## 10. The rewrite dialog (♻)

### Reachable from the dialog that was already there

The **范围** row is a plain either/or — **整篇** or **自选** — and getting there took removing something.

It first offered the computed sets (`稀有成就 27`, `未解锁 1`) as scope options, which had a concrete defect: **you confirmed a paid, irreversible rewrite over a set you had never seen**, and could not adjust it afterwards. The owner spotted that the presets are not scopes at all but *starting points for a selection*, so they moved inside the picker as buttons that **tick** their entries — now you see exactly which 27, and can add or drop individually.

What went with them: the server-side `patchPresets` machinery (one `planGuide`, four presets), the `unavailable`-vs-`0` distinction and its `—` rendering, and the per-preset preflight. The client already holds `rarity` and `unlocked` on every pickable item, so the counts are computed locally with no round trip.

**`RARE_PCT` is sent to the client (`rarePct`) rather than duplicated as a literal `15`** — the threshold that decides "rare" in the prompt, in `--only rare`, in the shortcut and in the percentage's accent colour has to be one number.

### That row was rebuilt three times, and the third one is **filters**

**It shipped as toggles that selected a batch**, whose lit state meant "every entry in this batch is currently selected". That is a *derived fact* read as *"I pressed this"*, and **property batches overlap while section batches do not**: on 部落幸存者 the single 未解锁 entry is also rare, so pressing 稀有 lit 未解锁 too — and pressing 未解锁 (now lit, so its action was *subtract*) then dimmed 稀有. **Press one key, watch a different one change.** Reported by the owner as a bug, and it was one: two meanings sharing one visual state.

**Attempt two made them add-once actions with no pressed state**, which killed the chain — and then hit the wall the owner found next: *add-only expresses unions and nothing else*, so 「the rare ones I have not got yet」, the single most useful set, could only be reached by taking all 22 rare and unticking by hand.

**Attempt three splits looking from taking**: the two chips are filters (press both = intersection) and a `全选` next to the count takes whatever is currently shown. The pressed state is honest again because the handler provably never touches `selected` — pinned by asserting the word `sel` does not appear in it, since that is the boundary, not any particular spelling.

**One predicate function serves both the list and 全选**: written twice, 全选 would quietly take entries that were not on screen, immediately before a paid irreversible action.

**The section boxes were tri-state toggles through all three rounds** — their batches are disjoint, so the connected behaviour cannot arise there, and they already operated on the filtered view, which is why attempt three was a small change.

### The count line was silently stale for three rounds

`已选 N 条` was written only at the end of `paintPicker`, and ticking a single entry **deliberately skips the full repaint** (it would jump the scroll position back to the top while you are working down the list). So the count froze at whatever the last full repaint left, while the sentence above it updated correctly.

**Nobody saw it because the other number was right** — you have to read the two together to notice. It surfaced only from comparing the *displayed* count against `querySelectorAll('input:checked').length`, i.e. checking the UI against the DOM rather than reading the UI.

`paintCount()` is now its own function precisely so the single-entry path can call it, and `html-smoke.test.js` pins that call (mutation-tested).

**When a value has two renderers and only one repaint path, assume they have drifted and go measure.**

### The dialog's width is pinned, and the body is gone entirely

Two things the owner caught by using it.

**`.modal-box` sizes to its content**, which is right for a two-line confirm and wrong for one containing a live list: ticking an entry changed which row was widest, so the whole dialog twitched under a cursor that was aiming at a checkbox. `.ask-wide` pins it to 520px and is applied whenever the dialog *has* a picker — not whenever the picker is *shown*, or switching 整篇/自选 would jump instead. Measured across nine states (mode switch, quick-pick, untick, collapse, filter, clear): 520px throughout, while the pickerless dialogs keep their natural width (the generate confirm is 297px).

**The dialog ends up with no body at all.** 自选 lost 「只改选中的 27 条」 (a restatement of the 「已选 27 条」 directly below the list) and 「其余 24 个一字不动」 (which restates what 自选 means); 整篇 was cut the same way down to one surviving clause — how many hand-ticked sub-step boxes revert — and on the fourth pass the owner cut that too: **a rewrite already implies replacing what is there, and the backup is taken either way, so the sentence restates its own verb.**

The disclosure did not vanish, it narrowed to one surface: `formatPreflight` still prints every at-risk tick for `--overwrite` and `guideoverwrite.test.js` pins it, because the CLI writes for someone who typed a flag and can afford the detail while a dialog cannot.

With no caller left, `askConfirm`'s **function-valued body** (it recomputed the text from the current selection) went with it, along with its six repaint calls; `html-smoke.test.js` now pins the opposite invariant — the rewrite confirm passes no `body` (mutation-tested), plus the display/hide of `#askBody` itself. Re-verified live afterwards: body `display:none`, 520px across every state, and the displayed count equal to `querySelectorAll('input:checked').length` at each of seven steps.

### `自选…` is one control doing two jobs

**The label went through 「挑几条…」 first, and the reason it changed is a rule:** the other three options (`整篇`, `稀有成就`, `未解锁`) are all *nouns naming a set*, and 「挑几条」 was a verb phrase describing an action — a shape mismatch that reads as casual next to them. `自选…` answers the same question the row asks (which set? *the one I pick*), and the ellipsis keeps the "this opens more UI" signal.

The picker lists the guide's own achievements **grouped by the section heading they sit under**, each row carrying its global unlock rate and unlock state; every heading has a **tri-state checkbox** that takes or drops the whole section.

That box was added after the owner asked whether sections could be selected at once — **the behaviour already existed**, as "click the heading", explained in a body sentence that only rendered while nothing was selected. So it vanished the moment you picked your first entry, and nobody found it. **An affordance you have to read about is not an affordance**; the box is drawn at exactly the size and left edge of the item checkboxes so it reads as the same kind of control without a word of explanation.

So "pick a section" and "pick individual entries" are the same control, and the request that goes out is always a plain `api_name` list — the explicit-list branch `resolveScope` already had, so the Dashboard never needs a `section:` selector at all.

Empty selection **disables the confirm button** (and Enter respects that) rather than being refused server-side.

### There is no `thin` selector, and the reason generalises

It has no honest short Chinese name: 「写得薄」 is a translation of *thin content* and additionally *grades* the entry; 「没写打法」 calls "wrote one sentence" "wrote nothing". **A criterion that needs its threshold explained before it makes sense cannot be a button.**

It was not built on the CLI either — `--only` accepts `rare` / `locked` / `section:` / a name list, and `test/guidepatch.test.js` pins `thin` as absent. **A criterion that cannot be stated clearly enough for a button is not made a selector anywhere.**

### Two labels that read as casual, and the shape rule behind both

「筛成就名…」 → 「搜索成就」 (a verb jammed into a noun slot, on a `type=search` input where 搜索 is simply the word) and 「怎么改」 → 「重写要求」.

The second is the third label in this dialog to hit the same rule: **the labels in a row are noun phrases (范围, 写法), so a question mixed in among them reads as casual** — identical to 「挑几条」 among 整篇/稀有成就/未解锁 two rounds earlier.

「要求」 alone had been rejected as too abstract; 「重写要求」 keeps the concreteness by naming what the requirement is *about*, and ties to the dialog's own title. What the field wants is answered by its placeholder, which leads with the real question: what happens if you leave it blank.

### 写法 lives in the confirmation, not on the row or in settings

The pre-spend confirm already existed and was nearly empty (a title and one button). **「Do you want to spend this」 and 「how deep」 are one decision**, so splitting them means answering before choosing.

A per-row selector would put one control on each of 300 rows; a settings field would make a per-run choice into a stored preference.

It reuses `.view-toggle` — the segmented control the top bar already has — rather than introducing the page's only slider, on the same precedent that removed the hand-drawn wordmark rule: **an element matching nothing next to it gets removed here.**

**`askConfirm` still returns a boolean**; the pick is written back into the caller's own `o.choice.value`, so its six other call sites did not have to change.

Server-side the value rides `startGuideGen` → `enqueue` → `runGuideGen` and becomes a **per-run config copy** — writing `config.ai.effort` would let one 极速 silently retune everything queued behind it.

The rewrite dialog's hardcoded 「约 2–4 分钟」 went at the same time: identical input has measured 76/174/337 s, and the fast mode is 8× faster again, so any quoted range is a promise the system cannot keep.

---

## 11. The floating layers

Two floating layers, two corners. `#gen-bar` (guide progress) is `position: fixed` **bottom-left**; `lib/rpc.js`'s sync status bar hardcodes bottom-right at `z-index: 9999`.

Generation runs for minutes — measured between 35 s and 11 min on real games, and **deliberately not quoted as a range anywhere on screen** — and the user is scrolling the table meanwhile, so an in-flow bar at the top means "scroll back up to see if it's still alive".

Anything floating needs an opaque background or it renders on top of table text. `#gen-bar` sits at 9990 so the sync bar wins any collision, and a `max-width: 720px` media query stacks them instead.

While a job runs the bar can only be **collapsed** (`genCollapsed`), never closed — one line stays and one click brings the strip back, since losing sight of a paid multi-minute run is not allowed to happen. Only a **finished** bar offers 关闭. The old single `genDismissed` flag conflated the two (its button said 收起 while the behaviour was permanent discarding of a running job's progress) and was split; finishing a run auto-expands the bar once, because the result line carries where the guide landed. Starting a new generation/migration clears the collapse.

---

## 12. Shared interaction rules

### Hover must not dim, and every control has a press state

Two defects the rebuild left behind.

`.badge-btn` carried a blanket `:hover { opacity: 0.85 }`, so hovering an **enabled** 锁定/家庭 badge did nothing but fade it — **pointing at a control made it harder to see**. Each variant now gets a *deepening* hover instead, and the `transition: all` went with it (it would have swept up the new `:active` transform and made presses lag).

Separately, **the file contained zero `:active` rules** — every button had hover, none had press feedback, in a tool whose rows get clicked dozens of times a day. There is now one global press rule next to the global `:focus-visible`, for the same reason that one exists: **per-component interaction states get forgotten one component at a time.**

It uses `translateY(1px)` (compositor-only — a padding/margin nudge would reflow a 300-row table on every click) and deliberately excludes `.g-card`, whose hover already owns `translateY(-3px)`.

### Every `.armed` rule needs a `:hover` twin

`.armed` is two classes (0,2,0); each button's own `:hover:not(:disabled)` is a class plus two pseudo-classes (0,3,0) — **hover wins**. And the cursor is sitting on the button right after the first click, so the confirm-red is painted over at exactly the moment it has to be visible.

Every armed rule in both pages is therefore written as a pair (`.x.armed, .x.armed:hover:not(:disabled)`).

**Nothing errors when the twin is missing**, the symptom is only a wrong colour, and it appears only while a live cursor rests on the control — so screenshots and reading the CSS both miss it. `html-smoke.test.js` requires the twin for each one.

---

## 12b. Both pages read their text from a table

`Setup.html` and `Dashboard.html` each hold a `STRINGS` table of `[zh, en]` pairs and the same ~56-line mechanism (`t`, `applyStrings`, `REPAINT`). **Zero dependencies allows no shared script**, so the mechanism is stored twice — the same arrangement as the `:root` design tokens, and `uilanguage.test.js` compares the two copies the same way. A divergence is silent: a fix to slot substitution lands on one page and not the other.

Pairs rather than two locale files, deliberately. A key missing from a second file falls back and looks fine; a pair makes a half-translation a structural fact the tests can see — both halves present, the Chinese half genuinely Chinese, the `{slots}` matching, no key used-but-undefined or defined-but-unused, and no Chinese left loose outside the table.

The two pages differ in one way. `Setup.html` repaints in place on a language change, so it needs a `REPAINT` registry for text that was interpolated when it was painted — leaving one out is invisible in Chinese and shows up as a single stale line in an otherwise English page, which is how the guide-archive counter was found still reading 「0 份 · 0 B」. The Dashboard needs no such registry: `render()` rebuilds the whole table from `allGames`, and there is no toggle on the page — it lives on `/setup`, and coming back is a full navigation.

**Dates follow the interface, not the machine.** `lastUpdated` is formatted server-side against `uiLanguage`; a page reading in English with a `zh-CN` timestamp on it is the one line that looks like a bug rather than a choice.

---

## 13. The setup page (`Setup.html`)

It is the first-run gate **and** the settings page. Served instead of `Dashboard.html` when `config.json` has no Steam credentials; reachable any time from the Dashboard's 设置 button. `getSettings` drives the two modes.

**Secret fields blank = keep current**, never = clear.

### Every string on this page comes from a table

`Setup.html` is the first surface converted for `uiLanguage`, so nothing on it is a literal any more. Two routes, and they are not interchangeable:

- **Static markup** carries `data-t` (or `data-t-placeholder` / `data-t-value` / `data-t-aria-label`) and is repainted by `applyStrings`. The Chinese stays inline as the pre-JS default, so the page reads correctly before the script runs.
- **Anything composed at runtime** calls `t(key, values)`, with `{slot}` for the interpolated parts.

Four rules the tests pin, each of which fails silently:

- **A whole sentence is one entry.** Several messages used to be spliced from a prefix, a joined list and a full stop. That works while one language is involved and breaks the moment word order moves — so `'已完成:' + list + '。'` became `msg.done.some`, and the list separator is its own entry because `;` and `; ` are not the same character.
- **A line that mixes our words with an `<a>` or a `<code>` keeps its elements** and gives each text run its own key, rather than storing markup in the table. That pins the word order to the Chinese one, so the English for those runs is written to fit the same slots. It is the price of never putting a table string through `innerHTML` — the restore preview is on this page, and it renders a not-yet-trusted file.
- **The page's own heading is set as a key, not as text.** It renames itself four times (fork, wizard, restore, settings); assigned as text, the next `applyStrings` repaints it from whichever key the markup shipped with and the page silently goes back to calling itself 初始设置.
- **Interpolated text has to be repainted explicitly.** `applyStrings` cannot help it — there is no key on the element, because the value was spliced in when it was painted. Those painters register in `REPAINT`. Leaving one out is invisible in Chinese: the guide-archive line went on reading 「0 份 · 0 B」 in an otherwise entirely English page.

Switching language repaints in place and **does not reload** — a reload would cost whichever step you were on.

**The control is a segmented pill on the heading row, not two buttons on a row of their own.** As
two bordered buttons it took a full band of vertical space above the step nav for a setting most
people touch once, and being the first thing under the heading it read as the first thing to fill
in. Opposite the heading it costs no vertical space at all: the row's height is the `h1`'s.

It is still two radios in a `radiogroup` — the same native selected state, focus ring and arrow-key
behaviour — and the hit area is unchanged at 32px. What changed is the shell: the border moved to
the track and the halves are borderless, so the pair reads as one control with one of two positions
rather than as two buttons competing for a press.

Each option stays written in its own language (中文 / English) rather than being abbreviated. It is
the one label on the page that has to be readable *before* the setting it changes has taken effect.

**Settings mode has no subtitle.** The step nav sits directly beneath the heading and is
self-evident; a sentence telling you to click it narrated what the controls already showed. The
first-run subtitle stays, because it states a fact that is nowhere else on screen — the keys never
leave this machine.

### The first screen is a fork, and it is the one thing the program has to ask

No config and no data looks **identical** for "first time ever" and "already a user, new machine" — nothing on disk distinguishes them, so this is the single question that cannot be inferred.

It is asked as 全新设置 / 从备份恢复 rather than 「你是新用户吗」: the second makes the user guess what this program means by "new", the first is answerable from what they have in front of them.

全新设置 is the solid button because first-timers are the majority **and mis-clicking is cheap** — the backup file is still there and restore stays reachable from the settings page.

The gate branch **must hide every `.step` itself**: step 1 carries no `hidden` attribute in the markup (normally `showStep()` does the hiding), so without that line the wizard's first step renders underneath the two choices and the fork is not a fork. Caught in a browser, not by a test.

### The fork has to be reversible

Reported by the user: after a fresh install they clicked 「从备份恢复」 by accident instead of 「全新设置」, and could not get back out — the only way was to close the whole program and reopen it.

`startRestore()` hid the fork and revealed the step-4 restore UI, after which no control on the page could go back. **All three routes were closed**: `#back-btn` (return to Dashboard) is only armed in settings mode, which is correct — first-run is deliberately a gate; `#step-nav` is only shown by `showWizard()`, which the restore branch never calls; and the packaged build has no address bar and no back key, while the tray's 「打开面板」 only shows and focuses.

Someone with no backup file was therefore stuck. The 全新设置 branch is one-way too, but you can still walk out of it by filling the settings in, which is why nobody reported that one.

**What was added is a way back to the fork, not back to the Dashboard.** `#gate-back` (重新选择) and `#back-btn` are two controls and must not be merged — making one control carry two meanings is the mistake the filter chips already paid for. The new control only appears during first-run and returns to the two choices above, so the user is still inside the gate and the "first-run has no exit" rule is intact.

`showGate()` is also first-run's initial state (`initSteps` calls it directly), so **it must restore everything either branch touched**: the three elements `startRestore` hid, the title, the subtitle, the step bar and the button row. Miss any one and the second visit to that section renders half-built, without erroring.

**That change opened a new hole, now plugged.** A way back turns `showWizard()` from "runs once ever" into something that can run repeatedly, and it contains four `addEventListener` calls. Measured with the guard removed: after three round trips between the fork and the wizard, one click on 「跳过」 jumped from step 1 to step 4 as three listeners fired together. **Duplicate binding does not error, it just doubles the behaviour, and you have to walk the way back to see it.** One-time wiring therefore moved into `wireWizard()`, behind a `wizardWired` check.

Verification was done at both ends, because `html-smoke.test.js` has no DOM and cannot see this class of bug (the original fork bug was also found in a browser). The live run used an isolated port 8778 and a separate `TRACKER_DATA_DIR`, touching no real data; it walked fork → restore → back → fresh setup → back, checking nine pieces of state at each step, confirmed 「跳过」 advances exactly one step after three round trips, and that `#back-btn` never appeared. Five source assertions were each broken and restored.

**Set the viewport before measuring geometry in the browser panel.** With none set, `clientWidth` is 0; a first reading of "button is 12x85, so it's squashed" was false — the whole form was 34px wide at the time.

### The settings page needs an exit, and it is not called 「取消」

The packaged app has no address bar, no back key, and the tray's 「打开面板」 only shows and focuses the existing window (`showWindow` never calls `loadURL`), so without `#back-btn` the only way off `/setup` is 「保存并验证」 — changing your mind means quitting the program and relaunching.

The *entry* half of this constraint was already handled (the ⚙ link on the Dashboard exists precisely because the packaged build has no address bar); the exit half is the same constraint from the other side.

**It names where it goes, not what it undoes**, because six controls on this page commit *before* save — `createNotionGuideDb` writes the new id to disk on the spot, and 立即备份 / 恢复 / 全部删除 / per-archive delete all act immediately. A button labelled 「取消」 would promise a page-wide rollback it can only deliver for seven text inputs.

Three details are load-bearing:

- **`type="button"`**: it lives inside the `<form>`, and the default type would *submit* on click.
- **Edit mode only** (`armBack()` is called from the `isEditMode` branch): during first-run the page is a gate and must have no exit at all.
- **The dirty check is per field, not one snapshot** — `createNotionGuideDb` re-marks only `notion-db`, because a whole-form reset would silently swallow a genuine unsaved edit made in the same sitting.

A clean form leaves on one click; only a dirty one arms, since a confirmation shown every time trains itself into a reflex. `#back-btn` must also sit in the document-click disarm exception beside `#arc-wipe`.

### Three wizard steps, one mechanism, two behaviours

Step 1 Steam (required) → 2 AI → 3 Notion, one section visible at a time, plus a settings-only 4th (备份与恢复).

**The step bar is clickable in both modes** — stepping one at a time is slow, and the sections are independent, so nothing is gained by forcing an order. The only difference is the button below: first run shows exactly one (`下一步` on step 1, `跳过` on the optional middles, `完成设置` at the end), the settings visit shows only `保存并验证`.

It replaced a flat page of `<details>` where required and optional fields sat together with nothing marking which was which.

**Every input stays in the one `<form>` and is merely hidden**, and submit reads `$(id).value`, which sees hidden nodes — so "skip" just means "left blank" and the whole save path is untouched.

### One button per step

There was briefly a row of 上一步 / 暂时跳过 / 下一步. Two of the three were redundant once the step bar became clickable — **the bar *is* the back button**, and on an optional step "skip" and "next" are the same action wearing two labels.

Keep this shape: **on-screen prose and near-duplicate controls both cost more than they give here.** Explanatory paragraphs were cut from steps 2, 3 and 4 for the same reason; the one that stayed warns about unrecoverable data loss (import before first sync), which is not an explanation of how the feature works. Long-form rationale lives in `docs/`, never on screen.

### No `required` inside the stepped form

A hidden `required` control makes the browser refuse to submit with a console-only "not focusable" error — i.e. pressing save from the Notion tab would do nothing, visibly.

Validation is the manual `stepOneOk()`, and failing it **jumps back to step 1 and says why** rather than the previous silent `return`, which with one section on screen would have looked like a dead button.

### `STEP_COUNT` and `WIZARD_LAST` are different numbers

4 and 3. The first bounds `showStep`'s clamp, the second is where `完成设置` hangs — 备份 is a settings-only section and is not part of first-run.

They were one constant, and reusing it meant `showStep(4)` clamped straight back to 3, so **the new tab simply did not open when clicked**, and nothing errored.

### The AI step shows the selected vendor's state, not the file's

`ai.providers` stores a key and model per vendor, so 「换一家试试」 stopped meaning 「把密钥再粘一遍」 — but only if the form follows the dropdown. `paintAiProvider()` repaints three things on every `change`: the 已配置 badge, the key placeholder, and the model field.

Three details are load-bearing and none of them errors when wrong:

- **The option labels are rebuilt from `opt.dataset.label`, never appended to** — `textContent += ' · 已配置'` is right the first time and produces 「DeepSeek · 已配置 · 已配置」 on the second repaint, which happens on every switch.
- **Changing vendor clears whatever is typed in the key box**, because that string was meant for the vendor you just left and submitting it would store a guaranteed-wrong key under the new one, surfacing as a validation failure that says nothing about the switch.
- **The step header's 已配置 asks whether the step is done, not whether the current vendor has a key** (`Object.values(aiProviders).some(...)`): configured Anthropic while parked on DeepSeek is still a finished step, and `!cur?.hasKey` there reads as "the config was lost".

A native `<option>` cannot hold an SVG and leading-space alignment is renderer-dependent, so the marker is a suffix here rather than the leading mark the filter chips use. Pinned as source assertions in `html-smoke.test.js` (no DOM in the runner), the first two mutation-tested.

### The archive panel here is **not** where you restore from

The question a person actually has is **「这个游戏的上一版哪去了」**, which is per-game. Answering it from a global Settings table means leaving the row you are looking at and then finding it again in a list where adjacent entries differ only by a timestamp.

So restore moved onto the Dashboard row itself, and what stays here is the residue that genuinely has no per-game home: **total size** (every archive rides inside the backup zip, and a Notion page dumps as ~120 KB) and **orphans** — archives whose game has been deleted from the library, which the ⋯ menu cannot reach at all.

Two consequences follow and both are deliberate:

- It is sorted **by size, not by date** — same data, different question, so the other sort belongs to the other surface.
- It offers 看 / 删 but **not 恢复**, including for orphans — restoring an orphan would `upsertGuide` a row pointing at a game the Dashboard does not render, i.e. a guide you still cannot see, so the honest instruction is 「先把游戏加回来」 and that is what the summary line says.

**The panel is fetched only in edit mode**: during first-run setup those directories are necessarily empty, and the restore-from-zip path owns that screen.

---

## Appendix: two page-wide hard rules

**An author `display:` silently defeats the `hidden` attribute.** `[hidden] { display: none }` comes from the *user-agent* stylesheet, so any author rule outranks it and turns that element's `hidden` into decoration — JS keeps setting `.hidden = true`, the element keeps showing, nothing errors. Both pages carry a global `[hidden] { display: none !important }` and `html-smoke.test.js` pins it. **Patching per element is whack-a-mole**; the next `display:` rule opens a fresh hole just as quietly.

**Native dialogs are unusable in this app — in *either* process.** A native dialog appears and vanishes before it can be clicked in the packaged build, so every action gated behind one is unreachable; `dialog.showMessageBox` from the main process returns instantly with `response: 420`, a value outside the button range. **The boundary is native-vs-page, not renderer-vs-main.** Do not add a native dialog anywhere in this project — it fails silently, and a non-zero response reads as "user declined".

`askConfirm({title, body, okText, danger, notifyOnly})` is the in-page replacement, identical in browser and package. It returns a **Promise**, so every call site must `await` it: a forgotten `await` makes `if (!askConfirm(...)) return` never return, silently green-lighting the dangerous action. Both rules are pinned in `guidegen.test.js`.
