/**
 * Guide-link sync tool: called remotely by Claude Code (or any HTTP client) through a
 * separate Web App deployment (its own deployment, access "Anyone", independent of and
 * unaffected by the Dashboard's deployment), to sync guide links from Notion into the
 * GUIDES tab without manual copy-pasting.
 *
 * Security relies on the SYNC_SECRET random token: a request body without the correct
 * token is rejected outright.
 * Note: this token is as sensitive as the Steam API key - it lives in Script Properties,
 * never in code, never committed to a public repo.
 * Setup: Project Settings (gear icon) -> Script Properties -> add SYNC_SECRET, with a
 * value you generate yourself (e.g. run `openssl rand -hex 32`).
 */
const SYNC_SECRET = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');

/**
 * POST entry point: JSON request body shaped { token, action, payload }.
 * Supported actions: listOwnedGames / listGuideRows / upsertGuideLinks
 */
function doPost(e) {
  let body;
  try {
    // e.postData.contents has a decoding bug with multi-byte UTF-8 characters;
    // specifying the encoding explicitly is more reliable
    body = JSON.parse(e.postData.getDataAsString('UTF-8'));
  } catch (err) {
    return jsonResponse_({ error: 'invalid JSON body' });
  }

  if (body.token !== SYNC_SECRET) {
    return jsonResponse_({ error: 'unauthorized' });
  }

  try {
    let result;
    switch (body.action) {
      case 'listOwnedGames':
        result = listOwnedGames();
        break;
      case 'listGuideRows':
        result = listGuideRows();
        break;
      case 'upsertGuideLinks':
        result = upsertGuideLinks(body.payload);
        break;
      case 'addManualGame':
        result = addManualGame(body.payload);
        break;
      case 'getUnlockedAchievements':
        result = getUnlockedAchievements(body.payload.appid);
        break;
      case 'getAllAchievementsForGame':
        result = getAllAchievementsForGame(body.payload.appid);
        break;
      default:
        return jsonResponse_({ error: 'unknown action: ' + body.action });
    }
    return jsonResponse_({ ok: true, result: result });
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns every game {appid, name} held in the RAW DATA sheet, for matching a game name to its appid.
 */
function listOwnedGames() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 2, lastRow - 1, 2).getValues(); // B=AppID, C=Name
  return data
    .filter(r => r[0])
    .map(r => ({ appid: String(r[0]), name: r[1] }));
}

/**
 * Returns all current rows in the GUIDES sheet, for comparison before syncing.
 */
function listGuideRows() {
  const sheet = getOrCreateGuidesSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  return data
    .filter(r => r[0])
    .map(r => ({ appid: String(r[0]), name: r[1], url: r[2], updated: r[3] }));
}

/**
 * Batch write/update guide links. entries: [{appid, name, url}]
 * Matched against existing rows by appid: updates the link+date if found, appends a new
 * row otherwise.
 * Returns {updated: [...], appended: [...]}
 */
function upsertGuideLinks(entries) {
  const sheet = getOrCreateGuidesSheet();
  const lastRow = sheet.getLastRow();
  const existing = {}; // appid -> row number
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    data.forEach((r, i) => {
      if (r[0]) existing[String(r[0])] = i + 2;
    });
  }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const updated = [];
  const appended = [];
  const toAppend = [];

  entries.forEach(e => {
    const appid = String(e.appid);
    if (existing[appid]) {
      const row = existing[appid];
      sheet.getRange(row, 2, 1, 3).setValues([[e.name, e.url, today]]);
      updated.push(appid);
    } else {
      toAppend.push([appid, e.name, e.url, today]);
      appended.push(appid);
    }
  });

  if (toAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, 4).setValues(toAppend);
  }

  return { updated: updated, appended: appended };
}

/**
 * Appends a Status='Manual' row to the RAW DATA sheet (e.g. for a family-shared game not
 * in the Steam owned-games list).
 * entry: {appid, name, achieved (optional, default 0), total (optional, default 'N/A')}
 * Manual rows are never overwritten by runBatch/rebuildSheetFromApi's automatic
 * achievement sync - their completion counts have to be maintained by hand.
 * Errors if the appid already exists rather than overwriting (to avoid clobbering existing data).
 */
