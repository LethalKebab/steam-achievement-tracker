/**
 * google.script.run → fetch 的兼容层
 * ------------------------------------------------
 * Dashboard.html 里 11 处调用全都是
 *   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).someMethod(args...)
 * 这个 shim 提供同样形状的链式对象,把调用转成 POST /api/someMethod。
 * 有它就不用改前端那一千行应用代码——本地化改动全部收在这一个文件里。
 *
 * 语义对齐 Apps Script:
 * - 方法正常返回(包括返回 {error: '...'} 这种业务错误)→ 走 successHandler
 * - 网络失败 / 服务端抛异常 → 走 failureHandler,收到一个带 .message 的 Error
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

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner({});
  // Apps Script 的 google.script.host（关闭弹窗之类）在本地没有对应物,给个空实现兜底
  window.google.script.host = window.google.script.host || { close() {}, setHeight() {} };

  // ---------------------------------------------------------------------------
  // 后台同步状态提示条(本地版特有:serve 启动时数据太旧会自动跑一次全量同步)
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
