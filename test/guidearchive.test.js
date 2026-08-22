/**
 * 攻略备份(列出 / 看 / 恢复 / 删)的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这三个归档目录在这个模块出现之前是**只进不出**的,所以这里守的失败类有两个方向,
 * 而且它们的严重程度不一样:
 *
 *  1. **恢复把东西弄丢了。** 恢复本身是一次覆盖 —— 它覆盖的还常常是用户手写的攻略。
 *     所以"覆盖前必须先备份""存档本身不许被恢复消耗掉""回读对不上要拦下来"
 *     这三条各有测试。少了第一条,一次点错的恢复就是不可逆的删除。
 *
 *  2. **存档编号是从浏览器来的字符串。** 它最后会变成一个 `readFileSync` /
 *     `rmSync` 的路径。这里的越界测试不是走形式:`.backups/../../config.json`
 *     这一条如果放过去,设置页上就有一个任意文件删除按钮。
 *
 * 另外单独盯一件容易"看着成了"的事:Notion 备份里子块挂在顶层 `children`,写回去时
 * 必须嵌进 `[type].children`。搞错了页面能写成、块数也对,只是**所有子步骤都升级成了
 * 成就** —— 而 checkbox 同步正是靠嵌套深度分辨这两者的。
 *
 * 不联网:Notion 是假的。
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
// 脚手架
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

/** Notion 的 rich_text。`plain_text` 是必须的 —— richTextToPlain 只认这个字段 */
const rt = (s) => [{ type: 'text', text: { content: s }, plain_text: s }];

/** 一个读回来的原样块(顶层 children,只读字段齐全),就是备份里存的那种形状 */
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
 * 假 Notion。**回读是从真写进去的块里还原的**,所以保真校验比的确实是这次写出去的那份。
 * 而且它按 append 的形状读子块(`[type].children`),不是备份的形状(顶层 `children`)——
 * 两种形状要是没转对,这里就会读出一个拍平的列表。
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
// 存档编号:这串东西是从浏览器来的
// ---------------------------------------------------------------------------

