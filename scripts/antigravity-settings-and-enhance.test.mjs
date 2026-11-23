// 回归测试：
// 1. Antigravity 设置弹窗（antigravitySettingsModal）读写持久化与新增模型继承
// 2. Antigravity 增强插件弹窗（antigravity_enhance.js）快速切换目标时并发防覆盖
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('antigravitySettingsModal 回显并真实持久化 antigravityContextWindow 与 antigravityMockCredits', async () => {
  const modalsSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_modals.js');
  const addSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_add.js');
  const dom = new JSDOM(`
    <div id="antigravitySettingsModal" class="modal-overlay">
      <select id="modal-antigravity-context-window">
        <option value="131072">128K</option>
        <option value="262144">256K</option>
        <option value="524288">512K</option>
        <option value="1048576">1M</option>
      </select>
      <input type="checkbox" id="modal-antigravity-mock-credits" checked>
    </div>
    <button id="antigravity-add-confirm-page"><span class="model-action-label"></span></button>
    <input type="checkbox" class="antigravity-add-model-check" data-model-id="m2" checked>
  `);

  const store = {
    antigravityContextWindow: 524288,
    antigravityMockCredits: false,
    antigravityConfigs: [
      { id: 'ag-1', name: 'm1', defaultModel: 'm1', contextWindow: 262144, enabled: true },
    ],
  };
  let mutateFail = false;
  let mutateCalls = 0;
  const toasts = [];

  const sandbox = {
    globalThis: null,
    document: dom.window.document,
    console,
    t: (k) => k,
    providerStore: store,
    modelMapStore: {},
    _antigravitySelectedSet: new Set(),
    antigravityConfigEditorMode: 'edit',
    antigravityProviderModels: [{ providerId: 'p1', providerName: 'P1', models: [{ id: 'm2' }] }],
    antigravityAddSelectedProvider: 'p1',
    antigravityRenderTableRows: () => {},
    antigravityUpdateBulkActionButtons: () => {},
    syncAntigravityConfigUiAfterStoreChange: async () => {},
    navigateTo: () => {},
    antigravityRefreshConsole: () => {},
    loadingHtml: (s) => s,
    showCustomAlert: () => {},
    showBottomToast: (msg, type) => toasts.push({ msg, type }),
    mutateProviderStore: async (fn) => {
      mutateCalls += 1;
      if (mutateFail) return false;
      const res = await fn(store);
      return res !== false;
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(modalsSrc, sandbox);
  vm.runInContext(addSrc, sandbox);

  sandbox.openAntigravitySettingsModal();
  assert.equal(
    dom.window.document.getElementById('modal-antigravity-context-window').value,
    '524288',
    '打开设置弹窗必须回显已保存的上下文阈值',
  );
  assert.equal(
    dom.window.document.getElementById('modal-antigravity-mock-credits').checked,
    false,
    '打开设置弹窗必须回显已关闭的配额伪装状态',
  );

  // 保存失败时不得关弹窗也不得弹成功 Toast
  mutateFail = true;
  dom.window.document.getElementById('modal-antigravity-context-window').value = '1048576';
  dom.window.document.getElementById('modal-antigravity-mock-credits').checked = true;
  await sandbox.saveAntigravitySettingsModal();
  assert.equal(mutateCalls, 1);
  assert.ok(dom.window.document.getElementById('antigravitySettingsModal').classList.contains('active'));
  assert.equal(toasts.length, 0);

  // 保存成功必须持久化顶层字段及已有模型，并同步关闭弹窗
  mutateFail = false;
  await sandbox.saveAntigravitySettingsModal();
  assert.equal(store.antigravityContextWindow, 1048576);
  assert.equal(store.antigravityMockCredits, true);
  assert.equal(store.antigravityConfigs[0].contextWindow, 1048576);
  assert.equal(dom.window.document.getElementById('antigravitySettingsModal').classList.contains('active'), false);
  assert.equal(toasts.length, 1);

  // 新增模型必须继承全局设置的 contextWindow
  await sandbox.confirmAddAntigravityModelsPage();
  const added = store.antigravityConfigs.find((c) => c.defaultModel === 'm2');
  assert.equal(added?.contextWindow, 1048576, '新增模型应继承全局上下文压缩阈值');
});

test('antigravity_enhance 双端独立弹窗、原项目命名与并发防覆盖', async () => {
  const partialHtml = readRepoFile('ui-src/partials/pages/platform-antigravity.html');
  assert.equal(partialHtml.includes('antigravity-platform-subtitle'), false, 'Hero 标题下不应保留已移除的副标题');
  assert.equal(partialHtml.includes('antigravityEnhanceTargetSwitch'), false, '增强插件弹窗不应合并目标切换器');
  assert.equal(partialHtml.includes('switchAntigravityEnhanceTarget'), false, '不应保留跨应用切换动作');
  assert.ok(partialHtml.includes('id="antigravityEnhanceModal"'), '应存在 Antigravity 独立增强弹窗');
  assert.ok(partialHtml.includes('id="antigravityIdeEnhanceModal"'), '应存在 Antigravity IDE 独立增强弹窗');

  const enhanceSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_enhance.js');
  const zhSrc = readRepoFile('ui/assets/i18n/zh-CN.js');
  const dom = new JSDOM(`<!doctype html><html><body>
    ${partialHtml}
    <button id="antigravityEnhanceBtn"><span id="antigravityEnhanceCount"></span></button>
  </body></html>`);

  let enhanceStatusCalls = 0;
  let desktopLocStatusCalls = 0;
  let slowResolve = null;
  const sandbox = {
    globalThis: null,
    document: dom.window.document,
    window: dom.window,
    console,
    t: null,
    getAntigravityTarget: () => 'antigravity',
    loadingHtml: (s) => s,
    setLoading: () => {},
    clearLoading: () => {},
    invoke: (cmd) => {
      if (cmd === 'get_antigravity_enhance_status') {
        enhanceStatusCalls += 1;
        if (enhanceStatusCalls === 1) {
          return new Promise((resolve) => {
            slowResolve = () => resolve([{
              id: 'antigravity-context-viewer',
              name: 'antigravity-context-viewer',
              repo: 'elviscjn-cjn/antigravity-context-viewer',
              installed: true,
              version: '0.8.9',
              hostInstalled: true,
              hostVersion: '2.34.0',
              compatible: true,
            }]);
          });
        }
        return Promise.resolve([{
          id: 'antigravity-context-viewer',
          name: 'antigravity-context-viewer',
          repo: 'elviscjn-cjn/antigravity-context-viewer',
          installed: true,
          version: '0.8.10',
          hostInstalled: true,
          hostVersion: '2.34.0',
          compatible: true,
        }]);
      }
      if (cmd === 'get_antigravity_localization_status') {
        desktopLocStatusCalls += 1;
        return Promise.resolve({ target: 'antigravity', installed: true, localized: false });
      }
      if (cmd === 'get_app_localization_status') {
        return Promise.resolve({
          platform: 'antigravity-ide',
          installed: true,
          localized: true,
          currentVersion: 'fresh-ide',
          langPackInstalled: true,
          hasUpdate: false,
        });
      }
      if (cmd === 'get_antigravity_cdp_status') {
        return Promise.resolve({ available: true, port: 9333, targets: 1, injected: 1 });
      }
      return Promise.resolve(null);
    },
  };
  sandbox.window = dom.window;
  const zhFn = new Function('window', zhSrc);
  zhFn(sandbox.window);
  const zhDict = sandbox.window.ByokI18nCatalog?.['zh-CN']?.translations || {};
  sandbox.t = (k) => zhDict[k] ?? k;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(enhanceSrc, sandbox);

  // 1. Antigravity 仅展示内置汉化的 antigravity-context-viewer 单卡，且同应用慢返回不得覆盖后续刷新
  const pSlowDesktop = sandbox.refreshAntigravityEnhance('antigravity');
  await new Promise((r) => setTimeout(r, 10));
  await sandbox.refreshAntigravityEnhance('antigravity');
  assert.ok(slowResolve, '应拦截到首轮挂起的桌面端插件状态探测');
  slowResolve();
  await pSlowDesktop;
  await new Promise((r) => setTimeout(r, 10));

  const desktopList = dom.window.document.getElementById('antigravityEnhanceList');
  const hubModalBox = dom.window.document.querySelector('#antigravityEnhanceModal .antigravity-enhance-modal');
  const desktopHtml = desktopList.innerHTML;
  assert.equal(desktopLocStatusCalls, 0, 'Antigravity 桌面端不再查询独立汉化状态');
  assert.ok(desktopList.classList.contains('is-single'), '桌面端单卡列表应启用 is-single 布局');
  assert.ok(hubModalBox.classList.contains('is-single'), '桌面端弹窗容器应启用 is-single 窄宽');
  assert.ok(desktopHtml.includes('v0.8.10'), '应保留最新桌面端插件版本');
  assert.equal(desktopHtml.includes('v0.8.9'), false, '慢返回不得覆盖最新桌面端视图');
  assert.ok(desktopHtml.includes('antigravity-context-viewer'), '上下文插件应显示原始项目名');
  assert.ok(desktopHtml.includes('内置汉化'), 'antigravity-context-viewer 卡片应标明内置汉化能力');
  assert.equal(desktopHtml.includes('Antigravity-Chinese-Localization'), false, 'Antigravity 弹窗不应再出现独立汉化卡片');
  assert.equal(desktopHtml.includes('上下文与多账号看板'), false, '不得回退为自定义功能名称');

  // 2. 独立打开 Antigravity IDE 增强弹窗，完全隔离宿主视图与日志
  await sandbox.openAntigravityIdeEnhanceModal();
  const ideModal = dom.window.document.getElementById('antigravityIdeEnhanceModal');
  const hubModal = dom.window.document.getElementById('antigravityEnhanceModal');
  const ideList = dom.window.document.getElementById('antigravityIdeEnhanceList');
  const ideModalBox = ideModal.querySelector('.antigravity-enhance-modal');
  const ideHtml = ideList.innerHTML;
  assert.ok(ideModal.classList.contains('active'), 'IDE 弹窗应处于激活状态');
  assert.equal(hubModal.classList.contains('active'), false, '打开 IDE 弹窗时桌面端弹窗不得同时打开');
  assert.equal(ideList.classList.contains('is-single'), false, 'IDE 弹窗双卡不应启用 is-single');
  assert.equal(ideModalBox.classList.contains('is-single'), false, 'IDE 弹窗容器不应启用 is-single');
  assert.ok(ideHtml.includes('fresh-ide'), 'IDE 弹窗应展示 IDE 专属汉化状态');
  assert.ok(ideHtml.includes('Antigravity-Chinese-Localization'), 'IDE 汉化卡片应显示原始项目名');
  assert.equal(ideHtml.includes('antigravity-context-viewer'), false, 'IDE 弹窗不得混入仅桌面端插件');
});

