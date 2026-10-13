/**
 * Partial rewrite — adding the achievements a guide has no entry for
 * ------------------------------------------------
 * Run with: node --test
 *
 * A game update adds achievements. The guide was written before it, so it has no checkbox for them,
 * and a partial rewrite — which only ever replaces boxes that already exist — could not reach them.
 * What this file guards is the other half of that sentence: **writing an entry the guide never had,
 * and putting it in the right place without moving anything the user wrote.**
 *
 * Nearly every assertion is about what did **not** change, for the reason `guidepatch.test.js`
 * states, plus three that only exist here:
 *
 *  - **An achievement is added only when the guide has no box that names it.** A box that exists
 *    but cannot be attributed (two achievements with one name, a reworded entry) is not a missing
 *    entry — adding one beside it writes the same achievement twice, with the old box never ticking
 *  - **An achievement that could not be recognised once written is not asked for.** The reply would
 *    resolve to nothing, the round would fail, and because landing is all-or-nothing the rest of the
 *    batch would be paid for and thrown away with it
 *  - **A new entry goes after everything its section already holds**, never between an entry and
 *    whatever follows it. Where it lands is judged from the section's own content, so the blank-line
 *    style of the guide (tight or spaced) is kept
 *
 * No network and no database: pure functions, and a fake Notion where the page matters.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseTodos, guideOutline } from '../lib/markdown.js';
import { blocksToOutline } from '../lib/notionblocks.js';
import { lintGuide, computeCheckedKeys } from '../lib/guidelint.js';
import {
  SELECTOR_KINDS, resolveScope, scopeEntries, groupBySection, uncoveredApiNames, canonicalEntry,
} from '../lib/guidescope.js';
import { pickableEntries, applyPatchToTodos, addedKey, buildPatchFeedback } from '../lib/guidepatch.js';
import { buildPatchMessage } from '../lib/guidegen.js';
import { patchPreflight, formatPatchPreflight } from '../lib/guidebackup.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const def = (apiName, nameCn, description = '', nameEn = '', descriptionEn = '') => ({
  api_name: apiName,
  name_cn: nameCn,
  name_en: nameEn,
  description,
  description_en: descriptionEn,
  game_name: '测试游戏',
  hidden: 0,
  icon: '',
});

/** A–D are in the guide below; E and F arrived with a patch and are not */
const DEFS = [
  def('A', '第一步', '完成第一关。'),
  def('B', '第二步', '完成第二关。'),
  def('C', '第三步', '完成第三关。'),
  def('D', '收集狂', '集齐全部收集品。'),
  def('E', '第四步', '完成第四关。'),
  def('F', '收集控', '集齐隐藏收集品。'),
];

const GUIDE = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿,顺手的事。',
  '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
  '  - [x] 打完第一个 Boss',
  '  - [ ] 拿到钥匙',
  '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
  '',
  '## 收集',
  '',
  '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
  '',
].join('\n');

const TODOS = parseTodos(GUIDE);
const lintOf = (todos, defs = DEFS) => lintGuide({ todos, defs, kind: 'notion' });

// ---------------------------------------------------------------------------

describe('which achievements the guide has no entry for', () => {
  test('it is the set the linter reports as missing a checkbox, and nothing else', () => {
    const missing = uncoveredApiNames(lintOf(TODOS));
    assert.deepEqual([...missing].sort(), ['E', 'F']);
  });

  test('a lint result with no missing-checkbox finding gives the empty set', () => {
    const full = parseTodos(GUIDE + '- [ ] **第四步**<br>完成第四关。\n- [ ] **收集控**<br>集齐隐藏收集品。\n');
    assert.equal(uncoveredApiNames(lintOf(full)).size, 0);
  });

  test('other findings, with an achievement of their own, are not mistaken for a missing box', () => {
    // A merged line is an error that names the todo and no achievement; a description that was
    // reworded is a warning that names one. Neither means the guide lacks the entry
    const todos = parseTodos(GUIDE.replace('完成第一关。', '随便改了描述') + '- [x] **x** / [x] **y**\n');
    const lint = lintOf(todos);
    assert.ok(lint.findings.some((f) => f.code === 'merged-line'), 'precondition: the other finding is there');
    assert.ok(lint.findings.some((f) => f.code === 'paraphrased-description' && f.apiName === 'A'));
    assert.deepEqual([...uncoveredApiNames(lint)].sort(), ['E', 'F']);
  });
});

