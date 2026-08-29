/**
 * 本地 HTTP 服务:给 Dashboard 提供页面和数据接口
 * ------------------------------------------------
 * - GET  /            → Dashboard.html(没配 Steam 凭据时 302 到 /setup)
 * - GET  /setup       → Setup.html(首次设置 + 之后从 Dashboard 进来改设置)
 * - GET  /_rpc.js     → lib/rpc.js(前端调后端用的封装)
 * - POST /api/<方法名> → 调 lib/api.js 里同名方法,body 是 {args: [...]}
 * - POST /restore[?dry=1] → 备份 zip 的二进制上传口(JSON 那条路解不了二进制)
 *
 * 只监听 127.0.0.1,不对局域网/公网暴露。**但那不是一道安全边界** —— 用户在浏览器里
 * 打开的任何一个网页都能往这个端口发请求,所以每一条都要过 `isLocalCaller`。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.js';
import { getMeta } from './db.js';
import { createApi } from './api.js';
import { archiveIdOf } from './guidearchive.js';
import { fullSync } from './sync.js';
import { NotionClient, extractNotionPageId } from './notion.js';
import { syncGuidesFromNotion, syncGuidesFromMarkdown, checkboxSync, syncGuideStatuses } from './guides.js';
import { resolveGuidePath, guideOutline } from './markdown.js';
import { getGuide } from './db.js';
import { generateGuide } from './guidegen.js';
import { patchGuide, planPatch, pickableEntries, PATCH_ROUNDS } from './guidepatch.js';
import { blocksToOutline } from './notionblocks.js';
import { groupBySection, RARE_PCT } from './guidescope.js';
import { createProvider } from './ai.js';
import { isInside } from './pathsafe.js';

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
  /**
   * 已经被认领、但还没走到 `begin()` 或入队的 appid。
   *
   * **`running` 和 `queue` 两个加起来仍然漏一段时间。** 从"决定要生成这一款"到
   * `begin()` 之间隔着预检(两次 Steam 调用)和建供应商,两个都是 await。那段时间里
   * 这一款既不在跑也不在队列里,于是第二次点击会看到一片空白、照样放行 —— 同一款
   * 生成两遍,钱付两遍。这个集合补的就是那一段。
   */
  const claimed = new Set();
  const pending = (id) =>
    claimed.has(id) || (state.running && state.appid === id) || queue.some((q) => q.appid === id);
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

    /** 已经在跑、已经排上、或者已经被认领的 appid —— 用来挡重复点击 */
    isPending(appid) {
      return pending(String(appid));
    },
    /**
     * 认领一个 appid,认领不到返回 false。
     *
     * **判断和占位在同一个同步块里完成**,这是它存在的全部理由:调用方
     * 「先 isPending 再 await 再开跑」的写法必然漏,因为两次点击可以同时通过那次
     * isPending。换成这个之后,第二次点击在 `claimed.add` 之后才跑,一定看得见。
     */
    claim(appid) {
      const id = String(appid);
      if (pending(id)) return false;
      claimed.add(id);
      return true;
    },
    /** 放开认领。入队或 `begin()` 之后就该放 —— 那两个自己会让 isPending 继续成立 */
    release(appid) {
      claimed.delete(String(appid));
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
 * bumped 是"这次发现成就总数变多了"的游戏名单——**Dashboard 这条路径也要交出去**,
 * 那恰恰是自动同步最该说出口的一件事。
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

/**
 * 回环地址的几种写法。Host 和 Origin 两处都拿它当白名单。
 * `[::1]` 带方括号,因为 `new URL(...).hostname` 对 IPv6 字面量就是这么给的
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** `127.0.0.1:8777` / `[::1]:8777` → 主机名那一段(端口不参与判断,端口是可配的) */
function hostnameOf(hostHeader) {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // IPv6 字面量整个带方括号
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * 这个请求是不是这台机器上的这一页发来的。
 *
 * **「只监听 127.0.0.1」挡不住网页。** 用户随便打开的一个站点就能往
 * `http://127.0.0.1:8777/` 发 POST —— `Content-Type: text/plain` 属于 CORS 的
 * 「简单请求」,没有预检可挡。对方读不到回应(那一步才轮到 CORS),但**副作用照样发生**,
 * 而这里的副作用是删游戏、改配置、发起要花钱的生成,以及 `/restore` 那条整库覆盖的路。
 *
 * 两个头各挡一种,少一个都不够:
 *
 * · **Origin** 挡跨站的表单和 fetch。浏览器发跨源请求时一定带它,页面自己改不掉。
 *   **根本没带这个头的原样放行** —— 那是启动器、CLI、测试这类非浏览器调用方,
 *   它们不在这条攻击链上;而字面量 `null`(sandbox iframe、`file://` 页面)要拒,
 *   那是"有来源但说不出口",不是"没有来源"。
 *
 * · **Host** 挡 DNS 重绑定:攻击者把自己的域名解到 127.0.0.1,浏览器就认为同源,
 *   于是上面那条失效 —— 而且这种情况下他**读得到回应**。但此刻 Host 头是他那个域名,
 *   不是回环名字。所以这一条要对 GET 也生效,不能只管有副作用的方法。
 */
export function isLocalCaller(headers = {}) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(headers.host))) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false; // 'null'、畸形值一律拒
  }
}

