/**
 * Re-icon guide pages that carry the 32×32 square icon
 * ------------------------------------------------
 * `fetchGameIcon` used to prefer Steam's `img_icon_url` asset, because `GetOwnedGames` hands out
 * its hash for free. That asset is **32×32**, and Notion draws a page icon several times larger,
 * so nearly every page this program wrote ended up with a visibly soft icon. `lib/steam.js` now
 * resolves the 460×215 store header first — but that only helps pages written from here on, since
 * `fillMissingIcon` fills an empty slot and never touches one that is filled.
 *
 * This is the deliberate exception, and it is deliberately narrow.
 *
 * ## What it will replace, and what it will not
 *
 * **Only an `external` icon whose address is the square-icon path this program itself writes.**
 * That signature is not a heuristic about what an image looks like: it is the exact URL shape
 * `fetchGameIcon`'s last branch produces, and nothing else writes it.
 *
 * Everything else is left alone, because everything else is a choice somebody made:
 *
 *  - an **emoji** — picked by hand, and no game art is an improvement on a deliberate emoji
 *  - a **`file` icon** — Notion hosts it, so somebody uploaded or replaced it. This program only
 *    ever sets `external` icons, so a `file` icon is proof of a human edit
 *  - **any other external address** — an image found somewhere and pasted in. Measured on a real
 *    library: one page carried a 225×225 from Google Images, which is sharper than what we would
 *    put there and is in any case not ours to overwrite
 *  - **no icon at all** — that is `fillMissingIcon`'s job, on its own rule, and running two
 *    different policies over the same slot from two places is how a rule stops being a rule
 *
 * ## Replacing like with like is not a replacement
 *
 * A game with no store asset resolves back to the same square icon (that is the fallback's whole
 * purpose). Writing it again would spend a Notion request to store the identical string and report
 * a page as fixed that is exactly as soft as before, so an unchanged address is skipped and said
 * so. **The count has to mean "this page got sharper".**
 */
import { allGuides } from './db.js';
import { extractNotionPageId } from './notion.js';
import { fetchGameIcon, sleep } from './steam.js';

/**
 * The square-icon address, as `fetchGameIcon` assembles it.
 *
 * Anchored at both ends and matched against the whole URL: a loose `includes('steamcommunity')`
 * would also catch a link somebody pasted from a community page, which is the one direction that
 * destroys something.
 */
export const SQUARE_ICON_RE =
  /^https?:\/\/[^/]*steamstatic\.com\/steamcommunity\/public\/images\/apps\/\d+\/[0-9a-f]+\.jpg$/i;

/** Whether a page's current icon is the 32×32 square icon this program writes — see the note above */
export function isSquareGameIcon(icon) {
  if (icon?.type !== 'external') return false;
  return SQUARE_ICON_RE.test(icon.external?.url ?? '');
}

/** Between two pages. Same reasoning as the 200/350ms pauses in notion.js — a sweep is the shape that hits the rate limit */
const PAGE_PAUSE_MS = 250;

/**
 * Walk every Notion guide and re-icon the ones still on the square icon.
 *
 * @returns {Promise<{pages:number, replaced:number, logs:Array<{appid:string, gameName:string, result:string}>}>}
 *          `logs` carries one entry per page **that was not skipped for having a chosen icon**, so
 *          the caller can print what happened without printing a hundred lines of "left alone".
 */
export async function refreshGuideIcons(db, steam, { notion, dryRun = false, onProgress = null } = {}) {
  const rows = allGuides(db).filter((g) => g.kind === 'notion' && g.url);
  const logs = [];
  let replaced = 0;
  let done = 0;

  for (const row of rows) {
    const appid = String(row.appid);
    const gameName = row.name ?? appid;
    onProgress?.({ done: ++done, total: rows.length, name: gameName });
    // **Per page, not per write.** Every page below costs a Notion read whether or not anything is
    // replaced, so pacing only the writes leaves a --dry-run sweep firing a hundred reads flat out
    if (done > 1) await sleep(PAGE_PAUSE_MS);

    let pageId;
    try {
      pageId = extractNotionPageId(row.url);
    } catch {
      logs.push({ appid, gameName, result: 'bad-url' });
      continue;
    }

    let icon;
    try {
      icon = await notion.fetchPageIcon(pageId);
    } catch {
      // One unreadable page must not end the sweep — the remaining hundred are still fixable
      logs.push({ appid, gameName, result: 'unreadable' });
      continue;
    }

    // The common case, and the quiet one: this page's icon is somebody's choice
    if (!isSquareGameIcon(icon)) continue;

    const fresh = await fetchGameIcon(steam, appid).catch(() => null);
    if (!fresh) {
      logs.push({ appid, gameName, result: 'no-source' });
      continue;
    }
    if (fresh === icon.external.url) {
      logs.push({ appid, gameName, result: 'no-better-source' });
      continue;
    }

    if (dryRun) {
      replaced++;
      logs.push({ appid, gameName, result: 'would-replace' });
      continue;
    }

    try {
      await notion.setPageIcon(pageId, fresh);
      replaced++;
      logs.push({ appid, gameName, result: 'replaced' });
    } catch {
      logs.push({ appid, gameName, result: 'write-failed' });
    }
  }

  return { pages: rows.length, replaced, logs };
}
