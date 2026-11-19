import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../..');

export function discoverBrowserBin() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);

  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const bin of candidates) {
    if (bin && fs.existsSync(bin)) return bin;
  }
  return null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

async function waitForDebugPort(child, userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stderrBuf = '';
  let detectedPort = null;

  const onData = (chunk) => {
    stderrBuf += chunk.toString('utf8');
    const match = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//i);
    if (match) detectedPort = Number(match[1]);
  };
  child.stderr?.on('data', onData);
  child.stdout?.on('data', onData);

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    if (detectedPort) return detectedPort;
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      const parsed = Number(lines[0]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (child.exitCode !== null) {
      throw new Error(`Browser exited early (code=${child.exitCode}): ${stderrBuf.slice(-400)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for DevTools port: ${stderrBuf.slice(-400)}`);
}

async function waitForPageTarget(debugPort, initialUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const hostPrefix = new URL(initialUrl).origin;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      if (Array.isArray(targets)) {
        const match =
          targets.find((t) => t.type === 'page' && String(t.url || '').startsWith(hostPrefix) && t.webSocketDebuggerUrl) ||
          targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (match) return match;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Timed out discovering CDP page target on port ${debugPort}`);
}

export async function launchCdpSession(options = {}) {
  const {
    url = 'about:blank',
    userDataDir = path.join(REPO_ROOT, 'tmp', 'ui-browser-test', String(process.pid)),
    width = 1600,
    height = 960,
    timeoutMs = 20000,
  } = options;

  const browserBin = discoverBrowserBin();
  if (!browserBin) {
    throw new Error('未发现 Chrome/Edge 浏览器可执行文件，请设置 CHROME_BIN 环境变量');
  }
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('当前 Node 运行时缺少全局 WebSocket（需 Node >= 22）');
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  const browserArgs = [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    `--window-size=${width},${height}`,
    `--user-data-dir=${userDataDir}`,
    url,
  ];

  const child = spawn(browserBin, browserArgs, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ws = null;
  const cleanupProcess = async () => {
    try {
      if (ws && ws.readyState === globalThis.WebSocket.OPEN) ws.close();
    } catch {}
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    const debugPort = await waitForDebugPort(child, userDataDir, timeoutMs);
    const target = await waitForPageTarget(debugPort, url, timeoutMs);

    ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err?.error || new Error('CDP WebSocket error')); }, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const exceptions = [];
    const consoleErrors = [];

    ws.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else entry.resolve(msg.result || {});
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const det = msg.params?.exceptionDetails || {};
        const desc = det.exception?.description || det.text || 'Uncaught exception';
        exceptions.push({ text: desc, url: det.url || '', line: det.lineNumber ?? 0 });
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleErrors.push({ text: args });
      }
    });

    const send = (method, params = {}, callTimeout = 15000) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout on ${method}`));
        }, callTimeout);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluate error';
        throw new Error(desc);
      }
      return res.result?.value;
    };

    const setViewport = async (w, h) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
    };

    const screenshot = async (outPath) => {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
      return outPath;
    };

    const pressKey = async (key) => {
      const codeMap = { Escape: 27, Enter: 13, Tab: 9 };
      const vk = codeMap[key] || 0;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    };

    const waitFor = async (expr, { timeout = 10000, interval = 100, label = expr } = {}) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          const val = await evaluate(expr);
          if (val) return val;
        } catch {}
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error(`waitFor timeout (${timeout}ms): ${label}`);
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');
    await setViewport(width, height);

    return {
      browserBin,
      userDataDir,
      send,
      evaluate,
      setViewport,
      screenshot,
      pressKey,
      waitFor,
      getExceptions: () => [...exceptions],
      getConsoleErrors: () => [...consoleErrors],
      clearErrors: () => { exceptions.length = 0; consoleErrors.length = 0; },
      close: cleanupProcess,
    };
  } catch (err) {
    await cleanupProcess();
    throw err;
  }
}