/**
 * 请求体,带上限。
 *
 * **上限必须在拼之前判,而且判完要掐连接。** 反过来写(先 `raw += chunk` 再看长度)
 * 只是让处理器早点放弃 —— 监听器还挂在那儿,对端继续发,字符串继续长。实测用
 * 1 MB 的上限收 80 MB 的 body,`raw` 结结实实到了 80 MB。`reject` 结束的是这个
 * Promise,不是这条连接。
 */
export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      if (raw.length + chunk.length > limit) return fail(new Error('请求体太大'));
      raw += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(raw);
    });
    req.on('error', fail);
  });
}

/**
 * 二进制 body。**不能复用 readBody** —— 那个用 `raw += chunk` 拼字符串,
 * 等于把每个块按 utf8 解一遍,任何非文本字节都会被替换成 U+FFFD,
 * 而且这件事不报错:传上来的 zip 只是"损坏"。上限也要单独给,
 * 一个几百款游戏的备份轻松超过 JSON 那条 1 MB 线。
 */
export function readBinaryBody(req, limit = 200_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy(); // 同 readBody:不掐掉的话对端会一直发下去
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      if (size + c.length > limit) return fail(new Error('文件太大'));
      size += c.length;
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

/**
 * URL 里的百分号转义。**解不动就返回 null,绝不抛。**
 *
 * `decodeURIComponent('%')` 抛 `URIError`,而请求处理器是 async 的 —— 抛出来就是
 * 一条没人接的 rejection,Node 从 15 起对这个的默认处理是**结束进程**。于是
 * `<img src="http://127.0.0.1:8777/fonts/%">` 挂在任何一个网页上,就能把后台服务
 * 打掉,打包版里显示成「后台服务意外退出(代码 1)」。
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** 根 package.json 的版本号,只给备份清单用。读不到就留空,不值得为它报错 */
function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

export function serve({ db, steam, config, log = console.log }) {
  const syncState = createSyncState();
  const guideGenState = createGuideGenState();
  const api = createApi({
    db, steam, config, syncState, guideGenState,
    startBackgroundSync: () => startBackgroundSync(),
    startGuideGen: (appid, overwrite, effort, scope) => startGuideGen(appid, overwrite, effort, scope),
    planGuidePreflight: (appid, opts) => planGuidePreflight(appid, opts),
    previewGuidePatch: (appid) => previewGuidePatch(appid),
    // 包成箭头函数,和上面几个一样——maybeAutoSync 是这个闭包里的函数声明,
    // 直接传引用也行,但保持一致比省一层更值钱
    maybeAutoSync: () => maybeAutoSync(),
    // 写进备份清单,恢复时用来判断格式读不读得动
    appVersion: readPkgVersion(),
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

  /**
   * 真正的分发。**外面必须包一层 catch**(见 `createServer` 那里),所以这里
   * 尽管往下写,不用为每条路径各写一个兜底。
   */
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // 每一条都过,GET 也不例外 —— DNS 重绑定读得到回应,挡它只能靠 Host
    if (!isLocalCaller(req.headers)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('只接受本机页面的请求');
    }

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

    // 本地 markdown 攻略。**以纯文本伺服,不渲染成 HTML** —— 攻略正文是 AI 生成的,
    // 而这个页面能调 /api/*(改数据、发起会花钱的生成)。把那段内容当 HTML 插进来
    // 等于给一个能写数据的页面开了 XSS 口子。想要好看的排版就用编辑器打开文件。
    //
    // 路径来自 guides 表而不是 URL:URL 里只有 appid。就算表里的 url 被写歪了,
    // resolveGuidePath 还会挡一道(不许越出 guidesDir)。
    if (req.method === 'GET' && url.pathname.startsWith('/guide/')) {
      const appid = safeDecode(url.pathname.slice('/guide/'.length));
      if (appid === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('路径里的转义解不动');
      }
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
      const rel = safeDecode(url.pathname.slice('/fonts/'.length));
      if (rel === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('路径里的转义解不动');
      }
      const ext = rel.slice(rel.lastIndexOf('.'));
      if (ext !== '.css' && ext !== '.woff2') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('不是字体资源');
      }
      const base = join(ROOT, 'assets', 'fonts');
      const target = resolve(base, rel);
      if (!isInside(base, target)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('路径越界');
      }
      return sendFile(res, target, ext, 'public, max-age=31536000, immutable');
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    /**
     * 恢复用的**二进制**上传口。为什么不走 /api/ 的 JSON 分发:那条路把 body
     * 按字符串拼(`raw += chunk`,等于按 utf8 解码,二进制会被解坏),而且卡在 1 MB。
     *
     * `?dry=1` 只看不写 —— 界面要在覆盖用户数据**之前**说清楚这个文件里是什么。
     * 代价是同一个文件传两遍,在 127.0.0.1 上传 1 MB 是白送的,换来的是
     * 服务端不用为了一次确认去存一份待定状态。
     */
    if (req.method === 'POST' && url.pathname === '/restore') {
      let buf;
      try {
        buf = await readBinaryBody(req);
      } catch (err) {
        return sendJson(res, 413, { ok: false, error: String(err.message ?? err) });
      }
      const dry = url.searchParams.get('dry') === '1';
      const keepConfig = url.searchParams.get('keepConfig') === '1';
      const result = dry ? api.inspectBackupFile(buf) : api.applyRestore(buf, { keepConfig });
      if (result.error) log('[restore] ' + result.error);
      return sendJson(res, 200, { ok: !result.error, result });
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
  };

  /**
   * **处理器抛出来的任何东西都要在这里落地。**
   *
   * 这个回调是 async 的:里面抛一次异常 = 一条没人接的 rejection = 进程退出
   * (Node ≥15 的默认行为)。也就是说,任何一条没想到的输入都不是"这一次请求 500",
   * 而是"整个后台服务没了"。已知的那个洞(畸形百分号转义)在 `safeDecode` 里堵掉了,
   * 但堵一个洞和"再也不会因为这个死"是两件事,后者只能靠这一层。
   */
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('[http] ' + req.method + ' ' + req.url + ' 出错: ' + (err?.stack ?? err));
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('服务器内部错误');
    });
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
  async function startGuideGen(appid, overwrite = false, effort = null, scope = null) {
    if (!config.ai?.apiKey) return { started: false, error: '还没配置 AI —— 去设置页填一个供应商和 key' };
    // **认领,不是查一下。** 下面立刻就有 await(预检要打两次 Steam),
    // 「查完再 await 再开跑」中间那段时间里第二次点击什么都看不见,于是同一款
    // 会被放行两次 —— 生成跑两遍、钱付两遍。见 claim() 的注释
    if (!guideGenState.claim(appid)) {
      return { started: false, error: '这一款已经在生成或排队里了' };
    }
    try {
      return await startGuideGenClaimed(appid, overwrite, effort, scope);
    } finally {
      // 到这里要么进了队列、要么已经 begin()、要么失败了 —— 三种都不再需要认领占位
      guideGenState.release(appid);
    }
  }

  async function startGuideGenClaimed(appid, overwrite, effort, scope) {
    let plan;
    try {
      // 不传 overwrite 的话 planGuide 会因为"已经有攻略了"直接拒绝 —— 那正是没加
      // --overwrite 时该有的行为,所以这里把标志一路带下去,不要在服务端偷偷放行。
      //
      // **局部重写走 planPatch,而不是 planGuidePreflight 再加个判断。** 它多验一件
      // 事:选择器解析得出来吗、选中的那几条在攻略里定位得到吗。那两条必须在**入队时**
      // 就拦下 —— 否则一个拼错的范围会安静地排二十分钟队,轮到它才说"一条都没选中"
      plan = scope
        ? await planPatchPreflight(appid, scope)
        : await planGuidePreflight(appid, { overwrite });
    } catch (err) {
      return { started: false, error: String(err.message ?? err) };
    }

    if (guideGenState.snapshot().running) {
      const position = guideGenState.enqueue({ appid, overwrite, effort, scope, game: plan.game });
      log(`🕒 排队等生成:${plan.game}(${appid}),队列第 ${position} 个`);
      return { started: false, queued: true, position, game: plan.game };
    }

    return runGuideGen({ appid, overwrite, effort, scope, game: plan.game });
  }

  /**
   * 真正开跑。**入队和开跑分开**,因为跑完要从队列里取下一个接着跑,那条路上
   * 没有「要不要排队」这个问题 —— 合在一起会绕回自己
   */
  async function runGuideGen({ appid, overwrite, effort, scope = null, game }) {
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

    const rounds = scope ? PATCH_ROUNDS : (config.ai.maxRounds ?? 3);
    guideGenState.begin(appid, game, rounds);
    log(scope ? `🤖 开始局部重写:${game}(${appid})· ${scope.selector}` : `🤖 开始生成攻略:${game}(${appid})`);

    /** 一个跑完就接下一个。成功失败都要走,否则一次失败会把整条队列卡死 */
    const drainNext = () => {
      const next = guideGenState.dequeue();
      if (next) runGuideGen(next);
    };

    /**
     * 局部重写和整篇生成是两条流水线,但**收尾只有一条**。
     *
     * 两条各自 `.then/.catch` 一遍的话,`drainNext` 就有了两份 —— 而
     * `guidequeue.test.js` 钉着的正是"它必须挂在 then 和 catch 两边",因为漏一处
     * 就是一次失败把整条队列永久卡死、没有错误也没有超时。一份收尾,一处并发保护
     */
    const job = scope
      ? patchGuide(db, {
        config: runConfig, provider, steam, appid, notion: new NotionClient(config),
        selector: scope.selector,
        instruction: scope.note || null,
        rounds,
        onProgress(ev) {
          if (ev.phase === 'plan') {
            guideGenState.onProgress({ phase: 'plan', note: `只改 ${ev.scope}/${ev.of} 条` });
          } else if (ev.phase === 'write') {
            guideGenState.onProgress({ phase: 'ask', round: ev.round, note: `查资料 + 重写 ${ev.scope} 条` });
          } else if (ev.phase === 'rewrite') {
            guideGenState.onProgress({ phase: 'rewrite', note: '按校验结果再改一次' });
          } else if (ev.phase === 'retry') {
            guideGenState.onProgress({ phase: 'ask', note: '没拿到正文,再问一次' });
          } else if (ev.phase === 'check') {
            // **少写了几条要留在屏幕上,不能被下一行盖掉。** 这是这条路上唯一一种
            // 闸门全绿而请求没被满足的情况,`note` 三秒后就会被覆盖,所以走 warn
            if (ev.missing) guideGenState.warn(`模型少写了 ${ev.missing} 条,正在重问`);
            if (ev.extra) guideGenState.warn(`模型多写了 ${ev.extra} 条没点名的,已忽略`);
            guideGenState.onProgress({ phase: 'check', note: `交回 ${ev.wrote}/${ev.of} 条,校验` });
          } else if (ev.phase === 'lint') {
            guideGenState.onProgress({ phase: 'lint', note: `这次要改 ${ev.caused} 条,旧问题 ${ev.preExisting} 条` });
          } else if (ev.phase === 'tool') guideGenState.onProgress({ phase: 'tool', note: ev.name });
          else if (ev.phase === 'notion-patch') guideGenState.onProgress({ phase: 'check', note: `改「${ev.name}」` });
          else if (ev.phase === 'notion-verify') guideGenState.onProgress({ phase: 'check', note: '回读整页校验' });
          else if (ev.phase === 'warn') guideGenState.warn(ev.note);
        },
      })
      : generateGuide(db, {
      // 传这一次的那份,不传共享的 —— generateGuide 今天不读 ai.effort,但两个名字
      // 摆在一起时,传错的那个不会报错,只会在将来某天悄悄用上全局值
      config: runConfig, provider, steam, appid, rounds, overwrite, notion: new NotionClient(config),
      onProgress(ev) {
        // 分段写的时候必须把"第几段"报出来:几百个成就要跑十来分钟,
        // 只显示"第 1/3 轮"的话进度条整段时间一动不动,看着像卡死了
        const seg = ev.chunks > 1 ? `${ev.chunk}/${ev.chunks} 段 · ` : '';
        if (ev.phase === 'plan' && ev.chunks > 1) {
          guideGenState.onProgress({ phase: 'plan', note: `${ev.achievements} 个成就,分 ${ev.chunks} 段` });
        } else if (ev.phase === 'regroup') {
          // 这一趟也要几十秒。**不报的话浮窗整段时间一动不动**,和上面那条注释同一个理由
          guideGenState.onProgress({ phase: 'plan', note: '正文写完,统一分区' });
        } else if (ev.phase === 'regroup-done') {
          guideGenState.onProgress({ phase: 'plan', note: `分区统一好了(${ev.sections} 个)` });
        } else if (ev.phase === 'regroup-failed') {
          // 走 warn 不走 note:降级的后果留在成品上,而 note 三秒后就被下一行盖掉
          guideGenState.warn('分区没统一成,同类成就可能散在几个小节里');
        } else if (ev.phase === 'regroup-merged') {
          guideGenState.onProgress({ phase: 'plan', note: `${ev.clusters} 组同类成就合到了一起` });
        } else if (ev.phase === 'unwrapped-toggles') {
          guideGenState.onProgress({ phase: 'plan', note: `摊开了 ${ev.titles.length} 个折叠` });
        } else if (ev.phase === 'unwrap-failed') {
          // 同上:后果留在成品上(那一节点开还是空的),不能让它三秒后被盖掉
          guideGenState.warn('有一节的成就藏在折叠里,页面上看不见');
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
    });

    job
      .then((r) => {
        guideGenState.end(null, {
          ok: r.ok,
          // 局部重写才有的三个数。**「改了几条」和「其余没动」要一起报** ——
          // 只说前者的话,用户没法把它和整篇重写区分开,而不动那部分正是他选它的理由
          patched: scope ? {
            selector: scope.selector,
            rewrote: (r.rewrote ?? []).length,
            scoped: (r.scope ?? []).length,
            missing: (r.missing ?? []).length,
            // 旧攻略本来就有的问题:这次没碰,也没拦路 —— 但必须说出来
            preExisting: (r.preExisting ?? []).length,
            unlocatable: (r.unlocatable ?? []).length,
          } : null,
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
          // 这次覆盖前存下来的那一份。**交出去的是存档编号,不是绝对路径** ——
          // 页面上要能拿它去调 `deleteGuideArchive`,而那个接口只认编号;
          // 路径拼编号的活交给 `archiveIdOf`,免得两边的格式各写一份。
          // 整篇新生成的攻略没有备份(没有旧的可存),那时候是 null,
          // 界面据此决定给不给「删除备份」那个动作
          backup: r.backup?.path
            ? { id: archiveIdOf(config, r.backup.path), bytes: r.backup.bytes }
            : null,
        });
        for (const c of r.chunkFailures ?? []) {
          log(`⚠️ 第 ${c.chunk}/${c.of} 段(${c.count} 个成就)没写出来:${c.reason.split('\n')[0]}`);
        }
        if (scope) {
          // 局部重写没过的时候**原攻略一个字都没动** —— 这句必须落进日志,
          // 否则「没过校验」读起来像是攻略被改坏了,而事实正相反
          log(r.ok
            ? `✅ 局部重写完成:改了 ${(r.rewrote ?? []).length} 条 → ${r.url}`
            : `⚠️ 局部重写没过校验,原攻略未改动:${r.url}`);
        } else {
          log(r.ok ? `✅ 攻略写完:${r.url}` : `⚠️ 攻略没过校验,草稿留在 ${r.draftPath}`);
        }
        drainNext();
      })
      .catch((err) => {
        guideGenState.end(err);
        log((scope ? '❌ 局部重写失败:' : '❌ 攻略生成失败:') + (err.stack ?? err));
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

  /**
   * 局部重写的预检:**一次 plan,四个预设的数字一起交出去**。
   *
   * 前端因此只花一次往返就能把整排按钮画出来、每个按钮上带着它自己的条数。点按钮
   * 不再有延迟 —— 而"点一下等半秒才出数字"会让人以为点漏了、再点一次。
   *
   * 和 `planGuidePreflight` 一样交**数字不交句子**:命令行给敲了 flag 的人看,
   * 可以详细;弹窗要短。硬凑一份共用文案的结果是两边都不合适。
   */
  async function previewGuidePatch(appid) {
    const notion = new NotionClient(config);
    const { plan, baseline, oldText, kind } = await planPatch(db, {
      config, steam, appid, notion,
      // 只要 plan 和基线校验,这里没有"范围"可言 —— 四个预设各自的范围下面再算
      selector: null,
    });

    /**
     * 小节结构。两个后端各出一份大纲,汇成同一种序列再分组。
     *
     * **Notion 这边要多读一次整页**(`fetchAllBlocks`),因为 `planPatch` 拿到的
     * `oldTodos` 来自 `fetchAllToDoBlocks`,那个函数只收 checkbox —— 标题在它眼里
     * 不存在。多的这次是同一页的第二次遍历,发生在用户主动点开对话框的时候,
     * 换来的是他真正那批攻略(全在 Notion)能按小节挑。
     *
     * 读失败**不算失败**:分组只是呈现,拿不到就退回一个平铺列表,挑选照样能用。
     * 为了一个分组把整个对话框打不开,是拿主功能给锦上添花的东西陪葬
     */
    let groups = [];
    try {
      const outline = kind === 'local'
        ? guideOutline(oldText ?? '')
        : blocksToOutline(await notion.fetchAllBlocks(extractNotionPageId(plan.existing.url)));
      groups = groupBySection(outline, plan.defs);
    } catch (err) {
      log(`⚠️ 读小节结构失败(${plan.game}),挑选列表退回平铺:${err.message ?? err}`);
    }

    return {
      game: plan.game,
      total: plan.defs.length,
      target: kind,
      url: plan.existing.url,
      boxes: plan.oldTodos.length,
      // 自选用的清单:按小节分组,每条带名字、稀有度、解锁状态
      pickable: pickableEntries({ plan, groups }),
      // **阈值跟着数据一起下发,不让前端自己写一个 15。** 「稀有」那个快捷键选谁、
      // 百分比什么时候标成强调色,和提示词判断哪几条要写深,必须是同一条线 ——
      // 分两处写迟早对不上,而对不上的表现是"界面说它稀有、程序不这么认为"
      rarePct: RARE_PCT,
    };
  }

  /** 真正入队前的那次:选择器解析得出来吗、选中的那几条定位得到吗。拒绝理由由 planPatch 抛 */
  async function planPatchPreflight(appid, scope) {
    const { plan, entries } = await planPatch(db, {
      config, steam, appid, notion: new NotionClient(config), selector: scope?.selector,
    });
    return { game: plan.game, count: entries.length };
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
   * 启动时的后台任务串。三步之间**有顺序**,不能并发扔出去:
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
