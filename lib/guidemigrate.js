/**
 * Move a local markdown guide into Notion
 * ------------------------------------------------
 * This looks like `guidegen`'s landing, but **it verifies something completely different**,
 * which is the reason this file exists.
 *
 * A generated guide has to pass `lintGuide`, because that content is fresh, nobody has read
 * it, and the gate is the only thing vouching for it. Migration is different: this guide
 * **already exists**, written by the user and in use for a long time. Holding it to the lint
 * is wrong — measured across the corpus, 330 achievements have no checkbox that name matching
 * can reach, so most local guides would fail the gate outright. **The user did not ask us to
 * grade his guide, he asked us to move it.**
 *
 * So what is verified here is **fidelity**: is what reads back from Notion the same thing the
 * file originally held.
 *
 *  - The same number of entries
 *  - The same text per entry (compared after `<br>`→newline and stripping `**`)
 *  - The same checked state — a move must never alter ticks, that is the sync system's boundary
 *
 * Any mismatch **leaves the local file alone** and reports the differences for a person to read.
 *
 * ## Order
 *
 * create the page → write the body → read back and verify fidelity → register (through the real
 * discovery logic) → **only then** archive the local file.
 * Archiving comes last because it is the one step in this chain that touches the user's file:
 * if anything before it fails, the local guide must still be sitting there untouched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { getGuide, getGame } from './db.js';
import { loadTodos, resolveGuidePath, UNDERLINE_SPAN_RE } from './markdown.js';
import { syncGuidesFromNotion } from './guides.js';
import { markdownToBlocks } from './notionblocks.js';
import { planNotionTarget, newGuideStatus, fillMissingIcon } from './notion.js';
import { fetchGameIcon } from './steam.js';
import { msg } from './messages.js';

/** Where a migrated local file goes. Like `.drafts/`, discovery is non-recursive and cannot see in */
export const MIGRATED_DIR = '.migrated';

/**
 * Reduce both sides to the same shape before comparing.
 *
 * The file holds `**name**<br>description`, while Notion reads back as `name\ndescription`
 * (the bold lives in annotations, not in plain_text). Without normalising, every single entry
 * would report "different" and this check would be useless.
 */
export const normalizeForCompare = (s) =>
  String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Same for the underline annotation: the file has `<span underline="true">…</span>`,
    // and Notion reads back only the text inside (the annotation lives in annotations)
    .replace(UNDERLINE_SPAN_RE, '$1')
    .replace(/\*\*/g, '')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

/**
 * Compare the source file's todos against the ones read back from Notion. **A pure function**,
 * so it is easy to test.
 *
 * @returns {{ok: boolean, problems: string[], count: number}}
 */
export function checkFidelity(sourceTodos, notionTodos) {
  const problems = [];
  const a = sourceTodos.map((t) => ({ text: normalizeForCompare(t.text), checked: Boolean(t.checked) }));
  const b = notionTodos.map((t) => ({ text: normalizeForCompare(t.text), checked: Boolean(t.checked) }));

  if (a.length !== b.length) {
    problems.push(`条目数对不上:文件里 ${a.length} 个,Notion 上 ${b.length} 个`);
  }

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].text !== b[i].text) {
      problems.push(`第 ${i + 1} 条文字对不上:\n    文件:${a[i].text.slice(0, 70)}\n    Notion:${b[i].text.slice(0, 70)}`);
    } else if (a[i].checked !== b[i].checked) {
      // Same text but a different tick is reported separately — a move altering ticks is more
      // insidious damage than losing text
      problems.push(`第 ${i + 1} 条勾选状态变了(${a[i].checked ? '已勾' : '未勾'} → ${b[i].checked ? '已勾' : '未勾'}):${a[i].text.slice(0, 40)}`);
    }
    if (problems.length >= 10) {
      problems.push('…… 后面的不再列了');
      break;
    }
  }

  return { ok: problems.length === 0, problems, count: a.length };
}

/**
 * Look before moving: what this guide contains, what the conversion will lose, and whether
 * Notion can take it. **Writes nothing.** Both the Dashboard and the CLI preview go through here.
 */
