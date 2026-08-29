/**
 * Moving a local guide into Notion
 * ------------------------------------------------
 * Run with: node --test
 *
 * The failure class this file guards is **something is lost in the move and neither side
 * reports it**. What is being moved is a guide the user spent a long time writing, so every
 * case here points at "it is gone but it looks like it worked":
 *
 *  - The fidelity check has to genuinely be able to fail. Changed text, a changed count and
 *    **a changed checked state** all have to be stopped — the checked state is the most
 *    hidden of the three: the page looks full, a few boxes have merely ticked themselves
 *  - When the check does not pass, **the local file must be untouched**. "The original is
 *    still there" is the premise of moving at all; lose that one and every other precaution
 *    above was for nothing
 *  - Archiving is a move, not a delete, and it is the last step
 *  - **lintGuide must not be used as a gate.** A hand-written guide failing the gate is
 *    normal (in the measured corpus 330 achievements had no matching checkbox), so using it
 *    as a threshold means refusing to move the vast majority of real guides
 *
 * No network: Notion is fake.
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
// Scaffolding
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
 * Fake Notion. The read-back is **reconstructed from the blocks actually written**, so what
 * the fidelity check compares really is "the copy that went out" rather than a separately
 * invented set of data. `corrupt` models the various "it was written but it is wrong" cases.
 */
