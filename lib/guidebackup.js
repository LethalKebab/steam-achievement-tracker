/**
 * 覆盖已有攻略前的备份和差异预览(「动手顺序」第 8 步)
 * ------------------------------------------------
 * 落盘闸门是**按可逆性分的,不按后端分**(设计文档里定的):新建文件过了机器闸门就自动写,
 * 覆盖已有的必须人工确认。这个文件提供确认之前该有的两样东西 —— **一份能拿回来的原文**,
 * 和**一张说清楚会失去什么的清单**。
 *
 * ## 为什么备份是 block JSON 而不是 markdown
 *
 * Notion 那边备份的是 `fetchAllBlocks` 的原样 JSON。把它渲染成 markdown 更好读,但那是
 * **有损的**:一旦覆盖完发现不对,好读的东西还不回去。备份的职责是"还得回去",不是"好看"。
 * 好看那份需求由下面的差异预览满足 —— 它本来就是给人看的。
 *
 * ## 差异预览按「成就覆盖」算,不逐行比文字
 *
 * 重新生成的攻略措辞几乎必然和旧的不一样,逐行 diff 会把每一行都报成"删了又加",
 * 噪音淹掉信号。真正需要人判断的是三件事:
 *
 *  1. **有没有成就在新版里丢了框** —— 那是真的退化
 *  2. **哪些手动勾上的框会变回未勾** —— 成就框会由 `computeCheckedKeys` 按数据库重新勾上,
 *     但**子步骤框不会**(它们不是成就,匹配不到任何东西)。这是覆盖唯一会真正丢掉的用户数据
 *  3. **正文体量变了多少** —— 拿三千字的机器攻略换掉九千字的手写笔记,是当场就该看见的事,
 *     而不是覆盖完才发现
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveTodoToAchievement } from './guides.js';
import { resolveGuidePath } from './markdown.js';
import { extractNotionPageId, richTextToPlain } from './notion.js';

/** 备份放哪。和 `.drafts/`、`.migrated/` 一样,发现逻辑是非递归的,扫不进来 */
export const BACKUPS_DIR = '.backups';

/** `20260811-155712` —— 可排序,同一天多次覆盖不会互相覆盖 */
export function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 覆盖之前把原文存下来。**任何写操作之前调用,失败就不要继续覆盖。**
 *
 * 备份失败和归档失败不一样:`guidemigrate` 里归档失败可以放过(那时候东西已经安全落地了),
 * 这里备份是覆盖的**前置条件** —— 没有备份的覆盖就是不可逆的删除。
 *
 * `blocks` 是**原样的 block 数组**,不只是个数 —— 覆盖时紧接着就要按它去删旧内容,
 * 让调用方为此再读一次页面,等于给"备份的和删掉的是不是同一批"留了个缝
 *
 * @returns {Promise<{path: string, kind: string, blocks: object[]|null, count: number|null, bytes: number}>}
 */
export async function backupGuide(config, { guide, appid, notion = null, now = new Date() }) {
  const dir = join(config.guidesDir, BACKUPS_DIR);
  mkdirSync(dir, { recursive: true });
  const base = `${appid}-${timeStamp(now)}`;

  if (guide.kind === 'local') {
    const from = resolveGuidePath(config.guidesDir, guide.url);
    if (!existsSync(from)) throw new Error(`要备份的攻略文件不见了:${from}`);
    const path = join(dir, `${base}.md`);
    copyFileSync(from, path);
    // 回读备份本身,而不是报源文件的大小 —— 备份的意义在于"存下来的那份",
    // 拷贝没写全的话这里就该看出来
    return { path, kind: 'local', blocks: null, count: null, bytes: Buffer.byteLength(readFileSync(path)) };
  }

  if (!notion?.configured) throw new Error('要备份 Notion 上的攻略,但 Notion 没配置');
  const blocks = await notion.fetchAllBlocks(extractNotionPageId(guide.url));
  if (!blocks.length) {
    throw new Error(`${guide.url} 上一个 block 都没读到 —— 备份空文件等于没备份,先确认这一页还在`);
  }
  const path = join(dir, `${base}.json`);
  const body = JSON.stringify({ appid: String(appid), url: guide.url, savedAt: now.toISOString(), blocks }, null, 2);
  writeFileSync(path, body);
  return { path, kind: 'notion', blocks, count: blocks.length, bytes: Buffer.byteLength(body) };
}

/**
 * 一份攻略覆盖了哪些成就,以及有哪些够不着成就的框(子步骤)。
 *
 * 用的是 `audit` 那条反查(`resolveTodoToAchievement`),不是另写一套 —— 于是"这个框
 * 说的是哪个成就"在预览里和在审计里是同一个答案。
 */
export function coverageOf(todos, defs) {
  const byApiName = new Map();
  const orphans = [];
  for (const t of todos) {
    // 反查返回的是 `{def, via}`,不是 def 本身 —— `via` 说明它是靠描述还是靠名字认出来的
    const hit = resolveTodoToAchievement(t.text, defs);
    if (hit?.def) byApiName.set(hit.def.api_name, t);
    else orphans.push(t);
  }
  return { byApiName, orphans };
}

/**
 * 覆盖会带来什么变化。**纯函数,好测。**
 *
 * @param {object[]} oldTodos 旧攻略的 checkbox(两种后端形状一样)
 * @param {object[]} newTodos 新生成的
 * @param {object[]} defs     这个游戏的成就定义
 */
