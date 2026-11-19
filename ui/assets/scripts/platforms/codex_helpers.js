// platforms/codex_helpers.js — split from 55-platforms.js
globalThis.codexTokenVisible = false;
globalThis.codexTokenTimer = null;
globalThis.codexConfigSearch = '';
globalThis.codexConfigEditorMode = 'create';
globalThis.codexConfigModelFetchSeq = 0;
globalThis.codexAgentsState = [];
function codexDesktopAutomationSupported() {
  const ua = `${navigator.userAgent || ''} ${navigator.platform || ''}`;
  return /\bWindows\b|Win32|Win64/i.test(ua);
}

function codexDesktopUnsupportedMessage() {
  return '自动重启与模型注入仅支持 Windows，请手动重启 Codex。';
}

function codexTargetBaseUrl(provider) {
  const endpoint = platformJoinUrl(provider && provider.apiHost, provider && provider.apiPath);
  if (!endpoint) return '';
  // Codex 会自行拼接 "/responses"，base 必须是 API 根路径。
  // 归一规则必须与后端 codex_direct_base_url() 完全一致，
  // 否则「显示的地址」与「写进 config.toml 的地址」会对不上，连带 codexProviderIsCurrent 误判。
  const base = platformStripSuffix(endpoint, ['/chat/completions', '/responses']);
  return platformUrlHasPath(base) ? base : `${base}/v1`;
}

/** URL 是否带非空路径段（platformJoinUrl 已保证有 scheme 且去掉了尾斜杠）。 */
function codexWireApiOf(provider) {
  const explicit = String(provider?.wireApi || '').trim().toLowerCase();
  if (explicit === 'chat' || explicit === 'responses') return explicit;
  const path = String(provider?.apiPath || '').trim().toLowerCase().replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  return '';
}

/**
 * 推断 Codex 配置的上游协议 —— 只决定「本地网关 → 供应商」用哪个端点，
 * 以及 sidecar 是否做 Responses→Chat 转换，**不写进 config.toml**。
 *
 * config.toml 里的 wire_api 恒为 "responses"：openai/codex 已删除 WireApi::Chat，
 * 写 "chat" 会让 Codex 反序列化配置失败、启动即崩（discussions/7782）。
 * 因此只支持 Chat Completions 的供应商，唯一出路就是开启路由模式让本地网关转协议 ——
 * 而转不转，正由这里推断出的值决定。
 *
 * 来源供应商优先：它的 apiPath 是探测出来的客观端点，比配置里存的旧值可信。
 */
function codexInferWireApi(source, existing) {
  return codexWireApiOf(source) || codexWireApiOf(existing) || 'responses';
}

function codexWireApiLabel(wireApi) {
  return wireApi === 'chat' ? 'Chat Completions' : 'Responses';
}

/** 把「自动识别」当前会推断出的协议写进选项文案，让推断结果对用户可见、可复核。 */
function renderCodexConfigRows(config) {
  if (!config) return '';
  const tokenText = config.hasBearerToken ? '已配置' : '未配置';
  const rows = [
    ['Codex model', config.model],
    ['Codex provider', config.modelProviderId],
    ['base_url', config.baseUrl],
    ['wire_api', config.wireApi],
    ['provider token', tokenText],
  ].filter(([, value]) => value != null && value !== '');

  return rows.map(([label, value]) => `
    <div class="platform-status-item">
      <span>${platformEsc(label)}</span>
      <strong title="${platformEsc(value)}">${platformEsc(value)}</strong>
    </div>
  `).join('');
}

function codexStatusMeta(info) {
  if (info && info.codexConfig && info.codexConfig.isOfficial) {
    return { label: 'OpenAI 官方', tone: 'ok' };
  }
  if (info && info.managedByAnyBridge) {
    return { label: 'AnyBridge 第三方', tone: 'info' };
  }
  if (info && info.currentProviderId) {
    return { label: '外部第三方', tone: 'warn' };
  }
  return { label: '未配置', tone: 'warn' };
}

