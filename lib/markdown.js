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

/** 把 guides.url 解析成真实文件路径,并挡住越出 guidesDir 的路径 */
export function resolveGuidePath(guidesDir, url) {
  const path = isAbsolute(url) ? url : join(guidesDir, url);
  const full = resolve(path);
  if (!full.startsWith(resolve(guidesDir))) {
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
  const todos = [];
  // 缩进栈:[{indent, key}],用来判断当前行挂在哪一行下面
  const stack = [];
  splitLines(readFileSync(path, 'utf8'))
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
