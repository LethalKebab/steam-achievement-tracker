/**
 * The network boundary: who can reach this port, and whether one request can take the
 * process down
 * ------------------------------------------------------------------
 * What this file protects is unlike every other test: elsewhere it is "is the feature
 * correct", while here it is **what "listens on 127.0.0.1 only" actually blocks**. The
 * answer is: almost nothing. Any web page the user opens in their browser can send requests
 * to `http://127.0.0.1:8777/` — `Content-Type: text/plain` is a CORS "simple request" with
 * no preflight; they cannot read the response, but **every side effect still lands**, and
 * the side effects here include deleting games, overwriting config.json, kicking off a
 * generation that spends money, and `/restore`, which replaces the whole database.
 *
 * Three of them, each matching a hole that was measured:
 *
 * 1. **A cross-site request** — `POST /api/deleteGame` sent from any page was executed
 * 2. **DNS rebinding** — once the attacker resolves a domain to 127.0.0.1 the Origin
 *                        becomes same-origin, and at that point they **can read the
 *                        response**, so GET has to be blocked too
 * 3. **A malformed escape** — `/fonts/%` throws a URIError, and unhandled inside an async
 *                        handler that means the process exits
 *
 * The third is not theoretical: `<img src="http://127.0.0.1:8777/fonts/%">` on any web page
 * makes the packaged build display 「后台服务意外退出(代码 1)」.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { serve, isLocalCaller, readBody, readBinaryBody } from '../lib/server.js';

// ---------------------------------------------------------------------------
// isLocalCaller — a pure function, so pin the predicate itself first
// ---------------------------------------------------------------------------

describe('isLocalCaller — who counts as "this page on this machine"', () => {
  test('sent by a local page: Host and Origin are both loopback, so it is allowed', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: 'http://127.0.0.1:8777' }), true);
    assert.equal(isLocalCaller({ host: 'localhost:8777', origin: 'http://localhost:8777' }), true);
  });

  test('the port plays no part — port is configurable, and hardcoding it makes that option useless', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:3000' }), true);
  });

  test('an IPv6 literal is recognised — the Host carries brackets and so does URL.hostname', () => {
    assert.equal(isLocalCaller({ host: '[::1]:8777', origin: 'http://[::1]:8777' }), true);
  });

  test('**no Origin header at all is allowed** — that is the launcher / the CLI / the tests, not a browser', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777' }), true);
  });

  test('a cross-site Origin is refused even with a correct Host — that is the CSRF route', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: 'https://evil.example' }), false);
  });

  test('**the literal null is refused and must not count as "absent"** — a sandboxed iframe and a file:// page send exactly that', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: 'null' }), false);
    assert.equal(isLocalCaller({ host: '127.0.0.1:8777', origin: '' }), false);
  });

  test('a domain that merely starts like loopback does not count — 127.0.0.1.evil.com is somebody else\'s machine', () => {
    assert.equal(isLocalCaller({ host: '127.0.0.1.evil.com', origin: 'http://127.0.0.1.evil.com' }), false);
    assert.equal(isLocalCaller({ host: 'localhost.evil.com:8777' }), false);
  });

  test('**a Host that is the attacker\'s domain is refused — the only place DNS rebinding can be blocked**', () => {
    // After rebinding the browser considers it same-origin, so the Origin is rebind.evil.com
    // too and the two headers are self-consistent.
    // The only thing separating it from a genuine local page is "this name is not a loopback name"
    assert.equal(isLocalCaller({ host: 'rebind.evil.com:8777', origin: 'http://rebind.evil.com:8777' }), false);
  });

  test('no Host header is refused rather than allowed by default', () => {
    assert.equal(isLocalCaller({}), false);
    assert.equal(isLocalCaller({ origin: 'http://127.0.0.1:8777' }), false);
  });
});

// ---------------------------------------------------------------------------
// A real server
// ---------------------------------------------------------------------------

describe('a running server', () => {
  let server;
  let port;
  /** The api methods that were called — "refused" and "refused but executed anyway" are two different things */
  let called;

  before(async () => {
    called = [];
    // db only has to be enough for the /api/ path to find the method and call it once.
    // deleteGame will blow up on db, and the blow-up itself proves **it was called** — which
    // is exactly what is being observed
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

  /** A raw request, so any header can be set — fetch will not let Host be changed */
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

  test('a POST from a local page goes through as usual', async () => {
    const r = await raw('POST', '/api/getSettings',
      { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, '{"args":[]}');
    assert.equal(r.status, 200);
  });

  test('a POST with no Origin goes through as usual — that is exactly how the launcher calls maybeSync', async () => {
    const r = await raw('POST', '/api/getSettings', { 'Content-Type': 'application/json' }, '{"args":[]}');
    assert.equal(r.status, 200);
  });

  test('**a cross-site POST is refused, and that method was never called once**', async () => {
    called.length = 0;
    const r = await raw('POST', '/api/deleteGame',
      { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, '{"args":["730"]}');
    assert.equal(r.status, 403, 'the cross-site POST was executed');
    // The status code alone is not enough: running the method anyway after a 403 means the data is already gone
    assert.deepEqual(called, [], 'the status code refused it while deleteGame ran regardless');
  });

  test('**/restore is behind the same gate** — it is the whole-database overwrite route', async () => {
    const r = await raw('POST', '/restore', { Origin: 'https://evil.example' }, 'PK');
    assert.equal(r.status, 403);
  });

  test('**GET has to check Host too** — a page arriving through rebinding can read the response', async () => {
    const r = await raw('GET', '/', { Host: 'rebind.evil.com' });
    assert.equal(r.status, 403, 'DNS rebinding can read the Dashboard');
  });

  describe('a malformed percent escape — one request takes the whole process down', () => {
    // Each of these makes the old code's async handler throw a URIError. The test process
    // itself has no unhandledRejection handler, so **a regression takes the whole test file
    // down** rather than turning one assertion red — which is exactly how it behaves in
    // production
    for (const path of ['/fonts/%', '/fonts/%zz', '/guide/%', '/guide/%E0%A4%A']) {
      test(`${path} → 400, and the process is still alive`, async () => {
        const r = await raw('GET', path);
        assert.equal(r.status, 400);
      });
    }

    test('after blocking it, the server answers the next request as usual', async () => {
      await raw('GET', '/fonts/%');
      const r = await raw('POST', '/api/getSettings', { 'Content-Type': 'application/json' }, '{"args":[]}');
      assert.equal(r.status, 200, 'the server stopped working after one malformed URL');
    });
  });

  test('a legitimate font path is unaffected', async () => {
    const r = await raw('GET', '/fonts/noto-sans-sc.css');
    assert.equal(r.status, 200);
  });

  test('**one that still escapes after decoding has to take the 403 rather than being caught by the extension check first**', async () => {
    const r = await raw('GET', '/fonts/%2e%2e%2fnope.css');
    assert.equal(r.status, 403);
  });

  test('**a sibling directory sharing the prefix escapes too** — assets/fonts-evil/ is not inside assets/fonts/', async () => {
    // The `../nope.css` above lands under assets/, where `startsWith(base)` was false anyway,
    // so it **cannot exercise the separator bit**. This one does: `assets/fonts-evil` is a
    // string prefix of `assets/fonts`, and missing the `+ sep` lets it through. The same trap
    // as resolveGuidePath
    const r = await raw('GET', '/fonts/%2e%2e%2ffonts-evil%2fx.css');
    assert.equal(r.status, 403, 'a sibling directory was treated as a subdirectory');
  });
});

// ---------------------------------------------------------------------------
// Body limits
// ---------------------------------------------------------------------------

/** A fake req that is enough: it can emit data / end / error and records whether it was destroyed */
function fakeReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  return req;
}

describe('body limits — rejecting is not the same as stopping', () => {
  test('a body under the limit is taken verbatim', async () => {
    const req = fakeReq();
    const p = readBody(req, 100);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    assert.equal(await p, 'hello');
  });

  test('exactly at the limit still counts as not over', async () => {
    const req = fakeReq();
    const p = readBody(req, 5);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    assert.equal(await p, 'hello');
  });

  test('over the limit rejects, and the sentence is written for a person', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('hello'));
    await assert.rejects(p, /请求体太大/);
  });

  test('**going over has to kill the connection** — without it the listener is still attached, the peer keeps sending and the string keeps growing', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('hello'));
    await assert.rejects(p, /请求体太大/);
    assert.equal(req.destroyed, true, 'it rejected without destroying — the limit merely makes the handler give up early');
  });

  test('chunks arriving after the kill are neither settled twice nor turned into an unhandled rejection', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('hello'));
    await assert.rejects(p, /请求体太大/);
    // A real socket may still hand up chunks already in the kernel buffer after a destroy
    req.emit('data', Buffer.from('x'.repeat(1000)));
    req.emit('end');
    req.emit('error', new Error('ECONNRESET'));
  });

  test('the binary path kills the connection too — it takes things on the order of 200 MB', async () => {
    const req = fakeReq();
    const p = readBinaryBody(req, 3);
    req.emit('data', Buffer.from([1, 2, 3, 4]));
    await assert.rejects(p, /文件太大/);
    assert.equal(req.destroyed, true);
  });

  test('a binary body under the limit is reassembled byte for byte', async () => {
    const req = fakeReq();
    const p = readBinaryBody(req, 10);
    req.emit('data', Buffer.from([0, 255]));
    req.emit('data', Buffer.from([128]));
    req.emit('end');
    assert.deepEqual([...(await p)], [0, 255, 128]);
  });
});
