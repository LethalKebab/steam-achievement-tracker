/**
 * 自更新
 * ------------------------------------------------
 * 这个文件保的是**一次坏掉就没法补救**的那部分。更新器的特殊之处在于:出问题的
 * 那一版已经装到用户机器上了,而修好的那一版要靠坏掉的更新器送过去。
 *
 * 按 docs/self-update.md 第五节分两半:
 *
 * - **可单测的**:清单生成、版本比对、sha256 校验、跳过版本的记忆。都在
 *   `launcher/updater.js` 里,那个文件故意不 import electron,所以能直接加载。
 * - **不可单测的**:真正的文件替换。靠排练(让它指向 v1.1.2 做一次「降级」)。
 *   这里能做的是把生成出来的 PowerShell **拿去解析一遍**,以及断言那段脚本的
 *   结构没有违反三条约束 —— 脚本是在一个 detached、没有控制台的进程里跑的,
 *   语法错了不会有任何人看到,表现只是"程序自己退了,再也没起来"。
 *
 * `launcher/main.js` 要 Electron 才能加载,所以那半只能用**源码断言**,和
 * `test/tray.test.js` 同源。
 *
 * ⚠️ 源码断言必须先去注释再匹配 —— 这个仓库注释密度很高,不去注释的话断言会被
 * 自己旁边的注释满足。tray.test.js 里那条就真的空跑过。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANIFEST_NAME,
  STATE_NAME,
  buildManifest,
  compareVersions,
  downloadVerified,
  hashFile,
  isSafeManifestPath,
  parseManifest,
  pickAssets,
  readUpdateState,
  renderHelperScript,
  sha256FromDigest,
  shouldOffer,
  writeHelperScript,
  writeUpdateState,
} from '../launcher/updater.js';

// --- 源码断言的两个工具。和 tray.test.js 里的同一份,理由见那边的长注释 ---

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

const mainSrc = stripComments(readFileSync(new URL('../launcher/main.js', import.meta.url), 'utf8'));
const postbuildSrc = stripComments(
  readFileSync(new URL('../launcher/postbuild.js', import.meta.url), 'utf8')
);

/** 从 needle 起按大括号配平截出整块 —— 固定长度切片会随上下文增删而错位 */
function blockFrom(src, needle, label = needle) {
  const start = src.indexOf(needle);
  assert.ok(start > 0, `找不到 ${label} —— 这条检查失去了目标,不是通过了`);
  const open = src.indexOf('{', start);
  assert.ok(open > start, `${label} 后面没有代码块`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${label} 的代码块没有闭合`);
}

/** await fn 之后才清理 —— 少了这个 await,异步用例的临时目录会在断言跑完之前就没了 */
async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfupdate-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 版本比对

describe('版本比对', () => {
  test('按数字段比,不是按字符串比', () => {
    // 字符串比较下 '1.1.9' > '1.2.0',于是 1.2.0 发出去没人收得到,
    // 而且不会有任何报错 —— 只是永远没有人升级
    assert.ok(compareVersions('1.2.0', '1.1.9') > 0, '1.2.0 必须比 1.1.9 新');
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0, '1.10.0 必须比 1.9.0 新');
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.equal(compareVersions('1.1.3', '1.1.3'), 0);
  });

  test('tag 的 v 前缀两边都容忍', () => {
    // 一边是 release 的 tag_name(v1.1.3),一边是 app.getVersion()(1.1.3)
    assert.equal(compareVersions('v1.1.3', '1.1.3'), 0);
    assert.ok(compareVersions('v1.1.4', 'v1.1.3') > 0);
  });

  test('段数不齐按 0 补', () => {
    assert.equal(compareVersions('1.1', '1.1.0'), 0);
    assert.ok(compareVersions('1.1.1', '1.1') > 0);
  });

  test('同版本和更老的版本都不弹', () => {
    const now = '1.1.3';
    assert.equal(shouldOffer({ currentVersion: now, remoteVersion: '1.1.3' }), false);
    // 老版本被重新发布 / latest 指回去了,不该把用户降级
    assert.equal(shouldOffer({ currentVersion: now, remoteVersion: '1.1.2' }), false);
    assert.equal(shouldOffer({ currentVersion: now, remoteVersion: '1.1.4' }), true);
  });

  test('tag_name 缺失时不弹', () => {
    assert.equal(shouldOffer({ currentVersion: '1.1.3', remoteVersion: '' }), false);
  });
});

// ================================================================ 跳过版本的记忆

describe('跳过版本的记忆', () => {
  test('跳过之后同一个版本不再弹,更新的版本照弹', () => {
    // 设计文档三个死细节之一。不记的话每次开都弹一遍,两天就被训练成无视
    const base = { currentVersion: '1.1.3', skippedVersion: '1.2.0' };
    assert.equal(shouldOffer({ ...base, remoteVersion: '1.2.0' }), false, '跳过的版本又弹了');
    assert.equal(
      shouldOffer({ ...base, remoteVersion: '1.2.1' }),
      true,
      '跳过 1.2.0 不该连 1.2.1 一起吃掉 —— 那等于永久关闭了更新'
    );
  });

  test('写了能读回来', () =>
    withTempDir((dir) => {
      const p = join(dir, STATE_NAME);
      assert.equal(writeUpdateState(p, { skippedVersion: '1.2.0' }), true);
      assert.deepEqual(readUpdateState(p), { skippedVersion: '1.2.0' });
    }));

  test('文件不存在 / 内容坏掉都当作没跳过,不能抛', () =>
    withTempDir((dir) => {
      // 抛出去的话第一次运行(还没有这个文件)就炸在检查更新里
      assert.deepEqual(readUpdateState(join(dir, 'nope.json')), { skippedVersion: null });

      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{ 这不是 json');
      assert.deepEqual(readUpdateState(broken), { skippedVersion: null });

      const wrongShape = join(dir, 'shape.json');
      writeFileSync(wrongShape, '{"skippedVersion": 17}');
      assert.deepEqual(readUpdateState(wrongShape), { skippedVersion: null });
    }));

  test('写不进去返回 false,不能抛', () =>
    withTempDir((dir) => {
      // app 目录只读(比如解压到 Program Files)时会走到这里。
      // 记不住跳过是小事,为此弹一个错误框才是大事
      const path = join(dir, 'no-such-dir', 'state.json');
      assert.doesNotThrow(() => writeUpdateState(path, { skippedVersion: '1.2.0' }));
      assert.equal(writeUpdateState(path, { skippedVersion: '1.2.0' }), false);
    }));
});

// ================================================================ sha256 校验

describe('sha256 校验', () => {
  const hex = 'a'.repeat(64);

  test('认得 GitHub 的 digest 格式', () => {
    assert.equal(sha256FromDigest(`sha256:${hex}`), hex);
    assert.equal(sha256FromDigest(`SHA256:${hex.toUpperCase()}`), hex);
  });

  test('认不出来一律返回 null', () => {
    assert.equal(sha256FromDigest(null), null);
    assert.equal(sha256FromDigest(undefined), null);
    assert.equal(sha256FromDigest(''), null);
    assert.equal(sha256FromDigest(`md5:${'a'.repeat(32)}`), null, 'md5 不该被当成 sha256');
    assert.equal(sha256FromDigest(`sha256:${'a'.repeat(63)}`), null, '长度不对就是不对');
    assert.equal(sha256FromDigest(`sha256:${'z'.repeat(64)}`), null, '非 hex 字符');
  });

  test('算出来的和 crypto 一致', async () =>
    withTempDir(async (dir) => {
      const p = join(dir, 'blob.bin');
      const payload = Buffer.from('成就追踪器'.repeat(1000));
      writeFileSync(p, payload);
      assert.equal(await hashFile(p), createHash('sha256').update(payload).digest('hex'));
    }));

  test('没有 digest 必须拒绝安装,而不是跳过校验', async () =>
    withTempDir(async (dir) => {
      // 最重要的一条。"验不了就不验"意味着让用户执行一份没验过的 133MB 可执行
      // 文件;宁可更新不了。而且这个退化不会有任何征兆——更新照样"成功"
      let fetched = false;
      const asset = { name: 'x-win.zip', browser_download_url: 'https://example/x', digest: null };
      await assert.rejects(
        () =>
          downloadVerified(asset, join(dir, 'x.zip'), {
            fetchImpl: async () => {
              fetched = true;
              return new Response(Buffer.from('whatever'));
            },
          }),
        /没有可用的 sha256/
      );
      assert.equal(fetched, false, '连下载都不该开始');
    }));

  test('内容对得上就通过,对不上就拒绝', async () =>
    withTempDir(async (dir) => {
      const payload = Buffer.from('真正的安装包');
      const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
      const fetchImpl = async () => new Response(payload);

      const good = { name: 'ok-win.zip', browser_download_url: 'https://example/ok', digest };
      await downloadVerified(good, join(dir, 'ok.zip'), { fetchImpl });
      assert.deepEqual(readFileSync(join(dir, 'ok.zip')), payload);

      const tampered = {
        name: 'bad-win.zip',
        browser_download_url: 'https://example/bad',
        digest: `sha256:${'0'.repeat(64)}`,
      };
      await assert.rejects(
        () => downloadVerified(tampered, join(dir, 'bad.zip'), { fetchImpl }),
        /校验不通过/
      );
    }));

  test('校验不过的半截文件要删掉', async () =>
    withTempDir(async (dir) => {
      // 这里下的是 133MB。反复失败会在 temp 里堆出几百兆,而一个校验不过的包
      // 留在磁盘上没有任何用处
      const dest = join(dir, 'bad.zip');
      await assert.rejects(() =>
        downloadVerified(
          { name: 'bad-win.zip', browser_download_url: 'https://x/bad', digest: `sha256:${'0'.repeat(64)}` },
          dest,
          { fetchImpl: async () => new Response(Buffer.from('垃圾')) }
        )
      );
      assert.equal(existsSync(dest), false, '校验失败的文件被留在了磁盘上');
    }));
});

// ================================================================ 发布附件

describe('发布附件的挑选', () => {
  const assets = [
    { name: 'SteamAchievementTracker-1.1.4-win.zip' },
    { name: 'SteamAchievementTracker-1.1.4-manifest.json' },
    { name: 'source.tar.gz' },
  ];

  test('挑得出 zip 和清单', () => {
    const { zip, manifest } = pickAssets(assets);
    assert.equal(zip.name, 'SteamAchievementTracker-1.1.4-win.zip');
    assert.equal(manifest.name, 'SteamAchievementTracker-1.1.4-manifest.json');
  });

  test('老发布没有清单,不算错', () => {
    // 1.1.3 及以前发布的包里就没有清单。那种情况照常更新,只是做完之后
    // app 目录里不留清单,下一次再走一遍覆盖
    const { zip, manifest } = pickAssets([{ name: 'SteamAchievementTracker-1.1.3-win.zip' }]);
    assert.ok(zip);
    assert.equal(manifest, null);
  });

  test('附件为空不抛', () => {
    assert.deepEqual(pickAssets(), { zip: null, manifest: null });
    assert.deepEqual(pickAssets([]), { zip: null, manifest: null });
  });
});

// ================================================================ 清单生成

describe('清单生成', () => {
  const makeTree = (root) => {
    mkdirSync(join(root, 'locales'), { recursive: true });
    mkdirSync(join(root, 'resources', 'tracker', 'lib'), { recursive: true });
    writeFileSync(join(root, 'App.exe'), 'exe');
    writeFileSync(join(root, 'locales', 'zh-CN.pak'), 'pak');
    writeFileSync(join(root, 'resources', 'tracker', 'tracker.js'), 'js');
    writeFileSync(join(root, 'resources', 'tracker', 'lib', 'db.js'), 'js');
  };

  test('列出全部文件,相对路径,正斜杠', () =>
    withTempDir((dir) => {
      makeTree(dir);
      const { files } = buildManifest(dir, '1.1.4');
      assert.deepEqual(files, [
        'App.exe',
        'locales/zh-CN.pak',
        'resources/tracker/lib/db.js',
        'resources/tracker/tracker.js',
      ]);
    }));

  test('只收文件,不收目录', () =>
    withTempDir((dir) => {
      // 目录进了清单,删除阶段就有机会删掉一个**非空**目录 ——
      // 而 resources/tracker/data/ 里躺着用户的数据库
      makeTree(dir);
      const { files } = buildManifest(dir, '1.1.4');
      assert.equal(files.includes('locales'), false);
      assert.equal(files.includes('resources'), false);
      assert.equal(files.includes('resources/tracker'), false);
    }));

  test('清单里带版本号', () =>
    withTempDir((dir) => {
      makeTree(dir);
      assert.equal(buildManifest(dir, '1.1.4').version, '1.1.4');
    }));

  test('生成出来的清单能被自己解析', () =>
    withTempDir((dir) => {
      makeTree(dir);
      const m = buildManifest(dir, '1.1.4');
      assert.deepEqual(parseManifest(JSON.stringify(m)), m);
    }));

  test('用户数据不在包里,所以天然不进清单', () =>
    withTempDir((dir) => {
      // 安全是构造出来的,不是过滤出来的:清单照着解包目录生成,而
      // config.json / data/ 从来就不在解包目录里(extraResources 是白名单)
      makeTree(dir);
      const { files } = buildManifest(dir, '1.1.4');
      assert.equal(
        files.some((f) => /config\.json|steam\.db|\bdata\//.test(f)),
        false
      );
    }));
});

// ================================================================ 清单校验

describe('清单路径校验', () => {
  test('正常的相对路径放行', () => {
    for (const p of ['App.exe', 'locales/zh-CN.pak', 'resources/tracker/lib/db.js']) {
      assert.equal(isSafeManifestPath(p), true, `${p} 被误判为不安全`);
    }
  });

  test('越界的一律拒绝', () => {
    // 清单是从网上下来的,而它唯一的用途是喂给一个删除循环
    for (const p of [
      '../outside.txt',
      'a/../../outside.txt',
      '/etc/passwd',
      '\\\\server\\share\\x',
      'C:\\Windows\\System32\\x.dll',
      './x',
      '',
      'a//b',
      'a\0b',
    ]) {
      assert.equal(isSafeManifestPath(p), false, `${JSON.stringify(p)} 应该被拒绝`);
    }
  });

  test('非字符串一律拒绝', () => {
    for (const p of [null, undefined, 17, {}, []]) {
      assert.equal(isSafeManifestPath(p), false);
    }
  });

  test('一条越界路径就整份拒收', () => {
    // 逐条过滤是错的:一份带越界路径的清单本身就说明它不是我们发的,
    // 剩下的部分同样不可信
    assert.throws(
      () => parseManifest(JSON.stringify({ version: '1.1.4', files: ['ok.txt', '../evil'] })),
      /越界路径/
    );
  });

  test('形状不对的清单直接抛', () => {
    assert.throws(() => parseManifest('不是 json'), /合法的 JSON/);
    assert.throws(() => parseManifest('{}'), /没有文件列表/);
    assert.throws(() => parseManifest('{"files": []}'), /没有文件列表/);
    assert.throws(() => parseManifest('{"files": "a.txt"}'), /没有文件列表/);
  });
});

// ================================================================ helper 脚本

describe('helper 脚本 —— 三条约束', () => {
  const render = (over = {}) =>
    renderHelperScript({
      processId: 4242,
      appDir: 'D:\\App',
      exePath: 'D:\\App\\X.exe',
      zipPath: 'C:\\tmp\\new.zip',
      manifestPath: `D:\\App\\${MANIFEST_NAME}`,
      newManifestPath: 'C:\\tmp\\new-manifest.json',
      logPath: 'C:\\tmp\\update.log',
      ...over,
    });

  test('约束 1:按清单删,不是按保留名单', () => {
    const s = render();
    assert.match(s, /foreach \(\$rel in \$entries\)/, '没有遍历清单 —— 删除依据变了');
    assert.match(s, /\.files/, '没有从清单里取文件列表');
    // 「先清空文件夹再解压」正是要避免的写法。这些形状出现任何一个,
    // 删的就不再是"上一版装了什么"
    assert.doesNotMatch(
      s,
      /Remove-Item[^\n]*\$AppDir\s*(\)|$|\s-)/m,
      '出现了对整个 AppDir 的删除 —— 那会删掉用户的数据库'
    );
    assert.doesNotMatch(s, /\$AppDir\\\*/, '出现了 $AppDir\\* 通配删除');
    assert.doesNotMatch(s, /-Exclude/i, '出现了 -Exclude —— 那就是保留名单,方向反了');
  });

  test('约束 1:只删文件,而且要先验证路径没越界', () => {
    // **必须切到删除循环里再匹配。** 整份脚本上找 `-PathType Leaf` 是空跑的:
    // 「清单在不在」那个判断上也带着同一个参数,于是把删除循环里的保护摘掉,
    // 断言照样通过。变异验证抓到的,读代码读不出来 —— 和 tray.test.js 里
    // 被注释满足的那条同一类错误,只是换了个伪装
    const s = render();
    const loop = s.slice(s.indexOf('foreach ($rel in $entries)'), s.indexOf('Log "按清单删除'));
    assert.ok(loop.length > 0, '找不到删除循环 —— 这条检查失去了目标');
    assert.match(loop, /-PathType Leaf/, '删除循环里没有 -PathType Leaf —— 目录也可能被删');
    assert.match(loop, /StartsWith\(\$AppDirFull/, '删除循环里没有边界检查');
  });

  test('约束 1:目录只在空的时候才删', () => {
    // resources/tracker/data/ 里有数据库,永远不空 —— 「只删空目录」
    // 就是这里全部的安全边界
    const s = render();
    const prune = s.slice(s.indexOf('-Recurse -Directory'));
    assert.match(
      prune.slice(0, 400),
      /if \(-not \(Get-ChildItem/,
      '删目录之前没有判空 —— 非空目录会被连内容一起删掉'
    );
  });

  test('约束 2:没有清单就退回覆盖,不猜', () => {
    const s = render();
    const guard = s.indexOf('if (Test-Path -LiteralPath $Manifest -PathType Leaf)');
    const loop = s.indexOf('foreach ($rel in $entries)');
    const extract = s.indexOf('Expand-Archive');
    assert.ok(guard > 0, '没有"清单在不在"的判断');
    assert.ok(guard < loop && loop < extract, '删除循环必须被清单存在性判断包住');

    // else 分支里绝不能有任何删除动作
    const elseBranch = s.slice(s.indexOf('} else {', loop), extract);
    assert.doesNotMatch(elseBranch, /Remove-Item/, '没有清单时仍在删东西 —— 那就是在猜');
  });

  test('删除必须排在解压之前', () => {
    // 这是"删多了无害"的全部理由:解压会把程序文件补回来。
    // 反过来的话,新装的文件会被按旧清单删掉,升级完就是个残包
    const s = render();
    assert.ok(
      s.indexOf('foreach ($rel in $entries)') < s.indexOf('Expand-Archive'),
      '解压排到了删除前面 —— 新文件会被旧清单删掉'
    );
  });

  test('约束 3:动手之前必须等进程退出', () => {
    const s = render();
    const wait = s.indexOf('Wait-Process');
    assert.ok(wait > 0, '没有等待主进程退出 —— Windows 会拒绝替换正在运行的 exe');
    assert.ok(wait < s.indexOf('foreach ($rel in $entries)'), '等待必须排在删除之前');
    assert.ok(wait < s.indexOf('Expand-Archive'), '等待必须排在解压之前');
    assert.match(s, /\$ProcessId\s+= 4242/, 'PID 没有传进脚本');
    assert.doesNotMatch(s, /\$Pid\s*=/i, '$Pid 是 PowerShell 的只读自动变量,不能赋值');
  });

  test('装完要写新清单;这次发布没带清单就把旧的清掉', () => {
    const withManifest = render();
    assert.match(withManifest, /Copy-Item -LiteralPath \$NewManifest/, '没有写入新清单');

    const without = render({ newManifestPath: '' });
    assert.match(without, /\$NewManifest = ''/, '空清单路径没有正确落进脚本');
    // 留着一份描述错版本的清单不会造成破坏(删在解压之前),但会把排查引向错误方向
    assert.match(without, /Remove-Item -LiteralPath \$Manifest/, '没有清掉过期的旧清单');
  });

  test('路径里的单引号被正确转义', () => {
    // 转义漏了的话脚本会在一个没有控制台的 detached 进程里语法错误,
    // 表现是"程序自己退了,再也没起来",没有任何提示
    const s = render({ appDir: "D:\\it's here" });
    assert.match(s, /\$AppDir\s+= 'D:\\it''s here'/);
  });

  test('失败了要说话,并尽量把老程序拉起来', () => {
    const s = render();
    assert.match(s, /MessageBox/, '失败时静默 —— 用户面对的是一个自己退掉又没起来的程序');
    // 从外层 catch 的第一行日志切起。用 lastIndexOf('} catch {') 会切到
    // 里面那个空 catch,断言就变成了对着两行代码做匹配
    const catchBlock = s.slice(s.indexOf('Log "失败'));
    assert.match(catchBlock, /Start-Process -FilePath \$ExePath/, '失败后没有尝试重新拉起');
  });

  test('脚本以 BOM 存盘', () =>
    withTempDir((dir) => {
      // PowerShell 5.1 没有 BOM 时按 ANSI 代码页读 .ps1。中文路径和中文提示
      // 会全变成问号,而路径变成问号就是找不到文件
      const p = join(dir, 'apply.ps1');
      writeHelperScript(p, render());
      assert.deepEqual([...readFileSync(p).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    }));

  test(
    '生成出来的是合法的 PowerShell',
    { skip: process.platform !== 'win32' ? '只在 Windows 上验' : false },
    () =>
      withTempDir((dir) => {
        // 这条是这个文件里唯一"真的跑了一下"的检查。模板字符串里同时有
        // JS 的 \\ 和 ` 与 PowerShell 的 \ 和 `,转义弄错一处就是语法错误 ——
        // 而那个错误发生在一个没有控制台的进程里,不会有任何人看到
        const p = join(dir, 'apply.ps1');
        writeHelperScript(p, render({ appDir: 'D:\\有中文的 路径' }));
        const probe = join(dir, 'probe.ps1');
        writeFileSync(
          probe,
          '\ufeff$e = $null\n' +
            `$null = [System.Management.Automation.Language.Parser]::ParseFile('${p.replace(/'/g, "''")}', [ref]$null, [ref]$e)\n` +
            'if ($e -and $e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 } else { exit 0 }\n',
          'utf8'
        );
        const out = execFileSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
          { encoding: 'utf8' }
        );
        assert.equal(out.trim(), '', `生成的 PowerShell 解析失败:${out}`);
      })
  );
});

