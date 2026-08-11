/**
 * AI 攻略生成编排的测试
 * ------------------------------------------------
 * 跑法:node --test
 *
 * 这个文件守的失败类是**没验过的东西溜进用户的笔记**,以及几条结构性保证会不会被绕开。
 * 前面几个文件守的是"算得对不对",这里守的是"该拦住的有没有拦住":
 *
 *  - **草稿绝不能被攻略发现逻辑扫到**。扫到就登记进 guides 表,接着 checkbox-sync
 *    拿一份三轮都没过的攻略去勾用户的框——正是整个方案明令禁止的事
 *  - **`appid:` 行由程序写**。模型抄错一位数,攻略就登记到另一款游戏上,而两边都不会报错
 *  - **`checked-mismatch` 永远不回灌给模型**。回灌等于要求它写 `- [x]`,
 *    而"模型只写 `- [ ]`、程序按数据库打勾"是这套设计的地基
 *  - **名字撞车的成就豁免 checked-mismatch**,否则那 3 款中英文都同名的游戏永远过不了关;
 *    但豁免必须**按名字**算——中文名撞车、英文名唯一的照样勾得上,错误豁免会把真问题藏掉
 *
 * 不联网:供应商和 Steam 都是假的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb, insertGame, replaceAchievements, upsertGuide, allGuides,
} from '../lib/db.js';
import { unnameableApiNames } from '../lib/guidelint.js';
import { syncGuidesFromMarkdown } from '../lib/guides.js';
import {
  generateGuide,
  planGuide,
  splitFindings,
  buildFeedback,
  extractMarkdown,
  stripLeadingHeader,
  buildHeader,
  guideFileName,
  buildAchievementList,
  buildSystemPrompt,
  SKILL_RULE_DISPOSITION,
  DRAFTS_DIR,
} from '../lib/guidegen.js';

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

const DEFS = [def('A', '第一步', '完成第一关。'), def('B', '第二步', '完成第二关。')];

/** achievements 表读出来是 snake_case,写进去要 camelCase —— 这里做一次转换 */
const toRow = (d) => ({
  apiName: d.api_name,
  gameName: d.game_name,
  nameCn: d.name_cn,
  nameEn: d.name_en,
  description: d.description,
  hidden: 0,
  icon: '',
});

