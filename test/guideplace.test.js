/**
 * Placing new entries in a guide
 * ------------------------------------------------
 * Run with: node --test
 *
 * An achievement a game update added has no box in the guide. Once its entry is written it still
 * has to go somewhere, and "somewhere" is a judgement (which section is it about?) followed by a
 * splice (after what, and with what spacing?). This file holds both halves apart from the writing:
 *
 *  - **The judgement may fail and the run must still land.** The entry is written, ticked and
 *    through the gates; a section it was never filed under is a tidiness problem. Every failure of
 *    that pass degrades to the end of the guide and **says which one it was** — except a
 *    cancellation, which is the one outcome a retry must not swallow.
 *  - **The splice changes nothing it was not asked to.** Delete the inserted lines and the text is
 *    the text it was, byte for byte, in the file's own line-ending style.
 *  - **A section is judged by its own content.** A new entry goes after everything the section
 *    already holds, so it is never put between an entry and whatever follows it, and a guide that
 *    separates its entries with blank lines keeps doing so.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { spliceLines } from '../lib/markdown.js';
import {
  FALLBACK_HEADING, fallbackHeading, localSections, notionSections,
  placementSystemFor, buildPlacementPrompt, parsePlacementReply, placeAdditions,
  planInsertions, localInsertEdits, verifyPlacement,
} from '../lib/guideplace.js';
import { ASIDE_EFFORT, REGROUP_ATTEMPTS } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const def = (apiName, nameCn, description = '', nameEn = '', descriptionEn = '') => ({
  api_name: apiName, name_cn: nameCn, name_en: nameEn, description, description_en: descriptionEn,
  game_name: '测试游戏', hidden: 0, icon: '',
});

const DEFS = [
  def('A', '第一步', '完成第一关。'),
  def('B', '第二步', '完成第二关。'),
  def('C', '第三步', '完成第三关。'),
  def('D', '收集狂', '集齐全部收集品。'),
  def('E', '第四步', '完成第四关。'),
  def('F', '收集控', '集齐隐藏收集品。'),
];
const ADDITIONS = [{ apiName: 'E', def: DEFS[4] }, { apiName: 'F', def: DEFS[5] }];

/** What the model writes for the two new entries */
const FOUND = new Map([
  ['E', ['- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。']],
  ['F', ['- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。', '  - [ ] 东边的洞穴']],
]);

/** Entries tight, a blank line before each heading — the shape a generated guide has */
const TIGHT = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿。',
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

/** The same guide with a blank line between entries, the way a hand-kept one often reads */
const SPACED = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿。',
  '',
  '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
  '',
  '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
  '',
  '## 收集',
  '',
  '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
  '',
].join('\n');

const lines = (s) => s.split('\n');

/**
 * "Nothing else moved", as a property rather than a comparison of two strings: every line of the
 * original is still there, in its order, and every line that is not one of them is a line that was
 * inserted or a blank separator. Returns the first line that breaks either half, or null.
 */
function onlyInsertions(before, after, inserted) {
  const split = (t) => t.split(/\r?\n/);
  const orig = split(before);
  const added = new Set(inserted.flat());
  let at = 0;
  const extra = [];
  for (const line of split(after)) {
    if (at < orig.length && line === orig[at]) at++;
    else extra.push(line);
  }
  if (at !== orig.length) return `the original line ${at} (${JSON.stringify(orig[at])}) is gone or moved`;
  const stray = extra.find((l) => l !== '' && !added.has(l));
  return stray === undefined ? null : `a line that is neither original nor inserted: ${JSON.stringify(stray)}`;
}

// ---------------------------------------------------------------------------

describe('the heading for entries no section fits', () => {
  test('it follows the guide’s language and is picked from the table, not composed', () => {
    assert.equal(fallbackHeading('zh'), FALLBACK_HEADING[0]);
    assert.equal(fallbackHeading('en'), FALLBACK_HEADING[1]);
    assert.equal(fallbackHeading('anything else'), FALLBACK_HEADING[0], 'an unknown language is the default one');
  });

  test('it carries no count, which the linter would flag in a heading', () => {
    for (const h of FALLBACK_HEADING) assert.doesNotMatch(h, /\d/);
  });

  test('each half is in its own language — the English heading is never Chinese', () => {
    assert.match(FALLBACK_HEADING[0], /[一-鿿]/);
    assert.doesNotMatch(FALLBACK_HEADING[1], /[一-鿿]/);
  });
});

