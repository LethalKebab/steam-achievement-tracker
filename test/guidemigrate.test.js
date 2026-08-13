/**
 * 本地攻略搬去 Notion 的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的失败类是**搬家搬丢了东西,而两边都不报错**。搬的是用户自己写了很久的
 * 攻略,所以每一条都指向"东西没了但看着像成了":
 *
 *  - 保真校验必须真的会失败。文字变了、条数变了、**勾选状态变了**都要拦下来 ——
 *    勾选被改是最隐蔽的一种:页面看着满满当当,只是有几个框莫名其妙自己勾上了
 *  - 校验没过时**本地文件必须原封不动**。搬家的前提是"原件还在",这一条塌了,
 *    前面所有的谨慎都白费
 *  - 归档是挪不是删,而且是最后一步
 *  - **不能拿 lintGuide 去卡**。手写攻略过不了闸门是常态(实测语料里 330 个成就
 *    没有能匹配的 checkbox),用它当门槛等于拒绝搬绝大多数真实攻略
 *
 * 不联网:Notion 是假的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertGame, updateGameStats, upsertGuide, getGuide } from '../lib/db.js';
import { markdownToBlocks } from '../lib/notionblocks.js';
import {
  planMigration,
  migrateGuideToNotion,
  checkFidelity,
  normalizeForCompare,
  MIGRATED_DIR,
} from '../lib/guidemigrate.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const GUIDE = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿',
  '- [ ] **第二步**<br>完成第二关。<br>接着打',
  '  - [ ] 子步骤甲',
  '',
  '## 速查表',
  '',
  '| 章节 | 答案 |',
  '| --- | --- |',
  '| 序章 | 41627 |',
  '',
].join('\n');

function freshEnv({ text = GUIDE, file = 'test_guide.md', kind = 'local', achieved = 3, total = 10 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  writeFileSync(join(dir, file), text);
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  updateGameStats(db, '1', { achieved, total });
  upsertGuide(db, { appid: '1', name: '测试游戏', url: file, kind });
  return { db, config: { guidesDir: dir }, dir, file };
}

/**
 * 假 Notion。回读**从真写进去的块里还原**,所以保真校验比的确实是"写出去的那份",
 * 不是另编一份数据。`corrupt` 用来模拟各种"写进去了但不对"的情况。
 */
/**
 * 假 Steam。搬家只用得到图标 hash 这一件事。
 * `img = null` 模拟"这游戏 Steam 那边没有图标",页面照样要建得出来。
 */
function fakeSteam(img = 'deadbeef') {
  return {
    async fetchOwnedGames() {
      return [{ appid: 1, img_icon_url: img }];
    },
  };
}

function fakeNotion({ pages = [], corrupt = null } = {}) {
  return {
    written: [],
    created: [],
    iconSets: [],
    pages,
    configured: true,
    async setPageIcon(pageId, url) {
      this.iconSets.push({ pageId, url });
    },
    async fetchGuideDbSchema() {
      // 选项照抄真实攻略库,不然测试会在一个现实中不存在的库上通过
      return {
        titleProperty: 'Name',
        status: {
          property: 'Status',
          type: 'status',
          options: ['Not started', 'Staged', 'Paused', 'In progress', 'Differed', 'Done'],
        },
      };
    },
    async queryGuideDatabase() { return this.pages; },
    async countChildren() { return 0; },
    async createGuidePage(args) {
      this.created.push(args);
      const page = { id: 'new-page', url: 'https://notion.so/new-page' };
      this.pages.push({ ...page, title: args.title });
      return page;
    },
    async appendBlocks(_id, blocks) { this.written.push(...blocks); return blocks.length; },
    async extractAppIdFromPageContent() { return '1'; },
    async fetchAllToDoBlocks() {
      const out = [];
      const walk = (blocks, parent) => {
        for (const b of blocks) {
          if (b.type !== 'to_do') continue;
          out.push({
            key: `k${out.length}`,
            text: b.to_do.rich_text.map((r) => r.text.content).join(''),
            checked: b.to_do.checked,
            parent,
          });
          if (b.to_do.children) walk(b.to_do.children, `k${out.length - 1}`);
        }
      };
      walk(this.written, null);
      return corrupt ? corrupt(out) : out;
    },
  };
}

