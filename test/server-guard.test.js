/**
 * 网络边界:谁够得着这个端口,以及一次请求能不能把进程带走
 * ------------------------------------------------------------------
 * 这个文件保的和别的测试都不一样:别处保的是「功能对不对」,这里保的是
 * **「只监听 127.0.0.1」这句话到底挡住了什么」**。答案是:几乎什么都没挡住。
 * 用户在浏览器里打开的任何一个网页都能往 `http://127.0.0.1:8777/` 发请求 ——
 * `Content-Type: text/plain` 是 CORS 的「简单请求」,没有预检;对方读不到回应,
 * 但**副作用照样发生**,而这里的副作用包括删游戏、覆盖 config.json、发起要花钱的
 * 生成,以及 `/restore` 那条把整个数据库换掉的路。
 *
 * 三条,每条对应一个实测过的洞:
 *
 * 1. **跨站请求**  —— `POST /api/deleteGame` 从任意页面发出去会被执行
 * 2. **DNS 重绑定** —— 攻击者把域名解到 127.0.0.1 之后 Origin 变成同源,
 *                    这时他连**回应都读得到**,所以 GET 也必须挡
 * 3. **畸形转义**  —— `/fonts/%` 抛 URIError,async 处理器里没人接 = 进程退出
 *
 * 第 3 条不是理论:`<img src="http://127.0.0.1:8777/fonts/%">` 挂在任何一个网页上,
 * 打包版就显示「后台服务意外退出(代码 1)」。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { serve, isLocalCaller, readBody, readBinaryBody } from '../lib/server.js';

// ---------------------------------------------------------------------------
// isLocalCaller —— 纯函数,先把判据本身钉死
// ---------------------------------------------------------------------------

describe('isLocalCaller —— 谁算「本机这一页」', () => {
  test('本机页面发来的:Host 和 Origin 都是回环,放行', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: 'http://127.0.0.1:8777' }), true);
    assert.equal(isLocalCaller({ host: 'localhost:8777', origin: 'http://localhost:8777' }), true);
  });

  test('端口不参与判断 —— port 是可配的,写死就等于把配置项废掉', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:3000' }), true);
  });

  test('IPv6 字面量认得 —— Host 里带方括号,URL.hostname 也带', () => {
    assert.equal(isLocalCaller({ host: '[::1]:8777', origin: 'http://[::1]:8777' }), true);
  });

  test('**根本没带 Origin 的放行** —— 那是启动器 / CLI / 测试,不是浏览器', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777' }), true);
  });

  test('跨站的 Origin 拒掉,哪怕 Host 是对的 —— 这就是 CSRF 那条路', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: 'https://evil.example' }), false);
  });

  test('**字面量 null 要拒,不能当成「没带」** —— sandbox iframe 和 file:// 页面发的是它', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: 'null' }), false);
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: '' }), false);
  });

  test('前缀像回环的域名不算 —— 127.0.0.1.evil.com 是别人的机器', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1.evil.com', origin: 'http://127.0.0.1.evil.com' }), false);
    assert.equal(isLocalCaller({ host: 'localhost.evil.com:8777' }), false);
  });

  test('**Host 是攻击者的域名就拒 —— DNS 重绑定唯一挡得住的地方**', () => {
    // 重绑定之后浏览器认为同源,于是 Origin 也是 rebind.evil.com,两个头自洽。
    // 能把它和真的本机页面分开的只有「这个名字不是回环名字」
    assert.equal(isLocalCaller({ host: 'rebind.evil.com:8777', origin: 'http://rebind.evil.com:8777' }), false);
  });

  test('没有 Host 头就拒,不是默认放行', () => {
    assert.equal(isLocalCaller({}), false);
    assert.equal(isLocalCaller({ origin: 'http://127.0.0.1:8777' }), false);
  });
});

// ---------------------------------------------------------------------------
// 真的起一个服务器
// ---------------------------------------------------------------------------

describe('跑起来的服务器', () => {
  let server;
  let port;
  /** 被调到的 api 方法名 —— 「拒绝了」和「拒绝了但还是执行了」是两回事 */
  let called;

  before(async () => {
    called = [];
    // db 只需要够 /api/ 那条路把方法找出来并调一次。deleteGame 会在 db 上炸,
    // 炸本身就说明**它被调用了** —— 这正是要观察的东西
    const db = {
      prepare() {
        called.push('db.prepare');
        throw new Error('测试用的假库');
      },
    };
    server = await serve({ db, steam: {}, config: { port: 0 }, log: () => {} });
    port = server.address().port;
  });

  after(() => server?.close());

  /** 原始请求,可以自己指定任意头 —— fetch 不让改 Host */
  const raw = (method, path, headers = {}, body = null) =>
    new Promise((resolve, reject) => {
      const lines = [`${method} ${path} HTTP/1.1`];
      const h = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
      for (const [k, v] of Object.entries(h)) if (v !== null) lines.push(`${k}: ${v}`);
      if (body !== null) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      const payload = lines.join('\r\n') + '\r\n\r\n' + (body ?? '');

      import('node:net').then(({ connect }) => {
        const sock = connect(port, '127.0.0.1', () => sock.end(payload));
        let text = '';
        sock.setEncoding('utf8');
        sock.on('data', (d) => { text += d; });
        sock.on('end', () => resolve({ status: Number(text.slice(9, 12)), text }));
        sock.on('error', reject);
      });
    });

  test('本机页面的 POST 照常走', async () => {
    const r = await raw('POST', '/api/getSettings',
      { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, '{"args":[]}');
    assert.equal(r.status, 200);
  });

  test('不带 Origin 的 POST 照常走 —— 启动器就是这么调 maybeSync 的', async () => {
    const r = await raw('POST', '/api/getSettings', { 'Content-Type': 'application/json' }, '{"args":[]}');
    assert.equal(r.status, 200);
  });

  test('**跨站 POST 被拒,而且那个方法一次都没被调到**', async () => {
    called.length = 0;
    const r = await raw('POST', '/api/deleteGame',
      { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, '{"args":["730"]}');
    assert.equal(r.status, 403, '跨站的 POST 被执行了');
    // 只看状态码不够:403 之后仍然把方法跑掉的话,数据已经没了
    assert.deepEqual(called, [], '拒绝了状态码,却还是执行了 deleteGame');
  });

  test('**/restore 也在同一道闸门后面** —— 它是整库覆盖那条路', async () => {
    const r = await raw('POST', '/restore', { Origin: 'https://evil.example' }, 'PK');
    assert.equal(r.status, 403);
  });

  test('**GET 也要挡 Host** —— 重绑定进来的页面读得到回应', async () => {
    const r = await raw('GET', '/', { Host: 'rebind.evil.com' });
    assert.equal(r.status, 403, 'DNS 重绑定能读到 Dashboard');
  });

  describe('畸形百分号转义 —— 一次请求打掉整个进程', () => {
    // 这几条各自都能让旧代码里的 async 处理器抛 URIError。测试进程本身没有
    // unhandledRejection 处理器,所以**回归一旦发生,是整个测试文件崩掉**,
    // 不是一条红色断言 —— 这恰好就是线上的表现
    for (const path of ['/fonts/%', '/fonts/%zz', '/guide/%', '/guide/%E0%A4%A']) {
      test(`${path} → 400,而且进程还活着`, async () => {
        const r = await raw('GET', path);
        assert.equal(r.status, 400);
      });
    }

    test('挡下之后服务器照常应答下一条请求', async () => {
      await raw('GET', '/fonts/%');
      const r = await raw('POST', '/api/getSettings', { 'Content-Type': 'application/json' }, '{"args":[]}');
      assert.equal(r.status, 200, '一条畸形 URL 之后服务器就不干活了');
    });
  });

  test('合法的字体路径不受影响', async () => {
    const r = await raw('GET', '/fonts/noto-sans-sc.css');
    assert.equal(r.status, 200);
  });

  test('**转义后仍然越界的,要走 403 而不是被扩展名那条先挡掉**', async () => {
    const r = await raw('GET', '/fonts/%2e%2e%2fnope.css');
    assert.equal(r.status, 403);
  });

  test('**前缀相同的兄弟目录也算越界** —— assets/fonts-evil/ 不在 assets/fonts/ 里', async () => {
    // 上面那条 `../nope.css` 落在 assets/ 下,`startsWith(base)` 本来就为假,
    // 所以它**验不到分隔符那一位**。这一条才验:`assets/fonts-evil` 是
    // `assets/fonts` 的字符串前缀,漏掉 `+ sep` 就放行了。同 resolveGuidePath 的坑
    const r = await raw('GET', '/fonts/%2e%2e%2ffonts-evil%2fx.css');
    assert.equal(r.status, 403, '兄弟目录被当成了子目录');
  });
});

