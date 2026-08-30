/**
 * AI guide generation orchestration
 * ------------------------------------------------
 * Run with: node --test
 *
 * The failure class this file guards is **something unvalidated slipping into the user's notes**,
 * plus whether a few structural guarantees can be bypassed. The earlier files guard "is the
 * computation right"; this one guards "was what should have been stopped actually stopped":
 *
 *  - **A draft must never be picked up by guide discovery**. Picked up, it is registered in the
 *    guides table, and checkbox-sync then takes a guide that failed three rounds and ticks the
 *    user's boxes — precisely what the whole design forbids
 *  - **The `appid:` line is written by the program**. One digit mistranscribed by the model
 *    registers the guide against another game, with neither side reporting anything
 *  - **`checked-mismatch` is never fed back to the model**. Feeding it back is asking it to write
 *    `- [x]`, and "the model only writes `- [ ]` while the program ticks from the database" is the
 *    foundation of this design
 *  - **An achievement whose name collides is exempt from checked-mismatch**, or the 3 games whose
 *    Chinese and English names both collide could never pass; but the exemption has to be
 *    computed **per name** — one whose Chinese name collides while its English name is unique can
 *    still be ticked, and a wrong exemption hides a real problem
 *
 * No network: both the provider and Steam are fake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb, insertGame, replaceAchievements, upsertGuide, allGuides, setGuideLang,
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
  PROMPT_SECTIONS,
  DRAFTS_DIR,
  unwrapAchievementToggles,
} from '../lib/guidegen.js';

// ---------------------------------------------------------------------------
// Scaffolding
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

/** The achievements table reads back in snake_case and is written in camelCase — this converts once */
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
 * The baffle for the classification pass. **The first line of every fake provider's send has to
 * go through it.**
 *
 * That pass runs in its own session (its system is `REGROUP_SYSTEM`) and must not consume any
 * scripted queue — consuming one presents as "the replies ran out / the script ran out", reported
 * a very long way from the real cause, and every new sharding test would hit it again.
 *
 * Passing null for `sections` models "classification did not succeed" and takes the degraded path
 * (equivalent to the behaviour before this pass was added).
 */
