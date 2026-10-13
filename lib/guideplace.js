/**
 * Placing new entries in a guide
 * ------------------------------------------------
 * A game update adds achievements, and the guide — written before it — has no entry for them. Once
 * an entry is written (`guidepatch.js`), it still has to go somewhere. That is two separate things,
 * and this file is both of them, kept away from the writing:
 *
 *  1. **Which section is it about?** A judgement, asked of the model in one small request with no
 *     research in it (`placeAdditions`), against a closed list of the guide's own sections.
 *  2. **Where exactly, and with what spacing?** Arithmetic, done here from the guide's own content
 *     (`localSections` / `notionSections` / `localInsertEdits`) and never left to the model.
 *
 * ## The rules this file keeps
 *
 * **A failed judgement lands anyway.** The entry is written, ticked and through the gates by the
 * time this runs; a section it was never filed under is a tidiness problem. So every failure here —
 * an unreadable reply, a refusal, an answer naming nothing — degrades to the end of the guide, and
 * **says which failure it was**, because five different ones would otherwise produce the same
 * sentence. The one exception is a cancellation: it is not a failure, and a retry that swallowed it
 * would turn a Cancel click into "finished anyway".
 *
 * **A section is judged by its own content, and a new entry goes after all of it.** "After the last
 * entry" sounds right and is not: whatever sits beside that entry — a fold, a table, an image the
 * user pasted — belongs with it, and putting a new entry between the two attaches that block to the
 * wrong achievement without any machine noticing. After everything the section holds can only ever
 * look a little late.
 *
 * **Only a section that holds an attributable entry is offered.** Nothing else has an anchor worth
 * the name, and a pure-prose section the model files an entry under is one nobody would look in.
 *
 * **This file has no I/O of its own.** The one network call is the provider's, handed in. Splicing
 * is a list of pure insertions for `spliceLines`, so what changed is always exactly the inserted
 * lines, in the file's own line-ending style.
 */

import { guideOutline, normSectionTitle, todoSpansWithToggles } from './markdown.js';
import { blocksToOutline } from './notionblocks.js';
import { groupBySection } from './guidescope.js';
import { createSession, checkResult, addUsage, emptyUsage } from './ai.js';
import { achievementName, achievementDescription } from './lang.js';
import { msgError } from './messages.js';
import { ASIDE_EFFORT, REGROUP_ATTEMPTS } from './guidegen.js';

/**
 * The heading for entries no existing section fits, in `[zh, en]`.
 *
 * It is **content**: it is written into the user's guide, so it follows the guide's language, which
 * is why it is picked by index from this table and never composed through `msg()`, which would
 * answer in whatever language the interface happens to be in. It carries no count — the linter
 * flags one in a heading, and a count goes stale the next time something is added.
 */
export const FALLBACK_HEADING = ['更新新增成就', 'Added in updates'];

export function fallbackHeading(lang) {
  return FALLBACK_HEADING[lang === 'en' ? 1 : 0];
}

/** A section an earlier run made for the same purpose, in either language */
const isFallbackTitle = (title) => FALLBACK_HEADING.some((h) => normSectionTitle(h) === normSectionTitle(title));

const HEADING_LINE = /^#{1,6}\s+\S/;

// ---------------------------------------------------------------------------
// Where each section ends
// ---------------------------------------------------------------------------

/**
 * The sections of a local guide a new entry can be filed under, each with the line its content ends
 * on.
 *
 * Content runs from the section's last attributable entry to the next heading **of any level** —
 * the same boundary `groupBySection` draws, so a section with subsections ends where its first
 * subsection begins. Trailing blank lines are not content: the new lines go before them, which is
 * what keeps the blank line ahead of the next heading where it was.
 *
 * Entries before the first heading belong to no section, and a guide with no headings has no
 * candidate at all; both fall to the end of the guide.
 */
export function localSections(text, defs) {
  const lines = String(text ?? '').split(/\r?\n/);
  const groups = groupBySection(guideOutline(text), defs).filter((g) => g.heading !== null);
  return groups.map((g, index) => {
    let end = lines.length;
    for (let i = g.lastAt.line + 1; i < lines.length; i++) {
      if (HEADING_LINE.test(lines[i])) { end = i; break; }
    }
    let last = end - 1;
    while (last > g.lastAt.line && !lines[last].trim()) last--;
    return { index, title: g.heading, path: g.path, level: g.level, apiNames: g.apiNames, anchor: { line: last } };
  });
}

