/**
 * 攻略备份:列出、看、恢复、删 `guides/` 底下那三个归档目录
 * ------------------------------------------------------
 * `.backups/`、`.migrated/`、`.drafts/` 三个目录一直**只进不出** —— 三条写入路径各自
 * 往里放东西,而在这个文件出现之前,全项目没有一行代码读它们:没有列表、没有恢复、
 * 没有清理(`drafts --clean` 只删,而且只管一个目录)。于是「覆盖前会备份」这句承诺
 * 只兑现了前半句 —— 原文确实存下来了,但**取回来的唯一办法是自己去文件管理器里拷**。
 *
 * `guidebackup.js` 的文件头写着 Notion 那边"备份的是原样 JSON,因为备份的职责是
 * 还得回去,不是好看"。这个文件就是那句话缺的另一半。
 *
 * ## 三个目录是三种东西,不是三堆垃圾
 *
 * | 目录 | 里面是什么 | 恢复意味着 |
 * |---|---|---|
 * | `.backups/` | 覆盖之前的原文(`.md` 是本地攻略,`.json` 是 Notion 整页的块) | 把那一版写回去 |
 * | `.migrated/` | 搬去 Notion 时留下的**本地原件** | 把攻略从 Notion 拽回本地 |
 * | `.drafts/` | 三轮没过校验的半成品 | 把这份没过校验的东西扶正 |
 *
 * 只有 `.drafts/` 是真的"没写完的中间产物"。另外两个都是**某一版攻略仅存的副本**:
 * `.migrated/` 里那份被 Notion 页面取代了,`.backups/` 里那份被新生成的攻略取代了。
 * 所以这里的删除一律要人点头,不做"超过 N 天自动清"。
 *
 * ## 恢复本身是一次覆盖,所以它先备份
 *
 * 这个项目对覆盖只有一条规矩:**没有备份的覆盖等于不可逆的删除**。恢复不例外 ——
 * 走的还是 `backupGuide`,同一个目录同一套命名。于是"手滑恢复错了一份"的出路和
 * "手滑覆盖错了一次"是同一条,不用另学一套。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { containedPath, isInside } from './pathsafe.js';

import { getGame, getGuide, upsertGuide } from './db.js';
import { BACKUPS_DIR, backupGuide, blocksToText } from './guidebackup.js';
import { DRAFTS_DIR, guideFileName } from './guidegen.js';
import { MIGRATED_DIR, checkFidelity } from './guidemigrate.js';
import { readGuideHeader } from './guides.js';
import { extractNotionPageId, richTextToPlain } from './notion.js';
import { blocksForAppend } from './notionblocks.js';
import { sleep } from './steam.js';

/** 扫这三个。顺序就是列表里同一时刻的排序,但列表最终按时间倒序,所以这里只管齐全 */
export const ARCHIVE_DIRS = [BACKUPS_DIR, MIGRATED_DIR, DRAFTS_DIR];

/** 界面上这一行是什么来头。**说来路,不说目录名** —— 用户没见过 `.migrated/` */
export const ARCHIVE_LABEL = {
  [BACKUPS_DIR]: '覆盖前的原文',
  [MIGRATED_DIR]: '搬去 Notion 时留下的原件',
  [DRAFTS_DIR]: '没过校验的草稿',
};

/** `backupGuide` 起的名字:`<appid>-20260820-122121.md|json` */
const BACKUP_NAME_RE = /^(\d+)-(\d{8})-(\d{6})\.(md|json)$/;

/**
 * 文件名允许什么:**不带分隔符、以 `.md` 或 `.json` 结尾**,别的不管。
 *
 * 后缀这一条不只是挑格式,它同时把 `C:`、`nul`、`COM1`、`....` 这类在 Windows 上
 * 有特殊含义的名字挡在外面 —— 而且它和 `describe()` 列表时的过滤条件是同一条,
 * 于是"能被列出来"和"能被点"是同一个集合,不会有列不出来却删得掉的东西。
 *
 * **故意不收窄到 ASCII。** `.migrated/` 和 `.drafts/` 里的文件名是用户自己的攻略
 * 文件名,`guideFileName` 生成的确实都是 ASCII,但手工命名成中文的照样能被
 * `syncGuidesFromMarkdown` 发现、照样会被搬走 —— 收窄的结果是那份存档列得出来、
 * 恢复不了也删不掉。
 */
const ARCHIVE_FILE_RE = /^[^/\\\0]+\.(md|json)$/;

/**
 * 存档编号 = `<目录>/<文件名>`。**这串东西是从浏览器来的**,最后会变成一次
 * `readFileSync` / `rmSync` 的路径,所以目录只认那三个字面量,文件名过上面那条规矩。
 */
