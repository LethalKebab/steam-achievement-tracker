/**
 * Partial rewrite — the selection set, entry location, and fault attribution
 * ------------------------------------------------
 * "Rewrite the whole guide" and "rewrite only the entries named" share one pipeline, and every
 * difference between them is confined to this file: **which entries to change** (resolveScope),
 * **which boxes those are in the guide** (scopeEntries), and **which of the problems found
 * afterwards are this change's fault** (classifyFindings).
 *
 * This file has **no I/O, knows no provider and touches no backend**. That is not fastidiousness:
 * the one genuinely dangerous thing about a partial rewrite is whether the content is spliced back
 * in the right place, and that has to be testable case by case with no network, no key and no
 * Notion. The orchestration is in lib/guidepatch.js.
 *
 * ## One trade-off runs through the whole file
 *
 * **Change one entry too few rather than one too many.**
 *
 * A whole-guide rewrite can fail by writing something worse; a partial rewrite has an additional,
 * worse failure: **altering text the user did not name**. No machine can detect that afterwards —
 * the guide looks complete, and one passage has simply become this run's improvisation, possibly
 * replacing something the user edited by hand. So wherever there is doubt: report rather than guess
 * when an entry cannot be located, leave it in place rather than widen when a range cannot reach,
 * and do not charge pre-existing problems to this change. All three point the same way.
 */

import { mapAchievementGuides, normalizeText, resolveTodoToAchievement } from './guides.js';
import { msg } from './messages.js';

/**
 * The default threshold for "rare": a global unlock rate below 10%.
 *
 * Aligned with `rarityTag`'s bands in the prompt (🔴 <5% / 🟠 <10%), and **deliberately the same
 * line**: the prompt says the 🔴🟠 entries are where a guide's value actually lies, so "rewrite
 * only the valuable ones" should select exactly that set. Two separately defined thresholds would
 * make the bands the user reads diverge from the set actually selected.
 *
 * **10%, and it must not be relaxed to 15%.** 15% is too loose: in a 51-achievement game 27 entries
 * fall inside it — more than half would be called "rare", at which point the word denotes nothing
 * and allocating effort by it is not allocating effort at all.
 *
 * `rarityTag`'s middle band **imports this constant** rather than each keeping its own: two
 * separate numbers produce "the interface says it is rare and the prompt says it is not". The
 * CLI's help text and the Dashboard's fallback still write the literal separately (one is a help
 * string, the other a fallback for when the server did not supply it), with a test pinning them equal.
 */
export const RARE_PCT = 10;

/**
 * The selector names. An explicit achievement list is not here — that is the fallback branch for
 * "none of these names".
 *
 * **This set and the row of scope buttons on the Dashboard are the same thing**, exactly. `all`,
 * `thin` and `unlocked` are **deliberately absent**, for different reasons with the same result:
 * the interface cannot offer them, so "what can this feature do" would have two answers in two
 * places and the documentation could only state one.
 *
 *   - `all`      — a whole-guide rewrite has its own entry point (`--overwrite`); this would be a
 *                  second, nearly identical path
 *   - `thin`     — its criterion cannot be stated clearly, so it cannot be a button (see the passage in guidepatch.js)
 *   - `unlocked` — "rewrite the achievements I have already earned" is a request nobody has made; `locked` is
 *   - `failing`  — "currently failing validation and fixable by a rewrite". In the real corpus that
 *                  set is almost always empty, and an option permanently showing 0 makes a person
 *                  work out what that 0 means every time. When it is genuinely needed,
 *                  `guide-lint <appid>` lists them more clearly and the entries can then be named
 *
 * Before adding another selector, ask: **what does it look like on the Dashboard?** If there is no
 * answer, do not add it yet.
 */
export const SELECTOR_KINDS = new Set(['rare', 'locked', 'section']);

/**
 * Parse what the user said into a set of api_names.
 *
 * **`unresolved` in the return value matters as much as `apiNames`.** An unrecognised name must be
 * reported and must not disappear silently from the set — the user naming five entries, the program
 * changing four, and the report saying "done" is this feature's worst failure, because they only
 * discover the missing one the next time they read the guide.
 *
 * @param {object}   o
 * @param {string}   o.selector  'rare[:pct]' | 'locked' | 'section:name' |
 *                               a comma-separated list of achievement names / api_names
 * @param {Array}    o.defs
 * @param {Array}    o.todos     the existing guide's checkboxes (the same shape from both backends)
 * @param {Map|null} [o.rarity]  api_name → global unlock rate
 * @param {Set}      [o.unlocked]
 * @param {string|null} [o.text] the guide's full text. Only the local backend can supply it, and `section:` needs it
 * @returns {{apiNames: string[], unresolved: string[], kind: string, arg: string|null}}
 */
