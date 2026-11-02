import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../ui/assets/scripts/70-healthcheck.js', import.meta.url), 'utf8');

function harness(invoke, tauriEvent = null) {
  const logs = [];
  const alerts = [];
  const progress = { hidden: true, classList: { toggle() {} } };
  const progressText = { textContent: '' };
  const buttons = new Map(['health-install-cert-btn', 'health-reinstall-cert-btn', 'health-generate-cert-btn', 'health-uninstall-cert-btn', 'health-cleanup-legacy-btn'].map(id => [id, { disabled: false, textContent: id, dataset: {}, style: {} }]));
  const summary = { innerHTML: '' };
  const context = vm.createContext({
    window: {},
    document: { getElementById: id => id === 'health-summary' ? summary : id === 'health-install-progress' ? progress : id === 'health-install-progress-text' ? progressText : buttons.get(id) || null },
    invoke,
    tauriEvent,
    addLog: (level, message) => logs.push({ level, message }),
    showCustomAlert: (...args) => alerts.push(args),
    // 加载态助手（真实实现在 ui/assets/scripts/ui/feedback.js，挂 globalThis）：
    // 沙箱注入等价 stub，保证「按钮进入忙碌态」路径可执行
    loadingHtml: (text) => `<span class="ab-loading">${text || '加载中…'}</span>`,
  });
  vm.runInContext(source, context);
  return { window: context.window, logs, alerts, buttons, summary, progress, progressText };
}

for (const [totals, level] of [
  [{ err: 1, warn: 2, ok: 0 }, 'err'],
  [{ err: 0, warn: 2, ok: 1 }, 'warn'],
  [{ err: 0, warn: 0, ok: 3 }, 'ok'],
]) {
  test(`health summary uses ${level}`, async () => {
    const h = harness(async () => ({ totals, ok: totals.err === 0, groups: [] }));
    await h.window.runHealthcheck();
    assert.equal(h.logs.at(-1).level, level);
    assert.match(h.logs.at(-1).message, /环境检测: 完成/);
    assert.ok(h.summary.innerHTML.includes(`status-${level}`));
  });
}

for (const [action, buttonId] of [
  ['installCaFromHealth', 'health-install-cert-btn'],
  ['reinstallCaFromHealth', 'health-reinstall-cert-btn'],
  ['generateCertsFromHealth', 'health-generate-cert-btn'],
  ['uninstallCaFromHealth', 'health-uninstall-cert-btn'],
  ['cleanupLegacyCaFromHealth', 'health-cleanup-legacy-btn'],
]) {
  for (const [reason, error] of [
    ['authorization', 'SecTrustSettingsSetTrustSettings: no user interaction was possible'],
    ['task busy', '另一个证书任务仍在执行，请等待完成后再操作'],
    ['proxy running', '请先停止代理再操作证书，避免运行中的代理继续使用旧证书'],
  ]) {
    test(`${action} preserves ${reason} failure and restores buttons`, async () => {
      const calls = [];
      const h = harness(async command => {
        assert.ok(h.buttons.get(buttonId).disabled);
        calls.push(command);
        throw new Error(error);
      });
      await h.window[action]();
      assert.equal(calls.length, 1);
      assert.equal(h.logs.at(-1).level, 'err');
      assert.ok(h.logs.at(-1).message.includes(error));
      assert.ok([...h.buttons.values()].every(button => !button.disabled));
      const expectsAlert = reason === 'authorization' && ['installCaFromHealth', 'reinstallCaFromHealth'].includes(action);
      assert.equal(h.alerts.length, expectsAlert ? 1 : 0);
      assert.ok(h.alerts.every(alert => !alert.join(' ').includes('UAC')));
    });
  }
}

test('certificate progress is scoped to its request and late events are ignored', async () => {
  let listener;
  let requestArgs;
  let resolveInvoke;
  let markInvokeStarted;
  const invokeStarted = new Promise(resolve => { markInvokeStarted = resolve; });
  const tauriEvent = { listen: async (_name, callback) => { listener = callback; return () => {}; } };
  const h = harness((command, args) => {
    if (command === 'healthcheck_grouped') return Promise.resolve({ totals: { err: 0, warn: 0, ok: 0 }, groups: [], ok: true });
    requestArgs = args;
    markInvokeStarted();
    return new Promise(resolve => { resolveInvoke = () => resolve('done'); });
  }, tauriEvent);
  const action = h.window.installCaFromHealth();
  await invokeStarted;
  assert.ok(listener);
  assert.equal(typeof requestArgs.requestId, 'string');
  const requestId = requestArgs.requestId;
  listener({ payload: { stage: 'start', requestId: 'old-request', operationId: 'old-op', message: '迟到事件', percent: 20, level: 'warn' } });
  assert.notEqual(h.progressText.textContent, '迟到事件');
  listener({ payload: { stage: 'start', requestId, operationId: 'current-op', message: '当前操作', percent: 10, level: 'info' } });
  listener({ payload: { stage: 'install', requestId, operationId: 'current-op', message: '正在安装', percent: 60, level: 'warn' } });
  const operationLogCount = h.logs.filter(log => log.message.includes('current-op')).length;
  listener({ payload: { stage: 'install', requestId, operationId: 'current-op', message: '正在安装', percent: 60, level: 'warn' } });
  assert.equal(h.progressText.textContent, '正在安装');
  assert.equal(h.logs.filter(log => log.message.includes('current-op')).length, operationLogCount);
  assert.ok(operationLogCount > 0);
  resolveInvoke();
  await action;
  listener({ payload: { stage: 'install', requestId, operationId: 'current-op', message: '完成后的迟到事件', percent: 80, level: 'warn' } });
  assert.notEqual(h.progressText.textContent, '完成后的迟到事件');
});

test('reinstall progress does not promise forced CA rotation on every platform', async () => {
  const h = harness(async () => { throw new Error('authorization failed'); });
  await h.window.reinstallCaFromHealth();
  assert.ok(!h.logs.some(log => log.message.includes('强制重生')));
});
