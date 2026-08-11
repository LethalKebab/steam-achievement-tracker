#!/usr/bin/env node
/**
 * Steam 成就追踪器 —— 本地版命令行入口
 * ------------------------------------------------
 * 零依赖:只用 Node 内置模块(node:sqlite 存数据,内置 fetch 调 Steam API,
 * node:http 起 Dashboard),不需要 npm install,不需要任何外部账号或部署。
 *
 *   node tracker.js init            填 Steam 凭据(只跑一次;--notion 填 Notion token,--ai 填 AI 供应商)
 *   node tracker.js sync            全量同步(库 + 成就完成数 + 成就详情;--fast 只查该查的)
 *   node tracker.js serve           起本地 Dashboard,数据太旧会自动后台同步
 *   node tracker.js status          看一眼当前数据和 AGCR
 *   node tracker.js import <目录>   从表格导出的 CSV 导入数据
 *   node tracker.js export [目录]   把三张表导出成 CSV
 *   node tracker.js guides          发现攻略页面(Notion 数据库 + 本地 guides/*.md)
 *   node tracker.js checkbox-sync   把已解锁成就同步成攻略里的 ✅(--dry-run 先预演)
 *   node tracker.js guide-status    攻略页状态对齐完成度:打满→Done,掉出100%→Staged
 *   node tracker.js audit           反查:有没有勾上了但其实没解锁的 checkbox(只读)
 *   node tracker.js ai-check        AI 联网研究链路自检(--dry 只组装不发送)
 *   node tracker.js guide-gen <appid>  让 AI 写一份攻略(--dry-run 只打印提示词,--overwrite 重写已有的)
 *   node tracker.js guide-to-notion <appid>  把本地 markdown 攻略搬到 Notion(--dry-run 只预览)
 *   node tracker.js log [n]         看最近的同步日志
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';

import { loadConfig, saveConfig, ROOT, CONFIG_PATH } from './lib/config.js';
import {
  openDb, allGames, allGuides, countGames, getMeta, recentSyncLog,
  getGame, achievementsFor, appIdsWithAchievements,
} from './lib/db.js';
import { SteamClient } from './lib/steam.js';
import { fullSync, syncLibrary, syncAchievementStats, syncAchievementSchema, computeAgcrStats } from './lib/sync.js';
import { serve } from './lib/server.js';
import { NotionClient } from './lib/notion.js';
import { checkboxSync, syncGuidesFromNotion, syncGuidesFromMarkdown, auditGuideTicks, syncGuideStatuses } from './lib/guides.js';
import { lintAllGuides } from './lib/guidelint.js';
import { createProvider, createSession, checkResult, formatUsage } from './lib/ai.js';
import { generateGuide, planGuide, buildSystemPrompt, DRAFTS_DIR } from './lib/guidegen.js';
import { planMigration, migrateGuideToNotion } from './lib/guidemigrate.js';
import {
  BACKUPS_DIR, overwritePreflight, formatPreflight, diffGuides, formatDiff,
} from './lib/guidebackup.js';
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

/** 取值型 flag —— 它们后面那个参数是值,不是位置参数(见 positionalArgs) */
const VALUE_FLAGS = new Set(['--rounds', '--file', '--model', '--provider', '--port']);

/**
 * 位置参数,排掉取值型 flag 的值。
 *
 * 不这么做的话 `guide-gen --rounds 2 1937500` 会把 2 当成 appid。
 * 全局那个 `positional` 是简单切分的,只有需要的命令用这个。
 */
function positionalArgs() {
  const args = argv.slice(1);
  return args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
}

/**
 * `--provider` / `--model` 覆盖配置。
 *
 * 有环境变量(AI_PROVIDER / AI_MODEL)还加 flag,是因为**环境变量的写法各 shell 不一样**:
 * `AI_MODEL=x node ...` 在 PowerShell 里直接报 CommandNotFound,得写成
 * `$env:AI_MODEL = "x"; node ...`,而且那样设了之后会在整个会话里赖着不走、
 * 悄悄盖掉 config.json。flag 没有这两个问题,哪个 shell 都一样。
 */
function applyAiFlags(config) {
  const provider = flagValue('provider');
  const model = flagValue('model');
  if (provider) {
    config.ai.provider = provider;
    // 换了供应商却没指定模型:config.json 里那个是给上一家的(claude-* vs gemini-* vs
    // deepseek-*),带过去必然报错。清掉,让新供应商用自己的默认值
    if (!model) config.ai.model = '';
  }
  if (model) config.ai.model = model;
  return config;
}

/**
 * 环境变量正在盖掉 config.json 的话,当场说出来。
 *
 * 环境变量在 shell 会话里会一直赖着,而 config.json 是肉眼看得见的那份 —— 两者不一致时,
 * 人看着文件、程序用着变量,谁也不知道差在哪。踩过:config.json 写着 deepseek,
 * PowerShell 会话里 $env:AI_PROVIDER 还留着 gemini,结果拿 gemini 的端点去请求
 * deepseek-chat,报出来的是一个完全指错方向的 404。
 */
