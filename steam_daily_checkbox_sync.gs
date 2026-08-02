/**
 * 每日自动同步:把Steam真实解锁的成就,自动勾选进对应Notion攻略页的checkbox。
 *
 * 设计思路(2026-08-02,取代之前靠Claude Code手动逐个游戏核对的方式):
 * - 判断"要不要同步这个游戏"不查Notion的Status(Staged/Paused/Done那些标签),
 *   而是直接用 RAW DATA 自己的 完成数<成就总数 (跳过已100%完成、以及没有成就系统的游戏)。
 *   原因:自动化脚本不像人工对话那样有token成本顾虑,就算对一个已经"Done"的游戏
 *   重新跑一次也是空操作(没有新解锁=没有变化),用成就数简单过滤足够了。
 * - 名字匹配用简单的"标准化后子串匹配"(和之前手动核对时的逻辑一致),
 *   自动勾选、不做二次确认;所有改动都写进 "Sync Log" 标签页方便事后审查。
 * - 用到的Notion API是**这个脚本自己直接调用**的(不经过Claude Code),
 *   所以需要一个独立的 Notion Internal Integration token,存在"脚本属性"里
 *   (不要写死在代码里,更不要提交到仓库):
 *     Apps Script编辑器 → 项目设置(齿轮图标) → 脚本属性 → 添加属性
 *     属性名:NOTION_TOKEN  值:你的Notion Internal Integration Secret
 *   并且要把相关的Notion页面(或者它们共同的父页面,比如"Entertainment")
 *   加到这个integration的连接里(Notion页面右上角 ••• → 连接 → 添加连接),
 *   不然API会返回404/无权限。
 *
 * 首次使用建议:
 * 1. 先跑 testSyncOneGameCheckboxSync('某个appid') 手动测试一款游戏,
 *    检查 Sync Log 里的结果是否合理,再决定要不要装自动触发器。
 * 2. 确认没问题后跑一次 installDailyCheckboxSyncTrigger() 装上每天的定时任务
 *    (默认早上8点,项目所在时区;改时间就改下面 atHour 的参数,重新跑一次这个函数即可)。
 */

/**
 * 每天自动运行的入口:扫描 RAW DATA 里"有攻略链接 && 成就没100% && 有成就系统"的游戏,
 * 逐个同步Steam解锁状态到Notion攻略页checkbox,结果汇总写进 "Sync Log" 标签页。
 */
function dailyCheckboxSync() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // A~E列: Status, AppID, 游戏名, 完成数, 成就总数
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
    Utilities.sleep(350); // 给Notion API留点余量,避免429限流
  });

  writeSyncLog_(allLogs);
}

/**
 * 手动测试单个游戏用,不用等每日触发器。appid传字符串或数字都行。
 * 在Apps Script编辑器里选中这个函数,改好参数直接点"运行"即可,
 * 结果既写进 Sync Log,也能在 查看→执行记录 里看到 Logger.log 输出。
 */
function testSyncOneGameCheckboxSync(appid) {
  appid = String(appid);
  const guide = listGuideRows().find(g => g.appid === appid);
  if (!guide) throw new Error('appid ' + appid + ' 在 GUIDES 表里没有攻略链接,没法同步');

  const logs = processGameCheckboxSync_(appid, guide.name, guide.url);
  writeSyncLog_(logs);
  Logger.log(JSON.stringify(logs, null, 2));
  return logs;
}

/**
 * 装上每天自动运行 dailyCheckboxSync 的定时触发器。
 * 会先清掉同名的旧触发器,避免重复触发,可以放心重复运行这个函数来改时间。
 */
function installDailyCheckboxSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyCheckboxSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCheckboxSync')
    .timeBased()
    .everyDays(1)
    .atHour(8) // 早上8点,项目所在时区(改这里的数字来调整时间)
    .create();
}

/** 卸载每日触发器(以后不想自动跑了就调这个)。 */
function uninstallDailyCheckboxSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyCheckboxSync') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------------------
// 单个游戏的同步逻辑
// ---------------------------------------------------------------------------

/**
 * 对一个游戏:拿Steam已解锁成就 + Notion攻略页的checkbox列表,做名字匹配并勾选。
 * 返回本次产生的日志行数组(每行是 [时间, AppID, 游戏名, 成就名, 结果说明])。
 */