describe('scopeEntries — rewrite, add, or neither', () => {
  const missing = new Set(['E', 'F']);

  test('a selected achievement the guide has no box for is an addition, not unlocatable', () => {
    const r = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['B', 'E', 'F'], missing });
    assert.deepEqual(r.entries.map((e) => e.apiName), ['B']);
    assert.deepEqual(r.additions.map((a) => a.apiName), ['E', 'F']);
    assert.equal(r.additions[0].def, DEFS[4], 'the definition travels with it — the prompt needs the name and description');
    assert.deepEqual(r.unlocatable, []);
    assert.deepEqual(r.unaddable, []);
  });

  test('without a missing set nothing is ever added — the old behaviour, for a caller that does not know', () => {
    const r = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['B', 'E'] });
    assert.deepEqual(r.additions, []);
    assert.deepEqual(r.unlocatable, ['E']);
  });

  test('additions follow the order of defs, not the order they were selected in', () => {
    const r = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['F', 'E'], missing });
    assert.deepEqual(r.additions.map((a) => a.apiName), ['E', 'F']);
  });

  test('an achievement the guide already names but cannot attribute is never added — that would write it twice', () => {
    // Two achievements share a name; the guide's one box names it without quoting either description.
    // The linter counts both as covered (a box does carry the name), the resolver cannot say which is
    // which, so neither can be located — and neither is missing
    const twins = [def('G1', '妙手空空', '偷 10 次。'), def('G2', '妙手空空', '偷 100 次。')];
    const todos = parseTodos('- [ ] **妙手空空**<br>随便写了点\n');
    const miss = uncoveredApiNames(lintGuide({ todos, defs: twins, kind: 'notion' }));
    assert.equal(miss.size, 0, 'precondition: the linter does see a box naming them');
    const r = scopeEntries({ todos, defs: twins, apiNames: ['G1', 'G2'], missing: miss });
    assert.deepEqual(r.additions, []);
    assert.deepEqual(r.unlocatable.sort(), ['G1', 'G2']);
  });

  test('a missing achievement that could not be recognised once written is not asked for', () => {
    // Same name, and the description Steam holds is empty: whatever the model writes, the reply
    // resolves to nothing. Asking would fail the round and, landing being all-or-nothing, the batch
    const defs = [
      def('A', '第一步', '完成第一关。'),
      def('X1', '妙手空空', ''),
      def('X2', '妙手空空', ''),
    ];
    const todos = parseTodos('- [ ] **第一步**<br>完成第一关。\n');
    const r = scopeEntries({ todos, defs, apiNames: ['X1', 'X2'], missing: new Set(['X1', 'X2']) });
    assert.deepEqual(r.additions, []);
    assert.deepEqual(r.unaddable.sort(), ['X1', 'X2']);
  });

  test('a missing achievement that shares a name but has a description of its own can be added', () => {
    const defs = [def('X1', '妙手空空', '偷 10 次。'), def('X2', '妙手空空', '偷 100 次。')];
    const r = scopeEntries({ todos: [], defs, apiNames: ['X1', 'X2'], missing: new Set(['X1', 'X2']) });
    assert.deepEqual(r.additions.map((a) => a.apiName), ['X1', 'X2']);
    assert.deepEqual(r.unaddable, []);
  });

  test('in an English guide the English name and description are what the entry will carry', () => {
    const d = def('A', '第一步', '完成第一关。', 'First Step', 'Finish the first level.');
    assert.equal(canonicalEntry(d, 'en'), '**First Step**<br>Finish the first level.');
    assert.equal(canonicalEntry(d, 'zh'), '**第一步**<br>完成第一关。');
  });

  test('the sub-step keys of a located entry still travel with it', () => {
    const r = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['B'], missing });
    assert.equal(r.entries[0].subTodos.length, 2);
  });
});

