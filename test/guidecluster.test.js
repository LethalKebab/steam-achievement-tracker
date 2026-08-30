import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sameKindClusters, mergeSplitClusters, clusterConstraint } from '../lib/guidecluster.js';

/** Builds a batch of achievements: `d('A1','将吉祥物替换为一只怪物。')` */
const d = (api, description, name = api) => ({ api_name: api, name_cn: name, description });
/** Pads the count so the MAX_SHARE rule does not misfire on a small sample */
const pad = (n) => Array.from({ length: n }, (_, i) => d(`PAD${i}`, `毫不相干的第${i}件事情要做完`));

describe('sameKindClusters (recognising same-kind achievements)', () => {
  test('descriptions from the same template form one cluster', () => {
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
   * **This is the case this module exists for.** Of 《马特的寻猫游戏》's four
   * mascot-replacement achievements, three read 「替换**为**」 and the fourth reads
   * 「替换**成**」 — and the odd one out is precisely the one that was split off into
   * another section. A greedy longest-prefix-claims-first pass misses it, which is why
   * there is a second absorption pass.
   */
  test('a near relative differing by one character is absorbed too', () => {
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
   * Terraria has 22 「Defeat …」 achievements, and early-game bosses and post-Wall bosses
   * genuinely should be separate.
   * **The prefix has to cover more than half the mean description length** is exactly what
   * blocks this — without it, this check would merge things it should not across a great
   * many games, and a wrong merge is invisible.
   */
  test('a common verb does not form a cluster — the prefix is too short to cover half the description', () => {
    const defs = [
      d('W1', 'Defeat the Eye of Cthulhu, a floating demonic eyeball.'),
      d('W2', 'Defeat Skeletron, the cursed guardian of the dungeon.'),
      d('W3', 'Defeat the Wall of Flesh, the pinnacle of the underworld.'),
      d('W4', 'Defeat Plantera, the overgrown terror of the jungle.'),
      ...pad(40),
    ];
    assert.deepEqual(sameKindClusters(defs), []);
  });

  test('two do not make a kind', () => {
    const defs = [d('A', '收集全部的红色宝石。'), d('B', '收集全部的蓝色宝石。'), ...pad(40)];
    assert.deepEqual(sameKindClusters(defs), []);
  });

  // In a small game, 8 entries may be half the guide, and forcing a merge would flatten the whole structure
  test('one cluster must not take too large a share', () => {
    const four = [
      d('A', '扩建你的房间。'), d('B', '扩建你的卧室。'),
      d('C', '扩建你的客厅。'), d('D', '扩建你的厨房。'),
    ];
    const noise = (n) => Array.from({ length: n }, (_, i) => d(`N${i}`, `毫不相干的第${i}件事情`));
    assert.deepEqual(sameKindClusters([...four, ...noise(2)]), [],
      '4 of 6 achievements in one cluster — two thirds, and merging them rewrites the guide\'s whole structure');
    assert.equal(sameKindClusters([...four, ...noise(40)]).length, 1,
      'the same batch inside a large game should be recognised — what blocks it is the share, not any other rule');
  });

  test('an achievement with no description does not take part', () => {
    const defs = [d('A', ''), d('B', null), d('C', undefined), ...pad(40)];
    assert.deepEqual(sameKindClusters(defs), []);
  });

  test('empty input does not blow up', () => {
    assert.deepEqual(sameKindClusters([]), []);
    assert.deepEqual(sameKindClusters(null), []);
  });
});

describe('mergeSplitClusters (putting a split cluster back together)', () => {
  const cluster = { prefix: '将吉祥物替换', apiNames: ['DOG', 'RAT', 'MON', 'DEV'] };

  test('a split cluster is merged into the section holding the most of it', () => {
    const before = new Map([
      ['DOG', '宝石与商店'], ['RAT', '宝石与商店'],
      ['MON', '吉祥物替换'], ['DEV', '吉祥物替换'], ['X', '别的'],
    ]);
    // A 2:2 tie — the one earlier in the section list wins
    const { assignment, merges } = mergeSplitClusters(before, [cluster], ['吉祥物替换', '宝石与商店']);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].into, '吉祥物替换');
    for (const a of cluster.apiNames) assert.equal(assignment.get(a), '吉祥物替换');
    assert.equal(assignment.get('X'), '别的', 'nothing outside the cluster may be touched');
  });

  test('an uneven count goes by count and ignores the list order', () => {
    const before = new Map([
      ['DOG', '宝石与商店'], ['RAT', '吉祥物替换'],
      ['MON', '吉祥物替换'], ['DEV', '吉祥物替换'],
    ]);
    const { assignment, merges } = mergeSplitClusters(before, [cluster], ['宝石与商店', '吉祥物替换']);
    assert.equal(merges[0].into, '吉祥物替换');
    assert.equal(merges[0].moved, 1);
    assert.equal(assignment.get('DOG'), '吉祥物替换');
  });

  // When the model placed a cluster correctly itself, this function has to do nothing
  test('an unsplit cluster is left alone', () => {
    const before = new Map(cluster.apiNames.map((a) => [a, '吉祥物替换']));
    const { assignment, merges } = mergeSplitClusters(before, [cluster], ['吉祥物替换']);
    assert.deepEqual(merges, []);
    assert.deepEqual([...assignment], [...before]);
  });

  /**
   * An achievement the model missed would otherwise "stay in its original section"
   * (`regroupByAssignment`'s fallback), and we have just decided this cluster is one kind of
   * thing — leaving it orphaned would create a fresh split.
   */
  test('the one the model missed travels with the cluster', () => {
    const before = new Map([['DOG', '吉祥物替换'], ['RAT', '吉祥物替换'], ['MON', '宝石与商店']]);
    const { assignment } = mergeSplitClusters(before, [cluster], ['吉祥物替换', '宝石与商店']);
    assert.equal(assignment.get('DEV'), '吉祥物替换', 'the one the whole cluster never had assigned has to land too');
  });

  test('a cluster with nothing assigned at all is left alone — there is nowhere to merge into', () => {
    const { assignment, merges } = mergeSplitClusters(new Map([['X', '别的']]), [cluster], []);
    assert.deepEqual(merges, []);
    assert.deepEqual([...assignment], [['X', '别的']]);
  });
});

describe('clusterConstraint (the passage written into the prompt)', () => {
  const defs = [d('A', 'a'), d('B', 'b'), d('C', 'c'), d('D', 'd')];

  test('each cluster is listed by number', () => {
    const s = clusterConstraint(defs, [{ prefix: 'x', apiNames: ['A', 'C', 'D'] }]);
    assert.match(s, /1 3 4/);
  });

  test('no clusters means an empty string — an empty rule must not be spliced into the prompt', () => {
    assert.equal(clusterConstraint(defs, []), '');
    assert.equal(clusterConstraint(defs, null), '');
  });
});