const REGROUP_SECTIONS = ['主线', '支线', '收集', '杂项'];
function regroupReply(system, sections = REGROUP_SECTIONS, count = 5) {
  // Recognised by REGROUP_SYSTEM; the format is 「== 标题 / 编号」 — what `parseRegroupReply` reads
  if (system !== REGROUP_SYSTEM) return null;
  const text = sections
    ? sections.map((x, i) => {
      // Hand the numbers out in order, with the last section catching the remainder, so every
      // number appears exactly once
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
 * Yields the prepared replies in order and records the user message sent each time.
 *
 * **The classification pass does not consume this queue.** It runs in its own session (its system
 * is `REGROUP_SYSTEM`) and is recognised by that here and answered separately — otherwise every
 * new sharding test would have to remember to prepend a classification reply to the queue, and
 * forgetting presents as "the replies ran out", reported a very long way from the real cause.
 *
 * Passing null for `sections` models "classification did not succeed" and takes the degraded path
 * (equivalent to the behaviour before this pass was added).
 */
function fakeProvider(replies, { sections = ['主线', '支线', '收集', '杂项'] } = {}) {
  return {
    model: 'claude-opus-5',
    asked: [],
    regroupAsks: 0,
    regroupPrompt: null,
    // Web tools are declared by the provider itself and the orchestration layer only forwards
    // them. A test needs no real tools
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
      if (text === undefined) throw new Error('fakeProvider ran out of replies');
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
  // Global unlock rates are a nice-to-have: return null when they cannot be fetched and the flow carries on
  async fetchGlobalAchievementPercentages() {
    return rarity;
  },
});

const GOOD = '```markdown\n## 主线\n\n- [ ] **第一步**<br>完成第一关。<br>开局就能拿\n- [ ] **第二步**<br>完成第二关。<br>接着打\n```';
const MISSING_B = '```markdown\n## 主线\n\n- [ ] **第一步**<br>完成第一关。\n```';

// ---------------------------------------------------------------------------
// Colliding names → out of reach of mechanical ticking
// ---------------------------------------------------------------------------

describe('unnameableApiNames', () => {
  test('both the Chinese and the English collide → both are out of reach', () => {
    const defs = [def('A', '妙手空空', '偷 10 次', 'Skilled Thief'), def('B', '妙手空空', '偷 100 次', 'Skilled Thief')];
    assert.deepEqual([...unnameableApiNames(defs)].sort(), ['A', 'B']);
  });

  test('only the Chinese collides while the English is unique → still tickable, so no exemption', () => {
    // 9 of the 12 games with colliding names are this kind (a Steam localisation bug). A wrong
    // exemption hides a real problem
    const defs = [
      def('A', '亦敌亦友', '描述一', 'Frenemy'),
      def('B', '亦敌亦友', '描述二', 'Frenemies'),
    ];
    assert.equal(unnameableApiNames(defs).size, 0);
  });

  test('every name unique → an empty set', () => {
    assert.equal(unnameableApiNames(DEFS).size, 0);
  });
});

describe('splitFindings', () => {
  const mismatch = (apiName) => ({ level: 'error', code: 'checked-mismatch', apiName, message: 'x' });

  test('checked-mismatch on a colliding achievement is expected and does not block', () => {
    const { blocking, expected } = splitFindings([mismatch('A')], new Set(['A']));
    assert.equal(blocking.length, 0);
    assert.equal(expected.length, 1);
  });

  test('checked-mismatch on a non-colliding one has to block — that means our own ticking went wrong', () => {
    const { blocking } = splitFindings([mismatch('Z')], new Set(['A']));
    assert.equal(blocking.length, 1);
  });

  test('every other rule still blocks — the exemptions are listed one by one, not by class', () => {
    const { blocking } = splitFindings(
      [{ level: 'error', code: 'missing-checkbox', apiName: 'A', message: 'x' }],
      new Set(['A'])
    );
    assert.equal(blocking.length, 1);
  });

  test('a warn does not go into blocking', () => {
    const { blocking } = splitFindings([{ level: 'warn', code: 'paraphrased-description', message: 'x' }], new Set());
    assert.equal(blocking.length, 0);
  });

  // -------------------------------------------------------------------------
  // A colliding name plus an empty Steam description: out of reach, but it must not block
  // -------------------------------------------------------------------------
  const emptyDesc = (apiName, name = 'Proud Player') => ({
    level: 'error', code: 'ambiguous-empty-description', apiName, name, message: '注定同步不上',
  });

  test('a colliding achievement with an empty description is expected and does not block', () => {
    // The only handle that separates these two achievements (the verbatim description) does not
    // exist on Steam at all, so no rewrite can satisfy it. The actual consequence of blocking was
    // measured: one complete 197/197 guide was kept out by 15 findings of this kind, while the
    // message itself says it is not something a guide can fix
    const { blocking, expected } = splitFindings([emptyDesc('A')], new Set(['A']));
    assert.equal(blocking.length, 0);
    assert.equal(expected.length, 1);
  });

  test('unnameable is not consulted — the trigger for this one already includes "the name collides"', () => {
    // Unlike checked-mismatch: that one is reported for any achievement, so it needs the
    // unnameable gate; this one is narrower than unnameable. It has to be exempt even given an
    // empty set, or the path where lint runs on its own becomes inconsistent
    const { blocking, expected } = splitFindings([emptyDesc('A')], new Set());
    assert.equal(blocking.length, 0);
    assert.equal(expected.length, 1);
  });

  test('the kind where the description **exists** and merely was not copied has to keep blocking — a rewrite fixes that one', () => {
    // This is where the change is most easily taken too far: the two used to share one code, and
    // letting both through means letting "should have copied it and did not" through as well —
    // which is the one lifeline a colliding achievement has
    const { blocking, expected } = splitFindings(
      [{ level: 'error', code: 'ambiguous-no-description', apiName: 'A', message: '没抄描述原文' }],
      new Set(['A'])
    );
    assert.equal(blocking.length, 1, 'having a description and not copying it is the guide problem and cannot be exempt');
    assert.equal(expected.length, 0);
  });
});

// ---------------------------------------------------------------------------
// What is fed back
// ---------------------------------------------------------------------------

test('the list fed back to the model never contains checked-mismatch', () => {
  const fb = buildFeedback([
    { level: 'error', code: 'missing-checkbox', message: '成就没有对应的 checkbox 行:第二步' },
    { level: 'error', code: 'checked-mismatch', message: '成就已解锁但框没勾:第一步' },
  ]);
  assert.match(fb, /第二步/);
  assert.doesNotMatch(fb, /已解锁但框没勾/, 'ask the model to fix a checked state and it starts writing - [x] at random');
  assert.match(fb, /完整的修改后全文/, 'the full text is needed, or a complete guide cannot be reassembled');
});

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------

describe('extractMarkdown', () => {
  test('takes what is inside the fence', () => {
    assert.equal(extractMarkdown('好的:\n```markdown\n# 标题\n```\n写完了'), '# 标题');
  });
  test('with several fences it takes the longest (the body is always longer than a fragmentary example)', () => {
    assert.equal(extractMarkdown('```\n短\n```\n中间\n```markdown\n很长很长的正文\n```'), '很长很长的正文');
  });
  test('with no fence the whole thing is the body', () => {
    assert.equal(extractMarkdown('# 标题\n- [ ] A'), '# 标题\n- [ ] A');
  });
});

/**
 * An achievement line has three segments: `- [ ] **名字**<br>官方描述<br>心得`.
 *
 * **A hidden achievement has no description on Steam** — the endpoint returns an empty string, so
 * the list given to the model says 「官方描述:(Steam 上是空的)」 for that entry, the model copies
 * an empty one following rule 4 (copy verbatim), and the middle segment is empty.
 * `notionblocks.js` turns each `<br>` into one `\n`, and two in a row is a jarring blank line
 * between the achievement name and the notes on the page.
 *
 * Measured on one game (926340): 28 of 50 achievements are hidden, and the blocks read back look
 * like `"扑朔迷离\n\n与艾尔耿对话,被问到…"` while the normal ones look like
 * `"初入酒馆\n欢迎光临白星酒馆\n序章…"`. More than half the entries carried that blank line.
 */
describe('an empty official description leaves no blank line', () => {
  test('an empty middle segment is collapsed', () => {
    assert.equal(
      collapseEmptyBreaks('- [ ] **扑朔迷离**<br><br>与艾尔耿对话时作答即解锁。'),
      '- [ ] **扑朔迷离**<br>与艾尔耿对话时作答即解锁。'
    );
  });

  test('**a line with all three segments is untouched**', () => {
    const line = '- [ ] **初入酒馆**<br>欢迎光临白星酒馆<br>序章开场剧情自动解锁。';
    assert.equal(collapseEmptyBreaks(line), line);
  });

  test('whitespace counts as an empty segment — what the model copies back often carries a space', () => {
    assert.equal(
      collapseEmptyBreaks('- [ ] **名字**<br>   <br>心得'),
      '- [ ] **名字**<br>心得'
    );
  });

  test('a trailing <br> is removed as well', () => {
    assert.equal(collapseEmptyBreaks('- [ ] **名字**<br>描述<br>'), '- [ ] **名字**<br>描述');
  });

  test('`<br/>` and `<BR>` are both recognised', () => {
    assert.equal(collapseEmptyBreaks('- [ ] **名字**<br/><BR />心得'), '- [ ] **名字**<br>心得');
  });

  test('an indented sub-step is handled the same way', () => {
    assert.equal(
      collapseEmptyBreaks('  - [ ] **子步骤**<br><br>说明'),
      '  - [ ] **子步骤**<br>说明'
    );
  });

  test('**only checkbox lines are touched** — consecutive <br> in a prose paragraph may be a deliberate blank line', () => {
    const prose = '这是一段正文<br><br>下面接着写';
    assert.equal(collapseEmptyBreaks(prose), prose);
    assert.equal(collapseEmptyBreaks('## 主线\n\n' + prose), '## 主线\n\n' + prose);
  });

  test('a line that is entirely empty segments is left as it is — that is a different problem, for lint to report', () => {
    assert.equal(collapseEmptyBreaks('- [ ] <br><br>'), '- [ ] <br><br>');
  });

  test('across many lines only the ones that need it change, with the count and order unchanged', () => {
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

  test('empty input does not blow up', () => {
    assert.equal(collapseEmptyBreaks(''), '');
    assert.equal(collapseEmptyBreaks(null), '');
    assert.equal(collapseEmptyBreaks(undefined), '');
  });

  /**
   * **Both landing paths have to pass through this.** Full generation and partial rewrite each
   * call `extractMarkdown` once, and wiring only one of them means the same guide grows blank
   * lines again under a different command — a drift no test would turn red for.
   */
  test('both full generation and partial rewrite are wired up', () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['lib/guidegen.js', 'lib/guidepatch.js']) {
      const src = strip(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
      const calls = [...src.matchAll(/extractMarkdown\(reply\.text\)/g)];
      assert.ok(calls.length >= 1, `cannot find extractMarkdown(reply.text) in ${f}`);
      for (const m of calls) {
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
        assert.match(line, /collapseEmptyBreaks\(/,
          `one extractMarkdown in ${f} is not wrapped in collapseEmptyBreaks: ${line.trim()}`);
      }
    }
  });
});

describe('the program writes the first two lines, not the model', () => {
  test('a title and appid line the model writes itself are stripped', () => {
    // One digit mistranscribed in the appid registers the guide against another game, with
    // neither side reporting anything
    const md = '# 别的游戏\n\nappid: 999999\n\n## 主线\n\n- [ ] **第一步**';
    const body = stripLeadingHeader(md);
    assert.equal(body, '## 主线\n\n- [ ] **第一步**');
    const full = buildHeader('测试游戏', '1') + '\n' + body;
    assert.match(full, /^# 测试游戏\n\nappid: 1\n/);
    assert.doesNotMatch(full, /999999/);
  });

  test('a level-two heading is not deleted by mistake', () => {
    assert.equal(stripLeadingHeader('## 主线成就\n\n- [ ] **A**'), '## 主线成就\n\n- [ ] **A**');
  });

  test('the generated header is recognised by syncGuidesFromMarkdown', () => {
    const head = buildHeader('测试游戏', '1');
    assert.match(head, /^appid:\s*1$/im);
    assert.match(head, /^#\s+测试游戏$/m);
  });
});

describe('guideFileName', () => {
  test('an English name becomes a slug', () => {
    assert.equal(guideFileName("Sultan's Game", '1'), 'sultan_s_game_achievements.md');
  });
  test('a Chinese name yields no ASCII, so it falls back to the appid', () => {
    assert.equal(guideFileName('空之轨迹', '3447040'), 'app_3447040_achievements.md');
  });
});

test('the achievement list marks the colliding entries for the model', () => {
  const defs = [def('A', '妙手空空', '偷 10 次'), def('B', '妙手空空', '偷 100 次'), def('C', '独一份', '别的')];
  const list = buildAchievementList('鬼谷八荒', '1', defs);
  assert.equal((list.match(/⚠️ 同名/g) ?? []).length, 2);
  assert.match(list, /共 3 个/);
  assert.match(list, /偷 10 次/, 'the description has to go out, or the model cannot copy it verbatim');
});

// ---------------------------------------------------------------------------
// Preflight: every refusal reason has to be given before any money is spent
// ---------------------------------------------------------------------------

describe('the planGuide gates', () => {
  test('the appid is not in the library → refused', async () => {
    const { db, config } = freshEnv();
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '999' }),
      /不在列表里/
    );
  });

  /**
   * **Missing achievement detail is no longer a refusal reason; it is fetched on the spot.**
   *
   * This used to refuse with "run `node tracker.js sync --schema` first", and a Dashboard user
   * (especially in the packaged build) has no terminal at all — that sentence is a dead end for
   * them. And it is not a rare case: a newly added game has not had its turn in the batch sync
   * yet, while a completed game is deliberately skipped by syncAchievementSchema (`rate === 1`),
   * so for the latter that wall is **permanent** no matter how many syncs are run.
   */
  test('no achievement detail → fetch once from Steam on the spot rather than demanding a command line', async () => {
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
    assert.equal(plan.defs.length, 1, 'what was fetched has to be directly usable');
    assert.ok(asked >= 1, 'Steam really should have been asked');
  });

  test('Steam has no achievement list either → only then refuse, and without mentioning a command line', async () => {
    const { db, config } = freshEnv({ defs: [] });
    const steam = { ...fakeSteam(), async fetchAchievementSchema() { return null; } };
    await assert.rejects(
      planGuide(db, { config, steam, appid: '1' }),
      (err) => {
        assert.equal(err.code, 'no-schema');
        assert.doesNotMatch(err.message, /tracker\.js|config\.json|sync --schema/,
          'this sentence appears verbatim on the Dashboard, so it must not send someone with no terminal to type a command');
        return true;
      }
    );
  });

  test('too many achievements → refused, leaving "which setting to change" to the CLI', async () => {
    const { db, config } = freshEnv();
    config.ai.maxAchievements = 1;
    await assert.rejects(
      planGuide(db, { config, steam: fakeSteam(), appid: '1' }),
      (err) => {
        assert.match(err.message, /上限/);
        assert.equal(err.code, 'too-many-achievements');
        assert.deepEqual(err.detail, { count: 2, max: 1 }, 'the numbers have to come through, or the CLI cannot assemble its advice');
        assert.doesNotMatch(err.message, /config\.json/, 'a Dashboard user cannot edit the config file');
        return true;
      }
    );
  });

  test('a Notion guide page already exists → refused (one appid, one backend)', async () => {
    const { db, config } = freshEnv();
    upsertGuide(db, { appid: '1', name: '测试游戏', url: 'https://notion.so/x', kind: 'notion' });
    await assert.rejects(planGuide(db, { config, steam: fakeSteam(), appid: '1' }), /Notion/);
  });

  test('the target file already exists → refuse to overwrite (backup / diff / confirmation is step 8)', async () => {
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

  test('Steam cannot give the unlock state → refuse to generate', async () => {
    // A guide with nothing ticked is a wrong guide, and it would be reported as a pile of
    // checked-mismatch findings, looking as though the model wrote it wrongly
    const { db, config } = freshEnv();
    const steam = { async fetchPlayerAchievements() { return { retry: true }; } };
    await assert.rejects(planGuide(db, { config, steam, appid: '1' }), /解锁状态/);
  });
});

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

describe('generateGuide', () => {
  test('one round passes: it lands, is mechanically ticked and is registered in the guides table', async () => {
    const { db, config } = freshEnv();
    const provider = fakeProvider([GOOD]);
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(['A']), appid: '1' });

    assert.equal(r.ok, true);
    assert.equal(r.rounds, 1);
    assert.ok(existsSync(r.path));

    const text = readFileSync(r.path, 'utf8');
    // Everything the model writes is `- [ ]`; the unlocked one is ticked by the program
    assert.match(text, /- \[x\] \*\*第一步\*\*/, 'the unlocked one has to be mechanically ticked');
    assert.match(text, /- \[ \] \*\*第二步\*\*/, 'the locked one must not be ticked');
    assert.match(text, /^# 测试游戏/);
    assert.match(text, /^appid: 1$/m);

    // Registered through the real discovery logic, which is what makes the link visible on the Dashboard
    assert.equal(allGuides(db).length, 1);
    assert.equal(allGuides(db)[0].kind, 'local');
    assert.ok(r.registered);
  });

  test('the draft is cleaned up after passing and does not stay in .drafts/', async () => {
    const { db, config } = freshEnv();
    const r = await generateGuide(db, { config, provider: fakeProvider([GOOD]), steam: fakeSteam(), appid: '1' });
    assert.equal(existsSync(join(config.guidesDir, DRAFTS_DIR, guideFileName('测试游戏', '1'))), false);
    assert.equal(r.draftPath, null);
  });

  test('the first round missed an achievement and the second fills it in after feedback → pass', async () => {
    const { db, config } = freshEnv();
    const provider = fakeProvider([MISSING_B, GOOD]);
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1', rounds: 3 });

    assert.equal(r.ok, true);
    assert.equal(r.rounds, 2);
    assert.equal(provider.asked.length, 2);
    assert.match(provider.asked[1], /第二步/, 'the feedback list has to name which achievement was missed');
  });

  test('all three rounds fail → it stays a draft, does not land, and discovery cannot see it', async () => {
    const { db, config } = freshEnv();
    const provider = fakeProvider([MISSING_B, MISSING_B, MISSING_B]);
    const r = await generateGuide(db, { config, provider, steam: fakeSteam(), appid: '1', rounds: 3 });

    assert.equal(r.ok, false);
    assert.equal(r.rounds, 3);
    assert.equal(provider.asked.length, 3, 'exactly 3 rounds, no more');
    assert.equal(r.path, null);
    assert.ok(existsSync(r.draftPath), 'a failed run is kept too: throwing it away burns the money and leaves nothing');
    assert.equal(r.blocking.some((f) => f.code === 'missing-checkbox'), true);

    // This is the most important case in the file: an unvalidated draft must never be registered,
    // or checkbox-sync takes it and ticks the user's boxes
    const found = syncGuidesFromMarkdown(db, config);
    assert.equal(found.files, 0, '.drafts/ is a subdirectory, and readdirSync is non-recursive and .md-only, so it is not seen');
    assert.equal(allGuides(db).length, 0);
  });

  // There are only two achievements here, too few to shard (see MIN_CHUNK), so this takes the
  // "stop" path. With enough achievements, a truncation first shards smaller and asks again — see
  // the "shard smaller and ask again after a truncation" group. What the two paths share is what
  // this case really pins: **half a guide never goes further**
  test('the model response was truncated (max_tokens) and cannot be sharded → stop on the spot rather than carrying half a guide forward', async () => {
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
  // A colliding name with an empty description: the whole guide has to land, and it has to be reported
  // -------------------------------------------------------------------------
  // Reproducing the shape of a four-in-one compilation, where each sub-game has its own
  // 「Proud Player」 and Steam returns an empty string as their description.
  // Before the change: a guide with all 197 entries written correctly was blocked by 15 findings
  // of this kind, after first spending three rounds asking the model to copy a description that
  // does not exist, and nothing landed in the end.
  describe('a colliding achievement with no description on Steam', () => {
    const TWINS = [
      def('ACH_001', 'Proud Player', ''),      // empty description — nobody can fix it
      def('ACH_104', 'Proud Player', ''),      // same name, equally empty
      def('ACH_007', '独一份', '完成第七关。'), // a normal one, as a control
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
    // All three written, with the names character for character — nothing wrong on the guide side
    const BODY =
      '```markdown\n## 全部\n\n' +
      '- [ ] **Proud Player**<br>隐藏成就:Proud 难度通关。<br>KH1 那一份。\n' +
      '- [ ] **Proud Player**<br>隐藏成就:Proud 难度通关。<br>KH2 那一份。\n' +
      '- [ ] **独一份**<br>完成第七关。<br>顺着主线走。\n```';

    test('it lands in one round and is not sent back for a rewrite', async () => {
      const { db, config } = twinsEnv();
      const provider = fakeProvider([BODY]);
      const r = await generateGuide(db, { config, provider, steam: twinsSteam(), appid: '1' });

      assert.equal(r.ok, true, 'a correctly written guide should land — the finding blocking it is one nobody can fix');
      assert.ok(r.path, 'it has to be really written into guides/, not left as a draft');
      assert.equal(provider.asked.length, 1, 'one round is enough; it should not spend two more copying a description that does not exist');
      assert.equal(r.blocking.length, 0);
    });

    test('landing does not excuse silence — these boxes can never be recognised by automatic ticking', async () => {
      const { db, config } = twinsEnv();
      const r = await generateGuide(db, {
        config, provider: fakeProvider([BODY]), steam: twinsSteam(), appid: '1',
      });
      // Not blocking ≠ staying silent. Without a report, the user finds out one day by noticing
      // two boxes that never move, and by then it looks more like the sync is broken
      const named = r.expected.filter((f) => f.code === 'ambiguous-empty-description');
      assert.equal(named.length, 2, 'one finding for each colliding achievement');
      assert.deepEqual([...new Set(named.map((f) => f.name))], ['Proud Player'],
        'report the spelling as it is on Steam, so the user can match it up');
      // The normal one should not be dragged in
      assert.ok(!named.some((f) => f.apiName === 'ACH_007'));
    });

    test('with a real problem in the same round, it still must not appear in the send-back list', async () => {
      // **Keeping it out of `MODEL_FIXABLE` is the second line of defence, and this case is the
      // only angle from which it is visible.**
      //
      // Normally splitFindings has already moved it into expected and the rewrite round never
      // touches it — so adding it back into MODEL_FIXABLE turns no test red (measured during
      // mutation testing). The membership only matters when **another** genuinely fixable error
      // exists in the same round and the rewrite round really runs: `buildFeedback` filters
      // findings by MODEL_FIXABLE directly, without going through splitFindings first
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
      // Write both out in full rather than assembling with replace — the first ``` is the
      // **opening** fence, and replacing it hands over a body with no fence at all, which the
      // extractMarkdown fallback then makes look like normal operation
      const TWO_TWINS =
        '- [ ] **Proud Player**<br>隐藏成就。<br>KH1。\n' +
        '- [ ] **Proud Player**<br>隐藏成就。<br>KH2。\n';
      const twinsOnly = '```markdown\n## 全部\n\n' + TWO_TWINS + '```';
      const allThree = '```markdown\n## 全部\n\n' + TWO_TWINS +
        '- [ ] **漏掉的那条**<br>完成第九关。<br>补上了。\n```';
      const provider = fakeProvider([twinsOnly, allThree]);
      const r = await generateGuide(db, { config, provider, steam, appid: '1' });

      assert.equal(r.ok, true);
      assert.equal(provider.asked.length, 2, 'one was missed in the first round and filled in on the second');
      const feedback = provider.asked[1];
      assert.match(feedback, /漏掉的那条/, 'the genuinely fixable one has to be in the send-back list');
      assert.doesNotMatch(feedback, /注定同步不上/,
        'the one with an empty description must not appear in the send-back list — that is asking the model to copy a string that does not exist');
    });

    test('when the description **exists** and merely was not copied, it is still sent back for a rewrite', async () => {
      // The other half: do not let "should have copied it and did not" through as well
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
      // Neither copies the description → it has to be sent back
      const noDesc = '```markdown\n## 全部\n\n- [ ] **Proud Player**<br>随便写的<br>心得\n' +
        '- [ ] **Proud Player**<br>也是随便写的<br>心得\n```';
      const provider = fakeProvider([noDesc, noDesc, noDesc]);
      const r = await generateGuide(db, { config, provider, steam, appid: '1' });

      assert.equal(r.ok, false, 'having a description and not copying it is the guide problem and has to block');
      assert.ok(provider.asked.length > 1, 'this kind has to be fed back for a rewrite');
      assert.ok(r.blocking.some((f) => f.code === 'ambiguous-no-description'));
    });
  });

  test('an invalid rounds value is stopped on the spot (otherwise it reads as "passed" and then copies a draft that does not exist)', async () => {
    const { db, config } = freshEnv();
    for (const bad of [0, -1, NaN, 2.5]) {
      await assert.rejects(
        generateGuide(db, { config, provider: fakeProvider([GOOD]), steam: fakeSteam(), appid: '1', rounds: bad }),
        /rounds/
      );
    }
  });

  test('usage accumulates across rounds so the cost can be worked out', async () => {
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config, provider: fakeProvider([MISSING_B, GOOD]), steam: fakeSteam(), appid: '1', rounds: 3,
    });
    assert.equal(r.usage.requests, 2);
    assert.equal(r.usage.outputTokens, 40);
  });

  test('the system prompt is byte-identical, which is what lets the feedback round hit the prefix cache', async () => {
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
    assert.equal(seen[0], seen[1], 'one byte different in system and the whole cache behind it is void');
  });
});

test('the drafts directory sits under guidesDir, and discovery cannot see it', () => {
  const { db, config } = freshEnv();
  mkdirSync(join(config.guidesDir, DRAFTS_DIR), { recursive: true });
  writeFileSync(join(config.guidesDir, DRAFTS_DIR, 'x_achievements.md'), '# X\n\nappid: 42\n\n- [ ] **A**');
  const found = syncGuidesFromMarkdown(db, config);
  assert.equal(found.files, 0);
  assert.equal(allGuides(db).length, 0);
});

test('an opening fence with no closing fence still has to be extracted cleanly (the model forgot to close it / the output was truncated)', () => {
  // Hit on 2026-08-10: the paired regex did not match, so the ```markdown line landed verbatim in
  // the guide file. **The validator cannot catch it** — that line is neither a checkbox nor a
  // violation of any rule, and 51/51 stayed green
  assert.equal(extractMarkdown('```markdown\n## 主线\n\n- [ ] **A**'), '## 主线\n\n- [ ] **A**');
  assert.equal(extractMarkdown('```md\n- [ ] **A**\n```'), '- [ ] **A**');
  // Properly paired ones, and ones with no fence at all, behave exactly as before
  assert.equal(extractMarkdown('```markdown\n正文\n```'), '正文');
  assert.equal(extractMarkdown('## 主线'), '## 主线');
});

// ---------------------------------------------------------------------------
// Drift between the prompt and SKILL.md
// ---------------------------------------------------------------------------

describe('the prompt and SKILL.md must not drift apart quietly', () => {
  const skillPath = new URL('../.claude/skills/achievement-guide-writing/SKILL.md', import.meta.url);

  /**
   * Every entry in SKILL.md that needs a position taken on it.
   *
   * **The identifier lives in the heading as `[id]`, and never in its prose.** That is what lets the
   * document be reworded — or translated — without moving a disposition key or any of the ~30
   * citations of one in `CLAUDE.md`, `docs/ai-guide-writing.md`, `lib/ai-anthropic.js`,
   * `lib/config.js`, `lib/guidelint.js`, `lib/notionblocks.js` and three tests. A heading's wording
   * is prose; its id is an interface.
   *
   * **Every `##` and `###` needs one**, subsections included — an unnumbered subsection with no id
   * is invisible here, and the disposition table then stays silent about a section that may well
   * have gone into the prompt while the parent rule's entry says it did not.
   *
   * Adding a heading turns this test red, which is the intent: a new section is exactly the moment
   * to say whether it went into the prompt.
   */
  function skillRuleKeys() {
    const text = readFileSync(skillPath, 'utf8');
    const keys = new Set();
    for (const line of text.split('\n')) {
      const m = line.match(/^#{2,3}\s+\[([^\]]+)\]/);
      if (m) keys.add(m[1]);
    }
    return keys;
  }

  test('every rule in SKILL.md has to be accounted for in the disposition table', () => {
    // RULES is a hand-copied summary of SKILL.md (about a quarter of its size); the full text
    // cannot be sent — whole sections are about writing to Notion, about screenshots, about
    // delegating to sub-agents, and 8.0 states outright 「默认建在 Notion」, so sending it would
    // actively mislead the model.
    // But hand-copying drifts, and this project has already been bitten once by documentation and
    // code saying different things.
    // This test turns that drift into a failure: change SKILL.md and a position has to be taken.
    const missing = [...skillRuleKeys()].filter((k) => !(k in SKILL_RULE_DISPOSITION));
    assert.deepEqual(
      missing,
      [],
      `these entries in SKILL.md are not accounted for in SKILL_RULE_DISPOSITION in lib/guidegen.js: ${missing.join('、')}\n` +
        'either add it to the RULES prompt, or state in the disposition table why it is not added.'
    );
  });

  /**
   * **The disposition table matches headings, not content.** rule-1 is marked as included, while its
   * three conditions exist as separate hand-copied versions — in SKILL.md and in the prompt, and the
   * prompt now in two languages. Change one and forget the others and the disposition table stays
   * completely silent, leaving differently worded copies of one rule: documentation and code saying
   * different things, which this project has been bitten by before.
   *
   * So each row below pins one rule to **one wording per copy**, and the row exists because that
   * rule has already been got wrong once. `skill` and `en` share a language and therefore share
   * their sentences outright; `zh` is the same rule in Chinese, and its phrases are what the
   * measured Chinese prompt actually says.
   *
   * A row is not a style rule. Every one of them is load-bearing:
   */
  const SHARED_RULES = [
    {
      // The one real case changed condition 2, so all three conditions are pinned to one wording.
      // The old criterion — "no nesting when the game counts for you" — kept the entire
      // collect-everything class out, which is the class nesting exists for
      what: 'the three nesting conditions',
      skill: [/A number is not an identity/, /beyond "which one it is"/, /alternatives/],
      en: [/A number is not an identity/, /beyond "which one it is"/, /alternatives/],
      zh: [/序号不是身份/, /写得出做法/, /互相替代/],
      absent: { zh: /游戏自己不替你数/ },
    },
    {
      // One real case: 613 characters in **one paragraph**. The content was right, and the model
      // itself wrote 「前置准备:…」 and 「流程:1)…6)」, all crammed into the same `<br>` segment —
      // not one bit of the structure reached the page. The rules had never said the notes segment
      // has to be broken up: hard rule 1 fixes only the three parts and says nothing about what the
      // notes look like inside, so "write in detail" was carried out as "write long"
      what: 'the line-breaking rule for the notes segment',
      skill: [/prerequisites, steps and warnings on separate lines/, /one step per line/, /not how long it is/],
      en: [/prerequisites, steps and warnings on separate lines/, /one step per line/, /not how long it is/],
      zh: [/前置、步骤、警告分行写/, /一步一行/, /不是字数/],
    },
    {
      // The same achievement exposed a second thing: the nesting section gives collectible examples
      // from beginning to end (shrines, recipes, side quests, entries), so it reads as "how to write
      // collectibles" — while 「创造」 is a six-stage process that satisfies all three conditions.
      // The lower bound matters as much: without it a two-step achievement gets split into sub-boxes
      what: 'a chain of steps is a nesting candidate too',
      skill: [/write the process itself as sub-checkboxes/, /Three steps or fewer/, /specific action/],
      en: [/write the process itself as sub-checkboxes/, /Three steps or fewer/, /specific action/],
      zh: [/把流程本身写成子 checkbox/, /三步以内的写在心得里就够/, /具体动作/],
    },
    {
      // One real rewrite produced 14 sub-boxes, every one starting with 「前置:」 or 「步骤:」 — the
      // same word fourteen times to say two things. The "why" is pinned along with the rule because
      // **it is a mechanical requirement rather than a style choice**, and a rule that only says
      // "write it this way" gets changed by the next person who finds it verbose
      what: 'how a group label is written',
      skill: [/label goes on its own line/, /do not repeat it in front of every entry/, /plain bullet/, /five or six go flat/],
      en: [/label goes on its own line/, /do not repeat it in front of every entry/, /plain bullet/, /five or six go flat/],
      zh: [/标签单独占一行/, /不要在每一条前面重复/, /不能写成普通 bullet/, /五六条以内直接平铺/],
    },
    {
      // Rule 5 once said only "a very long list" gets folded, with no number — while the group-label
      // side had a five-or-six lower bound and the folding side had none: two rulers in one guide.
      // Folding a three-line table only hides the information
      what: 'folding has a line-count lower bound',
      skill: [/10 lines/],
      en: [/10 lines/],
      zh: [/10 行/],
    },
    {
      // **The starting point of a whole round of rework, and the spec once said nothing about it.**
      // Four 「将吉祥物替换为 X」 achievements were split between two sections — each defensible on
      // its own, and a bug taken together. The program half (`lib/guidecluster.js`) runs only when
      // the guide **was sharded**, while more than half the library has fewer achievements than
      // `ai.chunkSize` and is written in one pass, with no fallback but this rule
      what: 'one kind of thing lives in one section',
      skill: [/Things of the same kind belong in the same section/, /not by how they unlock/],
      en: [/Things of the same kind belong in the same section/, /not by how they unlock/],
      zh: [/同一类事必须在同一个小节里/, /不看.{0,4}解锁途径|不看是怎么解锁的/],
    },
    {
      // A line count answers "fold or not", never "fold what". Without this a whole section of
      // achievements gets packed into one fold (measured: the 13 entries under one game's
      // `## 世界全清`), and that section opens empty on Notion. `unwrapAchievementToggles` takes it
      // apart, but **that is no reason to drop the rule** — a program fallback is the last line, not
      // the first. Saying only "do not fold an achievement" leaves it unclear whether the supporting
      // material counts as one, so what a fold *does* hold is pinned alongside
      what: 'an achievement itself never goes into a fold',
      skill: [/never goes inside a fold/, /supporting material/],
      en: [/never goes inside a fold/, /supporting material/],
      zh: [/成就本身那一行永远不进折叠|成就那一行永远不进折叠/, /折叠装的是.{0,12}辅料/],
    },
    {
      // Location achievements in a hidden-object game: prose cannot explain where 30 mushrooms are,
      // and the screenshot route is explicitly excluded (rule-2's disposition — the model cannot
      // produce reliable in-game screenshots). Measured by rewriting those entries: the substitute
      // the model found by itself was a video link with a timestamp. The catch-all phrasing is
      // blocked **by name**, because saying only "write concretely" does not stop it
      what: 'the fallback for a location achievement',
      skill: [/timestamp/, /check the corners/],
      en: [/timestamp/, /check the corners/],
      zh: [/时间点/, /留意角落/],
    },
  ];

  for (const rule of SHARED_RULES) {
    test(`${rule.what} — one wording per copy, and the copies stay in step`, () => {
      const skill = readFileSync(skillPath, 'utf8');
      const defs = [def('A', '第一步', '完成第一关。')];
      const copies = [
        ['SKILL.md', skill, rule.skill],
        ['the English prompt', buildSystemPrompt('测试游戏', '1', defs, { lang: 'en' }), rule.en],
        ['the Chinese prompt', buildSystemPrompt('测试游戏', '1', defs), rule.zh],
      ];
      for (const [name, text, patterns] of copies) {
        for (const p of patterns) {
          assert.match(text, p, `${name} no longer carries ${p} — ${rule.what}`);
        }
      }
      for (const [lang, pattern] of Object.entries(rule.absent ?? {})) {
        const text = copies.find(([n]) => n.endsWith(lang === 'zh' ? 'Chinese prompt' : 'English prompt'))[1];
        assert.doesNotMatch(text, pattern, `the ${lang} copy still carries superseded wording`);
      }
    });
  }

  test('every shared rule really is checked against all three copies', () => {
    // Without this, a row with an empty pattern list passes vacuously and the rule it names is
    // guarded by nothing — the failure mode of every table-driven test
    for (const rule of SHARED_RULES) {
      for (const key of ['skill', 'en', 'zh']) {
        assert.ok(Array.isArray(rule[key]) && rule[key].length > 0, `${rule.what} has no ${key} patterns`);
      }
      assert.equal(rule.skill.length, rule.en.length, `${rule.what}: the two English copies are checked unevenly`);
      assert.equal(rule.zh.length, rule.en.length, `${rule.what}: the Chinese copy is checked unevenly`);
    }
  });

  test('the two English copies are pinned to the same sentences, not merely to similar ones', () => {
    // SKILL.md and the English prompt share a language, so there is no reason for them to word one
    // rule two ways — and every row above is a rule already got wrong once by exactly that drift.
    // The Chinese prompt is the one copy that cannot share a string, which is what the section
    // table and the hard-rule parity tests cover instead
    for (const rule of SHARED_RULES) {
      assert.deepEqual(rule.skill.map(String), rule.en.map(String), rule.what);
    }
  });

  /**
   * Where the copies are **supposed** to differ, and why each difference has to be pinned too.
   *
   * The table above pins what the copies share. These are the two places they deliberately part
   * company — and an unpinned deliberate difference is read by the next person as a contradiction
   * and deleted, or worse, harmonised in the wrong direction.
   */
  test('SKILL.md keeps the Notion-side exception the prompt cannot carry', () => {
    const skill = readFileSync(skillPath, 'utf8');
    // The prompt does not know which backend a guide will land on when `target` does not reach it,
    // so it can only give the checkbox-label form that is safe on both. SKILL.md is for editing a
    // page on a *known* backend by hand, and on Notion `fetchAllToDoBlocks` treats a toggle as a
    // transparent container, so a folded label does not break attribution
    assert.match(skill, /transparent containers/,
      'SKILL.md lost the Notion-side exception — a folded label is safe there, and that is the reason');
    assert.match(skill, /it falls back to the checkbox-label form/,
      'SKILL.md lost the fallback direction — the cost of guessing wrong is asymmetric, so the default has to be the checkbox label');
  });

  test('each copy keeps its own strongest sentence on the location fallback', () => {
    // 「时间点」 / "timestamp" appears several times on every side, so the shared row above survives
    // the deletion of any one occurrence. These pin the sentence that carries the rule
    const skill = readFileSync(skillPath, 'utf8');
    const defs = [def('A', '第一步', '完成第一关。')];
    const zh = buildSystemPrompt('测试游戏', '1', defs);
    const en = buildSystemPrompt('测试游戏', '1', defs, { lang: 'en' });
    assert.match(zh, /写不出具体位置时/, 'the Chinese prompt lost the rule itself');
    assert.match(zh, /时间点是关键/, 'the Chinese prompt lost "a bare video id makes people scrub from the start"');
    assert.match(en, /The timestamp is the point/, 'the English prompt lost the same sentence');
    assert.match(skill, /When a screenshot is not possible/, 'SKILL.md lost this section');
  });

  // The group label is the one rule in the prompt that branches by backend. On Notion,
  // `fetchAllToDoBlocks` treats a toggle as a transparent container (`parent` is passed straight
  // through), so a collapsible label does not break attribution; `todoSpans` for local md cuts the
  // range at any non-checkbox line. One version for both sides is bound to break one of them.
  test('the group label branches by backend, and the fallback has to be the one safe on both', () => {
    const defs = [def('A', '第一步', '完成第一关。')];
    const notion = buildSystemPrompt('测试游戏', '1', defs, { target: 'notion' });
    const local = buildSystemPrompt('测试游戏', '1', defs, { target: 'local' });
    const fallback = buildSystemPrompt('测试游戏', '1', defs);

    assert.match(notion, /<summary>\*\*前置\*\*/, 'the Notion version does not give the collapsible label form');
    assert.doesNotMatch(notion, /标签行必须也是/,
      'the Notion version should not still require a checkbox label line — that is exactly the ailment being treated');
    assert.match(notion, /也不要用 checkbox/,
      'the Notion version is missing "the caution group degrades to ordinary bullets" — a warning cannot be ticked off, and --cascade would tick it into a false record');

    assert.match(local, /标签行必须也是/, 'the local version has to keep the hard checkbox-label requirement');
    assert.doesNotMatch(local, /<summary>\*\*前置\*\*/,
      'the local version must not recommend a collapsible as a label — todoSpans cuts the range on the spot');

    // **The fallback direction has a cost asymmetry; it is not an arbitrary pick.** A collapsible
    // written into local md silently breaks the range (quiet duplicates), while a checkbox label
    // written into Notion is merely uglier. So a missing target has to fall back to the local version.
    assert.equal(fallback, local,
      'with no target it has to equal the local version — guessing the Notion version makes local md silently grow duplicate entries');

    // The two sides diverge only in the label passage; no other rule may branch with it
    for (const [name, text] of [['notion', notion], ['local', local]]) {
      assert.match(text, /标签单独占一行/, `the ${name} version lost the overall group-label rule`);
      assert.match(text, /五六条以内直接平铺/, `the ${name} version lost the lower bound for grouping`);
    }
  });

  test('the disposition table must not carry entries SKILL.md has already deleted', () => {
    const keys = skillRuleKeys();
    const stale = Object.keys(SKILL_RULE_DISPOSITION).filter((k) => !keys.has(k));
    assert.deepEqual(stale, [], `these entries in the disposition table are no longer in SKILL.md: ${stale.join('、')}`);
  });

  test('the few rules that really constrain the output really are in the prompt', () => {
    const defs = [def('A', '第一步', '完成第一关。')];
    const p = buildSystemPrompt('测试游戏', '1', defs);
    // Each corresponds to a pit fallen into or narrowly avoided; none is filler
    assert.match(p, /易错过/, 'the permanently-missable marker');
    assert.match(p, /不要标/, 'a seasonal one **must not** be marked missable — a false alarm makes the marker useless');
    assert.match(p, /※除去追加内容/, 'the fixed wording of the DLC exclusion note');
    assert.match(p, /位置 XXX/, 'the fixed wording of a location note');
    assert.match(p, /待确认/, 'no documentation-style notes such as "guess / to be confirmed"');
    assert.match(p, /机制速查/, 'the mechanics reference before the achievement list');
  });

  // Actually generated on 2026-08-11: four "play for 7 days" achievements in one game each carried
  // `第1天`…`第7天` beneath them, 28 sub-boxes in total. The old prompt only blocked mutually
  // exclusive options (the "any one ending" kind), and this batch — where **every one has to be
  // done** — passed legitimately through that gate. The real problem is that they carry no
  // information at all, and one of the parent achievements was already unlocked, so cascade would
  // tick 7 empty boxes into 7 false records.
  test('the prompt has to block meaningless sub-checkboxes, not only mutually exclusive options', () => {
    const p = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    assert.match(p, /子 checkbox 默认不写/, 'no nesting by default — nesting needs a reason, not the other way round');
    assert.match(p, /序号不是身份/, '`第1天`/`第2天` numbering does not constitute a sub-step');
    // **Do not match against the whole prompt.** Condition 1 also contains `第1天`, so asserting
    // 「第1天」 over the whole text is permanently green — delete condition 2's example entirely and
    // it still passes. Slice to condition 2 itself
    const c2 = p.slice(p.indexOf('2. **这一行'), p.indexOf('3. **每一条都要做'));
    assert.ok(c2.length > 20, 'slice to condition 2 — this check has lost its target rather than passed');
    assert.match(c2, /第7天/, 'condition 2 has to name a concrete example of what should not be nested');
    assert.match(p, /互相替代/, 'the old mutually-exclusive rule must not be lost in the rewrite');
  });

  // **The accident in the other direction, 2026-08-21: one achievement = collect every entry of an
  // in-game encyclopaedia**, with a different acquisition route per entry. The user named it for a
  // rewrite and asked for concrete steps, and what came back was still one paragraph saying
  // 「条目会随剧情推进和角色入队逐步录入」 — not one entry named, which is the same as not writing it.
  //
  // The cause is not the model but the rule: the old condition 2 was 「游戏自己不替你数」, and an
  // encyclopaedia of course has a counter, so this condition kept the entire collect-everything
  // class out. All three have to hold, and blocking one is enough.
  //
  // **And that criterion was not doing any work anyway**: its own three examples (play 7 days, kill
  // 100, save up 5000) are all stopped first by condition 1 「序号不是身份」 — the one thing it
  // uniquely did was block a legitimate collection list. It also directly contradicted the
  // self-check sentence in the same passage: 「把那几行删掉,攻略少了什么信息吗?」 — delete the
  // acquisition routes of thirty entries and what is missing is all of it.
  test('but it must not block collect-everything achievements in return', () => {
    const p = buildSystemPrompt('测试游戏', '1', [def('A', '第一步', '完成第一关。')]);
    assert.doesNotMatch(p, /游戏自己不替你数/,
      'this criterion cannot block what should be blocked (condition 1 already blocks the numbering kind); it only blocks collection lists');
    assert.match(p, /写得出做法/, 'the criterion has to become "does this line have anything besides a number"');
    const c2 = p.slice(p.indexOf('2. **这一行'), p.indexOf('3. **每一条都要做'));
    assert.ok(c2.length > 20, 'slice to condition 2 — this check has lost its target rather than passed');
    assert.match(c2, /百科全书/,
      'a rule with only counter-examples teaches the model "do not nest"; the side that should be nested needs an example too');
    assert.match(p, /长不是"不列"的理由/,
      '"it is too long" is the most common excuse for writing a collection as one paragraph, and it has to be blocked on the spot');
  });
});
// ---------------------------------------------------------------------------
// The difficulty signal
// ---------------------------------------------------------------------------

describe('the global unlock rate', () => {
  test('mark it, and say outright whether to write deeply or briefly — do not make the model convert it itself', () => {
    // Measured on one game: the hardest is 1.1% and the easiest 64.5%, a factor of 60; without
    // this signal, the generated notes differed in length by less than a factor of two — the model
    // cannot tell which is hard, so it spreads the effort evenly
    const defs = [def('A', '大城堡', 'x'), def('B', '道路畅通', 'y')];
    const list = buildAchievementList('部落幸存者', '1', defs, new Map([['A', 1.1], ['B', 64.5]]));
    assert.match(list, /1\.1%.*这类要写深/);
    assert.match(list, /64\.5%.*一两句带过/);
    assert.match(list, /力气按它分配/, 'a bare number is not enough; it has to say what to do with it');
  });

  test('with no unlock rates, it leaves no trace at all (the explanatory passage disappears too)', () => {
    const list = buildAchievementList('X', '1', [def('A', '甲', 'x')], null);
    assert.doesNotMatch(list, /解锁率|%/);
    assert.doesNotMatch(list, /力气按它分配/, 'explaining how to use data that is not there only confuses the model');
  });

  test('when Steam cannot give the unlock rates, generation carries on', async () => {
    // A nice-to-have signal should not stop someone from generating a guide when it is unavailable
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config, provider: fakeProvider([GOOD]), steam: fakeSteam(['A'], null), appid: '1',
    });
    assert.equal(r.ok, true);
  });
});

// ---------------------------------------------------------------------------
// The Dashboard generate button
// ---------------------------------------------------------------------------

describe('the 「生成」 button on the Dashboard', () => {
  const html = readFileSync(new URL('../Dashboard.html', import.meta.url), 'utf8');

  test('the button calls a named function directly rather than relying on event bubbling', () => {
    // Hit before: the button carries its own event.stopPropagation() (without it, clicking also
    // expands the achievement detail), while the handler was a delegate on document — and
    // stopPropagation kills it exactly.
    // It presents as "clicking does nothing", **with not one error in the console**, the hardest
    // kind to diagnose
    assert.match(html, /onclick="event\.stopPropagation\(\);window\.genGuide\(this\)"/);
    assert.match(html, /window\.genGuide = async function/);
    assert.doesNotMatch(
      html,
      /document\.addEventListener\('click'[\s\S]{0,120}data-gen/,
      'do not go back to event delegation — stopPropagation means it never arrives'
    );
  });

  // Hit on 2026-08-11 in the packaged build: the native confirm appeared and vanished at once,
  // too fast to click, so "generate a guide from the Dashboard" was an entirely broken path in the
  // packaged build — while the same page in a browser worked perfectly, so no amount of clicking
  // in a browser could reproduce it. A native dialog belongs to the Electron main process and the
  // page cannot take it back; an in-page dialog does not have this problem and behaves the same on
  // both sides
  test('the confirmation must not use native confirm/alert — in the packaged build they vanish on their own', () => {
    // Strip comments before checking. **Those names appearing in comments is correct** — those
    // passages are precisely about "why the native ones are not allowed", and using them to judge
    // "you are still using it" amounts to forbidding an explanation of the decision.
    // (The first run of this test was tripped by its own explanatory comment)
    const code = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*(\*|\/\/).*$/gm, '');

    assert.doesNotMatch(code, /window\.confirm\s*\(/, 'window.confirm cannot be clicked in Electron; use askConfirm()');
    assert.doesNotMatch(code, /(?<![.\w])alert\s*\(/, 'alert becomes askConfirm({notifyOnly:true})');
    assert.doesNotMatch(code, /(?<![.\w])confirm\s*\(/, 'a bare confirm( is not allowed either');
    assert.match(html, /function askConfirm\(o\)/, 'the shared confirmation dialog itself');
    assert.match(html, /id="askModal"/, 'the page really has to contain that dialog, not just the function');
  });

  // This is the **second** time money wording was taken out of the interface (the first was the
  // setup page, commit 4d66ce9). What a prompt should say is "what happens next", not an appraisal
  // on the user's behalf: the key is theirs, they know their own rates, and we have never even
  // measured how server-side search is billed (see CLAUDE.md, "no spend caps"). Frightening people
  // with a number we cannot explain is worse than saying nothing. Explaining "why this confirmation
  // exists" in a code comment is fine; the user never reads comments.
  test('user-facing copy does not mention money — it has been removed twice already', () => {
    const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\*|\/\/).*$/gm, '');
    const MONEY = /花钱|产生费用|要花多少|收费/;

    assert.doesNotMatch(strip(html), MONEY, 'the Dashboard confirmation dialogs and status bar do not mention money');

    const cli = strip(readFileSync(new URL('../tracker.js', import.meta.url), 'utf8'));
    assert.doesNotMatch(cli, MONEY, 'the CLI prompts and help do not mention money either (explaining the reason in a comment is fine)');
  });

  // Rewriting (overwriting an existing guide) used to be callable only from the command line — a
  // Dashboard row with a guide showed only 「📖 攻略」, with no button at all. One click in a GUI is
  // far easier than typing a command line, so the gate **must not be looser than the CLI's**: run
  // the preflight, lay out what will be lost, and only then ask.
  test('the Dashboard can rewrite an existing guide, with a gate as strict as the CLI', () => {
    // **The entry point is on the row, not in the ⋯ menu.** It was moved into the menu on
    // 2026-08-20 and moved back — the reasoning is in the `.row-actions` passage in
    // Dashboard.html: a rewrite is a deliberate action, and a second level means one extra click
    // every time. What is pinned here is that **the entry exists and greys out while it runs**,
    // not what it looks like (the previous version pinned the `data-rewrite` attribute, which is gone)
    assert.match(html, /class="guide-btn rewrite"/, 'a row with a guide has to have a rewrite entry');
    assert.match(html, /window\.rewriteGuide\(/);
    assert.match(html, /window\.rewriteGuide = async function/);
    // The greyed-out state is **rendered**, not set back by hand after render — hanging it on the
    // button lets the next background sync repaint wash it off, and a rewrite runs for two or
    // three minutes, so a collision is certain.
    // Slice to a real anchor before matching rather than hardcoding the string: the previous
    // version wrote the space count into the regex, and one changed space turned it red
    const rowActions = html.slice(
      html.indexOf('<div class="row-actions">'),
      html.indexOf('class="delete-btn"')
    );
    assert.ok(rowActions.length > 0 && rowActions.length < 4000, 'what was sliced should be the row-actions passage');
    assert.match(rowActions, /guideBusy\.has\(String\(g\.appid\)\)/,
      'the rewrite button greying has to be rendered from guideBusy rather than hung on the DOM');
    // Preflight first, then ask — the other order makes it "a confirmation that does not know what
    // will be lost".
    // Slice by the **function definition**, not the first occurrence of the name — the name first
    // appears at a call site, and slicing there gives a fragment between two calls that matches
    // nothing
    const fn = html.slice(
      html.indexOf('window.rewriteGuide = async function'),
      html.indexOf('window.migrateGuide = function')
    );
    assert.ok(
      fn.indexOf('previewGuideRewrite') < fn.indexOf('askConfirm'),
      'the preflight result has to be in hand before the confirmation dialog opens'
    );
    assert.match(fn, /danger: true/, 'an overwrite is irreversible, so the confirm button is red');
    assert.match(fn, /startGuideGen\(appid, true[,)]/, 'without passing overwrite down, the server refuses as usual');
  });

  test('generate and rewrite never appear on the same row — one is for rows with no guide, the other for rows with one', () => {
    assert.match(html, /const canGen = !g\.guideUrl/, 'generate is only for rows with no guide');
    assert.match(html, /g\.guideUrl && aiReady/, 'rewrite is only for rows with one');
  });

  // The user has said three times over that the interface text is too long and explains too much.
  // A confirmation dialog should answer only "what will happen and how long it takes"; mechanics
  // and guarantees are documentation, and moving them into code comments means the user reads not
  // one word of them. This test exists to stop it growing back — every time someone wants to add
  // "let me explain while we are here", it fails first
  test('a confirmation dialog is short — no bulleted lists, no explanations', () => {
    // The bodies moved into the page's string table, so they are read from there — the rule is
    // about the shape of a confirmation, not about where the sentence is stored
    const table = html.slice(html.indexOf('const STRINGS = {'));
    const keys = [...html.matchAll(/askConfirm\(\{[\s\S]{0,160}?body:\s*t\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(keys.length >= 1, 'at least one table-backed body should be caught (the delete dialog)');
    const bodies = keys.flatMap((k) => {
      // Sliced by hand rather than built into a RegExp: the key contains a dot, and every attempt
      // to escape one through a generated pattern in this repo has produced a broken expression
      const at = table.indexOf("'" + k + "':");
      assert.ok(at > 0, `cannot find the '${k}' entry in STRINGS`);
      const entry = table.slice(at, table.indexOf('],', at));
      // both languages: a confirmation that grew a bulleted list in translation is just as bad
      return [...entry.matchAll(/'([^']*)'/g)].map((x) => x[1]).slice(1);
    });
    for (const b of bodies) {
      const lines = b.split('\\n').filter((l) => l.trim());
      assert.ok(lines.length <= 3, `a confirmation is at most three lines, this one has ${lines.length}: ${b.slice(0, 60)}`);
      assert.ok(!b.includes('· '), `do not lay out a bulleted list in a confirmation: ${b.slice(0, 60)}`);
    }
  });

  test('the generate dialog is one question with no body — generating is reversible, so there is nothing to state first', () => {
    const call = html.slice(html.indexOf("askConfirm({ title: t('gen.title'"), html.indexOf("okText: t('gen.ok')") + 20);
    assert.ok(call.includes("title: t('gen.title'"), 'the generate dialog is still there');
    assert.ok(!/\bbody:/.test(call), 'the generate dialog should no longer have a body');
    // But "the content is unverified" must not disappear entirely; it moved to the result line
    assert.match(html, /内容需要你自己过一遍/, 'once a guide is written it still has to say honestly that the content is unverified');
  });

  // **The second time** (the first was the setup page, commit 4d66ce9, whose title says
  // 「去掉对供应商的评价」). That time only the setup page was changed with no search elsewhere, so
  // README, docs and the CLI selector all kept theirs.
  // Rates change at any time and we have no comparable measurement of quality — writing it down is
  // conjecture, and the user takes it as fact when choosing.
  // Write only what is verifiable: whether there is web search, and where to get a key.
  test('no user-facing surface carries an appraisal of a vendor', () => {
    // Markdown and source have to be stripped differently. `^\s*\*` is a block-comment
    // continuation in .js/.html and **bold** or a list item in .md — applying the same rule to
    // markdown eats whole lines of prose, and the assertion never sees them again. Measured once:
    // across README, guides, configuration and cli, 44 lines were completely invisible to this
    // assertion. So .md has only HTML comments stripped
    const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
    const strip = (s, rel) => (rel.endsWith('.md')
      ? stripHtml(s)
      : stripHtml(s).replace(/^\s*(\*|\/\/).*$/gm, ''));
    // Self-check: after stripping .md, a bold line has to still be there. Without this line,
    // changing strip back to the unified version is also all green — this assertion would silently
    // become empty, and an empty assertion is worse than none
    assert.match(strip('**x** 最便宜', '../x.md'), /最便宜/,
      'the bold line in markdown was stripped, so the whole loop below ran on nothing');
    const JUDGEMENT = /cheapest|priciest|most expensive|best quality|最便宜|最贵|质量最好|有免费额度/i;
    const surfaces = ['../README.md', '../docs/guides.md', '../docs/configuration.md',
      '../docs/cli.md',
      '../tracker.js', '../lib/config.js', '../lib/ai.js', '../Setup.html', '../Dashboard.html'];
    for (const rel of surfaces) {
      const text = strip(readFileSync(new URL(rel, import.meta.url), 'utf8'), rel);
      const hit = text.match(JUDGEMENT);
      assert.equal(hit, null, `${rel} still carries an appraisal of a vendor: 「${hit && hit[0]}」`);
    }
  });

  test('every askConfirm call site is async/await — it returns a Promise, and forgetting await means confirming by default', () => {
    // askConfirm returns a Promise, and a Promise is always truthy. Miss the await and
    // `if (!askConfirm(...)) return` never returns — the dangerous action is let straight through,
    // silently
    for (const m of html.matchAll(/(?<!await\s)askConfirm\(\{/g)) {
      const before = html.slice(Math.max(0, m.index - 400), m.index);
      assert.ok(
        /await\s*$/.test(before) || /notifyOnly/.test(html.slice(m.index, m.index + 240)),
        `the return value of askConfirm is not awaited (at ${m.index}) — unless it is a notifyOnly notice`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Sharded writing (games with hundreds of achievements)
// ---------------------------------------------------------------------------
// Raising the ceiling from 100 to 500 was not a matter of "turn a number up" — one output cannot
// hold hundreds of entries of prose, and **not holding it raises no error**: the model stops
// halfway and the validator only says "every achievement in the second half is missing a
// checkbox". So beyond one shard it is written in several rounds, in the same session (the model
// can see what it wrote before), and assembled at the end for ticking and validation over **one
// complete guide**.

describe('sharded writing', () => {
  const BIG = ['A', 'B', 'C', 'D', 'E'].map((k, i) => def(k, `成就${i + 1}`, `完成第${i + 1}关。`));
  const bigSteam = () => ({
    async fetchPlayerAchievements() {
      return { achievements: BIG.map((d) => ({ apiname: d.api_name, achieved: 0 })) };
    },
    async fetchGlobalAchievementPercentages() { return null; },
  });
  /** The markdown one shard should carry */
  const seg = (items) =>
    '```markdown\n## 主线\n\n' +
    items.map((d) => `- [ ] **${d.name_cn}**<br>${d.description}<br>心得`).join('\n') +
    '\n```';

  const envFor = (chunkSize) => {
    const e = freshEnv({ defs: BIG });
    e.config.ai = { maxAchievements: 500, chunkSize };
    return e;
  };

  test('chunkDefs splits correctly, with the remainder as its own shard', () => {
    assert.deepEqual(chunkDefs([1, 2, 3, 4, 5], 2).map((c) => c.length), [2, 2, 1]);
    assert.deepEqual(chunkDefs([1, 2, 3], 10).map((c) => c.length), [3], 'if it fits there is only one shard');
    assert.equal(chunkDefs([1, 2, 3], 0).length, 3, 'a size of 0 must not loop forever');
    assert.deepEqual(chunkDefs([], 50), [], 'no achievements means no shards');
  });

  test('chunkDefs spreads the achievements evenly rather than leaving the last shard a remnant', () => {
    const n = (len) => Array.from({ length: len }, (_, i) => i);
    // This case was written from a real event: one game has 55 achievements with chunkSize=50.
    // A naive slice gives 50 + 5 — the same shard count, while making the first shard press right
    // up against the ceiling and hit max_tokens
    assert.deepEqual(chunkDefs(n(55), 50).map((c) => c.length), [28, 27]);
    assert.deepEqual(chunkDefs(n(101), 50).map((c) => c.length), [34, 34, 33]);
    // When it divides evenly it is exactly as before — spreading should not disturb what is
    // already even
    assert.deepEqual(chunkDefs(n(100), 50).map((c) => c.length), [50, 50]);
    assert.deepEqual(chunkDefs(n(50), 50).map((c) => c.length), [50]);
  });

  test('after chunkDefs spreads: the shard count does not grow, none exceeds the ceiling, and no achievement is lost or duplicated', () => {
    for (let len = 1; len <= 120; len++) {
      for (const size of [1, 2, 7, 50]) {
        const defs = Array.from({ length: len }, (_, i) => i);
        const chunks = chunkDefs(defs, size);
        const flat = chunks.flat();
        // **The ceiling is hard.** Spreading should only make shards shorter; exceeding it
        // quietly raises the value the user configured
        assert.ok(chunks.every((c) => c.length <= size), `len=${len} size=${size} has a shard over the ceiling`);
        // The shard count must not exceed the naive split — one more shard is one more request
        // and one more search budget
        assert.ok(
          chunks.length <= Math.ceil(len / size),
          `len=${len} size=${size} produced more shards than the naive split`
        );
        // Order and completeness: the model writes by "achievements N–M", and one missing or one
        // duplicated becomes a missing-checkbox in the validator's words while the real cause is here
        assert.deepEqual(flat, defs, `len=${len} size=${size} lost an achievement or changed the order`);
      }
    }
  });

  test('with only one shard the message sent is character for character what it was — the behaviour for a small guide must not be touched by this change', () => {
    assert.equal(buildChunkMessage([BIG], 0), '开始写吧。先联网查资料,再按规则写完整份攻略。');
  });

  test('when sharded, tell the model which entries this shard is, and not to repeat earlier ones', () => {
    const chunks = chunkDefs(BIG, 2);
    const m = buildChunkMessage(chunks, 1);
    assert.match(m, /第 3–4 个成就/);
    assert.match(m, /成就3[\s\S]*成就4/);
    assert.match(m, /不要重复前面已经写过的小节和成就/);
    assert.match(m, /后面还有/, 'a middle shard should not wrap up');
    assert.match(buildChunkMessage(chunks, 2), /最后一段,写完就停/);
  });

  /**
   * With the shards written concurrently the model cannot see the others, so two adjacent shards
   * both belonging to 「主线」 each write a `## 主线` line. What the prompt says is "open the
   * heading as you need, the program merges duplicates", and this is where that promise is kept —
   * without it the guide carries an empty heading immediately followed by one of the same name,
   * with not one entry missing while it reads as though the categorisation broke.
   */
  describe('merging section headings duplicated across shards on assembly', () => {
    test('adjacent headings of the same name merge into one', () => {
      const out = joinBodies(['## 主线\n\n- [ ] **A**', '## 主线\n\n- [ ] **B**']);
      assert.equal(out.match(/## 主线/g).length, 1, 'both shards opened 「主线」, and only one heading should remain');
      assert.match(out, /\*\*A\*\*[\s\S]*\*\*B\*\*/, 'not one entry may be lost and the order may not change');
    });

    test('one that returns after another section in between is not merged — that is the game own categorisation', () => {
      const out = joinBodies(['## 主线\n- [ ] **A**', '## 支线\n- [ ] **B**', '## 主线\n- [ ] **C**']);
      assert.equal(out.match(/## 主线/g).length, 2,
        'only adjacent ones merge. Returning after another section is a legitimate structure, and merging pushes C into the side quests');
    });

    test('different levels do not merge — `## 收集` and `### 收集` are two different things', () => {
      const out = joinBodies(['## 收集\n- [ ] **A**', '### 收集\n- [ ] **B**']);
      assert.match(out, /## 收集/);
      assert.match(out, /### 收集/);
    });

    test('merging happens only at a shard start. A same-named heading in the middle of a shard is untouched', () => {
      const out = joinBodies(['## 主线\n- [ ] **A**', '- [ ] **B**\n\n## 主线\n- [ ] **C**']);
      assert.equal(out.match(/## 主线/g).length, 2,
        'the second shard starts with an entry, so the heading inside it opens a new section rather than being a duplicated start');
    });

    test('empty shards and failed shards (null) are skipped, leaving no blank line and no misalignment', () => {
      assert.equal(joinBodies(['## A\n- [ ] **x**', null, '', '## B\n- [ ] **y**']),
        '## A\n- [ ] **x**\n\n## B\n- [ ] **y**');
      assert.equal(joinBodies([null, null]), '', 'no shards at all is an empty string, not "null"');
    });
  });

  /**
   * Cross-shard categorisation. **This group pins a real incident**: one game's 91 achievements
   * were written in two shards, each shard defining its own sections, and the union came to 17
   * sections — the romance topic was split into six and `## 主线剧情` appeared verbatim twice.
   * Each shard was internally duplicate-free; only the union was a mess.
   */
  describe('cross-shard categorisation', () => {
    /** One shard of body text, laid out as [[section, achievements[]], ...]. `seg` hardcodes the heading as 主线, and this has to vary it */
    const body = (parts) =>
      '```markdown\n' +
      parts
        .map(([h, items]) =>
          `## ${h}\n\n` +
          items.map((d) => `- [ ] **${d.name_cn}**<br>${d.description}<br>心得`).join('\n'))
        .join('\n\n') +
      '\n```';

    test('end to end: two shards each open the same section once, and the finished guide has one', async () => {
      // The cases above verify the parts. **This one verifies those parts are really wired into
      // the generation flow** — whether classification was asked for, whether the mapping really
      // moved the entries, whether the duplicate at the seam was merged; miss any link and nothing
      // raises an error, the finished guide merely grows duplicate sections again.
      // **The shape is copied from that real game**: the duplicated 「主线」 lands at the **end** of
      // shard 2, while both sides of the seam are 「社交」. joinBodies can merge the pair at the
      // seam by itself, so using that as the end-to-end assertion verifies nothing — what only the
      // merge can cure is the one far from the seam
      const { db, config } = envFor(3); // 5 achievements split into 3 + 2
      const provider = fakeProvider(
        [
          body([['主线', BIG.slice(0, 2)], ['社交', [BIG[2]]]]),
          body([['社交', [BIG[3]]], ['主线', [BIG[4]]]]),
        ],
        { sections: ['主线', '社交'] }
      );
      const res = await generateGuide(db, { db, config, provider, steam: bigSteam(), appid: '1' });
      assert.equal(provider.regroupAsks, 1, 'sections are unified in one pass, not once per shard');
      assert.match(provider.regroupPrompt, /已经写完了/, 'what is asked really is the "classify after writing" pass');
      assert.match(provider.regroupPrompt, /现在在:/, 'the sections each shard chose have to go up with it — that is the information this pass has that the earlier one did not');
      assert.doesNotMatch(provider.asked[0], /一字不差地照抄/, 'when writing the body the headings should no longer be pinned; each shard opens its own');
      const text = readFileSync(res.path, 'utf8');
      assert.equal(text.match(/## 主线/g).length, 1, '「主线」 was opened once by each shard, and the finished guide should have one');
      assert.equal(text.match(/## 社交/g).length, 1);
      assert.ok(text.indexOf('## 主线') < text.indexOf('## 社交'), 'the order follows the classification result');
      assert.equal((text.match(/- \[ \]/g) ?? []).length, 5, 'not one of the 5 achievements may be lost');
    });

    test('both interfaces have to report "unifying the sections" and "could not unify"', () => {
      // **Both consumers are if/else-if chains, and an unrecognised phase lands silently.**
      // Not adding a branch has two symptoms, neither of them an error: the progress bar does not
      // move for the tens of seconds the sections take (which looks like a hang), and the
      // degradation happens quietly — the latter being exactly the kind of decay this project
      // guards against most, and it is visible in the finished guide (duplicated section
      // headings), where the user only thinks "the categorisation came out a mess this time".
      //
      // **Strip line comments before block comments** (see CLAUDE.md): the other way round, a `/*`
      // appearing in a comment swallows the code below it, so the assertion is fed and stays green
      // with the code deleted
      const strip = (src) =>
        src.replace(/(^|[^:])\/\/[^\n]*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
      const read = (f) => strip(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
      for (const f of ['tracker.js', 'lib/server.js']) {
        const src = read(f);
        assert.ok(src.includes("=== 'regroup'"), `${f} does not handle regroup — nothing moves on screen for those tens of seconds`);
        assert.ok(src.includes("'regroup-done'"), `${f} does not report that the sections were unified`);
        assert.ok(src.includes("'regroup-failed'"), `${f} does not report the degradation — a silent decay`);
      }
    });

    test('when the sections cannot be unified it degrades rather than interrupting generation', async () => {
      const { db, config } = envFor(3);
      const provider = fakeProvider([seg(BIG.slice(0, 3)), seg(BIG.slice(3))], { sections: null });
      const events = [];
      const res = await generateGuide(db, {
        db, config, provider, steam: bigSteam(), appid: '1',
        onProgress: (e) => events.push(e),
      });
      assert.ok(res.path, 'the body is something the user already waited minutes for; the whole thing must not be voided because the skeleton could not be settled');
      assert.equal((readFileSync(res.path, 'utf8').match(/- \[ \]/g) ?? []).length, 5);
      // **A degradation has to speak up.** A decay that happens quietly is exactly what this
      // project guards against most
      assert.ok(events.some((e) => e.phase === 'regroup-failed'),
        'a degradation has to report a regroup-failed');
      // Degrading = keep the headings each shard chose, rather than flattening the body into one section
      const degraded = readFileSync(res.path, 'utf8');
      assert.match(degraded, /^## /m, 'even degraded, the sections each shard opened have to stay');
      // **The seam merge is only observable on this path.** When the classification pass succeeds
      // it re-buckets by heading and merges duplicates along the way, so a missed seam merge leaves
      // no trace at all; once degraded there is no fallback, and the `## 主线` each shard opened
      // stays as two. Measured: replace the landing line with a bare concatenation and not one test
      // in the suite turns red — this assertion is what plugs that hole
      assert.equal((degraded.match(/^## 主线$/gm) ?? []).length, 1,
        'both shards start with 「主线」, and joinBodies has to merge the duplicate line at the seam');
    });
  });

  test('chunksNeedingRewrite locates a problem to a specific shard by apiName', () => {
    const chunks = chunkDefs(BIG, 2);
    const blocking = [{ code: 'missing-checkbox', apiName: 'E', message: 'x' }];
    assert.deepEqual(chunksNeedingRewrite(blocking, chunks), [2]);
    // What cannot be located (carrying no apiName) must not point at a shard at random — the caller
    // falls back to rewriting everything
    assert.deepEqual(chunksNeedingRewrite([{ code: 'merged-line', message: 'x' }], chunks), []);
  });

  // -------------------------------------------------------------------------
  // Truncated by max_tokens → shard smaller and ask again
  // -------------------------------------------------------------------------
  // What has to fit in one request is thinking plus prose, and thinking varies with the game, the
  // model and the endpoint — on a compatible endpoint the parameter that would cap it cannot even
  // be sent. So rather than predicting how big a shard should be, **wait until a truncation really
  // happens** and then split — a truncation is a measured fact, and it says directly that this
  // shard went over the line.
  describe('sharding smaller and asking again after a truncation', () => {
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

    /** Lets each call's stopReason be specified, and records **the full history seen each time** */
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
          if (!step) throw new Error('the scriptedProvider script ran out');
          // A transport failure (a 401, a dropped connection) is a different class from
          // "this shard is unusable" as judged by checkResult, and they come out of the same
          // await. See CHUNK_LOCAL
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

    test('a shard that cannot be finished is split in two, both halves are asked, and no achievement is lost', async () => {
      const { db, config } = manyEnv(N); // one whole shard, so it is bound to split
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

      assert.equal(r.ok, true, 'once sharded smaller it should finish cleanly');
      assert.equal(provider.asked.length, 3, 'the truncated call plus the two halves = three');
      const text = readFileSync(r.path, 'utf8');
      for (const d of MANY) {
        assert.ok(text.includes(`**${d.name_cn}**`), `${d.name_cn} was lost`);
      }
      const re = events.find((e) => e.phase === 'resplit');
      assert.ok(re, 'sharding smaller has to emit a progress event — the interface must not read as "stuck"');
      assert.deepEqual([re.from, re.to], [12, 6]);
    });

    test('the truncated round has to be removed from the history before asking again', async () => {
      const { db, config } = manyEnv(N);
      const provider = scriptedProvider([
        { text: HALF_WRITTEN, stop: 'max_tokens' },
        { text: seg(MANY.slice(0, 6)) },
        { text: seg(MANY.slice(6)) },
      ]);
      await generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' });

      // **This is the easiest thing in the whole business to get wrong.** The dead draft stays in
      // the context while the re-ask prompt says 「不要重复前面已经写过的成就」 — so the model skips
      // the ones it half wrote, and the output looks entirely normal while missing entries. A
      // failure is reported; missing content is not
      assert.ok(
        !provider.seen[1].includes('写到这里就被砍了'),
        'the second request history still carries the truncated dead draft'
      );
      assert.ok(
        !provider.seen[2].includes('写到这里就被砍了'),
        'the third request history still carries the truncated dead draft'
      );
      // What is removed is only the dead-draft round; a shard that was written properly has to
      // stay — the whole point of one session is that the model can see what it wrote before
      assert.ok(provider.seen[2].includes('成就1'), 'the work of the first half should not be removed along with it');
    });

    test('at the lower bound and still unable to finish, it stops and says plainly why not to raise maxTokens', async () => {
      // 5 == MIN_CHUNK, no further split possible
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
          assert.match(err.message, /这是用量不是上限/, 'that number is usage, and it has to be said');
          // **This sentence goes verbatim into the Dashboard floater.** Which knob to turn is
          // advice only a terminal can give and only there means anything (tracker.js adds it
          // after catching chunk-too-small)
          assert.equal(err.code, 'chunk-too-small');
          // `was` records the code from **before** the rewrite. Once it cannot be split further
          // the code always becomes chunk-too-small, so "was it truncated or did it output no
          // prose at all" is left to this one field — and the weight of the advice "try another
          // model" is completely different between those two
          assert.deepEqual(err.detail, { size: 5, min: 5, was: 'max_tokens' });
          assert.doesNotMatch(err.message, /ai\.maxTokens|anthropicExtras|config\.json/,
            'a Dashboard user has no terminal and should not be asked to edit a config file');
          return true;
        }
      );
      assert.equal(provider.asked.length, 1, 'once it cannot be split further it should not ask again');
    });

    test('only a truncation shards smaller and re-asks — a refusal or RECITATION hits the same wall when smaller', async () => {
      for (const stop of ['refusal', 'recitation']) {
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([{ text: '', stop }]);
        await assert.rejects(
          () => generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' }),
          (err) => {
            assert.equal(err.code, stop);
            assert.doesNotMatch(err.message, /已经切到/, 'this is not a length problem, so do not report it as one');
            return true;
          }
        );
        assert.equal(provider.asked.length, 1, `${stop} should not be retried`);
      }
    });

    // -----------------------------------------------------------------------
    // An empty reply: ask again unchanged first, and shard smaller if it is still empty
    // -----------------------------------------------------------------------
    // "Not one text block" is the only genuinely **transient** failure on this path: the request
    // is fine, the shard length is fine, the research was found, and this one call simply produced
    // no prose. It used to be retried not once, voiding the whole guide on the spot — measured
    // (one game, shards 3 and 4 of 197 achievements).
    describe('an empty reply', () => {
      test('asking again unchanged is enough — the whole guide should not be voided over it', async () => {
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '' },              // an empty reply
          { text: seg(MANY) },       // asking again produces it
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: manySteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        assert.equal(r.ok, true, 'one re-ask should finish it normally');
        assert.equal(provider.asked.length, 2);
        assert.deepEqual(r.chunkFailures, [], 'once filled in, no failure record should still be hanging');
        const ev = events.find((e) => e.phase === 'retry');
        assert.ok(ev, 'a re-ask has to emit a progress event — the interface must not read as "stuck for three minutes"');
        assert.deepEqual([ev.attempt, ev.of], [1, 1]);
      });

      test('the empty assistant turn has to be removed from the history before asking again', async () => {
        // Without removing it, the history holds a round of "asked for this shard / answered
        // nothing" while the re-ask is **the same sentence** — the model may well take it as "you
        // already asked" and answer empty again. The same reasoning as removing the truncated
        // round, only the dead draft has a different shape (half a guide there, empty here)
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([{ text: '' }, { text: seg(MANY) }]);
        await generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' });

        const second = JSON.parse(provider.seen[1]);
        assert.equal(second.length, 1, 'on the re-ask the history should hold only the newly asked user turn');
        assert.equal(second[0].role, 'user');
      });

      test('a leaked control token takes the same ladder: ask again unchanged, and once filled in treat it as though nothing happened', async () => {
        // The vendor writes an internal marker into the prose and the output breaks off there (see
        // leakedControlToken in lib/ai.js). The same class as an empty reply: this one sampling
        // went off the rails, not this shard — asking again will very likely be normal.
        // The production occurrence had no such interception, so all three rounds accepted the
        // broken-off prose as a success, ending 10 achievements short with those three garbage
        // lines in the draft
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

        assert.equal(r.ok, true, 'one re-ask should fix it');
        assert.equal(provider.asked.length, 2);
        const ev = events.find((e) => e.phase === 'retry');
        assert.ok(ev, 'the re-ask progress event has to be emitted');
        assert.equal(ev.reason, 'control-token');
        // The broken-off half must never stay in the finished product
        assert.doesNotMatch(readFileSync(r.path, 'utf8'), /DSML/, 'garbage must not get into the guide file');
      });

      test('persistent leaking does not drag the whole guide down — record it and carry on with the rest', async () => {
        // control-token has to be in CHUNK_LOCAL: it is this shard's own problem (HTTP 200), not a
        // broken vendor, so passing over this shard and carrying on with the rest is right.
        // 5 per shard == MIN_CHUNK, so no further split — this case examines only "record it and
        // carry on" without mixing in the splitting behaviour
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
          { text: seg(LOTS.slice(0, 5)) },  // shard 1 is normal
          junk, junk,                        // shard 2: leaks, leaks again on the re-ask → cannot split, recorded and passed over
          { text: seg(LOTS.slice(5)) },      // the second round fills it in
        ]);
        const r = await generateGuide(e.db, { config: e.config, provider, steam, appid: '1' })
          .catch((err) => ({ threw: err }));
        assert.ok(!r.threw, 'the whole thing should not be thrown: ' + (r.threw && r.threw.message));
        assert.equal(r.ok, true, 'filled in on the second round, it should land');
        assert.doesNotMatch(readFileSync(r.path, 'utf8'), /DSML/);
      });

      test('still empty on the re-ask ⇒ treat it as a length problem and split in two', async () => {
        // Empty a second time is no longer a glitch. On a compatible endpoint the parameter that
        // would cap thinking cannot be sent, and it cannot be assumed to report "the allowance was
        // eaten by thinking" honestly as max_tokens — so "empty reply" carries a share of cases
        // that are truncations in substance, and sharding smaller is the cure for that share
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '' },                    // empty
          { text: '' },                    // still empty on the re-ask → split
          { text: seg(MANY.slice(0, 6)) },
          { text: seg(MANY.slice(6)) },
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: manySteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        assert.equal(r.ok, true);
        assert.equal(provider.asked.length, 4, 'empty + re-ask + two halves = four');
        const re = events.find((e) => e.phase === 'resplit');
        assert.ok(re, 'sharding smaller has to emit a progress event');
        assert.deepEqual([re.from, re.to], [12, 6]);
        assert.equal(re.reason, 'empty', 'it has to say the split was caused by an empty reply, not by a truncation');
      });

      test('each half after a split gets its own re-ask — the retry count follows the shard', async () => {
        // Sharding smaller swaps in **a smaller piece of content**, and the two earlier empty
        // replies are the previous shard's history and should not be charged to it. Without
        // resetting the count, the first half only has to glitch once to be killed outright, while
        // it has not been tried even once
        const { db, config } = manyEnv(N);
        const provider = scriptedProvider([
          { text: '' }, { text: '' },       // whole shard: empty + still empty on the re-ask → split
          { text: '' },                     // first half: empty
          { text: seg(MANY.slice(0, 6)) },  // first half: the re-ask produces it
          { text: seg(MANY.slice(6)) },
        ]);
        const r = await generateGuide(db, { db, config, provider, steam: manySteam(), appid: '1' });
        assert.equal(r.ok, true, 'a half after the split should get its own re-ask too');
        assert.equal(provider.asked.length, 5);
      });
    });

    // -----------------------------------------------------------------------
    // One shard fails without voiding the whole guide
    // -----------------------------------------------------------------------
    describe('one shard that cannot be written does not drag the whole guide down', () => {
      /** 24 achievements in 4 shards of 6 — the same shape as the production case (197 in 4 shards) */
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

      test('shard 3 is voided and shard 4 is still written, with the earlier shards work kept', async () => {
        const { db, config } = lotsEnv();
        // Shard 3 refuses (not retryable, not splittable); the shards before and after are normal
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: '', stop: 'refusal' },
          { text: seg(quarter(3)) },
          // The second round fills in shard 3
          { text: seg(quarter(2)) },
        ]);
        const events = [];
        const r = await generateGuide(db, {
          db, config, provider, steam: lotsSteam(), appid: '1',
          onProgress: (e) => events.push(e),
        });

        // **This is the core of the change.** Previously a failed shard 3 was thrown straight out,
        // voiding the first two shards' minutes of web research along with shard 4 — while the
        // missing shard has a ready-made remedy: all its achievements are reported as
        // missing-checkbox, chunksNeedingRewrite picks out exactly that shard, and the next round
        // re-asks only it. That machinery was already there
        assert.equal(r.ok, true, 'filled in on the second round, it should land cleanly');
        assert.equal(provider.asked.length, 5, 'round one is 4 calls (including the failed one) plus 1 to fill in on round two');
        const text = readFileSync(r.path, 'utf8');
        for (const d of LOTS) {
          assert.ok(text.includes(`**${d.name_cn}**`), `${d.name_cn} was lost`);
        }
        const ev = events.find((e) => e.phase === 'chunk-failed');
        assert.ok(ev, 'giving up a shard has to emit a progress event — quietly missing a piece is the worst way to fail');
        assert.deepEqual([ev.chunk, ev.count], [3, 6]);
      });

      test('filling in shard 3 asks for "write this shard", not six "missing checkbox" findings', async () => {
        const { db, config } = lotsEnv();
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: '', stop: 'refusal' },
          { text: seg(quarter(3)) },
          { text: seg(quarter(2)) },
        ]);
        await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });

        // A shard that was never written is missing not corrections but the shard itself. Asking
        // with the send-back list hands the model six "XX has no checkbox" findings about content
        // it has never seen
        const refill = provider.asked[4];
        assert.match(refill, /只写第 13–18 个成就/, 'it has to use the original "write this shard" wording');
        assert.doesNotMatch(refill, /校验没过/, 'this shard was never written, so there is no failed validation to speak of');
      });

      test('a broken vendor is thrown through verbatim rather than recorded as "this shard did not work"', async () => {
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
            // **The code has to pass through verbatim.** It is the key tracker.js's top-level catch
            // uses to attach terminal advice (the bad-api-key one has to say 「环境变量会盖掉
            // config.json」, and clearing an env var can only be done in a terminal). Recorded as a
            // shard failure, that advice never reaches there
            assert.equal(err.code, 'bad-api-key');
            return true;
          }
        );
      });

      /**
       * **"Concurrent" must not be merely a claim.** The shard count is unchanged, the request
       * count is unchanged and the guide is identical, so swapping runPool back for a for loop
       * would originally have turned not one test red — the only difference is wall-clock time,
       * and that is the **entire** purpose of the change. So this case measures the overlap
       * directly: hold each shard's request open and count how many are in flight at once.
       */
      test('the shards of round one really are in flight together rather than queued', async () => {
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
          // Hold for a tick before carrying on — queued, no second shard enters during that tick
          // and the peak stays at 1
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
          return inner(args);
        };
        await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });
        assert.equal(peak, 3, `the peak in flight was ${peak}, which means it is still queueing shard by shard`);
      });

      test('concurrency: 1 falls back to sequential — that escape route has to exist for diagnosis', async () => {
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

      test('running sequentially, not one request goes out after a total failure', async () => {
        // `concurrency: 1` is the original sequential behaviour, and this pins it as it was: hit
        // the wall and stop, with not one extra call
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
        assert.equal(provider.asked.length, 3, 'a total failure should not go on to ask shard 4 — that is the same wall');
      });

      test('running concurrently, no new work is dispatched after hitting the wall — the extra hits are capped by the concurrency, not by the shard count', async () => {
        // **Concurrently, "stop on the spot" is impossible: the requests are already out and cannot
        // be cancelled.** What is possible is dispatching no more, so at worst it hits the wall
        // concurrency-1 more times rather than once per remaining shard — which is its entire value.
        //
        // **The shape of this case was forced by mutation testing.** The first version used 8
        // shards with concurrency 2 and a script of only two entries, so every lane was stopped by
        // its own error ("the script ran out") and removing `stop` stayed green.
        // To make `stop` the only thing that can explain the result, **the lanes that do not error
        // need work to pick up**: 8 shards, concurrency 3, only shard 2 blowing up, and successful
        // replies prepared for the other six.
        //   with stop: dispatch 0/1/2, shard 1 blows up ⇒ 0 and 2 finish and it wraps up, 3 calls
        //   without stop: 0 finishes and takes 3, 2 finishes and takes 4 … all the way to 8 calls
        const e = freshEnv({ defs: LOTS });
        e.config.ai = { maxAchievements: 500, chunkSize: 3, concurrency: 3 }; // 24 / 3 = 8 shards
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
              '**what is thrown has to be the error of the lowest-numbered shard**. A 401 fails every request in flight, '
              + 'and which of them rejects first depends on network speed — taking "the first to blow up" makes two runs of the same input report different causes');
            return true;
          }
        );
        assert.ok(provider.asked.length <= 4,
          `it asked ${provider.asked.length} times (8 shards). Dispatching new work after hitting the wall `
          + 'means hitting the same wall once per remaining shard — which is exactly what throwing on the spot saves in the sequential version');
      });

      test('when two shards blow up together, the one reported is the lower-numbered one, not the first to blow up', async () => {
        // **This case was forced by mutation testing: with only one shard failing, sorting and not
        // sorting give the same result.**
        // The real scenario is a 401 — every request in flight fails, and which rejects first
        // depends only on network speed. Taking "the first to blow up" means two runs of the same
        // input can report different causes, and the first suspicion when diagnosing differs.
        // So the lower-numbered shard is deliberately made to blow up **later**: without sorting it
        // could never be selected.
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
              'shard 2 rejects first, but what has to be reported is shard 1 — otherwise two runs of the same input report different causes');
            return true;
          }
        );
      });

      test('when a rewrite fails, the shard already written in the previous round is kept', async () => {
        // The slot in a rewrite round holds the previous round's body. **Unable to change it is not
        // the same as should be discarded** — blanking it means one "this round did not improve it"
        // takes away the perfectly usable original as well, and what the user sees is that shard
        // vanishing into thin air rather than "this shard did not improve"
        const { db, config } = lotsEnv();
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: seg(quarter(2)) },
          // Shard 4 is one achievement short ⇒ validation fails ⇒ round two rewrites it specifically
          { text: seg(quarter(3).slice(0, 5)) },
          { text: '', stop: 'refusal' },   // round 2: the rewrite fails
          { text: '', stop: 'refusal' },   // round 3: it fails again
        ]);
        const r = await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });
        const draft = readFileSync(r.draftPath, 'utf8');
        assert.match(draft, new RegExp(quarter(3)[0].name_cn),
          'what shard 4 produced in round one has to still be there — a failed rewrite does not mean deleting it');
        assert.match(draft, new RegExp(quarter(0)[0].name_cn), 'the other shards should be even less affected');
      });

      test('when a total failure is thrown, the shards already written stay in the draft', async () => {
        // **This case is what really pins "write to disk after each shard".** The end-of-round
        // writeDraft is unreachable on this path (the exception goes straight out of
        // generateGuide), so whether the draft holds anything depends entirely on the per-shard
        // write. After the production failure .drafts/ was empty, precisely because the draft was
        // written only after the whole sharding loop finished
        const { db, config } = lotsEnv();
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { throws: Object.assign(new Error('网络断了'), { code: 'bad-api-key' }) },
        ]);
        const draft = join(config.guidesDir, DRAFTS_DIR, guideFileName('测试游戏', '1'));
        await assert.rejects(() => generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }));

        assert.ok(existsSync(draft), 'the first two shards work has to already be on disk — the user has paid for it');
        const text = readFileSync(draft, 'utf8');
        for (const d of [...quarter(0), ...quarter(1)]) {
          assert.ok(text.includes(`**${d.name_cn}**`), `${d.name_cn} should stay in the draft`);
        }
      });

      test('write to disk after each shard — one failed shard should not throw away the money spent on the earlier ones', async () => {
        const { db, config } = lotsEnv();
        // The first two shards succeed and everything from shard 3 refuses: three rounds cannot
        // fill it in, ending in ok=false
        const provider = scriptedProvider([
          { text: seg(quarter(0)) },
          { text: seg(quarter(1)) },
          { text: '', stop: 'refusal' },
          { text: seg(quarter(3)) },
          { text: '', stop: 'refusal' },  // round 2
          { text: '', stop: 'refusal' },  // round 3
        ]);
        const r = await generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' });

        assert.equal(r.ok, false);
        assert.equal(r.path, null, 'knowing a shard is missing, it must never land');
        // **The draft used to be written only after the whole sharding loop finished**, so an
        // exception in any shard threw away the earlier ones along with their web research.
        // Measured: after the production failure .drafts/ was empty
        assert.ok(existsSync(r.draftPath), 'the draft has to be there');
        const draft = readFileSync(r.draftPath, 'utf8');
        for (const d of [...quarter(0), ...quarter(1), ...quarter(3)]) {
          assert.ok(draft.includes(`**${d.name_cn}**`), `the successfully written ${d.name_cn} should stay in the draft`);
        }
        // The cause has to be handed out. The symptom of a missing shard is six missing-checkbox
        // findings, and that is a symptom, not the cause
        assert.equal(r.chunkFailures.length, 1);
        assert.deepEqual(
          [r.chunkFailures[0].chunk, r.chunkFailures[0].of, r.chunkFailures[0].count],
          [3, 4, 6]
        );
        assert.match(r.chunkFailures[0].reason, /拒答/);
      });

      test('every shard failing ⇒ throw the first real cause, not a pile of "missing checkbox"', async () => {
        const { db, config } = lotsEnv();
        const provider = scriptedProvider(Array.from({ length: 4 }, () => ({ text: '', stop: 'refusal' })));
        await assert.rejects(
          () => generateGuide(db, { db, config, provider, steam: lotsSteam(), appid: '1' }),
          (err) => {
            // Carrying on when not one shard was written means validating an empty draft, reporting
            // "every achievement is missing a checkbox" and then spending two more rounds asking —
            // the symptom buries the cause and two extra rounds are paid for
            assert.equal(err.code, 'refusal');
            assert.doesNotMatch(err.message, /checkbox/);
            return true;
          }
        );
        assert.equal(provider.asked.length, 4, 'it should stop once round one is done rather than opening a second round');
      });
    });
  });

  test('five achievements written in three shards assemble into five checkboxes with none missing', async () => {
    const { db, config } = envFor(2);
    const chunks = chunkDefs(BIG, 2);
    const provider = fakeProvider(chunks.map(seg));
    const r = await generateGuide(db, { config, provider, steam: bigSteam(), appid: '1' });

    assert.equal(r.ok, true);
    assert.equal(provider.asked.length, 3, 'three shards should take three calls');
    const text = readFileSync(r.path, 'utf8');
    // Compare strings directly rather than assembling a regex — every character of
    // `- [ ] **名字**` would need escaping, and getting it wrong reports "invalid regex" rather
    // than "the guide is one entry short", sending the diagnosis entirely the wrong way
    for (const d of BIG) {
      assert.ok(text.includes(`- [ ] **${d.name_cn}**`), `${d.name_cn} was lost in the assembled guide`);
    }
    assert.equal((text.match(/^# /gm) || []).length, 1, 'there can be only one title, not one per shard');
  });

  test('when only one shard has a problem, round two re-asks only that shard', async () => {
    const { db, config } = envFor(2);
    const chunks = chunkDefs(BIG, 2);
    // Shard 2 (成就3/成就4) is missing 成就4
    const bad = seg([chunks[1][0]]);
    const provider = fakeProvider([seg(chunks[0]), bad, seg(chunks[2]), seg(chunks[1])]);
    const r = await generateGuide(db, { config, provider, steam: bigSteam(), appid: '1' });

    assert.equal(r.ok, true);
    assert.equal(r.rounds, 2);
    assert.equal(provider.asked.length, 4, '3 calls in round one plus 1 to fill in on round two');
    assert.match(provider.asked[3], /第 2\/3 段/, 'the re-ask has to be the shard with the problem');
    assert.match(provider.asked[3], /只重新输出这一段/);
    assert.match(readFileSync(r.path, 'utf8'), /- \[ \] \*\*成就4\*\*/);
  });

  test('the send-back list carries only this shard own problems, not another shard errors', () => {
    const chunks = chunkDefs(BIG, 2);
    const findings = [
      { level: 'error', code: 'missing-checkbox', apiName: 'B', message: '成就2 没有 checkbox' },
      { level: 'error', code: 'missing-checkbox', apiName: 'E', message: '成就5 没有 checkbox' },
    ];
    const m = buildChunkFeedback(findings, chunks, 0, new Set());
    assert.match(m, /成就2/);
    assert.doesNotMatch(m, /成就5/, 'a shard 3 problem should not appear in shard 1 send-back list');
  });
});

// The only reason `--dry-run` exists is to let someone see what would be sent. Assembling the
// parameters a second time inside it makes it fork from the copy actually sent — measured: the
// dry run was missing `rarity` and `target`, so one game's dry run printed the checkbox label
// version while a real run would send the collapsible version. **Structurally there is only one
// entry point**, so the fork has nowhere to happen.
test('the prompt has one entry point, so a dry run and a real send cannot fork', () => {
  const plan = {
    game: '测试游戏',
    defs: [def('A', '第一步', '完成第一关。')],
    rarity: null,
    target: 'notion',
  };
  const viaPlan = systemPromptFor(plan, '1', { canSearch: true });
  assert.match(viaPlan, /<summary>\*\*前置\*\*/,
    'systemPromptFor did not pass plan.target through — the dry run would print the wrong version');

  // All three paths have to go through systemPromptFor; none may call buildSystemPrompt with its
  // own parameters
  for (const f of ['../lib/guidegen.js', '../lib/guidepatch.js', '../tracker.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const direct = src.split('\n').filter((l) =>
      /\bbuildSystemPrompt\(/.test(l) && !/^export function buildSystemPrompt|return buildSystemPrompt/.test(l.trim()));
    assert.deepEqual(direct, [],
      `${f} still calls buildSystemPrompt directly — its parameters will fork from the other two paths`);
  }
});

describe('regroupByAssignment (the rearrangement after classification moved to a final pass)', () => {
  const D = [
    def('A', '喵界图鉴', '解锁所有吉祥物。'),
    def('B', '狗狗上位', '将吉祥物替换成一条狗。'),
    def('C', '宿敌登台', '将吉祥物替换为一只怪物。'),
    def('E', '开盒', '使用各式钥匙打开30个宝箱。'),
  ];
  const map = (pairs) => new Map(pairs);

  /**
   * The classification pass **lists only the sections holding achievements** and never mentions a
   * pure prose section — and anything unmentioned is appended at the end. So the 「机制速查」 of
   * rule 3.5 would be moved from before the list to the very end of the document, dangling under
   * the last achievement; that is something to read before the list, and moving it to the end is
   * the same as not writing it.
   *
   * One game's rewrite really did come out that way, though the draft has been deleted and it
   * cannot be proven whether the rearrangement moved it or the model wrote it at the end to begin
   * with. **The rule is right in either case**, so write by the rule, not by the guess.
   */
  test('a pure prose section not mentioned in the classification stays on the side of the achievement list it was on', () => {
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
      'the reference first and the notes last — each stays on the side it was on in the original');
  });

  // Hit in one real game: four achievements of the same kind were split across two sections. The
  // pass before the body is written **structurally** cannot see that split (the split happens
  // after it), while the final pass sees the whole document and can move them back.
  test('achievements of the same kind split across two places are brought together, with a section intro following its own section', () => {
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

    assert.match(out, /## 商店\n\n宝石是商店货币。/, 'a section intro has to stay under its own section');
    const mascot = out.slice(out.indexOf('## 吉祥物替换'));
    assert.match(mascot, /狗狗上位/, '狗狗上位 was not moved across');
    assert.match(mascot, /宿敌登台/);
    assert.doesNotMatch(out.slice(0, out.indexOf('## 吉祥物替换')), /狗狗上位/, 'once moved it must not remain in its old place');
  });

  // When the model misses a mapping, **leaving it where it is** is the only handling that creates
  // no new error — dropping it is a silent loss, and putting it in a miscellaneous section is
  // actively misfiling an achievement that was correctly filed
  test('an achievement the mapping does not cover stays in its original section', () => {
    const body = ['## 商店', '- [ ] **喵界图鉴**<br>解锁所有吉祥物。', '- [ ] **开盒**<br>使用各式钥匙打开30个宝箱。'].join('\n');
    const out = regroupByAssignment(body, { defs: D, assignment: map([['A', '商店']]), sections: ['商店'] });
    assert.match(out, /开盒/, 'an entry with no mapping must not be dropped');
    assert.equal((out.match(/开盒/g) ?? []).length, 1, 'nor duplicated');
  });

  // With a Notion target, one achievement's body is "its own line plus a few `<details>` groups".
  // The move has to take the whole block: moving only the first line leaves the sub-steps in the
  // original section — the old ailment of todoSpans recognising only checkbox lines
  test('an achievement with <details> groups moves as one block, with no sub-step left behind', () => {
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
    assert.doesNotMatch(head, /先买下狗狗吉祥物/, 'the sub-step was left in the original section — the range did not take the collapsible');
    assert.match(out.slice(out.indexOf('## 吉祥物替换')), /先买下狗狗吉祥物/);
  });

  // A section left with no entries at all and only its intro: keeping it is a visible blemish,
  // dropping it is an invisible loss
  test('a section left with only its intro is kept, with no text silently dropped', () => {
    const body = ['## 商店', '这一节讲商店怎么用。', '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。'].join('\n');
    const out = regroupByAssignment(body, { defs: D, assignment: map([['B', '吉祥物替换']]), sections: ['吉祥物替换'] });
    assert.match(out, /这一节讲商店怎么用。/, 'the section was emptied, but its intro must not disappear with it');
  });

  // Hit in one real game: a `- [ ]` inside a section-level long-list collapsible (rule 五) is
  // top-level as far as `parseTodos` is concerned (there is no shallower checkbox before it to
  // hang off). Without a special case they are moved away as individual achievements — the
  // collapsible is left an empty shell with 12 entries scattered outside it.
  //
  // **And the first two assertions did not fire at all**: not one character was lost; what was
  // lost was the structure. Assertion 3 was added for that, and verified the same way by fault
  // injection (changing that branch to `if (false && ...)` makes it throw
  // 「重排把折叠块拆开了」 on the spot).
  test('a section-level standalone collapsible follows its section as one block rather than being split into a pile of top-level entries', () => {
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
      'the collapsible was hollowed out — the entries have to stay inside it');
    assert.doesNotMatch(out, /<\/details>\n\n- \[ \] 「回归自我」/,
      'the entries were moved outside the collapsible');
  });

  // Hit in one real game: after 「羁绊」 was emptied the page was left with a heading carrying only
  // an intro and not one achievement, sitting right after the section that took all of its entries.
  // The old rule was "keep it", on the grounds that no rule could say who that intro should follow —
  // and "the section that received the most entries" is a definite criterion needing no guess.
  test('the intro of an emptied section is merged into the section that received the most of its entries', () => {
    const body = ['## 商店', '商店怎么用的说明。', '- [ ] **狗狗上位**<br>x', '- [ ] **宿敌登台**<br>y'].join('\n');
    const out = regroupByAssignment(body, {
      defs: D, assignment: new Map([['B', '外观'], ['C', '外观']]), sections: ['外观'],
    });
    assert.doesNotMatch(out, /## 商店/, 'an emptied section should not leave an empty heading behind');
    assert.match(out, /商店怎么用的说明。/, 'but not one character of its intro may be lost');
    assert.ok(out.indexOf('## 外观') < out.indexOf('商店怎么用的说明'), 'the intro has to land in the receiving section');
  });

  // A pure prose section that never had entries has no "most" to speak of, so keeping it is right
  test('a pure prose section that never had entries is untouched', () => {
    const body = ['## 写在前面', '这游戏要通三遍。', '## 商店', '- [ ] **狗狗上位**<br>x'].join('\n');
    const out = regroupByAssignment(body, { defs: D, assignment: new Map(), sections: [] });
    assert.match(out, /## 写在前面/, 'a section with no entries to move should not be merged away');
  });

  // **The assertion is not decorative; it was verified by fault injection.** Changing the exit line
  // to `b.prose[0]` (taking only the first line of the intro) made it throw
  // 「重排丢了正文:「说明第二行。」进去 1 次、出来 0 次」 on the spot.
  // What is kept here is its **opposite**: the same achievement appearing twice in the body is the
  // validator's job, and the rearrangement should not "fix" it while it is there.
  test('duplicate entries are left as they are for the validator to report; the rearrangement does not take it upon itself', () => {
    const dup = [
      '## 商店',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
      '## 别处',
      '- [ ] **狗狗上位**<br>将吉祥物替换成一条狗。',
    ].join('\n');
    const out = regroupByAssignment(dup, { defs: D, assignment: new Map([['B', '商店']]), sections: ['商店'] });
    assert.equal((out.match(/狗狗上位/g) ?? []).length, 2, 'both have to stay — deduplication is the validator job, not the rearrangement');
  });
});

/**
 * The collapsible of rule 五 is for long content, not for the achievement list — but rule 五 only
 * said 「到 10 行才折」 and never said 「成就本身永远不折」. Measured on one game: the whole
 * `## 世界全清` section of 13 achievements was stuffed into one collapsible, and that section shows
 * 0 entries on Notion.
 */
describe('unwrapAchievementToggles (pulling achievements out of a collapsible)', () => {
  const D = [
    def('W1', '快乐露营者', '以100%完成度通关世界1的所有关卡。'),
    def('W2', '老练水手', '以100%完成度通关世界2的所有关卡。'),
    def('S', '宿敌登台', '将吉祥物替换为一只怪物。'),
  ];

  test('a top-level collapsible holding achievements — take it apart, with the label demoted to a bold line', () => {
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
    assert.doesNotMatch(text, /<\/?details|<\/?summary/i, 'not a trace of the shell remains');
    assert.match(text, /^\*\*世界 1~12 全清与通关\*\*$/m, 'the label is kept — it is the name of this group');
    for (const t of ['快乐露营者', '老练水手']) assert.match(text, new RegExp(t));
  });

  test('indented achievements return to column zero once pulled out — otherwise parseTodos takes them for sub-steps', () => {
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
      assert.equal(line, line.trimStart(), `still indented: ${line}`);
    }
  });

  /**
   * **This is the half that guards against collateral damage.** Rule 一 requires prerequisites /
   * steps / cautions to be written as indented `<details>` group labels under a Notion target, and
   * a collapsible of that kind holds sub-steps, not achievements — taking it apart destroys rule 一.
   */
  test('a group-label collapsible hanging under an achievement must not be touched', () => {
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
    assert.equal(text, md, 'not one character should change');
  });

  /**
   * **The indentation criterion is its own gate and cannot be replaced by "does it hold
   * achievements".**
   *
   * Sub-steps inside a group collapsible usually resolve to no achievement (a whole sentence does
   * not equal an achievement name, and `resolveTodoToAchievement` requires exact equality), so most
   * of the time the two gates look like the same thing. But the 「前置」 group **naturally lists
   * other achievements one per line**, and those lines are exactly equal and do resolve — at which
   * point only the indentation says this is supporting material hanging under something else rather
   * than a section of achievement list. Take it apart and rule 一's group labels are destroyed, and
   * those sub-steps become top-level entries that read like duplicated achievements.
   */
  test('prerequisite achievements listed one by one inside an indented collapsible must not be taken apart either', () => {
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
    assert.deepEqual(unwrapped, [], 'the indentation says it is supporting material, and mentioning achievements inside does not change that');
    assert.equal(text, md);
  });

  test('a top-level collapsible that holds no achievements is untouched too — the all-endings table kind', () => {
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

  // A truncated model response leaves exactly one unclosed <details>, and running to end of file
  // would swallow every achievement after it
  test('an unclosed collapsible is left alone', () => {
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

  test('a summary whose opening and closing tags sit on their own lines is recognised too', () => {
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
    assert.doesNotMatch(text, /<\/?summary/i, 'a bare summary tag must not be left in the body');
  });

  test('a body with no collapsible comes back unchanged', () => {
    const md = '## 一节\n\n- [ ] **宿敌登台**<br>将吉祥物替换为一只怪物。';
    assert.deepEqual(unwrapAchievementToggles(md, D), { text: md, unwrapped: [] });
  });
});

/**
 * An already-unlocked achievement gets one line.
 *
 * A guide is something to follow, and the entries already finished need no method — the name, the
 * official description and a box that can be ticked are everything still of use. What is saved is
 * the research and prose for those entries, which is the only thing this feature spends money on.
 */
describe('an unlocked achievement gets one line', () => {
  describe('briefApiNames — who goes on the brief list', () => {
    const D = [def('A', '甲', '一'), def('B', '乙', '二'), def('C', '丙', '三')];

    test('unlocked ones go in, locked ones do not', () => {
      assert.deepEqual([...briefApiNames(D, ['A', 'C'])], ['A', 'C']);
    });

    test('none unlocked → the list is empty', () => {
      assert.deepEqual([...briefApiNames(D, [])], []);
    });

    // **A fully unlocked game saves not one entry.** What would be saved is the whole guide —
    // leaving a string of lines carrying only names and official descriptions, which the Steam page
    // already has. Someone generating a guide for a 100% game wants precisely the content
    test('fully unlocked → the list is empty, not everything', () => {
      assert.deepEqual([...briefApiNames(D, ['A', 'B', 'C'])], []);
    });

    test('no achievements does not blow up', () => {
      assert.deepEqual([...briefApiNames([], ['A'])], []);
      assert.deepEqual([...briefApiNames(null, null)], []);
    });
  });

  describe('buildChunkMessage — how the prompt says it', () => {
    const D = [def('A', '甲', '一'), def('B', '乙', '二'), def('C', '丙', '三'), def('D', '丁', '四')];

    // With an empty list this sentence has to carry **not one extra character** — this is the path
    // the vast majority of guides take
    test('nothing to write briefly → character for character what it was', () => {
      assert.equal(buildChunkMessage([D], 0, new Set()),
        '开始写吧。先联网查资料,再按规则写完整份攻略。');
      assert.equal(buildChunkMessage([D], 0), '开始写吧。先联网查资料,再按规则写完整份攻略。');
    });

    test('the brief ones are a minority → name them', () => {
      const m = buildChunkMessage([D], 0, briefApiNames(D, ['A']));
      assert.match(m, /「甲」/);
      assert.match(m, /一行就停/);
      assert.doesNotMatch(m, /「乙」/, 'the ones to write in full should not appear on the brief list');
    });

    // Most games are "already more than half unlocked", and there listing "the few to write in
    // full" is far shorter than listing "the forty to write briefly", and is exactly the work the
    // model really has to do for this shard
    test('the brief ones are the majority → name the few to write in full instead', () => {
      const m = buildChunkMessage([D], 0, briefApiNames(D, ['A', 'B', 'C']));
      assert.match(m, /只有这几个要按规则写完整/);
      assert.match(m, /「丁」/);
      assert.doesNotMatch(m, /「甲」/, 'when the brief ones are the majority they should not be listed one by one');
    });

    test('when sharded, that sentence follows the shard rather than being one for the whole guide', () => {
      const chunks = [D.slice(0, 2), D.slice(2)];
      const brief = briefApiNames(D, ['A', 'D']);
      assert.match(buildChunkMessage(chunks, 0, brief), /「甲」/);
      assert.doesNotMatch(buildChunkMessage(chunks, 0, brief), /「丁」/, 'shard one should not mention another shard achievement');
      assert.match(buildChunkMessage(chunks, 1, brief), /「丁」/);
    });
  });

  describe('end to end: generateGuide really asks this way', () => {
    test('one unlocked → the prompt names it and asks for one line only', async () => {
      const { db, config } = freshEnv();
      const provider = fakeProvider([GOOD]);
      await generateGuide(db, { config, provider, steam: fakeSteam(['A']), appid: '1' });
      assert.match(provider.asked[0], /「第一步」/, 'the unlocked one has to be named');
      assert.match(provider.asked[0], /一行就停/);
    });

    test('fully unlocked → nothing is abbreviated and the prompt returns to the original sentence', async () => {
      const { db, config } = freshEnv();
      const provider = fakeProvider([GOOD]);
      await generateGuide(db, { config, provider, steam: fakeSteam(['A', 'B']), appid: '1' });
      assert.doesNotMatch(provider.asked[0], /一行就停/,
        'when fully unlocked what would be saved is the whole guide, and what is left the Steam page already has');
    });

    // **An overwrite rewrite abbreviates nothing.** The guide already holds prose that was paid
    // for, and "they unlocked this one since" is no reason to delete that text — once deleted there
    // is nowhere left to find it
    test('an overwrite rewrite → no abbreviation; prose already written must not be collapsed into one line', async () => {
      const { db, config } = freshEnv();
      const provider = fakeProvider([GOOD]);
      await generateGuide(db, {
        config, provider, steam: fakeSteam(['A']), appid: '1', overwrite: true,
      });
      assert.doesNotMatch(provider.asked[0], /一行就停/,
        'abbreviating on an overwrite deletes prose they paid for');
    });
  });
});

/**
 * The prompt forks by language
 * ------------------------------------------------
 * Rule text cannot be shared between the two — a translation is a different string all the way
 * down — so what is shared is the shape. These tests are what makes "one builder, language as a
 * parameter" mean something other than two prompts that drift.
 *
 * The alternative was generating English by asking the Chinese prompt for English output. It reads
 * as the cheap option and is not: the rules would still be describing a Chinese guide format, and
 * the one signal that anything was wrong would be guides slowly coming out in a different shape.
 */
describe('the prompt in two languages', () => {
  const defs = [
    {
      api_name: 'A_ONE', name_cn: '开局', name_en: 'First Step',
      description: '完成序章', description_en: 'Finish the prologue', hidden: 0,
    },
    {
      api_name: 'A_TWO', name_cn: '收藏家', name_en: 'Collector',
      description: '', description_en: '', hidden: 1,
    },
  ];
  const build = (lang, opts) => buildSystemPrompt('测试游戏', '1', defs, { target: 'notion', lang, ...opts });

  describe('section parity', () => {
    test('every section in the table appears in its own language, in order', () => {
      for (const half of [0, 1]) {
        const prompt = build(half === 0 ? 'zh' : 'en');
        let at = -1;
        for (const pair of PROMPT_SECTIONS) {
          const found = prompt.indexOf('\n' + pair[half] + '\n');
          assert.notEqual(found, -1, pair[half] + ' is missing from the ' + (half ? 'English' : 'Chinese') + ' prompt');
          assert.ok(found > at, pair[half] + ' is out of order');
          at = found;
        }
      }
    });

    test('neither prompt has a section the table does not list', () => {
      // Without this the table is satisfied by a prompt that grew a section in one language only —
      // the exact failure it exists to catch, arriving from the side it is not looking at
      for (const half of [0, 1]) {
        const rules = build(half === 0 ? 'zh' : 'en').split('\n---\n')[0];
        const headings = [...rules.matchAll(/^## .+$/gm)].map((m) => m[0]);
        const listed = PROMPT_SECTIONS.map((pair) => pair[half]);
        // The research block is appended after the rules and varies with canSearch rather than with
        // language, so its two sections are not part of this table
        const research = /查资料|research|预算|budget|联网|network/i;
        const unlisted = headings.filter((h) => !listed.includes(h) && !research.test(h));
        assert.deepEqual(unlisted, [], 'unlisted sections in the ' + (half ? 'English' : 'Chinese') + ' prompt');
      }
    });

    test('the two halves of every pair really are different strings', () => {
      // A pair filled in by pasting the Chinese heading into both columns would satisfy everything
      // above while leaving that section untranslated
      for (const [zh, en] of PROMPT_SECTIONS) assert.notEqual(zh, en);
    });
  });

  describe('the rules that genuinely differ', () => {
    test('the English prompt asks for English output', () => {
      assert.match(build('en'), /\*\*Write it in English\.\*\*/);
    });

    test('the English list puts the official English name first', () => {
      // Rule 3 requires the bold name to equal a name in the list, so which one leads decides which
      // language the entries come out in — and the matching index holds both, so either one ticks
      assert.match(build('en'), /\*\*First Step\*\* \/ 开局/);
      assert.match(build('zh'), /\*\*开局\*\* \/ First Step/);
    });

    test('the English list quotes description_en', () => {
      assert.match(build('en'), /Official description: Finish the prologue/);
      assert.match(build('zh'), /官方描述:完成序章/);
    });

    test('an achievement with no English description keeps the Chinese one rather than losing it', () => {
      // A game synced before description_en existed has English names and Chinese descriptions. An
      // empty description leaves rule 4 with nothing to copy verbatim and the entry gets written from
      // its name alone. The odd-looking result is recoverable by syncing; an invented one is not
      const half = [{ ...defs[0], description_en: '' }];
      assert.match(buildSystemPrompt('测试游戏', '1', half, { target: 'notion', lang: 'en' }),
        /Official description: 完成序章/);
    });

    test('an empty description is marked as empty in both languages, never left blank', () => {
      assert.match(build('en'), /\(empty on Steam\)/);
      assert.match(build('zh'), /\(Steam 上是空的\)/);
    });

    test('the English prompt drops the missing-Chinese-localisation rules', () => {
      // Both are about a game shipping no Chinese name. In an English guide they have no subject,
      // and a rule with no subject still costs the model attention
      assert.doesNotMatch(build('en'), /暂无中文翻译/);
      assert.doesNotMatch(build('en'), /官方中文/);
      assert.match(build('zh'), /暂无中文翻译/);
    });

    test('citations follow the source actually read rather than naming one site', () => {
      // The Chinese prompt names B站 because that is where the coverage is for its readers. The
      // English one must not inherit that as a default, or it cites a source it never opened
      assert.match(build('en'), /Cite whatever source you actually read/);
      assert.match(build('zh'), /B站 BV/);
    });

    test('the research sources stay the same in both — the fork is the output, not the reading', () => {
      // Deliberate: for a Chinese-developed game the best guide really is on NGA or Bilibili, and a
      // model that can read it can write English from it. Dropping those sites would make English
      // guides worst exactly where guides are hardest to find
      for (const site of ['TrueAchievements', 'Fandom']) {
        assert.ok(build('en').includes(site), site + ' is missing from the English research rules');
        assert.ok(build('zh').includes(site), site + ' is missing from the Chinese research rules');
      }
      assert.match(build('en'), /Bilibili/);
    });

    test('the offline variant forks too', () => {
      assert.match(build('en', { canSearch: false }), /You have \*\*no search or page-fetch tools\*\*/);
      assert.match(build('zh', { canSearch: false }), /你这次没有联网能力/);
    });
  });

  describe('the rules that must NOT differ', () => {
    // The hard rules are what the validator checks afterwards. One dropped from a single language
    // produces guides that fail lint in that language only, which reads as the model being worse at
    // English rather than as a missing rule
    const HARD = [
      ['一行只能有一个 checkbox', 'One checkbox per line'],
      ['永远不要写 `- [x]`', 'never `- [x]`'],
      ['一字不差', 'must match the list below exactly'],
      ['原文照抄', 'Copy the official description verbatim'],
      ['不要写大标题行', 'Do not write a top-level heading'],
    ];

    test('every hard rule is present in both languages', () => {
      const zh = build('zh');
      const en = build('en');
      for (const [z, e] of HARD) {
        assert.ok(zh.includes(z), 'the Chinese prompt lost: ' + z);
        assert.ok(en.includes(e), 'the English prompt lost: ' + e);
      }
    });

    test('both prompts number the same count of hard rules', () => {
      // Every numbered rule, not only the ones opening in bold — four of the eight do not, and a
      // regex that sees only bold ones counts four in each language and calls that parity
      const count = (p) => (p.split('\n---\n')[0].match(/^\d+\. /gm) || []).length;
      assert.ok(count(build('zh')) >= 8, 'the hard rules were not found at all');
      assert.equal(count(build('en')), count(build('zh')));
    });
  });

  test('the language reaches the prompt only through the plan', () => {
    // Same rule as `target`: three paths have to send the same prompt — full generation, partial
    // rewrite, and --dry-run's preview. A caller resolving the language for itself is where they
    // first disagree, and the preview exists precisely to show what will be sent
    const plan = { game: '测试游戏', defs, rarity: null, target: 'notion', lang: 'en' };
    assert.equal(systemPromptFor(plan, '1', { canSearch: true }), build('en'));
    assert.equal(systemPromptFor({ ...plan, lang: 'zh' }, '1', { canSearch: true }), build('zh'));
  });
});

/**
 * Which language a generated guide comes out in
 * ------------------------------------------------
 * Resolved once, in `planGuide`, from the interface language — and that is deliberately the entire
 * mechanism for changing an existing guide's language. There is no separate "generate in English"
 * action: a second button beside 「重写」 doing the same work with a different output is two ways to
 * spend the same money on the one guide a game is allowed. So switching the interface and pressing
 * 「重写」 is how a Chinese guide becomes an English one, which is why the rewrite dialog's title
 * names the language — otherwise that path would be silent.
 */
describe('the language a guide is generated in', () => {
  const plan = (uiLanguage) => {
    const { db, config } = freshEnv();
    return planGuide(db, { config: { ...config, uiLanguage }, steam: fakeSteam(), appid: '1' });
  };

  test('follows the interface language', async () => {
    assert.equal((await plan('en')).lang, 'en');
    assert.equal((await plan('zh')).lang, 'zh');
  });

  test('an unset or unrecognised interface language means Chinese', async () => {
    // `uiLanguage` is a config field, so it is a value a person can type
    for (const junk of [undefined, null, '', 'fr', 'EN']) {
      assert.equal((await plan(junk)).lang, 'zh', String(junk));
    }
  });

  test('an overwrite follows the interface too, not the guide it replaces', async () => {
    // The half that is easy to get backwards, and getting it backwards removes the only way to
    // change a guide's language: a rewrite that inherited the old language could never produce
    // anything but the old language
    const { db, config } = freshEnv();
    upsertGuide(db, { appid: '1', name: '测试游戏', url: 'g.md', kind: 'local' });
    setGuideLang(db, '1', 'zh');
    writeFileSync(join(config.guidesDir, 'g.md'), '# 测试游戏\n\nappid: 1\n\n- [ ] **第一步**\n');
    const p = await planGuide(db, {
      config: { ...config, uiLanguage: 'en' }, steam: fakeSteam(), appid: '1', overwrite: true,
    });
    assert.equal(p.existing.lang, 'zh', 'the old guide really was Chinese');
    assert.equal(p.lang, 'en', 'and the rewrite is planned in the interface language');
  });
});

describe('the landed guide records which language it was written in', () => {
  /**
   * Written after the landing rather than as a field on the upsert, because the two discovery paths
   * that create the row register guides they *found* and know nothing about the language.
   *
   * **Only on success.** Recording it from a run that failed to land would leave the achievement
   * panel marking a guide that is still the old one — a wrong marker on a guide nobody changed.
   */
  test('a guide generated in English is recorded as English', async () => {
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config: { ...config, uiLanguage: 'en' }, provider: fakeProvider([GOOD]),
      steam: fakeSteam(['A']), appid: '1',
    });
    assert.equal(r.ok, true);
    assert.equal(allGuides(db)[0].lang, 'en');
  });

  test('a guide generated in Chinese is recorded as Chinese', async () => {
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config: { ...config, uiLanguage: 'zh' }, provider: fakeProvider([GOOD]),
      steam: fakeSteam(['A']), appid: '1',
    });
    assert.equal(r.ok, true);
    assert.equal(allGuides(db)[0].lang, 'zh');
  });

  test('a rewrite that changes the language updates the record', async () => {
    // The path a person actually takes to get an English guide: switch the interface, press 「重写」.
    // If the column kept the old value the panel would go on marking the guide as Chinese while its
    // text was English — the marker pointing the wrong way is worse than no marker
    const { db, config } = freshEnv();
    await generateGuide(db, {
      config: { ...config, uiLanguage: 'zh' }, provider: fakeProvider([GOOD]),
      steam: fakeSteam(['A']), appid: '1',
    });
    assert.equal(allGuides(db)[0].lang, 'zh');

    const again = await generateGuide(db, {
      config: { ...config, uiLanguage: 'en' }, provider: fakeProvider([GOOD]),
      steam: fakeSteam(['A']), appid: '1', overwrite: true,
    });
    assert.equal(again.ok, true);
    assert.equal(allGuides(db)[0].lang, 'en');
  });

  test('a run that never lands records nothing', async () => {
    // There is no row to write to on this path, and that is the point: the assertion is that the
    // failure stays invisible to the guides table rather than half-registering
    const { db, config } = freshEnv();
    const r = await generateGuide(db, {
      config: { ...config, uiLanguage: 'en' },
      provider: fakeProvider([MISSING_B, MISSING_B, MISSING_B]), steam: fakeSteam(), appid: '1', rounds: 3,
    });
    assert.equal(r.ok, false);
    assert.equal(allGuides(db).length, 0);
  });

  test('a failed rewrite leaves the recorded language alone', async () => {
    // **This is the case the `ok` guard exists for.** A failed *new* guide has no row to write to,
    // so the guard is invisible there; a failed *overwrite* has one, and the old guide is still
    // sitting in it untouched. Stamping the new language on at that point would mark a Chinese
    // guide as English — the panel then says the text is in a language it is not, which is worse
    // than saying nothing, and nothing about the guide changed to explain it
    const { db, config } = freshEnv();
    await generateGuide(db, {
      config: { ...config, uiLanguage: 'zh' }, provider: fakeProvider([GOOD]),
      steam: fakeSteam(['A']), appid: '1',
    });
    assert.equal(allGuides(db)[0].lang, 'zh');

    const failed = await generateGuide(db, {
      config: { ...config, uiLanguage: 'en' },
      provider: fakeProvider([MISSING_B, MISSING_B, MISSING_B]),
      steam: fakeSteam(['A']), appid: '1', overwrite: true, rounds: 3,
    });
    assert.equal(failed.ok, false);
    assert.equal(allGuides(db)[0].lang, 'zh', 'the guide is still the Chinese one, so the record has to say so');
  });
});
