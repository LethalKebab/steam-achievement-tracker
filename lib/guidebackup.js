/**
 * Backup and diff preview before overwriting an existing guide (step 8 of the working order)
 * ------------------------------------------------
 * The landing gate is **split by reversibility, not by backend** (as settled in the design
 * document): a new file is written automatically once the machine gates pass, and overwriting an
 * existing one requires human confirmation. This file supplies the two things that must exist
 * before that confirmation — **a copy of the original that can be brought back**, and **a
 * statement of what will be lost**.
 *
 * ## Why the backup is block JSON rather than markdown
 *
 * On the Notion side what is stored is `fetchAllBlocks`'s raw JSON. Rendering it as markdown
 * would read better, but it is **lossy**: once the overwrite turns out to be wrong, something
 * readable cannot be put back. A backup's job is to be restorable, not to be readable. The
 * readable requirement is met by the diff preview below, which exists for a person to read.
 *
 * ## The diff preview is computed over achievement coverage, not line by line
 *
 * A regenerated guide is almost certain to be worded differently everywhere, so a line diff
 * reports every line as removed and re-added, and the noise buries the signal. What actually
 * needs a person's judgement is three things:
 *
 *  1. **Whether any achievement lost its checkbox in the new version** — that is a real regression
 *  2. **Which hand-ticked boxes revert to unticked** — achievement boxes are re-ticked from the
 *     database by `computeCheckedKeys`, but **sub-step boxes are not** (they are not achievements
 *     and match nothing). This is the only user data an overwrite genuinely destroys
 *  3. **How much the prose volume changed** — replacing nine thousand characters of hand-written
 *     notes with three thousand of generated text is something to see at the time, not afterwards
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveTodoToAchievement } from './guides.js';
import { resolveGuidePath } from './markdown.js';
import { extractNotionPageId, richTextToPlain } from './notion.js';

/** Where backups go. Like `.drafts/` and `.migrated/`, discovery is non-recursive and cannot reach in */
export const BACKUPS_DIR = '.backups';

/** `20260811-155712` — sortable, and several overwrites on one day do not collide */
export function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Save the original before overwriting. **Call before any write, and do not proceed with the
 * overwrite if it fails.**
 *
 * A failed backup is not the same as a failed archive: in `guidemigrate` a failed archive can be
 * waved through (everything has already landed safely by then), whereas here the backup is a
 * **precondition** of the overwrite — an overwrite without one is an irreversible deletion.
 *
 * `blocks` is the **raw block array**, not merely a count — the overwrite deletes the old content
 * by it immediately afterwards, and making the caller read the page again would open a gap
 * between what was backed up and what is deleted.
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
    // Read the backup itself back rather than reporting the source file's size — what matters
    // is the copy that was stored, and an incomplete copy should be visible here
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
 * Which achievements a guide covers, and which boxes reach no achievement (the sub-steps).
 *
 * It uses `audit`'s reverse lookup (`resolveTodoToAchievement`) rather than a second
 * implementation, so "which achievement is this box about" has the same answer in the preview
 * as it does in the audit.
 */
export function coverageOf(todos, defs) {
  const byApiName = new Map();
  const orphans = [];
  for (const t of todos) {
    // The lookup returns `{def, via}` rather than the def itself — `via` states whether it was
    // recognised by description or by name
    const hit = resolveTodoToAchievement(t.text, defs);
    if (hit?.def) byApiName.set(hit.def.api_name, t);
    else orphans.push(t);
  }
  return { byApiName, orphans };
}

/**
 * What an overwrite would change. **A pure function, so it is easy to test.**
 *
 * @param {object[]} oldTodos the old guide's checkboxes (both backends produce the same shape)
 * @param {object[]} newTodos the newly generated ones
 * @param {object[]} defs     this game's achievement definitions
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

  // The only user data an overwrite genuinely destroys: **hand-ticked sub-step boxes**.
  // Achievement boxes are re-ticked from the database by computeCheckedKeys, while sub-step boxes
  // match no achievement and come back unticked after regeneration
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

/** Render the diff preview as a few lines for a person to read. The CLI and the Dashboard share this wording */
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
 * The half that can be computed **before** any money is spent: what the old guide looks like, and
 * which ticks will certainly be lost.
 *
 * A complete before-and-after comparison only exists once the new guide has been written, while
 * the confirmation has to be asked beforehand — so this is what can be offered at that moment.
 * It is incomplete, but **it contains the one irreversible item**: hand-ticked sub-step boxes
 * revert to unticked. Achievement boxes are not in that category, as `computeCheckedKeys` re-ticks
 * them from the database after regeneration.
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

