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

/**
 * One CSS rule block, sliced between its own selector and its closing brace. `'.rpc-close'`
 * cannot collide with `.rpc-close:hover` or `.rpc-close svg`, because the anchor carries the
 * ` {` — and slicing to a real delimiter is what keeps this from drifting the way a fixed
 * byte window does as the block grows.
 */
function cssRule(selector) {
  const at = SRC.indexOf(`${selector} {`);
  if (at === -1) return null;
  const end = SRC.indexOf('}', at);
  return end === -1 ? null : SRC.slice(at, end + 1);
}

/** The body of the close button's click listener, between its two real anchors */
function clickBody() {
  const at = SRC.indexOf("closeBtn.addEventListener('click'");
  if (at === -1) return null;
  const end = SRC.indexOf('});', at);
  return end === -1 ? null : SRC.slice(at, end + 3);
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

/**
 * The other half of "does not auto-dismiss": a notice that never leaves on its own has to be
 * able to leave when told. Until it could, the corner stayed occupied until the *next* sync —
 * hours, with `syncStaleHours` at 12 and the app living in the tray — and `#toTop` sat 60px
 * up the whole time, since its observer keys off this bar being displayed.
 */
describe('a sticky notice can be dismissed', () => {
  test('the content goes in a child, or show() would delete the button', () => {
    // This is the one that fails silently: append a button to `bar` itself and it survives
    // exactly until the next notice, with nothing erroring and nothing looking wrong in the
    // source. The two assertions are not the same one twice — the second is what catches a
    // later edit "simplifying" the child away again
    assert.match(SRC, /barBody\.innerHTML = Array\.isArray\(lines\)/,
      'show() must write into the body child');
    assert.doesNotMatch(SRC, /\bbar\.innerHTML\s*=/,
      'writing the bar itself wipes every child, the close button included');
    assert.match(SRC, /bar\.appendChild\(barBody\);\s*bar\.appendChild\(closeBtn\);/,
      'both children have to actually be attached');
  });

  test('only a sticky bar draws one', () => {
    // Progress is replaced by the next tick and the plain completion line removes itself after
    // 3s. A button on progress would come back on the next poll, which reads as a dead control
    const base = cssRule('.rpc-close');
    assert.ok(base, 'the close button needs its own rule block');
    assert.match(base, /display: none;/, 'hidden by default');
    assert.match(SRC, /\.rpc-bar\[data-sticky="1"\] \.rpc-close \{ display: inline-flex; \}/,
      'and revealed only by the sticky flag — the same flag that decides it will not leave on its own');
  });

  test('room for it is reserved only when there is one', () => {
    assert.match(SRC, /\.rpc-bar\[data-sticky="1"\] \{ padding-right: 38px; \}/,
      'an unconditional padding puts a right margin on every progress line against nothing');
  });

  test('the pointer target clears WCAG 2.2 SC 2.5.8, computed rather than eyeballed', () => {
    // .gen-close shipped at 23×23 — one pixel under — and that was found by measuring, not by
    // reading. Asserting the arithmetic instead of the literals means the numbers can change
    // and this still answers the question that matters
    const rule = cssRule('.rpc-close');
    const svg = cssRule('.rpc-close svg');
    assert.ok(rule && svg, 'both blocks have to exist for the size to be decidable');
    const pad = Number(/padding: (\d+)px/.exec(rule)?.[1]);
    const w = Number(/width: (\d+)px/.exec(svg)?.[1]);
    const h = Number(/height: (\d+)px/.exec(svg)?.[1]);
    assert.ok([pad, w, h].every(Number.isFinite), `could not read the sizes: pad=${pad} w=${w} h=${h}`);
    assert.ok(w + pad * 2 >= 24 && h + pad * 2 >= 24,
      `${w + pad * 2}×${h + pad * 2} is under SC 2.5.8's 24×24 minimum`);
  });

  test('dismissing clears the flag as well as hiding', () => {
    const body = clickBody();
    assert.ok(body, 'the click listener should still be here');
    assert.match(body, /bar\.dataset\.sticky = '';/,
      'a bar left flagged sticky keeps guarding the poll hide for something already gone');
    assert.match(body, /bar\.style\.display = 'none';/,
      "and it is the style attribute the Dashboard's #toTop observer watches — without it "
      + 'the back-to-top button stays displaced after the notice is gone');
  });

  test('the icon is drawn here, not pulled from the Dashboard sprite', () => {
    // Same rule the file states for its dot: those ids live in another file, and renaming one
    // would leave a button containing nothing — a blank space, with no error anywhere
    assert.doesNotMatch(SRC, /<use\s+href=/, 'no reference into another file\'s sprite');
    assert.match(SRC, /<path d="M6 6l12 12M18 6L6 18"\/>/, 'the cross is drawn inline');
  });

  test('an icon-only control still carries a name, in the language shown', () => {
    // Nothing in the button is text, so the accessible name has to be supplied — and supplied when
    // the bar is shown, not when the button is built. The button exists from the moment this script
    // loads, before the page has settled its language, so a name given then is frozen in whichever
    // language happened to be current
    const at = SRC.indexOf('const show = (');
    const end = SRC.indexOf('};', at);
    assert.ok(at !== -1 && end > at, 'show() should still be the arrow function it was');
    const body = SRC.slice(at, end);
    assert.match(body, /closeBtn\.setAttribute\('aria-label', t\('close'\)\)/,
      'the accessible name is not taken from the table where the bar is shown');
    assert.match(body, /closeBtn\.title = t\('close'\)/, 'nor is the tooltip');
    assert.doesNotMatch(SRC, /closeBtn\.(?:title\s*=\s*|setAttribute\('aria-label',\s*)['"`]/,
      'a literal name is one language whatever the page is set to');
    assert.match(SRC, /closeBtn\.type = 'button';/,
      'a bare <button> defaults to submit');
    assert.match(SRC, /aria-hidden="true"/, 'and the svg inside it must not be announced twice');
  });
});
