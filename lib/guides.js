/**
 * The guide layer: achievement-name ↔ checkbox matching rules, and dispatch between the two
 * backends (Notion / local markdown)
 * ------------------------------------------------
 * Matching runs in two passes: achievements with ambiguous names are located first by the verbatim
 * official description copied into the guide (see matchAchievements), and the rest are matched by
 * exact name. So **copying the official description into a guide is functional**, not merely
 * decorative.
 *
 * **Matching is exact equality against "title candidate segments"; no substring or prefix matching.**
 * The reason (a defect paid for): a short achievement name can be a strict prefix of another,
 * unrelated and harder achievement's name. Once the short one's checkbox is ticked and leaves the
 * candidate pool, prefix matching goes and ticks that "cousin" achievement — which is not unlocked.
 * So only "the achievement name is exactly equal to one candidate segment" is accepted.
 *
 * How candidates are split has to cover the common ways guides are written, but that only means
 * **producing a few more candidate segments**; each candidate still requires strict equality —
 * matching must never be loosened to accommodate a particular style:
 *   - The part before a newline, a colon, or a dash (both the ASCII ' - ' and the fullwidth
 *     ' — ' / ' – ' are recognised)
 *   - The 「中文名(English Name)」 form, where the Chinese and English names each also count
 *
 * But producing more candidates exposes a deeper problem: same-named achievements. With two
 * achievements sharing a name, the name cannot possibly determine which checkbox to tick. Hence a
 * further gate, findAmbiguousNames — when the same-named achievements are not all unlocked, the
 * whole name is abandoned. See that function's comment.
 */
import { achievementsFor, allGames, allGuides, getGame, upsertGuide, getGuide, appendSyncLog, nowIso } from './db.js';
import { sleep } from './steam.js';
import { extractNotionPageId, normalizeNotionId } from './notion.js';
import { schemaMissingReason } from './schemareason.js';
import * as md from './markdown.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { msg, achName } from './messages.js';

/**
 * Lowercase, strip markdown bold asterisks, turn a literal <br> into a real newline, and collapse
 * excess whitespace.
 * **Punctuation is preserved** (colons, dashes, newlines), because extractTitleCandidates relies on
 * it to find segment boundaries.
 */
