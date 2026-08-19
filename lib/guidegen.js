/**
 * AI 攻略生成 —— 编排
 * ------------------------------------------------
 * 一条流水线:取成就数据 → 让模型联网研究并撰写 → **机械打勾** → 交给校验器 →
 * 不过关就把具体错误回灌重写(最多 3 轮)→ 落盘。设计和取舍见 docs/ai-guide-writing.md。
 *
 * `lib/ai.js` 负责怎么跟供应商说话,这里负责说什么、以及信不信它说回来的东西。
 *
 * **这一层保证的是「格式和数据一定正确」,不是「攻略正确」。** 步骤可不可行、难度准不准、
 * "易错过"是不是真的——机器一条都验不了,而那正是攻略的全部价值。调用方(CLI / 将来的
 * Dashboard 入口)必须如实告诉用户内容未经验证。
 *
 * 三件事是**结构上**保证的,不是靠检查:
 *
 * 1. **勾选状态**。模型一律只写 `- [ ]`,写完由 `computeCheckedKeys` 按数据库填。
 *    于是"勾选必须等于真实 achieved"从一条要检查的规则,变成不可能违反的事实。
 *    解锁状态也**不喂给模型**——这是上一条的推论,也更符合 SKILL.md 规则 3.1:
 *    攻略是"怎么打过的"记录,不是"还剩什么没做"的清单。
 * 2. **`# 游戏名` 和 `appid:` 两行由程序写**,不让模型写。这两行是纯数据,库里就有;
 *    让模型转录一遍等于凭空多一次写错的机会,而写错 appid 会把攻略登记到**另一款游戏**上。
 * 3. **草稿绝不落在 `guides/` 根目录**。`syncGuidesFromMarkdown` 会把任何带 `appid:` 行的
 *    `.md` 登记进 guides 表,接着 `checkbox-sync` 就拿一份没验过的攻略去勾用户的框。
 *    草稿一律写进 `guides/.drafts/` —— 那个发现逻辑是 `readdirSync` 非递归 + 只认 `.md`,
 *    子目录进不了它的视野(已核对源码,不是推测)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { achievementsFor, getGame, getGuide } from './db.js';
import { lintGuide, computeCheckedKeys, unnameableApiNames } from './guidelint.js';
import { loadTodos, applyChecks, resolveGuidePath } from './markdown.js';
import { syncGuidesFromMarkdown, syncGuidesFromNotion } from './guides.js';
import { markdownToBlocks } from './notionblocks.js';
import { planNotionTarget, newGuideStatus, fillMissingIcon, extractNotionPageId } from './notion.js';
import { fetchGameIcon, sleep } from './steam.js';
import { createSession, checkResult, addUsage, emptyUsage } from './ai.js';
import { backupGuide } from './guidebackup.js';
import { RARE_PCT } from './guidescope.js';
// 缺成就详情时当场补一次。**和批量同步共用同一个取法** —— 见 fetchGameSchema 的注释
import { fetchGameSchema } from './sync.js';

/** 草稿目录。放在 guidesDir 底下方便找,但发现逻辑扫不到(非递归) */
export const DRAFTS_DIR = '.drafts';

/**
 * 哪些校验问题**能怪模型**。
 *
 * `checked-mismatch` 不在里面,而且必须不在:模型压根不许写 checkbox 状态,
 * 把这条回灌给它等于要求它做我们明令禁止的事,它只会开始瞎写 `- [x]`。
 *
 * `ambiguous-empty-description` 同样不在里面:Steam 上那个描述是空的,没有字符串可抄,
 * 回灌等于让它去抄不存在的东西。而 `ambiguous-no-description`(描述存在、只是没抄)
 * **在**里面 —— 那一种重写就能解决。这两种以前共用一个 code,于是不可能修的那种也被
 * 回灌了三轮,再把一份完整的攻略丢掉(见 lib/guidelint.js 里那段注释)。
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
// 提示词
// ---------------------------------------------------------------------------

/**
 * `.claude/skills/achievement-guide-writing/SKILL.md` 每一条规则在生成器里的处置。
 *
 * **为什么需要这张表:** 下面的 `RULES` 是 SKILL.md 的**手抄摘要**(约四分之一体量),
 * 不是全文。全文不能直接发 —— 里面有整节讲往 Notion 写、讲截图、讲委托子 agent,
 * 8.0 更是明写"新攻略默认建在 Notion",发过去会主动误导模型。
 *
 * 但手抄就会漂移:SKILL.md 改了,提示词不会跟着改,而且没有任何东西会提醒。
 * CLAUDE.md 里记着这个项目已经被同一件事咬过一次(一个密钥硬编码在公开仓库里几个月,
 * 三份文档都说它读的是 config)。所以这张表 + `test/guidegen.test.js` 里那条测试,
 * 把"悄悄漂移"变成"改了 SKILL.md 就有测试失败"。
 *
 * **改 SKILL.md 之后,要么把新规则加进 `RULES`,要么在这里写明为什么不加。**
 */
export const SKILL_RULE_DISPOSITION = {
  '规则一': '进了 —— 一个成就一行 checkbox、子步骤嵌套的三个条件、重名抄描述。「写后验证」由程序做',
  '规则二': '**没进** —— 截图明确不在 v1 范围(模型给不出可靠的游戏内截图)',
  '规则三': '伞形标题,细则见 3.1–3.5',
  '3.1': '进了 —— 三段式、描述照抄、详略取舍、五种附加标注的固定写法',
  '3.2': '进了 —— 消化重写不照搬、B站 BV 号、极少数保留英文原句',
  '3.3': '**没进** —— 补充1/补充2 是给「回头补充已有攻略」用的,生成器每次写全新一份',
  '3.4': '**没进** —— 子页面和 Notion 内嵌数据库都属于 Notion 后端,是第二阶段',
  '3.5': '进了 —— 成就列表前的机制速查',
  '规则四': '伞形标题,细则见 4.1–4.4',
  '4.1': '**部分** —— `# 游戏名` 和 `appid:` 由程序写,所以反过来要求模型**别写**',
  '4.2': '进了 —— 按游戏自身分类分节、节标题不带统计数字',
  '4.3': '进了 —— 写完就停',
  '4.4': '进了 —— DLC 当普通一节,不写"暂无中文翻译"那种括号注释',
  '规则五': '进了 —— <details> 折叠、表格取舍。删除线没进(生成新攻略用不上)',
  '规则六': '进了 —— 中英文混用',
  '规则七': '进了 —— 不写数据来源',
  '规则八': '伞形标题,细则见 8.0–8.4',
  '8.0': '**没进** —— 后端选择是程序的事(v1 只写本地 md),而且 8.0 明写"默认建在 Notion",发给模型会主动误导',
  '8.1': '**没进** —— 取成就数据和解锁状态由程序做。解锁状态**刻意不喂给模型**',
  '8.2': '进了精神 —— "按游戏自身的成就分类分节"',
  '8.3': '进了精神 —— 在「怎么查资料」那节。具体的抓取手法(get_page_text 之类)是我们这边的工具,模型用的是服务端搜索',
  '8.4': '**部分进了** —— 委托子 agent 仍然没进(那是会话层的做法)。但分片本身做了(2026-08-11):超过 ai.chunkSize 就分几段写,同一个 session 多轮,拼起来再整体校验。所以提示词里不提分片,分几段是程序的事',
  '规则九': '伞形标题,细则见 9.1–9.3',
  '9.1': '**没进** —— notion-update-page 的命令选择,v1 只写本地 md',
  '9.2': '**没进** —— Notion 大内容分批写',
  '9.3': '**没进** —— 写完回读验证。程序落盘后会自己重新读一遍再校验一次',
  '规则十': '进了要点 —— 自检清单里对生成有约束的几条(尤其"不写推测/待确认/暂无中文翻译")。其余是给人复核用的',
};

/**
 * 规则部分。**放在 system 的最前面而且逐字不变**——回灌重写最多跑 3 轮,每轮都重发
 * 这一大段,命中前缀缓存按 0.1 倍计费。所以这里绝对不能插时间戳、随机数之类的东西:
 * 缓存是前缀匹配,前面变一个字节后面全作废。
 *
 * 和 SKILL.md 的对应关系见上面的 `SKILL_RULE_DISPOSITION`。
 */
