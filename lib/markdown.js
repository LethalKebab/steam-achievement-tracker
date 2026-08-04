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

export function loadTodos(path) {
  const todos = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(TODO_RE);
      if (m) todos.push({ key: i, text: m[4], checked: m[2] !== ' ' });
    });
  return todos;
}

/** 把指定行号的 checkbox 勾上,一次性写回文件 */
export function applyChecks(path, keys) {
  if (!keys.length) return 0;
  const want = new Set(keys);
  const lines = readFileSync(path, 'utf8').split('\n');
  let changed = 0;
  for (const i of want) {
    const m = lines[i]?.match(TODO_RE);
    if (m && m[2] === ' ') {
      lines[i] = `${m[1]}x${m[3]}${m[4]}`;
      changed++;
    }
  }
  if (changed) writeFileSync(path, lines.join('\n'));
  return changed;
}
