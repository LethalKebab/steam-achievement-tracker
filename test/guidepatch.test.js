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
import { lintGuide, computeCheckedKeys } from '../lib/guidelint.js';
import {
  RARE_PCT, resolveScope, scopeEntries, classifyFindings,
} from '../lib/guidescope.js';
import {
  parsePatchReply, applyPatchToTodos, spliceIntoText, buildPatchFeedback, landPatchNotion,
} from '../lib/guidepatch.js';
import { patchPreflight, formatPatchPreflight } from '../lib/guidebackup.js';
import { NotionClient } from '../lib/notion.js';
import { buildPatchMessage, buildAchievementList } from '../lib/guidegen.js';

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
    // C 是 1.1%,进;**D 是 12%,不进** —— 它正好卡在旧线(15%)和新线(10%)之间,
    // 所以这条断言同时钉住"线在 10%"和"线确实动过"
    assert.deepEqual(r.apiNames, ['C']);
    assert.equal(RARE_PCT, 10);
  });

  test('rare:15 放宽阈值 —— 参数能覆盖默认线', () => {
    // 拿旧的那个数当参数:D(12%)重新进来。这条以前是 rare:5,而 5 和新的默认线
    // 选出来是同一批,证明不了参数有没有被读进去
    assert.deepEqual(resolveScope({ ...base, selector: 'rare:15' }).apiNames, ['C', 'D']);
  });

  test('拿不到解锁率时 rare 报错,而不是选空集', () => {
    // 静静地选空集看起来和"这游戏没有难成就"一模一样,而真相是 Steam 没答话
    assert.throws(
      () => resolveScope({ ...base, rarity: null, selector: 'rare' }),
      (e) => e.code === 'no-rarity'
    );
  });

  test('locked 挑还没打的那些', () => {
    assert.deepEqual(resolveScope({ ...base, selector: 'locked' }).apiNames, ['B', 'C', 'D']);
  });

  /**
   * **选择器只有 Dashboard 上有对应按钮的那几个。**
   *
   * 删掉过四个:`all`(整篇重写有 `--overwrite`,这是第二条几乎一样的路)、
   * `thin`(判据说不清楚,做不成按钮)、`unlocked`(没人要过"重写我已经打过的")、
   * `failing`(真实语料里几乎永远是空集,一个常年显示 0 的按钮只制造疑问)。
   *
   * 钉住它们**不认得**,而不只是钉住剩下的认得:一个悄悄加回来的选择器不会让任何
   * 测试变红,而它会让「这个功能能做什么」在 CLI 和界面上有两个答案。
   */
  test('删掉的四个选择器当成"没这个东西",按名字去解析', () => {
    for (const gone of ['all', 'thin', 'unlocked', 'failing']) {
      const r = resolveScope({ ...base, selector: gone });
      // 落到显式列表那条分支 ⇒ 认不出这个"成就名" ⇒ 进 unresolved,而不是选中一批
      assert.deepEqual(r.apiNames, [], `${gone} 不该还能选中成就`);
      assert.deepEqual(r.unresolved, [gone], `${gone} 该被当成一个认不出的成就名报出来`);
    }
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
    // `--only ""` 曾经在 planPatch 里被一个 `if (!selector)` 的内部捷径吞掉,
    // 于是它交回 `scope: null`,调用方读 `pp.scope.apiNames` 当场 TypeError ——
    // 一个用户错误变成了一句看不懂的崩溃。「调用方没给」和「用户给了个空的」
    // 是两件事,判据必须是 `== null` 而不是假值
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

// 提示词里那句「标签行必须也是 `- [ ]`,不能写成普通 bullet」不是风格偏好,
// 是这里量出来的:`todoSpans` 只把**连续的、更深缩进的 checkbox 行**算进一条成就,
// 中间夹一行非 checkbox 就当场截断。截断之后局部重写只替换成就那一行,
// 底下的旧内容原样留着 —— 页面上是**重复**,而且不报错。
describe('分组标签必须也是 checkbox', () => {
  const P = '- [ ] **创造**<br>你可以创造一切。<br>心得';
  const span1 = (md) => {
    const s = todoSpans(md).get(0);
    return s ? s.end - s.start + 1 : 0;
  };

  test('提示词教的那个形状,能被完整圈住', () => {
    const md = [P,
      '  - [ ] **前置**',
      '    - [ ] 神之侧身像',
      '    - [ ] 玛希尔入队',
      '  - [ ] **步骤**',
      '    - [ ] 寻思龙眼宝石',
    ].join('\n');
    assert.equal(span1(md), 6, '六行都要算进这条成就,否则重写会留下重复');
    const todos = parseTodos(md);
    assert.equal(todos.length, 6);
    assert.equal(todos.filter((t) => t.parent != null).length, 5, '五条都要挂在上面');
  });

  test('标签写成普通 bullet 就会把范围截断', () => {
    // 这条**不是在钉一个我们想要的行为**,是在钉一个约束的存在:
    // 哪天 todoSpans 放宽了,提示词里那句"必须是 checkbox"的理由就没了,
    // 这条会红,提醒去把规则一起改掉
    const md = [P,
      '  - 前置：',
      '    - [ ] 神之侧身像',
      '    - [ ] 玛希尔入队',
    ].join('\n');
    assert.equal(span1(md), 1,
      '普通 bullet 一夹,成就就只剩自己一行 —— 提示词禁止这种写法的全部理由');
  });
});

// 逗号是列表分隔符,而**成就名里本来就有逗号** —— 全库 10134 个成就里 302 个带逗号,
// 其中 116 个属于已经写了攻略的游戏(马特的寻猫游戏的「拔掉插头,放松身心」就是一个)。
// 不先把整串当一个名字试一次的话,它会被切成两半、两半都匹配不上,而报出来的是
// 「这两条攻略里找不到」—— 指不到真正的原因。
describe('--only 的名字里带逗号', () => {
  const withComma = [
    def('A', '第一步', '完成第一关。'),
    def('X', '拔掉插头，放松身心', '关掉10块屏幕。'),
    def('Y', '放松身心', '别的成就。'),
  ];

  test('整串正好是一个成就名时,不拆', () => {
    const r = resolveScope({ selector: '拔掉插头，放松身心', defs: withComma });
    assert.deepEqual(r.apiNames, ['X']);
    assert.deepEqual(r.unresolved, []);
  });

  test('整串匹配不上时,照常按逗号拆', () => {
    const r = resolveScope({ selector: '第一步,放松身心', defs: withComma });
    assert.deepEqual(r.apiNames, ['A', 'Y']);
  });

  test('api_name 那条退路没被改坏', () => {
    assert.deepEqual(resolveScope({ selector: 'X', defs: withComma }).apiNames, ['X']);
    assert.deepEqual(resolveScope({ selector: 'A,X', defs: withComma }).apiNames, ['A', 'X']);
  });

  test('中文逗号真的能当分隔符 —— 原来那个字符类里是两个半角逗号', () => {
    // `/[,,]/` 看着像「半角 + 全角」,实际是同一个 U+002C 写了两遍,而注释一直
    // 说「中文逗号也认」。输入法给的就是 U+FF0C,所以这条路一直是断的,
    // 而且断得很安静:整串匹配不上,报「攻略里找不到」
    const r = resolveScope({ selector: '第一步，放松身心', defs: withComma });
    assert.deepEqual(r.apiNames, ['A', 'Y']);
    assert.deepEqual(r.unresolved, []);
  });

  test('两个名字都点不中的照旧报出来,不静默', () => {
    const r = resolveScope({ selector: '不存在甲,不存在乙', defs: withComma });
    assert.deepEqual(r.apiNames, []);
    assert.deepEqual(r.unresolved, ['不存在甲', '不存在乙']);
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

  test('原文一律给,没有"不给它看"这个档', () => {
    // 曾经有个 `fresh` 开关抽掉原文。删了 —— 界面上没有它,而「写详细点 / 补上
    // 前置条件」这类要求占绝大多数、且全都以看得见原文为前提。多传一个它不认识的
    // 参数也不该改变行为
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '重新查', fresh: true });
    assert.match(msg, /接着打就行/, '原文永远给');
    assert.match(msg, /完成第二关。/, '官方描述也要给 —— 那是硬规则要照抄的东西');
  });

  test('不在用户刚提了要求的时候重申"默认不写"', () => {
    // 点名重写某几条,多半正是因为那几条写得不够细 —— 苏丹的游戏「知识」就是这么来的:
    // 用户明说"写出具体步骤",而这条消息同时在说"子步骤默认不写",两句话对着干。
    // 指回规则就够了,嵌不嵌套让那三个条件去判
    const msg = buildPatchMessage(entriesFor(['B']), { instruction: '写详细点' });
    assert.match(msg, /子步骤/, '仍然要说清子步骤怎么摆');
    assert.doesNotMatch(msg, /默认不写/, '不要在这里替那三个条件先给出答案');
    assert.match(msg, /三个条件/, '指回规则,而不是自己下结论');
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

/**
 * 「稀有」只有一条线
 * ------------------------------------------------
 * `RARE_PCT` 同时决定四件事:`--only rare` 选谁、提示词给哪几条打 🟠「偏难」、
 * Dashboard 上哪些百分比标成强调色、以及两处帮助文本里印的那个数。
 *
 * 前两件现在是**同一个常量**(`rarityTag` import 它),这一组钉的是后两件 ——
 * 它们各自是字面量,而且是**字符串**,漂了不会有任何东西报错:表现只是界面或者
 * 帮助文本说"稀有 = 低于 15%",而程序按 10% 选。2026-08-18 从 15% 改到 10% 时,
 * 全项目一共有六处写着这个数。
 */
describe('稀有的阈值只有一条线', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('提示词的 🟠 档就是 RARE_PCT —— 不是又写了一遍', () => {
    const defs = [def('LOW', '刚好在线内'), def('HIGH', '刚好在线外')];
    // 用 RARE_PCT 现算边界值,这样常量再改一次这条测试也还是对的
    const rarity = new Map([['LOW', RARE_PCT - 0.1], ['HIGH', RARE_PCT + 0.1]]);
    const list = buildAchievementList('测试', 1, defs, rarity);
    const lineOf = (name) => list.split('\n').find((l) => l.includes(name));
    assert.match(lineOf('刚好在线内'), /🟠|🔴/, '线内的要被标成偏难');
    assert.doesNotMatch(lineOf('刚好在线外'), /🟠|🔴/, '线外的不该标 —— 两处的线错开了');
  });

  test('CLI 帮助文本印的就是这个数', () => {
    const src = read('../tracker.js');
    const hits = [...src.matchAll(/全球解锁率 <(\d+)%/g)].map((m) => Number(m[1]));
    assert.ok(hits.length >= 2, '两处帮助文本都要提到阈值');
    for (const n of hits) assert.equal(n, RARE_PCT);
  });

  test('Dashboard 的兜底值也是这个数', () => {
    // 正常情况下阈值由服务端下发;兜底只在 previewGuidePatch 失败时用得上,
    // 也正因为如此它漂了几乎不会被发现
    const src = read('../Dashboard.html');
    // 两处的形状不一样:`o.picker.rarePct || 10` 和 `(sc && sc.rarePct) || 10`,
    // 所以 `\)?`。第一版漏了后者,断言当场报"两处兜底都在"不成立 —— 提取写窄了
    // 会让这条测试悄悄只钉住一半
    const hits = [...src.matchAll(/rarePct\)?\s*\|\|\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(hits.length, 2, '两处兜底都要被匹配到');
    for (const n of hits) assert.equal(n, RARE_PCT);
  });
});

// ---------------------------------------------------------------------------
// 勾选状态:校验之前必须先机械打勾
// ---------------------------------------------------------------------------

describe('局部重写的勾选状态', () => {
  /**
   * **这是一条真实的失败,不是假设。** 罗曼圣诞探案集(926340,46/50)重写一条
   * 「初入酒馆」直接失败,报的就是 `checked-mismatch`。
   *
   * 链条是这样的:`applyPatchToTodos` 把重写过的成就标成 `checked: false`(**这是对的** ——
   * 模型交回来的永远是 `- [ ]`,上面那条测试钉的就是它),落地时两个后端都会照
   * `computeCheckedKeys` 重新勾一遍。但**校验跑在落地之前**,如果直接拿那份没勾的
   * 去 lint,任何一条**已解锁**的成就都会报 `checked-mismatch` —— 而它不在
   * `MODEL_FIXABLE` 里,于是 `patchGuide` 当场把整次改动判死。
   *
   * 也就是说这条路对**任何已解锁的成就都不能用**,而那是一份打了大半的攻略里的
   * 绝大多数条目。`guidepatch.test.js` 全是纯函数测试(这是有意的),而这个 bug
   * 长在把这些纯函数串起来的那一段上,所以整套测试一片绿。这里补的就是那一段。
   */
  const patchedThenTicked = (apiNames, found, unlocked) => {
    const entries = entriesFor(apiNames);
    let patched = applyPatchToTodos(TODOS, entries, found, { kind: 'notion' });
    const wantChecked = new Set(
      computeCheckedKeys({ todos: patched, defs: DEFS, unlockedApiNames: unlocked })
    );
    patched = patched.map((t) => (wantChecked.has(t.key) ? { ...t, checked: true } : t));
    return { patched, wantChecked };
  };

  const rewriteA = new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>重写过的正文。']]]);
  const errorsOf = (patched, unlocked) =>
    lintGuide({ todos: patched, defs: DEFS, unlockedApiNames: unlocked, kind: 'notion' })
      .findings.filter((f) => f.level === 'error');

  test('重写一条已解锁的成就,校验不该报 checked-mismatch', () => {
    const unlocked = new Set(['A']);
    const { patched } = patchedThenTicked(['A'], rewriteA, unlocked);
    assert.deepEqual(
      errorsOf(patched, unlocked).map((f) => f.code), [],
      '这正是罗曼圣诞探案集那次失败'
    );
  });

  test('不先机械打勾就会报 —— 证明上面那条不是白测的', () => {
    const unlocked = new Set(['A']);
    const entries = entriesFor(['A']);
    const raw = applyPatchToTodos(TODOS, entries, rewriteA, { kind: 'notion' });
    assert.ok(
      errorsOf(raw, unlocked).some((f) => f.code === 'checked-mismatch'),
      '少了那一步,任何已解锁的成就都会把整次改动判死'
    );
  });

  test('没解锁的成就重写完仍然是没勾的', () => {
    const unlocked = new Set();
    const { patched, wantChecked } = patchedThenTicked(['A'], rewriteA, unlocked);
    const a = patched.find((t) => t.text.includes('第一步'));
    assert.equal(a.checked, false, '没解锁就不该勾 —— 打勾只看数据库,不看模型');
    assert.equal(wantChecked.size, 0);
  });

  test('算好的那份不能再算第二次 —— 会得到空集,然后把框取消勾选', () => {
    const unlocked = new Set(['A']);
    const { patched, wantChecked } = patchedThenTicked(['A'], rewriteA, unlocked);
    assert.ok(wantChecked.size > 0, '第一次要算出东西来');
    // computeCheckedKeys 跳过已经勾上的(「已经勾上的不用管」),所以对着勾好的
    // 再算一遍是空的 —— Notion 落地那条路会拿它当 `checked: false` 写回去
    const again = computeCheckedKeys({ todos: patched, defs: DEFS, unlockedApiNames: unlocked });
    assert.deepEqual(again, [], '这就是为什么落地必须收下算好的集合,而不是自己再算');
  });

  test('没被点名的条目,勾选状态一个都没动', () => {
    const unlocked = new Set(['A', 'B']);
    const { patched } = patchedThenTicked(['A'], rewriteA, unlocked);
    const boss = patched.find((t) => t.text === '打完第一个 Boss');
    assert.equal(boss.checked, true, '手动勾上的子步骤不该被这次改动碰到');
  });
});

describe('patchGuide 的接线(源码断言 —— 这一段没有网络就跑不到)', () => {
  const src = readFileSync(new URL('../lib/guidepatch.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('机械打勾排在 lintGuide 之前', () => {
    const i = src.indexOf('wantChecked = new Set(computeCheckedKeys(');
    const j = src.indexOf('lint = lintGuide(');
    assert.ok(i > 0 && j > 0, '两处都得在');
    assert.ok(i < j, '算在校验之后就等于没算');
  });

  // 上面那几条行为测试**自己把编排重跑了一遍**,所以它们证明的是「这套逻辑对」,
  // 不是「生产代码真这么做」—— 把 lib 里那一行删掉,它们照样绿。变异测试当场抓到。
  // 这一条补的就是那个缺口:算完必须写回去。
  test('算出来的勾选要写回 patched —— 只算不写等于没算', () => {
    const i = src.indexOf('wantChecked = new Set(computeCheckedKeys(');
    const j = src.indexOf('lint = lintGuide(');
    assert.ok(i > 0 && j > i);
    const between = src.slice(i, j);
    assert.match(between, /patched\s*=\s*patched\.map\(/,
      '算好的集合要写回 patched,否则校验看到的还是那份没勾的');
    assert.match(between, /checked:\s*true/);
  });

  test('Notion 落地收下算好的集合,不自己重算', () => {
    const fn = src.slice(
      src.indexOf('async function landPatchNotion'),
      src.indexOf('await notion.setTodoRichText')
    );
    assert.ok(fn.length > 0 && fn.length < 2000);
    assert.doesNotMatch(fn, /computeCheckedKeys\(/,
      '重算会得到空集,然后把刚勾上的框取消勾选');
    assert.match(fn, /wantChecked/, '要用传进来的那份');
  });
});

// ---------------------------------------------------------------------------
// Notion 落地 —— 这一段以前**一行都没执行过**
// ---------------------------------------------------------------------------

/**
 * 这个 describe 是补一个洞,而那个洞连着放走了两个 bug。
 *
 * 这个文件开头写着「全是纯函数,不联网」,而 `landPatchNotion` 不是纯函数,于是它
 * 一次都没被跑过 —— 连**函数体里有没有引用一个不存在的变量**都没人知道。实测:
 * 修上一个 bug 时我把 `defs` / `unlocked` 从它的参数里删掉了,而回读校验那行还在用,
 * 结果是运行时 `defs is not defined`。`node --check` 只看语法,整套测试跑不到这里,
 * 于是它一路走进打包版,用户点一次「重写」才炸。
 *
 * **假的 Notion 不算联网。** `guidegen-notion.test.js` 早就是这么做的;这里照搬。
 * 只要函数被真的执行一遍,这一类错误就没有藏身之处了。
 */
function fakeNotionPage() {
  return {
    written: [],
    childrenCalls: [],
    async setTodoRichText(blockId, richText, opts = {}) {
      this.written.push({ blockId, checked: opts.checked, text: richText.map((r) => r.text.content).join('') });
    },
    async replaceTodoChildren(blockId, blocks) {
      this.childrenCalls.push({ blockId, count: blocks.length });
    },
    // 回读:把原来的 todos 拿出来,并把这次改过的那几条换成写进去的样子
    async fetchAllToDoBlocks() {
      return TODOS.map((t) => {
        const w = this.written.find((x) => x.blockId === t.key);
        return w ? { key: t.key, text: w.text, checked: Boolean(w.checked), parent: t.parent } : t;
      });
    },
  };
}

const patchPlan = () => ({
  existing: { url: 'https://notion.so/3b91fee6252b811eaff4f382158bd7bc', kind: 'notion' },
  game: '测试游戏',
  unnameable: new Set(),
});

describe('landPatchNotion(假 Notion)', () => {
  const entries = () => entriesFor(['A']);
  const found = () => new Map([['A', ['- [ ] **第一步**<br>完成第一关。<br>重写过的正文。']]]);

  test('跑得起来 —— 光这一条就能挡住「defs is not defined」那一类', async () => {
    const notion = fakeNotionPage();
    const es = entries();
    const r = await landPatchNotion({
      notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(['A']),
      entries: es, found: found(), wantChecked: new Set([es[0].key]),
    });
    assert.equal(r.kind, 'notion');
    assert.equal(r.changed, 1);
  });

  // 这一条是写上面那个测试时**不小心撞出来的**:我把「A 已解锁」和「别勾 A」
  // 一起传了进去,回读当场把它抓了出来。那正是这段回读存在的理由 ——
  // 上一个 bug 的翻面版本(落地自己重算 ⇒ 空集 ⇒ 把该勾的框写成没勾)
  // 就长这个样子,所以它值得单独钉一条
  test('说要勾却没勾上,回读会抓出来', async () => {
    const notion = fakeNotionPage();
    await assert.rejects(
      () => landPatchNotion({
        notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(['A']),
        entries: entries(), found: found(), wantChecked: new Set(),
      }),
      /成就已解锁但框没勾/
    );
  });

  test('勾选状态用传进来的那份,不自己重算', async () => {
    const notion = fakeNotionPage();
    const es = entries();
    const key = es[0].key;
    await landPatchNotion({
      notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(['A']),
      entries: es, found: found(), wantChecked: new Set([key]),
    });
    assert.equal(notion.written.length, 1);
    assert.equal(notion.written[0].checked, true, '算好的说要勾,就得勾上');
  });

  // **这条钉的是「用户自己贴的东西能不能活下来」。**
  // 马特的寻猫游戏这类找物游戏,位置得靠截图说清楚,而模型给不出可靠的游戏内截图
  // (SKILL_RULE_DISPOSITION 的「规则二」写着为什么不做)。剩下的路是用户自己往
  // 成就底下贴图 —— 那就必须保证局部重写不会顺手删掉它。
  //
  // **判据搬过家了。** 原来靠「调用方只传 `e.subTodos` 的 id」,而分组标签是 toggle:
  // 装在里面的子步骤删得掉、壳删不掉,于是重写完页面上留下空折叠(苏丹的游戏「创造」
  // 实测:两个空壳 + 19 条子步骤没贴回去)。现在改成方法自己按**块类型**决定 ——
  // `to_do`/`toggle` 是模型每次整份交回来的正文,删;别的类型是用户的东西,留。
  // 所以这条测试跟着搬到真实现上,`landPatchNotion` 那层已经没有名单可验了。
  test('replaceTodoChildren 只删正文块(to_do/toggle),手贴的图表留着', async () => {
    const notion = new NotionClient({ notion: { token: 't' } });
    notion.childBlockStubs = async () => [
      { id: 'k1', type: 'to_do' },
      { id: 'k2', type: 'toggle' },
      { id: 'k3', type: 'image' },
      { id: 'k4', type: 'table' },
      { id: 'k5', type: 'paragraph' },
    ];
    const deleted = [];
    notion.deleteBlock = async (id) => { deleted.push(id); };
    let appended = 0;
    notion.appendBlocks = async (_id, blocks) => { appended = blocks.length; };

    await notion.replaceTodoChildren('parent', [{ object: 'block', type: 'to_do', to_do: {} }]);

    assert.deepEqual(deleted, ['k1', 'k2'],
      '只能删 to_do 和 toggle —— 多删一种,用户手贴的图就跟着没了,而且不报错');
    assert.equal(appended, 1, '新正文还是要写进去');
  });

  test('传进来说不勾,就不勾', async () => {
    const notion = fakeNotionPage();
    await landPatchNotion({
      notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(),
      entries: entries(), found: found(), wantChecked: new Set(),
    });
    assert.equal(notion.written[0].checked, false);
  });

  test('回读对不上就抛,而且只对这次改的那几条较真', async () => {
    const notion = fakeNotionPage();
    // 写进去的文字被换成别的东西 —— 这条成就的 checkbox 就没了
    notion.setTodoRichText = async function (blockId) {
      this.written.push({ blockId, checked: false, text: '完全不相干的一行字' });
    };
    await assert.rejects(
      () => landPatchNotion({
        notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(),
        entries: entries(), found: found(), wantChecked: new Set(),
      }),
      /回读校验/
    );
  });

  test('转不出 checkbox 就停下,不继续写坏后面的', async () => {
    const notion = fakeNotionPage();
    await assert.rejects(
      () => landPatchNotion({
        notion, plan: patchPlan(), defs: DEFS, unlocked: new Set(),
        entries: entries(),
        found: new Map([['A', ['这一行不是 checkbox']]]),
        wantChecked: new Set(),
      }),
      /转不出 checkbox/
    );
    assert.equal(notion.written.length, 0, '一个字都不该写出去');
  });
});

// 苏丹的游戏「创造」实测踩到的那个:模型照 groupLabelRule('notion') 写了三个
// `<details>` 分组、共 19 条子步骤,而 `parsePatchReply` 用的 `todoSpans` 只认
// checkbox 行,区间在第一个折叠行就断,子步骤一条都没被读进去。
test('Notion 目标下,折叠里的子步骤要算进这条成就的区间', () => {
  const md = [
    '- [ ] **第二步**<br>完成第二关。<br>重写过的正文。',
    '\t<details>',
    '\t<summary>**前置** — 开局前先备齐</summary>',
    '\t- [ ] 先拿到钥匙',
    '\t- [ ] 再点亮灯',
    '\t</details>',
    '\t<details>',
    '\t<summary>**注意** — 走岔就掉别的结局</summary>',
    '\t- 别先开箱子',
    '\t</details>',
  ].join('\n');

  const notion = parsePatchReply(md, DEFS, { kind: 'notion' }).found.get('B');
  assert.equal(notion.length, 10, 'Notion 目标要把两个折叠整块吃进来');
  assert.ok(notion.join('\n').includes('先拿到钥匙'), '子步骤丢了 —— 正是踩过的那个 bug');
  assert.ok(notion.join('\n').includes('别先开箱子'), '注意那一组的 bullet 也要在');

  // 本地那边**行为一个字不变**:`spliceIntoText` 按行区间回贴,多吃一行是静默删字,
  // 而本地目标的提示词根本不会产出这个形状
  const local = parsePatchReply(md, DEFS, { kind: 'local' }).found.get('B');
  assert.equal(local.length, 1, '本地目标必须维持 todoSpans 的保守区间');
});

// 折叠没闭合(模型被截断时的典型残骸)不能一路吃到文末 —— 那会把后面别的成就吞掉
test('折叠没有闭合标签时不猜,区间不往下吃', () => {
  const md = [
    '- [ ] **第二步**<br>完成第二关。<br>正文。',
    '\t<details>',
    '\t<summary>**前置**</summary>',
    '\t- [ ] 先拿到钥匙',
  ].join('\n');
  const got = parsePatchReply(md, DEFS, { kind: 'notion' }).found.get('B');
  assert.equal(got.length, 1, '没闭合就退回保守区间,少吃一行是看得见的失败');
});
