/**
 * 终端专属建议没有丢
 * ------------------------------------------------
 * 库里的错误消息现在只说**发生了什么**,因为同一句话会原样出现在 Dashboard 的浮窗上,
 * 而那边(尤其打包版)的用户没有终端、也不该被要求去编辑 config.json。
 *
 * 但「加 --provider X」「调大 ai.maxAchievements」这类建议对终端用户是最有用的东西,
 * 不该为了迁就另一个界面而蒸发。它们搬去了 `tracker.js` 的 `CLI_HINTS`,按错误的
 * `code` 挂。**这个文件的存在理由就是那次搬家**:原来有三条测试钉着这些话在消息正文里,
 * 改完之后那三条自然失效,如果不在新位置重新钉一遍,等于悄悄删掉了一份保证。
 *
 * 按源码文本查,和 `html-smoke.test.js` / `SKILL_RULE_DISPOSITION` 是同一路数 ——
 * `tracker.js` 是 CLI 入口,一 import 就会去跑命令,没法直接把常量拿出来。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tracker = readFileSync(join(ROOT, 'tracker.js'), 'utf8');

/** CLI_HINTS 那个对象字面量的正文 */
function hintsBlock() {
  const start = tracker.indexOf('const CLI_HINTS = {');
  assert.notEqual(start, -1, '找不到 CLI_HINTS —— 提取逻辑坏了,不是建议没了');
  const end = tracker.indexOf('\n};', start);
  assert.notEqual(end, -1, 'CLI_HINTS 没有正常收尾');
  return tracker.slice(start, end);
}

describe('CLI_HINTS 覆盖了库里带 detail 的每一个错误码', () => {
  const block = hintsBlock();

  // 库里 throw 出来、而且终端还有话要补的那几个
  const CODES = [
    'provider-model-mismatch', 'too-many-achievements',
    'chunk-too-small', 'guide-exists', 'file-exists',
  ];
  for (const code of CODES) {
    test(code, () => {
      assert.ok(block.includes(`'${code}'`), `${code} 没有对应的终端建议`);
    });
  }

  test('库里挂出来的每个 code 都在这张表里 —— 加了新 code 别忘了终端那一侧', () => {
    const codes = new Set();
    for (const f of ['lib/ai.js', 'lib/guidegen.js', 'lib/notion.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/err\.code = '([a-z-]+)'/g)) codes.add(m[1]);
    }
    // no-schema 是有意不在表里的:它的意思是"Steam 上就没有这个游戏的成就",
    // 终端也给不出别的办法。列在这里是为了让"漏了"和"故意不给"分得开
    const NO_HINT_NEEDED = new Set(['no-schema']);
    const missing = [...codes].filter((c) => !NO_HINT_NEEDED.has(c) && !block.includes(`'${c}'`));
    assert.deepEqual(missing, [], `这些 code 在库里抛出来了,但终端没有对应建议:${missing.join(', ')}`);
  });

  test('原来钉在消息正文里的那几句话,一句都没少', () => {
    // 供应商/模型对不上:两条修法 + 那个最容易看不见的来源
    assert.match(block, /--provider \$\{d\.belongsTo\}/, '要给出直接可用的修法');
    assert.match(block, /--model/, '另一个方向的修法也要给');
    assert.match(block, /环境变量会盖掉 config\.json/, '这是最容易看不见的那种来源');
    // 成就太多:该调哪个、现在是多少
    assert.match(block, /ai\.maxAchievements/);
    // 切到下限还写不完:**反过来劝阻**,这条比前两条更容易被写反
    assert.match(block, /别急着调大 ai\.maxTokens/);
  });

  test('这些话只在终端出现,库里不能再有一份', () => {
    // 有一份拷贝留在库里,就等于 Dashboard 上还会冒出命令行 —— 而这正是要修的
    for (const f of ['lib/ai.js', 'lib/guidegen.js', 'lib/notion.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      // 只看会被 throw 出去的字符串:注释里提这些名字是正常的(它们本来就在解释配置)
      const thrown = [...src.matchAll(/(?:new Error|new AiError)\(([\s\S]{0,400}?)\)\s*;/g)]
        .map((m) => m[1])
        .join('\n');
      assert.doesNotMatch(thrown, /node tracker\.js/, `${f} 的报错里还在教人敲命令`);
      assert.doesNotMatch(thrown, /Remove-Item|PowerShell/, `${f} 的报错里还有终端专属指令`);
    }
  });
});
