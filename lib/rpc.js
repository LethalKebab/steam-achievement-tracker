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
  /**
   * This file's own [zh, en] table, and the one place it decides which half to show.
   *
   * **It cannot share the page's table.** `/_rpc.js` is a separate script, loaded before the page's
   * own, and the page keeps its language in a `let` inside that script — reachable from here only
   * by name, and only for as long as the name and the load order stay as they are. What the page
   * does publish is `<html lang>`: `applyStrings()` sets it to `en` or `zh-CN` before the first
   * paint, for screen readers and line breaking. Reading it reads the page's own answer through the
   * one interface the page already commits to. An empty attribute means the page has not settled
   * yet, and falls back to Chinese, which is where the page itself starts.
   *
   * **It is read on every string, never once.** This script builds the bar and starts polling before
   * the page's first data load has set the language, so a value captured at startup would freeze
   * whichever language happened to be there.
   *
   * The phase labels match the terminal's in `lib/tracker-messages.js` word for word, and a test
   * holds the two copies together: two copies of one label drift.
   */
  const STRINGS = {
    requestFailed:          ['请求失败', 'Request failed'],
    close:                  ['关闭', 'Close'],
    reload:                 ['刷新页面', 'Reload the page'],
    syncing:                ['同步中', 'Syncing'],
    running:                ['正在同步:{phase}', 'Syncing: {phase}'],
    'phase.library':        ['检查新游戏', 'Checking for new games'],
    'phase.library-family': ['检查家庭库游戏', 'Checking family-shared games'],
    'phase.library-en':     ['补英文名', 'Filling in English names'],
    'phase.achievements':   ['刷新成就数', 'Refreshing achievement counts'],
    'phase.schema':         ['同步成就详情', 'Syncing achievement details'],
    'phase.rarity':         ['查询成就稀有度', 'Fetching achievement rarity'],
    'phase.hltb':           ['查询通关时长', 'Fetching completion times'],
    'phase.checkbox':       ['勾选攻略 checkbox', 'Ticking guide checkboxes'],
    'phase.guideStatus':    ['更新攻略完成状态', 'Updating guide statuses'],
    failed:                 ['同步失败:{error}', 'Sync failed: {error}'],
    done:                   ['同步完成,数据已自动刷新', 'Sync finished, data refreshed'],
    doneEditing:            ['同步完成(检测到你正在编辑,没有自动刷新)', 'Sync finished. The page was not refreshed, because you are editing'],
    bumped:                 ['{n} 款游戏新增了成就:{names}', 'Games with new achievements ({n}): {names}'],
    forbidden:              ['{n} 款游戏 Steam 不再提供你的进度:{names}', 'Steam stopped reporting your progress on these games ({n}): {names}'],
    forbiddenSub:           ['请切换成手动更新成就数据', 'Switch these games to manual updates'],
    familyAdded:            ['发现你在玩 {n} 款家庭库游戏,已加入追踪:{names}', 'Family-shared games you are playing, now tracked ({n}): {names}'],
    ticked:                 ['自动勾选了 {n} 个 checkbox:{names}', 'Guide checkboxes ticked automatically ({n}): {names}'],
    tickFailed:             ['自动勾选失败:{error}', 'Automatic ticking failed: {error}'],
    tickFailedSub:          ['成就数据已同步完成,不受影响', 'The achievement data synced normally and is not affected'],
    statusDone:             ['{n} 个攻略页标记为 Done:{names}', 'Guide pages marked Done ({n}): {names}'],
    statusStaged:           ['{n} 个攻略页退回 Staged(加了新成就,掉出 100%):{names}', 'Guide pages back to Staged, pushed below 100% by new achievements ({n}): {names}'],
    statusFailed:           ['攻略状态更新失败:{error}', 'Updating guide statuses failed: {error}'],
    listSep:                ['、', ', '],
    more:                   [' 等', ' and more'],
  };

  const isEnglish = () => (document.documentElement.lang || '').toLowerCase().startsWith('en');

  /**
   * One string, `{slot}` filled from `values`. **An unknown key returns the key**, as the page's own
   * `t()` does: a key on screen names the missing entry, where a blank would read as a layout bug.
   *
   * The slots are filled in a single pass, so a value is never itself searched for slots — a game
   * whose name happens to contain `{n}` is shown as written rather than having the count put inside it.
   */
  const t = (key, values) => {
    const pair = STRINGS[key];
    if (!pair) return key;
    const s = pair[isEnglish() ? 1 : 0] || pair[0];
    return values ? s.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)) : s;
  };

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
                  throw new Error(body?.error || t('requestFailed'));
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
    /* **Only a sticky bar gets a ×.** Progress is replaced by the next tick and the plain
       completion line takes itself away after three seconds — on either, the button would be
       undoing something already leaving, and on progress the next poll would bring it straight
       back, which reads as a control that ignores you. */
    .rpc-close {
      display: none;
      position: absolute;
      /* Centred on the **first line of text**, not on the bar's own top edge — two anchors that
         happen to sit close, which is the mistake .gen-close made and had corrected. padding-top
         is 11px and the first line box is 13px × 1.55 = 20.15px, so that line's centre is at
         11 + 20.15/2 = 21.1px; this button is 28px tall, so its top is 21.1 − 14 = 7.1px */
      top: 7px;
      right: 5px;
      /* 12px icon + 8px padding a side = 28×28, **clear of** WCAG 2.2 SC 2.5.8's 24×24 minimum
         pointer target rather than one pixel under it, which is where .gen-close started */
      padding: 8px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-3, #6d7f95);
      line-height: 0;
      border-radius: var(--r-sm, 4px);
    }
    .rpc-bar[data-sticky="1"] .rpc-close { display: inline-flex; }
    /* Reserved only where there is a button to reserve it for, or every progress line carries a
       right margin against nothing */
    .rpc-bar[data-sticky="1"] { padding-right: 38px; }
    .rpc-close:hover { color: var(--text, #dce6f2); background: rgba(255,255,255,.08); }
    .rpc-close svg { width: 12px; height: 12px; display: block; }
  `;
  const bar = document.createElement('div');
  bar.className = 'rpc-bar';
  /**
   * **The lines live in their own child, and that is what makes a corner button possible at all.**
   * `show()` replaces the content wholesale, so anything written into `bar` itself is destroyed on
   * the next call — a button appended once would survive exactly until the next notice.
   */
  const barBody = document.createElement('div');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rpc-close';
  // Its name and tooltip are given in show(), not here — see the note there
  /* Drawn here rather than `<use href="#i-close">` — same reasoning as the block above: that id
     lives in another file, and renaming it would leave a button with nothing in it */
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  /**
   * **Clearing the flag matters as much as hiding.** Left set, `data-sticky` would go on guarding
   * the poll's own hide for a bar that is already gone, so the next notice would arrive on top of
   * stale state rather than a clean one.
   *
   * Writing `style.display` is also the signal the Dashboard's `#toTop` observer watches
   * (`attributeFilter: ['style']`): while this bar shows, the back-to-top button sits 60px higher
   * to keep out of its way, and before the sticky flag existed that displacement lasted three
   * seconds. It now lasts until this button is pressed, which is the whole reason it exists.
   */
  closeBtn.addEventListener('click', () => {
    bar.dataset.sticky = '';
    bar.style.display = 'none';
  });
  bar.appendChild(barBody);
  bar.appendChild(closeBtn);
  document.addEventListener('DOMContentLoaded', () => {
    document.head.appendChild(barCss);
    document.body.appendChild(bar);
  });

  /**
   * One line. kind decides the colour of the dot in front.
   *
   * **The content is wrapped in its own block, and that wrapper is load-bearing.** `.rpc-line` is a
   * flex row so the dot can sit on the first baseline — which means a bare `<br>` in the html does
   * not break the line at all: the run after it becomes a second flex item and lands *beside* the
   * text instead of under it. Every caller that adds a `<span class="rpc-sub">` explanation was
   * rendering it as a right-hand column. One wrapper makes the html flow the way it reads.
   */
  const line = (kind, html) => `<div class="rpc-line" data-kind="${kind}"><div>${html}</div></div>`;

  /**
   * Swapping the content also sets the bar's state colour — the two must happen together, or
   * written apart they eventually disagree.
   *
   * **`sticky` is what makes "does not auto-dismiss" true.** The poll's final `else` hides the bar
   * on any tick where nothing is running, and the completion branch clears `wasRunning` on its way
   * out — so every notice used to survive exactly one 3-second tick and then vanish, however
   * emphatically the comment above it said otherwise. A retro-added achievement and an automatic
   * Notion write are precisely the things you cannot notice on your own; three seconds is not a
   * notice. The flag lives on the element rather than in a closure variable so the two can never
   * drift apart from each other.
   *
   * **It also decides whether the bar can be dismissed at all**, which is the other half of the
   * same rule: a notice that never leaves on its own has to be able to leave when told, or the
   * corner is occupied until the next sync — and with `syncStaleHours` at 12 and the app living in
   * the tray, that is measured in hours, not minutes. `.rpc-close` is drawn only for `sticky`,
   * so the two states that take themselves away are the two that carry no button.
   */
  const show = (state, lines, { sticky = false } = {}) => {
    bar.dataset.state = state;
    bar.dataset.sticky = sticky ? '1' : '';
    // The button is named here rather than where it is built: it is built when this script loads,
    // before the page has settled its language, so a name given then would stay in whichever
    // language happened to be current
    closeBtn.title = t('close');
    closeBtn.setAttribute('aria-label', t('close'));
    bar.style.display = 'block';
    // Into the body, never `bar` itself — see the note on barBody above
    barBody.innerHTML = Array.isArray(lines) ? lines.join('') : lines;
  };

  /** Composed when it is shown, so it is in the language current then rather than at load */
  const reloadLink = () => ' — <a href="#" onclick="location.reload();return false;">' + t('reload') + '</a>';

  // Game and achievement names come from Steam, guide names from Notion, and all of them go
  // into innerHTML, so escape before concatenating. A local page, so the risk is low, but
  // there is no reason not to
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /**
   * The first three names, escaped, then a marker when there were more — the separator and the
   * marker both in the language current now. Every sentence these go into states the count
   * first, so the marker carries none
   */
  const names = (list, pick = (x) => x) =>
    esc(list.slice(0, 3).map(pick).join(t('listSep'))) + (list.length > 3 ? t('more') : '');

  /**
   * The results of automatic ticking. This writes to the user's guide notes in Notion rather
   * than to local data, so like bumped it **does not auto-dismiss** — missing this notice
   * leaves sync_log as the only way to find out.
   */
  function tickNotices(s) {
    const out = [];
    const ticked = s.ticked || [];
    if (ticked.length) {
      out.push(line('ok', t('ticked', { n: ticked.length, names: names(ticked) })));
    }
    if (s.tickError) {
      out.push(line('warn',
        t('tickFailed', { error: esc(s.tickError) }) +
          '<br><span class="rpc-sub">' + t('tickFailedSub') + '</span>'
      ));
    }
    const statusDone = s.statusDone || [];
    if (statusDone.length) {
      out.push(line('ok', t('statusDone', { n: statusDone.length, names: names(statusDone) })));
    }
    // Dropping below 100% deserves saying out loud more than completing does: it means a game
    // you thought was finished has had new achievements added
    const statusStaged = s.statusStaged || [];
    if (statusStaged.length) {
      out.push(line('warn', t('statusStaged', { n: statusStaged.length, names: names(statusStaged) })));
    }
    if (s.statusError) {
      out.push(line('warn', t('statusFailed', { error: esc(s.statusError) })));
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
          // A phase with no label says only that a sync is running, rather than putting a key on screen
          const phaseKey = 'phase.' + s.phase;
          const phase = STRINGS[phaseKey] ? t(phaseKey) : t('syncing');
          const progress = s.total ? ` ${s.done}/${s.total}` : '';
          show('running', line('info',
            t('running', { phase: phase + progress }) +
            (s.name ? `<br><span class="rpc-sub">${esc(s.name)}</span>` : '')
          ));
        } else if (wasRunning) {
          wasRunning = false;

          // Don't auto-refresh on failure: the data on the page hasn't changed, and a refresh
          // would only wipe out the error notice — which is the only clue to the failure the
          // user ever gets
          if (s.error) {
            show('error', line('error', t('failed', { error: esc(s.error) }) + reloadLink()), { sticky: true });
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
              line('ok', t('doneEditing') + reloadLink()),
              ...tickNotices(s),
            ], { sticky: true });
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
              notices.push(line('info', t('bumped', { n: bumped.length, names: names(bumped) })));
            }
            // **Rows Steam will not answer for again.** Separate from the retry count on purpose:
            // one means "ask later", this means "never". The number on those rows is frozen at the
            // last successful read and nothing on screen would otherwise say so. It repeats every
            // sync until the row is locked — that is deliberate, because it is actionable and the
            // action is one click, which also removes the cause
            const forbidden = s.forbidden || [];
            if (forbidden.length) {
              notices.push(line('warn',
                t('forbidden', { n: forbidden.length, names: names(forbidden) }) +
                  '<br><span class="rpc-sub">' + t('forbiddenSub') + '</span>'
              ));
            }

            // The one row the sync creates on its own. A new line among three hundred is invisible,
            // and this one was never asked for, so it says so — and like the rest of these it does
            // not auto-dismiss
            const familyAdded = s.familyAdded || [];
            if (familyAdded.length) {
              notices.push(line('ok',
                t('familyAdded', { n: familyAdded.length, names: names(familyAdded, (a) => a.name) })
              ));
            }
            notices.push(...tickNotices(s));

            const done = line('ok', t('done'));
            if (notices.length) {
              show('ok', [done, ...notices], { sticky: true });
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
        } else if (bar.dataset.sticky !== '1') {
          // Nothing running and nothing to keep on screen. A sticky bar is left alone: it is
          // reporting something that already happened, and the next sync is what replaces it
          bar.style.display = 'none';
        }
      })
      .catch(() => {});
  }

  poll();
  setInterval(poll, 3000);
})();
