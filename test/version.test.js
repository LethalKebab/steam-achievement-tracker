/**
 * There is only one version number — three places have to agree
 * ------------------------------------------------
 * Three places in this repository carry a version: the root `package.json`,
 * `launcher/package.json`, and `launcher/package-lock.json` (which writes it twice).
 * **Only the launcher one has a runtime reader** — `app.getVersion()` and `postbuild.js`
 * both read it, the zip and manifest file names are assembled from it, and the tag has to
 * equal it. Nothing reads the other two.
 *
 * A number nobody reads is a number that drifts, and it drifts silently:
 *
 * 1. **The root one is carried into the package.** `extraResources` copies it as
 *    `resources/tracker/package.json`, which is the **only** place a user can read on their
 *    own disk to learn "which version of the tracker code do I have". Getting it wrong
 *    raises no error and merely sends an investigation off course — which happened once on
 *    2026-08-14: a bug report against 1.1.2 took an extra round to trace, because the two
 *    counters looked like two independent facts, before establishing that the reporter was
 *    not running 1.1.2's code at all.
 * 2. **The two places in the lock file are filled in by `npm install --package-lock-only`**,
 *    and skipping that step still builds successfully: the zip is named with one number
 *    while another sits in the lock file, and nothing anywhere goes red.
 *
 * These three used to be **deliberately** split into two counters (tracker 2.x / app 1.x,
 * the reasoning is in "Cutting a release" in `launcher/README.md`). Across four releases
 * the two were always bumped together and the second one never carried any information, so
 * they were merged into one on 2026-08-14.
 *
 * **The half this file cannot reach: the git tag.** A test cannot see the tag, so "the tag
 * equals the launcher's version" still has to be guaranteed by hand at that step in the
 * release checklist. What can be done here is making **the repository internally**
 * consistent first, leaving only one number for the checklist to match.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const root = readJson('../package.json');
const launcher = readJson('../launcher/package.json');
const lock = readJson('../launcher/package-lock.json');

/**
 * The launcher's is the reference, and not arbitrarily: it is the only one with a runtime
 * reader, and the one the zip name, the manifest name and the tag have to match. The other
 * two follow it.
 */
const expected = launcher.version;

describe('version alignment', () => {
  test('the launcher version is three-part, with no v prefix and no whitespace', () => {
    // postbuild.js assembles file names from it
    // (`SteamAchievementTracker-<version>-win.zip`), and a stray `v` or trailing space makes
    // the produced file name disagree with the tag — which raises no error at build time.
    assert.match(
      expected,
      /^\d+\.\d+\.\d+$/,
      `launcher/package.json's version is ${JSON.stringify(expected)}, and should be plain three-part`
    );
  });

  test('the root package.json matches the launcher', () => {
    assert.equal(
      root.version,
      expected,
      `the root package.json is ${root.version} while the launcher is ${expected}. ` +
        'The two have to match — the root one is packaged as resources/tracker/package.json ' +
        'and is the only version number a user can read.'
    );
  });

  test('the lock file\'s top level matches the launcher', () => {
    assert.equal(
      lock.version,
      expected,
      `launcher/package-lock.json's top level is ${lock.version}, expected ${expected}. ` +
        'Run `npm install --package-lock-only` inside launcher/.'
    );
  });

  test('the lock file\'s root package entry matches the launcher', () => {
    // The lock file writes its own version twice, and `packages[""]` is the second place.
    // Aligning only the top level leaves a half-fixed lock file, which is likewise silent.
    assert.equal(
      lock.packages?.['']?.version,
      expected,
      `launcher/package-lock.json's packages[""] is ${lock.packages?.['']?.version}, expected ${expected}. ` +
        'Run `npm install --package-lock-only` inside launcher/.'
    );
  });
});
