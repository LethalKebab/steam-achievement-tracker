/**
 * Structural smoke tests for Dashboard.html / Setup.html
 * ------------------------------------------------
 * ## What it is, and what it is not
 *
 * **This is not a behaviour test.** The project has zero dependencies (see CLAUDE.md), with no
 * jsdom and no Playwright, so no real DOM runs here — clicks, focus and CSS cascade cannot be
 * verified at all, and that part still depends on a person looking at a browser.
 * **Do not read a green run of this file as "the interface is fine".**
 *
 * What it verifies is **referential integrity**: does the element the JS points at exist, does
 * what a selector points at exist, does the script parse. That sounds shallow, but it is exactly
 * the real failure mode of these two files — a page is one big string, and renaming or deleting
 * an element **makes nothing report anything**, it merely becomes null at runtime, silently, or
 * quietly stops a CSS rule from matching anything.
 *
 * These checks were written from **pits actually fallen into**, not made up as a list:
 *
 * - After `<details>` became `<section>`, the `details ol code` and `.hint a` rules stopped
 *   matching — inline code fell back to the default monospace and links in the notes turned dark
 *   blue, nearly invisible on a dark ground, and **nothing reported anything**. (Check: a type
 *   selector in the CSS has to still have a corresponding tag)
 * - After the whole `#newAchSection` block was deleted, a leftover `getElementById` returned null.
 *   (Check: every id the JS references has to exist)
 * - A hidden `required` control makes the browser **refuse to submit silently**, logging
 *   "not focusable" in the console, and presenting as "pressing save does nothing".
 *   (Check: no required inside the stepped form)
 * - `classList.toggle(name, undefined)` **flips rather than clears**, so with a field missing from
 *   the state object the sync line in the topbar blinks every 3 seconds and never stops.
 *   (Check: the second argument has to be booleanised)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['Dashboard.html', 'Setup.html'];
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** The separator used when joining several inline scripts */
const SEP = String.fromCharCode(10);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Inline <script> only (one with src does not count — that is /_rpc.js, which is not in this file) */
const inlineScripts = (html) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const styleBlocks = (html) => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);

/** Remove <style> and <script>; what is left is the static markup — otherwise `button {` in the CSS is taken for a tag */
const markupOnly = (html) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

/**
 * Then strip `<!-- -->` as well.
 *
 * `markupOnly` leaves comments alone, and in an assertion of the form "this copy must not contain
 * a certain word", **the comment explaining why that word cannot be used sits right beside it** —
 * without stripping, the assertion is fed by the comment and stays green with the code deleted.
 * This is the same pit this repository keeps falling into (maybeAutoSync in tray.test.js, the
 * Dashboard's loadDashboard(); see CLAUDE.md, "Strip comments before any source assertion").
 */
const markupNoComments = (html) => markupOnly(html).replace(/<!--[\s\S]*?-->/g, '');

/** The markup of one step. Slice by data-step, never by byte count — a fixed window drifts quietly as the content grows */
const stepBlock = (html, n) => {
  const m = markupNoComments(html).match(
    new RegExp(`data-step="${n}"[\\s\\S]*?(?=data-step="${n + 1}"|</form>)`)
  );
  assert.ok(m, `cannot find the data-step="${n}" block in Setup.html`);
  return m[0];
};

/**
 * Every source of "what the page might emit": the static markup **plus** the strings that assemble
 * HTML in the JS.
 *
 * The Dashboard's table is almost entirely assembled in JS — `class="manual-input"`,
 * `data-fav-appid="` and `<img` exist only in strings inside the scripts. Looking at the static
 * markup alone judges all of them "absent", which was the source of false positives in the first
 * version.
 *
 * Strip block comments only: `//` line comments must not be stripped, or the double slash in
 * `'https://…'` is hit by mistake.
 */