function warnEnvOverrides() {
  const notes = [];
  for (const [name, label] of [['AI_PROVIDER', '供应商'], ['AI_MODEL', '模型']]) {
    if (process.env[name]) notes.push(`${label}来自环境变量 ${name}=${process.env[name]}(盖掉了 config.json)`);
  }
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY']) {
    if (process.env[name]) notes.push(`API key 可能来自环境变量 ${name}(盖掉了 config.json)`);
  }
  for (const n of notes) console.log(`  ⚠️  ${n}`);
  if (notes.length) {
    console.log('      清掉:Remove-Item Env:AI_PROVIDER, Env:AI_MODEL -ErrorAction SilentlyContinue');
  }
}

/** 供应商实例。`--dry` / `--dry-run` 不发请求,所以没 key 也要能造出来 */
async function providerFor(config, { needKey = true } = {}) {
  const ai = !needKey && !config.ai.apiKey ? { ...config.ai, apiKey: '(dry-run,不会发送)' } : config.ai;
  return createProvider({ ai });
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

/** 供应商选项。顺序就是推荐顺序,第一个是默认 */
const AI_PROVIDERS = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    note: '有联网搜索,便宜。key 在 https://platform.deepseek.com/api_keys',
    env: 'DEEPSEEK_API_KEY',
  },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    note: '有联网搜索,质量最好也最贵。key 在 https://platform.claude.com/settings/keys',
    env: 'ANTHROPIC_API_KEY',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    note: '有免费额度,但实测免费层常常拿不到能用的模型。https://aistudio.google.com/apikey',
    env: 'GEMINI_API_KEY',
  },
];

/**
 * `init --ai`:配置攻略生成用的 AI 供应商。
 *
 * **当场用真请求验证**,而不是写完就完 —— 这个功能的失败模式(key 无效、模型名不对、
 * 这一档没额度、端点不认某个工具)全都长得不一样,而且全都要发一次请求才知道。
 * 让人在 `init` 的时候花几分钱撞上,好过在生成一份攻略跑到一半的时候撞上。
 */
async function cmdInitAi() {
  const io = makeSecretReader();
  try {
    console.log('\n配置 AI 攻略生成\n');
    console.log('这个功能会调用 AI 联网查资料并写攻略,**要花钱**(免费额度的除外)。');
    console.log('不用这个功能的话,整个项目的其他部分都不需要它。\n');

    AI_PROVIDERS.forEach((p, i) => {
      console.log(`  ${i + 1}) ${p.label.padEnd(20)} ${p.note}`);
    });
    const pick = (await io.ask(`\n选一个(1-${AI_PROVIDERS.length},回车用 1): `)) || '1';
    const chosen = AI_PROVIDERS[Number(pick) - 1];
    if (!chosen) throw new Error(`没有第 ${pick} 个选项`);

    const key = await io.askSecret(`${chosen.label} API Key(输入不会显示): `);
    if (!key) throw new Error('没输入 key');

    const model = await io.ask('模型名(回车用这一家的默认值): ');

    const ai = { provider: chosen.key, apiKey: key.trim(), model: model.trim() };
    const provider = await createProvider({ ai: { ...loadConfig().ai, ...ai } });

    // 真发一次请求。问题最小化:不挂联网工具、只要一个字
    stdout.write(`\n正在验证(模型 ${provider.model})…`);
    const r = await provider.send({ messages: [{ role: 'user', content: '回复一个字:好' }] });
    const verdict = checkResult(r);
    if (!verdict.ok) throw new Error(`验证没通过:${verdict.reason}`);
    console.log(`\r✅ 可用:${provider.name} / ${provider.model},回了「${r.text.trim().slice(0, 10)}」      `);
    console.log(`   ${formatUsage(r.usage)}`);

    // model 留空就不写进 config,让代码里的默认值继续生效(那个会跟着版本更新)
    saveConfig({ ai: model.trim() ? ai : { provider: ai.provider, apiKey: ai.apiKey } });
    console.log(`\n✅ 已写入 ${CONFIG_PATH}(已 gitignore,不会被提交)`);
    console.log('\n接下来:');
    console.log('  node tracker.js ai-check              ← 验证联网搜索真的能用(重点看有没有发出搜索)');
    console.log('  node tracker.js guide-gen <appid>     ← 生成一份攻略(会先问你一句才开始花钱)');
    console.log(`\n(不想把 key 写进文件的话,也可以用环境变量 ${chosen.env}=… 临时覆盖)`);
  } finally {
    io.close();
  }
}

