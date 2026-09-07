/**
 * "Does not auto-dismiss" was a comment, not a behaviour
 * ------------------------------------------------
 * Run with: node --test
 *
 * `lib/rpc.js`'s status bar reports the things you cannot notice on your own — a developer adding
 * achievements to a finished game, an automatic write into your Notion notes, a game added to the
 * library by the sync itself, a failed run. Three separate comments and a line in CLAUDE.md say
 * those notices do not auto-dismiss.
 *
 * They did. The poll is `if (running) … else if (wasRunning) … else hide`, and the completion
 * branch clears `wasRunning` on its way out — so the next tick, 3 seconds later, fell into the
 * final `else` and hid the bar. Every notice lived exactly one poll interval. Nothing errored,
 * nothing looked wrong in the source, and the comment above each one said the opposite.
 *
 * **There is no DOM in this runner**, so this file reads `lib/rpc.js` as source, the way
 * `tray.test.js` reads `launcher/main.js`. Comments are stripped first — line comments before
 * block comments — because this file's own subject matter is heavily commented and a check that
 * greps for `sticky` would otherwise be satisfied by the paragraph explaining `sticky`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Line comments first: a `//` here can legitimately contain `/*`, and stripping blocks first eats real code */
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SRC = strip(readFileSync(join(ROOT, 'lib', 'rpc.js'), 'utf8'));

/** Every `show(` call in the source, as {call, tail} — the text of the call and what follows it */
function showCalls(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('show(', i)) !== -1) {
    // `const show = (state, …` is the definition, not a call
    if (/[.\w]/.test(src[i - 1] ?? '')) { i += 5; continue; }
    let depth = 0, j = i + 4, inStr = null;
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
    out.push({ call: src.slice(i, j + 1), tail: src.slice(j + 1, j + 60) });
    i = j + 1;
  }
  return out;
}

describe('the sync status bar keeps what it says it keeps', () => {
  test('every show() that returns straight afterwards is sticky', () => {
    const calls = showCalls(SRC);
    assert.ok(calls.length >= 4, `expected several show() calls, found ${calls.length}`);

    // Returning right after showing is this file's way of saying "and nothing else touches the bar
    // this tick" — which is exactly the shape that used to be undone three seconds later
    const returning = calls.filter((c) => /^\s*;?\s*return\b/.test(c.tail));
    assert.ok(returning.length >= 3, `expected the notice branches to still return, found ${returning.length}`);

    const leaky = returning.filter((c) => !/sticky:\s*true/.test(c.call)).map((c) => c.call.slice(0, 70));
    assert.deepEqual(leaky, [], 'these notices are shown and then left for the next poll to hide');
  });

  test('the progress line is deliberately not sticky', () => {
    const running = showCalls(SRC).find((c) => c.call.includes("show('running'"));
    assert.ok(running, 'the progress line should still exist');
    assert.ok(!/sticky/.test(running.call),
      'progress is replaced by the next tick; pinning it would leave "syncing" on screen after the run ends');
  });

  test('the poll only hides the bar when nothing is being kept on it', () => {
    // The bare form is what the bug was. Asserting the guard exists is not enough on its own —
    // an unguarded second copy would sit beside it and win
    assert.match(SRC, /else if \(bar\.dataset\.sticky !== '1'\) \{\s*bar\.style\.display = 'none';/,
      "the poll's hide must be guarded by the sticky flag");
    const bareElseHide = /\}\s*else\s*\{\s*bar\.style\.display = 'none';/.test(SRC);
    assert.equal(bareElseHide, false, 'an unguarded else-hide is the defect this file exists for');
  });

  test('the one timed hide belongs to the plain completion line, which carries no notices', () => {
    // That path is allowed to disappear on its own — there is nothing on it to miss
    assert.match(SRC, /show\('ok', done\);\s*setTimeout\(/);
  });

  test('a notice line wraps its content, so a <br> inside it breaks the line', () => {
    // `.rpc-line` is a flex row (the dot sits on the first baseline), and a bare <br> in a flex
    // container does not break: the run after it becomes a second flex item and lands beside the
    // text. Every `rpc-sub` explanation rendered as a right-hand column until the wrapper existed
    assert.match(SRC, /class="rpc-line" data-kind="\$\{kind\}"><div>\$\{html\}<\/div>/);
    assert.ok(SRC.includes('rpc-sub'), 'the sub-line style is what needs the wrapper');
  });
});
