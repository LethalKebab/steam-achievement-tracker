/**
 * Local HTTP server: serves the Dashboard's pages and data endpoints
 * ------------------------------------------------
 * - GET  /            → Dashboard.html (302 to /setup when Steam credentials are missing)
 * - GET  /setup       → Setup.html (first-run setup, and later entered from the Dashboard)
 * - GET  /_rpc.js     → lib/rpc.js (the wrapper the frontend calls the backend through)
 * - POST /api/<method> → calls the same-named method in lib/api.js; the body is {args: [...]}
 * - POST /restore[?dry=1] → binary upload endpoint for a backup zip (the JSON path cannot carry binary)
 *
 * Listens on 127.0.0.1 only, never exposed to the LAN or the internet. **But that is not a
 * security boundary** — any web page the user opens in their browser can send requests to this
 * port, so every one of them has to pass `isLocalCaller`.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.js';
import { getMeta } from './db.js';
import { msg, setMessageLanguage } from './messages.js';
import { clog } from './cli-messages.js';
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
 * Background state for guide generation.
 *
 * **Deliberately not shared with syncState.** Syncing and generating are two different things: a
 * generation runs for two or three minutes, and the user may well press 「立即同步」 during it.
 * With one shared state the later `begin()` would wipe out the earlier one's progress and result
 * entirely, and neither side would raise an error — the page would just show the progress bar
 * jumping backwards for no visible reason. One state each, one concurrency gate each.
 *
 * The result carries `researched` and `searchQueries`: **"can search" and "did search" are two
 * different things**, and the user cannot tell the difference from the page, so it has to be
 * written out (the same reason as on the CLI side).
 */
export function createGuideGenState() {
  const idle = {
    running: false, appid: null, game: '', phase: null, round: 0, rounds: 0,
    note: '', errorNote: null, at: null,
    /**
     * The things that have to survive the run. **Not through `note`** — that slot is "what is
     * happening right now" and the next progress event overwrites it, while a sentence like
     * 「第 3 段未生成」 has to stay until somebody sees it at the end. Same reason as syncState's
     * `bumped`/`ticked`: reporting something that **already happened** must not share a slot with
     * progress.
     */
    warnings: [],
    result: null, // {ok, path, rounds, covered, total, warnings, researched, searchQueries, usage}
  };
  let state = { ...idle };
  /**
   * The ones whose turn has not come. **The queue lives here rather than in server.js's closure**
   * so it is handed out together with `snapshot()` — the page shows "how many are queued", and
   * that is the other half of "which one is running now"; storing them in two places means one of
   * them eventually stops being updated.
   *
   * Running one at a time is deliberate: generation needs the network and costs money, and running
   * them in parallel both hits the provider's rate limit and makes "how much was spent"
   * unattributable.
   */
  let queue = [];
  /**
   * The ones that have finished. **Lives outside state**, for the same reason as `queue` plus a
   * harder one: `begin()` is `{ ...idle }`, so anything put in state is wiped the moment the next
   * task starts.
   *
   * And "the previous one finished" has to survive that moment. Between one queued job finishing
   * and the next `begin()` there is only `drainNext()` and one dynamic import in `createProvider()`
   * (cached, no network) — that is a single microtask; the page polls every three seconds, so the
   * result in `state.result` is **essentially impossible to observe**.
   *
   * The symptom: queue up several games and nobody sees any result but the last one — the guide
   * link never appears and that row's button stays greyed out until the page is refreshed. It
   * looks like "the first one finished but the UI didn't refresh".
   *
   * The page takes increments by `seq` and never looks at one twice; the cap only stops somebody
   * queueing dozens from bloating the snapshot.
   */
  let finished = [];
  let seq = 0;
  const FINISHED_KEEP = 20;
  /**
   * appids that have been claimed but have not yet reached `begin()` or the queue.
   *
   * **`running` and `queue` together still leave a window.** Between "decided to generate this
   * one" and `begin()` sit the preflight (two Steam calls) and building the provider, both awaits.
   * During that window the game is neither running nor queued, so a second click sees a blank slate
   * and is let through — the same game generated twice and paid for twice. This set covers that
   * window.
   */
  const claimed = new Set();
  const pending = (id) =>
    claimed.has(id) || (state.running && state.appid === id) || queue.some((q) => q.appid === id);
  /**
   * Whether the single running slot is spoken for by a job that has not reached `begin()` yet.
   *
   * **`claimed` closes the window for one appid; this closes it for every other one.** They are two
   * different questions: `claimed` answers "is *this game* already on its way", which is what stops
   * a double click, while this answers "is *anything* already on its way", which is what keeps the
   * one-at-a-time rule (see the note on `queue`). Two different appids both pass `claim()` by
   * design, and with only `state.running` to consult they would both read `false` — neither has
   * reached `begin()` — and both start. Two generations in parallel, both paid for.
   */
  let runReserved = false;
  /**
   * The running job's `AbortController`, if any. **Lives here, not in a `server.js` closure
   * variable**, for the same reason `queue` does: `runGuideGen` sets it right alongside `begin()`
   * and clears it right alongside `end()`, so keeping the two pairs in one object is what stops
   * them drifting apart — a controller left set after the job it belonged to finished would let a
   * *later* job's cancel button abort a request that already succeeded.
   */
  let controller = null;

  /** Identity for `warn`'s de-duplication — two notices are the same one when both halves match */
  const noteId = (w) => (typeof w === 'string' ? w : `${w.key}|${JSON.stringify(w.values ?? null)}`);
  /**
   * A stored notice, in the language being spoken **now**.
   *
   * A plain string still renders as itself: an error not raised through `msgError` arrives that
   * way, and so would a caller nobody converted. Those keep the behaviour they had rather than
   * putting `[object Object]` in front of somebody.
   */
  const renderNote = (w) => (typeof w === 'string' ? w : msg(w.key, w.values));

  return {
    snapshot: () => ({
      ...state,
      errorNote: undefined,
      error: state.errorNote ? renderNote(state.errorNote) : null,
      warnings: state.warnings.map(renderNote),
      queue: queue.map((q) => ({ appid: q.appid, game: q.game })),
      finished: finished.map((f) => ({
        ...f,
        errorNote: undefined,
        error: f.errorNote ? renderNote(f.errorNote) : null,
        warnings: f.warnings.map(renderNote),
      })),
    }),
    begin(appid, game, rounds) {
      // The reservation existed to hold the slot until exactly this moment; `running` holds it now
      runReserved = false;
      state = { ...idle, running: true, appid: String(appid), game, rounds, at: new Date().toISOString() };
    },
    onProgress(p) {
      state = { ...state, ...p };
    },
    /**
     * Accumulates one notice that has to survive the run. `onProgress` has merge semantics, so
     * appending needs its own entrance.
     *
     * **It takes the entry, not the sentence.** A `note` from `onProgress` is transient — the next
     * one covers it seconds later — so composing that one on the spot is right. These are the
     * opposite: they stay in `finished` after the run, and the interface language can change while
     * they sit there. Composed at this moment a warning is frozen in whatever language the run
     * started in, and no later switch can repaint it — which is how a single English line came to
     * sit on an otherwise Chinese card. `snapshot` composes them when the page reads them instead.
     */
    warn(note) {
      if (!note) return;
      const id = noteId(note);
      if (state.warnings.some((w) => noteId(w) === id)) return;
      state = { ...state, warnings: [...state.warnings, note] };
    },
    end(error, result = null) {
      state = {
        ...state,
        running: false,
        phase: null,
        note: '',
        // An error raised through `msgError` still knows which entry it is; one that was not keeps
        // its text, and `renderNote` hands that through untouched
        errorNote: error
          ? (error.msgKey ? { key: error.msgKey, values: error.msgValues } : String(error.message ?? error))
          : null,
        result,
      };
      /**
       * A second copy of the same result for the page to take incrementally. **Both successes and
       * failures go in** — the failure entry is equally responsible for un-greying that row, and
       * missing it leaves the row greyed out forever; and since nobody goes to click something
       * that just failed, that omission surfaces even later than the success one would.
       *
       * `warnings` travels with it: those sentences ("第 3 段未生成") describe **what is missing
       * from the finished product**, they vanish the moment the next task calls `begin()`, and they
       * have to stay on screen alongside the result.
       */
      finished = [...finished, {
        seq: ++seq,
        appid: state.appid,
        game: state.game,
        errorNote: state.errorNote,
        result,
        warnings: state.warnings,
        at: new Date().toISOString(),
      }].slice(-FINISHED_KEEP);
    },

    /** An appid that is running, queued or already claimed — used to block a repeated click */
    isPending(appid) {
      return pending(String(appid));
    },
    /**
     * Claims an appid, returning false when it cannot be claimed.
     *
     * **The test and the reservation happen in the same synchronous block**, which is its entire
     * reason for existing: a caller writing "check isPending, then await, then start" necessarily
     * leaks, because two clicks can pass that isPending simultaneously. With this, the second click
     * runs after `claimed.add` and is guaranteed to see it.
     */
    claim(appid) {
      const id = String(appid);
      if (pending(id)) return false;
      claimed.add(id);
      return true;
    },
    /** Releases a claim. It should be released once queued or once `begin()` has run — those two keep isPending true on their own */
    release(appid) {
      claimed.delete(String(appid));
    },
    /**
     * Takes the single running slot, or returns false when something already holds it.
     *
     * **Test and reservation in one synchronous block**, the same reason `claim()` gives: a caller
     * that asks `snapshot().running` and only then awaits has already lost the race, because the
     * job it is racing has not reached `begin()` either. Whoever gets `true` must reach either
     * `begin()` or `releaseRun()`; there is no third ending.
     */
    reserveRun() {
      if (state.running || runReserved) return false;
      runReserved = true;
      return true;
    },
    /** Gives the slot back without having started — the reserving path failed before `begin()` */
    releaseRun() {
      runReserved = false;
    },
    enqueue(item) {
      queue.push({ ...item, appid: String(item.appid) });
      return queue.length;
    },
    dequeue: () => queue.shift() ?? null,
    queueLength: () => queue.length,
    /** A global failure such as a misconfigured provider: drop the queue rather than letting them all fail one by one */
    clearQueue() {
      const dropped = queue;
      queue = [];
      return dropped;
    },

    /** Records the running job's controller, or clears it once the job has settled (pass null) */
    setController(c) {
      controller = c;
    },
    /**
     * Aborts the job currently running, if there is one. Returns whether there was.
     *
     * **Does not touch `state` itself** — that happens exactly once, in `runGuideGen`'s own
     * `.catch`, the same place every other ending of a run is recorded. Two writers deciding when
     * a run is "over" is how `end()` ends up called twice for one job, the second call's `result:
     * null` quietly overwriting the first's.
     */
    cancelRunning() {
      if (!controller) return false;
      controller.abort();
      return true;
    },
    /**
     * Removes a queued job before its turn comes, and synthesises a `finished` record for it —
     * without one, the row that started it stays greyed out forever: `setGuideBusy(appid, false)`
     * on the Dashboard only ever fires off an entry in `finished`, and a job that never reaches
     * `begin()` produces none on its own. Returns false when the appid was not queued (already
     * running, already finished, or never existed — the caller tells those apart itself).
     */
    cancelQueued(appid) {
      const id = String(appid);
      const idx = queue.findIndex((q) => q.appid === id);
      if (idx === -1) return false;
      const [item] = queue.splice(idx, 1);
      finished = [...finished, {
        seq: ++seq,
        appid: id,
        game: item.game,
        errorNote: null,
        result: { ok: false, cancelled: true },
        warnings: [],
        at: new Date().toISOString(),
      }].slice(-FINISHED_KEEP);
      return true;
    },
  };
}

