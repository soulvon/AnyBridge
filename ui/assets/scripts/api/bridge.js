/**
 * api/bridge.js — Tauri bridge（P4 共享层）
 *
 * 状态（TAURI / invoke / tauriEvent / appWindow）只存在 globalThis 上，
 * 保证功能模块里的自由变量读写与 bindTauriBridge 更新一致。
 * 函数真正 export，并 mirror 到 globalThis 供 data-action 使用。
 */
export function _diag(msg) {
  console.log('[DIAG]', msg);
}

if (!('TAURI' in globalThis)) globalThis.TAURI = null;
if (!('invoke' in globalThis)) globalThis.invoke = null;
if (!('tauriEvent' in globalThis)) globalThis.tauriEvent = null;
if (!('appWindow' in globalThis)) globalThis.appWindow = null;

export function bindTauriBridge() {
  const TAURI = window.__TAURI__ || null;
  const invoke = TAURI?.core?.invoke || null;
  const tauriEvent = TAURI?.event || null;
  let appWindow = null;
  try {
    appWindow = TAURI?.window?.getCurrentWindow ? TAURI.window.getCurrentWindow() : null;
  } catch {
    appWindow = null;
  }
  globalThis.TAURI = TAURI;
  globalThis.invoke = invoke;
  globalThis.tauriEvent = tauriEvent;
  globalThis.appWindow = appWindow;
  _diag(`bindTauriBridge: __TAURI__=${!!TAURI} invoke=${!!invoke} appWindow=${!!appWindow}`);
  return !!invoke;
}

export async function ensureTauriBridge(maxWaitMs = 3000) {
  _diag('ensureTauriBridge: start waiting...');
  if (bindTauriBridge()) {
    _diag('ensureTauriBridge: immediate OK');
    return true;
  }
  let waited = 0;
  const step = 100;
  while (waited < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, step));
    waited += step;
    if (bindTauriBridge()) {
      _diag(`ensureTauriBridge: OK after ${waited}ms`);
      return true;
    }
  }
  _diag('ensureTauriBridge: FAILED - bridge never became available');
  return false;
}

globalThis._diag = _diag;
globalThis.bindTauriBridge = bindTauriBridge;
globalThis.ensureTauriBridge = ensureTauriBridge;

window.addEventListener('error', (e) => _diag(`UNCAUGHT: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => _diag(`UNHANDLED: ${e.reason}`));
