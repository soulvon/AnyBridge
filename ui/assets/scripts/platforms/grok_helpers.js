// platforms/grok_helpers.js — split from 55-platforms.js
function syncGrokRawConfigFromFields() {
  const textarea = document.getElementById('grok-config-raw-toml');
  if (!textarea) return;
  const name = document.getElementById('grok-config-name')?.value.trim() || 'Custom';
  const baseUrl = document.getElementById('grok-config-base-url')?.value.trim() || 'https://api.deepseek.com/v1';
  const apiKey = document.getElementById('grok-config-api-key')?.value.trim() || '';
  const backend = document.getElementById('grok-config-backend')?.value.trim() || 'chat_completions';
  const editId = document.getElementById('grok-config-edit-id')?.value.trim();

  const entries = grokRegisteredEntries();
  const defaultModel = entries.find(e => e.isDefault)?.model || entries[0]?.model || '';
  const key = grok_sanitize_key(editId || name || 'custom');
  const lines = [
    `# ~/.grok/config.toml 自定义模型配置段落预览`,
    `[models]`,
    `default = "${defaultModel ? key : ''}"`,
  ];

  entries.forEach(entry => {
    const isDefault = entry.model === defaultModel;
    const sectionKey = isDefault ? key : `${key}--${grok_sanitize_key(entry.model)}`;
    const sectionName = isDefault ? name : `${name} · ${entry.model}`;
    lines.push(
      ``,
      `[model.${sectionKey}]`,
      `name = "${sectionName}"`,
      `model = "${entry.model}"`,
      `base_url = "${baseUrl}"`,
      `api_key = "${apiKey || 'sk-...'}"`,
      `api_backend = "${backend}"`
    );
    if (entry.contextWindow) lines.push(`context_window = ${entry.contextWindow}`);
    lines.push(`anybridge_managed = true`);
  });

  const subagentEntries = Object.entries(grokSubagentModels || {})
    .filter(([agent, target]) => String(agent).trim() && String(target).trim())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (subagentEntries.length) {
    lines.push(``, `[subagents.models]`);
    subagentEntries.forEach(([agent, target]) => {
      lines.push(`${String(agent).trim()} = "${String(target).trim()}"`);
    });
  }

  textarea.value = lines.join('\n');
}

// ═══════ Grok Build CLI 配置管理器 ═══════

globalThis.grokConfigSearch = '';
globalThis.grokConfigEditorMode = 'create';

