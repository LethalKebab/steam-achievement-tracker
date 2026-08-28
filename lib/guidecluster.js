/**
 * 同类成就的识别与归并。
 *
 * **解决的是哪个问题。** 分类那一趟(`buildRegroupPrompt`)拿到的是一份封闭小节名单,
 * 那挡得住"自创标题",挡不住**名单里有两个都说得通的去处时二选一**。实测《马特的寻猫
 * 游戏》四条「替换吉祥物」成就:两条进了「宝石与商店」(因为在商店买),两条进了
 * 「吉祥物替换」。模型不是搞错了,它真心认为"商店买的"和"彩蛋解锁的"是两类事 ——
 * 这是个**说得通但错**的编辑判断,加提示词纠不过来,得有个程序判据。
 *
 * **判据:官方描述的公共前缀。** 成就名常是梗(「海拉鲁老流氓」=打碎罐子),描述不是,
 * 它是暴雪/开发者按同一个模板批量写出来的 ——「替换<X>吉祥物」「扩建<X>」
 * 「成为新手<X>」。前缀够长就说明是同一批模板产物,也就是同一类事。
 *
 * **为什么不能只看前缀长度。** Terraria 有 22 条「Defeat …」,泰拉的前期 boss 和肉后
 * boss 本来就该分开。所以要求前缀**占描述均长的一半以上** —— "Defeat " 占不到,
 * 「替换吉祥物」占得到。这一条把噪音从 115 簇/60 款压到个位数量级。
 */

/** 比较前先归一:空白和常见标点不参与,它们在批量描述里最不稳定 */
const flat = (s) => String(s ?? '').replace(/[\s　]+/g, '').trim();

/** 两个串的公共前缀 */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** 前缀至少这么长才考虑。再短的公共开头("Do"、「获得」)哪个游戏都能凑出一堆 */
const MIN_PREFIX = 4;
/** 前缀要占到描述均长的这个比例。**这一条是噪音和信号的分界线**,见文件头 */
const MIN_RATIO = 0.5;
/** 簇的大小上下界。2 条不成类;太大的多半是「Defeat …」那种跨越整个游戏的动词 */
const MIN_SIZE = 3;
const MAX_SIZE = 8;
/** 一簇最多占全部成就的这个比例 —— 小游戏里 8 条可能是半份攻略,强并会把结构压塌 */
const MAX_SHARE = 0.25;

/**
 * 找出「描述明显同模板」的成就簇。
 *
 * 两趟。第一趟从长前缀往短前缀扫,**先成簇的先占位**:这样 3 条「替换吉祥物」不会被
 * 更短的「替换」把不相干的东西也吸进来。第二趟把差一两个字的近亲吸附进已有的簇 ——
 * 那一趟不是锦上添花,理由见它自己的注释。
 *
 * @param {{api_name:string, description?:string}[]} defs
 * @returns {{prefix:string, apiNames:string[]}[]} 按簇内第一条的出现顺序排
 */
export function sameKindClusters(defs) {
  const list = (defs ?? []).filter((d) => d?.api_name && flat(d.description).length >= MIN_PREFIX);
  if (list.length < MIN_SIZE) return [];

  const maxSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor((defs?.length ?? 0) * MAX_SHARE)));
  if (maxSize < MIN_SIZE) return [];

  const idx = new Map(list.map((d, i) => [d.api_name, i]));
  const desc = new Map(list.map((d) => [d.api_name, flat(d.description)]));
  const claimed = new Set();
  const out = [];

  // ---- 第一趟:严格成簇。从长前缀往短扫,先成簇的先占位 ----------------------
  // 不给 L 设上限:封顶的话,长描述里那些真的共享一大段模板的成就会因为
  // 「前缀占比不足」被整批漏掉,而循环本身是 O(最长描述 x 成就数),量级可以忽略
  const longest = Math.max(...list.map((d) => desc.get(d.api_name).length));
  for (let L = longest; L >= MIN_PREFIX; L--) {
    const groups = new Map();
    for (const d of list) {
      if (claimed.has(d.api_name)) continue;
      const t = desc.get(d.api_name);
      if (t.length < L) continue;
      const k = t.slice(0, L);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    for (const [prefix, members] of groups) {
      if (members.length < MIN_SIZE || members.length > maxSize) continue;
      const mean = members.reduce((s, d) => s + desc.get(d.api_name).length, 0) / members.length;
      if (L / mean < MIN_RATIO) continue;
      for (const d of members) claimed.add(d.api_name);
      out.push({ prefix, apiNames: members.map((d) => d.api_name) });
    }
  }

  /**
   * ---- 第二趟:把差一两个字的近亲吸附进来 ----------------------------------
   *
   * **实测踩过。**《马特的寻猫游戏》四条替换吉祥物的成就,三条写的是「将吉祥物替换**为**
   * 一只/一位…」,第四条写的是「将吉祥物替换**成**一条狗」。长前缀「将吉祥物替换为一」
   * 先把三条占走,剩下那条落单 —— 而它正是这次被劈到别的小节去的那条。差一个字就漏掉,
   * 等于这个检查在最需要它的那次没起作用。
   *
   * 吸附**只能加入已经成立的簇,不能造簇**:严格那一趟已经证明了这批描述同模板,
   * 这里放宽的只是"离模板多远还算同一批"。所以门槛按簇前缀的一半算,不是绝对值 ——
   * 前缀越长的簇,越有资格认亲。
   */
  for (const c of out) {
    if (c.apiNames.length >= maxSize) continue;
    const need = Math.max(MIN_PREFIX, Math.ceil(c.prefix.length / 2));
    for (const d of list) {
      if (claimed.has(d.api_name)) continue;
      if (c.apiNames.length >= maxSize) break;
      if (commonPrefix(desc.get(d.api_name), c.prefix).length < need) continue;
      claimed.add(d.api_name);
      c.apiNames.push(d.api_name);
    }
    c.apiNames.sort((a, b) => idx.get(a) - idx.get(b));
  }

  out.sort((a, b) => idx.get(a.apiNames[0]) - idx.get(b.apiNames[0]));
  return out;
}

