import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sameKindClusters, mergeSplitClusters, clusterConstraint } from '../lib/guidecluster.js';

/** 造一批成就:`d('A1','将吉祥物替换为一只怪物。')` */
const d = (api, description, name = api) => ({ api_name: api, name_cn: name, description });
/** 凑够数量,让 MAX_SHARE 那条不误伤小样本 */
const pad = (n) => Array.from({ length: n }, (_, i) => d(`PAD${i}`, `毫不相干的第${i}件事情要做完`));

describe('sameKindClusters(同类成就识别)', () => {
  test('同模板描述成一簇', () => {
    const defs = [
      d('A', '将吉祥物替换为一只啮齿动物。'),
      d('B', '将吉祥物替换为一只怪物。'),
      d('C', '将吉祥物替换为一位开发者。'),
      ...pad(40),
    ];
    const cs = sameKindClusters(defs);
    assert.equal(cs.length, 1);
    assert.deepEqual(cs[0].apiNames.sort(), ['A', 'B', 'C']);
  });

  /**
   * **这是这个模块存在的原因那一条。**《马特的寻猫游戏》四条替换吉祥物的成就里,
   * 三条写「替换**为**」,第四条写「替换**成**」—— 而落单的那条正是被劈到别的小节
   * 去的那条。长前缀先占位的贪心会把它漏掉,所以才有第二趟吸附。
   */
  test('差一个字的近亲也吸进来', () => {
    const defs = [
      d('DOG', '将吉祥物替换成一条狗。'),
      d('RAT', '将吉祥物替换为一只啮齿动物。'),
      d('MON', '将吉祥物替换为一只怪物。'),
      d('DEV', '将吉祥物替换为一位开发者。'),
      ...pad(40),
    ];
    const cs = sameKindClusters(defs);
    assert.equal(cs.length, 1);
    assert.deepEqual(cs[0].apiNames.sort(), ['DEV', 'DOG', 'MON', 'RAT']);
  });

  /**
   * 泰拉瑞亚有 22 条「Defeat …」,前期 boss 和肉后 boss 本来就该分开。
   * **前缀占描述均长一半以上**这一条就是拿来挡这个的 —— 挡不住它,这个检查会在
   * 一大批游戏上把不该并的并了,而误并是看不出来的。
   */
  test('公共动词不成簇 —— 前缀太短占不到描述的一半', () => {
    const defs = [
      d('W1', 'Defeat the Eye of Cthulhu, a floating demonic eyeball.'),
      d('W2', 'Defeat Skeletron, the cursed guardian of the dungeon.'),
      d('W3', 'Defeat the Wall of Flesh, the pinnacle of the underworld.'),
      d('W4', 'Defeat Plantera, the overgrown terror of the jungle.'),
      ...pad(40),
    ];
    assert.deepEqual(sameKindClusters(defs), []);
  });

  test('两条不成类', () => {
    const defs = [d('A', '收集全部的红色宝石。'), d('B', '收集全部的蓝色宝石。'), ...pad(40)];
    assert.deepEqual(sameKindClusters(defs), []);
  });

  // 小游戏里 8 条可能是半份攻略,强并会把结构整个压塌
  test('一簇不能占掉太大比例', () => {
    const four = [
      d('A', '扩建你的房间。'), d('B', '扩建你的卧室。'),
      d('C', '扩建你的客厅。'), d('D', '扩建你的厨房。'),
    ];
    const noise = (n) => Array.from({ length: n }, (_, i) => d(`N${i}`, `毫不相干的第${i}件事情`));
    assert.deepEqual(sameKindClusters([...four, ...noise(2)]), [],
      '6 个成就里 4 条一簇 —— 占了三分之二,并起来等于重写整份攻略的结构');
    assert.equal(sameKindClusters([...four, ...noise(40)]).length, 1,
      '同一批成就放进大游戏里就该认出来 —— 挡掉它的是占比,不是别的规则');
  });

  test('没有描述的成就不参与', () => {
    const defs = [d('A', ''), d('B', null), d('C', undefined), ...pad(40)];
    assert.deepEqual(sameKindClusters(defs), []);
  });

  test('空输入不炸', () => {
    assert.deepEqual(sameKindClusters([]), []);
    assert.deepEqual(sameKindClusters(null), []);
  });
});

describe('mergeSplitClusters(把劈开的簇并回去)', () => {
  const cluster = { prefix: '将吉祥物替换', apiNames: ['DOG', 'RAT', 'MON', 'DEV'] };

  test('劈开了就并到人数最多的那一节', () => {
    const before = new Map([
      ['DOG', '宝石与商店'], ['RAT', '宝石与商店'],
      ['MON', '吉祥物替换'], ['DEV', '吉祥物替换'], ['X', '别的'],
    ]);
    // 2:2 平票 —— 取小节名单里靠前的那个
    const { assignment, merges } = mergeSplitClusters(before, [cluster], ['吉祥物替换', '宝石与商店']);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].into, '吉祥物替换');
    for (const a of cluster.apiNames) assert.equal(assignment.get(a), '吉祥物替换');
    assert.equal(assignment.get('X'), '别的', '簇以外的一个都不许动');
  });

  test('人数不平时按人数,不看名单顺序', () => {
    const before = new Map([
      ['DOG', '宝石与商店'], ['RAT', '吉祥物替换'],
      ['MON', '吉祥物替换'], ['DEV', '吉祥物替换'],
    ]);
    const { assignment, merges } = mergeSplitClusters(before, [cluster], ['宝石与商店', '吉祥物替换']);
    assert.equal(merges[0].into, '吉祥物替换');
    assert.equal(merges[0].moved, 1);
    assert.equal(assignment.get('DOG'), '吉祥物替换');
  });

  // 模型自己把一簇放对了的时候,这个函数必须什么都不做
  test('没劈开就不动', () => {
    const before = new Map(cluster.apiNames.map((a) => [a, '吉祥物替换']));
    const { assignment, merges } = mergeSplitClusters(before, [cluster], ['吉祥物替换']);
    assert.deepEqual(merges, []);
    assert.deepEqual([...assignment], [...before]);
  });

  /**
   * 漏分的成就本来会「留在原来的小节」(`regroupByAssignment` 的兜底),而我们刚认定
   * 这一簇是同一类事 —— 让它落单等于新造一次劈分。
   */
  test('模型漏掉的那条跟着簇走', () => {
    const before = new Map([['DOG', '吉祥物替换'], ['RAT', '吉祥物替换'], ['MON', '宝石与商店']]);
    const { assignment } = mergeSplitClusters(before, [cluster], ['吉祥物替换', '宝石与商店']);
    assert.equal(assignment.get('DEV'), '吉祥物替换', '整簇没被分到过的那条也要落位');
  });

  test('整簇都没分到就不动 —— 无处可并', () => {
    const { assignment, merges } = mergeSplitClusters(new Map([['X', '别的']]), [cluster], []);
    assert.deepEqual(merges, []);
    assert.deepEqual([...assignment], [['X', '别的']]);
  });
});

describe('clusterConstraint(写进提示词的那段)', () => {
  const defs = [d('A', 'a'), d('B', 'b'), d('C', 'c'), d('D', 'd')];

  test('按编号列出各簇', () => {
    const s = clusterConstraint(defs, [{ prefix: 'x', apiNames: ['A', 'C', 'D'] }]);
    assert.match(s, /1 3 4/);
  });

  test('没有簇就是空串 —— 不能往提示词里插一段空规则', () => {
    assert.equal(clusterConstraint(defs, []), '');
    assert.equal(clusterConstraint(defs, null), '');
  });
});
