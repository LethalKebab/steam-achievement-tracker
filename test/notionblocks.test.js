import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToBlocks, toRichText, chunkBlocks, splitDeepChildren, blockDepth, partitionForOverwrite, carriesPointer, sectionIntros, keepIntro } from '../lib/notionblocks.js';
import { richTextToPlain, NotionClient } from '../lib/notion.js';

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

// ---------------------------------------------------------------------------
// <details> 折叠块
// ---------------------------------------------------------------------------

/**
 * **SKILL.md 规则五要求长内容用 `<details><summary>` 折叠**,所以模型写它是照规矩
 * 办事,认不出来的是转换器。认不出的后果和当年只认 `##` 一样:掉进普通段落分支,
 * 页面上留下一行字面的 `<details><summary>…</summary>` 和一行 `</details>`。
 * 实测在《加利宅邸悬案》(3641000) 上留了 4 个这样的块 —— 表格进去了,壳子变成了文字。
 */
test('details 变成 toggle,summary 变成它的标题', () => {
  const { blocks, unconverted } = markdownToBlocks(
    '<details><summary>16 个地点代码</summary>\n\n正文一行\n\n</details>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(richTextToPlain(blocks[0].toggle.rich_text.map((r) => ({ plain_text: r.text.content }))),
    '16 个地点代码');
  assert.equal(blocks[0].toggle.children.length, 1);
  assert.equal(blocks[0].toggle.children[0].type, 'paragraph');
  assert.deepEqual(unconverted, [], '认出来了就不该再报"排版降级"');
});

test('**页面上不许再出现字面的标签**', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n</details>'
  );
  const flat = JSON.stringify(blocks);
  assert.doesNotMatch(flat, /<details/i, '开标签变成了正文');
  assert.doesNotMatch(flat, /<\/details/i, '闭标签变成了正文 —— 这是实测留下的那 4 个块之一');
  assert.doesNotMatch(flat, /<summary/i);
});

test('summary 单独一行也认', () => {
  const { blocks } = markdownToBlocks('<details>\n<summary>各房间最早的一个场景代码</summary>\n\n正文\n\n</details>');
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(blocks[0].toggle.rich_text[0].text.content, '各房间最早的一个场景代码');
  assert.equal(blocks[0].toggle.children.length, 1, 'summary 那一行不该再当成正文留在里面');
});

test('表格进得去折叠块', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| 地点 | 代码 |\n| --- | --- |\n| 书房 | A1 |\n\n</details>'
  );
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(blocks[0].toggle.children[0].type, 'table');
  assert.equal(blocks[0].toggle.children[0].table.children.length, 2);
});

test('折叠块外面的内容不受影响,顺序也不变', () => {
  const { blocks } = markdownToBlocks('## 标题\n\n<details><summary>x</summary>\n\n里面\n\n</details>\n\n外面');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'toggle', 'paragraph']);
  assert.equal(blocks[2].paragraph.rich_text[0].text.content, '外面');
});

test('折叠块套折叠块:按层数配对,不是见到第一个闭标签就收', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>外</summary>\n\n<details><summary>内</summary>\n\n里面\n\n</details>\n\n外层的尾巴\n\n</details>'
  );
  assert.equal(blocks.length, 1, '外层被内层的闭标签提前截断了');
  const kids = blocks[0].toggle.children;
  assert.equal(kids[0].type, 'toggle');
  assert.equal(kids[1].type, 'paragraph');
  assert.equal(kids[1].paragraph.rich_text[0].text.content, '外层的尾巴');
});

/**
 * **没有闭合标签时绝不能一路吃到文末。** 模型被截断时正好会留下一个没关的
 * `<details>` —— 那样整篇剩下的内容会全被塞进一个折叠块里,页面看起来"少了一大半",
 * 而且不报错。退回旧行为(段落 + unconverted)是**看得见**的降级。
 */
test('没有闭合标签就退回旧行为,不吞掉后面的内容', () => {
  const { blocks, unconverted } = markdownToBlocks('<details><summary>没关</summary>\n\n## 后面的小节\n\n正文');
  assert.equal(blocks[0].type, 'paragraph', '没闭合的标签不该变成 toggle');
  assert.ok(blocks.some((b) => b.type === 'heading_2'), '后面的小节被折叠块吞掉了');
  assert.equal(unconverted.length, 1, '降级了就要报出来');
});