export function resolveScope({
  selector,
  defs,
  todos,
  rarity = null,
  unlocked = new Set(),
  text = null,
}) {
  const raw = String(selector ?? '').trim();
  if (!raw) {
    const err = new Error(msg('scope.nothingNamed'));
    err.code = 'empty-scope';
    throw err;
  }

  const [head, ...restArg] = raw.split(':');
  const kind = head.trim().toLowerCase();
  const arg = restArg.length ? restArg.join(':').trim() : null;
  const inDefsOrder = (set) => defs.filter((d) => set.has(d.api_name)).map((d) => d.api_name);

  if (SELECTOR_KINDS.has(kind)) {
    // A computed selector never produces an unresolved entry — it filters against defs and the
    // guide itself, so finding nothing means "no achievement matches", which is an empty set
    // rather than an unrecognised name
    const picked = new Set();
    const byApiName = mapAchievementGuides(todos, defs);

    if (kind === 'rare') {
      const pct = arg === null ? RARE_PCT : Number(arg);
      if (!Number.isFinite(pct)) {
        const err = new Error(msg('scope.badRare', { arg }));
        err.code = 'bad-scope';
        throw err;
      }
      // With no unlock rates available this **raises an error rather than selecting an empty set**:
      // `--only rare` quietly selecting nothing looks exactly like "this game has no hard
      // achievements", when the truth is that Steam did not answer this time
      if (!rarity || rarity.size === 0) {
        const err = new Error(msg('scope.noGlobalRates'));
        err.code = 'no-rarity';
        throw err;
      }
      for (const d of defs) {
        const p = rarity.get(d.api_name);
        if (p !== undefined && p !== null && p < pct) picked.add(d.api_name);
      }
    } else if (kind === 'locked') {
      // "The ones not yet earned". The inverse (rewriting already-unlocked entries) has never been
      // requested, so it is not offered
      for (const d of defs) if (!unlocked.has(d.api_name)) picked.add(d.api_name);
    } else if (kind === 'section') {
      if (!arg) {
        const err = new Error(msg('scope.badSection'));
        err.code = 'bad-scope';
        throw err;
      }
      if (text === null) {
        /**
         * **This limitation belongs to this function, not to Notion.**
         *
         * It used to say "section structure cannot be read from a guide on Notion", which was
         * wrong: what was wrong was the function being consulted. `fetchAllToDoBlocks` collects
         * checkboxes only, so headings do not exist as far as it is concerned; `fetchAllBlocks`
         * returns every block on the page including headings — and that is exactly what the
         * Dashboard's picker uses to group a Notion guide by section (see `blocksToOutline`).
         *
         * The refusal remains because `resolveScope` receives only `text` (the local full text) and
         * never the blocks. Supporting Notion's `section:` on the CLI would mean threading the
         * outline all the way through — which is possible, just not done. **Hence the message says
         * "this path", not "Notion"**
         */
        const err = new Error(msg('scope.needsLocalText'));
        err.code = 'section-needs-local';
        throw err;
      }
      for (const apiName of sectionApiNames(text, arg, todos, defs)) picked.add(apiName);
    }

    return { apiNames: inDefsOrder(picked), unresolved: [], kind, arg };
  }

  // An explicit list: api_names or achievement names (Chinese or English). **Both the ASCII and the
  // fullwidth comma are accepted** — these names are copied from the Dashboard or from Steam, and
  // the input method decides which one appears
  const byApi = new Map(defs.map((d) => [d.api_name, d]));
  const byName = new Map();
  for (const d of defs) {
    for (const n of [d.name_cn, d.name_en]) {
      const k = normalizeText(n);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(d.api_name);
    }
  }

  // **Try the whole string as one name first, and only then consider splitting.** Achievement names
  // genuinely contain commas — of 10,134 achievements in the library, 302 carry one, and 116 of
  // those belong to games that already have a guide (「拔掉插头,放松身心」 is one). The line above
  // has just genuinely added the fullwidth comma as a separator, and without trying the whole
  // string first those 116 would be cut in half, with neither half matching, and the reported error
  // would be "these two entries are not in the guide" — pointing nowhere near the real cause. A
  // whole-string hit is more specific than a split hit, so it takes precedence.
  // `api_name` remains available as a fallback (it contains no comma, so the split path already
  // handles it); what is skipped here is looking up api_name first
  const wholeName = byName.get(normalizeText(raw));
  if (wholeName?.size === 1) {
    return { apiNames: [...wholeName], unresolved: [], kind: 'list', arg: null };
  }

  // **Written as `，` rather than by pasting the character.** This used to be `/[,,]/` —
  // which looks like "an ASCII comma and a fullwidth comma" and was in fact **the same U+002C
  // written twice**, while the comment beside it claimed the Chinese comma was accepted too. The
  // two characters are all but identical in a monospace font and no amount of reading would find
  // it; the escape form turns it into something legible
  const wanted = raw.split(/[,\uFF0C]/).map((s) => s.trim()).filter(Boolean);
  const picked = new Set();
  const unresolved = [];
  for (const w of wanted) {
    if (byApi.has(w)) {
      picked.add(w);
      continue;
    }
    const hit = byName.get(normalizeText(w));
    // **Same-named achievements cannot be named by name.** The library genuinely contains them (see
    // the same-name section of CLAUDE.md), and guessing means writing A's method under B's heading.
    // To name one of them, use its api_name — that is always unique
    if (hit?.size === 1) picked.add([...hit][0]);
    else unresolved.push(w);
  }

  return { apiNames: inDefsOrder(picked), unresolved, kind: 'list', arg: null };
}

