/**
 * Steam achievement auto-sync script (Google Apps Script)
 * ------------------------------------------------
 * Design principle: data returned by the Steam API is the source of truth.
 * The sheet is keyed on appid; official names/achievement data are always pulled from
 * the API, never matched against manually entered data.
 *
 * Setup:
 * 1. Open this Google Sheet -> Extensions -> Apps Script
 * 2. Paste this file's contents in (replacing the default Code.gs contents)
 * 3. Project Settings (gear icon) -> Script Properties -> add two: STEAM_API_KEY / STEAM_ID
 *    (get a Steam API Key at https://steamcommunity.com/dev/apikey;
 *    STEAM_ID is your SteamID64, look it up at https://steamid.io)
 * 4. Run setup() once (it will prompt you to authorize - click allow)
 * 5. Run rebuildSheetFromApi() once to do the initial fill
 * 6. Run createTrigger() to set up the daily schedule - fully automatic from then on
 *
 * Functions you'll use day to day:
 * - runBatch()          Refreshes achievement data in batches (runs daily via trigger, rarely needs manual runs)
 * - syncNewGames()       Detects new games in your library and appends them (runs automatically via trigger)
 * - updateMissingRows()  Run manually after adding a new appid row if you don't want to wait for the cursor to cycle around
 * - sortSheetByCompletion() Run manually to re-sort by completion rate/total achievements
 * - fillMissingNames()    Backfills names specifically (appid present but name blank), regardless of whether achievement data is filled
 * - fillChineseTranslations() Looks up the Chinese name for rows with an English name and overwrites the name in place (not a separate column)
 *   (syncNewGames() already tries the official Chinese name first for newly added games, so this is only needed for backfilling)
 * - rebuildSheetFromApi() Run manually to fully rebuild the sheet (keeps manually-added "played but not owned" rows)
 * - hardResetFromApi()    Run manually for a full wipe-and-restart with nothing kept (rarely needed)
 *
 * Achievement-detail functionality (for building a full checklist) lives in the separate
 * file steam_achievements_detail.gs; its syncAchievementSchema() is now wired into the daily
 * trigger too, so new games/games with recently updated achievements sync automatically -
 * see that file's header comment for details.
 */

// ============ Config ============
// STEAM_API_KEY / STEAM_ID are never hardcoded here - they're read from Script Properties
// (Project Settings -> Script Properties), so this code can be shared publicly without
// leaking anyone's personal information.
const CONFIG = {
  STEAM_API_KEY: PropertiesService.getScriptProperties().getProperty('STEAM_API_KEY'),
  STEAM_ID: PropertiesService.getScriptProperties().getProperty('STEAM_ID'),
  SHEET_NAME: 'RAW DATA',
  ACHIEVEMENTS_SHEET_NAME: 'ACHIEVEMENTS', // separate tab storing full achievement detail for every game
  UNVETTED_COL: 1, // Col A: Status flag. 'Unvetted' = game Steam hides by default (excluded from aggregate stats); 'Manual' = manually recorded row, locked out of auto-sync
  APPID_COL: 2,    // Col B: AppID (the sheet's primary key - all automation keys off this)
  NAME_COL: 3,     // Col C: Game name (official name from the Steam API)
  ACHIEVED_COL: 4, // Col D: Achieved count
  TOTAL_COL: 5,    // Col E: Total achievements (games with no achievement system get 'N/A')
  RATE_COL: 6,     // Col F: Completion rate
  FAVORITE_COL: 7, // Col G: Favorite flag (♥), TRUE/FALSE, toggled by clicking the heart on the Dashboard
  PRIORITY_COL: 8, // Col H: Spotlight flag (★), TRUE/FALSE, toggled by clicking the star on the Dashboard - spotlighted games are pinned to the top
  NEW_ACH_DATE_COL: 9, // Col I: date the total-achievement count last increased (i.e. the game got new achievements in an update), used for a Dashboard notice
  HEADER_ROW: 2,   // which row the data starts on
  BATCH_SIZE: 1000,       // set high - MAX_RUNTIME_MS below is the real backstop
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
};

// ============ Initialization ============
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CURSOR')) {
    props.setProperty('CURSOR', '0');
  }
  ensureHeaders();
  Logger.log('Setup complete');
}

/**
 * Ensures every data column has header text in row 1. Safe to run standalone at any time;
 * also called automatically whenever the sheet is rebuilt.
 */
