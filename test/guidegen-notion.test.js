/**
 * 攻略落到 Notion 这条路的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的失败类是**写坏用户已经有的东西**,以及**写完了但其实没写对却报成功**。
 * 两件事在这条路上都很容易发生,而且都不会自己喊疼:
 *
 *  - Notion 攻略库里躺着几个"页建好了、攻略还没写"的空页。往同名页上并排再建一个,
 *    或者往一个**已经有手写笔记**的页上追加,都是不可逆地弄乱用户自己的笔记
 *  - markdown → block 的转换、Notion 的渲染、嵌套层级,任何一步出岔子,HTTP 都还是 200。
 *    所以写完必须**回读重校验**,而且校验没过要抛,不能当成功报出去
 *  - 我们写的 `appid:` 行如果发现逻辑读不出来,页面在、内容在,Dashboard 上却永远没有链接
 *
 * 不联网:Notion 和 Steam 都是假的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertGame, replaceAchievements, getGuide } from '../lib/db.js';
import { planNotionTarget, landToNotion, NOTION_NEW_STATUS, DRAFTS_DIR } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const DEFS = [
  { api_name: 'A', name_cn: '第一步', name_en: '', description: '完成第一关。' },
  { api_name: 'B', name_cn: '第二步', name_en: '', description: '完成第二关。' },
];

const DRAFT = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  // 交给 landToNotion 的草稿是**已经机械打过勾**的(generateGuide 在循环里就 applyChecks 了),
  // 所以 A 已解锁 ⇒ 这里是 [x]。写成 [ ] 的话回读校验会当场报 checked-mismatch
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿',
  '- [ ] **第二步**<br>完成第二关。<br>接着打',
  '',
].join('\n');

function freshEnv({ draft = DRAFT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-notion-'));
  mkdirSync(join(dir, DRAFTS_DIR), { recursive: true });
  const draftPath = join(dir, DRAFTS_DIR, 'x.md');
  writeFileSync(draftPath, draft);
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  replaceAchievements(
    db,
    '1',
    DEFS.map((d) => ({
      apiName: d.api_name, gameName: '测试游戏', nameCn: d.name_cn,
      nameEn: d.name_en, description: d.description, hidden: 0, icon: '',
    }))
  );
  return { db, config: { guidesDir: dir }, draftPath };
}

/**
 * 假 Notion。`written` 收下所有被追加的块,回读时按它反推出 to_do 列表 ——
 * 也就是说"回读"读到的确实是"写进去"的那份,而不是另一份编好的数据。
 */
function fakeNotion(opts = {}) {
  const {
    statusOptions = ['Not started', NOTION_NEW_STATUS, 'Done'],
    pages = [],
    childCounts = {},
    titleProperty = 'Name',
  } = opts;
  return {
    written: [],
    created: [],
    pages,
    async fetchGuideDbSchema() {
      return {
        titleProperty,
        status: { property: 'Status', type: 'status', options: statusOptions },
      };
    },
    async queryGuideDatabase() {
      return this.pages;
    },
    async countChildren(id) {
      return childCounts[id] ?? 0;
    },
    async createGuidePage(args) {
      this.created.push(args);
      const page = { id: 'new-page', url: 'https://notion.so/new-page' };
      this.pages.push({ ...page, title: args.title, status: args.status?.value ?? null });
      return page;
    },
    async appendBlocks(pageId, blocks) {
      this.written.push(...blocks);
      return blocks.length;
    },
    async fetchAllToDoBlocks() {
      // 从真写进去的块里还原 —— 回读读到的就是写进去的那份
      const out = [];
      for (const b of this.written) {
        if (b.type !== 'to_do') continue;
        const text = b.to_do.rich_text.map((r) => r.text.content).join('');
        out.push({ key: `k${out.length}`, text, checked: b.to_do.checked, parent: null });
      }
      return out;
    },
  };
}

const fakeSteam = {
  async fetchOwnedGames() {
    return [{ appid: 1, img_icon_url: 'deadbeef' }];
  },
};

const basePlan = (draftPath, notionPlan) => ({
  draftPath,
  unnameable: new Set(),
  notion: { titleProperty: 'Name', status: null, existingPage: null, ...notionPlan },
});

// ---------------------------------------------------------------------------

