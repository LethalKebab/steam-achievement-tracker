#!/usr/bin/env node
/**
 * Steam 成就追踪器 —— 本地版命令行入口
 * ------------------------------------------------
 * 零依赖:只用 Node 内置模块(node:sqlite 存数据,内置 fetch 调 Steam API,
 * node:http 起 Dashboard),不需要 npm install,不需要任何外部账号或部署。
 *
 *   node tracker.js init            填 Steam 凭据(只需要跑一次;--notion 填 Notion token)
 *   node tracker.js sync            全量同步(库 + 成就完成数 + 成就详情)
 *   node tracker.js serve           起本地 Dashboard,数据太旧会自动后台同步
 *   node tracker.js status          看一眼当前数据和 AGCR
 *   node tracker.js import <目录>   从表格导出的 CSV 导入数据
 *   node tracker.js export [目录]   把三张表导出成 CSV
 *   node tracker.js guides          发现攻略页面(Notion 数据库 + 本地 guides/*.md)
 *   node tracker.js checkbox-sync   把已解锁成就同步成攻略里的 ✅(--dry-run 先预演)
 *   node tracker.js audit           反查:有没有勾上了但其实没解锁的 checkbox(只读)
 *   node tracker.js log [n]         看最近的同步日志
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';

import { loadConfig, saveConfig, ROOT, CONFIG_PATH } from './lib/config.js';
import { openDb, allGames, allGuides, countGames, getMeta, recentSyncLog } from './lib/db.js';
import { SteamClient } from './lib/steam.js';
import { fullSync, syncLibrary, syncAchievementStats, syncAchievementSchema, computeAgcrStats } from './lib/sync.js';
import { serve } from './lib/server.js';
import { NotionClient } from './lib/notion.js';
import { checkboxSync, syncGuidesFromNotion, syncGuidesFromMarkdown, auditGuideTicks } from './lib/guides.js';
import { importAll, exportAll } from './lib/csv.js';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));

function flagValue(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 同一行原地刷新的进度输出(不是 TTY 就退化成什么都不打,避免刷屏日志) */
function progressPrinter() {
  const isTty = stdout.isTTY;
  let last = '';
  return {
    update(text) {
      if (!isTty) return;
      const line = text.length > 100 ? text.slice(0, 99) + '…' : text;
      stdout.write('\r' + ' '.repeat(last.length) + '\r' + line);
      last = line;
    },
    done(text) {
      if (isTty && last) stdout.write('\r' + ' '.repeat(last.length) + '\r');
      last = '';
      if (text) console.log(text);
    },
  };
}

const PHASE_LABEL = { library: '检查新游戏', achievements: '刷新成就完成数', schema: '同步成就详情' };

function makeProgressHandler(p) {
  return (ev) => {
    const label = PHASE_LABEL[ev.phase] ?? ev.phase ?? '';
    const count = ev.total ? ` ${ev.done}/${ev.total}` : ev.added ? ` +${ev.added}` : '';
    p.update(`  ${label}${count} ${ev.name ?? ''}`);
  };
}

function withSteam({ requireSteam = true } = {}) {
  const config = loadConfig({ required: requireSteam ? ['steam'] : [] });
  const db = openDb(config.dbPath);
  const steam = new SteamClient(config, { log: () => {} });
  return { config, db, steam };
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/**
 * 读一行但**不回显**——token 不该留在终端 scrollback 里,也不该进 shell history。
 * 提示语自己写到 stdout,readline 的输出走一个可静音的 Writable。
 */
function makeSecretReader() {
  // stdin 不是终端(管道输入/CI)的时候不能开 terminal 模式,否则 readline 收不到行、
  // question() 永远不 resolve,整个进程挂住。这种情况下也没有回显要遮,直接普通读。
  const isTty = Boolean(stdin.isTTY);
  let muted = false;
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output: isTty ? out : stdout, terminal: isTty });

  // 用异步迭代器逐行取,不用 rl.question():管道输入时整块数据会一次到达,
  // readline 会连着抛出所有 'line' 事件,后面那个 question() 还没注册就把行丢了、
  // 于是永远不 resolve。迭代器带队列,不会漏行。
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async () => ((await lines.next()).value ?? '').trim();

  return {
    ask: async (prompt) => {
      stdout.write(prompt);
      return nextLine();
    },
    askSecret: async (prompt) => {
      stdout.write(prompt);
      muted = true;
      const v = await nextLine();
      muted = false;
      if (isTty) stdout.write('\n');
      return v;
    },
    close: () => rl.close(),
  };
}