function ensureHeaders() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  sheet.getRange(1, CONFIG.APPID_COL).setValue('AppID');
  sheet.getRange(1, CONFIG.NAME_COL).setValue('游戏名');
  sheet.getRange(1, CONFIG.ACHIEVED_COL).setValue('完成数');
  sheet.getRange(1, CONFIG.TOTAL_COL).setValue('成就总数');
  sheet.getRange(1, CONFIG.RATE_COL).setValue('完成率');
  sheet.getRange(1, CONFIG.UNVETTED_COL).setValue('Status');
  sheet.getRange(1, CONFIG.FAVORITE_COL).setValue('喜爱');
  sheet.getRange(1, CONFIG.PRIORITY_COL).setValue('重点关注');
  sheet.getRange(1, CONFIG.NEW_ACH_DATE_COL).setValue('成就更新日期');

  const headerCols = [CONFIG.APPID_COL, CONFIG.NAME_COL, CONFIG.ACHIEVED_COL, CONFIG.TOTAL_COL, CONFIG.RATE_COL, CONFIG.UNVETTED_COL, CONFIG.FAVORITE_COL, CONFIG.PRIORITY_COL, CONFIG.NEW_ACH_DATE_COL];
  headerCols.forEach(col => {
    sheet.getRange(1, col).setFontWeight('bold');
  });
}

function hasChineseChars(str) {
  return /[\u4e00-\u9fff]/.test(String(str));
}

/**
 * Rebuilds the whole sheet from Steam API data, while preserving rows whose appid
 * isn't in the current owned-games list (manually-added games you've played but
 * don't currently own). Recommended when you want to clean out stale data without
 * losing manual records.
 */
function rebuildSheetFromApi() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const result = fetchOwnedGamesWithUnvettedFlag();
  const ownedGames = result.games;
  const ownedAppIdSet = new Set(ownedGames.map(g => String(g.appid)));

  const manualRows = [];
  const manualStatusAppIds = new Set(); // appids marked 'Manual' - keep this flag through the rebuild regardless of owned status
  if (lastRow >= CONFIG.HEADER_ROW) {
    const numCols = sheet.getLastColumn();
    const data = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, numCols).getValues();
    data.forEach(rowValues => {
      const appid = rowValues[CONFIG.APPID_COL - 1];
      const name = rowValues[CONFIG.NAME_COL - 1];
      const status = rowValues[CONFIG.UNVETTED_COL - 1];
      if (!name && !appid) return; // entire row is blank, skip
      if (status === 'Manual' && appid) manualStatusAppIds.add(String(appid));
      if (!appid || !ownedAppIdSet.has(String(appid))) manualRows.push(rowValues);
    });
  }

  if (lastRow >= CONFIG.HEADER_ROW) {
    sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, sheet.getLastColumn()).clearContent();
  }

  let row = CONFIG.HEADER_ROW;
  ownedGames.forEach(g => {
    sheet.getRange(row, CONFIG.NAME_COL).setValue(g.name);
    sheet.getRange(row, CONFIG.APPID_COL).setValue(g.appid);
    if (manualStatusAppIds.has(String(g.appid))) {
      sheet.getRange(row, CONFIG.UNVETTED_COL).setValue('Manual'); // manual lock takes priority over the API's auto-detected Unvetted flag
    } else if (result.unvettedAppIds.has(String(g.appid))) {
      sheet.getRange(row, CONFIG.UNVETTED_COL).setValue('Unvetted');
    }
    row++;
  });

  manualRows.forEach(rowValues => {
    sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
    row++;
  });

  PropertiesService.getScriptProperties().setProperty('CURSOR', '0');
  ensureHeaders();
  Logger.log('Rebuild complete: wrote ' + ownedGames.length + ' API games (' + result.unvettedAppIds.size
    + ' flagged Unvetted, ' + manualStatusAppIds.size + ' kept as manually-locked Manual) + kept ' + manualRows.length + ' manual/non-owned rows');
}

/**
 * Hard reset: keeps nothing, just re-fills the whole sheet from Steam API data.
 * Manually-added rows (including any with a bad appid) get wiped too.
 * For a genuine clean-slate restart; not needed for normal use.
 */
