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
  chunkDefs,
  buildChunkMessage,
  buildChunkFeedback,
  chunksNeedingRewrite,
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

  test('别的规则照拦 —— 豁免是逐条列出来的,不是一类', () => {
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

  // -------------------------------------------------------------------------
  // 同名 + Steam 描述是空的:够不着,但不该拦
  // -------------------------------------------------------------------------
  const emptyDesc = (apiName, name = 'Proud Player') => ({
    level: 'error', code: 'ambiguous-empty-description', apiName, name, message: '注定同步不上',
  });

  test('描述是空的同名成就算预期内,不拦', () => {
    // 区分这两个成就的唯一凭据(描述原文)在 Steam 上就不存在,任何重写都满足不了。
    // 拦下来的实际后果实测过:KINGDOM HEARTS 一份 197/197 全覆盖的攻略被 15 条
    // 这种错误挡在门外,而它自己的消息就写着"不是攻略能修的"
    const { blocking, expected } = splitFindings([emptyDesc('A')], new Set(['A']));
    assert.equal(blocking.length, 0);
    assert.equal(expected.length, 1);
  });

  test('不看 unnameable —— 这条的触发前提本身就含"名字撞车"', () => {
    // 和 checked-mismatch 那条不同:那一条对任何成就都会报,所以需要 unnameable 这道闸;
    // 这一条比 unnameable 更窄。传个空集合照样要豁免,否则在 lint 单独跑的路径上会不一致
    const { blocking, expected } = splitFindings([emptyDesc('A')], new Set());
    assert.equal(blocking.length, 0);
    assert.equal(expected.length, 1);
  });

  test('描述**存在**只是没抄的那种必须继续拦 —— 那一种重写就能修', () => {
    // 这是这次改动最容易做过头的地方:两种以前共用一个 code,一起放过等于
    // 把"该抄没抄"也放过,而那正是同名成就唯一的救命绳
    const { blocking, expected } = splitFindings(
      [{ level: 'error', code: 'ambiguous-no-description', apiName: 'A', message: '没抄描述原文' }],
      new Set(['A'])
    );
    assert.equal(blocking.length, 1, '有描述不抄是攻略的问题,不能豁免');
    assert.equal(expected.length, 0);
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
  test('库里没有这个 appid → 拒绝', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '999' }),
      /不在列表里/
    );
  });

  /**
   * **缺成就详情不再是拒绝理由,而是当场去取。**
   *
   * 原来这里拒绝并附一句"先跑 `node tracker.js sync --schema`",而 Dashboard
   * (尤其打包版)的用户根本没有终端 —— 那句话对他们是死胡同。而且这不是罕见情况:
   * 刚添加的游戏还没轮到批量同步,已打满的游戏则被 syncAchievementSchema 有意跳过
   * (`rate === 1`),对后者那堵墙是**永久**的,按多少次同步都没用。
   */
  test('没有成就详情 → 当场去 Steam 取一次,不再要求先跑命令行', async () => {
    const { db, config } = freshEnv({ defs: [] });
    let asked = 0;
    const steam = {
      ...fakeSteam(),
      async fetchAchievementSchema(appid, lang) {
        asked++;
        return [{ name: 'A', displayName: lang === 'schinese' ? '第一步' : 'First', description: '完成第一关。', hidden: 0, icon: '' }];
      },
    };
    const plan = await planGuide(db, { config, steam, appid: '1' });
    assert.equal(plan.defs.length, 1, '取回来的成就要能直接用');
    assert.ok(asked >= 1, '应该真的去问了 Steam');
  });

  test('Steam 那边也没有成就清单 → 才拒绝,而且不提命令行', async () => {
    const { db, config } = freshEnv({ defs: [] });
    const steam = { ...fakeSteam(), async fetchAchievementSchema() { return null; } };
    await assert.rejects(
      planGuide(db, { config, steam, appid: '1' }),
      (err) => {
        assert.equal(err.code, 'no-schema');
        assert.doesNotMatch(err.message, /tracker\.js|config\.json|sync --schema/,
          '这句话会原样出现在 Dashboard 上,不能让没有终端的人去敲命令');
        return true;
      }
    );
  });

  test('成就太多 → 拒绝,但把「该改哪个配置」留给 CLI 自己说', async () => {
    const { db, config } = freshEnv();
    config.ai.maxAchievements = 1;
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.match(err.message, /上限/);
        assert.equal(err.code, 'too-many-achievements');
        assert.deepEqual(err.detail, { count: 2, max: 1 }, '数字要带出去,CLI 才拼得出建议');
        assert.doesNotMatch(err.message, /config\.json/, 'Dashboard 用户改不了配置文件');
        return true;
      }
    );
  });

  test('已经有 Notion 攻略页 → 拒绝(一个 appid 一个后端)', async () => {
    const { db, config } = freshEnv();
    upsertGuide(db, { appid: '1', name: '测试游戏', url: 'https://notion.so/x', kind: 'notion' });
    await assert.rejects(planGuide(db, { config, steam: fakeSteam(), appid: '1' }), /Notion/);
  });

  test('目标文件已存在 → 拒绝覆盖(备份/diff/确认是第 8 步)', async () => {
    const { db, config } = freshEnv();
    writeFileSync(join(config.guidesDir, guideFileName('测试游戏', '1')), '旧的攻略');
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.match(err.message, /已经有一个同名文件/);
        assert.equal(err.code, 'file-exists');
        return true;
      }
    );
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

  // 这里只有两个成就,切不动(见 MIN_CHUNK),所以走的是"停下来"那条路。
  // 成就够多时截断会先自己切小重问,见「截断之后自己切小重问」那一组 ——
  // 两条路的共同点才是这条测试真正钉住的东西:**半份攻略绝不往下走**
  test('模型返回被截断(max_tokens)且切不动 → 当场停,不拿半份攻略往下走', async () => {
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

  // -------------------------------------------------------------------------
  // 同名 + 描述为空:整份要能落地,而且要报出来
  // -------------------------------------------------------------------------
  // 复刻 KINGDOM HEARTS -HD 1.5+2.5 ReMIX- 的形状:四合一合集,每款子游戏各有一个
  // 自己的「Proud Player」,而 Steam 对它们的描述返回空字符串。
  // 改之前:197 条全写对的攻略被 15 条这种错误拦掉,先花三轮让模型抄不存在的描述,
  // 最后什么都没落地。
  describe('同名成就在 Steam 上没有描述', () => {
    const TWINS = [
      def('ACH_001', 'Proud Player', ''),      // 描述为空 —— 谁都修不了
      def('ACH_104', 'Proud Player', ''),      // 同名,同样为空
      def('ACH_007', '独一份', '完成第七关。'), // 正常的一条,当对照
    ];
    const twinsEnv = () => {
      const dir = mkdtempSync(join(tmpdir(), 'guidegen-twins-'));
      const db = openDb(':memory:');
      insertGame(db, { appid: '1', name: '测试游戏' });
      replaceAchievements(db, '1', TWINS.map(toRow));
      return { db, config: { guidesDir: dir, ai: { maxAchievements: 100 } } };
    };
    const twinsSteam = () => ({
      async fetchPlayerAchievements() {
        return { achievements: TWINS.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
      },
      async fetchGlobalAchievementPercentages() { return null; },
    });
    // 三条都写了,名字一字不差 —— 攻略这边没有任何毛病
    const BODY =
      '```markdown\n## 全部\n\n' +
      '- [ ] **Proud Player**<br>隐藏成就:Proud 难度通关。<br>KH1 那一份。\n' +
      '- [ ] **Proud Player**<br>隐藏成就:Proud 难度通关。<br>KH2 那一份。\n' +
      '- [ ] **独一份**<br>完成第七关。<br>顺着主线走。\n```';

    test('一轮就落地,不再拿它去重写', async () => {
      const { db, config } = twinsEnv();
      const provider = fakeProvider([BODY]);
      const r = await generateGuide(db, { config, provider, steam: twinsSteam(), appid: '1' });

      assert.equal(r.ok, true, '攻略写对了就该落地 —— 拦它的那条错误谁都改不动');
      assert.ok(r.path, '要真的写进 guides/,不是留在草稿里');
      assert.equal(provider.asked.length, 1, '一轮就够,不该再花两轮抄不存在的描述');
      assert.equal(r.blocking.length, 0);
    });

    test('落地了也必须报出来 —— 这几个框自动勾选永远认不出', async () => {
      const { db, config } = twinsEnv();
      const r = await generateGuide(db, {
        config, provider: fakeProvider([BODY]), steam: twinsSteam(), appid: '1',
      });
      // 不拦路 ≠ 不吭声。不报的话,用户要等到某天发现有两个框一直没动才会知道,
      // 而那时候看起来更像是同步坏了
      const named = r.expected.filter((f) => f.code === 'ambiguous-empty-description');
      assert.equal(named.length, 2, '两个撞名的成就各报一条');
      assert.deepEqual([...new Set(named.map((f) => f.name))], ['Proud Player'],
        '要报 Steam 上那个写法,方便用户对得上');
      // 正常那条不该被卷进来
      assert.ok(!named.some((f) => f.apiName === 'ACH_007'));
    });

    test('同一轮里还有真问题时,打回清单里也不能出现它', async () => {
      // **`MODEL_FIXABLE` 里不放它,是第二道防线,而且这一条测试是唯一能看见它的角度。**
      //
      // 平时 splitFindings 已经把它挪进 expected 了,重写轮压根碰不到 —— 所以把它加回
      // MODEL_FIXABLE 也不会有任何测试变红(变异验证时实测如此)。只有同一轮里存在**另一条**
      // 真该修的错误、重写轮真的跑起来的时候,这个成员资格才起作用:
      // `buildFeedback` 是直接按 MODEL_FIXABLE 过 findings 的,没有先过 splitFindings
      const MIXED = [
        def('ACH_001', 'Proud Player', ''),
        def('ACH_104', 'Proud Player', ''),
        def('ACH_009', '漏掉的那条', '完成第九关。'),
      ];
      const dir = mkdtempSync(join(tmpdir(), 'guidegen-mixed-'));
      const db = openDb(':memory:');
      insertGame(db, { appid: '1', name: '测试游戏' });
      replaceAchievements(db, '1', MIXED.map(toRow));
      const config = { guidesDir: dir, ai: { maxAchievements: 100 } };
      const steam = {
        async fetchPlayerAchievements() {
          return { achievements: MIXED.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
        },
        async fetchGlobalAchievementPercentages() { return null; },
      };
      // 两份都写全,别用 replace 去拼 —— 第一个 ``` 是**开**围栏,替掉它等于交出去
      // 一份没有围栏的正文,而 extractMarkdown 那条兜底又会让它看着像正常工作
      const TWO_TWINS =
        '- [ ] **Proud Player**<br>隐藏成就。<br>KH1。\n' +
        '- [ ] **Proud Player**<br>隐藏成就。<br>KH2。\n';
      const twinsOnly = '```markdown\n## 全部\n\n' + TWO_TWINS + '```';
      const allThree = '```markdown\n## 全部\n\n' + TWO_TWINS +
        '- [ ] **漏掉的那条**<br>完成第九关。<br>补上了。\n```';
      const provider = fakeProvider([twinsOnly, allThree]);
      const r = await generateGuide(db, { config, provider, steam, appid: '1' });

      assert.equal(r.ok, true);
      assert.equal(provider.asked.length, 2, '第一轮漏了一条,第二轮补上');
      const feedback = provider.asked[1];
      assert.match(feedback, /漏掉的那条/, '真该修的那条要在打回清单里');
      assert.doesNotMatch(feedback, /注定同步不上/,
        '描述是空的那条不能出现在打回清单里 —— 那是要求模型抄一个不存在的字符串');
    });

    test('描述**存在**只是没抄的时候,照旧打回重写', async () => {
      // 反向那一半:别把"该抄没抄"也一起放过了
      const WITH_DESC = [
        def('ACH_001', 'Proud Player', 'Clear on Proud.'),
        def('ACH_104', 'Proud Player', 'Clear on Critical.'),
      ];
      const dir = mkdtempSync(join(tmpdir(), 'guidegen-desc-'));
      const db = openDb(':memory:');
      insertGame(db, { appid: '1', name: '测试游戏' });
      replaceAchievements(db, '1', WITH_DESC.map(toRow));
      const config = { guidesDir: dir, ai: { maxAchievements: 100 } };
      const steam = {
        async fetchPlayerAchievements() {
          return { achievements: WITH_DESC.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
        },
        async fetchGlobalAchievementPercentages() { return null; },
      };
      // 两条都不抄描述 → 该打回
      const noDesc = '```markdown\n## 全部\n\n- [ ] **Proud Player**<br>随便写的<br>心得\n' +
        '- [ ] **Proud Player**<br>也是随便写的<br>心得\n```';
      const provider = fakeProvider([noDesc, noDesc, noDesc]);
      const r = await generateGuide(db, { config, provider, steam, appid: '1' });

      assert.equal(r.ok, false, '有描述不抄是攻略的问题,必须拦');
      assert.ok(provider.asked.length > 1, '这一种要回灌重写');
      assert.ok(r.blocking.some((f) => f.code === 'ambiguous-no-description'));
    });
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
    assert.match(html, /window\.genGuide = async function/);
    assert.doesNotMatch(
      html,
      /document\.addEventListener\('click'[\s\S]{0,120}data-gen/,
      '别再改回事件委托 —— stopPropagation 会让它收不到'
    );
  });

  // 踩过(2026-08-11,打包版):原生 confirm 弹出来立刻就消失,人来不及点确定,
  // 于是"从 Dashboard 生成攻略"在打包版上整条路是断的 —— 而同一份页面在浏览器里
  // 完全正常,所以浏览器里怎么点都复现不出来。原生对话框归 Electron 主进程管,
  // 页面夺不回来;页面内的框没有这个问题,两边行为也一致
  test('确认框不能用原生 confirm/alert —— 打包版里它们会自己消失', () => {
    // 先把注释削掉再查。**注释里提到这些名字是应该的** —— 那几段注释写的正是
    // "为什么不许用原生的",拿它们判定"你还在用",等于禁止解释自己的决定。
    // (这条测试第一次跑就是被自己的说明注释绊倒的)
    const code = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*(\*|\/\/).*$/gm, '');

    assert.doesNotMatch(code, /window\.confirm\s*\(/, 'window.confirm 在 Electron 里点不到,改用 askConfirm()');
    assert.doesNotMatch(code, /(?<![.\w])alert\s*\(/, 'alert 换成 askConfirm({notifyOnly:true})');
    assert.doesNotMatch(code, /(?<![.\w])confirm\s*\(/, '裸 confirm( 也不行');
    assert.match(html, /function askConfirm\(o\)/, '通用确认框本体');
    assert.match(html, /id="askModal"/, '页面里得真有那个框,不能只有函数');
  });

  // 这是**第二次**把花钱措辞从界面上拿掉了(第一次是设置页,commit 4d66ce9)。
  // 提示语该说的是"接下来会发生什么",不是替用户评估值不值:key 是他自己配的,
  // 单价他自己知道,而我们连服务端搜索怎么计费都没测过(见 CLAUDE.md「没有 spend caps」)。
  // 拿一个我们说不清的数去吓人,比不说更糟。代码注释里说明"为什么有这道确认"是可以的,
  // 用户读不到注释。
  test('面向用户的文案里不提花钱 —— 已经被拿掉两次了', () => {
    const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\*|\/\/).*$/gm, '');
    const MONEY = /花钱|产生费用|要花多少|收费/;

    assert.doesNotMatch(strip(html), MONEY, 'Dashboard 的确认框和状态条里不提钱');

    const cli = strip(readFileSync(new URL('../tracker.js', import.meta.url), 'utf8'));
    assert.doesNotMatch(cli, MONEY, 'CLI 的提示语和帮助里也不提钱(注释里说明理由没问题)');
  });

  // 重写(覆盖已有攻略)以前只有命令行能调 —— Dashboard 上有攻略的行只显示「📖 攻略」,
  // 连按钮都没有。GUI 上点一下比敲一行命令容易得多,所以闸门**不能比 CLI 松**:
  // 必须先预检、把"会失去什么"摆出来,再问。
  test('Dashboard 能重写已有攻略,而且闸门和 CLI 一样严', () => {
    assert.match(html, /data-rewrite=/, '有攻略的行要有重写入口');
    assert.match(html, /window\.rewriteGuide = async function/);
    // 先预检再问 —— 顺序反了就成了"不知道会失去什么的确认"
    // 按**函数定义**切,不是按名字第一次出现切 —— 名字最早出现在按钮的 onclick 属性里,
    // 那样切出来的是两个 onclick 之间的一小段,什么都匹配不到
    const fn = html.slice(
      html.indexOf('window.rewriteGuide = async function'),
      html.indexOf('window.migrateGuide = function')
    );
    assert.ok(
      fn.indexOf('previewGuideRewrite') < fn.indexOf('askConfirm'),
      '必须先拿到预检结果再弹确认框'
    );
    assert.match(fn, /danger: true/, '覆盖不可逆,确认按钮要标红');
    assert.match(fn, /startGuideGen\(appid, true[,)]/, '不把 overwrite 传下去,服务端会照常拒绝');
  });

  test('生成和重写不会同时出现在一行 —— 一个针对没攻略的,一个针对有攻略的', () => {
    assert.match(html, /const canGen = !g\.guideUrl/, '生成只给没攻略的行');
    assert.match(html, /g\.guideUrl && aiReady/, '重写只给有攻略的行');
  });

  // 用户反复说过三次:界面上的字太长、解释太多。确认框只该回答"会发生什么、要多久",
  // 机制和保证属于说明,搬到代码注释里用户一个字都不用读。这条测试是防它长回去的 ——
  // 每次想往框里加一句"顺便解释一下"的时候,它会先失败
  test('确认框要短 —— 不摆项目符号清单,不写解释', () => {
    const bodies = [...html.matchAll(/askConfirm\(\{[\s\S]{0,120}?body:\s*'([^']*)'/g)].map((m) => m[1]);
    assert.ok(bodies.length >= 1, '至少该抓到一个字符串型 body(删除框)');
    for (const b of bodies) {
      const lines = b.split('\\n').filter((l) => l.trim());
      assert.ok(lines.length <= 3, `确认框最多三行,这个有 ${lines.length} 行:${b.slice(0, 60)}`);
      assert.ok(!b.includes('· '), `别在确认框里摆项目符号清单:${b.slice(0, 60)}`);
    }
  });

  test('生成框只有一句问话,没有正文 —— 生成是可逆的,没什么要先交代', () => {
    const call = html.slice(html.indexOf("askConfirm({ title: '为《'"), html.indexOf("okText: '生成'") + 20);
    assert.ok(call.includes("title: '为《'"), '生成框还在');
    assert.ok(!/\bbody:/.test(call), '生成框不该再有正文');
    // 但"内容没验过"这句话不能整个消失,它挪到结果那一行去了
    assert.match(html, /内容需要你自己过一遍/, '攻略写完之后仍要如实说内容未经验证');
  });

  // **第二次了**(第一次是设置页,commit 4d66ce9,标题就写着「去掉对供应商的评价」)。
  // 那次只改了设置页,没搜别处,于是 README、docs、CLI 的选择器里全留着。
  // 单价随时变、质量我们没有可比的测量 —— 写出来就是臆断,而用户会当事实照着选。
  // 只写可核实的:有没有联网搜索、key 在哪申请。
  test('任何面向用户的地方都不写对供应商的评价', () => {
    const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\*|\/\/).*$/gm, '');
    const JUDGEMENT = /cheapest|priciest|most expensive|best quality|最便宜|最贵|质量最好|有免费额度/i;
    const surfaces = ['../README.md', '../docs/guides.md', '../docs/configuration.md',
      '../tracker.js', '../lib/config.js', '../lib/ai.js', '../Setup.html', '../Dashboard.html'];
    for (const rel of surfaces) {
      const text = strip(readFileSync(new URL(rel, import.meta.url), 'utf8'));
      const hit = text.match(JUDGEMENT);
      assert.equal(hit, null, `${rel} 里还有对供应商的评价:「${hit && hit[0]}」`);
    }
  });

  test('用了 askConfirm 的调用点都是 async/await —— 它返回 Promise,忘了 await 等于默认确认', () => {
    // askConfirm 回的是 Promise,而 Promise 恒为真值。漏掉 await 的话
    // `if (!askConfirm(...)) return` 永远不会 return —— 危险动作直接放行,静默
    for (const m of html.matchAll(/(?<!await\s)askConfirm\(\{/g)) {
      const before = html.slice(Math.max(0, m.index - 400), m.index);
      assert.ok(
        /await\s*$/.test(before) || /notifyOnly/.test(html.slice(m.index, m.index + 240)),
        `askConfirm 的返回值没有被 await(位置 ${m.index}) —— 除非是 notifyOnly 的纯提示`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 分段撰写(几百个成就的游戏)
// ---------------------------------------------------------------------------
// 上限从 100 提到 500,靠的不是"调大一个数字"——一次输出装不下几百条正文,
// 而**装不下不会报错**:模型写到一半停,校验器只说"后半段的成就都缺 checkbox"。
// 所以超过一段就分几轮写,同一个 session(模型看得见自己前面写了什么),
// 最后拼起来对**完整的一份**打勾和校验。

describe('分段撰写', () => {
  const BIG = ['A', 'B', 'C', 'D', 'E'].map((k, i) => def(k, `成就${i + 1}`, `完成第${i + 1}关。`));
  const bigSteam = () => ({
    async fetchPlayerAchievements() {
      return { achievements: BIG.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
    },
    async fetchGlobalAchievementPercentages() { return null; },
  });
  /** 某一段该有的 markdown */
  const seg = (items) =>
    '```markdown\n## 主线\n\n' +
    items.map((d) => `- [ ] **${d.name_cn}**<br>${d.description}<br>心得`).join('\n') +
    '\n```';

  const envFor = (chunkSize) => {
    const e = freshEnv({ defs: BIG });
    e.config.ai = { maxAchievements: 500, chunkSize };
    return e;
  };

  test('chunkDefs 切得对,余数单独成段', () => {
    assert.deepEqual(chunkDefs([1, 2, 3, 4, 5], 2).map((c) => c.length), [2, 2, 1]);
    assert.deepEqual(chunkDefs([1, 2, 3], 10).map((c) => c.length), [3], '装得下就只有一段');
    assert.equal(chunkDefs([1, 2, 3], 0).length, 3, 'size 传 0 不能死循环');
    assert.deepEqual(chunkDefs([], 50), [], '一个成就都没有就没有段');
  });

  test('chunkDefs 把成就均摊到各段,不让最后一段变成零头', () => {
    const n = (len) => Array.from({ length: len }, (_, i) => i);
    // 这条是照着真事写的:人中之龙0 有 55 个成就,配 chunkSize=50。
    // 朴素切片给 50 + 5 —— 段数同样是 2,却让第一段顶着上限去撞 max_tokens
    assert.deepEqual(chunkDefs(n(55), 50).map((c) => c.length), [28, 27]);
    assert.deepEqual(chunkDefs(n(101), 50).map((c) => c.length), [34, 34, 33]);
    // 整除时和以前一模一样 —— 均摊不该改动本来就均匀的情况
    assert.deepEqual(chunkDefs(n(100), 50).map((c) => c.length), [50, 50]);
    assert.deepEqual(chunkDefs(n(50), 50).map((c) => c.length), [50]);
  });

  test('chunkDefs 均摊之后:段数不增加、没有一段超上限、成就不丢不重', () => {
    for (let len = 1; len <= 120; len++) {
      for (const size of [1, 2, 7, 50]) {
        const defs = Array.from({ length: len }, (_, i) => i);
        const chunks = chunkDefs(defs, size);
        const flat = chunks.flat();
        // **上限是硬的。** 均摊只该把段变短;超了就等于悄悄把用户配的值改大了
        assert.ok(chunks.every((c) => c.length <= size), `len=${len} size=${size} 有段超过上限`);
        // 段数不能比朴素切法多 —— 多一段就是多一次请求、多一次搜索预算
        assert.ok(
          chunks.length <= Math.ceil(len / size),
          `len=${len} size=${size} 段数比朴素切法还多`
        );
        // 顺序和完整性:模型是按「第 N–M 个成就」写的,漏一个或重一个都会
        // 变成校验器口中的 missing-checkbox,而真因在这里
        assert.deepEqual(flat, defs, `len=${len} size=${size} 成就丢了或顺序变了`);
      }
    }
  });

  test('只有一段时,发过去的话和以前一字不差 —— 小攻略的行为不能被这次改动碰到', () => {
    assert.equal(buildChunkMessage([BIG], 0), '开始写吧。先联网查资料,再按规则写完整份攻略。');
  });

  test('分段时告诉模型这一段是哪几个,以及别重复前面写过的', () => {
    const chunks = chunkDefs(BIG, 2);
    const m = buildChunkMessage(chunks, 1);
    assert.match(m, /第 3–4 个成就/);
    assert.match(m, /成就3[\s\S]*成就4/);
    assert.match(m, /不要重复前面已经写过的小节和成就/);
    assert.match(m, /后面还有/, '中间段不该收尾');
    assert.match(buildChunkMessage(chunks, 2), /最后一段,写完就停/);
  });

  test('chunksNeedingRewrite 按 apiName 把问题定位到具体那一段', () => {
    const chunks = chunkDefs(BIG, 2);
    const blocking = [{ code: 'missing-checkbox', apiName: 'E', message: 'x' }];
    assert.deepEqual(chunksNeedingRewrite(blocking, chunks), [2]);
    // 定位不到的(没带 apiName)不该乱指一段 —— 调用方会退回全部重写
    assert.deepEqual(chunksNeedingRewrite([{ code: 'merged-line', message: 'x' }], chunks), []);
  });

  // -------------------------------------------------------------------------
  // 被 max_tokens 截断 → 切小重问
  // -------------------------------------------------------------------------
  // 装进单次请求的是 thinking + 正文,而 thinking 随游戏/模型/端点变,兼容端点上
  // 连压它的参数都发不出去。所以不预测该切多大,而是**等截断真的发生**再切 ——
  // 截断是量到的事实,它直接说明这一段越了界。
  describe('截断之后自己切小重问', () => {
    const N = 12;
    const MANY = Array.from({ length: N }, (_, i) => def(`K${i}`, `成就${i + 1}`, `完成第${i + 1}关。`));
    const manySteam = () => ({
      async fetchPlayerAchievements() {
        return { achievements: MANY.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
      },
      async fetchGlobalAchievementPercentages() { return null; },
    });
    const manyEnv = (chunkSize, defs = MANY) => {
      const e = freshEnv({ defs });
      e.config.ai = { maxAchievements: 500, chunkSize };
      return e;
    };

    /** 能指定每次的 stopReason,并且把**每次看到的完整历史**记下来 */
    function scriptedProvider(script) {
      return {
        model: 'claude-opus-5',
        asked: [],
        seen: [],
        webTools: () => [],
        async send({ messages }) {
          this.seen.push(JSON.stringify(messages));
          this.asked.push(messages.at(-1).content);
          const step = script[this.asked.length - 1];
          if (!step) throw new Error('scriptedProvider 的脚本用完了');
          // 传输层的故障(401、网络断了)—— 和 checkResult 判出来的「这一段不可用」
          // 是两类东西,而它们从同一个 await 里出来。见 CHUNK_LOCAL
          if (step.throws) throw step.throws;
          const text = step.text ?? '';
          return {
            content: [{ type: 'text', text }],
            text,
            stopReason: step.stop ?? 'end_turn',
            stopDetails: null,
            usage: {
              inputTokens: 10, outputTokens: step.out ?? 20, cacheCreationTokens: 0,
              cacheReadTokens: 0, webSearches: 1, requests: 1,
            },
            model: 'claude-opus-5',
            continuations: 0,
            toolErrors: [],
          };
        },
      };
    }

    const HALF_WRITTEN = '```markdown\n## 主线\n\n- [ ] **成就1**<br>完成第1关。<br>写到这里就被砍了\n```';

    test('一段写不完就一分为二,两半都问一遍,成就一个不少', async () => {
      const { db, config } = manyEnv(N); // 一整段,必然要切
      const provider = scriptedProvider([
        { text: HALF_WRITTEN, stop: 'max_tokens', out: 61445 },
        { text: seg(MANY.slice(0, 6)) },
        { text: seg(MANY.slice(6)) },
      ]);
      const events = [];
      const r = await generateGuide(db, {
        db, config, provider, steam: manySteam(), appid: '1',
        onProgress: (e) => events.push(e),
      });

      assert.equal(r.ok, true, '切小之后应该顺利写完');
      assert.equal(provider.asked.length, 3, '截断那次 + 两半 = 三次');
      const text = readFileSync(r.path, 'utf8');
      for (const d of MANY) {
        assert.ok(text.includes(`**${d.name_cn}**`), `${d.name_cn} 丢了`);
      }
      const re = events.find((e) => e.phase === 'resplit');
      assert.ok(re, '切小要发进度事件 —— 界面上不能是「卡住了」');
      assert.deepEqual([re.from, re.to], [12, 6]);
    });

    test('重问之前必须把被截断的那一轮从历史里摘掉', async () => {
      const { db, config } = manyEnv(N);
      const provider = scriptedProvider([
        { text: HALF_WRITTEN, stop: 'max_tokens' },
        { text: seg(MANY.slice(0, 6)) },
        { text: seg(MANY.slice(6)) },
      ]);
      await generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' });

      // **这条是整件事最容易做错的地方。** 废稿留在上下文里,而重问的提示词写着
      // 「不要重复前面已经写过的成就」—— 模型会跳过它写了一半的那几个,
      // 产出看着完全正常,只是少了条目。失败会报出来,缺东西不会
      assert.ok(
        !provider.seen[1].includes('写到这里就被砍了'),
        '第二次请求的历史里还留着被截断的废稿'
      );
      assert.ok(
        !provider.seen[2].includes('写到这里就被砍了'),
        '第三次请求的历史里还留着被截断的废稿'
      );
      // 摘掉的只是废稿那一轮,正常写完的那一段必须留着 —— 同一个 session 的意义
      // 就在于模型看得见自己前面写了什么
      assert.ok(provider.seen[2].includes('成就1'), '第一半的成果不该被一起摘掉');
    });

    test('切到下限还是写不完就停下来,并且说清楚为什么别去调大 maxTokens', async () => {
      // 5 == MIN_CHUNK,不能再切
      const FIVE = MANY.slice(0, 5);
      const { db, config } = manyEnv(5, FIVE);
      const provider = scriptedProvider([{ text: HALF_WRITTEN, stop: 'max_tokens' }]);
      await assert.rejects(
        () => generateGuide(db, {
          db, config, provider,
          steam: {
            async fetchPlayerAchievements() {
              return { achievements: FIVE.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
            },
            async fetchGlobalAchievementPercentages() { return null; },
          },
          appid: '1',
        }),
        (err) => {
          assert.match(err.message, /已经切到 5 个成就/);
          assert.match(err.message, /这是用量不是上限/, '那个数字是用量,得说明白');
          // **这句话会原样进 Dashboard 的浮窗。** 该动哪个旋钮是终端才给得出、
          // 也才有意义的建议(tracker.js 接住 chunk-too-small 之后自己补)
          assert.equal(err.code, 'chunk-too-small');
          // `was` 记的是**改写之前**那个码。切不动之后 code 一律变成 chunk-too-small,
          // 于是"到底是被截断还是根本没输出正文"就只剩这一个字段说得清 ——
          // 而那两种情况下"换个模型"这条建议的分量完全不同
          assert.deepEqual(err.detail, { size: 5, min: 5, was: 'max_tokens' });
          assert.doesNotMatch(err.message, /ai\.maxTokens|anthropicExtras|config\.json/,
            'Dashboard 用户没有终端,也不该被要求去编辑配置文件');
          return true;
        }
      );
      assert.equal(provider.asked.length, 1, '切不动了就不该再问一次');
    });

    test('只有截断才切小重问 —— 拒答、RECITATION 切小了照样撞', async () => {
      for (const stop of ['refusal', 'recitation']) {
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([{ text: '', stop }]);
        await assert.rejects(
          () => generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' }),
          (err) => {
            assert.equal(err.code, stop);
            assert.doesNotMatch(err.message, /已经切到/, '这不是长度问题,别按长度问题报');
            return true;
          }
        );
        assert.equal(provider.asked.length, 1, `${stop} 不该重试`);
      }
    });

    // -----------------------------------------------------------------------
    // 空回复:先原样重问,还空再切小
    // -----------------------------------------------------------------------
    // 「一个 text 块都没有」是这条路上唯一真正的**瞬时**失败:请求没问题、段长没问题、
    // 资料也搜到了,就是这一次没吐出正文。它此前一次都不重试,整份当场作废 ——
    // 实测撞到过(KINGDOM HEARTS,197 个成就第 3/4 段)。
    describe('空回复', () => {
      test('原样再问一次就好了 —— 不该为此把整份作废', async () => {
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '' },              // 空回复
          { text: seg(MANY) },       // 再问一次就有了
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: manySteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        assert.equal(r.ok, true, '重问一次就该正常写完');
        assert.equal(provider.asked.length, 2);
        assert.deepEqual(r.chunkFailures, [], '补上了就不该还挂着失败记录');
        const ev = events.find((e) => e.phase === 'retry');
        assert.ok(ev, '重问要发进度事件 —— 界面上不能是「卡了三分钟」');
        assert.deepEqual([ev.attempt, ev.of], [1, 1]);
      });

      test('重问时那条空 assistant 必须先从历史里摘掉', async () => {
        // 不摘的话历史里就有一轮「问了这一段 / 什么都没答」,而重问的是**同一句话** ——
        // 模型完全可能当成"你已经问过了",于是再答一次空。这跟被截断那一轮必须摘掉
        // 是同一条理由,只是废稿的形状不同(那边是半份,这边是空的)
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([{ text: '' }, { text: seg(MANY) }]);
        await generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' });

        const second = JSON.parse(provider.seen[1]);
        assert.equal(second.length, 1, '重问时历史里只该有新问的那一句 user');
        assert.equal(second[0].role, 'user');
      });

      test('控制符泄漏走同一条阶梯:先原样重问,补上就当没事发生', async () => {
        // 供应商把内部记号写进正文,输出从那里断掉(见 lib/ai.js 的 leakedControlToken)。
        // 和空回复同类:是这一次采样跑偏,不是这一段有问题 —— 重问一次很可能就正常了。
        // 线上那次(KINGDOM HEARTS)因为没有这道拦截,三轮都把断掉的正文当成功收下了,
        // 结果少 10 个成就,而那三行乱码进了草稿
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '```markdown\n- [ ] **成就1**<br>完成第1关。<br>写到一半</｜｜DSML｜｜parameter>\n' },
          { text: seg(MANY) },
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: manySteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        assert.equal(r.ok, true, '重问一次就该好');
        assert.equal(provider.asked.length, 2);
        const ev = events.find((e) => e.phase === 'retry');
        assert.ok(ev, '要发重问的进度事件');
        assert.equal(ev.reason, 'control-token');
        // 断掉的那半份绝不能留在成品里
        assert.doesNotMatch(readFileSync(r.path, 'utf8'), /DSML/, '乱码不能进攻略文件');
      });

      test('一直泄漏也不拖垮整份 —— 记下来接着写后面的', async () => {
        // control-token 必须在 CHUNK_LOCAL 里:它是这一段自己的问题(HTTP 200),
        // 不是供应商坏了,所以放过这一段、接着写后面几段是对的
        // 每段 5 个 == MIN_CHUNK,所以切不动 —— 这条只考「记下来接着跑」,
        // 不把切分的行为也混进来
        const LOTS = Array.from({ length: 10 }, (_, i) => def(`K${i}`, `成就${i + 1}`, `完成第${i + 1}关。`));
        const e = freshEnv({ defs: LOTS });
        e.config.ai = { maxAchievements: 500, chunkSize: 5 };
        const steam = {
          async fetchPlayerAchievements() {
            return { achievements: LOTS.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
          },
          async fetchGlobalAchievementPercentages() { return null; },
        };
        const junk = { text: '```markdown\n- [ ] **x**<br>y</｜｜DSML｜｜invoke>\n' };
        const provider = scriptedProvider([
          { text: seg(LOTS.slice(0, 5)) },  // 第 1 段正常
          junk, junk,                        // 第 2 段:泄漏 + 重问还泄漏 → 切不动,记下来放过
          { text: seg(LOTS.slice(5)) },      // 第 2 轮把它补上
        ]);
        const r = await generateGuide(e.db, { config: e.config, provider, steam, appid: '1' })
          .catch((err) => ({ threw: err }));
        assert.ok(!r.threw, '不该整份抛出去:' + (r.threw && r.threw.message));
        assert.equal(r.ok, true, '第二轮补上了就该落地');
        assert.doesNotMatch(readFileSync(r.path, 'utf8'), /DSML/);
      });

      test('重问还是空 ⇒ 按长度问题处理,切成两半', async () => {
        // 第二次还空就不是抽风了。兼容端点上既发不出压 thinking 的参数,也不能假定
        // 它会把「额度被思考吃光」如实报成 max_tokens —— 所以"空回复"里混着一部分
        // 实质上就是截断的情况,而切小正是那部分的解
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '' },                    // 空
          { text: '' },                    // 重问还是空 → 切
          { text: seg(MANY.slice(0, 6)) },
          { text: seg(MANY.slice(6)) },
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: manySteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        assert.equal(r.ok, true);
        assert.equal(provider.asked.length, 4, '空 + 重问 + 两半 = 四次');
        const re = events.find((e) => e.phase === 'resplit');
        assert.ok(re, '切小要发进度事件');
        assert.deepEqual([re.from, re.to], [12, 6]);
        assert.equal(re.reason, 'empty', '要说清是因为空回复才切的,不是因为截断');
      });

      test('切完的两半各自还能再重问一次 —— 重试次数跟着段走', async () => {
        // 切小换的是**一段更小的内容**,前面那两次空回复是上一段的历史,不该记在它头上。
        // 计数不归零的话,切完的第一半只要抽风一次就直接判死,而它其实一次都没试过
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '' }, { text: '' },       // 整段:空 + 重问还空 → 切
          { text: '' },                     // 前一半:空
          { text: seg(MANY.slice(0, 6)) },  // 前一半:重问就有了
          { text: seg(MANY.slice(6)) },
        ]);
        const r = await generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' });
        assert.equal(r.ok, true, '切完的那一半也该有自己的一次重问机会');
        assert.equal(provider.asked.length, 5);
      });
    });

    // -----------------------------------------------------------------------
    // 一段失败,整份不作废
    // -----------------------------------------------------------------------
    describe('一段写不出来时不拖垮整份', () => {
      /** 24 个成就分 4 段,每段 6 个 —— 和线上那次(197 个分 4 段)同形状 */
      const M = 24;
      const LOTS = Array.from({ length: M }, (_, i) => def(`K${i}`, `成就${i + 1}`, `完成第${i + 1}关。`));
      const lotsSteam = () => ({
        async fetchPlayerAchievements() {
          return { achievements: LOTS.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
        },
        async fetchGlobalAchievementPercentages() { return null; },
      });
      const lotsEnv = () => {
        const e = freshEnv({ defs: LOTS });
        e.config.ai = { maxAchievements: 500, chunkSize: 6 };
        return e;
      };
      const quarter = (n) => LOTS.slice(n * 6, n * 6 + 6);

      test('第 3 段作废也接着写第 4 段,前几段的成果不丢', async () => {
        const { db, config } = lotsEnv();
        // 第 3 段拒答(不可重试、不可切),前后两段正常
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: '', stop: 'refusal' },
          { text: seg(quarter(3)) },
          // 第二轮补第 3 段
          { text: seg(quarter(2)) },
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: lotsSteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        // **这条是这次改动的核心。** 原来第 3 段一失败就直接抛出去,前两段几分钟的
        // 联网研究连同第 4 段一起作废 —— 而少的那一段有现成的补救路径:
        // 它的成就全被报成 missing-checkbox,chunksNeedingRewrite 精确挑出这一段,
        // 下一轮只重问它。那套机器本来就在
        assert.equal(r.ok, true, '第二轮补上了就该顺利落地');
        assert.equal(provider.asked.length, 5, '第一轮 4 次(含失败那次)+ 第二轮补 1 次');
        const text = readFileSync(r.path, 'utf8');
        for (const d of LOTS) {
          assert.ok(text.includes(`**${d.name_cn}**`), `${d.name_cn} 丢了`);
        }
        const ev = events.find((e) => e.phase === 'chunk-failed');
        assert.ok(ev, '放弃一段必须发进度事件 —— 悄悄少一块是最糟的失败方式');
        assert.deepEqual([ev.chunk, ev.count], [3, 6]);
      });

      test('补第 3 段时问的是「写这一段」,不是甩过去六条「缺 checkbox」', async () => {
        const { db, config } = lotsEnv();
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: '', stop: 'refusal' },
          { text: seg(quarter(3)) },
          { text: seg(quarter(2)) },
        ]);
        await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });

        // 一段从没写出来,缺的不是修正意见,是这一段本身。拿打回清单去问,等于
        // 递给模型六条「XX 没有 checkbox」,而它压根没见过这一段的内容
        const refill = provider.asked[4];
        assert.match(refill, /只写第 13–18 个成就/, '该用原来那句「写这一段」');
        assert.doesNotMatch(refill, /校验没过/, '这一段没写过,谈不上校验没过');
      });

      test('供应商坏了要原样抛出去,不能当成「这一段没成」接着问', async () => {
        const { db, config } = lotsEnv();
        const boom = Object.assign(new Error('deepseek API HTTP 401:key 不对'), { code: 'bad-api-key' });
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { throws: boom },
        ]);
        await assert.rejects(
          () => generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }),
          (err) => {
            // **code 必须原样传出去。** 它是 tracker.js 顶层 catch 用来挂终端建议的钥匙
            // (bad-api-key 那条要说「环境变量会盖掉 config.json」,而清环境变量只能在
            // 终端做)。当成一段的失败记下来,这条建议就永远走不到那儿了
            assert.equal(err.code, 'bad-api-key');
            return true;
          }
        );
        assert.equal(provider.asked.length, 3, '整体故障不该再去问第 4 段 —— 那是同一堵墙');
      });

      test('整体故障抛出去时,已经写好的几段仍然留在草稿里', async () => {
        // **这一条才真正钉住「每写完一段就落盘」。** 轮末那次 writeDraft 在这条路上
        // 根本走不到(异常直接穿出 generateGuide),所以草稿里有没有东西,全靠逐段那次写。
        // 线上那次失败后 .drafts/ 是空的,就是因为草稿只在整个分段循环跑完之后才写
        const { db, config } = lotsEnv();
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { throws: Object.assign(new Error('网络断了'), { code: 'bad-api-key' }) },
        ]);
        const draft = join(config.guidesDir, DRAFTS_DIR, guideFileName('测试游戏', '1'));
        await assert.rejects(() => generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }));

        assert.ok(existsSync(draft), '前两段的成果必须已经在盘上 —— 那是用户已经付过钱的东西');
        const text = readFileSync(draft, 'utf8');
        for (const d of [...quarter(0), ...quarter(1)]) {
          assert.ok(text.includes(`**${d.name_cn}**`), `${d.name_cn} 应该留在草稿里`);
        }
      });

      test('每写完一段就落盘 —— 一段失败不该把前面几段的钱一起丢掉', async () => {
        const { db, config } = lotsEnv();
        // 前两段成功,第 3 段起全部拒答:三轮都补不上,最后 ok=false
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: '', stop: 'refusal' },
          { text: seg(quarter(3)) },
          { text: '', stop: 'refusal' },  // 第 2 轮
          { text: '', stop: 'refusal' },  // 第 3 轮
        ]);
        const r = await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });

        assert.equal(r.ok, false);
        assert.equal(r.path, null, '知道缺一段就绝不能落地');
        // **草稿原来是整个分段循环跑完之后才写的**,所以任何一段中途抛异常都会把
        // 前面几段连同它们的联网研究一起丢掉。实测:线上那次失败后 .drafts/ 是空的
        assert.ok(existsSync(r.draftPath), '草稿必须在');
        const draft = readFileSync(r.draftPath, 'utf8');
        for (const d of [...quarter(0), ...quarter(1), ...quarter(3)]) {
          assert.ok(draft.includes(`**${d.name_cn}**`), `写成功的 ${d.name_cn} 应该留在草稿里`);
        }
        // 病因要交出去。少一段的症状是六条 missing-checkbox,而那是症状不是病因
        assert.equal(r.chunkFailures.length, 1);
        assert.deepEqual(
          [r.chunkFailures[0].chunk, r.chunkFailures[0].of, r.chunkFailures[0].count],
          [3, 4, 6]
        );
        assert.match(r.chunkFailures[0].reason, /拒答/);
      });

      test('全部段都写不出来 ⇒ 抛第一个真原因,不是一堆「缺 checkbox」', async () => {
        const { db, config } = lotsEnv();
        const provider = scriptedProvider(Array.from({ length: 4 }, () => ({ text: '', stop: 'refusal' })));
        await assert.rejects(
          () => generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }),
          (err) => {
            // 一段都没写出来时继续往下走,会拿一份空草稿去校验、报出"每个成就都缺
            // checkbox",然后再花两轮重问 —— 症状盖住病因,还多花两轮的钱
            assert.equal(err.code, 'refusal');
            assert.doesNotMatch(err.message, /checkbox/);
            return true;
          }
        );
        assert.equal(provider.asked.length, 4, '第一轮走完就该停,不该再开第二轮');
      });
    });
  });

  test('五个成就分三段写完,拼起来五个 checkbox 一个不少', async () => {
    const { db, config } = envFor(2);
    const chunks = chunkDefs(BIG, 2);
    const provider = fakeProvider(chunks.map(seg));
    const r = await generateGuide(db, { config, provider, steam: bigSteam(), appid: '1' });

    assert.equal(r.ok, true);
    assert.equal(provider.asked.length, 3, '三段就该问三次');
    const text = readFileSync(r.path, 'utf8');
    // 直接比字符串,不拼正则 —— `- [ ] **名字**` 里每个字符都要转义,拼错了
    // 报的是"正则无效",而不是"攻略少了一条",排查方向整个偏掉
    for (const d of BIG) {
      assert.ok(text.includes(`- [ ] **${d.name_cn}**`), `${d.name_cn} 在拼起来的攻略里丢了`);
    }
    assert.equal((text.match(/^# /gm) || []).length, 1, '标题只能有一个,不能每段各写一个');
  });

  test('只有一段出问题时,第二轮只重问那一段', async () => {
    const { db, config } = envFor(2);
    const chunks = chunkDefs(BIG, 2);
    // 第 2 段(成就3/成就4)漏了成就4
    const bad = seg([chunks[1][0]]);
    const provider = fakeProvider([seg(chunks[0]), bad, seg(chunks[2]), seg(chunks[1])]);
    const r = await generateGuide(db, { config, provider, steam: bigSteam(), appid: '1' });

    assert.equal(r.ok, true);
    assert.equal(r.rounds, 2);
    assert.equal(provider.asked.length, 4, '第一轮 3 次 + 第二轮只补 1 次');
    assert.match(provider.asked[3], /第 2\/3 段/, '重问的必须是出问题的那一段');
    assert.match(provider.asked[3], /只重新输出这一段/);
    assert.match(readFileSync(r.path, 'utf8'), /- \[ \] \*\*成就4\*\*/);
  });

  test('打回清单只列这一段自己的问题,别把别段的错也塞进来', () => {
    const chunks = chunkDefs(BIG, 2);
    const findings = [
      { level: 'error', code: 'missing-checkbox', apiName: 'B', message: '成就2 没有 checkbox' },
      { level: 'error', code: 'missing-checkbox', apiName: 'E', message: '成就5 没有 checkbox' },
    ];
    const m = buildChunkFeedback(findings, chunks, 0, new Set());
    assert.match(m, /成就2/);
    assert.doesNotMatch(m, /成就5/, '第 3 段的问题不该出现在第 1 段的打回清单里');
  });
});