/**
 * Fake Steam. Moving a guide needs exactly one thing from it: the icon hash.
 * `img = null` models "Steam has no icon for this game", where the page still has to be
 * creatable.
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
      // Options copied from the real guide database, or the test would pass against a
      // database that does not exist in reality
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

describe('checkFidelity — pure comparison', () => {
  test('after `**` and `<br>` are normalised, the two sides should be identical', () => {
    assert.equal(normalizeForCompare('**名字**<br>描述'), '名字\n描述');
  });

  test('completely identical → ok', () => {
    const a = [{ text: '**甲**<br>描述', checked: true }];
    const b = [{ text: '甲\n描述', checked: true }];
    assert.equal(checkFidelity(a, b).ok, true);
  });

  test('a different count → reported', () => {
    const r = checkFidelity([{ text: 'a' }, { text: 'b' }], [{ text: 'a' }]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /条目数对不上/);
  });

  test('changed text → reported, with both sides printed', () => {
    const r = checkFidelity([{ text: '原来的字' }], [{ text: '变了的字' }]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /原来的字[\s\S]*变了的字/);
  });

  test('same text but a changed checked state → reported separately, the most hidden kind of damage', () => {
    const r = checkFidelity([{ text: '甲', checked: false }], [{ text: '甲', checked: true }]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /勾选状态被改了/);
  });

  test('too many problems are truncated rather than flooding the terminal', () => {
    const a = Array.from({ length: 50 }, (_, i) => ({ text: 'a' + i }));
    const b = Array.from({ length: 50 }, (_, i) => ({ text: 'b' + i }));
    assert.ok(checkFidelity(a, b).problems.length <= 11);
  });
});

describe('planMigration — look before writing', () => {
  test('a guide already on Notion does not need moving', async () => {
    const { db, config } = freshEnv({ kind: 'notion' });
    await assert.rejects(planMigration(db, { notion: fakeNotion(), config, appid: '1' }), /已经在 Notion/);
  });

  test('no guide registered → refused', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(planMigration(db, { notion: fakeNotion(), config, appid: '999' }), /没有登记/);
  });

  test('Notion not configured → says plainly where to configure it', async () => {
    const { db, config } = freshEnv();
    const notion = { ...fakeNotion(), configured: false };
    await assert.rejects(planMigration(db, { notion, config, appid: '1' }), /还没配置 Notion/);
  });

  test('a file with not one checkbox → refused (most likely the wrong file)', async () => {
    const { db, config } = freshEnv({ text: 'appid: 1\n\n只是一段普通文字。\n' });
    await assert.rejects(planMigration(db, { notion: fakeNotion(), config, appid: '1' }), /一个 checkbox 都没有/);
  });

  test('the preview gives block-type counts and degraded lines, and writes nothing', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    const p = await planMigration(db, { notion, config, appid: '1' });
    assert.equal(p.todos.length, 3);
    assert.equal(p.byType.table, 1, 'a table should become a table block, not three paragraphs');
    assert.equal(p.byType.heading_2, 2);
    assert.equal(notion.written.length, 0, 'a preview must not write anything');
    assert.equal(notion.created.length, 0);
  });
});

describe('migrateGuideToNotion — move, then check entry by entry', () => {
  test('everything normal: create the page, write the blocks, pass the check, switch to notion, archive the local file', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion();
    const r = await run(db, config, notion);

    assert.equal(r.count, 3);
    assert.equal(r.url, 'https://notion.so/new-page');
    assert.equal(notion.created[0].title, '测试游戏');
    assert.equal(getGuide(db, '1').kind, 'notion', 'the guides table has to switch from local to notion');
    assert.equal(existsSync(join(dir, file)), false, 'it should no longer be in its original place');
    assert.equal(existsSync(join(dir, MIGRATED_DIR, file)), true, 'but it has to still be in .migrated/');
    assert.equal(readFileSync(join(dir, MIGRATED_DIR, file), 'utf8'), GUIDE, 'what is archived is the original, not a modified copy');
  });

  test('the checked state carries over as is — moving does not touch checkboxes', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    await run(db, config, notion);
    const todos = await notion.fetchAllToDoBlocks();
    assert.deepEqual(todos.map((t) => t.checked), [true, false, false]);
  });

  test('the read-back text does not match → throws, and **the local file does not move an inch**', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({
      corrupt: (todos) => todos.map((t, i) => (i === 0 ? { ...t, text: '被改过的字' } : t)),
    });
    await assert.rejects(run(db, config, notion), /回读对不上/);
    assert.equal(existsSync(join(dir, file)), true, 'a failed move has to leave the original in place');
    assert.equal(getGuide(db, '1').kind, 'local', 'the guides table should not change either');
  });

  test('the read-back is one entry short → throws, the local file is still there', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({ corrupt: (todos) => todos.slice(1) });
    await assert.rejects(run(db, config, notion), /条目数对不上/);
    assert.equal(existsSync(join(dir, file)), true);
  });

  test('the read-back has ticked a box that was not ticked → throws, the local file is still there', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({ corrupt: (todos) => todos.map((t) => ({ ...t, checked: true })) });
    await assert.rejects(run(db, config, notion), /勾选状态被改了/);
    assert.equal(existsSync(join(dir, file)), true);
  });

  test('discovery cannot read the appid → throws, the local file is still there', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion();
    notion.extractAppIdFromPageContent = async () => null;
    await assert.rejects(run(db, config, notion), /没能从上面读出 appid/);
    assert.equal(existsSync(join(dir, file)), true);
  });

  test('a guide that cannot pass lint moves all the same — moving does not grade the guide', async () => {
    // The achievement name matches nothing and the description is not the official text:
    // lintGuide will report a pile of findings, but none of that is the move's business
    const { db, config } = freshEnv({
      text: 'appid: 1\n\n- [ ] 随便写的一行,根本不是成就名\n- [x] 另一行\n',
    });
    const r = await run(db, config, fakeNotion());
    assert.equal(r.count, 2);
    assert.equal(getGuide(db, '1').kind, 'notion');
  });

  test('an empty same-titled page is filled in rather than a second page being created', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    const r = await run(db, config, notion);
    assert.equal(notion.created.length, 0);
    assert.equal(r.url, 'u1');
  });

  test('a same-titled page with content → refused, nothing is appended after what the user hand-wrote', async () => {
    const { db, config, dir, file } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏' }] });
    notion.countChildren = async () => 7;
    await assert.rejects(run(db, config, notion), /里面有内容/);
    assert.equal(existsSync(join(dir, file)), true);
  });
});

/**
 * The icon. Moved pages and pages generated by `guide-gen` sit in the same guide database,
 * and one batch having icons while another does not simply looks like the move dropped
 * something — these cases guard exactly that "one thing is missing" silent failure:
 * it raises no error and the read-back check is entirely green; it is visible only when a
 * person opens Notion.
 */