describe('local sections — where a section ends', () => {
  test('each section holding an entry is a candidate, with its path and the line its content ends on', () => {
    const s = localSections(TIGHT, DEFS);
    assert.equal(s.length, 2);
    assert.deepEqual(s.map((x) => [x.index, x.title, x.level, x.path, x.apiNames]), [
      [0, '主线', 2, [], ['A', 'B', 'C']],
      [1, '收集', 2, [], ['D']],
    ]);
    const l = lines(TIGHT);
    assert.equal(l[s[0].anchor.line], '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。');
    assert.equal(l[s[1].anchor.line], '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。');
  });

  test('a section ends after its last entry’s sub-steps, not before them', () => {
    const md = TIGHT.replace(
      '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
      '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。\n  - [ ] 先存档'
    );
    const s = localSections(md, DEFS);
    assert.equal(lines(md)[s[0].anchor.line], '  - [ ] 先存档');
  });

  test('whatever follows the last entry belongs to the section: the new entry goes after it, so nothing is split from what it follows', () => {
    const md = [
      '## 主线', '',
      '- [ ] **第一步**<br>完成第一关。',
      '<details><summary>全结局对照</summary>',
      '结局一 / 结局二',
      '</details>',
      '',
      '## 收集', '',
      '- [ ] **收集狂**<br>集齐全部收集品。',
    ].join('\n');
    const s = localSections(md, DEFS);
    assert.equal(lines(md)[s[0].anchor.line], '</details>');
  });

  test('blank lines after the content are not part of it', () => {
    const md = '## 主线\n\n- [ ] **第一步**<br>完成第一关。\n\n\n\n## 收集\n\n- [ ] **收集狂**<br>集齐全部收集品。\n';
    const s = localSections(md, DEFS);
    assert.equal(lines(md)[s[0].anchor.line], '- [ ] **第一步**<br>完成第一关。');
  });

  test('the last section ends on its last non-blank line, whatever trails the file', () => {
    const md = '## 主线\n\n- [ ] **第一步**<br>完成第一关。\n\n\n';
    const s = localSections(md, DEFS);
    assert.equal(s[0].anchor.line, 2);
  });

  test('a section with subsections of its own entries gives each its own anchor', () => {
    const md = [
      '## 玩法', '',
      '### 主线', '',
      '- [ ] **第一步**<br>完成第一关。', '',
      '### 收集', '',
      '- [ ] **收集狂**<br>集齐全部收集品。',
    ].join('\n');
    const s = localSections(md, DEFS);
    assert.deepEqual(s.map((x) => [x.title, x.path]), [['主线', ['玩法']], ['收集', ['玩法']]]);
  });

  test('a section with no attributable entry is not offered', () => {
    const md = '## 机制速查\n\n一段说明。\n\n## 主线\n\n- [ ] **第一步**<br>完成第一关。\n';
    assert.deepEqual(localSections(md, DEFS).map((x) => x.title), ['主线']);
  });

  test('a guide with no headings has no candidate section', () => {
    assert.deepEqual(localSections('- [ ] **第一步**<br>完成第一关。\n', DEFS), []);
  });
});

// A page as `fetchAllBlocks` returns it: top-level blocks, children inlined
const PAGE = 'page-1';
const rt = (s) => [{ type: 'text', text: { content: s }, plain_text: s }];
const onPage = { type: 'page_id', page_id: PAGE };
const H = (id, text, level = 2) => ({ id, type: `heading_${level}`, parent: onPage, [`heading_${level}`]: { rich_text: rt(text) } });
const T = (id, text, { parent = onPage, children = [] } = {}) => ({
  id, type: 'to_do', parent, has_children: children.length > 0, to_do: { rich_text: rt(text), checked: false }, children,
});
const P = (id, text) => ({ id, type: 'paragraph', parent: onPage, paragraph: { rich_text: rt(text) } });
const TG = (id, children) => ({ id, type: 'toggle', parent: onPage, has_children: true, toggle: { rich_text: rt('折叠') }, children });
const ENTRY = (n) => `**${n}**<br>`;

