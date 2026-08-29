/**
 * Regression tests for the guide validator
 * ------------------------------------------------
 * Run with: node --test
 *
 * The failure class this file guards is **false positives**. The validator is to become the
 * gate for AI-generated guides, with nothing landing that does not pass; a rule that can
 * misfire either blocks a good guide or, worse, trains people to ignore the validation
 * results — at which point it may as well not exist.
 * So besides "what should be reported is reported", what matters more here are the cases
 * that "look reportable and are not": a duplicate-named achievement's box does exist (its
 * name simply cannot be resolved), a sub-step is not an achievement, and an achievement with
 * an empty description is unsolvable but is not the guide's fault.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintGuide, computeCheckedKeys } from '../lib/guidelint.js';

/** Builds an achievement definition with the same field names as the achievements table */
const def = (apiName, nameCn, description = '', nameEn = '') => ({
  api_name: apiName,
  name_cn: nameCn,
  name_en: nameEn,
  description,
});
const todo = (key, text, checked = false, parent = null) => ({ key, text, checked, parent });

const codesOf = (r) => r.findings.map((f) => f.code);

describe('missing checkbox', () => {
  test('an achievement with no box → error', () => {
    const r = lintGuide({
      defs: [def('A', '第一步'), def('B', '第二步')],
      todos: [todo(1, '**第一步**')],
    });
    assert.equal(r.ok, false);
    assert.deepEqual(codesOf(r), ['missing-checkbox']);
    assert.equal(r.findings[0].name, '第二步');
  });

  test('all boxes present → passes', () => {
    const r = lintGuide({
      defs: [def('A', '第一步'), def('B', '第二步')],
      todos: [todo(1, '**第一步**'), todo(2, '**第二步**')],
    });
    assert.equal(r.ok, true);
    assert.equal(r.stats.covered, 2);
  });

  test('an English name counts too (achievement names stay English when a game has no Chinese)', () => {
    const r = lintGuide({
      defs: [def('A', '', '', 'First Blood')],
      todos: [todo(1, '**First Blood**<br>拿到第一滴血')],
    });
    assert.equal(r.ok, true);
  });

  test('a name followed by a description and notes still matches (SKILL.md rule 3.1\'s three-part form)', () => {
    const r = lintGuide({
      defs: [def('A', '妙手空空', '偷窃十次')],
      todos: [todo(1, '**妙手空空**<br>偷窃十次<br>开局就能做,别等')],
    });
    assert.equal(r.ok, true);
  });
});

describe('merged lines', () => {
  test('two checkboxes on one line → error', () => {
    const r = lintGuide({
      defs: [def('A', 'A成就'), def('B', 'B成就')],
      todos: [todo(1, '**A成就** / [x] **B成就**')],
    });
    assert.ok(codesOf(r).includes('merged-line'));
  });

  test('square brackets in the prose that are not a checkbox → not reported', () => {
    const r = lintGuide({
      defs: [def('A', 'A成就')],
      todos: [todo(1, '**A成就**<br>参考 [攻略链接](http://x) 里的做法')],
    });
    assert.equal(codesOf(r).includes('merged-line'), false);
  });
});