const isHeadingBlock = (b) => /^heading_[123]$/.test(b?.type ?? '');

/**
 * The same sections of a Notion page, each anchored on the block a new entry goes **after**.
 *
 * `blocks` is `fetchAllBlocks`' result — every block, children inlined — never `fetchAllToDoBlocks`',
 * which has no headings in it.
 *
 * An entry on the page itself is anchored on the last block before the next heading, whatever its
 * type, for the reason given at the top of this file. An entry inside a container (a toggle, a
 * column) is anchored on the entry itself, inside that container: the heading that bounds the
 * section is not a sibling there, and walking out of the container to find one would put the new
 * entry in a different place from the entries beside it.
 */
export function notionSections(blocks, defs, pageId) {
  const groups = groupBySection(blocksToOutline(blocks), defs).filter((g) => g.heading !== null);
  return groups.map((g, index) => ({
    index,
    title: g.heading,
    path: g.path,
    level: g.level,
    apiNames: g.apiNames,
    anchor: notionAnchor(blocks, g.lastAt, pageId),
  }));
}

function notionAnchor(blocks, at, pageId) {
  const top = blocks.findIndex((b) => b.id === at.id);
  if (top < 0) return { id: at.id, parentId: at.parentId ?? pageId };
  let end = top;
  while (end + 1 < blocks.length && !isHeadingBlock(blocks[end + 1])) end++;
  return { id: blocks[end].id, parentId: at.parentId ?? pageId };
}

// ---------------------------------------------------------------------------
// Asking which section
// ---------------------------------------------------------------------------

/** How many of a section's entries the prompt names. Enough to say what the section is about, few enough to read */
const SAMPLE_NAMES = 4;

/** How much of the model's own note on an entry is shown back to it — the part that says what the entry is about */
const NOTE_CHARS = 160;

/**
 * The placement pass's system prompt. **No network and no research**: the entries are written, and
 * this pass only files them.
 */
export function placementSystemFor(lang) {
  return lang === 'en'
    ? 'You are filing newly added achievements into a Steam achievement guide that is already ' +
      'written. Output the filing only: no explanation, no restating the prose, no rewording of ' +
      'any achievement.'
    : '你在给一份已经写好的 Steam 成就攻略归类新增的成就。只输出归类结果,' +
      '不要解释、不要复述正文、不要改写任何成就的文字。';
}

/** What the model wrote about an entry beyond its name and the official description — the part that says what it is about */
function notesOf(text) {
  const parts = String(text ?? '').split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean);
  return parts.slice(2).join(' ').replace(/\s+/g, ' ').slice(0, NOTE_CHARS);
}

/**
 * The placement prompt. Sections and entries are both **numbered**, and the reply is numbers only:
 * a title has to match to the letter to be matched at all, and two sections of one title under
 * different parents cannot be told apart by it. A number cannot be misspelt.
 *
 * Written after the prose, which is what makes the pass better than filing from names alone: the
 * model has already researched each entry, and its own note on it is shown back to it.
 *
 * @param {object} o
 * @param {string} o.game
 * @param {{apiName: string, def: object, text: string}[]} o.items  the new entries, in the order they are numbered
 * @param {object[]} o.sections  `localSections` / `notionSections`
 * @param {object[]} o.defs      every achievement of the game, to name what a section holds
 * @param {string}   o.lang      the guide's language
 */
