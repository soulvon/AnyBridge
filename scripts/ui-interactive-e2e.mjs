#!/usr/bin/env node
// ui-interactive-e2e.mjs — @poteto 运行时交互与全栈穿透 E2E：
// 启动本地 Mock 上游 + 真 sidecar/proxy-entry + 隔离沙箱 + Chromium CDP，
// 验证供应商 CRUD、当帧 .ab-spinner 防死机、磁盘持久化+真刷新存活、UI->Sidecar 流式穿透、
// 模型映射行内改名落盘、平台接管/还原对称闭环与扩展中心无报错弹窗。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchCdpSession, REPO_ROOT } from './lib/cdp-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_SANDBOX_SCRIPT = path.join(__dirname, 'dev-sandbox.mjs');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'tmp', 'ui-screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function startMockUpstream() {
  const seenAuths = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const urlPath = (req.url || '/').split('?')[0];
      const auth = String(req.headers.authorization || req.headers['x-api-key'] || '');
      if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'poteto-gpt-4.1' }, { id: 'poteto-claude-4' }] }));
        return;
      }
      if (req.method === 'POST' && urlPath === '/v1/chat/completions') {
        seenAuths.push(auth);
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        if (json.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write(`data: ${JSON.stringify({ id: 'e2e-1', choices: [{ index: 0, delta: { content: 'Poteto E2E ' }, finish_reason: null }] })}\n\n`);
          await sleep(30);
          res.write(`data: ${JSON.stringify({ id: 'e2e-1', choices: [{ index: 0, delta: { content: 'stream OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 14, completion_tokens: 6 } })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        // 故意延迟 240ms，以便 Chromium 当帧准确捕获加载按钮禁用与唯一 .ab-spinner
        await sleep(240);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'e2e-probe', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected mock path ${urlPath}` } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    seenAuths,
    close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  })));
}

async function startLiveSandbox(sandboxDir) {
  fs.mkdirSync(sandboxDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [DEV_SANDBOX_SCRIPT, '--port', '0', '--api-port', '0', '--inference-port', '0', '--ag-https-port', '0', '--reseed', '--sandbox-dir', sandboxDir],
    { cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev-sandbox(sidecar) start timeout:\n${logs}`)), 20000);
    const onData = (chunk) => {
      logs += chunk.toString('utf8');
      const m = logs.match(/\[dev-sandbox\]\s+listening on\s+(http:\/\/127\.0\.0\.1:\d+)\s+\(sandbox=([^,]+),\s*sidecar=true,\s*apiPort=(\d+)/i);
      if (m) { clearTimeout(timer); resolve({ url: m[1], configDir: m[2].trim(), apiPort: Number(m[3]) }); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dev-sandbox exited (${code}):\n${logs}`)); });
  });
  return {
    ...info,
    getLogs: () => logs,
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        try { child.kill('SIGTERM'); } catch {}
        await sleep(250);
        if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
      }
      try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function readCfgJson(configDir, name) {
  return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
}