function addManualGame(entry) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const appid = String(entry.appid);

  if (lastRow >= 2) {
    const existingAppIds = sheet.getRange(2, CONFIG.APPID_COL, lastRow - 1, 1).getValues().flat().map(String);
    if (existingAppIds.includes(appid)) {
      throw new Error('appid ' + appid + ' is already in RAW DATA, not adding a duplicate');
    }
  }

  const row = lastRow + 1;
  const achieved = entry.achieved !== undefined ? entry.achieved : 0;
  const total = entry.total !== undefined ? entry.total : 'N/A';
  const rate = (typeof total === 'number' && total > 0) ? (achieved / total) : '';

  sheet.getRange(row, CONFIG.UNVETTED_COL).setValue('Manual');
  sheet.getRange(row, CONFIG.APPID_COL).setValue(appid);
  sheet.getRange(row, CONFIG.NAME_COL).setValue(entry.name);
  sheet.getRange(row, CONFIG.ACHIEVED_COL).setValue(achieved);
  sheet.getRange(row, CONFIG.TOTAL_COL).setValue(total);
  if (rate !== '') sheet.getRange(row, CONFIG.RATE_COL).setValue(rate);

  return { row: row, appid: appid, name: entry.name };
}

/**
 * Returns the list of unlocked achievements for an appid, with zh/en names/descriptions
 * (looked up from the ACHIEVEMENTS sheet), for Claude Code to match against checkboxes
 * on a Notion guide page.
 * Reuses the existing GetPlayerAchievements call logic from steam_achievement_sync.gs.
 */
function getUnlockedAchievements(appid) {
  appid = String(appid);
  const stats = fetchAchievementStats(appid); // from steam_achievement_sync.gs
  if (stats.noAchievementSystem) {
    throw new Error('appid ' + appid + ' has no achievement data (may have no achievement system, or Steam says this account has no stats)');
  }
  if (stats.retry) {
    throw new Error('appid ' + appid + ' is rate-limited (429), try again later');
  }

  const achSheet = getOrCreateAchievementsSheet();
  const achLastRow = achSheet.getLastRow();
  const nameByApiName = {};
  if (achLastRow >= 2) {
    const achData = achSheet.getRange(2, 1, achLastRow - 1, 6).getValues();
    achData.forEach(r => {
      if (String(r[0]) === appid) {
        nameByApiName[r[2]] = { nameCn: r[3], nameEn: r[4], description: r[5] };
      }
    });
  }

  // fetchAchievementStats currently only returns a summary count; re-fetch the raw list here to get per-achievement achieved status
  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/`
    + `?appid=${appid}&key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  const achievements = (data.playerstats && data.playerstats.achievements) || [];

  return achievements
    .filter(a => a.achieved === 1)
    .map(a => {
      const meta = nameByApiName[a.apiname] || {};
      return {
        apiname: a.apiname,
        unlocktime: a.unlocktime,
        nameCn: meta.nameCn || '',
        nameEn: meta.nameEn || '',
        description: meta.description || ''
      };
    });
}

/**
 * Returns the full achievement list for an appid (regardless of unlock status), with
 * zh/en names/descriptions/hidden flag (from the ACHIEVEMENTS sheet) plus the real
 * unlock status (GetPlayerAchievements). For writing/fixing a guide page's achievement
 * checklist from scratch.
 */
function getAllAchievementsForGame(appid) {
  appid = String(appid);

  const achSheet = getOrCreateAchievementsSheet();
  const achLastRow = achSheet.getLastRow();
  const defs = [];
  if (achLastRow >= 2) {
    const achData = achSheet.getRange(2, 1, achLastRow - 1, 8).getValues();
    achData.forEach(r => {
      if (String(r[0]) === appid) {
        defs.push({
          apiname: r[2],
          nameCn: r[3],
          nameEn: r[4],
          description: r[5],
          hidden: r[6] === 'TRUE' || r[6] === true
        });
      }
    });
  }
  if (defs.length === 0) {
    throw new Error('appid ' + appid + ' has no record in the ACHIEVEMENTS sheet - run syncAchievementSchema first to fill it in');
  }

  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/`
    + `?appid=${appid}&key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const achievedByApiName = {};
  if (res.getResponseCode() === 200) {
    const data = JSON.parse(res.getContentText());
    const achievements = (data.playerstats && data.playerstats.achievements) || [];
    achievements.forEach(a => { achievedByApiName[a.apiname] = a.achieved === 1; });
  }

  return defs.map(d => ({
    apiname: d.apiname,
    nameCn: d.nameCn,
    nameEn: d.nameEn,
    description: d.description,
    hidden: d.hidden,
    achieved: achievedByApiName[d.apiname] === true
  }));
}
