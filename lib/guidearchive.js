/**
 * Guide archives: list, view, restore and delete the three archive directories under `guides/`
 * ------------------------------------------------------
 * `.backups/`, `.migrated/` and `.drafts/` were **write-only** — three write paths each put
 * things there, and before this file existed not one line in the project read them: no listing,
 * no restore, no cleanup (`drafts --clean` only deletes, and only from one directory). So the
 * promise that "an overwrite backs up first" was only half kept — the original was genuinely
 * saved, but **the only way to get it back was to copy it by hand in a file manager**.
 *
 * `guidebackup.js`'s header states that the Notion side stores raw JSON "because a backup's job
 * is to be restorable, not to be readable". This file is the other half of that sentence.
 *
 * ## The three directories are three different things, not three piles of rubbish
 *
 * | Directory | What is in it | What restoring means |
 * |---|---|---|
 * | `.backups/` | The original before an overwrite (`.md` for local guides, `.json` for a whole Notion page's blocks) | Write that version back |
 * | `.migrated/` | The **local original** left behind when a guide moved to Notion | Pull the guide back from Notion to local |
 * | `.drafts/` | A part-finished guide that failed validation three rounds running | Promote something that never passed validation |
 *
 * Only `.drafts/` genuinely holds unfinished intermediate output. The other two are **the only
 * surviving copy of some version of a guide**: the one in `.migrated/` was superseded by the
 * Notion page, and the one in `.backups/` by a newly generated guide. So deletion here always
 * requires a person to agree, and there is no "sweep anything older than N days".
 *
 * ## A restore is itself an overwrite, so it backs up first
 *
 * This project has one rule about overwriting: **an overwrite without a backup is an
 * irreversible deletion.** A restore is no exception — it goes through `backupGuide`, into the
 * same directory with the same naming. So the way out of "I restored the wrong one by mistake"
 * is the same as the way out of "I overwrote the wrong one by mistake", with nothing new to learn.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { containedPath, isInside } from './pathsafe.js';

import { getGame, getGuide, upsertGuide } from './db.js';
import { BACKUPS_DIR, backupGuide, blocksToText } from './guidebackup.js';
import { DRAFTS_DIR, guideFileName } from './guidegen.js';
import { MIGRATED_DIR, checkFidelity } from './guidemigrate.js';
import { readGuideHeader } from './guides.js';
import { extractNotionPageId, richTextToPlain } from './notion.js';
import { blocksForAppend } from './notionblocks.js';
import { sleep } from './steam.js';

/** The three directories scanned. This order is the ordering within one moment, but the list ends up sorted newest-first, so all this needs to be is complete */
export const ARCHIVE_DIRS = [BACKUPS_DIR, MIGRATED_DIR, DRAFTS_DIR];

/** What a row in the interface came from. **It names the origin, not the directory** — the user has never seen `.migrated/` */
export const ARCHIVE_LABEL = {
  [BACKUPS_DIR]: '覆盖前的原文',
  [MIGRATED_DIR]: '搬去 Notion 时留下的原件',
  [DRAFTS_DIR]: '没过校验的草稿',
};

/** The naming `backupGuide` uses: `<appid>-20260820-122121.md|json` */
const BACKUP_NAME_RE = /^(\d+)-(\d{8})-(\d{6})\.(md|json)$/;

/**
 * What a filename may be: **no separator, ending in `.md` or `.json`**, and nothing else.
 *
 * The extension rule does more than select a format; it simultaneously excludes names with
 * special meaning on Windows such as `C:`, `nul`, `COM1` and `....` — and it is the same
 * condition `describe()` filters the listing by, so "can be listed" and "can be clicked" are the
 * same set, with nothing that cannot be listed yet can be deleted.
 *
 * **Deliberately not narrowed to ASCII.** Filenames in `.migrated/` and `.drafts/` are the user's
 * own guide filenames. `guideFileName` does produce ASCII, but a file named in Chinese by hand is
 * still discovered by `syncGuidesFromMarkdown` and still gets moved — and narrowing would leave
 * that archive listable but impossible to restore or delete.
 */
const ARCHIVE_FILE_RE = /^[^/\\\0]+\.(md|json)$/;

/**
 * An archive id is `<directory>/<filename>`. **This string comes from the browser** and ends up
 * as the path of a `readFileSync` / `rmSync`, so the directory must be one of those three
 * literals and the filename must satisfy the rule above.
 */