export function normalizeText(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    // The underline annotation is the same class of thing as `**`: markup, not prose, and on the
    // Notion side only the inner text survives. Without stripping it, the same guide normalises
    // differently on the two backends and matching works intermittently
    .replace(md.UNDERLINE_SPAN_RE, '$1')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * The normalisation used for "are these two pieces of text the same". **It folds different spellings
 * of the same character and never touches content.**
 *
 * Two places ask this question: `resolveTodoToAchievement` (audit's reverse lookup, and the
 * Dashboard's "what is still missing" panel) and `guidelint`'s "is the description quoted
 * verbatim". The two **must use the same predicate** — with separate copies only one of them
 * eventually gets updated, and at that point the linter says "audit cannot reverse-resolve this box"
 * about a box audit can in fact resolve. They were indeed separate copies (two identical private
 * `flat` helpers).
 *
 * Folding typographic quotes is justified because it **does not change content**: Steam's
 * `“幸福的孩子”` and the guide's `"幸福的孩子"` are the same sentence, and differing glyphs had us
 * judging it "paraphrased", so audit could not resolve that box. Measured across the library, 14 of
 * 791 mismatches are of this kind; the other 777 are genuine paraphrases by the author and must be
 * left alone.
 *
 * **This is not loosening the matching.** It cannot make two **different** descriptions equal, only
 * two spellings of the same one — the same class as the whitespace collapse already present. Should
 * two achievements ever differ only by quote style, the description-uniqueness test returns 2 and
 * neither matches, landing on the side this project consistently chooses (a missed tick over a
 * wrong one).
 *
 * Dashes and the ellipsis are **deliberately not folded**: no evidence demands it, and their
 * variants genuinely differ in meaning across contexts.
 */
const TYPO_QUOTES = /[\u201C\u201D\u201E\u201F\uFF02]/g;
const TYPO_APOS = /[\u2018\u2019\u201A\u201B\uFF07]/g;
/**
 * The typographic half of `flatCompare`, **without the whitespace collapse**, so it is
 * length-preserving: one character in, one character out, every offset unchanged.
 *
 * That property is the whole reason it exists separately. `flatCompare` answers "are these the same
 * text", which needs no offsets; the spoiler pass has to answer "**where** in this line is that
 * sentence" so it can cut it out, and a normaliser that removes whitespace cannot say. Splitting it
 * here rather than writing the character classes out a second time is deliberate — two copies of
 * this pair is exactly the shape that leaves one of them un-updated.
 */
export const foldTypography = (s) => String(s ?? '').replace(TYPO_QUOTES, '"').replace(TYPO_APOS, "'");

export function flatCompare(s) {
  return foldTypography(s).replace(/\s+/g, '');
}

/**
 * Is this string usable as evidence that a checkbox is about a particular achievement?
 *
 * **Steam's description can be whitespace and nothing else** — Factorio's 咸鱼翻身 stores a single
 * space, and rows like it are already in every user's database. Such a value is truthy, so a plain
 * `if (!raw)` admits it, and `flatCompare` reduces it to `''`, which every checkbox's text
 * "contains". One row then answers for the whole game: the reverse lookup hands that achievement
 * back for the first box it reads and discards every later box as already claimed, so a complete
 * guide displays as if nothing were written. **Anything asking "does the guide quote this
 * description" must go through here** rather than testing the raw string for truthiness.
 */
export function isQuotableText(raw) {
  return flatCompare(raw).length > 0;
}

const PAREN_PAIR = /^(.+?)\s*[（(]([^)）]+)[)）]\s*$/;

/**
 * Trailing punctuation on a candidate. It only consumes the end; punctuation mid-sentence is never
 * touched.
 * Quotation marks, parentheses and title marks are excluded — they are paired, and removing one side
 * alone would turn `《物种起源》` into `《物种起源`.
 */
const TRAILING_PUNCT = /[。．.！!？?，,、;；:：…⋯～~\s]+$/;

export function extractTitleCandidates(text) {
  const candidates = [];
  const add = (s) => {
    const t = (s ?? '').trim();
    if (t) candidates.push(t);
  };

  // 1. Split by newline (covering "title<br>description", and layouts with the English name, the
  //    localised name and the description each on their own line)
  for (const line of text.split('\n')) add(line);

  // 2. The single-line form separating title and description with a colon or a dash; take the part before the separator
  const colonIdx = text.search(/[:：]/);
  if (colonIdx > 0) add(text.slice(0, colonIdx));
  for (const dash of [' - ', ' — ', ' – ', '——']) {
    const idx = text.indexOf(dash);
    if (idx > 0) add(text.slice(0, idx));
  }
  // The form with **no space before the dash** (`achievement- description`). Every separator above
  // requires a space before the dash, so a line such as `胜利!- 使用北条时宗…` produces only one
  // candidate (the whole line) and the achievement name can never be extracted — so those boxes
  // neither tick nor get noticed: audit resolves them by the verbatim description and waves them
  // through, while checkbox-sync presents "nothing to tick", which looks exactly like "everything is
  // already ticked".
  // It only surfaced when guidelint was run across every guide; measured, it affected 17 boxes (all
  // in Civilization VI).
  // Still **exact equality** — this only supplies one more candidate segment and does not loosen the test.
  const dashIdx = text.search(/[-—–]\s/);
  if (dashIdx > 0) add(text.slice(0, dashIdx));

  // 3. The whole text is a candidate too (the case where the line is a bare achievement name with no description)
  add(text);

  // 4. 「中文名(English Name)」 → the Chinese and English names each become candidates
  for (const c of [...candidates]) {
    const m = c.match(PAREN_PAIR);
    if (m) {
      add(m[1]);
      add(m[2]);
    }
  }

  // 5. A further copy with trailing punctuation removed. Guides commonly add a full stop to an
  //    achievement name (writing 「秘密食材。」 where Steam has 「秘密食材」), so exact equality
  //    fails. The same class of problem as the dash case above.
  //
  //    **Appended, never substituted** — achievements whose names genuinely carry punctuation
  //    (「白手起家。」, 「胜利!」) must keep the unmodified candidate, or this would turn matches that
  //    worked into matches that do not. Placing it last also ensures resolveTodoToAchievement tries
  //    the exact one first.
  //
  //    Only the candidate side is normalised, never the defs name index: adding punctuation-stripped
  //    keys to the index would collide `X` with `X。` as same-named achievements, and both would be
  //    skipped as ambiguous — trading "fails to tick" for the risk of "ticks the wrong one", the
  //    opposite of the project-wide caution. The cost is that the reverse direction (the guide
  //    correct, Steam's name carrying punctuation) still fails to match, a known uncovered case.
  for (const c of [...candidates]) {
    const stripped = c.replace(TRAILING_PUNCT, '');
    if (stripped !== c) add(stripped);
  }

  return candidates;
}

/**
 * The unlocked achievements, with Chinese and English names taken from the achievements table
 * (formerly getUnlockedAchievements).
 * Returning [] means unlock data cannot currently be read for this game, and the caller decides how
 * to log it.
 */
export async function getUnlockedAchievements(db, steam, appid) {
  const raw = await steam.fetchPlayerAchievements(appid);
  if (raw.retry) throw new Error(msg('guides.noUnlockData', { appid }));
  if (raw.noAchievementSystem) throw new Error(msg('guides.noAchData', { appid }));

  const meta = Object.fromEntries(
    achievementsFor(db, appid).map((a) => [
      a.api_name,
      { nameCn: a.name_cn, nameEn: a.name_en, description: a.description },
    ])
  );

  return raw.achievements
    .filter((a) => a.achieved === 1)
    .map((a) => ({
      apiname: a.apiname,
      unlocktime: a.unlocktime,
      nameCn: meta[a.apiname]?.nameCn ?? '',
      nameEn: meta[a.apiname]?.nameEn ?? '',
      description: meta[a.apiname]?.description ?? '',
    }));
}

/**
 * Find the achievement names that **cannot be safely distinguished by name**.
 *
 * Some games have **several achievements with identical names** (in both languages) — 鬼谷八荒 has
 * two called `妙手空空 / Skilled Thief`, one for "steal covertly 10 times" and one for "finish the
 * game having stolen 100 times". The guide's author distinguishes them with a suffix, but the
 * achievement names themselves are identical, so **name matching cannot tell them apart in principle**.
 *
 * The dangerous combination is this: of N same-named achievements, only some are unlocked. Once the
 * unlocked one's checkbox is ticked it leaves the candidate pool, so the same name goes on to match
 * the checkbox of **another, not-yet-unlocked** achievement — a wrong tick.
 * (This is the class of bug already paid for twice, except that this time it is "identical names"
 * rather than "a prefix", which exact matching cannot stop.)
 *
 * The rule: if **all** same-named achievements are unlocked, any pairing is correct and matching
 * proceeds as normal; with only some unlocked, the whole name is abandoned — a missed tick over a
 * wrong one.
 */
export function findAmbiguousNames(db, appid, unlockedApiNames) {
  const byName = new Map();
  for (const a of achievementsFor(db, appid)) {
    for (const raw of [a.name_cn, a.name_en]) {
      const key = normalizeText(raw);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(a.api_name);
    }
  }
  const unsafe = new Set();
  for (const [name, apiNames] of byName) {
    const uniq = [...new Set(apiNames)];
    if (uniq.length > 1 && !uniq.every((n) => unlockedApiNames.has(n))) unsafe.add(name);
  }
  return unsafe;
}

/**
 * Whether this same-named group already has as many boxes ticked as it should.
 *
 * Used to decide **whether to notify the user**, and never participating in any write decision —
 * which is why loose substring matching is acceptable here while it is categorically not in the tick
 * path (see the file header). The difference: getting this wrong costs one log line more or fewer;
 * getting the tick path wrong writes something wrong into the user's notes.
 *
 * The logic: how many boxes bearing this name in the guide are already ticked (T), and how many
 * same-named achievements are unlocked (U). T >= U means everything that should be ticked is ticked,
 * there is nothing to do, and no notice is needed.
 * (Unlocking a second same-named achievement makes U 2 while T is still 1, and notices resume —
 * which is exactly when one is needed.)
 */
function nameGroupAlreadySatisfied(ach, unlocked, todos) {
  const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  for (const rawName of [ach.nameCn, ach.nameEn]) {
    const name = flat(rawName);
    if (!name) continue;
    const withName = todos.filter((t) => flat(t.text).includes(name));
    if (withName.length === 0) continue;
    const ticked = withName.filter((t) => t.checked).length;
    const unlockedInGroup = unlocked.filter(
      (a) => flat(a.nameCn) === name || flat(a.nameEn) === name
    ).length;
    if (ticked >= unlockedInGroup) return true;
  }
  return false;
}

/**
 * Pair unlocked achievements with the checkbox list. One checkbox is claimed by one achievement, and
 * an achievement stops once it has matched one.
 * Names in unsafeNames are skipped outright; see findAmbiguousNames.
 */
export function matchAchievements(unlocked, todos, { unsafeNames = new Set(), defs = [] } = {}) {
  const pending = todos.filter((t) => !t.checked);
  const claimed = new Set();
  const matches = [];
  const matchedApiNames = new Set();

  const nameIsUnsafe = (n) => Boolean(n) && unsafeNames.has(n);
  const hasUnsafeName = (ach) =>
    nameIsUnsafe(normalizeText(ach.nameCn)) || nameIsUnsafe(normalizeText(ach.nameEn));

  /**
   * Which of this achievement's names remain usable for equality matching.
   *
   * The gate closes **per name**, not per achievement — a distinction with measured evidence behind
   * it: Steam's localisation frequently collides in one language only. Plague Inc has two
   * achievements both called 「生化武器大师」 in Chinese while their English names are Nano-Virus
   * Master and Bioweapon Master; 犹格索托斯的庭院 is the inverse, with four achievements whose
   * English names are all the placeholder "Text" and whose Chinese names all differ. Of the 12 games
   * in the library with a name collision, 9 collide in one language only. Condemning the whole
   * achievement would discard a name that was unique all along.
   *
   * The colliding name itself remains entirely unusable: what cannot distinguish the twins is the
   * **name**, not the achievement. The equality rule itself is untouched — still exact, no
   * substrings, no prefixes.
   */
  const safeNamesOf = (ach) =>
    [normalizeText(ach.nameCn), normalizeText(ach.nameEn)].filter((n) => n && !nameIsUnsafe(n));

  // ── Pass one: for achievements with colliding names, try the **verbatim description** ──────
  // A same-named achievement can never be distinguished by that name, but if a checkbox quotes one
  // achievement's complete description and that description is unique within this game, then the box
  // is unambiguously about that achievement and can safely be ticked.
  // It runs first because the description is more precise than a name: letting it claim its own box
  // first prevents pass two's name matching from taking it.
  const ambiguous = unlocked.filter((a) => hasUnsafeName(a) && achName(a));
  const unresolved = [];
  for (const ach of ambiguous) {
    const todo = pending.find((t) => {
      if (claimed.has(t.key)) return false;
      const hit = resolveTodoToAchievement(t.text, defs);
      // It must have matched **by description**: the name path returns null for a same-named achievement anyway, and stating it explicitly makes this harder to break
      return hit?.via === 'description' && hit.def.api_name === ach.apiname;
    });
    if (todo) {
      claimed.add(todo.key);
      matchedApiNames.add(ach.apiname);
      matches.push({ key: todo.key, achievement: ach, text: todo.text, via: 'description' });
    } else {
      // **Do not conclude "skipped" yet**: it may still have a non-colliding name that pass two can
      // rescue it by. Deciding early would report a rescued achievement in the log as "needs manual
      // review" anyway — a false alarm.
      unresolved.push(ach);
    }
  }

  // ── Pass two: exact name matching, using only the names that **do not collide** ────────────
  for (const ach of unlocked) {
    if (matchedApiNames.has(ach.apiname)) continue; // Already claimed in pass one
    const names = safeNamesOf(ach);
    if (!names.length) continue; // Both languages collide (or there is no name at all) → only the description can help

    for (const todo of pending) {
      if (claimed.has(todo.key)) continue;
      const norm = normalizeText(todo.text);
      if (!norm) continue;

      const candidates = extractTitleCandidates(norm);
      if (names.some((n) => candidates.includes(n))) {
        claimed.add(todo.key);
        matchedApiNames.add(ach.apiname);
        matches.push({ key: todo.key, achievement: ach, text: todo.text, via: 'name' });
        break;
      }
    }
  }

  // Only a colliding achievement unmatched by both passes counts as genuinely skipped.
  // nameGroupAlreadySatisfied reads only todos and unlocked and is unaffected by claimed, so moving
  // the judgement here changes nothing.
  matches.skippedAmbiguous = unresolved.filter(
    (a) => !matchedApiNames.has(a.apiname) && !nameGroupAlreadySatisfied(a, unlocked, todos)
  );
  return matches;
}

/**
 * The sub-step cascade: when an achievement is established as unlocked, tick the sub-step checkboxes
 * nested beneath it as well.
 *
 * This is the **only** way sub-steps can be ticked automatically — a sub-step (one shrine, one
 * technique, one side quest) is not an achievement, Steam has no data for it, and its name matches no
 * achievement, so name matching can never reach it.
 *
 * ⚠️ A known inaccuracy; read this before changing anything here. It assumes "the parent achievement
 * is unlocked ⇒ every sub-step listed under it was done", which holds for collect-them-all
 * achievements (「every technique failed at least once」) and **fails for any-of** achievements —
 * 「reach any ending」 with 9 endings listed beneath it does not mean all 9 were reached, so 8
 * undone boxes would be ticked. The code cannot distinguish the two, hence:
 *   - The user explicitly asked for it on by default (`--no-cascade` disables it)
 *   - Every cascaded tick is logged individually (with the word 子步骤), so sync_log can be reviewed afterwards
 *   - A full --dry-run should be reviewed by hand before going live
 * This is a rare place in this project that prefers over-ticking, contrary to the overall "a missed
 * tick over a wrong one" principle, and it is deliberate.
 *
 * "The parent achievement is unlocked" has two sources, and both are required:
 *   1. What is being ticked this run (matches) — just matched by name or description
 *   2. **Boxes already ticked** whose reverse lookup gives a unique achievement that is genuinely
 *      unlocked. Without this one, sub-steps under achievements ticked historically (the vast
 *      majority) could never cascade, and the feature would do nothing
 */
export function collectSubStepTicks(todos, matches, { defs = [], unlockedApiNames = new Set() } = {}) {
  const byParent = new Map();
  for (const t of todos) {
    if (t.parent === null || t.parent === undefined) continue;
    if (!byParent.has(t.parent)) byParent.set(t.parent, []);
    byParent.get(t.parent).push(t);
  }
  if (byParent.size === 0) return [];

  const roots = new Set(matches.map((m) => m.key));
  for (const t of todos) {
    if (!t.checked || roots.has(t.key)) continue;
    const hit = resolveTodoToAchievement(t.text, defs);
    if (hit && unlockedApiNames.has(hit.def.api_name)) roots.add(t.key);
  }

  const out = [];
  const seen = new Set();
  const walk = (key) => {
    for (const child of byParent.get(key) ?? []) {
      if (seen.has(child.key)) continue;
      seen.add(child.key);
      if (!child.checked) out.push(child);
      walk(child.key); // A sub-step with its own sub-steps continues downwards
    }
  };
  for (const key of roots) walk(key);
  return out;
}

// ---------------------------------------------------------------------------
// Auditing: find wrongly ticked checkboxes in reverse
// ---------------------------------------------------------------------------

/**
 * Reverse-resolve a checkbox to **which achievement it is about**. Returns {def, via} or null.
 *
 * The opposite direction from matchAchievements: that one is "achievement → find a box", this is
 * "box → find an achievement", and auditing needs the latter (to judge whether the achievement a
 * ticked box refers to is actually unlocked).
 *
 * Two tiers, each requiring **uniqueness** — an audit either gives a definite answer or none, and
 * never guesses:
 *   1. The checkbox text contains the achievement's **complete** description, and that description is unique within the game
 *   2. A candidate segment is exactly equal to an achievement name, and that name maps to exactly one achievement
 *
 * ⚠️ Never degrade this into "description prefix" matching. Tiered achievement families (deal
 * 100/500/1000 damage, complete X's report card) have identical opening text, and prefix matching
 * attributes a **correctly ticked lower tier** to a **not-yet-unlocked higher tier**, inventing a
 * pile of false "wrong ticks".
 * This is the class of bug this project has been guarding against throughout, and
 * test/matching.test.js pins the case.
 */
export function resolveTodoToAchievement(text, defs) {
  const flatText = flatCompare(text);
  const flat = flatCompare;

  // 1. The complete description, unique within the game — **in either language**
  //
  // An English guide quotes the English description and a Chinese one quotes the Chinese, so
  // matching one language only means this stage silently never fires on half the guides. It is not
  // resolved by asking which language the guide is in: the answer would have to be right, and rows
  // written before that was recorded carry an assumed value. Comparing against both needs no such
  // answer.
  //
  // **Uniqueness is counted in achievements, not in occurrences.** A game whose Chinese and English
  // descriptions happen to be the same string would otherwise contribute that key twice from one
  // achievement, read as a collision, and refuse a match that is in fact unambiguous.
  const descOwners = new Map();
  for (const d of defs) {
    for (const raw of [d.description, d.description_en]) {
      if (!isQuotableText(raw)) continue;
      const k = flat(raw);
      if (!descOwners.has(k)) descOwners.set(k, new Set());
      descOwners.get(k).add(d.api_name);
    }
  }
  const quotedUniquely = (raw) =>
    isQuotableText(raw) && descOwners.get(flat(raw))?.size === 1 && flatText.includes(flat(raw));

  // **One box can contain several achievements' complete descriptions at once**, because a tiered
  // family's lower tier is routinely a substring of its higher tier: Factorio quotes 「建造出内燃机
  // 车。」 inside 「在游戏90分钟内建造出内燃机车。」, and 「向太空发射火箭。」 inside both the 8-hour
  // and the 15-hour version. Taking whichever `defs` happened to list first therefore filed the
  // higher tier's box under the lower tier — the mis-attribution the note above forbids, arriving
  // by containment rather than by prefix.
  // The longest contained description wins: a proper substring of it is strictly weaker evidence
  // about the same sentence. Two different achievements matching at the same length is a real
  // ambiguity, and this stage answers those with nothing at all, leaving the name stage to try.
  let byDesc = null;
  let byDescLen = 0;
  let ambiguous = false;
  for (const d of defs) {
    for (const raw of [d.description, d.description_en]) {
      if (!quotedUniquely(raw)) continue;
      const len = flat(raw).length;
      if (len > byDescLen) {
        byDesc = d;
        byDescLen = len;
        ambiguous = false;
      } else if (len === byDescLen && d.api_name !== byDesc?.api_name) {
        // Both languages of one achievement can be the same length; that is one answer, not two
        ambiguous = true;
      }
    }
  }
  if (byDesc && !ambiguous) return { def: byDesc, via: 'description' };

  // 2. An exact name match where the name maps to exactly one achievement
  const byName = new Map();
  for (const d of defs) {
    for (const raw of [d.name_cn, d.name_en]) {
      const k = normalizeText(raw);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Map());
      byName.get(k).set(d.api_name, d);
    }
  }
  for (const cand of extractTitleCandidates(normalizeText(text))) {
    const hit = byName.get(cand);
    if (hit?.size === 1) return { def: [...hit.values()][0], via: 'name' };
  }

  return null;
}