describe('Notion sections — where a section ends', () => {
  const blocks = [
    H('h1', '主线'),
    T('a', '**第一步**<br>完成第一关。'),
    T('b', '**第二步**<br>完成第二关。', { children: [T('b1', '拿到钥匙', { parent: { type: 'block_id', block_id: 'b' } })] }),
    H('h2', '收集'),
    T('d', '**收集狂**<br>集齐全部收集品。'),
    P('p1', '收集品清单见下面的 BV 号'),
  ];

  test('a section ends on the last block before the next heading', () => {
    const s = notionSections(blocks, DEFS, PAGE);
    assert.deepEqual(s.map((x) => [x.title, x.anchor]), [
      ['主线', { id: 'b', parentId: PAGE }],
      ['收集', { id: 'p1', parentId: PAGE }],
    ]);
  });

  test('a block pasted beside the last entry stays beside it: the new entry goes after both', () => {
    const withImage = [
      H('h1', '主线'),
      T('a', '**第一步**<br>完成第一关。'),
      { id: 'img', type: 'image', parent: onPage, image: {} },
      H('h2', '收集'),
      T('d', '**收集狂**<br>集齐全部收集品。'),
    ];
    assert.equal(notionSections(withImage, DEFS, PAGE)[0].anchor.id, 'img');
  });

  test('entries inside a container are anchored inside it, on the entry itself', () => {
    const inToggle = [
      H('h1', '主线'),
      TG('tg', [T('x1', '**第一步**<br>完成第一关。', { parent: { type: 'block_id', block_id: 'tg' } })]),
    ];
    assert.deepEqual(notionSections(inToggle, DEFS, PAGE)[0].anchor, { id: 'x1', parentId: 'tg' });
  });

  test('a block read with no parent field is taken to sit on the page', () => {
    const bare = [H('h1', '主线'), { ...T('a', '**第一步**<br>完成第一关。'), parent: undefined }];
    assert.deepEqual(notionSections(bare, DEFS, PAGE)[0].anchor, { id: 'a', parentId: PAGE });
  });

  test('the same sections come out of the page as out of the text, in the same order', () => {
    const fromPage = notionSections(blocks, DEFS, PAGE).map((x) => [x.title, x.apiNames]);
    const fromText = localSections(TIGHT, DEFS).map((x) => [x.title, x.apiNames]);
    assert.deepEqual(fromPage.map((x) => x[0]), fromText.map((x) => x[0]));
  });
});

// ---------------------------------------------------------------------------
// Asking where each one goes
// ---------------------------------------------------------------------------

