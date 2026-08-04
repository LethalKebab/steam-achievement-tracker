# Steam 成就自动化追踪项目 — 项目背景说明

给 Claude Code 快速上下文用。这个项目在 claude.ai 网页对话里从头搭建,现在挪到 Claude Code 继续开发。

## 项目是什么

一套自动追踪 Steam 游戏成就完成度的系统,由三部分组成:

1. **Google Sheet**(数据源,唯一权威数据)—— 表名"RAW DATA",还有几个辅助标签页:
   - `ACHIEVEMENTS` —— 全库游戏的完整官方成就详情(中英文名字都存,中文优先展示)
   - `GUIDES` —— 每款游戏对应的攻略页面链接(存在Notion/Google Doc等外部工具,这里只存链接)
2. **Google Apps Script**(自动化后端,跟Sheet绑定在同一个项目里,多个.gs文件共享全局作用域)
3. **网页 Dashboard**(Apps Script Web App,HTML+JS前端,部署后有独立URL)

## 技术栈 & 关键约束

- 全部代码是 **Google Apps Script(.gs文件)+ 原生HTML/JS**,不是Node.js/npm项目,不能用现代import语法,函数间靠共享全局作用域调用
- Steam Web API Key、SteamID64、`SYNC_SECRET` 等敏感信息都存在 Apps Script 的 Script Properties 里,不硬编码在源码里——这是仓库能公开发布的前提,新克隆这个项目需要自己在 Script Properties 里填一遍(见 README.md)
- appid为主键,数据源以 Steam API 为准(不是手动录入)

## 文件清单(都在这个文件夹里)

- `steam_achievement_sync.gs` —— 主脚本:核心同步逻辑(runBatch/syncNewGames/rebuildSheetFromApi等),定时任务设置
- `steam_achievements_detail.gs` —— 独立文件:批量拉取全库成就详情(中英文)到ACHIEVEMENTS表
- `steam_dashboard.gs` —— Dashboard后端(doGet + 各种google.script.run被调用的函数)
- `Dashboard.html` —— Dashboard前端(HtmlService模板,文件名必须叫`Dashboard`不带后缀)
- `steam_test_debug.gs` —— 调试工具集合(查原始API返回内容用)
- `steam_guides_sync.gs` —— 独立部署的 HTTP endpoint,给 Claude Code 和每日自动化用:读写 RAW DATA/GUIDES/ACHIEVEMENTS,外加自动发现 Notion 新攻略页并写入 GUIDES 表。函数清单、部署方式见 `.claude/skills/steam-guide-sync/SKILL.md`,不在这里重复
- `steam_daily_checkbox_sync.gs` —— 独立的每日定时任务(`dailyCheckboxSync`,靠`installDailyCheckboxSyncTrigger()`装),自动把Steam已解锁成就同步进Notion攻略页checkbox。判断"要不要同步"看的是RAW DATA自己的完成数<成就总数,不看Notion的Status属性——所以不需要另外维护一份"哪些游戏还没同步"的清单
- `guides/` 目录 —— 已经做好的游戏成就攻略(Markdown格式),写法规则见 `.claude/skills/achievement-guide-writing/SKILL.md`

## 已经踩过的坑(避免重复踩)