/**
 * Reverse-resolve a whole guide: achievement → the entry that writes about it (the prose plus the
 * sub-steps nested under it).
 *
 * Its purpose differs from auditGuideTicks (that asks "was this ticked correctly", this asks "how do
 * I do this one"), but the direction and the standard of evidence are identical, and they share
 * resolveTodoToAchievement. **Do not loosen the matching just because "this is only display"** — the
 * same function also carries the job of writing ticks into the user's notes, and loosening it once
 * loosens it for both.
 * A blank card is preferable to pasting achievement A's method under achievement B.
 *
 * By SKILL.md's writing convention, the achievement name, the official description and the method
 * are **one block** in Notion (`<br>` is a newline within the block, which notionblocks.js
 * specifically guarantees), so the matched entry's `text` is itself the complete solution and there
 * is no need to scrape the surrounding paragraphs — the Dashboard can display it directly.
 *
 * When one achievement appears several times in a guide only the first is taken: a repeat is usually
 * a passing mention elsewhere rather than a second method, and putting both on the card only makes
 * it unclear which is the real one.
 *
 * @returns {Map<string, {key, text, checked, subSteps: {text, checked, depth}[]}>}
 */
export function mapAchievementGuides(todos, defs) {
  const byParent = new Map();
  for (const t of todos) {
    if (t.parent === null || t.parent === undefined) continue;
    if (!byParent.has(t.parent)) byParent.set(t.parent, []);
    byParent.get(t.parent).push(t);
  }

  const out = new Map();
  const claimed = new Set();
  for (const t of todos) {
    const hit = resolveTodoToAchievement(t.text, defs);
    if (!hit || out.has(hit.def.api_name)) continue;
    out.set(hit.def.api_name, { key: t.key, text: t.text, checked: t.checked, subSteps: [] });
    claimed.add(t.key);
  }

  // A sub-step = a box hanging under an achievement's box that does not itself resolve to any
  // achievement. Sub-steps can themselves carry sub-steps, so this descends all the way (the same
  // shape as collectSubStepTicks' walk), with depth left for the frontend's indentation.
  // Claimed boxes are skipped: those are their own achievement's prose, not a sub-step of the one above
  const seen = new Set();
  const walk = (key, depth, into) => {
    for (const child of byParent.get(key) ?? []) {
      if (seen.has(child.key) || claimed.has(child.key)) continue;
      seen.add(child.key);
      into.push({ text: child.text, checked: child.checked, depth });
      walk(child.key, depth + 1, into);
    }
  };
  for (const entry of out.values()) walk(entry.key, 0, entry.subSteps);
  return out;
}

