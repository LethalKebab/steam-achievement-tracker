/**
 * Self-update
 * ------------------------------------------------
 * This file guards the part that **cannot be repaired once it breaks**. What makes the updater
 * special is that the broken version is already installed on the user's machine, and the fixed
 * version has to be delivered by the broken updater.
 *
 * Split in two, following section 5 of docs/self-update.md:
 *
 * - **Unit-testable**: manifest generation, version comparison, sha256 verification, remembering
 *   a skipped version. All in `launcher/updater.js`, a file that deliberately does not import
 *   electron so it can be loaded directly.
 * - **Not unit-testable**: the actual file replacement. Covered by a rehearsal (pointing it at
 *   v1.1.2 for a "downgrade"). What can be done here is **parsing the generated PowerShell** and
 *   asserting that the script's structure does not violate the three constraints — the script
 *   runs in a process with no console and nobody watching, so a syntax error is seen by nobody
 *   and presents only as "the program quit itself and never came back". That is not a figure of
 *   speech: it happened once in a real rehearsal, while the app log said the helper had started.
 *
 * `launcher/main.js` needs Electron to load, so that half can only be **source assertions**, the
 * same family as `test/tray.test.js`.
 *
 * ⚠️ A source assertion has to strip comments before matching — this repository has a high
 * comment density, and without stripping, an assertion gets satisfied by the comment beside it.
 * The one in tray.test.js really did run empty.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANIFEST_NAME,
  STATE_NAME,
  buildManifest,
  compareVersions,
  downloadVerified,
  hashFile,
  fallbackLaunch,
  isSafeManifestPath,
  machineLocalEntries,
  primaryLaunch,
  parseManifest,
  parsePromptChoice,
  pickAssets,
  renderUpdatePromptHtml,
  readUpdateState,
  renderHelperScript,
  sha256FromDigest,
  shouldOffer,
  writeHelperScript,
  writeUpdateState,
} from '../launcher/updater.js';

// --- The two helpers for source assertions. The same copy as in tray.test.js; the reasoning is in the long comment there ---

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

const mainSrc = stripComments(readFileSync(new URL('../launcher/main.js', import.meta.url), 'utf8'));
const postbuildSrc = stripComments(
  readFileSync(new URL('../launcher/postbuild.js', import.meta.url), 'utf8')
);

/**
 * Slice out a whole block from needle by brace balancing — a fixed-length slice drifts as the
 * surrounding code grows and shrinks.
 *
 * **The search for `{` has to start after the end of needle, not at its start.** Otherwise the
 * first `{` of something like `function askUpdate({ version, sizeMb })` is the destructured
 * parameter itself, balancing closes at the parameter list, and what is sliced out is one line
 * of signature — so the assertion matches against a signature line, always false (or worse,
 * always true). The copy in tray.test.js never hit this only because none of its needles carry a
 * brace; a needle has to include the parameter list to reach the function body.
 */
