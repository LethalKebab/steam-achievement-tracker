/**
 * AI guide generation — orchestration
 * ------------------------------------------------
 * One pipeline: fetch achievement data → have the model research online and write → **mechanical
 * ticking** → hand it to the validator → feed the specific errors back and rewrite if it does not
 * pass (at most 3 rounds) → land it. Design and trade-offs: docs/ai-guide-writing.md.
 *
 * `lib/ai.js` handles how to talk to a provider; this file handles what to say and whether to
 * believe what comes back.
 *
 * **What this layer guarantees is "the format and the data are definitely right", not "the guide is
 * right".** Whether a step works, whether the difficulty is accurate, whether "easily missed" is
 * actually true — a machine can verify none of it, and that is the entire value of a guide. The
 * caller (the CLI, and later the Dashboard entry point) has to tell the user honestly that the
 * content is unverified.
 *
 * Three things are guaranteed **structurally**, not by checking:
 *
 * 1. **Tick state**. The model only ever writes `- [ ]`, and `computeCheckedKeys` fills it in from
 *    the database afterwards. So "ticks must equal the real achieved state" goes from a rule to be
 *    checked to a fact that cannot be violated. Unlock state is also **not fed to the model** —
 *    a corollary of the above, and closer to SKILL.md rule 3.1: a guide is a record of "how it was
 *    beaten", not a list of "what is left to do".
 * 2. **The `# 游戏名` and `appid:` lines are written by the program**, never by the model. Those two
 *    lines are pure data already in the database; having the model transcribe them is one extra
 *    chance to get them wrong out of nothing, and a wrong appid registers the guide against
 *    **a different game**.
 * 3. **Drafts never land in the `guides/` root**. `syncGuidesFromMarkdown` registers any `.md`
 *    carrying an `appid:` line into the guides table, and `checkbox-sync` then takes an unvalidated
 *    guide and ticks the user's boxes with it. Drafts always go into `guides/.drafts/` — that
 *    discovery logic is a non-recursive `readdirSync` that only accepts `.md`, so a subdirectory
 *    never enters its field of view (verified against the source, not assumed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { achievementsFor, getGame, getGuide, getGuideProse, setGuideProse, setGuideLang } from './db.js';
import { normalizeUiLanguage, achievementName } from './lang.js';
import { clusterConstraint, mergeSplitClusters, sameKindClusters } from './guidecluster.js';
import { lintGuide, computeCheckedKeys, unnameableApiNames } from './guidelint.js';
import {
  loadTodos, applyChecks, resolveGuidePath, parseTodos, todoSpansWithToggles, detailsBlockEnd,
} from './markdown.js';
import { syncGuidesFromMarkdown, syncGuidesFromNotion, resolveTodoToAchievement } from './guides.js';
import {
  markdownToBlocks, partitionForOverwrite, richTextText, sectionIntros,
} from './notionblocks.js';
import { planNotionTarget, newGuideStatus, fillMissingIcon, extractNotionPageId } from './notion.js';
import { fetchGameIcon, sleep } from './steam.js';
import { createSession, checkResult, addUsage, emptyUsage } from './ai.js';
import { backupGuide } from './guidebackup.js';
import { RARE_PCT } from './guidescope.js';
// Fetches the achievement detail on the spot when it is missing. **Uses the same fetch as the bulk
// sync** — see the comment on fetchGameSchema
import { fetchGameSchema } from './sync.js';
import { msg, msgError, achName } from './messages.js';

/** The drafts directory. Under guidesDir so it is easy to find, but out of discovery's reach (non-recursive) */
export const DRAFTS_DIR = '.drafts';

/**
 * Which validation problems **can be blamed on the model**.
 *
 * `checked-mismatch` is not in here, and must not be: the model is not allowed to write checkbox
 * state at all, so feeding this one back asks it to do the very thing we forbid, and it will simply
 * start writing `- [x]`.
 *
 * `ambiguous-empty-description` is likewise not in here: the description on Steam is empty, so there
 * is no string to copy, and feeding it back is asking it to copy something that does not exist.
 * Whereas `ambiguous-no-description` (the description exists, it just was not copied) **is** in
 * here — a rewrite really does solve that one. **These two must be two separate codes**: sharing one
 * would put the unfixable kind through three rounds of rewriting and then throw away a complete
 * guide (see the comment in lib/guidelint.js).
 */
export const MODEL_FIXABLE = new Set([
  'missing-checkbox',
  'merged-line',
  'ambiguous-no-description',
  'paraphrased-description',
  'stats-in-heading',
  'data-source-note',
  'missing-title',
]);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * How each rule in `.claude/skills/achievement-guide-writing/SKILL.md` is handled in the generator.
 *
 * **Why this table is needed:** the rule text below is a **hand-copied summary** of SKILL.md (about a
 * quarter of its bulk), not the full text. The full text cannot be sent as-is — it has whole
 * sections about writing to Notion, about screenshots, about delegating to sub-agents, and 8.0 even
 * states outright that "a new guide defaults to being created in Notion", so sending it would
 * actively mislead the model.
 *
 * But hand-copying drifts: SKILL.md changes, the prompt does not follow, and nothing raises a flag.
 * There are now **three** copies to keep in step — SKILL.md, the Chinese prompt and the English one
 * — so this table answers "does the rule reach the prompt at all", and the shared-wording table in
 * `guidegen.test.js` answers "do the three say the same thing".
 * CLAUDE.md records that this project has already been bitten by exactly that once (a secret sat
 * hardcoded in a public repo for months while three docs said it was read from config). So this
 * table plus the test in `test/guidegen.test.js` turns "silent drift" into "changing SKILL.md makes
 * a test fail".
 *
 * **After changing SKILL.md, either add the new rule to `RULES` or state here why it was not added.**
 */
export const SKILL_RULE_DISPOSITION = {
  'rule-1': '进了 —— 一个成就一行 checkbox、子步骤嵌套的三个条件、重名抄描述。分组标签**按后端分岔**(见 groupLabelRule),是提示词里唯一一处。「写后验证」由程序做',
  'rule-2': '**部分** —— 截图整块没进(模型给不出可靠的游戏内截图,而且它看不见图,没法核对贴的对不对);「贴不了截图的时候」那一节**进了**,细则见下面的子节',
  'rule-3': '伞形标题,细则见 3.1–3.5',
  '3.1': '进了 —— 三段式、描述照抄、详略取舍、五种附加标注的固定写法',
  '3.2': '进了 —— 消化重写不照搬、B站 BV 号、极少数保留英文原句',
  '3.3': '**没进** —— 补充1/补充2 是给「回头补充已有攻略」用的,生成器每次写全新一份',
  '3.4': '**没进** —— 子页面和 Notion 内嵌数据库都属于 Notion 后端,是第二阶段',
  '3.5': '进了 —— 成就列表前的机制速查',
  'rule-4': '伞形标题,细则见 4.1–4.4',
  '4.1': '**部分** —— `# 游戏名` 和 `appid:` 由程序写,所以反过来要求模型**别写**',
  '4.2': '进了 —— 按游戏自身分类分节、节标题不带统计数字',
  '4.3': '进了 —— 写完就停',
  '4.4': '进了 —— DLC 当普通一节,不写"暂无中文翻译"那种括号注释',
  'rule-5': '进了 —— <details> 折叠(带 10 行下限、成就本身不进折叠)、表格取舍。删除线没进(生成新攻略用不上)',
  'rule-6': '进了 —— 中英文混用',
  'rule-7': '进了 —— 不写数据来源',
  'rule-8': '伞形标题,细则见 8.0–8.4',
  '8.0': '**没进** —— 后端选择是程序的事(Notion 连着就默认落 Notion,本地 md 要显式指定),而且提示词全篇不提"写去哪":模型交回来的永远是 markdown,落哪个后端是之后的事',
  '8.1': '**没进** —— 取成就数据和解锁状态由程序做。解锁状态**刻意不喂给模型**',
  '8.2': '进了精神 —— "按游戏自身的成就分类分节"',
  '8.3': '进了精神 —— 在「怎么查资料」那节。具体的抓取手法(get_page_text 之类)是我们这边的工具,模型用的是服务端搜索',
  '8.4': '**部分进了** —— 委托子 agent 没进(那是会话层的做法)。分片进了:超过 ai.chunkSize 就分几段写,拼起来再整体校验。**RULES 里不提分片**(它逐字不变,是缓存前缀);分几段、这是第几段由 buildChunkMessage 逐段告诉模型',
  'rule-9': '伞形标题,细则见 9.1–9.3',
  '9.1': '**没进** —— notion-update-page 的命令选择。写 Notion 是 landToNotion 的事,模型只交 markdown',
  '9.2': '**没进** —— Notion 大内容分批写',
  '9.3': '**没进** —— 写完回读验证。程序落盘后会自己重新读一遍再校验一次',
  // ---- Subsections without a number of their own ------------------------
  // **Every `##` and `###` in SKILL.md carries a bracketed id, and that id is the key here.** A
  // subsection with no id is invisible to the guard, and the disposition table then stays silent
  // about a section that may well have gone into the prompt while its parent rule's entry says the
  // rule did not — which is how rule-2's conclusion once changed with nobody noticing.
  'rule-1/notes-lines': '进了 —— 前置/步骤/警告分行写,判据是「有没有把两类东西挤进一行」,不是字数',
  'rule-1/sub-labels': '进了 —— 但**按后端分岔**(见 groupLabelRule),是整份提示词里唯一一处分岔',
  'rule-1/nesting': '进了 —— 嵌套的三个条件(有身份、写得出做法、都要做)逐字同口径,测试钉着',
  'rule-1/duplicate-names': '进了 —— 硬规则 5:清单里标了 ⚠️ 同名 的,描述原文必须抄进去',
  'rule-1/verify': '**没进** —— 程序做:落盘后重新读一遍再过一次校验器,不指望模型自查',
  'rule-2/worth-shots': '**没进** —— 模型给不出可靠的游戏内截图,而且它看不见图,没法核对贴的对不对',
  'rule-2/video-instead': '**进了** —— 位置写不出来时给带时间点的视频链接,并点名挡掉「留意角落」那类万能话。**rule-2 整条是「没进」,唯独这一节是例外** —— 父规则的结论不覆盖子节,两者要分开读',
  'rule-2/no-shots': '**没进** —— 根本不贴图,这一节没有约束对象',
  'rule-2/source-images': '**没进** —— 同上。「跟着配等价的图」对一个贴不了图的写手是空话',
  'rule-5/tables': '进了 —— 列数多、纯文字对不齐的可以用 <table>,能用 checkbox 列表说清的优先用列表',
  'rule-5/strikethrough': '**没进** —— 删除线是改已有攻略时用的,生成器每次写全新一份',
  'rule-10': '进了要点 —— 自检清单里对生成有约束的几条(尤其"不写推测/待确认/暂无中文翻译")。其余是给人复核用的',
};

/**
 * The rules section. **Placed at the very front of the system prompt and byte-identical every
 * time** — feedback rewriting runs up to 3 rounds and resends this whole block each round, hitting
 * the prefix cache at 0.1× the price. So absolutely nothing like a timestamp or a random number may
 * be inserted here: the cache matches on prefix, and changing one byte at the front invalidates
 * everything after it.
 *
 * How it maps to SKILL.md: see `SKILL_RULE_DISPOSITION` above.
 */
// The prompt as a whole never says "where to write this" — what the model hands back is always
// markdown, and whether it lands in Notion or locally is a **later** question (see landToNotion), so
// almost no rule should branch per backend; saying "a local guide" would make it write from a
// premise that no longer holds. **The one exception is the group label** (`groupLabelRule`): that
// rule genuinely works differently on the two backends, and `plan.target` / `kind` are settled
// before generation starts, so it alone is given per backend.

/**
 * How to write group labels, **the one rule in the prompt that branches per backend**.
 *
 * Both sides demand "the label gets its own line, do not repeat it in front of every entry"; the
 * disagreement is only about what carries the label:
 *
 * - **Notion**: `fetchAllToDoBlocks` treats toggle / column as transparent containers and passes
 *   `parent` straight through, so a child checkbox inside a toggle still belongs to that
 *   achievement. The label can be carried by `<summary>`, and the 「注意」 group can even drop to a
 *   plain bullet — a warning is not a task and cannot be ticked off, and once they are bullets they
 *   are no longer `to_do` blocks, so `--cascade` cannot tick a run of warnings into false records.
 * - **Local md**: `todoSpans` delimits which lines an achievement occupies by "consecutive, more
 *   deeply indented checkbox lines", and a single non-checkbox line in between (a plain bullet, a
 *   `<details>`, a section note all count) truncates the range on the spot — so a partial rewrite
 *   pastes the new one on while the old stays where it was, producing a duplicate. So at this level
 *   only checkbox labels work.
 *
 * **When `target` does not reach here it falls back to the local version**, not the Notion one: a
 * toggle written into local md silently truncates a range, while a checkbox label written into
 * Notion is merely a bit ugly. The costs of guessing wrong are not symmetric, so the default has to
 * be the survivable one.
 */
function groupLabelRule(target, lang) {
  if (lang === 'en') return groupLabelRuleEn(target);
  const head = `- **分组的标签单独占一行,不要在每一条前面重复。** 十四条各写一遍「前置:」「步骤:」,
  同一个词出现十四次,而它要说的事只有两件。分组这么写:`;
  const tail = '  分组只在**条目多到要分**的时候用;五六条以内直接平铺,不用套一层';
  if (target === 'notion') {
    return `${head}
      - [ ] **创造**<br>官方描述<br>心得……
        <details>
        <summary>**前置** — 开局前先备齐</summary>
        - [ ] 命运商店花 40 点数买「神之侧身像」
        - [ ] 玛希尔两次「项目投资」完成后入队
        </details>
        <details>
        <summary>**注意** — 走岔就掉别的结局</summary>
        - 魔力熔炉别放人,放追随者会被直接烧死
        </details>
  **标签行本身不要写成 checkbox**,用 \`<details><summary>\` 承载 —— 「前置」不是一件
  能做完的事,勾它没有意义。**「注意」那一组的条目也不要用 checkbox**:警告是出问题时
  回头查的参考,不是任务,永远勾不掉,只会把这条成就的进度永久压低几格。
${tail}`;
  }
  return `${head}
      - [ ] **前置**
        - [ ] 命运商店花 40 点数买「神之侧身像」
        - [ ] 玛希尔两次「项目投资」完成后入队
      - [ ] **步骤**
        - [ ] 寻思龙眼宝石,选「研究一下它能做什么」
        - [ ] 魔力熔炉放入龙眼宝石+玛希尔+一瓶乙太
  **标签行必须也是 \`- [ ]\`,不能写成普通 bullet(\`- 前置:\`)。** 这是硬性的:
  局部重写按「连续的、更深缩进的 checkbox 行」圈定一条成就占哪几行,中间夹一行
  非 checkbox 会把范围当场截断 —— 重写完新的贴上去、旧的那几行还留在原地,变成重复。
${tail}`;
}

/** The same rule, in English. Only the prose differs — the two branches on `target` are identical */
function groupLabelRuleEn(target) {
  const head = `- **A group's label goes on its own line; do not repeat it in front of every entry.**
  Writing "Prerequisite:" and "Steps:" onto fourteen lines puts one word on screen fourteen times to
  say two things. Group them like this:`;
  const tail = '  Group only when there are **enough entries to need grouping**; five or six go flat, with no extra layer';
  if (target === 'notion') {
    return `${head}
      - [ ] **Creation**<br>the official description<br>your notes…
        <details>
        <summary>**Prerequisite** — have these before you start</summary>
        - [ ] Buy the Divine Profile from the Fate shop for 40 points
        - [ ] Recruit Mahir after her two Project Investments finish
        </details>
        <details>
        <summary>**Careful** — take the wrong turn and you get a different ending</summary>
        - Do not put anyone in the mana furnace; a follower placed there burns outright
        </details>
  **The label line itself is not a checkbox** — carry it on \`<details><summary>\`. "Prerequisite" is
  not a thing that can be finished, so ticking it means nothing. **Entries under "Careful" are not
  checkboxes either**: a warning is something you come back to when things go wrong, not a task, so
  it can never be ticked off and only holds this achievement's progress down for good.
${tail}`;
  }
  return `${head}
      - [ ] **Prerequisite**
        - [ ] Buy the Divine Profile from the Fate shop for 40 points
        - [ ] Recruit Mahir after her two Project Investments finish
      - [ ] **Steps**
        - [ ] Examine the dragon-eye gem, pick "look into what it can do"
        - [ ] Put the dragon-eye gem, Mahir and a flask of aether into the mana furnace
  **The label line has to be a \`- [ ]\` too — never a plain bullet (\`- Prerequisite:\`).** This one is
  hard: a partial rewrite decides which lines an achievement occupies by taking the run of
  consecutive, more deeply indented checkbox lines, and one non-checkbox line in the middle cuts that
  range short — the rewritten entry is pasted in while the old lines stay where they were, as a
  duplicate.
${tail}`;
}

/**
 * The `##` sections of the rules block, paired across the two languages **in the order they appear**.
 *
 * This is the parity check, and it exists because the alternative was two free-form prompts. Rule
 * text cannot be shared — a translation is a different string all the way down — so what is shared
 * is the *shape*: `guidegen.test.js` walks this table and requires each prompt to carry its own half,
 * in this order, with no `##` heading left off the table in either language. A section that gets
 * added to one language and forgotten in the other is then a failing test rather than an English
 * guide quietly written to a shorter rule set.
 *
 * It pins the **sections**, not the numbered rules inside them; that split is deliberate. Section
 * headings are structural and stay put, while the rules within one are reworded and reordered
 * constantly, and a table pinned that finely would be edited to match the code every time instead of
 * catching anything.
 */
export const PROMPT_SECTIONS = [
  ['## 输出什么', '## What to output'],
  ['## 硬规则(机器逐条检查)', '## Hard rules (checked one by one by machine)'],
  ['## 写法', '## How to write it'],
  ['## 标注用固定写法(不要自创)', '## Fixed notations (do not invent your own)'],
  ['## 不要写文档化的备注', '## No documentation-style asides'],
];

