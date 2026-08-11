/**
 * markdown 攻略 → Notion 的 block JSON
 * ------------------------------------------------
 * `lib/notion.js` 走的是原始 REST API,它要的是 block 对象,不是 markdown。
 * 这个文件把我们**自己生成**的那种攻略翻译过去。
 *
 * 之所以能写成这么小一个转换器:格式是受控的(见 guidegen.js 的 RULES),
 * 只有四种东西 —— `## 小节标题`、`- [ ]` / `- [x]`(可带一层缩进子步骤)、
 * `appid: NNNNNN`、以及零星的普通段落。它**不是**通用 markdown 转换器,也不该变成那个。
 *
 * ## 两条不肯让步的规则
 *
 * 1. **认不出来的行不丢,降级成普通段落**,并且在 `unconverted` 里报出来。
 *    默默丢内容是这个项目最不能接受的失败方式 —— 用户不会知道攻略少了一段,
 *    而攻略是他自己的笔记。
 * 2. **`<br>` 变成块内换行(`\n`),不是三个独立的块。** 一个成就必须是**一行**
 *    checkbox:拆成三块的话,同步脚本按"成就名精确等于候选片段"匹配时,
 *    描述和心得会变成两个无主的段落,而那一行的文字只剩名字 —— 匹配还在,
 *    但 `audit` 的反查(靠描述原文)就永远找不到了。
 */

import { UNDERLINE_SPAN_RE } from './markdown.js';

/** Notion 单个 text 节点的内容上限。超了要拆成多个 run,不然整个请求被拒 */
const MAX_TEXT = 2000;

/** 一次 API 调用最多带多少个块。SKILL.md 9.2:大内容分批写,别硬塞一次 */
export const MAX_BLOCKS_PER_CALL = 100;

/**
 * `**粗体**` + `<br>` → Notion 的 rich_text 数组。
 *
 * 粗体不影响匹配(`richTextToPlain` 只取 plain_text,而本地那边 `normalizeText`
 * 会去掉 `**`),纯粹是为了和已有的上百份攻略长得一样。
 */
export function toRichText(line) {
  const runs = [];
  const push = (text, bold, underline) => {
    if (!text) return;
    // 超长的切开,不然 Notion 会整个拒掉
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      runs.push({
        type: 'text',
        text: { content: text.slice(i, i + MAX_TEXT) },
        annotations: { bold: Boolean(bold), underline: Boolean(underline) },
      });
    }
  };

  const normalized = String(line ?? '').replace(/<br\s*\/?>/gi, '\n');

  // 先按互斥标注切,再在每段里按 ** 切粗体。
  // `<span underline="true">…</span>` 是 SKILL.md 的固定写法,以前原样落进正文 ——
  // 于是 Notion 上显示的是标签本身而不是一条下划线,和用户手写的那一百多页不一样
  const segments = [];
  let last = 0;
  for (const m of normalized.matchAll(UNDERLINE_SPAN_RE)) {
    if (m.index > last) segments.push({ text: normalized.slice(last, m.index), underline: false });
    segments.push({ text: m[1], underline: true });
    last = m.index + m[0].length;
  }
  if (last < normalized.length) segments.push({ text: normalized.slice(last), underline: false });

  for (const seg of segments) {
    // 按成对的 ** 切;下标为奇的那些是粗体
    seg.text.split(/\*\*/).forEach((part, i) => push(part, i % 2 === 1, seg.underline));
  }
  return runs.length
    ? runs
    : [{ type: 'text', text: { content: '' }, annotations: { bold: false, underline: false } }];
}

const TODO_RE = /^(\s*)- \[([ xX])\]\s*(.*)$/;
/** 普通项目符号。**必须在 TODO_RE 之后判**,不然 `- [ ] x` 会被当成普通条目 */
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
/** markdown 表格的分隔行 `| --- | :-: |`,它不是数据,是语法 */
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;

/** `| a | b |` → ['a', 'b'] */
const splitRow = (line) =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/**
 * 连续的表格行 → 一个 Notion table 块。
 *
 * Notion 要求**每一行的单元格数量都等于 `table_width`**,少一个整个请求就被拒。
 * 手写的 markdown 表格经常有多一根或少一根竖线的行,所以这里统一补齐/截断,
 * 而不是把整张表退回成段落 —— 一张表退成段落,读的人就得自己在文字里找列。
 */
