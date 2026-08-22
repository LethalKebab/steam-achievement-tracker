/**
 * 每家供应商一套自己的配置
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的是**一家的设置被当成另一家的用**。
 *
 * `ai` 下面原本只有一份 `apiKey` / `model` / `baseUrl`,而供应商有三家。于是
 * 「换一家试试」这个再普通不过的动作没有安全的写法:
 *
 *  - 设置页每次都要重新粘一遍 key(它至少**拒绝**沿用上一家的,见 `api.js` 里
 *    `effective` 那一行),而 `model` 连拒绝都没有
 *  - 命令行的 `--provider` 两样都没有:它翻了 provider、留着上一家的 key 直接发出去
 *
 * **那个 401 的措辞是这里最贵的部分**:错误写着「检查 ANTHROPIC_API_KEY」,而这个变量
 * 明明设对了 —— 真因是它压根没被读。一条把人指向反方向的报错比没有报错更费时间。
 *
 * 哪些字段进 `ai.providers`,是量出来的而不是拍的:**被不止一家读、且各家的正确值
 * 不同**的,只有 `apiKey` / `model` / `baseUrl` 三个。`maxTokens`、`effort` 这些是
 * 跨家预算(同一个值在哪家都对);`geminiTools`、`webFetch`、`searchTool` 这些只有
 * 一家会读,留着上一家的值只会被忽略,不会被误用。
 *
 * 三条规则:
 *
 *  - **环境变量按被问的那家取**,不按 config.json 里写的那家取
 *  - **`providers[家]` 是每家自己的一套**,互不覆盖
 *  - **legacy 的扁平字段只属于 `ai.provider` 那一家**,而且**归户要在任何
 *    provider 覆盖生效之前发生** —— 顺序反了就等于把上一家的 key 送给新一家
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// loadConfig 的 CONFIG_PATH 是模块级、import 时就定死的,所以 TRACKER_DATA_DIR 必须在
// **动态** import 之前设好。整个文件共用一个临时目录,每个用例自己重写 config.json
const DIR = mkdtempSync(join(tmpdir(), 'aiproviders-'));
process.env.TRACKER_DATA_DIR = DIR;
const { resolveAiKey, canonicalAiProvider, switchAiProvider, loadConfig, saveConfig } =
  await import('../lib/config.js');

const writeConfig = (ai) =>
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({ steamApiKey: 'x', steamId: 'y', ai }));

/** 每个用例自带一份干净的假环境,绝不读真的 process.env */
const env = (o = {}) => ({ ...o });

// ---------------------------------------------------------------------------
// 供应商名的归一
// ---------------------------------------------------------------------------

