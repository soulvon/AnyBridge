// codex-desktop-cdp.js
//
// CDP (Chrome DevTools Protocol) client for injecting patches into the
// Codex Desktop renderer process. Language-agnostic HTTP + WebSocket —
// no native deps, uses Node 22 global WebSocket.
//
// Flow:
//   1. GET http://127.0.0.1:{port}/json  → list targets (no system proxy)
//   2. Pick the Codex page target (type=="page" + webSocketDebuggerUrl)
//   3. Open WebSocket to webSocketDebuggerUrl
//   4. Runtime.enable → Page.addScriptToEvaluateOnNewDocument{source}
//      → Runtime.evaluate{expression}  (immediate + future-document inject)
//   5. Close WebSocket
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

const CDP_TIMEOUT_MS = 8000;

/**
 * Read the full model objects from the AnyBridge catalog file
 * (~/.codex/anybridge-model-catalog.json). Returns objects in Codex-internal
 * format ({slug, display_name, description, ...}) suitable for injection.
 * @returns {Array<object>}
 */
export function readInjectableModels() {
  try {
    const catalogFile = path.join(os.homedir(), '.codex', 'anybridge-model-catalog.json');
    if (!fs.existsSync(catalogFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.models) ? parsed.models : []);
    if (!Array.isArray(arr)) return [];
    return arr.filter((m) => m && (m.slug || m.model));
  } catch {
    return [];
  }
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
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), CDP_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
  });
}

/**
 * Inject the 6-point patch script into the Codex Desktop renderer.
 *
 * @param {number} port  CDP debug port (default 9229)
 * @param {Array<object>} models  Codex-format model objects to inject
 * @returns {Promise<{ok:boolean, message:string, target?:object, evalResult?:string}>}
 */
export async function injectPatches(port, models) {
  const targets = await listTargets(port);
  const target = pickPageTarget(targets);
  if (!target) {
    return { ok: false, message: 'No injectable Codex page target found (no type=="page" with webSocketDebuggerUrl)' };
  }

  const wsUrl = target.webSocketDebuggerUrl;
  const script = buildInjectionScript(models);

  let ws;
  try {
    ws = new WebSocket(wsUrl);
    await waitForOpen(ws);

    // 1. Enable Runtime (required for evaluate + binding events).
    await cdpSend(ws, 1, 'Runtime.enable', {});

    // 2. Register script for all future documents/navigations.
    await cdpSend(ws, 2, 'Page.addScriptToEvaluateOnNewDocument', { source: script });

    // 3. Evaluate immediately on the current page.
    const evalResult = await cdpSend(ws, 3, 'Runtime.evaluate', {
      expression: script,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });

    const evalValue = evalResult?.result?.value || evalResult?.result?.description || 'ok';

    ws.close();
    return {
      ok: true,
      message: `Injected ${Array.isArray(models) ? models.length : 0} custom models into Codex Desktop`,
      target: { id: target.id, title: target.title, url: target.url },
      evalResult: evalValue,
    };
  } catch (err) {
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
    }
    return { ok: false, message: err.message || String(err) };
  }
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
    const ws = new WebSocket(target.webSocketDebuggerUrl);
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
