// platforms/opencode_config.js — split from 55-platforms.js
function opencodeConfigSourceProviders() {
  return (providerStore.providers || []).filter(p =>
    p &&
    p.enabled !== false &&
    !isLocalProxyProvider(p)
  );
}

function opencodeTargetBaseUrl(provider) {
  const endpoint = platformJoinUrl(provider && provider.apiHost, provider && provider.apiPath);
  if (!endpoint) return '';
  const base = platformStripSuffix(endpoint, ['/chat/completions', '/responses', '/models']);
  return base.toLowerCase().endsWith('/v1') ? base : `${base}/v1`;
}

function opencodeConfigDisplayBaseUrl(provider) {
  if (!provider) return '';
  return opencodeTargetBaseUrl(provider) || platformJoinUrl(provider.apiHost, provider.apiPath);
}

function opencodeCurrentRawSettingsConfig() {
  const raw = document.getElementById('opencode-config-raw-json')?.value || '';
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function opencodeModelMapFromList(models, seedModels = {}) {
  const out = {};
  for (const modelId of codexConfigNormalizeModels(models)) {
    const existing = seedModels && typeof seedModels === 'object' && !Array.isArray(seedModels)
      ? seedModels[modelId]
      : null;
    const meta = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? JSON.parse(JSON.stringify(existing))
      : {};
    if (!meta.name) meta.name = modelId;
    out[modelId] = meta;
  }
  return out;
}

function opencodeBuildSettingsConfig(name, baseUrl, apiKey, models, seed = null) {
  const cleanBaseUrl = opencodeConfigDisplayBaseUrl({
    apiHost: baseUrl,
    apiPath: '',
  }) || String(baseUrl || '').trim();
  const cleanName = String(name || '').trim() || 'AnyBridge';
  const base = seed && typeof seed === 'object' && !Array.isArray(seed)
    ? JSON.parse(JSON.stringify(seed))
    : {};
  if (!base.npm) base.npm = '@ai-sdk/openai-compatible';
  base.name = cleanName;
  if (!base.options || typeof base.options !== 'object' || Array.isArray(base.options)) base.options = {};
  base.options.baseURL = cleanBaseUrl;
  base.options.apiKey = String(apiKey || '').trim();
  if (!('setCacheKey' in base.options)) base.options.setCacheKey = true;
  const seedModels = base.models && typeof base.models === 'object' && !Array.isArray(base.models)
    ? base.models
    : {};
  base.models = opencodeModelMapFromList(models, seedModels);
  return base;
}

function opencodeSettingsFromFields() {
  const name = document.getElementById('opencode-config-name')?.value || '';
  const baseUrl = document.getElementById('opencode-config-base-url')?.value || '';
  const apiKey = document.getElementById('opencode-config-api-key')?.value || '';
  const defaultModel = document.getElementById('opencode-config-model')?.value || '';
  const models = codexConfigParseModels(document.getElementById('opencode-config-models')?.value, defaultModel);
  return opencodeBuildSettingsConfig(name, baseUrl, apiKey, models, opencodeCurrentRawSettingsConfig());
}

function opencodeValidateSettingsConfig(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'OpenCode provider 配置 JSON 顶层必须是对象。';
  }
  if ('options' in settings && (typeof settings.options !== 'object' || settings.options === null || Array.isArray(settings.options))) {
    return 'OpenCode provider 配置 JSON 的 options 字段必须是对象。';
  }
  if ('models' in settings && (typeof settings.models !== 'object' || settings.models === null || Array.isArray(settings.models))) {
    return 'OpenCode provider 配置 JSON 的 models 字段必须是对象。';
  }
  return '';
}

function opencodeNormalizeSettingsConfig(settings, name, baseUrl, apiKey, models) {
  const normalized = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings
    : {};
  if (!normalized.npm) normalized.npm = '@ai-sdk/openai-compatible';
  if (!normalized.name && name) normalized.name = name;
  if (!normalized.options || typeof normalized.options !== 'object' || Array.isArray(normalized.options)) normalized.options = {};
  if (!normalized.options.baseURL && baseUrl) normalized.options.baseURL = baseUrl;
  if (!normalized.options.apiKey && apiKey) normalized.options.apiKey = apiKey;
  if (!('setCacheKey' in normalized.options)) normalized.options.setCacheKey = true;
  if (!normalized.models || typeof normalized.models !== 'object' || Array.isArray(normalized.models)) normalized.models = {};
  for (const modelId of codexConfigNormalizeModels(models)) {
    const meta = normalized.models[modelId];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      normalized.models[modelId] = { name: modelId };
    } else if (!meta.name) {
      meta.name = modelId;
    }
  }
  return normalized;
}

