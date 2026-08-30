/**
 * The local markdown guide backend (the second way of storing guides, besides Notion)
 * ------------------------------------------------
 * For rows in the guides table with kind='local', url holds a file path relative to guidesDir
 * (sultans_game_achievements.md, for example). A checkbox is a markdown "- [ ] xxx" line, and
 * syncing rewrites a matched one to "- [x] xxx".
 *
 * The matching rules (normalizeText / extractTitleCandidates) are **shared code with the Notion
 * backend**, in lib/guides.js — that "must match a title candidate segment exactly" rule was
 * paid for with real defects, and the two backends must not each keep their own copy.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

import { isInside } from './pathsafe.js';

/**
 * The fixed form for a mutual-exclusion annotation (SKILL.md rule 3.1):
 * `<span underline="true">如果进行此动作则无法获得X成就。</span>`
 *
 * **It is the same class of thing as `**bold**` — markup, not prose.** On the Notion side it
 * becomes an `underline` annotation on the rich_text and `plain_text` holds only the inner
 * characters; in local markdown it is literal text. So anywhere the two sides' text is compared
 * (the fidelity check on migration, the normalisation in achievement matching) the tag must be
 * stripped first, or the same sentence can never compare equal across the two backends — `**`
 * has been handled this way all along, and this rule merely fills in the one that was missed.
 *
 * Neither `matchAll` nor `replace` pollutes lastIndex, so this /g regex can be shared.
 */
export const UNDERLINE_SPAN_RE = /<span\s+underline=["']true["']\s*>([\s\S]*?)<\/span>/gi;

const TODO_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*)(.*)$/;

/**
 * Split into lines, **recognising both CRLF and LF**.
 *
 * With `split('\n')` alone, every line of a CRLF file retains a trailing `\r`, and `.` in a JS
 * regex **does not match `\r`** (it counts as a line terminator, like `\n`), so `(.*)$` fails
 * to match — and the whole guide reads as **0 checkboxes**.
 *
 * This is not hypothetical: editors on Windows write CRLF by default. It happened once, and the
 * symptom was `checkbox-sync` ticking nothing and `guide-lint` reporting that every achievement
 * was missing a checkbox, **with neither raising an error**, so it looked as though the guide
 * had been written wrongly.
 */
const splitLines = (text) => text.split(/\r?\n/);

/** Preserve the file's original line-ending style when writing back, rather than converting the whole file to LF */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * Resolve `guides.url` into a real file path, blocking any path that leaves `guidesDir`.
 *
 * The predicate lives in `pathsafe.isInside`, shared by all four containment checks — this was
 * once `startsWith(resolve(guidesDir))` without a separator, so `…/guides-evil/x.md` counted as
 * "inside guides". **This is not only a read hole**: `guidepatch.landPatchLocal` passes this
 * return value to `writeFileSync`.
 */
export function resolveGuidePath(guidesDir, url) {
  const path = isAbsolute(url) ? url : join(guidesDir, url);
  const full = resolve(path);
  if (!isInside(guidesDir, full)) {
    throw new Error(`攻略路径越出了 guides 目录: ${url}`);
  }
  if (!existsSync(full)) throw new Error(`找不到攻略文件: ${full}`);
  return full;
}

/**
 * Read every checkbox line. A more deeply indented line is a **sub-step** of the one above it
 * (parent points at that line's key), corresponding to the Notion backend's nested to_do blocks
 * — the two backends must hand the matching logic the same data shape.
 */
export function loadTodos(path) {
  return parseTodos(readFileSync(path, 'utf8'));
}

/**
 * The same parser, taking a string rather than a path.
 *
 * It was extracted because **partial rewriting has to parse the lines the model just returned**,
 * before they reach disk — and every rule here (CRLF, the indentation algorithm, how `parent` is
 * attached) was paid for with a defect, so a second copy would certainly drift: the two backends
 * must hand the matching logic the same shape, which means the two parses must be one parse.
 *
 * **The returned shape matches the Notion backend exactly** (`{key, text, checked, parent}`),
 * with no extra markdown-only field such as `indent` — adding one would mean some code reading
 * it off a Notion todo and getting undefined, a failure that makes no sound. Everything at the
 * line-number level is `todoSpans`'s responsibility.
 */
