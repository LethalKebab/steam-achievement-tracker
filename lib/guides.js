/**
 * 攻略层:成就名 ↔ checkbox 的匹配规则,以及两种后端(Notion / 本地 markdown)的调度
 * ------------------------------------------------
 * 匹配分两遍:名字有歧义的成就先靠"攻略里抄了的成就描述原文"定位(见 matchAchievements),
 * 剩下的按名字精确匹配。所以**攻略里抄上官方描述原文是有用的**,不只是给人看的。
 *
 * **必须精确匹配"标题候选片段",不做 substring / prefix 匹配。**
 * 原因(踩过的坑):一个短成就名可能正好是另一个不相关的、更难的成就名的严格前缀。
 * 如果短成就名对应的 checkbox 已经被勾上(不在待匹配池里了),前缀匹配就会去勾那个
 * "表亲成就"——而它其实还没解锁。所以只接受"成就名严格等于某个候选片段"。
 *
 * 候选片段的切法要覆盖攻略里几种常见写法,但这只是**多切出几个候选片段**,
 * 每个候选仍然要求严格相等——不能为了兼容某种写法去放宽匹配:
 *   - 换行 / 冒号 / 破折号(半角 ' - ' 和全角 ' — ' ' – ' 都认)前面那段
 *   - "中文名(English Name)" 这种片段,中文名和英文名各自也算一个候选
 *
 * 但多切候选片段会让"同名成就"这个更深的问题露出来:名字一样的两个成就,靠名字
 * 根本分不出该勾哪个 checkbox。所以还有一道闸门 findAmbiguousNames——
 * 同名成就没全部解锁时,整个名字放弃匹配。见那个函数的注释。
 */
import { achievementsFor, allGames, allGuides, getGame, upsertGuide, getGuide, appendSyncLog, nowIso } from './db.js';
import { sleep } from './steam.js';
import { extractNotionPageId, normalizeNotionId } from './notion.js';
import * as md from './markdown.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 转小写、去掉 markdown 加粗星号、把字面量 <br> 变成真换行、压掉多余空白。
 * **保留标点**(冒号、破折号、换行),因为 extractTitleCandidates 要靠它们找分段边界。
 */
export function normalizeText(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const PAREN_PAIR = /^(.+?)\s*[（(]([^)）]+)[)）]\s*$/;

/**
 * 候选**结尾**的句读。只吃结尾,句子中间的标点一律不动。
 * 不含引号/括号/书名号——那些是成对的,单独去掉一边会把 `《物种起源》` 弄成 `《物种起源`。
 */
const TRAILING_PUNCT = /[。．.！!？?，,、;；:：…⋯～~\s]+$/;

export function extractTitleCandidates(text) {
  const candidates = [];
  const add = (s) => {
    const t = (s ?? '').trim();
    if (t) candidates.push(t);
  };

  // 1. 按换行拆(对应"标题<br>描述",以及"英文名/本地化名/描述"各占一行的布局)
  for (const line of text.split('\n')) add(line);

  // 2. 单行里用冒号或破折号分隔标题和描述的写法,取分隔符前面那段
  const colonIdx = text.search(/[:：]/);
  if (colonIdx > 0) add(text.slice(0, colonIdx));
  for (const dash of [' - ', ' — ', ' – ', '——']) {
    const idx = text.indexOf(dash);
    if (idx > 0) add(text.slice(0, idx));
  }
  // 破折号**前面没有空格**的写法(`成就名- 描述`)。上面那组分隔符全都要求破折号前面
  // 有空格,所以 `胜利！- 使用北条时宗...` 这种整行只能产出一个候选(全行),成就名
  // 永远提取不出来 —— 于是这些框既勾不上,也没人发现:audit 会先拿描述原文反查、
  // 把它们蒙混过去,checkbox-sync 那边则表现为"没有要勾的",和"已经勾完了"长得一模一样。
  // 2026-08-10 用 guidelint 跑全量攻略时才暴露出来,实测影响 25 个框(主要是文明 6)。
  // 仍然是**精确相等**匹配,只是多给一个候选片段,不放宽判定。
  const dashIdx = text.search(/[-—–]\s/);
  if (dashIdx > 0) add(text.slice(0, dashIdx));

  // 3. 整段原文本身也是一个候选(整行就是纯成就名、没有描述的情况)
  add(text);

  // 4. "中文名(English Name)" → 中文名、英文名各自也算候选
  for (const c of [...candidates]) {
    const m = c.match(PAREN_PAIR);
    if (m) {
      add(m[1]);
      add(m[2]);
    }
  }

  // 5. 去掉结尾句读之后再来一份。攻略里常见给成就名补个句号(写「秘密食材。」,
  //    Steam 上是「秘密食材」),精确相等因此不成立。2026-08-10 抽查 guidelint
  //    残留报错时发现的,和上面破折号那条是同类问题。
  //
  //    **追加,不替换**——「白手起家。」「胜利！」这种名字本身就带标点的成就,
  //    原样候选必须留着,否则等于把本来能匹配的改成匹配不上。放在最后也保证
  //    resolveTodoToAchievement 先试精确的那个。
  //
  //    只动候选这一侧,不动 defs 的名字索引:给索引加去标点的键会让
  //    `X` 和 `X。` 两个成就撞成同名,双双变"歧义"而被跳过——那是拿"勾不上"
  //    换"勾错"的风险,和全局的谨慎原则相反。代价是反方向(攻略写对、Steam
  //    名字带标点)仍匹配不上,属于已知未覆盖。
  for (const c of [...candidates]) {
    const stripped = c.replace(TRAILING_PUNCT, '');
    if (stripped !== c) add(stripped);
  }

  return candidates;
}

