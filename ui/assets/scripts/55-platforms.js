// More platforms: persistent config switching for Claude Code / Codex / CodeBuddy / OpenCode / ZCode.

let platformInfos = [];
let platformBusy = null;
let codexTokenVisible = false;
let codexTokenTimer = null;
let claudeCodeConfigSearch = '';
let claudeCodeConfigEditorMode = 'create';
let claudeCodeConfigModelFetchSeq = 0;
let claudeCodeRawConfigSyncing = false;
let codexConfigSearch = '';
let codexConfigEditorMode = 'create';
let codexConfigModelFetchSeq = 0;
let opencodeConfigSearch = '';
let opencodeConfigEditorMode = 'create';
let opencodeConfigModelFetchSeq = 0;
let opencodeRawConfigSyncing = false;

const PLATFORM_DEFS = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    requiredApiFormat: 'anthropic',
    configHint: '~/.claude/settings.json',
    summary: '写入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / 默认模型',
    note: '原有 MCP、权限、hooks、语言等设置会保留。',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    requiredApiFormat: 'openai',
    configHint: '~/.codex/config.toml',
    summary: '写入 model_provider = "byok" 和 model_providers.byok',
    note: '所选中转站必须支持 OpenAI Responses API。',
  },
  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy',
    vendor: 'Tencent Cloud',
    requiredApiFormat: 'openai',
    configHint: '~/.codebuddy/models.json',
    summary: '写入 models.json 自定义模型，使用 OpenAI Chat Completions',
    note: 'URL 会规范化为完整 /v1/chat/completions 端点。',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode',
    requiredApiFormat: 'openai',
    configHint: '~/.config/opencode/opencode.json',
    summary: '以累加模式写入 @ai-sdk/openai-compatible provider',
    note: '配置方案独立保存，应用时加入 OpenCode live provider 列表。',
  },
  zcode: {
    id: 'zcode',
    name: 'ZCode',
    vendor: 'Z.AI',
    requiredApiFormat: 'openai',
    configHint: '~/.zcode/v2/config.json + ~/.zcode/cli/config.json',
    summary: '写入 openai-compatible provider 到 ZCode 配置',
    note: 'baseURL 会写入 ZCode 原生 provider 配置，不带 /chat/completions。',
  },
  workbuddy: {
    id: 'workbuddy',
    name: 'WorkBuddy',
    vendor: 'Tencent Cloud',
    requiredApiFormat: 'openai',
    configHint: '~/.workbuddy/models.json',
    summary: '写入 models.json 自定义模型，使用完整 Chat Completions 端点',
    note: '会设置 useCustomProtocol=true，避免 WorkBuddy 额外拼接路径。',
  },
};

function platformEsc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function platformInfoOf(platformId) {
  return platformInfos.find(p => p.id === platformId) || null;
}

function platformDef(platformId) {
  return PLATFORM_DEFS[platformId] || {
    id: platformId,
    name: platformId,
    vendor: '',
    requiredApiFormat: 'anthropic',
    configHint: '',
    summary: '',
    note: '',
  };
}

function platformFormatLabel(fmt) {
  return fmt === 'openai' ? 'OpenAI' : 'Anthropic';
}


function platformLocalProxyConfigId(platformId) {
  return `anybridge-local-proxy-${platformId}`;
}

function platformIsLocalProxyConfig(config) {
  return !!(config && (config.localProxy || String(config.id || '').startsWith('anybridge-local-proxy-')));
}

function platformLocalProxyRuntime(platformId) {
  if (typeof getLocalProxyRuntimeConfig !== 'function') return null;
  return getLocalProxyRuntimeConfig(platformId);
}


function openProxyRoutesFromPlatform() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('routes');
  } else if (typeof navigateTo === 'function') {
    navigateTo('proxy');
  }
}

function platformLocalProxyCard(platformId, info) {
  if (platformId === 'codex') return null;
  const runtime = platformLocalProxyRuntime(platformId);
  if (!runtime) return null;
  const isClaude = platformId === 'claude-code';
  const isOpenCode = platformId === 'opencode';
  const localProxyId = platformLocalProxyConfigId(platformId);
  const live = isOpenCode
    ? (Array.isArray(info?.liveProviderIds) && info.liveProviderIds.includes(localProxyId))
    : false;
  const current = isOpenCode
    ? info?.currentProviderId === localProxyId
    : isClaude
      ? (typeof claudeCodeProviderIsCurrent === 'function' && claudeCodeProviderIsCurrent(runtime, info))
      : (typeof codexProviderIsCurrent === 'function' && codexProviderIsCurrent(runtime, info));
  return {
    platformId,
    name: 'AnyBridge 本地代理',
    description: isClaude
      ? '通过 AnyBridge Claude 兼容入口转发到代理模型列表、代理增强和日志统计。'
      : '通过 AnyBridge OpenAI 兼容入口转发到代理模型列表、代理增强和日志统计。',
    typeLabel: isOpenCode && live ? (current ? '当前使用' : '已加入') : '本地',
    tone: isOpenCode && live ? (current ? 'local live' : 'local') : 'local',
    current: !!current,
    currentLabel: '当前使用',
    model: runtime.defaultModel || '未配置',
    endpoint: runtime.endpoint,
    protocol: isClaude ? 'anthropic-compatible' : (isOpenCode ? 'openai-compatible' : 'responses'),
    configAction: isOpenCode ? '' : 'openProxyRoutesFromPlatform()',
    configLabel: '配置模型',
    action: `applyLocalProxyPlatformConfig(${platformJsArg(platformId)})`,
    actionLabel: isOpenCode ? (live ? '设为当前' : '加入并设为当前') : '切换',
    removeAction: isOpenCode && live ? `removeOpenCodeProviderConfig(${platformJsArg(localProxyId)})` : '',
    removeLabel: '移除',
  };
}

function upsertById(list, item) {
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex(x => x && x.id === item.id);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...item };
  else arr.push(item);
  return arr;
}

async function ensureLocalProxyPlatformConfig(platformId) {
  if (platformId === 'codex') {
    throw new Error('Codex 已使用独立配置的「路由模式（本地代理）」接入 AnyBridge 本地代理，不再支持旧版本地代理快捷卡片。');
  }
  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  if (typeof ensureLocalProxyConfig === 'function') await ensureLocalProxyConfig({});
  const runtime = platformLocalProxyRuntime(platformId);
  if (!runtime) throw new Error('本地代理配置未初始化');
  if (!runtime.apiKey) throw new Error('本地代理 key 尚未生成');
  const models = Array.isArray(runtime.models) && runtime.models.length
    ? runtime.models
    : [];
  if (!models.length) {
    throw new Error('尚未配置启用的本地代理模型，请先到「代理 > 模型列表」添加模型。');
  }
  const model = runtime.defaultModel || models[0];
  const base = {
    id: platformLocalProxyConfigId(platformId),
    name: 'AnyBridge 本地代理',
    apiHost: runtime.apiHost,
    apiPath: runtime.apiPath,
    apiKey: runtime.apiKey,
    defaultModel: model,
    models,
    sourceProviderId: 'local-proxy',
    sourceProviderName: 'AnyBridge',
    localProxy: true,
  };

  if (platformId === 'claude-code') {
    const settingsConfig = typeof claudeCodeBuildSettingsConfig === 'function'
      ? claudeCodeBuildSettingsConfig(runtime.endpoint, runtime.apiKey, model, null)
      : null;
    providerStore.claudeCodeConfigs = upsertById(providerStore.claudeCodeConfigs, { ...base, settingsConfig });
  } else if (platformId === 'opencode') {
    const settingsConfig = typeof opencodeBuildSettingsConfig === 'function'
      ? opencodeBuildSettingsConfig('AnyBridge 本地代理', runtime.endpoint, runtime.apiKey, models, null)
      : null;
    providerStore.opencodeConfigs = upsertById(providerStore.opencodeConfigs, { ...base, settingsConfig });
  } else if (platformId === 'codex') {
    providerStore.codexConfigs = upsertById(providerStore.codexConfigs, base);
  } else {
    providerStore.providers = upsertById(providerStore.providers, {
      id: platformLocalProxyConfigId(platformId),
      name: 'AnyBridge 本地代理',
      apiHost: runtime.apiHost,
      apiPath: runtime.apiPath,
      apiKey: runtime.apiKey,
      defaultModel: model,
      models,
      apiFormat: runtime.apiFormat || 'openai',
      enabled: true,
      localProxy: true,
    });
  }
  if (typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) {
      providerStore = typeof cloneProviderStore === 'function'
        ? cloneProviderStore(previous)
        : JSON.parse(JSON.stringify(previous));
      throw new Error('本地代理平台配置保存失败');
    }
  }
  return platformLocalProxyConfigId(platformId);
}

