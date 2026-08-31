/**
 * The CLI's flag gates
 * ------------------------------------------------
 * `tracker.js` is the entry point: importing it runs a command, so the functions in it are out
 * of a unit test's reach and this file reads the source instead — the same approach as
 * `test/cli-hints.test.js`.
 *
 * The gate below is not merely matched as text. It is **extracted and evaluated**, so what is
 * asserted is what the flags actually resolve to, and a rewrite that keeps the shape while
 * changing the meaning is still caught.
 *
 * The failures guarded here are all of the same kind: **the command runs, exits 0, and does
 * nothing**. Nothing is thrown, nothing is printed in red, and the only way to notice is to know
 * what should have happened.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../tracker.js', import.meta.url), 'utf8');

describe('guides: which sources a set of flags selects', () => {
  /**
   * Runs the real gate against a synthetic flag set.
   *
   * The lines are lifted between `cmdGuides` and its first use of the result, keeping only the
   * `const` declarations and dropping the one that opens the database. If that shape ever changes
   * this throws rather than quietly passing.
   */
  const select = (...flagList) => {
    const start = SRC.indexOf('async function cmdGuides');
    assert.ok(start > 0, 'cannot find cmdGuides — this check has lost its target rather than passed');
    const end = SRC.indexOf('if (wantLocal)', start);
    assert.ok(end > start, 'cannot find the first use of wantLocal — the shape changed, so rewrite this check rather than loosening it');
    const decls = SRC.slice(start, end)
      .split('\n')
      .filter((l) => /^\s*const /.test(l) && !l.includes('withSteam'))
      .join('\n');
    assert.match(decls, /wantNotion/, 'the extracted block no longer computes wantNotion');
    // eslint-disable-next-line no-new-func -- the point is to run the shipped expression, not a copy of it
    return new Function('flags', `${decls}\nreturn { local: wantLocal, notion: wantNotion };`)(new Set(flagList));
  };

  test('no flags at all scans both sources', () => {
    assert.deepEqual(select(), { local: true, notion: true });
  });

  test('--local and --notion each select just their own', () => {
    assert.deepEqual(select('--local'), { local: true, notion: false });
    assert.deepEqual(select('--notion'), { local: false, notion: true });
  });

  test('--all selects both', () => {
    assert.deepEqual(select('--all'), { local: true, notion: true });
  });

  test('**--force alone still scans both**', () => {
    // `guides.conflict` tells the user in so many words to add --force to switch to the local md.
    // Keying the default off "no flags were given" makes that advice a no-op: the command scans
    // nothing, prints an empty table, and exits 0 — so the advice appears to have been followed
    // and to have done nothing
    assert.deepEqual(
      select('--force'), { local: true, notion: true },
      'an unrelated flag turned both sources off, so the command scanned nothing at all'
    );
  });

  test('a selector combined with an unrelated flag still means that selector', () => {
    assert.deepEqual(select('--local', '--force'), { local: true, notion: false });
    assert.deepEqual(select('--notion', '--force'), { local: false, notion: true });
  });

  test('the gate does not key off how many flags there are', () => {
    assert.doesNotMatch(
      SRC.slice(SRC.indexOf('async function cmdGuides'), SRC.indexOf('if (wantLocal)')),
      /flags\.size/,
      'counting flags means any flag added later silently changes which sources are scanned'
    );
  });
});

describe('--provider without --model keeps that vendor\'s pinned model', () => {
  /**
   * `switchAiProvider` stores one model per vendor precisely so that switching away and back does
   * not lose a pin, and `test/config-ai-providers.test.js` pins that property. It reads the stored
   * one through `??`, which an empty string defeats: `''` is a value, so the fallback never runs
   * and the pin is cleared instead of read.
   *
   * `flagValue` returns undefined when the flag is absent, so passing it straight through is what
   * makes the vendor's own model be found.
   */
  test('the call site passes the flag through rather than substituting an empty string', () => {
    const start = SRC.indexOf('function applyAiFlags');
    assert.ok(start > 0, 'cannot find applyAiFlags — this check has lost its target rather than passed');
    const body = SRC.slice(start, SRC.indexOf('\n}', start));
    const call = body.match(/switchAiProvider\([^;]*\);/);
    assert.ok(call, 'cannot find the switchAiProvider call');
    assert.doesNotMatch(
      call[0], /model:\s*model\s*\?\?\s*''/,
      "an empty string is a value, so switchAiProvider's ?? never fires and the vendor's pinned model is cleared instead of read"
    );
    assert.match(call[0], /\{\s*model\s*\}/, 'the model flag is no longer passed through as given');
  });

  test('flagValue returns undefined for an absent flag, which is what the ?? depends on', () => {
    const fn = SRC.match(/function flagValue\(name\) \{([\s\S]*?)\n\}/);
    assert.ok(fn, 'cannot find flagValue');
    assert.doesNotMatch(fn[1], /\?\?\s*''/, 'flagValue substituting an empty string would defeat the same fallback one level down');
  });
});

describe('the CLI prints dates in the interface language', () => {
  test('no command pins a locale literal', () => {
    const hits = [...SRC.matchAll(/toLocaleString\(\s*'([a-z]{2}-[A-Z]{2})'/g)].map((m) => m[1]);
    assert.deepEqual(hits, [],
      `a hardcoded locale (${hits.join(', ')}) prints a Chinese-formatted timestamp under an English interface`);
  });
});