/**
 * 已解锁成就(带中英文名字,名字来自 achievements 表)。原 getUnlockedAchievements。
 * 返回 [] 表示这游戏当前查不到解锁数据,调用方自己决定怎么记日志。
 */
export async function getUnlockedAchievements(db, steam, appid) {
  const raw = await steam.fetchPlayerAchievements(appid);
  if (raw.retry) throw new Error(`appid ${appid} 暂时查不到解锁数据(限流/隐私设置),稍后再试`);
  if (raw.noAchievementSystem) throw new Error(`appid ${appid} 查不到成就数据(可能没有成就系统)`);

  const meta = Object.fromEntries(
    achievementsFor(db, appid).map((a) => [
      a.api_name,
      { nameCn: a.name_cn, nameEn: a.name_en, description: a.description },
    ])
  );

  return raw.achievements
    .filter((a) => a.achieved === 1)
    .map((a) => ({
      apiname: a.apiname,
      unlocktime: a.unlocktime,
      nameCn: meta[a.apiname]?.nameCn ?? '',
      nameEn: meta[a.apiname]?.nameEn ?? '',
      description: meta[a.apiname]?.description ?? '',
    }));
}

/**
 * 找出"靠名字无法安全区分"的成就名。
 *
 * 有些游戏存在**多个成就用完全一样的名字**(中英文都一样),比如《鬼谷八荒》有两个
 * `妙手空空 / Skilled Thief`:一个是"隐秘偷窃10次",另一个是"通关且偷窃100次"。
 * 攻略作者靠加后缀区分,但成就名本身一模一样,**按名字匹配在原理上就分不出来**。
 *
 * 危险的是这种组合:同名的 N 个成就里只解锁了一部分。已解锁那个的 checkbox 一旦被勾上,
 * 它就退出待匹配池,于是同一个名字会去匹配**另一个还没解锁的**成就的 checkbox——勾错。
 * (这正是踩过两轮的那类 bug,只不过这次是"完全同名"而不是"前缀",精确匹配挡不住。)
 *
 * 规则:同名的成就如果**全部**解锁了,随便怎么配都对,照常匹配;
 * 只解锁了一部分就整个名字放弃,宁可漏勾也不能勾错。
 */
export function findAmbiguousNames(db, appid, unlockedApiNames) {
  const byName = new Map();
  for (const a of achievementsFor(db, appid)) {
    for (const raw of [a.name_cn, a.name_en]) {
      const key = normalizeText(raw);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(a.api_name);
    }
  }
  const unsafe = new Set();
  for (const [name, apiNames] of byName) {
    const uniq = [...new Set(apiNames)];
    if (uniq.length > 1 && !uniq.every((n) => unlockedApiNames.has(n))) unsafe.add(name);
  }
  return unsafe;
}

/**
 * 同名这一组"该勾的框是不是已经勾够了"。
 *
 * 用来决定**要不要提醒用户**,不参与任何写入判断——所以这里可以用宽松的包含匹配,
 * 而勾选路径绝对不行(见文件头)。区别在于:这里判错只是多一条或少一条日志,
 * 那里判错是往用户的笔记里写错东西。
 *
 * 逻辑:这个名字在攻略里出现的框有几个已经勾上了(T),同名成就里解锁了几个(U)。
 * T >= U 就说明该勾的都勾了,没事要做,不用提醒。
 * (等你解锁了同名里的第二个,U 变 2 而 T 还是 1,就会重新开始提醒——正好是需要提醒的时候。)
 */
function nameGroupAlreadySatisfied(ach, unlocked, todos) {
  const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  for (const rawName of [ach.nameCn, ach.nameEn]) {
    const name = flat(rawName);
    if (!name) continue;
    const withName = todos.filter((t) => flat(t.text).includes(name));
    if (withName.length === 0) continue;
    const ticked = withName.filter((t) => t.checked).length;
    const unlockedInGroup = unlocked.filter(
      (a) => flat(a.nameCn) === name || flat(a.nameEn) === name
    ).length;
    if (ticked >= unlockedInGroup) return true;
  }
  return false;
}

/**
 * 把已解锁成就和 checkbox 列表配对。一个 checkbox 只会被一个成就认领(claimed),
 * 一个成就配到一个就停。
 * unsafeNames 里的名字直接跳过,见 findAmbiguousNames。
 */
