/**
 * 覆盖已有攻略(「动手顺序」第 8 步)的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的失败类是**不可逆地弄丢用户已经写好的攻略**。前面的文件守"没验过的东西
 * 别溜进笔记",这里守的是反过来那一半:验过的新东西盖上去的时候,旧的那份得还拿得回来。
 *
 *  - **没有 `--overwrite` 就不许覆盖**。默认拒绝是这条路唯一的安全边界
 *  - **备份失败 ⇒ 整件事停下**。和 `guidemigrate` 的归档不一样:那边归档失败可以放过
 *    (东西已经安全落地了),这边备份是覆盖的**前置条件**,没备份的覆盖就是删除
 *  - **删 Notion 页面内容之前必须已经拿到备份**,而且删的就是备份里那一批 block ——
 *    分两次读页面,中间被人动过,备份里就少一块,而少的那块已经被删了
 *  - **覆盖本地攻略不会顺手把它搬去 Notion**。换后端是另一条命令的事
 *  - **手动勾上的子步骤框会丢,而且必须在花钱之前就说出来**。成就框会被机械打勾按
 *    数据库勾回原样,子步骤框匹配不到任何成就,重新生成之后一律变回未勾选
 *
 * 不联网:Notion 和 Steam 都是假的。
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
// 脚手架
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

/** Steam:只提供机械打勾要的解锁状态和解锁率 */
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

describe('planGuide —— 覆盖这道闸门', () => {
  /**
   * 「不只说不行,还要说怎么办」这条要求没变,变的是**谁来说**。
   *
   * 终端的下一步是加 `--overwrite`,Dashboard 上那一行有个「重写」按钮 —— 不是同一个
   * 动作。把其中一个写进消息正文,对另一边就是一句做不到的建议。所以正文只陈述事实,
   * 带上 code 和 detail,让两个界面各自说各自的下一步(终端那半由 cli-hints.test.js 钉)。
   */
  test('已经有攻略、没加 --overwrite → 拒绝,并且带上让界面自己接话的信息', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.match(err.message, /已经有攻略了/);
        assert.equal(err.code, 'guide-exists', '光说"已经有攻略了"不够,界面得知道这是哪一类拒绝');
        assert.equal(err.detail.kind, 'local');
        assert.ok(err.detail.url, '要能指出是哪一份');
        assert.doesNotMatch(err.message, /--overwrite/, 'Dashboard 上没有命令行可敲');
        return true;
      }
    );
  });

  test('加了 --overwrite → 放行,并把旧攻略一起带出来给差异预览用', async () => {
    const { db, config } = freshEnv();
    const plan = await planGuide(db, { config, steam: fakeSteam(), appid: '1', overwrite: true });
    assert.equal(plan.existing.kind, 'local');
    assert.equal(plan.oldTodos.length, 4, '三个成就框 + 一个子步骤框');
    assert.ok(plan.oldText.includes('第一步'));
  });

  test('覆盖本地攻略不会顺手搬去 Notion —— 换后端是 guide-to-notion 的事', async () => {
    const { db, config } = freshEnv();
    const plan = await planGuide(db, {
      config: { ...config, notion: { overviewDbId: 'db1' } },
      steam: fakeSteam(),
      appid: '1',
      notion: { configured: true },
      overwrite: true,
    });
    assert.equal(plan.target, 'local', 'Notion 连着也不该改变一份本地攻略的落点');
  });

  test('覆盖时写回原来那个文件,不按游戏名另起一个', async () => {
    const { db, config, file } = freshEnv({ file: '手起的名字.md' });
    const plan = await planGuide(db, { config, steam: fakeSteam(), appid: '1', overwrite: true });
    assert.equal(plan.fileName, file);
  });

  test('guides 表指着一个已经不在的文件 → 当场报,不等花完钱', async () => {
    const { db, config } = freshEnv({ register: false });
    upsertGuide(db, { appid: '1', name: '测试游戏', url: '根本没有这个.md', kind: 'local' });
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1', overwrite: true }),
      /不在了|找不到/
    );
  });

  test('文件在、但没登记进 guides 表 → 也算覆盖,一样要先拦下来', async () => {
    const { db, config } = freshEnv({ register: false });
    // 中文游戏名削不出 ASCII slug,guideFileName 会退回 app_<appid>_achievements.md
    writeFileSync(join(config.guidesDir, 'app_1_achievements.md'), GUIDE);
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.equal(err.code, 'file-exists');
        // 「加 --overwrite」搬去终端那一侧了(见 cli-hints.test.js):同一句话
        // 会原样出现在 Dashboard 上,而那边没有命令行可敲
        assert.doesNotMatch(err.message, /--overwrite|--file/);
        return true;
      }
    );
  });
});