function blockFrom(src, needle, label = needle) {
  const start = src.indexOf(needle);
  assert.ok(start > 0, `cannot find ${label} — this check has lost its target rather than passed`);
  const open = src.indexOf('{', start + needle.length);
  assert.ok(open > start, `there is no code block after ${label}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`the code block for ${label} does not close`);
}

/** Clean up only after awaiting fn — without that await, an async case's temp directory is gone before its assertions run */
async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfupdate-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ version comparison

describe('version comparison', () => {
  test('compares numeric segments, not strings', () => {
    // Under string comparison '1.1.9' > '1.2.0', so 1.2.0 goes out and nobody receives it,
    // with no error at all — simply nobody ever upgrades
    assert.ok(compareVersions('1.2.0', '1.1.9') > 0, '1.2.0 has to be newer than 1.1.9');
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0, '1.10.0 has to be newer than 1.9.0');
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.equal(compareVersions('1.1.3', '1.1.3'), 0);
  });

  test('the v prefix on a tag is tolerated on both sides', () => {
    // One side is the release tag_name (v1.1.3), the other is app.getVersion() (1.1.3)
    assert.equal(compareVersions('v1.1.3', '1.1.3'), 0);
    assert.ok(compareVersions('v1.1.4', 'v1.1.3') > 0);
  });

  test('uneven segment counts are padded with 0', () => {
    assert.equal(compareVersions('1.1', '1.1.0'), 0);
    assert.ok(compareVersions('1.1.1', '1.1') > 0);
  });

  test('neither the same version nor an older one prompts', () => {
    const now = '1.1.3';
    assert.equal(shouldOffer({ currentVersion: now, remoteVersion: '1.1.3' }), false);
    // An older version was re-published / latest was pointed back: the user must not be downgraded
    assert.equal(shouldOffer({ currentVersion: now, remoteVersion: '1.1.2' }), false);
    assert.equal(shouldOffer({ currentVersion: now, remoteVersion: '1.1.4' }), true);
  });

  test('a missing tag_name does not prompt', () => {
    assert.equal(shouldOffer({ currentVersion: '1.1.3', remoteVersion: '' }), false);
  });
});

// ================================================================ remembering a skipped version

describe('remembering a skipped version', () => {
  test('after skipping, that same version does not prompt again while a newer one still does', () => {
    // One of the three fatal details in the design document. Without remembering, it prompts on
    // every launch and two days later the user is trained to ignore it
    const base = { currentVersion: '1.1.3', skippedVersion: '1.2.0' };
    assert.equal(shouldOffer({ ...base, remoteVersion: '1.2.0' }), false, 'the skipped version prompted again');
    assert.equal(
      shouldOffer({ ...base, remoteVersion: '1.2.1' }),
      true,
      'skipping 1.2.0 should not swallow 1.2.1 as well — that would turn updates off permanently'
    );
  });

  test('what is written can be read back', () =>
    withTempDir((dir) => {
      const p = join(dir, STATE_NAME);
      assert.equal(writeUpdateState(p, { skippedVersion: '1.2.0' }), true);
      assert.deepEqual(readUpdateState(p), { skippedVersion: '1.2.0' });
    }));

  test('a missing file and a corrupt one both count as "nothing skipped" and must not throw', () =>
    withTempDir((dir) => {
      // Throwing would blow up inside the update check on the very first run (before the file exists)
      assert.deepEqual(readUpdateState(join(dir, 'nope.json')), { skippedVersion: null });

      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{ 这不是 json');
      assert.deepEqual(readUpdateState(broken), { skippedVersion: null });

      const wrongShape = join(dir, 'shape.json');
      writeFileSync(wrongShape, '{"skippedVersion": 17}');
      assert.deepEqual(readUpdateState(wrongShape), { skippedVersion: null });
    }));

  test('an unwritable path returns false rather than throwing', () =>
    withTempDir((dir) => {
      // This is reached when the app directory is read-only (unzipped into Program Files, say).
      // Failing to remember a skip is a small thing; popping an error box over it is not
      const path = join(dir, 'no-such-dir', 'state.json');
      assert.doesNotThrow(() => writeUpdateState(path, { skippedVersion: '1.2.0' }));
      assert.equal(writeUpdateState(path, { skippedVersion: '1.2.0' }), false);
    }));
});

// ================================================================ sha256 verification

describe('sha256 verification', () => {
  const hex = 'a'.repeat(64);

  test('the GitHub digest format is recognised', () => {
    assert.equal(sha256FromDigest(`sha256:${hex}`), hex);
    assert.equal(sha256FromDigest(`SHA256:${hex.toUpperCase()}`), hex);
  });

  test('anything unrecognised returns null', () => {
    assert.equal(sha256FromDigest(null), null);
    assert.equal(sha256FromDigest(undefined), null);
    assert.equal(sha256FromDigest(''), null);
    assert.equal(sha256FromDigest(`md5:${'a'.repeat(32)}`), null, 'md5 must not be taken for sha256');
    assert.equal(sha256FromDigest(`sha256:${'a'.repeat(63)}`), null, 'a wrong length is wrong');
    assert.equal(sha256FromDigest(`sha256:${'z'.repeat(64)}`), null, 'non-hex characters');
  });

  test('what it computes matches crypto', async () =>
    withTempDir(async (dir) => {
      const p = join(dir, 'blob.bin');
      const payload = Buffer.from('成就追踪器'.repeat(1000));
      writeFileSync(p, payload);
      assert.equal(await hashFile(p), createHash('sha256').update(payload).digest('hex'));
    }));

  test('with no digest it has to refuse to install rather than skip verification', async () =>
    withTempDir(async (dir) => {
      // The most important one. "Cannot verify, so do not verify" means letting the user run an
      // unverified 133MB executable; better not to update at all. And that degradation gives no
      // sign whatsoever — the update still "succeeds"
      let fetched = false;
      const asset = { name: 'x-win.zip', browser_download_url: 'https://example/x', digest: null };
      await assert.rejects(
        () =>
          downloadVerified(asset, join(dir, 'x.zip'), {
            fetchImpl: async () => {
              fetched = true;
              return new Response(Buffer.from('whatever'));
            },
          }),
        /没有可用的 sha256/
      );
      assert.equal(fetched, false, 'the download should not even start');
    }));

  test('matching content passes, mismatching content is refused', async () =>
    withTempDir(async (dir) => {
      const payload = Buffer.from('真正的安装包');
      const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
      const fetchImpl = async () => new Response(payload);

      const good = { name: 'ok-win.zip', browser_download_url: 'https://example/ok', digest };
      await downloadVerified(good, join(dir, 'ok.zip'), { fetchImpl });
      assert.deepEqual(readFileSync(join(dir, 'ok.zip')), payload);

      const tampered = {
        name: 'bad-win.zip',
        browser_download_url: 'https://example/bad',
        digest: `sha256:${'0'.repeat(64)}`,
      };
      await assert.rejects(
        () => downloadVerified(tampered, join(dir, 'bad.zip'), { fetchImpl }),
        /校验不通过/
      );
    }));

  test('a half-written file that fails verification has to be deleted', async () =>
    withTempDir(async (dir) => {
      // What is downloaded here is 133MB. Repeated failures pile up hundreds of megabytes in
      // temp, and a package that fails verification is of no use on disk at all
      const dest = join(dir, 'bad.zip');
      await assert.rejects(() =>
        downloadVerified(
          { name: 'bad-win.zip', browser_download_url: 'https://x/bad', digest: `sha256:${'0'.repeat(64)}` },
          dest,
          { fetchImpl: async () => new Response(Buffer.from('垃圾')) }
        )
      );
      assert.equal(existsSync(dest), false, 'a file that failed verification was left on disk');
    }));
});

// ================================================================ release assets

describe('picking the release assets', () => {
  const assets = [
    { name: 'SteamAchievementTracker-1.1.4-win.zip' },
    { name: 'SteamAchievementTracker-1.1.4-manifest.json' },
    { name: 'source.tar.gz' },
  ];

  test('the zip and the manifest are picked out', () => {
    const { zip, manifest } = pickAssets(assets);
    assert.equal(zip.name, 'SteamAchievementTracker-1.1.4-win.zip');
    assert.equal(manifest.name, 'SteamAchievementTracker-1.1.4-manifest.json');
  });

  test('an older release has no manifest, and that is not an error', () => {
    // Packages published up to and including 1.1.3 carry no manifest. That case updates as usual,
    // only leaving no manifest in the app directory afterwards, so the next one does a plain
    // overwrite again
    const { zip, manifest } = pickAssets([{ name: 'SteamAchievementTracker-1.1.3-win.zip' }]);
    assert.ok(zip);
    assert.equal(manifest, null);
  });

  test('an empty asset list does not throw', () => {
    assert.deepEqual(pickAssets(), { zip: null, manifest: null });
    assert.deepEqual(pickAssets([]), { zip: null, manifest: null });
  });
});

// ================================================================ manifest generation

describe('manifest generation', () => {
  const makeTree = (root) => {
    mkdirSync(join(root, 'locales'), { recursive: true });
    mkdirSync(join(root, 'resources', 'tracker', 'lib'), { recursive: true });
    writeFileSync(join(root, 'App.exe'), 'exe');
    writeFileSync(join(root, 'locales', 'zh-CN.pak'), 'pak');
    writeFileSync(join(root, 'resources', 'tracker', 'tracker.js'), 'js');
    writeFileSync(join(root, 'resources', 'tracker', 'lib', 'db.js'), 'js');
  };

  test('every file is listed, as a relative path with forward slashes', () =>
    withTempDir((dir) => {
      makeTree(dir);
      const { files } = buildManifest(dir, '1.1.4');
      assert.deepEqual(files, [
        'App.exe',
        'locales/zh-CN.pak',
        'resources/tracker/lib/db.js',
        'resources/tracker/tracker.js',
      ]);
    }));

  test('only files, never directories', () =>
    withTempDir((dir) => {
      // A directory in the manifest gives the deletion phase a chance to remove a **non-empty**
      // directory — and the user's database sits in resources/tracker/data/
      makeTree(dir);
      const { files } = buildManifest(dir, '1.1.4');
      assert.equal(files.includes('locales'), false);
      assert.equal(files.includes('resources'), false);
      assert.equal(files.includes('resources/tracker'), false);
    }));

  test('the manifest carries the version', () =>
    withTempDir((dir) => {
      makeTree(dir);
      assert.equal(buildManifest(dir, '1.1.4').version, '1.1.4');
    }));

  test('a generated manifest can be parsed by its own parser', () =>
    withTempDir((dir) => {
      makeTree(dir);
      const m = buildManifest(dir, '1.1.4');
      assert.deepEqual(parseManifest(JSON.stringify(m)), m);
    }));

  test('user data is not in the package, so it naturally never reaches the manifest', () =>
    withTempDir((dir) => {
      // The safety is constructed, not filtered: the manifest is generated from the unpacked
      // directory, and config.json / data/ were never in the unpacked directory at all
      // (extraResources is an allow-list)
      makeTree(dir);
      const { files } = buildManifest(dir, '1.1.4');
      assert.equal(
        files.some((f) => /config\.json|steam\.db|\bdata\//.test(f)),
        false
      );
    }));
});

// ================================================================ manifest validation

describe('manifest path validation', () => {
  test('ordinary relative paths pass', () => {
    for (const p of ['App.exe', 'locales/zh-CN.pak', 'resources/tracker/lib/db.js']) {
      assert.equal(isSafeManifestPath(p), true, `${p} was wrongly judged unsafe`);
    }
  });

  test('anything out of bounds is refused', () => {
    // The manifest comes off the internet, and its only use is to feed a deletion loop
    for (const p of [
      '../outside.txt',
      'a/../../outside.txt',
      '/etc/passwd',
      '\\\\server\\share\\x',
      'C:\\Windows\\System32\\x.dll',
      './x',
      '',
      'a//b',
      'a\0b',
    ]) {
      assert.equal(isSafeManifestPath(p), false, `${JSON.stringify(p)} should be refused`);
    }
  });

  test('anything that is not a string is refused', () => {
    for (const p of [null, undefined, 17, {}, []]) {
      assert.equal(isSafeManifestPath(p), false);
    }
  });

  test('one out-of-bounds path rejects the whole manifest', () => {
    // Filtering entry by entry is wrong: a manifest carrying an out-of-bounds path is itself
    // evidence that we did not publish it, and the rest is equally untrustworthy
    assert.throws(
      () => parseManifest(JSON.stringify({ version: '1.1.4', files: ['ok.txt', '../evil'] })),
      /越界路径/
    );
  });

  test('a manifest of the wrong shape throws outright', () => {
    assert.throws(() => parseManifest('不是 json'), /合法的 JSON/);
    assert.throws(() => parseManifest('{}'), /没有文件列表/);
    assert.throws(() => parseManifest('{"files": []}'), /没有文件列表/);
    assert.throws(() => parseManifest('{"files": "a.txt"}'), /没有文件列表/);
  });
});

// ================================================================ the helper script

describe('the helper script — three constraints', () => {
  const render = (over = {}) =>
    renderHelperScript({
      processId: 4242,
      appDir: 'D:\\App',
      exePath: 'D:\\App\\X.exe',
      zipPath: 'C:\\tmp\\new.zip',
      manifestPath: `D:\\App\\${MANIFEST_NAME}`,
      newManifestPath: 'C:\\tmp\\new-manifest.json',
      logPath: 'C:\\tmp\\update.log',
      ...over,
    });

  test('constraint 1: delete by the manifest, never by a keep-list', () => {
    const s = render();
    assert.match(s, /foreach \(\$rel in \$entries\)/, 'the manifest is not being walked — the deletion criterion has changed');
    assert.match(s, /\.files/, 'the file list is not taken from the manifest');
    // "empty the folder then unzip" is exactly the form being avoided. Any one of these shapes
    // appearing means what is deleted is no longer "what the previous version installed"
    assert.doesNotMatch(
      s,
      /Remove-Item[^\n]*\$AppDir\s*(\)|$|\s-)/m,
      'a deletion of the whole AppDir appeared — that would delete the user database'
    );
    assert.doesNotMatch(s, /\$AppDir\\\*/, 'a $AppDir\\* wildcard deletion appeared');
    assert.doesNotMatch(s, /-Exclude/i, '-Exclude appeared — that is a keep-list, the wrong direction');
  });

  test('constraint 1: delete files only, and verify the path is in bounds first', () => {
    // **The slice has to be into the deletion loop before matching.** Searching the whole script
    // for `-PathType Leaf` runs empty: the "is the manifest there" check carries the same
    // parameter, so removing the protection inside the deletion loop still leaves the assertion
    // passing. Mutation testing caught it; reading the code did not — the same class of error as
    // the one satisfied by its own comment in tray.test.js, merely in a different disguise
    const s = render();
    const loop = s.slice(s.indexOf('foreach ($rel in $entries)'), s.indexOf('Log "按清单删除'));
    assert.ok(loop.length > 0, 'cannot find the deletion loop — this check has lost its target');
    assert.match(loop, /-PathType Leaf/, 'the deletion loop has no -PathType Leaf — a directory could be deleted too');
    assert.match(loop, /StartsWith\(\$AppDirFull/, 'the deletion loop has no bounds check');
  });

  test('constraint 1: a directory is deleted only when it is empty', () => {
    // resources/tracker/data/ holds the database and is never empty — "delete only empty
    // directories" is the entire safety boundary here
    const s = render();
    const prune = s.slice(s.indexOf('-Recurse -Directory'));
    assert.match(
      prune.slice(0, 400),
      /if \(-not \(Get-ChildItem/,
      'no emptiness check before deleting a directory — a non-empty one would be deleted with its contents'
    );
  });

  test('constraint 2: with no manifest, fall back to overwriting rather than guessing', () => {
    const s = render();
    const guard = s.indexOf('if (Test-Path -LiteralPath $Manifest -PathType Leaf)');
    const loop = s.indexOf('foreach ($rel in $entries)');
    const extract = s.indexOf('Expand-Archive');
    assert.ok(guard > 0, 'there is no "is the manifest there" check');
    assert.ok(guard < loop && loop < extract, 'the deletion loop has to be wrapped by the manifest-existence check');

    // The else branch must contain no deletion at all
    const elseBranch = s.slice(s.indexOf('} else {', loop), extract);
    assert.doesNotMatch(elseBranch, /Remove-Item/, 'things are still being deleted with no manifest — that is guessing');
  });

  test('deletion has to come before extraction', () => {
    // This is the whole reason "deleting too much is harmless": extraction puts the program files
    // back. The other way round, newly installed files are deleted by the old manifest and the
    // upgrade ends as a broken install
    const s = render();
    assert.ok(
      s.indexOf('foreach ($rel in $entries)') < s.indexOf('Expand-Archive'),
      'extraction was moved ahead of deletion — new files would be deleted by the old manifest'
    );
  });

  test('constraint 3: wait for the process to exit before acting', () => {
    const s = render();
    const wait = s.indexOf('Wait-Process');
    assert.ok(wait > 0, 'the main process is not waited for — Windows refuses to replace a running exe');
    assert.ok(wait < s.indexOf('foreach ($rel in $entries)'), 'the wait has to come before the deletion');
    assert.ok(wait < s.indexOf('Expand-Archive'), 'the wait has to come before the extraction');
    assert.match(s, /\$ProcessId\s+= 4242/, 'the PID was not passed into the script');
    assert.doesNotMatch(s, /\$Pid\s*=/i, '$Pid is a read-only PowerShell automatic variable and cannot be assigned');
  });

  test('after installing, write the new manifest; if this release carries none, clear the old one', () => {
    const withManifest = render();
    assert.match(withManifest, /Copy-Item -LiteralPath \$NewManifest/, 'the new manifest is not written');

    const without = render({ newManifestPath: '' });
    assert.match(without, /\$NewManifest = ''/, 'an empty manifest path did not land correctly in the script');
    // Keeping a manifest that describes the wrong version does no damage (deletion comes before
    // extraction), but it points any investigation in the wrong direction
    assert.match(without, /Remove-Item -LiteralPath \$Manifest/, 'the stale old manifest is not cleared');
  });

  test('single quotes in a path are escaped correctly', () => {
    // A missed escape makes the script a syntax error in a detached process with no console,
    // presenting as "the program quit itself and never came back", with no message at all
    const s = render({ appDir: "D:\\it's here" });
    assert.match(s, /\$AppDir\s+= 'D:\\it''s here'/);
  });

  test('a failure has to speak up, and try to bring the old program back', () => {
    const s = render();
    assert.match(s, /MessageBox/, 'silent on failure — the user faces a program that quit itself and did not come back');
    // Slice from the first log line of the outer catch. Using lastIndexOf('} catch {') slices into
    // the empty inner catch, and the assertion then matches against two lines of code
    const catchBlock = s.slice(s.indexOf('Log "失败'));
    assert.match(catchBlock, /Start-Process -FilePath \$ExePath/, 'no attempt to relaunch after a failure');
  });

  test('the script is saved with a BOM', () =>
    withTempDir((dir) => {
      // Without a BOM, PowerShell 5.1 reads a .ps1 in the ANSI code page. Chinese paths and
      // Chinese messages all become question marks, and a path of question marks is a file that
      // cannot be found
      const p = join(dir, 'apply.ps1');
      writeHelperScript(p, render());
      assert.deepEqual([...readFileSync(p).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    }));

  test(
    'what is generated is valid PowerShell',
    { skip: process.platform !== 'win32' ? 'verified on Windows only' : false },
    () =>
      withTempDir((dir) => {
        // This is the one check in this file that actually runs something. The template literal
        // carries JS's \\ and ` alongside PowerShell's \ and `, and one escape wrong is a syntax
        // error — in a process with no console, where nobody would ever see it
        const p = join(dir, 'apply.ps1');
        writeHelperScript(p, render({ appDir: 'D:\\有中文的 路径' }));
        const probe = join(dir, 'probe.ps1');
        writeFileSync(
          probe,
          '\ufeff$e = $null\n' +
            `$null = [System.Management.Automation.Language.Parser]::ParseFile('${p.replace(/'/g, "''")}', [ref]$null, [ref]$e)\n` +
            'if ($e -and $e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 } else { exit 0 }\n',
          'utf8'
        );
        const out = execFileSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
          { encoding: 'utf8' }
        );
        assert.equal(out.trim(), '', `the generated PowerShell failed to parse: ${out}`);
      })
  );
});