async function httpReq({ port, method = 'GET', reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function parseSseText(rawText) {
  let acc = '';
  for (const line of String(rawText || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try { acc += JSON.parse(raw)?.choices?.[0]?.delta?.content || ''; } catch {}
  }
  return acc;
}

async function waitUiReady(cdp) {
  await cdp.waitFor(
    'Boolean(window.__TAURI__?.__SANDBOX__ && window.ByokI18n && typeof navigateTo === "function" && document.querySelector(".page.active"))',
    { timeout: 15000, label: 'UI boot & sandbox bridge' },
  );
  await sleep(450);
}

async function testProviderCrudReloadAndSpinner(cdp, mockPort, configDir) {
  await cdp.evaluate(`(async () => { await navigateTo('providers'); })()`);
  await sleep(220);
  await cdp.evaluate(`document.querySelector('#page-providers [data-action="openProviderEditor"]')?.click()`);
  await cdp.waitFor('document.getElementById("page-provider-editor")?.classList.contains("active")', { label: 'enter provider editor' });

  await cdp.evaluate(`(() => {
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal('pf-name', 'Poteto 实测网关');
    setVal('pf-host', 'http://127.0.0.1:${mockPort}');
    document.getElementById('pfFormatTrigger')?.click();
    document.querySelector('.pf-format-option[data-format="openai"]')?.click();
    setVal('pf-key', 'sk-poteto-live-01');
    document.querySelector('[data-action="addEditorApiKey"]')?.click();
    const rows = document.querySelectorAll('#providerKeysList .provider-key-row');
    const last = rows[rows.length - 1];
    if (last) {
      const lb = last.querySelector('.provider-key-label');
      const kv = last.querySelector('.provider-key-value');
      if (lb) { lb.value = '备用密钥'; lb.dispatchEvent(new Event('input', { bubbles: true })); }
      if (kv) { kv.value = 'sk-poteto-bak-02'; kv.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  })()`);

  await cdp.evaluate(`document.getElementById('pf-fetch-btn')?.click()`);
  await cdp.waitFor('Boolean(document.querySelector("#modelPanelBody .model-item[data-arg=\\"poteto-gpt-4.1\\"]"))', { timeout: 8000, label: 'fetch models from mock upstream' });
  await cdp.evaluate(`(() => {
    const item = document.querySelector('#modelPanelBody .model-item[data-arg="poteto-gpt-4.1"]');
    if (item && !item.classList.contains('selected')) item.click();
    const item2 = document.querySelector('#modelPanelBody .model-item[data-arg="poteto-claude-4"]');
    if (item2 && !item2.classList.contains('selected')) item2.click();
  })()`);
  await cdp.waitFor('document.querySelectorAll("#leftSelectedModelsList > *").length >= 1', { label: 'models selected' });

  // 点击测试连接后 30ms 内同步验证当帧忙碌态：disabled + 唯一 .ab-spinner
  const immediateBusy = await cdp.evaluate(`(() => {
    const btn = document.getElementById('provider-editor-test-btn');
    btn?.click();
    return {
      disabled: Boolean(btn?.disabled),
      hasLoadingCls: btn?.classList.contains('is-loading') || false,
      spinnerCount: btn ? btn.querySelectorAll('.ab-spinner, .btn-spinner').length : -1,
      text: btn?.innerText?.trim() || '',
    };
  })()`);
  assert(immediateBusy.disabled && immediateBusy.hasLoadingCls, `异步测试按钮未立即进入忙碌态: ${JSON.stringify(immediateBusy)}`);
  assert(immediateBusy.spinnerCount === 1, `忙碌按钮 spinner 数量异常(需严格=1): ${JSON.stringify(immediateBusy)}`);

  await cdp.waitFor('document.getElementById("provider-editor-test-btn")?.disabled === false', { timeout: 8000, label: 'test button recover' });
  const testDone = await cdp.evaluate(`(() => {
    const btn = document.getElementById('provider-editor-test-btn');
    const bar = document.getElementById('providerEditorTestResult');
    return {
      spinnerAfter: btn ? btn.querySelectorAll('.ab-spinner').length : -1,
      barHidden: bar ? bar.hidden : true,
      barOk: bar?.classList.contains('is-success') || false,
      barText: bar?.textContent?.trim() || '',
    };
  })()`);
  assert(testDone.spinnerAfter === 0, `测试完成后残留 spinner: ${JSON.stringify(testDone)}`);
  assert(!testDone.barHidden && testDone.barOk && testDone.barText.includes('HTTP 200'), `测试结果条异常: ${JSON.stringify(testDone)}`);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'poteto-provider-test-ok.png'));

  await cdp.evaluate(`document.querySelector('#page-provider-editor [data-action="saveProviderFromEditor"]')?.click()`);
  await cdp.waitFor('document.getElementById("page-providers")?.classList.contains("active")', { label: 'return to providers page' });
  await sleep(220);

  const onDisk = readCfgJson(configDir, 'providers.json');
  const saved = (onDisk.providers || []).find((p) => p.name === 'Poteto 实测网关');
  assert(saved, '保存后 providers.json 未落盘 Poteto 实测网关');
  assert(saved.apiKey === 'sk-poteto-live-01', `apiKey 不符: ${saved.apiKey}`);
  assert(Array.isArray(saved.apiKeys) && saved.apiKeys.some((k) => k?.key === 'sk-poteto-bak-02'), `多密钥池未落盘: ${JSON.stringify(saved.apiKeys)}`);
  assert(Array.isArray(saved.models) && saved.models.includes('poteto-gpt-4.1'), `已选模型未落盘: ${JSON.stringify(saved.models)}`);

  // 真实浏览器 reload 验证状态并非只在 JS 内存里存活
  await cdp.evaluate('location.reload()');
  await waitUiReady(cdp);
  await cdp.evaluate(`(async () => { await navigateTo('providers'); })()`);
  await sleep(260);
  const survivedReload = await cdp.evaluate(`(() => {
    return Array.from(document.querySelectorAll('#providerGrid .provider-name')).some((el) => el.textContent.includes('Poteto 实测网关'));
  })()`);
  assert(survivedReload, '页面 reload 后新建供应商卡片丢失');
  return saved;
}

async function testUnlockAndTogglePersistence(cdp, savedProv, configDir) {
  await cdp.evaluate(`document.querySelector('[data-action="openProviderUnlockModal"][data-arg="${savedProv.id}"]')?.click()`);
  await cdp.waitFor('document.getElementById("provider-unlock-modal")?.classList.contains("active")', { label: 'open unlock modal' });
  await cdp.evaluate(`document.querySelector('#provider-unlock-body input[data-action="setProviderUnlockFromModal"][data-args*="codex"]')?.click()`);
  await sleep(260);
  const diskAfterUnlock = readCfgJson(configDir, 'providers.json');
  const provAfterUnlock = diskAfterUnlock.providers.find((p) => p.id === savedProv.id);
  assert(provAfterUnlock?.unlocks?.codex?.enabled === true, `解锁弹窗未写入 unlocks.codex.enabled=true: ${JSON.stringify(provAfterUnlock?.unlocks)}`);
  await cdp.evaluate(`document.querySelector('#provider-unlock-modal .modal-btn-confirm')?.click()`);
  await sleep(180);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'poteto-providers-after-crud.png'));

  await cdp.evaluate(`document.querySelector('#providerGrid input[data-action="toggleProviderEnabled"][data-arg="${savedProv.id}"]')?.click()`);
  await sleep(260);
  const disabledProv = readCfgJson(configDir, 'providers.json').providers.find((p) => p.id === savedProv.id);
  assert(disabledProv?.enabled === false, '停用供应商开关未同步落盘 enabled=false');
  await cdp.evaluate(`document.querySelector('#providerGrid input[data-action="toggleProviderEnabled"][data-arg="${savedProv.id}"]')?.click()`);
  await sleep(260);
  const reenabledProv = readCfgJson(configDir, 'providers.json').providers.find((p) => p.id === savedProv.id);
  assert(reenabledProv?.enabled === true, '重新启用供应商开关未落盘 enabled=true');
}

