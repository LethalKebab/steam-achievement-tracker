/**
 * Daily auto-sync: automatically checks off Notion guide-page checkboxes to match
 * achievements you've actually unlocked on Steam.
 *
 * Design notes (replaces the earlier approach of manually cross-checking each game via
 * Claude Code):
 * - Deciding "should this game be synced" doesn't look at Notion's Status property
 *   (Staged/Paused/Done etc.) - it uses RAW DATA's own achieved-count < total-achievements
 *   directly (skipping games already at 100% and games with no achievement system).
 *   Reason: an automated script doesn't have the token-cost concerns a chat-driven pass
 *   does - re-running against an already-"Done" game is just a no-op (no new unlocks =
 *   no change), so this simple achievement-count filter is good enough.
 * - Name matching requires an **exact** match against a title candidate segment (see
 *   extractTitleCandidates_ below) - not a substring/prefix match. Matches are applied
 *   automatically with no second confirmation step; every change is written to the
 *   "Sync Log" tab for after-the-fact review.
 * - The Notion API calls here are made **directly by this script** (not routed through
 *   Claude Code), so a separate Notion Internal Integration token is required, stored in
 *   Script Properties (never hardcoded, never committed to a repo):
 *     Apps Script editor -> Project Settings (gear icon) -> Script Properties -> Add property
 *     Name: NOTION_TOKEN   Value: your Notion Internal Integration secret
 *   and the relevant Notion pages (or their shared parent page, e.g. "Entertainment")
 *   need to be added to that integration's connections (Notion page top-right ••• ->
 *   Connections -> Add connection), otherwise the API returns 404/no access.
 *
 * First-time use:
 * 1. Run testSyncOneGameCheckboxSync('<some appid>') to manually test one game first,
 *    check the Sync Log results look right before deciding to install the auto trigger.
 * 2. Once confirmed, run installDailyCheckboxSyncTrigger() once to install the daily
 *    schedule (defaults to 8am, project timezone; change the atHour argument below and
 *    re-run this function to adjust the time).
 */

/**
 * Entry point that runs automatically every day: scans RAW DATA for games that have a
 * guide link, aren't at 100%, and have an achievement system, syncs Steam's unlock state
 * to the Notion guide page's checkboxes for each, and writes a summary to the
 * "Sync Log" tab.
 */
function dailyCheckboxSync() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // Columns A-E: Status, AppID, Name, Achieved count, Total achievements
  const rawData = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const guideByAppid = {};
  listGuideRows().forEach(g => { guideByAppid[g.appid] = g; });

  const candidates = rawData
    .filter(r => {
      const appid = String(r[1]);
      const achieved = r[3];
      const total = r[4];
      return appid && typeof total === 'number' && total > 0 && achieved < total && guideByAppid[appid];
    })
    .map(r => ({ appid: String(r[1]), name: r[2] }));

  const allLogs = [];
  candidates.forEach(c => {
    const guide = guideByAppid[c.appid];
    const logs = processGameCheckboxSync_(c.appid, c.name, guide.url);
    allLogs.push.apply(allLogs, logs);
    Utilities.sleep(350); // leave some margin for the Notion API to avoid 429 rate-limiting
  });

  writeSyncLog_(allLogs);
}

/**
 * Manually test a single game without waiting for the daily trigger. appid can be a
 * string or a number.
 * Select this function in the Apps Script editor, set the argument, and click "Run" -
 * results are written to Sync Log and also visible via Logger.log output under
 * View -> Executions.
 */
function testSyncOneGameCheckboxSync(appid) {
  appid = String(appid);
  const guide = listGuideRows().find(g => g.appid === appid);
  if (!guide) throw new Error('appid ' + appid + ' has no guide link in the GUIDES sheet, can\'t sync');

  const logs = processGameCheckboxSync_(appid, guide.name, guide.url);
  writeSyncLog_(logs);
  Logger.log(JSON.stringify(logs, null, 2));
  return logs;
}

/**
 * Installs the daily trigger that runs dailyCheckboxSync automatically.
 * Clears any existing same-named trigger first to avoid duplicates, so it's safe to
 * re-run this function whenever you want to change the time.
 */
function installDailyCheckboxSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyCheckboxSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCheckboxSync')
    .timeBased()
    .everyDays(1)
    .atHour(8) // 8am, project timezone (change this number to adjust the time)
    .create();
}

/** Uninstalls the daily trigger (call this if you no longer want it to run automatically). */
function uninstallDailyCheckboxSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyCheckboxSync') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------------------
// Per-game sync logic
// ---------------------------------------------------------------------------

