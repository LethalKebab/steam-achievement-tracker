/**
 * The language boundary
 * ------------------------------------------------
 * This project deliberately keeps two languages, split by audience:
 *
 *  - **Anything a user reads at runtime is in the interface language**: the Dashboard and Setup
 *    copy, the messages thrown from `lib/`, the CLI's output, and the prompt sent to the model.
 *    Each of those is a pair, and Chinese is the half that answers when nothing says otherwise.
 *  - **Anything a developer reads is English**: comments, documentation, test names.
 *
 * Everything on the second list was translated in one pass. **The failure this file guards is the
 * same pass being run again and taking the first list with it** — and that failure is silent in
 * every one of its forms:
 *
 *  - A translated error message from `lib/` renders verbatim in the Dashboard's floating bar, so
 *    the packaged app shows a sentence in the wrong language and nothing reports it.
 *  - A prompt half-translated changes **what the model is asked for**, not merely how it reads —
 *    and half is the state it reaches on its own, because the rules and the round-by-round
 *    messages are written in different places and only the rules were forked at first.
 *  - Translated CLI advice fails the same way as the error messages, one surface over.
 *
 * **What this file is not.** It does not check that the comments really were translated — that is
 * a diff against a base revision, not a property of the tree, and it would go red the first time
 * someone legitimately edits a Chinese label.
 *
 * **Why some of these are densities rather than per-string rules.** Only the `lib/` errors form a
 * clean set where every member must be Chinese. The other surfaces legitimately mix in command
 * lines, model names and brand words, so a per-string rule there needs an exemption list long
 * enough to rot. The realistic failure is a wholesale pass, not one relabelled button, so those
 * are floors set at roughly half of what is there today: an ordinary copy edit never approaches
 * them, and a translation pass falls straight through.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSystemPrompt, buildChunkMessage, buildChunkFeedback, buildFeedback, buildPatchMessage,
  buildRegroupPrompt, regroupSystemFor, chunkDefs,
} from '../lib/guidegen.js';
import { buildPatchFeedback } from '../lib/guidepatch.js';
import { clusterConstraint, sameKindClusters } from '../lib/guidecluster.js';
import { MESSAGES, setMessageLanguage } from '../lib/messages.js';
import { CLI_MESSAGES, clog } from '../lib/cli-messages.js';
import { TRACKER_MESSAGES } from '../lib/tracker-messages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const CJK = /[一-鿿]/;
const cjkCount = (s) => (s.match(/[一-鿿]/g) ?? []).length;

/** Strip comments before counting — the comments are English now, and their quoted Chinese would inflate every count */
const stripComments = (s) =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');


/**
 * Everything `lib/` says to a user now comes out of `lib/messages.js`, and the rule below is what
 * keeps it that way.
 *
 * **The rule this replaces was "every string handed to `new Error` in lib/ is Chinese".** It was
 * the strict one, and it worked while every message was a literal. It cannot survive them moving
 * into a table: a message composed through `msg('key')` is invisible to it, so as files converted
 * that rule would have covered less and less while still reporting green — the exact failure mode
 * this whole file exists to catch, wearing the costume of the check meant to catch it.
 *
 * So the rule became "no user-facing literal survives in lib/ at all", and the language question
 * moved to the table, where both halves of every entry can be checked. `EXEMPT` is what keeps the
 * two from drifting apart: a file listed here still holds its own strings, with the reason written
 * out, the way `TERMINAL_ONLY` does in cli-hints.test.js. Anything not listed must be empty.
 */
