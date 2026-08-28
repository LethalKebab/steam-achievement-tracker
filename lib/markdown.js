/**
 * 本地 markdown 攻略后端(Notion 之外的第二种攻略存放方式)
 * ------------------------------------------------
 * guides 表里 kind='local' 的行,url 存的是相对 guidesDir 的文件路径(比如
 * sultans_game_achievements.md)。checkbox 就是 markdown 的 "- [ ] xxx" 行,
 * 同步时把匹配上的改成 "- [x] xxx"。
 *
 * 匹配规则(normalizeText / extractTitleCandidates)和 Notion 后端**共用同一份代码**,
 * 见 lib/guides.js——那套"必须精确匹配标题候选片段"的规则是踩过坑换来的,
 * 两个后端不能各写一份。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

import { isInside } from './pathsafe.js';

/**
 * 互斥标注的固定写法(SKILL.md 规则 3.1):
 * `<span underline="true">如果进行此动作则无法获得X成就。</span>`
 *
 * **它和 `**粗体**` 是同一类东西 —— 是标记,不是正文。** Notion 那边它变成 rich_text 的
 * `underline` 注解,`plain_text` 里只剩里面的字;本地 md 里它是字面文本。所以凡是要把
 * 两边的文字放在一起比的地方(搬家的保真校验、成就匹配的归一化),都必须先把标签削掉,
 * 否则同一句话在两种后端上永远比不相等 —— `**` 早就是这么处理的,这条只是补上漏掉的那个。
 *
 * 用 `matchAll` 和 `replace` 都不会污染 lastIndex,所以这个带 /g 的正则可以共用。
 */
export const UNDERLINE_SPAN_RE = /<span\s+underline=["']true["']\s*>([\s\S]*?)<\/span>/gi;

const TODO_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*)(.*)$/;

/**
 * 按行拆,**CRLF 和 LF 都要认**。
 *
 * 只 `split('\n')` 的话,CRLF 文件每行结尾会剩一个 `\r`,而 JS 正则里 `.` **不匹配 `\r`**
 * (它和 `\n` 一样算行终止符),于是 `(.*)$` 匹配不上 —— 整份攻略读出 **0 个 checkbox**。
 *
 * 这不是假想的问题:Windows 上的编辑器默认就写 CRLF。踩过一次,表现是
 * `checkbox-sync` 一个框都不勾、`guide-lint` 报"所有成就都缺 checkbox",
 * **两边都不报错**,看起来就像攻略写错了。
 */
const splitLines = (text) => text.split(/\r?\n/);

/** 写回去的时候保持文件原来的换行风格,不要顺手把整个文件改成 LF */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * 把 `guides.url` 解析成真实文件路径,并挡住越出 `guidesDir` 的路径。
 *
 * 判据在 `pathsafe.isInside` 里,四处包含性检查共用一个 —— 这里曾经是
 * `startsWith(resolve(guidesDir))`,不带分隔符,于是 `…/guides-evil/x.md`
 * 也算"在 guides 里面"。**这不只是读的口子**:`guidepatch.landPatchLocal`
 * 拿这个返回值 `writeFileSync`。
 */
export function resolveGuidePath(guidesDir, url) {
  const path = isAbsolute(url) ? url : join(guidesDir, url);
  const full = resolve(path);
  if (!isInside(guidesDir, full)) {
    throw new Error(`攻略路径越出了 guides 目录: ${url}`);
  }
  if (!existsSync(full)) throw new Error(`找不到攻略文件: ${full}`);
  return full;
}

/**
 * 读出所有 checkbox 行。缩进更深的行算上一层的**子步骤**(parent 指向那一行的 key),
 * 和 Notion 后端的嵌套 to_do 对应上——两个后端交给匹配逻辑的数据形状必须一样。
 */
export function loadTodos(path) {
  return parseTodos(readFileSync(path, 'utf8'));
}

