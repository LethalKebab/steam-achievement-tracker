import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToBlocks, toRichText, chunkBlocks, splitDeepChildren, blockDepth, partitionForOverwrite, carriesPointer, sectionIntros, keepIntro } from '../lib/notionblocks.js';
import { richTextToPlain, NotionClient } from '../lib/notion.js';

/** Join rich_text back into plain text — the same function the sync uses when reading Notion */
const plain = (rt) => richTextToPlain(rt.map((r) => ({ plain_text: r.text.content })));

test('## becomes heading_2, and the level-one heading is dropped', () => {
  const { blocks } = markdownToBlocks('# 游戏名\n\n## 一、入门\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'heading_2');
  assert.equal(plain(blocks[0].heading_2.rich_text), '一、入门');
});

test('the appid line has to be a paragraph — extractAppIdFromPageContent reads only paragraphs', () => {
  const { blocks } = markdownToBlocks('# 游戏名\nappid: 926340\n');
  assert.equal(blocks[0].type, 'paragraph');
  assert.match(plain(blocks[0].paragraph.rich_text), /^appid: 926340$/);
});

test('an achievement line: a bold name plus <br> becomes a newline inside the block, not three blocks', () => {
  const { blocks } = markdownToBlocks('- [ ] **初次见面**<br>完成序章<br>跟着提示走就行');
  assert.equal(blocks.length, 1, 'splitting on <br> breaks the reverse lookup in audit');
  const rt = blocks[0].to_do.rich_text;
  assert.equal(blocks[0].to_do.checked, false);
  assert.equal(rt[0].text.content, '初次见面');
  assert.equal(rt[0].annotations.bold, true);
  assert.equal(rt[1].annotations.bold, false);
  assert.equal(plain(rt), '初次见面\n完成序章\n跟着提示走就行');
});

test('- [x] reads as checked', () => {
  const { blocks } = markdownToBlocks('- [x] **已完成**\n- [X] **大写也算**');
  assert.deepEqual(
    blocks.map((b) => b.to_do.checked),
    [true, true]
  );
});

test('an indented sub-step hangs under the previous top-level achievement and takes no top-level slot', () => {
  const md = ['- [ ] **主成就**', '  - [ ] 第一步', '  - [ ] 第二步', '- [ ] **下一个成就**'].join(
    '\n'
  );
  const { blocks } = markdownToBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].to_do.children.length, 2);
  assert.equal(plain(blocks[0].to_do.children[0].to_do.rich_text), '第一步');
  assert.equal(blocks[1].to_do.children, undefined);
});

test('a section heading severs the parent link, so an indented item after it does not hang off the previous section achievement', () => {
  const md = ['- [ ] **上一节的成就**', '## 二、后期', '  - [ ] 孤儿子步骤'].join('\n');
  const { blocks } = markdownToBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].to_do.children, undefined);
  assert.equal(blocks[2].type, 'to_do', 'with nothing to hang off it falls back to top level rather than being lost');
});

test('an unrecognised line degrades to a paragraph, keeping the content and reporting it', () => {
  // `### 三级标题` is **no longer** in this class — it now really converts to heading_3 (see the
  // group of tests below). What is left here is genuinely unrecognisable: Notion has no block
  // type corresponding to an HTML collapsible
  const md = '<details><summary>展开</summary>\n普通一行\n';
  const { blocks, unconverted } = markdownToBlocks(md);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.type === 'paragraph'));
  assert.match(plain(blocks[0].paragraph.rich_text), /details/);
  assert.equal(unconverted.length, 1, 'losing the formatting means telling the user which lines');
  assert.match(unconverted[0], /details/);
});

test('CRLF and trailing spaces do not affect parsing', () => {
  const { blocks } = markdownToBlocks('## 一、入门  \r\n- [ ] **成就**  \r\n');
  assert.equal(blocks.length, 2);
  assert.equal(plain(blocks[0].heading_2.rich_text), '一、入门');
  assert.equal(plain(blocks[1].to_do.rich_text), '成就');
});

test('a blank line produces no empty block', () => {
  const { blocks } = markdownToBlocks('\n\n## 标题\n\n\n- [ ] a\n\n');
  assert.equal(blocks.length, 2);
});

