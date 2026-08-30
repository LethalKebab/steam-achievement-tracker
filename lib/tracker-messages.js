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