function hardResetFromApi() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();

  if (lastRow >= CONFIG.HEADER_ROW) {
    sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, sheet.getLastColumn()).clearContent();
  }

  const result = fetchOwnedGamesWithUnvettedFlag();
  let row = CONFIG.HEADER_ROW;
  result.games.forEach(g => {
    sheet.getRange(row, CONFIG.NAME_COL).setValue(g.name);
    sheet.getRange(row, CONFIG.APPID_COL).setValue(g.appid);
    if (result.unvettedAppIds.has(String(g.appid))) {
      sheet.getRange(row, CONFIG.UNVETTED_COL).setValue('Unvetted');
    }
    row++;
  });

  PropertiesService.getScriptProperties().setProperty('CURSOR', '0');
  ensureHeaders();
  Logger.log('Hard reset complete: wrote ' + result.games.length + ' API games (' + result.unvettedAppIds.size
    + ' flagged Unvetted), no old rows kept');
}

/**
 * Detects games in your Steam library that aren't in the sheet yet and appends them as new rows.
 */
function syncNewGames() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const result = fetchOwnedGamesWithUnvettedFlag();
  const existingAppIds = getExistingAppIds(sheet);

  const newGames = result.games.filter(g => !existingAppIds.has(String(g.appid)));
  if (newGames.length === 0) {
    Logger.log('No new games found');
    return;
  }

  let nextRow = sheet.getLastRow() + 1;
  newGames.forEach(g => {
    const bestName = fetchAppName(g.appid) || g.name; // prefer the two-tier Chinese-name lookup, fall back to whatever GetOwnedGames returned
    sheet.getRange(nextRow, CONFIG.NAME_COL).setValue(bestName);
    sheet.getRange(nextRow, CONFIG.APPID_COL).setValue(g.appid);
    if (result.unvettedAppIds.has(String(g.appid))) {
      sheet.getRange(nextRow, CONFIG.UNVETTED_COL).setValue('Unvetted');
    }
    nextRow++;
    Utilities.sleep(300);
  });

  Logger.log('Added ' + newGames.length + ' new game(s): ' + JSON.stringify(newGames.map(g => g.name)));
}

function getExistingAppIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return new Set();
  const values = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, lastRow - CONFIG.HEADER_ROW + 1, 1).getValues();
  const set = new Set();
  values.forEach(r => { if (r[0]) set.add(String(r[0])); });
  return set;
}

// ============ Core: batched achievement-data sync ============
function runBatch() {
  const startTime = Date.now();
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const props = PropertiesService.getScriptProperties();
  let cursor = parseInt(props.getProperty('CURSOR') || '0', 10);

  const totalDataRows = lastRow - CONFIG.HEADER_ROW + 1;
  if (totalDataRows <= 0) return;

  const startCursor = cursor;
  let processed = 0;

  while (processed < CONFIG.BATCH_SIZE) {
    if (Date.now() - startTime > CONFIG.MAX_RUNTIME_MS) break;
    if (cursor >= totalDataRows) cursor = 0;

    const row = CONFIG.HEADER_ROW + cursor;
    const appid = sheet.getRange(row, CONFIG.APPID_COL).getValue();
    const currentTotal = sheet.getRange(row, CONFIG.TOTAL_COL).getValue();
    const status = sheet.getRange(row, CONFIG.UNVETTED_COL).getValue();

    if (appid && currentTotal !== 'N/A' && status !== 'Manual') {
      try {
        updateRowForGame(sheet, row, appid);
      } catch (e) {
        Logger.log('appid ' + appid + ' update failed: ' + e.message);
      }
      Utilities.sleep(300);
    }

    cursor++;
    processed++;
  }

  props.setProperty('CURSOR', String(cursor));
  Logger.log('Processed rows ' + (CONFIG.HEADER_ROW + startCursor) + ' to ' + (CONFIG.HEADER_ROW + cursor - 1)
    + ' (' + processed + ' rows this run, total data rows=' + totalDataRows + ')');
  updateSummaryStats();
}

/**
 * Looks up the Chinese name for rows that currently have an English name, and overwrites
 * the name in place (not a separate column) when found.
 * Scraping the store page is more rate-limit-prone than calling the API, so this stops
 * when the time budget runs out - just run it again a few more times to finish backfilling.
 */
