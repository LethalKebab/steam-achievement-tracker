/**
 * Partial rewrite — orchestration
 * ------------------------------------------------
 * "Rewrite only the achievements named." A whole-guide rewrite goes through `generateGuide` in
 * `guidegen.js`; this is a separate path that shares its prompt, its gate and its backup rules.
 *
 * ## Why a separate file rather than a branch in generateGuide
 *
 * `generateGuide` is 500-odd lines, almost all of it **sharded-concurrency** machinery: a session
 * per shard, the three-rung split ladder, failed-shard bookkeeping, the flattened shard-index
 * mapping. A partial rewrite needs none of it — it is one request, a named set of entries, one
 * splice. Making it a branch of that function would add a dimension to an already dense state
 * machine, while the only things the two paths genuinely share are **the prompt and the gate**,
 * both of which are imported.
 *
 * ## Three hard rules on this path
 *
 * 1. **Splice back only the entries named, at known line numbers / block ids.** The guarantee comes
 *    not from "telling the model not to touch the rest" but from the program accepting only the
 *    entries it asked for and writing only at the positions it recorded. Anything extra the model
 *    writes is **not applied** (reported, not applied) — the same move as mechanical ticking
 *    replacing "check whether the model wrote `- [x]` correctly".
 * 2. **The gate does not loosen.** Ticking and validation always run over **the whole guide after
 *    the change**, using the same `lintGuide` / `computeCheckedKeys` pair. The only addition is that
 *    problems the old guide already had are not charged to this run (`classifyFindings`), or a
 *    change made correctly would be discarded over an old problem the user did not ask to fix and we
 *    were not authorised to touch.
 * 3. **The backup is a precondition.** As with `--overwrite`: a failed backup writes nothing. A
 *    partial rewrite alters less text, but "less" is not "reversible".
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadTodos, parseTodos, todoSpans, todoSpansWithToggles, spliceLines, applyChecks, resolveGuidePath,
} from './markdown.js';
import { lintGuide, computeCheckedKeys } from './guidelint.js';
import { resolveTodoToAchievement, syncGuidesFromMarkdown } from './guides.js';
import { markdownToBlocks } from './notionblocks.js';
import { extractNotionPageId } from './notion.js';
import { createSession, checkResult, addUsage, emptyUsage } from './ai.js';
import {
  spoilerSystemFor, buildSpoilerMessage, guideEntries, foldSpoilersInBlocks,
} from './guidespoiler.js';
import { backupGuide, patchPreflight } from './guidebackup.js';
import { resolveScope, scopeEntries, classifyFindings, groupBySection } from './guidescope.js';
import { msg, msgError, achName } from './messages.js';
import { achievementName } from './lang.js';
import {
  DRAFTS_DIR, MODEL_FIXABLE, RETRYABLE, SPLITTABLE,
  systemPromptFor, buildPatchMessage, collapseEmptyBreaks, extractMarkdown, splitFindings, planGuide,
} from './guidegen.js';

/** How many rounds a partial rewrite asks at most. 2 by default, one fewer than a whole-guide rewrite — see the comment on patchGuide at the end of this file */
export const PATCH_ROUNDS = 2;

/**
 * For each entry returned: which achievement it is, and which lines it occupies.
 *
 * **Only top-level entries are recognised** (`parent === null`): indented ones are sub-steps
 * belonging to the entry above, and reverse-resolving one on its own would go looking for
 * 「第 3 座神庙」 as though it were an achievement.
 *
 * Attribution goes through `resolveTodoToAchievement` — the same function used by ticking, auditing
 * and the Dashboard cards, without the slightest relaxation. Anything unrecognised goes into
 * `unresolved` and is **not guessed at**: the consequence of a wrong guess is A's method pasted
 * under B's heading, which is this feature's worst failure mode.
 *
 * @returns {{found: Map<string, string[]>, unresolved: string[]}}
 */
export function parsePatchReply(markdown, defs, { kind = 'local' } = {}) {
  const md = String(markdown ?? '');
  const lines = md.split(/\r?\n/);
  const spans = kind === 'notion' ? todoSpansWithToggles(md) : todoSpans(md);
  const found = new Map();
  const unresolved = [];

  for (const t of parseTodos(md)) {
    if (t.parent !== null && t.parent !== undefined) continue;
    const hit = resolveTodoToAchievement(t.text, defs);
    if (!hit) {
      unresolved.push(t.text.slice(0, 60));
      continue;
    }
    // The same achievement returned twice is taken once, consistent with mapAchievementGuides: a
    // duplicate is usually the model mentioning it again in passing, and splicing both back would
    // genuinely put two of them in the guide
    if (found.has(hit.def.api_name)) continue;
    // With Notion as the target, a group label is a `<details>`, so the range must swallow the
    // collapse too (see todoSpansWithToggles). Local markdown keeps `todoSpans`' conservative range
    // — there, eating one line too many deletes text silently.
    const span = spans.get(t.key);
    found.set(hit.def.api_name, lines.slice(span.start, span.end + 1));
  }

  return { found, unresolved };
}

