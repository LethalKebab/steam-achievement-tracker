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
import { setMessageLanguage, messageLanguage, achName } from './lib/messages.js';
import { serve } from './lib/server.js';
import { clog } from './lib/cli-messages.js';
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
  for (const [name, label] of [['AI_PROVIDER', 'env.provider'], ['AI_MODEL', 'env.model']]) {
    if (process.env[name]) {
      notes.push(clog('env.fromEnv', { label: clog(label), name, value: process.env[name] }));
    }
  }
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY']) {
    if (process.env[name]) notes.push(clog('env.keyFromEnv', { name }));
  }
  for (const n of notes) console.log(`  ⚠️  ${n}`);
  if (notes.length) {
    console.log(clog('env.clear'));
  }
}

/** A provider instance. `--dry` / `--dry-run` sends nothing, so it has to be constructible without a key */
async function providerFor(config, { needKey = true } = {}) {
  const ai = !needKey && !config.ai.apiKey ? { ...config.ai, apiKey: clog('env.dryRunKey') } : config.ai;
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

// The label is a key now; the text lives in `lib/tracker-messages.js` like everything else the
// CLI prints. A phase with no entry still falls through to its own raw name below
const PHASE_LABEL = { library: 'phase.library', 'library-en': 'phase.libraryEn', achievements: 'phase.achievements', schema: 'phase.schema' };

function makeProgressHandler(p) {
  return (ev) => {
    const label = PHASE_LABEL[ev.phase] ? clog(PHASE_LABEL[ev.phase]) : (ev.phase ?? '');
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
  stdout.write(clog('nb.querying'));
  const { pages, truncated } = await probe.searchPages();
  if (!pages.length) {
    console.log(clog('nb.noPages'));
    console.log(clog('nb.noPagesWhy'));
    console.log(clog('nb.noPagesHow'));
    return '';
  }
  console.log(clog('nb.canSee', { n: pages.length, more: truncated ? clog('nb.andMore') : '' }));
  pages.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.title}`));

  const pick = Number(await io.ask(clog('nb.pick', { n: pages.length })));
  if (!Number.isInteger(pick) || pick < 1 || pick > pages.length) {
    throw new Error(clog('nb.badPick'));
  }
  const title = (await io.ask(clog('nb.nameAsk'))) || clog('nb.defaultName');

  stdout.write(clog('nb.creating'));
  const db = await probe.createGuideDatabase({ parentPageId: pages[pick - 1].id, title });
  console.log(clog('nb.created', { url: db.url }));
  console.log(clog('nb.options', { options: db.options.join(' / ') }));
  console.log(clog('nb.groupNote'));
  console.log(clog('nb.groupNote2'));
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
    console.log(clog('in.title'));
    // The English terms are always copied verbatim from Notion's own UI, never conceptual names like
    // "Internal Integration" — those five words appear nowhere in Notion, so somebody looking for
    // them will not find them. Notion has renamed these more than once (it used to be New
    // integration / Internal Integration Secret), so what is copied is the wording of the current one
    console.log(clog('in.tokenWhere'));
    console.log(clog('in.tokenWhere2'));
    console.log(clog('in.tokenWhere3'));
    console.log(clog('in.tokenWhere4'));
    console.log(clog('in.tokenDocs'));

    const token = await io.askSecret(clog('in.tokenAsk'));
    if (!token) throw new Error(clog('in.tokenMissing'));

    const probe = new NotionClient({ notion: { token } });

    stdout.write(clog('in.verifying'));
    const me = await probe.request('get', '/users/me');
    console.log(clog('in.tokenOk', { name: me.name || me.bot?.workspace_name || clog('in.unnamed') }));

    let dbId = '';
    let dbOk = false;

    if (create) {
      // The newly created ID would overwrite the existing one, and that would move a database holding
      // hundreds of guides entirely out of the tool's view. It is not blocked outright (the command
      // line is an explicit action), but it has to ask first — the GUI refuses it, because a click is
      // far too easy
      const had = cfg.notion?.overviewDbId;
      if (had) {
        console.log(clog('in.hasDb', { url: had }));
        console.log(clog('in.hasDbWarn'));
        const yes = await io.ask(clog('in.hasDbConfirm'));
        if (!/^y/i.test(yes)) throw new Error(clog('in.cancelled'));
      }
      dbId = await createGuideDbInteractively(io, probe);
      dbOk = Boolean(dbId);
      // dbId is empty when the user never picked a page (because none were visible, say) — and an
      // empty value must never overwrite an existing configuration, which would amount to losing
      // somebody's database over one failed attempt
      if (!dbId && had) dbId = had;
    } else {
      const dbDefault = cfg.notion?.overviewDbId || '';
      dbId = (await io.ask(clog('in.dbIdAsk', { default: dbDefault ? clog('in.dbIdDefault', { id: dbDefault }) : '' }))) || dbDefault;
      if (!dbId) {
        console.log(clog('in.noDbHint'));
      } else {
        stdout.write(clog('in.dbChecking'));
        try {
          const pages = await probe.queryGuideDatabase(dbId);
          console.log(clog('in.dbOk', { n: pages.length }));
          dbOk = true;
        } catch (err) {
          // **Connections cannot be the only thing mentioned** — that sends somebody who entered a
          // page ID off to check permissions over and over. Three faults, three fixes, said once
          console.log(clog('in.dbFailed', { reason: err.message }));
          console.log(clog('in.dbFailedWhy'));
          console.log(clog('in.dbFailedA'));
          console.log(clog('in.dbFailedA2'));
          console.log(clog('in.dbFailedB'));
          console.log(clog('in.dbFailedC'));
        }
      }
    }

    saveConfig({ notion: { token, overviewDbId: dbId } });
    console.log(clog('in.written', { path: CONFIG_PATH }));
    console.log(clog('in.next'));
    console.log(clog('in.nextCheck'));
    console.log(clog('in.nextGuides'));
    console.log(clog('in.nextCbs'));
    if (!dbOk && dbId) console.log(clog('in.dbStepFailed'));
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
  if (r.regrouped?.length) console.log(clog('fix.regrouped', { names: r.regrouped.join(' / ') }));
  if (r.stillWrongGroup?.length) console.log(clog('fix.stillWrongGroup', { names: r.stillWrongGroup.join(' / ') }));
  if (r.boardView?.created) console.log(clog('fix.boardCreated'));
  else if (r.boardView && !r.boardView.ok) {
    console.log(clog('fix.boardFailed', { reason: r.boardView.error }));
    console.log(clog('fix.boardHarmless'));
  }
  if (r.colour?.recoloured?.length) {
    const done = r.colour.recoloured.map((n) => `${n} ${clog(COLOUR_ZH[GUIDE_STATUS_STYLE[n].color])}`).join(',');
    console.log(clog('fix.recoloured', { names: done }));
    // Say it out loud. Pages that had to be written back are pages Notion did not bring back on its
    // own, and that is the one number telling you the snapshot earned its keep
    if (r.colour.restored?.length) {
      console.log(clog('fix.restored', { n: r.colour.restored.length, names: r.colour.restored.slice(0, 5).join('、') }));
    }
  }
  if (r.colour?.stillWrong?.length) {
    const want = r.colour.stillWrong.map((n) => `${n} ${clog(COLOUR_ZH[GUIDE_STATUS_STYLE[n].color])}`).join(',');
    console.log(clog('fix.colourFailed', { names: want }));
    if (r.colour.error) console.log(`      ${r.colour.error}`);
    console.log(clog('fix.colourByHand'));
  }
}

async function cmdNotionCheck() {
  const { config, db } = withSteam({ requireSteam: false });
  const token = config.notion?.token;
  const dbId = config.notion?.overviewDbId;

  if (!token) {
    console.log(clog('nc.noToken'));
    console.log(clog('nc.noTokenFix'));
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
    console.log(clog('nc.noDbId'));
    console.log(clog('nc.noDbIdFix'));
    return;
  }

  const unreadable = problem(DB_PROBLEM.DB_UNREADABLE);
  if (unreadable) {
    console.log(`❌ ${unreadable.message}`);
    console.log(clog('nc.twoCauses'));
    for (const c of unreadable.causes) console.log(`   · ${c}`);
    return;
  }
  console.log(clog('nc.database', { title: verdict.database.title }));
  if (problem(DB_PROBLEM.NO_TITLE_PROP)) say(problem(DB_PROBLEM.NO_TITLE_PROP));
  else console.log(clog('nc.titleProp', { name: verdict.schema.titleProperty }));

  const noStatus = problem(DB_PROBLEM.NO_STATUS_PROP);
  const missingOpts = problem(DB_PROBLEM.MISSING_OPTIONS);
  if (noStatus) {
    console.log(clog('nc.noStatus'));
    console.log(clog('nc.noStatus2'));
    console.log(clog('nc.noStatus3', { options: noStatus.wanted.join(' / ') }));
  } else if (missingOpts) {
    console.log(clog('nc.statusProp', { property: missingOpts.property, type: missingOpts.type }));
    console.log(clog('nc.statusHave', { have: missingOpts.have.join(' / ') || clog('nc.statusNone') }));
    console.log(clog('nc.statusMissing', { missing: missingOpts.missing.join(' / ') }));
    console.log(clog('nc.statusBlocks'));
    if (missingOpts.missing.some((o) => ['Not started', 'In progress', 'Done'].includes(o))) {
      console.log(clog('nc.statusUsedNew'));
    }
    if (missingOpts.missing.includes('Staged')) {
      console.log(clog('nc.statusUsedStaged'));
    }
    if (argv.includes('--fix')) {
      // Adding options **writes to the user's database**, so it only happens when explicitly asked,
      // and success is judged by the read-back rather than by the 200
      const r = await repairGuideDb(notion, dbId);
      if (r.ok) console.log(clog('nc.fixed', { added: r.added.join(' / ') }));
      else if (r.reason === 'clobbered') {
        console.log(clog('nc.clobbered', { names: r.clobbered.join(' / ') }));
      } else {
        console.log(clog('nc.stillMissing', { names: r.stillMissing.join(' / ') }));
        console.log(clog('nc.addByHand'));
      }
      reportReformat(r);
    } else {
      console.log(clog('nc.tryFix'));
    }
  } else {
    console.log(clog('nc.statusOk', { property: verdict.schema.status.property, type: verdict.schema.status.type }));
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
    console.log(clog('nc.probeOk'));
  }
  const stranded = problem(DB_PROBLEM.STRANDED_PROBE_PAGE);
  if (stranded) console.log(`⚠️  ${stranded.message}:${stranded.url}`);

  const pages = await notion.queryGuideDatabase(dbId);
  const registered = allGuides(db).filter((g) => g.kind === 'notion').length;
  console.log(clog('nc.pages', { pages: pages.length, registered }));
  if (pages.length > registered) {
    console.log(clog('nc.unregistered', { n: pages.length - registered }));
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
    note: 'prov.deepseek',
    env: 'DEEPSEEK_API_KEY',
  },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    note: 'prov.anthropic',
    env: 'ANTHROPIC_API_KEY',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    note: 'prov.gemini',
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
    console.log(clog('ia.title'));
    console.log(clog('ia.what'));
    console.log(clog('ia.optional'));

    AI_PROVIDERS.forEach((p, i) => {
      console.log(`  ${i + 1}) ${p.label.padEnd(20)} ${clog(p.note)}`);
    });
    const pick = (await io.ask(clog('ia.pick', { n: AI_PROVIDERS.length }))) || '1';
    const chosen = AI_PROVIDERS[Number(pick) - 1];
    if (!chosen) throw new Error(clog('ia.badPick', { pick }));

    const key = await io.askSecret(clog('ia.keyAsk', { label: chosen.label }));
    if (!key) throw new Error(clog('ia.keyMissing'));

    const model = await io.ask(clog('ia.modelAsk'));

    const ai = { provider: chosen.key, apiKey: key.trim(), model: model.trim() };
    const provider = await createProvider({ ai: { ...loadConfig().ai, ...ai } });

    // Send one real request. Minimised: no web tools attached, one character wanted back
    stdout.write(clog('ia.verifying', { model: provider.model }));
    const r = await provider.send({ messages: [{ role: 'user', content: clog('ia.probe') }] });
    const verdict = checkResult(r);
    if (!verdict.ok) throw new Error(clog('ia.verifyFailed', { reason: verdict.reason }));
    console.log(clog('ia.ok', { name: provider.name, model: provider.model, reply: r.text.trim().slice(0, 10) }));
    console.log(`   ${formatUsage(r.usage)}`);

    // An empty model is not written into the config, so the default in the code keeps applying (and
    // that one follows the version)
    saveConfig({ ai: model.trim() ? ai : { provider: ai.provider, apiKey: ai.apiKey } });
    console.log(clog('ia.written', { path: CONFIG_PATH }));
    console.log(clog('in.next'));
    console.log(clog('ia.nextCheck'));
    console.log(clog('ia.nextGen'));
    console.log(clog('ia.envNote', { env: chosen.env }));
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
    console.log(clog('init.title'));

    if (current.steamApiKey && current.steamId) {
      console.log(clog('init.hasConfig', { path: CONFIG_PATH }));
      console.log(`  STEAM_ID = ${current.steamId}`);
      const again = await rl.question(clog('init.again'));
      if (!/^y/i.test(again)) return;
    }

    console.log(clog('init.needTwo'));
    console.log('  ① Steam Web API Key → https://steamcommunity.com/dev/apikey');
    console.log(clog('init.needSteamId'));

    const key = (flagValue('key') ?? (await rl.question('① Steam Web API Key: '))).trim();
    const id = (flagValue('id') ?? (await rl.question('② SteamID64: '))).trim();
    if (!key || !id) throw new Error(clog('init.bothRequired'));
    if (!/^\d{17}$/.test(id)) console.log(clog('init.oddId'));

    saveConfig({ steamApiKey: key, steamId: id });
    const config = loadConfig({ required: ['steam'] });
    openDb(config.dbPath);
    console.log(clog('init.written', { path: CONFIG_PATH }));
    console.log(clog('init.dbMade', { path: config.dbPath }));

    // Verify with a real request immediately, so bad credentials are not discovered halfway through a
    // sync later
    process.stdout.write(clog('init.verifying'));
    try {
      const steam = new SteamClient(config);
      const games = await steam.fetchOwnedGames(false);
      console.log(clog('init.credsOk', { n: games.length }));
    } catch (err) {
      console.log(clog('init.credsFailed', { reason: err.message }));
      console.log(clog('init.credsFix'));
      return;
    }

    console.log(clog('in.next'));
    console.log(clog('init.nextSync'));
    console.log(clog('init.nextServe'));
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
    clog(selection ? 'sync.startFast' : 'sync.start')
  );
  const t0 = Date.now();

  if (only.length === 0) {
    const r = await fullSync(db, steam, { onProgress, selection });
    p.done();
    console.log(
      clog('sync.library', {
        owned: r.library.ownedCount, unvetted: r.library.unvettedCount,
        added: r.library.added.length, restamped: r.library.restamped,
      }) +
        // Only when something moved: after the first run this is 0 on every sync, and a permanent
        // 「补英文名 0 款」 is noise on the one line that has to stay readable
        (r.library.namedEn ? clog('sync.namedEn', { n: r.library.namedEn }) : '')
    );
    if (r.library.added.length) console.log(clog('sync.added', { names: r.library.added.map((a) => a.name).join('、') }));
    console.log(clog('sync.stats', { updated: r.stats.updated, noSystem: r.stats.noSystem, retried: r.stats.retried }));
    const s = r.stats.selection;
    if (s.gated) {
      console.log(
        clog('sync.sample', { total: s.total, played: s.played, unowned: s.unowned, swept: s.swept })
        + (s.sweepPending ? clog('sync.samplePending', { n: s.sweepPending }) : '')
      );
    }
    if (r.stats.bumped.length) console.log(clog('sync.bumped', { names: r.stats.bumped.join('、') }));
    console.log(clog('sync.schema', { processed: r.schema.processed, candidates: r.schema.candidates, skipped: r.schema.skippedNoSchema }));
  } else {
    if (only.includes('library')) {
      const r = await syncLibrary(db, steam, { onProgress });
      p.done(
        clog('sync.libraryShort', { added: r.added.length, restamped: r.restamped })
          + (r.namedEn ? clog('sync.namedEn', { n: r.namedEn }) : '')
      );
    }
    if (only.includes('achievements')) {
      const r = await syncAchievementStats(db, steam, { onProgress });
      p.done(clog('sync.stats', { updated: r.updated, noSystem: r.noSystem, retried: r.retried }));
    }
    if (only.includes('schema')) {
      const r = await syncAchievementSchema(db, steam, { onProgress });
      p.done(clog('sync.schemaShort', { processed: r.processed, candidates: r.candidates }));
    }
  }

  const agcr = computeAgcrStats(db);
  console.log(clog('sync.done', {
    seconds: ((Date.now() - t0) / 1000).toFixed(0),
    pct: Math.floor(agcr.avg * 100), exact: (agcr.avg * 100).toFixed(3), perfect: agcr.perfectCount,
  }));
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

  // **The locale follows the interface language, not the machine.** `toLocaleString` with a
  // hardcoded 'zh-CN' prints a Chinese-formatted timestamp under an English interface — the one
  // thing in this block that no string table would have caught
  const locale = messageLanguage() === 'en' ? 'en-GB' : 'zh-CN';
  const guides = allGuides(db);
  console.log(clog('status.db', { n: countGames(db) }));
  console.log(clog('status.lastSync', { when: last ? new Date(last).toLocaleString(locale) : clog('status.never') }));
  console.log(clog('status.agcr', { pct: Math.floor(agcr.avg * 100), exact: (agcr.avg * 100).toFixed(3), n: agcr.eligibleCount }));
  console.log(clog('status.perfect', { n: agcr.perfectCount }));
  console.log(clog('status.flags', {
    unvetted: count((g) => g.status === 'Unvetted'),
    manual: count((g) => g.status === 'Manual'),
    family: count((g) => g.family),
  }));
  console.log(clog('status.marks', { fav: count((g) => g.favorite), pri: count((g) => g.priority) }));
  console.log(clog('status.noAch', {
    none: count((g) => g.has_achievements === 0),
    unsynced: count((g) => g.total === null && g.has_achievements !== 0),
  }));
  console.log(clog('status.guides', {
    n: guides.length,
    notion: guides.filter((g) => g.kind === 'notion').length,
    local: guides.filter((g) => g.kind === 'local').length,
  }));
}

async function cmdGuides() {
  const { config, db } = withSteam({ requireSteam: false });
  const wantLocal = flags.has('--local') || flags.has('--all') || flags.size === 0;
  const wantNotion = flags.has('--notion') || flags.has('--all') || flags.size === 0;

  if (wantLocal) {
    const r = syncGuidesFromMarkdown(db, config, { force: flags.has('--force') });
    console.log(clog('guides.local', { files: r.files, added: r.added.length }));
    for (const a of r.added) console.log(`  ${a.action === 'appended' ? '+' : '~'} ${a.appid}  ${a.name}  (${a.file})`);
    if (r.skipped.length) console.log(clog('guides.skipped', { names: r.skipped.join('、') }));
    for (const c of r.conflicts) {
      console.log(clog('guides.conflict', { appid: c.appid, file: c.file }));
    }
  }

  if (wantNotion) {
    const notion = new NotionClient(config);
    if (!notion.configured) {
      console.log(clog('guides.noToken'));
    } else {
      const r = await syncGuidesFromNotion(db, notion);
      console.log(clog('guides.notion', { pages: r.dbPages, fresh: r.newPagesChecked, added: r.added.length }));
      for (const a of r.added) console.log(`  + ${a.appid}  ${a.name}`);
      for (const f of r.failed) console.log(`  ⚠️  ${f.title}:${f.error}`);
    }
  }

  console.log(clog('guides.table', { n: allGuides(db).length }));
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
    return console.log(clog('gs.noToken'));
  }
  const dryRun = flags.has('--dry-run');
  if (dryRun) console.log(clog('gs.dryRun'));

  const r = await syncGuideStatuses(db, { notion, dryRun });
  const up = r.updates.filter((u) => u.reason === 'complete').length;
  const down = r.updates.filter((u) => u.reason === 'incomplete').length;
  console.log(clog('gs.summary', { pages: r.pages, up, down }));
  for (const l of r.logs) console.log(`  ${l.gameName} — ${l.result}`);
  if (!r.updates.length) console.log(clog('gs.nothing'));
  else if (dryRun) console.log(clog('gs.rerun'));
}

async function cmdCheckboxSync() {
  const { config, db, steam } = withSteam();
  const notion = new NotionClient(config);
  const appid = positional[0] ?? null;
  const dryRun = flags.has('--dry-run');
  const cascade = !flags.has('--no-cascade');
  const p = progressPrinter();

  if (dryRun) console.log(clog('cbs.dryRun'));
  if (!cascade) console.log(clog('cbs.noCascade'));

  const r = await checkboxSync(db, steam, {
    notion,
    config,
    appid,
    dryRun,
    cascade,
    onProgress: (ev) => p.update(`  ${ev.done}/${ev.total} ${ev.name}`),
  });
  p.done(clog('cbs.checked', { games: r.checked, logs: r.logs.length }));

  // Printed grouped by game; a flat list of a few hundred entries is unreadable
  const byGame = new Map();
  for (const l of r.logs) {
    if (!byGame.has(l.gameName)) byGame.set(l.gameName, []);
    byGame.get(l.gameName).push(l);
  }
  for (const [game, logs] of byGame) {
    console.log(clog('cbs.game', { game, n: logs.length }));
    for (const l of logs) console.log(`    ${l.achievement || '—'} → ${l.result}`);
  }

  if (r.checked === 0) {
    console.log(clog('cbs.noCandidates'));
  } else if (dryRun) {
    const willCheck = r.logs.filter((l) => l.code === 'would-tick').length;
    console.log(
      clog('cbs.dryRunEnd', { n: willCheck })
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

  console.log(clog('audit.intro'));
  const { results, totals, candidates } = await auditGuideTicks(db, steam, {
    notion,
    config,
    appid: positional[0] ?? null,
    onProgress: (ev) => p.update(`  ${ev.done}/${ev.total} ${ev.name}`),
  });
  p.done();

  for (const r of results) {
    if (r.skipped) {
      console.log(clog('audit.skipped', { name: r.name, reason: r.skipped }));
      continue;
    }
    if (r.wrong.length === 0) continue;
    console.log(clog('audit.wrongGame', { name: r.name, ticked: r.ticked, wrong: r.wrong.length }));
    for (const w of r.wrong) {
      console.log(clog('audit.wrongEntry', { name: w.name, apiName: w.apiName, via: clog(w.via === 'description' ? 'audit.viaDesc' : 'audit.viaName') }));
      console.log(`       ${w.text.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }

  console.log(
    clog('audit.total', { games: totals.games, candidates, ticked: totals.ticked })
  );
  console.log(clog('audit.wrongTotal', { n: totals.wrong }));
  // The coverage has to be stated honestly: the ones that could not be resolved carry no verdict, and
  // "0 wrong" must not look stronger than the audit's actual coverage
  console.log(clog('audit.unresolved', { n: totals.unresolved }));
  if (totals.skipped) console.log(clog('audit.skippedTotal', { n: totals.skipped }));
  if (totals.wrong > 0) {
    console.log(clog('audit.fixByHand'));
    console.log(clog('audit.checkFirst'));
  }
}

