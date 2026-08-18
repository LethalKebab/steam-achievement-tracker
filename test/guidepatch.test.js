/**
 * 局部重写(`guide-gen --only`)的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的失败类是**在用户没点名的地方动了字**。
 *
 * 那是局部重写独有的、也是最坏的一种失败:整篇重写写差了至少看得出来(内容全换了,
 * 你本来就要读一遍),而局部重写多改了一条、少改了一条、或者把 A 的打法贴到 B 头上,
 * **攻略看起来是完整的**,没有任何机器会报错,而被顶掉的那一段可能正是用户自己手改过的。
 *
 * 所以这里的断言几乎全是「什么**没有**变」:
 *
 *  - **点名之外的每一个字节逐字不变**。不是"差不多"、不是"行数一样",是逐行相等
 *  - **区间不多吃一行**:紧跟在成就后面的 `<details>`、表格、小节说明都不属于它
 *  - **模型多写的一律不应用**。保证来自程序只贴它问的那几条,不来自"叫它别乱写"
 *  - **模型少写的必须让整件事不算过**。这是唯一一种「闸门全绿而请求没被满足」的组合:
 *    漏改的那条成就旧框还在原地,校验器一点问题都看不出来
 *  - **旧攻略本来就有的问题不算这次的账**,但**必须报出来** —— 不拦不等于不说
 *  - **同名成就按名字点不动**。猜一个等于把 A 的打法写到 B 头上
 *
 * 不联网、不碰数据库:全是纯函数。这是刻意的 —— 拼接位置对不对必须能在没有 key、
 * 没有网络、没有 Notion 的情况下逐条验。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseTodos, todoSpans, spliceLines } from '../lib/markdown.js';
import { lintGuide } from '../lib/guidelint.js';
import {
  RARE_PCT, THIN_CHARS, guideProse, resolveScope, scopeEntries, classifyFindings,
} from '../lib/guidescope.js';
import {
  parsePatchReply, applyPatchToTodos, spliceIntoText, buildPatchFeedback,
} from '../lib/guidepatch.js';
import { patchPreflight, formatPatchPreflight } from '../lib/guidebackup.js';
import { buildPatchMessage } from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const def = (apiName, nameCn, description = '', nameEn = '') => ({
  api_name: apiName,
  name_cn: nameCn,
  name_en: nameEn,
  description,
  game_name: '测试游戏',
  hidden: 0,
  icon: '',
});

const DEFS = [
  def('A', '第一步', '完成第一关。'),
  def('B', '第二步', '完成第二关。'),
  def('C', '第三步', '完成第三关。'),
  def('D', '收集狂', '集齐全部收集品。'),
];

/** 稀有度:C 是 1.1% 的硬骨头,别的都很常见 */
const RARITY = new Map([['A', 64.5], ['B', 40.0], ['C', 1.1], ['D', 12.0]]);

/**
 * 一份长得像真攻略的语料。三个细节是刻意的:
 *
 *  - **B 底下挂了两条子步骤**,其中一条是手动勾上的 —— 局部重写唯一真正的损失
 *  - **C 后面紧跟一段 `<details>`**,用来钉住区间不会把它吃掉
 *  - **两个小节**,`section:` 选择器要用
 */
const GUIDE = [
  '# 测试游戏',
  'appid: 1',
  '',
  '## 主线',
  '- [x] **第一步**<br>完成第一关。<br>开局就能拿,顺手的事。',
  '- [ ] **第二步**<br>完成第二关。<br>接着打就行。',
  '  - [x] 打完第一个 Boss',
  '  - [ ] 拿到钥匙',
  '- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。',
  '<details><summary>全结局对照</summary>',
  '结局一 / 结局二 / 结局三',
  '</details>',
  '',
  '## 收集',
  '- [ ] **收集狂**<br>集齐全部收集品。<br>见下面的 BV 号。',
  '',
].join('\n');

