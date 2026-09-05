/**
 * Regression tests for the achievement-name ↔ checkbox matching rules
 * ------------------------------------------------
 * Run with: node --test (zero dependencies, using Node's built-in node:test)
 *
 * What is locked down here is the spot in the whole project most easily broken by "loosening it
 * a little while we are here": matching has to be **exact**.
 * The pit already fallen into: with prefix matching, a short achievement name can be the prefix
 * of another, harder achievement that is not actually unlocked, and the wrong checkbox gets
 * ticked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeText, extractTitleCandidates, matchAchievements, syncGameCheckboxes, findAmbiguousNames, resolveTodoToAchievement, collectSubStepTicks, mapAchievementGuides, stripGuideEcho, flatCompare } from '../lib/guides.js';
import { loadTodos, applyChecks } from '../lib/markdown.js';
import { toCsv, exportAll } from '../lib/csv.js';
import { openDb, insertGame, markNoAchievements, updateGameStats } from '../lib/db.js';
import { extractNotionPageId, normalizeNotionId } from '../lib/notion.js';

const ach = (nameCn, nameEn = '') => ({ nameCn, nameEn, apiname: nameCn });
const todo = (key, text, checked = false) => ({ key, text, checked });

describe('normalizeText', () => {
  test('strips bold, lowercases and turns <br> into a newline, while keeping separators like the colon and the dash', () => {
    assert.equal(normalizeText('**Taste**<br>描述在这里'), 'taste\n描述在这里');
    assert.equal(normalizeText('  位置:秘密  '), '位置:秘密');
    assert.equal(normalizeText('A  —  B'), 'a — b');
  });
});

describe('extractTitleCandidates', () => {
  test('splits by newline (the Notion "title<br>description" form)', () => {
    assert.ok(extractTitleCandidates('taste\n游戏才刚刚开始').includes('taste'));
  });

  test('splits by colon', () => {
    assert.ok(extractTitleCandidates('位置:这个位置的秘密').includes('位置'));
  });

  test('splits by halfwidth and fullwidth dashes', () => {
    assert.ok(extractTitleCandidates('freedom - 逃跑成功').includes('freedom'));
    assert.ok(extractTitleCandidates('体验(taste) — 描述').includes('体验(taste)'));
  });

  test('splits even with no space before the dash (`成就名- 描述`)', () => {
    // Found on 2026-08-10 while running guidelint over every guide: guides for games like
    // Civilization VI write `胜利！- 使用...`, with no space before the dash. Splitting only on
    // ' - ' made the whole line the sole candidate, so the achievement name could not be
    // extracted and those boxes could never be ticked — with no error: audit slipped past via the
    // description, while checkbox-sync presented as "nothing to tick", indistinguishable from
    // "everything is already ticked".
    assert.ok(extractTitleCandidates('胜利！- 使用北条时宗获得一场常规赛胜利').includes('胜利！'));
    assert.ok(extractTitleCandidates('《物种起源》- 在加拉帕戈斯群岛附近激活达尔文').includes('《物种起源》'));
  });

  test('a name with its own hyphen and no space after it is not split (Half-Life must not become Half-)', () => {
    // The split condition is a dash **followed by whitespace**, so a compound word is not cut in half
    const c = extractTitleCandidates('half-life 描述');
    assert.equal(c.includes('half'), false);
    assert.equal(c.includes('half-'), false);
  });

  test('in "中文名(English)" both the Chinese and the English name are candidates', () => {
    const c = extractTitleCandidates('体验(taste) — "游戏才刚刚开始……"');
    assert.ok(c.includes('体验'), 'the Chinese name should be a candidate');
    assert.ok(c.includes('taste'), 'the English name should be a candidate');
  });

  test('a guide adding a full stop to the name still yields a candidate with it removed', () => {
    // Found on 2026-08-10 while spot-checking guidelint's residual findings: the guide writes
    // 「秘密食材。」 while Steam calls it 「秘密食材」, so exact equality does not hold.
    const c = extractTitleCandidates('秘密食材。\n在所有隐藏关卡获得三星。');
    assert.ok(c.includes('秘密食材'), 'with the trailing full stop removed it should become a candidate');
  });

  test('the verbatim form (with punctuation) is still a candidate — a name that genuinely carries punctuation must not be broken', () => {
    // Names like 「白手起家。」 and 「胜利！」 really do carry punctuation.
    // The stripped candidate is **appended**, and the verbatim one has to remain, or working
    // matches are turned into misses.
    const c = extractTitleCandidates('白手起家。');
    assert.ok(c.includes('白手起家。'), 'the verbatim candidate with punctuation has to be kept');
    assert.ok(c.includes('白手起家'), 'the stripped candidate has to be there too');
  });

  test('the stripped candidate comes after the verbatim one (so the exact one wins first)', () => {
    const c = extractTitleCandidates('胜利！');
    assert.ok(c.indexOf('胜利！') < c.indexOf('胜利'), 'the verbatim candidate has to come first');
  });

  test('a line of nothing but punctuation does not produce an empty candidate', () => {
    assert.equal(extractTitleCandidates('。。。').includes(''), false);
  });

  test('punctuation inside the sentence is unaffected (only the tail is stripped)', () => {
    const c = extractTitleCandidates('说到底,还是要氪。');
    assert.ok(c.includes('说到底,还是要氪'), 'the trailing full stop should be removed');
    assert.equal(c.includes('说到底还是要氪'), false, 'the comma inside must not be touched');
  });
});

describe('matchAchievements — exact matching', () => {
  test('the common local markdown forms match (both the Chinese and the English name)', () => {
    const todos = [todo(1, '**体验**(Taste) — "游戏才刚刚开始……"')];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 1);
    assert.equal(matchAchievements([ach('', 'Taste')], todos).length, 1);
  });

  test('a short name does not wrongly match another achievement that has it as a prefix (a pit already fallen into)', () => {
    // 「明日」 is a strict prefix of 「明日之星」: prefix matching ticks the wrong one, and exact
    // matching has to refuse
    const todos = [todo(1, '**明日之星**(Rising Star) — 完成第1章')];
    assert.equal(matchAchievements([ach('明日', 'Rising')], todos).length, 0);
  });

  test('an achievement name appearing in a description is not a match', () => {
    const todos = [todo(1, '**其他成就**(Other) — 解锁后可以看到体验的说明')];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 0);
  });

  test('an already-ticked checkbox does not take part in matching', () => {
    const todos = [todo(1, '**体验**(Taste) — 描述', true)];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 0);
  });

  test('one checkbox is claimed by only one achievement', () => {
    const todos = [todo(1, '体验(Taste)')];
    const matches = matchAchievements([ach('体验', 'Taste'), ach('体验', 'Taste')], todos);
    assert.equal(matches.length, 1);
  });

  test('an achievement with no name (not yet synced into the ACHIEVEMENTS table) is skipped rather than matched at random', () => {
    assert.equal(matchAchievements([ach('', '')], [todo(1, '任何文字')]).length, 0);
  });
});

describe('the local markdown backend', () => {
  const dir = join(tmpdir(), 'sat-md-test');
  const file = join(dir, 'g.md');

  test('reads the checkboxes, ticks only the named lines, and leaves everything else untouched', () => {
    mkdirSync(dir, { recursive: true });
    const original = [
      '# 标题',
      '',
      'appid: 123 | 共2个成就',
      '',
      '- [ ] **体验**(Taste) — 描述一',
      '- [ ] **自由**(Freedom) — 描述二',
      '- [x] **已完成**(Done) — 描述三',
      '',
      '普通段落,不是 checkbox',
    ].join('\n');
    writeFileSync(file, original);

    const todos = loadTodos(file);
    assert.equal(todos.length, 3);
    assert.deepEqual(
      todos.map((t) => t.checked),
      [false, false, true]
    );

    const matches = matchAchievements([ach('体验', 'Taste')], todos);
    assert.equal(matches.length, 1);
    assert.equal(applyChecks(file, matches.map((m) => m.key)), 1);

    const after = readFileSync(file, 'utf8').split('\n');
    assert.equal(after[4], '- [x] **体验**(Taste) — 描述一', 'the matched line should be ticked with its text unchanged');
    assert.equal(after[5], '- [ ] **自由**(Freedom) — 描述二', 'an unmatched line must not be touched');
    assert.equal(after[8], '普通段落,不是 checkbox');

    // Idempotent: a second run should change nothing
    assert.equal(applyChecks(file, [4]), 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an indented checkbox hangs off the level above (parent points at the parent line, aligning with Notion nested to_do)', () => {
    const dir2 = join(tmpdir(), 'sat-md-nested');
    const f = join(dir2, 'n.md');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      f,
      [
        '- [ ] **父成就**',
        '  - [ ] 子步骤 1',
        '    - [ ] 子步骤 1.1',
        '  - [x] 子步骤 2',
        '- [ ] **另一个成就**',
      ].join('\n')
    );
    const t = loadTodos(f);
    assert.equal(t.length, 5);
    assert.equal(t[0].parent, null, 'top level has no parent');
    assert.equal(t[1].parent, t[0].key, 'one level of indent hangs off the parent achievement');
    assert.equal(t[2].parent, t[1].key, 'two levels of indent hang off the sub-step above');
    assert.equal(t[3].parent, t[0].key, 'back to one level of indent, hanging off the parent achievement again');
    assert.equal(t[4].parent, null, 'the next top-level achievement should not inherit the previous parent');
    rmSync(dir2, { recursive: true, force: true });
  });
});

/**
 * Sub-step cascading is the one place in this project that prefers over-ticking (see the comment
 * on collectSubStepTicks), so the boundary has to be nailed down: with no evidence that the
 * parent achievement really is unlocked, not one sub-step may be ticked.
 */