// 提示词里不提"写去哪"——模型交出来的永远是 markdown,落 Notion 还是落本地是**之后**
// 的事(见 landToNotion)。说成"本地攻略"会让它按一个已经不成立的前提写
const RULES = `你在为一个 Steam 成就追踪工具写一份 **markdown 攻略**。下面的规则来自这个项目积累的写法规范,写完机器会逐条校验,不满足会被打回重写。

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
5. 清单里标了 **⚠️ 同名** 的成就,描述原文**必须**抄进去——同一个游戏里有另一个成就叫一模一样的名字,描述是唯一能把它们区分开的东西
6. 节标题里不要写"共 N 个""M 项未完成"这类统计数字,会随进度过期而且没人会去更新
7. 不要在攻略里写数据来源(例如"勾选状态来自 Steam 真实解锁数据")
8. 写完最后一个成就就停。不要"总结"、不要"参考来源"、不要"这份攻略还不完整"

## 写法

- 分节按**游戏自身的成就分类**走(主线 / 支线 / 收集 / 战斗 / 杂项),跟着游戏本身的分法
- **子 checkbox 默认不写。** 嵌套是例外,下面三条**同时**成立才嵌套:
  1. **每一条都有自己的身份** —— 一个神庙名、一份配方、一条支线任务名、一处收集品位置,
     是要去找、去查、去认的**具体东西**。**序号不是身份**:\`第1天\`/\`第2天\`、\`第1关\`/\`第2关\`、
     \`1/10\`、\`步骤一\`/\`步骤二\` 只是把一个数字拆开写,一条信息都没多
  2. **游戏自己不替你数** —— 游戏里已经有进度条或计数器的(玩满 7 天、杀 100 只、攒 5000 块),
     这种框勾了对用户没有任何用处:他看游戏界面就知道自己到哪儿了
  3. **每一条都要做**,不是任选其一。如果那几条是**互相替代**的选项(比如"达成任一结局"
     下面列了九个结局、"用任意职业通关"下面列了五个职业),**不要嵌套**,平铺写在心得那一段里。
     嵌套的语义是"父成就解锁 ⇒ 下面每一条都做过了",互斥选项放进去会变成八条假记录
- 三条都满足的时候**就要**嵌套(120 个神庙、20 份配方、5 条支线各占一行),别写成一段纯文字
  ——那种情况下用户确实要一条一条勾掉
- **一句自检:把那几行删掉,这份攻略少了什么信息吗?** 少不了就不要写。
  "玩满 7 天"下面挂 \`第1天\`…\`第7天\`,是这条规则最常见、也最没价值的违反方式
- 纯剧情推进自动解锁的成就:只写名字和官方描述就够了
- 有坑、有技巧、容易错过的成就:详细写前置条件、关键选择节点、容易翻车的地方。**这是攻略最有价值的部分**,别省
- 很长的清单(全结局对照、全收集品)用 \`<details><summary>\` 折叠起来。列数多、纯文字对不齐的可以用 HTML \`<table>\`,但能用 checkbox 列表说清楚的优先用列表
- 游戏有官方中文就用中文成就名,没有就保留英文原名;Boss、Build、DLC、NPC 这类术语不强行翻译
- **DLC 成就当游戏的普通一节处理**,不要写成 \`DLC: XXX(3个成就,暂无中文翻译)\` 这种带括号注释的格式。没有中文名就直接用英文名
- 游戏有需要反复查阅的操作说明(调酒配方、职业解锁条件这类),可以在成就列表**前面**写一小段机制速查。这是功能性速查,不是文档包装
- 收集品类的可以贴 B站 BV 号或链接。极少数情况(某个判定条件的英文原文特别精确、翻译容易走样)可以保留英文原句,但要简短、前面加中文说明上下文
- 不要贴图片

## 标注用固定写法(不要自创)

- **位置**:涉及特定地图位置的,在条目开头标 \`位置 XXX\`
- **前置条件**:需要特定背景/技能/perk 的,用 \`※需要有背景X\`
- **互斥**:和别的成就冲突的,用 \`<span underline="true">如果进行此动作则无法获得X成就。</span>\`
- **易错过**:**过了某个节点会永久错过**的才标 \`易错过!!\`。季节性、每年一次这种"等下一轮还能拿"的**不要标** —— 那是假警报,标多了这个记号就没人看了
- **DLC 排除**:成就不含 DLC 内容的,标 \`※除去追加内容\`

## 不要写文档化的备注

**攻略里不出现"推测"、"待确认"、"暂无中文翻译"、"此处存疑"这类话。** 不确定的东西有两个处理办法:要么查清楚再写,要么不写。把不确定性写进正文,读的人既不能照做、也不知道该信几分。

`;

/** 有联网能力时的调研要求 */
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
 * 没有联网能力时的版本。
 *
 * 不是把上面那段删掉就完事——**"不要编造"这条在没有资料来源时几乎是不可执行的**,
 * 模型只能凭已有知识写,而它分不清自己记得的是事实还是补全出来的。所以这一版把要求
 * 反过来:宁可只留官方描述,也不要写一句没把握的攻略。少写是可以接受的结果,
 * 编一个看着很像真的步骤不是。
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
 * 全球解锁率 → 一个模型能照着分配力气的标签。
 *
 * 光给百分比不够:模型得知道 1.1% 意味着"这条要往深里写"。所以直接把结论写出来,
 * 而不是让它自己换算。阈值是拍的,但方向是实测的 —— 《部落幸存者》最难 1.1%、
 * 最易 64.5%,差 60 倍,而不给这个信号时生成的心得字数只差不到一倍。
 */
function rarityTag(pct) {
  if (pct === undefined || pct === null) return '';
  const p = pct.toFixed(1);
  if (pct < 5) return `  🔴 全球仅 ${p}% 玩家解锁 —— **这类要写深**`;
  // **这条线是 import 来的,不是又写了一遍。** 「界面上标成稀有的」和「提示词说
  // 要写深的」必须是同一批成就;两处各写一个数,漂了也没人会发现 —— 表现只是
  // 界面说它稀有、程序不这么认为。Dashboard 那边同理,阈值由服务端下发
  if (pct < RARE_PCT) return `  🟠 全球 ${p}% 解锁,偏难`;
  if (pct < 40) return `  🟡 全球 ${p}% 解锁`;
  return `  ⚪ 全球 ${p}% 解锁,多数人自然拿到 —— 一两句带过就行`;
}