test('very long text is split into several runs, staying under Notion 2000 limit', () => {
  const runs = toRichText('x'.repeat(5000));
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.text.content.length <= 2000));
  assert.equal(plain(runs).length, 5000);
});

test('a stray ** does not turn everything after it bold and lose it', () => {
  const runs = toRichText('**没闭合的粗体');
  assert.equal(plain(runs), '没闭合的粗体');
});

test('chunkBlocks splits at 100', () => {
  const chunks = chunkBlocks(Array.from({ length: 250 }, (_, i) => i));
  assert.deepEqual(
    chunks.map((c) => c.length),
    [100, 100, 50]
  );
});

// ---------------------------------------------------------------------------
// The next two groups were added for "move a local guide into Notion": two block kinds that
// really appear in hand-written guides. A generated guide never uses them, but one the user
// wrote does — and degrading these to paragraphs loses what they wrote down themselves
// ---------------------------------------------------------------------------

test('an ordinary bullet becomes a bulleted_list_item, not a paragraph', () => {
  const { blocks } = markdownToBlocks('- **模式**:用标准模式开新档\n- 第二条');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['bulleted_list_item', 'bulleted_list_item']
  );
  assert.equal(blocks[0].bulleted_list_item.rich_text[0].annotations.bold, true);
});

test('`- [ ]` is not taken as an ordinary bullet — the checkbox wins', () => {
  const { blocks } = markdownToBlocks('- [ ] **成就**<br>描述');
  assert.equal(blocks[0].type, 'to_do');
});

test('a markdown table becomes a table block, and the separator row is not a data row', () => {
  const md = [
    '| 章节 | 犯罪手法 | 嫌疑人 |',
    '| --- | --- | --- |',
    '| 序章 | 41627 | 两个都是 |',
    '| 第一章 | 35624 | 肖恩 |',
  ].join('\n');
  const { blocks } = markdownToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'table');
  assert.equal(blocks[0].table.table_width, 3);
  assert.equal(blocks[0].table.has_column_header, true);
  assert.equal(blocks[0].table.children.length, 3, 'the separator row should not become a data row');
  assert.equal(plain(blocks[0].table.children[1].table_row.cells[1]), '41627');
});

test('a table with uneven row widths is padded to one width — Notion refuses uneven ones', () => {
  const { blocks } = markdownToBlocks('| a | b | c |\n| --- | --- | --- |\n| 只有一格 |');
  const rows = blocks[0].table.children;
  assert.ok(rows.every((r) => r.table_row.cells.length === 3));
  assert.equal(plain(rows[1].table_row.cells[2]), '');
});

test('ordinary lines after a table parse as usual, and a table at end of file is not missed', () => {
  const { blocks } = markdownToBlocks('| a |\n| --- |\n| b |\n\n## 后面还有\n\n| c |\n| --- |');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['table', 'heading_2', 'table']
  );
});

// ---------------------------------------------------------------------------
// The underline on a mutual-exclusion note
// ---------------------------------------------------------------------------
// Hit on 2026-08-11: `<span underline="true">…</span>` is the fixed form required by SKILL.md
// rule 3.1, and it used to land in the body verbatim — what Notion showed was the tag itself
// rather than an underline. The moved page had 9 of these, inconsistent with the hundred-plus
// pages the user wrote by hand.
// It is the same class of thing as `**`: markup, not prose, so three places have to change
// together — the converter produces the annotation, and both text normalisations (the fidelity
// check and achievement matching) have to strip the tag, or the two backends can never compare
// equal.

test('a mutual-exclusion note becomes an underline annotation, and the tag itself stays out of the body', () => {
  const rt = toRichText('选了这个。<span underline="true">如果选另一个则无法获得本成就。</span>');
  assert.ok(!plain(rt).includes('<span'), 'the tag should not appear in the body');
  assert.ok(!plain(rt).includes('</span>'));
  assert.equal(plain(rt), '选了这个。如果选另一个则无法获得本成就。');

  const underlined = rt.filter((r) => r.annotations.underline);
  assert.equal(underlined.length, 1);
  assert.equal(underlined[0].text.content, '如果选另一个则无法获得本成就。');
  assert.equal(rt.find((r) => r.text.content === '选了这个。').annotations.underline, false);
});