/**
 * Strip the guide prose's opening echo of the achievement name and official description.
 *
 * The Dashboard's card already prints Steam's achievement name and description above, and by
 * SKILL.md's writing convention a checkbox's first two lines are exactly the name and the verbatim
 * official description — so the same information appears twice on one card and pushes the actually
 * useful method out of the window.
 *
 * **Only unambiguous echoes are removed, and only from the top.** Both tests require the line to be
 * **exactly** that thing:
 *
 *   - The name: the normalised line equals the Chinese or English name, or is of the form
 *     `中文名(English Name)`.
 *     **extractTitleCandidates must not be used for this judgement** — that function slices 「知识」
 *     out of `知识(Rationality) — "……" 集齐全部百科全书条目`, and deleting by it removes the whole
 *     method. It exists to *find a match*, not to confirm that a whole line is an echo.
 *   - The description: the line equals Steam's description **verbatim**. A paraphrase is always
 *     kept — those are the user's own words, and for a hidden achievement that line is often the
 *     **only place on the whole card** stating the unlock condition (Steam supplies no description
 *     at all). A line deleted in error cannot be recovered while a line kept is merely verbose, and
 *     that asymmetry sets how strict the tests are.
 *
 * **Stripping to nothing returns an empty string**, and the caller then simply does not draw the
 * guide window. This is not "information lost": such an entry only ever copied the official name and
 * description without writing any method, and both are already above on the card.
 * This used to be `rest || raw` (returning the original when empty), justified as "never show an
 * empty card" — which was the wrong reason, since the card still has the name, the description and
 * the jump control, and only the window is empty. Its actual effect was that **an entry that copied
 * nothing but the official text became the most thoroughly redundant card on screen.**
 */