test('没写 summary 也给一个标题 —— 空标题的 toggle 是一条看不见的横杠', () => {
  const { blocks } = markdownToBlocks('<details>\n\n正文\n\n</details>');
  assert.equal(blocks[0].type, 'toggle');
  assert.ok(blocks[0].toggle.rich_text[0].text.content.length > 0);
});

// ---------------------------------------------------------------------------
// 嵌套深度:Notion 一次只收两层
// ---------------------------------------------------------------------------

test('blockDepth 数的是块连同子孙的层数', () => {
  const leaf = { type: 'paragraph', paragraph: { rich_text: [] } };
  assert.equal(blockDepth(leaf), 1);
  const one = { type: 'toggle', toggle: { rich_text: [], children: [leaf] } };
  assert.equal(blockDepth(one), 2);
  assert.equal(blockDepth({ type: 'toggle', toggle: { rich_text: [], children: [one] } }), 3);
});

test('两层以内的原样不动', () => {
  const { blocks } = markdownToBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |');
  const { shallow, deferred } = splitDeepChildren(blocks);
  assert.deepEqual(deferred, [], 'table > table_row 正好两层,不该被拆');
  assert.equal(shallow[0].table.children.length, 2);
});

test('**三层的把整批 children 摘下来**,留着第二趟补', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n</details>'
  );
  assert.equal(blockDepth(blocks[0]), 3, '前提变了:折叠块里包表格本来就是三层');
  const { shallow, deferred } = splitDeepChildren(blocks);
  assert.equal(shallow.length, 1);
  assert.equal(shallow[0].toggle.children, undefined, 'children 没摘干净,请求还是三层');
  assert.equal(shallow[0].toggle.rich_text[0].text.content, '表', '标题要留在第一趟');
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].index, 0, 'index 要指回 shallow 里的位置,调用方靠它拿父块 id');
  assert.equal(deferred[0].children[0].type, 'table');
});

test('摘的是**整批**,不是只摘那个太深的 —— 留一半会打乱作者写的顺序', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>x</summary>\n\n前面一句\n\n| a |\n| --- |\n| 1 |\n\n后面一句\n\n</details>'
  );
  const { deferred } = splitDeepChildren(blocks);
  assert.equal(deferred.length, 1);
  assert.deepEqual(deferred[0].children.map((b) => b.type), ['paragraph', 'table', 'paragraph']);
});

test('原来的块不被就地改掉 —— 调用方可能还要用它', () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a |\n| --- |\n| 1 |\n\n</details>'
  );
  splitDeepChildren(blocks);
  assert.ok(blocks[0].toggle.children, '原数组被就地掏空了');
});

// ---------------------------------------------------------------------------
// appendBlocks 的两趟写法
// ---------------------------------------------------------------------------

/** 记下每次请求的假客户端。`request` 是 NotionClient 里唯一碰网络的地方 */
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

test('**折叠块里包表格要分两趟写** —— 一次请求只送得进两层', async () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>16 个地点代码</summary>\n\n| 地点 | 代码 |\n| --- | --- |\n| 书房 | A1 |\n\n</details>'
  );
  const { client, calls } = fakeClient();
  await client.appendBlocks('PAGE', blocks);

  assert.equal(calls.length, 2, `应该发两趟,实际 ${calls.length} 趟`);

  // 第一趟:toggle 本身,没有 children
  assert.equal(calls[0].path, '/blocks/PAGE/children');
  assert.equal(calls[0].payload.children[0].type, 'toggle');
  assert.equal(calls[0].payload.children[0].toggle.children, undefined);
  assert.equal(blockDepth(calls[0].payload.children[0]), 1);

  // 第二趟:补进第一趟建出来的那个 toggle 里
  assert.equal(calls[1].path, '/blocks/blk1/children', '补到了别的块上,内容会跑到页面外面');
  assert.equal(calls[1].payload.children[0].type, 'table');
  // 这一趟自己也不能超过两层
  for (const b of calls[1].payload.children) {
    assert.ok(blockDepth(b) <= 2, `第二趟又发了 ${blockDepth(b)} 层`);
  }
});

test('两层以内的还是一趟,别为了没用的事多发请求', async () => {
  const { blocks } = markdownToBlocks('## 标题\n\n- [ ] **成就**<br>说明');
  const { client, calls } = fakeClient();
  await client.appendBlocks('PAGE', blocks);
  assert.equal(calls.length, 1);
});

