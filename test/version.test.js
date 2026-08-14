/**
 * 版本号只有一个 —— 三处必须相等
 * ------------------------------------------------
 * 这个仓库里写着版本号的地方有三个:根 `package.json`、`launcher/package.json`、
 * 以及 `launcher/package-lock.json`(它自己写两遍)。**只有 launcher 那个有运行时
 * 读者** —— `app.getVersion()` 和 `postbuild.js` 都读它,zip 和清单的文件名由它拼,
 * tag 也必须等于它。另外两个没有任何代码会读。
 *
 * 没人读的号就是会漂的号,而漂了不出声:
 *
 * 1. **根的那个会被打包带走。** `extraResources` 把它复制成
 *    `resources/tracker/package.json`,那是用户在自己磁盘上**唯一**能读到
 *    「我这份 tracker 代码是哪一版」的地方。它错了不会报错,只会把一次排查带偏 ——
 *    2026-08-14 就发生过一次:一份 1.1.2 的 bug 报告,因为两个计数器看起来像两个
 *    独立的事实,多花了一轮才定位到「报告的人根本没在跑 1.1.2 的代码」。
 * 2. **锁文件那两处由 `npm install --package-lock-only` 补**,漏了这一步构建照样
 *    成功:zip 用一个号命名,锁文件里躺着另一个号,没有任何环节会红。
 *
 * 这三处以前是**故意**分成两个计数器的(tracker 2.x / app 1.x,理由见
 * `launcher/README.md` 的「Cutting a release」)。四个 release 下来两个号一直是
 * 同步 bump 的,第二个号从来没携带过信息,所以 2026-08-14 合并成一个。
 *
 * **这个文件够不着的那一半:git tag。** 测试看不见 tag,所以「tag 等于 launcher
 * 的版本号」仍然只能靠发布清单里那一步人工保证。这里能做的是保证**仓库内部**先自洽,
 * 这样清单上就只剩一个号要对。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const root = readJson('../package.json');
const launcher = readJson('../launcher/package.json');
const lock = readJson('../launcher/package-lock.json');

/**
 * 基准是 launcher 的 —— 不是随便挑的:它是唯一有运行时读者的那个,
 * 也是 zip 名、清单名和 tag 必须匹配的那个。另外两个是跟随者。
 */
const expected = launcher.version;

describe('版本号对齐', () => {
  test('launcher 的版本号是三段式,没有 v 前缀也没有空白', () => {
    // postbuild.js 拿它拼文件名(`SteamAchievementTracker-<version>-win.zip`),
    // 混进一个 `v` 或者尾随空格,产出的文件名就和 tag 对不上 —— 而这在构建时不报错。
    assert.match(
      expected,
      /^\d+\.\d+\.\d+$/,
      `launcher/package.json 的 version 是 ${JSON.stringify(expected)},应该是纯三段式`
    );
  });

  test('根 package.json 和 launcher 同号', () => {
    assert.equal(
      root.version,
      expected,
      `根 package.json 是 ${root.version},launcher 是 ${expected}。` +
        '两处必须相同 —— 根那份会被打包成 resources/tracker/package.json,' +
        '是用户能读到的唯一版本号。'
    );
  });

  test('锁文件顶层和 launcher 同号', () => {
    assert.equal(
      lock.version,
      expected,
      `launcher/package-lock.json 顶层是 ${lock.version},应为 ${expected}。` +
        '在 launcher/ 里跑 `npm install --package-lock-only`。'
    );
  });

  test('锁文件里根包条目和 launcher 同号', () => {
    // 锁文件把自己的版本号写两遍,`packages[""]` 是第二处。只对齐顶层
    // 会留下一个半修好的锁文件,而它同样不出声。
    assert.equal(
      lock.packages?.['']?.version,
      expected,
      `launcher/package-lock.json 的 packages[""] 是 ${lock.packages?.['']?.version},应为 ${expected}。` +
        '在 launcher/ 里跑 `npm install --package-lock-only`。'
    );
  });
});