1. **Steam商店API的appdetails接口,`name`字段不受`l=`语言参数影响**(已知怪癖),要拿中文名必须额外抓商店网页HTML本身(`fetchAppNameFromStorePage`函数)
2. **商店网页抓取容易被限流**,正则要写宽松点(class属性可能带多个class),而且要带年龄验证的cookie绕过部分游戏的年龄确认页
3. **GetPlayerAchievements接口返回HTTP 400通常代表"这游戏对这账号没有stats数据"**(不是错误,是Steam的标准信号),不要重试;只有429才是真限流需要重试
4. **Google Sheets单元格粘贴多行文本会被拆到多行**——这也是为什么GUIDES表只存链接、不存长文本内容
5. **写/改攻略页(Notion或本地.md)的具体规则(checkbox格式、配图取舍、Notion API写入方式)见独立skill文件`.claude/skills/achievement-guide-writing/SKILL.md`**,不在这里展开
6. **`Manual` 状态同时被当成两件不同的事在用**:(a)"跳过每日成就自动同步"(`runBatch`只看这个),(b)"重建表格时锁定Status、不让API的Unvetted判定覆盖"(只对owned的行有意义)。这两件事绑在同一个Status字段上,曾经导致"账号自己能查到真实成就数据、但游戏不在GetOwnedGames里"的家庭共享游戏被无脑锁死成Manual,成就数只能手动改。**排查方法**:直接查`GetPlayerAchievements`(带真实key/steamid)看返回的achieved数字是不是账号自己的真实进度(全是0通常是别的家庭成员在玩;数字对得上说明账号自己能查到,且`GetPlayerAchievements`能查到数据不代表这appid在`GetOwnedGames`里)。**处理方式**:账号自己能查到真实数据 → Status清空(交给`runBatch`)+ J列(FAMILY_COL)打勾留信息标记;查到的是别人的进度 → 继续Manual。代码层面的完整细节见 `CLAUDE.md`"Known pitfalls"。
7. **`GetOwnedGames`默认会漏掉一些游戏**:免费游戏默认不算在内(要加`include_played_free_games=true`才会返回,`fetchOwnedGames`已经这样做了),"Unvetted"游戏默认也不算在内(要加`skip_unvetted_apps=false`才会返回)。想准确判断"这个游戏到底是不是owned/是不是被Steam判成Unvetted",必须严格按`fetchOwnedGamesWithUnvettedFlag()`那样发两次请求做差集,不能只发一次请求就下结论
8. **判断"两条数据是否指向同一个外部资源"不能用对方系统返回的 URL/文本原文做 key,要用稳定 ID**:Notion 的页面 URL 有时会带标题 slug 前缀,同一个页面两次查询返回的 URL 文本可能不一样。`syncGuidesFromNotion` 最初按 URL 原文比对"是否已在 GUIDES 表里",导致大量已存在的页面被误判成新页面、覆盖写入了本来整理好的 name/url。已修复:改用从 URL/page id 提取的标准 UUID 做比较(`steam_guides_sync.gs` 的 `normalizeNotionId_`)。
9. **文档写的和代码实际做的可能不一致,光看文档不算验证**:`SYNC_SECRET` 曾经以明文硬编码在 `steam_guides_sync.gs` 里,从项目"公开发布"那次提交起就一直在公开仓库里,尽管三份文档都写着它应该跟 STEAM_API_KEY 一样存 Script Properties——没人实际去源码里确认过。已改成从 Script Properties 读取,旧的硬编码值已作废。

## 表格结构(RAW DATA,当前列顺序)

A=Status(Unvetted/Manual标记) / B=AppID / C=游戏名 / D=完成数 / E=成就总数 / F=完成率 / G=喜爱(♥) / H=重点关注(★) / I=成就更新日期 / J=家庭共享(非自购,纯信息标记,不影响任何自动化)

## 目前架构现状

- 核心同步管线(RAW DATA自动更新、Dashboard展示、喜爱/重点关注标记)、ACHIEVEMENTS表(全库成就详情,中英文都存)都已经跑起来了
- 攻略功能已经是全自动闭环:Notion 里带 `appid: NNNNNN` 开头行的攻略页,每天7点被 `syncGuidesFromNotion` 自动发现并写入 GUIDES 表,GUIDES 表又被 Dashboard 和每天8点的 `dailyCheckboxSync`(Steam解锁状态→Notion checkbox)自动读取——写好一篇攻略、补上 appid 行,不用再手动维护任何链接表或同步清单
- 已知还没写攻略的游戏(Notion "Overview" 数据库里存在、但还没有攻略内容/appid行):Xenoblade Chronicles X、三相奇谈、以闪亮之名、最强祖师、月圆之夜、燕云十六声
- 已知待处理:Notion里"苏丹的游戏"有一个重复页面(旧的那个,url含`1d31fee6...`)需要手动删除

## 可能的下一步

- 给上面列的几个游戏写攻略、把Dashboard做得更丰富、或者优化现有同步逻辑的健壮性

## 给下一个Claude Code session的经验(session管理/token成本)

1. **批量、重复性的操作(比如给几十个Notion页面逐个加一行文字)会不成比例地贵**——Notion的MCP连接器没有"批量更新"接口,只能一个page一个page调用,而这类任务通常出现在已经跑了很久、堆了很多历史内容的session里,每次工具调用都要带着整个对话历史算token。**遇到这种"体力活但要跑几十次"的任务,动手前就提醒用户"这个大概要跑N次调用,要不要单独开个新session做"。**
2. **判断一个任务是否"应该另开session"的经验法则**:预估要读/写的内容总量明显超过当前会话已有内容量级,或者是纯重复性、可以脱离当前上下文独立执行的任务,就值得建议开新session。像"改一两个具体成就的checkbox"这种小任务,当场做就行。
3. **新session要怎么接得上**:靠这份`PROJECT_CONTEXT.md`了解背景,靠各个`.claude/skills/`文件了解具体操作规则和可复用函数——不用重新读整个.gs文件,也不用重新发明一遍逻辑。
4. **验证优先于假设**:工具调用成功不代表内容正确。具体踩过的坑见上面"已经踩过的坑"第8、9条,以及各 skill 文件里的验证章节。改完之后重新读一遍结果确认,尤其是批量写入/覆盖类操作。

## 重要提醒

这个文档是手动整理维护的,不是自动同步的——做了会影响其他 session 理解项目背景的改动,记得回来更新这份文档;单个 session 内的操作细节不需要记录在这里,只留下会持续有用的架构现状和教训。