describe('nothing lib/ says to a user is a loose literal any more', () => {
  /**
   * The one real exemption, and the reason it is real.
   *
   * `lib/rpc.js` is **served to the browser** as `/_rpc.js` — it runs inside the page, not in Node,
   * so it cannot import `lib/messages.js` at all. Its single message is the same sentence as
   * `Setup.html`'s `msg.failed`, and it converts when the Dashboard's own table is built.
   */
  const EXEMPT = { 'rpc.js': ['请求失败'] };

  const libFiles = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));

  /**
   * Every string literal **anywhere inside** a `new Error(...)`, plus the `{error: ...}` returns.
   *
   * Not "the literal immediately after the paren": `new Error(body?.error || '请求失败')` puts one
   * behind a fallback, and an extractor anchored to the opening paren walks straight past it. That
   * is not hypothetical — it is the one exemption in this file, and the narrower version reported
   * the whole rule green while also declaring the exemption stale, which is how it was noticed.
   * So the argument list is sliced by paren balancing and then scanned whole.
   */
  const errorExpressions = (src) => {
    const out = [];
    let i = 0;
    while ((i = src.indexOf('new Error(', i)) !== -1) {
      let depth = 0, j = i + 'new Error('.length - 1, inStr = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (inStr) {
          if (c === '\\') { j++; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      out.push(src.slice(i, j + 1));
      i = j + 1;
    }
    return out;
  };

  const literals = (src) => {
    const clean = stripComments(src);
    const found = [];
    for (const expr of errorExpressions(clean)) {
      for (const m of expr.matchAll(/(['"`])((?:[^\\]|\\.)*?)\1/g)) found.push(m[2]);
    }
    for (const m of clean.matchAll(/error:\s*(['`])((?:[^\\]|\\.)*?)\1/g)) found.push(m[2]);
    return found;
  };

  test('every user-facing string in lib/ is either in the table or a written-out exemption', () => {
    const loose = [];
    for (const f of libFiles) {
      const allowed = EXEMPT[f] ?? [];
      for (const s of literals(read(join('lib', f)))) {
        if (!CJK.test(s)) continue;
        if (allowed.includes(s)) continue;
        loose.push(`lib/${f}: ${JSON.stringify(s.slice(0, 60))}`);
      }
    }
    assert.deepEqual(loose, [],
      'these are user-facing strings still written into lib/ rather than composed from '
      + 'lib/messages.js, so they stay in one language while everything around them switches: '
      + loose.join(' | '));
  });

  test('an exemption that is no longer used has to be deleted, not left standing', () => {
    // A stale entry here is how an exemption list turns into a place things are quietly parked.
    const stale = [];
    for (const [f, strings] of Object.entries(EXEMPT)) {
      const present = literals(read(join('lib', f)));
      for (const s of strings) if (!present.includes(s)) stale.push(`lib/${f}: ${JSON.stringify(s)}`);
    }
    assert.deepEqual(stale, [], 'these exemptions no longer match anything in the file: ' + stale.join(' | '));
  });

  /**
   * **The rule above reaches `new Error` and `{error: …}` and nothing else.** `lib/api.js` also hands
   * the Dashboard user-facing text in ordinary data fields — the last-synced line, a game with no
   * name, the placeholder for a hidden achievement — and one of those was still Chinese in an
   * otherwise entirely English page until a browser showed it. Nothing in the suite could have.
   *
   * So this file is checked whole: every Chinese literal in it is either composed through `msg` or
   * named here with its reason.
   */
  test('lib/api.js hands out no Chinese it did not compose', () => {
    const KEEP = {
      // Sent **to the model**, not to the user: a one-character reply is the cheapest probe that
      // proves a key works, and asking in another language changes what is being tested
      '回复一个字:好': 'the AI verification prompt',
      // The default title of a database created **in the user's Notion**. It is content, not
      // interface, and the settings page sends its own title through anyway
      'Steam 攻略': 'the default Notion database title',
    };
    // **Line-based on purpose.** Two attempts to pull the string literals out of the source both
    // produced false positives — a scan that pairs quotes straddles a regex literal containing
    // Chinese, and one that pairs backticks straddles two unrelated template literals, reporting
    // everything in between. Asking "does this line carry Chinese, and does it compose it" needs no
    // parsing at all and cannot straddle anything.
    const loose = stripComments(read(join('lib', 'api.js')))
      .split('\n')
      .filter((l) => CJK.test(l))
      .filter((l) => !l.includes('msg('))
      .filter((l) => !Object.keys(KEEP).some((k) => l.includes(k)))
      .map((l) => l.trim().slice(0, 70));
    assert.deepEqual(loose, [],
      'these reach the Dashboard as text without going through lib/messages.js, so they stay Chinese '
      + 'while everything around them switches: ' + loose.join(' | '));
  });

  test('the exempt strings are still Chinese', () => {
    // They are outside the table, so the table's own check cannot reach them — but they are read by
    // the same person, and the original rule still applies to whatever has not moved yet
    for (const [f, strings] of Object.entries(EXEMPT)) {
      for (const s of strings) {
        assert.ok(CJK.test(s), `lib/${f} carries an exempt message that is no longer Chinese: ${JSON.stringify(s)}`);
      }
    }
  });
});

/**
 * The other half of the same rule: the table those messages moved into.
 *
 * The check above says nothing is left loose in `lib/`. On its own that is satisfied by an empty
 * table, so this one says the table is actually right — both languages present, the Chinese half
 * still Chinese, the slots agreeing, no key asked for that does not exist and none defined that
 * nothing shows. Together they add up to "every message a user can see is available in both
 * languages"; either alone can be satisfied by something broken.
 */
// Two tables, two composers: `msg` reads MESSAGES, `clog` reads CLI_MESSAGES. The checks are the
// same for both, so the call name is a parameter — scanning for the wrong one reports every key
// in the other table as an undefined translation
for (const [TABLE_NAME, TABLE, FN, OWN_FILES] of [
  ['lib/messages.js', MESSAGES, 'msg', ['messages.js']],
  // `clog` reads both terminal tables as one, so the checks below have to see one too — the
  // merged view is what the composer actually resolves against. Split apart, every key living
  // in the other half is reported as an undefined translation
  ['the terminal tables', { ...CLI_MESSAGES, ...TRACKER_MESSAGES }, 'clog',
    ['cli-messages.js', 'tracker-messages.js']],
])
describe('the messages in ' + TABLE_NAME, () => {
  /**
   * A handful of entries have **no Chinese to carry**: they are punctuation and slots, and the
   * difference between their halves is typography rather than words. Written out by name so that a
   * *new* entry losing its Chinese is still reported, which is what this check is for.
   *
   * The entry still has to differ between the two halves — otherwise this list becomes the place a
   * genuinely untranslated entry goes to hide.
   */
  const NO_PROSE = {
    'gp.header': 'a game line: 《》 and · against ( ) and ·, with everything else interpolated',
    'ai.leakedSample': 'a label and a sample, separated by the colon each language spaces differently',
    'ai.blockSep': 'the separator between block counts: 、 against a comma and a space',
    'ai.httpError': 'a vendor, a status and a body, joined by the colon each language spaces differently',
    'ai.keyShapeSep': 'the separator between the facts about a key: , against a comma and a space',
  };

  test('every entry has both languages, and the Chinese half really is Chinese', () => {
    const bad = Object.entries(TABLE).filter(([k, v]) => {
      if (!Array.isArray(v) || v.length !== 2) return true;
      const [zh, en] = v;
      if (!zh || !en) return true;
      // A translation pass that took the runtime surface with it shows up here and nowhere else:
      // both halves present, both readable, and the Chinese one no longer Chinese
      return !CJK.test(zh) && !(k in NO_PROSE);
    }).map(([k]) => k);
    assert.deepEqual(bad, [], 'these entries are not a [zh, en] pair with a Chinese first half');
  });

  /**
   * **The same assertion pointing the other way**, and it has to be its own test rather than a
   * second condition in the one above: "the Chinese half is Chinese" is satisfied by an entry whose
   * *English* half is also Chinese, which is exactly what a half-finished translation leaves behind.
   * One direction alone leaves the real hole open.
   *
   * What it caught on the way in: `notion.dbUnreadable` told an English-interface user to press
   * 「新建一个攻略数据库」, a button that reads `＋ Create a guide database` on their screen. Both
   * halves were present, they differed, the slots matched, and the advice named a control that was
   * not there.
   *
   * A Chinese **name** reaching an English message is not this — game and achievement names arrive
   * through slots, and a slot's value is never in this table.
   */
  test('and the English half carries no Chinese', () => {
    const bad = Object.entries(TABLE)
      .filter(([, v]) => Array.isArray(v) && v.length === 2 && CJK.test(v[1]))
      .map(([k]) => k);
    assert.deepEqual(bad, [], 'these entries have Chinese left in the English half');
  });

  test('the entries exempted from that are really wordless, and really do differ', () => {
    for (const [k, why] of Object.entries(NO_PROSE)) {
      if (!(k in TABLE)) continue;              // the exemption lists both tables' names
      const [zh, en] = TABLE[k];
      assert.ok(!CJK.test(zh), `${k} now carries Chinese, so it does not need the exemption: ${why}`);
      assert.notEqual(zh, en, `${k}'s two halves are identical — the exemption is hiding an untranslated entry`);
    }
  });


  test('no entry has two identical halves', () => {
    /**
     * The failure this catches is a **half-finished translation pass**: an entry copied into both
     * slots so the shape is right and the content is not. Every other check here passes on it —
     * both halves present, the Chinese one Chinese, the slots identical by construction — and at
     * runtime the interface simply keeps answering in the wrong language for that one line.
     *
     * No exemptions today, and a new one needs an argument: two languages agreeing on a whole
     * message, punctuation included, is rare enough to be worth writing down.
     */
    const same = Object.entries(TABLE).filter(([, [zh, en]]) => zh === en).map(([k]) => k);
    assert.deepEqual(same, [], 'these entries say exactly the same thing in both languages');
  });

  test('a message asked for with no values has no slots to fill', () => {
    /**
     * `clog('key')` with no second argument leaves every `{slot}` in the message **rendered
     * literally**, so a dotted placeholder reaches the terminal where a path or a count belongs.
     * Nothing throws, and it is invisible until somebody hits that branch.
     *
     * Only the no-argument form is checkable statically — with an object passed there is no way
     * from here to know which keys it holds — and that is the form the bug takes.
     */
    const bare = new Set();
    const scan = [...readdirSync(join(ROOT, 'lib')).filter((x) => x.endsWith('.js'))]
      .map((f) => join('lib', f)).concat(['tracker.js']);
    for (const f of scan) {
      for (const m of stripComments(read(f)).matchAll(new RegExp(FN + "\\('([^']+)'\\s*\\)", 'g'))) {
        bare.add(m[1]);
      }
    }
    const unfilled = [...bare]
      .filter((k) => TABLE[k] && /\{[a-zA-Z]+\}/.test(TABLE[k][0]))
      .map((k) => `${k} (${(TABLE[k][0].match(/\{[a-zA-Z]+\}/g) ?? []).join(', ')})`);
    assert.deepEqual(unfilled, [], 'these are asked for with no values, and their slots would print literally');
  });

  test('a slot in one language is a slot in the other', () => {
    const slots = (x) => (x.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
    const mismatched = Object.entries(TABLE)
      .filter(([, [zh, en]]) => slots(zh) !== slots(en))
      .map(([k]) => k);
    // A dropped slot does not throw — it renders the sentence without the value it existed to carry
    assert.deepEqual(mismatched, [], 'the two languages of these entries interpolate different things');
  });

  test('every key asked for exists, and every key defined is asked for', () => {
    const asked = new Set();
    for (const f of readdirSync(join(ROOT, 'lib')).filter((x) => x.endsWith('.js'))) {
      for (const m of stripComments(read(join('lib', f))).matchAll(new RegExp(FN + "\\('([^']+)'", 'g'))) asked.add(m[1]);
    }
    for (const m of stripComments(read('tracker.js')).matchAll(new RegExp(FN + "\\('([^']+)'", 'g'))) asked.add(m[1]);
    /**
     * **The two directions need different sets, and mixing them is what broke this once.**
     *
     * "Asked for but not defined" has to stay narrow — only a real `msg('key')` call — or every
     * quoted string in `lib/` becomes a supposed key and the check reports `'end_turn'` and
     * `'max_tokens'` as missing translations.
     *
     * "Defined but never used" has to be wide, because a key is often reached indirectly:
     * `msg(cond ? 'a' : 'b')` puts it nowhere near the call. The question there is only whether an
     * entry is dead weight, and one that appears nowhere in the source certainly is.
     */
    // **The table's own file is excluded, and without that this whole half is vacuous**: every key
    // appears as a quoted literal in the table that defines it, so `defined - mentioned` is empty
    // whatever else is true and a dead entry is never reported. tracker.js is scanned because
    // CLI_HINTS maps an error code to a message key there as a bare string rather than a `clog` call
    const mentioned = new Set(asked);
    const scan = [...readdirSync(join(ROOT, 'lib')).filter((x) => x.endsWith('.js') && !OWN_FILES.includes(x))]
      .map((f) => join('lib', f))
      .concat(['tracker.js', 'Dashboard.html', 'Setup.html']);
    for (const f of scan) {
      for (const m of stripComments(read(f)).matchAll(/'([a-z][\w.]*)'/g)) mentioned.add(m[1]);
    }
    const defined = new Set(Object.keys(TABLE));
    // msg() returns the key for a miss, so a typo reaches the user as a dotted identifier in the
    // floating bar rather than as an error anybody sees first
    assert.deepEqual([...asked].filter((k) => !defined.has(k)), [], 'these keys are used but not defined');
    assert.deepEqual([...defined].filter((k) => !mentioned.has(k)), [], 'these entries are translated but never used');
  });

  test('the two terminal tables never define the same key', () => {
    // A merged table hides a collision: one half silently wins and the other entry is unreachable,
    // which reads as "that message never got translated" a long way from the cause
    const both = Object.keys(CLI_MESSAGES).filter((k) => k in TRACKER_MESSAGES);
    assert.deepEqual(both, [], 'these keys are defined in both terminal tables');
  });

  test('the language is actually set at both entry points', () => {
    // The table defaults to Chinese, so forgetting this is silent: the interface switches to
    // English and every message from lib/ keeps answering in Chinese
    assert.match(stripComments(read(join('lib', 'server.js'))), /setMessageLanguage\(config\.uiLanguage\)/,
      'serve has to set it before anything can fail');
    // **The CLI sets it once, at dispatch, rather than inside each command.** It was inside
    // `withSteam`, which most commands go through and five do not — `drafts`, `ai-check`,
    // `guide-gen`, `guide-gen --only` and `init` load the config themselves — and every one of them
    // printed Chinese under an English interface, silently, because the tables default to Chinese
    const tracker = stripComments(read('tracker.js'));
    assert.match(tracker, /setMessageLanguage\(loadConfig\(\{ required: \[\] \}\)\.uiLanguage\)/,
      'the CLI shares these messages with the Dashboard and has to agree with it');
    assert.ok(tracker.indexOf('setMessageLanguage(') < tracker.indexOf('const fn = COMMANDS[command]'),
      'it has to be set before the command runs, or the first thing a command prints is in the wrong language');
    assert.equal((tracker.match(/setMessageLanguage\(/g) ?? []).length, 1,
      'one call, at the one point every command passes through — a second is a place that can disagree');
    assert.match(stripComments(read(join('lib', 'api.js'))), /setMessageLanguage\(lang\)/,
      'saveUiLanguage has to move the messages too, or the toggle changes the page and not the errors');
  });
});

describe('each language of the prompt is written in that language', () => {
  /**
   * The prompt forks by language, and this guards the fork the only way a ratio can: **each variant
   * has to be predominantly the language it claims.**
   *
   * Parameterised over both rather than checking the Chinese one and exempting the English one. An
   * exemption leaves the real hole open — a pass that translates *both* and reports itself fine —
   * because the Chinese prompt would then be English and nothing would be looking at it. Two
   * assertions pointing in opposite directions cannot both be satisfied by one sweeping translation.
   *
   * A ratio rather than a phrase: `guidegen.test.js` pins the individual rules that must be present
   * (`序号不是身份`, `写得出做法`, and their English counterparts), and this catches the wholesale
   * case those cannot.
   */
  const defs = [{
    api_name: 'A', name_cn: '第一步', name_en: 'First Step', description: '完成第一关。',
    description_en: 'Finish the first level.', game_name: '测试游戏', hidden: 0, icon: '',
  }];

  // The `target` branch is per backend and only one of the two is exercised by default, so both are
  // walked here; `null` is the fallback used when the backend has not been decided yet
  const VARIANTS = [undefined, 'notion', 'local'];

  test('the Chinese prompt is more than 40% Chinese', () => {
    for (const target of VARIANTS) {
      const p = buildSystemPrompt('测试游戏', '1', defs, { target });
      const ratio = cjkCount(p) / p.length;
      assert.ok(ratio > 0.4,
        `the ${target ?? 'default'} variant is only ${Math.round(ratio * 100)}% Chinese `
        + `(${cjkCount(p)} of ${p.length} characters)`);
    }
  });

  test('the English prompt is almost entirely free of Chinese', () => {
    // Not zero: the fixture's own achievement name and description are Chinese and are quoted into
    // the list verbatim, which is rule 3 and rule 4 doing exactly what they are supposed to do. What
    // the ceiling excludes is Chinese in the **rules**, which is where a half-finished fork shows up
    for (const target of VARIANTS) {
      const p = buildSystemPrompt('测试游戏', '1', defs, { target, lang: 'en' });
      const ratio = cjkCount(p) / p.length;
      assert.ok(ratio < 0.02,
        `the English ${target ?? 'default'} variant is ${Math.round(ratio * 100)}% Chinese `
        + `(${cjkCount(p)} of ${p.length} characters), so part of it was left untranslated`);
    }
  });

  test('the two are actually different prompts', () => {
    // Guards the cheapest way to satisfy both ratios at once: returning the Chinese prompt for both
    // languages would fail the second test, but returning the *English* one for both would pass
    // neither — while a stub returning an empty string for one would pass both vacuously
    const zh = buildSystemPrompt('测试游戏', '1', defs, { target: 'notion' });
    const en = buildSystemPrompt('测试游戏', '1', defs, { target: 'notion', lang: 'en' });
    assert.notEqual(zh, en);
    assert.ok(zh.length > 5000 && en.length > 5000, 'neither variant is a stub');
  });

  test("an unrecognised language falls back to Chinese rather than to nothing", () => {
    // `lang` reaches here from config, and config is a file a person edits
    for (const lang of ['fr', '', null, undefined, 'ZH']) {
      const p = buildSystemPrompt('测试游戏', '1', defs, { target: 'notion', lang });
      assert.ok(cjkCount(p) / p.length > 0.4, `lang=${JSON.stringify(lang)} produced a non-Chinese prompt`);
    }
  });
});

describe('every prompt that reaches the model forks, not only the rules', () => {
  /**
   * **The ratio test above covers `buildSystemPrompt` and nothing else.** That is the cached prefix;
   * everything below is a turn message, written elsewhere in the file, and for a long time none of
   * them forked at all — an English guide was asked for in English rules and instructed in Chinese
   * every round after. The pass that decides the guide's **final section headings**
   * (`buildRegroupPrompt`) was among them, which is what issue #121 reported: English prose under
   * Chinese headings, with `lintGuide` green, because the validator checks format and data and never
   * content.
   *
   * **The fixture is entirely English on purpose.** Names and official descriptions are quoted into
   * these prompts verbatim by rule, so a fixture with Chinese in it forces the English assertion
   * down to a ratio, and a ratio cannot tell "the prompt is Chinese" from "the game is". With
   * nothing Chinese to quote, any Chinese character in an English prompt is the prompt's own, and
   * the assertion can be **none at all**.
   */
  const ach = (n, name, desc) => ({
    api_name: n, name_cn: '', name_en: name, description: desc, description_en: desc,
    game_name: 'Test Game', hidden: 0, icon: '',
  });
  // The last three share a description template, which is what sameKindClusters looks for. **The
  // shared part has to come first**: it clusters on a common prefix, so "Deal 10,000 damage in
  // Operations" and "Deal 50,000 damage in Operations" share only "Deal " and do not cluster at all.
  // Without a cluster `clusterConstraint` returns '' in both languages and passes every check below
  // vacuously
  const DEFS = [
    ach('A', 'First Step', 'Finish the first level.'),
    ach('B', 'Collector', 'Collect 25 items.'),
    ach('C', 'Mascot Swap', 'Swap the mascot once.'),
    ach('D', 'Deal 10k', 'Deal cumulative damage in Operations: 10,000.'),
    ach('E', 'Deal 50k', 'Deal cumulative damage in Operations: 50,000.'),
    ach('F', 'Deal 100k', 'Deal cumulative damage in Operations: 100,000.'),
  ];
  const CHUNKS = chunkDefs(DEFS, 3);
  const CLUSTERS = sameKindClusters(DEFS);
  const FINDINGS = [
    { code: 'missing-checkbox', level: 'error', message: '"First Step" has no `- [ ]` line of its own', apiName: 'A' },
    { code: 'paraphrased-description', level: 'warn', message: '"Collector" has a reworded description', apiName: 'B' },
  ];
  const ENTRIES = [
    { apiName: 'B', def: DEFS[1], text: '- [ ] **Collector**<br>Collect 25 items.' },
    { apiName: 'C', def: DEFS[2], text: '- [ ] **Mascot Swap**<br>Swap the mascot once.' },
  ];
  const CURRENT = {
    assignment: new Map([['A', 'Opening'], ['B', 'Collectibles'], ['C', 'Shop'], ['D', 'Combat']]),
    sections: ['Opening', 'Collectibles', 'Shop', 'Combat'],
  };

  /** Every prompt the generator sends, as a function of the language alone */
  const PROMPTS = [
    ['the opening message of a single-shard guide', (lang) => buildChunkMessage([DEFS], 0, new Set(), lang)],
    ['one shard of several', (lang) => buildChunkMessage(CHUNKS, 0, new Set(), lang)],
    ['the last shard', (lang) => buildChunkMessage(CHUNKS, CHUNKS.length - 1, new Set(), lang)],
    ['the brief-entry note inside a shard', (lang) => buildChunkMessage(CHUNKS, 0, new Set(['A']), lang)],
    ["a shard's rejection list", (lang) => buildChunkFeedback(FINDINGS, CHUNKS, 0, new Set(), lang)],
    ["the whole guide's rejection list", (lang) => buildFeedback(FINDINGS, lang)],
    ['a partial rewrite', (lang) => buildPatchMessage(ENTRIES, { lang })],
    ['a partial rewrite with a requirement', (lang) => buildPatchMessage(ENTRIES, { instruction: 'say what is mutually exclusive', lang })],
    ["a partial rewrite's rejection list", (lang) => buildPatchFeedback(FINDINGS, ENTRIES, ['C'], lang)],
    ["the classification pass's system prompt", (lang) => regroupSystemFor(lang)],
    ['the classification pass', (lang) => buildRegroupPrompt('Test Game', DEFS, CURRENT, CLUSTERS, lang)],
    ['the same-kind cluster constraint', (lang) => clusterConstraint(DEFS, CLUSTERS, lang)],
  ];

  for (const [what, build] of PROMPTS) {
    test(`${what} says nothing in Chinese when the guide is English`, () => {
      const en = build('en');
      assert.ok(en.length > 0, 'the English variant is empty, which would pass every check vacuously');
      assert.equal(cjkCount(en), 0,
        `${what} still has ${cjkCount(en)} Chinese characters in its English form: ${en.slice(0, 160)}`);
    });

    /**
     * Pointed the opposite way, and for the reason given on the ratio pair above: one sweeping
     * translation satisfies "the English one has no Chinese" everywhere by translating both, and
     * only an assertion that the Chinese one is still Chinese notices.
     */
    test(`${what} is still Chinese when the guide is Chinese`, () => {
      const zh = build('zh');
      assert.ok(cjkCount(zh) >= 10,
        `${what} has only ${cjkCount(zh)} Chinese characters left in its Chinese form: ${zh.slice(0, 160)}`);
    });

    test(`${what} is two different texts, not one returned twice`, () => {
      assert.notEqual(build('zh'), build('en'));
    });
  }

  /**
   * **The one that catches the next one.** Every check above names its builder, so a builder added
   * later is simply absent from the list and nothing goes red — which is exactly how this family
   * grew: the fork was added for the rules, and each turn message written afterwards inherited
   * nothing. This reads the source instead: a function that holds a Chinese string literal is
   * writing Chinese for somebody, and it has to be able to answer for the other language too.
   */
  /**
   * The one exemption, and the reason it is real.
   *
   * `'回复一个字:好'` is the **prompt** the connectivity check sends to the model, not a sentence
   * anybody reads — nothing renders the reply, only whether one came back. Putting it in a table
   * whose stated subject is what a person reads would make that table say something untrue about
   * itself. Written out here instead, the way `rpc.js` is above.
   *
   * Keys are the path with forward slashes; `posix` normalises whatever `join` produced.
   */
  const EXEMPT_PROMPTS = { 'lib/api.js': ['回复一个字'] };
  const posix = (p) => p.split('\\').join('/');

  test('no prompt builder holds Chinese without taking a language', () => {
    /**
     * **The whole of `lib/`, not only the prompt builders.** It began at three files, which is how
     * far the fork itself had got; the sweep that followed found the same defect in nine more —
     * progress labels, provider hints, lint findings quoted straight into the rejection prompt.
     * Naming the files is what let those sit there, so the list is now "everything except the
     * tables and what is written out below".
     *
     * **Declared functions only.** Every builder is written as `function name(...)`, and that is the
     * shape a new one will take. The two prompt sources that are consts (`rulesFor`,
     * `REGROUP_SYSTEM`) are named individually in the checks above, so nothing is outside both nets.
     *
     * Comments have already been stripped, so what is examined is string literals: Chinese in a
     * comment documents the code, Chinese in a string is a sentence somebody reads.
     */
    const TABLES = ['messages.js', 'cli-messages.js', 'tracker-messages.js'];
    const FILES = readdirSync(join(ROOT, 'lib'))
      .filter((f) => f.endsWith('.js') && !TABLES.includes(f))
      .map((f) => join('lib', f));

    /** From the `(` at `i`, the parameter list — signatures wrap, and `new Set()` closes a paren early */
    const paramsAt = (src, i) => {
      let depth = 0;
      for (let k = i; k < src.length; k++) {
        if (src[k] === '(') depth++;
        else if (src[k] === ')' && --depth === 0) return src.slice(i + 1, k);
      }
      return '';
    };

    const offenders = [];
    for (const file of FILES) {
      const src = stripComments(read(file));
      for (const m of src.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)) {
        const open = m.index + m[0].length - 1;
        if (/\blang\b/.test(paramsAt(src, open))) continue;
        const end = src.indexOf('\n}\n', open);
        const body = src.slice(open, end === -1 ? src.length : end);
        const strings = body.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [];
        const allowed = EXEMPT_PROMPTS[posix(file)] ?? [];
        const bad = strings.filter((s) => CJK.test(s) && !allowed.some((a) => s.includes(a)));
        if (bad.length) offenders.push(`${file}: ${m[1]} — ${bad[0].slice(0, 60)}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these hold Chinese text but cannot be asked for it in English:\n  ' + offenders.join('\n  '));
  });

  /**
   * **Found by breaking the check above.** Widening a fragment to `''` makes it a substring of every
   * string, so the guard passed while exempting the whole of `lib/` — the exemption list becoming
   * the place a real offender hides is the same failure `NO_PROSE` is held to further up, and it
   * needs the same two questions asked of it: is it specific, and is it still needed.
   */
  test('the prompt exemption is specific, and is still doing something', () => {
    for (const [file, fragments] of Object.entries(EXEMPT_PROMPTS)) {
      assert.ok(fragments.length, `${file} is listed with nothing exempted`);
      const src = stripComments(read(file));
      for (const fragment of fragments) {
        assert.ok(fragment.length >= 4 && CJK.test(fragment),
          `${file}: "${fragment}" is too broad to be an exemption — it has to name the string it excuses`);
        assert.ok(src.includes(fragment),
          `${file}: "${fragment}" is no longer in that file, so the exemption has to be deleted rather than left standing`);
      }
    }
  });
});

describe('what the CLI prints is available in both languages', () => {
  /**
   * The CLI's copy moved into `lib/tracker-messages.js`, so these are table checks rather than
   * source assertions. The generic table checks — both halves present, the Chinese half Chinese,
   * matching slots, no key used-but-undefined or defined-but-unused — already run over the merged
   * terminal table above. What is left here is what those cannot see: **that particular groups of
   * entries did not lose their substance to the translation.**
   *
   * A density floor rather than a per-string rule for the advice, because those entries legitimately
   * contain command lines (`Remove-Item Env:…`) which are not Chinese and must not be. The phase and
   * lint labels are short and every value is a label, so those are checked per string in both halves.
   */
  const entries = (prefix) => Object.entries(TRACKER_MESSAGES).filter(([k]) => k.startsWith(prefix));

  test('the terminal-only advice carries real prose in both languages', () => {
    const rows = entries('hint.');
    assert.ok(rows.length >= 15, `only ${rows.length} advice entries were found — the extraction is broken, not the rule satisfied`);
    const cjk = cjkCount(rows.map(([, v]) => v[0]).join(''));
    assert.ok(cjk > 250,
      `the Chinese half of the advice holds only ${cjk} Chinese characters. This is what is printed `
      + 'beside a failure, and it is read by the same person reading the rest of the terminal output');
    // The English half cannot be measured the same way, so it is measured by its own absence of
    // Chinese plus a length floor — an entry left as the Chinese string in both slots fails the first,
    // and an entry cut down to a stub fails the second
    for (const [k, [zh, en]] of rows) {
      assert.ok(!CJK.test(en.replace(/[""「」]/g, '')), `${k}: the English half still contains Chinese`);
      assert.ok(en.length > zh.length * 0.6, `${k}: the English half is far shorter than the Chinese one and has probably lost something`);
    }
  });

  test('every lint-code label is a real sentence in both languages', () => {
    const rows = entries('code.');
    assert.ok(rows.length >= 8, `only ${rows.length} lint labels were found — the extraction is broken`);
    for (const [k, [zh, en]] of rows) {
      assert.ok(CJK.test(zh), `${k}: the Chinese half is not Chinese`);
      assert.ok(en.length > 10 && !CJK.test(en), `${k}: the English half is missing or still Chinese`);
    }
  });

  test('every sync phase label is a real label in both languages', () => {
    const rows = entries('phase.');
    assert.ok(rows.length >= 3, `only ${rows.length} phase labels were found — the extraction is broken`);
    for (const [k, [zh, en]] of rows) {
      assert.ok(CJK.test(zh), `the phase label ${JSON.stringify(zh)} is not Chinese`);
      assert.ok(en && !CJK.test(en), `${k}: the English phase label is missing or still Chinese`);
    }
  });
});

describe('the copy on the two pages stays Chinese', () => {
  /**
   * Counted over the whole file with comments stripped, not over the static markup: the Dashboard's
   * table is assembled in JS, so almost all of its user-visible text lives in string literals
   * inside `<script>` rather than between tags. Measuring the markup alone finds 89 characters and
   * would pass with the entire interface translated.
   */
  for (const [page, floor] of [['Dashboard.html', 1000], ['Setup.html', 400]]) {
    test(`${page} still carries its Chinese interface copy`, () => {
      const cjk = cjkCount(stripComments(read(page)));
      assert.ok(cjk > floor,
        `${page} holds only ${cjk} Chinese characters, below the floor of ${floor}. `
        + 'The interface copy is deliberately Chinese; a drop of this size means it was translated wholesale');
    });
  }
});

describe('clog resolves against both terminal tables at runtime', () => {
  /**
   * The static checks above compare key sets. **None of them notices the composer looking at only
   * one table** — every key still exists, every entry still has both languages, and `clog` simply
   * returns the key itself for anything in the half it stopped reading. That reaches a terminal as
   * a dotted identifier where a sentence belongs, which nothing else here would report.
   */
  const SAMPLES = [
    ['srv.listening', 'from lib/cli-messages.js'],
    ['phase.library', 'from lib/tracker-messages.js'],
  ];

  for (const lang of ['zh', 'en']) {
    test(`a key from each table resolves in ${lang}`, () => {
      setMessageLanguage(lang);
      for (const [key, where] of SAMPLES) {
        const out = clog(key);
        assert.notEqual(out, key, `clog returned the key itself for ${key} (${where})`);
        assert.ok(out.length > 2, `${key} resolved to something too short to be the message`);
      }
    });
  }

  test('the two languages really differ', () => {
    // Guards the cheapest way to pass the two tests above: a composer that ignores the language
    setMessageLanguage('zh');
    const zh = SAMPLES.map(([k]) => clog(k));
    setMessageLanguage('en');
    const en = SAMPLES.map(([k]) => clog(k));
    for (const [i, [key]] of SAMPLES.entries()) {
      assert.notEqual(zh[i], en[i], `${key} renders identically in both languages`);
    }
    setMessageLanguage('zh');
  });
});

/**
 * UI labels quoted in the walkthrough docs
 * ------------------------------------------------
 * `notion-setup.md` tells someone which button to press, and it is reached **from inside the
 * program** — `Setup.html`'s 「配置图解 ↗」 link — so a label that no longer exists sends a reader
 * looking for a control that is not on their screen.
 *
 * **This went wrong once already and nothing reported it.** The interface became bilingual, every
 * label grew an English half, and the docs kept quoting only the Chinese one for a full release.
 * `guides.md` was worse: it named 「搬去 Notion」, a control that exists in neither language — the
 * button's own text is `Notion` and only its tooltip mentions 搬到.
 *
 * The rule: **every 「…」 in a walkthrough doc has to appear in one of the message tables.** That is
 * the same property `i18n-boundary` already enforces on the tables themselves, extended one surface
 * out to the prose that quotes them.
 *
 * **Why only these three files.** 「…」 means "a control you click" here and nowhere else.
 * `frontend.md` and `ai-guide-writing.md` are design records whose quotes are prompt fragments,
 * achievement names and labels that were deliberately reverted — none of them are current controls.
 * README mixes labels with rhetorical quotes (「反悔」, and 「Windows 已保护你的电脑」 is Windows'
 * dialog, not ours); four of its seven would need exempting, which is the exemption list long
 * enough to rot that the header of this file warns about.
 *
 * **What makes it red**: rename a control in the table without touching the doc, or quote a label
 * in one of these three files that no table defines.
 */
describe('UI labels quoted in the walkthrough docs', () => {
  const WALKTHROUGHS = ['docs/notion-setup.md', 'docs/guides.md', 'docs/configuration.md'];

  /**
   * Comments are stripped first. The house style is to name the control in the comment beside it
   * (`/* … the full-width 「保存并验证」 *\/`), so leaving them in would let a doc keep quoting a
   * label that only survives in a comment about it.
   */
  const tables = () =>
    [stripComments(read('Setup.html')), stripComments(read('Dashboard.html')),
      JSON.stringify(MESSAGES), JSON.stringify(CLI_MESSAGES), JSON.stringify(TRACKER_MESSAGES)].join('\n');

  const labelsIn = (f) => [...read(f).matchAll(/「([^」]+)」/g)].map((m) => m[1]);

  test('every label a walkthrough quotes is one the program actually shows', () => {
    const haystack = tables();
    const all = WALKTHROUGHS.flatMap((f) => labelsIn(f).map((l) => [f, l]));
    // Without this the assertion is satisfied by an extraction that returns nothing, and an empty
    // assertion is worse than none. 15 is roughly half of what the three files carry today, so an
    // ordinary edit never approaches it
    assert.ok(all.length >= 15,
      `only ${all.length} quoted labels were found — the extraction is broken, not the rule satisfied`);
    const missing = all.filter(([, l]) => !haystack.includes(l)).map(([f, l]) => `${f}: 「${l}」`);
    assert.deepEqual(missing, [], 'these docs quote a label no message table defines');
  });

  /**
   * The contiguous run of `>` lines that line `i` belongs to, or null when it is not in one.
   */
  const quoteBlock = (lines, i) => {
    if (!/^\s*>/.test(lines[i])) return null;
    let from = i, to = i;
    while (from > 0 && /^\s*>/.test(lines[from - 1])) from--;
    while (to < lines.length - 1 && /^\s*>/.test(lines[to + 1])) to++;
    return lines.slice(from, to + 1);
  };

  /**
   * Whether a block quote carries the English half on a line of its own.
   *
   * **Both halves are counted rather than testing for "has Latin in it"**: the Chinese half of these
   * messages embeds English option names (`状态选项 Not started / In progress / …`), so a presence
   * test would let the Chinese line vouch for itself and exempt its own block. A line that is still
   * quoting a label is not a translation of one either, so those are excluded outright.
   */
  const carriesEnglish = (block) => block.some((l) => !l.includes('「')
    && (l.match(/[A-Za-z]/g) ?? []).length > (l.match(/[一-鿿]/g) ?? []).length);

  /**
   * The label alone is not enough — 「保存并验证」 on its own is exactly what the docs carried while
   * the English half went unmentioned for a release. Each one has to be given English first with
   * the Chinese in parentheses, which is what these files now say they do.
   *
   * **A block quote reproducing what the program prints is the one exception.** Those strings carry
   * the corner brackets themselves (`notion.created` is `创建成功:「{name}」,…`), so rewriting one
   * into English-then-parenthesis would misquote the program — the exact failure the rest of this
   * file exists to catch. The English half is still required; in a quotation it sits on its own line
   * beside the Chinese, so the block is asked for it rather than the 80 characters before the label.
   */
  test('a quoted label is preceded by its English half', () => {
    const bad = [];
    for (const f of WALKTHROUGHS) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        const block = quoteBlock(lines, i);
        if (block && carriesEnglish(block)) return;
        for (const m of line.matchAll(/(.{0,80})「([^」]+)」/g)) {
          const [, before, label] = m;
          // The Chinese half sits in parentheses directly after the English one. A label that opens
          // a parenthesis it did not close is being quoted bare
          if (!/[(（]\s*$/.test(before)) bad.push(`${f}: 「${label}」`);
        }
      });
    }
    assert.deepEqual(bad, [], 'these labels are quoted without the English half in front of them');
  });

  /**
   * The exemption is pinned here rather than left to whichever document happens to use it, so that
   * neither half of what makes a quotation bilingual can be dropped without a test going red.
   */
  test('the block-quote exemption needs a real English line, not merely a block quote', () => {
    const zh = '> 创建成功:「Steam 攻略」,状态选项 Not started / In progress / Staged / Done。ID 已填好并保存。';
    const en = '> Created: Steam 攻略, status options Not started / In progress / Staged / Done. The ID is filled in and saved.';
    assert.equal(carriesEnglish([zh, '>', en]), true, 'the line beside it is the English half');
    assert.equal(carriesEnglish([zh, '>']), false,
      'the Chinese half embeds English option names and must not vouch for itself');
    assert.equal(carriesEnglish(['> Click 「保存并验证」 when you are done.']), false,
      'a line still quoting the label is not a translation of it');
  });
});
