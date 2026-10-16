/**
 * Words the owner has rejected as too spoken for text the reader sees
 * ------------------------------------------------
 * Run with: node --test
 *
 * `han-readability` is a writing standard with a self-check. It does not flag a word, so the spoken
 * ones that were rejected by hand kept coming back in new strings. This file is the list of what has
 * been rejected, and the scan that keeps those words out of every surface a reader sees.
 *
 * | Surface | How it is read |
 * |---|---|
 * | the Dashboard, terminal and launcher message tables | the Chinese half of every entry, **imported**, so a prompt, a comment or a rule table in the same file cannot trip it |
 * | `Dashboard.html`, `Setup.html`, `lib/rpc.js`, `tracker.js` | the whole file with its comments taken out |
 * | `README.zh.md` | the whole file with its HTML comments taken out |
 *
 * **It is a list of what was rejected, not a style checklist.** A word goes on it when the owner
 * rejects it, in the same change that replaces it, and nothing here is inferred from a rule. That is
 * how a rejected word stays rejected: the next string written in a hurry fails here instead of
 * being found by eye.
 *
 * Not scanned, on purpose: the prompts sent to the model and the developer-facing rule table in
 * `guidegen.js`, which are not text a reader sees; and `docs/` and `CLAUDE.md`, whose design records
 * quote the rejected words they discuss.
 *
 * **The list is only as good as the scan can see.** A scan over a table that imported empty passes
 * on everything, so each surface is asserted to hold enough text before it is searched, and each
 * entry is asserted to catch its own word.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MESSAGES } from '../lib/messages.js';
import { CLI_MESSAGES } from '../lib/cli-messages.js';
import { TRACKER_MESSAGES } from '../lib/tracker-messages.js';
import { LAUNCHER_MESSAGES } from '../launcher/strings.js';

// ---------------------------------------------------------------------------
// What has been rejected, and what is written instead
// ---------------------------------------------------------------------------

/**
 * `re` is what is searched for, written to leave out the **ordinary words that contain the rejected
 * one**: 挑战 and 挑选 for 挑, 默认不出现 for 认不出 (it spells 认不出 across the word boundary), and
 * 没成功 for 没成. `use` is what to write instead, and appears in the failure.
 */
const REJECTED = [
  { word: '没成', re: /没成(?!功)/, use: '失败' },
  { word: '挑', re: /挑(?![战选])/, use: '选择 / 选中' },
  { word: '认不出', re: /(?<!默)认不出/, use: '无法识别' },
  { word: '认得出', re: /认得出/, use: '能识别' },
  { word: '一字不动', re: /一字不动/, use: '保持不变' },
  { word: '一字没动', re: /一字没动/, use: '保持不变' },
  { word: '一个字都没动', re: /一个字都没动/, use: '没有任何改动' },
  { word: '没法', re: /没法/, use: '无法' },
  { word: '动不了', re: /动不了/, use: '无法修改 / 不能修改' },
  { word: '点不动', re: /点不动/, use: '无法选中' },
  { word: '改不到', re: /改不到/, use: '不能修改' },
  { word: '改不了', re: /改不了/, use: '不能修改' },
  { word: '点到了', re: /点到了/, use: '已点名' },
  { word: '压根', re: /压根/, use: '根本' },
  { word: '打满', re: /打满/, use: '解锁全部成就' },
  { word: '做满', re: /做满/, use: '解锁全部成就' },
];

/** Which rejected words a piece of text contains */
const rejectedIn = (text) => REJECTED.filter((r) => r.re.test(text));

