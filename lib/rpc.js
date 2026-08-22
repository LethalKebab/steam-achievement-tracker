/**
 * rpc —— Dashboard 前端调后端的薄封装
 * ------------------------------------------------
 * 用法(Dashboard.html 里 11 处都是这个形状):
 *   rpc.withSuccessHandler(fn).withFailureHandler(fn).someMethod(args...)
 * 转成 POST /api/someMethod,body 是 {args: [...]},由 lib/api.js 里的同名方法处理。
 *
 * 用回调链而不是 Promise,是因为前端每处调用都要区分成功/失败两条路径
 * (乐观更新 + 失败回滚),这个形状读起来最直接。
 *
 * 约定:
 * - 方法正常返回(包括返回 {error: '...'} 这种业务错误)→ 走 successHandler,
 *   由前端自己看 result.error 决定怎么提示
 * - 网络失败 / 服务端抛异常 → 走 failureHandler,收到一个带 .message 的 Error
 * 加后端方法只需要往 lib/api.js 里加,这里不用动——任何方法名都会被代理。
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

          // 其他任何属性名都当成"要调用的后端方法"
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
  // 后台同步状态提示条(serve 启动时数据太旧会自动跑一次全量同步)
  // ---------------------------------------------------------------------------
  /*
    这条状态条**浮在页面所有内容之上**,所以它长什么样决定了整个界面看上去是不是
    一套东西 —— 颜色**不能写死成 rgba**,那和页面的设计令牌毫无关系。

    用 `var(--令牌, 回退值)`:在 Dashboard 上取到的是那套令牌,颜色、圆角、投影跟着
    页面走;万一被塞进一个没定义令牌的页面,回退值让它照样能看。
    **样式挂在注入的 <style> 里而不是 cssText**,因为下面要按状态换色、还要给
    每条提示画一个小圆点,这些用行内样式写不了。

    状态靠**左边那道色条**和每行前面的小圆点表达,不用 emoji 前缀。
    理由和页面上换掉 emoji 是同一条:emoji 吃不到 color,各系统画得还不一样,
    七个不同的 ✅⚠️🆕☑️🏁↩️⏳ 拼在一条窄提示里,颜色比文字还吵。
    这里也刻意**不去 <use> Dashboard 的图标精灵** —— 那是另一个文件里的 id,
    一旦改名这里会静默变成一片空白,而这个项目最不接受的就是静默。
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
    /* 每条提示前面一个小圆点,颜色说明它是哪一类。**比 emoji 安静得多** */
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

  /** 一条提示。kind 决定前面那个圆点的颜色 */
  const line = (kind, html) => `<div class="rpc-line" data-kind="${kind}">${html}</div>`;

  /** 换内容顺带把整条的状态色定下来 —— 两件事必须一起做,分开写迟早对不上 */
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

  // 游戏名/成就名是 Steam 来的、攻略名是 Notion 来的,都往 innerHTML 里塞,
  // escape 一下再拼。本地页面,风险不高,但没有理由不做
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /**
   * 自动勾选的结果。写的是 Notion 里的攻略笔记而不是本地数据,所以和 bumped 一样
   * **不自动消失**——错过这条提示就只能去翻 sync_log 了。
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
        '自动勾选没跑成:' + esc(s.tickError) +
          '<br><span class="rpc-sub">成就数据已经同步好了,不受影响</span>'
      ));
    }
    const statusDone = s.statusDone || [];
    if (statusDone.length) {
      out.push(line('ok',
        statusDone.length + ' 个攻略页标成了 Done:' +
          esc(statusDone.slice(0, 3).join('、')) + (statusDone.length > 3 ? ' 等' : '')
      ));
    }
    // 掉出 100% 比打满更该说出口:它意味着有款你以为完成了的游戏加了新成就
    const statusStaged = s.statusStaged || [];
    if (statusStaged.length) {
      out.push(line('warn',
        statusStaged.length + ' 个攻略页退回 Staged(加了新成就,掉出 100%):' +
          esc(statusStaged.slice(0, 3).join('、')) + (statusStaged.length > 3 ? ' 等' : '')
      ));
    }
    if (s.statusError) {
      out.push(line('warn', '攻略状态没更新成:' + esc(s.statusError)));
    }
    return out;
  }

  let wasRunning = false;

  function poll() {
    fetch('/api/syncStatus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then(({ result: s }) => {
        if (!s) return;

        // 每次轮询都把状态抛给页面(Dashboard.html 用它管「立即同步」按钮的禁用态)。
        // 放在所有分支**之前**是必须的:下面失败和"正在编辑"两条路都会提前 return,
        // 挂在后面的话按钮会永远停在"同步中"解不开。
        if (typeof window.onSyncState === 'function') window.onSyncState(s);

        if (s.running) {
          wasRunning = true;
          const phase = PHASE_LABEL[s.phase] || '同步中';
          const progress = s.total ? ` ${s.done}/${s.total}` : '';
          show('running', line('info',
            `后台同步:${phase}${progress}` +
            (s.name ? `<br><span class="rpc-sub">${esc(s.name)}</span>` : '')
          ));
        } else if (wasRunning) {
          wasRunning = false;

          // 失败的时候不自动刷新:页面上的数据没变,刷新只会把错误提示冲掉,
          // 而这条提示正是用户唯一能看到的失败线索
          if (s.error) {
            show('error', line('error', `同步失败:${esc(s.error)}` + reloadLink));
            return;
          }

          // 正在手改 Manual 行的数字时不要刷新——render() 会重建整张表格,
          // 把还没提交的输入吃掉。这种情况退回手动链接
          const active = document.activeElement;
          if (active && active.classList && active.classList.contains('manual-input')) {
            // 勾选提示在这条路径上也要给出来:因为碰巧在编辑就把"动过你 Notion 笔记"
            // 这件事咽回去,正是这个项目最不能接受的那种静默
            show('ok', [
              line('ok', '同步完成(检测到你正在编辑,没有自动刷新)' + reloadLink),
              ...tickNotices(s),
            ]);
            return;
          }

          if (typeof window.reloadDashboard === 'function') {
            const y = window.scrollY;
            window.reloadDashboard();
            // 表格是重建的,滚动位置会跳回顶部,渲染完再挪回去
            requestAnimationFrame(() => window.scrollTo(0, y));

            // 有游戏新增了成就就说出来。这类变化不需要你玩过也会发生(开发者打补丁),
            // 完美游戏还会因此掉出 100%,是唯一一种"你不看就不会知道"的变化
            const notices = [];
            const bumped = s.bumped || [];
            if (bumped.length) {
              notices.push(line('info',
                bumped.length + ' 款游戏新增了成就:' +
                  esc(bumped.slice(0, 3).join('、')) + (bumped.length > 3 ? ' 等' : '')
              ));
            }
            notices.push(...tickNotices(s));

            const done = line('ok', '同步完成,数据已自动刷新');
            if (notices.length) {
              show('ok', [done, ...notices]);
              return; // 这些都不自动消失——错过了就得等下次同步才会再提
            }

            show('ok', done);
            setTimeout(() => {
              bar.style.display = 'none';
            }, 6000);
          } else {
            // 老版本 Dashboard.html 没有这个钩子,退回整页刷新
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