async function testUiToSidecarLiveRouting(cdp, savedProv, sidecarApiPort, mockUpstream) {
  const beforeStatsRes = await httpReq({ port: sidecarApiPort, reqPath: '/__byok/stats' });
  assert(beforeStatsRes.status === 200, `sidecar /__byok/stats failed: ${beforeStatsRes.status}`);
  const beforeReqs = Number(JSON.parse(beforeStatsRes.text).requests || 0);

  await cdp.evaluate(`(async () => {
    const store = await invoke('load_proxy_routes');
    const next = {
      ...(store || { version: 2, routes: [] }),
      routes: [
        ...((store && Array.isArray(store.routes)) ? store.routes.filter((r) => r.id !== 'poteto-live-route') : []),
        {
          uid: 'rt-poteto-live',
          id: 'poteto-live-route',
          displayName: 'Poteto Live Route',
          enabled: true,
          mode: 'auto',
          exposedFormats: ['openai'],
          capabilities: { stream: true, tools: true, vision: true, reasoning: false },
          targets: [{ providerId: ${JSON.stringify(savedProv.id)}, model: 'poteto-gpt-4.1', weight: 100, enabled: true }],
        },
      ],
    };
    await invoke('save_proxy_routes', { store: next });
  })()`);
  // 等待跨过 config-cache 2000ms TTL 使 sidecar 热重载新写入的 providers.json 与 proxy-routes.json
  await sleep(2200);

  const authHeaders = { authorization: 'Bearer byok-sandbox-demo-key-2026', 'content-type': 'application/json' };
  const streamRes = await httpReq({
    port: sidecarApiPort,
    method: 'POST',
    reqPath: '/v1/chat/completions',
    headers: authHeaders,
    body: { model: 'poteto-live-route', stream: true, messages: [{ role: 'user', content: 'ping poteto' }] },
  });
  assert(streamRes.status === 200, `UI->Sidecar 流式路由失败: HTTP ${streamRes.status} ${streamRes.text}`);
  const decoded = parseSseText(streamRes.text);
  assert(decoded === 'Poteto E2E stream OK', `UI->Sidecar 流式解码异常: "${decoded}" raw=${streamRes.text}`);
  assert(mockUpstream.seenAuths.includes('Bearer sk-poteto-live-01'), `Mock 上游未收到 UI 填入的密钥: ${JSON.stringify(mockUpstream.seenAuths)}`);

  const afterStats = JSON.parse((await httpReq({ port: sidecarApiPort, reqPath: '/__byok/stats' })).text);
  assert(Number(afterStats.requests) >= beforeReqs + 1, `Sidecar stats requests 未增长: before=${beforeReqs} after=${afterStats.requests}`);
}

