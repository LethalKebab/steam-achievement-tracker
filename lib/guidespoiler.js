/**
 * The spoiler pass
 * ------------------------------------------------
 * Moves a sentence that states a fact about the story out of an achievement's notes and into a
 * folded block underneath it.
 *
 * **Why this is a pass and not a rule in the writing prompt.** It was a rule first, and it never
 * once fired — three live runs, two wordings, zero folds, all recorded in `docs/ai-guide-writing.md`.
 * Asked the same question in the same words as the *only* question, over a finished guide, the same
 * model returns the offending sentence immediately. So it can write the spoiler and it can recognise
 * the spoiler; what it will not do is restructure an entry it is halfway through writing, on rule 38
 * of a thirteen-thousand-character prompt. Every other transformation here already runs after the
 * writing — ticking, `unwrapAchievementToggles`, `collapseEmptyBreaks`, the classification pass —
 * and this one was the only one asked for inline.
 *
 * **The model returns a selection; this file does the cutting.** That is `guidepatch`'s rule, for
 * its reason: if the model returns rewritten prose there is no way to verify it left the rest alone.
 * Here it returns sentences it did not write, which can be checked against the text that is already
 * on disk, and everything that cannot be located is discarded rather than guessed at.
 *
 * Ordering: **before `regroup`**, in the same slot as `unwrapAchievementToggles`, and for the same
 * reason recorded there — `regroup`'s third assertion compares toggle contents, so a pass that
 * creates toggles run afterwards is judged to have torn one open and rolls the whole thing back.
 */
import { flatCompare, foldTypography } from './guides.js';
import { todoSpansWithToggles } from './markdown.js';

/** A top-level checkbox line. Sub-steps are indented and are not entries */
const ENTRY_RE = /^[-*]\s*\[[ xX]\]\s/;
/** `【3】the sentence` — one pick per line. `【】` are U+3010/3011, outside the CJK class the i18n guard scans */
const PICK_RE = /^\s*【\s*(\d+)\s*】\s*(.+?)\s*$/gm;

/**
 * The label the fold carries. **A closed vocabulary of one word, in two languages, and both are
 * accepted on either language's guide** — see `guidelint.js`, which checks the same thing.
 */
const LABEL = { zh: '剧透', en: 'Spoiler' };

/**
 * What the model is asked. **Deliberately the only thing it is asked** — this whole file exists
 * because the same sentences buried in the writing prompt were ignored.
 *
 * The trigger wording is kept word for word in step with the prompt's own `剧透` notation. They are
 * two statements of one rule, and if they drift the pass starts folding a different set of things
 * than the writer was told to leave foldable.
 */
export function spoilerSystemFor(lang) {
  if (lang === 'en') {
    return `You are checking a finished Steam achievement guide, and doing exactly one thing: finding the sentences that **state a fact about the story itself**.

The test: how it ends, what the twist is, who somebody turns out to be, what actually happened in some scene.
How to do it, where it is, how many runs it takes, how hard it is, whether it can be missed — none of that spoils anything.

Go through the entries below one at a time. Where an entry contains such a sentence, **quote that sentence exactly as it stands**, without changing a character. Where it does not, skip that entry; do not go looking for one.

Output this and nothing else, no explanation:
【number】the sentence`;
  }
  return `你在检查一份已经写好的 Steam 成就攻略,只做一件事:找出**说出了故事本身的事实**的句子。

判据:结局是什么、反转是什么、某个角色到底是谁、某段剧情实际发生了什么。
怎么操作、在哪、要刷几次、难不难、会不会错过,都不是剧透。

逐条看下面的成就条目。对每一条,如果里面有这样的句子,**原样抄出那一句**,一个字都不要改。没有就跳过这一条,不要勉强找。

只输出这个,不要解释:
【编号】原句`;
}

/** The entries, numbered. The numbers are a handle for the reply, not something this file trusts */
export function buildSpoilerMessage(entries, lang) {
  const head = lang === 'en'
    ? `Here are the ${entries.length} achievement entries of this guide:`
    : `下面是这份攻略的 ${entries.length} 条成就条目:`;
  return `${head}\n\n${entries.map((e, i) => `【${i + 1}】\n${e}`).join('\n\n')}`;
}

