/**
 * Adding the achievements a guide has no entry for — the whole run
 * ------------------------------------------------
 * Run with: node --test
 *
 * `guideadd.test.js` and `guideplace.test.js` hold the pieces. This file runs the **path**: select,
 * write, file, back up, land, read back — through the real `patchGuide`, against a guide on disk and
 * against a Notion page.
 *
 * The Notion page is the real `NotionClient` with only its HTTP layer replaced by an in-memory block
 * tree. That is the point: `fetchAllToDoBlocks`, `fetchAllBlocks`, `appendBlocks` (its batching, its
 * two-level nesting limit and the deferred children it fills in afterwards) and the in-place edits
 * all run as shipped, and a test that hands `landPatchNotion` a fake with the three methods it
 * happens to call would say nothing about whether any of them exists in the form the landing needs.
 *
 * Two shapes of silence are guarded here, both from this feature's own history of near-misses:
 *
 *  - **An insertion that lands in the wrong place raises nothing.** Every call succeeds, the page
 *    holds every entry, and one of them sits under the wrong heading. The landing reads the page
 *    back and checks *where* each entry is, and the case that proves it can fail is the fake that
 *    ignores `after`.
 *  - **A pass that fails must not stop a run that has already paid.** The entries are written and
 *    ticked by the time they are filed, so a filing that fails lands them at the end of the guide
 *    and says why; only a cancellation stops the run, and when it does nothing has been written.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, insertGame, replaceAchievements, upsertGuide } from '../lib/db.js';
import { syncGuidesFromMarkdown } from '../lib/guides.js';
import { NotionClient, extractNotionPageId } from '../lib/notion.js';
import { toRichText } from '../lib/notionblocks.js';
import { patchGuide } from '../lib/guidepatch.js';
import { placementSystemFor, FALLBACK_HEADING } from '../lib/guideplace.js';
import { BACKUPS_DIR } from '../lib/guidebackup.js';
import { msg } from '../lib/messages.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const row = (apiName, nameCn, description, nameEn = '', descriptionEn = '') => ({
  apiName, gameName: '测试游戏', nameCn, nameEn, description, descriptionEn, hidden: 0, icon: '',
});

const ROWS = [
  row('A', '第一步', '完成第一关。', 'First Step', 'Finish the first level.'),
  row('B', '第二步', '完成第二关。', 'Second Step', 'Finish the second level.'),
  row('C', '第三步', '完成第三关。', 'Third Step', 'Finish the third level.'),
  row('D', '收集狂', '集齐全部收集品。', 'Collector', 'Collect everything.'),
  row('E', '第四步', '完成第四关。', 'Fourth Step', 'Finish the fourth level.'),
  row('F', '收集控', '集齐隐藏收集品。', 'Hidden Collector', 'Collect the hidden items.'),
];

const GUIDE_MD = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿。',
  '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
  '  - [x] 打完第一个 Boss',
  '  - [ ] 拿到钥匙',
  '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
  '',
  '## 收集',
  '',
  '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
  '',
].join('\n');

/** What the model returns for the two new entries, in the order of the achievement list */
const WRITE_EF = [
  '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
  '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
  '  - [ ] 东边的洞穴',
].join('\n');

const fence = (md) => '```markdown\n' + md + '\n```';

function replyOf(text, extra = {}) {
  return {
    content: [{ type: 'text', text }], text, stopReason: 'end_turn', stopDetails: null,
    usage: { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, webSearches: 1, requests: 1 },
    model: 'test-model', continuations: 0, toolErrors: [], searchQueries: [], ...extra,
  };
}

/** A provider that tells the placement pass from the writing by its system prompt, as the real classification pass is told */
function provider({ writes = [], place = ['1 -> 1\n2 -> 2'] } = {}) {
  const p = {
    model: 'test-model',
    canSearch: true,
    webTools: () => [],
    writeAsks: [],
    placeAsks: [],
    async send({ system, messages, effort, onEvent }) {
      if (system === placementSystemFor('zh') || system === placementSystemFor('en')) {
        p.placeAsks.push({ prompt: messages.at(-1).content, count: messages.length, effort });
        const a = place[p.placeAsks.length - 1];
        if (a instanceof Error) throw a;
        return replyOf(a ?? '');
      }
      p.writeAsks.push(messages.at(-1).content);
      const a = writes[p.writeAsks.length - 1];
      if (a === undefined) throw new Error('the scripted provider ran out of writes');
      const text = fence(a);
      if (onEvent) onEvent({ type: 'text', text });
      return replyOf(text);
    },
  };
  return p;
}