/** guidelint's code → a human sentence. The per-guide summary and the totals share one set, so the two cannot disagree on naming */
const CODE_LABELS = {
  'missing-checkbox': 'code.missingCheckbox',
  'merged-line': 'code.mergedLine',
  'ambiguous-no-description': 'code.ambiguousNoDesc',
  'checked-mismatch': 'code.checkedMismatch',
  'missing-title': 'code.missingTitle',
  'paraphrased-description': 'code.paraphrased',
  'stats-in-heading': 'code.statsInHeading',
  'data-source-note': 'code.dataSourceNote',
};

/** A lint code as a sentence, falling back to the raw code so a new one is still legible */
const codeLabel = (code) => (CODE_LABELS[code] ? clog(CODE_LABELS[code]) : code);

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

  console.log(clog('lint.intro'));
  if (checkTicks) console.log(clog('lint.withTicks'));
  else console.log(clog('lint.withoutTicks'));

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
      if (detail) console.log(clog('lint.skipped', { name: r.name, reason: r.skipped }));
      continue;
    }
    const { findings, stats } = r.lint;
    if (findings.length === 0 && !detail) continue;

    const mark = stats.errors ? '❌' : findings.length ? '⚠️ ' : '✅';
    console.log(
      clog('lint.guide', { mark, name: r.name, appid: r.appid, covered: stats.covered, achievements: stats.achievements, todos: stats.todos })
    );
    if (detail) {
      for (const f of findings) console.log(`     ${f.level === 'error' ? '✖' : '·'} ${f.message}`);
      continue;
    }
    const byCode = new Map();
    for (const f of findings) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}  ${codeLabel(code)}`);
    }
  }
  if (!detail && results.some((r) => !r.skipped && r.lint.findings.length)) {
    console.log(clog('lint.perGuide'));
  }

  console.log(
    clog('lint.total', { guides: totals.guides, noErrors: totals.noErrors, clean: totals.clean })
  );
  if (totals.skipped) {
    console.log(clog('lint.skippedTotal', { n: totals.skipped }));
  }
  if (totals.achievements) {
    const pct = ((totals.covered / totals.achievements) * 100).toFixed(1);
    console.log(clog('lint.coverage', { covered: totals.covered, achievements: totals.achievements, pct }));
  }
  const entries = Object.entries(totals.byCode).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    console.log(clog('lint.byKind'));
    for (const [code, n] of entries) {
      console.log(`    ${String(n).padStart(4)}  ${codeLabel(code)}`);
    }
  }
  if (totals.errors === 0) console.log(clog('lint.noErrors'));
  else console.log(clog('lint.errorTotal', { errors: totals.errors, warnings: totals.warnings }));
}

/** Picks a game that has achievement detail for the smoke test. With no appid given, takes the first usable one in the library */
function pickSmokeTarget(db, appid) {
  if (appid) {
    const defs = achievementsFor(db, appid);
    if (!defs.length) {
      throw new Error(clog('smoke.noDetail', { appid }));
    }
    return { appid: String(appid), name: getGame(db, appid)?.name || defs[0].game_name || String(appid), defs };
  }
  const withAch = appIdsWithAchievements(db);
  for (const g of allGames(db)) {
    if (!withAch.has(String(g.appid))) continue;
    const defs = achievementsFor(db, g.appid);
    if (defs.length) return { appid: String(g.appid), name: g.name || String(g.appid), defs };
  }
  throw new Error(clog('smoke.noneAtAll'));
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
      throw new Error(clog('ac.noModelList', { name: provider.name }));
    }
    const models = await provider.listModels();
    console.log(clog('ac.modelList', { name: provider.name, n: models.length }));
    for (const m of models) {
      const limits = m.inputLimit ? clog('ac.modelLimits', { input: m.inputLimit, output: m.outputLimit }) : '';
      console.log(`  ${m.name.padEnd(34)}${m.display}${limits}`);
    }
    // Measured: the 2.5 series is no longer sold to new keys, yet it still appears in this list. This
    // endpoint says only "it exists", never "you can use it" — not saying so makes people try items
    // off the list over and over
    console.log(
      clog('ac.listedNotUsable')
    );
    console.log(clog('ac.currentModel', { model: provider.model }));
    return;
  }

  const db = openDb(config.dbPath);
  const target = pickSmokeTarget(db, positionalArgs()[0] ?? null);
  const def = target.defs.find((d) => d.description) ?? target.defs[0];
  const shownName = achName(def);

  // **The probe follows the interface language too.** It is a smoke test whose whole output the
  // user reads, so a Chinese answer under an English interface is the same failure as a Chinese
  // message would be — and it is the one place where the language reaches the model rather than the
  // terminal
  const system = clog('ac.probeSystem');
  const question =
    clog('ac.probeQuestion', { game: target.name, appid: target.appid, achievement: shownName })
    + (def.description ? clog('ac.probeDesc', { description: def.description }) : '')
    +
    // No specific tool is named: the two vendors call their tools different things, and hardcoding
    // one vendor's name leaves the other unable to understand it
    clog('ac.probeTask');

  const provider = await providerFor(config, { needKey: !dry });
  const tools = provider.webTools();

  if (dry) {
    const body = provider.buildBody({ system, messages: [{ role: 'user', content: question }], tools });
    console.log(clog('ac.dryRun', { name: provider.name, model: provider.model }));
    console.log(clog(config.ai.apiKey ? 'ac.keySet' : 'ac.keyUnset'));
    console.log(clog('ac.requestBody'));
    console.log(JSON.stringify(body, null, 2));
    console.log(clog('ac.dryRunEnd'));
    return;
  }

  console.log(clog('ac.header', { name: provider.name, model: provider.model, tools: tools.length }));
  warnEnvOverrides();
  console.log(clog('ac.subject', { game: target.name, achievement: shownName }));

  const session = createSession(provider, { system, tools });
  const t0 = Date.now();
  const r = await session.ask(question, {
    onEvent(ev) {
      // With web access and deep thinking, several minutes of silence is normal. Printing the tool
      // activity is what separates "working" from "stuck"
      if (ev.type === 'tool') stdout.write(`\n  → ${ev.name} …`);
      else if (ev.type === 'tool-result') stdout.write(ev.ok ? ' ok' : clog('ac.toolFailed', { code: ev.errorCode }));
      else if (ev.type === 'search') stdout.write(`\n  🔎 ${ev.query}`);
      else if (ev.type === 'text') stdout.write(ev.text);
    },
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const verdict = checkResult(r);
  console.log('\n\n' + '─'.repeat(60));
  console.log(verdict.ok ? clog('ac.endToEnd') : clog('ac.roundUnusable', { reason: verdict.reason }));
  console.log(
    clog('ac.stopReason', {
      stop: r.stopReason,
      raw: r.rawStopReason && r.rawStopReason !== r.stopReason ? clog('ac.rawStop', { raw: r.rawStopReason }) : '',
      continuations: r.continuations, secs,
    })
  );
  console.log('  ' + formatUsage(session.usage));

  // This line is the one most worth looking at in this command: **the web tools were declared, but
  // did the model actually search**. Whether the free tier includes web access is not reliably
  // answerable from the docs, and the response is more reliable than the pricing page
  if (r.searchQueries?.length) {
    console.log(clog('ac.searches', { n: r.searchQueries.length, queries: r.searchQueries.slice(0, 5).join(' / ') }));
  } else if (tools.length) {
    console.log(clog('ac.noSearch'));
    console.log(clog('ac.noSearch2'));
  }
  // A failed page fetch is normal on a per-URL basis; flagging it stops the next person who sees this
  // line from going off to investigate whether web access is broken
  for (const e of r.toolErrors ?? []) {
    const tail = e.tool === 'fetch' ? clog('ac.toolFetchNote') : '';
    console.log(clog('ac.toolError', { tool: clog(e.tool === 'fetch' ? 'ac.toolFetch' : 'ac.toolSearch'), code: e.errorCode, tail }));
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
      clog('gg.usage')
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
  console.log(clog('gg.counts', { n: plan.defs.length, unlocked: plan.unlocked.size }));
  if (plan.unnameable.size) {
    console.log(clog('gg.unnameable', { n: plan.unnameable.size }));
  }
  // "Has server-side search" is a hard admission criterion set by the design doc, on the grounds that
  // "letting one without search in makes quality depend on which vendor the user picked, and the user
  // cannot see that difference". So it cannot be waived by default; the person has to **explicitly
  // know what they are asking for**
  const probe = await providerFor(config, { needKey: !dryRun });

  // Prints the model name the provider resolved, not the one in the config: when switching provider
  // without specifying a model, the config's is empty and what is really used is that vendor's default
  console.log(clog('gg.provider', { name: probe.name, model: probe.model, rounds }));
  warnEnvOverrides();
  if (plan.existing) {
    // Overwriting is the one irreversible action in this command, so it gets its own paragraph, and
    // it is printed **before** the "continue?" question
    const where = clog(plan.existing.kind === 'notion' ? 'gg.notionPage' : 'gg.localFile');
    console.log(clog('gg.overwriting', { where, url: plan.existing.url }));
    console.log(formatPreflight(overwritePreflight(plan), { defsCount: plan.defs.length }));
    // A failed backup means nothing is written, and deleting a Notion block is really archiving
    // (recoverable from the trash within 30 days) — both are safety nets on our side, not decisions
    // for them, so neither is printed
    console.log(clog('gg.backupTo', { dir: join(config.guidesDir, BACKUPS_DIR) }));
  } else if (plan.target === 'notion') {
    console.log(
      plan.notion.existingPage
        ? clog('gg.intoExisting', { url: plan.notion.existingPage.url })
        : clog('gg.intoNew')
    );
  } else {
    console.log(clog('gg.toDisk', { path: plan.finalPath }));
  }

  if (probe.canSearch === false && !flags.has('--no-research')) {
    throw new Error(
      clog('gg.noResearch', { name: probe.name })
        + `    node tracker.js guide-gen ${appid} --no-research\n\n`
        + clog('gg.noResearchAlt')
    );
  }
  if (probe.canSearch === false) {
    console.log(clog('gg.noResearchOn'));
  }

  if (dryRun) {
    console.log(clog('gg.dryRun'));
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
        ? clog('gg.confirmOverwrite', { game: plan.game })
        : clog('gg.confirm')
    );
    io.close();
    if (!/^y(es)?$/i.test(answer)) return console.log(clog('gtn.cancelled'));
  }

  const provider = probe;
  const p = progressPrinter();
  const started = Date.now();

  const r = await generateGuide(db, {
    config, provider, steam, appid, rounds, fileName, notion, local, overwrite, plan,
    onProgress(ev) {
      if (ev.phase === 'plan' && ev.chunks > 1) {
        p.done(clog('gg.sharded', { achievements: ev.achievements, chunks: ev.chunks }));
      } else if (ev.phase === 'regroup') {
        p.update(clog('gg.regrouping'));
      } else if (ev.phase === 'regroup-done') {
        p.done(clog('gg.regrouped', { sections: ev.sections, assigned: ev.assigned, of: ev.of }));
      } else if (ev.phase === 'regroup-failed') {
        // **A degradation has to speak up.** Each shard opens its own headings, and without unifying
        // them same-kind achievements end up scattered across several sections — a visible regression
        // in the finished product. Unsaid, the user only concludes 「这次的分区怎么乱七八糟」
        p.done(clog('gg.regroupFailed', { reason: ev.reason }));
      } else if (ev.phase === 'regroup-merged') {
        // This is the program **overriding the classification the model gave**, and the finished
        // product does not show who changed it. Say plainly how many places were changed
        p.done(clog('gg.clustered', { clusters: ev.clusters, into: ev.into.join('、'), moved: ev.moved }));
      } else if (ev.phase === 'unwrapped-toggles') {
        p.done(clog('gg.unwrapped', { n: ev.titles.length, titles: ev.titles.join('、') }));
      } else if (ev.phase === 'unwrap-failed') {
        p.done(clog('gg.unwrapFailed', { reason: ev.reason }));
      } else if (ev.phase === 'rewrite') {
        p.done(clog('gg.partialRewrite', { round: ev.round, chunks: ev.chunks, of: ev.of }));
      } else if (ev.phase === 'ask') {
        // **Under concurrency, report "shards finished" rather than "writing shard N".** Several
        // shards are written at once and this event fires once per shard — reporting the current
        // shard number makes this line bounce between 1/4, 3/4 and 2/4, looking like progress going
        // backwards. The count of finished shards is monotonic, and holds equally running in series
        const prog = ev.chunks > 1 ? clog('gg.chunkProgress', { done: ev.done ?? 0, chunks: ev.chunks }) : '';
        p.update(clog('gg.round', { round: ev.round, rounds: ev.rounds, progress: prog }));
      } else if (ev.phase === 'tool') p.update(clog('gg.tool', { round: ev.round, label: ev.label ? ` ${ev.label}` : '', name: ev.name }));
      else if (ev.phase === 'check') p.update(clog('gg.check', { round: ev.round }));
      else if (ev.phase === 'lint') {
        p.done(clog('gg.checked', { round: ev.round, ticked: ev.ticked, blocking: ev.blocking }));
      } else if (ev.phase === 'notion-create' || ev.phase === 'notion-fill') {
        p.update(clog('gg.toNotion', { blocks: ev.blocks }));
      } else if (ev.phase === 'backup') p.update(clog('gg.backingUp'));
      else if (ev.phase === 'backup-done') p.done(clog('gg.backedUp', { path: ev.path, bytes: ev.bytes }));
      else if (ev.phase === 'notion-clear') p.update(clog('gg.notionClear', { blocks: ev.blocks }));
      else if (ev.phase === 'resplit') {
        p.done(clog('gg.chunkSplit', { chunk: ev.chunk, from: ev.from, to: ev.to }));
      } else if (ev.phase === 'retry') {
        p.done(clog('gg.chunkRetry', { chunk: ev.chunk, attempt: ev.attempt, of: ev.of }));
      } else if (ev.phase === 'chunk-failed') {
        // **This one must be done, never update.** It is the only record in the whole guide that a
        // shard was skipped, and a line written with update is overwritten on the spot by the next
        // shard's progress — leaving nobody knowing what was missed once the run ends
        p.done(clog('gg.chunkGaveUp', { chunk: ev.chunk, count: ev.count }));
      }
    },
  });
  p.done();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('\n' + '─'.repeat(70));
  if (r.ok) {
    console.log(clog('gg.done', { rounds: r.rounds, secs, url: r.url }));
    if (r.overwrote) {
      // A genuine old-vs-new comparison can only be computed after the overwrite — the preflight
      // before spending can only cover the old half. This section gives "what exactly did I replace"
      // an answer that can be checked on the spot, with the backup path right below
      console.log(clog('gg.diffHeader'));
      console.log(formatDiff(diffGuides({
        oldTodos: plan.oldTodos,
        newTodos: r.todos,
        defs: plan.defs,
        oldText: plan.oldText,
        newText: r.text,
      })));
      if (r.backup) console.log(clog('gg.backupPath', { path: r.backup.path }));
    }
    if (r.registered) console.log(clog('gg.registered', { action: r.registered.action ?? clog('gg.registeredNew') }));
    else console.log(clog('gg.notRegistered'));
    // Lines the converter did not recognise were not lost, but their formatting degraded to a plain
    // paragraph. The user has a right to know which lines
    if (r.unconverted.length) {
      console.log(clog('gg.unconverted', { n: r.unconverted.length }));
      for (const line of r.unconverted.slice(0, 5)) console.log(`       ${line}`);
    }
  } else {
    console.log(clog('gg.failed', { rounds: r.rounds, n: r.blocking.length, path: r.draftPath }));
    console.log(clog('gg.draftInvisible'));
    // **The cause goes before the symptom.** A missing shard presents as dozens of "missing
    // checkbox" findings, and reading down the list one concludes the model forgot to write them;
    // the truth is the whole shard never came back. The other order buries the real reason under
    // fifteen identical sentences
    for (const c of r.chunkFailures ?? []) {
      console.log(clog('gg.chunkMissing', { chunk: c.chunk, of: c.of, count: c.count, first: c.first, last: c.last }));
      console.log(`      ${c.reason.replace(/\n/g, '\n      ')}`);
      console.log(clog('gg.chunkMissingWhy'));
    }
    for (const f of r.blocking.slice(0, 15)) console.log(`     ✖ ${f.message}`);
    if (r.blocking.length > 15) console.log(clog('gg.andMore', { n: r.blocking.length - 15 }));
  }
  // **`expected` now holds two kinds of "out of reach" with different causes, and they cannot be
  // reported as one sentence.** This line used to hardcode 「已解锁但没勾」, which is true only of
  // checked-mismatch. The empty-description kind is "this box can never be ticked" and has nothing
  // to do with unlock state; merging them into one sentence states it wrongly
  const emptyDesc = r.expected.filter((f) => f.code === 'ambiguous-empty-description');
  const mismatch = r.expected.filter((f) => f.code === 'checked-mismatch');
  if (mismatch.length) {
    console.log(clog('gg.expectedMismatch', { n: mismatch.length }));
  }
  if (emptyDesc.length) {
    // Not blocking, but it has to be said: these will **never** be ticked automatically, and the user
    // has a right to learn that on the same screen that says 「写完了」 rather than discovering months
    // later that a few boxes have never moved
    console.log(clog('gg.emptyDesc', { n: emptyDesc.length }));
    for (const f of emptyDesc.slice(0, 8)) console.log(`       ${f.name}`);
    if (emptyDesc.length > 8) console.log(clog('gg.andMoreItems', { n: emptyDesc.length - 8 }));
    console.log(clog('gg.emptyDescFine'));
  }
  if (r.lint?.stats) {
    console.log(clog('gg.coverage', {
      covered: r.lint.stats.covered, achievements: r.lint.stats.achievements, warnings: r.lint.stats.warnings,
    }));
  }
  console.log('  ' + formatUsage(r.usage));
  // The machine verifies format and data (one line per achievement, names that match, verbatim
  // descriptions, ticks equal to the real unlock state) and can verify nothing about whether the
  // content is right. **This reminder has to stay**, but it is one sentence, not a paragraph
  console.log(clog('gg.readItYourself'));
  // **Can search ≠ did search.** canSearch only says the provider has the capability; searchQueries
  // is what it actually issued. Not reporting it turns "declared the tools and never searched" into
  // an invisible quality difference — exactly what the canSearch design exists to prevent
  if (!r.researched) {
    console.log(clog('gg.notResearched'));
  } else if (!r.searchQueries?.length) {
    console.log(clog('gg.noSearchIssued'));
  } else {
    console.log(clog('gg.searched', { n: r.searchQueries.length, queries: r.searchQueries.slice(0, 4).join(' / ') }));
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

  console.log(clog('gp.header', { game: plan.game, appid, where: clog(kind === 'notion' ? 'gg.notionPage' : 'gg.localFile'), url: plan.existing.url }));
  console.log(clog('gp.selected', { selector, n: entries.length }));
  for (const e of entries.slice(0, 12)) {
    const pct = plan.rarity?.get(e.apiName);
    const rare = pct === undefined || pct === null ? '' : clog('gp.rarity', { pct: pct.toFixed(1) });
    console.log(`       ${achName(e.def)}${rare}`);
  }
  if (entries.length > 12) console.log(clog('gp.andMore', { n: entries.length - 12 }));

  console.log('');
  console.log(formatPatchPreflight(pp.preflight, { defsCount: plan.defs.length }));

  // Named but not locatable in the guide: **report them, do not pretend they do not exist**. Their
  // symptom is missing-checkbox, and fixing that takes a full rewrite (or writing a line by hand),
  // which is not something this command can do
  if (unlocatable.length) {
    console.log(clog('gp.unlocatable', { n: unlocatable.length }));
    for (const a of unlocatable.slice(0, 8)) {
      const d = plan.defs.find((x) => x.api_name === a);
      console.log(`       ${achName(d) || a}`);
    }
    if (unlocatable.length > 8) console.log(clog('gp.andMore', { n: unlocatable.length - 8 }));
    console.log(clog('gp.unlocatableWhy'));
  }

  // The findings the old guide already failed on. **Say plainly that this run will not fix them** —
  // otherwise seeing them still in the report afterwards reads as damage done by this change
  const oldBlocking = baseline.findings.filter((f) => f.level === 'error');
  const outside = oldBlocking.filter((f) => !f.apiName || !pp.scope.apiNames.includes(f.apiName));
  if (outside.length) {
    console.log(clog('gp.outside', { n: outside.length }));
    for (const f of outside.slice(0, 5)) console.log(`       ${f.message}`);
    if (outside.length > 5) console.log(clog('gp.andMoreFew', { n: outside.length - 5 }));
  }

  const probe = await providerFor(config, { needKey: !dryRun });
  console.log(clog('gp.provider', { name: probe.name, model: probe.model, rounds }));
  warnEnvOverrides();
  console.log(clog('gg.backupTo', { dir: join(config.guidesDir, BACKUPS_DIR) }));

  if (probe.canSearch === false && !flags.has('--no-research')) {
    throw new Error(
      clog('gp.noResearch', { name: probe.name })
    );
  }
  if (probe.canSearch === false) {
    console.log(clog('gp.noResearchOn'));
  }

  if (dryRun) {
    console.log(clog('gp.dryRun'));
    console.log('─'.repeat(70));
    console.log(buildPatchMessage(entries, { instruction }));
    console.log('─'.repeat(70));
    console.log(clog('gp.samePrompt'));
    return;
  }

  if (!flags.has('--yes')) {
    const io = makeSecretReader();
    const answer = await io.ask(
      clog('gp.confirm', { n: entries.length, keeping: pp.preflight.keeping })
    );
    io.close();
    if (!/^y(es)?$/i.test(answer)) return console.log(clog('gtn.cancelled'));
  }

  const p = progressPrinter();
  const started = Date.now();

  const r = await patchGuide(db, {
    config, provider: probe, steam, appid, notion,
    selector, instruction, rounds, patchPlan: pp,
    onProgress(ev) {
      if (ev.phase === 'write') p.update(clog('gp.write', { round: ev.round, of: ev.of, scope: ev.scope }));
      else if (ev.phase === 'rewrite') p.update(clog('gp.rewrite', { round: ev.round, of: ev.of }));
      else if (ev.phase === 'tool') p.update(clog('gp.tool', { round: ev.round, name: ev.name }));
      else if (ev.phase === 'retry') p.done(clog('gp.retry', { round: ev.round, reason: ev.reason }));
      else if (ev.phase === 'check') {
        // **How many came back must be done, not update.** 「少写了两条」 is the only case on this
        // path where every gate is green and the request still was not met, and being overwritten by
        // the next line leaves nobody knowing
        const miss = ev.missing ? clog('gp.missingSome', { n: ev.missing }) : '';
        const extra = ev.extra ? clog('gp.extraSome', { n: ev.extra }) : '';
        p.done(clog('gp.returned', { round: ev.round, wrote: ev.wrote, of: ev.of, missing: miss, extra }));
      } else if (ev.phase === 'lint') {
        p.done(clog('gp.findings', { round: ev.round, caused: ev.caused, preExisting: ev.preExisting }));
      } else if (ev.phase === 'warn') p.done(`  ⚠️  ${ev.note}`);
      else if (ev.phase === 'backup') p.update(clog('gg.backingUp'));
      else if (ev.phase === 'backup-done') p.done(clog('gg.backedUp', { path: ev.path, bytes: ev.bytes }));
      else if (ev.phase === 'notion-patch') p.update(clog('gp.notionPatch', { name: ev.name }));
      else if (ev.phase === 'notion-verify') p.update(clog('gp.notionVerify'));
    },
  });
  p.done();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('\n' + '─'.repeat(70));
  if (r.ok) {
    console.log(clog('gp.done', { n: r.rewrote.length, rounds: r.rounds, secs, url: r.url }));
    console.log(clog('gp.keeping', { n: pp.preflight.keeping }));
    if (r.backup) console.log(clog('gg.backupPath', { path: r.backup.path }));
  } else {
    // Not passing means not one byte was written — this has to be said, or the user goes looking
    // through the guide for what got damaged
    console.log(clog('gp.failed', { rounds: r.rounds }));
    if (r.missing.length) {
      console.log(clog('gp.missingList', { n: r.missing.length }));
      for (const a of r.missing.slice(0, 8)) {
        const d = plan.defs.find((x) => x.api_name === a);
        console.log(`     ✖ ${achName(d) || a}`);
      }
    }
    for (const f of r.blocking.slice(0, 15)) console.log(`     ✖ ${f.message}`);
    if (r.blocking.length > 15) console.log(clog('gg.andMore', { n: r.blocking.length - 15 }));
  }

  // **Not blocking does not mean not mentioning.** The old guide's pre-existing problems were not
  // touched this run, but they are still there
  if (r.preExisting.length) {
    console.log(clog('gp.preExisting', { n: r.preExisting.length }));
    for (const f of r.preExisting.slice(0, 5)) console.log(`       ${f.message}`);
    if (r.preExisting.length > 5) console.log(clog('gp.andMoreFew', { n: r.preExisting.length - 5 }));
  }
  if (r.unapplied.extra.length) {
    console.log(clog('gp.extraIgnored', { n: r.unapplied.extra.length }));
  }
  if (r.unapplied.unresolved.length) {
    console.log(clog('gp.unresolved', { n: r.unapplied.unresolved.length }));
  }

  console.log('  ' + formatUsage(r.usage));
  console.log(clog('gg.readItYourself'));
  if (!r.researched) console.log(clog('gp.notResearched'));
  else if (!r.searchQueries?.length) console.log(clog('gg.noSearchIssued'));
  else console.log(clog('gg.searched', { n: r.searchQueries.length, queries: r.searchQueries.slice(0, 4).join(' / ') }));
}

/**
 * Moves a local markdown guide into Notion.
 *
 * `--dry-run` is the recommended first step: whether the conversion loses any formatting and whether
 * Notion can hold it are both visible in the preview, and it writes not one byte.
 */
async function cmdGuideToNotion() {
  const appid = positionalArgs()[0];
  if (!appid) throw new Error(clog('gtn.usage'));
  // steam is for the page icon (a Steam game icon is added at creation time, matching the pages
  // guide-gen creates)
  const { config, db, steam } = withSteam();
  const notion = new NotionClient(config);

  const plan = await planMigration(db, { notion, config, appid });
  const checked = plan.todos.filter((t) => t.checked).length;

  console.log(`\n《${plan.game}》(appid ${appid})`);
  console.log(clog('gtn.source', { path: plan.path }));
  console.log(clog('gtn.boxes', { n: plan.todos.length, checked }));
  console.log(clog('gtn.converts', { breakdown: Object.entries(plan.byType).map(([k, n]) => clog('gtn.typeCount', { n, type: k })).join('、') }));
  console.log(
    plan.target.existingPage
      ? clog('gtn.intoExisting', { url: plan.target.existingPage.url })
      : clog('gtn.intoNew')
  );
  if (plan.unconverted.length) {
    console.log(clog('gtn.unconverted', { n: plan.unconverted.length }));
    for (const line of plan.unconverted.slice(0, 8)) console.log(`       ${line}`);
  }

  if (flags.has('--dry-run')) return console.log(clog('gtn.dryRun'));

  if (!flags.has('--yes')) {
    const io = makeSecretReader();
    const answer = await io.ask(clog('gtn.confirm'));
    io.close();
    if (!/^y(es)?$/i.test(answer)) return console.log(clog('gtn.cancelled'));
  }

  const r = await migrateGuideToNotion(db, {
    notion, steam, config, appid, plan,
    onProgress(ev) {
      if (ev.phase === 'create') console.log(clog('gtn.creating', { blocks: ev.blocks }));
      else if (ev.phase === 'fill') console.log(clog('gtn.filling', { blocks: ev.blocks }));
      else if (ev.phase === 'verify') console.log(clog('gtn.verifying'));
    },
  });

  console.log(clog('gtn.done', { n: r.count, url: r.url }));
  console.log(
    r.archivedTo
      ? clog('gtn.archived', { path: r.archivedTo })
      : clog('gtn.notArchived')
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
  if (!existsSync(dir)) return console.log(clog('drafts.noDir'));

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

  if (!files.length) return console.log(clog('drafts.empty'));

  const doomed = files.filter((x) => x.mtime.getTime() < cutoff);
  console.log(clog('drafts.header', { dir: join(config.guidesDir, DRAFTS_DIR), n: files.length }));
  for (const x of files) {
    const mark = flags.has('--clean') && doomed.includes(x) ? clog('drafts.markDelete') : '  ';
    console.log(clog('drafts.row', { mark, age: String(x.ageDays).padStart(4), size: String(x.size).padStart(7), file: x.f }));
  }

  if (!flags.has('--clean')) {
    console.log(clog('drafts.harmless'));
    console.log(clog('drafts.howToClean'));
    return;
  }
  if (!doomed.length) return console.log(clog('drafts.nothingOld', { days }));

  for (const x of doomed) rmSync(x.path, { force: true });
  console.log(clog('drafts.deleted', { n: doomed.length, left: files.length - doomed.length }));
}

function cmdExport() {
  const dir = positional[0] ?? join(ROOT, 'exports');
  mkdirSync(dir, { recursive: true });
  const { db } = withSteam({ requireSteam: false });
  console.log(clog('export.to', { dir }));
  for (const f of exportAll(db, dir)) console.log(clog('export.file', { file: f.file, rows: f.rows }));
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

  console.log(clog('backup.done', { path: out }));
  console.log(clog('backup.counts', { games: manifest.counts.games, achievements: manifest.counts.achievements, guides: manifest.counts.guides, files: manifest.guideFiles }));
  console.log(`   ${(zip.length / 1048576).toFixed(1)} MB`);
  if (manifest.hasConfig) {
    console.log(clog('backup.hasSecrets'));
    console.log(clog('backup.secretsCost'));
  }
  console.log(clog('backup.moveMachine'));
}

/**
 * Restores from a backup. **Look before acting**: restoring clears the existing tables, so it asks
 * for confirmation by default, and before asking it prints both what is in the backup and what this
 * machine currently holds — a bare 「确定吗?」 conveys no information at all.
 */
async function cmdRestore() {
  const file = positional[0];
  if (!file) throw new Error(clog('restore.usage'));
  if (!existsSync(file)) throw new Error(clog('restore.notFound', { file }));

  const buf = readFileSync(file);
  const { manifest, hasConfig, guideFiles } = inspectBackup(buf);

  const { config, db } = withSteam({ requireSteam: false });
  const existing = countGames(db);

  console.log(clog('restore.contents'));
  if (manifest) {
    console.log(clog('restore.madeAt', {
      when: new Date(manifest.createdAt).toLocaleString(messageLanguage() === 'en' ? 'en-GB' : 'zh-CN'),
      version: manifest.appVersion ? clog('restore.version', { version: manifest.appVersion }) : '',
    }));
    console.log(clog('restore.counts', {
      games: manifest.counts.games, achievements: manifest.counts.achievements, guides: manifest.counts.guides,
    }));
  } else {
    console.log(clog('restore.noManifest'));
  }
  console.log(clog('restore.guideFiles', { n: guideFiles.length }));
  console.log('  ' + clog(hasConfig ? 'restore.hasConfig' : 'restore.noConfig'));

  const keepConfig = flags.has('--keep-config');
  console.log(clog('restore.thisMachine'));
  console.log(clog('restore.willReplace', { n: existing }));
  if (hasConfig && keepConfig) console.log(clog('restore.keepConfig'));

  if (!flags.has('--yes')) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const ans = (await rl.question(clog('restore.confirm'))).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') return console.log(clog('restore.aborted'));
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

  console.log(clog('restore.done'));
  for (const [t, n] of Object.entries(r.tables)) console.log(clog('restore.table', { table: t, n }));
  console.log(clog('restore.guideFilesOut', { n: r.guideFiles }));
  if (r.config) console.log(clog('restore.configOut'));
  console.log(clog('restore.thenSync'));
}

function cmdLog() {
  const { db } = withSteam({ requireSteam: false });
  const rows = recentSyncLog(db, Number(positional[0] ?? 30));
  if (!rows.length) return console.log(clog('log.empty'));
  for (const r of rows.reverse()) {
    const ts = new Date(r.ts).toLocaleString('zh-CN');
    console.log(`${ts}  ${r.game_name || '—'}  ${r.achievement || ''}  ${r.result}`);
  }
}

function cmdHelp() {
  console.log(clog('help.screen', { configPath: CONFIG_PATH }));
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

/**
 * **The interface language is set once, here, before any command runs.**
 *
 * It used to be set inside `withSteam`, which most commands go through — but not all: `drafts`,
 * `ai-check`, `guide-gen`, `guide-gen --only` and `init` call `loadConfig` directly, and every one
 * of them printed Chinese under an English interface. Nothing errored, because the tables default to
 * Chinese and a missing `setMessageLanguage` simply leaves them there. One call at the single point
 * every command passes through cannot be forgotten by the next command added.
 *
 * `required: []` so this cannot throw: a missing credential is the command's own error to raise,
 * with its own wording, and failing here would replace it with a worse one.
 */
try {
  setMessageLanguage(loadConfig({ required: [] }).uiLanguage);
} catch {
  // An unreadable or absent config.json is `init`'s whole reason for existing, and it is also the
  // state a first-time user is in. Falling through on the default language is correct here
}

const fn = COMMANDS[command];
if (!fn) {
  console.error(clog('cli.unknown', { command }));
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
const CLI_HINTS = {
  'provider-model-mismatch': 'hint.providerModelMismatch',
  'too-many-achievements': 'hint.tooManyAchievements',
  // Every Gemini model-name problem funnels to the same advice: ask the API for the list, then
  // change the model. Three codes, one entry — three copies of one sentence drift
  'gemini-model-retired': 'hint.geminiModel',
  'gemini-model-unknown': 'hint.geminiModel',
  'gemini-no-allowance': 'hint.geminiModel',
  'gemini-429-no-detail': 'hint.gemini429NoDetail',
  'gemini-tool-rejected': 'hint.geminiToolRejected',
  'bad-api-key': 'hint.badApiKey',
  'deepseek-length': 'hint.deepseekLength',
  'guide-exists': 'hint.guideExists',
  'file-exists': 'hint.fileExists',
  // ---- Partial rewrite (--only) ----
  'no-guide-to-patch': 'hint.noGuideToPatch',
  'unknown-achievements': 'hint.unknownAchievements',
  'empty-scope-result': 'hint.emptyScopeResult',
  'nothing-locatable': 'hint.nothingLocatable',
  'no-rarity': 'hint.noRarity',
  'section-needs-local': 'hint.sectionNeedsLocal',
  'bad-scope': 'hint.badScope',
  // Nothing at all after `--only`. **Kept separate from bad-scope**: that one is a wrong spelling,
  // this one is nothing written — the former needs the spelling corrected, the latter needs to know
  // which spellings exist in the first place
  'empty-scope': 'hint.emptyScope',
  'chunk-too-small': 'hint.chunkTooSmall',
};

try {
  await fn();
} catch (err) {
  console.error('\n❌ ' + (err.message ?? err));
  const hint = CLI_HINTS[err.code];
  if (hint) console.error(clog(hint, err.detail ?? {}));
  if (process.env.DEBUG) console.error(err.stack);
  // **Do not use process.exit().** Forcing an exit interrupts libuv while sockets and timers are
  // still being torn down, which on Windows shows up as
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — and it happens after the error message
  // has printed, so it looks like two unrelated things.
  // Setting exitCode lets Node exit naturally, with the same exit code of 1
  process.exitCode = 1;
}