function fillChineseTranslations() {
  const startTime = Date.now();
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  let official = 0;
  let notFound = 0;
  let skipped = 0;

  for (let row = CONFIG.HEADER_ROW; row <= lastRow; row++) {
    if (Date.now() - startTime > CONFIG.MAX_RUNTIME_MS) {
      Logger.log('Time budget nearly up, stopping at row ' + row + '. Store-page scraping rate-limits easily - run again after a short wait to keep going.');
      break;
    }

    const name = sheet.getRange(row, CONFIG.NAME_COL).getValue();
    if (!name) continue;
    if (hasChineseChars(name)) { skipped++; continue; }

    const appid = sheet.getRange(row, CONFIG.APPID_COL).getValue();
    if (!appid) continue;

    const officialCnName = fetchAppNameFromStorePage(appid);
    if (officialCnName && hasChineseChars(officialCnName)) {
      sheet.getRange(row, CONFIG.NAME_COL).setValue(officialCnName);
      official++;
    } else {
      notFound++;
    }
    Utilities.sleep(800); // longer delay - scraping the store page trips rate limits more easily than API calls
  }

  Logger.log('Chinese-name backfill complete: found official title for ' + official + ', no official Chinese name for '
    + notFound + ' (left as-is, retryable next run), skipped (already Chinese) ' + skipped);
}

/**
 * Backfills names specifically: scans the whole sheet and looks up the official name for
 * any row that has an appid but a blank name. Doesn't check columns C/D - this exists
 * specifically to unstick rows where achievement data got filled but the name didn't.
 */
function fillMissingNames() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  let filled = 0;
  let failed = 0;

  for (let row = CONFIG.HEADER_ROW; row <= lastRow; row++) {
    const appid = sheet.getRange(row, CONFIG.APPID_COL).getValue();
    const name = sheet.getRange(row, CONFIG.NAME_COL).getValue();
    if (!appid || name) continue;

    const officialName = fetchAppName(appid);
    if (officialName) {
      sheet.getRange(row, CONFIG.NAME_COL).setValue(officialName);
      filled++;
    } else {
      failed++;
    }
    Utilities.sleep(300);
  }

  Logger.log('Name backfill complete: ' + filled + ' succeeded, ' + failed + ' failed (see the log above for reasons)');
}

/**
 * Ignores the cursor and scans the whole sheet, filling in any row that has no
 * achievement data yet (column D blank and not N/A). Useful after manually adding
 * new rows when you don't want to wait for the cursor to cycle around to them.
 */
function updateMissingRows() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  let updated = 0;

  for (let row = CONFIG.HEADER_ROW; row <= lastRow; row++) {
    const appid = sheet.getRange(row, CONFIG.APPID_COL).getValue();
    const total = sheet.getRange(row, CONFIG.TOTAL_COL).getValue();
    const status = sheet.getRange(row, CONFIG.UNVETTED_COL).getValue();
    if (!appid) continue;
    if (total === 'N/A') continue;
    if (status === 'Manual') continue;
    if (total !== '') continue;

    try {
      updateRowForGame(sheet, row, appid);
    } catch (e) {
      Logger.log('appid ' + appid + ' update failed: ' + e.message);
    }
    updated++;
    Utilities.sleep(300);
  }

  Logger.log('Backfill complete, processed ' + updated + ' row(s) of missing data');
  updateSummaryStats();
}

function updateRowForGame(sheet, row, appid) {
  const currentName = sheet.getRange(row, CONFIG.NAME_COL).getValue();
  if (!currentName) {
    const officialName = fetchAppName(appid); // two-tier lookup: JSON first, scrape the store page if that has no Chinese name, use whichever is best
    if (officialName) sheet.getRange(row, CONFIG.NAME_COL).setValue(officialName);
    Utilities.sleep(300); // the store endpoint rate-limits fairly aggressively - pause here before hitting the achievements endpoint
  }

  const result = fetchAchievementStats(appid);

  if (result.noAchievementSystem) {
    sheet.getRange(row, CONFIG.TOTAL_COL).setValue('N/A');
    return;
  }

  if (result.retry) {
    return; // transient error - leave it blank so the next run retries
  }

  const stats = result;
  const previousTotal = sheet.getRange(row, CONFIG.TOTAL_COL).getValue();
  const rate = stats.total > 0 ? stats.achieved / stats.total : 0;

  // if the total-achievement count is now higher than what's on record, the game's had an
  // update that added new achievements - note the date
  if (typeof previousTotal === 'number' && stats.total > previousTotal) {
    sheet.getRange(row, CONFIG.NEW_ACH_DATE_COL).setValue(new Date());
  }

  sheet.getRange(row, CONFIG.ACHIEVED_COL).setValue(stats.achieved);
  sheet.getRange(row, CONFIG.TOTAL_COL).setValue(stats.total);
  sheet.getRange(row, CONFIG.RATE_COL).setValue(rate);
  sheet.getRange(row, CONFIG.RATE_COL).setNumberFormat('0.00%');
}