async function testModelMapInlineEditAndSelection(cdp, configDir) {
  await cdp.evaluate(`(async () => { await navigateTo('models'); })()`);
  await sleep(260);
  const firstUid = await cdp.evaluate(`document.querySelector('#modelMapBody tr[data-row-kind="mapped"]')?.dataset?.modelUid || ''`);
  assert(firstUid, '#page-models 表格为空');

  await cdp.evaluate(`document.querySelector('#modelMapBody tr[data-model-uid="${firstUid}"] .editable-cell')?.click()`);
  await cdp.waitFor('Boolean(document.querySelector("#modelMapBody td.editable-cell input[type=\\"text\\"]"))', { label: 'inline edit input open' });
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#modelMapBody td.editable-cell input[type="text"]');
    input.value = '瑞士工作台实测槽位';
    input.focus();
  })()`);
  await cdp.pressKey('Enter');
  await cdp.waitFor('!document.querySelector("#modelMapBody td.editable-cell input[type=\\"text\\"]")', { label: 'inline edit saved' });
  await sleep(220);

  const rowText = await cdp.evaluate(`document.querySelector('#modelMapBody tr[data-model-uid="${firstUid}"] .model-map-display-name-text')?.textContent?.trim() || ''`);
  assert(rowText.includes('瑞士工作台实测槽位'), `DOM 未更新显示名: ${rowText}`);
  const mapJson = readCfgJson(configDir, 'model-map.json');
  const slotDisk = (mapJson.slots || []).find((s) => s.modelUid === firstUid);
  assert(slotDisk?.displayName === '瑞士工作台实测槽位', `磁盘 model-map.json 未更新 displayName: ${JSON.stringify(slotDisk)}`);

  await cdp.evaluate(`document.querySelector('#modelMapBody tr[data-model-uid="${firstUid}"] .model-map-row-check')?.click()`);
  await sleep(160);
  const rowSelected = await cdp.evaluate(`document.querySelector('#modelMapBody tr[data-model-uid="${firstUid}"]')?.classList.contains('is-selected') || false`);
  assert(rowSelected, '模型映射行勾选未激活 .is-selected');
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'poteto-model-map-edited.png'));
  await cdp.evaluate(`document.querySelector('#modelMapBody tr[data-model-uid="${firstUid}"] .model-map-row-check')?.click()`);
  await sleep(120);
}

async function testPlatformSwitchRestoreAndExtensions(cdp, configDir) {
  await cdp.evaluate(`(async () => { await navigateTo('platform-claude-code'); })()`);
  await sleep(280);
  await cdp.evaluate(`document.querySelector('#platform-claude-code-config-list button[data-action-call*="applyClaudeCodeProviderConfig"]')?.click()`);
  await cdp.waitFor('document.getElementById("custom-confirm-modal")?.classList.contains("active")', { label: 'claude-code switch confirm' });
  await cdp.evaluate(`document.getElementById('modal-btn-confirm')?.click()`);
  await cdp.waitFor('document.getElementById("custom-alert-modal")?.classList.contains("active")', { timeout: 8000, label: 'claude-code switch done alert' });
  await cdp.evaluate(`document.getElementById('custom-alert-ok-btn')?.click()`);
  await sleep(200);

  const afterApply = readCfgJson(configDir, 'sandbox-mock-state.json').platforms.find((p) => p.id === 'claude-code');
  assert(afterApply?.managedByAnyBridge === true, `Claude Code 切换未落盘 managedByAnyBridge=true: ${JSON.stringify(afterApply)}`);

  await cdp.evaluate(`document.getElementById('platform-claude-code-restore')?.click()`);
  await cdp.waitFor('document.getElementById("custom-confirm-modal")?.classList.contains("active")', { label: 'claude-code restore confirm' });
  await cdp.evaluate(`document.getElementById('modal-btn-confirm')?.click()`);
  await cdp.waitFor('document.getElementById("custom-alert-modal")?.classList.contains("active")', { timeout: 8000, label: 'claude-code restore done alert' });
  await cdp.evaluate(`document.getElementById('custom-alert-ok-btn')?.click()`);
  await sleep(200);

  const afterRestore = readCfgJson(configDir, 'sandbox-mock-state.json').platforms.find((p) => p.id === 'claude-code');
  assert(afterRestore?.managedByAnyBridge === false && afterRestore?.currentProviderId === null, `Claude Code 还原未对称清零: ${JSON.stringify(afterRestore)}`);

  await cdp.evaluate(`(async () => { await navigateTo('extensions'); })()`);
  await sleep(320);
  const cpaHasError = await cdp.evaluate(`Boolean(document.querySelector('[data-extension-card="cpa-suite"].is-error, #extension-cpa-alert:not([hidden])'))`);
  assert(!cpaHasError, '扩展中心 CPA 套件出现意外错误警示状态');

  await cdp.evaluate(`document.querySelector('.extension-tab[data-extension-tab="all"]')?.click()`);
  await sleep(180);
  await cdp.evaluate(`document.querySelector('.extension-tab[data-extension-tab="installed"]')?.click()`);
  await sleep(180);
  await cdp.evaluate(`(() => { if (typeof openExtensionDetail === 'function') openExtensionDetail('cpa-suite'); })()`);
  await cdp.waitFor('document.getElementById("extension-detail-modal")?.classList.contains("active")', { label: 'extension detail modal active' });
  await sleep(200);
  await cdp.screenshot(path.join(SCREENSHOT_DIR, 'poteto-extensions-detail.png'));
  await cdp.pressKey('Escape');
  await sleep(180);
  const detailAfterEsc = await cdp.evaluate(`document.getElementById('extension-detail-modal')?.classList.contains('active') || false`);
  assert(!detailAfterEsc, '#extension-detail-modal 按 Escape 未关闭');
}

async function main() {
  const sandboxDir = path.join(REPO_ROOT, 'tmp', 'ui-interactive-e2e', `${process.pid}-sandbox`);
  const userDataDir = path.join(REPO_ROOT, 'tmp', 'ui-interactive-e2e', `${process.pid}-profile`);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const mockUpstream = await startMockUpstream();
  const sandbox = await startLiveSandbox(sandboxDir);
  let cdp = null;
  let passed = 0;

  const run = async (name, fn) => {
    const t0 = Date.now();
    const res = await fn();
    passed++;
    console.log(`PASS [${name}] (${Date.now() - t0}ms)`);
    return res;
  };

  try {
    console.log(`[e2e-interactive] ui=${sandbox.url} sidecarApiPort=${sandbox.apiPort} mockUpstream=${mockUpstream.port}`);
    cdp = await launchCdpSession({ url: sandbox.url, userDataDir, width: 1600, height: 960 });
    await waitUiReady(cdp);

    const savedProv = await run('1. 供应商 CRUD + 真拉取 + 当帧 .ab-spinner + 落盘 + reload 存活', () =>
      testProviderCrudReloadAndSpinner(cdp, mockUpstream.port, sandbox.configDir));
    await run('2. 解锁限制弹窗与启停开关真实落盘', () =>
      testUnlockAndTogglePersistence(cdp, savedProv, sandbox.configDir));
    await run('3. UI 新建供应商 -> 真 Sidecar 本地网关流式穿透闭环', () =>
      testUiToSidecarLiveRouting(cdp, savedProv, sandbox.apiPort, mockUpstream));
    await run('4. 模型映射行内改名落盘 + 复选高亮联动', () =>
      testModelMapInlineEditAndSelection(cdp, sandbox.configDir));
    await run('5. 平台切换接管/还原对称闭环 + 扩展中心弹窗交互', () =>
      testPlatformSwitchRestoreAndExtensions(cdp, sandbox.configDir));

    await run('6. 终局零 Runtime 异常 / 零 console.error / 零未知 invoke / 零残留弹窗', async () => {
      const unhandled = sandbox.getLogs().split(/\r?\n/).filter((l) => l.includes('unhandled invoke'));
      assert(unhandled.length === 0, `存在未处理沙箱 invoke: ${unhandled.join(' | ')}`);
      assert(cdp.getExceptions().length === 0, `Runtime 未捕获异常: ${JSON.stringify(cdp.getExceptions())}`);
      assert(cdp.getConsoleErrors().length === 0, `控制台 console.error: ${JSON.stringify(cdp.getConsoleErrors())}`);
      const alertActive = await cdp.evaluate(`document.getElementById('custom-alert-modal')?.classList.contains('active') || false`);
      assert(!alertActive, '结束时存在激活中的 #custom-alert-modal');
    });

    console.log(`\n[e2e-interactive] SUMMARY: ${passed} interactive closed-loop checks passed, consoleErrors=0, exceptions=0`);
  } finally {
    if (cdp) await cdp.close();
    await sandbox.stop();
    await mockUpstream.close();
    try { fs.rmSync(path.join(REPO_ROOT, 'tmp', 'ui-interactive-e2e'), { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error('FAIL [e2e-interactive]:', err?.stack || err);
  process.exit(1);
});