/**
 * 同一个解析器,吃字符串而不是路径。
 *
 * 拆出来是因为**局部重写要解析模型刚交回来的那几行**,那时候它还没落盘 —— 而这里
 * 每一条规则(CRLF、缩进算法、`parent` 的挂法)都是踩过坑换来的,再写第二份
 * 一定会漂:两个后端交给匹配逻辑的形状必须一样,那么两处解析也必须是同一处。
 *
 * **返回的形状和 Notion 后端逐字一致**(`{key, text, checked, parent}`),不额外加
 * `indent` 之类只有 markdown 才有的字段 —— 加了就会有代码在 Notion 的 todo 上读它、
 * 拿到 undefined,而那种失败一声不响。行号层面的事全部交给 `todoSpans`。
 */
export function parseTodos(text) {
  const todos = [];
  // 缩进栈:[{indent, key}],用来判断当前行挂在哪一行下面
  const stack = [];
  splitLines(text)
    .forEach((line, i) => {
      const m = line.match(TODO_RE);
      if (!m) return;
      // m[1] 是 "  - [" 这一段,减掉 "-"/"*" 和 "[" 才是真正的缩进宽度
      const indent = m[1].length - m[1].trimStart().length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      todos.push({
        key: i,
        text: m[4],
        checked: m[2] !== ' ',
        parent: stack.length ? stack[stack.length - 1].key : null,
      });
      stack.push({ indent, key: i });
    });
  return todos;
}

/**
 * 一份本地攻略拍平成「标题和 checkbox 按出现顺序排成一串」。
 *
 * 给"这条成就属于哪个小节"用。**行的判定复用这个文件里同一套正则** —— 小节归属
 * 和打勾必须对同一批行有同一个看法,各写一份迟早出现"打得上勾却分不进小节"。
 *
 * Notion 那边由 `notionblocks.js` 的 `blocksToOutline` 产出同样的形状,于是
 * `groupBySection` 一份代码吃两个后端。
 *
 * @returns {{kind:'heading'|'todo', text:string, level?:number}[]}
 */
export function guideOutline(text) {
  const out = [];
  for (const line of splitLines(text)) {
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      out.push({ kind: 'heading', text: h[2].trim(), level: h[1].length });
      continue;
    }
    const t = line.match(TODO_RE);
    // 缩进的是子步骤,不是成就 —— 归属只认顶层那一行
    if (t && t[1].length - t[1].trimStart().length === 0) out.push({ kind: 'todo', text: t[4] });
  }
  return out;
}

/**
 * 每个 checkbox 行占哪几行 —— 局部重写靠它精确替换,不碰别的字节。
 *
 * 一条成就 = 它自己那一行 + **紧挨在后面、缩进更深**的那串子步骤行。
 *
 * 两条判据都是刻意收紧的,方向一致:**宁可少吃一行,绝不多吃一行。**
 *
 * - **必须连续**(`row.line === end + 1`)。中间只要插了一行不是 checkbox 的东西,
 *   区间就到此为止 —— 一段 `<details>` 折叠、一个表格、一句小节说明都可能躺在
 *   成就和它的子步骤之间,而那些**不是这条成就的东西**。吞掉它们就是在用户没
 *   要求的地方删字,而这个功能存在的全部理由就是"没点名的部分一个字节都不动"。
 * - **缩进必须更深**。同级或更浅就是下一条成就(或者退回上一层),区间结束。
 *
 * 代价是:子步骤之间空一行的攻略,只有第一段子步骤会被替换掉,剩下的留在原地 ——
 * 那会被校验器当成重复条目报出来,是**看得见**的失败。反过来(多吃一行)是静默删字。
 */
export function todoSpans(text) {
  const rows = [];
  splitLines(text).forEach((line, i) => {
    const m = line.match(TODO_RE);
    if (m) rows.push({ line: i, indent: m[1].length - m[1].trimStart().length });
  });

  const spans = new Map();
  for (let r = 0; r < rows.length; r++) {
    let end = rows[r].line;
    for (let k = r + 1; k < rows.length; k++) {
      if (rows[k].indent <= rows[r].indent) break;
      if (rows[k].line !== end + 1) break;
      end = rows[k].line;
    }
    spans.set(rows[r].line, { start: rows[r].line, end, indent: rows[r].indent });
  }
  return spans;
}

/** `<details ...>` / `</details>`,大小写和属性都放过。**这两行是 notionblocks.js
 *  里同名正则的副本** —— 那个模块 import 本文件(UNDERLINE_SPAN_RE),反过来 import
 *  就成环了。两行正则,复制比循环依赖便宜。 */