/** Every top-level entry, as `{ line, text, end }` — `line` is where the checkbox is, `end` where its span stops */
export function guideEntries(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const spans = todoSpansWithToggles(String(text ?? ''));
  const out = [];
  for (const [start, span] of spans) {
    if (!ENTRY_RE.test(lines[start] ?? '')) continue;   // indented ⇒ a sub-step, not an entry
    out.push({ line: start, end: span.end, text: lines[start] });
  }
  return out;
}

/**
 * Turn the reply into picks this file is willing to act on.
 *
 * **The number the model returns is a hint, never the answer.** Each quoted sentence is located in
 * the guide by its own content, and the entry it is found in is the entry that gets folded — so a
 * mis-numbered reply still lands correctly, and a sentence the model invented lands nowhere.
 *
 * Three refusals, all of them silent-failure shaped if they were left out:
 *
 * - **Not found** ⇒ discarded. Told to copy verbatim, the model reformats anyway: measured, it
 *   returned `“船长杀了所有人”` where the guide holds `"船长杀了所有人"`. `flatCompare` is what makes
 *   those the same string; a raw `includes` would discard every pick and report nothing wrong.
 * - **Found in more than one entry** ⇒ discarded. Same posture as the matching rules everywhere else
 *   in this project: a missed fold is cheap, folding the wrong entry's prose is not.
 * - **Inside the achievement's name** ⇒ discarded. The name is copied from Steam verbatim and is one
 *   of the two handles `resolveTodoToAchievement` matches on; cutting into it would break ticking.
 */
export function parseSpoilerReply(reply, entries) {
  const picks = [];
  const discarded = [];
  const seen = new Set();

  for (const m of String(reply ?? '').matchAll(PICK_RE)) {
    const quote = m[2].trim();
    if (!quote || seen.has(quote)) continue;
    seen.add(quote);

    const flat = flatCompare(quote);
    if (!flat) continue;
    const hits = entries.filter((e) => flatCompare(e.text).includes(flat));
    if (hits.length !== 1) {
      discarded.push({ quote, reason: hits.length ? 'ambiguous' : 'not-found' });
      continue;
    }

    const entry = hits[0];
    const at = foldTypography(entry.text).indexOf(foldTypography(quote));
    // Located across `<br>` boundaries by flatCompare but not as a contiguous run of this line:
    // the sentence spans a break, and cutting it would join two parts that were separate
    if (at === -1) {
      discarded.push({ quote, reason: 'not-contiguous' });
      continue;
    }
    const firstBreak = foldTypography(entry.text).search(/<br\s*\/?>/i);
    if (firstBreak === -1 || at < firstBreak) {
      discarded.push({ quote, reason: 'in-the-name' });
      continue;
    }
    picks.push({ quote, entry, at });
  }
  return { picks, discarded };
}

/**
 * The same pass over **a set of separate entry blocks** rather than a whole document, which is the
 * shape a partial rewrite works in: `parsePatchReply` hands back one block of lines per rewritten
 * achievement, and those are the only entries `--only` is allowed to touch.
 *
 * **Scoping it to those blocks is the point, not an optimisation.** Run over the whole guide here,
 * the pass would fold entries the user did not name, and "nothing outside the named set is touched"
 * is the entire guarantee `--only` exists to provide.
 *
 * Each block is folded on its own, so the line numbers a pick carries stay block-relative and no
 * offset bookkeeping is needed across them. The model is still asked **once**, about all of them.
 *
 * @param {string[][]} blocks   one array of lines per rewritten entry
 * @returns {{blocks: string[][], applied: object[], skipped: object[]}}
 */