function codexField(label, value, extra = '') {
  const safe = platformShort(value);
  return `
    <div class="codex-field">
      <span>${platformEsc(label)}</span>
      <strong title="${platformEsc(safe)}">${platformEsc(safe)}</strong>
      ${extra}
    </div>
  `;
}

function renderCodexPageStatus(info) {
  const pill = document.getElementById('platform-codex-state-pill');
  const currentLabel = document.getElementById('codex-current-label');

  const meta = codexStatusMeta(info);

  if (pill) {
    pill.textContent = meta.label;
    pill.className = `codex-state-pill ${meta.tone}`;
  }
  if (currentLabel) currentLabel.textContent = meta.label;
  bindRevealPathLabel('codex-config-path-label', info.configPath || platformDef('codex').configHint);
  renderHeroVersion('codex', 'codex-platform-version');
  renderCodexConfigList(info);
  renderPlatformNativeRetry();
}

function toggleCodexToken(event) {
  if (event) event.preventDefault();
  codexTokenVisible = !codexTokenVisible;
  if (codexTokenTimer) {
    clearTimeout(codexTokenTimer);
    codexTokenTimer = null;
  }
  if (codexTokenVisible) {
    codexTokenTimer = setTimeout(() => {
      codexTokenVisible = false;
      renderPlatformDetailStatuses();
    }, 15000);
  }
  renderPlatformDetailStatuses();
}

function renderCodexTargetSummary(provider, message = '') {
  const el = document.getElementById('platform-codex-target-summary');
  if (!el) return;
  if (!provider) {
    el.innerHTML = `<div class="codex-target-empty">${platformEsc(message || '请选择配置')}</div>`;
    return;
  }

  const info = platformInfoOf('codex') || {};
  const current = info.currentProviderName || info.currentProviderId || '当前配置';
  const model = provider.defaultModel || '默认模型未设置';
  const baseUrl = codexTargetBaseUrl(provider);

  el.innerHTML = `
    <div class="codex-target-route">
      <span>${platformEsc(current)}</span>
      <i></i>
      <strong>${platformEsc(provider.name || provider.id)}</strong>
    </div>
    <div class="codex-target-grid">
      ${codexField('目标模型', model)}
      ${codexField('写入地址', baseUrl)}
      ${codexField('写入 provider', 'byok')}
      ${codexField('写入协议', 'responses')}
    </div>
    <div class="codex-protocol-note ok">
      可以应用：将按 Codex Responses 配置写入。
    </div>
  `;
}

function codexProviderIsCurrent(provider, info) {
  const config = (info && info.codexConfig) || {};
  if (!provider || !config || config.isOfficial) return false;
  if (info && info.currentProviderId && info.currentProviderId === provider.id) return true;
  const targetBase = codexTargetBaseUrl(provider).replace(/\/+$/, '').toLowerCase();
  const currentBase = String(config.baseUrl || '').replace(/\/+$/, '').toLowerCase();
  const sameBase = targetBase && currentBase && targetBase === currentBase;
  const sameModel = !config.model || !provider.defaultModel || config.model === provider.defaultModel;
  const sameName = config.providerName && provider.name && config.providerName === provider.name;
  return (sameBase && sameModel) || (sameName && sameModel);
}

function codexConfigMetaLine(parts) {
  return parts.filter(Boolean).map(part => `<span>${platformEsc(part)}</span>`).join('<i></i>');
}

function codexConfigBadge(label, tone) {
  return `<span class="codex-config-badge ${platformEsc(tone || 'third')}">${platformEsc(label)}</span>`;
}

function codexConfigProviderById(id) {
  return (providerStore.codexConfigs || []).find(p => p && p.id === id) || null;
}

/** preserveOfficialAuth 优先；与后端 codex_needs_cdp_injection 一致。 */
function codexProviderPreservesOfficialAuth(provider) {
  return !!(provider && provider.preserveOfficialAuth);
}

/** injectModels 默认 true；preserveOfficialAuth=true 时强制不注入。 */
function codexProviderNeedsInject(provider) {
  if (!provider) return false;
  if (codexProviderPreservesOfficialAuth(provider)) return false;
  return provider.injectModels !== false;
}

