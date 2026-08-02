/**
 * Steam achievement Dashboard (a separate file, in the same Apps Script project as
 * steam_achievement_sync.gs)
 * ------------------------------------------------
 * Usage:
 * 1. In the same Apps Script project, create this file (paste this content in), then
 *    create an HTML file named "Dashboard" (must be exactly that, no .html extension -
 *    Apps Script auto-recognizes it as HTML), and paste Dashboard.html's contents into it
 * 2. Being in the same project, this can use the CONFIG from steam_achievement_sync.gs
 *    directly, no duplicate configuration needed
 * 3. Deploy as a web app: top-right "Deploy" -> "New deployment" -> type "Web app"
 *    - Execute as: "Me"
 *    - Who has access: pick based on your needs (e.g. "Only myself" is most private;
 *      "Anyone with the link" if you want to share it - note that anyone with the link
 *      can then see your Steam data)
 * 4. Deploying gives you a URL - that's your dashboard link. Once sheet data updates,
 *    just refresh the page; no redeploy needed (unless you change these two files' code)
 *
 * Guides feature: the GUIDES tab (AppID / Name / Guide link / Updated date) stores each
 * game's guide-page link, auto-created on the first call to getDashboardData() if it
 * doesn't exist yet.
 * Guide content itself lives in an external tool (Notion or Google Docs both work -
 * doesn't matter where, only a link is stored in the sheet). Notion is recommended,
 * since pasting markdown text auto-converts "- [ ]" into real checkable to-do blocks,
 * no extra steps needed.
 * Just paste the guide page's share link into the "Guide link" column, one URL per row -
 * no risk of multi-line paste getting split across rows.
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('Steam Achievement Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called by Dashboard.html via google.script.run - reads the RAW DATA sheet and shapes
 * it into the JSON structure the frontend needs.
 */
function getDashboardData() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const numRows = Math.max(0, lastRow - CONFIG.HEADER_ROW + 1);

  const guideUrls = getGuideUrlMap();

  const games = [];
  if (numRows > 0) {
    const lastCol = Math.max(CONFIG.UNVETTED_COL, CONFIG.RATE_COL, CONFIG.APPID_COL, CONFIG.NAME_COL, CONFIG.FAVORITE_COL, CONFIG.PRIORITY_COL, CONFIG.NEW_ACH_DATE_COL);
    const data = sheet.getRange(CONFIG.HEADER_ROW, 1, numRows, lastCol).getValues();
    data.forEach(row => {
      const appid = row[CONFIG.APPID_COL - 1];
      const name = row[CONFIG.NAME_COL - 1];
      if (!appid && !name) return; // skip blank rows

      const achievedRaw = row[CONFIG.ACHIEVED_COL - 1];
      const totalRaw = row[CONFIG.TOTAL_COL - 1];
      const rateRaw = row[CONFIG.RATE_COL - 1];
      const statusRaw = row[CONFIG.UNVETTED_COL - 1];
      const favoriteRaw = row[CONFIG.FAVORITE_COL - 1];
      const priorityRaw = row[CONFIG.PRIORITY_COL - 1];
      const newAchDateRaw = row[CONFIG.NEW_ACH_DATE_COL - 1];

      games.push({
        appid: appid || '',
        name: name || '(未命名)',
        achieved: (typeof achievedRaw === 'number') ? achievedRaw : null,
        total: (totalRaw === 'N/A') ? 'N/A' : ((typeof totalRaw === 'number') ? totalRaw : null),
        rate: (typeof rateRaw === 'number') ? rateRaw : null,
        unvetted: statusRaw === 'Unvetted',
        favorite: favoriteRaw === true || favoriteRaw === 'TRUE',
        priority: priorityRaw === true || priorityRaw === 'TRUE',
        newAchDaysAgo: (newAchDateRaw instanceof Date)
          ? Math.floor((Date.now() - newAchDateRaw.getTime()) / 86400000)
          : null,
        guideUrl: guideUrls[String(appid)] || ''
      });
    });
  }

  const agcr = computeAgcrStats(sheet);

  return {
    avgRounded: Math.floor(agcr.avg * 100) + '%',
    avgPrecise: (agcr.avg * 100).toFixed(3) + '%',
    perfectCount: agcr.perfectCount,
    totalGames: games.length,
    games: games,
    lastUpdated: new Date().toLocaleString('zh-CN')
  };
}

/**
 * Called when clicking the heart icon on the Dashboard: toggles favorite status for an
 * appid, writes it back to the sheet, and returns the new state.
 */
function toggleFavorite(appid) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return { error: '表格没有数据' };

  const numRows = lastRow - CONFIG.HEADER_ROW + 1;
  const appidVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    if (String(appidVals[i][0]) === String(appid)) {
      const row = CONFIG.HEADER_ROW + i;
      const current = sheet.getRange(row, CONFIG.FAVORITE_COL).getValue();
      const newVal = !(current === true || current === 'TRUE');
      sheet.getRange(row, CONFIG.FAVORITE_COL).setValue(newVal);
      return { favorite: newVal };
    }
  }

  return { error: '没有在表格里找到这个appid' };
}