/**
 * Progress state for the background sync, used by /api/syncStatus and the status bar.
 * bumped is the list of games whose achievement total was found to have grown this run — **this
 * path has to hand it out too**, since that is precisely the thing an automatic sync most needs to
 * say out loud.
 *
 * ticked / tickError are the results of the automatic checkbox pass, kept apart from error
 * deliberately: Notion being down must not make the page display "sync failed" when the
 * achievement counts refreshed perfectly well.
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
 * The several spellings of the loopback address. Both the Host and the Origin check use it as a
 * whitelist.
 * `[::1]` carries its brackets, because that is exactly how `new URL(...).hostname` hands back an
 * IPv6 literal
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** `127.0.0.1:8777` / `[::1]:8777` → just the hostname part (the port plays no part in the decision; it is configurable) */
function hostnameOf(hostHeader) {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // an IPv6 literal keeps its brackets
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * Whether this request came from this page on this machine.
 *
 * **"Listens on 127.0.0.1 only" does not keep web pages out.** Any site the user happens to open
 * can POST to `http://127.0.0.1:8777/` — `Content-Type: text/plain` is a CORS "simple request", so
 * there is no preflight to stop it. They cannot read the response (CORS only enters at that step),
 * but **every side effect still lands**, and the side effects here are deleting games, rewriting
 * the config, kicking off a generation that spends money, and `/restore`, which replaces the whole
 * database.
 *
 * Two headers, each covering one thing, and neither is sufficient alone:
 *
 * · **Origin** blocks cross-site forms and fetches. The browser always sends it on a cross-origin
 *   request and a page cannot alter its own. **A request with no such header at all is allowed
 *   through** — that is the launcher, the CLI and the tests, non-browser callers that are not on
 *   this attack chain; while the literal `null` (a sandboxed iframe, a `file://` page) is refused,
 *   because that is "has an origin it cannot state", not "has no origin".
 *
 * · **Host** blocks DNS rebinding: an attacker resolves their own domain to 127.0.0.1, the browser
 *   considers it same-origin, and the check above stops working — and in that case they **can**
 *   read the response. But at that moment the Host header is their domain, not a loopback name. So
 *   this check has to apply to GET as well, not only to methods with side effects.
 */
export function isLocalCaller(headers = {}) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(headers.host))) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false; // 'null' and malformed values are all refused
  }
}