describe('duplicate-named achievements', () => {
  const twins = [
    def('A1', '妙手空空', '成功偷窃了其他修仙者的物品10次,并且尚未被察觉。'),
    def('A2', '妙手空空', '通关且成功偷窃其他修仙者100次'),
  ];

  test('the description copied verbatim → passes, and no false missing-checkbox', () => {
    const r = lintGuide({
      defs: twins,
      todos: [
        todo(1, '**妙手空空**<br>成功偷窃了其他修仙者的物品10次,并且尚未被察觉。'),
        todo(2, '**妙手空空**<br>通关且成功偷窃其他修仙者100次'),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
  });

  test('no description copied → reports the name ambiguity, but **not** a missing checkbox (the box exists)', () => {
    const r = lintGuide({
      defs: twins,
      todos: [todo(1, '**妙手空空**'), todo(2, '**妙手空空**')],
    });
    assert.equal(codesOf(r).includes('missing-checkbox'), false, 'the box exists and must not be reported missing');
    assert.equal(r.findings.filter((f) => f.code === 'ambiguous-no-description').length, 2);
  });

  test('the description on Steam is itself empty → a different code, because nobody can fix this one', () => {
    // The two used to share `ambiguous-no-description` with the difference hanging on a
    // `fixable` boolean — and that field **was computed and read by no production code at
    // all**; this test originally only asserted that it was set.
    // The result was a guide with full 197/197 coverage stopped by 15 errors nobody could
    // change, after first spending three rounds asking the model to copy a description that
    // does not exist (KINGDOM HEARTS -HD 1.5+2.5 ReMIX-, a four-in-one collection).
    // They are now split by code, and the code is the only thing in this project used to
    // route "can this be remedied".
    const r = lintGuide({
      defs: [def('P1', 'Pilgrimage', ''), def('P2', 'Pilgrimage', '')],
      todos: [todo(1, '**Pilgrimage**'), todo(2, '**Pilgrimage**')],
    });
    assert.equal(r.findings.filter((f) => f.code === 'ambiguous-empty-description').length, 2);
    assert.equal(
      r.findings.filter((f) => f.code === 'ambiguous-no-description').length, 0,
      'an empty description must not still be reported as "the description was not copied" — that sentence demands something impossible'
    );
    // The message must not both say "this is not the guide's fault" and still block. It now states only the consequence
    const f = r.findings.find((x) => x.code === 'ambiguous-empty-description');
    assert.match(f.message, /注定同步不上/);
    assert.match(f.message, /不是攻略能修的/);
  });

  test('the reported name uses Steam\'s spelling, not the normalised index key', () => {
    // The index key has been through normalizeText (lowercased, punctuation stripped), so read
    // aloud it is `proud player` while what the user sees on Steam is `Proud Player`. Measured
    // in the dialog it really was lowercase, and it reads as a different achievement
    const r = lintGuide({
      defs: [def('A1', 'Proud Player', ''), def('A2', 'Proud Player', '')],
      todos: [todo(1, '**Proud Player**'), todo(2, '**Proud Player**')],
    });
    const f = r.findings.find((x) => x.code === 'ambiguous-empty-description');
    assert.match(f.message, /Proud Player/);
    assert.equal(f.name, 'Proud Player');
  });

  test('only the Chinese names collide while the English differ → the English side still covers', () => {
    const r = lintGuide({
      defs: [
        def('N1', '大师', '甲的描述', 'Nano-Virus Master'),
        def('N2', '大师', '乙的描述', 'Bioweapon Master'),
      ],
      todos: [
        todo(1, '**Nano-Virus Master**<br>甲的描述'),
        todo(2, '**Bioweapon Master**<br>乙的描述'),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
  });
});

describe('the verbatim description', () => {
  test('a paraphrased description → warn, not error (it can still be ticked by name; only audit\'s reverse lookup fails)', () => {
    const r = lintGuide({
      defs: [def('A', '妙手空空', '成功偷窃了其他修仙者的物品10次,并且尚未被察觉。')],
      todos: [todo(1, '**妙手空空**<br>隐秘偷窃10次')],
    });
    assert.deepEqual(codesOf(r), ['paraphrased-description']);
    assert.equal(r.ok, true, 'a warn should not fail the whole guide');
  });

  test('a whitespace difference is not a paraphrase (the same test as resolveTodoToAchievement)', () => {
    const r = lintGuide({
      defs: [def('A', 'X', '偷窃 十次')],
      todos: [todo(1, '**X**<br>偷窃十次')],
    });
    assert.equal(codesOf(r).includes('paraphrased-description'), false);
  });

  test('an achievement with a missing checkbox is not also reported for its description', () => {
    const r = lintGuide({
      defs: [def('A', '没写进攻略的成就', '某个描述')],
      todos: [],
    });
    assert.deepEqual(codesOf(r), ['missing-checkbox']);
  });
});

describe('tick state', () => {
  test('unlocked but not ticked → error', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**', false)],
      unlockedApiNames: new Set(['A']),
    });
    assert.ok(codesOf(r).includes('checked-mismatch'));
  });

  test('ticked but not unlocked → error', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**', true)],
      unlockedApiNames: new Set(),
    });
    assert.ok(codesOf(r).includes('checked-mismatch'));
  });

  test('with no unlock data the whole rule is skipped rather than guessed', () => {
    const r = lintGuide({ defs: [def('A', 'X')], todos: [todo(1, '**X**', true)] });
    assert.equal(codesOf(r).includes('checked-mismatch'), false);
  });
});

describe('the rules only a local markdown guide can be checked against', () => {
  test('a local guide missing `# 游戏名` → error', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: 'appid: 123\n\n## 一、店铺日常\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.ok(codesOf(r).includes('missing-title'));
  });

  test('with a `# 游戏名` → passes', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: '# 苏丹的游戏\n\nappid: 123\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.equal(r.ok, true);
  });

  test('a Notion guide does not require a `# 标题` (the name comes from the title property)', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: 'appid: 123\n\n- [ ] **X**',
      kind: 'notion',
    });
    assert.equal(codesOf(r).includes('missing-title'), false);
  });

  test('statistics in a section heading → warn', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: '# 游戏\n\n## 收集类(共 39 个)\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.ok(codesOf(r).includes('stats-in-heading'));
  });

  test('a note about the data source → warn', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: '# 游戏\n\n勾选状态来自 Steam 真实解锁数据。\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.ok(codesOf(r).includes('data-source-note'));
  });

  test('without the full text these rules are skipped rather than reported as missing', () => {
    const r = lintGuide({ defs: [def('A', 'X')], todos: [todo(1, '**X**')], kind: 'local' });
    assert.equal(codesOf(r).includes('missing-title'), false);
  });
});

