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

/**
 * rich_text → 纯文本。`toRichText` 的逆运算,所以放在它旁边。
 *
 * `notion.js` 原样再导出这个名字 —— 它先有的这个函数,六处调用点都从那儿 import,
 * 而搬一个工具函数不该在别的文件里留下六处无关改动。
 */
export const richTextToPlain = (rt) => (rt ?? []).map((t) => t.plain_text).join('');

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
  // `<span underline="true">…</span>` 是 SKILL.md 的固定写法,**必须在这里转掉** ——
  // 原样落进正文的话,Notion 上显示的是标签本身而不是一条下划线,和用户手写的页面不一样
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
  return convertLines(String(md ?? '').split(/\r?\n/));
}

/** `<details ...>` / `</details>` / `<summary>…</summary>`,大小写和属性都放过 */
const DETAILS_OPEN_RE = /^<details\b[^>]*>/i;
const DETAILS_CLOSE_RE = /^<\/details\s*>/i;
const SUMMARY_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/**
 * `<details>` 那一段占哪几行。**找不到闭合标签就返回 null**,调用方退回旧行为。
 *
 * 数层数而不是找第一个 `</details>`:折叠块里套折叠块是合法写法,取第一个闭合
 * 会把外层在半路截断。而**没有闭合标签时绝不能一路吃到文末** —— 模型被截断
 * 时正好会留下一个没关的 `<details>`,那样整篇剩下的内容会全部塞进一个折叠块里,
 * 页面看起来"少了一大半",而且不报错。
 */