export function parseTodos(text) {
  const todos = [];
  // The indentation stack: [{indent, key}], used to decide which line the current one hangs under
  const stack = [];
  splitLines(text)
    .forEach((line, i) => {
      const m = line.match(TODO_RE);
      if (!m) return;
      // m[1] is the "  - [" portion; subtract the "-"/"*" and "[" to get the real indent width
      const indent = m[1].length - m[1].trimStart().length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      todos.push({
        key: i,
        text: m[4],
        checked: m[2] !== ' ',
        parent: stack.length ? stack[stack.length - 1].key : null,
      });
      stack.push({ indent, key: i });
    });
  return todos;
}

/**
 * Flatten a local guide into headings and checkboxes in the order they appear.
 *
 * Used to determine which section an achievement belongs to. **Line classification reuses the
 * same regexes as the rest of this file** — section membership and ticking must hold the same
 * view of the same lines, and separate copies would eventually produce "it ticks but it can't
 * be placed in a section".
 *
 * On the Notion side `blocksToOutline` in `notionblocks.js` produces the same shape, so one
 * `groupBySection` serves both backends.
 *
 * @returns {{kind:'heading'|'todo', text:string, level?:number}[]}
 */
export function guideOutline(text) {
  const out = [];
  for (const line of splitLines(text)) {
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      out.push({ kind: 'heading', text: h[2].trim(), level: h[1].length });
      continue;
    }
    const t = line.match(TODO_RE);
    // An indented line is a sub-step, not an achievement — membership considers top-level lines only
    if (t && t[1].length - t[1].trimStart().length === 0) out.push({ kind: 'todo', text: t[4] });
  }
  return out;
}

/**
 * Which lines each checkbox entry occupies — partial rewriting uses this to replace precisely,
 * touching no other bytes.
 *
 * One achievement = its own line plus the run of **immediately following, more deeply indented**
 * sub-step lines.
 *
 * Both conditions are deliberately strict, in the same direction: **eat one line too few rather
 * than one too many.**
 *
 * - **They must be consecutive** (`row.line === end + 1`). A single non-checkbox line in between
 *   ends the range — a `<details>` block, a table or a section note can all sit between an
 *   achievement and its sub-steps, and **those do not belong to that achievement**. Swallowing
 *   them deletes text the user never asked to change, and the entire reason this feature exists
 *   is that nothing outside the named set is touched.
 * - **The indent must be deeper.** Equal or shallower is the next achievement (or a return to an
 *   outer level), and the range ends.
 *
 * The cost is that in a guide with a blank line between sub-steps, only the first run of
 * sub-steps is replaced and the rest stay in place — which the linter reports as a duplicate
 * entry, a **visible** failure. The opposite direction (eating one line too many) deletes text
 * silently.
 */
export function todoSpans(text) {
  const rows = [];
  splitLines(text).forEach((line, i) => {
    const m = line.match(TODO_RE);
    if (m) rows.push({ line: i, indent: m[1].length - m[1].trimStart().length });
  });

  const spans = new Map();
  for (let r = 0; r < rows.length; r++) {
    let end = rows[r].line;
    for (let k = r + 1; k < rows.length; k++) {
      if (rows[k].indent <= rows[r].indent) break;
      if (rows[k].line !== end + 1) break;
      end = rows[k].line;
    }
    spans.set(rows[r].line, { start: rows[r].line, end, indent: rows[r].indent });
  }
  return spans;
}

/** `<details ...>` / `</details>`, ignoring case and attributes. **These two lines duplicate the
 *  identically named regexes in notionblocks.js** — that module imports this file
 *  (UNDERLINE_SPAN_RE), and importing back would be a cycle. Two regexes are cheaper to
 *  duplicate than a circular dependency. */
