/**
 * Regression tests for backup / restore
 * ------------------------------------------------
 * **Every kind of failure on this path eats the user's data**, and most of them silently:
 * a restore is a DELETE followed by an INSERT, and stopping halfway, moving the wrong
 * columns, or not moving anything at all all leave a database that "looks normal, just with
 * things missing". So nearly everything pinned here is on the "did not take effect" and
 * "took effect too far" sides rather than the happy path itself.
 *
 * The zip container layer is covered separately in zip.test.js; here it is treated as a
 * working black box.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, insertGame, setGameField, updateGameStats, upsertGuide, getGame, allGames } from '../lib/db.js';
import { createBackup, applyBackup, inspectBackup, backupName, BACKUP_VERSION } from '../lib/backup.js';
import { zipWrite, zipRead } from '../lib/zip.js';

/** A database carrying every "marker Steam cannot give back" — which is precisely why backups exist */
function seedDb(dbPath) {
  const db = openDb(dbPath);
  insertGame(db, { appid: '294100', name: 'RimWorld' });
  updateGameStats(db, '294100', { achieved: 40, total: 100 });
  setGameField(db, '294100', 'favorite', 1);
  setGameField(db, '294100', 'priority', 1);
  insertGame(db, { appid: '620', name: 'Portal 2', status: 'Manual' });
  setGameField(db, '620', 'sync_locked', 1);
  setGameField(db, '620', 'family', 1);
  upsertGuide(db, { appid: '294100', name: 'RimWorld', url: 'rimworld.md', kind: 'local' });
  return db;
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('backup / restore', () => {
  test('round trip: ♥/★/family/Manual/lock — the columns Steam cannot give back have to come back verbatim', () => {
    const src = tmp('sat-bk-src-');
    const dst = tmp('sat-bk-dst-');
    try {
      const srcGuides = join(src, 'guides');
      mkdirSync(srcGuides, { recursive: true });
      writeFileSync(join(srcGuides, 'rimworld.md'), '# RimWorld\n\nappid: 294100\n\n- [x] 第一步\n');
      const srcCfg = join(src, 'config.json');
      writeFileSync(srcCfg, JSON.stringify({ steamApiKey: 'KEY123', steamId: '76561190000000000' }));

      const db = seedDb(join(src, 'steam.db'));
      const { zip, manifest } = createBackup({ db, configPath: srcCfg, guidesDir: srcGuides, appVersion: '9.9.9' });
      db.close();

      assert.equal(manifest.counts.games, 2);
      assert.equal(manifest.hasConfig, true);
      assert.equal(manifest.guideFiles, 1);

      // A brand-new machine: an empty database, no guides, no config
      const dstGuides = join(dst, 'guides');
      const dstCfg = join(dst, 'config.json');
      const db2 = openDb(join(dst, 'steam.db'));
      const r = applyBackup({ db: db2, buf: zip, configPath: dstCfg, guidesDir: dstGuides });

      assert.equal(r.tables.games, 2);
      assert.equal(r.guideFiles, 1);
      assert.equal(r.config, true);

      const rim = getGame(db2, '294100');
      assert.equal(rim.favorite, 1, 'the ♥ did not come back');
      assert.equal(rim.priority, 1, 'the ★ did not come back');
      assert.equal(rim.achieved, 40);
      const portal = getGame(db2, '620');
      assert.equal(portal.status, 'Manual');
      assert.equal(portal.sync_locked, 1, 'the lock did not come back');
      assert.equal(portal.family, 1, 'the family marker did not come back');

      assert.match(readFileSync(join(dstGuides, 'rimworld.md'), 'utf8'), /- \[x\] 第一步/);
      assert.equal(JSON.parse(readFileSync(dstCfg, 'utf8')).steamApiKey, 'KEY123', 'the credentials did not travel with it');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('a restore replaces rather than merges — rows already in the target database have to disappear', () => {
    // Merging leaves a pile of games that were never owned, with no warning at all. This is
    // the direction a restore is most easily written wrong in: forget the DELETE and one
    // INSERT OR REPLACE turns it into a merge
    const src = tmp('sat-bk-src-');
    const dst = tmp('sat-bk-dst-');
    try {
      const db = seedDb(join(src, 'steam.db'));
      const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
      db.close();

      const db2 = openDb(join(dst, 'steam.db'));
      insertGame(db2, { appid: '999999', name: '这台机器上原有的游戏' });
      insertGame(db2, { appid: '294100', name: '同一个 appid 但名字不同' });
      applyBackup({ db: db2, buf: zip, configPath: null, guidesDir: join(dst, 'guides') });

      assert.equal(allGames(db2).length, 2, 'the pre-existing rows are still there, which means it merged rather than replaced');
      assert.equal(getGame(db2, '999999'), undefined);
      assert.equal(getGame(db2, '294100').name, 'RimWorld');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('an older backup missing a few columns still restores (by intersection), with the extra columns left at their defaults', () => {
    // A real scenario: backups from before 1.1.9 have no cover_url. SELECT * fails outright on
    // a column count mismatch, and that is the most painful kind of failure — "a backup from
    // three months ago cannot be restored"
    const src = tmp('sat-bk-old-');
    const dst = tmp('sat-bk-dst-');
    try {
      const db = seedDb(join(src, 'steam.db'));
      db.exec('ALTER TABLE games DROP COLUMN cover_url');
      const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
      db.close();

      const db2 = openDb(join(dst, 'steam.db'));
      const r = applyBackup({ db: db2, buf: zip, configPath: null, guidesDir: join(dst, 'guides') });
      assert.equal(r.tables.games, 2);
      assert.equal(getGame(db2, '294100').cover_url, null, 'a missing column should be its default, not misaligned data');
      assert.equal(getGame(db2, '294100').favorite, 1, 'the remaining columns still have to line up');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('a ../ inside the zip must not write a file outside guides/', () => {
    // **The landing name has to differ every time.** The first version hardcoded pwned.md, and
    // since guides/ is under dst, the landing spot for ../../ is tmpdir() itself — so using
    // this for mutation testing (deleting the guard to watch it go red) really did leave a file
    // there, and the next run failed because of **the previous round's leftover**.
    // What the assertion has to say is "this round did not escape", not "there has never been a
    // file at this path".
    const marker = `sat-slip-${process.pid}-${Date.now()}.md`;
    const dst = tmp('sat-bk-slip-');
    const escaped = [join(dst, marker), join(tmpdir(), marker)];
    try {
      const src = tmp('sat-bk-seed-');
      // The backup has to contain one **ordinary** guide file, or the "an ordinary entry still
      // lands" assertion below would also be satisfied by a guard that writes nothing — and then
      // this test would only prove the program did nothing
      mkdirSync(join(src, 'guides'), { recursive: true });
      writeFileSync(join(src, 'guides', 'ok.md'), '# 正常攻略\n');
      const db = seedDb(join(src, 'steam.db'));
      const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
      db.close();
      rmSync(src, { recursive: true, force: true });

      // Put an escaping entry back into the zip
      const entries = [...zipRead(zip)].map(([name, data]) => ({ name, data }));
      entries.push({ name: `guides/../../${marker}`, data: Buffer.from('x') });
      const evil = zipWrite(entries);

      const db2 = openDb(join(dst, 'steam.db'));
      applyBackup({ db: db2, buf: evil, configPath: null, guidesDir: join(dst, 'guides') });
      db2.close();

      for (const p of escaped) assert.equal(existsSync(p), false, `escaped and wrote to ${p}`);
      // The guard has to **pick that one out**, not refuse the whole batch
      assert.ok(existsSync(join(dst, 'guides', 'ok.md')), 'the escape was blocked, but the ordinary guide was not written either');
    } finally {
      for (const p of escaped) rmSync(p, { force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  /**
   * **A backslash is another spelling of the same hole, and the test above cannot reach it.**
   *
   * The zip spec says entry names use forward slashes — but that is a spec, not a validator,
   * and an attacker hand-writing `guides/..\..\x.md` is entirely legal. A guard that only
   * `split('/')`s sees `..\..` as one whole "file name", which passes the `.includes('..')`
   * check, and then `join()` on Windows parses the backslashes into a real climb. Measured, it
   * lands under `D:\GitHub\`.
   *
   * The third case is a **sibling directory sharing the prefix**: `guides-evil` is a string
   * prefix of `guides`, and a containment check missing the separator lets it through — the
   * same trap as `resolveGuidePath` and the `/fonts/` path, which has now appeared three times
   * in this project.
   */
  const SLIP_CASES = [
    ['backslash climb', (m) => `guides/..\\..\\${m}`, (dst) => join(dst, '..', '..')],
    ['mixed slashes', (m) => `guides/..\\../${m}`, (dst) => join(dst, '..', '..')],
    ['sibling directory sharing the prefix', (m) => `guides/../guides-evil/${m}`, (dst) => join(dst, 'guides-evil')],
    ['a single-dot segment', (m) => `guides/./../${m}`, (dst) => join(dst, '..')],
  ];

  for (const [label, entryName, landingDir] of SLIP_CASES) {
    test(`zip-slip: ${label} is likewise blocked outside guides/`, () => {
      const marker = `sat-slip-${label.length}-${process.pid}-${Date.now()}.md`;
      const dst = tmp('sat-bk-slip2-');
      // The landing spot is computed per shape, plus two generic fallback locations
      const escaped = [
        join(landingDir(dst), marker),
        join(dst, marker),
        join(tmpdir(), marker),
      ];
      try {
        const src = tmp('sat-bk-seed2-');
        mkdirSync(join(src, 'guides'), { recursive: true });
        writeFileSync(join(src, 'guides', 'ok.md'), '# 正常攻略\n');
        const db = seedDb(join(src, 'steam.db'));
        const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
        db.close();
        rmSync(src, { recursive: true, force: true });

        const entries = [...zipRead(zip)].map(([name, data]) => ({ name, data }));
        entries.push({ name: entryName(marker), data: Buffer.from('x') });

        const db2 = openDb(join(dst, 'steam.db'));
        const r = applyBackup({
          db: db2, buf: zipWrite(entries), configPath: null, guidesDir: join(dst, 'guides'),
        });
        db2.close();

        for (const p of escaped) assert.equal(existsSync(p), false, `escaped and wrote to ${p}`);
        assert.ok(existsSync(join(dst, 'guides', 'ok.md')), 'the escape was blocked, but the ordinary guide was not written either');
        // What it counts can only be that one ordinary file — counting the malicious entry in the report is a lie
        assert.equal(r.guideFiles, 1, 'the malicious entry was counted into "how many guide files were written"');
      } finally {
        for (const p of escaped) rmSync(p, { force: true });
        rmSync(join(dst, '..', 'guides-evil'), { recursive: true, force: true });
        rmSync(dst, { recursive: true, force: true });
      }
    });
  }

  test('a bad file has to be stopped before the database is touched', () => {
    // The order is critical: DELETE first and then discover the zip is unreadable, and the
    // user's data is gone while the backup never arrived
    const dst = tmp('sat-bk-bad-');
    try {
      const db2 = openDb(join(dst, 'steam.db'));
      insertGame(db2, { appid: '111', name: '不该被删掉' });

      const notZip = Buffer.from('这不是 zip'.repeat(20));
      assert.throws(() => applyBackup({ db: db2, buf: notZip, configPath: null, guidesDir: join(dst, 'guides') }), /ZIP|zip/);

      const noDb = zipWrite([{ name: 'manifest.json', data: Buffer.from('{}') }]);
      assert.throws(() => applyBackup({ db: db2, buf: noDb, configPath: null, guidesDir: join(dst, 'guides') }), /steam\.db/);

      assert.equal(getGame(db2, '111').name, '不该被删掉', 'a failed restore deleted the original data');
      db2.close();
    } finally {
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('a truncated zip has to report a checksum failure rather than moving half a database in', () => {
    const src = tmp('sat-bk-trunc-');
    try {
      const db = seedDb(join(src, 'steam.db'));
      const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
      db.close();
      const half = Buffer.concat([zip.subarray(0, zip.length - 200), zip.subarray(zip.length - 22)]);
      assert.throws(() => inspectBackup(half));
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test('a backup from a newer version is refused explicitly rather than forced through the old format', () => {
    const zip = zipWrite([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: BACKUP_VERSION + 1 })) },
      { name: 'steam.db', data: Buffer.from('x') },
    ]);
    assert.throws(() => inspectBackup(zip), /更新的版本/);
  });

  test('a broken manifest should not block a restore — the data is in steam.db, not in the manifest', () => {
    const src = tmp('sat-bk-mf-');
    const dst = tmp('sat-bk-dst-');
    try {
      const db = seedDb(join(src, 'steam.db'));
      const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
      db.close();

      const entries = [...zipRead(zip)].map(([name, data]) =>
        name === 'manifest.json' ? { name, data: Buffer.from('{ 这不是 json') } : { name, data }
      );
      const db2 = openDb(join(dst, 'steam.db'));
      const r = applyBackup({ db: db2, buf: zipWrite(entries), configPath: null, guidesDir: join(dst, 'guides') });
      assert.equal(r.manifest, null);
      assert.equal(r.tables.games, 2);
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('restoreConfig:false moves the data only and leaves the local credentials alone', () => {
    const src = tmp('sat-bk-src-');
    const dst = tmp('sat-bk-dst-');
    try {
      const srcCfg = join(src, 'config.json');
      writeFileSync(srcCfg, JSON.stringify({ steamApiKey: '来自备份' }));
      const db = seedDb(join(src, 'steam.db'));
      const { zip } = createBackup({ db, configPath: srcCfg, guidesDir: join(src, 'guides') });
      db.close();

      const dstCfg = join(dst, 'config.json');
      writeFileSync(dstCfg, JSON.stringify({ steamApiKey: '本机原有' }));
      const db2 = openDb(join(dst, 'steam.db'));
      const r = applyBackup({ db: db2, buf: zip, configPath: dstCfg, guidesDir: join(dst, 'guides'), restoreConfig: false });
      assert.equal(r.config, false);
      assert.equal(JSON.parse(readFileSync(dstCfg, 'utf8')).steamApiKey, '本机原有');
      assert.equal(r.tables.games, 2, 'the data still has to be moved');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('.drafts does not go into a backup — those are unfinished intermediates', () => {
    const src = tmp('sat-bk-dr-');
    try {
      const guides = join(src, 'guides');
      mkdirSync(join(guides, '.drafts'), { recursive: true });
      mkdirSync(join(guides, '.backups'), { recursive: true });
      writeFileSync(join(guides, 'good.md'), 'ok');
      writeFileSync(join(guides, '.drafts', 'half.md'), '写了一半');
      writeFileSync(join(guides, '.backups', 'old.json'), '{}');

      const db = seedDb(join(src, 'steam.db'));
      const { zip, manifest } = createBackup({ db, configPath: null, guidesDir: guides });
      db.close();

      const names = [...zipRead(zip).keys()];
      assert.ok(names.includes('guides/good.md'));
      assert.ok(names.includes('guides/.backups/old.json'), '.backups holds a guide\'s historical versions and has to stay');
      assert.ok(!names.some((n) => n.includes('.drafts')), '.drafts should not go into a backup');
      assert.equal(manifest.guideFiles, 2);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test('the file name carries a timestamp, so two backups in a row do not overwrite each other', () => {
    const a = backupName(new Date(2026, 7, 19, 9, 5));
    const b = backupName(new Date(2026, 7, 19, 14, 30));
    assert.equal(a, 'steam-tracker-backup-20260819-0905.zip');
    assert.notEqual(a, b);
  });
});