describe('planNotionTarget —— 写之前把该问的问完', () => {
  test('状态属性里没有我们要写的那个选项 → 拒绝,并列出现有选项', async () => {
    const notion = fakeNotion({ statusOptions: ['待办', '完成'] });
    await assert.rejects(planNotionTarget(notion, '测试游戏'), /待办 \/ 完成/);
  });

  test('同名的空页就是要写的那一页,不再并排建一个', async () => {
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    const plan = await planNotionTarget(notion, '测试游戏');
    assert.equal(plan.existingPage.id, 'p1');
  });

  test('同名页上已经有内容 → 拒绝,绝不往用户手写的笔记后面追加', async () => {
    const notion = fakeNotion({
      pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }],
      childCounts: { p1: 12 },
    });
    await assert.rejects(planNotionTarget(notion, '测试游戏'), /里面有内容/);
  });

  test('两个同名页 → 拒绝,分不清该写哪个就不猜', async () => {
    const notion = fakeNotion({
      pages: [
        { id: 'p1', url: 'u1', title: '测试游戏' },
        { id: 'p2', url: 'u2', title: '测试游戏' },
      ],
    });
    await assert.rejects(planNotionTarget(notion, '测试游戏'), /分不清/);
  });

  test('标题属性名是读出来的,不是写死的 Name', async () => {
    const notion = fakeNotion({ titleProperty: '名称' });
    const plan = await planNotionTarget(notion, '测试游戏');
    assert.equal(plan.titleProperty, '名称');
  });

  test('新页给 Staged —— 游戏真打完了的话 guide-status 会自己提成 Done', async () => {
    const notion = fakeNotion();
    const plan = await planNotionTarget(notion, '测试游戏');
    assert.equal(plan.status.value, NOTION_NEW_STATUS);
  });
});

describe('landToNotion —— 写进去,然后回读验一遍', () => {
  const land = (db, config, draftPath, notion, plan) =>
    landToNotion(db, {
      notion, steam: fakeSteam, config, appid: '1', game: '测试游戏',
      defs: DEFS, unlocked: new Set(['A']),
      plan: basePlan(draftPath, plan),
    });

  test('建新页:标题、状态、图标都带上,正文块另外追加', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => '1';

    const r = await land(db, config, draftPath, notion, {
      status: { property: 'Status', type: 'status', value: NOTION_NEW_STATUS },
    });

    assert.equal(notion.created.length, 1);
    assert.equal(notion.created[0].title, '测试游戏');
    assert.equal(notion.created[0].status.value, NOTION_NEW_STATUS);
    assert.match(notion.created[0].icon, /^https:\/\/cdn\.cloudflare\.steamstatic\.com\/.*deadbeef\.jpg$/);
    assert.equal(r.url, 'https://notion.so/new-page');
    // 登记走的是真的发现逻辑,所以 guides 表里应该真出现这一条
    assert.equal(getGuide(db, '1').kind, 'notion');
  });

  test('用已有的空页时不建新页,也不去动它的标题/图标/状态', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    notion.extractAppIdFromPageContent = async () => '1';

    const r = await land(db, config, draftPath, notion, {
      existingPage: { id: 'p1', url: 'u1', title: '测试游戏' },
    });

    assert.equal(notion.created.length, 0, '那一页是用户建的,不该再建一个');
    assert.equal(r.url, 'u1');
    assert.ok(notion.written.length > 0);
  });

  test('# 标题不进正文(标题在属性里),appid 行进正文(发现逻辑要读它)', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => '1';
    await land(db, config, draftPath, notion, {});

    const texts = notion.written.map((b) => (b[b.type].rich_text ?? []).map((r) => r.text.content).join(''));
    assert.ok(!texts.some((t) => t === '测试游戏'), '# 标题应该被丢掉');
    assert.ok(texts.some((t) => t === 'appid: 1'));
  });

  test('图标拿不到照样建页 —— 图标不该挡住一份写好的攻略', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => '1';
    const brokenSteam = { async fetchOwnedGames() { throw new Error('Steam 挂了'); } };

    const r = await landToNotion(db, {
      notion, steam: brokenSteam, config, appid: '1', game: '测试游戏',
      defs: DEFS, unlocked: new Set(['A']), plan: basePlan(draftPath, {}),
    });
    assert.equal(notion.created[0].icon, null);
    assert.ok(r.url);
  });

  test('回读校验没过 → 抛出来,不能当成功报', async () => {
    // 草稿里少写了一个成就,回读时 lintGuide 会报 missing-achievement
    const { db, config, draftPath } = freshEnv({
      draft: 'appid: 1\n\n- [ ] **第一步**<br>完成第一关。<br>开局就能拿\n',
    });
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => '1';
    await assert.rejects(
      land(db, config, draftPath, notion, {}),
      /回读校验没过[\s\S]*第二步/
    );
  });

  test('发现逻辑读不出 appid → 抛出来,别留一条 Dashboard 上永远不出现的攻略', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => null; // 读不到
    await assert.rejects(land(db, config, draftPath, notion, {}), /没能从上面读出 appid/);
  });
});
