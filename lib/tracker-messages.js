/**
 * Everything `tracker.js` prints
 * ------------------------------------------------
 * A third table rather than a bigger `cli-messages.js`, and the axis is size rather than audience:
 * the CLI's own copy is more than four times the size of `serve`'s, and one file holding both is a
 * file nobody scrolls through. The **audience is identical**, so the rule that separates
 * `messages.js` from these two applies to this file exactly as it does to its sibling: everything
 * here reaches a terminal and nothing else, so it may name a command line — which is the most useful
 * thing there is to say to somebody who typed one. `cli-hints.test.js` lists both on `TERMINAL_ONLY`.
 *
 * `clog` reads this and `CLI_MESSAGES` as one table, so there is a single lookup and a single place
 * holding the language. The key prefixes keep the two apart, and a test pins that they never
 * collide — a duplicated key would have one half silently win.
 *
 * **The English half is a translation, not a rewrite.** Where the Chinese half names a flag, a file
 * or a config field, the English half names the same one: those are the parts a reader retypes.
 */
export const TRACKER_MESSAGES = {
  // ---- the top-level dispatch -------------------------------------------------
  'cli.unknown':          ['未知命令:{command}\n', 'Unknown command: {command}\n'],

  // ---- sync phase labels ------------------------------------------------------
  // Printed by the progress line as each phase starts; short by necessity, so each one names the
  // thing being fetched rather than the function doing it
  'phase.library':        ['检查新游戏', 'Checking for new games'],
  'phase.libraryEn':      ['补英文名', 'Filling in English names'],
  'phase.achievements':   ['刷新成就完成数', 'Refreshing achievement counts'],
  'phase.schema':         ['同步成就详情', 'Syncing achievement details'],

  // ---- guide-lint codes -------------------------------------------------------
  // The per-guide list and the totals share one set, so the two cannot disagree on naming
  'code.missingCheckbox': ['成就没有 checkbox,永远勾不上', 'the achievement has no checkbox and can never be ticked'],
  'code.mergedLine':      ['一行里写了多个 checkbox', 'several checkboxes on one line'],
  'code.ambiguousNoDesc': ['同名成就没抄描述,分不出是哪一个', 'a duplicate-named achievement with no description copied in, so the two cannot be told apart'],
  'code.checkedMismatch': ['勾选状态和真实解锁不一致', 'the ticked state disagrees with the real unlock state'],
  'code.missingTitle':    ['本地攻略缺 `# 游戏名`', 'the local guide has no `# Game Name` line'],
  'code.paraphrased':     ['描述不是原文照抄,audit 反查不了', 'the description is not verbatim, so audit cannot trace it back'],
  'code.statsInHeading':  ['节标题里有会过期的统计数字', 'a section heading carries counts that go stale'],
  'code.dataSourceNote':  ['写了勾选状态的数据来源', 'it states where the ticked state came from'],

  // ---- environment overrides, warned about before anything is spent ------------
  'env.provider':         ['供应商', 'The provider'],
  'env.model':            ['模型', 'The model'],
  'env.fromEnv':          ['{label}来自环境变量 {name}={value}(盖掉了 config.json)', '{label} comes from the environment variable {name}={value}, which overrides config.json'],
  'env.keyFromEnv':       ['API key 可能来自环境变量 {name}(盖掉了 config.json)', 'The API key may come from the environment variable {name}, which overrides config.json'],
  'env.clear':            ['      清掉:Remove-Item Env:AI_PROVIDER, Env:AI_MODEL -ErrorAction SilentlyContinue', '      To clear them: Remove-Item Env:AI_PROVIDER, Env:AI_MODEL -ErrorAction SilentlyContinue'],
  'env.dryRunKey':        ['(dry-run,不会发送)', '(dry run — nothing is sent)'],

  // ---- sync -------------------------------------------------------------------
  'sync.startFast':       ['开始同步(--fast:只查玩过的 + 轮换复查一批)\n', 'Starting the sync (--fast: only games played, plus a rotating batch of re-checks)\n'],
  'sync.start':           ['开始同步(Ctrl+C 可以随时停,已经写进库的数据不会丢)\n', 'Starting the sync (Ctrl+C stops it at any point; anything already written to the database is kept)\n'],
  'sync.library':         ['  库:owned {owned} 款(Unvetted {unvetted} 款),新增 {added} 款,Unvetted 标记更新 {restamped} 处', '  Library: {owned} owned ({unvetted} Unvetted), {added} added, {restamped} Unvetted stamps refreshed'],
  'sync.libraryShort':    ['  库:新增 {added} 款,Unvetted 标记更新 {restamped} 处', '  Library: {added} added, {restamped} Unvetted stamps refreshed'],
  'sync.namedEn':         [',补英文名 {n} 款', ', {n} English names filled in'],
  'sync.added':           ['     新增:{names}', '     Added: {names}'],
  'sync.stats':           ['  成就完成数:更新 {updated} 款,无成就系统 {noSystem} 款,留待重试 {retried} 款', '  Achievement counts: {updated} updated, {noSystem} with no achievement system, {retried} left to retry'],
  'sync.sample':          ['     取样:查了 {total} 款(玩过 {played} / 不在 owned {unowned} / 轮换复查 {swept})', '     Sampled: {total} checked ({played} played / {unowned} not owned / {swept} on rotation)'],
  'sync.samplePending':   [',{n} 款排队等下次', ', {n} queued for next time'],
  'sync.bumped':          ['     🆕 成就总数变多了(游戏更新):{names}', '     🆕 The achievement total rose — a game update: {names}'],
  'sync.schema':          ['  成就详情:处理 {processed}/{candidates} 款,查不到定义 {skipped} 款', '  Achievement details: {processed} of {candidates} processed, {skipped} with no definition found'],
  'sync.schemaShort':     ['  成就详情:处理 {processed}/{candidates} 款', '  Achievement details: {processed} of {candidates} processed'],
  'sync.done':            ['\n✅ 用时 {seconds} 秒 — AGCR {pct}%(精确 {exact}%),完美游戏 {perfect} 款', '\n✅ Finished in {seconds}s — AGCR {pct}% (exactly {exact}%), {perfect} perfect games'],

  // ---- status -----------------------------------------------------------------
  'status.db':            ['\n数据库:{n} 款游戏', '\nDatabase: {n} games'],
  'status.lastSync':      ['  上次同步:{when}', '  Last sync: {when}'],
  'status.never':         ['还没同步过', 'never'],
  'status.agcr':          ['  AGCR:{pct}%(精确 {exact}%),计入 {n} 款', '  AGCR: {pct}% (exactly {exact}%), over {n} games'],
  'status.perfect':       ['  完美(100%):{n} 款', '  Perfect (100%): {n}'],
  'status.flags':         ['  Unvetted:{unvetted} 款 / Manual:{manual} 款 / 家庭共享标记:{family} 款', '  Unvetted: {unvetted} / Manual: {manual} / marked family-shared: {family}'],
  'status.marks':         ['  ♥ 喜爱:{fav} 款 / ★ 重点关注:{pri} 款', '  ♥ Favourite: {fav} / ★ Priority: {pri}'],
  'status.noAch':         ['  没有成就系统:{none} 款 / 还没同步到数据:{unsynced} 款', '  No achievement system: {none} / not yet synced: {unsynced}'],
  'status.guides':        ['  攻略:{n} 条(Notion {notion} / 本地 {local})\n', '  Guides: {n} ({notion} on Notion / {local} local)\n'],

  // ---- guides -----------------------------------------------------------------
  'guides.local':         ['本地 guides/:扫了 {files} 个 .md,登记 {added} 条', 'Local guides/: {files} .md files scanned, {added} registered'],
  'guides.skipped':       ['  跳过(没有 "appid: NNNNNN" 行):{names}', '  Skipped (no "appid: NNNNNN" line): {names}'],
  'guides.conflict':      ['  ⚠️  {appid} 已经登记了 Notion 攻略,没动 {file}(想改成用本地 md 加 --force)', '  ⚠️  {appid} already has a Notion guide registered, so {file} was left alone (add --force to switch to the local md)'],
  'guides.noToken':       ['Notion:没配 token,跳过(要用的话在 config.json 填 notion.token 和 notion.overviewDbId)', 'Notion: no token configured, skipping (set notion.token and notion.overviewDbId in config.json to use it)'],
  'guides.notion':        ['Notion:数据库里 {pages} 个页面,新页面 {fresh} 个,登记 {added} 条', 'Notion: {pages} pages in the database, {fresh} new, {added} registered'],
  'guides.table':         ['\n当前 guides 表({n} 条):', '\nThe guides table right now ({n} rows):'],

  // ---- guide-status -----------------------------------------------------------
  'gs.noToken':           ['Notion:没配 token(config.json 的 notion.token / notion.overviewDbId)', 'Notion: no token configured (notion.token / notion.overviewDbId in config.json)'],
  'gs.dryRun':            ['预演模式:只算不写\n', 'Dry run: it works out what would change and writes nothing\n'],
  'gs.summary':           ['攻略数据库 {pages} 个页面:{up} 个该标 Done,{down} 个该退回 Staged', '{pages} pages in the guide database: {up} to mark Done, {down} to send back to Staged'],
  'gs.nothing':           ['  (没有要改的,状态和完成度已经一致)', '  (nothing to change — the statuses already match the completion)'],
  'gs.rerun':             ['\n确认没问题就去掉 --dry-run 再跑一次。', '\nIf that looks right, drop --dry-run and run it again.'],

  // ---- checkbox-sync ----------------------------------------------------------
  'cbs.dryRun':           ['预演模式:只读攻略页面算出会勾哪些,不写任何东西\n', 'Dry run: it reads the guide pages, works out what would be ticked, and writes nothing\n'],
  'cbs.noCascade':        ['已关闭子步骤联动:只按成就名/描述匹配勾选\n', 'Sub-step cascade off: ticking only by achievement name and description\n'],
  'cbs.checked':          ['检查了 {games} 款游戏,产生 {logs} 条日志', '{games} games checked, {logs} log lines'],
  'cbs.game':             ['\n  {game}({n} 条)', '\n  {game} ({n})'],
  'cbs.noCandidates':     ['  (没有符合条件的游戏:需要有攻略登记、有成就系统、且还没 100% 完成)', '  (no games qualify: one needs a registered guide, an achievement system, and to be short of 100%)'],
  'cbs.dryRunEnd':        ['\n预演结束:会勾选 {n} 个 checkbox。确认没问题就去掉 --dry-run 再跑一次。\n(Notion 的勾选没法自动撤销,建议先只跑一款游戏:checkbox-sync <appid>)', '\nDry run finished: {n} checkboxes would be ticked. If that looks right, drop --dry-run and run it again.\n(A tick on Notion cannot be undone automatically, so try one game first: checkbox-sync <appid>)'],

  // ---- notion-check --fix's reformat report -----------------------------------
  'fix.regrouped':        ['   🔧 排进看板分组:{names}', '   🔧 Sorted into board groups: {names}'],
  'fix.stillWrongGroup':  ['   ❌ 分组没落地:{names}', '   ❌ The grouping did not take: {names}'],
  'fix.boardCreated':     ['   🔧 加了看板视图,放在第一个标签页', '   🔧 Added a board view as the first tab'],
  'fix.boardFailed':      ['   ⚠️  看板视图没建成:{reason}', '   ⚠️  The board view was not created: {reason}'],
  'fix.boardHarmless':    ['      库照常能用,攻略照样生成,复选框照样勾', '      The database still works, guides are still generated, and checkboxes are still ticked'],
  'fix.recoloured':       ['   🔧 换好颜色:{names}', '   🔧 Recoloured: {names}'],
  'fix.restored':         ['      有 {n} 页的状态是照快照写回去的:{names}', '      {n} pages had their status written back from the snapshot: {names}'],
  'fix.colourFailed':     ['   ⚠️  这几个状态的颜色没换成:{names}', '   ⚠️  These statuses could not be recoloured: {names}'],
  'fix.colourByHand':     ['      也可以自己来:打开那个库 → 点状态属性 → 逐个挑一次', '      You can also do it by hand: open the database → click the status property → pick each one once'],

  // ---- audit ------------------------------------------------------------------
  'audit.intro':          ['审计已勾选的 checkbox:找"勾上了但成就其实没解锁"的(只读,不会改任何东西)\n', 'Auditing ticked checkboxes for ones whose achievement is not actually unlocked (read-only; nothing is changed)\n'],
  'audit.skipped':        ['  ⏭  {name} —— 跳过:{reason}', '  ⏭  {name} — skipped: {reason}'],
  'audit.wrongGame':      ['\n  ❌ {name}(已勾 {ticked} 个,其中 {wrong} 个对应的成就没解锁)', '\n  ❌ {name} ({ticked} ticked, {wrong} of them for achievements that are not unlocked)'],
  'audit.wrongEntry':     ['     {name}({apiName},按{via}对上的)', '     {name} ({apiName}, matched by {via})'],
  'audit.viaDesc':        ['描述', 'description'],
  'audit.viaName':        ['名字', 'name'],
  'audit.total':          ['\n审计完 {games}/{candidates} 款游戏,检查了 {ticked} 个已勾选的 checkbox', '\nAudited {games} of {candidates} games and checked {ticked} ticked checkboxes'],
  'audit.wrongTotal':     ['  确认勾错:{n} 个', '  Confirmed wrong: {n}'],
  'audit.unresolved':     ['  对不上具体成就、没下结论:{n} 个(攻略文字既没抄描述原文、名字也不唯一)', '  Undetermined: {n} (the guide text neither copies the description verbatim nor carries a unique name)'],
  'audit.skippedTotal':   ['  跳过的游戏:{n} 款(见上面)', '  Games skipped: {n} (listed above)'],
  'audit.fixByHand':      ['\n勾错的框需要手动取消勾选——checkbox-sync 只会勾上、从不取消,修不了自己的错。', '\nA wrongly ticked box has to be unticked by hand — checkbox-sync only ever ticks and never unticks, so it cannot repair its own mistakes.'],
  'audit.checkFirst':     ['取消之前先自己确认一遍:也可能是你自己有意勾的(比如标记"计划要做")。', 'Check each one before unticking: you may have ticked it deliberately, to mark something as planned.'],

  // ---- guide-lint -------------------------------------------------------------
  'lint.intro':           ['校验攻略写法(只读,不会改任何东西)', 'Validating how the guides are written (read-only; nothing is changed)'],
  'lint.withTicks':       ['已开启勾选状态校验:每款游戏都要单独问一次 Steam,会慢不少\n', 'Ticked-state checking is on: every game needs its own request to Steam, so this is considerably slower\n'],
  'lint.withoutTicks':    ['(勾选状态默认不校验,要的话加 --checked)\n', '(the ticked state is not checked by default; add --checked for that)\n'],
  'lint.skipped':         ['  ⏭  {name} —— 跳过:{reason}', '  ⏭  {name} — skipped: {reason}'],
  'lint.guide':           ['\n  {mark} {name}({appid})  {covered}/{achievements} 覆盖,{todos} 个框', '\n  {mark} {name} ({appid})  {covered}/{achievements} covered, {todos} boxes'],
  'lint.perGuide':        ['\n  (逐条看某一份:guide-lint <appid>)', '\n  (to see one guide entry by entry: guide-lint <appid>)'],
  'lint.total':           ['\n校验了 {guides} 份攻略:{noErrors} 份没有 error(其中 {clean} 份连 warn 都没有)', '\n{guides} guides validated: {noErrors} with no errors ({clean} of those with no warnings either)'],
  'lint.skippedTotal':    ['  跳过 {n} 份(多半是 100% 通关的游戏,成就详情没同步,没有可比对的基准)', '  {n} skipped (mostly games at 100%, whose achievement details are not synced, so there is nothing to compare against)'],
  'lint.coverage':        ['  成就覆盖:{covered}/{achievements}({pct}%)', '  Achievement coverage: {covered}/{achievements} ({pct}%)'],
  'lint.byKind':          ['\n  按问题类型:', '\n  By kind of finding:'],
  'lint.noErrors':        ['\n没有 error。', '\nNo errors.'],
  'lint.errorTotal':      ['\n合计 {errors} 个 error、{warnings} 个 warn。改的是攻略内容,不是代码。', '\n{errors} errors and {warnings} warnings in total. What needs changing is the guide content, not the code.'],

  // ---- ai-check's smoke target ------------------------------------------------
  'smoke.noDetail':       ['appid {appid} 还没有成就详情。先跑 `node tracker.js sync --schema`', 'appid {appid} has no achievement details yet. Run `node tracker.js sync --schema` first'],
  'smoke.noneAtAll':      ['数据库里一条成就详情都没有。先跑 `node tracker.js sync --schema`', 'There is not one achievement detail in the database. Run `node tracker.js sync --schema` first'],

  // ---- drafts -----------------------------------------------------------------
  'drafts.noDir':         ['草稿目录还不存在,没什么可清的。', 'The drafts directory does not exist yet, so there is nothing to clear.'],
  'drafts.empty':         ['草稿目录是空的。', 'The drafts directory is empty.'],
  'drafts.header':        ['\n{dir}:{n} 份草稿\n', '\n{dir}: {n} drafts\n'],
  'drafts.markDelete':    ['删', 'rm'],
  'drafts.row':           ['  {mark} {age} 天前  {size} B  {file}', '  {mark} {age}d ago  {size} B  {file}'],
  'drafts.harmless':      ['\n草稿不会被攻略发现逻辑扫到,留着不影响任何东西 —— 只是会一直堆着。', '\nDrafts are invisible to guide discovery and harm nothing if left — they simply accumulate.'],
  'drafts.howToClean':    ['要清:node tracker.js drafts --clean [--older-than N]', 'To clear them: node tracker.js drafts --clean [--older-than N]'],
  'drafts.nothingOld':    ['\n没有超过 {days} 天的草稿,什么都没删。', '\nNo drafts older than {days} days, so nothing was deleted.'],
  'drafts.deleted':       ['\n✅ 删了 {n} 份,还剩 {left} 份。', '\n✅ Deleted {n}, {left} left.'],

  // ---- export -----------------------------------------------------------------
  'export.to':            ['\n导出到 {dir}:', '\nExported to {dir}:'],
  'export.file':          ['  {file}({rows} 行)', '  {file} ({rows} rows)'],

  // ---- backup -----------------------------------------------------------------
  'backup.done':          ['\n✅ 备份好了:{path}', '\n✅ Backed up: {path}'],
  'backup.counts':        ['   {games} 款游戏、{achievements} 条成就、{guides} 条攻略登记、{files} 个攻略文件', '   {games} games, {achievements} achievements, {guides} registered guides, {files} guide files'],
  'backup.hasSecrets':    ['\n⚠️  里面有 config.json,也就是**明文的** Steam / Notion / AI 密钥。', '\n⚠️  It contains config.json, which holds your Steam / Notion / AI keys **in plain text**.'],
  'backup.secretsCost':   ['   拿到这个文件的人能花你的 AI 额度。不想带就加 --no-config。', '   Anyone holding this file can spend your AI credit. Add --no-config to leave it out.'],
  'backup.moveMachine':   ['\n换到新机器:把这个 zip 拷过去,`node tracker.js restore <文件>`。', '\nTo move to another machine: copy the zip over and run `node tracker.js restore <file>`.'],

  // ---- log --------------------------------------------------------------------
  'log.empty':            ['还没有同步日志', 'There is no sync log yet'],

  // ---- Notion option colours, printed when notion-check --fix reports what it changed ----
  'colour.default':       ['默认', 'default'],
  'colour.blue':          ['蓝', 'blue'],
  'colour.purple':        ['紫', 'purple'],
  'colour.green':         ['绿', 'green'],

  // ---- init --notion --create -------------------------------------------------
  'nb.querying':          ['正在查询这个 connection 能访问的页面…', 'Looking up the pages this connection can see…'],
  'nb.noPages':           ['\r⚠️  这个 integration 一个页面都看不到                    ', '\r⚠️  This integration cannot see a single page                    '],
  'nb.noPagesWhy':        ['   token 是好的,所以缺的是共享:在 Notion 里打开要放攻略的那一页', '   The token is fine, so what is missing is sharing. Open the page the guides should live under'],
  'nb.noPagesHow':        ['   → 右上角 ••• → Connections → 加上这个 integration,然后重跑一次', '   → ••• at the top right → Connections → add this integration, then run it again'],
  'nb.canSee':            ['\r能访问 {n} 个页面{more}:                    \n', '\r{n} pages visible{more}:                    \n'],
  'nb.andMore':           ['(还有更多没列完)', ' (and more not listed)'],
  'nb.pick':              ['\n建在哪一页下面?(1-{n}): ', '\nWhich page should it go under? (1-{n}): '],
  'nb.badPick':           ['没选一个有效的编号,什么都没建', 'That is not one of the numbers, so nothing was created'],
  'nb.nameAsk':           ['数据库名字(回车用「Steam 攻略」): ', 'Database name (Enter for "Steam Guides"): '],
  // The title of a database created in the **user's own Notion**, so it follows the interface
  // language like the prompt that offered it. Renaming it later is a Notion edit, not a config one
  'nb.defaultName':       ['Steam 攻略', 'Steam Guides'],
  'nb.creating':          ['正在建…', 'Creating…'],
  'nb.created':           ['\r✅ 建好了:{url}        ', '\r✅ Created: {url}        '],
  'nb.options':           ['   状态选项:{options}', '   Status options: {options}'],
  'nb.groupNote':         ['   (四个选项都在 To-do 分组里 —— Notion 的 API 设不了分组,试过,静默无效。', '   (all four options are in the To-do group — Notion\'s API cannot set groups; it was tried, and it fails silently.'],
  'nb.groupNote2':        ['    不影响功能,想整理 board 视图的话自己在 Notion 里拖一下)', '    Nothing depends on it; drag them in Notion if you want the board view tidier)'],

  // ---- init --notion ----------------------------------------------------------
  'in.title':             ['\n配置 Notion 攻略同步\n', '\nSetting up Notion guide syncing\n'],
  'in.tokenWhere':        ['token 从哪来:打开 https://app.notion.com/developers/connections,点 New connection,', 'Where the token comes from: open https://app.notion.com/developers/connections and click New connection,'],
  'in.tokenWhere2':       ['在它的 Configuration 标签页里复制 Access token(ntn_ 开头)。然后把攻略页面(或它们', 'then copy the Access token (it starts with ntn_) from its Configuration tab. Then grant the integration'],
  'in.tokenWhere3':       ['共同的父页面)授权给它:Notion 页面右上角 ••• → Add connections → 选中它,', 'access to the guide pages, or their common parent: ••• at the top right of the page → Add connections → pick it,'],
  'in.tokenWhere4':       ['否则 API 会返回 404。\n', 'or the API answers 404.\n'],
  'in.tokenDocs':         ['带图的完整步骤:docs/notion-setup.md\n', 'The full walkthrough with screenshots: docs/notion-setup.md\n'],
  'in.tokenAsk':          ['Notion Integration Token(输入不会显示): ', 'Notion integration token (not shown as you type): '],
  'in.tokenMissing':      ['没输入 token', 'No token was entered'],
  'in.verifying':         ['\n正在验证 token…', '\nVerifying the token…'],
  'in.tokenOk':           ['\r✅ token 可用:integration「{name}」        ', '\r✅ The token works: integration "{name}"        '],
  'in.unnamed':           ['未命名', 'unnamed'],
  'in.hasDb':             ['\n⚠️  已经配了攻略库:{url}', '\n⚠️  A guide database is already configured: {url}'],
  'in.hasDbWarn':         ['   新建一个会把配置改指到新库 —— 现有攻略一篇都不会丢,但工具会看不到它们。', '   Creating another repoints the configuration at it. No existing guide is lost, but this tool stops seeing them.'],
  'in.hasDbConfirm':      ['   确定还要建一个新的?(y/N) ', '   Create a new one anyway? (y/N) '],
  'in.cancelled':         ['取消了,什么都没建', 'Cancelled; nothing was created'],
  'in.dbIdAsk':           ['攻略数据库 ID{default}: ', 'Guide database ID{default}: '],
  'in.dbIdDefault':       ['(回车用 {id})', ' (Enter for {id})'],
  'in.noDbHint':          ['   (没有现成的库?`node tracker.js init --notion --create` 让程序建一个)', '   (No database yet? `node tracker.js init --notion --create` creates one for you)'],
  'in.dbChecking':        ['正在验证数据库访问…', 'Checking access to the database…'],
  'in.dbOk':              ['\r✅ 数据库可访问:里面有 {n} 个页面        ', '\r✅ The database is reachable: {n} pages in it        '],
  'in.dbFailed':          ['\r⚠️  数据库访问失败:{reason}', '\r⚠️  Could not reach the database: {reason}'],
  'in.dbFailedWhy':       ['   token 本身是好的,所以问题在 ID 或权限:', '   The token itself is fine, so it is the ID or the permissions:'],
  'in.dbFailedA':         ['   · 它不是数据库 —— 要整页打开,取 URL 里 ?v= 之前那 32 位十六进制', '   · it is not a database — open it as a full page and take the 32 hex characters before ?v= in the URL'],
  'in.dbFailedA2':        ['     (页面 ID、视图 ID、整条链接都不行)', '     (a page ID, a view ID or the whole link will not do)'],
  'in.dbFailedB':         ['   · 还没共享 —— 打开它(或父页面)→ ••• → Connections → 加上这个 integration', '   · it is not shared — open it (or its parent) → ••• → Connections → add this integration'],
  'in.dbFailedC':         ['   · 压根还没有库 —— 改用 `init --notion --create`', '   · there is no database at all — use `init --notion --create` instead'],
  'in.written':           ['\n✅ 已写入 {path}(权限 600,已 gitignore,不会被提交)', '\n✅ Written to {path} (mode 600, gitignored, never committed)'],
  'in.next':              ['\n接下来:', '\nNext:'],
  'in.nextCheck':         ['  node tracker.js notion-check               ← 只读体检,确认这一侧全通了', '  node tracker.js notion-check               ← a read-only check that this side is fully wired up'],
  'in.nextGuides':        ['  node tracker.js guides --notion            ← 发现攻略页并登记', '  node tracker.js guides --notion            ← discover the guide pages and register them'],
  'in.nextCbs':           ['  node tracker.js checkbox-sync --dry-run    ← 只算不写,先看会勾掉哪些', '  node tracker.js checkbox-sync --dry-run    ← works out what would be ticked and writes nothing'],
  'in.dbStepFailed':      ['\n(数据库那一步没通过的话,上面几条会失败,先按上面的提示修)', '\n(if the database step did not pass, the commands above will fail; fix that first using the notes above)'],

  // ---- init --ai --------------------------------------------------------------
  'ia.title':             ['\n配置 AI 攻略生成\n', '\nSetting up AI guide generation\n'],
  'ia.what':              ['这个功能会调用 AI 联网查资料并写攻略。', 'This feature calls an AI, has it research on the web, and has it write the guide.'],
  'ia.optional':          ['不用这个功能的话,整个项目的其他部分都不需要它。\n', 'Nothing else in the project needs it if you do not use this feature.\n'],
  'ia.pick':              ['\n选一个(1-{n},回车用 1): ', '\nPick one (1-{n}, Enter for 1): '],
  'ia.badPick':           ['没有第 {pick} 个选项', 'There is no option {pick}'],
  'ia.keyAsk':            ['{label} API Key(输入不会显示): ', '{label} API key (not shown as you type): '],
  'ia.keyMissing':        ['没输入 key', 'No key was entered'],
  'ia.modelAsk':          ['模型名(回车用这一家的默认值): ', "Model name (Enter for this vendor's default): "],
  'ia.verifying':         ['\n正在验证(模型 {model})…', '\nVerifying (model {model})…'],
  'ia.probe':             ['回复一个字:好', 'Reply with one word: ok'],
  'ia.verifyFailed':      ['验证没通过:{reason}', 'Verification failed: {reason}'],
  'ia.ok':                ['\r✅ 可用:{name} / {model},回了「{reply}」      ', '\r✅ Working: {name} / {model}, which replied "{reply}"      '],
  'ia.written':           ['\n✅ 已写入 {path}(已 gitignore,不会被提交)', '\n✅ Written to {path} (gitignored, never committed)'],
  'ia.nextCheck':         ['  node tracker.js ai-check              ← 验证联网搜索真的能用(重点看有没有发出搜索)', '  node tracker.js ai-check              ← check that web search really works (watch for whether a search is actually issued)'],
  'ia.nextGen':           ['  node tracker.js guide-gen <appid>     ← 生成一份攻略(开始之前会先问你一句)', '  node tracker.js guide-gen <appid>     ← write a guide (it asks before it starts)'],
  'ia.envNote':           ['\n(不想把 key 写进文件的话,也可以用环境变量 {env}=… 临时覆盖)', '\n(to keep the key out of the file, the environment variable {env}=… overrides it for one run)'],

  // ---- init -------------------------------------------------------------------
  'init.title':           ['\nSteam 成就追踪器 —— 本地版初始化\n', '\nSteam achievement tracker — first-run setup\n'],
  'init.hasConfig':       ['已有配置:{path}', 'There is already a configuration: {path}'],
  'init.again':           ['要重新填一遍吗?(y/N) ', 'Fill it in again? (y/N) '],
  'init.needTwo':         ['需要两个东西(都是一次性的):', 'Two things are needed, both one-off:'],
  'init.needSteamId':     ['  ② SteamID64        → https://steamid.io(把你的个人资料链接粘进去)\n', '  ② SteamID64        → https://steamid.io (paste your profile link in)\n'],
  'init.bothRequired':    ['两项都要填写', 'Both are required'],
  'init.oddId':           ['⚠️  SteamID64 一般是 17 位数字,你填的看起来不像,先存下了,同步失败的话回来检查这里', '⚠️  A SteamID64 is normally 17 digits and this one does not look like one. It has been saved anyway; come back here if the sync fails'],
  'init.written':         ['\n✅ 写入 {path}(权限 600,已在 .gitignore 里)', '\n✅ Written to {path} (mode 600, in .gitignore)'],
  'init.dbMade':          ['✅ 建好数据库 {path}', '✅ Database created at {path}'],
  'init.verifying':       ['\n正在验证凭据…', '\nVerifying the credentials…'],
  'init.credsOk':         ['\r✅ 凭据可用:Steam 返回了 {n} 款游戏          ', '\r✅ The credentials work: Steam returned {n} games          '],
  'init.credsFailed':     ['\r❌ 凭据验证失败:{reason}', '\r❌ The credentials failed: {reason}'],
  'init.credsFix':        ['   检查一下 API Key 和 SteamID64,改 config.json 或者重跑 init 都行。', '   Check the API key and the SteamID64; edit config.json or run init again.'],
  'init.nextSync':        ['  node tracker.js sync               ← 首次全量同步(库大的话要几分钟)', '  node tracker.js sync               ← the first full sync (a few minutes for a large library)'],
  'init.nextServe':       ['  node tracker.js serve              ← 打开 Dashboard', '  node tracker.js serve              ← open the Dashboard'],

  // ---- notion-check -----------------------------------------------------------
  'nc.noToken':           ['❌ 没配 Notion token(config.json 的 notion.token)', '❌ No Notion token configured (notion.token in config.json)'],
  'nc.noTokenFix':        ['   跑 `node tracker.js init --notion` 配一下', '   Run `node tracker.js init --notion` to set it up'],
  'nc.noDbId':            ['❌ 没配攻略数据库 ID(config.json 的 notion.overviewDbId)', '❌ No guide database ID configured (notion.overviewDbId in config.json)'],
  'nc.noDbIdFix':         ['   `node tracker.js init --notion --create` 可以直接建一个', '   `node tracker.js init --notion --create` creates one for you'],
  'nc.twoCauses':         ['   两种可能,修法不一样:', '   Two possible causes, with different fixes:'],
  'nc.database':          ['✅ 数据库:「{title}」', '✅ Database: "{title}"'],
  'nc.titleProp':         ['✅ 标题属性:{name}', '✅ Title property: {name}'],
  'nc.noStatus':          ['ℹ️  没有状态属性 —— 合法。攻略照样能建、能同步勾选,只是', 'ℹ️  No status property — which is legal. Guides are still created and checkboxes still sync; it only means'],
  'nc.noStatus2':         ['   guide-status 那套(打满→Done、掉出 100%→Staged)没东西可写。', '   that guide-status (100% → Done, dropping below → Staged) has nothing to write to.'],
  'nc.noStatus3':         ['   想要的话加一个 Status 属性,选项:{options}', '   To use it, add a Status property with these options: {options}'],
  'nc.statusProp':        ['⚠️  状态属性:{property}({type})', '⚠️  Status property: {property} ({type})'],
  'nc.statusHave':        ['   现有选项:{have}', '   Options present: {have}'],
  'nc.statusNone':        ['无', 'none'],
  'nc.statusMissing':     ['   缺:{missing}', '   Missing: {missing}'],
  'nc.statusBlocks':      ['   缺的那个会在程序真要写它的时候把命令拦下来:', '   A missing option stops the command at the moment the program tries to write it:'],
  'nc.statusUsedNew':     ['     · guide-gen / guide-to-notion 建新页时按完成度写这三档', '     · guide-gen / guide-to-notion writes one of these three by completion when creating a page'],
  'nc.statusUsedStaged':  ['     · guide-status 把掉出 100% 的页面退回 Staged 时写它(每次开 Dashboard 都跑)', '     · guide-status writes it when sending a page that dropped below 100% back to Staged (which runs every time the Dashboard opens)'],
  'nc.fixed':             ['   🔧 已补上:{added}(回读确认落地)', '   🔧 Added: {added} (confirmed by reading back)'],
  'nc.clobbered':         ['   ❌ 补的时候把已有选项冲掉了:{names} —— 请去 Notion 里加回来', '   ❌ Adding them wiped existing options: {names} — please add them back in Notion'],
  'nc.stillMissing':      ['   ❌ Notion 收下了请求但选项没落地,还缺:{names}', '   ❌ Notion accepted the request but the options did not land; still missing: {names}'],
  'nc.addByHand':         ['      手动加:打开那个库 → 点这个属性 → 加选项,名字要一模一样(注意大小写)', '      Add them by hand: open the database → click the property → add the options, spelled exactly (case included)'],
  'nc.tryFix':            ['   加 --fix 让程序试着补上,或者自己去 Notion 里加(名字要一模一样,注意大小写)', '   Add --fix to have the program try, or add them in Notion yourself (spelled exactly, case included)'],
  'nc.statusOk':          ['✅ 状态属性:{property}({type}),四个选项齐全', '✅ Status property: {property} ({type}), all four options present'],
  'nc.probeOk':           ['✅ 试写:建页 + 归档都通过(这个 integration 确实有写权限)', '✅ Write probe: creating and archiving a page both passed, so this integration really can write'],
  'nc.pages':             ['✅ 库里 {pages} 个页面,其中 {registered} 个已登记进 guides 表', '✅ {pages} pages in the database, {registered} of them registered in the guides table'],
  'nc.unregistered':      ['   剩下 {n} 个没有 `appid: NNNNNN` 行 —— 那是还没写的攻略,不是错误', '   The other {n} have no `appid: NNNNNN` line — those are guides not yet written, not an error'],

  // ---- the AI provider list shown by init --ai --------------------------------
  'prov.deepseek':        ['有联网搜索。key 在 https://platform.deepseek.com/api_keys', 'Has web search. Keys: https://platform.deepseek.com/api_keys'],
  'prov.anthropic':       ['有联网搜索。key 在 https://platform.claude.com/settings/keys', 'Has web search. Keys: https://platform.claude.com/settings/keys'],
  'prov.gemini':          ['有联网搜索。key 在 https://aistudio.google.com/apikey', 'Has web search. Keys: https://aistudio.google.com/apikey'],

  // ---- ai-check ---------------------------------------------------------------
  'ac.noModelList':       ['{name} 没有列模型的接口(目前只有 gemini 有)', '{name} has no endpoint that lists models (only gemini does at present)'],
  'ac.modelList':         ['\n{name} 列出来的模型({n} 个):\n', '\nModels {name} lists ({n}):\n'],
  'ac.modelLimits':       ['  输入上限 {input} / 输出上限 {output}', '  input limit {input} / output limit {output}'],
  'ac.listedNotUsable':   ['\n⚠️  列出来 ≠ 能用。这个接口只说模型存在,不反映你的 key 有没有权限或额度:\n    · 老版本可能已经"对新用户停止提供"(实测 2.5 系列)\n    · 有的在你这一档额度是 0(实测 Pro 系列在免费层)\n    真跑一次 `ai-check` 才知道。', '\n⚠️  Listed does not mean usable. This endpoint says a model exists; it says nothing about whether your key has access or allowance:\n    · an older version may have stopped being offered to new users (measured on the 2.5 series)\n    · some have an allowance of 0 on your tier (measured on the Pro series on the free tier)\n    Only a real `ai-check` run tells you.'],
  'ac.currentModel':      ['\n当前用的是 {model}。临时换:--model <名字>;固定换:改 config.json 的 ai.model。', '\nCurrently using {model}. For one run: --model <name>. Permanently: ai.model in config.json.'],
  'ac.probeSystem':       ['你在帮一个 Steam 成就攻略作者做资料调研。回答用中文,只讲怎么达成,不要寒暄和总结段。', 'You are researching for someone writing a Steam achievement guide. Answer in English, say only how the achievement is earned, and skip greetings and summaries.'],
  'ac.probeTask':         ['。请先上网搜一下这个成就的攻略,能抓到正文的话读一读,然后用三句话讲清楚怎么拿到它。', '. Search the web for a guide to this achievement, read the page if you can fetch it, and then say in three sentences how to earn it.'],
  'ac.dryRun':            ['\n只组装不发送(--dry)。供应商 {name},模型 {model}。', '\nAssembled but not sent (--dry). Provider {name}, model {model}.'],
  // One entry per state rather than a label plus a slot: 「API key:」 carries no Chinese at all, so
  // as its own entry it reads as a half-finished translation to every check that walks this table
  'ac.keySet':            ['API key:已配置(不打印)\n', 'API key: configured (not printed)\n'],
  'ac.keyUnset':          ['API key:**没配置**\n', 'API key: **not configured**\n'],
  'ac.requestBody':       ['请求体:', 'Request body:'],
  'ac.dryRunEnd':         ['\n真跑一次:去掉 --dry。', '\nTo run it for real: drop --dry.'],
  'ac.header':            ['\n供应商 {name} · 模型 {model} · 联网工具 {tools} 个', '\nProvider {name} · model {model} · {tools} web tools'],
  'ac.subject':           ['题目:《{game}》的成就「{achievement}」\n', 'Subject: the {achievement} achievement in {game}\n'],
  'ac.toolFailed':        [' 失败({code})', ' failed ({code})'],
  'ac.endToEnd':          ['✅ 端到端跑通', '✅ End to end, it works'],
  'ac.roundUnusable':     ['❌ 这轮不能用:{reason}', '❌ This round is unusable: {reason}'],
  'ac.stopReason':        ['  stop_reason: {stop}{raw} · 续跑 {continuations} 次 · 耗时 {secs}s', '  stop_reason: {stop}{raw} · {continuations} continuations · {secs}s'],
  'ac.rawStop':           ['(原值 {raw})', ' (raw {raw})'],
  'ac.searches':          ['  🔎 实际发出 {n} 次搜索:{queries}', '  🔎 {n} searches actually issued: {queries}'],
  'ac.noSearch':          ['  ⚠️  声明了联网工具,但这一轮一次搜索都没发出去 —— 可能是这个层级/模型不支持,', '  ⚠️  Web tools were declared and not one search went out this round. The tier or the model may not support them,'],
  'ac.noSearch2':         ['      也可能是模型觉得不用查。攻略生成如果一直这样,内容就是它凭记忆编的', '      or the model decided it did not need to look. If guide generation keeps doing this, the content is written from memory'],
  'ac.toolFetchNote':     ['(逐个 URL 的常态,不影响这一轮)', ' (normal per URL; it does not affect this round)'],
  'ac.toolError':         ['  ⚠️  {tool}报错:{code}{tail}', '  ⚠️  {tool} error: {code}{tail}'],
  'ac.toolFetch':         ['抓页', 'fetch'],
  'ac.toolSearch':        ['搜索', 'search'],

  // ---- guide-to-notion --------------------------------------------------------
  'gtn.usage':            ['用法:node tracker.js guide-to-notion <appid> [--dry-run] [--yes]', 'Usage: node tracker.js guide-to-notion <appid> [--dry-run] [--yes]'],
  'gtn.source':           ['  来源:{path}', '  Source: {path}'],
  'gtn.boxes':            ['  {n} 个 checkbox,其中 {checked} 个已勾选(勾选状态原样带过去)', '  {n} checkboxes, {checked} of them ticked (the ticked state travels as it is)'],
  'gtn.converts':         ['  转换成 {breakdown}', '  Converts to {breakdown}'],
  'gtn.typeCount':        ['{n} 个 {type}', '{n} × {type}'],
  'gtn.intoExisting':     ['  写进 Notion 上已有的空页:{url}', '  Written into an existing empty page on Notion: {url}'],
  'gtn.intoNew':          ['  在 Notion 攻略库里新建一页', '  A new page in the Notion guide database'],
  'gtn.unconverted':      ['  ⚠️  {n} 行 Notion 放不下原来的排版,会转为普通段落(文字不会丢失):', '  ⚠️  {n} lines whose formatting Notion cannot hold become ordinary paragraphs (no text is lost):'],
  'gtn.dryRun':           ['\n--dry-run:什么都没写。', '\n--dry-run: nothing was written.'],
  'gtn.confirm':          ['\n搬过去?本地文件会挪进 guides/.migrated/(不删)(y/N)', '\nMove it across? The local file goes into guides/.migrated/ rather than being deleted (y/N) '],
  'gtn.cancelled':        ['取消了。', 'Cancelled.'],
  'gtn.creating':         ['  建好页面,写 {blocks} 个块…', '  Page created, writing {blocks} blocks…'],
  'gtn.filling':          ['  填进已有的空页,写 {blocks} 个块…', '  Filling the existing empty page, writing {blocks} blocks…'],
  'gtn.verifying':        ['  回读逐条核对…', '  Reading back and checking entry by entry…'],
  'gtn.done':             ['\n✅ 搬完了,{n} 个 checkbox 逐条核对一致 → {url}', '\n✅ Moved; all {n} checkboxes matched entry by entry → {url}'],
  'gtn.archived':         ['  本地文件挪到 {path}(没删)', '  The local file was moved to {path} rather than deleted'],
  'gtn.notArchived':      ['  ⚠️  本地文件没挪成,留在原地了 —— 不影响,发现逻辑不会把攻略抢回本地', '  ⚠️  The local file could not be moved and is where it was — harmless, since discovery will not claim the guide back'],

  // ---- restore ----------------------------------------------------------------
  'restore.usage':        ['用法:node tracker.js restore <备份.zip>', 'Usage: node tracker.js restore <backup.zip>'],
  'restore.notFound':     ['找不到 {file}', 'Cannot find {file}'],
  'restore.contents':     ['\n备份内容:', '\nWhat the backup holds:'],
  'restore.madeAt':       ['  备于 {when}{version}', '  Made {when}{version}'],
  'restore.version':      ['(版本 {version})', ' (version {version})'],
  'restore.counts':       ['  {games} 款游戏、{achievements} 条成就、{guides} 条攻略登记', '  {games} games, {achievements} achievements, {guides} registered guides'],
  'restore.noManifest':   ['  (没有清单,可能是手工改过的 zip —— 数据本身还是照读)', '  (no manifest — the zip may have been edited by hand; the data itself is still read)'],
  'restore.guideFiles':   ['  {n} 个攻略文件', '  {n} guide files'],
  'restore.hasConfig':    ['含 config.json(本机密钥会被覆盖)', 'includes config.json (this machine\'s keys will be overwritten)'],
  'restore.noConfig':     ['不含 config.json', 'no config.json'],
  'restore.thisMachine':  ['\n本机现在:', '\nThis machine right now:'],
  'restore.willReplace':  ['  {n} 款游戏 —— **会被替换成备份里的那些**', '  {n} games — **these will be replaced by the ones in the backup**'],
  'restore.keepConfig':   ['  --keep-config:本机密钥保留不动', "  --keep-config: this machine's keys are left alone"],
  'restore.confirm':      ['\n继续?(y/N) ', '\nContinue? (y/N) '],
  'restore.aborted':      ['没动任何东西。', 'Nothing was changed.'],
  'restore.done':         ['\n✅ 恢复完成:', '\n✅ Restore finished:'],
  'restore.table':        ['  {table} → {n} 行', '  {table} → {n} rows'],
  'restore.guideFilesOut': ['  攻略文件 → {n} 个', '  Guide files → {n}'],
  'restore.configOut':    ['  config.json → 已覆盖(密钥来自备份)', '  config.json → overwritten (the keys come from the backup)'],
  'restore.thenSync':     ['\n接着跑 `node tracker.js sync` 用 Steam 的最新数据刷一遍。', '\nNow run `node tracker.js sync` to refresh against Steam.'],

  // ---- ai-check's question stem -----------------------------------------------
  'ac.probeQuestion':     ['游戏《{game}》(appid {appid})的成就「{achievement}」', 'The {achievement} achievement in {game} (appid {appid})'],
  'ac.probeDesc':         [',官方描述是「{description}」', ', whose official description is "{description}"'],

  // ---- guide-gen --------------------------------------------------------------
  'gg.usage':             ['用法:node tracker.js guide-gen <appid> [--dry-run] [--yes] [--local] [--overwrite]\n      只改其中几条:guide-gen <appid> --only <选择器> [--note "要求"]', 'Usage: node tracker.js guide-gen <appid> [--dry-run] [--yes] [--local] [--overwrite]\n       To change only some entries: guide-gen <appid> --only <selector> [--note "what to change"]'],
  'gg.counts':            ['  成就 {n} 个,已解锁 {unlocked} 个', '  {n} achievements, {unlocked} unlocked'],
  'gg.unnameable':        ['  {n} 个成就名在本作里撞车,它们的框会留空(已知)', '  {n} achievement names collide within this game, so their boxes stay empty (known)'],
  'gg.provider':          ['  {name} · 模型 {model} · 最多改 {rounds} 轮', '  {name} · model {model} · up to {rounds} rounds'],
  'gg.notionPage':        ['Notion 页面', 'a Notion page'],
  'gg.localFile':         ['本地文件', 'a local file'],
  'gg.overwriting':       ['\n  ⚠️  覆盖已有攻略({where}:{url})', '\n  ⚠️  Overwriting an existing guide ({where}: {url})'],
  'gg.backupTo':          ['  原文备份到 {dir}', '  The original is backed up to {dir}'],
  'gg.intoExisting':      ['  写进 Notion 已有的空页:{url}', '  Written into an existing empty Notion page: {url}'],
  'gg.intoNew':           ['  在 Notion 攻略库里新建一页(要写本地文件就加 --local)', '  A new page in the Notion guide database (add --local to write a local file instead)'],
  'gg.toDisk':            ['  落盘到 {path}', '  Written to {path}'],
  'gg.noResearch':        ['{name} 没有服务端联网搜索,生成出来的攻略是模型**凭已有知识写的**,不是查来的。\n  这类攻略的步骤、数值、地点都无法核实,而格式校验一个字都验不出来。\n\n  真要这么跑(比如只是想验证流水线本身),加 --no-research 明说:\n', '{name} has no server-side web search, so the guide would be written **from what the model already knows** rather than researched.\n  Its steps, figures and locations cannot be verified, and the format checks verify none of that.\n\n  To run it anyway — to exercise the pipeline itself, say — add --no-research to say so explicitly:\n'],
  'gg.noResearchAlt':     ['  想要经过调研的攻略,换一家有联网的:--provider anthropic 或 --provider gemini。', '  For a researched guide, switch to a provider that has web access: --provider anthropic or --provider gemini.'],
  'gg.noResearchOn':      ['  ⚠️  --no-research:这一份不会经过任何联网调研,内容全靠模型的已有知识', '  ⚠️  --no-research: nothing here is researched online; the content rests entirely on what the model knows'],
  'gg.dryRun':            ['\n--dry-run:不发任何请求。会发过去的 system 提示词:\n', '\n--dry-run: no request is sent. The system prompt that would go out:\n'],
  'gg.confirmOverwrite':  ['\n这一步会联网研究并重写,而且会**覆盖《{game}》现在那份攻略**。继续?(y/N)', '\nThis researches online and rewrites, and it **replaces the guide {game} has now**. Continue? (y/N) '],
  'gg.confirm':           ['\n这一步会联网研究并撰写,通常两到四分钟。继续?(y/N)', '\nThis researches online and writes, usually two to four minutes. Continue? (y/N) '],
  'gg.sharded':           ['  {achievements} 个成就,一次写不完,分 {chunks} 段写', '  {achievements} achievements is more than one pass can write; splitting into {chunks} shards'],
  'gg.regrouping':        ['  正文写完了,再统一一遍分区…', '  The prose is written; now making the sections consistent…'],
  'gg.regrouped':         ['  分区统一好了({sections} 个,归了 {assigned}/{of} 条)', '  Sections settled ({sections} of them, {assigned} of {of} entries placed)'],
  'gg.regroupFailed':     ['  ⚠️  分区统一失败({reason}),保留各段自己分的结果', '  ⚠️  Could not settle the sections ({reason}); keeping what each shard decided'],
  'gg.clustered':         ['  {clusters} 组同类成就散在几个小节里,已合到 {into}(移了 {moved} 条)', '  {clusters} groups of same-kind achievements were scattered across sections; merged into {into} ({moved} entries moved)'],
  'gg.unwrapped':         ['  {n} 处成就本来收在折叠里,已摊开:{titles}', '  {n} places had achievements folded away; unwrapped: {titles}'],
  'gg.unwrapFailed':      ['  ⚠️  {reason},折叠保持原样', '  ⚠️  {reason}; the folds are left as they are'],
  'gg.partialRewrite':    ['  校验没过,第 {round} 轮只重写其中 {chunks}/{of} 段', '  The checks did not pass; round {round} rewrites only {chunks} of {of} shards'],
  'gg.chunkProgress':     [' 已写完 {done}/{chunks} 段', ' {done} of {chunks} shards written'],
  'gg.round':             ['  第 {round}/{rounds} 轮{progress}:联网研究 + 撰写…', '  Round {round} of {rounds}{progress}: researching and writing…'],
  'gg.tool':              ['  第 {round} 轮{label}:{name}…', '  Round {round}{label}: {name}…'],
  'gg.check':             ['  第 {round} 轮:机械打勾 + 校验…', '  Round {round}: mechanical ticking and validation…'],
  'gg.checked':           ['  第 {round} 轮:勾上 {ticked} 个框,还剩 {blocking} 条要改', '  Round {round}: {ticked} boxes ticked, {blocking} findings left to fix'],
  'gg.toNotion':          ['  写进 Notion({blocks} 个块)…', '  Writing to Notion ({blocks} blocks)…'],
  'gg.backingUp':         ['  备份原文…', '  Backing up the original…'],
  'gg.backedUp':          ['  原文已备份:{path}({bytes} 字节)', '  The original is backed up: {path} ({bytes} bytes)'],
  'gg.notionClear':       ['  清掉页面上原来的 {blocks} 个块…', '  Clearing the {blocks} blocks already on the page…'],
  'gg.chunkSplit':        ['  第 {chunk} 段未生成({from} 个成就),拆成两半重问({to} 个)', '  Shard {chunk} produced nothing ({from} achievements); splitting it in half and asking again ({to})'],
  'gg.chunkRetry':        ['  第 {chunk} 段没拿到正文,原样再问一次(第 {attempt}/{of} 次)', '  Shard {chunk} returned no prose; asking again unchanged (attempt {attempt} of {of})'],
  'gg.chunkGaveUp':       ['  ⚠️  第 {chunk} 段({count} 个成就)放弃了,先接着写后面的', '  ⚠️  Shard {chunk} ({count} achievements) was given up on; carrying on with the rest'],
  'gg.done':              ['✅ 写完了,{rounds} 轮 · {secs}s → {url}', '✅ Written in {rounds} rounds · {secs}s → {url}'],
  'gg.diffHeader':        ['\n  覆盖前后对照:', '\n  Before and after:'],
  'gg.backupPath':        ['  原文备份:{path}', '  The original is backed up at {path}'],
  'gg.registered':        ['  已登记({action}),Dashboard 上能看到链接了', '  Registered ({action}); the link is on the Dashboard now'],
  'gg.registeredNew':     ['新增', 'new'],
  'gg.notRegistered':     ['  ⚠️  没登记上。跑一次 `node tracker.js guides` 看为什么', '  ⚠️  It did not register. Run `node tracker.js guides` to see why'],
  'gg.unconverted':       ['  ⚠️  {n} 行排版降级成普通段落,文字没丢:', '  ⚠️  {n} lines were degraded to plain paragraphs; no text was lost:'],
  'gg.failed':            ['❌ {rounds} 轮之后仍有 {n} 条没过,草稿留在 {path}', '❌ After {rounds} rounds {n} findings still stand; the draft is at {path}'],
  'gg.draftInvisible':    ['  (草稿不会被发现逻辑扫到,不会拿去勾框)', '  (a draft is invisible to discovery and is never used to tick boxes)'],
  'gg.chunkMissing':      ['\n  ⚠️  第 {chunk}/{of} 段未生成({count} 个成就:{first} … {last})', '\n  ⚠️  Shard {chunk} of {of} produced nothing ({count} achievements: {first} … {last})'],
  'gg.chunkMissingWhy':   ['      下面那些"缺 checkbox"里,这一段的部分是这个原因,不是模型漏写', '      The "missing checkbox" findings from this shard below have that cause, rather than the model skipping them'],
  'gg.andMore':           ['     …… 另外 {n} 条', '     … and {n} more'],
  'gg.expectedMismatch':  ['  {n} 条"已解锁但没勾"是预期内的:成就名在本作里撞车,勾不上', '  {n} "unlocked but unticked" findings are expected: those achievement names collide within this game and cannot be ticked'],
  'gg.emptyDesc':         ['  ⚠️  {n} 个成就同名、而 Steam 上的描述是空的,自动勾选永远认不出它们:', '  ⚠️  {n} achievements share a name and have no description on Steam, so automatic ticking can never tell them apart:'],
  'gg.andMoreItems':      ['       …… 另外 {n} 个', '       … and {n} more'],
  'gg.emptyDescFine':     ['     攻略本身没问题,这几个框要自己手动勾。', '     The guide itself is fine; those boxes have to be ticked by hand.'],
  'gg.coverage':          ['  覆盖 {covered}/{achievements} 个成就,{warnings} 条 warn', '  {covered} of {achievements} achievements covered, {warnings} warnings'],
  'gg.readItYourself':    ['\n⚠️  只验了格式和数据,内容需要你自己读一遍。', '\n⚠️  Only the format and the data were checked. The content still needs reading.'],
  'gg.notResearched':     ['    这一份没联网,内容是模型凭已有知识写的。', '    This one was not researched online; the content is what the model already knew.'],
  'gg.noSearchIssued':    ['    ⚠️  一次搜索都没发出去,内容等同于凭记忆写的。', '    ⚠️  Not one search was issued, so the content amounts to having been written from memory.'],
  'gg.searched':          ['\n🔎 搜了 {n} 次:{queries}', '\n🔎 {n} searches: {queries}'],

  // ---- guide-gen --only -------------------------------------------------------
  'gp.header':            ['\n《{game}》(appid {appid})· {where}:{url}', '\n{game} (appid {appid}) · {where}: {url}'],
  'gp.selected':          ['\n  按「{selector}」挑中 {n} 条成就:', '\n  "{selector}" selected {n} achievements:'],
  'gp.rarity':            ['  (全球 {pct}%)', '  (globally {pct}%)'],
  'gp.andMore':           ['       …… 还有 {n} 条', '       … and {n} more'],
  'gp.unlocatable':       ['\n  ⚠️  另有 {n} 条点到了、但现有攻略里没有对应的 checkbox,这次改不到:', '\n  ⚠️  Another {n} were named but have no checkbox in the existing guide, so this run cannot touch them:'],
  'gp.unlocatableWhy':    ['       这几条是"攻略里压根没写",要整篇重写(--overwrite)或者自己补一行。', '       Those were never written at all, which needs a full rewrite (--overwrite) or a line added by hand.'],
  'gp.outside':           ['\n  ℹ️  这份攻略本来就有 {n} 条校验问题落在这次范围之外,不会被这次改动碰到,也不会拦路:', '\n  ℹ️  This guide already has {n} findings outside the scope of this run. They are not touched and do not block:'],
  'gp.andMoreFew':        ['       …… 还有 {n} 条', '       … and {n} more'],
  'gp.provider':          ['\n  {name} · 模型 {model} · 最多改 {rounds} 轮', '\n  {name} · model {model} · up to {rounds} rounds'],
  'gp.noResearch':        ['{name} 没有服务端联网搜索,重写出来的内容是模型**凭已有知识写的**,不是查来的。\n  真要这么跑,加 --no-research 明说;想要经过调研的,换一家有联网的(--provider anthropic 或 --provider gemini)。', '{name} has no server-side web search, so the rewritten content would come **from what the model already knows** rather than from research.\n  To run it anyway, add --no-research to say so; for researched content, switch to a provider with web access (--provider anthropic or --provider gemini).'],
  'gp.noResearchOn':      ['  ⚠️  --no-research:这几条不会经过任何联网调研', '  ⚠️  --no-research: none of these entries is researched online'],
  'gp.dryRun':            ['\n--dry-run:不发任何请求。会发过去的那条请求:\n', '\n--dry-run: no request is sent. The request that would go out:\n'],
  'gp.samePrompt':        ['\n(system 提示词和整篇生成是同一份,想看就跑 guide-gen --dry-run)', '\n(the system prompt is the same one a full generation sends; run guide-gen --dry-run to see it)'],
  'gp.confirm':           ['\n这一步会联网研究并重写上面那 {n} 条,其余 {keeping} 个框一字不动。继续?(y/N)', '\nThis researches online and rewrites the {n} entries above; the other {keeping} boxes are left untouched. Continue? (y/N) '],
  'gp.write':             ['  第 {round}/{of} 轮:联网研究 + 重写 {scope} 条…', '  Round {round} of {of}: researching and rewriting {scope} entries…'],
  'gp.rewrite':           ['  第 {round}/{of} 轮:按校验结果再改一次…', '  Round {round} of {of}: another pass against the findings…'],
  'gp.tool':              ['  第 {round} 轮:{name}…', '  Round {round}: {name}…'],
  'gp.retry':             ['  第 {round} 轮没拿到正文,原样再问一次({reason})', '  Round {round} returned no prose; asking again unchanged ({reason})'],
  'gp.missingSome':       [',少了 {n} 条', ', {n} short'],
  'gp.extraSome':         [',多写了 {n} 条(已忽略)', ', {n} extra (ignored)'],
  'gp.returned':          ['  第 {round} 轮:交回 {wrote}/{of} 条{missing}{extra}', '  Round {round}: {wrote} of {of} returned{missing}{extra}'],
  'gp.findings':          ['  第 {round} 轮:这次改动 {caused} 条要改,旧问题 {preExisting} 条(不拦)', '  Round {round}: {caused} findings caused by this change, {preExisting} pre-existing (not blocking)'],
  'gp.notionPatch':       ['  改 Notion 上的「{name}」…', '  Patching "{name}" on Notion…'],
  'gp.notionVerify':      ['  回读整页重新校验…', '  Reading the whole page back and revalidating…'],
  'gp.done':              ['✅ 改完了 {n} 条,{rounds} 轮 · {secs}s → {url}', '✅ {n} entries rewritten in {rounds} rounds · {secs}s → {url}'],
  'gp.keeping':           ['  其余 {n} 个 checkbox 一字没动', '  The other {n} checkboxes are untouched'],
  'gp.failed':            ['❌ {rounds} 轮之后仍没过,**原攻略一个字都没动**', '❌ After {rounds} rounds it still does not pass, and **not one byte of the guide was changed**'],
  'gp.missingList':       ['  这 {n} 条模型没交回来:', '  The model did not return these {n}:'],
  'gp.preExisting':       ['\n  ℹ️  这份攻略还有 {n} 条原有的校验问题(本次未处理,也没拦路):', '\n  ℹ️  This guide has {n} pre-existing findings, untouched by this run and not blocking:'],
  'gp.extraIgnored':      ['\n  ⚠️  模型多写了 {n} 条没要求的成就,**已忽略**(只贴回点名的那几条)', '\n  ⚠️  The model wrote {n} achievements that were not asked for; they are **ignored** (only the named entries are spliced back)'],
  'gp.unresolved':        ['  ⚠️  {n} 条交回来的条目认不出是哪个成就,已忽略', '  ⚠️  {n} returned entries could not be matched to an achievement and were ignored'],
  'gp.notResearched':     ['    这几条没联网,内容是模型凭已有知识写的。', '    These were not researched online; the content is what the model already knew.'],

  // ---- help -------------------------------------------------------------------
  // **One entry for the whole screen, rather than one per line.** The command column is aligned by
  // hand, and alignment is a property of the block: split into forty entries, a translator changing
  // one line has no way to see the column it sits in, and the screen drifts crooked one line at a
  // time. `{configPath}` is the only value that varies
  'help.screen': [
    `
Steam 成就追踪器(本地版)—— 零依赖,不需要 Google 账号

  node tracker.js init                    填 Steam API Key 和 SteamID64(跑一次)
              init --notion               填 Notion token(只有要用攻略同步才需要)
              init --ai                   填 AI 供应商和 key(只有要用攻略生成才需要)
  node tracker.js sync                    全量同步:库 + 成就完成数 + 成就详情
              sync --fast                 只查玩过的 + 轮换复查一批(和 Dashboard 一样)
              sync --library              只检查新游戏
              sync --achievements         只刷成就完成数
              sync --schema               只同步成就详情
  node tracker.js serve [--port 8777]     起本地 Dashboard(数据超过 12 小时会自动后台同步)
  node tracker.js status                  当前数据概览 + AGCR
  node tracker.js export [目录]            三张表导出成 CSV,给表格软件看(默认 exports/,单向,不是备份)
  node tracker.js backup [目录]            打包成一个 zip:数据库 + 攻略 + config.json(默认 backups/)
              backup --no-config          不装 config.json(zip 里就没有明文密钥了)
  node tracker.js restore <文件.zip>       从备份恢复。**会覆盖现有数据**,先问一次
              restore --keep-config       只搬数据,本机的密钥不动
              restore --yes               不问,直接恢复
  node tracker.js guides [--notion|--local|--all]
                                          发现攻略页面并登记进 guides 表
  node tracker.js checkbox-sync [appid]   把 Steam 已解锁成就同步成攻略里的 ✅
              checkbox-sync --dry-run     只算不写,先看会勾掉哪些(Notion 勾选不可撤销)
              checkbox-sync --no-cascade  别联动勾选嵌套的子步骤 checkbox
  node tracker.js guide-status            攻略页状态对齐完成度(打满→Done,掉出100%→Staged)
              guide-status --dry-run      只算不写,先看会改哪些
  node tracker.js audit [appid]           反查有没有勾上了但其实没解锁的 checkbox(只读)
  node tracker.js guide-lint [appid]      校验攻略写法:成就有没有漏、格式对不对(只读)
              guide-lint --checked        连勾选状态一起校验(每款游戏要单独问 Steam,慢)
  node tracker.js guide-to-notion <appid> 把本地 markdown 攻略搬到 Notion(逐条核对后才动本地文件)
              guide-to-notion --dry-run   只预览转换结果,一个字节都不写
  node tracker.js notion-check            Notion 这一侧的体检:token、库、标题属性、状态选项
                                          --fix         缺的状态选项试着补上(会写你的库,补完回读确认)
                                          --probe-write 建一页再立刻归档,验证 integration 真有写权限
  node tracker.js ai-check [appid]        AI 联网研究链路自检(token 用量会打出来)
              ai-check --dry              只组装请求不发送,先看清楚会发什么(不用 key)
              ai-check --models           问 API 这个 key 能用哪些模型(gemini)
              --provider X --model Y      临时换供应商/模型,不改 config.json
              --effort low|medium|high    这一次查多深(默认 high)。low 快得多,省掉的是
                                          那批中等难度成就的内容,最难那几条两边都写得透
                                          (以上三个 ai-check 和 guide-gen 都支持)
  node tracker.js guide-gen <appid>       让 AI 写一份攻略(默认先问一句才开始)
              guide-gen --dry-run         只打印提示词和落盘计划,一个请求都不发
              guide-gen --overwrite       整篇重写(先备份原文,再告诉你会失去什么)
              guide-gen --only <选择器>    **只重写点名的那几条**,其余一字不动。先备份。
                                          rare[:%] 稀有成就(全球解锁率 <10%)· locked 还没打的
                                          section:小节名 · 或者「成就名A,成就名B」直接点
              guide-gen --note "要求"      配 --only 用,比如 --note "把互斥关系写清楚"
              guide-gen --yes             跳过确认;--rounds N 改重写轮数;--file 换文件名
  node tracker.js drafts                  列出 guides/.drafts/ 里堆的草稿(只列不删)
              drafts --clean              清掉;--older-than N 只清 N 天前的
  node tracker.js log [n]                 最近 n 条同步日志

配置:{configPath}(gitignore 里,别提交)
数据:data/steam.db(SQLite,直接 sqlite3 打开也能查)
`,
    `
Steam achievement tracker (local) — zero dependencies, no Google account

  node tracker.js init                    enter a Steam API key and SteamID64 (once)
              init --notion               enter a Notion token (only for guide syncing)
              init --ai                   enter an AI provider and key (only for guide generation)
  node tracker.js sync                    full sync: library + achievement counts + achievement detail
              sync --fast                 only games played, plus a rotating batch (as the Dashboard does)
              sync --library              check for new games only
              sync --achievements         refresh achievement counts only
              sync --schema               sync achievement detail only
  node tracker.js serve [--port 8777]     start the local Dashboard (data over 12h old syncs in the background)
  node tracker.js status                  a summary of the data, plus AGCR
  node tracker.js export [dir]            three tables to CSV for a spreadsheet (default exports/; one-way, not a backup)
  node tracker.js backup [dir]            one zip: database + guides + config.json (default backups/)
              backup --no-config          leave config.json out (no plaintext keys in the zip)
  node tracker.js restore <file.zip>      restore from a backup. **This replaces your data**; it asks first
              restore --keep-config       data only; this machine's keys are left alone
              restore --yes               restore without asking
  node tracker.js guides [--notion|--local|--all]
                                          discover guide pages and register them in the guides table
  node tracker.js checkbox-sync [appid]   tick a guide's ✅ from what Steam says is unlocked
              checkbox-sync --dry-run     work out what would be ticked and write nothing (a Notion tick cannot be undone)
              checkbox-sync --no-cascade  do not cascade ticks onto nested sub-step checkboxes
  node tracker.js guide-status            align guide page status with completion (100% → Done, dropping below → Staged)
              guide-status --dry-run      work out what would change and write nothing
  node tracker.js audit [appid]           find checkboxes ticked for achievements that are not unlocked (read-only)
  node tracker.js guide-lint [appid]      validate how a guide is written: missing achievements, format (read-only)
              guide-lint --checked        check the ticked state too (one Steam request per game, so slow)
  node tracker.js guide-to-notion <appid> move a local markdown guide to Notion (the local file is touched only after a full check)
              guide-to-notion --dry-run   preview the conversion; not one byte is written
  node tracker.js notion-check            check the Notion side: token, database, title property, status options
                                          --fix         try to add the missing status options (writes to your database, then reads back)
                                          --probe-write create a page and archive it, proving the integration really can write
  node tracker.js ai-check [appid]        exercise the AI research chain end to end (token usage is printed)
              ai-check --dry              assemble the request without sending it, to see exactly what would go (no key needed)
              ai-check --models           ask the API which models this key can use (gemini)
              --provider X --model Y      switch provider or model for one run, without touching config.json
              --effort low|medium|high    how deep to research this time (default high). low is far faster, and what
                                          it gives up is the middling achievements; the hardest ones come out
                                          well written either way
                                          (all three work on ai-check and guide-gen alike)
  node tracker.js guide-gen <appid>       have an AI write a guide (it asks before starting)
              guide-gen --dry-run         print the prompt and the landing plan; send no request
              guide-gen --overwrite       rewrite the whole guide (backs the original up, then says what you lose)
              guide-gen --only <selector> **rewrite only the named entries**, leaving the rest untouched. Backs up first.
                                          rare[:%] rare achievements (global unlock rate <10%) · locked for the unearned
                                          section:<heading> · or "Name A,Name B" to name them
              guide-gen --note "what"     goes with --only, e.g. --note "spell out the exclusions"
              guide-gen --yes             skip the confirmation; --rounds N sets the rewrite rounds; --file renames the file
  node tracker.js drafts                  list the drafts piling up in guides/.drafts/ (lists only, deletes nothing)
              drafts --clean              delete them; --older-than N deletes only those older than N days
  node tracker.js log [n]                 the last n sync log entries

Configuration: {configPath} (in .gitignore — do not commit it)
Data: data/steam.db (SQLite; sqlite3 opens it directly)
`,
  ],

  // ---- terminal-only advice, keyed from CLI_HINTS ------------------------------
  // These are the reason this file may carry command lines at all: `lib/` states what happened and
  // stops there, because the same sentence renders verbatim in the Dashboard's floating bar
  'hint.providerModelMismatch': [
    '  要用这个模型:加 --provider {belongsTo}\n'
    + '  要用 {provider}:换成它自己的模型(--model <名字>,或改 config.json 的 ai.model)\n'
    + '  注意环境变量会盖掉 config.json,清掉:\n'
    + '    Remove-Item Env:AI_PROVIDER, Env:AI_MODEL -ErrorAction SilentlyContinue',
    '  To use this model: add --provider {belongsTo}\n'
    + "  To use {provider}: switch to one of its own models (--model <name>, or ai.model in config.json)\n"
    + '  Note that environment variables override config.json. To clear them:\n'
    + '    Remove-Item Env:AI_PROVIDER, Env:AI_MODEL -ErrorAction SilentlyContinue',
  ],
  'hint.tooManyAchievements': [
    '  真要写就调大 config.json 的 ai.maxAchievements(当前 {max},这款要 {count})。',
    '  To write it anyway, raise ai.maxAchievements in config.json (currently {max}; this game needs {count}).',
  ],
  // Every Gemini model-name problem funnels to the same advice: ask the API for the list, then
  // change the model. Three codes share this one entry rather than three copies of it
  'hint.geminiModel': [
    '  换模型:--model <名字>,或者改 config.json 的 ai.model。\n'
    + '  有哪些可用跑 `node tracker.js ai-check --models` —— 但注意列出来 ≠ 能用,\n'
    + '  停售的模型照样出现在那个列表里。',
    '  Change the model: --model <name>, or ai.model in config.json.\n'
    + '  Run `node tracker.js ai-check --models` to see what is available — but listed does not mean\n'
    + '  usable: a retired model still appears in that list.',
  ],
  'hint.gemini429NoDetail': [
    '  换个具体模型试:AI_MODEL=gemini-2.5-flash —— 别用 -latest 别名,\n'
    + '  别名可能解析到一个不在免费层的新模型。',
    '  Try a specific model: AI_MODEL=gemini-2.5-flash — avoid the -latest aliases, which can\n'
    + '  resolve to a newer model that is not on the free tier.',
  ],
  'hint.geminiToolRejected': [
    '  改 config.json 的 ai.geminiTools,默认值是 ["google_search"];去掉 url_context 再试。',
    '  Edit ai.geminiTools in config.json — the default is ["google_search"]; drop url_context and retry.',
  ],
  'hint.badApiKey': [
    '  注意环境变量 {envVar} 会盖掉 config.json,清掉再试:\n'
    + '    Remove-Item Env:{envVar} -ErrorAction SilentlyContinue',
    '  Note that the environment variable {envVar} overrides config.json. Clear it and retry:\n'
    + '    Remove-Item Env:{envVar} -ErrorAction SilentlyContinue',
  ],
  'hint.deepseekLength': [
    '  也可以把 config.json 的 ai.maxTokens 调小(DeepSeek 的上限比另外两家小)。',
    '  You can also lower ai.maxTokens in config.json — DeepSeek\'s ceiling is lower than the other two.',
  ],
  'hint.guideExists': [
    '  要整篇重写加 --overwrite(会先备份,并给出新旧对照)。\n'
    + '  只想改其中几条:--only <选择器>(rare / locked /\n'
    + '  section:小节名 / 成就名或 api_name 的逗号列表),配 --note "要求"。',
    '  To rewrite the whole thing, add --overwrite (it backs up first and shows you old against new).\n'
    + '  To change only some entries: --only <selector> (rare / locked /\n'
    + '  section:<heading> / a comma-separated list of names or api_names), with --note "what to change".',
  ],
  'hint.fileExists': [
    '  覆盖它加 --overwrite,或者用 --file 换个文件名。',
    '  Add --overwrite to replace it, or --file to write under a different name.',
  ],
  // ---- partial rewrite (--only) ----
  'hint.noGuideToPatch': [
    '  --only 是改已有攻略里的几条。这一款还没有攻略,先生成一份:\n'
    + '  去掉 --only 直接跑 guide-gen。',
    '  --only changes entries in a guide that already exists, and this game has none yet.\n'
    + '  Drop --only and run guide-gen to write one.',
  ],
  'hint.unknownAchievements': [
    '  名字要和 Steam 上一字不差(中文名或英文名都行)。同名的成就按名字点不动 ——\n'
    + '  用 api_name 点它,`node tracker.js guide-lint <appid>` 里能看到。',
    '  A name has to match Steam exactly (either language). A duplicate name cannot be selected by\n'
    + '  name — use its api_name, which `node tracker.js guide-lint <appid>` prints.',
  ],
  'hint.emptyScopeResult': [
    '  「{selector}」一条都没选中。放宽阈值试试:--only rare:30,\n'
    + '  或者直接点名:--only "成就名A,成就名B"。',
    '  "{selector}" selected nothing. Try a wider threshold — --only rare:30 —\n'
    + '  or name them outright: --only "Name A,Name B".',
  ],
  'hint.nothingLocatable': [
    '  点名的成就在攻略里都没有对应的 checkbox —— 那是"压根没写",不是"写得不好"。\n'
    + '  这种要整篇重写(--overwrite),局部重写没有可以替换的位置。',
    '  None of the named achievements has a checkbox in the guide — they were never written, rather\n'
    + '  than written badly. That needs a full rewrite (--overwrite); a partial one has nothing to replace.',
  ],
  'hint.noRarity': [
    '  Steam 这次没给出全球解锁率(限流或临时故障),等会儿再试,\n'
    + '  或者换个不依赖它的选择器:--only thin / --only locked。',
    '  Steam did not return global unlock rates this time (rate limiting or a temporary fault). Retry\n'
    + '  shortly, or use a selector that does not need them: --only thin / --only locked.',
  ],
  'hint.sectionNeedsLocal': [
    '  命令行这条路按小节挑需要本地攻略全文。\n'
    + '  Notion 上的攻略要按小节挑,去 Dashboard 点 ♻ 重写 →「自选…」——\n'
    + '  那边读的是整页的块,小节结构在(点小节标题就是整节选中)。',
    '  Selecting by section from the command line needs the full text of a local guide.\n'
    + '  For a guide on Notion, use the Dashboard: ♻ Rewrite → "Choose…" — that path reads the page\'s\n'
    + '  blocks, so the section structure is there and clicking a heading selects the whole section.',
  ],
  'hint.badScope': [
    '  选择器的写法:rare[:百分比] / locked / section:小节名。',
    '  Selector syntax: rare[:percentage] / locked / section:<heading>.',
  ],
  // Nothing at all after `--only`. **Kept separate from badScope**: that one is a wrong spelling,
  // this one is nothing written — the former needs the spelling corrected, the latter needs to know
  // which spellings exist in the first place
  'hint.emptyScope': [
    '  --only 后面要跟选择器:rare[:百分比] 稀有成就(全球解锁率 <10%)/\n'
    + '  locked 还没打的 / section:小节名,或者「成就名A,成就名B」直接点名。\n'
    + '  想整篇重写的话用 --overwrite,不要 --only。',
    '  --only takes a selector: rare[:percentage] for rare achievements (global unlock rate <10%),\n'
    + '  locked for the ones not yet earned, section:<heading>, or "Name A,Name B" to name them.\n'
    + '  To rewrite the whole guide use --overwrite rather than --only.',
  ],
  'hint.chunkTooSmall': [
    '  别急着调大 ai.maxTokens —— 它是 thinking + 正文的总额,而一段只剩 {size} 个成就\n'
    + '  还写不完,说明吃掉额度的是思考,调大只会让它想得更久(CLAUDE.md 有实测)。\n'
    + '  能压住思考的只有官方端点(ai.anthropicExtras 那几个参数兼容端点不收)。',
    '  Do not reach for a larger ai.maxTokens — it is the budget for thinking **plus** prose, and a\n'
    + '  shard down to {size} achievements still cannot finish, which means thinking is eating the\n'
    + '  budget and raising it only buys more thinking (measured; see CLAUDE.md).\n'
    + '  Only the official endpoint can hold thinking down (a compatible endpoint ignores the\n'
    + '  ai.anthropicExtras parameters).',
  ],
};
