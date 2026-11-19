// platforms/claude_code_settings.js — Claude Code settings.json 构建/校验与模型端点探测

function claudeCodeConfigProviderById(id) {
  return (providerStore.claudeCodeConfigs || []).find(p => p && p.id === id) || null;
}

function claudeCodeConfigSourceProviders() {
  return (providerStore.providers || []).filter(p =>
    p &&
    p.enabled !== false
  );
}

function claudeCodeTargetBaseUrl(provider) {
  const endpoint = platformJoinUrl(provider && provider.apiHost, provider && provider.apiPath);
  if (!endpoint) return '';
  return platformStripSuffix(endpoint, ['/v1/messages', '/messages', '/v1']);
}

function claudeCodeConfigDisplayBaseUrl(provider) {
  if (!provider) return '';
  return claudeCodeTargetBaseUrl(provider) || platformJoinUrl(provider.apiHost, provider.apiPath);
}

function claudeCodeBuildSettingsConfig(baseUrl, apiKey, model, seed = null) {
  const cleanBaseUrl = claudeCodeConfigDisplayBaseUrl({
    apiHost: baseUrl,
    apiPath: '',
  }) || String(baseUrl || '').trim();
  const cleanModel = String(model || '').trim();
  const displayName = cleanModel.replace(/\s*\[1m\]\s*$/i, '');
  const base = seed && typeof seed === 'object' && !Array.isArray(seed)
    ? JSON.parse(JSON.stringify(seed))
    : {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      includeCoAuthoredBy: false,
      env: {},
      permissions: {},
      hooks: {},
      mcpServers: {},
    };
  if (!base.env || typeof base.env !== 'object' || Array.isArray(base.env)) base.env = {};
  const env = base.env;
  env.ANTHROPIC_BASE_URL = cleanBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = String(apiKey || '').trim();
  env.ANTHROPIC_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = displayName;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = displayName;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = displayName;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = displayName;
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  return base;
}