function tableBlock(rows) {
  const cells = rows.filter((r) => !TABLE_SEP_RE.test(r)).map(splitRow);
  const width = Math.max(...cells.map((c) => c.length));
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      // 有分隔行 = 第一行是表头,这是 markdown 表格的定义
      has_column_header: rows.some((r) => TABLE_SEP_RE.test(r)),
      has_row_header: false,
      children: cells.map((row) => ({
        object: 'block',
        type: 'table_row',
        table_row: {
          cells: Array.from({ length: width }, (_, i) => toRichText(row[i] ?? '')),
        },
      })),
    },
  };
}

/**
 * 整篇 markdown → blocks。
 *
 * @returns {{blocks: object[], unconverted: string[]}}
 *   unconverted 是**认不出、已降级成普通段落**的行,给调用方报给用户看的。
 *   内容没丢,但排版丢了,用户有权知道是哪几行。
 */
export function markdownToBlocks(md) {
  const blocks = [];
  const unconverted = [];
  // 上一个顶层列表项(to_do 或 bulleted_list_item),缩进的子项挂到它的 children 上
  let lastItem = null;
  // 表格是多行结构,攒够连续的表格行再一次性转
  let tableRows = [];
  const flushTable = () => {
    if (tableRows.length) blocks.push(tableBlock(tableRows));
    tableRows = [];
  };

  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');

    if (TABLE_ROW_RE.test(line)) {
      tableRows.push(line);
      lastItem = null;
      continue;
    }
    flushTable();

    if (!line.trim()) continue; // 空行:Notion 自己有块间距,不需要占位块

    // 标题。**每一级都要认**,不是只认 `##`:模型写 `###` 小节是很自然的事,
    // 而以前 `###` 会掉进下面的普通段落分支,页面上就是一行字面的 `### 机制速查`。
    // 实测踩到 —— 《中国式家长》那份整篇用的都是 `###`,于是**一个真标题都没有**,
    // 而且 `unconverted` 里报的是"排版降级",听着像小事,实际是整篇的结构都没了
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      // 一级标题不进正文 —— Notion 页面的标题来自 title 属性(SKILL.md 4.1)
      if (level === 1) continue;
      // Notion 只有三级标题,再深的一律归到 heading_3:少一层层级,
      // 总比把标题写成正文强
      const type = level === 2 ? 'heading_2' : 'heading_3';
      blocks.push({ object: 'block', type, [type]: { rich_text: toRichText(heading[2]) } });
      lastItem = null;
      continue;
    }

    // 列表项:checkbox 和普通条目共用一套嵌套规则。**TODO_RE 必须先判**,
    // 不然 `- [ ] 成就` 会被 BULLET_RE 当成普通条目,checkbox 就没了
    const todo = line.match(TODO_RE);
    const bullet = todo ? null : line.match(BULLET_RE);
    if (todo || bullet) {
      const [indent, type, payload] = todo
        ? [todo[1], 'to_do', { rich_text: toRichText(todo[3]), checked: todo[2] !== ' ' }]
        : [bullet[1], 'bulleted_list_item', { rich_text: toRichText(bullet[2]) }];
      const block = { object: 'block', type, [type]: payload };
      // 有缩进 = 子项,挂到上一个顶层列表项下面。挂不上(前面没有顶层的)
      // 就退化成顶层,总比丢掉强
      if (indent.length > 0 && lastItem) {
        (lastItem[lastItem.type].children ??= []).push(block);
      } else {
        blocks.push(block);
        lastItem = block;
      }
      continue;
    }

    // 剩下的都当普通段落。`appid: NNNNNN` 正好落在这里 —— 而它必须是段落,
    // 因为 extractAppIdFromPageContent 就是从 paragraph 里找它的
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: toRichText(line) },
    });
    lastItem = null;
    // <details>/<summary> 这些会走到这里:内容留住了,排版没了。
    // (标题不在这里了 —— 它们现在真的转成 heading 块)
    if (/^<(details|summary)/i.test(line)) unconverted.push(line.slice(0, 60));
  }

  flushTable(); // 文件以表格结尾时别把它落下

  return { blocks, unconverted };
}

/** 按 Notion 的单次上限切块 */
export function chunkBlocks(blocks, size = MAX_BLOCKS_PER_CALL) {
  const out = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}
