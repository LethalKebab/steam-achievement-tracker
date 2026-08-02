/**
 * 成就详情同步(独立文件,和 steam_achievement_sync.gs 分开,减少主文件体积)
 * ------------------------------------------------
 * 用法:
 * 1. 在同一个 Apps Script 项目里新建一个文件(名字随意),把这个文件内容粘进去
 * 2. 因为和主文件在同一个项目里,可以直接复用 CONFIG(STEAM_API_KEY等)
 * 3. 运行 syncAchievementSchema()
 *
 * 功能:批量把 RAW DATA 里所有游戏的完整官方成就详情(名字/描述/是否隐藏/图标),
 * 拉进独立的 "ACHIEVEMENTS" 标签页(第一次跑会自动创建这个标签页)。
 * 中文+英文都存:中文给你自己看,英文名字留着以后搜社区攻略用(攻略基本都是英文写的,
 * 光有中文名字搜不出对应的英文攻略)。
 *
 * 会自动刷新的情况(不用手动干预):
 * - 这个appid在ACHIEVEMENTS表里还没有任何记录(新游戏)
 * - RAW DATA里这个游戏的"成就更新日期"是最近7天内(说明它更新加了新成就,参见主文件里
 *   updateRowForGame的成就总数变化检测逻辑)
 * 会跳过的情况:
 * - 完成率(RATE_COL)刚好是100%的游戏——已经全成就了,不需要checklist
 * - 完成率不确定/不是100%的游戏(包括家庭共享那种没法确认具体进度的)不会被跳过,
 *   因为不能确认它已经全成就,宁可多处理也不能漏掉
 * 已经同步过、又没有最近更新的游戏会跳过,不重复查询。
 * 时间到了会先停,可以多跑几次接着补完整个库。
 */
function syncAchievementSchema() {
  const startTime = Date.now();
  const rawSheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const achSheet = getOrCreateAchievementsSheet();

  // 读RAW DATA,判断每个appid是否需要处理
  const lastRow = rawSheet.getLastRow();
  const games = [];
  for (let row = CONFIG.HEADER_ROW; row <= lastRow; row++) {
    const appid = rawSheet.getRange(row, CONFIG.APPID_COL).getValue();
    const total = rawSheet.getRange(row, CONFIG.TOTAL_COL).getValue();
    const rate = rawSheet.getRange(row, CONFIG.RATE_COL).getValue();
    const gameName = rawSheet.getRange(row, CONFIG.NAME_COL).getValue();
    const newAchDate = rawSheet.getRange(row, CONFIG.NEW_ACH_DATE_COL).getValue();
    if (!appid || total === 'N/A') continue;
    if (typeof rate === 'number' && rate === 1) continue; // 已经100%完成的游戏,不需要成就checklist,跳过
    const recentlyUpdated = (newAchDate instanceof Date) && ((Date.now() - newAchDate.getTime()) < 7 * 86400000);
    games.push({ appid: String(appid), name: gameName, recentlyUpdated: recentlyUpdated });
  }

  // 读现有ACHIEVEMENTS数据
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
    Logger.log('没有需要新增或刷新的游戏');
    return;
  }

  // 保留不需要刷新的旧数据;要刷新的appid,旧行先去掉,后面重新写入新查到的
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

  // 重写数据区:表头保留,内容替换成"保留的旧行 + 新查到的行"
  const allRows = keptRows.concat(newRows);
  if (achSheet.getLastRow() >= 2) {
    achSheet.getRange(2, 1, achSheet.getLastRow() - 1, 8).clearContent();
  }
  if (allRows.length > 0) {
    achSheet.getRange(2, 1, allRows.length, 8).setValues(allRows);
  }

  Logger.log('成就详情同步完成: 新增/刷新了 ' + processedGames + ' 款游戏, 跳过(查不到定义) ' + skippedNoSchema + ' 款'
    + (timedOut ? ' (时间到了,还有游戏没处理完,可以再跑一次接着补)' : ''));
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
 * 查询某个appid的完整官方成就定义(GetSchemaForGame),按指定语言查。
 * 不需要steamid,不依赖账号登录,是纯粹按appid查的公开数据。
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