function freshEnv({ defs = DEFS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guidegen-'));
  const db = openDb(':memory:');
  insertGame(db, { appid: '1', name: '测试游戏' });
  replaceAchievements(db, '1', defs.map(toRow));
  return { db, config: { guidesDir: dir, ai: { maxAchievements: 100 } } };
}

/** 按顺序吐出预设回复,并记下每次发过去的 user 消息 */
function fakeProvider(replies) {
  return {
    model: 'claude-opus-5',
    asked: [],
    // 联网工具由供应商自己声明,编排层只是转发。测试里不需要真的工具
    webTools: () => [],
    async send({ messages }) {
      this.asked.push(messages.at(-1).content);
      const text = replies[this.asked.length - 1];
      if (text === undefined) throw new Error('fakeProvider 的回复用完了');
      return {
        content: [{ type: 'text', text }],
        text,
        stopReason: 'end_turn',
        stopDetails: null,
        usage: {
          inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0,
          cacheReadTokens: 0, webSearches: 1, requests: 1,
        },
        model: 'claude-opus-5',
        continuations: 0,
        toolErrors: [],
      };
    },
  };
}

const fakeSteam = (unlocked = ['A'], rarity = null) => ({
  async fetchPlayerAchievements() {
    return { achievements: DEFS.map((d) => ({ apiname: d.api_name, achieved: unlocked.includes(d.api_name) ? 1 : 0 })) };
  },
  // 全球解锁率是锦上添花的数据,拿不到就返回 null,流程照走
  async fetchGlobalAchievementPercentages() {
    return rarity;
  },
});

const GOOD = '```markdown\n## 主线\n\n- [ ] **第一步**<br>完成第一关。<br>开局就能拿\n- [ ] **第二步**<br>完成第二关。<br>接着打\n```';
const MISSING_B = '```markdown\n## 主线\n\n- [ ] **第一步**<br>完成第一关。\n```';

// ---------------------------------------------------------------------------
// 名字撞车 → 机械打勾够不着
// ---------------------------------------------------------------------------

describe('unnameableApiNames', () => {
  test('中英文都撞车 → 两个都够不着', () => {
    const defs = [def('A', '妙手空空', '偷 10 次', 'Skilled Thief'), def('B', '妙手空空', '偷 100 次', 'Skilled Thief')];
    assert.deepEqual([...unnameableApiNames(defs)].sort(), ['A', 'B']);
  });

  test('只有中文名撞车、英文名唯一 → 照样勾得上,不能豁免', () => {
    // 12 款同名游戏里有 9 款是这种(Steam 的本地化 bug)。错误豁免会把真问题藏起来
    const defs = [
      def('A', '亦敌亦友', '描述一', 'Frenemy'),
      def('B', '亦敌亦友', '描述二', 'Frenemies'),
    ];
    assert.equal(unnameableApiNames(defs).size, 0);
  });

  test('名字全都唯一 → 空集', () => {
    assert.equal(unnameableApiNames(DEFS).size, 0);
  });
});

describe('splitFindings', () => {
  const mismatch = (apiName) => ({ level: 'error', code: 'checked-mismatch', apiName, message: 'x' });

  test('撞车成就的 checked-mismatch 算预期内,不拦', () => {
    const { blocking, expected } = splitFindings([mismatch('A')], new Set(['A']));
    assert.equal(blocking.length, 0);
    assert.equal(expected.length, 1);
  });

  test('没撞车的 checked-mismatch 必须拦 —— 那是我们自己打勾出了错', () => {
    const { blocking } = splitFindings([mismatch('Z')], new Set(['A']));
    assert.equal(blocking.length, 1);
  });

  test('豁免只对 checked-mismatch 生效,别的规则照拦', () => {
    const { blocking } = splitFindings(
      [{ level: 'error', code: 'missing-checkbox', apiName: 'A', message: 'x' }],
      new Set(['A'])
    );
    assert.equal(blocking.length, 1);
  });

  test('warn 不进 blocking', () => {
    const { blocking } = splitFindings([{ level: 'warn', code: 'paraphrased-description', message: 'x' }], new Set());
    assert.equal(blocking.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 回灌内容
// ---------------------------------------------------------------------------

test('回灌给模型的清单里绝不出现 checked-mismatch', () => {
  const fb = buildFeedback([
    { level: 'error', code: 'missing-checkbox', message: '成就没有对应的 checkbox 行:第二步' },
    { level: 'error', code: 'checked-mismatch', message: '成就已解锁但框没勾:第一步' },
  ]);
  assert.match(fb, /第二步/);
  assert.doesNotMatch(fb, /已解锁但框没勾/, '让模型去改勾选状态,它就会开始瞎写 - [x]');
  assert.match(fb, /完整的修改后全文/, '要全文,不然拼不回一份完整攻略');
});

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

describe('extractMarkdown', () => {
  test('抠出围栏里的内容', () => {
    assert.equal(extractMarkdown('好的:\n```markdown\n# 标题\n```\n写完了'), '# 标题');
  });
  test('多个围栏取最长的(正文一定比零碎示例长)', () => {
    assert.equal(extractMarkdown('```\n短\n```\n中间\n```markdown\n很长很长的正文\n```'), '很长很长的正文');
  });
  test('没有围栏就当整段都是正文', () => {
    assert.equal(extractMarkdown('# 标题\n- [ ] A'), '# 标题\n- [ ] A');
  });
});

describe('程序写头两行,不让模型写', () => {
  test('模型自己写的标题和 appid 行会被削掉', () => {
    // appid 抄错一位,攻略就登记到另一款游戏上,而两边都不会报错
    const md = '# 别的游戏\n\nappid: 999999\n\n## 主线\n\n- [ ] **第一步**';
    const body = stripLeadingHeader(md);
    assert.equal(body, '## 主线\n\n- [ ] **第一步**');
    const full = buildHeader('测试游戏', '1') + '\n' + body;
    assert.match(full, /^# 测试游戏\n\nappid: 1\n/);
    assert.doesNotMatch(full, /999999/);
  });

  test('二级标题不会被误删', () => {
    assert.equal(stripLeadingHeader('## 主线成就\n\n- [ ] **A**'), '## 主线成就\n\n- [ ] **A**');
  });

  test('生成的头能被 syncGuidesFromMarkdown 认出来', () => {
    const head = buildHeader('测试游戏', '1');
    assert.match(head, /^appid:\s*1$/im);
    assert.match(head, /^#\s+测试游戏$/m);
  });
});

describe('guideFileName', () => {
  test('英文名削成 slug', () => {
    assert.equal(guideFileName("Sultan's Game", '1'), 'sultan_s_game_achievements.md');
  });
  test('中文名削不出 ASCII 就退回 appid', () => {
    assert.equal(guideFileName('空之轨迹', '3447040'), 'app_3447040_achievements.md');
  });
});

test('成就清单给模型标出同名的那几条', () => {
  const defs = [def('A', '妙手空空', '偷 10 次'), def('B', '妙手空空', '偷 100 次'), def('C', '独一份', '别的')];
  const list = buildAchievementList('鬼谷八荒', '1', defs);
  assert.equal((list.match(/⚠️ 同名/g) ?? []).length, 2);
  assert.match(list, /共 3 个/);
  assert.match(list, /偷 10 次/, '描述要给出去,不然模型没法照抄原文');
});

// ---------------------------------------------------------------------------
// 前置检查:所有拒绝理由都要在花钱之前给出来
// ---------------------------------------------------------------------------

describe('planGuide 的闸门', () => {
  test('没有成就详情 → 拒绝', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '999' }),
      /成就详情/
    );
  });

  test('成就太多 → 拒绝(分片编排不在 v1)', async () => {
    const { db, config } = freshEnv();
    config.ai.maxAchievements = 1;
    await assert.rejects(planGuide(db, { config, steam: fakeSteam(), appid: '1' }), /上限/);
  });

  test('已经有 Notion 攻略页 → 拒绝(一个 appid 一个后端)', async () => {
    const { db, config } = freshEnv();
    upsertGuide(db, { appid: '1', name: '测试游戏', url: 'https://notion.so/x', kind: 'notion' });
    await assert.rejects(planGuide(db, { config, steam: fakeSteam(), appid: '1' }), /Notion/);
  });

  test('目标文件已存在 → 拒绝覆盖(备份/diff/确认是第 8 步)', async () => {
    const { db, config } = freshEnv();
    writeFileSync(join(config.guidesDir, guideFileName('测试游戏', '1')), '旧的攻略');
    await assert.rejects(planGuide(db, { config, steam: fakeSteam(), appid: '1' }), /已经存在/);
  });

  test('Steam 给不出解锁状态 → 拒绝生成', async () => {
    // 全部不勾的攻略是一份错的攻略,而且会被报成一堆 checked-mismatch,看着像模型写错了
    const { db, config } = freshEnv();
    const steam = { async fetchPlayerAchievements() { return { retry: true }; } };
    await assert.rejects(planGuide(db, { config, steam, appid: '1' }), /解锁状态/);
  });
});

// ---------------------------------------------------------------------------
// 整条流水线
// ---------------------------------------------------------------------------

describe('generateGuide', () => {
  test('一轮过关:落盘、机械打勾、登记进 guides 表', async () => {
    const { db, config } = freshEnv();
    const provider = fakeProvider([GOOD]);
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(['A']), appid: '1' });

    assert.equal(r.ok, true);
    assert.equal(r.rounds, 1);
    assert.ok(existsSync(r.path));

    const text = readFileSync(r.path, 'utf8');
    // 模型写的全是 `- [ ]`,已解锁的那个由程序勾上
    assert.match(text, /- \[x\] \*\*第一步\*\*/, '已解锁的要被机械打勾');
    assert.match(text, /- \[ \] \*\*第二步\*\*/, '没解锁的不许勾');
    assert.match(text, /^# 测试游戏/);
    assert.match(text, /^appid: 1$/m);

    // 用真正的发现逻辑登记,Dashboard 上才看得到链接
    assert.equal(allGuides(db).length, 1);
    assert.equal(allGuides(db)[0].kind, 'local');
    assert.ok(r.registered);
  });

  test('草稿在过关后清掉,不留在 .drafts/', async () => {
    const { db, config } = freshEnv();
    const r = await generateGuide(db, { config, provider: fakeProvider([GOOD]), steam: fakeSteam(), appid: '1' });
    assert.equal(existsSync(join(config.guidesDir, DRAFTS_DIR, guideFileName('测试游戏', '1'))), false);
    assert.equal(r.draftPath, null);
  });

  test('第一轮漏了成就,回灌之后第二轮补上 → 过关', async () => {
    const { db, config } = freshEnv();
    const provider = fakeProvider([MISSING_B, GOOD]);
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1', rounds: 3 });

    assert.equal(r.ok, true);
    assert.equal(r.rounds, 2);
    assert.equal(provider.asked.length, 2);
    assert.match(provider.asked[1], /第二步/, '回灌的清单要指名道姓说漏了哪个成就');
  });

  test('三轮都没过 → 留成草稿,不落盘,而且发现逻辑扫不到它', async () => {
    const { db, config } = freshEnv();
    const provider = fakeProvider([MISSING_B, MISSING_B, MISSING_B]);
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1', rounds: 3 });

    assert.equal(r.ok, false);
    assert.equal(r.rounds, 3);
    assert.equal(provider.asked.length, 3, '就是 3 轮,不能多问');
    assert.equal(r.path, null);
    assert.ok(existsSync(r.draftPath), '没过关也要留下来:丢掉等于烧掉钱还什么都不剩');
    assert.equal(r.blocking.some((f) => f.code === 'missing-checkbox'), true);

    // 这是整个文件最要紧的一条:没验过的草稿绝不能被登记,
    // 否则 checkbox-sync 会拿它去勾用户的框
    const found = syncGuidesFromMarkdown(db, config);
    assert.equal(found.files, 0, '.drafts/ 是子目录,readdirSync 非递归 + 只认 .md,扫不到');
    assert.equal(allGuides(db).length, 0);
  });

  test('模型返回被截断(max_tokens)→ 当场停,不拿半份攻略往下走', async () => {
    const { db, config } = freshEnv();
    const provider = {
      model: 'claude-opus-5',
      webTools: () => [],
      async send() {
        return {
          content: [{ type: 'text', text: MISSING_B }],
          text: MISSING_B,
          stopReason: 'max_tokens',
          stopDetails: null,
          usage: { inputTokens: 1, outputTokens: 32000, cacheCreationTokens: 0, cacheReadTokens: 0, webSearches: 0, requests: 1 },
          model: 'claude-opus-5',
          continuations: 0,
          toolErrors: [],
        };
      },
    };
    await assert.rejects(
      generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1' }),
      /截断/
    );
  });

  test('rounds 不合法当场拦下(否则会被读成"过关了"再去复制不存在的草稿)', async () => {
    const { db, config } = freshEnv();
    for (const bad of [0, -1, NaN, 2.5]) {
      await assert.rejects(
        generateGuide(db, { config, provider: fakeProvider([GOOD]), steam: fakeSteam(), appid: '1', rounds: bad }),
        /rounds/
      );
    }
  });

  test('用量跨轮累加,能算出花费', async () => {
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config, provider: fakeProvider([MISSING_B, GOOD]), steam: fakeSteam(), appid: '1', rounds: 3,
    });
    assert.equal(r.usage.requests, 2);
    assert.equal(r.usage.outputTokens, 40);
  });

  test('system 提示词逐字不变,回灌那轮才能命中前缀缓存', async () => {
    const { db, config } = freshEnv();
    const seen = [];
    const provider = fakeProvider([MISSING_B, GOOD]);
    const inner = provider.send.bind(provider);
    provider.send = async (args) => {
      seen.push(args.system);
      return inner(args);
    };
    await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1', rounds: 3 });
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], 'system 变一个字节,后面的缓存全作废');
  });
});

