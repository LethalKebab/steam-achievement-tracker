/**
 * The language boundary
 * ------------------------------------------------
 * This project deliberately keeps two languages, split by audience:
 *
 *  - **Anything a user reads at runtime is Chinese**: the Dashboard and Setup copy, the messages
 *    thrown from `lib/`, the CLI's output, and the prompt sent to the model.
 *  - **Anything a developer reads is English**: comments, documentation, test names.
 *
 * Everything on the second list was translated in one pass. **The failure this file guards is the
 * same pass being run again and taking the first list with it** — and that failure is silent in
 * every one of its forms:
 *
 *  - A translated error message from `lib/` renders verbatim in the Dashboard's floating bar, so
 *    the packaged app shows a sentence in the wrong language and nothing reports it.
 *  - A translated prompt changes **what the model is asked for**, not merely how it reads. That is
 *    why the prompt was excluded by hand; nothing in the code says so.
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

import { buildSystemPrompt } from '../lib/guidegen.js';
import { MESSAGES } from '../lib/messages.js';

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
 * A named const's initialiser, sliced by brace balancing.
 *
 * Not `indexOf(name)` plus a byte count, and not up to the next `\n};` — the latter silently runs
 * to the end of the file for a one-line object, which is how an early version of this check read
 * 1824 Chinese characters out of a three-entry label map.
 */