const run = (db, config, notion, steam = fakeSteam()) =>
  migrateGuideToNotion(db, { notion, steam, config, appid: '1' });

// ---------------------------------------------------------------------------

describe('checkFidelity —— 纯比对', () => {
  test('`**` 和 `<br>` 归一化之后,两边应该一模一样', () => {
    assert.equal(normalizeForCompare('**名字**<br>描述'), '名字\n描述');
  });

  test('完全一致 → ok', () => {
    const a = [{ text: '**甲**<br>描述', checked: true }];
    const b = [{ text: '甲\n描述', checked: true }];
    assert.equal(checkFidelity(a, b).ok, true);
  });

  test('条数不一样 → 报出来', () => {
    const r = checkFidelity([{ text: 'a' }, { text: 'b' }], [{ text: 'a' }]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /条目数对不上/);
  });

  test('文字变了 → 报出来,并且把两边都打出来', () => {
    const r = checkFidelity([{ text: '原来的字' }], [{ text: '变了的字' }]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /原来的字[\s\S]*变了的字/);
  });

  test('文字一样但勾选被改了 → 单独报,这是最隐蔽的一种破坏', () => {
    const r = checkFidelity([{ text: '甲', checked: false }], [{ text: '甲', checked: true }]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /勾选状态被改了/);
  });

  test('问题太多时截断,不把终端刷爆', () => {
    const a = Array.from({ length: 50 }, (_, i) => ({ text: 'a' + i }));
    const b = Array.from({ length: 50 }, (_, i) => ({ text: 'b' + i }));
    assert.ok(checkFidelity(a, b).problems.length <= 11);
  });
});

describe('planMigration —— 写之前先看清楚', () => {
  test('已经在 Notion 上的攻略不用搬', async () => {
    const { db, config } = freshEnv({ kind: 'notion' });
    await assert.rejects(planMigration(db, { notion: fakeNotion(), config, appid: '1' }), /已经在 Notion/);
  });

  test('没登记过攻略 → 拒绝', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(planMigration(db, { notion: fakeNotion(), config, appid: '999' }), /没有登记/);
  });

  test('没配 Notion → 说清楚去哪配', async () => {
    const { db, config } = freshEnv();
    const notion = { ...fakeNotion(), configured: false };
    await assert.rejects(planMigration(db, { notion, config, appid: '1' }), /还没配置 Notion/);
  });

  test('一个 checkbox 都没有的文件 → 拒绝(多半搞错文件了)', async () => {
    const { db, config } = freshEnv({ text: 'appid: 1\n\n只是一段普通文字。\n' });
    await assert.rejects(planMigration(db, { notion: fakeNotion(), config, appid: '1' }), /一个 checkbox 都没有/);
  });

  test('预览给出块类型统计和降级行,不写任何东西', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    const p = await planMigration(db, { notion, config, appid: '1' });
    assert.equal(p.todos.length, 3);
    assert.equal(p.byType.table, 1, '表格该转成 table 块,不是三段文字');
    assert.equal(p.byType.heading_2, 2);
    assert.equal(notion.written.length, 0, '预览不能写东西');
    assert.equal(notion.created.length, 0);
  });
});