const TODOS = parseTodos(GUIDE);

/** 按 api_name 拿到 scopeEntries 的那一条 */
const entriesFor = (apiNames, todos = TODOS) =>
  scopeEntries({ todos, defs: DEFS, apiNames }).entries;

/** 模型交回来的那种回复(已经过 extractMarkdown,所以是纯 markdown) */
const reply = (...blocks) => blocks.join('\n');

// ---------------------------------------------------------------------------

describe('行区间定位 —— 宁可少吃一行,绝不多吃一行', () => {
  test('一条成就的区间 = 它自己 + 紧跟的更深缩进行', () => {
    const spans = todoSpans(GUIDE);
    const lines = GUIDE.split('\n');
    const bLine = lines.indexOf('- [ ] **第二步**<br>完成第二关。<br>接着打就行。');

    assert.deepEqual(spans.get(bLine), { start: bLine, end: bLine + 2, indent: 0 });
  });

  test('紧跟在成就后面的 <details> 不属于它 —— 区间到成就那一行就停', () => {
    const spans = todoSpans(GUIDE);
    const lines = GUIDE.split('\n');
    const cLine = lines.indexOf('- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。');

    // C 后面就是 <details>,不是 checkbox ⇒ 区间只有它自己一行。
    // 多吃一行的后果是那段折叠被静默删掉,而它是用户的东西
    assert.equal(spans.get(cLine).end, cLine);
  });

  test('中间隔了非 checkbox 行的更深缩进,不算它的子步骤', () => {
    // **这条钉的是「必须连续」那一条判据,上面那条 <details> 的钉不住它** ——
    // 那里 `<details>` 后面跟的是下一条**同级**成就,所以缩进判据先一步把区间截断了,
    // 连续性判据根本没被走到。变异验证发现的:把 `line !== end + 1` 删掉,整个文件照样全绿。
    //
    // 这里的形状才真的需要它:折叠块**里面**有更深缩进的 checkbox。少了这条判据,
    // 区间会一路吃到 `- [ ] 折叠块里的东西`,于是重写这条成就会把用户的整段折叠删掉
    const md = [
      '- [ ] **第一步**<br>完成第一关。<br>正文。',
      '<details><summary>全收集品位置</summary>',
      '  - [ ] 折叠块里的东西,缩进更深',
      '</details>',
    ].join('\n');

    assert.equal(todoSpans(md).get(0).end, 0, '区间只有它自己 —— 多吃一行就是静默删掉用户的折叠块');
  });

  test('子步骤自己也有区间,而且不会把下一条成就吃进来', () => {
    const spans = todoSpans(GUIDE);
    const lines = GUIDE.split('\n');
    const sub = lines.indexOf('  - [x] 打完第一个 Boss');

    // 下一行 `拿到钥匙` 是**同级**(缩进相同),所以不算它的子步骤
    assert.equal(spans.get(sub).end, sub);
  });

  test('spliceLines 倒序替换:前面的替换不会错开后面的区间', () => {
    const text = ['a', 'b', 'c', 'd'].join('\n');
    // 两处替换,第一处把 1 行变成 3 行。正序做的话第二处的下标会偏 2
    const out = spliceLines(text, [
      { start: 0, end: 0, lines: ['a1', 'a2', 'a3'] },
      { start: 2, end: 2, lines: ['C'] },
    ]);
    assert.deepEqual(out.split('\n'), ['a1', 'a2', 'a3', 'b', 'C', 'd']);
  });

  test('CRLF 文件替换之后还是 CRLF —— 不然 git diff 变成整份都改了', () => {
    const crlf = GUIDE.replace(/\n/g, '\r\n');
    const out = spliceLines(crlf, [{ start: 0, end: 0, lines: ['# 改了'] }]);
    assert.ok(out.includes('\r\n'), '换行风格应该跟着原文');
    assert.ok(!/[^\r]\n/.test(out), '不该混进裸 LF');
  });
});