describe('--only missing', () => {
  const missing = new Set(['E', 'F']);
  const unlocked = new Set(['A']);

  test('it is one of the selector kinds, so the Dashboard and the command line offer the same things', () => {
    assert.ok(SELECTOR_KINDS.has('missing'));
  });

  test('it picks exactly the achievements the guide has no box for', () => {
    const r = resolveScope({ selector: 'missing', defs: DEFS, todos: TODOS, unlocked, missing });
    assert.deepEqual(r.apiNames, ['E', 'F']);
    assert.deepEqual(r.unresolved, []);
  });

  test('an achievement the guide has a box for is not picked, however the set that was passed in reads', () => {
    // The set comes from the linter and the box from the resolver; where they disagree the box wins,
    // because writing an entry beside an existing one writes the achievement twice
    const r = resolveScope({ selector: 'missing', defs: DEFS, todos: TODOS, unlocked, missing: new Set(['B', 'E']) });
    assert.deepEqual(r.apiNames, ['E']);
  });

  test('when nothing is missing it selects nothing, which the caller reports rather than running', () => {
    const r = resolveScope({ selector: 'missing', defs: DEFS, todos: TODOS, unlocked, missing: new Set() });
    assert.deepEqual(r.apiNames, []);
  });

  test('locked reaches the missing ones as well — they are not unlocked either', () => {
    const r = resolveScope({ selector: 'locked', defs: DEFS, todos: TODOS, unlocked, missing });
    assert.ok(r.apiNames.includes('E') && r.apiNames.includes('F'));
  });

  test('a name in an explicit list resolves whether or not the guide has a box for it', () => {
    const r = resolveScope({ selector: '第四步,收集控', defs: DEFS, todos: TODOS, unlocked, missing });
    assert.deepEqual(r.apiNames, ['E', 'F']);
  });

  describe('a name that begins with the word is a name, not the selector', () => {
    // `missing` and `locked` take no argument, so an argument after the colon means the whole string
    // is an achievement's name. Read as the selector it would silently pick a different, larger set
    const named = [
      ...DEFS,
      def('G', 'Missing: The Heist', '偷到金库里的东西。', 'Missing: The Heist'),
      def('H', 'Locked: Door', '打开那扇门。', 'Locked: Door'),
    ];

    test('「Missing: The Heist」 selects that achievement alone', () => {
      const r = resolveScope({ selector: 'Missing: The Heist', defs: named, todos: TODOS, unlocked, missing: new Set(['E', 'F']) });
      assert.deepEqual(r.apiNames, ['G']);
      assert.equal(r.kind, 'list');
    });

    test('「Locked: Door」 selects that achievement alone, not every achievement not yet earned', () => {
      const r = resolveScope({ selector: 'Locked: Door', defs: named, todos: TODOS, unlocked });
      assert.deepEqual(r.apiNames, ['H']);
      assert.equal(r.kind, 'list');
    });

    test('with an argument and no such name it is reported as unrecognised rather than guessed at', () => {
      const r = resolveScope({ selector: 'missing: nothing of that name', defs: DEFS, todos: TODOS, unlocked, missing });
      assert.deepEqual(r.apiNames, []);
      assert.deepEqual(r.unresolved, ['missing: nothing of that name']);
    });

    test('the bare words, with or without a trailing colon, are still the selectors', () => {
      for (const selector of ['missing', 'Missing', ' missing ', 'missing:']) {
        const r = resolveScope({ selector, defs: DEFS, todos: TODOS, unlocked, missing });
        assert.equal(r.kind, 'missing', selector);
        assert.deepEqual(r.apiNames, ['E', 'F'], selector);
      }
      assert.equal(resolveScope({ selector: 'locked:', defs: DEFS, todos: TODOS, unlocked, missing }).kind, 'locked');
    });
  });
});

// ---------------------------------------------------------------------------
// The section structure, and where each section ends
// ---------------------------------------------------------------------------

describe('the outline carries positions', () => {
  test('a local guide reports the line of every heading and top-level entry', () => {
    const o = guideOutline(GUIDE);
    const lines = GUIDE.split('\n');
    for (const item of o) {
      assert.equal(typeof item.at?.line, 'number', `${item.kind} "${item.text}" has no line`);
      assert.ok(lines[item.at.line].includes(item.text.slice(0, 6)),
        `"${item.text}" says line ${item.at.line}, which holds "${lines[item.at.line]}"`);
    }
  });

  test('sub-steps are not entries and carry nothing', () => {
    const o = guideOutline(GUIDE);
    assert.ok(!o.some((i) => i.text.includes('拿到钥匙')));
  });
});

