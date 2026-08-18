/**
 * 局部重写 —— 选择集、条目定位、错误归属
 * ------------------------------------------------
 * 「重写整篇」和「只重写点名的那几条」共用一条流水线,区别全部收在这个文件里:
 * **哪几条要改**(resolveScope)、**它们在攻略里是哪几个框**(scopeEntries)、
 * **改完之后新出的问题里哪些该怪这次改动**(classifyFindings)。
 *
 * 这个文件**没有 I/O、不认识供应商、不碰后端**。理由不是洁癖:局部重写唯一真正
 * 危险的地方是"贴回去的位置对不对",而那件事必须能在没有网络、没有 key、没有
 * Notion 的情况下逐条测。编排在 lib/guidepatch.js。
 *
 * ## 一条贯穿全文的取舍
 *
 * **宁可少改一条,绝不多改一条。**
 *
 * 整篇重写的失败方式是"写差了",而局部重写多了一种更坏的:**在用户没点名的地方
 * 动了字**。后者没有任何机器能事后发现 —— 攻略看起来是完整的,只是某一段变成了
 * 模型这次的即兴发挥,而那一段可能是用户自己手改过的。所以凡是拿不准的:
 * 定位不到就报出来(不猜)、区间够不着就留在原地(不扩)、旧的问题不算这次的账
 * (不拦)。三条都是同一个方向。
 */

import { stripGuideEcho, mapAchievementGuides, normalizeText } from './guides.js';

/**
 * 「稀有」的默认线:全球解锁率 15% 以下。
 *
 * 和提示词里 `rarityTag` 的分档对齐(🔴 <5% / 🟠 <15%),**刻意共用同一条线**:
 * 提示词说「🔴🟠 这几条是攻略真正的价值所在」,那么「只重写值钱的那几条」就该
 * 正好选中同一批。两处各定一个阈值,用户读到的分档和实际选中的集合就会错开。
 */
export const RARE_PCT = 15;

/**
 * 「写得太薄」的默认线:去掉成就名和官方描述之后,剩下的打法不足 40 个字。
 *
 * 40 是拍的,但拍在一个有意义的位置上:中文一句完整的话大约 15–25 字,40 字以下
 * 基本等于"只抄了官方文案,再补半句废话"。CLAUDE.md 记着实测的每条字数是
 * low 档 211、high 档 306(**含**名字和描述),所以这条线离正常水位很远 ——
 * 它选的是明确没写东西的那批,不是"写得短"的那批。
 *
 * 判据里最容易写错的一步是**怎么把名字和描述剥掉**:直接按字数截、或者按 `<br>`
 * 取第三段,都会在模型少写一个 `<br>` 的时候把打法当成描述扔掉。所以这里复用
 * `stripGuideEcho` —— 它只删"整行恰好是名字/恰好是描述原文"的开头几行,是这个
 * 项目为 Dashboard 卡片调准过的同一套判据。
 */
export const THIN_CHARS = 40;

/** `<br>` 是块内换行(见 notionblocks.js)。本地 md 里它是字面文本,Notion 那边是真换行 */
const BR_RE = /<br\s*\/?>/gi;

/**
 * 一条成就在攻略里**属于用户的那部分**:去掉成就名和官方描述的复述之后剩下的字。
 *
 * 两个后端的同一条成就长得不一样(md 里是 `<br>`,Notion 里是真换行),所以先统一
 * 成换行再交给 `stripGuideEcho` —— 那个函数是按行判断的,不先换就一行都认不出来。
 */
export function guideProse(todoText, def) {
  const asLines = String(todoText ?? '').replace(BR_RE, '\n');
  return stripGuideEcho(asLines, {
    names: [def?.name_cn, def?.name_en].filter(Boolean),
    description: def?.description ?? '',
  }).trim();
}

/** 选择器的名字。显式成就列表不在这里 —— 那是"不是这些名字里任何一个"的兜底分支 */
export const SELECTOR_KINDS = new Set(['all', 'rare', 'thin', 'locked', 'unlocked', 'failing', 'section']);