describe('拼接 —— 点名之外逐字不变', () => {
  test('只改 B:其余每一行逐字相等', () => {
    const entries = entriesFor(['B']);
    const found = new Map([['B', ['- [ ] **第二步**<br>完成第二关。<br>换了个说法,写详细多了。']]]);

    const out = spliceIntoText(GUIDE, entries, found);
    const before = GUIDE.split('\n');
    const after = out.split('\n');

    // B 那一行 + 它的两条子步骤(3 行)换成了 1 行
    assert.equal(after.length, before.length - 2);

    // **逐行比对未点名的部分。** 这是这个文件最重要的一条断言
    const untouched = (arr) => arr.filter((l) => !l.includes('第二步') && !l.includes('打完第一个 Boss') && !l.includes('拿到钥匙'));
    assert.deepEqual(untouched(after), untouched(before));
  });

  test('只改 C:后面那段 <details> 一个字没动', () => {
    const entries = entriesFor(['C']);
    const found = new Map([['C', ['- [ ] **第三步**<br>完成第三关。<br>重写过的打法。']]]);

    const out = spliceIntoText(GUIDE, entries, found).split('\n');
    assert.ok(out.includes('<details><summary>全结局对照</summary>'));
    assert.ok(out.includes('结局一 / 结局二 / 结局三'));
    assert.ok(out.includes('</details>'));
  });

  test('新写的子步骤替换掉旧的,数量可以不一样', () => {
    const entries = entriesFor(['B']);
    const found = new Map([['B', [
      '- [ ] **第二步**<br>完成第二关。<br>拆成三步。',
      '  - [ ] 一',
      '  - [ ] 二',
      '  - [ ] 三',
    ]]]);

    const out = spliceIntoText(GUIDE, entries, found);
    assert.ok(!out.includes('打完第一个 Boss'), '旧子步骤该被换掉');
    assert.ok(out.includes('  - [ ] 三'));
    // 别的成就的子步骤不存在,所以总数就是新的那三条
    assert.equal(parseTodos(out).filter((t) => t.parent !== null).length, 3);
  });

  test('两条不相邻的成就一起改,互不干扰', () => {
    const entries = entriesFor(['A', 'D']);
    const found = new Map([
      ['A', ['- [ ] **第一步**<br>完成第一关。<br>A 的新写法。']],
      ['D', ['- [ ] **收集狂**<br>集齐全部收集品。<br>D 的新写法。']],
    ]);

    const out = spliceIntoText(GUIDE, entries, found);
    assert.ok(out.includes('A 的新写法'));
    assert.ok(out.includes('D 的新写法'));
    // 中间的 B / C / details / 小节标题全在
    assert.ok(out.includes('- [ ] **第二步**<br>完成第二关。<br>接着打就行。'));
    assert.ok(out.includes('  - [x] 打完第一个 Boss'));
    assert.ok(out.includes('## 收集'));
    assert.ok(out.includes('</details>'));
  });

  test('没交回来的成就原地不动 —— 不会被清空', () => {
    const entries = entriesFor(['A', 'B']);
    // 只交回 A
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>只改了 A。']]]);

    const out = spliceIntoText(GUIDE, entries, found);
    assert.ok(out.includes('只改了 A'));
    assert.ok(out.includes('- [ ] **第二步**<br>完成第二关。<br>接着打就行。'), 'B 该原样留着');
  });
});