export function parseArchiveId(config, id) {
  const raw = String(id ?? '');
  const slash = raw.indexOf('/');
  const dir = slash === -1 ? '' : raw.slice(0, slash);
  const file = slash === -1 ? '' : raw.slice(slash + 1);

  if (!ARCHIVE_DIRS.includes(dir)) throw new Error(`存档编号里的目录不认识:${raw}`);
  if (!ARCHIVE_FILE_RE.test(file)) throw new Error(`存档编号里的文件名不合法:${raw}`);

  // 兜底。**实测走不到**:上面那条禁掉了 `/` 和 `\`,于是 join 出来的路径不可能跑出
  // `root` —— 拿 `..`、`C:`、ADS 那些形状逐个试过,全部在上一行就被拦下了。
  // 留着是因为它守的是"上面那条以后被放宽"这件事,而放宽正是最容易顺手做的改动
  const path = containedPath(join(config.guidesDir, dir), file);
  if (!path) throw new Error(`存档编号越界了:${raw}`);
  return { dir, file, path };
}

/**
 * `parseArchiveId` 的反向:一个刚写出来的绝对路径 → 存档编号。
 *
 * 存在的理由是**别在别处用字符串拼编号**。编号的格式由上面那个解析器定义,
 * 拼接方写在 `server.js` 里的话,两边迟早会对不上 —— 而对不上的症状是
 * 「删除备份」按钮点了没反应,不是一条报错。
 *
 * 不在那三个目录里就返回 `null`,调用方据此决定要不要给出那个动作。
 */