test('bold and underline do not interfere — the achievement name is still bold', () => {
  const rt = toRichText('**成就名**<br>描述<br>心得。<span underline="true">互斥警告。</span>');
  const bold = rt.filter((r) => r.annotations.bold);
  assert.equal(bold.length, 1);
  assert.equal(bold[0].text.content, '成就名');
  assert.equal(bold[0].annotations.underline, false, 'the achievement name should not get underlined along with it');
  assert.equal(rt.filter((r) => r.annotations.underline).length, 1);
});

test('single quotes and any casing are recognised', () => {
  assert.equal(toRichText("<span underline='true'>甲</span>").filter((r) => r.annotations.underline).length, 1);
  assert.equal(toRichText('<SPAN UNDERLINE="TRUE">甲</SPAN>').filter((r) => r.annotations.underline).length, 1);
});

test('two notes on one line both get underlined', () => {
  const rt = toRichText('<span underline="true">甲</span>中间<span underline="true">乙</span>');
  assert.deepEqual(
    rt.filter((r) => r.annotations.underline).map((r) => r.text.content),
    ['甲', '乙']
  );
  assert.equal(plain(rt), '甲中间乙');
});

test('with no note, underline is false throughout and never left undefined', () => {
  for (const r of toRichText('**名字**<br>普通描述')) {
    assert.equal(r.annotations.underline, false);
  }
});

// ---------------------------------------------------------------------------
// Every heading level
// ---------------------------------------------------------------------------
// Hit on 2026-08-11: the converter understood only `##` while the model wrote `###` throughout,
// so all seven section headings fell into the ordinary-paragraph branch and the page carried
// seven literal lines of `### 机制速查` with not one real heading. What `unconverted` reported
// was a "formatting degradation", which sounds minor.

test('### becomes heading_3, not literal text', () => {
  const { blocks, unconverted } = markdownToBlocks('### 机制速查\n正文\n');
  assert.equal(blocks[0].type, 'heading_3');
  assert.equal(plain(blocks[0].heading_3.rich_text), '机制速查');
  assert.deepEqual(unconverted, [], 'converted correctly, it should no longer report a formatting degradation');
});

test('#### and deeper collapse to heading_3 — Notion has only three levels', () => {
  const { blocks } = markdownToBlocks('#### 更深一层\n##### 再深\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_3', 'heading_3']);
});

test('## is still heading_2, and # is still dropped', () => {
  const { blocks } = markdownToBlocks('# 游戏名\n## 主线\n### 支线\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'heading_3']);
});

test('bold and underline inside a heading still take effect', () => {
  const { blocks } = markdownToBlocks('### **重点**小节\n');
  assert.equal(blocks[0].heading_3.rich_text.filter((r) => r.annotations.bold).length, 1);
});

test('hashes with no space after them are not a heading (the #1 case)', () => {
  const { blocks } = markdownToBlocks('#1 号目标\n');
  assert.equal(blocks[0].type, 'paragraph', '"#1 号" is prose, not a heading');
});

// ---------------------------------------------------------------------------
// The <details> collapsible
// ---------------------------------------------------------------------------

/**
 * **SKILL.md rule-5 requires long content to be collapsed with `<details><summary>`**, so a
 * model writing one is following the rules and what fails to recognise it is the converter. The
 * consequence of not recognising it is the same as understanding only `##` back then: it falls
 * into the ordinary-paragraph branch and the page is left with a literal
 * `<details><summary>…</summary>` line and a `</details>` line. Measured on one game (3641000),
 * it left 4 such blocks — the table went in and the shell became text.
 */
test('details becomes a toggle, and summary becomes its title', () => {
  const { blocks, unconverted } = markdownToBlocks(
    '<details><summary>16 个地点代码</summary>\n\n正文一行\n\n</details>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(richTextToPlain(blocks[0].toggle.rich_text.map((r) => ({ plain_text: r.text.content }))),
    '16 个地点代码');
  assert.equal(blocks[0].toggle.children.length, 1);
  assert.equal(blocks[0].toggle.children[0].type, 'paragraph');
  assert.deepEqual(unconverted, [], 'recognised correctly, it should no longer report a formatting degradation');
});

test('**a literal tag must never appear on the page again**', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n</details>'
  );
  const flat = JSON.stringify(blocks);
  assert.doesNotMatch(flat, /<details/i, 'the opening tag became prose');
  assert.doesNotMatch(flat, /<\/details/i, 'the closing tag became prose — one of the 4 blocks the measurement left behind');
  assert.doesNotMatch(flat, /<summary/i);
});

