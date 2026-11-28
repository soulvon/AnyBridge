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

test('antigravity_enhance 双端独立弹窗、原项目命名、四卡分级冲突提醒与并发防覆盖', async () => {
  const partialHtml = readRepoFile('ui-src/partials/pages/platform-antigravity.html');
  assert.equal(partialHtml.includes('antigravity-platform-subtitle'), false, 'Hero 标题下不应保留已移除的副标题');
  assert.equal(partialHtml.includes('antigravityEnhanceTargetSwitch'), false, '增强插件弹窗不应合并目标切换器');
  assert.equal(partialHtml.includes('switchAntigravityEnhanceTarget'), false, '不应保留跨应用切换动作');
  assert.ok(partialHtml.includes('id="antigravityEnhanceModal"'), '应存在 Antigravity 独立增强弹窗');
  assert.ok(partialHtml.includes('id="antigravityIdeEnhanceModal"'), '应存在 Antigravity IDE 独立增强弹窗');

  const catalogSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_enhance_catalog.js');
  const renderSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_enhance_render.js');
  const detailSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_enhance_detail.js');
  const enhanceSrc = readRepoFile('ui/assets/scripts/platforms/antigravity_enhance.js');
  const zhSrc = readRepoFile('ui/assets/i18n/zh-CN.js');
  const dom = new JSDOM(`<!doctype html><html><body>
    ${partialHtml}
    <button id="antigravityEnhanceBtn"><span id="antigravityEnhanceCount"></span></button>
  </body></html>`);

  let enhanceStatusCalls = 0;
  let desktopLocStatusCalls = 0;
  const checkedPluginIds = [];
  const confirmCalls = [];
  let slowResolve = null;
  const mkDesktopItems = (viewerVer) => [
    {
      id: 'antigravity-context-viewer',
      name: 'antigravity-context-viewer',
      repo: 'elviscjn-cjn/antigravity-context-viewer',
      installed: true,
      version: viewerVer,
      hostInstalled: true,
      hostVersion: '2.34.0',
      compatible: true,
      conflictsWith: [],
      conflicts: [
        { peerId: 'antigravity-usage-monitor', level: 'overlap', reasonCode: 'topbar_i18n_account', reason: '', active: false },
        { peerId: 'antigravity-codex-theme', level: 'overlap', reasonCode: 'viewer_with_codex_i18n', reason: '', active: true },
        { peerId: 'chuanban-antigravity-theme-patch', level: 'overlap', reasonCode: 'viewer_chuanban_i18n_stats', reason: '', active: false },
      ],
    },
    {
      id: 'antigravity-usage-monitor',
      name: 'antigravity-usage-monitor',
      repo: 'yuhuan-dev/antigravity-usage-monitor',
      installed: false,
      version: null,
      hostInstalled: true,
      hostVersion: '2.34.0',
      compatible: true,
      conflictsWith: [],
      conflicts: [
        { peerId: 'antigravity-context-viewer', level: 'overlap', reasonCode: 'topbar_i18n_account', reason: '', active: true },
        { peerId: 'antigravity-codex-theme', level: 'overlap', reasonCode: 'monitor_theme_coexist', reason: '', active: true },
        { peerId: 'chuanban-antigravity-theme-patch', level: 'overlap', reasonCode: 'monitor_theme_coexist', reason: '', active: false },
      ],
    },
    {
      id: 'antigravity-codex-theme',
      name: 'antigravity-codex-theme',
      repo: 'nkjDSLcvanv/antigravity-codex-theme',
      installed: true,
      version: '1.3.1',
      hostInstalled: true,
      hostVersion: '2.34.0',
      compatible: true,
      conflictsWith: ['chuanban-antigravity-theme-patch'],
      conflicts: [
        { peerId: 'chuanban-antigravity-theme-patch', level: 'exclusive', reasonCode: 'cdp_theme_daemon', reason: '', active: false },
        { peerId: 'antigravity-context-viewer', level: 'overlap', reasonCode: 'codex_skip_i18n_with_viewer', reason: '', active: true },
        { peerId: 'antigravity-usage-monitor', level: 'overlap', reasonCode: 'monitor_theme_coexist', reason: '', active: false },
      ],
    },
    {
      id: 'chuanban-antigravity-theme-patch',
      name: 'chuanban-antigravity-theme-patch',
      repo: 'Anarcadia/chuanban-antigravity-theme-patch',
      installed: false,
      version: '6.0.1',
      hostInstalled: true,
      hostVersion: '2.34.0',
      compatible: true,
      conflictsWith: ['antigravity-codex-theme'],
      conflicts: [
        { peerId: 'antigravity-codex-theme', level: 'exclusive', reasonCode: 'cdp_theme_daemon', reason: '', active: true },
        { peerId: 'antigravity-context-viewer', level: 'overlap', reasonCode: 'viewer_chuanban_i18n_stats', reason: '', active: true },
        { peerId: 'antigravity-usage-monitor', level: 'overlap', reasonCode: 'monitor_theme_coexist', reason: '', active: false },
      ],
    },
  ];
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
    showBottomToast: () => {},
    showCustomConfirm: async (message, title) => {
      confirmCalls.push({ message, title });
      return false;
    },
    invoke: (cmd, args) => {
      if (cmd === 'get_antigravity_enhance_status') {
        enhanceStatusCalls += 1;
        if (enhanceStatusCalls === 1) {
          return new Promise((resolve) => {
            slowResolve = () => resolve(mkDesktopItems('0.8.9'));
          });
        }
        return Promise.resolve(mkDesktopItems('0.8.10'));
      }
      if (cmd === 'check_antigravity_enhance_update') {
        checkedPluginIds.push(args?.id);
        return Promise.resolve({ id: args?.id, latestVersion: '9.9.9', hasUpdate: false });
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
      if (cmd === 'get_enhance_github_detail') {
        if (args?.repo === 'nkjDSLcvanv/antigravity-codex-theme') {
          return Promise.resolve({
            repo: 'nkjDSLcvanv/antigravity-codex-theme',
            htmlUrl: 'https://github.com/nkjDSLcvanv/antigravity-codex-theme',
            defaultBranch: 'main',
            description: 'Codex theme for Antigravity',
            stars: 420,
            license: 'MIT',
            updatedAt: '2026-11-27T10:00:00Z',
            readmeFilename: 'README.md',
            renderedOnline: true,
            readmeHtml: `<article class="markdown-body"><div align="center">
              <div class="markdown-heading"><h1>antigravity-codex-theme</h1><a id="user-content-top" class="anchor" href="#top"><svg><path/></svg></a></div>
              <p>支持 <code>--only</code> 按需安装</p>
              <p><a href="https://github.com/nkjDSLcvanv/antigravity-codex-theme/actions"><img src="https://camo.githubusercontent.com/abc/123" data-canonical-src="https://img.shields.io/static/v1?label=Node.js&message=%3E%3D%2022.13.0" alt="Node.js >= 22.13.0"></a></p>
              <details><summary>promo.mp4</summary><video src="https://private-user-images.githubusercontent.com/1/promo.mp4"></video></details>
              <a href="javascript:alert(1)" onclick="alert(2)">恶意脚本</a><script>alert(3)</script>
              <img src="assets/logo.svg" alt="项目 Logo" width="84">
              <img src="assets/preview.png" alt="预览截图" width="100%" onerror="alert(4)">
              <table><tr><td align="center" width="33.3%"><img src="assets/context.png" alt="实时监控"></td><td align="center" width="33.3%"><img src="assets/analytics.png" alt="用量统计"></td></tr></table>
              <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date">
            </div></article>`,
            readmeMarkdown: '',
          });
        }
        return Promise.resolve({
          repo: args?.repo || 'yuhuan-dev/antigravity-usage-monitor',
          htmlUrl: `https://github.com/${args?.repo || 'yuhuan-dev/antigravity-usage-monitor'}`,
          defaultBranch: 'main',
          description: 'Local usage monitor for Antigravity',
          stars: 318,
          license: 'GPL-3.0',
          updatedAt: '2026-11-26T10:00:00Z',
          readmeFilename: 'README.zh-CN.md',
          renderedOnline: false,
          readmeHtml: null,
          readmeMarkdown: `<div align="center"><h1>Usage Monitor</h1><img src="assets/logo.svg" alt="Logo" width="84" /><img src="assets/ide-preview.png" alt="IDE预览" width="100%" /><p>支持 <code>--only</code> 参数与 <a href="https://github.com/x"><img src="https://img.shields.io/static/v1?label=Node&message=22" alt="Node >= 22.13.0"></a></p></div>\n\n<table><tr><td align="center" width="33.3%"><img src="assets/c1.png" alt="图1"></td><td align="center" width="33.3%"><img src="assets/c2.png" alt="图2"></td><td align="center" width="33.3%"><img src="assets/c3.png" alt="图3"></td></tr></table>\n\n![Node](https://img.shields.io/badge/node-%3E%3D22.0.0%20(22.13%2B%20Full)-brightgreen)\n\n![Star History Chart](https://api.star-history.com/svg?repos=yuhuan-dev/antigravity-usage-monitor&type=Date)\n\nhttps://github.com/user-attachments/assets/e27c7621-b605-4fdf-9bc3-4fc12da85484\n\n![preview](assets/preview.png)\n\n- 支持实时速率与上下文分析\n\n[恶意链接](javascript:alert(1))`,
        });
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
  vm.runInContext(catalogSrc, sandbox);
  vm.runInContext(renderSrc, sandbox);
  vm.runInContext(detailSrc, sandbox);
  vm.runInContext(enhanceSrc, sandbox);

  // 1. Antigravity 展示四张原项目命名卡片，且同应用慢返回不得覆盖后续刷新
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
  assert.equal(desktopList.classList.contains('is-single'), false, '桌面端四卡不得启用 is-single 布局');
  assert.equal(hubModalBox.classList.contains('is-single'), false, '桌面端四卡弹窗容器不得启用 is-single');
  assert.ok(desktopHtml.includes('v0.8.10'), '应保留最新桌面端插件版本');
  assert.equal(desktopHtml.includes('v0.8.9'), false, '慢返回不得覆盖最新桌面端视图');
  assert.ok(desktopHtml.includes('antigravity-context-viewer'), '上下文插件应显示原始项目名');
  assert.ok(desktopHtml.includes('antigravity-usage-monitor'), '用量监控原生插件应显示原始项目名');
  assert.ok(desktopHtml.includes('antigravity-codex-theme'), '应显示 antigravity-codex-theme 原始项目名');
  assert.ok(desktopHtml.includes('chuanban-antigravity-theme-patch'), '应显示船板原始项目名');
  assert.ok(desktopHtml.includes('enhance-conflict-item is-exclusive'), '未装互斥主题卡片应展示硬互斥提醒条');
  assert.ok(desktopHtml.includes('enhance-conflict-item is-overlap is-compact'), '存在功能重叠的未装卡片应展示紧凑重叠提醒条');
  assert.ok(desktopHtml.includes('已安装 antigravity-codex-theme'), '未装互斥主题时应提示切换会先自动卸载已装主题');
  assert.ok(desktopHtml.includes('GitHub 详情'), '卡片应提供站内查看 GitHub 详情入口');
  assert.ok(desktopHtml.includes('内置汉化'), 'antigravity-context-viewer 卡片应标明内置汉化能力');
  assert.equal(desktopHtml.includes('Antigravity-Chinese-Localization'), false, 'Antigravity 弹窗不应再出现独立汉化卡片');
  assert.equal(desktopHtml.includes('上下文与多账号看板'), false, '不得回退为自定义功能名称');

  // 1.5 叠层二级 GitHub 详情弹窗：打开时保持底层列表完整可见，同时校验降级 Markdown 与 GitHub 在线 HTML 清洗
  const hubModalOverlay = dom.window.document.getElementById('antigravityEnhanceModal');
  hubModalOverlay.classList.add('active');
  sandbox.openAntigravityEnhanceDetail('antigravity-usage-monitor');
  await new Promise((r) => setTimeout(r, 15));
  const detailModal = dom.window.document.getElementById('antigravityEnhanceDetailModal');
  const detailDialog = dom.window.document.getElementById('antigravityEnhanceDetailDialog');
  const listView = dom.window.document.getElementById('antigravityEnhanceListView');
  assert.ok(detailModal.classList.contains('active'), '打开详情后应弹出叠层二级详情弹窗');
  assert.ok(hubModalOverlay.classList.contains('active'), '叠层详情弹窗打开时底层插件列表弹窗必须保持可见');
  assert.equal(listView.hidden, false, '叠层详情弹窗不得隐藏底层插件列表');
  assert.ok(detailDialog.innerHTML.includes('318'), '详情弹窗应展示 GitHub Star 数');
  assert.ok(detailDialog.innerHTML.includes('GPL-3.0'), '详情弹窗应展示开源协议');
  assert.ok(
    detailDialog.innerHTML.includes('https://raw.githubusercontent.com/yuhuan-dev/antigravity-usage-monitor/main/assets/preview.png'),
    '相对路径图片应解析为 GitHub Raw 绝对地址',
  );
  const mdIdeImg = detailDialog.querySelector('img[alt="IDE预览"]');
  assert.ok(mdIdeImg, '降级 Markdown 应渲染 HTML img');
  assert.equal(mdIdeImg.getAttribute('width'), null, 'width="100%" 在降级渲染中绝不可误截成 width="100"');
  assert.ok(mdIdeImg.classList.contains('is-full-width'), 'width="100%" 应加满宽类 is-full-width');
  const mdLogoImg = detailDialog.querySelector('img[alt="Logo"]');
  assert.equal(mdLogoImg?.getAttribute('width'), '84', '降级 Markdown 纯数字 width="84" 应保留像素宽度');
  assert.ok(mdLogoImg?.classList.contains('is-inline-logo'), '小 Logo 应标为 is-inline-logo');
  const mdParenBadge = detailDialog.querySelector('img[alt="Node"]');
  assert.ok(mdParenBadge?.getAttribute('src')?.includes('(22.13%2B%20Full)-brightgreen'), 'Markdown 图片 URL 含成对括号时不得在首个 ) 提前截断');
  const mdStarChart = detailDialog.querySelector('img[alt="Star History Chart"]');
  assert.ok(mdStarChart?.classList.contains('enhance-md-shot'), 'Star History 图表应归类为大图 enhance-md-shot 而非 20px 小徽章');
  const mdFixedTable = detailDialog.querySelector('table.enhance-md-table.is-fixed-layout');
  assert.ok(mdFixedTable, '降级 Markdown 里的多列百分比 HTML 表格应保留为等分固定列宽表格');
  const onlineTableCheck = detailDialog.innerHTML.includes('<td>') || Boolean(mdFixedTable);
  assert.ok(onlineTableCheck);
  assert.ok(detailDialog.innerHTML.includes('<code>--only</code>'), '降级 Markdown 必须正确渲染 HTML code 标签');
  assert.equal(detailDialog.textContent.includes('<h1>'), false, '降级 Markdown 不得泄露原始 <h1> 标签文本');
  assert.equal(detailDialog.textContent.includes('<code>'), false, '降级 Markdown 不得泄露原始 <code> 标签文本');
  assert.equal(detailDialog.textContent.includes('>= 22.13.0">'), false, 'img alt 含 >= 时不得截断泄露残余属性文本');
  assert.equal(detailDialog.textContent.includes('ENHANCETOKEN'), false, '降级 Markdown 不得泄露占位符 token');
  assert.ok(detailDialog.innerHTML.includes('enhance-md-attachment-link'), '裸 GitHub 附件链接应渲染为安全附件跳转入口');
  assert.ok(detailDialog.innerHTML.includes('仅侧边栏'), '详情弹窗应展开完整共存建议');
  assert.equal(detailDialog.innerHTML.includes('javascript:alert'), false, 'Markdown 渲染必须过滤危险协议链接');

  // 1.5b GitHub 在线 HTML 渲染模式安全清洗校验（防 XSS + 保留对齐/徽章/视频/相对图）
  sandbox.openAntigravityEnhanceDetail('antigravity-codex-theme');
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(detailDialog.innerHTML.includes('GitHub 在线渲染'), '在线 HTML 模式应标注在线渲染来源');
  assert.ok(detailDialog.innerHTML.includes('<h1 class="enhance-md-h1"'), '在线 HTML 应提取干净标题元素');
  assert.ok(detailDialog.innerHTML.includes('<code>--only</code>'), '在线 HTML 应保留行内代码');
  assert.ok(detailDialog.innerHTML.includes('img.shields.io/static/v1'), '在线 HTML 应保留 canonical 徽章源');
  assert.ok(detailDialog.innerHTML.includes('data-fallback-src="https://camo.githubusercontent.com/abc/123"'), '徽章应保留 camo 作为回退源');
  assert.ok(detailDialog.innerHTML.includes('https://raw.githubusercontent.com/nkjDSLcvanv/antigravity-codex-theme/main/assets/preview.png'), '在线 HTML 相对图应解析为 raw 绝对地址');
  const onlineShotImg = detailDialog.querySelector('img[alt="预览截图"]');
  assert.ok(onlineShotImg, '在线 HTML 应包含预览截图');
  assert.equal(onlineShotImg.getAttribute('width'), null, '在线 HTML width="100%" 不得误设成 width="100" 像素缩略图');
  assert.ok(onlineShotImg.classList.contains('is-full-width'), '在线 HTML width="100%" 应添加 is-full-width 类铺满容器');
  const onlineLogoImg = detailDialog.querySelector('img[alt="项目 Logo"]');
  assert.equal(onlineLogoImg?.getAttribute('width'), '84', '在线 HTML 纯数字 width="84" 应保留像素宽度');
  assert.ok(onlineLogoImg?.classList.contains('is-inline-logo'), '在线 HTML 小图标应标为 is-inline-logo');
  const onlineCell = detailDialog.querySelector('.enhance-md-table td');
  assert.equal(onlineCell?.style?.width, '33.3%', '表格单元格应保留安全的百分比列宽');
  assert.ok(detailDialog.querySelector('table.enhance-md-table.is-fixed-layout'), '多列百分比表格应附加 is-fixed-layout 防止超宽横向溢出');
  const onlineStarChart = detailDialog.querySelector('img[alt="Star History Chart"]');
  assert.ok(onlineStarChart?.classList.contains('enhance-md-shot'), '在线 HTML 的 Star History 图表必须按大图展示');
  assert.equal(onlineStarChart?.classList.contains('enhance-md-badge'), false, 'Star History 图表不得被压缩成 badge');
  assert.ok(detailDialog.innerHTML.includes('<video class="enhance-md-video"'), '在线 HTML 应保留受控 GitHub 演示视频播放器');
  assert.equal(detailDialog.innerHTML.includes('<script'), false, '在线 HTML 清洗器必须剥离 script 标签');
  assert.equal(detailDialog.innerHTML.includes('onerror='), false, '在线 HTML 清洗器必须剥离事件属性');
  assert.equal(detailDialog.innerHTML.includes('onclick='), false, '在线 HTML 清洗器必须剥离 onclick 属性');
  assert.equal(detailDialog.innerHTML.includes('javascript:alert'), false, '在线 HTML 清洗器必须剥离危险链接协议');
  assert.equal(detailDialog.innerHTML.includes('octicon'), false, '在线 HTML 清洗器应移除 GitHub 空锚点图标');

  // 按 Escape 仅关闭叠层详情弹窗，底层插件列表保持打开
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(detailModal.classList.contains('active'), false, '按 Escape 应关闭叠层详情弹窗');
  assert.ok(hubModalOverlay.classList.contains('active'), '关闭叠层详情弹窗不得误关底层插件列表');
  hubModalOverlay.classList.remove('active');

  // 1.6 底部执行日志抽屉默认收起，可手动切换展开
  const logEl = dom.window.document.getElementById('antigravityEnhanceLog');
  assert.equal(logEl.hidden, true, '日志区默认应折叠收起，避免挤占卡片空间');
  sandbox.toggleAntigravityEnhanceLog('antigravity');
  assert.equal(logEl.hidden, false, '点击日志栏后应展开日志内容');
  sandbox.toggleAntigravityEnhanceLog('antigravity');
  assert.equal(logEl.hidden, true, '再次点击应折叠日志内容');

  // 2. 安装前确认弹窗：硬互斥 + 功能重叠同时命中 / 仅功能重叠命中
  await sandbox.installAntigravityEnhance('chuanban-antigravity-theme-patch');
  await sandbox.installAntigravityEnhance('antigravity-usage-monitor');
  assert.equal(confirmCalls.length, 2);
  assert.ok(
    confirmCalls[0].message.includes('antigravity-codex-theme') && confirmCalls[0].message.includes('自动卸载'),
    '安装互斥主题时确认框必须明示先自动卸载已装互斥插件',
  );
  assert.ok(
    confirmCalls[0].message.includes('antigravity-context-viewer') && confirmCalls[0].message.includes('功能重叠提醒'),
    '同时存在功能重叠时确认框也应一并提醒',
  );
  assert.ok(
    confirmCalls[1].message.includes('功能重叠提醒') && confirmCalls[1].message.includes('antigravity-context-viewer'),
    '安装 usage-monitor 时确认框应给出与 context-viewer 的重叠提醒',
  );
  assert.equal(
    confirmCalls[1].message.includes('自动卸载'),
    false,
    '仅功能重叠（非互斥）时确认框不得误报会自动卸载',
  );

  // 3. 全局「检查更新」必须遍历全部 4 个桌面端插件
  await sandbox.checkAllAntigravityEnhanceUpdates(null, 'antigravity');
  assert.deepEqual(
    checkedPluginIds,
    [
      'antigravity-context-viewer',
      'antigravity-usage-monitor',
      'antigravity-codex-theme',
      'chuanban-antigravity-theme-patch',
    ],
    '检查全部更新应覆盖全部四个桌面端增强插件',
  );

  // 4. 独立打开 Antigravity IDE 增强弹窗，完全隔离宿主视图与日志
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
  assert.equal(ideHtml.includes('antigravity-usage-monitor'), false, 'IDE 弹窗不得混入仅桌面端插件');
  assert.equal(ideHtml.includes('antigravity-codex-theme'), false, 'IDE 弹窗不得混入仅桌面端主题');
});

