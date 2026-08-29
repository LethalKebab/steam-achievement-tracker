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
  collapseEmptyBreaks,
  stripLeadingHeader,
  buildHeader,
  joinBodies,
  guideFileName,
  buildAchievementList,
  buildSystemPrompt,
  systemPromptFor,
  REGROUP_SYSTEM,
  regroupByAssignment,
  chunkDefs,
  buildChunkMessage,
  briefApiNames,
  buildChunkFeedback,
  chunksNeedingRewrite,
  SKILL_RULE_DISPOSITION,
  DRAFTS_DIR,
  unwrapAchievementToggles,
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

/**
 * 分类那一趟的挡板。**每个假供应商的 send 第一行都要过它。**
 *
 * 那一趟走的是单独一条会话(system 是 `REGROUP_SYSTEM`),不该吃掉任何一个脚本
 * 队列 —— 吃掉的表现是「回复用完了 / 脚本用完了」,报的位置和真正的原因差着十万
 * 八千里,而且每写一个新的分段测试都会再踩一次。
 *
 * `sections` 传 null 就模拟「分类没成」,走降级路径(等于加这一趟之前的行为)。
 */
const REGROUP_SECTIONS = ['主线', '支线', '收集', '杂项'];
function regroupReply(system, sections = REGROUP_SECTIONS, count = 5) {
  // 认 REGROUP_SYSTEM,格式是「== 标题 / 编号」——`parseRegroupReply` 认的就是那个
  if (system !== REGROUP_SYSTEM) return null;
  const text = sections
    ? sections.map((x, i) => {
      // 编号按顺序发下去,最后一节兜住剩下的,保证每个编号都出现一次
      const from = Math.floor((i * count) / sections.length) + 1;
      const to = i === sections.length - 1 ? count : Math.floor(((i + 1) * count) / sections.length);
      const nums = [];
      for (let n = from; n <= to; n++) nums.push(String(n));
      return `== ${x}\n${nums.join('\n')}`;
    }).join('\n')
    : '这个游戏不用分区。';
  return {
    content: [{ type: 'text', text }], text, stopReason: 'end_turn', stopDetails: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, webSearches: 0, requests: 1 },
    model: 'plan', continuations: 0, toolErrors: [], searchQueries: [],
  };
}

/**
 * 按顺序吐出预设回复,并记下每次发过去的 user 消息。
 *
 * **分类那一趟不吃这个队列。** 它走的是单独一条会话(system 是 `REGROUP_SYSTEM`),
 * 这里按 system 认出来单独作答 —— 否则每写一个分段测试都得记着在队列最前面多塞一条
 * 分类回复,而忘了塞的表现是「回复用完了」,报的位置和真正的原因差着十万八千里。
 *
 * `sections` 给 null 就模拟「分类没成」,走降级路径(等于加这一趟之前的行为)。
 */
