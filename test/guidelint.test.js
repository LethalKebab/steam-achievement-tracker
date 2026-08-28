/**
 * 攻略校验器的回归测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的失败类是**误报**。校验器将来要给 AI 生成的攻略当闸门,过不了就不落盘;
 * 一条会误报的规则,轻则把好攻略拦在外面,重则让人开始无视校验结果——那时它就等于不存在。
 * 所以这里除了"该报的报得出来",更要紧的是那几条"看起来该报、其实不该报"的:
 * 同名成就的框是存在的(只是名字认不出)、子步骤不是成就、描述空的成就无解但不是攻略的错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintGuide, computeCheckedKeys } from '../lib/guidelint.js';

/** 造一个成就定义,字段名和 achievements 表一致 */
const def = (apiName, nameCn, description = '', nameEn = '') => ({
  api_name: apiName,
  name_cn: nameCn,
  name_en: nameEn,
  description,
});
const todo = (key, text, checked = false, parent = null) => ({ key, text, checked, parent });

const codesOf = (r) => r.findings.map((f) => f.code);

describe('缺 checkbox', () => {
  test('成就没有对应的框 → error', () => {
    const r = lintGuide({
      defs: [def('A', '第一步'), def('B', '第二步')],
      todos: [todo(1, '**第一步**')],
    });
    assert.equal(r.ok, false);
    assert.deepEqual(codesOf(r), ['missing-checkbox']);
    assert.equal(r.findings[0].name, '第二步');
  });

  test('全都有框 → 通过', () => {
    const r = lintGuide({
      defs: [def('A', '第一步'), def('B', '第二步')],
      todos: [todo(1, '**第一步**'), todo(2, '**第二步**')],
    });
    assert.equal(r.ok, true);
    assert.equal(r.stats.covered, 2);
  });

  test('英文名也算数(游戏没中文时成就名保留英文)', () => {
    const r = lintGuide({
      defs: [def('A', '', '', 'First Blood')],
      todos: [todo(1, '**First Blood**<br>拿到第一滴血')],
    });
    assert.equal(r.ok, true);
  });

  test('名字后面跟着描述和心得照样能对上(SKILL.md 规则 3.1 的三段式)', () => {
    const r = lintGuide({
      defs: [def('A', '妙手空空', '偷窃十次')],
      todos: [todo(1, '**妙手空空**<br>偷窃十次<br>开局就能做,别等')],
    });
    assert.equal(r.ok, true);
  });
});

describe('合并行', () => {
  test('一行里两个 checkbox → error', () => {
    const r = lintGuide({
      defs: [def('A', 'A成就'), def('B', 'B成就')],
      todos: [todo(1, '**A成就** / [x] **B成就**')],
    });
    assert.ok(codesOf(r).includes('merged-line'));
  });

  test('正文里出现方括号但不是 checkbox → 不报', () => {
    const r = lintGuide({
      defs: [def('A', 'A成就')],
      todos: [todo(1, '**A成就**<br>参考 [攻略链接](http://x) 里的做法')],
    });
    assert.equal(codesOf(r).includes('merged-line'), false);
  });
});

