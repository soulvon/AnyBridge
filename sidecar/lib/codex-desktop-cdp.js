// codex-desktop-cdp.js
//
// CDP (Chrome DevTools Protocol) client for injecting patches into the
// Codex Desktop renderer process. Language-agnostic HTTP + WebSocket —
// no native deps, uses Node 22 global WebSocket.
//
// Flow (injectWithRetry):
//   1. Retry until renderer ready or timeout:
//      a. GET http://127.0.0.1:{port}/json  → list targets (no system proxy)
//      b. Pick the Codex page target (type=="page" + webSocketDebuggerUrl)
//      c. Open WebSocket to webSocketDebuggerUrl
//      d. Runtime.enable → Page.addScriptToEvaluateOnNewDocument{source}
//         → Runtime.evaluate{expression}  (immediate + future-document inject)
//      e. Close WebSocket
//   2. On success return; on failure record real reason, wait, retry.
//   3. Timeout → expose last real error (no silent fallback).
//
// Ported from CodexPlusPlus cdp.py (list_targets, pick_page_target,
// evaluate_script, add_script_to_new_documents). Key difference: we use
// the global WebSocket (Node 22) instead of the `websocket-client` lib,
// and the `http` module with no agent (§4.17: system proxy intercepts localhost).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInjectionScript } from './codex-desktop-inject.js';

// WebSocket: 优先 Node 22+ 全局 WebSocket（release pkg exe 内置）；
// 回退 ws 包（dev 模式 node 20 无全局 WebSocket，typeof 检查避免 ReferenceError）。
const WSImpl = typeof WebSocket === 'function' ? WebSocket : (await import('ws')).default;
const CDP_TIMEOUT_MS = 8000;

/**
 * Read the full model objects from the AnyBridge catalog file
 * (~/.codex/anybridge-model-catalog.json). Returns objects in Codex-internal
 * format ({slug, display_name, description, ...}) suitable for injection.
 * @returns {Array<object>}
 */
export function readInjectableModels() {
  const catalogFile = path.join(os.homedir(), '.codex', 'anybridge-model-catalog.json');
  if (!fs.existsSync(catalogFile)) {
    throw new Error(`Codex model catalog not found: ${catalogFile}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse Codex model catalog ${catalogFile}: ${err.message || err}`);
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.models) ? parsed.models : null);
  if (!Array.isArray(arr)) {
    throw new Error(`Codex model catalog has no models array: ${catalogFile}`);
  }
  const models = arr.filter((m) => m && (m.slug || m.model));
  if (!models.length) {
    throw new Error(`Codex model catalog has no injectable models: ${catalogFile}`);
  }
  return models;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const arr = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(arr) ? arr : []);
        } catch (e) {
          reject(new Error(`CDP /json parse failed: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`CDP /json timeout`)); });
  });
}

/**
 * GET /json from the CDP HTTP endpoint. Tries IPv4 + IPv6.
 * @param {number} port
 * @returns {Promise<Array<object>>}
 */
export async function listTargets(port) {
  const urls = [`http://127.0.0.1:${port}/json`, `http://[::1]:${port}/json`];
  const errors = [];
  for (const url of urls) {
    try {
      const targets = await httpGetJson(url);
      if (Array.isArray(targets)) return targets;
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

/**
 * Pick the best page target: prefer one whose title/url mentions "codex",
 * otherwise fall back to the first page target.
 * @param {Array<object>} targets
 * @returns {object|null}
 */
export function pickPageTarget(targets) {
  const pages = targets.filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl,
  );
  if (!pages.length) return null;
  for (const t of pages) {
    const hay = `${t.title || ''} ${t.url || ''}`.toLowerCase();
    if (hay.includes('codex')) return t;
  }
  return pages[0];
}

/**
 * Send a single CDP command over WebSocket and await its response.
 * Ignores intermediate events (method-only messages without matching id).
 * @param {WebSocket} ws
 * @param {number} id
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>} the response result
 */
function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      reject(new Error(`CDP ${method} timeout after ${CDP_TIMEOUT_MS}ms`));
    }, CDP_TIMEOUT_MS);

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '{}');
      } catch {
        return;
      }
      if (msg.id === id) {
        clearTimeout(timer);
        ws.onmessage = null;
        if (msg.error) {
          reject(new Error(`CDP ${method} error: ${JSON.stringify(msg.error)}`));
        } else {
          resolve(msg.result || {});
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      ws.onmessage = null;
      reject(new Error(`CDP ${method} websocket error`));
    };

    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Wait for the WebSocket to open.
 * @param {WebSocket} ws
 * @returns {Promise<void>}
 */
function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WSImpl.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), CDP_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
  });
}