export function parseArchiveId(config, id) {
  const raw = String(id ?? '');
  const slash = raw.indexOf('/');
  const dir = slash === -1 ? '' : raw.slice(0, slash);
  const file = slash === -1 ? '' : raw.slice(slash + 1);

  if (!ARCHIVE_DIRS.includes(dir)) throw new Error(`存档编号里的目录不认识:${raw}`);
  if (!ARCHIVE_FILE_RE.test(file)) throw new Error(`存档编号里的文件名不合法:${raw}`);

  // A backstop. **Measured to be unreachable**: the rule above forbids `/` and `\`, so the joined
  // path cannot escape `root` — `..`, `C:`, ADS and similar shapes were each tried, and all of
  // them were rejected by the previous line. It stays because what it guards against is that rule
  // being relaxed later, and relaxing it is exactly the kind of change made casually
  const path = containedPath(join(config.guidesDir, dir), file);
  if (!path) throw new Error(`存档编号越界了:${raw}`);
  return { dir, file, path };
}

/**
 * The inverse of `parseArchiveId`: a freshly written absolute path → an archive id.
 *
 * It exists so that **nowhere else assembles an id from strings**. The id's format is defined by
 * the parser above, and if the assembly lived in `server.js` the two would eventually disagree —
 * with the symptom being a 「删除备份」 button that does nothing when clicked, rather than an error.
 *
 * Returns `null` for anything outside those three directories, and the caller uses that to decide
 * whether to offer the action at all.
 */
