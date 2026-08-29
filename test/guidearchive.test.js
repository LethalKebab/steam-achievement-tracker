/**
 * Guide archives (list / view / restore / delete)
 * ------------------------------------------------
 * Run with: node --test
 *
 * Before this module existed the three archive directories were **write-only**, so the failure
 * class here has two directions, and they are not equally severe:
 *
 *  1. **Restore loses something.** A restore is itself an overwrite — and what it overwrites is
 *     often a guide the user wrote by hand. So "back up before overwriting", "the archive must
 *     not be consumed by the restore" and "a read-back that does not match has to be stopped"
 *     each have their own test. Without the first, one misclicked restore is an irreversible
 *     delete.
 *
 *  2. **The archive id is a string from the browser.** It ends up as a `readFileSync` /
 *     `rmSync` path. The containment tests here are not a formality: let
 *     `.backups/../../config.json` through and the setup page carries an arbitrary-file-delete
 *     button.
 *
 * One more thing is watched separately because it "looks like it worked": in a Notion backup
 * child blocks hang off a top-level `children`, and writing them back has to nest them into
 * `[type].children`. Get it wrong and the page writes fine with the right block count, only
 * **every sub-step has been promoted to an achievement** — and nesting depth is exactly how
 * checkbox syncing tells those two apart.
 *
 * No network: Notion is fake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, insertGame, upsertGuide, getGuide } from '../lib/db.js';
import { blocksForAppend } from '../lib/notionblocks.js';
import {
  ARCHIVE_DIRS,
  listArchives,
  readArchive,
  restoreArchive,
  deleteArchive,
  deleteArchives,
  parseArchiveId,
  archiveIdOf,
  todosFromBlocks,
} from '../lib/guidearchive.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const GUIDE = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '- [x] **第一步**<br>完成第一关。',
  '- [ ] **第二步**<br>完成第二关。',
  '  - [ ] 子步骤甲',
  '',
].join('\n');

/** Notion rich_text. `plain_text` is required — richTextToPlain reads only that field */
const rt = (s) => [{ type: 'text', text: { content: s }, plain_text: s }];

/** A block exactly as read back (top-level children, every read-only field present), the shape a backup stores */
const raw = (type, text, extra = {}, children = null) => ({
  object: 'block',
  id: `id-${text}`,
  parent: { type: 'page_id', page_id: 'p1' },
  created_time: '2026-08-01T00:00:00.000Z',
  last_edited_time: '2026-08-01T00:00:00.000Z',
  created_by: { object: 'user', id: 'u1' },
  has_children: Boolean(children),
  archived: false,
  type,
  [type]: { rich_text: rt(text), ...extra },
  ...(children ? { children } : {}),
});

const NOTION_BLOCKS = [
  raw('heading_2', '主线'),
  raw('to_do', '第一步', { checked: true }),
  raw('to_do', '第二步', { checked: false }, [raw('to_do', '子步骤甲', { checked: false })]),
];

function freshEnv({ guides = {}, archives = {}, kind = 'local', url = 'test_guide.md' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'archive-'));
  for (const [name, text] of Object.entries(guides)) writeFileSync(join(dir, name), text);
  for (const [sub, files] of Object.entries(archives)) {
    mkdirSync(join(dir, sub), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, sub, name), text);
  }
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  if (url) upsertGuide(db, { appid: '1', name: '测试游戏', url, kind });
  return { db, config: { guidesDir: dir }, dir };
}

/**
 * Fake Notion. **The read-back is reconstructed from the blocks actually written**, so the
 * fidelity check really does compare against the copy sent this time. It also reads child
 * blocks in the append shape (`[type].children`) rather than the backup shape (top-level
 * `children`) — get that conversion wrong and this reads back a flattened list.
 */
