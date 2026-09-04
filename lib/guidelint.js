/**
 * The guide validator
 * ------------------------------------------------
 * It answers one question: **can the sync scripts handle this guide correctly?**
 *
 * It makes no judgement about whether the guide is well written — whether the steps work, whether
 * the difficulty ratings are right, whether the "easy to miss" flags are true. A machine cannot
 * verify any of that; it is a person's job. This validates format and data consistency only, which
 * is what checkbox-sync and audit depend on. That boundary has to be stated plainly: passing
 * validation ≠ the guide is correct, it only means ≠ the guide will break the sync.
 *
 * **Deliberately backend-agnostic**: the input is an array of {key, text, checked, parent} todos,
 * and both Notion (fetchAllToDoBlocks) and local markdown (loadTodos) already produce that shape.
 * So one rule set applies word for word to both backends, and it is testable offline — a unit test
 * needs no Notion token.
 *
 * Every predicate used here is taken from lib/guides.js rather than reimplemented: when the
 * validator says "audit can reverse-resolve this box", it says so by calling the function audit
 * itself uses, not a lookalike copy.
 */
import { achievementsFor, allGuides } from './db.js';
import {
  normalizeText, extractTitleCandidates, resolveTodoToAchievement, backendFor, flatCompare,
  isQuotableText,
} from './guides.js';
import { headingOf, normSectionTitle } from './markdown.js';
import { schemaMissingReason } from './schemareason.js';
import { msg, achName } from './messages.js';

/** Strip all whitespace before comparing — kept exactly consistent with resolveTodoToAchievement's description comparison */
// **The same predicate audit uses.** This lint's wording is "audit cannot reverse-resolve this
// box", so it must decide that by calling the function audit actually uses — a second copy would
// eventually have only one of the two updated
const flat = flatCompare;

/**
 * A second [ ] / [x] on one line is a merged line.
 *
 * Why that is wrong is in SKILL.md rule-1: in Notion only the first bracket at the start of a line
 * renders as a real checkbox, and later ones are escaped to the literal `\[x\]`, so the sync scripts
 * cannot find those achievements at all.
 * todo.text is the portion **after** the line's leading checkbox, so anything counted here is surplus.
 */
const MERGED_RE = /\[\s*[xX ]\s*\]/;

/** Counts in a section heading, forbidden by SKILL.md rule 4.2 (they expire as progress changes, and nobody updates them) */
const HEADING_STATS_RE = /共\s*\d+\s*[个項项]|\d+\s*[项個个]\s*(未完成|已完成)/;

/** SKILL.md rule-7: a guide's prose does not state where its data came from */
const DATA_SOURCE_RE = /勾选状态来自|数据来自\s*Steam|来自\s*Steam\s*真实|根据\s*Steam\s*(真实)?解锁/;

/**
 * Build an index of achievement name → which achievements carry that name.
 *
 * It uses extractTitleCandidates plus exact equality, the same rules as matchAchievements' second
 * pass — when the validator decides "does this achievement have a checkbox", the standard must be
 * identical to the one used when actually ticking, or the worst case arises: validation says yes
 * while the sync cannot tick it.
 */
function buildNameIndex(defs) {
  const byName = new Map();
  for (const d of defs) {
    for (const raw of [d.name_cn, d.name_en]) {
      const k = normalizeText(raw);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(d.api_name);
    }
  }
  return byName;
}

/**
 * Validate one guide.
 *
 * @param {object}   o
 * @param {Array}    o.todos    {key, text, checked, parent} — both backends produce this shape
 * @param {Array}    o.defs     this game's achievement definitions from the achievements table
 * @param {string}   [o.text]   the guide's full text. Only local markdown can supply it; the Notion
 *                              side cannot produce a whole page's source, so rules that depend on
 *                              the full text are skipped rather than reported falsely
 * @param {Set|null} [o.unlockedApiNames]  the real unlock state. Checked state is validated only when supplied
 * @param {string}   [o.kind]   'local' | 'notion' — affects only the "must there be a # title" rule
 */
/**
 * Which **line numbers** in a local markdown file fall inside `<details>…</details>`.
 *
 * On the Notion side this question is answered by `fetchAllToDoBlocks`'s `container` flag; a local
 * guide is only text, so it is computed here line by line. The two backends must give the same
 * answer — the same guide reaching a different conclusion on a different backend is a bug, not a
 * design.
 */