test('a summary on its own line is recognised too', () => {
  const { blocks } = markdownToBlocks('<details>\n<summary>各房间最早的一个场景代码</summary>\n\n正文\n\n</details>');
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(blocks[0].toggle.rich_text[0].text.content, '各房间最早的一个场景代码');
  assert.equal(blocks[0].toggle.children.length, 1, 'the summary line should not be left inside as body text');
});

test('a table fits inside a collapsible', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| 地点 | 代码 |\n| --- | --- |\n| 书房 | A1 |\n\n</details>'
  );
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(blocks[0].toggle.children[0].type, 'table');
  assert.equal(blocks[0].toggle.children[0].table.children.length, 2);
});

test('content outside the collapsible is unaffected and keeps its order', () => {
  const { blocks } = markdownToBlocks('## 标题\n\n<details><summary>x</summary>\n\n里面\n\n</details>\n\n外面');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'toggle', 'paragraph']);
  assert.equal(blocks[2].paragraph.rich_text[0].text.content, '外面');
});

test('a collapsible inside a collapsible: paired by counting depth, not by taking the first closing tag', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>外</summary>\n\n<details><summary>内</summary>\n\n里面\n\n</details>\n\n外层的尾巴\n\n</details>'
  );
  assert.equal(blocks.length, 1, 'the outer one was cut short by the inner closing tag');
  const kids = blocks[0].toggle.children;
  assert.equal(kids[0].type, 'toggle');
  assert.equal(kids[1].type, 'paragraph');
  assert.equal(kids[1].paragraph.rich_text[0].text.content, '外层的尾巴');
});

/**
 * **With no closing tag it must never run to end of file.** A truncated model response leaves
 * exactly one unclosed `<details>` — and that would sweep everything remaining in the document
 * into one collapsible, so the page looks like half of it went missing, with no error raised.
 * Falling back to the old behaviour (paragraph plus unconverted) is a **visible** degradation.
 */
test('with no closing tag it falls back to the old behaviour and does not swallow what follows', () => {
  const { blocks, unconverted } = markdownToBlocks('<details><summary>没关</summary>\n\n## 后面的小节\n\n正文');
  assert.equal(blocks[0].type, 'paragraph', 'an unclosed tag should not become a toggle');
  assert.ok(blocks.some((b) => b.type === 'heading_2'), 'the section that follows was swallowed by the collapsible');
  assert.equal(unconverted.length, 1, 'a degradation has to be reported');
});

test('a missing summary still gets a title — a toggle with an empty title is an invisible bar', () => {
  const { blocks } = markdownToBlocks('<details>\n\n正文\n\n</details>');
  assert.equal(blocks[0].type, 'toggle');
  assert.ok(blocks[0].toggle.rich_text[0].text.content.length > 0);
});

// ---------------------------------------------------------------------------
// Nesting depth: Notion accepts only two levels per request
// ---------------------------------------------------------------------------

test('blockDepth counts the levels of a block together with its descendants', () => {
  const leaf = { type: 'paragraph', paragraph: { rich_text: [] } };
  assert.equal(blockDepth(leaf), 1);
  const one = { type: 'toggle', toggle: { rich_text: [], children: [leaf] } };
  assert.equal(blockDepth(one), 2);
  assert.equal(blockDepth({ type: 'toggle', toggle: { rich_text: [], children: [one] } }), 3);
});

test('two levels or fewer pass through untouched', () => {
  const { blocks } = markdownToBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |');
  const { shallow, deferred } = splitDeepChildren(blocks);
  assert.deepEqual(deferred, [], 'table > table_row is exactly two levels and should not be split');
  assert.equal(shallow[0].table.children.length, 2);
});