function opencodeConfigObjectFromRawOrFields() {
  const rawConfig = String(document.getElementById('opencode-config-raw-json')?.value || '').trim();
  return rawConfig ? JSON.parse(rawConfig) : opencodeSettingsFromFields();
}

function opencodeBuildSettingsForProvider(provider, models = null) {
  const modelList = models || codexConfigModelList(provider);
  return opencodeNormalizeSettingsConfig(
    opencodeBuildSettingsConfig(
      provider?.name || '',
      opencodeConfigDisplayBaseUrl(provider),
      provider?.apiKey || '',
      modelList,
      provider?.settingsConfig || null
    ),
    provider?.name || '',
    opencodeConfigDisplayBaseUrl(provider),
    provider?.apiKey || '',
    modelList
  );
}

function opencodeSetRawSettings(settings) {
  codexConfigSetInputValue('opencode-config-raw-json', JSON.stringify(settings, null, 2));
}

function opencodeModelKeysFromSettings(settings) {
  return settings && settings.models && typeof settings.models === 'object' && !Array.isArray(settings.models)
    ? Object.keys(settings.models).map(x => String(x || '').trim()).filter(Boolean)
    : [];
}

function opencodeBaseUrlFromOptions(options = {}) {
  return typeof options.baseURL === 'string'
    ? options.baseURL
    : typeof options.baseUrl === 'string'
      ? options.baseUrl
      : '';
}

function opencodeApiKeyFromOptions(options = {}) {
  return typeof options.apiKey === 'string' ? options.apiKey : '';
}

function opencodeConfigNameFromSettings(settings) {
  return typeof settings?.name === 'string' ? settings.name : '';
}

function opencodeRawConfigTextFromSettings(settings) {
  return JSON.stringify(settings, null, 2);
}

function opencodeRawConfigTextFromFields() {
  return opencodeRawConfigTextFromSettings(opencodeSettingsFromFields());
}

function syncOpenCodeRawConfigFromFields() {
  if (opencodeRawConfigSyncing) return;
  const raw = document.getElementById('opencode-config-raw-json');
  if (!raw) return;
  opencodeRawConfigSyncing = true;
  raw.value = opencodeRawConfigTextFromFields();
  opencodeRawConfigSyncing = false;
}

function opencodeApplyRawConfigToFields(settings) {
  if (!settings || typeof settings !== 'object') return;
  const options = settings.options && typeof settings.options === 'object' ? settings.options : {};
  const baseUrl = opencodeBaseUrlFromOptions(options);
  const apiKey = opencodeApiKeyFromOptions(options);
  const name = opencodeConfigNameFromSettings(settings);
  const modelKeys = opencodeModelKeysFromSettings(settings);
  const currentModel = String(document.getElementById('opencode-config-model')?.value || '').trim();
  const pickedModel = currentModel && modelKeys.includes(currentModel) ? currentModel : modelKeys[0] || currentModel;

  if (name) codexConfigSetInputValue('opencode-config-name', name);
  if (baseUrl) codexConfigSetInputValue('opencode-config-base-url', baseUrl);
  if (apiKey) codexConfigSetInputValue('opencode-config-api-key', apiKey);
  if (modelKeys.length) {
    codexConfigSetInputValue('opencode-config-model', pickedModel);
    codexConfigSetInputValue('opencode-config-models', codexConfigNormalizeModels(modelKeys, pickedModel).join('\n'));
    renderOpenCodeConfigModelList(modelKeys);
  }
}

