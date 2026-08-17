/**
 * 成就名 ↔ checkbox 匹配规则的回归测试
 * ------------------------------------------------
 * 跑法:node --test(零依赖,用 Node 内置的 node:test)
 *
 * 这里锁住的是整个项目最容易被"顺手放宽一下"改坏的地方:匹配必须**精确**。
 * 踩过的坑:用前缀匹配的时候,一个短成就名可能是另一个更难的、
 * 实际还没解锁的成就名的前缀,结果勾错了 checkbox。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeText, extractTitleCandidates, matchAchievements, syncGameCheckboxes, findAmbiguousNames, resolveTodoToAchievement, collectSubStepTicks, mapAchievementGuides, stripGuideEcho } from '../lib/guides.js';
import { loadTodos, applyChecks } from '../lib/markdown.js';
import { parseCsv, toCsv, tabName, importGames } from '../lib/csv.js';
import { openDb, getGame } from '../lib/db.js';
import { extractNotionPageId, normalizeNotionId } from '../lib/notion.js';

const ach = (nameCn, nameEn = '') => ({ nameCn, nameEn, apiname: nameCn });
const todo = (key, text, checked = false) => ({ key, text, checked });

describe('normalizeText', () => {
  test('去掉加粗、转小写、<br> 变换行,但保留冒号/破折号这些分隔符', () => {
    assert.equal(normalizeText('**Taste**<br>描述在这里'), 'taste\n描述在这里');
    assert.equal(normalizeText('  位置:秘密  '), '位置:秘密');
    assert.equal(normalizeText('A  —  B'), 'a — b');
  });
});

describe('extractTitleCandidates', () => {
  test('按换行拆(Notion "标题<br>描述" 的写法)', () => {
    assert.ok(extractTitleCandidates('taste\n游戏才刚刚开始').includes('taste'));
  });

  test('按冒号拆', () => {
    assert.ok(extractTitleCandidates('位置:这个位置的秘密').includes('位置'));
  });

  test('按半角/全角破折号拆', () => {
    assert.ok(extractTitleCandidates('freedom - 逃跑成功').includes('freedom'));
    assert.ok(extractTitleCandidates('体验(taste) — 描述').includes('体验(taste)'));
  });

  test('破折号前面没有空格也要能拆(`成就名- 描述`)', () => {
    // 2026-08-10 guidelint 跑全量攻略时发现的:文明 6 这类攻略写成 `胜利！- 使用...`,
    // 破折号前不留空格。以前只按 ' - ' 拆,整行成了唯一候选,成就名提取不出来,
    // 于是这些框永远勾不上——而且不报错:audit 靠描述反查蒙混过去,
    // checkbox-sync 则表现为"没有要勾的",和"已经勾完了"分不出来。
    assert.ok(extractTitleCandidates('胜利！- 使用北条时宗获得一场常规赛胜利').includes('胜利！'));
    assert.ok(extractTitleCandidates('《物种起源》- 在加拉帕戈斯群岛附近激活达尔文').includes('《物种起源》'));
  });

  test('名字自带连字符、后面没空格的不拆(Half-Life 不能变成 Half-)', () => {
    // 拆的条件是破折号**后面跟空白**,所以复合词不会被腰斩
    const c = extractTitleCandidates('half-life 描述');
    assert.equal(c.includes('half'), false);
    assert.equal(c.includes('half-'), false);
  });

  test('"中文名(English)" 的中英文各自都算候选', () => {
    const c = extractTitleCandidates('体验(taste) — "游戏才刚刚开始……"');
    assert.ok(c.includes('体验'), '中文名应该是候选');
    assert.ok(c.includes('taste'), '英文名应该是候选');
  });

  test('攻略给成就名多写了句号,去掉句号后也算候选', () => {
    // 2026-08-10 抽查 guidelint 的残留报错时发现的:攻略写「秘密食材。」,
    // Steam 上叫「秘密食材」,精确相等因此不成立。
    const c = extractTitleCandidates('秘密食材。\n在所有隐藏关卡获得三星。');
    assert.ok(c.includes('秘密食材'), '去掉尾部句号后应该成为候选');
  });

  test('原样(带标点)仍然是候选 —— 成就名本身就带标点的不能被拆掉', () => {
    // Card Shark 的「白手起家。」、文明 6 的「胜利！」名字里本来就有标点。
    // 去标点的候选是**追加**的,原样那个必须还在,否则等于把能匹配的改成匹配不上。
    const c = extractTitleCandidates('白手起家。');
    assert.ok(c.includes('白手起家。'), '带标点的原样候选必须保留');
    assert.ok(c.includes('白手起家'), '去标点的候选也要有');
  });

  test('去标点的候选排在原样后面(优先命中精确的那个)', () => {
    const c = extractTitleCandidates('胜利！');
    assert.ok(c.indexOf('胜利！') < c.indexOf('胜利'), '原样候选必须排在前面');
  });

  test('全是标点的行不会产出空候选', () => {
    assert.equal(extractTitleCandidates('。。。').includes(''), false);
  });

  test('句中的标点不受影响(只去尾部)', () => {
    const c = extractTitleCandidates('说到底,还是要氪。');
    assert.ok(c.includes('说到底,还是要氪'), '尾部句号该去掉');
    assert.equal(c.includes('说到底还是要氪'), false, '句中逗号不该动');
  });
});

describe('matchAchievements —— 精确匹配', () => {
  test('本地 markdown 常见写法能匹配上(中文名和英文名都行)', () => {
    const todos = [todo(1, '**体验**(Taste) — "游戏才刚刚开始……"')];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 1);
    assert.equal(matchAchievements([ach('', 'Taste')], todos).length, 1);
  });

  test('短成就名不会错误匹配到"以它为前缀"的另一个成就(踩过的坑)', () => {
    // "明日" 是 "明日之星" 的严格前缀:前缀匹配会勾错,精确匹配必须拒绝
    const todos = [todo(1, '**明日之星**(Rising Star) — 完成第1章')];
    assert.equal(matchAchievements([ach('明日', 'Rising')], todos).length, 0);
  });

  test('描述里出现成就名也不算匹配', () => {
    const todos = [todo(1, '**其他成就**(Other) — 解锁后可以看到体验的说明')];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 0);
  });

  test('已经勾上的 checkbox 不参与匹配', () => {
    const todos = [todo(1, '**体验**(Taste) — 描述', true)];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 0);
  });

  test('一个 checkbox 只会被一个成就认领', () => {
    const todos = [todo(1, '体验(Taste)')];
    const matches = matchAchievements([ach('体验', 'Taste'), ach('体验', 'Taste')], todos);
    assert.equal(matches.length, 1);
  });

  test('没有名字的成就(ACHIEVEMENTS 表里还没同步到)直接跳过,不会乱匹配', () => {
    assert.equal(matchAchievements([ach('', '')], [todo(1, '任何文字')]).length, 0);
  });
});

describe('本地 markdown 后端', () => {
  const dir = join(tmpdir(), 'sat-md-test');
  const file = join(dir, 'g.md');

  test('读出 checkbox、只勾指定的行、其他内容一个字不动', () => {
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
    assert.equal(after[4], '- [x] **体验**(Taste) — 描述一', '匹配的那行应该被勾上,文字保持原样');
    assert.equal(after[5], '- [ ] **自由**(Freedom) — 描述二', '没匹配的行不能动');
    assert.equal(after[8], '普通段落,不是 checkbox');

    // 幂等:再跑一次不该有任何变化
    assert.equal(applyChecks(file, [4]), 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('缩进的 checkbox 挂到上一层(parent 指向父行,和 Notion 的嵌套 to_do 对齐)', () => {
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
    assert.equal(t[0].parent, null, '顶层没有父');
    assert.equal(t[1].parent, t[0].key, '一层缩进挂到父成就');
    assert.equal(t[2].parent, t[1].key, '两层缩进挂到上一层子步骤');
    assert.equal(t[3].parent, t[0].key, '回到一层缩进,重新挂回父成就');
    assert.equal(t[4].parent, null, '下一个顶层成就不该继承前面的父');
    rmSync(dir2, { recursive: true, force: true });
  });
});

/**
 * 子步骤联动是本项目唯一"宁可多勾"的地方(见 collectSubStepTicks 的注释),
 * 所以边界必须钉死:没有"父成就确实解锁"的证据时,一个子步骤都不能勾。
 */