describe('模型交回来的东西 —— 只认点名的那几条', () => {
  test('反查得出 api_name 才认,顺序不影响归属', () => {
    const md = reply(
      '- [ ] **收集狂**<br>集齐全部收集品。<br>D 先来。',
      '- [ ] **第一步**<br>完成第一关。<br>A 后到。',
    );
    const { found, unresolved } = parsePatchReply(md, DEFS);
    assert.deepEqual([...found.keys()].sort(), ['A', 'D']);
    assert.deepEqual(unresolved, []);
  });

  test('多写了没点名的成就 ⇒ 不应用,但要报出来', () => {
    const md = reply(
      '- [ ] **第二步**<br>完成第二关。<br>点名的这条。',
      '- [ ] **第三步**<br>完成第三关。<br>没点名,顺手改的。',
    );
    const { found } = parsePatchReply(md, DEFS);
    const wanted = new Set(['B']);

    // 这是 patchGuide 里那一步的形状:过滤掉没点名的
    const applied = new Map([...found].filter(([a]) => wanted.has(a)));
    const extra = [...found.keys()].filter((a) => !wanted.has(a));

    assert.deepEqual([...applied.keys()], ['B']);
    assert.deepEqual(extra, ['C'], '多写的要报出来,不能静静吞掉');

    // 真去拼一次:C 必须还是原文
    const out = spliceIntoText(GUIDE, entriesFor(['B']), applied);
    assert.ok(out.includes('- [ ] **第三步**<br>完成第三关。<br>最后一关,有点难。'));
    assert.ok(!out.includes('没点名,顺手改的'));
  });

  test('认不出是哪个成就的条目进 unresolved,不猜', () => {
    const md = reply('- [ ] **第五步**<br>这个成就不存在。<br>瞎写的。');
    const { found, unresolved } = parsePatchReply(md, DEFS);
    assert.equal(found.size, 0);
    assert.equal(unresolved.length, 1);
  });

  test('子步骤不会被当成成就单独反查', () => {
    const md = reply(
      '- [ ] **第二步**<br>完成第二关。<br>带子步骤。',
      '  - [ ] 第三步的某个环节',
    );
    const { found } = parsePatchReply(md, DEFS);
    // 那条子步骤的文字里有「第三步」,顶层过滤没做对的话它会被当成成就 C
    assert.deepEqual([...found.keys()], ['B']);
    assert.equal(found.get('B').length, 2, '子步骤要跟着它那一条一起交回来');
  });

  test('同一个成就交回来两遍只认第一遍', () => {
    const md = reply(
      '- [ ] **第二步**<br>完成第二关。<br>第一版。',
      '- [ ] **第二步**<br>完成第二关。<br>第二版。',
    );
    const { found } = parsePatchReply(md, DEFS);
    assert.equal(found.size, 1);
    assert.ok(found.get('B')[0].includes('第一版'));
  });
});

describe('闸门 —— 少改一条不能算过', () => {
  test('漏掉的条目在 lint 里查不出来,所以必须单独判', () => {
    // 点名 A 和 B,只交回 A —— B 的旧框还在原地
    const entries = entriesFor(['A', 'B']);
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>只改了 A。']]]);

    const patched = applyPatchToTodos(TODOS, entries, found);
    const lint = lintGuide({ todos: patched, defs: DEFS, unlockedApiNames: new Set(), kind: 'notion' });

    // **校验器一条错都报不出来** —— 这正是"漏改"必须单独判的理由
    assert.equal(lint.findings.filter((f) => f.level === 'error').length, 0);

    const missing = entries.filter((e) => !found.has(e.apiName)).map((e) => e.apiName);
    assert.deepEqual(missing, ['B'], '漏改要靠这个数发现,不靠校验器');
  });

  test('applyPatchToTodos:新条目一律未勾选,旧子步骤被丢掉', () => {
    const entries = entriesFor(['A']);
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>新写的。']]]);
    const patched = applyPatchToTodos(TODOS, entries, found);

    const a = patched.find((t) => t.text.includes('第一步'));
    // 原文里 A 是 `- [x]`。新写的一律 false,勾选由 computeCheckedKeys 按数据库填 ——
    // 沿用旧状态是错的,因为旧的那个勾可能本来就勾错了
    assert.equal(a.checked, false);
  });

  test('新子步骤挂在自己那一条底下', () => {
    const entries = entriesFor(['A']);
    const found = new Map([['A', [
      '- [ ] **第一步**<br>完成第一关。<br>新写的。',
      '  - [ ] 子步骤一',
    ]]]);
    const patched = applyPatchToTodos(TODOS, entries, found);
    const a = patched.find((t) => t.text.includes('第一步'));
    const sub = patched.find((t) => t.text === '子步骤一');

    assert.equal(sub.parent, a.key);
    assert.notEqual(sub.key, a.key, '合成 key 必须和父的不一样');
  });

  test('旧攻略里别处的子步骤没被动过', () => {
    const entries = entriesFor(['A']);
    const found = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>新写的。']]]);
    const patched = applyPatchToTodos(TODOS, entries, found);

    const boss = patched.find((t) => t.text === '打完第一个 Boss');
    assert.ok(boss, 'B 的子步骤该还在');
    assert.equal(boss.checked, true, '手动勾上的状态该保住');
  });
});