export function buildPlacementPrompt({ game, items, sections, defs, lang }) {
  const en = lang === 'en';
  const byApi = new Map(defs.map((d) => [d.api_name, d]));
  const name = (d) => achievementName(d, lang);

  const rows = sections.map((s, i) => {
    const label = sectionLabel(s.path, s.title);
    const names = s.apiNames.map((a) => byApi.get(a)).filter(Boolean).map(name);
    const shown = names.slice(0, SAMPLE_NAMES).join(en ? ', ' : '、');
    const count = s.apiNames.length;
    if (en) return `${i + 1}. ${label} — ${count} ${count === 1 ? 'entry' : 'entries'}${count > SAMPLE_NAMES ? ', for example' : ''}: ${shown}`;
    return `${i + 1}. ${label} — 共 ${count} 条${count > SAMPLE_NAMES ? ',如' : ''}:${shown}`;
  });

  const entries = items.map((it, i) => {
    const d = it.def;
    const desc = achievementDescription(d, lang).trim();
    const note = notesOf(it.text);
    const head = `${i + 1}. **${name(d)}** — ${desc || (en ? '(empty on Steam)' : '(Steam 上是空的)')}`;
    return note ? `${head}\n   ${en ? 'Written as' : '写的是'}: ${note}` : head;
  });

  if (en) {
    return (
      `The guide for ${game} is written. The ${items.length} achievements below were added by a game ` +
      'update, and each has to go into one of the guide\'s existing sections.\n\n' +
      'Pick one **existing section** for each:\n' +
      '- **Use only the numbered sections below**; do not start a new one, and do not retitle any\n' +
      '- Pick the section it fits by what the game asks the player to do, using what the section ' +
      'already holds as the guide; **things of one kind go in one section**\n' +
      '- If none fits, answer 0 (the program puts it at the end of the guide)\n' +
      '- Every new achievement gets an answer\n\n' +
      `Existing sections:\n${rows.join('\n')}\n\n` +
      `New achievements:\n${entries.join('\n')}\n\n` +
      'Output format (exactly this, nothing else):\n' +
      '```\n1 -> 2\n2 -> 0\n```'
    );
  }
  return (
    `《${game}》的攻略已经写好了。下面这 ${items.length} 条是游戏更新后才有的成就,` +
    '要放进攻略里已有的小节。\n\n' +
    '请给每一条选一个**现有的小节**:\n' +
    '- **只能用下面编号的小节**,不要新开,也不要改标题\n' +
    '- 按这个游戏实际要做的事来选,参考小节里已有的成就;**同一类的成就放在同一节**\n' +
    '- 实在没有合适的就答 0(程序会把它放到攻略末尾)\n' +
    '- 每一条新成就都要有一个答案\n\n' +
    `现有小节:\n${rows.join('\n')}\n\n` +
    `新增的成就:\n${entries.join('\n')}\n\n` +
    '输出格式(严格照这个,不要别的):\n' +
    '```\n1 -> 2\n2 -> 0\n```'
  );
}

/** `1 -> 2`, with whichever arrow or colon a model prefers, an optional list bullet, nothing else on the line */
const ANSWER_LINE = /^\s*(?:[-*]\s*)?(\d{1,4})\s*(?:->|=>|→|[:：=])\s*(\d{1,4})\s*$/;

/**
 * Reads the reply: entry number → section number, both from 1, and **0 meaning no section fits**.
 *
 * Only a line that is nothing but an answer counts, so prose around the reply is never mistaken for
 * one. A number naming an entry or a section that does not exist is ignored rather than guessed at,
 * and an entry answered twice keeps its first answer.
 *
 * `answered` counts the entries the reply said anything readable about, **0 included**: "nothing
 * fits any of them" is an answer, and a reply with none at all is a failure, and the two must not
 * look alike to the caller.
 *
 * @returns {{placed: Map<string, number>, none: string[], answered: number}}  `placed` maps an
 *          api_name to a 0-based index into `sections`
 */
export function parsePlacementReply(text, { items, sections }) {
  const placed = new Map();
  const none = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(ANSWER_LINE);
    if (!m) continue;
    const item = items[Number(m[1]) - 1];
    if (!item || seen.has(item.apiName)) continue;
    const n = Number(m[2]);
    if (n === 0) {
      seen.add(item.apiName);
      none.push(item.apiName);
    } else if (sections[n - 1]) {
      seen.add(item.apiName);
      placed.set(item.apiName, n - 1);
    }
  }
  return { placed, none, answered: placed.size + none.length };
}