export function matchAchievements(unlocked, todos, { unsafeNames = new Set(), defs = [] } = {}) {
  const pending = todos.filter((t) => !t.checked);
  const claimed = new Set();
  const matches = [];
  const matchedApiNames = new Set();

  const nameIsUnsafe = (n) => Boolean(n) && unsafeNames.has(n);
  const hasUnsafeName = (ach) =>
    nameIsUnsafe(normalizeText(ach.nameCn)) || nameIsUnsafe(normalizeText(ach.nameEn));

  /**
   * 这个成就还剩哪些名字可以拿去做等值匹配。
   *
   * 闸门是**按名字**关的,不是按成就关的——这个区别是有实测依据的:Steam 的本地化
   * 经常只有一种语言撞车。Plague Inc 两个成就中文都叫「生化武器大师」,英文却分别是
   * Nano-Virus Master 和 Bioweapon Master;犹格索托斯的庭院正好反过来,四个成就的
   * 英文名都是占位符 "Text",中文名各不相同。全库 12 款撞名游戏里,9 款只撞一种语言。
   * 把整个成就一并判死,等于把一个本来就唯一的名字白白扔掉。
   *
   * 撞车的那个名字仍然一个都不许用:分不出双胞胎的是**名字**,不是成就。
   * 等值匹配那条规则本身一个字没动——仍然要求完全相等,不许子串、不许前缀。
   */
  const safeNamesOf = (ach) =>
    [normalizeText(ach.nameCn), normalizeText(ach.nameEn)].filter((n) => n && !nameIsUnsafe(n));

  // ── 第一遍:名字撞车的成就,先试**描述原文** ──────────────────────────────
  // 同名成就靠那个名字永远分不出来,但如果 checkbox 里抄了某个成就的完整描述、而且这条
  // 描述在本游戏里唯一,那这个框说的就是那个成就,没有二义性,可以放心勾。
  // 放在第一遍是因为描述比名字精确:先让它认领自己的框,避免被第二遍的名字匹配抢走。
  const ambiguous = unlocked.filter((a) => hasUnsafeName(a) && (a.nameCn || a.nameEn));
  const unresolved = [];
  for (const ach of ambiguous) {
    const todo = pending.find((t) => {
      if (claimed.has(t.key)) return false;
      const hit = resolveTodoToAchievement(t.text, defs);
      // 必须是"按描述"对上的:按名字那条路对同名成就本来就会返回 null,写明更不容易误改
      return hit?.via === 'description' && hit.def.api_name === ach.apiname;
    });
    if (todo) {
      claimed.add(todo.key);
      matchedApiNames.add(ach.apiname);
      matches.push({ key: todo.key, achievement: ach, text: todo.text, via: 'description' });
    } else {
      // **先别判成"跳过"**:它可能还有一个没撞车的名字,第二遍能把它救回来。
      // 提前定案的话,救回来的成就照样会在日志里报一条"需人工核对"——假警报。
      unresolved.push(ach);
    }
  }

  // ── 第二遍:按名字精确匹配,但只用**没撞车**的那些名字 ────────────────────
  for (const ach of unlocked) {
    if (matchedApiNames.has(ach.apiname)) continue; // 第一遍已经认领过了
    const names = safeNamesOf(ach);
    if (!names.length) continue; // 两种语言都撞(或者根本没名字)→ 只能靠描述

    for (const todo of pending) {
      if (claimed.has(todo.key)) continue;
      const norm = normalizeText(todo.text);
      if (!norm) continue;

      const candidates = extractTitleCandidates(norm);
      if (names.some((n) => candidates.includes(n))) {
        claimed.add(todo.key);
        matchedApiNames.add(ach.apiname);
        matches.push({ key: todo.key, achievement: ach, text: todo.text, via: 'name' });
        break;
      }
    }
  }

  // 两遍都没配上的撞名成就才算真的跳过。nameGroupAlreadySatisfied 只看 todos 和
  // unlocked,不受 claimed 影响,所以挪到这里判结果不变。
  matches.skippedAmbiguous = unresolved.filter(
    (a) => !matchedApiNames.has(a.apiname) && !nameGroupAlreadySatisfied(a, unlocked, todos)
  );
  return matches;
}

/**
 * 子步骤联动:成就本身确定已解锁时,把嵌在它下面的子步骤 checkbox 一起勾上。
 *
 * 这是**唯一**能自动勾子步骤的办法——子步骤(单个神龛、单个技巧、单条支线)不是成就,
 * Steam 里没有它们的数据,名字也对不上任何成就,所以按名字匹配永远勾不到它们。
 *
 * ⚠️ 已知的不准确之处,想改这段之前先读:这里假设"父成就解锁 ⇒ 它列的子步骤都做过",
 * 对"集齐/全部完成"型成就成立(比如「每种技术都至少失败过一次」),对**"任意一个就行"**型
 * 成就不成立——比如「达成任意结局」下面列了 9 个结局,解锁它并不代表 9 个都走过,
 * 那样会把 8 个没做的框也勾上。代码分不出这两类,所以:
 *   - 用户明确要求默认开启(`--no-cascade` 可以关掉)
 *   - 每条联动勾选都单独记日志("子步骤"字样),方便事后翻 sync_log 复查
 *   - 上线前应当先跑一次全量 --dry-run 人工过一遍
 * 这是本项目里少见的"宁可多勾"的地方,和"宁可漏勾也不错勾"的总原则相反,是有意为之。
 *
 * 认定"父成就已解锁"有两条来源,缺一不可:
 *   1. 这次要勾的那些(matches)——刚刚按名字/描述匹配上的
 *   2. **早就勾上的**框,反查得到唯一成就且那个成就确实解锁了。少了这条,
 *      历史上已经勾好的成就(绝大多数)下面的子步骤永远联动不到,功能等于没用
 */