describe('migrateGuideToNotion —— 搬,然后逐条核对', () => {
  test('一切正常:建页、写块、核对通过、翻成 notion、本地文件挪走', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion();
    const r = await run(db, config, notion);

    assert.equal(r.count, 3);
    assert.equal(r.url, 'https://notion.so/new-page');
    assert.equal(notion.created[0].title, '测试游戏');
    assert.equal(getGuide(db, '1').kind, 'notion', 'guides 表要从 local 翻成 notion');
    assert.equal(existsSync(join(dir, file)), false, '原位置应该没有了');
    assert.equal(existsSync(join(dir, MIGRATED_DIR, file)), true, '但必须还在 .migrated/ 里');
    assert.equal(readFileSync(join(dir, MIGRATED_DIR, file), 'utf8'), GUIDE, '归档的是原文,不是改过的');
  });

  test('勾选状态原样带过去 —— 搬家不碰勾选', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    await run(db, config, notion);
    const todos = await notion.fetchAllToDoBlocks();
    assert.deepEqual(todos.map((t) => t.checked), [true, false, false]);
  });

  test('回读文字对不上 → 抛,而且**本地文件一动不动**', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({
      corrupt: (todos) => todos.map((t, i) => (i === 0 ? { ...t, text: '被改过的字' } : t)),
    });
    await assert.rejects(run(db, config, notion), /回读对不上/);
    assert.equal(existsSync(join(dir, file)), true, '搬失败了原件必须还在');
    assert.equal(getGuide(db, '1').kind, 'local', 'guides 表也不该改');
  });

  test('回读少了一条 → 抛,本地文件还在', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({ corrupt: (todos) => todos.slice(1) });
    await assert.rejects(run(db, config, notion), /条目数对不上/);
    assert.equal(existsSync(join(dir, file)), true);
  });

  test('回读把没勾的勾上了 → 抛,本地文件还在', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({ corrupt: (todos) => todos.map((t) => ({ ...t, checked: true })) });
    await assert.rejects(run(db, config, notion), /勾选状态被改了/);
    assert.equal(existsSync(join(dir, file)), true);
  });

  test('发现逻辑读不出 appid → 抛,本地文件还在', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => null;
    await assert.rejects(run(db, config, notion), /没能从上面读出 appid/);
    assert.equal(existsSync(join(dir, file)), true);
  });

  test('一份过不了 lint 的攻略照样搬得动 —— 搬家不评价攻略质量', async () => {
    // 成就名对不上任何东西、描述也不是原文:lintGuide 会报一堆,但这不关搬家的事
    const { db, config } = freshEnv({
      text: 'appid: 1\n\n- [ ] 随便写的一行,根本不是成就名\n- [x] 另一行\n',
    });
    const r = await run(db, config, fakeNotion());
    assert.equal(r.count, 2);
    assert.equal(getGuide(db, '1').kind, 'notion');
  });

  test('同名的空页会被填进去,不新建第二页', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    const r = await run(db, config, notion);
    assert.equal(notion.created.length, 0);
    assert.equal(r.url, 'u1');
  });

  test('同名页有内容 → 拒绝,不往用户手写的东西后面追加', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    notion.countChildren = async () => 7;
    await assert.rejects(run(db, config, notion), /里面有内容/);
    assert.equal(existsSync(join(dir, file)), true);
  });
});

/**
 * 图标。搬过去的页面和 `guide-gen` 生成的页面躺在同一个攻略库里,一批有图标一批没有,
 * 看着就是搬运漏了东西 —— 这几条守的就是那个"少了一样东西"的静默失败:
 * 它不报错、回读校验也全绿,只有人打开 Notion 才看得见。
 */
describe('页面图标', () => {
  test('新建的页面带上 Steam 图标', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    await run(db, config, notion);
    assert.match(notion.created[0].icon, /deadbeef\.jpg$/);
  });

  test('Steam 没有图标 → 照常建页,不因为这个卡住', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    const r = await run(db, config, notion, fakeSteam(null));
    assert.equal(notion.created[0].icon, null);
    assert.equal(r.count, 3, '图标拿不到不影响搬家本身');
  });

  test('Steam 接口挂了 → 照常建页', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    const steam = { async fetchOwnedGames() { throw new Error('429'); } };
    const r = await run(db, config, notion, steam);
    assert.equal(notion.created[0].icon, null);
    assert.equal(r.count, 3);
  });

  test('接管的空页原本没有图标 → 补上', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏', icon: null }] });
    await run(db, config, notion);
    assert.equal(notion.iconSets.length, 1);
    assert.equal(notion.iconSets[0].pageId, 'p1');
  });

  test('接管的空页已经有图标 → 一个字都不动(哪怕是个 emoji)', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion({
      pages: [{ id: 'p1', url: 'u1', title: '测试游戏', icon: { type: 'emoji', emoji: '🌯' } }],
    });
    await run(db, config, notion);
    assert.deepEqual(notion.iconSets, [], '用户自己挑的图标不是我们该"顺手改一下"的东西');
  });
});