describe('sub-step cascade ticking', () => {
  const defs = [
    { api_name: 'allTech', name_cn: '笨手笨脚', name_en: 'Butterfingers', description: '每种技术都至少失败过一次' },
  ];
  const parentText = '**笨手笨脚**\n每种技术都至少失败过一次';
  const unlocked = new Set(['allTech']);

  test('the parent was matched this round → its unticked sub-steps are ticked along with it, and the ticked ones are not repeated', () => {
    const todos = [
      { key: 1, text: parentText, checked: false, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
      { key: 3, text: '技巧 B', checked: true, parent: 1 },
    ];
    const matches = [{ key: 1, achievement: ach('笨手笨脚'), text: parentText, via: 'name' }];
    const subs = collectSubStepTicks(todos, matches, { defs, unlockedApiNames: unlocked });
    assert.deepEqual(subs.map((s) => s.key), [2]);
  });

  test('the parent was ticked long ago with no new match this round → it still cascades (otherwise the feature does nothing for existing guides)', () => {
    const todos = [
      { key: 1, text: parentText, checked: true, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.deepEqual(subs.map((s) => s.key), [2]);
  });

  test('the parent is not actually unlocked (though the box is ticked) → not one sub-step is ticked', () => {
    const todos = [
      { key: 1, text: parentText, checked: true, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: new Set() });
    assert.equal(subs.length, 0);
  });

  test('the parent box is unticked and not in this round matches → no evidence, no cascade', () => {
    const todos = [
      { key: 1, text: parentText, checked: false, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.equal(subs.length, 0);
  });

  test('the parent box resolves to no unique achievement (the guide copied no description and the name does not match) → no cascade', () => {
    const todos = [
      { key: 1, text: '随手写的一行说明', checked: true, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.equal(subs.length, 0);
  });

  test('a sub-step with its own sub-steps ticks all the way down', () => {
    const todos = [
      { key: 1, text: parentText, checked: true, parent: null },
      { key: 2, text: '子步骤 1', checked: false, parent: 1 },
      { key: 3, text: '子步骤 1.1', checked: false, parent: 2 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.deepEqual(subs.map((s) => s.key).sort(), [2, 3]);
  });

  test('an older guide with no nesting at all: no cascade tick is produced', () => {
    const todos = [todo(1, parentText, true), todo(2, '**另一个成就**')];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.equal(subs.length, 0, 'parent is undefined throughout, so the behaviour has to be exactly what it was before');
  });
});

describe('Notion ID handling', () => {
  test('the page ID is extracted from URLs of every shape', () => {
    const want = '1d31fee6-ab8c-4f0b-9e2a-3c4d5e6f7a8b';
    assert.equal(extractNotionPageId('https://notion.so/Title-1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b'), want);
    assert.equal(extractNotionPageId('https://notion.so/1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b?v=x'), want);
  });

  test('deduplication has to use the normalised ID, never the raw URL text (the slug changes)', () => {
    const a = 'https://notion.so/Palworld-Guide-1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b';
    const b = 'https://notion.so/1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b';
    assert.equal(normalizeNotionId(a), normalizeNotionId(b));
    // Hex characters inside the slug (the a and d of Palworld) must not contaminate the extraction
    assert.equal(normalizeNotionId(a), '1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b');
  });
});

describe('CSV export', () => {
  // After import was deleted (2026-08-19), what remains here is the one silent failure on the
  // export side: for a game whose name carries a comma or a quote, wrong escaping raises no
  // error, it merely misaligns that row in a spreadsheet.
  // This used to be tested by the round trip parseCsv(toCsv(x)) === x, and parseCsv was part of
  // import, so it went away with it — hence pinning the literal output directly, which is harder
  // than a self-consistent round trip.
  test('commas, quotes and newlines are wrapped in quotes, with quotes doubled', () => {
    assert.equal(
      toCsv([['名字', '备注'], ['苏丹的游戏', '有,逗号和"引号"']]),
      '名字,备注\n苏丹的游戏,"有,逗号和""引号"""\n'
    );
    assert.equal(toCsv([['带\n换行']]), '"带\n换行"\n');
    assert.equal(toCsv([['干净', '']]), '干净,\n');
  });

  test("a game with no achievement system exports as 'N/A', not 0 — an empty achievement count and zero achievements are two different things", () => {
    // This used to be pinned only from the import side ('N/A' → has_achievements=0). Import is
    // gone while the code writing 'N/A' is still in exportAll, so here is one pinning it from the
    // export side.
    const db = openDb(':memory:');
    insertGame(db, { appid: '294100', name: 'RimWorld' });
    markNoAchievements(db, '294100');
    insertGame(db, { appid: '4164310', name: '这是谐音梗' });
    updateGameStats(db, '4164310', { achieved: 1000, total: 1000 });

    const dir = mkdtempSync(join(tmpdir(), 'sat-export-'));
    exportAll(db, dir);
    const rows = readFileSync(join(dir, 'RAW DATA.csv'), 'utf8').trim().split('\n');
    rmSync(dir, { recursive: true, force: true });

    const byApp = Object.fromEntries(rows.slice(1).map((r) => [r.split(',')[1], r.split(',')]));
    assert.equal(byApp['294100'][4], 'N/A');
    assert.equal(byApp['294100'][3], '');
    assert.equal(byApp['4164310'][4], '1000', 'a four-digit number must not carry a thousands separator');
    assert.equal(byApp['4164310'][5], '100.00%');
  });
});

describe('the dry-run mode of checkbox syncing', () => {
  const dir = join(tmpdir(), 'sat-dry-test');
  const file = 'g.md';

  test('--dry-run reports what would be ticked and writes not one byte', async () => {
    mkdirSync(dir, { recursive: true });
    const full = join(dir, file);
    const before = '# t\n\nappid: 123\n\n- [ ] **体验**(Taste) — 描述\n- [ ] **自由**(Freedom) — 描述\n';
    writeFileSync(full, before);

    const db = openDb(':memory:');
    db.prepare("INSERT INTO achievements (appid, api_name, name_cn, name_en) VALUES ('123','A','体验','Taste')").run();
    const steam = { delay: 0, fetchPlayerAchievements: async () => ({ achievements: [{ apiname: 'A', achieved: 1 }] }) };
    const guide = { appid: '123', url: file, kind: 'local' };
    const config = { guidesDir: dir };

    const dry = await syncGameCheckboxes(db, steam, guide, 'G', { notion: null, config, dryRun: true });
    assert.equal(dry.length, 1);
    assert.match(dry[0].result, /^【预演】/);
    assert.equal(readFileSync(full, 'utf8'), before, 'a dry run must not modify the file');

    // Only without dryRun does it really write
    const real = await syncGameCheckboxes(db, steam, guide, 'G', { notion: null, config });
    assert.match(real[0].result, /^已勾选/);
    assert.match(readFileSync(full, 'utf8'), /- \[x\] \*\*体验\*\*/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('identically named achievements (hit in real data)', () => {
  // One game has two achievements with exactly the same Chinese and English names:
  //   ACHIEVEMENT_160101 = steal 10 times unseen  → unlocked
  //   ACHIEVEMENT_300020 = finish and steal 100   → not unlocked
  // The unlocked one's checkbox was ticked long ago and has left the candidate pool, so the same
  // name goes on to match the other, **still locked** checkbox — the wrong tick. Exact matching
  // cannot stop two genuinely identical names.
  const seed = () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO achievements (appid, api_name, name_cn, name_en) VALUES (?,?,?,?)');
    ins.run('1468810', 'ACHIEVEMENT_160101', '妙手空空', 'Skilled Thief');
    ins.run('1468810', 'ACHIEVEMENT_300020', '妙手空空', 'Skilled Thief');
    ins.run('1468810', 'ACHIEVEMENT_OTHER', '一鸣惊人', 'Debut');
    return db;
  };
  const todos = [
    { key: 1, text: '妙手空空·隐秘10次版(隐秘偷窃10次)', checked: true },
    { key: 2, text: '妙手空空·通关100次版(Skilled Thief) — 通关且偷窃100次。', checked: false },
  ];
  const unlockedOne = [{ apiname: 'ACHIEVEMENT_160101', nameCn: '妙手空空', nameEn: 'Skilled Thief' }];

  test('only one of the identically named achievements is unlocked → the whole name is abandoned, and the other is never ticked', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_160101']));
    assert.ok(unsafe.has('妙手空空'), 'the Chinese name should be judged unsafe');
    assert.ok(unsafe.has('skilled thief'), 'the English name should be judged unsafe too');
    const m = matchAchievements(unlockedOne, todos, { unsafeNames: unsafe });
    assert.equal(m.length, 0, 'not one checkbox may be ticked');
    // The unlocked one's box was already ticked → everything that should be ticked is, and there
    // is nothing to warn about. Reporting "needs manual review" on every run while there is
    // nothing to do only trains people to stop reading the log.
    assert.equal(m.skippedAmbiguous.length, 0, 'this group is already satisfied and should stay silent');
  });

  test('none of the identically named boxes is ticked → it has to be reported rather than staying silent', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_160101']));
    const noneTicked = todos.map((t) => ({ ...t, checked: false }));
    const m = matchAchievements(unlockedOne, noneTicked, { unsafeNames: unsafe });
    assert.equal(m.length, 0, 'it still must not tick blindly');
    assert.equal(m.skippedAmbiguous.length, 1, 'unlocked with not one box ticked → worth a warning');
  });

  test('all the identically named achievements are unlocked → any pairing is correct, so match as usual', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_160101', 'ACHIEVEMENT_300020']));
    assert.equal(unsafe.size, 0);
    const both = [...unlockedOne, { apiname: 'ACHIEVEMENT_300020', nameCn: '妙手空空', nameEn: 'Skilled Thief' }];
    assert.equal(matchAchievements(both, todos, { unsafeNames: unsafe }).length, 1);
  });

  test('an achievement with a unique name is unaffected', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_OTHER']));
    assert.ok(!unsafe.has('一鸣惊人'));
  });
});

describe('audit: resolving a checkbox back to a specific achievement', () => {
  const def = (api, cn, en, desc) => ({ api_name: api, name_cn: cn, name_en: en, description: desc });

  // A tiered family: the descriptions start identically and differ only in the number. This is
  // where "match by prefix" goes off the rails
  const TIERED = [
    def('DMG_1', '牛刀小试', 'Damage1', '不触发天命特效，单发攻击造成100点伤害'),
    def('DMG_2', '威力一击', 'Damage2', '不触发天命特效，单发攻击造成500点伤害'),
    def('DMG_3', '致命一击', 'Damage3', '不触发天命特效，单发攻击造成1000点伤害'),
  ];

  test('a tiered family: the low tier box has to resolve to the low tier, not to a still-locked high one', () => {
    // A real incident: the audit matched on "the first 14 characters of the description" and
    // attributed this correctly ticked 100-damage tier to the 500-damage tier, inventing a
    // false "wrongly ticked" finding
    const hit = resolveTodoToAchievement('牛刀小试 不触发天命特效，单发攻击造成100点伤害', TIERED);
    assert.equal(hit?.def.api_name, 'DMG_1');
  });

  test('a tiered family: every tier resolves to its own', () => {
    for (const [text, want] of [
      ['威力一击 不触发天命特效，单发攻击造成500点伤害', 'DMG_2'],
      ['致命一击 不触发天命特效，单发攻击造成1000点伤害', 'DMG_3'],
    ]) {
      assert.equal(resolveTodoToAchievement(text, TIERED)?.def.api_name, want);
    }
  });

  test('the description was copied verbatim → resolved by description (the most trustworthy layer)', () => {
    const hit = resolveTodoToAchievement('新年快乐：在打特定怪物的战斗中，投掷爆竹作为最后一击。补充说明若干', [
      def('ach_241', '新年快乐', 'Happy New Year', '在打特定怪物的战斗中，投掷爆竹作为最后一击。'),
    ]);
    assert.equal(hit?.def.api_name, 'ach_241');
    assert.equal(hit?.via, 'description');
  });

  test('the guide paraphrased the description → fall back to the name, and only if the name is unique', () => {
    const defs = [def('A', '隐秘大师', 'Sneaky', '在不被发现的情况下完成整个章节')];
    const hit = resolveTodoToAchievement('隐秘大师(Sneaky) — 全程别被看见', defs);
    assert.equal(hit?.def.api_name, 'A');
    assert.equal(hit?.via, 'name');
  });

  test('identically named achievements → no conclusion (returns null), never a guess', () => {
    const defs = [
      def('A', '妙手空空', 'Skilled Thief', '偷窃10次'),
      def('B', '妙手空空', 'Skilled Thief', '通关且偷窃100次'),
    ];
    assert.equal(resolveTodoToAchievement('妙手空空·通关100次版(Skilled Thief)', defs), null);
  });

  test('two achievements with identical descriptions → no conclusion either', () => {
    const defs = [def('A', '甲', 'A', '做同一件事'), def('B', '乙', 'B', '做同一件事')];
    assert.equal(resolveTodoToAchievement('随便什么 做同一件事', defs), null);
  });

  test('text that matches nothing at all → null', () => {
    assert.equal(resolveTodoToAchievement('这一行只是章节标题', TIERED), null);
  });
});

/**
 * When the Dashboard expands a row, every still-locked achievement has to show "what your own
 * guide says about it".
 *
 * These cases all guard failures that **raise no error**: attaching the wrong achievement's
 * solution, the same passage appearing on two cards, and loosening the matching so a card is not
 * left blank. The last one especially needs pinning — this is "only display", so the temptation
 * to loosen is far stronger than on the ticking path, and both sides share the same
 * resolveTodoToAchievement.
 */
describe('guide reverse lookup: achievement → the entry in the guide', () => {
  const def = (api, cn, en, desc) => ({ api_name: api, name_cn: cn, name_en: en, description: desc });
  const todo = (key, text, { checked = false, parent = null } = {}) => ({ key, text, checked, parent });

  const DEFS = [
    def('A', '隐秘大师', 'Sneaky', '在不被发现的情况下完成整个章节'),
    def('B', '收藏家', 'Collector', '集齐全部藏品'),
  ];

  test('a matched box: the body comes through verbatim, and that is the solution the card shows', () => {
    const map = mapAchievementGuides(
      [todo('k1', '隐秘大师\n在不被发现的情况下完成整个章节\n走右边水道，别开灯')],
      DEFS
    );
    assert.equal(map.get('A').text, '隐秘大师\n在不被发现的情况下完成整个章节\n走右边水道，别开灯');
    assert.equal(map.get('A').key, 'k1');
  });

  test('sub-steps hanging under the achievement travel with it, keeping their nesting depth', () => {
    const map = mapAchievementGuides([
      todo('k1', '收藏家 集齐全部藏品'),
      todo('k2', '藏品一:钟楼顶', { parent: 'k1', checked: true }),
      todo('k3', '藏品二:地窖', { parent: 'k1' }),
      todo('k4', '地窖要先拿钥匙', { parent: 'k3' }),
    ], DEFS);
    assert.deepEqual(map.get('B').subSteps, [
      { text: '藏品一:钟楼顶', checked: true, depth: 0 },
      { text: '藏品二:地窖', checked: false, depth: 0 },
      { text: '地窖要先拿钥匙', checked: false, depth: 1 },
    ]);
  });

  test('a sub-step that is itself another achievement box → it is not a sub-step of the one above', () => {
    // Without excluding it, the same passage appears once on each of two cards, and one of those
    // times it is attributed to the wrong achievement
    const map = mapAchievementGuides([
      todo('k1', '收藏家 集齐全部藏品'),
      todo('k2', '隐秘大师 在不被发现的情况下完成整个章节', { parent: 'k1' }),
    ], DEFS);
    assert.deepEqual(map.get('B').subSteps, []);
    assert.equal(map.get('A').key, 'k2');
  });

  test('identically named achievements → this achievement gets no entry, the card stays blank, and one is never picked at random', () => {
    const dup = [
      def('X', '妙手空空', 'Skilled Thief', '偷窃10次'),
      def('Y', '妙手空空', 'Skilled Thief', '通关且偷窃100次'),
    ];
    const map = mapAchievementGuides([todo('k1', '妙手空空 随便写点什么')], dup);
    assert.equal(map.size, 0);
  });

  test('one achievement mentioned twice in the guide → only the first entry counts', () => {
    const first = todo('k1', '隐秘大师 在不被发现的情况下完成整个章节');
    const again = todo('k9', '隐秘大师 — 另一处顺带提了一句');
    // First confirm **both** really do resolve to A — otherwise this case passes automatically
    // when the second one never matched at all, pinning nothing (mutation testing caught that
    // empty-running version)
    assert.equal(resolveTodoToAchievement(again.text, DEFS)?.def.api_name, 'A');
    const map = mapAchievementGuides([first, again], DEFS);
    assert.equal(map.get('A').key, 'k1');
  });

  test('a whole guide where not one box matches → an empty Map, not a throw', () => {
    const map = mapAchievementGuides([todo('k1', '第一章:开场'), todo('k2', '第二章:结局')], DEFS);
    assert.equal(map.size, 0);
  });
});

/**
 * The card already carries the achievement name and description above, so the restatement at the
 * start of the guide body has to be trimmed.
 *
 * **Most of this group is "must not delete"**: deleting a line the user wrote is unrecoverable,
 * while keeping one is merely verbose. That asymmetry is the entire reason for this criterion,
 * so the negative cases are worth pinning more than the positive ones.
 */
describe('trimming the guide opening restatement of the name and description', () => {
  const NAMES = ['隐秘大师', 'Sneaky'];
  const DESC = '在不被发现的情况下完成整个章节';

  test('name + verbatim description + solution → only the solution is kept', () => {
    const out = stripGuideEcho('隐秘大师\n在不被发现的情况下完成整个章节\n走右边水道，别开灯',
      { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道，别开灯');
  });

  test('the `中文名(English)` form is recognised too', () => {
    const out = stripGuideEcho('隐秘大师(Sneaky)\n走右边水道', { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道');
  });

  test('a `**bold**` name is recognised as well (the markdown backend)', () => {
    const out = stripGuideEcho('**隐秘大师**\n走右边水道', { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道');
  });

  test('a rewritten description → kept, those are the user own words', () => {
    const text = '隐秘大师\n全程不能被任何人看到\n走右边水道';
    assert.equal(stripGuideEcho(text, { names: NAMES, description: DESC }),
      '全程不能被任何人看到\n走右边水道');
  });

  test('a hidden achievement: Steam has no description → not one line may be over-deleted', () => {
    // This line is the only place on the whole card stating the unlock condition, because the
    // Steam side is empty
    const out = stripGuideEcho('夏洛克家\n处理酸奶丢失的情况。',
      { names: ['夏洛克家'], description: '' });
    assert.equal(out, '处理酸奶丢失的情况。');
  });

  test('the name is only the start of the line with body text after it → the whole line is left alone', () => {
    // extractTitleCandidates would cut 「知识」 out of this line, and deleting by that would delete
    // the whole solution.
    // **A second body line has to be attached**: with only this one line, over-deleting empties
    // rest and the fallback returns it verbatim, making this case permanently green — mutation
    // testing caught that empty-running version
    const head = '知识(Rationality) — "知识让我们知道自己依旧不知道。" 集齐全部百科全书条目';
    const text = head + '\n先去图书馆把三轮问答刷完';
    assert.equal(stripGuideEcho(text, { names: ['知识', 'Rationality'], description: '知识让我们知道自己依旧不知道。' }),
      text);
  });

  test('a restatement in the middle rather than at the start → untouched', () => {
    const text = '先做支线\n隐秘大师\n再回主线';
    assert.equal(stripGuideEcho(text, { names: NAMES, description: DESC }), text);
  });

  test('a whole guide entry of nothing but the name and description → empty string, telling the caller not to draw a panel', () => {
    // Returned verbatim, an entry that "only copied the official text" would be the most
    // thoroughly duplicated card of all
    const text = '隐秘大师\n在不被发现的情况下完成整个章节';
    assert.equal(stripGuideEcho(text, { names: NAMES, description: DESC }), '');
  });

  test('a difference in trailing punctuation should not block the description match', () => {
    const out = stripGuideEcho('隐秘大师\n在不被发现的情况下完成整个章节。\n走右边水道',
      { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道');
  });
});

describe('identically named achievements: copying the description verbatim rescues them', () => {
  // Two achievements in the same game with exactly the same name, differing only in description.
  // The name alone can never separate them (see findAmbiguousNames above), but if the checkbox
  // copied the full official description, which achievement the box refers to is unambiguous.
  const DEFS = [
    { api_name: 'A', name_cn: '妙手空空', name_en: 'Skilled Thief', description: '偷窃10次且未被察觉' },
    { api_name: 'B', name_cn: '妙手空空', name_en: 'Skilled Thief', description: '通关且成功偷窃100次' },
  ];
  const unsafe = new Set(['妙手空空', 'skilled thief']);
  const unlockedA = [{ apiname: 'A', nameCn: '妙手空空', nameEn: 'Skilled Thief' }];

  test('the description was copied verbatim → the correct box is ticked and the other is untouched', () => {
    const todos = [
      { key: 1, text: '**妙手空空**<br>偷窃10次且未被察觉<br>提示:开局就能做', checked: false },
      { key: 2, text: '**妙手空空**<br>通关且成功偷窃100次<br>提示:要二周目', checked: false },
    ];
    const m = matchAchievements(unlockedA, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m[0].key, 1, 'it should tick the unlocked one (A), not the still-locked B');
    assert.equal(m[0].via, 'description');
    assert.equal(m.skippedAmbiguous.length, 0);
  });

  test('only paraphrased, with no verbatim description → still abandoned, never guessed', () => {
    const todos = [
      { key: 1, text: '**妙手空空·隐秘10次版**(偷偷摸摸拿十次东西)', checked: false },
      { key: 2, text: '**妙手空空·通关100次版**(打完再拿一百次)', checked: false },
    ];
    const m = matchAchievements(unlockedA, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 0);
    assert.equal(m.skippedAmbiguous.length, 1);
  });

  test('the unlocked one box was ticked long ago → the other, still-locked one is not ticked', () => {
    const todos = [
      { key: 1, text: '**妙手空空**<br>偷窃10次且未被察觉', checked: true },
      { key: 2, text: '**妙手空空**<br>通关且成功偷窃100次', checked: false },
    ];
    const m = matchAchievements(unlockedA, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 0, 'this is the core scenario of the original bug, and not one may be ticked');
  });

  test('an achievement with a unique name is unaffected by the first pass and still matches by name', () => {
    const defs = [...DEFS, { api_name: 'C', name_cn: '一鸣惊人', name_en: 'Debut', description: '首次出场' }];
    const todos = [{ key: 9, text: '**一鸣惊人**(Debut) — 首次出场', checked: false }];
    const m = matchAchievements([{ apiname: 'C', nameCn: '一鸣惊人', nameEn: 'Debut' }], todos, {
      unsafeNames: unsafe, defs,
    });
    assert.equal(m.length, 1);
    assert.equal(m[0].via, 'name');
  });
});

describe('the collision gate closes per name, not per achievement', () => {
  // Of the 12 games in the library with colliding names, 9 collide in **only one language** —
  // a Steam localisation mistake, with the original names perfectly separable. Previously, a
  // collision in one language sent the whole achievement down the description-only path, wasting
  // a completely unique name in the other language. What cannot tell the twins apart is the
  // **name**, not the achievement.
  //
  // The only loosening is "do not throw away the unique name too"; equality matching itself is
  // unchanged: full equality is still required, substrings and prefixes are still forbidden, and
  // the colliding name itself is still never usable.
  const DEFS = [
    { api_name: 'NANO', name_cn: '生化武器大师', name_en: 'Nano-Virus Master', description: '在终极困难模式下打败纳米病毒大师!' },
    { api_name: 'BIO', name_cn: '生化武器大师', name_en: 'Bioweapon Master', description: '在终极困难模式下打败生化武器大师!' },
  ];
  const unsafe = new Set(['生化武器大师']); // only the Chinese collides
  const nano = [{ apiname: 'NANO', nameCn: '生化武器大师', nameEn: 'Nano-Virus Master' }];

  test('the Chinese collides while the English is unique → ticked via the English name, without touching the twin box', () => {
    const todos = [
      { key: 1, text: '生化武器大师(Nano-Virus Master)', checked: false },
      { key: 2, text: '生化武器大师(Bioweapon Master)', checked: false },
    ];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m[0].key, 1, 'only the one whose English name matches may be ticked');
    assert.equal(m[0].via, 'name');
  });

  test('the colliding name itself is still never usable', () => {
    const todos = [{ key: 1, text: '生化武器大师', checked: false }];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 0, 'the box carries only the colliding name → which one it is cannot be told, so abandon it');
  });

  test('one rescued by the non-colliding name does not count as "skipped" — no false alarm', () => {
    const todos = [{ key: 1, text: '生化武器大师(Nano-Virus Master)', checked: false }];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m.skippedAmbiguous.length, 0, 'once matched it should not report "needs manual review" again');
  });

  test('and the reverse: the English collides while the Chinese is unique (a "Text" placeholder)', () => {
    const defs = [
      { api_name: 'X', name_cn: '寻至世界两端', name_en: 'Text', description: 'd1' },
      { api_name: 'Y', name_cn: '献给死神塔的花束', name_en: 'Text', description: 'd2' },
    ];
    const todos = [
      { key: 1, text: '寻至世界两端', checked: false },
      { key: 2, text: '献给死神塔的花束', checked: false },
    ];
    const m = matchAchievements([{ apiname: 'X', nameCn: '寻至世界两端', nameEn: 'Text' }], todos, {
      unsafeNames: new Set(['text']), defs,
    });
    assert.equal(m.length, 1);
    assert.equal(m[0].key, 1);
    assert.equal(m[0].via, 'name');
  });

  test('both languages collide → still description-only, with genuinely identical names loosened not one bit', () => {
    const defs = [
      { api_name: 'A', name_cn: '妙手空空', name_en: 'Skilled Thief', description: '偷窃10次且未被察觉' },
      { api_name: 'B', name_cn: '妙手空空', name_en: 'Skilled Thief', description: '通关且成功偷窃100次' },
    ];
    const todos = [{ key: 1, text: '妙手空空(Skilled Thief)', checked: false }];
    const m = matchAchievements([{ apiname: 'A', nameCn: '妙手空空', nameEn: 'Skilled Thief' }], todos, {
      unsafeNames: new Set(['妙手空空', 'skilled thief']), defs,
    });
    assert.equal(m.length, 0);
    assert.equal(m.skippedAmbiguous.length, 1);
  });

  test('the description still wins over the name: when both paths work, take the description', () => {
    const todos = [
      { key: 1, text: '生化武器大师(Nano-Virus Master)\n在终极困难模式下打败纳米病毒大师!', checked: false },
    ];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m[0].via, 'description', 'the first pass runs first — the description is more precise than the name');
  });
});

// ---------------------------------------------------------------------------
// Line-ending style
// ---------------------------------------------------------------------------

describe('a CRLF local guide has to work as usual', () => {

  test('a CRLF file yields its checkboxes — a silent failure where neither tool reports anything', () => {
    // Hit on 2026-08-10: editors on Windows write CRLF by default. The code used split('\n'),
    // leaving a \r at the end of the line, and `.` in a JS regex **does not match \r** (it counts
    // as a line terminator), so `(.*)$` failed to match and the whole guide read as 0 checkboxes.
    // It presented as checkbox-sync ticking nothing and guide-lint reporting "every achievement is
    // missing a checkbox", **with neither side raising an error**, which looks like the guide was
    // written wrong
    const dir = mkdtempSync(join(tmpdir(), 'crlf-'));
    const p = join(dir, 'g.md');
    writeFileSync(p, '# 游戏\r\n\r\nappid: 1\r\n\r\n- [ ] **第一步**<br>描述\r\n  - [ ] 子步骤\r\n');
    const todos = loadTodos(p);
    assert.equal(todos.length, 2);
    assert.equal(todos[0].text, '**第一步**<br>描述');
    assert.equal(todos[1].parent, todos[0].key, 'the indent level has to be recognised too');
  });

  test('ticking preserves the original line-ending style (do not convert the whole file to LF)', () => {
    // Converting the whole file to LF while there makes git diff show every line as changed,
    // burying the real change inside it
    const dir = mkdtempSync(join(tmpdir(), 'crlf-'));
    const p = join(dir, 'g.md');
    writeFileSync(p, '- [ ] **甲**\r\n- [ ] **乙**\r\n');
    applyChecks(p, [0]);
    const after = readFileSync(p, 'utf8');
    assert.match(after, /^- \[x\] \*\*甲\*\*\r\n/, 'the one to tick was ticked');
    assert.ok(!/[^\r]\n/.test(after), 'no bare LF may be mixed in');
  });
});

// ---------------------------------------------------------------------------
// Normalisation for comparison (flatCompare)
// ---------------------------------------------------------------------------
// One game's 「好家长」: Steam writes curly quotes 「与孩子的关系达到“幸福的孩子”。」 while the
// guide copied straight quotes. The same sentence, judged as "paraphrased", so audit cannot
// resolve that box.
// Measured across the library, 14 of 791 mismatches are this kind and the other 777 are genuine
// rewrites by the author.
describe('flatCompare: fold the spelling, never the content', () => {
  test('typographic and straight quotes count as the same character', () => {
    assert.equal(flatCompare('达到“幸福的孩子”。'), flatCompare('达到"幸福的孩子"。'));
    assert.equal(flatCompare('it\u2019s'), flatCompare("it's"));
  });

  test('whitespace is still folded', () => {
    assert.equal(flatCompare('a b\nc'), 'abc');
  });

  test('dashes and the ellipsis are deliberately not folded — there is no evidence it is needed, and their meanings really do differ', () => {
    assert.notEqual(flatCompare('1-2'), flatCompare('1\u20142'));
    assert.notEqual(flatCompare('...'), flatCompare('\u2026'));
  });

  test('two different descriptions are not folded into one', () => {
    assert.notEqual(flatCompare('杀死100只怪'), flatCompare('杀死200只怪'));
    assert.notEqual(flatCompare('“甲”'), flatCompare('“乙”'));
  });

  test('audit can now resolve a box that differs only in quote glyphs', () => {
    const defs = [
      { api_name: 'A', name_cn: '好家长', name_en: '', description: '与孩子的关系达到“幸福的孩子”。' },
      { api_name: 'B', name_cn: '别的', name_en: '', description: '完全不同的描述。' },
    ];
    const hit = resolveTodoToAchievement('好家长<br>与孩子的关系达到"幸福的孩子"。<br>心得', defs);
    assert.equal(hit?.def?.api_name, 'A');
    assert.equal(hit?.via, 'description', 'it should go via the description path rather than hitting the name');
  });

  test('two achievements differing only in quotes: neither matches — the safe side', () => {
    // After folding, the description uniqueness count becomes 2, so the description path is not
    // taken at all.
    // This project consistently chooses "rather fail to tick than tick wrongly"
    const defs = [
      { api_name: 'A', name_cn: '甲', name_en: '', description: '拿到“钥匙”。' },
      { api_name: 'B', name_cn: '乙', name_en: '', description: '拿到"钥匙"。' },
    ];
    assert.equal(resolveTodoToAchievement('随便写点<br>拿到"钥匙"。', defs), null);
  });

  test('both askers go through the same function, with no second copy allowed', () => {
    // resolveTodoToAchievement and guidelint used to hold one identical private flat each.
    // Changing one and missing the other presents as: the linter says "audit cannot resolve this
    // box" while audit resolves it perfectly well.
    //
    // **There is a third copy in guides.js, and that one is deliberately different**:
    // `nameGroupAlreadySatisfied` uses loose containment plus lowercase, and it only decides
    // whether to print a log line, never what to write (see its own comment and CLAUDE.md).
    // Merging it would erase that boundary, so only the two on the write side are pinned here.
    const strip = (src) => src
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const guides = strip(readFileSync(new URL('../lib/guides.js', import.meta.url), 'utf8'));
    const lint = strip(readFileSync(new URL('../lib/guidelint.js', import.meta.url), 'utf8'));

    const at = guides.indexOf('export function resolveTodoToAchievement');
    assert.ok(at > 0, 'cannot find resolveTodoToAchievement — this check has lost its target');
    const rta = guides.slice(at, guides.indexOf('\n}', at));
    assert.ok(rta.length > 200, 'what was sliced should be the whole function');
    // `\\s` is what means "a backslash followed by an s". Written as `\s` it is the whitespace
    // class, which can never match the `replace(/\s+/g` in the source — these two assertions were
    // written that way at first, making them constantly true, and mutation testing is what caught it
    const INLINED = /replace\(\/\\s\+\/g/;
    assert.doesNotMatch(rta, INLINED, 'the audit criterion has to go through flatCompare rather than folding its own copy');
    assert.match(rta, /flatCompare/);

    assert.doesNotMatch(lint, INLINED,
      'the linter criterion has to go through flatCompare — its wording is 「audit 反查不了」, so it has to judge with the audit function');
    // Checking that flatCompare appears is not enough: the import line contains it, so replacing
    // flat with an inlined version would still be green
    assert.match(lint, /const flat = flatCompare/, 'the linter flat has to be flatCompare itself');
  });
});

// ---------------------------------------------------------------------------
// Stage 1 matches a description in either language
// ---------------------------------------------------------------------------

/**
 * The description stage is the precise one — it claims a checkbox before name matching could, and
 * it is the **only** way to tell apart two achievements that share a name. Matching one language
 * only means it silently never fires on a guide written in the other, and every one of those falls
 * through to the name stage, where a shared name resolves to nothing at all.
 *
 * It is not fixed by consulting the guide's recorded language: that value would have to be right,
 * and rows written before it existed carry an assumed one. Comparing against both needs no answer.
 */
describe('resolveTodoToAchievement stage 1 — either language', () => {
  const A = {
    api_name: 'A', name_cn: '第一个', name_en: 'The First',
    description: '解锁第一个成就。', description_en: 'Unlock the first achievement.',
  };
  const B = {
    api_name: 'B', name_cn: '第二个', name_en: 'The Second',
    description: '再来一次。', description_en: 'Do it again.',
  };

  test('a Chinese guide quoting the Chinese description still resolves', () => {
    const hit = resolveTodoToAchievement('**第一个**<br>解锁第一个成就。<br>随手就有', [A, B]);
    assert.equal(hit?.def.api_name, 'A');
    assert.equal(hit?.via, 'description');
  });

  test('an English guide quoting the English description resolves the same way', () => {
    const hit = resolveTodoToAchievement('**The First**<br>Unlock the first achievement.<br>trivial', [A, B]);
    assert.equal(hit?.def.api_name, 'A');
    assert.equal(hit?.via, 'description');
  });

  test('two achievements sharing a name are told apart by the English description', () => {
    // The case this stage exists for. Both are called the same thing, so the name stage refuses
    // (hit.size !== 1) and returns null — only the description can separate them
    const dupA = { ...A, name_cn: '收集', name_en: 'Collect' };
    const dupB = { ...B, name_cn: '收集', name_en: 'Collect' };
    const hit = resolveTodoToAchievement('**Collect**<br>Do it again.<br>later', [dupA, dupB]);
    assert.equal(hit?.def.api_name, 'B');
    assert.equal(hit?.via, 'description');
  });

  test('a description shared by two achievements still refuses, across languages', () => {
    // Uniqueness is what makes this stage safe, and it has to hold over the union of both
    // languages — otherwise an English description colliding with another achievement's Chinese one
    // would match wrongly, which is worse than not matching
    const collide = { ...B, description: 'Unlock the first achievement.' };
    assert.equal(resolveTodoToAchievement('Unlock the first achievement.', [A, collide]), null);
  });

  test('**one achievement whose two descriptions are the same string still matches**', () => {
    // Counting occurrences rather than achievements reads this as a collision with itself and
    // refuses a match that is in fact unambiguous. Some games ship identical text in both schemas
    const same = { api_name: 'S', name_cn: '同文', name_en: 'Same', description: 'Do the thing.', description_en: 'Do the thing.' };
    const hit = resolveTodoToAchievement('**Same**<br>Do the thing.', [same, B]);
    assert.equal(hit?.def.api_name, 'S');
    assert.equal(hit?.via, 'description');
  });

  test('an achievement with only a Chinese description is unaffected', () => {
    // Every guide written before description_en existed is in this state
    const old = { api_name: 'O', name_cn: '旧的', name_en: 'Old', description: '只有中文描述。' };
    assert.equal(resolveTodoToAchievement('**旧的**<br>只有中文描述。', [old, B])?.def.api_name, 'O');
  });
});

/**
 * Stage 1 asks whether a checkbox **contains** an achievement's complete description, and two ways
 * of satisfying that question by accident are pinned here. Both were live in Factorio at once and
 * between them cost 61 of 88 cards their guide.
 *
 * They share a failure shape worth naming: the stage answered with an achievement it had *some*
 * evidence for, rather than with the achievement the evidence was strongest for — and
 * mapAchievementGuides gives each achievement to the first box that claims it, so one wrong answer
 * also silently swallows every later box that should have had it.
 */
describe('resolveTodoToAchievement stage 1 — evidence that only looks like evidence', () => {
  const A = {
    api_name: 'A', name_cn: '第一个', name_en: 'The First',
    description: '解锁第一个成就。', description_en: 'Unlock the first achievement.',
  };

  test('**a description that is only whitespace is not evidence at all**', () => {
    // Steam really does ship these — Factorio's 咸鱼翻身 stores a single space. It is truthy, so a
    // `!raw` guard admits it, and it flattens to '', which every text on earth contains. Left
    // unguarded that one achievement answers for every checkbox in the game
    const blank = { api_name: 'BLANK', name_cn: '咸鱼翻身', name_en: 'So long', description: ' ', description_en: ' ' };
    assert.equal(resolveTodoToAchievement('完全无关的一段话', [blank, A]), null);
    assert.equal(resolveTodoToAchievement('**第一个**<br>解锁第一个成就。', [blank, A])?.def.api_name, 'A');
  });

  test('**the longest contained description wins, not the first one listed**', () => {
    // A tiered family writes the lower tier's description inside the higher tier's, so a box for
    // the higher tier contains both. Order in `defs` must not decide it: taking the first filed
    // 「在游戏90分钟内建造出内燃机车。」 under the achievement that only asks for a locomotive
    const lower = { api_name: 'LOW', name_cn: '你上道了', name_en: 'On track', description: '建造出内燃机车。' };
    const higher = { api_name: 'HIGH', name_cn: '轻车熟路', name_en: 'Like a pro', description: '在游戏90分钟内建造出内燃机车。' };
    const box = '轻车熟路<br>在游戏90分钟内建造出内燃机车。';
    assert.equal(resolveTodoToAchievement(box, [lower, higher])?.def.api_name, 'HIGH');
    assert.equal(resolveTodoToAchievement(box, [higher, lower])?.def.api_name, 'HIGH');
    // The lower tier's own box contains only its own description and is unaffected
    assert.equal(resolveTodoToAchievement('你上道了<br>建造出内燃机车。', [lower, higher])?.def.api_name, 'LOW');
  });

  test('two different achievements contained at the same length answer with nothing', () => {
    // Length is a tie-break between nested sentences, not a way to pick a winner out of a genuine
    // ambiguity. Neither is more specific than the other, so the stage declines and the name stage
    // gets its turn
    const x = { api_name: 'X', name_cn: '甲', name_en: 'X', description: '做完这件事。' };
    const y = { api_name: 'Y', name_cn: '乙', name_en: 'Y', description: '做完那件事。' };
    assert.equal(resolveTodoToAchievement('做完这件事。做完那件事。', [x, y]), null);
  });
});

/**
 * **A description quoted in the notes is a citation, not the subject.**
 *
 * Measured over the whole corpus: 7 boxes of 4,133 were filed under an achievement the entry merely
 * mentioned — 神界：原罪2 (4), 月圆之夜 (2), KINGDOM HEARTS (1). The shape is always the same: the
 * notes cite another achievement, that citation contains the cited achievement's complete
 * description, and it is longer than this entry's own — so the description stage claimed it before
 * the name stage could say what the entry is called.
 */
describe('which part of an entry a description has to be quoted in', () => {
  const def = (api, cn, en, desc) => ({ api_name: api, name_cn: cn, name_en: en, description: desc });
  // 「购买了愿望之夜-女巫」's official description *is* its name, so a cross-reference to it carries
  // the whole description with it. That is 月圆之夜's real data
  const DEFS = [
    def('BUY', '购买了愿望之夜-女巫', 'Bought the Witch', '购买了愿望之夜-女巫'),
    def('HOME', '温暖的家', 'A Warm Home', '女巫，通关任意难度'),
  ];
  const ENTRY = [
    '温暖的家',
    '女巫，通关任意难度',
    '前置:先购买「愿望之夜-女巫」角色包(见成就「购买了愿望之夜-女巫」)。',
  ].join('\n');

  test('an entry is about what its head says, not what its notes cite', () => {
    const hit = resolveTodoToAchievement(ENTRY, DEFS);
    assert.equal(hit?.def.api_name, 'HOME', 'the cited achievement is longer, and used to win');
  });

  test('the cited achievement still resolves from its own entry', () => {
    const hit = resolveTodoToAchievement('购买了愿望之夜-女巫\n购买了愿望之夜-女巫\n在商店买这个角色包', DEFS);
    assert.equal(hit?.def.api_name, 'BUY');
  });

  /**
   * **The ambiguous-name rescue depends on this staying head-first.** `matchAchievements` resolves a
   * same-named achievement only through a box that resolves to it **by description** — a rule that
   * simply preferred the name would take that path away, and the cost is a checkbox that can never
   * be ticked.
   */
  test('a same-named achievement is still rescued by the description at the head', () => {
    const defs = [
      def('A', '妙手空空', 'Skilled Thief', '偷窃10次'),
      def('B', '妙手空空', 'Skilled Thief', '通关且偷窃100次'),
    ];
    const hit = resolveTodoToAchievement('妙手空空\n通关且偷窃100次\n提示:先做完主线', defs);
    assert.equal(hit?.def.api_name, 'B');
    assert.equal(hit?.via, 'description', 'matchAchievements looks for exactly this');
  });

  /**
   * **An achievement Steam ships with no description cannot be quoted**, so a guide writing an
   * entry for one quotes the nearest thing — a sibling's. Measured on KINGDOM HEARTS -HD 1.5+2.5
   * ReMIX-, a four-in-one collection: 「Record Keeper Sora」 carries an empty description and its
   * entry quotes 「Record Keeper」's, at the head, where the head tier trusts it.
   *
   * The title breaks that tie and nothing else: over the whole corpus this moved **one** box of
   * 4,133, and left every other answer exactly where it was.
   */
  test('a title that names one achievement outranks a head description naming another', () => {
    const defs = [
      def('KEEPER', 'Record Keeper', 'Record Keeper', "Collect all Jiminy's Journal entries."),
      def('SORA', 'Record Keeper Sora', 'Record Keeper Sora', ''),
    ];
    const entry = "Record Keeper Sora\nCollect all Jiminy's Journal entries.\n索拉篇日志全收集";
    assert.equal(resolveTodoToAchievement(entry, defs)?.def.api_name, 'SORA');
    // and the achievement whose description it is still resolves from its own entry
    assert.equal(
      resolveTodoToAchievement("Record Keeper\nCollect all Jiminy's Journal entries.", defs)?.def.api_name,
      'KEEPER'
    );
  });

  /**
   * **The tie-break reads the title line and nothing else, and that is what keeps the rescue safe.**
   *
   * Candidates come out of every line, so widening it to the whole entry would let a name cited in
   * the notes stand in for the title. Here the title is a same-named achievement — the one shape
   * that *must* fall through to the description — and the notes name a different, unique one. Read
   * whole-entry, the tie-break would hand the box to the achievement the notes merely mention and
   * `matchAchievements` would lose its only way to place the real one.
   */
  test('the tie-break reads the title line only, never a name cited further down', () => {
    const defs = [
      def('A', '妙手空空', 'Skilled Thief', '偷窃10次'),
      def('B', '妙手空空', 'Skilled Thief2', '通关且偷窃100次'),
      def('C', '开锁大师', 'Lockpick', '开锁50次'),
    ];
    const hit = resolveTodoToAchievement('妙手空空\n通关且偷窃100次\n开锁大师', defs);
    assert.equal(hit?.def.api_name, 'B');
    assert.equal(hit?.via, 'description', 'a same-named achievement has no other way through');
  });

  test('where the title and the head description agree, the description still answers', () => {
    // 2,836 boxes of the corpus resolve this way, and the tie-break must not disturb any of them
    const defs = [def('A', '新年快乐', 'Happy New Year', '投掷爆竹作为最后一击。')];
    const hit = resolveTodoToAchievement('新年快乐\n投掷爆竹作为最后一击。\n补充说明', defs);
    assert.equal(hit?.def.api_name, 'A');
    assert.equal(hit?.via, 'description', 'the description stays the primary evidence');
  });

  test('and a description below the head still resolves when the entry names nothing unique', () => {
    // The last tier, and it costs nothing to keep: the one box in the corpus that quotes its
    // description below the head, and has no unique name of its own, resolves exactly as before
    const defs = [def('A', '妙手空空', 'Skilled Thief', '偷窃10次'), def('B', '妙手空空', 'Skilled Thief', '通关且偷窃100次')];
    const hit = resolveTodoToAchievement('妙手空空\n(Skilled Thief)\n通关且偷窃100次', defs);
    assert.equal(hit?.def.api_name, 'B');
    assert.equal(hit?.via, 'description');
  });
});
