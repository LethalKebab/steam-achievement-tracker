/**
 * 本地 HTTP 服务:给 Dashboard 提供页面和数据接口
 * ------------------------------------------------
 * - GET  /            → Dashboard.html(没配 Steam 凭据时 302 到 /setup)
 * - GET  /setup       → Setup.html(首次设置 + 之后从 Dashboard 进来改设置)
 * - GET  /template/<表名>.csv → 只有表头的空模板,给设置页的表格导入用
 * - GET  /_rpc.js     → lib/rpc.js(前端调后端用的封装)
 * - POST /api/<方法名> → 调 lib/api.js 里同名方法,body 是 {args: [...]}
 *
 * 只监听 127.0.0.1,不对局域网/公网暴露——所以接口本身不需要再加一层 token 鉴权。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ROOT } from './config.js';
import { getMeta } from './db.js';
import { createApi } from './api.js';
import { fullSync } from './sync.js';
import { NotionClient } from './notion.js';
import { syncGuidesFromNotion, syncGuidesFromMarkdown, checkboxSync, syncGuideStatuses } from './guides.js';
import { resolveGuidePath } from './markdown.js';
import { getGuide } from './db.js';
import { templateCsv } from './csv.js';
import { generateGuide } from './guidegen.js';
import { createProvider } from './ai.js';

/**
 * 攻略生成的后台状态。
 *
 * **故意不和 syncState 共用。** 同步和生成是两件不同的事:一次生成要跑两三分钟,
 * 期间用户完全可能去点「立即同步」;共用一份状态的话,后开始的那个 `begin()` 会把
 * 前一个的进度和结果整个抹掉,而两边都不会报错——页面上只会看到进度条莫名其妙跳回去。
 * 各自一份状态,各自一个并发闸门。
 *
 * 结果里带着 `researched` 和 `searchQueries`:**"能搜"和"搜了"是两回事**,
 * 而这个差别用户在页面上看不出来,必须明写(和 CLI 那边同一条理由)。
 */
export function createGuideGenState() {
  const idle = {
    running: false, appid: null, game: '', phase: null, round: 0, rounds: 0,
    note: '', error: null, at: null,
    /**
     * 跑完还要留着的话。**不能走 `note`** —— 那一格是"现在在干什么",下一个进度事件
     * 就把它盖掉了,而「第 3 段没写出来」这种话必须留到最后被人看见。同 syncState 的
     * `bumped`/`ticked` 一条理由:报告一件**已经发生**的事,不该和进度共用一格。
     */
    warnings: [],
    result: null, // {ok, path, rounds, covered, total, warnings, researched, searchQueries, usage}
  };
  let state = { ...idle };
  /**
   * 还没轮到的那些。**队列住在这里而不是 server.js 的闭包里**,是为了让它跟着
   * `snapshot()` 一起交出去 —— 页面上要显示「还有几个在排队」,而那和「现在在跑哪个」
   * 是同一件事的两半,分两处存迟早会有一处忘了更新。
   *
   * 一次只跑一个是有意的:生成要联网、要花钱,并行跑既撞供应商的限流,也让
   * 「花了多少」变得没法归因。
   */
  let queue = [];
  return {
    snapshot: () => ({ ...state, queue: queue.map((q) => ({ appid: q.appid, game: q.game })) }),
    begin(appid, game, rounds) {
      state = { ...idle, running: true, appid: String(appid), game, rounds, at: new Date().toISOString() };
    },
    onProgress(p) {
      state = { ...state, ...p };
    },
    /** 攒一条跑完还要留着的提醒。`onProgress` 是合并语义,追加只能另开一个口 */
    warn(note) {
      if (note && !state.warnings.includes(note)) state = { ...state, warnings: [...state.warnings, note] };
    },
    end(error, result = null) {
      state = {
        ...state,
        running: false,
        phase: null,
        note: '',
        error: error ? String(error.message ?? error) : null,
        result,
      };
    },

    /** 已经在跑或已经排上的 appid —— 用来挡重复点击 */
    isPending(appid) {
      const id = String(appid);
      return (state.running && state.appid === id) || queue.some((q) => q.appid === id);
    },
    enqueue(item) {
      queue.push({ ...item, appid: String(item.appid) });
      return queue.length;
    },
    dequeue: () => queue.shift() ?? null,
    queueLength: () => queue.length,
    /** 供应商没配好之类的整体故障:把队列清掉,别让它们一个个再失败一遍 */
    clearQueue() {
      const dropped = queue;
      queue = [];
      return dropped;
    },
  };
}