export function stripGuideEcho(text, { names = [], description = '' } = {}) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  const nameKeys = new Set(names.map((n) => normalizeText(n)).filter(Boolean));
  const descKey = normalizeText(description).replace(TRAILING_PUNCT, '');

  const isNameEcho = (line) => {
    const bare = normalizeText(line);
    if (!bare || !nameKeys.size) return false;
    if (nameKeys.has(bare)) return true;
    const m = bare.match(PAREN_PAIR);           // 中文名(English Name)
    return Boolean(m) && (nameKeys.has(m[1]) || nameKeys.has(m[2]));
  };

  let i = 0;
  let tookName = false;
  let tookDesc = false;
  while (i < lines.length) {
    const key = normalizeText(lines[i]);
    if (!key) { i++; continue; }                                    // Blank lines are consumed along with them
    if (!tookName && isNameEcho(lines[i])) { tookName = true; i++; continue; }
    if (!tookDesc && descKey && key.replace(TRAILING_PUNCT, '') === descKey) {
      tookDesc = true; i++; continue;
    }
    break;                                       // Once a line is not an echo, nothing after it is touched
  }

  return lines.slice(i).join('\n').trim();
}

/**
 * A read-only audit: find checkboxes that are ticked while the achievement is not actually unlocked
 * on Steam.
 *
 * The opposite direction from checkboxSync (that finds missing ticks, this finds wrong ones), and it
 * **writes nothing**.
 * Only games below 100% are audited — in a fully completed game every achievement is unlocked, so no
 * tick can be wrong.
 *
 * A box that cannot be resolved to a specific achievement is counted but not judged: a missed report
 * is preferable to a false one. The number is reported honestly in the result, so that "the audit
 * passed" cannot look like broader coverage than it is.
 */
export async function auditGuideTicks(
  db,
  steam,
  { notion, config, appid = null, onProgress = () => {} }
) {
  const guideByAppid = Object.fromEntries(allGuides(db).map((g) => [g.appid, g]));
  const targets = allGames(db).filter((g) => {
    if (!guideByAppid[g.appid]) return false;
    if (appid && g.appid !== String(appid)) return false;
    return typeof g.total === 'number' && g.total > 0 && g.achieved < g.total;
  });

  const results = [];
  const totals = { games: 0, ticked: 0, wrong: 0, unresolved: 0, skipped: 0 };

  for (const [i, g] of targets.entries()) {
    onProgress({ done: i + 1, total: targets.length, name: g.name });
    const entry = { appid: g.appid, name: g.name, wrong: [], ticked: 0, unresolved: 0, skipped: null };

    const defs = achievementsFor(db, g.appid);
    if (defs.length === 0) {
      entry.skipped = schemaMissingReason(db, g.appid);
      results.push(entry);
      totals.skipped++;
      continue;
    }

    let todos;
    try {
      todos = await backendFor(guideByAppid[g.appid], { notion, config }).loadTodos();
    } catch (err) {
      entry.skipped = msg('guide.unreadable', { reason: err.message });
      results.push(entry);
      totals.skipped++;
      continue;
    }

    const raw = await steam.fetchPlayerAchievements(g.appid);
    if (raw.retry || raw.noAchievementSystem) {
      entry.skipped = msg('guide.noUnlockState');
      results.push(entry);
      totals.skipped++;
      continue;
    }
    const unlocked = new Map(raw.achievements.map((a) => [a.apiname, a.achieved === 1]));

    for (const t of todos.filter((x) => x.checked)) {
      const hit = resolveTodoToAchievement(t.text, defs);
      // A sub-step box (one shrine, one side quest) was never "an achievement's box", and failing to
      // resolve it is normal. Those must not be counted in the "could not resolve" figure — a guide
      // with much nesting would drown it in sub-steps, while the point of that number is "how many
      // **genuine achievement boxes** the audit could not cover". A nested box that does resolve to
      // an achievement is audited as normal.
      if (!hit && t.parent !== null && t.parent !== undefined) continue;
      entry.ticked++;
      if (!hit) {
        entry.unresolved++;
        continue;
      }
      if (unlocked.get(hit.def.api_name) === false) {
        entry.wrong.push({
          apiName: hit.def.api_name,
          name: achName(hit.def),
          text: t.text,
          via: hit.via,
        });
      }
    }

    totals.games++;
    totals.ticked += entry.ticked;
    totals.wrong += entry.wrong.length;
    totals.unresolved += entry.unresolved;
    results.push(entry);
    await sleep(200);
  }

  return { results, totals, candidates: targets.length };
}