describe('the placement prompt', () => {
  const sections = localSections(TIGHT, DEFS);
  const items = ADDITIONS.map((a) => ({ ...a, text: FOUND.get(a.apiName).join('\n') }));

  test('every section is offered by number with its title, and says what it already holds', () => {
    const p = buildPlacementPrompt({ game: '测试游戏', items, sections, defs: DEFS, lang: 'zh' });
    assert.match(p, /1\. 主线/);
    assert.match(p, /2\. 收集/);
    assert.match(p, /第一步/, 'the entries a section holds are what the model judges by');
    assert.match(p, /收集狂/);
  });

  test('every new entry is offered by number with its name and description', () => {
    const p = buildPlacementPrompt({ game: '测试游戏', items, sections, defs: DEFS, lang: 'zh' });
    assert.match(p, /1\. \*\*第四步\*\*/);
    assert.match(p, /集齐隐藏收集品/);
  });

  test('what the model wrote about an entry is shown back to it — the research is what makes the pass better than filing by name', () => {
    const p = buildPlacementPrompt({ game: '测试游戏', items, sections, defs: DEFS, lang: 'zh' });
    assert.match(p, /1\. \*\*第四步\*\* — 完成第四关。\n {3}写的是: 新关卡,先过前三关。/);
    assert.doesNotMatch(p, /写的是: \*\*/, 'the name and the description it already has are not repeated as a note');
  });

  test('an entry with nothing written beyond its name and description has no note line', () => {
    const bare = [{ ...ADDITIONS[0], text: '**第四步**<br>完成第四关。' }];
    const p = buildPlacementPrompt({ game: '测试游戏', items: bare, sections, defs: DEFS, lang: 'zh' });
    assert.doesNotMatch(p, /写的是/);
  });

  test('a section holding one entry is not told "1 entries"', () => {
    const p = buildPlacementPrompt({
      game: 'Game', items: [{ apiName: 'E', def: def('E', '', 'd', 'Fourth', 'Fourth level.'), text: '' }],
      sections: [{ index: 0, title: 'Main', path: [], level: 2, apiNames: ['A'], anchor: { line: 1 } }],
      defs: [def('A', '', 'a', 'First', 'First level.')], lang: 'en',
    });
    assert.match(p, /Main — 1 entry: First/);
  });

  test('it says plainly that sections are not to be invented, and what answering 0 does', () => {
    const p = buildPlacementPrompt({ game: '测试游戏', items, sections, defs: DEFS, lang: 'zh' });
    assert.match(p, /不要新开/);
    assert.match(p, /0/);
  });

  test('a nested section is told apart from one of the same title elsewhere by its path', () => {
    const nested = [
      { index: 0, title: '角色通关', path: ['经典'], level: 3, apiNames: ['A'], anchor: { line: 1 } },
      { index: 1, title: '角色通关', path: ['无尽'], level: 3, apiNames: ['D'], anchor: { line: 4 } },
    ];
    const p = buildPlacementPrompt({ game: '测试游戏', items, sections: nested, defs: DEFS, lang: 'zh' });
    assert.match(p, /经典 › 角色通关/);
    assert.match(p, /无尽 › 角色通关/);
  });

  test('a long section is summarised by a few names and a count, not listed whole', () => {
    const many = DEFS.concat(Array.from({ length: 30 }, (_, i) => def(`Z${i}`, `额外${i}`, `额外描述${i}。`)));
    const big = [{ index: 0, title: '主线', path: [], level: 2, apiNames: many.map((d) => d.api_name), anchor: { line: 1 } }];
    const p = buildPlacementPrompt({ game: '测试游戏', items, sections: big, defs: many, lang: 'zh' });
    assert.match(p, /共 36 条/);
    assert.doesNotMatch(p, /额外29/);
  });

  test('the system prompt and the message are in the guide’s language, and differ between languages', () => {
    for (const lang of ['zh', 'en']) {
      assert.ok(placementSystemFor(lang).length > 20);
    }
    assert.notEqual(placementSystemFor('zh'), placementSystemFor('en'));
  });
});

describe('reading the placement reply', () => {
  const sections = localSections(TIGHT, DEFS);
  const items = ADDITIONS.map((a) => ({ ...a, text: '' }));
  const read = (text) => parsePlacementReply(text, { items, sections });
  const parse = (text) => read(text).placed;

  test('each line maps an entry number to a section number', () => {
    assert.deepEqual([...parse('1 -> 2\n2 -> 1')], [['E', 1], ['F', 0]]);
  });

  test('"nothing fits" is an answer, and is told apart from no answer at all', () => {
    assert.deepEqual(read('1 -> 0\n2 -> 0').none, ['E', 'F']);
    assert.equal(read('1 -> 0\n2 -> 0').answered, 2);
    assert.equal(read('抱歉,我不确定。').answered, 0);
    assert.equal(read('9 -> 1').answered, 0, 'an answer about an entry that does not exist says nothing');
    assert.equal(read('1 -> 7').answered, 0, 'neither does one naming a section that does not exist');
  });

  test('the separators a model uses instead of the arrow all read the same', () => {
    for (const sep of ['->', '→', ':', '：', '=', '=>']) {
      assert.deepEqual([...parse(`1 ${sep} 2`)], [['E', 1]], `separator ${sep}`);
    }
  });

  test('a code fence and a list bullet around the lines do no harm', () => {
    assert.deepEqual([...parse('```\n- 1 -> 1\n- 2 -> 2\n```')], [['E', 0], ['F', 1]]);
  });

  test('0 means no section fits, and the entry is left out of the mapping', () => {
    assert.deepEqual([...parse('1 -> 0\n2 -> 2')], [['F', 1]]);
  });

  test('a number with no entry, or a section that does not exist, is ignored rather than guessed at', () => {
    assert.deepEqual([...parse('9 -> 1\n1 -> 7\n2 -> 2')], [['F', 1]]);
  });

  test('an entry answered twice keeps its first answer', () => {
    assert.deepEqual([...parse('1 -> 1\n1 -> 2')], [['E', 0]]);
  });

  test('prose around the answer is not an answer', () => {
    assert.deepEqual([...parse('好的,下面是结果:\n1 -> 1\n以上。')], [['E', 0]]);
    assert.equal(parse('抱歉,我无法完成这个请求。').size, 0);
  });
});