describe('同名成就', () => {
  const twins = [
    def('A1', '妙手空空', '成功偷窃了其他修仙者的物品10次,并且尚未被察觉。'),
    def('A2', '妙手空空', '通关且成功偷窃其他修仙者100次'),
  ];

  test('抄了描述原文 → 通过,且不误报缺 checkbox', () => {
    const r = lintGuide({
      defs: twins,
      todos: [
        todo(1, '**妙手空空**<br>成功偷窃了其他修仙者的物品10次,并且尚未被察觉。'),
        todo(2, '**妙手空空**<br>通关且成功偷窃其他修仙者100次'),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
  });

  test('没抄描述 → 报同名歧义,但**不**报缺 checkbox(框是存在的)', () => {
    const r = lintGuide({
      defs: twins,
      todos: [todo(1, '**妙手空空**'), todo(2, '**妙手空空**')],
    });
    assert.equal(codesOf(r).includes('missing-checkbox'), false, '框存在,不该报缺失');
    assert.equal(r.findings.filter((f) => f.code === 'ambiguous-no-description').length, 2);
  });

  test('Steam 上描述本身是空的 → 换一个 code,因为这一种谁都修不了', () => {
    // 原来两种共用 `ambiguous-no-description`,区别只挂在一个 `fixable` 布尔字段上,
    // 而那个字段**算出来了却没有任何生产代码读它** —— 这条测试当初就只断言它被设上了。
    // 结果是一份 197/197 全覆盖的攻略被 15 条谁都改不动的错误拦掉,还先花三轮让模型
    // 去抄不存在的描述(KINGDOM HEARTS -HD 1.5+2.5 ReMIX-,四合一合集)。
    // 现在按 code 分,而 code 是这个项目里唯一用来分流"能不能补救"的东西
    const r = lintGuide({
      defs: [def('P1', 'Pilgrimage', ''), def('P2', 'Pilgrimage', '')],
      todos: [todo(1, '**Pilgrimage**'), todo(2, '**Pilgrimage**')],
    });
    assert.equal(r.findings.filter((f) => f.code === 'ambiguous-empty-description').length, 2);
    assert.equal(
      r.findings.filter((f) => f.code === 'ambiguous-no-description').length, 0,
      '描述是空的不该再报成"没抄描述" —— 那句话在要求一件做不到的事'
    );
    // 消息里不能留一句"不是攻略的错"却又把人拦在门外。它现在只陈述后果
    const f = r.findings.find((x) => x.code === 'ambiguous-empty-description');
    assert.match(f.message, /注定同步不上/);
    assert.match(f.message, /不是攻略能修的/);
  });

  test('报出来的名字用 Steam 上那个写法,不是归一化之后的索引键', () => {
    // 索引键过了 normalizeText(小写、去标点),照着念是 `proud player`,而用户在 Steam 上
    // 看到的是 `Proud Player`。实测在弹窗里就是小写的,读着像另一个成就
    const r = lintGuide({
      defs: [def('A1', 'Proud Player', ''), def('A2', 'Proud Player', '')],
      todos: [todo(1, '**Proud Player**'), todo(2, '**Proud Player**')],
    });
    const f = r.findings.find((x) => x.code === 'ambiguous-empty-description');
    assert.match(f.message, /Proud Player/);
    assert.equal(f.name, 'Proud Player');
  });

  test('只有中文名撞名、英文名不同 → 英文名那侧照常能覆盖', () => {
    const r = lintGuide({
      defs: [
        def('N1', '大师', '甲的描述', 'Nano-Virus Master'),
        def('N2', '大师', '乙的描述', 'Bioweapon Master'),
      ],
      todos: [
        todo(1, '**Nano-Virus Master**<br>甲的描述'),
        todo(2, '**Bioweapon Master**<br>乙的描述'),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
  });
});

describe('描述原文', () => {
  test('改写过的描述 → warn,不是 error(还能靠名字勾上,只是 audit 反查不了)', () => {
    const r = lintGuide({
      defs: [def('A', '妙手空空', '成功偷窃了其他修仙者的物品10次,并且尚未被察觉。')],
      todos: [todo(1, '**妙手空空**<br>隐秘偷窃10次')],
    });
    assert.deepEqual(codesOf(r), ['paraphrased-description']);
    assert.equal(r.ok, true, 'warn 不该让整份攻略不通过');
  });

  test('空白差异不算改写(和 resolveTodoToAchievement 的判据一致)', () => {
    const r = lintGuide({
      defs: [def('A', 'X', '偷窃 十次')],
      todos: [todo(1, '**X**<br>偷窃十次')],
    });
    assert.equal(codesOf(r).includes('paraphrased-description'), false);
  });

  test('缺 checkbox 的成就不重复报描述问题', () => {
    const r = lintGuide({
      defs: [def('A', '没写进攻略的成就', '某个描述')],
      todos: [],
    });
    assert.deepEqual(codesOf(r), ['missing-checkbox']);
  });
});

describe('勾选状态', () => {
  test('已解锁但没勾 → error', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**', false)],
      unlockedApiNames: new Set(['A']),
    });
    assert.ok(codesOf(r).includes('checked-mismatch'));
  });

  test('没解锁却勾上了 → error', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**', true)],
      unlockedApiNames: new Set(),
    });
    assert.ok(codesOf(r).includes('checked-mismatch'));
  });

  test('不给解锁数据就整条跳过,不猜', () => {
    const r = lintGuide({ defs: [def('A', 'X')], todos: [todo(1, '**X**', true)] });
    assert.equal(codesOf(r).includes('checked-mismatch'), false);
  });
});

describe('只有本地 markdown 能验的几条', () => {
  test('本地攻略缺 `# 游戏名` → error', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: 'appid: 123\n\n## 一、店铺日常\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.ok(codesOf(r).includes('missing-title'));
  });

  test('有 `# 游戏名` → 通过', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: '# 苏丹的游戏\n\nappid: 123\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.equal(r.ok, true);
  });

  test('Notion 攻略不要求 `# 标题`(名字来自 title 属性)', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: 'appid: 123\n\n- [ ] **X**',
      kind: 'notion',
    });
    assert.equal(codesOf(r).includes('missing-title'), false);
  });

  test('节标题里的统计数字 → warn', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: '# 游戏\n\n## 收集类(共 39 个)\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.ok(codesOf(r).includes('stats-in-heading'));
  });

  test('数据来源说明 → warn', () => {
    const r = lintGuide({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**')],
      text: '# 游戏\n\n勾选状态来自 Steam 真实解锁数据。\n\n- [ ] **X**',
      kind: 'local',
    });
    assert.ok(codesOf(r).includes('data-source-note'));
  });

  test('不给全文就跳过这几条,而不是当成缺失来报', () => {
    const r = lintGuide({ defs: [def('A', 'X')], todos: [todo(1, '**X**')], kind: 'local' });
    assert.equal(codesOf(r).includes('missing-title'), false);
  });
});