export function collectSubStepTicks(todos, matches, { defs = [], unlockedApiNames = new Set() } = {}) {
  const byParent = new Map();
  for (const t of todos) {
    if (t.parent === null || t.parent === undefined) continue;
    if (!byParent.has(t.parent)) byParent.set(t.parent, []);
    byParent.get(t.parent).push(t);
  }
  if (byParent.size === 0) return [];

  const roots = new Set(matches.map((m) => m.key));
  for (const t of todos) {
    if (!t.checked || roots.has(t.key)) continue;
    const hit = resolveTodoToAchievement(t.text, defs);
    if (hit && unlockedApiNames.has(hit.def.api_name)) roots.add(t.key);
  }

  const out = [];
  const seen = new Set();
  const walk = (key) => {
    for (const child of byParent.get(key) ?? []) {
      if (seen.has(child.key)) continue;
      seen.add(child.key);
      if (!child.checked) out.push(child);
      walk(child.key); // 子步骤自己还有子步骤的,一起往下
    }
  };
  for (const key of roots) walk(key);
  return out;
}

// ---------------------------------------------------------------------------
// 审计:反向找"勾错了"的 checkbox
// ---------------------------------------------------------------------------

/**
 * 把一个 checkbox 反查到**具体哪个成就**。返回 {def, via} 或 null。
 *
 * 和 matchAchievements 的方向相反:那个是"成就 → 找框",这个是"框 → 找成就",
 * 审计要用后者(判断"这个已勾的框对应的成就到底解锁了没")。
 *
 * 两层,每层都要求**唯一**——审计要么给确定答案,要么不给答案,绝不猜:
 *   1. checkbox 文字里含成就描述**全文**,且这条描述在本游戏里唯一
 *   2. 候选片段精确等于某个成就名,且这个名字在本游戏里只对应一个成就
 *
 * ⚠️ 千万别退化成"描述前缀"匹配。系列成就(造成 100/500/1000 点伤害、
 * 集齐 X 的报告卡)描述开头完全一样,按前缀匹配会把**正确勾上的低档位**
 * 算到**还没解锁的高档位**头上,凭空造出一堆假的"勾错"。
 * 这是本项目一直在防的那类 bug,test/matching.test.js 里钉着这个用例。
 */
export function resolveTodoToAchievement(text, defs) {
  const flat = (s) => String(s ?? '').replace(/\s+/g, '');
  const flatText = flat(text);

  // 1. 描述全文,且描述唯一
  const descCount = new Map();
  for (const d of defs) {
    if (!d.description) continue;
    const k = flat(d.description);
    descCount.set(k, (descCount.get(k) ?? 0) + 1);
  }
  const byDesc = defs.find(
    (d) => d.description && descCount.get(flat(d.description)) === 1 && flatText.includes(flat(d.description))
  );
  if (byDesc) return { def: byDesc, via: 'description' };

  // 2. 名字精确匹配,且这个名字只对应一个成就
  const byName = new Map();
  for (const d of defs) {
    for (const raw of [d.name_cn, d.name_en]) {
      const k = normalizeText(raw);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Map());
      byName.get(k).set(d.api_name, d);
    }
  }
  for (const cand of extractTitleCandidates(normalizeText(text))) {
    const hit = byName.get(cand);
    if (hit?.size === 1) return { def: [...hit.values()][0], via: 'name' };
  }

  return null;
}

/**
 * 只读审计:找出"勾上了、但那个成就在 Steam 上并没解锁"的 checkbox。
 *
 * 和 checkboxSync 方向相反(那个找漏勾,这个找勾错),而且**不写任何东西**。
 * 只审还没 100% 的游戏——全成就的游戏所有成就都解锁了,勾了也不可能勾错。
 *
 * 对不上具体成就的框只计数、不下结论:宁可漏报也不能误报。数字会在结果里如实报出来,
 * 不能让"审计通过"看起来比实际覆盖范围更强。
 */