function fakeProvider(replies, { sections = ['主线', '支线', '收集', '杂项'] } = {}) {
  return {
    model: 'claude-opus-5',
    asked: [],
    regroupAsks: 0,
    regroupPrompt: null,
    // 联网工具由供应商自己声明,编排层只是转发。测试里不需要真的工具
    webTools: () => [],
    async send({ system, messages }) {
      const planned = regroupReply(system, sections, replies.count ?? 5);
      if (planned) {
        this.regroupAsks++;
        this.regroupPrompt = messages.at(-1).content;
        return planned;
      }
      this.asked.push(messages.at(-1).content);
      const text = replies[this.asked.length - 1];
      if (text === undefined) throw new Error('fakeProvider 的回复用完了');
      return this.reply(text);
    },
    reply(text) {
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

/**
 * 成就行的格式是三段:`- [ ] **名字**<br>官方描述<br>心得`。
 *
 * **隐藏成就在 Steam 上没有描述** —— 接口返回空字符串,于是给模型的清单里那一条
 * 写着「官方描述:(Steam 上是空的)」,模型照规则 4「原文照抄」抄了个空的,
 * 中间那段就空了。`notionblocks.js` 把每个 `<br>` 转成一个 `\n`,两个连着就是
 * 页面上成就名和心得之间一行突兀的空白。
 *
 * 实测《罗曼圣诞探案集》(926340):50 个成就 28 个是隐藏的,读回来的块长这样 ——
 * `"扑朔迷离\n\n与艾尔耿对话,被问到…"`,而正常的那些是 `"初入酒馆\n欢迎光临白星酒馆\n序章…"`。
 * 超过一半的条目带着这行空白。
 */
describe('空的官方描述不留空行', () => {
  test('中间那段是空的就合掉', () => {
    assert.equal(
      collapseEmptyBreaks('- [ ] **扑朔迷离**<br><br>与艾尔耿对话时作答即解锁。'),
      '- [ ] **扑朔迷离**<br>与艾尔耿对话时作答即解锁。'
    );
  });

  test('**三段都有的一个字都不动**', () => {
    const line = '- [ ] **初入酒馆**<br>欢迎光临白星酒馆<br>序章开场剧情自动解锁。';
    assert.equal(collapseEmptyBreaks(line), line);
  });

  test('空白字符也算空段 —— 模型抄回来的常带一个空格', () => {
    assert.equal(
      collapseEmptyBreaks('- [ ] **名字**<br>   <br>心得'),
      '- [ ] **名字**<br>心得'
    );
  });

  test('末尾多出来的 <br> 一并去掉', () => {
    assert.equal(collapseEmptyBreaks('- [ ] **名字**<br>描述<br>'), '- [ ] **名字**<br>描述');
  });

  test('`<br/>` 和 `<BR>` 都认', () => {
    assert.equal(collapseEmptyBreaks('- [ ] **名字**<br/><BR />心得'), '- [ ] **名字**<br>心得');
  });

  test('缩进的子步骤同样处理', () => {
    assert.equal(
      collapseEmptyBreaks('  - [ ] **子步骤**<br><br>说明'),
      '  - [ ] **子步骤**<br>说明'
    );
  });

  test('**只动 checkbox 行** —— 正文段落里的连续 <br> 可能是作者真想空一行', () => {
    const prose = '这是一段正文<br><br>下面接着写';
    assert.equal(collapseEmptyBreaks(prose), prose);
    assert.equal(collapseEmptyBreaks('## 主线\n\n' + prose), '## 主线\n\n' + prose);
  });

  test('整行都是空段的原样留着 —— 那是别的问题,交给 lint 去报', () => {
    assert.equal(collapseEmptyBreaks('- [ ] <br><br>'), '- [ ] <br><br>');
  });

  test('多行里只改需要改的那几行,行数和顺序不变', () => {
    const src = [
      '## 序章',
      '',
      '- [ ] **初入酒馆**<br>欢迎光临白星酒馆<br>自动解锁。',
      '- [ ] **扑朔迷离**<br><br>对话时作答即解锁。',
      '- [ ] **食色性也**<br><br>把调查点全部点一遍。',
    ].join('\n');
    const out = collapseEmptyBreaks(src);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.match(out, /扑朔迷离\*\*<br>对话时/);
    assert.match(out, /食色性也\*\*<br>把调查点/);
    assert.match(out, /初入酒馆\*\*<br>欢迎光临白星酒馆<br>自动解锁。/);
    assert.doesNotMatch(out, /<br>\s*<br>/);
  });

  test('空输入不炸', () => {
    assert.equal(collapseEmptyBreaks(''), '');
    assert.equal(collapseEmptyBreaks(null), '');
    assert.equal(collapseEmptyBreaks(undefined), '');
  });

  /**
   * **两条落地路径都要过这一道。** 整篇生成和局部重写各自 `extractMarkdown` 一次,
   * 只接一处的话,同一份攻略换个命令就又长出空行来 —— 而那种漂移一个测试都不会红。
   */
  test('整篇生成和局部重写都接上了', () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['lib/guidegen.js', 'lib/guidepatch.js']) {
      const src = strip(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
      const calls = [...src.matchAll(/extractMarkdown\(reply\.text\)/g)];
      assert.ok(calls.length >= 1, `${f} 里找不到 extractMarkdown(reply.text)`);
      for (const m of calls) {
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
        assert.match(line, /collapseEmptyBreaks\(/,
          `${f} 有一处 extractMarkdown 没包 collapseEmptyBreaks:${line.trim()}`);
      }
    }
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
  /**
   * SKILL.md 里所有需要表态的条目。
   *
   * **不带编号的 `###` 子节也要算进来 —— 这一条是补出来的。** 原来只抓 `## 规则N`
   * 和 `### N.N`,于是往任何一条规则底下加一个不带编号的子节,处置表一个字都不会响。
   * 实测漏过一次:规则二的处置写着「没进 —— 截图不在 v1 范围」,而后来加进去的
   * 「贴不了截图的时候:带时间点的视频链接」**是进了提示词的**,处置结论因此变了,
   * 却没有任何东西提醒去更新 —— SKILL.md 那段还反过来写着「(见「规则二」的处置)」,
   * 指着一条说它没进的记录。
   *
   * 子节按 `规则N/标题` 作 key。改标题会让这条测试红,这是想要的:改一个子节的标题
   * 正是回头确认「它到底进没进提示词」的时候。
   */
  function skillRuleKeys() {
    const text = readFileSync(skillPath, 'utf8');
    const keys = new Set();
    let rule = null;
    for (const line of text.split('\n')) {
      let m = line.match(/^##\s+(规则[一二三四五六七八九十]+)/);
      if (m) { rule = m[1]; keys.add(rule); continue; }
      m = line.match(/^###\s+(.+?)\s*$/);
      if (!m) continue;
      const title = m[1];
      const numbered = title.match(/^(\d+\.\d+)/);
      keys.add(numbered ? numbered[1] : `${rule}/${title}`);
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

  // **处置表只对得上「标题」,对不上「内容」。** 规则一在表里写着「进了」,而它的
  // 三个条件在 SKILL.md 和 RULES 里各存一份手抄 —— 改一边忘另一边,处置表一个字
  // 都不会响,而两份不同口径的规则就是"文档和代码各说各话"的又一次。
  // 苏丹的游戏「知识」那次改的正是条件 2,所以这条把三个条件都钉成同口径。
  test('嵌套的三个条件,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /序号不是身份/, `${name} 少了条件 1`);
      assert.match(text, /写得出做法/, `${name} 的条件 2 要拿"这一行有没有内容"当判据`);
      assert.match(text, /互相替代/, `${name} 少了条件 3`);
      assert.doesNotMatch(text, /游戏自己不替你数/,
        `${name} 还留着旧判据 —— 有计数器就不嵌套,会把全收集类成就整类挡在门外`);
    }
  });

  // 苏丹的游戏「创造」:613 字**一整段**。内容其实是对的,模型自己都写了
  // "前置准备:…"和"流程:1)…6)",但全挤在同一个 <br> 段里 —— 结构一点没落到页面上,
  // 读的人分不出哪句是准备、哪句是操作、哪句是雷。
  //
  // 规则里从来没说过心得段要分行:硬规则 1 只定了「名字<br>描述<br>心得」三段,
  // 心得内部长什么样一个字没提,于是"写详细"被执行成了"写长"。
  test('心得段的分行规矩,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /前置、步骤、警告分行写/, `${name} 少了分行规矩`);
      assert.match(text, /一步一行/, `${name} 要说清步骤多了就一步一行`);
      assert.match(text, /不是字数/,
        `${name} 的判据要是"混没混进两种性质的东西" —— 卡字数会把该长的也砍短`);
    }
  });

  // 同一条成就还暴露了第二件事:嵌套那一节从头到尾只举收集品的例子
  //(神庙、配方、支线、词条),模型于是把它读成"收集品的写法",
  // 而「创造」是个六阶段的长流程 —— 三个条件它其实全都满足。
  test('步骤链也算嵌套的候选,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /把流程本身写成子 checkbox/, `${name} 没说长流程也可以嵌套`);
      assert.match(text, /三步以内的写在心得里就够/,
        `${name} 少了下限 —— 不设的话两步的成就也会被拆成子框`);
      assert.match(text, /具体动作/,
        `${name} 要挡住 步骤一/步骤二 那种没内容的拆法`);
    }
  });

  // 「创造」重写完是 14 个子框,每一个都以「前置:」或「步骤:」开头 —— 同一个词
  // 出现十四次,而它要说的事只有两件。分组标签该单独一行。
  test('分组标签的写法,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /标签单独占一行/, `${name} 少了分组标签的规矩`);
      assert.match(text, /不要在每一条前面重复/, `${name} 少了「别重复」这半句 —— 那才是这条规则要治的病`);
      // **这一条是机制要求,不是风格**,所以两边都要把"为什么"写出来 ——
      // 只写"要这么写"的规则,下一个人一嫌啰嗦就改了
      assert.match(text, /不能写成普通 bullet/,
        `${name} 没说标签行必须也是 checkbox —— 那是局部重写能不能定位的前提`);
      assert.match(text, /五六条以内直接平铺/,
        `${name} 少了下限,三条也套一层只会多两个空框`);
    }

    // 两份手抄到这里分开,而且是故意的。RULES 不知道这份攻略
    // 最后落哪个后端(`guidegen.js` 里那句注释),只能给两边都安全的
    // checkbox 标签形;SKILL.md 是手改已知后端的页面用的,Notion 那一侧
    // `fetchAllToDoBlocks` 把 toggle 当透明容器,折叠标签不会断开归属。
    // **把分歧本身钉住**——否则下一个人要么把 Notion 那一段当矛盾删掉,
    // 要么把它搬进 RULES,而后者会让本地 md 的 `todoSpans` 静默断掉。
    assert.match(skill, /toggle \/ column 当\*\*透明容器\*\*/,
      'SKILL.md 少了 Notion 侧的例外 —— 折叠标签在 Notion 上是安全的,这是理由');
    assert.match(skill, /target. 传不到时退回 checkbox 标签版/,
      'SKILL.md 少了兜底方向 —— 猜错的代价不对等,默认必须是 checkbox 标签');
    // `rules` 这里没传 target,拿到的就是兜底版。**兜底必须是两边都能活的那一版。**
    assert.match(rules, /标签行必须也是/,
      'target 没传时 RULES 必须给 checkbox 标签形 —— 折叠写进本地 md 会静默断区间');
  });

  // 分组标签是提示词里唯一按后端分岔的规则。Notion 上 `fetchAllToDoBlocks` 把 toggle
  // 当透明容器(`parent` 原样往下传),折叠标签不会断开归属;本地 md 的 `todoSpans`
  // 遇到非 checkbox 行就截断区间。两边给同一版必然坑掉其中一个。
  test('分组标签按后端分岔,兜底必须是两边都安全的那一版', () => {
    const defs = [def('A', '第一步', '完成第一关。')];
    const notion = buildSystemPrompt('测试游戏', '1', defs, { target: 'notion' });
    const local = buildSystemPrompt('测试游戏', '1', defs, { target: 'local' });
    const fallback = buildSystemPrompt('测试游戏', '1', defs);

    assert.match(notion, /<summary>\*\*前置\*\*/, 'Notion 版没给折叠标签的写法');
    assert.doesNotMatch(notion, /标签行必须也是/,
      'Notion 版不该还要求标签行是 checkbox —— 那正是要治的毛病');
    assert.match(notion, /也不要用 checkbox/,
      'Notion 版少了「注意那一组降成普通 bullet」—— 警告勾不掉,还会被 --cascade 勾成假记录');

    assert.match(local, /标签行必须也是/, '本地版必须保留 checkbox 标签的硬要求');
    assert.doesNotMatch(local, /<summary>\*\*前置\*\*/,
      '本地版不能推荐折叠做标签 —— todoSpans 会当场截断区间');

    // **兜底方向是有代价差的,不是随便挑一个。** 折叠写进本地 md 是静默断区间(默默重复),
    // checkbox 标签写进 Notion 只是丑一点。所以 target 缺失时必须退到本地版。
    assert.equal(fallback, local,
      'target 没传时必须等同本地版 —— 猜成 Notion 版会让本地 md 静默产生重复条目');

    // 两边只在标签那一段分岔,别的规则不能跟着分
    for (const [name, text] of [['notion', notion], ['local', local]]) {
      assert.match(text, /标签单独占一行/, `${name} 版丢了分组标签的总规矩`);
      assert.match(text, /五六条以内直接平铺/, `${name} 版丢了分组的下限`);
    }
  });

  // 规则五原来只说"很长的清单"就折,没有数字 —— 分组标签那边有「五六条」的下限,
  // 折叠这边没有,同一份攻略里两把尺子。三五行的表折起来只是把信息藏了。
  test('折叠有行数下限,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /10 行/,
        `${name} 少了折叠的下限 —— 不设的话三行的表也会被折起来,信息反而被藏了`);
    }
  });

  /**
   * 行数下限只回答「折不折」,不回答「折什么」。少了这一条,整节成就会被打包进一个
   * 折叠里(实测马特 `## 世界全清` 的 13 条),那一节在 Notion 上点开是空的。
   * `unwrapAchievementToggles` 会把它拆开,但**提示词这一条不能因此省掉** ——
   * 程序兜底是最后一道,不是第一道。
   */
  /**
   * **这一条是整轮返工的起点,而它在规范里一度一个字都没有。**《马特的寻猫游戏》四条
   * 「将吉祥物替换为 X」被拆成「宝石与商店」和「吉祥物替换」两处 —— 两边各自说得通,
   * 合起来就是 bug。程序那一半(`lib/guidecluster.js`)只在**分了段**时才跑,而库里
   * 一半以上的游戏成就数不到 `ai.chunkSize`、一段写完 —— 它们没有兜底,只有这条规则。
   */
  test('同一类事必须在一个小节,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /同一类事必须在同一个小节里/, `${name} 少了这一条`);
      assert.match(text, /不看.{0,4}解锁途径|不看是怎么解锁的/,
        `${name} 要说清判据是官方描述而不是解锁途径 —— 按途径分正是当初劈开的那个理由`);
    }
  });

  test('成就本身不进折叠,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    assert.match(rules, /成就本身那一行永远不进折叠/, 'RULES 少了这一条');
    assert.match(skill, /成就那一行永远不进折叠/, 'SKILL.md 少了这一条');
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /折叠装的是.{0,12}辅料/,
        `${name} 要说清折叠装的是什么 —— 只说「不许折成就」,模型分不出辅料算不算成就`);
    }
  });

  // 马特的寻猫游戏(找物游戏)的位置类成就:文字说不清「这 30 朵蘑菇在哪」,
  // 而截图这条路是明确排除掉的(规则二的处置:模型给不出可靠的游戏内截图)。
  // 实测把这几条重写一遍,模型自己找到的替代品是**带时间点的视频链接**
  // (「对照 B站 BV1KFwzzCEsc 的 5-2 段落(01:56)」)—— 那就是该写进规则的东西。
  test('位置类成就的兜底写法,两份手抄必须同口径', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const rules = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    for (const [name, text] of [['SKILL.md', skill], ['RULES', rules]]) {
      assert.match(text, /时间点/, `${name} 少了「视频链接要带时间点」`);
      assert.match(text, /留意角落/,
        `${name} 要把万能话点名挡掉 —— 只说「写具体点」拦不住它`);
    }
    // **两边措辞不同,共用一个断言只能钉住最弱的那个。** 各自最要紧的那句分开钉 ——
    // 「时间点」这三个字在两边都出现好几处,删掉任何一处它都还在
    assert.match(rules, /写不出具体位置时/, 'RULES 少了这条规则本身');
    assert.match(rules, /时间点是关键/, 'RULES 少了「只给视频号等于让人从头翻」');
    assert.match(skill, /贴不了截图的时候/, 'SKILL.md 少了这一节');
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
    // **不能直接 match 整段提示词。** 条件 1 里也写着 `第1天`,所以在整段上断言
    // 「第1天」永远是绿的 —— 把条件 2 的例子整个删掉它也不会响。切到条件 2 自己那一段
    const c2 = p.slice(p.indexOf('2. **这一行'), p.indexOf('3. **每一条都要做'));
    assert.ok(c2.length > 20, '切到条件 2 —— 这条检查失去了目标,不是通过了');
    assert.match(c2, /第7天/, '条件 2 要点名一个"不该嵌套"的具体例子');
    assert.match(p, /互相替代/, '互斥选项那条老规则不能在改写中丢掉');
  });

  // **反方向的事故,2026-08-21:苏丹的游戏「知识」= 集齐《百科全书》全部词条**,
  // 每个词条入手方式都不一样。用户点名重写它、并且要求写具体步骤,拿回来的仍然是
  // 一整段「条目会随剧情推进和角色入队逐步录入」——一个词条都没点名,等于没写。
  //
  // 原因不在模型,在规则:旧的条件 2 是「游戏自己不替你数」,而百科全书当然有计数器,
  // 所以这一条把整类全收集成就挡在了门外。三条必须同时成立,挡一条就够。
  //
  // **而且那条判据本来就没在干活**:它自己举的三个例子(玩满 7 天、杀 100 只、
  // 攒 5000 块)全都先被条件 1「序号不是身份」拦掉了 —— 它唯一独占的作用,
  // 就是拦住合法的收集清单。它还和同一段的自检句直接矛盾:
  // 「把那几行删掉,攻略少了什么信息吗?」——删掉三十个词条的入手方式,少的是全部。
  test('但不能反过来把全收集类的成就也拦掉', () => {
    const p = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    assert.doesNotMatch(p, /游戏自己不替你数/,
      '这条判据挡不住该挡的(序号那类条件 1 已经挡了),只挡得住全收集清单');
    assert.match(p, /写得出做法/, '判据要换成「这一行除了序号还有没有内容」');
    const c2 = p.slice(p.indexOf('2. **这一行'), p.indexOf('3. **每一条都要做'));
    assert.ok(c2.length > 20, '切到条件 2 —— 这条检查失去了目标,不是通过了');
    assert.match(c2, /百科全书/,
      '规则只给反例的话,模型学到的是「别嵌套」;该嵌套的那一面也要举一个');
    assert.match(p, /长不是"不列"的理由/,
      '「太长了」是把全收集写成一段话最常用的借口,要当场堵掉');
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
    // **入口在行上,不在 ⋯ 菜单里。** 2026-08-20 收进过菜单又收回来了 —— 理由见
    // Dashboard.html 里 `.row-actions` 那段:重写是主动要做的动作,进第二层等于
    // 每次都多一次点击。这里钉的是**入口还在、而且跑起来之后会置灰**,
    // 不钉它长什么样(上一版钉在 `data-rewrite` 属性上,那个属性没了)
    assert.match(html, /class="guide-btn rewrite"/, '有攻略的行要有重写入口');
    assert.match(html, /window\.rewriteGuide\(/);
    assert.match(html, /window\.rewriteGuide = async function/);
    // 置灰状态是**渲染出来的**,不是 render 之后手动设回去的 —— 挂在按钮上会被
    // 下一次后台同步的重画洗掉,而重写要跑两三分钟,中间必然撞上。
    // 切到真锚点再匹配,不写死那一串字符:上一版把空格数写进正则,改一个空格就红
    const rowActions = html.slice(
      html.indexOf('<div class="row-actions">'),
      html.indexOf('class="delete-btn"')
    );
    assert.ok(rowActions.length > 0 && rowActions.length < 4000, '切到的应该是 row-actions 那一段');
    assert.match(rowActions, /guideBusy\.has\(String\(g\.appid\)\)/,
      '重写按钮的置灰要从 guideBusy 渲染,不能挂在 DOM 上');
    // 先预检再问 —— 顺序反了就成了"不知道会失去什么的确认"
    // 按**函数定义**切,不是按名字第一次出现切 —— 名字最早出现在调用点上,
    // 那样切出来的是两个调用之间的一小段,什么都匹配不到
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
    // markdown 和源码得分开剥。`^\s*\*` 在 .js/.html 里是块注释的续行,在 .md 里
    // 是**加粗**或者列表项 —— 拿同一条规则去剥 markdown,会把整行正文一起吃掉,
    // 断言就再也看不见那一行。量过一次:README、guides、configuration、cli
    // 四个 md 面加起来 44 行对这条断言完全不可见。所以 .md 只剥 HTML 注释
    const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
    const strip = (s, rel) => (rel.endsWith('.md')
      ? stripHtml(s)
      : stripHtml(s).replace(/^\s*(\*|\/\/).*$/gm, ''));
    // 自查:.md 剥完之后加粗行必须还在。少了这一句,把 strip 改回统一那版
    // 也是全绿 —— 这条断言会静默变成空的,而空断言比没有断言更糟
    assert.match(strip('**x** 最便宜', '../x.md'), /最便宜/,
      'markdown 的加粗行被剥掉了,下面整个循环等于没跑');
    const JUDGEMENT = /cheapest|priciest|most expensive|best quality|最便宜|最贵|质量最好|有免费额度/i;
    const surfaces = ['../README.md', '../docs/guides.md', '../docs/configuration.md',
      '../docs/cli.md',
      '../tracker.js', '../lib/config.js', '../lib/ai.js', '../Setup.html', '../Dashboard.html'];
    for (const rel of surfaces) {
      const text = strip(readFileSync(new URL(rel, import.meta.url), 'utf8'), rel);
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

  /**
   * 各段并发写之后模型看不见别段,于是相邻两段都属于「主线」时会各写一行 `## 主线`。
   * 提示词那边说的是"标题照开,重了程序合",这里就是那句承诺的兑现处 ——
   * 少了它,攻略里会出现一个空标题紧跟着同名标题,内容一条没少但读起来像分类断了。
   */
  describe('拼接时合掉跨段重复的小节标题', () => {
    test('紧挨着的同名标题合成一个', () => {
      const out = joinBodies(['## 主线\n\n- [ ] **A**', '## 主线\n\n- [ ] **B**']);
      assert.equal(out.match(/## 主线/g).length, 1, '两段都开了「主线」,只该留一个标题');
      assert.match(out, /\*\*A\*\*[\s\S]*\*\*B\*\*/, '条目一条都不能少,顺序也不能变');
    });

    test('中间隔了别的小节又转回来的,不合 —— 那是游戏自己的分类', () => {
      const out = joinBodies(['## 主线\n- [ ] **A**', '## 支线\n- [ ] **B**', '## 主线\n- [ ] **C**']);
      assert.equal(out.match(/## 主线/g).length, 2,
        '只合紧挨着的。隔着别的小节又回来是合法结构,合掉等于把 C 塞进支线');
    });

    test('层级不同不合 —— `## 收集` 和 `### 收集` 是两个东西', () => {
      const out = joinBodies(['## 收集\n- [ ] **A**', '### 收集\n- [ ] **B**']);
      assert.match(out, /## 收集/);
      assert.match(out, /### 收集/);
    });

    test('只在段首合。段中间出现的同名标题不动', () => {
      const out = joinBodies(['## 主线\n- [ ] **A**', '- [ ] **B**\n\n## 主线\n- [ ] **C**']);
      assert.equal(out.match(/## 主线/g).length, 2,
        '第二段是以条目开头的,它里面那个标题是新开的一节,不是重复的开头');
    });

    test('空段和失败段(null)直接跳过,不留空行也不错位', () => {
      assert.equal(joinBodies(['## A\n- [ ] **x**', null, '', '## B\n- [ ] **y**']),
        '## A\n- [ ] **x**\n\n## B\n- [ ] **y**');
      assert.equal(joinBodies([null, null]), '', '一段都没有就是空字符串,不是 "null"');
    });
  });

  /**
   * 跨段分类。**这一组钉的是一个真实事故**:《波西亚时光》91 个成就分两段写,
   * 两段各自定各自的分区,并起来 17 个小节 —— 恋爱那件事被拆成六个,
   * `## 主线剧情` 原样出现两次。每一段自己内部零重复,乱的只有并集。
   */
  describe('跨段分类', () => {
    /** 一段正文:按 [[小节名, 成就[]], ...] 摆好。`seg` 把标题写死成「主线」,这里要能换 */
    const body = (parts) =>
      '```markdown\n' +
      parts
        .map(([h, items]) =>
          `## ${h}\n\n` +
          items.map((d) => `- [ ] **${d.name_cn}**<br>${d.description}<br>心得`).join('\n'))
        .join('\n\n') +
      '\n```';

    test('端到端:两段各开一次同名小节,成品里只有一个', async () => {
      // 上面几条验的是零件。**这一条验的是这些零件真的接在生成流程上** ——
      // 分类问没问、映射有没有真的搬动条目、接缝重复合没合掉,漏掉任何一环
      // 都不会报错,只会让成品重新长出重复的小节
      // **形状照抄《波西亚时光》**:重复的「主线」落在第 2 段的**末尾**,
      // 而接缝两侧是「社交」。接缝那一对 joinBodies 自己就能合,所以拿它当端到端
      // 断言等于什么都没验 —— 真正只有归并治得了的,是离接缝远的那一个
      const { db, config } = envFor(3); // 5 个成就切成 3 + 2
      const provider = fakeProvider(
        [
          body([['主线', BIG.slice(0, 2)], ['社交', [BIG[2]]]]),
          body([['社交', [BIG[3]]], ['主线', [BIG[4]]]]),
        ],
        { sections: ['主线', '社交'] }
      );
      const res = await generateGuide(db, { db, config, provider, steam: bigSteam(), appid: '1' });
      assert.equal(provider.regroupAsks, 1, '分区只统一一趟,不是每段问一次');
      assert.match(provider.regroupPrompt, /已经写完了/, '问的确实是「写完之后再分类」那一趟');
      assert.match(provider.regroupPrompt, /现在在:/, '要把各段自己给的分节一起交上去 —— 那是这一趟比前置那趟多出来的信息');
      assert.doesNotMatch(provider.asked[0], /一字不差地照抄/, '写正文时不该再钉死标题,各段自己开');
      const text = readFileSync(res.path, 'utf8');
      assert.equal(text.match(/## 主线/g).length, 1, '「主线」被两段各开了一次,成品里只该有一个');
      assert.equal(text.match(/## 社交/g).length, 1);
      assert.ok(text.indexOf('## 主线') < text.indexOf('## 社交'), '顺序按分类结果走');
      assert.equal((text.match(/- \[ \]/g) ?? []).length, 5, '5 个成就一个都不能少');
    });

    test('两个界面都要报「正在统一分区」和「没统一成」', () => {
      // **两个消费者都是 if/else if 链,不认识的 phase 静默落地。**
      // 不加分支的表现有两个,都不报错:定分区那几十秒里进度条一动不动(看着像卡死),
      // 以及降级悄悄发生 —— 后者正是这个项目最防的那种退化,而它在成品上是看得见的
      // (小节标题重复),用户只会觉得"这次生成的分区怎么乱七八糟"。
      //
      // **先剥行注释再剥块注释**(见 CLAUDE.md):反过来的话,注释里出现的 `/*`
      // 会把下面的代码一起吃掉,于是断言被喂饱,代码删了它照样绿
      const strip = (src) =>
        src.replace(/(^|[^:])\/\/[^\n]*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
      const read = (f) => strip(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
      for (const f of ['tracker.js', 'lib/server.js']) {
        const src = read(f);
        assert.ok(src.includes("=== 'regroup'"), `${f} 没处理 regroup —— 那几十秒界面上什么都不动`);
        assert.ok(src.includes("'regroup-done'"), `${f} 没报分区统一好了`);
        assert.ok(src.includes("'regroup-failed'"), `${f} 没报降级 —— 静默退化`);
      }
    });

    test('分区统一不出来时降级,不中断生成', async () => {
      const { db, config } = envFor(3);
      const provider = fakeProvider([seg(BIG.slice(0, 3)), seg(BIG.slice(3))], { sections: null });
      const events = [];
      const res = await generateGuide(db, {
        db, config, provider, steam: bigSteam(), appid: '1',
        onProgress: (e) => events.push(e),
      });
      assert.ok(res.path, '正文是用户已经等了几分钟的东西,不能因为骨架没定成就整份作废');
      assert.equal((readFileSync(res.path, 'utf8').match(/- \[ \]/g) ?? []).length, 5);
      // **降级要出声。** 悄悄发生的退化正是这个项目最防的那种
      assert.ok(events.some((e) => e.phase === 'regroup-failed'),
        '降级了就要报一条 regroup-failed');
      // 降级 = 保留各段自己分的标题,而不是把正文推平成一节
      const degraded = readFileSync(res.path, 'utf8');
      assert.match(degraded, /^## /m, '降级也要留着各段自己开的小节');
      // **接缝合并只有在这条路上才看得出来。** 分类那一趟成功时它会按标题重新分桶,
      // 顺手把重复的合掉,于是拼接处漏没漏合一点痕迹都不留;降级之后没人兜底了,
      // 两段各开的 `## 主线` 会原样留成两个。实测:把落盘那句换成裸拼接,
      // 全套测试一条都不红 —— 这条断言就是拿来堵那个洞的
      assert.equal((degraded.match(/^## 主线$/gm) ?? []).length, 1,
        '两段都以「主线」开头,joinBodies 要在接缝上合掉重复的那一行');
    });
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
        async send({ system, messages }) {
          const planned = regroupReply(system);
          if (planned) return planned;
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
      });

      /**
       * **「并发」不能只是个说法。** 段数没变、请求数没变、攻略也一模一样,所以把
       * runPool 换回 for 循环,整套测试原本一条都不会红 —— 唯一的差别是墙上时间,
       * 而那正是这次改动的**全部**目的。所以这一条直接量重叠:让每段的请求挂住,
       * 数同时在飞的有几个。
       */
      test('第一轮各段真的同时在飞,不是排队', async () => {
        const { db, config } = lotsEnv();
        config.ai.concurrency = 3;
        let inFlight = 0;
        let peak = 0;
        const provider = scriptedProvider([
          { text: seg(quarter(0)) }, { text: seg(quarter(1)) },
          { text: seg(quarter(2)) }, { text: seg(quarter(3)) },
        ]);
        const inner = provider.send.bind(provider);
        provider.send = async (args) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          // 挂一拍再往下走 —— 排队的话这一拍里不会有第二段进来,峰值就停在 1
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
          return inner(args);
        };
        await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });
        assert.equal(peak, 3, `同时在飞的峰值是 ${peak},说明还在一段一段排队`);
      });

      test('concurrency: 1 退回顺序 —— 排查问题时要有这条退路', async () => {
        const { db, config } = lotsEnv();
        config.ai.concurrency = 1;
        let inFlight = 0;
        let peak = 0;
        const provider = scriptedProvider([
          { text: seg(quarter(0)) }, { text: seg(quarter(1)) },
          { text: seg(quarter(2)) }, { text: seg(quarter(3)) },
        ]);
        const inner = provider.send.bind(provider);
        provider.send = async (args) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
          return inner(args);
        };
        await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });
        assert.equal(peak, 1);
      });

      test('顺序跑时,整体故障之后一个请求都不再发', async () => {
        // `concurrency: 1` 就是原来的顺序行为,这一条把它原样钉住:撞墙即停,不多问一次
        const { db, config } = lotsEnv();
        config.ai.concurrency = 1;
        const boom = Object.assign(new Error('deepseek API HTTP 401:key 不对'), { code: 'bad-api-key' });
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { throws: boom },
        ]);
        await assert.rejects(() =>
          generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }));
        assert.equal(provider.asked.length, 3, '整体故障不该再去问第 4 段 —— 那是同一堵墙');
      });

      test('并发跑时,撞墙之后停止派新活 —— 多撞的次数由并发数封顶,不随段数涨', async () => {
        // **并发下"当场停"做不到:请求已经发出去了,取消不了。** 能做到的是不再往下派,
        // 于是最坏多撞 concurrency-1 次,而不是每剩一段撞一次 —— 这就是它的全部价值。
        //
        // **这一条的形状是被变异测试逼出来的。** 第一版用 8 段 + 并发 2、脚本只给两条,
        // 于是每条泳道都是被自己那次错误停下的("脚本用完了"),`stop` 拿掉照样绿。
        // 要让 `stop` 成为唯一能解释结果的东西,得让**不出错的泳道有活可接**:
        // 8 段、并发 3、只有第 2 段炸,其余六段的成功回复都备好。
        //   有 stop:派出 0/1/2,第 1 段炸 ⇒ 0 和 2 跑完就收工,一共 3 次
        //   没 stop:0 完了接 3、2 完了接 4 …… 一路问到 8 次
        const e = freshEnv({ defs: LOTS });
        e.config.ai = { maxAchievements: 500, chunkSize: 3, concurrency: 3 }; // 24 / 3 = 8 段
        const boom = Object.assign(new Error('HTTP 401'), { code: 'bad-api-key' });
        const third = (n) => LOTS.slice(n * 3, n * 3 + 3);
        const provider = scriptedProvider([
          { text: seg(third(0)) },
          { throws: boom },
          ...Array.from({ length: 6 }, (_, k) => ({ text: seg(third(k + 2)) })),
        ]);
        await assert.rejects(
          () => generateGuide(e.db, { db: e.db, config: e.config, provider, steam: lotsSteam(), appid: '1' }),
          (err) => {
            assert.equal(err.code, 'bad-api-key',
              '**抛的必须是段号最小的那个错**。401 会让在飞的请求一起失败,'
              + '而它们谁先 reject 取决于网络快慢 —— 取"最先炸的"会让同一个输入两次跑报出不同的原因');
            return true;
          }
        );
        assert.ok(provider.asked.length <= 4,
          `问了 ${provider.asked.length} 次(8 段)。撞墙后还在派新活,`
          + '等于每剩一段再撞一次同一堵墙 —— 而那正是顺序版当场抛出去要省掉的东西');
      });

      test('两段一起炸时,报的是段号小的那个,不是先炸的那个', async () => {
        // **这一条是变异测试逼出来的:只有一段失败时,排序和不排序结果一样。**
        // 真实场景是 401 —— 在飞的请求会一起失败,而谁先 reject 只取决于网络快慢。
        // 取"最先炸的"意味着同一个输入两次跑能报出不同的原因,排查时先怀疑的方向就不一样。
        // 所以这里故意让**段号小的那个慢一点炸**:不排序的话它一定选不中。
        const { db, config } = lotsEnv();
        config.ai.concurrency = 3;
        const early = Object.assign(new Error('第 2 段先炸'), { code: 'later-shard' });
        const late = Object.assign(new Error('第 1 段后炸'), { code: 'first-shard' });
        const provider = {
          model: 'x', asked: [], webTools: () => [],
          async send({ system, messages }) {
            const planned = regroupReply(system);
            if (planned) return planned;
            const msg = messages.at(-1).content;
            this.asked.push(msg);
            const from = Number(msg.match(/第 (\d+)–/)?.[1] ?? 0);
            if (from === 1) { await new Promise((r) => setTimeout(r, 30)); throw late; }
            if (from === 7) throw early;
            const text = seg(quarter((from - 1) / 6));
            return {
              content: [{ type: 'text', text }], text, stopReason: 'end_turn', stopDetails: null,
              usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, webSearches: 0, requests: 1 },
              model: 'x', continuations: 0, toolErrors: [], searchQueries: [],
            };
          },
        };
        await assert.rejects(
          () => generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }),
          (err) => {
            assert.equal(err.code, 'first-shard',
              '第 2 段先 reject,但要报的是第 1 段那个 —— 否则同一个输入两次跑报出不同的原因');
            return true;
          }
        );
      });

      test('重写失败时,保住上一轮已经写好的那一段', async () => {
        // 重写轮里那一格装的是上一轮的正文。**改不动不等于该丢掉** ——
        // 抹成空的话,一次"这轮没改好"就把原来能用的那份也带走了,
        // 而用户看到的是那一段凭空消失,不是"这一段没改好"
        const { db, config } = lotsEnv();
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: seg(quarter(2)) },
          // 第 4 段少写一个成就 ⇒ 校验不过 ⇒ 第二轮定点重写它
          { text: seg(quarter(3).slice(0, 5)) },
          { text: '', stop: 'refusal' },   // 第 2 轮:重写失败
          { text: '', stop: 'refusal' },   // 第 3 轮:还是失败
        ]);
        const r = await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });
        const draft = readFileSync(r.draftPath, 'utf8');
        assert.match(draft, new RegExp(quarter(3)[0].name_cn),
          '第 4 段第一轮写出来的内容必须还在 —— 重写没成功,不代表要把它删掉');
        assert.match(draft, new RegExp(quarter(0)[0].name_cn), '别的段更不该受影响');
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

// `--dry-run` 存在的唯一理由是"让人看到会发过去什么"。它自己拼一遍参数就会和真正
// 发出去的那份分叉 —— 实际踩到过:预演漏了 `rarity` 和 `target`,于是 ARK 的预演
// 打印的是 checkbox 标签版,而真跑会发折叠版。**结构上只留一个入口**,分叉无处发生。
test('提示词只有一个入口,预演和真发不会分叉', () => {
  const plan = {
    game: '测试游戏',
    defs: [def('A', '第一步', '完成第一关。')],
    rarity: null,
    target: 'notion',
  };
  const viaPlan = systemPromptFor(plan, '1', { canSearch: true });
  assert.match(viaPlan, /<summary>\*\*前置\*\*/,
    'systemPromptFor 没把 plan.target 透下去 —— 预演就会印错版本');

  // 三条路都必须走 systemPromptFor,不许自己调 buildSystemPrompt 拼参数
  for (const f of ['../lib/guidegen.js', '../lib/guidepatch.js', '../tracker.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const direct = src.split('\n').filter((l) =>
      /\bbuildSystemPrompt\(/.test(l) && !/^export function buildSystemPrompt|return buildSystemPrompt/.test(l.trim()));
    assert.deepEqual(direct, [],
      `${f} 里还有直接调 buildSystemPrompt 的地方 —— 参数会跟另外两条路分叉`);
  }
});

describe('regroupByAssignment(分类挪到最后一趟之后的重排)', () => {
  const D = [
    def('A', '喵界图鉴', '解锁所有吉祥物。'),
    def('B', '狗狗上位', '将吉祥物替换成一条狗。'),
    def('C', '宿敌登台', '将吉祥物替换为一只怪物。'),
    def('E', '开盒', '使用各式钥匙打开30个宝箱。'),
  ];
  const map = (pairs) => new Map(pairs);

  /**
   * 分类那一趟**只列装成就的小节**,纯说明小节它一个字都不会提 —— 而没被提到的一律
   * 接在后面。于是规则 3.5 的「机制速查」会从列表前面被搬到全篇末尾,吊在最后一条成就
   * 下面;那是给人在读列表之前看的东西,挪到末尾等于没写。
   *
   * 《马特的寻猫游戏》重写之后确实是这个结果,不过草稿已经删了,没法证明是重排搬的还是
   * 模型本来就写在末尾。**两种情况下这条规则都对**,所以按规则写,不按猜测写。
   */
  test('分类名单没提到的纯说明小节,留在成就列表原来那一侧', () => {
    const body = [
      '## 机制速查',
      '- 提示条随时间恢复,分三档。',
      '## 商店',
      '- [ ] **喵界图鉴**<br>解锁所有吉祥物。',
      '## 备注',
      '- 数据截至 1.2 版本。',
    ].join('\n');

    const out = regroupByAssignment(body, {
      defs: D, assignment: map([['A', '商店']]), sections: ['商店'],
    });
    const heads = out.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    assert.deepEqual(heads, ['机制速查', '商店', '备注'],
      '速查在前、备注在后 —— 两边都按原文那一侧留着');
  });

  // 马特的寻猫游戏实际踩到的:四条同类吉祥物成就被劈进两个小节。写正文之前那一趟**结构上**
  // 看不见这个劈开(劈开是它之后才发生的),而最后一趟看得见全文,所以能搬回来。
  test('把劈到两处的同类成就搬到一起,小节说明跟着自己的小节走', () => {
    const body = [
      '## 商店',
      '宝石是商店货币。',
      '- [ ] **喵界图鉴**<br>解锁所有吉祥物。',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
      '## 吉祥物替换',
      '- [ ] **宿敌登台**<br>将吉祥物替换为一只怪物。',
    ].join('\n');

    const out = regroupByAssignment(body, {
      defs: D,
      assignment: map([['B', '吉祥物替换'], ['C', '吉祥物替换'], ['A', '商店']]),
      sections: ['商店', '吉祥物替换'],
    });

    assert.match(out, /## 商店\n\n宝石是商店货币。/, '小节说明必须留在自己的小节下');
    const mascot = out.slice(out.indexOf('## 吉祥物替换'));
    assert.match(mascot, /狗狗上位/, '狗狗上位没搬过来');
    assert.match(mascot, /宿敌登台/);
    assert.doesNotMatch(out.slice(0, out.indexOf('## 吉祥物替换')), /狗狗上位/, '搬过去了就不能还留在原处');
  });

  // 模型漏给一条映射时,**原地不动**是唯一不制造新错误的处置 —— 丢掉是静默损失,
  // 塞杂项是把一条分好的成就主动分错
  test('映射没覆盖到的成就留在原来的小节', () => {
    const body = ['## 商店', '- [ ] **喵界图鉴**<br>解锁所有吉祥物。', '- [ ] **开盒**<br>使用各式钥匙打开30个宝箱。'].join('\n');
    const out = regroupByAssignment(body, { defs: D, assignment: map([['A', '商店']]), sections: ['商店'] });
    assert.match(out, /开盒/, '没给映射的条目不能被丢掉');
    assert.equal((out.match(/开盒/g) ?? []).length, 1, '也不能被复制一份');
  });

  // Notion 目标下一条成就的正文是「自己那行 + 几个 <details> 分组」。搬家必须整块搬,
  // 只搬走第一行会把子步骤留在原小节 —— 那正是 todoSpans 只认 checkbox 行的老毛病
  test('带 <details> 分组的成就整块搬走,子步骤不掉队', () => {
    const body = [
      '## 商店',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
      '\t<details>',
      '\t<summary>**前置**</summary>',
      '\t- [ ] 先买下狗狗吉祥物',
      '\t</details>',
      '## 吉祥物替换',
      '- [ ] **宿敌登台**<br>将吉祥物替换为一只怪物。',
    ].join('\n');

    const out = regroupByAssignment(body, {
      defs: D, assignment: map([['B', '吉祥物替换'], ['C', '吉祥物替换']]), sections: ['吉祥物替换'],
    });
    const head = out.slice(0, out.indexOf('## 吉祥物替换'));
    assert.doesNotMatch(head, /先买下狗狗吉祥物/, '子步骤被留在原小节了 —— 区间没吃到折叠');
    assert.match(out.slice(out.indexOf('## 吉祥物替换')), /先买下狗狗吉祥物/);
  });

  // 一条成就都不剩、只剩开场说明的小节:留着是看得见的瑕疵,丢掉是看不见的损失
  test('只剩开场说明的小节保留,不静默丢字', () => {
    const body = ['## 商店', '这一节讲商店怎么用。', '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。'].join('\n');
    const out = regroupByAssignment(body, { defs: D, assignment: map([['B', '吉祥物替换']]), sections: ['吉祥物替换'] });
    assert.match(out, /这一节讲商店怎么用。/, '小节被搬空了,但它的说明不能跟着消失');
  });

  // 《破晓传奇》实测踩到的:小节级的长清单折叠(规则五)里面的 `- [ ]`,在
  // `parseTodos` 眼里是顶层的(前面没有更浅的 checkbox 可挂)。不特判就会被当成
  // 一条条独立成就搬走 —— 折叠剩个空壳、12 个条目散落在外面。
  //
  // **而前两条断言一条都没响**:一个字都没丢,丢的是结构。断言 3 是为此加的,
  // 同样用故障注入验过(把这个分支改成 `if (false && ...)`,它当场抛
  // 「重排把折叠块拆开了」)。
  test('小节级的独立折叠整块跟着小节走,不被拆成一堆顶层条目', () => {
    const body = [
      '## 黎明之后',
      '<details>',
      '<summary>12 个个人支线一览</summary>',
      '- [ ] 「回归自我」',
      '- [ ] 「昨日重现」',
      '</details>',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
    ].join('\n');
    const out = regroupByAssignment(body, {
      defs: D, assignment: new Map([['B', '黎明之后']]), sections: ['黎明之后'],
    });
    assert.match(out, /<summary>12 个个人支线一览<\/summary>\n- \[ \] 「回归自我」/,
      '折叠被掏空了 —— 条目必须留在它里面');
    assert.doesNotMatch(out, /<\/details>\n\n- \[ \] 「回归自我」/,
      '条目被搬到折叠外面去了');
  });

  // 《破晓传奇》实测踩到的：「羁绊」被搬空之后，页面上留下一个只有一段说明、
  // 一条成就都没有的标题,紧跟在拿走了它全部条目的「羁绊与对话」后面。
  // 原来的规则是「留着」,理由是没有规则能说清那段说明该跟谁走 ——
  // 而「条目去得最多的那个小节」就是一个确定的判据,不用猜。
  test('被搬空的小节,开场说明并到接收条目最多的那个小节', () => {
    const body = ['## 商店', '商店怎么用的说明。', '- [ ] **狗狗上位**<br>x', '- [ ] **宿敌登台**<br>y'].join('\n');
    const out = regroupByAssignment(body, {
      defs: D, assignment: new Map([['B', '外观'], ['C', '外观']]), sections: ['外观'],
    });
    assert.doesNotMatch(out, /## 商店/, '被搬空的小节不该再留一个空标题');
    assert.match(out, /商店怎么用的说明。/, '但它的说明一个字都不能丢');
    assert.ok(out.indexOf('## 外观') < out.indexOf('商店怎么用的说明'), '说明要落在接收方那一节里');
  });

  // 本来就没有条目的纯说明小节没有「最多」可言,留着才是对的
  test('本来就没条目的纯说明小节不动', () => {
    const body = ['## 写在前面', '这游戏要通三遍。', '## 商店', '- [ ] **狗狗上位**<br>x'].join('\n');
    const out = regroupByAssignment(body, { defs: D, assignment: new Map(), sections: [] });
    assert.match(out, /## 写在前面/, '没条目可搬的小节不该被并掉');
  });

  // **断言不是摆设,是用故障注入验过的。** 把出口那行改成 `b.prose[0]`(只取开场说明的
  // 第一行)之后,它当场抛出「重排丢了正文:「说明第二行。」进去 1 次、出来 0 次」。
  // 这里留的是它的**反面**:正文里同一条成就出现两次是校验器的活,重排不该顺手"修"掉。
  test('重复条目原样留着,由校验器去报,重排不自作主张', () => {
    const dup = [
      '## 商店',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
      '## 别处',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
    ].join('\n');
    const out = regroupByAssignment(dup, { defs: D, assignment: new Map([['B', '商店']]), sections: ['商店'] });
    assert.equal((out.match(/狗狗上位/g) ?? []).length, 2, '两条都要留着 —— 去重是校验器的职责,不是重排的');
  });
});

/**
 * 规则五的折叠是给长内容用的,不是给成就列表用的 —— 但规则五只写了「到 10 行才折」,
 * 没写「成就本身永远不折」。实测《马特的寻猫游戏》整节 `## 世界全清` 的 13 条成就被
 * 塞进一个折叠里,那一节在 Notion 上显示 0 条。
 */
describe('unwrapAchievementToggles(把藏进折叠的成就掏出来)', () => {
  const D = [
    def('W1', '快乐露营者', '以100%完成度通关世界1的所有关卡。'),
    def('W2', '老练水手', '以100%完成度通关世界2的所有关卡。'),
    def('S', '宿敌登台', '将吉祥物替换为一只怪物。'),
  ];

  test('顶层折叠里装着成就 —— 拆开,标题降成一行加粗', () => {
    const md = [
      '## 世界全清',
      '<details>',
      '<summary>**世界 1~12 全清与通关**</summary>',
      '',
      '- [ ] **快乐露营者**<br>以100%完成度通关世界1的所有关卡。<br>心得',
      '- [ ] **老练水手**<br>以100%完成度通关世界2的所有关卡。<br>心得',
      '</details>',
    ].join('\n');
    const { text, unwrapped } = unwrapAchievementToggles(md, D);
    assert.deepEqual(unwrapped, ['世界 1~12 全清与通关']);
    assert.doesNotMatch(text, /<\/?details|<\/?summary/i, '外壳一点不留');
    assert.match(text, /^\*\*世界 1~12 全清与通关\*\*$/m, '标签留着 —— 它是这一组的名字');
    for (const t of ['快乐露营者', '老练水手']) assert.match(text, new RegExp(t));
  });

  test('缩进的成就掏出来之后回到顶格 —— 不然 parseTodos 把它们当子步骤', () => {
    const md = [
      '## 世界全清',
      '<details>',
      '<summary>全清一览</summary>',
      '\t- [ ] **快乐露营者**<br>以100%完成度通关世界1的所有关卡。',
      '\t- [ ] **老练水手**<br>以100%完成度通关世界2的所有关卡。',
      '</details>',
    ].join('\n');
    const { text } = unwrapAchievementToggles(md, D);
    for (const line of text.split('\n').filter((l) => l.includes('- [ ]'))) {
      assert.equal(line, line.trimStart(), `还缩着:${line}`);
    }
  });

  /**
   * **这一条是防误伤的那一半。** 规则一要求 Notion 目标下把前置/步骤/注意写成缩进的
   * `<details>` 分组标签,那种折叠里装的是子步骤,不是成就 —— 拆了就把规则一毁了。
   */
  test('挂在成就底下的分组标签折叠不许碰', () => {
    const md = [
      '## 吉祥物',
      '- [ ] **宿敌登台**<br>将吉祥物替换为一只怪物。<br>心得',
      '\t<details>',
      '\t<summary>**前置** —— 开局前先备齐</summary>',
      '\t- [ ] 命运商店花 40 点数买「祸之侍身像」',
      '\t</details>',
    ].join('\n');
    const { text, unwrapped } = unwrapAchievementToggles(md, D);
    assert.deepEqual(unwrapped, []);
    assert.equal(text, md, '一个字都不该动');
  });

  /**
   * **缩进这一条是独立的一道闸,不能靠「里面有没有成就」代替。**
   *
   * 分组折叠里的子步骤通常反查不到成就(整句话不等于成就名,`resolveTodoToAchievement`
   * 要的是精确相等),所以多数时候两道闸看起来是一回事。但「前置」这一组**天然会把
   * 别的成就一条一行列出来**,那种行是精确相等的,反查得到 —— 那时候只剩缩进能说明
   * 这是挂在别人底下的辅料,而不是一节成就列表。拆了它,规则一的分组标签就毁了,
   * 而且那几条子步骤会变成顶层条目,读起来像重复的成就。
   */
  test('缩进折叠里逐条列出的前置成就,也不许拆', () => {
    const md = [
      '## 世界全清',
      '- [ ] **快乐露营者**<br>以100%完成度通关世界1的所有关卡。<br>心得',
      '\t<details>',
      '\t<summary>**前置** —— 这两条先做掉</summary>',
      '\t- [ ] **宿敌登台**',
      '\t- [ ] **老练水手**',
      '\t</details>',
    ].join('\n');
    const { text, unwrapped } = unwrapAchievementToggles(md, D);
    assert.deepEqual(unwrapped, [], '缩进说明它是辅料,里面提到成就不改变这一点');
    assert.equal(text, md);
  });

  test('装的不是成就的顶层折叠也不碰 —— 全结局对照表那种', () => {
    const md = [
      '## 收集',
      '<details>',
      '<summary>全结局对照表</summary>',
      '- [ ] 结局 A:第 3 章选左边',
      '- [ ] 结局 B:第 3 章选右边',
      '</details>',
    ].join('\n');
    const { text, unwrapped } = unwrapAchievementToggles(md, D);
    assert.deepEqual(unwrapped, []);
    assert.equal(text, md);
  });

  // 模型被截断时正好留下一个没关的 <details>,一路吃到文末会吞掉后面所有成就
  test('折叠没闭合就不动它', () => {
    const md = [
      '## 世界全清',
      '<details>',
      '<summary>全清一览</summary>',
      '- [ ] **快乐露营者**<br>以100%完成度通关世界1的所有关卡。',
    ].join('\n');
    const { text, unwrapped } = unwrapAchievementToggles(md, D);
    assert.deepEqual(unwrapped, []);
    assert.equal(text, md);
  });

  test('开合标签各占一行的 summary 也认', () => {
    const md = [
      '## 世界全清',
      '<details>',
      '<summary>',
      '世界 1~12 全清',
      '</summary>',
      '- [ ] **快乐露营者**<br>以100%完成度通关世界1的所有关卡。',
      '- [ ] **老练水手**<br>以100%完成度通关世界2的所有关卡。',
      '</details>',
    ].join('\n');
    const { text, unwrapped } = unwrapAchievementToggles(md, D);
    assert.deepEqual(unwrapped, ['世界 1~12 全清']);
    assert.doesNotMatch(text, /<\/?summary/i, '裸的 summary 标签不许留在正文里');
  });

  test('没有折叠的正文原样返回', () => {
    const md = '## 一节\n\n- [ ] **宿敌登台**<br>将吉祥物替换为一只怪物。';
    assert.deepEqual(unwrapAchievementToggles(md, D), { text: md, unwrapped: [] });
  });
});

/**
 * 已经解锁的成就只写一行。
 *
 * 攻略是拿来照着做的,而已经做完的那几条不需要做法 —— 名字、官方描述、一个能勾的框
 * 就是他还会用到的全部。省掉的是这几条的查资料和正文,也就是这个功能唯一花钱的地方。
 */
describe('已解锁的成就只写一行', () => {
  describe('briefApiNames —— 谁进略写名单', () => {
    const D = [def('A', '甲', '一'), def('B', '乙', '二'), def('C', '丙', '三')];

    test('解锁了的进,没解锁的不进', () => {
      assert.deepEqual([...briefApiNames(D, ['A', 'C'])], ['A', 'C']);
    });

    test('一个都没解锁 → 名单是空的', () => {
      assert.deepEqual([...briefApiNames(D, [])], []);
    });

    // **全解锁的游戏一条都不省。** 省下来的就是整篇攻略 —— 剩下一串只有名字和官方
    // 描述的行,而那份东西 Steam 页面上本来就有。会给 100% 的游戏生成攻略的人,
    // 要的恰恰是内容
    test('全解锁 → 名单是空的,不是全都进', () => {
      assert.deepEqual([...briefApiNames(D, ['A', 'B', 'C'])], []);
    });

    test('没有成就时不炸', () => {
      assert.deepEqual([...briefApiNames([], ['A'])], []);
      assert.deepEqual([...briefApiNames(null, null)], []);
    });
  });

  describe('buildChunkMessage —— 提示词里怎么说', () => {
    const D = [def('A', '甲', '一'), def('B', '乙', '二'), def('C', '丙', '三'), def('D', '丁', '四')];

    // 名单空的时候这句话必须**一个字都不多** —— 这是绝大多数攻略走的那条路
    test('没有要略写的 → 和原来一字不差', () => {
      assert.equal(buildChunkMessage([D], 0, new Set()),
        '开始写吧。先联网查资料,再按规则写完整份攻略。');
      assert.equal(buildChunkMessage([D], 0), '开始写吧。先联网查资料,再按规则写完整份攻略。');
    });

    test('略写的是少数 → 点名那几个', () => {
      const m = buildChunkMessage([D], 0, briefApiNames(D, ['A']));
      assert.match(m, /「甲」/);
      assert.match(m, /一行就停/);
      assert.doesNotMatch(m, /「乙」/, '要写完整的那些不该出现在略写名单里');
    });

    // 大部分游戏是"已经解锁了一大半",那时候列"要写详细的这几个"比列"要略写的
    // 那四十个"短得多,而且正好是模型这一段真正要干的活
    test('略写的是多数 → 反过来点名要写完整的那几个', () => {
      const m = buildChunkMessage([D], 0, briefApiNames(D, ['A', 'B', 'C']));
      assert.match(m, /只有这几个要按规则写完整/);
      assert.match(m, /「丁」/);
      assert.doesNotMatch(m, /「甲」/, '略写的是多数时不该再把它们一个个列出来');
    });

    test('分段时那句话跟着段走,不是全篇一份', () => {
      const chunks = [D.slice(0, 2), D.slice(2)];
      const brief = briefApiNames(D, ['A', 'D']);
      assert.match(buildChunkMessage(chunks, 0, brief), /「甲」/);
      assert.doesNotMatch(buildChunkMessage(chunks, 0, brief), /「丁」/, '第一段不该提别段的成就');
      assert.match(buildChunkMessage(chunks, 1, brief), /「丁」/);
    });
  });

  describe('端到端:generateGuide 真的这么问', () => {
    test('解锁了一个 → 提示词里点名让它只写一行', async () => {
      const { db, config } = freshEnv();
      const provider = fakeProvider([GOOD]);
      await generateGuide(db, { config, provider, steam: fakeSteam(['A']), appid: '1' });
      assert.match(provider.asked[0], /「第一步」/, '已解锁的那条要被点名');
      assert.match(provider.asked[0], /一行就停/);
    });

    test('全解锁 → 一条都不略,提示词回到原来那句', async () => {
      const { db, config } = freshEnv();
      const provider = fakeProvider([GOOD]);
      await generateGuide(db, { config, provider, steam: fakeSteam(['A', 'B']), appid: '1' });
      assert.doesNotMatch(provider.asked[0], /一行就停/,
        '全解锁时省下来的就是整篇攻略,剩下的东西 Steam 页面上本来就有');
    });

    // **覆盖重写一条都不省。** 攻略里已经有花过钱写出来的正文,而"他后来把这条解锁了"
    // 不是把那段字删掉的理由 —— 删掉之后没有任何地方找得回来
    test('覆盖重写 → 不略写,已经写出来的正文不许被收成一行', async () => {
      const { db, config } = freshEnv();
      const provider = fakeProvider([GOOD]);
      await generateGuide(db, {
        config, provider, steam: fakeSteam(['A']), appid: '1', overwrite: true,
      });
      assert.doesNotMatch(provider.asked[0], /一行就停/,
        '覆盖时略写等于把他付过钱的正文删掉');
    });
  });
});