describe('sub-steps', () => {
  test('a nested sub-step is not an achievement and must not be reported as surplus content', () => {
    const r = lintGuide({
      defs: [def('A', '水火不容', '完成所有差事')],
      todos: [
        todo(1, '**水火不容**<br>完成所有差事'),
        todo(2, '1.【二手灵魂】:第一次水位下降后', false, 1),
        todo(3, '2.【法夫纳的宝藏】:离开精灵国时', false, 1),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.equal(r.findings.length, 0);
  });
});

describe('computeCheckedKeys (mechanical ticking)', () => {
  test('an unlocked achievement → should be ticked', () => {
    const keys = computeCheckedKeys({
      defs: [def('A', 'X'), def('B', 'Y')],
      todos: [todo(1, '**X**'), todo(2, '**Y**')],
      unlockedApiNames: new Set(['A']),
    });
    assert.deepEqual(keys, [1]);
  });

  test('an already-ticked one is not returned again (the sync only ticks and never unticks)', () => {
    const keys = computeCheckedKeys({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**', true)],
      unlockedApiNames: new Set(['A']),
    });
    assert.deepEqual(keys, []);
  });

  test('duplicate-named achievements are never ticked — they cannot be told apart, and a missed tick beats a wrong one', () => {
    const keys = computeCheckedKeys({
      defs: [def('A1', '妙手空空', '甲'), def('A2', '妙手空空', '乙')],
      todos: [todo(1, '**妙手空空**<br>甲'), todo(2, '**妙手空空**<br>乙')],
      unlockedApiNames: new Set(['A1']),
    });
    assert.deepEqual(keys, []);
  });

  test('a sub-step is never ticked by mistake (its name matches no achievement)', () => {
    const keys = computeCheckedKeys({
      defs: [def('A', '水火不容')],
      todos: [todo(1, '**水火不容**'), todo(2, '1.【二手灵魂】', false, 1)],
      unlockedApiNames: new Set(['A']),
    });
    assert.deepEqual(keys, [1]);
  });
});

// The rule above checks "every achievement has a box" and cannot check "every top-level box
// is an achievement".
// 《破晓传奇》 reported 「覆盖 58/58,0 条 warn」 after generation while the page held 70
// top-level checkboxes — the extra 12 were sub-steps written at top level that should have
// been nested, and they can never be ticked.
test('a top-level checkbox that resolves to no achievement is reported, while a nested sub-step is not', () => {
  const defs = [{ api_name: 'A', name_cn: '聊不完的话题', name_en: '', description: 'd', game_name: 'g', hidden: 0, icon: '' }];
  const todos = [
    { key: 0, text: '聊不完的话题\nd', checked: false, parent: null },
    { key: 1, text: '「回归自我」', checked: false, parent: null },
    { key: 2, text: '某个子步骤', checked: false, parent: 0 },
  ];
  const codes = lintGuide({ todos, defs, kind: 'notion' }).findings.map((f) => f.code);
  assert.deepEqual(codes, ['orphan-todo'], 'only that one orphaned top-level box should be reported');
  // **A nested sub-step is legitimate**, and reporting it would wash every guide with sub-steps into a wall of warnings
  assert.ok(!codes.includes('orphan-todo') || todos[2].parent === 0);
});

// **They look identical to a real orphan in `parent`.**
// Entries inside a top-level toggle (rule five's long list) come through
// `fetchAllToDoBlocks`, which treats the container as transparent and passes `parent`
// straight down, so theirs is `null` too — `parent` alone cannot tell them apart.
// Measured in practice: 《破晓传奇》's 38 owl locations were all falsely reported as
// orphans, and **38 false alarms are worse than no check at all** — they train people to
// ignore warnings.
test('a checkbox inside a toggle is not an orphan, and both backends have to give the same answer', () => {
  const defs = [{ api_name: 'A', name_cn: '聊不完的话题', name_en: '', description: 'd', game_name: 'g', hidden: 0, icon: '' }];
  const mk = (key, text, container) => ({ key, text, checked: false, parent: null, container });

  // Notion: it relies on the `container` marker
  const notion = lintGuide({
    todos: [mk(0, '聊不完的话题', false), mk(1, '折叠里的位置', true), mk(2, '「回归自我」', false)],
    defs, kind: 'notion',
  }).findings.filter((f) => f.code === 'orphan-todo');
  assert.equal(notion.length, 1, 'only that one real orphan should be reported');
  assert.match(notion[0].message, /「回归自我」/);

  // Local md: there is only text, so line numbers decide which sit inside a <details>
  const text = [
    '- [ ] 聊不完的话题',
    '<details>',
    '<summary>位置一览</summary>',
    '- [ ] 折叠里的位置',
    '</details>',
    '- [ ] 「回归自我」',
  ].join('\n');
  const local = lintGuide({
    todos: [mk(0, '聊不完的话题'), mk(3, '折叠里的位置'), mk(5, '「回归自我」')],
    defs, text, kind: 'local',
  }).findings.filter((f) => f.code === 'orphan-todo');
  assert.equal(local.length, 1, 'the local side should report exactly one too — the two backends disagreeing is a bug');
  assert.match(local[0].message, /「回归自我」/);
});