/**
 * `init --notion`:配置攻略同步用的 Notion token。
 * 输入不回显,而且**当场验证**——token 本身 + 那个数据库能不能访问,
 * 分开报错,因为这两件事的修法完全不同(换 token vs. 去 Notion 加 connection)。
 */
async function cmdInitNotion() {
  const io = makeSecretReader();
  try {
    const cfg = loadConfig();
    console.log('\n配置 Notion 攻略同步\n');
    console.log('token 从哪来:https://www.notion.so/my-integrations 新建一个 Internal Integration,');
    console.log('复制它的 secret。然后把攻略页面(或它们共同的父页面)加到这个 integration 的');
    console.log('connections 里:Notion 页面右上角 ••• → Connections → 加上它,否则 API 会返回 404。\n');

    const token = await io.askSecret('Notion Integration Token(输入不会显示): ');
    if (!token) throw new Error('没输入 token');

    const dbDefault = cfg.notion?.overviewDbId || '';
    const dbId =
      (await io.ask(`攻略数据库 ID${dbDefault ? `(回车用 ${dbDefault})` : ''}: `)) || dbDefault;

    const probe = new NotionClient({ notion: { token, overviewDbId: dbId } });

    stdout.write('\n正在验证 token…');
    const me = await probe.request('get', '/users/me');
    console.log(`\r✅ token 可用:integration「${me.name || me.bot?.workspace_name || '未命名'}」        `);

    let dbOk = false;
    if (dbId) {
      stdout.write('正在验证数据库访问…');
      try {
        const pages = await probe.queryGuideDatabase(dbId);
        console.log(`\r✅ 数据库可访问:里面有 ${pages.length} 个页面        `);
        dbOk = true;
      } catch (err) {
        console.log(`\r⚠️  数据库访问失败:${err.message}`);
        console.log('   token 本身是好的,所以问题在权限或 ID:');
        console.log('   Notion 里打开那个数据库(或它的父页面)→ 右上角 ••• → Connections → 加上这个 integration');
      }
    }

    saveConfig({ notion: { token, overviewDbId: dbId } });
    console.log(`\n✅ 已写入 ${CONFIG_PATH}(权限 600,已 gitignore,不会被提交)`);
    console.log('\n接下来:');
    console.log('  node tracker.js guides --notion             ← 应该报「新增 0 条」');
    console.log('  node tracker.js checkbox-sync --dry-run     ← 只算不写,先看会勾掉哪些');
    if (!dbOk && dbId) console.log('\n(数据库那一步没通过的话,上面两条命令会失败,先按提示加 connection)');
  } finally {
    io.close();
  }
}

async function cmdInit() {
  if (flags.has('--notion')) return cmdInitNotion();
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const current = loadConfig();
    console.log('\nSteam 成就追踪器 —— 本地版初始化\n');

    if (current.steamApiKey && current.steamId) {
      console.log(`已有配置:${CONFIG_PATH}`);
      console.log(`  STEAM_ID = ${current.steamId}`);
      const again = await rl.question('要重新填一遍吗?(y/N) ');
      if (!/^y/i.test(again)) return;
    }

    console.log('需要两个东西(都是一次性的):');
    console.log('  ① Steam Web API Key → https://steamcommunity.com/dev/apikey');
    console.log('  ② SteamID64        → https://steamid.io(把你的个人资料链接粘进去)\n');

    const key = (flagValue('key') ?? (await rl.question('① Steam Web API Key: '))).trim();
    const id = (flagValue('id') ?? (await rl.question('② SteamID64: '))).trim();
    if (!key || !id) throw new Error('两个都得填');
    if (!/^\d{17}$/.test(id)) console.log('⚠️  SteamID64 一般是 17 位数字,你填的看起来不像,先存下了,同步失败的话回来检查这里');

    saveConfig({ steamApiKey: key, steamId: id });
    const config = loadConfig({ required: ['steam'] });
    openDb(config.dbPath);
    console.log(`\n✅ 写入 ${CONFIG_PATH}(权限 600,已在 .gitignore 里)`);
    console.log(`✅ 建好数据库 ${config.dbPath}`);

    // 立刻拿真实请求验一次,省得后面同步到一半才发现凭据不对
    process.stdout.write('\n正在验证凭据…');
    try {
      const steam = new SteamClient(config);
      const games = await steam.fetchOwnedGames(false);
      console.log(`\r✅ 凭据可用:Steam 返回了 ${games.length} 款游戏          `);
    } catch (err) {
      console.log(`\r❌ 凭据验证失败:${err.message}`);
      console.log('   检查一下 API Key 和 SteamID64,改 config.json 或者重跑 init 都行。');
      return;
    }

    console.log('\n接下来:');
    console.log('  node tracker.js import <csv目录>   ← 有表格里的历史数据就先导入(♥/★/家庭/Manual 标记只能靠这个带过来)');
    console.log('  node tracker.js sync               ← 首次全量同步(库大的话要几分钟)');
    console.log('  node tracker.js serve              ← 打开 Dashboard');
  } finally {
    rl.close();
  }
}