export function archiveIdOf(config, absPath) {
  if (!absPath) return null;
  const full = resolve(String(absPath));
  for (const dir of ARCHIVE_DIRS) {
    const root = resolve(join(config.guidesDir, dir));
    if (!isInside(root, full)) continue;
    const file = full.slice(root.length + 1);
    if (file.includes(sep) || file.includes('/')) continue; // 只认直接子文件
    try {
      parseArchiveId(config, `${dir}/${file}`); // 用同一个解析器验一遍
      return `${dir}/${file}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** `20260820` + `122121` → 本地时区的那一刻。文件 mtime 会被拷贝、同步弄乱,文件名不会 */
function stampToDate(day, time) {
  const n = (s, a, b) => Number(s.slice(a, b));
  const d = new Date(
    n(day, 0, 4), n(day, 4, 6) - 1, n(day, 6, 8),
    n(time, 0, 2), n(time, 2, 4), n(time, 4, 6)
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 备份里的 to_do,深度优先。**顺序要和 `fetchAllToDoBlocks` 一致**,否则回读比对全是噪音 */
export function todosFromBlocks(blocks, out = []) {
  for (const b of blocks ?? []) {
    if (b?.type === 'to_do') {
      out.push({ text: richTextToPlain(b.to_do?.rich_text), checked: Boolean(b.to_do?.checked) });
      todosFromBlocks(b.children, out);
      continue;
    }
    if (b?.children?.length) todosFromBlocks(b.children, out);
  }
  return out;
}

/** 一份存档在列表里长什么样。读不动或者不是我们放的东西就返回 null,让它从列表里消失 */
function describe(db, config, dir, file) {
  const path = join(config.guidesDir, dir, file);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const isJson = file.endsWith('.json');
  if (!isJson && !file.endsWith('.md')) return null;

  const base = {
    id: `${dir}/${file}`,
    dir, file,
    label: ARCHIVE_LABEL[dir],
    bytes: stat.size,
    savedAt: stat.mtime.toISOString(),
  };

  // `.backups/` 的文件名自带 appid 和时间。**不去读 JSON 里的那份** ——
  // 列一次表要读四五份一百多 KB 的 block dump,只为拿两个文件名上就有的字段
  const named = BACKUP_NAME_RE.exec(file);
  if (named) {
    const [, appid, day, time] = named;
    const at = stampToDate(day, time);
    const game = getGame(db, appid);
    return {
      ...base,
      appid,
      game: game?.name || `AppID ${appid}`,
      // 游戏不在库里 = Dashboard 上没有它那一行,这份存档从主入口**够不着**。
      // 设置页那个全量列表存在的唯一理由就是它们
      orphan: !game,
      kind: isJson ? 'notion' : 'local',
      savedAt: at ? at.toISOString() : base.savedAt,
    };
  }

  // `.migrated/` 和 `.drafts/`:文件名就是攻略文件名,appid 只在正文里
  let header = { appid: null, title: '' };
  try {
    header = readGuideHeader(readFileSync(path, 'utf8'));
  } catch {
    /* 读不动就当没头,下面照样列出来 —— 列不出来的存档等于不存在 */
  }
  const game = header.appid ? getGame(db, header.appid) : null;
  return {
    ...base,
    appid: header.appid,
    game: game?.name || header.title || file,
    // 没有 appid 行的文件也算孤儿:它连"属于哪个游戏"都答不出来,
    // 按游戏找永远找不到它
    orphan: !game,
    kind: 'local',
  };
}

/**
 * 三个目录里现在有什么。**新的在前** —— 要找的多半是刚被覆盖掉的那一份。
 *
 * `appid` 是**主用法**:存档的日常入口在 Dashboard 上每个游戏那一行的 ⋯ 菜单里,
 * 问的永远是"这一个游戏的历史版本"。不带 appid 的全量列表只剩两个用处 ——
 * 算总占地,和找出 `orphan`(游戏已经从库里删了,行上再也够不着的那些)。
 */
export function listArchives(db, config, { appid = null } = {}) {
  const want = appid == null ? null : String(appid);
  const out = [];
  for (const dir of ARCHIVE_DIRS) {
    const abs = join(config.guidesDir, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      const entry = describe(db, config, dir, file);
      if (!entry) continue;
      if (want !== null && entry.appid !== want) continue;
      out.push(entry);
    }
  }
  out.sort((a, b) => (a.savedAt === b.savedAt ? a.file.localeCompare(b.file) : a.savedAt < b.savedAt ? 1 : -1));
  return out;
}

/**
 * 一份存档的正文,给"恢复之前先看一眼"用。
 *
 * Notion 那种是 block JSON,这里渲染成纯文本 —— **只给人看,不参与恢复**。
 * 恢复用的始终是原样的 block(见文件头:好看那份是有损的)。
 */
export function readArchive(config, id) {
  const { dir, file, path } = parseArchiveId(config, id);
  const raw = readFileSync(path, 'utf8');
  if (!file.endsWith('.json')) return { id, dir, file, kind: 'local', text: raw };

  const data = JSON.parse(raw);
  const blocks = data.blocks ?? [];
  return {
    id, dir, file,
    kind: 'notion',
    url: data.url ?? '',
    savedAt: data.savedAt ?? null,
    blocks: blocks.length,
    todos: todosFromBlocks(blocks).length,
    text: blocksToText(blocks),
  };
}

/**
 * 把一份本地存档写回 `guides/`。
 *
 * **落到哪个文件名**分两种:`.migrated/` 和 `.drafts/` 里的文件名本来就是攻略文件名,
 * 原样用;`.backups/` 里的是 `<appid>-<时间>.md`,那不是攻略名,得另外要一个 ——
 * 优先用这个游戏现在登记着的本地文件名(那才是"原地"),没有才现起一个。
 */
async function restoreLocal(db, { config, dir, file, path, now }) {
  const text = readFileSync(path, 'utf8');
  const { appid, title } = readGuideHeader(text);
  if (!appid) {
    throw new Error(
      `${file} 的开头没有 \`appid: NNNNNN\` 行 —— 恢复过去也不会被攻略发现逻辑登记,` +
        '等于放了个看不见的文件。先在文件里补上那一行。'
    );
  }

  const existing = getGuide(db, appid);
  const target =
    dir === BACKUPS_DIR
      ? existing?.kind === 'local'
        ? existing.url
        : guideFileName(getGame(db, appid)?.name || title || appid, appid)
      : file;
  const to = join(config.guidesDir, target);

  // 恢复也是覆盖。走 `backupGuide` 而不是自己拷一份:同一个目录、同一套命名,
  // 于是"恢复错了想反悔"和"覆盖错了想反悔"在存档列表里长得一模一样
  const backup = existsSync(to)
    ? await backupGuide(config, { guide: { kind: 'local', url: target }, appid, now })
    : null;

  writeFileSync(to, text);

  // 登记成 local。**这一步会把 Notion 那一页从 guides 表里顶下去** ——
  // 一个 appid 只能有一个攻略后端,而用户刚刚明确说了要本地这一份。
  // Notion 页面本身一个字不动,想搬回去还有「搬去 Notion」那个按钮
  const action = upsertGuide(db, { appid, name: title || target, url: target, kind: 'local' });

  return {
    ok: true,
    kind: 'local',
    appid,
    game: getGame(db, appid)?.name || title || `AppID ${appid}`,
    file: target,
    path: to,
    action,
    backedUpTo: backup?.path ?? null,
    unregisteredNotion: existing?.kind === 'notion' ? existing.url : null,
  };
}

