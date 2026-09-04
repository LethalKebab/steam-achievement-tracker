/**
 * Partial rewrite (`guide-gen --only`)
 * ------------------------------------------------
 * Run with: node --test
 *
 * The failure class this file guards is **changing text where the user did not point**.
 *
 * That is the failure unique to a partial rewrite, and the worst one: a bad full rewrite is at
 * least visible (the content is entirely replaced, and it has to be read through anyway), while
 * a partial rewrite that changes one entry too many, one too few, or pastes A's solution onto B
 * leaves **a guide that looks complete**, with no machine reporting anything — and the passage
 * displaced may be exactly the one the user edited by hand.
 *
 * So nearly every assertion here is about what did **not** change:
 *
 *  - **Every byte outside what was named is unchanged, verbatim.** Not "roughly", not "the same
 *    line count", but equal line by line
 *  - **The range does not eat one line too many**: a `<details>`, a table or a section intro
 *    immediately after an achievement does not belong to it
 *  - **Nothing extra the model writes is applied.** The guarantee comes from the program
 *    splicing only the entries it asked for, not from telling the model not to wander
 *  - **Anything the model fails to write has to make the whole thing not pass.** This is the one
 *    combination where every gate is green and the request was not satisfied: the missed
 *    achievement's old box is still sitting there and the validator sees nothing wrong
 *  - **Problems the old guide already had are not charged to this change**, but **have to be
 *    reported** — not blocking is not the same as not mentioning
 *  - **Identically named achievements cannot be selected by name.** Guessing one means writing
 *    A's solution onto B
 *
 * No network, no database: everything is a pure function. That is deliberate — whether the
 * splice lands in the right place has to be verifiable entry by entry with no key, no network
 * and no Notion.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseTodos, todoSpans, spliceLines } from '../lib/markdown.js';
import { lintGuide, computeCheckedKeys } from '../lib/guidelint.js';
import {
  RARE_PCT, resolveScope, scopeEntries, classifyFindings,
} from '../lib/guidescope.js';
import {
  parsePatchReply, applyPatchToTodos, spliceIntoText, buildPatchFeedback, landPatchNotion, patchSteps,
} from '../lib/guidepatch.js';
import { patchPreflight, formatPatchPreflight } from '../lib/guidebackup.js';
import { NotionClient } from '../lib/notion.js';
import { buildPatchMessage, buildAchievementList } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const def = (apiName, nameCn, description = '', nameEn = '') => ({
  api_name: apiName,
  name_cn: nameCn,
  name_en: nameEn,
  description,
  game_name: '测试游戏',
  hidden: 0,
  icon: '',
});

const DEFS = [
  def('A', '第一步', '完成第一关。'),
  def('B', '第二步', '完成第二关。'),
  def('C', '第三步', '完成第三关。'),
  def('D', '收集狂', '集齐全部收集品。'),
];

/** Rarity: C is the 1.1% hard one, the rest are common */
const RARITY = new Map([['A', 64.5], ['B', 40.0], ['C', 1.1], ['D', 12.0]]);

/**
 * A corpus shaped like a real guide. Three details are deliberate:
 *
 *  - **B carries two sub-steps**, one of them ticked by hand — the one real loss a partial
 *    rewrite causes
 *  - **C is immediately followed by a `<details>` block**, to pin that the range does not eat it
 *  - **Two sections**, which the `section:` selector needs
 */
const GUIDE = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿,顺手的事。',
  '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
  '  - [x] 打完第一个 Boss',
  '  - [ ] 拿到钥匙',
  '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
  '<details><summary>全结局对照</summary>',
  '结局一 / 结局二 / 结局三',
  '</details>',
  '',
  '## 收集',
  '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
  '',
].join('\n');

const TODOS = parseTodos(GUIDE);

/** The scopeEntries entry for the given api_names */
const entriesFor = (apiNames, todos = TODOS) =>
  scopeEntries({ todos, defs: DEFS, apiNames }).entries;

/** The kind of reply the model returns (already through extractMarkdown, so it is plain markdown) */
const reply = (...blocks) => blocks.join('\n');

// ---------------------------------------------------------------------------

describe('locating the line range — rather one line too few than one too many', () => {
  test('an achievement range = itself plus the more deeply indented lines that follow', () => {
    const spans = todoSpans(GUIDE);
    const lines = GUIDE.split('\n');
    const bLine = lines.indexOf('- [ ] **第二步**<br>完成第二关。<br>接着打就行。');

    assert.deepEqual(spans.get(bLine), { start: bLine, end: bLine + 2, indent: 0 });
  });

  test('a <details> immediately after an achievement does not belong to it — the range stops at the achievement line', () => {
    const spans = todoSpans(GUIDE);
    const lines = GUIDE.split('\n');
    const cLine = lines.indexOf('- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。');

    // What follows C is <details>, not a checkbox ⇒ the range is that one line.
    // Eating one line too many silently deletes that collapsible, and it is the user's
    assert.equal(spans.get(cLine).end, cLine);
  });

  test('a deeper indent separated by a non-checkbox line is not one of its sub-steps', () => {
    // **This pins the "has to be contiguous" criterion, which the <details> case above cannot
    // pin** — there, what follows `<details>` is the next achievement at the **same level**, so
    // the indent criterion cuts the range first and the contiguity criterion is never reached.
    // Mutation testing found it: delete `line !== end + 1` and the whole file stays green.
    //
    // This shape is the one that really needs it: a checkbox at a deeper indent **inside** the
    // collapsible. Without the criterion the range runs all the way to
    // `- [ ] 折叠块里的东西`, so rewriting this achievement deletes the user's whole collapsible
    const md = [
      '- [ ] **第一步**<br>完成第一关。<br>正文。',
      '<details><summary>全收集品位置</summary>',
      '  - [ ] 折叠块里的东西,缩进更深',
      '</details>',
    ].join('\n');

    assert.equal(todoSpans(md).get(0).end, 0, 'the range is that one line — one more is silently deleting the user collapsible');
  });

  test('a sub-step has its own range, and does not swallow the next achievement', () => {
    const spans = todoSpans(GUIDE);
    const lines = GUIDE.split('\n');
    const sub = lines.indexOf('  - [x] 打完第一个 Boss');

    // The next line 拿到钥匙 is at the **same level** (same indent), so it is not its sub-step
    assert.equal(spans.get(sub).end, sub);
  });

  test('spliceLines replaces in reverse: an earlier replacement does not shift the later ranges', () => {
    const text = ['a', 'b', 'c', 'd'].join('\n');
    // Two replacements, the first turning 1 line into 3. Done forwards, the second index is off by 2
    const out = spliceLines(text, [
      { start: 0, end: 0, lines: ['a1', 'a2', 'a3'] },
      { start: 2, end: 2, lines: ['C'] },
    ]);
    assert.deepEqual(out.split('\n'), ['a1', 'a2', 'a3', 'b', 'C', 'd']);
  });

  test('a CRLF file is still CRLF after the replacement — otherwise git diff shows the whole file as changed', () => {
    const crlf = GUIDE.replace(/\n/g, '\r\n');
    const out = spliceLines(crlf, [{ start: 0, end: 0, lines: ['# 改了'] }]);
    assert.ok(out.includes('\r\n'), 'the line-ending style should follow the original');
    assert.ok(!/[^\r]\n/.test(out), 'no bare LF should be mixed in');
  });
});