async function cmdSync() {
  const { db, steam } = withSteam();
  const p = progressPrinter();
  const onProgress = makeProgressHandler(p);
  const only = ['library', 'achievements', 'schema'].filter((f) => flags.has('--' + f));

  console.log('开始同步(Ctrl+C 可以随时停,已经写进库的数据不会丢)\n');
  const t0 = Date.now();

  if (only.length === 0) {
    const r = await fullSync(db, steam, { onProgress });
    p.done();
    console.log(`  库:owned ${r.library.ownedCount} 款(Unvetted ${r.library.unvettedCount} 款),新增 ${r.library.added.length} 款,Unvetted 标记更新 ${r.library.restamped} 处`);
    if (r.library.added.length) console.log(`     新增:${r.library.added.map((a) => a.name).join('、')}`);
    console.log(`  成就完成数:更新 ${r.stats.updated} 款,无成就系统 ${r.stats.noSystem} 款,留待重试 ${r.stats.retried} 款`);
    if (r.stats.bumped.length) console.log(`     🆕 成就总数变多了(游戏更新):${r.stats.bumped.join('、')}`);
    console.log(`  成就详情:处理 ${r.schema.processed}/${r.schema.candidates} 款,查不到定义 ${r.schema.skippedNoSchema} 款`);
  } else {
    if (only.includes('library')) {
      const r = await syncLibrary(db, steam, { onProgress });
      p.done(`  库:新增 ${r.added.length} 款,Unvetted 标记更新 ${r.restamped} 处`);
    }
    if (only.includes('achievements')) {
      const r = await syncAchievementStats(db, steam, { onProgress });
      p.done(`  成就完成数:更新 ${r.updated} 款,无成就系统 ${r.noSystem} 款,留待重试 ${r.retried} 款`);
    }
    if (only.includes('schema')) {
      const r = await syncAchievementSchema(db, steam, { onProgress });
      p.done(`  成就详情:处理 ${r.processed}/${r.candidates} 款`);
    }
  }

  const agcr = computeAgcrStats(db);
  console.log(`\n✅ 用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒 — AGCR ${Math.floor(agcr.avg * 100)}%(精确 ${(agcr.avg * 100).toFixed(3)}%),完美游戏 ${agcr.perfectCount} 款`);
}

async function cmdServe() {
  const { config, db, steam } = withSteam({ requireSteam: false });
  const port = Number(flagValue('port') ?? config.port);
  await serve({ db, steam, config: { ...config, port } });
}

function cmdStatus() {
  const { db } = withSteam({ requireSteam: false });
  const games = allGames(db);
  const agcr = computeAgcrStats(db);
  const last = getMeta(db, 'last_sync');
  const count = (fn) => games.filter(fn).length;

  console.log(`\n数据库:${countGames(db)} 款游戏`);
  console.log(`  上次同步:${last ? new Date(last).toLocaleString('zh-CN') : '还没同步过'}`);
  console.log(`  AGCR:${Math.floor(agcr.avg * 100)}%(精确 ${(agcr.avg * 100).toFixed(3)}%),计入 ${agcr.eligibleCount} 款`);
  console.log(`  完美(100%):${agcr.perfectCount} 款`);
  console.log(`  Unvetted:${count((g) => g.status === 'Unvetted')} 款 / Manual:${count((g) => g.status === 'Manual')} 款 / 家庭共享标记:${count((g) => g.family)} 款`);
  console.log(`  ♥ 喜爱:${count((g) => g.favorite)} 款 / ★ 重点关注:${count((g) => g.priority)} 款`);
  console.log(`  没有成就系统:${count((g) => g.has_achievements === 0)} 款 / 还没同步到数据:${count((g) => g.total === null && g.has_achievements !== 0)} 款`);
  console.log(`  攻略:${allGuides(db).length} 条(Notion ${allGuides(db).filter((g) => g.kind === 'notion').length} / 本地 ${allGuides(db).filter((g) => g.kind === 'local').length})\n`);
}