/** 成就清单。⚠️ 同名 标记直接告诉模型哪几条必须抄描述,比让它自己数可靠 */
export function buildAchievementList(game, appid, defs, rarity = null) {
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

export function buildSystemPrompt(game, appid, defs, { canSearch = true, rarity = null } = {}) {
  const research = canSearch ? RESEARCH_ONLINE : RESEARCH_OFFLINE;
  return `${RULES}\n\n${research}\n\n---\n\n${buildAchievementList(game, appid, defs, rarity)}`;
}

// ---------------------------------------------------------------------------
// 分段撰写
// ---------------------------------------------------------------------------

/**
 * 成就切成几段。一次上下文写不完几百个成就 —— 不是装不下清单(清单很小),
 * 是**写不出那么长的正文**:一个成就的三段式大约 150 字,400 个就是六万字,
 * 远超任何一家的单次输出上限。截断了还不报错,校验器只会说"后半段的成就都缺 checkbox"。
 *
 * **`size` 是每段的上限,不是每段的长度。** 先算要几段,再把成就均摊到这几段上。
 *
 * 原来是朴素的顺序切片(每段装满 size,剩下的单独成段),而那个写法对**任何略大于
 * size 整数倍**的成就数都给出最差的一种切法:55 个成就配 size=50 切成 50 + 5 ——
 * 第一段顶着上限,最后一段几乎是空的,总段数还是 2。段数一样,却让第一段去冒
 * 被 max_tokens 截断的风险,白冒的。均摊之后是 28 + 27,段数不变,单段正文减半。
 * (实测撞上这条的是人中之龙0,55 个成就。)
 *
 * 均摊不会让任何一段超过 size —— `ceil(n / ceil(n / size)) ≤ size` 是恒成立的,
 * 所以这只会把段变短,不会把上限撑破。
 */
export function chunkDefs(defs, size) {
  const max = Math.max(1, Number(size) || 1);
  if (!defs.length) return [];
  const per = Math.ceil(defs.length / Math.ceil(defs.length / max));
  const out = [];
  for (let i = 0; i < defs.length; i += per) out.push(defs.slice(i, i + per));
  return out;
}

const defName = (d) => (d.name_cn || d.name_en || d.api_name || '').trim();

/**
 * 切到这么小还写不出来就不再切了。
 *
 * 这个下限不是怕死循环(每次至少减半,必然收敛),是**再切下去也不解决问题**:
 * 五个成就的正文两三千字,撑不满任何一家的单次上限,还写不出来说明吃掉额度的是
 * thinking 而不是正文,而那是切分够不着的东西。继续切只会把一次失败拆成十次失败,
 * 每次都要重新联网搜一遍。到这儿就停下来把真话说出来。
 */
export const MIN_CHUNK = 5;

/**
 * 一段最多**额外**再问几次。
 *
 * 只有「空回复」用得上它,而空回复是这条路上唯一真正的**瞬时**失败:请求没问题、
 * 段长没问题、资料也搜到了,就是这一次没吐出正文来。原样再问一遍很可能就有了,
 * 代价是一次请求 —— 而不重问的代价是整份作废、十几次联网搜索白花。
 *
 * 1 而不是更多:第二次还空就不是抽风了,说明这一段有什么东西让模型写不出来,
 * 那时候该换手法(切小,见 canSplit),不是继续拿同一句话去撞。
 */
export const EMPTY_RETRIES = 1;

/**
 * 原样再问一次就可能好的那几种 —— 都是**这一次抽风**,不是这一段有问题。
 *
 * - `empty` —— 一个 text 块都没有。请求、段长、资料全都没问题,就是这次没吐出正文。
 * - `control-token` —— 模型把自己的内部控制符写进了正文,输出从那里断掉(见
 *   lib/ai.js 的 `leakedControlToken`)。同样是采样跑偏,重问一次很可能就正常了。
 *
 * 别的每一种都有具体原因:截断是段太长(该切小)、拒答和 RECITATION 是内容判定
 * (再问一遍是同一个结果)、搜索报错是网络或额度(要么等要么改配置)。
 * 把它们塞进重试,只是花钱把同一个错误再犯一次。
 */
export const RETRYABLE = new Set(['empty', 'control-token']);

function canRetry(err, attempt) {
  return RETRYABLE.has(err?.code) && attempt < EMPTY_RETRIES;
}

/**
 * 切小再问能补救的两种失败。
 *
 * - `max_tokens` —— 段太长,一分为二是对症下药。
 * - `empty` —— **重问过还是空**(见 canRetry)才走到这里。这一步是猜,但是有依据的猜:
 *   装进一次请求的是 thinking + 正文,而兼容端点上我们既发不出压制 thinking 的参数
 *   (见 ai-anthropic.js 的 `extras`:`ai.baseUrl` 一设,`thinking`/`output_config`
 *   就不发了),也**不能假定它会把「额度被思考吃光」如实报成 max_tokens** ——
 *   DeepSeek 的 `/anthropic` 是别人实现的 Messages API,停止原因的保真度不在我们手里。
 *   所以「空回复」里混着一部分实质上就是截断的情况,而切小正是那部分的解。
 *   猜错的代价是多问一次;不猜的代价是整份作废。
 */
export const SPLITTABLE = new Set(['max_tokens', 'empty', 'control-token']);

/**
 * 「这一段没成」和「供应商坏了」是两件事,而它们从同一个 `await ask()` 里抛出来。
 *
 * 只有 `checkResult` 判出来的这几种是**这一段自己**的问题:全都是 HTTP 200,
 * 换一段内容再问就可能好,所以放过这一段、接着写后面几段是对的。
 *
 * 401、网络断了、`ai.maxContinuations` 用光了这类**整体**故障必须原样抛出去。
 * 当成"这一段没成"接着问,是拿同一堵墙再撞三次,每次都让用户干等一轮;而且真正的
 * 原因会被埋进一串「第 N 段没写出来」里 —— 更要紧的是它自己那条终端建议
 * (比如 `bad-api-key` 要说的「环境变量会盖掉 config.json」)再也走不到
 * tracker.js 的顶层 catch 了。分级不分级,这就是差别。
 */
const CHUNK_LOCAL = new Set(['empty', 'max_tokens', 'refusal', 'recitation', 'tool-error', 'other', 'control-token']);

/**
 * 这次失败能不能靠"切小再问"补救。
 *
 * 拒答、RECITATION、搜索报错都不在 `SPLITTABLE` 里:它们不是长度问题,切小了照样撞,
 * 而且各自的正确处置完全不同(换问法 / 换游戏 / 查网络)。
 *
 * 只在第一轮切。之后几轮是拿校验结果定点重写,`targets` 是进循环前算好的下标,
 * 中途改段数会让那份对应关系失效 —— 而重写轮里段长已经是第一轮跑通过的值。
 */
function canSplit(err, round, chunk) {
  return SPLITTABLE.has(err?.code) && round === 1 && chunk.length > MIN_CHUNK;
}

/**
 * 切不动了的时候补一句"切到多小了"。
 *
 * **`round !== 1` 不配这句话。** 那种情况下不切是因为重写轮的下标动不得
 * (见 canSplit),不是因为段已经足够小 —— 说成"切到 N 个还是写不出来"是在
 * 报一个没发生过的事实。所以这里只在第一轮改写错误码。
 *
 * **只说事实,不给配置建议。** 这条消息会原样出现在 Dashboard 的浮窗里,而那边的
 * 用户没有终端也不该被要求去编辑 config.json;具体该调哪个旋钮由 CLI 自己接着说
 * (见 tracker.js 对 `chunk-too-small` 的处理)。
 */
function chunkFloorAdvice(err, round, chunk) {
  if (!SPLITTABLE.has(err?.code) || round !== 1) return err;
  err.detail = { size: chunk.length, min: MIN_CHUNK, was: err.code };
  err.code = 'chunk-too-small';
  err.message += `\n这一段已经切到 ${chunk.length} 个成就还是没写出来,换个模型或供应商可能更合适。`;
  return err;
}

/** 这一段该写什么。只有一段时就是原来那句话,行为一个字都没变 */
export function buildChunkMessage(chunks, i) {
  if (chunks.length === 1) return '开始写吧。先联网查资料,再按规则写完整份攻略。';

  const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0);
  const chunk = chunks[i];
  const last = i === chunks.length - 1;
  return (
    `这一轮**只写第 ${before + 1}–${before + chunk.length} 个成就**` +
    `(从「${defName(chunk[0])}」到「${defName(chunk[chunk.length - 1])}」),` +
    `全篇共 ${chunks.length} 段,这是第 ${i + 1} 段。\n\n` +
    '- 只输出这一段的 markdown,**不要重复前面已经写过的小节和成就**\n' +
    '- 这一段里的每一个成就都要有自己的 `- [ ]` 行,一个都不能少\n' +
    // **各段是分开写的,你看不到别段的正文。**
    //
    // 这一行以前写的是「如果这几个成就属于你前面已经开过的小节,直接接着写条目,
    // 别把小节标题再写一遍」—— 那句话的前提是各段共用一个会话、模型真的能看见前文。
    // 各段并发之后前提没了,而那句话会让它**该写的小节标题也不写**,于是那一段的条目
    // 直接悬在上一段的标题底下,读起来像分类错了。所以反过来说:标题照开,重了程序合。
    '- 这一段是独立写的,你看不到别的段写了什么。**该开的小节标题就开** ——' +
    '相邻两段开了同一个小节的话,程序会把重复的那行合掉,不用你操心\n' +
    (last
      ? '- 这是最后一段,写完就停。不要写总结、不要写参考来源\n'
      : '- 后面还有,所以这一段结尾不要写任何收尾的话\n')
  );
}

/**
 * 某一段的打回清单。**只列这一段自己的问题**,别把别段的错误也塞进来 ——
 * 模型会顺手去"修"它这一轮根本不该输出的内容。
 */
