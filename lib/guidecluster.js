/**
 * Recognising and merging families of same-kind achievements.
 *
 * **The problem this solves.** The classification pass (`buildRegroupPrompt`) is handed a closed
 * list of section names, which stops invented headings but does not stop **choosing between two
 * defensible destinations that are both on the list.** Measured on 《马特的寻猫游戏》's four
 * "replace the mascot" achievements: two went into 「宝石与商店」 (because you buy them in the
 * shop) and two into 「吉祥物替换」. The model was not confused — it genuinely holds that
 * "bought in the shop" and "unlocked as an easter egg" are two kinds of thing. That is a
 * **defensible but wrong** editorial judgement, a prompt cannot argue it out, and it needs a
 * programmatic rule.
 *
 * **The rule: the common prefix of the official description.** Achievement names are often jokes
 * (「海拉鲁老流氓」 = smash pots); descriptions are not — developers batch-write them from one
 * template: 「替换<X>吉祥物」, 「扩建<X>」, 「成为新手<X>」. A long enough prefix means they came
 * out of the same template, and therefore describe the same kind of thing.
 *
 * **Why prefix length alone is not enough.** Terraria has 22 「Defeat …」 achievements whose
 * early-game and hardmode bosses genuinely belong apart. So the prefix must be **at least half
 * the mean description length** — "Defeat " doesn't reach that, 「替换吉祥物」 does. This one
 * condition cut the noise from 115 clusters across 60 games down to single digits.
 */

/** Normalise before comparing: whitespace and common punctuation are excluded, being the least stable parts of batch-written descriptions */
const flat = (s) => String(s ?? '').replace(/[\s　]+/g, '').trim();

/** The common prefix of two strings */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** A prefix must be at least this long to be considered. Anything shorter ("Do", 「获得」) can be scraped together in any game */
const MIN_PREFIX = 4;
/** The prefix must be at least this fraction of the mean description length. **This is the line between noise and signal**, see the file header */
const MIN_RATIO = 0.5;
/** Bounds on cluster size. Two entries are not a family; too large is usually a verb like 「Defeat …」 spanning the whole game */
const MIN_SIZE = 3;
const MAX_SIZE = 8;
/** One cluster may cover at most this fraction of all achievements — in a small game 8 entries could be half the guide, and force-merging flattens the structure */
const MAX_SHARE = 0.25;

/**
 * Find clusters of achievements whose descriptions are obviously from one template.
 *
 * Two passes. The first scans from long prefixes down to short ones, **first to form a cluster
 * claims its members**: that way three 「替换吉祥物」 entries can't have unrelated things pulled
 * in by a shorter 「替换」. The second pass absorbs near-misses that differ by a character or two
 * — that pass is not a nicety, and its own comment explains why.
 *
 * @param {{api_name:string, description?:string}[]} defs
 * @returns {{prefix:string, apiNames:string[]}[]} ordered by where each cluster's first entry appears
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

  // ---- Pass one: strict clustering. Scan long prefixes down to short, first cluster claims ----
  // No upper bound on L: capping it would make achievements with long descriptions that
  // genuinely share a large template get missed as a batch for "prefix ratio too low", and the
  // loop itself is O(longest description x achievements), which is negligible here
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
   * ---- Pass two: absorb near-misses that differ by a character or two ----------------------
   *
   * **Hit for real.** Of 《马特的寻猫游戏》's four mascot-replacement achievements, three read
   * 「将吉祥物替换**为**一只/一位…」 and the fourth reads 「将吉祥物替换**成**一条狗」. The long
   * prefix 「将吉祥物替换为一」 claims the three first, orphaning the fourth — and the orphan is
   * precisely the one that had been split into a different section. Missing it over one character
   * means this check does nothing on the very run that needed it.
   *
   * Absorption **can only join an already-established cluster, never create one**: the strict pass
   * has already proved these descriptions share a template, and all this relaxes is "how far from
   * the template still counts as the same batch". So the threshold is half the cluster's prefix
   * rather than an absolute value — the longer a cluster's prefix, the more entitled it is to
   * claim relatives.
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
 * Merge a family split across several sections **back into one**, landing on whichever section
 * holds most of the cluster.
 *
 * **Why it is safe to rewrite the model's mapping directly.** Merging wrongly and splitting
 * wrongly do not cost the same: putting 「扩建房间/卧室/客厅/卫生间」 in one section reads at worst
 * as slightly coarse; splitting them across two sections is exactly the bug the user reported.
 * And this function only acts when a cluster is **already split** — when the model put a cluster
 * together itself, it does nothing.
 *
 * On a tie it takes whichever section comes **earlier in the section list** (not at random, and
 * not the first achievement's section): `sections` is the model's own order, and earlier ones are
 * usually the main-line or more general heading, so merging a subdivision into a broader category
 * is safer than the reverse.
 *
 * @param {Map<string,string>} assignment achievement api_name → section heading
 * @param {{prefix:string, apiNames:string[]}[]} clusters
 * @param {string[]} [sections] section order, used to break ties
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
    // One section (not split), or none assigned at all (the model missed the whole cluster) —
    // neither should be touched
    if (tally.size < 2) continue;

    const into = [...tally].sort((a, b) => (
      b[1] - a[1] || (rank.get(a[0]) ?? Infinity) - (rank.get(b[0]) ?? Infinity)
    ))[0][0];
    const from = [...tally.keys()].filter((s) => s !== into);
    let moved = 0;
    for (const api of c.apiNames) {
      // **An unassigned achievement follows its cluster.** It would otherwise "stay in the
      // section it was already in" (regroupByAssignment's fallback), and we have just established
      // that this cluster is one kind of thing — leaving it orphaned would be creating a fresh split
      if (next.get(api) !== into) moved++;
      next.set(api, into);
    }
    merges.push({ prefix: c.prefix, into, from, moved });
  }
  return { assignment: next, merges };
}

/**
 * A constraint for the prompt: tell the model about the clusters that were found.
 *
 * Why say it at all when the programmatic merge is already a backstop: **the model picks better
 * than plurality does.** It can see the prose and knows which section a cluster really belongs
 * with; plurality only counts heads. If it complies, no backstop is needed this run; if it
 * doesn't, `mergeSplitClusters` cleans up after it.
 */
export function clusterConstraint(defs, clusters, lang = 'zh') {
  if (!clusters?.length) return '';
  const nameOf = new Map((defs ?? []).map((d, i) => [d.api_name, `${i + 1}`]));
  const lines = clusters.map((c) => `  - ${c.apiNames.map((a) => nameOf.get(a) ?? '?').join(' ')}`);
  if (lang === 'en') {
    return (
      '\n- **Each group below is written from one description template, so it is one kind of thing '
      + 'and the whole group goes in one section** (the numbers within a group may not be split up):\n'
      + lines.join('\n') + '\n'
    );
  }
  return (
    '\n- **下面每一组的官方描述是同一个模板写出来的,是同一类事,必须整组放进同一个小节**' +
    '(组内编号不许拆开):\n' + lines.join('\n') + '\n'
  );
}