const PAGE = 'page-1';
const rt = (s) => [{ type: 'text', text: { content: s }, plain_text: s }];
const H = (id, text, level = 2) => ({
  id, type: `heading_${level}`, parent: { type: 'page_id', page_id: PAGE }, [`heading_${level}`]: { rich_text: rt(text) },
});
const T = (id, text, { parent = { type: 'page_id', page_id: PAGE }, children = [] } = {}) => ({
  id, type: 'to_do', parent, has_children: children.length > 0, to_do: { rich_text: rt(text), checked: false }, children,
});
const P = (id, text) => ({
  id, type: 'paragraph', parent: { type: 'page_id', page_id: PAGE }, paragraph: { rich_text: rt(text) },
});

describe('a Notion page reports where each entry sits', () => {
  const blocks = [
    H('h1', '主线'),
    T('a', '**第一步**<br>完成第一关。'),
    T('b', '**第二步**<br>完成第二关。', { children: [T('b1', '拿到钥匙', { parent: { type: 'block_id', block_id: 'b' } })] }),
    H('h2', '收集'),
    T('d', '**收集狂**<br>集齐全部收集品。'),
    P('p1', '收集品清单见下面的 BV 号'),
  ];

  test('every entry names its block and the block that holds it', () => {
    const o = blocksToOutline(blocks);
    const entries = o.filter((i) => i.kind === 'todo');
    assert.deepEqual(entries.map((e) => e.at), [
      { id: 'a', parentId: PAGE },
      { id: 'b', parentId: PAGE },
      { id: 'd', parentId: PAGE },
    ]);
  });

  test('a sub-step is still not an entry', () => {
    const o = blocksToOutline(blocks);
    assert.ok(!o.some((i) => i.at?.id === 'b1'));
  });
});

describe('groupBySection', () => {
  test('each group says which section it is, how deep, what sits above it, and where its last entry is', () => {
    const outline = [
      { kind: 'heading', text: '玩法', level: 2, at: { line: 0 } },
      { kind: 'heading', text: '主线', level: 3, at: { line: 1 } },
      { kind: 'todo', text: '**第一步**<br>完成第一关。', at: { line: 2 } },
      { kind: 'todo', text: '**第二步**<br>完成第二关。', at: { line: 3 } },
      { kind: 'heading', text: '收集', level: 3, at: { line: 5 } },
      { kind: 'todo', text: '**收集狂**<br>集齐全部收集品。', at: { line: 6 } },
    ];
    const g = groupBySection(outline, DEFS);
    assert.deepEqual(g.map((x) => x.heading), ['主线', '收集']);
    assert.deepEqual(g.map((x) => x.level), [3, 3]);
    assert.deepEqual(g.map((x) => x.path), [['玩法'], ['玩法']]);
    assert.deepEqual(g[0].lastAt, { line: 3 });
    assert.deepEqual(g[1].lastAt, { line: 6 });
    assert.deepEqual(g[0].apiNames, ['A', 'B']);
  });

  test('the guide’s own title is not part of anybody’s path', () => {
    const outline = [
      { kind: 'heading', text: '测试游戏', level: 1, at: { line: 0 } },
      { kind: 'heading', text: '主线', level: 2, at: { line: 2 } },
      { kind: 'todo', text: '**第一步**<br>完成第一关。', at: { line: 3 } },
    ];
    assert.deepEqual(groupBySection(outline, DEFS)[0].path, []);
  });

  test('an entry that cannot be attributed is neither listed nor taken for the last one', () => {
    const outline = [
      { kind: 'heading', text: '主线', level: 2, at: { line: 0 } },
      { kind: 'todo', text: '**第一步**<br>完成第一关。', at: { line: 1 } },
      { kind: 'todo', text: '这一条是用户自己写的清单项', at: { line: 2 } },
    ];
    const g = groupBySection(outline, DEFS);
    assert.deepEqual(g[0].apiNames, ['A']);
    assert.deepEqual(g[0].lastAt, { line: 1 });
  });

  test('a section holding no attributable entry is dropped, as before', () => {
    const outline = [
      { kind: 'heading', text: '机制速查', level: 2, at: { line: 0 } },
      { kind: 'heading', text: '主线', level: 2, at: { line: 3 } },
      { kind: 'todo', text: '**第一步**<br>完成第一关。', at: { line: 4 } },
    ];
    assert.deepEqual(groupBySection(outline, DEFS).map((x) => x.heading), ['主线']);
  });

  test('entries before the first heading form a group with no heading, as before', () => {
    const outline = [{ kind: 'todo', text: '**第一步**<br>完成第一关。', at: { line: 0 } }];
    const g = groupBySection(outline, DEFS);
    assert.equal(g[0].heading, null);
    assert.deepEqual(g[0].lastAt, { line: 0 });
  });
});

