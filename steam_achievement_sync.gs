/**
 * Steam 成就自动同步脚本 (Google Apps Script)
 * ------------------------------------------------
 * 设计原则:以 Steam API 返回的数据为 source of truth。
 * 表格以 appid 为主键,官方名字/成就数据都从 API 拉取,不依赖手动录入匹配。
 *
 * 使用前准备:
 * 1. 打开这个 Google Sheet -> 扩展程序(Extensions) -> Apps Script
 * 2. 把这个文件的内容整个粘贴进去(替换默认的 Code.gs 内容)
 * 3. 项目设置(齿轮图标) -> Script Properties -> 添加两个: STEAM_API_KEY / STEAM_ID
 *    (Steam API Key 在 https://steamcommunity.com/dev/apikey 获取;
 *    STEAM_ID 是你的 SteamID64,在 https://steamid.io 查)
 * 4. 运行一次 setup()(会要求你授权,点允许即可)
 * 5. 运行一次 rebuildSheetFromApi() 完成初始铺表
 * 6. 运行 createTrigger() 设置定时任务,之后就是全自动的了
 *
 * 日常会用到的函数:
 * - runBatch()          分批刷新成就数据(定时任务每天跑一次,通常不用手动碰)
 * - syncNewGames()       检测库里的新游戏并加进表格(定时任务自动跑)
 * - updateMissingRows()  手动加了新的appid行、不想等游标转一圈时,手动跑一下
 * - sortSheetByCompletion() 想按完成率/成就总数重新排序时手动跑
 * - fillMissingNames()    专门补名字(appid有但名字空着)的行,不看成就数据有没有填过
 * - fillChineseTranslations() 给英文名的行找中文名,找到直接覆盖游戏名(不是单独一列)
 *   (以后 syncNewGames() 新增游戏时,会默认优先尝试拿官方中文名,不用手动补)
 * - rebuildSheetFromApi() 想彻底重建表格(会保留手动加的"玩过但不owned"的行)时手动跑
 * - hardResetFromApi()    想完全清空、不保留任何旧行、彻底重来时手动跑(很少需要)
 *
 * 成就详情(完整checklist用)相关的功能拆到了单独文件 steam_achievements_detail.gs 里,
 * 里面的 syncAchievementSchema() 现在也接进了每日定时任务,新游戏/最近成就有更新的游戏
 * 会自动同步,不需要手动跑,参见那个文件顶部的说明。
 */

// ============ 配置区 ============
// STEAM_API_KEY / STEAM_ID 不会写死在代码里——从 Script Properties 读取
// (项目设置 -> Script Properties),这样代码可以公开发布,不会泄露个人信息。
const CONFIG = {
  STEAM_API_KEY: PropertiesService.getScriptProperties().getProperty('STEAM_API_KEY'),
  STEAM_ID: PropertiesService.getScriptProperties().getProperty('STEAM_ID'),
  SHEET_NAME: 'RAW DATA',
  ACHIEVEMENTS_SHEET_NAME: 'ACHIEVEMENTS', // 存全部游戏完整成就详情的独立标签页
  UNVETTED_COL: 1, // A列:Status标记。'Unvetted'=Steam默认隐藏的游戏(汇总统计会排除);'Manual'=人工记录、锁定不再自动同步的行
  APPID_COL: 2,    // B列:AppID(表的主键,所有自动化都靠它)
  NAME_COL: 3,     // C列:游戏名(来自 Steam API 的官方名字)
  ACHIEVED_COL: 4, // D列:完成数
  TOTAL_COL: 5,    // E列:成就总数(无成就系统的游戏会写 'N/A')
  RATE_COL: 6,     // F列:完成率
  FAVORITE_COL: 7, // G列:喜爱标记(♥),TRUE/FALSE,在Dashboard上点爱心切换
  PRIORITY_COL: 8, // H列:重点关注标记(★),TRUE/FALSE,在Dashboard上点星标切换,标记的游戏会置顶显示
  NEW_ACH_DATE_COL: 9, // I列:成就总数比上次记录变多的日期(说明游戏更新加了新成就),用于Dashboard提醒
  HEADER_ROW: 2,   // 数据从第几行开始
  BATCH_SIZE: 1000,       // 上限设高一点,真正兜底的是下面的 MAX_RUNTIME_MS
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
};

// ============ 初始化 ============
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CURSOR')) {
    props.setProperty('CURSOR', '0');
  }
  ensureHeaders();
  Logger.log('初始化完成');
}

