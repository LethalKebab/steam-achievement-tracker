# Steam 成就自动化追踪项目 — 项目背景说明

给 Claude Code 快速上下文用。这个项目在 claude.ai 网页对话里从头搭建,现在要挪到 Claude Code 继续开发。

## 项目是什么

一套自动追踪 Steam 游戏成就完成度的系统,由三部分组成:

1. **Google Sheet**(数据源,唯一权威数据)—— 表名"RAW DATA",还有几个辅助标签页:
   - `ACHIEVEMENTS` —— 全库游戏的完整官方成就详情(中英文名字都存,中文优先展示)
   - `GUIDES` —— 每款游戏对应的攻略页面链接(存在Notion/Google Doc等外部工具,这里只存链接)
2. **Google Apps Script**(自动化后端,跟Sheet绑定在同一个项目里,多个.gs文件共享全局作用域)
3. **网页 Dashboard**(Apps Script Web App,HTML+JS前端,部署后有独立URL)

## 技术栈 & 关键约束

- 全部代码是 **Google Apps Script(.gs文件)+ 原生HTML/JS**,不是Node.js/npm项目,不能用现代import语法,函数间靠共享全局作用域调用
- Steam Web API Key 和 SteamID64 存在 `steam_achievement_sync.gs` 的 `CONFIG` 常量里(已经填好真实值,注意别泄露/别提交到公开仓库)
- appid为主键,数据源以 Steam API 为准(不是手动录入)

## 文件清单(都在这个文件夹里)

- `steam_achievement_sync.gs` —— 主脚本:核心同步逻辑(runBatch/syncNewGames/rebuildSheetFromApi等),定时任务设置
- `steam_achievements_detail.gs` —— 独立文件:批量拉取全库成就详情(中英文)到ACHIEVEMENTS表
- `steam_dashboard.gs` —— Dashboard后端(doGet + 各种google.script.run被调用的函数)
- `Dashboard.html` —— Dashboard前端(HtmlService模板,文件名必须叫`Dashboard`不带后缀)
- `steam_test_debug.gs` —— 调试工具集合(查原始API返回内容用)
- `steam_guides_sync.gs` —— Notion→GUIDES表 同步工具,给 Claude Code 用,见下方"攻略链接自动同步"一节
- `steam_daily_checkbox_sync.gs` —— 独立的每日定时任务(`dailyCheckboxSync`,靠`installDailyCheckboxSyncTrigger()`装),自动把Steam已解锁成就同步进Notion攻略页checkbox(直接调Notion API,不经过Claude Code)。**这个文件和`(dev)`文件夹是分开的两个git仓库、但共用同一个Apps Script scriptId**——2026-08-03这天曾经因为在`(dev)`跑`clasp push`而把这个文件从线上项目删掉(`(dev)`本地没有这个文件,`clasp push`不会保留远端独有的文件),当时及时发现并补救。以后从任一边`clasp push`前,先确认两边文件清单一致
- `two_point_museum_achievements.md` / `sultans_game_achievements.md` / `octopath_traveler_achievements.md` / `gugu_bahuang_achievements.md` —— 已经做好的游戏成就攻略(Markdown格式,checkbox清单,勾选状态来自getAllAchievementsForGame真实解锁数据)

## 攻略链接自动同步(Notion → GUIDES表)

现在本地是 clasp 管理的项目(`.clasp.json`),`clasp push`/`clasp pull` 直接对接 Apps Script,不用手动复制粘贴代码。Dashboard 有独立的正式部署(deploymentId 见 `.clasp.json` 同目录下的对话记录/git log,访问权限"仅我自己"),每次改动 push 后用 `clasp deploy -i <dashboard-deploymentId>` 更新同一个部署,链接不变。

