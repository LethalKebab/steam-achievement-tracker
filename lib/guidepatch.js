/**
 * 局部重写 —— 编排
 * ------------------------------------------------
 * 「只重写点名的那几条成就」。整篇重写走 `guidegen.js` 的 `generateGuide`,这里是
 * 另一条路,共用它的提示词、闸门和备份规矩。
 *
 * ## 为什么是另一个文件,不是 generateGuide 的一个分支
 *
 * `generateGuide` 五百多行,绝大部分是**分段并发**的机器:每段一个会话、切小的三级
 * 梯子、失败段的记账、摊平后的段号映射。局部重写一条都不需要 —— 它是一次请求、
 * 一批点名的条目、一次拼接。把它塞成那个函数的分支,等于给一个已经很密的状态机
 * 再加一维,而两条路唯一真正共享的东西是**提示词和闸门**,那两样都是导入来的。
 *
 * ## 这条路的三条硬规矩
 *
 * 1. **只贴回点名的那几条,按已知的行号/块 id。** 保证不来自"叫模型别动别的",
 *    而来自程序只接收它问的那几条、只往它记下来的位置写。模型多写的一律**不用**
 *    (报出来,不应用)—— 和机械打勾取代"检查模型有没有写对 `- [x]`" 是同一个手法。
 * 2. **闸门不松。** 打勾和校验一律对着**改完之后的整份**做,用的是 `lintGuide` /
 *    `computeCheckedKeys` 同一对函数。新增的只有一件事:旧攻略本来就有的问题
 *    不算这次的账(`classifyFindings`),否则一次做对了的改动会被一个用户没要求
 *    改、我们也没授权去改的老问题整个丢掉。
 * 3. **备份是前置条件。** 和 `--overwrite` 一样:备份失败就一个字都不写。局部重写
 *    动的字少,但"少"不等于"可逆"。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadTodos, parseTodos, todoSpans, spliceLines, applyChecks, resolveGuidePath } from './markdown.js';
import { lintGuide, computeCheckedKeys } from './guidelint.js';
import { resolveTodoToAchievement, syncGuidesFromMarkdown } from './guides.js';
import { markdownToBlocks } from './notionblocks.js';
import { extractNotionPageId } from './notion.js';
import { createSession, checkResult, addUsage, emptyUsage } from './ai.js';
import { backupGuide, patchPreflight } from './guidebackup.js';
import { resolveScope, scopeEntries, classifyFindings } from './guidescope.js';
import {
  DRAFTS_DIR, MODEL_FIXABLE, RETRYABLE, SPLITTABLE,
  buildSystemPrompt, buildPatchMessage, extractMarkdown, splitFindings, planGuide,
} from './guidegen.js';

/** 一次局部重写最多问几轮。默认 2,比整篇的 3 少一轮 —— 见文件末尾 patchGuide 的注释 */
export const PATCH_ROUNDS = 2;

/**
 * 交回来的那几条,各自是哪个成就、占哪几行。
 *
 * **只认顶层条目**(`parent === null`):缩进的那些是子步骤,归它上面那一条,单独
 * 拎出来反查会把「第 3 座神庙」当成一个成就去找。
 *
 * 归属走 `resolveTodoToAchievement` —— 和打勾、审计、Dashboard 卡片同一个函数,
 * 一个字都不放松。认不出来的进 `unresolved`,**不猜**:猜错的后果是把 A 的打法
 * 贴到 B 头上,而那是这个功能最坏的失败方式。
 *
 * @returns {{found: Map<string, string[]>, unresolved: string[]}}
 */
export function parsePatchReply(markdown, defs) {
  const md = String(markdown ?? '');
  const lines = md.split(/\r?\n/);
  const spans = todoSpans(md);
  const found = new Map();
  const unresolved = [];

  for (const t of parseTodos(md)) {
    if (t.parent !== null && t.parent !== undefined) continue;
    const hit = resolveTodoToAchievement(t.text, defs);
    if (!hit) {
      unresolved.push(t.text.slice(0, 60));
      continue;
    }
    // 同一个成就交回来两遍就只认第一遍。和 mapAchievementGuides 的规矩一致:
    // 重复通常是它顺手又提了一句,两条都贴回去会变成攻略里真的有两条
    if (found.has(hit.def.api_name)) continue;
    const span = spans.get(t.key);
    found.set(hit.def.api_name, lines.slice(span.start, span.end + 1));
  }

  return { found, unresolved };
}

