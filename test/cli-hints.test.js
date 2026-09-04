/**
 * The terminal-only advice was not lost
 * ------------------------------------------------
 * Error messages in lib/ now say only **what happened**, because the same sentence appears
 * verbatim in the Dashboard's floater, where the user (especially in the packaged build) has
 * no terminal and should not be asked to edit config.json.
 *
 * But advice like "add --provider X" or "raise ai.maxAchievements" is the most useful thing
 * there is for a terminal user, and should not evaporate to accommodate the other surface.
 * It moved into `tracker.js`'s `CLI_HINTS`, keyed by the error's `code`. **This file exists
 * because of that move**: three tests used to pin those sentences inside the message bodies,
 * and after the change those three naturally stopped applying — without pinning them again in
 * the new place, a guarantee would have been silently deleted.
 *
 * It checks by source text, the same approach as `html-smoke.test.js` /
 * `SKILL_RULE_DISPOSITION` — `tracker.js` is the CLI entry point and runs a command on
 * import, so the constants cannot simply be imported out.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tracker = readFileSync(join(ROOT, 'tracker.js'), 'utf8');

/** Every .js under lib/. **Enumerated rather than a hardcoded list** — a hardcoded list misses files added later */
const libFiles = () => readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));

/**
 * The command lines in these files are **correct**, because their strings only ever reach a
 * terminal and cannot get into the Dashboard's floater.
 *
 * The reason is written out per file rather than loosening the check — "deliberately exempt"
 * and "one was missed" have to stay distinguishable.
 * The test below checks these files still exist, so renaming one cannot turn an exemption into
 * a silent hole.
 */
const TERMINAL_ONLY = {
  // loadConfig's HINTS: missing credentials are thrown at **startup**. The Dashboard path goes
  // through a 302 to /setup, plus startBackgroundSync's own notice, which mentions no command line
  'config.js': 'missing credentials are a startup-time error, and the page path redirects to the setup page',
  // log() prints to the server process's console (into the stderr pipe in the packaged build), not to the page
  'server.js': 'log() writes to the server console, not to the floater',
  // The table server.js and the CLI compose their terminal lines from. It is a separate file
  // from lib/messages.js **for this rule**: messages.js can reach the Dashboard, so it stays
  // strictly command-line-free, and anything bound for a terminal lives here instead
  'cli-messages.js': 'the terminal-only half of the message tables, by construction',
  // Split from cli-messages.js by size rather than audience — everything in it reaches a terminal
  // and nothing else, which is the whole reason it may name a command line
  'tracker-messages.js': "the CLI's own copy, terminal-only by construction",
};

/**
 * Every string literal in a source file that **a user could see**, with comments already
 * removed.
 *
 * Mentioning `sync --schema` or `--overwrite` in a comment is normal (those comments are
 * explaining why those switches exist and why they are no longer written into messages), so
 * this filters by comment rather than searching the whole file — otherwise this check would
 * force people to delete the explanations, and those explanations are exactly what the next
 * person needs to read.
 */
function userFacingStrings(src) {
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out = [];
  // Single-quoted, double-quoted and backtick literals
  for (const re of [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g]) {
    for (const m of noComments.matchAll(re)) if (m[1].trim()) out.push(m[1]);
  }
  return out;
}

/**
 * The body of the CLI_HINTS object literal — **which codes have advice**, not what the advice says.
 *
 * The prose moved into `lib/tracker-messages.js` when the CLI became switchable, so `tracker.js`
 * now holds only the mapping from an error code to a message key. The two halves are checked
 * separately below: this one that every code is covered, `adviceText()` that the covering entries
 * still say the things worth saying.
 */
function hintsBlock() {
  const start = tracker.indexOf('const CLI_HINTS = {');
  assert.notEqual(start, -1, 'CLI_HINTS not found — the extraction is broken, not the advice missing');
  const end = tracker.indexOf('\n};', start);
  assert.notEqual(end, -1, 'CLI_HINTS does not terminate properly');
  return tracker.slice(start, end);
}

/** Every hint's text, both languages, as one string to search */
function adviceText() {
  const src = readFileSync(join(ROOT, 'lib', 'tracker-messages.js'), 'utf8');
  const start = src.indexOf("'hint.providerModelMismatch'");
  assert.notEqual(start, -1, 'the advice entries were renamed — this extraction is broken, not the advice missing');
  return src.slice(start);
}

