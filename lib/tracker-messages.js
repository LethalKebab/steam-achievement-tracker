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