describe('子步骤联动勾选', () => {
  const defs = [
    { api_name: 'allTech', name_cn: '笨手笨脚', name_en: 'Butterfingers', description: '每种技术都至少失败过一次' },
  ];
  const parentText = '**笨手笨脚**\n每种技术都至少失败过一次';
  const unlocked = new Set(['allTech']);

  test('父成就这次被匹配上 → 它下面没勾的子步骤一起勾,已勾的不重复', () => {
    const todos = [
      { key: 1, text: parentText, checked: false, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
      { key: 3, text: '技巧 B', checked: true, parent: 1 },
    ];
    const matches = [{ key: 1, achievement: ach('笨手笨脚'), text: parentText, via: 'name' }];
    const subs = collectSubStepTicks(todos, matches, { defs, unlockedApiNames: unlocked });
    assert.deepEqual(subs.map((s) => s.key), [2]);
  });

  test('父成就早就勾上了、这次没有新 match → 仍然联动(否则功能对历史攻略等于没用)', () => {
    const todos = [
      { key: 1, text: parentText, checked: true, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.deepEqual(subs.map((s) => s.key), [2]);
  });

  test('父成就其实没解锁(框却勾着)→ 一个子步骤都不勾', () => {
    const todos = [
      { key: 1, text: parentText, checked: true, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: new Set() });
    assert.equal(subs.length, 0);
  });

  test('父框没勾、也不在这次 matches 里 → 没有证据,不联动', () => {
    const todos = [
      { key: 1, text: parentText, checked: false, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.equal(subs.length, 0);
  });

  test('父框反查不到唯一成就(攻略没抄描述、名字也对不上)→ 不联动', () => {
    const todos = [
      { key: 1, text: '随手写的一行说明', checked: true, parent: null },
      { key: 2, text: '技巧 A', checked: false, parent: 1 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.equal(subs.length, 0);
  });

  test('子步骤自己还有子步骤,一路往下勾', () => {
    const todos = [
      { key: 1, text: parentText, checked: true, parent: null },
      { key: 2, text: '子步骤 1', checked: false, parent: 1 },
      { key: 3, text: '子步骤 1.1', checked: false, parent: 2 },
    ];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.deepEqual(subs.map((s) => s.key).sort(), [2, 3]);
  });

  test('完全没有嵌套的老攻略:不产生任何联动勾选', () => {
    const todos = [todo(1, parentText, true), todo(2, '**另一个成就**')];
    const subs = collectSubStepTicks(todos, [], { defs, unlockedApiNames: unlocked });
    assert.equal(subs.length, 0, 'parent 全是 undefined,行为必须和以前一模一样');
  });
});

describe('Notion ID 处理', () => {
  test('从各种形状的 URL 里提取页面 ID', () => {
    const want = '1d31fee6-ab8c-4f0b-9e2a-3c4d5e6f7a8b';
    assert.equal(extractNotionPageId('https://notion.so/Title-1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b'), want);
    assert.equal(extractNotionPageId('https://notion.so/1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b?v=x'), want);
  });

  test('去重要用规范化 ID,不能比 URL 原文(slug 会变)', () => {
    const a = 'https://notion.so/Palworld-Guide-1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b';
    const b = 'https://notion.so/1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b';
    assert.equal(normalizeNotionId(a), normalizeNotionId(b));
    // slug 里的十六进制字符(Palworld 的 a/d)不能污染提取结果
    assert.equal(normalizeNotionId(a), '1d31fee6ab8c4f0b9e2a3c4d5e6f7a8b');
  });
});

describe('CSV', () => {
  test('引号包裹、字段内逗号、"" 转义、换行都能解析', () => {
    const rows = parseCsv('a,b\n"含,逗号","含""引号"\n');
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['含,逗号', '含"引号'],
    ]);
  });

  test('序列化后能原样解析回来', () => {
    const rows = [
      ['名字', '备注'],
      ['苏丹的游戏', '有,逗号和"引号"'],
    ];
    assert.deepEqual(parseCsv(toCsv(rows)), rows);
  });
});

describe('CSV 文件名识别', () => {
  test('只看工作表名,表格名里的关键词不能干扰', () => {
    // 表格叫 "Steam Achievement Tracker" 的时候,RAW DATA 的导出文件名里也有 achievement——
    // 按整个文件名匹配会把 games 数据当成 achievements 导进去,整张表变垃圾数据
    assert.equal(tabName('Steam Achievement Tracker - RAW DATA.csv'), 'rawdata');
    assert.equal(tabName('Steam Achievement Tracker - ACHIEVEMENTS.csv'), 'achievements');
    assert.equal(tabName('Steam Achievement Tracker - GUIDES.csv'), 'guides');
  });

  test('没有 " - " 分隔的文件名退回用整个名字', () => {
    assert.equal(tabName('RAW DATA.csv'), 'rawdata');
    assert.equal(tabName('guides.csv'), 'guides');
  });
});

describe('CSV 数值解析', () => {
  test('千位分隔符不能让成就数变成 null(真实数据里踩到过:1,000 个成就的游戏)', () => {
    // Sheet 导出的是显示值,所以四位数会带逗号
    const rows = parseCsv('Status,AppID,名字,完成数,成就总数,完成率\n,4164310,这是谐音梗,"1,000","1,000",100.00%\n');
    assert.equal(rows[1][3], '1,000', '解析出来还是带逗号的原文');
    // importGames 用的转换逻辑必须能吃下它 —— 这里直接验行为:导入后 total 应该是 1000
    const db = openDb(':memory:');
    const f = join(tmpdir(), 'sat-csv-comma.csv');
    writeFileSync(f, toCsv(rows));
    importGames(db, f);
    const g = getGame(db, '4164310');
    assert.equal(g.achieved, 1000);
    assert.equal(g.total, 1000);
    rmSync(f, { force: true });
  });

  test("'N/A' 要变成 has_achievements=0,而不是 total=0", () => {
    const db = openDb(':memory:');
    const f = join(tmpdir(), 'sat-csv-na.csv');
    writeFileSync(f, toCsv([
      ['Status', 'AppID', '名字', '完成数', '成就总数'],
      ['', '294100', 'RimWorld', '', 'N/A'],
    ]));
    importGames(db, f);
    const g = getGame(db, '294100');
    assert.equal(g.has_achievements, 0);
    assert.equal(g.total, null);
    rmSync(f, { force: true });
  });
});

describe('checkbox 同步的预演模式', () => {
  const dir = join(tmpdir(), 'sat-dry-test');
  const file = 'g.md';

  test('--dry-run 报告会勾哪些,但一个字节都不写', async () => {
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
    assert.equal(readFileSync(full, 'utf8'), before, '预演不能改文件');

    // 去掉 dryRun 之后才真的写
    const real = await syncGameCheckboxes(db, steam, guide, 'G', { notion: null, config });
    assert.match(real[0].result, /^已勾选/);
    assert.match(readFileSync(full, 'utf8'), /- \[x\] \*\*体验\*\*/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('同名成就(真实数据里踩到的:鬼谷八荒)', () => {
  // 《鬼谷八荒》有两个成就中英文名完全一样:妙手空空 / Skilled Thief
  //   ACHIEVEMENT_160101 = 隐秘偷窃10次   → 已解锁
  //   ACHIEVEMENT_300020 = 通关且偷窃100次 → 没解锁
  // 已解锁那个的 checkbox 早就被勾上、退出了待匹配池,于是同一个名字会去匹配
  // 另一个**还没解锁**的 checkbox —— 勾错。精确匹配挡不住完全同名。
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

  test('只解锁了同名成就中的一个 → 整个名字放弃,绝不勾另一个', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_160101']));
    assert.ok(unsafe.has('妙手空空'), '中文名应该被判为不安全');
    assert.ok(unsafe.has('skilled thief'), '英文名也应该被判为不安全');
    const m = matchAchievements(unlockedOne, todos, { unsafeNames: unsafe });
    assert.equal(m.length, 0, '不能勾任何 checkbox');
    // 已解锁那个的框(隐秘10次版)本来就勾着 → 该勾的已经勾够了,不用提醒。
    // 每次跑都报一条"需人工核对"而其实无事可做,只会让人以后不看日志。
    assert.equal(m.skippedAmbiguous.length, 0, '这一组已经满足了,应该静默');
  });

  test('同名成就一个都还没勾 → 要报告,不能静默', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_160101']));
    const noneTicked = todos.map((t) => ({ ...t, checked: false }));
    const m = matchAchievements(unlockedOne, noneTicked, { unsafeNames: unsafe });
    assert.equal(m.length, 0, '还是不能瞎勾');
    assert.equal(m.skippedAmbiguous.length, 1, '解锁了却一个框都没勾 → 该提醒');
  });

  test('同名成就全部解锁 → 怎么配都对,照常匹配', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_160101', 'ACHIEVEMENT_300020']));
    assert.equal(unsafe.size, 0);
    const both = [...unlockedOne, { apiname: 'ACHIEVEMENT_300020', nameCn: '妙手空空', nameEn: 'Skilled Thief' }];
    assert.equal(matchAchievements(both, todos, { unsafeNames: unsafe }).length, 1);
  });

  test('名字唯一的成就不受影响', () => {
    const db = seed();
    const unsafe = findAmbiguousNames(db, '1468810', new Set(['ACHIEVEMENT_OTHER']));
    assert.ok(!unsafe.has('一鸣惊人'));
  });
});

describe('审计:把 checkbox 反查到具体成就', () => {
  const def = (api, cn, en, desc) => ({ api_name: api, name_cn: cn, name_en: en, description: desc });

  // 系列成就:描述开头完全一样,只有数字不同。这是"按前缀匹配"翻车的地方
  const TIERED = [
    def('DMG_1', '牛刀小试', 'Damage1', '不触发天命特效，单发攻击造成100点伤害'),
    def('DMG_2', '威力一击', 'Damage2', '不触发天命特效，单发攻击造成500点伤害'),
    def('DMG_3', '致命一击', 'Damage3', '不触发天命特效，单发攻击造成1000点伤害'),
  ];

  test('系列成就:低档位的框要对到低档位,不能对到还没解锁的高档位', () => {
    // 真实事故:审计用"描述前 14 字"匹配,把这个正确勾上的 100 点档
    // 算到了 500 点档头上,凭空报出一个假的"勾错"
    const hit = resolveTodoToAchievement('牛刀小试 不触发天命特效，单发攻击造成100点伤害', TIERED);
    assert.equal(hit?.def.api_name, 'DMG_1');
  });

  test('系列成就:每一档都能各自对上', () => {
    for (const [text, want] of [
      ['威力一击 不触发天命特效，单发攻击造成500点伤害', 'DMG_2'],
      ['致命一击 不触发天命特效，单发攻击造成1000点伤害', 'DMG_3'],
    ]) {
      assert.equal(resolveTodoToAchievement(text, TIERED)?.def.api_name, want);
    }
  });

  test('描述抄了原文 → 按描述对上(最可信的那一层)', () => {
    const hit = resolveTodoToAchievement('新年快乐：在打特定怪物的战斗中，投掷爆竹作为最后一击。补充说明若干', [
      def('ach_241', '新年快乐', 'Happy New Year', '在打特定怪物的战斗中，投掷爆竹作为最后一击。'),
    ]);
    assert.equal(hit?.def.api_name, 'ach_241');
    assert.equal(hit?.via, 'description');
  });

  test('攻略把描述改写过 → 退回按名字对,名字唯一才算', () => {
    const defs = [def('A', '隐秘大师', 'Sneaky', '在不被发现的情况下完成整个章节')];
    const hit = resolveTodoToAchievement('隐秘大师(Sneaky) — 全程别被看见', defs);
    assert.equal(hit?.def.api_name, 'A');
    assert.equal(hit?.via, 'name');
  });

  test('同名成就 → 不下结论(返回 null),不能猜', () => {
    const defs = [
      def('A', '妙手空空', 'Skilled Thief', '偷窃10次'),
      def('B', '妙手空空', 'Skilled Thief', '通关且偷窃100次'),
    ];
    assert.equal(resolveTodoToAchievement('妙手空空·通关100次版(Skilled Thief)', defs), null);
  });

  test('两个成就描述一模一样 → 也不下结论', () => {
    const defs = [def('A', '甲', 'A', '做同一件事'), def('B', '乙', 'B', '做同一件事')];
    assert.equal(resolveTodoToAchievement('随便什么 做同一件事', defs), null);
  });

  test('完全对不上的文字 → null', () => {
    assert.equal(resolveTodoToAchievement('这一行只是章节标题', TIERED), null);
  });
});

/**
 * Dashboard 展开一行时,每条还没解锁的成就下面要显示"你自己攻略里是怎么写的"。
 *
 * 这些用例守的都是**不会报错的**失败:贴错成就的打法、同一段文字在两张卡片上重复
 * 出现、以及为了让卡片别空着而把匹配放松掉。最后一条尤其要钉住 —— 这里"只是显示",
 * 松匹配的诱惑比写勾那条路径大得多,而两边共用同一个 resolveTodoToAchievement。
 */
describe('攻略反查:成就 → 攻略里那一条', () => {
  const def = (api, cn, en, desc) => ({ api_name: api, name_cn: cn, name_en: en, description: desc });
  const todo = (key, text, { checked = false, parent = null } = {}) => ({ key, text, checked, parent });

  const DEFS = [
    def('A', '隐秘大师', 'Sneaky', '在不被发现的情况下完成整个章节'),
    def('B', '收藏家', 'Collector', '集齐全部藏品'),
  ];

  test('匹配上的框:正文原样带出来,那就是卡片上要显示的解法', () => {
    const map = mapAchievementGuides(
      [todo('k1', '隐秘大师\n在不被发现的情况下完成整个章节\n走右边水道，别开灯')],
      DEFS
    );
    assert.equal(map.get('A').text, '隐秘大师\n在不被发现的情况下完成整个章节\n走右边水道，别开灯');
    assert.equal(map.get('A').key, 'k1');
  });

  test('挂在成就下面的子步骤跟着一起走,嵌套深度保留下来', () => {
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

  test('子步骤自己就是另一个成就的框 → 不算上一条的子步骤', () => {
    // 不排掉的话,同一段文字会在两张卡片上各出现一次,而且其中一次归错了成就
    const map = mapAchievementGuides([
      todo('k1', '收藏家 集齐全部藏品'),
      todo('k2', '隐秘大师 在不被发现的情况下完成整个章节', { parent: 'k1' }),
    ], DEFS);
    assert.deepEqual(map.get('B').subSteps, []);
    assert.equal(map.get('A').key, 'k2');
  });

  test('同名成就 → 这条成就没有条目,卡片留白,绝不挑一个贴上去', () => {
    const dup = [
      def('X', '妙手空空', 'Skilled Thief', '偷窃10次'),
      def('Y', '妙手空空', 'Skilled Thief', '通关且偷窃100次'),
    ];
    const map = mapAchievementGuides([todo('k1', '妙手空空 随便写点什么')], dup);
    assert.equal(map.size, 0);
  });

  test('一个成就在攻略里被提到两次 → 只认第一条', () => {
    const first = todo('k1', '隐秘大师 在不被发现的情况下完成整个章节');
    const again = todo('k9', '隐秘大师 — 另一处顺带提了一句');
    // 先确认两条**都真的**反查得到 A —— 否则这个用例会在"第二条压根没匹配上"
    // 的情况下自动通过,那就什么都没钉住(变异测试抓到过这个空转版本)
    assert.equal(resolveTodoToAchievement(again.text, DEFS)?.def.api_name, 'A');
    const map = mapAchievementGuides([first, again], DEFS);
    assert.equal(map.get('A').key, 'k1');
  });

  test('整份攻略一个框都对不上 → 空 Map,不是抛错', () => {
    const map = mapAchievementGuides([todo('k1', '第一章:开场'), todo('k2', '第二章:结局')], DEFS);
    assert.equal(map.size, 0);
  });
});

/**
 * 卡片上方已经有成就名和描述,攻略正文开头的复述要削掉。
 *
 * 这一组里**大半是"必须不删"**:删掉一行用户自己写的东西是拿不回来的,而留一行
 * 只是啰嗦。松紧的不对称就是这个判据的全部理由,所以反例比正例更值得钉住。
 */
describe('削掉攻略开头对成就名/描述的复述', () => {
  const NAMES = ['隐秘大师', 'Sneaky'];
  const DESC = '在不被发现的情况下完成整个章节';

  test('名字 + 逐字描述 + 打法 → 只留打法', () => {
    const out = stripGuideEcho('隐秘大师\n在不被发现的情况下完成整个章节\n走右边水道，别开灯',
      { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道，别开灯');
  });

  test('`中文名(English)` 那种写法也认', () => {
    const out = stripGuideEcho('隐秘大师(Sneaky)\n走右边水道', { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道');
  });

  test('`**加粗**` 的名字照样认(markdown 后端)', () => {
    const out = stripGuideEcho('**隐秘大师**\n走右边水道', { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道');
  });

  test('描述被改写过 → 留着,那是用户自己的话', () => {
    const text = '隐秘大师\n全程不能被任何人看到\n走右边水道';
    assert.equal(stripGuideEcho(text, { names: NAMES, description: DESC }),
      '全程不能被任何人看到\n走右边水道');
  });

  test('隐藏成就:Steam 没有描述 → 一行都不能多删', () => {
    // 这行"处理酸奶丢失的情况"是全卡片唯一写着达成条件的地方,Steam 那边是空的
    const out = stripGuideEcho('夏洛克家\n处理酸奶丢失的情况。',
      { names: ['夏洛克家'], description: '' });
    assert.equal(out, '处理酸奶丢失的情况。');
  });

  test('名字只是开头、后面还有正文 → 整行不动', () => {
    // extractTitleCandidates 会从这行切出「知识」,照那个删就把整条打法删没了。
    // **必须再挂一行正文**:只有这一行的话,删过头会让 rest 变空、兜底原样返回,
    // 这条用例就永远是绿的——变异测试抓到过它的空转版本
    const head = '知识(Rationality) — "知识让我们知道自己依旧不知道。" 集齐全部百科全书条目';
    const text = head + '\n先去图书馆把三轮问答刷完';
    assert.equal(stripGuideEcho(text, { names: ['知识', 'Rationality'], description: '知识让我们知道自己依旧不知道。' }),
      text);
  });

  test('复述夹在中间而不是开头 → 不碰', () => {
    const text = '先做支线\n隐秘大师\n再回主线';
    assert.equal(stripGuideEcho(text, { names: NAMES, description: DESC }), text);
  });

  test('整条攻略只有名字和描述 → 空串,让调用方别画窗口', () => {
    // 原样吐回来的话,这种"只抄了官方文案"的条目反而是重复得最彻底的一张卡片
    const text = '隐秘大师\n在不被发现的情况下完成整个章节';
    assert.equal(stripGuideEcho(text, { names: NAMES, description: DESC }), '');
  });

  test('结尾句读的差别不该挡住描述的匹配', () => {
    const out = stripGuideEcho('隐秘大师\n在不被发现的情况下完成整个章节。\n走右边水道',
      { names: NAMES, description: DESC });
    assert.equal(out, '走右边水道');
  });
});

describe('同名成就:攻略抄了描述原文就能救回来', () => {
  // 同一个游戏两个成就名字完全一样,只有描述不同。
  // 只靠名字永远分不出来(见上面的 findAmbiguousNames),但如果 checkbox 里抄了
  // 完整的官方描述,框指的是哪个成就就没有二义性了。
  const DEFS = [
    { api_name: 'A', name_cn: '妙手空空', name_en: 'Skilled Thief', description: '偷窃10次且未被察觉' },
    { api_name: 'B', name_cn: '妙手空空', name_en: 'Skilled Thief', description: '通关且成功偷窃100次' },
  ];
  const unsafe = new Set(['妙手空空', 'skilled thief']);
  const unlockedA = [{ apiname: 'A', nameCn: '妙手空空', nameEn: 'Skilled Thief' }];

  test('抄了描述原文 → 勾中正确的那个框,不碰另一个', () => {
    const todos = [
      { key: 1, text: '**妙手空空**<br>偷窃10次且未被察觉<br>提示:开局就能做', checked: false },
      { key: 2, text: '**妙手空空**<br>通关且成功偷窃100次<br>提示:要二周目', checked: false },
    ];
    const m = matchAchievements(unlockedA, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m[0].key, 1, '应该勾解锁了的那个(A=偷窃10次),不是还没解锁的 B');
    assert.equal(m[0].via, 'description');
    assert.equal(m.skippedAmbiguous.length, 0);
  });

  test('只改写、没抄描述原文 → 仍然放弃,不猜', () => {
    const todos = [
      { key: 1, text: '**妙手空空·隐秘10次版**(偷偷摸摸拿十次东西)', checked: false },
      { key: 2, text: '**妙手空空·通关100次版**(打完再拿一百次)', checked: false },
    ];
    const m = matchAchievements(unlockedA, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 0);
    assert.equal(m.skippedAmbiguous.length, 1);
  });

  test('已解锁那个的框早就勾上了 → 不会去勾另一个还没解锁的', () => {
    const todos = [
      { key: 1, text: '**妙手空空**<br>偷窃10次且未被察觉', checked: true },
      { key: 2, text: '**妙手空空**<br>通关且成功偷窃100次', checked: false },
    ];
    const m = matchAchievements(unlockedA, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 0, '这才是最初那个 bug 的核心场景,必须一个都不勾');
  });

  test('名字唯一的成就不受第一遍影响,照旧按名字匹配', () => {
    const defs = [...DEFS, { api_name: 'C', name_cn: '一鸣惊人', name_en: 'Debut', description: '首次出场' }];
    const todos = [{ key: 9, text: '**一鸣惊人**(Debut) — 首次出场', checked: false }];
    const m = matchAchievements([{ apiname: 'C', nameCn: '一鸣惊人', nameEn: 'Debut' }], todos, {
      unsafeNames: unsafe, defs,
    });
    assert.equal(m.length, 1);
    assert.equal(m[0].via, 'name');
  });
});

describe('撞名闸门按名字关,不按成就关', () => {
  // 全库 12 款撞名游戏里有 9 款**只撞一种语言** —— 是 Steam 本地化写错了,原名分得开。
  // 以前只要有一种语言撞车,整个成就就被赶进"只能靠描述"那一趟,另一种语言里那个
  // 完全唯一的名字白白浪费掉。分不出双胞胎的是**名字**,不是成就。
  //
  // 放宽的只有"别把唯一的名字一起扔掉"这一点;等值匹配本身一个字没动:
  // 仍然要求完全相等,仍然不许子串、不许前缀,撞车的那个名字仍然一个都不许用。
  const DEFS = [
    { api_name: 'NANO', name_cn: '生化武器大师', name_en: 'Nano-Virus Master', description: '在终极困难模式下打败纳米病毒大师!' },
    { api_name: 'BIO', name_cn: '生化武器大师', name_en: 'Bioweapon Master', description: '在终极困难模式下打败生化武器大师!' },
  ];
  const unsafe = new Set(['生化武器大师']); // 只有中文撞车
  const nano = [{ apiname: 'NANO', nameCn: '生化武器大师', nameEn: 'Nano-Virus Master' }];

  test('中文撞车、英文唯一 → 靠英文名勾上,而且不碰双胞胎的框', () => {
    const todos = [
      { key: 1, text: '生化武器大师(Nano-Virus Master)', checked: false },
      { key: 2, text: '生化武器大师(Bioweapon Master)', checked: false },
    ];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m[0].key, 1, '只能勾英文名对得上的那个');
    assert.equal(m[0].via, 'name');
  });

  test('撞车的那个名字仍然一个都不许用', () => {
    const todos = [{ key: 1, text: '生化武器大师', checked: false }];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 0, '框里只有撞名的那个名字 → 分不出是哪个,必须放弃');
  });

  test('靠没撞车的名字救回来的,不算"跳过" —— 不能报假警', () => {
    const todos = [{ key: 1, text: '生化武器大师(Nano-Virus Master)', checked: false }];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m.skippedAmbiguous.length, 0, '配上了就不该再报"需人工核对"');
  });

  test('反过来一样:英文撞车、中文唯一(犹格索托斯的庭院的 "Text" 占位符)', () => {
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

  test('两种语言都撞 → 照旧只能靠描述,真同名一点都不放宽', () => {
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

  test('描述仍然优先于名字:两条路都通时走描述', () => {
    const todos = [
      { key: 1, text: '生化武器大师(Nano-Virus Master)\n在终极困难模式下打败纳米病毒大师!', checked: false },
    ];
    const m = matchAchievements(nano, todos, { unsafeNames: unsafe, defs: DEFS });
    assert.equal(m.length, 1);
    assert.equal(m[0].via, 'description', '第一遍先跑 —— 描述比名字精确');
  });
});

// ---------------------------------------------------------------------------
// 换行风格
// ---------------------------------------------------------------------------

describe('CRLF 的本地攻略必须照常工作', () => {

  test('CRLF 文件读得出 checkbox —— 这是个静默失败,两个工具都不报错', () => {
    // 踩过(2026-08-10):Windows 上的编辑器默认写 CRLF。原来是 split('\n'),
    // 行尾剩一个 \r,而 JS 正则里 `.` **不匹配 \r**(它算行终止符),
    // 于是 `(.*)$` 匹配不上,整份攻略读出 0 个 checkbox。
    // 表现是 checkbox-sync 一个框都不勾、guide-lint 报"所有成就都缺 checkbox",
    // **两边都不报错**,看起来就像攻略写错了
    const dir = mkdtempSync(join(tmpdir(), 'crlf-'));
    const p = join(dir, 'g.md');
    writeFileSync(p, '# 游戏\r\n\r\nappid: 1\r\n\r\n- [ ] **第一步**<br>描述\r\n  - [ ] 子步骤\r\n');
    const todos = loadTodos(p);
    assert.equal(todos.length, 2);
    assert.equal(todos[0].text, '**第一步**<br>描述');
    assert.equal(todos[1].parent, todos[0].key, '缩进层级也要认得出来');
  });

  test('打勾之后保持原来的换行风格(不要把整个文件改成 LF)', () => {
    // 顺手全文改成 LF 会让 git diff 变成"每一行都改了",真正的改动淹没在里面
    const dir = mkdtempSync(join(tmpdir(), 'crlf-'));
    const p = join(dir, 'g.md');
    writeFileSync(p, '- [ ] **甲**\r\n- [ ] **乙**\r\n');
    applyChecks(p, [0]);
    const after = readFileSync(p, 'utf8');
    assert.match(after, /^- \[x\] \*\*甲\*\*\r\n/, '该勾的勾上了');
    assert.ok(!/[^\r]\n/.test(after), '不能混进裸 LF');
  });
});