export async function auditGuideTicks(
  db,
  steam,
  { notion, config, appid = null, onProgress = () => {} }
) {
  const guideByAppid = Object.fromEntries(allGuides(db).map((g) => [g.appid, g]));
  const targets = allGames(db).filter((g) => {
    if (!guideByAppid[g.appid]) return false;
    if (appid && g.appid !== String(appid)) return false;
    return typeof g.total === 'number' && g.total > 0 && g.achieved < g.total;
  });

  const results = [];
  const totals = { games: 0, ticked: 0, wrong: 0, unresolved: 0, skipped: 0 };

  for (const [i, g] of targets.entries()) {
    onProgress({ done: i + 1, total: targets.length, name: g.name });
    const entry = { appid: g.appid, name: g.name, wrong: [], ticked: 0, unresolved: 0, skipped: null };

    const defs = achievementsFor(db, g.appid);
    if (defs.length === 0) {
      entry.skipped = '还没同步成就详情(先跑 sync --schema)';
      results.push(entry);
      totals.skipped++;
      continue;
    }

    let todos;
    try {
      todos = await backendFor(guideByAppid[g.appid], { notion, config }).loadTodos();
    } catch (err) {
      entry.skipped = '读不到攻略: ' + err.message;
      results.push(entry);
      totals.skipped++;
      continue;
    }

    const raw = await steam.fetchPlayerAchievements(g.appid);
    if (raw.retry || raw.noAchievementSystem) {
      entry.skipped = 'Steam 查不到解锁状态,稍后再试';
      results.push(entry);
      totals.skipped++;
      continue;
    }
    const unlocked = new Map(raw.achievements.map((a) => [a.apiname, a.achieved === 1]));

    for (const t of todos.filter((x) => x.checked)) {
      const hit = resolveTodoToAchievement(t.text, defs);
      // 子步骤的框(单个神龛、单条支线)本来就不是"某个成就的框",反查不到是正常的。
      // 不能把它们计进"对不上成就"那个数——嵌套攻略一多就会被子步骤淹没,而那个数字
      // 存在的意义是"审计覆盖不到多少**真·成就框**"。能反查到成就的嵌套框照常审计。
      if (!hit && t.parent !== null && t.parent !== undefined) continue;
      entry.ticked++;
      if (!hit) {
        entry.unresolved++;
        continue;
      }
      if (unlocked.get(hit.def.api_name) === false) {
        entry.wrong.push({
          apiName: hit.def.api_name,
          name: hit.def.name_cn || hit.def.name_en,
          text: t.text,
          via: hit.via,
        });
      }
    }

    totals.games++;
    totals.ticked += entry.ticked;
    totals.wrong += entry.wrong.length;
    totals.unresolved += entry.unresolved;
    results.push(entry);
    await sleep(200);
  }

  return { results, totals, candidates: targets.length };
}

// ---------------------------------------------------------------------------
// 两种后端
// ---------------------------------------------------------------------------

function backendFor(guide, { notion, config }) {
  if (guide.kind === 'local') {
    const path = md.resolveGuidePath(config.guidesDir, guide.url);
    return {
      label: '本地 markdown',
      loadTodos: async () => md.loadTodos(path),
      applyChecks: async (keys) => md.applyChecks(path, keys),
    };
  }
  const pageId = extractNotionPageId(guide.url);
  return {
    label: 'Notion',
    loadTodos: () => notion.fetchAllToDoBlocks(pageId),
    applyChecks: async (keys) => {
      let n = 0;
      for (const key of keys) {
        await notion.checkTodo(key);
        n++;
        await sleep(120);
      }
      return n;
    },
  };
}

/**
 * 单款游戏的 checkbox 同步。返回日志行 [{ts, appid, gameName, achievement, result}]。
 * 出错不抛异常,统一记成日志行——一款游戏失败不该让整个每日同步中断。
 */
export async function syncGameCheckboxes(db, steam, guide, gameName, { notion, config, dryRun = false, cascade = true }) {
  const logs = [];
  const push = (achievement, result) =>
    logs.push({ ts: nowIso(), appid: guide.appid, gameName, achievement, result });

  let unlocked;
  try {
    unlocked = await getUnlockedAchievements(db, steam, guide.appid);
  } catch (err) {
    push('', '跳过 - 无法获取Steam解锁数据: ' + err.message);
    return logs;
  }
  if (unlocked.length === 0) return logs;

  let backend;
  try {
    backend = backendFor(guide, { notion, config });
  } catch (err) {
    push('', '跳过 - 攻略链接/路径无法解析: ' + err.message);
    return logs;
  }

  let todos;
  try {
    todos = await backend.loadTodos();
  } catch (err) {
    push('', `跳过 - 无法读取${backend.label}攻略(Notion 需检查 integration 是否连接到该页面): ` + err.message);
    return logs;
  }

  if (todos.length === 0) {
    push('', '跳过 - 攻略里没找到checkbox(可能是纯数据库/纯笔记页面,需要手动处理)');
    return logs;
  }

  const defs = achievementsFor(db, guide.appid);
  const unsafeNames = findAmbiguousNames(db, guide.appid, new Set(unlocked.map((a) => a.apiname)));
  const matches = matchAchievements(unlocked, todos, { unsafeNames, defs });

  // 同名成就导致的跳过必须记下来:静默漏勾和"本来就没什么可勾"看起来一样,
  // 时间久了会以为同步是好的,其实一直在漏
  for (const a of matches.skippedAmbiguous ?? []) {
    push(a.nameCn || a.nameEn, '跳过 - 有多个同名成就且只解锁了一部分,攻略里也没抄成就描述原文,靠名字分不出该勾哪个;需人工核对(很可能已解锁那个的框早就勾上了、剩下的本来就不该勾)');
  }
  // 子步骤联动。注意它**不要求** matches 非空:绝大多数成就早就勾上了,
  // 这次没有新成就要勾、但下面的子步骤还空着,才是最常见的情况
  const subSteps = cascade
    ? collectSubStepTicks(todos, matches, {
        defs,
        unlockedApiNames: new Set(unlocked.map((a) => a.apiname)),
      })
    : [];

  if (matches.length === 0 && subSteps.length === 0) return logs;

  // 预演模式:只读页面、算出会勾哪些,不写任何东西(Notion 的勾选没法自动撤销,
  // 所以第一次跑、或者改过匹配规则之后,应该先用 --dry-run 看一眼)
  if (dryRun) {
    for (const m of matches) {
      push(m.achievement.nameCn || m.achievement.nameEn, '【预演】会勾选: ' + m.text.slice(0, 60));
    }
    for (const s of subSteps) {
      push('', '【预演】会勾选子步骤: ' + s.text.replace(/\n/g, ' ').slice(0, 60));
    }
    return logs;
  }

  try {
    await backend.applyChecks([...matches.map((m) => m.key), ...subSteps.map((s) => s.key)]);
    for (const m of matches) {
      push(m.achievement.nameCn || m.achievement.nameEn, '已勾选: ' + m.text.slice(0, 60));
    }
    // 子步骤单独记:它不是按成就匹配勾上的,而是靠父成就联动推出来的,
    // 事后复查"这个框凭什么勾上"时必须能一眼分出来
    for (const s of subSteps) {
      push('', '已勾选子步骤(父成就已解锁): ' + s.text.replace(/\n/g, ' ').slice(0, 60));
    }
  } catch (err) {
    push('', '勾选失败: ' + err.message);
  }
  return logs;
}