/**
 * **Re-indent** a returned block to the depth of the entry it replaces.
 *
 * Achievements in a guide are always top level (indent 0), and so is what the model returns, so this
 * function normally does nothing. It stays because doing nothing is conditional on "both sides are
 * top level", which is an **assumption** rather than a guarantee — when the indentation genuinely
 * disagrees, not correcting it leaves that entry hanging under the achievement above it as a
 * sub-step, which `loadTodos` reads exactly that way while the validator says nothing (it checks
 * whether an achievement has a box, not where the box hangs).
 *
 * It only shifts right, never trims left: trimming left means guessing which spaces are structure
 * and which are alignment, and a wrong guess changes the nesting.
 */
function reindent(block, delta) {
  if (delta <= 0) return block;
  const pad = ' '.repeat(delta);
  return block.map((l) => (l.trim() ? pad + l : l));
}

/** A checkbox line's indent width. Treated as 0 when unavailable */
const indentOf = (line) => {
  const m = String(line ?? '').match(/^(\s*)[-*]\s*\[/);
  return m ? m[1].length : 0;
};

/**
 * The feedback list: **only problems on the entries changed this run**.
 *
 * Written separately from `buildChunkFeedback` because what has to be said differs: that one says
 * "this shard broke a rule, output the shard again"; this one says "of the entries you just
 * rewrote, these are still wrong, try again" — and it must restate "do not touch the others", or the
 * model readily goes off to fix whichever other achievements the feedback list mentions.
 */
export function buildPatchFeedback(findings, entries, missing = [], lang = 'zh') {
  if (lang === 'en') return buildPatchFeedbackEn(findings, entries, missing);
  const mine = new Set(entries.map((e) => e.apiName));
  const own = findings.filter((f) => MODEL_FIXABLE.has(f.code) && (!f.apiName || mine.has(f.apiName)));
  const byApi = new Map(entries.map((e) => [e.apiName, e]));
  const shown = (a) => {
    const d = byApi.get(a)?.def;
    return achName(d) || a;
  };

  const parts = [];
  // **"Never returned at all" and "returned but written wrongly" must be stated separately.** Merged
  // into one sentence, the omitted entries are described as "failed validation", and what the model
  // receives is an instruction to fix something it believes it already wrote
  if (missing.length) {
    parts.push(
      `这 ${missing.length} 条一条都没交回来:${missing.map(shown).join('、')}\n` +
        '**每一条都必须有自己的 `- [ ]` 行**,一条都不能少。'
    );
  }
  if (own.length) {
    parts.push(
      `这几条交回来了,但没过机器校验:\n${own.slice(0, 40).map((f) => `✖ ${f.message}`).join('\n')}`
    );
  }

  return (
    parts.join('\n\n') +
    `\n\n请**重新输出这 ${entries.length} 条的完整 markdown**(还是一个 \`\`\`markdown 围栏、` +
    '还是那个顺序、还是每条一个顶层 `- [ ]` 行)。**别动别的成就** —— 上面提到的问题' +
    '如果牵扯到不在这几条里的成就,那不是这一轮的事。\n' +
    'checkbox 的勾选状态不用管,程序会填;粗体名字一字不差、官方描述原文照抄。'
  );
}

/**
 * `buildPatchFeedback` in English. The name is resolved against the guide's language rather than
 * the interface's, for the reason given on `defNameIn` in guidegen.js.
 */
function buildPatchFeedbackEn(findings, entries, missing) {
  const mine = new Set(entries.map((e) => e.apiName));
  const own = findings.filter((f) => MODEL_FIXABLE.has(f.code) && (!f.apiName || mine.has(f.apiName)));
  const byApi = new Map(entries.map((e) => [e.apiName, e]));
  const shown = (a) => {
    const d = byApi.get(a)?.def;
    return achievementName(d, 'en') || a;
  };

  const parts = [];
  if (missing.length) {
    parts.push(
      `These ${missing.length} did not come back at all: ${missing.map(shown).join(', ')}\n` +
        '**Every one of them needs its own `- [ ]` line**, without exception.'
    );
  }
  if (own.length) {
    parts.push(
      `These came back, but did not pass validation:\n${own.slice(0, 40).map((f) => `✖ ${f.message}`).join('\n')}`
    );
  }

  return (
    parts.join('\n\n') +
    `\n\n**Output the complete markdown for these ${entries.length} again** (one \`\`\`markdown fence, ` +
    'the same order, one top-level `- [ ]` line each). **Leave the other achievements alone** — where ' +
    'a problem above involves an achievement that is not in this set, that is not this round\'s business.\n' +
    'Ignore the checkbox tick state, the program fills it in; bold names match exactly, official ' +
    'descriptions are copied verbatim.'
  );
}

/**
 * Apply the change to the in-memory todo list, for the gate to inspect.
 *
 * **This is the only way the Notion backend can be gated before writing** — there is no "whole page
 * source" to assemble there, while `lintGuide` needs exactly a todo list (the same shape from both
 * backends, which is the entire point of it being backend-agnostic). So this simulates the result of
 * the splice at the todo-list level: replace that entry's prose, drop its old sub-steps, attach the
 * newly written ones.
 *
 * New entries are always `checked: false`: they have just been written, and the checked state is
 * filled shortly afterwards by `computeCheckedKeys` from the database — the same rule as whole-guide
 * generation, rather than "carry the old checked state over". Carrying it over would be wrong,
 * because the old tick may have been wrong in the first place, and that is precisely what mechanical
 * ticking exists to eliminate.
 */
export function applyPatchToTodos(todos, entries, found, { kind = 'local' } = {}) {
  /**
   * What the model returns is always markdown (`<br>`). A local guide stores `<br>` as-is; on the
   * Notion side `toRichText` converts it to a real newline (notionblocks.js), so reading back after
   * writing yields `\n`. What is simulated here is **what the backend will hold after the write**,
   * so the Notion case converts first.
   *
   * **This is not about making matching work** — `normalizeText` already normalises `<br>` to a
   * newline, both backends take the same path, and matching succeeds either way. The one reason to
   * convert is to make **this pre-write validation** and **the post-write read-back validation** see
   * the same text, so that a disagreement between them means "the write went wrong" rather than
   * "the two representations differ". The difference only pays when something has actually gone
   * wrong, which is exactly when it is needed.
   */
  const asBackendText = (s) => (kind === 'notion' ? String(s).replace(/<br\s*\/?>/gi, '\n') : String(s));

  const dropped = new Set();
  const replaced = new Map();
  for (const e of entries) {
    const block = found.get(e.apiName);
    if (!block) continue;
    for (const s of e.subTodos) dropped.add(s.key);
    replaced.set(e.key, block);
  }

  const out = [];
  for (const t of todos) {
    if (dropped.has(t.key)) continue;
    const block = replaced.get(t.key);
    if (!block) {
      out.push(t);
      continue;
    }
    // The block's first line is the achievement itself, followed by its new sub-steps. The sub-steps
    // get synthesised keys — they have no Notion block id yet (one exists only after the append),
    // and the gate needs only that keys are distinct and can express the parent relationship
    const sub = parseTodos(block.join('\n'));
    out.push({ key: t.key, text: asBackendText(sub[0]?.text ?? ''), checked: false, parent: t.parent });
    for (let i = 1; i < sub.length; i++) {
      out.push({
        key: `${t.key}#sub${i}`,
        text: asBackendText(sub[i].text),
        checked: false,
        // One level only: sub[i].parent points at a line number within the block, and the block has
        // no top-level item other than line 0, so the parent is always this achievement
        parent: t.key,
      });
    }
  }
  return out;
}

/**
 * Partially rewrite an existing guide.
 *
 * @param {object} db
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.provider
 * @param {object} o.steam
 * @param {string} o.appid
 * @param {object} [o.notion]
 * @param {string} o.selector     see resolveScope in guidescope.js
 * @param {string} [o.instruction] the user's own requirement, passed to the model verbatim
 * @param {number} [o.rounds]
 * @param {object} [o.plan]       pass it in when the CLI has already planned, rather than planning
 *                                again (which costs extra API calls and opens a gap where the plan
 *                                asked about is not the plan written)
 * @param {Function} [o.onProgress]
 */
export async function planPatch(db, { config, steam, appid, notion = null, selector, plan: given = null }) {
  // `overwrite: true` is required: a partial rewrite is an overwrite (of less), and without it
  // planGuide refuses outright because a guide already exists — which is exactly the behaviour it
  // should have
  const plan = given ?? (await planGuide(db, { config, steam, appid, notion, overwrite: true }));
  const { defs, game, unlocked, oldTodos } = plan;

  // With no guide there is nothing to do partially. **State the next action** — the next step after this error is to generate one
  if (!plan.existing) {
    const err = msgError('patch.noGuide', { game });
    err.code = 'no-guide-to-patch';
    throw err;
  }

  const kind = plan.existing.kind;
  /**
   * The whole source text, **available only on the local backend**.
   *
   * `planGuide` has already read it (the overwrite preflight needs it), so it is not read a second
   * time here — the file could have changed between the two reads, and "the copy validated is not
   * the copy written" is the hardest class of bug to diagnose on this path.
   *
   * On the Notion side `plan.oldText` is **every checkbox joined by newlines**, not a document.
   * Handing that to `lintGuide` as the full text immediately produces a false `missing-title` (it of
   * course has no `# 游戏名`), so this must branch by backend rather than take the shortcut
   */
  const oldText = kind === 'local' ? plan.oldText : null;

  // **Validate the old guide before changing anything, and this validation is free** (oldTodos has
  // already been read). It has two uses, neither optional: the `failing` selector picks from it, and
  // classifyFindings uses it to separate "broken by this change" from "already broken"
  const baseline = lintGuide({
    todos: oldTodos,
    defs,
    text: oldText,
    unlockedApiNames: unlocked,
    kind,
  });

  /**
   * **`selector` may be null, meaning "give me the plan and the baseline, do not resolve a scope".**
   *
   * The Dashboard's preflight uses it this way — it takes this plan and computes each of the four
   * presets from it, having no scope of its own. **An internal signal is written as an internal
   * signal**, rather than borrowing a public selector value (passing `'all'`, say) as an internal
   * marker: the moment that value is removed, the borrowing becomes a call that throws.
   */
  //
  // **The test is `== null`, not falsiness.** Written as `if (!selector)`, a user typing
  // `--only ""` would also take this internal shortcut — so `planPatch` would return a result with
  // `scope: null`, and the caller reading `pp.scope.apiNames` immediately hits a TypeError. An empty
  // selector is a **user error** with its own code (`empty-scope`) and terminal advice, and should
  // be thrown as normal. "The caller did not supply one" and "the user supplied an empty one" are
  // two different things, and a falsiness test conflates them
  if (selector === null || selector === undefined) {
    return { plan, kind, oldText, baseline, scope: null, entries: [], unlocatable: [], preflight: null };
  }

  const scope = resolveScope({
    selector,
    defs,
    todos: oldTodos,
    rarity: plan.rarity,
    unlocked,
    text: oldText,
  });

  // Unrecognised names are **stopped before any money is spent**, and must be listed. Changing one
  // fewer entry while reporting "done" means the user only finds out the next time they read the
  // guide — this feature's worst failure mode
  if (scope.unresolved.length) {
    const err = msgError('patch.namesNotFound', { game, list: scope.unresolved.join('、') });
    err.code = 'unknown-achievements';
    err.detail = { unresolved: scope.unresolved };
    throw err;
  }
  if (!scope.apiNames.length) {
    const err = msgError('patch.selectorEmpty', { selector });
    err.code = 'empty-scope-result';
    err.detail = { selector };
    throw err;
  }

  const { entries, unlocatable } = scopeEntries({ todos: oldTodos, defs, apiNames: scope.apiNames });
  if (!entries.length) {
    const err = msgError('patch.noCheckboxes', { n: scope.apiNames.length });
    err.code = 'nothing-locatable';
    err.detail = { unlocatable };
    throw err;
  }

  return {
    plan, kind, oldText, baseline, scope, entries, unlocatable,
    // Everything computable before spending. **A different function from the whole-guide preflight**; the reasoning is in guidebackup.js
    preflight: patchPreflight({ oldTodos, defs, entries, oldText: plan.oldText ?? '' }),
  };
}

/**
 * **The Dashboard offers no scope presets (rare / locked / …), only quick-pick buttons above the
 * selection list.**
 *
 * The difference is that a quick-pick button **ticks** the matching entries, while a preset turns
 * them into an invisible set that is run directly. The latter has a real defect:
 *
 * With a preset selected, the user has **never seen what those 27 entries are**, yet has to confirm
 * a paid and irreversible operation on that set; and once selected it cannot be adjusted — removing
 * even two of them is impossible.
 *
 * Moved into the list: one click → those 27 boxes are ticked → which 27 is visible → and it can
 * still be edited. "Scope" thus returns to a genuine either/or: whole guide, or self-selected.
 * **The presets were never scopes; they are starting points for a selection** — modelling them as
 * scopes was a category error.
 *
 * What went with them: the machinery computing four presets from one plan, the `unavailable`-versus-`0`
 * distinction, and the per-preset preflight. The client already has the rarity and unlock state on
 * every entry of `pickableEntries`, so it computes them locally with no round trip.
 *
 * **The CLI's `--only rare` / `--only locked` are unchanged**, since there is no list to look at
 * there and the entries can only be named in one go. Same capability, same semantics, different
 * interaction — this is not the two surfaces contradicting each other.
 */

/**
 * The selection list: the achievements in a guide **a partial rewrite can actually reach**, grouped
 * by section.
 *
 * The interface's 「自选…」 uses it, and it solves two things at once: selecting a whole section
 * (clicking the heading) and selecting individual entries (clicking an item). **So the interface
 * needs no `section:` selector** — the grouping is presentation only, and what goes out is always a
 * list of named api_names, a path `resolveScope` has supported all along.
 *
 * Only entries `scopeEntries` can locate are listed: an achievement the guide never wrote about is
 * out of a partial rewrite's reach, and listing it would offer a checkbox that does nothing.
 *
 * @param {{heading:string|null, apiNames:string[]}[]} groups  the result of groupBySection
 */
export function pickableEntries({ plan, groups }) {
  const { defs, oldTodos, rarity, unlocked } = plan;
  const locatable = new Set(
    scopeEntries({ todos: oldTodos, defs, apiNames: defs.map((d) => d.api_name) }).entries
      .map((e) => e.apiName)
  );
  const byApi = new Map(defs.map((d) => [d.api_name, d]));

  const item = (apiName) => {
    const d = byApi.get(apiName);
    const pct = rarity?.get(apiName);
    return {
      apiName,
      name: achName(d) || apiName,
      // Rarity and unlock state travel with it: while selecting, what one most wants to know is "is
      // this one hard" and "have I got it", and the server already holds both, so having the
      // frontend ask again would be a wasted round trip
      rarity: pct === undefined || pct === null ? null : Math.round(pct * 10) / 10,
      unlocked: unlocked.has(apiName),
    };
  };

  const grouped = groups
    .map((g) => ({ heading: g.heading, items: g.apiNames.filter((a) => locatable.has(a)).map(item) }))
    .filter((g) => g.items.length);

  // Achievements absent from the outline but genuinely holding a box in the guide (the heading
  // structure was not read, or attribution failed). **Catch them; they must not disappear from the
  // list** — going from "cannot be selected" to "cannot be seen" is the worse failure
  const seen = new Set(grouped.flatMap((g) => g.items.map((i) => i.apiName)));
  const rest = [...locatable].filter((a) => !seen.has(a));
  if (rest.length) grouped.push({ heading: null, items: rest.map(item) });

  return grouped;
}

export async function patchGuide(db, {
  config,
  provider,
  steam,
  appid,
  notion = null,
  selector,
  instruction = null,
  rounds = PATCH_ROUNDS,
  patchPlan = null,
  onProgress = () => {},
  // See the identical parameter on generateGuide in guidegen.js. A patch has only one request in
  // flight at a time (no shards, no concurrency), so cancelling it needs nothing beyond threading
  // this through to `session.ask` — a cancelled request rejects with `AiError.cancelled`, which
  // has no `.code`, so `askWithRetry` below already treats it as unretryable and rethrows as-is.
  signal = null,
}) {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw msgError('gen.badRounds', { rounds });
  }

  // planPatch's result may be passed in: the CLI computes the preflight from it and asks the user
  // before starting. Planning again would cost extra API calls and open a gap where the plan asked
  // about is not the plan changed
  const pp = patchPlan ?? (await planPatch(db, { config, steam, appid, notion, selector }));
  const { plan, kind, oldText, baseline, scope, entries, unlocatable } = pp;
  const { defs, game, unlocked, oldTodos } = plan;

  onProgress({ phase: 'plan', scope: entries.length, of: defs.length, unlocatable: unlocatable.length });

  const canSearch = provider.canSearch !== false;
  const system = systemPromptFor(plan, appid, { canSearch });
  const session = createSession(provider, { system, tools: provider.webTools() });
  // The spoiler pass runs on a session of its own, and its tokens are part of what this run cost
  const asideSessions = [];
  const searchQueries = [];

  // `prompt`, not `msg` — see the same rename in guidegen.js: msg() is the user-facing message
  // table here now, and the two must not share a name
  const ask = async (prompt, round) => {
    const reply = await session.ask(prompt, {
      signal,
      onEvent: (ev) => {
        if (ev.type === 'tool') onProgress({ phase: 'tool', round, name: ev.name });
        else if (ev.type === 'search') onProgress({ phase: 'tool', round, name: msg('gp.searchQuery', { query: ev.query }) });
      },
    });
    for (const q of reply.searchQueries ?? []) if (!searchQueries.includes(q)) searchQueries.push(q);
    const verdict = checkResult(reply);
    if (!verdict.ok) {
      const err = msgError('gen.roundFailed', { round, reason: verdict.reason });
      err.code = verdict.code;
      throw err;
    }
    for (const w of verdict.warnings ?? []) onProgress({ phase: 'warn', round, note: w });
    return collapseEmptyBreaks(extractMarkdown(reply.text));
  };

  /**
   * Ask one round, **re-asking once as-is on an empty reply**.
   *
   * The retry test is imported from `guidegen.js` (`RETRYABLE`) rather than written again here —
   * two copies would certainly drift, and the direction of drift is "one kind of failure is retried
   * on one path and not on the other", a difference nobody would ever see.
   *
   * **Splitting does not apply on this path**, even though `SPLITTABLE` covers these codes too: a
   * partial rewrite's entry set was named by the user, and unilaterally changing only half of it
   * quietly narrows their request. If too many entries hit a truncation, say so and let them name
   * them in two goes, rather than deciding which half to change on their behalf.
   */
  const askWithRetry = async (prompt, round) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ask(prompt, round);
      } catch (err) {
        if (!RETRYABLE.has(err?.code) || attempt >= 1) {
          if (SPLITTABLE.has(err?.code) && entries.length > 1) {
            err.message += msg('gp.splitAdvice', { n: entries.length });
          }
          throw err;
        }
        session.dropLastTurn();
        onProgress({ phase: 'retry', round, reason: err.code });
      }
    }
  };

  let round = 0;
  let found = new Map();
  let patched = oldTodos;
  let wantChecked = new Set();
  let lint = baseline;
  let caused = [];
  let preExisting = [];
  let missing = [];
  let unapplied = { extra: [], unresolved: [] };

  while (round < rounds) {
    round++;
    onProgress({ phase: round === 1 ? 'write' : 'rewrite', round, of: rounds, scope: entries.length });

    const prompt = round === 1
      ? buildPatchMessage(entries, { instruction, lang: plan.lang })
      : buildPatchFeedback(caused, entries, missing, plan.lang);
    const md = await askWithRetry(prompt, round);

    const parsed = parsePatchReply(md, defs, { kind });
    const wanted = new Set(entries.map((e) => e.apiName));
    // **Extra and unrecognised entries are never applied.** The guarantee originates here: the
    // program splices back only the entries it asked for. They are reported because they indicate
    // the model misunderstood the request, which is something the next round should know
    unapplied = {
      extra: [...parsed.found.keys()].filter((a) => !wanted.has(a)),
      unresolved: parsed.unresolved,
    };
    found = new Map([...parsed.found].filter(([a]) => wanted.has(a)));
    missing = entries.filter((e) => !found.has(e.apiName)).map((e) => e.apiName);

    onProgress({
      phase: 'check', round,
      wrote: found.size, of: entries.length,
      missing: missing.length, extra: unapplied.extra.length,
    });

    patched = applyPatchToTodos(oldTodos, entries, found, { kind });

    /**
     * **The checked state must be computed before validation; validation must not see a guide in
     * which every rewritten entry is unticked.**
     *
     * `applyPatchToTodos` marks each rewritten achievement `checked: false`, which is correct — what
     * the model returns is always `- [ ]`, and it is not permitted to write ticks. At landing time
     * both backends re-tick from `computeCheckedKeys`, so **what gets written is ticked correctly**.
     * But validation runs before landing and sees the unticked version, so every **unlocked**
     * achievement reports a `checked-mismatch` — and that code is outside `MODEL_FIXABLE`, so the
     * throw below fails the entire change.
     *
     * The consequence is that this path is unusable **for any unlocked achievement**, which is the
     * vast majority of entries in a mostly-completed guide. Measured: 罗曼圣诞探案集 (926340,
     * 46/50), rewriting 「初入酒馆」 alone, failed outright reporting exactly this.
     *
     * The computed set **must be handed to the landing** rather than recomputed there:
     * `computeCheckedKeys` skips entries whose `checked` is already true ("already ticked needs no
     * action"), so recomputing over this ticked version yields an empty set, and the Notion path
     * would then use `checked: false` to **untick** the boxes it just ticked — the same bug inverted.
     */
    wantChecked = new Set(computeCheckedKeys({ todos: patched, defs, unlockedApiNames: unlocked }));
    patched = patched.map((t) => (wantChecked.has(t.key) ? { ...t, checked: true } : t));

    lint = lintGuide({
      todos: patched,
      defs,
      // Only the local backend has whole-document text to validate (the title line and the
      // section-heading statistics rules need it). The assembled text is exactly what will be
      // written, so what is validated is the final product
      text: kind === 'local' ? spliceIntoText(oldText, entries, found) : null,
      unlockedApiNames: unlocked,
      kind,
    });

    const { blocking } = splitFindings(lint.findings, plan.unnameable);
    const split = classifyFindings({
      before: splitFindings(baseline.findings, plan.unnameable).blocking,
      after: blocking,
      apiNames: scope.apiNames,
    });
    caused = split.caused;
    preExisting = split.preExisting;

    onProgress({
      phase: 'lint', round,
      caused: caused.length, preExisting: preExisting.length,
    });

    // **A missing entry has to be judged separately.** It produces no lint error at all — that
    // achievement's old box is still sitting there untouched, the validator sees nothing wrong, and
    // `ok` would be true while that entry was never changed. This is the one combination on this path
    // where the gate is entirely green and the request was not satisfied; not judging it means
    // silently changing less than asked
    if (!caused.length && !missing.length) break;
    if (round >= rounds) break;

    // Anything the model cannot fix stops immediately. **The same rule as the whole-guide path**: a
    // checked-mismatch reaching here means our own ticking or splicing went wrong, and asking the
    // model to fix it only makes it start inventing `- [x]`. A missing entry is not in this
    // category — the model can fix that, and asking again is exactly right
    if (caused.length && !caused.some((f) => MODEL_FIXABLE.has(f.code))) {
      throw msgError('patch.nothingModelCanFix', { problems: caused.map((f) => f.message).join('\n  ') });
    }
  }

  const ok = caused.length === 0 && missing.length === 0;

  /**
   * ---- Fold the spoilers away, in the rewritten entries only ---------------
   *
   * **Run after the rounds converge, not inside the loop**, so it costs one request rather than one
   * per round — and re-validated afterwards, because everything above rests on "what was validated
   * is what gets landed" and folding changes the text.
   *
   * **Scoped to `found`, which is exactly the set the user named.** Folding across the whole guide
   * here would touch entries `--only` promised not to, and that promise is the feature.
   *
   * Any failure degrades to "nothing folded", the same trade the whole-guide path makes: the rewrite
   * itself is finished and correct by this point, and losing it over a cosmetic pass is a bad deal.
   * A cancellation is still a cancellation.
   */
  if (ok && found.size) {
    const beforeFound = new Map(found);
    try {
      const keys = [...found.keys()];
      const blocks = keys.map((k) => found.get(k));
      onProgress({ phase: 'spoiler', entries: blocks.length });
      const finder = createSession(provider, { system: spoilerSystemFor(plan.lang) });
      asideSessions.push(finder);
      const entryTexts = blocks.flatMap((b) => guideEntries(b.join('\n')).map((e) => e.text));
      const reply = await finder.ask(buildSpoilerMessage(entryTexts, plan.lang), { signal });
      const verdict = checkResult(reply);
      if (!verdict.ok) throw new Error(verdict.reason);

      const folded = foldSpoilersInBlocks(blocks, reply.text, defs, plan.lang);
      if (folded.applied.length) {
        keys.forEach((k, i) => found.set(k, folded.blocks[i]));
        const repatched = applyPatchToTodos(oldTodos, entries, found, { kind });
        const reticked = repatched.map((t) => (wantChecked.has(t.key) ? { ...t, checked: true } : t));
        const after = lintGuide({
          todos: reticked,
          defs,
          text: kind === 'local' ? spliceIntoText(oldText, entries, found) : null,
          unlockedApiNames: unlocked,
          kind,
        });
        const recheck = classifyFindings({
          before: splitFindings(baseline.findings, plan.unnameable).blocking,
          after: splitFindings(after.findings, plan.unnameable).blocking,
          apiNames: scope.apiNames,
        });
        if (recheck.caused.length) throw msgError('patch.recheckFailed', { n: recheck.caused.length });
        lint = after;
        patched = reticked;
        onProgress({ phase: 'spoiler-done', folded: folded.applied.length, skipped: folded.skipped.length });
      }
    } catch (err) {
      found = beforeFound;
      if (err?.cancelled) throw err;
      onProgress({ phase: 'spoiler-failed', reason: String(err?.message ?? err) });
    }
  }

  // ---- Landing. **Back up first; a failed backup writes nothing** ----
  let backup = null;
  let landed = null;
  if (ok) {
    onProgress({ phase: 'backup' });
    backup = await backupGuide(config, { guide: plan.existing, appid, notion });
    onProgress({ phase: 'backup-done', path: backup.path, bytes: backup.bytes });

    landed = kind === 'local'
      ? landPatchLocal(db, { config, plan, defs, unlocked, oldText, entries, found })
      : await landPatchNotion({ notion, plan, defs, unlocked, entries, found, wantChecked, onProgress });
    onProgress({ phase: 'landed', target: kind, url: plan.existing.url });
  }

  return {
    ok,
    game,
    appid: String(appid),
    target: kind,
    url: plan.existing.url,
    selector,
    instruction,
    // How many were named, how many were changed, and how many were named but not found in the
    // guide. **All three are reported** — "changed 4" and "named 5 and changed 4" are entirely
    // different statements
    scope: scope.apiNames,
    rewrote: [...found.keys()],
    unlocatable,
    missing,
    unapplied,
    researched: canSearch,
    searchQueries,
    rounds: round,
    lint,
    // Broken by this change / already broken. **The latter must be reported**: not blocking is not
    // the same as not mentioning, a rule this project paid for with ambiguous-empty-description
    blocking: caused,
    preExisting,
    expected: splitFindings(lint.findings, plan.unnameable).expected,
    usage: [session, ...asideSessions].reduce((tot, x) => addUsage(tot, x.usage), emptyUsage()),
    model: provider.model,
    backup: backup ? { path: backup.path, bytes: backup.bytes, count: backup.count } : null,
    landed,
  };
}