describe('splicing — everything outside what was named is verbatim', () => {
  test('changing only B: every other line is equal character for character', () => {
    const entries = entriesFor(['B']);
    const found = new Map([['B', ['- [ ] **第二步**<br>完成第二关。<br>换了个说法,写详细多了。']]]);

    const out = spliceIntoText(GUIDE, entries, found);
    const before = GUIDE.split('\n');
    const after = out.split('\n');

    // The B line plus its two sub-steps (3 lines) became 1 line
    assert.equal(after.length, before.length - 2);

    // **Compare the unnamed part line by line.** This is the most important assertion in this file
    const untouched = (arr) => arr.filter((l) => !l.includes('第二步') && !l.includes('打完第一个 Boss') && !l.includes('拿到钥匙'));
    assert.deepEqual(untouched(after), untouched(before));
  });

  test('changing only C: the <details> after it is untouched', () => {
    const entries = entriesFor(['C']);
    const found = new Map([['C', ['- [ ] **第三步**<br>完成第三关。<br>重写过的打法。']]]);

    const out = spliceIntoText(GUIDE, entries, found).split('\n');
    assert.ok(out.includes('<details><summary>全结局对照</summary>'));
    assert.ok(out.includes('结局一 / 结局二 / 结局三'));
    assert.ok(out.includes('</details>'));
  });

  test('new sub-steps replace the old ones, and the counts may differ', () => {
    const entries = entriesFor(['B']);
    const found = new Map([['B', [
      '- [ ] **第二步**<br>完成第二关。<br>拆成三步。',
      '  - [ ] 一',
      '  - [ ] 二',
      '  - [ ] 三',
    ]]]);

    const out = spliceIntoText(GUIDE, entries, found);
    assert.ok(!out.includes('打完第一个 Boss'), 'the old sub-steps should be replaced');
    assert.ok(out.includes('  - [ ] 三'));
    // No other achievement has sub-steps, so the total is exactly those three new ones
    assert.equal(parseTodos(out).filter((t) => t.parent !== null).length, 3);
  });

  test('two non-adjacent achievements changed together do not interfere', () => {
    const entries = entriesFor(['A', 'D']);
    const found = new Map([
      ['A', ['- [ ] **第一步**<br>完成第一关。<br>A 的新写法。']],
      ['D', ['- [ ] **收集狂**<br>集齐全部收集品。<br>D 的新写法。']],
    ]);

    const out = spliceIntoText(GUIDE, entries, found);
    assert.ok(out.includes('A 的新写法'));
    assert.ok(out.includes('D 的新写法'));
    // The B / C / details / section heading in between are all still there
    assert.ok(out.includes('- [ ] **第二步**<br>完成第二关。<br>接着打就行。'));
    assert.ok(out.includes('  - [x] 打完第一个 Boss'));
    assert.ok(out.includes('## 收集'));
    assert.ok(out.includes('</details>'));
  });

  test('an achievement not returned stays where it was — it is not blanked', () => {
    const entries = entriesFor(['A', 'B']);
    // Only A came back
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>只改了 A。']]]);

    const out = spliceIntoText(GUIDE, entries, found);
    assert.ok(out.includes('只改了 A'));
    assert.ok(out.includes('- [ ] **第二步**<br>完成第二关。<br>接着打就行。'), 'B should be left as it was');
  });
});

describe('what the model returns — only the entries that were named count', () => {
  test('only what resolves to an api_name counts, and the order does not affect attribution', () => {
    const md = reply(
      '- [ ] **收集狂**<br>集齐全部收集品。<br>D 先来。',
      '- [ ] **第一步**<br>完成第一关。<br>A 后到。',
    );
    const { found, unresolved } = parsePatchReply(md, DEFS);
    assert.deepEqual([...found.keys()].sort(), ['A', 'D']);
    assert.deepEqual(unresolved, []);
  });

  test('an achievement written that was not named ⇒ not applied, but reported', () => {
    const md = reply(
      '- [ ] **第二步**<br>完成第二关。<br>点名的这条。',
      '- [ ] **第三步**<br>完成第三关。<br>没点名,顺手改的。',
    );
    const { found } = parsePatchReply(md, DEFS);
    const wanted = new Set(['B']);

    // This is the shape of that step inside patchGuide: filter out what was not named
    const applied = new Map([...found].filter(([a]) => wanted.has(a)));
    const extra = [...found.keys()].filter((a) => !wanted.has(a));

    assert.deepEqual([...applied.keys()], ['B']);
    assert.deepEqual(extra, ['C'], 'the extra one has to be reported rather than quietly swallowed');

    // Actually splice once: C has to still be the original text
    const out = spliceIntoText(GUIDE, entriesFor(['B']), applied);
    assert.ok(out.includes('- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。'));
    assert.ok(!out.includes('没点名,顺手改的'));
  });

  test('an entry that cannot be resolved to an achievement goes to unresolved rather than being guessed', () => {
    const md = reply('- [ ] **第五步**<br>这个成就不存在。<br>瞎写的。');
    const { found, unresolved } = parsePatchReply(md, DEFS);
    assert.equal(found.size, 0);
    assert.equal(unresolved.length, 1);
  });

  test('a sub-step is not resolved as an achievement on its own', () => {
    const md = reply(
      '- [ ] **第二步**<br>完成第二关。<br>带子步骤。',
      '  - [ ] 第三步的某个环节',
    );
    const { found } = parsePatchReply(md, DEFS);
    // That sub-step's text contains 「第三步」, and without a correct top-level filter it would be
    // taken as achievement C
    assert.deepEqual([...found.keys()], ['B']);
    assert.equal(found.get('B').length, 2, 'a sub-step has to come back together with its entry');
  });

  test('the same achievement returned twice counts only the first time', () => {
    const md = reply(
      '- [ ] **第二步**<br>完成第二关。<br>第一版。',
      '- [ ] **第二步**<br>完成第二关。<br>第二版。',
    );
    const { found } = parsePatchReply(md, DEFS);
    assert.equal(found.size, 1);
    assert.ok(found.get('B')[0].includes('第一版'));
  });
});