/** 表单互斥：preserveOfficialAuth 与 injectModels 不能同时为 true。 */
function codexConfigAuthInjectInputs() {
  return {
    inject: document.getElementById('codex-config-inject-models'),
    preserve: document.getElementById('codex-config-preserve-official-auth'),
  };
}

function syncCodexConfigAuthInjectMutualExclusion(source) {
  const { inject, preserve } = codexConfigAuthInjectInputs();
  if (!inject || !preserve) return;
  if (source === 'preserve' && preserve.checked) {
    inject.checked = false;
  } else if (source === 'inject' && inject.checked) {
    preserve.checked = false;
  } else if (source !== 'inject' && source !== 'preserve' && preserve.checked) {
    // 打开编辑器或保存前：preserve 优先
    inject.checked = false;
  }
  syncCodexRawConfigFromFields();
}

function onCodexConfigInjectModelsChange() {
  syncCodexConfigAuthInjectMutualExclusion('inject');
}

function onCodexConfigPreserveOfficialAuthChange() {
  syncCodexConfigAuthInjectMutualExclusion('preserve');
}

function codexConfigSourceProviders() {
  return (providerStore.providers || []).filter(p => {
    if (!p || p.enabled === false) return false;
    const fmt = String(p.apiFormat || p.api_format || '').trim().toLowerCase();
    if (fmt) return fmt === 'openai';
    const endpoint = platformJoinUrl(p.apiHost, p.apiPath).toLowerCase();
    return !endpoint.includes('/messages') && !endpoint.includes('anthropic');
  });
}

function applyCodexConfigSource(providerId) {
  let source = (providerStore.providers || []).find(p => p && (p.id === providerId || p.providerId === providerId));
  if (!source && Array.isArray(codexProviderModels)) {
    const pm = codexProviderModels.find(p => p && (p.providerId === providerId || p.id === providerId));
    if (pm) {
      source = {
        id: pm.providerId || pm.id,
        name: pm.providerName || pm.name,
        apiHost: pm.apiHost,
        apiPath: pm.apiPath || '/v1',
        apiKey: pm.apiKey || '',
        models: (pm.models || []).map(m => typeof m === 'string' ? m : m.id),
      };
    }
  }
  if (!source) return;
  codexConfigSetInputValue('codex-config-source-id', source.id);
  const nameInput = document.getElementById('codex-config-name');
  if (codexConfigEditorMode === 'create' || !nameInput?.value.trim()) {
    codexConfigSetInputValue('codex-config-name', source.name || '');
  }
  codexConfigSetInputValue('codex-config-base-url', codexConfigDisplayBaseUrl(source));
  codexConfigSetInputValue('codex-config-api-key', source.apiKey || '');
  renderReasoningConfig(source.codexChatReasoning);
  refreshCodexWireApiAutoLabel();
  // 合并 catalog 和 provider models 到统一列表
  const catalog = source.modelCatalog || [];
  const providerModels = codexConfigModelList(source);
  const merged = mergeCatalogAndModels(catalog, providerModels);
  const defaultModel = source.defaultModel || (merged[0]?.model || '');
  renderCodexModelManager(merged, defaultModel, merged.length ? `已带入 ${merged.length} 个模型` : '已带入来源信息，可拉取模型列表。');
}

function selectCodexConfigSource(providerId) {
  const picked = renderCodexConfigSourceList(providerId);
  if (picked) applyCodexConfigSource(picked);
}

function onCodexConfigSourceChange() {
  const select = document.getElementById('codex-config-source-select');
  selectCodexConfigSource(select?.value || '');
}

function codexConfigModelList(provider) {
  const list = Array.isArray(provider?.models) ? provider.models : [];
  const models = list.map(m => sanitizePlatformModelName(m)).filter(Boolean);
  const fallback = sanitizePlatformModelName(provider?.defaultModel || '');
  if (fallback && !models.includes(fallback)) models.unshift(fallback);
  return [...new Set(models)];
}

