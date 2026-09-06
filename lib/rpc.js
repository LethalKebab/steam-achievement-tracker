/**
 * rpc — the thin wrapper the Dashboard frontend uses to call the backend
 * ------------------------------------------------
 * Usage (every call in Dashboard.html has this shape):
 *   rpc.withSuccessHandler(fn).withFailureHandler(fn).someMethod(args...)
 * becomes POST /api/someMethod with a body of {args: [...]}, handled by the method of the
 * same name in lib/api.js.
 *
 * A callback chain rather than a Promise, because every call site in the frontend has to
 * distinguish the success and failure paths (optimistic update plus rollback), and this
 * shape reads most directly for that.
 *
 * The contract:
 * - A method returning normally (including a business error like {error: '...'}) → the
 *   successHandler, and the frontend inspects result.error itself to decide what to show
 * - A network failure or a server-side throw → the failureHandler, receiving an Error with .message
 * Adding a backend method only means adding it to lib/api.js; nothing changes here — any
 * method name is proxied.
 */
(function () {
  function createRunner(handlers) {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'withSuccessHandler') {
            return (fn) => createRunner({ ...handlers, success: fn });
          }
          if (prop === 'withFailureHandler') {
            return (fn) => createRunner({ ...handlers, failure: fn });
          }
          if (prop === 'withUserObject') {
            return (obj) => createRunner({ ...handlers, userObject: obj });
          }
          if (typeof prop !== 'string') return undefined;

          // Any other property name is treated as "a backend method to call"
          return function (...args) {
            fetch('/api/' + prop, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ args }),
            })
              .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
              .then(({ ok, body }) => {
                if (!ok || body.ok === false) {
                  throw new Error(body?.error || '请求失败');
                }
                if (handlers.success) handlers.success(body.result, handlers.userObject);
              })
              .catch((err) => {
                if (handlers.failure) handlers.failure(err, handlers.userObject);
                else console.error('[rpc]', prop, err);
              });
          };
        },
      }
    );
  }

  window.rpc = createRunner({});

  // ---------------------------------------------------------------------------
  // The background sync status bar (serve runs a full sync on startup when the data is stale)
  // ---------------------------------------------------------------------------
  /*
    This status bar **floats above everything on the page**, so how it looks decides whether
    the whole interface reads as one thing — the colours **must not be hardcoded as rgba**,
    which would have no relationship to the page's design tokens.

    It uses `var(--token, fallback)`: on the Dashboard it picks up that token set, so colour,
    radius and shadow follow the page; dropped into a page with no tokens defined, the
    fallbacks keep it legible.
    **The styles live in an injected <style> rather than cssText**, because the rules below
    change colour by state and draw a dot in front of each line, neither of which can be
    written as inline style.

    State is carried by **the colour bar down the left** plus a dot in front of each line,
    not by an emoji prefix. Same reasoning as removing emoji from the page: emoji ignore
    `color` and render differently per OS, and seven different ✅⚠️🆕☑️🏁↩️⏳ crammed into one
    narrow bar are louder in colour than the text is.
    It also deliberately **does not <use> the Dashboard's icon sprite** — those are ids in
    another file, and renaming one would silently turn this into a blank space, which is
    the one thing this project refuses to accept.
  */
  const barCss = document.createElement('style');
  barCss.textContent = `
    .rpc-bar {
      position: fixed; right: 16px; bottom: 16px; z-index: 9999;
      display: none; max-width: 360px;
      padding: 11px 15px;
      background: var(--surface-3, #2a3749);
      color: var(--text, #dce6f2);
      font-family: inherit;
      font-size: var(--fs-md, 13px);
      line-height: 1.55;
      border: 1px solid var(--line-3, rgba(150,180,216,.28));
      border-left: 3px solid var(--text-3, #6d7f95);
      border-radius: var(--r-md, 7px);
      box-shadow: var(--sh-3, 0 16px 48px rgba(0,0,0,.6));
    }
    .rpc-bar[data-state="running"] { border-left-color: var(--accent, #66c0f4); }
    .rpc-bar[data-state="ok"]      { border-left-color: var(--ok, #8cc63f); }
    .rpc-bar[data-state="error"]   { border-left-color: var(--danger, #e0685e); }
    /* A dot in front of each line, coloured by kind. **Far quieter than an emoji** */
    .rpc-line { display: flex; gap: 8px; align-items: baseline; }
    .rpc-line + .rpc-line { margin-top: 5px; }
    .rpc-line::before {
      content: ''; flex-shrink: 0;
      width: 6px; height: 6px; border-radius: 999px;
      transform: translateY(-1px);
      background: var(--text-3, #6d7f95);
    }
    .rpc-line[data-kind="ok"]::before    { background: var(--ok, #8cc63f); }
    .rpc-line[data-kind="warn"]::before  { background: var(--warn, #e0a63f); }
    .rpc-line[data-kind="error"]::before { background: var(--danger, #e0685e); }
    .rpc-line[data-kind="info"]::before  { background: var(--accent, #66c0f4); }
    .rpc-sub { opacity: .6; }
    .rpc-bar a { color: var(--accent, #66c0f4); }
  `;
  const bar = document.createElement('div');
  bar.className = 'rpc-bar';
  document.addEventListener('DOMContentLoaded', () => {
    document.head.appendChild(barCss);
    document.body.appendChild(bar);
  });

  /** One line. kind decides the colour of the dot in front */
  const line = (kind, html) => `<div class="rpc-line" data-kind="${kind}">${html}</div>`;

  /** Swapping the content also sets the bar's state colour — the two must happen together, or written apart they eventually disagree */
  const show = (state, lines) => {
    bar.dataset.state = state;
    bar.style.display = 'block';
    bar.innerHTML = Array.isArray(lines) ? lines.join('') : lines;
  };

  const reloadLink = ' — <a href="#" onclick="location.reload();return false;">刷新页面</a>';

  const PHASE_LABEL = {
    library: '检查库里的新游戏',
    achievements: '刷新成就完成数',
    schema: '同步成就详情',
    checkbox: '勾选攻略 checkbox',
    guideStatus: '更新攻略完成状态',
  };

  // Game and achievement names come from Steam, guide names from Notion, and all of them go
  // into innerHTML, so escape before concatenating. A local page, so the risk is low, but
  // there is no reason not to
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /**
   * The results of automatic ticking. This writes to the user's guide notes in Notion rather
   * than to local data, so like bumped it **does not auto-dismiss** — missing this notice
   * leaves sync_log as the only way to find out.
   */
  function tickNotices(s) {
    const out = [];
    const ticked = s.ticked || [];
    if (ticked.length) {
      out.push(line('ok',
        '自动勾选了 ' + ticked.length + ' 个 checkbox:' +
          esc(ticked.slice(0, 3).join('、')) + (ticked.length > 3 ? ' 等' : '')
      ));
    }
    if (s.tickError) {
      out.push(line('warn',
        '自动勾选失败:' + esc(s.tickError) +
          '<br><span class="rpc-sub">成就数据已同步完成,不受影响</span>'
      ));
    }
    const statusDone = s.statusDone || [];
    if (statusDone.length) {
      out.push(line('ok',
        statusDone.length + ' 个攻略页标记为 Done:' +
          esc(statusDone.slice(0, 3).join('、')) + (statusDone.length > 3 ? ' 等' : '')
      ));
    }
    // Dropping below 100% deserves saying out loud more than completing does: it means a game
    // you thought was finished has had new achievements added
    const statusStaged = s.statusStaged || [];
    if (statusStaged.length) {
      out.push(line('warn',
        statusStaged.length + ' 个攻略页退回 Staged(加了新成就,掉出 100%):' +
          esc(statusStaged.slice(0, 3).join('、')) + (statusStaged.length > 3 ? ' 等' : '')
      ));
    }
    if (s.statusError) {
      out.push(line('warn', '攻略状态更新失败:' + esc(s.statusError)));
    }
    return out;
  }

  let wasRunning = false;

  function poll() {
    fetch('/api/syncStatus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then(({ result: s }) => {
        if (!s) return;

        // Hand the state to the page on every poll (Dashboard.html uses it to manage the
        // 「立即同步」 button's disabled state). Doing this **before** every branch is
        // mandatory: both the failure path and the "user is editing" path below return
        // early, so hanging it off the end would strand the button on "syncing" forever.
        if (typeof window.onSyncState === 'function') window.onSyncState(s);

        if (s.running) {
          wasRunning = true;
          const phase = PHASE_LABEL[s.phase] || '同步中';
          const progress = s.total ? ` ${s.done}/${s.total}` : '';
          show('running', line('info',
            `正在同步:${phase}${progress}` +
            (s.name ? `<br><span class="rpc-sub">${esc(s.name)}</span>` : '')
          ));
        } else if (wasRunning) {
          wasRunning = false;

          // Don't auto-refresh on failure: the data on the page hasn't changed, and a refresh
          // would only wipe out the error notice — which is the only clue to the failure the
          // user ever gets
          if (s.error) {
            show('error', line('error', `同步失败:${esc(s.error)}` + reloadLink));
            return;
          }

          // Don't refresh while a Manual row's numbers are being edited by hand — render()
          // rebuilds the whole table and would swallow input that hasn't been committed.
          // Fall back to a manual link in that case
          const active = document.activeElement;
          if (active && active.classList && active.classList.contains('manual-input')) {
            // The tick notices have to appear on this path too: swallowing "we changed your
            // Notion notes" because you happened to be editing is exactly the kind of silence
            // this project cannot accept
            show('ok', [
              line('ok', '同步完成(检测到你正在编辑,没有自动刷新)' + reloadLink),
              ...tickNotices(s),
            ]);
            return;
          }

          if (typeof window.reloadDashboard === 'function') {
            const y = window.scrollY;
            window.reloadDashboard();
            // The table is rebuilt, so the scroll position jumps to the top; put it back once
            // rendering is done
            requestAnimationFrame(() => window.scrollTo(0, y));

            // Say so when a game has gained achievements. This kind of change happens without
            // you playing (a developer patch), it can drop a perfect game below 100%, and it
            // is the one change you would never notice on your own
            const notices = [];
            const bumped = s.bumped || [];
            if (bumped.length) {
              notices.push(line('info',
                bumped.length + ' 款游戏新增了成就:' +
                  esc(bumped.slice(0, 3).join('、')) + (bumped.length > 3 ? ' 等' : '')
              ));
            }
            // The one row the sync creates on its own. A new line among three hundred is invisible,
            // and this one was never asked for, so it says so — and like the rest of these it does
            // not auto-dismiss
            const familyAdded = s.familyAdded || [];
            if (familyAdded.length) {
              notices.push(line('ok',
                '发现你在玩 ' + familyAdded.length + ' 款家庭库游戏,已加入追踪:' +
                  esc(familyAdded.slice(0, 3).map((a) => a.name).join('、')) + (familyAdded.length > 3 ? ' 等' : '')
              ));
            }
            notices.push(...tickNotices(s));

            const done = line('ok', '同步完成,数据已自动刷新');
            if (notices.length) {
              show('ok', [done, ...notices]);
              return; // None of these auto-dismiss — miss one and it won't be mentioned again until the next sync
            }

            show('ok', done);
            setTimeout(() => {
              bar.style.display = 'none';
            }, 6000);
          } else {
            // An older Dashboard.html has no such hook; fall back to a full page reload
            location.reload();
          }
        } else {
          bar.style.display = 'none';
        }
      })
      .catch(() => {});
  }

  poll();
  setInterval(poll, 3000);
})();
