/**
 * 路径包含性:四处检查,一个判据
 * ------------------------------------------------------------------
 * 这个文件保的是一个**具体漏过的位**:`startsWith(root)` 不带分隔符时,
 * `…/guides-evil/x.md` 会被判成"在 `…/guides` 里面",因为前者确实以后者开头。
 * 前缀相同的**兄弟目录**是这类检查最经典的漏法,而这个项目里同一个问题
 * 有四个答案(见 `lib/pathsafe.js` 的表),其中两处漏掉了它。
 *
 * 所以这里测两层:判据本身,以及**四个调用方是不是真的都走了它** ——
 * 判据抽出来了而某一处仍旧自己写一遍,是这次修复唯一有意义的回归方式。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { isInside, containedPath } from '../lib/pathsafe.js';
import { resolveGuidePath } from '../lib/markdown.js';
import { parseArchiveId } from '../lib/guidearchive.js';

const R = (...p) => resolve(join(...p));

describe('isInside', () => {
  test('子文件和更深的子目录都算在里面', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides/x.md')), true);
    assert.equal(isInside(R('/a/guides'), R('/a/guides/sub/x.md')), true);
  });

  test('**前缀相同的兄弟目录不算** —— 这就是漏过的那一位', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides-evil/x.md')), false);
    assert.equal(isInside(R('/a/guides'), R('/a/guidesX')), false);
    assert.equal(isInside(R('/a/guides'), R('/a/guides.bak/x.md')), false);
  });

  test('往上跳出去的不算', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/x.md')), false);
    assert.equal(isInside(R('/a/guides'), R('/b/x.md')), false);
  });

  test('根自己不算在里面 —— 调用方要的都是"根底下的某个文件"', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides')), false);
  });

  test('`..` 先被规范化掉,绕回来的照样算在里面', () => {
    assert.equal(isInside(R('/a/guides'), R('/a/guides/sub/../x.md')), true);
  });
});

describe('containedPath', () => {
  test('正常的段拼出绝对路径', () => {
    assert.equal(containedPath(R('/a/guides'), 'x.md'), R('/a/guides/x.md'));
    assert.equal(containedPath(R('/a/guides'), 'sub', 'x.md'), R('/a/guides/sub/x.md'));
  });

  test('`..` 段返回 null', () => {
    assert.equal(containedPath(R('/a/guides'), '..', 'x.md'), null);
    assert.equal(containedPath(R('/a/guides'), '..', 'guides-evil', 'x.md'), null);
  });

  test('**某一段里藏着分隔符也返回 null** —— 那一段在偷偷改变路径结构', () => {
    assert.equal(containedPath(R('/a/guides'), `..${sep}..${sep}x.md`), null);
    assert.equal(containedPath(R('/a/guides'), '../x.md'), null);
  });

  test('段里带分隔符但没跑出去的,照样拒 —— 判据是"逐段拼"而不是"最后落在哪"', () => {
    // 结果确实还在 guides/ 里,但这一段声称自己是一个文件名而实际是两段。
    // 放行的话,"每一段都是文件名"这个前提就不成立了,而调用方全靠它
    assert.equal(containedPath(R('/a/guides'), `sub${sep}x.md`), null);
  });
});

// ---------------------------------------------------------------------------
// 四个调用方
// ---------------------------------------------------------------------------

describe('调用方都走同一个判据', () => {
  /** 造一个真目录:guides/ 和它的兄弟 guides-evil/ */
  const build = () => {
    const base = mkdtempSync(join(tmpdir(), 'sat-pathsafe-'));
    mkdirSync(join(base, 'guides'), { recursive: true });
    mkdirSync(join(base, 'guides-evil'), { recursive: true });
    writeFileSync(join(base, 'guides', 'ok.md'), '# 正常\n');
    writeFileSync(join(base, 'guides-evil', 'secret.md'), '机密\n');
    return base;
  };

  test('resolveGuidePath:正常的相对路径读得到', () => {
    const base = build();
    try {
      assert.equal(resolveGuidePath(join(base, 'guides'), 'ok.md'), R(base, 'guides', 'ok.md'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('**resolveGuidePath:兄弟目录要抛,不能读出来**', () => {
    const base = build();
    try {
      assert.throws(
        () => resolveGuidePath(join(base, 'guides'), join('..', 'guides-evil', 'secret.md')),
        /越出了 guides 目录/,
        'guides-evil/ 被当成 guides/ 的一部分读出来了'
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('resolveGuidePath:绝对路径也要过同一道检查', () => {
    const base = build();
    try {
      assert.throws(
        () => resolveGuidePath(join(base, 'guides'), join(base, 'guides-evil', 'secret.md')),
        /越出了 guides 目录/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('parseArchiveId:合法编号解得出来', () => {
    const config = { guidesDir: R('/a/guides') };
    const r = parseArchiveId(config, '.backups/730-20260820-122121.md');
    assert.equal(r.dir, '.backups');
    assert.equal(r.file, '730-20260820-122121.md');
  });

  test('parseArchiveId:目录不在那三个里面就拒', () => {
    assert.throws(() => parseArchiveId({ guidesDir: R('/a/guides') }, '.evil/x.md'), /目录不认识/);
  });

  test('parseArchiveId:文件名带分隔符就拒 —— 编号是浏览器传上来的字符串', () => {
    const config = { guidesDir: R('/a/guides') };
    assert.throws(() => parseArchiveId(config, '.backups/../x.md'), /不合法|越界/);
    assert.throws(() => parseArchiveId(config, `.backups/..${sep}..${sep}x.md`), /不合法|越界/);
  });

  /**
   * **判据必须只有一份。** 抽出来之后最可能的回归不是判据写错,
   * 是某一处没改过来、继续用自己那份 —— 而那种回归一个测试都不会红,
   * 因为每一处自己的测试都还在过。所以这里直接查源码。
   */
  test('没有哪个文件还在自己写 `startsWith(root)` 那种包含性检查', async () => {
    const { readFileSync } = await import('node:fs');
    const files = ['lib/markdown.js', 'lib/backup.js', 'lib/guidearchive.js', 'lib/server.js'];
    for (const f of files) {
      const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
        .replace(/^\s*\/\/.*$/gm, '')       // 行注释 —— 注释里提到这个写法是允许的
        .replace(/^\s*\*.*$/gm, '');        // JSDoc 续行
      assert.doesNotMatch(
        src, /startsWith\(\s*(?:root|base|resolve\()/,
        `${f} 里还有一份自己写的包含性检查,判据又变成两份了`
      );
    }
  });
});