/**
 * Called when clicking the star icon on the Dashboard: toggles "spotlight" status for an
 * appid, writes it back to the sheet, and returns the new state.
 * Games marked this way get pinned to the top of the Dashboard.
 */
function togglePriority(appid) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return { error: '表格没有数据' };

  const numRows = lastRow - CONFIG.HEADER_ROW + 1;
  const appidVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    if (String(appidVals[i][0]) === String(appid)) {
      const row = CONFIG.HEADER_ROW + i;
      const current = sheet.getRange(row, CONFIG.PRIORITY_COL).getValue();
      const newVal = !(current === true || current === 'TRUE');
      sheet.getRange(row, CONFIG.PRIORITY_COL).setValue(newVal);
      return { priority: newVal };
    }
  }

  return { error: '没有在表格里找到这个appid' };
}

/**
 * On-demand lookup: which achievements are still missing for a given appid (with icon,
 * name, description).
 * Prefers the ACHIEVEMENTS sheet data already batch-synced by syncAchievementSchema()
 * (avoids an extra network call for achievement definitions), only doing a live lookup
 * for "which ones you've actually unlocked" (GetPlayerAchievements).
 * Falls back to a live double-lookup if this game has no ACHIEVEMENTS sheet data yet.
 */
function getMissingAchievements(appid) {
  const cached = getCachedAchievementSchema(appid);

  const statsUrl = 'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/'
    + '?appid=' + appid + '&key=' + CONFIG.STEAM_API_KEY + '&steamid=' + CONFIG.STEAM_ID + '&format=json';
  const statsRes = UrlFetchApp.fetch(statsUrl, { muteHttpExceptions: true });
  if (statsRes.getResponseCode() !== 200) {
    return { error: '无法获取你的成就进度(HTTP ' + statsRes.getResponseCode() + ')' };
  }

  let statsData;
  try {
    statsData = JSON.parse(statsRes.getContentText());
  } catch (e) {
    return { error: '成就进度返回内容解析失败' };
  }

  const achievedSet = {};
  if (statsData.playerstats && statsData.playerstats.achievements) {
    statsData.playerstats.achievements.forEach(a => {
      if (a.achieved === 1) achievedSet[a.apiname] = true;
    });
  }

  let defs;
  if (cached && cached.length > 0) {
    defs = cached.map(a => ({
      name: a.apiName,
      displayName: a.nameCn || a.nameEn || a.apiName,
      description: a.hidden ? '(隐藏成就,解锁前不显示描述)' : a.description,
      icon: a.icon
    }));
  } else {
    const schemaUrl = 'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/'
      + '?key=' + CONFIG.STEAM_API_KEY + '&appid=' + appid + '&l=schinese&format=json';
    const schemaRes = UrlFetchApp.fetch(schemaUrl, { muteHttpExceptions: true });
    if (schemaRes.getResponseCode() !== 200) {
      return { error: '无法获取该游戏的成就定义(HTTP ' + schemaRes.getResponseCode() + ')' };
    }
    let schemaData;
    try {
      schemaData = JSON.parse(schemaRes.getContentText());
    } catch (e) {
      return { error: '成就定义返回内容解析失败' };
    }
    const achievementDefs = (schemaData.game && schemaData.game.availableGameStats
      && schemaData.game.availableGameStats.achievements) || [];
    if (achievementDefs.length === 0) {
      return { error: '该游戏没有成就系统,或者无法获取成就定义' };
    }
    defs = achievementDefs.map(def => ({
      name: def.name,
      displayName: def.displayName || def.name,
      description: def.hidden === 1 ? '(隐藏成就,解锁前不显示描述)' : (def.description || ''),
      icon: def.hidden === 1 ? (def.icongray || def.icon || '') : (def.icon || '')
    }));
  }

  const missing = defs.filter(a => !achievedSet[a.name]);

  return {
    total: defs.length,
    missingCount: missing.length,
    missing: missing.map(a => ({ name: a.displayName, description: a.description, icon: a.icon }))
  };
}

/**
 * Reads the already-synced achievement detail for an appid from the ACHIEVEMENTS sheet,
 * returns null if there isn't any.
 */
function getCachedAchievementSchema(appid) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.ACHIEVEMENTS_SHEET_NAME);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  const rows = data.filter(r => String(r[0]) === String(appid));
  if (rows.length === 0) return null;

  return rows.map(r => ({
    apiName: r[2],
    nameCn: r[3],
    nameEn: r[4],
    description: r[5],
    hidden: r[6] === 'TRUE' || r[6] === true,
    icon: r[7]
  }));
}

/**
 * Ensures the GUIDES tab exists (stores each game's guide-page link), auto-created if missing.
 */
function getOrCreateGuidesSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName('GUIDES');
  if (!sheet) {
    sheet = ss.insertSheet('GUIDES');
  }
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, 4).setValues([['AppID', '游戏名', '攻略链接', '更新日期']]);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Returns an appid -> guide-link map from the GUIDES sheet, for getDashboardData() to use.
 */
function getGuideUrlMap() {
  const sheet = getOrCreateGuidesSheet();
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;
  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  data.forEach(r => {
    if (r[0] && r[2]) map[String(r[0])] = r[2];
  });
  return map;
}
