/**
 * 把本地 markdown 攻略搬到 Notion
 * ------------------------------------------------
 * 和 `guidegen` 的落盘看着像,但**验的东西完全不一样**,这是这个文件存在的理由。
 *
 * 生成的攻略要过 `lintGuide`,因为那份内容是刚出炉的、没人看过的,闸门是它唯一的把关。
 * 搬家不一样:这份攻略**已经存在了**,是用户自己写的、用了很久的东西。拿 lint 去卡它
 * 是错的 —— 实测语料里 330 个成就没有任何 name-matching 够得着的 checkbox,大部分本地
 * 攻略根本过不了闸门。**用户没有请我们评价他的攻略,他请我们搬它。**
 *
 * 所以这里验的是**保真**:Notion 上读回来的东西,和文件里原来写的,是不是同一份。
 *
 *  - 条目数一样
 *  - 每条的文字一样(`<br>`→换行、`**`去掉之后逐条比)
 *  - 勾选状态一样 —— 搬家绝不能改动勾选,那是同步系统的职责边界
 *
 * 对不上就**不动本地文件**,把差异报出来让人自己看。
 *
 * ## 顺序
 *
 * 建页 → 写正文 → 回读保真校验 → 登记(走真的发现逻辑)→ **最后**才把本地文件归档。
 * 归档放最后,是因为它是这条链里唯一动用户文件的一步:前面任何一步炸了,
 * 本地攻略必须原封不动还在那儿。
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { getGuide, getGame } from './db.js';
import { loadTodos, resolveGuidePath } from './markdown.js';
import { syncGuidesFromNotion } from './guides.js';
import { markdownToBlocks } from './notionblocks.js';
import { planNotionTarget, newGuideStatus, fillMissingIcon } from './notion.js';
import { fetchGameIcon } from './steam.js';

/** 搬完的本地文件挪去哪。和 `.drafts/` 一样,发现逻辑是非递归的,进不来 */
export const MIGRATED_DIR = '.migrated';

/**
 * 两边的文字化到同一个形状再比。
 *
 * 文件里是 `**名字**<br>描述`,Notion 读回来是 `名字\n描述`(粗体在 annotations 里,
 * 不在 plain_text 里)。不归一化的话每一条都会报"不一样",这个校验就没用了。
 */
export const normalizeForCompare = (s) =>
  String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*/g, '')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

/**
 * 比对源文件的 todo 和 Notion 读回来的 todo。**纯函数**,好测。
 *
 * @returns {{ok: boolean, problems: string[], count: number}}
 */
export function checkFidelity(sourceTodos, notionTodos) {
  const problems = [];
  const a = sourceTodos.map((t) => ({ text: normalizeForCompare(t.text), checked: Boolean(t.checked) }));
  const b = notionTodos.map((t) => ({ text: normalizeForCompare(t.text), checked: Boolean(t.checked) }));

  if (a.length !== b.length) {
    problems.push(`条目数对不上:文件里 ${a.length} 个,Notion 上 ${b.length} 个`);
  }

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].text !== b[i].text) {
      problems.push(`第 ${i + 1} 条文字对不上:\n    文件:${a[i].text.slice(0, 70)}\n    Notion:${b[i].text.slice(0, 70)}`);
    } else if (a[i].checked !== b[i].checked) {
      // 文字一样但勾选不一样单独报 —— 搬家改动勾选是比丢字更隐蔽的破坏
      problems.push(`第 ${i + 1} 条勾选状态被改了(${a[i].checked ? '已勾' : '未勾'} → ${b[i].checked ? '已勾' : '未勾'}):${a[i].text.slice(0, 40)}`);
    }
    if (problems.length >= 10) {
      problems.push('…… 后面的不再列了');
      break;
    }
  }

  return { ok: problems.length === 0, problems, count: a.length };
}

/**
 * 搬家前先看清楚:这份攻略长什么样、转换会损失什么、Notion 那边能不能接。
 * **不写任何东西。** Dashboard 和 CLI 的预览都走这里。
 */
export async function planMigration(db, { notion, config, appid }) {
  const id = String(appid);
  const guide = getGuide(db, id);
  if (!guide) throw new Error(`appid ${id} 在 guides 表里没有登记的攻略`);
  if (guide.kind !== 'local') {
    throw new Error(`《${guide.name}》的攻略已经在 Notion 上了(${guide.url}),不用搬`);
  }
  if (!notion?.configured) {
    throw new Error('还没配置 Notion —— 去设置页填 integration token 和攻略数据库 ID');
  }

  const path = resolveGuidePath(config.guidesDir, guide.url);
  if (!existsSync(path)) throw new Error(`攻略文件不见了:${path}`);

  const markdown = readFileSync(path, 'utf8');
  const { blocks, unconverted } = markdownToBlocks(markdown);
  const todos = loadTodos(path);
  if (!todos.length) {
    throw new Error(`${path} 里一个 checkbox 都没有,搬过去也没法勾。先确认这是不是想搬的文件。`);
  }

  // 页面标题用**游戏名**,不是文件名 —— 攻略库里其他一百多页都是游戏名,
  // 而且 planNotionTarget 的同名页判断也是按游戏名来的
  const gameRow = getGame(db, id);
  const game = gameRow?.name || guide.name || id;
  // 状态按这个游戏的真实进度算,不是固定值 —— 见 newGuideStatus 里那段"踩过"
  const target = await planNotionTarget(notion, game, { statusValue: newGuideStatus(gameRow) });

  const byType = {};
  for (const b of blocks) byType[b.type] = (byType[b.type] ?? 0) + 1;

  return { guide, game, path, markdown, blocks, todos, unconverted, target, byType };
}