const rulesFor = (target, lang) => (lang === 'en' ? rulesEnFor(target) : `你在为一个 Steam 成就追踪工具写一份 **markdown 攻略**。下面的规则来自这个项目积累的写法规范,写完机器会逐条校验,不满足会被打回重写。

## 输出什么

只输出攻略正文的 markdown,整份放在一个 \`\`\`markdown 围栏里。不要写开场白、不要写结语、不要解释你做了什么。

**不要写大标题行,也不要写 appid 行**——那两行由程序按数据库填。你从第一个小节标题开始写。

## 硬规则(机器逐条检查)

1. **每个成就单独占一行 checkbox**,格式是 \`- [ ] **成就名**<br>官方描述<br>你的攻略心得\`
   - 一行只能有一个 checkbox。写成 \`- [ ] A / [ ] B\` 的话,第二个不会渲染成真 checkbox,同步脚本永远找不到它
   - 不能把一组成就写成一段纯文字总结。哪怕那组成就再无聊,也要一个成就一行
   - **下面清单里的每一个成就都必须出现,一个都不能少**。这是最常见的打回原因
2. **一律写 \`- [ ]\`,永远不要写 \`- [x]\`**。勾选状态由程序按 Steam 的真实解锁数据填,你写什么都会被覆盖。你也拿不到解锁状态,这是刻意的:攻略是"这游戏怎么打"的记录,不是"还剩什么没做"的清单
3. **粗体成就名必须和清单里的名字一字不差**。不要加后缀、不要改写、不要翻译、不要把两个成就名合并。同步是按"成就名精确等于某个候选片段"匹配的,改一个标点就永远勾不上
4. **官方描述原文照抄**,跟在成就名后面用 \`<br>\` 隔开。改写过的描述会让审计反查不到这个框。想补充说明、写心得,写在第三段,别动第二段
   - **清单里写着「(Steam 上是空的)」的,把那一段整个跳过**,写成 \`- [ ] **成就名**<br>你的攻略心得\`。不要留一个空的 \`<br><br>\`——那在页面上是一行突兀的空白。隐藏成就在 Steam 上一律没有描述,所以这种情况很常见
5. 清单里标了 **⚠️ 同名** 的成就,描述原文**必须**抄进去——同一个游戏里有另一个成就叫一模一样的名字,描述是唯一能把它们区分开的东西
6. 节标题里不要写"共 N 个""M 项未完成"这类统计数字,会随进度过期而且没人会去更新
7. 不要在攻略里写数据来源(例如"勾选状态来自 Steam 真实解锁数据")
8. 写完最后一个成就就停。不要"总结"、不要"参考来源"、不要"这份攻略还不完整"

## 写法

- 分节按**游戏自身的成就分类**走(主线 / 支线 / 收集 / 战斗 / 杂项),跟着游戏本身的分法
- **同一类事必须在同一个小节里。** 判据看**官方描述**,不看是怎么解锁的:四条
  「将吉祥物替换为 X」就是一类,哪怕其中两个要在商店买、另外两个是彩蛋 —— 按解锁
  途径拆开,读的人就得在两个小节之间来回找同一件事。同理:「解锁全部 X」这一组、
  同一个东西的 100/500/1000 三档,都各自成一组,不要散开
- **子 checkbox 默认不写。** 嵌套是例外,下面三条**同时**成立才嵌套:
  1. **每一条都有自己的身份** —— 一个神庙名、一份配方、一条支线任务名、一处收集品位置,
     是要去找、去查、去认的**具体东西**。**序号不是身份**:\`第1天\`/\`第2天\`、\`第1关\`/\`第2关\`、
     \`1/10\`、\`步骤一\`/\`步骤二\` 只是把一个数字拆开写,一条信息都没多
  2. **这一行除了「第几个」之外写得出做法。** 判据**不是游戏有没有计数器** —— 计数器只
     告诉用户「还差几个」,从不告诉他「缺的那个怎么拿」,而后者正是攻略的全部价值。
     所以:\`第1天\`…\`第7天\` 写不出任何做法,不嵌套;百科全书三十个词条各有各的入手方式,
     **嵌套**,每一行就写那个词条怎么拿。十件收集品掉落方式完全一样的也不嵌套 ——
     那十行写的是同一句话
  3. **每一条都要做**,不是任选其一。如果那几条是**互相替代**的选项(比如"达成任一结局"
     下面列了九个结局、"用任意职业通关"下面列了五个职业),**不要嵌套**,平铺写在心得那一段里。
     嵌套的语义是"父成就解锁 ⇒ 下面每一条都做过了",互斥选项放进去会变成八条假记录
- 三条都满足的时候**就要**嵌套(120 个神庙、20 份配方、5 条支线各占一行),别写成一段纯文字
  ——那种情况下用户确实要一条一条勾掉
- **要跨好几个阶段才能拿到的成就,把流程本身写成子 checkbox。** 上面三条对"长流程"
  一样成立:每一步是一个**具体动作**(在哪个仪式里放什么、去哪触发哪个事件),
  写得出做法,而且每一步都要做。别把嵌套只当成收集品的写法 —— 用户是一个周目里
  分好几次做完的,他要能一步一步勾掉。**三步以内的写在心得里就够,不用拆**
${groupLabelRule(target)}
- **一句自检:把那几行删掉,这份攻略少了什么信息吗?** 少不了就不要写。
  "玩满 7 天"下面挂 \`第1天\`…\`第7天\`,是这条规则最常见、也最没价值的违反方式。
  **三条拿不准的时候以这一句为准** —— 前两条想测的就是"这几行有没有信息",
  而这一句直接问了出来。反过来也成立:删掉之后攻略就说不清怎么拿了,那就是该嵌套
- 纯剧情推进自动解锁的成就:只写名字和官方描述就够了
- 有坑、有技巧、容易错过的成就:详细写前置条件、关键选择节点、容易翻车的地方。**这是攻略最有价值的部分**,别省
- **前置、步骤、警告分行写,不要挤成一段。** \`<br>\` 在 checkbox 里就是换行,拿它把不同性质的
  东西拆开:前置/材料清单单独一行、开头写「前置:」;步骤超过三步就**一步一行**;
  会导致失败或走岔路的单独一行、开头写「注意:」。
  **判据是"这一行里混没混进两种性质的东西",不是字数** —— 六百字挤成一段的时候,
  内容再对,读的人也分不出哪句是准备、哪句是操作、哪句是雷。写完自己看一眼:
  **能不能一眼指出哪几句是前置、哪几句是步骤?** 指不出来就是还没分行
- 很长的清单(全结局对照、全收集品)用 \`<details><summary>\` 折叠起来。**下限:这块内容到了 10 行,或者比它所属那条成就的正文还长,才折** —— 不到就直接摊开,折叠本身是一层要点开的成本,三五行的表折起来只是把信息藏了。列数多、纯文字对不齐的可以用 HTML \`<table>\`,但能用 checkbox 列表说清楚的优先用列表
  - **折叠块里可以直接放嵌套的 checkbox 列表。长不是"不列"的理由,只是"折起来"的理由** ——
    三十个词条各有各的入手方式,写成一段"随剧情推进逐步录入"的话,等于一条信息都没给
  - **但成就本身那一行永远不进折叠。** 折叠装的是某一条成就底下的辅料(子步骤、
    对照表、收集品清单),不是成就列表。把一节的成就打包折起来,那一节点开是空的
- 游戏有官方中文就用中文成就名,没有就保留英文原名;Boss、Build、DLC、NPC 这类术语不强行翻译
- **DLC 成就当游戏的普通一节处理**,不要写成 \`DLC: XXX(3个成就,暂无中文翻译)\` 这种带括号注释的格式。没有中文名就直接用英文名
- 游戏有需要反复查阅的操作说明(调酒配方、职业解锁条件这类),可以在成就列表**前面**写一小段机制速查。这是功能性速查,不是文档包装
- **位置类成就:写不出具体位置时,给带时间点的视频链接,不要用万能话凑数。**
  找物/解谜这类游戏里,「30 朵蘑菇散落在场景各处」是没法用文字逐个说清的,
  而 「留意角落」「注意被遮挡的」放到哪一关都成立 —— 等于没写。这种时候给
  「对照 B站 BVxxxxxx 的 5-2 段落(01:56)」,读的人能直接看到那一屏。
  **时间点是关键**,只给一个视频号等于让人自己从头翻。
- 收集品类的可以贴 B站 BV 号或链接。极少数情况(某个判定条件的英文原文特别精确、翻译容易走样)可以保留英文原句,但要简短、前面加中文说明上下文
- 不要贴图片

## 标注用固定写法(不要自创)

- **位置**:涉及特定地图位置的,在条目开头标 \`位置 XXX\`
- **前置条件**:需要特定背景/技能/perk 的,用 \`※需要有背景X\`
- **互斥**:和别的成就冲突的,用 \`<span underline="true">如果进行此动作则无法获得X成就。</span>\`
- **易错过**:**过了某个节点会永久错过**的才标 \`易错过!!\`。季节性、每年一次这种"等下一轮还能拿"的**不要标** —— 那是假警报,标多了这个记号就没人看了
- **DLC 排除**:成就不含 DLC 内容的,标 \`※除去追加内容\`
- **剧透**:会毁掉第一次游玩体验的内容(结局、反转、某个角色的真实身份、隐藏成就到底要做的那件事),
  不要直接写进心得,挂一个折叠块在这条成就下面:
      - [ ] **成就名**<br>官方描述<br>不剧透的那半做法
        <details>
        <summary>剧透</summary>
        具体内容写在这里,写成段落
        </details>
  - **\`<summary>\` 里只写「剧透」两个字。** 这个标签是读的人不点开也会看到的东西,
    写成「剧透:凶手是医生」等于没折
  - **上面那行 checkbox 要把上下文交代清楚**,让人不点开也知道折叠里是哪一类东西、值不值得点
  - **折叠块必须紧跟在成就那一行后面、缩进更深,中间不能空行。** 隔开之后程序认不出它属于
    哪条成就,局部重写会把它落在原地
  - **折叠里写段落,不要放 checkbox。** 折叠里的 checkbox 会当成子步骤处理,父成就一解锁就
    连带勾上,变成一条假记录
  - **这一条不受上面那个「10 行」下限的约束** —— 它折起来的理由是内容剧透,不是内容长
  - **要少。** 真实攻略站上,一份叙事向游戏的攻略通常总共只有 0 到 2 处剧透遮挡。不要给每个
    隐藏成就都挂一个 —— 遮多了读的人会养成习惯全部点开,这个记号就作废了

## 不要写文档化的备注

**攻略里不出现"推测"、"待确认"、"暂无中文翻译"、"此处存疑"这类话。** 不确定的东西有两个处理办法:要么查清楚再写,要么不写。把不确定性写进正文,读的人既不能照做、也不知道该信几分。

`);

/**
 * The English rules.
 *
 * **Four rules genuinely differ; everything else is the same rule in another language.** The four:
 * the guide is written in English, the achievement name preferred is the official English one, the
 * pair of rules about missing Chinese localisation have nothing to say here and are gone, and a
 * citation follows whatever source was actually read rather than naming Bilibili by default.
 *
 * The research strategy is **not** one of them — the sources were already Chinese-first rather than
 * Chinese-only, and for a Chinese-developed game the best guide really is on NGA or Bilibili. The
 * model can read that and write English from it; dropping those sites would make English guides
 * worst exactly where guides are hardest to find.
 */
const rulesEnFor = (target) => `You are writing a **markdown guide** for a Steam achievement tracker. The rules below come from the conventions this project has accumulated. When you are done a machine checks the guide rule by rule, and anything that does not hold is sent back to be rewritten.

## What to output

Output the guide's markdown body only, the whole thing inside one \`\`\`markdown fence. No preamble, no closing remarks, no explanation of what you did.

**Write it in English.** The entries, the section headings and your own notes are all English. Official achievement names are the exception and are covered by rule 3.

**Do not write a top-level heading, and do not write an appid line** — the program fills both in from the database. Start at your first section heading.

## Hard rules (checked one by one by machine)

1. **Every achievement gets its own checkbox line**, in the form \`- [ ] **Achievement Name**<br>official description<br>your notes\`
   - One checkbox per line. Written as \`- [ ] A / [ ] B\`, the second one does not render as a real checkbox and the sync will never find it
   - Do not summarise a group of achievements as a paragraph of prose. However dull the group, it is still one line per achievement
   - **Every achievement in the list below has to appear, without exception.** This is the most common reason a guide is sent back
2. **Always write \`- [ ]\`, never \`- [x]\`**. Ticked state is filled in by the program from Steam's real unlock data, and anything you write is overwritten. You are also not given the unlock state, which is deliberate: a guide is a record of how the game is played, not a list of what is left to do
3. **The bold achievement name must match the list below exactly.** No suffixes, no rewording, no translating, no merging two names into one. The sync matches on "the achievement name is exactly equal to one of the extracted candidates", so a single changed punctuation mark means it never ticks
   - **The list gives the official English name first where the game has one.** Use it verbatim. Where a game only ships a Chinese name, keep that name as it stands rather than translating it — a translated name matches nothing
4. **Copy the official description verbatim**, after the name and separated by \`<br>\`. A reworded description leaves the audit unable to trace the checkbox back. Put anything you want to add in the third part; leave the second alone
   - **Where the list says "(empty on Steam)", skip that part entirely** and write \`- [ ] **Achievement Name**<br>your notes\`. Do not leave an empty \`<br><br>\` — on the page that is a jarring blank line. Hidden achievements never have a description on Steam, so this comes up often
5. An achievement marked **⚠️ duplicate name** in the list **must** have its description copied in — another achievement in the same game carries exactly the same name, and the description is the only thing that tells them apart
6. Do not put counts in section headings ("12 total", "3 remaining"). They go stale as progress moves and nobody updates them
7. Do not write about where the data comes from (for example "ticked state comes from Steam's real unlock data")
8. Stop after the last achievement. No summary, no list of sources, no "this guide is incomplete"

## How to write it

- Divide into sections along **the game's own achievement categories** (main story / side content / collectibles / combat / miscellaneous), following how the game itself divides them
- **Things of the same kind belong in the same section.** Judge by the **official description**, not by how they unlock: four "replace the mascot with X" achievements are one kind, even if two are bought in a shop and two are easter eggs — split them by unlock route and the reader has to look in two sections for one thing. Likewise "unlock every X" belongs together, and the 100/500/1000 tiers of the same thing are one group, not three scattered entries
- **Sub-checkboxes are off by default.** Nesting is the exception, and all three of these have to hold **at once**:
  1. **Each line has an identity of its own** — a shrine's name, a recipe, a side quest, a collectible's location: a **specific thing** to go and find, look up or recognise. **A number is not an identity**: \`Day 1\`/\`Day 2\`, \`Level 1\`/\`Level 2\`, \`1/10\`, \`Step one\`/\`Step two\` only spell a number out and add nothing
  2. **The line has something to say beyond "which one it is".** The test is **not whether the game has a counter** — a counter only tells the player how many are left, never how to get the one they are missing, and the second is the entire value of a guide. So \`Day 1\`…\`Day 7\` has no method to state and is not nested; thirty encyclopedia entries each obtained a different way **are** nested, each line saying how that entry is obtained. Ten collectibles that all drop the same way are not nested either — those ten lines would say one thing ten times
  3. **Every line has to be done**, not one of them chosen. Where the lines are **alternatives** (nine endings under "reach any ending", five classes under "finish with any class"), **do not nest** — write them flat in the notes. Nesting means "the parent unlocked ⇒ every line below it was done", and putting mutually exclusive options there creates eight false records
- When all three hold, nesting is **required** (120 shrines, 20 recipes, 5 side quests, one per line) rather than a paragraph of prose — in that case the reader really does tick them off one at a time
- **An achievement that takes several stages to reach: write the process itself as sub-checkboxes.** The three rules above hold for a long process just as well: each step is a **specific action** (what to place in which ritual, where to trigger which event), it has a method to state, and every step has to be done. Nesting is not only for collectibles — the reader does this across several sittings in one playthrough and wants to tick it off step by step. **Three steps or fewer belong in the notes and need no breakdown**
${groupLabelRule(target, 'en')}
- **One self-check: delete those lines — does the guide lose any information?** If not, do not write them. Hanging \`Day 1\`…\`Day 7\` under "play for 7 days" is the most common and least useful way to break this rule. **When the three tests above are unclear, this one decides** — the first two are asking whether those lines carry information, and this asks it outright. It works the other way too: if deleting them leaves the guide unable to say how the achievement is earned, it should be nested
- An achievement that unlocks automatically as the story progresses: the name and the official description are enough
- An achievement with a trap, a trick, or something easy to miss: write out the prerequisites, the decisive choices and where it goes wrong. **This is the most valuable part of a guide** — do not skimp on it
- **Put prerequisites, steps and warnings on separate lines rather than in one block.** \`<br>\` is a line break inside a checkbox; use it to separate things of different kinds: prerequisites and material lists get their own line beginning "Prerequisite:"; anything past three steps goes **one step per line**; whatever causes a failure or a wrong turn gets its own line beginning "Careful:".
  **The test is whether one line mixes two kinds of thing, not how long it is** — six hundred words in a single block can be entirely correct and still leave the reader unable to tell which sentence is preparation, which is the action and which is the trap. Read it back afterwards: **can you point straight at which sentences are prerequisites and which are steps?** If not, it is not yet broken up
- Fold a very long list (every ending, every collectible) into \`<details><summary>\`. **The floor: fold it once it reaches 10 lines, or once it is longer than the body of the achievement it belongs to** — under that, leave it open, because folding costs a click and a three-line table folded away is just information hidden. A table with many columns that plain text cannot align may use an HTML \`<table>\`, but prefer a checkbox list wherever one says it clearly
  - **A folded block may hold a nested checkbox list. Length is not a reason to leave things out, only a reason to fold them** — thirty entries each obtained a different way, written as one sentence about "recorded gradually as the story progresses", gives the reader nothing at all
  - **The achievement's own line never goes inside a fold.** A fold holds the supporting material under an achievement (sub-steps, comparison tables, collectible lists), not the achievement list. Fold a section's achievements away and opening that section shows nothing
- Use the game's official English achievement names. Where a game has no English name, keep the original. Terms of art — boss, build, DLC, NPC — stay as they are
- **Treat DLC achievements as an ordinary section of the game.** Do not label them with parenthetical notes about which release they came from; a section heading naming the DLC is enough
- Where a game has operating details worth looking up repeatedly (cocktail recipes, class unlock conditions), a short reference section **before** the achievement list is fine. That is a functional reference, not documentation wrapping
- **Location achievements: when you cannot give the actual location, give a video link with a timestamp rather than filling the space with generalities.**
  In a hunting or puzzle game "30 mushrooms are scattered around the map" cannot be written out one by one in prose, while "check the corners" and "look for anything obscured" are true of every level ever made — which is to say they are nothing.
  In that case give something like "compare against the 5-2 chapter of <video> (01:56)" so the reader can see that exact screen.
  **The timestamp is the point**; a bare video link asks the reader to scrub through the whole thing
- **Cite whatever source you actually read.** A guide researched on TrueAchievements cites TrueAchievements; one researched on Bilibili cites the BV number. Do not convert a citation into a source you did not open
- No images

## Fixed notations (do not invent your own)

- **Location**: for anything tied to a specific place on the map, begin the entry with \`Location: XXX\`
- **Prerequisite**: where a background, skill or perk is needed, use \`※ requires background X\`
- **Mutually exclusive**: where an achievement conflicts with another, use \`<span underline="true">Doing this makes X unobtainable.</span>\`
- **Missable**: mark \`MISSABLE!!\` only where passing some point loses it **permanently**. Seasonal or once-a-year things that come round again **are not marked** — that is a false alarm, and enough of them and nobody reads the marker at all
- **DLC excluded**: where an achievement does not include DLC content, mark \`※ base game only\`
- **Spoiler**: content that ruins a first playthrough (endings, twists, who somebody turns out to be,
  what a hidden achievement actually asks of you) does not go straight into your notes. Hang a fold
  under that achievement instead:
      - [ ] **Achievement Name**<br>the official description<br>the half of the method that spoils nothing
        <details>
        <summary>Spoiler</summary>
        The actual content goes here, written as prose
        </details>
  - **The \`<summary>\` reads \`Spoiler\` and nothing else.** That label is what a reader sees without
    opening the fold, so "Spoiler: the killer is the doctor" has folded nothing away
  - **The achievement's own line has to carry the context**, so a reader can tell what kind of thing
    is inside and whether it is worth opening, without opening it
  - **The fold comes immediately after the achievement's line, indented more deeply, with no blank
    line between them.** Separated, the program cannot tell which achievement it belongs to, and a
    partial rewrite leaves it stranded where it is
  - **Write prose inside the fold, not checkboxes.** A checkbox in there is read as a sub-step and is
    ticked along with the parent achievement, which files a false record
  - **The 10-line floor above does not apply here** — this one is folded because it spoils, not
    because it is long
  - **Use it rarely.** On real guide sites a narrative game's whole guide carries 0 to 2 of these. Do
    not hang one on every hidden achievement — fold too much and the reader opens everything by
    reflex, which retires the marker

## No documentation-style asides

**A guide never contains "presumably", "to be confirmed", "unverified" or "this may be wrong".** There are two ways to handle something uncertain: look it up and then write it, or leave it out. Uncertainty written into the body leaves the reader unable either to follow it or to judge how far to trust it.

`;

/** The research requirements when the model has network access */
const RESEARCH_ONLINE = `## 怎么查资料

先上网搜这个游戏的成就攻略,再把最有用的那一两页正文抓回来读完。中文攻略站(游民星空、3DM、NGA、B站)、Steam 社区攻略、TrueAchievements、Fandom wiki 都可以。**理解机制之后用自己的话重写**,不要照搬原文。

## 搜索预算怎么花

**先搜一两次全局的("<游戏名> 全成就攻略"),再对着 🔴 和 🟠 那几条单独搜。**
一次通用搜索解决不了难成就——难就难在细节上,而细节只在专门讲它的帖子里。

- 🔴 的每一条都值得单独搜一次,搜不到就换关键词再来一次(中文搜不到就用英文成就名 + 游戏英文名)
- ⚪ 的不用搜,官方描述加一句话就够
- **搜索次数是够用的,不要省。** 一次搜索比一段编出来的话便宜得多

**难成就要写到能照着做:** 前置条件怎么达成、要多少资源/多长时间、关键节点在哪、
最容易翻车的地方是什么、有没有更省事的替代打法。只给一句"需要 XXX"等于没写。

查不到具体资料的成就,就按名字和官方描述给出你能给的最合理的说明——**不要编造**具体数值、地点、道具名。写不确定的东西不如少写。`;