/** Splice the rewritten entries into the whole source text. Pure string manipulation, with every position coming from `todoSpans` */
export function spliceIntoText(oldText, entries, found) {
  const spans = todoSpans(oldText);
  const lines = oldText.split(/\r?\n/);
  const edits = [];
  for (const e of entries) {
    const block = found.get(e.apiName);
    if (!block) continue;
    const span = spans.get(e.key);
    // Skip anything that cannot be located rather than guessing. A key read from the old guide is a
    // line number and must in theory always be in spans — this guard stays because "in theory" has
    // already been wrong several times in this project
    if (!span) continue;
    const delta = indentOf(lines[span.start]) - indentOf(block[0]);
    edits.push({ start: span.start, end: span.end, lines: reindent(block, delta) });
  }
  return spliceLines(oldText, edits);
}

/**
 * Landing locally: splice → write a draft → tick mechanically → **read back and validate again** →
 * overwrite the original file → re-register.
 *
 * The draft goes to `guides/.drafts/` first and is then copied over, rather than being written
 * straight to the target file. The extra read and write buys one specific thing: `applyChecks` and
 * the final validation both operate on **the copy that is about to land**, while a failure at any
 * intermediate step leaves the user's guide byte-for-byte as it was.
 */
function landPatchLocal(db, { config, plan, defs, unlocked, oldText, entries, found }) {
  const finalPath = resolveGuidePath(config.guidesDir, plan.existing.url);
  const draftPath = plan.draftPath;
  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });

  writeFileSync(draftPath, spliceIntoText(oldText, entries, found));
  const keys = computeCheckedKeys({ todos: loadTodos(draftPath), defs, unlockedApiNames: unlocked });
  applyChecks(draftPath, keys);

  const text = readFileSync(draftPath, 'utf8');
  writeFileSync(finalPath, text);
  rmSync(draftPath, { force: true });

  /**
   * **Read it back after landing and validate again** — the same rule as `generateGuide`'s local
   * landing path.
   *
   * "The call succeeded ≠ the content is correct" is a hole this project has fallen into, and a
   * partial rewrite has its own version: the validation above checked **the todo list assembled in
   * memory**, while this one checks **the actual file on disk**. Between them lie a splice, a
   * tick-and-write-back, and a copy, and a line mangled by any of those is invisible to the earlier
   * validation. One extra read buys one real confirmation.
   *
   * It is strict only about **the entries changed this run**: old problems elsewhere in the guide
   * were not touched, and throwing on them would report "written correctly" as "written wrongly".
   * The test is identical to the Notion read-back path
   */
  const after = lintGuide({
    todos: loadTodos(finalPath),
    defs,
    text: readFileSync(finalPath, 'utf8'),
    unlockedApiNames: unlocked,
    kind: 'local',
  });
  const mine = new Set(entries.map((e) => e.apiName));
  const bad = splitFindings(after.findings, plan.unnameable).blocking.filter(
    (f) => f.apiName && mine.has(f.apiName)
  );
  if (bad.length) {
    throw msgError('gen.finalRecheckFailed', {
      path: finalPath,
      problems: bad.map((f) => f.message).join('; '),
    });
  }

  // Registration goes through the real discovery logic rather than upserting directly — the same
  // rule as generateGuide, so two places do not gradually diverge on "how the title is taken". A
  // partial rewrite usually does not change the title, but after `--only section:` nobody can
  // guarantee that
  syncGuidesFromMarkdown(db, config);
  return { kind: 'local', path: finalPath, ticked: keys.length, lint: after };
}