/**
 * File the new entries under the guide's sections.
 *
 * Asked up to `REGROUP_ATTEMPTS` times, **each in a session of its own**: a rejected reply left in
 * the context is the model being shown its own bad answer and asked to do better. Runs at
 * `ASIDE_EFFORT`, never the run's depth — it writes no prose, and a deep run spends its whole
 * output budget thinking about 162 numbers and is truncated before the answer.
 *
 * @returns {Promise<{placement: Map<string, number>, fallback: string[], reason: string|null, usage: object}>}
 *          `fallback` are the api_names that go to the end of the guide; `reason` is why the pass
 *          failed, and is null when it did not — an entry that fitted no section is not a failure
 */
export async function placeAdditions({ provider, game, lang, items, sections, defs, signal, onProgress = () => {} }) {
  const usage = emptyUsage();
  const all = items.map((it) => it.apiName);
  if (!items.length || !sections.length) return { placement: new Map(), fallback: all, reason: null, usage };

  let reason = null;
  for (let attempt = 1; attempt <= REGROUP_ATTEMPTS; attempt++) {
    const session = createSession(provider, { system: placementSystemFor(lang), effort: ASIDE_EFFORT });
    try {
      const r = await session.ask(buildPlacementPrompt({ game, items, sections, defs, lang }), { signal });
      const verdict = checkResult(r);
      if (!verdict.ok) throw new Error(verdict.reason);
      const parsed = parsePlacementReply(r.text, { items, sections });
      if (!parsed.answered) throw msgError('patch.placeNothing');
      return {
        placement: parsed.placed,
        fallback: all.filter((a) => !parsed.placed.has(a)),
        reason: null,
        usage,
      };
    } catch (err) {
      // A cancellation is not a failure to degrade from, and it is the one thing a retry must not swallow
      if (err?.cancelled) throw err;
      reason = String(err?.message ?? err);
      if (attempt < REGROUP_ATTEMPTS) {
        onProgress({ phase: 'place-retry', attempt, reason });
        continue;
      }
      onProgress({ phase: 'place-failed', reason });
    } finally {
      addUsage(usage, session.usage);
    }
  }
  return { placement: new Map(), fallback: all, reason, usage };
}

// ---------------------------------------------------------------------------
// From answers to insertions
// ---------------------------------------------------------------------------

/**
 * Turn the answers into groups of entries to insert, and what is left over.
 *
 * Entries nobody placed go to **one section at the end**, under `fallbackHeading`. If the guide
 * already has such a section — an earlier run made it, in either language — the entries join it
 * instead of heading a second one, which the linter would flag and a reader would have to look in
 * twice. Within a section the entries keep the order of the guide's achievement list, however the
 * model happened to answer.
 *
 * `fallbackTitle` is the heading the leftover entries are under — the new section's, or the older
 * one's they joined — and null when nothing was left over. It is what the finished run reports.
 *
 * @param {object[]} o.sections   `localSections` / `notionSections`
 * @param {{apiName: string}[]} o.additions  in the order of the achievement list
 * @param {Map<string, number>} o.placement  api_name → index into `sections`
 * @returns {{groups: {section: object, apiNames: string[]}[], tail: {title: string, apiNames: string[]}|null, fallbackTitle: string|null}}
 */
export function planInsertions({ sections, additions, placement, lang }) {
  const order = new Map(additions.map((a, i) => [a.apiName, i]));
  const bySection = new Map();
  const left = [];
  const put = (index, apiName) => {
    if (!bySection.has(index)) bySection.set(index, []);
    bySection.get(index).push(apiName);
  };

  for (const a of additions) {
    const i = placement.get(a.apiName);
    if (Number.isInteger(i) && sections[i]) put(i, a.apiName);
    else left.push(a.apiName);
  }

  let tail = null;
  let fallbackTitle = null;
  if (left.length) {
    const existing = sections.find((s) => isFallbackTitle(s.title));
    if (existing) {
      left.forEach((a) => put(existing.index, a));
      fallbackTitle = existing.title;
    } else {
      tail = { title: fallbackHeading(lang), apiNames: left };
      fallbackTitle = tail.title;
    }
  }

  const groups = [...bySection]
    .sort(([a], [b]) => a - b)
    .map(([index, apiNames]) => ({
      section: sections[index],
      apiNames: [...apiNames].sort((x, y) => order.get(x) - order.get(y)),
    }));
  return { groups, tail, fallbackTitle };
}

