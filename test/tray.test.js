/**
 * 托盘常驻 + 窗口显示时的新鲜度同步
 * ------------------------------------------------
 * 这个文件保的是四件**坏掉不出声**的事:
 *
 * 1. 关窗口又变回退出 —— 功能整个白做,而且看起来"正常"(以前就是这个行为)。
 * 2. 退不掉 —— close 里 preventDefault 没给退出让路,托盘的「退出」按了没反应,
 *    用户只能去任务管理器。
 * 3. 每次切回窗口都全量同步一遍 —— `maybeSync` 要是退化成 `startSync` 的别名,
 *    新鲜度闸门就没了。这个不会报错,只会让 Steam 请求量悄悄翻几十倍。
 * 4. 双击第二次 exe 弹一个假的「后台服务意外退出」—— 这一条是前三条的直接后果:
 *    程序常驻在托盘里,所以"再点一次图标"从稀有事件变成了日常动作。
 *
 * `launcher/main.js` 要 Electron 才能加载,单测够不着,所以那部分是**源码断言**,
 * 和 `guidequeue.test.js` 里 drainNext 那条同源。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApi } from '../lib/api.js';

/**
 * 匹配之前先去掉注释。
 *
 * **不这样做的话断言会被自己的注释满足。** 这不是假设:第一版里
 * 「server.js 有没有注入 maybeAutoSync」那条是空跑的 —— 注入行旁边的注释里
 * 出现了 `maybeAutoSync` 这个词,把真正的代码删掉,断言照样通过。变异验证
 * 抓到的,读代码读不出来。这个仓库注释密度很高,所以这是通例不是特例。
 *
 * `[^:]` 那一段是为了不误伤 `http://` —— 协议里的双斜杠不是注释,而且那些行上
 * 常带 `${...}`,连着删掉会把大括号配平也搞坏。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

const mainSrc = stripComments(readFileSync(new URL('../launcher/main.js', import.meta.url), 'utf8'));
const serverSrc = stripComments(readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8'));

/**
 * 从 `needle` 起按大括号配平截出整块。
 *
 * 固定长度切片(`slice(start, start + 2600)`)会随着上下文增删而错位,而错位的
 * 后果是断言变成对着半截代码做匹配 —— 可能恒真,也可能恒假,两种都不是在测东西。
 */
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

describe('窗口生命周期 —— 关掉不等于退出', () => {
  test('window-all-closed 不能再退出程序', () => {
    // 这是整个功能的开关。这里恢复成 app.quit(),后台常驻就没了,
    // 而表现是"一切正常"——因为那正是改动之前的行为
    const body = blockFrom(mainSrc, "app.on('window-all-closed'");
    assert.doesNotMatch(body, /app\.quit\(\)/,
      'window-all-closed 又去退出了 —— 托盘常驻被撤销,且不会有任何报错');
  });

  test('close 必须给真正的退出让路', () => {
    const body = blockFrom(mainSrc, "mainWindow.on('close'");
    assert.match(body, /isQuitting/,
      'close 里没有 isQuitting 的放行分支 —— preventDefault 会让程序永远退不掉');
    assert.match(body, /preventDefault/, '没有拦下关闭,窗口会真的被销毁');
    assert.match(body, /hide\(\)/, '拦下了却没有隐藏,窗口会卡在原地关不掉');
  });

  test('before-quit 必须先置 isQuitting,再 kill 子进程', () => {
    // 顺序反过来:子进程的 exit 监听看到 isQuitting 还是 false,
    // 于是每一次正常退出都先弹一个「后台服务意外退出」的错误框
    const body = blockFrom(mainSrc, "app.on('before-quit'");
    const flag = body.indexOf('isQuitting');
    const kill = body.indexOf('.kill()');
    assert.ok(flag > 0, 'before-quit 没有置 isQuitting');
    assert.ok(kill > 0, 'before-quit 没有关掉子进程 —— 服务器会变成孤儿进程留在后台');
    assert.ok(flag < kill,
      '顺序反了:kill 在置位之前,每次正常退出都会弹一个假的「意外退出」错误框');
  });
});