const fakeSteam = (unlocked = ['A']) => ({
  async fetchPlayerAchievements() {
    return { achievements: ROWS.map((r) => ({ apiname: r.apiName, achieved: unlocked.includes(r.apiName) ? 1 : 0 })) };
  },
  async fetchGlobalAchievementPercentages() {
    return null;
  },
});

function localEnv({ md = GUIDE_MD, uiLanguage = 'zh' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guideadd-'));
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  replaceAchievements(db, '1', ROWS);
  const config = { guidesDir: dir, uiLanguage, ai: { maxAchievements: 100 } };
  const file = join(dir, 'game.md');
  writeFileSync(file, md);
  syncGuidesFromMarkdown(db, config);
  return { db, config, dir, file };
}

const run = (env, prov, over = {}) => patchGuide(env.db, {
  config: env.config, provider: prov, steam: fakeSteam(over.unlocked), appid: '1', notion: null,
  selector: 'missing', ...over,
});

const backups = (dir) => (existsSync(join(dir, BACKUPS_DIR)) ? readdirSync(join(dir, BACKUPS_DIR)) : []);

// ---------------------------------------------------------------------------

describe('a local guide — the whole run', () => {
  test('missing achievements are written, filed under their sections and ticked from the database', async () => {
    const env = localEnv();
    const prov = provider({ writes: [WRITE_EF] });
    const r = await run(env, prov, { unlocked: ['A', 'E'] });

    assert.equal(r.ok, true);
    assert.deepEqual(r.added, ['E', 'F']);
    assert.deepEqual(r.rewrote, []);
    assert.deepEqual(r.placement.fallback, []);
    assert.equal(readFileSync(env.file, 'utf8'), [
      '# 测试游戏',
      'appid: 1',
      '',
      '## 主线',
      '',
      '- [x] **第一步**<br>完成第一关。<br>开局就能拿。',
      '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
      '  - [x] 打完第一个 Boss',
      '  - [ ] 拿到钥匙',
      '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
      '- [x] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '',
      '## 收集',
      '',
      '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  - [ ] 东边的洞穴',
      '',
    ].join('\n'), 'E is unlocked and so ticked; every other line is where it was');
  });

  test('a tick the model drew on a new entry for a locked achievement never reaches the file', async () => {
    // `applyChecks` only adds ticks, so a [x] that got through would stay for good and only be noticed
    // after the guide had been written over
    const env = localEnv();
    const ticked = WRITE_EF.replace('- [ ] **第四步**', '- [x] **第四步**').replace('  - [ ] 东边的洞穴', '  - [x] 东边的洞穴');
    assert.notEqual(ticked, WRITE_EF, 'precondition: the reply really carries ticks');
    const r = await run(env, provider({ writes: [ticked] }), { unlocked: ['A'] });

    assert.equal(r.ok, true);
    const text = readFileSync(env.file, 'utf8');
    assert.match(text, /^- \[ \] \*\*第四步\*\*/m);
    assert.match(text, /^  - \[ \] 东边的洞穴$/m);
    assert.equal((text.match(/\[x\]/g) ?? []).length, 2, 'only A and its sub-step, which were ticked in the original');
  });

  test('the writing request says which entries are new, and the filing request runs at the aside depth in a session of its own', async () => {
    const env = localEnv();
    const prov = provider({ writes: [WRITE_EF] });
    await run(env, prov);
    assert.equal(prov.writeAsks.length, 1, 'one request covers every entry, new ones included');
    assert.match(prov.writeAsks[0], /第四步/);
    assert.match(prov.writeAsks[0], /攻略里还没有/, 'a new entry must not be shown to the model as one to rewrite');
    assert.equal(prov.placeAsks.length, 1);
    assert.equal(prov.placeAsks[0].effort, 'low');
    assert.equal(prov.placeAsks[0].count, 1);
    assert.match(prov.placeAsks[0].prompt, /收集控/, 'the filing request names the new entries');
  });

  test('the original is backed up before anything is written', async () => {
    const env = localEnv();
    await run(env, provider({ writes: [WRITE_EF] }));
    const [name] = backups(env.dir);
    assert.ok(name?.endsWith('.md'));
    assert.equal(readFileSync(join(env.dir, BACKUPS_DIR, name), 'utf8'), GUIDE_MD);
  });

  test('a guide path that climbs out and back in is refused up front, because its draft would be written outside', async () => {
    // `guides.url` is data. This one names the guide itself by a way that goes up two folders and
    // down again, so the final path is inside guides/ and passes; the draft, which is written and then
    // deleted under `.drafts/`, would sit in a folder that is not
    const env = localEnv();
    const url = join('..', '..', relative(dirname(dirname(env.dir)), env.file));
    upsertGuide(env.db, { appid: '1', name: '测试游戏', url, kind: 'local' });
    const prov = provider({ writes: [WRITE_EF] });

    await assert.rejects(() => run(env, prov), (err) => err.message.includes(url) && !/ENOENT/.test(err.message));
    assert.equal(prov.writeAsks.length, 0, 'refused at planning, before a request was paid for');
    assert.equal(readFileSync(env.file, 'utf8'), GUIDE_MD, 'the guide is as it was');
    assert.deepEqual(backups(env.dir), [], 'nothing was backed up, because nothing was going to be written');
  });

  test('a filing that fails lands the entries at the end of the guide and says why', async () => {
    const env = localEnv();
    const events = [];
    const prov = provider({ writes: [WRITE_EF], place: ['乱七八糟', '还是乱七八糟'] });
    const r = await run(env, prov, { onProgress: (e) => events.push(e) });

    assert.equal(r.ok, true, 'the entries are written and through the gates; a section they were not filed under costs nothing else');
    assert.deepEqual(r.placement.fallback, ['E', 'F']);
    assert.ok(r.placement.reason);
    assert.equal(r.placement.heading, FALLBACK_HEADING[0]);
    const out = readFileSync(env.file, 'utf8');
    assert.ok(out.endsWith([
      '',
      `## ${FALLBACK_HEADING[0]}`,
      '',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  - [ ] 东边的洞穴',
      '',
    ].join('\n')), out);
    assert.ok(events.some((e) => e.phase === 'place-failed' && e.reason));
  });

  test('an entry answered "none fits" goes to the end while the rest are filed', async () => {
    const env = localEnv();
    const r = await run(env, provider({ writes: [WRITE_EF], place: ['1 -> 1\n2 -> 0'] }));
    assert.deepEqual(r.placement.fallback, ['F']);
    assert.equal(r.placement.reason, null, 'nothing failed');
    const out = readFileSync(env.file, 'utf8');
    assert.ok(out.indexOf('第四步') < out.indexOf('## 收集'), 'E went into the first section');
    assert.ok(out.indexOf(FALLBACK_HEADING[0]) < out.indexOf('收集控'));
  });

  test('a cancellation while filing writes nothing and takes no backup', async () => {
    const env = localEnv();
    const cancelled = Object.assign(new Error('cancelled'), { cancelled: true });
    const prov = provider({ writes: [WRITE_EF], place: [cancelled] });
    await assert.rejects(() => run(env, prov), (e) => e.cancelled === true);
    assert.equal(readFileSync(env.file, 'utf8'), GUIDE_MD);
    assert.deepEqual(backups(env.dir), []);
    assert.equal(prov.placeAsks.length, 1, 'the Cancel click must not be retried');
  });

  test('a rewrite and an addition in one run: both land, and the rest is untouched', async () => {
    const env = localEnv();
    const writes = [[
      '- [ ] **第二步**<br>完成第二关。<br>换了个说法,写详细多了。',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
    ].join('\n')];
    const prov = provider({ writes, place: ['1 -> 1'] });
    const r = await run(env, prov, { selector: '第二步,第四步' });

    assert.equal(r.ok, true);
    assert.deepEqual(r.rewrote, ['B']);
    assert.deepEqual(r.added, ['E']);
    assert.equal(readFileSync(env.file, 'utf8'), [
      '# 测试游戏',
      'appid: 1',
      '',
      '## 主线',
      '',
      '- [x] **第一步**<br>完成第一关。<br>开局就能拿。',
      '- [ ] **第二步**<br>完成第二关。<br>换了个说法,写详细多了。',
      '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡,先过前三关。',
      '',
      '## 收集',
      '',
      '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
      '',
    ].join('\n'));
    assert.match(prov.writeAsks[0], /现在写的/, 'the entry being rewritten is shown as it stands');
  });

  test('locked reaches the missing entries as well as the existing ones', async () => {
    const env = localEnv();
    const writes = [[
      '- [ ] **第二步**<br>完成第二关。<br>重写。',
      '- [ ] **第三步**<br>完成第三关。<br>重写。',
      '- [ ] **收集狂**<br>集齐全部收集品。<br>重写。',
      '- [ ] **第四步**<br>完成第四关。<br>新写。',
      '- [ ] **收集控**<br>集齐隐藏收集品。<br>新写。',
    ].join('\n')];
    const r = await run(env, provider({ writes, place: ['1 -> 1\n2 -> 2'] }), { selector: 'locked' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rewrote, ['B', 'C', 'D']);
    assert.deepEqual(r.added, ['E', 'F']);
  });

  test('an entry the model leaves out is asked for again, and if it never comes nothing is written or filed', async () => {
    const env = localEnv();
    const onlyE = '- [ ] **第四步**<br>完成第四关。<br>新关卡。';
    const prov = provider({ writes: [onlyE, onlyE] });
    const r = await run(env, prov);

    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['F']);
    assert.match(prov.writeAsks[1], /收集控/, 'the second round names the entry that did not come back');
    assert.equal(prov.placeAsks.length, 0, 'filing is not paid for until there is something to file');
    assert.equal(readFileSync(env.file, 'utf8'), GUIDE_MD);
    assert.deepEqual(backups(env.dir), []);
  });

  test('nothing missing means nothing selected, and nothing is asked', async () => {
    const full = GUIDE_MD.replace(/\n$/, '') + '\n- [ ] **第四步**<br>完成第四关。\n- [ ] **收集控**<br>集齐隐藏收集品。\n';
    const env = localEnv({ md: full });
    const prov = provider();
    await assert.rejects(() => run(env, prov), (e) => e.code === 'nothing-missing');
    assert.equal(prov.writeAsks.length, 0);
  });

  test('an achievement that cannot be recognised once written is reported, and never asked for', async () => {
    // Two achievements, one name, and no description on Steam to tell them apart
    const env = localEnv();
    replaceAchievements(env.db, '1', [
      ...ROWS,
      row('X1', '妙手空空', ''),
      row('X2', '妙手空空', ''),
    ]);
    const prov = provider({ writes: [WRITE_EF] });
    const r = await run(env, prov);
    assert.equal(r.ok, true);
    assert.deepEqual(r.added, ['E', 'F']);
    assert.deepEqual(r.unaddable.sort(), ['X1', 'X2']);
    assert.doesNotMatch(prov.writeAsks[0], /妙手空空/);
  });

  test('an English guide takes its heading and its prompts in English', async () => {
    const env = localEnv({ uiLanguage: 'en' });
    const writes = [[
      '- [ ] **Fourth Step**<br>Finish the fourth level.<br>A new level.',
      '- [ ] **Hidden Collector**<br>Collect the hidden items.<br>On the map edge.',
    ].join('\n')];
    const prov = provider({ writes, place: ['nothing usable'] });
    const r = await run(env, prov);
    assert.equal(r.placement.heading, FALLBACK_HEADING[1]);
    assert.ok(readFileSync(env.file, 'utf8').includes(`## ${FALLBACK_HEADING[1]}`));
    // The section titles and the game's name are quoted from a guide whose headings are Chinese in
    // this fixture; what has to be English is what the program says
    assert.match(prov.placeAsks[0].prompt, /Pick one \*\*existing section\*\*/);
    assert.doesNotMatch(prov.placeAsks[0].prompt, /现有小节|新增的成就|请给每一条/, 'an English guide is asked in English');
  });

  test('the cost of the filing is counted in the run’s usage', async () => {
    const env = localEnv();
    const r = await run(env, provider({ writes: [WRITE_EF] }));
    assert.equal(r.usage.requests, 2, 'one to write and one to file');
  });

  test('a second run finds nothing missing — the guide now has every entry', async () => {
    const env = localEnv();
    await run(env, provider({ writes: [WRITE_EF] }));
    await assert.rejects(() => run(env, provider({ writes: [] })), (e) => e.code === 'nothing-missing');
  });
});

// ---------------------------------------------------------------------------
// Notion — the real client over an in-memory page
// ---------------------------------------------------------------------------

const PAGE_URL = 'https://www.notion.so/Test-3b91fee6252b811eaff4f382158bd7bc';
const PAGE_ID = extractNotionPageId(PAGE_URL);

/**
 * The Notion API as far as this feature touches it, over a tree held in memory.
 *
 * What it keeps is what the client **sends**; what it hands back adds `plain_text` to every rich
 * text, which is what the real API always does and what the client's readers rely on. A fake that
 * returned exactly what it was given would let a reader written for sent blocks pass over
 * received ones.
 */
class FakeNotion extends NotionClient {
  constructor({ ignoreAfter = false } = {}) {
    super({ notion: { token: 'test-token' } });
    this.ignoreAfter = ignoreAfter;
    this.nodes = new Map();
    this.kids = new Map([[PAGE_ID, []]]);
    this.serial = 0;
    this.calls = [];
  }

  /** Seed from fixtures shaped `{id?, type, text?, checked?, children?}` */
  seed(list, parentId = PAGE_ID) {
    for (const b of list) this.#create(b, parentId, null);
  }

  #create(b, parentId, index) {
    const id = b.id ?? `blk-${++this.serial}`;
    const type = b.type;
    const payload = { ...(b[type] ?? {}) };
    if (b.text !== undefined) payload.rich_text = toRichText(b.text);
    if (type === 'to_do') payload.checked = Boolean(b.checked ?? payload.checked);
    const inner = payload.children ?? b.children ?? [];
    delete payload.children;
    this.nodes.set(id, { id, type, parentId, [type]: payload });
    this.kids.set(id, []);
    const siblings = this.kids.get(parentId);
    if (index === null) siblings.push(id);
    else siblings.splice(index, 0, id);
    for (const c of inner) this.#create(c.object === 'block' ? c : { ...c }, id, null);
    return id;
  }

  #json(id) {
    const n = this.nodes.get(id);
    const payload = { ...n[n.type] };
    if (payload.rich_text) payload.rich_text = payload.rich_text.map((t) => ({ ...t, plain_text: t.plain_text ?? t.text?.content ?? '' }));
    return {
      object: 'block', id, type: n.type,
      parent: n.parentId === PAGE_ID ? { type: 'page_id', page_id: PAGE_ID } : { type: 'block_id', block_id: n.parentId },
      has_children: this.kids.get(id).length > 0,
      [n.type]: payload,
    };
  }

  #drop(id) {
    for (const k of this.kids.get(id) ?? []) this.#drop(k);
    const n = this.nodes.get(id);
    const sib = this.kids.get(n.parentId);
    sib.splice(sib.indexOf(id), 1);
    this.nodes.delete(id);
    this.kids.delete(id);
  }

  async request(method, path, payload) {
    this.calls.push({ method, path, payload });
    const m = path.match(/^\/blocks\/([^/?]+)(\/children)?/);
    if (!m) throw new Error(`the fake has no route for ${method} ${path}`);
    const id = m[1];
    if (m[2] && method === 'get') {
      return { results: (this.kids.get(id) ?? []).map((k) => this.#json(k)), has_more: false };
    }
    if (m[2] && method === 'patch') {
      const siblings = this.kids.get(id);
      let at = siblings.length;
      if (payload.after && !this.ignoreAfter) at = siblings.indexOf(payload.after) + 1;
      if (payload.position?.type === 'start') at = 0;
      const made = payload.children.map((c, i) => this.#create(c, id, at + i));
      // **What the live API answers**: the blocks this request created, first, and then every
      // sibling that follows them, up to a hundred results. Measured, not assumed — a fake that
      // returned only what was created would let the client read "the last result" as the last
      // block it placed, which is true of an append at the end and false of an insertion
      const following = siblings.slice(at + made.length);
      return { results: [...made, ...following].slice(0, 100).map((k) => this.#json(k)) };
    }
    if (!m[2] && method === 'patch') {
      const n = this.nodes.get(id);
      Object.assign(n[n.type], payload[n.type]);
      return this.#json(id);
    }
    if (!m[2] && method === 'delete') {
      this.#drop(id);
      return {};
    }
    throw new Error(`the fake has no route for ${method} ${path}`);
  }

  /** The page as readable lines, nesting shown by indent */
  dump(id = PAGE_ID, depth = 0) {
    const out = [];
    for (const k of this.kids.get(id)) {
      const n = this.nodes.get(k);
      const p = n[n.type];
      const text = (p.rich_text ?? []).map((t) => t.text?.content ?? t.plain_text ?? '').join('').replace(/\n/g, '<br>');
      const tag = n.type === 'to_do' ? (p.checked ? '[x]' : '[ ]') : n.type.replace('heading_', 'h');
      out.push(`${'  '.repeat(depth)}${tag} ${text}`);
      out.push(...this.dump(k, depth + 1));
    }
    return out;
  }
}

const SEED = [
  { id: 'h1', type: 'heading_2', text: '主线' },
  { id: 'a', type: 'to_do', text: '**第一步**<br>完成第一关。<br>开局就能拿。', checked: true },
  {
    id: 'b', type: 'to_do', text: '**第二步**<br>完成第二关。<br>接着打就行。',
    children: [
      { id: 'b1', type: 'to_do', text: '打完第一个 Boss', checked: true },
      { id: 'b2', type: 'to_do', text: '拿到钥匙' },
    ],
  },
  { id: 'c', type: 'to_do', text: '**第三步**<br>完成第三关。<br>最后一关,有点难。' },
  { id: 'note', type: 'paragraph', text: '通关后解锁隐藏关。' },
  { id: 'h2', type: 'heading_2', text: '收集' },
  { id: 'd', type: 'to_do', text: '**收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。' },
];

function notionEnv(fake) {
  const dir = mkdtempSync(join(tmpdir(), 'guideadd-notion-'));
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  replaceAchievements(db, '1', ROWS);
  upsertGuide(db, { appid: '1', name: '测试游戏', url: PAGE_URL, kind: 'notion' });
  const config = { guidesDir: dir, uiLanguage: 'zh', ai: { maxAchievements: 100 }, notion: { token: 'test-token' } };
  return { db, config, dir, notion: fake };
}

const runNotion = (env, prov, over = {}) => patchGuide(env.db, {
  config: env.config, provider: prov, steam: fakeSteam(over.unlocked), appid: '1', notion: env.notion,
  selector: 'missing', ...over,
});

/** The page of `SEED`, as `dump` reads it, before anything is added */
const SEED_DUMP = [
  'h2 主线',
  '[x] 第一步<br>完成第一关。<br>开局就能拿。',
  '[ ] 第二步<br>完成第二关。<br>接着打就行。',
  '  [x] 打完第一个 Boss',
  '  [ ] 拿到钥匙',
  '[ ] 第三步<br>完成第三关。<br>最后一关,有点难。',
  'paragraph 通关后解锁隐藏关。',
  'h2 收集',
  '[ ] 收集狂<br>集齐全部收集品。<br>见下面的 BV 号。',
];

const mutating = (fake) => fake.calls.filter((c) => c.method !== 'get');

describe('a Notion guide — the whole run, through the real client', () => {
  test('new entries land after everything their section holds, and nothing else on the page moves', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    assert.deepEqual(fake.dump(), SEED_DUMP, 'precondition: the fake reads back what it was seeded with');
    const env = notionEnv(fake);
    const r = await runNotion(env, provider({ writes: [WRITE_EF] }), { unlocked: ['A', 'E'] });

    assert.equal(r.ok, true);
    assert.deepEqual(r.added, ['E', 'F']);
    // E closes 主线, after the paragraph that closes it; F follows 收集狂. Every other line is where it was
    assert.deepEqual(fake.dump(), [
      'h2 主线',
      '[x] 第一步<br>完成第一关。<br>开局就能拿。',
      '[ ] 第二步<br>完成第二关。<br>接着打就行。',
      '  [x] 打完第一个 Boss',
      '  [ ] 拿到钥匙',
      '[ ] 第三步<br>完成第三关。<br>最后一关,有点难。',
      'paragraph 通关后解锁隐藏关。',
      '[x] 第四步<br>完成第四关。<br>新关卡,先过前三关。',
      'h2 收集',
      '[ ] 收集狂<br>集齐全部收集品。<br>见下面的 BV 号。',
      '[ ] 收集控<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  [ ] 东边的洞穴',
    ]);
  });

  test('the blocks that were there keep their ids, so links to them keep working', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const ids = [...fake.kids.get(PAGE_ID)];
    await runNotion(notionEnv(fake), provider({ writes: [WRITE_EF] }));
    const now = fake.kids.get(PAGE_ID);
    for (const id of ids) assert.ok(now.includes(id), `${id} is gone`);
    assert.deepEqual(now.filter((id) => ids.includes(id)), ids, 'and in the order they were in');
  });

  test('the insertion names the block it goes after, and the page it goes into', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    await runNotion(notionEnv(fake), provider({ writes: [WRITE_EF] }));
    const inserts = mutating(fake).filter((c) => c.payload?.after);
    assert.deepEqual(inserts.map((c) => [c.path, c.payload.after]), [
      [`/blocks/${PAGE_ID}/children`, 'note'],
      [`/blocks/${PAGE_ID}/children`, 'd'],
    ]);
  });

  test('the original page is backed up, as block JSON, before anything is written', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const env = notionEnv(fake);
    await runNotion(env, provider({ writes: [WRITE_EF] }));
    const [name] = backups(env.dir);
    assert.ok(name?.endsWith('.json'));
    const saved = JSON.parse(readFileSync(join(env.dir, BACKUPS_DIR, name), 'utf8'));
    assert.equal(saved.blocks.length, 7, 'the seven top-level blocks it had, not the page after the run');
  });

  test('entries inside a container are added inside it, after the entry that closes the section', async () => {
    const fake = new FakeNotion();
    fake.seed([
      { id: 'h1', type: 'heading_2', text: '主线' },
      { id: 'b', type: 'to_do', text: '**第二步**<br>完成第二关。<br>接着打就行。' },
      {
        id: 'tg', type: 'toggle', text: '全部',
        children: [
          { id: 'a', type: 'to_do', text: '**第一步**<br>完成第一关。<br>开局就能拿。', checked: true },
          { id: 'c', type: 'to_do', text: '**第三步**<br>完成第三关。<br>最后一关,有点难。' },
        ],
      },
      { id: 'h2', type: 'heading_2', text: '收集' },
      { id: 'd', type: 'to_do', text: '**收集狂**<br>集齐全部收集品。' },
    ]);
    await runNotion(notionEnv(fake), provider({ writes: [WRITE_EF], place: ['1 -> 1\n2 -> 2'] }));
    const inserts = mutating(fake).filter((c) => c.payload?.after);
    assert.deepEqual(inserts.map((c) => [c.path, c.payload.after]), [
      ['/blocks/tg/children', 'c'],
      [`/blocks/${PAGE_ID}/children`, 'd'],
    ]);
    assert.deepEqual(fake.dump(), [
      'h2 主线',
      '[ ] 第二步<br>完成第二关。<br>接着打就行。',
      'toggle 全部',
      '  [x] 第一步<br>完成第一关。<br>开局就能拿。',
      '  [ ] 第三步<br>完成第三关。<br>最后一关,有点难。',
      '  [ ] 第四步<br>完成第四关。<br>新关卡,先过前三关。',
      'h2 收集',
      '[ ] 收集狂<br>集齐全部收集品。',
      '[ ] 收集控<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  [ ] 东边的洞穴',
    ]);
  });

  test('one entry filed and one that fits nowhere: the first goes into its section, the second to the end', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const r = await runNotion(notionEnv(fake), provider({ writes: [WRITE_EF], place: ['1 -> 1\n2 -> 0'] }));
    assert.deepEqual(r.placement.fallback, ['F']);
    assert.deepEqual(r.placement.where.map((w) => [w.apiName, w.section]), [['E', '主线'], ['F', FALLBACK_HEADING[0]]]);
    assert.deepEqual(fake.dump(), [
      'h2 主线',
      '[x] 第一步<br>完成第一关。<br>开局就能拿。',
      '[ ] 第二步<br>完成第二关。<br>接着打就行。',
      '  [x] 打完第一个 Boss',
      '  [ ] 拿到钥匙',
      '[ ] 第三步<br>完成第三关。<br>最后一关,有点难。',
      'paragraph 通关后解锁隐藏关。',
      '[ ] 第四步<br>完成第四关。<br>新关卡,先过前三关。',
      'h2 收集',
      '[ ] 收集狂<br>集齐全部收集品。<br>见下面的 BV 号。',
      `h2 ${FALLBACK_HEADING[0]}`,
      '[ ] 收集控<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  [ ] 东边的洞穴',
    ]);
  });

  test('a filing that fails puts the entries in a new section at the end, and says so', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const r = await runNotion(notionEnv(fake), provider({ writes: [WRITE_EF], place: ['乱', '乱'] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.placement.fallback, ['E', 'F']);
    assert.ok(r.placement.reason);
    assert.deepEqual(fake.dump().slice(-4), [
      `h2 ${FALLBACK_HEADING[0]}`,
      '[ ] 第四步<br>完成第四关。<br>新关卡,先过前三关。',
      '[ ] 收集控<br>集齐隐藏收集品。<br>藏在地图边缘。',
      '  [ ] 东边的洞穴',
    ]);
  });

  test('a rewrite and an addition together: the page is added to first, and only then edited in place', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const writes = [[
      '- [ ] **第二步**<br>完成第二关。<br>换了个说法。',
      '- [ ] **第四步**<br>完成第四关。<br>新关卡。',
    ].join('\n')];
    const r = await runNotion(notionEnv(fake), provider({ writes, place: ['1 -> 1'] }), { selector: '第二步,第四步' });
    assert.equal(r.ok, true);
    const calls = mutating(fake);
    assert.ok(calls[0].payload?.after, 'the non-destructive write comes first, so a stale anchor fails before anything is edited');
    assert.ok(calls.slice(1).some((c) => c.method === 'patch' && c.path === '/blocks/b'), 'then the entry is rewritten in place');
    assert.ok(fake.dump().includes('[ ] 第二步<br>完成第二关。<br>换了个说法。'));
    assert.ok(!fake.dump().includes('  [ ] 拿到钥匙'), 'its old sub-steps were replaced, as in any rewrite');
  });

  test('the outline read leaves out what hangs under a checkbox, and still reads inside a container', async () => {
    const fake = new FakeNotion();
    fake.seed([
      ...SEED,
      { id: 'tg', type: 'toggle', text: '折叠', children: [{ id: 'x1', type: 'to_do', text: '**收集狂**<br>集齐全部收集品。' }] },
    ]);
    fake.calls.length = 0;
    const blocks = await fake.fetchSectionBlocks(PAGE_ID);
    const b = blocks.find((x) => x.id === 'b');
    assert.equal(b.children, undefined, 'the sub-steps of a checkbox are not the outline');
    assert.equal(blocks.find((x) => x.id === 'tg').children[0].id, 'x1', 'but a container is read');
    assert.ok(!fake.calls.some((c) => c.path.startsWith('/blocks/b/children')), 'and the request for them is not made');
  });

  test('appendBlocks says which block it placed last, with a page full of blocks behind the insertion', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const toDo = (id, s) => ({ object: 'block', type: 'to_do', to_do: { rich_text: toRichText(s), checked: false } });
    const r = await fake.appendBlocks(PAGE_ID, [toDo('x', 'new one'), toDo('y', 'new two')], { after: 'a' });
    const now = fake.kids.get(PAGE_ID);
    assert.equal(r.written, 2);
    assert.equal(r.lastId, now[now.indexOf('a') + 2], 'the second block placed — not the last block of the page, which is what the response ends with');
    assert.deepEqual(now.slice(0, 5), ['h1', 'a', now[2], now[3], 'b']);
  });

  test('a batch that runs past one request is chained behind what the last one placed', async () => {
    const fake = new FakeNotion();
    fake.seed(SEED);
    const many = Array.from({ length: 130 }, (_, i) => ({
      object: 'block', type: 'to_do', to_do: { rich_text: toRichText(`bulk ${String(i).padStart(3, '0')}`), checked: false },
    }));
    await fake.appendBlocks(PAGE_ID, many, { after: 'a' });
    const lines = fake.dump();
    const first = lines.findIndex((l) => l.includes('bulk 000'));
    assert.equal(lines[first - 1], '[x] 第一步<br>完成第一关。<br>开局就能拿。');
    for (let i = 0; i < 130; i++) assert.ok(lines[first + i].includes(`bulk ${String(i).padStart(3, '0')}`), `bulk ${i} is out of place`);
    assert.equal(lines[first + 130], '[ ] 第二步<br>完成第二关。<br>接着打就行。', 'and the page carries on as it did behind them');
  });

  test('an insertion that lands in the wrong place is caught by reading the page back, and the run does not report success', async () => {
    // The fake ignores `after` and appends at the end, which is what a changed API would do:
    // every call succeeds, every entry is on the page, and E sits under 收集
    const fake = new FakeNotion({ ignoreAfter: true });
    fake.seed(SEED);
    await assert.rejects(
      () => runNotion(notionEnv(fake), provider({ writes: [WRITE_EF], place: ['1 -> 1\n2 -> 2'] })),
      (e) => e.msgKey === 'patch.placementFailed',
    );
  });
});
