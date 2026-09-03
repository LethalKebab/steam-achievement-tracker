/**
 * A markdown guide → Notion block JSON
 * ------------------------------------------------
 * `lib/notion.js` speaks the raw REST API, which wants block objects rather than markdown.
 * This file translates the kind of guide **we generate ourselves**.
 *
 * The reason it can be this small a converter is that the format is controlled (see RULES in
 * guidegen.js): only four things exist — `## section heading`, `- [ ]` / `- [x]` (optionally with
 * one level of indented sub-steps), `appid: NNNNNN`, and the occasional ordinary paragraph. It is
 * **not** a general markdown converter, and should not become one.
 *
 * ## Two rules that do not bend
 *
 * 1. **An unrecognised line is never dropped; it degrades to an ordinary paragraph** and is
 *    reported in `unconverted`. Silently discarding content is the least acceptable failure in this
 *    project — the user would never know a passage was missing from what are, after all, their own notes.
 * 2. **`<br>` becomes a newline (`\n`) inside the block, never three separate blocks.** One
 *    achievement must be **one** checkbox line: split into three, the sync scripts matching
 *    "achievement name equals a candidate segment exactly" would leave the description and the
 *    notes as two ownerless paragraphs while that line held only the name — matching would still
 *    work, but `audit`'s reverse lookup (which relies on the verbatim description) could never find it again.
 */

import { UNDERLINE_SPAN_RE } from './markdown.js';
import { MESSAGES, messageLanguage } from './messages.js';

/**
 * rich_text → plain text. The inverse of `toRichText`, hence its placement beside it.
 *
 * `notion.js` re-exports this name verbatim — it had the function first, six call sites import it
 * from there, and relocating a utility should not leave six unrelated edits in another file.
 */
export const richTextToPlain = (rt) => (rt ?? []).map((t) => t.plain_text).join('');

/** Notion's content limit for one text node. Anything longer must be split into several runs, or the whole request is rejected */
const MAX_TEXT = 2000;

/** How many blocks one API call may carry. SKILL.md 9.2: write large content in batches rather than forcing it into one call */
export const MAX_BLOCKS_PER_CALL = 100;

/**
 * `**bold**` plus `<br>` → Notion's rich_text array.
 *
 * Bold does not affect matching (`richTextToPlain` takes only plain_text, and on the local side
 * `normalizeText` strips `**`); it exists purely so these look like the hundred-odd existing guides.
 */
export function toRichText(line) {
  const runs = [];
  const push = (text, bold, underline) => {
    if (!text) return;
    // Split anything over-long, or Notion rejects the whole thing
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      runs.push({
        type: 'text',
        text: { content: text.slice(i, i + MAX_TEXT) },
        annotations: { bold: Boolean(bold), underline: Boolean(underline) },
      });
    }
  };

  const normalized = String(line ?? '').replace(/<br\s*\/?>/gi, '\n');

  // Split on the mutual-exclusion annotation first, then split each segment on ** for bold.
  // `<span underline="true">…</span>` is SKILL.md's fixed form and **must be converted here** —
  // landing in the prose unchanged, Notion displays the tag itself rather than an underline, unlike
  // the pages the user wrote by hand
  const segments = [];
  let last = 0;
  for (const m of normalized.matchAll(UNDERLINE_SPAN_RE)) {
    if (m.index > last) segments.push({ text: normalized.slice(last, m.index), underline: false });
    segments.push({ text: m[1], underline: true });
    last = m.index + m[0].length;
  }
  if (last < normalized.length) segments.push({ text: normalized.slice(last), underline: false });

  for (const seg of segments) {
    // Split on paired **; the odd-indexed pieces are bold
    seg.text.split(/\*\*/).forEach((part, i) => push(part, i % 2 === 1, seg.underline));
  }
  return runs.length
    ? runs
    : [{ type: 'text', text: { content: '' }, annotations: { bold: false, underline: false } }];
}

const TODO_RE = /^(\s*)- \[([ xX])\]\s*(.*)$/;
/** An ordinary bullet. **Must be tested after TODO_RE**, or `- [ ] x` is taken for an ordinary item */
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
/** A markdown table's separator row `| --- | :-: |` — syntax, not data */
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;

