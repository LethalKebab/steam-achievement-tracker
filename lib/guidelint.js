/**
 * 攻略校验器
 * ------------------------------------------------
 * 回答一个问题:**这份攻略,同步脚本能不能正确处理?**
 *
 * 不判断攻略写得好不好——步骤对不对、难度准不准、"易错过"标注是否属实,机器都验不了,
 * 那是人的活。这里只验格式和数据一致性,也就是 checkbox-sync 和 audit 依赖的那些前提。
 * 这个边界必须说清楚:通过校验 ≠ 攻略正确,只 ≠ 攻略会把同步搞砸。
 *
 * **故意不认识后端**:输入是 {key, text, checked, parent} 的 todo 数组,而 Notion
 * (fetchAllToDoBlocks)和本地 markdown(loadTodos)本来就都产出这个形状。于是同一套
 * 规则对两种后端一字不差,而且离线可测——写单测不需要 Notion token。
 *
 * 判定用的谓词都从 lib/guides.js 拿现成的,不另写一套:校验器说"这个框 audit 能反查",
 * 靠的就是调用 audit 自己用的那个函数,而不是一个长得像的复制品。
 */
import { achievementsFor, allGuides } from './db.js';
import { normalizeText, extractTitleCandidates, resolveTodoToAchievement, backendFor } from './guides.js';

/** 去掉所有空白再比——和 resolveTodoToAchievement 的描述比对保持完全一致 */
const flat = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * 一行里出现第二个 [ ] / [x] 就是合并行。
 *
 * 为什么是错的见 SKILL.md 规则一:Notion 一行只有开头第一个方括号会渲染成真 checkbox,
 * 后面的会被转义成字面量 `\[x\]`,同步脚本根本找不到那些成就。
 * todo.text 是行首 checkbox **之后**的部分,所以这里数到的都是多余的。
 */
const MERGED_RE = /\[\s*[xX ]\s*\]/;

/** 节标题里的统计数字,SKILL.md 规则 4.2 禁止(会随进度过期,且没人会去更新) */
const HEADING_STATS_RE = /共\s*\d+\s*[个項项]|\d+\s*[项個个]\s*(未完成|已完成)/;

/** SKILL.md 规则七:攻略正文里不写数据从哪来 */
const DATA_SOURCE_RE = /勾选状态来自|数据来自\s*Steam|来自\s*Steam\s*真实|根据\s*Steam\s*(真实)?解锁/;

/**
 * 建"成就名 → 有哪些成就叫这个名字"的索引。
 *
 * 用 extractTitleCandidates + 精确相等,和 matchAchievements 第二轮同一套规则——
 * 校验器判"这个成就有没有 checkbox",标准必须和真正勾选时一模一样,
 * 不然会出现"校验说有、同步却勾不上"这种最坏的情况。
 */
function buildNameIndex(defs) {
  const byName = new Map();
  for (const d of defs) {
    for (const raw of [d.name_cn, d.name_en]) {
      const k = normalizeText(raw);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(d.api_name);
    }
  }
  return byName;
}

/**
 * 校验一份攻略。
 *
 * @param {object}   o
 * @param {Array}    o.todos    {key, text, checked, parent} —— 两种后端都产出这个形状
 * @param {Array}    o.defs     achievements 表里这个游戏的成就定义
 * @param {string}   [o.text]   攻略全文。只有本地 markdown 给得出;Notion 那边给不了
 *                              整页原文,所以依赖全文的几条会自动跳过而不是误报
 * @param {Set|null} [o.unlockedApiNames]  真实解锁状态。给了才校验勾选状态是否一致
 * @param {string}   [o.kind]   'local' | 'notion' —— 只影响"要不要有 # 标题"这一条
 */