describe('存档编号', () => {
  const config = { guidesDir: join(tmpdir(), 'nowhere') };

  test('认得三个归档目录里的普通文件名', () => {
    for (const dir of ARCHIVE_DIRS) {
      const r = parseArchiveId(config, `${dir}/1-20260820-122121.md`);
      assert.equal(r.dir, dir);
      assert.equal(r.file, '1-20260820-122121.md');
    }
  });

  // 放过任意一条,设置页上就有一个任意文件读写按钮
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
    test(`挡住 ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseArchiveId(config, bad), /存档编号/);
    });
  }

  test('挡住藏了 NUL 的文件名', () => {
    assert.throws(() => parseArchiveId(config, '.backups/x\0.md'), /存档编号/);
  });

  // Windows 上这些名字有特殊含义,而它们都不带分隔符 —— 只靠"不许有 / 和 \"是放过去的
  for (const bad of ['.backups/C:', '.backups/nul', '.backups/COM1', '.backups/....', '.backups/x.txt']) {
    test(`挡住 ${JSON.stringify(bad)} —— 列不出来的就不该点得动`, () => {
      assert.throws(() => parseArchiveId(config, bad), /存档编号/);
    });
  }

  test('放行中文文件名 —— 手工命名的攻略搬走之后也得恢复得回来', () => {
    const r = parseArchiveId(config, '.migrated/中文攻略_achievements.md');
    assert.equal(r.file, '中文攻略_achievements.md');
  });
});

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

describe('列出存档', () => {
  // 目录之间是混排的,不是分段。要找的多半是刚被覆盖掉的那一份,而它在哪个
  // 目录里取决于当时的后端 —— 按目录分段等于让人先答对一道题才能开始找
  test('三个目录混在一起按时间倒序,不分段', () => {
    const { db, config } = freshEnv({
      archives: {
        '.backups': { '1-20250810-100000.md': GUIDE, '1-20260820-100000.json': backupJson() },
        '.migrated': { 'old_guide.md': GUIDE }, // 刚写出来,mtime 就是现在,所以它最新
      },
    });
    assert.deepEqual(
      listArchives(db, config).map((e) => e.file),
      ['old_guide.md', '1-20260820-100000.json', '1-20250810-100000.md']
    );
  });

  test('.backups 的 appid 和时间取自文件名,不是 mtime', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20250102-030405.md': GUIDE } },
    });
    const [e] = listArchives(db, config);
    assert.equal(e.appid, '1');
    assert.equal(e.game, '测试游戏', 'appid 要能查回游戏名');
    // 文件刚写出来,mtime 是现在;取到 2025 才说明读的是文件名
    assert.equal(new Date(e.savedAt).getFullYear(), 2025);
    assert.equal(new Date(e.savedAt).getMonth(), 0);
    assert.equal(new Date(e.savedAt).getDate(), 2);
  });

  test('.md 是本地攻略,.json 是 Notion 整页', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.md': GUIDE, '1-20260820-100001.json': backupJson() } },
    });
    const byFile = Object.fromEntries(listArchives(db, config).map((e) => [e.file, e.kind]));
    assert.equal(byFile['1-20260820-100000.md'], 'local');
    assert.equal(byFile['1-20260820-100001.json'], 'notion');
  });

  test('.migrated / .drafts 的 appid 从正文里读', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'whatever_name.md': GUIDE } },
    });
    const [e] = listArchives(db, config);
    assert.equal(e.appid, '1', '文件名里没有 appid,只能从 `appid:` 行拿');
    assert.equal(e.game, '测试游戏');
  });

  test('列表里不带正文 —— 一份备份是十几万字节', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.json': backupJson() } },
    });
    const [e] = listArchives(db, config);
    assert.equal(e.text, undefined);
    assert.ok(e.bytes > 0, '但大小要有 —— 列表上就靠它判断值不值得点开');
  });

  test('不是 .md / .json 的东西不列,子目录也不列', () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.md': GUIDE, 'notes.txt': 'x', '.DS_Store': 'x' } },
    });
    mkdirSync(join(config.guidesDir, '.backups', 'nested'));
    assert.deepEqual(listArchives(db, config).map((e) => e.file), ['1-20260820-100000.md']);
  });

  test('目录不存在不是错误,当成空的', () => {
    const { db, config } = freshEnv();
    assert.deepEqual(listArchives(db, config), []);
  });

  // 按游戏过滤是**主用法** —— 入口在 Dashboard 每一行的 ⋯ 菜单里,问的永远是
  // 「这一个游戏的上一版哪去了」。不带 appid 的全量列表只剩总占地和孤儿两件事
  describe('按 appid 过滤', () => {
    const env = () =>
      freshEnv({
        archives: {
          '.backups': { '1-20260820-100000.md': GUIDE, '2-20260820-100001.md': GUIDE },
          '.migrated': { 'other.md': GUIDE.replace('appid: 1', 'appid: 2') },
        },
      });

    test('只给这个游戏的', () => {
      const { db, config } = env();
      assert.deepEqual(listArchives(db, config, { appid: '1' }).map((e) => e.file),
        ['1-20260820-100000.md']);
      assert.equal(listArchives(db, config, { appid: '2' }).length, 2);
    });

    test('数字和字符串的 appid 是同一个游戏', () => {
      const { db, config } = env();
      assert.equal(listArchives(db, config, { appid: 1 }).length, 1, 'rpc 传下来的可能是数字');
    });

    test('没有存档的游戏给空数组,不是全部', () => {
      const { db, config } = env();
      assert.deepEqual(listArchives(db, config, { appid: '999' }), [],
        '过滤失灵会让菜单上每个游戏都显示同一批存档');
    });

    test('不传 appid 还是全量', () => {
      const { db, config } = env();
      assert.equal(listArchives(db, config).length, 3);
      assert.equal(listArchives(db, config, {}).length, 3);
    });
  });

  // 孤儿是设置页那个全量列表**唯一**还必须存在的理由:游戏被删了,
  // Dashboard 上没有它那一行,⋯ 菜单永远够不着这几份
  describe('孤儿存档', () => {
    test('游戏在库里就不是孤儿', () => {
      const { db, config } = freshEnv({
        archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
      });
      assert.equal(listArchives(db, config)[0].orphan, false);
    });

    test('游戏不在库里就是孤儿', () => {
      const { db, config } = freshEnv({
        archives: { '.backups': { '777-20260820-100000.md': GUIDE } },
      });
      const [e] = listArchives(db, config);
      assert.equal(e.orphan, true);
      assert.equal(e.game, 'AppID 777', '查不到名字就报 appid,不要留空');
    });

    test('连 appid 行都没有的文件也算孤儿 —— 它答不出属于哪个游戏', () => {
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
// 预览
// ---------------------------------------------------------------------------

describe('看一份存档', () => {
  test('本地存档给的是原文', () => {
    const { config } = freshEnv({ archives: { '.migrated': { 'g.md': GUIDE } } });
    const r = readArchive(config, '.migrated/g.md');
    assert.equal(r.text, GUIDE, '一个字都不能改 —— 恢复写回去的就是这份');
  });

  test('Notion 存档渲染成纯文本,并报块数和条目数', () => {
    const { config } = freshEnv({ archives: { '.backups': { '1-20260820-100000.json': backupJson() } } });
    const r = readArchive(config, '.backups/1-20260820-100000.json');
    assert.equal(r.kind, 'notion');
    assert.equal(r.blocks, 3, '顶层三块');
    assert.equal(r.todos, 3, '两个成就 + 一个子步骤');
    assert.match(r.text, /第一步/);
    assert.match(r.text, /子步骤甲/, '嵌套的子块也要抠出来');
  });
});

// ---------------------------------------------------------------------------
// 恢复:本地
// ---------------------------------------------------------------------------

describe('恢复本地存档', () => {
  test('.migrated 的文件按原文件名放回 guides/,并登记成 local', async () => {
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
    assert.equal(r.unregisteredNotion, 'https://notion.so/abc', 'Notion 那一页被顶下去了,必须说出来');
  });

  test('恢复不消耗存档 —— 那一份还在原地', async () => {
    const { db, config, dir } = freshEnv({
      archives: { '.migrated': { 'old_guide.md': GUIDE } },
      url: null,
    });
    await restoreArchive(db, { config, id: '.migrated/old_guide.md' });
    assert.ok(existsSync(join(dir, '.migrated', 'old_guide.md')), '恢复是拷回去,不是搬回去');
  });

  test('覆盖已有攻略之前先备份,备份进 .backups/', async () => {
    const { db, config, dir } = freshEnv({
      guides: { 'test_guide.md': '# 现在这份\nappid: 1\n\n- [ ] 手写的东西\n' },
      archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' });

    assert.ok(r.backedUpTo, '没有备份的覆盖就是不可逆的删除');
    assert.match(readFileSync(r.backedUpTo, 'utf8'), /手写的东西/, '备份里必须是被顶掉的那一份');
    assert.equal(readFileSync(join(dir, 'test_guide.md'), 'utf8'), GUIDE);
  });

  test('目标文件不存在就没有备份可做,也不该报错', async () => {
    const { db, config } = freshEnv({
      archives: { '.migrated': { 'brand_new.md': GUIDE } },
      url: null,
    });
    const r = await restoreArchive(db, { config, id: '.migrated/brand_new.md' });
    assert.equal(r.backedUpTo, null);
    assert.equal(r.ok, true);
  });

  test('.backups 的文件回到这个游戏现在登记的那个文件名', async () => {
    const { db, config, dir } = freshEnv({
      url: 'my_own_name.md',
      guides: { 'my_own_name.md': '# 旧的\nappid: 1\n' },
      archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' });
    assert.equal(r.file, 'my_own_name.md', '文件名是 `<appid>-<时间>.md`,那不是攻略名');
    assert.ok(existsSync(join(dir, 'my_own_name.md')));
  });

  test('这个游戏还没有本地攻略时,现起一个文件名', async () => {
    const { db, config } = freshEnv({
      kind: 'notion',
      url: 'https://notion.so/abc',
      archives: { '.backups': { '1-20260820-100000.md': GUIDE } },
    });
    const r = await restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' });
    assert.match(r.file, /_achievements\.md$/);
    assert.ok(!r.file.startsWith('1-'), '不能拿备份的文件名当攻略名');
  });

  test('没有 appid 行的存档拒绝恢复,并说清楚为什么', async () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'headless.md': '# 没头的\n\n- [ ] 一条\n' } },
      url: null,
    });
    await assert.rejects(
      () => restoreArchive(db, { config, id: '.drafts/headless.md' }),
      /appid/,
      '恢复过去也不会被登记,等于放了个看不见的文件'
    );
  });

  test('存档不在了要明说,不是静悄悄成功', async () => {
    const { db, config } = freshEnv();
    mkdirSync(join(config.guidesDir, '.backups'), { recursive: true });
    await assert.rejects(
      () => restoreArchive(db, { config, id: '.backups/1-20260820-100000.md' }),
      /不在了/
    );
  });
});

// ---------------------------------------------------------------------------
// 恢复:Notion
// ---------------------------------------------------------------------------

describe('恢复 Notion 存档', () => {
  const id = '.backups/1-20260820-100000.json';
  const env = () =>
    freshEnv({
      kind: 'notion',
      url: 'https://notion.so/1234567890abcdef1234567890abcdef',
      archives: { '.backups': { '1-20260820-100000.json': backupJson() } },
    });

  test('先备份现在那一页,再删,再写', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    const r = await restoreArchive(db, { config, notion, id });

    assert.ok(r.backedUpTo, '恢复也是覆盖');
    assert.ok(existsSync(r.backedUpTo));
    assert.deepEqual(
      notion.deleted,
      NOTION_BLOCKS.map((b) => b.id),
      '删的必须正好是刚备份下来的那一批'
    );
    assert.equal(notion.appended.length, 3);
  });

  test('删掉的那批和备份下来的那批是同一次读回来的', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    await restoreArchive(db, { config, notion, id });
    assert.equal(notion.fetched, 1, '读两次页面 = 给"备份的和删掉的不是同一批"留了条缝');
  });

  test('子块写回去时嵌进 [type].children,不是拍平一层', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    await restoreArchive(db, { config, notion, id });

    const second = notion.appended.find((b) => b.to_do?.rich_text?.[0]?.plain_text === '第二步');
    assert.equal(second.to_do.children.length, 1, '拍平的话子步骤会全部升级成成就');
    assert.equal(second.children, undefined, '顶层 children 是读回来的形状,写回去不认');
  });

  test('只读字段不能跟着写回去', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    await restoreArchive(db, { config, notion, id });
    for (const b of notion.appended) {
      for (const f of ['id', 'created_time', 'last_edited_time', 'has_children', 'parent', 'archived']) {
        assert.equal(b[f], undefined, `${f} 带过去就是一个 400`);
      }
    }
  });

  test('回读对不上就抛,并且说出备份在哪', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    // 写进去了,但少了一条 —— 页面看着满满当当,只是短了一截
    notion.appendBlocks = async function (_id, blocks) {
      this.appended.push(...blocks.slice(0, 1));
      return 1;
    };
    await assert.rejects(
      () => restoreArchive(db, { config, notion, id }),
      (err) => /对不上/.test(err.message) && /\.backups/.test(err.message)
    );
  });

  test('没配 Notion 时拒绝动手,而且是在删任何东西之前', async () => {
    const { db, config } = env();
    const notion = fakeNotion();
    notion.configured = false;
    await assert.rejects(() => restoreArchive(db, { config, notion, id }), /Notion/);
    assert.deepEqual(notion.deleted, []);
    assert.equal(notion.fetched, 0);
  });

  test('备份里没记页面地址就不猜', async () => {
    const { db, config } = freshEnv({
      archives: { '.backups': { '1-20260820-100000.json': backupJson(NOTION_BLOCKS, { url: '' }) } },
    });
    const notion = fakeNotion();
    await assert.rejects(() => restoreArchive(db, { config, notion, id }), /页面地址/);
    assert.deepEqual(notion.deleted, []);
  });

  test('一个能写回去的块都没有时,那一页不动', async () => {
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
    assert.deepEqual(notion.deleted, [], '删了就再也回不来了');
  });
});

// ---------------------------------------------------------------------------
// 块形状转换
// ---------------------------------------------------------------------------

describe('blocksForAppend', () => {
  test('只留 type 和它的载荷,其余一概不带', () => {
    const { blocks } = blocksForAppend([raw('paragraph', '一段')]);
    assert.deepEqual(Object.keys(blocks[0]).sort(), ['object', 'paragraph', 'type']);
  });

  test('建不出来的块丢掉并记一笔,不是整篇失败', () => {
    const { blocks, dropped } = blocksForAppend([
      raw('paragraph', '留着'),
      { object: 'block', id: 'a', type: 'child_database', child_database: {} },
      { object: 'block', id: 'b', type: 'unsupported', unsupported: {} },
      { object: 'block', id: 'c', type: 'child_database', child_database: {} },
    ]);
    assert.equal(blocks.length, 1, '一个 child_database 不该让整篇攻略写不回去');
    assert.deepEqual(dropped, { child_database: 2, unsupported: 1 });
  });

  test('子块一层层往下转', () => {
    const { blocks } = blocksForAppend([
      raw('to_do', '一', { checked: false }, [raw('to_do', '二', { checked: false }, [raw('to_do', '三', { checked: false })])]),
    ]);
    assert.equal(blocks[0].to_do.children[0].to_do.children[0].to_do.rich_text[0].plain_text, '三');
  });

  test('表格的 table_width 这类建表必需的字段要留住', () => {
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
  test('深度优先,顺序和 fetchAllToDoBlocks 一致', () => {
    assert.deepEqual(
      todosFromBlocks(NOTION_BLOCKS).map((t) => t.text),
      ['第一步', '第二步', '子步骤甲'],
      '顺序错了,回读比对就全是噪音'
    );
  });

  test('勾选状态跟着走', () => {
    assert.deepEqual(todosFromBlocks(NOTION_BLOCKS).map((t) => t.checked), [true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

describe('删存档', () => {
  test('删掉,并报删了多大', () => {
    const { db, config, dir } = freshEnv({ archives: { '.drafts': { 'g.md': GUIDE } } });
    const r = deleteArchive(config, '.drafts/g.md');
    assert.equal(r.ok, true);
    assert.equal(r.bytes, Buffer.byteLength(GUIDE));
    assert.equal(existsSync(join(dir, '.drafts', 'g.md')), false);
    assert.deepEqual(listArchives(db, config), []);
  });

  test('已经不在了不算失败', () => {
    const { config } = freshEnv({ archives: { '.drafts': {} } });
    const r = deleteArchive(config, '.drafts/gone.md');
    assert.equal(r.ok, true);
    assert.equal(r.alreadyGone, true);
  });

  test('只删得到那三个目录里的东西', () => {
    const { config, dir } = freshEnv({ guides: { 'live_guide.md': GUIDE } });
    assert.throws(() => deleteArchive(config, '.backups/../live_guide.md'), /存档编号/);
    assert.ok(existsSync(join(dir, 'live_guide.md')), '这是用户现在正用着的攻略');
  });

  test('删一份不动别的', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE } },
    });
    deleteArchive(config, '.drafts/a.md');
    assert.deepEqual(listArchives(db, config).map((e) => e.file), ['b.md']);
  });
});

// ---------------------------------------------------------------------------
// 一键删 —— 设置页列表尾巴那个「全部删除」
// ---------------------------------------------------------------------------

describe('批量删存档', () => {
  test('一次删掉一批,份数和体积都报出来', () => {
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
   * 这条盯的是 **try 写在循环里面还是外面**。写外面的话,一个野编号
   * 会把它后面没轮到的全部顶掉 —— 而屏幕上只会看到一句报错,剩下的文件
   * 看起来就像"没选中",下一下还会再撞一次同一个坏编号。
   */
  test('一个坏编号不拖累后面的', () => {
    const { db, config, dir } = freshEnv({
      guides: { 'live_guide.md': GUIDE },
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE } },
    });
    const r = deleteArchives(config, ['.backups/../live_guide.md', '.drafts/a.md', '.drafts/b.md']);
    assert.equal(r.deleted, 2, '坏编号后面的两份要真删掉');
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].error, /存档编号/);
    assert.equal(r.failed[0].id, '.backups/../live_guide.md');
    assert.ok(existsSync(join(dir, 'live_guide.md')), '越界那一条仍然得拦住');
    assert.deepEqual(listArchives(db, config), []);
  });

  /**
   * **它删的是点名的那几份,不是"把目录清了"。** 区别在页面画完之后、
   * 按钮点下去之前——后台刚跑完一次重写,`.backups/` 里就多一份没上过屏的。
   * 清目录会把那份也吃掉
   */
  test('只删点名的,没点到的还在', () => {
    const { db, config } = freshEnv({
      archives: { '.drafts': { 'a.md': GUIDE, 'b.md': GUIDE } },
    });
    const r = deleteArchives(config, ['.drafts/a.md']);
    assert.equal(r.deleted, 1);
    assert.deepEqual(listArchives(db, config).map((e) => e.file), ['b.md']);
  });

  test('没给编号就什么都不删', () => {
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
// 绝对路径 → 存档编号
// ---------------------------------------------------------------------------

describe('archiveIdOf', () => {
  // 「生成成功」那一屏上的「删除备份」要拿这个编号去调 deleteGuideArchive。
  // 存在的理由是**别在 server.js 里用字符串拼编号** —— 格式由 parseArchiveId
  // 定义,两处各写一份的话,对不上的症状是按钮点了没反应,而不是一条报错
  test('三个目录里的直接子文件都认得,而且能和解析器对上', () => {
    const { config } = freshEnv();
    for (const dir of ARCHIVE_DIRS) {
      const id = `${dir}/1-20260820-100000.md`;
      const { path } = parseArchiveId(config, id);
      assert.equal(archiveIdOf(config, path), id, '往返必须闭环');
    }
  });

  test('归档目录之外的一律 null', () => {
    const { config, dir } = freshEnv();
    assert.equal(archiveIdOf(config, join(dir, 'live_guide.md')), null, '正在用的攻略不是存档');
    assert.equal(archiveIdOf(config, join(dir, '..', 'somewhere.md')), null);
    assert.equal(archiveIdOf(config, 'C:/Windows/win.ini'), null);
  });

  test('再深一层的不认 —— 列表也只列直接子文件', () => {
    const { config, dir } = freshEnv();
    assert.equal(archiveIdOf(config, join(dir, '.backups', 'nested', 'x.md')), null);
  });

  test('后缀不对的不认 —— 和列表的过滤条件是同一条', () => {
    const { config, dir } = freshEnv();
    assert.equal(archiveIdOf(config, join(dir, '.backups', 'notes.txt')), null);
  });

  test('空值不炸', () => {
    const { config } = freshEnv();
    assert.equal(archiveIdOf(config, null), null);
    assert.equal(archiveIdOf(config, ''), null);
    assert.equal(archiveIdOf(config, undefined), null);
  });
});