test('**three levels have the whole batch of children lifted out**, kept for a second pass', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n</details>'
  );
  assert.equal(blockDepth(blocks[0]), 3, 'the premise has changed: a table inside a collapsible is three levels to begin with');
  const { shallow, deferred } = splitDeepChildren(blocks);
  assert.equal(shallow.length, 1);
  assert.equal(shallow[0].toggle.children, undefined, 'the children were not fully lifted, so the request is still three levels');
  assert.equal(shallow[0].toggle.rich_text[0].text.content, '表', 'the title has to stay in the first pass');
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].index, 0, 'index has to point back into shallow, which is how the caller gets the parent block id');
  assert.equal(deferred[0].children[0].type, 'table');
});

test('the **whole batch** is lifted, not only the too-deep one — leaving half behind reorders what the author wrote', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>x</summary>\n\n前面一句\n\n| a |\n| --- |\n| 1 |\n\n后面一句\n\n</details>'
  );
  const { deferred } = splitDeepChildren(blocks);
  assert.equal(deferred.length, 1);
  assert.deepEqual(deferred[0].children.map((b) => b.type), ['paragraph', 'table', 'paragraph']);
});

test('the original blocks are not modified in place — the caller may still need them', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a |\n| --- |\n| 1 |\n\n</details>'
  );
  splitDeepChildren(blocks);
  assert.ok(blocks[0].toggle.children, 'the original array was emptied in place');
});

// ---------------------------------------------------------------------------
// appendBlocks and its two passes
// ---------------------------------------------------------------------------

/** A fake client that records every request. `request` is the only place NotionClient touches the network */
function fakeClient() {
  const client = new NotionClient({ notion: { token: 't' } });
  const calls = [];
  let n = 0;
  client.request = async (method, path, payload) => {
    calls.push({ method, path, payload });
    return { results: (payload?.children ?? []).map(() => ({ id: `blk${++n}` })) };
  };
  return { client, calls };
}

test('**a table inside a collapsible has to be written in two passes** — one request carries only two levels', async () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>16 个地点代码</summary>\n\n| 地点 | 代码 |\n| --- | --- |\n| 书房 | A1 |\n\n</details>'
  );
  const { client, calls } = fakeClient();
  await client.appendBlocks('PAGE', blocks);

  assert.equal(calls.length, 2, `there should be two passes, there were ${calls.length}`);

  // First pass: the toggle itself, with no children
  assert.equal(calls[0].path, '/blocks/PAGE/children');
  assert.equal(calls[0].payload.children[0].type, 'toggle');
  assert.equal(calls[0].payload.children[0].toggle.children, undefined);
  assert.equal(blockDepth(calls[0].payload.children[0]), 1);

  // Second pass: filled into the toggle the first pass created
  assert.equal(calls[1].path, '/blocks/blk1/children', 'filled into a different block, the content ends up outside the page');
  assert.equal(calls[1].payload.children[0].type, 'table');
  // This pass must not exceed two levels either
  for (const b of calls[1].payload.children) {
    assert.ok(blockDepth(b) <= 2, `the second pass sent ${blockDepth(b)} levels again`);
  }
});

test('two levels or fewer is still one pass — do not send extra requests for nothing', async () => {
  const { blocks } = markdownToBlocks('## 标题\n\n- [ ] **成就**<br>说明');
  const { client, calls } = fakeClient();
  await client.appendBlocks('PAGE', blocks);
  assert.equal(calls.length, 1);
});

test('with no parent block id it raises, rather than leaving the collapsible quietly empty', async () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a |\n| --- |\n| 1 |\n\n</details>'
  );
  const client = new NotionClient({ notion: { token: 't' } });
  client.request = async () => ({ results: [] }); // Notion returned no new blocks
  await assert.rejects(() => client.appendBlocks('PAGE', blocks), /没能补上|半篇攻略/);
});