describe('the gate — one entry missed cannot count as a pass', () => {
  test('a missing entry cannot be found by lint, so it has to be judged separately', () => {
    // A and B were named, only A came back — B's old box is still sitting there
    const entries = entriesFor(['A', 'B']);
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>只改了 A。']]]);

    const patched = applyPatchToTodos(TODOS, entries, found);
    const lint = lintGuide({ todos: patched, defs: DEFS, unlockedApiNames: new Set(), kind: 'notion' });

    // **The validator reports not one error** — which is exactly why a missed entry has to be
    // judged separately
    assert.equal(lint.findings.filter((f) => f.level === 'error').length, 0);

    const missing = entries.filter((e) => !found.has(e.apiName)).map((e) => e.apiName);
    assert.deepEqual(missing, ['B'], 'a missed entry has to be found by this count, not by the validator');
  });

  test('applyPatchToTodos: a new entry is always unticked, and the old sub-steps are dropped', () => {
    const entries = entriesFor(['A']);
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>新写的。']]]);
    const patched = applyPatchToTodos(TODOS, entries, found);

    const a = patched.find((t) => t.text.includes('第一步'));
    // In the original A is `- [x]`. Anything newly written is false, with ticking filled in by
    // computeCheckedKeys from the database — carrying the old state over is wrong, because that
    // old tick may have been wrong to begin with
    assert.equal(a.checked, false);
  });

  test('a new sub-step hangs under its own entry', () => {
    const entries = entriesFor(['A']);
    const found = new Map([['A', [
      '- [ ] **第一步**<br>完成第一关。<br>新写的。',
      '  - [ ] 子步骤一',
    ]]]);
    const patched = applyPatchToTodos(TODOS, entries, found);
    const a = patched.find((t) => t.text.includes('第一步'));
    const sub = patched.find((t) => t.text === '子步骤一');

    assert.equal(sub.parent, a.key);
    assert.notEqual(sub.key, a.key, 'a synthesised key has to differ from the parent one');
  });

  test('sub-steps elsewhere in the old guide are untouched', () => {
    const entries = entriesFor(['A']);
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>新写的。']]]);
    const patched = applyPatchToTodos(TODOS, entries, found);

    const boss = patched.find((t) => t.text === '打完第一个 Boss');
    assert.ok(boss, 'B sub-step should still be there');
    assert.equal(boss.checked, true, 'a hand-ticked state has to be kept');
  });
});

describe('attributing findings — an old problem is not charged to this change, but has to be said', () => {
  const finding = (code, apiName, message = code) => ({ level: 'error', code, apiName, message });

  test('a problem inside the selection is charged to this change', () => {
    const { caused, preExisting } = classifyFindings({
      before: [finding('paraphrased-description', 'B')],
      after: [finding('paraphrased-description', 'B')],
      apiNames: ['B'],
    });
    // It existed before the change, but B is exactly what was rewritten this time — still there
    // after the rewrite means this rewrite did not get it right
    assert.equal(caused.length, 1);
    assert.equal(preExisting.length, 0);
  });

  test('a problem outside the selection that existed before does not block', () => {
    const { caused, preExisting } = classifyFindings({
      before: [finding('ambiguous-no-description', 'D')],
      after: [finding('ambiguous-no-description', 'D')],
      apiNames: ['B'],
    });
    assert.equal(caused.length, 0, 'a change that got it right should not be thrown away over an old problem it was not authorised to fix');
    assert.equal(preExisting.length, 1, '**but it has to be reported** — not blocking is not the same as not mentioning');
  });

  test('a newly grown problem is charged to this change, even outside the selection', () => {
    const { caused } = classifyFindings({
      before: [],
      after: [finding('merged-line', null, '一行里写了多个 checkbox')],
      apiNames: ['B'],
    });
    // The splice turned a line into a merged line — it carries no apiName, but it did not exist
    // before the change
    assert.equal(caused.length, 1);
  });

  test('identity does not go by key — line numbers move after a splice, the problem is the same one', () => {
    const { preExisting } = classifyFindings({
      before: [{ level: 'error', code: 'merged-line', key: 5, message: '一行里写了多个:xxx' }],
      after: [{ level: 'error', code: 'merged-line', key: 9, message: '一行里写了多个:xxx' }],
      apiNames: ['B'],
    });
    assert.equal(preExisting.length, 1, 'a changed line number does not make it a new problem');
  });
});

describe('selectors', () => {
  const base = { defs: DEFS, todos: TODOS, rarity: RARITY, unlocked: new Set(['A']), text: GUIDE };

  test('rare uses the same line as the prompt', () => {
    const r = resolveScope({ ...base, selector: 'rare' });
    // C is 1.1%, in; **D is 12%, out** — it sits exactly between the old line (15%) and the new
    // one (10%), so this assertion pins both "the line is at 10%" and "the line really moved"
    assert.deepEqual(r.apiNames, ['C']);
    assert.equal(RARE_PCT, 10);
  });

  test('rare:15 loosens the threshold — the parameter can override the default line', () => {
    // Using the old number as the parameter: D (12%) comes back in. This case used to be rare:5,
    // and 5 selects the same set as the new default line, which proves nothing about whether the
    // parameter is read at all
    assert.deepEqual(resolveScope({ ...base, selector: 'rare:15' }).apiNames, ['C', 'D']);
  });

  test('with no unlock rates, rare raises rather than selecting an empty set', () => {
    // Quietly selecting an empty set looks exactly like "this game has no hard achievements",
    // while the truth is that Steam did not answer
    assert.throws(
      () => resolveScope({ ...base, rarity: null, selector: 'rare' }),
      (e) => e.code === 'no-rarity'
    );
  });

  test('locked picks the ones not yet earned', () => {
    assert.deepEqual(resolveScope({ ...base, selector: 'locked' }).apiNames, ['B', 'C', 'D']);
  });

  /**
   * **The only selectors are the ones with a corresponding button on the Dashboard.**
   *
   * Four were deleted: `all` (a full rewrite is `--overwrite`, and this was a second nearly
   * identical path), `thin` (a criterion that cannot be stated, so it cannot be a button),
   * `unlocked` (nobody ever asked to rewrite what they had already earned) and `failing` (in the
   * real corpus it is nearly always an empty set, and a button that permanently shows 0 only
   * raises questions).
   *
   * What is pinned is that they are **not recognised**, not merely that the remaining ones are:
   * a selector quietly added back turns no test red, and it would give "what can this feature do"
   * two different answers in the CLI and the interface.
   */
  test('the four deleted selectors are treated as nonexistent and resolved as names', () => {
    for (const gone of ['all', 'thin', 'unlocked', 'failing']) {
      const r = resolveScope({ ...base, selector: gone });
      // It falls to the explicit-list branch ⇒ that "achievement name" is unrecognised ⇒ it goes
      // to unresolved rather than selecting a batch
      assert.deepEqual(r.apiNames, [], `${gone} should no longer select achievements`);
      assert.deepEqual(r.unresolved, [gone], `${gone} should be reported as an unrecognised achievement name`);
    }
  });

  test('section: takes only the achievements in that section', () => {
    assert.deepEqual(resolveScope({ ...base, selector: 'section:收集' }).apiNames, ['D']);
    assert.deepEqual(resolveScope({ ...base, selector: 'section:主线' }).apiNames, ['A', 'B', 'C']);
  });

  test('with no full text available, section: raises plainly rather than selecting an empty set', () => {
    assert.throws(
      () => resolveScope({ ...base, text: null, selector: 'section:主线' }),
      (e) => e.code === 'section-needs-local'
    );
  });

  test('an explicit list recognises the Chinese name, the English name and the api_name', () => {
    assert.deepEqual(resolveScope({ ...base, selector: '第一步,D' }).apiNames, ['A', 'D']);
    // The Chinese comma is recognised too — the names are copied off the Dashboard, and the IME
    // gives what it gives
    assert.deepEqual(resolveScope({ ...base, selector: '第一步,第三步' }).apiNames, ['A', 'C']);
  });

  test('an unrecognised name goes to unresolved; not one may vanish quietly', () => {
    const r = resolveScope({ ...base, selector: '第一步,不存在的成就' });
    assert.deepEqual(r.apiNames, ['A']);
    assert.deepEqual(r.unresolved, ['不存在的成就']);
  });

  test('identically named achievements cannot be selected by name — guessing one writes A solution onto B', () => {
    const twins = [def('X1', '妙手空空', '偷到东西。'), def('X2', '妙手空空', '')];
    const r = resolveScope({
      selector: '妙手空空',
      defs: twins,
      todos: [],
      rarity: null,
      unlocked: new Set(),
      text: null,
    });
    assert.deepEqual(r.apiNames, []);
    assert.deepEqual(r.unresolved, ['妙手空空']);

    // The api_name can select it — that one is always unique
    const byApi = resolveScope({
      selector: 'X2', defs: twins, todos: [], rarity: null, unlocked: new Set(), text: null,
    });
    assert.deepEqual(byApi.apiNames, ['X2']);
  });

  test('an empty selector and a nonsense threshold are both refused on the spot', () => {
    // `--only ""` was once swallowed by an internal shortcut `if (!selector)` inside planPatch,
    // which returned `scope: null`, so the caller reading `pp.scope.apiNames` got a TypeError on
    // the spot — a user error turned into an incomprehensible crash. "The caller passed nothing"
    // and "the user passed an empty one" are two different things, so the criterion has to be
    // `== null` rather than falsiness
    assert.throws(() => resolveScope({ ...base, selector: '' }), (e) => e.code === 'empty-scope');
    assert.throws(() => resolveScope({ ...base, selector: 'rare:很稀有' }), (e) => e.code === 'bad-scope');
    assert.throws(() => resolveScope({ ...base, selector: 'section:' }), (e) => e.code === 'bad-scope');
  });
});

