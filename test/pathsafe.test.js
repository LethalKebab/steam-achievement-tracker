/**
 * Path containment: four checks, one predicate
 * ------------------------------------------------------------------
 * What this file protects is a **specific bit that was missed**: without a separator,
 * `startsWith(root)` judges `…/guides-evil/x.md` to be "inside `…/guides`", because the
 * former really does start with the latter.
 * A **sibling directory sharing a prefix** is the classic way this kind of check leaks,
 * and in this project the same question had four answers (see the table in
 * `lib/pathsafe.js`), two of which missed it.
 *
 * So there are two layers here: the predicate itself, and **whether all four callers
 * genuinely route through it** — the predicate being extracted while one place still
 * writes its own is the only meaningful regression for this fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { isInside, containedPath } from '../lib/pathsafe.js';
import { resolveGuidePath } from '../lib/markdown.js';
import { parseArchiveId } from '../lib/guidearchive.js';

const R = (...p) => resolve(join(...p));

describe('isInside', () => {
  test('a child file and a deeper subdirectory both count as inside', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides/x.md')), true);
    assert.equal(isInside(R('/a/guides'), R('/a/guides/sub/x.md')), true);
  });

  test('**a sibling directory sharing the prefix does not count** — this is the bit that was missed', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides-evil/x.md')), false);
    assert.equal(isInside(R('/a/guides'), R('/a/guidesX')), false);
    assert.equal(isInside(R('/a/guides'), R('/a/guides.bak/x.md')), false);
  });

  test('anything that climbs out does not count', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/x.md')), false);
    assert.equal(isInside(R('/a/guides'), R('/b/x.md')), false);
  });

  test('the root itself does not count as inside — every caller wants "some file under the root"', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides')), false);
  });

  test('`..` is normalised away first, so a path that comes back round still counts as inside', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides/sub/../x.md')), true);
  });
});

describe('containedPath', () => {
  test('ordinary segments assemble into an absolute path', () => {
    assert.equal(containedPath(R('/a/guides'), 'x.md'), R('/a/guides/x.md'));
    assert.equal(containedPath(R('/a/guides'), 'sub', 'x.md'), R('/a/guides/sub/x.md'));
  });

  test('a `..` segment returns null', () => {
    assert.equal(containedPath(R('/a/guides'), '..', 'x.md'), null);
    assert.equal(containedPath(R('/a/guides'), '..', 'guides-evil', 'x.md'), null);
  });

  test('**a separator hidden inside a segment returns null too** — that segment is quietly changing the path structure', () => {
    assert.equal(containedPath(R('/a/guides'), `..${sep}..${sep}x.md`), null);
    assert.equal(containedPath(R('/a/guides'), '../x.md'), null);
  });

  test('a segment with a separator that does not escape is still refused — the test is "assembled segment by segment", not "where it ends up"', () => {
    // The result really is still inside guides/, but that segment claims to be one file
    // name while actually being two. Letting it through breaks the premise that "every
    // segment is a file name", which every caller relies on
    assert.equal(containedPath(R('/a/guides'), `sub${sep}x.md`), null);
  });
});

// ---------------------------------------------------------------------------
// The four callers
// ---------------------------------------------------------------------------

describe('every caller routes through the same predicate', () => {
  /** Builds a real directory: guides/ and its sibling guides-evil/ */
  const build = () => {
    const base = mkdtempSync(join(tmpdir(), 'sat-pathsafe-'));
    mkdirSync(join(base, 'guides'), { recursive: true });
    mkdirSync(join(base, 'guides-evil'), { recursive: true });
    writeFileSync(join(base, 'guides', 'ok.md'), '# 正常\n');
    writeFileSync(join(base, 'guides-evil', 'secret.md'), '机密\n');
    return base;
  };

  test('resolveGuidePath: an ordinary relative path reads back', () => {
    const base = build();
    try {
      assert.equal(resolveGuidePath(join(base, 'guides'), 'ok.md'), R(base, 'guides', 'ok.md'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('**resolveGuidePath: a sibling directory has to throw and must not be readable**', () => {
    const base = build();
    try {
      assert.throws(
        () => resolveGuidePath(join(base, 'guides'), join('..', 'guides-evil', 'secret.md')),
        /越出了 guides 目录/,
        'guides-evil/ was read as though it were part of guides/'
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('resolveGuidePath: an absolute path goes through the same check', () => {
    const base = build();
    try {
      assert.throws(
        () => resolveGuidePath(join(base, 'guides'), join(base, 'guides-evil', 'secret.md')),
        /越出了 guides 目录/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('parseArchiveId: a legal id parses', () => {
    const config = { guidesDir: R('/a/guides') };
    const r = parseArchiveId(config, '.backups/730-20260820-122121.md');
    assert.equal(r.dir, '.backups');
    assert.equal(r.file, '730-20260820-122121.md');
  });

  test('parseArchiveId: a directory outside those three is refused', () => {
    assert.throws(() => parseArchiveId({ guidesDir: R('/a/guides') }, '.evil/x.md'), /目录不认识/);
  });

  test('parseArchiveId: a file name with a separator is refused — the id is a string sent up by the browser', () => {
    const config = { guidesDir: R('/a/guides') };
    assert.throws(() => parseArchiveId(config, '.backups/../x.md'), /不合法|越界/);
    assert.throws(() => parseArchiveId(config, `.backups/..${sep}..${sep}x.md`), /不合法|越界/);
  });

  /**
   * **There has to be exactly one predicate.** After extracting it, the most likely
   * regression is not the predicate being wrong but one place never being converted and
   * carrying on with its own — and that regression turns no test red, because each place's
   * own tests still pass. So this checks the source directly.
   */
  test('no file still writes its own `startsWith(root)` containment check', async () => {
    const { readFileSync } = await import('node:fs');
    const files = ['lib/markdown.js', 'lib/backup.js', 'lib/guidearchive.js', 'lib/server.js'];
    for (const f of files) {
      const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/^\s*\/\/.*$/gm, '')       // line comments — mentioning this form in a comment is allowed
        .replace(/^\s*\*.*$/gm, '');        // JSDoc continuation lines
      assert.doesNotMatch(
        src, /startsWith\(\s*(?:root|base|resolve\()/,
        `${f} still holds a hand-written containment check, so the predicate is back to two copies`
      );
    }
  });
});
