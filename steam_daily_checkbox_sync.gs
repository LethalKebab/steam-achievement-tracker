/**
 * 每日自动同步:根据Steam上实际解锁了哪些成就,自动去Notion攻略页面里勾选对应的checkbox。
 *
 * 设计说明(替代了之前通过 Claude Code 手动逐款游戏交叉核对的旧方案):
 * - 判断"某款游戏是否需要同步"不看Notion的Status属性(Staged/Paused/Done等),
 *   直接用RAW DATA里自己的完成数 < 成就总数来判断(跳过已经100%完成的游戏,
 *   以及没有成就系统的游戏)。
 *   原因:自动化脚本不存在chat-driven那种token成本的顾虑,重新跑一次已经标记"Done"的
 *   游戏也只是no-op(没有新解锁=没有变化),所以拿简单的成就数过滤就够用了。
 * - 名字匹配要求**精确**匹配标题候选片段(见下面的extractTitleCandidates_)——
 *   不做substring/prefix匹配。匹配到的直接自动勾选,没有二次确认;所有变更写进
 *   "Sync Log"标签页,供事后复查。
 * - 这里的Notion API调用是**这个脚本直接发出的**(不经过Claude Code),
 *   所以需要一个独立的Notion Internal Integration token,存在Script Properties里
 *   (不写进代码里,不提交到仓库):
 *     Apps Script 编辑器 -> 项目设置(齿轮图标) -> Script Properties -> 添加属性
 *     名称: NOTION_TOKEN   值: 你的 Notion Internal Integration secret
 *   并且相关的Notion页面(或者它们共同的父页面,比如 "Entertainment")需要添加到
 *   这个integration的connections里(Notion页面右上角••• -> Connections -> Add connection),
 *   否则API会返回404/没有权限。
 *
 * 首次使用:
 * 1. 先跑一次 testSyncOneGameCheckboxSync('<某个appid>') 手动测一款游戏,
 *    检查Sync Log结果没问题再决定要不要装自动定时任务。
 * 2. 确认没问题后,跑一次 installDailyCheckboxSyncTrigger() 装上每天定时任务
 *    (默认早上8点按项目时区;改下面atHour参数再重新跑一次这个函数就可以调时间)。
 */

/**
 * 每天自动运行的入口:扫描RAW DATA里有攻略链接、没到100%、有成就系统的游戏,
 * 把Steam解锁状态同步到Notion攻略页面的checkbox上,然后写一行摘要到"Sync Log"标签页。
 */
function dailyCheckboxSync() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // A-E列: Status, AppID, 游戏名, 完成数, 成就总数
  const rawData = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const guideByAppid = {};
  listGuideRows().forEach(g => { guideByAppid[g.appid] = g; });

  const candidates = rawData
    .filter(r => {
      const appid = String(r[1]);
      const achieved = r[3];
      const total = r[4];
      return appid && typeof total === 'number' && total > 0 && achieved < total && guideByAppid[appid];
    })
    .map(r => ({ appid: String(r[1]), name: r[2] }));

  const allLogs = [];
  candidates.forEach(c => {
    const guide = guideByAppid[c.appid];
    const logs = processGameCheckboxSync_(c.appid, c.name, guide.url);
    allLogs.push.apply(allLogs, logs);
    Utilities.sleep(350); // 给Notion API留点余量,避免触发429限流
  });

  writeSyncLog_(allLogs);
}

/**
 * 不等定时任务,手动测一款游戏。appid可以是字符串或数字。
 * 在Apps Script编辑器里选这个函数、填好参数、点"Run"——
 * 结果会写入Sync Log,同时也可以通过查看 -> 执行记录看Logger.log的输出。
 */
function testSyncOneGameCheckboxSync(appid) {
  appid = String(appid);
  const guide = listGuideRows().find(g => g.appid === appid);
  if (!guide) throw new Error('appid ' + appid + ' 在GUIDES表里没有攻略链接,无法同步');

  const logs = processGameCheckboxSync_(appid, guide.name, guide.url);
  writeSyncLog_(logs);
  Logger.log(JSON.stringify(logs, null, 2));
  return logs;
}

/**
 * 安装每天自动跑 dailyCheckboxSync 的定时任务。
 * 跑之前会先清掉已有的同名trigger避免重复,所以想改时间直接改atHour参数重新跑就行。
 */
function installDailyCheckboxSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyCheckboxSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCheckboxSync')
    .timeBased()
    .everyDays(1)
    .atHour(8) // 早上8点,项目时区(改这个数字来调时间)
    .create();
}

/** 卸载定时任务(不想再自动跑了就调这个)。 */
function uninstallDailyCheckboxSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyCheckboxSync') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------------------
// 单游戏同步逻辑
// ---------------------------------------------------------------------------