export function lintGuide({ todos, defs, text = null, unlockedApiNames = null, kind = 'notion' }) {
  const findings = [];
  const add = (level, code, message, extra = {}) => findings.push({ level, code, message, ...extra });

  const byName = buildNameIndex(defs);

  // ---- 每个成就是不是都有自己的 checkbox 行 ----
  // 反过来做:先把每个 todo 能对上的成就都收集起来,再看谁没被收集到。
  // **不能用 resolveTodoToAchievement 来做这一步**——它对同名成就一律返回 null,
  // 而同名成就的框其实是存在的,只是靠名字认不出来。用它会在那 12 款同名游戏上
  // 批量误报"缺 checkbox"。同名是另一条规则的事,见下面。
  const covered = new Set();
  const todoByApiName = new Map();
  for (const t of todos) {
    for (const cand of extractTitleCandidates(normalizeText(t.text))) {
      const hit = byName.get(cand);
      if (!hit) continue;
      for (const apiName of hit) {
        covered.add(apiName);
        if (!todoByApiName.has(apiName)) todoByApiName.set(apiName, []);
        todoByApiName.get(apiName).push(t);
      }
    }
  }

  for (const d of defs) {
    if (covered.has(d.api_name)) continue;
    add('error', 'missing-checkbox', `成就没有对应的 checkbox 行,永远勾不上:${d.name_cn || d.name_en || d.api_name}`, {
      apiName: d.api_name,
      name: d.name_cn || d.name_en || d.api_name,
    });
  }

  // ---- 合并行 ----
  for (const t of todos) {
    if (MERGED_RE.test(t.text)) {
      add('error', 'merged-line', `一行里写了多个 checkbox,后面几个不会渲染成真 checkbox:${t.text.slice(0, 60)}`, {
        key: t.key,
      });
    }
  }

  // ---- 同名成就必须抄描述,否则永远同步不上 ----
  // findAmbiguousNames 判的是"这一轮能不能安全勾",要真实解锁状态;这里判的是攻略本身
  // 写得对不对,和解锁状态无关,所以直接看索引:一个名字对应多个成就就是同名。
  for (const [name, apiNames] of byName) {
    if (apiNames.size < 2) continue;
    for (const apiName of apiNames) {
      const d = defs.find((x) => x.api_name === apiName);
      if (!d) continue;
      const hits = todoByApiName.get(apiName) ?? [];
      // 只要有任意一个框抄了这个成就的描述原文,它就能被区分出来
      const hasDesc = d.description && hits.some((t) => flat(t.text).includes(flat(d.description)));
      if (hasDesc) continue;
      add(
        'error',
        'ambiguous-no-description',
        d.description
          ? `同名成就「${name}」没抄描述原文,靠名字分不出是哪一个,永远同步不上`
          : `同名成就「${name}」在 Steam 上的描述是空的,无法区分——这份攻略里它注定同步不上(不是攻略的错)`,
        { apiName, name, fixable: Boolean(d.description) }
      );
    }
  }

  // ---- 描述是不是原文照抄 ----
  // 用的是 resolveTodoToAchievement 里那条完全相同的判据,所以这一条通过 = audit 反查得动。
  // 只报 warn:改写过的描述照样能靠名字勾上,只是审计验不了它,SKILL.md 里也是这么说的。
  for (const d of defs) {
    if (!d.description) continue;
    const hits = todoByApiName.get(d.api_name) ?? [];
    if (!hits.length) continue; // 缺 checkbox 已经在上面报过了,不重复报
    if (hits.some((t) => flat(t.text).includes(flat(d.description)))) continue;
    add('warn', 'paraphrased-description', `描述不是原文照抄,audit 无法反查这个框:${d.name_cn || d.name_en}`, {
      apiName: d.api_name,
      name: d.name_cn || d.name_en || d.api_name,
    });
  }

  // ---- 勾选状态和真实解锁是否一致 ----
  // 机械打勾之后这一条理论上不可能失败,留着是为了兜住手写攻略和历史遗留数据。
  if (unlockedApiNames) {
    for (const d of defs) {
      const hits = todoByApiName.get(d.api_name) ?? [];
      if (!hits.length) continue;
      const shouldBeChecked = unlockedApiNames.has(d.api_name);
      // 同名成就的一个名字会命中多个框,任意一个状态对上就算对——这正是同名歧义本身,
      // 上面已经单独报过了,这里不再叠一次
      if (hits.some((t) => t.checked === shouldBeChecked)) continue;
      add(
        'error',
        'checked-mismatch',
        shouldBeChecked
          ? `成就已解锁但框没勾:${d.name_cn || d.name_en}`
          : `框勾上了但成就并没解锁:${d.name_cn || d.name_en}`,
        { apiName: d.api_name, name: d.name_cn || d.name_en || d.api_name }
      );
    }
  }

  // ---- 下面几条要攻略全文,只有本地 markdown 给得出 ----
  if (text !== null) {
    // SKILL.md 规则 4.1:本地 md 必须有 `# 游戏名`。少了这行,syncGuidesFromMarkdown
    // 会拿前 15 行里第一个 ^# 当攻略名,于是 guides 表里的名字变成第一个小节标题(踩过)
    if (kind === 'local' && !/^#\s+\S/m.test(text.split('\n').slice(0, 15).join('\n'))) {
      add('error', 'missing-title', '本地攻略前 15 行里没有 `# 游戏名`,登记进 guides 表时名字会取错');
    }
    for (const line of text.split('\n')) {
      if (/^#{1,6}\s/.test(line) && HEADING_STATS_RE.test(line)) {
        add('warn', 'stats-in-heading', `节标题里有统计数字,会随进度过期:${line.trim().slice(0, 50)}`);
      }
    }
    if (DATA_SOURCE_RE.test(text)) {
      add('warn', 'data-source-note', '攻略里写了勾选状态的数据来源,SKILL.md 规则七要求去掉');
    }
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  return {
    findings,
    ok: errors === 0,
    stats: {
      achievements: defs.length,
      todos: todos.length,
      covered: covered.size,
      errors,
      warnings: findings.length - errors,
    },
  };
}

/**
 * 机械打勾:算出哪些 todo 的 key 该是勾上的状态。
 *
 * 设计上模型只写 `- [ ]`,勾选状态一律由这里按数据库填。这样"勾选必须等于真实解锁"
 * 就从一条要检查的规则,变成了结构上不可能违反的事实——SKILL.md 规则十第 16 条
 * 原本要人逐条核对,现在不需要了。
 *
 * 只回答"该勾哪些",不碰文件:本地 md 交给 markdown.js 的 applyChecks 去写,
 * Notion 那边是另一套写入 API。
 */
export function computeCheckedKeys({ todos, defs, unlockedApiNames }) {
  const byName = buildNameIndex(defs);
  const keys = [];
  for (const t of todos) {
    if (t.checked) continue; // 已经勾上的不用管——同步只勾不取消,和 checkbox-sync 一致
    const matched = extractTitleCandidates(normalizeText(t.text)).some((cand) => {
      const hit = byName.get(cand);
      // 同名的名字不能用来打勾:分不清是哪一个,可能勾错另一个还没解锁的。
      // 这和 findAmbiguousNames 是同一条谨慎原则——宁可漏勾,不能勾错
      if (!hit || hit.size !== 1) return false;
      return unlockedApiNames.has([...hit][0]);
    });
    if (matched) keys.push(t.key);
  }
  return keys;
}

/**
 * 机械打勾**永远够不着**的成就:两个名字(中文、英文)没有一个是这个游戏里独一份的。
 *
 * `computeCheckedKeys` 对名字撞车的候选一律跳过(`hit.size !== 1`),因为分不清是哪一个,
 * 可能勾错另一个还没解锁的——宁可漏勾不能勾错。于是这些成就**解锁了框也不会被勾上**,
 * 而 `checked-mismatch` 会照报不误。生成攻略时必须知道这批是谁,不然三轮改写都过不了关,
 * 而且报的还是一条模型根本改不动的错(它连 checkbox 都不许写)。
 *
 * **按名字算,不是按成就算**——中文名撞车但英文名唯一的照样勾得上,这和 2026-08-09
 * 那次"闸门按名字关"的改动是同一条规则。12 款同名游戏里有 9 款只在一种语言下撞车。
 */
export function unnameableApiNames(defs) {
  const byName = buildNameIndex(defs);
  const out = new Set();
  for (const d of defs) {
    const hasUniqueName = [d.name_cn, d.name_en].some((raw) => {
      const k = normalizeText(raw);
      return k && byName.get(k)?.size === 1;
    });
    if (!hasUniqueName) out.add(d.api_name);
  }
  return out;
}

/**
 * 从 db 取某个 appid 的成就定义。校验器的调用方几乎都要这一步,放这儿省得各写一遍。
 * 返回空数组表示这游戏的成就详情还没同步过(syncAchievementSchema 没跑到),
 * 这种情况下校验没有意义——调用方应该先报这件事,而不是报"所有成就都缺 checkbox"。
 */
export function defsFor(db, appid) {
  return achievementsFor(db, appid);
}

/**
 * 把校验器跑到真实攻略上。上面那些函数都是纯的(测试不联网),网络 I/O 全在这里,
 * 和 guides.js 里 `matchAchievements`(纯)/ `checkboxSync`(联网)的分工是同一套。
 *
 * 只读:不写数据库、不碰 Notion、不改本地 md。
 *
 * `steam` 传了才校验勾选状态(`checked-mismatch`),默认不传。原因是那要给每款游戏
 * 单独发一次 Steam 请求(`audit` 慢就慢在这儿),而且"已解锁但没勾"本来就是
 * `checkbox-sync` 该干的活、不是攻略写得有问题——默认报出来只会把真正的内容问题淹掉。
 *
 * @returns {{results: Array, totals: object}}
 */
export async function lintAllGuides(db, { notion, config, steam = null, appid = null, onProgress = () => {} }) {
  const targets = allGuides(db).filter((g) => !appid || g.appid === String(appid));
  const results = [];
  const totals = {
    guides: 0, clean: 0, noErrors: 0, skipped: 0,
    errors: 0, warnings: 0, achievements: 0, covered: 0,
    byCode: {},
  };

  for (const [i, g] of targets.entries()) {
    onProgress({ done: i + 1, total: targets.length, name: g.name });
    const entry = { appid: g.appid, name: g.name, kind: g.kind, skipped: null, lint: null };

    const defs = achievementsFor(db, g.appid);
    if (defs.length === 0) {
      // 100% 通关的游戏 syncAchievementSchema 故意不同步成就详情,没有可比对的基准。
      // 必须如实报成"跳过"而不是悄悄漏掉——不然"全都干净"看起来比实际覆盖范围强
      entry.skipped = '还没同步成就详情(先跑 sync --schema)';
      results.push(entry);
      totals.skipped++;
      continue;
    }

    const backend = backendFor(g, { notion, config });
    let todos, text = null;
    try {
      todos = await backend.loadTodos();
      text = await backend.loadText();
    } catch (err) {
      entry.skipped = '读不到攻略:' + err.message;
      results.push(entry);
      totals.skipped++;
      continue;
    }

    let unlockedApiNames = null;
    if (steam) {
      const raw = await steam.fetchPlayerAchievements(g.appid);
      if (!raw.retry && !raw.noAchievementSystem) {
        unlockedApiNames = new Set((raw.achievements ?? []).filter((a) => a.achieved).map((a) => a.apiname));
      }
    }

    // todos 直接透传:两种后端产出的就是 lintGuide 要的 {key, text, checked, parent}。
    // 这里不做"防御性"重整形——那会把将来某一边真的改了形状这件事掩盖掉
    entry.lint = lintGuide({
      todos,
      defs,
      text,
      unlockedApiNames,
      kind: g.kind === 'local' ? 'local' : 'notion',
    });

    totals.guides++;
    totals.errors += entry.lint.stats.errors;
    totals.warnings += entry.lint.stats.warnings;
    totals.achievements += entry.lint.stats.achievements;
    totals.covered += entry.lint.stats.covered;
    if (entry.lint.findings.length === 0) totals.clean++;
    if (entry.lint.stats.errors === 0) totals.noErrors++;
    for (const f of entry.lint.findings) totals.byCode[f.code] = (totals.byCode[f.code] ?? 0) + 1;

    results.push(entry);
  }

  return { results, totals };
}