/**
 * 单次注入尝试：连 CDP → 装 6 点 patch。失败抛错，由 injectWithRetry 决定是否重试。
 *
 * @param {number} port  CDP debug port
 * @param {Array<object>} models  Codex-format model objects
 * @returns {Promise<{message:string, target?:object, evalResult?:string}>}
 * @throws {Error} 带真实失败原因（连不上 / 无 page target / patch 异常）
 */
async function injectOnce(port, models) {
  const targets = await listTargets(port);
  const target = pickPageTarget(targets);
  if (!target) {
    throw new Error(`No injectable Codex page target (CDP ${targets.length} targets, none is type=="page" with webSocketDebuggerUrl)`);
  }

  const wsUrl = target.webSocketDebuggerUrl;
  const script = buildInjectionScript(models);

  let ws;
  try {
    ws = new WSImpl(wsUrl);
    await waitForOpen(ws);

    await cdpSend(ws, 1, 'Runtime.enable', {});
    await cdpSend(ws, 2, 'Page.addScriptToEvaluateOnNewDocument', { source: script });
    const evalResult = await cdpSend(ws, 3, 'Runtime.evaluate', {
      expression: script,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });

    const evalValue = evalResult?.result?.value || evalResult?.result?.description || 'ok';
    ws.close();
    return {
      message: `Injected ${models.length} custom models into Codex Desktop`,
      target: { id: target.id, title: target.title, url: target.url },
      evalResult: evalValue,
    };
  } catch (err) {
    if (ws) { try { ws.close(); } catch (_) {} }
    throw err;
  }
}

/**
 * 注入 6 点 patch，自带 renderer 就绪重试。
 *
 * 重试不是兜底——launch 后 renderer 需要几秒才加载完 __STATSIG__/webpack 模块，
 * 此前 listTargets 拿不到 page target 或连不上 WebSocket 是正常时序。
 * 重试就是等 renderer 就绪，超时则暴露最后一次真实错误。
 *
 * @param {number} port  CDP debug port (default 9229)
 * @param {Array<object>} models  Codex-format model objects to inject
 * @param {number} [timeoutMs=15000]  最长等待 renderer 就绪的时间
 * @returns {Promise<{ok:boolean, message:string, target?:object, evalResult?:string}>}
 */
export async function injectWithRetry(port, models, timeoutMs = 15000) {
  if (!Array.isArray(models) || !models.length) {
    return { ok: false, message: 'No Codex custom models to inject. Check ~/.codex/anybridge-model-catalog.json.' };
  }

  const deadline = Date.now() + timeoutMs;
  const interval = 500;
  let lastError = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const result = await injectOnce(port, models);
      return { ok: true, ...result };
    } catch (err) {
      lastError = err;
      // 还在时限内 → 等 renderer 就绪后重试（这是正常时序，不是失败）
      if (Date.now() + interval < deadline) {
        await new Promise(r => setTimeout(r, interval));
      }
    }
  }

  // 超时 → 暴露最后一次真实错误，不静默
  const reason = lastError?.message || String(lastError || 'unknown');
  return {
    ok: false,
    message: `Codex renderer 未在 ${timeoutMs / 1000}s 内就绪，注入失败。最后状态: ${reason}`,
  };
}

/**
 * Check whether the injection guard is already present (for watcher re-inject).
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isAlreadyInjected(port) {
  try {
    const targets = await listTargets(port);
    const target = pickPageTarget(targets);
    if (!target) return false;
    const ws = new WSImpl(target.webSocketDebuggerUrl);
    await waitForOpen(ws);
    await cdpSend(ws, 1, 'Runtime.enable', {});
    const result = await cdpSend(ws, 2, 'Runtime.evaluate', {
      expression: 'typeof window.__ccSwitchCodexModelPickerUnlockV6 !== "undefined"',
      allowUnsafeEvalBlockedByCSP: true,
    });
    ws.close();
    return result?.result?.value === true;
  } catch {
    return false;
  }
}