/**
 * 对一款游戏:拉Steam已解锁成就 + 拉Notion攻略页面的checkbox列表,
 * 按名字匹配,对匹配到的自动勾选。
 * 返回本次运行产生的日志行(每行 [时间戳, AppID, 游戏名, 成就名, 结果描述])。
 */
function processGameCheckboxSync_(appid, gameName, url) {
  const logEntries = [];

  let unlocked;
  try {
    unlocked = getUnlockedAchievements(appid); // 复用 steam_guides_sync.gs
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', '跳过 - 无法获取Steam解锁数据: ' + err]);
    return logEntries;
  }
  if (!unlocked || unlocked.length === 0) return logEntries;

  let pageId;
  try {
    pageId = extractNotionPageId_(url);
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', '跳过 - 无法解析Notion链接: ' + err]);
    return logEntries;
  }

  let todos;
  try {
    todos = fetchAllToDoBlocks_(pageId);
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', '跳过 - 无法读取Notion页面(检查integration是否已连接到该页面): ' + err]);
    return logEntries;
  }

  if (todos.length === 0) {
    logEntries.push([new Date(), appid, gameName, '', '跳过 - 页面上没有找到checkbox(可能是纯数据库/纯笔记页面,需要手动处理)']);
    return logEntries;
  }

  const uncheckedTodos = todos.filter(t => !t.checked);
  const claimedBlockIds = {};

  unlocked.forEach(ach => {
    const nameCnNorm = normalizeText_(ach.nameCn);
    const nameEnNorm = normalizeText_(ach.nameEn);
    if (!nameCnNorm && !nameEnNorm) return;

    for (let i = 0; i < uncheckedTodos.length; i++) {
      const todo = uncheckedTodos[i];
      if (claimedBlockIds[todo.id]) continue;
      const todoNorm = normalizeText_(todo.text);
      if (!todoNorm) continue;

      // 前缀匹配(哪怕加边界字符检查)仍然不够严格:一个短的成就名可以是另一个不相关的、
      // 更难的成就名的严格前缀——两者恰好前几个字相同。如果短成就名的真实checkbox已经被
      // 勾选了(不再在待匹配池里),算法就可能错误地勾选到那个"表亲成就"的checkbox——
      // 而那个成就实际上还没解锁。
      // 修正方案:改为**精确匹配**——把checkbox文本按"标题候选片段"拆分(先按<br>转换
      // 出来的换行拆,再在单行内按冒号/破折号拆),成就名必须严格等于其中一个候选片段才算
      // 匹配,不再接受"前缀+边界看起来对"的弱匹配。(先按换行拆也自然处理了成就名本身含
      // 冒号的情况,因为冒号在换行之前,会完整地保留在这一行的候选片段里。)
      const candidates = extractTitleCandidates_(todoNorm);
      const isMatch =
        (nameCnNorm && candidates.indexOf(nameCnNorm) !== -1) ||
        (nameEnNorm && candidates.indexOf(nameEnNorm) !== -1);

      if (isMatch) {
        claimedBlockIds[todo.id] = true;
        try {
          notionApiRequest_('patch', '/blocks/' + todo.id, { to_do: { checked: true } });
          logEntries.push([new Date(), appid, gameName, ach.nameCn || ach.nameEn, '已勾选: ' + todo.text.slice(0, 60)]);
        } catch (err) {
          logEntries.push([new Date(), appid, gameName, ach.nameCn || ach.nameEn, '勾选失败: ' + err]);
        }
        break; // 这个成就已处理完毕,不需要继续找其他同名的checkbox
      }
    }
  });

  return logEntries;
}

/** 把日志行追加到"Sync Log"标签页,没有就自动创建。 */
function writeSyncLog_(entries) {
  if (!entries || entries.length === 0) return;
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName('Sync Log');
  if (!sheet) {
    sheet = ss.insertSheet('Sync Log');
    sheet.getRange(1, 1, 1, 5).setValues([['时间', 'AppID', '游戏名', '成就', '结果']]);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, entries.length, 5).setValues(entries);
}

// ---------------------------------------------------------------------------
// Notion API 辅助函数
// ---------------------------------------------------------------------------

/**
 * 从 GUIDES 表里存的 Notion 链接中提取页面ID(标准带横线的UUID格式,Notion API要的就是这个)。
 * 能处理结尾ID有没有横线、以及有没有 ?query 参数的情况。
 */
function extractNotionPageId_(url) {
  const clean = String(url).split('?')[0];
  const match = clean.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i);
  if (!match) throw new Error('无法从URL中提取Notion页面ID: ' + url);
  const id = match[1].replace(/-/g, '');
  return id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
}