/**
 * The preflight for a partial rewrite. **It says the opposite of the whole-guide one**, which is
 * why it is a separate function rather than a parameter.
 *
 * A whole-guide preflight answers "what will you lose"; a partial one answers "what stays" — and
 * the latter is the entire point of the feature. One function forced to serve both questions
 * comes out wrong on both sides (this project has reached that same conclusion twice already, on
 * `inspectGuideDb` and `previewGuideRewrite`).
 *
 * `atRiskTicks` is **narrowed** here: only hand-ticks falling under the entries being changed are
 * lost, and nothing elsewhere is touched. `savedTicks` is that difference — and it has to be
 * reported, because it is **the only concrete, quantifiable benefit** of choosing a partial
 * rewrite over a whole one.
 */
export function patchPreflight({ oldTodos, defs, entries, oldText = '' }) {
  const full = overwritePreflight({ oldTodos, defs, oldText });
  const touched = new Set(entries.flatMap((e) => e.subTodos.map((s) => s.key)));
  const atRiskTicks = full.atRiskTicks.filter((t) => touched.has(t.key));
  const replacing = entries.reduce((n, e) => n + 1 + e.subTodos.length, 0);

  return {
    ...full,
    scope: entries.length,
    replacing,
    keeping: full.count - replacing,
    atRiskTicks,
    savedTicks: full.atRiskTicks.length - atRiskTicks.length,
  };
}

export function formatPatchPreflight(p, { defsCount = null } = {}) {
  const lines = [
    `  只改 ${p.scope} 条成就,其余 ${p.keeping} 个 checkbox 一字不动` +
      `(现有 ${p.count} 个,已勾选 ${p.checked},覆盖 ${p.covered}${defsCount ? `/${defsCount}` : ''} 个成就)`,
  ];
  if (p.atRiskTicks.length) {
    lines.push(`  ⚠️  ${p.atRiskTicks.length} 个手动勾上的子步骤框会变回未勾选(都在要改的这几条底下):`);
    for (const t of p.atRiskTicks.slice(0, 5)) lines.push(`       ${t.text.split('\n')[0].slice(0, 50)}`);
    if (p.atRiskTicks.length > 5) lines.push(`       …… 还有 ${p.atRiskTicks.length - 5} 个`);
  } else {
    lines.push('  没有手动勾选会丢失');
  }
  // This line is the only concrete, quantifiable advantage a partial rewrite has over a whole one; do not omit it
  if (p.savedTicks > 0) {
    lines.push(`  ✓ 另外 ${p.savedTicks} 个手动勾选保住了 —— 整篇重写会把它们全部变回未勾选`);
  }
  return lines.join('\n');
}

export function formatPreflight(p, { defsCount = null } = {}) {
  const lines = [
    `  现有 ${p.count} 个 checkbox(已勾选 ${p.checked}),约 ${p.chars} 字,` +
      `覆盖 ${p.covered}${defsCount ? `/${defsCount}` : ''} 个成就`,
  ];
  if (p.atRiskTicks.length) {
    lines.push(`  ⚠️  ${p.atRiskTicks.length} 个手动勾上的子步骤框会变回未勾选:`);
    for (const t of p.atRiskTicks.slice(0, 5)) lines.push(`       ${t.text.split('\n')[0].slice(0, 50)}`);
    if (p.atRiskTicks.length > 5) lines.push(`       …… 还有 ${p.atRiskTicks.length - 5} 个`);
  } else {
    lines.push('  没有手动勾选会丢失');
  }
  return lines.join('\n');
}

/** Extract the plain text from a backup, for the diff preview's character count */
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