// ---------------------------------------------------------------------------
// What the Dashboard's picker is given
// ---------------------------------------------------------------------------

const ADDS = [{ apiName: 'E', def: DEFS[4] }, { apiName: 'F', def: DEFS[5] }];

describe('pickableEntries — the first group is the achievements the guide has no entry for', () => {
  const RARITY = new Map([['A', 64.5], ['B', 40.0], ['C', 1.1], ['D', 12.0], ['E', 3.2], ['F', 20.0]]);
  const plan = (over = {}) => ({
    defs: DEFS, oldTodos: TODOS, rarity: RARITY, unlocked: new Set(['A']), lang: 'zh', ...over,
  });
  const groups = groupBySection(guideOutline(GUIDE), DEFS);
  const uncovered = uncoveredApiNames(lintOf(TODOS));

  test('they come first, flagged, and carry what the rest of the list carries', () => {
    const [first, ...rest] = pickableEntries({ plan: plan(), groups, uncovered });
    assert.equal(first.added, true);
    assert.equal(first.heading, null, 'the server sends the fact, not a name for it — the interface words it');
    assert.deepEqual(first.items.map((i) => i.apiName), ['E', 'F']);
    assert.ok(first.items.every((i) => i.added === true));
    assert.deepEqual(first.items[0], { apiName: 'E', name: '第四步', rarity: 3.2, unlocked: false, added: true });
    assert.deepEqual(rest.map((g) => g.heading), ['主线', '收集']);
    assert.ok(rest.every((g) => !g.added && g.items.every((i) => !i.added)));
  });

  test('without the set of what is missing there is no such group, which is how the list read before', () => {
    const g = pickableEntries({ plan: plan(), groups });
    assert.deepEqual(g.map((x) => x.heading), ['主线', '收集']);
  });

  test('a guide with nothing missing has no such group', () => {
    const g = pickableEntries({ plan: plan(), groups, uncovered: new Set() });
    assert.ok(!g.some((x) => x.added));
  });

  test('what could not be written is not offered: a click on it would do nothing', () => {
    const defs = [...DEFS, def('X1', '妙手空空', ''), def('X2', '妙手空空', '')];
    const miss = new Set(['E', 'F', 'X1', 'X2']);
    const g = pickableEntries({ plan: plan({ defs }), groups, uncovered: miss });
    assert.deepEqual(g[0].items.map((i) => i.apiName), ['E', 'F']);
  });

  test('a box that exists but cannot be attributed is not offered either — it would be written twice', () => {
    const twins = [def('G1', '妙手空空', '偷 10 次。'), def('G2', '妙手空空', '偷 100 次。')];
    const todos = parseTodos('- [ ] **妙手空空**<br>随便写了点\n');
    const g = pickableEntries({
      plan: plan({ defs: twins, oldTodos: todos, rarity: null }),
      groups: [],
      uncovered: uncoveredApiNames(lintGuide({ todos, defs: twins, kind: 'notion' })),
    });
    assert.deepEqual(g, []);
  });
});