/**
 * Sorts the sheet's data range by completion rate (RATE_COL) descending, then total
 * achievements (TOTAL_COL) descending. Blank rows (not synced yet) naturally sort last.
 * Note: sorting shuffles rows' physical positions, and the CURSOR property tracks
 * "which row number" rather than a specific game - so what the cursor points at changes
 * after a sort, but correctness isn't affected. runBatch() just processes rows in
 * positional order and cycles through everything eventually, so nothing gets skipped.
 */
function sortSheetByCompletion() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= CONFIG.HEADER_ROW) return;

  const range = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastCol);
  range.sort([
    { column: CONFIG.RATE_COL, ascending: false },
    { column: CONFIG.TOTAL_COL, ascending: false }
  ]);
}

/**
 * Computes AGCR (Average Game Completion Rate) per Steam's own community-documented
 * algorithm, and returns the result without writing it back to the sheet (no summary
 * cells are kept on the sheet - the Dashboard computes and displays this live).
 * - Only games with at least 1 unlocked achievement count toward the average (games
 *   with 0 achieved are excluded entirely, not counted as 0%)
 * - Each eligible game contributes one completion rate; the result is a plain arithmetic
 *   mean (equal weight per game, independent of each game's total achievement count)
 * - Games flagged Unvetted (Profile Features Limited) are excluded, matching Steam's own convention
 * Reference: https://steamcommunity.com/sharedfiles/filedetails/?id=650166273
 */
function computeAgcrStats(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return { eligibleCount: 0, avg: 0, perfectCount: 0 };

  const numRows = lastRow - CONFIG.HEADER_ROW + 1;
  const achievedVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.ACHIEVED_COL, numRows, 1).getValues();
  const totalVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.TOTAL_COL, numRows, 1).getValues();
  const unvettedVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.UNVETTED_COL, numRows, 1).getValues();

  let sum = 0;
  let eligibleCount = 0;
  let perfectCount = 0;

  for (let i = 0; i < numRows; i++) {
    const achieved = achievedVals[i][0];
    const total = totalVals[i][0];

    if (unvettedVals[i][0] === 'Unvetted') continue;
    if (typeof total !== 'number' || total <= 0) continue;
    if (!achieved || achieved <= 0) continue;

    sum += achieved / total;
    eligibleCount++;
    if (achieved === total) perfectCount++;
  }

  const avg = eligibleCount > 0 ? sum / eligibleCount : 0;
  return { eligibleCount, avg, perfectCount };
}

/**
 * Logs the summary only - a quick way to check the aggregate numbers by running this
 * manually in the editor. Doesn't write anything back to the sheet.
 */
function updateSummaryStats() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const stats = computeAgcrStats(sheet);
  const roundedDownPct = Math.floor(stats.avg * 100);
  Logger.log('AGCR computed: eligible games=' + stats.eligibleCount
    + ', average completion=' + roundedDownPct + '% (precise value ' + (stats.avg * 100).toFixed(5) + '%), perfect games=' + stats.perfectCount);
}

/**
 * Looks up the official game name by appid using Steam's public store endpoints (no login,
 * no ownership required).
 * Note: the appdetails JSON endpoint's name field often ignores the l= localization param
 * (a known Steam quirk), so if the JSON-provided name has no Chinese characters, this falls
 * back to scraping the store page's own HTML, which does carry the real localized title.
 */
function fetchAppName(appid) {
  const apiName = fetchAppNameFromJson(appid);
  if (apiName && hasChineseChars(apiName)) return apiName;

  const pageName = fetchAppNameFromStorePage(appid);
  if (pageName && hasChineseChars(pageName)) return pageName;

  return apiName; // neither source had a Chinese name - fall back to whatever JSON gave (possibly English)
}