describe('locating', () => {
  test('scopeEntries carries the sub-step keys — deleting a child block in Notion needs a block id', () => {
    const { entries } = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['B'] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].subTodos.length, 2);
    for (const s of entries[0].subTodos) assert.notEqual(s.key, undefined);
  });

  test('an achievement with no corresponding box in the guide goes to unlocatable rather than being treated as absent', () => {
    const thin = parseTodos('# 测试游戏\n- [ ] **第一步**<br>完成第一关。');
    const r = scopeEntries({ todos: thin, defs: DEFS, apiNames: ['A', 'C'] });
    assert.deepEqual(r.entries.map((e) => e.apiName), ['A']);
    assert.deepEqual(r.unlocatable, ['C']);
  });

  test('entry order follows defs, not the order written in the selector', () => {
    const { entries } = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['D', 'A'] });
    assert.deepEqual(entries.map((e) => e.apiName), ['A', 'D']);
  });
});

describe('preflight — what it states is what will survive', () => {
  test('only hand ticks under the named entries are lost; the others are reported as kept', () => {
    const entries = entriesFor(['A']);
    const p = patchPreflight({ oldTodos: TODOS, defs: DEFS, entries, oldText: GUIDE });

    // The hand-ticked sub-step under B is not in this round's scope
    assert.equal(p.atRiskTicks.length, 0);
    assert.equal(p.savedTicks, 1);
    assert.equal(p.scope, 1);
    assert.equal(p.replacing, 1);
    assert.equal(p.keeping, p.count - 1);

    const text = formatPatchPreflight(p, { defsCount: DEFS.length });
    assert.match(text, /只改 1 条成就/);
    assert.match(text, /1 个手动勾选保住了/);
  });

  test('naming B loses the hand tick under it, and that has to be said', () => {
    const entries = entriesFor(['B']);
    const p = patchPreflight({ oldTodos: TODOS, defs: DEFS, entries, oldText: GUIDE });

    assert.equal(p.atRiskTicks.length, 1);
    assert.equal(p.savedTicks, 0);
    assert.equal(p.replacing, 3, 'itself plus two sub-steps');

    assert.match(formatPatchPreflight(p), /会变回未勾选/);
  });
});

/**
 * Source assertions — these guard **the orchestration a unit test cannot reach**.
 *
 * `patchGuide` needs a provider and sends requests, so rules like "back up before landing" and
 * "one entry missed is not a pass" cannot be covered by a unit test. The same approach as the
 * `drainNext` assertion in `guidequeue.test.js`: slice between two real anchors (not `indexOf`
 * plus a byte count — such a window drifts quietly as code is added in between), and **strip
 * comments before matching**, or the comment explaining the rule satisfies the assertion by
 * itself and deleting the code leaves it green.
 */