/**
 * The request body, with a cap.
 *
 * **The cap has to be checked before appending, and the connection killed once it trips.** Written
 * the other way round (`raw += chunk` first, then check the length) it merely makes the handler
 * give up early — the listener is still attached, the peer keeps sending, and the string keeps
 * growing. Measured: a 1 MB cap fed an 80 MB body ended with a solid 80 MB in `raw`. `reject` ends
 * the promise, not the connection.
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
      if (raw.length + chunk.length > limit) return fail(new Error(msg('http.bodyTooBig')));
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
 * A binary body. **readBody cannot be reused** — that one concatenates a string with
 * `raw += chunk`, which decodes every chunk as utf8, so any non-text byte is replaced with U+FFFD,
 * and it does so without raising an error: the uploaded zip is simply "corrupt". The cap has to be
 * separate too — a backup of a library with a few hundred games comfortably exceeds the JSON
 * path's 1 MB line.
 */
export function readBinaryBody(req, limit = 200_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy(); // as in readBody: without killing it the peer keeps sending
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      if (size + c.length > limit) return fail(new Error(msg('http.fileTooBig')));
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
 * Percent-escapes in a URL. **Returns null when it cannot decode; never throws.**
 *
 * `decodeURIComponent('%')` throws a `URIError`, and the request handler is async — a throw there
 * is an unhandled rejection, which Node has answered since 15 by **ending the process**. So
 * `<img src="http://127.0.0.1:8777/fonts/%">` on any web page is enough to take the background
 * service down, showing up in the packaged build as 「后台服务意外退出(代码 1)」.
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The root package.json's version, used only in the backup manifest. Left empty when unreadable — not worth erroring over */
function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

export function serve({ db, steam, config, log = console.log }) {
  // **Before anything can fail.** lib/'s messages are composed from their own table against a
  // module-level language (see lib/messages.js for why it is not an argument), and a failure during
  // startup composes its message before any request has been served — so this cannot wait for the
  // first one
  setMessageLanguage(config.uiLanguage);
  const syncState = createSyncState();
  const guideGenState = createGuideGenState();
  const api = createApi({
    db, steam, config, syncState, guideGenState,
    startBackgroundSync: () => startBackgroundSync(),
    startGuideGen: (appid, overwrite, effort, scope) => startGuideGen(appid, overwrite, effort, scope),
    cancelGuideGen: (appid) => cancelGuideGen(appid),
    planGuidePreflight: (appid, opts) => planGuidePreflight(appid, opts),
    previewGuidePatch: (appid) => previewGuidePatch(appid),
    // Wrapped in an arrow function like the ones above — maybeAutoSync is a function declaration in
    // this closure so passing the reference directly would work, but staying consistent is worth
    // more than saving one layer
    maybeAutoSync: () => maybeAutoSync(),
    // Written into the backup manifest, used at restore time to judge whether the format is readable
    appVersion: readPkgVersion(),
  });

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  // cacheControl defaults to no-store — the HTML and rpc.js are edited and refreshed constantly, so
  // caching only gets in the way. Fonts are the sole exception, see the /fonts/ section.
  const sendFile = (res, path, ext, cacheControl = 'no-store') => {
    try {
      const body = readFileSync(path);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cacheControl });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg('http.readFailed', { reason: err.message }));
    }
  };

  /**
   * The actual dispatch. **An outer catch is mandatory** (see the `createServer` below), so this
   * can be written straight through without a fallback per route.
   */
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Every request goes through it, GET included — DNS rebinding can read responses, and Host is
    // the only thing that blocks it
    if (!isLocalCaller(req.headers)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(msg('http.notLocal'));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // When it is packaged for somebody else, missing Steam credentials should not land them on an
      // empty Dashboard — go to the setup page instead, and once completeSetup saves, the Electron
      // main process restarts the child and brings them back here.
      if (!config.steamApiKey || !config.steamId) {
        res.writeHead(302, { Location: '/setup' });
        return res.end();
      }
      return sendFile(res, join(ROOT, 'Dashboard.html'), '.html');
    }
    if (req.method === 'GET' && url.pathname === '/setup') {
      return sendFile(res, join(ROOT, 'Setup.html'), '.html');
    }

    // Local markdown guides. **Served as plain text, never rendered as HTML** — guide bodies are AI
    // generated, and this page can call /api/* (changing data, starting a generation that costs
    // money). Injecting that content as HTML would open an XSS hole into a page that can write
    // data. Open the file in an editor for nicely formatted reading.
    //
    // The path comes from the guides table rather than the URL: the URL only holds the appid. Even
    // if a url in the table were written wrong, resolveGuidePath still blocks it (it may not leave
    // guidesDir).
    if (req.method === 'GET' && url.pathname.startsWith('/guide/')) {
      const appid = safeDecode(url.pathname.slice('/guide/'.length));
      if (appid === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(msg('http.badEscape'));
      }
      const row = getGuide(db, appid);
      if (!row || row.kind !== 'local') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(msg('http.noLocalGuide'));
      }
      try {
        const body = readFileSync(resolveGuidePath(config.guidesDir, row.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(msg('http.guideReadFailed', { reason: err.message }));
      }
    }
    if (req.method === 'GET' && url.pathname === '/_rpc.js') {
      return sendFile(res, join(ROOT, 'lib', 'rpc.js'), '.js');
    }

    /* Self-hosted fonts. **This section exists so the app does not change appearance on a different
       machine** — where the previous font stack (Segoe UI → system fallback) landed for Chinese was
       nobody's guess: measured on this machine it was neither Yahei nor the Noto Sans SC named in
       the stack, and the three weights 600/650/700 rendered with **exactly the same ink**, meaning
       the three tiers the design system declares were really one tier in Chinese. Bundling the font
       makes both problems disappear at once.

       Noto Sans SC Variable (OFL-1.1; the LICENSE sits next to the font, as the licence requires),
       sliced into 101 shards by unicode-range — the browser only fetches the shards holding
       characters that actually appear on screen, not 4.7MB at once. Weight is a **variable axis
       100–900**, so every weight shares the same set of files.

       Two constraints:
       · **Only .css and .woff2 are allowed through, and the path is pinned inside assets/fonts.**
         The same reasoning as resolveGuidePath — what gets joined into the path comes from the URL,
         and skipping the containment check is a directory traversal.
       · **Fonts need a long cache.** Every other static file is no-store (edit and refresh), but
         fonts do not change, and this page uses dozens of shards on every open; no-store would make
         it re-download them every time. */
    if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
      const rel = safeDecode(url.pathname.slice('/fonts/'.length));
      if (rel === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(msg('http.badEscape'));
      }
      const ext = rel.slice(rel.lastIndexOf('.'));
      if (ext !== '.css' && ext !== '.woff2') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(msg('http.notAFont'));
      }
      const base = join(ROOT, 'assets', 'fonts');
      const target = resolve(base, rel);
      if (!isInside(base, target)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(msg('http.outOfBounds'));
      }
      return sendFile(res, target, ext, 'public, max-age=31536000, immutable');
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    /**
     * The **binary** upload endpoint used by restore. Why not the JSON dispatch under /api/: that
     * path concatenates the body as a string (`raw += chunk`, i.e. utf8 decoding, which corrupts
     * binary) and is capped at 1 MB.
     *
     * `?dry=1` looks without writing — the UI has to explain what is in this file **before**
     * overwriting the user's data. The cost is uploading the same file twice, which over 127.0.0.1
     * is free for 1 MB, and what it buys is a server that never has to hold pending state just to
     * support one confirmation.
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
      if (typeof fn !== 'function') return sendJson(res, 404, { ok: false, error: msg('http.unknownMethod', { method }) });

      try {
        const raw = await readBody(req);
        const args = raw ? (JSON.parse(raw).args ?? []) : [];
        const result = await fn(...args);
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        log(clog('srv.apiError', { method, reason: err.stack ?? err }));
        return sendJson(res, 500, { ok: false, error: String(err.message ?? err) });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  };

  /**
   * **Anything the handler throws has to land here.**
   *
   * This callback is async: one exception inside it = one unhandled rejection = the process exits
   * (Node ≥15's default behaviour). Which means any input nobody thought of is not "one 500 for
   * this request" but "the whole background service is gone". The known hole (a malformed percent
   * escape) is plugged in `safeDecode`, but plugging one hole and "it will never die of this again"
   * are two different things, and only this layer delivers the second.
   */
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(clog('srv.httpError', { method: req.method, url: req.url, reason: err?.stack ?? err }));
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg('http.serverError'));
    });
  });

  /**
   * Discovers new guide pages (Notion + local guides/) whenever the Dashboard is opened.
   *
   * Deliberately **not governed by syncStaleHours**: when the Dashboard is opened right after a
   * guide page was created in Notion, the achievement data is often still fresh (so no fullSync
   * fires), but the guide link has to appear immediately — which is exactly why this hook exists.
   * Gating it on staleness could keep a new page off the Dashboard for a dozen hours.
   *
   * It needs no Steam credentials either: guide discovery only concerns Notion and the guides/
   * directory. And **failure has to be soft** — Notion being down or a token expiring must not
   * affect the Dashboard or the achievement sync.
   */
  async function syncGuides() {
    if (config.syncGuidesOnServe === false) return [];
    // The appids **newly registered** this round. Handed to the automatic tick pass afterwards: a
    // guide page created just now may hold boxes for achievements unlocked months ago, and if they
    // are not ticked on this occasion it will take until the next time that game is played.
    const found = [];
    try {
      // Only action==='appended' counts: syncGuidesFromMarkdown re-upserts already-registered local
      // guides too and puts them in added, so without the filter every start would treat **every**
      // local guide as "just discovered", and the targeted tick pass would immediately degrade into
      // "scan every local guide every time".
      // (Notion's added is already filtered against existingIds, so those are genuinely new.)
      const local = syncGuidesFromMarkdown(db, config);
      const localNew = local.added.filter((a) => a.action === 'appended');
      if (localNew.length) {
        found.push(...localNew.map((a) => a.appid));
        log(clog('srv.guidesLocal', { n: localNew.length, names: localNew.map((a) => a.name).join('、') }));
      }

      const notion = new NotionClient(config);
      if (!notion.configured) return found;

      const r = await syncGuidesFromNotion(db, notion);
      if (r.added.length) {
        found.push(...r.added.map((a) => a.appid));
        log(clog('srv.guidesNotion', { n: r.added.length, names: r.added.map((a) => a.name).join('、') }));
      } else {
        log(clog('srv.guidesNotionNone', { n: r.dbPages }));
      }
      if (r.failed.length) {
        log(clog('srv.guidesUnreadable', { n: r.failed.length, titles: r.failed.map((f) => f.title).join('、') }));
      }
    } catch (err) {
      log(clog('srv.guidesFailed', { reason: err.message ?? err }));
    }
    return found;
  }

  /**
   * The automatic checkbox pass. **This is the only path in the whole project that writes to Notion
   * without a --dry-run in front of it**, so every narrowing below is deliberate:
   *
   * - **Only rows in appids are inspected**, not the full candidate set. The full set is 40-odd
   *   games × (1 Steam call + 1 Notion page read + 350ms), run on every Dashboard open, while in
   *   the vast majority of cases not a single box changes. What gets passed in is "achieved/total
   *   really moved this round" plus "guide pages registered this round". An empty array = not one
   *   external call.
   * - **Sub-steps do not cascade by default** (checkboxSyncOnServeCascade). The cascade is the one
   *   place in the project that prefers over-ticking, it mis-ticks a whole run of "any one of
   *   these" achievements, and this path has no human gate.
   * - **Failure is soft.** An expired Notion token must not make the page display "sync failed" —
   *   the achievement counts refreshed fine, and that is this background job's main output. So this
   *   never throws; the error goes separately into tickError.
   *
   * Every tick (plus every skip and failure) still goes into sync_log, reviewable afterwards with
   * `node tracker.js log`.
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
        .filter((l) => l.code === 'ticked')
        .map((l) => `${l.gameName} - ${l.achievement || clog('srv.subStep')}`);
      const failed = r.logs.filter((l) => l.code === 'tick-failed');

      if (ticked.length) log(clog('srv.autoTicked', { n: ticked.length, names: ticked.join('、') }));
      else if (r.checked) log(clog('srv.autoTickNone', { n: r.checked }));
      if (failed.length) log(clog('srv.autoTickFailed', { n: failed.length }));

      return { ticked, error: null };
    } catch (err) {
      log(clog('srv.autoTickError', { reason: err.message ?? err }));
      return { ticked: [], error: String(err.message ?? err) };
    }
  }

  /**
   * Marks the guide pages of completed games as Done.
   *
   * **Converges on current state; never watches for "did it just hit 100% this round"**. The
   * instant of crossing 100% exists only for as long as updateGameStats writes it: any run that
   * fails to write it (a CLI sync on a machine with no Notion configured, an interrupted process,
   * an expired token) loses that change forever — next time both old and new read 100%, and nothing
   * can be inferred. A convergent rule is the same however many times it runs, and repairs its own
   * omissions. The cost is two or three extra API requests per run (database schema + paging
   * through every page), which is not in the same league as reading status page by page.
   *
   * As with ticking, failure is soft: not being able to set a status must not affect the
   * achievement data, nor make the page display "sync failed".
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
      // Split by direction using applied (the ones that really landed), never by parsing log text
      const done = r.applied.filter((u) => u.reason === 'complete').map((u) => u.name);
      const staged = r.applied.filter((u) => u.reason === 'incomplete').map((u) => u.name);
      const failed = r.logs.filter((l) => l.code === 'status-failed');
      if (done.length) log(clog('srv.statusDone', { names: done.join('、') }));
      if (staged.length) log(clog('srv.statusStaged', { names: staged.join('、') }));
      if (failed.length) log(clog('srv.statusFailed', { n: failed.length }));
      return { done, staged, error: null };
    } catch (err) {
      log(clog('srv.statusError', { reason: err.message ?? err }));
      return { done: [], staged: [], error: String(err.message ?? err) };
    }
  }

  /**
   * Actually kicks off a background sync. The automatic sync at startup and the Dashboard's
   * 「立即同步」 button both come through here — **there is exactly one concurrency guard**, and
   * both paths share one syncState, so a click landing at the exact moment the startup sync begins
   * still cannot produce two fullSyncs.
   *
   * Deliberately **ignores syncStaleHours**: that gate answers "should we sync unprompted", and a
   * manual click has already answered it. Returns synchronously without waiting for fullSync —
   * progress is polled through /api/syncStatus.
   */
  /**
   * Generates a guide in the background. **This is the only action on the page that costs money**,
   * so:
   *
   * - there is exactly one concurrency gate and one run at a time (two at once means burning two
   *   lots of money simultaneously, and each takes minutes)
   * - every precondition is checked **before it starts** (no key configured, achievement detail not
   *   synced, a guide already exists) — discovering it halfway through means the money is spent
   * - the page has to show a confirmation dialog first. This does not do that, but it must not
   *   assume it happened either: every refusal reason is returned as `{error}` so the caller can
   *   display it verbatim
   */
  /**
   * One click = one task. **When it cannot run, it queues; it is not refused.**
   *
   * This used to return `{error: '已经有一个攻略在生成了'}` outright while a task was running. That
   * error is displayed on the progress bar, and the poll three seconds later replaces it with the
   * game currently running — so from the user's seat it is "clicked it, saw a flash, nothing
   * happened". A generation takes 2–4 minutes; queueing is what they actually want.
   *
   * The preflight **runs at enqueue time**: refusal reasons like "this game already has a guide"
   * have to be said on the spot, not twenty minutes later when its turn comes. `generateGuide`
   * re-plans for itself before it actually writes, so a preflight that has gone stale since queueing
   * still cannot write anything bad — the real gate is inside.
   */
  async function startGuideGen(appid, overwrite = false, effort = null, scope = null) {
    if (!config.ai?.apiKey) return { started: false, error: msg('ai.notConfigured') };
    // **Claim, do not merely check.** There is an await immediately below (the preflight makes two
    // Steam calls), and during the window in "check, then await, then start" a second click sees
    // nothing at all, so the same game is let through twice — generated twice, paid for twice. See
    // the comment on claim()
    if (!guideGenState.claim(appid)) {
      return { started: false, error: msg('guidegen.queued') };
    }
    try {
      return await startGuideGenClaimed(appid, overwrite, effort, scope);
    } finally {
      // By here it is either queued, already begun, or failed — none of the three still needs the
      // claim reservation
      guideGenState.release(appid);
    }
  }

  async function startGuideGenClaimed(appid, overwrite, effort, scope) {
    let plan;
    try {
      // Without passing overwrite, planGuide refuses outright with "a guide already exists" — which
      // is exactly the right behaviour when --overwrite was not given, so the flag is carried all
      // the way down rather than quietly waived on the server side.
      //
      // **A partial rewrite goes through planPatch, not planGuidePreflight plus a branch.** It
      // verifies one more thing: can the selector be parsed, and can the selected entries be located
      // in the guide. Both have to be caught **at enqueue time** — otherwise a mistyped scope
      // queues quietly for twenty minutes and only says "nothing was selected" when its turn comes
      plan = scope
        ? await planPatchPreflight(appid, scope)
        : await planGuidePreflight(appid, { overwrite });
    } catch (err) {
      return { started: false, error: String(err.message ?? err) };
    }

    // **Reserve, do not merely ask whether something is running.** `running` is set in `begin()`,
    // which is another await away (building the provider), so two different appids that both got
    // through `claim()` above would both see an idle state and both start. The reservation and the
    // call that consumes it are in one synchronous block, with no await between them
    if (!guideGenState.reserveRun()) {
      const position = guideGenState.enqueue({ appid, overwrite, effort, scope, game: plan.game });
      log(clog('srv.queued', { game: plan.game, appid, n: position }));
      return { started: false, queued: true, position, game: plan.game };
    }

    return runGuideGen({ appid, overwrite, effort, scope, game: plan.game });
  }

  /**
   * The actual start. **Enqueueing and starting are separate**, because finishing a run pulls the
   * next one off the queue and starts it, and on that path there is no "should this be queued"
   * question — combining them would loop back on itself
   */
  async function runGuideGen({ appid, overwrite, effort, scope = null, game }) {
    // **This run's config, not a change to the shared one.** effort is "how deep this one run
    // should go", and every job in the queue may have picked its own — writing config.ai.effort
    // directly would make one "low" turn every queued job after it low as well, with nothing
    // raising an error. The same shape as applyAiFlags on the CLI side; the only difference is that
    // a CLI process runs once while this one runs a series
    const runConfig = effort ? { ...config, ai: { ...config.ai, effort } } : config;
    let provider;
    try {
      provider = await createProvider(runConfig);
    } catch (err) {
      // A provider that cannot be built is a global failure, and everything queued behind it would
      // hit the same wall one by one — clear them together, and record why, so the queue does not
      // vanish silently
      const dropped = guideGenState.clearQueue();
      if (dropped.length) log(clog('srv.queueDropped', { n: dropped.length, names: dropped.map((d) => d.game).join('、') }));
      // The only way out between reserving the slot and `begin()`. Without this the slot stays held
      // by a job that never ran, and every later request queues behind a queue that never drains
      guideGenState.releaseRun();
      return { started: false, error: String(err.message ?? err) };
    }

    const rounds = scope ? PATCH_ROUNDS : (config.ai.maxRounds ?? 3);
    guideGenState.begin(appid, game, rounds);
    log(scope
      ? clog('srv.startPatch', { game, appid, selector: scope.selector })
      : clog('srv.startGen', { game, appid }));

    // **Set right alongside begin(), cleared right alongside end()** — see the comment on
    // `controller` inside createGuideGenState for why the two live in one object rather than two
    const controller = new AbortController();
    guideGenState.setController(controller);

    /** One finishes, the next begins. Both success and failure go through it, or a single failure wedges the whole queue */
    const drainNext = () => {
      // Reserved here for the same reason as at the enqueue decision: `end()` has already cleared
      // `running`, and `runGuideGen` does not reach `begin()` until after building the provider —
      // a request arriving in that window would otherwise find the slot free and start alongside.
      // **Reserved before dequeuing, not after**: a job taken off the queue that then cannot be
      // started has nowhere to go back to, and losing it raises no error anywhere
      if (!guideGenState.reserveRun()) return;
      const next = guideGenState.dequeue();
      if (next) runGuideGen(next);
      else guideGenState.releaseRun();
    };

    /**
     * A partial rewrite and a full generation are two pipelines, but **there is only one ending**.
     *
     * With a `.then/.catch` on each, `drainNext` would exist in two copies — and what
     * `guidequeue.test.js` pins is precisely that it must hang off both then and catch, because
     * missing one means a single failure wedges the whole queue permanently, with no error and no
     * timeout. One ending, one concurrency guard
     */
    const job = scope
      ? patchGuide(db, {
        config: runConfig, provider, steam, appid, notion: new NotionClient(config),
        selector: scope.selector,
        instruction: scope.note || null,
        rounds,
        signal: controller.signal,
        onProgress(ev) {
          if (ev.phase === 'plan') {
            guideGenState.onProgress({ phase: 'plan', note: msg('gp.patchScope', { n: ev.scope, of: ev.of }) });
          } else if (ev.phase === 'write') {
            guideGenState.onProgress({ phase: 'ask', round: ev.round, note: msg('gp.patchAsk', { n: ev.scope }) });
          } else if (ev.phase === 'rewrite') {
            guideGenState.onProgress({ phase: 'rewrite', note: msg('gp.rewriteOnce') });
          } else if (ev.phase === 'retry') {
            guideGenState.onProgress({ phase: 'ask', note: msg('gp.askAgain') });
          } else if (ev.phase === 'check') {
            // **A few entries missing has to stay on screen; the next line must not cover it.** This
            // is the only case on this path where every gate is green and the request still was not
            // met, and `note` is overwritten three seconds later, so it goes through warn
            if (ev.missing) guideGenState.warn({ key: 'gp.missing', values: { n: ev.missing } });
            if (ev.extra) guideGenState.warn({ key: 'gp.extra', values: { n: ev.extra } });
            guideGenState.onProgress({ phase: 'check', note: msg('gp.checkWrote', { wrote: ev.wrote, of: ev.of }) });
          } else if (ev.phase === 'lint') {
            guideGenState.onProgress({ phase: 'lint', note: msg('gp.lintPatch', { caused: ev.caused, pre: ev.preExisting }) });
          } else if (ev.phase === 'tool') guideGenState.onProgress({ phase: 'tool', note: ev.name });
          else if (ev.phase === 'notion-patch') guideGenState.onProgress({ phase: 'check', note: msg('gp.notionPatch', { name: ev.name }) });
          else if (ev.phase === 'notion-verify') guideGenState.onProgress({ phase: 'check', note: msg('gp.notionVerify') });
          else if (ev.phase === 'warn') guideGenState.warn(ev.note);
        },
      })
      : generateGuide(db, {
      // Pass this run's copy, not the shared one — generateGuide does not read ai.effort today, but
      // with the two names sitting side by side, passing the wrong one raises no error and would
      // simply start quietly using the global value one day
      config: runConfig, provider, steam, appid, rounds, overwrite, notion: new NotionClient(config),
      signal: controller.signal,
      onProgress(ev) {
        // When writing in shards, "which shard" has to be reported: a few hundred achievements take
        // ten-odd minutes, and showing only "round 1/3" leaves the progress bar motionless for the
        // whole time, which looks like a hang
        const seg = ev.chunks > 1 ? msg('gp.segment', { chunk: ev.chunk, chunks: ev.chunks }) : '';
        if (ev.phase === 'plan' && ev.chunks > 1) {
          guideGenState.onProgress({ phase: 'plan', note: msg('gp.planChunks', { n: ev.achievements, chunks: ev.chunks }) });
        } else if (ev.phase === 'regroup') {
          // This pass also takes tens of seconds. **Without reporting it the floater sits motionless
          // for the duration**, the same reason as the comment above
          guideGenState.onProgress({ phase: 'plan', note: msg('gp.regroup') });
        } else if (ev.phase === 'regroup-done') {
          guideGenState.onProgress({ phase: 'plan', note: msg('gp.regroupDone', { n: ev.sections }) });
        } else if (ev.phase === 'regroup-failed') {
          // Through warn rather than note: the consequence of the degradation stays in the finished
          // product, while note is covered by the next line three seconds later
          guideGenState.warn({ key: 'gp.regroupFailed' });
        } else if (ev.phase === 'regroup-merged') {
          guideGenState.onProgress({ phase: 'plan', note: msg('gp.regroupMerged', { n: ev.clusters }) });
        } else if (ev.phase === 'unwrapped-toggles') {
          guideGenState.onProgress({ phase: 'plan', note: msg('gp.unwrapped', { n: ev.titles.length }) });
        } else if (ev.phase === 'unwrap-failed') {
          // As above: the consequence stays in the finished product (that section is still empty when
          // opened), so it must not be covered three seconds later
          guideGenState.warn({ key: 'gp.unwrapFailed' });
        } else if (ev.phase === 'ask') {
          // **Report "shards finished" rather than "writing shard N".** With shards running
          // concurrently several are being written at once, and this event fires once per shard — so
          // reporting the current shard number makes the floater bounce between 1/4, 3/4 and 2/4,
          // looking like progress going backwards. The count of finished shards is monotonic, and
          // holds equally well when they run sequentially
          const prog = ev.chunks > 1 ? msg('gp.progress', { done: ev.done ?? 0, chunks: ev.chunks }) : '';
          guideGenState.onProgress({ phase: 'ask', round: ev.round, note: msg('gp.askWrite', { prog }) });
        } else if (ev.phase === 'rewrite') {
          guideGenState.onProgress({ phase: 'rewrite', note: msg('gp.rewriteChunks', { n: ev.chunks, of: ev.of }) });
        } else if (ev.phase === 'retry') {
          guideGenState.onProgress({ phase: 'ask', note: msg('gp.askAgainSeg', { seg }) });
        } else if (ev.phase === 'resplit') {
          // **None of these three were handled at all originally.** So the "split smaller and re-ask"
          // recovery path was completely invisible on the Dashboard: the floater sat at "shard 3/4,
          // researching + writing" while the shard count quietly went from 4 to 5, and the user could
          // only conclude it was stuck. The recovery process is itself something people need to see
          guideGenState.onProgress({ phase: 'ask', note: msg('gp.resplit', { chunk: ev.chunk, to: ev.to }) });
        } else if (ev.phase === 'chunk-failed') {
          guideGenState.warn({ key: 'gp.chunkFailed', values: { chunk: ev.chunk, count: ev.count } });
        } else if (ev.phase === 'tool') guideGenState.onProgress({ phase: 'tool', note: ev.name });
        else if (ev.phase === 'check') guideGenState.onProgress({ phase: 'check', note: msg('gp.check') });
        else if (ev.phase === 'lint') {
          guideGenState.onProgress({ phase: 'lint', note: msg('gp.lintTicked', { ticked: ev.ticked, blocking: ev.blocking }) });
        }
      },
    });

    // **Cleared here, not inside .then/.catch.** `.finally` runs before either branch and passes
    // the settled value/error through untouched, so the controller cannot outlive the job it
    // belongs to regardless of which way this settles — leaving it set after a success would let
    // the *next* queued job's Cancel button abort a request that already finished
    job
      .finally(() => guideGenState.setController(null))
      .then((r) => {
        guideGenState.end(null, {
          ok: r.ok,
          // The three numbers only a partial rewrite has. **"How many were changed" and "the rest
          // were untouched" have to be reported together** — reporting only the former leaves the
          // user unable to tell it apart from a full rewrite, and the untouched part is precisely
          // why they chose it
          patched: scope ? {
            selector: scope.selector,
            rewrote: (r.rewrote ?? []).length,
            scoped: (r.scope ?? []).length,
            missing: (r.missing ?? []).length,
            // Problems the old guide already had: untouched this time, and not blocking — but they
            // have to be said
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
          // **The success path has to be able to report "these boxes can never be ticked" too.**
          // Once these moved from blocking into expected the guide could land, and the landing
          // screen originally said only how much was covered — turning "automatic ticking will never
          // recognise these 15 boxes" into something the user discovers months later. Not blocking ≠
          // not mentioning, the same rule as the failed page fetch
          unsyncable: (r.expected ?? [])
            .filter((f) => f.code === 'ambiguous-empty-description')
            .map((f) => f.name),
          // **The cause, not the symptom.** A missing shard presents as dozens of "missing checkbox"
          // findings, while the dialog holds only five — all taken up by the same sentence, with not
          // one word of the real reason showing through
          chunkFailures: (r.chunkFailures ?? []).map((c) => ({
            chunk: c.chunk, of: c.of, count: c.count, reason: c.reason,
          })),
          blocking: (r.blocking ?? []).slice(0, 5).map((f) => f.message),
          // The copy saved before this overwrite. **What is handed out is the archive id, not an
          // absolute path** — the page has to be able to call `deleteGuideArchive` with it, and that
          // endpoint takes ids only; turning a path into an id is `archiveIdOf`'s job, so the format
          // is not written out in two places.
          // A freshly generated whole guide has no backup (there was no old one to save), in which
          // case this is null and the UI uses that to decide whether to offer 「删除备份」
          backup: r.backup?.path
            ? { id: archiveIdOf(config, r.backup.path), bytes: r.backup.bytes }
            : null,
        });
        for (const c of r.chunkFailures ?? []) {
          log(clog('srv.chunkFailed', { chunk: c.chunk, of: c.of, count: c.count, reason: c.reason.split('\n')[0] }));
        }
        if (scope) {
          // When a partial rewrite does not pass, **not one byte of the original guide was touched**
          // — that sentence has to reach the log, or 「没过校验」 reads as though the guide was
          // damaged, when the truth is the opposite
          log(r.ok
            ? clog('srv.patchDone', { n: (r.rewrote ?? []).length, url: r.url })
            : clog('srv.patchFailed', { url: r.url }));
        } else {
          log(r.ok ? clog('srv.genDone', { url: r.url }) : clog('srv.genDraft', { path: r.draftPath }));
        }
        drainNext();
      })
      .catch((err) => {
        // **A cancellation is not the same outcome as a failure.** It carries no `error` — the run
        // did exactly what was asked of it — so it goes through `end(null, result)` like a normal
        // finish, with `result.cancelled` telling the two apart. Reusing `end(err)`'s shape here
        // would print "generation failed: 已取消" in the log and on the Dashboard, which is true in
        // the narrowest technical sense and wrong in every sense that matters to whoever clicked
        // the button.
        if (err?.cancelled) {
          guideGenState.end(null, { ok: false, cancelled: true });
          log(clog(scope ? 'srv.patchCancelled' : 'srv.genCancelled', { game, appid }));
        } else {
          guideGenState.end(err);
          // **`clog`, not `msg`.** `srv.patchError`/`srv.genError` only exist in cli-messages.js's
          // table (msg() reads messages.js's, a different table) — `msg()` here was silently
          // printing the literal key instead of the formatted line, on every failed generation.
          // Found while adding the cancelled branch right above it.
          log(clog(scope ? 'srv.patchError' : 'srv.genError', { reason: err.stack ?? err }));
        }
        drainNext();
      });

    return { started: true, game };
  }

  /**
   * Cancels a generation or partial rewrite — the running one if this appid is it, a queued one
   * otherwise. Two outcomes, not three: **the narrow window between `claim()` and either `begin()`
   * or `enqueue()`** (the preflight's two Steam calls, an await apart) has no controller and is not
   * in the queue yet, so a cancel click landing in that instant reports "not found" rather than
   * doing nothing silently — it is sub-second and self-resolving, the same accepted gap
   * `startGuideGen`'s own comment describes for the claim/begin race.
   */
  function cancelGuideGen(appid) {
    const id = String(appid);
    const snap = guideGenState.snapshot();
    if (snap.running && snap.appid === id) {
      return guideGenState.cancelRunning()
        ? { cancelled: true }
        : { cancelled: false, error: msg('gen.cancelNotFound') };
    }
    if (guideGenState.cancelQueued(id)) return { cancelled: true };
    return { cancelled: false, error: msg('gen.cancelNotFound') };
  }

  /** The pre-start check. planGuide raises every refusal reason at once by itself; this just borrows it for a pass */
  /**
   * The preflight before generating. With `overwrite` it also computes **what will be lost** —
   * **the GUI's gate must not be looser than the CLI's**: overwriting is irreversible, and clicking
   * once on the Dashboard is far easier than typing a command.
   *
   * What it hands out is **numbers, not formatted sentences**. What the two surfaces should share
   * is the `overwritePreflight` computation, not the wording: the command line is read by somebody
   * who typed a flag and can afford detail, while the UI has to be short. Forcing one shared piece
   * of copy suits neither.
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
      existing: { kind: plan.existing.kind, url: plan.existing.url, lang: plan.existing.lang || 'zh' },
      boxes: pre.count,
      checked: pre.checked,
      atRisk: pre.atRiskTicks.length,
      backupDir: join(config.guidesDir, BACKUPS_DIR),
    };
  }

  /**
   * The preflight for a partial rewrite: **one plan, all four presets' numbers handed out together**.
   *
   * So the frontend can draw the whole row of buttons in a single round trip, each carrying its own
   * count. Pressing a button then has no delay — and "click, wait half a second for a number" makes
   * people think the click missed and press again.
   *
   * Like `planGuidePreflight` it hands out **numbers, not sentences**: the command line is read by
   * somebody who typed a flag and can afford detail, while a dialog has to be short. Forcing one
   * shared piece of copy suits neither.
   */
  async function previewGuidePatch(appid) {
    const notion = new NotionClient(config);
    const { plan, baseline, oldText, kind } = await planPatch(db, {
      config, steam, appid, notion,
      // Only the plan and the baseline check are wanted; there is no "scope" here — each of the four
      // presets computes its own scope below
      selector: null,
    });

    /**
     * The section structure. Each backend produces its own outline, converged into one sequence and
     * then grouped.
     *
     * **The Notion side needs one extra whole-page read** (`fetchAllBlocks`), because the `oldTodos`
     * `planPatch` obtained come from `fetchAllToDoBlocks`, and that function collects only
     * checkboxes — headings do not exist as far as it is concerned. The extra call is a second walk
     * over the same page, happening when the user deliberately opens the dialog, and what it buys is
     * that their real body of guides (all in Notion) can be picked by section.
     *
     * A failed read **is not a failure**: grouping is only presentation, so without it this falls
     * back to a flat list and picking still works. Making the whole dialog fail to open over one
     * grouping would sacrifice the main feature for a garnish
     */
    let groups = [];
    try {
      const outline = kind === 'local'
        ? guideOutline(oldText ?? '')
        : blocksToOutline(await notion.fetchAllBlocks(extractNotionPageId(plan.existing.url)));
      groups = groupBySection(outline, plan.defs);
    } catch (err) {
      log(clog('srv.sectionsFailed', { game: plan.game, reason: err.message ?? err }));
    }

    return {
      game: plan.game,
      total: plan.defs.length,
      target: kind,
      url: plan.existing.url,
      boxes: plan.oldTodos.length,
      // The list used for hand-picking: grouped by section, each entry carrying name, rarity and
      // unlock state
      pickable: pickableEntries({ plan, groups }),
      // **The threshold is sent down with the data rather than letting the frontend write its own
      // 15.** Which entries the 「稀有」 shortcut selects, when a percentage is coloured as emphasis,
      // and which entries the prompt decides to write in depth all have to be one line — written in
      // two places they will eventually disagree, and the symptom is "the UI says it is rare, the
      // program does not agree"
      rarePct: RARE_PCT,
    };
  }

  /** The one before actually queueing: can the selector be parsed, can the selected entries be located. planPatch raises the refusal reasons */
  async function planPatchPreflight(appid, scope) {
    const { plan, entries } = await planPatch(db, {
      config, steam, appid, notion: new NotionClient(config), selector: scope?.selector,
    });
    return { game: plan.game, count: entries.length };
  }

  function startBackgroundSync({ guideAppids = [] } = {}) {
    if (syncState.snapshot().running) return { started: false, error: msg('sync.running') };
    if (!config.steamApiKey || !config.steamId) {
      // This sentence is displayed verbatim on the Dashboard, so it does not mention the command
      // line — without credentials the page redirects to the setup page anyway, and the few who
      // actually reach this point are edge cases (deleting config.json midway, say)
      return { started: false, error: msg('steam.notConfigured') };
    }

    syncState.begin();
    // Passing selection is what makes phase two sample by rtime + rotating sweep (the CLI's sync
    // stays a full pass)
    const selection = {
      sweepBudget: config.sweepBudget,
      maxStatsAgeDays: config.maxStatsAgeDays,
      perfectGameMaxAgeDays: config.perfectGameMaxAgeDays,
    };
    fullSync(db, steam, { onProgress: (p) => syncState.onProgress(p), selection })
      .then(async (r) => {
        const s = r.stats.selection;
        log(clog('srv.syncDone', {
          added: r.library.added.length,
          updated: r.stats.updated,
          schema: r.schema.processed,
        }));
        log(clog('srv.syncSample', {
          total: s.total, played: s.played, unowned: s.unowned, swept: s.swept,
          pending: s.sweepPending ? clog('srv.syncPending', { n: s.sweepPending }) : '',
        }));
        if (r.stats.bumped.length) {
          log(clog('srv.syncBumped', { names: r.stats.bumped.join('、') }));
        }

        // Ticking runs after the sync, and **running stays true throughout**: the status bar keeps
        // showing, the 「立即同步」 button stays disabled, and reloadDashboard fires only once at
        // the end.
        // The order cannot be reversed — ticking matches boxes against the unlock state that was
        // just refreshed, or it would be matching against last round's stale data.
        const tick = await runCheckboxSync([
          ...new Set([...r.stats.changedAppids, ...guideAppids]),
        ]);
        // Status convergence goes **after** ticking: for a game that just hit 100%, the last few
        // boxes should be ticked before it is marked Done, or the page ends up Done with unticked
        // boxes still under it
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
        log(clog('srv.syncError', { reason: err.stack ?? err }));
      });

    return { started: true };
  }

  /**
   * Runs a background sync when the data is older than syncStaleHours (0 turns this behaviour off).
   * Returns whether a sync was actually started — if not, newly discovered guide pages have to be
   * ticked separately by startupJobs.
   */
  function maybeAutoSync(guideAppids = []) {
    const hours = config.syncStaleHours;
    if (!hours) return false;
    const last = getMeta(db, 'last_sync');
    const ageH = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
    if (ageH < hours) {
      log(clog('srv.freshEnough', { hours: ageH.toFixed(1), threshold: hours }));
      return false;
    }

    const r = startBackgroundSync({ guideAppids });
    if (!r.started) {
      log(clog('srv.skipAutoSync', { reason: r.error }));
      return false;
    }
    log(last ? clog('srv.staleStartSync', { hours: ageH.toFixed(1) }) : clog('srv.firstSync'));
    return true;
  }

  /**
   * The chain of background jobs at startup. The three steps **are ordered** and cannot be fired off
   * concurrently: guide discovery has to finish before the sync knows which pages were registered
   * this round, and ticking has to wait for the achievement counts to refresh or it works from last
   * round's unlock state.
   */
  async function startupJobs() {
    const guideAppids = await syncGuides();
    const started = maybeAutoSync(guideAppids);
    if (started) return; // ticking and status convergence are already hung off the end of that sync chain

    // The data was fresh enough that no sync fired. Ticking may still have work to do (in a
    // just-discovered guide page, the achievements its boxes refer to were very likely unlocked long
    // ago), and status convergence should run every time regardless — it never depended on "did
    // anything change this round".
    // The same reasoning as syncGuides not being governed by syncStaleHours: fresh Steam data does
    // not mean there is nothing pending on the Notion side.
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
     * **A listen failure is an async error event, not a throw.** Without this listener that error
     * never passes through this promise — so `tracker.js`'s top-level `try { await fn() }` cannot
     * catch it (the promise hangs forever and the process is taken out by the uncaught error), and
     * the CLI prints a dozen incomprehensible stack lines instead of the message written for it. In
     * the packaged build it is worse: the stack lands on a console that does not exist, leaving the
     * launcher with nothing to report but 「代码 1」.
     *
     * Once listen succeeds the listener is **removed**, rather than being repurposed: a later error
     * still has nobody catching it (crashing as before), instead of rejecting into an
     * already-settled promise where it would be quietly swallowed.
     */
    const failStartup = (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(msg('serve.portTaken', { port: config.port }))
          : err
      );
    };
    server.once('error', failStartup);

    server.listen(config.port, '127.0.0.1', () => {
      server.removeListener('error', failStartup);
      log(clog('srv.listening', { port: config.port }));
      // Runs in the background so it does not block the listen callback — the page has to open
      // immediately
      startupJobs().catch((err) => log(clog('srv.startupError', { reason: err.stack ?? err })));
      resolve(server);
    });
  });
}