/**
 * The version for when there is no network access.
 *
 * Not simply the section above deleted — **"do not make things up" is nearly unenforceable without
 * a source**, since the model can only write from what it already knows and cannot tell what it
 * remembers from what it confabulated. So this version inverts the requirement: better to leave
 * only the official description than to write one sentence it is unsure of. Writing less is an
 * acceptable outcome; inventing a step that looks convincing is not.
 */
const RESEARCH_OFFLINE = `## 你这次没有联网能力

这一轮你**没有搜索和抓取网页的工具**,只能靠已有知识写。因此:

- **宁可少写,也不要写没把握的东西。** 不确定的成就,只写官方描述那一段,第三段留空
- **绝对不要编造**具体数值、地点、道具名、NPC 名、选项文本。这些正是最容易记错、
  而读的人又最会当真去照做的东西
- 确实有把握的通用机制(比如"这类成就通常要通关后二周目才能拿")可以写,
  但要写成判断而不是断言
- 不要为了让攻略看起来完整而给每一条都编一段心得。**留空是合格的结果**`;

/**
 * The research sections in English.
 *
 * **The source list is deliberately the same one.** The Chinese sites are not there because the
 * guide is in Chinese; they are there because that is where the coverage is for a great many games,
 * and reading a Bilibili post to write an English entry is exactly what a bilingual model is for.
 * What changes is the fallback keyword advice, which pointed at English names as the second attempt
 * and now points the other way.
 */
const RESEARCH_ONLINE_EN = `## How to research

Search the web for this game's achievement guides, then fetch and read the one or two most useful pages in full. Steam community guides, TrueAchievements, Fandom wikis and the Chinese guide sites (Gamersky, 3DM, NGA, Bilibili) are all fair game. **Understand the mechanics and then write them in your own words** — do not copy the source.

## How to spend the search budget

**Run one or two broad searches first ("<game> all achievements guide"), then search individually for the 🔴 and 🟠 entries.**
A general search does not solve a hard achievement — the difficulty is in the detail, and the detail is only in a post written about that one achievement.

- Every 🔴 entry is worth its own search, and worth a second with different keywords if the first finds nothing (when English finds nothing, try the Chinese achievement name plus the game's Chinese title)
- ⚪ entries need no search; the official description plus a sentence is enough
- **You have enough searches, so do not ration them.** One search is far cheaper than one invented paragraph

**A hard achievement has to be written so it can be followed:** how the prerequisites are met, how much time or resource it costs, where the decisive moments are, where it most often goes wrong, and whether there is an easier route. A single sentence saying "you need XXX" is not an entry.

Where you cannot find anything specific, give the most reasonable account the name and the official description support — **do not invent** figures, places or item names. Writing less beats writing something uncertain.`;

const RESEARCH_OFFLINE_EN = `## You have no network access this time

You have **no search or page-fetch tools** this round and can write only from what you already know. Therefore:

- **Write less rather than writing what you are unsure of.** For an achievement you are uncertain about, write only the official description and leave the third part empty
- **Never invent** specific figures, locations, item names, NPC names or menu text. These are precisely what is easiest to misremember and what the reader is most likely to take at face value and act on
- General mechanics you are genuinely confident about ("achievements of this kind usually need a second playthrough") are fine, but write them as a judgement rather than as a fact
- Do not invent a note for every entry so the guide looks complete. **Leaving it empty is an acceptable result**`;

/**
 * Global unlock rate → a label the model can allocate effort against.
 *
 * A bare percentage is not enough: the model has to know that 1.1% means "write this one deeply".
 * So the conclusion is stated directly rather than left to it to convert. The thresholds are a
 * judgement call, but the direction is measured — in 《部落幸存者》 the hardest is 1.1% and the
 * easiest 64.5%, a 60× spread, while without this signal the generated notes differed in length by
 * less than 2×.
 */
function rarityTag(pct, lang) {
  if (pct === undefined || pct === null) return '';
  const p = pct.toFixed(1);
  if (lang === 'en') {
    if (pct < 5) return `  🔴 only ${p}% of players worldwide have this — **write this one deeply**`;
    if (pct < RARE_PCT) return `  🟠 ${p}% worldwide, on the hard side`;
    if (pct < 40) return `  🟡 ${p}% worldwide`;
    return `  ⚪ ${p}% worldwide, most players get it without trying — a sentence or two is enough`;
  }
  if (pct < 5) return `  🔴 全球仅 ${p}% 玩家解锁 —— **这类要写深**`;
  // **This threshold is imported, not written out a second time.** "What the UI marks as rare" and
  // "what the prompt says to write deeply" have to be the same set of achievements; two separately
  // written numbers can drift with nobody noticing — the symptom is only that the UI says it is
  // rare and the program disagrees. Same on the Dashboard side, where the server sends the threshold
  if (pct < RARE_PCT) return `  🟠 全球 ${p}% 解锁,偏难`;
  if (pct < 40) return `  🟡 全球 ${p}% 解锁`;
  return `  ⚪ 全球 ${p}% 解锁,多数人自然拿到 —— 一两句带过就行`;
}

/**
 * The achievement list. The ⚠️ 同名 marker tells the model outright which entries must copy the
 * description, which beats making it count for itself.
 *
 * **`lang` reorders the name pair and picks the description; it never drops half.** Both names stay
 * on the line whichever way round they go, because rule 3 requires the bold name to match the list
 * exactly and a game may have only one of the two. The duplicate-name count is taken over both
 * languages for the same reason it always was: a collision in either one is a collision.
 */
export function buildAchievementList(game, appid, defs, rarity = null, lang) {
  if (lang === 'en') return buildAchievementListEn(game, appid, defs, rarity);
  const byName = new Map();
  for (const d of defs) {
    for (const raw of [d.name_cn, d.name_en]) {
      const k = String(raw ?? '').trim();
      if (!k) continue;
      byName.set(k, (byName.get(k) ?? 0) + 1);
    }
  }

  const lines = defs.map((d, i) => {
    const cn = (d.name_cn ?? '').trim();
    const en = (d.name_en ?? '').trim();
    const dup = (cn && byName.get(cn) > 1) || (en && byName.get(en) > 1);
    const title = cn && en && cn !== en ? `**${cn}** / ${en}` : `**${cn || en}**`;
    const desc = (d.description ?? '').trim();
    return (
      `${i + 1}. ${title}${dup ? '  ⚠️ 同名' : ''}${rarityTag(rarity?.get(d.api_name))}\n` +
      `   官方描述:${desc || '(Steam 上是空的)'}`
    );
  });

  const head = `## 《${game}》(appid ${appid})的全部成就,共 ${defs.length} 个`;
  const note = rarity
    ? '\n\n每条后面标的是**全球解锁率**(Steam 公开数据)。这是判断难度最可靠的信号 ——\n' +
      '**力气按它分配**:🔴 那几条是这份攻略真正的价值所在,要专门去查、写清楚前置条件、\n' +
      '资源/时间成本、关键节点和常见翻车点;⚪ 那些一两句就够,写多了反而稀释重点。'
    : '';
  return `${head}${note}\n\n${lines.join('\n')}`;
}

/**
 * The same list with the English name first and `description_en` as the official description.
 *
 * **The description falls back to the Chinese one rather than to nothing.** A game synced before
 * `description_en` existed has English names and Chinese descriptions until the next sync reaches
 * it; an entry with an empty description would be written up from its name alone, and rule 4's
 * verbatim copy would then have nothing to copy. A Chinese description in an English guide is
 * visibly odd, which is the point — it is recoverable by syncing, while an invented one is not.
 */
function buildAchievementListEn(game, appid, defs, rarity) {
  const byName = new Map();
  for (const d of defs) {
    for (const raw of [d.name_cn, d.name_en]) {
      const k = String(raw ?? '').trim();
      if (!k) continue;
      byName.set(k, (byName.get(k) ?? 0) + 1);
    }
  }

  const lines = defs.map((d, i) => {
    const cn = (d.name_cn ?? '').trim();
    const en = (d.name_en ?? '').trim();
    const dup = (cn && byName.get(cn) > 1) || (en && byName.get(en) > 1);
    const title = cn && en && cn !== en ? `**${en}** / ${cn}` : `**${en || cn}**`;
    const desc = (d.description_en ?? '').trim() || (d.description ?? '').trim();
    return (
      `${i + 1}. ${title}${dup ? '  ⚠️ duplicate name' : ''}${rarityTag(rarity?.get(d.api_name), 'en')}\n` +
      `   Official description: ${desc || '(empty on Steam)'}`
    );
  });

  const head = `## Every achievement in ${game} (appid ${appid}) — ${defs.length} in total`;
  const note = rarity
    ? '\n\nThe tag after each entry is its **global unlock rate** (Steam public data). It is the most\n' +
      'reliable signal of difficulty there is, so **spend your effort by it**: the 🔴 entries are where\n' +
      "this guide's value actually lies and deserve their own research — prerequisites, cost in time and\n" +
      'resources, the decisive moments, the usual ways it goes wrong. The ⚪ ones need a sentence or two,\n' +
      'and writing more only dilutes the rest.'
    : '';
  return `${head}${note}\n\n${lines.join('\n')}`;
}

/**
 * `target` is which backend this guide finally lands on (`'notion'` / `'local'`). **Only the group
 * label rule** branches on it; every other rule stays the same — see `groupLabelRule`. When it does
 * not reach here, fall back to the version that is safe on both.
 */
export function buildSystemPrompt(
  game, appid, defs, { canSearch = true, rarity = null, target = null, lang = 'zh' } = {}
) {
  const en = lang === 'en';
  const research = en
    ? (canSearch ? RESEARCH_ONLINE_EN : RESEARCH_OFFLINE_EN)
    : (canSearch ? RESEARCH_ONLINE : RESEARCH_OFFLINE);
  return `${rulesFor(target, lang)}\n\n${research}\n\n---\n\n${buildAchievementList(game, appid, defs, rarity, lang)}`;
}

/**
 * Builds the system prompt from a `plan`. **There is exactly one entrance for building a prompt.**
 *
 * Three paths have to send the same one: full generation, partial rewrite, and `--dry-run`'s
 * preview. Assembling the arguments separately in each ends in silent divergence — stepped on once:
 * the `--dry-run` copy was missing `rarity` and `target`, so the prompt the preview printed was not
 * the one actually sent, and the sole reason the preview exists is "let people see what will be
 * sent". The arguments come from `plan` and callers may not assemble their own, so there is nowhere
 * for divergence to happen.
 *
 * `target` always comes from `plan.target`: the partial-rewrite side holds `plan.existing.kind`,
 * and in `planGuide` `target = existing ? existing.kind : …`, so the two are identical whenever a
 * guide already exists.
 */
export function systemPromptFor(plan, appid, { canSearch }) {
  return buildSystemPrompt(plan.game, String(appid), plan.defs, {
    canSearch,
    rarity: plan.rarity,
    target: plan.target,
    // Same argument as `target`: the language is decided once, in `planGuide`, and travels on the
    // plan. A caller that resolved it for itself would be the second place able to answer "which
    // language is this guide", and the `--dry-run` preview would be where the two first disagreed
    lang: plan.lang,
  });
}

// ---------------------------------------------------------------------------
// Sharded writing
// ---------------------------------------------------------------------------

/**
 * Splits the achievements into shards. A few hundred achievements will not fit in one context —
 * not because the list does not fit (the list is small) but because **that much prose cannot be
 * written**: one achievement's three-part entry is about 150 characters, so 400 of them is 60,000,
 * far past any vendor's single-response output ceiling. And truncation raises no error — the
 * validator merely says "every achievement in the second half is missing its checkbox".
 *
 * **`size` is a per-shard cap, not a per-shard length.** First work out how many shards are needed,
 * then spread the achievements evenly across them.
 *
 * It used to be naive sequential slicing (fill each shard to size, the remainder gets its own), and
 * that gives the worst possible split for **any count slightly above a multiple of size**: 55
 * achievements with size=50 splits into 50 + 5 — the first shard is pressed against the ceiling,
 * the last is nearly empty, and the shard count is still 2. Same number of shards, but the first
 * one takes the max_tokens truncation risk for nothing. Spread evenly it is 28 + 27: same shard
 * count, half the prose per shard.
 * (Measured on 人中之龙0, 55 achievements.)
 *
 * Spreading evenly can never push a shard past size — `ceil(n / ceil(n / size)) ≤ size` holds
 * identically, so this only ever shortens shards, never breaks the cap.
 */
export function chunkDefs(defs, size) {
  const max = Math.max(1, Number(size) || 1);
  if (!defs.length) return [];
  const per = Math.ceil(defs.length / Math.ceil(defs.length / max));
  const out = [];
  for (let i = 0; i < defs.length; i += per) out.push(defs.slice(i, i + per));
  return out;
}

const defName = (d) => achName(d).trim();

/**
 * The same name, but in **the language this prompt is being written in** rather than the language
 * the interface happens to be in. `defName` asks `achName`, which reads the process-wide message
 * language — correct for a progress label, wrong inside a prompt, because the two disagree for the
 * whole of a run started in one language and watched in the other.
 */
const defNameIn = (d, lang) => achievementName(d, lang).trim();

/**
 * Cut this small and still unable to write it, and the cutting stops.
 *
 * This floor is not about infinite loops (each split at least halves, so it necessarily converges),
 * it is that **cutting further does not solve the problem**: the prose for five achievements is two
 * or three thousand characters, nowhere near any vendor's single-response ceiling, so still failing
 * means what is eating the budget is thinking rather than prose — and sharding cannot reach that.
 * Continuing only turns one failure into ten failures, each one re-running the whole web research.
 * Stop here and say the truth out loud.
 */
export const MIN_CHUNK = 5;

/**
 * How many **extra** asks one shard gets at most.
 *
 * Only "empty reply" ever uses it, and an empty reply is the one genuinely **transient** failure on
 * this path: the request was fine, the shard length was fine, the research was found, and this one
 * time no prose came out. Asking again verbatim will very likely produce it, at the cost of one
 * request — while not re-asking costs the whole guide plus a dozen wasted web searches.
 *
 * 1 rather than more: a second empty reply is not a glitch, it means something about this shard
 * stops the model from writing it, and at that point the right move is to change technique (split
 * it, see canSplit) rather than keep throwing the same sentence at the wall.
 */
export const EMPTY_RETRIES = 1;

/**
 * The kinds that might just work when asked again verbatim — all of them **this one glitch**, not
 * a problem with this shard.
 *
 * - `empty` — not a single text block. Request, shard length and research were all fine; this time
 *   no prose came out.
 * - `control-token` — the model wrote one of its own internal control markers into the prose and
 *   the output cut off there (see `leakedControlToken` in lib/ai.js). Also a sampling excursion, and
 *   re-asking will very likely come back normal.
 *
 * Every other kind has a specific cause: truncation means the shard is too long (split it), refusal
 * and RECITATION are content judgements (asking again gives the same answer), a search error is the
 * network or a quota (wait, or change the config). Putting those into a retry only pays to make the
 * same mistake twice.
 */
export const RETRYABLE = new Set(['empty', 'control-token']);

function canRetry(err, attempt) {
  return RETRYABLE.has(err?.code) && attempt < EMPTY_RETRIES;
}

/**
 * The two failures that splitting and re-asking can rescue.
 *
 * - `max_tokens` — the shard is too long, and halving it treats the actual cause.
 * - `empty` — reached only after **re-asking still returned empty** (see canRetry). This step is a
 *   guess, but a grounded one: what goes into one request is thinking + prose, and on a compatible
 *   endpoint we can neither send the parameter that suppresses thinking (see `extras` in
 *   ai-anthropic.js: set `ai.baseUrl` and `thinking`/`output_config` stop being sent) nor **assume
 *   it reports "thinking ate the budget" honestly as max_tokens** — DeepSeek's `/anthropic` is
 *   somebody else's implementation of the Messages API, and the fidelity of its stop reasons is not
 *   in our hands. So "empty reply" holds a share of cases that are substantively truncation, and
 *   splitting is the remedy for that share. Guessing wrong costs one extra ask; not guessing costs
 *   the whole guide.
 */
export const SPLITTABLE = new Set(['max_tokens', 'empty', 'control-token']);

/**
 * "This shard failed" and "the provider is broken" are two different things, and they are thrown
 * from the same `await ask()`.
 *
 * Only these kinds, as judged by `checkResult`, are **this shard's own** problem: all of them are
 * HTTP 200 and may well work with different content, so letting this shard go and carrying on with
 * the rest is right.
 *
 * A 401, a dropped network, an exhausted `ai.maxContinuations` and other **global** failures have to
 * be rethrown verbatim. Treating one as "this shard failed" and asking on means hitting the same
 * wall three more times, each one making the user wait out a round; and the real cause gets buried
 * in a string of 「第 N 段未生成」 — more importantly, its own terminal advice (for `bad-api-key`,
 * the note that an env var overrides config.json) can no longer reach tracker.js's top-level catch.
 * Grading them or not is exactly this difference.
 */
const CHUNK_LOCAL = new Set(['empty', 'max_tokens', 'refusal', 'recitation', 'tool-error', 'other', 'control-token']);

/**
 * Whether this failure can be rescued by splitting and re-asking.
 *
 * Refusal, RECITATION and search errors are not in `SPLITTABLE`: they are not length problems, they
 * hit the same wall when smaller, and each has a completely different correct response (rephrase /
 * change game / check the network).
 *
 * Splitting only happens in round 1. Later rounds do targeted rewrites from the validation results,
 * and `targets` holds indices computed before entering the loop, so changing the shard count midway
 * invalidates that correspondence — while in a rewrite round the shard length is already a value
 * that worked in round 1.
 */
function canSplit(err, round, chunk) {
  return SPLITTABLE.has(err?.code) && round === 1 && chunk.length > MIN_CHUNK;
}

/**
 * Adds "and it was cut down to this" when it cannot be cut further.
 *
 * **`round !== 1` does not deserve this sentence.** In that case the reason for not splitting is
 * that a rewrite round's indices cannot move (see canSplit), not that the shard is already small
 * enough — saying "cut down to N and it still could not be written" reports a fact that never
 * happened. So this only rewrites the error code in round 1.
 *
 * **States facts only, gives no configuration advice.** This message appears verbatim in the
 * Dashboard's floater, where the user has no terminal and should not be asked to edit config.json;
 * which knob to turn is said afterwards by the CLI itself (see tracker.js's handling of
 * `chunk-too-small`).
 */
function chunkFloorAdvice(err, round, chunk) {
  if (!SPLITTABLE.has(err?.code) || round !== 1) return err;
  err.detail = { size: chunk.length, min: MIN_CHUNK, was: err.code };
  err.code = 'chunk-too-small';
  err.message += msg('gen.chunkFloor', { n: chunk.length });
  return err;
}

/**
 * Classification is **not done before the prose is written**, it is done afterwards (see
 * `buildRegroupPrompt`).
 *
 * A pass before writing holds only achievement names, and names are frequently jokes: 《马特的寻猫
 * 游戏》's 「海拉鲁老流氓」 is really about smashing 100 pots. Classifying by name alone produces
 * thematic headings like 「自然与美食」 and 「囤积狂的自我修养」, and splits same-kind achievements
 * across two sections. Adding descriptions and running it again does not help either — **the
 * information is missing, not the prompt**: classification needs "what this one actually requires,
 * known after the research", and that information exists only once the prose is written.
 */


