/**
 * Tests for overwriting an existing guide (step 8 of the "order of operations")
 * ------------------------------------------------
 * Run with: node --test
 *
 * The failure class this file guards is **irreversibly losing a guide the user has already
 * written**. The earlier files guard "nothing unvalidated slips into the notes"; this one
 * guards the other half: when something validated is written over the top, the old copy has
 * to still be recoverable.
 *
 *  - **No `--overwrite`, no overwriting.** Refusing by default is this path's only safety
 *    boundary
 *  - **A failed backup ⇒ the whole thing stops.** Unlike `guidemigrate`'s archiving: there a
 *    failed archive can be let through (the content has already landed safely), while here
 *    the backup is a **precondition** of overwriting, and an overwrite with no backup is a
 *    deletion
 *  - **The backup has to exist before a Notion page's content is deleted**, and what is
 *    deleted is exactly the batch of blocks in the backup — reading the page twice, with
 *    somebody touching it in between, leaves the backup one block short, and that block has
 *    already been deleted
 *  - **Overwriting a local guide does not move it to Notion in passing.** Changing backend is
 *    another command's job
 *  - **Hand-ticked sub-step boxes are lost, and that has to be said before any money is
 *    spent.** Achievement boxes are ticked back exactly as they were by the mechanical pass
 *    from the database, while sub-step boxes match no achievement and come back unticked
 *    after regeneration
 *
 * Offline: both Notion and Steam are fakes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertGame, replaceAchievements, upsertGuide } from '../lib/db.js';
import { loadTodos } from '../lib/markdown.js';
import { planGuide } from '../lib/guidegen.js';
import {
  BACKUPS_DIR,
  backupGuide,
  coverageOf,
  diffGuides,
  overwritePreflight,
  formatPreflight,
  timeStamp,
} from '../lib/guidebackup.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const def = (apiName, nameCn, description = '') => ({
  api_name: apiName,
  name_cn: nameCn,
  name_en: '',
  description,
  game_name: '测试游戏',
  hidden: 0,
  icon: '',
});

const DEFS = [
  def('A', '第一步', '完成第一关。'),
  def('B', '第二步', '完成第二关。'),
  def('C', '第三步', '完成第三关。'),
];

const toRow = (d) => ({
  apiName: d.api_name,
  gameName: d.game_name,
  nameCn: d.name_cn,
  nameEn: d.name_en,
  description: d.description,
  hidden: 0,
  icon: '',
});

const GUIDE = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿',
  '- [ ] **第二步**<br>完成第二关。<br>接着打',
  '\t- [x] 手动勾上的子步骤',
  '- [ ] **第三步**<br>完成第三关。<br>最后一关',
  '',
].join('\n');

function freshEnv({ text = GUIDE, file = 'test_guide.md', kind = 'local', register = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'overwrite-'));
  if (kind === 'local') writeFileSync(join(dir, file), text);
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  replaceAchievements(db, '1', DEFS.map(toRow));
  if (register) {
    upsertGuide(db, {
      appid: '1',
      name: '测试游戏',
      url: kind === 'local' ? file : 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee',
      kind,
    });
  }
  return { db, config: { guidesDir: dir, ai: { maxAchievements: 100 } }, dir, file };
}

/** Steam: supplies only the unlock state and unlock rates the mechanical tick pass needs */
const fakeSteam = () => ({
  async fetchPlayerAchievements() {
    return { achievements: [{ apiname: 'A', achieved: 1 }] };
  },
  async fetchGlobalAchievementPercentages() {
    return null;
  },
});

const fakeNotion = ({ blocks = null } = {}) => ({
  configured: true,
  deleted: [],
  async fetchAllBlocks() {
    return (
      blocks ?? [
        { id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'appid: 1' }] } },
        { id: 'b2', type: 'to_do', to_do: { rich_text: [{ plain_text: '第一步' }], checked: true } },
      ]
    );
  },
  async fetchAllToDoBlocks() {
    return [{ key: 'b2', text: '第一步\n完成第一关。', checked: true, parent: null }];
  },
  async deleteBlock(id) {
    this.deleted.push(id);
  },
});

// ---------------------------------------------------------------------------