function onOpenCodeRawConfigInput() {
  if (opencodeRawConfigSyncing) return;
  const raw = document.getElementById('opencode-config-raw-json')?.value || '';
  try {
    const parsed = JSON.parse(raw || '{}');
    const validation = opencodeValidateSettingsConfig(parsed);
    if (validation) {
      opencodeConfigSetModelStatus(validation, 'error');
      return;
    }
    opencodeRawConfigSyncing = true;
    opencodeApplyRawConfigToFields(parsed);
    opencodeRawConfigSyncing = false;
    opencodeConfigSetModelStatus('原始配置 JSON 已同步', 'success');
  } catch {
    opencodeConfigSetModelStatus('原始配置 JSON 格式无效', 'error');
  }
}

function onOpenCodeDefaultModelInput() {
  renderOpenCodeConfigModelList();
  syncOpenCodeRawConfigFromFields();
}

// Active OpenCode raw-config helpers above preserve extra options/model metadata.

globalThis.opencodeSourceSearchKw = '';

function onOpenCodeSourceSearch() {
  const input = document.getElementById('opencode-source-search-input');
  globalThis.opencodeSourceSearchKw = (input?.value || '').trim().toLowerCase();
  const currentId = document.getElementById('opencode-config-source-id')?.value || '';
  renderOpenCodeConfigSourceList(currentId);
}

function renderOpenCodeConfigSourceList(selectedId = '') {
  const list = document.getElementById('opencode-config-source-list');
  const hint = document.getElementById('opencode-config-source-hint');
  const count = document.getElementById('opencode-config-source-count');
  if (!list) return '';
  const sources = opencodeConfigSourceProviders();
  if (count) count.textContent = String(sources.length);
  if (!sources.length) {
    list.innerHTML = '<div class="codex-config-source-empty">暂无 OpenAI 供应商</div>';
    if (hint) hint.textContent = '请先在「供应商」页添加 OpenAI 协议供应商，再回来创建 OpenCode 配置。';
    codexConfigSetInputValue('opencode-config-source-id', '');
    return '';
  }

  const kw = (globalThis.opencodeSourceSearchKw || '').trim().toLowerCase();
  const filteredSources = kw
    ? sources.filter(p => {
        const name = String(p.name || p.id || '').toLowerCase();
        const host = String(p.apiHost || '').toLowerCase();
        return name.includes(kw) || host.includes(kw);
      })
    : sources;

  if (!filteredSources.length) {
    list.innerHTML = '<div class="codex-config-source-empty">没有匹配的供应商</div>';
    return '';
  }

  const picked = filteredSources.some(p => p.id === selectedId)
    ? selectedId
    : (sources.some(p => p.id === selectedId) ? selectedId : filteredSources[0].id);

  list.innerHTML = filteredSources.map(p => {
    const active = p.id === picked;
    const name = p.name || p.id;
    const endpoint = opencodeConfigDisplayBaseUrl(p) || 'Base URL 未设置';
    const modelCount = Array.isArray(p.models) ? p.models.length : 0;
    const countBadge = modelCount > 0 ? `<span class="opencode-source-count-badge">${modelCount} 模型</span>` : '';
    return `
      <button type="button" class="codex-config-source-item ${active ? 'active' : ''}" data-source-id="${platformEsc(p.id)}">
        <span class="codex-config-source-copy">
          <span class="opencode-source-item-top">
            <strong title="${platformEsc(name)}">${platformEsc(name)}</strong>
            ${countBadge}
          </span>
          <em title="${platformEsc(endpoint)}">${platformEsc(endpoint)}</em>
        </span>
      </button>`;
  }).join('');
  list.onclick = (event) => {
    const item = event.target.closest('.codex-config-source-item');
    if (!item || !list.contains(item)) return;
    selectOpenCodeConfigSource(item.dataset.sourceId || '');
  };
  if (hint) hint.textContent = '只读取来源供应商作为模板；保存后会生成独立的 OpenCode 配置。';
  codexConfigSetInputValue('opencode-config-source-id', picked);
  return picked;
}

function applyOpenCodeConfigSource(providerId) {
  const source = (providerStore.providers || []).find(p => p && p.id === providerId);
  if (!source) return;
  codexConfigSetInputValue('opencode-config-source-id', source.id);
  codexConfigSetInputValue('opencode-config-name', source.name || '');
  codexConfigSetInputValue('opencode-config-base-url', opencodeConfigDisplayBaseUrl(source));
  codexConfigSetInputValue('opencode-config-api-key', source.apiKey || '');
  const models = codexConfigModelList(source);
  codexConfigSetInputValue('opencode-config-model', source.defaultModel || models[0] || '');
  opencodeConfigSetModels(models, source.defaultModel || models[0] || '', models.length ? `已带入 ${models.length} 个模型` : '已带入来源信息，请拉取模型列表。');
  syncOpenCodeRawConfigFromFields();
}