/**
 * 真搬。`plan` 来自 `planMigration`(不传就自己跑一遍)。
 *
 * @returns {Promise<object>} {url, count, unconverted, archivedTo}
 */
export async function migrateGuideToNotion(
  db,
  { notion, steam, config, appid, plan = null, onProgress = () => {} }
) {
  const p = plan ?? (await planMigration(db, { notion, config, appid }));

  let page = p.target.existingPage;
  // 图标和 `guide-gen` 建页时走的是同一个来源、同一条容错规则。
  //
  // **这里原来是不补图标的**,理由是"搬家是换个地方放,不是重做一份,想要图标自己拖一个
  // 更快"。实际用下来那个理由不成立:搬过去的页面和生成的页面并排躺在同一个攻略库里,
  // 一批有图标一批没有,看着就是搬运漏了东西 —— 而"自己拖一个"是把一次 Steam 调用
  // 换成用户的一次手工操作,每搬一篇都要来一遍。多打一次接口便宜得多。
  const icon = await fetchGameIcon(steam, appid).catch(() => null);

  if (page) {
    onProgress({ phase: 'fill', url: page.url, blocks: p.blocks.length });
    // 接管别人建的空页只补**空着**的图标格,有图标的一律不碰 —— 和 landToNotion 同一条规矩
    await fillMissingIcon(notion, page, icon);
  } else {
    page = await notion.createGuidePage({
      titleProperty: p.target.titleProperty,
      title: p.game,
      icon,
      status: p.target.status,
    });
    onProgress({ phase: 'create', url: page.url, blocks: p.blocks.length });
  }

  await notion.appendBlocks(page.id, p.blocks);
  onProgress({ phase: 'verify', url: page.url });

  // 保真校验。**不是 lintGuide** —— 理由见文件头
  const readBack = await notion.fetchAllToDoBlocks(page.id);
  const fidelity = checkFidelity(p.todos, readBack);
  if (!fidelity.ok) {
    throw new Error(
      `搬过去之后回读对不上,本地文件原样没动(${page.url}):\n  ` +
        fidelity.problems.join('\n  ') +
        '\n  Notion 上那一页请自己看一眼决定留不留。'
    );
  }

  // 登记走真的发现逻辑:它会回去读页面上的 `appid:` 行。读不出来就说明那行没写对,
  // 而 upsertGuide 的 ON CONFLICT 会把这一行从 local 翻成 notion
  const discovered = await syncGuidesFromNotion(db, notion);
  if (!discovered.added.some((a) => a.appid === String(appid))) {
    throw new Error(
      `页面写好了(${page.url}),但攻略发现逻辑没能从上面读出 appid:${appid}。` +
        '本地文件原样没动,guides 表还指着它 —— 检查页面正文里的 `appid:` 行。'
    );
  }

  // 最后一步才动用户的文件,而且是**挪走不是删掉**。前面任何一步失败,
  // 本地攻略都还在原地
  const archivedTo = archiveLocalGuide(config, p.guide.url);
  onProgress({ phase: 'done', url: page.url, archivedTo });

  return { url: page.url, count: fidelity.count, unconverted: p.unconverted, archivedTo, game: p.game };
}

/**
 * 把搬走的本地文件挪进 `guides/.migrated/`。**不删。**
 *
 * 归档失败不算搬家失败:发现逻辑遇到已登记成 notion 的 appid 会跳过本地同名文件
 * (`syncGuidesFromMarkdown` 里 `existing.kind === 'notion' && !force` 那一支),
 * 所以留在原地的文件顶多是碍眼,不会把攻略抢回本地。为这个把已经成功的搬家报成失败,
 * 是拿一个真问题的名义去报一个假问题。
 */
export function archiveLocalGuide(config, fileName) {
  try {
    const from = resolveGuidePath(config.guidesDir, fileName);
    const dir = join(config.guidesDir, MIGRATED_DIR);
    mkdirSync(dir, { recursive: true });
    const to = join(dir, fileName);
    renameSync(from, to);
    return to;
  } catch {
    return null;
  }
}