function processGameCheckboxSync_(appid, gameName, url) {
  const logEntries = [];

  let unlocked;
  try {
    unlocked = getUnlockedAchievements(appid); // 复用 steam_guides_sync.gs
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', '跳过-无法获取Steam解锁数据: ' + err]);
    return logEntries;
  }
  if (!unlocked || unlocked.length === 0) return logEntries;

  let pageId;
  try {
    pageId = extractNotionPageId_(url);
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', '跳过-无法解析Notion链接: ' + err]);
    return logEntries;
  }

  let todos;
  try {
    todos = fetchAllToDoBlocks_(pageId);
  } catch (err) {
    logEntries.push([new Date(), appid, gameName, '', '跳过-无法读取Notion页面(检查integration是否已连接这个页面): ' + err]);
    return logEntries;
  }

  if (todos.length === 0) {
    logEntries.push([new Date(), appid, gameName, '', '跳过-页面没有找到checkbox(可能是纯数据库/纯攻略笔记页,需要人工处理)']);
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

      // 前缀匹配(哪怕带边界字符检查)还是不够严格:"忍义手"是"忍义手之炉火纯青"的
      // 前缀,"新人冒险者"是"新人冒险者之星"的前缀,"比邻星"是"比邻星主厨"的前缀——
      // 只要真正对应的checkbox已经被勾过(不在待匹配池里),算法就可能把这些完全不同、
      // 更难、真没解锁的"表亲成就"的checkbox误勾上。
      // 改成**精确匹配**:把checkbox文字按<br>换行/单行内的冒号或破折号分隔符拆成若干个
      // "标题候选段",只有成就名字和某个候选段完全相等才算数,不再接受"前缀+边界符合"这种
      // 弱匹配。（换行优先拆分,能同时兼容"日记：家徒四壁"这种名字本身自带冒号的情况——
      // 因为冒号在换行之前,拆出来的整行候选段里冒号还在,不会被切碎。）
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
        break; // 这个成就处理完了,不用继续找同名的其他checkbox
      }
    }
  });

  return logEntries;
}

/** 把日志行追加到 "Sync Log" 标签页,没有就先创建。 */
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
 * 从GUIDES表里存的Notion链接提取出页面ID(标准带横杠UUID格式,Notion API要这个格式)。
 * 兼容链接末尾ID带不带横杠、后面有没有?query的情况。
 */
function extractNotionPageId_(url) {
  const clean = String(url).split('?')[0];
  const match = clean.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i);
  if (!match) throw new Error('无法从URL提取Notion页面ID: ' + url);
  const id = match[1].replace(/-/g, '');
  return id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
}

/**
 * 递归拉取一个block底下所有的 to_do 类型子block(包括嵌套在toggle/column等容器里的)。
 * 返回 [{id, text, checked}, ...]
 *
 * 子页面(child_page)特殊处理:有些游戏(比如文明6)把成就清单放在攻略主页面底下的
 * 一个子页面里(常见标题"成就"),而不是直接摊平写在主页面上——这种情况下只有标题
 * 看起来像成就清单的子页面才继续往下挖,像"复盘"/"教程"这类跟成就无关的子页面
 * 不会被搜索,避免浪费API调用、也避免把无关内容误当成搜索范围。
 *
 * 子数据库(child_database,比如Crusader Kings III那种用内嵌数据库+"完成"勾选属性
 * 记录成就、而不是markdown checkbox的页面)以及链接到其他页面(link_to_page)这两种
 * 不在这个函数的处理范围内,遇到会直接跳过——这类页面需要完全不同的同步逻辑
 * (查数据库行、改属性而不是改block),见 PROJECT_CONTEXT.md 里的说明。
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
        if (/成就|achievement/i.test(block.child_page.title || '')) {
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
 * 转小写、去掉markdown加粗星号、把字面的<br>统一成换行、合并多余空格——
 * 但**保留**标点符号(冒号/破折号/换行等),因为 isPrefixMatchWithBoundary_
 * 要靠这些标点来判断"名字是不是在这里就结束了",不能像之前那样直接全部去掉。
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
 * 把一个checkbox的文字拆成若干个"标题候选段",用于和成就名字做**精确**匹配
 * (而不是前缀/包含匹配,避免"忍义手"这种短名字误配到"忍义手之炉火纯青"这种
 * 只是凑巧共享前几个字的、完全不同的长名字成就上)。
 *
 * 拆分优先级:
 * 1. 按换行拆(对应页面里"标题<br>描述"格式转换后的换行;DOS2这类"英文名\n中文名\n
 *    描述"的两行开头格式也靠这个自然处理成两个独立候选段)——同时天然兼容
 *    "日记：家徒四壁"这种名字本身就带冒号的情况,因为冒号在换行之前,整行候选段里
 *    冒号还在,不会被切碎。
 * 2. 如果整段文字是单行、靠冒号或破折号分隔标题和描述(没有用<br>换行的那些页面,
 *    比如"翻云寨：翻云寨的秘密。"),额外把"第一个冒号/破折号之前的部分"也算一个候选段。
 * 3. 整段原文本身也作为候选(万一完全没有描述,checkbox整行就是成就名)。
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
 * 统一的Notion API调用封装。token从脚本属性里读(不要写死在代码里)。
 * method: 'get' | 'patch' 等;path: 以 /blocks/... 开头,不含域名。
 */
function notionApiRequest_(method, path, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) {
    throw new Error('未设置 NOTION_TOKEN。请到 项目设置(齿轮图标) → 脚本属性 里添加,值是你的Notion Internal Integration Secret');
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
    throw new Error('Notion API错误 ' + code + ': ' + (body.message || res.getContentText()));
  }
  return body;
}