function selectOpenCodeConfigSource(providerId) {
  const picked = renderOpenCodeConfigSourceList(providerId);
  if (picked) applyOpenCodeConfigSource(picked);
}

function opencodeConfigSetModelStatus(text, tone = '') {
  const el = document.getElementById('opencode-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone || '';
}

function opencodeConfigSetFetchLoading(loading) {
  setConfigFetchButtonLoading('opencode-config-fetch-models-btn', loading);
}

function opencodeConfigSetModels(models, defaultModel = '', status = '') {
  const normalized = codexConfigNormalizeModels(models, defaultModel);
  codexConfigSetInputValue('opencode-config-models', normalized.join('\n'));
  codexConfigSetInputValue('opencode-config-model', defaultModel || normalized[0] || '');
  renderOpenCodeConfigModelList(normalized);
  if (status) opencodeConfigSetModelStatus(status);
}

function renderOpenCodeConfigModelList(models = null) {
  const list = document.getElementById('opencode-config-model-list');
  if (!list) return;
  const defaultModel = String(document.getElementById('opencode-config-model')?.value || '').trim();
  const rawSource = models || codexConfigParseModels(document.getElementById('opencode-config-models')?.value, defaultModel);
  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const source = sortFn(rawSource);
  if (!source.length) {
    list.innerHTML = '<div class="codex-config-model-empty">还没有模型，点击右上角按钮拉取。</div>';
    return;
  }
  list.innerHTML = source.map(model => {
    const isDefault = model === defaultModel;
    const icon = typeof renderModelIcon === 'function' ? renderModelIcon(model) : '';
    return `
      <div class="opencode-model-option ${isDefault ? 'active' : ''}" data-model="${platformEsc(model)}" title="${platformEsc(model)}" role="radio" aria-checked="${isDefault ? 'true' : 'false'}">
        <span class="opencode-model-icon-wrap">${icon}</span>
        <span class="opencode-model-name">${platformEsc(model)}</span>
        ${isDefault ? '<span class="opencode-model-default-badge">默认 ✓</span>' : '<span style="font-size:12px;color:var(--text-muted);opacity:0.8;margin-left:auto;">点击设为默认</span>'}
      </div>
    `;
  }).join('');
  list.setAttribute('role', 'radiogroup');
  list.onclick = (event) => {
    const item = event.target.closest('.opencode-model-option');
    if (!item || !list.contains(item)) return;
    event.preventDefault();
    event.stopPropagation();
    selectOpenCodeConfigModel(item.dataset.model || '');
  };
}

function selectOpenCodeConfigModel(model) {
  codexConfigSetInputValue('opencode-config-model', model);
  const models = codexConfigNormalizeModels(document.getElementById('opencode-config-models')?.value, model);
  codexConfigSetInputValue('opencode-config-models', models.join('\n'));
  renderOpenCodeConfigModelList(models);
  syncOpenCodeRawConfigFromFields();
}

function opencodeConfigEndpointParts(baseUrl) {
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

async function fetchOpenCodeConfigModels() {
  if (!invoke) return;
  const baseUrl = String(document.getElementById('opencode-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('opencode-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  await runRaceGuardedModelFetch({
    getSeq: () => opencodeConfigModelFetchSeq,
    bumpSeq: () => ++opencodeConfigModelFetchSeq,
    setLoadingFn: opencodeConfigSetFetchLoading,
    setStatusFn: opencodeConfigSetModelStatus,
    loadingStatusText: '正在拉取模型列表...',
    fetcher: async () => {
      const endpoint = opencodeConfigEndpointParts(baseUrl);
      return invoke('fetch_models', {
        args: {
          host: endpoint.apiHost,
          api_key: apiKey,
          api_format: 'openai',
          path: endpoint.apiPath || '/v1',
        }
      });
    },
    onSuccess: (result) => {
      const models = codexConfigNormalizeModels(result?.models || []);
      if (!models.length) throw new Error('接口返回的模型列表为空');
      const current = String(document.getElementById('opencode-config-model')?.value || '').trim();
      const picked = current && models.includes(current) ? current : models[0];
      opencodeConfigSetModels(models, picked, `已拉取 ${models.length} 个模型`);
      syncOpenCodeRawConfigFromFields();
      if (typeof addLog === 'function') addLog('ok', `OpenCode 配置模型拉取成功: ${models.length} 个`);
    },
    onError: (e) => {
      opencodeConfigSetModelStatus('拉取失败，可手动输入默认模型', 'error');
      if (typeof addLog === 'function') addLog('warn', `OpenCode 配置模型拉取失败: ${e}`);
      showCustomAlert(String(e), '模型拉取失败', 'error');
    },
  });
}

function openCodeProviderIsLive(provider, info) {
  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  return !!provider && liveIds.includes(provider.id);
}

function opencodeConfigMatchesSearch(config) {
  const kw = opencodeConfigSearch.trim().toLowerCase();
  if (!kw) return true;
  return [
    config.name,
    config.typeLabel,
    config.model,
    config.endpoint,
    config.protocol,
    config.description,
  ].some(value => String(value || '').toLowerCase().includes(kw));
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.opencodeConfigSourceProviders = opencodeConfigSourceProviders;
  g.opencodeTargetBaseUrl = opencodeTargetBaseUrl;
  g.opencodeConfigDisplayBaseUrl = opencodeConfigDisplayBaseUrl;
  g.opencodeCurrentRawSettingsConfig = opencodeCurrentRawSettingsConfig;
  g.opencodeModelMapFromList = opencodeModelMapFromList;
  g.opencodeBuildSettingsConfig = opencodeBuildSettingsConfig;
  g.opencodeSettingsFromFields = opencodeSettingsFromFields;
  g.opencodeValidateSettingsConfig = opencodeValidateSettingsConfig;
  g.opencodeNormalizeSettingsConfig = opencodeNormalizeSettingsConfig;
  g.opencodeConfigObjectFromRawOrFields = opencodeConfigObjectFromRawOrFields;
  g.opencodeBuildSettingsForProvider = opencodeBuildSettingsForProvider;
  g.opencodeSetRawSettings = opencodeSetRawSettings;
  g.opencodeModelKeysFromSettings = opencodeModelKeysFromSettings;
  g.opencodeBaseUrlFromOptions = opencodeBaseUrlFromOptions;
  g.opencodeApiKeyFromOptions = opencodeApiKeyFromOptions;
  g.opencodeConfigNameFromSettings = opencodeConfigNameFromSettings;
  g.opencodeRawConfigTextFromSettings = opencodeRawConfigTextFromSettings;
  g.opencodeRawConfigTextFromFields = opencodeRawConfigTextFromFields;
  g.syncOpenCodeRawConfigFromFields = syncOpenCodeRawConfigFromFields;
  g.opencodeApplyRawConfigToFields = opencodeApplyRawConfigToFields;
  g.onOpenCodeRawConfigInput = onOpenCodeRawConfigInput;
  g.onOpenCodeDefaultModelInput = onOpenCodeDefaultModelInput;
  g.onOpenCodeSourceSearch = onOpenCodeSourceSearch;
  g.renderOpenCodeConfigSourceList = renderOpenCodeConfigSourceList;
  g.applyOpenCodeConfigSource = applyOpenCodeConfigSource;
  g.selectOpenCodeConfigSource = selectOpenCodeConfigSource;
  g.opencodeConfigSetModelStatus = opencodeConfigSetModelStatus;
  g.opencodeConfigSetFetchLoading = opencodeConfigSetFetchLoading;
  g.opencodeConfigSetModels = opencodeConfigSetModels;
  g.renderOpenCodeConfigModelList = renderOpenCodeConfigModelList;
  g.selectOpenCodeConfigModel = selectOpenCodeConfigModel;
  g.opencodeConfigEndpointParts = opencodeConfigEndpointParts;
  g.fetchOpenCodeConfigModels = fetchOpenCodeConfigModels;
  g.openCodeProviderIsLive = openCodeProviderIsLive;
  g.opencodeConfigMatchesSearch = opencodeConfigMatchesSearch;
})(globalThis);
