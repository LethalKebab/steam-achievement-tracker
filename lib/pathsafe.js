/**
 * Path containment: is this absolute path inside that root
 * ------------------------------------------------
 * Four places in this project answer the same question, and all four take their
 * input from outside:
 *
 * | Who | Where the path fragment comes from | What a miss costs |
 * |---|---|---|
 * | `markdown.resolveGuidePath` | `guides.url` (a database column) | reading, and **writing**, outside guides/ |
 * | `backup.safeGuidePath` | zip entry names (somebody else's backup file) | zip-slip: writing a file anywhere |
 * | `guidearchive.parseArchiveId` | an archive id sent from the browser | reading / deleting anywhere |
 * | `server.js`'s `/fonts/` | a URL path | reading any file |
 *
 * Writing it four times produced the predictable result: **two of them missed the
 * same detail.** Without a separator, `startsWith(root)` counts `…/guides-evil/x.md`
 * as "inside `…/guides`", because it genuinely does start with it — a **sibling
 * directory sharing a prefix** is the classic way this check leaks.
 *
 * So the predicate is written once, here. Not to save typing, but so that
 * "forgot the separator" has exactly one place it can happen. Each caller decides
 * for itself how to react to a miss (throw, return null, answer 403); that part
 * is supposed to differ.
 */
import { join, resolve, sep } from 'node:path';

/**
 * Is `full` **inside** `root`. Both are treated as absolute paths.
 *
 * **`root` itself does not count as inside.** Every caller wants "some file under
 * the root", and the root itself is a directory; anywhere that genuinely needs to
 * admit the root can add its own `=== root`, because that is its semantics, not
 * this function's.
 */
export function isInside(root, full) {
  const r = resolve(String(root ?? ''));
  const f = resolve(String(full ?? ''));
  return f.startsWith(r + sep);
}

/**
 * `root` + some segments → an absolute path, **or null if it doesn't hold up**.
 *
 * Two checks, and the order cannot be reversed:
 *
 * 1. **Every segment must be a plain filename** — no separator, not `.` or `..`,
 *    not empty. That is what a caller means by "segments", and `join` disagrees:
 *    on Windows it normalises `sub\x.md` into two segments, so one segment
 *    quietly becomes two. The result may still land inside the root, which is
 *    why `isInside` cannot see this — it only knows where the path ended up, not
 *    whether anything changed shape on the way.
 * 2. Only then, containment.
 *
 * Check 1 is redundant for both of today's callers (each validates first). It stays
 * because this function's contract has to stand on its own: handing it an
 * unwashed string should be safe.
 */
export function containedPath(root, ...parts) {
  const r = resolve(String(root ?? ''));
  const segs = parts.map((p) => String(p ?? ''));
  if (segs.some((s) => !s || s === '.' || s === '..' || /[/\\]/.test(s))) return null;
  const full = resolve(join(r, ...segs));
  return isInside(r, full) ? full : null;
}