另外有一个**独立的、单独部署**的 Web App,专门给 Claude Code 用 HTTP 调用来读写 GUIDES 表(不用 `clasp run`,因为那需要额外绑定标准 GCP 项目,比较麻烦):
- `steam_guides_sync.gs` 里的 `doPost(e)`,靠 `SYNC_SECRET` 这个随机 token 做鉴权(和 Steam API Key 一样敏感,不要提交到公开仓库/分享出去)
- 支持的 action(都是 `steam_guides_sync.gs` 里现成的函数,直接复用,不用重新写):
  - `listOwnedGames` —— RAW DATA里全部appid+名字,用于按名字匹配appid
  - `listGuideRows` —— GUIDES表当前所有行(appid/名字/链接/更新日期)
  - `upsertGuideLinks(entries)` —— 批量写入/更新攻略链接,按appid匹配已有行;entries: [{appid, name, url}]。**更新时要连游戏名列B一起覆盖,不能只更新链接和日期,不然名字改不过来**(踩过的坑,已修复)
  - `addManualGame(entry)` —— 给RAW DATA加一行Status=Manual的游戏(比如家庭共享、不在Steam owned列表里的);entry: {appid, name, achieved?, total?};appid已存在会报错,不会覆盖。**注意**:这个函数无条件打Manual标记,只适合"这账号永远查不到真实成就数据"的情况(比如真的是别的家庭成员在玩);如果账号自己其实能查到真实数据,应该用下面的`migrateFamilyGames`而不是这个
  - `getUnlockedAchievements(appid)` —— 返回某appid**已解锁**的成就列表,带中英文名字/描述(从ACHIEVEMENTS表查),已解锁状态来自GetPlayerAchievements真实数据。**给"把Steam真实进度同步进Notion攻略页checkbox"这个任务用**
  - `getAllAchievementsForGame(appid)` —— 返回某appid**全部**成就(不管是否解锁),每条都带真实的achieved布尔值。**给"从头重写/修正一份攻略成就清单"这个任务用**(比如瘟疫公司那次)——如果ACHIEVEMENTS表还没有这个appid的记录,会报错提示先跑`syncAchievementSchema`
  - `setGameStatus(appid, status)` —— 直接改某一行的Status(A列),纠正误设的标记用。status传`''`/`'Unvetted'`/`'Manual'`之一
  - `migrateFamilyGames(appids)` —— 批量把appid列表从Manual迁移成"家庭共享"分类:Status清空(恢复runBatch每日自动同步)、J列(FAMILY_COL)打勾。2026-08-03这天用它把13款"账号自己能查到真实成就数据、但不在GetOwnedGames里"的游戏从误用的Manual状态改了过来(详见下方"已经踩过的坑"第8条)
  - 以上这些新增action每次要跟doPost里的switch一起加,加完记得走一遍"临时开ANYONE_ANONYMOUS→push→deploy→改回MYSELF→再push"的流程(见下一条)
- 这个部署的访问权限是"任何人"(ANYONE_ANONYMOUS),因为要脱离浏览器登录用纯HTTP调用;`appsscript.json` 里 `webapp.access` 默认是 `MYSELF`(给Dashboard正式部署用的默认值)。**每次要更新这个同步端点的代码时**,必须:临时把 `access` 改成 `ANYONE_ANONYMOUS` → push → `clasp deploy -i <这个同步端点的deploymentId>` → 改回 `MYSELF` → 再 push 一次。不这样做的话要么权限不对,要么会不小心把Dashboard正式部署也改成公开。
- HTTP调用踩过的坑:Apps Script Web App 的 POST 请求会返回 302 重定向到 `script.googleusercontent.com/macros/echo?...`,**重定向后必须用 GET**(那个echo端点只是取回已经算好的结果,不是重新执行一次,POST 会 405)。`curl -L`/`--post302` 这类工具在这里反而会出问题,PowerShell 建议手动用 `HttpClientHandler(AllowAutoRedirect=false)` 拿到 Location 后自己发 GET,同时用 UTF8 明确编码收发,避免中文乱码。

## 已经踩过的坑(避免重复踩)