function codexConfigParseModels(value, defaultModel) {
  const parts = String(value || '')
    .split(/[\n,，]/)
    .map(x => sanitizePlatformModelName(x))
    .filter(Boolean);
  const first = sanitizePlatformModelName(defaultModel);
  const models = first ? [first, ...parts] : parts;
  return [...new Set(models)];
}

function codexConfigNormalizeModels(models, defaultModel = '') {
  const list = (Array.isArray(models) ? models : String(models || '').split(/[\n,，]/))
    .map(m => sanitizePlatformModelName(m))
    .filter(Boolean);
  const first = sanitizePlatformModelName(defaultModel);
  return [...new Set(first ? [first, ...list] : list)];
}

// ── 统一模型管理 ──
// 数据结构: { model, displayName, contextWindow, inCatalog, isDefault }

function mergeCatalogAndModels(catalog, models) {
  const result = [];
  const seen = new Set();
  // 先放 catalog 里的（已勾选）
  for (const entry of (catalog || [])) {
    const model = String(entry?.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push({
      model,
      displayName: entry?.displayName || '',
      contextWindow: entry?.contextWindow || '',
      inCatalog: true,
      isDefault: false,
    });
  }
  // 再放 provider models 里不在 catalog 的（默认勾选）
  for (const model of (models || [])) {
    const m = String(model || '').trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    result.push({ model: m, displayName: '', contextWindow: '', inCatalog: true, isDefault: false });
  }
  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  return sortFn(result, 'codex');
}

function codexConfigSetModelStatus(text, tone = '') {
  const el = document.getElementById('codex-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone || '';
}

function codexConfigSetFetchLoading(loading) {
  setConfigFetchButtonLoading('codex-config-fetch-models-btn', loading);
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.codexDesktopAutomationSupported = codexDesktopAutomationSupported;
  g.codexDesktopUnsupportedMessage = codexDesktopUnsupportedMessage;
  g.codexTargetBaseUrl = codexTargetBaseUrl;
  g.codexWireApiOf = codexWireApiOf;
  g.codexInferWireApi = codexInferWireApi;
  g.codexWireApiLabel = codexWireApiLabel;
  g.renderCodexConfigRows = renderCodexConfigRows;
  g.codexStatusMeta = codexStatusMeta;
  g.codexField = codexField;
  g.renderCodexPageStatus = renderCodexPageStatus;
  g.toggleCodexToken = toggleCodexToken;
  g.renderCodexTargetSummary = renderCodexTargetSummary;
  g.codexProviderIsCurrent = codexProviderIsCurrent;
  g.codexConfigMetaLine = codexConfigMetaLine;
  g.codexConfigBadge = codexConfigBadge;
  g.codexConfigProviderById = codexConfigProviderById;
  g.codexProviderPreservesOfficialAuth = codexProviderPreservesOfficialAuth;
  g.codexProviderNeedsInject = codexProviderNeedsInject;
  g.codexConfigAuthInjectInputs = codexConfigAuthInjectInputs;
  g.syncCodexConfigAuthInjectMutualExclusion = syncCodexConfigAuthInjectMutualExclusion;
  g.onCodexConfigInjectModelsChange = onCodexConfigInjectModelsChange;
  g.onCodexConfigPreserveOfficialAuthChange = onCodexConfigPreserveOfficialAuthChange;
  g.codexConfigSourceProviders = codexConfigSourceProviders;
  g.applyCodexConfigSource = applyCodexConfigSource;
  g.selectCodexConfigSource = selectCodexConfigSource;
  g.onCodexConfigSourceChange = onCodexConfigSourceChange;
  g.codexConfigModelList = codexConfigModelList;
  g.codexConfigParseModels = codexConfigParseModels;
  g.codexConfigNormalizeModels = codexConfigNormalizeModels;
  g.mergeCatalogAndModels = mergeCatalogAndModels;
  g.codexConfigSetModelStatus = codexConfigSetModelStatus;
  g.codexConfigSetFetchLoading = codexConfigSetFetchLoading;
})(globalThis);
