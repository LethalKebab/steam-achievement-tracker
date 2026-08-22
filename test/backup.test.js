/**
 * 备份 / 恢复的回归测试
 * ------------------------------------------------
 * 这条路径上**每一种失败都会吃掉用户的数据**,而且大多不出声:
 * 恢复是先 DELETE 再 INSERT 的,搬到一半、搬错列、或者压根没搬,
 * 结果都是一个"看起来正常、只是东西少了"的库。所以这里钉的几乎全是
 * "没生效"和"生效过头"两侧,而不是 happy path 本身。
 *
 * zip 容器那一层单独在 zip.test.js 里,这里只当它是个能用的黑盒。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, insertGame, setGameField, updateGameStats, upsertGuide, getGame, allGames } from '../lib/db.js';
import { createBackup, applyBackup, inspectBackup, backupName, BACKUP_VERSION } from '../lib/backup.js';
import { zipWrite, zipRead } from '../lib/zip.js';

/** 一个带齐"Steam 补不回来的那些标记"的库 —— 那些正是备份存在的理由 */
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

describe('备份 / 恢复', () => {
  test('往返:♥/★/家庭/Manual/锁 —— 这些 Steam 补不回来的列必须原样回来', () => {
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

      // 全新的一台机器:空库、没有 guides、没有 config
      const dstGuides = join(dst, 'guides');
      const dstCfg = join(dst, 'config.json');
      const db2 = openDb(join(dst, 'steam.db'));
      const r = applyBackup({ db: db2, buf: zip, configPath: dstCfg, guidesDir: dstGuides });

      assert.equal(r.tables.games, 2);
      assert.equal(r.guideFiles, 1);
      assert.equal(r.config, true);

      const rim = getGame(db2, '294100');
      assert.equal(rim.favorite, 1, '♥ 没回来');
      assert.equal(rim.priority, 1, '★ 没回来');
      assert.equal(rim.achieved, 40);
      const portal = getGame(db2, '620');
      assert.equal(portal.status, 'Manual');
      assert.equal(portal.sync_locked, 1, '锁没回来');
      assert.equal(portal.family, 1, '家庭标记没回来');

      assert.match(readFileSync(join(dstGuides, 'rimworld.md'), 'utf8'), /- \[x\] 第一步/);
      assert.equal(JSON.parse(readFileSync(dstCfg, 'utf8')).steamApiKey, 'KEY123', '凭据没跟着走');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('恢复是替换,不是合并 —— 目标库里原有的行必须消失', () => {
    // 合并会留下一堆"从没拥有过"的游戏,而且没有任何提示。这是恢复最容易
    // 写错的方向:忘了 DELETE,INSERT OR REPLACE 一写就变成了合并
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

      assert.equal(allGames(db2).length, 2, '原有的行还在,说明是合并不是替换');
      assert.equal(getGame(db2, '999999'), undefined);
      assert.equal(getGame(db2, '294100').name, 'RimWorld');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('老备份少几列也能恢复(按交集搬),多出来的列留默认值', () => {
    // 真实场景:1.1.9 之前的备份没有 cover_url。SELECT * 会直接报列数不匹配,
    // 而这是"三个月前的备份恢复不了"这种最难受的失败
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
      assert.equal(getGame(db2, '294100').cover_url, null, '缺的列该是默认值,不是错位的数据');
      assert.equal(getGame(db2, '294100').favorite, 1, '其余的列还得对上');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('zip 里的 ../ 不能把文件写到 guides/ 外面去', () => {
    // **落点名字必须每次都不一样。** 第一版写死叫 pwned.md,而 guides/ 在 dst 下面,
    // 所以 ../../ 的落点是 tmpdir() 本身 —— 拿这条做变异测试(把守卫删掉看它变红)
    // 真的在那里留下了一个文件,下一次跑就因为**上一轮的残留**而失败。
    // 断言要说的是"这一轮没有越界",不是"这个路径上从来没有过文件"。
    const marker = `sat-slip-${process.pid}-${Date.now()}.md`;
    const dst = tmp('sat-bk-slip-');
    const escaped = [join(dst, marker), join(tmpdir(), marker)];
    try {
      const src = tmp('sat-bk-seed-');
      // 备份里必须有一个**正常**的攻略文件,否则下面"正常条目照样落地"那条
      // 会被一个"什么都不写"的守卫也满足 —— 那样这个测试就只证明了程序没干活
      mkdirSync(join(src, 'guides'), { recursive: true });
      writeFileSync(join(src, 'guides', 'ok.md'), '# 正常攻略\n');
      const db = seedDb(join(src, 'steam.db'));
      const { zip } = createBackup({ db, configPath: null, guidesDir: join(src, 'guides') });
      db.close();
      rmSync(src, { recursive: true, force: true });

      // 把一个越界条目塞回 zip 里
      const entries = [...zipRead(zip)].map(([name, data]) => ({ name, data }));
      entries.push({ name: `guides/../../${marker}`, data: Buffer.from('x') });
      const evil = zipWrite(entries);

      const db2 = openDb(join(dst, 'steam.db'));
      applyBackup({ db: db2, buf: evil, configPath: null, guidesDir: join(dst, 'guides') });
      db2.close();

      for (const p of escaped) assert.equal(existsSync(p), false, `越界写到了 ${p}`);
      // 守卫必须是**挑出那一条**,不是把整批都拒了
      assert.ok(existsSync(join(dst, 'guides', 'ok.md')), '越界被挡住了,但正常的攻略也没写进去');
    } finally {
      for (const p of escaped) rmSync(p, { force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  /**
   * **反斜杠是同一个洞的另一种拼法,而上面那条测不到它。**
   *
   * zip 规范说条目名用正斜杠 —— 但那是规范,不是校验器,攻击者手写一个
   * `guides/..\..\x.md` 完全合法。守卫如果只 `split('/')`,`..\..` 整个是一个
   * "文件名",过得了 `.includes('..')` 那一关,然后 Windows 上的 `join()` 把
   * 反斜杠当分隔符解析成真正的上跳。实测能落到 `D:\GitHub\` 下。
   *
   * 第三条是**前缀相同的兄弟目录**:`guides-evil` 是 `guides` 的字符串前缀,
   * 包含性检查漏掉分隔符就放行 —— 和 `resolveGuidePath`、`/fonts/` 那条路
   * 同一个坑,这个项目里已经出现过三次。
   */
  const SLIP_CASES = [
    ['反斜杠上跳', (m) => `guides/..\\..\\${m}`, (dst) => join(dst, '..', '..')],
    ['正反混用', (m) => `guides/..\\../${m}`, (dst) => join(dst, '..', '..')],
    ['前缀相同的兄弟目录', (m) => `guides/../guides-evil/${m}`, (dst) => join(dst, 'guides-evil')],
    ['单点段', (m) => `guides/./../${m}`, (dst) => join(dst, '..')],
  ];

  for (const [label, entryName, landingDir] of SLIP_CASES) {
    test(`zip-slip:${label} 同样挡在 guides/ 外面`, () => {
      const marker = `sat-slip-${label.length}-${process.pid}-${Date.now()}.md`;
      const dst = tmp('sat-bk-slip2-');
      // 落点按各自的形状算,再加两个通用的兜底位置
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

        for (const p of escaped) assert.equal(existsSync(p), false, `越界写到了 ${p}`);
        assert.ok(existsSync(join(dst, 'guides', 'ok.md')), '越界被挡住了,但正常的攻略也没写进去');
        // 数出来的也只能是那一个正常文件 —— 报告里把恶意条目算进去等于说了谎
        assert.equal(r.guideFiles, 1, '恶意条目被算进"写了几个攻略文件"里了');
      } finally {
        for (const p of escaped) rmSync(p, { force: true });
        rmSync(join(dst, '..', 'guides-evil'), { recursive: true, force: true });
        rmSync(dst, { recursive: true, force: true });
      }
    });
  }

  test('坏文件在碰数据库之前就要被拦下', () => {
    // 顺序很关键:先 DELETE 再发现 zip 读不动,用户的数据就没了而备份也没进来
    const dst = tmp('sat-bk-bad-');
    try {
      const db2 = openDb(join(dst, 'steam.db'));
      insertGame(db2, { appid: '111', name: '不该被删掉' });

      const notZip = Buffer.from('这不是 zip'.repeat(20));
      assert.throws(() => applyBackup({ db: db2, buf: notZip, configPath: null, guidesDir: join(dst, 'guides') }), /ZIP|zip/);

      const noDb = zipWrite([{ name: 'manifest.json', data: Buffer.from('{}') }]);
      assert.throws(() => applyBackup({ db: db2, buf: noDb, configPath: null, guidesDir: join(dst, 'guides') }), /steam\.db/);

      assert.equal(getGame(db2, '111').name, '不该被删掉', '失败的恢复把原数据删了');
      db2.close();
    } finally {
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('被截断的 zip 要报校验失败,而不是把半个库搬进去', () => {
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

  test('更新版本的备份要明确拒绝,不能按老格式硬读', () => {
    const zip = zipWrite([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: BACKUP_VERSION + 1 })) },
      { name: 'steam.db', data: Buffer.from('x') },
    ]);
    assert.throws(() => inspectBackup(zip), /更新的版本/);
  });

  test('清单坏了不该挡住恢复 —— 数据在 steam.db 里,不在清单里', () => {
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

  test('restoreConfig:false 只搬数据,本机凭据不动', () => {
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
      assert.equal(r.tables.games, 2, '数据还是要搬');
      db2.close();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('.drafts 不进备份 —— 那是没写完的中间产物', () => {
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
      assert.ok(names.includes('guides/.backups/old.json'), '.backups 是攻略的历史版本,要留');
      assert.ok(!names.some((n) => n.includes('.drafts')), '.drafts 不该进备份');
      assert.equal(manifest.guideFiles, 2);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test('文件名带时间戳,连备两次不会互相覆盖', () => {
    const a = backupName(new Date(2026, 7, 19, 9, 5));
    const b = backupName(new Date(2026, 7, 19, 14, 30));
    assert.equal(a, 'steam-tracker-backup-20260819-0905.zip');
    assert.notEqual(a, b);
  });
});
