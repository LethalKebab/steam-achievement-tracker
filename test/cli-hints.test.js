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
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tracker = readFileSync(join(ROOT, 'tracker.js'), 'utf8');

/** lib/ 下所有 .js。**列举而不是写死清单** —— 写死的清单会漏掉后来新增的文件 */
const libFiles = () => readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));

/**
 * 这几个文件里的命令行是**对的**,因为它们的字符串只走终端,进不了 Dashboard 的浮窗。
 *
 * 逐个写明理由,而不是把检查放宽 —— 「故意豁免」和「漏了一个」必须分得开。
 * 下面那条测试会检查这些文件还在,免得改个文件名就把豁免变成一个静默的洞。
 */
const TERMINAL_ONLY = {
  // loadConfig 的 HINTS:凭据没配时抛在**启动**阶段。Dashboard 那条路走的是
  // 302 到 /setup,以及 startBackgroundSync 自己那句不提命令行的提示
  'config.js': '凭据缺失是启动期错误,页面那条路是跳设置页',
  // log() 打到服务进程的控制台(打包版进 stderr 管子),不是页面
  'server.js': 'log() 写的是服务端控制台,不是浮窗',
};

/**
 * 一份源码里所有**会给用户看**的字符串字面量,注释已经剔掉。
 *
 * 注释里提 `sync --schema`、`--overwrite` 是正常的(它们本来就在解释这些开关存在的
 * 理由、以及为什么不再往消息里写),所以按注释过滤而不是按整文件搜 —— 否则这条检查
 * 会逼人把解释也删掉,而那些解释正是下一个人需要读到的东西。
 */
function userFacingStrings(src) {
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out = [];
  // 单引号、双引号、反引号三种字面量
  for (const re of [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g]) {
    for (const m of noComments.matchAll(re)) if (m[1].trim()) out.push(m[1]);
  }
  return out;
}

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
    'bad-api-key', 'deepseek-length',
    'gemini-model-retired', 'gemini-model-unknown', 'gemini-no-allowance',
    'gemini-429-no-detail', 'gemini-tool-rejected',
  ];
  for (const code of CODES) {
    test(code, () => {
      assert.ok(block.includes(`'${code}'`), `${code} 没有对应的终端建议`);
    });
  }

  test('库里挂出来的每个 code 都在这张表里 —— 加了新 code 别忘了终端那一侧', () => {
    const codes = new Set();
    for (const f of libFiles()) {
      const src = readFileSync(join(ROOT, 'lib', f), 'utf8');
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
    // Gemini:模型名那一类三条都指向同一句建议
    assert.match(tracker, /const GEMINI_MODEL_HINT/);
    assert.match(tracker, /ai-check --models/, '「怎么查有哪些模型可用」不能丢');
    assert.match(tracker, /列出来 ≠ 能用/, '停售的模型照样在列表里,这点是踩出来的');
    assert.match(block, /AI_MODEL=gemini-2\.5-flash/, '要给一个具体能试的模型');
    assert.match(block, /别名/, '别名可能解析到不在免费层的新模型');
    assert.match(block, /geminiTools/);
    // DeepSeek 的 401:环境变量会盖掉配置文件,而清它只能在终端做
    assert.match(block, /Remove-Item Env:\$\{d\.envVar\}/);
  });

  test('这些话只在终端出现,库里不能再有一份', () => {
    // 有一份拷贝留在库里,就等于 Dashboard 上还会冒出命令行 —— 而这正是要修的。
    //
    // **扫整个 lib/,不是只扫改过的那几个文件。** 第一版只列了 ai / guidegen / notion
    // 三个(改动碰到的那三个),于是 guides.js 和 guidelint.js 里两句同样的
    // 「先跑 sync --schema」全身而过 —— 是打完包去 exe 里搜才发现的。
    // 一条"清光了"的检查,扫描范围比断言本身更要紧
    for (const f of libFiles()) {
      if (TERMINAL_ONLY[f]) continue;
      const src = readFileSync(join(ROOT, 'lib', f), 'utf8');
      const bad = [];
      for (const s of userFacingStrings(src)) {
        if (/node tracker\.js|sync --schema|--overwrite|--local\b/.test(s)) bad.push(s.slice(0, 70));
        if (/Remove-Item|PowerShell|Get-ChildItem/.test(s)) bad.push(s.slice(0, 70));
      }
      assert.deepEqual(bad, [], `lib/${f} 里这些给用户看的字符串还带着命令行:\n  ${bad.join('\n  ')}`);
    }
  });

  test('豁免清单里的文件必须还在 —— 文件改了名,豁免就成了一个静默的洞', () => {
    const have = new Set(libFiles());
    const gone = Object.keys(TERMINAL_ONLY).filter((f) => !have.has(f));
    assert.deepEqual(gone, [], `这些文件不在 lib/ 了,豁免条目该删:${gone.join(', ')}`);
  });
});

/**
 * 取值型 flag 漏登记会**静默错位**,不会报错。
 *
 * `positionalArgs` 靠 `VALUE_FLAGS` 才知道 `--effort low 648800` 里 `low` 是值、
 * `648800` 才是 appid。漏登记的话 appid 会变成 `low`,而报出来的是
 * 「找不到这个游戏」之类跟 `--effort` 毫无关系的话 —— 照着那句话查永远查不到真因。
 * `--rounds` 当年就是为这个进的表(注释里写着 `guide-gen --rounds 2 1937500`)。
 */
describe('取值型 flag 都登记进 VALUE_FLAGS 了', () => {
  const valueFlags = new Set(
    (tracker.match(/const VALUE_FLAGS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '')
      .split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
  );

  test('flagValue 读的每一个 flag 都在表里', () => {
    // flagValue('x') 的意思就是"x 后面跟着一个值",所以它和 VALUE_FLAGS 必须一一对应。
    // 少一个就错位,而错位不报错
    const read = new Set([...tracker.matchAll(/flagValue\('([^']+)'\)/g)].map((m) => '--' + m[1]));
    const missing = [...read].filter((f) => !valueFlags.has(f));
    assert.deepEqual(missing, [],
      `这些 flag 后面跟着值,却没进 VALUE_FLAGS:${missing.join(' ')} —— `
      + '于是那个值会被当成位置参数(appid),报出来的错跟真因毫无关系');
  });

  test('--effort 能透到请求体里,而且是 flag 不是设置项', () => {
    assert.ok(valueFlags.has('--effort'), '--effort low 648800 会把 low 当 appid');
    const fn = tracker.slice(tracker.indexOf('function applyAiFlags'));
    const body = fn.slice(0, fn.indexOf('\n}')).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(body, /config\.ai\.effort\s*=\s*effort/,
      'applyAiFlags 要真的把它写进 config.ai.effort —— 注释里提到不算,'
      + '这个文件的开头就写着为什么源码断言必须先剥注释');
  });
});
