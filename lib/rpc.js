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
          bar.innerHTML =
            (s.error ? `⚠️ 同步失败:${s.error}` : '✅ 同步完成') +
            ' — <a href="#" style="color:#7fb2ff" onclick="location.reload();return false;">刷新页面</a>';
        } else {
          bar.style.display = 'none';
        }
      })
      .catch(() => {});
  }

  poll();
  setInterval(poll, 3000);
})();