/**
 * Which entries get one line only — **the ones already unlocked**.
 *
 * A guide is meant to be followed, and the ones already done need no method: the name, the official
 * description and a tickable box are all of it they will still use. What is saved is the research
 * and prose for those entries, and that is the only thing this feature spends money on (see the A/B
 * in CLAUDE.md: nearly all the time goes into the model thinking and searching, not into length).
 *
 * **A fully unlocked game saves nothing.** In that case "what is saved" is the entire guide — what
 * remains is a run of lines holding only names and official descriptions, which is exactly what the
 * Steam page already shows. Somebody generating a guide for a 100% game wants precisely the content.
 *
 * This only governs **a newly written guide**. An overwrite does not take this path: by then the
 * guide already contains prose that was paid for, and "they unlocked it since" is not a reason to
 * delete that text — see where it is passed in generateGuide.
 */
export function briefApiNames(defs, unlockedApiNames) {
  const all = defs ?? [];
  const unlocked = new Set(unlockedApiNames ?? []);
  const mine = all.filter((d) => unlocked.has(d.api_name));
  return mine.length === all.length ? new Set() : new Set(mine.map((d) => d.api_name));
}

/**
 * Which entries in this shard get one line only. **Names the smaller half** — most games are
 * "already mostly unlocked", and there listing "the few to write in full" is far shorter than
 * listing "the forty to write briefly", and reads as exactly the work the model has to do in this
 * shard.
 */
function briefInstruction(chunk, brief, lang = 'zh') {
  if (lang === 'en') return briefInstructionEn(chunk, brief);
  const all = chunk ?? [];
  const mine = all.filter((d) => brief.has(d.api_name));
  if (!mine.length) return '';
  const full = all.filter((d) => !brief.has(d.api_name));
  const names = (list) => list.map((d) => '「' + defName(d) + '」').join('、');
  const shortForm = '`- [ ] **名字** — 官方描述` 一行就停,不用查资料,也不用写怎么做';
  return full.length < mine.length
    ? '- 这一段里**只有这几个要按规则写完整**:' + names(full) + '。\n'
      + '  其余的他都已经解锁了,每个写 ' + shortForm + '\n'
    : '- 这几个他**已经解锁了**,每个写 ' + shortForm + ':' + names(mine) + '\n';
}

/** `briefInstruction` in English. Same three sentences; see that one for why the shape is what it is. */
function briefInstructionEn(chunk, brief) {
  const all = chunk ?? [];
  const mine = all.filter((d) => brief.has(d.api_name));
  if (!mine.length) return '';
  const full = all.filter((d) => !brief.has(d.api_name));
  const names = (list) => list.map((d) => '"' + defNameIn(d, 'en') + '"').join(', ');
  const shortForm = '`- [ ] **Name** — official description` and stop there: no research, and no walkthrough';
  return full.length < mine.length
    ? '- **Only these need writing out in full** in this part: ' + names(full) + '.\n'
      + '  The rest are already unlocked; write each as ' + shortForm + '\n'
    : '- These are **already unlocked**; write each as ' + shortForm + ': ' + names(mine) + '\n';
}

/**
 * What this shard should write. With a single shard and nothing to write briefly it is the original
 * sentence, with behaviour unchanged to the letter.
 */
export function buildChunkMessage(chunks, i, brief = new Set(), lang = 'zh') {
  if (lang === 'en') return buildChunkMessageEn(chunks, i, brief);
  const briefNote = briefInstruction(chunks[i], brief);
  if (chunks.length === 1) {
    const open = '开始写吧。先联网查资料,再按规则写完整份攻略。';
    return briefNote ? open + '\n\n' + briefNote : open;
  }

  const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0);
  const chunk = chunks[i];
  const last = i === chunks.length - 1;
  return (
    `这一轮**只写第 ${before + 1}–${before + chunk.length} 个成就**` +
    `(从「${defName(chunk[0])}」到「${defName(chunk[chunk.length - 1])}」),` +
    `全篇共 ${chunks.length} 段,这是第 ${i + 1} 段。\n\n` +
    '- 只输出这一段的 markdown,**不要重复前面已经写过的小节和成就**\n' +
    '- 这一段里的每一个成就都要有自己的 `- [ ]` 行,一个都不能少\n' +
    // **The shards are written separately; you cannot see any other shard's prose.**
    //
    // **It must not say "do not write the section heading again"** — that sentence assumes the
    // shards share one session and the model really can see what came before. Once the shards run
    // concurrently that assumption is gone, and it would make the model omit **the section heading
    // it should write**, leaving that shard's entries hanging under the previous shard's heading and
    // reading like a misfiled category. Put the other way round: open the heading, and the program
    // merges duplicates — a duplicate at a seam is merged by `joinBodies`, while the real
    // categorisation is the job of the pass after everything is written (see `buildRegroupPrompt`)
    '- 这一段是独立写的,你看不到别的段写了什么。**该开的小节标题就开** ——' +
    '相邻两段开了同一个小节的话,程序会把重复的那行合掉,不用你操心\n' +
    (last
      ? '- 这是最后一段,写完就停。不要写总结、不要写参考来源\n'
      : '- 后面还有,所以这一段结尾不要写任何收尾的话\n') +
    briefNote
  );
}

/**
 * `buildChunkMessage` in English. **A turn message, not the rules** — the rules are the cached system
 * prefix and fork in `rulesFor`; this is what is said each round, and it forks for the same reason:
 * an English guide asked for in Chinese comes back in whichever language the model settles on, and
 * the section headings are where that shows first.
 */
function buildChunkMessageEn(chunks, i, brief) {
  const briefNote = briefInstructionEn(chunks[i], brief);
  if (chunks.length === 1) {
    const open = 'Go ahead. Research it online first, then write the whole guide by the rules.';
    return briefNote ? open + '\n\n' + briefNote : open;
  }

  const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0);
  const chunk = chunks[i];
  const last = i === chunks.length - 1;
  return (
    `This round writes **achievements ${before + 1}–${before + chunk.length} only** ` +
    `(from "${defNameIn(chunk[0], 'en')}" to "${defNameIn(chunk[chunk.length - 1], 'en')}"). ` +
    `The guide is ${chunks.length} parts in all; this is part ${i + 1}.\n\n` +
    '- Output the markdown for this part only, and **do not repeat sections or achievements already written**\n' +
    '- Every achievement in this part needs its own `- [ ]` line, without exception\n' +
    '- This part is written on its own and you cannot see what the other parts wrote. ' +
    '**Open whatever section heading it needs** — where two adjacent parts open the same section, ' +
    'the program merges the duplicate line; it is not yours to worry about\n' +
    (last
      ? '- This is the last part. Stop when it is written: no summary, no list of sources\n'
      : '- More parts follow, so do not write anything that closes the guide at the end of this one\n') +
    briefNote
  );
}

/**
 * One shard's list of rejections. **Lists only this shard's own problems** — do not stuff other
 * shards' errors in, or the model will helpfully "fix" content it is not supposed to output this
 * round.
 */
export function buildChunkFeedback(findings, chunks, i, unnameable = new Set(), lang = 'zh') {
  if (chunks.length === 1) return buildFeedback(findings, lang);
  if (lang === 'en') return buildChunkFeedbackEn(findings, chunks, i, unnameable);

  const mine = new Set(chunks[i].map((d) => d.api_name));
  const { blocking } = splitFindings(findings, unnameable);
  const own = blocking.filter((f) => MODEL_FIXABLE.has(f.code) && (!f.apiName || mine.has(f.apiName)));
  const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0);

  return (
    `第 ${i + 1}/${chunks.length} 段(第 ${before + 1}–${before + chunks[i].length} 个成就)校验没过:\n\n` +
    own.slice(0, 40).map((f) => `✖ ${f.message}`).join('\n') +
    '\n\n请**只重新输出这一段的完整 markdown**(放在一个 ```markdown 围栏里),' +
    '别动别的段落。checkbox 的勾选状态不用管,程序会填 —— 你只要保证这一段里' +
    '每个成就都有自己的 `- [ ]` 行、粗体名字和清单一字不差、官方描述原文照抄。'
  );
}

/** `buildChunkFeedback` in English. The single-shard case has already gone to `buildFeedback`. */
function buildChunkFeedbackEn(findings, chunks, i, unnameable) {
  const mine = new Set(chunks[i].map((d) => d.api_name));
  const { blocking } = splitFindings(findings, unnameable);
  const own = blocking.filter((f) => MODEL_FIXABLE.has(f.code) && (!f.apiName || mine.has(f.apiName)));
  const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0);

  return (
    `Part ${i + 1} of ${chunks.length} (achievements ${before + 1}–${before + chunks[i].length}) ` +
    'did not pass validation:\n\n' +
    own.slice(0, 40).map((f) => `✖ ${f.message}`).join('\n') +
    '\n\n**Output the complete markdown for this part again** (inside one ```markdown fence) and ' +
    'leave the other parts alone. Ignore the checkbox tick state, the program fills it in — what you ' +
    'have to get right is that every achievement in this part has its own `- [ ]` line, that the bold ' +
    'names match the list exactly, and that the official descriptions are copied verbatim.'
  );
}

/**
 * The prompt for a partial rewrite: **rewrite only the named entries, and show it the original.**
 *
 * This is a third way of asking, and it cannot be conflated with either of the other two, for
 * reasons worth writing down:
 *
 * - `buildChunkMessage` writes a shard **blind** — it cannot see any existing prose. Using it for a
 *   partial rewrite means the model receives "write these entries" while the user said "write these
 *   entries in more detail", and that requirement has nothing to attach to.
 * - `buildChunkFeedback` is a **rejection based on validation results** — its register is "you broke
 *   a rule, fix it". A user saying 「加上互斥关系」 is not a rule violation, and wrapping it as a ✖
 *   makes the model guess what it did wrong.
 *
 * So this version lays out the original and then states the requirement. Three constraints are
 * structural, not left to the model's discretion:
 *
 * 1. **Output only these entries and no section headings.** The splice happens by line range (see
 *    `todoSpans` in markdown.js), and an extra heading would be pasted into an achievement's slot.
 * 2. **Keep the given order.** Every returned entry still has to be resolved back to its api_name by
 *    `resolveTodoToAchievement` before it counts (order only makes it easy to line up; it is not
 *    evidence we trust) — but with a consistent order a discrepancy is visible at a glance, whereas
 *    a shuffled one relies wholly on the reverse lookup.
 * 3. **`- [ ]` as always.** Tick state is always filled in by the program from the database, and
 *    this rule is the same one here as in full generation (see item 1 in the file header).
 *
 * **The original is always given; do not add a "rewrite without the original" switch.** Requirements
 * like 「写详细点 / 补上前置条件 / 把这段改成表格」 are the overwhelming majority, and every one of
 * them presupposes seeing the original. To have it rewritten from scratch, simply give no
 * requirement — which is exactly what the default sentence below says.
 */
export function buildPatchMessage(entries, { instruction = null, lang = 'zh' } = {}) {
  if (lang === 'en') return buildPatchMessageEn(entries, { instruction });
  const lines = entries.map((e, i) => {
    const d = e.def;
    const cn = (d.name_cn ?? '').trim();
    const en = (d.name_en ?? '').trim();
    const title = cn && en && cn !== en ? `**${cn}** / ${en}` : `**${cn || en}**`;
    const desc = (d.description ?? '').trim();
    const body = [
      `${i + 1}. ${title}`,
      `   官方描述:${desc || '(Steam 上是空的)'}`,
    ];
    body.push(`   现在写的:${String(e.text ?? '').replace(/\n/g, ' ') || '(空)'}`);
    return body.join('\n');
  });

  const ask = instruction
    ? `要求:${instruction}`
    : // No requirement means "write it again" — saying so beats leaving it blank, which biases the
      // model towards copying the original back verbatim
      '要求:重新写这几条,查资料,把打法写到能照着做。';

  return (
    `这份攻略已经写好了,**这一轮只重写下面 ${entries.length} 条成就,别的一条都不要动、也不要输出**。\n\n` +
    `${ask}\n\n` +
    `要重写的是这 ${entries.length} 条,连同它们现在的写法:\n\n` +
    lines.join('\n\n') +
    '\n\n输出要求:\n' +
    `- 按上面的顺序输出这 ${entries.length} 条,每条一个顶层 \`- [ ]\` 行,放在一个 \`\`\`markdown 围栏里\n` +
    '- **不要写小节标题**,不要写别的成就,不要写开场白和结语 —— 程序会把它们贴回原来的位置\n' +
    // **Do not restate "sub-steps default to off" here.** Somebody naming a few entries for rewrite
    // most likely does so because those entries were not detailed enough, and this line would work
    // against the requirement they just gave — pointing back at the rules is enough, and the three
    // conditions decide the answer
    '- 子步骤缩进挂在自己那一条下面;嵌不嵌套照规则里那三个条件判\n' +
    '- 粗体成就名和清单一字不差、官方描述原文照抄、一律写 `- [ ]`(勾选状态由程序填)'
  );
}

/**
 * `buildPatchMessage` in English. **The original is shown in English too** - name order and
 * description column follow the guide's language, exactly as `buildAchievementListEn` does. Handing
 * the model the Chinese column under English rules is how a rewrite comes back in the wrong language
 * while every rule it was given was correct.
 */
function buildPatchMessageEn(entries, { instruction = null } = {}) {
  const lines = entries.map((e, i) => {
    const d = e.def;
    const cn = (d.name_cn ?? '').trim();
    const en = (d.name_en ?? '').trim();
    const title = cn && en && cn !== en ? `**${en}** / ${cn}` : `**${en || cn}**`;
    const desc = (d.description_en ?? '').trim() || (d.description ?? '').trim();
    const body = [
      `${i + 1}. ${title}`,
      `   Official description: ${desc || '(empty on Steam)'}`,
    ];
    body.push(`   Currently written: ${String(e.text ?? '').replace(/\n/g, ' ') || '(empty)'}`);
    return body.join('\n');
  });

  const ask = instruction
    ? `Requirement: ${instruction}`
    : 'Requirement: write these again — research them, and make the walkthrough something a reader can follow step by step.';

  return (
    `This guide is already written. **This round rewrites only the ${entries.length} achievements ` +
    'below — leave every other one alone, and do not output them.**\n\n' +
    `${ask}\n\n` +
    `These are the ${entries.length} to rewrite, with how they read at the moment:\n\n` +
    lines.join('\n\n') +
    '\n\nWhat to output:\n' +
    `- The ${entries.length} of them in the order above, one top-level \`- [ ]\` line each, inside one \`\`\`markdown fence\n` +
    '- **No section headings**, no other achievements, no preamble and no closing remarks — the program pastes these back where they came from\n' +
    '- Sub-steps are indented under their own entry; whether to nest at all is decided by the three conditions in the rules\n' +
    '- Bold achievement names match the list exactly, official descriptions are copied verbatim, and every line is `- [ ]` (tick state is filled in by the program)'
  );
}

/**
 * Which shards need rewriting. Located by `apiName` — `missing-checkbox` carries it, and that is
 * overwhelmingly how sharded generation fails (a whole shard never written / truncated).
 *
 * Findings that cannot carry an apiName (merged-line, say) cannot be located and so trigger no shard
 * rewrite; when the caller can locate no shard at all it falls back to rewriting everything, so
 * nothing is missed — it just costs a little more.
 */
export function chunksNeedingRewrite(blocking, chunks) {
  const need = new Set();
  for (const f of blocking) {
    if (!f.apiName || !MODEL_FIXABLE.has(f.code)) continue;
    const i = chunks.findIndex((c) => c.some((d) => d.api_name === f.apiName));
    if (i >= 0) need.add(i);
  }
  return [...need].sort((a, b) => a - b);
}

/** Turns the validation results into a rejection list for the model */
export function buildFeedback(findings, lang = 'zh') {
  if (lang === 'en') return buildFeedbackEn(findings);
  const fixable = findings.filter((f) => MODEL_FIXABLE.has(f.code));
  const shown = fixable.slice(0, 40);
  const more = fixable.length - shown.length;
  const lines = shown.map((f) => `${f.level === 'error' ? '✖' : '·'} ${f.message}`);
  return (
    '校验没过。下面是机器逐条查出来的问题:\n\n' +
    lines.join('\n') +
    (more > 0 ? `\n…… 另外还有 ${more} 条同类问题\n` : '') +
    '\n请输出**完整的修改后全文**(还是放在一个 ```markdown 围栏里),不要只给改动的部分。\n' +
    'checkbox 的勾选状态不用管,程序会填——你只要保证每个成就都有自己的 `- [ ]` 行、' +
    '粗体名字和清单一字不差、官方描述原文照抄。'
  );
}

