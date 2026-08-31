#!/usr/bin/env node
/**
 * Steam achievement tracker — local CLI entry point
 * ------------------------------------------------
 * Zero dependencies: Node built-ins only (node:sqlite for storage, the built-in fetch for the Steam
 * API, node:http for the Dashboard). No npm install, no external account, no deployment.
 *
 *   node tracker.js init            enter Steam credentials (run once; --notion for a Notion token, --ai for an AI provider)
 *   node tracker.js sync            full sync (library + achievement counts + achievement detail; --fast checks only what needs checking)
 *   node tracker.js serve           start the local Dashboard; syncs in the background when the data is stale
 *   node tracker.js status          a quick look at the current data and AGCR
 *   node tracker.js export [dir]    export the three tables as CSV
 *   node tracker.js backup [dir]    write a backup zip (for a new machine or a reinstall)
 *   node tracker.js restore <file>  restore from a backup zip
 *   node tracker.js guides          discover guide pages (the Notion database + local guides/*.md)
 *   node tracker.js checkbox-sync   tick unlocked achievements in the guides (--dry-run previews first)
 *   node tracker.js guide-status    align guide page status with completion: 100% → Done, dropped below → Staged
 *   node tracker.js notion-check    health check on the Notion side (token/database/properties/options; --fix adds options, --probe-write tries a write)
 *   node tracker.js audit           reverse lookup: any ticked checkbox whose achievement is not actually unlocked (read-only)
 *   node tracker.js ai-check        self-check of the AI online-research chain (--dry assembles without sending)
 *   node tracker.js guide-gen <appid>  have the AI write a guide (--dry-run prints the prompt only, --overwrite rewrites the whole thing,
 *                                     --only <selector> [--note "requirement"] rewrites just a few entries)
 *   node tracker.js guide-to-notion <appid>  move a local markdown guide into Notion (--dry-run previews only)
 *   node tracker.js log [n]         show the recent sync log
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';

import { loadConfig, saveConfig, switchAiProvider, ROOT, DATA_ROOT, CONFIG_PATH } from './lib/config.js';
import {
  openDb, allGames, allGuides, countGames, getMeta, recentSyncLog,
  getGame, achievementsFor, appIdsWithAchievements,
} from './lib/db.js';
import { SteamClient } from './lib/steam.js';
import { fullSync, syncLibrary, syncAchievementStats, syncAchievementSchema, computeAgcrStats } from './lib/sync.js';
import { setMessageLanguage, achName } from './lib/messages.js';
import { serve } from './lib/server.js';
import {
  NotionClient,
  pickGuideDbProperties,
  GUIDE_STATUS_OPTIONS,
  inspectGuideDb,
  repairGuideDb,
  GUIDE_STATUS_STYLE,
  COLOUR_ZH,
  DB_PROBLEM,
} from './lib/notion.js';
import { checkboxSync, syncGuidesFromNotion, syncGuidesFromMarkdown, auditGuideTicks, syncGuideStatuses } from './lib/guides.js';
import { lintAllGuides } from './lib/guidelint.js';
import { createProvider, createSession, checkResult, formatUsage } from './lib/ai.js';
import {
  generateGuide, planGuide, systemPromptFor, buildPatchMessage, DRAFTS_DIR,
} from './lib/guidegen.js';
import { planMigration, migrateGuideToNotion } from './lib/guidemigrate.js';
import { planPatch, patchGuide, PATCH_ROUNDS } from './lib/guidepatch.js';
import {
  BACKUPS_DIR, overwritePreflight, formatPreflight, formatPatchPreflight, diffGuides, formatDiff,
} from './lib/guidebackup.js';
import { exportAll } from './lib/csv.js';
import { createBackup, applyBackup, inspectBackup, backupName } from './lib/backup.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));

function flagValue(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Value-taking flags — the argument after them is a value, not a positional (see positionalArgs).
 *
 * **This table has to correspond one-for-one with what `flagValue()` reads**, and
 * `test/cli-hints.test.js` pins that. A missing registration raises no error; it just makes the
 * value be taken as a positional: in `guide-gen --effort low 648800` the appid becomes `low`, and
 * what gets reported is something like "game not found", with nothing at all to do with `--effort`.
 *
 * `--key` / `--id` / `--older-than` were added later: they have always been value-taking, and the
 * commands they belong to (`init` / `drafts`) simply take no positionals, so they never collided.
 * Leaving them out of the table amounts to "it breaks quietly the day those commands gain a
 * positional", and that is not a bet worth keeping
 */
// The consequence of `--only` / `--note` (partial rewrite) going unregistered is exactly the one
// described above: `guide-gen --only rare 1937500` takes `rare` as the appid and reports
// 「这个游戏不在列表里」.
//
// **Comments must stay outside this Set.** `test/cli-hints.test.js` pulls this literal out with a
// simple regex and splits it on commas, so a comment containing a comma produces a fragment that
// covers the entry right after it — and then `'--only'` is plainly written there while the assertion
// reports it unregistered. Stepped on once, recorded here
const VALUE_FLAGS = new Set([
  '--rounds', '--file', '--model', '--provider', '--port', '--effort',
  '--key', '--id', '--older-than', '--only', '--note',
]);

/**
 * The positionals, with value-taking flags' values removed.
 *
 * Without this, `guide-gen --rounds 2 1937500` takes 2 as the appid.
 * The global `positional` is a naive split; only the commands that need this use it.
 */
function positionalArgs() {
  const args = argv.slice(1);
  return args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
}

/**
 * `--provider` / `--model` / `--effort` override the config.
 *
 * There are flags as well as env vars (AI_PROVIDER / AI_MODEL) because **the syntax for env vars
 * differs per shell**: `AI_MODEL=x node ...` is an outright CommandNotFound in PowerShell, where it
 * has to be `$env:AI_MODEL = "x"; node ...` — and set that way it lingers for the whole session,
 * quietly overriding config.json. Flags have neither problem and work the same in every shell.
 */
function applyAiFlags(config) {
  const provider = flagValue('provider');
  const model = flagValue('model');
  if (provider) {
    // **provider / key / model are switched together.** This used to switch only the first and the
    // last: the key stayed put, so `--provider anthropic` sent the previous vendor's key to
    // api.anthropic.com and got back 「检查 ANTHROPIC_API_KEY」 — while that variable was very often
    // the one thing that was correct. An error pointing the wrong way costs more time than no error.
    // The key-switching rule (env var → keys slot → legacy only for its own vendor) lives in one
    // place, resolveAiKey in lib/config.js, and the setup page goes through it too
    //
    // model is cleared when unspecified: the one in config.json belongs to the previous vendor
    // (claude-* / gemini-* / deepseek-*), and carrying it across necessarily trips
    // assertModelMatchesProvider
    config.ai = switchAiProvider(config.ai, provider, process.env, { model: model ?? '' });
  } else if (model) {
    config.ai.model = model;
  }

  // **`--effort` is the choice of "how deep this one run goes", which makes it a flag rather than a setting.**
  //
  // What this knob changes is **breadth**: measured (see docs/ai-guide-writing.md), `low` is eight
  // times faster than `high`, and what it saves on is the content for the large batch of
  // medium-difficulty achievements — the hardest few are written thoroughly either way. So "for this
  // game I only want difficulty hints" and "these are notes I intend to keep" are two different
  // decisions, not one long-term preference that belongs in config.json.
  //
  // The value is not validated: the tier names differ per vendor (Anthropic also has xhigh/max, and
  // DeepSeek has not been measured), and a hardcoded whitelist would reject a legal value the day a
  // vendor adds a tier. The consequence of a typo is a 400 from the vendor, and errorFromResponse
  // has a dedicated hint for this field
  const effort = flagValue('effort');
  if (effort) config.ai.effort = effort;
  return config;
}

/**
 * Says so on the spot when an env var is overriding config.json.
 *
 * An env var lingers for the whole shell session, while config.json is the copy people can see — and
 * when the two disagree, the person is reading the file while the program uses the variable and
 * nobody can tell where the difference is. Stepped on: config.json said deepseek while the
 * PowerShell session still had $env:AI_PROVIDER at gemini, so deepseek-chat was requested against
 * Gemini's endpoint and what came back was a 404 pointing in entirely the wrong direction.
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

/** A provider instance. `--dry` / `--dry-run` sends nothing, so it has to be constructible without a key */
async function providerFor(config, { needKey = true } = {}) {
  const ai = !needKey && !config.ai.apiKey ? { ...config.ai, apiKey: '(dry-run,不会发送)' } : config.ai;
  return createProvider({ ai });
}

/** Progress output that refreshes one line in place (degrades to printing nothing when not a TTY, to avoid flooding logs) */
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

const PHASE_LABEL = { library: '检查新游戏', 'library-en': '补英文名', achievements: '刷新成就完成数', schema: '同步成就详情' };

function makeProgressHandler(p) {
  return (ev) => {
    const label = PHASE_LABEL[ev.phase] ?? ev.phase ?? '';
    const count = ev.total ? ` ${ev.done}/${ev.total}` : ev.added ? ` +${ev.added}` : '';
    p.update(`  ${label}${count} ${ev.name ?? ''}`);
  };
}

