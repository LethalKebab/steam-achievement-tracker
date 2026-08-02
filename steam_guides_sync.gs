/**
 * 攻略链接同步工具:给 Claude Code 通过独立的 Web App 部署(单独部署,
 * 访问权限"任何人",和 Dashboard 的部署分开、互不影响)远程调用,
 * 把 Notion 里的攻略链接同步进 GUIDES 标签页,不用手动复制粘贴。
 *
 * 安全性靠 SYNC_SECRET 这个随机token:请求体里不带对的token直接拒绝。
 * 注意:这个token和Steam API Key一样是敏感信息,存在脚本属性里,不写进代码/不提交到公开仓库。
 * 设置方法:项目设置(左侧齿轮图标) -> 脚本属性 -> 新增 SYNC_SECRET,
 * 值填一个自己生成的随机字符串(比如跑一次 `openssl rand -hex 32`)。
 */
const SYNC_SECRET = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');

/**
 * POST入口:{ token, action, payload } 格式的JSON请求体。
 * action 支持: listOwnedGames / listGuideRows / upsertGuideLinks
 */
function doPost(e) {
  let body;
  try {
    // e.postData.contents 对多字节UTF-8字符解码有bug,显式指定编码更可靠
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
 * 返回 RAW DATA 表里持有的全部游戏 {appid, name},用于按游戏名匹配 appid。
 */
function listOwnedGames() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 2, lastRow - 1, 2).getValues(); // B=AppID, C=游戏名
  return data
    .filter(r => r[0])
    .map(r => ({ appid: String(r[0]), name: r[1] }));
}

/**
 * 返回 GUIDES 表当前所有行,用于同步前对比。
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
 * 批量写入/更新攻略链接。entries: [{appid, name, url}]
 * 按 appid 匹配已有行:存在则更新链接+日期,不存在则追加新行。
 * 返回 {updated: [...], appended: [...]}
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
 * 在 RAW DATA 表里追加一行 Status='Manual' 的游戏(比如家庭共享、不在Steam owned列表里的游戏)。
 * entry: {appid, name, achieved (可选,默认0), total (可选,默认'N/A')}
 * Manual状态的行不会被 runBatch/rebuildSheetFromApi 的自动成就同步覆盖,需要手动维护完成数。
 * appid已存在则直接报错,不做覆盖(避免误伤已有数据)。
 */
function addManualGame(entry) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const appid = String(entry.appid);

  if (lastRow >= 2) {
    const existingAppIds = sheet.getRange(2, CONFIG.APPID_COL, lastRow - 1, 1).getValues().flat().map(String);
    if (existingAppIds.includes(appid)) {
      throw new Error('appid ' + appid + ' 已经在 RAW DATA 里了,不重复添加');
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
 * 返回某个appid已解锁的成就列表,带中英文名字/描述(从ACHIEVEMENTS表查),
 * 给Claude Code拿去匹配Notion攻略页面里的checkbox用。
 * 复用 steam_achievement_sync.gs 里已有的 GetPlayerAchievements 调用逻辑。
 */
function getUnlockedAchievements(appid) {
  appid = String(appid);
  const stats = fetchAchievementStats(appid); // 来自 steam_achievement_sync.gs
  if (stats.noAchievementSystem) {
    throw new Error('appid ' + appid + ' 查不到成就数据(可能没有成就系统,或Steam判定这个账号没有stats)');
  }
  if (stats.retry) {
    throw new Error('appid ' + appid + ' 被限流(429),稍后再试');
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

  // fetchAchievementStats 目前只返回汇总数,这里重新拉一次原始列表拿逐条 achieved 状态
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
 * 返回某个appid的完整成就列表(不管是否解锁),带中英文名字/描述/是否隐藏成就(ACHIEVEMENTS表)
 * + 真实解锁状态(GetPlayerAchievements)。用于从头重写/修正一份攻略页面的成就清单。
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
    throw new Error('appid ' + appid + ' 在 ACHIEVEMENTS 表里没有记录,先跑 syncAchievementSchema 补齐');
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