function fetchAppNameFromJson(appid) {
  const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=schinese';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('appid ' + appid + ' -> name lookup failed, HTTP ' + res.getResponseCode() + ' (the store endpoint rate-limits fairly aggressively - common after too many lookups in a short time)');
    return null;
  }

  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    Logger.log('appid ' + appid + ' -> name lookup failed, response wasn\'t valid JSON (most likely rate-limited and returned an error page)');
    return null;
  }

  const entry = data[String(appid)];
  if (entry && entry.success && entry.data && entry.data.name) {
    return entry.data.name;
  }
  Logger.log('appid ' + appid + ' -> name lookup failed, the store endpoint returned no valid data (appid may be invalid, or this app type isn\'t supported)');
  return null;
}

/**
 * Scrapes the store page's own HTML and extracts the real localized title (the
 * apphub_AppName element). More reliable than the JSON endpoint's name field, but the
 * page structure could change in the future, so treat this as a best-effort fallback.
 * Sends an age-verification cookie so age-gated games don't get blocked before the
 * actual content is reachable.
 */
function fetchAppNameFromStorePage(appid) {
  const url = 'https://store.steampowered.com/app/' + appid + '/?l=schinese';
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Cookie': 'birthtime=189302401; mature_content=1; wants_mature_content=1; lastagecheckage=1-January-1976' }
  });
  if (res.getResponseCode() !== 200) return null;

  const html = res.getContentText();
  // the class attribute may carry multiple classes (e.g. "apphub_AppName xxx"), so don't
  // require an exact match on the whole attribute value
  const match = html.match(/<div[^>]*class="[^"]*apphub_AppName[^"]*"[^>]*>([^<]+)<\/div>/);
  if (match && match[1]) return match[1].trim();
  return null;
}

// ============ Steam API wrappers ============
function fetchOwnedGames(skipUnvettedApps) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/`
    + `?key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}`
    + `&include_appinfo=true&include_played_free_games=true&format=json&l=schinese`
    + `&skip_unvetted_apps=${skipUnvettedApps}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  return (data.response && data.response.games) || [];
}

/**
 * Fetches the full owned-games list (including games Steam hides by default under
 * "Unvetted/Profile Features Limited"), while also flagging which ones are in that
 * hidden batch, so the sheet can call them out separately.
 * Returns { games: [...], unvettedAppIds: Set }
 */
function fetchOwnedGamesWithUnvettedFlag() {
  const fullList = fetchOwnedGames(false);   // don't skip unvetted - gets the complete list
  const vettedList = fetchOwnedGames(true);  // skip unvetted - gets only the "vetted" subset
  const vettedAppIds = new Set(vettedList.map(g => String(g.appid)));
  const unvettedAppIds = new Set(
    fullList.filter(g => !vettedAppIds.has(String(g.appid))).map(g => String(g.appid))
  );
  return { games: fullList, unvettedAppIds: unvettedAppIds };
}

function fetchAchievementStats(appid) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/`
    + `?appid=${appid}&key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = res.getResponseCode();

  if (code === 429) {
    Logger.log('appid ' + appid + ' -> HTTP 429 rate-limited, leaving blank for now, will retry next run');
    return { retry: true };
  }

  if (code !== 200) {
    Logger.log('appid ' + appid + ' -> HTTP ' + code + ' (Steam says no achievement data, marking N/A)');
    return { noAchievementSystem: true };
  }

  const data = JSON.parse(res.getContentText());
  const stats = data.playerstats;

  if (!stats || !stats.success) {
    const reason = (stats && stats.error) || 'unknown reason';
    Logger.log('appid ' + appid + ' -> ' + reason + ' (marking N/A, won\'t retry)');
    return { noAchievementSystem: true };
  }

  if (!stats.achievements) {
    Logger.log('appid ' + appid + ' -> confirmed no achievement system');
    return { noAchievementSystem: true };
  }

  const total = stats.achievements.length;
  const achieved = stats.achievements.filter(a => a.achieved === 1).length;
  return { total, achieved };
}

// ============ Scheduled triggers ============
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'runBatch' || fn === 'syncNewGames' || fn === 'syncAchievementSchema') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runBatch').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('syncNewGames').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('syncAchievementSchema').timeBased().everyDays(1).atHour(4).create();
  Logger.log('Triggers created: runBatch at 2am, syncNewGames at 3am, syncAchievementSchema at 4am, each running once daily');
}
