/**
 * Steam API 调试/测试工具(独立文件,和正式同步脚本 steam_achievement_sync.gs 分开)
 * ------------------------------------------------
 * 用法:
 * 1. 在同一个 Apps Script 项目里,新建一个文件(左侧文件列表 "+" -> Script),
 *    命名随意(比如 test),把这个文件内容粘贴进去
 * 2. 因为和正式脚本在同一个项目里,可以直接复用 CONFIG 里的 STEAM_API_KEY / STEAM_ID
 * 3. 想删的时候直接删掉这个文件就行,不会影响正式脚本
 */

/**
 * 把某个appid的成就接口原始返回内容打到日志里,方便直接看Steam返回了什么。
 * 用法:把 appid 换成你要测试的数字,直接运行这个函数(不用传参)。
 */
function debugRawAchievements() {
  const appid = 47890; // <-- 改成你要测试的appid

  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/`
    + `?appid=${appid}&key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('appid: ' + appid);
  Logger.log('HTTP状态码: ' + res.getResponseCode());
  Logger.log('原始返回内容: ' + res.getContentText());
}

/**
 * 把商店接口(反查游戏名用的那个)针对某个appid的原始返回打到日志里。
 */
function debugRawAppDetails() {
  const appid = 47890; // <-- 改成你要测试的appid

  const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=schinese';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('appid: ' + appid);
  Logger.log('HTTP状态码: ' + res.getResponseCode());
  Logger.log('原始返回内容: ' + res.getContentText());
}

/**
 * 把 GetOwnedGames 的原始返回打到日志里(注意:数据量可能很大,日志会很长)。
 */
function debugRawOwnedGames() {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/`
    + `?key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}`
    + `&include_appinfo=true&include_played_free_games=true&format=json&l=schinese`
    + `&skip_unvetted_apps=false`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('HTTP状态码: ' + res.getResponseCode());
  Logger.log('原始返回内容: ' + res.getContentText());
}

/**
 * 对比 skip_unvetted_apps=true / false 两次调用的差异,列出哪些appid只在false版本里出现
 * (也就是被Steam默认隐藏的"Unvetted/Profile Features Limited"游戏)。
 */
function debugCompareUnvetted() {
  const result = fetchOwnedGamesWithUnvettedFlag();
  Logger.log('完整列表游戏数: ' + result.games.length);
  Logger.log('被标记为Unvetted的游戏appid列表: ' + JSON.stringify(Array.from(result.unvettedAppIds)));
  const unvettedNames = result.games
    .filter(g => result.unvettedAppIds.has(String(g.appid)))
    .map(g => g.appid + ': ' + g.name);
  Logger.log('对应游戏名:\n' + unvettedNames.join('\n'));
}

/**
 * 排查商店网页抓取失败用:把某个appid的商店页面抓回来,看看HTTP状态码、页面长度、
 * 是否含有 apphub_AppName 关键词、以及 <title> 标签内容,方便判断是页面结构问题还是被拦截了。
 */
function debugStorePageHtml() {
  const appid = 1366540; // <-- 改成你要测试的appid,这个默认是《戴森球计划》

  const url = 'https://store.steampowered.com/app/' + appid + '/?l=schinese';
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Cookie': 'birthtime=189302401; mature_content=1; wants_mature_content=1; lastagecheckage=1-January-1976' }
  });
  const html = res.getContentText();

  Logger.log('HTTP状态码: ' + res.getResponseCode());
  Logger.log('页面长度: ' + html.length);
  Logger.log('是否包含 apphub_AppName: ' + html.includes('apphub_AppName'));
  Logger.log('是否包含年龄验证关键词: ' + (html.includes('agecheck') || html.includes('agegate') || html.includes('请验证您的年龄')));

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  Logger.log('<title>标签内容: ' + (titleMatch ? titleMatch[1] : '未找到'));

  const idx = html.indexOf('apphub_AppName');
  if (idx >= 0) {
    Logger.log('apphub_AppName 附近的HTML片段: ' + html.substring(Math.max(0, idx - 50), idx + 150));
  }
}

/**
 * 给"做成就攻略清单"用的:把某个appid的完整成就列表(官方简体中文,如果有的话)倒出来,
 * 包括每个成就的名字、描述、是否隐藏成就。跑完把日志复制给Claude,就能做成对应游戏的checklist,
 * 不用每次都手动去网页上搜/复制。
 */
function debugDumpAchievementSchema() {
  const appid = 2185060; // <-- 改成你要查的游戏appid

  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/`
    + `?key=${CONFIG.STEAM_API_KEY}&appid=${appid}&l=schinese&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('HTTP状态码: ' + res.getResponseCode());

  if (res.getResponseCode() !== 200) {
    Logger.log('请求失败,原始返回: ' + res.getContentText());
    return;
  }

  const data = JSON.parse(res.getContentText());
  const achievements = (data.game && data.game.availableGameStats && data.game.availableGameStats.achievements) || [];

  if (achievements.length === 0) {
    Logger.log('没有查到成就数据,原始返回: ' + res.getContentText());
    return;
  }

  Logger.log('appid ' + appid + ' 共 ' + achievements.length + ' 个成就:\n');
  achievements.forEach((a, i) => {
    Logger.log((i + 1) + '. [' + a.name + '] ' + (a.displayName || '(无名字)')
      + (a.hidden === 1 ? ' 【隐藏成就】' : '')
      + '\n   描述: ' + (a.description || '(无描述,大概率是隐藏成就)'));
  });
}