async function cmdGuides() {
  const { config, db } = withSteam({ requireSteam: false });
  const wantLocal = flags.has('--local') || flags.has('--all') || flags.size === 0;
  const wantNotion = flags.has('--notion') || flags.has('--all') || flags.size === 0;

  if (wantLocal) {
    const r = syncGuidesFromMarkdown(db, config, { force: flags.has('--force') });
    console.log(`本地 guides/:扫了 ${r.files} 个 .md,登记 ${r.added.length} 条`);
    for (const a of r.added) console.log(`  ${a.action === 'appended' ? '+' : '~'} ${a.appid}  ${a.name}  (${a.file})`);
    if (r.skipped.length) console.log(`  跳过(没有 "appid: NNNNNN" 行):${r.skipped.join('、')}`);
    for (const c of r.conflicts) {
      console.log(`  ⚠️  ${c.appid} 已经登记了 Notion 攻略,没动 ${c.file}(想改成用本地 md 加 --force)`);
    }
  }

  if (wantNotion) {
    const notion = new NotionClient(config);
    if (!notion.configured) {
      console.log('Notion:没配 token,跳过(要用的话在 config.json 填 notion.token 和 notion.overviewDbId)');
    } else {
      const r = await syncGuidesFromNotion(db, notion);
      console.log(`Notion:数据库里 ${r.dbPages} 个页面,新页面 ${r.newPagesChecked} 个,登记 ${r.added.length} 条`);
      for (const a of r.added) console.log(`  + ${a.appid}  ${a.name}`);
      for (const f of r.failed) console.log(`  ⚠️  ${f.title}:${f.error}`);
    }
  }

  console.log(`\n当前 guides 表(${allGuides(db).length} 条):`);
  for (const g of allGuides(db)) console.log(`  ${g.appid.padEnd(8)} ${g.kind.padEnd(6)} ${g.name}`);
}

async function cmdCheckboxSync() {
  const { config, db, steam } = withSteam();
  const notion = new NotionClient(config);
  const appid = positional[0] ?? null;
  const dryRun = flags.has('--dry-run');
  const p = progressPrinter();

  if (dryRun) console.log('预演模式:只读攻略页面算出会勾哪些,不写任何东西\n');

  const r = await checkboxSync(db, steam, {
    notion,
    config,
    appid,
    dryRun,
    onProgress: (ev) => p.update(`  ${ev.done}/${ev.total} ${ev.name}`),
  });
  p.done(`检查了 ${r.checked} 款游戏,产生 ${r.logs.length} 条日志`);

  // 按游戏分组打印,几百条的时候平铺看不清
  const byGame = new Map();
  for (const l of r.logs) {
    if (!byGame.has(l.gameName)) byGame.set(l.gameName, []);
    byGame.get(l.gameName).push(l);
  }
  for (const [game, logs] of byGame) {
    console.log(`\n  ${game}(${logs.length} 条)`);
    for (const l of logs) console.log(`    ${l.achievement || '—'} → ${l.result}`);
  }

  if (r.checked === 0) {
    console.log('  (没有符合条件的游戏:需要有攻略登记、有成就系统、且还没 100% 完成)');
  } else if (dryRun) {
    const willCheck = r.logs.filter((l) => l.result.startsWith('【预演】')).length;
    console.log(
      `\n预演结束:会勾选 ${willCheck} 个 checkbox。确认没问题就去掉 --dry-run 再跑一次。` +
        '\n(Notion 的勾选没法自动撤销,建议先只跑一款游戏:checkbox-sync <appid>)'
    );
  }
}

/**
 * 只读审计:找勾错的 checkbox(和 checkbox-sync 找漏勾正好相反)。
 * 不写任何东西,所以不需要 --dry-run。
 */
async function cmdAudit() {
  const { config, db, steam } = withSteam();
  const notion = new NotionClient(config);
  const p = progressPrinter();

  console.log('审计已勾选的 checkbox:找"勾上了但成就其实没解锁"的(只读,不会改任何东西)\n');
  const { results, totals, candidates } = await auditGuideTicks(db, steam, {
    notion,
    config,
    appid: positional[0] ?? null,
    onProgress: (ev) => p.update(`  ${ev.done}/${ev.total} ${ev.name}`),
  });
  p.done();

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⏭  ${r.name} —— 跳过:${r.skipped}`);
      continue;
    }
    if (r.wrong.length === 0) continue;
    console.log(`\n  ❌ ${r.name}(已勾 ${r.ticked} 个,其中 ${r.wrong.length} 个对应的成就没解锁)`);
    for (const w of r.wrong) {
      console.log(`     ${w.name}(${w.apiName},按${w.via === 'description' ? '描述' : '名字'}对上的)`);
      console.log(`       ${w.text.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }

  console.log(
    `\n审计完 ${totals.games}/${candidates} 款游戏,检查了 ${totals.ticked} 个已勾选的 checkbox`
  );
  console.log(`  确认勾错:${totals.wrong} 个`);
  // 覆盖范围要如实说:对不上的没结论,不能让"0 个勾错"看起来比实际覆盖更强
  console.log(`  对不上具体成就、没下结论:${totals.unresolved} 个(攻略文字既没抄描述原文、名字也不唯一)`);
  if (totals.skipped) console.log(`  跳过的游戏:${totals.skipped} 款(见上面)`);
  if (totals.wrong > 0) {
    console.log('\n勾错的框需要手动取消勾选——checkbox-sync 只会勾上、从不取消,修不了自己的错。');
    console.log('取消之前先自己确认一遍:也可能是你自己有意勾的(比如标记"计划要做")。');
  }
}