function withSteam({ requireSteam = true } = {}) {
  const config = loadConfig({ required: requireSteam ? ['steam'] : [] });
  // The CLI's own output is not switchable (see #86 — its audience and the Dashboard's need not be
  // one decision), but the messages **lib/ throws** are shared with the Dashboard and come from a
  // table now. Setting it here keeps one error from reading in two languages depending on which
  // entry point hit it
  setMessageLanguage(config.uiLanguage);
  const db = openDb(config.dbPath);
  const steam = new SteamClient(config, { log: () => {} });
  return { config, db, steam };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Reads a line **without echoing** — a token should stay out of the terminal scrollback and out of
 * the shell history. The prompt is written to stdout directly and readline's output goes through a
 * mutable Writable.
 */
function makeSecretReader() {
  // When stdin is not a terminal (piped input / CI) terminal mode must not be enabled, or readline
  // receives no lines, question() never resolves and the whole process hangs. In that case there is
  // no echo to hide either, so read normally.
  const isTty = Boolean(stdin.isTTY);
  let muted = false;
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output: isTty ? out : stdout, terminal: isTty });

  // Lines are taken through the async iterator rather than rl.question(): with piped input the whole
  // block arrives at once and readline emits every 'line' event back to back, so the later
  // question() has not registered yet and the lines are dropped — and it then never resolves. The
  // iterator has a queue and drops nothing.
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
 * The interactive part of `--create`: list the pages → pick one → create the database.
 *
 * **An empty list is itself a diagnosis**: a valid token that can see not one page can only mean the
 * Connections step was skipped — and that cannot be inferred from a single error message shared with
 * 「数据库 ID 填错了」.
 */
async function createGuideDbInteractively(io, probe) {
  stdout.write('正在查询这个 connection 能访问的页面…');
  const { pages, truncated } = await probe.searchPages();
  if (!pages.length) {
    console.log('\r⚠️  这个 integration 一个页面都看不到                    ');
    console.log('   token 是好的,所以缺的是共享:在 Notion 里打开要放攻略的那一页');
    console.log('   → 右上角 ••• → Connections → 加上这个 integration,然后重跑一次');
    return '';
  }
  console.log(`\r能访问 ${pages.length} 个页面${truncated ? '(还有更多没列完)' : ''}:                    \n`);
  pages.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.title}`));

  const pick = Number(await io.ask(`\n建在哪一页下面?(1-${pages.length}): `));
  if (!Number.isInteger(pick) || pick < 1 || pick > pages.length) {
    throw new Error('没选一个有效的编号,什么都没建');
  }
  const title = (await io.ask('数据库名字(回车用「Steam 攻略」): ')) || 'Steam 攻略';

  stdout.write('正在建…');
  const db = await probe.createGuideDatabase({ parentPageId: pages[pick - 1].id, title });
  console.log(`\r✅ 建好了:${db.url}        `);
  console.log(`   状态选项:${db.options.join(' / ')}`);
  console.log('   (四个选项都在 To-do 分组里 —— Notion 的 API 设不了分组,试过,静默无效。');
  console.log('    不影响功能,想整理 board 视图的话自己在 Notion 里拖一下)');
  return db.id;
}

/**
 * `init --notion`: configures the Notion token used for guide syncing.
 * Input is not echoed, and it is **verified on the spot** — the token itself and whether that
 * database is reachable, reported separately, because the fixes for those two are completely
 * different (change the token vs. add a connection in Notion).
 *
 * `--create` takes a different route: instead of asking for a database ID it lists the visible
 * pages, takes a pick, and creates a properly configured database under it. **For people who have no
 * database yet** — the manual route means creating one in Notion, adding every status option, then
 * opening it as a full page to dig the ID out of the URL, and each of those three steps has its own
 * traps.
 */
async function cmdInitNotion() {
  const create = flags.has('--create');
  const io = makeSecretReader();
  try {
    const cfg = loadConfig();
    console.log('\n配置 Notion 攻略同步\n');
    // The English terms are always copied verbatim from Notion's own UI, never conceptual names like
    // "Internal Integration" — those five words appear nowhere in Notion, so somebody looking for
    // them will not find them. Notion has renamed these more than once (it used to be New
    // integration / Internal Integration Secret), so what is copied is the wording of the current one
    console.log('token 从哪来:打开 https://app.notion.com/developers/connections,点 New connection,');
    console.log('在它的 Configuration 标签页里复制 Access token(ntn_ 开头)。然后把攻略页面(或它们');
    console.log('共同的父页面)授权给它:Notion 页面右上角 ••• → Add connections → 选中它,');
    console.log('否则 API 会返回 404。\n');
    console.log('带图的完整步骤:docs/notion-setup.md\n');

    const token = await io.askSecret('Notion Integration Token(输入不会显示): ');
    if (!token) throw new Error('没输入 token');

    const probe = new NotionClient({ notion: { token } });

    stdout.write('\n正在验证 token…');
    const me = await probe.request('get', '/users/me');
    console.log(`\r✅ token 可用:integration「${me.name || me.bot?.workspace_name || '未命名'}」        `);

    let dbId = '';
    let dbOk = false;

    if (create) {
      // The newly created ID would overwrite the existing one, and that would move a database holding
      // hundreds of guides entirely out of the tool's view. It is not blocked outright (the command
      // line is an explicit action), but it has to ask first — the GUI refuses it, because a click is
      // far too easy
      const had = cfg.notion?.overviewDbId;
      if (had) {
        console.log(`\n⚠️  已经配了攻略库:${had}`);
        console.log('   新建一个会把配置改指到新库 —— 现有攻略一篇都不会丢,但工具会看不到它们。');
        const yes = await io.ask('   确定还要建一个新的?(y/N) ');
        if (!/^y/i.test(yes)) throw new Error('取消了,什么都没建');
      }
      dbId = await createGuideDbInteractively(io, probe);
      dbOk = Boolean(dbId);
      // dbId is empty when the user never picked a page (because none were visible, say) — and an
      // empty value must never overwrite an existing configuration, which would amount to losing
      // somebody's database over one failed attempt
      if (!dbId && had) dbId = had;
    } else {
      const dbDefault = cfg.notion?.overviewDbId || '';
      dbId = (await io.ask(`攻略数据库 ID${dbDefault ? `(回车用 ${dbDefault})` : ''}: `)) || dbDefault;
      if (!dbId) {
        console.log('   (没有现成的库?`node tracker.js init --notion --create` 让程序建一个)');
      } else {
        stdout.write('正在验证数据库访问…');
        try {
          const pages = await probe.queryGuideDatabase(dbId);
          console.log(`\r✅ 数据库可访问:里面有 ${pages.length} 个页面        `);
          dbOk = true;
        } catch (err) {
          // **Connections cannot be the only thing mentioned** — that sends somebody who entered a
          // page ID off to check permissions over and over. Three faults, three fixes, said once
          console.log(`\r⚠️  数据库访问失败:${err.message}`);
          console.log('   token 本身是好的,所以问题在 ID 或权限:');
          console.log('   · 它不是数据库 —— 要整页打开,取 URL 里 ?v= 之前那 32 位十六进制');
          console.log('     (页面 ID、视图 ID、整条链接都不行)');
          console.log('   · 还没共享 —— 打开它(或父页面)→ ••• → Connections → 加上这个 integration');
          console.log('   · 压根还没有库 —— 改用 `init --notion --create`');
        }
      }
    }

    saveConfig({ notion: { token, overviewDbId: dbId } });
    console.log(`\n✅ 已写入 ${CONFIG_PATH}(权限 600,已 gitignore,不会被提交)`);
    console.log('\n接下来:');
    console.log('  node tracker.js notion-check               ← 只读体检,确认这一侧全通了');
    console.log('  node tracker.js guides --notion            ← 发现攻略页并登记');
    console.log('  node tracker.js checkbox-sync --dry-run    ← 只算不写,先看会勾掉哪些');
    if (!dbOk && dbId) console.log('\n(数据库那一步没通过的话,上面几条会失败,先按上面的提示修)');
  } finally {
    io.close();
  }
}

/**
 * `notion-check`: the health check for the Notion side. A pair with `ai-check` — both ask the real
 * API once, turning "is this actually configured" into something with a visible answer right now
 * rather than something that blows up when the real flow runs.
 *
 * **It writes not one byte.** It exists because the failures on this chain all look alike: a bad
 * token, an ID that is not a database, an unshared database, a missing status option — the first
 * three are easily merged into one sentence, and the last would not surface until the first
 * `guide-gen` without a check.
 */
/**
 * The half of a repair that is not about missing options: board columns, the board view, and the
 * colours only a human can change.
 *
 * **Silence here would be the bug.** Notion refuses to recolour an option that already exists, so
 * the program can bring an older database most of the way and no further; saying nothing leaves
 * somebody looking at a grey board wondering what the command did.
 */
function reportReformat(r) {
  if (r.regrouped?.length) console.log(`   🔧 排进看板分组:${r.regrouped.join(' / ')}`);
  if (r.stillWrongGroup?.length) console.log(`   ❌ 分组没落地:${r.stillWrongGroup.join(' / ')}`);
  if (r.boardView?.created) console.log('   🔧 加了看板视图,放在第一个标签页');
  else if (r.boardView && !r.boardView.ok) {
    console.log(`   ⚠️  看板视图没建成:${r.boardView.error}`);
    console.log('      库照常能用,攻略照样生成,复选框照样勾');
  }
  if (r.colour?.recoloured?.length) {
    const done = r.colour.recoloured.map((n) => `${n} ${COLOUR_ZH[GUIDE_STATUS_STYLE[n].color]}`).join(',');
    console.log(`   🔧 换好颜色:${done}`);
    // Say it out loud. Pages that had to be written back are pages Notion did not bring back on its
    // own, and that is the one number telling you the snapshot earned its keep
    if (r.colour.restored?.length) {
      console.log(`      有 ${r.colour.restored.length} 页的状态是照快照写回去的:${r.colour.restored.slice(0, 5).join('、')}`);
    }
  }
  if (r.colour?.stillWrong?.length) {
    const want = r.colour.stillWrong.map((n) => `${n} ${COLOUR_ZH[GUIDE_STATUS_STYLE[n].color]}`).join(',');
    console.log(`   ⚠️  这几个状态的颜色没换成:${want}`);
    if (r.colour.error) console.log(`      ${r.colour.error}`);
    console.log('      也可以自己来:打开那个库 → 点状态属性 → 逐个挑一次');
  }
}

async function cmdNotionCheck() {
  const { config, db } = withSteam({ requireSteam: false });
  const token = config.notion?.token;
  const dbId = config.notion?.overviewDbId;

  if (!token) {
    console.log('❌ 没配 Notion token(config.json 的 notion.token)');
    console.log('   跑 `node tracker.js init --notion` 配一下');
    return;
  }
  const notion = new NotionClient(config);

  // **The verdict comes from inspectGuideDb, shared with the setup page.** Two paths checking
  // different things is exactly the shape of that "only shows up at upload time" class of bug. All
  // this does is turn the verdict into a report a person reads — what is shared is the computation,
  // not the wording.
  //
  // `--probe-write` has to be opted into: it creates a page in the database and immediately archives
  // it, whereas a read-only check has the right to be on the default path.
  const verdict = await inspectGuideDb(notion, dbId, { probeWrite: argv.includes('--probe-write') });

  const problem = (code) => verdict.problems.find((p) => p.code === code);
  const say = (p) => console.log(`${p.severity === 'error' ? '❌' : '⚠️ '} ${p.message}`);

  if (problem(DB_PROBLEM.BAD_TOKEN)) return say(problem(DB_PROBLEM.BAD_TOKEN));
  console.log(`✅ token:integration「${verdict.workspace}」`);

  if (problem(DB_PROBLEM.NO_DB_ID)) {
    console.log('❌ 没配攻略数据库 ID(config.json 的 notion.overviewDbId)');
    console.log('   `node tracker.js init --notion --create` 可以直接建一个');
    return;
  }

  const unreadable = problem(DB_PROBLEM.DB_UNREADABLE);
  if (unreadable) {
    console.log(`❌ ${unreadable.message}`);
    console.log('   两种可能,修法不一样:');
    for (const c of unreadable.causes) console.log(`   · ${c}`);
    return;
  }
  console.log(`✅ 数据库:「${verdict.database.title}」`);
  if (problem(DB_PROBLEM.NO_TITLE_PROP)) say(problem(DB_PROBLEM.NO_TITLE_PROP));
  else console.log(`✅ 标题属性:${verdict.schema.titleProperty}`);

  const noStatus = problem(DB_PROBLEM.NO_STATUS_PROP);
  const missingOpts = problem(DB_PROBLEM.MISSING_OPTIONS);
  if (noStatus) {
    console.log('ℹ️  没有状态属性 —— 合法。攻略照样能建、能同步勾选,只是');
    console.log('   guide-status 那套(打满→Done、掉出 100%→Staged)没东西可写。');
    console.log(`   想要的话加一个 Status 属性,选项:${noStatus.wanted.join(' / ')}`);
  } else if (missingOpts) {
    console.log(`⚠️  状态属性:${missingOpts.property}(${missingOpts.type})`);
    console.log(`   现有选项:${missingOpts.have.join(' / ') || '无'}`);
    console.log(`   缺:${missingOpts.missing.join(' / ')}`);
    console.log('   缺的那个会在程序真要写它的时候把命令拦下来:');
    if (missingOpts.missing.some((o) => ['Not started', 'In progress', 'Done'].includes(o))) {
      console.log('     · guide-gen / guide-to-notion 建新页时按完成度写这三档');
    }
    if (missingOpts.missing.includes('Staged')) {
      console.log('     · guide-status 把掉出 100% 的页面退回 Staged 时写它(每次开 Dashboard 都跑)');
    }
    if (argv.includes('--fix')) {
      // Adding options **writes to the user's database**, so it only happens when explicitly asked,
      // and success is judged by the read-back rather than by the 200
      const r = await repairGuideDb(notion, dbId);
      if (r.ok) console.log(`   🔧 已补上:${r.added.join(' / ')}(回读确认落地)`);
      else if (r.reason === 'clobbered') {
        console.log(`   ❌ 补的时候把已有选项冲掉了:${r.clobbered.join(' / ')} —— 请去 Notion 里加回来`);
      } else {
        console.log(`   ❌ Notion 收下了请求但选项没落地,还缺:${r.stillMissing.join(' / ')}`);
        console.log('      手动加:打开那个库 → 点这个属性 → 加选项,名字要一模一样(注意大小写)');
      }
      reportReformat(r);
    } else {
      console.log('   加 --fix 让程序试着补上,或者自己去 Notion 里加(名字要一模一样,注意大小写)');
    }
  } else {
    console.log(`✅ 状态属性:${verdict.schema.status.property}(${verdict.schema.status.type}),四个选项齐全`);
    // **A database built by an older version reaches this branch.** Its four options are all there,
    // and it is still out of date: everything grey, everything in one board column, no board view.
    // Gating --fix on a missing option would leave those users with a button that does nothing
    if (argv.includes('--fix')) reportReformat(await repairGuideDb(notion, dbId));
  }

  const noWrite = problem(DB_PROBLEM.NO_WRITE);
  if (noWrite) {
    console.log(`❌ ${noWrite.message}`);
    console.log(`   ${noWrite.hint}`);
  } else if (argv.includes('--probe-write')) {
    console.log('✅ 试写:建页 + 归档都通过(这个 integration 确实有写权限)');
  }
  const stranded = problem(DB_PROBLEM.STRANDED_PROBE_PAGE);
  if (stranded) console.log(`⚠️  ${stranded.message}:${stranded.url}`);

  const pages = await notion.queryGuideDatabase(dbId);
  const registered = allGuides(db).filter((g) => g.kind === 'notion').length;
  console.log(`✅ 库里 ${pages.length} 个页面,其中 ${registered} 个已登记进 guides 表`);
  if (pages.length > registered) {
    console.log(`   剩下 ${pages.length - registered} 个没有 \`appid: NNNNNN\` 行 —— 那是还没写的攻略,不是错误`);
  }
}

