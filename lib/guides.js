/**
 * 攻略层:成就名 ↔ checkbox 的匹配规则,以及两种后端(Notion / 本地 markdown)的调度
 * ------------------------------------------------
 * 原 steam_daily_checkbox_sync.gs 的核心逻辑搬到这里,匹配规则一个字都没放松:
 *
 * **必须精确匹配"标题候选片段",不做 substring / prefix 匹配。**
 * 原因(踩过的坑):一个短成就名可能正好是另一个不相关的、更难的成就名的严格前缀。
 * 如果短成就名对应的 checkbox 已经被勾上(不在待匹配池里了),前缀匹配就会去勾那个
 * "表亲成就"——而它其实还没解锁。所以只接受"成就名严格等于某个候选片段"。
 *
 * 候选片段的提取(extractTitleCandidates)比原版多了两种,为的是同时支持本地 markdown
 * 攻略常用的写法,而不是靠放宽匹配去兼容:
 *   - 破折号除了 ' - ' 也认全角破折号 ' — ' / ' – '
 *   - "中文名(English Name)" 这种片段,中文名和英文名各自也算一个候选
 * 这两条只是**多切出几个候选片段**,每个候选仍然要求严格相等,没有削弱精确性。
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
 * 把已解锁成就和 checkbox 列表配对。一个 checkbox 只会被一个成就认领(claimed),
 * 一个成就配到一个就停,和原版行为一致。
 */
export function matchAchievements(unlocked, todos) {
  const pending = todos.filter((t) => !t.checked);
  const claimed = new Set();
  const matches = [];

  for (const ach of unlocked) {
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
        matches.push({ key: todo.key, achievement: ach, text: todo.text });
        break;
      }
    }
  }
  return matches;
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
export async function syncGameCheckboxes(db, steam, guide, gameName, { notion, config }) {
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

  const matches = matchAchievements(unlocked, todos);
  if (matches.length === 0) return logs;

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
 * 候选条件和原版一致:有攻略链接、有成就系统、完成数 < 成就总数(已经 100% 的跳过)。
 * 判断依据是本地自己的成就数,不看 Notion 的 Status 属性——重复跑已完成的游戏只是 no-op。
 */
export async function checkboxSync(db, steam, { notion, config, appid = null, onProgress = () => {} }) {
  const guideByAppid = Object.fromEntries(allGuides(db).map((g) => [g.appid, g]));
  const candidates = allGames(db).filter((g) => {
    if (!guideByAppid[g.appid]) return false;
    if (appid && g.appid !== String(appid)) return false;
    return typeof g.total === 'number' && g.total > 0 && g.achieved < g.total;
  });

  const allLogs = [];
  for (const [i, g] of candidates.entries()) {
    onProgress({ done: i + 1, total: candidates.length, name: g.name });
    const logs = await syncGameCheckboxes(db, steam, guideByAppid[g.appid], g.name, { notion, config });
    allLogs.push(...logs);
    await sleep(350); // 给 Notion API 留余量,避免 429
  }

  appendSyncLog(db, allLogs);
  return { checked: candidates.length, logs: allLogs };
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