const DETAILS_OPEN = /^<details\b[^>]*>/i;
const DETAILS_CLOSE = /^<\/details\s*>/i;

/**
 * Where a `<details>` starting at `start` ends (the line holding the closing tag).
 * **Returns null when no close is found.**
 *
 * It counts depth rather than taking the first `</details>`: a toggle nested inside a toggle is
 * legal. When there is no close it **must not run to the end of the file** — a truncated model
 * response leaves exactly one unclosed `<details>`, and everything after it would be swallowed.
 */
export function detailsBlockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const cur = lines[i].trim();
    if (DETAILS_OPEN.test(cur)) depth++;
    if (DETAILS_CLOSE.test(cur)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * The same ranges as `todoSpans`, **plus any immediately following, more deeply indented
 * `<details>` block**.
 *
 * Why a separate function rather than relaxing `todoSpans`: that function's conservatism is
 * **load-bearing** — `spliceLines` on local markdown replaces by line range, and eating one line
 * too many deletes text silently. This one exists for guides whose prose contains toggles: with
 * Notion as the target, a group label *is* a `<details>` (see `groupLabelRule` in guidegen), and
 * that line is not a checkbox, so `todoSpans` truncates there and leaves every sub-step outside
 * the range.
 *
 * **An unclosed toggle is not guessed at**, and the range stops there: a truncated model response
 * leaves exactly one unclosed `<details>`, and running to the end of the file would swallow whole
 * subsequent achievements. Eating one line too few is reported by the linter as a missing entry
 * (visible); eating too many swallows silently (invisible), and the costs are not equal.
 */
export function todoSpansWithToggles(text) {
  const lines = splitLines(text);
  const spans = todoSpans(text);
  const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;
  const out = new Map();

  for (const [key, span] of spans) {
    const base = indentOf(lines[span.start] ?? '');
    let end = span.end;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (!next.trim()) break;
      if (indentOf(next) <= base) break;
      const t = next.trim();
      if (DETAILS_OPEN.test(t)) {
        const close = detailsBlockEnd(lines, end + 1);
        if (close === null) break;
        end = close;
        continue;
      }
      if (TODO_RE.test(next)) { end += 1; continue; }
      break;
    }
    out.set(key, { ...span, end });
  }
  return out;
}

/**
 * Replace by line range, **working backwards**.
 *
 * Working forwards, the moment the first replacement changes the line count every subsequent
 * range's indices are off — and that raises no error, it simply attaches content to a different
 * achievement. Going backwards, the indices always point into the half that has not been touched.
 *
 * Line endings follow the original (`eolOf`), for the same reason as in `applyChecks`: quietly
 * converting CRLF to LF turns the git diff into "every line changed", burying the real change.
 *
 * @param {string} text
 * @param {{start:number, end:number, lines:string[]}[]} edits
 */
export function spliceLines(text, edits) {
  if (!edits.length) return text;
  const eol = eolOf(text);
  const lines = splitLines(text);
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (const e of ordered) {
    lines.splice(e.start, e.end - e.start + 1, ...e.lines);
  }
  return lines.join(eol);
}

/** Tick the checkboxes at the given line numbers and write the file back once */
export function applyChecks(path, keys) {
  if (!keys.length) return 0;
  const want = new Set(keys);
  const text = readFileSync(path, 'utf8');
  // Preserve the original line-ending style when writing back — quietly converting the whole
  // file from CRLF to LF turns the git diff into "every line changed", burying the real change
  const eol = eolOf(text);
  const lines = splitLines(text);
  let changed = 0;
  for (const i of want) {
    const m = lines[i]?.match(TODO_RE);
    if (m && m[2] === ' ') {
      lines[i] = `${m[1]}x${m[3]}${m[4]}`;
      changed++;
    }
  }
  if (changed) writeFileSync(path, lines.join(eol));
  return changed;
}
