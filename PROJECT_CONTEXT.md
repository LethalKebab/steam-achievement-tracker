# Steam 成就自动化追踪项目 — 项目背景说明

给 Claude Code 快速上下文用。这个项目最早在 claude.ai 网页对话里搭起来,后来挪到 Claude Code,
再后来从 Google Apps Script + Google Sheet **整体改成了本地运行**(2026-08-03)。

## 项目是什么

一套自动追踪 Steam 游戏成就完成度的系统,全部跑在本地,由三部分组成:

1. **SQLite 数据库**(`data/steam.db`,唯一权威数据)—— 四张表:
   - `games` —— 全库游戏的成就完成度、♥/★/家庭共享标记、Manual 状态(原 `RAW DATA` 标签页)
   - `achievements` —— 全库游戏的完整官方成就详情(中英文名字都存,中文优先展示)
   - `guides` —— 每款游戏对应的攻略位置(Notion 链接或本地 md 文件名,只存指针不存正文)
   - `sync_log` —— checkbox 同步的逐条结果,事后复查用(原 `Sync Log` 标签页)
2. **Node CLI**(`tracker.js` + `lib/*.js`)—— 同步引擎、攻略同步、导入导出,零依赖
3. **网页 Dashboard**(`Dashboard.html`,由 `lib/server.js` 起的本地 HTTP 服务提供,只监听 127.0.0.1)

## 技术栈 & 关键约束

- **零依赖是刻意的**:只用 Node 内置模块(`node:sqlite` 存数据、内置 `fetch` 调 API、
  `node:http` 起服务、`node:test` 跑测试)。加 npm 依赖需要很强的理由——"不用 install"
  本身就是这个项目的卖点之一
- 需要 **Node 24+**(`node:sqlite` 的可用性),ES modules,文件之间是真的 `import`,
  不再是 Apps Script 那种共享全局作用域
- 敏感信息(Steam API Key / SteamID64 / Notion token)存在 `config.json`(权限 600,
  已 gitignore),或者用环境变量覆盖。**仓库是公开的,绝对不能提交进源码**
- appid 为主键,数据源以 Steam API 为准(不是手动录入)

## 文件清单

- `tracker.js` —— CLI 入口,所有命令(init/sync/serve/status/guides/checkbox-sync/import/export/log)
- `lib/steam.js` —— Steam Web API + 商店接口封装,所有已知怪癖的处理都在这里
- `lib/sync.js` —— 同步引擎三个阶段 + AGCR 计算
- `lib/db.js` —— SQLite 表结构和访问函数
- `lib/server.js` —— 本地 HTTP 服务,`/api/*` 分发,后台同步状态
- `lib/api.js` —— Dashboard 的 10 个后端方法,**函数名和返回结构必须和 `Dashboard.html` 调的一致**
- `lib/rpc-shim.js` —— 把 `google.script.run` 转成 `fetch`,所以前端那一千行没改
- `lib/guides.js` —— 成就名↔checkbox 的匹配规则、两种攻略后端的调度、攻略发现
- `lib/notion.js` / `lib/markdown.js` —— 两种攻略后端
- `lib/csv.js` —— CSV 解析/序列化、从 Sheet 导出的数据导入、导出
- `test/matching.test.js` —— 匹配规则的回归测试(`node --test`)
- `guides/` 目录 —— 已经做好的游戏成就攻略(Markdown),写法规则见
  `.claude/skills/achievement-guide-writing/SKILL.md`

## 已经踩过的坑(避免重复踩)

1. **Steam 商店 API 的 appdetails 接口,`name` 字段不受 `l=` 语言参数影响**(已知怪癖),
   要拿中文名必须额外抓商店网页 HTML 本身(`fetchAppNameFromStorePage`)
2. **商店网页抓取容易被限流**,正则要写宽松点(class 属性可能带多个 class),
   而且要带年龄验证的 cookie 绕过部分游戏的年龄确认页
3. **`GetPlayerAchievements` 返回 HTTP 400 通常代表"这游戏对这账号没有 stats 数据"**
   (不是错误,是 Steam 的标准信号),不要重试;只有 429 才是真限流需要重试;
   403 "Profile is not public" 是 Steam 侧的单游戏隐私开关,重试永远不会成功
