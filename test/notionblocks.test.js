import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToBlocks, toRichText, chunkBlocks } from '../lib/notionblocks.js';
import { richTextToPlain } from '../lib/notion.js';

/** 把 rich_text 拼回纯文本 —— 和同步脚本读 Notion 时走的是同一个函数 */
const plain = (rt) => richTextToPlain(rt.map((r) => ({ plain_text: r.text.content })));

test('## 小节变成 heading_2,一级标题被丢掉', () => {
  const { blocks } = markdownToBlocks('# 游戏名\n\n## 一、入门\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'heading_2');
  assert.equal(plain(blocks[0].heading_2.rich_text), '一、入门');
});

test('appid 行必须是 paragraph —— extractAppIdFromPageContent 只认 paragraph', () => {
  const { blocks } = markdownToBlocks('# 游戏名\nappid: 926340\n');
  assert.equal(blocks[0].type, 'paragraph');
  assert.match(plain(blocks[0].paragraph.rich_text), /^appid: 926340$/);
});

test('成就行:粗体成就名 + <br> 变成块内换行,而不是拆成三个块', () => {
  const { blocks } = markdownToBlocks('- [ ] **初次见面**<br>完成序章<br>跟着提示走就行');
  assert.equal(blocks.length, 1, '<br> 拆块会让 audit 的反查失效');
  const rt = blocks[0].to_do.rich_text;
  assert.equal(blocks[0].to_do.checked, false);
  assert.equal(rt[0].text.content, '初次见面');
  assert.equal(rt[0].annotations.bold, true);
  assert.equal(rt[1].annotations.bold, false);
  assert.equal(plain(rt), '初次见面\n完成序章\n跟着提示走就行');
});

test('- [x] 读成 checked', () => {
  const { blocks } = markdownToBlocks('- [x] **已完成**\n- [X] **大写也算**');
  assert.deepEqual(
    blocks.map((b) => b.to_do.checked),
    [true, true]
  );
});

test('缩进的子步骤挂到上一个顶层成就下面,不占顶层位置', () => {
  const md = ['- [ ] **主成就**', '  - [ ] 第一步', '  - [ ] 第二步', '- [ ] **下一个成就**'].join(
    '\n'
  );
  const { blocks } = markdownToBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].to_do.children.length, 2);
  assert.equal(plain(blocks[0].to_do.children[0].to_do.rich_text), '第一步');
  assert.equal(blocks[1].to_do.children, undefined);
});

test('小节标题会切断父子关系,标题后面的缩进项不会挂到上一节的成就上', () => {
  const md = ['- [ ] **上一节的成就**', '## 二、后期', '  - [ ] 孤儿子步骤'].join('\n');
  const { blocks } = markdownToBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].to_do.children, undefined);
  assert.equal(blocks[2].type, 'to_do', '挂不上就退成顶层,不能丢');
});

test('认不出来的行降级成段落,内容留住并且报出来', () => {
  const md = '<details><summary>展开</summary>\n### 三级标题\n';
  const { blocks, unconverted } = markdownToBlocks(md);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.type === 'paragraph'));
  assert.match(plain(blocks[0].paragraph.rich_text), /details/);
  assert.equal(unconverted.length, 2, '排版丢了要告诉用户是哪几行');
});

test('CRLF 和行尾空格不影响解析', () => {
  const { blocks } = markdownToBlocks('## 一、入门  \r\n- [ ] **成就**  \r\n');
  assert.equal(blocks.length, 2);
  assert.equal(plain(blocks[0].heading_2.rich_text), '一、入门');
  assert.equal(plain(blocks[1].to_do.rich_text), '成就');
});

test('空行不产生空块', () => {
  const { blocks } = markdownToBlocks('\n\n## 标题\n\n\n- [ ] a\n\n');
  assert.equal(blocks.length, 2);
});

test('超长文字切成多个 run,不超 Notion 的 2000 上限', () => {
  const runs = toRichText('x'.repeat(5000));
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.text.content.length <= 2000));
  assert.equal(plain(runs).length, 5000);
});

test('落单的 ** 不会把后面的字全变粗体丢掉', () => {
  const runs = toRichText('**没闭合的粗体');
  assert.equal(plain(runs), '没闭合的粗体');
});

test('chunkBlocks 按 100 切', () => {
  const chunks = chunkBlocks(Array.from({ length: 250 }, (_, i) => i));
  assert.deepEqual(
    chunks.map((c) => c.length),
    [100, 100, 50]
  );
});

// ---------------------------------------------------------------------------
// 下面两组是为「本地攻略搬去 Notion」加的:手写攻略里真实出现的两种块。
// 生成的攻略不会用到它们,但用户自己写的会 —— 而把这些降级成段落,
// 丢的是他自己记下来的东西
// ---------------------------------------------------------------------------

test('普通项目符号变成 bulleted_list_item,不是段落', () => {
  const { blocks } = markdownToBlocks('- **模式**:用标准模式开新档\n- 第二条');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['bulleted_list_item', 'bulleted_list_item']
  );
  assert.equal(blocks[0].bulleted_list_item.rich_text[0].annotations.bold, true);
});

test('`- [ ]` 不会被当成普通项目符号 —— checkbox 优先', () => {
  const { blocks } = markdownToBlocks('- [ ] **成就**<br>描述');
  assert.equal(blocks[0].type, 'to_do');
});

test('markdown 表格变成 table 块,分隔行不算数据行', () => {
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
  assert.equal(blocks[0].table.children.length, 3, '分隔行不该变成一行数据');
  assert.equal(plain(blocks[0].table.children[1].table_row.cells[1]), '41627');
});

test('行与行列数不齐的表格补齐到同一宽度 —— Notion 会拒收不齐的', () => {
  const { blocks } = markdownToBlocks('| a | b | c |\n| --- | --- | --- |\n| 只有一格 |');
  const rows = blocks[0].table.children;
  assert.ok(rows.every((r) => r.table_row.cells.length === 3));
  assert.equal(plain(rows[1].table_row.cells[2]), '');
});

test('表格结束后普通行照常解析,表格在文件末尾也不会漏', () => {
  const { blocks } = markdownToBlocks('| a |\n| --- |\n| b |\n\n## 后面还有\n\n| c |\n| --- |');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['table', 'heading_2', 'table']
  );
});