describe('错误归属 —— 旧问题不算这次的账,但要说出来', () => {
  const finding = (code, apiName, message = code) => ({ level: 'error', code, apiName, message });

  test('落在选择集里的问题算这次的', () => {
    const { caused, preExisting } = classifyFindings({
      before: [finding('paraphrased-description', 'B')],
      after: [finding('paraphrased-description', 'B')],
      apiNames: ['B'],
    });
    // 改之前就有,但 B 正是这次重写的 —— 重写完还有,就是这次没写对
    assert.equal(caused.length, 1);
    assert.equal(preExisting.length, 0);
  });

  test('选择集之外、改之前就有的问题不拦路', () => {
    const { caused, preExisting } = classifyFindings({
      before: [finding('ambiguous-no-description', 'D')],
      after: [finding('ambiguous-no-description', 'D')],
      apiNames: ['B'],
    });
    assert.equal(caused.length, 0, '一次做对了的改动不该被一个没授权去改的老问题丢掉');
    assert.equal(preExisting.length, 1, '**但必须报出来** —— 不拦不等于不说');
  });

  test('新长出来的问题算这次的,哪怕落在选择集之外', () => {
    const { caused } = classifyFindings({
      before: [],
      after: [finding('merged-line', null, '一行里写了多个 checkbox')],
      apiNames: ['B'],
    });
    // 拼接把某行弄成了合并行 —— 带不了 apiName,但它改之前不存在
    assert.equal(caused.length, 1);
  });

  test('身份不看 key —— 拼接之后行号会变,问题还是同一个', () => {
    const { preExisting } = classifyFindings({
      before: [{ level: 'error', code: 'merged-line', key: 5, message: '一行里写了多个:xxx' }],
      after: [{ level: 'error', code: 'merged-line', key: 9, message: '一行里写了多个:xxx' }],
      apiNames: ['B'],
    });
    assert.equal(preExisting.length, 1, '行号变了不代表这是个新问题');
  });
});

