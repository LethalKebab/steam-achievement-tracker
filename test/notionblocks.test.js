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