/**
 * 把被劈到多个小节的同类簇**并回一处**,落点取簇内人数最多的那个小节。
 *
 * **为什么敢直接改模型给的映射。** 误并的代价和误劈不对等:把「扩建房间/卧室/客厅/
 * 卫生间」凑到一个小节里,读起来至多是"分得粗了一点";把它们劈到两个小节,读起来
 * 就是这次用户报的那个 bug。而且这个函数只在**簇已经被劈开**时才动手 —— 模型自己
 * 把一簇放在一起时它什么都不做。
 *
 * 平票时取**小节名单里靠前**的那个(不是随机、也不是第一条成就的小节):`sections`
 * 是模型给的顺序,靠前的通常是主线/更一般的那个,把细分类并进大类比反过来安全。
 *
 * @param {Map<string,string>} assignment 成就 api_name → 小节标题
 * @param {{prefix:string, apiNames:string[]}[]} clusters
 * @param {string[]} [sections] 小节顺序,用来打破平票
 * @returns {{assignment:Map<string,string>, merges:{prefix:string,into:string,from:string[],moved:number}[]}}
 */
export function mergeSplitClusters(assignment, clusters, sections = []) {
  const next = new Map(assignment ?? []);
  const merges = [];
  const rank = new Map(sections.map((s, i) => [s, i]));

  for (const c of clusters ?? []) {
    const tally = new Map();
    for (const api of c.apiNames) {
      const sec = next.get(api);
      if (sec) tally.set(sec, (tally.get(sec) ?? 0) + 1);
    }
    // 一个小节(没劈)、或者一个都没分到(模型漏了整簇)—— 两种都不该动
    if (tally.size < 2) continue;

    const into = [...tally].sort((a, b) => (
      b[1] - a[1] || (rank.get(a[0]) ?? Infinity) - (rank.get(b[0]) ?? Infinity)
    ))[0][0];
    const from = [...tally.keys()].filter((s) => s !== into);
    let moved = 0;
    for (const api of c.apiNames) {
      // **漏分的成就跟着簇走。** 它本来会"留在原来的小节"(regroupByAssignment 的兜底),
      // 而我们刚认定这一簇是同一类事 —— 让它落单反而是新造一次劈分
      if (next.get(api) !== into) moved++;
      next.set(api, into);
    }
    merges.push({ prefix: c.prefix, into, from, moved });
  }
  return { assignment: next, merges };
}

/**
 * 给提示词用的一段约束:把识别出的簇明说给模型。
 *
 * 程序归并已经能兜底了,为什么还要说一遍:**模型选得比 plurality 准**。它看得见正文,
 * 知道这一簇更该跟哪个小节;plurality 只会数人头。说了它照做,这一趟就不用兜底;
 * 不照做,`mergeSplitClusters` 再来收拾。
 */
export function clusterConstraint(defs, clusters) {
  if (!clusters?.length) return '';
  const nameOf = new Map((defs ?? []).map((d, i) => [d.api_name, `${i + 1}`]));
  const lines = clusters.map((c) => `  - ${c.apiNames.map((a) => nameOf.get(a) ?? '?').join(' ')}`);
  return (
    '\n- **下面每一组的官方描述是同一个模板写出来的,是同一类事,必须整组放进同一个小节**' +
    '(组内编号不许拆开):\n' + lines.join('\n') + '\n'
  );
}