export function buildChunkFeedback(findings, chunks, i, unnameable = new Set()) {
  if (chunks.length === 1) return buildFeedback(findings);

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

/**
 * 局部重写的提示词:**只重写点名的这几条,把原文一起给它看。**
 *
 * 这是第三种问法,和前两种都不能混用,原因值得写下来:
 *
 * - `buildChunkMessage` 是**盲写**一段 —— 它看不见任何已有正文。拿它做局部重写,
 *   模型收到的是"写这几条",而用户说的是"把这几条写详细点",那句要求就没有落点。
 * - `buildChunkFeedback` 是**按校验结果打回** —— 它的语气是"你违规了,改"。用户
 *   说「加上互斥关系」并不是攻略违规,把它包成一条 ✖ 会让模型去猜自己错在哪。
 *
 * 所以这一版把原文摆出来,然后说要求。三条约束是结构性的,不靠模型自觉:
 *
 * 1. **只输出这几条,不输出小节标题。** 拼接是按行区间做的(见 markdown.js 的
 *    `todoSpans`),多出来的标题会被贴进一条成就的位置上。
 * 2. **顺序照给的来。** 交回来的每一条还是要靠 `resolveTodoToAchievement` 反查
 *    api_name 才算认下(顺序只是让它好对,不是我们信任的凭据)—— 但顺序一致时
 *    出了偏差能一眼看出来,乱序时只能靠反查兜。
 * 3. **`- [ ]` 照旧。** 勾选状态永远是程序按数据库填的,这条在这里和在整篇生成
 *    时是同一条(见文件头 1.)。
 *
 * **原文一律给。** 曾经有个 `fresh` 开关抽掉原文让模型重新查着写,删了:界面上没有
 * 它,而「写详细点 / 补上前置条件 / 把这段改成表格」这类要求占绝大多数、且全都以
 * 看得见原文为前提。想让它彻底重写,不给要求就是了 —— 下面那句默认的话说的正是这个。
 */
export function buildPatchMessage(entries, { instruction = null } = {}) {
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
    : // 没给要求就是"重新写一遍" —— 说出来比留空强,留空会让模型倾向于原样抄回
      '要求:重新写这几条,查资料,把打法写到能照着做。';

  return (
    `这份攻略已经写好了,**这一轮只重写下面 ${entries.length} 条成就,别的一条都不要动、也不要输出**。\n\n` +
    `${ask}\n\n` +
    `要重写的是这 ${entries.length} 条,连同它们现在的写法:\n\n` +
    lines.join('\n\n') +
    '\n\n输出要求:\n' +
    `- 按上面的顺序输出这 ${entries.length} 条,每条一个顶层 \`- [ ]\` 行,放在一个 \`\`\`markdown 围栏里\n` +
    '- **不要写小节标题**,不要写别的成就,不要写开场白和结语 —— 程序会把它们贴回原来的位置\n' +
    '- 子步骤要写就缩进挂在自己那一条下面(嵌套的三个条件照旧,默认不写)\n' +
    '- 粗体成就名和清单一字不差、官方描述原文照抄、一律写 `- [ ]`(勾选状态由程序填)'
  );
}

/**
 * 哪几段需要重写。按 `apiName` 定位 —— `missing-checkbox` 带着它,而那正是
 * 分段生成压倒性的失败方式(某一段整个没写出来 / 被截断)。
 *
 * 带不了 apiName 的(比如 merged-line)定位不到,就不会触发任何一段重写;
 * 调用方遇到"一段都定位不到"时会退回全部重写,所以不会漏修,只会多花一点。
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

/** 把校验结果写成给模型看的打回清单 */
export function buildFeedback(findings) {
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

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

/** 从回复里抠出 markdown。多个围栏时取最长的那个(正文一定比零碎示例长) */
export function extractMarkdown(text) {
  const s = String(text ?? '').trim();
  const fences = [...s.matchAll(/```(?:markdown|md)?\n([\s\S]*?)```/g)];
  if (fences.length) return fences.map((m) => m[1]).sort((a, b) => b.length - a.length)[0].trim();

  // **只有开围栏、没有闭围栏**:模型忘了收尾,或者输出被截断。
  // 成对匹配的正则在这里匹配不上,于是整段(连 ```markdown 那一行)原样落进攻略文件 ——
  // 而**校验器抓不到这个**:那行既不是 checkbox,也不违反任何一条规则,
  // 51/51 照样全绿。实测踩过(2026-08-10,部落幸存者那份)
  const open = s.match(/^```(?:markdown|md)?[ \t]*\n/);
  if (open) return s.slice(open[0].length).replace(/\n```[ \t]*$/, '').trim();
  return s;
}

/**
 * 削掉模型自己写的标题/appid 行。
 *
 * 提示词已经说了别写,但这两行由程序生成是**结构性保证**,不能靠模型听话:
 * 留一份它写的下来,轻则重复标题,重则 appid 写错、攻略登记到另一款游戏上。
 * `^#\s` 只匹配一级标题,`## 主线成就` 这种小节标题不会被误删。
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

/** 程序写的头两行。`appid:` 那行是 syncGuidesFromMarkdown 唯一认的登记依据 */
export function buildHeader(game, appid) {
  return `# ${game}\n\nappid: ${appid}\n`;
}

/** 一行是不是小节标题(`##` 起,`#` 是整篇大标题、由程序写) */
const headingOf = (line) => line.match(/^(#{2,6})\s+(.*\S)\s*$/);

/**
 * 把各段拼成一份,**顺手合掉跨段重复的小节标题**。
 *
 * 各段并发写之后,模型看不见别段写了什么,于是同一个小节会被相邻两段各开一次:
 * 成就 1–50 和 51–100 都属于「主线」,两段就都会写一行 `## 主线`。拼起来就是
 * 一个标题下面空无一物、紧跟着同名标题又来一遍 —— 内容一条没少,但读起来像分类断了。
 *
 * **只合"紧挨着的同名标题",不做任何全局去重。** 判据是:这一段的第一行标题,
 * 恰好等于已拼好那部分的**最后一个**标题。真的隔了别的小节又转回来(游戏本身的分类
 * 就允许这样)不会被碰,因为那时中间隔着别的标题。
 *
 * 层级也要一样才合:`## 收集` 和 `### 收集` 是两个不同的东西,合掉会把层级弄丢。
 */
export function joinBodies(bodies) {
  const kept = bodies.filter(Boolean);
  if (kept.length <= 1) return kept.join('\n\n');

  const out = [];
  let lastHeading = null;
  for (const body of kept) {
    const lines = body.split('\n');
    // 找这一段开头的第一个标题(前面允许有空行)
    let first = 0;
    while (first < lines.length && lines[first].trim() === '') first++;
    const opening = first < lines.length ? headingOf(lines[first]) : null;
    if (opening && lastHeading === `${opening[1]} ${opening[2]}`) {
      lines.splice(first, 1);
      // 删掉标题后紧跟的空行,免得留下一个突兀的空段
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

/** 攻略文件名。中文名削不出 ASCII 就退回 app_<appid>,反正显示名取自 `# 游戏名` 那行 */
export function guideFileName(game, appid) {
  const slug = String(game ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${slug.length >= 3 ? slug : `app_${appid}`}_achievements.md`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 生成一份攻略。
 *
 * @param {object}   db
 * @param {object}   o
 * @param {object}   o.config
 * @param {object}   o.provider   lib/ai.js 的供应商
 * @param {object}   o.steam      SteamClient —— 机械打勾要真实解锁状态
 * @param {string}   o.appid
 * @param {number}   [o.rounds]   最多改几轮(默认 3)
 * @param {string}   [o.fileName] 覆盖默认文件名
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
}) {
  // 0 轮或 NaN 会让下面的循环一次都不跑,于是"没有 blocking"被读成"过关了",
  // 接着去复制一个根本不存在的草稿。当场拦下来比在 ENOENT 上猜半天强
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`rounds 要是 ≥1 的整数,拿到的是 ${rounds}`);
  }

  // 允许把 plan 传进来:CLI 要先拿 plan 算差异预览、问过人之后才开跑,
  // 重新 plan 一次既多打几个接口,也留下"问的那份和写的那份不是同一份"的缝
  const plan = given ?? (await planGuide(db, { config, steam, appid, fileName, notion, local, overwrite }));
  const { defs, game, unlocked, finalPath, draftPath } = plan;

  // 没有联网能力的供应商换一套调研要求。设计文档把"有服务端搜索"定成硬性准入,
  // 拦在 CLI 那一层;真要跑(--no-research)也不能装作有资料可查
  const canSearch = provider.canSearch !== false;
  const system = buildSystemPrompt(game, appid, defs, { canSearch, rarity: plan.rarity });
  // 联网工具由供应商自己声明:各家的形状完全不一样,编排这一层不该知道
  /**
   * **每个顶层段一个会话,不再是全篇共用一个。**
   *
   * 共用一个会话买到的是"模型看得见自己前面写了什么",而它的代价是**各段只能排队**:
   * 一个会话就是一条链,第 4 段必须等前 3 段写完。实测这条链是整件事的全部时间 ——
   * 一段 10 个成就要一两百秒,197 个成就四段就是半小时,而其中绝大部分是模型在想。
   *
   * 换成每段一个会话之后,段与段之间没有依赖,可以同时发出去。丢掉的那点跨段可见性
   * 有两个对应的补偿,都不靠模型自觉:
   *
   * - **成就不会重复**:每段的提示词点名了它要写的编号区间和首尾成就名,各段互不相交,
   *   这一条本来就是结构保证的,不依赖它看得见别段。
   * - **小节标题会重复**,这是真的会发生的:相邻两段都属于「主线」就会各写一行 `## 主线`。
   *   所以提示词改成"标题照开",拼接时由 `joinBodies` 把紧挨着的同名标题合掉。
   *   老提示词那句"别把小节标题再写一遍"在并发下是有害的 —— 见 buildChunkMessage。
   *
   * 另外一个顺带的好处:共用会话时每段请求都要把**前面所有段的正文连同 thinking**
   * 一起重发,197 个成就到第 4 段时上下文已经十几万字符。各段独立之后每条链只装自己。
   */
  const sessions = [];
  const sessionFor = (s) =>
    (sessions[s] ??= createSession(provider, { system, tools: provider.webTools() }));

  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });

  let lint = null;
  let blocking = [];
  let expected = [];
  let round = 0;
  // 模型这一轮实际发出去的搜索词。**能搜 ≠ 搜了** —— 声明了工具却一次没搜,
  // 生成的就是它凭记忆写的东西,而这正是 canSearch 那套设计要防的静默质量差别
  const searchQueries = [];
  // 一次写不完就分段写。各段一个会话、并发跑 —— 见上面 sessionFor 那段
  let chunks = chunkDefs(defs, config.ai?.chunkSize ?? 50);
  let bodies = [];

  /**
   * 第一轮的工作区:**每个顶层段自己的子段列表**。
   *
   * 切小(见 canSplit)以前是 `chunks.splice(i, 1, a, b)`,直接改全局那个数组。
   * 顺序跑时这没问题,因为只有一个循环在走它;并发之后它是共享可变状态 ——
   * 第 2 段切一刀,正在跑的第 3、4 段的下标当场全错位,而**不会有任何东西报错**,
   * 只会让提示词里的编号、失败报告里的段号、以及下一轮的重写目标各错各的。
   *
   * 所以切分改成只动自己这一格:`shardChunks[s]` 是第 s 段被切成了哪几块。
   * 第一轮跑完再按顺序摊平成 `chunks` —— 摊平是确定性的(按 s、再按 sub),
   * 和哪一段先跑完无关。`shardBodies` 与它逐格对齐,失败的格子写 `null` 而不是留空,
   * 否则摊平之后正文和段就会错位一格。
   */
  const shardChunks = chunks.map((c) => [c]);
  const shardBodies = chunks.map(() => [null]);
  /** 摊平后:第 j 段属于哪个顶层段 —— 重写轮要用它那条链上的会话 */
  let sessionOwner = chunks.map((_, s) => s);

  /**
   * 同时发几段。默认 3 是保守的:每段一条链,3 条同时跑已经把最常见的 2–4 段一次吃下,
   * 而并发主要吃的是供应商的限流额度(429 走 maxRetries 那条退避路,不会丢段)。
   * 设 1 就退回原来的顺序行为,排查问题时有用。
   */
  const concurrency = Math.max(1, Math.floor(Number(config.ai?.concurrency) || 3));

  /** 提示词里要报「共几段、这是第几段」,而并发时别的段也在切。单线程,读到的一定是完整值 */
  const viewOf = (s, sub) => ({
    view: shardChunks.flat(),
    index: shardChunks.slice(0, s).reduce((n, subs) => n + subs.length, 0) + sub,
  });

  onProgress({ phase: 'plan', chunks: chunks.length, achievements: defs.length });

  /**
   * **每写完一段就落盘。**
   *
   * 草稿原来是在整个分段循环**跑完之后**才写的,于是任何一段中途失败都会把前面
   * 几段连同它们的联网研究一起丢掉 —— 而那几段是用户已经付过钱的东西。
   * 实测撞到过:KINGDOM HEARTS -HD 1.5+2.5 ReMIX-(197 个成就分 4 段),第 3 段
   * 失败,`guides/.drafts/` 是空的,前两段几分钟的研究一个字没留下。
   *
   * 写进 `.drafts/` 是安全的:`syncGuidesFromMarkdown` 是非递归 readdir,
   * 看不见这个子目录(见文件头注释),所以半份草稿绝不会被登记成攻略。
   */
  // 第一轮读工作区(段可能还在切),之后几轮读摊平后的 bodies。并发时任何一段写完
  // 都会落一次盘,落的是**当时已经拿到的全部段** —— 中途炸了也留得住已经付过钱的部分。
  // 拼接走 joinBodies,它顺手合掉跨段重复的小节标题
  const liveBodies = () => (round <= 1 ? shardBodies.flat() : bodies);
  const writeDraft = () =>
    writeFileSync(draftPath, buildHeader(game, appid) + '\n' + joinBodies(liveBodies()) + '\n');

  /**
   * 这一轮里彻底没写出来的段。**记下来,不抛。**
   *
   * 一段失败就整份作废,是拿"少一段"换"一份都没有" —— 而少的那一段有现成的补救
   * 路径:它的成就全部会被校验器报成 `missing-checkbox`(带 apiName),
   * `chunksNeedingRewrite` 于是精确地把这一段挑出来,下一轮只重问它。
   * 那套机器本来就在,为分段生成的头号失败方式(某段整个没出来)写的。
   *
   * 每轮开头清空:它描述的是**最终**状态,不是历史。第一轮失败、第二轮补上了的段
   * 不该还挂在这里,否则报告会说一段丢了而它其实在文件里。
   */
  const chunkFailures = [];
  /** 全军覆没时要抛的那个原始错误 —— 报"197 个成就都缺 checkbox"是拿症状当病因 */
  let firstChunkError = null;

  /**
   * 之后几轮问哪几段(下标)。**第一轮不看它** —— 第一轮是"从头到尾走一遍",
   * 而它走的过程中段数可能变(截断会把一段拆成两段),所以那一轮按 chunks 的
   * 当前长度走,不能先把下标列死
   */
  let targets = [];

  const ask = async (session, msg, label) => {
    const reply = await session.ask(msg, {
      onEvent: (ev) => {
        // 通用进度事件,不认识任何一家的原始格式
        if (ev.type === 'tool') onProgress({ phase: 'tool', round, name: ev.name, label });
        else if (ev.type === 'search') {
          onProgress({ phase: 'tool', round, name: `搜索「${ev.query}」`, label });
        }
      },
    });
    for (const q of reply.searchQueries ?? []) if (!searchQueries.includes(q)) searchQueries.push(q);
    // refusal / max_tokens 截断 / 工具报错都是 HTTP 200。这里必须先问一句再用正文,
    // 尤其 max_tokens ——半份攻略看起来完全正常,校验器只会报"后半段的成就都缺 checkbox"
    const verdict = checkResult(reply);
    if (!verdict.ok) {
      const err = new Error(`第 ${round} 轮${label ? `(${label})` : ''}没拿到可用结果:${verdict.reason}`);
      // 让上面分辨得出"这种失败能不能补救"。**用 code 不用 reason 的文字** ——
      // 拿人话当接口,改个措辞就悄悄失灵
      err.code = verdict.code;
      throw err;
    }
    // 不拦路的降级(实际上就是抓页失败)也得露面,否则就是这个项目最防的那种静默降级。
    // 借已有的 tool 相走,CLI 和 Dashboard 都已经在显示它,不用新加一条管线
    for (const w of verdict.warnings) onProgress({ phase: 'tool', round, name: `⚠️ ${w}`, label });
    return stripLeadingHeader(extractMarkdown(reply.text));
  };

  /**
   * 一段的重试阶梯:原样再问 → 切成两半 → 记下来放过。**三级都在这个内层循环里**,
   * 而不是靠外层 `continue` 绕回来 —— 那样"这一段问了第几次"就得挂在外面,
   * 而切小之后那个计数该归零,两件事缠在一个变量上迟早错。
   *
   * `locate()` 把"我是第几段"和"一共几段"外包出去,因为这两个数在第一轮(并发、
   * 别的段还在切)和之后几轮(下标固定)算法完全不同,而阶梯本身对此毫无兴趣。
   */
  const askChunk = async ({ session, chunkAt, setChunks, setBody, locate, prompt }) => {
    let attempt = 0;
    for (;;) {
      const { index, total } = locate();
      const label = total > 1 ? `第 ${index + 1}/${total} 段` : '';
      // **`done` 是并发之后唯一还能读的进度。** 并发时三段同时在写,"当前第几段"
      // 每隔几秒就在 1/4、3/4、2/4 之间跳,看着像进度在倒退。已写完几段是单调的,
      // 而且顺序跑时它同样成立,所以两种模式共用一个说法
      onProgress({
        phase: 'ask', round, rounds, chunk: index + 1, chunks: total,
        done: liveBodies().filter(Boolean).length,
      });
      try {
        setBody(await ask(session, prompt(index, total), label));
        return null;
      } catch (err) {
        // **摘掉刚才那一轮是下面每一条的前提,不是收尾。** 废稿(半份、或者一条
        // 空 assistant)留在上下文里,而重问的提示词写着"不要重复前面已经写过的
        // 成就" —— 模型会跳过它写了一半的那几个,产出看着正常但是缺条目
        session.dropLastTurn();

        // ① 空回复 ⇒ 原样再问一次。见 canRetry
        if (canRetry(err, attempt)) {
          attempt++;
          onProgress({
            phase: 'retry', round, chunk: index + 1, chunks: total,
            attempt, of: EMPTY_RETRIES, reason: err.code,
          });
          continue;
        }

        // ② 一分为二,只重问这两半。
        //
        // 用的是**已经发生的事实**,不是开跑前的估算 —— 装进单次请求的是
        // thinking + 正文,而 thinking 随游戏、模型、端点变。任何"先算出该切多大"的
        // 做法都是在预测那个量;失败本身则是量到的。
        // 每次至少减半,所以必然在几步内收敛到 MIN_CHUNK,不需要再加一个次数上限
        if (setChunks && canSplit(err, round, chunkAt())) {
          const cur = chunkAt();
          const half = Math.ceil(cur.length / 2);
          setChunks(cur.slice(0, half), cur.slice(half));
          onProgress({
            phase: 'resplit', round, chunk: index + 1, chunks: locate().total,
            from: cur.length, to: half, reason: err.code,
          });
          attempt = 0; // 换了一段更小的内容,重试次数重新算
          continue; // 同一个位置重来,现在它是前一半
        }

        // ③ 整体故障原样抛出去 —— 见 CHUNK_LOCAL。**放过一段的前提是那一段自己
        //    的问题**,供应商坏了不在里面
        if (!CHUNK_LOCAL.has(err?.code)) throw err;

        // ④ 招用完了。**这一段作废,整份不作废** —— 见 chunkFailures
        const cur = chunkAt();
        const failed = chunkFloorAdvice(err, round, cur);
        // **失败就不碰 setBody。** 第一轮那一格本来就初始化成 null;而重写轮里
        // 那一格装的是上一轮写好的正文,把它抹掉等于因为"改不动"就把原来能用的那份
        // 也丢了。两种情形都要求这里什么都不做,所以这里什么都不做
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
   * 有上限的并发。**炸了之后不再派新活,但已经在飞的那几个等它们落地。**
   *
   * 顺序版里"整体故障当场抛出去"能省下"每剩一段就再撞一次墙"的钱。并发版做不到
   * 当场:请求已经发出去了,取消不了。能做到的是**不再往下派**,于是最坏多撞
   * `limit - 1` 次,而不是每一段都撞一次 —— 这就是它值得存在的全部理由。
   */
  const runPool = async (n, limit, worker) => {
    let next = 0;
    let stop = false;
    // **按段号取最小的那个抛出去,不是"最先炸的那个"。**
    // 401 会让所有在飞的请求一起失败,而它们谁先 reject 取决于网络快慢 ——
    // 用"最先"的话,同一个输入两次跑能报出不同的原因,排查时先怀疑的方向就不一样。
    // 和下面 firstChunkError 挑最小段号是同一条理由
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
          stop = true; // 不再派新活;已经在飞的那几个还是会跑完
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, n) }, lane));
    if (failures.length) throw failures.sort((a, b) => a.i - b.i)[0].err;
  };

  for (round = 1; round <= rounds; round++) {
    // 描述最终状态,不是历史 —— 见 chunkFailures 的注释
    chunkFailures.length = 0;

    if (round === 1) {
      // ---- 第一轮:各段并发,每段一条自己的链 ----
      //
      // 失败先记在 `{s, sub}` 上,**摊平之后再换算成段号**。并发时"当下的下标"
      // 会被别的段的切分挪动,当场算出来的段号可能和最终文件里的对不上 ——
      // 顺序版靠"切分只发生在当前下标、循环只往前走"保证过这件事,那个前提没了
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
              return buildChunkMessage(view, index);
            },
          });
          if (failure) pending.push({ s, sub, ...failure });
          // 拿到了就立刻落盘。**放在 askChunk 外面** —— 写盘失败(磁盘满、权限)是
          // 我们这边的故障,不是"这一段模型没写出来",不该被那套重试阶梯当成后者
          if (shardBodies[s][sub]) writeDraft();
        }
      });

      // 摊平:顺序只由 (s, sub) 决定,和谁先跑完无关
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
      // 全军覆没时要抛的那个原始错误。**按段号取最小的那个**,别取"最先抛出来的"——
      // 并发下谁先炸取决于网络快慢,同一个输入两次跑能报出不同的原因
      const firstFailed = pending.slice().sort((a, b) => a.s - b.s || a.sub - b.sub)[0];
      firstChunkError ??= firstFailed?.error ?? null;
    } else {
      // ---- 之后几轮:按校验结果定点重写,顺序跑 ----
      //
      // **故意不并发。** 重写轮通常只有一两段,省不下多少;而切小过的段共用它那个
      // 顶层段的会话(重写要的正是"你上一版写的那份"),并发会让两个请求同时用一条
      // 会话 —— messages 是共享可变状态,插进去就乱了。收益小、失败方式脏,不换
      for (const i of targets) {
        const failure = await askChunk({
          session: sessionFor(sessionOwner[i]),
          chunkAt: () => chunks[i],
          setChunks: null, // 重写轮不切:targets 是按当前下标算好的,中途改段数会让它失效
          setBody: (text) => { bodies[i] = text; },
          locate: () => ({ index: i, total: chunks.length }),
          prompt: () =>
            // **这一段还什么都没有 ⇒ 用原来那句"写这一段"。** 拿 buildChunkFeedback
            // 去问一段从没写出来的内容,等于甩过去五十条"缺 checkbox" ——
            // 而模型缺的不是修正意见,是这一段本身
            bodies[i]
              ? buildChunkFeedback(lint.findings, chunks, i, plan.unnameable)
              : buildChunkMessage(chunks, i),
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

    // **一段都没写出来 ⇒ 硬失败,而且要抛第一个真原因。**
    // 继续往下走会拿一份空草稿去校验,报出"每个成就都缺 checkbox",然后再花两轮
    // 重问 —— 症状盖住病因,还多花两轮的钱
    if (chunkFailures.length && !bodies.some(Boolean)) throw firstChunkError;

    onProgress({ phase: 'check', round });
    // 各段拼起来才是完整的一份。**打勾和校验一律对着完整的这份做** ——
    // 逐段校验会把"成就写重了""小节标题重复"这类跨段的问题整个漏掉
    writeDraft();

    // 机械打勾:模型写的全是 `- [ ]`,这里按数据库把该勾的勾上
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

    // 最后一轮不用再组织回灌了,直接落到下面的"没过"报告
    if (round >= rounds) break;

    // 只把模型改得动的回灌。一条 checked-mismatch 落到这里说明是我们自己的打勾出了问题,
    // 让模型去改只会让它开始瞎写 `- [x]`;而且再问几轮也不会好,不如当场停下来说清楚
    if (!blocking.some((f) => MODEL_FIXABLE.has(f.code))) {
      throw new Error(
        '校验没过,但没有一条是模型能改的(多半是机械打勾本身出了问题)。草稿留在 ' +
          draftPath + ',先看这几条:\n  ' + blocking.map((f) => f.message).join('\n  ')
      );
    }

    // 下一轮只重问**出了问题的那几段**。整份重写在分段的情况下根本不可行
    // (几百个成就一次输出不完,那正是分段的理由),而且会把已经写好的段落
    // 重新掷一次骰子。定位不到任何一段时退回全部重写 —— 那是分一段时的老行为
    targets = chunksNeedingRewrite(blocking, chunks);
    if (!targets.length) targets = chunks.map((_, i) => i);
    onProgress({ phase: 'rewrite', round: round + 1, chunks: targets.length, of: chunks.length });
  }

  // **知道有一段没写出来就绝不落地。** 正常情况下这一条是多余的(缺一段 ⇒ 那 50 个
  // 成就全部 missing-checkbox ⇒ blocking 非空),留着是因为"我们已经知道它不全"
  // 这件事不该由另一条规则代为把关 —— 万一哪天校验器放过了,这里也不会把半份攻略
  // 当成品写进用户的笔记
  const ok = blocking.length === 0 && chunkFailures.length === 0;
  let registered = null;
  let landedUrl = null;
  let unconverted = [];
  let backup = null;
  let finalTodos = [];
  let finalText = '';

  // 覆盖的备份**在这里做,不在落地函数里**:两个后端一条规矩,而且它必须发生在
  // 任何一个写操作之前。备份失败就整件事停下 —— 没有备份的覆盖是不可逆的删除,
  // 而这个项目对不可逆操作的规矩是"先能回退,再动手"
  if (ok && plan.existing) {
    onProgress({ phase: 'backup' });
    backup = await backupGuide(config, { guide: plan.existing, appid, notion });
    onProgress({ phase: 'backup-done', path: backup.path, bytes: backup.bytes });
  }

  if (ok && plan.target === 'notion') {
    const landed = await landToNotion(db, {
      notion, steam, config, plan, appid, game, defs, unlocked, backup, onProgress,
    });
    ({ registered, unconverted } = landed);
    landedUrl = landed.url;
    lint = landed.lint;
    finalTodos = landed.todos;
    finalText = landed.text;
    rmSync(draftPath, { force: true });
  } else if (ok) {
    // 落盘。新建文件、机器闸门过了 ⇒ 自动写(可逆)。覆盖已有文件走的是同一行 ——
    // 区别在于上面已经先备份过、CLI 那边也已经拿差异预览问过人了
    writeFileSync(finalPath, readFileSync(draftPath, 'utf8'));
    rmSync(draftPath, { force: true });

    // 写完重新读一遍再验一次。"调用成功 ≠ 内容正确"是这个项目栽过的跟头,
    // 落盘路径上多花一次读的钱换一次真确认
    const after = lintGuide({
      todos: loadTodos(finalPath),
      defs,
      text: readFileSync(finalPath, 'utf8'),
      unlockedApiNames: unlocked,
      kind: 'local',
    });
    const recheck = splitFindings(after.findings, plan.unnameable);
    if (recheck.blocking.length) {
      throw new Error(`落盘后重新校验又出问题了(${finalPath}):` +
        recheck.blocking.map((f) => f.message).join('; '));
    }
    lint = after;
    finalTodos = loadTodos(finalPath);
    finalText = readFileSync(finalPath, 'utf8');

    // 用真正的发现逻辑登记,不自己 upsert ——省得两处对"标题怎么取""后端冲突怎么办"
    // 的理解慢慢跑偏
    registered = syncGuidesFromMarkdown(db, config).added.find((a) => a.appid === String(appid)) ?? null;
    landedUrl = finalPath;
  }

  return {
    ok,
    game,
    appid: String(appid),
    target: plan.target,
    url: landedUrl,
    unconverted,
    // 这一份到底有没有经过调研,要跟着结果一起交出去 —— 调用方必须能如实告诉用户
    // canSearch 是"能不能搜",searchQueries 是"实际搜了什么" —— 两个都要交出去
    researched: canSearch,
    searchQueries,
    path: ok && plan.target === 'local' ? finalPath : null,
    draftPath: ok ? null : draftPath,
    rounds: round > rounds ? rounds : round,
    lint,
    blocking,
    // 哪几段最后没写出来。**必须交出去**:少一段的症状是几十条 missing-checkbox,
    // 而那是症状不是病因 —— 调用方要能说出"第 3 段没拿到结果",否则用户只看到
    // 一长串"缺 checkbox",会以为模型忘了写,而真相是那一段整个没回来
    chunkFailures,
    expected,
    // **把每条链的账加起来。** 以前只有一个会话,`session.usage` 就是全部;各段
    // 独立之后每条链各记各的,只报第一条等于把绝大部分用量吞掉 —— 而这个数字是
    // 唯一能拿去和供应商账单对账的东西(见 lib/ai.js 里 formatUsage 的注释)
    usage: sessions.reduce((tot, s) => addUsage(tot, s.usage), emptyUsage()),
    model: provider.model,
    registered,
    // 覆盖时原文备份在哪。调用方必须把它讲出来 —— 一次不可逆操作的退路,
    // 藏在返回值里没人报,等于没有
    backup: backup ? { path: backup.path, bytes: backup.bytes, count: backup.count } : null,
    overwrote: plan.existing ? { kind: plan.existing.kind, url: plan.existing.url } : null,
    todos: finalTodos,
    text: finalText,
  };
}

/**
 * 把过了闸门的草稿写进 Notion,然后**回读一遍重新校验**。
 *
 * 顺序是有讲究的:先建页(或者用查到的那个空页),再分批填正文,最后回读。
 * 回读不是走个过场 —— markdown 到 block 的转换、Notion 的渲染、嵌套层级,
 * 每一步都可能在不报错的情况下产出别的东西。这个项目的原则是"调用成功 ≠ 内容正确",
 * 而校验用的是**跟 `guide-lint` 完全同一个函数、同一个 todo 形状**,
 * 所以这次回读校验和平时对着线上页面跑的那次是一回事,不是另写一套宽松版。
 */
export async function landToNotion(
  db,
  { notion, steam, config, plan, appid, game, defs, unlocked, backup = null, onProgress = () => {} }
) {
  const markdown = readFileSync(plan.draftPath, 'utf8');
  const { blocks, unconverted } = markdownToBlocks(markdown);

  // 覆盖已有的攻略页:清空正文再写新的。**标题、图标、状态一律不动** ——
  // 用户是来换攻略内容的,不是来换这一页的身份的;`guide-status` 也还会按完成度收敛状态。
  //
  // 删之前必须已经备份好(`backup` 由 generateGuide 传进来,拿的就是同一批 block),
  // 所以这里不重新读一次页面:让备份和删除各读一次,等于给"备份的和删掉的不是同一批"
  // 留了一条缝 —— 中间只要有人动了那一页,备份里就少一块,而少的那块已经被删了
  if (plan.existing?.kind === 'notion') {
    if (!backup?.blocks) throw new Error('覆盖 Notion 攻略前没有拿到备份,拒绝删除页面内容');
    const page = { id: extractNotionPageId(plan.existing.url), url: plan.existing.url };
    onProgress({ phase: 'notion-clear', url: page.url, blocks: backup.blocks.length });
    for (const b of backup.blocks) {
      await notion.deleteBlock(b.id);
      // 和 appendBlocks 一样自己让着点。一篇攻略是几十上百个块,不歇气地删会撞上限流,
      // 而这条路上每一次 429 重试都发生在"旧内容已经删了一半"的状态里
      await sleep(200);
    }
    // 覆盖也补一次空图标格 —— 和新建、接管两条路同一条规矩,不然三条落地路各有各的脾气。
    // 图标得**读出来**再判断:硬传 icon: null 会让"只补空格"变成"每次都覆盖"。
    // 读失败时退回一个非空值,于是 fillMissingIcon 认为"已经有图标"而不动它 ——
    // 拿不准的时候不碰用户的东西,方向和整个项目一致
    const current = await notion.fetchPageIcon(page.id).catch(() => ({ type: 'unknown' }));
    await fillMissingIcon(notion, { ...page, icon: current }, await fetchGameIcon(steam, appid).catch(() => null));
    onProgress({ phase: 'notion-fill', url: page.url, blocks: blocks.length });
    return finishNotionLanding(db, { notion, page, blocks, unconverted, defs, unlocked, plan, appid });
  }

  let page = plan.notion.existingPage;
  // 图标是锦上添花:拿不到就不要,别为了个图标把生成好的攻略卡住
  const icon = await fetchGameIcon(steam, appid).catch(() => null);

  if (page) {
    // 用户自己建的空页:**只填正文,不动标题和状态**。那两样是他手设的,我们要写的是正文;
    // 顺手"顺便改一下"就是在不可逆地覆盖别人的选择。状态真不对的话,`guide-status`
    // 会按完成度自己收敛。
    //
    // 图标是这条规矩里**唯一的例外,而且只补空着的那一格**:没有图标不是"用户选了不要图标",
    // 是那一格还没人填过。填空不是覆盖 —— 已经有图标的(哪怕是个 emoji)一律不碰
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
 * 写正文 → 回读重校验 → 走真发现逻辑登记。**新建、接管空页、覆盖三条路共用这一段**,
 * 就是为了让"写完要回读"这件事没有哪条路能绕过去 —— 覆盖那条路最需要它:
 * 旧内容已经删了,新内容要是没落对,页面就是空的。
 */
async function finishNotionLanding(db, { notion, page, blocks, unconverted, defs, unlocked, plan, appid }) {
  await notion.appendBlocks(page.id, blocks);

  // 回读校验。todos 的形状两种后端一样,所以这里喂给 lintGuide 的和 guide-lint
  // 平时喂的是同一种东西
  const todos = await notion.fetchAllToDoBlocks(page.id);
  const after = lintGuide({ todos, defs, unlockedApiNames: unlocked, kind: 'notion' });
  const recheck = splitFindings(after.findings, plan.unnameable);
  if (recheck.blocking.length) {
    throw new Error(
      `写进 Notion 之后回读校验没过(${page.url}):` +
        recheck.blocking.map((f) => f.message).join('; ') +
        '\n页面已经建好了,内容也在上面,自己看一眼决定是留是删。'
    );
  }

  // 用真正的发现逻辑登记 —— 它会自己回去读页面上的 `appid:` 行。
  // 顺带就验了一件只有这样才验得到的事:**我们写的那行 appid,发现逻辑真的认得出来**。
  // 自己 upsert 的话,一个渲染错了的 appid 行要等到下次 serve 才暴露
  const discovered = await syncGuidesFromNotion(db, notion);
  const registered =
    discovered.added.find((a) => a.appid === String(appid)) ??
    // 覆盖时这一页早就登记过了,发现逻辑不会把它算进 `added` —— 那不是失败。
    // 但"页面上的 appid 行还读得出来"仍然要验,所以退回去直接读一次
    ((await notion.extractAppIdFromPageContent(page.id)) === String(appid)
      ? { appid: String(appid), url: page.url, action: 'overwritten' }
      : null);
  if (!registered) {
    throw new Error(
      `页面写好了(${page.url}),但攻略发现逻辑没能从上面读出 appid:${appid}。` +
        '页面在,内容在,只是 Dashboard 上暂时不会出现链接 —— 检查正文第一行的 `appid:`。'
    );
  }

  // todos/text 一起交出去:覆盖之后要拿它和旧的那份做对照,而 lintGuide 只返回结论
  // 不返回素材。让调用方为了对照再读一次页面,读到的就可能不是刚写的那一份了
  return { url: page.url, lint: after, registered, unconverted, todos, text: todos.map((t) => t.text).join('\n') };
}

/**
 * 前置检查 + 数据准备。**所有拒绝理由都在这里一次性给完**,不要跑到一半、花了钱
 * 才发现文件已经存在。
 */
export async function planGuide(db, {
  config, steam, appid, fileName = null, notion = null, local = false, overwrite = false,
}) {
  const id = String(appid);
  let defs = achievementsFor(db, id);

  // **没有成就详情就当场去取,不要求用户先跑一次全库同步。**
  //
  // 这里原来是直接拒绝,附一句"先跑 `node tracker.js sync --schema`" —— 而
  // Dashboard(尤其是打包版)的用户**根本没有终端**,那句话对他们是个死胡同。
  //
  // 而且这不是罕见情况,是两类必然会碰上的游戏:
  //   刚添加的  —— 还没轮到批量同步
  //   已打满的  —— syncAchievementSchema 有意跳过 `rate === 1`(平时没有 checklist
  //                可看,省调用),于是对它们这堵墙是**永久**的,按多少次同步都没用
  // 手动添加的游戏多半是家庭共享的老游戏,正好是这两类的交集。
  //
  // 代价是一两次 Steam 调用,而且只在真的缺的时候发生;换来的是"点了就能用"。
  // 取不到才拒绝 —— 那种情况是这游戏在 Steam 上确实没有成就定义,不是同步没跑
  if (!defs.length) {
    const row = getGame(db, id);
    if (!row) throw new Error('这个游戏不在列表里');
    const got = await fetchGameSchema(db, steam, row).catch(() => false);
    defs = got ? achievementsFor(db, id) : [];
  }
  if (!defs.length) {
    const err = new Error('Steam 上查不到这个游戏的成就清单,没有可写的内容。');
    err.code = 'no-schema';
    throw err;
  }

  // 上限还在,但它现在管的是"跑多久、花多少",不是"技术上写不出来" ——
  // 超过一段的会自动分段写(见 chunkDefs)。库里最多的一款 408 个成就
  const max = config.ai?.maxAchievements ?? 500;
  if (defs.length > max) {
    const err = new Error(
      `这个游戏有 ${defs.length} 个成就,超过了一次生成的上限 ${max},没有开始。`
    );
    // 上限是配置项,改它属于"高级用法" —— CLI 会把具体怎么改印出来(见 tracker.js),
    // Dashboard 只说发生了什么。同一句话同时服务两个界面,两边都会写歪
    err.code = 'too-many-achievements';
    err.detail = { count: defs.length, max };
    throw err;
  }

  const gameRow = getGame(db, id);
  const game = gameRow?.name || defs[0].game_name || id;

  // 一个 appid 只能有一个攻略后端。已经登记过 = 这是一次**覆盖**,不可逆,
  // 所以默认拒绝;`--overwrite` 才放行,而且下面会先备份、先给差异预览
  const existing = getGuide(db, id);
  if (existing && !overwrite) {
    const where = existing.kind === 'notion' ? 'Notion 页面' : '本地文件';
    // 只陈述"已经有了"。**两个界面的下一步动作不是同一个东西** —— 终端要加
    // `--overwrite`,Dashboard 上那一行有个「重写」按钮。写死其中一个,另一边就是废话
    const err = new Error(`《${game}》已经有攻略了(${where}:${existing.url})。`);
    err.code = 'guide-exists';
    err.detail = { kind: existing.kind, url: existing.url };
    throw err;
  }

  // 覆盖时写回**这份攻略自己所在的后端**,不走上面那条默认规则:
  // `--overwrite` 一个本地攻略,意思是重写那个本地文件,不是顺手把它搬去 Notion。
  // 换后端是 `guide-to-notion` 的职责,两件事混在一个命令里,出了问题分不清是谁干的
  const name = existing?.kind === 'local' ? existing.url : (fileName ?? guideFileName(game, id));
  const finalPath = join(config.guidesDir, name);
  const draftPath = join(config.guidesDir, DRAFTS_DIR, name);

  // 攻略写去哪:Notion 连着就写 Notion。这是 SKILL.md 8.0 定下的 ——
  // 攻略是用户自己的笔记,它们已经有 105 篇在 Notion 里了,新的一篇落在本地
  // 就是把一份笔记劈成两处。`--local` 是明确说"这次写本地"的出口
  const target = existing
    ? existing.kind
    : !local && notion?.configured && config.notion?.overviewDbId
      ? 'notion'
      : 'local';

  // 覆盖已有 Notion 页时**不查 planNotionTarget**:那个函数的职责是"给新攻略找一页
  // 空页或者建一页",它会因为页面有内容而拒绝 —— 而这里页面有内容正是前提。
  // 目标页就是已登记的那一页,标题和状态原样不动,我们只换正文
  const notionPlan =
    target === 'notion' && !existing
      ? await planNotionTarget(notion, game, { statusValue: newGuideStatus(gameRow) })
      : null;

  // 没登记进 guides 表、但文件已经躺在那儿 —— 同样是覆盖,同样要 --overwrite。
  // 草稿始终写本地,所以这条对两种目标都要查
  if (target === 'local' && !existing && existsSync(finalPath)) {
    const err = new Error(`已经有一个同名文件了:${finalPath}`);
    err.code = 'file-exists';
    err.detail = { path: finalPath };
    throw err;
  }

  // 覆盖前先读旧攻略,给差异预览用。**读在花钱之前** —— 读不出来就说明那份攻略
  // 已经有问题了,该当场停,而不是等模型写完、钱花完再发现没法比对
  let oldTodos = [];
  let oldText = '';
  if (existing) {
    if (existing.kind === 'local') {
      const path = resolveGuidePath(config.guidesDir, existing.url);
      if (!existsSync(path)) throw new Error(`guides 表指着 ${path},但那个文件不在了`);
      oldTodos = loadTodos(path);
      oldText = readFileSync(path, 'utf8');
    } else {
      oldTodos = await notion.fetchAllToDoBlocks(extractNotionPageId(existing.url));
      oldText = oldTodos.map((t) => t.text).join('\n');
    }
  }

  // 机械打勾要真实解锁状态。拿不到就**不生成**:全部不勾的攻略等于一份错的攻略,
  // 而校验器会把它报成一堆 checked-mismatch,看着像模型写错了
  const raw = await steam.fetchPlayerAchievements(id);
  if (raw.retry) throw new Error(`Steam 没给出 ${id} 的解锁状态(限流或临时故障),等会儿再试`);
  if (raw.noAchievementSystem) throw new Error(`Steam 说 ${id} 这个账号没有成就数据,没法机械打勾`);
  const unlocked = new Set((raw.achievements ?? []).filter((a) => a.achieved).map((a) => a.apiname));

  // 全球解锁率:难度信号,给模型分配力气用。拿不到就算了 —— 锦上添花的数据,
  // 不该因为它挂掉就不给人生成攻略
  const rarity = await steam.fetchGlobalAchievementPercentages(id);

  return {
    defs, game, unlocked, rarity, finalPath, draftPath, target,
    notion: notionPlan,
    fileName: name,
    unnameable: unnameableApiNames(defs),
    // `existing` 非空就是一次覆盖。下游靠这一个字段判断要不要备份、要不要清旧内容
    existing: existing ?? null,
    oldTodos,
    oldText,
  };
}

/**
 * 把校验结果分成"必须解决"和"已知够不着"。
 *
 * **进 `expected` 的判据只有一条:有没有任何人的任何操作能消掉它?** 没有 ⇒ 报出来,
 * 但不拦。拦一条谁都改不动的错,唯一的效果是先花掉三轮改写、再把一份写对了的攻略丢掉。
 *
 * 现在有两种够不着,来源不同:
 *
 * 1. `checked-mismatch` + 名字撞车 —— `computeCheckedKeys` 对撞名的成就一律跳过
 *    (宁可漏勾不能勾错),于是解锁了框也不会被勾上。**这一条需要 `unnameable` 那道闸**,
 *    因为 `checked-mismatch` 对任何成就都会报,撞名只是其中一种。
 * 2. `ambiguous-empty-description` —— 同名,而 Steam 上的描述是空字符串,于是区分它们的
 *    唯一凭据根本不存在。**这一条不看 `unnameable`**:它的触发前提本身就含"名字撞车",
 *    比 unnameable 更窄,加上去是个恒真判断。
 *
 * **这张清单是逐条列举的,不是"某一类"。** 上一版这里写的是"只有 checked-mismatch 能
 * 豁免",而那句话既是错的、又挡着第 2 种被发现 —— 详见 lib/guidelint.js 里那段注释。
 * 加新条目之前先回答那个判据;`ambiguous-no-description`(描述在、只是没抄)就答不上来,
 * 所以它照常拦。
 */
export function splitFindings(findings, unnameable) {
  const blocking = [];
  const expected = [];
  for (const f of findings) {
    if (f.level !== 'error') continue;
    if (f.code === 'checked-mismatch' && unnameable.has(f.apiName)) expected.push(f);
    // **`ambiguous-empty-description` 也够不着,而且是更彻底的够不着。**
    //
    // 同名 + Steam 上描述是空的 ⇒ 区分这两个成就的唯一凭据不存在,任何重写都不可能
    // 满足它。放在 blocking 里的后果实测过:KINGDOM HEARTS(四合一合集,16 个名字撞车)
    // 一份 197/197 全覆盖的攻略被 15 条这种错误拦掉,而它自己的消息就写着"不是攻略能修的"。
    // 三轮全花在让模型去抄不存在的描述上,然后把整份丢了。
    //
    // 这里**不加 `unnameable.has(f.apiName)` 那道闸**,和上一行不同:那一行需要它,
    // 因为 `checked-mismatch` 对任何成就都会报,撞名只是其中一种;而这一条的触发前提
    // 本身就包含"名字撞车",条件比 unnameable 更窄。加上去是个恒真判断,读起来像有疑问
    else if (f.code === 'ambiguous-empty-description') expected.push(f);
    else blocking.push(f);
  }
  return { blocking, expected };
}