describe('planGuide — the overwrite gate', () => {
  /**
   * The requirement "do not only say no, say what to do" has not changed; what changed is
   * **who says it**.
   *
   * The terminal's next step is adding `--overwrite`, while the Dashboard has a 「重写」
   * button on that row — not the same action. Writing either into the message body makes it
   * advice the other surface cannot act on. So the body states facts only and carries a code
   * and a detail, letting each surface state its own next step (the terminal half is pinned
   * by cli-hints.test.js).
   */
  test('a guide already exists and --overwrite was not given → refused, carrying enough for a surface to continue the sentence', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.match(err.message, /已经有攻略了/);
        assert.equal(err.code, 'guide-exists', 'saying only "a guide already exists" is not enough; the surface has to know which kind of refusal this is');
        assert.equal(err.detail.kind, 'local');
        assert.ok(err.detail.url, 'it has to be able to point at which one');
        assert.doesNotMatch(err.message, /--overwrite/, 'there is no command line to type on the Dashboard');
        return true;
      }
    );
  });

  test('with --overwrite → allowed, and the old guide comes back with it for the diff preview', async () => {
    const { db, config } = freshEnv();
    const plan = await planGuide(db, { config, steam: fakeSteam(), appid: '1', overwrite: true });
    assert.equal(plan.existing.kind, 'local');
    assert.equal(plan.oldTodos.length, 4, 'three achievement boxes plus one sub-step box');
    assert.ok(plan.oldText.includes('第一步'));
  });

  test('overwriting a local guide does not move it to Notion in passing — changing backend is guide-to-notion\'s job', async () => {
    const { db, config } = freshEnv();
    const plan = await planGuide(db, {
      config: { ...config, notion: { overviewDbId: 'db1' } },
      steam: fakeSteam(),
      appid: '1',
      notion: { configured: true },
      overwrite: true,
    });
    assert.equal(plan.target, 'local', 'Notion being connected should not change where a local guide lands');
  });

  test('an overwrite writes back to the original file rather than starting a new one from the game name', async () => {
    const { db, config, file } = freshEnv({ file: '手起的名字.md' });
    const plan = await planGuide(db, { config, steam: fakeSteam(), appid: '1', overwrite: true });
    assert.equal(plan.fileName, file);
  });

  test('the guides table points at a file that is gone → reported on the spot, not after the money is spent', async () => {
    const { db, config } = freshEnv({ register: false });
    upsertGuide(db, { appid: '1', name: '测试游戏', url: '根本没有这个.md', kind: 'local' });
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1', overwrite: true }),
      /不在了|找不到/
    );
  });

  test('the file exists but is not registered in the guides table → still an overwrite, and still blocked first', async () => {
    const { db, config } = freshEnv({ register: false });
    // A Chinese game name produces no ASCII slug, so guideFileName falls back to app_<appid>_achievements.md
    writeFileSync(join(config.guidesDir, 'app_1_achievements.md'), GUIDE);
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.equal(err.code, 'file-exists');
        // 「加 --overwrite」 moved to the terminal side (see cli-hints.test.js): the same
        // sentence appears verbatim on the Dashboard, where there is no command line to type
        assert.doesNotMatch(err.message, /--overwrite|--file/);
        return true;
      }
    );
  });
});