// ---------------------------------------------------------------------------
// The two backends
// ---------------------------------------------------------------------------

export function backendFor(guide, { notion, config }) {
  if (guide.kind === 'local') {
    const path = md.resolveGuidePath(config.guidesDir, guide.url);
    return {
      label: msg('guide.localBackend'),
      loadTodos: async () => md.loadTodos(path),
      applyChecks: async (keys) => md.applyChecks(path, keys),
      // The validator needs the full text for the `# 游戏名` rule, the heading-statistics rule and
      // the data-source rule. The Notion side cannot produce a whole page's source, so it returns
      // null and lintGuide automatically skips the rules that depend on it
      loadText: async () => readFileSync(path, 'utf8'),
    };
  }
  const pageId = extractNotionPageId(guide.url);
  return {
    label: 'Notion',
    loadTodos: () => notion.fetchAllToDoBlocks(pageId),
    loadText: async () => null,
    applyChecks: async (keys) => {
      let n = 0;
      for (const key of keys) {
        await notion.checkTodo(key);
        n++;
        await sleep(120);
      }
      return n;
    },
  };
}

/**
 * Checkbox sync for one game. Returns log rows [{ts, appid, gameName, achievement, result}].
 * Errors do not throw and are recorded as log rows instead — one game failing must not interrupt the
 * whole daily sync.
 */
export async function syncGameCheckboxes(db, steam, guide, gameName, { notion, config, dryRun = false, cascade = true }) {
  const logs = [];
  /**
   * One row of the sync log.
   *
   * **`code` is the interface; `result` is prose for a person to read.** The callers used to tell
   * these rows apart with `result.startsWith('已勾选')`, which is treating human text as an API —
   * the same coupling this file already warns about for `applied`. It survived only for as long as
   * there was one language: the moment the prose could be English, every one of those filters
   * silently matched nothing and the summary reported zero ticks on a run that ticked plenty.
   */
  const push = (achievement, result, code) =>
    logs.push({ ts: nowIso(), appid: guide.appid, gameName, achievement, result, code });

  let unlocked;
  try {
    unlocked = await getUnlockedAchievements(db, steam, guide.appid);
  } catch (err) {
    push('', msg('sync.skipNoSteam', { reason: err.message }), 'skip-no-steam');
    return logs;
  }
  if (unlocked.length === 0) return logs;

  let backend;
  try {
    backend = backendFor(guide, { notion, config });
  } catch (err) {
    push('', msg('sync.skipBadPath', { reason: err.message }), 'skip-bad-path');
    return logs;
  }

  let todos;
  try {
    todos = await backend.loadTodos();
  } catch (err) {
    push('', msg('sync.skipUnreadable', { label: backend.label, reason: err.message }), 'skip-unreadable');
    return logs;
  }

  if (todos.length === 0) {
    push('', msg('sync.skipNoCheckbox'), 'skip-no-checkbox');
    return logs;
  }

  const defs = achievementsFor(db, guide.appid);
  const unsafeNames = findAmbiguousNames(db, guide.appid, new Set(unlocked.map((a) => a.apiname)));
  const matches = matchAchievements(unlocked, todos, { unsafeNames, defs });

  // A skip caused by same-named achievements must be recorded: a silent missed tick looks exactly
  // like "there was nothing to tick", and over time that makes the sync appear healthy while it has
  // been missing things all along
  for (const a of matches.skippedAmbiguous ?? []) {
    push(achName(a), msg('sync.ambiguousName'), 'skip-ambiguous');
  }
  // The sub-step cascade. Note it does **not** require matches to be non-empty: the vast majority of
  // achievements were ticked long ago, and "no new achievement to tick this run while the sub-steps
  // beneath are still empty" is the commonest case of all
  const subSteps = cascade
    ? collectSubStepTicks(todos, matches, {
        defs,
        unlockedApiNames: new Set(unlocked.map((a) => a.apiname)),
      })
    : [];

  if (matches.length === 0 && subSteps.length === 0) return logs;

  // Dry-run mode: read the page, compute what would be ticked, and write nothing (a tick in Notion
  // cannot be undone automatically, so the first run — or any run after the matching rules change —
  // should be inspected with --dry-run first)
  if (dryRun) {
    for (const m of matches) {
      push(achName(m.achievement), msg('sync.wouldTick', { text: m.text.slice(0, 60) }), 'would-tick');
    }
    for (const s of subSteps) {
      push('', msg('sync.wouldTickSub', { text: s.text.replace(/\n/g, ' ').slice(0, 60) }), 'would-tick');
    }
    return logs;
  }

  try {
    await backend.applyChecks([...matches.map((m) => m.key), ...subSteps.map((s) => s.key)]);
    for (const m of matches) {
      push(achName(m.achievement), msg('sync.ticked', { text: m.text.slice(0, 60) }), 'ticked');
    }
    // Sub-steps are logged separately: they were not ticked by matching an achievement but inferred
    // from the parent's cascade, and reviewing "why was this box ticked" afterwards has to
    // distinguish the two at a glance
    for (const s of subSteps) {
      push('', msg('sync.tickedSub', { text: s.text.replace(/\n/g, ' ').slice(0, 60) }), 'ticked');
    }
  } catch (err) {
    push('', msg('sync.tickFailed', { reason: err.message }), 'tick-failed');
  }
  return logs;
}

/**
 * Select which games' guide pages to read this run. **Extracted so that it can be tested** — the
 * same reasoning as selectStatsTargets: loosening it here wastes dozens of Notion and Steam calls,
 * tightening it silently misses ticks, and neither raises an error.
 *
 * The base conditions: it has a guide link, it has an achievement system, and achieved < total
 * (games already at 100% are skipped). The judgement uses our own achievement counts rather than
 * Notion's Status property — re-running a completed game is merely a no-op.
 *
 * The two narrowing parameters mean different things and must not be conflated:
 * - `appid`: the CLI's "just this one game".
 * - `appids`: an allow-list array, which serve's automatic sync uses to reduce the candidates to
 *   "the rows that genuinely changed this run".
 *   **An empty array means run nothing**, not "no restriction" — no restriction is null. Writing
 *   something like `appids?.length ? … : everything` translates "nothing changed this time" into
 *   "so run the full set", which is precisely what this parameter exists to avoid.
 */