/**
 * 确保各数据列在第1行都有表头文字。可以随时单独运行,也会在重建表格时自动调用。
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
  return /[一-鿿]/.test(String(str));
}

/**
 * 用 Steam API 的数据重建整张表,同时保留"appid不在当前owned列表里"的行
 * (手动加的、已玩过但现在不owned的游戏)。
 * 建议在想彻底清理陈旧数据、又不想丢失手动记录时运行。
 */
function rebuildSheetFromApi() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const result = fetchOwnedGamesWithUnvettedFlag();
  const ownedGames = result.games;
  const ownedAppIdSet = new Set(ownedGames.map(g => String(g.appid)));

  const manualRows = [];
  const manualStatusAppIds = new Set(); // 标过'Manual'的appid,不管owned与否,重建后都要保住这个标记
  if (lastRow >= CONFIG.HEADER_ROW) {
    const numCols = sheet.getLastColumn();
    const data = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, numCols).getValues();
    data.forEach(rowValues => {
      const appid = rowValues[CONFIG.APPID_COL - 1];
      const name = rowValues[CONFIG.NAME_COL - 1];
      const status = rowValues[CONFIG.UNVETTED_COL - 1];
      if (!name && !appid) return; // 整行都是空的,跳过
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
      sheet.getRange(row, CONFIG.UNVETTED_COL).setValue('Manual'); // 人工锁定优先,盖过API自动判定的Unvetted
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
  Logger.log('重建完成:写入 ' + ownedGames.length + ' 个 API 游戏(其中 ' + result.unvettedAppIds.size
    + ' 个标记为Unvetted,' + manualStatusAppIds.size + ' 个人工锁定Manual保留) + 保留 ' + manualRows.length + ' 个手动/非owned行');
}

/**
 * 硬重置:不保留任何东西,直接用 Steam API 的数据把整张表重新铺一遍。
 * 手动加的行(包括可能有appid错误的那些)也会被一起清掉。
 * 适合想彻底清干净、重新开始的情况,平时不需要跑。
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
  Logger.log('硬重置完成:写入 ' + result.games.length + ' 个 API 游戏(其中 ' + result.unvettedAppIds.size
    + ' 个标记为Unvetted),没有保留任何旧行');
}

/**
 * 检测 Steam 库里表格中还没有的新游戏,自动追加成新行。
 */
function syncNewGames() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const result = fetchOwnedGamesWithUnvettedFlag();
  const existingAppIds = getExistingAppIds(sheet);

  const newGames = result.games.filter(g => !existingAppIds.has(String(g.appid)));
  if (newGames.length === 0) {
    Logger.log('没有发现新游戏');
    return;
  }

  let nextRow = sheet.getLastRow() + 1;
  newGames.forEach(g => {
    const bestName = fetchAppName(g.appid) || g.name; // 优先用两层查到的中文名,查不到就退回GetOwnedGames给的名字
    sheet.getRange(nextRow, CONFIG.NAME_COL).setValue(bestName);
    sheet.getRange(nextRow, CONFIG.APPID_COL).setValue(g.appid);
    if (result.unvettedAppIds.has(String(g.appid))) {
      sheet.getRange(nextRow, CONFIG.UNVETTED_COL).setValue('Unvetted');
    }
    nextRow++;
    Utilities.sleep(300);
  });

  Logger.log('新增了 ' + newGames.length + ' 款游戏: ' + JSON.stringify(newGames.map(g => g.name)));
}

function getExistingAppIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.HEADER_ROW) return new Set();
  const values = sheet.getRange(CONFIG.HEADER_ROW, CONFIG.APPID_COL, lastRow - CONFIG.HEADER_ROW + 1, 1).getValues();
  const set = new Set();
  values.forEach(r => { if (r[0]) set.add(String(r[0])); });
  return set;
}

// ============ 核心:分批同步成就数据 ============
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
        Logger.log('appid ' + appid + ' 更新失败: ' + e.message);
      }
      Utilities.sleep(300);
    }

    cursor++;
    processed++;
  }

  props.setProperty('CURSOR', String(cursor));
  Logger.log('本次处理范围: 第' + (CONFIG.HEADER_ROW + startCursor) + '行 到 第' + (CONFIG.HEADER_ROW + cursor - 1)
    + '行 (共' + processed + '行, 表格总数据行数=' + totalDataRows + ')');
  updateSummaryStats();
}