describe('选择器', () => {
  const base = { defs: DEFS, todos: TODOS, rarity: RARITY, unlocked: new Set(['A']), text: GUIDE };

  test('rare 用的是和提示词同一条线', () => {
    const r = resolveScope({ ...base, selector: 'rare' });
    // C 是 1.1%,D 是 12% —— 都在 15% 以下
    assert.deepEqual(r.apiNames, ['C', 'D']);
    assert.equal(RARE_PCT, 15);
  });

  test('rare:5 收紧阈值', () => {
    assert.deepEqual(resolveScope({ ...base, selector: 'rare:5' }).apiNames, ['C']);
  });

  test('拿不到解锁率时 rare 报错,而不是选空集', () => {
    // 静静地选空集看起来和"这游戏没有难成就"一模一样,而真相是 Steam 没答话
    assert.throws(
      () => resolveScope({ ...base, rarity: null, selector: 'rare' }),
      (e) => e.code === 'no-rarity'
    );
  });

  test('thin 挑没写打法的,不挑整条都不存在的', () => {
    const thinGuide = [
      '# 测试游戏',
      '- [ ] **第一步**<br>完成第一关。',
      '- [ ] **第二步**<br>完成第二关。<br>' + '这条写得很详细,'.repeat(6),
    ].join('\n');
    const todos = parseTodos(thinGuide);

    const r = resolveScope({ ...base, todos, text: thinGuide, selector: 'thin' });
    assert.ok(r.apiNames.includes('A'), '只抄了官方描述的该被选中');
    assert.ok(!r.apiNames.includes('B'), '写得详细的不该被选中');
    // C / D 在这份攻略里压根没有框 —— 那是"缺 checkbox",归 failing 管,不是"没写打法"
    assert.ok(!r.apiNames.includes('C'));
    assert.ok(!r.apiNames.includes('D'));
  });

  test('guideProse 剥掉名字和描述之后才量长度', () => {
    const only = guideProse('**第一步**<br>完成第一关。', DEFS[0]);
    assert.equal(only, '', '只有名字和官方描述 ⇒ 打法是空的');
    assert.ok(guideProse('**第一步**<br>完成第一关。<br>开局就能拿。', DEFS[0]).includes('开局'));
    assert.equal(THIN_CHARS, 40);
  });

  test('locked / unlocked 按真实解锁状态分', () => {
    assert.deepEqual(resolveScope({ ...base, selector: 'unlocked' }).apiNames, ['A']);
    assert.deepEqual(resolveScope({ ...base, selector: 'locked' }).apiNames, ['B', 'C', 'D']);
  });

  test('section: 只取那一节里的成就', () => {
    assert.deepEqual(resolveScope({ ...base, selector: 'section:收集' }).apiNames, ['D']);
    assert.deepEqual(resolveScope({ ...base, selector: 'section:主线' }).apiNames, ['A', 'B', 'C']);
  });

  test('拿不到全文时 section: 明确报错,不选空集', () => {
    assert.throws(
      () => resolveScope({ ...base, text: null, selector: 'section:主线' }),
      (e) => e.code === 'section-needs-local'
    );
  });

  test('failing 从改之前那次 lint 里挑人', () => {
    const baseline = [
      { level: 'error', code: 'missing-checkbox', apiName: 'C' },
      { level: 'error', code: 'checked-mismatch', apiName: 'A' },
    ];
    const r = resolveScope({ ...base, baseline, selector: 'failing' });
    // checked-mismatch 不算"这条写得不对" —— 模型压根不许写勾选状态
    assert.deepEqual(r.apiNames, ['C']);
  });

  test('显式列表认中文名、英文名和 api_name', () => {
    assert.deepEqual(resolveScope({ ...base, selector: '第一步,D' }).apiNames, ['A', 'D']);
    // 中文逗号也认 —— 名字是从 Dashboard 抄下来的,输入法给什么就是什么
    assert.deepEqual(resolveScope({ ...base, selector: '第一步,第三步' }).apiNames, ['A', 'C']);
  });

  test('认不出的名字进 unresolved,一条都不能静静消失', () => {
    const r = resolveScope({ ...base, selector: '第一步,不存在的成就' });
    assert.deepEqual(r.apiNames, ['A']);
    assert.deepEqual(r.unresolved, ['不存在的成就']);
  });

  test('同名成就按名字点不动 —— 猜一个等于把 A 的打法写到 B 头上', () => {
    const twins = [def('X1', '妙手空空', '偷到东西。'), def('X2', '妙手空空', '')];
    const r = resolveScope({
      selector: '妙手空空',
      defs: twins,
      todos: [],
      rarity: null,
      unlocked: new Set(),
      text: null,
    });
    assert.deepEqual(r.apiNames, []);
    assert.deepEqual(r.unresolved, ['妙手空空']);

    // api_name 点得动 —— 那个一定唯一
    const byApi = resolveScope({
      selector: 'X2', defs: twins, todos: [], rarity: null, unlocked: new Set(), text: null,
    });
    assert.deepEqual(byApi.apiNames, ['X2']);
  });

  test('空选择器和瞎写的阈值都当场拒绝', () => {
    assert.throws(() => resolveScope({ ...base, selector: '' }), (e) => e.code === 'empty-scope');
    assert.throws(() => resolveScope({ ...base, selector: 'rare:很稀有' }), (e) => e.code === 'bad-scope');
    assert.throws(() => resolveScope({ ...base, selector: 'section:' }), (e) => e.code === 'bad-scope');
  });
});