/**
 * The provider options. The first is the default.
 *
 * **The notes state only verifiable things: whether it has web search, and where to get a key.**
 * Nothing about price, quality or a recommendation — rates change at any time and we have no
 * comparable measurement of quality, so writing those would be our own conjecture, and the user
 * would take it as fact and choose accordingly.
 */
const AI_PROVIDERS = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    note: '有联网搜索。key 在 https://platform.deepseek.com/api_keys',
    env: 'DEEPSEEK_API_KEY',
  },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    note: '有联网搜索。key 在 https://platform.claude.com/settings/keys',
    env: 'ANTHROPIC_API_KEY',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    note: '有联网搜索。key 在 https://aistudio.google.com/apikey',
    env: 'GEMINI_API_KEY',
  },
];

/**
 * `init --ai`: configures the AI provider used for guide generation.
 *
 * **Verified with a real request on the spot** rather than merely written and forgotten — this
 * feature's failure modes (an invalid key, a wrong model name, no quota on this tier, an endpoint
 * that rejects some tool) all look different, and all of them require sending a request to find out.
 * Having somebody spend a few cents hitting one during `init` beats hitting it halfway through
 * generating a guide.
 */
async function cmdInitAi() {
  const io = makeSecretReader();
  try {
    console.log('\n配置 AI 攻略生成\n');
    console.log('这个功能会调用 AI 联网查资料并写攻略。');
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

    // Send one real request. Minimised: no web tools attached, one character wanted back
    stdout.write(`\n正在验证(模型 ${provider.model})…`);
    const r = await provider.send({ messages: [{ role: 'user', content: '回复一个字:好' }] });
    const verdict = checkResult(r);
    if (!verdict.ok) throw new Error(`验证没通过:${verdict.reason}`);
    console.log(`\r✅ 可用:${provider.name} / ${provider.model},回了「${r.text.trim().slice(0, 10)}」      `);
    console.log(`   ${formatUsage(r.usage)}`);

    // An empty model is not written into the config, so the default in the code keeps applying (and
    // that one follows the version)
    saveConfig({ ai: model.trim() ? ai : { provider: ai.provider, apiKey: ai.apiKey } });
    console.log(`\n✅ 已写入 ${CONFIG_PATH}(已 gitignore,不会被提交)`);
    console.log('\n接下来:');
    console.log('  node tracker.js ai-check              ← 验证联网搜索真的能用(重点看有没有发出搜索)');
    console.log('  node tracker.js guide-gen <appid>     ← 生成一份攻略(开始之前会先问你一句)');
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
    if (!key || !id) throw new Error('两项都要填写');
    if (!/^\d{17}$/.test(id)) console.log('⚠️  SteamID64 一般是 17 位数字,你填的看起来不像,先存下了,同步失败的话回来检查这里');

    saveConfig({ steamApiKey: key, steamId: id });
    const config = loadConfig({ required: ['steam'] });
    openDb(config.dbPath);
    console.log(`\n✅ 写入 ${CONFIG_PATH}(权限 600,已在 .gitignore 里)`);
    console.log(`✅ 建好数据库 ${config.dbPath}`);

    // Verify with a real request immediately, so bad credentials are not discovered halfway through a
    // sync later
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

  // Full by default: the command line has to keep one entrance that "definitely misses nothing when
  // it finishes".
  // --fast uses the same sampling rules as the Dashboard's automatic sync (see selectStatsTargets in
  // lib/sync.js)
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
    console.log(
      `  库:owned ${r.library.ownedCount} 款(Unvetted ${r.library.unvettedCount} 款),新增 ${r.library.added.length} 款,Unvetted 标记更新 ${r.library.restamped} 处` +
        // Only when something moved: after the first run this is 0 on every sync, and a permanent
        // 「补英文名 0 款」 is noise on the one line that has to stay readable
        (r.library.namedEn ? `,补英文名 ${r.library.namedEn} 款` : '')
    );
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
      p.done(
        `  库:新增 ${r.added.length} 款,Unvetted 标记更新 ${r.restamped} 处` +
          (r.namedEn ? `,补英文名 ${r.namedEn} 款` : '')
      );
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
 * Aligns Notion guide page status with completion: 100% → Done, dropped below 100% → Staged.
 * Converges on the current state (rather than catching the instant of crossing 100% this round), so
 * running it repeatedly is a safe no-op.
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

  // Printed grouped by game; a flat list of a few hundred entries is unreadable
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
    const willCheck = r.logs.filter((l) => l.code === 'would-tick').length;
    console.log(
      `\n预演结束:会勾选 ${willCheck} 个 checkbox。确认没问题就去掉 --dry-run 再跑一次。` +
        '\n(Notion 的勾选没法自动撤销,建议先只跑一款游戏:checkbox-sync <appid>)'
    );
  }
}

