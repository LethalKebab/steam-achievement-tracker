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
import { loadTodos, applyChecks } from './markdown.js';
import { syncGuidesFromMarkdown, syncGuidesFromNotion } from './guides.js';
import { markdownToBlocks } from './notionblocks.js';
import { planNotionTarget, newGuideStatus } from './notion.js';
import { createSession, checkResult } from './ai.js';

/** 草稿目录。放在 guidesDir 底下方便找,但发现逻辑扫不到(非递归) */
export const DRAFTS_DIR = '.drafts';

/**
 * 哪些校验问题**能怪模型**。
 *
 * `checked-mismatch` 不在里面,而且必须不在:模型压根不许写 checkbox 状态,
 * 把这条回灌给它等于要求它做我们明令禁止的事,它只会开始瞎写 `- [x]`。
 */
const MODEL_FIXABLE = new Set([
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
  '规则一': '进了 —— 一个成就一行 checkbox、嵌套子步骤、重名抄描述。「写后验证」由程序做',
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
  '8.4': '**没进** —— 委托子 agent 是会话层的做法;100+ 成就的分片编排不在 v1,由 maxAchievements 直接拒绝',
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
- 子步骤、子收集品用**缩进的嵌套 checkbox**,不要写成纯文字列表——用户要能单独勾掉每一条
- **但只嵌套"每一条都要做"的东西。** 如果那几条是**互相替代**的选项(比如"达成任一结局"
  下面列了九个结局、"用任意职业通关"下面列了五个职业),**不要嵌套**,平铺写在心得那一段里。
  嵌套的语义是"父成就解锁 ⇒ 下面每一条都做过了",互斥选项放进去会变成八条假记录
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
  if (pct < 15) return `  🟠 全球 ${p}% 解锁,偏难`;
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
  onProgress = () => {},
}) {
  // 0 轮或 NaN 会让下面的循环一次都不跑,于是"没有 blocking"被读成"过关了",
  // 接着去复制一个根本不存在的草稿。当场拦下来比在 ENOENT 上猜半天强
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`rounds 要是 ≥1 的整数,拿到的是 ${rounds}`);
  }

  const plan = await planGuide(db, { config, steam, appid, fileName, notion, local });
  const { defs, game, unlocked, finalPath, draftPath } = plan;

  // 没有联网能力的供应商换一套调研要求。设计文档把"有服务端搜索"定成硬性准入,
  // 拦在 CLI 那一层;真要跑(--no-research)也不能装作有资料可查
  const canSearch = provider.canSearch !== false;
  const system = buildSystemPrompt(game, appid, defs, { canSearch, rarity: plan.rarity });
  // 联网工具由供应商自己声明:各家的形状完全不一样,编排这一层不该知道
  const session = createSession(provider, { system, tools: provider.webTools() });

  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });

  let lint = null;
  let blocking = [];
  let expected = [];
  let round = 0;
  // 模型这一轮实际发出去的搜索词。**能搜 ≠ 搜了** —— 声明了工具却一次没搜,
  // 生成的就是它凭记忆写的东西,而这正是 canSearch 那套设计要防的静默质量差别
  const searchQueries = [];
  let message = '开始写吧。先联网查资料,再按规则写完整份攻略。';

  for (round = 1; round <= rounds; round++) {
    onProgress({ phase: 'ask', round, rounds });
    const reply = await session.ask(message, {
      onEvent: (ev) => {
        // 通用进度事件,不认识任何一家的原始格式
        if (ev.type === 'tool') onProgress({ phase: 'tool', round, name: ev.name });
        else if (ev.type === 'search') onProgress({ phase: 'tool', round, name: `搜索「${ev.query}」` });
      },
    });

    // refusal / max_tokens 截断 / 工具报错都是 HTTP 200。这里必须先问一句再用正文,
    // 尤其 max_tokens ——半份攻略看起来完全正常,校验器只会报"后半段的成就都缺 checkbox"
    for (const q of reply.searchQueries ?? []) if (!searchQueries.includes(q)) searchQueries.push(q);


    const verdict = checkResult(reply);
    if (!verdict.ok) throw new Error(`第 ${round} 轮没拿到可用结果:${verdict.reason}`);

    onProgress({ phase: 'check', round });
    const body = stripLeadingHeader(extractMarkdown(reply.text));
    writeFileSync(draftPath, buildHeader(game, appid) + '\n' + body + '\n');

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
    message = buildFeedback(lint.findings);
  }

  const ok = blocking.length === 0;
  let registered = null;
  let landedUrl = null;
  let unconverted = [];

  if (ok && plan.target === 'notion') {
    const landed = await landToNotion(db, {
      notion, steam, config, plan, appid, game, defs, unlocked, onProgress,
    });
    ({ registered, unconverted } = landed);
    landedUrl = landed.url;
    lint = landed.lint;
    rmSync(draftPath, { force: true });
  } else if (ok) {
    // 落盘。新建文件、机器闸门过了 ⇒ 自动写(可逆);覆盖已有文件要人工确认,
    // 那是「动手顺序」第 8 步,还没做——planGuide 已经在前面把这条路堵死了
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
    expected,
    usage: session.usage,
    model: provider.model,
    registered,
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
  { notion, steam, config, plan, appid, game, defs, unlocked, onProgress = () => {} }
) {
  const markdown = readFileSync(plan.draftPath, 'utf8');
  const { blocks, unconverted } = markdownToBlocks(markdown);

  let page = plan.notion.existingPage;
  if (page) {
    // 用户自己建的空页:**只填正文,不动标题、图标和状态**。那几样是他手设的,
    // 我们要写的是正文;顺手"顺便改一下"就是在不可逆地覆盖别人的选择。
    // 状态真不对的话,`guide-status` 会按完成度自己收敛
    onProgress({ phase: 'notion-fill', url: page.url, blocks: blocks.length });
  } else {
    // 图标是锦上添花:拿不到就不要,别为了个图标把生成好的攻略卡住
    const icon = await fetchGameIcon(steam, appid).catch(() => null);
    page = await notion.createGuidePage({
      titleProperty: plan.notion.titleProperty,
      title: game,
      icon,
      status: plan.notion.status,
    });
    onProgress({ phase: 'notion-create', url: page.url, blocks: blocks.length });
  }

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
  const registered = discovered.added.find((a) => a.appid === String(appid)) ?? null;
  if (!registered) {
    throw new Error(
      `页面写好了(${page.url}),但攻略发现逻辑没能从上面读出 appid:${appid}。` +
        '页面在,内容在,只是 Dashboard 上暂时不会出现链接 —— 检查正文第一行的 `appid:`。'
    );
  }

  return { url: page.url, lint: after, registered, unconverted };
}