describe('托盘 —— 关窗口之后唯一的出口', () => {
  const trayBlock = () => blockFrom(mainSrc, 'function createTray');

  test('菜单里必须有「退出」,且真的调 app.quit', () => {
    const body = trayBlock();
    assert.match(body, /label: '退出'/, '托盘菜单没有退出项 —— 用户只剩任务管理器');
    assert.match(body, /app\.quit\(\)/, '有退出项但没接上 app.quit');
  });

  test('图标为空必须说出来,不能静默', () => {
    // 空 nativeImage 在托盘里是**看不见的图标**。配合"关窗口不退出",
    // 结果是一个既看不见又关不掉的程序
    assert.match(trayBlock(), /isEmpty\(\)/,
      '没检查空图标 —— 图标加载失败会得到一个看不见也退不掉的程序');
  });

  test('托盘要在窗口之前建好', () => {
    // 关窗口时要用 tray 发气泡提示;顺序反了,第一次关窗口那条提示就丢了
    const ready = blockFrom(mainSrc, 'app.whenReady()');
    const tray = ready.indexOf('createTray');
    const win = ready.indexOf('createWindow');
    assert.ok(tray > 0 && win > 0, 'whenReady 里少了 createTray 或 createWindow');
    assert.ok(tray < win, 'createTray 必须排在 createWindow 前面');
  });
});