/**
 * For one game: fetches Steam's unlocked achievements + the Notion guide page's checkbox
 * list, name-matches them, and checks the matches.
 * Returns the log rows produced this run (each row is [timestamp, AppID, Name,
 * Achievement name, result description]).
 */
function processGameCheckboxSync_(appid, gameName, url) {
  const logEntries = [];

  let unlocked;
  try {
    unlocked = getUnlockedAchievements(appid); // reuses steam_guides_sync.gs
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', 'Skipped - could not fetch Steam unlock data: ' + err]);
    return logEntries;
  }
  if (!unlocked || unlocked.length === 0) return logEntries;

  let pageId;
  try {
    pageId = extractNotionPageId_(url);
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', 'Skipped - could not parse the Notion link: ' + err]);
    return logEntries;
  }

  let todos;
  try {
    todos = fetchAllToDoBlocks_(pageId);
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', 'Skipped - could not read the Notion page (check whether the integration is connected to it): ' + err]);
    return logEntries;
  }

  if (todos.length === 0) {
    logEntries.push([new Date(), appid, gameName, '', 'Skipped - no checkboxes found on the page (may be a database-only/notes-only page, needs manual handling)']);
    return logEntries;
  }

  const uncheckedTodos = todos.filter(t => !t.checked);
  const claimedBlockIds = {};

  unlocked.forEach(ach => {
    const nameCnNorm = normalizeText_(ach.nameCn);
    const nameEnNorm = normalizeText_(ach.nameEn);
    if (!nameCnNorm && !nameEnNorm) return;

    for (let i = 0; i < uncheckedTodos.length; i++) {
      const todo = uncheckedTodos[i];
      if (claimedBlockIds[todo.id]) continue;
      const todoNorm = normalizeText_(todo.text);
      if (!todoNorm) continue;

      // Prefix matching (even with a boundary-character check) still isn't strict enough:
      // a short achievement name can be a strict prefix of a different, unrelated, harder
      // achievement's name that happens to share its first few characters. If the short
      // name's real checkbox has already been checked (so it's no longer in the pool to
      // match against), the algorithm could end up checking the wrong "cousin
      // achievement's" checkbox instead - one that's actually still locked.
      // Fixed by requiring an **exact match**: split the checkbox text into "title
      // candidate segments" (on <br>-converted line breaks, and on a colon/dash within a
      // single line), and only count it as a match if the achievement name exactly equals
      // one of those candidate segments - no more accepting "prefix + boundary looks ok" as
      // a weak match. (Splitting on line breaks first also naturally handles achievement
      // names that themselves contain a colon, since the colon sits before the line break
      // and survives intact in that line's candidate segment.)
      const candidates = extractTitleCandidates_(todoNorm);
      const isMatch =
        (nameCnNorm && candidates.indexOf(nameCnNorm) !== -1) ||
        (nameEnNorm && candidates.indexOf(nameEnNorm) !== -1);

      if (isMatch) {
        claimedBlockIds[todo.id] = true;
        try {
          notionApiRequest_('patch', '/blocks/' + todo.id, { to_do: { checked: true } });
          logEntries.push([new Date(), appid, gameName, ach.nameCn || ach.nameEn, 'Checked: ' + todo.text.slice(0, 60)]);
        } catch (err) {
          logEntries.push([new Date(), appid, gameName, ach.nameCn || ach.nameEn, 'Check failed: ' + err]);
        }
        break; // this achievement is handled - no need to keep looking for other same-named checkboxes
      }
    }
  });

  return logEntries;
}

/** Appends log rows to the "Sync Log" tab, creating it first if it doesn't exist. */
function writeSyncLog_(entries) {
  if (!entries || entries.length === 0) return;
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName('Sync Log');
  if (!sheet) {
    sheet = ss.insertSheet('Sync Log');
    sheet.getRange(1, 1, 1, 5).setValues([['时间', 'AppID', '游戏名', '成就', '结果']]);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, entries.length, 5).setValues(entries);
}

// ---------------------------------------------------------------------------
// Notion API helper functions
// ---------------------------------------------------------------------------

/**
 * Extracts the page ID (standard dashed UUID format, which the Notion API requires) from
 * a Notion link stored in the GUIDES sheet.
 * Handles links whose trailing ID may or may not have dashes, and may or may not have a
 * trailing ?query.
 */
function extractNotionPageId_(url) {
  const clean = String(url).split('?')[0];
  const match = clean.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i);
  if (!match) throw new Error('Could not extract a Notion page ID from URL: ' + url);
  const id = match[1].replace(/-/g, '');
  return id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
}