describe('backupGuide —— 覆盖的前置条件', () => {
  test('本地攻略:原样拷进 .backups/,原件一个字都不动', async () => {
    const { db: _db, config, dir, file } = freshEnv();
    const b = await backupGuide(config, { guide: { kind: 'local', url: file }, appid: '1' });

    assert.ok(existsSync(b.path));
    assert.equal(readFileSync(b.path, 'utf8'), GUIDE, '备份的必须是原文');
    assert.equal(readFileSync(join(dir, file), 'utf8'), GUIDE, '原件不该被动过');
    assert.ok(b.path.includes(BACKUPS_DIR));
    assert.ok(b.bytes > 0);
  });

  test('本地攻略不见了 → 抛,不要写一个空备份', async () => {
    const { config } = freshEnv();
    await assert.rejects(
      backupGuide(config, { guide: { kind: 'local', url: '没有这个.md' }, appid: '1' }),
      /不见了|找不到/
    );
  });

  test('Notion:存原样 block JSON,而且把 block 一起交出来给删除用', async () => {
    const { config } = freshEnv({ kind: 'notion' });
    const notion = fakeNotion();
    const b = await backupGuide(config, {
      guide: { kind: 'notion', url: 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee' },
      appid: '1',
      notion,
    });

    assert.equal(b.count, 2);
    assert.equal(b.blocks.length, 2, '要拿回 block 本身,不只是个数 —— 紧接着就按它删');
    const saved = JSON.parse(readFileSync(b.path, 'utf8'));
    assert.equal(saved.blocks.length, 2);
    assert.equal(saved.appid, '1');
    assert.ok(saved.savedAt, '存下来的东西要能说出自己是什么时候的');
  });

  test('页面一个 block 都读不到 → 抛。空备份等于没备份', async () => {
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

  test('Notion 没配置 → 抛,不要静悄悄跳过备份', async () => {
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

  test('时间戳可排序,同一秒之外不会互相覆盖', () => {
    assert.match(timeStamp(new Date(2026, 7, 11, 15, 57, 12)), /^20260811-155712$/);
    assert.ok(timeStamp(new Date(2026, 0, 2)) < timeStamp(new Date(2026, 0, 3)));
  });
});

describe('差异预览 —— 说清楚会失去什么', () => {
  const oldTodos = loadTodosFrom(GUIDE);

  function loadTodosFrom(text) {
    const dir = mkdtempSync(join(tmpdir(), 'diff-'));
    const p = join(dir, 'g.md');
    writeFileSync(p, text);
    return loadTodos(p);
  }

  test('coverageOf 把成就框和子步骤框分开', () => {
    const { byApiName, orphans } = coverageOf(oldTodos, DEFS);
    assert.equal(byApiName.size, 3);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].text.trim(), '手动勾上的子步骤');
  });

  test('手动勾上的子步骤框被点名 —— 这是覆盖唯一真正丢掉的用户数据', () => {
    const p = overwritePreflight({ oldTodos, defs: DEFS, oldText: GUIDE });
    assert.equal(p.atRiskTicks.length, 1);
    assert.match(formatPreflight(p), /手动勾上的子步骤框会变回未勾选/);
  });

  test('成就框的勾不算"会丢" —— 机械打勾会按数据库勾回原样', () => {
    // 「第一步」在旧攻略里是勾上的,而且它是个成就 → 不该出现在 atRiskTicks 里
    const p = overwritePreflight({ oldTodos, defs: DEFS });
    assert.ok(!p.atRiskTicks.some((t) => t.text.includes('第一步')));
  });

  test('没有子步骤勾选时,明说没有东西会丢', () => {
    const todos = loadTodosFrom('- [x] **第一步**<br>完成第一关。\n');
    const out = formatPreflight(overwritePreflight({ oldTodos: todos, defs: DEFS }));
    assert.match(out, /没有手动勾选会丢失/);
  });

  test('新版少了一个成就的框 → 报出来,这是真的退化', () => {
    const newTodos = loadTodosFrom(
      '- [ ] **第一步**<br>完成第一关。\n- [ ] **第二步**<br>完成第二关。\n'
    );
    const d = diffGuides({ oldTodos, newTodos, defs: DEFS });
    assert.equal(d.lostAchievements.length, 1);
    assert.equal(d.lostAchievements[0].name, '第三步');
  });

  test('三个成就都在 → 不报丢失,但要说正文整份换掉了', () => {
    const newTodos = loadTodosFrom(
      '- [ ] **第一步**<br>完成第一关。<br>换了个写法\n' +
        '- [ ] **第二步**<br>完成第二关。<br>也换了\n' +
        '- [ ] **第三步**<br>完成第三关。<br>还是换了\n'
    );
    const d = diffGuides({ oldTodos, newTodos, defs: DEFS });
    assert.equal(d.lostAchievements.length, 0);
    assert.equal(d.newCovered, 3);
  });

  test('字数变化算得出来 —— 拿三千字换掉九千字要当场看见', () => {
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