/** `buildFeedback` in English. */
function buildFeedbackEn(findings) {
  const fixable = findings.filter((f) => MODEL_FIXABLE.has(f.code));
  const shown = fixable.slice(0, 40);
  const more = fixable.length - shown.length;
  const lines = shown.map((f) => `${f.level === 'error' ? '✖' : '·'} ${f.message}`);
  return (
    'Validation did not pass. Here is what the machine found, rule by rule:\n\n' +
    lines.join('\n') +
    (more > 0 ? `\n… and ${more} more of the same kind\n` : '') +
    '\nPlease output **the complete corrected guide** (again inside one ```markdown fence), not only the parts you changed.\n' +
    'Ignore the checkbox tick state, the program fills it in — what you have to get right is that every ' +
    'achievement has its own `- [ ]` line, that the bold names match the list exactly, and that the ' +
    'official descriptions are copied verbatim.'
  );
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/** Digs the markdown out of a reply. With several fences it takes the longest (the prose is always longer than a stray example) */
export function extractMarkdown(text) {
  const s = String(text ?? '').trim();
  const fences = [...s.matchAll(/```(?:markdown|md)?\n([\s\S]*?)```/g)];
  if (fences.length) return fences.map((m) => m[1]).sort((a, b) => b.length - a.length)[0].trim();

  // **An opening fence with no closing one**: the model forgot to close it, or the output was
  // truncated. The paired regex cannot match here, so the whole block — including the ```markdown
  // line itself — lands verbatim in the guide file, and **the validator cannot catch this**: that
  // line is neither a checkbox nor a violation of any rule, and 51/51 still comes back green.
  // Measured in practice (the 部落幸存者 guide)
  const open = s.match(/^```(?:markdown|md)?[ \t]*\n/);
  if (open) return s.slice(open[0].length).replace(/\n```[ \t]*$/, '').trim();
  return s;
}

/** An achievement line: `- [ ] **名字**<br>官方描述<br>心得`. Indented sub-steps count too */
const CHECKBOX_LINE_RE = /^(\s*[-*]\s*\[[ xX]\]\s*)(.*)$/;

/**
 * Collapses empty paragraphs inside an achievement line: `<br><br>` → `<br>`.
 *
 * **This is not typographic fussiness, it is the inevitable consequence of hidden achievements.**
 * The line format is three parts, name / official description / notes, and Steam **always returns an
 * empty description for a hidden achievement** — so the entry `buildAchievementList` gives the model
 * says 「官方描述:(Steam 上是空的)」, the model copies it verbatim per hard rule 4, copies an empty
 * string, and the middle part comes out empty. `notionblocks.js` turns each `<br>` into one `\n`,
 * and two in a row is **a jarring blank line between the achievement name and the notes** on the
 * page. Measured: 28 of 《罗曼圣诞探案集》's 50 achievements are hidden, so more than half the
 * entries carried that blank line.
 *
 * **Only checkbox lines are touched.** `<br>` is only defined for achievement lines in this format;
 * consecutive `<br>`s in an ordinary paragraph more likely mean the author really wanted a blank
 * line, and that is not ours to decide.
 *
 * **Only empty parts are removed; the surviving ones are not trimmed** — not one character the model
 * returned is altered, and all this does is take a part that does not exist out of the line.
 */
export function collapseEmptyBreaks(md) {
  return String(md ?? '')
    .split('\n')
    .map((line) => {
      const m = CHECKBOX_LINE_RE.exec(line);
      if (!m) return line;
      const parts = m[2].split(/<br\s*\/?>/i);
      const kept = parts.filter((p) => p.trim() !== '');
      // Nothing left at all (an empty checkbox) is left as it is: that is a different problem, and
      // lint reports it
      if (kept.length === parts.length || !kept.length) return line;
      return m[1] + kept.join('<br>');
    })
    .join('\n');
}

/**
 * Strips a title / appid line the model wrote itself.
 *
 * The prompt already says not to write them, but those two lines being program-generated is a
 * **structural guarantee** and cannot depend on the model complying: keeping one it wrote means a
 * duplicated title at best, and at worst a wrong appid registering the guide against another game.
 * `^#\s` matches only a level-one heading, so a section heading like `## 主线成就` is never removed
 * by mistake.
 */
export function stripLeadingHeader(md) {
  const lines = String(md ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === '' || /^appid:\s*\d+/i.test(l) || /^#\s+\S/.test(l)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n').trim();
}

/** The two lines the program writes. The `appid:` line is the only registration handle syncGuidesFromMarkdown recognises */
export function buildHeader(game, appid) {
  return `# ${game}\n\nappid: ${appid}\n`;
}

/** Whether a line is a section heading (`##` and deeper; `#` is the document title, written by the program) */
const headingOf = (line) => line.match(/^(#{2,6})\s+(.*\S)\s*$/);

/**
 * Joins the shards into one document, **merging duplicated section headings across seams on the way**.
 *
 * With the shards written concurrently the model cannot see what the others wrote, so the same
 * section gets opened once by each of two adjacent shards: achievements 1–50 and 51–100 both belong
 * to 「主线」, so both write a `## 主线` line. Joined up that is a heading with nothing under it
 * immediately followed by the same heading again — not one entry is missing, but it reads like the
 * categorisation broke.
 *
 * **Only "adjacent identical headings" are merged; no global deduplication happens.** The test is:
 * this shard's first heading line is exactly equal to the **last** heading in what has been joined so
 * far. A section genuinely returned to after others in between (which the game's own categorisation
 * permits) is untouched, because another heading sits in between by then.
 *
 * The level has to match too: `## 收集` and `### 收集` are two different things, and merging them
 * would lose the level.
 */
export function joinBodies(bodies) {
  const kept = bodies.filter(Boolean);
  if (kept.length <= 1) return kept.join('\n\n');

  const out = [];
  let lastHeading = null;
  for (const body of kept) {
    const lines = body.split('\n');
    // Find this shard's first heading (blank lines are allowed before it)
    let first = 0;
    while (first < lines.length && lines[first].trim() === '') first++;
    const opening = first < lines.length ? headingOf(lines[first]) : null;
    if (opening && lastHeading === `${opening[1]} ${opening[2]}`) {
      lines.splice(first, 1);
      // Remove the blank line right after the heading, so no jarring empty paragraph is left
      while (first < lines.length && lines[first].trim() === '') lines.splice(first, 1);
    }
    const text = lines.join('\n').trim();
    if (!text) continue;
    out.push(text);
    for (let k = lines.length - 1; k >= 0; k--) {
      const h = headingOf(lines[k]);
      if (h) { lastHeading = `${h[1]} ${h[2]}`; break; }
    }
  }
  return out.join('\n\n');
}


/**
 * Unwraps top-level toggles that **hold the achievements themselves**.
 *
 * **Rule five's toggle is for long content, not for the achievement list.** But rule five only says
 * "fold once the content reaches 10 lines", never "an achievement itself is never folded" —
 * measured on 《马特的寻猫游戏》, the 13 achievements of the whole `## 世界全清` section were stuffed
 * into a toggle called 「世界 1~12 全清与通关」, so that section showed 0 entries in Notion. Nothing
 * was functionally broken (the sync still recognised them), but a section that opens empty reads
 * like a bug.
 *
 * Two conditions must both hold before unwrapping; either one missing and it is left alone:
 *
 * 1. **The toggle is at top level (not indented).** A group-label toggle (prerequisites/steps/notes)
 *    is always indented under some achievement (see `groupLabelRule` and the SKILL.md examples), so
 *    an unindented one can only be a section-level long list.
 * 2. **It contains a checkbox that resolves back to a real achievement.** Sub-steps do not resolve —
 *    `resolveTodoToAchievement` requires either a full description match or an exact achievement
 *    name, both required to be unique, and does no prefix matching.
 *
 * The `<summary>` text is not lost; it drops to one bold line: it is that group's label, and once
 * the shell is gone something still has to say what this is.
 *
 * @param {string} text the prose
 * @param {any[]} defs
 * @returns {{text:string, unwrapped:string[]}} unwrapped holds the titles of the toggles that were unwrapped
 */
export function unwrapAchievementToggles(text, defs) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  const unwrapped = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top level only. An indented toggle is a group label hanging under some achievement, which is
    // what rule one asks for and must not be touched
    if (!/^<details\b/i.test(line)) { out.push(line); continue; }
    const close = detailsBlockEnd(lines, i);
    if (close === null) { out.push(line); continue; }

    const inner = lines.slice(i + 1, close);
    const holdsAchievement = parseTodos(inner.join('\n'))
      .some((t) => resolveTodoToAchievement(t.text, defs ?? []));
    if (!holdsAchievement) {
      out.push(...lines.slice(i, close + 1));
      i = close;
      continue;
    }

    /**
     * Extracts the `<summary>` label **by peeling tags, not by matching a whole line**: the model
     * has written both forms, all on one line and with the opening and closing tags on their own
     * lines. A whole-line regex only recognises the former, and on the latter leaves a bare
     * `<summary>` in the prose.
     */
    let label = null;
    const body = [];
    let inSummary = false;
    for (const raw of inner) {
      const t = raw.trim();
      if (!inSummary && !/^<summary\b/i.test(t)) { body.push(raw); continue; }
      inSummary = !/<\/summary\s*>/i.test(t);
      const piece = t.replace(/<\/?summary[^>]*>/gi, '').replace(/\*\*/g, '').trim();
      if (piece) label = label ? `${label} ${piece}` : piece;
    }
    // With the shell gone, everything inside is lifted one level — keeping the indent would make
    // parseTodos treat them as sub-steps hanging under somebody else
    const pad = body.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
    const cut = pad.length ? Math.min(...pad) : 0;
    if (label) { out.push(`**${label}**`, ''); unwrapped.push(label); }
    else unwrapped.push(msg('gen.untitledToggle'));
    out.push(...body.map((l) => (l.trim() ? l.slice(cut) : l)));
    i = close;
  }
  return { text: out.join('\n'), unwrapped };
}

/**
 * Rearranges the prose by an "achievement → section" mapping. **Now that classification moved to the
 * final pass, this is where it lands.**
 *
 * How it divides labour with `joinBodies`: that one only merges identical headings **at a seam** and
 * cannot move entries — it runs the moment the shards are written, when nobody has yet said "which
 * section does this belong in". This one is the reverse: the prose is finished, the classification
 * pass produced a mapping from the whole document, and so entries can really be moved into the
 * sections they belong in.
 *
 * **Losslessness is a hard requirement, not a best effort.** This codebase's tolerance for silently
 * dropping content is zero (`todoSpans`'s "eat one line too few, never one too many" is the same
 * rule). So there are two assertions at the exit:
 *
 *   1. the multiset of achievement api_names is exactly equal before and after — not one may be
 *      missing or duplicated
 *   2. every non-heading line of text occurs the same number of times before and after — section
 *      intros, tables and toggle blocks all included
 *
 * Failing either throws. **A misplaced entry is legible; a lost one is not**, so stopping here is
 * preferable.
 *
 * An achievement the mapping does not cover **stays in its original section**, neither discarded nor
 * dumped into a misc bucket: when the model misses one, "leave it where it is" is the only handling
 * that creates no new error.
 *
 * A section left with only its intro and no achievements at all is **kept**. It looks empty, but that
 * intro is prose, and no rule can say which achievement it should travel with — keeping it is a
 * visible blemish, dropping it is an invisible loss.
 *
 * @param {string} body the joined prose (without the `# 游戏名` / `appid:` lines)
 * @param {{defs:any[], assignment:Map<string,string>, sections?:string[]}} opts
 */
export function regroupByAssignment(body, { defs, assignment, sections = [] } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  const spans = todoSpansWithToggles(String(body ?? ''));

  /** Line number → the top-level achievement range starting on that line */
  const entryAt = new Map();
  for (const t of parseTodos(String(body ?? ''))) {
    if (t.parent !== null && t.parent !== undefined) continue;
    const span = spans.get(t.key);
    if (!span) continue;
    const hit = resolveTodoToAchievement(t.text, defs ?? []);
    entryAt.set(span.start, { apiName: hit?.def?.api_name ?? null, end: span.end });
  }

  const norm = (x) => String(x).replace(/\s+/g, '').toLowerCase();
  const order = [];
  const bucket = new Map();
  const preamble = [];
  const touch = (title, level = 2) => {
    const k = norm(title);
    if (!bucket.has(k)) {
      bucket.set(k, { level, title, prose: [], entries: [] });
      order.push(k);
    }
    return bucket.get(k);
  };

  const placed = [];
  /** Original section → { destination section → how many entries moved there }. Used by the orphaned-intro rule below */
  const movedFrom = new Map();
  /** Whether any achievement has been seen yet in the original — decides whether a pure-prose section sorts before or after the list, see head/tail below */
  let sawEntry = false;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (h) {
      cur = touch(h[2], h[1].length);
      cur.beforeEntries ??= !sawEntry;
      continue;
    }
    const e = entryAt.get(i);
    if (e) {
      sawEntry = true;
      const seg = lines.slice(i, e.end + 1);
      const dest = (e.apiName && assignment?.get?.(e.apiName)) || cur?.title || null;
      if (dest) {
        touch(dest).entries.push({ apiName: e.apiName, lines: seg });
        if (cur?.title) {
          if (!movedFrom.has(cur.title)) movedFrom.set(cur.title, new Map());
          const tally = movedFrom.get(cur.title);
          tally.set(dest, (tally.get(dest) ?? 0) + 1);
        }
      } else preamble.push(...seg);
      if (e.apiName) placed.push(e.apiName);
      i = e.end;
      continue;
    }
    /**
     * **A standalone toggle block is one unit and travels with its section whole.**
     *
     * A group toggle hanging under an achievement has already been enclosed in that achievement's
     * range by `todoSpansWithToggles` and never reaches here; what reaches here is a **section-level**
     * long-list toggle (rule five). The `- [ ]` inside it look top-level to `parseTodos` (there is no
     * shallower checkbox in front of them to hang from), so without a special case they would be
     * moved away one by one as separate achievements — leaving the toggle an empty shell with its
     * entries scattered outside.
     *
     * **Measured in practice**: 《破晓传奇》's 「12 个个人支线一览」 toggle under 「黎明之后」 was torn
     * into an empty shell plus 12 top-level checkboxes, and **neither losslessness assertion fired** —
     * they count text, and what was lost was structure. Which is why a third assertion was added
     * below.
     */
    if (/^<details\b/i.test(lines[i].trim())) {
      const close = detailsBlockEnd(lines, i);
      if (close !== null) {
        (cur ? cur.prose : preamble).push(...lines.slice(i, close + 1));
        i = close;
        continue;
      }
    }
    (cur ? cur.prose : preamble).push(lines[i]);
  }

  /**
   * **A section emptied out and left with only its intro: merge that intro into the section that
   * received the most of its entries.**
   *
   * The rule used to be "keep it", justified by no rule being able to say which section that intro
   * should travel with. **Running a real generation showed that justification does not hold**: after
   * 《破晓传奇》's 「羁绊」 was emptied, the page was left with a heading carrying one paragraph of
   * intro and not one achievement, sitting right after 「羁绊与对话」, which had taken every one of
   * its entries — which just reads like a bug. And "the section that received the most entries" is a
   * **definite** test, no guessing required.
   *
   * A section that never had entries (a pure-prose section) is untouched: there is no "most" there,
   * and keeping it is right.
   */
  for (const b of bucket.values()) {
    if (b.entries.length) continue;
    if (!b.prose.some((l) => l.trim())) continue;
    const tally = movedFrom.get(b.title);
    if (!tally?.size) continue;
    const best = [...tally].sort((x, y) => y[1] - x[1])[0][0];
    const target = bucket.get(norm(best));
    if (!target || target === b) continue;
    target.prose.push(...b.prose);
    b.prose = [];
  }

  const wanted = sections.map(norm).filter((k) => bucket.has(k));
  const seen = new Set(wanted);

  /**
   * **A section the classification list never mentioned stays on the side of the achievement list it
   * was already on.**
   *
   * The classification pass lists only sections holding achievements; it will not say one word about
   * a pure-prose section (rule 3.5's 「机制速查」). And anything unmentioned is appended at the end —
   * so a quick reference meant to sit **before** the list gets moved to the very end of the document,
   * dangling under the last achievement. **That is something meant to be read before the list, and
   * moving it to the end is the same as not writing it.**
   *
   * The test comes from the original text, no guessing: the heading appeared before any achievement
   * had been seen ⇒ it was before the list, and it stays before the list. That gets both directions
   * right — a closing 「备注」 was after the list originally and is still after it once rearranged.
   */
  const head = order.filter((k) => !seen.has(k) && bucket.get(k).beforeEntries);
  const tail = order.filter((k) => !seen.has(k) && !bucket.get(k).beforeEntries);
  const parts = [];
  const pre = preamble.join('\n').trim();
  if (pre) parts.push(pre);
  for (const k of [...head, ...wanted, ...tail]) {
    const b = bucket.get(k);
    const prose = b.prose.join('\n').trim();
    const entries = b.entries.map((e) => e.lines.join('\n')).join('\n').trim();
    if (!prose && !entries) continue;
    parts.push([`${'#'.repeat(b.level)} ${b.title}`, prose, entries].filter(Boolean).join('\n\n'));
  }
  const out = parts.join('\n\n');

  // ---- Assertion 1: not one achievement missing or duplicated ------------
  const before = [...entryAt.values()].map((e) => e.apiName).filter(Boolean).sort();
  const after = [...placed].sort();
  if (before.length !== after.length || before.some((x, i) => x !== after[i])) {
    throw msgError('gen.regroupLostAch', { before: before.length, after: after.length });
  }

  // ---- Assertion 2: every non-heading line of text is still there verbatim --
  const bag = (arr) => {
    const m = new Map();
    for (const l of arr) {
      const t = l.trim();
      if (!t) continue;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  };
  const inBag = bag(lines.filter((l) => !headingOf(l)));
  const outBag = bag(out.split('\n').filter((l) => !headingOf(l)));
  for (const [text, n] of inBag) {
    const got = outBag.get(text) ?? 0;
    if (got !== n) {
      throw msgError('gen.regroupLostText', { text: text.slice(0, 40), n, got });
    }
  }

  // ---- Assertion 3: no toggle block was hollowed out ----------------------
  // **The first two count text and cannot count structure.** Tearing a toggle into "an empty shell
  // plus entries scattered outside" loses not one character, and assertions 1 and 2 both stay green
  // — which is exactly how the 破晓传奇 case slipped through
  const toggleBodies = (arr) => {
    const got = [];
    for (let i = 0; i < arr.length; i++) {
      if (!/^<details\b/i.test(arr[i].trim())) continue;
      const close = detailsBlockEnd(arr, i);
      if (close === null) continue;
      got.push(arr.slice(i + 1, close).map((l) => l.trim()).filter(Boolean).join('\u0001'));
      i = close;
    }
    return got.sort();
  };
  const tIn = toggleBodies(lines);
  const tOut = toggleBodies(out.split('\n'));
  if (tIn.length !== tOut.length || tIn.some((x, i) => x !== tOut[i])) {
    throw msgError('gen.regroupBrokeToggles', { in: tIn.length, out: tOut.length });
  }

  return out;
}

/**
 * Reads the prose's current sectioning: which section each achievement sits in, and the order the
 * sections appear in.
 *
 * This is the most valuable single item in the classification pass's **input** — it encodes the
 * model's understanding of each achievement **after doing the research and writing the prose**, and
 * a pass before the prose exists (holding only achievement names) simply cannot obtain it.
 */
export function readAssignment(body, defs) {
  const lines = String(body ?? '').split(/\r?\n/);
  const spans = todoSpansWithToggles(String(body ?? ''));
  const starts = new Map();
  for (const t of parseTodos(String(body ?? ''))) {
    if (t.parent !== null && t.parent !== undefined) continue;
    const span = spans.get(t.key);
    const hit = resolveTodoToAchievement(t.text, defs ?? []);
    if (span && hit) starts.set(span.start, hit.def.api_name);
  }

  const assignment = new Map();
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (h) {
      cur = h[2];
      if (!sections.includes(cur)) sections.push(cur);
      continue;
    }
    const api = starts.get(i);
    if (api && cur) assignment.set(api, cur);
  }
  return { assignment, sections };
}

/** The classification pass's system prompt. **No network** — the prose is already written, and this pass only groups. */
export const REGROUP_SYSTEM =
  '你在给一份已经写好的 Steam 成就攻略重排小节。只输出分组结果,' +
  '不要解释、不要复述正文、不要改写任何成就的文字。';

/** `REGROUP_SYSTEM` in English. */
export const REGROUP_SYSTEM_EN =
  'You are re-sectioning a Steam achievement guide that is already written. Output the grouping ' +
  'only: no explanation, no restating the prose, no rewording of any achievement.';

/**
 * Which of the two the classification pass runs under. **It has to be the guide's language, not the
 * interface's** — the pass decides the guide's final section headings, so a Chinese system prompt
 * over an English guide renames every section into Chinese and the validator, which checks format
 * and data and never content, passes it.
 */
export function regroupSystemFor(lang) {
  return lang === 'en' ? REGROUP_SYSTEM_EN : REGROUP_SYSTEM;
}

/**
 * The classification pass's prompt. **Runs after the prose is written**, which is the whole
 * difference from "classify up front from names alone":
 *
 * - The up-front pass has only achievement names. Games whose names are jokes (「海拉鲁老流氓」 =
 *   smash 100 pots) defeat it: measured, 《马特的寻猫游戏》 produced thematic headings like
 *   「自然与美食」 and 「囤积狂的自我修养」, and split four same-kind 「替换吉祥物」 entries across two
 *   sections.
 * - This pass has the names, the official descriptions, **and each shard's own sectioning** — which
 *   is a judgement made after the research. The split has already happened, so it can see it, and
 *   therefore undo it.
 *
 * Achievements are identified by number rather than name: a name has to match to the letter to be
 * matched at all (duplicates, punctuation, full/half-width can each defeat it), a number cannot.
 */
export function buildRegroupPrompt(game, defs, current, clusters = [], lang = 'zh') {
  if (lang === 'en') return buildRegroupPromptEn(game, defs, current, clusters);
  const hi = Math.min(14, Math.max(6, Math.round(defs.length / 10)));
  const lo = Math.max(4, Math.round(hi * 0.6));
  const rows = defs.map((d, i) => {
    const sec = current.assignment.get(d.api_name);
    return `${i + 1}. ${defName(d)} — ${d.description || '(无描述)'}${sec ? `  [现在在:${sec}]` : ''}`;
  }).join('\n');
  return (
    `《${game}》的攻略正文已经写完了,一共 ${defs.length} 个成就。\n` +
    '各段是并发写的、互相看不见,所以现在的分节是各段各自决定的,需要统一一遍。\n\n' +
    '请通读下面的名单(带官方描述和它现在所在的小节),给出最终分节。\n\n' +
    `- **${lo}–${hi} 个小节**\n` +
    '- 标题按**这个游戏实际要做的事**来取,不是按成就名的字面意思 —— ' +
    '成就名常是梗(「海拉鲁老流氓」其实是打碎罐子),按描述判断\n' +
    '- **同一类事必须在同一个小节里。** 现在被拆到两个小节的同类成就,合到一处\n' +
    clusterConstraint(defs, clusters) +
    '- 现在的分节大体合理的话就沿用,不要为了改而改\n' +
    '- **每个编号都要出现且只出现一次**,一个都不能漏\n\n' +
    '输出格式(严格照这个,不要别的):\n' +
    '```\n== 小节标题\n3\n7\n12\n== 另一个小节\n1\n2\n```\n\n' +
    `---\n\n${rows}`
  );
}

/**
 * `buildRegroupPrompt` in English. Three things change with the language, and leaving any one of
 * them behind is enough to get Chinese headings on an English guide:
 *
 * - the instructions themselves, including **an explicit "answer in English"** — every other rule in
 *   the English fork says which language to write in (`rulesEnFor`: "the entries, the section
 *   headings and your own notes are all English"), and this pass overwrites exactly those headings
 * - the **name** shown per row, which follows the guide's language rather than the interface's
 * - the **description** shown per row: `description_en` where the game has one. Handing the model
 *   the Chinese column is how a heading comes back naming a Chinese term the guide never uses —
 *   measured on Delta Force, where every description mentioning the mode has a complete English one
 *   saying "Operations" (issue #121)
 */
function buildRegroupPromptEn(game, defs, current, clusters = []) {
  const hi = Math.min(14, Math.max(6, Math.round(defs.length / 10)));
  const lo = Math.max(4, Math.round(hi * 0.6));
  const rows = defs.map((d, i) => {
    const sec = current.assignment.get(d.api_name);
    const desc = (d.description_en ?? '').trim() || (d.description ?? '').trim();
    return `${i + 1}. ${defNameIn(d, 'en')} — ${desc || '(no description)'}${sec ? `  [currently in: ${sec}]` : ''}`;
  }).join('\n');
  return (
    `The body of the guide for ${game} is written; there are ${defs.length} achievements in all.\n` +
    'The parts were written concurrently and could not see one another, so the sections as they ' +
    'stand were each decided in isolation and need reconciling.\n\n' +
    'Read the list below (each with its official description and the section it is in at the ' +
    'moment) and give the final sectioning.\n\n' +
    `- **${lo}–${hi} sections**\n` +
    '- Title them by **what this game actually asks the player to do**, not by the literal wording ' +
    'of the achievement name — names are often jokes ("Hyrule Hooligan" is really about smashing ' +
    'pots), so judge by the description\n' +
    '- **Write the section titles in English**, like the rest of the guide\n' +
    '- **Things of the same kind must be in one section.** Where achievements of one kind are ' +
    'currently split across two sections, put them together\n' +
    clusterConstraint(defs, clusters, 'en') +
    '- Where the sectioning as it stands is broadly right, keep it; do not change it for the sake of changing it\n' +
    '- **Every number appears exactly once**, with none left out\n\n' +
    'Output format (exactly this, nothing else):\n' +
    '```\n== Section title\n3\n7\n12\n== Another section\n1\n2\n```\n\n' +
    `---\n\n${rows}`
  );
}

/**
 * Parses the classification reply: `== 标题` opens a section, and the bare numbers under it are
 * achievement indices (1-based).
 *
 * **Missing numbers are not filled in and not guessed.** What the caller receives is a possibly
 * incomplete mapping, and `regroupByAssignment` handles an uncovered achievement by "leave it in its
 * original section" — the only fallback that creates no new error. Doing something clever here to
 * complete it would only turn the model's oversight into our mistake.
 */
export function parseRegroupReply(text, defs) {
  const sections = [];
  const assignment = new Map();
  let cur = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^==\s*(.+\S)\s*$/);
    if (head) {
      cur = head[1].replace(/^#+\s*/, '').trim();
      if (cur && !sections.includes(cur)) sections.push(cur);
      continue;
    }
    const n = line.match(/^[-*]?\s*(\d{1,4})\s*[.、]?\s*$/);
    if (!n || !cur) continue;
    const d = defs[Number(n[1]) - 1];
    // An out-of-range number is simply ignored: the model miscounting must not become an achievement
    // filed somewhere else
    if (d && !assignment.has(d.api_name)) assignment.set(d.api_name, cur);
  }
  return { sections, assignment };
}

