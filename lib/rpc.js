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
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:9999',
    'background:rgba(20,22,28,.94)', 'color:#e8eaf0', 'font-size:13px',
    'padding:10px 14px', 'border-radius:8px', 'border:1px solid rgba(255,255,255,.14)',
    'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'display:none', 'max-width:340px',
    'font-family:system-ui,-apple-system,sans-serif', 'line-height:1.5',
  ].join(';');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));

  const PHASE_LABEL = {
    library: '检查库里的新游戏',
    achievements: '刷新成就完成数',
    schema: '同步成就详情',
  };

  let wasRunning = false;

  function poll() {
    fetch('/api/syncStatus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then(({ result: s }) => {
        if (!s) return;
        if (s.running) {
          wasRunning = true;
          const phase = PHASE_LABEL[s.phase] || '同步中';
          const progress = s.total ? ` ${s.done}/${s.total}` : '';
          bar.style.display = 'block';
          bar.innerHTML =
            `⏳ 后台同步:${phase}${progress}` +
            (s.name ? `<br><span style="opacity:.6">${s.name}</span>` : '');
        } else if (wasRunning) {
          wasRunning = false;
          bar.style.display = 'block';

          // 失败的时候不自动刷新:页面上的数据没变,刷新只会把错误提示冲掉,
          // 而这条提示正是用户唯一能看到的失败线索
          if (s.error) {
            bar.innerHTML =
              `⚠️ 同步失败:${s.error}` +
              ' — <a href="#" style="color:#7fb2ff" onclick="location.reload();return false;">刷新页面</a>';
            return;
          }

          // 正在手改 Manual 行的数字时不要刷新——render() 会重建整张表格,
          // 把还没提交的输入吃掉。这种情况退回手动链接
          const active = document.activeElement;
          if (active && active.classList && active.classList.contains('manual-input')) {
            bar.innerHTML =
              '✅ 同步完成(检测到你正在编辑,没有自动刷新)' +
              ' — <a href="#" style="color:#7fb2ff" onclick="location.reload();return false;">刷新页面</a>';
            return;
          }

          if (typeof window.reloadDashboard === 'function') {
            const y = window.scrollY;
            window.reloadDashboard();
            // 表格是重建的,滚动位置会跳回顶部,渲染完再挪回去
            requestAnimationFrame(() => window.scrollTo(0, y));

            // 有游戏新增了成就就说出来。这类变化不需要你玩过也会发生(开发者打补丁),
            // 完美游戏还会因此掉出 100%,是唯一一种"你不看就不会知道"的变化
            const bumped = s.bumped || [];
            if (bumped.length) {
              const shown = bumped.slice(0, 3).join('、');
              bar.innerHTML =
                '✅ 同步完成,数据已自动刷新<br>' +
                '🆕 ' + bumped.length + ' 款游戏新增了成就:' + shown +
                (bumped.length > 3 ? ' 等' : '');
              return; // 这条不自动消失——错过了就得等下次同步才会再提
            }

            bar.innerHTML = '✅ 同步完成,数据已自动刷新';
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