// A provider that answers by a script, recording what it was asked
const reply = (text, extra = {}) => ({
  content: [{ type: 'text', text }], text, stopReason: 'end_turn', stopDetails: null,
  usage: { inputTokens: 3, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, webSearches: 0, requests: 1 },
  model: 'plan', continuations: 0, toolErrors: [], searchQueries: [], ...extra,
});
function scripted(answers) {
  const p = {
    asked: [],
    async send({ system, messages, tools, effort, signal }) {
      p.asked.push({ system, messages: messages.map((m) => ({ ...m })), tools, effort, signal });
      const a = answers[p.asked.length - 1];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error('scripted provider ran out of answers');
      return typeof a === 'string' ? reply(a) : a;
    },
  };
  return p;
}

describe('placeAdditions', () => {
  const sections = localSections(TIGHT, DEFS);
  const items = ADDITIONS.map((a) => ({ ...a, text: FOUND.get(a.apiName).join('\n') }));
  const run = (provider, over = {}) => placeAdditions({
    provider, game: '测试游戏', lang: 'zh', items, sections, defs: DEFS, signal: undefined, onProgress: () => {}, ...over,
  });

  test('a usable reply places the entries, at the aside depth, with no tools', async () => {
    const p = scripted(['1 -> 1\n2 -> 2']);
    const r = await run(p);
    assert.deepEqual([...r.placement], [['E', 0], ['F', 1]]);
    assert.deepEqual(r.fallback, []);
    assert.equal(r.reason, null);
    assert.equal(p.asked.length, 1);
    assert.equal(p.asked[0].effort, ASIDE_EFFORT, 'it decides nothing about content, and a run at full depth spends its budget thinking');
    assert.ok(!p.asked[0].tools?.length, 'the guide is written; this pass only files');
    assert.equal(p.asked[0].system, placementSystemFor('zh'));
  });

  test('what it cost is reported, so the run’s total is honest', async () => {
    const r = await run(scripted(['1 -> 1\n2 -> 2']));
    assert.equal(r.usage.outputTokens, 2);
  });

  test('a reply nothing can be read from is asked once more, in a session of its own', async () => {
    const p = scripted(['抱歉,我不确定。', '1 -> 1\n2 -> 2']);
    const events = [];
    const r = await run(p, { onProgress: (e) => events.push(e.phase) });
    assert.equal(p.asked.length, REGROUP_ATTEMPTS);
    assert.equal(p.asked[1].messages.length, 1, 'the rejected answer must not sit in the second attempt’s context');
    assert.deepEqual([...r.placement], [['E', 0], ['F', 1]]);
    assert.ok(events.includes('place-retry'));
  });

  test('when every attempt fails the entries go to the end, and the reason is carried out', async () => {
    const events = [];
    const r = await run(scripted(['乱七八糟', '还是乱七八糟']), { onProgress: (e) => events.push(e) });
    assert.deepEqual([...r.placement], []);
    assert.deepEqual(r.fallback, ['E', 'F']);
    assert.ok(r.reason, 'a degradation that does not say why cannot be diagnosed afterwards');
    assert.ok(events.some((e) => e.phase === 'place-failed' && e.reason));
  });

  test('a refusal is not a placement, and is retried like any other failure', async () => {
    const p = scripted([reply('', { stopReason: 'refusal' }), '1 -> 1\n2 -> 2']);
    const r = await run(p);
    assert.deepEqual([...r.placement], [['E', 0], ['F', 1]]);
  });

  test('a partial answer places what it answered and sends the rest to the end, without asking again', async () => {
    const p = scripted(['1 -> 1']);
    const r = await run(p);
    assert.deepEqual([...r.placement], [['E', 0]]);
    assert.deepEqual(r.fallback, ['F']);
    assert.equal(r.reason, null, 'nothing failed; one entry fitted no section');
    assert.equal(p.asked.length, 1);
  });

  test('an entry answered 0 is sent to the end', async () => {
    const r = await run(scripted(['1 -> 1\n2 -> 0']));
    assert.deepEqual(r.fallback, ['F']);
  });

  test('"none of them fits" is a complete answer, not a failure to retry', async () => {
    const p = scripted(['1 -> 0\n2 -> 0']);
    const r = await run(p);
    assert.equal(p.asked.length, 1);
    assert.deepEqual(r.fallback, ['E', 'F']);
    assert.equal(r.reason, null);
  });

  test('a cancellation is not retried and not swallowed', async () => {
    const cancelled = Object.assign(new Error('cancelled'), { cancelled: true });
    const p = scripted([cancelled, '1 -> 1\n2 -> 2']);
    await assert.rejects(() => run(p), (e) => e.cancelled === true);
    assert.equal(p.asked.length, 1, 'asking again is the opposite of what a Cancel click means');
  });

  test('with no section to file under nothing is asked, and everything goes to the end', async () => {
    const p = scripted([]);
    const r = await run(p, { sections: [] });
    assert.equal(p.asked.length, 0);
    assert.deepEqual(r.fallback, ['E', 'F']);
    assert.equal(r.reason, null);
  });

  test('with nothing to place nothing is asked', async () => {
    const p = scripted([]);
    const r = await run(p, { items: [] });
    assert.equal(p.asked.length, 0);
    assert.deepEqual(r.fallback, []);
  });

  test('the signal reaches the request, so Cancel can stop it', async () => {
    const ctl = new AbortController();
    const p = scripted(['1 -> 1\n2 -> 2']);
    await run(p, { signal: ctl.signal });
    assert.equal(p.asked[0].signal, ctl.signal);
  });
});