/**
 * 挑出这次要读攻略页的游戏。**单独抽出来是为了能测**——和 selectStatsTargets 同理:
 * 这里放宽会白烧几十次 Notion/Steam 调用,收紧会静默漏勾,两种都不报错。
 *
 * 基础条件:有攻略链接、有成就系统、完成数 < 成就总数(已经 100% 的跳过)。
 * 判断依据是本地自己的成就数,不看 Notion 的 Status 属性——重复跑已完成的游戏只是 no-op。
 *
 * 两个缩小范围的参数语义不同,别混:
 * - `appid`:CLI 的"只跑这一款"。
 * - `appids`:白名单数组,serve 的自动同步用它把候选压到"这轮真的变了的行"。
 *   **空数组表示一款都不跑**,不是"不限制"——不限制是 null。写成 `appids?.length ? … : 全部`
 *   之类的会把"这次没有变化"翻译成"那就跑全量",正好是这个参数要避免的事。
 */
export function selectCheckboxCandidates(db, { appid = null, appids = null, cascade = true } = {}) {
  const only = appids === null ? null : new Set(appids.map(String));
  const guideByAppid = Object.fromEntries(allGuides(db).map((g) => [g.appid, g]));
  const games = allGames(db).filter((g) => {
    if (!guideByAppid[g.appid]) return false;
    if (appid && g.appid !== String(appid)) return false;
    if (only && !only.has(g.appid)) return false;
    if (typeof g.total !== 'number' || g.total <= 0) return false;
    if (g.achieved >= g.total) {
      // 已经 100% 的游戏。**必须有成就详情**才值得读:不管是靠名字匹配还是靠
      // resolveTodoToAchievement 认父成就,都要 achievements 表里的名字/描述。
      // 而 syncAchievementSchema 故意跳过正好 100% 的游戏——实测早就满成就的那批
      // 55/55 都没有详情。不加这道闸门的话,每次跑都会白拉 55 个页面 + 55 次 Steam
      // 请求,一个框也勾不上。哪天真给某个满成就游戏同步了详情,自动生效。
      if (achievementsFor(db, g.appid).length === 0) return false;
      // 有详情之后还要回答"这一趟值得走吗":
      // - 开了子步骤联动 → 值得,成就全解锁但底下的子步骤可能还空着
      // - **这一行是这轮点名进来的**(appids 白名单)→ 值得,而且是必须的:
      //   它是刚刚才打满的,最后那几个成就的框八成还空着。少了这一条,
      //   "让游戏通关的那个成就"的 checkbox 永远不会被自动勾上——一次都不会,
      //   因为等我们下次来看时它已经是 100%,被这里挡掉了。
      return cascade || only !== null;
    }
    return true;
  });
  return { games, guideByAppid };
}

/** 每日 checkbox 同步(原 dailyCheckboxSync)。候选规则见 selectCheckboxCandidates。 */
export async function checkboxSync(
  db,
  steam,
  { notion, config, appid = null, appids = null, dryRun = false, cascade = true, onProgress = () => {} }
) {
  const { games: candidates, guideByAppid } = selectCheckboxCandidates(db, { appid, appids, cascade });

  const allLogs = [];
  for (const [i, g] of candidates.entries()) {
    onProgress({ done: i + 1, total: candidates.length, name: g.name });
    const logs = await syncGameCheckboxes(db, steam, guideByAppid[g.appid], g.name, {
      notion,
      config,
      dryRun,
      cascade,
    });
    allLogs.push(...logs);
    await sleep(350); // 给 Notion API 留余量,避免 429
  }

  // 预演不写 sync_log,免得审计表里混进没真发生过的事
  if (!dryRun) appendSyncLog(db, allLogs);
  return { checked: candidates.length, logs: allLogs, dryRun };
}

