/**
 * The path that lands a guide on Notion
 * ------------------------------------------------
 * Run with: node --test
 *
 * The failure class this file guards is **damaging what the user already has**, and **writing
 * something that did not actually land correctly and reporting success**. Both are easy on this
 * path, and neither cries out on its own:
 *
 *  - The Notion guide database holds several "the page is created, the guide is not written yet"
 *    empty pages. Creating a second page alongside one with the same title, or appending to a
 *    page that **already holds hand-written notes**, both irreversibly disturb the user's own
 *    notes
 *  - markdown → block conversion, Notion's rendering, nesting depth: any of them can go wrong
 *    while HTTP still returns 200. So after writing there has to be a **read-back re-check**,
 *    and a failed check has to throw rather than be reported as success
 *  - If discovery cannot read the `appid:` line we wrote, the page is there and the content is
 *    there, yet the Dashboard never shows a link
 *
 * No network: both Notion and Steam are fake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertGame, replaceAchievements, getGuide } from '../lib/db.js';
import { landToNotion, DRAFTS_DIR, writeAroundKept } from '../lib/guidegen.js';
// planNotionTarget lives in notion.js rather than guidegen.js — it is "what to ask before
// writing to Notion", it has nothing to do with AI, and the migration path (guidemigrate.js)
// needs it too
import { planNotionTarget, newGuideStatus, GUIDE_STATUS_OPTIONS } from '../lib/notion.js';

/** This used to be a hardcoded constant. The status is now derived from progress, so the test follows with "the derived value" */
const SOME_STATUS = 'In progress';

// ---------------------------------------------------------------------------
// Scaffolding
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
  // The draft handed to landToNotion has **already been mechanically ticked** (generateGuide
  // calls applyChecks inside the loop), so A being unlocked means [x] here. Writing [ ] makes
  // the read-back check report checked-mismatch on the spot
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
 * Fake Notion. `written` collects every appended block, and the read-back derives the to_do
 * list from it — meaning what the "read-back" reads really is what was "written", not a
 * separately invented set of data.
 */