const DETAILS_OPEN = /^<details\b[^>]*>/i;
const DETAILS_CLOSE = /^<\/details\s*>/i;

/**
 * 一个 `<details>` 从 `start` 起占到哪一行(闭合标签那一行)。**找不到闭合就返回 null**。
 *
 * 数层数而不是找第一个 `</details>`:折叠里套折叠是合法写法。没闭合时**绝不能一路吃到
 * 文末** —— 模型被截断时正好会留下一个没关的 `<details>`,那样后面的内容会全被吞进去。
 */
export function detailsBlockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const cur = lines[i].trim();
    if (DETAILS_OPEN.test(cur)) depth++;
    if (DETAILS_CLOSE.test(cur)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * 和 `todoSpans` 同一套区间,**外加吃掉紧跟着的、更深缩进的 `<details>` 折叠块**。
 *
 * 为什么要单独一个函数而不是放宽 `todoSpans`:那个的保守是**载荷**的 —— 本地 md 的
 * `spliceLines` 按行区间回贴,多吃一行就是静默删字。这个是给"正文里带折叠"的场景用的:
 * Notion 目标下分组标签就是 `<details>`(见 guidegen 的 `groupLabelRule`),
 * 而折叠那一行不是 checkbox,`todoSpans` 会在那里当场截断,把子步骤全丢在区间外。
 *
 * **折叠没有闭合标签时不猜**,到此为止:模型被截断时正好会留下一个没关的 `<details>`,
 * 一路吃到文末会把后面别的成就整个吞进来。少吃一行会被校验器报成缺条目(看得见),
 * 多吃是静默吞并(看不见),两者的代价不对等。
 */
export function todoSpansWithToggles(text) {
  const lines = splitLines(text);
  const spans = todoSpans(text);
  const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;
  const out = new Map();

  for (const [key, span] of spans) {
    const base = indentOf(lines[span.start] ?? '');
    let end = span.end;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (!next.trim()) break;
      if (indentOf(next) <= base) break;
      const t = next.trim();
      if (DETAILS_OPEN.test(t)) {
        const close = detailsBlockEnd(lines, end + 1);
        if (close === null) break;
        end = close;
        continue;
      }
      if (TODO_RE.test(next)) { end += 1; continue; }
      break;
    }
    out.set(key, { ...span, end });
  }
  return out;
}

/**
 * 按行区间替换,**从后往前做**。
 *
 * 从前往后替换的话,第一处替换的行数一变,后面每个区间的下标就全错位了 —— 而它
 * 不会报错,只会把内容贴到别的成就身上。倒着做区间下标就永远指向还没动过的那半边。
 *
 * 换行风格跟着原文(`eolOf`),理由和 `applyChecks` 那条一样:顺手把 CRLF 改成 LF
 * 会让 git diff 变成"每一行都改了",真正的改动淹没在里面。
 *
 * @param {string} text
 * @param {{start:number, end:number, lines:string[]}[]} edits
 */
export function spliceLines(text, edits) {
  if (!edits.length) return text;
  const eol = eolOf(text);
  const lines = splitLines(text);
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (const e of ordered) {
    lines.splice(e.start, e.end - e.start + 1, ...e.lines);
  }
  return lines.join(eol);
}

/** 把指定行号的 checkbox 勾上,一次性写回文件 */
export function applyChecks(path, keys) {
  if (!keys.length) return 0;
  const want = new Set(keys);
  const text = readFileSync(path, 'utf8');
  // 写回去保持原来的换行风格 —— 顺手把整个文件从 CRLF 改成 LF 会让 git diff
  // 变成"每一行都改了",真正的改动淹没在里面
  const eol = eolOf(text);
  const lines = splitLines(text);
  let changed = 0;
  for (const i of want) {
    const m = lines[i]?.match(TODO_RE);
    if (m && m[2] === ' ') {
      lines[i] = `${m[1]}x${m[3]}${m[4]}`;
      changed++;
    }
  }
  if (changed) writeFileSync(path, lines.join(eol));
  return changed;
}