/** `| a | b |` → ['a', 'b'] */
const splitRow = (line) =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/**
 * A run of consecutive table rows → one Notion table block.
 *
 * Notion requires **every row to have exactly `table_width` cells**, and one short rejects the whole
 * request. Hand-written markdown tables frequently have a row with one pipe too many or too few, so
 * this pads and truncates to a common width rather than degrading the whole table to paragraphs —
 * a table degraded to paragraphs leaves the reader to find the columns in running text.
 */
function tableBlock(rows) {
  const cells = rows.filter((r) => !TABLE_SEP_RE.test(r)).map(splitRow);
  const width = Math.max(...cells.map((c) => c.length));
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      // A separator row present means the first row is a header, which is the definition of a markdown table
      has_column_header: rows.some((r) => TABLE_SEP_RE.test(r)),
      has_row_header: false,
      children: cells.map((row) => ({
        object: 'block',
        type: 'table_row',
        table_row: {
          cells: Array.from({ length: width }, (_, i) => toRichText(row[i] ?? '')),
        },
      })),
    },
  };
}

/**
 * A whole markdown document → blocks.
 *
 * @returns {{blocks: object[], unconverted: string[]}}
 *   unconverted holds the lines that were **not recognised and degraded to ordinary paragraphs**,
 *   for the caller to report to the user. No content was lost, but the layout was, and the user is
 *   entitled to know which lines.
 */
/**
 * `lang` is **the guide's** language, not the interface's. The only thing it decides is the label
 * on a `<details>` that carries no `<summary>`, and that label is written into the user's page as
 * content — so it follows the document it lands in. Callers that know the guide's language pass
 * it (`plan.lang`); the rest fall back to the interface, which is the best signal available.
 */
export function markdownToBlocks(md, { lang = messageLanguage() } = {}) {
  return convertLines(String(md ?? '').split(/\r?\n/), lang);
}

/** `<details ...>` / `</details>` / `<summary>…</summary>`, ignoring case and attributes */
const DETAILS_OPEN_RE = /^<details\b[^>]*>/i;
const DETAILS_CLOSE_RE = /^<\/details\s*>/i;
const SUMMARY_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/**
 * Which lines a `<details>` block occupies. **Returns null when no closing tag is found**, and the
 * caller falls back to the old behaviour.
 *
 * It counts depth rather than taking the first `</details>`: a collapse nested inside a collapse is
 * legal, and taking the first close truncates the outer one partway. And **with no closing tag it
 * must never run to the end of the file** — a truncated model response leaves exactly one unclosed
 * `<details>`, and everything remaining would be packed into one collapse, so the page looks as
 * though half of it is missing, without raising an error.
 */