export function diffGuides({ oldTodos, newTodos, defs, oldText = '', newText = '' }) {
  const before = coverageOf(oldTodos, defs);
  const after = coverageOf(newTodos, defs);

  const lostAchievements = [];
  for (const [apiName, todo] of before.byApiName) {
    if (!after.byApiName.has(apiName)) {
      const d = defs.find((x) => x.api_name === apiName);
      lostAchievements.push({ apiName, name: d?.name_cn || d?.name_en || apiName, wasChecked: Boolean(todo.checked) });
    }
  }

  // 覆盖唯一真正丢掉的用户数据:**手动勾上的子步骤框**。成就框会被 computeCheckedKeys
  // 按数据库重新勾上,子步骤框匹配不到任何成就,重新生成之后一律是未勾选
  const lostTicks = before.orphans.filter((t) => t.checked);

  return {
    oldCount: oldTodos.length,
    newCount: newTodos.length,
    oldChecked: oldTodos.filter((t) => t.checked).length,
    newChecked: newTodos.filter((t) => t.checked).length,
    oldCovered: before.byApiName.size,
    newCovered: after.byApiName.size,
    oldSubSteps: before.orphans.length,
    newSubSteps: after.orphans.length,
    lostAchievements,
    lostTicks,
    oldChars: oldText.length,
    newChars: newText.length,
  };
}

/** 差异预览渲染成几行给人看的话。CLI 和 Dashboard 用同一份措辞 */
export function formatDiff(d) {
  const lines = [
    `  checkbox:${d.oldCount} → ${d.newCount}(已勾选 ${d.oldChecked} → ${d.newChecked})`,
    `  覆盖到的成就:${d.oldCovered} → ${d.newCovered}`,
    `  子步骤框:${d.oldSubSteps} → ${d.newSubSteps}`,
  ];
  if (d.oldChars || d.newChars) {
    const pct = d.oldChars ? Math.round(((d.newChars - d.oldChars) / d.oldChars) * 100) : 0;
    lines.push(`  正文字数:${d.oldChars} → ${d.newChars}(${pct >= 0 ? '+' : ''}${pct}%)`);
  }
  if (d.lostAchievements.length) {
    lines.push(`  ⚠️  ${d.lostAchievements.length} 个成就在新版里没有对应的 checkbox 了:`);
    for (const a of d.lostAchievements.slice(0, 8)) {
      lines.push(`       ${a.name}${a.wasChecked ? '(原来是勾上的)' : ''}`);
    }
    if (d.lostAchievements.length > 8) lines.push(`       …… 还有 ${d.lostAchievements.length - 8} 个`);
  }
  if (d.lostTicks.length) {
    lines.push(`  ⚠️  ${d.lostTicks.length} 个**手动勾上的子步骤框**会变回未勾选(它们不是成就,程序没法重新勾上):`);
    for (const t of d.lostTicks.slice(0, 5)) lines.push(`       ${t.text.split('\n')[0].slice(0, 50)}`);
    if (d.lostTicks.length > 5) lines.push(`       …… 还有 ${d.lostTicks.length - 5} 个`);
  }
  if (!d.lostAchievements.length && !d.lostTicks.length) {
    lines.push('  没有成就框丢失,也没有手动勾选会丢 —— 但正文会整份换成新写的');
  }
  return lines.join('\n');
}

/**
 * 花钱**之前**能算出来的那一半:旧攻略长什么样,以及哪些勾选一定会丢。
 *
 * 完整的新旧对照要等新攻略写出来才有,而确认要在花钱前问 —— 所以问的时候能给的是
 * 这份。它不完整,但**它包含唯一那件不可挽回的事**:手动勾上的子步骤框会变回未勾选。
 * 成就框不在此列,重新生成后 `computeCheckedKeys` 会按数据库照原样勾回去。
 */
export function overwritePreflight({ oldTodos, defs, oldText = '' }) {
  const { byApiName, orphans } = coverageOf(oldTodos, defs);
  return {
    count: oldTodos.length,
    checked: oldTodos.filter((t) => t.checked).length,
    covered: byApiName.size,
    subSteps: orphans.length,
    atRiskTicks: orphans.filter((t) => t.checked),
    chars: oldText.length,
  };
}

export function formatPreflight(p, { defsCount = null } = {}) {
  const lines = [
    `  现在这份:${p.count} 个 checkbox(已勾选 ${p.checked} 个),约 ${p.chars} 字`,
    `  其中认得出成就的 ${p.covered} 个${defsCount ? ` / 全作 ${defsCount} 个成就` : ''},子步骤框 ${p.subSteps} 个`,
  ];
  if (p.atRiskTicks.length) {
    lines.push(
      `  ⚠️  ${p.atRiskTicks.length} 个**手动勾上的子步骤框会变回未勾选** —— 它们不是成就,`,
      '      程序没法按 Steam 数据重新勾上。成就框不受影响,会照数据库勾回原样:'
    );
    for (const t of p.atRiskTicks.slice(0, 5)) lines.push(`       ${t.text.split('\n')[0].slice(0, 50)}`);
    if (p.atRiskTicks.length > 5) lines.push(`       …… 还有 ${p.atRiskTicks.length - 5} 个`);
  } else {
    lines.push('  没有手动勾选会丢失(勾上的框都认得出对应成就,会按数据库勾回来)');
  }
  return lines.join('\n');
}

/** 把备份里的纯文本抠出来,给差异预览算字数用 */
export function blocksToText(blocks) {
  const out = [];
  const walk = (list) => {
    for (const b of list ?? []) {
      const rt = b?.[b.type]?.rich_text;
      if (Array.isArray(rt)) out.push(richTextToPlain(rt));
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return out.join('\n');
}
