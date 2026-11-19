// platforms/core_helpers.js — 平台公共辅助（模型名清洗、密码显隐、排序与内置代理判断）

function platformJsArg(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function renderCodexConfigSourceList(selectedId = '') {
  const list = document.getElementById('codex-config-source-list');
  const hint = document.getElementById('codex-config-source-hint');
  const count = document.getElementById('codex-config-source-count');
  if (!list) return '';
  const sources = codexConfigSourceProviders();
  if (count) count.textContent = String(sources.length);
  if (!sources.length) {
    list.innerHTML = '<div class="codex-config-source-empty">暂无 OpenAI 兼容供应商</div>';
    if (hint) hint.textContent = '请先在「供应商」页添加 OpenAI 兼容供应商，再回来创建 Codex 配置。';
    codexConfigSetInputValue('codex-config-source-id', '');
    return '';
  }

  const picked = sources.some(p => p.id === selectedId) ? selectedId : sources[0].id;
  list.innerHTML = sources.map(p => {
    const active = p.id === picked;
    const name = p.name || p.id;
    const endpoint = codexConfigDisplayBaseUrl(p) || 'Base URL 未设置';
    return `
      <button type="button" class="codex-config-source-item ${active ? 'active' : ''}" data-source-id="${platformEsc(p.id)}">
        <span class="codex-config-source-copy">
          <strong title="${platformEsc(name)}">${platformEsc(name)}</strong>
          <em title="${platformEsc(endpoint)}">${platformEsc(endpoint)}</em>
        </span>
      </button>`;
  }).join('');
  list.onclick = (event) => {
    const item = event.target.closest('.codex-config-source-item');
    if (!item || !list.contains(item)) return;
    selectCodexConfigSource(item.dataset.sourceId || '');
  };
  if (hint) hint.textContent = '只读取名称、Base URL 和 API Key；模型需要重新拉取或手动填写。';
  codexConfigSetInputValue('codex-config-source-id', picked);
  return picked;
}

function sanitizePlatformModelName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\[\s*$/g, '')
    .trim();
}

function isAnyRouterEndpoint(url = '', name = '') {
  const s = `${url || ''} ${name || ''}`.toLowerCase();
  return s.includes('anyrouter');
}

function isClaudeModel(name = '') {
  return String(name || '').toLowerCase().includes('claude');
}

function ensureOneMContextMarker(model, isAnyRouter = false) {
  const clean = sanitizePlatformModelName(model);
  if (!clean) return '';
  const isClaude = isClaudeModel(clean);
  if (isAnyRouter && isClaude) {
    if (clean.toLowerCase().endsWith('[1m]')) return clean;
    return `${clean}[1m]`;
  }
  if (clean.toLowerCase().endsWith('[1m]')) {
    return clean.slice(0, -4).trim();
  }
  return clean;
}

function stripOneMContextMarker(model) {
  let m = String(model || '').trim();
  if (m.toLowerCase().endsWith('[1m]')) {
    m = m.slice(0, -4).trim();
  }
  return m;
}