export function detailsSpan(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim();
    if (DETAILS_OPEN_RE.test(l)) depth++;
    if (DETAILS_CLOSE_RE.test(l)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Lines inside a collapse still carry their indentation from the original (`\t<details>` is
 * followed by `\t- [ ]`). **That common indent has to be stripped before recursing.** Without it
 * the first child becomes `lastItem` for want of anything shallower, and every subsequent one
 * attaches beneath it for being indented — so ten parallel prerequisites become ten nested levels,
 * without an error, requiring ten clicks to read.
 */
function dedent(lines) {
  const widths = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const strip = widths.length ? Math.min(...widths) : 0;
  return strip ? lines.map((l) => (l.trim() ? l.slice(strip) : l)) : lines;
}

function convertLines(lines, lang) {
  const blocks = [];
  const unconverted = [];
  // The last top-level list item (to_do or bulleted_list_item); indented children attach to its children
  let lastItem = null;
  // A table is a multi-line structure, so consecutive table rows are collected and converted at once
  let tableRows = [];
  const flushTable = () => {
    if (tableRows.length) blocks.push(tableBlock(tableRows));
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    if (TABLE_ROW_RE.test(line)) {
      tableRows.push(line);
      lastItem = null;
      continue;
    }
    flushTable();

    if (!line.trim()) continue; // Blank line: Notion spaces blocks itself and needs no placeholder block

    /**
     * `<details><summary>title</summary>` … `</details>` → Notion's **toggle**.
     *
     * **This is not "supporting one more syntax while we are here".** SKILL.md rule-5 **requires**
     * long content to be collapsed in `<details>` (location-code tables, scene-code tables, and
     * other multi-dozen-line reference material), so the model writing one is following the rules
     * and failing to recognise it is this converter's fault. The consequence of not recognising it
     * is identical to the days of recognising only `##`: it falls into the ordinary-paragraph
     * branch below, leaving a literal `<details><summary>…</summary>` line and a `</details>` line
     * on the page, with the content present and the layout gone — while `unconverted`'s report of a
     * "layout downgrade" sounds minor. Measured on 加利宅邸悬案, which was left with 4 such blocks.
     *
     * The summary may be written on the opening tag's line (the model's usual habit) or on the next
     * line; both are recognised.
     */
    if (DETAILS_OPEN_RE.test(line.trim())) {
      const close = detailsSpan(lines, i);
      if (close !== null) {
        flushTable();
        const inner = lines.slice(i + 1, close);
        // The summary may be on the opening tag's line, or on a line of its own
        let label = SUMMARY_RE.exec(line)?.[1];
        if (label === undefined) {
          const at = inner.findIndex((l) => SUMMARY_RE.test(l));
          if (at !== -1) {
            label = SUMMARY_RE.exec(inner[at])[1];
            inner.splice(at, 1);
          }
        }
        const sub = convertLines(dedent(inner), lang);
        const toggle = {
          object: 'block',
          type: 'toggle',
          toggle: {
            // A toggle needs a title even with no summary — an empty title in Notion is an invisible bar
            rich_text: toRichText(label ?? MESSAGES['notion.summaryFallback'][lang === 'en' ? 1 : 0]),
            ...(sub.blocks.length ? { children: sub.blocks } : {}),
          },
        };
        /**
         * **An indented collapse attaches to the previous list item**, the same rule as an indented
         * checkbox.
         *
         * A group label (prerequisites/steps/warnings) has exactly this shape: `- [ ] **achievement**`
         * followed by a few indented `<details>`. Pushed at top level, the collapse becomes the
         * achievement's **sibling**, and on the Notion side `fetchAllToDoBlocks` then reads the
         * sub-steps inside it as top-level achievements — the validator reports a run of surplus
         * entries that resolve to nothing, while the page merely looks as though a collapse is in
         * the wrong place.
         *
         * After attaching, **`lastItem` is not cleared**: one achievement is usually followed by
         * several collapses (prerequisites, steps, warnings), and clearing it would drop the second
         * one back to top level.
         */
        if (/^[ \t]/.test(line) && lastItem) {
          (lastItem[lastItem.type].children ??= []).push(toggle);
        } else {
          blocks.push(toggle);
          lastItem = null;
        }
        unconverted.push(...sub.unconverted);
        i = close; // Skip the whole span; the closing tag must not become a block of its own
        continue;
      }
      // No closing tag: fall back to the old behaviour (the ordinary-paragraph branch below) and report it honestly
    }

    // Headings. **Every level is recognised**, not only `##`: the model writing a `###` section is
    // entirely natural, and failing to recognise it drops the line into the ordinary-paragraph
    // branch below, leaving a literal `### 机制速查` on the page. Hit for real on a guide written
    // entirely in `###`, which therefore had **not one real heading**, while `unconverted` reported
    // a "layout downgrade" — which sounds minor and was in fact the loss of the whole structure
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      // A level-1 heading does not enter the body — a Notion page's title comes from the title property (SKILL.md 4.1)
      if (level === 1) continue;
      // Notion has only three heading levels, so anything deeper collapses to heading_3: losing one
      // level of hierarchy still beats rendering a heading as body text
      const type = level === 2 ? 'heading_2' : 'heading_3';
      blocks.push({ object: 'block', type, [type]: { rich_text: toRichText(heading[2]) } });
      lastItem = null;
      continue;
    }

    // List items: checkboxes and ordinary bullets share one nesting rule. **TODO_RE must be tested
    // first**, or `- [ ] achievement` is taken by BULLET_RE for an ordinary item and the checkbox is lost
    const todo = line.match(TODO_RE);
    const bullet = todo ? null : line.match(BULLET_RE);
    if (todo || bullet) {
      const [indent, type, payload] = todo
        ? [todo[1], 'to_do', { rich_text: toRichText(todo[3]), checked: todo[2] !== ' ' }]
        : [bullet[1], 'bulleted_list_item', { rich_text: toRichText(bullet[2]) }];
      const block = { object: 'block', type, [type]: payload };
      // Indented means a child, attached to the previous top-level list item. With nothing to
      // attach to (no top-level item yet) it degrades to top level, which beats dropping it
      if (indent.length > 0 && lastItem) {
        (lastItem[lastItem.type].children ??= []).push(block);
      } else {
        blocks.push(block);
        lastItem = block;
      }
      continue;
    }

    // Everything else becomes an ordinary paragraph. `appid: NNNNNN` lands here, and it has to be a
    // paragraph, because extractAppIdFromPageContent looks for it among the paragraphs
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: toRichText(line) },
    });
    lastItem = null;
    // <details>/<summary> reach this point: the content survives, the layout does not.
    // (Headings no longer do — they now genuinely convert to heading blocks)
    if (/^<(details|summary)/i.test(line)) unconverted.push(line.slice(0, 60));
  }

  flushTable(); // Do not lose a table that ends the file

  return { blocks, unconverted };
}