test('草稿目录建在 guidesDir 底下,但发现逻辑看不见它', () => {
  const { db, config } = freshEnv();
  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });
  writeFileSync(join(config.guidesDir, DRAFTS_DIR, 'x_achievements.md'), '# X\n\nappid: 42\n\n- [ ] **A**');
  const found = syncGuidesFromMarkdown(db, config);
  assert.equal(found.files, 0);
  assert.equal(allGuides(db).length, 0);
});

test('只有开围栏没有闭围栏时也要抠干净(模型忘了收尾 / 输出被截断)', () => {
  // 实测踩过(2026-08-10):成对匹配的正则匹配不上,于是 ```markdown 那一行原样落进了
  // 攻略文件。**校验器抓不到** —— 那行既不是 checkbox 也不违反任何规则,51/51 照样全绿
  assert.equal(extractMarkdown('```markdown\n## 主线\n\n- [ ] **A**'), '## 主线\n\n- [ ] **A**');
  assert.equal(extractMarkdown('```md\n- [ ] **A**\n```'), '- [ ] **A**');
  // 正常成对的、以及压根没有围栏的,行为不变
  assert.equal(extractMarkdown('```markdown\n正文\n```'), '正文');
  assert.equal(extractMarkdown('## 主线'), '## 主线');
});