export function archiveIdOf(config, absPath) {
  if (!absPath) return null;
  const full = resolve(String(absPath));
  for (const dir of ARCHIVE_DIRS) {
    const root = resolve(join(config.guidesDir, dir));
    if (!isInside(root, full)) continue;
    const file = full.slice(root.length + 1);
    if (file.includes(sep) || file.includes('/')) continue; // Direct children only
    try {
      parseArchiveId(config, `${dir}/${file}`); // Validate through the same parser
      return `${dir}/${file}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** `20260820` + `122121` → that moment in local time. A file's mtime is disturbed by copying and syncing; the filename is not */
function stampToDate(day, time) {
  const n = (s, a, b) => Number(s.slice(a, b));
  const d = new Date(
    n(day, 0, 4), n(day, 4, 6) - 1, n(day, 6, 8),
    n(time, 0, 2), n(time, 2, 4), n(time, 4, 6)
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The to_do blocks in a backup, depth first. **The order must match `fetchAllToDoBlocks`**, or the read-back comparison is all noise */
export function todosFromBlocks(blocks, out = []) {
  for (const b of blocks ?? []) {
    if (b?.type === 'to_do') {
      out.push({ text: richTextToPlain(b.to_do?.rich_text), checked: Boolean(b.to_do?.checked) });
      todosFromBlocks(b.children, out);
      continue;
    }
    if (b?.children?.length) todosFromBlocks(b.children, out);
  }
  return out;
}

/** What an archive looks like in the listing. Returns null for anything unreadable or not put there by us, which removes it from the listing */
function describe(db, config, dir, file) {
  const path = join(config.guidesDir, dir, file);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const isJson = file.endsWith('.json');
  if (!isJson && !file.endsWith('.md')) return null;

  const base = {
    id: `${dir}/${file}`,
    dir, file,
    label: ARCHIVE_LABEL[dir],
    bytes: stat.size,
    savedAt: stat.mtime.toISOString(),
  };

  // A `.backups/` filename carries the appid and the timestamp. **The copy inside the JSON is not
  // read** — listing once would mean reading four or five block dumps of a hundred-odd KB each,
  // purely to obtain two fields the filename already holds
  const named = BACKUP_NAME_RE.exec(file);
  if (named) {
    const [, appid, day, time] = named;
    const at = stampToDate(day, time);
    const game = getGame(db, appid);
    return {
      ...base,
      appid,
      game: game?.name || `AppID ${appid}`,
      // The game is not in the library = there is no row for it on the Dashboard, so this archive
      // is **unreachable** from the primary entry point. Those are the sole reason the full
      // listing on the settings page exists
      orphan: !game,
      kind: isJson ? 'notion' : 'local',
      savedAt: at ? at.toISOString() : base.savedAt,
    };
  }

  // `.migrated/` and `.drafts/`: the filename is the guide's filename, and the appid is only in the body
  let header = { appid: null, title: '' };
  try {
    header = readGuideHeader(readFileSync(path, 'utf8'));
  } catch {
    /* Unreadable means no header; it is still listed below — an archive that cannot be listed does not exist */
  }
  const game = header.appid ? getGame(db, header.appid) : null;
  return {
    ...base,
    appid: header.appid,
    game: game?.name || header.title || file,
    // A file with no appid line counts as an orphan too: it cannot even answer which game it
    // belongs to, so searching by game will never find it
    orphan: !game,
    kind: 'local',
  };
}

/**
 * What the three directories currently hold. **Newest first** — what is being looked for is
 * almost always the version that was just overwritten.
 *
 * `appid` is the **primary usage**: the everyday entry point is the ⋯ menu on a game's row on the
 * Dashboard, and the question there is always "the earlier versions of this one game". The
 * unfiltered listing has only two remaining uses — computing the total size, and finding
 * `orphan` entries (games deleted from the library, which no row can reach any more).
 */
export function listArchives(db, config, { appid = null } = {}) {
  const want = appid == null ? null : String(appid);
  const out = [];
  for (const dir of ARCHIVE_DIRS) {
    const abs = join(config.guidesDir, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      const entry = describe(db, config, dir, file);
      if (!entry) continue;
      if (want !== null && entry.appid !== want) continue;
      out.push(entry);
    }
  }
  out.sort((a, b) => (a.savedAt === b.savedAt ? a.file.localeCompare(b.file) : a.savedAt < b.savedAt ? 1 : -1));
  return out;
}

/**
 * An archive's content, for looking before restoring.
 *
 * The Notion kind is block JSON, rendered to plain text here — **for a person to read only, never
 * used in the restore**. A restore always uses the raw blocks (see the file header: the readable
 * version is lossy).
 */
export function readArchive(config, id) {
  const { dir, file, path } = parseArchiveId(config, id);
  const raw = readFileSync(path, 'utf8');
  if (!file.endsWith('.json')) return { id, dir, file, kind: 'local', text: raw };

  const data = JSON.parse(raw);
  const blocks = data.blocks ?? [];
  return {
    id, dir, file,
    kind: 'notion',
    url: data.url ?? '',
    savedAt: data.savedAt ?? null,
    blocks: blocks.length,
    todos: todosFromBlocks(blocks).length,
    text: blocksToText(blocks),
  };
}

/**
 * Write a local archive back into `guides/`.
 *
 * **Which filename it lands as** takes two forms: filenames in `.migrated/` and `.drafts/` are
 * already guide filenames and are used as they are; a `.backups/` name is `<appid>-<time>.md`,
 * which is not a guide name and needs one — preferring the local filename this game is currently
 * registered under (that being "back where it was"), and generating one only if there is none.
 */
async function restoreLocal(db, { config, dir, file, path, now }) {
  const text = readFileSync(path, 'utf8');
  const { appid, title } = readGuideHeader(text);
  if (!appid) {
    throw new Error(
      `${file} 的开头没有 \`appid: NNNNNN\` 行 —— 恢复过去也不会被攻略发现逻辑登记,` +
        '等于放了个看不见的文件。先在文件里补上那一行。'
    );
  }

  const existing = getGuide(db, appid);
  const target =
    dir === BACKUPS_DIR
      ? existing?.kind === 'local'
        ? existing.url
        : guideFileName(getGame(db, appid)?.name || title || appid, appid)
      : file;
  const to = join(config.guidesDir, target);

  // A restore is an overwrite too. It goes through `backupGuide` rather than copying by hand: the
  // same directory and the same naming, so "I restored the wrong one and want to undo it" looks
  // exactly like "I overwrote the wrong one and want to undo it" in the archive listing
  const backup = existsSync(to)
    ? await backupGuide(config, { guide: { kind: 'local', url: target }, appid, now })
    : null;

  writeFileSync(to, text);

  // Register it as local. **This displaces the Notion page from the guides table** — one appid can
  // have only one guide backend, and the user has just stated explicitly that they want this local
  // copy. The Notion page itself is untouched, and the 「搬去 Notion」 button can move it back
  const action = upsertGuide(db, { appid, name: title || target, url: target, kind: 'local' });

  return {
    ok: true,
    kind: 'local',
    appid,
    game: getGame(db, appid)?.name || title || `AppID ${appid}`,
    file: target,
    path: to,
    action,
    backedUpTo: backup?.path ?? null,
    unregisteredNotion: existing?.kind === 'notion' ? existing.url : null,
  };
}