/**
 * Flatten a Notion guide page into headings and checkboxes in the order they appear — the same
 * shape as `guideOutline` in `markdown.js`, so section attribution has only one implementation.
 *
 * **What is fed in must be `fetchAllBlocks`'s result, not `fetchAllToDoBlocks`'s.** The latter
 * collects only to_do blocks, so headings do not exist as far as it is concerned — "section
 * structure cannot be read from Notion" is true of that function only, and not of the page, whose
 * blocks are perfectly obtainable.
 *
 * Only a top-level to_do counts as an achievement: one nested inside another to_do is a sub-step,
 * matching the local side's test of zero indentation.
 *
 * @returns {{kind:'heading'|'todo', text:string, level?:number}[]}
 */
export function blocksToOutline(blocks, depth = 0) {
  const out = [];
  for (const b of blocks ?? []) {
    const h = /^heading_([123])$/.exec(b.type ?? '');
    if (h) {
      out.push({ kind: 'heading', text: richTextToPlain(b[b.type]?.rich_text), level: Number(h[1]) });
      continue;
    }
    if (b.type === 'to_do') {
      if (depth === 0) out.push({ kind: 'todo', text: richTextToPlain(b.to_do?.rich_text) });
      continue; // Do not recurse into the sub-steps
    }
    // A container (toggle, column and the like) does not change attribution: a heading or achievement inside it still belongs to this section
    if (b.children?.length) out.push(...blocksToOutline(b.children, depth));
  }
  return out;
}

/**
 * Blocks in a backup that **point at another entity**, or that have no writable content at all —
 * append cannot create them. When one appears it is dropped and recorded, rather than handed to
 * Notion verbatim in exchange for a 400: one `child_database` in a restore must not prevent the
 * whole guide from being written back.
 */
const UNRESTORABLE_TYPES = new Set([
  'child_page', 'child_database', 'link_to_page', 'synced_block', 'unsupported',
]);

/**
 * Turn the raw blocks stored by `fetchAllBlocks` into a shape `appendBlocks` can write back.
 *
 * The two shapes differ in two ways, which is the entire reason this function exists:
 *
 *  1. **Read-only fields** (`id` / `created_time` / `parent` / `has_children` …) are all present on
 *     a block read back and none of them may be sent when writing. Rather than deleting them one by
 *     one, this **takes `type` and `block[type]` and rebuilds** — a deletion list expires as Notion
 *     adds fields, and rebuilding does not.
 *  2. **Child blocks live somewhere different**: in the backup they hang off the top-level
 *     `block.children` (which is how `fetchAllBlocks` stores them), while writing back Notion
 *     requires them nested in `block[type].children`. Without this step a restored page is flat —
 *     every sub-step under an achievement is promoted to an achievement, and nesting depth is
 *     precisely how checkbox sync tells the two apart.
 *
 * @returns {{blocks: object[], dropped: Record<string, number>}}
 */
export function blocksForAppend(blocks) {
  const dropped = {};
  const convert = (list) => {
    const out = [];
    for (const b of list ?? []) {
      const type = b?.type;
      if (!type) continue;
      if (UNRESTORABLE_TYPES.has(type)) {
        dropped[type] = (dropped[type] ?? 0) + 1;
        continue;
      }
      const payload = { ...(b[type] ?? {}) };
      const kids = convert(b.children);
      if (kids.length) payload.children = kids;
      out.push({ object: 'block', type, [type]: payload });
    }
    return out;
  };
  return { blocks: convert(blocks), dropped };
}

/** Chunk to Notion's per-call ceiling */
/** How many levels a block spans including its descendants. A leaf counts as 1 */
export function blockDepth(block) {
  const kids = block?.[block?.type]?.children ?? [];
  return kids.length ? 1 + Math.max(...kids.map(blockDepth)) : 1;
}

