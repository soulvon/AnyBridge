// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// 运行期诊断输出（默认仅控制台，不在界面展示）
function _diag(msg) { console.log('[DIAG]', msg); }
window.addEventListener('error', e => _diag(`UNCAUGHT: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => _diag(`UNHANDLED: ${e.reason}`));


globalThis.TAURI = null;
globalThis.invoke = null;
globalThis.tauriEvent = null;
globalThis.appWindow = null;

function bindTauriBridge() {
  TAURI = window.__TAURI__ || null;
  invoke = TAURI?.core?.invoke || null;
  tauriEvent = TAURI?.event || null;
  try {
    appWindow = TAURI?.window?.getCurrentWindow ? TAURI.window.getCurrentWindow() : null;
  } catch { appWindow = null; }
  _diag(`bindTauriBridge: __TAURI__=${!!TAURI} invoke=${!!invoke} appWindow=${!!appWindow}`);
  return !!invoke;
}

async function ensureTauriBridge(maxWaitMs = 3000) {
  _diag('ensureTauriBridge: start waiting...');
  if (bindTauriBridge()) { _diag('ensureTauriBridge: immediate OK'); return true; }
  let waited = 0;
  const step = 100;
  while (waited < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, step));
    waited += step;
    if (bindTauriBridge()) { _diag(`ensureTauriBridge: OK after ${waited}ms`); return true; }
  }
  _diag('ensureTauriBridge: FAILED - bridge never became available');
  return false;
}

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g._diag = _diag;
  g.bindTauriBridge = bindTauriBridge;
  g.ensureTauriBridge = ensureTauriBridge;
})(globalThis);