describe('the rules in the orchestration a unit test cannot reach', () => {
  const src = readFileSync(new URL('../lib/guidepatch.js', import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** Slice the tail of patchGuide's loop plus the landing section */
  function landingBlock() {
    const start = src.indexOf('  while (round < rounds) {');
    const end = src.indexOf('  return {\n    ok,');
    assert.notEqual(start, -1, 'cannot find that loop — the extraction is broken, not the rule missing');
    assert.notEqual(end, -1, 'cannot find the return value — the extraction is broken');
    return strip(src.slice(start, end));
  }

  test('one entry missed is not a pass — it cannot become any kind of lint error', () => {
    const block = landingBlock();
    assert.match(block, /const ok = caused\.length === 0 && missing\.length === 0/,
      '`ok` has to look at both caused and missing. Looking only at caused means the achievement the model missed '
      + 'still has its old box in place, the validator reports not one error, and "not changed" is reported as "changed"');
    assert.match(block, /if \(!caused\.length && !missing\.length\) break/,
      'the loop-exit condition has to look at missing too, or the missed entries are never asked for again');
  });

  test('the backup is a precondition of landing, and comes before any write', () => {
    const block = landingBlock();
    const backup = block.indexOf('await backupGuide(');
    const landLocal = block.indexOf('landPatchLocal(');
    const landNotion = block.indexOf('landPatchNotion(');

    assert.ok(backup > -1, 'a backup has to come before landing — an overwrite with no backup is an irreversible delete');
    assert.ok(landLocal > backup && landNotion > backup, 'the backup has to come before both landing paths');
    assert.match(block, /if \(ok\) \{/, 'not one character is written before the gate passes');
  });

  test('both landing paths are inside ok, with no branch bypassing the gate', () => {
    const block = landingBlock();
    // Between `ok` and the return value there should be exactly one if(ok) block. One more
    // independent write path = one path bypassing the gate
    const writes = [...block.matchAll(/landPatch(Local|Notion)\(/g)];
    assert.equal(writes.length, 2, 'landing should be these two calls only');
  });
});

// The prompt line saying a label line has to be a `- [ ]` too, never an ordinary bullet, is not a
// style preference — it was measured here: `todoSpans` counts only **contiguous checkbox lines at
// a deeper indent** as part of one achievement, and one non-checkbox line in between cuts the
// range on the spot. Once cut, a partial rewrite replaces only the achievement line and the old
// content beneath stays as it was — the page shows **duplicates**, with no error.
describe('a group label has to be a checkbox too', () => {
  const P = '- [ ] **创造**<br>你可以创造一切。<br>心得';
  const span1 = (md) => {
    const s = todoSpans(md).get(0);
    return s ? s.end - s.start + 1 : 0;
  };

  test('the shape the prompt teaches is enclosed completely', () => {
    const md = [P,
      '  - [ ] **前置**',
      '    - [ ] 神之侧身像',
      '    - [ ] 玛希尔入队',
      '  - [ ] **步骤**',
      '    - [ ] 寻思龙眼宝石',
    ].join('\n');
    assert.equal(span1(md), 6, 'all six lines have to count as this achievement, or a rewrite leaves duplicates');
    const todos = parseTodos(md);
    assert.equal(todos.length, 6);
    assert.equal(todos.filter((t) => t.parent != null).length, 5, 'all five have to hang off it');
  });

  test('writing the label as an ordinary bullet cuts the range short', () => {
    // This case **is not pinning a behaviour we want**, it is pinning that a constraint exists:
    // the day todoSpans loosens, the reason for the prompt line "it has to be a checkbox" is
    // gone, this goes red, and it is a reminder to change the rule with it
    const md = [P,
      '  - 前置：',
      '    - [ ] 神之侧身像',
      '    - [ ] 玛希尔入队',
    ].join('\n');
    assert.equal(span1(md), 1,
      'one ordinary bullet in between leaves the achievement with only its own line — the whole reason the prompt forbids this form');
  });
});

// The comma is the list separator, and **achievement names carry commas**: of the 10134
// achievements in the library, 302 carry one, and 116 of those belong to games that already have
// a guide. Without trying the whole string as one name first, it is cut in two, neither half
// matches, and what is reported is "these two entries are not in the guide" — pointing nowhere
// near the real cause.
describe('a --only name that carries a comma', () => {
  const withComma = [
    def('A', '第一步', '完成第一关。'),
    def('X', '拔掉插头，放松身心', '关掉10块屏幕。'),
    def('Y', '放松身心', '别的成就。'),
  ];

  test('when the whole string is exactly one achievement name, it is not split', () => {
    const r = resolveScope({ selector: '拔掉插头，放松身心', defs: withComma });
    assert.deepEqual(r.apiNames, ['X']);
    assert.deepEqual(r.unresolved, []);
  });

  test('when the whole string does not match, it is split on the comma as usual', () => {
    const r = resolveScope({ selector: '第一步,放松身心', defs: withComma });
    assert.deepEqual(r.apiNames, ['A', 'Y']);
  });

  test('the api_name fallback was not broken', () => {
    assert.deepEqual(resolveScope({ selector: 'X', defs: withComma }).apiNames, ['X']);
    assert.deepEqual(resolveScope({ selector: 'A,X', defs: withComma }).apiNames, ['A', 'X']);
  });

  test('the Chinese comma really works as a separator — the old character class held two halfwidth commas', () => {
    // `/[,,]/` looks like "halfwidth plus fullwidth" and is in fact the same U+002C written twice,
    // while the comment said all along that the Chinese comma was recognised. What an IME gives is
    // U+FF0C, so this path was broken the whole time, and broken very quietly: the whole string
    // fails to match and it reports "not found in the guide"
    const r = resolveScope({ selector: '第一步，放松身心', defs: withComma });
    assert.deepEqual(r.apiNames, ['A', 'Y']);
    assert.deepEqual(r.unresolved, []);
  });

  test('two names that both miss are still reported rather than silently dropped', () => {
    const r = resolveScope({ selector: '不存在甲,不存在乙', defs: withComma });
    assert.deepEqual(r.apiNames, []);
    assert.deepEqual(r.unresolved, ['不存在甲', '不存在乙']);
  });
});

describe('the prompt', () => {
  test('it lays out the original text and says plainly not to touch anything else', () => {
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '把互斥关系写清楚' });
    assert.match(msg, /把互斥关系写清楚/);
    assert.match(msg, /接着打就行/, 'the model has to be shown the original by default');
    assert.match(msg, /别的一条都不要动/);
    assert.match(msg, /不要写小节标题/);
    assert.match(msg, /- \[ \]/, 'the checked-state rule has to be restated');
  });

  test('the original is always given; there is no "withhold it" mode', () => {
    // There was once a `fresh` switch that withheld the original. Deleted — the interface has no
    // such thing, and requests like "write more detail / add the prerequisites" are the vast
    // majority and all presuppose seeing the original. Passing an extra parameter it does not
    // know should not change the behaviour either
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '重新查', fresh: true });
    assert.match(msg, /接着打就行/, 'the original is always given');
    assert.match(msg, /完成第二关。/, 'the official description too — that is what the hard rule says to copy verbatim');
  });

  test('do not restate "not written by default" at the moment the user has just asked for it', () => {
    // Naming a few entries for a rewrite usually means exactly that those entries are not detailed
    // enough — one real case had the user say plainly "write out the concrete steps" while this
    // message simultaneously said "sub-steps are not written by default", the two contradicting
    // each other. Pointing back at the rule is enough; let the three conditions decide the nesting
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '写详细点' });
    assert.match(msg, /子步骤/, 'how to lay out sub-steps still has to be stated');
    assert.doesNotMatch(msg, /默认不写/, 'do not answer for the three conditions here');
    assert.match(msg, /三个条件/, 'point back at the rule rather than drawing the conclusion here');
  });

  test('with no instruction it says plainly that this is a rewrite, leaving no blank', () => {
    const msg = buildPatchMessage(entriesFor(['B']));
    assert.match(msg, /要求:/);
  });

  test('the send-back list separates "not returned" from "written wrongly"', () => {
    const entries = entriesFor(['A', 'B']);
    const fb = buildPatchFeedback(
      [{ level: 'error', code: 'paraphrased-description', apiName: 'A', message: '描述不是原文照抄:第一步' }],
      entries,
      ['B']
    );
    assert.match(fb, /一条都没交回来/);
    assert.match(fb, /第二步/, 'the missed one has to be named');
    assert.match(fb, /没过机器校验/);
    assert.match(fb, /别动别的成就/);
  });

  test('the send-back list carries only these entries own problems', () => {
    const fb = buildPatchFeedback(
      [
        { level: 'error', code: 'paraphrased-description', apiName: 'A', message: 'A 的问题' },
        { level: 'error', code: 'paraphrased-description', apiName: 'D', message: 'D 的问题' },
      ],
      entriesFor(['A'])
    );
    assert.match(fb, /A 的问题/);
    assert.ok(!fb.includes('D 的问题'), 'another segment problem pushed in here makes the model go and change what it must not touch this round');
  });
});