test('拿不到父块 id 就报错,不让折叠块静悄悄地空着', async () => {
  const { blocks } = markdownToBlocks(
    '<details><summary>表</summary>\n\n| a |\n| --- |\n| 1 |\n\n</details>'
  );
  const client = new NotionClient({ notion: { token: 't' } });
  client.request = async () => ({ results: [] }); // Notion 没回新块
  await assert.rejects(() => client.appendBlocks('PAGE', blocks), /没能补上|半篇攻略/);
});

// 分组标签(前置/步骤/注意)的形状:`- [ ] **成就**` 下面缩进几个 `<details>`。
// 这是 guidegen 的 groupLabelRule 在 target='notion' 时**要求**模型写的形状,
// 所以转换器认不认它不是"顺手支持",是这条规则能不能落地。
test('缩进的 details 挂在上一个 checkbox 下面,而不是变成它的兄弟', () => {
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

  // 顶层只有两个成就 —— 折叠不能站到顶层去
  assert.deepEqual(blocks.map((b) => b.type), ['to_do', 'to_do']);
  assert.deepEqual(unconverted, []);

  const kids = blocks[0].to_do.children;
  assert.deepEqual(kids.map((b) => b.type), ['toggle', 'toggle'],
    '一条成就下面连着的两个折叠都要挂上去 —— 第二个不能掉回顶层');

  // **折叠里的并列子项必须还是并列的。** 不 dedent 的话第二条会挂到第一条下面,
  // 十条前置就成了十层嵌套。
  const pre = kids[0].toggle.children;
  assert.deepEqual(pre.map((b) => b.type), ['to_do', 'to_do'],
    '折叠里两条并列的 checkbox 变成了嵌套');
  assert.equal(pre[1].to_do.children, undefined, '第二条不该成为第一条的子块');

  // 「注意」那一组是普通 bullet(警告不是任务),不能被转成 to_do
  assert.deepEqual(kids[1].toggle.children.map((b) => b.type), ['bulleted_list_item']);
});

// 顶层的折叠(规则五的长清单)行为不能被上面那条改掉
test('顶层的 details 仍然是顶层 toggle', () => {
  const md = ['- [ ] **成就**', '<details>', '<summary>全结局对照</summary>', '- 一行', '</details>'].join('\n');
  const { blocks } = markdownToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['to_do', 'toggle']);
  assert.equal(blocks[0].to_do.children, undefined);
});