/** 哪些 lint code 算"这条成就写得不对,重写能修" —— `failing` 选择器用它挑人 */
const FAILING_CODES = new Set([
  'missing-checkbox',
  'merged-line',
  'ambiguous-no-description',
  'paraphrased-description',
]);

/**
 * 把用户说的话解析成一组 api_name。
 *
 * **返回值里 `unresolved` 和 `apiNames` 一样重要。** 一个认不出来的名字必须被报出来,
 * 不能静静地从集合里消失 —— 用户点了五条、程序改了四条、报告说"改完了",是这个
 * 功能最坏的失败方式,因为他要等到下次读攻略才发现那一条没动。
 *
 * @param {object}   o
 * @param {string}   o.selector  'all' | 'rare[:pct]' | 'thin[:chars]' | 'locked' |
 *                               'unlocked' | 'failing' | 'section:名字' | 逗号分隔的成就名/api_name
 * @param {Array}    o.defs
 * @param {Array}    o.todos     现有攻略的 checkbox(两种后端同一形状)
 * @param {Map|null} [o.rarity]  api_name → 全球解锁率
 * @param {Set}      [o.unlocked]
 * @param {Array}    [o.baseline] 改之前对旧攻略跑的那次 lint 的 findings
 * @param {string|null} [o.text] 攻略全文。只有本地后端给得出,`section:` 需要它
 * @returns {{apiNames: string[], unresolved: string[], kind: string, arg: string|null}}
 */