describe('单实例 —— 第二次双击 exe 不能变成一个错误框', () => {
  test('拿不到锁的那一支只许退出,不许起任何东西', () => {
    // 起了就白防了:那份子进程照样撞 EADDRINUSE 秒退,假的「意外退出」框原样回来
    const body = blockFrom(mainSrc, 'if (!app.requestSingleInstanceLock())');
    assert.match(body, /app\.quit\(\)/, '第二个实例没有退出 —— 它会一直挂在那儿');
    for (const forbidden of ['startServer', 'createTray', 'createWindow']) {
      assert.doesNotMatch(body, new RegExp(forbidden),
        `第二个实例还在调 ${forbidden} —— 单实例锁形同虚设`);
    }
  });

  test('锁必须挡在 whenReady 的注册之前', () => {
    // ready 之前调 app.quit() 只是排了个队,ready 回调照样会先跑一遍 startServer。
    // 所以判断要包住**注册**,不能挪进回调里
    const lock = mainSrc.indexOf('requestSingleInstanceLock');
    const ready = mainSrc.indexOf('app.whenReady()');
    assert.ok(lock > 0, '没有单实例锁 —— 第二次双击 exe 会弹「后台服务意外退出(代码 1)」');
    assert.ok(ready > 0, 'whenReady 没了');
    assert.ok(lock < ready, 'whenReady 注册在锁之前 —— 第二个实例仍然会先起一遍子进程');
  });

  test('第一个实例要把面板拿出来,不能装作没看见', () => {
    assert.match(mainSrc, /app\.on\('second-instance',\s*showWindow\)/,
      'second-instance 没接 showWindow —— 双击 exe 变成「什么都没发生」,比报错更让人以为程序坏了');
  });

  test('子进程的 stderr 要留着,错误框才说得出原因', () => {
    // 回到 stdio: 'inherit' 只在**打包版**出问题:那里没有控制台,子进程死前说的
    // 那句话直接蒸发,错误框退化成一个连搜都没得搜的「代码 1」。dev 模式一切正常
    const body = blockFrom(mainSrc, 'function startServer');
    assert.match(body, /stdio:\s*\['inherit',\s*'inherit',\s*'pipe'\]/,
      'stderr 不再走管子 —— 打包版里子进程的错误信息会丢掉');
    assert.match(body, /lastErrorLine\(/, '错误框没有复述子进程说的原因');
  });

  test('启动期的 error 监听要在 listen 成功之后摘掉', () => {
    // 留着的话,listen 之后真出的 error 会 reject 到一个已经 settle 的 promise 上 ——
    // 既不崩也不报,一个错误就这么没了
    // 针对的是 listen 回调本身 —— `new Promise((resolve, reject)` 这个写法在
    // 这个文件里不止一处(readBody 也是),拿它当锚会截到别人的代码块上
    const block = blockFrom(serverSrc, 'server.listen(config.port');
    assert.match(block, /removeListener\('error'/,
      'listen 成功后没摘掉启动期监听 —— 之后的服务器错误会被静默吞掉');
  });
});

describe('maybeSync —— 新鲜度闸门不能被绕开', () => {
  const nulls = {
    db: null, steam: null, config: {}, syncState: null,
    guideGenState: null, startGuideGen: null, planGuidePreflight: null,
  };

  test('走的是 maybeAutoSync,不是 startBackgroundSync', () => {
    let stale = 0;
    let forced = 0;
    const api = createApi({
      ...nulls,
      startBackgroundSync: () => { forced++; return { started: true }; },
      maybeAutoSync: () => { stale++; return true; },
    });

    const r = api.maybeSync();
    assert.equal(stale, 1, 'maybeSync 没有调 maybeAutoSync');
    assert.equal(forced, 0,
      'maybeSync 走了 startBackgroundSync —— 那个故意绕开 syncStaleHours,' +
      '于是每次切回窗口都会全量同步一遍');
    assert.deepEqual(r, { started: true });
  });

  test('闸门说不用同步时,如实返回 false', () => {
    const api = createApi({ ...nulls, startBackgroundSync: null, maybeAutoSync: () => false });
    assert.deepEqual(api.maybeSync(), { started: false });
  });

  test('没注入也不抛 —— CLI 起的 serve 不该因为这个 500', () => {
    const api = createApi({ ...nulls, startBackgroundSync: null });
    assert.doesNotThrow(() => api.maybeSync());
    assert.equal(api.maybeSync().started, false);
  });

  test('server.js 真的把 maybeAutoSync 接进了 createApi', () => {
    // 源码断言:注入点在 serve() 的闭包里,单测够不着。漏接的话 maybeSync
    // 永远返回 unavailable,窗口显示再也不触发同步——而且完全不报错
    const block = blockFrom(serverSrc, 'const api = createApi(');
    assert.match(block, /maybeAutoSync\s*:/,
      'server.js 没把 maybeAutoSync 注进去 —— maybeSync 会静默变成空操作');
  });
});

describe('图标资产', () => {
  test('icon.ico 存在,且是含 256 档的合法 ICO', () => {
    const buf = readFileSync(new URL('../launcher/icon.ico', import.meta.url));
    assert.equal(buf.readUInt16LE(0), 0, 'ICO 头的 reserved 必须是 0');
    assert.equal(buf.readUInt16LE(2), 1, 'type 必须是 1(图标,不是光标)');

    const count = buf.readUInt16LE(4);
    assert.ok(count > 0, 'ICO 里一张图都没有');

    const sizes = [];
    for (let i = 0; i < count; i++) sizes.push(buf[6 + i * 16] || 256);
    assert.ok(sizes.includes(16), '缺 16×16 —— 那是托盘实际用的尺寸');
    assert.ok(sizes.includes(256), '缺 256×256 —— electron-builder 对应用图标的硬性下限');
  });

  test('打包配置必须带上 icon.ico', () => {
    // 漏掉只有**打包版**没图标,dev 模式(npm start)一切正常 ——
    // 正是那种要等发出去才发现的问题
    const pkg = JSON.parse(readFileSync(new URL('../launcher/package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.build.files.includes('icon.ico'), 'build.files 里没有,asar 里就没有这个文件');
    assert.ok(pkg.build.asarUnpack?.includes('icon.ico'),
      '没有 asarUnpack —— 托盘要从真实路径读这个文件,压在 asar 里读不到');
    assert.equal(pkg.build.win.icon, 'icon.ico', 'win.icon 没设,exe 还是默认的 Electron 图标');
  });
});