describe('定位', () => {
  test('scopeEntries 带上子步骤的 key —— Notion 删子块要 block id', () => {
    const { entries } = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['B'] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].subTodos.length, 2);
    for (const s of entries[0].subTodos) assert.notEqual(s.key, undefined);
  });

  test('攻略里没有对应框的成就进 unlocatable,不当它不存在', () => {
    const thin = parseTodos('# 测试游戏\n- [ ] **第一步**<br>完成第一关。');
    const r = scopeEntries({ todos: thin, defs: DEFS, apiNames: ['A', 'C'] });
    assert.deepEqual(r.entries.map((e) => e.apiName), ['A']);
    assert.deepEqual(r.unlocatable, ['C']);
  });

  test('条目顺序跟 defs 走,不跟选择器里写的顺序走', () => {
    const { entries } = scopeEntries({ todos: TODOS, defs: DEFS, apiNames: ['D', 'A'] });
    assert.deepEqual(entries.map((e) => e.apiName), ['A', 'D']);
  });
});

describe('预检 —— 讲的是什么会留下', () => {
  test('只有点名那几条底下的手动勾选会丢,别处的报成保住了', () => {
    const entries = entriesFor(['A']);
    const p = patchPreflight({ oldTodos: TODOS, defs: DEFS, entries, oldText: GUIDE });

    // B 底下那个手动勾上的子步骤不在这次范围里
    assert.equal(p.atRiskTicks.length, 0);
    assert.equal(p.savedTicks, 1);
    assert.equal(p.scope, 1);
    assert.equal(p.replacing, 1);
    assert.equal(p.keeping, p.count - 1);

    const text = formatPatchPreflight(p, { defsCount: DEFS.length });
    assert.match(text, /只改 1 条成就/);
    assert.match(text, /1 个手动勾选保住了/);
  });

  test('点到 B 的话,它底下那个手动勾选就会丢,而且要说出来', () => {
    const entries = entriesFor(['B']);
    const p = patchPreflight({ oldTodos: TODOS, defs: DEFS, entries, oldText: GUIDE });

    assert.equal(p.atRiskTicks.length, 1);
    assert.equal(p.savedTicks, 0);
    assert.equal(p.replacing, 3, '它自己 + 两条子步骤');

    assert.match(formatPatchPreflight(p), /会变回未勾选/);
  });
});

/**
 * 源码断言 —— 这几条守的是**单测够不到的那段编排**。
 *
 * `patchGuide` 要有 provider、要发请求,所以"落地前必须先备份""少写一条不算过"这类
 * 规矩没法用单测覆盖。和 `guidequeue.test.js` 里那条 `drainNext` 断言同一路数:
 * 按两个真锚点切片(不是 `indexOf` + 字节数 —— 那种窗口会随着中间加代码悄悄挪走),
 * 而且**先剥注释再匹配**,否则解释这条规矩的注释本身就能让断言通过,删掉代码也照样绿。
 */