/**
 * 把交回来的块**重新缩进**到原来那一条的深度。
 *
 * 攻略里的成就一律是顶层(缩进 0),模型交回来的也是,所以这个函数平时什么都不做。
 * 留着是因为它不做事的前提是"两边都顶层",而那是一个**假设**,不是保证 —— 真出现
 * 缩进不一致时,不修的后果是那一条从此挂在上一条成就底下,变成它的子步骤,而
 * `loadTodos` 会如实这么读,校验器一声不响(它只查成就有没有框,不查挂在哪儿)。
 *
 * 只往右移,不往左削:往左削要猜哪些空格是结构、哪些是对齐,猜错就把嵌套关系改了。
 */
function reindent(block, delta) {
  if (delta <= 0) return block;
  const pad = ' '.repeat(delta);
  return block.map((l) => (l.trim() ? pad + l : l));
}

/** 一条 checkbox 行的缩进宽度。拿不到就当 0 */
const indentOf = (line) => {
  const m = String(line ?? '').match(/^(\s*)[-*]\s*\[/);
  return m ? m[1].length : 0;
};

/**
 * 打回清单:**只列这次改的那几条身上的问题**。
 *
 * 和 `buildChunkFeedback` 分开写,因为要说的话不一样:那个是"你这一段违规了,
 * 重新输出这一段";这里是"你刚重写的这几条里,这几条还不对,再来一次" —— 而且
 * 必须把"别动别的成就"重申一遍,否则模型很容易顺手去修打回清单里提到的别人。
 */
export function buildPatchFeedback(findings, entries, missing = []) {
  const mine = new Set(entries.map((e) => e.apiName));
  const own = findings.filter((f) => MODEL_FIXABLE.has(f.code) && (!f.apiName || mine.has(f.apiName)));
  const byApi = new Map(entries.map((e) => [e.apiName, e]));
  const shown = (a) => {
    const d = byApi.get(a)?.def;
    return d?.name_cn || d?.name_en || a;
  };

  const parts = [];
  // **「压根没交回来」和「交回来但写得不对」要分开说。** 合成一句的话,漏掉的那几条
  // 会被描述成"校验没过",而模型收到的信息是"去修一条你以为自己写过的东西"
  if (missing.length) {
    parts.push(
      `这 ${missing.length} 条一条都没交回来:${missing.map(shown).join('、')}\n` +
        '**每一条都必须有自己的 `- [ ]` 行**,一条都不能少。'
    );
  }
  if (own.length) {
    parts.push(
      `这几条交回来了,但没过机器校验:\n${own.slice(0, 40).map((f) => `✖ ${f.message}`).join('\n')}`
    );
  }

  return (
    parts.join('\n\n') +
    `\n\n请**重新输出这 ${entries.length} 条的完整 markdown**(还是一个 \`\`\`markdown 围栏、` +
    '还是那个顺序、还是每条一个顶层 `- [ ]` 行)。**别动别的成就** —— 上面提到的问题' +
    '如果牵扯到不在这几条里的成就,那不是这一轮的事。\n' +
    'checkbox 的勾选状态不用管,程序会填;粗体名字一字不差、官方描述原文照抄。'
  );
}

/**
 * 把改动落到内存里的 todo 列表上,给闸门用。
 *
 * **Notion 后端只有这一条路能在写之前把关** —— 那边没有"整页原文"可以拼,而
 * `lintGuide` 要的正好只是 todo 列表(两种后端同一形状,这是它 backend-agnostic
 * 的全部意义)。所以这里按 todo 列表模拟拼接的结果:换掉那一条的正文、丢掉它的旧
 * 子步骤、按新写的挂上新的。
 *
 * 新条目一律 `checked: false`:它是刚写出来的,勾选状态等下由 `computeCheckedKeys`
 * 按数据库填 —— 和整篇生成同一条规矩,而不是"沿用旧的勾选状态"。沿用是错的,
 * 因为旧的那个勾可能本来就勾错了,而这正是机械打勾要消灭的东西。
 */
export function applyPatchToTodos(todos, entries, found, { kind = 'local' } = {}) {
  /**
   * 模型交回来的永远是 markdown(`<br>`)。本地攻略存的就是 `<br>`,原样;Notion 那边
   * `toRichText` 会把它换成真换行(notionblocks.js),写完读回来拿到的是 `\n`。
   * 这里模拟的是**写完之后后端里会是什么样**,所以 Notion 先换掉。
   *
   * **这不是为了让匹配成立** —— `normalizeText` 本来就把 `<br>` 归一成换行,两个后端
   * 走的是同一条,不换也匹配得上。换的理由只有一个:让**写之前这次校验**和
   * **写完回读那次校验**看到同一种文本,于是两者对不上时说明的是"写出问题了",
   * 而不是"两边表示法不同"。差别只有在真出事的时候才值钱,但那正是它存在的时候。
   */
  const asBackendText = (s) => (kind === 'notion' ? String(s).replace(/<br\s*\/?>/gi, '\n') : String(s));

  const dropped = new Set();
  const replaced = new Map();
  for (const e of entries) {
    const block = found.get(e.apiName);
    if (!block) continue;
    for (const s of e.subTodos) dropped.add(s.key);
    replaced.set(e.key, block);
  }

  const out = [];
  for (const t of todos) {
    if (dropped.has(t.key)) continue;
    const block = replaced.get(t.key);
    if (!block) {
      out.push(t);
      continue;
    }
    // 块的第一行是这条成就自己,后面是它的新子步骤。子步骤给合成 key ——
    // 它们在 Notion 上还没有 block id(要 append 之后才有),而闸门只需要
    // key 互不相同、能表达 parent 关系
    const sub = parseTodos(block.join('\n'));
    out.push({ key: t.key, text: asBackendText(sub[0]?.text ?? ''), checked: false, parent: t.parent });
    for (let i = 1; i < sub.length; i++) {
      out.push({
        key: `${t.key}#sub${i}`,
        text: asBackendText(sub[i].text),
        checked: false,
        // 只支持一层:sub[i].parent 指向块内的行号,而块内除了第 0 行没有别的
        // 顶层项,所以父一律是这条成就本身
        parent: t.key,
      });
    }
  }
  return out;
}

/**
 * 局部重写一份已有攻略。
 *
 * @param {object} db
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.provider
 * @param {object} o.steam
 * @param {string} o.appid
 * @param {object} [o.notion]
 * @param {string} o.selector     见 guidescope.js 的 resolveScope
 * @param {string} [o.instruction] 用户那句要求,原样交给模型
 * @param {boolean} [o.fresh]     true = 不把原文给模型看,让它重新查着写
 * @param {number} [o.rounds]
 * @param {object} [o.plan]       CLI 先 plan 过就传进来,别重新 plan(会多打接口,
 *                                也留下"问的那份和写的那份不是同一份"的缝)
 * @param {Function} [o.onProgress]
 */
export async function planPatch(db, { config, steam, appid, notion = null, selector, plan: given = null }) {
  // `overwrite: true` 是必须的:局部重写就是一次覆盖(只是覆盖得少),不传的话
  // planGuide 会因为"已经有攻略了"直接拒绝,那正是它该有的行为
  const plan = given ?? (await planGuide(db, { config, steam, appid, notion, overwrite: true }));
  const { defs, game, unlocked, oldTodos } = plan;

  // 没有攻略就没有"局部"可言。**说清楚该干什么** —— 这条错误的下一步动作是生成一份
  if (!plan.existing) {
    const err = new Error(`《${game}》还没有攻略,没有可以局部重写的内容。`);
    err.code = 'no-guide-to-patch';
    throw err;
  }

  const kind = plan.existing.kind;
  /**
   * 整份原文,**只有本地后端有**。
   *
   * `planGuide` 已经把它读出来了(覆盖预检要用),所以这里不再读第二遍 —— 两次读
   * 之间那份文件可能已经变了,而"验的那份和写的那份不是同一份"是这条路上最难查的
   * 一类 bug。
   *
   * Notion 那边 `plan.oldText` 是**把所有 checkbox 用换行拼起来**的东西,不是一份
   * 文档。当成全文交给 `lintGuide` 会立刻误报 `missing-title`(它当然没有 `# 游戏名`),
   * 所以这里必须按后端分,不能图省事直接用
   */
  const oldText = kind === 'local' ? plan.oldText : null;

  // **改之前先给旧攻略验一次,而且这一次是免费的**(oldTodos 已经读出来了)。
  // 它有两个用处,都不可少:`failing` 选择器靠它挑人,而 classifyFindings 靠它
  // 分清"这次改坏的"和"本来就坏的"
  const baseline = lintGuide({
    todos: oldTodos,
    defs,
    text: oldText,
    unlockedApiNames: unlocked,
    kind,
  });

  const scope = resolveScope({
    selector,
    defs,
    todos: oldTodos,
    rarity: plan.rarity,
    unlocked,
    baseline: baseline.findings,
    text: oldText,
  });

  // 认不出的名字**在花钱之前拦下来**,而且必须列出来。少改一条却报"改完了",
  // 用户要等到下次读攻略才发现 —— 这个功能最坏的失败方式
  if (scope.unresolved.length) {
    const err = new Error(`这几个名字在《${game}》的成就里找不到:${scope.unresolved.join('、')}`);
    err.code = 'unknown-achievements';
    err.detail = { unresolved: scope.unresolved };
    throw err;
  }
  if (!scope.apiNames.length) {
    const err = new Error(`按「${selector}」挑下来一条成就都没有,没有开始。`);
    err.code = 'empty-scope-result';
    err.detail = { selector };
    throw err;
  }

  const { entries, unlocatable } = scopeEntries({ todos: oldTodos, defs, apiNames: scope.apiNames });
  if (!entries.length) {
    const err = new Error(
      `点名的 ${scope.apiNames.length} 条成就在现有攻略里都找不到对应的 checkbox,` +
        '局部重写没有可以替换的位置。'
    );
    err.code = 'nothing-locatable';
    err.detail = { unlocatable };
    throw err;
  }

  return {
    plan, kind, oldText, baseline, scope, entries, unlocatable,
    // 花钱之前能算出来的全部。**和整篇重写的预检是两个函数**,理由见 guidebackup.js
    preflight: patchPreflight({ oldTodos, defs, entries, oldText: plan.oldText ?? '' }),
  };
}

/**
 * Dashboard 上那一排范围按钮。
 *
 * **只有算得出来的那几个。** `section:` 要挑一个小节名(界面上没地方问)、点名列表
 * 要一个成就选择器 —— 两个都属于 CLI 那边的用法。这一排是「一眼就能选、而且选完
 * 立刻知道选中几条」的那部分。
 *
 * `label` 在这里而不在前端,因为它和 `key` 必须一一对应,分两处写迟早对不上。
 */
export const PATCH_PRESETS = [
  { key: 'rare', label: '稀有' },
  // 「没写打法」而不是「写得薄」。后者是 thin content 直译过来的,中文里不这么讲 ——
  // 而且它在**评价**这条写得好不好,那是我们没资格下的判断。「打法」是这个项目
  // 自己的词(提示词里就写着「你的攻略心得」「把打法写到能照着做」),说的是
  // 那一段**在不在**,不是那一段够不够好
  { key: 'thin', label: '没写打法' },
  { key: 'locked', label: '未解锁' },
  { key: 'failing', label: '没过校验' },
];

/**
 * 每个预设各会选中几条、改完还剩几个框不动。
 *
 * **一次 plan 算完全部四个**,不是每个预设各 plan 一次:`planGuide` 要打 Steam 和
 * Notion 的接口,而选择集的解析是纯的。前端于是只花一次往返就能把四个数字都拿到,
 * 点按钮不再有延迟 —— 而"点一下等半秒才出数字"会让人以为点漏了。
 *
 * **算不出来的预设报 `unavailable`,不报 0。** 那两件事在界面上长得一样(按钮都是
 * 灰的),但它们的含义相反:0 是「这游戏没有稀有成就」,unavailable 是「Steam 这次
 * 没给解锁率」。前者不必再试,后者过会儿再试就好 —— 混成一个数字,用户永远分不清。
 *
 * @returns {{key, label, count, keeping, atRisk, savedTicks, unavailable, reason}[]}
 */
export function patchPresets({ plan, baseline, oldText = null }) {
  const { defs, oldTodos, unlocked, rarity } = plan;

  return PATCH_PRESETS.map(({ key, label }) => {
    try {
      const scope = resolveScope({
        selector: key,
        defs,
        todos: oldTodos,
        rarity,
        unlocked,
        baseline: baseline?.findings ?? [],
        text: oldText,
      });
      const { entries, unlocatable } = scopeEntries({ todos: oldTodos, defs, apiNames: scope.apiNames });
      const pre = patchPreflight({ oldTodos, defs, entries, oldText: oldText ?? '' });
      return {
        key,
        label,
        count: entries.length,
        keeping: pre.keeping,
        atRisk: pre.atRiskTicks.length,
        savedTicks: pre.savedTicks,
        // 点得到但攻略里没有框的那几条 —— 局部重写够不着,得说出来
        unlocatable: unlocatable.length,
        unavailable: false,
        reason: null,
      };
    } catch (err) {
      // 一个预设算不出来不该让整排都出不来。**把原因带上** —— 按钮上的 title
      // 就靠它,否则用户只看到一个灰按钮而不知道是没有还是没算成
      return {
        key, label, count: 0, keeping: 0, atRisk: 0, savedTicks: 0, unlocatable: 0,
        unavailable: true,
        reason: String(err.message ?? err),
      };
    }
  });
}

export async function patchGuide(db, {
  config,
  provider,
  steam,
  appid,
  notion = null,
  selector,
  instruction = null,
  fresh = false,
  rounds = PATCH_ROUNDS,
  patchPlan = null,
  onProgress = () => {},
}) {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`rounds 要是 ≥1 的整数,拿到的是 ${rounds}`);
  }

  // 允许把 planPatch 的结果传进来:CLI 要先拿它算预检、问过人之后才开跑。
  // 重新 plan 一次既多打几个接口,也留下"问的那份和改的那份不是同一份"的缝
  const pp = patchPlan ?? (await planPatch(db, { config, steam, appid, notion, selector }));
  const { plan, kind, oldText, baseline, scope, entries, unlocatable } = pp;
  const { defs, game, unlocked, oldTodos } = plan;

  onProgress({ phase: 'plan', scope: entries.length, of: defs.length, unlocatable: unlocatable.length });

  const canSearch = provider.canSearch !== false;
  const system = buildSystemPrompt(game, appid, defs, { canSearch, rarity: plan.rarity });
  const session = createSession(provider, { system, tools: provider.webTools() });
  const searchQueries = [];

  const ask = async (msg, round) => {
    const reply = await session.ask(msg, {
      onEvent: (ev) => {
        if (ev.type === 'tool') onProgress({ phase: 'tool', round, name: ev.name });
        else if (ev.type === 'search') onProgress({ phase: 'tool', round, name: `搜索「${ev.query}」` });
      },
    });
    for (const q of reply.searchQueries ?? []) if (!searchQueries.includes(q)) searchQueries.push(q);
    const verdict = checkResult(reply);
    if (!verdict.ok) {
      const err = new Error(`第 ${round} 轮没拿到可用结果:${verdict.reason}`);
      err.code = verdict.code;
      throw err;
    }
    for (const w of verdict.warnings ?? []) onProgress({ phase: 'warn', round, note: w });
    return extractMarkdown(reply.text);
  };

  /**
   * 问一轮,**空回复原样再问一次**。
   *
   * 重试的判据从 `guidegen.js` 导入(`RETRYABLE`),不在这里再写一份 —— 两份判据
   * 一定会漂,而漂的方向是"某一种失败在一条路上重试、在另一条路上不重试",
   * 那种差别没人看得见。
   *
   * **切小不适用于这条路**,尽管 `SPLITTABLE` 里也有这几种:局部重写的条目集是
   * 用户点名的,擅自只改一半是在悄悄缩小他的请求。条目太多撞了截断,该说出来
   * 让他分两次点,而不是替他决定改哪一半。
   */
  const askWithRetry = async (msg, round) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ask(msg, round);
      } catch (err) {
        if (!RETRYABLE.has(err?.code) || attempt >= 1) {
          if (SPLITTABLE.has(err?.code) && entries.length > 1) {
            err.message +=
              `\n这次点了 ${entries.length} 条,一次写不完。分两次改会好过一次 ——` +
              '这条路不会自己替你砍一半。';
          }
          throw err;
        }
        session.dropLastTurn();
        onProgress({ phase: 'retry', round, reason: err.code });
      }
    }
  };

  let round = 0;
  let found = new Map();
  let patched = oldTodos;
  let lint = baseline;
  let caused = [];
  let preExisting = [];
  let missing = [];
  let unapplied = { extra: [], unresolved: [] };

  while (round < rounds) {
    round++;
    onProgress({ phase: round === 1 ? 'write' : 'rewrite', round, of: rounds, scope: entries.length });

    const msg = round === 1
      ? buildPatchMessage(entries, { instruction, fresh })
      : buildPatchFeedback(caused, entries, missing);
    const md = await askWithRetry(msg, round);

    const parsed = parsePatchReply(md, defs);
    const wanted = new Set(entries.map((e) => e.apiName));
    // **多写的和认不出的一律不应用。** 保证来自这里:程序只贴它问的那几条。
    // 报出来是因为它们说明模型误解了请求,而那是下一轮该知道的事
    unapplied = {
      extra: [...parsed.found.keys()].filter((a) => !wanted.has(a)),
      unresolved: parsed.unresolved,
    };
    found = new Map([...parsed.found].filter(([a]) => wanted.has(a)));
    missing = entries.filter((e) => !found.has(e.apiName)).map((e) => e.apiName);

    onProgress({
      phase: 'check', round,
      wrote: found.size, of: entries.length,
      missing: missing.length, extra: unapplied.extra.length,
    });

    patched = applyPatchToTodos(oldTodos, entries, found, { kind });
    lint = lintGuide({
      todos: patched,
      defs,
      // 本地后端才有整份原文可验(标题行、节标题统计数字这几条要它)。
      // 拼出来的那份就是要落盘的那份,所以验的正是最终产物
      text: kind === 'local' ? spliceIntoText(oldText, entries, found) : null,
      unlockedApiNames: unlocked,
      kind,
    });

    const { blocking } = splitFindings(lint.findings, plan.unnameable);
    const split = classifyFindings({
      before: splitFindings(baseline.findings, plan.unnameable).blocking,
      after: blocking,
      apiNames: scope.apiNames,
    });
    caused = split.caused;
    preExisting = split.preExisting;

    onProgress({
      phase: 'lint', round,
      caused: caused.length, preExisting: preExisting.length,
    });

    // **漏写的条目必须单独判。** 它不会变成任何一条 lint 错误 —— 那条成就的旧框
    // 还老老实实待在原地,校验器看不出一点问题,`ok` 于是会是 true 而那一条根本
    // 没改。这是这条路上唯一一种「闸门全绿 + 请求没被满足」的组合,不判就是静默少改
    if (!caused.length && !missing.length) break;
    if (round >= rounds) break;

    // 模型改不动的一律当场停。**和整篇那条路同一条规矩**:一条 checked-mismatch
    // 落到这里说明是我们自己的打勾或拼接出了问题,让模型去改只会让它开始瞎写 `- [x]`。
    // 漏写不在此列 —— 那个模型改得动,再问一遍就是
    if (caused.length && !caused.some((f) => MODEL_FIXABLE.has(f.code))) {
      throw new Error(
        '这次改动没过校验,而且没有一条是模型能改的(多半是拼接本身出了问题)。' +
          '原攻略一个字都没动,先看这几条:\n  ' + caused.map((f) => f.message).join('\n  ')
      );
    }
  }

  const ok = caused.length === 0 && missing.length === 0;

  // ---- 落地。**先备份,备份失败就一个字都不写** ----
  let backup = null;
  let landed = null;
  if (ok) {
    onProgress({ phase: 'backup' });
    backup = await backupGuide(config, { guide: plan.existing, appid, notion });
    onProgress({ phase: 'backup-done', path: backup.path, bytes: backup.bytes });

    landed = kind === 'local'
      ? landPatchLocal(db, { config, plan, defs, unlocked, oldText, entries, found })
      : await landPatchNotion({ notion, plan, defs, unlocked, entries, found, patched, onProgress });
    onProgress({ phase: 'landed', target: kind, url: plan.existing.url });
  }

  return {
    ok,
    game,
    appid: String(appid),
    target: kind,
    url: plan.existing.url,
    selector,
    instruction,
    // 点了几条、改了几条、点了但攻略里找不到的几条。**三个数都要交出去** ——
    // "改了 4 条"和"点了 5 条改了 4 条"是完全不同的两句话
    scope: scope.apiNames,
    rewrote: [...found.keys()],
    unlocatable,
    missing,
    unapplied,
    researched: canSearch,
    searchQueries,
    rounds: round,
    lint,
    // 这次改坏的 / 本来就坏的。**后者必须报出来**:不拦不等于不说,那条规矩是
    // ambiguous-empty-description 那次付过学费的
    blocking: caused,
    preExisting,
    expected: splitFindings(lint.findings, plan.unnameable).expected,
    usage: addUsage(emptyUsage(), session.usage),
    model: provider.model,
    backup: backup ? { path: backup.path, bytes: backup.bytes, count: backup.count } : null,
    landed,
  };
}

