/**
 * 本地 HTTP 服务(替代 Apps Script 的 HtmlService Web App 部署)
 * ------------------------------------------------
 * - GET  /            → Dashboard.html(原封不动的那份,只多了一行 <script src="/_rpc.js">)
 * - GET  /_rpc.js     → google.script.run 的兼容层
 * - POST /api/<方法名> → 调 lib/api.js 里同名方法,body 是 {args: [...]}
 *
 * 只监听 127.0.0.1:不对局域网/公网暴露,所以不需要 SYNC_SECRET 这类 token
 * (原版那个 endpoint 必须部署成 ANYONE_ANONYMOUS 才能被外部调用,才需要自己造一层鉴权)。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { getMeta } from './db.js';
import { createApi } from './api.js';
import { fullSync } from './sync.js';

/** 后台同步的进度状态,给 /api/syncStatus 和提示条用 */
export function createSyncState() {
  let state = { running: false, phase: null, done: 0, total: 0, name: '', error: null, at: null };
  return {
    snapshot: () => ({ ...state }),
    onProgress(p) {
      state = { ...state, ...p };
    },
    begin() {
      state = { running: true, phase: 'library', done: 0, total: 0, name: '', error: null, at: new Date().toISOString() };
    },
    end(error) {
      state = { ...state, running: false, phase: null, name: '', error: error ? String(error.message ?? error) : null };
    },
  };
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error('请求体太大'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export function serve({ db, steam, config, log = console.log }) {
  const syncState = createSyncState();
  const api = createApi({ db, steam, config, syncState });

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const sendFile = (res, path, ext) => {
    try {
      const body = readFileSync(path);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读不到文件: ' + err.message);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendFile(res, join(ROOT, 'Dashboard.html'), '.html');
    }
    if (req.method === 'GET' && url.pathname === '/_rpc.js') {
      return sendFile(res, join(ROOT, 'lib', 'rpc-shim.js'), '.js');
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const method = url.pathname.slice('/api/'.length);
      const fn = Object.hasOwn(api, method) ? api[method] : null;
      if (typeof fn !== 'function') return sendJson(res, 404, { ok: false, error: `未知方法: ${method}` });

      try {
        const raw = await readBody(req);
        const args = raw ? (JSON.parse(raw).args ?? []) : [];
        const result = await fn(...args);
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        log('[api] ' + method + ' 出错: ' + (err.stack ?? err));
        return sendJson(res, 500, { ok: false, error: String(err.message ?? err) });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  /** 数据超过 syncStaleHours 就在后台跑一次全量同步(设 0 表示关掉这个行为) */
  function maybeAutoSync() {
    const hours = config.syncStaleHours;
    if (!hours) return;
    const last = getMeta(db, 'last_sync');
    const ageH = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
    if (ageH < hours) {
      log(`数据是 ${ageH.toFixed(1)} 小时前同步的(阈值 ${hours}h),这次不自动同步。`);
      return;
    }
    if (!config.steamApiKey || !config.steamId) {
      log('⚠️  Steam 凭据没配置,跳过自动同步。跑 `node tracker.js init` 配一下。');
      return;
    }

    log(last ? `数据已经 ${ageH.toFixed(1)} 小时没更新,开始后台同步...` : '还没有同步记录,开始首次同步...');
    syncState.begin();
    fullSync(db, steam, { onProgress: (p) => syncState.onProgress(p) })
      .then((r) => {
        syncState.end(null);
        log(
          `✅ 后台同步完成:新增 ${r.library.added.length} 款,刷新成就 ${r.stats.updated} 款,` +
            `成就详情 ${r.schema.processed} 款`
        );
      })
      .catch((err) => {
        syncState.end(err);
        log('❌ 后台同步失败:' + (err.stack ?? err));
      });
  }

  return new Promise((resolve) => {
    server.listen(config.port, '127.0.0.1', () => {
      log(`\n  Dashboard → http://127.0.0.1:${config.port}\n  停止:Ctrl+C\n`);
      maybeAutoSync();
      resolve(server);
    });
  });
}
