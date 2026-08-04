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
import { parseCsv, toCsv } from '../lib/csv.js';
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