describe('the writing request', () => {
  const entries = [
    { apiName: 'B', def: DEFS[1], text: '**第二步**<br>完成第二关。<br>接着打。' },
    { apiName: 'E', def: DEFS[4], text: null, added: true },
  ];
  const ENTRIES_EN = [
    { apiName: 'B', def: def('B', '', 'Finish the second level.', 'Second Step', 'Finish the second level.'), text: '**Second Step**<br>Finish the second level.' },
    { apiName: 'E', def: def('E', '', 'Finish the fourth level.', 'Fourth Step', 'Finish the fourth level.'), text: null, added: true },
  ];

  test('a new entry is shown as one that does not exist yet, and the old one as it stands', () => {
    const p = buildPatchMessage(entries, { lang: 'zh' });
    assert.match(p, /这一轮只处理下面 2 条成就/);
    assert.match(p, /其中 1 条是游戏更新后才有的/);
    assert.match(p, /2\. \*\*第四步\*\*\n {3}官方描述:完成第四关。\n {3}现在写的:\(游戏更新后新增的成就,攻略里还没有这一条,从头写\)/);
    assert.match(p, /1\. \*\*第二步\*\*\n {3}官方描述:完成第二关。\n {3}现在写的:\*\*第二步\*\*<br>完成第二关。<br>接着打。/);
  });

  test('without a requirement the default says what to do with each kind', () => {
    assert.match(buildPatchMessage(entries, { lang: 'zh' }), /已经有的重新写,新增的第一次写/);
    assert.match(buildPatchMessage(ENTRIES_EN, { lang: 'en' }), /rewrite the ones already in the guide and write the new ones/);
  });

  test('a requirement the user wrote is passed through, whatever the mix', () => {
    assert.match(buildPatchMessage(entries, { instruction: '写详细点', lang: 'zh' }), /要求:写详细点/);
  });

  test('it says the program decides where a new entry goes, so no heading is asked for', () => {
    assert.match(buildPatchMessage(entries, { lang: 'zh' }), /不要写小节标题.*放到攻略里合适的位置/);
    assert.match(buildPatchMessage(ENTRIES_EN, { lang: 'en' }), /No section headings.*where they belong in the guide/);
  });

  test('rewrite-only requests read exactly as they always did', () => {
    const zh = buildPatchMessage([entries[0]], { lang: 'zh' });
    assert.match(zh, /这一轮只重写下面 1 条成就,别的一条都不要动、也不要输出/);
    assert.match(zh, /要重写的是这 1 条/);
    assert.match(zh, /程序会把它们贴回原来的位置/);
    assert.doesNotMatch(zh, /新增|游戏更新/);
    const en = buildPatchMessage([ENTRIES_EN[0]], { lang: 'en' });
    assert.match(en, /This round rewrites only the 1 achievements/);
    assert.doesNotMatch(en, /added by a game update/);
  });

  test('the English request holds no Chinese', () => {
    assert.doesNotMatch(buildPatchMessage(ENTRIES_EN, { lang: 'en' }), /[一-鿿]/);
  });

  test('the rejection list names an entry that never came back, new or not', () => {
    const p = buildPatchFeedback([], entries, ['E'], 'zh');
    assert.match(p, /这 1 条一条都没交回来:第四步/);
  });
});

describe('the gate sees a new entry as a box of its own', () => {
  test('it is added to the list, unticked, with its sub-steps under it', () => {
    const found = new Map([['E', ['- [ ] **第四步**<br>完成第四关。', '  - [ ] 先过前三关']]]);
    const out = applyPatchToTodos(TODOS, [], found, { additions: [ADDS[0]] });
    const added = out.filter((t) => t.key === addedKey('E') || String(t.key).startsWith(addedKey('E') + '#'));
    assert.equal(added.length, 2);
    assert.equal(added[0].checked, false);
    assert.equal(added[0].parent, null);
    assert.equal(added[1].parent, addedKey('E'));
    assert.equal(out.length, TODOS.length + 2, 'and nothing else was added or removed');
  });

  test('with the box in the list the guide stops being missing it', () => {
    const found = new Map([['E', ['- [ ] **第四步**<br>完成第四关。']], ['F', ['- [ ] **收集控**<br>集齐隐藏收集品。']]]);
    const out = applyPatchToTodos(TODOS, [], found, { additions: ADDS });
    assert.equal(uncoveredApiNames(lintOf(out)).size, 0);
  });

  test('an addition the model did not write adds nothing', () => {
    const out = applyPatchToTodos(TODOS, [], new Map(), { additions: ADDS });
    assert.equal(out.length, TODOS.length);
  });

  test('ticking reaches it by its own key, so an unlocked new entry is written ticked', () => {
    const found = new Map([['E', ['- [ ] **第四步**<br>完成第四关。']]]);
    const out = applyPatchToTodos(TODOS, [], found, { additions: ADDS });
    const keys = computeCheckedKeys({ todos: out, defs: DEFS, unlockedApiNames: new Set(['E']) });
    assert.deepEqual(keys, [addedKey('E')]);
  });
});

// ---------------------------------------------------------------------------
// The wiring a unit test cannot reach — what the server, the page and the command line hand each other
// ---------------------------------------------------------------------------