globalThis.PLATFORM_EYE_OPEN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
globalThis.PLATFORM_EYE_CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`;

function togglePasswordInputVisibility(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = btnId ? document.getElementById(btnId) : null;
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.innerHTML = PLATFORM_EYE_CLOSE;
  } else {
    input.type = 'password';
    if (btn) btn.innerHTML = PLATFORM_EYE_OPEN;
  }
}

function resetPasswordInputVisibility(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = btnId ? document.getElementById(btnId) : null;
  if (input) input.type = 'password';
  if (btn) btn.innerHTML = PLATFORM_EYE_OPEN;
}

function togglePasswordVisibility(inputId, btnId) {
  togglePasswordInputVisibility(inputId, btnId);
}

function toggleCodexKeyVisibility() {
  togglePasswordInputVisibility('codex-config-api-key', 'codex-config-api-key-toggle');
}

function toggleClaudeDesktopKeyVisibility() {
  togglePasswordInputVisibility('claude-desktop-config-api-key', 'claude-desktop-config-api-key-toggle');
}

function toggleClaudeCodeKeyVisibility() {
  togglePasswordInputVisibility('claude-code-config-api-key', 'claude-code-config-api-key-toggle');
}

function toggleOpenCodeKeyVisibility() {
  togglePasswordInputVisibility('opencode-config-api-key', 'opencode-config-api-key-toggle');
}

function toggleGrokKeyVisibility() {
  togglePasswordInputVisibility('grok-config-api-key', 'grok-config-api-key-toggle');
}

globalThis.cbModels = [];
globalThis.cbAvailableModels = [];
globalThis.cbConfigScope = 'user';
globalThis.cbConfigPath = '~/.codebuddy/models.json';
globalThis.cbProviderModels = [];
globalThis.cbEditingIndex = -1;
globalThis.cbAddSelectedProvider = null; // 当前在「添加」页面选中的供应商
globalThis.cbAddSearchKw = '';
globalThis.grokProviderModels = [];
globalThis.grokAddSelectedProvider = null;
globalThis.grokModelEntriesState = [];
globalThis.grokConfigModelFetchSeq = 0;
globalThis.grokAddSearchKw = '';
globalThis.opencodeProviderModels = [];
globalThis.opencodeAddSelectedProvider = null;
globalThis.opencodeAddSearchKw = '';
globalThis.codexProviderModels = [];
globalThis.codexAddSelectedProvider = null;
globalThis.codexAddSearchKw = '';
globalThis.claudeProviderModels = [];
globalThis.claudeAddSelectedProvider = null;
globalThis.claudeAddSearchKw = '';
globalThis.TENCENT_BUDDY_SYNC_STORAGE_KEY = 'anybridge.tencentBuddyModelSyncEnabled';
globalThis.tencentBuddySyncEnabled = localStorage.getItem(TENCENT_BUDDY_SYNC_STORAGE_KEY) === 'true';
globalThis.PLATFORM_ADD_PROVIDER_SORT_STORAGE_KEY = 'anybridge.platformAddProviderSortMode';
globalThis.PLATFORM_ADD_PROVIDER_SORT_MODES = new Set(['default', 'name-asc', 'name-desc']);
globalThis.PLATFORM_ADD_PROVIDER_SORT_LABELS = {
  default: '默认排序',
  'name-asc': '名称正序',
  'name-desc': '名称反序',
};
globalThis.PLATFORM_ADD_SORT_PREFIXES = ['cb', 'wb', 'zc', 'pi', 'hermes', 'dsh', 'grok', 'opencode', 'codex', 'claude', 'cursor', 'claudeDesktop', 'antigravity'];
globalThis.platformAddProviderSortMode = (() => {
  try {
    return normalizePlatformAddProviderSortMode(localStorage.getItem(PLATFORM_ADD_PROVIDER_SORT_STORAGE_KEY));
  } catch (_) {
    return 'default';
  }
})();
globalThis.cbSelectedModelIds = {
  Cb: new Set(),
  Wb: new Set(),
  Zc: new Set(),
  Pi: new Set(),
  Hermes: new Set(),
  Dsh: new Set(),
};

function normalizePlatformAddProviderSortMode(mode) {
  return PLATFORM_ADD_PROVIDER_SORT_MODES.has(mode) ? mode : 'default';
}

function platformAddProviderSortLabel(mode) {
  return PLATFORM_ADD_PROVIDER_SORT_LABELS[normalizePlatformAddProviderSortMode(mode)]
    || PLATFORM_ADD_PROVIDER_SORT_LABELS.default;
}

function platformAddProviderSortText(p) {
  return String(p?.providerName || p?.providerId || '').trim();
}

function comparePlatformAddProvidersByName(a, b) {
  const primary = platformAddProviderSortText(a).localeCompare(platformAddProviderSortText(b), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
  if (primary !== 0) return primary;
  return String(a?.providerId || '').localeCompare(String(b?.providerId || ''), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function isAnyBridgeLocalProxy(p) {
  if (!p) return false;
  if (p.isLocalProxy === true || p.meta?.localProxy === true) return true;
  const id = String(p.providerId || p.id || p.provider_id || '').toLowerCase();
  if (id === 'anybridge-local-proxy' || id === 'anybridge' || id === 'local-proxy') return true;
  const name = String(p.providerName || p.name || '').trim().toLowerCase();
  if (name === 'anybridge' || name.startsWith('anybridge')) return true;
  return false;
}

function isCpaLocalProxy(p) {
  if (!p) return false;
  if (p.meta?.cpaLocal === true) return true;
  const id = String(p.providerId || p.id || p.provider_id || '').toLowerCase();
  if (id === 'cpa-local' || id === 'cpa' || id.startsWith('p-cpa-local')) return true;
  const name = String(p.providerName || p.name || '').trim().toUpperCase();
  if (name === 'CPA' || name.startsWith('CPA ') || name.startsWith('CPA(') || name.startsWith('CPA（')) return true;
  const host = String(p.apiHost || p.api_host || '').replace(/\/+$/, '').toLowerCase();
  if (host === 'http://127.0.0.1:8317' || (host.includes(':8317') && /cpa/i.test(name))) return true;
  return false;
}

function isOtherBuiltinProxy(p) {
  if (!p) return false;
  if (isAnyBridgeLocalProxy(p) || isCpaLocalProxy(p)) return false;
  // 插件自动登记的本地供应商（plugin-<id>）；isPluginLocalProvider 在 30 的模块作用域里，此处内联等价判断
  const pluginLocalId = String(p.providerId || p.id || p.provider_id || '');
  if (pluginLocalId.startsWith('plugin-')) return true;
  if (p.isBuiltin === true || p.builtin === true || p.meta?.builtin === true || p.meta?.isBuiltin === true) return true;
  if (p.meta?.pluginProxy === true || p.isPluginProxy === true || p.meta?.isProxy === true || p.isProxy === true) return true;
  if (p.meta?.cpaLocal === true || p.meta?.localProxy === true) return true;
  const host = String(p.apiHost || p.api_host || '').toLowerCase();
  if ((host.includes('127.0.0.1') || host.includes('localhost')) && (p.meta?.plugin || p.meta?.extension || p.pluginId)) return true;
  return false;
}

function isBuiltinProxyEntry(p) {
  return isAnyBridgeLocalProxy(p) || isCpaLocalProxy(p) || isOtherBuiltinProxy(p);
}

function builtinProxySortRank(p) {
  if (isAnyBridgeLocalProxy(p)) return 1;
  if (isCpaLocalProxy(p)) return 2;
  if (isOtherBuiltinProxy(p)) return 3;
  return 999;
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.platformJsArg = platformJsArg;
  g.renderCodexConfigSourceList = renderCodexConfigSourceList;
  g.sanitizePlatformModelName = sanitizePlatformModelName;
  g.isAnyRouterEndpoint = isAnyRouterEndpoint;
  g.isClaudeModel = isClaudeModel;
  g.ensureOneMContextMarker = ensureOneMContextMarker;
  g.stripOneMContextMarker = stripOneMContextMarker;
  g.togglePasswordInputVisibility = togglePasswordInputVisibility;
  g.resetPasswordInputVisibility = resetPasswordInputVisibility;
  g.togglePasswordVisibility = togglePasswordVisibility;
  g.toggleCodexKeyVisibility = toggleCodexKeyVisibility;
  g.toggleClaudeDesktopKeyVisibility = toggleClaudeDesktopKeyVisibility;
  g.toggleClaudeCodeKeyVisibility = toggleClaudeCodeKeyVisibility;
  g.toggleOpenCodeKeyVisibility = toggleOpenCodeKeyVisibility;
  g.toggleGrokKeyVisibility = toggleGrokKeyVisibility;
  g.normalizePlatformAddProviderSortMode = normalizePlatformAddProviderSortMode;
  g.platformAddProviderSortLabel = platformAddProviderSortLabel;
  g.platformAddProviderSortText = platformAddProviderSortText;
  g.comparePlatformAddProvidersByName = comparePlatformAddProvidersByName;
  g.isAnyBridgeLocalProxy = isAnyBridgeLocalProxy;
  g.isCpaLocalProxy = isCpaLocalProxy;
  g.isOtherBuiltinProxy = isOtherBuiltinProxy;
  g.isBuiltinProxyEntry = isBuiltinProxyEntry;
  g.builtinProxySortRank = builtinProxySortRank;
})(globalThis);
