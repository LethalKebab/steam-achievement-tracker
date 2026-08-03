# Steam 成就自动化追踪项目 — 项目背景说明

给 Claude Code 快速上下文用。这个项目在 claude.ai 网页对话里从头搭建,现在在 Claude Code 里用 clasp 管理。

**操作性细节(怎么部署/怎么排查/怎么写攻略)已经拆到 `.claude/skills/` 下面按任务分开了,不再堆在这份文档里——按需加载,别把这份文档当成唯一上下文来源。**

## 项目是什么

一套自动追踪 Steam 游戏成就完成度的系统,由三部分组成:

1. **Google Sheet**(数据源,唯一权威数据)—— 表名"RAW DATA",还有几个辅助标签页:
   - `ACHIEVEMENTS` —— 全库游戏的完整官方成就详情(中英文名字都存,中文优先展示)
   - `GUIDES` —— 每款游戏对应的攻略页面链接(存在Notion/Google Doc等外部工具,这里只存链接)
2. **Google Apps Script**(自动化后端,跟Sheet绑定在同一个项目里,多个.gs文件共享全局作用域)
3. **网页 Dashboard**(Apps Script Web App,HTML+JS前端,部署后有独立URL)

appid为主键,数据源以 Steam API 为准(不是手动录入)。

## 文件清单

- `steam_achievement_sync.gs` —— 主脚本:核心同步逻辑(runBatch/syncNewGames/rebuildSheetFromApi等),定时任务设置,`CONFIG`常量(Steam API Key/SteamID64从脚本属性读取,不写死在代码里)
- `steam_achievements_detail.gs` —— 批量拉取全库成就详情(中英文)到ACHIEVEMENTS表
- `steam_dashboard.gs` + `Dashboard.html` —— Dashboard后端/前端(HtmlService,文件名必须叫`Dashboard`不带后缀)
- `steam_guides_sync.gs` —— Notion→GUIDES表 同步工具 + 给Claude Code用的HTTP同步端点,详见 `.claude/skills/steam-guide-sync/`
- `steam_daily_checkbox_sync.gs` —— 每日自动把Steam已解锁成就勾进Notion攻略页checkbox,详见 `.claude/skills/steam-daily-checkbox-sync/`
- `steam_test_debug.gs` —— Steam API调试工具集合,详见 `.claude/skills/steam-apps-script-dev/`
- `guides/` —— 已经做好的游戏成就攻略示例(Markdown,checkbox清单),纯本地文档,不会被clasp push

对应的技能/工作流细节见:
- `.claude/skills/steam-guide-sync/` —— GUIDES表读写、doPost端点、部署权限切换、HTTP调用踩坑
- `.claude/skills/steam-daily-checkbox-sync/` —— 每日自动勾选:安装/卸载、名字精确匹配算法(别改回子串/前缀匹配)
- `.claude/skills/steam-achievement-guide-writing/` —— 从头写/重写一份Notion攻略页(内容格式、wiki抓取、校验方法)
- `.claude/skills/steam-apps-script-dev/` —— clasp/部署约定、Steam API怪癖、表格schema

## 表格结构(RAW DATA,当前列顺序)

A=Status(Unvetted/Manual标记) / B=AppID / C=游戏名 / D=完成数 / E=成就总数 / F=完成率 / G=喜爱(♥) / H=重点关注(★) / I=成就更新日期 / J=家庭共享(非自购,纯信息标记)

Status(A列)和Family(J列)是两件独立的事——前者决定`runBatch`要不要跳过这行,后者纯粹是给自己看的"这游戏不是我买的"标记,互不影响。这个区分、以及`rebuildSheetFromApi`真正的保留判断逻辑,详见 `.claude/skills/steam-apps-script-dev/`。

## 目前进度

- 核心同步管线(RAW DATA自动更新、Dashboard展示、喜爱/重点关注标记)已经跑起来了
- ACHIEVEMENTS表(全库成就详情)已做好,中英文都存
- GUIDES表 + Notion攻略链接同步已跑通(appid为主键)
- 每日自动勾选成就checkbox的脚本(`steam_daily_checkbox_sync.gs`)已实现并投入使用
- Notion攻略页checkbox↔Steam真实解锁状态的同步、以及"重写内嵌数据库格式攻略页→标准checkbox"这两类任务都已经跑通过至少一次,方法论收录进 `.claude/skills/steam-achievement-guide-writing/` 和 `.claude/skills/steam-daily-checkbox-sync/`,不是本文档需要记录的内容

具体某个用户跑过哪些游戏、修过哪些delta,这类使用记录留在各自的Notion/Sheet里,不放在这份公开的项目文档中。

## 给下一个Claude Code session的经验(session管理/token成本)

1. **批量、重复性操作(比如给93个Notion页面逐个加一行文字)会不成比例地贵**——Notion MCP没有批量更新接口,只能一页页调用,而且往往发生在已经堆了很多历史内容的session里。遇到"体力活但要跑几十次"的任务,动手前就该提醒用户"要不要单独开个新session",不要埋头做到一半才发现贵。
2. **判断要不要另开session**:预估读写量明显超过当前会话量级,或者是纯重复性、可脱离上下文独立执行的任务,就建议开新session。改一两个具体checkbox这种小任务当场做就行。
3. **新session怎么接上**:靠这份文档 + `.claude/skills/`——按当前要做的任务加载对应skill,不用重新读整个.gs文件或重新发明逻辑。
4. **验证优先于假设**:不要assume工具调用成功=内容正确,做完之后重新读一遍结果确认(至少两次踩过这个坑,细节见git历史)。
5. **如果本地还有另一个指向同一个Apps Script项目(同一个scriptId)的文件夹**:`clasp push`不会保留"远端有、本地这份没有"的文件——会直接删掉。两边文件清单不一致时,从任一边push前先diff一下,或者干脆先`clasp pull`到一个临时目录看看线上真实状态。2026-08-03这天因为这个原因把`steam_daily_checkbox_sync.gs`从线上删掉过一次,当天发现并补救。

## 重要提醒

这个文档不是自动同步的——如果之后又在网页对话里做了新改动,记得手动更新,或者直接把最新的.gs/.html文件覆盖过来。新的操作性知识应该写进对应的skill文件,而不是加回这份文档。