function grok_sanitize_key(key) {
  const s = String(key || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'anybridge';
}

/** 配置卡片上的模型摘要：单模型显示模型名，多模型显示「主模型 等 N 个模型」 */
function grokConfigModelLabel(cfg) {
  const primary = cfg?.defaultModel || '默认模型未设置';
  const all = (Array.isArray(cfg?.models) ? cfg.models : []).filter(Boolean);
  const extras = all.filter(id => id !== primary);
  return extras.length ? `${primary} 等 ${extras.length + 1} 个模型` : primary;
}

function grokConfigProviderById(id) {
  return (providerStore.grokConfigs || []).find(p => p && p.id === id) || null;
}

/** 按模型推荐上下文窗口；拿不到推荐值时退回 256000（Grok 省略该字段会按 200000 处理） */
function grokRecommendContextWindow(modelId) {
  const value = Number(cbRecommendContextWindow(modelId));
  return Number.isFinite(value) && value > 0 ? value : 256000;
}

function grokConfigSourceProviders() {
  const providers = (providerStore && Array.isArray(providerStore.providers))
    ? providerStore.providers
    : [];
  return providers.filter(p => p && p.enabled !== false && p.apiFormat === 'openai' && !platformIsLocalProxyConfig(p));
}

function renderGrokPageStatus(info) {
  bindRevealPathLabel('grok-config-path-label', info.configPath || platformDef('grok').configHint);
  renderHeroVersion('grok', 'grok-platform-version');
  renderGrokConfigList(info);
}

function renderGrokConfigSourceList(selectedId = '') {
  const list = document.getElementById('grok-config-source-list');
  const count = document.getElementById('grok-config-source-count');
  if (!list) return null;

  const sources = grokConfigSourceProviders();
  if (count) count.textContent = String(sources.length);
  if (!sources.length) {
    list.innerHTML = '<div class="codex-config-source-empty">暂无可用 OpenAI 供应商</div>';
    return null;
  }

  const activeId = selectedId || sources[0].id;
  list.innerHTML = sources.map(source => `
    <button type="button" class="codex-config-source-item ${source.id === activeId ? 'active' : ''}"
      data-source-id="${platformEsc(source.id)}" data-action="selectGrokConfigSource" data-arg="${platformEsc(source.id)}">
      <div class="codex-config-source-name">${platformEsc(source.name || source.id)}</div>
      <div class="codex-config-source-meta">${platformEsc(source.defaultModel || '默认模型')} · ${platformEsc(source.apiHost || '')}</div>
    </button>
  `).join('');

  return sources.find(s => s.id === activeId) || sources[0] || null;
}

function applyGrokConfigSource(source) {
  if (!source) return;
  codexConfigSetInputValue('grok-config-source-id', source.id);
  // list_provider_models 返回的字段是 providerName（不是 name），直接读 name 永远为空；
  // 与 Codex 一致：仅新建或名称为空时回填，不覆盖编辑中已改过的名称。
  const nameInput = document.getElementById('grok-config-name');
  if (grokConfigEditorMode === 'create' || !nameInput?.value.trim()) {
    codexConfigSetInputValue('grok-config-name', source.providerName || source.name || '');
  }
  codexConfigSetInputValue('grok-config-base-url', openai_base_url_from_source(source));
  codexConfigSetInputValue('grok-config-api-key', source.apiKey || '');
  // 选供应商后：把它的模型池铺进列表，默认模型标默认并注册
  const pool = grokModelIdsOf(source.models || []);
  const entries = pool.map(id => ({
    model: id,
    displayName: '',
    contextWindow: grokRecommendContextWindow(id),
    inCatalog: id === (source.defaultModel || '') || pool.length === 1,
    isDefault: id === (source.defaultModel || '') || pool.length === 1,
  }));
  if (!entries.length && source.defaultModel) {
    entries.push({
      model: source.defaultModel,
      displayName: '',
      contextWindow: grokRecommendContextWindow(source.defaultModel),
      inCatalog: true,
      isDefault: true,
    });
  }
  // 换供应商 = 换模型段 key，旧的子代理覆盖指向的段已不存在，重置避免写出悬空引用
  grokSubagentModels = {};
  grokSubagentCustomTypes = [];
  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  renderGrokModelManager(sortFn(entries, 'grok'), source.defaultModel || '');
  const backendSelect = document.getElementById('grok-config-backend');
  if (backendSelect) backendSelect.value = 'chat_completions';
}

function openai_base_url_from_source(source) {
  let host = String(source.apiHost || '').trim();
  if (!host) return '';
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');
  let path = String(source.apiPath || '/v1').trim();
  let full = `${host}/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return full.replace(/\/chat\/completions$/i, '').replace(/\/responses$/i, '');
}

function grokConfigEndpointParts(baseUrl) {
  if (typeof providerEndpointParts === 'function') {
    return providerEndpointParts(baseUrl, 'openai', '/v1');
  }
  let apiHost = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiHost)) apiHost = `https://${apiHost}`;
  try {
    const url = new URL(apiHost);
    const apiPath = url.pathname && url.pathname !== '/' ? url.pathname : '/v1';
    return { apiHost: url.origin, apiPath };
  } catch {
    return { apiHost, apiPath: '/v1' };
  }
}

function selectGrokConfigSource(providerId) {
  const picked = renderGrokConfigSourceList(providerId);
  if (picked) applyGrokConfigSource(picked);
}

function setGrokConfigBackendRadio(backend) {
  const normalized = backend || 'chat_completions';
  const hidden = document.getElementById('grok-config-backend') || document.getElementById('grok-add-backend');
  if (hidden) hidden.value = normalized;
  document.querySelectorAll('input[name="grok-config-backend-radio"], input[name="grok-add-backend-radio"]').forEach(r => {
    r.checked = r.value === normalized;
  });
  syncGrokRawConfigFromFields();
}

function setGrokAddBackend(backend) {
  setGrokConfigBackendRadio(backend);
}

async function openGrokAddModal() {
  await openGrokConfigEditor();
}

function openGrokConfigAdd() {
  openGrokConfigEditor();
}

async function initGrokConfigEditorPage(providerId = '') {
  grokProviderModels = await loadConfigEditorProviderModels();
  grokAddSearchKw = '';
  const searchInput = document.getElementById('grok-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? grokConfigProviderById(providerId) : null;
  grokConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('grok-config-page-title');
  const subEl = document.getElementById('grok-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · Grok' : '添加配置 · Grok';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 Grok 模型配置。`
      : '从现有供应商创建或自由定制一份 Grok Build CLI 自定义模型配置方案。';
  }

  codexConfigSetInputValue('grok-config-edit-id', provider?.id || '');

  if (provider) {
    const bound = resolveConfigEditorBoundView(provider);
    const liveProvider = bound.hasSource
      ? { ...provider, apiHost: bound.apiHost, apiPath: bound.apiPath, apiKey: bound.apiKey }
      : provider;

    grokAddSelectedProvider = provider.sourceProviderId || null;
    renderGrokAddProviderList();

    codexConfigSetInputValue('grok-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('grok-config-name', provider.name || '');
    const url = liveProvider.apiHost ? (liveProvider.apiHost.replace(/\/+$/, '') + (liveProvider.apiPath || '/v1')) : '';
    codexConfigSetInputValue('grok-config-base-url', url);
    codexConfigSetInputValue('grok-config-api-key', liveProvider.apiKey || '');
    setGrokConfigBackendRadio(provider.apiBackend || 'chat_completions');

    // 回填已注册模型（历史配置只有 defaultModel 时等价于只注册它），
    // 再叠加来源供应商的模型池，未注册的不勾选，方便直接勾上
    const registered = (Array.isArray(provider.models) && provider.models.length)
      ? provider.models.filter(Boolean)
      : [provider.defaultModel].filter(Boolean);
    const pool = grokModelIdsOf(bound.source ? bound.source.models : []);
    const known = new Set(registered);
    const entries = registered.map(id => ({
      model: id,
      displayName: '',
      contextWindow: provider.modelContexts?.[id] || grokRecommendContextWindow(id),
      inCatalog: true,
      isDefault: id === provider.defaultModel,
    }));
    pool.forEach(id => {
      if (known.has(id)) return;
      known.add(id);
      entries.push({ model: id, displayName: '', contextWindow: grokRecommendContextWindow(id), inCatalog: false, isDefault: false });
    });
    const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
    // 子代理覆盖回填（自定义类型 = 不在内置列表里的键）
    grokSubagentModels = { ...(provider.subagentModels || {}) };
    grokSubagentCustomTypes = Object.keys(grokSubagentModels)
      .filter(id => !GROK_SUBAGENT_TYPES.some(t => t.id === id));
    renderGrokModelManager(sortFn(entries, 'grok'), provider.defaultModel || '');
  } else {
    codexConfigSetInputValue('grok-config-source-id', '');
    codexConfigSetInputValue('grok-config-name', '');
    codexConfigSetInputValue('grok-config-base-url', '');
    codexConfigSetInputValue('grok-config-api-key', '');
    setGrokConfigBackendRadio('chat_completions');
    grokSubagentModels = {};
    grokSubagentCustomTypes = [];

    const firstProvider = grokProviderModels[0];
    if (firstProvider) {
      grokAddSelectedProvider = firstProvider.providerId;
      renderGrokAddProviderList();
      applyGrokConfigSource(firstProvider);
    } else {
      grokAddSelectedProvider = null;
      renderGrokAddProviderList();
      renderGrokModelManager([], '');
    }
  }

  const hasRealDiskFile = await loadPlatformRealConfigFile('grok', 'grok-config-raw-toml');
  if (!hasRealDiskFile) {
    syncGrokRawConfigFromFields();
  }

  window.setTimeout(() => {
    document.getElementById('grok-config-name')?.focus();
  }, 50);
}

async function initGrokAddPage() {
  await initGrokConfigEditorPage();
}

function onGrokAddSearch() {
  const input = document.getElementById('grok-add-search');
  grokAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderGrokAddProviderList();
}

function renderGrokAddProviderList() {
  renderConfigAddProviderList({
    listId: 'grok-add-provider-list',
    sortPrefix: 'grok',
    providers: grokProviderModels,
    keyword: grokAddSearchKw,
    selectedProviderId: grokAddSelectedProvider,
    selectAction: 'selectGrokAddProvider',
  });
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.syncGrokRawConfigFromFields = syncGrokRawConfigFromFields;
  g.grok_sanitize_key = grok_sanitize_key;
  g.grokConfigModelLabel = grokConfigModelLabel;
  g.grokConfigProviderById = grokConfigProviderById;
  g.grokRecommendContextWindow = grokRecommendContextWindow;
  g.grokConfigSourceProviders = grokConfigSourceProviders;
  g.renderGrokPageStatus = renderGrokPageStatus;
  g.renderGrokConfigSourceList = renderGrokConfigSourceList;
  g.applyGrokConfigSource = applyGrokConfigSource;
  g.openai_base_url_from_source = openai_base_url_from_source;
  g.grokConfigEndpointParts = grokConfigEndpointParts;
  g.selectGrokConfigSource = selectGrokConfigSource;
  g.setGrokConfigBackendRadio = setGrokConfigBackendRadio;
  g.setGrokAddBackend = setGrokAddBackend;
  g.openGrokAddModal = openGrokAddModal;
  g.openGrokConfigAdd = openGrokConfigAdd;
  g.initGrokConfigEditorPage = initGrokConfigEditorPage;
  g.initGrokAddPage = initGrokAddPage;
  g.onGrokAddSearch = onGrokAddSearch;
  g.renderGrokAddProviderList = renderGrokAddProviderList;
})(globalThis);