describe('canonicalAiProvider', () => {
  test('别名收敛到同一家 —— 一家一套,不按端点分', () => {
    // google 是 gemini 的别名(createProvider 也这么认);deepseek-openai 是同一个
    // 供应商的另一个端点,**同一把 key**,分成两套只会让人粘两遍
    assert.equal(canonicalAiProvider('google'), 'gemini');
    assert.equal(canonicalAiProvider('GEMINI'), 'gemini');
    assert.equal(canonicalAiProvider('deepseek-openai'), 'deepseek');
    assert.equal(canonicalAiProvider('Anthropic'), 'anthropic');
  });

  test('不认识的名字原样返回,不猜', () => {
    // 自建端点、代理服务可以叫任何名字。猜错了会去读一个不存在的环境变量,
    // 而那比"这一家我不认识"难查得多
    assert.equal(canonicalAiProvider('my-proxy'), 'my-proxy');
    assert.equal(canonicalAiProvider(''), '');
    assert.equal(canonicalAiProvider(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// 取 key
// ---------------------------------------------------------------------------

describe('resolveAiKey', () => {
  test('环境变量按**被问的那家**取,不按配置里写的那家', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS', providers: {} };
    const e = env({ ANTHROPIC_API_KEY: 'ANT', DEEPSEEK_API_KEY: 'DS-ENV' });
    assert.equal(resolveAiKey(ai, 'anthropic', e), 'ANT');
    assert.equal(resolveAiKey(ai, 'deepseek', e), 'DS-ENV');
  });

  test('环境变量压过文件 —— 临时试一把新 key 不用改文件', () => {
    const ai = { provider: 'anthropic', providers: { anthropic: { apiKey: 'FROM-FILE' } } };
    assert.equal(resolveAiKey(ai, 'anthropic', env({ ANTHROPIC_API_KEY: 'FROM-ENV' })), 'FROM-ENV');
    assert.equal(resolveAiKey(ai, 'anthropic', env()), 'FROM-FILE');
  });

  test('每家一套,互不覆盖', () => {
    const ai = {
      provider: 'gemini',
      providers: { anthropic: { apiKey: 'ANT' }, gemini: { apiKey: 'GEM' }, deepseek: { apiKey: 'DS' } },
    };
    assert.equal(resolveAiKey(ai, 'anthropic', env()), 'ANT');
    assert.equal(resolveAiKey(ai, 'gemini', env()), 'GEM');
    assert.equal(resolveAiKey(ai, 'deepseek', env()), 'DS');
    assert.equal(resolveAiKey(ai, 'deepseek-openai', env()), 'DS', '同一家的另一个端点共用一把');
  });

  test('legacy 的扁平 apiKey 只属于 ai.provider 那一家', () => {
    // 老配置只有一个槽位,它装的必然是当时那个 provider 的 key,所以给那一家兜底是对的
    const ai = { provider: 'deepseek', apiKey: 'DS-LEGACY' };
    assert.equal(resolveAiKey(ai, 'deepseek', env()), 'DS-LEGACY', '老配置必须继续能用');
  });

  test('**这就是那个 bug**:问别家要 key 时,legacy 槽位不许兜底', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS-LEGACY' };
    assert.equal(
      resolveAiKey(ai, 'anthropic', env()), '',
      'DeepSeek 的 key 被发去了 Anthropic —— 那个 401 会说「检查 ANTHROPIC_API_KEY」,指向反方向'
    );
  });

  test('providers 槽位压过 legacy —— 迁移之后老值不再生效', () => {
    const ai = { provider: 'anthropic', apiKey: 'OLD', providers: { anthropic: { apiKey: 'NEW' } } };
    assert.equal(resolveAiKey(ai, 'anthropic', env()), 'NEW');
  });

  test('首尾空白一律去掉', () => {
    // 复制粘贴带上换行是 401 最常见的原因,而报出来的错完全指不到这个方向。
    // 三条来路都要去,漏一条这个保护就只在某些写法下成立
    assert.equal(resolveAiKey({ providers: { gemini: { apiKey: '  G  ' } } }, 'gemini', env()), 'G');
    assert.equal(resolveAiKey({ provider: 'gemini', apiKey: '\tG\n' }, 'gemini', env()), 'G');
    assert.equal(resolveAiKey({}, 'gemini', env({ GEMINI_API_KEY: ' G ' })), 'G');
  });

  test('哪儿都没有就是空字符串,不是 undefined', () => {
    // 调用方到处在写 `if (!config.ai.apiKey)`,给个 undefined 只是把判断推给别人
    assert.equal(resolveAiKey({}, 'anthropic', env()), '');
    assert.equal(resolveAiKey(null, 'anthropic', env()), '');
  });
});

// ---------------------------------------------------------------------------
// 换一家:三个字段一起换
// ---------------------------------------------------------------------------

describe('switchAiProvider', () => {
  const AI = {
    provider: 'deepseek',
    providers: {
      anthropic: { apiKey: 'ANT', model: 'claude-opus-5' },
      gemini: { apiKey: 'GEM', model: 'gemini-flash-latest' },
      deepseek: { apiKey: 'DS', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/anthropic' },
    },
  };

  test('key 和 model 一起换 —— **换回来的时候那家自己的 model 还在**', () => {
    // 这是把 model 也放进 providers 的全部理由。原来只有一份 `model`,换家时只能清空
    // (上一家的模型名带过去必然撞 assertModelMatchesProvider),于是"我给 Anthropic
    // pin 的版本"在切去 Gemini 再切回来之后就没了 —— 而且不报错,只是悄悄用回默认值
    const a = switchAiProvider(AI, 'anthropic', env());
    assert.equal(a.apiKey, 'ANT');
    assert.equal(a.model, 'claude-opus-5');

    const g = switchAiProvider(a, 'gemini', env());
    assert.equal(g.apiKey, 'GEM');
    assert.equal(g.model, 'gemini-flash-latest');

    assert.equal(switchAiProvider(g, 'anthropic', env()).model, 'claude-opus-5', '切回来该原样还在');
  });

  test('baseUrl 也跟着走 —— 它同样是一家一个值', () => {
    // baseUrl 被 anthropic 和 deepseek 两家读,而一个 DeepSeek 的兼容端点 URL
    // 送给 anthropic 就是在拿别人的地址发请求。留在扁平层就会这样串
    assert.equal(switchAiProvider(AI, 'deepseek', env()).baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(switchAiProvider(AI, 'anthropic', env()).baseUrl, '', '别家的端点地址不许带过来');
  });

  test('显式指定 model 时以它为准', () => {
    assert.equal(switchAiProvider(AI, 'anthropic', env(), { model: 'claude-sonnet-5' }).model, 'claude-sonnet-5');
  });

  test('换到一家什么都没配的,三个字段都是空 —— 不留上一家的', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS', model: 'deepseek-v4-flash', providers: {} };
    const next = switchAiProvider(ai, 'gemini', env());
    assert.equal(next.apiKey, '');
    assert.equal(next.model, '');
    assert.equal(next.baseUrl, '');
  });

  test('不改原对象 —— 调用方手里那份配置不能被就地改掉', () => {
    const ai = { provider: 'deepseek', apiKey: 'DS', model: 'm', providers: { anthropic: { apiKey: 'ANT' } } };
    switchAiProvider(ai, 'anthropic', env());
    assert.equal(ai.provider, 'deepseek');
    assert.equal(ai.apiKey, 'DS');
    assert.equal(ai.model, 'm');
  });

  test('跨家的预算旋钮原样带着走 —— 它们不是一家一个值', () => {
    const ai = { provider: 'gemini', providers: {}, maxTokens: 12345, effort: 'low', chunkSize: 20 };
    const next = switchAiProvider(ai, 'anthropic', env());
    assert.equal(next.maxTokens, 12345);
    assert.equal(next.effort, 'low');
    assert.equal(next.chunkSize, 20);
  });
});

// ---------------------------------------------------------------------------
// loadConfig 这一侧
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('当前这家的三个字段被摊平到 ai 上,下游一个字都不用改', () => {
    writeConfig({
      provider: 'gemini',
      providers: { anthropic: { apiKey: 'ANT', model: 'claude-opus-5' }, gemini: { apiKey: 'GEM', model: 'gemini-3-pro' } },
    });
    const { ai } = loadConfig();
    assert.equal(ai.apiKey, 'GEM');
    assert.equal(ai.model, 'gemini-3-pro');
  });

  test('只有 legacy 扁平字段的老配置照常工作', () => {
    writeConfig({ provider: 'deepseek', apiKey: 'DS-LEGACY', model: 'deepseek-v4-flash' });
    const { ai } = loadConfig();
    assert.equal(ai.apiKey, 'DS-LEGACY');
    assert.equal(ai.model, 'deepseek-v4-flash');
  });

  /**
   * **归户必须发生在 AI_PROVIDER 覆盖之前。**
   *
   * legacy 扁平槽位的主人是**文件里写着的那个 provider**,而不是环境变量或 `--provider`
   * 切过去的那个。先覆盖再归户,等于把上一家的 key 认成新一家的 —— 也就是这套改动
   * 要修的那个 bug,只是换了个地方重新长出来。
   */
  test('AI_PROVIDER 换家时,legacy 槽位不会被认成新那家的', () => {
    writeConfig({ provider: 'deepseek', apiKey: 'DS-LEGACY', model: 'deepseek-v4-flash' });
    process.env.AI_PROVIDER = 'anthropic';
    try {
      const { ai } = loadConfig();
      assert.equal(ai.provider, 'anthropic');
      assert.equal(ai.apiKey, '', 'DeepSeek 的 key 被认成了 Anthropic 的');
      assert.equal(ai.model, '', 'DeepSeek 的模型名带过去会撞 assertModelMatchesProvider');
    } finally {
      delete process.env.AI_PROVIDER;
    }
  });

  test('AI_PROVIDER 换到一家配好了的,拿的是那家自己的整套', () => {
    writeConfig({
      provider: 'deepseek',
      apiKey: 'DS-LEGACY',
      providers: { anthropic: { apiKey: 'ANT', model: 'claude-opus-5' } },
    });
    process.env.AI_PROVIDER = 'anthropic';
    try {
      const { ai } = loadConfig();
      assert.equal(ai.apiKey, 'ANT');
      assert.equal(ai.model, 'claude-opus-5');
    } finally {
      delete process.env.AI_PROVIDER;
    }
  });

  test('AI_MODEL 压过存着的 model —— 它是"这一次用哪个"的临时覆盖', () => {
    writeConfig({ provider: 'gemini', providers: { gemini: { apiKey: 'GEM', model: 'gemini-flash-latest' } } });
    process.env.AI_MODEL = 'gemini-3-pro';
    try {
      assert.equal(loadConfig().ai.model, 'gemini-3-pro');
    } finally {
      delete process.env.AI_MODEL;
    }
  });

  test('ai.providers 原样留在配置里 —— 设置页要靠它知道哪几家已经配好了', () => {
    writeConfig({ provider: 'gemini', providers: { anthropic: { apiKey: 'ANT' }, gemini: { apiKey: 'GEM' } } });
    assert.deepEqual(Object.keys(loadConfig().ai.providers).sort(), ['anthropic', 'gemini']);
  });

  /**
   * **保存一家不能抹掉另一家。**
   *
   * 这是这套改动里唯一会**静默丢数据**的方向:设置页保存 Gemini 时如果把整份
   * `providers` 写回去,Anthropic 那套就没了,而页面会显示「保存成功」。用户下次换
   * 回去才发现,那时已经无从知道是什么时候丢的。
   *
   * 靠的是 `saveConfig` 的 merge 递归下钻。**它是递归的这件事必须被钉住** ——
   * 改成浅合并不会让任何现有测试变红,而后果就是上面那段。
   */
  test('保存一家不会抹掉别家', () => {
    writeConfig({
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'ANT', model: 'claude-opus-5' }, gemini: { apiKey: 'GEM' } },
    });
    saveConfig({ ai: { provider: 'deepseek', providers: { deepseek: { apiKey: 'DS', model: '' } } } });

    const { ai } = loadConfig();
    assert.equal(ai.providers.anthropic.apiKey, 'ANT', 'Anthropic 那套被保存 DeepSeek 的动作抹掉了');
    assert.equal(ai.providers.anthropic.model, 'claude-opus-5', 'model 也要一起活下来');
    assert.equal(ai.providers.gemini.apiKey, 'GEM');
    assert.equal(ai.apiKey, 'DS', '当前 provider 的 key 要解析出来');
  });
});