// The shape of a group label (prerequisite / step / caution): `- [ ] **成就**` with a few
// indented `<details>` beneath it. This is the shape guidegen's groupLabelRule **requires** the
// model to write when target='notion', so whether the converter recognises it is not a
// "supported while we are here" question — it is whether that rule can land at all.
test('an indented details hangs under the previous checkbox rather than becoming its sibling', () => {
  const md = [
    '- [ ] **创造**<br>你可以创造一切。',
    '\t<details>',
    '\t<summary>**前置** — 开局前先备齐</summary>',
    '\t- [ ] 拿到龙眼宝石',
    '\t- [ ] 玛希尔在队',
    '\t</details>',
    '\t<details>',
    '\t<summary>**注意** — 走岔就掉别的结局</summary>',
    '\t- 魔力熔炉别放人',
    '\t</details>',
    '- [ ] **知识**<br>收齐词条。',
  ].join('\n');
  const { blocks, unconverted } = markdownToBlocks(md);

  // Only two achievements at top level — a collapsible must not stand at top level
  assert.deepEqual(blocks.map((b) => b.type), ['to_do', 'to_do']);
  assert.deepEqual(unconverted, []);

  const kids = blocks[0].to_do.children;
  assert.deepEqual(kids.map((b) => b.type), ['toggle', 'toggle'],
    'both collapsibles following one achievement have to hang off it — the second must not fall back to top level');

  // **Sibling items inside a collapsible have to stay siblings.** Without the dedent the second
  // one hangs under the first, and ten prerequisites become ten levels of nesting.
  const pre = kids[0].toggle.children;
  assert.deepEqual(pre.map((b) => b.type), ['to_do', 'to_do'],
    'two sibling checkboxes inside the collapsible became nested');
  assert.equal(pre[1].to_do.children, undefined, 'the second one should not become a child of the first');

  // The 「注意」 group is ordinary bullets (a caution is not a task) and must not become to_do
  assert.deepEqual(kids[1].toggle.children.map((b) => b.type), ['bulleted_list_item']);
});

// A top-level collapsible (the long list from rule 五) must not have its behaviour changed by
// the rule above
test('a top-level details is still a top-level toggle', () => {
  const md = ['- [ ] **成就**', '<details>', '<summary>全结局对照</summary>', '- 一行', '</details>'].join('\n');
  const { blocks } = markdownToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['to_do', 'toggle']);
  assert.equal(blocks[0].to_do.children, undefined);
});

// Which blocks are deleted and which are kept on an overwrite rewrite. **The criterion is
// defined in reverse** — what is listed is "produced by the generator itself", and anything not
// listed is kept, because the direction to be wrong in should be "one extra block kept" rather
// than "the user content deleted".
describe('partitionForOverwrite', () => {
  const rt = (s, link) => [{
    plain_text: s,
    text: { content: s, ...(link ? { link: { url: link } } : {}) },
    ...(link ? { href: link } : {}),
  }];
  const resolve = (s) => ({ '成就甲': 'A', '成就乙': 'B' })[String(s).trim()] ?? null;

  test('images and embeds are kept, headings and checkboxes are deleted', () => {
    const { drop, keep } = partitionForOverwrite([
      { id: 'h', type: 'heading_2', heading_2: { rich_text: rt('主线') } },
      { id: 't', type: 'to_do', to_do: { rich_text: rt('成就甲') } },
      { id: 'i', type: 'image', image: {} },
      { id: 'c', type: 'callout', callout: {} },
    ], resolve);
    assert.deepEqual(drop.map((x) => x.id), ['h', 't']);
    assert.deepEqual(keep.map((x) => x.id), ['i', 'c']);
    assert.equal(keep[0].afterApiName, 'A', 'the image has to anchor to the achievement in front of it');
  });

  // A section intro is a paragraph, and the generator writes those too. Keeping them all
  // accumulates (one kept this time, the model writes another, next time both are kept…), while
  // keeping none loses external pointers that a regeneration cannot find again. So only the ones
  // carrying a pointer are kept.
  test('a section intro with a link or a BV number is kept, a plain-text one is allowed to be regenerated', () => {
    const { drop, keep } = partitionForOverwrite([
      { id: 'h', type: 'heading_2', heading_2: { rich_text: rt('指定关卡') } },
      { id: 'link', type: 'paragraph', paragraph: { rich_text: rt('gamefaqs', 'https://gamefaqs.gamespot.com/x') } },
      { id: 'bv', type: 'paragraph', paragraph: { rich_text: rt('对照 B站 BV1KFwzzCEsc 的5-2 段落') } },
      { id: 'plain', type: 'paragraph', paragraph: { rich_text: rt('这一组都在指定关卡内完成。') } },
      { id: 't', type: 'to_do', to_do: { rich_text: rt('成就甲') } },
    ], resolve);
    assert.deepEqual(keep.map((x) => x.id), ['link', 'bv'], 'only the two carrying a pointer are kept');
    assert.ok(drop.some((x) => x.id === 'plain'), 'a plain-text note makes way for a new version written from fresh research');
    assert.equal(keep[0].prefer, 'before', 'an intro sits **before** the achievements, so the anchor is the achievement after it');
    assert.equal(keep[0].beforeApiName, 'A');
  });

  // A paragraph under an achievement is not a section intro — that is the notes body, rewritten
  // every time
  test('a paragraph after an achievement is not a section intro, and is not kept even with a link', () => {
    const { keep } = partitionForOverwrite([
      { id: 'h', type: 'heading_2', heading_2: { rich_text: rt('主线') } },
      { id: 't', type: 'to_do', to_do: { rich_text: rt('成就甲') } },
      { id: 'p', type: 'paragraph', paragraph: { rich_text: rt('参考', 'https://x.com') } },
    ], resolve);
    assert.deepEqual(keep, [], 'once the achievement list has started it is no longer an intro');
  });

  test('carriesPointer recognises links, bare URLs and BV numbers', () => {
    assert.equal(carriesPointer(rt('没有指针')), false);
    assert.equal(carriesPointer(rt('有链接', 'https://a.b')), true);
    assert.equal(carriesPointer(rt('看 https://a.b/c 这里')), true);
    assert.equal(carriesPointer(rt('对照 BV1KFwzzCEsc')), true);
    assert.equal(carriesPointer(rt('BV 号太短 BV123')), false, 'do not take every occurrence of BV as a video id');
  });
});