export function guideFileName(game, appid) {
  const slug = String(game ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${slug.length >= 3 ? slug : `app_${appid}`}_achievements.md`;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

/**
 * Generates a guide.
 *
 * @param {object}   db
 * @param {object}   o
 * @param {object}   o.config
 * @param {object}   o.provider   a provider from lib/ai.js
 * @param {object}   o.steam      SteamClient — mechanical ticking needs the real unlock state
 * @param {string}   o.appid
 * @param {number}   [o.rounds]   how many rewrite rounds at most (default 3)
 * @param {string}   [o.fileName] overrides the default file name
 * @param {Function} [o.onProgress]
 * @returns {Promise<object>} {ok, path, draftPath, rounds, lint, usage, blocking, expected, registered}
 */
export async function generateGuide(db, {
  config,
  provider,
  steam,
  appid,
  rounds = 3,
  fileName = null,
  notion = null,
  local = false,
  overwrite = false,
  plan: given = null,
  onProgress = () => {},
  // Cancels the run — see the Dashboard's Cancel button in lib/server.js. Threaded only into
  // `provider.send()` calls, never into local file writes or the Notion landing at the end: those
  // are not what is expensive here, and aborting mid-write is a worse failure than letting a few
  // hundred milliseconds of local work finish. A shard whose request is torn down rejects with an
  // AiError carrying `cancelled: true`, which `askChunk`'s rung ③ already rethrows immediately
  // (it has no `.code`, so it is neither retryable, splittable, nor CHUNK_LOCAL) — cancellation
  // needed no new branch in the retry ladder, only a signal to reach it.
  signal = null,
}) {
  // 0 rounds or NaN would make the loop below run not once, so "no blocking findings" gets read as
  // "it passed", and then a draft that does not exist gets copied. Catching it here beats guessing
  // at an ENOENT later
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw msgError('gen.badRounds', { rounds });
  }

  // The plan may be passed in: the CLI has to obtain a plan first to compute the diff preview and ask
  // the user before starting, and re-planning would both spend extra API calls and leave a gap where
  // "the one asked about" and "the one written" are not the same plan
  const plan = given ?? (await planGuide(db, { config, steam, appid, fileName, notion, local, overwrite }));
  const { defs, game, unlocked, finalPath, draftPath } = plan;

  // A provider with no network access gets a different set of research requirements. The design doc
  // makes "has server-side search" a hard admission criterion, enforced at the CLI layer; if it is
  // really run anyway (--no-research) it still must not pretend there is anything to look up
  const canSearch = provider.canSearch !== false;
  const system = systemPromptFor(plan, appid, { canSearch });
  // The web tools are declared by the provider itself: their shapes differ completely per vendor, and
  // this orchestration layer should not know them
  /**
   * **One session per top-level shard, not one shared across the whole document.**
   *
   * What a shared session buys is "the model can see what it wrote earlier", and the price is that
   * **the shards can only run in series**: one session is one chain, so shard 4 has to wait for
   * shards 1–3. Measured, that chain is the entire elapsed time — one shard of 10 achievements takes
   * one or two hundred seconds, so 197 achievements in four shards is half an hour, nearly all of it
   * the model thinking.
   *
   * With one session per shard there is no dependency between shards and they can be sent at once.
   * The little cross-shard visibility that is lost has two matching compensations, neither of which
   * relies on the model's discretion:
   *
   * - **Achievements cannot be duplicated**: each shard's prompt names the index range and the first
   *   and last achievement it must write, and the shards are disjoint. That was always a structural
   *   guarantee and never depended on seeing the other shards.
   * - **Section headings will be duplicated**, and that really does happen: two adjacent shards both
   *   belonging to 「主线」 each write a `## 主线` line. So the prompt was changed to "open the
   *   heading", and `joinBodies` merges adjacent identical headings at join time. The old prompt's
   *   "do not write the section heading again" is harmful under concurrency — see buildChunkMessage.
   *
   * One incidental benefit: with a shared session every request has to resend **all the previous
   * shards' prose along with their thinking**, and by shard 4 of 197 achievements the context is well
   * over a hundred thousand characters. With independent shards each chain carries only its own.
   */
  const sessions = [];
  const sessionFor = (s) =>
    (sessions[s] ??= createSession(provider, { system, tools: provider.webTools() }));
  /**
   * Sessions belonging to no shard. **A separate list because `sessions` is indexed by shard
   * number** — appending to it would hand shard N a session built for something else.
   *
   * They are collected for one reason: the `usage` total at the end is what the run cost, and a
   * session missing from it is spend the user paid for and never sees.
   */
  const asideSessions = [];

  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });

  let lint = null;
  let blocking = [];
  let expected = [];
  let round = 0;
  // The search terms the model actually issued this run. **Can search ≠ did search** — declaring the
  // tools and never searching once means what was generated came from memory, and that is exactly the
  // silent quality difference the canSearch design exists to prevent
  const searchQueries = [];
  // Written in shards when it will not fit in one. One session per shard, run concurrently — see the
  // sessionFor block above
  let chunks = chunkDefs(defs, config.ai?.chunkSize ?? 50);
  /**
   * The entries they have already unlocked get one line only — see `briefApiNames`.
   *
   * **An overwrite saves nothing.** By then the guide holds prose that was paid for, and "they have
   * since unlocked this one" is not a reason to delete that text — it is something they paid for,
   * and once deleted there is nowhere to get it back from. So only a newly written guide writes
   * briefly.
   */
  const brief = overwrite ? new Set() : briefApiNames(defs, unlocked);
  /**
   * **There is exactly one exit for asking what a shard should write.** With the two call sites (the
   * round-1 shard path, and the later rounds filling in a shard that never got written) each writing
   * their own `buildChunkMessage(..., brief)`, the one that forgets the argument raises no error and
   * loses no content — it just quietly drops that shard's brief-entry list, and it happens to be the
   * hardest path to test (reachable only after a whole shard has failed). Bind it once and neither
   * side gets the chance to forget.
   */
  const chunkMessage = (cs, at) => buildChunkMessage(cs, at, brief, plan.lang);
  let bodies = [];

  /**
   * Round 1's workspace: **each top-level shard's own list of sub-shards**.
   *
   * **Splitting must not be written as `chunks.splice(i, 1, a, b)`**, which mutates the global array
   * directly. That is fine running in series, since only one loop walks it; under concurrency it is
   * shared mutable state — shard 2 splitting throws off the indices of shards 3 and 4 while they are
   * running, and **nothing raises an error**, it just makes the numbers in the prompt, the shard
   * number in a failure report and the next round's rewrite targets all wrong in different ways.
   *
   * So splitting was changed to touch only its own slot: `shardChunks[s]` is which pieces shard s was
   * cut into. After round 1 they are flattened into `chunks` in order — flattening is deterministic
   * (by s, then by sub) and independent of which shard finished first. `shardBodies` aligns with it
   * slot for slot, and a failed slot holds `null` rather than being left out, or after flattening the
   * prose and the shards would be off by one.
   */
  const shardChunks = chunks.map((c) => [c]);
  const shardBodies = chunks.map(() => [null]);
  /** After flattening: which top-level shard flat shard j belongs to — a rewrite round needs that chain's session */
  let sessionOwner = chunks.map((_, s) => s);

  /**
   * How many shards run at once. The default of 3 is conservative: one chain per shard, and 3 at once
   * already covers the common 2–4 shards in one pass, while concurrency mostly consumes the provider's
   * rate-limit budget (a 429 goes down the maxRetries backoff path and never loses a shard).
   * Set it to 1 to get the old sequential behaviour, which is useful when debugging.
   */
  const concurrency = Math.max(1, Math.floor(Number(config.ai?.concurrency) || 3));

  /** The prompt has to report "how many shards, and which one this is", while other shards are splitting concurrently. Single-threaded, so what is read is always a complete value */
  const viewOf = (s, sub) => ({
    view: shardChunks.flat(),
    index: shardChunks.slice(0, s).reduce((n, subs) => n + subs.length, 0) + sub,
  });

  onProgress({ phase: 'plan', chunks: chunks.length, achievements: defs.length });

  /**
   * **Each shard opens its own section headings; they are not given a unified list while writing**
   * (classification is the job of the pass after everything is written, see `phase: 'regroup'` below).
   *
   * Fixing the list up front means that pass holds **only achievement names**, and games whose names
   * are jokes defeat it right there: 《马特的寻猫游戏》's 「海拉鲁老流氓」 is really smashing 100 pots
   * and 「半条命4」 is prising containers open with a crowbar, and classifying by name alone produces
   * 「自然与美食」 and 「囤积狂的自我修养」; adding descriptions and running it again still loses a
   * genuinely important structure like 「难度模式」. **The information is missing, not the prompt.**
   *
   * So duplicates at the seams are merged by `joinBodies`, and the real categorisation waits for the
   * final pass — by which time the names, the descriptions, each shard's own judgement and the
   * researched prose are all in hand.
   */

  /**
   * **Every finished shard is written to disk immediately.**
   *
   * The draft used to be written only **after** the whole shard loop finished, so any shard failing
   * midway threw away the earlier shards along with their web research — which is something the user
   * has already paid for. Measured: KINGDOM HEARTS -HD 1.5+2.5 ReMIX- (197 achievements in 4 shards),
   * shard 3 failed, `guides/.drafts/` was empty, and not one word of the first two shards' minutes of
   * research survived.
   *
   * Writing into `.drafts/` is safe: `syncGuidesFromMarkdown` is a non-recursive readdir and cannot
   * see that subdirectory (see the file header comment), so half a draft can never be registered as a
   * guide.
   */
  // Round 1 reads the workspace (shards may still be splitting); later rounds read the flattened
  // bodies. Under concurrency every finished shard writes to disk once, and what it writes is **every
  // shard obtained so far** — so a blow-up midway still keeps the part that has been paid for.
  const liveBodies = () => (round <= 1 ? shardBodies.flat() : bodies);
  const writeDraft = () =>
    writeFileSync(
      draftPath,
      buildHeader(game, appid) + '\n' + joinBodies(liveBodies()) + '\n'
    );

  /**
   * The shards that could not be written at all this round. **Recorded, not thrown.**
   *
   * Discarding the whole guide over one failed shard trades "one shard short" for "nothing at all" —
   * while the missing shard has a ready-made recovery path: every one of its achievements will be
   * reported by the validator as `missing-checkbox` (carrying apiName), so `chunksNeedingRewrite`
   * picks exactly that shard out and the next round re-asks only it. That machinery already exists,
   * written for sharded generation's number-one failure mode (a whole shard never arriving).
   *
   * Cleared at the start of each round: it describes the **final** state, not the history. A shard
   * that failed in round 1 and was filled in during round 2 must not still hang here, or the report
   * would say a shard is missing when it is actually in the file.
   */
  const chunkFailures = [];
  /** The original error to throw when everything failed — reporting "197 achievements are missing checkboxes" is treating the symptom as the cause */
  let firstChunkError = null;

  /**
   * Which shards (by index) the later rounds ask about. **Round 1 does not look at it** — round 1 is
   * "walk it from start to finish", and the shard count can change during that walk (truncation
   * splits one shard into two), so that round follows chunks' current length rather than fixing the
   * indices in advance
   */
  let targets = [];

  // Named `prompt`, not `msg`: this file also composes user-facing messages through msg() now,
  // and one identifier meaning both "what we send the model" and "what we say to the user" is a
  // shadowing bug waiting to happen — it was exactly that, for one commit
  const ask = async (session, prompt, label) => {
    const reply = await session.ask(prompt, {
      signal,
      onEvent: (ev) => {
        // Generic progress events; knows no vendor's raw format
        if (ev.type === 'tool') onProgress({ phase: 'tool', round, name: ev.name, label });
        else if (ev.type === 'search') {
          onProgress({ phase: 'tool', round, name: msg('gp.searchQuery', { query: ev.query }), label });
        }
      },
    });
    for (const q of reply.searchQueries ?? []) if (!searchQueries.includes(q)) searchQueries.push(q);
    // A refusal, a max_tokens truncation and a tool error are all HTTP 200. This has to ask before
    // using the prose, max_tokens above all — half a guide looks perfectly normal, and the validator
    // only reports "every achievement in the second half is missing its checkbox"
    const verdict = checkResult(reply);
    if (!verdict.ok) {
      const err = new Error(label
        ? msg('gen.roundFailedLabelled', { round, label, reason: verdict.reason })
        : msg('gen.roundFailed', { round, reason: verdict.reason }));
      // Lets the code above tell whether this failure is recoverable. **Uses the code, never the
      // reason text** — treating human prose as an interface means a rewording silently breaks it
      err.code = verdict.code;
      throw err;
    }
    // Non-blocking degradations (in practice, a failed page fetch) still have to show, or it is
    // exactly the silent degradation this project guards against most. It rides the existing tool
    // phase, which both the CLI and the Dashboard already display, so no new pipeline is needed
    // Composed here on purpose: this one is a progress label, covered by the next line seconds
    // later. The copy that has to survive travels to `warn` in lib/server.js as its key
    for (const w of verdict.warnings) {
      onProgress({ phase: 'tool', round, name: `⚠️ ${msg(w.key, w.values)}`, label });
    }
    return collapseEmptyBreaks(stripLeadingHeader(extractMarkdown(reply.text)));
  };

  /**
   * One shard's retry ladder: ask again verbatim → split in half → record it and let it go. **All
   * three rungs live in this inner loop** rather than looping back through the outer `continue` —
   * that way "how many times has this shard been asked" would have to hang outside, and that counter
   * should reset after a split, so two things tangled in one variable would eventually go wrong.
   *
   * `locate()` outsources "which shard am I" and "how many are there", because those two numbers are
   * computed completely differently in round 1 (concurrent, with other shards still splitting) and in
   * later rounds (fixed indices), while the ladder itself has no interest in that.
   */
  const askChunk = async ({ session, chunkAt, setChunks, setBody, locate, prompt }) => {
    let attempt = 0;
    for (;;) {
      const { index, total } = locate();
      const label = total > 1 ? msg('gp.segmentLabel', { n: index + 1, of: total }) : '';
      // **`done` is the only progress figure still readable under concurrency.** With three shards
      // writing at once, "which shard is current" jumps between 1/4, 3/4 and 2/4 every few seconds,
      // looking like progress going backwards. How many shards are finished is monotonic, and it
      // holds equally well running in series, so both modes share one wording
      onProgress({
        phase: 'ask', round, rounds, chunk: index + 1, chunks: total,
        done: liveBodies().filter(Boolean).length,
      });
      try {
        setBody(await ask(session, prompt(index, total), label));
        return null;
      } catch (err) {
        // **Dropping that turn is a precondition for every rung below, not a tidy-up.** A discarded
        // draft (half a shard, or an empty assistant turn) left in the context, combined with a
        // re-ask prompt saying "do not repeat achievements already written", makes the model skip the
        // ones it half-wrote — producing output that looks normal but is missing entries
        session.dropLastTurn();

        // ① empty reply ⇒ ask again verbatim. See canRetry
        if (canRetry(err, attempt)) {
          attempt++;
          onProgress({
            phase: 'retry', round, chunk: index + 1, chunks: total,
            attempt, of: EMPTY_RETRIES, reason: err.code,
          });
          continue;
        }

        // ② Halve it and re-ask only those two halves.
        //
        // This uses **what actually happened**, not an estimate made before starting — what goes into
        // one request is thinking + prose, and thinking varies by game, model and endpoint. Any
        // "work out the right shard size up front" approach is predicting that quantity; the failure
        // itself is measuring it.
        // Each split at least halves, so it necessarily converges to MIN_CHUNK within a few steps and
        // no additional attempt cap is needed
        if (setChunks && canSplit(err, round, chunkAt())) {
          const cur = chunkAt();
          const half = Math.ceil(cur.length / 2);
          setChunks(cur.slice(0, half), cur.slice(half));
          onProgress({
            phase: 'resplit', round, chunk: index + 1, chunks: locate().total,
            from: cur.length, to: half, reason: err.code,
          });
          attempt = 0; // different, smaller content, so the retry count starts over
          continue; // same position again, and it is now the first half
        }

        // ③ A global failure is rethrown verbatim — see CHUNK_LOCAL. **Letting a shard go presupposes
        //    the problem is that shard's own**, and a broken provider is not
        if (!CHUNK_LOCAL.has(err?.code)) throw err;

        // ④ Out of moves. **This shard is written off, the whole guide is not** — see chunkFailures
        const cur = chunkAt();
        const failed = chunkFloorAdvice(err, round, cur);
        // **On failure, setBody is not touched.** In round 1 that slot was initialised to null
        // anyway; in a rewrite round it holds the prose written last round, and wiping it would mean
        // throwing away a usable version because it "could not be improved". Both cases require doing
        // nothing here, so nothing is done here
        onProgress({
          phase: 'chunk-failed', round, chunk: index + 1, chunks: total,
          count: cur.length, reason: failed.message,
        });
        return {
          count: cur.length,
          first: defName(cur[0]),
          last: defName(cur[cur.length - 1]),
          code: failed.code ?? null,
          reason: failed.message,
          error: err,
        };
      }
    }
  };

  /**
   * Bounded concurrency. **After a blow-up no new work is dispatched, but the ones already in flight
   * are awaited.**
   *
   * The sequential version's "throw a global failure on the spot" saved the cost of hitting the same
   * wall once per remaining shard. The concurrent version cannot do it on the spot: the requests are
   * already out and cannot be cancelled. What it can do is **stop dispatching**, so at worst
   * `limit - 1` more hit the wall instead of every shard — which is the entire reason it exists.
   */
  const runPool = async (n, limit, worker) => {
    let next = 0;
    let stop = false;
    // **Throws the one with the lowest shard number, not "whichever blew up first".**
    // A 401 makes every in-flight request fail together, and which of them rejects first depends on
    // network timing — so with "whichever was first" the same input can report different causes on
    // two runs, and the first thing to suspect while debugging differs.
    // The same reasoning as firstChunkError picking the lowest shard number below
    const failures = [];
    const lane = async () => {
      for (;;) {
        if (stop) return;
        const i = next++;
        if (i >= n) return;
        try {
          await worker(i);
        } catch (err) {
          failures.push({ i, err });
          stop = true; // no new work dispatched; the ones in flight still finish
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, n) }, lane));
    if (failures.length) throw failures.sort((a, b) => a.i - b.i)[0].err;
  };

  for (round = 1; round <= rounds; round++) {
    // Describes the final state, not the history — see the comment on chunkFailures
    chunkFailures.length = 0;

    if (round === 1) {
      // ---- Round 1: shards run concurrently, each on its own chain ----
      //
      // Failures are recorded against `{s, sub}` first and **converted to shard numbers after
      // flattening**. Under concurrency "the current index" is shifted by other shards' splits, so a
      // shard number computed on the spot may not match the final file — the sequential version
      // guaranteed it by "splitting only happens at the current index and the loop only moves
      // forward", and that premise is gone
      const pending = [];
      await runPool(shardChunks.length, concurrency, async (s) => {
        for (let sub = 0; sub < shardChunks[s].length; sub++) {
          const failure = await askChunk({
            session: sessionFor(s),
            chunkAt: () => shardChunks[s][sub],
            setChunks: (a, b) => {
              shardChunks[s].splice(sub, 1, a, b);
              shardBodies[s].splice(sub, 1, null, null);
            },
            setBody: (text) => { shardBodies[s][sub] = text; },
            locate: () => {
              const { view, index } = viewOf(s, sub);
              return { index, total: view.length };
            },
            prompt: () => {
              const { view, index } = viewOf(s, sub);
              return chunkMessage(view, index);
            },
          });
          if (failure) pending.push({ s, sub, ...failure });
          // Write to disk the moment it arrives. **Outside askChunk** — a write failure (disk full,
          // permissions) is a fault on our side, not "the model did not write this shard", and must
          // not be treated as the latter by that retry ladder
          if (shardBodies[s][sub]) writeDraft();
        }
      });

      // Flatten: the order is determined solely by (s, sub), independent of who finished first
      chunks = shardChunks.flat();
      bodies = shardBodies.flat();
      sessionOwner = shardChunks.flatMap((subs, s) => subs.map(() => s));
      const flatIndex = (s, sub) =>
        shardChunks.slice(0, s).reduce((n, subs) => n + subs.length, 0) + sub;
      for (const f of pending) {
        chunkFailures.push({
          chunk: flatIndex(f.s, f.sub) + 1, of: chunks.length,
          count: f.count, first: f.first, last: f.last, code: f.code, reason: f.reason,
        });
      }
      // The original error to throw when everything failed. **Takes the lowest shard number**, never
      // "the first one thrown" — under concurrency which blows up first depends on network timing, so
      // the same input can report different causes on two runs
      const firstFailed = pending.slice().sort((a, b) => a.s - b.s || a.sub - b.sub)[0];
      firstChunkError ??= firstFailed?.error ?? null;
    } else {
      // ---- Later rounds: targeted rewrites from the validation results, run in series ----
      //
      // **Deliberately not concurrent.** A rewrite round usually has only one or two shards, so there
      // is little to save; and a shard that was split shares its top-level shard's session (a rewrite
      // needs exactly "the version you wrote last time"), so concurrency would have two requests
      // using one session at once — messages is shared mutable state and interleaving corrupts it.
      // Small gain, dirty failure mode; not worth the trade
      for (const i of targets) {
        const failure = await askChunk({
          session: sessionFor(sessionOwner[i]),
          chunkAt: () => chunks[i],
          setChunks: null, // rewrite rounds do not split: targets was computed against current indices, and changing the shard count invalidates it
          setBody: (text) => { bodies[i] = text; },
          locate: () => ({ index: i, total: chunks.length }),
          prompt: () =>
            // **This shard holds nothing yet ⇒ use the original "write this shard" message.** Using
            // buildChunkFeedback to ask about content that was never written means throwing fifty
            // "missing checkbox" findings at it — while what the model lacks is not corrections, it
            // is the shard itself
            bodies[i]
              ? buildChunkFeedback(lint.findings, chunks, i, plan.unnameable, plan.lang)
              : chunkMessage(chunks, i),
        });
        if (failure) {
          chunkFailures.push({
            chunk: i + 1, of: chunks.length,
            count: failure.count, first: failure.first, last: failure.last,
            code: failure.code, reason: failure.reason,
          });
          firstChunkError ??= failure.error;
        }
        if (bodies[i]) writeDraft();
      }
    }

    // **Not one shard written ⇒ a hard failure, and the first real cause has to be thrown.**
    // Carrying on would validate an empty draft, report "every achievement is missing its checkbox",
    // and then spend two more rounds re-asking — the symptom covering the cause, at the price of two
    // extra rounds
    if (chunkFailures.length && !bodies.some(Boolean)) throw firstChunkError;

    onProgress({ phase: 'check', round });
    // Only the joined shards are a complete guide. **Ticking and validation are always done against
    // that complete version** — validating shard by shard would miss cross-shard problems like a
    // duplicated achievement or a duplicated section heading entirely
    writeDraft();

    // Mechanical ticking: the model writes only `- [ ]`, and this ticks what should be ticked from the
    // database
    const keys = computeCheckedKeys({ todos: loadTodos(draftPath), defs, unlockedApiNames: unlocked });
    applyChecks(draftPath, keys);

    const text = readFileSync(draftPath, 'utf8');
    lint = lintGuide({
      todos: loadTodos(draftPath),
      defs,
      text,
      unlockedApiNames: unlocked,
      kind: 'local',
    });

    ({ blocking, expected } = splitFindings(lint.findings, plan.unnameable));
    onProgress({ phase: 'lint', round, blocking: blocking.length, ticked: keys.length });
    if (!blocking.length) break;

    // The last round has no feedback to organise; fall straight through to the "did not pass" report
    // below
    if (round >= rounds) break;

    // Only what the model can fix is fed back. A checked-mismatch reaching here means our own ticking
    // is broken, and asking the model to fix it only makes it start writing `- [x]` by guesswork; nor
    // would more rounds help, so stopping here and saying so plainly is better
    if (!blocking.some((f) => MODEL_FIXABLE.has(f.code))) {
      throw msgError('gen.nothingModelCanFix', {
        path: draftPath,
        problems: blocking.map((f) => f.message).join('\n  '),
      });
    }

    // The next round re-asks **only the shards with problems**. A whole-document rewrite is simply
    // not viable when sharded (a few hundred achievements cannot be output at once, which is the
    // reason for sharding), and it would re-roll the dice on paragraphs that were already right. When
    // no shard can be located it falls back to rewriting all of them — the old behaviour from when
    // there was one shard
    targets = chunksNeedingRewrite(blocking, chunks);
    if (!targets.length) targets = chunks.map((_, i) => i);
    onProgress({ phase: 'rewrite', round: round + 1, chunks: targets.length, of: chunks.length });
  }

  /**
   * ---- Dig the achievements out of the toggles they were hidden in ---------
   *
   * **Done before the rearrangement, not after.** `regroupByAssignment`'s third assertion compares
   * toggle contents, and hollowing a toggle out would immediately be judged "a toggle was torn open"
   * and roll the whole pass back — that assertion is right, and what it guards against is the
   * rearrangement tearing toggles itself. So the order is unwrap first, and the rearrangement sees
   * prose that is already flat.
   *
   * An unsharded guide can have this problem too, so this step **does not look at `chunks.length`**.
   *
   * **The gates have to be re-run afterwards, and it rolls back if it cannot pass.** By this point the
   * draft has already been ticked and validated; it is a landable finished product, and this pass is
   * only making it nicer, with no licence to make it unacceptable. The rearrangement pass follows the
   * same rule — the only difference being that it comes later and cannot cover for this one (its
   * rollback restores the version produced after unwrapping).
   */
  if (!blocking.length && !chunkFailures.length) {
    const before = readFileSync(draftPath, 'utf8');
    const { text: flat, unwrapped } = unwrapAchievementToggles(before, defs);
    if (unwrapped.length) {
      writeFileSync(draftPath, flat);
      const after = lintGuide({
        todos: loadTodos(draftPath),
        defs,
        text: flat,
        unlockedApiNames: unlocked,
        kind: 'local',
      });
      const recheck = splitFindings(after.findings, plan.unnameable);
      if (recheck.blocking.length) {
        writeFileSync(draftPath, before);
        onProgress({ phase: 'unwrap-failed', reason: msg('gen.unwrapRecheckFailed', { n: recheck.blocking.length }) });
      } else {
        lint = after;
        onProgress({ phase: 'unwrapped-toggles', titles: unwrapped });
      }
    }
  }

  /**
   * ---- Classification: run once after the whole document is written -------
   *
   * What this pass can see, the up-front pass has none of: the official descriptions, **which section
   * each shard put each entry in** (a judgement made after the research), and the prose itself.
   * Same-kind achievements being split across two places happens only while the shards are written
   * concurrently — the pass before the prose is structurally unable to see it, and this one can.
   *
   * **Only runs when it really was sharded.** A single-shard document has no cross-shard consistency
   * problem, and in that pass the model already had the descriptions and rarities in hand, so it
   * classifies better than any after-the-fact pass could.
   *
   * **Any failure degrades to "no rearrangement" and never aborts.** The prose is written, ticked and
   * through the gates; throwing it away over one cosmetic grouping pass is a bad trade — the same
   * rule as every other cosmetic pass. A degradation has to speak up.
   */
  if (!blocking.length && !chunkFailures.length && chunks.length > 1) {
    onProgress({ phase: 'regroup', achievements: defs.length });
    const beforeText = readFileSync(draftPath, 'utf8');
    try {
      const header = buildHeader(game, appid);
      const body = (beforeText.startsWith(header) ? beforeText.slice(header.length) : beforeText)
        .replace(/^\n+/, '');
      const current = readAssignment(body, defs);

      /**
       * **Same-kind clusters: tell the model first, then back it up ourselves.**
       *
       * Telling it is because it picks better than plurality does — it can see the prose and knows
       * which section this cluster really belongs with; the backstop is because a closed list cannot
       * stop "picking one of two equally defensible destinations on the list". 《马特的寻猫游戏》's
       * four mascot-replacement entries getting split between 「宝石与商店」 and 「吉祥物替换」 is
       * exactly how that happens. A prompt cannot overrule a defensible editorial judgement; there
       * has to be a programmatic test.
       */
      const clusters = sameKindClusters(defs);

      const grouper = createSession(provider, { system: regroupSystemFor(plan.lang) });
      asideSessions.push(grouper);
      const reply = await grouper.ask(buildRegroupPrompt(game, defs, current, clusters, plan.lang), { signal });
      const verdict = checkResult(reply);
      if (!verdict.ok) throw new Error(verdict.reason);
      const parsed = parseRegroupReply(reply.text, defs);
      const finalSections = parsed.sections;
      if (!finalSections.length) throw msgError('gen.noGroups');
      const { assignment, merges } = mergeSplitClusters(parsed.assignment, clusters, finalSections);
      if (merges.length) {
        onProgress({
          phase: 'regroup-merged',
          clusters: merges.length,
          moved: merges.reduce((n, m) => n + m.moved, 0),
          into: merges.map((m) => m.into),
        });
      }

      // regroupByAssignment carries its own losslessness assertions and throws on a lost character,
      // falling straight into the catch
      const regrouped = regroupByAssignment(body, { defs, assignment, sections: finalSections });
      writeFileSync(draftPath, header + '\n' + regrouped + '\n');

      // **Re-run the gates after rearranging.** The assertions cover "nothing was lost", the validator
      // covers "it is still an acceptable guide"; neither substitutes for the other
      const after = lintGuide({
        todos: loadTodos(draftPath),
        defs,
        text: readFileSync(draftPath, 'utf8'),
        unlockedApiNames: unlocked,
        kind: 'local',
      });
      const recheck = splitFindings(after.findings, plan.unnameable);
      if (recheck.blocking.length) {
        throw msgError('gen.recheckFailed', { n: recheck.blocking.length });
      }
      lint = after;
      onProgress({
        phase: 'regroup-done', sections: finalSections.length, assigned: assignment.size, of: defs.length,
      });
    } catch (err) {
      // **A genuine cancellation is not a degrade-and-continue case.** This is the one AI call in
      // the whole function that can only be reached after every writing round already succeeded,
      // so it is also the one place "any failure degrades to no rearrangement" could quietly turn
      // a user's Cancel click into "finished anyway, just without the tidy-up" — the opposite of
      // what they asked for. Everywhere else a cancellation reaches the caller by simply not being
      // caught; here it has to be caught first (to know whether to roll back) and then let through.
      if (err?.cancelled) {
        writeFileSync(draftPath, beforeText);
        throw err;
      }
      // **Roll back to the version before the rearrangement.** The draft is a finished product that
      // has been ticked and passed the gates; a half-done one must not be left behind
      writeFileSync(draftPath, beforeText);
      onProgress({ phase: 'regroup-failed', reason: String(err?.message ?? err) });
    }
  }

  // **Never land anything once a shard is known to be missing.** Normally this check is redundant (a
  // missing shard ⇒ those 50 achievements are all missing-checkbox ⇒ blocking is non-empty); it stays
  // because "we already know it is incomplete" should not be policed on our behalf by another rule —
  // if the validator ever lets one through, this still will not write half a guide into the user's
  // notes as a finished product
  const ok = blocking.length === 0 && chunkFailures.length === 0;
  let registered = null;
  let landedUrl = null;
  let unconverted = [];
  let backup = null;
  let finalTodos = [];
  let finalText = '';

  // The overwrite backup happens **here, not in the landing function**: one rule for both backends,
  // and it has to happen before any write at all. A failed backup stops the whole thing — an
  // overwrite without a backup is an irreversible deletion, and this project's rule for irreversible
  // operations is "make it revertible first, then act"
  if (ok && plan.existing) {
    onProgress({ phase: 'backup' });
    backup = await backupGuide(config, { guide: plan.existing, appid, notion });
    onProgress({ phase: 'backup-done', path: backup.path, bytes: backup.bytes });
  }

  if (ok && plan.target === 'notion') {
    // The draft is about to be deleted, so the section intros have to be extracted before that
    const markdown = readFileSync(draftPath, 'utf8');
    const landed = await landToNotion(db, {
      notion, steam, config, plan, appid, game, defs, unlocked, backup, onProgress,
    });
    ({ registered, unconverted } = landed);
    landedUrl = landed.url;
    lint = landed.lint;
    finalTodos = landed.todos;
    finalText = landed.text;
    // **Record which section intros we wrote ourselves this time.** The next overwrite uses it to
    // tell "ours" from "hand-written or edited by the user" — a paragraph's type cannot identify its
    // author, but its content can. Recorded only after a genuine success: recording it early would
    // treat a failed generation as an accomplished fact, and the next run would delete the user's
    // paragraphs as ours
    setGuideProse(db, appid, sectionIntros(markdown));
    rmSync(draftPath, { force: true });
  } else if (ok) {
    // Landing on disk. A new file, machine gates passed ⇒ write automatically (reversible).
    // Overwriting an existing file goes through the same line — the difference being that a backup
    // was already taken above and the CLI has already shown the diff preview and asked
    writeFileSync(finalPath, readFileSync(draftPath, 'utf8'));
    rmSync(draftPath, { force: true });

    // Read it back after writing and validate once more. "The call succeeded ≠ the content is right"
    // is something this project has been bitten by, and on the landing path one extra read buys one
    // genuine confirmation
    const after = lintGuide({
      todos: loadTodos(finalPath),
      defs,
      text: readFileSync(finalPath, 'utf8'),
      unlockedApiNames: unlocked,
      kind: 'local',
    });
    const recheck = splitFindings(after.findings, plan.unnameable);
    if (recheck.blocking.length) {
      throw msgError('gen.finalRecheckFailed', {
        path: finalPath,
        problems: recheck.blocking.map((f) => f.message).join('; '),
      });
    }
    lint = after;
    finalTodos = loadTodos(finalPath);
    finalText = readFileSync(finalPath, 'utf8');

    // Registered through the real discovery logic rather than a local upsert — so that two places
    // cannot slowly drift apart on "how the title is taken" and "what to do about a backend conflict"
    registered = syncGuidesFromMarkdown(db, config).added.find((a) => a.appid === String(appid)) ?? null;
    landedUrl = finalPath;
  }

  // **After both landing paths, and only on success.** The row is created by the discovery call each
  // branch just made, so there is one row to write to either way — and recording the language of a
  // guide that failed to land would leave the panel marking a guide that is still the old one.
  //
  // It is a separate statement rather than a field on the upsert because the two discovery paths
  // register guides they *found* and know nothing about the language; see `setGuideLang`
  if (ok) setGuideLang(db, appid, plan.lang);

  return {
    ok,
    game,
    appid: String(appid),
    target: plan.target,
    url: landedUrl,
    unconverted,
    // Whether this guide was actually researched has to be handed out with the result — the caller
    // must be able to tell the user honestly.
    // canSearch is "could it search", searchQueries is "what it actually searched" — both are handed out
    researched: canSearch,
    searchQueries,
    path: ok && plan.target === 'local' ? finalPath : null,
    draftPath: ok ? null : draftPath,
    rounds: round > rounds ? rounds : round,
    lint,
    blocking,
    // Which shards ended up unwritten. **Must be handed out**: a missing shard presents as dozens of
    // missing-checkbox findings, and that is the symptom rather than the cause — the caller has to be
    // able to say "shard 3 never came back", or the user sees only a long list of "missing checkbox"
    // and concludes the model forgot to write them, when the truth is the whole shard never arrived
    chunkFailures,
    expected,
    // **Sum every chain's bill.** With independent shards each chain accounts for itself, and
    // reporting only the first swallows the vast majority of the usage — while this number is
    // the only thing that can be reconciled against a provider's bill (see the comment on
    // formatUsage in lib/ai.js)
    // `sessions` is indexed by shard and may have holes, and spreading turns a hole into
    // `undefined` — filtered rather than assumed dense
    usage: [...sessions, ...asideSessions].filter(Boolean).reduce((tot, s) => addUsage(tot, s.usage), emptyUsage()),
    model: provider.model,
    registered,
    // Where the original was backed up on an overwrite. The caller has to say this out loud — the way
    // back from an irreversible operation, buried in a return value and reported by nobody, is the
    // same as not existing
    backup: backup ? { path: backup.path, bytes: backup.bytes, count: backup.count } : null,
    overwrote: plan.existing ? { kind: plan.existing.kind, url: plan.existing.url } : null,
    todos: finalTodos,
    text: finalText,
  };
}