export function resolveScope({
  selector,
  defs,
  todos,
  rarity = null,
  unlocked = new Set(),
  baseline = [],
  text = null,
}) {
  const raw = String(selector ?? '').trim();
  if (!raw) {
    const err = new Error('没说要重写哪些成就。');
    err.code = 'empty-scope';
    throw err;
  }

  const [head, ...restArg] = raw.split(':');
  const kind = head.trim().toLowerCase();
  const arg = restArg.length ? restArg.join(':').trim() : null;
  const inDefsOrder = (set) => defs.filter((d) => set.has(d.api_name)).map((d) => d.api_name);

  if (SELECTOR_KINDS.has(kind)) {
    // 算出来的选择器一条都不会 unresolved —— 它们是对着 defs 和攻略本身筛的,
    // 筛不到就是"没有符合条件的成就",那是空集合而不是认不出的名字
    const picked = new Set();
    const byApiName = mapAchievementGuides(todos, defs);

    if (kind === 'all') {
      for (const d of defs) picked.add(d.api_name);
    } else if (kind === 'rare') {
      const pct = arg === null ? RARE_PCT : Number(arg);
      if (!Number.isFinite(pct)) {
        const err = new Error(`rare: 后面要跟一个百分比数字,拿到的是「${arg}」`);
        err.code = 'bad-scope';
        throw err;
      }
      // 拿不到解锁率就**报错而不是选空集**:`--only rare` 静静地什么都不选,
      // 看起来和"这游戏没有难成就"一模一样,而真相是 Steam 那次没答话
      if (!rarity || rarity.size === 0) {
        const err = new Error('Steam 没给出全球解锁率,这次没法按稀有度挑成就。');
        err.code = 'no-rarity';
        throw err;
      }
      for (const d of defs) {
        const p = rarity.get(d.api_name);
        if (p !== undefined && p !== null && p < pct) picked.add(d.api_name);
      }
    } else if (kind === 'thin') {
      const limit = arg === null ? THIN_CHARS : Number(arg);
      if (!Number.isFinite(limit)) {
        const err = new Error(`thin: 后面要跟一个字数,拿到的是「${arg}」`);
        err.code = 'bad-scope';
        throw err;
      }
      for (const d of defs) {
        const entry = byApiName.get(d.api_name);
        // 攻略里定位不到的成就不算"写得薄" —— 它是**根本没写**,那是缺 checkbox,
        // 归 `failing` 管。混进来的话 `--only thin` 在一份半成品攻略上会选中全部
        if (!entry) continue;
        if (guideProse(entry.text, d).length < limit) picked.add(d.api_name);
      }
    } else if (kind === 'locked' || kind === 'unlocked') {
      const want = kind === 'unlocked';
      for (const d of defs) if (unlocked.has(d.api_name) === want) picked.add(d.api_name);
    } else if (kind === 'failing') {
      for (const f of baseline) {
        if (f.apiName && FAILING_CODES.has(f.code)) picked.add(f.apiName);
      }
    } else if (kind === 'section') {
      if (!arg) {
        const err = new Error('section: 后面要跟小节标题。');
        err.code = 'bad-scope';
        throw err;
      }
      if (text === null) {
        // Notion 那边我们只拿得到 checkbox,拿不到整页原文,所以"这条属于哪个小节"
        // 无从判断。**说出来比选个空集强** —— 后者看着像这一节没有成就
        const err = new Error('按小节挑成就需要攻略全文,Notion 上的攻略读不到小节结构。');
        err.code = 'section-needs-local';
        throw err;
      }
      for (const apiName of sectionApiNames(text, arg, todos, defs)) picked.add(apiName);
    }

    return { apiNames: inDefsOrder(picked), unresolved: [], kind, arg };
  }

  // 显式列表:api_name 或成就名(中文/英文都行)。**逗号和中文逗号都认** ——
  // 名字是从 Dashboard 或 Steam 上抄下来的,输入法给什么就是什么
  const wanted = raw.split(/[,,]/).map((s) => s.trim()).filter(Boolean);
  const byApi = new Map(defs.map((d) => [d.api_name, d]));
  const byName = new Map();
  for (const d of defs) {
    for (const n of [d.name_cn, d.name_en]) {
      const k = normalizeText(n);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(d.api_name);
    }
  }

  const picked = new Set();
  const unresolved = [];
  for (const w of wanted) {
    if (byApi.has(w)) {
      picked.add(w);
      continue;
    }
    const hit = byName.get(normalizeText(w));
    // **同名成就按名字点不动。** 库里真有同名的成就(见 CLAUDE.md 的同名一节),
    // 猜一个等于把 A 的打法写到 B 头上。要点它就用 api_name —— 那个一定唯一
    if (hit?.size === 1) picked.add([...hit][0]);
    else unresolved.push(w);
  }

  return { apiNames: inDefsOrder(picked), unresolved, kind: 'list', arg: null };
}

/**
 * 某个 `##` 小节标题底下的成就有哪些。
 *
 * 判据是行号:小节标题那一行之后、下一个**同级或更高级**标题之前的所有 checkbox。
 * 标题匹配用 `normalizeText` 之后相等 —— 用户敲的是「主线」,攻略里写的可能是
 * `## 主线剧情`,那两个不是一回事,不该悄悄放行。
 */
function sectionApiNames(text, wanted, todos, defs) {
  const lines = String(text).split(/\r?\n/);
  const target = normalizeText(wanted);
  let level = 0;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    if (start === -1) {
      if (normalizeText(m[2]) === target) {
        level = m[1].length;
        start = i;
      }
      continue;
    }
    if (m[1].length <= level) {
      end = i;
      break;
    }
  }
  if (start === -1) return [];

  const keys = new Set(todos.filter((t) => t.key > start && t.key < end).map((t) => t.key));
  const out = [];
  for (const [apiName, entry] of mapAchievementGuides(todos, defs)) {
    if (keys.has(entry.key)) out.push(apiName);
  }
  return out;
}