export function foldSpoilersInBlocks(blocks, reply, defs = [], lang = 'zh') {
  const perBlock = blocks.map((lines, i) => ({ i, text: lines.join('\n'), entries: guideEntries(lines.join('\n')) }));
  const all = perBlock.flatMap((b) => b.entries.map((e) => ({ ...e, block: b.i })));
  const { picks, discarded } = parseSpoilerReply(reply, all);

  const out = blocks.map((lines) => lines);
  const applied = [];
  const skipped = [...discarded];
  for (const b of perBlock) {
    const mine = picks.filter((p) => p.entry.block === b.i);
    if (!mine.length) continue;
    const folded = foldSpoilers(b.text, mine, defs, lang);
    if (!folded.applied.length) { skipped.push(...folded.reverted); continue; }
    out[b.i] = folded.text.split('\n');
    applied.push(...folded.applied);
    skipped.push(...folded.reverted);
  }
  return { blocks: out, applied, skipped };
}

/** `- [ ] **X**<br>desc<br>a<br><br>b` → the same without the empty part. The narrow case this pass creates */
const tidy = (line) => line.replace(/(<br\s*\/?>)\s*(?=<br\s*\/?>)/gi, '').replace(/(<br\s*\/?>)\s*$/i, '');

/**
 * Cut each picked sentence out of its entry and hang it in a fold underneath.
 *
 * **The fold goes after the entry's whole span, not directly under the checkbox line.** An entry may
 * already own sub-step checkboxes, and `todoSpans` — the range a *local* partial rewrite replaces —
 * ends at the first non-checkbox line, so a fold inserted in the middle would cut that run in half.
 * At the end of the span, `todoSpansWithToggles` still carries it (its loop takes checkbox lines and
 * `<details>` blocks alike), which is the same predicate `guidelint` calls the fold "attached" by.
 *
 * **`defs` is a post-condition, not a hint.** After cutting, an entry that quoted its official
 * description must still quote it byte for byte — that description is what `audit` reverse-resolves
 * a ticked box by, and this pass is not allowed to be the thing that breaks it. A pick that would
 * damage it is reverted individually rather than failing the pass.
 *
 * @returns {{text: string, applied: object[], reverted: object[]}}
 */
export function foldSpoilers(text, picks, defs = [], lang = 'zh') {
  const lines = String(text ?? '').split(/\r?\n/);
  const label = LABEL[lang === 'en' ? 'en' : 'zh'];
  const descriptions = defs.map((d) => String(d.description ?? '').trim()).filter(Boolean);

  const applied = [];
  const reverted = [];
  // Keyed by line so two picks in one entry share a fold rather than making two
  const byLine = new Map();

  for (const p of picks) {
    const original = lines[p.entry.line];
    // **What goes into the fold is the guide's own bytes, never the model's copy of them.** The two
    // differ: told to quote verbatim it still reformats, which is the whole reason `foldTypography`
    // is used to find the offset. Writing `p.quote` back would quietly retype the author's sentence
    // in the model's punctuation — and the entry would still read correctly, so nothing would say so.
    // Safe to slice by the quote's length only because that fold is length-preserving.
    const verbatim = original.slice(p.at, p.at + p.quote.length);
    const cut = tidy(original.slice(0, p.at) + original.slice(p.at + p.quote.length));

    // Everything the entry quoted verbatim before must still be quoted verbatim after
    const lost = descriptions.find((d) => original.includes(d) && !cut.includes(d));
    if (lost) {
      reverted.push({ quote: p.quote, reason: 'would-cut-the-official-description' });
      continue;
    }

    lines[p.entry.line] = cut;
    if (!byLine.has(p.entry.line)) byLine.set(p.entry.line, { end: p.entry.end, body: [] });
    byLine.get(p.entry.line).body.push(verbatim);
    applied.push({ quote: p.quote, line: p.entry.line + 1 });
  }

  // Inserted from the bottom up, so an earlier insertion never shifts a later entry's line numbers
  for (const [, fold] of [...byLine].sort((a, b) => b[0] - a[0])) {
    const block = ['  <details>', `  <summary>${label}</summary>`, ...fold.body.map((b) => `  ${b}`), '  </details>'];
    lines.splice(fold.end + 1, 0, ...block);
  }

  return { text: lines.join('\n'), applied, reverted };
}