// ---------------------------------------------------------------------------
// 攻略状态:完成度和 Notion 页面状态对齐(打满 → Done,掉出 100% → Staged)
// ---------------------------------------------------------------------------

export const GUIDE_STATUS_DONE = 'Done';
export const GUIDE_STATUS_STAGED = 'Staged';

/**
 * 哪些攻略页的状态该改。**纯函数,可测**——和 selectCheckboxCandidates 同理。
 *
 * 判据是**当前状态**,不是"这一轮刚好跨过 100%"。故意的:跨越那个瞬间只在
 * updateGameStats 写那一下存在,错过一次(CLI 同步时没有 Notion token、进程被 Ctrl+C、
 * 那台机器根本没配 Notion)就永远补不回来了——下次再看,新旧值一样,什么都推断不出来。
 * 按状态收敛就没有这个问题:跑多少次结果一样,漏了一次下次自己补上。
 *
 * 实测这不只是"更整洁":唯一一个需要回退的页面(Supermarket Together 28/51)
 * `new_ach_date` 是空的,靠"看见 total 变多了"来触发的写法对它**一次都不会触发**。
 *
 * 两个方向的宽严是不对称的,这是有意的:
 * - **升到 Done**:除了已经是 Done,其它状态一律覆盖(完成度说了算)。
 * - **退回 Staged**:只动 Done 的页面。不到 100% 的 Paused / In progress /
 *   Not started / Differed 都是你自己排的工作流状态,没有理由去动它们——
 *   而且每次打开 Dashboard 都覆盖一遍的话,人跟机器就会一直互相改。
 *
 * 只管 kind='notion' 的攻略。本地 markdown 没有状态属性这个概念。
 */
export function selectGuideStatusUpdates(
  db,
  pages,
  { doneName = GUIDE_STATUS_DONE, stagedName = GUIDE_STATUS_STAGED } = {}
) {
  const byPageId = new Map();
  for (const g of allGuides(db)) {
    if (g.kind !== 'notion') continue;
    const id = normalizeNotionId(g.url);
    if (id) byPageId.set(id, g);
  }

  const updates = [];
  for (const page of pages) {
    // 页面身份一律走规范化 ID,不能比 URL 原文(见 normalizeNotionId 的注释)
    const id = normalizeNotionId(page.id) || normalizeNotionId(page.url);
    const guide = id ? byPageId.get(id) : null;
    if (!guide) continue; // 还没登记 appid 的攻略页(攻略没写完),不归这里管

    const game = getGame(db, guide.appid);
    if (!game) continue;
    // 没有成就系统 / 还没同步过:两种都推不出完成度,一律不动。
    // 这一条也顺带挡住了几种假的"掉出 100%":markNoAchievements 会把 total 清成 NULL,
    // 限流和 403 则是 retry、根本不写库,所以那些情况到不了这里。
    if (typeof game.total !== 'number' || game.total <= 0) continue;
    if (typeof game.achieved !== 'number') continue;

    const perfect = game.achieved >= game.total;
    const name = game.name || page.title;
    const common = { appid: guide.appid, pageId: page.id, name, from: page.status };

    if (perfect && page.status !== doneName) {
      updates.push({ ...common, to: doneName, reason: 'complete' });
    } else if (!perfect && page.status === doneName) {
      // 通常是开发者打补丁加了新成就,把满成就的游戏顶下 100%
      updates.push({ ...common, to: stagedName, reason: 'incomplete' });
    }
  }
  return updates;
}

/**
 * 让攻略页状态和完成度对齐,双向:
 *   - 打满了 → Done(除 Done 外其它状态一律覆盖,完成度说了算)
 *   - 掉出 100% → Staged(**只动 Done 的页面**,别的状态是人排的工作流,不碰)
 * 掉出 100% 基本都是开发者打补丁加了新成就。
 */