/**
 * Steam 的游戏图标 URL。图标 hash 只有 `GetOwnedGames` 给,所以要多打一次接口 ——
 * 生成一篇攻略本来就是分钟级、花钱的操作,多这一次可以忽略。
 * 拿不到返回 null:没有图标的页面照样是好页面。
 */
export async function fetchGameIcon(steam, appid) {
  const games = await steam.fetchOwnedGames(true);
  const hit = games.find((g) => String(g.appid) === String(appid));
  if (!hit?.img_icon_url) return null;
  return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${hit.img_icon_url}.jpg`;
}

/**
 * 前置检查 + 数据准备。**所有拒绝理由都在这里一次性给完**,不要跑到一半、花了钱
 * 才发现文件已经存在。
 */
export async function planGuide(db, { config, steam, appid, fileName = null, notion = null, local = false }) {
  const id = String(appid);
  const defs = achievementsFor(db, id);
  if (!defs.length) {
    throw new Error(`appid ${id} 还没有成就详情,没有可写的清单。先跑 \`node tracker.js sync --schema\``);
  }

  const max = config.ai?.maxAchievements ?? 100;
  if (defs.length > max) {
    throw new Error(
      `这个游戏有 ${defs.length} 个成就,超过 v1 的上限 ${max}。` +
        '100+ 成就的分片编排是独立的一块工程(SKILL.md 8.4),还没做。' +
        '真要试就把 config.json 的 ai.maxAchievements 调大,但一次上下文装不下的话质量会掉。'
    );
  }

  const gameRow = getGame(db, id);
  const game = gameRow?.name || defs[0].game_name || id;

  // 一个 appid 只能有一个攻略后端。已经登记过就不能再生成一份 —— 无论哪个后端,
  // 都是覆盖已有攻略,得走第 8 步那套备份 + 人工确认
  const existing = getGuide(db, id);
  if (existing) {
    const where = existing.kind === 'notion' ? 'Notion 页面' : '本地文件';
    throw new Error(
      `《${game}》已经有攻略了(${where}:${existing.url})。覆盖已有攻略要走` +
        '备份 + diff 预览 + 人工确认(「动手顺序」第 8 步),还没做。'
    );
  }

  const name = fileName ?? guideFileName(game, id);
  const finalPath = join(config.guidesDir, name);
  const draftPath = join(config.guidesDir, DRAFTS_DIR, name);

  // 攻略写去哪:Notion 连着就写 Notion。这是 SKILL.md 8.0 定下的 ——
  // 攻略是用户自己的笔记,它们已经有 105 篇在 Notion 里了,新的一篇落在本地
  // 就是把一份笔记劈成两处。`--local` 是明确说"这次写本地"的出口
  const target = !local && notion?.configured && config.notion?.overviewDbId ? 'notion' : 'local';
  const notionPlan =
    target === 'notion'
      ? await planNotionTarget(notion, game, { statusValue: newGuideStatus(gameRow) })
      : null;

  // 覆盖已有攻略 = 不可逆,按落盘闸门的规矩必须备份 + diff 预览 + 人工确认,
  // 那一整套是第 8 步。在它做出来之前,这条路直接堵死比"先写了再说"安全。
  // 草稿始终写本地,所以这条对两种目标都要查
  if (target === 'local' && existsSync(finalPath)) {
    throw new Error(
      `${finalPath} 已经存在。覆盖已有攻略要走备份 + diff 预览 + 人工确认(「动手顺序」第 8 步),` +
        '还没做。想重新生成就先把旧文件挪走,或者用 --file 换个名字。'
    );
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
  };
}

/**
 * 把校验结果分成"必须解决"和"已知够不着"。
 *
 * 名字在这个游戏里撞车的成就,`computeCheckedKeys` 一律跳过(宁可漏勾不能勾错),
 * 于是解锁了框也不会被勾上、`checked-mismatch` 照报。这批不算攻略的问题——
 * 不摘出来的话,那 3 款中英文都同名的游戏会永远卡在"三轮都没过",而且报的还是
 * 一条谁都改不动的错。**只有 `checked-mismatch` 能这样豁免**,别的规则照常拦。
 */
export function splitFindings(findings, unnameable) {
  const blocking = [];
  const expected = [];
  for (const f of findings) {
    if (f.level !== 'error') continue;
    if (f.code === 'checked-mismatch' && unnameable.has(f.apiName)) expected.push(f);
    else blocking.push(f);
  }
  return { blocking, expected };
}