function claudeCodeCurrentRawSettingsConfig() {
  const raw = document.getElementById('claude-code-config-raw-json')?.value || '';
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function claudeCodeModelCandidatesFromEnv(env = {}) {
  return [
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME,
    env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME,
    env.ANTHROPIC_SMALL_FAST_MODEL,
  ].map(value => sanitizePlatformModelName(value)).filter(Boolean);
}

function claudeCodeSeededSettingsConfig(baseUrl, apiKey, model) {
  return claudeCodeBuildSettingsConfig(baseUrl, apiKey, model, claudeCodeCurrentRawSettingsConfig());
}

function claudeCodeFallbackSettingsConfig(provider, models = null) {
  const modelList = models || codexConfigModelList(provider);
  return claudeCodeBuildSettingsConfig(
    claudeCodeConfigDisplayBaseUrl(provider),
    provider?.apiKey || '',
    provider?.defaultModel || modelList[0] || '',
    provider?.settingsConfig || null
  );
}

function claudeCodeNormalizeSettingsConfig(settings, baseUrl, apiKey, model) {
  const normalized = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings
    : {};
  if (!normalized.env || typeof normalized.env !== 'object' || Array.isArray(normalized.env)) {
    normalized.env = {};
  }
  const env = normalized.env;
  if (!env.ANTHROPIC_BASE_URL && baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY && !normalized.apiKey && apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;

  const effectiveUrl = env.ANTHROPIC_BASE_URL || baseUrl || '';
  const isAnyRouter = isAnyRouterEndpoint(effectiveUrl, settings?.name || '');
  const cleanModel = sanitizePlatformModelName(model);
  const targetModel = ensureOneMContextMarker(cleanModel, isAnyRouter);
  const displayName = stripOneMContextMarker(targetModel);

  const modelFields = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
  ];
  modelFields.forEach(field => {
    if (env[field]) {
      const cleanFieldVal = sanitizePlatformModelName(env[field]);
      env[field] = ensureOneMContextMarker(cleanFieldVal, isAnyRouter);
    } else if (targetModel) {
      env[field] = targetModel;
    }
  });

  const nameFields = [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  ];
  nameFields.forEach(field => {
    if (env[field]) {
      env[field] = stripOneMContextMarker(sanitizePlatformModelName(env[field]));
    } else if (displayName) {
      env[field] = displayName;
    }
  });

  if (isAnyRouter) {
    if (env.ANTHROPIC_REASONING_MODEL) {
      env.ANTHROPIC_REASONING_MODEL = ensureOneMContextMarker(env.ANTHROPIC_REASONING_MODEL, true);
    }
    if (env.CLAUDE_CODE_SUBAGENT_MODEL) {
      env.CLAUDE_CODE_SUBAGENT_MODEL = ensureOneMContextMarker(env.CLAUDE_CODE_SUBAGENT_MODEL, true);
    }
    if (normalized.model) {
      normalized.model = ensureOneMContextMarker(normalized.model, true);
    }
  }

  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  if (!('$schema' in normalized)) normalized.$schema = 'https://json.schemastore.org/claude-code-settings.json';
  if (!('includeCoAuthoredBy' in normalized)) normalized.includeCoAuthoredBy = false;
  if (!('permissions' in normalized)) normalized.permissions = {};
  if (!('hooks' in normalized)) normalized.hooks = {};
  if (!('mcpServers' in normalized)) normalized.mcpServers = {};
  return normalized;
}

function claudeCodeEnsureRawConfigFromFields() {
  const raw = document.getElementById('claude-code-config-raw-json');
  if (!raw || raw.value.trim()) return;
  raw.value = claudeCodeRawConfigTextFromFields();
}

function claudeCodeEnvModel(settings) {
  const env = settings && typeof settings === 'object' ? settings.env || {} : {};
  return claudeCodeModelCandidatesFromEnv(env)[0] || '';
}

function claudeCodeApplyModelCandidates(settings) {
  const env = settings && typeof settings === 'object' ? settings.env || {} : {};
  const candidates = claudeCodeModelCandidatesFromEnv(env);
  if (!candidates.length) return;
  const picked = candidates[0];
  codexConfigSetInputValue('claude-code-config-model', picked);
  const existing = document.getElementById('claude-code-config-models')?.value || '';
  const models = codexConfigNormalizeModels([...candidates, ...codexConfigParseModels(existing, picked)], picked);
  codexConfigSetInputValue('claude-code-config-models', models.join('\n'));
  renderClaudeCodeConfigModelList(models);
}

function claudeCodeApiKeyFromEnv(env = {}) {
  return env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || env.GOOGLE_API_KEY || '';
}

function claudeCodeApiKeyFromSettings(settings) {
  if (typeof settings?.apiKey === 'string' && settings.apiKey && !settings.apiKey.includes('${')) {
    return settings.apiKey;
  }
  const env = settings && typeof settings === 'object' ? settings.env || {} : {};
  return claudeCodeApiKeyFromEnv(env);
}

function claudeCodeBaseUrlFromEnv(env = {}) {
  return env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BEDROCK_BASE_URL || env.ANTHROPIC_VERTEX_BASE_URL || '';
}

function claudeCodeValidateSettingsConfig(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'Claude Code 配置 JSON 顶层必须是对象。';
  }
  if ('env' in settings && (typeof settings.env !== 'object' || Array.isArray(settings.env) || settings.env === null)) {
    return 'Claude Code 配置 JSON 的 env 字段必须是对象。';
  }
  return '';
}

function claudeCodeRawConfigTextFromSettings(settings) {
  return JSON.stringify(settings, null, 2);
}

function claudeCodeBuildSettingsForProvider(provider, models = null) {
  const modelList = models || codexConfigModelList(provider);
  const baseUrl = claudeCodeConfigDisplayBaseUrl(provider);
  const isAnyRouter = isAnyRouterEndpoint(baseUrl, provider?.name || '');
  const cleanDefault = ensureOneMContextMarker(provider?.defaultModel || modelList[0] || '', isAnyRouter);
  return claudeCodeNormalizeSettingsConfig(
    claudeCodeFallbackSettingsConfig(provider, modelList),
    baseUrl,
    provider?.apiKey || '',
    cleanDefault
  );
}

