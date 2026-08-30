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

describe('every message thrown from lib/ is Chinese', () => {
  /**
   * The strict one, and the only surface clean enough to be strict about: **all 85 of these are
   * Chinese today, with no exemptions**.
   *
   * These strings are not diagnostics. `lib/` throws them and the Dashboard prints them verbatim
   * into its floating bar, which is why CLAUDE.md forbids them from carrying command lines — the
   * packaged app's user has no terminal. The same reasoning fixes their language: whoever reads
   * them is reading the rest of that interface in Chinese.
   *
   * If a genuinely internal error ever needs to be English, add it to an exemption map here with
   * the reason written out, the way `TERMINAL_ONLY` does in cli-hints.test.js — do not loosen the
   * rule, because "deliberately exempt" and "translated by accident" have to stay distinguishable.
   */
  const libFiles = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));

  /** Every string literal handed straight to `new Error(...)`, comments stripped first */
  const thrownLiterals = (src) =>
    [...stripComments(src).matchAll(/new Error\(\s*(['"`])((?:[^\\]|\\.)*?)\1/g)].map((m) => m[2]);

  test('not one of them is English', () => {
    const english = [];
    let total = 0;
    for (const f of libFiles) {
      for (const s of thrownLiterals(read(join('lib', f)))) {
        total++;
        if (!CJK.test(s)) english.push(`lib/${f}: ${JSON.stringify(s.slice(0, 60))}`);
      }
    }
    // Guard the extraction itself: an empty result would otherwise read as "all of them pass"
    assert.ok(total > 60, `only ${total} thrown messages were found in lib/ — the extraction is broken, not the rule satisfied`);
    assert.deepEqual(english, [],
      'these messages are thrown from lib/ in English, and they render verbatim in the Dashboard floating bar:\n  '
      + english.join('\n  '));
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