function fakeNotion({ current = NOTION_BLOCKS } = {}) {
  return {
    configured: true,
    deleted: [],
    appended: [],
    fetched: 0,
    async fetchAllBlocks() {
      this.fetched++;
      return current;
    },
    async deleteBlock(id) {
      this.deleted.push(id);
    },
    async appendBlocks(_pageId, blocks) {
      this.appended.push(...blocks);
      return blocks.length;
    },
    async fetchAllToDoBlocks() {
      const out = [];
      const walk = (list, parent) => {
        for (const b of list ?? []) {
          if (b.type === 'to_do') {
            out.push({
              key: `k${out.length}`,
              text: b.to_do.rich_text.map((r) => r.plain_text).join(''),
              checked: Boolean(b.to_do.checked),
              parent,
            });
            walk(b.to_do.children, b.id ?? `k${out.length}`);
            continue;
          }
          walk(b[b.type]?.children, parent);
        }
      };
      walk(this.appended, null);
      return out;
    },
  };
}

const backupJson = (blocks = NOTION_BLOCKS, over = {}) =>
  JSON.stringify({
    appid: '1',
    url: 'https://notion.so/1234567890abcdef1234567890abcdef',
    savedAt: '2026-08-19T00:00:00.000Z',
    blocks,
    ...over,
  });

// ---------------------------------------------------------------------------
// The archive id: this string comes from the browser
// ---------------------------------------------------------------------------

