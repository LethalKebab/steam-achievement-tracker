/**
 * Steam 成就 Dashboard(独立文件,和 steam_achievement_sync.gs 放在同一个 Apps Script 项目里)
 * ------------------------------------------------
 * 用法:
 * 1. 在同一个 Apps Script 项目里新建这个文件(粘贴这份内容),再新建一个 HTML 文件叫
 *    "Dashboard"(文件名必须是这个,不带.html后缀,Apps Script 自动识别为HTML文件),
 *    把 Dashboard.html 的内容粘进去
 * 2. 因为在同一个项目里,可以直接用 steam_achievement_sync.gs 里的 CONFIG,不用重复配置
 * 3. 部署为网页应用:右上角"部署" -> "新建部署" -> 类型选"网页应用"
 *    - 执行身份:选"我"
 *    - 访问权限:按你需求选(比如"仅我自己"最私密;想分享给别人看选"知道链接的任何人",
 *      注意这样任何拿到链接的人都能看到你的Steam数据)
 * 4. 部署后会给你一个网址,那就是你的 dashboard 链接,以后表格数据更新了直接刷新页面就行,
 *    不需要重新部署(除非改了这两个文件的代码)
 *
 * 攻略功能:GUIDES 标签页(AppID / 游戏名 / 攻略链接 / 更新日期)存每款游戏的攻略页面链接,
 * 没有这个标签页的话第一次调用 getDashboardData() 会自动创建。
 * 攻略内容放在外部工具里(Notion、Google Doc都行,存哪都一样,只是存个链接进表格),
 * 推荐Notion,因为粘贴markdown文本时会自动把"- [ ]"识别转换成真正可勾选的to-do块,不用额外操作。
 * 把攻略页面的分享链接粘贴进"攻略链接"这一列就行,一行一个URL,不会有多行粘贴被拆行的问题。
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('Steam Achievement Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 供 Dashboard.html 通过 google.script.run 调用,读取 RAW DATA 表格,
 * 整理成前端要用的 JSON 结构。
 */