describe('backupGuide — the overwrite\'s precondition', () => {
  test('a local guide: copied verbatim into .backups/, with the original untouched', async () => {
    const { db: _db, config, dir, file } = freshEnv();
    const b = await backupGuide(config, { guide: { kind: 'local', url: file }, appid: '1' });

    assert.ok(existsSync(b.path));
    assert.equal(readFileSync(b.path, 'utf8'), GUIDE, 'what is backed up has to be the original');
    assert.equal(readFileSync(join(dir, file), 'utf8'), GUIDE, 'the original should not have been touched');
    assert.ok(b.path.includes(BACKUPS_DIR));
    assert.ok(b.bytes > 0);
  });

  test('the local guide is gone → throw rather than writing an empty backup', async () => {
    const { config } = freshEnv();
    await assert.rejects(
      backupGuide(config, { guide: { kind: 'local', url: '没有这个.md' }, appid: '1' }),
      /不见了|找不到/
    );
  });

  test('Notion: stores the raw block JSON, and hands the blocks back for the deletion', async () => {
    const { config } = freshEnv({ kind: 'notion' });
    const notion = fakeNotion();
    const b = await backupGuide(config, {
      guide: { kind: 'notion', url: 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee' },
      appid: '1',
      notion,
    });

    assert.equal(b.count, 2);
    assert.equal(b.blocks.length, 2, 'the blocks themselves have to come back, not only a count — the deletion goes by them immediately after');
    const saved = JSON.parse(readFileSync(b.path, 'utf8'));
    assert.equal(saved.blocks.length, 2);
    assert.equal(saved.appid, '1');
    assert.ok(saved.savedAt, 'what is stored has to be able to say when it is from');
  });

  test('not one block could be read from the page → throw. An empty backup is no backup', async () => {
    const { config } = freshEnv({ kind: 'notion' });
    await assert.rejects(
      backupGuide(config, {
        guide: { kind: 'notion', url: 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee' },
        appid: '1',
        notion: fakeNotion({ blocks: [] }),
      }),
      /一个 block 都没读到/
    );
  });

  test('Notion is not configured → throw rather than silently skipping the backup', async () => {
    const { config } = freshEnv({ kind: 'notion' });
    await assert.rejects(
      backupGuide(config, {
        guide: { kind: 'notion', url: 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee' },
        appid: '1',
        notion: { configured: false },
      }),
      /没配置/
    );
  });

  test('the timestamp sorts, and does not collide outside the same second', () => {
    assert.match(timeStamp(new Date(2026, 7, 11, 15, 57, 12)), /^20260811-155712$/);
    assert.ok(timeStamp(new Date(2026, 0, 2)) < timeStamp(new Date(2026, 0, 3)));
  });
});

describe('the diff preview — stating clearly what will be lost', () => {
  const oldTodos = loadTodosFrom(GUIDE);

  function loadTodosFrom(text) {
    const dir = mkdtempSync(join(tmpdir(), 'diff-'));
    const p = join(dir, 'g.md');
    writeFileSync(p, text);
    return loadTodos(p);
  }

  test('coverageOf separates achievement boxes from sub-step boxes', () => {
    const { byApiName, orphans } = coverageOf(oldTodos, DEFS);
    assert.equal(byApiName.size, 3);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].text.trim(), '手动勾上的子步骤');
  });

  test('hand-ticked sub-step boxes are named — the one piece of user data an overwrite genuinely loses', () => {
    // **The command line is now the only place that says this.** The Dashboard confirm
    // dialog's body has been cut down to nothing (the interface has to be short, 「重写」 by
    // itself already implies it, and the backup still exists). Cutting it here too would leave
    // nowhere mentioning it — and it really is the only user data an overwrite cannot get back
    const p = overwritePreflight({ oldTodos, defs: DEFS, oldText: GUIDE });
    assert.equal(p.atRiskTicks.length, 1);
    assert.match(formatPreflight(p), /手动勾上的子步骤框会变回未勾选/);
  });

  test('a ticked achievement box does not count as "will be lost" — the mechanical pass ticks it back from the database', () => {
    // 「第一步」 is ticked in the old guide and is an achievement → it should not appear in atRiskTicks
    const p = overwritePreflight({ oldTodos, defs: DEFS });
    assert.ok(!p.atRiskTicks.some((t) => t.text.includes('第一步')));
  });

  test('with no ticked sub-steps, it says outright that nothing will be lost', () => {
    const todos = loadTodosFrom('- [x] **第一步**<br>完成第一关。\n');
    const out = formatPreflight(overwritePreflight({ oldTodos: todos, defs: DEFS }));
    assert.match(out, /没有手动勾选会丢失/);
  });

  test('the new version is missing an achievement\'s box → reported, because that is a genuine regression', () => {
    const newTodos = loadTodosFrom(
      '- [ ] **第一步**<br>完成第一关。\n- [ ] **第二步**<br>完成第二关。\n'
    );
    const d = diffGuides({ oldTodos, newTodos, defs: DEFS });
    assert.equal(d.lostAchievements.length, 1);
    assert.equal(d.lostAchievements[0].name, '第三步');
  });

  test('all three achievements present → nothing reported lost, but it has to say the prose was replaced wholesale', () => {
    const newTodos = loadTodosFrom(
      '- [ ] **第一步**<br>完成第一关。<br>换了个写法\n' +
        '- [ ] **第二步**<br>完成第二关。<br>也换了\n' +
        '- [ ] **第三步**<br>完成第三关。<br>还是换了\n'
    );
    const d = diffGuides({ oldTodos, newTodos, defs: DEFS });
    assert.equal(d.lostAchievements.length, 0);
    assert.equal(d.newCovered, 3);
  });

  test('the change in length is computed — trading nine thousand characters for three thousand has to be visible on the spot', () => {
    const d = diffGuides({
      oldTodos,
      newTodos: oldTodos,
      defs: DEFS,
      oldText: 'x'.repeat(9000),
      newText: 'x'.repeat(3000),
    });
    assert.equal(d.oldChars, 9000);
    assert.equal(d.newChars, 3000);
  });
});