/**
 * Writes a draft that passed the gates into Notion, then **reads it back and validates it again**.
 *
 * The order matters: create the page (or use the empty one that was found), fill the body in
 * batches, then read back. The read-back is not a formality — the markdown-to-block conversion,
 * Notion's rendering and the nesting levels can each produce something else without raising an
 * error. This project's principle is "the call succeeded ≠ the content is right", and the validation
 * uses **exactly the same function and the same todo shape as `guide-lint`**, so this read-back
 * check is the same thing as the one normally run against a live page, not a looser second version.
 */
/**
 * Writes the new prose back **around the blocks that were kept**.
 *
 * After the deletion the page holds only the kept blocks, in their original order. Each kept block
 * carries "which achievement it used to follow" (`afterApiName`), so the new prose can be cut into
 * segments at those anchors and inserted one after another:
 *
 *   segment 0 (up to anchor A) → [kept block 1] → segment 1 (up to anchor B) → [kept block 2] → segment 2 (the rest)
 *
 * The first segment has no usable anchor block in front of it, so it goes through
 * `position: {type:'start'}`; every later segment attaches after the previous kept block. Both forms
 * of positioning are measured working on `2022-06-28`.
 *
 * **When an anchor cannot be found in the new prose the kept block stays where it is** (that segment
 * merges into the next one): that achievement may have been deleted by this rewrite, and "a
 * less-than-ideal position" is far better than "deleting the user's image to get the position right".
 */