// ================================================================ wiring (source assertions)

describe('the wiring in main.js', () => {
  const checkBlock = () => blockFrom(mainSrc, 'async function checkForUpdate');

  test('a failed check has to be silent', () => {
    // Being offline is normal. Popping an error box with no network would first turn this feature
    // into something that pesters the user once a day, and then get it switched off
    const body = checkBlock();
    const fetchCatch = body.slice(body.indexOf('await fetchRelease'), body.indexOf('tag_name'));
    assert.match(fetchCatch, /catch/, 'the update check is not wrapped in a try — being offline throws uncaught');
    assert.doesNotMatch(fetchCatch, /showErrorBox|showMessageBox/, 'a failed check popped a box');
  });

  test('it must not quit before verification passes', () => {
    // The other order is: the program quits first and then discovers the download was a bad file —
    // the user faces a program that closed for no reason
    const body = checkBlock();
    assert.ok(
      body.indexOf('downloadVerified') < body.indexOf('app.quit()'),
      'quitting before verifying — on a failed verification the user already has no program to run'
    );
    assert.match(body, /downloadVerified/, 'the download does not go through the verified path');
  });

  test('the helper receives our own PID', () => {
    // Pass the wrong one and Wait-Process returns immediately, so the replacement happens while
    // the exe is still locked
    assert.match(checkBlock(), /processId: process\.pid/, 'the PID is not the current process');
  });

  test('a skipped version really is written to disk', () => {
    const body = checkBlock();
    const dismissed = body.slice(body.indexOf('if (!choice.update)'));
    assert.match(
      dismissed.slice(0, 300),
      /if \(choice\.skip\) writeUpdateState/,
      'the do-not-prompt-for-this-version box was ticked without being persisted — it prompts again on the next launch'
    );
  });

  test('it does not check only once at startup', () => {
    // Once it lives in the tray, "startup" becomes a rare event. Checking only once means a user
    // who leaves it running for days never gets an update prompt, with no error at all
    const body = blockFrom(mainSrc, 'function scheduleUpdateCheck');
    // Look only at the callback body, so the function declaration line cannot satisfy the assertion
    const callback = body.slice(body.indexOf('setTimeout'));
    assert.match(
      callback,
      /scheduleUpdateCheck\([^)]*UPDATE_CHECK_INTERVAL_MS/,
      'the timer does not schedule the next one — it checks once and never again'
    );
    assert.match(mainSrc, /UPDATE_CHECK_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/, 'the check interval is not one day');
  });

  test('the timer is cleared on quit', () => {
    assert.match(
      blockFrom(mainSrc, "app.on('before-quit'"),
      /clearTimeout\(updateTimer\)/,
      'before-quit does not clear the update timer'
    );
  });

  test('dev mode does not check', () => {
    // Under npm start there is no zip directory to replace at all
    assert.match(checkBlock(), /!app\.isPackaged/, 'dev mode checks for updates too');
  });

  test('the update prompt must never be a native dialog', () => {
    /**
     * **This assertion is inverted, and precisely because it is inverted it guards a real bug.**
     *
     * The first version used `dialog.showMessageBox`. In a real rehearsal it flashed and vanished,
     * with the promise returning `response: 420` at once — a value outside the button range.
     * Cutting the options down to `{ message }`, switching to the synchronous version, attaching a
     * parent window, not attaching one: ten combinations, all 420; while a plain Win32 MessageBox
     * on the same machine stood there perfectly.
     *
     * This is the second time this repository hit the same class of thing (the first was the
     * renderer's `window.confirm`, which made guide generation entirely dead in the packaged
     * build). The conclusion at the time — "native dialogs belong to the main process" — was too
     * narrow: the main process's are equally unusable. The fix is the same as it was then: use a page.
     */
    const body = checkBlock();
    assert.doesNotMatch(
      body,
      /dialog\.showMessageBox/,
      'the update prompt went back to a native dialog — measured, it vanishes on its own, raises no error, and the feature silently stops working'
    );
    assert.match(body, /await askUpdate\(/, 'it does not go through the web-page prompt');

    const showAt = body.indexOf('showWindow()');
    const askAt = body.indexOf('askUpdate(');
    assert.ok(showAt > 0 && showAt < askAt, 'bring the window to the front before asking');
  });

  test('the prompt window reports back via page-title-updated, and closing the window counts as 「以后再说」', () => {
    // The needle has to carry the parameter list: the first `{` of
    // `function askUpdate({ version, sizeMb })` is the **destructured parameter**, and blockFrom
    // would balance from there, slicing out nothing but the parameters
    const body = blockFrom(mainSrc, 'function askUpdate({ version, sizeMb })');
    assert.match(body, /page-title-updated/, 'the title report is not listened for — the user clicks and nobody receives it');
    assert.match(body, /parsePromptChoice/, 'the reported title is not parsed');
    // Asking a question and then hanging forever because the user closed the window is worse than
    // not asking
    assert.match(
      body,
      /win\.on\('closed'[\s\S]{0,120}?update: false/,
      'closing the window is not treated as "later" — that path leaves the promise never resolving'
    );
    // The page needs no privileges at all, so it gets none
    assert.match(body, /nodeIntegration: false/, 'the prompt window enabled nodeIntegration');
    assert.match(body, /contextIsolation: true/, 'the prompt window disabled contextIsolation');
  });

  test('the prompt page is self-contained, and all three exits are there', () => {
    const html = renderUpdatePromptHtml({ version: '1.1.4', sizeMb: 133 });
    assert.match(html, /有新版本 1\.1\.4/);
    assert.match(html, /133 MB/);
    assert.match(html, /立即更新/);
    assert.match(html, /以后再说/);
    assert.match(html, /不再提示这个版本/);
    assert.match(html, /document\.title\s*=/, 'the page does not write the choice back into the title — the main process receives nothing');
    // A data: URL cannot load external resources, and this window should work offline anyway
    assert.doesNotMatch(html, /https?:\/\//, 'the page references an external resource');
    assert.doesNotMatch(html, /<img|<link/i, 'the page references an external resource');
  });

  test('the version number is escaped before it reaches the page', () => {
    // The version comes from GitHub's tag_name — data off the internet, not a constant of ours
    const html = renderUpdatePromptHtml({ version: '<img src=x onerror=alert(1)>', sizeMb: 1 });
    assert.doesNotMatch(html, /<img src=x/, 'tag_name was inserted into the HTML verbatim');
    assert.match(html, /&#60;img/, 'it was not escaped');
  });

  test('the title report recognises only its own form', () => {
    assert.deepEqual(parsePromptChoice('choice:update:0'), { update: true, skip: false });
    assert.deepEqual(parsePromptChoice('choice:update:1'), { update: true, skip: true });
    assert.deepEqual(parsePromptChoice('choice:later:1'), { update: false, skip: true });
    // The page's own <title> fires page-title-updated first and must not be misread as a choice
    assert.equal(parsePromptChoice('Steam 成就追踪器'), null);
    assert.equal(parsePromptChoice('choice:update'), null);
    assert.equal(parsePromptChoice('choice:maybe:1'), null);
    assert.equal(parsePromptChoice(''), null);
    assert.equal(parsePromptChoice(null), null);
  });

  test('no prompt before the window exists, and retry after a short interval', () => {
    // When the server starts slowly (waitForServer allows up to 15 seconds) the window appears
    // after the first check. Jumping straight to 24 hours later throws away the day's only chance,
    // with no sign of it
    const body = checkBlock();
    const guardAt = body.indexOf('if (!mainWindow)');
    assert.ok(guardAt > 0, 'there is no check for whether the window exists');
    // **Assert on what the branch returns, not merely that the if is still there.** Mutation
    // testing proved the latter runs empty: change the branch body to return true and that if line
    // is untouched while the assertion still passes — and the scheduler treats the round as
    // "checked" and waits until tomorrow
    const branch = body.slice(guardAt, body.indexOf('}', guardAt));
    assert.match(
      branch,
      /return false;/,
      'it does not return false when the window is not ready — the scheduler counts it as checked and stops checking for a whole day'
    );

    const sched = blockFrom(mainSrc, 'function scheduleUpdateCheck');
    assert.match(
      sched,
      /checked \? UPDATE_CHECK_INTERVAL_MS : UPDATE_CHECK_RETRY_MS/,
      'it waits a day even after an unsuccessful check — a slow machine gets no update prompt all day'
    );
  });

  test('the helper must never be started with detached again', () => {
    /**
     * Bought with one real incident. The first version was `spawn(..., { detached: true })`, the
     * log said the helper had started, and it was in fact killed along with app.quit(), so the
     * program quit and never came back.
     *
     * In a real session, four ways of starting a fake helper were each followed immediately by
     * app.quit(). Measured: detached ✗ / plain spawn ✗ / `cmd /c start` ✓ / WMI ✓ —
     * that is the signature of a **job object**, and Windows's DETACHED_PROCESS cannot escape one.
     */
    const launch = blockFrom(mainSrc, 'async function launchHelper({ scriptPath, renderedScript, aliveMarkerPath })');
    assert.doesNotMatch(
      launch,
      /detached:\s*true/,
      'the helper is started with detached again — it dies with app.quit() and reports nothing'
    );
    assert.match(launch, /primaryLaunch\(/, 'it does not use a launch method that escapes the job object');
    assert.match(launch, /fallbackLaunch\(/, 'there is no fallback launch method');
    // A spawn launch failure is an async error event, not a thrown exception
    assert.match(launch, /child\.on\('error'/, 'spawn error is not listened for — a failed launch presents as a successful one');
  });

  test('quit only after the helper is confirmed alive, and do not quit if it never reports in', () => {
    // "Started" and "alive" are two different things. Quitting without waiting gives the user a
    // program that closed itself and never returns — which is exactly what happened in the real
    // rehearsal
    const body = checkBlock();
    const launchAt = body.indexOf('await launchHelper(');
    const quitAt = body.indexOf('app.quit()');
    assert.ok(launchAt > 0 && launchAt < quitAt, 'it quit without waiting for confirmation');
    const guard = body.slice(launchAt, quitAt);
    assert.match(guard, /if \(!launched\)/, 'there is no "do not quit if it cannot start" branch');
    assert.match(guard, /showErrorBox/, 'it cannot start and says nothing');
    assert.match(guard, /return true;/, 'it cannot start and still carries on to app.quit()');
  });

  test('both launch paths escape the job object', () => {
    const primary = primaryLaunch({ scriptPath: 'C:\\t\\apply.ps1', psPath: 'C:\\ps.exe' });
    assert.equal(primary.file, 'cmd', 'the primary path is not cmd start — a plain spawn cannot escape the job object');
    assert.deepEqual(primary.args.slice(0, 4), ['/c', 'start', '""', '/min']);
    // The empty title argument has to be given: without it, start takes the first quoted path that
    // follows as the window title
    assert.equal(primary.args[2], '""', 'start is missing the empty title argument, so a path with spaces is taken as the title');
    assert.ok(primary.args.includes('-File'), 'the primary path should use a script file (a short command line, well under the cmd 8191 limit)');

    const fallback = fallbackLaunch({ script: 'Write-Output 1', psPath: 'C:\\ps.exe' });
    assert.equal(fallback.file, 'C:\\ps.exe');
    const joined = fallback.args.join(' ');
    assert.match(joined, /Win32_Process/, 'the fallback path does not create the process through WMI');
    assert.match(joined, /-EncodedCommand/, 'the fallback path should use EncodedCommand — the execution policy does not reach it');
  });

  test('the first thing the helper does is report in', () => {
    // Reporting in has to come before waiting for the process to exit: the app is waiting on that
    // file, and one step later means the app waits 15 seconds for nothing and then declares failure
    const s = renderHelperScript({
      processId: 1,
      appDir: 'D:\\App',
      exePath: 'D:\\App\\X.exe',
      zipPath: 'C:\\t\\n.zip',
      manifestPath: 'D:\\App\\update-manifest.json',
      logPath: 'C:\\t\\u.log',
      aliveMarkerPath: 'C:\\t\\helper-alive.txt',
    });
    const aliveAt = s.indexOf('Set-Content -LiteralPath $AliveMarker');
    assert.ok(aliveAt > 0, 'the helper does not write the alive marker — the app waits forever and then declares the update failed');
    assert.ok(aliveAt < s.indexOf('Wait-Process'), 'reporting in has to come before waiting for the main process');
    assert.ok(aliveAt < s.indexOf('Expand-Archive'), 'reporting in has to come before doing anything');
  });

  test('dev mode does not even start the timer', () => {
    assert.match(
      blockFrom(mainSrc, 'app.whenReady()'),
      /app\.isPackaged && autoUpdateEnabled\(\)/,
      'dev mode started the update timer too'
    );
  });

  test('it can be turned off entirely', () => {
    // One of the three fatal details in the design document
    assert.match(mainSrc, /function autoUpdateEnabled/, 'there is no switch to turn auto-update off');
    assert.match(
      blockFrom(mainSrc, 'app.whenReady()'),
      /autoUpdateEnabled\(\)/,
      'the switch is not wired to the actual scheduling'
    );
  });
});

describe('packaging and release', () => {
  test('updater.js has to be in build.files', () => {
    // Missing it breaks only the **packaged** build: npm start is fine throughout while the
    // released package fails at launch with a module not found. The same class as the icon.ico one
    const pkg = JSON.parse(
      readFileSync(new URL('../launcher/package.json', import.meta.url), 'utf8')
    );
    assert.ok(pkg.build.files.includes('updater.js'), 'build.files does not contain updater.js');
    assert.ok(pkg.build.files.includes('main.js'));
  });

  test('postbuild generates the manifest first, then copies local.config.json', () => {
    // In the other order that machine-local config lands in the manifest and is deleted as a
    // program file by the next update — the user's data directory silently reverts to the default
    // location, which looks like "all the data is gone"
    const manifestAt = postbuildSrc.indexOf('buildManifest(');
    const copyAt = postbuildSrc.indexOf('copyFileSync(localCfg');
    assert.ok(manifestAt > 0, 'postbuild does not generate the manifest');
    assert.ok(copyAt > 0, 'postbuild no longer copies local.config.json?');
    assert.ok(manifestAt < copyAt, 'manifest generation was moved after the local.config.json copy');
  });

  test('a machine-local file sneaking into the manifest has to be recognised', () => {
    /**
     * This used to be a pure source assertion ("is that if still in postbuild"), and mutation
     * testing proved it ran empty: turn the guard into a constant false and that text is still
     * there, with the assertion still passing. A source assertion can only prove some characters
     * are still there; it cannot prove they still do anything.
     *
     * So the judgement itself moved into updater.js — what is tested here now is behaviour, and a
     * broken guard goes red.
     */
    assert.deepEqual(machineLocalEntries(['App.exe', 'lib/db.js']), [], 'a clean manifest was falsely reported');
    assert.deepEqual(machineLocalEntries(['App.exe', 'local.config.json']), ['local.config.json']);
    // Neither case nor separator should be a reason to slip through
    assert.deepEqual(machineLocalEntries(['Local.Config.JSON']), ['Local.Config.JSON']);
    assert.deepEqual(machineLocalEntries(['a/b/local.config.json']), ['a/b/local.config.json']);
    assert.deepEqual(machineLocalEntries(['a\\b\\local.config.json']), ['a\\b\\local.config.json']);
    // Match the whole filename only; a suffix must not collide with another file
    assert.deepEqual(machineLocalEntries(['my-local.config.json.bak']), []);
  });

  test('postbuild really uses it to block, and a failure has to make the build red', () => {
    assert.match(postbuildSrc, /machineLocalEntries\(manifest\.files\)/, 'postbuild does not check the manifest');
    const guard = postbuildSrc.slice(postbuildSrc.indexOf('machineLocalEntries(manifest.files)'));
    assert.match(
      guard.slice(0, 900),
      /process\.exit\(1\)/,
      'it was found without failing the build — which amounts to not finding it'
    );
    const guardAt = postbuildSrc.indexOf('machineLocalEntries(manifest.files)');
    const writeAt = postbuildSrc.indexOf('writeFileSync(manifestPath');
    assert.ok(guardAt < writeAt, 'the check has to come before the manifest is written, or the bad manifest is already on disk');
  });

  test('the manifest filename carries the version, matching the zip', () => {
    assert.match(
      postbuildSrc,
      /\$\{PRODUCT\}-\$\{version\}-manifest\.json/,
      'the manifest filename carries no version — the release page cannot tell which build it belongs to'
    );
  });
});