const sameTitle = (a, b) => normSectionTitle(a) === normSectionTitle(b);
const samePath = (a, b) => a.length === b.length && a.every((t, i) => sameTitle(t, b[i]));

/** A section as a person reads it: its title, with the headings above it when there are any */
export const sectionLabel = (path, title) => [...path, title].join(' › ');
const labelOf = sectionLabel;

/**
 * Whether each new entry is in the section it was meant for, in a guide **read back after writing**.
 *
 * An insertion that lands under the wrong heading raises nothing: every request succeeds, every
 * entry is on the page, and the linter has no rule about where. So the sections are read again,
 * from what is actually there, and each entry is looked up in them — by title **and path**, since
 * two sections can share a title.
 *
 * @param {object[]} o.sections  `localSections` / `notionSections` of the landed guide
 * @param {object}   o.plan      `planInsertions`' result for what was inserted
 * @returns {{apiName: string, wanted: string, got: string|null}[]}  the entries not where they should be
 */
export function verifyPlacement({ sections, plan }) {
  const where = new Map();
  for (const s of sections) for (const a of s.apiNames) if (!where.has(a)) where.set(a, s);

  const bad = [];
  const expect = (apiNames, title, path) => {
    for (const apiName of apiNames) {
      const got = where.get(apiName);
      if (got && sameTitle(got.title, title) && samePath(got.path, path)) continue;
      bad.push({ apiName, wanted: labelOf(path, title), got: got ? labelOf(got.path, got.title) : null });
    }
  };
  for (const g of plan.groups) expect(g.apiNames, g.section.title, g.section.path);
  if (plan.tail) expect(plan.tail.apiNames, plan.tail.title, []);
  return bad;
}

/**
 * Whether this guide separates its entries with a blank line.
 *
 * Judged from the gaps between consecutive top-level entries of one section: no lines between them
 * is a tight guide, only blank lines is a spaced one. A gap holding anything else is prose between
 * entries and says nothing either way, and a gap across a heading is a section boundary, not a
 * style. Ties, and a guide with no gap to judge, read as tight — what a generated guide is.
 */
function prefersSpaced(text) {
  const lines = String(text).split(/\r?\n/);
  const spans = todoSpansWithToggles(String(text));
  const starts = [...spans].filter(([, s]) => s.indent === 0).map(([k]) => k).sort((a, b) => a - b);
  let spaced = 0;
  let tight = 0;
  for (let i = 0; i + 1 < starts.length; i++) {
    const gap = lines.slice(spans.get(starts[i]).end + 1, starts[i + 1]);
    if (gap.some((l) => HEADING_LINE.test(l))) continue;
    if (!gap.length) tight++;
    else if (gap.every((l) => !l.trim())) spaced++;
  }
  return spaced > tight;
}

/**
 * The insertions that put the new entries into a local guide: **pure insertions** for
 * `spliceLines`, each an empty range, so nothing is replaced and nothing removed.
 *
 * - A group goes straight after its section's last line of content, with a blank line before each
 *   entry in a guide that spaces its entries.
 * - The leftover becomes a new `##` section after the last non-blank line of the file, with a blank
 *   line before the heading and one after it.
 * - **Insertions at one position are one edit.** Two edits at the same line would depend on how
 *   the splice sorts them, and the last section ending at the end of the file is exactly the case
 *   where a group and the new section meet.
 *
 * `found` maps api_name → the lines the model wrote for it, which are inserted as they are.
 */
export function localInsertEdits({ text, sections, plan, found }) {
  const lines = String(text).split(/\r?\n/);
  const spaced = prefersSpaced(text);
  const entries = (apiNames, { lead }) => apiNames.flatMap((a, k) => (
    spaced && (lead || k > 0) ? ['', ...found.get(a)] : found.get(a)
  ));

  const at = new Map();
  const add = (pos, ls) => at.set(pos, [...(at.get(pos) ?? []), ...ls]);

  for (const g of plan.groups) add(g.section.anchor.line + 1, entries(g.apiNames, { lead: true }));
  if (plan.tail) {
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    add(last + 1, ['', `## ${plan.tail.title}`, '', ...entries(plan.tail.apiNames, { lead: false })]);
  }
  return [...at].map(([pos, ls]) => ({ start: pos, end: pos - 1, lines: ls }));
}