/**
 * Recursively fetches every to_do-type child block under a block (including ones nested
 * inside containers like toggle/column blocks).
 * Returns [{id, text, checked}, ...]
 *
 * Special handling for child pages: some games (e.g. Civilization VI) put their
 * achievement checklist in a child page under the main guide page (commonly titled
 * "Achievements"), rather than flattened directly into the main page - in that case, only
 * child pages whose title looks like an achievement list are recursed into; unrelated
 * child pages (e.g. "Retrospective"/"Tutorial") are not searched, to avoid wasted API
 * calls and false matches against unrelated content.
 *
 * Child databases (child_database - e.g. Crusader Kings III's original format, which
 * tracked achievements via an embedded database with a "Done" checkbox property instead
 * of markdown checkboxes) and links to other pages (link_to_page) are out of scope for
 * this function and are skipped when encountered - that kind of page needs entirely
 * different sync logic (querying database rows and updating a property, rather than
 * editing a block) - see PROJECT_CONTEXT.md.
 */
function fetchAllToDoBlocks_(blockId, results) {
  results = results || [];
  let cursor = null;
  do {
    const path = '/blocks/' + blockId + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
    const data = notionApiRequest_('get', path);
    (data.results || []).forEach(block => {
      if (block.type === 'to_do') {
        results.push({
          id: block.id,
          text: richTextToPlain_(block.to_do.rich_text),
          checked: !!block.to_do.checked
        });
        return;
      }

      if (block.type === 'child_page') {
        if (/成就|achievement/i.test(block.child_page.title || '')) { // matches "成就" (Chinese for "achievement") too - guide pages are bilingual
          fetchAllToDoBlocks_(block.id, results);
        }
        return;
      }

      const skipTypes = ['child_database', 'link_to_page'];
      if (block.has_children && skipTypes.indexOf(block.type) === -1) {
        fetchAllToDoBlocks_(block.id, results);
      }
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function richTextToPlain_(richText) {
  return (richText || []).map(function (t) { return t.plain_text; }).join('');
}

/**
 * Lowercases, strips markdown bold asterisks, normalizes literal <br> into a real
 * newline, and collapses extra whitespace - but **keeps** punctuation (colons, dashes,
 * newlines, etc.), since extractTitleCandidates_ relies on that punctuation to find
 * segment boundaries; it can't be stripped outright.
 */
function normalizeText_(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Splits a checkbox's text into "title candidate segments," used to do an **exact** match
 * against an achievement name (rather than a prefix/substring match, which would let a
 * short achievement name incorrectly match a different, longer achievement name that
 * merely happens to share the same first few characters).
 *
 * Split priority:
 * 1. Split on line breaks first (corresponding to a "title<br>description" page format
 *    converted to a real newline; also naturally handles a two-line "English name /
 *    localized name / description" layout as two separate candidates). This also
 *    naturally supports an achievement name that itself contains a colon, since the
 *    colon sits before the line break and stays intact in that line's candidate segment.
 * 2. If the whole text is a single line separating title and description with a colon or
 *    dash (pages that don't use <br>, e.g. "Location: the location's secret."), the part
 *    before the first colon/dash is also added as a candidate.
 * 3. The whole original text is also a candidate (in case there's no description at all
 *    and the entire checkbox line is just the achievement name).
 */
function extractTitleCandidates_(text) {
  const candidates = [];
  text.split('\n').forEach(function (line) {
    const t = line.trim();
    if (t) candidates.push(t);
  });
  const colonIdx = text.search(/[:：]/);
  if (colonIdx > 0) candidates.push(text.substring(0, colonIdx).trim());
  const dashIdx = text.indexOf(' - ');
  if (dashIdx > 0) candidates.push(text.substring(0, dashIdx).trim());
  const whole = text.trim();
  if (whole) candidates.push(whole);
  return candidates;
}

/**
 * Unified Notion API call wrapper. Reads the token from Script Properties (never
 * hardcoded in code).
 * method: 'get' | 'patch' etc.; path: starts with /blocks/..., no domain.
 */
function notionApiRequest_(method, path, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) {
    throw new Error('NOTION_TOKEN is not set. Add it under Project Settings (gear icon) -> Script Properties, with your Notion Internal Integration secret as the value');
  }
  const options = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, options);
  const code = res.getResponseCode();

  if (code === 429) {
    Utilities.sleep(1000);
    return notionApiRequest_(method, path, payload); // simple single retry
  }

  const body = JSON.parse(res.getContentText());
  if (code >= 400) {
    throw new Error('Notion API error ' + code + ': ' + (body.message || res.getContentText()));
  }
  return body;
}