/**
 * 给英文名的行找中文名,找到直接覆盖游戏名(不再单独存一列)。
 * 抓网页比调用API接口容易被限流,单次运行时间到了会先停,可以多跑几次逐步补完。
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
      Logger.log('时间快到了,先停在第' + row + '行。抓网页容易被限流,建议隔一会再跑一次接着补。');
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
    Utilities.sleep(800); // 抓网页比调用API接口容易触发限流,间隔拉长一些
  }

  Logger.log('补中文名完成: 新查到官方标题 ' + official + ' 个, 没有官方中文名 '
    + notFound + ' 个(保持原样,下次可重试), 跳过(已是中文) ' + skipped + ' 个');
}

/**
 * 专门补名字:扫一遍全表,把appid有、但名字是空的行都反查一次官方名字。
 * 不看C/D列有没有数据,专门解决"成就数据已经填了、名字还是空的"这种卡住的情况。
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

  Logger.log('补名字完成:成功 ' + filled + ' 个,失败 ' + failed + ' 个(失败原因看上面的日志)');
}

/**
 * 不看游标,直接扫一遍全表,把还没有成就数据的行(D列是空的,且不是N/A)全部补上。
 * 适合手动加了新行、不想等游标转一圈才轮到它们的情况。
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
      Logger.log('appid ' + appid + ' 更新失败: ' + e.message);
    }
    updated++;
    Utilities.sleep(300);
  }

  Logger.log('补全完成,共处理 ' + updated + ' 行缺失数据');
  updateSummaryStats();
}

function updateRowForGame(sheet, row, appid) {
  const currentName = sheet.getRange(row, CONFIG.NAME_COL).getValue();
  if (!currentName) {
    const officialName = fetchAppName(appid); // 两层查:JSON优先,没中文再抓商店网页,拿到最好的一个名字
    if (officialName) sheet.getRange(row, CONFIG.NAME_COL).setValue(officialName);
    Utilities.sleep(300); // 商店接口限流比较严格,单独留个间隔,别紧接着就打成就接口
  }

  const result = fetchAchievementStats(appid);

  if (result.noAchievementSystem) {
    sheet.getRange(row, CONFIG.TOTAL_COL).setValue('N/A');
    return;
  }

  if (result.retry) {
    return; // 临时性错误,留空让下次重试
  }

  const stats = result;
  const previousTotal = sheet.getRange(row, CONFIG.TOTAL_COL).getValue();
  const rate = stats.total > 0 ? stats.achieved / stats.total : 0;

  // 如果这次查到的成就总数比上次记录的多,说明游戏更新加了新成就,记一下日期
  if (typeof previousTotal === 'number' && stats.total > previousTotal) {
    sheet.getRange(row, CONFIG.NEW_ACH_DATE_COL).setValue(new Date());
  }

  sheet.getRange(row, CONFIG.ACHIEVED_COL).setValue(stats.achieved);
  sheet.getRange(row, CONFIG.TOTAL_COL).setValue(stats.total);
  sheet.getRange(row, CONFIG.RATE_COL).setValue(rate);
  sheet.getRange(row, CONFIG.RATE_COL).setNumberFormat('0.00%');
}

/**
 * 按完成率(RATE_COL)降序、成就总数(TOTAL_COL)降序排一次表格数据区。
 * 空值(还没同步到数据的行)会自动排到最后。
 * 注意:排序会打乱行的物理位置,游标(CURSOR)记的是"第几行"而不是具体哪款游戏,
 * 排序后游标含义会跟着变,但不影响正确性——runBatch 只是按位置顺序轮流处理,
 * 转几圈下来所有行还是都会被处理到,不会漏掉。
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
 * 按 Steam 官方社区文档记录的 AGCR(Average Game Completion Rate)算法计算,
 * 返回计算结果,不写回表格(表格里不再保留汇总统计单元格,只在Dashboard里现算显示)。
 * - 只有"至少解锁过1个成就"的游戏才计入平均(0个成就的游戏直接排除,不算0%)
 * - 每款符合条件的游戏各算一个完成率,取算术平均(权重相同,和成就总数无关)
 * - 标记为Unvetted(Profile Features Limited)的游戏排除在外,和Steam官方口径一致
 * 参考: https://steamcommunity.com/sharedfiles/filedetails/?id=650166273
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
 * 只打日志,方便在编辑器里手动跑一下快速看眼汇总数字,不会写回表格。
 */