// ---------------------------------------------------------------------------
// From placements to groups
// ---------------------------------------------------------------------------

describe('planInsertions', () => {
  const sections = localSections(TIGHT, DEFS);

  test('entries go to the section they were placed in, in the order of the guide’s achievement list', () => {
    const p = planInsertions({ sections, additions: ADDITIONS, placement: new Map([['F', 1], ['E', 0]]), lang: 'zh' });
    assert.deepEqual(p.groups.map((g) => [g.section.index, g.apiNames]), [[0, ['E']], [1, ['F']]]);
    assert.equal(p.tail, null);
  });

  test('two entries in one section keep the order of the achievement list, however they were answered', () => {
    const p = planInsertions({ sections, additions: ADDITIONS, placement: new Map([['F', 0], ['E', 0]]), lang: 'zh' });
    assert.deepEqual(p.groups[0].apiNames, ['E', 'F']);
  });

  test('entries nobody placed form a new section at the end, headed in the guide’s language', () => {
    const zh = planInsertions({ sections, additions: ADDITIONS, placement: new Map([['E', 0]]), lang: 'zh' });
    assert.deepEqual(zh.tail, { title: FALLBACK_HEADING[0], apiNames: ['F'] });
    const en = planInsertions({ sections, additions: ADDITIONS, placement: new Map(), lang: 'en' });
    assert.deepEqual(en.tail, { title: FALLBACK_HEADING[1], apiNames: ['E', 'F'] });
  });

  test('a section made for them by an earlier run is used again rather than headed a second time', () => {
    const had = [...sections, { index: 2, title: FALLBACK_HEADING[0], path: [], level: 2, apiNames: ['D'], anchor: { line: 20 } }];
    const p = planInsertions({ sections: had, additions: ADDITIONS, placement: new Map([['E', 0]]), lang: 'zh' });
    assert.equal(p.tail, null);
    assert.deepEqual(p.groups.map((g) => [g.section.index, g.apiNames]), [[0, ['E']], [2, ['F']]]);
  });

  test('a section made in the other language is recognised as theirs too', () => {
    const had = [{ index: 0, title: FALLBACK_HEADING[1], path: [], level: 2, apiNames: ['D'], anchor: { line: 3 } }];
    const p = planInsertions({ sections: had, additions: ADDITIONS, placement: new Map(), lang: 'zh' });
    assert.equal(p.tail, null);
    assert.deepEqual(p.groups[0].apiNames, ['E', 'F']);
  });

  test('an answer naming a section that does not exist is treated as no answer', () => {
    const p = planInsertions({ sections, additions: ADDITIONS, placement: new Map([['E', 9]]), lang: 'zh' });
    assert.deepEqual(p.tail.apiNames, ['E', 'F']);
  });
});