1. **Steam商店API的appdetails接口,`name`字段不受`l=`语言参数影响**(已知怪癖),要拿中文名必须额外抓商店网页HTML本身(`fetchAppNameFromStorePage`函数)
2. **商店网页抓取容易被限流**,正则要写宽松点(class属性可能带多个class),而且要带年龄验证的cookie绕过部分游戏的年龄确认页
3. **GetPlayerAchievements接口返回HTTP 400通常代表"这游戏对这账号没有stats数据"**(不是错误,是Steam的标准信号),不要重试;只有429才是真限流需要重试
4. **Google Sheets单元格粘贴多行文本会被拆到多行**——这也是为什么GUIDES表只存链接、不存长文本内容
5. **Apps Script的DocumentApp API不支持创建原生可勾选checklist**,所以攻略內容放在外部工具(推荐Notion,粘贴markdown自动转checkbox)而不是用脚本生成Google Doc
6. 全量重建表格(`rebuildSheetFromApi`)之前要注意保护:手动标记的`Manual`状态、家庭共享等不在owned列表里的行——已经处理好了,改动前先看代码里这部分逻辑。**但注意**:真正决定一行是否在重建后保留的,是"appid是否在当前GetOwnedGames结果里",跟Status是不是Manual无关——非owned的行不管Status是什么都会保留;`manualStatusAppIds`那部分逻辑只是给"owned但被人工锁定"的行重建后继续盖过API判定的Unvetted用。`hardResetFromApi`则完全不保留任何东西,不管Status,慎用
7. **写/改攻略页(Notion或本地.md)的具体规则(checkbox格式、配图取舍)见独立skill文件`.claude/skills/achievement-guide-writing/SKILL.md`**,不在这里展开,避免这份文档越堆越大
8. **`Manual`状态被同时当成两件不同的事在用,这是2026-08-03这天理清楚的一个坑**:(a)"跳过每日成就自动同步"(`runBatch`只看这个),(b)"重建表格时锁定Status、不让API的Unvetted判定覆盖"(`rebuildSheetFromApi`里`manualStatusAppIds`那部分逻辑,只对owned的行有意义)。这两件事目前绑在同一个Status字段上,导致"账号自己能查到真实成就数据、但游戏不在GetOwnedGames里"的家庭共享游戏,当初被无脑套用(a)+(b)一起锁死,成就数只能手动改。**排查方法**:直接查`GetPlayerAchievements`(带真实key/steamid)看返回的achieved数字是不是账号自己的真实进度(比如全是0很可能是别的家庭成员在玩,数字对得上说明账号自己就能查到);同时要注意`GetPlayerAchievements`能查到数据不代表这appid在`GetOwnedGames`里(小的免费游戏可能已经被下架、但成就记录永久保留)。**处理方式**:如果账号自己能查到真实数据 → Status清空(交给`runBatch`)+ J列(FAMILY_COL)打勾留个信息标记;如果查到的是别人的进度(比如全是0)→ 继续保持Manual。当天用这个方法把18个Manual行分了类:13个改成了正常同步+家庭标记,4个(Cats and Seek: Osaka、100 Istanbul Cats、昨日难留、The Forest)各有各的原因继续留Manual——分别是"family-sharing访问权限似乎会波动、之前被API判过Unvetted"、"账号自己owned但Steam的Unvetted判定对这个游戏本身就不稳定(和家庭共享无关)"、"这两个appid的Game Details隐私设置是私密的,API直接403"(还有1个双点博物馆是测试用的占位行,用户没在玩,不用管)
9. **`GetOwnedGames`默认会漏掉一些游戏**:免费游戏默认不算在内(要加`include_played_free_games=true`才会返回,`fetchOwnedGames`已经这样做了),"Unvetted"游戏默认也不算在内(要加`skip_unvetted_apps=false`才会返回)。想准确判断"这个游戏到底是不是owned/是不是被Steam判成Unvetted",必须严格按`fetchOwnedGamesWithUnvettedFlag()`那样发两次请求做差集,不能只发一次请求就下结论
10. **第8条那个"18个游戏误锁Manual"的坑,根源大概率是`steam_detect_manual_edits.gs`里的`detectAndLockManualEdits()`**——这个一次性工具会把任何不在`GetOwnedGames`里的appid无脑锁成Manual,完全不检查`GetPlayerAchievements`是不是其实还能查到真实数据。2026-08-03已经删掉这个文件(prod那边本来就没有,一次性工具用完即弃,也没有被任何其他函数引用或定时任务调用)。以后如果要重写类似"自动锁定非owned行"的工具,必须先查真实成就数据,不能只看ownership——这正是加J列(FAMILY_COL)的原因

## 表格结构(RAW DATA,当前列顺序)

A=Status(Unvetted/Manual标记) / B=AppID / C=游戏名 / D=完成数 / E=成就总数 / F=完成率 / G=喜爱(♥) / H=重点关注(★) / I=成就更新日期 / J=家庭共享(非自购,纯信息标记,不影响任何自动化)

## 目前进度 & 下一步可能的方向

- 核心同步管线(RAW DATA自动更新、Dashboard展示、喜爱/重点关注标记)已经跑起来了
- ACHIEVEMENTS表(全库成就详情)刚做好,中英文都存
- 攻略功能(GUIDES表 + Dashboard攻略按钮)架构已完成,GUIDES表已经从Notion "Overview" 数据库同步了95款游戏的攻略链接(appid为主键)
- 已知待处理:Notion里"苏丹的游戏"有一个重复页面(旧的那个,url含`1d31fee6...`)需要手动删除
- 每个攻略页面开头正在补充一行 `appid: NNNNNN`(纯文本,方便以appid而不是模糊的名字匹配来定位页面,避免"看错游戏"的问题),95个里已经做了61个(苏丹的游戏、瘟疫公司这两个本来就有,另外61个是新加的),还有约34个没做——如果要继续补,思路是:读GUIDES表拿appid+url,对每个url跑`notion-update-page`,command=`insert_content`,position=`{"type":"start"}`,content=`"appid: " + appid`。这一步单纯是体力活,一次性内容较大,建议单独一个session做,不要和别的任务混在一起,免得context堆积让每次调用变贵。

## 待办任务:把已解锁的成就同步进Notion攻略页checkbox