describe('搬过去的内容本身', () => {
  test('表格搬成 table 块,不是三行文字', () => {
    const { blocks } = markdownToBlocks(GUIDE);
    const table = blocks.find((b) => b.type === 'table');
    assert.ok(table, '表格丢了的话,速查表就得让人自己在文字里找列');
    assert.equal(table.table.children.length, 2);
  });

  test('嵌套子步骤仍然挂在父成就下面', () => {
    const { blocks } = markdownToBlocks(GUIDE);
    const todos = blocks.filter((b) => b.type === 'to_do');
    assert.equal(todos.length, 2);
    assert.equal(todos[1].to_do.children.length, 1);
  });
});

describe('新页的状态按真实进度算', () => {
  const statusOf = async (achieved, total) => {
    const { db, config } = freshEnv({ achieved, total });
    const notion = fakeNotion();
    await run(db, config, notion);
    return notion.created[0].status.value;
  };

  test('解锁了一部分 → In progress(部落幸存者 50/51 就是这一档)', async () => {
    assert.equal(await statusOf(50, 51), 'In progress');
  });

  test('一个都没解锁 → Not started', async () => {
    assert.equal(await statusOf(0, 51), 'Not started');
  });

  test('满成就 → Done', async () => {
    assert.equal(await statusOf(51, 51), 'Done');
  });

  test('绝不会是 Staged —— 那一档的含义是"曾经满成就又被顶下来"', async () => {
    for (const [a, t] of [[0, 51], [50, 51], [51, 51]]) {
      assert.notEqual(await statusOf(a, t), 'Staged');
    }
  });
});

/**
 * 互斥标注(`<span underline="true">…</span>`)转成 Notion 的下划线注解之后,
 * **回读的文字里不再有标签** —— 而文件里有。保真校验要是不知道这件事,
 * 每一份带互斥标注的攻略都会在"回读对不上"这一步失败,而且失败得毫无道理:
 * 内容一个字没变,只是标记搬去了 annotations。`**` 早就是这么处理的。
 */
describe('互斥标注不该把保真校验搞崩', () => {
  const WITH_SPAN = [
    'appid: 1',
    '',
    '- [x] **第一步**<br>完成第一关。<br>选了这个。<span underline="true">如果选另一个则无法获得本成就。</span>',
    '- [ ] **第二步**<br>完成第二关。<br>接着打',
    '',
  ].join('\n');

  test('归一化之后,文件里的标签和 Notion 读回来的纯文字相等', () => {
    assert.equal(
      normalizeForCompare('心得。<span underline="true">互斥警告。</span>'),
      normalizeForCompare('心得。互斥警告。')
    );
  });

  test('带互斥标注的攻略搬得过去,而且逐条核对通过', async () => {
    const { db, config } = freshEnv({ text: WITH_SPAN });
    const notion = fakeNotion();
    const r = await run(db, config, notion);
    assert.equal(r.count, 2);
    assert.equal(getGuide(db, '1').kind, 'notion');
  });

  test('搬过去的那一条真的带了下划线注解,不是把标签当文字写进去', async () => {
    const { db, config } = freshEnv({ text: WITH_SPAN });
    const notion = fakeNotion();
    await run(db, config, notion);
    const runs = notion.written.flatMap((b) => b[b.type].rich_text ?? []);
    const underlined = runs.filter((x) => x.annotations?.underline);
    assert.equal(underlined.length, 1);
    assert.equal(underlined[0].text.content, '如果选另一个则无法获得本成就。');
    assert.ok(
      !runs.some((x) => x.text.content.includes('<span')),
      '标签不能作为字面文字写进 Notion —— 那正是这次要修的东西'
    );
  });
});