describe('CLI_HINTS covers every error code in lib/ that carries a detail', () => {
  const block = hintsBlock();

  // The ones thrown in lib/ that the terminal still has something to add to
  const CODES = [
    'provider-model-mismatch', 'too-many-achievements',
    'chunk-too-small', 'guide-exists', 'file-exists',
    'bad-api-key', 'deepseek-length',
    // Thrown as `timeoutErr.code = 'ai-timeout'` in all three providers — the capital E in
    // `timeoutErr` means the literal substring `err.code = '` never occurs, so the
    // /err\.code = '.../ scan just below silently never sees it. Hardcoded here for the same
    // reason as bad-api-key and deepseek-length just above: escapes the scan, still needs a hint
    'ai-timeout',
  ];
  for (const code of CODES) {
    test(code, () => {
      assert.ok(block.includes(`'${code}'`), `${code} has no corresponding terminal advice`);
    });
  }

  test('every code raised in lib/ is in this table — adding a new code must not forget the terminal side', () => {
    const codes = new Set();
    for (const f of libFiles()) {
      const src = readFileSync(join(ROOT, 'lib', f), 'utf8');
      for (const m of src.matchAll(/err\.code = '([a-z-]+)'/g)) codes.add(m[1]);
    }
    // no-schema is deliberately absent: it means "Steam simply has no achievements for this
    // game", and the terminal has nothing else to offer either. Listing it here keeps
    // "was missed" and "deliberately has none" distinguishable
    const NO_HINT_NEEDED = new Set(['no-schema']);
    const missing = [...codes].filter((c) => !NO_HINT_NEEDED.has(c) && !block.includes(`'${c}'`));
    assert.deepEqual(missing, [], `these codes are thrown in lib/ but have no terminal advice: ${missing.join(', ')}`);
  });

  test('not one of the sentences formerly pinned inside the message bodies is missing', () => {
    const advice = adviceText();
    // Provider/model mismatch: two fixes plus the source most easily overlooked
    assert.match(advice, /--provider \{belongsTo\}/, 'it has to give a directly usable fix');
    assert.match(advice, /--model/, 'the fix for the other direction has to be given too');
    assert.match(advice, /环境变量会盖掉 config\.json/, 'this is the kind of source most easily overlooked');
    assert.match(advice, /environment variables override config\.json/, 'and the English half has to say it too');
    // Too many achievements: which knob, and what it is now
    assert.match(advice, /ai\.maxAchievements/);
    // Still unwritable at the floor: **it advises against**, and this one is far easier to get backwards than the two above
    assert.match(advice, /别急着调大 ai\.maxTokens/);
    assert.match(advice, /Do not reach for a larger ai\.maxTokens/);
    // DeepSeek's 401: an env var overrides the config file, and clearing it can only be done in a terminal
    assert.match(advice, /Remove-Item Env:\{envVar\}/);
  });

  test('a command line stays a command line in both halves', () => {
    // The one thing a translation must not do here: a flag, a file name or a config field is
    // retyped by the reader, so it is the same string in both languages or the English half is
    // advice that cannot be followed
    const src = readFileSync(join(ROOT, 'lib', 'tracker-messages.js'), 'utf8');
    for (const literal of ['--provider', '--model', '--overwrite', '--only', 'ai.maxTokens',
      'ai.maxAchievements', 'Remove-Item Env:']) {
      const n = (src.split(literal).length - 1);
      assert.ok(n >= 2, `${literal} appears ${n} time(s) — one of the two languages dropped it`);
    }
  });

  test('these sentences appear only in the terminal, and lib/ must not hold another copy', () => {
    // One copy left in lib/ means command lines still surface on the Dashboard — the very thing
    // being fixed.
    //
    // **Scan all of lib/, not only the files that were changed.** The first version listed only
    // ai / guidegen / notion (the three the change touched), so two identical
    // 「先跑 sync --schema」 sentences in guides.js and guidelint.js went straight through — and
    // were only found by building the package and searching inside the exe.
    // For a "it has all been cleared out" check, the scan's scope matters more than the assertion
    for (const f of libFiles()) {
      if (TERMINAL_ONLY[f]) continue;
      const src = readFileSync(join(ROOT, 'lib', f), 'utf8');
      const bad = [];
      for (const s of userFacingStrings(src)) {
        if (/node tracker\.js|sync --schema|--overwrite|--local\b/.test(s)) bad.push(s.slice(0, 70));
        if (/Remove-Item|PowerShell|Get-ChildItem/.test(s)) bad.push(s.slice(0, 70));
      }
      assert.deepEqual(bad, [], `these user-facing strings in lib/${f} still carry a command line:\n  ${bad.join('\n  ')}`);
    }
  });

  test('the files on the exemption list have to still exist — rename one and the exemption becomes a silent hole', () => {
    const have = new Set(libFiles());
    const gone = Object.keys(TERMINAL_ONLY).filter((f) => !have.has(f));
    assert.deepEqual(gone, [], `these files are no longer in lib/ and their exemptions should be removed: ${gone.join(', ')}`);
  });
});

/**
 * An unregistered value-taking flag **misaligns silently** and raises no error.
 *
 * `positionalArgs` relies on `VALUE_FLAGS` to know that in `--effort low 648800`, `low` is a
 * value and `648800` is the appid. Unregistered, the appid becomes `low` and what gets
 * reported is something like "game not found" with nothing to do with `--effort` — and
 * following that sentence never reaches the real cause.
 * `--rounds` entered the table for exactly this reason back then (the comment says
 * `guide-gen --rounds 2 1937500`).
 */
describe('every value-taking flag is registered in VALUE_FLAGS', () => {
  const valueFlags = new Set(
    (tracker.match(/const VALUE_FLAGS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '')
      .split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
  );

  test('every flag flagValue reads is in the table', () => {
    // flagValue('x') means exactly "x is followed by a value", so it and VALUE_FLAGS have to
    // correspond one for one. One missing misaligns, and misalignment raises no error
    const read = new Set([...tracker.matchAll(/flagValue\('([^']+)'\)/g)].map((m) => '--' + m[1]));
    const missing = [...read].filter((f) => !valueFlags.has(f));
    assert.deepEqual(missing, [],
      `these flags are followed by a value but are not in VALUE_FLAGS: ${missing.join(' ')} — `
      + 'so that value is taken as a positional (the appid), and the reported error has nothing to do with the real cause');
  });

  test('--effort reaches the request body, and is a flag rather than a setting', () => {
    assert.ok(valueFlags.has('--effort'), '--effort low 648800 would take low as the appid');
    const fn = tracker.slice(tracker.indexOf('function applyAiFlags'));
    const body = fn.slice(0, fn.indexOf('\n}')).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(body, /config\.ai\.effort\s*=\s*effort/,
      'applyAiFlags has to genuinely write it into config.ai.effort — a mention in a comment does not count, '
      + 'and the top of this file says why a source assertion has to strip comments first');
  });
});