/**
 * Which achievements sit under a given `##` section heading.
 *
 * The test is by line number: every checkbox after the heading line and before the next heading at
 * the same or a higher level. Headings are matched by equality after `normalizeText` — the user
 * typing 「主线」 when the guide says `## 主线剧情` is not the same thing, and must not be waved
 * through silently.
 */
function sectionApiNames(text, wanted, todos, defs) {
  const lines = String(text).split(/\r?\n/);
  const target = normalizeText(wanted);
  let level = 0;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    if (start === -1) {
      if (normalizeText(m[2]) === target) {
        level = m[1].length;
        start = i;
      }
      continue;
    }
    if (m[1].length <= level) {
      end = i;
      break;
    }
  }
  if (start === -1) return [];

  const keys = new Set(todos.filter((t) => t.key > start && t.key < end).map((t) => t.key));
  const out = [];
  for (const [apiName, entry] of mapAchievementGuides(todos, defs)) {
    if (keys.has(entry.key)) out.push(apiName);
  }
  return out;
}

/**
 * Which box each named achievement is in the guide, plus the sub-steps hanging under it (**with
 * their keys**).
 *
 * Attribution goes through `mapAchievementGuides` → `resolveTodoToAchievement`, the same function
 * used by ticking, auditing and the Dashboard cards. **It must never be relaxed here**: that
 * function also carries the job of writing ticks into the user's notes, and relaxing it once for
 * "this is only a rewrite" relaxes it for both. Anything that cannot be located goes into
 * `unlocatable`.
 *
 * The sub-steps walk the `parent` chain again rather than using the `subSteps` that
 * `mapAchievementGuides` provides, for one reason: **the keys are needed**. That field is for
 * frontend display and discards the keys, while deleting a child block on the Notion backend
 * requires a block id.
 *
 * @returns {{entries: object[], unlocatable: string[]}}
 */
export function scopeEntries({ todos, defs, apiNames }) {
  const byApiName = mapAchievementGuides(todos, defs);
  const byDef = new Map(defs.map((d) => [d.api_name, d]));

  const childrenOf = new Map();
  for (const t of todos) {
    if (t.parent === null || t.parent === undefined) continue;
    if (!childrenOf.has(t.parent)) childrenOf.set(t.parent, []);
    childrenOf.get(t.parent).push(t);
  }
  const descendants = (key, out = []) => {
    for (const c of childrenOf.get(key) ?? []) {
      out.push(c);
      descendants(c.key, out);
    }
    return out;
  };

  const entries = [];
  const unlocatable = [];
  // defs' order is the numbering order used in the prompt, and this follows it — the list handed to
  // the model and the order spliced back must be the same order for "entry 3 corresponds to entry
  // 3" to mean anything
  for (const d of defs) {
    if (!apiNames.includes(d.api_name)) continue;
    const entry = byApiName.get(d.api_name);
    if (!entry) {
      unlocatable.push(d.api_name);
      continue;
    }
    entries.push({
      apiName: d.api_name,
      def: byDef.get(d.api_name),
      key: entry.key,
      text: entry.text,
      checked: entry.checked,
      subTodos: descendants(entry.key),
    });
  }
  return { entries, unlocatable };
}