describe('verifyPlacement — reading back where each entry went', () => {
  const section = (index, title, path, apiNames) => ({ index, title, path, level: 2, apiNames, anchor: { line: index } });
  const plan = {
    groups: [{ section: section(0, '主线', [], []), apiNames: ['E'] }, { section: section(1, '收集', ['玩法'], []), apiNames: ['F'] }],
    tail: null,
  };

  test('every entry in the section it was meant for is nothing to report', () => {
    const landed = [section(0, '主线', [], ['A', 'E']), section(1, '收集', ['玩法'], ['D', 'F'])];
    assert.deepEqual(verifyPlacement({ sections: landed, plan }), []);
  });

  test('an entry under another heading is reported with where it was meant to be and where it is', () => {
    const landed = [section(0, '主线', [], ['A']), section(1, '收集', ['玩法'], ['D', 'F', 'E'])];
    assert.deepEqual(verifyPlacement({ sections: landed, plan }), [
      { apiName: 'E', wanted: '主线', got: '玩法 › 收集' },
    ]);
  });

  test('an entry no section holds is reported as nowhere', () => {
    const landed = [section(0, '主线', [], ['A', 'E'])];
    assert.deepEqual(verifyPlacement({ sections: landed, plan }), [
      { apiName: 'F', wanted: '玩法 › 收集', got: null },
    ]);
  });

  test('two sections of one title are told apart by the headings above them', () => {
    const twin = { groups: [{ section: section(0, '角色通关', ['经典'], []), apiNames: ['E'] }], tail: null };
    const wrongParent = [section(0, '角色通关', ['无尽'], ['E'])];
    assert.equal(verifyPlacement({ sections: wrongParent, plan: twin }).length, 1);
    const rightParent = [section(0, '角色通关', ['经典'], ['E'])];
    assert.deepEqual(verifyPlacement({ sections: rightParent, plan: twin }), []);
  });

  test('a title is compared the way the linter compares titles — case and spacing do not make a section another', () => {
    const p = { groups: [{ section: section(0, 'Main Story', [], []), apiNames: ['E'] }], tail: null };
    assert.deepEqual(verifyPlacement({ sections: [section(0, 'main  story', [], ['E'])], plan: p }), []);
  });

  test('entries sent to the section at the end are looked for there', () => {
    const p = { groups: [], tail: { title: FALLBACK_HEADING[0], apiNames: ['E'] } };
    assert.deepEqual(verifyPlacement({ sections: [section(0, FALLBACK_HEADING[0], [], ['E'])], plan: p }), []);
    assert.equal(verifyPlacement({ sections: [section(0, '主线', [], ['E'])], plan: p }).length, 1);
  });
});

