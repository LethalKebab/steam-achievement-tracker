/**
 * Steam API debugging/testing tools (a separate file from the main sync script
 * steam_achievement_sync.gs)
 * ------------------------------------------------
 * Usage:
 * 1. In the same Apps Script project, create a new file (left file list "+" -> Script),
 *    name it whatever (e.g. test), and paste this content in
 * 2. Being in the same project, this can reuse CONFIG's STEAM_API_KEY / STEAM_ID directly
 * 3. Delete this file whenever you want - it won't affect the main script
 */

/**
 * Logs the raw response of the achievement endpoint for a given appid, so you can see
 * exactly what Steam returned.
 * Usage: change appid to the number you want to test, then just run this function
 * (no arguments needed).
 */
function debugRawAchievements() {
  const appid = 47890; // <-- change to the appid you want to test

  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/`
    + `?appid=${appid}&key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('appid: ' + appid);
  Logger.log('HTTP status: ' + res.getResponseCode());
  Logger.log('Raw response: ' + res.getContentText());
}

/**
 * Logs the raw response of the store endpoint (the one used to look up game names) for a
 * given appid.
 */
function debugRawAppDetails() {
  const appid = 47890; // <-- change to the appid you want to test

  const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=schinese';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('appid: ' + appid);
  Logger.log('HTTP status: ' + res.getResponseCode());
  Logger.log('Raw response: ' + res.getContentText());
}

/**
 * Logs the raw response of GetOwnedGames (note: this can be a lot of data, the log will be long).
 */
function debugRawOwnedGames() {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/`
    + `?key=${CONFIG.STEAM_API_KEY}&steamid=${CONFIG.STEAM_ID}`
    + `&include_appinfo=true&include_played_free_games=true&format=json&l=schinese`
    + `&skip_unvetted_apps=false`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('HTTP status: ' + res.getResponseCode());
  Logger.log('Raw response: ' + res.getContentText());
}

/**
 * Diffs two GetOwnedGames calls (skip_unvetted_apps=true vs false) and lists which
 * appids only show up in the false version (i.e. games Steam hides by default under
 * "Unvetted/Profile Features Limited").
 */
function debugCompareUnvetted() {
  const result = fetchOwnedGamesWithUnvettedFlag();
  Logger.log('Full list game count: ' + result.games.length);
  Logger.log('Appids flagged Unvetted: ' + JSON.stringify(Array.from(result.unvettedAppIds)));
  const unvettedNames = result.games
    .filter(g => result.unvettedAppIds.has(String(g.appid)))
    .map(g => g.appid + ': ' + g.name);
  Logger.log('Corresponding game names:\n' + unvettedNames.join('\n'));
}

/**
 * For diagnosing store-page scraping failures: fetches the store page for a given appid
 * and reports the HTTP status, page length, whether it contains the apphub_AppName
 * keyword, and the <title> tag content - useful for telling apart a page-structure issue
 * from being blocked outright.
 */
function debugStorePageHtml() {
  const appid = 1366540; // <-- change to the appid you want to test; this default is Dyson Sphere Program

  const url = 'https://store.steampowered.com/app/' + appid + '/?l=schinese';
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Cookie': 'birthtime=189302401; mature_content=1; wants_mature_content=1; lastagecheckage=1-January-1976' }
  });
  const html = res.getContentText();

  Logger.log('HTTP status: ' + res.getResponseCode());
  Logger.log('Page length: ' + html.length);
  Logger.log('Contains apphub_AppName: ' + html.includes('apphub_AppName'));
  Logger.log('Contains age-verification keyword: ' + (html.includes('agecheck') || html.includes('agegate') || html.includes('请验证您的年龄')));

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  Logger.log('<title> tag content: ' + (titleMatch ? titleMatch[1] : 'not found'));

  const idx = html.indexOf('apphub_AppName');
  if (idx >= 0) {
    Logger.log('HTML around apphub_AppName: ' + html.substring(Math.max(0, idx - 50), idx + 150));
  }
}

/**
 * For building an achievement guide checklist: dumps the full achievement list for a
 * given appid (official localized text, if available), including each achievement's
 * name, description, and hidden flag. Copy the log output to hand off to an LLM to draft
 * that game's checklist, instead of manually searching/copying from a web page each time.
 */
function debugDumpAchievementSchema() {
  const appid = 2185060; // <-- change to the appid you want to look up

  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/`
    + `?key=${CONFIG.STEAM_API_KEY}&appid=${appid}&l=schinese&format=json`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('HTTP status: ' + res.getResponseCode());

  if (res.getResponseCode() !== 200) {
    Logger.log('Request failed, raw response: ' + res.getContentText());
    return;
  }

  const data = JSON.parse(res.getContentText());
  const achievements = (data.game && data.game.availableGameStats && data.game.availableGameStats.achievements) || [];

  if (achievements.length === 0) {
    Logger.log('No achievement data found, raw response: ' + res.getContentText());
    return;
  }

  Logger.log('appid ' + appid + ' has ' + achievements.length + ' achievements:\n');
  achievements.forEach((a, i) => {
    Logger.log((i + 1) + '. [' + a.name + '] ' + (a.displayName || '(no name)')
      + (a.hidden === 1 ? ' [HIDDEN ACHIEVEMENT]' : '')
      + '\n   Description: ' + (a.description || '(no description, likely a hidden achievement)'));
  });
}