// ---------------------------------------------------------------------------
// 提示词 ↔ SKILL.md 的漂移
// ---------------------------------------------------------------------------

describe('提示词和 SKILL.md 不能悄悄脱节', () => {
  const skillPath = new URL('../.claude/skills/achievement-guide-writing/SKILL.md', import.meta.url);

  /** SKILL.md 里的规则标题:`## 规则一:…` 取「规则一」,`### 3.1 …` 取「3.1」 */
  function skillRuleKeys() {
    const text = readFileSync(skillPath, 'utf8');
    const keys = new Set();
    for (const line of text.split('\n')) {
      let m = line.match(/^##\s+(规则[一二三四五六七八九十]+)/);
      if (m) { keys.add(m[1]); continue; }
      m = line.match(/^###\s+(\d+\.\d+)/);
      if (m) keys.add(m[1]);
    }
    return keys;
  }

  test('SKILL.md 的每条规则都要在处置表里有交代', () => {
    // RULES 是 SKILL.md 的手抄摘要(约 1/4 体量),全文不能直接发 —— 里面整节讲往 Notion
    // 写、讲截图、讲委托子 agent,8.0 还明写"默认建在 Notion",发过去会主动误导模型。
    // 但手抄就会漂移,而这个项目已经被"文档和代码各说各话"咬过一次。
    // 这条测试把漂移变成一次失败:改了 SKILL.md 就必须表态。
    const missing = [...skillRuleKeys()].filter((k) => !(k in SKILL_RULE_DISPOSITION));
    assert.deepEqual(
      missing,
      [],
      `SKILL.md 里这几条在 lib/guidegen.js 的 SKILL_RULE_DISPOSITION 里没有交代:${missing.join('、')}\n` +
        '要么把它加进 RULES 提示词,要么在处置表里写明为什么不加。'
    );
  });

  test('处置表里不能有 SKILL.md 已经删掉的条目', () => {
    const keys = skillRuleKeys();
    const stale = Object.keys(SKILL_RULE_DISPOSITION).filter((k) => !keys.has(k));
    assert.deepEqual(stale, [], `处置表里这几条 SKILL.md 已经没有了:${stale.join('、')}`);
  });

  test('几条对生成结果有实际约束的规则,确实在提示词里', () => {
    const defs = [def('A', '第一步', '完成第一关。')];
    const p = buildSystemPrompt('测试游戏', '1', defs);
    // 每一条都对应一个踩过或差点踩的坑,不是凑数
    assert.match(p, /易错过/, '永久错过的标注');
    assert.match(p, /不要标/, '季节性的**不能**标易错过 —— 假警报会让这个记号失效');
    assert.match(p, /※除去追加内容/, 'DLC 排除标注的固定写法');
    assert.match(p, /位置 XXX/, '位置标注的固定写法');
    assert.match(p, /待确认/, '不写"推测/待确认"这类文档化备注');
    assert.match(p, /机制速查/, '成就列表前的机制速查');
  });

  // 2026-08-11 实际生成出来的:Wrap House Simulator 四个"玩满 7 天"成就下面
  // 各挂了 `第1天`…`第7天`,一共 28 个子框。旧提示词只拦"互斥选项"(任一结局那种),
  // 而这一批**每一条都要做**,合法地穿过了那道门。真正的问题是它们一条信息都不带,
  // 而且其中一个父成就已解锁 —— cascade 会把 7 个空框勾成 7 条假记录。
  test('提示词要拦住无意义的子 checkbox,不只拦互斥选项', () => {
    const p = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    assert.match(p, /子 checkbox 默认不写/, '默认不嵌套 —— 嵌套要给理由,不是反过来');
    assert.match(p, /序号不是身份/, '`第1天`/`第2天` 这种序号不构成子步骤');
    assert.match(p, /游戏自己不替你数/, '游戏里已有计数器的(7 天、100 只)不该拆成子框');
    assert.match(p, /互相替代/, '互斥选项那条老规则不能在改写中丢掉');
  });
});

// ---------------------------------------------------------------------------
// 难度信号
// ---------------------------------------------------------------------------

describe('全球解锁率', () => {
  test('标出来,而且直接说该写深还是带过 —— 不让模型自己换算', () => {
    // 实测《部落幸存者》最难 1.1%、最易 64.5%,差 60 倍;不给这个信号时,
    // 生成的心得字数只差不到一倍 —— 模型分不出哪条难,就把力气平摊了
    const defs = [def('A', '大城堡', 'x'), def('B', '道路畅通', 'y')];
    const list = buildAchievementList('部落幸存者', '1', defs, new Map([['A', 1.1], ['B', 64.5]]));
    assert.match(list, /1\.1%.*这类要写深/);
    assert.match(list, /64\.5%.*一两句带过/);
    assert.match(list, /力气按它分配/, '光标数字不够,得说清楚拿它干什么');
  });

  test('拿不到解锁率时不留任何痕迹(整段说明也不出现)', () => {
    const list = buildAchievementList('X', '1', [def('A', '甲', 'x')], null);
    assert.doesNotMatch(list, /解锁率|%/);
    assert.doesNotMatch(list, /力气按它分配/, '没有数据还讲怎么用数据,只会让模型困惑');
  });

  test('Steam 拿不到解锁率时,生成流程照走', async () => {
    // 锦上添花的数据,不该因为它挂掉就不给人生成攻略
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config, provider: fakeProvider([GOOD]), steam: fakeSteam(['A'], null), appid: '1',
    });
    assert.equal(r.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Dashboard 的生成按钮
// ---------------------------------------------------------------------------

describe('Dashboard 上的「生成」按钮', () => {
  const html = readFileSync(new URL('../Dashboard.html', import.meta.url), 'utf8');

  test('按钮直接调具名函数,不靠事件冒泡', () => {
    // 踩过:按钮自己带 event.stopPropagation()(不拦住的话点它会同时展开成就详情),
    // 而处理器是挂在 document 上的委托 —— stopPropagation 正好把它挡死。
    // 表现是"点了什么都没发生",**控制台里一个错都没有**,最难查的那种
    assert.match(html, /onclick="event\.stopPropagation\(\);window\.genGuide\(this\)"/);
    assert.match(html, /window\.genGuide = function/);
    assert.doesNotMatch(
      html,
      /document\.addEventListener\('click'[\s\S]{0,120}data-gen/,
      '别再改回事件委托 —— stopPropagation 会让它收不到'
    );
  });
});