// ================================================================ 接线(源码断言)

describe('main.js 的接线', () => {
  const checkBlock = () => blockFrom(mainSrc, 'async function checkForUpdate');

  test('检查失败必须静默', () => {
    // 离线是常态。没网就弹错误框的话,这个功能会先把自己变成一个每天骚扰
    // 用户一次的东西,然后被关掉
    const body = checkBlock();
    const fetchCatch = body.slice(body.indexOf('await fetchRelease'), body.indexOf('tag_name'));
    assert.match(fetchCatch, /catch/, '检查更新没有被 try 包住 —— 离线会抛到未捕获');
    assert.doesNotMatch(fetchCatch, /showErrorBox|showMessageBox/, '检查失败弹了框');
  });

  test('校验通过之前不能退出', () => {
    // 顺序反了就是:程序先退了,然后发现下载的是坏文件 —— 用户面对的是
    // 一个凭空关掉的程序
    const body = checkBlock();
    assert.ok(
      body.indexOf('downloadVerified') < body.indexOf('app.quit()'),
      '先退出再校验 —— 校验失败时用户已经没有程序可用了'
    );
    assert.match(body, /downloadVerified/, '下载没有走校验路径');
  });

  test('helper 必须 detached 且 unref,并且启动后才退出', () => {
    const body = checkBlock();
    assert.match(body, /detached: true/, 'helper 没有 detached —— 会跟着我们一起死');
    assert.match(body, /\.unref\(\)/, '没有 unref');
    const spawnAt = body.indexOf('spawn(');
    const quitAt = body.indexOf('app.quit()');
    assert.ok(spawnAt > 0 && quitAt > spawnAt, 'helper 必须在 app.quit() 之前启动');
  });

  test('helper 收到的是我们自己的 PID', () => {
    // 传错的话 Wait-Process 立刻返回,替换发生在 exe 还锁着的时候
    assert.match(checkBlock(), /processId: process\.pid/, 'PID 不是当前进程的');
  });

  test('跳过的版本真的写盘', () => {
    const body = checkBlock();
    const dismissed = body.slice(body.indexOf('if (response !== 0)'));
    assert.match(
      dismissed.slice(0, 300),
      /writeUpdateState/,
      '勾了"不再提示这个版本"却没有落盘 —— 下次开机照弹'
    );
  });

  test('不是只在启动时查一次', () => {
    // 收进托盘之后"启动"变成很稀少的事件。只查一次的话,一个连着开几天的
    // 用户永远收不到更新提示,而且完全不报错
    const body = blockFrom(mainSrc, 'function scheduleUpdateCheck');
    assert.match(body, /scheduleUpdateCheck\(UPDATE_CHECK_INTERVAL_MS\)/, '定时器没有自己续上');
    assert.match(mainSrc, /UPDATE_CHECK_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/, '检查周期不是一天');
  });

  test('定时器在退出时清掉', () => {
    assert.match(
      blockFrom(mainSrc, "app.on('before-quit'"),
      /clearTimeout\(updateTimer\)/,
      'before-quit 没有清掉更新定时器'
    );
  });

  test('dev 模式不查', () => {
    // npm start 下根本没有可替换的 zip 目录
    assert.match(checkBlock(), /!app\.isPackaged/, 'dev 模式也会去检查更新');
  });

  test('对话框不挂在 mainWindow 上', () => {
    // 此刻窗口多半正藏在托盘里,挂上去就是一个看不见的模态框 ——
    // 而模态框看不见的表现是"程序卡住了"
    const body = checkBlock();
    assert.match(body, /dialog\.showMessageBox\(\{/, '对话框挂到了某个窗口上');
  });

  test('能整个关掉', () => {
    // 设计文档三个死细节之一
    assert.match(mainSrc, /function autoUpdateEnabled/, '没有关掉自动更新的开关');
    assert.match(
      blockFrom(mainSrc, 'app.whenReady()'),
      /autoUpdateEnabled\(\)/,
      '开关没有接到实际的调度上'
    );
  });
});

describe('打包与发布', () => {
  test('updater.js 必须进 build.files', () => {
    // 漏掉只有**打包版**坏掉:npm start 一切正常,发出去的包一启动就是
    // 模块找不到。和 icon.ico 那条同一类
    const pkg = JSON.parse(
      readFileSync(new URL('../launcher/package.json', import.meta.url), 'utf8')
    );
    assert.ok(pkg.build.files.includes('updater.js'), 'build.files 里没有 updater.js');
    assert.ok(pkg.build.files.includes('main.js'));
  });

  test('postbuild 先生成清单,再复制 local.config.json', () => {
    // 顺序反了,那份本机配置就会进清单,下次更新时被当作程序文件删掉 ——
    // 用户的数据目录会静默地跳回默认位置,看起来像"数据全没了"
    const manifestAt = postbuildSrc.indexOf('buildManifest(');
    const copyAt = postbuildSrc.indexOf('copyFileSync(localCfg');
    assert.ok(manifestAt > 0, 'postbuild 没有生成清单');
    assert.ok(copyAt > 0, 'postbuild 不再复制 local.config.json 了?');
    assert.ok(manifestAt < copyAt, '清单生成排到了复制 local.config.json 之后');
  });

  test('postbuild 显式挡住 local.config.json 进清单', () => {
    assert.match(
      postbuildSrc,
      /local\.config\.json'\)\)\)?\s*\{[\s\S]{0,400}?process\.exit\(1\)/,
      'postbuild 没有对清单里出现 local.config.json 报错'
    );
  });

  test('清单文件名带版本号,和 zip 一致', () => {
    assert.match(
      postbuildSrc,
      /\$\{PRODUCT\}-\$\{version\}-manifest\.json/,
      '清单文件名不带版本 —— 发布页上会分不清是哪一版的'
    );
  });
});