/**
 * **Notion's append endpoint accepts only two levels of nesting** (the top-level block plus its
 * children); anything deeper needs a further request.
 *
 * This was not a problem before toggles existed: the deepest shapes were `table > table_row` and
 * "achievement to_do > sub-step to_do", exactly two levels. A collapse wrapping a table makes
 * `toggle > table > table_row` — three levels, which cannot be sent in one call.
 *
 * An over-deep block has **all of its children moved out together**, rather than only the one that
 * is too deep: leaving half in place and appending the other half on a second pass reorders the
 * collapse's contents, and that order is the author's.
 *
 * Returns `{ shallow, deferred }`, where `deferred[i].index` points into `shallow` — Notion's append
 * response returns the created blocks in request order, which is how the caller obtains the parent's id.
 */
export function splitDeepChildren(blocks, max = 2) {
  const shallow = [];
  const deferred = [];
  blocks.forEach((b, index) => {
    if (blockDepth(b) <= max) {
      shallow.push(b);
      return;
    }
    const payload = { ...b[b.type] };
    const children = payload.children ?? [];
    delete payload.children;
    shallow.push({ ...b, [b.type]: payload });
    deferred.push({ index, children });
  });
  return { shallow, deferred };
}

export function chunkBlocks(blocks, size = MAX_BLOCKS_PER_CALL) {
  const out = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}

/**
 * The block types `markdownToBlocks` **does** produce — that is, the ones it is safe to delete and
 * rewrite during an overwrite.
 *
 * **Defining it this way round is deliberate.** Listing "the types to preserve" means that when
 * Notion adds a block type, or the user uses one we did not anticipate, it falls on the "delete"
 * side and quietly disappears. Listing "the ones we produce ourselves" preserves everything not
 * listed — so a wrong guess leaves one extra block rather than destroying the user's content.
 *
 * Images are not on the list: the prompt states explicitly that no images are to be inserted, so an
 * image on the page is **certainly** one the user added. And in a hidden-object game a location can
 * only be made clear with a picture (rule 二), which is something regeneration cannot bring back.
 */
export const GENERATED_BLOCK_TYPES = new Set([
  'heading_1', 'heading_2', 'heading_3',
  'paragraph', 'to_do', 'bulleted_list_item', 'numbered_list_item',
  'toggle', 'table', 'table_row', 'divider', 'code',
]);

/**
 * During an overwrite, split the old page's top-level blocks into "delete" and "keep", computing an
 * **anchor** for each block kept.
 *
 * The anchor is **the api_name of the nearest achievement above it**, not a section heading —
 * headings are changed by the regrouping pass, while an achievement's identity is stable. A block
 * with no achievement above it (an image at the top of the page) records `null` and is reinserted first.
 *
 * @returns {{drop: {id:string}[], keep: {id:string, type:string, afterApiName:string|null}[]}}
 */
/**
 * Take plain text from rich_text, **recognising both shapes**.
 *
 * Every item Notion **reads back** carries `plain_text`; the ones we **build ourselves**
 * (`toRichText`) have only `text.content`. `richTextToPlain` reads the former only — using it to
 * parse a block we just built yields an empty string, and an empty string raises no error; it merely
 * makes everything downstream match nothing and degrade in silence.
 *
 * **Hit for real**: `writeAroundKept` used it to build the anchor table, every new block parsed as
 * empty, and every preserved bookmark therefore fell back to "leave it where it is" and landed at
 * the top of the page. The unit test missed it because the fixture supplied both fields — more
 * generous than reality.
 */
export const richTextText = (rt) => (rt ?? [])
  .map((t) => (t?.plain_text ?? t?.text?.content ?? ''))
  .join('');