function claudeCodeConfigSetModelStatus(text, tone = '') {
  const el = document.getElementById('claude-code-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone || '';
}

function claudeCodeConfigSetFetchLoading(loading) {
  setConfigFetchButtonLoading('claude-code-config-fetch-models-btn', loading);
}

function claudeCodeConfigEndpointParts(baseUrl) {
  if (typeof providerEndpointParts === 'function') {
    return providerEndpointParts(baseUrl, 'anthropic', '/v1/messages');
  }
  let apiHost = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiHost)) apiHost = `https://${apiHost}`;
  try {
    const url = new URL(apiHost);
    const apiPath = url.pathname && url.pathname !== '/' ? url.pathname : '/v1/messages';
    return { apiHost: url.origin, apiPath };
  } catch {
    return { apiHost, apiPath: '/v1/messages' };
  }
}

function claudeCodeConfigModelEndpointParts(baseUrl, apiFormat) {
  if (typeof providerEndpointParts === 'function') {
    return providerEndpointParts(
      baseUrl,
      apiFormat,
      apiFormat === 'openai' ? '/v1' : '/v1/messages'
    );
  }
  return claudeCodeConfigEndpointParts(baseUrl);
}

async function fetchClaudeCodeConfigModelsWithFormat(baseUrl, apiKey, apiFormat) {
  const endpoint = claudeCodeConfigModelEndpointParts(baseUrl, apiFormat);
  return invoke('fetch_models', {
    args: {
      host: endpoint.apiHost,
      api_key: apiKey,
      api_format: apiFormat,
      path: endpoint.apiPath || (apiFormat === 'openai' ? '/v1' : '/v1/messages'),
    }
  });
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.claudeCodeConfigProviderById = claudeCodeConfigProviderById;
  g.claudeCodeConfigSourceProviders = claudeCodeConfigSourceProviders;
  g.claudeCodeTargetBaseUrl = claudeCodeTargetBaseUrl;
  g.claudeCodeConfigDisplayBaseUrl = claudeCodeConfigDisplayBaseUrl;
  g.claudeCodeBuildSettingsConfig = claudeCodeBuildSettingsConfig;
  g.claudeCodeCurrentRawSettingsConfig = claudeCodeCurrentRawSettingsConfig;
  g.claudeCodeModelCandidatesFromEnv = claudeCodeModelCandidatesFromEnv;
  g.claudeCodeSeededSettingsConfig = claudeCodeSeededSettingsConfig;
  g.claudeCodeFallbackSettingsConfig = claudeCodeFallbackSettingsConfig;
  g.claudeCodeNormalizeSettingsConfig = claudeCodeNormalizeSettingsConfig;
  g.claudeCodeEnsureRawConfigFromFields = claudeCodeEnsureRawConfigFromFields;
  g.claudeCodeEnvModel = claudeCodeEnvModel;
  g.claudeCodeApplyModelCandidates = claudeCodeApplyModelCandidates;
  g.claudeCodeApiKeyFromEnv = claudeCodeApiKeyFromEnv;
  g.claudeCodeApiKeyFromSettings = claudeCodeApiKeyFromSettings;
  g.claudeCodeBaseUrlFromEnv = claudeCodeBaseUrlFromEnv;
  g.claudeCodeValidateSettingsConfig = claudeCodeValidateSettingsConfig;
  g.claudeCodeRawConfigTextFromSettings = claudeCodeRawConfigTextFromSettings;
  g.claudeCodeBuildSettingsForProvider = claudeCodeBuildSettingsForProvider;
  g.claudeCodeConfigSetModelStatus = claudeCodeConfigSetModelStatus;
  g.claudeCodeConfigSetFetchLoading = claudeCodeConfigSetFetchLoading;
  g.claudeCodeConfigEndpointParts = claudeCodeConfigEndpointParts;
  g.claudeCodeConfigModelEndpointParts = claudeCodeConfigModelEndpointParts;
  g.fetchClaudeCodeConfigModelsWithFormat = fetchClaudeCodeConfigModelsWithFormat;
})(globalThis);