/** 把改好的几条拼进整份原文。纯字符串运算,拼接位置全部来自 `todoSpans` */
export function spliceIntoText(oldText, entries, found) {
  const spans = todoSpans(oldText);
  const lines = oldText.split(/\r?\n/);
  const edits = [];
  for (const e of entries) {
    const block = found.get(e.apiName);
    if (!block) continue;
    const span = spans.get(e.key);
    // 定位不到就跳过,不猜。旧攻略读出来的 key 就是行号,理论上一定在 spans 里 ——
    // 留这一手是因为"理论上"在这个项目里已经错过好几次了
    if (!span) continue;
    const delta = indentOf(lines[span.start]) - indentOf(block[0]);
    edits.push({ start: span.start, end: span.end, lines: reindent(block, delta) });
  }
  return spliceLines(oldText, edits);
}

/**
 * 本地落地:拼好 → 写草稿 → 机械打勾 → **回读再验一次** → 覆盖原文件 → 重新登记。
 *
 * 草稿先落 `guides/.drafts/` 再拷过去,而不是直接写目标文件。多一次读写换的是
 * 一件具体的事:`applyChecks` 和最后那次校验都对着**要落地的那份**做,而中途
 * 任何一步失败时,用户的攻略还是原来那个字节。
 */
function landPatchLocal(db, { config, plan, defs, unlocked, oldText, entries, found }) {
  const finalPath = resolveGuidePath(config.guidesDir, plan.existing.url);
  const draftPath = plan.draftPath;
  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });

  writeFileSync(draftPath, spliceIntoText(oldText, entries, found));
  const keys = computeCheckedKeys({ todos: loadTodos(draftPath), defs, unlockedApiNames: unlocked });
  applyChecks(draftPath, keys);

  const text = readFileSync(draftPath, 'utf8');
  writeFileSync(finalPath, text);
  rmSync(draftPath, { force: true });

  /**
   * **落盘之后重新读一遍再验一次** —— 和 `generateGuide` 落本地那条路同一条规矩。
   *
   * 「调用成功 ≠ 内容正确」是这个项目栽过的跟头,而局部重写有它自己的版本:上面那次
   * 校验验的是**内存里拼出来的 todo 列表**,这次验的是**磁盘上真实的那个文件**。
   * 两者之间隔着一次 splice、一次打勾写回和一次拷贝,中间任何一步把行弄错了,
   * 前面那次校验都看不见。多一次读的钱换一次真确认。
   *
   * 只对**这次改的那几条**较真:攻略别处的老问题这次没碰,拿它们来抛错会把
   * 「写对了」说成「写坏了」。判据和回读 Notion 那条路一模一样
   */
  const after = lintGuide({
    todos: loadTodos(finalPath),
    defs,
    text: readFileSync(finalPath, 'utf8'),
    unlockedApiNames: unlocked,
    kind: 'local',
  });
  const mine = new Set(entries.map((e) => e.apiName));
  const bad = splitFindings(after.findings, plan.unnameable).blocking.filter(
    (f) => f.apiName && mine.has(f.apiName)
  );
  if (bad.length) {
    throw new Error(
      `落盘后重新校验又出问题了(${finalPath}):` + bad.map((f) => f.message).join('; ')
    );
  }

  // 登记走真发现逻辑,不自己 upsert —— 和 generateGuide 同一条规矩,省得两处对
  // "标题怎么取"慢慢跑偏。局部重写通常不会改标题,但 `--only section:` 之后
  // 谁也不敢保证
  syncGuidesFromMarkdown(db, config);
  return { kind: 'local', path: finalPath, ticked: keys.length, lint: after };
}