/**
 * Group a guide's outline by section: which achievements sit under each heading.
 *
 * It consumes the same sequence produced by `guideOutline` in `markdown.js` or `blocksToOutline` in
 * `notionblocks.js`, **so both backends share this one attribution routine**. Written twice, the
 * same guide would change sections on being migrated, and nobody would ever see that difference.
 *
 * Attribution still goes through `resolveTodoToAchievement` — an unrecognised entry is skipped
 * rather than guessed at. In the interface that entry simply does not appear in the picker, which
 * is correct: an achievement that cannot be located is out of a partial rewrite's reach anyway (see
 * `unlocatable` in `scopeEntries`).
 *
 * Achievements appearing before any heading are grouped under `heading: null` — opening a guide
 * with a quick-reference section and then listing a few entries directly is a common shape, and
 * dropping them would make those entries permanently unselectable.
 *
 * @returns {{heading: string|null, apiNames: string[]}[]}
 */
export function groupBySection(outline, defs) {
  const groups = [];
  let cur = null;
  const open = (heading) => {
    cur = { heading, apiNames: [] };
    groups.push(cur);
    return cur;
  };

  for (const item of outline ?? []) {
    if (item.kind === 'heading') {
      open(item.text);
      continue;
    }
    const hit = resolveTodoToAchievement(item.text, defs);
    if (!hit) continue;
    // When one achievement appears twice in a guide only the first is taken, the same rule as mapAchievementGuides
    if (groups.some((g) => g.apiNames.includes(hit.def.api_name))) continue;
    (cur ?? open(null)).apiNames.push(hit.def.api_name);
  }

  // Empty groups are dropped: a section with no achievements (pure prose, a quick reference) would
  // be an unclickable heading in the picker
  return groups.filter((g) => g.apiNames.length);
}

/** A finding's identity. `key` cannot be used — line numbers change after splicing while it still refers to the same problem */
const findingId = (f) => `${f.code}\u0000${f.apiName ?? f.message ?? ''}`;

/**
 * Which of the problems found afterwards are this change's fault.
 *
 * **This is the one genuinely new failure mode a partial rewrite introduces, and the one that has
 * to be handled explicitly.**
 *
 * An old guide may well already fail validation — hand-written ones especially (CLAUDE.md records
 * 330 achievements in the corpus with no matchable checkbox at all). For a whole-guide rewrite this
 * is not a problem: everything was rewritten, so every finding belongs to it. For a partial rewrite
 * it is: the user names 3 entries while entry 40 has been missing its description for months, and
 * blocking on that discards a change that was made correctly, over a problem they did not ask to
 * fix and we were not authorised to touch — while the error message reads 「校验没过」, suggesting
 * this change broke something.
 *
 * Two criteria, either of which charges a finding to this run (`caused`):
 *
 * 1. **It falls inside the selection set** — those are the entries just rewritten, so problems on
 *    them obviously count.
 * 2. **It was not there before** — a newly appeared problem, wherever it lands, is a consequence of
 *    this splice (a new entry duplicating something elsewhere, say, or the splice producing a
 *    merged line).
 *
 * The rest are `preExisting`: **reported, never blocking.** "Not blocking" is emphatically not "not
 * mentioning" — this project paid for that rule with `ambiguous-empty-description`: 15 boxes that
 * will never tick themselves, if merely not blocked and not mentioned, are discovered months later
 * and read as the sync being broken.
 */
export function classifyFindings({ before = [], after = [], apiNames = [] }) {
  const inScope = new Set(apiNames);
  const had = new Set(before.map(findingId));
  const caused = [];
  const preExisting = [];
  for (const f of after) {
    if ((f.apiName && inScope.has(f.apiName)) || !had.has(findingId(f))) caused.push(f);
    else preExisting.push(f);
  }
  return { caused, preExisting };
}