describe('the wiring (source assertions — none of this runs without a server, a browser or a terminal)', () => {
  /** Comments out first: the comment explaining a symbol would otherwise satisfy a search for it */
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
  const server = read('lib/server.js');
  const page = read('Dashboard.html');
  const cli = read('tracker.js');

  test('the picker is handed the set of what the guide is missing, or it can never show the group', () => {
    assert.match(server, /pickableEntries\(\{ plan, groups, uncovered \}\)/);
    assert.match(server, /const \{ plan, baseline, uncovered, oldText, kind \} = await planPatch\(/);
  });

  test('the outline is read without the insides of the checkboxes', () => {
    assert.match(server, /blocksToOutline\(await notion\.fetchSectionBlocks\(/);
    assert.doesNotMatch(server, /blocksToOutline\(await notion\.fetchAllBlocks\(/);
  });

  test('a run that only adds is queued with its real size', () => {
    assert.match(server, /count: entries\.length \+ additions\.length/);
  });

  test('the finished card carries what was added and where the overflow went', () => {
    assert.match(server, /added: \(r\.added \?\? \[\]\)\.length/);
    assert.match(server, /unaddable: \(r\.unaddable \?\? \[\]\)\.length/);
    assert.match(server, /fallback: \(r\.placement\?\.fallback \?\? \[\]\)\.length/);
    assert.match(server, /fallbackHeading: r\.placement\?\.heading \?\? null/);
  });

  test('every phase the filing reports reaches the progress bar', () => {
    for (const phase of ['place', 'place-retry', 'place-failed', 'notion-add']) {
      assert.ok(server.includes(`ev.phase === '${phase}'`), `${phase} is reported by the run and shown nowhere`);
    }
  });

  test('where the overflow went is said once, by the finished card, and not again as a warning on the way', () => {
    // The in-run warning and the card's own line were one sentence, and the card showed it twice
    assert.doesNotMatch(server, /ev\.phase === 'placed'/);
    assert.match(page, /t\('res\.addedAtEnd'/);
  });

  test('the page names the group of new entries itself', () => {
    assert.match(page, /g\.added \? t\('pick\.added'\)/);
  });

  test('the page says 新增 beside 已修改 only when something was added', () => {
    assert.match(page, /pat && pat\.added/);
    assert.match(page, /t\('res\.rewroteAdded'/);
    assert.match(page, /t\('res\.added'/);
  });

  test('the command line shows the request it would send with the new entries in it', () => {
    assert.match(cli, /buildPatchMessage\(asked, \{ instruction, lang: plan\.lang \}\)/);
    assert.match(cli, /const asked = askedEntries\(\{ entries, additions, defs: plan\.defs \}\)/);
  });

  test('nothing missing has advice of its own, not the advice for a threshold that matched nothing', () => {
    assert.match(cli, /'nothing-missing': 'hint\.nothingMissing'/);
  });
});

describe('the preflight', () => {
  const entries = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['B'] }).entries;

  test('adding is counted apart from replacing, and changes neither what stays nor what is at risk', () => {
    const base = patchPreflight({ oldTodos: TODOS, defs: DEFS, entries });
    const adding = patchPreflight({ oldTodos: TODOS, defs: DEFS, entries, adding: 2 });
    assert.equal(adding.adding, 2);
    assert.equal(base.adding, 0);
    assert.equal(adding.keeping, base.keeping);
    assert.deepEqual(adding.atRiskTicks, base.atRiskTicks);
  });

  test('it is stated beside the rewrite when there is one, and in place of it when there is not', () => {
    const both = formatPatchPreflight(patchPreflight({ oldTodos: TODOS, defs: DEFS, entries, adding: 2 }));
    assert.match(both, /另外新增 2 条/);
    const only = formatPatchPreflight(patchPreflight({ oldTodos: TODOS, defs: DEFS, entries: [], adding: 2 }));
    assert.match(only, /只新增 2 条/);
    assert.doesNotMatch(only, /只改 0 条/);
  });

  test('a run that adds nothing reads exactly as it did', () => {
    const text = formatPatchPreflight(patchPreflight({ oldTodos: TODOS, defs: DEFS, entries }));
    assert.match(text, /只改 1 条成就/);
    assert.doesNotMatch(text, /新增/);
  });
});