export function partitionForOverwrite(blocks, resolve, generatedProse = null) {
  const list = blocks ?? [];

  // First compute, for each index, the nearest achievement after it — a section intro belongs to the achievement **following** it
  const nextApi = new Array(list.length).fill(null);
  {
    let seen = null;
    for (let i = list.length - 1; i >= 0; i--) {
      nextApi[i] = seen;
      if (list[i].type === 'to_do') {
        const hit = resolve(richTextToPlain(list[i].to_do?.rich_text ?? []));
        if (hit) seen = hit;
      }
    }
  }

  const drop = [];
  const keep = [];
  let lastApiName = null;
  /** Whether a to_do has been seen since the last heading — if not, we are still in the section intro */
  let inSectionIntro = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (/^heading_[1-6]$/.test(b.type)) inSectionIntro = true;
    if (b.type === 'to_do') {
      inSectionIntro = false;
      const hit = resolve(richTextToPlain(b.to_do?.rich_text ?? []));
      if (hit) lastApiName = hit;
    }

    if (!GENERATED_BLOCK_TYPES.has(b.type)) {
      keep.push({ id: b.id, type: b.type, prefer: 'after', afterApiName: lastApiName, beforeApiName: nextApi[i] });
      continue;
    }
    if (b.type === 'paragraph' && inSectionIntro && keepIntro(b.paragraph?.rich_text, generatedProse)) {
      keep.push({ id: b.id, type: b.type, prefer: 'before', afterApiName: lastApiName, beforeApiName: nextApi[i] });
      continue;
    }
    drop.push({ id: b.id });
  }
  return { drop, keep };
}

/**
 * Whether this section intro contains an **external pointer** — a link, a bare URL, or a Bilibili BV id.
 *
 * **Why only the ones with a pointer are kept.** A section intro is a `paragraph`, and the generator
 * writes paragraphs too, so the type alone cannot distinguish "written by the user" from "written
 * by the last generation". Keeping all of them accumulates: one kept this time plus one the model
 * writes, then both kept next time plus another… Keeping none discards the things that genuinely
 * cannot be recovered.
 *
 * The ones carrying a pointer are precisely those **regeneration may not find again**: a
 * walkthrough on gamefaqs, or a timestamped reference such as 「对照 B站 BV1KFwzzCEsc 的 5-2
 * 段落(01:56)」. A purely textual note (a hint-token cap, say) is researched and rewritten every
 * time, so losing it costs nothing.
 *
 * The cost stated plainly: this is a **heuristic**, not provenance. A hand-written note with no link
 * will be replaced by a regenerated one — avoiding that requires storing what we wrote last time and
 * comparing, which is a different thing.
 */
export function carriesPointer(richText) {
  const rt = richText ?? [];
  if (rt.some((t) => t?.href || t?.text?.link?.url)) return true;
  const plain = richTextToPlain(rt);
  return /https?:\/\//i.test(plain) || /\bBV[0-9A-Za-z]{8,}\b/.test(plain);
}

/** Normalise a section intro: compare content only, not whitespace — a Notion round trip alters spacing but never the characters */
export const normalizeProse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Whether this section intro should be kept.
 *
 * **Where provenance exists, use provenance.** `generatedProse` holds the passages we wrote
 * ourselves last time: found there ⇒ we wrote it, so it gives way to this run's freshly researched
 * version; not found ⇒ the user wrote or edited it, so it stays. That is the only principled test —
 * a paragraph's type cannot identify its author, and its content can.
 *
 * **Only where provenance is unavailable (an older guide, with that column still empty) does it fall
 * back to the `carriesPointer` heuristic.** There, only intros with a link or a BV id are kept:
 * keeping all of them would stack with this run's new intro into two copies, then three next time;
 * keeping none would lose the gamefaqs link and 「BV1KFwzzCEsc 的 5-2 段落(01:56)」, which
 * regeneration cannot recover. A guide goes through this transitional period only once — after one
 * landing, `gen_prose` has a value.
 */
export function keepIntro(richText, generatedProse) {
  if (!generatedProse) return carriesPointer(richText);
  const mine = new Set(generatedProse.map(normalizeProse));
  return !mine.has(normalizeProse(richTextToPlain(richText ?? [])));
}

/**
 * Pick the section intros out of the markdown **we just wrote** — the non-empty lines after a
 * heading and before the first `- [ ]`. Stored into `guides.gen_prose` after a successful landing,
 * as the reverse lookup for the next overwrite.
 */
export function sectionIntros(markdown) {
  const out = [];
  let intro = false;
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    // **Only `##` and deeper count as a section heading.** `#` is the guide's own title, and what
    // follows it immediately is the `appid:` line — written by the program, not a section intro, and
    // collecting it would only leave noise in the provenance
    if (/^#{2,6}\s/.test(line)) { intro = true; continue; }
    if (/^#\s/.test(line)) { intro = false; continue; }
    if (/^[-*]\s*\[[ xX]\]/.test(line)) { intro = false; continue; }
    if (!intro || !line) continue;
    if (/^<\/?(details|summary)/i.test(line)) continue;
    out.push(normalizeProse(line));
  }
  return out;
}