export function selectCheckboxCandidates(db, { appid = null, appids = null, cascade = true } = {}) {
  const only = appids === null ? null : new Set(appids.map(String));
  const guideByAppid = Object.fromEntries(allGuides(db).map((g) => [g.appid, g]));
  const games = allGames(db).filter((g) => {
    if (!guideByAppid[g.appid]) return false;
    if (appid && g.appid !== String(appid)) return false;
    if (only && !only.has(g.appid)) return false;
    if (typeof g.total !== 'number' || g.total <= 0) return false;
    if (g.achieved >= g.total) {
      // A game already at 100%. **It is only worth reading when achievement detail exists**: whether
      // by name matching or by resolveTodoToAchievement recognising the parent, both need the names
      // and descriptions in the achievements table.
      // And syncAchievementSchema deliberately skips games at exactly 100% — measured, all 55 of the
      // long-completed ones have no detail. Without this gate, every run would fetch 55 pages and
      // make 55 Steam requests for nothing, ticking not one box. Should detail ever be synced for a
      // completed game, this takes effect automatically.
      if (achievementsFor(db, g.appid).length === 0) return false;
      // With detail present, the remaining question is whether this trip is worth making:
      // - the sub-step cascade is on → worth it, since every achievement is unlocked while the
      //   sub-steps beneath may still be empty
      // - **this row was named into this run** (the appids allow-list) → worth it, and necessary:
      //   it has only just been completed, and the last few achievements' boxes are almost certainly
      //   still empty. Without this condition, the checkbox for "the achievement that completed the
      //   game" would never be ticked automatically — not once, because by the time we next look it
      //   is at 100% and is excluded here.
      return cascade || only !== null;
    }
    return true;
  });
  return { games, guideByAppid };
}

/** The daily checkbox sync (formerly dailyCheckboxSync). The candidate rules are in selectCheckboxCandidates. */
export async function checkboxSync(
  db,
  steam,
  { notion, config, appid = null, appids = null, dryRun = false, cascade = true, onProgress = () => {} }
) {
  const { games: candidates, guideByAppid } = selectCheckboxCandidates(db, { appid, appids, cascade });

  const allLogs = [];
  for (const [i, g] of candidates.entries()) {
    onProgress({ done: i + 1, total: candidates.length, name: g.name });
    const logs = await syncGameCheckboxes(db, steam, guideByAppid[g.appid], g.name, {
      notion,
      config,
      dryRun,
      cascade,
    });
    allLogs.push(...logs);
    await sleep(350); // Leave headroom for the Notion API and avoid a 429
  }

  // A dry run writes no sync_log, so the audit table never contains things that did not happen
  if (!dryRun) appendSyncLog(db, allLogs);
  return { checked: candidates.length, logs: allLogs, dryRun };
}

// ---------------------------------------------------------------------------
// Guide status: keep the Notion page status in step with completion (complete → Done, dropped below 100% → Staged)
// ---------------------------------------------------------------------------

export const GUIDE_STATUS_DONE = 'Done';
export const GUIDE_STATUS_STAGED = 'Staged';

/**
 * Which guide pages' status should change. **A pure function, testable** — the same reasoning as
 * selectCheckboxCandidates.
 *
 * The test is **current state**, not "this run happened to cross 100%". Deliberately: crossing that
 * threshold exists only for the instant updateGameStats writes it, and missing it once (a CLI sync
 * with no Notion token, a process interrupted with Ctrl+C, a machine with Notion unconfigured) means
 * it can never be recovered — the next look sees the same value on both sides and can infer nothing.
 * Converging on state has no such problem: any number of runs gives the same result, and a missed
 * one is picked up next time.
 *
 * Measured, this is more than tidiness: the one page that needed demoting (Supermarket Together,
 * 28/51) has an empty `new_ach_date`, so a rule triggered by "we saw total go up" would **never**
 * have fired for it.
 *
 * The two directions are deliberately asymmetric in how aggressive they are:
 * - **Promoting to Done**: overwrites every status except Done (completion decides).
 * - **Demoting to Staged**: touches only pages at Done. A page below 100% sitting at Paused /
 *   In progress / Not started / Differed is a workflow state you chose, and there is no reason to
 *   change it — and overwriting it on every Dashboard open would have you and the machine changing
 *   it back and forth indefinitely.
 *
 * Only kind='notion' guides are handled. Local markdown has no concept of a status property.
 */
export function selectGuideStatusUpdates(
  db,
  pages,
  { doneName = GUIDE_STATUS_DONE, stagedName = GUIDE_STATUS_STAGED } = {}
) {
  const byPageId = new Map();
  for (const g of allGuides(db)) {
    if (g.kind !== 'notion') continue;
    const id = normalizeNotionId(g.url);
    if (id) byPageId.set(id, g);
  }

  const updates = [];
  for (const page of pages) {
    // Page identity always goes through the normalised ID and never compares raw URLs (see the comment on normalizeNotionId)
    const id = normalizeNotionId(page.id) || normalizeNotionId(page.url);
    const guide = id ? byPageId.get(id) : null;
    if (!guide) continue; // A guide page with no registered appid (the guide is unfinished) is not this function's concern

    const game = getGame(db, guide.appid);
    if (!game) continue;
    // No achievement system, or never synced: neither allows completion to be derived, so nothing is
    // touched. This condition also excludes several kinds of false "dropped below 100%":
    // markNoAchievements clears total to NULL, while rate limits and 403s take the retry path and
    // write nothing at all, so those cases never reach here.
    if (typeof game.total !== 'number' || game.total <= 0) continue;
    if (typeof game.achieved !== 'number') continue;

    const perfect = game.achieved >= game.total;
    const name = game.name || page.title;
    const common = { appid: guide.appid, pageId: page.id, name, from: page.status };

    if (perfect && page.status !== doneName) {
      updates.push({ ...common, to: doneName, reason: 'complete' });
    } else if (!perfect && page.status === doneName) {
      // Almost always a developer patch adding achievements and pushing a completed game below 100%
      updates.push({ ...common, to: stagedName, reason: 'incomplete' });
    }
  }
  return updates;
}

/**
 * Keep guide page status in step with completion, in both directions:
 *   - Completed → Done (overwriting every status except Done; completion decides)
 *   - Dropped below 100% → Staged (**only pages at Done**; other statuses are workflow states a person chose, and are not touched)
 * Dropping below 100% is essentially always a developer patch adding achievements.
 */
