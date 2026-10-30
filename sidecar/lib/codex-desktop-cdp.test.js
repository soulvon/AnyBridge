// Codex CDP 目标判定单测。
//
// 事故背景（2026-10 实测）：新版 Codex Desktop 把 CDP 绑在 ::1，而 IPv4 回环上
// 可能另有 Electron 应用占着同一端口。旧的「取第一个 page」把补丁注入了
// Antigravity IDE 的 workbench。这里用真实双栈双进程把这个场景钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { isCodexDesktopTarget, pickPageTarget, listTargets } from './codex-desktop-cdp.js';

const CODEX_MAIN = {
  id: 'p1',
  type: 'page',
  title: 'ChatGPT',
  url: 'app://-/index.html',
  webSocketDebuggerUrl: 'ws://[::1]:1/devtools/page/p1',
};
const CODEX_SPOTLIGHT = {
  id: 'p2',
  type: 'page',
  title: 'ChatGPT',
  url: 'app://-/index.html?initialRoute=%2Fspotlight',
  webSocketDebuggerUrl: 'ws://[::1]:1/devtools/page/p2',
};
const CODEX_WEBVIEW = {
  id: 'w1',
  type: 'webview',
  url: 'codex-sandbox://codex-inline-visualization.web-sandbox.oaiusercontent.com',
};
const IDE_PAGE = {
  id: 'i1',
  type: 'page',
  title: 'Antigravity IDE - 测试',
  url: 'vscode-file://vscode-app/c:/Users/x/AppData/Local/Programs/Antigravity IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/i1',
};

test('新版 Codex：识别 app:// 主窗口，并排除 webview 与 spotlight 子路由', () => {
  assert.equal(isCodexDesktopTarget(CODEX_MAIN), true);
  assert.equal(isCodexDesktopTarget(CODEX_SPOTLIGHT), true);
  assert.equal(isCodexDesktopTarget(CODEX_WEBVIEW), false);
  const picked = pickPageTarget([CODEX_WEBVIEW, CODEX_SPOTLIGHT, CODEX_MAIN]);
  assert.equal(picked.url, 'app://-/index.html', '应优先主窗口而不是 spotlight 子路由');
});

test('端口被别的 Electron 应用占用时拒绝注入，而不是打到别人页面上', () => {
  assert.equal(isCodexDesktopTarget(IDE_PAGE), false);
  assert.equal(pickPageTarget([IDE_PAGE]), null);
});

test('旧版 Codex 的 URL 特征未知时保持兼容（首个 page）', () => {
  const legacy = {
    id: 'l1',
    type: 'page',
    title: 'Codex',
    url: 'file:///C:/Codex/resources/app/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/l1',
  };
  assert.notEqual(pickPageTarget([legacy]), null);
});

test('listTargets：IPv4 是 IDE、IPv6 是 Codex 时选 Codex 那组', async (t) => {
  const codexServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([CODEX_WEBVIEW, CODEX_MAIN]));
  });
  const ideServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([IDE_PAGE]));
  });

  await new Promise((resolve, reject) => {
    codexServer.once('error', reject);
    codexServer.listen(0, '::1', resolve);
  });
  const port = codexServer.address().port;

  let dualStack = true;
  await new Promise((resolve) => {
    ideServer.once('error', () => { dualStack = false; resolve(); });
    ideServer.listen(port, '127.0.0.1', resolve);
  });
  if (!dualStack) {
    t.diagnostic('本机不允许同端口分地址族绑定，跳过双栈用例');
    codexServer.close();
    return;
  }

  try {
    const targets = await listTargets(port);
    assert.ok(
      targets.some((x) => x.type === 'page' && /^app:\/\/-\//.test(String(x.url || ''))),
      '必须返回 Codex 那组，而不是 IPv4 上 IDE 的 target 列表',
    );
    assert.equal(pickPageTarget(targets)?.id, 'p1');
  } finally {
    codexServer.close();
    ideServer.close();
  }
});