export async function planMigration(db, { notion, config, appid }) {
  const id = String(appid);
  const guide = getGuide(db, id);
  if (!guide) throw new Error(msg('mig.noGuide', { id }));
  if (guide.kind !== 'local') {
    throw new Error(msg('mig.alreadyNotion', { name: guide.name, url: guide.url }));
  }
  if (!notion?.configured) {
    throw new Error(msg('mig.notionMissing'));
  }

  const path = resolveGuidePath(config.guidesDir, guide.url);
  if (!existsSync(path)) throw new Error(msg('mig.fileMissing', { path }));

  const markdown = readFileSync(path, 'utf8');
  const { blocks, unconverted } = markdownToBlocks(markdown);
  const todos = loadTodos(path);
  if (!todos.length) {
    throw new Error(msg('mig.noCheckboxes', { path }));
  }

  // The page title uses the **game name**, not the filename — the other hundred-odd pages in
  // the guide database are game names, and planNotionTarget's same-title check goes by game name too
  const gameRow = getGame(db, id);
  const game = gameRow?.name || guide.name || id;
  // The status is computed from this game's real progress rather than a fixed value — see the
  // "hit for real" note in newGuideStatus
  const target = await planNotionTarget(notion, game, { statusValue: newGuideStatus(gameRow) });

  const byType = {};
  for (const b of blocks) byType[b.type] = (byType[b.type] ?? 0) + 1;

  return { guide, game, path, markdown, blocks, todos, unconverted, target, byType };
}

/**
 * Actually move it. `plan` comes from `planMigration` (computed here if not passed).
 *
 * @returns {Promise<object>} {url, count, unconverted, archivedTo}
 */
export async function migrateGuideToNotion(
  db,
  { notion, steam, config, appid, plan = null, onProgress = () => {} }
) {
  const p = plan ?? (await planMigration(db, { notion, config, appid }));

  let page = p.target.existingPage;
  // The icon uses the same source and the same tolerance rule as page creation in `guide-gen`.
  //
  // **This used not to set an icon at all**, on the grounds that "a move relocates something, it
  // doesn't rebuild it; dragging an icon in yourself is faster". In practice that reasoning did
  // not hold: migrated and generated pages sit side by side in one guide database, and a batch
  // with icons next to a batch without reads as the mover having dropped something — while
  // "drag one in yourself" trades one Steam call for one manual action by the user, repeated
  // for every guide moved. One extra API call is far cheaper.
  const icon = await fetchGameIcon(steam, appid).catch(() => null);

  if (page) {
    onProgress({ phase: 'fill', url: page.url, blocks: p.blocks.length });
    // Adopting somebody's empty page only fills an **empty** icon slot and never touches one
    // that is already set — same rule as landToNotion
    await fillMissingIcon(notion, page, icon);
  } else {
    page = await notion.createGuidePage({
      titleProperty: p.target.titleProperty,
      title: p.game,
      icon,
      status: p.target.status,
    });
    onProgress({ phase: 'create', url: page.url, blocks: p.blocks.length });
  }

  await notion.appendBlocks(page.id, p.blocks);
  onProgress({ phase: 'verify', url: page.url });

  // The fidelity check. **Not lintGuide** — reasoning at the top of this file
  const readBack = await notion.fetchAllToDoBlocks(page.id);
  const fidelity = checkFidelity(p.todos, readBack);
  if (!fidelity.ok) {
    throw new Error(msg('mig.readbackMismatch', { url: page.url, problems: fidelity.problems.join('\n  ') }));
  }

  // Registration goes through the real discovery logic, which reads the `appid:` line back off
  // the page. Failing to read it means that line wasn't written correctly, and upsertGuide's
  // ON CONFLICT flips this row from local to notion
  const discovered = await syncGuidesFromNotion(db, notion);
  if (!discovered.added.some((a) => a.appid === String(appid))) {
    throw new Error(msg('mig.appidNotFound', { url: page.url, appid }));
  }

  // Only the last step touches the user's file, and it **moves rather than deletes**. If any
  // earlier step failed, the local guide is still where it was
  const archivedTo = archiveLocalGuide(config, p.guide.url);
  onProgress({ phase: 'done', url: page.url, archivedTo });

  return { url: page.url, count: fidelity.count, unconverted: p.unconverted, archivedTo, game: p.game };
}

/**
 * Move a migrated local file into `guides/.migrated/`. **Never deletes.**
 *
 * A failed archive is not a failed migration: discovery skips a local file whose appid is
 * already registered as notion (the `existing.kind === 'notion' && !force` branch in
 * `syncGuidesFromMarkdown`), so a file left in place is at worst untidy and can never steal
 * the guide back. Reporting an already-successful migration as failed over this would be
 * raising a fake problem under a real problem's name.
 */
export function archiveLocalGuide(config, fileName) {
  try {
    const from = resolveGuidePath(config.guidesDir, fileName);
    const dir = join(config.guidesDir, MIGRATED_DIR);
    mkdirSync(dir, { recursive: true });
    const to = join(dir, fileName);
    renameSync(from, to);
    return to;
  } catch {
    return null;
  }
}