async function cmdInit() {
  if (flags.has('--notion')) return cmdInitNotion();
  if (flags.has('--ai')) return cmdInitAi();
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
  const { config, db, steam } = withSteam();
  const p = progressPrinter();
  const onProgress = makeProgressHandler(p);
  const only = ['library', 'achievements', 'schema'].filter((f) => flags.has('--' + f));

  // 默认全量:命令行得留一个"跑完肯定什么都不漏"的入口。
  // --fast 用和 Dashboard 自动同步一样的取样规则(见 lib/sync.js selectStatsTargets)
  const selection = flags.has('--fast')
    ? {
        sweepBudget: config.sweepBudget,
        maxStatsAgeDays: config.maxStatsAgeDays,
        perfectGameMaxAgeDays: config.perfectGameMaxAgeDays,
      }
    : null;

  console.log(
    selection
      ? '开始同步(--fast:只查玩过的 + 轮换复查一批)\n'
      : '开始同步(Ctrl+C 可以随时停,已经写进库的数据不会丢)\n'
  );
  const t0 = Date.now();

  if (only.length === 0) {
    const r = await fullSync(db, steam, { onProgress, selection });
    p.done();
    console.log(`  库:owned ${r.library.ownedCount} 款(Unvetted ${r.library.unvettedCount} 款),新增 ${r.library.added.length} 款,Unvetted 标记更新 ${r.library.restamped} 处`);
    if (r.library.added.length) console.log(`     新增:${r.library.added.map((a) => a.name).join('、')}`);
    console.log(`  成就完成数:更新 ${r.stats.updated} 款,无成就系统 ${r.stats.noSystem} 款,留待重试 ${r.stats.retried} 款`);
    const s = r.stats.selection;
    if (s.gated) {
      console.log(`     取样:查了 ${s.total} 款(玩过 ${s.played} / 不在 owned ${s.unowned} / 轮换复查 ${s.swept})` + (s.sweepPending ? `,${s.sweepPending} 款排队等下次` : ''));
    }
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

/**
 * 让 Notion 攻略页状态和完成度对齐:打满 → Done,掉出 100% → Staged。
 * 按当前状态收敛(不是抓"刚好这轮跨过 100%"的瞬间),所以重复跑是安全的 no-op。
 */
async function cmdGuideStatus() {
  const { config, db } = withSteam({ requireSteam: false });
  const notion = new NotionClient(config);
  if (!notion.configured) {
    return console.log('Notion:没配 token(config.json 的 notion.token / notion.overviewDbId)');
  }
  const dryRun = flags.has('--dry-run');
  if (dryRun) console.log('预演模式:只算不写\n');

  const r = await syncGuideStatuses(db, { notion, dryRun });
  const up = r.updates.filter((u) => u.reason === 'complete').length;
  const down = r.updates.filter((u) => u.reason === 'incomplete').length;
  console.log(`攻略数据库 ${r.pages} 个页面:${up} 个该标 Done,${down} 个该退回 Staged`);
  for (const l of r.logs) console.log(`  ${l.gameName} — ${l.result}`);
  if (!r.updates.length) console.log('  (没有要改的,状态和完成度已经一致)');
  else if (dryRun) console.log('\n确认没问题就去掉 --dry-run 再跑一次。');
}

async function cmdCheckboxSync() {
  const { config, db, steam } = withSteam();
  const notion = new NotionClient(config);
  const appid = positional[0] ?? null;
  const dryRun = flags.has('--dry-run');
  const cascade = !flags.has('--no-cascade');
  const p = progressPrinter();

  if (dryRun) console.log('预演模式:只读攻略页面算出会勾哪些,不写任何东西\n');
  if (!cascade) console.log('已关闭子步骤联动:只按成就名/描述匹配勾选\n');

  const r = await checkboxSync(db, steam, {
    notion,
    config,
    appid,
    dryRun,
    cascade,
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

/** guidelint 的 code → 人话。逐份汇总和总表共用一套,免得两处叫法对不上 */
const CODE_LABELS = {
  'missing-checkbox': '成就没有 checkbox,永远勾不上',
  'merged-line': '一行里写了多个 checkbox',
  'ambiguous-no-description': '同名成就没抄描述,分不出是哪一个',
  'checked-mismatch': '勾选状态和真实解锁不一致',
  'missing-title': '本地攻略缺 `# 游戏名`',
  'paraphrased-description': '描述不是原文照抄,audit 反查不了',
  'stats-in-heading': '节标题里有会过期的统计数字',
  'data-source-note': '写了勾选状态的数据来源',
};

/**
 * 只读校验:攻略本身写得对不对(和 audit 查"勾错了没"、checkbox-sync 查"漏勾没"是三件事)。
 * 不写数据库、不碰 Notion、不改本地 md,所以不需要 --dry-run。
 */
async function cmdGuideLint() {
  // 默认不需要 Steam 凭据:只有 --checked 那条规则要真实解锁状态
  const checkTicks = flags.has('--checked');
  const { config, db, steam } = withSteam({ requireSteam: checkTicks });
  const notion = new NotionClient(config);
  const appid = positional[0] ?? null;
  const p = progressPrinter();

  console.log('校验攻略写法(只读,不会改任何东西)');
  if (checkTicks) console.log('已开启勾选状态校验:每款游戏都要单独问一次 Steam,会慢不少\n');
  else console.log('(勾选状态默认不校验,要的话加 --checked)\n');

  const { results, totals } = await lintAllGuides(db, {
    notion,
    config,
    steam: checkTicks ? steam : null,
    appid,
    onProgress: (ev) => p.update(`  ${ev.done}/${ev.total} ${ev.name}`),
  });
  p.done();

  // 指定了 appid 就把这一份的问题逐条列出来;否则每份只按类型报个数——
  // 全量下光"缺 checkbox"和"描述没照抄"就有九百多条,平铺出来等于没有输出
  const detail = Boolean(appid);
  for (const r of results) {
    if (r.skipped) {
      if (detail) console.log(`  ⏭  ${r.name} —— 跳过:${r.skipped}`);
      continue;
    }
    const { findings, stats } = r.lint;
    if (findings.length === 0 && !detail) continue;

    const mark = stats.errors ? '❌' : findings.length ? '⚠️ ' : '✅';
    console.log(
      `\n  ${mark} ${r.name}(${r.appid})  ${stats.covered}/${stats.achievements} 覆盖,${stats.todos} 个框`
    );
    if (detail) {
      for (const f of findings) console.log(`     ${f.level === 'error' ? '✖' : '·'} ${f.message}`);
      continue;
    }
    const byCode = new Map();
    for (const f of findings) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}  ${CODE_LABELS[code] ?? code}`);
    }
  }
  if (!detail && results.some((r) => !r.skipped && r.lint.findings.length)) {
    console.log('\n  (逐条看某一份:guide-lint <appid>)');
  }

  console.log(
    `\n校验了 ${totals.guides} 份攻略:${totals.noErrors} 份没有 error` +
      `(其中 ${totals.clean} 份连 warn 都没有)`
  );
  if (totals.skipped) {
    console.log(`  跳过 ${totals.skipped} 份(多半是 100% 通关的游戏,成就详情没同步,没有可比对的基准)`);
  }
  if (totals.achievements) {
    const pct = ((totals.covered / totals.achievements) * 100).toFixed(1);
    console.log(`  成就覆盖:${totals.covered}/${totals.achievements}(${pct}%)`);
  }
  const entries = Object.entries(totals.byCode).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    console.log(`\n  按问题类型:`);
    for (const [code, n] of entries) {
      console.log(`    ${String(n).padStart(4)}  ${CODE_LABELS[code] ?? code}`);
    }
  }
  if (totals.errors === 0) console.log('\n没有 error。');
  else console.log(`\n合计 ${totals.errors} 个 error、${totals.warnings} 个 warn。改的是攻略内容,不是代码。`);
}

/** 挑一个有成就详情的游戏来做冒烟测试。没指定 appid 就拿库里第一个能用的 */
function pickSmokeTarget(db, appid) {
  if (appid) {
    const defs = achievementsFor(db, appid);
    if (!defs.length) {
      throw new Error(`appid ${appid} 还没有成就详情。先跑 \`node tracker.js sync --schema\``);
    }
    return { appid: String(appid), name: getGame(db, appid)?.name || defs[0].game_name || String(appid), defs };
  }
  const withAch = appIdsWithAchievements(db);
  for (const g of allGames(db)) {
    if (!withAch.has(String(g.appid))) continue;
    const defs = achievementsFor(db, g.appid);
    if (defs.length) return { appid: String(g.appid), name: g.name || String(g.appid), defs };
  }
  throw new Error('数据库里一条成就详情都没有。先跑 `node tracker.js sync --schema`');
}

/**
 * `ai-check`:把 lib/ai.js 整条链路真跑一遍——组装请求 → 服务端搜索 → 抓页 →
 * pause_turn 续跑 → token 用量。
 *
 * 这是「动手顺序」第 3 步的验收命令,不是攻略生成本身:它只问一个成就,拿三句话回来。
 * 攻略怎么写是 guidegen(下一步)的事。**要花钱**,所以 `--dry` 只组装不发送,
 * 先看清楚会发出去什么、用哪个模型、带哪些工具。
 */
async function cmdAiCheck() {
  const dry = flags.has('--dry');
  // --dry 不需要 key:它的用处正是"还没配 key 时先看清楚会发什么"
  const config = applyAiFlags(loadConfig({ required: dry ? [] : ['ai'] }));

  // --models:直接问 API 有哪些模型可用。写 Gemini 那家的时候文档拿不到,模型名只能靠
  // 记忆猜,所以留了这条路——猜错了不用改代码,问一句就知道
  if (flags.has('--models')) {
    const provider = await createProvider(config);
    if (typeof provider.listModels !== 'function') {
      throw new Error(`${provider.name} 没有列模型的接口(目前只有 gemini 有)`);
    }
    const models = await provider.listModels();
    console.log(`\n${provider.name} 列出来的模型(${models.length} 个):\n`);
    for (const m of models) {
      const limits = m.inputLimit ? `  输入上限 ${m.inputLimit} / 输出上限 ${m.outputLimit}` : '';
      console.log(`  ${m.name.padEnd(34)}${m.display}${limits}`);
    }
    // 实测:2.5 系列对新 key 已停售,但照样出现在这个列表里。这个接口只说"存在",
    // 不说"你能不能用"——不写清楚会让人对着列表反复试
    console.log(
      `\n⚠️  列出来 ≠ 能用。这个接口只说模型存在,不反映你的 key 有没有权限或额度:\n` +
        '    · 老版本可能已经"对新用户停止提供"(实测 2.5 系列)\n' +
        '    · 有的在你这一档额度是 0(实测 Pro 系列在免费层)\n' +
        '    真跑一次 `ai-check` 才知道。'
    );
    console.log(`\n当前用的是 ${provider.model}。临时换:--model <名字>;固定换:改 config.json 的 ai.model。`);
    return;
  }

  const db = openDb(config.dbPath);
  const target = pickSmokeTarget(db, positionalArgs()[0] ?? null);
  const def = target.defs.find((d) => d.description) ?? target.defs[0];
  const achName = def.name_cn || def.name_en || def.api_name;

  const system =
    '你在帮一个 Steam 成就攻略作者做资料调研。回答用中文,只讲怎么达成,不要寒暄和总结段。';
  const question =
    `游戏《${target.name}》(appid ${target.appid})的成就「${achName}」` +
    (def.description ? `,官方描述是「${def.description}」` : '') +
    // 不点名具体工具:两家的工具叫法不一样,写死一家的名字会让另一家看不懂
    '。请先上网搜一下这个成就的攻略,能抓到正文的话读一读,然后用三句话讲清楚怎么拿到它。';

  const provider = await providerFor(config, { needKey: !dry });
  const tools = provider.webTools();

  if (dry) {
    const body = provider.buildBody({ system, messages: [{ role: 'user', content: question }], tools });
    console.log(`\n只组装不发送(--dry)。供应商 ${provider.name},模型 ${provider.model}。`);
    console.log(`API key:${config.ai.apiKey ? '已配置(不打印)' : '**没配置**'}\n`);
    console.log('请求体:');
    console.log(JSON.stringify(body, null, 2));
    console.log('\n真跑一次:去掉 --dry。');
    return;
  }

  console.log(`\n供应商 ${provider.name} · 模型 ${provider.model} · 联网工具 ${tools.length} 个`);
  warnEnvOverrides();
  console.log(`题目:《${target.name}》的成就「${achName}」\n`);

  const session = createSession(provider, { system, tools });
  const t0 = Date.now();
  const r = await session.ask(question, {
    onEvent(ev) {
      // 联网 + 深度思考,几分钟不出声是常态。把工具活动打出来,不然分不清"在干活"和"卡住了"
      if (ev.type === 'tool') stdout.write(`\n  → ${ev.name} …`);
      else if (ev.type === 'tool-result') stdout.write(ev.ok ? ' ok' : ` 失败(${ev.errorCode})`);
      else if (ev.type === 'search') stdout.write(`\n  🔎 ${ev.query}`);
      else if (ev.type === 'text') stdout.write(ev.text);
    },
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const verdict = checkResult(r);
  console.log('\n\n' + '─'.repeat(60));
  console.log(verdict.ok ? '✅ 端到端跑通' : `❌ 这轮不能用:${verdict.reason}`);
  console.log(
    `  stop_reason: ${r.stopReason}${r.rawStopReason && r.rawStopReason !== r.stopReason ? `(原值 ${r.rawStopReason})` : ''}` +
      ` · 续跑 ${r.continuations} 次 · 耗时 ${secs}s`
  );
  console.log('  ' + formatUsage(session.usage));

  // 这一行是这个命令最该看的:**声明了联网工具,模型到底搜没搜**。
  // 免费层带不带联网是文档上查不准的事,回包比定价页可靠
  if (r.searchQueries?.length) {
    console.log(`  🔎 实际发出 ${r.searchQueries.length} 次搜索:${r.searchQueries.slice(0, 5).join(' / ')}`);
  } else if (tools.length) {
    console.log('  ⚠️  声明了联网工具,但这一轮一次搜索都没发出去 —— 可能是这个层级/模型不支持,');
    console.log('      也可能是模型觉得不用查。攻略生成如果一直这样,内容就是它凭记忆编的');
  }
  for (const e of r.toolErrors ?? []) console.log(`  ⚠️  ${e.tool} 报错:${e.errorCode}`);
}

/**
 * `guide-gen <appid>`:让 AI 写一份本地 markdown 攻略。
 *
 * **会花钱**,所以默认要人工确认一次(`--yes` 跳过),`--dry-run` 则只打印会发出去的
 * 提示词和落盘计划、一个请求都不发。
 *
 * 这里一度有一套花费上限(每次 / 每天,token 和美元各一组)和一张模型单价表,
 * 现在整套删了:单价我们核实不过来、搜索工具怎么计费也没实测,于是那些"上限"
 * 建立在一个连我们自己都不信的金额上。跑完只报 token 数 —— 那是 API 回的硬数字。
 */
async function cmdGuideGen() {
  const appid = positionalArgs()[0];
  if (!appid) {
    throw new Error('用法:node tracker.js guide-gen <appid> [--dry-run] [--yes] [--local] [--overwrite]');
  }
  const dryRun = flags.has('--dry-run');
  const overwrite = flags.has('--overwrite');

  const config = applyAiFlags(loadConfig({ required: dryRun ? ['steam'] : ['steam', 'ai'] }));
  const db = openDb(config.dbPath);
  const steam = new SteamClient(config, { log: () => {} });
  const notion = new NotionClient(config);
  const local = flags.has('--local');
  const rounds = Number(flagValue('rounds') ?? config.ai.maxRounds ?? 3);
  const fileName = flagValue('file') ?? null;

  const plan = await planGuide(db, { config, steam, appid, fileName, notion, local, overwrite });

  console.log(`\n《${plan.game}》(appid ${appid})`);
  console.log(`  成就 ${plan.defs.length} 个,其中已解锁 ${plan.unlocked.size} 个(用来机械打勾,不会喂给模型)`);
  if (plan.unnameable.size) {
    console.log(`  ${plan.unnameable.size} 个成就名字在本作里撞车,机械打勾够不着——它们的框会留空,这是已知的`);
  }
  // 「有服务端搜索」是设计文档定的硬性准入,理由是"混进一家没有搜索的,会让质量取决于
  // 用户选了谁,而用户看不出这个差别"。所以不能默认放行,得让人**明确知道自己在要什么**
  const probe = await providerFor(config, { needKey: !dryRun });

  // 打供应商解析后的模型名,不是 config 里那个:换 provider 没指定 model 时
  // config 里是空的,真正用的是这一家的默认值
  console.log(`  ${probe.name} · 模型 ${probe.model} · 最多改 ${rounds} 轮`);
  warnEnvOverrides();
  if (plan.existing) {
    // 覆盖是这条命令里唯一不可逆的动作,所以它自己占一段,而且**在问"继续吗"之前**印出来
    const where = plan.existing.kind === 'notion' ? 'Notion 页面' : '本地文件';
    console.log(`\n  ⚠️  覆盖已有攻略(${where}:${plan.existing.url})`);
    console.log(formatPreflight(overwritePreflight(plan), { defsCount: plan.defs.length }));
    console.log(`  原文会先备份进 ${join(config.guidesDir, BACKUPS_DIR)}/,备份失败就不会动它`);
    if (plan.existing.kind === 'notion') {
      console.log('  Notion 删块是归档,30 天内还能在 Notion 回收站里找回来');
    }
  } else if (plan.target === 'notion') {
    console.log(
      plan.notion.existingPage
        ? `  写进 Notion 已有的空页:${plan.notion.existingPage.url}`
        : '  在 Notion 攻略库里新建一页(要写本地文件就加 --local)'
    );
  } else {
    console.log(`  落盘到 ${plan.finalPath}`);
  }

  if (probe.canSearch === false && !flags.has('--no-research')) {
    throw new Error(
      `${probe.name} 没有服务端联网搜索,生成出来的攻略是模型**凭已有知识写的**,不是查来的。\n` +
        '  这类攻略的步骤、数值、地点都无法核实,而格式校验一个字都验不出来。\n\n' +
        '  真要这么跑(比如只是想验证流水线本身),加 --no-research 明说:\n' +
        `    node tracker.js guide-gen ${appid} --no-research\n\n` +
        '  想要经过调研的攻略,换一家有联网的:--provider anthropic 或 --provider gemini。'
    );
  }
  if (probe.canSearch === false) {
    console.log('  ⚠️  --no-research:这一份不会经过任何联网调研,内容全靠模型的已有知识');
  }

  if (dryRun) {
    console.log('\n--dry-run:不发任何请求。会发过去的 system 提示词:\n');
    console.log('─'.repeat(70));
    console.log(buildSystemPrompt(plan.game, String(appid), plan.defs, { canSearch: probe.canSearch !== false }));
    console.log('─'.repeat(70));
    return;
  }

  if (!flags.has('--yes')) {
    // 花钱的操作默认问一句。这是唯一的闸门 —— 上限那一套删掉了(见上面的说明)。
    // 覆盖的时候这句话还要多担一件事:它同时是那次不可逆写入的人工确认
    const io = makeSecretReader();
    const answer = await io.ask(
      plan.existing
        ? `\n这一步会调用 AI 并产生费用,而且会**覆盖《${plan.game}》现在那份攻略**。继续?(y/N)`
        : '\n这一步会调用 AI 并产生费用。继续?(y/N)'
    );
    io.close();
    if (!/^y(es)?$/i.test(answer)) return console.log('取消了。');
  }

  const provider = probe;
  const p = progressPrinter();
  const started = Date.now();

  const r = await generateGuide(db, {
    config, provider, steam, appid, rounds, fileName, notion, local, overwrite, plan,
    onProgress(ev) {
      if (ev.phase === 'ask') p.update(`  第 ${ev.round}/${ev.rounds} 轮:联网研究 + 撰写…`);
      else if (ev.phase === 'tool') p.update(`  第 ${ev.round} 轮:${ev.name}…`);
      else if (ev.phase === 'check') p.update(`  第 ${ev.round} 轮:机械打勾 + 校验…`);
      else if (ev.phase === 'lint') {
        p.done(`  第 ${ev.round} 轮:勾上 ${ev.ticked} 个框,还剩 ${ev.blocking} 条要改`);
      } else if (ev.phase === 'notion-create' || ev.phase === 'notion-fill') {
        p.update(`  写进 Notion(${ev.blocks} 个块)…`);
      } else if (ev.phase === 'backup') p.update('  备份原文…');
      else if (ev.phase === 'backup-done') p.done(`  原文已备份:${ev.path}(${ev.bytes} 字节)`);
      else if (ev.phase === 'notion-clear') p.update(`  清掉页面上原来的 ${ev.blocks} 个块…`);
    },
  });
  p.done();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('\n' + '─'.repeat(70));
  if (r.ok) {
    console.log(`✅ 写完了,${r.rounds} 轮 · ${secs}s → ${r.url}`);
    if (r.overwrote) {
      // 覆盖之后才算得出真正的新旧对照 —— 花钱前那份预检只能讲旧的那一半。
      // 这一段是给"我到底换掉了什么"一个可以当场核对的答案,备份路径就在下面
      console.log('\n  覆盖前后对照:');
      console.log(formatDiff(diffGuides({
        oldTodos: plan.oldTodos,
        newTodos: r.todos,
        defs: plan.defs,
        oldText: plan.oldText,
        newText: r.text,
      })));
      if (r.backup) console.log(`  原文备份:${r.backup.path}`);
    }
    if (r.registered) console.log(`  已登记进 guides 表(${r.registered.action ?? '新增'}),Dashboard 上就能看到链接了`);
    else console.log('  ⚠️  没被 guides 发现逻辑收进去,手动跑一次 `node tracker.js guides --local` 看看为什么');
    // 转换器认不出来的行没丢,但排版降级成了普通段落。用户有权知道是哪几行
    if (r.unconverted.length) {
      console.log(`  ⚠️  ${r.unconverted.length} 行 Notion 放不下原来的排版,已经降级成普通段落(内容没丢):`);
      for (const line of r.unconverted.slice(0, 5)) console.log(`       ${line}`);
    }
  } else {
    console.log(`❌ ${r.rounds} 轮之后仍有 ${r.blocking.length} 条没过,草稿留在 ${r.draftPath}`);
    console.log('  (草稿目录不会被攻略发现逻辑扫到,不会被同步拿去勾框)');
    for (const f of r.blocking.slice(0, 15)) console.log(`     ✖ ${f.message}`);
    if (r.blocking.length > 15) console.log(`     …… 另外 ${r.blocking.length - 15} 条`);
  }
  if (r.expected.length) {
    console.log(`  ${r.expected.length} 条"已解锁但没勾"是预期内的:这些成就名在本作里撞车,机械打勾够不着`);
  }
  if (r.lint?.stats) {
    console.log(`  覆盖 ${r.lint.stats.covered}/${r.lint.stats.achievements} 个成就,` +
      `${r.lint.stats.warnings} 条 warn`);
  }
  console.log('  ' + formatUsage(r.usage));
  console.log('\n⚠️  机器只验了格式和数据:每个成就有独立 checkbox、名字对得上、描述是原文、' +
    '勾选等于真实解锁。\n    **攻略内容本身没有验证过** —— 步骤可不可行、难度准不准、' +
    '"易错过"是不是真的,都要你自己看一遍。');
  // **能搜 ≠ 搜了。** canSearch 只说供应商有这个能力,searchQueries 才是它真发出去的。
  // 不报的话,"声明了工具但一次没搜"就变成一个看不出来的质量差别 —— 正是 canSearch
  // 那套设计要防的东西
  if (!r.researched) {
    console.log('    而且这一份**完全没有经过联网调研**,内容是模型凭已有知识写的,' +
      '可信度比查过资料的低一档。');
  } else if (!r.searchQueries?.length) {
    console.log('    ⚠️  而且**这一轮模型一次搜索都没发出去** —— 工具挂上了但它没用,' +
      '内容实际上等同于凭记忆写的。');
  } else {
    console.log(`\n🔎 实际发出 ${r.searchQueries.length} 次搜索,前几条:` +
      r.searchQueries.slice(0, 4).join(' / '));
  }
}

/**
 * 把一份本地 markdown 攻略搬到 Notion。
 *
 * `--dry-run` 是推荐的第一步:转换会不会掉排版、Notion 那边接不接得住,
 * 预览里全看得见,而且一个字节都不写。
 */
async function cmdGuideToNotion() {
  const appid = positionalArgs()[0];
  if (!appid) throw new Error('用法:node tracker.js guide-to-notion <appid> [--dry-run] [--yes]');
  // steam 是给页面图标用的(建页时补一个 Steam 游戏图标,和 guide-gen 建的页一致)
  const { config, db, steam } = withSteam();
  const notion = new NotionClient(config);

  const plan = await planMigration(db, { notion, config, appid });
  const checked = plan.todos.filter((t) => t.checked).length;

  console.log(`\n《${plan.game}》(appid ${appid})`);
  console.log(`  来源:${plan.path}`);
  console.log(`  ${plan.todos.length} 个 checkbox,其中 ${checked} 个已勾选(勾选状态原样带过去)`);
  console.log('  转换成 ' + Object.entries(plan.byType).map(([k, n]) => `${n} 个 ${k}`).join('、'));
  console.log(
    plan.target.existingPage
      ? `  写进 Notion 上已有的空页:${plan.target.existingPage.url}`
      : '  在 Notion 攻略库里新建一页'
  );
  if (plan.unconverted.length) {
    console.log(`  ⚠️  ${plan.unconverted.length} 行 Notion 放不下原来的排版,会降级成普通段落(文字不丢):`);
    for (const line of plan.unconverted.slice(0, 8)) console.log(`       ${line}`);
  }

  if (flags.has('--dry-run')) return console.log('\n--dry-run:什么都没写。');

  if (!flags.has('--yes')) {
    const io = makeSecretReader();
    const answer = await io.ask('\n搬过去?本地文件会挪进 guides/.migrated/(不删)(y/N)');
    io.close();
    if (!/^y(es)?$/i.test(answer)) return console.log('取消了。');
  }

  const r = await migrateGuideToNotion(db, {
    notion, steam, config, appid, plan,
    onProgress(ev) {
      if (ev.phase === 'create') console.log(`  建好页面,写 ${ev.blocks} 个块…`);
      else if (ev.phase === 'fill') console.log(`  填进已有的空页,写 ${ev.blocks} 个块…`);
      else if (ev.phase === 'verify') console.log('  回读逐条核对…');
    },
  });

  console.log(`\n✅ 搬完了,${r.count} 个 checkbox 逐条核对一致 → ${r.url}`);
  console.log(
    r.archivedTo
      ? `  本地文件挪到 ${r.archivedTo}(没删)`
      : '  ⚠️  本地文件没挪成,留在原地了 —— 不影响,发现逻辑不会把攻略抢回本地'
  );
}

/**
 * `drafts`:看看 `guides/.drafts/` 里堆了什么,`--clean` 清掉。
 *
 * 草稿目录是**故意**会留东西的:三轮没过的攻略留在这儿,因为"丢弃等于烧掉钱和时间
 * 还什么都不留",而且"哪条没过"本身有信息量。但留下的东西没人清就会一直堆着 ——
 * 实测堆了三份几个月前做 A/B 对比用的文件,早就没人记得是干嘛的了。
 *
 * **默认只列不删。** 这个目录里躺的是花钱生成出来的东西,删要说出口。
 * `--older-than N` 只动 N 天前的,今天刚失败的那份不会被顺手带走。
 */
function cmdDrafts() {
  const config = loadConfig({ required: [] });
  const dir = join(config.guidesDir, DRAFTS_DIR);
  if (!existsSync(dir)) return console.log('草稿目录还不存在,没什么可清的。');

  const days = Number(flagValue('older-than') ?? 0);
  const cutoff = Date.now() - days * 86400_000;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const path = join(dir, f);
      const { mtime, size } = statSync(path);
      return { f, path, mtime, size, ageDays: Math.floor((Date.now() - mtime.getTime()) / 86400_000) };
    })
    .sort((a, b) => a.mtime - b.mtime);

  if (!files.length) return console.log('草稿目录是空的。');

  const doomed = files.filter((x) => x.mtime.getTime() < cutoff);
  console.log(`\n${join(config.guidesDir, DRAFTS_DIR)}:${files.length} 份草稿\n`);
  for (const x of files) {
    const mark = flags.has('--clean') && doomed.includes(x) ? '删' : '  ';
    console.log(`  ${mark} ${String(x.ageDays).padStart(4)} 天前  ${String(x.size).padStart(7)} B  ${x.f}`);
  }

  if (!flags.has('--clean')) {
    console.log('\n草稿不会被攻略发现逻辑扫到,留着不影响任何东西 —— 只是会一直堆着。');
    console.log('要清:node tracker.js drafts --clean [--older-than N]');
    return;
  }
  if (!doomed.length) return console.log(`\n没有超过 ${days} 天的草稿,什么都没删。`);

  for (const x of doomed) rmSync(x.path, { force: true });
  console.log(`\n✅ 删了 ${doomed.length} 份,还剩 ${files.length - doomed.length} 份。`);
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
              init --ai                   填 AI 供应商和 key(只有要用攻略生成才需要)
  node tracker.js sync                    全量同步:库 + 成就完成数 + 成就详情
              sync --fast                 只查玩过的 + 轮换复查一批(和 Dashboard 一样)
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
              checkbox-sync --no-cascade  别联动勾选嵌套的子步骤 checkbox
  node tracker.js guide-status            攻略页状态对齐完成度(打满→Done,掉出100%→Staged)
              guide-status --dry-run      只算不写,先看会改哪些
  node tracker.js audit [appid]           反查有没有勾上了但其实没解锁的 checkbox(只读)
  node tracker.js guide-lint [appid]      校验攻略写法:成就有没有漏、格式对不对(只读)
              guide-lint --checked        连勾选状态一起校验(每款游戏要单独问 Steam,慢)
  node tracker.js guide-to-notion <appid> 把本地 markdown 攻略搬到 Notion(逐条核对后才动本地文件)
              guide-to-notion --dry-run   只预览转换结果,一个字节都不写
  node tracker.js ai-check [appid]        AI 联网研究链路自检(token 用量会打出来)
              ai-check --dry              只组装请求不发送,先看清楚会发什么(不用 key)
              ai-check --models           问 API 这个 key 能用哪些模型(gemini)
              --provider X --model Y      临时换供应商/模型,不改 config.json
                                          (ai-check 和 guide-gen 都支持)
  node tracker.js guide-gen <appid>       让 AI 写一份本地攻略(会花钱,默认先问一句)
              guide-gen --dry-run         只打印提示词和落盘计划,一个请求都不发
              guide-gen --overwrite       重写已有的那份攻略(先备份原文,再告诉你会失去什么)
              guide-gen --yes             跳过确认;--rounds N 改重写轮数;--file 换文件名
  node tracker.js drafts                  列出 guides/.drafts/ 里堆的草稿(只列不删)
              drafts --clean              清掉;--older-than N 只清 N 天前的
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
  'guide-status': cmdGuideStatus,
  'guide-lint': cmdGuideLint,
  'ai-check': cmdAiCheck,
  'guide-gen': cmdGuideGen,
  'guide-to-notion': cmdGuideToNotion,
  drafts: cmdDrafts,
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
  // **不要用 process.exit()。** 强行退出会在 socket / 定时器还在拆除的时候打断 libuv,
  // Windows 上表现为 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" ——
  // 而且是在错误信息打完之后才崩,看起来像两件不相干的事。
  // 设 exitCode 让 Node 自然退出,退出码一样是 1
  process.exitCode = 1;
}