function constBlock(src, name) {
  const at = src.indexOf(`const ${name} = `);
  assert.ok(at > 0, `cannot find ${name} — the extraction is broken, not the rule gone`);
  const open = src.indexOf('{', at);
  assert.ok(open > at, `${name} does not open a block`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`the initialiser of ${name} does not close`);
}

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
describe('the messages that moved into lib/messages.js', () => {
  test('every entry has both languages, and the Chinese half really is Chinese', () => {
    const bad = Object.entries(MESSAGES).filter(([, v]) => {
      if (!Array.isArray(v) || v.length !== 2) return true;
      const [zh, en] = v;
      // A translation pass that took the runtime surface with it shows up here and nowhere else:
      // both halves present, both readable, and the Chinese one no longer Chinese
      return !zh || !en || !CJK.test(zh);
    }).map(([k]) => k);
    assert.deepEqual(bad, [], 'these entries are not a [zh, en] pair with a Chinese first half');
  });

  test('a slot in one language is a slot in the other', () => {
    const slots = (x) => (x.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
    const mismatched = Object.entries(MESSAGES)
      .filter(([, [zh, en]]) => slots(zh) !== slots(en))
      .map(([k]) => k);
    // A dropped slot does not throw — it renders the sentence without the value it existed to carry
    assert.deepEqual(mismatched, [], 'the two languages of these entries interpolate different things');
  });

  test('every key asked for exists, and every key defined is asked for', () => {
    const asked = new Set();
    for (const f of readdirSync(join(ROOT, 'lib')).filter((x) => x.endsWith('.js'))) {
      for (const m of stripComments(read(join('lib', f))).matchAll(/msg\('([^']+)'/g)) asked.add(m[1]);
    }
    for (const m of stripComments(read('tracker.js')).matchAll(/msg\('([^']+)'/g)) asked.add(m[1]);
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
    const mentioned = new Set(asked);
    for (const f of [...readdirSync(join(ROOT, 'lib')).filter((x) => x.endsWith('.js'))]) {
      for (const m of stripComments(read(join('lib', f))).matchAll(/'([a-z][\w.]*)'/g)) mentioned.add(m[1]);
    }
    const defined = new Set(Object.keys(MESSAGES));
    // msg() returns the key for a miss, so a typo reaches the user as a dotted identifier in the
    // floating bar rather than as an error anybody sees first
    assert.deepEqual([...asked].filter((k) => !defined.has(k)), [], 'these keys are used but not defined');
    assert.deepEqual([...defined].filter((k) => !mentioned.has(k)), [], 'these entries are translated but never used');
  });

  test('the language is actually set at both entry points', () => {
    // The table defaults to Chinese, so forgetting this is silent: the interface switches to
    // English and every message from lib/ keeps answering in Chinese
    assert.match(stripComments(read(join('lib', 'server.js'))), /setMessageLanguage\(config\.uiLanguage\)/,
      'serve has to set it before anything can fail');
    assert.match(stripComments(read('tracker.js')), /setMessageLanguage\(config\.uiLanguage\)/,
      'the CLI shares these messages with the Dashboard and has to agree with it');
    assert.match(stripComments(read(join('lib', 'api.js'))), /setMessageLanguage\(lang\)/,
      'saveUiLanguage has to move the messages too, or the toggle changes the page and not the errors');
  });
});

describe('the prompt sent to the model stays Chinese', () => {
  /**
   * Translating this is not a cosmetic change: the rules are quoted back at the model, the guide
   * format they describe is Chinese, and `SKILL.md` — which the disposition table in guidegen.js
   * is checked against — is Chinese too. A translated prompt asks for something different, and the
   * only evidence would be guides slowly coming out in a different shape.
   *
   * A ratio rather than a phrase: `guidegen.test.js` already pins the individual rules that must
   * be present (`序号不是身份`, `写得出做法`, and the rest), and this catches the wholesale case
   * those cannot — a pass that translates the prose around them.
   */
  const defs = [{
    api_name: 'A', name_cn: '第一步', name_en: '', description: '完成第一关。',
    game_name: '测试游戏', hidden: 0, icon: '',
  }];

  test('it is more than 40% Chinese', () => {
    const p = buildSystemPrompt('测试游戏', '1', defs);
    const ratio = cjkCount(p) / p.length;
    assert.ok(ratio > 0.4,
      `the system prompt is only ${Math.round(ratio * 100)}% Chinese (${cjkCount(p)} of ${p.length} characters). `
      + 'It was excluded from the translation by hand because translating it changes what the model is asked for');
  });

  test('both backend variants stay Chinese — the branch is per target, and only one of them is exercised by default', () => {
    for (const target of ['notion', 'local']) {
      const p = buildSystemPrompt('测试游戏', '1', defs, { target });
      assert.ok(cjkCount(p) / p.length > 0.4, `the ${target} variant of the prompt is no longer mostly Chinese`);
    }
  });
});

describe('what the CLI prints stays Chinese', () => {
  /**
   * Source assertions: `tracker.js` is the CLI entry point and runs a command on import, so these
   * constants cannot be imported out — the same reason `cli-hints.test.js` reads it as text.
   *
   * `CLI_HINTS` is a density check because its entries legitimately contain command lines
   * (`Remove-Item Env:…`) that are not Chinese and must not be. `PHASE_LABEL` is small and every
   * value is a label, so that one is checked per string.
   */
  const tracker = () => stripComments(read('tracker.js'));

  test('the terminal-only advice is still written in Chinese', () => {
    const cjk = cjkCount(constBlock(tracker(), 'CLI_HINTS'));
    assert.ok(cjk > 250,
      `CLI_HINTS holds only ${cjk} Chinese characters. This is the advice printed beside a failure, `
      + 'and it is read by the same person reading the rest of the terminal output');
  });

  test('the error labels are still written in Chinese', () => {
    const cjk = cjkCount(constBlock(tracker(), 'CODE_LABELS'));
    assert.ok(cjk > 40, `CODE_LABELS holds only ${cjk} Chinese characters`);
  });

  test('every sync phase label is Chinese', () => {
    const block = constBlock(tracker(), 'PHASE_LABEL');
    const values = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(values.length >= 3, `only ${values.length} phase labels were found — the extraction is broken, not the rule satisfied`);
    for (const v of values) assert.ok(CJK.test(v), `the phase label ${JSON.stringify(v)} is not Chinese`);
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
