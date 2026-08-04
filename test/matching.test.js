/**
 * 成就名 ↔ checkbox 匹配规则的回归测试
 * ------------------------------------------------
 * 跑法:node --test(零依赖,用 Node 内置的 node:test)
 *
 * 这里锁住的是整个项目最容易被"顺手放宽一下"改坏的地方:匹配必须**精确**。
 * 原版就踩过一次坑——用前缀匹配的时候,一个短成就名可能是另一个更难的、
 * 实际还没解锁的成就名的前缀,结果勾错了 checkbox。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeText, extractTitleCandidates, matchAchievements } from '../lib/guides.js';
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

  test('"中文名(English)" 的中英文各自都算候选', () => {
    const c = extractTitleCandidates('体验(taste) — "游戏才刚刚开始……"');
    assert.ok(c.includes('体验'), '中文名应该是候选');
    assert.ok(c.includes('taste'), '英文名应该是候选');
  });
});

describe('matchAchievements —— 精确匹配', () => {
  test('本地 markdown 常见写法能匹配上(中文名和英文名都行)', () => {
    const todos = [todo(1, '**体验**(Taste) — "游戏才刚刚开始……"')];
    assert.equal(matchAchievements([ach('体验', 'Taste')], todos).length, 1);
    assert.equal(matchAchievements([ach('', 'Taste')], todos).length, 1);
  });

  test('短成就名不会错误匹配到"以它为前缀"的另一个成就(原版踩过的坑)', () => {
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
  test('只看标签页名,表格名里的关键词不能干扰', () => {
    // 表格叫 "Steam Achievement Tracker" 的时候,RAW DATA 的导出文件名里也有 achievement——
    // 按整个文件名匹配会把 games 表当成 achievements 表导进去,整张表变垃圾数据
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