const emittingSource = (html) => html.replace(/\/\*[\s\S]*?\*\//g, '');

const definedIds = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** The two ways the JS fetches an element by id. Setup.html wraps getElementById in $ */
const referencedIds = (js) => [
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
];

const querySelectors = (js) =>
  [...js.matchAll(/querySelectorAll?\('([^']+)'\)/g)].map((m) => m[1]);

/**
 * The type selectors used in the CSS (`details`, `summary`, `button`…).
 *
 * Strip @keyframes as whole blocks first — the `from` / `to` / `50%` inside are not tags. For the
 * other at-rules (@media) only the prefix line is removed; the rules inside the block are read as
 * usual.
 */
function cssTypeSelectors(css) {
  // **Strip comments first.** Without that, comment prose is taken for selectors — the CSS
  // comments in this file are full of words like `emoji`, `img` and `svg`, and the first version
  // reported all of them
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutKeyframes = withoutComments.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out = new Set();
  for (const m of withoutKeyframes.matchAll(/(^|\}|\{)\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[2].split(',')) {
      for (const simple of sel.trim().split(/[\s>+~]+/)) {
        // Remove .class / #id / [attr] / :pseudo; what is left is the type selector
        const tag = simple.replace(/[.#[:][^\s]*$/, '').replace(/[.#[:].*/, '').trim();
        if (/^[a-z][a-z0-9]*$/.test(tag)) out.add(tag);
      }
    }
  }
  return out;
}

/** The tokens in a selector that can be verified against the markup */
function selectorTokens(sel) {
  const tokens = [];
  for (const m of sel.matchAll(/#([\w-]+)/g)) tokens.push({ kind: 'id', name: m[1] });
  for (const m of sel.matchAll(/\.([\w-]+)/g)) tokens.push({ kind: 'class', name: m[1] });
  for (const m of sel.matchAll(/\[([\w-]+)/g)) tokens.push({ kind: 'attr', name: m[1] });
  return tokens;
}

// These tags need not be found individually in the markup: they are either the root element or
// created dynamically by JS
const TAG_WHITELIST = new Set(['html', 'body', 'option']);

// ---------------------------------------------------------------------------

describe('the inline scripts parse', () => {
  for (const page of PAGES) {
    test(page, () => {
      const scripts = inlineScripts(read(page));
      assert.ok(scripts.length > 0, `no inline script found in ${page} — the extraction is broken, not the page empty`);
      scripts.forEach((src, i) => {
        // A syntax error presents in a browser as "none of the page JS runs" while the HTML
        // renders as usual — it looks like a broken interface, not a syntax error
        assert.doesNotThrow(() => new Script(src), `syntax error in script block ${i + 1} of ${page}`);
      });
    });
  }
});

describe('every element id the JS points at exists', () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      const defined = definedIds(html);
      const referenced = [...new Set(inlineScripts(html).flatMap(referencedIds))];
      assert.ok(referenced.length > 5, `only ${referenced.length} references were caught in ${page}; the extraction may be broken`);
      const missing = referenced.filter((id) => !defined.has(id));
      assert.deepEqual(missing, [],
        `these ids are referenced by JS in ${page} but are not in the markup (null at runtime, with no error): ${missing.join(', ')}`);
    });
  }
});

describe('the selectors used with querySelector have something to match in the markup', () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      const src = emittingSource(html);
      const srcNoCss = src.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
      // Every class-name token that ever appears inside a class="…" (both static markup and JS
      // template strings).
      // **The attribute is not required to be closed** — JS often writes
      // `'<div class="g-card' + (x ? ' y' : '') + '"'`, with the closing quote in another string.
      // So it stops at a `"` or `'`, which catches both forms
      const classTokens = new Set(
        [...srcNoCss.matchAll(/class="([^"']*)/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
      );
      const defined = definedIds(html);
      const bad = [];
      for (const sel of new Set(inlineScripts(html).flatMap(querySelectors))) {
        for (const t of selectorTokens(sel)) {
          let ok;
          if (t.kind === 'id') {
            ok = defined.has(t.name);
          } else if (t.kind === 'attr') {
            // An attribute is always written out as `="`, so this can be verified exactly
            ok = new RegExp(`\\b${t.name}=`).test(src);
          } else {
            // A class name has to appear in a context **where it is really emitted**, in two forms:
            //   1. `class="… name …"` — counted in static markup and in JS template strings
            //   2. a standalone quoted string `'name'` / `' name'` — used to assemble className or
            //      classList (`'game-row' + (canExpand ? ' expandable' : '')`)
            //
            // It used to be "appears at least twice in the whole file", and mutation testing proved
            // that unreliable: short names are everywhere (`step` is hit by `step-nav`, `showStep`
            // and `data-step` alike), so deleting the emitting side left the count high enough.
            // **<style> has to be excluded** — a class name nearly always has a rule in the CSS.
            // **Split real class tokens on whitespace; \b cannot be used.** `\b` counts `-` as a
            // boundary too, so looking for `step` is satisfied by `class="step-title"` — a false
            // positive mutation testing caught
            ok = classTokens.has(t.name)
              || new RegExp(`'\\s*${t.name}\\s*'`).test(srcNoCss);
          }
          if (!ok) bad.push(`${sel} → ${t.kind} "${t.name}"`);
        }
      }
      assert.deepEqual(bad, [], `these selectors in ${page} match nothing:\n  ${bad.join('\n  ')}`);
    });
  }
});

describe('the type selectors in the CSS still have corresponding tags', () => {
  for (const page of PAGES) {
    test(page, () => {
      const html = read(page);
      // Look for `<tag` in **the static markup plus the strings assembled in JS** — the
      // Dashboard's img/svg exist only inside scripts
      const src = emittingSource(html).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
      // **A third form: `document.createElement('tag')`.** Without it, a tag created only through
      // the DOM API is reported as "a silently dead rule" while it plainly exists on the page —
      // which is how the archive panel's `.arc-main b` ran into it. That it had never surfaced was
      // pure luck: the div/span/button/li created by createElement happen to appear as `<tag`
      // elsewhere, and `b` was the first that did not
      const created = new Set(
        [...src.matchAll(/createElement\(\s*['"]([a-zA-Z][a-zA-Z0-9-]*)['"]/g)].map((m) => m[1].toLowerCase())
      );
      const orphans = [...cssTypeSelectors(styleBlocks(html).join('\n'))]
        .filter((tag) => !TAG_WHITELIST.has(tag)
          && !created.has(tag)
          && !new RegExp(`<${tag}[\\s>]`).test(src));
      // This one was written from a real event: after <details> became <section>, the
      // details ol code rule silently stopped applying, inline code on the page fell back to the
      // browser default, and nothing reported anything
      assert.deepEqual(orphans, [],
        `these type selectors in the CSS of ${page} no longer match any tag (the rules are silently dead): ${orphans.join(', ')}`);
    });
  }
});

describe('pits fallen into, pinned', () => {
  test('no required inside the stepped Setup form — a hidden required control makes submission fail silently', () => {
    const markup = markupOnly(read('Setup.html'));
    const offenders = [...markup.matchAll(/<input[^>]*\brequired\b[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(offenders, [],
      'the browser refuses to validate a display:none required control and only logs not focusable in the console — '
      + 'on screen that is "pressing save does nothing". Validation has to go through the manual stepOneOk path');
  });

  /**
   * Reported twice by users, the same rule both times: **the English appearing in an instruction
   * step has to be the wording on the control at this moment.**
   *
   * 2026-08-17 — following step 3 to Notion, 「Internal Integration」 could not be found on screen,
   * because it is a conceptual name that appears nowhere in Notion. 2026-08-29 — the same passage
   * stopped matching again, this time because Notion changed it: the button went from
   * `New integration` to `New connection`, the secret from `Integration Secret` to `Access token`,
   * and the developer page moved away from `notion.so/my-integrations`.
   *
   * The symptom is the same both times: whoever follows it gets stuck, and **this kind of error
   * reports nothing at all**.
   *
   * The assertion slices the `<ol>`, not the whole step. **Only an old name inside the steps
   * counts as wrong; one elsewhere in the step does not** — this step may grow other sentences at
   * any time, and as long as one of them carries an old word, a match against the whole step is
   * fed and stays green with the instructions wrong. That is not hypothetical: the first version
   * did match the whole step, and after the change to `New connection` the test said nothing,
   * because a line carrying the old names was hanging under the step at the time.
   */
  const notionSteps = (html) => {
    const step = stepBlock(html, 3);
    const a = step.indexOf('<ol>');
    const b = step.indexOf('</ol>', a);
    assert.ok(a > 0 && b > a, 'cannot slice the step list of step 3');
    return step.slice(a, b);
  };

  test('the Notion step quotes the wording on the interface at this moment', () => {
    const ol = notionSteps(read('Setup.html'));
    assert.match(ol, /New connection/, 'the wording on the button. The user is looking for it on screen by this passage');
    assert.match(ol, /Access token/, 'the wording of the secret field');
    assert.doesNotMatch(ol, /Internal\s+Integration/i,
      '「Internal Integration」 is a conceptual name that appears nowhere in Notion — it sends people looking for a label that does not exist');
    assert.doesNotMatch(ol, /my-integrations/,
      'the developer page is no longer at this address');
  });

  // No old-name equivalents are placed on this step — there are only two steps in total, and a
  // line of synonyms beside them makes the reader work out which set is for them. The old names
  // stay in docs/notion-setup.md
  test('this step does not present the old and new names side by side', () => {
    const step = stepBlock(read('Setup.html'), 3);
    assert.doesNotMatch(step, /New integration|Integration Secret/,
      'the old names belong to the walkthrough document, not to these two lines of steps');
  });

  test('the setup page has a walkthrough entry, and the document it points at still exists', () => {
    const step = stepBlock(read('Setup.html'), 3);
    assert.match(step, /docs\/notion-setup\.md/,
      '"open the instructions and let me follow along" was the second thing the user asked for. The walkthrough page was always there; only this entry was missing');
    assert.ok(existsSync(join(ROOT, 'docs/notion-setup.md')),
      'the setup page points at docs/notion-setup.md. Renaming the document makes nothing report anything, '
      + 'it merely turns that link into a 404 — and whoever clicks it is already stuck');
  });

  test('the second argument of classList.toggle has to be booleanised, or undefined flips it', () => {
    for (const page of PAGES) {
      const js = inlineScripts(read(page)).join('\n');
      for (const m of js.matchAll(/classList\.toggle\(([^)]*)\)/g)) {
        const args = m[1].split(',');
        if (args.length < 2) continue;       // one argument is a deliberate "flip"
        const second = args[1].trim();
        const safe = /^(true|false)$/.test(second)
          || second.startsWith('Boolean(')
          || second.startsWith('!')
          || /[=<>]=?/.test(second);          // a comparison expression is a boolean already
        assert.ok(safe,
          `${page}: the second argument of classList.toggle(${m[1]}) is not guaranteed to be a boolean. `
          + 'undefined makes it **flip** rather than clear — with a field missing from the state object, this class blinks on every poll');
      }
    }
  });

  test('the sync button is an icon, and onSyncState must not write its textContent', () => {
    const js = inlineScripts(read('Dashboard.html')).join('\n');
    const start = js.indexOf('window.onSyncState');
    assert.ok(start > 0, 'cannot find onSyncState — this check has lost its target rather than passed');
    const body = js.slice(start, start + 1200);
    assert.ok(!/syncBtn\.(textContent|innerHTML)\s*=/.test(body),
      'writing textContent replaces the 🔄 with text and deletes the .icon-glyph inside it — '
      + 'the spin and state styles have nowhere to hang after that. State goes through class and title');
  });
});

/**
 * The `hidden` attribute has to really hide — both pages need that global rule
 * ------------------------------------------------
 * The browser's own `[hidden] { display: none }` comes from the **user-agent stylesheet**, and any
 * `display:` in the author stylesheet outranks it. So one unrelated layout rule can quietly turn
 * an element's `hidden` into decoration: the JS sets `.hidden = true` as usual, the element shows
 * as usual, and **nothing reports anything**.
 *
 * This is not hypothetical. A scan on 2026-08-14 found three already caught across the two pages:
 *   · `.gallery { display: grid }`  → after the Dashboard switches back to the table view, the
 *     grid content stays below the table (`render` returns early in table mode and never repaints
 *     #gallery, so the old content hangs there)
 *   · `.steps { display: flex }`         → the step bar on the setup page
 *   · `.step-actions { display: flex }`  → the button row on the setup page, all three showing at once
 *
 * The page **already** carried a `.step[hidden] { display: none }` at the time — so the pit was
 * known, and patching it one element at a time is whack-a-mole: the next rule carrying `display`
 * opens a new hole, equally silently.
 * So it became one global rule, making this class structurally impossible. The `!important` is
 * required, because what it has to outrank is exactly "some display someone writes later".
 *
 * What is pinned here is **the rule itself**, not a few elements — elements come and go, and while
 * the rule is there this class cannot come back.
 */
describe('the hidden attribute cannot be hollowed out by a display rule', () => {
  for (const page of PAGES) {
    test(`${page} has a global [hidden] { display: none !important }`, () => {
      const css = styleBlocks(read(page)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      const guard = rules.find(
        (m) =>
          m[1].split(',').some((s) => s.trim() === '[hidden]') &&
          /display\s*:\s*none\s*!important/.test(m[2])
      );
      assert.ok(
        guard,
        `${page} is missing the global [hidden] rule — any display: at all silently kills some element hidden`
      );
    });

    test(`no element with hidden in ${page} is individually hollowed out by another display rule`, () => {
      // With the global rule in place this always passes; its value is that **when the global rule
      // is deleted** it reports which elements are actually caught, so whoever fixes it knows what
      // they are protecting rather than only seeing an abstract rule go missing
      const html = read(page);
      const css = styleBlocks(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*display\s*:[^{}]*)\}/g)].map((m) => ({
        sels: m[1].split(',').map((s) => s.trim()),
        decl: m[2],
      }));
      if (rules.some((r) => r.sels.includes('[hidden]') && /none\s*!important/.test(r.decl))) return;

      const hiddenTags = [...html.matchAll(/<(\w+)([^>]*\shidden(?=[\s/>])[^>]*)>/g)].map((m) => ({
        id: m[2].match(/\sid="([^"]+)"/)?.[1] ?? '',
        cls: (m[2].match(/\sclass="([^"]+)"/)?.[1] ?? '').split(/\s+/).filter(Boolean),
      }));
      const broken = hiddenTags.filter((t) =>
        rules.some(
          (r) =>
            !r.sels.some((s) => s.includes('[hidden]')) &&
            r.sels.some((s) => t.cls.some((c) => s === '.' + c) || (t.id && s === '#' + t.id))
        )
      );
      assert.deepEqual(broken.map((t) => t.id || t.cls.join('.')), [], 'the hidden on these elements is decoration');
    });
  }
});

/**
 * The design tokens of the two pages have to be one copy
 * ------------------------------------------------
 * Colours, spacing, font sizes and radii all converge into one block of variables on `:root`, and
 * **zero dependencies allows no shared stylesheet** (CLAUDE.md's stack constraints: no build step,
 * a page is one big string), so that block is stored once in Dashboard.html and once in Setup.html.
 *
 * Two hand-copied things will certainly diverge, and the symptom of divergence is that **nothing
 * reports anything**: the blue on the setup page differs slightly from the blue on the main
 * interface, or a `--danger` added while changing the main interface is undefined on the setup
 * page — and an undefined CSS variable raises no error, it makes the whole declaration invalid and
 * the colour quietly falls back to the inherited value.
 *
 * So this compares them declaration by declaration. **What is compared is declarations, not
 * bytes** — the two pages indent differently (4 spaces / 2) and their comments explain their own
 * contexts, so comparing the raw text would report a false alarm every day.
 */
describe('the :root design tokens of the two pages are one copy', () => {
  /** Take the declarations inside :root and normalise them into an ordered array of `name:value` */
  const rootDecls = (html) => {
    const css = styleBlocks(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = css.match(/:root\s*\{([^{}]*)\}/);
    assert.ok(m, 'cannot find :root — this check has lost its target rather than passed');
    return m[1]
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  };

  test('the tokens in Dashboard.html and Setup.html are identical entry by entry', () => {
    const a = rootDecls(read('Dashboard.html'));
    const b = rootDecls(read('Setup.html'));
    assert.ok(a.length > 30, `only ${a.length} declarations were caught; the extraction may be broken`);

    const only = (x, y) => x.filter((d) => !y.includes(d));
    assert.deepEqual(
      { 只在Dashboard: only(a, b), 只在Setup: only(b, a) },
      { 只在Dashboard: [], 只在Setup: [] },
      'the design tokens of the two pages have diverged — one was changed and the other forgotten. An undefined variable raises no error, '
      + 'it merely invalidates that declaration and the colour or spacing quietly falls back to the inherited value'
    );
  });

  /**
   * A runtime measurement does not belong in the token block.
   *
   * `--topbar-h` is the topbar height the Dashboard measures with a ResizeObserver (the table
   * header sticks to it) and is not part of the design system. Writing it into :root would leave
   * the parity assertion above permanently red, and the laziest way to "fix" that is to stuff an
   * unused --topbar-h into Setup as well — at which point things unrelated to design start mixing
   * into the token block and the discipline rots. So it is pinned separately.
   */
  test('--topbar-h is not in :root; it is a runtime measurement, not a token', () => {
    const css = styleBlocks(read('Dashboard.html')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const root = css.match(/:root\s*\{([^{}]*)\}/)[1];
    assert.ok(!/--topbar-h/.test(root), '--topbar-h should not appear in :root');
    assert.match(css, /--topbar-h\s*:/, 'but it needs a default value elsewhere — the frame before the JS has run needs it');
  });
});

describe('the setup page: the interface has to assemble even before the server is up', () => {
  test('the getSettings call is wrapped in try/catch', () => {
    // With the server not up, `call` **throws** rather than returning {error} — the `if (s.error)`
    // fallback below never gets its turn. Missing the catch means initSteps() does not run: the
    // step bar does not appear, only the first of the four sections is left, and not one button is
    // collapsed (「下一步」 and 「保存并验证」 sit side by side). In the packaged build Electron
    // opens the window before waiting for the child process, landing exactly in that window.
    const js = inlineScripts(read('Setup.html')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const i = js.indexOf("call('getSettings'");
    assert.ok(i > 0, 'cannot find the getSettings call');
    const around = js.slice(Math.max(0, i - 300), i + 200);
    assert.match(around, /try\s*\{/, 'the getSettings call is not wrapped in a try');
    assert.match(around, /catch/, 'there is no catch — a failed fetch aborts the whole load()');
  });
});

/**
 * Once `aiReady` lands it may only repaint, never refetch
 * ------------------------------------------------
 * `aiReady` / `notionReady` affect only **how it is drawn**, not **what is drawn**. Writing
 * `loadDashboard()` re-fetches the whole library to flip one boolean — and that happens to make an
 * existing race visible:
 *
 * `aiReady` starts false and the page-load `loadDashboard()` runs immediately, so whether
 * 「✨ 生成」 is there depends on which of `getSettings` (reading an object in memory) and
 * `getDashboardData` (reading the whole library) returns first. Normally the former wins easily,
 * so normally nothing shows. **The moment right after the first setup the server is busy** — the
 * full sync of startupJobs, guide discovery and ticking are all running, Node is single-threaded,
 * and the order flips: a table with no buttons is drawn first, and the buttons only appear once a
 * second full fetch reaches the front of the queue. A real user reported it: right after connecting
 * Notion there was no generate button, and a refresh brought it back. Changing it back to
 * `loadDashboard()` makes this recovery path the most expensive one again, and expensive exactly
 * when the server is busiest.
 *
 * A source assertion: this logic lives in an async callback inside an IIFE, there is no DOM with
 * zero dependencies, and a unit test cannot reach it — the same family as the `onSyncState` one.
 */
describe('loadAiState only repaints once it lands', () => {
  test('that repaint calls render(), not loadDashboard()', () => {
    // **Both kinds of comment have to go.** Stripping only `/* */` lets the `doesNotMatch` below
    // be satisfied by this logic's own `//` explanatory comment — which says `loadDashboard()`.
    // The same family as the one in tray.test.js; the difference is that this one went red on the
    // spot rather than running empty
    const js = inlineScripts(read('Dashboard.html'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const i = js.indexOf('notionReady = Boolean(');
    assert.ok(i > 0, 'cannot find the line in loadAiState that sets notionReady');
    // Slice to this block before matching, so a loadDashboard() elsewhere in the file cannot feed
    // the assertion
    const block = js.slice(i, js.indexOf('})();', i));
    assert.match(block, /\brender\(\)/, 'the repaint has to call render()');
    assert.doesNotMatch(
      block,
      /\bloadDashboard\(\)/,
      'calling loadDashboard() here re-fetches the whole library for one boolean, and exactly when the server is busiest'
    );
  });

  test('confirm allGames already has data before repainting', () => {
    // The reverse order has to be right too: when getSettings returns first, allGames is still
    // empty, and render() then draws an empty table which the loadDashboard result overwrites — a
    // flash of "no games"
    // **Both kinds of comment have to go.** Stripping only `/* */` lets the `doesNotMatch` below
    // be satisfied by this logic's own `//` explanatory comment — which says `loadDashboard()`.
    // The same family as the one in tray.test.js; the difference is that this one went red on the
    // spot rather than running empty
    const js = inlineScripts(read('Dashboard.html'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const i = js.indexOf('notionReady = Boolean(');
    const block = js.slice(i, js.indexOf('})();', i));
    assert.match(block, /allGames\.length/, 'without the allGames.length guard, a getSettings that arrives first draws an empty table');
  });
});

/**
 * Self-hosted fonts
 * ------------------------------------------------
 * This group guards **silent degradation**: a wrong font link, files not shipped, the packaging
 * filter missing assets — not one of the four raises an error. The page renders as usual and
 * merely falls back to a system font, which is the very problem shipping the font solves (it looks
 * different on another machine, and 600/650/700 collapse into one weight in Chinese).
 *
 * The packaging one is especially worth pinning: it **fails only in the packaged build** and
 * `npm start` always looks fine — the same pit as `icon.ico` and `updater.js` in CLAUDE.md.
 */
describe('the search box does two jobs at once', () => {
  /** The inline scripts with both kinds of comment removed — the comments contain these words too, and leaving them feeds the assertions */
  const js = () => inlineScripts(read('Dashboard.html'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  test('with a search term, all five filter chips step aside', () => {
    // **This one is the foundation of the "add it from Steam if the library has not got it"
    // feature.** Without stepping aside, "not found" means "hidden by your own filter" more than
    // half the time — measured, the three chips that start in the excluded state hide 171 of 316
    // games — so searching for a game already at 100% has the interface suggest **adding it
    // again**.
    // The way to break it is subtle: change the return to fall through and the table merely looks
    // like it "lost a few rows"
    const src = js();
    const i = src.indexOf('function hidingFilter');
    assert.ok(i > 0, 'cannot find hidingFilter — this check has lost its target rather than passed');
    const block = src.slice(i, src.indexOf('\n    }', i));
    const searchAt = block.indexOf('f.search');
    const chipLoop = block.indexOf('FILTERS.length');
    assert.ok(searchAt > 0, 'cannot find f.search inside hidingFilter');
    assert.ok(chipLoop > searchAt, 'the search has to be judged before the chip loop');
    // The search branch has to return on its own and must not fall through into the chip loop below
    const searchBranch = block.slice(searchAt, chipLoop);
    assert.match(searchBranch, /return/, 'with a search term it has to return on the spot rather than carrying on through the chips');
  });

  test('the keys of the chips and of the FILTERS table have to correspond one for one, in the same order', () => {
    // **Missing one on either side raises no error; it just "does nothing when clicked".** The
    // event is delegated to the container, so one extra chip in the markup still cycles colours —
    // there is simply no entry for it in the hidingFilter loop and not one table row moves.
    // Conversely, one extra row in FILTERS is a property whose state can never be read:
    // currentFilters only collects chips present in the markup, f[key] is undefined, which is
    // neither 'only' nor 'not', so it is silently continued past. **Both directions are silent**,
    // so this is the only place to pin it.
    //
    // The order is pinned along with it: the on-screen order is by frequency of use (the two people
    // want to "only see" first, the three that hide things at startup after), while the FILTERS
    // order decides which chip 「被谁挡住了」 names — and once they are out of step that sentence
    // points at an unrelated chip and says "click here"
    const src = js();
    const table = src.slice(src.indexOf('const FILTERS = ['), src.indexOf('const NEXT_STATE'));
    const inTable = [...table.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);
    const page = read('Dashboard.html');
    const chipsAt = page.indexOf('id="filterChips"');
    const inMarkup = [...page.slice(chipsAt, chipsAt + 3000).matchAll(/data-filter="([a-z]+)"/g)]
      .map((m) => m[1]);
    assert.ok(inTable.length >= 5, 'the FILTERS table read empty — this check has lost its target rather than passed');
    assert.deepEqual(inMarkup, inTable, 'the chips and FILTERS have to share names and order');
  });

  test('the three-state cycle runs neutral → only → excluded', () => {
    // **The direction is not arbitrary; reversed, the two most common actions each cost an extra
    // click.**
    // The three states form a ring and neutral has only one predecessor, so only one direction is a
    // single click. At startup favourite/family are neutral and the other three are excluded — the
    // next step for the former is usually "only", and for the latter "back to neutral" (unhide to
    // go find a game), and this direction makes both one click.
    // Arranged the other way both become two clicks, while **the table still works** and nothing
    // reports anything — merely dozens of extra clicks a day, exactly the kind of regression nobody
    // notices
    const src = js();
    const m = src.match(/const NEXT_STATE = \{([^}]+)\}/);
    assert.ok(m, 'cannot find NEXT_STATE');
    assert.match(m[1], /off:\s*'only'/, 'the next state after neutral has to be only');
    assert.match(m[1], /only:\s*'not'/, 'the next state after only has to be excluded');
    assert.match(m[1], /not:\s*'off'/, 'the next state after excluded has to be neutral');
  });

  test('the startup state: favourite and family neutral, the other three excluded', () => {
    // The default view has to be **line for line the same** as the checkbox version — the three
    // "hide" checkboxes were ticked by default, which is the excluded state. Changing this changes
    // the first screen everyone sees on opening the page, and it raises no error
    const page = read('Dashboard.html');
    const chipsAt = page.indexOf('id="filterChips"');
    const states = [...page.slice(chipsAt, chipsAt + 3000)
      .matchAll(/data-filter="([a-z]+)" data-state="([a-z]+)"/g)].map((m) => m[1] + ':' + m[2]);
    assert.deepEqual(states, ['fav:off', 'family:off', 'complete:not', 'unvetted:not', 'noach:not']);
  });

  test('whether the library has it must not decide whether to search Steam', () => {
    // **This case pins exactly the opposite of the previous version, and the previous version was a
    // bug.**
    // It used to say "if the library has it, stop there and do not look on Steam", and that rule
    // conflated two things: "found something" is not "found the thing you wanted". Someone wanting
    // to add Silksong types silk, the library happens to hold a Silkroad — and the add path
    // vanishes, **without it being visible that it vanished**.
    // The check stays, but it only decides how to display (expanded or folded into one line)
    const src = js();
    const i = src.indexOf('function onSearchInput');
    assert.ok(i > 0, 'cannot find onSearchInput');
    const block = src.slice(i, src.indexOf('\n    }', i));
    assert.match(block, /allGames\.some/, 'the "does it exist" check has to use the whole library, not the filtered rows');
    assert.match(block, /setTimeout/, 'the search has to be sent regardless');
    // There must be no return between "the library has it" and "send the request" — one there and
    // it is the blocking rule all over again
    const hitAt = block.indexOf('libHit =');
    const timerAt = block.indexOf('setTimeout');
    assert.ok(hitAt > 0 && timerAt > hitAt, 'the check first, the request after');
    // **Slice from the end of the assignment line, not from the start.**
    // `libHit = allGames.some(function(g){ return … })` carries a return of its own, so slicing
    // from the line start is fed by that callback — which is how the first version went falsely
    // red. What matters is whether there is a control-flow return between that line and the request
    const afterAssign = block.indexOf('\n', hitAt);
    assert.ok(afterAssign > 0 && afterAssign < timerAt, 'cannot find the end of the libHit line');
    assert.doesNotMatch(
      block.slice(afterAssign, timerAt),
      /\breturn\b/,
      'returning right after checking whether the library has it hides the add path all over again'
    );
  });

  test('when the library already has results, the Steam ones fold into one line', () => {
    // Ten expanded rows are about 370px, and this block lives in the frozen area — every filter of
    // your own library pushes ten table rows out of view in exchange for supplementary results the
    // user is most likely not looking for. The folded line exists to **keep "you can still add"
    // visible**
    const src = js();
    const i = src.indexOf('function renderSearchResults');
    assert.ok(i > 0, 'cannot find renderSearchResults');
    const block = src.slice(i, src.indexOf('\n    function ', i + 10));
    assert.match(block, /libHit && !steamExpanded/, 'the fold condition is "the library has it" and "it has not been opened"');
    assert.match(block, /steam-more/, 'that clickable line has to exist');
    // Expanding **must not send another request** — the results are already in hand
    assert.match(block, /renderSearchResults\(steamItems\)/, 'expanding repaints the cache rather than searching again');
    assert.doesNotMatch(block, /searchSteamGames/, 'the expand step should not touch rpc');
  });

  test('a Steam result is a button, not a div with a click handler', () => {
    // It is the only entry point for "add a game". As a div the mouse works and the keyboard cannot
    // reach it at all — tab skips it, Enter does nothing, and nothing reports any of that
    const src = js();
    const i = src.indexOf('function renderSearchResults');
    assert.ok(i > 0, 'cannot find renderSearchResults');
    const block = src.slice(i, src.indexOf('\n    }', i));
    assert.match(block, /<button type="button" class="game-search-result"/,
      'a result item has to be a button with an explicit type — the default submit would submit the page once it ends up inside a form');
  });
});

/**
 * The clear cross in the search box
 * ------------------------------------------------
 * This group guards **pressing it and nothing happening**: the cross is drawn, it can be clicked
 * and the value really is cleared, while not one character on screen changes. The page raises no
 * error and the cross looks fine.
 *
 * Two cases guard one end each, both silent:
 *
 * - **Whether it shows is pure CSS.** `:placeholder-shown` is the only criterion for "the box is
 *   empty", and it requires the box to always have a placeholder — replace the placeholder with a
 *   visible label (which this page does elsewhere) and the cross hangs on an empty box forever,
 *   doing nothing when pressed.
 * - **Clearing is JS.** The search box carries two input listeners while the filter box in the
 *   dialog carries its own oninput, and merely wiping the value runs neither: the table still shows
 *   search results and the Steam block is still open, while the input is empty.
 */
describe('the clear cross in the search box', () => {
  const page = () => read('Dashboard.html');
  /** The inline scripts with both kinds of comment removed — the comments contain these words, and leaving them feeds the assertions */
  const js = () => inlineScripts(page())
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  test('every input inside a .search-field keeps its placeholder, and every cross is there', () => {
    const fields = [...markupNoComments(page()).matchAll(/<div class="search-field">([\s\S]*?)<\/div>/g)];
    assert.ok(fields.length >= 2, 'cannot find .search-field — this check has lost its target rather than passed');
    for (const [, inner] of fields) {
      const input = inner.match(/<input[^>]*>/);
      assert.ok(input, 'a .search-field has to contain an input');
      assert.match(input[0], /\splaceholder="[^"]+"/,
        'the cross shows and hides via :placeholder-shown, and with no placeholder it hangs on an empty box forever');
      assert.match(inner, /class="field-clear"/, 'a .search-field has to contain that cross');
    }
  });

  test('the cross sits inside the box rather than after it', () => {
    // Placed after it, its appearing and disappearing nudges everything to the right, and the
    // search box lives in the frozen area where every keystroke recomputes the height.
    // **The inset padding has to be permanent too**: reserving the space only when there is text
    // makes the characters already typed jump left by one notch the instant the first one is typed
    const css = styleBlocks(page()).join(SEP).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.search-field\s*\{[^}]*position:\s*relative/, '.search-field has to be the positioning reference');
    assert.match(css, /\.field-clear\s*\{[^}]*position:\s*absolute/, 'the cross has to be absolutely positioned');
    const pad = css.match(/\.search-field input\s*\{([^}]*)\}/);
    assert.ok(pad, 'cannot find the rule reserving space for the cross — this check has lost its target rather than passed');
    assert.match(pad[1], /padding-right:/, 'the input has to permanently reserve the space for the cross on its right');
  });

  /** The whole binding passage: sliced from the start of the forEach to its own close, both real anchors */
  const bindBlock = () => {
    const src = js();
    const from = src.indexOf("document.querySelectorAll('.search-field').forEach");
    assert.ok(from > 0, 'cannot find the clear-cross binding — this check has lost its target rather than passed');
    const to = src.indexOf('\n    });', from);
    assert.ok(to > from, 'cannot slice the close of that passage');
    return src.slice(from, to);
  };

  test('clearing has to dispatch an input event rather than merely wiping the value', () => {
    assert.match(bindBlock(), /dispatchEvent\(\s*new Event\('input'/,
      'clearing has to dispatch an input event — calling those handlers by name misses one and gives "cleared but the results are still there"');
  });

  test('Esc is intercepted only when the box has text; with none it goes to the dialog to close it', () => {
    // On the filter box inside the dialog, Esc also means closing the whole dialog. An
    // unconditional stopPropagation makes an empty filter box swallow the dialog's exit — pressing
    // Esc does nothing, with no way to see why
    const block = bindBlock();
    const guard = block.indexOf("input.value === ''");
    const stop = block.indexOf('stopPropagation');
    assert.ok(guard > 0, 'the Esc guard has to check both the key name and whether the box has text');
    assert.ok(stop > guard, 'check for text first, and only intercept the Esc when there is some');
  });
});

describe('recently played: the badge and the pin share one window', () => {
  // **Each writing its own day count is a kind of broken that raises no error.** It presents as a
  // row sorting to the top with nothing on the row saying why — the user only thinks the sorting
  // is broken. CLAUDE.md writes this down as a rule, and before this test nothing stopped it.
  const js = () => inlineScripts(read('Dashboard.html'))
    .join(SEP)
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')   // **line comments before block comments**, see CLAUDE.md
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /** The body of a given function */
  const bodyOf = (src, name) => {
    const i = src.indexOf('const ' + name + ' = ');
    assert.ok(i > 0, `cannot find ${name} — this check has lost its target rather than passed`);
    return src.slice(i, src.indexOf('};', i));
  };

  test('the window is one number, written in one named constant', () => {
    // Two literals scattered in two places cannot be shared, and "shared" is exactly what this
    // group protects
    assert.match(js(), /const RECENT_PLAY_DAYS = \d+;/, 'the window has to be a named constant');
  });

  test('the badge reads that constant rather than a number of its own', () => {
    assert.match(bodyOf(js(), 'isRecentlyPlayed'), /RECENT_PLAY_DAYS/);
  });

  test('the pin builds on the badge and does not compute the day count again', () => {
    // **The pin may add conditions, but it must not open a second window.** The extra condition
    // (there are achievements to track) is a deliberate asymmetry: a badge without a pin makes
    // sense, a pin without a badge does not
    const pin = bodyOf(js(), 'pinsToTop');
    assert.match(pin, /isRecentlyPlayed\(/, 'the pin has to go through isRecentlyPlayed');
    assert.doesNotMatch(pin, /playedDaysAgo|RECENT_PLAY_DAYS/,
      'a day comparison should not appear inside the pin — that is a second window');
  });

  test('the pin also requires there really to be achievements to track', () => {
    // Blocking only 'N/A' is the same as blocking nothing: "no progress to look at" has three
    // shapes (N/A, null, 0), and null is the most common — a game just added to the library is
    // exactly both recently played and not yet synced for achievement counts
    assert.match(bodyOf(js(), 'pinsToTop'), /typeof g\.total === 'number' && g\.total > 0/);
  });
});

describe('the state mark on a filter chip', () => {
  // The difference between the three states rests entirely on this one 9x9 mark, and **breaking it
  // raises no error at all** — the page renders as usual, the filtering works as usual, and the
  // row scanned dozens of times a day merely starts reading as the wrong thing.
  const css = () => styleBlocks(read('Dashboard.html')).join(SEP).replace(/\/\*[\s\S]*?\*\//g, '');
  /** The mark passage: from .chip-dot to the next unrelated rule */
  const markBlock = () => {
    const s = css();
    const from = s.indexOf('.chip-dot {');
    const to = s.indexOf('input[type="text"] {', from);
    assert.ok(from > 0 && to > from, 'cannot find the mark passage — this check has lost its target rather than passed');
    return s.slice(from, to);
  };

  test('the excluded state is two opposed diagonal strokes, not one horizontal bar', () => {
    // **A horizontal bar means "partially selected", not "excluded".** HTML's indeterminate and
    // every system's half-checked box all draw a bar; the semantics of minus in an icon library
    // are subtract/decrease — "take some away". What this cell has to say is "take it out
    // entirely". One glyph carrying two opposite meanings makes the reader guess which, so it
    // became a cross.
    // **The way back to a bar is very quiet**: delete the ::after half of the rule and the one
    // stroke that remains is exactly a bar.
    const b = markBlock();
    const not = b.slice(b.indexOf('[data-state="not"]'));
    assert.match(not, /rotate\(45deg\)/, 'the excluded state needs one stroke rotated +45°');
    assert.match(not, /rotate\(-45deg\)/, 'the excluded state needs the other rotated -45° — one stroke alone is a bar again');
    assert.match(not, /\.chip-dot::before/, 'the first stroke');
    assert.match(not, /\.chip-dot::after/, 'the second stroke');
  });

  test('the second stroke has width 0 normally, or the neutral state grows an extra blob', () => {
    // ::after should be invisible in both the neutral and only states. A zero-width box draws
    // nothing, which is the only way to be "absent" here without an extra rule
    const b = markBlock();
    const base = b.slice(0, b.indexOf('[data-state='));
    assert.match(base, /\.chip-dot::after\s*\{[^}]*width:\s*0\b/,
      'the initial width of ::after has to be 0');
  });

  test('the glow of the lit state can only hang on the first stroke', () => {
    // **The spread of a box-shadow does not care whether the box has width.** Hung on the
    // zero-width ::after it draws a 6x8 rounded rectangle out of nowhere beside the dot — appearing
    // only in the "only" state, and looking like a rendering bug rather than a mistaken rule
    const b = markBlock();
    const rules = [...b.matchAll(/([^{}]+)\{([^}]*box-shadow:\s*0 0 0[^}]*)\}/g)];
    assert.ok(rules.length >= 1, 'cannot find the glow rule — this check has lost its target rather than passed');
    for (const [, sel] of rules) {
      assert.doesNotMatch(sel, /::after/, 'the glow must not hang on ::after: ' + sel.trim());
    }
  });

  test('with motion turned off, the mark must not still rotate', () => {
    // The mark now rotates 45°, which is exactly the kind of motion prefers-reduced-motion has to
    // turn off.
    // **The previous version of this rule selected .filter-chips** — the container has no
    // transition at all, so that rule never took effect from the day it was written, and it looked
    // entirely normal
    const s = css();
    const rm = s.slice(s.indexOf('@media (prefers-reduced-motion'));
    assert.ok(rm.length > 0, 'cannot find the reduced-motion passage');
    assert.match(rm, /\.chip-dot::before/, 'what has to be turned off is the transition on the pseudo-elements');
    assert.match(rm, /\.chip-dot::after/, 'both strokes have to be turned off');
    // Pinned in reverse: the transition really is on the pseudo-elements and not on the container —
    // otherwise the two assertions above run empty again
    assert.match(markBlock(), /\.chip-dot::before,\s*\n?\s*\.chip-dot::after\s*\{[^}]*transition:/,
      'the transition has to hang on the two pseudo-elements');
  });
});

describe('self-hosted fonts', () => {
  const FONT_CSS = 'assets/fonts/noto-sans-sc.css';

  for (const page of ['Dashboard.html', 'Setup.html']) {
    test(`${page} links the font stylesheet`, () => {
      assert.match(
        read(page),
        /<link[^>]+href="\/fonts\/noto-sans-sc\.css"/,
        `${page} does not link /fonts/noto-sans-sc.css — the page silently falls back to a system font`
      );
    });

    test(`--font-ui in ${page} puts the bundled font first`, () => {
      // Keeping the fallback stack is right, but the bundled one has to come first, or a machine
      // with Segoe UI installed still uses a system font and self-hosting was for nothing
      const m = read(page).match(/--font-ui:\s*([^;]+);/);
      assert.ok(m, `the :root of ${page} has no --font-ui`);
      assert.match(m[1].trim(), /^"Noto Sans SC Variable"/,
        `--font-ui in ${page} does not put the bundled font first: ${m[1].trim()}`);
    });
  }

  test('the font stylesheet exists, and every woff2 slice is there', () => {
    const css = read(FONT_CSS);
    const urls = [...css.matchAll(/url\(\.\/([^)]+\.woff2)\)/g)].map((m) => m[1]);
    assert.ok(urls.length > 50, `the slice count looks wrong (${urls.length}); Noto Sans SC should have around 100`);
    const missing = urls.filter((u) => !existsSync(join(ROOT, 'assets', 'fonts', u)));
    assert.deepEqual(missing, [],
      `the files these @font-face rules point at do not exist, and the corresponding characters silently fall back to a system font: ${missing.slice(0, 5).join(', ')}`);
  });

  test('the OFL requires the licence file to be shipped alongside', () => {
    assert.ok(existsSync(join(ROOT, 'assets', 'fonts', 'LICENSE')),
      'Noto Sans SC is OFL-1.1, the licence requires LICENSE to be shipped with it, and this repository is public');
  });

  test('the packaging filter includes assets/ (missing it breaks only the packaged build)', () => {
    const pkg = JSON.parse(read('launcher/package.json'));
    const filter = pkg.build.extraResources[0].filter;
    assert.ok(filter.includes('assets/**/*'),
      'the extraResources filter in launcher/package.json has no assets/**/*, '
      + 'so the packaged build has no font — while npm start is fine throughout, which is why this omission goes unnoticed');
  });
});


/**
 * The writing-mode cell. **The default has to be the deep mode** — the fast tier was measured
 * writing 9 of 16 entries as template sentences (「第 III 章全体查证正确即解锁」), and that is more
 * than half the entries of a guide. A default drifting to fast raises no error; it merely makes
 * every new guide quietly thinner.
 */
describe('the wording in the confirmation dialog', () => {
  const dash = read('Dashboard.html');
  const markup = markupNoComments(dash);
  const js = inlineScripts(dash).join('\n').replace(/\/\/[^\n]*/g, '');

  // **Pull the function out and actually run it; do not grep for `value: 'high'`.**
  // The first version did exactly that and could never fail — the option list itself contains a
  // `{ value: 'high', label: '高' }`, the regex matched that one, and changing the default to low
  // stayed green. Mutation testing caught it. This function has no dependencies, and pulling it out
  // and executing it is the only way to be sure
  const effortChoice = (() => {
    const at = js.indexOf('function effortChoice');
    const end = js.indexOf('\n    }', at) + '\n    }'.length;
    return new Function(js.slice(at, end) + '; return effortChoice;')();
  })();

  test('the default is the deep mode, and there are only two tiers', () => {
    assert.equal(effortChoice().value, 'high',
      'the fast tier writes more than half the entries as template sentences — a default drifting there raises no error and quietly thins the guide');
    // **medium must not come back on screen.** In the same measurement it is indistinguishable from
    // high (both 0 template sentences, the time difference inside the noise), and putting it up
    // makes people stop and weigh a choice with no measurable difference, where the only honest
    // description is "these two are the same". config.json still accepts it; this is only about the screen
    assert.deepEqual(effortChoice().options.map((o) => o.value), ['low', 'high'],
      'the order is content too: left to right is cheap to deep, and reversing it makes people pick the wrong one by position');
    assert.equal(effortChoice().label, '写法');
  });

  test('each tier says plainly what picking it loses', () => {
    // The names 「极速模式/深度模式」 explain nothing by themselves — without this sentence,
    // someone wanting to save money does not know what is being saved, and that is the only
    // question this cell has to answer
    for (const o of effortChoice().options) {
      assert.ok(o.hint && o.hint.length > 8, `${o.label} has no description`);
    }
    // The fast one's sentence has to name **template sentences**. That is the only cost the whole
    // A/B measured (9 of 16), and the only thing they need to know before choosing; softening it
    // into something like "the content is a little worse" is the same as saying nothing
    const low = effortChoice().options.find((o) => o.value === 'low');
    assert.match(low.hint, /模板/,
      'the concrete cost of saving is "it becomes template sentences" — said softly it cannot help anyone decide');
  });

  test('the selected state has to be reported, and written in both places', () => {
    // ui-ux-pro-max lists this as Critical: a compact control has to expose pressed/selected state.
    // **Checking only that it "appears" is not enough** — the initial render and the click-to-change
    // each write one, and deleting either stays green, which is exactly what "reported once and
    // never updated" looks like. Mutation testing caught it
    const at = js.indexOf('function askConfirm');
    const body = js.slice(at, js.indexOf('\n    }', at));
    const writes = (body.match(/aria-pressed/g) ?? []).length;
    assert.ok(writes >= 2,
      `askConfirm writes aria-pressed in only ${writes} place. The initial render and the click-to-change both have to write it, `
      + 'and one missing is "reported but never updated", which misleads more than not reporting at all');
  });

  test('every button of the view switch reports its selected state', () => {
    // **Check them one by one, not "one of them has it so it passes"** — the one missed is the one
    // that never reports its state
    const btns = markup.match(/<button[^>]*data-view[^>]*>/g) ?? [];
    assert.ok(btns.length >= 2, 'the view-switch buttons are gone');
    for (const b of btns) {
      assert.match(b, /aria-pressed/,
        `this button does not report its selected state: ${b} — two segmented controls on one page, one reporting and one not, is worse than neither`);
    }
  });

  test('the tier chosen really travels with the request', () => {
    // The control is built and the value is not passed down — everything looks fine on screen while
    // every run still uses the default tier
    assert.match(js, /startGuideGen\(appid, false, choice\.value\)/, 'the generate path');
    assert.match(js, /startGuideGen\(appid, true, rewriteChoice\.value, scope\)/, 'the rewrite path');
  });

  test('the scope of a partial rewrite really travels with the request, and is exclusive with the whole guide', () => {
    // The scope is chosen and the value is not passed down, presenting as a full rewrite every time
    // — which is exactly the thing this feature exists to avoid, carrying a 「已改 N 条」 success
    // notice with it. Everything looks fine on screen
    assert.match(js, /scopeChoice\.value === 'all'\s*\n?\s*\?\s*null/,
      'choosing 「整篇」 has to pass null rather than a scope whose selector is all — '
      + 'the server branches on whether scope is empty, and giving both makes "which one ran" depend on the order of the checks');
    assert.match(js, /note: noteInput\.value/, 'the instruction has to be passed down too, or the input box is decoration');
  });

  test('Enter must not bypass the three gates in this dialog', () => {
    // This dialog now has two input boxes (「怎么改」 and the picker filter), and the interface is
    // in Chinese: every candidate selection while typing presses Enter. Without blocking it,
    // typing 「把互斥关系写清楚」 would confirm this costly and irreversible operation mid-sentence.
    //
    // **The assertion pins the intent, not the spelling** — the previous version checked for the
    // literal `askInput`, and replacing `document.getElementById('askInput')` with a local variable
    // turned it red even though the rule had not changed by one word
    const fn = js.slice(js.indexOf('function onKey'));
    const body = fn.slice(0, fn.indexOf('\n        }')).replace(/\/\/[^\n]*/g, '');
    assert.match(body, /isComposing/, 'an Enter during composition has to be blocked');
    assert.match(body, /e\.target ===/, 'it has to distinguish by where the focus is: the person is still typing in an input, not deciding');
    assert.match(body, /okBtn\.disabled/,
      'Enter has to be blocked while the confirm button is gated — otherwise "picked but nothing ticked" can be bypassed with the return key');
  });

  test('with pick chosen and nothing ticked, the confirm button is gated', () => {
    // Sending an empty selection = a request that can select no achievement, and it is only refused
    // at the server. The gate belongs on the button: let the person **see** why it cannot be
    // pressed, rather than pressing it and receiving an error
    assert.match(js, /pickerShown\(\)\s*&&\s*o\.picker\.selected\.size === 0/,
      'an empty selection has to make the confirm button unclickable');
    // This dialog reuses the same DOM, and without an unconditional reset the next dialog with no
    // picker opens unclickable, with nothing to explain why it cannot be pressed
    const sync = js.slice(js.indexOf('function syncPicker'));
    assert.match(sync.slice(0, sync.indexOf('\n        }')), /refreshOk\(\)/,
      'refreshOk has to run unconditionally, and is what resets the disabled left over from last time');
  });

  test('the "plan only" shortcut in planPatch checks for null, not falsiness', () => {
    // This is pinned on the source because triggering it needs Steam and Notion. `if (!selector)`
    // sends a user-typed `--only ""` down the internal shortcut too, returning scope: null, and the
    // caller immediately reads .apiNames and crashes — a user error with its own error code and
    // terminal advice turns into an incomprehensible TypeError
    const src = readFileSync(new URL('../lib/guidepatch.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.match(src, /if \(selector === null \|\| selector === undefined\)/,
      'the internal shortcut has to accept only null/undefined — an empty string is a user error and should still throw empty-scope');
  });

  test('what pick sends is a list of api_names, not achievement names', () => {
    // Identically named achievements cannot be selected by name (the library really holds 12 such
    // pairs), and using names has the request judged unresolved at the server — while the interface
    // plainly just ticked it
    assert.match(js, /selector: \[\.\.\.picker\.selected\]\.join\(','\)/,
      'what is selected are api_names, joined with commas straight into an explicit list for resolveScope');
  });

  test('a filter pill changes only the display and does not touch the selection by one character', () => {
    /**
     * **This is the core invariant of this cell, and what killed each of its two previous versions.**
     *
     * One version was a "bulk select" switch: lit meant "this batch is already all in the
     * selection" — a derived fact the user read as "I pressed this key". The properties intersect
     * (the one locked achievement happened to be rare too), so pressing 「稀有」 lit 「未解锁」 as
     * well, and pressing that one dimmed 「稀有」 again.
     *
     * The second version became "add to the selection once, carrying no state": the chaining was
     * gone, but it could only do unions — 「既稀有又没打的」 cannot be expressed, leaving 22 entries
     * to be selected and then deselected one by one.
     *
     * Now it is a filter. **As long as it does not touch selected, the pressed state is honest
     * again** (it means "I pressed this filter"), and the intersection comes free: both pills
     * pressed is an AND. So what is pinned here is not a spelling but that boundary — once sel
     * appears in the handler, version one's chaining has a way back.
     */
    const fn = js.slice(js.indexOf('function paintFilters'));
    const body = fn.slice(0, fn.indexOf('\n        }')).replace(/\/\/[^\n]*/g, '');
    assert.match(body, /active\.(add|delete)/, 'a click toggles the filter state');
    // Both `sel` and `selected` have to be blocked. The first version wrote only `\bsel\b`, and the
    // most natural way to break it in mutation testing (`o.picker.selected.add(...)`) walked right
    // past it — `\b` does not hold after the sel in "selected". **Pinning only a local variable
    // name pins only one spelling**
    assert.doesNotMatch(body, /\bsel(ected)?\b/, 'a filter must not touch the selection — touching it makes it "bulk select" again');
    assert.match(body, /aria-pressed/, 'it really is a switch now (a filter switch) and has to report its pressed state');

    // Taking that batch is another button's job, and what it takes has to be **the batch on screen**
    assert.match(js, /pickAll\.onclick/, 'there has to be a select-all');
    assert.match(js, /shownItems\(\)\.forEach/, 'select-all takes the batch that is displayed');
    assert.match(js, /pickClear\.onclick/, 'there has to be a clear');
    assert.match(js, /o\.picker\.selected\.clear\(\)/, 'clear has to really clear');
  });

  test('what the list draws and what select-all takes share one criterion', () => {
    // Writing the filter condition twice makes 「全选」 quietly take things that are not on screen —
    // and the next step costs money and is irreversible. So shownFilter() is the single criterion,
    // used by both the list and shownItems
    assert.equal((js.match(/function shownFilter\(\)/g) ?? []).length, 1);
    assert.match(js, /const ok = shownFilter\(\);/, 'the list uses it');
    assert.match(js, /return pickerItems\(\)\.filter\(shownFilter\(\)\);/, 'the select-all batch uses it too');
    assert.match(js, /g\.items\.filter\(ok\)/, 'every section filters by the same criterion');
  });

  test('ticking one entry has to update 「已选 N 条」', () => {
    /**
     * This pins a bug that **really happened**: the count was written only at the end of
     * `paintPicker`, while ticking a single entry deliberately does not repaint the whole list (a
     * repaint bounces the scroll position back to the top), so that line was stuck at the value
     * from the last full repaint.
     *
     * Catching it took comparing the number of boxes really ticked in the DOM against the number
     * displayed — the interface alone shows nothing, and that line looks perfectly fine.
     * That number is now the only thing on screen saying how many are selected (the confirmation
     * body has been deleted entirely), so there is even less to check it against
     */
    assert.match(js, /function paintCount\(\)/,
      'the count has to be its own function before the single-tick path can possibly call it');
    const handler = js.slice(js.indexOf("cb.addEventListener('change'"));
    const body = handler.slice(0, handler.indexOf('\n              });')).replace(/\/\/[^\n]*/g, '');
    assert.match(body, /paintCount\(\)/, 'ticking one entry has to refresh the count');

    // The scope is left with one genuine either-or
    const scope = js.slice(js.indexOf('const scopeChoice = {'));
    const opts = scope.slice(0, scope.indexOf('\n      };'));
    assert.match(opts, /value: 'all'/);
    assert.match(opts, /value: 'pick'/);
    assert.doesNotMatch(opts, /'rare'|'locked'|'failing'/,
      'the computed batches are no longer scope tiers — they are shortcuts inside the list');
  });

  test('the rewrite confirmation writes no body', () => {
    /**
     * Four rounds of deletion left not one sentence, and every one of them restated something
     * already on screen: the duration (measured, the same input took 76/174/337 seconds, so writing
     * one down is simply wrong), 「现有 51 个 checkbox 会被整份替换」 (「整篇」 already says it),
     * 「只改选中的 27 条」 (「已选 27 条」 is right beside it), 「原文先备份」 (our own safety net,
     * not something they decide), and finally 「N 个手动勾的子步骤会变回未勾选」 — which 「重写」
     * implies by itself, and the backup is there anyway.
     *
     * **The loss is not unmentioned; it is mentioned elsewhere:** the CLI's `formatPreflight` still
     * prints the hand ticks that will be lost, one by one (guideoverwrite.test.js pins that). A
     * command line is for someone who typed a flag and can afford detail; the interface has to be
     * short — one set of wording forced to serve both suits neither.
     */
    const call = js.slice(js.indexOf("title: '重写《'"));
    const args = call.slice(0, call.indexOf('\n      });')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(args, /picker: picker/, '(first confirm the slice really is the rewrite dialog)');
    assert.doesNotMatch(args, /body:/, 'the scope, the count and the instruction are all on controls; a body could only restate them');
  });

  test('the rare threshold comes from the server; the frontend does not write its own 15', () => {
    // The batch marked "rare" on screen has to be the same line the prompt uses to judge which
    // entries to write deeply. Two places each writing a number drift with nobody noticing — it
    // presents only as "the interface calls it rare and the program does not"
    assert.match(js, /sc && sc\.rarePct/, 'the threshold comes from the previewGuidePatch return value');
    assert.match(js, /o\.picker\.rarePct/, 'entry colouring uses the same value');
  });

  test('a dialog with no body collapses that cell rather than leaving a blank', () => {
    // The rewrite dialog now writes no body at all, and #askBody is permanent markup — clearing
    // only its textContent leaves an empty div with margins, and the dialog looks like a rendering
    // fault.
    //
    // The other half is pinned along with it: a dialog that does have a body (delete, migrate)
    // still shows it. askConfirm has six call sites and both branches have users
    assert.match(js, /bodyEl\.textContent = o\.body \|\| ''/);
    assert.match(js, /bodyEl\.style\.display = o\.body \? '' : 'none'/);
  });

  test('the confirmation no longer hardcodes a duration', () => {
    // The same input measured 76/174/337 seconds, and with the writing mode selectable the fast
    // tier is eight times quicker — any hardcoded range promises something that cannot be given.
    // The duration is on the progress bar
    const noBlockComments = js.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(markup + noBlockComments, /约 \d[–-]\d 分钟/, 'this sentence becomes wrong on the spot at the low tier');
  });
});

/**
 * Switching vendors: each remembers its own key and model.
 *
 * Source assertions, for the same reason as the two `loadAiState` ones — this logic lives in the
 * page script, there is no DOM with zero dependencies, and a unit test cannot reach it. Both aim at
 * **silent** failures: nothing is reported on error, the thing is merely turned into a different
 * thing.
 */
describe('switching AI vendor', () => {
  /** Code only: both kinds of comment are stripped, or the comment explaining the rule feeds the assertion */
  const setupJs = () =>
    inlineScripts(read('Setup.html'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  /** Slice the body of paintAiProvider. **Use real anchors, not a byte count** — a window drifts quietly as the content grows */
  const paintBlock = () => {
    const js = setupJs();
    const i = js.indexOf('function paintAiProvider');
    assert.ok(i > 0, 'cannot find paintAiProvider');
    const j = js.indexOf("$('ai-provider').addEventListener('change'", i);
    assert.ok(j > i, 'cannot find the change listener after paintAiProvider — the lower bound of the slice is gone');
    return js.slice(i, j);
  };

  test('the option label is repainted from dataset.label, not from the current textContent', () => {
    // A plain `opt.textContent += ' · 已配置'` is right the first time and **stacks on the second
    // repaint**: 「DeepSeek · 已配置 · 已配置」. And the repaint happens on every vendor switch, so
    // this is a failure that appears after two uses while reporting nothing
    const block = paintBlock();
    assert.match(block, /opt\.dataset\.label/, 'the base label has to live in dataset');
    assert.match(block, /opt\.textContent = /, 'the repaint is a whole assignment, not an append');
    assert.doesNotMatch(block, /textContent\s*\+=/, 'appending stacks the marker up one repaint at a time');
  });

  test('each vendor own model is painted back into the input', () => {
    // Like the key, model is one value per vendor (see ai.providers in lib/config.js). Without
    // painting it, switching back leaves the previous vendor's model name in the box, and
    // submitting writes it into this vendor's slot — where a claude-* sent to Gemini is stopped by
    // assertModelMatchesProvider, reporting "the model and the vendor do not match", which points
    // nowhere near "this value was left behind by the switch"
    assert.match(paintBlock(), /\$\('ai-model'\)\.value = cur\?\.model/);
  });

  test('switching vendor first clears the key already typed in', () => {
    // **This is the only one here that writes bad data.** Type half a Gemini key and switch back to
    // Anthropic, and without clearing, that string is stored as the Anthropic key. It is certain to
    // be wrong, and what is reported is a failed validation, pointing nowhere near the real cause
    // of "you just switched vendor"
    const js = setupJs();
    const i = js.indexOf("$('ai-provider').addEventListener('change'");
    assert.ok(i > 0, 'cannot find the change listener on the vendor dropdown');
    const block = js.slice(i, js.indexOf('});', i));
    assert.match(block, /\$\('ai-key'\)\.value = ''/, 'switching vendor has to clear the key in the input');
    assert.match(block, /paintAiProvider\(\)/, 'after clearing it has to repaint, or the state stays on the previous vendor');
  });

  test('the 「已配置」 on the step heading asks whether this step is done, not whether the current vendor is configured', () => {
    // Anthropic configured while sitting on Gemini plainly means the step was done. Written as
    // `!cur?.hasKey`, switching to an unconfigured vendor marks the whole step unconfigured — which
    // looks like the configuration was lost
    assert.match(paintBlock(), /\$\('ai-set'\)\.hidden = !Object\.values\(aiProviders\)/);
  });
});

/**
 * The API key placeholder changes with the vendor.
 *
 * Once the three vendors share one input, "pasting the Anthropic key into the Gemini field" is a
 * mistake this revision **newly created**, and a hardcoded `sk-...` is wrong for two of the three —
 * far from stopping it, it endorses the mistake. Reported by a user.
 */
describe('the AI key placeholder', () => {
  const html = read('Setup.html');

  test('the static markup hardcodes no vendor shape', () => {
    // For the instant before the JS starts, empty is better than wrong. Hardcoding one means two
    // vendors are being lied to
    const step = stepBlock(html, 2);
    const m = step.match(/<input[^>]*id="ai-key"[^>]*>/);
    assert.ok(m, 'cannot find the ai-key input');
    assert.doesNotMatch(m[0], /placeholder=/, 'the ai-key placeholder is filled in per vendor by paintAiProvider');
  });

  test('all three have their own shape, and they differ from one another', () => {
    const js = inlineScripts(html)
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const i = js.indexOf('const AI_KEY_HINT');
    assert.ok(i > 0, 'cannot find AI_KEY_HINT');
    const block = js.slice(i, js.indexOf('}', i));

    const hints = [...block.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(hints.map((h) => h[0]).sort(), ['anthropic', 'deepseek', 'gemini']);
    assert.equal(
      new Set(hints.map((h) => h[1])).size, hints.length,
      'two vendors share one shape — exactly what this test exists to prevent'
    );
    // An Anthropic key starts with sk-ant- and a DeepSeek one only with sk-. One is a prefix of the
    // other, so "both start with sk-" is not a distinction; the whole strings have to differ
    assert.equal(Object.fromEntries(hints).anthropic, 'sk-ant-...');
    assert.equal(Object.fromEntries(hints).gemini, 'AIza...');
  });

  test('the shape is only a hint and is never used to validate anywhere', () => {
    // Recognising a prefix = rejecting a perfectly good key the next time the vendor changes its
    // format, with the error saying "the key is invalid" and pointing at something entirely
    // correct. The Notion field settled that rule back then
    const all = read('Setup.html') + readFileSync(join(ROOT, 'lib', 'api.js'), 'utf8');
    const noComments = all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(
      noComments,
      /startsWith\(\s*'(sk-|AIza)/,
      'validating an API key by prefix — the day the vendor changes format it rejects a good key'
    );
  });
});

describe('guide backups: one number has exactly one repaint path', () => {
  // The number in 「备份 N」 renders in two places: the button at the end of the row (in the HTML
  // string `render()` assembles) and the summary line in the dialog (`paintArchive()`). Repainting
  // only one after a deletion leaves the two numbers contradicting each other on the same screen,
  // and without a page refresh they never agree again — measured: the dialog said 「1 份」 while the
  // row still said 「备份 2」.
  //
  // This is an old ailment of this project (see the `paintCount` entry in CLAUDE.md: 「已选 N 条」
  // once sat silently at the value from the last full repaint). So both actions have to go through
  // the same refreshArchives.
  //
  // **Comments have to be stripped first** — the passage above names `render()` and `paintArchive`
  // in full, and without stripping, the assertion passes with the code deleted; this very file has
  // been bitten by that
  const src = read('Dashboard.html')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('refreshArchives repaints all three: the index, the dialog and the table', () => {
    const fn = src.slice(
      src.indexOf('async function refreshArchives'),
      src.indexOf('async function loadArchiveIndex')
    );
    assert.ok(fn.length > 0 && fn.length < 600, 'what was sliced should be the refreshArchives passage');
    assert.match(fn, /loadArchiveIndex\(\)/, 'without re-fetching the index, the number on the row is still the old one');
    assert.match(fn, /paintArchive\(\)/, 'without repainting the dialog, the list is still the old one');
    assert.match(fn, /render\(\)/, 'without repainting the table, the 「备份 N」 at the end of the row is still the old one');
  });

  test('no repaint while editing — render() would replace the number input being typed in, focus and all', () => {
    const fn = src.slice(
      src.indexOf('async function refreshArchives'),
      src.indexOf('async function loadArchiveIndex')
    );
    assert.match(fn, /editingAppid === null/);
  });

  test('both delete and overwrite go through refreshArchives, with neither bypassing it', () => {
    const block = src.slice(src.indexOf('function arcRow'), src.indexOf('function paintArchive'));
    assert.ok(block.length > 0, 'what was sliced should be arcRow');
    assert.equal(
      (block.match(/refreshArchives\(\)/g) || []).length, 2,
      'once for overwrite and once for delete — one missing and the two numbers on that path split apart'
    );
    assert.doesNotMatch(block, /await loadArchiveIndex\(\);\s*paintArchive\(\)/,
      'writing those two lines by hand bypasses refreshArchives, and the table is not repainted with it');
  });

  test('setGuideBusy repaints too — the greying is rendered, so anything that changes it has to repaint', () => {
    const fn = src.slice(
      src.indexOf('function setGuideBusy'),
      src.indexOf('async function refreshArchives')
    );
    assert.ok(fn.length > 0 && fn.length < 600);
    assert.match(fn, /render\(\)/);
    assert.match(fn, /editingAppid === null/);
  });
});

describe('greying and the backup count: every exit has to clean up after itself', () => {
  // `guideBusy` decides whether 「重写」 and 「Notion」 on a row are greyed, and the greying is
  // **rendered**. It used to be `btn.disabled = true` hung on the DOM node, which one
  // `loadDashboard()` repaint cleared along the way — that automatic sweeping disappeared with the
  // move to rendering, so any exit that does not explicitly release it leaves that row stuck grey
  // until the page is refreshed. The success path is the one that never released it (it did not
  // need to), so this bug happened to grow on the most travelled path.
  //
  // The same set of exits has each just produced an archive (a rewrite stores the original in
  // .backups/, a migration puts the original in .migrated/), so the 「备份 N」 at the end of the row
  // has to be re-fetched as well — 「重写完想反悔」 is exactly when it is most needed.
  //
  // **The comments have to be stripped first**: this passage and the ones beside the code name
  // setGuideBusy and refreshArchives in full, and without stripping, the assertion passes with the
  // code deleted
  const src = read('Dashboard.html')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const fetchGen = () => {
    const a = src.indexOf('function fetchGen()');
    const b = src.indexOf('fetchGen();', a + 20);
    assert.ok(a > 0 && b > a, 'cannot slice fetchGen');
    return src.slice(a, b);
  };

  test('a generation or rewrite finishing: release the greying and re-fetch the backup count', () => {
    const fn = fetchGen();
    assert.match(fn, /setGuideBusy\(f\.appid, false\)/,
      'without releasing it, the rewrite button on that row stays grey until the page is refreshed');
    assert.match(fn, /refreshArchives\(\)/,
      'this rewrite has just stored an original, and the 「备份 N」 at the end of the row has to appear');
    assert.match(fn, /loadDashboard\(\)/,
      'the guide is registered, so the 「📖 攻略」 link has to appear');
  });

  // Success, failure and failed validation — the three exits are now **collected in one place**:
  // the server piles all three into `finished` and the page takes them as given. It used to be
  // written once for success and once for failure, which is exactly the shape described at the top
  // of this describe (two places where sooner or later only one is changed, and the missed one
  // leaves the row permanently grey)
  test('a failure releases the greying too, and the wrap-up can exist in only one place', () => {
    const fn = fetchGen();
    assert.equal((fn.match(/setGuideBusy\(/g) || []).length, 1,
      'a wrap-up written in two places will sooner or later be changed in only one');
    assert.match(fn, /fresh\.forEach\([\s\S]{0,80}setGuideBusy\(f\.appid, false\)/,
      'the appid comes from that entry in the server snapshot — on a failure there is no result to take it from');
  });

  // **This one is the bug itself.** When generating from a queue, one finishing and the next
  // starting are separated by a single microtask while the page polls every three seconds — so
  // every poll sees running as true. A wrap-up written after the `if (s.running)` return can never
  // execute: the table does not refresh, the guide link does not appear, and that row stays grey,
  // which looks like "the first one finished but the interface did not react"
  test('collect what has finished first, then look at what is running now', () => {
    const fn = fetchGen();
    const drain = fn.indexOf('s.finished');
    const running = fn.indexOf('if (s.running)');
    assert.ok(drain > 0, 'finished has to be collected from the server snapshot');
    assert.ok(running > 0, 'what was sliced should be fetchGen');
    assert.ok(drain < running,
      'while queued, running is permanently true, so a wrap-up placed after it never gets its turn');
  });

  test('a successful move to Notion: release the greying and re-fetch the backup count', () => {
    // **Slice inside the successHandler, and count the occurrences.** The first version sliced the
    // whole rpc chain, so the identical `setGuideBusy(appid, false)` inside failureHandler fed the
    // assertion — deleting the one on the success path stayed green. Mutation testing caught it on
    // the spot, and this file keeps producing exactly this shape (see the entries at the top).
    // migrate is **two nested rpc calls** (previewGuideToNotion first, then migrateGuideToNotion),
    // so search backwards from the inner call for its own successHandler rather than forwards from
    // the outer one
    const call = src.indexOf('.migrateGuideToNotion(appid)');
    const a = src.lastIndexOf('.withSuccessHandler(function (r)', call);
    const fn = src.slice(a, src.indexOf('.withFailureHandler', a));
    assert.ok(fn.length > 0 && fn.length < 3000, 'what was sliced should be the success handling of migrate');
    assert.equal(
      (fn.match(/setGuideBusy\(appid, false\)/g) || []).length, 2,
      'two places: the early return on r.error and the real success — one missing leaves a path that sticks the button grey'
    );
    assert.match(fn, /refreshArchives\(\)/, 'the move has just put the original into .migrated/, so the backup count changed');
  });

  test('do not paint the dialog when it is not open — refreshArchives is called by finished tasks', () => {
    const fn = src.slice(
      src.indexOf('async function refreshArchives'),
      src.indexOf('async function loadArchiveIndex')
    );
    assert.match(fn, /arcModal\.classList\.contains\('show'\)/,
      'without that check, a finished rewrite paints the dialog as the list of the game last looked at');
  });
});

describe('the two backup actions on the generation-succeeded screen', () => {
  // After 「读一遍确认没问题」 there are only two conclusions, so there have to be two actions:
  // this version is fine → delete the old one; this version is worse → go back to the old one.
  // **With only the delete, at the moment they are most likely to want to go back, the only button
  // on screen destroys the means of going back.** The moment they are needed is the moment the
  // guide was just opened, so they sit beside 「打开攻略」 — anywhere else means "tidy up later",
  // and later mostly never comes.
  //
  // Strip the comments first: the comments beside the code below name backup and
  // deleteGuideArchive in full
  const src = read('Dashboard.html')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('with no backup neither action appears — a whole new generation has no old copy to store', () => {
    assert.equal((src.match(/r\.backup && r\.backup\.id/g) || []).length, 2,
      'each action has to check once; without the check the new-generation screen shows buttons bound to fail');
  });

  test('both follow 「打开攻略」 into the title line, with restore before delete', () => {
    // **Both branches have to concatenate them**: the title line has a partial-rewrite form and a
    // full-generation form, and asserting it appears once stays green after deleting the
    // concatenation in one of them — mutation testing caught that.
    // The order is pinned too: what can be undone comes first, the irreversible one last
    assert.equal(
      (src.match(/where \+ restoreBackup \+ dropBackup/g) || []).length, 2,
      'both the partial-rewrite and the full-generation titles have to carry these two, with restore before delete'
    );
    const i = src.indexOf('const dropBackup');
    const j = src.indexOf('where + restoreBackup + dropBackup');
    assert.ok(i > 0 && j > i, 'compute first, use after');
    assert.ok(src.indexOf('const restoreBackup') < i, 'restore has to be computed before delete');
  });

  test('restore is a two-click too, and the second click states the backend-specific consequence', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-restore-backup]')"),
      src.indexOf("querySelectorAll('[data-drop-backup]')")
    );
    assert.ok(fn.length > 0 && fn.length < 3000, 'what was sliced should be that handler');
    assert.match(fn, /if \(!armed\)/, 'the first click only arms and does not overwrite');
    assert.match(fn, /data-restore-label/,
      'the second click label has to state the consequence, computed by backend at render time — checking again inside the handler will sooner or later be changed in only one place');
    assert.match(fn, /restoreGuideArchive\(/);
  });

  test('that consequence sentence branches by backend, and Notion has to say 「整页重写」', () => {
    // On the Notion side the whole page's blocks are **deleted first and written back**, which is
    // not the same as overwriting a local file, and saying it the same way leaves the user not
    // knowing what they are approving before they press
    const i = src.indexOf('const restoreBackup');
    const seg = src.slice(i, src.indexOf('const dropBackup'));
    assert.match(seg, /整页重写/, 'the Notion branch');
    assert.match(seg, /覆盖本地文件/, 'the local branch');
    assert.match(seg, /r\.target === 'notion'/, 'chosen by backend rather than one hardcoded sentence');
  });

  test('after a restore, remove 「删除备份」 — what it points at is no longer the copy meant to be deleted', () => {
    // After a restore the old version is the source of what is live, and what they want to delete is
    // most likely the new version that was just displaced.
    // Leaving that button there only deletes the wrong copy
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-restore-backup]')"),
      src.indexOf("querySelectorAll('[data-drop-backup]')")
    );
    assert.match(fn, /\[data-drop-backup\][\s\S]*?remove\(\)/);
    assert.match(fn, /refreshArchives\(\)/, 'the 「备份 N」 at the end of the row changed');
    assert.match(fn, /loadDashboard\(\)/, 'the registration may flip from notion back to local, so the link has to change with it');
  });

  test('two clicks: the first turns it into the consequence sentence, and only the second really deletes', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-drop-backup]')"),
      src.indexOf("querySelectorAll('[data-reveal]')")
    );
    assert.ok(fn.length > 0 && fn.length < 2500, 'what was sliced should be that handler');
    assert.match(fn, /if \(!armed\)/, 'the first click only arms and does not delete');
    assert.match(fn, /'永久删除'/, 'the second click label states the consequence, not 「确定」');
    assert.match(fn, /deleteGuideArchive\(/);
  });

  test('repaint after deleting — the 「备份 N」 at the end of the row has to go down by one', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-drop-backup]')"),
      src.indexOf("querySelectorAll('[data-reveal]')")
    );
    assert.match(fn, /refreshArchives\(\)/,
      'without repainting, the backup is gone while the row still says it is there');
  });

  test('after deleting, no still-clickable button is left behind', () => {
    const fn = src.slice(
      src.indexOf("querySelectorAll('[data-drop-backup]')"),
      src.indexOf("querySelectorAll('[data-reveal]')")
    );
    assert.match(fn, /'备份已删'/, 'once deleted it has no object left');
  });
});

describe('the guide backups on the setup page are collapsed', () => {
  const html = read('Setup.html');
  const css = styleBlocks(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

  test('the whole section is a <details>, collapsed by default', () => {
    assert.match(html, /<details id="guide-archive" hidden>/,
      'expanded it takes the whole screen and pushes out what is actually used below');
    assert.doesNotMatch(html, /<details id="guide-archive"[^>]*\sopen/, 'it should not be open by default');
  });

  // The expand triangle of a `<summary>` is drawn by `display: list-item`, and changing it to
  // flex / block / grid makes it disappear on the spot — and this page has no icon sprite to take
  // over, so with the triangle gone nothing indicates whether it is expanded. Hit once: the
  // computed display was flex and the marker went with it
  test('.arc-head must not change display — that triangle is the state marker', () => {
    const block = css.slice(css.indexOf('.arc-head {'), css.indexOf('.arc-count'));
    assert.ok(block.length > 0 && block.length < 900, 'what was sliced should be the .arc-head passage');
    assert.doesNotMatch(block, /display\s*:/, 'summary defaults to list-item, and touching it loses the triangle');
  });

  test('how many and how large stays visible while collapsed — that is what this section answers', () => {
    assert.match(html, /<span class="arc-count" id="arc-count">/);
    assert.match(html, /\$\('arc-count'\)\.textContent/,
      'the number has to really be written in, or the collapsed state is an empty heading');
  });

  test('it is called 「攻略备份」, not 「攻略存档」 — the same word as the button at the end of the row', () => {
    assert.match(html, /攻略备份/);
    assert.doesNotMatch(html, /攻略存档/);
    assert.doesNotMatch(read('Dashboard.html'), /攻略存档/);
  });
});

describe('the guide backup section does not explain itself', () => {
  const html = read('Setup.html');
  const js = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The deleted sentence was two halves of explanation joined: the first about the mechanism
  // (backups travel with the zip), the second about where another feature is (the end of a
  // Dashboard row). Both are the docs' job. The list itself already says what there is and how large
  test('no mechanism note such as "it travels with the backup zip"', () => {
    assert.doesNotMatch(js, /备份 zip 一起走/);
    assert.doesNotMatch(js, /去 Dashboard 上那个游戏行尾/);
  });

  test('the orphan sentence stays — it is a dead end plus a way out, not an explanation', () => {
    assert.match(js, /面板上没有对应行/);
    assert.match(js, /先把游戏加回来/, 'having said it cannot be reached, it has to say what to do');
  });

  test('with no orphans that line is empty, and empty takes no space', () => {
    assert.match(js, /\$\('arc-sum'\)\.textContent = orphans\.length/,
      'writing a sentence unconditionally leaves this cell permanently occupying a margin');
    assert.match(styleBlocks(html).join('\n'), /#arc-sum:empty\s*\{\s*display:\s*none/);
  });
});

/**
 * The 「全部删除」 at the end of the list.
 *
 * This group is all source assertions — zero dependencies, no DOM, clicks cannot be verified (see
 * the file header). The three things they watch all **fail without reporting**: the button in the
 * wrong place, disarming itself, and deleting a wider set than what is on screen.
 */
describe('the bulk delete of guide backups', () => {
  const html = read('Setup.html');
  const js = inlineScripts(html)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  test('the button is **below** the list, not on the heading line', () => {
    const wipe = html.indexOf('id="arc-wipe"');
    const list = html.indexOf('id="arc-list"');
    const summaryEnd = html.indexOf('</summary>');
    assert.ok(wipe > 0, 'cannot find the delete-all button');
    assert.ok(wipe > list, 'seeing which copies are being deleted has to come before that button');
    // Inside the `<summary>`: it could be deleted while collapsed, where that line shows only a
    // total; and clicking it would toggle the whole section along with it
    assert.ok(wipe > summaryEnd, 'it must not go inside the <summary>');
    assert.ok(html.indexOf('</details>') > wipe, 'it has to be inside the guide backup section');
  });

  test('the second-click button states the consequence — how many and how large, not 「确定」', () => {
    const i = js.indexOf('arm(wipe,');
    assert.ok(i > 0, 'cannot find arm(wipe, ...)');
    const call = js.slice(i, js.indexOf('\n', i));
    assert.match(call, /永久删除/);
    assert.match(call, /\$\{list\.length\} 份/, 'it has to say how many are being deleted');
    assert.match(call, /\$\{kb\(bytes\)\}/, 'it has to say how much is freed');
    assert.doesNotMatch(call, /确定/, 'the second click states the consequence, not 「确定」');
  });

  /**
   * The same family as a pit really fallen into: `#arc-wipe` is not inside `.arc-acts` (it is the
   * tail of the whole list). Left out of that selector, the first click runs its onclick and arms
   * it, then bubbles to document and immediately disarms it — presenting as **the button appearing
   * to do nothing and never reaching a second click**, with not one error reported
   */
  test('clicking it does not count as "clicking outside", or it is disarmed the moment it arms', () => {
    const i = js.indexOf("document.addEventListener('click'");
    assert.ok(i > 0);
    const guard = js.slice(i, i + 200);
    // Assert one by one rather than pinning the whole string: this check should not get in the way
    // when another exception is added later, and it has to fire when one is missing
    for (const sel of ['.arc-acts', '#arc-wipe', '#back-btn']) {
      assert.ok(guard.includes(sel),
        `the disarm check is missing ${sel} — that button is disarmed by the bubble the moment the first click arms it, and never reaches a second`);
    }
  });

  /**
   * **What is deleted is the batch on screen.** An id list is passed rather than telling the server
   * to "clear the directories": one background rewrite in between is enough to produce a backup
   * that was never on screen. The same class of error has come up repeatedly in this project: one
   * value with two renderers, one repaint path.
   */
  test('what is passed is the id list of the batch that was just painted', () => {
    assert.match(js, /const ids = sorted\.map\(\(e\) => e\.id\)/,
      'the ids have to be fixed at repaint time');
    assert.match(js, /call\('deleteGuideArchives', \[ids\]\)/);
  });

  test('the button has to reset after a repaint — it lives across repaints rather than being rebuilt like a row', () => {
    const i = js.indexOf("const wipe = $('arc-wipe')");
    assert.ok(i > 0, 'cannot find the definition of wipe');
    const block = js.slice(i, js.indexOf('arm(wipe,', i));
    assert.match(block, /wipe\.textContent = '全部删除'/, 'without a reset it stays on 永久删除 N 份');
    assert.match(block, /wipe\.classList\.remove\('armed'\)/);
  });

  test('the server really has that method', () => {
    const api = readFileSync(join(ROOT, 'lib', 'api.js'), 'utf8');
    assert.match(api, /deleteGuideArchives\(ids\)/, 'the name the page calls has to really exist');
  });
});

/**
 * The restore preview: the file under review must not execute while it is being previewed
 * ------------------------------------------------------------------
 * `manifest.json` is **a file inside the uploaded zip**, and `inspectBackup` `JSON.parse`s it
 * verbatim and hands it back to the page. So `counts.games` can say whatever it likes — assembled
 * into `innerHTML`, one `<img src=x onerror=…>` runs inside the setup page, and the setup page can
 * reach all 38 `/api/*` methods (delete games, change the config, start a generation that costs
 * money).
 *
 * The entire point of this screen is 「在覆盖数据之前先看看里面是什么」. Executing it on a glance
 * puts the gate the wrong way round.
 */
describe('the restore preview does not execute what is inside the backup file', () => {
  const js = inlineScripts(read('Setup.html')).join(SEP);

  /**
   * **Comments have to be stripped first, and line comments before block comments.**
   *
   * The first half is this repository's old rule: the comment beside this code says
   * 「拼进 innerHTML 就等于…」 while the assertion below looks for exactly the word `innerHTML` —
   * without stripping, the sentence explaining the rule makes the assertion fail forever (the
   * reverse is just as common: a comment making an assertion pass forever).
   *
   * The second half was **found by measurement**: the same line comment contains `/api` followed
   * by a star, and the block-comment regex takes that slash-star for the start of a block comment,
   * eating all the way to the first closing marker dozens of lines later — taking the **code** in
   * between with it. So changing `appendChild` to `innerHTML +=` still passed. Strip `//` by line
   * first and that false opening does not exist.
   *
   * (This comment dares not write the closing marker either — writing it would end this comment
   * early.)
   */
  const codeOnly = (s) => s
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\*.*$/gm, '');

  test('**the preview lines do not go through innerHTML**', () => {
    const i = js.indexOf('async function previewFile');
    assert.ok(i > 0, 'cannot find previewFile — this check has lost its target');
    const end = js.indexOf('function ', i + 30);
    assert.ok(end > i, 'cannot find the end of the function; it should be rewritten rather than loosened');
    const body = codeOnly(js.slice(i, end));
    // **The word `innerHTML` may not appear anywhere in this block.** Written as
    // `/\.innerHTML\s*=/` it misses `innerHTML +=` — which is exactly the shape "I am only
    // appending a little" most easily grows into
    assert.doesNotMatch(body, /innerHTML/,
      'the preview touches innerHTML again — the manifest comes from the file that is not yet trusted');
    assert.match(body, /bk-info/, 'what this check should be looking at is the bk-info block');
  });

  test('the numbers go through a numeric check rather than being placed as strings', () => {
    const i = js.indexOf('async function previewFile');
    const body = js.slice(i, js.indexOf('function ', i + 30));
    assert.match(body, /Number\.isFinite/,
      'the counts in the manifest are displayed unvalidated — they can be anything');
    assert.match(body, /num\(c\.games\)/, 'games does not go through num()');
    assert.match(body, /num\(c\.achievements\)/, 'achievements does not go through num()');
  });

  test('emphasis uses a real <b> element rather than an assembled tag', () => {
    const i = js.indexOf('async function previewFile');
    const body = js.slice(i, js.indexOf('function ', i + 30));
    assert.match(body, /createElement\('b'\)/, 'a <b> assembled as a string is another hole opened');
    assert.match(body, /textContent = text/, 'the text has to go through textContent');
  });
});

/**
 * A two-click button has to remain clickable after the second click throws
 * ------------------------------------------------------------------
 * Both awaits inside `run()` (`call()` / `rpc`) can throw (the connection dropped, the response is
 * not JSON), and `#arc-wipe` **lives across repaints** — writing `btn.disabled = false` on the
 * straight path means one throw leaves it disabled forever, recoverable only by refreshing the
 * whole page. And the moment it is most likely to throw is exactly the moment someone has just
 * failed once and wants to retry.
 */
describe('a two-click button does not get stuck greyed out', () => {
  for (const [page, fn] of [['Setup.html', 'function arm('], ['Dashboard.html', 'function arcArm(']]) {
    test(`${page}: the greying reset is in a finally`, () => {
      const js = inlineScripts(read(page)).join(SEP);
      const i = js.indexOf(fn);
      assert.ok(i > 0, `cannot find ${fn} — this check has lost its target`);
      const end = js.indexOf('\n    }', js.indexOf('btn.onclick', i));
      assert.ok(end > i, 'cannot find the end of the onclick; it should be rewritten rather than loosened');
      const body = js.slice(i, end);

      assert.match(body, /btn\.disabled = true/, 'the second click should grey the button first');
      // The finally has to come after the await run(), with that reset inside it
      assert.match(
        body, /try\s*\{\s*await run\(\);\s*\}\s*finally\s*\{\s*btn\.disabled = false;\s*\}/,
        'if run() throws the button is greyed forever — the reset belongs in a finally'
      );
    });
  }
});


/**
 * The exit from the setup page
 * ------------------------------------------------------------------
 * The packaged build has no address bar and no back key, and the tray's 「打开面板」 only
 * shows/focuses (showWindow in launcher/main.js does not loadURL). So `#back-btn` is the **only**
 * way back to the Dashboard from /setup without saving — without it, someone who changes their
 * mind halfway through can only quit the program.
 *
 * Everything pinned in this section is something whose deletion raises no error: the button type,
 * the condition for it appearing, the disarm exception, and its two pieces of copy. The disarm
 * exception is up in "the bulk delete of guide backups", verified together with `#arc-wipe`.
 */
/**
 * The way back from the fork
 * ------------------------------------------------------------------
 * The first screen of first-run setup is a fork between 全新设置 and 从备份恢复, and that fork
 * **used to be a one-way door**: once inside 「从备份恢复」 no control on the page led back, and
 * the packaged build has no address bar, no back key, and the tray's 「打开面板」 only
 * shows/focuses — so someone with no backup file to hand could only quit the whole program. That
 * is what a user reported.
 *
 * The way back and `#back-btn` are **not the same thing**, and every case in this section holds
 * that distinction: that one goes to the Dashboard and is armed only in settings mode (first-run
 * setup is a gate and should have no exit); this one appears only in first-run setup and returns to
 * those two choices, with the person still inside the gate.
 */
describe('the way back from the fork', () => {
  const html = read('Setup.html');
  const js = inlineScripts(html).join(SEP);
  /** Line comments before block comments — the words these assertions look for all appear in the comments explaining them */
  const codeOnly = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const code = codeOnly(js);
  const tag = html.match(/<button[^>]*id="gate-back"[^>]*>([^<]*)<\/button>/);

  test('it exists, is type="button", and is collapsed by default', () => {
    assert.ok(tag, 'cannot find #gate-back — without it, 「从备份恢复」 is a one-way door again');
    assert.match(tag[0], /type="button"/, 'it is inside the <form>, and the default type would submit it');
    assert.match(tag[0], /\shidden\b/, 'the fork itself should have no way back');
  });

  test('both branches reveal it', () => {
    for (const fn of ['startWizard', 'startRestore']) {
      const i = code.indexOf('function ' + fn + '(');
      assert.ok(i > 0, 'cannot find ' + fn);
      assert.match(code.slice(i, code.indexOf('\n    }', i)), /gate-back'\)\.hidden = false/,
        fn + ' does not reveal the way back — that branch cannot return');
    }
  });

  /**
   * `startRestore` hides three elements and changes the title and subtitle. If `showGate` misses
   * restoring any one of them, that section is half missing the second time through — and it raises
   * no error.
   */
  test('showGate restores everything startRestore hid', () => {
    const g = code.indexOf('function showGate(');
    assert.ok(g > 0, 'cannot find showGate');
    const body = code.slice(g, code.indexOf('\n    }', g));
    for (const id of ['backup-make', 'backup-title', 'restore-title']) {
      assert.ok(body.includes(id), 'showGate does not restore ' + id + ' — startRestore hid it');
    }
    assert.match(body, /gate'\)\.hidden = false/, 'showGate has to put the fork back');
    assert.match(body, /gate-back'\)\.hidden = true/, 'the fork itself should carry no way back');
  });

  /**
   * **The way back turned `showWizard` into a function that can run a second time.** The
   * `addEventListener` calls inside it then stack up: measured, with the guard removed and three
   * round trips, one 「跳过」 jumped from step 1 to step 4. A duplicate binding raises no error; the
   * behaviour merely doubles.
   */
  test('the one-off wiring of the wizard can only run once', () => {
    const i = code.indexOf('function wireWizard(');
    assert.ok(i > 0, 'cannot find wireWizard — one-off wiring has to be shut away on its own');
    const body = code.slice(i, code.indexOf('\n    }', i));
    assert.match(body, /if \(wizardWired\) return;/, 'without this guard the listeners stack up');
    for (const ev of ['step-skip', 'step-next']) {
      assert.ok(body.includes(ev), ev + ' has to be bound after the guard');
    }
    const sw = code.indexOf('function showWizard(');
    assert.doesNotMatch(code.slice(sw, code.indexOf('\n    }', sw)), /addEventListener/,
      'showWizard must not carry a bare addEventListener any more — it now runs several times');
  });

  test('the way back is not the exit to the Dashboard', () => {
    const i = code.indexOf("addEventListener('click', showGate)");
    assert.ok(i > 0, 'the way back has to be wired to showGate');
    assert.doesNotMatch(tag[1], /Dashboard/,
      'first-run setup is a gate, and this button returns to the fork rather than to the Dashboard');
  });
});

describe('the exit from the setup page', () => {
  const html = read('Setup.html');
  const js = inlineScripts(html).join(SEP);
  /** Line comments before block comments — the words these assertions look for all appear in the comments explaining them */
  const codeOnly = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const code = codeOnly(js);
  const tag = html.match(/<button[^>]*id="back-btn"[^>]*>([^<]*)<\/button>/);

  test('it is type="button" — it sits inside the <form>, and the default type would submit it', () => {
    assert.ok(tag, 'cannot find #back-btn');
    assert.match(tag[0], /type="button"/,
      'the default type is submit: pressing 「返回」 would trigger a save, which is the very thing it exists to avoid');
  });

  test('hidden by default — during first-run setup this page is a gate and should have no exit', () => {
    assert.match(tag[0], /\shidden\b/, 'it has to be collapsed in the markup itself');
    const i = code.indexOf('if (isEditMode) {');
    assert.ok(i > 0, 'cannot find the settings-mode branch');
    assert.match(code.slice(i, i + 400), /armBack\(\)/, 'the exit has to hang inside isEditMode');
    assert.equal([...code.matchAll(/back\.hidden = false/g)].length, 1,
      'only one place should reveal the exit — one more is one more path bypassing isEditMode');
  });

  test('the label says where it goes, not what it undoes', () => {
    assert.match(tag[1], /面板/, 'the button has to say where it goes');
    assert.doesNotMatch(tag[1], /取消/,
      'six controls on this page take effect before a save (creating the Notion database saves on the spot, backup now, restore, delete archive), '
      + 'and 「取消」 promises a whole-page rollback while all it can take back is a few input boxes');
  });

  test('the second click states the consequence, not 「确定」', () => {
    const i = code.indexOf('arm(back,');
    assert.ok(i > 0, 'cannot find arm(back, ...)');
    const line = code.slice(i, code.indexOf('\n', i));
    assert.match(line, /放弃未保存的修改/, 'it has to say plainly what is being lost');
    assert.doesNotMatch(line, /确定/, 'the same rule as the archive buttons');
  });

  test('with nothing changed it goes straight through — stopping every time trains the confirmation into something dismissed reflexively', () => {
    const i = code.indexOf('back.onclick = (e) =>');
    assert.ok(i > 0, 'cannot find the layer wrapped around arm()');
    const body = code.slice(i, i + 220);
    assert.match(body, /if \(isDirty\(\)\) return confirmClick\(e\)/, 'only a dirty form takes the two-click path');
    assert.match(body, /location\.href = '\/'/, 'a clean one goes straight back to the Dashboard');
  });

  test('creating the Notion database marks only that field — a whole reset wipes genuinely unsaved changes elsewhere', () => {
    const i = code.indexOf('loadedNotionDb = r.id');
    assert.ok(i > 0, 'cannot find the write-back after the database is created');
    const after = code.slice(i, i + 200);
    assert.match(after, /markSaved\('notion-db'\)/, 'creating the database saves on the spot, so that field should no longer count as dirty');
    assert.doesNotMatch(after, /markSaved\(\)/,
      'a whole reset wipes genuinely unsaved changes made at the same time (a half-edited SteamID, say)');
  });

  /**
   * **Every field read at submit time has to be in the dirty check.** Missing one presents as:
   * change it, press back, the page leaves without a word and the change is lost — which is exactly
   * the purpose of this button biting back. Derive it from the submit passage rather than
   * hand-copying a list: adding a new setting makes this fail by itself.
   */
  test('every field read at submit time is in the dirty check, and really exists in the markup', () => {
    const i = code.indexOf("form.addEventListener('submit'");
    assert.ok(i > 0, 'cannot find the submit handler');
    const sub = code.slice(i, code.indexOf('btn.disabled = true', i));
    const ids = [...new Set([...sub.matchAll(/\$\('([^']+)'\)\.value/g)].map((m) => m[1]))];
    assert.ok(ids.length >= 7, `only ${ids.length} fields were read in the submit; this check has lost its target`);

    const m = code.match(/const DIRTY_FIELDS =\s*\[([^\]]*)\]/);
    assert.ok(m, 'cannot find DIRTY_FIELDS');
    for (const id of ids) {
      assert.ok(m[1].includes(`'${id}'`),
        `${id} is saved but is not in the dirty check — changing it and pressing back is not stopped, and the change is quietly lost`);
      assert.ok(html.includes(`id="${id}"`), `${id} does not exist in the markup, so $() returns null`);
    }
  });
});


/**
 * The red of a two-click button cannot be covered by the hover colour
 * ------------------------------------------------------------------
 * `.armed` is **two classes** (0,2,0), while each `:hover:not(:disabled)` is one class plus two
 * pseudo-classes (0,3,0) — the hover rule wins. And after the first click the cursor is resting
 * right on the button: the red is covered by the hover colour at exactly the instant it most needs
 * to be seen.
 *
 * The symptom is only a wrong colour, **nothing reports anything**, and it appears only while the
 * mouse is on the button — easy to miss in a screenshot and in a scan by eye. So every armed rule
 * has to carry its own `:hover` variant.
 */
describe('the red of a two-click button cannot be covered by the hover colour', () => {
  /** CSS comments have to be stripped first — the sentence explaining this rule names these selectors */
  const cssOf = (page) =>
    styleBlocks(read(page)).join(SEP).replace(/\/\*[\s\S]*?\*\//g, '');

  for (const [page, sels] of [
    ['Setup.html', ['.back.armed', '.arc-acts .armed', '.arc-foot .armed']],
    ['Dashboard.html', ['.arc-acts button.armed']],
  ]) {
    test(`${page}: every armed rule carries a :hover variant`, () => {
      const css = cssOf(page);
      for (const sel of sels) {
        assert.ok(css.includes(sel),
          `${sel} is gone — this check has lost its target and should be updated rather than deleted`);
        assert.ok(css.includes(`${sel}:hover:not(:disabled)`),
          `${sel} has no :hover variant — with the cursor on the button the red is covered by the hover colour, `
          + `which is exactly the state right after the first click`);
      }
    });
  }
});