export async function syncGuideStatuses(db, { notion, dryRun = false, onProgress = () => {} }) {
  const schema = await notion.fetchGuideStatusSchema();
  if (!schema) {
    throw new Error(msg('guides.noStatusProp'));
  }
  // A mismatched option name produces a barely readable 400 from Notion, so it is better to state it
  // plainly first. Both must be checked: with Done present but Staged missing, the demotion half
  // would fail only at the moment it is genuinely needed.
  if (schema.options.length) {
    const missing = [GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED].filter((o) => !schema.options.includes(o));
    if (missing.length) {
      throw new Error(msg('guides.missingOptions', {
        property: schema.property,
        missing: missing.join('、'),
        existing: schema.options.join('、'),
      }));
    }
  }

  const pages = await notion.queryGuideDatabase();
  const updates = selectGuideStatusUpdates(db, pages);
  const logs = [];
  const applied = [];
  // Same rule as the checkbox log above: the code is what callers read
  const push = (u, result, code) =>
    logs.push({ ts: nowIso(), appid: u.appid, gameName: u.name, achievement: '', result, code });
  const why = (u) => msg(u.reason === 'complete' ? 'status.whyComplete' : 'status.whyIncomplete');

  for (const [i, u] of updates.entries()) {
    onProgress({ done: i + 1, total: updates.length, name: u.name });
    const shown = u.from || msg('status.emptyFrom');
    if (dryRun) {
      push(u, msg('status.wouldChange', { from: shown, to: u.to, why: why(u) }), 'would-change');
      continue;
    }
    try {
      await notion.setPageStatus(u.pageId, { property: schema.property, type: schema.type, value: u.to });
      applied.push(u);
      push(u, msg('status.changed', { from: shown, to: u.to, why: why(u) }), 'changed');
    } catch (err) {
      // One page failing must not stop the rest from running
      push(u, msg('status.changeFailed', { reason: err.message }), 'status-failed');
    }
    await sleep(350);
  }

  if (!dryRun) appendSyncLog(db, logs);
  // applied holds the ones that **genuinely succeeded** (updates still includes the failures). The
  // caller uses it for its notice rather than parsing the log text — that coupling breaks on a
  // single reworded character
  return { pages: pages.length, updates, applied, logs, dryRun };
}

// ---------------------------------------------------------------------------
// Guide discovery: the Notion database and the local guides directory
// ---------------------------------------------------------------------------

/**
 * Formerly syncGuidesFromNotion: query the guide database for every page, read the blocks of any
 * page not yet registered, and register it into the guides table if it carries an
 * "appid: NNNNNN" line.
 * Deduplication must go by the normalised Notion page ID and never by the raw URL (see the comment
 * on normalizeNotionId).
 */
export async function syncGuidesFromNotion(db, notion) {
  const existingIds = new Set(
    allGuides(db)
      .map((g) => normalizeNotionId(g.url))
      .filter(Boolean)
  );

  const pages = await notion.queryGuideDatabase();
  const newPages = pages.filter((p) => {
    const id = normalizeNotionId(p.id) || normalizeNotionId(p.url);
    return !id || !existingIds.has(id);
  });

  const added = [];
  const failed = [];
  for (const page of newPages) {
    try {
      const appid = await notion.extractAppIdFromPageContent(page.id);
      if (appid) {
        upsertGuide(db, { appid, name: page.title, url: page.url, kind: 'notion' });
        added.push({ appid, name: page.title });
      }
    } catch (err) {
      failed.push({ title: page.title, error: err.message });
    }
    await sleep(350);
  }

  if (added.length || failed.length) {
    appendSyncLog(db, [
      {
        ts: nowIso(),
        result:
          msg('sync.guideLinksAdded', { n: added.length }) +
          (added.length ? ': ' + added.map((a) => `${a.name}(${a.appid})`).join(', ') : '') +
          (failed.length ? msg('sync.guidePagesFailed', { n: failed.length }) : ''),
      },
    ]);
  }

  return { dbPages: pages.length, newPagesChecked: newPages.length, added, failed };
}

/**
 * A local guide's header: the `appid:` line and the `# 游戏名` line.
 *
 * **Only the first 15 lines are read**, as before this function was extracted — the string `appid:`
 * appearing in the body (a guide explaining how to find an appid, say) must not change what gets
 * registered.
 *
 * It was extracted because the archive panel needs the same answer: filenames in `.migrated/` and
 * `.drafts/` carry no appid, so it can only be read from the body. Two separate regexes would
 * eventually produce "the archive panel recognises this file and guide discovery does not".
 */
export function readGuideHeader(text) {
  const head = String(text ?? '').split('\n').slice(0, 15).join('\n');
  return {
    appid: head.match(/^appid:\s*(\d+)/im)?.[1] ?? null,
    title: head.match(/^#\s*(.+)$/m)?.[1]?.trim() ?? '',
  };
}

/**
 * Added for the local build: scan the .md files in guides/ and register them into the guides table
 * by the same "appid: NNNNNN" line (kind='local'). Symmetrical with Notion's discovery, so local
 * markdown guides need no hand-maintained link table either.
 */
export function syncGuidesFromMarkdown(db, config, { force = false } = {}) {
  // guidesDir need not exist: the repository may have no local guides, or guidesDir may point at a
  // directory not yet created. That is not an error — it is treated as "there are no local guides".
  // Throwing would abort serve's guide discovery entirely, so even the Notion discovery afterwards
  // would never run.
  if (!existsSync(config.guidesDir)) return { files: 0, added: [], skipped: [], conflicts: [] };
  const files = readdirSync(config.guidesDir).filter((f) => f.endsWith('.md'));
  const added = [];
  const skipped = [];
  const conflicts = [];

  for (const file of files) {
    const header = readGuideHeader(readFileSync(join(config.guidesDir, file), 'utf8'));
    if (!header.appid) {
      skipped.push(file);
      continue;
    }
    const appid = header.appid;
    const title = header.title || file;

    // One appid can have only one guide backend. A game already registered with a Notion page is
    // left alone by default — Notion is the primary usage, and a local .md happening to exist too
    // must not quietly switch the link (use --force to switch).
    const existing = getGuide(db, appid);
    if (existing && existing.kind === 'notion' && !force) {
      conflicts.push({ appid, file, notionUrl: existing.url });
      continue;
    }

    const action = upsertGuide(db, { appid, name: title, url: file, kind: 'local' });
    added.push({ appid, name: title, file, action });
  }

  return { files: files.length, added, skipped, conflicts };
}
