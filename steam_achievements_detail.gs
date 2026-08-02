/**
 * Achievement-detail sync (a separate file from steam_achievement_sync.gs, to keep the
 * main file smaller)
 * ------------------------------------------------
 * Usage:
 * 1. In the same Apps Script project, create a new file (any name) and paste this in
 * 2. Being in the same project, it can reuse CONFIG (STEAM_API_KEY etc.) directly
 * 3. Run syncAchievementSchema()
 *
 * What it does: pulls the full official achievement detail (name/description/hidden
 * flag/icon) for every game in RAW DATA into a separate "ACHIEVEMENTS" tab (auto-created
 * on first run). Stores both Chinese and English: Chinese for your own reading, English
 * kept around for searching community guides later (guides are mostly written in English,
 * and a Chinese-only name won't turn up the matching English guide).
 *
 * Auto-refreshes without manual intervention when:
 * - this appid has no record yet in the ACHIEVEMENTS sheet (new game)
 * - RAW DATA's "achievements last updated" date for this game is within the last 7 days
 *   (meaning it got new achievements in an update - see the total-achievement-count
 *   change detection in updateRowForGame in the main file)
 * Skipped when:
 * - the completion rate (RATE_COL) is exactly 100% - already fully completed, no
 *   checklist needed
 * - games whose completion rate is uncertain/not 100% (including family-shared games
 *   whose real progress can't be confirmed) are NOT skipped, since we can't be sure
 *   they're fully completed - better to over-process than miss one
 * Games already synced with no recent update are skipped, no redundant lookups.
 * Stops when the time budget runs out - run it a few more times to finish the whole library.
 */
function syncAchievementSchema() {
  const startTime = Date.now();
  const rawSheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const achSheet = getOrCreateAchievementsSheet();

  // read RAW DATA and decide which appids need processing
  const lastRow = rawSheet.getLastRow();
  const games = [];
  for (let row = CONFIG.HEADER_ROW; row <= lastRow; row++) {
    const appid = rawSheet.getRange(row, CONFIG.APPID_COL).getValue();
    const total = rawSheet.getRange(row, CONFIG.TOTAL_COL).getValue();
    const rate = rawSheet.getRange(row, CONFIG.RATE_COL).getValue();
    const gameName = rawSheet.getRange(row, CONFIG.NAME_COL).getValue();
    const newAchDate = rawSheet.getRange(row, CONFIG.NEW_ACH_DATE_COL).getValue();
    if (!appid || total === 'N/A') continue;
    if (typeof rate === 'number' && rate === 1) continue; // already 100% complete, no checklist needed, skip
    const recentlyUpdated = (newAchDate instanceof Date) && ((Date.now() - newAchDate.getTime()) < 7 * 86400000);
    games.push({ appid: String(appid), name: gameName, recentlyUpdated: recentlyUpdated });
  }

  // read existing ACHIEVEMENTS data
  const achLastRow = achSheet.getLastRow();
  let existingData = [];
  const existingAppIds = new Set();
  if (achLastRow >= 2) {
    existingData = achSheet.getRange(2, 1, achLastRow - 1, 8).getValues();
    existingData.forEach(r => { if (r[0]) existingAppIds.add(String(r[0])); });
  }

  const appidsToRefresh = new Set(
    games.filter(g => g.recentlyUpdated || !existingAppIds.has(g.appid)).map(g => g.appid)
  );

  if (appidsToRefresh.size === 0) {
    Logger.log('No games need to be added or refreshed');
    return;
  }

  // keep old data that doesn't need refreshing; drop the old rows for appids being
  // refreshed, they'll be rewritten below with freshly-fetched data
  const keptRows = existingData.filter(r => !appidsToRefresh.has(String(r[0])));

  const newRows = [];
  let processedGames = 0;
  let skippedNoSchema = 0;
  let timedOut = false;

  for (const g of games) {
    if (!appidsToRefresh.has(g.appid)) continue;
    if (Date.now() - startTime > CONFIG.MAX_RUNTIME_MS) {
      timedOut = true;
      break;
    }

    const achievementsCn = fetchAchievementSchema(g.appid, 'schinese');
    if (!achievementsCn || achievementsCn.length === 0) {
      skippedNoSchema++;
      Utilities.sleep(300);
      continue;
    }
    Utilities.sleep(300);
    const achievementsEn = fetchAchievementSchema(g.appid, 'english') || [];
    const enByApiName = {};
    achievementsEn.forEach(a => { enByApiName[a.name] = a; });

    achievementsCn.forEach(a => {
      const enA = enByApiName[a.name];
      newRows.push([
        g.appid,
        g.name,
        a.name,
        a.displayName || a.name,
        enA ? (enA.displayName || enA.name) : '',
        a.hidden === 1 ? '' : (a.description || ''),
        a.hidden === 1 ? 'TRUE' : 'FALSE',
        a.hidden === 1 ? (a.icongray || a.icon || '') : (a.icon || '')
      ]);
    });

    processedGames++;
    Utilities.sleep(300);
  }

  // rewrite the data range: keep the header, replace the content with "kept old rows + newly fetched rows"
  const allRows = keptRows.concat(newRows);
  if (achSheet.getLastRow() >= 2) {
    achSheet.getRange(2, 1, achSheet.getLastRow() - 1, 8).clearContent();
  }
  if (allRows.length > 0) {
    achSheet.getRange(2, 1, allRows.length, 8).setValues(allRows);
  }

  Logger.log('Achievement-detail sync complete: added/refreshed ' + processedGames + ' game(s), skipped (no schema found) ' + skippedNoSchema
    + (timedOut ? ' (time budget ran out, some games still unprocessed - run again to keep going)' : ''));
}

function getOrCreateAchievementsSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CONFIG.ACHIEVEMENTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ACHIEVEMENTS_SHEET_NAME);
  }
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, 8).setValues([[
      'AppID', '游戏名', '成就APIName', '成就名称(中文)', '成就名称(英文,搜攻略用)', '成就描述', '是否隐藏成就', '图标URL'
    ]]);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Queries the full official achievement schema for an appid (GetSchemaForGame) in the
 * given language. Doesn't need a steamid or account login - purely public data keyed by appid.
 */
function fetchAchievementSchema(appid, lang) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/`
    + `?key=${CONFIG.STEAM_API_KEY}&appid=${appid}&l=${lang}&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;

  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    return null;
  }

  return (data.game && data.game.availableGameStats && data.game.availableGameStats.achievements) || null;
}