// 覆盖重写时哪些块该删、哪些该留。**判据是反过来定义的** ——
// 列的是「生成器自己产的」，没列到的一律保留，因为猜错的方向应该是
// 「多留一个块」而不是「删掉用户的东西」。
describe('partitionForOverwrite', () => {
  const rt = (s, link) => [{
    plain_text: s,
    text: { content: s, ...(link ? { link: { url: link } } : {}) },
    ...(link ? { href: link } : {}),
  }];
  const resolve = (s) => ({ '成就甲': 'A', '成就乙': 'B' })[String(s).trim()] ?? null;

  test('图片/嵌入留着，标题和 checkbox 删掉', () => {
    const { drop, keep } = partitionForOverwrite([
      { id: 'h', type: 'heading_2', heading_2: { rich_text: rt('主线') } },
      { id: 't', type: 'to_do', to_do: { rich_text: rt('成就甲') } },
      { id: 'i', type: 'image', image: {} },
      { id: 'c', type: 'callout', callout: {} },
    ], resolve);
    assert.deepEqual(drop.map((x) => x.id), ['h', 't']);
    assert.deepEqual(keep.map((x) => x.id), ['i', 'c']);
    assert.equal(keep[0].afterApiName, 'A', '图要锤在它前面那条成就上');
  });

  // 小节开场说明是 paragraph，而生成器自己也写这种段落。全留会累积
  // （这次留一段、模型又写一段，下次两段都留……），全不留又会丢掉
  // 重新生成找不回来的外部指针。所以只留带指针的那部分。
  test('带链接/BV 号的小节说明留着，纯文字的让它重生', () => {
    const { drop, keep } = partitionForOverwrite([
      { id: 'h', type: 'heading_2', heading_2: { rich_text: rt('指定关卡') } },
      { id: 'link', type: 'paragraph', paragraph: { rich_text: rt('gamefaqs', 'https://gamefaqs.gamespot.com/x') } },
      { id: 'bv', type: 'paragraph', paragraph: { rich_text: rt('对照 B站 BV1KFwzzCEsc 的5-2 段落') } },
      { id: 'plain', type: 'paragraph', paragraph: { rich_text: rt('这一组都在指定关卡内完成。') } },
      { id: 't', type: 'to_do', to_do: { rich_text: rt('成就甲') } },
    ], resolve);
    assert.deepEqual(keep.map((x) => x.id), ['link', 'bv'], '只有带指针的那两段留下');
    assert.ok(drop.some((x) => x.id === 'plain'), '纯文字说明要让位给重新查过资料的新版');
    assert.equal(keep[0].prefer, 'before', '开场说明在成就**前面**，锤点要用后一条成就');
    assert.equal(keep[0].beforeApiName, 'A');
  });

  // 成就底下的段落不是小节开场说明 —— 那是心得正文，每次都重写
  test('成就之后的段落不算小节说明，带链接也不留', () => {
    const { keep } = partitionForOverwrite([
      { id: 'h', type: 'heading_2', heading_2: { rich_text: rt('主线') } },
      { id: 't', type: 'to_do', to_do: { rich_text: rt('成就甲') } },
      { id: 'p', type: 'paragraph', paragraph: { rich_text: rt('参考', 'https://x.com') } },
    ], resolve);
    assert.deepEqual(keep, [], '已经进了成就列表就不再是开场说明');
  });

  test('carriesPointer 认链接、裸 URL 和 BV 号', () => {
    assert.equal(carriesPointer(rt('没有指针')), false);
    assert.equal(carriesPointer(rt('有链接', 'https://a.b')), true);
    assert.equal(carriesPointer(rt('看 https://a.b/c 这里')), true);
    assert.equal(carriesPointer(rt('对照 BV1KFwzzCEsc')), true);
    assert.equal(carriesPointer(rt('BV 号太短 BV123')), false, '别把任意 BV 字样都当成视频号');
  });
});

/**
 * 小节开场说明是 `paragraph`，而生成器自己也写这种段落 ——
 * **段落类型分不出作者，内容能。** 记下上一次我们写了什么，下次反查。
 */
describe('小节说明的 provenance', () => {
  const rt = (s) => [{ plain_text: s, text: { content: s } }];
  const md = [
    '## 指定关卡',
    '这一组都在指定关卡内完成。',
    '- [ ] **移动游戏厅**<br>d',
    '## 道具使用',
    '关卡里会出现锤子。',
    '- [ ] **开盒**<br>d',
  ].join('\n');

  test('sectionIntros 只抓标题之后、第一条 checkbox 之前的行', () => {
    assert.deepEqual(sectionIntros(md), ['这一组都在指定关卡内完成。', '关卡里会出现锤子。']);
  });

  test('有记录时：我们写的让位，用户改过的留着', () => {
    const mine = sectionIntros(md);
    assert.equal(keepIntro(rt('这一组都在指定关卡内完成。'), mine), false,
      '一字不差 ⇒ 是我们上次写的，该换成新查过资料的那版');
    assert.equal(keepIntro(rt('这一组都在指定关卡内完成。我补了一句。'), mine), true,
      '改过一个字就不再是我们的 ⇒ 留着');
    assert.equal(keepIntro(rt('完全是用户自己写的一段'), mine), true);
  });

  test('空白差异不算修改 —— Notion 往返会动空格，不会动字', () => {
    assert.equal(keepIntro(rt('  这一组都在指定关卡内完成。 '), sectionIntros(md)), false);
  });

  // **「没记录」和「记过、但是空的」是两回事。**
  // 前者是老攻略（退回启发式），后者是上次真的一段说明都没写（那页面上的就全是用户的）
  test('没有记录退回启发式，记过空数组则一律留着', () => {
    assert.equal(keepIntro(rt('纯文字说明'), null), false, '没记录 ⇒ 只留带指针的');
    assert.equal(keepIntro(rt('对照 BV1KFwzzCEsc'), null), true);
    assert.equal(keepIntro(rt('纯文字说明'), []), true, '记过但上次一段没写 ⇒ 页上的全是用户的');
  });
});