async function applyLocalProxyPlatformConfig(platformId) {
  const def = platformDef(platformId);
  const providerId = await ensureLocalProxyPlatformConfig(platformId);
  const runtime = platformLocalProxyRuntime(platformId);
  const isOpenCode = platformId === 'opencode';
  const info = platformInfoOf(platformId) || {};
  const live = isOpenCode && Array.isArray(info.liveProviderIds) && info.liveProviderIds.includes(providerId);
  const ok = await showCustomConfirm(
    `${isOpenCode ? (live ? '将把 AnyBridge 本地代理设为 OpenCode 当前 model。' : '将把 AnyBridge 本地代理加入 OpenCode live provider 列表，并设为当前 model。') : `将把 ${def.name} 切换到「AnyBridge 本地代理」。`}\n\n模型列表：${(runtime.models || []).join(', ') || '未配置'}\n地址：${runtime.endpoint}\n\n请求会先进入 AnyBridge 全局代理服务；如果代理未启动，外部工具会连接失败。`,
    isOpenCode ? (live ? '设为当前' : '加入并设为当前') : '切换到本地代理',
    'warn'
  );
  if (!ok) return;
  setPlatformBusy(platformId, true);
  showSwitchProgress(platformId, '正在准备切换到本地代理…');
  try {
    const result = await invoke('switch_platform', { platform: platformId, providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || `${def.name} 已切换到 AnyBridge 本地代理`);
    showCustomAlert(result.message || `${def.name} 已切换到 AnyBridge 本地代理。`, isOpenCode ? '设置完成' : '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${def.name} 切换到本地代理失败: ${e}`);
    showCustomAlert(String(e), isOpenCode ? '设置失败' : '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy(platformId, false);
    renderPlatformDetailStatuses();
  }
}
function platformProviderList(platformId) {
  const def = platformDef(platformId);
  if (platformId === 'claude-code') {
    return Array.isArray(providerStore?.claudeCodeConfigs) ? providerStore.claudeCodeConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'codex') {
    return Array.isArray(providerStore?.codexConfigs) ? providerStore.codexConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'opencode') {
    return Array.isArray(providerStore?.opencodeConfigs) ? providerStore.opencodeConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  const providers = (providerStore && Array.isArray(providerStore.providers))
    ? providerStore.providers
    : [];
  return providers.filter(p => p && p.enabled !== false && !platformIsLocalProxyConfig(p));
}

function formatPlatformTime(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n < 1000000000000 ? n * 1000 : n;
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function platformSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function platformSetValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value == null ? '' : String(value);
}

function platformStatusTag(label, tone) {
  return `<span class="platform-tag ${platformEsc(tone)}">${platformEsc(label)}</span>`;
}

function platformShort(value, fallback = '未配置') {
  const text = String(value || '').trim();
  return text || fallback;
}

function platformJoinUrl(host, path) {
  let base = String(host || '').trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');
  const suffix = String(path || '').trim();
  if (!suffix || suffix === '/') return base;
  return `${base}/${suffix.replace(/^\/+/, '').replace(/\/+$/, '')}`.replace(/\/+$/, '');
}

function platformStripSuffix(value, suffixes) {
  let out = String(value || '').trim().replace(/\/+$/, '');
  const lower = out.toLowerCase();
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) {
      out = out.slice(0, out.length - suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return out;
}

function codexTargetBaseUrl(provider) {
  const endpoint = platformJoinUrl(provider && provider.apiHost, provider && provider.apiPath);
  if (!endpoint) return '';
  const base = platformStripSuffix(endpoint, ['/chat/completions', '/responses']);
  return base.toLowerCase().endsWith('/v1') ? base : `${base}/v1`;
}

async function refreshPlatforms(options = {}) {
  if (!invoke) return;
  const btn = document.getElementById('platforms-refresh-btn');
  if (btn && !options.silent) {
    btn.disabled = true;
    btn.textContent = '检测中...';
  }

  try {
    if (typeof loadProviders === 'function') {
      await loadProviders();
    }
    platformInfos = await invoke('detect_platforms') || [];
    renderPlatformCards();
    renderPlatformDetailStatuses();
    renderPlatformProviderOptions();
  } catch (e) {
    const grid = document.getElementById('platforms-grid');
    if (grid) {
      grid.innerHTML = `<div class="platforms-empty">检测失败：${platformEsc(e)}</div>`;
    }
    if (typeof addLog === 'function') addLog('err', '平台检测失败: ' + e);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '刷新检测';
    }
  }
}

function renderPlatformCards() {
  const grid = document.getElementById('platforms-grid');
  if (!grid) return;

  const ids = Object.keys(PLATFORM_DEFS);
  const infos = ids.map(id => platformInfoOf(id) || {
    ...PLATFORM_DEFS[id],
    displayName: PLATFORM_DEFS[id].name,
    installed: false,
    backupExists: false,
    managedByAnyBridge: false,
    currentProviderName: '',
    currentProviderId: '',
    configPath: '',
    appliedAt: '',
    codexConfig: null,
    claudeConfig: null,
  });

  grid.innerHTML = infos.map(info => renderPlatformCard(info)).join('');
}

function renderPlatformCard(info) {
  const def = platformDef(info.id);
  const installed = !!info.installed;
  const backup = !!info.backupExists;
  const hasProvider = !!info.currentProviderId;
  const official = !!(info.codexConfig && info.codexConfig.isOfficial);
  const managed = info.managedByAnyBridge != null ? !!info.managedByAnyBridge : hasProvider;
  const appliedAt = formatPlatformTime(info.appliedAt);
  const providerName = info.currentProviderName || info.currentProviderId || '未接管';
  const path = info.configPath || def.configHint;
  const status = installed
    ? platformStatusTag('已检测', 'ok')
    : platformStatusTag('未检测', 'warn');
  const backupTag = backup
    ? platformStatusTag('有备份', 'info')
    : platformStatusTag('无备份', 'muted');
  const appliedTag = official
    ? platformStatusTag('官方配置', 'ok')
    : managed
    ? platformStatusTag('已接管', 'ok')
    : hasProvider
      ? platformStatusTag('外部配置', 'info')
      : platformStatusTag('未接管', 'muted');

  return `
    <article class="platform-card">
      <div class="platform-card-top">
        <div>
          <div class="platform-card-title">${platformEsc(def.name)}</div>
          <div class="platform-card-sub">${platformEsc(def.vendor)} · ${platformEsc(platformFormatLabel(def.requiredApiFormat))}</div>
        </div>
        <div class="platform-card-tags">${status}${appliedTag}${backupTag}</div>
      </div>
      <div class="platform-card-body">
        <div class="platform-card-summary">${platformEsc(def.summary)}</div>
        <div class="platform-card-row">
          <span>当前供应商</span>
          <strong title="${platformEsc(providerName)}">${platformEsc(providerName)}</strong>
        </div>
        <div class="platform-card-row">
          <span>配置文件</span>
          <strong title="${platformEsc(path)}">${platformEsc(path)}</strong>
        </div>
        ${appliedAt ? `<div class="platform-card-row"><span>应用时间</span><strong>${platformEsc(appliedAt)}</strong></div>` : ''}
      </div>
      <div class="platform-card-actions">
        <button class="btn-primary platform-open-btn" onclick="openPlatformPage('${platformEsc(info.id)}')">配置</button>
      </div>
    </article>
  `;
}

function renderPlatformDetailStatuses() {
  Object.keys(PLATFORM_DEFS).forEach(platformId => {
    const info = platformInfoOf(platformId);
    const def = platformDef(platformId);
    const el = document.getElementById(`platform-${platformId}-status`);

    if (platformId === 'codex') {
      if (info) renderCodexPageStatus(info);
      return;
    }
    if (platformId === 'claude-code') {
      if (info) renderClaudeCodePageStatus(info);
      return;
    }
    if (platformId === 'opencode') {
      if (info) renderOpenCodePageStatus(info);
      return;
    }

    if (!el) return;

    if (!info) {
      el.innerHTML = '<div class="platform-status-line">尚未检测。</div>';
      return;
    }

    const appliedAt = formatPlatformTime(info.appliedAt);
    const providerName = info.currentProviderName || info.currentProviderId || '未接管';
    const managed = info.managedByAnyBridge != null ? !!info.managedByAnyBridge : !!info.currentProviderId;
    const installedText = info.installed
      ? '已检测到配置目录'
      : '未检测到配置目录，应用时会自动创建配置文件';
    const backupText = info.backupExists
      ? '已创建 AnyBridge 备份，可还原'
      : '尚无 AnyBridge 备份';
    const manageText = managed
      ? 'AnyBridge 当前接管'
      : info.currentProviderId
        ? '当前为外部配置'
        : '未接管';
    const codexRows = info.id === 'codex' ? renderCodexConfigRows(info.codexConfig) : '';

    el.innerHTML = `
      <div class="platform-status-grid">
        <div class="platform-status-item">
          <span>检测状态</span>
          <strong>${platformEsc(installedText)}</strong>
        </div>
        <div class="platform-status-item">
          <span>当前供应商</span>
          <strong>${platformEsc(providerName)}</strong>
        </div>
        <div class="platform-status-item">
          <span>接管状态</span>
          <strong>${platformEsc(manageText)}</strong>
        </div>
        <div class="platform-status-item">
          <span>配置文件</span>
          <strong title="${platformEsc(info.configPath || def.configHint)}">${platformEsc(info.configPath || def.configHint)}</strong>
        </div>
        <div class="platform-status-item">
          <span>备份</span>
          <strong>${platformEsc(backupText)}</strong>
        </div>
        ${codexRows}
        ${appliedAt ? `<div class="platform-status-item"><span>应用时间</span><strong>${platformEsc(appliedAt)}</strong></div>` : ''}
      </div>
      ${info.error ? `<div class="platform-error">${platformEsc(info.error)}</div>` : ''}
    `;
  });
}

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

function claudeCodeStatusMeta(info) {
  if (info && info.claudeConfig && info.claudeConfig.isOfficial) {
    return { label: 'Anthropic 官方', tone: 'ok' };
  }
  if (info && info.managedByAnyBridge) {
    return { label: 'AnyBridge 第三方', tone: 'info' };
  }
  if (info && info.currentProviderId) {
    return { label: '外部配置', tone: 'warn' };
  }
  return { label: '未配置', tone: 'warn' };
}

function openCodeStatusMeta(info) {
  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  if (info?.currentProviderId) {
    return { label: `当前：${info.currentProviderName || info.currentProviderId}`, tone: info.managedByAnyBridge ? 'info' : 'warn' };
  }
  if (liveIds.length) {
    return { label: `已加入 ${liveIds.length} 个`, tone: info.managedByAnyBridge ? 'info' : 'warn' };
  }
  return { label: '未加入', tone: 'warn' };
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
  const headline = document.getElementById('platform-codex-headline');
  const pill = document.getElementById('platform-codex-state-pill');
  const currentLabel = document.getElementById('codex-current-label');
  const configPathLabel = document.getElementById('codex-config-path-label');

  const meta = codexStatusMeta(info);
  if (headline) headline.textContent = '管理 Codex 的官方登录配置和第三方 API 配置方案，切换后重启 Codex 生效。';

  if (pill) {
    pill.textContent = meta.label;
    pill.className = `codex-state-pill ${meta.tone}`;
  }
  if (currentLabel) currentLabel.textContent = meta.label;
  if (configPathLabel) configPathLabel.textContent = info.configPath || platformDef('codex').configHint;
  renderCodexConfigList(info);
}

function renderClaudeCodePageStatus(info) {
  const headline = document.getElementById('platform-claude-code-headline');
  const currentLabel = document.getElementById('claude-code-current-label');
  const configPathLabel = document.getElementById('claude-code-config-path-label');
  const meta = claudeCodeStatusMeta(info);

  if (headline) headline.textContent = '管理 Claude Code 的官方环境和第三方 Anthropic API 配置，切换后重启 Claude Code 生效。';
  if (currentLabel) currentLabel.textContent = meta.label;
  if (configPathLabel) configPathLabel.textContent = info.configPath || platformDef('claude-code').configHint;
  renderClaudeCodeConfigList(info);
}

function renderOpenCodePageStatus(info) {
  const headline = document.getElementById('platform-opencode-headline');
  const currentLabel = document.getElementById('opencode-current-label');
  const configPathLabel = document.getElementById('opencode-config-path-label');
  const meta = openCodeStatusMeta(info);

  if (headline) headline.textContent = '管理 OpenCode 的独立 provider 配置。应用时追加到 opencode.json，并可设为当前 model，不覆盖其他 provider。';
  if (currentLabel) currentLabel.textContent = meta.label;
  if (configPathLabel) configPathLabel.textContent = info.configPath || platformDef('opencode').configHint;
  renderOpenCodeConfigList(info);
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

function platformJsArg(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function codexConfigBadge(label, tone) {
  return `<span class="codex-config-badge ${platformEsc(tone || 'third')}">${platformEsc(label)}</span>`;
}

function codexConfigProviderById(id) {
  return (providerStore.codexConfigs || []).find(p => p && p.id === id) || null;
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

function applyCodexConfigSource(providerId) {
  const source = (providerStore.providers || []).find(p => p && p.id === providerId);
  if (!source) return;
  codexConfigSetInputValue('codex-config-source-id', source.id);
  codexConfigSetInputValue('codex-config-name', source.name || '');
  codexConfigSetInputValue('codex-config-base-url', codexConfigDisplayBaseUrl(source));
  codexConfigSetInputValue('codex-config-api-key', source.apiKey || '');
  renderReasoningConfig(source.codexChatReasoning);
  // 合并 catalog 和 provider models 到统一列表
  const catalog = source.modelCatalog || [];
  const providerModels = codexConfigModelList(source);
  const merged = mergeCatalogAndModels(catalog, providerModels);
  renderCodexModelManager(merged, '', '已带入来源信息，请拉取模型列表。');
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
  const models = list.map(m => String(m || '').trim()).filter(Boolean);
  const fallback = String(provider?.defaultModel || '').trim();
  if (fallback && !models.includes(fallback)) models.unshift(fallback);
  return [...new Set(models)];
}

function codexConfigParseModels(value, defaultModel) {
  const parts = String(value || '')
    .split(/[\n,，]/)
    .map(x => x.trim())
    .filter(Boolean);
  const first = String(defaultModel || '').trim();
  const models = first ? [first, ...parts] : parts;
  return [...new Set(models)];
}

function codexConfigNormalizeModels(models, defaultModel = '') {
  const list = (Array.isArray(models) ? models : String(models || '').split(/[\n,，]/))
    .map(m => String(m || '').trim())
    .filter(Boolean);
  const first = String(defaultModel || '').trim();
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
  return result;
}

function codexConfigSetModelStatus(text, tone = '') {
  const el = document.getElementById('codex-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone || '';
}

function codexConfigSetFetchLoading(loading) {
  const btn = document.getElementById('codex-config-fetch-models-btn');
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
  btn.textContent = loading ? '拉取中...' : '拉取模型';
}

function renderCodexModelManager(entries, defaultModel = '', status = '') {
  const container = document.getElementById('codex-config-model-list');
  if (!container) return;
  const list = Array.isArray(entries) ? entries : [];
  if (defaultModel) {
    list.forEach(e => { e.isDefault = (e.model === defaultModel); });
  }
  codexConfigSetInputValue('codex-config-models', list.map(e => e.model).join('\n'));
  codexConfigSetInputValue('codex-config-model', defaultModel || '');

  if (!list.length) {
    container.innerHTML = '<div class="codex-config-model-empty">还没有模型，点击右上角拉取或手动添加。</div>';
    if (status) codexConfigSetModelStatus(status);
    setCodexModelEntriesState([]);
    return;
  }
  setCodexModelEntriesState(list);
  // 不传 status 时：自动显示"目录 x/总数 · 默认 xxx"
  if (!status) {
    const total = list.length;
    const inCat = list.filter(e => e.inCatalog).length;
    const dflt = list.find(e => e.isDefault)?.model || '';
    const parts = [`目录 ${inCat}/${total}`];
    if (dflt) parts.push(`默认 ${dflt}`);
    codexConfigSetModelStatus(parts.join(' · '));
  }
  container.innerHTML = list.map((entry, i) => {
    const model = platformEsc(entry.model || '');
    const displayName = platformEsc(entry.displayName || '');
    const ctx = platformEsc(String(entry.contextWindow || ''));
    const checked = entry.inCatalog ? 'checked' : '';
    const isDefault = entry.isDefault;
    const activeClass = isDefault ? ' active' : '';
    const defaultBtnClass = isDefault ? 'codex-model-default-btn is-default' : 'codex-model-default-btn';
    const defaultBtnText = isDefault ? '默认 ✓' : '设为默认';
    const defaultBtnClick = isDefault
      ? `selectCodexDefaultModel('')`
      : `selectCodexDefaultModel('${model}')`;
    return `<div class="codex-config-model-option${activeClass}" data-idx="${i}" data-model="${model}" data-display="${displayName}" data-ctx="${ctx}">
      <input type="checkbox" ${checked} onchange="toggleCodexModelCatalog(${i})" title="加入模型目录">
      <span title="${model}">${model}</span>
      ${displayName ? `<span>${displayName}</span>` : ''}
      ${ctx ? `<span>${ctx}</span>` : ''}
      <button type="button" class="${defaultBtnClass}" onclick="${defaultBtnClick}">${defaultBtnText}</button>
      <button type="button" class="codex-config-fetch-btn" onclick="editCodexModelEntry(${i})">编辑</button>
      <button type="button" class="codex-config-catalog-del" onclick="removeCodexModelEntry(${i})">删除</button>
    </div>`;
  }).join('');
  if (status) codexConfigSetModelStatus(status);
}

// 从状态缓存读（避免 re-render 时 DOM 已被替换导致读到旧值）
function getCodexModelEntries() {
  if (codexModelEntriesState.length) {
    return codexModelEntriesState.map(e => ({ ...e }));
  }
  // 状态为空时回退到 DOM 读取（首次进入编辑器等场景）
  const container = document.getElementById('codex-config-model-list');
  if (!container) return [];
  const rows = container.querySelectorAll('.codex-config-model-option[data-idx]');
  const entries = [];
  for (const row of rows) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox) continue;
    const model = row.dataset.model || '';
    if (!model) continue;
    const displayName = row.dataset.display || '';
    const ctxStr = row.dataset.ctx || '';
    const inCatalog = checkbox.checked || false;
    const isDefault = row.classList.contains('active');
    const entry = { model, inCatalog, isDefault };
    if (displayName) entry.displayName = displayName;
    if (ctxStr) {
      const ctx = Number(ctxStr);
      if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx;
    }
    entries.push(entry);
  }
  return entries;
}

// 独立的 entries 状态缓存，避免 onchange 时从 DOM checkbox.checked 读到
// 已变化的值（导致"点取消→又变回勾上"的反向 bug）
let codexModelEntriesState = [];

function setCodexModelEntriesState(entries) {
  codexModelEntriesState = entries.map(e => ({ ...e }));
}

function toggleCodexModelCatalog(idx) {
  if (!codexModelEntriesState[idx]) return;
  codexModelEntriesState[idx].inCatalog = !codexModelEntriesState[idx].inCatalog;
  if (!codexModelEntriesState[idx].inCatalog) codexModelEntriesState[idx].isDefault = false;
  const defaultModel = codexModelEntriesState.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(codexModelEntriesState, defaultModel);
}

function selectCodexDefaultModel(model) {
  const entries = getCodexModelEntries();
  const defaultModel = String(model || '').trim();
  entries.forEach(e => { e.isDefault = (e.model === defaultModel); });
  renderCodexModelManager(entries, defaultModel);
  codexConfigSetModelStatus(defaultModel ? `默认模型：${defaultModel}` : '已清空默认模型', defaultModel ? 'success' : '');
}

function addCodexModelEntry() {
  const entries = getCodexModelEntries();
  entries.push({ model: '', displayName: '', contextWindow: '', inCatalog: true, isDefault: false });
  renderCodexModelManager(entries, entries.find(e => e.isDefault)?.model || '');
  editCodexModelEntry(entries.length - 1);
}

function editCodexModelEntry(idx) {
  const container = document.getElementById('codex-config-model-list');
  if (!container) return;
  const row = container.querySelectorAll('.codex-config-model-option[data-idx]')[idx];
  if (!row) return;
  const entries = getCodexModelEntries();
  const entry = entries[idx];
  if (!entry) return;
  row.classList.remove('active');
  row.innerHTML = `<div class="codex-config-catalog-row" style="width:100%">
    <input class="field-input" placeholder="模型 ID" value="${platformEsc(entry.model)}">
    <input class="field-input" placeholder="显示名（可选）" value="${platformEsc(entry.displayName)}">
    <input class="field-input" placeholder="上下文窗口" value="${platformEsc(String(entry.contextWindow || ''))}">
    <div style="display:flex;gap:4px">
      <button type="button" class="codex-config-fetch-btn" onclick="saveCodexModelEdit(${idx})">确定</button>
      <button type="button" class="codex-config-catalog-del" onclick="renderCodexModelManager(getCodexModelEntries(), getCodexModelEntries().find(e=>e.isDefault)?.model||'')">取消</button>
    </div>
  </div>`;
  row.querySelector('.field-input')?.focus();
}

function saveCodexModelEdit(idx) {
  const container = document.getElementById('codex-config-model-list');
  if (!container) return;
  const row = container.querySelectorAll('.codex-config-model-option[data-idx]')[idx];
  if (!row) return;
  const entries = getCodexModelEntries();
  const inputs = row.querySelectorAll('.field-input');
  const model = inputs[0]?.value?.trim() || '';
  if (!model) return;
  entries[idx].model = model;
  entries[idx].displayName = inputs[1]?.value?.trim() || '';
  const ctxStr = inputs[2]?.value?.trim() || '';
  if (ctxStr) {
    const ctx = Number(ctxStr);
    if (Number.isFinite(ctx) && ctx > 0) entries[idx].contextWindow = ctx;
  }
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, defaultModel);
}

function removeCodexModelEntry(idx) {
  const entries = getCodexModelEntries();
  if (!entries[idx]) return;
  entries.splice(idx, 1);
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, defaultModel);
}

function batchSetCodexModelCatalog(inCatalog) {
  const entries = getCodexModelEntries();
  if (!entries.length) return;
  entries.forEach(e => {
    e.inCatalog = inCatalog;
    if (!inCatalog) e.isDefault = false;
  });
  const defaultModel = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, defaultModel);
  codexConfigSetModelStatus(inCatalog ? `已加入 ${entries.length} 个模型到目录` : `已清空目录`, inCatalog ? 'success' : '');
  setTimeout(() => renderCodexModelManager(getCodexModelEntries(), codexConfigGetDefaultModel()), 1500);
}

function batchSetCodexDefaultModel() {
  const entries = getCodexModelEntries();
  if (!entries.length) return;
  entries.forEach(e => { e.isDefault = false; });
  renderCodexModelManager(entries, '');
  codexConfigSetModelStatus('已清空默认模型', '');
  setTimeout(() => renderCodexModelManager(getCodexModelEntries(), ''), 1500);
}

function codexConfigGetDefaultModel() {
  return String(document.getElementById('codex-config-model')?.value || '').trim();
}

function codexConfigEndpointParts(baseUrl) {
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

async function fetchCodexConfigModels() {
  if (!invoke) return;
  const seq = ++codexConfigModelFetchSeq;
  const baseUrl = String(document.getElementById('codex-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('codex-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  codexConfigSetFetchLoading(true);
  codexConfigSetModelStatus('正在拉取模型列表...', 'loading');
  try {
    const endpoint = codexConfigEndpointParts(baseUrl);
    const result = await invoke('fetch_models', {
      args: {
        host: endpoint.apiHost,
        api_key: apiKey,
        api_format: 'openai',
        path: endpoint.apiPath || '/v1',
      }
    });
    if (seq !== codexConfigModelFetchSeq) return;
    const fetchedModels = (result?.models || []).map(m => String(m || '').trim()).filter(Boolean);
    if (!fetchedModels.length) throw new Error('接口返回的模型列表为空');
    // 合并到已有列表：已有的保留状态，新拉取的默认不勾选
    const existing = getCodexModelEntries();
    const existingMap = new Map(existing.map(e => [e.model, e]));
    const merged = [];
    // 先放已有的
    for (const entry of existing) {
      merged.push({ ...entry });
    }
    // 再放新拉取的
    for (const model of fetchedModels) {
      if (!existingMap.has(model)) {
        merged.push({ model, displayName: '', contextWindow: '', inCatalog: false, isDefault: false });
      }
    }
    const currentDefault = existing.find(e => e.isDefault)?.model || '';
    renderCodexModelManager(merged, currentDefault, `已拉取 ${fetchedModels.length} 个模型`);
    codexConfigSetModelStatus(`已拉取 ${fetchedModels.length} 个模型`, 'success');
    if (typeof addLog === 'function') addLog('ok', `Codex 配置模型拉取成功: ${fetchedModels.length} 个`);
  } catch (e) {
    if (seq !== codexConfigModelFetchSeq) return;
    codexConfigSetModelStatus('拉取失败，可手动添加模型', 'error');
    if (typeof addLog === 'function') addLog('warn', `Codex 配置模型拉取失败: ${e}`);
    showCustomAlert(String(e), '模型拉取失败', 'error');
  } finally {
    if (seq === codexConfigModelFetchSeq) codexConfigSetFetchLoading(false);
  }
}

function codexConfigDisplayBaseUrl(provider) {
  if (!provider) return '';
  return codexTargetBaseUrl(provider) || platformJoinUrl(provider.apiHost, provider.apiPath);
}

function codexConfigSetInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value == null ? '' : String(value);
}

// ── Reasoning 配置编辑 ──
function renderReasoningConfig(config) {
  const r = config || {};
  codexConfigSetInputValue('codex-config-reasoning-thinking', r.thinkingParam || 'none');
  codexConfigSetInputValue('codex-config-reasoning-effort', r.effortParam || 'none');
  codexConfigSetInputValue('codex-config-reasoning-effort-mode', r.effortValueMode || 'passthrough');
  codexConfigSetInputValue('codex-config-reasoning-output', r.outputFormat || 'auto');
}

function getReasoningConfig() {
  const thinkingParam = String(document.getElementById('codex-config-reasoning-thinking')?.value || 'none').trim();
  const effortParam = String(document.getElementById('codex-config-reasoning-effort')?.value || 'none').trim();
  const effortValueMode = String(document.getElementById('codex-config-reasoning-effort-mode')?.value || 'passthrough').trim();
  const outputFormat = String(document.getElementById('codex-config-reasoning-output')?.value || 'auto').trim();
  if (thinkingParam === 'none' && effortParam === 'none') return undefined;
  return {
    supportsThinking: thinkingParam !== 'none',
    supportsEffort: effortParam !== 'none',
    thinkingParam: thinkingParam !== 'none' ? thinkingParam : undefined,
    effortParam: effortParam !== 'none' ? effortParam : undefined,
    effortValueMode: effortValueMode !== 'passthrough' ? effortValueMode : undefined,
    outputFormat: outputFormat !== 'auto' ? outputFormat : undefined,
  };
}

function openCodexConfigEditor(providerId = '') {
  const provider = providerId ? codexConfigProviderById(providerId) : null;
  if (providerId && !provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  codexConfigEditorMode = provider ? 'edit' : 'create';
  const modal = document.getElementById('codex-config-modal');
  const title = document.getElementById('codex-config-modal-title');
  const sub = document.getElementById('codex-config-modal-sub');
  const sourceWrap = document.getElementById('codex-config-source-wrap');
  const layout = document.getElementById('codex-config-editor-layout');
  const models = codexConfigModelList(provider);

  if (title) title.textContent = provider ? '编辑 Codex 配置' : '添加 Codex 配置';
  if (sub) sub.textContent = provider
    ? `正在编辑「${provider.name || provider.id}」这份 Codex 配置。`
    : '从现有供应商创建一份可切换的 Codex Responses 配置。';
  if (sourceWrap) sourceWrap.classList.toggle('is-hidden', !!provider);
  if (layout) {
    layout.classList.toggle('is-editing', !!provider);
    layout.classList.toggle('is-creating', !provider);
  }

  codexConfigSetInputValue('codex-config-edit-id', provider?.id || '');
  if (provider) {
    codexConfigSetInputValue('codex-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('codex-config-name', provider.name || '');
    codexConfigSetInputValue('codex-config-base-url', codexConfigDisplayBaseUrl(provider));
    codexConfigSetInputValue('codex-config-api-key', provider.apiKey || '');
    document.getElementById('codex-config-route-through-proxy').checked = provider.routeThroughProxy !== false;
    document.getElementById('codex-config-inject-models').checked = provider.injectModels !== false;
    renderReasoningConfig(provider.codexChatReasoning);
    // 合并 catalog 和 models 到统一列表
    const catalog = provider.modelCatalog || [];
    const providerModels = codexConfigModelList(provider);
    const merged = mergeCatalogAndModels(catalog, providerModels);
    const defaultModel = provider.defaultModel || '';
    // 标记默认模型
    if (defaultModel) {
      const dm = merged.find(e => e.model === defaultModel);
      if (dm) dm.isDefault = true;
    }
    // 编辑模式：不在 saved catalog 里的模型默认不勾选（保留用户之前取消的选择）
    // 创建模式：所有模型默认勾选
    const catalogSet = new Set(catalog.map(e => e.model));
    for (const e of merged) {
      if (!catalogSet.has(e.model)) {
        e.inCatalog = false;
      }
    }
    renderCodexModelManager(merged, defaultModel, merged.length ? `已保存 ${merged.length} 个模型` : '可重新拉取模型列表');
  } else {
    codexConfigSetInputValue('codex-config-name', '');
    codexConfigSetInputValue('codex-config-base-url', '');
    codexConfigSetInputValue('codex-config-api-key', '');
    document.getElementById('codex-config-route-through-proxy').checked = true;
    document.getElementById('codex-config-inject-models').checked = true;
    renderReasoningConfig(null);
    renderCodexModelManager([], '', '选择供应商后拉取模型列表');
    const picked = renderCodexConfigSourceList('');
    if (picked) applyCodexConfigSource(picked);
  }

  if (modal) modal.classList.add('active');
  window.setTimeout(() => {
    const target = provider
      ? document.getElementById('codex-config-name')
      : document.querySelector('#codex-config-source-list .codex-config-source-item.active');
    target?.focus();
  }, 30);
}

function closeCodexConfigEditor() {
  document.getElementById('codex-config-modal')?.classList.remove('active');
}

async function syncCodexConfigUiAfterStoreChange() {
  if (typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) return false;
  }
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
  if (typeof renderModelMap === 'function') await renderModelMap();
  renderCodexConfigList(platformInfoOf('codex') || {});
  renderPlatformProviderOptions();
  return true;
}

async function saveCodexConfigEditor(switchAfter = false) {
  const editId = String(document.getElementById('codex-config-edit-id')?.value || '').trim();
  const sourceId = String(document.getElementById('codex-config-source-id')?.value || '').trim();
  const name = String(document.getElementById('codex-config-name')?.value || '').trim();
  const baseUrl = String(document.getElementById('codex-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('codex-config-api-key')?.value || '').trim();
  // 从统一模型管理器读取数据
  const allEntries = getCodexModelEntries();
  const defaultModel = allEntries.find(e => e.isDefault)?.model || '';
  const models = allEntries.map(e => e.model).filter(Boolean);
  const modelCatalog = allEntries
    .filter(e => e.inCatalog)
    .map(e => {
      const entry = { model: e.model };
      if (e.displayName) entry.displayName = e.displayName;
      if (e.contextWindow) entry.contextWindow = e.contextWindow;
      return entry;
    });

  if (!editId && !sourceId) {
    showCustomAlert('请先选择一个现有供应商。', '没有配置来源', 'warn');
    return;
  }
  if (!name || !baseUrl || !apiKey) {
    showCustomAlert('请填写配置名称、Base URL 和 API Key。', '配置不完整', 'warn');
    return;
  }
  if (!models.length) {
    showCustomAlert('请至少添加一个模型。', '配置不完整', 'warn');
    return;
  }
  if (!defaultModel) {
    showCustomAlert('请选择一个默认模型（勾选后点击单选按钮）。', '未选择默认模型', 'warn');
    return;
  }

  const endpoint = typeof providerEndpointParts === 'function'
    ? providerEndpointParts(baseUrl, 'openai', '/v1')
    : { apiHost: baseUrl.replace(/\/+$/, ''), apiPath: '/v1' };
  const existing = editId ? codexConfigProviderById(editId) : null;
  const source = sourceId
    ? (providerStore.providers || []).find(p => p && p.id === sourceId)
    : null;
  // wireApi 从来源供应商自动继承（用户不在 UI 上选，编辑时保留原值）
  const wireApi = source?.wireApi || existing?.wireApi || 'responses';
  const routeThroughProxy = document.getElementById('codex-config-route-through-proxy')?.checked !== false;
  const injectModels = document.getElementById('codex-config-inject-models')?.checked !== false;

  const provider = {
    ...(existing || {}),
    id: editId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1',
    apiKey,
    defaultModel,
    models,
    wireApi,
    modelCatalog: modelCatalog.length ? modelCatalog : undefined,
    codexChatReasoning: getReasoningConfig(),
    routeThroughProxy,
    injectModels,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  if (!Array.isArray(providerStore.codexConfigs)) providerStore.codexConfigs = [];
  if (editId) {
    const idx = providerStore.codexConfigs.findIndex(p => p.id === editId);
    if (idx >= 0) providerStore.codexConfigs[idx] = provider;
    else providerStore.codexConfigs.push(provider);
  } else {
    providerStore.codexConfigs.push(provider);
  }

  const ok = await syncCodexConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderCodexConfigList(platformInfoOf('codex') || {});
    return;
  }
  closeCodexConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 Codex 配置: ${name}`);
  if (switchAfter) await applyCodexProviderConfig(provider.id);
}

function codexActionIcon(type) {
  if (type === 'delete') {
    return '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
  }
  if (type === 'start') {
    return '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
  }
  return '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
}

function codexCurrentAction(label = '当前使用') {
  return `<span class="codex-current-action">${platformEsc(label)}</span>`;
}

function renderCodexConfigCard(config) {
  const disabled = platformBusy === (config.platformId || 'codex');
  const editButton = config.editAction
    ? `<button class="btn-ghost codex-card-action codex-icon-action" type="button" title="编辑" aria-label="编辑 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} onclick="${platformEsc(config.editAction)}">${codexActionIcon('edit')}</button>`
    : '';
  const deleteButton = config.deleteAction
    ? `<button class="btn-ghost codex-card-action codex-icon-action codex-delete-action" type="button" title="删除" aria-label="删除 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} onclick="${platformEsc(config.deleteAction)}">${codexActionIcon('delete')}</button>`
    : '';
  const removeButton = config.removeAction
    ? `<button class="btn-ghost codex-card-action" type="button" title="从 live 配置移除" aria-label="从 live 配置移除 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} onclick="${platformEsc(config.removeAction)}">${platformEsc(config.removeLabel || '移除')}</button>`
    : '';
  const configButton = config.configAction
    ? `<button class="btn-ghost codex-card-action" type="button" aria-label="${platformEsc(config.configLabel || '配置')} ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} onclick="${platformEsc(config.configAction)}">${platformEsc(config.configLabel || '配置')}</button>`
    : '';
  const startButton = config.startAction
    ? `<button class="btn-ghost codex-card-action codex-icon-action" type="button" title="重启 Codex 桌面版" aria-label="启动 Codex ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} onclick="${platformEsc(config.startAction)}">${codexActionIcon('start')}</button>`
    : '';
  const switchButton = config.current || !config.action
    ? ''
    : `<button class="btn-primary codex-card-action codex-switch-action" ${disabled ? 'disabled' : ''} onclick="${platformEsc(config.action)}">${platformEsc(config.actionLabel || '切换')}</button>`;
  const actions = config.current
    ? `<div class="codex-config-actions">${editButton}${deleteButton}${configButton}${removeButton}${startButton}${codexCurrentAction(config.currentLabel || '当前使用')}</div>`
    : (editButton || deleteButton || configButton || removeButton || switchButton || startButton ? `<div class="codex-config-actions">${editButton}${deleteButton}${configButton}${removeButton}${switchButton}${startButton}</div>` : '<span class="codex-row-muted">-</span>');
  const meta = codexConfigMetaLine([
    config.model || '-',
    config.endpoint || '-',
    config.protocol || 'responses',
  ]);
  return `
    <article class="codex-config-card ${config.current ? 'current' : ''} ${platformEsc(config.tone || '')}">
      <div class="codex-config-main">
        <div class="codex-config-title">
          <strong title="${platformEsc(config.name)}">${platformEsc(config.name)}</strong>
          ${codexConfigBadge(config.typeLabel || '第三方', config.tone)}
          ${config.injectBadge === 'success'
            ? '<span class="codex-config-badge-success">✓ codex 桌面版正确显示模型</span>'
            : config.injectBadge === 'muted'
              ? '<span class="codex-config-badge-muted">codex 桌面版使用默认模型</span>'
              : ''}
        </div>
        <p>${platformEsc(config.description || '')}</p>
        <div class="codex-config-meta">${meta}</div>
      </div>
      <div class="codex-config-card-side">
        ${actions}
      </div>
    </article>
  `;
}

async function deleteCodexProviderConfig(providerId) {
  const provider = codexConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('codex');
  if (codexProviderIsCurrent(provider, info)) {
    showCustomAlert('当前正在使用的配置不能直接删除，请先切换到其他配置或官方配置。', '无法删除当前配置', 'warn');
    return;
  }
  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  providerStore.codexConfigs = (providerStore.codexConfigs || []).filter(p => p.id !== providerId);
  const ok = await syncCodexConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderCodexConfigList(platformInfoOf('codex') || {});
    return;
  }
  if (typeof addLog === 'function') addLog('info', `已删除 Codex 配置: ${provider.name || provider.id}`);
}

function editCodexProviderConfig(providerId) {
  const provider = codexConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  openCodexConfigEditor(providerId);
}

function codexConfigMatchesSearch(config) {
  const kw = codexConfigSearch.trim().toLowerCase();
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

function renderCodexConfigList(info) {
  const list = document.getElementById('platform-codex-config-list');
  if (!list) return;

  const providers = platformProviderList('codex');
  const config = (info && info.codexConfig) || {};
  const items = [];

  items.push({
    name: 'OpenAI 官方配置',
    description: '使用 Codex 官方登录态，不写入第三方地址和 token。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: !!config.isOfficial,
    model: '官方默认',
    endpoint: 'auth.json 登录态',
    protocol: 'responses',
    action: 'restoreCodexOfficialConfig()',
  });

  const codexLocalCard = platformLocalProxyCard('codex', info);
  if (codexLocalCard) items.push(codexLocalCard);

  const isExternal = !!info.currentProviderId && !config.isOfficial && !info.managedByAnyBridge
    && !providers.some(provider => codexProviderIsCurrent(provider, info));
  if (isExternal) {
    items.push({
      name: info.currentProviderName || config.providerName || info.currentProviderId || '当前第三方配置',
      description: '由其他工具或手动配置写入。可以保留，也可以切换到下方任一配置。',
      typeLabel: '第三方',
      tone: 'third external',
      current: true,
      model: config.model || '未知',
      endpoint: config.baseUrl || config.modelProviderId || info.currentProviderId,
      protocol: config.wireApi || 'responses',
    });
  }

  providers.forEach(provider => {
    const baseUrl = codexTargetBaseUrl(provider);
    const current = codexProviderIsCurrent(provider, info);
    const typeLabel = provider.routeThroughProxy === false ? '直连' : '代理';
    const injectModels = provider.injectModels !== false; // 默认 true
    const isOfficialModel = /^gpt-/i.test(String(provider.defaultModel || '').trim());
    items.push({
      name: provider.name || provider.id,
      description: '第三方 OpenAI Responses 兼容配置。',
      typeLabel: isOfficialModel ? `${typeLabel}（官方模型）` : typeLabel,
      tone: 'third',
      current,
      model: provider.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: provider.wireApi || 'responses',
      injectBadge: injectModels ? 'success' : 'muted',
      action: `applyCodexProviderConfig(${platformJsArg(provider.id)})`,
      editAction: `editCodexProviderConfig(${platformJsArg(provider.id)})`,
      startAction: current ? `startCodexWithCdp(${injectModels ? 'true' : 'false'})` : '',
      deleteAction: current ? '' : `deleteCodexProviderConfig(${platformJsArg(provider.id)})`,
    });
  });

  const filtered = items.filter(codexConfigMatchesSearch);
  const count = document.getElementById('codex-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

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
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = cleanModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = cleanModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = cleanModel;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = cleanModel;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = cleanModel;
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
  ].map(value => String(value || '').trim()).filter(Boolean);
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
  const cleanModel = String(model || '').trim();
  if (cleanModel) {
    const fields = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    ];
    fields.forEach(field => {
      if (!env[field]) env[field] = cleanModel;
    });
    delete env.ANTHROPIC_SMALL_FAST_MODEL;
  }
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

function claudeCodeSettingsFromFields() {
  const baseUrl = document.getElementById('claude-code-config-base-url')?.value || '';
  const apiKey = document.getElementById('claude-code-config-api-key')?.value || '';
  const model = document.getElementById('claude-code-config-model')?.value || '';
  return claudeCodeSeededSettingsConfig(baseUrl, apiKey, model);
}

function claudeCodeSettingsTextFromFields() {
  return claudeCodeRawConfigTextFromSettings(claudeCodeSettingsFromFields());
}

function claudeCodeSetRawSettings(settings) {
  codexConfigSetInputValue('claude-code-config-raw-json', claudeCodeRawConfigTextFromSettings(settings));
}

function claudeCodeBuildSettingsForProvider(provider, models = null) {
  const modelList = models || codexConfigModelList(provider);
  return claudeCodeNormalizeSettingsConfig(
    claudeCodeFallbackSettingsConfig(provider, modelList),
    claudeCodeConfigDisplayBaseUrl(provider),
    provider?.apiKey || '',
    provider?.defaultModel || modelList[0] || ''
  );
}

function claudeCodeCreateSettingsFromCurrentFields() {
  return claudeCodeNormalizeSettingsConfig(
    claudeCodeSettingsFromFields(),
    document.getElementById('claude-code-config-base-url')?.value || '',
    document.getElementById('claude-code-config-api-key')?.value || '',
    document.getElementById('claude-code-config-model')?.value || ''
  );
}

function claudeCodeConfigObjectFromRawOrFields() {
  const rawConfig = String(document.getElementById('claude-code-config-raw-json')?.value || '').trim();
  return rawConfig ? JSON.parse(rawConfig) : claudeCodeCreateSettingsFromCurrentFields();
}

function claudeCodeRawConfigTextFromFields() {
  return claudeCodeSettingsTextFromFields();
}

function syncClaudeCodeRawConfigFromFields() {
  if (claudeCodeRawConfigSyncing) return;
  const raw = document.getElementById('claude-code-config-raw-json');
  if (!raw) return;
  claudeCodeRawConfigSyncing = true;
  raw.value = claudeCodeRawConfigTextFromFields();
  claudeCodeRawConfigSyncing = false;
}

function claudeCodeApplyRawConfigToFields(settings) {
  const env = settings && typeof settings === 'object' ? settings.env || {} : {};
  const baseUrl = claudeCodeBaseUrlFromEnv(env);
  const apiKey = claudeCodeApiKeyFromEnv(env);
  if (baseUrl) codexConfigSetInputValue('claude-code-config-base-url', baseUrl);
  if (apiKey) codexConfigSetInputValue('claude-code-config-api-key', apiKey);
  claudeCodeApplyModelCandidates(settings);
}

function onClaudeCodeRawConfigInput() {
  if (claudeCodeRawConfigSyncing) return;
  const raw = document.getElementById('claude-code-config-raw-json')?.value || '';
  try {
    const parsed = JSON.parse(raw || '{}');
    const validation = claudeCodeValidateSettingsConfig(parsed);
    if (validation) {
      claudeCodeConfigSetModelStatus(validation, 'error');
      return;
    }
    claudeCodeRawConfigSyncing = true;
    claudeCodeApplyRawConfigToFields(parsed);
    claudeCodeRawConfigSyncing = false;
    claudeCodeConfigSetModelStatus('原始配置 JSON 已同步', 'success');
  } catch {
    claudeCodeConfigSetModelStatus('原始配置 JSON 格式无效', 'error');
  }
}

function onClaudeCodeDefaultModelInput() {
  renderClaudeCodeConfigModelList();
  syncClaudeCodeRawConfigFromFields();
}

function renderClaudeCodeConfigSourceList(selectedId = '') {
  const list = document.getElementById('claude-code-config-source-list');
  const hint = document.getElementById('claude-code-config-source-hint');
  const count = document.getElementById('claude-code-config-source-count');
  if (!list) return '';
  const sources = claudeCodeConfigSourceProviders();
  if (count) count.textContent = String(sources.length);
  if (!sources.length) {
    list.innerHTML = '<div class="codex-config-source-empty">暂无 Anthropic 供应商</div>';
    if (hint) hint.textContent = '请先在「供应商」页添加 Anthropic 协议供应商，再回来创建 Claude Code 配置。';
    codexConfigSetInputValue('claude-code-config-source-id', '');
    return '';
  }

  const picked = sources.some(p => p.id === selectedId) ? selectedId : sources[0].id;
  list.innerHTML = sources.map(p => {
    const active = p.id === picked;
    const name = p.name || p.id;
    const endpoint = claudeCodeConfigDisplayBaseUrl(p) || 'Base URL 未设置';
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
    selectClaudeCodeConfigSource(item.dataset.sourceId || '');
  };
  if (hint) hint.textContent = '只读取来源供应商作为模板；保存后会生成独立的 Claude Code 配置。';
  codexConfigSetInputValue('claude-code-config-source-id', picked);
  return picked;
}

function applyClaudeCodeConfigSource(providerId) {
  const source = (providerStore.providers || []).find(p => p && p.id === providerId);
  if (!source) return;
  codexConfigSetInputValue('claude-code-config-source-id', source.id);
  codexConfigSetInputValue('claude-code-config-name', source.name || '');
  codexConfigSetInputValue('claude-code-config-base-url', claudeCodeConfigDisplayBaseUrl(source));
  codexConfigSetInputValue('claude-code-config-api-key', source.apiKey || '');
  const models = codexConfigModelList(source);
  codexConfigSetInputValue('claude-code-config-model', source.defaultModel || models[0] || '');
  claudeCodeConfigSetModels(models, source.defaultModel || models[0] || '', models.length ? `已带入 ${models.length} 个模型` : '已带入来源信息，请拉取模型列表。');
  syncClaudeCodeRawConfigFromFields();
}

function selectClaudeCodeConfigSource(providerId) {
  const picked = renderClaudeCodeConfigSourceList(providerId);
  if (picked) applyClaudeCodeConfigSource(picked);
}

function claudeCodeConfigSetModelStatus(text, tone = '') {
  const el = document.getElementById('claude-code-config-model-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.tone = tone || '';
}

function claudeCodeConfigSetFetchLoading(loading) {
  const btn = document.getElementById('claude-code-config-fetch-models-btn');
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
  btn.textContent = loading ? '拉取中...' : '拉取模型列表';
}

function claudeCodeConfigSetModels(models, defaultModel = '', status = '') {
  const normalized = codexConfigNormalizeModels(models, defaultModel);
  codexConfigSetInputValue('claude-code-config-models', normalized.join('\n'));
  codexConfigSetInputValue('claude-code-config-model', defaultModel || normalized[0] || '');
  renderClaudeCodeConfigModelList(normalized);
  if (status) claudeCodeConfigSetModelStatus(status);
}

function renderClaudeCodeConfigModelList(models = null) {
  const list = document.getElementById('claude-code-config-model-list');
  if (!list) return;
  const defaultModel = String(document.getElementById('claude-code-config-model')?.value || '').trim();
  const source = models || codexConfigParseModels(document.getElementById('claude-code-config-models')?.value, defaultModel);
  if (!source.length) {
    list.innerHTML = '<div class="codex-config-model-empty">还没有模型，点击右上角按钮拉取。</div>';
    return;
  }
  list.innerHTML = source.map(model => `
    <button type="button" class="codex-config-model-option ${model === defaultModel ? 'active' : ''}" data-model="${platformEsc(model)}" title="${platformEsc(model)}" role="radio" aria-checked="${model === defaultModel ? 'true' : 'false'}">
      <span>${platformEsc(model)}</span>
    </button>
  `).join('');
  list.setAttribute('role', 'radiogroup');
  list.onclick = (event) => {
    const item = event.target.closest('.codex-config-model-option');
    if (!item || !list.contains(item)) return;
    event.preventDefault();
    event.stopPropagation();
    selectClaudeCodeConfigModel(item.dataset.model || '');
  };
}

function selectClaudeCodeConfigModel(model) {
  codexConfigSetInputValue('claude-code-config-model', model);
  const models = codexConfigNormalizeModels(document.getElementById('claude-code-config-models')?.value, model);
  codexConfigSetInputValue('claude-code-config-models', models.join('\n'));
  renderClaudeCodeConfigModelList(models);
  syncClaudeCodeRawConfigFromFields();
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

async function fetchClaudeCodeConfigModels() {
  if (!invoke) return;
  const seq = ++claudeCodeConfigModelFetchSeq;
  const baseUrl = String(document.getElementById('claude-code-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('claude-code-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  claudeCodeConfigSetFetchLoading(true);
  claudeCodeConfigSetModelStatus('正在拉取模型列表...', 'loading');
  try {
    let result = null;
    let lastError = null;
    for (const apiFormat of ['openai', 'anthropic']) {
      try {
        claudeCodeConfigSetModelStatus(
          apiFormat === 'openai'
            ? '正在按 /v1/models 拉取模型列表...'
            : '正在按 Anthropic 鉴权重试模型列表...',
          'loading'
        );
        result = await fetchClaudeCodeConfigModelsWithFormat(baseUrl, apiKey, apiFormat);
        if (result?.models?.length) break;
        lastError = new Error(`${apiFormat === 'openai' ? 'OpenAI' : 'Anthropic'} 协议返回的模型列表为空`);
      } catch (e) {
        lastError = e;
      }
    }
    if (!result?.models?.length) throw lastError || new Error('接口返回的模型列表为空');
    if (seq !== claudeCodeConfigModelFetchSeq) return;
    const models = codexConfigNormalizeModels(result?.models || []);
    if (!models.length) throw new Error('接口返回的模型列表为空');
    const current = String(document.getElementById('claude-code-config-model')?.value || '').trim();
    const picked = current && models.includes(current) ? current : models[0];
    claudeCodeConfigSetModels(models, picked, `已拉取 ${models.length} 个模型`);
    syncClaudeCodeRawConfigFromFields();
    if (typeof addLog === 'function') addLog('ok', `Claude Code 配置模型拉取成功: ${models.length} 个`);
  } catch (e) {
    if (seq !== claudeCodeConfigModelFetchSeq) return;
    claudeCodeConfigSetModelStatus('拉取失败，可手动输入默认模型', 'error');
    if (typeof addLog === 'function') addLog('warn', `Claude Code 配置模型拉取失败: ${e}`);
    showCustomAlert(String(e), '模型拉取失败', 'error');
  } finally {
    if (seq === claudeCodeConfigModelFetchSeq) claudeCodeConfigSetFetchLoading(false);
  }
}

function claudeCodeProviderIsCurrent(provider, info) {
  const config = (info && info.claudeConfig) || {};
  if (!provider || !config || config.isOfficial) return false;
  const targetBase = claudeCodeTargetBaseUrl(provider).replace(/\/+$/, '').toLowerCase();
  const currentBase = String(config.baseUrl || '').replace(/\/+$/, '').toLowerCase();
  const sameBase = targetBase && currentBase && targetBase === currentBase;
  const sameModel = !config.model || !provider.defaultModel || config.model === provider.defaultModel;
  return sameBase && sameModel;
}

function claudeCodeConfigMatchesSearch(config) {
  const kw = claudeCodeConfigSearch.trim().toLowerCase();
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

function openClaudeCodeProviderAdd() {
  openClaudeCodeConfigEditor('');
}

function openClaudeCodeConfigEditor(providerId = '') {
  const provider = providerId ? claudeCodeConfigProviderById(providerId) : null;
  if (providerId && !provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  claudeCodeConfigEditorMode = provider ? 'edit' : 'create';
  const modal = document.getElementById('claude-code-config-modal');
  const title = document.getElementById('claude-code-config-modal-title');
  const sub = document.getElementById('claude-code-config-modal-sub');
  const sourceWrap = document.getElementById('claude-code-config-source-wrap');
  const layout = document.getElementById('claude-code-config-editor-layout');
  const models = codexConfigModelList(provider);

  if (title) title.textContent = provider ? '编辑 Claude Code 配置' : '添加 Claude Code 配置';
  if (sub) sub.textContent = provider
    ? `正在编辑「${provider.name || provider.id}」这份 Claude Code 配置。`
    : '从现有 Anthropic 供应商创建一份独立可切换配置。';
  if (sourceWrap) sourceWrap.classList.toggle('is-hidden', !!provider);
  if (layout) {
    layout.classList.toggle('is-editing', !!provider);
    layout.classList.toggle('is-creating', !provider);
  }

  codexConfigSetInputValue('claude-code-config-edit-id', provider?.id || '');
  if (provider) {
    codexConfigSetInputValue('claude-code-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('claude-code-config-name', provider.name || '');
    codexConfigSetInputValue('claude-code-config-base-url', claudeCodeConfigDisplayBaseUrl(provider));
    codexConfigSetInputValue('claude-code-config-api-key', provider.apiKey || '');
    codexConfigSetInputValue('claude-code-config-model', provider.defaultModel || models[0] || '');
    claudeCodeConfigSetModels(models, provider.defaultModel || models[0] || '', models.length ? `已保存 ${models.length} 个模型` : '可重新拉取模型列表');
    claudeCodeSetRawSettings(claudeCodeBuildSettingsForProvider(provider, models));
  } else {
    codexConfigSetInputValue('claude-code-config-name', '');
    codexConfigSetInputValue('claude-code-config-base-url', '');
    codexConfigSetInputValue('claude-code-config-api-key', '');
    codexConfigSetInputValue('claude-code-config-model', '');
    claudeCodeConfigSetModels([], '', '选择供应商后拉取模型列表');
    const picked = renderClaudeCodeConfigSourceList('');
    if (picked) applyClaudeCodeConfigSource(picked);
    else syncClaudeCodeRawConfigFromFields();
  }

  if (modal) modal.classList.add('active');
  window.setTimeout(() => {
    const target = provider
      ? document.getElementById('claude-code-config-name')
      : document.querySelector('#claude-code-config-source-list .codex-config-source-item.active');
    target?.focus();
  }, 30);
}

function closeClaudeCodeConfigEditor() {
  document.getElementById('claude-code-config-modal')?.classList.remove('active');
}

async function syncClaudeCodeConfigUiAfterStoreChange() {
  if (typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) return false;
  }
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
  if (typeof renderModelMap === 'function') await renderModelMap();
  renderClaudeCodeConfigList(platformInfoOf('claude-code') || {});
  renderPlatformProviderOptions();
  return true;
}

async function saveClaudeCodeConfigEditor(switchAfter = false) {
  const editId = String(document.getElementById('claude-code-config-edit-id')?.value || '').trim();
  const sourceId = String(document.getElementById('claude-code-config-source-id')?.value || '').trim();
  const name = String(document.getElementById('claude-code-config-name')?.value || '').trim();
  let baseUrl = String(document.getElementById('claude-code-config-base-url')?.value || '').trim();
  let apiKey = String(document.getElementById('claude-code-config-api-key')?.value || '').trim();
  let defaultModel = String(document.getElementById('claude-code-config-model')?.value || '').trim();
  let settingsConfig = null;
  try {
    settingsConfig = claudeCodeConfigObjectFromRawOrFields();
  } catch (e) {
    showCustomAlert(`原始配置 JSON 格式无效：${e}`, '配置不完整', 'warn');
    return;
  }
  const validation = claudeCodeValidateSettingsConfig(settingsConfig);
  if (validation) {
    showCustomAlert(validation, '配置不完整', 'warn');
    return;
  }
  settingsConfig = claudeCodeNormalizeSettingsConfig(settingsConfig, baseUrl, apiKey, defaultModel);
  const env = settingsConfig && typeof settingsConfig === 'object' ? settingsConfig.env || {} : {};
  baseUrl = claudeCodeBaseUrlFromEnv(env) || baseUrl;
  apiKey = claudeCodeApiKeyFromSettings(settingsConfig) || apiKey;
  defaultModel = claudeCodeEnvModel(settingsConfig) || defaultModel;
  const models = codexConfigNormalizeModels([
    ...claudeCodeModelCandidatesFromEnv(env),
    ...codexConfigParseModels(document.getElementById('claude-code-config-models')?.value, defaultModel),
  ], defaultModel);

  if (!editId && !sourceId) {
    showCustomAlert('请先选择一个现有供应商。', '没有配置来源', 'warn');
    return;
  }
  if (!name || !baseUrl || !apiKey || !defaultModel) {
    showCustomAlert('请填写配置名称、Base URL、API Key 和默认模型。', '配置不完整', 'warn');
    return;
  }
  if (!models.length) {
    showCustomAlert('请至少填写一个模型。', '配置不完整', 'warn');
    return;
  }

  const endpoint = claudeCodeConfigEndpointParts(baseUrl);
  const existing = editId ? claudeCodeConfigProviderById(editId) : null;
  const source = sourceId
    ? (providerStore.providers || []).find(p => p && p.id === sourceId)
    : null;
  const provider = {
    ...(existing || {}),
    id: editId || `claude-code-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1/messages',
    apiKey,
    defaultModel,
    models,
    settingsConfig,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  if (!Array.isArray(providerStore.claudeCodeConfigs)) providerStore.claudeCodeConfigs = [];
  if (editId) {
    const idx = providerStore.claudeCodeConfigs.findIndex(p => p.id === editId);
    if (idx >= 0) providerStore.claudeCodeConfigs[idx] = provider;
    else providerStore.claudeCodeConfigs.push(provider);
  } else {
    providerStore.claudeCodeConfigs.push(provider);
  }

  const ok = await syncClaudeCodeConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderClaudeCodeConfigList(platformInfoOf('claude-code') || {});
    return;
  }
  closeClaudeCodeConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 Claude Code 配置: ${name}`);
  if (switchAfter) await applyClaudeCodeProviderConfig(provider.id);
}

function editClaudeCodeProviderConfig(providerId) {
  const provider = claudeCodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  openClaudeCodeConfigEditor(providerId);
}

async function deleteClaudeCodeProviderConfig(providerId) {
  const provider = claudeCodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('claude-code');
  if (claudeCodeProviderIsCurrent(provider, info)) {
    showCustomAlert('当前正在使用的配置不能直接删除，请先切换到其他配置或官方配置。', '无法删除当前配置', 'warn');
    return;
  }
  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  providerStore.claudeCodeConfigs = (providerStore.claudeCodeConfigs || []).filter(p => p.id !== providerId);
  const ok = await syncClaudeCodeConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderClaudeCodeConfigList(platformInfoOf('claude-code') || {});
    return;
  }
  if (typeof addLog === 'function') addLog('info', `已删除 Claude Code 配置: ${provider.name || provider.id}`);
}

function renderClaudeCodeConfigList(info) {
  const list = document.getElementById('platform-claude-code-config-list');
  if (!list) return;

  const providers = platformProviderList('claude-code');
  const config = (info && info.claudeConfig) || {};
  const items = [];

  items.push({
    platformId: 'claude-code',
    name: 'Anthropic 官方配置',
    description: '使用 Claude Code 官方登录态，不写入第三方地址和 token。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: !!config.isOfficial || (!info.currentProviderId && !config.baseUrl),
    model: config.isOfficial && config.model ? config.model : '官方默认',
    endpoint: '~/.claude/settings.json',
    protocol: 'anthropic',
    action: 'restoreClaudeCodeOfficialConfig()',
  });

  const claudeLocalCard = platformLocalProxyCard('claude-code', info);
  if (claudeLocalCard) items.push(claudeLocalCard);

  const isExternal = !!info.currentProviderId && !config.isOfficial && !info.managedByAnyBridge
    && !providers.some(provider => claudeCodeProviderIsCurrent(provider, info));
  if (isExternal) {
    items.push({
      platformId: 'claude-code',
      name: info.currentProviderName || '当前外部配置',
      description: '由其他工具或手动配置写入。可以保留，也可以切换到下方任一配置。',
      typeLabel: '外部',
      tone: 'third external',
      current: true,
      model: config.model || '未知模型',
      endpoint: config.baseUrl || info.currentProviderId,
      protocol: 'anthropic',
    });
  }

  providers.forEach(provider => {
    const baseUrl = claudeCodeTargetBaseUrl(provider);
    const current = claudeCodeProviderIsCurrent(provider, info);
    items.push({
      platformId: 'claude-code',
      name: provider.name || provider.id,
      description: '第三方 Anthropic API 兼容配置。',
      typeLabel: '第三方',
      tone: 'third',
      current,
      model: provider.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: 'anthropic',
      action: `applyClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
      editAction: `editClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
      deleteAction: current ? '' : `deleteClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
    });
  });

  const filtered = items.filter(claudeCodeConfigMatchesSearch);
  const count = document.getElementById('claude-code-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

function onClaudeCodeConfigSearch() {
  const input = document.getElementById('claude-code-config-search');
  claudeCodeConfigSearch = input ? input.value : '';
  const info = platformInfoOf('claude-code');
  if (info) renderClaudeCodeConfigList(info);
}

function opencodeConfigProviderById(id) {
  return (providerStore.opencodeConfigs || []).find(p => p && p.id === id) || null;
}

function opencodeConfigSourceProviders() {
  return (providerStore.providers || []).filter(p =>
    p &&
    p.enabled !== false &&
    !isBuiltinProvider(p)
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

  const picked = sources.some(p => p.id === selectedId) ? selectedId : sources[0].id;
  list.innerHTML = sources.map(p => {
    const active = p.id === picked;
    const name = p.name || p.id;
    const endpoint = opencodeConfigDisplayBaseUrl(p) || 'Base URL 未设置';
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
  const btn = document.getElementById('opencode-config-fetch-models-btn');
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
  btn.textContent = loading ? '拉取中...' : '拉取模型列表';
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
  const source = models || codexConfigParseModels(document.getElementById('opencode-config-models')?.value, defaultModel);
  if (!source.length) {
    list.innerHTML = '<div class="codex-config-model-empty">还没有模型，点击右上角按钮拉取。</div>';
    return;
  }
  list.innerHTML = source.map(model => `
    <button type="button" class="codex-config-model-option ${model === defaultModel ? 'active' : ''}" data-model="${platformEsc(model)}" title="${platformEsc(model)}" role="radio" aria-checked="${model === defaultModel ? 'true' : 'false'}">
      <span>${platformEsc(model)}</span>
    </button>
  `).join('');
  list.setAttribute('role', 'radiogroup');
  list.onclick = (event) => {
    const item = event.target.closest('.codex-config-model-option');
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
  const seq = ++opencodeConfigModelFetchSeq;
  const baseUrl = String(document.getElementById('opencode-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('opencode-config-api-key')?.value || '').trim();
  if (!baseUrl || !apiKey) {
    showCustomAlert('请先填写 Base URL 和 API Key。', '无法拉取模型', 'warn');
    return;
  }

  opencodeConfigSetFetchLoading(true);
  opencodeConfigSetModelStatus('正在拉取模型列表...', 'loading');
  try {
    const endpoint = opencodeConfigEndpointParts(baseUrl);
    const result = await invoke('fetch_models', {
      args: {
        host: endpoint.apiHost,
        api_key: apiKey,
        api_format: 'openai',
        path: endpoint.apiPath || '/v1',
      }
    });
    if (seq !== opencodeConfigModelFetchSeq) return;
    const models = codexConfigNormalizeModels(result?.models || []);
    if (!models.length) throw new Error('接口返回的模型列表为空');
    const current = String(document.getElementById('opencode-config-model')?.value || '').trim();
    const picked = current && models.includes(current) ? current : models[0];
    opencodeConfigSetModels(models, picked, `已拉取 ${models.length} 个模型`);
    syncOpenCodeRawConfigFromFields();
    if (typeof addLog === 'function') addLog('ok', `OpenCode 配置模型拉取成功: ${models.length} 个`);
  } catch (e) {
    if (seq !== opencodeConfigModelFetchSeq) return;
    opencodeConfigSetModelStatus('拉取失败，可手动输入默认模型', 'error');
    if (typeof addLog === 'function') addLog('warn', `OpenCode 配置模型拉取失败: ${e}`);
    showCustomAlert(String(e), '模型拉取失败', 'error');
  } finally {
    if (seq === opencodeConfigModelFetchSeq) opencodeConfigSetFetchLoading(false);
  }
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

function openOpenCodeProviderAdd() {
  openOpenCodeConfigEditor('');
}

function openOpenCodeConfigEditor(providerId = '') {
  const provider = providerId ? opencodeConfigProviderById(providerId) : null;
  if (providerId && !provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  opencodeConfigEditorMode = provider ? 'edit' : 'create';
  const modal = document.getElementById('opencode-config-modal');
  const title = document.getElementById('opencode-config-modal-title');
  const sub = document.getElementById('opencode-config-modal-sub');
  const sourceWrap = document.getElementById('opencode-config-source-wrap');
  const layout = document.getElementById('opencode-config-editor-layout');
  const models = codexConfigModelList(provider);

  if (title) title.textContent = provider ? '编辑 OpenCode 配置' : '添加 OpenCode 配置';
  if (sub) sub.textContent = provider
    ? `正在编辑「${provider.name || provider.id}」这份 OpenCode 配置。`
    : '从现有 OpenAI 供应商创建一份独立 OpenCode provider 配置。';
  if (sourceWrap) sourceWrap.classList.toggle('is-hidden', !!provider);
  if (layout) {
    layout.classList.toggle('is-editing', !!provider);
    layout.classList.toggle('is-creating', !provider);
  }

  codexConfigSetInputValue('opencode-config-edit-id', provider?.id || '');
  if (provider) {
    codexConfigSetInputValue('opencode-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('opencode-config-name', provider.name || '');
    codexConfigSetInputValue('opencode-config-base-url', opencodeConfigDisplayBaseUrl(provider));
    codexConfigSetInputValue('opencode-config-api-key', provider.apiKey || '');
    codexConfigSetInputValue('opencode-config-model', provider.defaultModel || models[0] || '');
    opencodeConfigSetModels(models, provider.defaultModel || models[0] || '', models.length ? `已保存 ${models.length} 个模型` : '可重新拉取模型列表');
    opencodeSetRawSettings(opencodeBuildSettingsForProvider(provider, models));
  } else {
    codexConfigSetInputValue('opencode-config-name', '');
    codexConfigSetInputValue('opencode-config-base-url', '');
    codexConfigSetInputValue('opencode-config-api-key', '');
    codexConfigSetInputValue('opencode-config-model', '');
    opencodeConfigSetModels([], '', '选择供应商后拉取模型列表');
    const picked = renderOpenCodeConfigSourceList('');
    if (picked) applyOpenCodeConfigSource(picked);
    else syncOpenCodeRawConfigFromFields();
  }

  if (modal) modal.classList.add('active');
  window.setTimeout(() => {
    const target = provider
      ? document.getElementById('opencode-config-name')
      : document.querySelector('#opencode-config-source-list .codex-config-source-item.active');
    target?.focus();
  }, 30);
}

function closeOpenCodeConfigEditor() {
  document.getElementById('opencode-config-modal')?.classList.remove('active');
}

async function syncOpenCodeConfigUiAfterStoreChange() {
  if (typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) return false;
  }
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
  if (typeof renderModelMap === 'function') await renderModelMap();
  renderOpenCodeConfigList(platformInfoOf('opencode') || {});
  renderPlatformProviderOptions();
  return true;
}

async function saveOpenCodeConfigEditor(addAfter = false) {
  const editId = String(document.getElementById('opencode-config-edit-id')?.value || '').trim();
  const sourceId = String(document.getElementById('opencode-config-source-id')?.value || '').trim();
  let name = String(document.getElementById('opencode-config-name')?.value || '').trim();
  let baseUrl = String(document.getElementById('opencode-config-base-url')?.value || '').trim();
  let apiKey = String(document.getElementById('opencode-config-api-key')?.value || '').trim();
  let defaultModel = String(document.getElementById('opencode-config-model')?.value || '').trim();
  let settingsConfig = null;
  try {
    settingsConfig = opencodeConfigObjectFromRawOrFields();
  } catch (e) {
    showCustomAlert(`原始配置 JSON 格式无效：${e}`, '配置不完整', 'warn');
    return;
  }
  const validation = opencodeValidateSettingsConfig(settingsConfig);
  if (validation) {
    showCustomAlert(validation, '配置不完整', 'warn');
    return;
  }

  const options = settingsConfig.options && typeof settingsConfig.options === 'object' ? settingsConfig.options : {};
  const modelKeys = opencodeModelKeysFromSettings(settingsConfig);
  name = opencodeConfigNameFromSettings(settingsConfig) || name;
  baseUrl = opencodeBaseUrlFromOptions(options).trim() || baseUrl;
  apiKey = opencodeApiKeyFromOptions(options).trim() || apiKey;
  defaultModel = modelKeys.includes(defaultModel) ? defaultModel : modelKeys[0] || defaultModel;
  const models = codexConfigParseModels(modelKeys.length ? modelKeys.join('\n') : document.getElementById('opencode-config-models')?.value, defaultModel);
  settingsConfig = opencodeNormalizeSettingsConfig(settingsConfig, name, baseUrl, apiKey, models);

  if (!editId && !sourceId) {
    showCustomAlert('请先选择一个现有供应商。', '没有配置来源', 'warn');
    return;
  }
  if (!name || !baseUrl || !apiKey || !defaultModel) {
    showCustomAlert('请填写配置名称、Base URL、API Key 和默认模型。', '配置不完整', 'warn');
    return;
  }
  if (!models.length) {
    showCustomAlert('请至少填写一个模型。', '配置不完整', 'warn');
    return;
  }

  const endpoint = opencodeConfigEndpointParts(baseUrl);
  const existing = editId ? opencodeConfigProviderById(editId) : null;
  const source = sourceId
    ? (providerStore.providers || []).find(p => p && p.id === sourceId)
    : null;
  const provider = {
    ...(existing || {}),
    id: editId || `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1',
    apiKey,
    defaultModel,
    models,
    settingsConfig,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  if (!Array.isArray(providerStore.opencodeConfigs)) providerStore.opencodeConfigs = [];
  if (editId) {
    const idx = providerStore.opencodeConfigs.findIndex(p => p.id === editId);
    if (idx >= 0) providerStore.opencodeConfigs[idx] = provider;
    else providerStore.opencodeConfigs.push(provider);
  } else {
    providerStore.opencodeConfigs.push(provider);
  }

  const ok = await syncOpenCodeConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderOpenCodeConfigList(platformInfoOf('opencode') || {});
    return;
  }
  closeOpenCodeConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 OpenCode 配置: ${name}`);
  if (addAfter) await applyOpenCodeProviderConfig(provider.id);
}

function editOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法编辑', 'warn');
    return;
  }
  openOpenCodeConfigEditor(providerId);
}

async function deleteOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('opencode');
  if (openCodeProviderIsLive(provider, info)) {
    showCustomAlert('这份配置已加入 OpenCode live 配置，请先从 OpenCode 移除后再删除。', '无法删除已加入配置', 'warn');
    return;
  }
  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  providerStore.opencodeConfigs = (providerStore.opencodeConfigs || []).filter(p => p.id !== providerId);
  const ok = await syncOpenCodeConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderOpenCodeConfigList(platformInfoOf('opencode') || {});
    return;
  }
  if (typeof addLog === 'function') addLog('info', `已删除 OpenCode 配置: ${provider.name || provider.id}`);
}

function renderOpenCodeConfigList(info) {
  const list = document.getElementById('platform-opencode-config-list');
  if (!list) return;

  const providers = platformProviderList('opencode');
  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  const items = [];
  const opencodeLocalCard = platformLocalProxyCard('opencode', info);
  if (opencodeLocalCard) items.push(opencodeLocalCard);

  liveIds
    .filter(id => !providers.some(provider => provider.id === id))
    .forEach(id => {
      const active = info?.currentProviderId === id;
      items.push({
        platformId: 'opencode',
        name: id,
        description: '由其他工具或手动配置写入。AnyBridge 不会修改这份外部配置。',
        typeLabel: active ? '当前使用' : '外部',
        tone: active ? 'third live' : 'third external',
        current: active,
        currentLabel: '当前使用',
        model: '外部配置',
        endpoint: '~/.config/opencode/opencode.json',
        protocol: 'openai-compatible',
      });
    });

  providers.forEach(provider => {
    const baseUrl = opencodeTargetBaseUrl(provider);
    const live = openCodeProviderIsLive(provider, info);
    const active = info?.currentProviderId === provider.id;
    items.push({
      platformId: 'opencode',
      name: provider.name || provider.id,
      description: '独立 OpenCode provider 配置，应用时追加到 opencode.json 并可设为当前 model。',
      typeLabel: active ? '当前使用' : (live ? '已加入' : '配置'),
      tone: active ? 'third live' : 'third',
      current: active,
      currentLabel: '当前使用',
      model: provider.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: 'openai-compatible',
      action: `applyOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      actionLabel: live ? '设为当前' : '加入并设为当前',
      editAction: `editOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      deleteAction: live ? '' : `deleteOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      removeAction: live ? `removeOpenCodeProviderConfig(${platformJsArg(provider.id)})` : '',
      removeLabel: '移除',
    });
  });

  const filtered = items.filter(opencodeConfigMatchesSearch);
  const count = document.getElementById('opencode-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="codex-table-empty">没有匹配的配置</div>';
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
}

function onOpenCodeConfigSearch() {
  const input = document.getElementById('opencode-config-search');
  opencodeConfigSearch = input ? input.value : '';
  const info = platformInfoOf('opencode');
  if (info) renderOpenCodeConfigList(info);
}

async function applyOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法加入', 'error');
    return;
  }

  const model = provider.defaultModel || '默认模型';
  const baseUrl = opencodeTargetBaseUrl(provider);
  const info = platformInfoOf('opencode') || {};
  const live = openCodeProviderIsLive(provider, info);
  const ok = await showCustomConfirm(
    `将把 OpenCode 配置「${provider.name || provider.id}」${live ? '设为当前 model' : '加入 live provider 列表，并设为当前 model'}。\n\n模型：${model}\n地址：${baseUrl}\n\n不会覆盖其他 OpenCode provider。新会话或重启 OpenCode 后生效。`,
    live ? '设为当前 OpenCode 配置' : '加入并设为当前',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy('opencode', true);
  showSwitchProgress('opencode', live ? '正在准备设置当前 OpenCode 配置…' : '正在准备加入 OpenCode 配置…');
  try {
    const result = await invoke('switch_platform', { platform: 'opencode', providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'OpenCode 配置已设置');
    showCustomAlert(result.message || 'OpenCode 配置已设置。', '设置完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `OpenCode 配置设置失败: ${e}`);
    showCustomAlert(String(e), '设置失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('opencode', false);
    renderPlatformDetailStatuses();
  }
}

async function removeOpenCodeProviderConfig(providerId) {
  const provider = opencodeConfigProviderById(providerId);
  const label = provider?.name || providerId;
  const ok = await showCustomConfirm(
    `将从 OpenCode live 配置移除「${label}」。\n\n保存的 OpenCode 配置方案仍会保留，可稍后重新加入。`,
    '移除 OpenCode 配置',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy('opencode', true);
  try {
    const result = await invoke('remove_opencode_config_from_live', { providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || '已从 OpenCode 移除配置');
    showCustomAlert(result.message || '已从 OpenCode 移除配置。', '移除完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `OpenCode 移除失败: ${e}`);
    showCustomAlert(String(e), '移除失败', 'error');
  } finally {
    setPlatformBusy('opencode', false);
    renderPlatformDetailStatuses();
  }
}

async function restoreClaudeCodeOfficialConfig() {
  const info = platformInfoOf('claude-code') || {};
  const alreadyOfficial = !!(info.claudeConfig && info.claudeConfig.isOfficial);
  const message = alreadyOfficial
    ? 'Claude Code 当前已经是官方配置。仍要清理 AnyBridge 写入的 ANTHROPIC_* env 字段吗？'
    : '将把 Claude Code 切回官方配置。\n\n这会移除 AnyBridge 写入的 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 和模型 env 字段，但会保留 MCP、权限、hooks、语言等其他配置。切换后需要重启 Claude Code 才会生效。';
  const ok = await showCustomConfirm(message, '切回官方配置', 'warn');
  if (!ok) return;

  setPlatformBusy('claude-code', true);
  showSwitchProgress('claude-code', '正在准备切回官方配置…');
  try {
    const result = await invoke('restore_claude_official_config');
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Claude Code 已切回官方配置');
    showCustomAlert(result.message || 'Claude Code 已切回官方配置。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Claude Code 切回官方失败: ${e}`);
    showCustomAlert(String(e), '切回官方失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('claude-code', false);
    renderPlatformDetailStatuses();
  }
}

async function applyClaudeCodeProviderConfig(providerId) {
  const provider = platformProviderList('claude-code').find(p => p.id === providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法切换', 'error');
    return;
  }

  const info = platformInfoOf('claude-code') || {};
  const from = info.currentProviderName || info.currentProviderId || '当前配置';
  const to = provider.name || provider.id || '目标配置';
  const model = provider.defaultModel || '默认模型';
  const baseUrl = claudeCodeTargetBaseUrl(provider);
  const message = `将把 Claude Code 从「${from}」切换到「${to}」。\n\n模型：${model}\n地址：${baseUrl}\n\n只会合并写入 settings.json 的 env 字段，原有 MCP、权限、hooks、语言等配置会保留。切换后需要重启 Claude Code 才会生效。`;
  const ok = await showCustomConfirm(message, '切换 Claude Code 配置', 'warn');
  if (!ok) return;

  setPlatformBusy('claude-code', true);
  showSwitchProgress('claude-code', '正在准备切换 Claude Code 配置…');
  try {
    const result = await invoke('switch_platform', { platform: 'claude-code', providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Claude Code 配置已切换');
    showCustomAlert(result.message || 'Claude Code 配置已切换。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Claude Code 切换失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('claude-code', false);
    renderPlatformDetailStatuses();
  }
}

function onCodexConfigSearch() {
  const input = document.getElementById('codex-config-search');
  codexConfigSearch = input ? input.value : '';
  const info = platformInfoOf('codex');
  if (info) renderCodexConfigList(info);
}

async function applyCodexProviderConfig(providerId) {
  const provider = codexConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法切换', 'error');
    return;
  }

  const flow = await runSwitchFlow({
    title: '切换 Codex 配置',
    lead: codexApplyConfirmMessage(provider),
    confirmText: '确认切换',
    platform: 'codex',
    runningMessage: '正在准备切换 Codex 配置…',
    successTitle: '切换完成',
    failureTitle: '切换失败',
    skipConfirm: false,
    task: async ({ setMessage }) => {
      setPlatformBusy('codex', true);
      try {
        setMessage('正在写入 Codex 配置…');
        const result = assertSwitchResultOk(
          await invoke('switch_platform', { platform: 'codex', providerId }),
          'Codex 配置切换失败'
        );
        if (typeof loadProviders === 'function') await loadProviders();
        await refreshPlatforms({ silent: true });

        setMessage('正在重启 Codex 桌面版并注入自定义模型…');
        const restart = assertSwitchResultOk(
          await invoke('restart_codex_desktop', { managed: true, model: provider.defaultModel || null, injectModels: provider.injectModels !== false }),
          'Codex 桌面版重启或注入失败'
        );

        if (typeof addLog === 'function') {
          addLog('ok', result.message || 'Codex 配置已切换');
          addLog('ok', restart.message || 'Codex 桌面版已重启并完成注入');
        }
        return {
          message: `${result.message || 'Codex 配置已切换。'}\n\n${restart.message || 'Codex 桌面版已重启并完成注入。'}`
        };
      } finally {
        setPlatformBusy('codex', false);
        renderPlatformDetailStatuses();
      }
    }
  });
  if (flow.confirmed && !flow.ok && typeof addLog === 'function') {
    addLog('err', `Codex 切换失败: ${switchFlowErrorText(flow.error)}`);
  }
}

async function startCodexWithCdp(injectModels = false) {
  setPlatformBusy('codex', true);
  try {
    const result = await invoke('start_codex_with_cdp', { injectModels: !!injectModels });
    if (typeof addLog === 'function') addLog(result.ok ? 'ok' : 'err', result.message || '');
    showCustomAlert(
      (result.message || '').replace(/^Error:\s*/i, ''),
      result.ok ? '提示' : '启动失败',
      result.ok ? 'success' : 'error'
    );
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `启动 Codex 失败: ${e}`);
    showCustomAlert(String(e).replace(/^Error:\s*/i, ''), '启动失败', 'error');
  } finally {
    setPlatformBusy('codex', false);
  }
}

function openCodexProviderAdd() {
  openCodexConfigEditor('');
}

function renderPlatformProviderOptions() {
  Object.keys(PLATFORM_DEFS).forEach(platformId => {
    const select = document.getElementById(`platform-${platformId}-select`);
    const applyBtn = document.getElementById(`platform-${platformId}-apply`);
    if (!select) return;

    const info = platformInfoOf(platformId);
    const providers = platformProviderList(platformId);
    const previous = select.value || (info && info.currentProviderId) || '';

    if (!providers.length) {
      select.innerHTML = `<option value="">无可用 ${platformEsc(platformFormatLabel(platformDef(platformId).requiredApiFormat))} 供应商</option>`;
      select.value = '';
      if (applyBtn) applyBtn.disabled = true;
      platformSetText(`platform-${platformId}-preview`, '请先在「供应商」页添加并启用匹配协议的供应商。');
      if (platformId === 'codex') renderCodexTargetSummary(null, '请先添加 Codex 配置');
      return;
    }

    select.innerHTML = providers
      .map(p => `<option value="${platformEsc(p.id)}">${platformEsc(p.name)} · ${platformEsc(p.defaultModel || '默认模型未设置')}</option>`)
      .join('');
    select.value = providers.some(p => p.id === previous) ? previous : providers[0].id;
    if (platformId === 'codex') {
      renderCodexTargetSummary(providers.find(p => p.id === select.value) || providers[0]);
    }
    onPlatformProviderChange(platformId);
  });
}

// ═══════ Cursor BYOK Console ═══════

let cursorConsoleBusy = false;

function cursorPageRoot() {
  return document.getElementById('page-platform-cursor');
}

function cursorEnsureBridge() {
  if (!invoke && typeof bindTauriBridge === 'function') bindTauriBridge();
  if (!invoke) throw new Error('Tauri 通道未就绪，Cursor 接入操作不可用。请从安装包版本启动，或重启应用后重试。');
}

function cursorSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function cursorSetCard(kind, tone, state, detail) {
  const card = document.getElementById(`cursor-card-${kind}`);
  if (card) {
    card.classList.remove('ok', 'warn', 'err');
    if (tone) card.classList.add(tone);
  }
  cursorSetText(`cursor-${kind}-state`, state || '未知');
  cursorSetText(`cursor-${kind}-detail`, detail || '');
}

function cursorSetBusy(busy) {
  cursorConsoleBusy = !!busy;
  const root = cursorPageRoot();
  if (!root) return;
  root
    .querySelectorAll('.cursor-primary-action, .cursor-mini-btn, .cursor-step-action, .cursor-card-action, .cursor-hero-actions .btn-ghost')
    .forEach(btn => { btn.disabled = !!busy; });
}

function cursorIssueList(report) {
  return report && Array.isArray(report.issues) ? report.issues : [];
}

function cursorIssueMatches(issue, prefixes) {
  const code = String(issue?.code || '');
  return prefixes.some(prefix => code === prefix || code.startsWith(prefix));
}

function cursorIssueDetail(issues, prefixes, fallback) {
  const matched = issues.filter(issue => cursorIssueMatches(issue, prefixes));
  const ranked = matched
    .filter(issue => issue.level === 'err')
    .concat(matched.filter(issue => issue.level === 'warn'))
    .concat(matched.filter(issue => issue.level === 'ok'));
  const messages = ranked
    .map(issue => String(issue.message || '').trim())
    .filter(Boolean)
    .slice(0, 2);
  return messages.length ? messages.join('；') : fallback;
}

function cursorIssueTone(issues, prefixes, okTone = 'ok') {
  const matched = issues.filter(issue => cursorIssueMatches(issue, prefixes));
  if (matched.some(issue => issue.level === 'err')) return 'err';
  if (matched.some(issue => issue.level === 'warn')) return 'warn';
  return okTone;
}

function cursorReportErrorMessage(e) {
  return String(e?.message || e || '未知错误');
}

function cursorExtractReport(result) {
  if (result && result.status === 'fulfilled') return result.value;
  throw new Error(cursorReportErrorMessage(result && result.reason));
}

async function cursorRefreshConsole() {
  const root = cursorPageRoot();
  if (!root) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    cursorSetCard('proxy', '', '读取中', '正在读取 AnyBridge 服务状态');
    cursorSetCard('settings', '', '读取中', '正在检查 Cursor settings.json');
    cursorSetCard('auth', '', '读取中', '正在检查 state.vscdb 和模型路由');
    cursorSetCard('cert', '', '读取中', '正在检查证书和系统信任状态');

    const [proxyResult, ideResult, preflightResult, certResult] = await Promise.allSettled([
      invoke('get_proxy_status'),
      typeof refreshIdeProxyStatus === 'function' ? refreshIdeProxyStatus('cursor') : invoke('get_ide_proxy_status', { target: 'cursor' }),
      invoke('preflight_proxy', { targetIde: 'cursor' }),
      invoke('cert_check_status')
    ]);

    let report = null;
    try {
      report = cursorExtractReport(preflightResult);
    } catch (e) {
      cursorSetCard('auth', 'err', '体检失败', cursorReportErrorMessage(e));
      if (typeof addLog === 'function') addLog('err', 'Cursor 环境体检失败: ' + e);
    }
    const issues = cursorIssueList(report);

    try {
      const proxy = cursorExtractReport(proxyResult) || {};
      const running = !!proxy.running;
      const target = proxy.target_ide || proxy.targetIde || '';
      const targetLabel = target ? (typeof ideDisplayLabel === 'function' ? ideDisplayLabel(target) : target) : '未绑定 IDE';
      const port = proxy.api_port || proxy.apiPort || (typeof getLocalProxyPort === 'function' ? getLocalProxyPort() : 7450);
      if (!running) {
        cursorSetCard('proxy', 'warn', '未启动', `本机代理未运行，Cursor 请求还不会进入 AnyBridge。API 端口 ${port}`);
      } else if (target && target !== 'cursor') {
        cursorSetCard('proxy', 'warn', '运行中', `代理已启动，但当前服务目标是 ${targetLabel}。建议从 Cursor 页重新接入。`);
      } else {
        cursorSetCard('proxy', 'ok', '运行中', `AnyBridge 代理已就绪。API 端口 ${port}`);
      }
    } catch (e) {
      cursorSetCard('proxy', 'err', '读取失败', cursorReportErrorMessage(e));
      if (typeof addLog === 'function') addLog('err', 'Cursor 本地代理状态读取失败: ' + e);
    }

    try {
      const ide = cursorExtractReport(ideResult) || {};
      if (ide.patched) {
        const strict = ide.strictSsl === false || ide.strict_ssl === false ? 'StrictSSL 已关闭' : 'StrictSSL 待确认';
        cursorSetCard('settings', 'ok', '已接入', `${strict}；${ide.proxyValue || ide.proxy_value || '已写入 AnyBridge 代理'}`);
      } else {
        const detail = cursorIssueDetail(issues, ['ide_settings.'], ide.settingsPath || ide.settings_path || 'Cursor 尚未写入 AnyBridge 代理配置');
        cursorSetCard('settings', cursorIssueTone(issues, ['ide_settings.'], 'warn'), '未接入', detail);
      }
    } catch (e) {
      cursorSetCard('settings', 'err', '读取失败', cursorReportErrorMessage(e));
      if (typeof addLog === 'function') addLog('err', 'Cursor 配置状态读取失败: ' + e);
    }

    if (report) {
      const authPrefixes = ['cursor.', 'model_map.', 'route.', 'providers.'];
      const authTone = cursorIssueTone(issues, authPrefixes);
      const authDetail = cursorIssueDetail(issues, authPrefixes, 'Cursor state.vscdb、默认模型和模型路由已通过检查');
      cursorSetCard('auth', authTone, authTone === 'ok' ? '就绪' : (authTone === 'warn' ? '有提示' : '未就绪'), authDetail);
    }

    try {
      const cert = cursorExtractReport(certResult) || {};
      const store = cert.effective_store || cert.effectiveStore || 'none';
      if (!cert.cert_exists && cert.certExists === undefined) cert.certExists = false;
      const certExists = cert.cert_exists ?? cert.certExists;
      const keyExists = cert.key_exists ?? cert.keyExists;
      const sanCurrent = cert.san_current ?? cert.sanCurrent;
      const trusted = store === 'current_user' || store === 'local_machine' || cert.current_user || cert.currentUser || cert.local_machine || cert.localMachine;
      const detail = cert.message || cursorIssueDetail(issues, ['cert.', 'certs.'], '证书状态已读取');
      if (!certExists || !keyExists || !trusted) {
        cursorSetCard('cert', 'err', '需安装', detail);
      } else if (!sanCurrent) {
        cursorSetCard('cert', 'warn', '需更新', detail);
      } else {
        cursorSetCard('cert', 'ok', '已信任', detail);
      }
    } catch (e) {
      cursorSetCard('cert', 'err', '读取失败', cursorReportErrorMessage(e));
      if (typeof addLog === 'function') addLog('err', 'Cursor 证书状态读取失败: ' + e);
    }
  } finally {
    cursorSetBusy(false);
  }
}

async function cursorStartProxy() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    try {
      await invoke('start_proxy_service');
      if (typeof addLog === 'function') addLog('ok', 'Cursor: 本地代理服务已启动');
    } catch (e) {
      if (String(e).includes('代理已在运行')) {
        if (typeof addLog === 'function') addLog('warn', 'Cursor: 本地代理服务已在运行');
      } else {
        throw e;
      }
    }
    if (typeof refreshStatus === 'function') await refreshStatus();
    await cursorRefreshConsole();
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 启动代理失败: ' + e);
    showCustomAlert(String(e), '启动失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

async function cursorSwitchToProxy() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    let proxy = await invoke('get_proxy_status');
    if (!proxy?.running) {
      try {
        await invoke('start_proxy_service');
        if (typeof addLog === 'function') addLog('ok', 'Cursor: 本地代理服务已自动启动');
      } catch (e) {
        if (!String(e).includes('代理已在运行')) throw new Error('自动启动本地代理失败: ' + e);
      }
      if (typeof refreshStatus === 'function') await refreshStatus();
      proxy = await invoke('get_proxy_status');
    }

    const report = await invoke('switch_ide_to_proxy', { target: 'cursor' });
    if (typeof refreshIdeProxyStatus === 'function') await refreshIdeProxyStatus('cursor');
    if (typeof setStatusPill === 'function') setStatusPill(!!proxy?.running, proxy);
    if (typeof addLog === 'function') {
      addLog('ok', 'Cursor 已切换到 AnyBridge 本机代理');
      if (report?.cursorAuth) addLog(String(report.cursorAuth).startsWith('ok') ? 'ok' : 'warn', 'Cursor 状态写入: ' + report.cursorAuth);
      if (report?.ideConfig) addLog(String(report.ideConfig).startsWith('ok') || report.ideConfig === 'updated' ? 'ok' : 'warn', 'Cursor settings 写入: ' + report.ideConfig);
    }
    await cursorRefreshConsole();
    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('Cursor 已接入 AnyBridge，本机代理已启动。重启 Cursor 后会重新读取代理和 BYOK 状态。', 'cursor', { mode: 'proxy' });
    } else {
      showCustomAlert('Cursor 已接入 AnyBridge。请重启 Cursor 使配置生效。', '接入完成', 'success');
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 一键接入失败: ' + e);
    showCustomAlert(String(e), '接入失败', 'error');
    await cursorRefreshConsole().catch(() => {});
  } finally {
    cursorSetBusy(false);
  }
}

async function cursorRestoreDirect() {
  if (cursorConsoleBusy) return;
  const ok = await showCustomConfirm('将把 Cursor 的 settings.json 和 state.vscdb 从 AnyBridge 接入状态还原为直连状态。全局代理服务不会停止。', '还原 Cursor 直连', 'warn');
  if (!ok) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    const report = await invoke('restore_ide_direct', { target: 'cursor' });
    if (typeof refreshIdeProxyStatus === 'function') await refreshIdeProxyStatus('cursor');
    const warnings = [];
    if (report?.ideConfig && !String(report.ideConfig).startsWith('ok')) warnings.push('配置: ' + report.ideConfig);
    if (report?.cursorAuth && !String(report.cursorAuth).startsWith('ok')) warnings.push('状态: ' + report.cursorAuth);
    await cursorRefreshConsole();
    if (warnings.length) {
      if (typeof addLog === 'function') addLog('warn', 'Cursor 还原直连完成但有提示: ' + warnings.join('；'));
      showCustomAlert(warnings.join('\n'), '还原提示', 'warn');
    } else {
      if (typeof addLog === 'function') addLog('ok', 'Cursor 已还原直连');
      if (typeof promptRestartIde === 'function') {
        await promptRestartIde('Cursor 已还原直连。重启 Cursor 后会重新读取配置。', 'cursor', { mode: 'direct' });
      } else {
        showCustomAlert('Cursor 已还原直连。请重启 Cursor 使配置生效。', '还原完成', 'success');
      }
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 还原直连失败: ' + e);
    showCustomAlert(String(e), '还原失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

async function cursorRestartIde() {
  if (typeof restartIdeNow === 'function') {
    await restartIdeNow('cursor');
    return;
  }
  cursorEnsureBridge();
  try {
    const result = await invoke('restart_ide', { target: 'cursor' });
    if (typeof addLog === 'function') addLog('ok', result);
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 重启失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
  }
}

async function cursorRunHealthcheck() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    const result = typeof runEnvironmentCheck === 'function'
      ? await runEnvironmentCheck({ target: 'cursor', prefix: 'Cursor 环境体检' })
      : { report: await invoke('preflight_proxy', { targetIde: 'cursor' }) };
    const report = result.report || {};
    const issues = cursorIssueList(report);
    const errors = issues.filter(issue => issue.level === 'err');
    const warnings = issues.filter(issue => issue.level === 'warn');
    await cursorRefreshConsole();
    if (errors.length) {
      showCustomAlert(errors.map(issue => issue.message || String(issue)).join('\n'), 'Cursor 体检未通过', 'error');
    } else if (warnings.length) {
      showCustomAlert(warnings.map(issue => issue.message || String(issue)).join('\n'), 'Cursor 体检提示', 'warn');
    } else {
      showCustomAlert('Cursor 接入环境检查通过。', '体检通过', 'success');
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 环境检测失败: ' + e);
    showCustomAlert(String(e), '检测失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

async function cursorInstallCert() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    const result = await invoke('cert_install');
    if (typeof addLog === 'function') addLog('ok', 'Cursor 证书安装: ' + result);
    await cursorRefreshConsole();
    showCustomAlert(result || '证书已安装。', '证书完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Cursor 证书安装失败: ' + e);
    showCustomAlert(String(e), '证书失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

function cursorOpenProxyModels() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('routes');
  } else {
    navigateTo('proxy');
  }
}

function cursorOpenStats() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('overview');
  } else {
    navigateTo('proxy');
  }
}

function openPlatformPage(platformId) {
  navigateTo(`platform-${platformId}`);
  renderPlatformDetailStatuses();
  renderPlatformProviderOptions();
  if (platformId === 'cursor') {
    cursorRefreshConsole().catch(e => {
      if (typeof addLog === 'function') addLog('err', 'Cursor 控制台刷新失败: ' + e);
      showCustomAlert(String(e), 'Cursor 状态读取失败', 'error');
    });
  }
}

async function onPlatformProviderChange(platformId) {
  const select = document.getElementById(`platform-${platformId}-select`);
  const preview = document.getElementById(`platform-${platformId}-preview`);
  const applyBtn = document.getElementById(`platform-${platformId}-apply`);
  const providerId = select ? select.value : '';

  if (!preview) return;
  if (!providerId) {
    preview.textContent = '请选择供应商';
    if (applyBtn) applyBtn.disabled = true;
    if (platformId === 'codex') renderCodexTargetSummary(null);
    return;
  }

  const provider = platformProviderList(platformId).find(p => p.id === providerId);
  const def = platformDef(platformId);
  if (!provider) {
    preview.textContent = platformId === 'codex' ? 'Codex 配置不存在或尚未加载' : '供应商不存在或尚未加载';
    if (applyBtn) applyBtn.disabled = true;
    if (platformId === 'codex') renderCodexTargetSummary(null, 'Codex 配置不存在或尚未加载');
    return;
  }

  if (applyBtn) applyBtn.disabled = platformBusy === platformId;
  if (platformId === 'codex') renderCodexTargetSummary(provider);
  preview.textContent = '正在生成预览...';
  try {
    const text = await invoke('preview_platform_switch', { platform: platformId, providerId });
    preview.textContent = text || '无预览内容';
  } catch (e) {
    preview.textContent = '生成预览失败：' + e;
    if (applyBtn) applyBtn.disabled = true;
  }
}

function setPlatformBusy(platformId, busy) {
  platformBusy = busy ? platformId : null;
  ['apply', 'restore'].forEach(action => {
    const btn = document.getElementById(`platform-${platformId}-${action}`);
    if (btn) btn.disabled = busy;
  });
  if (platformId === 'codex') {
    document
      .querySelectorAll('.codex-row-action, .codex-add-config-btn, .codex-refresh-btn, .codex-restore-btn')
      .forEach(btn => { btn.disabled = busy; });
  }
  if (platformId === 'claude-code') {
    document
      .querySelectorAll('#page-platform-claude-code .codex-card-action, #page-platform-claude-code .codex-add-config-btn, #page-platform-claude-code .codex-refresh-btn, #page-platform-claude-code .codex-restore-btn')
      .forEach(btn => { btn.disabled = busy; });
  }
  if (platformId === 'opencode') {
    document
      .querySelectorAll('#page-platform-opencode .codex-card-action, #page-platform-opencode .codex-add-config-btn, #page-platform-opencode .codex-refresh-btn, #page-platform-opencode .codex-restore-btn')
      .forEach(btn => { btn.disabled = busy; });
  }
  const select = document.getElementById(`platform-${platformId}-select`);
  if (select) select.disabled = busy;
}

// ═══════ 切换进度提示 ═══════

let _switchProgressUnlisten = null;
let _switchProgressPlatform = null;
let _switchFlowState = null;

function switchFlowErrorText(e) {
  return String(e?.message || e || '未知错误');
}

function assertSwitchResultOk(result, fallbackMessage) {
  if (result && result.ok === false) {
    throw new Error(result.message || fallbackMessage || '操作失败');
  }
  return result;
}

async function runSwitchFlow(options) {
  const {
    title = '确认切换',
    lead = '',
    confirmText = '确定',
    platform,
    runningMessage = '正在处理…',
    successTitle = '切换完成',
    failureTitle = '切换失败',
    skipConfirm = false,
    task,
  } = options || {};

  if (_switchFlowState) {
    throw new Error('已有切换任务正在进行，请等待完成。');
  }
  if (typeof task !== 'function') {
    throw new Error('切换任务未配置。');
  }

  const modal = document.getElementById('custom-confirm-modal');
  const bodyEl = modal?.querySelector('.modal-body');
  const titleEl = document.getElementById('custom-confirm-title');
  const leadEl = document.getElementById('modal-lead');
  const questionEl = leadEl?.nextElementSibling;
  const warningEl = modal?.querySelector('.modal-warning');
  const btnCancel = document.getElementById('modal-btn-cancel');
  const btnConfirm = document.getElementById('modal-btn-confirm');
  if (!modal || !bodyEl || !titleEl || !leadEl || !btnCancel || !btnConfirm) {
    throw new Error('切换确认弹窗 DOM 未初始化。');
  }

  return new Promise((resolve) => {
    const prev = {
      title: titleEl.textContent,
      lead: leadEl.textContent,
      leadDisplay: leadEl.style.display,
      leadWhiteSpace: leadEl.style.whiteSpace,
      question: questionEl ? questionEl.textContent : '',
      questionDisplay: questionEl ? questionEl.style.display : '',
      warningDisplay: warningEl ? warningEl.style.display : '',
      cancelText: btnCancel.textContent,
      cancelDisplay: btnCancel.style.display,
      cancelDisabled: btnCancel.disabled,
      confirmText: btnConfirm.textContent,
      confirmDisplay: btnConfirm.style.display,
      confirmDisabled: btnConfirm.disabled,
      confirmWidth: btnConfirm.style.width,
      confirmMinWidth: btnConfirm.style.minWidth,
    };

    let flowResult = { confirmed: false };
    const flowEl = document.createElement('div');
    flowEl.className = 'switch-flow-state';
    flowEl.setAttribute('aria-live', 'polite');
    flowEl.style.display = 'none';
    bodyEl.appendChild(flowEl);

    const renderProgress = (message) => {
      flowEl.className = 'switch-flow-state is-running';
      flowEl.style.display = '';
      flowEl.innerHTML = `
        <span class="switch-progress-spinner" aria-hidden="true"></span>
        <span class="switch-flow-msg"></span>
      `;
      const msgEl = flowEl.querySelector('.switch-flow-msg');
      if (msgEl) msgEl.textContent = message || '正在处理…';
    };

    const setMessage = (message) => {
      if (!message) return;
      const msgEl = flowEl.querySelector('.switch-flow-msg');
      if (msgEl) msgEl.textContent = message;
    };

    const renderResult = (ok, message) => {
      titleEl.textContent = ok ? successTitle : failureTitle;
      leadEl.style.display = 'none';
      flowEl.className = `switch-flow-state is-result ${ok ? 'is-success' : 'is-error'}`;
      flowEl.style.display = '';
      flowEl.innerHTML = `
        <span class="switch-flow-icon" aria-hidden="true">${ok ? '✓' : '!'}</span>
        <span class="switch-flow-msg"></span>
      `;
      const msgEl = flowEl.querySelector('.switch-flow-msg');
      if (msgEl) msgEl.textContent = message || (ok ? '已完成。' : '操作失败。');
      btnCancel.style.display = 'none';
      btnConfirm.style.display = '';
      btnConfirm.disabled = false;
      btnConfirm.textContent = ok ? '完成' : '关闭';
      btnConfirm.style.minWidth = '88px';
      btnConfirm.addEventListener('click', onDone);
    };

    const flowState = {
      platform,
      setProgress: (message) => {
        if (message) setMessage(message);
      },
    };

    const cleanup = () => {
      modal.classList.remove('active');
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      btnConfirm.removeEventListener('click', onDone);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      if (_switchFlowState === flowState) _switchFlowState = null;
      flowEl.remove();
      titleEl.textContent = prev.title;
      leadEl.textContent = prev.lead;
      leadEl.style.display = prev.leadDisplay;
      leadEl.style.whiteSpace = prev.leadWhiteSpace;
      if (questionEl) {
        questionEl.textContent = prev.question;
        questionEl.style.display = prev.questionDisplay;
      }
      if (warningEl) warningEl.style.display = prev.warningDisplay;
      btnCancel.textContent = prev.cancelText;
      btnCancel.style.display = prev.cancelDisplay;
      btnCancel.disabled = prev.cancelDisabled;
      btnConfirm.textContent = prev.confirmText;
      btnConfirm.style.display = prev.confirmDisplay;
      btnConfirm.disabled = prev.confirmDisabled;
      btnConfirm.style.width = prev.confirmWidth;
      btnConfirm.style.minWidth = prev.confirmMinWidth;
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const start = async () => {
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      // skipConfirm 时 modal 可能还没 add active（确认态没显示）
      if (!modal.classList.contains('active')) modal.classList.add('active');
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onEsc);
      btnCancel.style.display = 'none';
      btnConfirm.style.display = 'none';
      btnCancel.disabled = true;
      btnConfirm.disabled = true;
      _switchFlowState = flowState;
      renderProgress(runningMessage);

      try {
        const result = await task({ setMessage });
        flowResult = { confirmed: true, ok: true, result };
        renderResult(true, result?.message || '已完成。');
      } catch (e) {
        flowResult = { confirmed: true, ok: false, error: e };
        renderResult(false, switchFlowErrorText(e));
      } finally {
        if (_switchFlowState === flowState) _switchFlowState = null;
      }
    };

    function onConfirm(e) {
      e.preventDefault();
      e.stopPropagation();
      start();
    }
    function onCancel(e) {
      e.preventDefault();
      e.stopPropagation();
      finish({ confirmed: false });
    }
    function onDone(e) {
      e.preventDefault();
      e.stopPropagation();
      finish(flowResult);
    }
    function onOverlay(e) {
      if (e.target === modal) finish({ confirmed: false });
    }
    function onEsc(e) {
      if (e.key === 'Escape' && modal.classList.contains('active')) finish({ confirmed: false });
    }

    titleEl.textContent = title;
    leadEl.textContent = lead;
    leadEl.style.display = '';
    leadEl.style.whiteSpace = 'pre-line';
    if (questionEl) {
      questionEl.textContent = '';
      questionEl.style.display = 'none';
    }
    if (warningEl) warningEl.style.display = 'none';
    btnCancel.style.display = '';
    btnCancel.disabled = false;
    btnCancel.textContent = '取消';
    btnConfirm.style.display = '';
    btnConfirm.disabled = false;
    btnConfirm.textContent = confirmText;
    btnConfirm.style.width = '';
    if (skipConfirm) {
      // 跳过确认态，直接进进度态（用户已在卡片上看到信息，无需再确认）
      start();
    } else {
      modal.classList.add('active');
    }

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEsc);
  });
}

function showSwitchProgress(platformId, initialMessage) {
  _switchProgressPlatform = platformId;
  let toast = document.getElementById('switch-progress-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'switch-progress-toast';
    toast.className = 'switch-progress-toast';
    toast.innerHTML = `
      <div class="switch-progress-spinner"></div>
      <div class="switch-progress-content">
        <div class="switch-progress-title">正在切换配置…</div>
        <div class="switch-progress-message"></div>
      </div>
    `;
    document.body.appendChild(toast);
  }
  const msgEl = toast.querySelector('.switch-progress-message');
  if (msgEl) msgEl.textContent = initialMessage || '正在处理…';
  toast.classList.add('show');
}

function updateSwitchProgress(payload) {
  if (!payload || !payload.platform) return;
  if (_switchFlowState && payload.platform === _switchFlowState.platform) {
    _switchFlowState.setProgress(payload.message || '正在处理…');
  }
  if (_switchProgressPlatform && payload.platform !== _switchProgressPlatform) return;
  const toast = document.getElementById('switch-progress-toast');
  if (!toast) return;
  const msgEl = toast.querySelector('.switch-progress-message');
  if (msgEl) msgEl.textContent = payload.message || '正在处理…';
  const titleEl = toast.querySelector('.switch-progress-title');
  if (titleEl) {
    if (payload.step === 'done') {
      titleEl.textContent = '完成';
    } else {
      titleEl.textContent = '正在切换配置…';
    }
  }
}

function hideSwitchProgress() {
  const toast = document.getElementById('switch-progress-toast');
  if (toast) {
    toast.classList.remove('show');
    setTimeout(() => { toast.remove(); }, 300);
  }
  _switchProgressPlatform = null;
}

async function bindSwitchProgressListener() {
  if (!tauriEvent?.listen || _switchProgressUnlisten) return;
  _switchProgressUnlisten = await tauriEvent.listen('platform-switch-progress', (event) => {
    updateSwitchProgress(event.payload || {});
  });
}

async function applyPlatform(platformId) {
  const def = platformDef(platformId);
  const select = document.getElementById(`platform-${platformId}-select`);
  const providerId = select ? select.value : '';
  if (!providerId) {
    showCustomAlert('请选择一个可用供应商。', '无法切换', 'warn');
    return;
  }

  const provider = platformProviderList(platformId).find(p => p.id === providerId);
  if (!provider) {
    showCustomAlert(platformId === 'codex' ? 'Codex 配置不存在或尚未加载。' : '供应商不存在或尚未加载。', '无法切换', 'error');
    return;
  }
  const confirmMessage = platformId === 'codex'
    ? codexApplyConfirmMessage(provider)
    : `将把「${provider.name}」写入 ${def.name} 配置文件，并在首次接管前创建 .byok-bak 备份。`;
  const ok = await showCustomConfirm(confirmMessage, '确认切换', 'warn');
  if (!ok) return;

  setPlatformBusy(platformId, true);
  showSwitchProgress(platformId, '正在准备切换…');
  try {
    const result = await invoke('switch_platform', { platform: platformId, providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || `${def.name} 已切换`);
    showCustomAlert(result.message || `${def.name} 已切换。`, '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${def.name} 切换失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy(platformId, false);
    if (platformId === 'codex' || platformId === 'opencode') renderPlatformDetailStatuses();
    else onPlatformProviderChange(platformId);
  }
}

function codexApplyConfirmMessage(provider) {
  const info = platformInfoOf('codex') || {};
  const from = info.currentProviderName || info.currentProviderId || '当前配置';
  const to = provider.name || provider.id || '目标配置';
  const model = provider.defaultModel || '默认模型';
  // 官方模型(gpt-*)在 Codex 白名单内，切换后直接可用；
  // 非官方模型需要注入补丁才能在模型选择器显示。
  const needsInject = !/^gpt-/i.test(String(model || '').trim());
  const hint = needsInject
    ? '切换后会自动重启 Codex，并解锁模型选择器中的第三方模型。'
    : '切换后会自动重启 Codex 生效。';
  return `将把 Codex 从「${from}」切换到「${to}」。\n\n供应商：${to}\n默认模型：${model}\n\n${hint}`;
}

async function restoreCodexOfficialConfig() {
  const info = platformInfoOf('codex') || {};
  const alreadyOfficial = !!(info.codexConfig && info.codexConfig.isOfficial);
  const message = alreadyOfficial
    ? 'Codex 当前已经是 OpenAI 官方配置。仍要清理第三方配置吗？'
    : '将把 Codex 切回 OpenAI 官方配置。\n\n切换后会自动重启 Codex（官方模式）。';
  const flow = await runSwitchFlow({
    title: '切回官方配置',
    lead: message,
    confirmText: '确认切回',
    platform: 'codex',
    runningMessage: '正在准备切回官方配置…',
    successTitle: '切换完成',
    failureTitle: '切回官方失败',
    skipConfirm: false,
    task: async ({ setMessage }) => {
      setPlatformBusy('codex', true);
      try {
        setMessage('正在写入 Codex 官方配置…');
        const result = assertSwitchResultOk(
          await invoke('restore_codex_official_config'),
          'Codex 官方配置还原失败'
        );
        if (typeof loadProviders === 'function') await loadProviders();
        await refreshPlatforms({ silent: true });

        setMessage('正在重启 Codex 桌面版（官方模式）…');
        const restart = assertSwitchResultOk(
          await invoke('restart_codex_desktop', { managed: false, model: null }),
          'Codex 桌面版官方模式重启失败'
        );

        if (typeof addLog === 'function') {
          addLog('ok', result.message || 'Codex 已切回官方配置');
          addLog('ok', restart.message || 'Codex 桌面版已按官方模式重启');
        }
        return {
          message: `${result.message || 'Codex 已切回官方配置。'}\n\n${restart.message || 'Codex 桌面版已按官方模式重启。'}`
        };
      } finally {
        setPlatformBusy('codex', false);
        renderPlatformDetailStatuses();
      }
    }
  });
  if (flow.confirmed && !flow.ok && typeof addLog === 'function') {
    addLog('err', `Codex 切回官方失败: ${switchFlowErrorText(flow.error)}`);
  }
}

async function restorePlatform(platformId) {
  const def = platformDef(platformId);
  const ok = await showCustomConfirm(
    `将从 .byok-bak 还原 ${def.name} 配置，并清除 AnyBridge 的接管记录。`,
    '确认还原',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy(platformId, true);
  showSwitchProgress(platformId, '正在准备还原配置…');
  try {
    const restored = await invoke('restore_platform', { platform: platformId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    const msg = restored ? `${def.name} 已从备份还原。` : `${def.name} 没有可还原的 AnyBridge 备份。`;
    if (typeof addLog === 'function') addLog(restored ? 'ok' : 'warn', msg);
    showCustomAlert(msg, restored ? '还原完成' : '没有备份', restored ? 'success' : 'info');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `${def.name} 还原失败: ${e}`);
    showCustomAlert(String(e), '还原失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy(platformId, false);
    if (platformId === 'codex' || platformId === 'opencode') renderPlatformDetailStatuses();
    else onPlatformProviderChange(platformId);
  }
}

// ═══════ CodeBuddy 自定义模型管理 ═══════

// 表格行工厂（提前声明，避免 TDZ）
const cbRowFactory = createCbRowFactory('Cb');
const wbRowFactory = createCbRowFactory('Wb');
const zcRowFactory = createCbRowFactory('Zc');

let cbModels = [];
let cbAvailableModels = [];
let cbConfigScope = 'user';
let cbConfigPath = '~/.codebuddy/models.json';
let cbProviderModels = [];
let cbEditingIndex = -1;
let cbAddSelectedProvider = null; // 当前在「添加」页面选中的供应商
let cbAddSearchKw = '';
const TENCENT_BUDDY_SYNC_STORAGE_KEY = 'anybridge.tencentBuddyModelSyncEnabled';
let tencentBuddySyncEnabled = localStorage.getItem(TENCENT_BUDDY_SYNC_STORAGE_KEY) === 'true';
const PLATFORM_ADD_PROVIDER_SORT_STORAGE_KEY = 'anybridge.platformAddProviderSortMode';
const PLATFORM_ADD_PROVIDER_SORT_MODES = new Set(['default', 'name-asc', 'name-desc']);
const PLATFORM_ADD_PROVIDER_SORT_LABELS = {
  default: '默认排序',
  'name-asc': '名称正序',
  'name-desc': '名称反序',
};
const PLATFORM_ADD_SORT_PREFIXES = ['cb', 'wb', 'zc'];
let platformAddProviderSortMode = (() => {
  try {
    return normalizePlatformAddProviderSortMode(localStorage.getItem(PLATFORM_ADD_PROVIDER_SORT_STORAGE_KEY));
  } catch (_) {
    return 'default';
  }
})();
const cbSelectedModelIds = {
  Cb: new Set(),
  Wb: new Set(),
  Zc: new Set(),
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

function platformAddProviderSortedList(list = []) {
  if (!Array.isArray(list)) return [];
  let result = list;
  if (platformAddProviderSortMode !== 'default') {
    const sorted = [...list].sort(comparePlatformAddProvidersByName);
    result = platformAddProviderSortMode === 'name-desc' ? sorted.reverse() : sorted;
  }
  // AnyBridge 本地代理始终排在第一位，不受排序影响
  const lpIdx = result.findIndex(p => isLocalProxyProviderEntry(p));
  if (lpIdx > 0) {
    const [lp] = result.splice(lpIdx, 1);
    result.unshift(lp);
  }
  return result;
}

function platformAddProviderSearchHaystack(p) {
  return [
    p?.providerName,
    p?.providerId,
  ].map(x => String(x || '').toLowerCase()).join(' ');
}

function platformAddVisibleProviders(list = [], keyword = '') {
  const source = Array.isArray(list) ? list : [];
  const terms = String(keyword || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length
    ? source.filter(p => {
        const haystack = platformAddProviderSearchHaystack(p);
        return terms.every(term => haystack.includes(term));
      })
    : source;
  return platformAddProviderSortedList(filtered);
}

function renderPlatformAddProviderLists() {
  renderCbAddProviderList();
  renderWbAddProviderList();
  renderZcAddProviderList();
}

function setPlatformAddProviderSortMode(mode) {
  const previous = platformAddProviderSortMode;
  platformAddProviderSortMode = normalizePlatformAddProviderSortMode(mode);
  try {
    localStorage.setItem(PLATFORM_ADD_PROVIDER_SORT_STORAGE_KEY, platformAddProviderSortMode);
  } catch (e) {
    platformAddProviderSortMode = previous;
    if (typeof addLog === 'function') addLog('err', '保存添加模型排序偏好失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  renderPlatformAddProviderLists();
}

function syncPlatformAddSortControl(prefix) {
  const label = document.getElementById(`${prefix}AddSortLabel`);
  if (label) label.textContent = platformAddProviderSortLabel(platformAddProviderSortMode);
  const menu = document.getElementById(`${prefix}AddSortMenu`);
  menu?.querySelectorAll('.provider-sort-option').forEach(btn => {
    const selected = btn.dataset.sortMode === platformAddProviderSortMode;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function syncAllPlatformAddSortControls() {
  PLATFORM_ADD_SORT_PREFIXES.forEach(syncPlatformAddSortControl);
}

function setPlatformAddSortMenuOpen(prefix, open) {
  if (open) {
    PLATFORM_ADD_SORT_PREFIXES.forEach(otherPrefix => {
      if (otherPrefix !== prefix) setPlatformAddSortMenuOpen(otherPrefix, false);
    });
    if (typeof closeProviderSortMenu === 'function') closeProviderSortMenu();
  }
  const control = document.getElementById(`${prefix}AddSortControl`);
  const trigger = document.getElementById(`${prefix}AddSortTrigger`);
  if (!control || !trigger) return;
  control.classList.toggle('open', !!open);
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function togglePlatformAddSortMenu(prefix, event) {
  if (event) event.stopPropagation();
  syncPlatformAddSortControl(prefix);
  const control = document.getElementById(`${prefix}AddSortControl`);
  setPlatformAddSortMenuOpen(prefix, !control?.classList.contains('open'));
}

function closePlatformAddSortMenus() {
  PLATFORM_ADD_SORT_PREFIXES.forEach(prefix => setPlatformAddSortMenuOpen(prefix, false));
}

function choosePlatformAddSortMode(prefix, mode) {
  setPlatformAddProviderSortMode(mode);
  closePlatformAddSortMenus();
  document.getElementById(`${prefix}AddSortTrigger`)?.focus();
}

function toggleCbAddSort(event) { togglePlatformAddSortMenu('cb', event); }
function chooseCbAddSortMode(mode) { choosePlatformAddSortMode('cb', mode); }
function toggleWbAddSort(event) { togglePlatformAddSortMenu('wb', event); }
function chooseWbAddSortMode(mode) { choosePlatformAddSortMode('wb', mode); }
function toggleZcAddSort(event) { togglePlatformAddSortMenu('zc', event); }
function chooseZcAddSortMode(mode) { choosePlatformAddSortMode('zc', mode); }

document.addEventListener('click', event => {
  const insideSortControl = PLATFORM_ADD_SORT_PREFIXES.some(prefix => {
    const control = document.getElementById(`${prefix}AddSortControl`);
    return control && control.contains(event.target);
  });
  if (!insideSortControl) closePlatformAddSortMenus();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePlatformAddSortMenus();
});

const CB_PLATFORM = 'codebuddy';
const WB_PLATFORM = 'workbuddy';

function cbApplyConfigMeta(prefix, data, fallbackPath) {
  const path = data && data._configPath ? String(data._configPath) : fallbackPath;
  const scope = data && data._configScope ? String(data._configScope) : 'user';
  const label = document.getElementById(`${prefix}-config-path-label`);
  const scopeLabel = document.getElementById(`${prefix}-config-scope-label`);
  if (label) label.textContent = path;
  if (scopeLabel) scopeLabel.textContent = scope === 'project' ? '项目级' : '用户级';
  return { path, scope };
}

function cbUniqueStrings(values) {
  const out = [];
  (values || []).forEach(value => {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  });
  return out;
}

function cbMergeAvailableModels(available, models) {
  return cbUniqueStrings([
    ...(Array.isArray(available) ? available : []),
    ...(Array.isArray(models) ? models.map(m => m && m.id) : []),
  ]);
}

function tencentBuddyPlatformLabel(platform) {
  return platform === WB_PLATFORM ? 'WorkBuddy' : 'CodeBuddy';
}

function cloneTencentBuddyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function syncTencentBuddySyncButtons() {
  document.querySelectorAll('[data-buddy-sync-toggle]').forEach(btn => {
    btn.classList.toggle('is-active', tencentBuddySyncEnabled);
    btn.setAttribute('aria-pressed', tencentBuddySyncEnabled ? 'true' : 'false');
    const platform = btn.getAttribute('onclick') || '';
    const isCodeBuddy = platform.includes("'codebuddy'");
    const targetName = isCodeBuddy ? 'WorkBuddy' : 'CodeBuddy';
    btn.title = tencentBuddySyncEnabled
      ? `同步 ${targetName} 已开启，点击关闭`
      : `开启同步 ${targetName}`;
  });
}

function setTencentBuddySyncEnabled(enabled) {
  const previous = tencentBuddySyncEnabled;
  tencentBuddySyncEnabled = !!enabled;
  try {
    localStorage.setItem(TENCENT_BUDDY_SYNC_STORAGE_KEY, tencentBuddySyncEnabled ? 'true' : 'false');
  } catch (e) {
    tencentBuddySyncEnabled = previous;
    if (typeof addLog === 'function') addLog('err', '保存双端同步开关失败: ' + e);
    if (typeof showCustomAlert === 'function') showCustomAlert(String(e), '保存失败', 'error');
  }
  syncTencentBuddySyncButtons();
}

function tencentBuddyModelId(model, sourceLabel, index, seen) {
  const id = String(model?.id || '').trim();
  if (!id) {
    throw new Error(`${sourceLabel} models[${index}] 缺少 id，无法双端同步`);
  }
  if (seen.has(id)) {
    throw new Error(`${sourceLabel} models 中存在重复模型 ID：${id}`);
  }
  seen.add(id);
  return id;
}

function mergeTencentBuddyModelObject(secondary, primary) {
  const merged = { ...(secondary || {}) };
  Object.entries(primary || {}).forEach(([key, value]) => {
    if (value !== undefined) merged[key] = value;
  });
  return merged;
}

function mergeTencentBuddyModelState(primaryData, secondaryData) {
  const primaryLabel = tencentBuddyPlatformLabel(primaryData.platform);
  const secondaryLabel = tencentBuddyPlatformLabel(secondaryData.platform);
  const byId = new Map();
  const order = [];
  const primarySeen = new Set();
  const secondarySeen = new Set();
  let conflictCount = 0;

  (primaryData.models || []).forEach((model, index) => {
    const id = tencentBuddyModelId(model, primaryLabel, index, primarySeen);
    byId.set(id, cloneTencentBuddyJson(model));
    order.push(id);
  });

  (secondaryData.models || []).forEach((model, index) => {
    const id = tencentBuddyModelId(model, secondaryLabel, index, secondarySeen);
    const cloned = cloneTencentBuddyJson(model);
    if (byId.has(id)) {
      conflictCount++;
      byId.set(id, mergeTencentBuddyModelObject(cloned, byId.get(id)));
      return;
    }
    byId.set(id, cloned);
    order.push(id);
  });

  const models = order.map(id => byId.get(id));
  const availableModels = cbMergeAvailableModels(
    cbUniqueStrings([
      ...(Array.isArray(primaryData.availableModels) ? primaryData.availableModels : []),
      ...(Array.isArray(secondaryData.availableModels) ? secondaryData.availableModels : []),
    ]),
    models
  );

  return { models, availableModels, conflictCount };
}

async function readTencentBuddyModels(platform) {
  if (!invoke) throw new Error('Tauri invoke 未初始化，无法同步 CodeBuddy / WorkBuddy');
  const data = await invoke('load_codebuddy_models', { platform });
  return {
    platform,
    models: Array.isArray(data.models) ? data.models : [],
    availableModels: Array.isArray(data.availableModels) ? data.availableModels : [],
    path: data && data._configPath ? String(data._configPath) : PLATFORM_DEFS[platform]?.configHint || '',
    scope: data && data._configScope ? String(data._configScope) : 'user',
  };
}

function memoryTencentBuddyModels(platform) {
  if (platform === WB_PLATFORM) {
    const availableModels = cbMergeAvailableModels(wbAvailableModels, wbModels);
    return {
      platform,
      models: wbModels,
      availableModels,
      path: wbConfigPath,
      scope: wbConfigScope,
    };
  }
  const availableModels = cbMergeAvailableModels(cbAvailableModels, cbModels);
  return {
    platform,
    models: cbModels,
    availableModels,
    path: cbConfigPath,
    scope: cbConfigScope,
  };
}

async function persistTencentBuddyModels(platform, models, availableModels, scope) {
  if (!invoke) throw new Error('Tauri invoke 未初始化，无法保存 CodeBuddy / WorkBuddy 配置');
  return invoke('save_codebuddy_models', {
    platform,
    models,
    availableModels,
    scope,
  });
}

function applyTencentBuddySyncedState(models, availableModels, codebuddyMeta, workbuddyMeta) {
  cbModels = cloneTencentBuddyJson(models);
  wbModels = cloneTencentBuddyJson(models);
  cbAvailableModels = cbUniqueStrings(availableModels);
  wbAvailableModels = cbUniqueStrings(availableModels);

  cbConfigPath = codebuddyMeta.path;
  wbConfigPath = workbuddyMeta.path;
  cbConfigScope = codebuddyMeta.scope;
  wbConfigScope = workbuddyMeta.scope;
  cbApplyConfigMeta('cb', { _configPath: cbConfigPath, _configScope: cbConfigScope }, cbConfigPath);
  cbApplyConfigMeta('wb', { _configPath: wbConfigPath, _configScope: wbConfigScope }, wbConfigPath);

  renderCodeBuddyModels();
  renderWbModels();
}

async function syncTencentBuddyModels(primaryPlatform, options = {}) {
  const primary = primaryPlatform === WB_PLATFORM ? WB_PLATFORM : CB_PLATFORM;
  const secondary = primary === CB_PLATFORM ? WB_PLATFORM : CB_PLATFORM;
  const primaryData = options.useCurrentPrimary
    ? memoryTencentBuddyModels(primary)
    : await readTencentBuddyModels(primary);
  const secondaryData = await readTencentBuddyModels(secondary);
  const codebuddyData = primary === CB_PLATFORM ? primaryData : secondaryData;
  const workbuddyData = primary === WB_PLATFORM ? primaryData : secondaryData;
  const merged = mergeTencentBuddyModelState(primaryData, secondaryData);

  const codebuddyPath = await persistTencentBuddyModels(
    CB_PLATFORM,
    cloneTencentBuddyJson(merged.models),
    cbUniqueStrings(merged.availableModels),
    codebuddyData.scope
  );
  const workbuddyPath = await persistTencentBuddyModels(
    WB_PLATFORM,
    cloneTencentBuddyJson(merged.models),
    cbUniqueStrings(merged.availableModels),
    workbuddyData.scope
  );

  const codebuddyMeta = { path: codebuddyPath, scope: codebuddyData.scope };
  const workbuddyMeta = { path: workbuddyPath, scope: workbuddyData.scope };
  applyTencentBuddySyncedState(merged.models, merged.availableModels, codebuddyMeta, workbuddyMeta);
  syncTencentBuddySyncButtons();

  if (typeof addLog === 'function') {
    const conflictText = merged.conflictCount ? `，${merged.conflictCount} 个同 ID 模型按 ${tencentBuddyPlatformLabel(primary)} 保留` : '';
    addLog('ok', `CodeBuddy / WorkBuddy 已同步 ${merged.models.length} 个模型${conflictText}`);
  }
  if (!options.silent) {
    const conflictText = merged.conflictCount ? `\n同 ID 冲突：${merged.conflictCount} 个，已保留 ${tencentBuddyPlatformLabel(primary)} 版本。` : '';
    showCustomAlert(
      `已同步 ${merged.models.length} 个模型到 CodeBuddy 与 WorkBuddy。${conflictText}`,
      '双端同步完成',
      'success'
    );
  }

  return { ...merged, paths: { codebuddy: codebuddyPath, workbuddy: workbuddyPath } };
}

async function toggleTencentBuddySync(primaryPlatform) {
  if (tencentBuddySyncEnabled) {
    setTencentBuddySyncEnabled(false);
    if (typeof addLog === 'function') addLog('info', 'CodeBuddy / WorkBuddy 双端同步已关闭');
    showCustomAlert('CodeBuddy / WorkBuddy 双端同步已关闭。', '同步已关闭', 'info');
    return;
  }

  const ok = await showCustomConfirm(
    `开启后会合并 CodeBuddy 与 WorkBuddy 的 models.json，并同时写入两个配置文件。\n\n之后打开或保存任一页面都会继续自动同步。相同模型 ID 冲突时保留当前页面的版本。`,
    '开启双端同步',
    'warn'
  );
  if (!ok) return;

  try {
    await syncTencentBuddyModels(primaryPlatform, { useCurrentPrimary: true });
    setTencentBuddySyncEnabled(true);
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '开启 CodeBuddy / WorkBuddy 双端同步失败: ' + e);
    showCustomAlert(String(e), '同步失败', 'error');
  }
}

function cbRemoveAvailableModel(available, modelId) {
  const id = String(modelId || '').trim();
  return cbUniqueStrings(available).filter(item => item !== id);
}

function cbReplaceAvailableModel(available, oldId, newId) {
  const next = cbRemoveAvailableModel(available, oldId);
  return cbMergeAvailableModels(next, [{ id: newId }]);
}

function cbProviderChatUrl(provider) {
  return provider?.chatUrl || provider?.apiHost || provider?.api_host || '';
}

function zcNormalizeBaseUrl(value) {
  let base = String(value || '').trim().replace(/\/+$/g, '');
  base = base.replace(/\/(?:chat\/completions|responses)$/i, '').replace(/\/+$/g, '');
  return base;
}

function zcProviderBaseUrl(provider) {
  return zcNormalizeBaseUrl(cbProviderChatUrl(provider));
}

function zcHashId(value) {
  let hash = 0x811c9dc5;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function zcProviderIdNeedsMigration(providerId, model) {
  const id = String(providerId || '').trim();
  const key = String(model?.apiKey || '').trim();
  return !id || id === 'AnyBridge' || id.includes('://') || id.includes('/') || id.includes('\\') || (!!key && id.includes(key));
}

function zcProviderIdForModel(model) {
  const existing = String(model?.providerId || '').trim();
  if (existing && !zcProviderIdNeedsMigration(existing, model)) return existing;
  return `AnyBridge-${zcHashId(`${model?.vendor || 'Custom'}|${zcNormalizeBaseUrl(model?.url || '')}`)}`;
}

function zcProviderIdForProvider(provider) {
  return zcProviderIdForModel({
    vendor: provider?.providerName || 'Custom',
    url: zcProviderBaseUrl(provider),
    apiKey: cbProviderApiKey(provider),
  });
}

function zcProviderModelKeyParts(providerId, modelId) {
  const pid = String(providerId || '').trim();
  const mid = String(modelId || '').trim();
  return pid && mid ? JSON.stringify([pid, mid]) : '';
}

function zcProviderModelKey(model) {
  return zcProviderModelKeyParts(zcProviderIdForModel(model), model?.id);
}

function cbModelSelectionKey(prefix, model) {
  if (prefix === 'Zc') return zcProviderModelKey(model);
  return String(model?.id || '').trim();
}

function cbProviderApiKey(provider) {
  return provider?.apiKey || provider?.api_key || '';
}

function cbSelectedCapability(prefix, name) {
  const el = document.getElementById(`${prefix}-add-page-${name}`);
  return el ? !!el.checked : true;
}

function cbBuildModelEntry(provider, modelId, displayName, capabilities, platformId) {
  const entry = {
    id: modelId,
    name: displayName || provider.providerName || 'Custom',
    vendor: provider.providerName || 'Custom',
    url: platformId === ZC_PLATFORM ? zcProviderBaseUrl(provider) : cbProviderChatUrl(provider),
    apiKey: cbProviderApiKey(provider),
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    supportsToolCall: !!capabilities.supportsToolCall,
    supportsImages: !!capabilities.supportsImages,
    supportsReasoning: !!capabilities.supportsReasoning,
  };
  if (platformId === WB_PLATFORM) entry.useCustomProtocol = true;
  if (platformId === ZC_PLATFORM) entry.providerId = zcProviderIdForModel(entry);
  return entry;
}

function cbAddModelIdentity(modelId) {
  const id = String(modelId || '');
  const icon = typeof renderModelIcon === 'function'
    ? renderModelIcon(id)
    : `<div class="model-item-icon fallback">${platformEsc(id.charAt(0).toUpperCase() || '?')}</div>`;
  return `
    <div class="cb-add-model-line" title="${platformEsc(id)}">
      ${icon}
      <span class="cb-add-model-id">${platformEsc(id || '-')}</span>
    </div>
  `;
}

function cbOnAddModelCheckChanged(input, syncFn) {
  const row = input?.closest('.cb-add-model-row, .wb-add-model-row');
  if (row) {
    const exists = row.dataset.existing === 'true';
    row.classList.toggle('already-added', exists);
  }
  if (typeof syncFn === 'function') syncFn();
}

function cbSetAddModelChecks(selector, checked, syncFn) {
  document.querySelectorAll(selector).forEach((checkbox) => {
    checkbox.checked = checked;
    cbOnAddModelCheckChanged(checkbox);
  });
  if (typeof syncFn === 'function') syncFn();
}

function cbApplyProviderModelSelection(prefix, provider, checkSelector, platformId) {
  const ref = cbModelListRef(prefix);
  const currentModels = ref.getModels();
  const providerModels = Array.isArray(provider?.models) ? provider.models : [];
  const providerIds = new Set(providerModels.map(m => String(m?.id || '')).filter(Boolean));
  const isZcode = prefix === 'Zc' || platformId === ZC_PLATFORM;
  const zcodeProviderId = isZcode ? zcProviderIdForProvider(provider) : '';
  const isCurrentProviderModel = (model) => {
    const modelId = String(model?.id || '');
    if (!providerIds.has(modelId)) return false;
    if (!isZcode) return true;
    return zcProviderModelKey(model) === zcProviderModelKeyParts(zcodeProviderId, modelId);
  };
  const selectedIds = new Set(
    Array.from(document.querySelectorAll(`${checkSelector}:checked`))
      .map(chk => String(chk.dataset.modelId || '').trim())
      .filter(id => providerIds.has(id))
  );
  const capabilities = {
    supportsToolCall: cbSelectedCapability(ref.domPrefix, 'tools'),
    supportsImages: cbSelectedCapability(ref.domPrefix, 'images'),
    supportsReasoning: cbSelectedCapability(ref.domPrefix, 'reasoning'),
  };
  const previousSelectedCount = currentModels.filter(isCurrentProviderModel).length;
  const preservedModels = currentModels.filter(model => !isCurrentProviderModel(model));
  const selectedModels = providerModels
    .filter(model => selectedIds.has(String(model?.id || '')))
    .map(model => {
      const modelId = String(model.id || '');
      const modelName = String(model.name || modelId);
      return cbBuildModelEntry(provider, modelId, provider.providerName, capabilities, platformId);
    });

  ref.setModels([...preservedModels, ...selectedModels]);
  ref.setAvailable(cbMergeAvailableModels(
    cbUniqueStrings(ref.getAvailable()).filter(id => !providerIds.has(String(id || ''))),
    selectedModels
  ));

  return { selectedCount: selectedModels.length, previousSelectedCount };
}

function cbIconSvg(name) {
  const icons = {
    tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.1 5.1L3 18l3 3 6.6-6.6a4 4 0 0 0 5.1-5.1l-2.4 2.4-3-3 2.4-2.4Z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m21 15-5-5L5 19"/></svg>',
    reason: '<svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14a6 6 0 1 1 8 0c-.8.7-1 1.5-1 2H9c0-.5-.2-1.3-1-2Z"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 8-8"/><path d="m15 8 3 3"/><path d="m17 6 3 3"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><rect x="4" y="4" width="11" height="11" rx="2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  };
  return icons[name] || '';
}

function cbCapabilityChip(cls, type, title) {
  return `<span class="${cls}-cap-chip ${cls}-cap-${type}" title="${platformEsc(title)}" aria-label="${platformEsc(title)}">${cbIconSvg(type)}</span>`;
}

// 能力药丸（中文标签，3 色按能力类型区分）
function cbCapabilityPill(cls, type, label) {
  const titles = { tool: '支持工具调用', image: '支持图片理解', reason: '支持深度推理' };
  const title = titles[type] || label;
  return `<span class="${cls}-cap-pill ${cls}-cap-${type}" title="${platformEsc(title)}" aria-label="${platformEsc(title)}">${platformEsc(label)}</span>`;
}

// ═══════ 编辑模型模态框（四个平台共用） ═══════

function cbEditModelsRef(prefix) {
  if (prefix === 'Cb') return { models: cbModels, available: () => cbAvailableModels, render: renderCodeBuddyModels, replace: (oldId, id) => { cbAvailableModels = cbReplaceAvailableModel(cbAvailableModels, oldId, id); }, platform: CB_PLATFORM };
  if (prefix === 'Zc') return { models: zcModels, available: () => zcAvailableModels, render: renderZcModels, replace: (oldId, id) => { zcAvailableModels = cbReplaceAvailableModel(zcAvailableModels, oldId, id); }, platform: ZC_PLATFORM };
  return { models: wbModels, available: () => wbAvailableModels, render: renderWbModels, replace: (oldId, id) => { wbAvailableModels = cbReplaceAvailableModel(wbAvailableModels, oldId, id); }, platform: WB_PLATFORM };
}

let cbEditCurrent = { prefix: null, index: -1 };

function openCbEditModal(prefix, index) {
  const ref = cbEditModelsRef(prefix);
  const model = ref.models[index];
  if (!model) return;
  cbEditCurrent = { prefix, index };

  const modal = document.getElementById('cb-edit-modal');
  if (!modal) return;

  // 填充字段：name 和 vendor 合并为「供应商」输入框
  const vendorOrName = model.vendor || model.name || '';
  platformSetValue('cb-edit-id', model.id || '');
  platformSetValue('cb-edit-vendor', vendorOrName);
  platformSetValue('cb-edit-url', prefix === 'Zc' ? zcNormalizeBaseUrl(model.url || '') : model.url || '');
  platformSetValue('cb-edit-key', model.apiKey || '');
  platformSetValue('cb-edit-max-input', model.maxInputTokens != null ? model.maxInputTokens : '');
  platformSetValue('cb-edit-max-output', model.maxOutputTokens != null ? model.maxOutputTokens : '');
  platformSetValue('cb-edit-temperature', model.temperature != null ? model.temperature : '');
  platformSetValue('cb-edit-tools', !!model.supportsToolCall);
  platformSetValue('cb-edit-images', !!model.supportsImages);
  platformSetValue('cb-edit-reasoning', !!model.supportsReasoning);

  // 标题展示平台名
  const titleEl = document.getElementById('cb-edit-modal-title');
  if (titleEl) {
    const platformLabel = prefix === 'Cb' ? 'CodeBuddy'      : prefix === 'Zc' ? 'ZCode'
      : 'WorkBuddy';
    titleEl.textContent = `编辑模型 · ${platformLabel}`;
  }
  const urlLabel = document.querySelector('label[for="cb-edit-url"]');
  const urlInput = document.getElementById('cb-edit-url');
  if (urlLabel) {
    urlLabel.innerHTML = prefix === 'Zc'
      ? 'Base URL <span style="color:var(--danger);">*</span>'
      : '接口地址 <span style="color:var(--danger);">*</span>';
  }
  if (urlInput) {
    urlInput.placeholder = prefix === 'Zc'
      ? 'OpenAI 兼容基础地址，如 https://api.example.com/v1'
      : 'API 端点完整路径，必须以 /chat/completions 结尾';
  }

  modal.classList.add('active');
  document.body.classList.add('modal-open');
  setTimeout(() => {
    const firstInput = document.getElementById('cb-edit-id');
    if (firstInput) firstInput.focus();
  }, 30);
}

function closeCbEditModal() {
  const modal = document.getElementById('cb-edit-modal');
  if (modal) modal.classList.remove('active');
  document.body.classList.remove('modal-open');
  cbEditCurrent = { prefix: null, index: -1 };
}

async function saveCbEditFromModal() {
  const { prefix, index } = cbEditCurrent;
  if (!prefix || index < 0) return;
  const ref = cbEditModelsRef(prefix);
  const listRef = cbModelListRef(prefix);
  const model = ref.models[index];
  if (!model) return;

  // 必填字段（4 个）：id / vendor (= name) / url / apiKey
  const id = (document.getElementById('cb-edit-id')?.value || '').trim();
  const vendor = (document.getElementById('cb-edit-vendor')?.value || '').trim();
  const rawUrl = (document.getElementById('cb-edit-url')?.value || '').trim();
  const url = prefix === 'Zc' ? zcNormalizeBaseUrl(rawUrl) : rawUrl;
  const apiKey = (document.getElementById('cb-edit-key')?.value || '').trim();

  // 必填校验
  const missing = [];
  if (!id) missing.push('模型 ID');
  if (!vendor) missing.push('供应商');
  if (!url) missing.push('接口地址');
  if (!apiKey) missing.push('API 密钥');
  if (missing.length) {
    showCustomAlert(`以下必填字段不能为空：\n${missing.join('、')}`, '输入错误', 'warn');
    return;
  }

  // 选填字段：留空不写
  const maxInputStr = (document.getElementById('cb-edit-max-input')?.value || '').trim();
  const maxOutputStr = (document.getElementById('cb-edit-max-output')?.value || '').trim();
  const tempStr = (document.getElementById('cb-edit-temperature')?.value || '').trim();
  const supportsToolCall = !!document.getElementById('cb-edit-tools')?.checked;
  const supportsImages = !!document.getElementById('cb-edit-images')?.checked;
  const supportsReasoning = !!document.getElementById('cb-edit-reasoning')?.checked;

  // 数字字段转换：空字符串或非数字 → 留空
  const parseNum = (v) => {
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const maxInput = parseNum(maxInputStr);
  const maxOutput = parseNum(maxOutputStr);
  const temperature = parseNum(tempStr);

  // 重建 entry：必填字段全写，name = vendor 同值；选填字段只在非空时写
  const oldId = model.id || '';
  const entry = {
    id,
    name: vendor,
    vendor,
    url,
    apiKey,
  };
  if (maxInput != null) entry.maxInputTokens = maxInput;
  if (maxOutput != null) entry.maxOutputTokens = maxOutput;
  if (temperature != null) entry.temperature = temperature;
  if (supportsToolCall) entry.supportsToolCall = true;
  if (supportsImages) entry.supportsImages = true;
  if (supportsReasoning) entry.supportsReasoning = true;

  // 保留 WorkBuddy 特殊字段
  if (model.useCustomProtocol) entry.useCustomProtocol = true;
  if (prefix === 'Zc') entry.providerId = zcProviderIdForModel({ ...model, ...entry });

  const previousModels = listRef.getModels().slice();
  const previousAvailable = listRef.getAvailable().slice();
  ref.models[index] = entry;
  ref.replace(oldId, id);
  ref.render();
  try {
    await listRef.save({ silent: true, throwOnError: true });
    closeCbEditModal();
    if (typeof showBottomToast === 'function') showBottomToast('模型已保存', 'success');
  } catch (e) {
    listRef.setModels(previousModels);
    listRef.setAvailable(previousAvailable);
    listRef.render();
    showCustomAlert(`保存失败，已恢复编辑前状态：${e}`, '保存失败', 'error');
  }
}

function cbModelsByClass(cls) {
  if (cls === 'cb') return cbModels;
  if (cls === 'zc') return zcModels;
  return wbModels;
}

function cbModelMatches(model, keyword) {
  if (!keyword) return true;
  return [
    model?.name,
    model?.id,
    model?.vendor,
    model?.url,
  ].some(value => String(value || '').toLowerCase().includes(keyword));
}

function cbFilteredModelEntries(models, prefix) {
  const keyword = (document.getElementById(`${prefix}-model-search`)?.value || '').trim().toLowerCase();
  return (models || [])
    .map((model, index) => ({ model, index }))
    .filter(entry => cbModelMatches(entry.model, keyword));
}

function cbNoResultRow(prefix) {
  return `
    <tr class="model-console-empty-row">
      <td colspan="6">
        <div>
          <strong>没有匹配的模型</strong>
          <span>换个关键词或清空搜索</span>
        </div>
      </td>
    </tr>
  `;
}

function cbUpdateConsoleStats(prefix, models) {
  const list = Array.isArray(models) ? models : [];
  const providerCount = new Set(list.map(m => String(m?.vendor || m?.url || 'Custom')).filter(Boolean)).size;
  const capCount = list.reduce((total, model) =>
    total + (model?.supportsToolCall ? 1 : 0) + (model?.supportsImages ? 1 : 0) + (model?.supportsReasoning ? 1 : 0),
    0
  );
  platformSetText(`${prefix}-console-count`, String(list.length));
  platformSetText(`${prefix}-console-provider-count`, String(providerCount));
  platformSetText(`${prefix}-console-cap-count`, String(capCount));
  // 更新标题旁的模型计数文字
  platformSetText(`${prefix}-model-count`, `共 ${list.length} 个`);
}

function cbButtonLabelEl(btn) {
  return btn?.querySelector('.model-action-label') || btn?.querySelector('span:last-child') || btn?.lastChild || null;
}

function cbGetButtonLabel(btn) {
  const label = cbButtonLabelEl(btn);
  return label ? label.textContent : '';
}

function cbSetButtonLabel(btn, text) {
  const label = cbButtonLabelEl(btn);
  if (label) label.textContent = text;
}

function onCbModelSearch() { renderCodeBuddyModels(); }
function onWbModelSearch() { renderWbModels(); }
function onZcModelSearch() { renderZcModels(); }

function cbSelectionSet(prefix) {
  if (!cbSelectedModelIds[prefix]) cbSelectedModelIds[prefix] = new Set();
  return cbSelectedModelIds[prefix];
}

function cbModelListRef(prefix) {
  if (prefix === 'Cb') {
    return {
      domPrefix: 'cb',
      getModels: () => cbModels,
      setModels: (models) => { cbModels = models; },
      getAvailable: () => cbAvailableModels,
      setAvailable: (available) => { cbAvailableModels = available; },
      render: renderCodeBuddyModels,
      save: saveCodeBuddyModels,
    };
  }
  if (prefix === 'Zc') {
    return {
      domPrefix: 'zc',
      getModels: () => zcModels,
      setModels: (models) => { zcModels = models; },
      getAvailable: () => zcAvailableModels,
      setAvailable: (available) => { zcAvailableModels = available; },
      render: renderZcModels,
      save: saveZcModels,
    };
  }
  return {
    domPrefix: 'wb',
    getModels: () => wbModels,
    setModels: (models) => { wbModels = models; },
    getAvailable: () => wbAvailableModels,
    setAvailable: (available) => { wbAvailableModels = available; },
    render: renderWbModels,
    save: saveWbModels,
  };
}

function cbSelectedVisibleEntries(prefix) {
  const ref = cbModelListRef(prefix);
  return cbFilteredModelEntries(ref.getModels(), ref.domPrefix);
}

function cbPruneSelection(prefix) {
  const ref = cbModelListRef(prefix);
  const ids = new Set(ref.getModels().map(model => cbModelSelectionKey(prefix, model)).filter(Boolean));
  const selected = cbSelectionSet(prefix);
  Array.from(selected).forEach(id => {
    if (!ids.has(id)) selected.delete(id);
  });
}

function cbSyncSelectionState(prefix) {
  cbPruneSelection(prefix);
  const ref = cbModelListRef(prefix);
  const selected = cbSelectionSet(prefix);
  const visibleEntries = cbSelectedVisibleEntries(prefix);
  const visibleIds = visibleEntries.map(({ model }) => cbModelSelectionKey(prefix, model)).filter(Boolean);
  const visibleSelected = visibleIds.filter(id => selected.has(id)).length;
  const domPrefix = ref.domPrefix;
  const selectAll = document.getElementById(`${domPrefix}-select-all`);
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
    selectAll.disabled = visibleIds.length === 0;
  }
  const btn = document.getElementById(`${domPrefix}-delete-selected-btn`);
  if (btn) {
    const count = selected.size;
    btn.disabled = count === 0;
    const label = btn.querySelector('.cb-bulk-delete-label');
    if (label) label.textContent = count ? `删除选中 (${count})` : '删除选中';
  }
}

function toggleCbModelSelection(prefix, index, checked) {
  const ref = cbModelListRef(prefix);
  const model = ref.getModels()[index];
  const id = cbModelSelectionKey(prefix, model);
  if (!id) return;
  const selected = cbSelectionSet(prefix);
  if (checked) selected.add(id);
  else selected.delete(id);
  cbSyncSelectionState(prefix);
}

function toggleCbModelSelectAll(prefix, checked) {
  const selected = cbSelectionSet(prefix);
  cbSelectedVisibleEntries(prefix).forEach(({ model }) => {
    const id = cbModelSelectionKey(prefix, model);
    if (!id) return;
    if (checked) selected.add(id);
    else selected.delete(id);
  });
  cbModelListRef(prefix).render();
}

async function cbPersistModelDeletion(prefix, previousModels, previousAvailable, deletedCount) {
  const ref = cbModelListRef(prefix);
  try {
    await ref.save({ silent: true, throwOnError: true });
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已删除 ${deletedCount} 个模型`, 'success');
    }
  } catch (e) {
    ref.setModels(previousModels);
    ref.setAvailable(previousAvailable);
    ref.render();
    showCustomAlert(`保存失败，已恢复删除前状态：${e}`, '保存失败', 'error');
  }
}

async function cbDeleteModelByIndex(prefix, index) {
  const ref = cbModelListRef(prefix);
  const models = ref.getModels();
  const model = models[index];
  if (!model) return;
  const previousModels = models.slice();
  const previousAvailable = ref.getAvailable().slice();
  const id = String(model.id || '');
  const selectionKey = cbModelSelectionKey(prefix, model);
  ref.setAvailable(cbRemoveAvailableModel(ref.getAvailable(), id));
  models.splice(index, 1);
  cbSelectionSet(prefix).delete(selectionKey);
  ref.render();
  await cbPersistModelDeletion(prefix, previousModels, previousAvailable, 1);
}

async function cbDeleteSelectedModels(prefix) {
  const ref = cbModelListRef(prefix);
  const selected = cbSelectionSet(prefix);
  if (!selected.size) return;
  const selectedIds = new Set(selected);
  const previousModels = ref.getModels().slice();
  const previousAvailable = ref.getAvailable().slice();
  const deletedCount = selectedIds.size;
  const nextModels = ref.getModels().filter(model => !selectedIds.has(cbModelSelectionKey(prefix, model)));
  ref.setModels(nextModels);
  if (prefix === 'Zc') {
    ref.setAvailable(cbMergeAvailableModels([], nextModels));
  } else {
    ref.setAvailable(cbUniqueStrings(ref.getAvailable()).filter(id => !selectedIds.has(String(id || ''))));
  }
  selected.clear();
  ref.render();
  await cbPersistModelDeletion(prefix, previousModels, previousAvailable, deletedCount);
}

function deleteSelectedCbModels() { cbDeleteSelectedModels('Cb'); }
function deleteSelectedWbModels() { cbDeleteSelectedModels('Wb'); }
function deleteSelectedZcModels() { cbDeleteSelectedModels('Zc'); }

async function copyCbModelId(cls, index) {
  const model = cbModelsByClass(cls)[index];
  const id = model?.id || '';
  if (!id) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(id);
    } else {
      const ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showCustomAlert(`已复制 ${id}`, '已复制', 'success');
  } catch (e) {
    showCustomAlert(String(e), '复制失败', 'error');
  }
}

function cbModelRow(model, index) {
  return cbRowFactory(model, index);
}

async function loadCodeBuddyModels() {
  if (!invoke) return;
  try {
    if (tencentBuddySyncEnabled) {
      await syncTencentBuddyModels(CB_PLATFORM, { silent: true });
      if (typeof addLog === 'function') addLog('ok', 'CodeBuddy 打开时已自动同步 WorkBuddy');
      return;
    }
    const data = await invoke('load_codebuddy_models', { platform: CB_PLATFORM });
    cbModels = Array.isArray(data.models) ? data.models : [];
    cbAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('cb', data, '~/.codebuddy/models.json');
    cbConfigScope = meta.scope;
    cbConfigPath = meta.path;
    renderCodeBuddyModels();
    if (typeof addLog === 'function') addLog('ok', 'CodeBuddy 模型列表已加载');
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步 CodeBuddy / WorkBuddy' : '加载 CodeBuddy 模型';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '加载失败', 'error');
  }
}

function renderCodeBuddyModels() {
  const tbody = document.getElementById('cb-model-tbody');
  const empty = document.getElementById('cb-model-empty');
  const table = document.getElementById('cb-model-table');
  if (!tbody) return;
  cbUpdateConsoleStats('cb', cbModels);

  if (!cbModels.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    cbSyncSelectionState('Cb');
    syncTencentBuddySyncButtons();
    return;
  }

  const entries = cbFilteredModelEntries(cbModels, 'cb');
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';
  tbody.innerHTML = entries.length
    ? entries.map(({ model, index }) => cbModelRow(model, index)).join('')
    : cbNoResultRow('cb');
  cbSyncSelectionState('Cb');
  syncTencentBuddySyncButtons();
}

function editCbModel(index) { openCbEditModal('Cb', index); }
function cancelCbEdit() { closeCbEditModal(); }
function saveCbEdit(index) { saveCbEditFromModal(index); }

function deleteCbModel(index) {
  cbDeleteModelByIndex('Cb', index);
}

async function toggleCbModelEnabled(index, checked) {
  const model = cbModels[index];
  if (!model) return;
  const previous = model.enabled !== false;
  model.enabled = checked;
  renderCodeBuddyModels();
  const saved = await saveCodeBuddyModels({ silent: true });
  if (!saved) {
    model.enabled = previous;
    renderCodeBuddyModels();
  }
}

async function saveCodeBuddyModels(options = {}) {
  if (!invoke) {
    const error = new Error('当前环境缺少 Tauri invoke，无法保存 CodeBuddy 配置');
    if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
    if (options.throwOnError) throw error;
    return false;
  }
  try {
    cbAvailableModels = cbMergeAvailableModels(cbAvailableModels, cbModels);
    if (tencentBuddySyncEnabled && !options.skipBuddySync) {
      const result = await syncTencentBuddyModels(CB_PLATFORM, {
        useCurrentPrimary: true,
        silent: true,
      });
      if (!options.silent) {
        showCustomAlert(`配置已同步保存到 ${result.paths.codebuddy} 与 ${result.paths.workbuddy}`, '保存成功', 'success');
      }
      return result.paths.codebuddy;
    }
    const path = await invoke('save_codebuddy_models', {
      platform: CB_PLATFORM,
      models: cbModels,
      availableModels: cbAvailableModels,
      scope: cbConfigScope,
    });
    cbConfigPath = path;
    const meta = cbApplyConfigMeta('cb', { _configPath: path, _configScope: cbConfigScope }, path);
    cbConfigScope = meta.scope;
    if (typeof addLog === 'function') addLog('ok', `CodeBuddy 配置已保存到 ${path}`);
    if (!options.silent) showCustomAlert(`配置已保存到 ${path}`, '保存成功', 'success');
    return path;
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步保存 CodeBuddy / WorkBuddy 配置' : '保存 CodeBuddy 配置';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    if (!options.silent) showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '保存失败', 'error');
    if (options.throwOnError) throw e;
    return false;
  }
}

// ─── 添加模型 · 独立页面版 ───

async function openCodeBuddyAddModal() {
  // 跳转到独立的「添加模型」子页面
  navigateTo('platform-codebuddy-add');
  await initCbAddPage();
}

async function initCbAddPage() {
  try {
    cbProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    cbProviderModels = [];
  }
  // 注入 AnyBridge 本地代理供应商到列表首位
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    cbProviderModels = cbProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    cbProviderModels.unshift(lp);
  }
  cbAddSelectedProvider = null;
  cbAddSearchKw = '';
  const searchInput = document.getElementById('cb-add-search');
  if (searchInput) searchInput.value = '';
  renderCbAddProviderList();
  renderCbAddModels();
  updateCbAddConfirmButton();
}

function onCbAddSearch() {
  const input = document.getElementById('cb-add-search');
  cbAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderCbAddProviderList();
}

function renderCbAddProviderList() {
  const list = document.getElementById('cb-add-provider-list');
  syncPlatformAddSortControl('cb');
  if (!list) return;
  if (!cbProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(cbProviderModels, cbAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = cbAddSelectedProvider === p.providerId;
    const isLP = isLocalProxyProviderEntry(p);
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isLP ? 'is-local-proxy' : ''}" onclick="selectCbAddProvider('${platformEsc(p.providerId)}')">
        <span class="cb-add-prov-icon">${platformEsc(initial)}</span>
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}${isLP ? '<span class="cb-add-prov-badge">本地</span>' : ''}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectCbAddProvider(providerId) {
  cbAddSelectedProvider = providerId;
  renderCbAddProviderList();
  renderCbAddModels();
  updateCbAddConfirmButton();
}

function renderCbAddModels() {
  const titleEl = document.getElementById('cb-add-models-title');
  const subEl = document.getElementById('cb-add-models-sub');
  const body = document.getElementById('cb-add-models-list-page');
  if (!body) return;

  if (!cbAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = cbProviderModels.find(p => p.providerId === cbAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要保留或添加的项`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  body.innerHTML = provider.models.map((m) => {
    const exists = cbModels.some(model => model.id === m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="cb-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} onchange="cbOnAddModelCheckChanged(this, updateCbAddConfirmButton)">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateCbAddConfirmButton() {
  const btn = document.getElementById('cb-add-confirm-page');
  if (!btn) return;
  const total = document.querySelectorAll('.cb-add-model-check').length;
  const checks = document.querySelectorAll('.cb-add-model-check:checked');
  btn.disabled = total === 0;
  const count = checks.length;
  cbSetButtonLabel(btn, ` 保存选择 (${count})`);
}

function cbAddSelectAll() {
  cbSetAddModelChecks('.cb-add-model-check', true, updateCbAddConfirmButton);
}

function cbAddSelectNone() {
  cbSetAddModelChecks('.cb-add-model-check', false, updateCbAddConfirmButton);
}

async function confirmAddCodeBuddyModelsPage() {
  if (!cbAddSelectedProvider) return;
  const provider = cbProviderModels.find(p => p.providerId === cbAddSelectedProvider);
  if (!provider) return;
  const btn = document.getElementById('cb-add-confirm-page');
  const originalBtnText = cbGetButtonLabel(btn);

  const checks = document.querySelectorAll('.cb-add-model-check:checked');
  if (btn) {
    btn.disabled = true;
    cbSetButtonLabel(btn, ' 保存中...');
  }
  const previousModels = cbModels.slice();
  const previousAvailableModels = cbAvailableModels.slice();
  const result = cbApplyProviderModelSelection('Cb', provider, '.cb-add-model-check', CB_PLATFORM);
  renderCodeBuddyModels();
  try {
    await saveCodeBuddyModels({ silent: true, throwOnError: true });
    navigateTo('platform-codebuddy');
    showBottomToast(`已保存选择（${result.selectedCount} 个模型）`, 'success');
  } catch (e) {
    cbModels = previousModels;
    cbAvailableModels = previousAvailableModels;
    renderCodeBuddyModels();
    showCustomAlert(`保存失败，未写入配置：${e}`, '保存失败', 'error');
    if (btn) {
      btn.disabled = false;
      cbSetButtonLabel(btn, originalBtnText || ` 保存选择 (${checks.length})`);
    }
  }
}

// 兼容旧调用
function closeCodeBuddyAddModal() { /* 旧弹窗已废弃 */ }
function onCbAddProviderChange() { /* 旧弹窗已废弃 */ }
function confirmAddCodeBuddyModels() { openCodeBuddyAddModal(); }

// ═══════ 通用模型表格行渲染工厂 ═══════

function createCbRowFactory(prefix) {
  const id = prefix.toLowerCase();
  const cls = prefix === 'Zc' ? 'wb' : id;
  const dataAttr = `data-${id}-index`;
  const esc = platformEsc;
  const maskKey = (k) => {
    k = String(k || '').trim();
    if (k.length <= 12) return '***';
    return k.slice(0, 6) + '***' + k.slice(-4);
  };

  const getEditingIndex = () => {
    if (prefix === 'Cb') return cbEditingIndex;
    if (prefix === 'Zc') return zcEditingIndex;
    return wbEditingIndex;
  };
  const setEditingIndex = (v) => {
    if (prefix === 'Cb') cbEditingIndex = v;
    else if (prefix === 'Zc') zcEditingIndex = v;
    else wbEditingIndex = v;
  };
  const editFn = prefix === 'Cb' ? 'editCbModel'    : prefix === 'Zc' ? 'editZcModel'
    : 'editWbModel';
  const deleteFn = prefix === 'Cb' ? 'deleteCbModel'    : prefix === 'Zc' ? 'deleteZcModel'
    : 'deleteWbModel';

  return function modelRow(model, index) {
    const displayName = model.vendor || model.name || model.id || '未命名';
    const selected = cbSelectionSet(prefix).has(cbModelSelectionKey(prefix, model));
    const caps = [];
    if (model.supportsToolCall) caps.push(cbCapabilityPill(cls, 'tool', '工具'));
    if (model.supportsImages) caps.push(cbCapabilityPill(cls, 'image', '图片'));
    if (model.supportsReasoning) caps.push(cbCapabilityPill(cls, 'reason', '推理'));

    const enabled = model.enabled !== false;
    const toggleFn = prefix === 'Cb' ? 'toggleCbModelEnabled'      : prefix === 'Zc' ? 'toggleZcModelEnabled'
      : 'toggleWbModelEnabled';

    return `
    <tr ${dataAttr}="${index}" class="${selected ? 'cb-model-row-selected' : ''}">
      <td class="cb-select-cell">
        <input type="checkbox" class="cb-model-row-check" aria-label="选择 ${esc(model.id || '模型')}" ${selected ? 'checked' : ''} onchange="toggleCbModelSelection('${prefix}', ${index}, this.checked)">
      </td>
      <td>
        <div class="model-id-copy-wrap">
          <span class="display-name-cell" title="${esc(model.id || '')}">${esc(model.id || '-')}</span>
          <button class="btn-icon model-id-copy-btn" onclick="copyTextToClipboard('${esc(model.id || '')}', '模型 ID')" title="复制模型 ID">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </td>
      <td><span title="${esc(displayName)}">${esc(displayName)}</span></td>
      <td><div style="display:flex; gap:6px; flex-wrap:wrap;">${caps.join('') || '<span style="color:var(--text-muted);font-size:12px;">—</span>'}</div></td>
      <td style="text-align:center;">
        <label class="toggle-switch" title="${enabled ? '已启用' : '已停用'}">
          <input type="checkbox" ${enabled ? 'checked' : ''} onchange="${toggleFn}(${index}, this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <div style="display:flex; gap:8px; justify-content:center;">
          <button class="btn-icon model-map-action-btn" onclick="openCbEditModal('${prefix}', ${index})" title="编辑模型">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon model-map-action-btn danger" onclick="${deleteFn}(${index})" title="删除模型">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `;
  };
}

// 拦截 openPlatformPage，让 CodeBuddy 系列页面加载模型列表
(function() {
  const _orig = openPlatformPage;
  window.openPlatformPage = function(platformId) {
    _orig(platformId);
    if (platformId === 'codebuddy') loadCodeBuddyModels();
    else if (platformId === 'workbuddy') loadWbModels();
    else if (platformId === 'zcode') loadZcModels();
  };
})();

// ═══════ 拖拽导入（通用工厂） ═══════

function createCbDropHandlers(prefix, modelsGetter, modelsSetter, availableGetter, availableSetter, renderFn, configLabel) {
  const id = prefix.toLowerCase();

  window[id + 'DragOver'] = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById(id + '-drop-zone');
    if (zone) zone.classList.add('drag-over');
  };

  window[id + 'DragLeave'] = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById(id + '-drop-zone');
    if (zone) zone.classList.remove('drag-over');
  };

  window[id + 'Drop'] = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById(id + '-drop-zone');
    if (zone) zone.classList.remove('drag-over');

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const file = files[0];
    if (!file.name.endsWith('.json')) {
      showCustomAlert('请拖入 .json 文件', '格式不支持', 'warn');
      return;
    }

    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        const incoming = Array.isArray(data.models) ? data.models : [];
        if (!incoming.length) {
          showCustomAlert('文件中没有 models 数组或为空', '导入失败', 'warn');
          return;
        }
        const current = modelsGetter();
        const existingIds = new Set(current.map(m => cbModelSelectionKey(prefix, m)).filter(Boolean));
        let added = 0;
        incoming.forEach(m => {
          const key = cbModelSelectionKey(prefix, m);
          if (!m.id || !key || existingIds.has(key)) return;
          existingIds.add(key);
          current.push(m);
          added++;
        });
        modelsSetter(current);
        if (Array.isArray(data.availableModels)) {
          const avail = availableGetter();
          data.availableModels.forEach(aid => {
            if (!avail.includes(aid)) avail.push(aid);
          });
          availableSetter(avail);
        }
        availableSetter(cbMergeAvailableModels(availableGetter(), current));
        renderFn();
        showCustomAlert(
          `拖入导入完成：${incoming.length} 个模型中有 ${added} 个新增（${incoming.length - added} 个重复已跳过）`,
          '导入结果',
          added > 0 ? 'success' : 'info'
        );
      } catch (err) {
        showCustomAlert('JSON 解析失败：' + err.message, '导入失败', 'error');
      }
    };
    reader.readAsText(file);
  };
}

createCbDropHandlers(
  'Cb',
  () => cbModels, v => { cbModels = v; },
  () => cbAvailableModels, v => { cbAvailableModels = v; },
  renderCodeBuddyModels, 'CodeBuddy'
);

createCbDropHandlers(
  'Wb',
  () => wbModels, v => { wbModels = v; },
  () => wbAvailableModels, v => { wbAvailableModels = v; },
  renderWbModels, 'WorkBuddy'
);

createCbDropHandlers(
  'Zc',
  () => zcModels, v => { zcModels = v; },
  () => zcAvailableModels, v => { zcAvailableModels = v; },
  renderZcModels, 'ZCode'
);

// ═══════ 导入导出 & JSON 编辑器（通用工厂） ═══════

function createCbIoHandlers(prefix, platform, modelsGetter, modelsSetter, availableGetter, availableSetter, renderFn, saveFn, loadFn, configLabel) {
  const id = prefix.toLowerCase();

  const setJsonToggleActive = (active) => {
    const btn = document.querySelector(`[data-json-toggle="${id}"]`);
    if (!btn) return;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  const setJsonView = (open) => {
    const listView = document.getElementById(id + '-list-view');
    const jsonView = document.getElementById(id + '-json-view');
    if (!jsonView) return;

    if (open) {
      if (listView) listView.style.display = 'none';
      jsonView.style.display = 'block';
      setJsonToggleActive(true);
      return;
    }

    jsonView.style.display = 'none';
    if (listView) listView.style.display = '';
    setJsonToggleActive(false);
    renderFn();
  };

  // ─── 导出 ───
  window['export' + prefix + 'Models'] = function() {
    const models = modelsGetter();
    const available = availableGetter();
    const payload = { models, availableModels: available };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = platform + '-models.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof addLog === 'function') addLog('ok', `${configLabel} 配置已导出`);
  };

  // ─── 导入 ───
  window['import' + prefix + 'Models'] = function(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    // 重置 input，允许重复选择同一文件
    event.target.value = '';
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = JSON.parse(e.target.result);
        const incoming = Array.isArray(data.models) ? data.models : [];
        if (!incoming.length) {
          showCustomAlert('导入文件中没有 models 数组或为空', '导入失败', 'warn');
          return;
        }
        const current = modelsGetter();
        const existingIds = new Set(current.map(m => cbModelSelectionKey(prefix, m)).filter(Boolean));
        let added = 0;
        incoming.forEach(m => {
          const key = cbModelSelectionKey(prefix, m);
          if (!m.id || !key || existingIds.has(key)) return;
          existingIds.add(key);
          current.push(m);
          added++;
        });
        modelsSetter(current);
        if (Array.isArray(data.availableModels)) {
          const avail = availableGetter();
          data.availableModels.forEach(id => {
            if (!avail.includes(id)) avail.push(id);
          });
          availableSetter(avail);
        }
        availableSetter(cbMergeAvailableModels(availableGetter(), current));
        renderFn();
        showCustomAlert(
          `导入完成：${incoming.length} 个模型中有 ${added} 个新增（${incoming.length - added} 个重复已跳过）`,
          '导入结果',
          added > 0 ? 'success' : 'info'
        );
      } catch (err) {
        showCustomAlert('JSON 解析失败：' + err.message, '导入失败', 'error');
      }
    };
    reader.readAsText(file);
  };

  // ─── JSON 编辑器 ───
  window['toggle' + prefix + 'JsonEditor'] = function() {
    const jsonView = document.getElementById(id + '-json-view');
    const wrap = document.getElementById(id + '-json-editor-wrap');
    if (!wrap) {
      console.warn('[toggle' + prefix + 'JsonEditor] wrap not found:', id + '-json-editor-wrap');
      return;
    }
    const isHidden = !jsonView || jsonView.style.display === 'none';
    if (isHidden) {
      // 展开：先填数据
      const models = modelsGetter();
      const available = availableGetter();
      const payload = { models, availableModels: available };
      const editor = document.getElementById(id + '-json-editor');
      if (editor) editor.value = JSON.stringify(payload, null, 2);
      const errEl = document.getElementById(id + '-json-error');
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      setJsonView(true);
    } else {
      setJsonView(false);
    }
  };

  window['format' + prefix + 'Json'] = function() {
    const editor = document.getElementById(id + '-json-editor');
    const errEl = document.getElementById(id + '-json-error');
    if (!editor) return;
    try {
      const data = JSON.parse(editor.value);
      editor.value = JSON.stringify(data, null, 2);
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    } catch (err) {
      if (errEl) { errEl.style.display = ''; errEl.textContent = '格式化失败：' + err.message; }
    }
  };

  window['apply' + prefix + 'Json'] = function() {
    const editor = document.getElementById(id + '-json-editor');
    const errEl = document.getElementById(id + '-json-error');
    if (!editor) return;
    try {
      const data = JSON.parse(editor.value);
      const models = Array.isArray(data.models) ? data.models : [];
      const available = Array.isArray(data.availableModels) ? data.availableModels : models.map(m => m.id).filter(Boolean);
      modelsSetter(models);
      availableSetter(available);
      setJsonView(false);
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      showCustomAlert(`已从 JSON 编辑器应用 ${models.length} 个模型`, '应用成功', 'success');
    } catch (err) {
      if (errEl) { errEl.style.display = ''; errEl.textContent = 'JSON 语法错误：' + err.message; }
    }
  };
}

// 为三个平台各注册一套
createCbIoHandlers(
  'Cb', 'codebuddy',
  () => cbModels, v => { cbModels = v; },
  () => cbAvailableModels, v => { cbAvailableModels = v; },
  renderCodeBuddyModels, saveCodeBuddyModels, loadCodeBuddyModels,
  'CodeBuddy'
);

createCbIoHandlers(
  'Wb', 'workbuddy',
  () => wbModels, v => { wbModels = v; },
  () => wbAvailableModels, v => { wbAvailableModels = v; },
  renderWbModels, saveWbModels, loadWbModels,
  'WorkBuddy'
);

createCbIoHandlers(
  'Zc', 'zcode',
  () => zcModels, v => { zcModels = v; },
  () => zcAvailableModels, v => { zcAvailableModels = v; },
  renderZcModels, saveZcModels, loadZcModels,
  'ZCode'
);

// ═══════ WorkBuddy 自定义模型管理 ═══════

let wbModels = [];
let wbAvailableModels = [];
let wbConfigScope = 'user';
let wbConfigPath = '~/.workbuddy/models.json';
let wbProviderModels = [];
let wbEditingIndex = -1;
let wbAddSelectedProvider = null;
let wbAddSearchKw = '';

function wbModelRow(model, index) {
  return wbRowFactory(model, index);
}

async function loadWbModels() {
  if (!invoke) return;
  try {
    if (tencentBuddySyncEnabled) {
      await syncTencentBuddyModels(WB_PLATFORM, { silent: true });
      if (typeof addLog === 'function') addLog('ok', 'WorkBuddy 打开时已自动同步 CodeBuddy');
      return;
    }
    const data = await invoke('load_codebuddy_models', { platform: WB_PLATFORM });
    wbModels = Array.isArray(data.models) ? data.models : [];
    wbAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('wb', data, '~/.workbuddy/models.json');
    wbConfigScope = meta.scope;
    wbConfigPath = meta.path;
    renderWbModels();
    if (typeof addLog === 'function') addLog('ok', 'WorkBuddy 模型列表已加载');
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步 CodeBuddy / WorkBuddy' : '加载 WorkBuddy 模型';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '加载失败', 'error');
  }
}

function renderWbModels() {
  const tbody = document.getElementById('wb-model-tbody');
  const empty = document.getElementById('wb-model-empty');
  const table = document.getElementById('wb-model-table');
  if (!tbody) return;
  cbUpdateConsoleStats('wb', wbModels);

  if (!wbModels.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    cbSyncSelectionState('Wb');
    syncTencentBuddySyncButtons();
    return;
  }

  const entries = cbFilteredModelEntries(wbModels, 'wb');
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';
  tbody.innerHTML = entries.length
    ? entries.map(({ model, index }) => wbModelRow(model, index)).join('')
    : cbNoResultRow('wb');
  cbSyncSelectionState('Wb');
  syncTencentBuddySyncButtons();
}

function editWbModel(index) { openCbEditModal('Wb', index); }
function cancelWbEdit() { closeCbEditModal(); }
function saveWbEdit(index) { saveCbEditFromModal(index); }

function deleteWbModel(index) {
  cbDeleteModelByIndex('Wb', index);
}

async function toggleWbModelEnabled(index, checked) {
  const model = wbModels[index];
  if (!model) return;
  const previous = model.enabled !== false;
  model.enabled = checked;
  renderWbModels();
  const saved = await saveWbModels({ silent: true });
  if (!saved) {
    model.enabled = previous;
    renderWbModels();
  }
}

async function saveWbModels(options = {}) {
  if (!invoke) {
    const error = new Error('当前环境缺少 Tauri invoke，无法保存 WorkBuddy 配置');
    if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
    if (options.throwOnError) throw error;
    return false;
  }
  try {
    wbAvailableModels = cbMergeAvailableModels(wbAvailableModels, wbModels);
    if (tencentBuddySyncEnabled && !options.skipBuddySync) {
      const result = await syncTencentBuddyModels(WB_PLATFORM, {
        useCurrentPrimary: true,
        silent: true,
      });
      if (!options.silent) {
        showCustomAlert(`配置已同步保存到 ${result.paths.codebuddy} 与 ${result.paths.workbuddy}`, '保存成功', 'success');
      }
      return result.paths.workbuddy;
    }
    const path = await invoke('save_codebuddy_models', {
      platform: WB_PLATFORM,
      models: wbModels,
      availableModels: wbAvailableModels,
      scope: wbConfigScope,
    });
    wbConfigPath = path;
    const meta = cbApplyConfigMeta('wb', { _configPath: path, _configScope: wbConfigScope }, path);
    wbConfigScope = meta.scope;
    if (typeof addLog === 'function') addLog('ok', `WorkBuddy 配置已保存到 ${path}`);
    if (!options.silent) showCustomAlert(`配置已保存到 ${path}`, '保存成功', 'success');
    return path;
  } catch (e) {
    const action = tencentBuddySyncEnabled ? '同步保存 CodeBuddy / WorkBuddy 配置' : '保存 WorkBuddy 配置';
    if (typeof addLog === 'function') addLog('err', `${action}失败: ` + e);
    if (!options.silent) showCustomAlert(String(e), tencentBuddySyncEnabled ? '双端同步失败' : '保存失败', 'error');
    if (options.throwOnError) throw e;
    return false;
  }
}

async function openWbAddModal() {
  navigateTo('platform-workbuddy-add');
  await initWbAddPage();
}

// 兼容旧调用
function closeWbAddModal() {}
function onWbAddProviderChange() {}
function confirmAddWbModels() { openWbAddModal(); }

async function initWbAddPage() {
  try {
    wbProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    wbProviderModels = [];
  }
  // 注入 AnyBridge 本地代理供应商到列表首位
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    wbProviderModels = wbProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    wbProviderModels.unshift(lp);
  }
  wbAddSelectedProvider = null;
  wbAddSearchKw = '';
  const searchInput = document.getElementById('wb-add-search');
  if (searchInput) searchInput.value = '';
  renderWbAddProviderList();
  renderWbAddModels();
  updateWbAddConfirmButton();
}

function onWbAddSearch() {
  const input = document.getElementById('wb-add-search');
  wbAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderWbAddProviderList();
}

function renderWbAddProviderList() {
  const list = document.getElementById('wb-add-provider-list');
  syncPlatformAddSortControl('wb');
  if (!list) return;
  if (!wbProviderModels.length) {
    list.innerHTML = '<div class="wb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(wbProviderModels, wbAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="wb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = wbAddSelectedProvider === p.providerId;
    const isLP = isLocalProxyProviderEntry(p);
    return `
      <div class="wb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isLP ? 'is-local-proxy' : ''}" onclick="selectWbAddProvider('${platformEsc(p.providerId)}')">
        <span class="wb-add-prov-icon">${platformEsc(initial)}</span>
        <span class="wb-add-prov-name">${platformEsc(p.providerName)}${isLP ? '<span class="wb-add-prov-badge">本地</span>' : ''}</span>
        <span class="wb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectWbAddProvider(providerId) {
  wbAddSelectedProvider = providerId;
  renderWbAddProviderList();
  renderWbAddModels();
  updateWbAddConfirmButton();
}

function renderWbAddModels() {
  const titleEl = document.getElementById('wb-add-models-title');
  const subEl = document.getElementById('wb-add-models-sub');
  const body = document.getElementById('wb-add-models-list-page');
  if (!body) return;
  if (!wbAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="wb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }
  const provider = wbProviderModels.find(p => p.providerId === wbAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    body.innerHTML = '<div class="wb-add-models-empty">供应商未找到</div>';
    return;
  }
  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要保留或添加的项`;
  if (!provider.models.length) {
    body.innerHTML = '<div class="wb-add-models-empty">该供应商暂无模型</div>';
    return;
  }
  body.innerHTML = provider.models.map((m) => {
    const exists = wbModels.some(model => model.id === m.id);
    return `
      <label class="wb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="wb-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} onchange="cbOnAddModelCheckChanged(this, updateWbAddConfirmButton)">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateWbAddConfirmButton() {
  const btn = document.getElementById('wb-add-confirm-page');
  if (!btn) return;
  const total = document.querySelectorAll('.wb-add-model-check').length;
  const checks = document.querySelectorAll('.wb-add-model-check:checked');
  btn.disabled = total === 0;
  const count = checks.length;
  cbSetButtonLabel(btn, ` 保存选择 (${count})`);
}

function wbAddSelectAll() {
  cbSetAddModelChecks('.wb-add-model-check', true, updateWbAddConfirmButton);
}

function wbAddSelectNone() {
  cbSetAddModelChecks('.wb-add-model-check', false, updateWbAddConfirmButton);
}

async function confirmAddWbModelsPage() {
  if (!wbAddSelectedProvider) return;
  const provider = wbProviderModels.find(p => p.providerId === wbAddSelectedProvider);
  if (!provider) return;
  const btn = document.getElementById('wb-add-confirm-page');
  const originalBtnText = cbGetButtonLabel(btn);
  const checks = document.querySelectorAll('.wb-add-model-check:checked');
  if (btn) {
    btn.disabled = true;
    cbSetButtonLabel(btn, ' 保存中...');
  }
  const previousModels = wbModels.slice();
  const previousAvailableModels = wbAvailableModels.slice();
  const result = cbApplyProviderModelSelection('Wb', provider, '.wb-add-model-check', WB_PLATFORM);
  renderWbModels();
  try {
    await saveWbModels({ silent: true, throwOnError: true });
    navigateTo('platform-workbuddy');
    showBottomToast(`已保存选择（${result.selectedCount} 个模型）`, 'success');
  } catch (e) {
    wbModels = previousModels;
    wbAvailableModels = previousAvailableModels;
    renderWbModels();
    showCustomAlert(`保存失败，未写入配置：${e}`, '保存失败', 'error');
    if (btn) {
      btn.disabled = false;
      cbSetButtonLabel(btn, originalBtnText || ` 保存选择 (${checks.length})`);
    }
  }
}

// ═══════ ZCode 自定义模型管理 ═══════

let zcModels = [];
let zcAvailableModels = [];
let zcConfigScope = 'user';
let zcConfigPath = '~/.zcode/v2/config.json';
let zcProviderModels = [];
let zcEditingIndex = -1;
let zcAddSelectedProvider = null;
let zcAddSearchKw = '';

const ZC_PLATFORM = 'zcode';

function zcModelRow(model, index) {
  return zcRowFactory(model, index);
}

async function loadZcModels() {
  if (!invoke) return;
  try {
    const data = await invoke('load_codebuddy_models', { platform: ZC_PLATFORM });
    zcModels = Array.isArray(data.models) ? data.models : [];
    zcAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('zc', data, '~/.zcode/v2/config.json');
    zcConfigScope = meta.scope;
    zcConfigPath = meta.path;
    renderZcModels();
    if (typeof addLog === 'function') addLog('ok', 'ZCode 模型列表已加载');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '加载 ZCode 模型失败: ' + e);
    showCustomAlert(String(e), '加载失败', 'error');
  }
}

function renderZcModels() {
  const tbody = document.getElementById('zc-model-tbody');
  const empty = document.getElementById('zc-model-empty');
  const table = document.getElementById('zc-model-table');
  if (!tbody) return;
  cbUpdateConsoleStats('zc', zcModels);

  if (!zcModels.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    cbSyncSelectionState('Zc');
    return;
  }

  const entries = cbFilteredModelEntries(zcModels, 'zc');
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';
  tbody.innerHTML = entries.length
    ? entries.map(({ model, index }) => zcModelRow(model, index)).join('')
    : cbNoResultRow('zc');
  cbSyncSelectionState('Zc');
}

function editZcModel(index) { openCbEditModal('Zc', index); }
function cancelZcEdit() { closeCbEditModal(); }
function saveZcEdit(index) { saveCbEditFromModal(index); }

function deleteZcModel(index) {
  cbDeleteModelByIndex('Zc', index);
}

async function toggleZcModelEnabled(index, checked) {
  const model = zcModels[index];
  if (!model) return;
  const previous = model.enabled !== false;
  model.enabled = checked;
  renderZcModels();
  const saved = await saveZcModels({ silent: true });
  if (!saved) {
    model.enabled = previous;
    renderZcModels();
  }
}

async function saveZcModels(options = {}) {
  if (!invoke) {
    const error = new Error('当前环境缺少 Tauri invoke，无法保存 ZCode 配置');
    if (!options.silent) showCustomAlert(error.message, '保存失败', 'error');
    if (options.throwOnError) throw error;
    return false;
  }
  try {
    zcAvailableModels = cbMergeAvailableModels(zcAvailableModels, zcModels);
    const path = await invoke('save_codebuddy_models', {
      platform: ZC_PLATFORM,
      models: zcModels,
      availableModels: zcAvailableModels,
      scope: zcConfigScope,
    });
    zcConfigPath = path;
    const meta = cbApplyConfigMeta('zc', { _configPath: path, _configScope: zcConfigScope }, path);
    zcConfigScope = meta.scope;
    if (typeof addLog === 'function') addLog('ok', `ZCode 配置已保存到 ${path}，并同步写入 CLI 配置`);
    if (!options.silent) showCustomAlert(`配置已保存到 ${path}，并同步写入 ~/.zcode/cli/config.json`, '保存成功', 'success');
    return path;
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '保存 ZCode 配置失败: ' + e);
    if (!options.silent) showCustomAlert(String(e), '保存失败', 'error');
    if (options.throwOnError) throw e;
    return false;
  }
}

async function openZcAddModal() {
  navigateTo('platform-zcode-add');
  await initZcAddPage();
}

// 兼容旧调用
function closeZcAddModal() {}
function onZcAddProviderChange() {}
function confirmAddZcModels() { openZcAddModal(); }

async function initZcAddPage() {
  try {
    zcProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    zcProviderModels = [];
  }
  // 注入 AnyBridge 本地代理供应商到列表首位
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    zcProviderModels = zcProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    zcProviderModels.unshift(lp);
  }
  zcAddSelectedProvider = null;
  zcAddSearchKw = '';
  const searchInput = document.getElementById('zc-add-search');
  if (searchInput) searchInput.value = '';
  renderZcAddProviderList();
  renderZcAddModels();
  updateZcAddConfirmButton();
}

function onZcAddSearch() {
  const input = document.getElementById('zc-add-search');
  zcAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderZcAddProviderList();
}

function renderZcAddProviderList() {
  const list = document.getElementById('zc-add-provider-list');
  syncPlatformAddSortControl('zc');
  if (!list) return;
  if (!zcProviderModels.length) {
    list.innerHTML = '<div class="wb-add-prov-empty zc-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(zcProviderModels, zcAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="wb-add-prov-empty zc-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = zcAddSelectedProvider === p.providerId;
    const isLP = isLocalProxyProviderEntry(p);
    return `
      <div class="wb-add-prov-item zc-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isLP ? 'is-local-proxy' : ''}" onclick="selectZcAddProvider('${platformEsc(p.providerId)}')">
        <span class="wb-add-prov-icon zc-add-prov-icon">${platformEsc(initial)}</span>
        <span class="wb-add-prov-name zc-add-prov-name">${platformEsc(p.providerName)}${isLP ? '<span class="wb-add-prov-badge zc-add-prov-badge">本地</span>' : ''}</span>
        <span class="wb-add-prov-count zc-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectZcAddProvider(providerId) {
  zcAddSelectedProvider = providerId;
  renderZcAddProviderList();
  renderZcAddModels();
  updateZcAddConfirmButton();
}

function renderZcAddModels() {
  const titleEl = document.getElementById('zc-add-models-title');
  const subEl = document.getElementById('zc-add-models-sub');
  const body = document.getElementById('zc-add-models-list-page');
  if (!body) return;
  if (!zcAddSelectedProvider) {
    if (titleEl) titleEl.textContent = '请选择供应商';
    if (subEl) subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="wb-add-models-empty zc-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }
  const provider = zcProviderModels.find(p => p.providerId === zcAddSelectedProvider);
  if (!provider) {
    if (titleEl) titleEl.textContent = '供应商未找到';
    if (subEl) subEl.textContent = '';
    body.innerHTML = '<div class="wb-add-models-empty zc-add-models-empty">供应商未找到</div>';
    return;
  }
  if (titleEl) titleEl.textContent = provider.providerName;
  if (subEl) subEl.textContent = `共 ${provider.models.length} 个模型，勾选要保留或添加的项`;
  if (!provider.models.length) {
    body.innerHTML = '<div class="wb-add-models-empty zc-add-models-empty">该供应商暂无模型</div>';
    return;
  }
  const zcodeProviderId = zcProviderIdForProvider(provider);
  body.innerHTML = provider.models.map((m) => {
    const exists = zcModels.some(model => zcProviderModelKey(model) === zcProviderModelKeyParts(zcodeProviderId, m.id));
    return `
      <label class="wb-add-model-row zc-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="zc-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} onchange="cbOnAddModelCheckChanged(this, updateZcAddConfirmButton)">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateZcAddConfirmButton() {
  const btn = document.getElementById('zc-add-confirm-page');
  if (!btn) return;
  const total = document.querySelectorAll('.zc-add-model-check').length;
  const checks = document.querySelectorAll('.zc-add-model-check:checked');
  btn.disabled = total === 0;
  const count = checks.length;
  cbSetButtonLabel(btn, ` 保存选择 (${count})`);
}

function zcAddSelectAll() {
  cbSetAddModelChecks('.zc-add-model-check', true, updateZcAddConfirmButton);
}

function zcAddSelectNone() {
  cbSetAddModelChecks('.zc-add-model-check', false, updateZcAddConfirmButton);
}

async function confirmAddZcModelsPage() {
  if (!zcAddSelectedProvider) return;
  const provider = zcProviderModels.find(p => p.providerId === zcAddSelectedProvider);
  if (!provider) return;
  const btn = document.getElementById('zc-add-confirm-page');
  const originalBtnText = cbGetButtonLabel(btn);
  const checks = document.querySelectorAll('.zc-add-model-check:checked');
  if (btn) {
    btn.disabled = true;
    cbSetButtonLabel(btn, ' 保存中...');
  }
  const previousModels = zcModels.slice();
  const previousAvailableModels = zcAvailableModels.slice();
  const result = cbApplyProviderModelSelection('Zc', provider, '.zc-add-model-check', ZC_PLATFORM);
  renderZcModels();
  try {
    await saveZcModels({ silent: true, throwOnError: true });
    navigateTo('platform-zcode');
    showBottomToast(`已保存选择（${result.selectedCount} 个模型）`, 'success');
  } catch (e) {
    zcModels = previousModels;
    zcAvailableModels = previousAvailableModels;
    renderZcModels();
    showCustomAlert(`保存失败，未写入配置：${e}`, '保存失败', 'error');
    if (btn) {
      btn.disabled = false;
      cbSetButtonLabel(btn, originalBtnText || ` 保存选择 (${checks.length})`);
    }
  }
}

// ═══════ ZCode JSON 编辑器：原生嵌套格式（覆盖通用工厂） ═══════
// ZCode 配置采用 provider → {providerId → {name, kind, options, source, models: {modelId: meta}}} 嵌套结构，
// 重写 toggle/apply 让 JSON 编辑器展示真实配置格式，而非 CodeBuddy 扁平 models[] 数组。

function zcFlatToNative(models) {
  const providers = {};
  for (const model of (models || [])) {
    const baseURL = zcNormalizeBaseUrl(model.url || '');
    const pid = zcProviderIdForModel({ ...model, url: baseURL });
    if (!providers[pid]) {
      providers[pid] = {
        name: model.vendor || 'Custom',
        kind: 'openai-compatible',
        options: {
          apiKey: model.apiKey || '',
          baseURL,
          apiKeyRequired: true,
        },
        source: 'custom',
        models: {},
      };
    }
    const input = model.supportsImages ? ['text', 'image'] : ['text'];
    const limit = { context: model.maxInputTokens || 128000 };
    if (model.maxOutputTokens) limit.output = model.maxOutputTokens;
    const meta = { name: model.name || model.id, limit, modalities: { input, output: ['text'] } };
    if (model.supportsReasoning) {
      meta.reasoning = {
        enabled: true,
        variants: ['enabled', 'off'],
        defaultVariant: 'enabled',
      };
    }
    providers[pid].models[model.id] = meta;
  }
  return { $schema: 'https://zcode.z.ai/config.json', provider: providers };
}

function zcReasoningEnabled(meta) {
  const reasoning = meta?.reasoning;
  if (typeof reasoning === 'boolean') return reasoning;
  if (reasoning && typeof reasoning === 'object') return reasoning.enabled !== false;
  return false;
}

function zcNativeToFlat(config) {
  const models = [];
  const providers = (config && config.provider) || {};
  for (const [pid, prov] of Object.entries(providers)) {
    if (prov.kind !== 'openai-compatible') continue;
    if ((prov.source || '') === 'builtin' || pid.startsWith('builtin:')) continue;
    const opts = prov.options || {};
    const baseURL = zcNormalizeBaseUrl(opts.baseURL || opts.baseUrl || '');
    const provModels = prov.models || {};
    for (const [mid, meta] of Object.entries(provModels)) {
      const inputArr = (meta.modalities && meta.modalities.input) || ['text'];
      const limit = meta.limit || {};
      models.push({
        id: mid,
        name: meta.name || mid,
        vendor: prov.name || 'Custom',
        url: baseURL,
        apiKey: opts.apiKey || '',
        providerId: zcProviderIdForModel({
          providerId: pid,
          vendor: prov.name || 'Custom',
          url: baseURL,
          apiKey: opts.apiKey || '',
        }),
        maxInputTokens: limit.context || 128000,
        maxOutputTokens: limit.output || undefined,
        supportsImages: inputArr.includes('image'),
        supportsReasoning: zcReasoningEnabled(meta),
        supportsToolCall: false,
        enabled: prov.enabled !== false && meta.enabled !== false,
      });
    }
  }
  return models;
}

function zcPayloadToFlat(data) {
  if (data && data.provider && typeof data.provider === 'object') return zcNativeToFlat(data);
  return Array.isArray(data?.models) ? data.models.map(model => {
    const next = {
      ...model,
      url: zcNormalizeBaseUrl(model.url || model.baseURL || model.baseUrl || ''),
    };
    return {
      ...next,
      providerId: zcProviderIdForModel(next),
    };
  }) : [];
}

// 覆盖：JSON 编辑器展开时显示 ZCode 原生嵌套格式
window.toggleZcJsonEditor = function() {
  const jsonView = document.getElementById('zc-json-view');
  if (!jsonView) return;
  const isHidden = jsonView.style.display === 'none';
  if (isHidden) {
    const listView = document.getElementById('zc-list-view');
    const native = zcFlatToNative(zcModels);
    const editor = document.getElementById('zc-json-editor');
    if (editor) editor.value = JSON.stringify(native, null, 2);
    const errEl = document.getElementById('zc-json-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (listView) listView.style.display = 'none';
    jsonView.style.display = 'block';
    const btn = document.querySelector('[data-json-toggle="zc"]');
    if (btn) { btn.classList.add('is-active'); btn.setAttribute('aria-pressed', 'true'); }
  } else {
    jsonView.style.display = 'none';
    const listView = document.getElementById('zc-list-view');
    if (listView) listView.style.display = '';
    const btn = document.querySelector('[data-json-toggle="zc"]');
    if (btn) { btn.classList.remove('is-active'); btn.setAttribute('aria-pressed', 'false'); }
    renderZcModels();
  }
};

// 覆盖：应用 JSON 编辑器时解析 ZCode 原生格式回扁平结构
window.applyZcJson = function() {
  const editor = document.getElementById('zc-json-editor');
  const errEl = document.getElementById('zc-json-error');
  if (!editor) return;
  try {
    const data = JSON.parse(editor.value);
    const models = zcPayloadToFlat(data);
    zcModels = models;
    zcAvailableModels = models.map(m => m.id).filter(Boolean);
    document.getElementById('zc-json-view').style.display = 'none';
    const listView = document.getElementById('zc-list-view');
    if (listView) listView.style.display = '';
    const btn = document.querySelector('[data-json-toggle="zc"]');
    if (btn) { btn.classList.remove('is-active'); btn.setAttribute('aria-pressed', 'false'); }
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    renderZcModels();
    showCustomAlert(`已从 JSON 编辑器应用 ${models.length} 个模型`, '应用成功', 'success');
  } catch (err) {
    if (errEl) { errEl.style.display = ''; errEl.textContent = 'JSON 语法错误：' + err.message; }
  }
};

// 覆盖导出：输出 ZCode 原生嵌套格式
window.exportZcModels = function() {
  const native = zcFlatToNative(zcModels);
  const json = JSON.stringify(native, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'zcode-config.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  if (typeof addLog === 'function') addLog('ok', 'ZCode 配置已导出（原生格式）');
};

window.importZcModels = function(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const incoming = zcPayloadToFlat(data);
      if (!incoming.length) {
        showCustomAlert('导入文件中没有可识别的 ZCode provider/models 配置', '导入失败', 'warn');
        return;
      }
      const existingIds = new Set(zcModels.map(zcProviderModelKey).filter(Boolean));
      let added = 0;
      incoming.forEach(model => {
        const key = zcProviderModelKey(model);
        if (!model.id || !key || existingIds.has(key)) return;
        existingIds.add(key);
        zcModels.push(model);
        added++;
      });
      zcAvailableModels = cbMergeAvailableModels(zcAvailableModels, zcModels);
      renderZcModels();
      showCustomAlert(
        `导入完成：${incoming.length} 个模型中有 ${added} 个新增（${incoming.length - added} 个重复已跳过）`,
        '导入结果',
        added > 0 ? 'success' : 'info'
      );
    } catch (err) {
      showCustomAlert('JSON 解析失败：' + err.message, '导入失败', 'error');
    }
  };
  reader.readAsText(file);
};

window.zcDrop = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('zc-drop-zone');
  if (zone) zone.classList.remove('drag-over');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const file = files[0];
  if (!file.name.endsWith('.json')) {
    showCustomAlert('请拖入 .json 文件', '格式不支持', 'warn');
    return;
  }
  window.importZcModels({ target: { files: [file], value: '' } });
};