describe('编排里那几条单测够不到的规矩', () => {
  const src = readFileSync(new URL('../lib/guidepatch.js', import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** 切到 patchGuide 的循环尾巴 + 落地那一段 */
  function landingBlock() {
    const start = src.indexOf('  while (round < rounds) {');
    const end = src.indexOf('  return {\n    ok,');
    assert.notEqual(start, -1, '找不到那个循环 —— 提取逻辑坏了,不是规矩没了');
    assert.notEqual(end, -1, '找不到返回值 —— 提取逻辑坏了');
    return strip(src.slice(start, end));
  }

  test('少写一条就不算过 —— 它变不成任何一条 lint 错误', () => {
    const block = landingBlock();
    assert.match(block, /const ok = caused\.length === 0 && missing\.length === 0/,
      '`ok` 必须同时看 caused 和 missing。只看 caused 的话,模型漏改的那条成就'
      + '旧框还在原地、校验器一条错都报不出来,于是"没改"会被报成"改完了"');
    assert.match(block, /if \(!caused\.length && !missing\.length\) break/,
      '跳出循环的条件也要看 missing,否则漏改的那几条根本不会被重问');
  });

  test('备份是落地的前置条件,而且排在任何一次写之前', () => {
    const block = landingBlock();
    const backup = block.indexOf('await backupGuide(');
    const landLocal = block.indexOf('landPatchLocal(');
    const landNotion = block.indexOf('landPatchNotion(');

    assert.ok(backup > -1, '落地前必须备份 —— 没备份的覆盖就是不可逆的删除');
    assert.ok(landLocal > backup && landNotion > backup, '备份要排在两条落地路之前');
    assert.match(block, /if \(ok\) \{/, '没过闸门就一个字都不写');
  });

  test('两条落地路都在 ok 里面,没有绕过闸门的分支', () => {
    const block = landingBlock();
    // `ok` 之后到返回值之间只该有一个 if(ok) 块。多一条独立的写路径 = 一条绕过闸门的路
    const writes = [...block.matchAll(/landPatch(Local|Notion)\(/g)];
    assert.equal(writes.length, 2, '落地只该有这两处调用');
  });
});

describe('提示词', () => {
  test('把原文摆出来,并且明说别动别的', () => {
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '把互斥关系写清楚' });
    assert.match(msg, /把互斥关系写清楚/);
    assert.match(msg, /接着打就行/, '默认要给模型看原文');
    assert.match(msg, /别的一条都不要动/);
    assert.match(msg, /不要写小节标题/);
    assert.match(msg, /- \[ \]/, '勾选状态那条规矩要重申');
  });

  test('--fresh 抽掉原文,只留清单', () => {
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '重新查', fresh: true });
    assert.ok(!msg.includes('接着打就行'), '--fresh 不该把原文给它看');
    assert.match(msg, /完成第二关。/, '官方描述还是要给 —— 那是硬规则要照抄的东西');
  });

  test('没给要求时说清楚是"重新写",不留空', () => {
    const msg = buildPatchMessage(entriesFor(['B']));
    assert.match(msg, /要求:/);
  });

  test('打回清单把「没交回来」和「写得不对」分开说', () => {
    const entries = entriesFor(['A', 'B']);
    const fb = buildPatchFeedback(
      [{ level: 'error', code: 'paraphrased-description', apiName: 'A', message: '描述不是原文照抄:第一步' }],
      entries,
      ['B']
    );
    assert.match(fb, /一条都没交回来/);
    assert.match(fb, /第二步/, '漏掉的要点名说');
    assert.match(fb, /没过机器校验/);
    assert.match(fb, /别动别的成就/);
  });

  test('打回清单只列这几条自己的问题', () => {
    const fb = buildPatchFeedback(
      [
        { level: 'error', code: 'paraphrased-description', apiName: 'A', message: 'A 的问题' },
        { level: 'error', code: 'paraphrased-description', apiName: 'D', message: 'D 的问题' },
      ],
      entriesFor(['A'])
    );
    assert.match(fb, /A 的问题/);
    assert.ok(!fb.includes('D 的问题'), '别段的问题塞进来,模型会顺手去改它这轮不该动的东西');
  });
});
