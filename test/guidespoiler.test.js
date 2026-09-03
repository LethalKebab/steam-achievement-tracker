/**
 * The spoiler pass
 * ------------------------------------------------
 * What this guards is the pass **doing something other than what it reported**. Every failure here
 * is quiet: a pick that silently matches nothing folds nothing and says so nowhere, a pick located
 * across a `<br>` joins two parts that were separate, and a cut that clips the official description
 * breaks `audit`'s reverse lookup on a page that still looks fine.
 *
 * The headline case is the typographic one. Told to copy verbatim the model reformats anyway, so a
 * pass built on a raw string match discards every pick while reporting nothing wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { guideEntries, parseSpoilerReply, foldSpoilers } from '../lib/guidespoiler.js';
import { lintGuide } from '../lib/guidelint.js';
import { loadTodos } from '../lib/markdown.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const def = (apiName, nameCn, description = '') => ({
  api_name: apiName, name_cn: nameCn, name_en: '', description,
});

const GUIDE = [
  '# 游戏',
  '',
  'appid: 123',
  '',
  '## 主线',
  '',
  '- [ ] **甲**<br>官方甲描述<br>照着流程走就行。真凶是医生。',
  '- [ ] **乙**<br>官方乙描述<br>刷三次即可。',
  '',
].join('\n');

const DEFS = [def('A', '甲', '官方甲描述'), def('B', '乙', '官方乙描述')];

const pick = (guide, reply) => {
  const entries = guideEntries(guide);
  return { entries, ...parseSpoilerReply(reply, entries) };
};

describe('locating what the model quoted', () => {
  test('a clean quote is located and folded', () => {
    const { picks, discarded } = pick(GUIDE, '【1】真凶是医生。');
    assert.equal(discarded.length, 0);
    const r = foldSpoilers(GUIDE, picks, DEFS);
    assert.equal(r.applied.length, 1);
    assert.ok(!r.text.includes('真凶是医生。<'), 'the sentence must be gone from the entry line');
    assert.match(r.text, /- \[ \] \*\*甲\*\*<br>官方甲描述<br>照着流程走就行。\n {2}<details>\n {2}<summary>剧透<\/summary>\n {2}真凶是医生。\n {2}<\/details>/);
  });

  test('**the quote glyphs may differ and it still lands** — the case that decided the design', () => {
    // Measured against the live model: told to copy verbatim it returned “…” where the guide holds
    // "…". A raw `includes` discards this and reports nothing wrong, which is the invisible direction
    const guide = GUIDE.replace('真凶是医生。', '真凶是"那位医生"。');
    const { picks, discarded } = pick(guide, '【1】真凶是“那位医生”。');
    assert.deepEqual(discarded, [], 'the typographic fold is what makes these the same sentence');
    const r = foldSpoilers(guide, picks, DEFS);
    assert.equal(r.applied.length, 1);
    assert.ok(r.text.includes('真凶是"那位医生"。'), 'what is folded is the guide\'s own bytes, not the model\'s rewrite');
  });

  test('a sentence the model invented is discarded, not guessed at', () => {
    const { picks, discarded } = pick(GUIDE, '【1】真凶是园丁。');
    assert.equal(picks.length, 0);
    assert.equal(discarded[0].reason, 'not-found');
  });

  test('a sentence appearing in two entries is discarded', () => {
    const guide = GUIDE.replace('刷三次即可。', '照着流程走就行。');
    const { picks, discarded } = pick(guide, '【1】照着流程走就行。');
    assert.equal(picks.length, 0);
    assert.equal(discarded[0].reason, 'ambiguous');
  });

  test('the achievement name is never cut into', () => {
    // The name is copied from Steam verbatim and is one of the two handles the sync matches on
    const { picks, discarded } = pick(GUIDE, '【1】**甲**');
    assert.equal(picks.length, 0);
    assert.equal(discarded[0].reason, 'in-the-name');
  });

  test('the model numbering the wrong entry does not misplace the fold', () => {
    // The number is a hint; the sentence's own content decides which entry is folded
    const { picks } = pick(GUIDE, '【2】真凶是医生。');
    const r = foldSpoilers(GUIDE, picks, DEFS);
    assert.equal(r.applied[0].line, 7, 'folded into the entry that actually holds the sentence');
  });
});

describe('what the cut is not allowed to damage', () => {
  test('a pick that would clip the official description is reverted on its own', () => {
    const { picks } = pick(GUIDE, '【1】官方甲描述<br>照着流程走就行。真凶是医生。');
    const r = foldSpoilers(GUIDE, picks, DEFS);
    assert.equal(r.applied.length, 0);
    assert.equal(r.reverted[0].reason, 'would-cut-the-official-description');
    assert.equal(r.text, GUIDE, 'nothing else moved either');
  });

  test('every description still sits in its entry verbatim afterwards', () => {
    const { picks } = pick(GUIDE, '【1】真凶是医生。');
    const r = foldSpoilers(GUIDE, picks, DEFS);
    for (const d of DEFS) assert.ok(r.text.includes(d.description), `${d.description} was not preserved`);
  });
});

describe('where the fold is put', () => {
  const WITH_SUBSTEPS = [
    '# 游戏', '', 'appid: 123', '',
    '- [ ] **甲**<br>官方甲描述<br>照着流程走。真凶是医生。',
    '  - [ ] 第一步',
    '  - [ ] 第二步',
    '- [ ] **乙**<br>官方乙描述<br>刷三次即可。',
    '',
  ].join('\n');

  test('it goes after the sub-steps, not between them and their achievement', () => {
    // todoSpans — what a local partial rewrite replaces — ends at the first non-checkbox line, so a
    // fold inserted in the middle would cut the sub-step run in half
    const { picks } = pick(WITH_SUBSTEPS, '【1】真凶是医生。');
    const out = foldSpoilers(WITH_SUBSTEPS, picks, DEFS).text.split('\n');
    assert.equal(out[5], '  - [ ] 第一步');
    assert.equal(out[6], '  - [ ] 第二步');
    assert.equal(out[7], '  <details>');
  });

  test('**the fold this pass writes passes the linter that checks folds**', () => {
    // The two halves were written days apart against the same rules; this is the assertion that
    // says they actually agree, rather than each being self-consistent
    const { picks } = pick(WITH_SUBSTEPS, '【1】真凶是医生。');
    const text = foldSpoilers(WITH_SUBSTEPS, picks, DEFS).text;
    const dir = mkdtempSync(join(tmpdir(), 'spoiler-'));
    const file = join(dir, 'g.md');
    writeFileSync(file, text);
    const r = lintGuide({ todos: loadTodos(file), defs: DEFS, text, kind: 'local' });
    assert.deepEqual(r.findings.filter((f) => f.code.startsWith('spoiler-')), []);
    assert.equal(r.stats.spoilerFolds, 1);
  });

  test('two picks in one entry share one fold', () => {
    const guide = GUIDE.replace('真凶是医生。', '真凶是医生。他其实还活着。');
    const { picks } = pick(guide, '【1】真凶是医生。\n【1】他其实还活着。');
    const r = foldSpoilers(guide, picks, DEFS);
    assert.equal(r.applied.length, 2);
    assert.equal((r.text.match(/<details>/g) ?? []).length, 1);
  });
});