describe('子步骤', () => {
  test('嵌套的子步骤不是成就,不该被当成多余内容报错', () => {
    const r = lintGuide({
      defs: [def('A', '水火不容', '完成所有差事')],
      todos: [
        todo(1, '**水火不容**<br>完成所有差事'),
        todo(2, '1.【二手灵魂】:第一次水位下降后', false, 1),
        todo(3, '2.【法夫纳的宝藏】:离开精灵国时', false, 1),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.equal(r.findings.length, 0);
  });
});

describe('computeCheckedKeys(机械打勾)', () => {
  test('已解锁的成就 → 该勾', () => {
    const keys = computeCheckedKeys({
      defs: [def('A', 'X'), def('B', 'Y')],
      todos: [todo(1, '**X**'), todo(2, '**Y**')],
      unlockedApiNames: new Set(['A']),
    });
    assert.deepEqual(keys, [1]);
  });

  test('已经勾上的不重复返回(同步只勾不取消)', () => {
    const keys = computeCheckedKeys({
      defs: [def('A', 'X')],
      todos: [todo(1, '**X**', true)],
      unlockedApiNames: new Set(['A']),
    });
    assert.deepEqual(keys, []);
  });

  test('同名成就一律不打勾——分不清是哪一个,宁可漏勾也不能勾错', () => {
    const keys = computeCheckedKeys({
      defs: [def('A1', '妙手空空', '甲'), def('A2', '妙手空空', '乙')],
      todos: [todo(1, '**妙手空空**<br>甲'), todo(2, '**妙手空空**<br>乙')],
      unlockedApiNames: new Set(['A1']),
    });
    assert.deepEqual(keys, []);
  });

  test('子步骤不会被误勾(名字对不上任何成就)', () => {
    const keys = computeCheckedKeys({
      defs: [def('A', '水火不容')],
      todos: [todo(1, '**水火不容**'), todo(2, '1.【二手灵魂】', false, 1)],
      unlockedApiNames: new Set(['A']),
    });
    assert.deepEqual(keys, [1]);
  });
});

// 上面那条查的是「每个成就都有框」,查不到「每个顶层框都是成就」。
// 《破晓传奇》生成完报的是「覆盖 58/58,0 条 warn」，而页面上有 70 个顶层
// checkbox —— 多出来的 12 个是该嵌套却写成顶层的子步骤,它们永远勾不上。
test('顶层 checkbox 认不出成就就报出来,嵌套的子步骤不算', () => {
  const defs = [{ api_name: 'A', name_cn: '聊不完的话题', name_en: '', description: 'd', game_name: 'g', hidden: 0, icon: '' }];
  const todos = [
    { key: 0, text: '聊不完的话题\nd', checked: false, parent: null },
    { key: 1, text: '「回归自我」', checked: false, parent: null },
    { key: 2, text: '某个子步骤', checked: false, parent: 0 },
  ];
  const codes = lintGuide({ todos, defs, kind: 'notion' }).findings.map((f) => f.code);
  assert.deepEqual(codes, ['orphan-todo'], '只该报那一条孤儿顶层框');
  // **嵌套的子步骤是合法的**,报它会把每份带子步骤的攻略都洗成一片 warn
  assert.ok(!codes.includes('orphan-todo') || todos[2].parent === 0);
});

// **它们和真孤儿在 `parent` 上长得一模一样。**
// 顶层折叠（规则五的长清单）里的条目，`fetchAllToDoBlocks` 把容器当透明的、
// `parent` 原样往下传，于是也是 `null` —— 光看 `parent` 分不出来。
// 实测踩过：《破晓传奇》的 38 条猫头鹰位置被全部误报成孤儿，
// **38 条假警报比没有检查更糟** —— 它会训练人忽略 warn。
test('折叠里的 checkbox 不算孤儿，两个后端要给同一个答案', () => {
  const defs = [{ api_name: 'A', name_cn: '聊不完的话题', name_en: '', description: 'd', game_name: 'g', hidden: 0, icon: '' }];
  const mk = (key, text, container) => ({ key, text, checked: false, parent: null, container });

  // Notion：靠 `container` 标记
  const notion = lintGuide({
    todos: [mk(0, '聊不完的话题', false), mk(1, '折叠里的位置', true), mk(2, '「回归自我」', false)],
    defs, kind: 'notion',
  }).findings.filter((f) => f.code === 'orphan-todo');
  assert.equal(notion.length, 1, '只该报那一条真孤儿');
  assert.match(notion[0].message, /「回归自我」/);

  // 本地 md：只有文本，靠行号算哪些夹在 <details> 里
  const text = [
    '- [ ] 聊不完的话题',
    '<details>',
    '<summary>位置一览</summary>',
    '- [ ] 折叠里的位置',
    '</details>',
    '- [ ] 「回归自我」',
  ].join('\n');
  const local = lintGuide({
    todos: [mk(0, '聊不完的话题'), mk(3, '折叠里的位置'), mk(5, '「回归自我」')],
    defs, text, kind: 'local',
  }).findings.filter((f) => f.code === 'orphan-todo');
  assert.equal(local.length, 1, '本地也只该报一条 —— 两个后端结论不一样就是 bug');
  assert.match(local[0].message, /「回归自我」/);
});