export async function writeAroundKept(notion, pageId, blocks, keep, resolveApi) {
  const firstIndexOf = new Map();
  blocks.forEach((b, i) => {
    if (b.type !== 'to_do') return;
    // **Must use richTextText, not richTextToPlain** — these blocks are ones we built ourselves and have no plain_text
    const api = resolveApi(richTextText(b.to_do?.rich_text ?? []));
    if (api && !firstIndexOf.has(api)) firstIndexOf.set(api, i);
  });

  let cut = 0;
  let after = null;
  let atStart = true;
  for (const k of keep) {
    /**
     * Images and embeds follow the content they belong to, so their anchor is the previous
     * achievement and they go in after it; a section intro comes before its achievements, so its
     * anchor is the next achievement and it goes in before it.
     * When the preferred anchor is gone it falls back to the other one — a slightly off position
     * always beats losing it to get the position right.
     */
    const afterAt = k.afterApiName != null && firstIndexOf.has(k.afterApiName)
      ? firstIndexOf.get(k.afterApiName) + 1 : null;
    const beforeAt = k.beforeApiName != null && firstIndexOf.has(k.beforeApiName)
      ? firstIndexOf.get(k.beforeApiName) : null;
    const at = k.prefer === 'before' ? (beforeAt ?? afterAt) : (afterAt ?? beforeAt);
    // Anchor not found, or already written past by an earlier segment ⇒ no cut this round, and the
    // kept block stays where it is
    if (at === null || at <= cut) { after = k.id; atStart = false; continue; }
    const seg = blocks.slice(cut, at);
    if (seg.length) {
      const r = await notion.appendBlocks(pageId, seg, { after, atStart });
      after = r?.lastId ?? after;
    }
    cut = at;
    after = k.id;
    atStart = false;
  }
  const tail = blocks.slice(cut);
  if (tail.length) await notion.appendBlocks(pageId, tail, { after, atStart });
}

export async function landToNotion(
  db,
  { notion, steam, config, plan, appid, game, defs, unlocked, backup = null, onProgress = () => {} }
) {
  const markdown = readFileSync(plan.draftPath, 'utf8');
  const { blocks, unconverted } = markdownToBlocks(markdown, { lang: plan.lang });

  // Overwriting an existing guide page: clear the body and write the new one. **The title, icon and
  // status are never touched** — the user came to replace the guide's content, not this page's
  // identity; and `guide-status` will still converge the status against completion.
  //
  // The backup must already exist before the deletion (`backup` is passed in by generateGuide and
  // holds exactly the same set of blocks), so this does not re-read the page: letting the backup and
  // the deletion each do their own read leaves a gap where "what was backed up" and "what was
  // deleted" are not the same set — anyone touching that page in between and the backup is short one
  // block, which has already been deleted
  if (plan.existing?.kind === 'notion') {
    if (!backup?.blocks) throw msgError('gen.noBackupBeforeOverwrite');
    const page = { id: extractNotionPageId(plan.existing.url), url: plan.existing.url };
    /**
     * **Only blocks the generator itself produced are deleted.** Images, embeds, bookmarks, callouts
     * and sub-pages are things `markdownToBlocks` can never produce (the prompt says outright 「不要
     * 贴图片」), so anything of that kind on the page can only have been put there by the user — and
     * for a collect-the-things game, the only way to make a location clear is an image (rule two),
     * which regenerating cannot bring back. So the test is defined the other way round: anything not
     * listed in `GENERATED_BLOCK_TYPES` is kept, and the direction of a wrong guess is "one extra
     * block kept" rather than "the user's content deleted".
     *
     * Kept blocks **cannot be moved** (the Notion API states outright that existing blocks cannot be
     * moved), so the new prose is written around them: each kept block remembers "the nearest
     * achievement before it" as an anchor, the new prose is cut into segments at those anchors, and
     * positional insertion puts each segment where it belongs. The anchor is an api_name rather than
     * a section heading — a heading can be changed by the rearrangement, an achievement's identity
     * cannot.
     */
    const resolveApi = (t) => resolveTodoToAchievement(t, defs)?.def?.api_name ?? null;
    // The section intros we wrote in ourselves last time. **Not having them means "this guide has
    // never been recorded"** (an older guide, or the first time down this path), and
    // `partitionForOverwrite` falls back to the `carriesPointer` heuristic, keeping only the ones
    // carrying a link or a BV number. A guide only goes through this bootstrap period once — after
    // this landing there is a record
    const priorProse = getGuideProse(db, appid);
    const { drop, keep } = partitionForOverwrite(backup.blocks, resolveApi, priorProse);
    onProgress({ phase: 'notion-clear', url: page.url, blocks: drop.length, kept: keep.length });
    for (const b of drop) {
      await notion.deleteBlock(b.id);
      // The same self-restraint as appendBlocks. One guide is dozens or hundreds of blocks, and
      // deleting them without pausing hits the rate limit, while on this path every 429 retry happens
      // in a state where half the old content is already gone
      await sleep(200);
    }
    if (keep.length) await writeAroundKept(notion, page.id, blocks, keep, resolveApi);
    // An overwrite fills an empty icon slot too — the same rule as the create and adopt paths, or the
    // three landing paths would each have their own temperament.
    // The icon has to be **read** before deciding: passing icon: null outright turns "fill only the
    // empty slot" into "overwrite every time".
    // A failed read falls back to a non-empty value, so fillMissingIcon concludes "it already has an
    // icon" and leaves it alone — when in doubt, do not touch the user's things, which is the
    // direction the whole project takes
    const current = await notion.fetchPageIcon(page.id).catch(() => ({ type: 'unknown' }));
    await fillMissingIcon(notion, { ...page, icon: current }, await fetchGameIcon(steam, appid).catch(() => null));
    onProgress({ phase: 'notion-fill', url: page.url, blocks: blocks.length });
    return finishNotionLanding(db, {
      notion, page, blocks, unconverted, defs, unlocked, plan, appid,
      alreadyWritten: keep.length > 0,
    });
  }

  let page = plan.notion.existingPage;
  // The icon is a garnish: if it cannot be fetched, go without — do not hold up a finished guide over
  // an icon
  const icon = await fetchGameIcon(steam, appid).catch(() => null);

  if (page) {
    // An empty page the user created themselves: **fill in the body only; leave the title and status
    // alone**. Those two they set by hand, and what we came to write is the body; "fixing them up
    // while we are here" is irreversibly overwriting somebody else's choice. If the status really is
    // wrong, `guide-status` converges it from completion by itself.
    //
    // The icon is the **one exception to this rule, and only for the slot that is empty**: no icon is
    // not "the user chose to have no icon", it is a slot nobody has filled. Filling a blank is not
    // overwriting — anything that already has an icon (even an emoji) is left alone
    onProgress({ phase: 'notion-fill', url: page.url, blocks: blocks.length });
    await fillMissingIcon(notion, page, icon);
  } else {
    page = await notion.createGuidePage({
      titleProperty: plan.notion.titleProperty,
      title: game,
      icon,
      status: plan.notion.status,
    });
    onProgress({ phase: 'notion-create', url: page.url, blocks: blocks.length });
  }

  return finishNotionLanding(db, { notion, page, blocks, unconverted, defs, unlocked, plan, appid });
}

/**
 * Write the body → read back and re-validate → register through the real discovery logic. **Create,
 * adopt-an-empty-page and overwrite all share this section**, precisely so that "read it back after
 * writing" is something no path can get around — and the overwrite path needs it most: the old
 * content is already deleted, so if the new content does not land the page is empty.
 */
async function finishNotionLanding(
  db, { notion, page, blocks, unconverted, defs, unlocked, plan, appid, alreadyWritten = false }
) {
  // The overwrite path already wrote its segments around the anchors (see `writeAroundKept`), so this
  // only does the read-back validation
  if (!alreadyWritten) await notion.appendBlocks(page.id, blocks);

  // Read-back validation. The todo shape is the same on both backends, so what is fed to lintGuide
  // here is the same thing guide-lint normally feeds it
  const todos = await notion.fetchAllToDoBlocks(page.id);
  const after = lintGuide({ todos, defs, unlockedApiNames: unlocked, kind: 'notion' });
  const recheck = splitFindings(after.findings, plan.unnameable);
  if (recheck.blocking.length) {
    throw msgError('gen.notionRecheckFailed', {
      url: page.url,
      problems: recheck.blocking.map((f) => f.message).join('; '),
    });
  }

  // Registered through the real discovery logic — it goes back and reads the `appid:` line off the
  // page itself. That incidentally verifies one thing nothing else could: **the appid line we wrote
  // really is recognisable to the discovery logic**. With a local upsert, a mis-rendered appid line
  // would not surface until the next serve
  const discovered = await syncGuidesFromNotion(db, notion);
  const registered =
    discovered.added.find((a) => a.appid === String(appid)) ??
    // On an overwrite this page was registered long ago and the discovery logic will not count it in
    // `added` — that is not a failure.
    // But "the appid line on the page is still readable" still has to be verified, so fall back to
    // reading it directly
    ((await notion.extractAppIdFromPageContent(page.id)) === String(appid)
      ? { appid: String(appid), url: page.url, action: 'overwritten' }
      : null);
  if (!registered) {
    throw msgError('gen.appidNotFound', { url: page.url, appid });
  }

  // todos/text are handed out too: after an overwrite they are needed to compare against the old
  // version, and lintGuide returns conclusions rather than material. Making the caller read the page
  // again for that comparison risks reading something other than what was just written
  return { url: page.url, lint: after, registered, unconverted, todos, text: todos.map((t) => t.text).join('\n') };
}

/**
 * Preconditions + data preparation. **Every refusal reason is given here, all at once** — never
 * halfway through, after money has been spent, only to find the file already exists.
 */
export async function planGuide(db, {
  config, steam, appid, fileName = null, notion = null, local = false, overwrite = false,
}) {
  const id = String(appid);
  let defs = achievementsFor(db, id);

  // **With no achievement detail, fetch it on the spot rather than requiring a full library sync first.**
  //
  // This used to refuse outright with "run `node tracker.js sync --schema` first" — and a Dashboard
  // user (especially in the packaged build) **has no terminal at all**, so that sentence is a dead
  // end for them.
  //
  // Nor is this rare; it is two classes of game that will inevitably come up:
  //   just added   — the bulk sync has not reached it yet
  //   at 100%      — syncAchievementSchema deliberately skips `rate === 1` (there is normally no
  //                  checklist to look at, saving calls), so for those this wall is **permanent**, no
  //                  matter how many syncs are run
  // A hand-added game is usually an older family-shared one, which is exactly the intersection of
  // those two classes.
  //
  // The cost is one or two Steam calls, incurred only when it is genuinely missing; what it buys is
  // "click it and it works". It refuses only when the fetch fails — and that case means this game
  // really has no achievement definitions on Steam, not that a sync has not run
  if (!defs.length) {
    const row = getGame(db, id);
    if (!row) throw msgError('gen.notInList');
    const got = await fetchGameSchema(db, steam, row).catch(() => false);
    defs = got ? achievementsFor(db, id) : [];
  }
  if (!defs.length) {
    const err = msgError('gen.noAchList');
    err.code = 'no-schema';
    throw err;
  }

  // The cap is still here, but what it now governs is "how long it runs and how much it costs", not
  // "technically unwritable" — anything past one shard is sharded automatically (see chunkDefs). The
  // largest in the library has 408 achievements
  const max = config.ai?.maxAchievements ?? 500;
  if (defs.length > max) {
    const err = msgError('gen.tooManyAch', { n: defs.length, max });
    // The cap is a config option, and changing it is "advanced usage" — the CLI prints exactly how to
    // change it (see tracker.js), while the Dashboard only says what happened. One sentence serving
    // both surfaces comes out wrong on both
    err.code = 'too-many-achievements';
    err.detail = { count: defs.length, max };
    throw err;
  }

  const gameRow = getGame(db, id);
  const game = gameRow?.name || defs[0].game_name || id;

  // One appid can have only one guide backend. Already registered = this is an **overwrite**, which is
  // irreversible, so it is refused by default; `--overwrite` lets it through, and even then a backup
  // and a diff preview come first
  const existing = getGuide(db, id);
  if (existing && !overwrite) {
    const where = msg(existing.kind === 'notion' ? 'gen.whereNotion' : 'gen.whereLocal');
    // States only "one already exists". **The next action is not the same thing on the two surfaces**
    // — the terminal needs `--overwrite`, while the Dashboard has a 「重写」 button on that row.
    // Hardcoding either one makes it useless prose on the other
    const err = msgError('gen.alreadyHasGuide', { game, where, url: existing.url });
    err.code = 'guide-exists';
    err.detail = { kind: existing.kind, url: existing.url };
    throw err;
  }

  // An overwrite writes back to **the backend this guide is already on**, not the default rule above:
  // `--overwrite` on a local guide means rewriting that local file, not moving it to Notion in
  // passing. Changing backend is `guide-to-notion`'s job, and mixing the two into one command makes
  // it impossible to tell which did what when something goes wrong
  const name = existing?.kind === 'local' ? existing.url : (fileName ?? guideFileName(game, id));
  const finalPath = join(config.guidesDir, name);
  const draftPath = join(config.guidesDir, DRAFTS_DIR, name);

  // Where the guide goes: Notion is connected, so write to Notion. That is what SKILL.md 8.0 settled
  // — guides are the user's own notes, they already have 105 of them in Notion, and landing a new one
  // locally splits one body of notes across two places. `--local` is the explicit "write this one
  // locally" exit
  const target = existing
    ? existing.kind
    : !local && notion?.configured && config.notion?.overviewDbId
      ? 'notion'
      : 'local';

  // Overwriting an existing Notion page **does not consult planNotionTarget**: that function's job is
  // "find an empty page for a new guide, or create one", and it refuses because the page has content —
  // whereas here the page having content is the premise. The target page is the registered one, its
  // title and status are left exactly as they are, and only the body is replaced
  const notionPlan =
    target === 'notion' && !existing
      ? await planNotionTarget(notion, game, { statusValue: newGuideStatus(gameRow) })
      : null;

  // Not registered in the guides table but the file is already sitting there — equally an overwrite,
  // equally requiring --overwrite. Drafts always go to disk, so this has to be checked for both
  // targets
  if (target === 'local' && !existing && existsSync(finalPath)) {
    const err = msgError('gen.fileExists', { path: finalPath });
    err.code = 'file-exists';
    err.detail = { path: finalPath };
    throw err;
  }

  // Read the old guide before overwriting, for the diff preview. **Read before spending** — an
  // unreadable one means that guide already has a problem and this should stop on the spot, rather
  // than waiting for the model to finish and the money to be spent before finding there is nothing to
  // compare against
  let oldTodos = [];
  let oldText = '';
  if (existing) {
    if (existing.kind === 'local') {
      const path = resolveGuidePath(config.guidesDir, existing.url);
      if (!existsSync(path)) throw msgError('gen.guideFileMissing', { path });
      oldTodos = loadTodos(path);
      oldText = readFileSync(path, 'utf8');
    } else {
      oldTodos = await notion.fetchAllToDoBlocks(extractNotionPageId(existing.url));
      oldText = oldTodos.map((t) => t.text).join('\n');
    }
  }

  // Mechanical ticking needs the real unlock state. If it cannot be obtained, **do not generate**: a
  // guide with nothing ticked is a wrong guide, and the validator would report it as a pile of
  // checked-mismatch findings that look like the model got it wrong
  const raw = await steam.fetchPlayerAchievements(id);
  if (raw.retry) throw msgError('gen.noUnlockState', { id });
  if (raw.noAchievementSystem) throw msgError('gen.noAchData', { id });
  const unlocked = new Set((raw.achievements ?? []).filter((a) => a.achieved).map((a) => a.apiname));

  // Global unlock rates: a difficulty signal, used by the model to allocate effort. Going without is
  // fine — it is a garnish, and it should not stop somebody getting a guide generated because it went
  // down
  const rarity = await steam.fetchGlobalAchievementPercentages(id);

  return {
    defs, game, unlocked, rarity, finalPath, draftPath, target,
    // **A generated guide is written in the interface language, overwrite included.**
    //
    // That is deliberately the whole mechanism for changing a guide's language: there is no separate
    // "generate in English" action, because one existed on paper and was rejected — a second button
    // beside 「重写」 doing the same work with a different output is two ways to spend the same money,
    // and the guide is one per game either way. So switching the interface and pressing 「重写」 is
    // how a Chinese guide becomes an English one, and the rewrite dialog's title names the language
    // precisely because that path would otherwise be silent.
    lang: normalizeUiLanguage(config.uiLanguage),
    notion: notionPlan,
    fileName: name,
    unnameable: unnameableApiNames(defs),
    // A non-empty `existing` means this is an overwrite. Downstream uses this one field to decide
    // whether to back up and whether to clear the old content
    existing: existing ?? null,
    oldTodos,
    oldText,
  };
}

/**
 * Splits the validation results into "must be resolved" and "known to be out of reach".
 *
 * **There is exactly one test for entering `expected`: is there any action, by anyone, that would
 * clear this?** No ⇒ report it, but do not block. Blocking an error nobody can fix achieves only one
 * thing: spending three rewrite rounds and then throwing away a correctly written guide.
 *
 * There are two kinds of out-of-reach today, from different sources:
 *
 * 1. `checked-mismatch` + a name collision — `computeCheckedKeys` skips any achievement whose name
 *    collides (better a missed tick than a wrong one), so an unlocked one's box never gets ticked.
 *    **This one needs the `unnameable` gate**, because `checked-mismatch` is reported for any
 *    achievement and a collision is only one of its causes.
 * 2. `ambiguous-empty-description` — a collision where the description on Steam is an empty string, so
 *    the one piece of evidence that could tell them apart simply does not exist. **This one does not
 *    look at `unnameable`**: its trigger already contains "the name collides", making it strictly
 *    narrower than unnameable, so adding the gate is a tautology.
 *
 * **This list is enumerated case by case, not "a category".** Writing it as "only checked-mismatch is
 * exempt" would be both wrong and an obstacle to discovering case 2 — see the comment in
 * lib/guidelint.js. Answer that test before adding a new entry; `ambiguous-no-description` (the
 * description is there, it just was not copied) cannot answer it, so it blocks as usual.
 */
export function splitFindings(findings, unnameable) {
  const blocking = [];
  const expected = [];
  for (const f of findings) {
    if (f.level !== 'error') continue;
    if (f.code === 'checked-mismatch' && unnameable.has(f.apiName)) expected.push(f);
    // **`ambiguous-empty-description` is out of reach too, and more thoroughly so.**
    //
    // A collision plus an empty description on Steam ⇒ the one piece of evidence separating these two
    // achievements does not exist, and no rewrite could ever satisfy it. Having it in blocking was
    // measured: KINGDOM HEARTS (a four-in-one collection with 16 colliding names) had a guide with
    // full 197/197 coverage stopped by 15 findings of this kind, whose own message said it was not
    // something a guide could fix. All three rounds went into asking the model to copy a description
    // that does not exist, and then the whole thing was thrown away.
    //
    // This **does not add the `unnameable.has(f.apiName)` gate**, unlike the line above: that line
    // needs it, because `checked-mismatch` is reported for any achievement and a collision is only
    // one of its causes; whereas this one's trigger already contains "the name collides" and is
    // strictly narrower than unnameable. Adding it is a tautology that reads as though there were
    // doubt
    else if (f.code === 'ambiguous-empty-description') expected.push(f);
    else blocking.push(f);
  }
  return { blocking, expected };
}