/**
 * 后台同步的进度状态,给 /api/syncStatus 和提示条用。
 * bumped 是"这次发现成就总数变多了"的游戏名单——以前只有 CLI 打印,Dashboard 这条
 * 路径直接丢掉了,而这恰恰是自动同步最该说出口的一件事。
 *
 * ticked / tickError 是自动 checkbox 勾选的结果,和 error 分开放是有意的:
 * Notion 挂了不该让页面显示"同步失败"——成就数明明已经刷新好了。
 */
export function createSyncState() {
  const idle = {
    running: false, phase: null, done: 0, total: 0, name: '',
    error: null, at: null, bumped: [], ticked: [], tickError: null,
    statusDone: [], statusStaged: [], statusError: null,
  };
  let state = { ...idle };
  return {
    snapshot: () => ({ ...state }),
    onProgress(p) {
      state = { ...state, ...p };
    },
    begin(phase = 'library') {
      state = { ...idle, running: true, phase, at: new Date().toISOString() };
    },
    end(error, {
      bumped = [], ticked = [], tickError = null,
      statusDone = [], statusStaged = [], statusError = null,
    } = {}) {
      state = {
        ...state,
        running: false,
        phase: null,
        name: '',
        error: error ? String(error.message ?? error) : null,
        bumped,
        ticked,
        tickError,
        statusDone,
        statusStaged,
        statusError,
      };
    },
  };
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

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
  const guideGenState = createGuideGenState();
  const api = createApi({
    db, steam, config, syncState, guideGenState,
    startBackgroundSync: () => startBackgroundSync(),
    startGuideGen: (appid, overwrite, effort) => startGuideGen(appid, overwrite, effort),
    planGuidePreflight: (appid, opts) => planGuidePreflight(appid, opts),
    // 包成箭头函数,和上面几个一样——maybeAutoSync 是这个闭包里的函数声明,
    // 直接传引用也行,但保持一致比省一层更值钱
    maybeAutoSync: () => maybeAutoSync(),
  });

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  // cacheControl 默认 no-store —— HTML 和 rpc.js 是边改边刷的,缓存只会碍事。
  // 字体是唯一的例外,见 /fonts/ 那一段。
  const sendFile = (res, path, ext, cacheControl = 'no-store') => {
    try {
      const body = readFileSync(path);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cacheControl });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读不到文件: ' + err.message);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // 打包给别人用的时候,没配 Steam 凭据不该直接看到一个空的 Dashboard——
      // 跳到设置页,填完 completeSetup 存盘后由 Electron 主进程重启子进程带回这里。
      if (!config.steamApiKey || !config.steamId) {
        res.writeHead(302, { Location: '/setup' });
        return res.end();
      }
      return sendFile(res, join(ROOT, 'Dashboard.html'), '.html');
    }
    if (req.method === 'GET' && url.pathname === '/setup') {
      return sendFile(res, join(ROOT, 'Setup.html'), '.html');
    }

    // 空模板下载(设置页的 CSV 导入那一步用)。表头取自 lib/csv.js 的 CSV_HEADERS,
    // 和导出共用同一份定义——导入是按列的位置读的,模板和导出的列序一旦不一致,
    // 填出来的表格会静默错位。BOM 是给 Excel 的:没有它中文表头会显示成乱码。
    if (req.method === 'GET' && url.pathname.startsWith('/template/')) {
      const kind = decodeURIComponent(url.pathname.slice('/template/'.length)).replace(/\.csv$/i, '');
      const body = templateCsv(kind);
      if (!body) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('没有这个模板');
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${kind}.csv"`,
      });
      return res.end('﻿' + body);
    }
    // 本地 markdown 攻略。**以纯文本伺服,不渲染成 HTML** —— 攻略正文是 AI 生成的,
    // 而这个页面能调 /api/*(改数据、发起会花钱的生成)。把那段内容当 HTML 插进来
    // 等于给一个能写数据的页面开了 XSS 口子。想要好看的排版就用编辑器打开文件。
    //
    // 路径来自 guides 表而不是 URL:URL 里只有 appid。就算表里的 url 被写歪了,
    // resolveGuidePath 还会挡一道(不许越出 guidesDir)。
    if (req.method === 'GET' && url.pathname.startsWith('/guide/')) {
      const appid = decodeURIComponent(url.pathname.slice('/guide/'.length));
      const row = getGuide(db, appid);
      if (!row || row.kind !== 'local') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('这个 appid 没有本地攻略');
      }
      try {
        const body = readFileSync(resolveGuidePath(config.guidesDir, row.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('读不到攻略文件:' + err.message);
      }
    }
    if (req.method === 'GET' && url.pathname === '/_rpc.js') {
      return sendFile(res, join(ROOT, 'lib', 'rpc.js'), '.js');
    }

    /* 自托管字体。**这一段存在的理由是「不要因为换台机器就变样」** —— 之前的字体栈
       (Segoe UI → 系统兜底)在中文上落到哪个字体是没人说得准的:实测这台机器上
       它既不是雅黑也不是栈里写的 Noto Sans SC,而 600/650/700 三档字重渲染出来
       **墨量完全相同**,也就是设计系统里声明的三档在中文里其实只有一档。
       自带字体之后这两件事一起消失。

       Noto Sans SC Variable(OFL-1.1,LICENSE 和字体放在一起,协议要求随附),
       按 unicode-range 切成 101 个分片 —— 浏览器只会去取屏幕上真出现的字所在的
       那几片,不是一次 4.7MB。字重是**可变轴 100–900**,所以全部字重共用同一批文件。

       两条约束:
       · **只放行 .css 和 .woff2,并且把路径夹在 assets/fonts 里面。**
         和 resolveGuidePath 同一个道理 —— 拼进路径的东西来自 URL,不做包含性检查
         就是一个目录穿越。
       · **字体要长缓存。** 其他静态文件都是 no-store(边改边刷),但字体是不变的,
         而这一页每次打开都要用到几十个分片;no-store 会让它们每次重下。 */
    if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
      const rel = decodeURIComponent(url.pathname.slice('/fonts/'.length));
      const ext = rel.slice(rel.lastIndexOf('.'));
      if (ext !== '.css' && ext !== '.woff2') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('不是字体资源');
      }
      const base = join(ROOT, 'assets', 'fonts');
      const target = resolve(base, rel);
      if (target !== base && !target.startsWith(base + sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('路径越界');
      }
      return sendFile(res, target, ext, 'public, max-age=31536000, immutable');
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
    if (config.syncGuidesOnServe === false) return [];
    // 这轮**新登记**的 appid。交给后面的自动勾选:一个刚建好的攻略页,里面的框
    // 对应的成就可能几个月前就解锁了,不趁这次勾上就得等到下次玩这款游戏。
    const found = [];
    try {
      // 只算 action==='appended' 的:syncGuidesFromMarkdown 对已经登记过的本地攻略
      // 也会重新 upsert 一遍并放进 added,不筛的话每次启动都会把**所有**本地攻略
      // 当成"刚发现的",定向勾选立刻退化成"每次全查一遍本地攻略"。
      // (Notion 那边的 added 已经按 existingIds 滤过了,是真·新增。)
      const local = syncGuidesFromMarkdown(db, config);
      const localNew = local.added.filter((a) => a.action === 'appended');
      if (localNew.length) {
        found.push(...localNew.map((a) => a.appid));
        log(`攻略(本地):登记 ${localNew.length} 条 —— ${localNew.map((a) => a.name).join('、')}`);
      }

      const notion = new NotionClient(config);
      if (!notion.configured) return found;

      const r = await syncGuidesFromNotion(db, notion);
      if (r.added.length) {
        found.push(...r.added.map((a) => a.appid));
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
    return found;
  }

  /**
   * 自动 checkbox 勾选。**这是全项目唯一不经 --dry-run 就往 Notion 写的路径**,
   * 所以每一处收窄都是故意的:
   *
   * - **只查 appids 里的行**,不是全部候选。全量是 40 多款游戏 × (1 次 Steam 调用 +
   *   1 次 Notion 页面读 + 350ms),每次打开 Dashboard 跑一遍,而绝大多数时候
   *   一个框都不会变。传进来的是"这轮 achieved/total 真的变了"加"这轮新登记的攻略页"。
   *   空数组 = 一次外部调用都不发。
   * - **默认不联动子步骤**(checkboxSyncOnServeCascade)。联动是全项目唯一"宁可多勾"
   *   的地方,对"任意一个即可"型成就会连着勾错一片,而这条路径没有人工闸门。
   * - **失败是软的**。Notion token 过期不该让页面显示"同步失败"——成就数已经刷新好了,
   *   那才是这次后台任务的主要产出。所以这里从不抛,错误单独放在 tickError 里。
   *
   * 每一条勾选(以及跳过、失败)照常写进 sync_log,`node tracker.js log` 事后可查。
   */
  async function runCheckboxSync(appids) {
    if (config.checkboxSyncOnServe === false) return { ticked: [], error: null };
    if (!appids.length) return { ticked: [], error: null };

    syncState.onProgress({ phase: 'checkbox', done: 0, total: appids.length, name: '' });
    try {
      const r = await checkboxSync(db, steam, {
        notion: new NotionClient(config),
        config,
        appids,
        cascade: config.checkboxSyncOnServeCascade === true,
        onProgress: (ev) =>
          syncState.onProgress({ phase: 'checkbox', done: ev.done, total: ev.total, name: ev.name }),
      });

      const ticked = r.logs
        .filter((l) => l.result.startsWith('已勾选'))
        .map((l) => `${l.gameName} - ${l.achievement || '子步骤'}`);
      const failed = r.logs.filter((l) => l.result.startsWith('勾选失败'));

      if (ticked.length) log(`✅ 自动勾选 ${ticked.length} 个 checkbox:${ticked.join('、')}`);
      else if (r.checked) log(`自动勾选:查了 ${r.checked} 款有变化的游戏,没有要勾的框。`);
      if (failed.length) log(`⚠️  ${failed.length} 个框没勾上,跑 \`node tracker.js log\` 看原因。`);

      return { ticked, error: null };
    } catch (err) {
      log('⚠️  自动勾选失败(成就数据已经同步好了,不受影响):' + (err.message ?? err));
      return { ticked: [], error: String(err.message ?? err) };
    }
  }

  /**
   * 把已经打满的游戏的攻略页标成 Done。
   *
   * **按当前状态收敛,不看"这一轮是否刚好打满"**。100% 那个瞬间只在 updateGameStats
   * 写的那一下存在:哪一次跑没能写成(CLI 同步的机器没配 Notion、进程中断、token 过期),
   * 这条变化就永远没了——再看时新旧都是 100%,推不出任何东西。收敛式则跑多少次都一样,
   * 漏了自己补。代价只是每次多两三个 API 请求(数据库 schema + 翻页查全部页面),
   * 和逐页去读状态完全不是一个量级。
   *
   * 和勾选一样,失败是软的:标不动状态不该影响成就数据,也不该让页面显示"同步失败"。
   */
  async function runGuideStatusSync() {
    const empty = { done: [], staged: [], error: null };
    if (config.guideStatusOnServe === false) return empty;
    const notion = new NotionClient(config);
    if (!notion.configured) return empty;

    syncState.onProgress({ phase: 'guideStatus', done: 0, total: 0, name: '' });
    try {
      const r = await syncGuideStatuses(db, {
        notion,
        onProgress: (ev) =>
          syncState.onProgress({ phase: 'guideStatus', done: ev.done, total: ev.total, name: ev.name }),
      });
      // 用 applied(真写成功的)分方向,不去解析日志文本
      const done = r.applied.filter((u) => u.reason === 'complete').map((u) => u.name);
      const staged = r.applied.filter((u) => u.reason === 'incomplete').map((u) => u.name);
      const failed = r.logs.filter((l) => l.result.startsWith('攻略状态改失败'));
      if (done.length) log(`✅ 攻略状态标为 Done:${done.join('、')}`);
      if (staged.length) log(`↩️  掉出 100%,攻略状态退回 Staged:${staged.join('、')}`);
      if (failed.length) log(`⚠️  ${failed.length} 个攻略页状态没改成,跑 \`node tracker.js log\` 看原因。`);
      return { done, staged, error: null };
    } catch (err) {
      log('⚠️  攻略状态同步失败(不影响成就数据和勾选):' + (err.message ?? err));
      return { done: [], staged: [], error: String(err.message ?? err) };
    }
  }

  /**
   * 真正发起一次后台同步。启动时的自动同步和 Dashboard 上的「立即同步」按钮
   * 都走这里——**并发保护只有这一处**,两条路径共用同一个 syncState,
   * 所以点按钮的瞬间刚好赶上启动自动同步也不会跑出两个 fullSync。
   *
   * 故意**不看 syncStaleHours**:那是"要不要自动跑"的判断,手动点了就是要跑。
   * 同步返回,不等 fullSync 完成——进度由 /api/syncStatus 轮询取。
   */
  /**
   * 后台生成一份攻略。**这是页面上唯一一个会花钱的动作**,所以:
   *
   * - 并发闸门只有这一处,一次只跑一个(两个一起跑等于同时烧两份钱,而且都要几分钟)
   * - 前置检查全部在**起跑之前**做完(没配 key、成就详情没同步、已经有攻略了)——
   *   跑到一半才发现,钱已经花了
   * - 页面那边必须先弹确认框。这里不做那件事,但也不能假设它做了:所有拒绝理由
   *   都以 `{error}` 返回,让调用方能原样显示
   */
  /**
   * 一次点击 = 一个任务。**跑不动就排队,不是拒绝。**
   *
   * 原来这里在有任务跑时直接返回 `{error: '已经有一个攻略在生成了'}`。那条错误会显示在
   * 进度条上,而 3 秒后的轮询就把它换成正在跑的那个游戏 —— 从用户的位置看就是
   * 「点了、闪一下、没反应」。一次生成要 2–4 分钟,排队是他真正想要的。
   *
   * 预检**在入队时就跑**:「这游戏已经有攻略了」这类拒绝理由要当场说,不能等
   * 二十分钟轮到它才说。真正下笔前 `generateGuide` 还会自己重新 plan 一次,所以
   * 入队时那次预检过期了也不会写坏 —— 真正的闸门在里面。
   */
  async function startGuideGen(appid, overwrite = false, effort = null) {
    if (!config.ai?.apiKey) return { started: false, error: '还没配置 AI —— 去设置页填一个供应商和 key' };
    if (guideGenState.isPending(appid)) {
      return { started: false, error: '这一款已经在生成或排队里了' };
    }

    let plan;
    try {
      // 不传 overwrite 的话 planGuide 会因为"已经有攻略了"直接拒绝 —— 那正是没加
      // --overwrite 时该有的行为,所以这里把标志一路带下去,不要在服务端偷偷放行
      plan = await planGuidePreflight(appid, { overwrite });
    } catch (err) {
      return { started: false, error: String(err.message ?? err) };
    }

    if (guideGenState.snapshot().running) {
      const position = guideGenState.enqueue({ appid, overwrite, effort, game: plan.game });
      log(`🕒 排队等生成:${plan.game}(${appid}),队列第 ${position} 个`);
      return { started: false, queued: true, position, game: plan.game };
    }

    return runGuideGen({ appid, overwrite, effort, game: plan.game });
  }

  /**
   * 真正开跑。**入队和开跑分开**,因为跑完要从队列里取下一个接着跑,那条路上
   * 没有「要不要排队」这个问题 —— 合在一起会绕回自己
   */
  async function runGuideGen({ appid, overwrite, effort, game }) {
    // **这一次的配置,不改共享的那份。** effort 是「这一次要多深」,而队列里排着的
    // 每个可能各选各的 —— 直接写 config.ai.effort 会让一次「低」把后面所有排队的
    // 也变成低,而且没有任何东西会报错。和 CLI 那边 applyAiFlags 是同一个形状,
    // 区别只是那边一个进程只跑一次,这边一个进程要跑一串
    const runConfig = effort ? { ...config, ai: { ...config.ai, effort } } : config;
    let provider;
    try {
      provider = await createProvider(runConfig);
    } catch (err) {
      // 供应商建不起来是整体故障,后面排着的会一个个撞同一堵墙 —— 一起清掉,
      // 并把原因记下来,免得队列静默消失
      const dropped = guideGenState.clearQueue();
      if (dropped.length) log(`⚠️ 供应商不可用,取消了排队中的 ${dropped.length} 个:${dropped.map((d) => d.game).join('、')}`);
      return { started: false, error: String(err.message ?? err) };
    }

    const rounds = config.ai.maxRounds ?? 3;
    guideGenState.begin(appid, game, rounds);
    log(`🤖 开始生成攻略:${game}(${appid})`);

    /** 一个跑完就接下一个。成功失败都要走,否则一次失败会把整条队列卡死 */
    const drainNext = () => {
      const next = guideGenState.dequeue();
      if (next) runGuideGen(next);
    };

    generateGuide(db, {
      // 传这一次的那份,不传共享的 —— generateGuide 今天不读 ai.effort,但两个名字
      // 摆在一起时,传错的那个不会报错,只会在将来某天悄悄用上全局值
      config: runConfig, provider, steam, appid, rounds, overwrite, notion: new NotionClient(config),
      onProgress(ev) {
        // 分段写的时候必须把"第几段"报出来:几百个成就要跑十来分钟,
        // 只显示"第 1/3 轮"的话进度条整段时间一动不动,看着像卡死了
        const seg = ev.chunks > 1 ? `${ev.chunk}/${ev.chunks} 段 · ` : '';
        if (ev.phase === 'plan' && ev.chunks > 1) {
          guideGenState.onProgress({ phase: 'plan', note: `${ev.achievements} 个成就,分 ${ev.chunks} 段` });
        } else if (ev.phase === 'ask') {
          // **报「已写完几段」而不是「正在写第几段」。** 各段并发之后同时有好几段在写,
          // 而这个事件每段各发一次 —— 报当前段号的话浮窗会在 1/4、3/4、2/4 之间来回跳,
          // 看着像进度在倒退。已写完的段数是单调的,顺序跑时也一样成立
          const prog = ev.chunks > 1 ? `已写完 ${ev.done ?? 0}/${ev.chunks} 段 · ` : '';
          guideGenState.onProgress({ phase: 'ask', round: ev.round, note: `${prog}查资料 + 撰写` });
        } else if (ev.phase === 'rewrite') {
          guideGenState.onProgress({ phase: 'rewrite', note: `重写 ${ev.chunks}/${ev.of} 段` });
        } else if (ev.phase === 'retry') {
          guideGenState.onProgress({ phase: 'ask', note: `${seg}没拿到正文,再问一次` });
        } else if (ev.phase === 'resplit') {
          // **这三相原来一个都没接。** 于是「切小重问」这条补救路径在 Dashboard 上
          // 完全看不见:浮窗停在"第 3/4 段查资料 + 撰写",段数悄悄从 4 变成 5,
          // 用户只会觉得卡住了。补救过程本身就是要给人看的东西
          guideGenState.onProgress({ phase: 'ask', note: `第 ${ev.chunk} 段太长,切成 ${ev.to} 个成就重问` });
        } else if (ev.phase === 'chunk-failed') {
          guideGenState.warn(`第 ${ev.chunk} 段(${ev.count} 个成就)没写出来,先写了后面的`);
        } else if (ev.phase === 'tool') guideGenState.onProgress({ phase: 'tool', note: ev.name });
        else if (ev.phase === 'check') guideGenState.onProgress({ phase: 'check', note: '校验' });
        else if (ev.phase === 'lint') {
          guideGenState.onProgress({ phase: 'lint', note: `勾上 ${ev.ticked} 个,还剩 ${ev.blocking} 条要改` });
        }
      },
    })
      .then((r) => {
        guideGenState.end(null, {
          ok: r.ok,
          tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
          path: r.url,
          target: r.target,
          rounds: r.rounds,
          covered: r.lint?.stats?.covered ?? 0,
          total: r.lint?.stats?.achievements ?? 0,
          warnings: r.lint?.stats?.warnings ?? 0,
          researched: r.researched,
          searchQueries: r.searchQueries ?? [],
          // **成功那条路也要能报"有几个框永远勾不上"。** 这几条从 blocking 挪进
          // expected 之后攻略就能落地了,而落地的那一屏原来只说覆盖了多少 ——
          // 于是"这 15 个框自动勾选永远认不出来"变成一件用户几个月后才会发现的事。
          // 不拦路 ≠ 不吭声,和抓页失败那条同一个规矩
          unsyncable: (r.expected ?? [])
            .filter((f) => f.code === 'ambiguous-empty-description')
            .map((f) => f.name),
          // **病因,不是症状。** 少一段的表象是几十条"缺 checkbox",而弹窗只放得下
          // 五条 —— 全被同一句话占满,真正的原因一个字都露不出来
          chunkFailures: (r.chunkFailures ?? []).map((c) => ({
            chunk: c.chunk, of: c.of, count: c.count, reason: c.reason,
          })),
          blocking: (r.blocking ?? []).slice(0, 5).map((f) => f.message),
        });
        for (const c of r.chunkFailures ?? []) {
          log(`⚠️ 第 ${c.chunk}/${c.of} 段(${c.count} 个成就)没写出来:${c.reason.split('\n')[0]}`);
        }
        log(r.ok ? `✅ 攻略写完:${r.url}` : `⚠️ 攻略没过校验,草稿留在 ${r.draftPath}`);
        drainNext();
      })
      .catch((err) => {
        guideGenState.end(err);
        log('❌ 攻略生成失败:' + (err.stack ?? err));
        drainNext();
      });

    return { started: true, game };
  }

  /** 起跑前的检查。planGuide 自己会把所有拒绝理由一次性抛出来,这里只是借它跑一遍 */
  /**
   * 生成前的预检。`overwrite` 时还要把「会失去什么」算出来 —— **GUI 的闸门不能比
   * CLI 松**:覆盖是不可逆的,而 Dashboard 上点一下比敲一行命令容易得多。
   *
   * 交出去的是**数字,不是排好版的句子**。两边共用的应该是 `overwritePreflight`
   * 那次计算,不是措辞:命令行是给敲了 flag 的人看的,可以详细;界面上要短。
   * 硬凑一份共用文案的结果就是两边都不合适。
   */
  async function planGuidePreflight(appid, { overwrite = false } = {}) {
    const { planGuide } = await import('./guidegen.js');
    const { overwritePreflight, BACKUPS_DIR } = await import('./guidebackup.js');
    const plan = await planGuide(db, {
      config, steam, appid, overwrite, notion: new NotionClient(config),
    });
    const base = { game: plan.game, count: plan.defs.length, target: plan.target };
    if (!plan.existing) return base;

    const pre = overwritePreflight(plan);
    return {
      ...base,
      existing: { kind: plan.existing.kind, url: plan.existing.url },
      boxes: pre.count,
      checked: pre.checked,
      atRisk: pre.atRiskTicks.length,
      backupDir: join(config.guidesDir, BACKUPS_DIR),
    };
  }

  function startBackgroundSync({ guideAppids = [] } = {}) {
    if (syncState.snapshot().running) return { started: false, error: '同步已经在跑了' };
    if (!config.steamApiKey || !config.steamId) {
      // 这句会原样显示在 Dashboard 上,所以不提命令行——没配凭据的话页面本来就会
      // 先跳到设置页,真正走到这里的是极少数(比如中途把 config.json 删了)
      return { started: false, error: 'Steam 凭据还没配置' };
    }

    syncState.begin();
    // 传了 selection,第二阶段才会按 rtime + 轮换扫描取样(CLI 的 sync 仍然是全量)
    const selection = {
      sweepBudget: config.sweepBudget,
      maxStatsAgeDays: config.maxStatsAgeDays,
      perfectGameMaxAgeDays: config.perfectGameMaxAgeDays,
    };
    fullSync(db, steam, { onProgress: (p) => syncState.onProgress(p), selection })
      .then(async (r) => {
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

        // 勾选接在同步后面跑,**期间 running 保持 true**:提示条继续显示、
        // 「立即同步」按钮继续禁用、reloadDashboard 只在最后触发一次。
        // 顺序不能反——勾选要拿刚刷新过的解锁状态去对框,不然对的是上一轮的旧数据。
        const tick = await runCheckboxSync([
          ...new Set([...r.stats.changedAppids, ...guideAppids]),
        ]);
        // 状态收敛放在勾选**之后**:刚打满的那一款,最后几个框应该先勾上再标 Done,
        // 不然页面成了 Done 底下却还留着没勾的框
        const status = await runGuideStatusSync();
        syncState.end(null, {
          bumped: r.stats.bumped,
          ticked: tick.ticked,
          tickError: tick.error,
          statusDone: status.done,
          statusStaged: status.staged,
          statusError: status.error,
        });
      })
      .catch((err) => {
        syncState.end(err);
        log('❌ 后台同步失败:' + (err.stack ?? err));
      });

    return { started: true };
  }

  /**
   * 数据超过 syncStaleHours 就在后台跑一次同步(设 0 表示关掉这个行为)。
   * 返回是否真的起了同步——没起的话,新发现的攻略页得由 startupJobs 单独去勾。
   */
  function maybeAutoSync(guideAppids = []) {
    const hours = config.syncStaleHours;
    if (!hours) return false;
    const last = getMeta(db, 'last_sync');
    const ageH = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
    if (ageH < hours) {
      log(`数据是 ${ageH.toFixed(1)} 小时前同步的(阈值 ${hours}h),这次不自动同步。`);
      return false;
    }

    const r = startBackgroundSync({ guideAppids });
    if (!r.started) {
      log(`⚠️  ${r.error},跳过自动同步。`);
      return false;
    }
    log(last ? `数据已经 ${ageH.toFixed(1)} 小时没更新,开始后台同步...` : '还没有同步记录,开始首次同步...');
    return true;
  }

  /**
   * 启动时的后台任务串。三步之间**有顺序**,不能像以前那样并发扔出去:
   * 攻略发现要先跑完,同步才知道这轮新登记了哪些页;勾选又要等成就数刷新完,
   * 否则拿的是上一轮的解锁状态。
   */
  async function startupJobs() {
    const guideAppids = await syncGuides();
    const started = maybeAutoSync(guideAppids);
    if (started) return; // 勾选和状态收敛已经挂在那条同步链的末尾了

    // 数据够新没触发同步。勾选仍然可能有活干(刚发现的攻略页里,那些框对应的成就
    // 很可能早就解锁了),状态收敛更是每次都该跑一遍——它本来就不依赖"这轮有没有变化"。
    // 和 syncGuides 不受 syncStaleHours 管是同一个道理:Steam 数据新鲜,
    // 不代表 Notion 那边没有待办。
    if (syncState.snapshot().running) return;
    const hasCredentials = Boolean(config.steamApiKey && config.steamId);

    syncState.begin('checkbox');
    const tick = hasCredentials && guideAppids.length
      ? await runCheckboxSync(guideAppids)
      : { ticked: [], error: null };
    const status = await runGuideStatusSync();
    syncState.end(null, {
      ticked: tick.ticked,
      tickError: tick.error,
      statusDone: status.done,
      statusStaged: status.staged,
      statusError: status.error,
    });
  }

  return new Promise((resolve, reject) => {
    /**
     * **listen 失败是异步的 error 事件,不是抛异常。** 没有这个监听,那个 error
     * 根本不经过这个 promise —— `tracker.js` 顶层的 `try { await fn() }` 因此接不到
     * (promise 永远悬着,进程被 uncaught error 直接带走),于是 CLI 里印的是十几行
     * 看不懂的堆栈而不是那句写好的提示。打包版里更糟:堆栈落在一个不存在的控制台上,
     * 启动器手里只剩一个「代码 1」可报。
     *
     * listen 成功后**把监听摘掉**,不顺手改后面的行为:之后再出 error 仍然没人接
     * (照旧崩),而不是 reject 进一个已经 settle 的 promise 里被悄悄吞掉。
     */
    const failStartup = (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `端口 ${config.port} 已被占用 —— 多半是另一个 serve 还在跑(启动器自己就带一个)。` +
              `先退掉那个,或者给 CLI 加 --port 换一个端口。`
            )
          : err
      );
    };
    server.once('error', failStartup);

    server.listen(config.port, '127.0.0.1', () => {
      server.removeListener('error', failStartup);
      log(`\n  Dashboard → http://127.0.0.1:${config.port}\n  停止:Ctrl+C\n`);
      // 后台跑,不挡住 listen 回调——页面要能立刻打开
      startupJobs().catch((err) => log('⚠️  启动任务出错:' + (err.stack ?? err)));
      resolve(server);
    });
  });
}