/**
 * "Rare" has exactly one line
 * ------------------------------------------------
 * `RARE_PCT` decides four things at once: who `--only rare` selects, which entries the prompt
 * tags 🟠 as harder, which percentages the Dashboard renders in the emphasis colour, and the
 * number printed in two pieces of help text.
 *
 * The first two are now **the same constant** (`rarityTag` imports it), and this group pins the
 * other two — each is a literal, and a **string** at that, so drift raises nothing at all: it
 * merely means the interface or the help text says "rare = below 15%" while the program selects
 * at 10%. When it changed from 15% to 10% on 2026-08-18, six places in the project carried the
 * number.
 */
describe('the rare threshold has exactly one line', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('the prompt 🟠 tier is RARE_PCT — not a second copy of it', () => {
    const defs = [def('LOW', '刚好在线内'), def('HIGH', '刚好在线外')];
    // Compute the boundary values from RARE_PCT, so this test stays correct if the constant changes again
    const rarity = new Map([['LOW', RARE_PCT - 0.1], ['HIGH', RARE_PCT + 0.1]]);
    const list = buildAchievementList('测试', 1, defs, rarity);
    const lineOf = (name) => list.split('\n').find((l) => l.includes(name));
    assert.match(lineOf('刚好在线内'), /🟠|🔴/, 'the one inside the line has to be tagged as harder');
    assert.doesNotMatch(lineOf('刚好在线外'), /🟠|🔴/, 'the one outside must not be tagged — the two lines have drifted apart');
  });

  test('the CLI help text prints this same number, in both languages', () => {
    // `help` is written inline in tracker.js; the `--only` advice lives in the message table, and
    // its two halves each state the threshold in their own words. All three have to agree with
    // RARE_PCT, or the interface calls something rare that the program does not
    const src = read('../tracker.js') + read('../lib/tracker-messages.js');
    const hits = [...src.matchAll(/(?:全球解锁率|unlock rate) <(\d+)%/g)].map((m) => Number(m[1]));
    assert.ok(hits.length >= 3, `only ${hits.length} places state the threshold; the help text, and both halves of the advice, all have to`);
    for (const n of hits) assert.equal(n, RARE_PCT);
  });

  test('the Dashboard fallback value is this number too', () => {
    // Normally the threshold comes from the server; the fallback matters only when
    // previewGuidePatch fails, which is exactly why its drifting would almost never be noticed
    const src = read('../Dashboard.html');
    // The two have different shapes: `o.picker.rarePct || 10` and `(sc && sc.rarePct) || 10`,
    // hence the `\)?`. The first version missed the latter and the assertion "both fallbacks are
    // there" failed on the spot — an extraction written too narrowly makes this test quietly pin
    // only half
    const hits = [...src.matchAll(/rarePct\)?\s*\|\|\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(hits.length, 2, 'both fallbacks have to be matched');
    for (const n of hits) assert.equal(n, RARE_PCT);
  });
});

// ---------------------------------------------------------------------------
// Checked state: mechanical ticking has to happen before validation
// ---------------------------------------------------------------------------

describe('the checked state of a partial rewrite', () => {
  /**
   * **This is a real failure, not a hypothesis.** On one game (926340, 46/50), rewriting a single
   * entry failed outright and reported `checked-mismatch`.
   *
   * The chain goes like this: `applyPatchToTodos` marks a rewritten achievement `checked: false`
   * (**which is correct** — what the model returns is always `- [ ]`, as the test above pins), and
   * on landing both backends re-tick according to `computeCheckedKeys`. But **validation runs
   * before landing**, and linting that unticked copy directly makes any **unlocked** achievement
   * report `checked-mismatch` — which is not in `MODEL_FIXABLE`, so `patchGuide` kills the whole
   * change on the spot.
   *
   * In other words this path was unusable for **any unlocked achievement**, which is the vast
   * majority of entries in a mostly-finished guide. `guidepatch.test.js` is all pure-function
   * tests (deliberately), and this bug grew in the part that strings those pure functions
   * together, so the whole suite was green. What is added here is that part.
   */
  const patchedThenTicked = (apiNames, found, unlocked) => {
    const entries = entriesFor(apiNames);
    let patched = applyPatchToTodos(TODOS, entries, found, { kind: 'notion' });
    const wantChecked = new Set(
      computeCheckedKeys({ todos: patched, defs: DEFS, unlockedApiNames: unlocked })
    );
    patched = patched.map((t) => (wantChecked.has(t.key) ? { ...t, checked: true } : t));
    return { patched, wantChecked };
  };

  const rewriteA = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>重写过的正文。']]]);
  const errorsOf = (patched, unlocked) =>
    lintGuide({ todos: patched, defs: DEFS, unlockedApiNames: unlocked, kind: 'notion' })
      .findings.filter((f) => f.level === 'error');

  test('rewriting an unlocked achievement should not make validation report checked-mismatch', () => {
    const unlocked = new Set(['A']);
    const { patched } = patchedThenTicked(['A'], rewriteA, unlocked);
    assert.deepEqual(
      errorsOf(patched, unlocked).map((f) => f.code), [],
      'this is exactly the failure that was reported'
    );
  });

  test('without the mechanical ticking it does report — proving the case above is not empty', () => {
    const unlocked = new Set(['A']);
    const entries = entriesFor(['A']);
    const raw = applyPatchToTodos(TODOS, entries, rewriteA, { kind: 'notion' });
    assert.ok(
      errorsOf(raw, unlocked).some((f) => f.code === 'checked-mismatch'),
      'without that step, any unlocked achievement kills the whole change'
    );
  });

  test('a locked achievement is still unticked after the rewrite', () => {
    const unlocked = new Set();
    const { patched, wantChecked } = patchedThenTicked(['A'], rewriteA, unlocked);
    const a = patched.find((t) => t.text.includes('第一步'));
    assert.equal(a.checked, false, 'locked means unticked — ticking looks only at the database, never at the model');
    assert.equal(wantChecked.size, 0);
  });

  test('the computed set must not be computed a second time — that gives an empty set and unticks the boxes', () => {
    const unlocked = new Set(['A']);
    const { patched, wantChecked } = patchedThenTicked(['A'], rewriteA, unlocked);
    assert.ok(wantChecked.size > 0, 'the first pass has to produce something');
    // computeCheckedKeys skips what is already ticked ("already ticked needs no action"), so
    // computing again over the ticked copy gives an empty set — and the Notion landing path would
    // write that back as `checked: false`
    const again = computeCheckedKeys({ todos: patched, defs: DEFS, unlockedApiNames: unlocked });
    assert.deepEqual(again, [], 'this is why landing has to accept the computed set rather than computing its own');
  });

  test('the checked state of entries that were not named is untouched', () => {
    const unlocked = new Set(['A', 'B']);
    const { patched } = patchedThenTicked(['A'], rewriteA, unlocked);
    const boss = patched.find((t) => t.text === '打完第一个 Boss');
    assert.equal(boss.checked, true, 'a hand-ticked sub-step should not be touched by this change');
  });
});