/**
 * 把一份 Notion 存档写回它当初那一页。
 *
 * **先删后写**,和 `landToNotion` 同序。反过来(先写后删)失败时页面上会是新旧两份,
 * 再跑一次就变三份;先删则失败了重跑一遍就好 —— 而原文在刚做的那份备份里。
 */
async function restoreNotion(db, { config, notion, path, now }) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const appid = String(data.appid ?? '');
  const url = String(data.url ?? '');
  if (!url) throw new Error('这份备份里没记页面地址,没法知道该恢复到哪一页。');
  if (!notion?.configured) {
    throw new Error('要把攻略写回 Notion,但 Notion 还没配置 —— 去设置页填 Notion 的 access token。');
  }

  const { blocks, dropped } = blocksForAppend(data.blocks ?? []);
  if (!blocks.length) throw new Error('这份备份里没有一个能写回去的块,那一页不动。');

  const pageId = extractNotionPageId(url);

  // 动手之前先把**现在**那一页存下来,而且用它返回的 blocks 去删 ——
  // 让备份和删除各读一次页面,等于给"备份的和删掉的不是同一批"留了条缝
  const backup = await backupGuide(config, { guide: { kind: 'notion', url }, appid, notion, now });

  for (const b of backup.blocks) {
    await notion.deleteBlock(b.id);
    await sleep(200); // 几十上百个块不歇气地删会撞限流,而这时旧内容已经删了一半
  }
  await notion.appendBlocks(pageId, blocks);

  // 回读比对。**和搬家用的是同一个 checkFidelity** —— 写进去 ≠ 写对了,
  // 这条路上尤其要紧:旧内容已经删了,新的要是没落对,页面就是空的
  const fidelity = checkFidelity(todosFromBlocks(data.blocks), await notion.fetchAllToDoBlocks(pageId));
  if (!fidelity.ok) {
    throw new Error(
      `写回去之后回读对不上(${url}):\n  ` +
        fidelity.problems.join('\n  ') +
        `\n  刚才那一版存在 ${backup.path},页面自己看一眼决定怎么办。`
    );
  }

  return {
    ok: true,
    kind: 'notion',
    appid,
    game: getGame(db, appid)?.name || `AppID ${appid}`,
    url,
    count: fidelity.count,
    dropped,
    backedUpTo: backup.path,
  };
}

/**
 * 恢复一份存档。`.json` 回 Notion,`.md` 回本地文件 —— **按存档自己的来路走,
 * 不按这个游戏现在的后端走**:存的是什么就还什么,换后端是另一个按钮的事。
 */
export async function restoreArchive(db, { config, notion = null, id, now = new Date() }) {
  const { dir, file, path } = parseArchiveId(config, id);
  if (!existsSync(path)) throw new Error(`这份存档已经不在了:${path}`);
  return file.endsWith('.json')
    ? restoreNotion(db, { config, notion, path, now })
    : restoreLocal(db, { config, dir, file, path, now });
}

/**
 * 删一份存档。
 */
export function deleteArchive(config, id) {
  const { dir, file, path } = parseArchiveId(config, id);
  if (!existsSync(path)) return { ok: true, id, dir, file, bytes: 0, alreadyGone: true };
  const bytes = statSync(path).size;
  rmSync(path, { force: true });
  return { ok: true, id, dir, file, bytes, alreadyGone: false };
}

/**
 * 删掉**点名的那几份**。设置页「全部删除」走这里。
 *
 * **参数是一串编号,不是"清空目录"**,而且这不是图省事。列表画出来之后、
 * 按钮点下去之前,后台可能刚跑完一次重写——`.backups/` 里就多出一份没上过屏的
 * 备份。"清空目录"会把那份一起吃掉;点名删则最多漏删,而漏删下次还看得见。
 *
 * **一份出错不能拖累后面的。** `parseArchiveId` 碰到野编号是抛的,try 写在循环
 * 外面的话,第一个坏编号就把剩下全部顶掉了。所以 try 在循环**里面**,坏的记进
 * `failed` 接着跑。
 *
 * 至于"这一键下去毁掉的是某一版攻略仅存的副本" —— 那句话归按钮说,
 * 不归这里拦。这里只负责把点名的删干净并如实报数。
 */
export function deleteArchives(config, ids) {
  let deleted = 0;
  let bytes = 0;
  const failed = [];
  for (const id of ids ?? []) {
    try {
      const r = deleteArchive(config, id);
      deleted += 1;
      bytes += r.bytes;
    } catch (err) {
      failed.push({ id: String(id), error: String(err.message ?? err) });
    }
  }
  return { ok: true, deleted, bytes, failed };
}