function updateSummaryStats() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const stats = computeAgcrStats(sheet);
  const roundedDownPct = Math.floor(stats.avg * 100);
  Logger.log('AGCR计算完成: 符合条件游戏数=' + stats.eligibleCount
    + ', 平均完成率=' + roundedDownPct + '% (精确值 ' + (stats.avg * 100).toFixed(5) + '%), 完美游戏数=' + stats.perfectCount);
}

/**
 * 用 Steam 商店的公开接口(不需要登录、不需要拥有游戏)按 appid 反查官方游戏名。
 * 注意:appdetails 这个JSON接口返回的 name 字段经常不受 l 参数本地化影响(是Steam的一个已知怪癖),
 * 所以如果JSON给的名字没有中文,会再去抓一次商店网页本身的HTML,那里才是真正展示用的本地化标题。
 */
function fetchAppName(appid) {
  const apiName = fetchAppNameFromJson(appid);
  if (apiName && hasChineseChars(apiName)) return apiName;

  const pageName = fetchAppNameFromStorePage(appid);
  if (pageName && hasChineseChars(pageName)) return pageName;

  return apiName; // 两边都没有中文名,只能返回JSON给的名字(可能是英文)
}

function fetchAppNameFromJson(appid) {
  const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=schinese';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('appid ' + appid + ' -> 反查名字失败, HTTP ' + res.getResponseCode() + ' (商店接口限流比较严格,常见于短时间内查太多次)');
    return null;
  }

  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    Logger.log('appid ' + appid + ' -> 反查名字失败, 返回内容不是合法JSON(大概率也是被限流了,返回了错误页面)');
    return null;
  }

  const entry = data[String(appid)];
  if (entry && entry.success && entry.data && entry.data.name) {
    return entry.data.name;
  }
  Logger.log('appid ' + appid + ' -> 反查名字失败, 商店接口没有返回有效数据(可能appid无效或该商品类型不支持)');
  return null;
}

/**
 * 抓商店网页本身的HTML,提取真正展示用的本地化标题(apphub_AppName这个元素)。
 * 比JSON接口的name字段更可靠,但网页结构以后可能会变,属于"尽力而为"的兜底方案。
 * 带上年龄验证的cookie,避免部分游戏被年龄确认页面拦住抓不到正文。
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
  // class属性可能带多个class(比如 "apphub_AppName xxx"),不要求精确匹配整个属性值
  const match = html.match(/<div[^>]*class="[^"]*apphub_AppName[^"]*"[^>]*>([^<]+)<\/div>/);
  if (match && match[1]) return match[1].trim();
  return null;
}

// ============ Steam API 封装 ============
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
 * 拉取完整owned列表(含Steam默认会隐藏的"Unvetted/Profile Features Limited"游戏),
 * 同时标记出哪些是被隐藏的那批,方便在表格里单独标注。
 * 返回 { games: [...], unvettedAppIds: Set }
 */
function fetchOwnedGamesWithUnvettedFlag() {
  const fullList = fetchOwnedGames(false);   // 不跳过unvetted,拿到完整列表
  const vettedList = fetchOwnedGames(true);  // 跳过unvetted,拿到"官方认可"的那部分
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
    Logger.log('appid ' + appid + ' -> HTTP 429 限流,先留空,下次重试');
    return { retry: true };
  }

  if (code !== 200) {
    Logger.log('appid ' + appid + ' -> HTTP ' + code + ' (Steam判定无成就数据,标记N/A)');
    return { noAchievementSystem: true };
  }

  const data = JSON.parse(res.getContentText());
  const stats = data.playerstats;

  if (!stats || !stats.success) {
    const reason = (stats && stats.error) || '未知原因';
    Logger.log('appid ' + appid + ' -> ' + reason + ' (标记N/A,不再重试)');
    return { noAchievementSystem: true };
  }

  if (!stats.achievements) {
    Logger.log('appid ' + appid + ' -> 确认无成就系统');
    return { noAchievementSystem: true };
  }

  const total = stats.achievements.length;
  const achieved = stats.achievements.filter(a => a.achieved === 1).length;
  return { total, achieved };
}

// ============ 定时任务 ============
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'runBatch' || fn === 'syncNewGames' || fn === 'syncAchievementSchema') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runBatch').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('syncNewGames').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('syncAchievementSchema').timeBased().everyDays(1).atHour(4).create();
  Logger.log('定时任务已创建:runBatch 凌晨2点、syncNewGames 凌晨3点、syncAchievementSchema 凌晨4点,每天各跑一次');
}