describe('how far along a partial rewrite says it is', () => {
  test('three steps, and all three always run', () => {
    // A patch has an existing guide by definition, so unlike generationSteps' the backup is not
    // conditional — nothing here is decided by what the run turns out to need
    assert.deepEqual(patchSteps(), ['write', 'backup', 'land']);
  });

  test('rewrite rounds are not steps', () => {
    // The one thing about a run nobody can know in advance. Counted, the total would grow while
    // somebody watched it, which is worse than having no total at all
    assert.equal(patchSteps({ rounds: 3 }).length, patchSteps().length);
  });
});

describe('the wiring of patchGuide (source assertions — this part cannot be reached without a network)', () => {
  const src = readFileSync(new URL('../lib/guidepatch.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('the mechanical ticking comes before lintGuide', () => {
    const i = src.indexOf('wantChecked = new Set(computeCheckedKeys(');
    const j = src.indexOf('lint = lintGuide(');
    assert.ok(i > 0 && j > 0, 'both have to be there');
    assert.ok(i < j, 'computing it after validation is the same as not computing it');
  });

  // The behaviour tests above **re-run the orchestration themselves**, so what they prove is
  // "this logic is right", not "the production code really does it" — delete that line in lib and
  // they stay green. Mutation testing caught it immediately.
  // This case fills that gap: what is computed has to be written back.
  test('the computed ticks have to be written back into patched — computing without writing is not computing', () => {
    const i = src.indexOf('wantChecked = new Set(computeCheckedKeys(');
    const j = src.indexOf('lint = lintGuide(');
    assert.ok(i > 0 && j > i);
    const between = src.slice(i, j);
    assert.match(between, /patched\s*=\s*patched\.map\(/,
      'the computed set has to be written back into patched, or validation still sees the unticked copy');
    assert.match(between, /checked:\s*true/);
  });

  /**
   * What a person watching a twenty-minute rewrite is given. All three of these existed on the
   * generation path for a release while this one reported none of them — the two `onProgress`
   * handlers are separate copies, and the lines were added to the other one.
   */
  test('a tool event is turned into a sentence, not put on screen as its own word', () => {
    assert.match(src, /phase: 'tool'[^}]*name: toolNote\(ev\.name\)/,
      'handing ev.name straight through puts a bare English `search` under a Chinese interface');
    assert.doesNotMatch(src, /phase: 'tool', round, name: ev\.name \}/, 'that is the shape of the defect');
  });

  test('the entry count is reported as the prose streams back', () => {
    const fn = src.slice(src.indexOf('const ask = async (prompt, round)'), src.indexOf('const verdict = checkResult'));
    assert.ok(fn.length > 0 && fn.length < 2000, 'what was sliced should be the ask');
    assert.match(fn, /countStreamedEntries\(streamed\)/, 'the one figure this path can move per achievement');
    assert.match(fn, /phase: 'written'[^}]*of: entries\.length/,
      'counted against what was asked for, or the figure has no denominator');
  });

  test('the steps are announced up front and then marked off', () => {
    assert.match(src, /const steps = patchSteps\(\)/);
    assert.match(src, /stepReporter\(steps, onProgress\)/, 'the reporter is shared with the generation path, not copied');
    for (const key of ['write', 'backup', 'land']) {
      assert.match(src, new RegExp(`step\\('${key}'\\)`), `nothing marks the ${key} step as started`);
    }
  });

  test('the Notion landing accepts the computed set rather than recomputing it', () => {
    const fn = src.slice(
      src.indexOf('async function landPatchNotion'),
      src.indexOf('await notion.setTodoRichText')
    );
    assert.ok(fn.length > 0 && fn.length < 2000);
    assert.doesNotMatch(fn, /computeCheckedKeys\(/,
      'recomputing gives an empty set and then unticks the boxes that were just ticked');
    assert.match(fn, /wantChecked/, 'it has to use the set that was passed in');
  });
});

// ---------------------------------------------------------------------------
// Landing on Notion — **not one line of this had ever executed**
// ---------------------------------------------------------------------------

/**
 * This describe fills a hole, and that hole let two bugs through in a row.
 *
 * The top of this file says everything is a pure function with no network, and `landPatchNotion`
 * is not a pure function, so it had never been run once — not even **whether its body references
 * a variable that does not exist** was known. Measured: while fixing the previous bug I removed
 * `defs` / `unlocked` from its parameters while the read-back check line still used them, giving
 * a runtime `defs is not defined`. `node --check` only looks at syntax, the whole suite never
 * reaches this far, and so it walked into the packaged build, blowing up the first time a user
 * pressed rewrite.
 *
 * **A fake Notion is not a network.** `guidegen-notion.test.js` has done it that way all along;
 * this copies it. Once the function is really executed even once, that class of error has nowhere
 * left to hide.
 */
function fakeNotionPage() {
  return {
    written: [],
    childrenCalls: [],
    async setTodoRichText(blockId, richText, opts = {}) {
      this.written.push({ blockId, checked: opts.checked, text: richText.map((r) => r.text.content).join('') });
    },
    async replaceTodoChildren(blockId, blocks) {
      this.childrenCalls.push({ blockId, count: blocks.length });
    },
    // The read-back: take the original todos and swap the entries changed this round for what was written
    async fetchAllToDoBlocks() {
      return TODOS.map((t) => {
        const w = this.written.find((x) => x.blockId === t.key);
        return w ? { key: t.key, text: w.text, checked: Boolean(w.checked), parent: t.parent } : t;
      });
    },
  };
}

const patchPlan = () => ({
  existing: { url: 'https://notion.so/3b91fee6252b811eaff4f382158bd7bc', kind: 'notion' },
  game: '测试游戏',
  unnameable: new Set(),
});

