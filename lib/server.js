/**
 * 本地 HTTP 服务:给 Dashboard 提供页面和数据接口
 * ------------------------------------------------
 * - GET  /            → Dashboard.html
 * - GET  /_rpc.js     → lib/rpc.js(前端调后端用的封装)
 * - POST /api/<方法名> → 调 lib/api.js 里同名方法,body 是 {args: [...]}
 *
 * 只监听 127.0.0.1,不对局域网/公网暴露——所以接口本身不需要再加一层 token 鉴权。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { getMeta } from './db.js';
import { createApi } from './api.js';
import { fullSync } from './sync.js';
import { NotionClient } from './notion.js';
import { syncGuidesFromNotion, syncGuidesFromMarkdown } from './guides.js';

/**
 * 后台同步的进度状态,给 /api/syncStatus 和提示条用。
 * bumped 是"这次发现成就总数变多了"的游戏名单——以前只有 CLI 打印,Dashboard 这条
 * 路径直接丢掉了,而这恰恰是自动同步最该说出口的一件事。
 */
export function createSyncState() {
  const idle = { running: false, phase: null, done: 0, total: 0, name: '', error: null, at: null, bumped: [] };
  let state = { ...idle };
  return {
    snapshot: () => ({ ...state }),
    onProgress(p) {
      state = { ...state, ...p };
    },
    begin() {
      state = { ...idle, running: true, phase: 'library', at: new Date().toISOString() };
    },
    end(error, { bumped = [] } = {}) {
      state = {
        ...state,
        running: false,
        phase: null,
        name: '',
        error: error ? String(error.message ?? error) : null,
        bumped,
      };
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
      return sendFile(res, join(ROOT, 'lib', 'rpc.js'), '.js');
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

  /**
   * 打开 Dashboard 时顺带发现一次新攻略页(Notion + 本地 guides/)。
   *
   * 故意**不受 syncStaleHours 管**:刚在 Notion 建好一个攻略页就打开 Dashboard 时,
   * 成就数据往往还很新(不触发 fullSync),但攻略链接必须当场出现——这正是这个钩子
   * 存在的理由。按 staleness 拦一道的话,新页面可能十几个小时都不出现在 Dashboard 上。
   *
   * 也不需要 Steam 凭据:攻略发现只跟 Notion 和 guides/ 目录有关。
   * 而且**失败必须是软的**——Notion 挂了、token 过期都不该影响 Dashboard 和成就同步。
   */
  async function syncGuides() {
    if (config.syncGuidesOnServe === false) return;
    try {
      const local = syncGuidesFromMarkdown(db, config);
      if (local.added.length) {
        log(`攻略(本地):登记 ${local.added.length} 条 —— ${local.added.map((a) => a.name).join('、')}`);
      }

      const notion = new NotionClient(config);
      if (!notion.configured) return;

      const r = await syncGuidesFromNotion(db, notion);
      if (r.added.length) {
        log(`攻略(Notion):新登记 ${r.added.length} 条 —— ${r.added.map((a) => a.name).join('、')}`);
      } else {
        log(`攻略(Notion):数据库里 ${r.dbPages} 个页面,没有新的要登记。`);
      }
      if (r.failed.length) {
        log(`⚠️  ${r.failed.length} 个攻略页面读不出来:${r.failed.map((f) => f.title).join('、')}`);
      }
    } catch (err) {
      log('⚠️  攻略发现失败(不影响 Dashboard 和成就同步):' + (err.message ?? err));
    }
  }

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
    // 传了 selection,第二阶段才会按 rtime + 轮换扫描取样(CLI 的 sync 仍然是全量)
    const selection = {
      sweepBudget: config.sweepBudget,
      maxStatsAgeDays: config.maxStatsAgeDays,
      perfectGameMaxAgeDays: config.perfectGameMaxAgeDays,
    };
    fullSync(db, steam, { onProgress: (p) => syncState.onProgress(p), selection })
      .then((r) => {
        syncState.end(null, { bumped: r.stats.bumped });
        const s = r.stats.selection;
        log(
          `✅ 后台同步完成:新增 ${r.library.added.length} 款,刷新成就 ${r.stats.updated} 款,` +
            `成就详情 ${r.schema.processed} 款`
        );
        log(
          `   查了 ${s.total} 款(玩过 ${s.played} / 不在 owned ${s.unowned} / 轮换复查 ${s.swept})` +
            (s.sweepPending ? `,还有 ${s.sweepPending} 款排队等下次` : '')
        );
        if (r.stats.bumped.length) {
          log(`   🆕 成就总数变多了(游戏更新):${r.stats.bumped.join('、')}`);
        }
      })
      .catch((err) => {
        syncState.end(err);
        log('❌ 后台同步失败:' + (err.stack ?? err));
      });
  }

  return new Promise((resolve) => {
    server.listen(config.port, '127.0.0.1', () => {
      log(`\n  Dashboard → http://127.0.0.1:${config.port}\n  停止:Ctrl+C\n`);
      // 两个都是后台跑,不挡住 listen 回调——页面要能立刻打开
      syncGuides();
      maybeAutoSync();
      resolve(server);
    });
  });
}