export async function syncGuideStatuses(db, { notion, dryRun = false, onProgress = () => {} }) {
  const schema = await notion.fetchGuideStatusSchema();
  if (!schema) {
    throw new Error('攻略数据库里没有 status/select 类型的属性,没法标记完成状态');
  }
  // 选项名对不上的话 Notion 会回一个很难读的 400,不如自己先说清楚。
  // 两个都要查:只有 Done 而没有 Staged 的话,回退那一半会在真要用时才炸。
  if (schema.options.length) {
    const missing = [GUIDE_STATUS_DONE, GUIDE_STATUS_STAGED].filter((o) => !schema.options.includes(o));
    if (missing.length) {
      throw new Error(
        `攻略数据库的「${schema.property}」属性缺少这些选项:${missing.join('、')}` +
          `(现有:${schema.options.join('、')})`
      );
    }
  }

  const pages = await notion.queryGuideDatabase();
  const updates = selectGuideStatusUpdates(db, pages);
  const logs = [];
  const applied = [];
  const push = (u, result) =>
    logs.push({ ts: nowIso(), appid: u.appid, gameName: u.name, achievement: '', result });
  const why = (u) => (u.reason === 'complete' ? '成就已打满' : '成就总数变多,掉出 100%');

  for (const [i, u] of updates.entries()) {
    onProgress({ done: i + 1, total: updates.length, name: u.name });
    const shown = u.from || '(空)';
    if (dryRun) {
      push(u, `【预演】会把攻略状态从 ${shown} 改成 ${u.to}(${why(u)})`);
      continue;
    }
    try {
      await notion.setPageStatus(u.pageId, { property: schema.property, type: schema.type, value: u.to });
      applied.push(u);
      push(u, `攻略状态 ${shown} → ${u.to}(${why(u)})`);
    } catch (err) {
      // 一页改不动不该让剩下的都不跑
      push(u, `攻略状态改失败: ${err.message}`);
    }
    await sleep(350);
  }

  if (!dryRun) appendSyncLog(db, logs);
  // applied 是**真的写成功了**的那些(updates 里还包含失败的)。调用方拿它做提示,
  // 不用去解析日志文本——那种耦合改一个字就断
  return { pages: pages.length, updates, applied, logs, dryRun };
}

// ---------------------------------------------------------------------------
// 攻略发现:Notion 数据库 / 本地 guides 目录
// ---------------------------------------------------------------------------

/**
 * 原 syncGuidesFromNotion:查攻略数据库拿全部页面,对还没登记过的页面读一次 block,
 * 有 "appid: NNNNNN" 行就登记进 guides 表。
 * 去重必须按规范化的 Notion page ID,不能按 URL 原文(见 normalizeNotionId 的注释)。
 */
export async function syncGuidesFromNotion(db, notion) {
  const existingIds = new Set(
    allGuides(db)
      .map((g) => normalizeNotionId(g.url))
      .filter(Boolean)
  );

  const pages = await notion.queryGuideDatabase();
  const newPages = pages.filter((p) => {
    const id = normalizeNotionId(p.id) || normalizeNotionId(p.url);
    return !id || !existingIds.has(id);
  });

  const added = [];
  const failed = [];
  for (const page of newPages) {
    try {
      const appid = await notion.extractAppIdFromPageContent(page.id);
      if (appid) {
        upsertGuide(db, { appid, name: page.title, url: page.url, kind: 'notion' });
        added.push({ appid, name: page.title });
      }
    } catch (err) {
      failed.push({ title: page.title, error: err.message });
    }
    await sleep(350);
  }

  if (added.length || failed.length) {
    appendSyncLog(db, [
      {
        ts: nowIso(),
        result:
          `Guide Sync - 新增 ${added.length} 条攻略链接` +
          (added.length ? ': ' + added.map((a) => `${a.name}(${a.appid})`).join(', ') : '') +
          (failed.length ? ` / 读取失败 ${failed.length} 个页面` : ''),
      },
    ]);
  }

  return { dbPages: pages.length, newPagesChecked: newPages.length, added, failed };
}

/**
 * 本地版新增:扫 guides/ 目录里的 .md 文件,同样按 "appid: NNNNNN" 行登记进 guides 表
 * (kind='local')。和 Notion 的发现逻辑对称,这样本地 markdown 攻略也不用手工维护链接表。
 */
export function syncGuidesFromMarkdown(db, config, { force = false } = {}) {
  // guidesDir 可以不存在:仓库里没有本地攻略、或者 guidesDir 指到了还没建的目录。
  // 不是错误——直接当"没有本地攻略"处理。抛出来的话 serve 的攻略发现会整个中断,
  // 连后面的 Notion 发现都跑不到。
  if (!existsSync(config.guidesDir)) return { files: 0, added: [], skipped: [], conflicts: [] };
  const files = readdirSync(config.guidesDir).filter((f) => f.endsWith('.md'));
  const added = [];
  const skipped = [];
  const conflicts = [];

  for (const file of files) {
    const head = readFileSync(join(config.guidesDir, file), 'utf8').split('\n').slice(0, 15).join('\n');
    const m = head.match(/^appid:\s*(\d+)/im);
    if (!m) {
      skipped.push(file);
      continue;
    }
    const appid = m[1];
    const title = head.match(/^#\s*(.+)$/m)?.[1]?.trim() || file;

    // 一个 appid 只能有一个攻略后端。已经登记了 Notion 页面的游戏默认不动——
    // Notion 是主用法,不该因为本地正好也有一份 .md 就把链接悄悄换掉(要换加 --force)。
    const existing = getGuide(db, appid);
    if (existing && existing.kind === 'notion' && !force) {
      conflicts.push({ appid, file, notionUrl: existing.url });
      continue;
    }

    const action = upsertGuide(db, { appid, name: title, url: file, kind: 'local' });
    added.push({ appid, name: title, file, action });
  }

  return { files: files.length, added, skipped, conflicts };
}