function fakeNotion(opts = {}) {
  const {
    // Use the real one rather than copying it: a copy is one more place that can quietly drift
    // apart from GUIDE_STATUS_OPTIONS
    statusOptions = GUIDE_STATUS_OPTIONS,
    pages = [],
    childCounts = {},
    titleProperty = 'Name',
  } = opts;
  return {
    written: [],
    created: [],
    iconSets: [],
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
    async setPageIcon(pageId, url) {
      this.iconSets.push({ pageId, url });
    },
    async appendBlocks(pageId, blocks) {
      this.written.push(...blocks);
      return blocks.length;
    },
    async fetchAllToDoBlocks() {
      // Reconstructed from the blocks actually written — the read-back reads the copy that went in
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

describe('planNotionTarget — ask everything worth asking before writing', () => {
  test('the status property has no option for what we are about to write → refused, with the existing options listed', async () => {
    const notion = fakeNotion({ statusOptions: ['待办', '完成'] });
    await assert.rejects(
      planNotionTarget(notion, '测试游戏', { statusValue: SOME_STATUS }),
      /待办 \/ 完成/
    );
  });

  test('what is validated is the value actually being written this time, not some fixed value', async () => {
    // `Paused` is used deliberately — it is a legal value the program **no longer writes** (see
    // newGuideStatus), so using it as the positive case is what best shows the check asks about
    // "the value for this write" rather than consulting a built-in list
    const notion = fakeNotion({ statusOptions: ['Paused'] });
    // Paused is in the options → allowed through
    await planNotionTarget(notion, '测试游戏', { statusValue: 'Paused' });
    // Not started is not → stopped on the spot rather than rejected by Notion after the write
    await assert.rejects(
      planNotionTarget(notion, '测试游戏', { statusValue: 'Not started' }),
      /没有「Not started」/
    );
  });

  test('an empty same-titled page is the page to write to, and no second one is created alongside it', async () => {
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    const plan = await planNotionTarget(notion, '测试游戏');
    assert.equal(plan.existingPage.id, 'p1');
  });

  test('a same-titled page already has content → refused, never appended after the user hand-written notes', async () => {
    const notion = fakeNotion({
      pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }],
      childCounts: { p1: 12 },
    });
    await assert.rejects(planNotionTarget(notion, '测试游戏'), /里面有内容/);
  });

  test('two same-titled pages → refused; where it cannot tell which one, it does not guess', async () => {
    const notion = fakeNotion({
      pages: [
        { id: 'p1', url: 'u1', title: '测试游戏' },
        { id: 'p2', url: 'u2', title: '测试游戏' },
      ],
    });
    await assert.rejects(planNotionTarget(notion, '测试游戏'), /分不清/);
  });

  test('the title property name is read, not hardcoded as Name', async () => {
    const notion = fakeNotion({ titleProperty: '名称' });
    const plan = await planNotionTarget(notion, '测试游戏');
    assert.equal(plan.titleProperty, '名称');
  });

  test('the status passes straight through to page creation, unchanged along the way', async () => {
    const notion = fakeNotion();
    const plan = await planNotionTarget(notion, '测试游戏', { statusValue: SOME_STATUS });
    assert.equal(plan.status.value, SOME_STATUS);
  });

  test('with no statusValue no status is set — do not fill one in on the user behalf', async () => {
    const notion = fakeNotion();
    const plan = await planNotionTarget(notion, '测试游戏');
    assert.equal(plan.status, null);
  });

  describe('newGuideStatus — derived from real progress, not a fixed value', () => {
    test('all achievements → Done', () => {
      assert.equal(newGuideStatus({ achieved: 51, total: 51 }), 'Done');
    });
    test('some unlocked → In progress', () => {
      assert.equal(newGuideStatus({ achieved: 50, total: 51 }), 'In progress');
    });
    test('none unlocked → Not started', () => {
      assert.equal(newGuideStatus({ achieved: 0, total: 51 }), 'Not started');
    });
    test('not synced yet (total is null) → Not started, and must not count as complete', () => {
      assert.equal(newGuideStatus({ achieved: null, total: null }), 'Not started');
      assert.equal(newGuideStatus(undefined), 'Not started');
    });
    test('0/0 is not complete — having no achievement system is not the same as having finished', () => {
      assert.equal(newGuideStatus({ achieved: 0, total: 0 }), 'Not started');
    });
  });
});

describe('landToNotion — write it in, then verify by reading back', () => {
  const land = (db, config, draftPath, notion, plan) =>
    landToNotion(db, {
      notion, steam: fakeSteam, config, appid: '1', game: '测试游戏',
      defs: DEFS, unlocked: new Set(['A']),
      plan: basePlan(draftPath, plan),
    });

  test('creating a new page: title, status and icon all carried, with the body blocks appended separately', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => '1';

    const r = await land(db, config, draftPath, notion, {
      status: { property: 'Status', type: 'status', value: SOME_STATUS },
    });

    assert.equal(notion.created.length, 1);
    assert.equal(notion.created[0].title, '测试游戏');
    assert.equal(notion.created[0].status.value, SOME_STATUS);
    assert.match(notion.created[0].icon, /^https:\/\/cdn\.cloudflare\.steamstatic\.com\/.*deadbeef\.jpg$/);
    assert.equal(r.url, 'https://notion.so/new-page');
    // Registration goes through the real discovery logic, so this row really should appear in
    // the guides table
    assert.equal(getGuide(db, '1').kind, 'notion');
  });

  test('using an existing empty page creates no new page and does not touch its title or status', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    notion.extractAppIdFromPageContent = async () => '1';

    const r = await land(db, config, draftPath, notion, {
      existingPage: { id: 'p1', url: 'u1', title: '测试游戏' },
    });

    assert.equal(notion.created.length, 0, 'that page is the user own, so a second one should not be created');
    assert.equal(r.url, 'u1');
    assert.ok(notion.written.length > 0);
  });

  // The icon is the one exception to "an adopted page is not touched at all", and only fills a
  // blank slot: having no icon is not "the user chose to have none", it is a slot nobody has
  // filled. Filling a blank is not overwriting.
  test('an adopted empty page had no icon → one is added', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏', icon: null }] });
    notion.extractAppIdFromPageContent = async () => '1';

    await land(db, config, draftPath, notion, {
      existingPage: { id: 'p1', url: 'u1', title: '测试游戏', icon: null },
    });

    assert.equal(notion.iconSets.length, 1);
    assert.equal(notion.iconSets[0].pageId, 'p1');
    assert.match(notion.iconSets[0].url, /deadbeef\.jpg$/);
  });

  test('an adopted empty page already has an icon → not one character is touched', async () => {
    const { db, config, draftPath } = freshEnv();
    const page = { id: 'p1', url: 'u1', title: '测试游戏', icon: { type: 'emoji', emoji: '🌯' } };
    const notion = fakeNotion({ pages: [page] });
    notion.extractAppIdFromPageContent = async () => '1';

    await land(db, config, draftPath, notion, { existingPage: page });

    assert.deepEqual(notion.iconSets, [], 'an icon the user picked is not something for us to fix while we are here');
  });

  test('a failed icon fill does not affect the landing — the body is the substance', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏', icon: null }] });
    notion.extractAppIdFromPageContent = async () => '1';
    notion.setPageIcon = async () => { throw new Error('Notion 挂了'); };

    const r = await land(db, config, draftPath, notion, {
      existingPage: { id: 'p1', url: 'u1', title: '测试游戏', icon: null },
    });

    assert.equal(r.url, 'u1', 'the guide body is already written in, and one icon must not turn that into a failure');
  });

  test('the # title stays out of the body (the title lives in the property), the appid line goes in (discovery reads it)', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => '1';
    await land(db, config, draftPath, notion, {});

    const texts = notion.written.map((b) => (b[b.type].rich_text ?? []).map((r) => r.text.content).join(''));
    assert.ok(!texts.some((t) => t === '测试游戏'), 'the # title should be dropped');
    assert.ok(texts.some((t) => t === 'appid: 1'));
  });

  test('the page is created even when the icon cannot be fetched — an icon must not block a finished guide', async () => {
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

  test('the read-back check does not pass → throws, and must not be reported as success', async () => {
    // The draft is missing an achievement, so lintGuide reports missing-achievement on read-back
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

  test('discovery cannot read the appid → throws, rather than leaving a guide that never appears on the Dashboard', async () => {
    const { db, config, draftPath } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => null; // cannot be read
    await assert.rejects(land(db, config, draftPath, notion, {}), /没能从上面读出 appid/);
  });
});

/**
 * An overwrite rewrite deletes **only the blocks the generator itself produced**, leaving
 * images, embeds and bookmarks in place. Blocks that stay **cannot be moved** (the Notion API
 * says outright that existing blocks cannot be moved), so the new body is written around them —
 * and these cases pin whether that way around is right.
 */
describe('writeAroundKept — the new body is written around the kept blocks', () => {
  // **The fixture has to be as stingy as reality.** What is passed to writeAroundKept are blocks
  // **we built ourselves** (`markdownToBlocks` → `toRichText`), carrying only `text.content` and
  // **no `plain_text`** — an earlier version supplied both fields here, and so the bug of
  // "the wrong text-extraction function was used" sailed through green all the way to
  // production: the anchor table was empty and the kept bookmark landed at the top of the page.
  const todo = (name) => ({ type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: name } }] } });
  const head = (name) => ({ type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: name } }] } });
  const resolveApi = (s) => ({ '成就甲': 'A', '成就乙': 'B', '成就丙': 'C' })[String(s).trim()] ?? null;

  // After the deletion only the kept blocks remain on the page, in the same order. Replay the
  // insert calls into a final ordering.
  const fake = (keptIds) => ({
    page: [...keptIds],
    calls: [],
    async appendBlocks(_pid, blocks, { after = null, atStart = false } = {}) {
      this.calls.push({ n: blocks.length, after, atStart });
      const names = blocks.map((b) => (b.type === 'to_do' || b.type === 'heading_2'
        ? b[b.type].rich_text[0].text.content : b.type));
      const at = after ? this.page.indexOf(after) + 1 : (atStart ? 0 : this.page.length);
      this.page.splice(at, 0, ...names);
      return { written: blocks.length, lastId: names[names.length - 1] };
    },
  });

  test('a kept block lands back after the achievement it used to follow', async () => {
    const blocks = [head('主线'), todo('成就甲'), todo('成就乙'), todo('成就丙')];
    const n = fake(['IMG']);
    await writeAroundKept(n, 'p', blocks, [{ id: 'IMG', type: 'image', afterApiName: 'A' }], resolveApi);
    assert.deepEqual(n.page, ['主线', '成就甲', 'IMG', '成就乙', '成就丙'],
      'the image has to land after 「成就甲」 — not at the top or the bottom of the page');
    assert.equal(n.calls[0].atStart, true, 'there is no anchor block before the first segment, so it has to be inserted at the top');
  });

  test('several kept blocks each go back to their own place without competing for a slot', async () => {
    const blocks = [todo('成就甲'), todo('成就乙'), todo('成就丙')];
    const n = fake(['IMG', 'BM']);
    await writeAroundKept(n, 'p', blocks, [
      { id: 'IMG', type: 'image', afterApiName: 'A' },
      { id: 'BM', type: 'bookmark', afterApiName: 'C' },
    ], resolveApi);
    assert.deepEqual(n.page, ['成就甲', 'IMG', '成就乙', '成就丙', 'BM']);
  });

  // The anchoring achievement was deleted this time (a delisted DLC, say) — **a less than ideal
  // position is far better than deleting the user image**
  test('prefer=before inserts **ahead of** the anchoring achievement', async () => {
    const blocks = [head('指定关卡'), todo('成就甲'), todo('成就乙')];
    const n = fake(['LINK']);
    await writeAroundKept(n, 'p', blocks,
      [{ id: 'LINK', type: 'paragraph', prefer: 'before', afterApiName: null, beforeApiName: 'A' }], resolveApi);
    assert.deepEqual(n.page, ['指定关卡', 'LINK', '成就甲', '成就乙'],
      'the section note has to land after the heading and before the first achievement');
  });

  test('the anchor is no longer in the new body, and the kept block still must not be lost', async () => {
    const blocks = [todo('成就甲'), todo('成就乙')];
    const n = fake(['IMG']);
    await writeAroundKept(n, 'p', blocks, [{ id: 'IMG', type: 'image', afterApiName: 'ZZZ' }], resolveApi);
    assert.ok(n.page.includes('IMG'), 'losing the anchor must not lose the kept block');
    assert.equal(n.page.length, 3, 'all three blocks are there');
  });
});
