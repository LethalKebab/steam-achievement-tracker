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
  // `### 三级标题` **不再**属于这一类 —— 它现在真的转成 heading_3(见下面那组测试)。
  // 留在这里的是真认不出来的:HTML 折叠块 Notion 没有对应的块类型
  const md = '<details><summary>展开</summary>\n普通一行\n';
  const { blocks, unconverted } = markdownToBlocks(md);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.type === 'paragraph'));
  assert.match(plain(blocks[0].paragraph.rich_text), /details/);
  assert.equal(unconverted.length, 1, '排版丢了要告诉用户是哪几行');
  assert.match(unconverted[0], /details/);
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

// ---------------------------------------------------------------------------
// 互斥标注的下划线
// ---------------------------------------------------------------------------
// 踩过(2026-08-11):`<span underline="true">…</span>` 是 SKILL.md 规则 3.1 的固定写法,
// 以前原样落进正文 —— Notion 上显示的是标签本身,而不是一条下划线。搬过去的罗曼圣诞那页
// 有 9 处长这样,和用户手写的一百多页不一致。
// 它和 `**` 是同一类东西:是标记不是正文,所以三处必须一起改 —— 转换器产出注解,
// 而两个文本归一化(保真校验、成就匹配)必须把标签削掉,否则两种后端永远比不相等。

test('互斥标注变成 underline 注解,标签本身不进正文', () => {
  const rt = toRichText('选了这个。<span underline="true">如果选另一个则无法获得本成就。</span>');
  assert.ok(!plain(rt).includes('<span'), '标签不该出现在正文里');
  assert.ok(!plain(rt).includes('</span>'));
  assert.equal(plain(rt), '选了这个。如果选另一个则无法获得本成就。');

  const underlined = rt.filter((r) => r.annotations.underline);
  assert.equal(underlined.length, 1);
  assert.equal(underlined[0].text.content, '如果选另一个则无法获得本成就。');
  assert.equal(rt.find((r) => r.text.content === '选了这个。').annotations.underline, false);
});

test('粗体和下划线互不干扰 —— 成就名还是粗的', () => {
  const rt = toRichText('**成就名**<br>描述<br>心得。<span underline="true">互斥警告。</span>');
  const bold = rt.filter((r) => r.annotations.bold);
  assert.equal(bold.length, 1);
  assert.equal(bold[0].text.content, '成就名');
  assert.equal(bold[0].annotations.underline, false, '成就名不该被连带划线');
  assert.equal(rt.filter((r) => r.annotations.underline).length, 1);
});

test('单引号写法和大小写都认', () => {
  assert.equal(toRichText("<span underline='true'>甲</span>").filter((r) => r.annotations.underline).length, 1);
  assert.equal(toRichText('<SPAN UNDERLINE="TRUE">甲</SPAN>').filter((r) => r.annotations.underline).length, 1);
});

test('一行里有两处标注,两处都要划上', () => {
  const rt = toRichText('<span underline="true">甲</span>中间<span underline="true">乙</span>');
  assert.deepEqual(
    rt.filter((r) => r.annotations.underline).map((r) => r.text.content),
    ['甲', '乙']
  );
  assert.equal(plain(rt), '甲中间乙');
});

test('没有标注时 underline 一律 false,不留下 undefined', () => {
  for (const r of toRichText('**名字**<br>普通描述')) {
    assert.equal(r.annotations.underline, false);
  }
});

// ---------------------------------------------------------------------------
// 标题的每一级
// ---------------------------------------------------------------------------
// 踩过(2026-08-11,《中国式家长》):转换器只认 `##`,模型整篇写的是 `###`,
// 于是七个小节标题全掉进普通段落分支,页面上是七行字面的 `### 机制速查`,
// 一个真标题都没有。`unconverted` 报的是"排版降级",听着像小事。

test('### 变成 heading_3,不是字面文字', () => {
  const { blocks, unconverted } = markdownToBlocks('### 机制速查\n正文\n');
  assert.equal(blocks[0].type, 'heading_3');
  assert.equal(plain(blocks[0].heading_3.rich_text), '机制速查');
  assert.deepEqual(unconverted, [], '转好了就不该再报"排版降级"');
});

test('#### 及更深的归到 heading_3 —— Notion 只有三级', () => {
  const { blocks } = markdownToBlocks('#### 更深一层\n##### 再深\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_3', 'heading_3']);
});

test('## 仍然是 heading_2,# 仍然被丢掉', () => {
  const { blocks } = markdownToBlocks('# 游戏名\n## 主线\n### 支线\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'heading_3']);
});

test('标题里的粗体和下划线照常生效', () => {
  const { blocks } = markdownToBlocks('### **重点**小节\n');
  assert.equal(blocks[0].heading_3.rich_text.filter((r) => r.annotations.bold).length, 1);
});

test('井号后面没有空格的不算标题(#1 号这种)', () => {
  const { blocks } = markdownToBlocks('#1 号目标\n');
  assert.equal(blocks[0].type, 'paragraph', '"#1 号" 是正文,不是标题');
});