describe('page icon', () => {
  test('a newly created page carries the Steam icon', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    await run(db, config, notion);
    assert.match(notion.created[0].icon, /deadbeef\.jpg$/);
  });

  test('Steam has no icon → the page is created as usual and is not blocked over it', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    const r = await run(db, config, notion, fakeSteam(null));
    assert.equal(notion.created[0].icon, null);
    assert.equal(r.count, 3, 'not getting an icon does not affect the move itself');
  });

  test('the Steam endpoint is down → the page is created as usual', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion();
    const steam = { async fetchOwnedGames() { throw new Error('429'); } };
    const r = await run(db, config, notion, steam);
    assert.equal(notion.created[0].icon, null);
    assert.equal(r.count, 3);
  });

  test('an adopted empty page had no icon → one is added', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion({ pages: [{ id: 'p1', url: 'u1', title: '测试游戏', icon: null }] });
    await run(db, config, notion);
    assert.equal(notion.iconSets.length, 1);
    assert.equal(notion.iconSets[0].pageId, 'p1');
  });

  test('an adopted empty page already has an icon → not one character is touched (even an emoji)', async () => {
    const { db, config } = freshEnv();
    const notion = fakeNotion({
      pages: [{ id: 'p1', url: 'u1', title: '测试游戏', icon: { type: 'emoji', emoji: '🌯' } }],
    });
    await run(db, config, notion);
    assert.deepEqual(notion.iconSets, [], 'an icon the user picked is not something for us to fix while we are here');
  });
});

describe('the content that was moved', () => {
  test('a table moves as a table block, not three lines of text', () => {
    const { blocks } = markdownToBlocks(GUIDE);
    const table = blocks.find((b) => b.type === 'table');
    assert.ok(table, 'if the table is lost, the reference table becomes something to hunt for in prose');
    assert.equal(table.table.children.length, 2);
  });

  test('nested sub-steps still hang under the parent achievement', () => {
    const { blocks } = markdownToBlocks(GUIDE);
    const todos = blocks.filter((b) => b.type === 'to_do');
    assert.equal(todos.length, 2);
    assert.equal(todos[1].to_do.children.length, 1);
  });
});

describe('a new page takes its status from real progress', () => {
  const statusOf = async (achieved, total) => {
    const { db, config } = freshEnv({ achieved, total });
    const notion = fakeNotion();
    await run(db, config, notion);
    return notion.created[0].status.value;
  };

  test('some unlocked → In progress (50/51 is exactly this case)', async () => {
    assert.equal(await statusOf(50, 51), 'In progress');
  });

  test('none unlocked → Not started', async () => {
    assert.equal(await statusOf(0, 51), 'Not started');
  });

  test('all achievements → Done', async () => {
    assert.equal(await statusOf(51, 51), 'Done');
  });

  test('never Staged — that value means "was complete and then got knocked below"', async () => {
    for (const [a, t] of [[0, 51], [50, 51], [51, 51]]) {
      assert.notEqual(await statusOf(a, t), 'Staged');
    }
  });
});

/**
 * Once a mutual-exclusion note (`<span underline="true">…</span>`) becomes a Notion underline
 * annotation, **the read-back text no longer contains the tag** — while the file does. If the
 * fidelity check does not know that, every guide carrying such a note fails at "the read-back
 * does not match", and fails for no discernible reason: not one character of content changed,
 * the marking merely moved into annotations. `**` has been handled this way all along.
 */
describe('a mutual-exclusion note must not break the fidelity check', () => {
  const WITH_SPAN = [
    'appid: 1',
    '',
    '- [x] **第一步**<br>完成第一关。<br>选了这个。<span underline="true">如果选另一个则无法获得本成就。</span>',
    '- [ ] **第二步**<br>完成第二关。<br>接着打',
    '',
  ].join('\n');

  test('after normalisation, the tag in the file equals the plain text read back from Notion', () => {
    assert.equal(
      normalizeForCompare('心得。<span underline="true">互斥警告。</span>'),
      normalizeForCompare('心得。互斥警告。')
    );
  });

  test('a guide carrying a mutual-exclusion note moves across and passes the entry-by-entry check', async () => {
    const { db, config } = freshEnv({ text: WITH_SPAN });
    const notion = fakeNotion();
    const r = await run(db, config, notion);
    assert.equal(r.count, 2);
    assert.equal(getGuide(db, '1').kind, 'notion');
  });

  test('the moved entry really carries an underline annotation rather than the tag being written as text', async () => {
    const { db, config } = freshEnv({ text: WITH_SPAN });
    const notion = fakeNotion();
    await run(db, config, notion);
    const runs = notion.written.flatMap((b) => b[b.type].rich_text ?? []);
    const underlined = runs.filter((x) => x.annotations?.underline);
    assert.equal(underlined.length, 1);
    assert.equal(underlined[0].text.content, '如果选另一个则无法获得本成就。');
    assert.ok(
      !runs.some((x) => x.text.content.includes('<span')),
      'the tag must not be written into Notion as literal text — that is exactly what was being fixed'
    );
  });
});
