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
import { achievementsFor, allGames, allGuides, upsertGuide, getGuide, appendSyncLog, nowIso } from './db.js';
import { sleep } from './steam.js';
import { extractNotionPageId, normalizeNotionId } from './notion.js';
import * as md from './markdown.js';
import { readFileSync, readdirSync } from 'node:fs';
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
  const skipped = [];

  const isAmbiguous = (ach) => {
    const cn = normalizeText(ach.nameCn);
    const en = normalizeText(ach.nameEn);
    return (cn && unsafeNames.has(cn)) || (en && unsafeNames.has(en));
  };

  // ── 第一遍:名字有歧义的成就,只能靠**描述原文**定位 ──────────────────────
  // 同名成就靠名字永远分不出来,但如果 checkbox 里抄了某个成就的完整描述、而且这条描述
  // 在本游戏里唯一,那这个框说的就是那个成就,没有二义性,可以放心勾。
  // 放在第一遍是因为描述比名字精确:先让它认领自己的框,避免被第二遍的名字匹配抢走。
  const ambiguous = unlocked.filter((a) => isAmbiguous(a) && (a.nameCn || a.nameEn));
  for (const ach of ambiguous) {
    const todo = pending.find((t) => {
      if (claimed.has(t.key)) return false;
      const hit = resolveTodoToAchievement(t.text, defs);
      // 必须是"按描述"对上的:按名字那条路对同名成就本来就会返回 null,写明更不容易误改
      return hit?.via === 'description' && hit.def.api_name === ach.apiname;
    });
    if (todo) {
      claimed.add(todo.key);
      matches.push({ key: todo.key, achievement: ach, text: todo.text, via: 'description' });
    } else if (!nameGroupAlreadySatisfied(ach, unlocked, todos)) {
      skipped.push(ach);
    }
    // nameGroupAlreadySatisfied 为真时静默:这一组该勾的框已经勾够了,没事要做。
    // 不这么判的话,这种游戏每次跑都会报一条"需人工核对",而其实什么都不用做——
    // 天天喊狼来了,真有事的时候就没人看日志了。
  }

  // ── 第二遍:名字没有歧义的,按名字精确匹配 ────────────────────────────────
  for (const ach of unlocked) {
    if (isAmbiguous(ach)) continue; // 第一遍处理过了
    const cn = normalizeText(ach.nameCn);
    const en = normalizeText(ach.nameEn);
    if (!cn && !en) continue;

    for (const todo of pending) {
      if (claimed.has(todo.key)) continue;
      const norm = normalizeText(todo.text);
      if (!norm) continue;

      const candidates = extractTitleCandidates(norm);
      if ((cn && candidates.includes(cn)) || (en && candidates.includes(en))) {
        claimed.add(todo.key);
        matches.push({ key: todo.key, achievement: ach, text: todo.text, via: 'name' });
        break;
      }
    }
  }
  matches.skippedAmbiguous = skipped;
  return matches;
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
      entry.ticked++;
      const hit = resolveTodoToAchievement(t.text, defs);
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
export async function syncGameCheckboxes(db, steam, guide, gameName, { notion, config, dryRun = false }) {
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
  if (matches.length === 0) return logs;

  // 预演模式:只读页面、算出会勾哪些,不写任何东西(Notion 的勾选没法自动撤销,
  // 所以第一次跑、或者改过匹配规则之后,应该先用 --dry-run 看一眼)
  if (dryRun) {
    for (const m of matches) {
      push(m.achievement.nameCn || m.achievement.nameEn, '【预演】会勾选: ' + m.text.slice(0, 60));
    }
    return logs;
  }

  try {
    await backend.applyChecks(matches.map((m) => m.key));
    for (const m of matches) {
      push(m.achievement.nameCn || m.achievement.nameEn, '已勾选: ' + m.text.slice(0, 60));
    }
  } catch (err) {
    push('', '勾选失败: ' + err.message);
  }
  return logs;
}

/**
 * 每日 checkbox 同步(原 dailyCheckboxSync)。
 * 候选条件:有攻略链接、有成就系统、完成数 < 成就总数(已经 100% 的跳过)。
 * 判断依据是本地自己的成就数,不看 Notion 的 Status 属性——重复跑已完成的游戏只是 no-op。
 */
export async function checkboxSync(
  db,
  steam,
  { notion, config, appid = null, dryRun = false, onProgress = () => {} }
) {
  const guideByAppid = Object.fromEntries(allGuides(db).map((g) => [g.appid, g]));
  const candidates = allGames(db).filter((g) => {
    if (!guideByAppid[g.appid]) return false;
    if (appid && g.appid !== String(appid)) return false;
    return typeof g.total === 'number' && g.total > 0 && g.achieved < g.total;
  });

  const allLogs = [];
  for (const [i, g] of candidates.entries()) {
    onProgress({ done: i + 1, total: candidates.length, name: g.name });
    const logs = await syncGameCheckboxes(db, steam, guideByAppid[g.appid], g.name, {
      notion,
      config,
      dryRun,
    });
    allLogs.push(...logs);
    await sleep(350); // 给 Notion API 留余量,避免 429
  }

  // 预演不写 sync_log,免得审计表里混进没真发生过的事
  if (!dryRun) appendSyncLog(db, allLogs);
  return { checked: candidates.length, logs: allLogs, dryRun };
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