export function detailsSpan(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim();
    if (DETAILS_OPEN_RE.test(l)) depth++;
    if (DETAILS_CLOSE_RE.test(l)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * 折叠块内部的行还带着它在原文里的缩进(`\t<details>` 下一行就是 `\t- [ ]`)。
 * **递归之前必须把这层公共缩进剥掉。** 不剥的话第一条子项因为"没有比它更浅的"
 * 成了 `lastItem`,后面每一条都因为"有缩进"挂到它下面 —— 十条并列的前置会变成
 * 一条套一条的十层,而且不报错,页面上要点开十次才看得全。
 */
function dedent(lines) {
  const widths = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const strip = widths.length ? Math.min(...widths) : 0;
  return strip ? lines.map((l) => (l.trim() ? l.slice(strip) : l)) : lines;
}

function convertLines(lines) {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    if (TABLE_ROW_RE.test(line)) {
      tableRows.push(line);
      lastItem = null;
      continue;
    }
    flushTable();

    if (!line.trim()) continue; // 空行:Notion 自己有块间距,不需要占位块

    /**
     * `<details><summary>标题</summary>` … `</details>` → Notion 的 **toggle**。
     *
     * **这不是"顺手多支持一种语法"。** SKILL.md 规则五**要求**长内容用
     * `<details>` 折叠(地点代码表、场景代码表这类几十行的参考资料),所以模型写它
     * 是在照规矩办事,漏认的是这个转换器。漏认的后果和当年只认 `##` 一模一样:
     * 掉进下面的普通段落分支,页面上留下一行字面的 `<details><summary>…</summary>`
     * 和一行 `</details>`,内容还在但排版没了 —— 而 `unconverted` 报的
     * 「排版降级」听着像小事。实测在《加利宅邸悬案》上留下 4 个这样的块。
     *
     * summary 允许写在开标签同一行(模型最常这么写)或下一行,两种都认。
     */
    if (DETAILS_OPEN_RE.test(line.trim())) {
      const close = detailsSpan(lines, i);
      if (close !== null) {
        flushTable();
        const inner = lines.slice(i + 1, close);
        // summary 可能在开标签那一行,也可能自成一行
        let label = SUMMARY_RE.exec(line)?.[1];
        if (label === undefined) {
          const at = inner.findIndex((l) => SUMMARY_RE.test(l));
          if (at !== -1) {
            label = SUMMARY_RE.exec(inner[at])[1];
            inner.splice(at, 1);
          }
        }
        const sub = convertLines(dedent(inner));
        const toggle = {
          object: 'block',
          type: 'toggle',
          toggle: {
            // 没写 summary 也要有个标题 —— Notion 的 toggle 空标题就是一条看不见的横杠
            rich_text: toRichText(label ?? '展开'),
            ...(sub.blocks.length ? { children: sub.blocks } : {}),
          },
        };
        /**
         * **缩进的折叠块挂到上一个列表项下面**,和缩进的 checkbox 同一套规则。
         *
         * 分组标签(前置/步骤/注意)就是这个形状:`- [ ] **成就**` 下面缩进几个
         * `<details>`。顶层 push 的话折叠会变成成就的**兄弟**,于是 Notion 那边
         * `fetchAllToDoBlocks` 把折叠里的子步骤当成顶层成就读出来 —— 校验器会报
         * 一串对不上的多余条目,而页面看起来只是"折叠站错了地方"。
         *
         * 挂上去之后**不清空 `lastItem`**:同一条成就下面通常连着好几个折叠
         * (前置、步骤、注意),清掉的话第二个就掉回顶层了。
         */
        if (/^[ \t]/.test(line) && lastItem) {
          (lastItem[lastItem.type].children ??= []).push(toggle);
        } else {
          blocks.push(toggle);
          lastItem = null;
        }
        unconverted.push(...sub.unconverted);
        i = close; // 跳过整段,闭合标签本身不该再变成一个块
        continue;
      }
      // 没有闭合标签:退回旧行为(下面的普通段落分支),并如实报出来
    }

    // 标题。**每一级都要认**,不是只认 `##`:模型写 `###` 小节是很自然的事,漏认
    // 的话它会掉进下面的普通段落分支,页面上就是一行字面的 `### 机制速查`。实测踩到过
    // 整篇都用 `###` 的攻略,于是**一个真标题都没有**,而 `unconverted` 里报的是
    // "排版降级",听着像小事,实际是整篇的结构都没了
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

/**
 * 一页 Notion 攻略拍平成「标题和 checkbox 按出现顺序排成一串」——
 * 和 `markdown.js` 的 `guideOutline` 同一种形状,于是小节归属只有一份代码。
 *
 * **喂给它的必须是 `fetchAllBlocks` 的结果,不是 `fetchAllToDoBlocks` 的。**
 * 后者只收 to_do,标题在它眼里根本不存在 —— 「Notion 上读不到小节结构」只对那个
 * 函数成立,对整页不成立,整页的块是拿得到的。
 *
 * 顶层的 to_do 才算成就:嵌在别的 to_do 里的是子步骤,和本地那边缩进为 0 的判据对齐。
 *
 * @returns {{kind:'heading'|'todo', text:string, level?:number}[]}
 */
export function blocksToOutline(blocks, depth = 0) {
  const out = [];
  for (const b of blocks ?? []) {
    const h = /^heading_([123])$/.exec(b.type ?? '');
    if (h) {
      out.push({ kind: 'heading', text: richTextToPlain(b[b.type]?.rich_text), level: Number(h[1]) });
      continue;
    }
    if (b.type === 'to_do') {
      if (depth === 0) out.push({ kind: 'todo', text: richTextToPlain(b.to_do?.rich_text) });
      continue; // 子步骤不递归进去
    }
    // 容器(toggle / column 等)不改变归属:套在里面的标题和成就还是这一节的
    if (b.children?.length) out.push(...blocksToOutline(b.children, depth));
  }
  return out;
}

/**
 * 备份里的块**指向别的实体**,或者压根没有可写的内容 —— append 建不出来。
 * 遇上就丢掉并记一笔,而不是原样递给 Notion 换一个 400:一次恢复里有一个
 * `child_database` 不该让整篇攻略写不回去。
 */
const UNRESTORABLE_TYPES = new Set([
  'child_page', 'child_database', 'link_to_page', 'synced_block', 'unsupported',
]);

/**
 * 把 `fetchAllBlocks` 存下来的原样块变成能 `appendBlocks` 回去的形状。
 *
 * 两处形状差在哪,是这个函数存在的全部理由:
 *
 *  1. **只读字段**(`id` / `created_time` / `parent` / `has_children` …)在读回来的块上
 *     全都有,写回去时一个都不能带。这里不是逐个 `delete`,而是**只挑 `type` 和
 *     `block[type]` 重新拼一个**——删名单会随 Notion 加字段而过期,重拼不会。
 *  2. **子块的位置不一样**:备份里挂在顶层 `block.children`(`fetchAllBlocks` 就是这么
 *     存的),写回去时 Notion 要求嵌在 `block[type].children` 里。这一步不做,恢复出来
 *     的页面是拍平的一层 —— 成就底下的子步骤会全部升级成成就,而 checkbox 同步
 *     正是靠嵌套深度分辨这两者的。
 *
 * @returns {{blocks: object[], dropped: Record<string, number>}}
 */
export function blocksForAppend(blocks) {
  const dropped = {};
  const convert = (list) => {
    const out = [];
    for (const b of list ?? []) {
      const type = b?.type;
      if (!type) continue;
      if (UNRESTORABLE_TYPES.has(type)) {
        dropped[type] = (dropped[type] ?? 0) + 1;
        continue;
      }
      const payload = { ...(b[type] ?? {}) };
      const kids = convert(b.children);
      if (kids.length) payload.children = kids;
      out.push({ object: 'block', type, [type]: payload });
    }
    return out;
  };
  return { blocks: convert(blocks), dropped };
}

/** 按 Notion 的单次上限切块 */
/** 一个块连同子孙一共多少层。叶子算 1 */
export function blockDepth(block) {
  const kids = block?.[block?.type]?.children ?? [];
  return kids.length ? 1 + Math.max(...kids.map(blockDepth)) : 1;
}

/**
 * **Notion 一次追加只收两层嵌套**(顶层块 + 它的 children),再深的要另发一次请求。
 *
 * 这在 toggle 出现之前不成问题:以前最深的形状就是 `table > table_row` 和
 * 「成就 to_do > 子步骤 to_do」,正好两层。折叠块把表格包进去之后变成
 * `toggle > table > table_row` —— 三层,一次发不上去。
 *
 * 超深的块**整批 children 一起挪走**,而不是只挪那个太深的:留一半在原地、
 * 另一半第二趟补,折叠块里的顺序就乱了,而那顺序是作者写的。
 *
 * 返回 `{ shallow, deferred }`,`deferred[i].index` 指向 `shallow` 里的位置 ——
 * Notion 的追加响应按请求顺序返回新建的块,调用方据此拿到父块 id。
 */
export function splitDeepChildren(blocks, max = 2) {
  const shallow = [];
  const deferred = [];
  blocks.forEach((b, index) => {
    if (blockDepth(b) <= max) {
      shallow.push(b);
      return;
    }
    const payload = { ...b[b.type] };
    const children = payload.children ?? [];
    delete payload.children;
    shallow.push({ ...b, [b.type]: payload });
    deferred.push({ index, children });
  });
  return { shallow, deferred };
}

export function chunkBlocks(blocks, size = MAX_BLOCKS_PER_CALL) {
  const out = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}

/**
 * `markdownToBlocks` **会**产出的块类型 —— 也就是覆盖重写时可以放心删掉重写的那些。
 *
 * **反过来定义是刻意的。** 列"要保留的类型"意味着 Notion 以后加一种新块、或者用户用了
 * 一种我们没想到的块,它就会掉进"删"的那一边并且悄悄消失。列"我们自己产的",没列到的
 * 一律保留 —— 猜错的方向是"多留一个块",不是"删掉用户的东西"。
 *
 * 图片不在里面:提示词里明写「不要贴图片」,所以页面上的图**一定**是用户自己贴的。
 * 而找物类游戏的位置只能靠图说清(规则二),那些图是重新生成拿不回来的东西。
 */
export const GENERATED_BLOCK_TYPES = new Set([
  'heading_1', 'heading_2', 'heading_3',
  'paragraph', 'to_do', 'bulleted_list_item', 'numbered_list_item',
  'toggle', 'table', 'table_row', 'divider', 'code',
]);

/**
 * 覆盖重写时,把旧页面的顶层块分成「删」和「留」,并给每个要留的块算一个**锚点**。
 *
 * 锚点是**它前面最近那条成就的 api_name**,不是小节标题 —— 标题会被重排改掉,而成就
 * 身份是稳定的。前面没有成就的(页面开头的图),锚点记 `null`,插回去时放最前面。
 *
 * @returns {{drop: {id:string}[], keep: {id:string, type:string, afterApiName:string|null}[]}}
 */
/**
 * rich_text 取纯文本,**两种形状都认**。
 *
 * Notion **读回来**的每一项带 `plain_text`;我们**自己造**的(`toRichText`)只有
 * `text.content`。`richTextToPlain` 只读前者 —— 拿它去解析自己刚造好的块会得到空串,
 * 而空串不会报错,只会让下游"一条都匹配不上"然后静静地退化。
 *
 * **实测踩过**:`writeAroundKept` 用它建锚点表,新块全解析成空,于是保留的 bookmark
 * 一律退回"留在原处",落到了页首。单测没抓到是因为夹具两个字段都给了 —— 比现实宽容。
 */
export const richTextText = (rt) => (rt ?? [])
  .map((t) => (t?.plain_text ?? t?.text?.content ?? ''))
  .join('');

export function partitionForOverwrite(blocks, resolve, generatedProse = null) {
  const list = blocks ?? [];

  // 先把每个下标后面最近的那条成就算出来 —— 小节开场说明挂的是**它后面**那条
  const nextApi = new Array(list.length).fill(null);
  {
    let seen = null;
    for (let i = list.length - 1; i >= 0; i--) {
      nextApi[i] = seen;
      if (list[i].type === 'to_do') {
        const hit = resolve(richTextToPlain(list[i].to_do?.rich_text ?? []));
        if (hit) seen = hit;
      }
    }
  }

  const drop = [];
  const keep = [];
  let lastApiName = null;
  /** 从上一个标题到现在,见过 to_do 没有 —— 没见过就说明还在小节开场那一段 */
  let inSectionIntro = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (/^heading_[1-6]$/.test(b.type)) inSectionIntro = true;
    if (b.type === 'to_do') {
      inSectionIntro = false;
      const hit = resolve(richTextToPlain(b.to_do?.rich_text ?? []));
      if (hit) lastApiName = hit;
    }

    if (!GENERATED_BLOCK_TYPES.has(b.type)) {
      keep.push({ id: b.id, type: b.type, prefer: 'after', afterApiName: lastApiName, beforeApiName: nextApi[i] });
      continue;
    }
    if (b.type === 'paragraph' && inSectionIntro && keepIntro(b.paragraph?.rich_text, generatedProse)) {
      keep.push({ id: b.id, type: b.type, prefer: 'before', afterApiName: lastApiName, beforeApiName: nextApi[i] });
      continue;
    }
    drop.push({ id: b.id });
  }
  return { drop, keep };
}

/**
 * 这段小节开场说明里有没有**外部指针** —— 链接、裸 URL、或者 B 站 BV 号。
 *
 * **为什么只留带指针的。** 小节开场说明是 `paragraph`,而生成器自己也写这种段落,
 * 光看类型分不出「用户手写的」和「上一次生成的」。全留会累积:这次留一段、模型又写
 * 一段,下次两段都留、再加一段……全不留又会丢掉真正拿不回来的东西。
 *
 * 带指针的那部分正好是**重新生成不一定找得回来的**:`gamefaqs` 的逐关攻略、
 * 「对照 B站 BV1KFwzzCEsc 的 5-2 段落(01:56)」这种带时间点的引用。纯文字说明
 * (「提示条上限 9 点」之类)模型每次都会重新查、重新写,丢了不可惜。
 *
 * 代价说明白:这是个**启发式**,不是 provenance。你手写的一段没有链接的说明会被
 * 重新生成的那段换掉 —— 想要那个得存「上次我们写了什么」再做比对,是另一件事。
 */
export function carriesPointer(richText) {
  const rt = richText ?? [];
  if (rt.some((t) => t?.href || t?.text?.link?.url)) return true;
  const plain = richTextToPlain(rt);
  return /https?:\/\//i.test(plain) || /\bBV[0-9A-Za-z]{8,}\b/.test(plain);
}

/** 小节说明归一化:只比内容,不比空白 —— Notion 往返会动空格,但不会动字 */
export const normalizeProse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 这一段小节开场说明该不该留下来。
 *
 * **有 provenance 就用 provenance。** `generatedProse` 是上一次我们自己写进去的那几段:
 * 能在里面找到 ⇒ 是我们写的,让位给这次重新查过资料的新版本;找不到 ⇒ 用户手写或
 * 改过的,留着。这是唯一原理上说得清的判据 —— 段落类型分不出作者,内容能。
 *
 * **拿不到 provenance(老攻略,这一列还是空的)才退回 `carriesPointer` 那个启发式。**
 * 那时候只留带链接/BV 号的:全留会和这次新写的说明叠成两份、下次叠三份;全不留会
 * 丢掉 `gamefaqs` 链接和「BV1KFwzzCEsc 的 5-2 段落(01:56)」这种重新生成找不回来的东西。
 * 一份攻略只会经历一次这种引导期 —— 落地之后 `gen_prose` 就有值了。
 */
export function keepIntro(richText, generatedProse) {
  if (!generatedProse) return carriesPointer(richText);
  const mine = new Set(generatedProse.map(normalizeProse));
  return !mine.has(normalizeProse(richTextToPlain(richText ?? [])));
}

/**
 * 从我们**刚写好的 markdown** 里挑出小节开场说明 —— 标题之后、第一条 `- [ ]` 之前的
 * 那些非空行。落地成功后存进 `guides.gen_prose`,给下一次覆盖当反查表。
 */
export function sectionIntros(markdown) {
  const out = [];
  let intro = false;
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    // **只认 `##` 起的小节标题。** `#` 是攻略的大标题,它下面紧跟的是 `appid:` 行 ——
    // 那是程序写的,不是小节说明,收进来只会在 provenance 里留一条噪音
    if (/^#{2,6}\s/.test(line)) { intro = true; continue; }
    if (/^#\s/.test(line)) { intro = false; continue; }
    if (/^[-*]\s*\[[ xX]\]/.test(line)) { intro = false; continue; }
    if (!intro || !line) continue;
    if (/^<\/?(details|summary)/i.test(line)) continue;
    out.push(normalizeProse(line));
  }
  return out;
}
