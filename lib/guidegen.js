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
import { syncGuidesFromMarkdown } from './guides.js';
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
 * 规则部分。**放在 system 的最前面而且逐字不变**——回灌重写最多跑 3 轮,每轮都重发
 * 这一大段,命中前缀缓存按 0.1 倍计费。所以这里绝对不能插时间戳、随机数之类的东西:
 * 缓存是前缀匹配,前面变一个字节后面全作废。
 */
const RULES = `你在为一个 Steam 成就追踪工具写一份**本地 markdown 攻略**。下面的规则来自这个项目积累的写法规范,写完机器会逐条校验,不满足会被打回重写。

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
- 纯剧情推进自动解锁的成就:只写名字和官方描述就够了
- 有坑、有技巧、容易错过的成就:详细写前置条件、关键选择节点、容易翻车的地方。**这是攻略最有价值的部分**,别省
- 过了某个节点会永久错过的标"易错过!!";和别的成就互斥的写清楚跟谁互斥;需要特定背景/perk/难度的把前置条件标出来
- 很长的清单(全结局对照、全收集品)用 \`<details><summary>\` 折叠起来
- 游戏有官方中文就用中文成就名,没有就保留英文原名;Boss、Build、DLC、NPC 这类术语不强行翻译
- 不要贴图片

## 怎么查资料

先上网搜这个游戏的成就攻略,再把最有用的那一两页正文抓回来读完。中文攻略站(游民星空、3DM、NGA、B站)、Steam 社区攻略、TrueAchievements、Fandom wiki 都可以。**理解机制之后用自己的话重写**,不要照搬原文。

查不到具体资料的成就,就按名字和官方描述给出你能给的最合理的说明——**不要编造**具体数值、地点、道具名。写不确定的东西不如少写。`;

/** 成就清单。⚠️ 同名 标记直接告诉模型哪几条必须抄描述,比让它自己数可靠 */
export function buildAchievementList(game, appid, defs) {
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
      `${i + 1}. ${title}${dup ? '  ⚠️ 同名' : ''}\n` +
      `   官方描述:${desc || '(Steam 上是空的)'}`
    );
  });

  return `## 《${game}》(appid ${appid})的全部成就,共 ${defs.length} 个\n\n${lines.join('\n')}`;
}

export function buildSystemPrompt(game, appid, defs) {
  return `${RULES}\n\n---\n\n${buildAchievementList(game, appid, defs)}`;
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
  const fences = [...String(text ?? '').matchAll(/```(?:markdown|md)?\n([\s\S]*?)```/g)];
  if (!fences.length) return String(text ?? '').trim();
  return fences.map((m) => m[1]).sort((a, b) => b.length - a.length)[0].trim();
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
  onProgress = () => {},
}) {
  // 0 轮或 NaN 会让下面的循环一次都不跑,于是"没有 blocking"被读成"过关了",
  // 接着去复制一个根本不存在的草稿。当场拦下来比在 ENOENT 上猜半天强
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`rounds 要是 ≥1 的整数,拿到的是 ${rounds}`);
  }

  const plan = await planGuide(db, { config, steam, appid, fileName });
  const { defs, game, unlocked, finalPath, draftPath } = plan;

  const system = buildSystemPrompt(game, appid, defs);
  // 联网工具由供应商自己声明:两家的形状完全不一样,编排这一层不该知道
  const session = createSession(provider, { system, tools: provider.webTools() });

  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });

  let lint = null;
  let blocking = [];
  let expected = [];
  let round = 0;
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

  if (ok) {
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
  }

  return {
    ok,
    game,
    appid: String(appid),
    path: ok ? finalPath : null,
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
 * 前置检查 + 数据准备。**所有拒绝理由都在这里一次性给完**,不要跑到一半、花了钱
 * 才发现文件已经存在。
 */
export async function planGuide(db, { config, steam, appid, fileName = null }) {
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

  const game = getGame(db, id)?.name || defs[0].game_name || id;

  // 一个 appid 只能有一个攻略后端。已经有 Notion 页面还往本地写,等于制造一次
  // 将来要手工收拾的冲突(syncGuidesFromMarkdown 也会拒绝登记它)
  const existing = getGuide(db, id);
  if (existing && existing.kind === 'notion') {
    throw new Error(
      `《${game}》已经有 Notion 攻略页了(${existing.url})。一个 appid 只能有一个后端;` +
        '写 Notion 是第二阶段,还没做。'
    );
  }

  const name = fileName ?? guideFileName(game, id);
  const finalPath = join(config.guidesDir, name);
  const draftPath = join(config.guidesDir, DRAFTS_DIR, name);

  // 覆盖已有攻略 = 不可逆,按落盘闸门的规矩必须备份 + diff 预览 + 人工确认,
  // 那一整套是第 8 步。在它做出来之前,这条路直接堵死比"先写了再说"安全
  if (existsSync(finalPath)) {
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

  return {
    defs, game, unlocked, finalPath, draftPath,
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