describe('archive id', () => {
  const config = { guidesDir: join(tmpdir(), 'nowhere') };

  test('an ordinary filename in each of the three archive directories is recognised', () => {
    for (const dir of ARCHIVE_DIRS) {
      const r = parseArchiveId(config, `${dir}/1-20260820-122121.md`);
      assert.equal(r.dir, dir);
      assert.equal(r.file, '1-20260820-122121.md');
    }
  });

  // Let any one of these through and the setup page carries an arbitrary-file read/write button
  for (const bad of [
    '.backups/../../config.json',
    '.backups/..\\..\\config.json',
    '.backups/sub/deeper.md',
    '.backups/..',
    '.backups/.',
    '.backups/',
    '.backups',
    '../config.json',
    'guides/.backups/x.md',
    '.git/config',
    'C:/Windows/win.ini',
    '/etc/passwd',
    '',
    null,
  ]) {
    test(`blocks ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseArchiveId(config, bad), /存档编号/);
    });
  }

  test('blocks a filename hiding a NUL', () => {
    assert.throws(() => parseArchiveId(config, '.backups/x\0.md'), /存档编号/);
  });

  // These names have special meanings on Windows, and none of them carries a separator — a rule
  // of "no / and no \" alone lets them all through
  for (const bad of ['.backups/C:', '.backups/nul', '.backups/COM1', '.backups/....', '.backups/x.txt']) {
    test(`blocks ${JSON.stringify(bad)} — what cannot be listed should not be clickable`, () => {
      assert.throws(() => parseArchiveId(config, bad), /存档编号/);
    });
  }

  test('allows a Chinese filename — a hand-named guide has to be restorable after being moved away', () => {
    const r = parseArchiveId(config, '.migrated/中文攻略_achievements.md');
    assert.equal(r.file, '中文攻略_achievements.md');
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('listing archives', () => {
  // The directories are interleaved rather than sectioned. What is being looked for is usually
  // the copy that was just overwritten, and which directory it is in depends on the backend at
  // the time — sectioning by directory means answering a question correctly before the search
  // can even start
  test('the three directories are interleaved newest first, not sectioned', () => {
    const { db, config } = freshEnv({
      archives: {
        '.backups': { '1-20250810-100000.md': GUIDE, '1-20260820-100000.json': backupJson() },
        '.migrated': { 'old_guide.md': GUIDE }, // just written, so its mtime is now and it is the newest
      },
    });
    assert.deepEqual(
      listArchives(db, config).map((e) => e.file),
      ['old_guide.md', '1-20260820-100000.json', '1-20250810-100000.md']
    );
  });

  test('for .backups the appid and time come from the filename, not the mtime', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20250102-030405.md': GUIDE } },
    });
    const [e] = listArchives(db, config);
    assert.equal(e.appid, '1');
    assert.equal(e.game, '测试游戏', 'the appid has to resolve back to a game name');
    // The file was just written, so its mtime is now; landing on 2025 is what proves the
    // filename is what was read
    assert.equal(new Date(e.savedAt).getFullYear(), 2025);
    assert.equal(new Date(e.savedAt).getMonth(), 0);
    assert.equal(new Date(e.savedAt).getDate(), 2);
  });

  test('.md is a local guide, .json is a whole Notion page', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.md': GUIDE, '1-20260820-100001.json': backupJson() } },
    });
    const byFile = Object.fromEntries(listArchives(db, config).map((e) => [e.file, e.kind]));
    assert.equal(byFile['1-20260820-100000.md'], 'local');
    assert.equal(byFile['1-20260820-100001.json'], 'notion');
  });

  test('for .migrated / .drafts the appid is read out of the body', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'whatever_name.md': GUIDE } },
    });
    const [e] = listArchives(db, config);
    assert.equal(e.appid, '1', 'there is no appid in the filename, so it can only come from the `appid:` line');
    assert.equal(e.game, '测试游戏');
  });

  test('the listing carries no body text — one backup is hundreds of thousands of bytes', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.json': backupJson() } },
    });
    const [e] = listArchives(db, config);
    assert.equal(e.text, undefined);
    assert.ok(e.bytes > 0, 'but the size has to be there — it is what the listing uses to judge whether opening it is worth it');
  });

  test('anything that is not .md / .json is not listed, and neither are subdirectories', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.md': GUIDE, 'notes.txt': 'x', '.DS_Store': 'x' } },
    });
    mkdirSync(join(config.guidesDir, '.backups', 'nested'));
    assert.deepEqual(listArchives(db, config).map((e) => e.file), ['1-20260820-100000.md']);
  });

  test('a missing directory is not an error, it counts as empty', () => {
    const { db, config } = freshEnv();
    assert.deepEqual(listArchives(db, config), []);
  });

  // Filtering by game is the **main usage** — the entry point is the ⋯ menu on every Dashboard
  // row, and the question is always "where did the previous version of this one game go". The
  // unfiltered listing is left with only two jobs: total footprint and orphans
  describe('filtering by appid', () => {
    const env = () =>
      freshEnv({
        archives: {
          '.backups': { '1-20260820-100000.md': GUIDE, '2-20260820-100001.md': GUIDE },
          '.migrated': { 'other.md': GUIDE.replace('appid: 1', 'appid: 2') },
        },
      });

    test('only this game is returned', () => {
      const { db, config } = env();
      assert.deepEqual(listArchives(db, config, { appid: '1' }).map((e) => e.file),
        ['1-20260820-100000.md']);
      assert.equal(listArchives(db, config, { appid: '2' }).length, 2);
    });

    test('a numeric and a string appid are the same game', () => {
      const { db, config } = env();
      assert.equal(listArchives(db, config, { appid: 1 }).length, 1, 'what rpc passes down may be a number');
    });

    test('a game with no archives gets an empty array, not everything', () => {
      const { db, config } = env();
      assert.deepEqual(listArchives(db, config, { appid: '999' }), [],
        'a broken filter makes every game in the menu show the same set of archives');
    });

    test('without an appid it is still the full listing', () => {
      const { db, config } = env();
      assert.equal(listArchives(db, config).length, 3);
      assert.equal(listArchives(db, config, {}).length, 3);
    });
  });

  // Orphans are the **only** remaining reason the full listing on the setup page has to exist:
  // the game was deleted, there is no row for it on the Dashboard, and the ⋯ menu can never
  // reach these
  describe('orphaned archives', () => {
    test('a game in the library is not an orphan', () => {
      const { db, config } = freshEnv({
        archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
      });
      assert.equal(listArchives(db, config)[0].orphan, false);
    });

    test('a game not in the library is an orphan', () => {
      const { db, config } = freshEnv({
        archives: { '.backups': { '777-20260820-100000.md': GUIDE } },
      });
      const [e] = listArchives(db, config);
      assert.equal(e.orphan, true);
      assert.equal(e.game, 'AppID 777', 'with no name to look up, report the appid rather than leaving it blank');
    });

    test('a file without even an appid line is an orphan too — it cannot say which game it belongs to', () => {
      const { db, config } = freshEnv({
        archives: { '.drafts': { 'headless.md': '# 没头的\n\n- [ ] 一条\n' } },
      });
      const [e] = listArchives(db, config);
      assert.equal(e.orphan, true);
      assert.equal(e.appid, null);
    });
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('viewing one archive', () => {
  test('a local archive gives back the original text', () => {
    const { config } = freshEnv({ archives: { '.migrated': { 'g.md': GUIDE } } });
    const r = readArchive(config, '.migrated/g.md');
    assert.equal(r.text, GUIDE, 'not one character may change — this is what a restore writes back');
  });

  test('a Notion archive renders to plain text and reports block and entry counts', () => {
    const { config } = freshEnv({ archives: { '.backups': { '1-20260820-100000.json': backupJson() } } });
    const r = readArchive(config, '.backups/1-20260820-100000.json');
    assert.equal(r.kind, 'notion');
    assert.equal(r.blocks, 3, 'three top-level blocks');
    assert.equal(r.todos, 3, 'two achievements plus one sub-step');
    assert.match(r.text, /第一步/);
    assert.match(r.text, /子步骤甲/, 'nested child blocks have to be pulled out too');
  });
});

// ---------------------------------------------------------------------------
// Restore: local
// ---------------------------------------------------------------------------

describe('restoring a local archive', () => {
  test('a .migrated file goes back into guides/ under its original name and is registered as local', async () => {
    const { db, config, dir } = freshEnv({
      kind: 'notion',
      url: 'https://notion.so/abc',
      archives: { '.migrated': { 'old_guide.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.migrated/old_guide.md' });

    assert.equal(r.file, 'old_guide.md');
    assert.equal(readFileSync(join(dir, 'old_guide.md'), 'utf8'), GUIDE);
    assert.equal(getGuide(db, '1').kind, 'local');
    assert.equal(getGuide(db, '1').url, 'old_guide.md');
    assert.equal(r.unregisteredNotion, 'https://notion.so/abc', 'the Notion page was displaced, which has to be said');
  });

  test('a restore does not consume the archive — that copy is still where it was', async () => {
    const { db, config, dir } = freshEnv({
      archives: { '.migrated': { 'old_guide.md': GUIDE } },
      url: null,
    });
    await restoreArchive(db, { config, id: '.migrated/old_guide.md' });
    assert.ok(existsSync(join(dir, '.migrated', 'old_guide.md')), 'a restore copies back, it does not move back');
  });

  test('back up before overwriting an existing guide, into .backups/', async () => {
    const { db, config, dir } = freshEnv({
      guides: { 'test_guide.md': '# 现在这份\nappid: 1\n\n- [ ] 手写的东西\n' },
      archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' });

    assert.ok(r.backedUpTo, 'an overwrite with no backup is an irreversible delete');
    assert.match(readFileSync(r.backedUpTo, 'utf8'), /手写的东西/, 'the backup has to hold the copy that was displaced');
    assert.equal(readFileSync(join(dir, 'test_guide.md'), 'utf8'), GUIDE);
  });

  test('no target file means there is nothing to back up, and that must not be an error', async () => {
    const { db, config } = freshEnv({
      archives: { '.migrated': { 'brand_new.md': GUIDE } },
      url: null,
    });
    const r = await restoreArchive(db, { config, id: '.migrated/brand_new.md' });
    assert.equal(r.backedUpTo, null);
    assert.equal(r.ok, true);
  });

  test('a .backups file goes back to the filename this game is currently registered under', async () => {
    const { db, config, dir } = freshEnv({
      url: 'my_own_name.md',
      guides: { 'my_own_name.md': '# 旧的\nappid: 1\n' },
      archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' });
    assert.equal(r.file, 'my_own_name.md', 'the filename is `<appid>-<time>.md`, which is not a guide name');
    assert.ok(existsSync(join(dir, 'my_own_name.md')));
  });

  test('when this game has no local guide yet, a filename is made up on the spot', async () => {
    const { db, config } = freshEnv({
      kind: 'notion',
      url: 'https://notion.so/abc',
      archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' });
    assert.match(r.file, /_achievements\.md$/);
    assert.ok(!r.file.startsWith('1-'), 'the backup filename must not be used as the guide name');
  });

  test('an archive with no appid line is refused, with the reason stated plainly', async () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'headless.md': '# 没头的\n\n- [ ] 一条\n' } },
      url: null,
    });
    await assert.rejects(
      () => restoreArchive(db, { config, id: '.drafts/headless.md' }),
      /appid/,
      'restoring it would not register it either, which amounts to dropping an invisible file'
    );
  });

  test('a missing archive has to be said out loud, not succeed quietly', async () => {
    const { db, config } = freshEnv();
    mkdirSync(join(config.guidesDir, '.backups'), { recursive: true });
    await assert.rejects(
      () => restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' }),
      /不在了/
    );
  });
});

// ---------------------------------------------------------------------------
// Restore: Notion
// ---------------------------------------------------------------------------

describe('restoring a Notion archive', () => {
  const id = '.backups/1-20260820-100000.json';
  const env = () =>
    freshEnv({
      kind: 'notion',
      url: 'https://notion.so/1234567890abcdef1234567890abcdef',
      archives: { '.backups': { '1-20260820-100000.json': backupJson() } },
    });

  test('back up the current page first, then delete, then write', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    const r = await restoreArchive(db, { config, notion, id });

    assert.ok(r.backedUpTo, 'a restore is an overwrite too');
    assert.ok(existsSync(r.backedUpTo));
    assert.deepEqual(
      notion.deleted,
      NOTION_BLOCKS.map((b) => b.id),
      'what is deleted has to be exactly the batch that was just backed up'
    );
    assert.equal(notion.appended.length, 3);
  });

  test('the batch deleted and the batch backed up come from the same read', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    await restoreArchive(db, { config, notion, id });
    assert.equal(notion.fetched, 1, 'reading the page twice leaves a gap where the backed-up batch is not the deleted batch');
  });

  test('child blocks are nested into [type].children on write-back rather than flattened up a level', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    await restoreArchive(db, { config, notion, id });

    const second = notion.appended.find((b) => b.to_do?.rich_text?.[0]?.plain_text === '第二步');
    assert.equal(second.to_do.children.length, 1, 'flattened, every sub-step is promoted to an achievement');
    assert.equal(second.children, undefined, 'top-level children is the read-back shape and is not accepted on write');
  });

  test('read-only fields must not be written back', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    await restoreArchive(db, { config, notion, id });
    for (const b of notion.appended) {
      for (const f of ['id', 'created_time', 'last_edited_time', 'has_children', 'parent', 'archived']) {
        assert.equal(b[f], undefined, `carrying ${f} across is a 400`);
      }
    }
  });

  test('a read-back that does not match throws, and says where the backup is', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    // It was written, but one entry short — the page looks full, it is merely cut off
    notion.appendBlocks = async function (_id, blocks) {
      this.appended.push(...blocks.slice(0, 1));
      return 1;
    };
    await assert.rejects(
      () => restoreArchive(db, { config, notion, id }),
      (err) => /对不上/.test(err.message) && /\.backups/.test(err.message)
    );
  });

  test('with Notion unconfigured it refuses to act, and does so before anything is deleted', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    notion.configured = false;
    await assert.rejects(() => restoreArchive(db, { config, notion, id }), /Notion/);
    assert.deepEqual(notion.deleted, []);
    assert.equal(notion.fetched, 0);
  });

  test('a backup with no page address recorded is not guessed at', async () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.json': backupJson(NOTION_BLOCKS, { url: '' }) } },
    });
    const notion = fakeNotion();
    await assert.rejects(() => restoreArchive(db, { config, notion, id }), /页面地址/);
    assert.deepEqual(notion.deleted, []);
  });

  test('with not one writable block, the page is left alone', async () => {
    const { db, config } = freshEnv({
      archives: {
        '.backups': {
          '1-20260820-100000.json': backupJson([
            { object: 'block', id: 'x', type: 'child_database', child_database: { title: '别的东西' } },
          ]),
        },
      },
    });
    const notion = fakeNotion();
    await assert.rejects(() => restoreArchive(db, { config, notion, id }), /写回去的块/);
    assert.deepEqual(notion.deleted, [], 'once deleted it never comes back');
  });
});

// ---------------------------------------------------------------------------
// Block shape conversion
// ---------------------------------------------------------------------------

describe('blocksForAppend', () => {
  test('only the type and its payload survive, nothing else is carried', () => {
    const { blocks } = blocksForAppend([raw('paragraph', '一段')]);
    assert.deepEqual(Object.keys(blocks[0]).sort(), ['object', 'paragraph', 'type']);
  });

  test('a block that cannot be created is dropped and recorded, rather than failing the whole page', () => {
    const { blocks, dropped } = blocksForAppend([
      raw('paragraph', '留着'),
      { object: 'block', id: 'a', type: 'child_database', child_database: {} },
      { object: 'block', id: 'b', type: 'unsupported', unsupported: {} },
      { object: 'block', id: 'c', type: 'child_database', child_database: {} },
    ]);
    assert.equal(blocks.length, 1, 'one child_database should not make a whole guide unwritable');
    assert.deepEqual(dropped, { child_database: 2, unsupported: 1 });
  });

  test('child blocks are converted level by level', () => {
    const { blocks } = blocksForAppend([
      raw('to_do', '一', { checked: false }, [raw('to_do', '二', { checked: false }, [raw('to_do', '三', { checked: false })])]),
    ]);
    assert.equal(blocks[0].to_do.children[0].to_do.children[0].to_do.rich_text[0].plain_text, '三');
  });

  test('fields a table needs to be created, such as table_width, are kept', () => {
    const { blocks } = blocksForAppend([
      {
        object: 'block', id: 't', type: 'table', has_children: true,
        table: { table_width: 2, has_column_header: true, has_row_header: false },
        children: [{ object: 'block', id: 'r', type: 'table_row', table_row: { cells: [rt('a'), rt('b')] } }],
      },
    ]);
    assert.equal(blocks[0].table.table_width, 2);
    assert.equal(blocks[0].table.children.length, 1);
  });
});

describe('todosFromBlocks', () => {
  test('depth first, in the same order as fetchAllToDoBlocks', () => {
    assert.deepEqual(
      todosFromBlocks(NOTION_BLOCKS).map((t) => t.text),
      ['第一步', '第二步', '子步骤甲'],
      'in the wrong order the read-back comparison is all noise'
    );
  });

  test('the checked state travels with it', () => {
    assert.deepEqual(todosFromBlocks(NOTION_BLOCKS).map((t) => t.checked), [true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

describe('deleting an archive', () => {
  test('it is deleted, and the size deleted is reported', () => {
    const { db, config, dir } = freshEnv({ archives: { '.drafts': { 'g.md': GUIDE } } });
    const r = deleteArchive(config, '.drafts/g.md');
    assert.equal(r.ok, true);
    assert.equal(r.bytes, Buffer.byteLength(GUIDE));
    assert.equal(existsSync(join(dir, '.drafts', 'g.md')), false);
    assert.deepEqual(listArchives(db, config), []);
  });

  test('already gone does not count as a failure', () => {
    const { config } = freshEnv({ archives: { '.drafts': {} } });
    const r = deleteArchive(config, '.drafts/gone.md');
    assert.equal(r.ok, true);
    assert.equal(r.alreadyGone, true);
  });

  test('only things inside those three directories can be deleted', () => {
    const { config, dir } = freshEnv({ guides: { 'live_guide.md': GUIDE } });
    assert.throws(() => deleteArchive(config, '.backups/../live_guide.md'), /存档编号/);
    assert.ok(existsSync(join(dir, 'live_guide.md')), 'this is the guide the user is using right now');
  });

  test('deleting one leaves the others alone', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE } },
    });
    deleteArchive(config, '.drafts/a.md');
    assert.deepEqual(listArchives(db, config).map((e) => e.file), ['b.md']);
  });
});

// ---------------------------------------------------------------------------
// Bulk delete — the 「全部删除」 at the end of the setup page listing
// ---------------------------------------------------------------------------

describe('deleting archives in bulk', () => {
  test('a batch is deleted at once, with both the count and the size reported', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE }, '.backups': { 'c.md': GUIDE } },
    });
    const r = deleteArchives(config, ['.drafts/a.md', '.drafts/b.md', '.backups/c.md']);
    assert.equal(r.ok, true);
    assert.equal(r.deleted, 3);
    assert.equal(r.bytes, Buffer.byteLength(GUIDE) * 3);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(listArchives(db, config), []);
  });

  /**
   * This one watches **whether the try is inside the loop or outside it**. Outside, one hostile
   * id shields every id after it that had not been reached yet — while the screen shows one
   * error and the remaining files simply look "not selected", so the next click hits the same
   * bad id all over again.
   */
  test('one bad id does not drag down the ones after it', () => {
    const { db, config, dir } = freshEnv({
      guides: { 'live_guide.md': GUIDE },
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE } },
    });
    const r = deleteArchives(config, ['.backups/../live_guide.md', '.drafts/a.md', '.drafts/b.md']);
    assert.equal(r.deleted, 2, 'the two after the bad id really have to be deleted');
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].error, /存档编号/);
    assert.equal(r.failed[0].id, '.backups/../live_guide.md');
    assert.ok(existsSync(join(dir, 'live_guide.md')), 'the out-of-bounds one still has to be stopped');
    assert.deepEqual(listArchives(db, config), []);
  });

  /**
   * **It deletes the copies named, not "clear the directories".** The difference lands between
   * the page painting and the button being clicked — a rewrite just finished in the background
   * and `.backups/` holds one more file that was never on screen. Clearing the directory eats
   * that one too
   */
  test('only the named ones are deleted, the unnamed ones remain', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE } },
    });
    const r = deleteArchives(config, ['.drafts/a.md']);
    assert.equal(r.deleted, 1);
    assert.deepEqual(listArchives(db, config).map((e) => e.file), ['b.md']);
  });

  test('with no ids given, nothing is deleted', () => {
    const { db, config } = freshEnv({ archives: { '.drafts': { 'a.md': GUIDE } } });
    for (const ids of [[], null, undefined]) {
      const r = deleteArchives(config, ids);
      assert.equal(r.deleted, 0);
      assert.equal(r.bytes, 0);
    }
    assert.equal(listArchives(db, config).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Absolute path → archive id
// ---------------------------------------------------------------------------

describe('archiveIdOf', () => {
  // The 「删除备份」 on the "generation succeeded" screen takes this id to call
  // deleteGuideArchive. It exists so that **server.js does not assemble an id by string
  // concatenation** — the format is defined by parseArchiveId, and with a second copy written
  // elsewhere the symptom of a mismatch is a button that does nothing, not an error
  test('a direct child file in each of the three directories is recognised, and round-trips through the parser', () => {
    const { config } = freshEnv();
    for (const dir of ARCHIVE_DIRS) {
      const id = `${dir}/1-20260820-100000.md`;
      const { path } = parseArchiveId(config, id);
      assert.equal(archiveIdOf(config, path), id, 'the round trip has to close');
    }
  });

  test('anything outside the archive directories is null', () => {
    const { config, dir } = freshEnv();
    assert.equal(archiveIdOf(config, join(dir, 'live_guide.md')), null, 'a guide in use is not an archive');
    assert.equal(archiveIdOf(config, join(dir, '..', 'somewhere.md')), null);
    assert.equal(archiveIdOf(config, 'C:/Windows/win.ini'), null);
  });

  test('one level deeper is not recognised — the listing only lists direct children too', () => {
    const { config, dir } = freshEnv();
    assert.equal(archiveIdOf(config, join(dir, '.backups', 'nested', 'x.md')), null);
  });

  test('the wrong extension is not recognised — the same filter the listing uses', () => {
    const { config, dir } = freshEnv();
    assert.equal(archiveIdOf(config, join(dir, '.backups', 'notes.txt')), null);
  });

  test('empty values do not blow up', () => {
    const { config } = freshEnv();
    assert.equal(archiveIdOf(config, null), null);
    assert.equal(archiveIdOf(config, ''), null);
    assert.equal(archiveIdOf(config, undefined), null);
  });
});