// ---------------------------------------------------------------------------
// 请求体上限
// ---------------------------------------------------------------------------

/** 一个够用的假 req:能发 data / end / error,并记下有没有被 destroy */
function fakeReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  return req;
}

describe('请求体上限 —— reject 不等于停下来', () => {
  test('没超的原样收下', async () => {
    const req = fakeReq();
    const p = readBody(req, 100);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    assert.equal(await p, 'hello');
  });

  test('刚好到上限还算没超', async () => {
    const req = fakeReq();
    const p = readBody(req, 5);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    assert.equal(await p, 'hello');
  });

  test('超了就 reject,而且话是说给人听的', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('hello'));
    await assert.rejects(p, /请求体太大/);
  });

  test('**超了要掐连接** —— 不掐的话监听器还挂着,对端继续发、字符串继续长', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('hello'));
    await assert.rejects(p, /请求体太大/);
    assert.equal(req.destroyed, true, 'reject 了却没 destroy —— 上限只是让处理器早点放弃');
  });

  test('掐完之后再来的块不会二次结算,也不会变成没人接的 rejection', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('hello'));
    await assert.rejects(p, /请求体太大/);
    // 真实的 socket 在 destroy 之后仍可能把已经在内核缓冲里的块交上来
    req.emit('data', Buffer.from('x'.repeat(1000)));
    req.emit('end');
    req.emit('error', new Error('ECONNRESET'));
  });

  test('二进制那条同样掐连接 —— 它收的是 200 MB 级别的东西', async () => {
    const req = fakeReq();
    const p = readBinaryBody(req, 3);
    req.emit('data', Buffer.from([1, 2, 3, 4]));
    await assert.rejects(p, /文件太大/);
    assert.equal(req.destroyed, true);
  });

  test('二进制没超的按字节原样拼回来', async () => {
    const req = fakeReq();
    const p = readBinaryBody(req, 10);
    req.emit('data', Buffer.from([0, 255]));
    req.emit('data', Buffer.from([128]));
    req.emit('end');
    assert.deepEqual([...(await p)], [0, 255, 128]);
  });
});