/**
 * 点名的这些成就在攻略里各是哪个框,以及挂在它下面的子步骤(**带 key**)。
 *
 * 归属走 `mapAchievementGuides` → `resolveTodoToAchievement`,和打勾、审计、
 * Dashboard 卡片用的是同一个函数。**这里绝不能放松它**:那个函数还担着往用户笔记里
 * 写勾的活,为了"这次只是重写"松一次,是两边一起松。定位不到就进 `unlocatable`。
 *
 * 子步骤自己重新走一遍 `parent` 链而不是用 `mapAchievementGuides` 给的 `subSteps`,
 * 只为一件事:**要 key**。那个字段是给前端显示用的,把 key 丢掉了,而 Notion 后端
 * 删子块必须有 block id。
 *
 * @returns {{entries: object[], unlocatable: string[]}}
 */
export function scopeEntries({ todos, defs, apiNames }) {
  const byApiName = mapAchievementGuides(todos, defs);
  const byDef = new Map(defs.map((d) => [d.api_name, d]));

  const childrenOf = new Map();
  for (const t of todos) {
    if (t.parent === null || t.parent === undefined) continue;
    if (!childrenOf.has(t.parent)) childrenOf.set(t.parent, []);
    childrenOf.get(t.parent).push(t);
  }
  const descendants = (key, out = []) => {
    for (const c of childrenOf.get(key) ?? []) {
      out.push(c);
      descendants(c.key, out);
    }
    return out;
  };

  const entries = [];
  const unlocatable = [];
  // defs 的顺序就是提示词里的编号顺序,这里跟着它 —— 交给模型的清单和贴回去的
  // 顺序是同一个顺序,才谈得上"第 3 条对应第 3 条"
  for (const d of defs) {
    if (!apiNames.includes(d.api_name)) continue;
    const entry = byApiName.get(d.api_name);
    if (!entry) {
      unlocatable.push(d.api_name);
      continue;
    }
    entries.push({
      apiName: d.api_name,
      def: byDef.get(d.api_name),
      key: entry.key,
      text: entry.text,
      checked: entry.checked,
      subTodos: descendants(entry.key),
    });
  }
  return { entries, unlocatable };
}

/** 一条 finding 的身份。`key` 不能用 —— 拼接之后行号会变,而它指的还是同一个问题 */
const findingId = (f) => `${f.code} ${f.apiName ?? f.message ?? ''}`;

/**
 * 改完之后的问题,哪些该怪这次改动。
 *
 * **这是局部重写唯一真正新增的失败方式,也是必须显式处理的那一个。**
 *
 * 旧攻略本来就可能不过校验 —— 手写的那些尤其(CLAUDE.md 记着 330 个成就在语料里
 * 压根没有能匹配的 checkbox)。整篇重写时这不是问题:整篇都重写了,所有错都归它。
 * 局部重写不行:用户点名改 3 条,而第 40 条早就缺描述 —— 拿那条去拦,等于用一个
 * 他没要求、也没授权我们去改的问题,把一次做对了的改动整个丢掉,而错误消息还会
 * 写着"校验没过",让人以为是这次改坏了。
 *
 * 归属判据两条,满足任一就算这次的账(`caused`):
 *
 * 1. **落在选择集里** —— 这几条正是我们刚重写的,它们身上的问题当然算。
 * 2. **改之前没有** —— 新长出来的问题,不管落在谁头上,都是这次拼接的后果
 *    (比如新写的条目和别处重了,或者拼接把某行弄成了合并行)。
 *
 * 剩下的是 `preExisting`:**报出来,不拦路。** 「不拦」绝不等于「不说」—— 这条规矩
 * 在这个项目里是 `ambiguous-empty-description` 那次付过学费的:15 个永远不会自己
 * 勾上的框如果只是静静地不拦,用户是几个月后才发现,而且会当成同步坏了。
 */
export function classifyFindings({ before = [], after = [], apiNames = [] }) {
  const inScope = new Set(apiNames);
  const had = new Set(before.map(findingId));
  const caused = [];
  const preExisting = [];
  for (const f of after) {
    if ((f.apiName && inScope.has(f.apiName)) || !had.has(findingId(f))) caused.push(f);
    else preExisting.push(f);
  }
  return { caused, preExisting };
}