describe('landPatchNotion (fake Notion)', () => {
  const entries = () => entriesFor(['A']);
  const found = () => new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>重写过的正文。']]]);

  test('it runs at all — this one case alone blocks the "defs is not defined" class', async () => {
    const notion = fakeNotionPage();
    const es = entries();
    const r = await landPatchNotion({
      notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(['A']),
      entries: es, found: found(), wantChecked: new Set([es[0].key]),
    });
    assert.equal(r.kind, 'notion');
    assert.equal(r.changed, 1);
  });

  // This case was **hit by accident** while writing the one above: passing both "A is unlocked"
  // and "do not tick A" made the read-back catch it on the spot. That is exactly why the read-back
  // exists — the flip side of the previous bug (landing recomputes ⇒ empty set ⇒ a box that should
  // be ticked is written unticked) looks just like this, so it is worth its own case
  test('saying it should be ticked while it is not gets caught by the read-back', async () => {
    const notion = fakeNotionPage();
    await assert.rejects(
      () => landPatchNotion({
        notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(['A']),
        entries: entries(), found: found(), wantChecked: new Set(),
      }),
      /成就已解锁但框没勾/
    );
  });

  test('the checked state uses the set passed in rather than being recomputed', async () => {
    const notion = fakeNotionPage();
    const es = entries();
    const key = es[0].key;
    await landPatchNotion({
      notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(['A']),
      entries: es, found: found(), wantChecked: new Set([key]),
    });
    assert.equal(notion.written.length, 1);
    assert.equal(notion.written[0].checked, true, 'the computed set says to tick, so it has to be ticked');
  });

  // **This pins whether what the user pasted in themselves survives.**
  // For a hidden-object game, positions have to be explained with screenshots, and the model
  // cannot produce reliable in-game screenshots (SKILL_RULE_DISPOSITION's 「rule-2」 records why
  // that is not attempted). What is left is the user pasting images under the achievement — so a
  // partial rewrite must not delete them while it is there.
  //
  // **The criterion moved house.** It used to rely on the caller passing only the ids in
  // `e.subTodos`, and a group label is a toggle: the sub-steps inside it can be deleted while the
  // shell cannot, so a rewrite left empty collapsibles behind (measured on one game: two empty
  // shells plus 19 sub-steps never pasted back). It is now the method itself deciding by **block
  // type** — `to_do`/`toggle` is body the model returns in full every time, so delete it; any
  // other type is the user's, so keep it.
  // So this case moved to the real implementation; the `landPatchNotion` layer no longer has a
  // list to verify.
  test('replaceTodoChildren deletes only body blocks (to_do/toggle), keeping hand-pasted images and tables', async () => {
    const notion = new NotionClient({ notion: { token: 't' } });
    notion.childBlockStubs = async () => [
      { id: 'k1', type: 'to_do' },
      { id: 'k2', type: 'toggle' },
      { id: 'k3', type: 'image' },
      { id: 'k4', type: 'table' },
      { id: 'k5', type: 'paragraph' },
    ];
    const deleted = [];
    notion.deleteBlock = async (id) => { deleted.push(id); };
    let appended = 0;
    notion.appendBlocks = async (_id, blocks) => { appended = blocks.length; };

    await notion.replaceTodoChildren('parent', [{ object: 'block', type: 'to_do', to_do: {} }]);

    assert.deepEqual(deleted, ['k1', 'k2'],
      'only to_do and toggle may be deleted — one more type and the user hand-pasted images go with them, with no error');
    assert.equal(appended, 1, 'the new body still has to be written in');
  });

  test('told not to tick, it does not tick', async () => {
    const notion = fakeNotionPage();
    await landPatchNotion({
      notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(),
      entries: entries(), found: found(), wantChecked: new Set(),
    });
    assert.equal(notion.written[0].checked, false);
  });

  test('a read-back that does not match throws, and it is strict only about the entries changed this round', async () => {
    const notion = fakeNotionPage();
    // The text written is replaced by something else — this achievement's checkbox is then gone
    notion.setTodoRichText = async function (blockId) {
      this.written.push({ blockId, checked: false, text: '完全不相干的一行字' });
    };
    await assert.rejects(
      () => landPatchNotion({
        notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(),
        entries: entries(), found: found(), wantChecked: new Set(),
      }),
      /回读校验/
    );
  });

  test('if it cannot be converted to a checkbox it stops rather than writing the rest badly', async () => {
    const notion = fakeNotionPage();
    await assert.rejects(
      () => landPatchNotion({
        notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(),
        entries: entries(),
        found: new Map([['A', ['这一行不是 checkbox']]]),
        wantChecked: new Set(),
      }),
      /转不出 checkbox/
    );
    assert.equal(notion.written.length, 0, 'not one character should be written out');
  });
});

// The one measured on a real game: the model followed groupLabelRule('notion') and wrote three
// `<details>` groups holding 19 sub-steps between them, while the `todoSpans` that
// `parsePatchReply` uses recognises only checkbox lines, so the range broke at the first
// collapsible line and not one sub-step was read in.
test('with a Notion target, sub-steps inside a collapsible count towards that achievement range', () => {
  const md = [
    '- [ ] **第二步**<br>完成第二关。<br>重写过的正文。',
    '\t<details>',
    '\t<summary>**前置** — 开局前先备齐</summary>',
    '\t- [ ] 先拿到钥匙',
    '\t- [ ] 再点亮灯',
    '\t</details>',
    '\t<details>',
    '\t<summary>**注意** — 走岔就掉别的结局</summary>',
    '\t- 别先开箱子',
    '\t</details>',
  ].join('\n');

  const notion = parsePatchReply(md, DEFS, { kind: 'notion' }).found.get('B');
  assert.equal(notion.length, 10, 'a Notion target has to take both collapsibles in whole');
  assert.ok(notion.join('\n').includes('先拿到钥匙'), 'the sub-steps were lost — exactly the bug that was hit');
  assert.ok(notion.join('\n').includes('别先开箱子'), 'the bullets of the caution group have to be there too');

  // The local side **does not change one character of behaviour**: `spliceIntoText` pastes back by
  // line range, one line too many is silently deleting text, and the prompt for a local target
  // never produces this shape
  const local = parsePatchReply(md, DEFS, { kind: 'local' }).found.get('B');
  assert.equal(local.length, 1, 'a local target has to keep the conservative todoSpans range');
});

// An unclosed collapsible (the typical debris of a truncated model response) must not run to end
// of file — that would swallow the other achievements after it
test('with no closing tag the collapsible is not guessed at and the range does not run on', () => {
  const md = [
    '- [ ] **第二步**<br>完成第二关。<br>正文。',
    '\t<details>',
    '\t<summary>**前置**</summary>',
    '\t- [ ] 先拿到钥匙',
  ].join('\n');
  const got = parsePatchReply(md, DEFS, { kind: 'notion' }).found.get('B');
  assert.equal(got.length, 1, 'unclosed falls back to the conservative range, and one line too few is a visible failure');
});