/**
 * Notion 落地:**逐块改**,不删整页。
 *
 * 一条成就 = 一个 to_do 块 + 它的子块。所以改一条是:PATCH 那个块的正文、
 * 把它的子块整批换掉。块 id 保住,页面上别的东西(图片、嵌入、手做的表格、
 * 转换器覆盖不到的一切)一个字都不动 —— 而那正是这个功能存在的理由。
 *
 * 写完**回读整页重新校验**,和 `finishNotionLanding` 同一条规矩:这个项目栽过
 * 「调用成功 ≠ 内容正确」的跟头,markdown→block 的转换、嵌套层级、渲染,每一步
 * 都可能在不报错的情况下产出别的东西。
 */
async function landPatchNotion({ notion, plan, defs, unlocked, entries, found, patched, onProgress }) {
  const pageId = extractNotionPageId(plan.existing.url);

  // 勾选状态按**改完之后的整份**算,和本地那条路同一个函数。合成 key 的那些
  // (新子步骤)拿不到 block id,所以它们的勾选状态在 append 的时候就写进 payload
  const wantChecked = new Set(computeCheckedKeys({ todos: patched, defs, unlockedApiNames: unlocked }));

  let changed = 0;
  for (const e of entries) {
    const block = found.get(e.apiName);
    if (!block) continue;

    const { blocks } = markdownToBlocks(block.join('\n'));
    const top = blocks.find((b) => b.type === 'to_do');
    if (!top) {
      // 交回来的东西转不出一个 to_do —— 闸门本该拦住这种(那条成就会报 missing-checkbox),
      // 到这里还有就是我们自己的 bug,停下比写坏一页强
      throw new Error(`《${plan.game}》的「${e.apiName}」转不出 checkbox 块,已停止,页面未改动的部分保持原样`);
    }

    onProgress({ phase: 'notion-patch', name: e.def?.name_cn || e.def?.name_en || e.apiName });
    // **rich_text 直接传过去,不压成字符串再转一次。** 那次往返会把 `**粗体**`
    // 和 `<br>` 一起丢掉,而且回读校验发现不了 —— 见 notion.js 里那段注释
    await notion.setTodoRichText(e.key, top.to_do.rich_text, { checked: wantChecked.has(e.key) });
    await notion.replaceTodoChildren(
      e.key,
      e.subTodos.map((s) => s.key),
      top.to_do.children ?? []
    );
    changed++;
  }

  onProgress({ phase: 'notion-verify', url: plan.existing.url });
  const todos = await notion.fetchAllToDoBlocks(pageId);
  const after = lintGuide({ todos, defs, unlockedApiNames: unlocked, kind: 'notion' });
  const recheck = splitFindings(after.findings, plan.unnameable);
  const still = classifyFindings({
    before: [],
    after: recheck.blocking,
    apiNames: entries.map((e) => e.apiName),
  });
  // 回读只对**这次改的那几条**较真:页面上别处的老问题这次没碰,拿它们来报错
  // 会把"写对了"说成"写坏了"
  const mine = new Set(entries.map((e) => e.apiName));
  const bad = still.caused.filter((f) => f.apiName && mine.has(f.apiName));
  if (bad.length) {
    throw new Error(
      `写进 Notion 之后回读校验又出问题了(${plan.existing.url}):` +
        bad.map((f) => f.message).join('; ')
    );
  }

  return { kind: 'notion', url: plan.existing.url, changed, lint: after };
}