**背景**:之前给"苏丹的游戏"(appid 3117820)和"瘟疫公司"(appid 246620)已经做过这件事——通过Steam真实解锁状态,把对应Notion攻略页里已达成的成就checkbox勾上。现在要推广到其他还在玩/没玩完的游戏,但**不包括**"Done"和"Differed"状态的游戏(已经打完/放弃的没必要再勾)。

**范围判定**:游戏的完成状态存在Notion "Overview" 数据库(collection://ecd69a37-e9f4-4ecf-8187-1a2406078f2d)的`Status`属性里,取值有 Not started / Staged / Paused / In progress / Differed / Done。这次只处理 **Status ≠ Done 且 ≠ Differed** 的游戏(即 Not started / Staged / Paused / In progress 这几种)。

**执行步骤**(新session里做,避免这个session积累的context拖慢/拖贵每次调用):
1. 调用GUIDES同步端点的 `listGuideRows` action,拿到全部95个appid+name+url
2. 查Notion "Overview" 数据库(用 `notion-query-data-sources`,SQL查 `Name`、`url`、`Status`),按url把Status匹配到第1步的每一行,过滤掉 Status=Done 或 Differed 的
3. 苏丹的游戏(3117820)和瘟疫公司(246620)已经做过,可以跳过
4. 对剩下的每个appid,调用 `getUnlockedAchievements`(steam_guides_sync.gs里已有,返回该appid已解锁成就的中英文名+描述)
5. 打开对应Notion攻略页(优先用appid line定位/确认,只有61个页面已经有这行,另外约34个还得靠GUIDES表里存的url),把已解锁成就在页面里对应的checkbox从 `- [ ]` 改成 `- [x]`(用 `notion-update-page` 的 `update_content`,old_str/new_str精确匹配成就名字那一行的开头,比如 `- [ ] **成就中文名**`)
6. 每处理完一个游戏,顺手看看这个页面是不是也还没有appid line,没有的话可以一起补上

**注意**:这是个批量、逐游戏重复的任务,每个游戏大概要2-4次工具调用(查解锁状态、开页面、改checkbox、可能还要补appid行)。游戏数量取决于第2步筛选结果,建议先跑完筛选、把清单列出来给用户看一眼再逐个处理,别一次性全跑。

## 可能的下一步

- 批量给更多游戏做攻略、把Dashboard做得更丰富、或者优化现有同步逻辑的健壮性

## 给下一个Claude Code session的经验(session管理/token成本)

这几点是这次做下来才发现的,写下来是为了不用再交一次学费:

1. **批量、重复性的操作(比如给93个Notion页面逐个加一行文字)会不成比例地贵**——不是因为单个操作难,而是因为:(a) Notion的MCP连接器目前没有"批量更新"接口,只能一个page一个page调用;(b) 这类任务通常出现在一个已经跑了很久、堆了很多历史内容的session里,而每次新的工具调用都要带着整个对话历史一起算token。**遇到这种"体力活但要跑几十次"的任务,应该在动手前就提醒用户"这个大概要跑N次调用,要不要单独开个新session做",而不是埋头做到一半才发现贵。**
2. **判断一个任务是否"应该另开session"的经验法则**:如果预估要读/写的内容总量明显超过当前会话已有内容的量级(比如这次瘟疫公司250个成就的攻略页重写,以及给95个页面逐个加appid行),或者是纯重复性、可以脱离当前上下文独立执行的任务,就值得建议开新session。相反,像"改一两个具体成就的checkbox"这种小任务,当场做就行,不用小题大做。
3. **新session要怎么接得上**:靠这份`PROJECT_CONTEXT.md`——遇到本文档里"待办任务"章节列出的活,直接照着步骤走,不用重新问用户一遍背景;文档里的"可复用的工具函数"部分(见上面"攻略链接自动同步"一节)列出了`steam_guides_sync.gs`里已经写好的函数,新session不用重新读整个.gs文件,也不用重新发明一遍逻辑。
4. **验证优先于假设**:这次至少有两次因为"想当然"踩坑——(a) 一开始看到瘟疫公司攻略页有203个checkbox就假设"肯定是重复内容太乱",没去先查Steam官方到底有多少个成就,被用户纠正后才发现游戏本身就有250个;(b) 往Notion页面插入`<details>`标签时,第一次把`<`/`>`转成了`&lt;`/`&gt;`,导致页面里出现的是字面文字而不是真正的可折叠区块,靠重新fetch页面内容对比才发现。**这类"看起来对但没实际验证"的操作,做完之后应该重新读一遍结果确认,而不是assume工具调用成功=内容正确。**

## 重要提醒

这个文档是从claude.ai网页对话里手动整理出来的背景说明,不是自动同步的——如果之后又在网页对话里做了新改动,记得手动更新这份文档,或者直接把最新的.gs/.html文件覆盖过来。