function getDashboardData() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const numRows = Math.max(0, lastRow - CONFIG.HEADER_ROW + 1);

  const guideUrls = getGuideUrlMap();

  const games = [];
  if (numRows > 0) {
    const lastCol = Math.max(CONFIG.UNVETTED_COL, CONFIG.RATE_COL, CONFIG.APPID_COL, CONFIG.NAME_COL, CONFIG.FAVORITE_COL, CONFIG.PRIORITY_COL, CONFIG.NEW_ACH_DATE_COL, CONFIG.FAMILY_COL);
    const data = sheet.getRange(CONFIG.HEADER_ROW, 1, numRows, lastCol).getValues();
    data.forEach(row => {
      const appid = row[CONFIG.APPID_COL - 1];
      const name = row[CONFIG.NAME_COL - 1];
      if (!appid && !name) return; // 跳过空行

      const achievedRaw = row[CONFIG.ACHIEVED_COL - 1];
      const totalRaw = row[CONFIG.TOTAL_COL - 1];
      const rateRaw = row[CONFIG.RATE_COL - 1];
      const statusRaw = row[CONFIG.UNVETTED_COL - 1];
      const favoriteRaw = row[CONFIG.FAVORITE_COL - 1];
      const priorityRaw = row[CONFIG.PRIORITY_COL - 1];
      const newAchDateRaw = row[CONFIG.NEW_ACH_DATE_COL - 1];
      const familyRaw = row[CONFIG.FAMILY_COL - 1];

      games.push({
        appid: appid || '',
        name: name || '(未命名)',
        achieved: (typeof achievedRaw === 'number') ? achievedRaw : null,
        total: (totalRaw === 'N/A') ? 'N/A' : ((typeof totalRaw === 'number') ? totalRaw : null),
        rate: (typeof rateRaw === 'number') ? rateRaw : null,
        unvetted: statusRaw === 'Unvetted',
        manual: statusRaw === 'Manual',
        family: familyRaw === true || familyRaw === 'TRUE',
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
 * 从Dashboard点星标调用:切换某个appid的喜爱状态,写回表格,返回切换后的新状态。
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
 * 从Dashboard点星标调用:切换某个appid的"重点关注"状态,写回表格,返回切换后的新状态。
 * 标记了这个的游戏会在Dashboard里置顶显示。
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
 * 从Dashboard切换某个appid的"家庭共享/非自购"标记(纯信息用途,J列)。
 * 和Status完全独立,不影响runBatch是否同步——只是让你自己知道这游戏不是自己买的。
 */
function toggleFamily(appid) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return { error: '表格没有数据' };

  const numRows = lastRow - CONFIG.HEADER_ROW + 1;
  const appidVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    if (String(appidVals[i][0]) === String(appid)) {
      const row = CONFIG.HEADER_ROW + i;
      const current = sheet.getRange(row, CONFIG.FAMILY_COL).getValue();
      const newVal = !(current === true || current === 'TRUE');
      sheet.getRange(row, CONFIG.FAMILY_COL).setValue(newVal);
      return { family: newVal };
    }
  }

  return { error: '没有在表格里找到这个appid' };
}

/**
 * 从Dashboard切换某个appid的Manual状态:设为Manual后 runBatch 会跳过这行,
 * 不再自动同步成就数据(给家庭共享、不在Steam owned列表里的游戏用)。
 */
function setManualStatus(appid, isManual) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return { error: '表格没有数据' };

  const numRows = lastRow - CONFIG.HEADER_ROW + 1;
  const appidVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    if (String(appidVals[i][0]) === String(appid)) {
      const row = CONFIG.HEADER_ROW + i;
      sheet.getRange(row, CONFIG.UNVETTED_COL).setValue(isManual ? 'Manual' : '');
      return { manual: isManual };
    }
  }

  return { error: '没有在表格里找到这个appid' };
}

/**
 * 从Dashboard手动编辑Manual游戏的完成数/成就总数(家庭共享游戏没有Steam API数据,
 * 只能手动维护),写回表格并按同样的公式重算完成率。只允许改Status为Manual的行,
 * 避免误改到还在被 runBatch 自动同步的行。
 */
function setManualAchievements(appid, achieved, total) {
  achieved = Number(achieved);
  total = Number(total);
  if (!isFinite(achieved) || !isFinite(total) || achieved < 0 || total < 0) {
    return { error: '数值无效' };
  }
  if (achieved > total) {
    return { error: '完成数不能大于成就总数' };
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return { error: '表格没有数据' };

  const numRows = lastRow - CONFIG.HEADER_ROW + 1;
  const appidVals = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    if (String(appidVals[i][0]) === String(appid)) {
      const row = CONFIG.HEADER_ROW + i;
      if (sheet.getRange(row, CONFIG.UNVETTED_COL).getValue() !== 'Manual') {
        return { error: '只能编辑Manual状态的游戏' };
      }
      const rate = total > 0 ? achieved / total : 0;
      sheet.getRange(row, CONFIG.ACHIEVED_COL).setValue(achieved);
      sheet.getRange(row, CONFIG.TOTAL_COL).setValue(total);
      sheet.getRange(row, CONFIG.RATE_COL).setValue(rate);
      sheet.getRange(row, CONFIG.RATE_COL).setNumberFormat('0.00%');
      return { achieved: achieved, total: total, rate: rate };
    }
  }

  return { error: '没有在表格里找到这个appid' };
}

/**
 * 按需查询:某个appid还差哪些成就没解锁(带图标、名字、描述)。
 * 优先用 syncAchievementSchema() 已经批量同步好的 ACHIEVEMENTS 表数据(不用再联网查一次成就定义),
 * 只需要实时查一次"你具体解锁了哪些"(GetPlayerAchievements)。
 * 如果 ACHIEVEMENTS 表里还没有这个游戏的数据,退回到实时双查询方式。
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
 * 从 ACHIEVEMENTS 表读取某个appid已经同步好的成就详情,没有就返回null。
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
 * 确保 GUIDES 标签页存在(存每款游戏对应的攻略Google Doc链接),没有就自动创建。
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
 * 返回GUIDES表里 appid -> Google Doc链接 的映射,给getDashboardData()用。
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