/**
 * 递归拉取一个block下所有 to_do 类型的子block(包括嵌套在toggle/column等容器里的)。
 * 返回 [{id, text, checked}, ...]
 *
 * 对子页面的特殊处理:部分游戏(比如《文明VI》)把成就checklist放在攻略主页下面的
 * 子页面里(通常叫"成就")而不是直接展平在主页上——这种情况只会递归进入标题长得像
 * 成就列表的子页面;不相关的子页面(比如"回顾"/"教程")不会搜,避免浪费API调用和
 * 匹配到无关内容。
 *
 * 子数据库(child_database——比如《十字军之王III》最初的形式,用嵌入的数据库+一个
 * "Done" checkbox属性来追踪成就,而不是markdown checkbox)以及指向其他页面的链接
 * (link_to_page)不在这个函数的处理范围内,遇到直接跳过——那种页面需要完全不同的
 * 同步逻辑(查数据库行、更新属性,而不是编辑block),参见PROJECT_CONTEXT.md。
 */
function fetchAllToDoBlocks_(blockId, results) {
  results = results || [];
  let cursor = null;
  do {
    const path = '/blocks/' + blockId + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
    const data = notionApiRequest_('get', path);
    (data.results || []).forEach(block => {
      if (block.type === 'to_do') {
        results.push({
          id: block.id,
          text: richTextToPlain_(block.to_do.rich_text),
          checked: !!block.to_do.checked
        });
        return;
      }

      if (block.type === 'child_page') {
        if (/成就|achievement/i.test(block.child_page.title || '')) { // 匹配"成就"(achievement的中文)和"achievement"——攻略页面是中英双语的
          fetchAllToDoBlocks_(block.id, results);
        }
        return;
      }

      const skipTypes = ['child_database', 'link_to_page'];
      if (block.has_children && skipTypes.indexOf(block.type) === -1) {
        fetchAllToDoBlocks_(block.id, results);
      }
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function richTextToPlain_(richText) {
  return (richText || []).map(function (t) { return t.plain_text; }).join('');
}

/**
 * 转小写、去掉markdown加粗星号、把字面量 <br> 规范为真实换行、压缩多余空白——
 * 但**保留**标点符号(冒号、破折号、换行等),因为 extractTitleCandidates_ 要靠这些
 * 标点来找分段边界,不能直接删掉。
 */
function normalizeText_(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 把checkbox的文本拆成"标题候选片段",用来对成就名做**精确**匹配(而不是前缀/substring匹配,
 * 后者会让短成就名错误地匹配到另一个恰好前几个字相同但实际不同的更长成就名)。
 *
 * 拆分优先级:
 * 1. 先按换行拆(对应"标题<br>描述"页面格式被转成真实换行;也自然支持"英文名/本地化名/
 *    描述"各占一行的双行布局,拆出两个独立候选片段)。成就名本身含冒号的情况也自然被处理
 *    了,因为冒号在换行之前,会完整保留在这一行的候选片段里。
 * 2. 如果整段文字是单行、用冒号或破折号分隔标题和描述(没用<br>的页面,比如
 *    "位置:这个位置的秘密"),在第一步拆出的基础之上,冒号/破折号前面的部分也作为候选。
 * 3. 整段原文也是一个候选(以防根本没有描述、整个checkbox行就是纯粹的成就名的情况)。
 */
function extractTitleCandidates_(text) {
  const candidates = [];
  text.split('\n').forEach(function (line) {
    const t = line.trim();
    if (t) candidates.push(t);
  });
  const colonIdx = text.search(/[:：]/);
  if (colonIdx > 0) candidates.push(text.substring(0, colonIdx).trim());
  const dashIdx = text.indexOf(' - ');
  if (dashIdx > 0) candidates.push(text.substring(0, dashIdx).trim());
  const whole = text.trim();
  if (whole) candidates.push(whole);
  return candidates;
}

/**
 * 统一的 Notion API 调用封装。token从Script Properties读取(不写在代码里)。
 * method: 'get' | 'patch' 等; path: 以 /blocks/... 开头,不加域名。
 */
function notionApiRequest_(method, path, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) {
    throw new Error('NOTION_TOKEN 未设置。请在项目设置(齿轮图标) -> Script Properties 里添加,值为你的 Notion Internal Integration secret');
  }
  const options = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, options);
  const code = res.getResponseCode();

  if (code === 429) {
    Utilities.sleep(1000);
    return notionApiRequest_(method, path, payload); // 简单重试一次
  }

  const body = JSON.parse(res.getContentText());
  if (code >= 400) {
    throw new Error('Notion API 错误 ' + code + ': ' + (body.message || res.getContentText()));
  }
  return body;
}