/** A comment is not text a reader sees. Newlines stay, so a hit is reported on its real line */
function withoutComments(text, { script = true } = {}) {
  const keepLines = (m) => m.replace(/[^\n]/g, '');
  let out = text.replace(/<!--[\s\S]*?-->/g, keepLines);
  if (script) {
    // Line comments first: a `//` line can contain `/api/` followed by a star, which the block-comment
    // pattern would read as an opener. `:` before the slashes is a URL, a quote is a string
    out = out
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
      .replace(/\/\*[\s\S]*?\*\//g, keepLines);
  }
  return out;
}

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const chineseChars = (s) => (s.match(/[一-鿿]/g) ?? []).length;

// ---------------------------------------------------------------------------
// The scan reads what it is meant to read
// ---------------------------------------------------------------------------

describe('the list catches what it names, and only that', () => {
  test('every entry catches its own word', () => {
    for (const r of REJECTED) {
      assert.ok(rejectedIn(`前面${r.word}后面`).some((x) => x.word === r.word), `${r.word} is not caught by its own pattern`);
    }
  });

  test('the ordinary words that contain a rejected one are left alone', () => {
    for (const fine of [
      '通用挑战成就', '挑选列表', '默认不出现在库存接口里', '没成功', '一字不差', '没有成就',
    ]) {
      assert.deepEqual(rejectedIn(fine).map((r) => r.word), [], `${fine} was flagged`);
    }
  });

  test('the word it replaces is not flagged', () => {
    for (const r of REJECTED) {
      for (const word of r.use.split(' / ')) {
        assert.deepEqual(rejectedIn(word).map((x) => x.word), [], `${word} (written instead of ${r.word}) is itself on the list`);
      }
    }
  });

  test('a comment is not scanned, and the line numbers survive taking it out', () => {
    const src = ['a', '// 没成', '/* 挑小节', '认不出 */', "'没法'"].join('\n');
    const kept = withoutComments(src).split('\n');
    assert.equal(kept.length, 5, 'lines were lost, so a hit would be reported on the wrong one');
    assert.deepEqual(kept.map((l) => rejectedIn(l).length), [0, 0, 0, 0, 1]);
  });
});

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

describe('the message tables', () => {
  const TABLES = {
    'lib/messages.js': [MESSAGES, 250],
    'lib/cli-messages.js': [CLI_MESSAGES, 30],
    'lib/tracker-messages.js': [TRACKER_MESSAGES, 350],
    'launcher/strings.js': [LAUNCHER_MESSAGES, 10],
  };

  for (const [file, [table, atLeast]] of Object.entries(TABLES)) {
    test(`${file} holds enough entries for a pass to mean something`, () => {
      assert.ok(Object.keys(table).length >= atLeast, `only ${Object.keys(table).length} entries were read from ${file}`);
      const zh = Object.values(table).map((v) => v[0]).join('');
      assert.ok(chineseChars(zh) > 100, `the Chinese half of ${file} came out nearly empty`);
    });

    test(`${file} uses none of the rejected words`, () => {
      const offenders = [];
      for (const [key, value] of Object.entries(table)) {
        for (const r of rejectedIn(String(value[0] ?? ''))) {
          offenders.push(`${file} · ${key}: 「${r.word}」 → ${r.use}`);
        }
      }
      assert.deepEqual(offenders, [], `rejected wording in a message table:\n  ${offenders.join('\n  ')}`);
    });
  }
});

// ---------------------------------------------------------------------------
// The files a reader sees directly
// ---------------------------------------------------------------------------

describe('the pages and scripts', () => {
  const FILES = [
    { file: 'Dashboard.html', enough: 1000 },
    { file: 'Setup.html', enough: 500 },
    { file: 'lib/rpc.js', enough: 20 },
    { file: 'tracker.js', enough: 0 },
    { file: 'README.zh.md', enough: 200, script: false },
  ];

  for (const { file, enough, script = true } of FILES) {
    test(`${file} uses none of the rejected words`, () => {
      const text = withoutComments(read(file), { script });
      assert.ok(text.length > 1000, `${file} came out nearly empty once its comments were taken out`);
      assert.ok(chineseChars(text) >= enough, `only ${chineseChars(text)} Chinese characters are left in ${file}, so the scan has little to look at`);

      const offenders = [];
      text.split('\n').forEach((line, i) => {
        for (const r of rejectedIn(line)) offenders.push(`${file}:${i + 1}: 「${r.word}」 → ${r.use}   ${line.trim().slice(0, 90)}`);
      });
      assert.deepEqual(offenders, [], `rejected wording in a file the reader sees:\n  ${offenders.join('\n  ')}`);
    });
  }
});