/**
 * Landing on Notion: **block by block**, never deleting the page.
 *
 * One achievement = one to_do block plus its children. So changing one means PATCHing that block's
 * prose and replacing its children wholesale. The block ids survive, and everything else on the page
 * (images, embeds, hand-made tables, everything the converter cannot represent) is untouched — which
 * is the very reason this feature exists.
 *
 * After writing, **the whole page is read back and revalidated**, the same rule as
 * `finishNotionLanding`: this project has fallen into "the call succeeded ≠ the content is correct",
 * and the markdown→block conversion, the nesting and the rendering can each produce something else
 * without raising an error.
 */
export async function landPatchNotion(
  { notion, plan, defs, unlocked, entries, found, wantChecked, onProgress = () => {} }
) {
  const pageId = extractNotionPageId(plan.existing.url);

  // The checked state is computed over **the whole guide after the change**, by the same function
  // the local path uses — but that step happened **before validation** (see the long comment above),
  // and this only consumes the result. **Do not recompute here**: the `patched` passed in is already
  // ticked, and `computeCheckedKeys` skips ticked entries, so recomputing yields an empty set and
  // then unticks the boxes just ticked.
  // Entries with synthesised keys (the new sub-steps) have no block id, and their checked state is
  // written into the payload at append time

  let changed = 0;
  for (const e of entries) {
    const block = found.get(e.apiName);
    if (!block) continue;

    const { blocks } = markdownToBlocks(block.join('\n'), { lang: plan.lang });
    const top = blocks.find((b) => b.type === 'to_do');
    if (!top) {
      // What was returned does not convert into a to_do — the gate should have caught this (that
      // achievement would report missing-checkbox), so reaching here is our own bug, and stopping
      // beats corrupting a page
      throw msgError('patch.noCheckboxBlock', { game: plan.game, apiName: e.apiName });
    }

    onProgress({ phase: 'notion-patch', name: achName(e.def) || e.apiName });
    // **Pass the rich_text straight through rather than flattening it to a string and converting
    // again.** That round trip loses both `**bold**` and `<br>`, and the read-back validation cannot
    // detect it — see the comment in notion.js
    await notion.setTodoRichText(e.key, top.to_do.rich_text, { checked: wantChecked.has(e.key) });
    await notion.replaceTodoChildren(e.key, top.to_do.children ?? []);
    changed++;
  }

  onProgress({ phase: 'notion-verify', url: plan.existing.url });
  const todos = await notion.fetchAllToDoBlocks(pageId);
  const after = lintGuide({ todos, defs, unlockedApiNames: unlocked, kind: 'notion' });
  const recheck = splitFindings(after.findings, plan.unnameable);
  const still = classifyFindings({
    before: [],
    after: recheck.blocking,
    apiNames: entries.map((e) => e.apiName),
  });
  // The read-back is strict only about **the entries changed this run**: old problems elsewhere on
  // the page were not touched, and reporting them would present "written correctly" as "written
  // wrongly"
  const mine = new Set(entries.map((e) => e.apiName));
  const bad = still.caused.filter((f) => f.apiName && mine.has(f.apiName));
  if (bad.length) {
    throw msgError('patch.notionRecheckFailed', {
      url: plan.existing.url,
      problems: bad.map((f) => f.message).join('; '),
    });
  }

  return { kind: 'notion', url: plan.existing.url, changed, lint: after };
}