describe('splicing new entries into a local guide', () => {
  const place = (text, placement, over = {}) => {
    const sections = localSections(text, DEFS);
    const plan = planInsertions({ sections, additions: ADDITIONS, placement, lang: 'zh' });
    const edits = localInsertEdits({ text, sections, plan, found: FOUND, ...over });
    return { out: spliceLines(text, edits), edits };
  };
  const inserted = [...FOUND.values()];

  test('a tight guide gets tight entries, directly after what the section held', () => {
    const { out } = place(TIGHT, new Map([['E', 0], ['F', 1]]));
    assert.equal(out, [
      '# 测试游戏',
      'appid: 1',
      '',
      '## 主线',
      '',
      '- [x] **第一步**<br>完成第一关。<br>开局就能拿。',
      '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
      '  - [x] 打完第一个 Boss',
      '  - [ ] 拿到钥匙',
      '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '',
      '## 收集',
      '',
      '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  - [ ] 东边的洞穴',
      '',
    ].join('\n'));
  });

  test('a guide that separates its entries by blank lines gets them that way', () => {
    const { out } = place(SPACED, new Map([['E', 0], ['F', 0]]));
    assert.ok(out.includes([
      '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
      '',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  - [ ] 东边的洞穴',
      '',
      '## 收集',
    ].join('\n')), out);
  });

  test('everything outside the inserted lines is the original, in its order', () => {
    for (const md of [TIGHT, SPACED]) {
      const { out } = place(md, new Map([['E', 0], ['F', 1]]));
      assert.equal(onlyInsertions(md, out, inserted), null);
    }
  });

  test('the check above can fail: a changed original line is reported', () => {
    const { out } = place(TIGHT, new Map([['E', 0], ['F', 1]]));
    const damaged = out.replace('开局就能拿。', '开局就能拿!');
    assert.match(onlyInsertions(TIGHT, damaged, inserted), /gone or moved/);
  });

  test('a CRLF guide stays CRLF throughout', () => {
    const crlf = TIGHT.replace(/\n/g, '\r\n');
    const { out } = place(crlf, new Map([['E', 0], ['F', 1]]));
    assert.ok(out.includes('\r\n'));
    assert.ok(!/[^\r]\n/.test(out), 'no bare LF may be mixed in');
  });

  test('entries nobody placed become a new section at the end, with a blank line before it', () => {
    const { out } = place(TIGHT, new Map());
    assert.equal(out, TIGHT.replace(/\n$/, '') + [
      '',
      '',
      `## ${FALLBACK_HEADING[0]}`,
      '',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  - [ ] 东边的洞穴',
      '',
    ].join('\n'));
  });

  test('a guide that spaces its entries gets a new section at the end spaced the same way, with no blank line wasted after the heading', () => {
    const { out } = place(SPACED, new Map());
    assert.ok(out.endsWith([
      '',
      `## ${FALLBACK_HEADING[0]}`,
      '',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  - [ ] 东边的洞穴',
      '',
    ].join('\n')), out);
  });

  test('the file’s final newline is kept where it was, and not invented where it was absent', () => {
    const noFinal = TIGHT.replace(/\n$/, '');
    const { out } = place(noFinal, new Map());
    assert.ok(!out.endsWith('\n'));
    const { out: withFinal } = place(TIGHT, new Map());
    assert.ok(withFinal.endsWith('\n'));
  });

  test('entries for the last section and entries for a new section at the end land in that order', () => {
    const { out } = place(TIGHT, new Map([['E', 1]]));
    const l = lines(out);
    const at = (s) => l.findIndex((x) => x.includes(s));
    assert.ok(at('第四步') < at(FALLBACK_HEADING[0]), 'the placed entry comes first');
    assert.ok(at(FALLBACK_HEADING[0]) < at('收集控'));
    assert.equal(l.filter((x) => x.includes('第四步')).length, 1);
  });

  test('a guide with no section to place under still takes the new section', () => {
    const flat = '- [ ] **第一步**<br>完成第一关。\n';
    const sections = localSections(flat, DEFS);
    const plan = planInsertions({ sections, additions: ADDITIONS, placement: new Map(), lang: 'zh' });
    const out = spliceLines(flat, localInsertEdits({ text: flat, sections, plan, found: FOUND }));
    assert.ok(out.startsWith(flat.trimEnd()));
    assert.ok(out.includes(`## ${FALLBACK_HEADING[0]}`));
  });

  test('the edits are pure insertions: none of them removes a line', () => {
    const { edits } = place(TIGHT, new Map([['E', 0], ['F', 1]]));
    for (const e of edits) assert.equal(e.end, e.start - 1, 'an insertion replaces an empty range');
  });

  test('two insertions at one position are one edit, so their order cannot depend on how the splice sorts', () => {
    const { edits } = place(TIGHT, new Map([['E', 1]]));
    const starts = edits.map((e) => e.start);
    assert.equal(new Set(starts).size, starts.length);
  });
});