function cmdImport() {
  const dir = positional[0];
  if (!dir) throw new Error('用法:node tracker.js import <放 CSV 的目录>');
  const { db } = withSteam({ requireSteam: false });
  const r = importAll(db, dir);
  console.log('\n导入完成:');
  if (r.games) console.log(`  ${r.games.file} → ${r.games.imported} 款游戏` + (r.games.skipped.length ? `(跳过 ${r.games.skipped.length} 行没有合法 appid 的)` : ''));
  if (r.achievements) console.log(`  ${r.achievements.file} → ${r.achievements.games} 款游戏的 ${r.achievements.rows} 条成就详情`);
  if (r.guides) console.log(`  ${r.guides.file} → ${r.guides.imported} 条攻略链接`);
  console.log('\n♥/★/家庭共享/Manual 标记都带过来了。接着跑 `node tracker.js sync` 用 Steam 的最新数据刷一遍。');
}

function cmdExport() {
  const dir = positional[0] ?? join(ROOT, 'exports');
  mkdirSync(dir, { recursive: true });
  const { db } = withSteam({ requireSteam: false });
  console.log('\n导出到 ' + dir + ':');
  for (const f of exportAll(db, dir)) console.log(`  ${f.file}(${f.rows} 行)`);
}

function cmdLog() {
  const { db } = withSteam({ requireSteam: false });
  const rows = recentSyncLog(db, Number(positional[0] ?? 30));
  if (!rows.length) return console.log('还没有同步日志');
  for (const r of rows.reverse()) {
    const ts = new Date(r.ts).toLocaleString('zh-CN');
    console.log(`${ts}  ${r.game_name || '—'}  ${r.achievement || ''}  ${r.result}`);
  }
}

function cmdHelp() {
  console.log(`
Steam 成就追踪器(本地版)—— 零依赖,不需要 Google 账号

  node tracker.js init                    填 Steam API Key 和 SteamID64(跑一次)
              init --notion               填 Notion token(只有要用攻略同步才需要)
  node tracker.js sync                    全量同步:库 + 成就完成数 + 成就详情
              sync --library              只检查新游戏
              sync --achievements         只刷成就完成数
              sync --schema               只同步成就详情
  node tracker.js serve [--port 8777]     起本地 Dashboard(数据超过 12 小时会自动后台同步)
  node tracker.js status                  当前数据概览 + AGCR
  node tracker.js import <目录>            从表格导出的 CSV 导入数据
  node tracker.js export [目录]            三张表导出成 CSV(默认 exports/)
  node tracker.js guides [--notion|--local|--all]
                                          发现攻略页面并登记进 guides 表
  node tracker.js checkbox-sync [appid]   把 Steam 已解锁成就同步成攻略里的 ✅
              checkbox-sync --dry-run     只算不写,先看会勾掉哪些(Notion 勾选不可撤销)
  node tracker.js audit [appid]           反查有没有勾上了但其实没解锁的 checkbox(只读)
  node tracker.js log [n]                 最近 n 条同步日志

配置:${CONFIG_PATH}(gitignore 里,别提交)
数据:data/steam.db(SQLite,直接 sqlite3 打开也能查)
`);
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  sync: cmdSync,
  serve: cmdServe,
  status: cmdStatus,
  guides: cmdGuides,
  'checkbox-sync': cmdCheckboxSync,
  audit: cmdAudit,
  import: cmdImport,
  export: cmdExport,
  log: cmdLog,
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};

const fn = COMMANDS[command];
if (!fn) {
  console.error(`未知命令:${command}\n`);
  cmdHelp();
  process.exit(1);
}

try {
  await fn();
} catch (err) {
  console.error('\n❌ ' + (err.message ?? err));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