function detailLineSet(text) {
  const set = new Set();
  if (!text) return set;
  const lines = String(text).split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const opens = /^<details\b/i.test(t);
    const closes = /^<\/details\s*>/i.test(t);
    if (opens) { depth++; continue; }
    if (closes) { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) set.add(i);
  }
  return set;
}

export function lintGuide({ todos, defs, text = null, unlockedApiNames = null, kind = 'notion' }) {
  const findings = [];
  const add = (level, code, message, extra = {}) => findings.push({ level, code, message, ...extra });

  const byName = buildNameIndex(defs);

  // ---- Does every achievement have its own checkbox line ----
  // Done in reverse: first collect every achievement each todo can match, then see who was never
  // collected. **resolveTodoToAchievement must not be used for this step** — it returns null for
  // every same-named achievement, whose boxes do in fact exist and merely cannot be recognised by
  // name. Using it would report "missing checkbox" in bulk across the 12 games with name
  // collisions. Same-named achievements are a different rule's concern; see below.
  const covered = new Set();
  const todoByApiName = new Map();
  for (const t of todos) {
    for (const cand of extractTitleCandidates(normalizeText(t.text))) {
      const hit = byName.get(cand);
      if (!hit) continue;
      for (const apiName of hit) {
        covered.add(apiName);
        if (!todoByApiName.has(apiName)) todoByApiName.set(apiName, []);
        todoByApiName.get(apiName).push(t);
      }
    }
  }

  /**
   * **The other half, in reverse: a top-level checkbox that resolves to no achievement.**
   *
   * The rule above checks that every achievement has a box; it cannot check that every top-level
   * box is an achievement. The two are not the same: when sub-steps are written at top level (not
   * indented as they should be), no achievement is missing and coverage is 100%, while those boxes
   * **can never be ticked** — `checkbox-sync` matches achievement names exactly, and an unmatched
   * box is never ticked and simply hangs there.
   *
   * **This escaped once, measured**: 破晓传奇 generated with a report of "58/58 covered, 0 warnings"
   * while the page held 70 top-level checkboxes — the extra 12 being sub-steps under 「12 个个人
   * 支线一览」 that should have been nested.
   *
   * Reported as `warn` rather than `error`: this is a writing violation by the model, not a data
   * error, and an error drives rewrite rounds — three of which would be burned for nothing if the
   * model cannot fix it. Being visible is enough.
   */
  const inDetails = detailLineSet(text);
  for (const t of todos) {
    if (t.parent !== null && t.parent !== undefined) continue;
    // Boxes inside a collapse do not count as orphans: rule 五 explicitly allows a long list to be
    // wrapped in `<details>` with a run of checkboxes, and those entries are not achievements. The
    // Notion side uses the `container` flag; local markdown uses line numbers
    if (t.container || inDetails.has(t.key)) continue;
    const hits = extractTitleCandidates(normalizeText(t.text)).some((c) => byName.has(c));
    if (hits) continue;
    add('warn', 'orphan-todo', msg('lint.orphanTodo', { text: t.text.split('\n')[0].slice(0, 40) }), {
      key: t.key,
    });
  }

  for (const d of defs) {
    if (covered.has(d.api_name)) continue;
    add('error', 'missing-checkbox', msg('lint.missingCheckbox', { name: achName(d) }), {
      apiName: d.api_name,
      name: achName(d),
    });
  }

  // ---- Merged lines ----
  for (const t of todos) {
    if (MERGED_RE.test(t.text)) {
      add('error', 'merged-line', msg('lint.mergedLine', { text: t.text.slice(0, 60) }), {
        key: t.key,
      });
    }
  }

  // ---- Same-named achievements must quote the description, or they can never be synced ----
  // findAmbiguousNames decides "can this run tick safely" and needs the real unlock state; this
  // decides whether the guide itself is written correctly, which is unrelated to unlock state, so
  // it reads the index directly: one name mapping to several achievements is a collision.
  for (const [name, apiNames] of byName) {
    if (apiNames.size < 2) continue;
    for (const apiName of apiNames) {
      const d = defs.find((x) => x.api_name === apiName);
      if (!d) continue;
      const hits = todoByApiName.get(apiName) ?? [];
      // One box quoting this achievement's description verbatim is enough to distinguish it.
      // **Either language counts**, the same rule as resolveTodoToAchievement and the
      // paraphrased-description check below: an English guide quotes the English description, and
      // demanding the Chinese one would report an entry that in fact syncs perfectly well
      const quotes = (raw) => isQuotableText(raw) && hits.some((t) => flat(t.text).includes(flat(raw)));
      if (quotes(d.description) || quotes(d.description_en)) continue;
      // **Two cases get two codes, not one code plus a boolean field.**
      //
      // Their remedies are fundamentally different: where a description exists, rewriting the guide
      // to quote it fixes it; where the description is empty, nobody can fix it — Steam has no
      // string to quote. And in this project "is this failure recoverable" is dispatched on `code`
      // everywhere (`MODEL_FIXABLE`, `splitFindings`, `CLI_HINTS` all are), so pushing the
      // distinction into a `fixable` boolean only this rule sets means a second mechanism for the
      // same question — and what actually happened is that the field **was computed and no
      // production code ever read it** (only a test asserting it had been set), so a guide with all
      // 197 entries written correctly was held back by 15 errors nobody could fix, after first
      // spending three rounds asking the model to quote a description that does not exist. Hit for
      // real on KINGDOM HEARTS -HD 1.5+2.5 ReMIX- (a four-game compilation, 16 colliding names).
      //
      // The name uses `d.name_cn || d.name_en` rather than `name`: `name` is the index key after
      // `normalizeText` (lowercased, punctuation removed), which reads as `proud player`, while
      // what the user sees on Steam is `Proud Player`. Anything reported to a person uses the
      // spelling that person can see
      const shown = achName(d) || name;
      // Which of the two codes applies turns on whether **any** description exists to quote — a
      // Steam entry with only an English one is still fixable by quoting that, and one holding
      // nothing but a space holds nothing to quote however truthy the string is
      if (isQuotableText(d.description) || isQuotableText(d.description_en)) {
        add('error', 'ambiguous-no-description',
          msg('lint.ambiguousNoDesc', { name: shown }),
          { apiName, name: shown });
      } else {
        add('error', 'ambiguous-empty-description',
          msg('lint.ambiguousEmptyDesc', { name: shown }),
          { apiName, name: shown });
      }
    }
  }

  // ---- Is the description quoted verbatim ----
  // This uses exactly the same predicate as resolveTodoToAchievement, so passing this rule means
  // audit can reverse-resolve it. Reported as warn only: a paraphrased description still ticks by
  // name and merely cannot be audited, which is what SKILL.md says as well.
  for (const d of defs) {
    if (!isQuotableText(d.description) && !isQuotableText(d.description_en)) continue;
    const hits = todoByApiName.get(d.api_name) ?? [];
    if (!hits.length) continue; // A missing checkbox was already reported above; do not report it twice
    // **Either language counts.** The rule catches paraphrasing, and a guide that quoted the other
    // language's description verbatim has not paraphrased anything. Demanding one language would
    // fire on every entry of every guide written in the other — a rule that reports everything is
    // one nobody reads
    const quoted = (raw) => isQuotableText(raw) && hits.some((t) => flat(t.text).includes(flat(raw)));
    if (quoted(d.description) || quoted(d.description_en)) continue;
    add('warn', 'paraphrased-description', msg('lint.paraphrased', { name: achName(d) }), {
      apiName: d.api_name,
      name: achName(d),
    });
  }

  // ---- Does the checked state agree with the real unlock state ----
  // After mechanical ticking this can in theory never fail; it remains to cover hand-written guides
  // and legacy data.
  if (unlockedApiNames) {
    for (const d of defs) {
      const hits = todoByApiName.get(d.api_name) ?? [];
      if (!hits.length) continue;
      const shouldBeChecked = unlockedApiNames.has(d.api_name);
      // One name belonging to same-named achievements matches several boxes, and any one of them
      // agreeing counts as agreement — that being the ambiguity itself, already reported separately
      // above rather than stacked again here
      if (hits.some((t) => t.checked === shouldBeChecked)) continue;
      add(
        'error',
        'checked-mismatch',
        shouldBeChecked
          ? msg('lint.unlockedNotTicked', { name: achName(d) })
          : msg('lint.tickedNotUnlocked', { name: achName(d) }),
        { apiName: d.api_name, name: achName(d) }
      );
    }
  }

  // ---- The rules below need the guide's full text, which only local markdown can supply ----
  if (text !== null) {
    // SKILL.md rule 4.1: a local md must carry `# 游戏名`. Without that line
    // syncGuidesFromMarkdown takes the first ^# within the first 15 lines as the guide's name, so
    // the name in the guides table becomes the first section heading (hit for real)
    if (kind === 'local' && !/^#\s+\S/m.test(text.split('\n').slice(0, 15).join('\n'))) {
      add('error', 'missing-title', msg('lint.missingTitle'));
    }
    /**
     * **One title, one section.** A title used twice is an index that does not work: a reader
     * looking up 「购买内容」 finds it in three places holding one, two and one entries. Nothing is
     * missing and nothing fails, which is why it can sit in a landed guide unnoticed — 月圆之夜 did.
     *
     * The level is part of the identity and the parent is not: `## 收集` and `### 收集` are two
     * different things, while two `### 角色通关` under different parents are a real repeat of the
     * subtitle worth reading about, even where `mergeDuplicateSections` is right to leave them
     * alone. **A warn**, because the mechanical merge fixes this at generation time and a rule that
     * blocked a guide over its headings would be refusing a finished product over a tidy-up.
     * Reported once per title rather than once per repeat.
     */
    const titleCount = new Map();
    for (const line of text.split('\n')) {
      if (/^#{1,6}\s/.test(line) && HEADING_STATS_RE.test(line)) {
        add('warn', 'stats-in-heading', msg('lint.statsInHeading', { text: line.trim().slice(0, 50) }));
      }
      const h = headingOf(line);
      if (!h) continue;
      const key = `${h[1].length} ${normSectionTitle(h[2])}`;
      const seen = (titleCount.get(key) ?? 0) + 1;
      titleCount.set(key, seen);
      if (seen === 2) {
        add('warn', 'duplicate-heading', msg('lint.duplicateHeading', { text: h[2].slice(0, 50) }));
      }
    }
    if (DATA_SOURCE_RE.test(text)) {
      add('warn', 'data-source-note', msg('lint.dataSourceNote'));
    }
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  return {
    findings,
    ok: errors === 0,
    stats: {
      achievements: defs.length,
      todos: todos.length,
      covered: covered.size,
      errors,
      warnings: findings.length - errors,
    },
  };
}

/**
 * Mechanical ticking: compute which todo keys should be in the ticked state.
 *
 * By design the model only ever writes `- [ ]`, and the checked state is filled in here from the
 * database. That turns "the checked state must equal the real unlock state" from a rule to be
 * checked into a fact that cannot structurally be violated — which is why the manual verification
 * in SKILL.md rule-10, item 16, is no longer necessary.
 *
 * It answers only "which should be ticked" and touches no file: local markdown is written by
 * applyChecks in markdown.js, and the Notion side uses a different write API.
 */
export function computeCheckedKeys({ todos, defs, unlockedApiNames }) {
  const byName = buildNameIndex(defs);
  const keys = [];
  for (const t of todos) {
    if (t.checked) continue; // Already ticked needs no action — the sync only ticks, never unticks, consistent with checkbox-sync
    const matched = extractTitleCandidates(normalizeText(t.text)).some((cand) => {
      const hit = byName.get(cand);
      // A colliding name cannot be used for ticking: which achievement it refers to is
      // indeterminate, and the other one may not be unlocked. This is the same caution as
      // findAmbiguousNames — prefer a missed tick to a wrong one
      if (!hit || hit.size !== 1) return false;
      return unlockedApiNames.has([...hit][0]);
    });
    if (matched) keys.push(t.key);
  }
  return keys;
}

/**
 * Achievements mechanical ticking can **never reach**: neither name (Chinese or English) is unique
 * within this game.
 *
 * `computeCheckedKeys` skips any candidate whose name collides (`hit.size !== 1`), because which
 * one it refers to is indeterminate and it might tick the other one, which is not unlocked —
 * prefer a missed tick to a wrong one. So those achievements **stay unticked even when unlocked**,
 * while `checked-mismatch` keeps reporting. Guide generation has to know which these are, or three
 * rewrite rounds fail the gate while reporting an error the model cannot possibly fix (it is not
 * permitted to write checkboxes at all).
 *
 * **Computed per name, not per achievement** — a colliding Chinese name with a unique English one
 * still ticks, the same rule as "the gate closes per name" on the matching side. The great majority
 * of collisions occur in one language only.
 */
export function unnameableApiNames(defs) {
  const byName = buildNameIndex(defs);
  const out = new Set();
  for (const d of defs) {
    const hasUniqueName = [d.name_cn, d.name_en].some((raw) => {
      const k = normalizeText(raw);
      return k && byName.get(k)?.size === 1;
    });
    if (!hasUniqueName) out.add(d.api_name);
  }
  return out;
}

/**
 * Run the validator over real guides. Everything above is pure (tests need no network) and all the
 * network I/O is here, the same division as `matchAchievements` (pure) and `checkboxSync`
 * (networked) in guides.js.
 *
 * Read-only: it writes no database, touches no Notion page and modifies no local md.
 *
 * Checked state (`checked-mismatch`) is validated only when `steam` is passed, which it is not by
 * default. The reason is that doing so costs one Steam request per game (which is why `audit` is
 * slow), and "unlocked but unticked" is `checkbox-sync`'s job rather than a defect in the guide —
 * reporting it by default would bury the genuine content problems.
 *
 * @returns {{results: Array, totals: object}}
 */
export async function lintAllGuides(db, { notion, config, steam = null, appid = null, onProgress = () => {} }) {
  const targets = allGuides(db).filter((g) => !appid || g.appid === String(appid));
  const results = [];
  const totals = {
    guides: 0, clean: 0, noErrors: 0, skipped: 0,
    errors: 0, warnings: 0, achievements: 0, covered: 0,
    byCode: {},
  };

  for (const [i, g] of targets.entries()) {
    onProgress({ done: i + 1, total: targets.length, name: g.name });
    const entry = { appid: g.appid, name: g.name, kind: g.kind, skipped: null, lint: null };

    const defs = achievementsFor(db, g.appid);
    if (defs.length === 0) {
      // syncAchievementSchema deliberately skips achievement detail for completed games, so there
      // is no baseline to compare against. This must be reported honestly as "skipped" rather than
      // quietly omitted — otherwise "everything is clean" looks like broader coverage than it is
      entry.skipped = schemaMissingReason(db, g.appid);
      results.push(entry);
      totals.skipped++;
      continue;
    }

    const backend = backendFor(g, { notion, config });
    let todos, text = null;
    try {
      todos = await backend.loadTodos();
      text = await backend.loadText();
    } catch (err) {
      entry.skipped = msg('guide.unreadable', { reason: err.message });
      results.push(entry);
      totals.skipped++;
      continue;
    }

    let unlockedApiNames = null;
    if (steam) {
      const raw = await steam.fetchPlayerAchievements(g.appid);
      if (!raw.retry && !raw.noAchievementSystem) {
        unlockedApiNames = new Set((raw.achievements ?? []).filter((a) => a.achieved).map((a) => a.apiname));
      }
    }

    // todos is passed straight through: what both backends produce is exactly the
    // {key, text, checked, parent} lintGuide expects. No "defensive" reshaping happens here — that
    // would conceal one side genuinely changing shape some day
    entry.lint = lintGuide({
      todos,
      defs,
      text,
      unlockedApiNames,
      kind: g.kind === 'local' ? 'local' : 'notion',
    });

    totals.guides++;
    totals.errors += entry.lint.stats.errors;
    totals.warnings += entry.lint.stats.warnings;
    totals.achievements += entry.lint.stats.achievements;
    totals.covered += entry.lint.stats.covered;
    if (entry.lint.findings.length === 0) totals.clean++;
    if (entry.lint.stats.errors === 0) totals.noErrors++;
    for (const f of entry.lint.findings) totals.byCode[f.code] = (totals.byCode[f.code] ?? 0) + 1;

    results.push(entry);
  }

  return { results, totals };
}