/**
 * A section intro is a `paragraph`, and the generator writes those too —
 * **the paragraph type cannot tell the author apart, the content can.** Record what we wrote
 * last time, and look it up next time.
 */
describe('section intro provenance', () => {
  const rt = (s) => [{ plain_text: s, text: { content: s } }];
  const md = [
    '## 指定关卡',
    '这一组都在指定关卡内完成。',
    '- [ ] **移动游戏厅**<br>d',
    '## 道具使用',
    '关卡里会出现锤子。',
    '- [ ] **开盒**<br>d',
  ].join('\n');

  test('sectionIntros takes only the lines after a heading and before the first checkbox', () => {
    assert.deepEqual(sectionIntros(md), ['这一组都在指定关卡内完成。', '关卡里会出现锤子。']);
  });

  test('with a record: what we wrote makes way, what the user edited is kept', () => {
    const mine = sectionIntros(md);
    assert.equal(keepIntro(rt('这一组都在指定关卡内完成。'), mine), false,
      'identical to the character ⇒ we wrote it last time, and it should be replaced by the newly researched version');
    assert.equal(keepIntro(rt('这一组都在指定关卡内完成。我补了一句。'), mine), true,
      'one character edited and it is no longer ours ⇒ keep it');
    assert.equal(keepIntro(rt('完全是用户自己写的一段'), mine), true);
  });

  test('a whitespace difference is not an edit — a Notion round trip moves spaces, not characters', () => {
    assert.equal(keepIntro(rt('  这一组都在指定关卡内完成。 '), sectionIntros(md)), false);
  });

  // **"No record" and "recorded, but empty" are two different things.**
  // The former is an older guide (fall back to the heuristic), the latter means not one intro
  // was written last time (so everything on the page is the user own)
  test('no record falls back to the heuristic, a recorded empty array keeps everything', () => {
    assert.equal(keepIntro(rt('纯文字说明'), null), false, 'no record ⇒ keep only what carries a pointer');
    assert.equal(keepIntro(rt('对照 BV1KFwzzCEsc'), null), true);
    assert.equal(keepIntro(rt('纯文字说明'), []), true, 'recorded but nothing written last time ⇒ everything on the page is the user own');
  });
});
