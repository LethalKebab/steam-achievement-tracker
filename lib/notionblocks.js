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
  const push = (text, bold) => {
    if (!text) return;
    // 超长的切开,不然 Notion 会整个拒掉
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      runs.push({
        type: 'text',
        text: { content: text.slice(i, i + MAX_TEXT) },
        annotations: { bold: Boolean(bold) },
      });
    }
  };

  const normalized = String(line ?? '').replace(/<br\s*\/?>/gi, '\n');
  // 按成对的 ** 切;奇数段是普通文字,偶数段(下标为奇)是粗体
  const parts = normalized.split(/\*\*/);
  parts.forEach((part, i) => push(part, i % 2 === 1));
  return runs.length ? runs : [{ type: 'text', text: { content: '' }, annotations: { bold: false } }];
}

const TODO_RE = /^(\s*)- \[([ xX])\]\s*(.*)$/;

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
  // 上一个顶层 to_do,子步骤要挂到它的 children 上
  let lastTodo = null;

  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue; // 空行:Notion 自己有块间距,不需要占位块

    // 一级标题不进正文 —— Notion 页面的标题来自 title 属性(SKILL.md 4.1)
    if (/^#\s+/.test(line)) continue;

    if (/^##\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: toRichText(line.replace(/^##\s+/, '')) },
      });
      lastTodo = null;
      continue;
    }

    const todo = line.match(TODO_RE);
    if (todo) {
      const [, indent, mark, text] = todo;
      const block = {
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: toRichText(text), checked: mark !== ' ' },
      };
      // 有缩进 = 子步骤,挂到上一个顶层 to_do 下面。挂不上(前面没有顶层的)
      // 就退化成顶层,总比丢掉强
      if (indent.length > 0 && lastTodo) {
        (lastTodo.to_do.children ??= []).push(block);
      } else {
        blocks.push(block);
        lastTodo = block;
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
    lastTodo = null;
    // 三级以上标题、<details>、<table> 这些会走到这里:内容留住了,排版没了
    if (/^#{3,}\s|^<(details|table|summary)/i.test(line)) unconverted.push(line.slice(0, 60));
  }

  return { blocks, unconverted };
}

/** 按 Notion 的单次上限切块 */
export function chunkBlocks(blocks, size = MAX_BLOCKS_PER_CALL) {
  const out = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}