4. **攻略正文不进数据库,只存指针**。最初的原因是 Google Sheets 单元格粘贴多行文本会被
   拆到多行;改成 SQLite 之后技术上可以存长文本了,但依然只存链接/文件名——
   攻略要能被人直接在 Notion 里勾选、编辑,存进库里反而不方便
5. **写/改攻略页(Notion 或本地 .md)的具体规则(checkbox 格式、配图取舍、Notion API 写入方式)
   见独立 skill 文件 `.claude/skills/achievement-guide-writing/SKILL.md`**,不在这里展开
6. **`Manual` 曾经被当成两件不同的事在用**:(a)"跳过每日成就自动同步",
   (b)"锁定 Status、不让 API 的 Unvetted 判定覆盖"。这两件事绑在同一个字段上,曾经导致
   "账号自己能查到真实成就数据、但游戏不在 `GetOwnedGames` 里"的家庭共享游戏被无脑锁死成
   Manual,成就数只能手动改。**本地版已经把它拆成 `status` 和 `sync_locked` 两列了**
   (默认行为不变,但现在可以只解锁同步、保留 Manual 分类)。
   **排查方法**:直接查 `GetPlayerAchievements` 看返回的 achieved 数字是不是账号自己的真实进度
   (全是 0 通常是别的家庭成员在玩;`GetPlayerAchievements` 能查到数据不代表这 appid 在
   `GetOwnedGames` 里)。**处理方式**:账号自己能查到真实数据 → `status` 清空 + `family` 打勾;
   查到的是别人的进度 → 继续 Manual
7. **`GetOwnedGames` 默认会漏掉一些游戏**:免费游戏默认不算在内(要
   `include_played_free_games=true`),"Unvetted"游戏默认也不算在内(要 `skip_unvetted_apps=false`)。
   想准确判断"这游戏到底是不是 owned / 是不是被 Steam 判成 Unvetted",必须严格按
   `fetchOwnedGamesWithUnvettedFlag()` 那样发两次请求做差集,不能只发一次就下结论
8. **判断"两条数据是否指向同一个外部资源"不能用对方系统返回的 URL/文本原文做 key,要用稳定 ID**:
   Notion 的页面 URL 有时会带标题 slug 前缀,同一个页面两次查询返回的 URL 文本可能不一样。
   攻略同步最初按 URL 原文比对"是否已在攻略表里",导致大量已存在的页面被误判成新页面、
   覆盖写入了本来整理好的 name/url。已修复:改用 `normalizeNotionId`(`lib/notion.js`)
9. **文档写的和代码实际做的可能不一致,光看文档不算验证**:`SYNC_SECRET` 曾经以明文硬编码在
   `steam_guides_sync.gs` 里,从项目"公开发布"那次提交起就一直躺在公开仓库里,
   尽管三份文档都写着它应该跟 STEAM_API_KEY 一样存 Script Properties——没人实际去源码里确认过。
   (本地版已经没有这个 endpoint 和这个 secret 了。)
10. **成就名匹配 checkbox 必须精确匹配,不能用 substring/prefix**——踩过两轮误勾的坑,
    详见 `CLAUDE.md` 的 "Guide checkbox matching" 一节和 `test/matching.test.js`。
    这条规则被测试锁住了,改 `lib/guides.js` 之后记得跑 `node --test`
11. **有些游戏存在多个"名字完全一样"的成就,靠名字匹配在原理上分不出来**(2026-08-03 发现)。
    《鬼谷八荒》有两个 `妙手空空 / Skilled Thief`:一个"隐秘偷窃10次"(已解锁),
    一个"通关且偷窃100次"(没解锁)。已解锁那个的 checkbox 早就勾上、退出了待匹配池,
    于是这个名字去匹配了**另一个还没解锁**的 checkbox——差一点勾错。
    这和第 10 条是同一类 bug 的第三种触发方式,精确匹配挡不住"完全同名"。
    已修:`findAmbiguousNames`——同名成就没全部解锁就整个名字放弃匹配,并记进日志。
    **这个库里有 12 组同名成就,涉及 11 款游戏**(CK3、文明VI、城市天际线、PUBG、
    古剑奇谭二 两组、雨世界、瘟疫公司、Farm Together、仙剑六、了不起的修仙模拟器),
    所以不是个别现象,别把这道闸门当多余的去掉