/**
 * A read-only audit: finds wrongly ticked checkboxes (the exact opposite of checkbox-sync finding
 * missed ticks).
 * It writes nothing, so it needs no --dry-run.
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
  // The coverage has to be stated honestly: the ones that could not be resolved carry no verdict, and
  // "0 wrong" must not look stronger than the audit's actual coverage
  console.log(`  对不上具体成就、没下结论:${totals.unresolved} 个(攻略文字既没抄描述原文、名字也不唯一)`);
  if (totals.skipped) console.log(`  跳过的游戏:${totals.skipped} 款(见上面)`);
  if (totals.wrong > 0) {
    console.log('\n勾错的框需要手动取消勾选——checkbox-sync 只会勾上、从不取消,修不了自己的错。');
    console.log('取消之前先自己确认一遍:也可能是你自己有意勾的(比如标记"计划要做")。');
  }
}

/** guidelint's code → a human sentence. The per-guide summary and the totals share one set, so the two cannot disagree on naming */
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
 * Read-only validation: whether the guide itself is written correctly (three different things from
 * audit's "was anything ticked wrongly" and checkbox-sync's "was anything missed").
 * It does not write the database, touch Notion or change local md, so it needs no --dry-run.
 */
async function cmdGuideLint() {
  // Steam credentials are not needed by default: only the --checked rule requires the real unlock
  // state
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

  // With an appid given, list that guide's problems one by one; otherwise report only a count per
  // type for each guide — across everything, "missing checkbox" and "description not copied" alone
  // come to over nine hundred findings, and printing them flat amounts to no output at all
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

/** Picks a game that has achievement detail for the smoke test. With no appid given, takes the first usable one in the library */
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
 * `ai-check`: runs lib/ai.js's whole chain for real — assembling the request → server-side search →
 * page fetch → pause_turn continuation → token usage.
 *
 * This is the acceptance command for step 3 of the "order of operations", not guide generation
 * itself: it asks about one achievement and gets three sentences back. How a guide is written is
 * guidegen's job (the next step). **It costs money**, so `--dry` assembles without sending, letting
 * you see exactly what would go out, on which model and with which tools.
 */
async function cmdAiCheck() {
  const dry = flags.has('--dry');
  // --dry needs no key: its whole use is "see exactly what would be sent before a key is configured"
  const config = applyAiFlags(loadConfig({ required: dry ? [] : ['ai'] }));

  // --models: ask the API directly which models are available. When the Gemini side was written the
  // docs were unreachable and model names could only be guessed from memory, so this route was left
  // in — a wrong guess needs no code change, just one question
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
    // Measured: the 2.5 series is no longer sold to new keys, yet it still appears in this list. This
    // endpoint says only "it exists", never "you can use it" — not saying so makes people try items
    // off the list over and over
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
  const shownName = achName(def);

  const system =
    '你在帮一个 Steam 成就攻略作者做资料调研。回答用中文,只讲怎么达成,不要寒暄和总结段。';
  const question =
    `游戏《${target.name}》(appid ${target.appid})的成就「${achName}」` +
    (def.description ? `,官方描述是「${def.description}」` : '') +
    // No specific tool is named: the two vendors call their tools different things, and hardcoding
    // one vendor's name leaves the other unable to understand it
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
      // With web access and deep thinking, several minutes of silence is normal. Printing the tool
      // activity is what separates "working" from "stuck"
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

  // This line is the one most worth looking at in this command: **the web tools were declared, but
  // did the model actually search**. Whether the free tier includes web access is not reliably
  // answerable from the docs, and the response is more reliable than the pricing page
  if (r.searchQueries?.length) {
    console.log(`  🔎 实际发出 ${r.searchQueries.length} 次搜索:${r.searchQueries.slice(0, 5).join(' / ')}`);
  } else if (tools.length) {
    console.log('  ⚠️  声明了联网工具,但这一轮一次搜索都没发出去 —— 可能是这个层级/模型不支持,');
    console.log('      也可能是模型觉得不用查。攻略生成如果一直这样,内容就是它凭记忆编的');
  }
  // A failed page fetch is normal on a per-URL basis; flagging it stops the next person who sees this
  // line from going off to investigate whether web access is broken
  for (const e of r.toolErrors ?? []) {
    const tail = e.tool === 'fetch' ? '(逐个 URL 的常态,不影响这一轮)' : '';
    console.log(`  ⚠️  ${e.tool === 'fetch' ? '抓页' : '搜索'}报错:${e.errorCode}${tail}`);
  }
}

/**
 * `guide-gen <appid>`: has the AI write a local markdown guide.
 *
 * **It costs money**, so it asks for confirmation once by default (`--yes` skips it), while
 * `--dry-run` prints the prompt that would be sent and the landing plan without sending a single
 * request.
 *
 * **Do not add a spend cap here.** We cannot verify the rates and have not measured how the search
 * tool is billed, so any "cap" would rest on a figure we do not believe ourselves. What is reported
 * at the end is the token count only — that is a hard number the API returns.
 */
async function cmdGuideGen() {
  const appid = positionalArgs()[0];
  if (!appid) {
    throw new Error(
      '用法:node tracker.js guide-gen <appid> [--dry-run] [--yes] [--local] [--overwrite]\n' +
        '      只改其中几条:guide-gen <appid> --only <选择器> [--note "要求"]'
    );
  }
  // **`--only` is a different pipeline** (lib/guidepatch.js): rewrite only the named entries and
  // leave every other byte alone. Split here rather than branching below, because what it has to say
  // is the exact opposite of a full rewrite — that preflight covers 「你会失去什么」 while this one
  // covers 「什么会留下」, and one piece of copy serving both questions comes out wrong on both
  if (flagValue('only') !== undefined) return cmdGuidePatch(appid);

  const dryRun = flags.has('--dry-run');
  const overwrite = flags.has('--overwrite');

  const config = applyAiFlags(loadConfig({ required: dryRun ? ['steam'] : ['steam', 'ai'] }));
  const db = openDb(config.dbPath);
  const steam = new SteamClient(config, { log: () => {} });
  const notion = new NotionClient(config);
  const local = flags.has('--local');
  const rounds = Number(flagValue('rounds') ?? config.ai.maxRounds ?? 3);
  const fileName = flagValue('file') ?? null;

  // **How a refusal is worded is each surface's own business.** planGuide says only what happened
  // (plus a code); "and here is the config option you should change" is advice only a terminal can
  // give and only there does it mean anything — a Dashboard user (especially in the packaged build)
  // has no terminal at all, and one sentence serving both surfaces comes out wrong on both.
  // planGuide says only what happened (plus a code), and 「那你该改哪个配置项」 is filled in on the
  // terminal side by the CLI_HINTS table at the bottom
  const plan = await planGuide(db, { config, steam, appid, fileName, notion, local, overwrite });

  console.log(`\n《${plan.game}》(appid ${appid})`);
  // The unlock state is for mechanical ticking and is never fed to the model — that is by design,
  // not something they need to read at this moment
  console.log(`  成就 ${plan.defs.length} 个,已解锁 ${plan.unlocked.size} 个`);
  if (plan.unnameable.size) {
    console.log(`  ${plan.unnameable.size} 个成就名在本作里撞车,它们的框会留空(已知)`);
  }
  // "Has server-side search" is a hard admission criterion set by the design doc, on the grounds that
  // "letting one without search in makes quality depend on which vendor the user picked, and the user
  // cannot see that difference". So it cannot be waived by default; the person has to **explicitly
  // know what they are asking for**
  const probe = await providerFor(config, { needKey: !dryRun });

  // Prints the model name the provider resolved, not the one in the config: when switching provider
  // without specifying a model, the config's is empty and what is really used is that vendor's default
  console.log(`  ${probe.name} · 模型 ${probe.model} · 最多改 ${rounds} 轮`);
  warnEnvOverrides();
  if (plan.existing) {
    // Overwriting is the one irreversible action in this command, so it gets its own paragraph, and
    // it is printed **before** the "continue?" question
    const where = plan.existing.kind === 'notion' ? 'Notion 页面' : '本地文件';
    console.log(`\n  ⚠️  覆盖已有攻略(${where}:${plan.existing.url})`);
    console.log(formatPreflight(overwritePreflight(plan), { defsCount: plan.defs.length }));
    // A failed backup means nothing is written, and deleting a Notion block is really archiving
    // (recoverable from the trash within 30 days) — both are safety nets on our side, not decisions
    // for them, so neither is printed
    console.log(`  原文备份到 ${join(config.guidesDir, BACKUPS_DIR)}`);
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
    console.log(systemPromptFor(plan, appid, { canSearch: probe.canSearch !== false }));
    console.log('─'.repeat(70));
    return;
  }

  if (!flags.has('--yes')) {
    // Asks once by default. This is the only gate — the whole cap mechanism was removed (see the note
    // above).
    // On an overwrite this sentence carries one more job: it is simultaneously the manual
    // confirmation of that irreversible write.
    //
    // **The wording does not mention money.** What a prompt should say is "here is what will happen
    // next", not an assessment of whether it is worth it on the user's behalf — it is their own key,
    // they know the rate, and we have not even measured how server-side search is billed (see the "no
    // spend caps" entry in CLAUDE.md). Frightening somebody with a figure we cannot explain is worse
    // than saying nothing
    const io = makeSecretReader();
    const answer = await io.ask(
      plan.existing
        ? `\n这一步会联网研究并重写,而且会**覆盖《${plan.game}》现在那份攻略**。继续?(y/N)`
        : '\n这一步会联网研究并撰写,通常两到四分钟。继续?(y/N)'
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
      if (ev.phase === 'plan' && ev.chunks > 1) {
        p.done(`  ${ev.achievements} 个成就,一次写不完,分 ${ev.chunks} 段写`);
      } else if (ev.phase === 'regroup') {
        p.update('  正文写完了,再统一一遍分区…');
      } else if (ev.phase === 'regroup-done') {
        p.done(`  分区统一好了(${ev.sections} 个,归了 ${ev.assigned}/${ev.of} 条)`);
      } else if (ev.phase === 'regroup-failed') {
        // **A degradation has to speak up.** Each shard opens its own headings, and without unifying
        // them same-kind achievements end up scattered across several sections — a visible regression
        // in the finished product. Unsaid, the user only concludes 「这次的分区怎么乱七八糟」
        p.done(`  ⚠️  分区统一失败(${ev.reason}),保留各段自己分的结果`);
      } else if (ev.phase === 'regroup-merged') {
        // This is the program **overriding the classification the model gave**, and the finished
        // product does not show who changed it. Say plainly how many places were changed
        p.done(`  ${ev.clusters} 组同类成就散在几个小节里,已合到 ${ev.into.join('、')}(移了 ${ev.moved} 条)`);
      } else if (ev.phase === 'unwrapped-toggles') {
        p.done(`  ${ev.titles.length} 处成就本来收在折叠里,已摊开:${ev.titles.join('、')}`);
      } else if (ev.phase === 'unwrap-failed') {
        p.done(`  ⚠️  ${ev.reason},折叠保持原样`);
      } else if (ev.phase === 'rewrite') {
        p.done(`  校验没过,第 ${ev.round} 轮只重写其中 ${ev.chunks}/${ev.of} 段`);
      } else if (ev.phase === 'ask') {
        // **Under concurrency, report "shards finished" rather than "writing shard N".** Several
        // shards are written at once and this event fires once per shard — reporting the current
        // shard number makes this line bounce between 1/4, 3/4 and 2/4, looking like progress going
        // backwards. The count of finished shards is monotonic, and holds equally running in series
        const prog = ev.chunks > 1 ? ` 已写完 ${ev.done ?? 0}/${ev.chunks} 段` : '';
        p.update(`  第 ${ev.round}/${ev.rounds} 轮${prog}:联网研究 + 撰写…`);
      } else if (ev.phase === 'tool') p.update(`  第 ${ev.round} 轮${ev.label ? ` ${ev.label}` : ''}:${ev.name}…`);
      else if (ev.phase === 'check') p.update(`  第 ${ev.round} 轮:机械打勾 + 校验…`);
      else if (ev.phase === 'lint') {
        p.done(`  第 ${ev.round} 轮:勾上 ${ev.ticked} 个框,还剩 ${ev.blocking} 条要改`);
      } else if (ev.phase === 'notion-create' || ev.phase === 'notion-fill') {
        p.update(`  写进 Notion(${ev.blocks} 个块)…`);
      } else if (ev.phase === 'backup') p.update('  备份原文…');
      else if (ev.phase === 'backup-done') p.done(`  原文已备份:${ev.path}(${ev.bytes} 字节)`);
      else if (ev.phase === 'notion-clear') p.update(`  清掉页面上原来的 ${ev.blocks} 个块…`);
      else if (ev.phase === 'resplit') {
        p.done(`  第 ${ev.chunk} 段未生成(${ev.from} 个成就),拆成两半重问(${ev.to} 个)`);
      } else if (ev.phase === 'retry') {
        p.done(`  第 ${ev.chunk} 段没拿到正文,原样再问一次(第 ${ev.attempt}/${ev.of} 次)`);
      } else if (ev.phase === 'chunk-failed') {
        // **This one must be done, never update.** It is the only record in the whole guide that a
        // shard was skipped, and a line written with update is overwritten on the spot by the next
        // shard's progress — leaving nobody knowing what was missed once the run ends
        p.done(`  ⚠️  第 ${ev.chunk} 段(${ev.count} 个成就)放弃了,先接着写后面的`);
      }
    },
  });
  p.done();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('\n' + '─'.repeat(70));
  if (r.ok) {
    console.log(`✅ 写完了,${r.rounds} 轮 · ${secs}s → ${r.url}`);
    if (r.overwrote) {
      // A genuine old-vs-new comparison can only be computed after the overwrite — the preflight
      // before spending can only cover the old half. This section gives "what exactly did I replace"
      // an answer that can be checked on the spot, with the backup path right below
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
    if (r.registered) console.log(`  已登记(${r.registered.action ?? '新增'}),Dashboard 上能看到链接了`);
    else console.log('  ⚠️  没登记上。跑一次 `node tracker.js guides` 看为什么');
    // Lines the converter did not recognise were not lost, but their formatting degraded to a plain
    // paragraph. The user has a right to know which lines
    if (r.unconverted.length) {
      console.log(`  ⚠️  ${r.unconverted.length} 行排版降级成普通段落,文字没丢:`);
      for (const line of r.unconverted.slice(0, 5)) console.log(`       ${line}`);
    }
  } else {
    console.log(`❌ ${r.rounds} 轮之后仍有 ${r.blocking.length} 条没过,草稿留在 ${r.draftPath}`);
    console.log('  (草稿不会被发现逻辑扫到,不会拿去勾框)');
    // **The cause goes before the symptom.** A missing shard presents as dozens of "missing
    // checkbox" findings, and reading down the list one concludes the model forgot to write them;
    // the truth is the whole shard never came back. The other order buries the real reason under
    // fifteen identical sentences
    for (const c of r.chunkFailures ?? []) {
      console.log(`\n  ⚠️  第 ${c.chunk}/${c.of} 段未生成(${c.count} 个成就:${c.first} … ${c.last})`);
      console.log(`      ${c.reason.replace(/\n/g, '\n      ')}`);
      console.log('      下面那些"缺 checkbox"里,这一段的部分是这个原因,不是模型漏写');
    }
    for (const f of r.blocking.slice(0, 15)) console.log(`     ✖ ${f.message}`);
    if (r.blocking.length > 15) console.log(`     …… 另外 ${r.blocking.length - 15} 条`);
  }
  // **`expected` now holds two kinds of "out of reach" with different causes, and they cannot be
  // reported as one sentence.** This line used to hardcode 「已解锁但没勾」, which is true only of
  // checked-mismatch. The empty-description kind is "this box can never be ticked" and has nothing
  // to do with unlock state; merging them into one sentence states it wrongly
  const emptyDesc = r.expected.filter((f) => f.code === 'ambiguous-empty-description');
  const mismatch = r.expected.filter((f) => f.code === 'checked-mismatch');
  if (mismatch.length) {
    console.log(`  ${mismatch.length} 条"已解锁但没勾"是预期内的:成就名在本作里撞车,勾不上`);
  }
  if (emptyDesc.length) {
    // Not blocking, but it has to be said: these will **never** be ticked automatically, and the user
    // has a right to learn that on the same screen that says 「写完了」 rather than discovering months
    // later that a few boxes have never moved
    console.log(`  ⚠️  ${emptyDesc.length} 个成就同名、而 Steam 上的描述是空的,自动勾选永远认不出它们:`);
    for (const f of emptyDesc.slice(0, 8)) console.log(`       ${f.name}`);
    if (emptyDesc.length > 8) console.log(`       …… 另外 ${emptyDesc.length - 8} 个`);
    console.log('     攻略本身没问题,这几个框要自己手动勾。');
  }
  if (r.lint?.stats) {
    console.log(`  覆盖 ${r.lint.stats.covered}/${r.lint.stats.achievements} 个成就,` +
      `${r.lint.stats.warnings} 条 warn`);
  }
  console.log('  ' + formatUsage(r.usage));
  // The machine verifies format and data (one line per achievement, names that match, verbatim
  // descriptions, ticks equal to the real unlock state) and can verify nothing about whether the
  // content is right. **This reminder has to stay**, but it is one sentence, not a paragraph
  console.log('\n⚠️  只验了格式和数据,内容需要你自己读一遍。');
  // **Can search ≠ did search.** canSearch only says the provider has the capability; searchQueries
  // is what it actually issued. Not reporting it turns "declared the tools and never searched" into
  // an invisible quality difference — exactly what the canSearch design exists to prevent
  if (!r.researched) {
    console.log('    这一份没联网,内容是模型凭已有知识写的。');
  } else if (!r.searchQueries?.length) {
    console.log('    ⚠️  一次搜索都没发出去,内容等同于凭记忆写的。');
  } else {
    console.log(`\n🔎 搜了 ${r.searchQueries.length} 次:` + r.searchQueries.slice(0, 4).join(' / '));
  }
}

/**
 * Partial rewrite: `guide-gen <appid> --only <selector> [--note "requirement"]`.
 *
 * Routed here by `cmdGuideGen` when it sees `--only` — one command name, two report shapes.
 *
 * **The report emphasises the opposite of a full rewrite.** That one covers 「你会失去什么」 (whole
 * document replaced, every manual tick gone); this one covers 「什么会留下」 (how many other boxes
 * stay untouched to the letter, how many manual ticks survive), because that is the only definite,
 * quantifiable benefit of choosing partial over full.
 *
 * `--dry-run` prints **the resolved selection plus the complete request** and sends not one byte.
 * This is the step most worth running first on this path: whether the selector picked the entries you
 * thought it did is only knowable once printed — and running with the wrong selection means paying to
 * change the wrong thing.
 */
async function cmdGuidePatch(appid) {
  const selector = String(flagValue('only') ?? '').trim();
  const instruction = flagValue('note') ?? null;
  const dryRun = flags.has('--dry-run');

  const config = applyAiFlags(loadConfig({ required: dryRun ? ['steam'] : ['steam', 'ai'] }));
  const db = openDb(config.dbPath);
  const steam = new SteamClient(config, { log: () => {} });
  const notion = new NotionClient(config);
  const rounds = Number(flagValue('rounds') ?? config.ai.maxRounds ?? PATCH_ROUNDS);

  const pp = await planPatch(db, { config, steam, appid, notion, selector });
  const { plan, entries, unlocatable, baseline, kind } = pp;

  console.log(`\n《${plan.game}》(appid ${appid})· ${kind === 'notion' ? 'Notion 页面' : '本地文件'}:${plan.existing.url}`);
  console.log(`\n  按「${selector}」挑中 ${entries.length} 条成就:`);
  for (const e of entries.slice(0, 12)) {
    const pct = plan.rarity?.get(e.apiName);
    const rare = pct === undefined || pct === null ? '' : `  (全球 ${pct.toFixed(1)}%)`;
    console.log(`       ${achName(e.def)}${rare}`);
  }
  if (entries.length > 12) console.log(`       …… 还有 ${entries.length - 12} 条`);

  console.log('');
  console.log(formatPatchPreflight(pp.preflight, { defsCount: plan.defs.length }));

  // Named but not locatable in the guide: **report them, do not pretend they do not exist**. Their
  // symptom is missing-checkbox, and fixing that takes a full rewrite (or writing a line by hand),
  // which is not something this command can do
  if (unlocatable.length) {
    console.log(`\n  ⚠️  另有 ${unlocatable.length} 条点到了、但现有攻略里没有对应的 checkbox,这次改不到:`);
    for (const a of unlocatable.slice(0, 8)) {
      const d = plan.defs.find((x) => x.api_name === a);
      console.log(`       ${achName(d) || a}`);
    }
    if (unlocatable.length > 8) console.log(`       …… 还有 ${unlocatable.length - 8} 条`);
    console.log('       这几条是"攻略里压根没写",要整篇重写(--overwrite)或者自己补一行。');
  }

  // The findings the old guide already failed on. **Say plainly that this run will not fix them** —
  // otherwise seeing them still in the report afterwards reads as damage done by this change
  const oldBlocking = baseline.findings.filter((f) => f.level === 'error');
  const outside = oldBlocking.filter((f) => !f.apiName || !pp.scope.apiNames.includes(f.apiName));
  if (outside.length) {
    console.log(`\n  ℹ️  这份攻略本来就有 ${outside.length} 条校验问题落在这次范围之外,不会被这次改动碰到,也不会拦路:`);
    for (const f of outside.slice(0, 5)) console.log(`       ${f.message}`);
    if (outside.length > 5) console.log(`       …… 还有 ${outside.length - 5} 条`);
  }

  const probe = await providerFor(config, { needKey: !dryRun });
  console.log(`\n  ${probe.name} · 模型 ${probe.model} · 最多改 ${rounds} 轮`);
  warnEnvOverrides();
  console.log(`  原文备份到 ${join(config.guidesDir, BACKUPS_DIR)}`);

  if (probe.canSearch === false && !flags.has('--no-research')) {
    throw new Error(
      `${probe.name} 没有服务端联网搜索,重写出来的内容是模型**凭已有知识写的**,不是查来的。\n` +
        '  真要这么跑,加 --no-research 明说;想要经过调研的,换一家有联网的' +
        '(--provider anthropic 或 --provider gemini)。'
    );
  }
  if (probe.canSearch === false) {
    console.log('  ⚠️  --no-research:这几条不会经过任何联网调研');
  }

  if (dryRun) {
    console.log('\n--dry-run:不发任何请求。会发过去的那条请求:\n');
    console.log('─'.repeat(70));
    console.log(buildPatchMessage(entries, { instruction }));
    console.log('─'.repeat(70));
    console.log('\n(system 提示词和整篇生成是同一份,想看就跑 guide-gen --dry-run)');
    return;
  }

  if (!flags.has('--yes')) {
    const io = makeSecretReader();
    const answer = await io.ask(
      `\n这一步会联网研究并重写上面那 ${entries.length} 条,其余 ${pp.preflight.keeping} 个框一字不动。继续?(y/N)`
    );
    io.close();
    if (!/^y(es)?$/i.test(answer)) return console.log('取消了。');
  }

  const p = progressPrinter();
  const started = Date.now();

  const r = await patchGuide(db, {
    config, provider: probe, steam, appid, notion,
    selector, instruction, rounds, patchPlan: pp,
    onProgress(ev) {
      if (ev.phase === 'write') p.update(`  第 ${ev.round}/${ev.of} 轮:联网研究 + 重写 ${ev.scope} 条…`);
      else if (ev.phase === 'rewrite') p.update(`  第 ${ev.round}/${ev.of} 轮:按校验结果再改一次…`);
      else if (ev.phase === 'tool') p.update(`  第 ${ev.round} 轮:${ev.name}…`);
      else if (ev.phase === 'retry') p.done(`  第 ${ev.round} 轮没拿到正文,原样再问一次(${ev.reason})`);
      else if (ev.phase === 'check') {
        // **How many came back must be done, not update.** 「少写了两条」 is the only case on this
        // path where every gate is green and the request still was not met, and being overwritten by
        // the next line leaves nobody knowing
        const miss = ev.missing ? `,少了 ${ev.missing} 条` : '';
        const extra = ev.extra ? `,多写了 ${ev.extra} 条(已忽略)` : '';
        p.done(`  第 ${ev.round} 轮:交回 ${ev.wrote}/${ev.of} 条${miss}${extra}`);
      } else if (ev.phase === 'lint') {
        p.done(`  第 ${ev.round} 轮:这次改动 ${ev.caused} 条要改,旧问题 ${ev.preExisting} 条(不拦)`);
      } else if (ev.phase === 'warn') p.done(`  ⚠️  ${ev.note}`);
      else if (ev.phase === 'backup') p.update('  备份原文…');
      else if (ev.phase === 'backup-done') p.done(`  原文已备份:${ev.path}(${ev.bytes} 字节)`);
      else if (ev.phase === 'notion-patch') p.update(`  改 Notion 上的「${ev.name}」…`);
      else if (ev.phase === 'notion-verify') p.update('  回读整页重新校验…');
    },
  });
  p.done();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('\n' + '─'.repeat(70));
  if (r.ok) {
    console.log(`✅ 改完了 ${r.rewrote.length} 条,${r.rounds} 轮 · ${secs}s → ${r.url}`);
    console.log(`  其余 ${pp.preflight.keeping} 个 checkbox 一字没动`);
    if (r.backup) console.log(`  原文备份:${r.backup.path}`);
  } else {
    // Not passing means not one byte was written — this has to be said, or the user goes looking
    // through the guide for what got damaged
    console.log(`❌ ${r.rounds} 轮之后仍没过,**原攻略一个字都没动**`);
    if (r.missing.length) {
      console.log(`  这 ${r.missing.length} 条模型没交回来:`);
      for (const a of r.missing.slice(0, 8)) {
        const d = plan.defs.find((x) => x.api_name === a);
        console.log(`     ✖ ${achName(d) || a}`);
      }
    }
    for (const f of r.blocking.slice(0, 15)) console.log(`     ✖ ${f.message}`);
    if (r.blocking.length > 15) console.log(`     …… 另外 ${r.blocking.length - 15} 条`);
  }

  // **Not blocking does not mean not mentioning.** The old guide's pre-existing problems were not
  // touched this run, but they are still there
  if (r.preExisting.length) {
    console.log(`\n  ℹ️  这份攻略还有 ${r.preExisting.length} 条原有的校验问题(本次未处理,也没拦路):`);
    for (const f of r.preExisting.slice(0, 5)) console.log(`       ${f.message}`);
    if (r.preExisting.length > 5) console.log(`       …… 还有 ${r.preExisting.length - 5} 条`);
  }
  if (r.unapplied.extra.length) {
    console.log(`\n  ⚠️  模型多写了 ${r.unapplied.extra.length} 条没要求的成就,**已忽略**(只贴回点名的那几条)`);
  }
  if (r.unapplied.unresolved.length) {
    console.log(`  ⚠️  ${r.unapplied.unresolved.length} 条交回来的条目认不出是哪个成就,已忽略`);
  }

  console.log('  ' + formatUsage(r.usage));
  console.log('\n⚠️  只验了格式和数据,内容需要你自己读一遍。');
  if (!r.researched) console.log('    这几条没联网,内容是模型凭已有知识写的。');
  else if (!r.searchQueries?.length) console.log('    ⚠️  一次搜索都没发出去,内容等同于凭记忆写的。');
  else console.log(`\n🔎 搜了 ${r.searchQueries.length} 次:` + r.searchQueries.slice(0, 4).join(' / '));
}

/**
 * Moves a local markdown guide into Notion.
 *
 * `--dry-run` is the recommended first step: whether the conversion loses any formatting and whether
 * Notion can hold it are both visible in the preview, and it writes not one byte.
 */
async function cmdGuideToNotion() {
  const appid = positionalArgs()[0];
  if (!appid) throw new Error('用法:node tracker.js guide-to-notion <appid> [--dry-run] [--yes]');
  // steam is for the page icon (a Steam game icon is added at creation time, matching the pages
  // guide-gen creates)
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
    console.log(`  ⚠️  ${plan.unconverted.length} 行 Notion 放不下原来的排版,会转为普通段落(文字不会丢失):`);
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
 * `drafts`: shows what has piled up in `guides/.drafts/`, and `--clean` clears it.
 *
 * The drafts directory **deliberately** accumulates things: a guide that failed three rounds stays
 * here, because "discarding it burns the money and the time and leaves nothing", and "which findings
 * failed" is itself informative. But what is left will keep piling up if nobody clears it — measured,
 * three files from an A/B comparison months earlier were sitting there with nobody remembering what
 * they were for.
 *
 * **Lists only by default, never deletes.** What lies in this directory was generated with money, and
 * deleting has to be said out loud.
 * `--older-than N` touches only what is more than N days old, so today's failure is not carried off
 * with it.
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

function cmdExport() {
  const dir = positional[0] ?? join(ROOT, 'exports');
  mkdirSync(dir, { recursive: true });
  const { db } = withSteam({ requireSteam: false });
  console.log('\n导出到 ' + dir + ':');
  for (const f of exportAll(db, dir)) console.log(`  ${f.file}(${f.rows} 行)`);
}

/** Records which version wrote this data in the backup manifest — used at restore time to judge whether the format is readable */
function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

/**
 * Backs up into a zip. **This file contains plaintext keys** (all of config.json goes in), so the
 * message has to say so — without that sentence, somebody dropping the backup into cloud storage has
 * no idea what they just dropped.
 * --no-config is the way out for anyone who does not want the keys carried along.
 */
function cmdBackup() {
  const withConfig = !flags.has('--no-config');
  // **DATA_ROOT, not ROOT.** A backup is data and has to live with the data it backs up — the
  // packaged build points its data elsewhere with TRACKER_DATA_DIR (see lib/config.js), and there
  // ROOT is where the code lives. Getting it wrong puts the CLI's and the setup page's 「立即备份」
  // in two different directories while the user is asking one question: where is my backup
  const dir = positional[0] ?? join(DATA_ROOT, 'backups');
  mkdirSync(dir, { recursive: true });

  const { config, db } = withSteam({ requireSteam: false });
  const { zip, manifest } = createBackup({
    db,
    configPath: withConfig ? CONFIG_PATH : null,
    guidesDir: config.guidesDir,
    appVersion: pkgVersion(),
  });

  const out = join(dir, backupName());
  writeFileSync(out, zip);

  console.log('\n✅ 备份好了:' + out);
  console.log(`   ${manifest.counts.games} 款游戏、${manifest.counts.achievements} 条成就、${manifest.counts.guides} 条攻略登记、${manifest.guideFiles} 个攻略文件`);
  console.log(`   ${(zip.length / 1048576).toFixed(1)} MB`);
  if (manifest.hasConfig) {
    console.log('\n⚠️  里面有 config.json,也就是**明文的** Steam / Notion / AI 密钥。');
    console.log('   拿到这个文件的人能花你的 AI 额度。不想带就加 --no-config。');
  }
  console.log('\n换到新机器:把这个 zip 拷过去,`node tracker.js restore <文件>`。');
}

/**
 * Restores from a backup. **Look before acting**: restoring clears the existing tables, so it asks
 * for confirmation by default, and before asking it prints both what is in the backup and what this
 * machine currently holds — a bare 「确定吗?」 conveys no information at all.
 */
async function cmdRestore() {
  const file = positional[0];
  if (!file) throw new Error('用法:node tracker.js restore <备份.zip>');
  if (!existsSync(file)) throw new Error(`找不到 ${file}`);

  const buf = readFileSync(file);
  const { manifest, hasConfig, guideFiles } = inspectBackup(buf);

  const { config, db } = withSteam({ requireSteam: false });
  const existing = countGames(db);

  console.log('\n备份内容:');
  if (manifest) {
    console.log(`  备于 ${new Date(manifest.createdAt).toLocaleString('zh-CN')}` + (manifest.appVersion ? `(版本 ${manifest.appVersion})` : ''));
    console.log(`  ${manifest.counts.games} 款游戏、${manifest.counts.achievements} 条成就、${manifest.counts.guides} 条攻略登记`);
  } else {
    console.log('  (没有清单,可能是手工改过的 zip —— 数据本身还是照读)');
  }
  console.log(`  ${guideFiles.length} 个攻略文件`);
  console.log(`  ${hasConfig ? '含 config.json(本机密钥会被覆盖)' : '不含 config.json'}`);

  const keepConfig = flags.has('--keep-config');
  console.log('\n本机现在:');
  console.log(`  ${existing} 款游戏 —— **会被替换成备份里的那些**`);
  if (hasConfig && keepConfig) console.log('  --keep-config:本机密钥保留不动');

  if (!flags.has('--yes')) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const ans = (await rl.question('\n继续?(y/N) ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') return console.log('没动任何东西。');
    } finally {
      rl.close();
    }
  }

  const r = applyBackup({
    db,
    buf,
    configPath: CONFIG_PATH,
    guidesDir: config.guidesDir,
    restoreConfig: hasConfig && !keepConfig,
  });

  console.log('\n✅ 恢复完成:');
  for (const [t, n] of Object.entries(r.tables)) console.log(`  ${t} → ${n} 行`);
  console.log(`  攻略文件 → ${r.guideFiles} 个`);
  if (r.config) console.log('  config.json → 已覆盖(密钥来自备份)');
  console.log('\n接着跑 `node tracker.js sync` 用 Steam 的最新数据刷一遍。');
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
  node tracker.js export [目录]            三张表导出成 CSV,给表格软件看(默认 exports/,单向,不是备份)
  node tracker.js backup [目录]            打包成一个 zip:数据库 + 攻略 + config.json(默认 backups/)
              backup --no-config          不装 config.json(zip 里就没有明文密钥了)
  node tracker.js restore <文件.zip>       从备份恢复。**会覆盖现有数据**,先问一次
              restore --keep-config       只搬数据,本机的密钥不动
              restore --yes               不问,直接恢复
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
  node tracker.js notion-check            Notion 这一侧的体检:token、库、标题属性、状态选项
                                          --fix         缺的状态选项试着补上(会写你的库,补完回读确认)
                                          --probe-write 建一页再立刻归档,验证 integration 真有写权限
  node tracker.js ai-check [appid]        AI 联网研究链路自检(token 用量会打出来)
              ai-check --dry              只组装请求不发送,先看清楚会发什么(不用 key)
              ai-check --models           问 API 这个 key 能用哪些模型(gemini)
              --provider X --model Y      临时换供应商/模型,不改 config.json
              --effort low|medium|high    这一次查多深(默认 high)。low 快得多,省掉的是
                                          那批中等难度成就的内容,最难那几条两边都写得透
                                          (以上三个 ai-check 和 guide-gen 都支持)
  node tracker.js guide-gen <appid>       让 AI 写一份攻略(默认先问一句才开始)
              guide-gen --dry-run         只打印提示词和落盘计划,一个请求都不发
              guide-gen --overwrite       整篇重写(先备份原文,再告诉你会失去什么)
              guide-gen --only <选择器>    **只重写点名的那几条**,其余一字不动。先备份。
                                          rare[:%] 稀有成就(全球解锁率 <10%)· locked 还没打的
                                          section:小节名 · 或者「成就名A,成就名B」直接点
              guide-gen --note "要求"      配 --only 用,比如 --note "把互斥关系写清楚"
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
  'notion-check': cmdNotionCheck,
  'ai-check': cmdAiCheck,
  'guide-gen': cmdGuideGen,
  'guide-to-notion': cmdGuideToNotion,
  drafts: cmdDrafts,
  audit: cmdAudit,
  export: cmdExport,
  backup: cmdBackup,
  restore: cmdRestore,
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

/**
 * Terminal-only supplementary advice, keyed by the error's `code`.
 *
 * **This is the alternative to "one sentence serving two surfaces".** Error messages in lib/ say only
 * what happened, because the same sentence appears verbatim in the Dashboard's floater, where the
 * user (especially in the packaged build) has no terminal and should not be asked to edit
 * config.json. Conversely, advice like "add --provider X" or "change ai.model" is the most useful
 * thing there is for a terminal user, and should not be dropped to accommodate the other surface.
 *
 * It hangs here rather than in each command: every command's errors leave through the catch below,
 * so one place is enough.
 */
const GEMINI_MODEL_HINT =
  '  换模型:--model <名字>,或者改 config.json 的 ai.model。\n' +
  '  有哪些可用跑 `node tracker.js ai-check --models` —— 但注意列出来 ≠ 能用,\n' +
  '  停售的模型照样出现在那个列表里。';

const CLI_HINTS = {
  'provider-model-mismatch': (d) =>
    `  要用这个模型:加 --provider ${d.belongsTo}\n` +
    `  要用 ${d.provider}:换成它自己的模型(--model <名字>,或改 config.json 的 ai.model)\n` +
    '  注意环境变量会盖掉 config.json,清掉:\n' +
    '    Remove-Item Env:AI_PROVIDER, Env:AI_MODEL -ErrorAction SilentlyContinue',
  'too-many-achievements': (d) =>
    `  真要写就调大 config.json 的 ai.maxAchievements(当前 ${d.max},这款要 ${d.count})。`,
  // Every Gemini model-name problem funnels to the same advice: ask the API for the list, then change
  // the model
  'gemini-model-retired': () => GEMINI_MODEL_HINT,
  'gemini-model-unknown': () => GEMINI_MODEL_HINT,
  'gemini-no-allowance': () => GEMINI_MODEL_HINT,
  'gemini-429-no-detail': () =>
    '  换个具体模型试:AI_MODEL=gemini-2.5-flash —— 别用 -latest 别名,\n' +
    '  别名可能解析到一个不在免费层的新模型。',
  'gemini-tool-rejected': () =>
    '  改 config.json 的 ai.geminiTools,默认值是 ["google_search"];去掉 url_context 再试。',
  'bad-api-key': (d) =>
    `  注意环境变量 ${d.envVar} 会盖掉 config.json,清掉再试:\n` +
    `    Remove-Item Env:${d.envVar} -ErrorAction SilentlyContinue`,
  'deepseek-length': () =>
    '  也可以把 config.json 的 ai.maxTokens 调小(DeepSeek 的上限比另外两家小)。',
  'guide-exists': () =>
    '  要整篇重写加 --overwrite(会先备份,并给出新旧对照)。\n' +
    '  只想改其中几条:--only <选择器>(rare / locked /\n' +
    '  section:小节名 / 成就名或 api_name 的逗号列表),配 --note "要求"。',
  'file-exists': () => '  覆盖它加 --overwrite,或者用 --file 换个文件名。',
  // ---- Partial rewrite (--only) ----
  'no-guide-to-patch': () =>
    '  --only 是改已有攻略里的几条。这一款还没有攻略,先生成一份:\n' +
    '  去掉 --only 直接跑 guide-gen。',
  'unknown-achievements': () =>
    '  名字要和 Steam 上一字不差(中文名或英文名都行)。同名的成就按名字点不动 ——\n' +
    '  用 api_name 点它,`node tracker.js guide-lint <appid>` 里能看到。',
  'empty-scope-result': (d) =>
    `  「${d.selector}」一条都没选中。放宽阈值试试:--only rare:30,\n` +
    '  或者直接点名:--only "成就名A,成就名B"。',
  'nothing-locatable': () =>
    '  点名的成就在攻略里都没有对应的 checkbox —— 那是"压根没写",不是"写得不好"。\n' +
    '  这种要整篇重写(--overwrite),局部重写没有可以替换的位置。',
  'no-rarity': () =>
    '  Steam 这次没给出全球解锁率(限流或临时故障),等会儿再试,\n' +
    '  或者换个不依赖它的选择器:--only thin / --only locked。',
  'section-needs-local': () =>
    '  命令行这条路按小节挑需要本地攻略全文。\n' +
    '  Notion 上的攻略要按小节挑,去 Dashboard 点 ♻ 重写 →「自选…」——\n' +
    '  那边读的是整页的块,小节结构在(点小节标题就是整节选中)。',
  'bad-scope': () => '  选择器的写法:rare[:百分比] / locked / section:小节名。',
  // Nothing at all after `--only`. **Kept separate from bad-scope**: that one is a wrong spelling,
  // this one is nothing written — the former needs the spelling corrected, the latter needs to know
  // which spellings exist in the first place
  'empty-scope': () =>
    '  --only 后面要跟选择器:rare[:百分比] 稀有成就(全球解锁率 <10%)/\n' +
    '  locked 还没打的 / section:小节名,或者「成就名A,成就名B」直接点名。\n' +
    '  想整篇重写的话用 --overwrite,不要 --only。',
  'chunk-too-small': (d) =>
    `  别急着调大 ai.maxTokens —— 它是 thinking + 正文的总额,而一段只剩 ${d.size} 个成就\n` +
    '  还写不完,说明吃掉额度的是思考,调大只会让它想得更久(CLAUDE.md 有实测)。\n' +
    '  能压住思考的只有官方端点(ai.anthropicExtras 那几个参数兼容端点不收)。',
};

try {
  await fn();
} catch (err) {
  console.error('\n❌ ' + (err.message ?? err));
  const hint = CLI_HINTS[err.code];
  if (hint) console.error(hint(err.detail ?? {}));
  if (process.env.DEBUG) console.error(err.stack);
  // **Do not use process.exit().** Forcing an exit interrupts libuv while sockets and timers are
  // still being torn down, which on Windows shows up as
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — and it happens after the error message
  // has printed, so it looks like two unrelated things.
  // Setting exitCode lets Node exit naturally, with the same exit code of 1
  process.exitCode = 1;
}