/**
 * Write a Notion archive back to the page it came from.
 *
 * **Delete first, then write**, the same order as `landToNotion`. The reverse (write then delete)
 * leaves both the old and the new content on the page when it fails, and running it again makes
 * three copies; deleting first means a failure is fixed by re-running — and the original is in the
 * backup that was just taken.
 */
async function restoreNotion(db, { config, notion, path, now }) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const appid = String(data.appid ?? '');
  const url = String(data.url ?? '');
  if (!url) throw new Error('这份备份里没记页面地址,没法知道该恢复到哪一页。');
  if (!notion?.configured) {
    throw new Error('要把攻略写回 Notion,但 Notion 还没配置 —— 去设置页填 Notion 的 access token。');
  }

  const { blocks, dropped } = blocksForAppend(data.blocks ?? []);
  if (!blocks.length) throw new Error('这份备份里没有一个能写回去的块,那一页不动。');

  const pageId = extractNotionPageId(url);

  // Save what is on the page **now** before acting, and delete by the blocks it returns — letting
  // the backup and the deletion each read the page separately would open a gap in which what was
  // backed up is not what gets deleted
  const backup = await backupGuide(config, { guide: { kind: 'notion', url }, appid, notion, now });

  for (const b of backup.blocks) {
    await notion.deleteBlock(b.id);
    await sleep(200); // Deleting dozens or hundreds of blocks without pause hits the rate limit, and by then half the old content is already gone
  }
  await notion.appendBlocks(pageId, blocks);

  // Read back and compare. **The same checkFidelity as migration uses** — written ≠ written
  // correctly, and that matters especially on this path: the old content is already deleted, so if
  // the new content did not land the page is empty
  const fidelity = checkFidelity(todosFromBlocks(data.blocks), await notion.fetchAllToDoBlocks(pageId));
  if (!fidelity.ok) {
    throw new Error(
      `写回去之后回读对不上(${url}):\n  ` +
        fidelity.problems.join('\n  ') +
        `\n  刚才那一版存在 ${backup.path},页面自己看一眼决定怎么办。`
    );
  }

  return {
    ok: true,
    kind: 'notion',
    appid,
    game: getGame(db, appid)?.name || `AppID ${appid}`,
    url,
    count: fidelity.count,
    dropped,
    backedUpTo: backup.path,
  };
}

/**
 * Restore one archive. `.json` goes back to Notion and `.md` back to a local file — **routed by
 * the archive's own origin, not by the game's current backend**: what was stored is what is
 * returned, and changing backend is a different button's job.
 */
export async function restoreArchive(db, { config, notion = null, id, now = new Date() }) {
  const { dir, file, path } = parseArchiveId(config, id);
  if (!existsSync(path)) throw new Error(`这份存档已经不在了:${path}`);
  return file.endsWith('.json')
    ? restoreNotion(db, { config, notion, path, now })
    : restoreLocal(db, { config, dir, file, path, now });
}

/**
 * Delete one archive.
 */
export function deleteArchive(config, id) {
  const { dir, file, path } = parseArchiveId(config, id);
  if (!existsSync(path)) return { ok: true, id, dir, file, bytes: 0, alreadyGone: true };
  const bytes = statSync(path).size;
  rmSync(path, { force: true });
  return { ok: true, id, dir, file, bytes, alreadyGone: false };
}

/**
 * Delete **the specific archives named**. The settings page's 「全部删除」 goes through here.
 *
 * **The parameter is a list of ids, never "clear the directories"**, and that is not for
 * convenience. Between the listing being painted and the button being pressed, a rewrite may have
 * finished in the background — leaving a `.backups/` entry that was never on screen. "Clear the
 * directory" would consume that too; naming ids can at worst under-delete, and an under-delete is
 * visible on the next repaint.
 *
 * **One failure must not take the rest down with it.** `parseArchiveId` throws on a hostile id, and
 * with the try outside the loop the first bad id would displace every id after it. So the try is
 * **inside** the loop, and a bad one is recorded in `failed` while the loop continues.
 *
 * As for "this single action destroys the only surviving copy of some version of a guide" — that
 * sentence belongs to the button, not to this function. This only deletes what was named and
 * reports the count honestly.
 */
export function deleteArchives(config, ids) {
  let deleted = 0;
  let bytes = 0;
  const failed = [];
  for (const id of ids ?? []) {
    try {
      const r = deleteArchive(config, id);
      deleted += 1;
      bytes += r.bytes;
    } catch (err) {
      failed.push({ id: String(id), error: String(err.message ?? err) });
    }
  }
  return { ok: true, deleted, bytes, failed };
}