12. **写 Notion 之前先 `--dry-run`**。Notion 的勾选没法自动撤销,而上面第 11 条正是靠
    预演在真写之前抓出来的。改过匹配逻辑、或者隔了很久没跑,都先预演一遍

## 目前架构现状

- 核心同步管线(库同步、成就完成数、成就详情、Dashboard 展示、♥/★ 标记)都已经跑通,
  跑一条 `node tracker.js sync` 就是全量,不再有游标/分批/4.5 分钟上限那套东西
  (那些纯粹是为了绕开 Apps Script 单次执行 6 分钟限制)
- 攻略功能:Notion 是主用法(带 `appid: NNNNNN` 开头行的页面,`node tracker.js guides`
  自动发现并登记),本地 markdown 是第二种后端(`guides/*.md`,同样靠 `appid:` 行发现)。
  `node tracker.js checkbox-sync` 把 Steam 解锁状态同步成攻略里的 ✅,两种后端共用同一份匹配规则
- **定时任务没有了**:改成"打开 Dashboard 时数据超过 12 小时就后台自动同步" + 手动跑 CLI。
  代价是机器睡着的时候不会同步(原来的 Apps Script trigger 在 Google 云上 24 小时跑),
  想要真的每日后台任务需要自己配一个 launchd plist 调 `node tracker.js sync`
- 已知还没写攻略的游戏(Notion 攻略数据库里存在、但还没有攻略内容/appid 行):
  Xenoblade Chronicles X、三相奇谈、以闪亮之名、最强祖师、月圆之夜、燕云十六声
- 已知待处理:Notion 里"苏丹的游戏"有一个重复页面(旧的那个,url 含 `1d31fee6...`)需要手动删除
- 迁移状态(2026-08-03):Sheet 数据已全量导入本地(310 款游戏 / 9461 条成就详情 / 96 条攻略),
  AGCR 和原表格算出来一致(77.438%)。Apps Script 那边的 8am `dailyCheckboxSync` trigger 已删
  (它还带着老的、会误勾同名成就的匹配逻辑);2/3/4/7am 那几个先留着让 Sheet 继续更新当备份,
  等不需要了再删——删掉之后 Sheet 就不再是活备份了,记得先 `node tracker.js export` 存一份 CSV

## 可能的下一步

- 给上面列的几个游戏写攻略、把 Dashboard 做得更丰富、或者优化现有同步逻辑的健壮性
- 如果想要真正的每日自动同步(不依赖"打开页面"),加一个 launchd plist

## 给下一个 Claude Code session 的经验(session 管理/token 成本)

1. **批量、重复性的操作(比如给几十个 Notion 页面逐个加一行文字)会不成比例地贵**——
   Notion 的 MCP 连接器没有"批量更新"接口,只能一个 page 一个 page 调用,而这类任务通常出现在
   已经跑了很久、堆了很多历史内容的 session 里,每次工具调用都要带着整个对话历史算 token。
   **遇到这种"体力活但要跑几十次"的任务,动手前就提醒用户"这个大概要跑 N 次调用,
   要不要单独开个新 session 做"。**
2. **判断一个任务是否"应该另开 session"的经验法则**:预估要读/写的内容总量明显超过当前会话
   已有内容量级,或者是纯重复性、可以脱离当前上下文独立执行的任务,就值得建议开新 session
3. **新 session 要怎么接得上**:靠这份 `PROJECT_CONTEXT.md` 了解背景,靠各个 `.claude/skills/`
   文件了解具体操作规则和可复用函数
4. **验证优先于假设**:工具调用成功不代表内容正确。具体踩过的坑见上面第 8、9 条。
   改完之后重新读一遍结果确认,尤其是批量写入/覆盖类操作

## 重要提醒

这个文档是手动整理维护的,不是自动同步的——做了会影响其他 session 理解项目背景的改动,
记得回来更新这份文档;单个 session 内的操作细节不需要记录在这里,
只留下会持续有用的架构现状和教训。
