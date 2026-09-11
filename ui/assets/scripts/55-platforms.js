// ES module (P3) — vars on globalThis; functions kept + mirrored for hoist + data-action.
// More platforms: persistent config switching for Claude Code / Codex / CodeBuddy / OpenCode / ZCode.

globalThis.platformInfos = [];
globalThis.platformBusy = null;
globalThis.codexTokenVisible = false;
globalThis.codexTokenTimer = null;
globalThis.claudeCodeConfigSearch = '';
globalThis.claudeCodeConfigEditorMode = 'create';
globalThis.claudeCodeConfigModelFetchSeq = 0;
globalThis.claudeCodeRawConfigSyncing = false;
globalThis.codexConfigSearch = '';
globalThis.codexConfigEditorMode = 'create';
globalThis.codexConfigModelFetchSeq = 0;
globalThis.codexAgentsState = [];
globalThis.opencodeConfigSearch = '';
globalThis.opencodeConfigEditorMode = 'create';
globalThis.opencodeConfigModelFetchSeq = 0;
globalThis.opencodeRawConfigSyncing = false;

globalThis.PLATFORM_DEFS = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    requiredApiFormat: 'anthropic',
    configHint: '~/.claude/settings.json',
    summary: '写入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / 默认模型',
    note: '原有 MCP、权限、hooks、语言等设置会保留。',
  },
  'claude-desktop': {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    vendor: 'Anthropic',
    requiredApiFormat: 'anthropic',
    configHint: 'Claude-3p/claude_desktop_config.json',
    summary: '开启本地路由模式，映射 Sonnet / Opus / Haiku 模型',
    note: '需保持 AnyBridge 运行以提供本地路由服务，切换后重启 Claude Desktop 生效。',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    requiredApiFormat: 'openai',
    configHint: '~/.codex/config.toml',
    summary: '写入 model_provider = "codex_local_access" 和 model_providers.codex_local_access',
    note: '所选中转站必须支持 OpenAI Responses API。',
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    requiredApiFormat: 'openai',
    configHint: 'Antigravity IDE/User/settings.json',
    summary: '写入 jetski.cloudCodeUrl 与环境变量，本地转换并优化上下文策略',
    note: '支持主流服务商接入、上下文长记忆保护与模型下拉列表注入。',
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
  grok: {
    id: 'grok',
    name: 'Grok',
    vendor: 'xAI',
    requiredApiFormat: 'openai',
    configHint: '~/.grok/config.toml',
    summary: '写入 [models].default 与 [model.anybridge] 自定义端点',
    note: '原生支持 OpenAI 兼容 API，保留 config.toml 其余配置。',
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

function isRevealablePath(path) {
  const s = String(path || '').trim();
  if (!s) return false;
  // ~/.xxx 也允许点击；后端 reveal_path 负责展开 home
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return true;
  return s.includes('/') || s.includes('\\') || /^[A-Za-z]:/.test(s);
}

async function revealConfigPath(path) {
  if (!isRevealablePath(path)) return;
  if (!invoke && !bindTauriBridge()) return;
  try {
    await invoke('reveal_path', { path: String(path) });
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', '打开配置目录失败: ' + e);
  }
}

function bindRevealPathLabel(labelId, path) {
  const el = document.getElementById(labelId);
  if (!el) return;
  const display = String(path || '').trim() || el.textContent || '';
  el.textContent = display;
  if (isRevealablePath(display)) {
    el.classList.add('reveal-path');
    el.title = '点击打开所在文件夹';
    el.onclick = () => revealConfigPath(display);
  } else {
    el.classList.remove('reveal-path');
    el.title = '';
    el.onclick = null;
  }
}

function codexDesktopAutomationSupported() {
  const ua = `${navigator.userAgent || ''} ${navigator.platform || ''}`;
  return /\bWindows\b|Win32|Win64/i.test(ua);
}

function codexDesktopUnsupportedMessage() {
  return 'Codex Desktop 自动启动和模型注入当前仅支持 Windows。配置已写入后，请在本机手动重启 Codex 使其生效。';
}

function platformFormatLabel(fmt) {
  return fmt === 'openai' ? 'OpenAI' : 'Anthropic';
}


function platformLocalProxyConfigId(platformId) {
  return `anybridge-local-proxy-${platformId}`;
}

function platformIsLocalProxyConfig(config) {
  return !!(config && (config.localProxy || String(config.id || '').startsWith('anybridge-local-proxy')));
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
  const isGrok = platformId === 'grok';
  const localProxyId = platformLocalProxyConfigId(platformId);
  const live = isOpenCode
    ? (Array.isArray(info?.liveProviderIds) && info.liveProviderIds.includes(localProxyId))
    : false;
  const current = isOpenCode
    ? info?.currentProviderId === localProxyId
    : isClaude
      ? (typeof claudeCodeProviderIsCurrent === 'function' && claudeCodeProviderIsCurrent(runtime, info))
      : isGrok
        ? (info?.currentProviderId === localProxyId || info?.currentProviderId === grok_sanitize_key(localProxyId))
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
    protocol: isClaude ? 'anthropic-compatible' : ((isOpenCode || isGrok) ? 'openai-compatible' : 'responses'),
    configAction: 'openProxyRoutesFromPlatform()',
    configLabel: '配置代理模型',
    action: `applyLocalProxyPlatformConfig(${platformJsArg(platformId)})`,
    actionLabel: '切换',
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
  } else if (platformId === 'grok') {
    providerStore.grokConfigs = upsertById(providerStore.grokConfigs, {
      ...base,
      apiBackend: 'chat_completions',
    });
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
  if (platformId === 'antigravity') {
    return Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'opencode') {
    return Array.isArray(providerStore?.opencodeConfigs) ? providerStore.opencodeConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
  }
  if (platformId === 'grok') {
    return Array.isArray(providerStore?.grokConfigs) ? providerStore.grokConfigs.filter(p => !platformIsLocalProxyConfig(p)) : [];
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
  // Codex 会自行拼接 "/responses"，base 必须是 API 根路径。
  // 归一规则必须与后端 codex_direct_base_url() 完全一致，
  // 否则「显示的地址」与「写进 config.toml 的地址」会对不上，连带 codexProviderIsCurrent 误判。
  const base = platformStripSuffix(endpoint, ['/chat/completions', '/responses']);
  return platformUrlHasPath(base) ? base : `${base}/v1`;
}

/** URL 是否带非空路径段（platformJoinUrl 已保证有 scheme 且去掉了尾斜杠）。 */
function platformUrlHasPath(url) {
  const raw = String(url || '');
  const idx = raw.indexOf('://');
  return idx >= 0 ? raw.slice(idx + 3).includes('/') : raw.includes('/');
}

/**
 * 供应商的上游协议：显式 wireApi 优先，否则按 API 路径判断。返回 '' 表示无法判断。
 *
 * 普通供应商在 UI 上没有 wireApi 输入项（字段恒为空字符串），
 * 端点协议这个信息实际上只存在于 apiPath 里（如 /v1/chat/completions）。
 */
function codexWireApiOf(provider) {
  const explicit = String(provider?.wireApi || '').trim().toLowerCase();
  if (explicit === 'chat' || explicit === 'responses') return explicit;
  const path = String(provider?.apiPath || '').trim().toLowerCase().replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  return '';
}

/**
 * 推断 Codex 配置的上游协议 —— 只决定「本地代理 → 供应商」用哪个端点，
 * 以及 sidecar 是否做 Responses→Chat 转换，**不写进 config.toml**。
 *
 * config.toml 里的 wire_api 恒为 "responses"：openai/codex 已删除 WireApi::Chat，
 * 写 "chat" 会让 Codex 反序列化配置失败、启动即崩（discussions/7782）。
 * 因此只支持 Chat Completions 的供应商，唯一出路就是开启路由模式让本地代理转协议 ——
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
function refreshCodexWireApiAutoLabel() {
  const autoOption = document.querySelector('#codex-config-wire-api option[value="auto"]');
  if (!autoOption) return;
  const sourceId = String(document.getElementById('codex-config-source-id')?.value || '').trim();
  const source = sourceId
    ? (providerStore?.providers || []).find(p => p && p.id === sourceId)
    : null;
  const guess = codexWireApiOf(source);
  autoOption.textContent = guess ? `自动识别（当前：${codexWireApiLabel(guess)}）` : '自动识别';
}

async function refreshPlatforms(options = {}) {
  if (!invoke) return;
  const btn = document.getElementById('platforms-refresh-btn');
  if (btn && !options.silent) {
    btn.disabled = true;
    btn.textContent = '检测中...';
  }

  try {
    if (options.reloadProviders !== false && typeof loadProviders === 'function') {
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
        <button class="btn-primary platform-open-btn" data-action="openPlatformPage" data-arg="${platformEsc(info.id)}">配置</button>
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
    if (platformId === 'antigravity') {
      renderAntigravityPageStatus(info || { id: 'antigravity', installed: false });
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
    if (platformId === 'grok') {
      if (info) renderGrokPageStatus(info);
      return;
    }
    if (platformId === 'claude-desktop') {
      if (typeof loadClaudeDesktopConsole === 'function') {
        loadClaudeDesktopConsole();
      }
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

  const meta = codexStatusMeta(info);
  if (headline) headline.textContent = 'OpenAI 终端智能体 CLI · 管理官方与第三方兼容配置';

  if (pill) {
    pill.textContent = meta.label;
    pill.className = `codex-state-pill ${meta.tone}`;
  }
  if (currentLabel) currentLabel.textContent = meta.label;
  bindRevealPathLabel('codex-config-path-label', info.configPath || platformDef('codex').configHint);
  renderCodexConfigList(info);
  renderPlatformNativeRetry();
}

function renderClaudeCodePageStatus(info) {
  const headline = document.getElementById('platform-claude-code-headline');
  const currentLabel = document.getElementById('claude-code-current-label');

  const meta = claudeCodeStatusMeta(info);

  if (headline) headline.textContent = 'Anthropic 终端智能体 CLI · 管理官方与第三方兼容配置';
  if (currentLabel) currentLabel.textContent = meta.label;
  bindRevealPathLabel('claude-code-config-path-label', info.configPath || platformDef('claude-code').configHint);
  renderClaudeCodeConfigList(info);
  renderPlatformNativeRetry();
}

function renderOpenCodePageStatus(info) {
  const headline = document.getElementById('platform-opencode-headline');
  const currentLabel = document.getElementById('opencode-current-label');

  const meta = openCodeStatusMeta(info);

  if (headline) headline.textContent = '开源终端 AI 助手 CLI · 管理独立 Provider 配置';
  if (currentLabel) currentLabel.textContent = meta.label;
  bindRevealPathLabel('opencode-config-path-label', info.configPath || platformDef('opencode').configHint);
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
  const btn = document.getElementById('codex-config-fetch-models-btn');
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
  btn.textContent = loading ? '拉取中...' : '拉取模型';
}

let currentViewingRealConfigPlatform = 'codex';

async function openPlatformRealConfigModal(platform = 'codex') {
  currentViewingRealConfigPlatform = platform;
  const modal = document.getElementById('platform-real-config-modal');
  if (!modal) return;

  const titleMap = {
    'codex': { title: '配置文件实际内容 · config.toml', file: '~/.codex/config.toml' },
    'claude-code': { title: '配置文件实际内容 · settings.json', file: '~/.claude/settings.json' },
    'opencode': { title: '配置文件实际内容 · opencode.json', file: '~/.config/opencode/opencode.json' },
    'grok': { title: '配置文件实际内容 · config.toml', file: '~/.grok/config.toml' },
    'claude-desktop': { title: '配置文件实际内容 · claude_desktop_config.json', file: 'Claude-3p/claude_desktop_config.json' }
  };

  const meta = titleMap[platform] || { title: `配置文件实际内容 · ${platform}`, file: '本地磁盘配置文件' };
  const titleEl = document.getElementById('platform-real-config-modal-title');
  const pathEl = document.getElementById('platform-real-config-modal-path');
  if (titleEl) titleEl.textContent = meta.title;
  if (pathEl) pathEl.textContent = `文件路径：${meta.file}`;

  modal.classList.add('active');
  await reloadPlatformRealConfigModal(false);
}

function closePlatformRealConfigModal() {
  document.getElementById('platform-real-config-modal')?.classList.remove('active');
}

async function reloadPlatformRealConfigModal(notify = true) {
  await loadPlatformRealConfigFile(currentViewingRealConfigPlatform, 'platform-real-config-modal-textarea', notify);
}

function copyPlatformRealConfigModal() {
  copyRawConfigText('platform-real-config-modal-textarea', `${currentViewingRealConfigPlatform} 配置文件内容`);
}

async function savePlatformRealConfigModal() {
  const textarea = document.getElementById('platform-real-config-modal-textarea');
  if (!textarea) return;
  const content = textarea.value;
  const saveBtn = document.getElementById('platform-real-config-modal-save-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
  }
  try {
    const ok = await invoke('write_platform_config_file', {
      platform: currentViewingRealConfigPlatform,
      content,
    });
    if (ok) {
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已成功保存并写回 ${currentViewingRealConfigPlatform} 磁盘配置文件`, 'success');
      } else {
        showCustomAlert('已成功保存并写回磁盘配置文件。', '保存成功', 'success');
      }
      closePlatformRealConfigModal();
      if (typeof refreshPlatforms === 'function') {
        refreshPlatforms();
      }
    }
  } catch (e) {
    console.error(`[platforms] 写入配置文件失败:`, e);
    showCustomAlert(String(e), '保存失败', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存修改';
    }
  }
}

async function loadPlatformRealConfigFile(platform, textareaId, notify = false) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return false;
  try {
    const content = await invoke('read_platform_config_file', { platform });
    if (content && content.trim()) {
      textarea.value = content;
      if (notify && typeof showBottomToast === 'function') {
        showBottomToast(`已从磁盘重新载入 ${platform} 配置文件原文`, 'success');
      }
      return true;
    } else {
      if (notify && typeof showBottomToast === 'function') {
        showBottomToast(`磁盘上尚未检测到 ${platform} 配置文件，已呈现预设模版`, 'info');
      }
    }
  } catch (e) {
    console.warn(`[platforms] 读取 ${platform} 磁盘配置文件失败:`, e);
    if (notify && typeof showCustomAlert === 'function') {
      showCustomAlert(String(e), '读取配置文件失败', 'error');
    }
  }
  return false;
}

function copyRawConfigText(textareaId, label = '配置文本') {
  const el = document.getElementById(textareaId);
  if (!el || !el.value.trim()) {
    showCustomAlert('暂无可复制的内容。', '提示', 'info');
    return;
  }
  const text = el.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      if (typeof showBottomToast === 'function') {
        showBottomToast(`已复制 ${label} 到剪贴板`, 'success');
      } else {
        showCustomAlert(`已复制 ${label} 到剪贴板。`, '复制成功', 'success');
      }
    }).catch(() => {
      el.select();
      document.execCommand('copy');
      showCustomAlert(`已复制 ${label} 到剪贴板。`, '复制成功', 'success');
    });
  } else {
    el.select();
    document.execCommand('copy');
    showCustomAlert(`已复制 ${label} 到剪贴板。`, '复制成功', 'success');
  }
}

function syncCodexRawConfigFromFields() {
  const textarea = document.getElementById('codex-config-raw-toml');
  if (!textarea) return;
  const name = document.getElementById('codex-config-name')?.value.trim() || 'CustomProvider';
  const baseUrl = document.getElementById('codex-config-base-url')?.value.trim() || 'http://127.0.0.1:7450/v1';
  const apiKey = document.getElementById('codex-config-api-key')?.value.trim() || '';
  const defaultModel = document.getElementById('codex-config-model')?.value.trim() || '';
  const routeThroughProxy = document.getElementById('codex-config-route-through-proxy')?.checked !== false;
  const preserveAuth = document.getElementById('codex-config-preserve-official-auth')?.checked === true;

  const effectiveBase = routeThroughProxy ? 'http://127.0.0.1:7450/v1' : baseUrl;

  const lines = [
    `# ~/.codex/config.toml 当前配置段落预览`
  ];
  if (defaultModel) lines.push(`model = "${defaultModel}"`);
  lines.push(`model_provider = "codex_local_access"\n`);
  lines.push(`[model_providers.codex_local_access]`);
  lines.push(`name = "${name}"`);
  lines.push(`base_url = "${effectiveBase}"`);
  lines.push(`wire_api = "responses"`);
  if (preserveAuth) {
    lines.push(`requires_openai_auth = true`);
  } else {
    lines.push(`requires_openai_auth = false`);
    if (apiKey) lines.push(`experimental_bearer_token = "${apiKey}"`);
  }

  const entries = typeof getCodexModelEntries === 'function' ? getCodexModelEntries() : [];
  const inCatalog = entries.filter(e => e.inCatalog);
  if (inCatalog.length) {
    lines.push('');
    for (const m of inCatalog) {
      lines.push(`[[model_providers.codex_local_access.models]]`);
      lines.push(`name = "${m.model}"`);
      if (m.displayName) lines.push(`display_name = "${m.displayName}"`);
      if (m.contextWindow) lines.push(`context_window = ${m.contextWindow}`);
    }
  }
  textarea.value = lines.join('\n');
}

function syncGrokRawConfigFromFields() {
  const textarea = document.getElementById('grok-config-raw-toml');
  if (!textarea) return;
  const name = document.getElementById('grok-config-name')?.value.trim() || 'Custom';
  const baseUrl = document.getElementById('grok-config-base-url')?.value.trim() || 'https://api.deepseek.com/v1';
  const apiKey = document.getElementById('grok-config-api-key')?.value.trim() || '';
  const model = document.getElementById('grok-config-model')?.value.trim() || 'deepseek-chat';
  const backend = document.getElementById('grok-config-backend')?.value.trim() || 'chat_completions';

  const key = (name || 'custom').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const lines = [
    `# ~/.grok/config.toml 自定义模型配置段落预览`,
    `default_model = "${model}"\n`,
    `[models.${key}]`,
    `name = "${name}"`,
    `base_url = "${baseUrl}"`,
    `api_key = "${apiKey || 'sk-...'}"`,
    `model = "${model}"`,
    `api_backend = "${backend}"`
  ];
  textarea.value = lines.join('\n');
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
    const icon = typeof renderModelIcon === 'function' ? renderModelIcon(entry.model) : '';
    return `<div class="codex-config-model-option${activeClass}" data-idx="${i}" data-model="${model}" data-display="${displayName}" data-ctx="${ctx}">
      <input type="checkbox" ${checked} data-action="toggleCodexModelCatalog" data-events="change" data-args="[${i}]" title="加入模型目录">
      <span class="codex-model-icon-wrap">${icon}</span>
      <span class="codex-model-name" title="${model}">${model}</span>
      ${displayName ? `<span class="codex-model-display-name">${displayName}</span>` : ''}
      ${ctx ? `<span class="codex-model-ctx">${ctx}</span>` : ''}
      <div class="codex-model-actions">
        <button type="button" class="${defaultBtnClass}" data-action-call="${defaultBtnClick}">${defaultBtnText}</button>
        <button type="button" class="codex-config-fetch-btn" data-action="editCodexModelEntry" data-args="[${i}]">编辑</button>
        <button type="button" class="codex-config-catalog-del" data-action="removeCodexModelEntry" data-args="[${i}]">删除</button>
      </div>
    </div>`;
  }).join('');
  if (status) codexConfigSetModelStatus(status);
  if (document.getElementById('codex-agents-list')) {
    renderCodexAgentsPanel(null, codexAgentsState);
  }
  syncCodexRawConfigFromFields();
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
globalThis.codexModelEntriesState = [];

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

function cancelCodexModelEdit() {
  const entries = getCodexModelEntries();
  const def = entries.find(e => e.isDefault)?.model || '';
  renderCodexModelManager(entries, def);
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
      <button type="button" class="codex-config-fetch-btn" data-action="saveCodexModelEdit" data-args="[${idx}]">确定</button>
      <button type="button" class="codex-config-catalog-del" data-action="cancelCodexModelEdit">取消</button>
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

function codexAgentModelOptions(selected = '') {
  const models = getCodexModelEntries().map(e => e.model).filter(Boolean);
  if (selected && !models.includes(selected)) models.unshift(selected);
  const inherited = `<option value="" ${selected ? '' : 'selected'}>继承父会话模型</option>`;
  return inherited + models.map(model =>
    `<option value="${platformEsc(model)}" ${model === selected ? 'selected' : ''}>${platformEsc(model)}</option>`
  ).join('');
}

function normalizeCodexAgent(agent = {}) {
  return {
    name: String(agent.name || '').trim(),
    description: String(agent.description || '').trim(),
    developerInstructions: String(agent.developerInstructions || '').trim(),
    model: String(agent.model || '').trim(),
    modelReasoningEffort: String(agent.modelReasoningEffort || '').trim(),
    sandboxMode: String(agent.sandboxMode || '').trim(),
    nicknameCandidates: Array.isArray(agent.nicknameCandidates)
      ? agent.nicknameCandidates.map(n => String(n || '').trim()).filter(Boolean)
      : String(agent.nicknameCandidates || '').split(/[,，\n]/).map(n => n.trim()).filter(Boolean),
  };
}

function renderCodexAgentsPanel(config = null, agents = null) {
  if (config) {
    codexConfigSetInputValue('codex-agents-max-threads', config.maxThreads || 6);
    codexConfigSetInputValue('codex-agents-max-depth', config.maxDepth || 1);
    codexConfigSetInputValue('codex-agents-job-timeout', config.jobMaxRuntimeSeconds || 1800);
  }
  if (Array.isArray(agents)) {
    codexAgentsState = agents.map(normalizeCodexAgent);
  }
  const count = document.getElementById('codex-agents-count');
  if (count) count.textContent = String(codexAgentsState.length);
  const list = document.getElementById('codex-agents-list');
  if (!list) return;
  if (!codexAgentsState.length) {
    list.innerHTML = '<div class="codex-config-model-empty">尚未配置子代理。Codex 只会在用户明确要求时调用子代理。</div>';
    return;
  }
  list.innerHTML = codexAgentsState.map((agent, idx) => {
    const nicknames = agent.nicknameCandidates.join(', ');
    return `<div class="codex-agent-card" data-idx="${idx}">
      <div class="codex-agent-card-head">
        <strong>${platformEsc(agent.name || `agent-${idx + 1}`)}</strong>
        <button type="button" class="codex-config-catalog-del" data-action="removeCodexAgent" data-args="[${idx}]">删除</button>
      </div>
      <div class="codex-agent-grid">
        <label class="codex-config-field">
          <span>名称</span>
          <input class="field-input" value="${platformEsc(agent.name)}" placeholder="code-reviewer" data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;name&quot;]" data-pass-value>
        </label>
        <label class="codex-config-field">
          <span>模型</span>
          <select class="field-input" data-action="updateCodexAgentField" data-events="change" data-args="[${idx},&quot;model&quot;]" data-pass-value>
            ${codexAgentModelOptions(agent.model)}
          </select>
        </label>
        <label class="codex-config-field">
          <span>推理强度</span>
          <select class="field-input" data-action="updateCodexAgentField" data-events="change" data-args="[${idx},&quot;modelReasoningEffort&quot;]" data-pass-value>
            <option value="" ${agent.modelReasoningEffort ? '' : 'selected'}>继承</option>
            <option value="low" ${agent.modelReasoningEffort === 'low' ? 'selected' : ''}>low</option>
            <option value="medium" ${agent.modelReasoningEffort === 'medium' ? 'selected' : ''}>medium</option>
            <option value="high" ${agent.modelReasoningEffort === 'high' ? 'selected' : ''}>high</option>
          </select>
        </label>
        <label class="codex-config-field">
          <span>Sandbox</span>
          <select class="field-input" data-action="updateCodexAgentField" data-events="change" data-args="[${idx},&quot;sandboxMode&quot;]" data-pass-value>
            <option value="" ${agent.sandboxMode ? '' : 'selected'}>继承</option>
            <option value="read-only" ${agent.sandboxMode === 'read-only' ? 'selected' : ''}>read-only</option>
            <option value="workspace-write" ${agent.sandboxMode === 'workspace-write' ? 'selected' : ''}>workspace-write</option>
            <option value="danger-full-access" ${agent.sandboxMode === 'danger-full-access' ? 'selected' : ''}>danger-full-access</option>
          </select>
        </label>
      </div>
      <label class="codex-config-field">
        <span>描述</span>
        <input class="field-input" value="${platformEsc(agent.description)}" placeholder="PR reviewer focused on correctness..." data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;description&quot;]" data-pass-value>
      </label>
      <label class="codex-config-field">
        <span>昵称候选（逗号分隔）</span>
        <input class="field-input" value="${platformEsc(nicknames)}" placeholder="Atlas, Delta" data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;nicknameCandidates&quot;]" data-pass-value>
      </label>
      <label class="codex-config-field">
        <span>Developer Instructions</span>
        <textarea class="field-input codex-agent-instructions" placeholder="Review code like an owner..." data-action="updateCodexAgentField" data-events="input" data-args="[${idx},&quot;developerInstructions&quot;]" data-pass-value>${platformEsc(agent.developerInstructions)}</textarea>
      </label>
    </div>`;
  }).join('');
}

function addCodexAgent() {
  codexAgentsState.push({
    name: `agent-${codexAgentsState.length + 1}`,
    description: '',
    developerInstructions: '',
    model: '',
    modelReasoningEffort: '',
    sandboxMode: 'read-only',
    nicknameCandidates: [],
  });
  renderCodexAgentsPanel(null, codexAgentsState);
}

function removeCodexAgent(idx) {
  codexAgentsState.splice(idx, 1);
  renderCodexAgentsPanel(null, codexAgentsState);
}

function updateCodexAgentField(idx, field, value) {
  if (!codexAgentsState[idx]) return;
  if (field === 'nicknameCandidates') {
    codexAgentsState[idx][field] = String(value || '').split(/[,，\n]/).map(n => n.trim()).filter(Boolean);
  } else {
    codexAgentsState[idx][field] = String(value || '');
  }
  const count = document.getElementById('codex-agents-count');
  if (count) count.textContent = String(codexAgentsState.length);
}

function getCodexAgentsConfig() {
  const maxThreads = Number(document.getElementById('codex-agents-max-threads')?.value || 6);
  const maxDepth = Number(document.getElementById('codex-agents-max-depth')?.value || 1);
  const jobMaxRuntimeSeconds = Number(document.getElementById('codex-agents-job-timeout')?.value || 1800);
  return {
    maxThreads: Number.isInteger(maxThreads) && maxThreads > 0 ? maxThreads : 6,
    maxDepth: Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : 1,
    jobMaxRuntimeSeconds: Number.isInteger(jobMaxRuntimeSeconds) && jobMaxRuntimeSeconds > 0 ? jobMaxRuntimeSeconds : 1800,
  };
}

function getCodexAgents() {
  return codexAgentsState.map(normalizeCodexAgent).filter(agent =>
    agent.name || agent.description || agent.developerInstructions
  );
}

function validateCodexAgents(agents, models) {
  const modelSet = new Set(models);
  const seen = new Set();
  const reserved = new Set(['default', 'worker', 'explorer']);
  for (const agent of agents) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent.name)) {
      return `子代理名称「${agent.name || '(空)'}」无效：必须匹配 ^[a-z][a-z0-9-]{0,63}$`;
    }
    if (reserved.has(agent.name)) return `子代理名称「${agent.name}」是 Codex 内置名称，当前版本不允许覆盖。`;
    const key = agent.name.toLowerCase();
    if (seen.has(key)) return `子代理名称重复：${agent.name}`;
    seen.add(key);
    if (!agent.description) return `子代理「${agent.name}」缺少描述。`;
    if (!agent.developerInstructions) return `子代理「${agent.name}」缺少 Developer Instructions。`;
    if (agent.model && !modelSet.has(agent.model)) return `子代理「${agent.name}」引用的模型「${agent.model}」不在当前模型列表中。`;
    if (agent.modelReasoningEffort && !['low', 'medium', 'high'].includes(agent.modelReasoningEffort)) {
      return `子代理「${agent.name}」的推理强度无效。`;
    }
    if (agent.sandboxMode && !['read-only', 'workspace-write', 'danger-full-access'].includes(agent.sandboxMode)) {
      return `子代理「${agent.name}」的 Sandbox 无效。`;
    }
    const nickSeen = new Set();
    for (const nickname of agent.nicknameCandidates) {
      if (!/^[A-Za-z0-9 _-]+$/.test(nickname)) {
        return `子代理「${agent.name}」的昵称「${nickname}」无效：仅允许 ASCII 字母、数字、空格、连字符和下划线。`;
      }
      const nickKey = nickname.toLowerCase();
      if (nickSeen.has(nickKey)) return `子代理「${agent.name}」的昵称重复：${nickname}`;
      nickSeen.add(nickKey);
    }
  }
  return '';
}

const PLATFORM_EYE_OPEN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const PLATFORM_EYE_CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`;

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

function syncCodexConfigTokenFromSource() {
  const sourceId = String(document.getElementById('codex-config-source-id')?.value || '').trim();
  const editId = String(document.getElementById('codex-config-edit-id')?.value || '').trim();
  const existing = editId ? codexConfigProviderById(editId) : null;
  const targetSourceId = sourceId || existing?.sourceProviderId || '';
  const configName = String(document.getElementById('codex-config-name')?.value || '').trim();

  const source = (providerStore.providers || []).find(p => p && (
    (targetSourceId && p.id === targetSourceId) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('未找到关联的来源供应商，请先在下方选择或关联来源。', '无法同步', 'warn');
    }
    return;
  }

  codexConfigSetInputValue('codex-config-source-id', source.id);
  codexConfigSetInputValue('codex-config-api-key', source.apiKey || '');
  const newEndpoint = codexConfigDisplayBaseUrl(source);
  if (newEndpoint) codexConfigSetInputValue('codex-config-base-url', newEndpoint);

  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌`, 'success');
  }
}

function syncClaudeCodeConfigTokenFromSource() {
  const sourceId = String(document.getElementById('claude-code-config-source-id')?.value || '').trim();
  const editId = String(document.getElementById('claude-code-config-edit-id')?.value || '').trim();
  const existing = editId ? claudeCodeConfigProviderById(editId) : null;
  const targetSourceId = sourceId || existing?.sourceProviderId || '';
  const configName = String(document.getElementById('claude-code-config-name')?.value || '').trim();

  const source = (providerStore.providers || []).find(p => p && (
    (targetSourceId && p.id === targetSourceId) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('未找到关联的来源供应商，请先选择来源。', '无法同步', 'warn');
    }
    return;
  }

  codexConfigSetInputValue('claude-code-config-source-id', source.id);
  codexConfigSetInputValue('claude-code-config-api-key', source.apiKey || '');
  const newEndpoint = claudeCodeConfigDisplayBaseUrl(source);
  if (newEndpoint) codexConfigSetInputValue('claude-code-config-base-url', newEndpoint);
  syncClaudeCodeRawConfigFromFields();

  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌`, 'success');
  }
}

function syncOpenCodeConfigTokenFromSource() {
  const sourceId = String(document.getElementById('opencode-config-source-id')?.value || '').trim();
  const editId = String(document.getElementById('opencode-config-edit-id')?.value || '').trim();
  const existing = editId ? opencodeConfigProviderById(editId) : null;
  const targetSourceId = sourceId || existing?.sourceProviderId || '';
  const configName = String(document.getElementById('opencode-config-name')?.value || '').trim();

  const source = (providerStore.providers || []).find(p => p && (
    (targetSourceId && p.id === targetSourceId) ||
    (configName && (p.name === configName || p.id === configName))
  ));

  if (!source) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('未找到关联的来源供应商，请先选择来源。', '无法同步', 'warn');
    }
    return;
  }

  codexConfigSetInputValue('opencode-config-source-id', source.id);
  codexConfigSetInputValue('opencode-config-api-key', source.apiKey || '');
  const newEndpoint = opencodeConfigDisplayBaseUrl(source);
  if (newEndpoint) codexConfigSetInputValue('opencode-config-base-url', newEndpoint);
  syncOpenCodeRawConfigFromFields();

  if (typeof showBottomToast === 'function') {
    showBottomToast(`已同步供应商「${source.name || source.id}」的最新令牌`, 'success');
  }
}

async function openCodexAddModal() {
  await openCodexConfigEditor();
}

function openCodexProviderAdd() {
  openCodexConfigEditor();
}

async function initCodexAddPage() {
  try {
    codexProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    codexProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    codexProviderModels = codexProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    codexProviderModels.unshift(lp);
  }
  codexAddSelectedProvider = null;
  codexAddSearchKw = '';
  const searchInput = document.getElementById('codex-add-search');
  if (searchInput) searchInput.value = '';
  setCodexAddWireApi('auto');
  renderCodexAddProviderList();
  renderCodexAddModels();
  updateCodexAddConfirmButton();
}

function onCodexAddSearch() {
  const input = document.getElementById('codex-add-search');
  codexAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderCodexAddProviderList();
}

function renderCodexAddProviderList() {
  const list = document.getElementById('codex-add-provider-list');
  syncPlatformAddSortControl('codex');
  if (!list) return;
  if (!codexProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(codexProviderModels, codexAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = codexAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectCodexAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectCodexAddProvider(providerId) {
  codexAddSelectedProvider = providerId;
  renderCodexAddProviderList();
  applyCodexConfigSource(providerId);
}

function renderCodexAddModels() {
  const titleEl = document.getElementById('codex-add-models-title');
  const subEl = document.getElementById('codex-add-models-sub');
  const body = document.getElementById('codex-add-models-list-page');
  if (!body) return;

  if (!codexAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = codexProviderModels.find(p => p.providerId === codexAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要添加到 Codex 的模型`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  const codexConfigs = Array.isArray(providerStore?.codexConfigs) ? providerStore.codexConfigs : [];
  const existingConfig = codexConfigs.find(c => c.sourceProviderId === provider.providerId || c.name === provider.providerName);
  const existingModels = new Set(existingConfig?.models || []);

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models, 'codex');

  body.innerHTML = sortedModels.map((m) => {
    const exists = existingModels.has(m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="codex-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateCodexAddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateCodexAddConfirmButton() {
  const btn = document.getElementById('codex-add-confirm-page');
  if (!btn) return;
  const checked = document.querySelectorAll('.codex-add-model-check:checked');
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    label.textContent = checked.length > 0 ? ` 保存选择 (${checked.length})` : ' 保存选择';
  }
}

function codexAddSelectAll() {
  cbSetAddModelChecks('.codex-add-model-check', true, updateCodexAddConfirmButton);
}

function codexAddSelectNone() {
  cbSetAddModelChecks('.codex-add-model-check', false, updateCodexAddConfirmButton);
}

function setCodexAddWireApi(api) {
  setCodexConfigWireApiRadio(api);
}

async function confirmAddCodexModelsPage() {
  const provider = codexProviderModels.find(p => p.providerId === codexAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.codex-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const checkedModelIds = checkedInputs.map(input => input.dataset.modelId);
  const defaultModel = checkedModelIds[0] || '';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1'}` : '');
  const endpoint = codexConfigEndpointParts(rawBaseUrl);

  const routeThroughProxy = document.getElementById('codex-add-route-through-proxy')?.checked ?? true;
  const injectModels = document.getElementById('codex-add-inject-models')?.checked ?? true;
  const unifySessionHistory = document.getElementById('codex-add-unify-session-history')?.checked ?? true;
  const preserveOfficialAuth = document.getElementById('codex-add-preserve-official-auth')?.checked ?? false;
  const wireApi = document.getElementById('codex-add-wire-api')?.value || 'auto';
  const wireApiAuto = wireApi === 'auto';

  if (!Array.isArray(providerStore.codexConfigs)) providerStore.codexConfigs = [];

  const sanitizedProvider = grok_sanitize_key(provider.providerId);
  const configId = `codex-${sanitizedProvider}`;
  const existingIdx = providerStore.codexConfigs.findIndex(p =>
    p.id === configId || p.sourceProviderId === provider.providerId
  );
  const existing = existingIdx >= 0 ? providerStore.codexConfigs[existingIdx] : null;

  const configItem = {
    ...(existing || {}),
    id: existing?.id || configId,
    name: provider.providerName,
    apiHost: endpoint.apiHost || provider.apiHost,
    apiPath: endpoint.apiPath || provider.apiPath || '/v1',
    apiKey: provider.apiKey || '',
    defaultModel,
    models: checkedModelIds,
    modelCatalog: checkedModelIds,
    wireApi: wireApiAuto ? undefined : wireApi,
    wireApiAuto,
    routeThroughProxy,
    injectModels: !preserveOfficialAuth && injectModels,
    preserveOfficialAuth,
    unifySessionHistory,
    sourceProviderId: provider.providerId,
    sourceProviderName: provider.providerName,
  };

  if (existingIdx >= 0) {
    providerStore.codexConfigs[existingIdx] = configItem;
  } else {
    providerStore.codexConfigs.push(configItem);
  }

  const ok = await syncCodexConfigUiAfterStoreChange();
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 Codex 配置: ${provider.providerName} (${checkedModelIds.length} 个模型)`);
    showCustomAlert(`已成功保存「${provider.providerName}」的 Codex 配置（共 ${checkedModelIds.length} 个模型）。`, '保存成功', 'success');
    navigateTo('platform-codex');
    renderCodexConfigList(platformInfoOf('codex') || {});
  }
}

function setCodexConfigWireApiRadio(api) {
  const normalized = api || 'auto';
  const hidden = document.getElementById('codex-config-wire-api') || document.getElementById('codex-add-wire-api');
  if (hidden) hidden.value = normalized;
  document.querySelectorAll('input[name="codex-config-wire-api-radio"], input[name="codex-add-wire-api-radio"]').forEach(r => {
    r.checked = r.value === normalized;
  });
  refreshCodexWireApiAutoLabel();
  syncCodexRawConfigFromFields();
}

async function openCodexConfigEditor(providerId = '') {
  resetPasswordInputVisibility('codex-config-api-key', 'codex-config-api-key-toggle');
  navigateTo('platform-codex-add');
  await initCodexConfigEditorPage(providerId);
}

async function initCodexConfigEditorPage(providerId = '') {
  try {
    codexProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    codexProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    codexProviderModels = codexProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    codexProviderModels.unshift(lp);
  }
  codexAddSearchKw = '';
  const searchInput = document.getElementById('codex-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? codexConfigProviderById(providerId) : null;
  codexConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('codex-config-page-title');
  const subEl = document.getElementById('codex-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · Codex' : '添加配置 · Codex';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 Codex 配置。`
      : '从现有供应商创建或自由定制一份可切换的 Codex Responses 配置方案。';
  }

  codexConfigSetInputValue('codex-config-edit-id', provider?.id || '');

  if (provider) {
    codexAddSelectedProvider = provider.sourceProviderId || null;
    renderCodexAddProviderList();

    codexConfigSetInputValue('codex-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('codex-config-name', provider.name || '');
    codexConfigSetInputValue('codex-config-base-url', codexConfigDisplayBaseUrl(provider));
    codexConfigSetInputValue('codex-config-api-key', provider.apiKey || '');
    const routeEl = document.getElementById('codex-config-route-through-proxy');
    if (routeEl) routeEl.checked = provider.routeThroughProxy !== false;
    const preserveEl = document.getElementById('codex-config-preserve-official-auth');
    if (preserveEl) preserveEl.checked = !!provider.preserveOfficialAuth;
    const injectEl = document.getElementById('codex-config-inject-models');
    if (injectEl) injectEl.checked = !provider.preserveOfficialAuth && provider.injectModels !== false;
    const unifyEl = document.getElementById('codex-config-unify-session-history');
    if (unifyEl) unifyEl.checked = provider.unifySessionHistory !== false;

    setCodexConfigWireApiRadio(
      provider.wireApiAuto === false ? (codexWireApiOf(provider) || 'responses') : 'auto'
    );
    syncCodexConfigAuthInjectMutualExclusion();
    renderReasoningConfig(provider.codexChatReasoning);

    const catalog = provider.modelCatalog || [];
    const providerModels = codexConfigModelList(provider);
    const merged = mergeCatalogAndModels(catalog, providerModels);
    const defaultModel = provider.defaultModel || '';
    if (defaultModel) {
      const dm = merged.find(e => e.model === defaultModel);
      if (dm) dm.isDefault = true;
    }
    const catalogSet = new Set(catalog.map(e => e.model));
    for (const e of merged) {
      if (!catalogSet.has(e.model)) {
        e.inCatalog = false;
      }
    }
    renderCodexModelManager(merged, defaultModel, merged.length ? `已保存 ${merged.length} 个模型` : '可重新拉取模型列表');
    renderCodexAgentsPanel(provider.agentsConfig || { maxThreads: 6, maxDepth: 1, jobMaxRuntimeSeconds: 1800 }, provider.agents || []);
  } else {
    codexConfigSetInputValue('codex-config-source-id', '');
    codexConfigSetInputValue('codex-config-name', '');
    codexConfigSetInputValue('codex-config-base-url', '');
    codexConfigSetInputValue('codex-config-api-key', '');
    const routeEl = document.getElementById('codex-config-route-through-proxy');
    if (routeEl) routeEl.checked = true;
    const injectEl = document.getElementById('codex-config-inject-models');
    if (injectEl) injectEl.checked = true;
    const preserveEl = document.getElementById('codex-config-preserve-official-auth');
    if (preserveEl) preserveEl.checked = false;
    const unifyEl = document.getElementById('codex-config-unify-session-history');
    if (unifyEl) unifyEl.checked = true;

    setCodexConfigWireApiRadio('auto');
    syncCodexConfigAuthInjectMutualExclusion();
    renderReasoningConfig(null);
    renderCodexModelManager([], '', '选择供应商后拉取模型列表');
    renderCodexAgentsPanel({ maxThreads: 6, maxDepth: 1, jobMaxRuntimeSeconds: 1800 }, []);

    const firstProvider = codexProviderModels[0];
    if (firstProvider) {
      codexAddSelectedProvider = firstProvider.providerId;
      renderCodexAddProviderList();
      applyCodexConfigSource(firstProvider.providerId);
    } else {
      codexAddSelectedProvider = null;
      renderCodexAddProviderList();
    }
  }

  const hasRealDiskFile = await loadPlatformRealConfigFile('codex', 'codex-config-raw-toml');
  if (!hasRealDiskFile) {
    syncCodexRawConfigFromFields();
  }

  window.setTimeout(() => {
    document.getElementById('codex-config-name')?.focus();
  }, 50);
}

function closeCodexConfigEditor() {
  resetPasswordInputVisibility('codex-config-api-key', 'codex-config-api-key-toggle');
  document.getElementById('codex-config-modal')?.classList.remove('active');
  navigateTo('platform-codex');
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

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.codexConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Codex 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('codex-config-name')?.focus();
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
  const agents = getCodexAgents();
  const agentsError = validateCodexAgents(agents, models);
  if (agentsError) {
    showCustomAlert(agentsError, '子代理配置无效', 'warn');
    return;
  }

  const endpoint = typeof providerEndpointParts === 'function'
    ? providerEndpointParts(baseUrl, 'openai', '/v1')
    : { apiHost: baseUrl.replace(/\/+$/, ''), apiPath: '/v1' };
  const existing = editId ? codexConfigProviderById(editId) : null;
  const source = sourceId
    ? (providerStore.providers || []).find(p => p && p.id === sourceId)
    : null;
  // 上游协议：选「自动识别」时按来源供应商的 API 路径推断，否则用用户显式选定的值。
  const wireApiChoice = String(document.getElementById('codex-config-wire-api')?.value || 'auto')
    .trim()
    .toLowerCase();
  const wireApiAuto = wireApiChoice !== 'chat' && wireApiChoice !== 'responses';
  const wireApi = wireApiAuto ? codexInferWireApi(source, existing) : wireApiChoice;
  const routeThroughProxy = document.getElementById('codex-config-route-through-proxy')?.checked !== false;
  syncCodexConfigAuthInjectMutualExclusion();
  const preserveOfficialAuth = document.getElementById('codex-config-preserve-official-auth')?.checked === true;
  // preserve 优先：与 codexProviderNeedsInject / 后端 watcher 一致
  const injectModels = preserveOfficialAuth
    ? false
    : document.getElementById('codex-config-inject-models')?.checked !== false;
  const unifySessionHistory = document.getElementById('codex-config-unify-session-history')?.checked !== false;

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
    wireApiAuto,
    modelCatalog: modelCatalog.length ? modelCatalog : undefined,
    codexChatReasoning: getReasoningConfig(),
    agentsConfig: agents.length ? getCodexAgentsConfig() : undefined,
    agents: agents.length ? agents : undefined,
    routeThroughProxy,
    injectModels,
    preserveOfficialAuth,
    unifySessionHistory,
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
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
  }
  if (type === 'config') {
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
  }
  if (type === 'start') {
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
  }
  return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
}

function codexReconfigureAction(action, disabled) {
  return `<button class="codex-current-action codex-reconfigure-action" type="button" title="重新写入当前配置" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(action)}">重新配置</button>`;
}

function renderCodexConfigCard(config) {
  const disabled = platformBusy === (config.platformId || 'codex');
  const editButton = config.editAction
    ? `<button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="编辑" aria-label="编辑 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.editAction)}">${codexActionIcon('edit')}</button>`
    : '';
  const deleteButton = config.deleteAction
    ? `<button class="btn-icon model-map-action-btn danger codex-icon-action codex-delete-action" type="button" title="删除" aria-label="删除 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.deleteAction)}">${codexActionIcon('delete')}</button>`
    : '';
  const removeButton = config.removeAction
    ? `<button class="btn-icon model-map-action-btn danger codex-icon-action codex-delete-action" type="button" title="${platformEsc(config.removeLabel || '移除')}" aria-label="从 live 配置移除 ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.removeAction)}">${codexActionIcon('delete')}</button>`
    : '';
  const configButton = config.configAction
    ? `<button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="${platformEsc(config.configLabel || '配置模型')}" aria-label="${platformEsc(config.configLabel || '配置')} ${platformEsc(config.name)}" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.configAction)}">${codexActionIcon('config')}</button>`
    : '';
  const desktopSupported = codexDesktopAutomationSupported();
  const startDisabled = disabled || !desktopSupported;
  const startTitle = desktopSupported ? '重启 Codex 桌面版' : '仅 Windows 支持自动启动 / 注入 Codex Desktop';
  const startButton = config.startAction
    ? `<button class="btn-icon model-map-action-btn codex-icon-action" type="button" title="${platformEsc(startTitle)}" aria-label="启动 Codex ${platformEsc(config.name)}" ${startDisabled ? 'disabled' : ''} data-action-call="${platformEsc(config.startAction)}">${codexActionIcon('start')}</button>`
    : '';
  const switchButton = config.current || !config.action
    ? ''
    : `<button class="btn-primary codex-switch-action" ${disabled ? 'disabled' : ''} data-action-call="${platformEsc(config.action)}">${platformEsc(config.actionLabel || '切换')}</button>`;
  const reconfigureButton = config.current && config.action
    ? `${codexReconfigureAction(config.action, disabled)}`
    : '';
  const iconActions = [editButton, deleteButton, removeButton, configButton, startButton].filter(Boolean).join('');
  const mainAction = switchButton || reconfigureButton || '';
  const actions = (iconActions || mainAction)
    ? `<div class="codex-config-actions">
        ${iconActions ? `<div class="codex-card-icon-actions">${iconActions}</div>` : ''}
        ${mainAction ? `<div class="codex-card-main-action">${mainAction}</div>` : ''}
      </div>`
    : '<span class="codex-row-muted">-</span>';
  const agentCount = Array.isArray(config.agents) ? config.agents.length : Number(config.agentCount || 0);
  const meta = codexConfigMetaLine([
    config.model || '-',
    config.endpoint || '-',
    config.protocol || 'responses',
    agentCount > 0 ? `子代理: ${agentCount}` : '',
  ]);
  return `
    <article class="codex-config-card ${config.current ? 'current' : ''} ${platformEsc(config.tone || '')}">
      <div class="codex-config-main">
        <div class="codex-config-title">
          <strong title="${platformEsc(config.name)}">${platformEsc(config.name)}</strong>
          ${config.current ? '<span class="codex-config-badge-current">当前使用</span>' : ''}
          ${codexConfigBadge(config.typeLabel || '第三方', config.tone)}
          ${config.injectBadge === 'success'
            ? '<span class="codex-config-badge-success">✓ codex 桌面版正确显示模型</span>'
            : config.injectBadge === 'muted'
              ? '<span class="codex-config-badge-muted">codex 桌面版使用默认模型</span>'
              : ''}
          ${config.preserveAuthBadge === 'success'
            ? '<span class="codex-config-badge-success">✓ 保留官方登录</span>'
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
  const isCurrent = codexProviderIsCurrent(provider, info);

  const confirmMsg = isCurrent
    ? `「${provider.name || provider.id}」当前正在生效中。\n\n删除该配置将自动为您恢复为「官方默认配置」。是否确认删除？`
    : `确定要删除 Codex 配置「${provider.name || provider.id}」吗？`;

  const okConfirm = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!okConfirm) return;

  if (isCurrent) {
    await restoreCodexOfficialConfig();
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
    name: '官方默认配置',
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
    const preserveAuth = codexProviderPreservesOfficialAuth(provider);
    const needInject = codexProviderNeedsInject(provider);
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
      // 三态：success=注入；muted=主动关闭注入；空=保留官方登录（由 preserveAuth 徽章说明）
      injectBadge: needInject ? 'success' : (preserveAuth ? '' : 'muted'),
      preserveAuthBadge: preserveAuth ? 'success' : '',
      action: `applyCodexProviderConfig(${platformJsArg(provider.id)})`,
      editAction: `editCodexProviderConfig(${platformJsArg(provider.id)})`,
      startAction: current ? `startCodexWithCdp(${needInject ? 'true' : 'false'})` : '',
      deleteAction: `deleteCodexProviderConfig(${platformJsArg(provider.id)})`,
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

// ═══════ Antigravity 配置与模型管理 ═══════

globalThis.antigravityProviderModels = [];
globalThis.antigravityAddSelectedProvider = null;
globalThis.antigravityAddSearchKw = '';
globalThis._antigravitySearchKeyword = '';
globalThis._antigravitySelectedSet = new Set();
globalThis.antigravityConfigEditorMode = 'edit';

function renderAntigravityPageStatus(info) {
  antigravityRefreshConsole({ silent: true });
}

function antigravityPageRoot() {
  return document.getElementById('page-platform-antigravity');
}

// ═══════ Antigravity 运行模式切换（纯 BYOK vs 混合模式） ═══════
function getAntigravityCurrentMode() {
  return (providerStore && providerStore.antigravityMode === 'hybrid') ? 'hybrid' : 'pure';
}

function syncAntigravityModeUi(mode) {
  const currentMode = mode || getAntigravityCurrentMode();
  const btns = document.querySelectorAll('.antigravity-mode-seg-btn');
  btns.forEach(btn => {
    const btnMode = btn.dataset.mode;
    btn.classList.toggle('is-active', btnMode === currentMode);
  });
}

async function selectAntigravityMode(mode) {
  const targetMode = mode === 'hybrid' ? 'hybrid' : 'pure';
  if (!providerStore) providerStore = {};
  syncAntigravityModeUi(targetMode);
  if (providerStore.antigravityMode === targetMode) return;

  providerStore.antigravityMode = targetMode;

  try {
    if (typeof invoke === 'function') {
      await invoke('save_providers', { store: providerStore });
    }
    const modeDesc = targetMode === 'hybrid' ? '混合模式（保留官方 + 自建）' : '纯 BYOK 模式（免登谷歌，纯走自建）';
    if (typeof showBottomToast === 'function') {
      showBottomToast(`已切换为${modeDesc}`, 'success');
    }
    if (typeof addLog === 'function') {
      addLog('info', `Antigravity 运行模式已切换为：${targetMode}`);
    }
  } catch (e) {
    if (typeof showBottomToast === 'function') {
      showBottomToast('保存模式失败: ' + (e?.message || e), 'error');
    }
  }
}

async function antigravityRefreshConsole(options = {}) {
  const root = antigravityPageRoot();
  if (!root) return;

  syncAntigravityModeUi();

  const info = platformInfoOf('antigravity');
  const managed = !!info?.managedByAnyBridge;

  // 1. 更新顶部接入状态与按钮 (完全对齐 Windsurf / Cursor 统一接入规范)
  const mainBtn = document.getElementById('antigravity-main-btn');
  const mainBtnText = document.getElementById('antigravity-main-btn-text');
  const mainBtnIcon = mainBtn?.querySelector('.proxy-btn-icon');
  const restoreBtn = document.getElementById('antigravityRestoreBtn');

  if (mainBtn && mainBtnText) {
    mainBtn.classList.add('platform-proxy-primary');
    mainBtn.classList.remove('platform-proxy-active');
    if (managed) {
      mainBtn.classList.add('is-connected');
      if (mainBtnIcon) {
        mainBtnIcon.innerHTML = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>';
      }
      mainBtnText.textContent = '已接入';
      mainBtn.setAttribute('aria-label', 'Antigravity 已接入 AnyBridge');
    } else {
      mainBtn.classList.remove('is-connected');
      if (mainBtnIcon) {
        mainBtnIcon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
      }
      mainBtnText.textContent = '一键接入';
      mainBtn.setAttribute('aria-label', '一键接入 Antigravity');
    }
  }

  if (restoreBtn) {
    restoreBtn.disabled = !managed;
    restoreBtn.classList.toggle('is-danger', managed);
    restoreBtn.setAttribute('aria-label', managed ? '停止 Antigravity 接入 AnyBridge' : 'Antigravity 当前未接入');
  }

  bindRevealPathLabel('antigravity-config-path-label', info?.configPath || platformDef('antigravity').configHint);

  // 2. 清理不存在的选中项
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const validIds = new Set(configs.map(c => c.id));
  _antigravitySelectedSet = new Set(Array.from(_antigravitySelectedSet).filter(id => validIds.has(id)));

  // 3. 渲染数据表格
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityGetFilteredList() {
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const kw = (_antigravitySearchKeyword || '').trim().toLowerCase();
  if (!kw) return configs;
  return configs.filter(item => {
    return [
      item.name,
      item.id,
      item.defaultModel,
      item.sourceProviderName,
      item.apiFormat,
      item.apiHost,
      item.apiPath,
    ].some(v => String(v || '').toLowerCase().includes(kw));
  });
}

function antigravityRenderTableRows() {
  const tbody = document.getElementById('antigravityModelTableBody');
  const empty = document.getElementById('antigravity-model-empty');
  const table = document.getElementById('antigravity-model-table');
  const countPill = document.getElementById('antigravity-model-count');
  if (!tbody) return;

  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  if (countPill) countPill.textContent = `共 ${configs.length} 个`;

  if (configs.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';

  const list = antigravityGetFilteredList();
  const kw = (_antigravitySearchKeyword || '').trim();

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 36px 0;">
          未找到匹配「${platformEsc(kw)}」的 Antigravity 模型
        </td>
      </tr>
    `;
    return;
  }

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  let html = '';
  list.forEach(item => {
    const isChecked = _antigravitySelectedSet.has(item.id);
    const displayName = (item.name || item.defaultModel || item.id).trim();
    const exposedModel = (item.defaultModel || item.id).trim();
    const providerName = (item.sourceProviderName || item.name || '自定义供应商').trim();
    const isEnabled = item.enabled !== false && item.injectModels !== false;
    const isVisionEnabled = item.useThirdPartyVision === true;
    const protocol = (item.apiFormat || 'openai').toUpperCase();

    const iconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(exposedModel, { size: 20 })
      : `<span style="color:var(--accent);">✦</span>`;

    const visionTitle = !hasVisionModels
      ? '请先在「代理增强」中配置图片理解模型'
      : (isVisionEnabled ? '已启用第三方图片理解（点击关闭）' : '启用后图片将使用第三方模型理解（点击启用）');

    html += `
      <tr class="${isChecked ? 'cb-model-row-selected is-selected' : ''}" data-config-id="${platformEsc(item.id)}" style="min-height: 52px;">
        <td class="cb-select-cell" style="text-align: center; padding-left: 14px;">
          <label class="provider-select-check provider-select-check-table" data-stop data-action="__noop">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="antigravityToggleRowSelect('${platformEsc(item.id)}', this.checked)">
            <span></span>
          </label>
        </td>
        <td class="display-name-cell">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--bg-input);border:1px solid var(--border);flex:0 0 24px;">
              ${iconHtml}
            </div>
            <div style="min-width:0;flex:1;">
              <strong style="font-weight:750;color:var(--text-primary);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${platformEsc(displayName)}">${platformEsc(displayName)}</strong>
            </div>
          </div>
        </td>
        <td>
          <code style="font-size:12px;color:var(--text-secondary);background:var(--bg-input);padding:2px 6px;border-radius:4px;border:1px solid var(--border);">${platformEsc(exposedModel)}</code>
        </td>
        <td>
          <span style="font-size:12px;color:var(--text-primary);font-weight:600;">${platformEsc(providerName)}</span>
        </td>
        <td>
          <span class="platform-badge" style="font-size:11px;padding:1px 6px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;">${platformEsc(protocol)}</span>
        </td>
        <td>
          <div class="model-map-actions">
            <button class="btn-icon model-map-action-btn" type="button" title="编辑模型" aria-label="编辑模型" onclick="editAntigravityProviderConfig('${platformEsc(item.id)}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" type="button" title="从 Antigravity 移除" aria-label="从 Antigravity 移除" onclick="deleteAntigravityProviderConfig('${platformEsc(item.id)}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${platformEsc(visionTitle)}">
            <input type="checkbox" ${isVisionEnabled ? 'checked' : ''} onchange="antigravityToggleThirdPartyVision('${platformEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${isEnabled ? '已向 Antigravity 暴露（点击停用）' : '已停用（点击启用）'}">
            <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="antigravityToggleModelEnabled('${platformEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function antigravityFilterModels(keyword) {
  _antigravitySearchKeyword = keyword || '';
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityToggleSelectAll(checked) {
  const visible = antigravityGetFilteredList();
  if (checked) {
    visible.forEach(m => _antigravitySelectedSet.add(m.id));
  } else {
    visible.forEach(m => _antigravitySelectedSet.delete(m.id));
  }
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityToggleSelectAllVisible() {
  const visible = antigravityGetFilteredList();
  if (!visible.length) return;
  const allSelected = visible.every(m => _antigravitySelectedSet.has(m.id));
  antigravityToggleSelectAll(!allSelected);
}

function antigravityToggleRowSelect(id, checked) {
  if (checked) _antigravitySelectedSet.add(id);
  else _antigravitySelectedSet.delete(id);
  antigravityRenderTableRows();
  antigravityUpdateBulkActionButtons();
}

function antigravityUpdateBulkActionButtons() {
  const count = _antigravitySelectedSet.size;
  const selectAll = document.getElementById('antigravitySelectAll');
  const visible = antigravityGetFilteredList();

  if (selectAll) {
    selectAll.checked = visible.length > 0 && visible.every(m => _antigravitySelectedSet.has(m.id));
  }

  const enableBtn = document.getElementById('antigravity-bulk-enable-btn');
  const disableBtn = document.getElementById('antigravity-bulk-disable-btn');
  const visionBtn = document.getElementById('antigravity-bulk-vision-btn');
  const removeBtn = document.getElementById('antigravity-bulk-remove-btn');

  if (enableBtn) enableBtn.disabled = count === 0;
  if (disableBtn) disableBtn.disabled = count === 0;
  if (visionBtn) visionBtn.disabled = count === 0;
  if (removeBtn) removeBtn.disabled = count === 0;
}

async function antigravityToggleThirdPartyVision(id, checked) {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  const target = providerStore.antigravityConfigs.find(c => c.id === id);
  if (!target) return;

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (checked && !hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置图片理解模型。', '无法启用', 'warn');
    antigravityRenderTableRows();
    return;
  }

  target.useThirdPartyVision = !!checked;
  antigravityRenderTableRows();
  await syncAntigravityConfigUiAfterStoreChange();
}

async function antigravityBulkThirdPartyVisionAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs) || _antigravitySelectedSet.size === 0) return;
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (!hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置第三方图片理解模型。', '无法启用', 'warn');
    return;
  }

  providerStore.antigravityConfigs.forEach(c => {
    if (_antigravitySelectedSet.has(c.id)) {
      c.useThirdPartyVision = true;
    }
  });
  antigravityRenderTableRows();
  await syncAntigravityConfigUiAfterStoreChange();
  showBottomToast(`已批量启用 ${_antigravitySelectedSet.size} 个模型的第三方图片理解`, 'success');
}

async function antigravityToggleModelEnabled(id, checked) {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  const target = providerStore.antigravityConfigs.find(c => c.id === id);
  if (target) {
    target.enabled = checked;
    target.injectModels = checked;
    await syncAntigravityConfigUiAfterStoreChange();
  }
}

async function antigravityBulkEnableAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  providerStore.antigravityConfigs.forEach(c => {
    if (_antigravitySelectedSet.has(c.id)) {
      c.enabled = true;
      c.injectModels = true;
    }
  });
  await syncAntigravityConfigUiAfterStoreChange();
  showBottomToast(`已批量启用 ${_antigravitySelectedSet.size} 个 Antigravity 模型`, 'success');
}

async function antigravityBulkDisableAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  providerStore.antigravityConfigs.forEach(c => {
    if (_antigravitySelectedSet.has(c.id)) {
      c.enabled = false;
      c.injectModels = false;
    }
  });
  await syncAntigravityConfigUiAfterStoreChange();
  showBottomToast(`已批量停用 ${_antigravitySelectedSet.size} 个 Antigravity 模型`, 'info');
}

async function antigravityBulkRemoveAction() {
  if (!Array.isArray(providerStore?.antigravityConfigs)) return;
  const count = _antigravitySelectedSet.size;
  if (count === 0) return;
  const ok = await showCustomConfirm(`确认从 Antigravity 列表中移除选中的 ${count} 个模型吗？`, '移除模型', 'warn');
  if (!ok) return;

  providerStore.antigravityConfigs = providerStore.antigravityConfigs.filter(c => !_antigravitySelectedSet.has(c.id));
  _antigravitySelectedSet.clear();
  await syncAntigravityConfigUiAfterStoreChange();
  showBottomToast(`已移除 ${count} 个模型`, 'success');
}

async function antigravityPrimaryAction() {
  const info = platformInfoOf('antigravity');
  if (info?.managedByAnyBridge) {
    showCustomAlert('Antigravity 当前已成功接入 AnyBridge。\n\n如需断开连接，请点击右侧「停止接入」按钮。', '已处于接入状态', 'info');
    return;
  }

  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const activeProviderId = configs.find(c => c.enabled !== false)?.id || configs[0]?.id || '';

  setPlatformBusy('antigravity', true);
  try {
    if (typeof addLog === 'function') addLog('info', '正在配置 Antigravity 接入 settings.json 与环境变量…');
    const result = assertSwitchResultOk(
      await invoke('switch_platform', { platform: 'antigravity', providerId: activeProviderId }),
      'Antigravity 接入失败'
    );
    if (typeof addLog === 'function') {
      addLog('ok', result.message || 'Antigravity 已成功接入 AnyBridge');
    }
    await refreshPlatforms({ silent: true, reloadProviders: false });
    antigravityRefreshConsole({ silent: true });

    // 精简交互：不再单独弹前置确认窗口，直接由唯一的「重启 IDE」弹窗作为确认点
    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('Antigravity 已接入 AnyBridge，重启 IDE 后生效。', 'antigravity', { mode: 'proxy' });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Antigravity 接入失败: ' + e);
    showCustomAlert(String(e?.message || e), '接入失败', 'error');
  } finally {
    setPlatformBusy('antigravity', false);
  }
}

async function antigravityRestoreAction() {
  await restoreAntigravityOfficialConfig();
  antigravityRefreshConsole({ silent: true });
}

async function restoreAntigravityOfficialConfig() {
  const info = platformInfoOf('antigravity') || {};
  const alreadyOfficial = !info.managedByAnyBridge;
  if (alreadyOfficial) {
    showCustomAlert('Antigravity 当前已经是官方直连模式，无需重复恢复。', '提示', 'info');
    return;
  }

  setPlatformBusy('antigravity', true);
  try {
    if (typeof addLog === 'function') addLog('info', '正在恢复 Antigravity 官方配置…');
    const result = assertSwitchResultOk(
      await invoke('restore_antigravity_official_config'),
      'Antigravity 官方配置还原失败'
    );
    if (typeof addLog === 'function') {
      addLog('ok', result.message || 'Antigravity 已恢复官方模式');
    }
    await refreshPlatforms({ silent: true, reloadProviders: false });
    antigravityRefreshConsole({ silent: true });

    // 精简交互：不再单独弹前置确认窗口，直接由唯一的「重启 IDE」弹窗作为确认点
    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('Antigravity 已切回官方直连，重启 IDE 后生效。', 'antigravity', { mode: 'direct' });
    }
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'Antigravity 切回官方失败: ' + e);
    showCustomAlert(String(e?.message || e), '切回官方失败', 'error');
  } finally {
    setPlatformBusy('antigravity', false);
  }
}

function renderAntigravityConfigList(info = {}) {
  if (typeof antigravityRefreshConsole === 'function') {
    antigravityRefreshConsole({ silent: true });
  }
}

async function syncAntigravityConfigUiAfterStoreChange() {
  if (typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) return false;
  }
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
  if (typeof renderModelMap === 'function') await renderModelMap();
  if (typeof antigravityRefreshConsole === 'function') antigravityRefreshConsole({ silent: true });
  renderPlatformProviderOptions();
  return true;
}

async function openAntigravityAddPage() {
  navigateTo('platform-antigravity-add');
  await initAntigravityAddPage();
}
const openAntigravityAddModal = openAntigravityAddPage;

async function initAntigravityAddPage() {
  try {
    antigravityProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    antigravityProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    antigravityProviderModels = antigravityProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    antigravityProviderModels.unshift(lp);
  }
  antigravityAddSearchKw = '';
  const searchInput = document.getElementById('antigravity-add-search');
  if (searchInput) searchInput.value = '';

  const sorted = platformAddVisibleProviders(antigravityProviderModels, '');
  const firstWithModels = sorted.find(p => p.models && p.models.length > 0) || sorted[0];
  antigravityAddSelectedProvider = firstWithModels ? firstWithModels.providerId : null;

  renderAntigravityAddProviderList();
  renderAntigravityAddModels();
  updateAntigravityAddConfirmButton();
}

function onAntigravityAddSearch() {
  const input = document.getElementById('antigravity-add-search');
  antigravityAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderAntigravityAddProviderList();
}

function renderAntigravityAddProviderList() {
  const list = document.getElementById('antigravity-add-provider-list');
  syncPlatformAddSortControl('antigravity');
  if (!list) return;
  if (!antigravityProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(antigravityProviderModels, antigravityAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = antigravityAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectAntigravityAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectAntigravityAddProvider(providerId) {
  antigravityAddSelectedProvider = providerId;
  renderAntigravityAddProviderList();
  renderAntigravityAddModels();
  updateAntigravityAddConfirmButton();
}

function renderAntigravityAddModels() {
  const titleEl = document.getElementById('antigravity-add-models-title');
  const subEl = document.getElementById('antigravity-add-models-sub');
  const body = document.getElementById('antigravity-add-models-list-page');
  if (!body) return;

  if (!antigravityAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = antigravityProviderModels.find(p => p.providerId === antigravityAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要注入到 Antigravity 的模型`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  const agConfigs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const existingModels = new Set();
  agConfigs.forEach(c => {
    if (c.sourceProviderId === provider.providerId || c.sourceProviderName === provider.providerName || c.name === provider.providerName) {
      if (c.defaultModel) existingModels.add(c.defaultModel);
      if (Array.isArray(c.models)) c.models.forEach(m => existingModels.add(m));
    }
  });

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models);

  body.innerHTML = sortedModels.map((m) => {
    const exists = existingModels.has(m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}">
        <input type="checkbox" class="antigravity-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateAntigravityAddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateAntigravityAddConfirmButton() {
  const btn = document.getElementById('antigravity-add-confirm-page');
  if (!btn) return;
  const checked = document.querySelectorAll('.antigravity-add-model-check:checked');
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    label.textContent = checked.length > 0 ? ` 保存选择 (${checked.length})` : ' 保存选择';
  }
}

function antigravityAddSelectAll() {
  cbSetAddModelChecks('.antigravity-add-model-check', true, updateAntigravityAddConfirmButton);
}

function antigravityAddSelectNone() {
  cbSetAddModelChecks('.antigravity-add-model-check', false, updateAntigravityAddConfirmButton);
}

async function confirmAddAntigravityModelsPage() {
  const provider = antigravityProviderModels.find(p => p.providerId === antigravityAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }

  const checkedBoxes = document.querySelectorAll('.antigravity-add-model-check:checked');
  const checkedModelIds = Array.from(checkedBoxes).map(cb => cb.dataset.modelId).filter(Boolean);
  if (!checkedModelIds.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const btn = document.getElementById('antigravity-add-confirm-page');
  const label = btn ? btn.querySelector('.model-action-label') : null;
  const originalLabel = label ? label.textContent : ` 保存选择 (${checkedModelIds.length})`;
  if (btn) {
    btn.disabled = true;
    if (label) label.textContent = ' 保存中...';
  }

  try {
    if (!Array.isArray(providerStore.antigravityConfigs)) {
      providerStore.antigravityConfigs = [];
    }

    checkedModelIds.forEach(modelId => {
      const entryId = `ag-${provider.providerId}-${modelId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const existing = providerStore.antigravityConfigs.find(c => c.id === entryId || (c.sourceProviderId === provider.providerId && c.defaultModel === modelId));
      if (existing) {
        existing.enabled = true;
        existing.injectModels = true;
        existing.apiHost = provider.apiHost || existing.apiHost || '';
        existing.apiPath = provider.apiPath || existing.apiPath || '';
        existing.apiKey = provider.apiKey || existing.apiKey || '';
        existing.apiFormat = provider.apiFormat || existing.apiFormat || 'openai';
      } else {
        providerStore.antigravityConfigs.push({
          id: entryId,
          name: modelId,
          apiHost: provider.apiHost || '',
          apiPath: provider.apiPath || '',
          apiKey: provider.apiKey || '',
          apiFormat: provider.apiFormat || 'openai',
          defaultModel: modelId,
          models: [modelId],
          enabled: true,
          injectModels: true,
          sourceProviderId: provider.providerId,
          sourceProviderName: provider.providerName,
        });
      }
    });

    const ok = await syncAntigravityConfigUiAfterStoreChange();
    if (ok) {
      navigateTo('platform-antigravity');
      antigravityRefreshConsole({ silent: true });
    }
  } catch (err) {
    console.error('[antigravity-add] confirm add failed:', err);
    showCustomAlert('添加模型失败: ' + err, '添加异常', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      if (label) label.textContent = originalLabel;
    }
  }
}

function openAntigravityConfigEditor(providerId = '') {
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const provider = configs.find(c => c.id === providerId);
  if (!provider) return;

  antigravityConfigEditorMode = 'edit';
  const modal = document.getElementById('antigravity-config-modal');
  const title = document.getElementById('antigravity-config-modal-title');
  const sub = document.getElementById('antigravity-config-modal-sub');

  if (title) title.textContent = '编辑 Antigravity 模型';
  if (sub) sub.textContent = `正在编辑「${provider.name || provider.defaultModel}」的配置。`;

  const editIdEl = document.getElementById('antigravity-config-edit-id');
  const nameEl = document.getElementById('antigravity-config-name');
  const modelEl = document.getElementById('antigravity-config-model');
  const apiFormatEl = document.getElementById('antigravity-config-api-format');
  const injectModelsEl = document.getElementById('antigravity-config-inject-models');
  const visionEl = document.getElementById('antigravity-config-use-third-party-vision');

  if (editIdEl) editIdEl.value = provider.id || '';
  if (nameEl) nameEl.value = provider.name || '';
  if (modelEl) modelEl.value = provider.defaultModel || '';
  if (apiFormatEl) apiFormatEl.value = provider.apiFormat || 'openai';
  if (injectModelsEl) injectModelsEl.checked = provider.injectModels !== false;
  if (visionEl) visionEl.checked = provider.useThirdPartyVision === true;

  if (modal) modal.classList.add('active');
}

function closeAntigravityConfigEditor() {
  const modal = document.getElementById('antigravity-config-modal');
  if (modal) modal.classList.remove('active');
}

async function saveAntigravityConfigEditor() {
  const editId = String(document.getElementById('antigravity-config-edit-id')?.value || '').trim();
  const name = String(document.getElementById('antigravity-config-name')?.value || '').trim();
  const defaultModel = String(document.getElementById('antigravity-config-model')?.value || '').trim();
  const apiFormat = String(document.getElementById('antigravity-config-api-format')?.value || 'openai').trim();
  const injectModels = document.getElementById('antigravity-config-inject-models')?.checked !== false;
  const useThirdPartyVision = document.getElementById('antigravity-config-use-third-party-vision')?.checked === true;

  if (!name) {
    showCustomAlert('显示名称不能为空。', '保存失败', 'warn');
    return;
  }

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (useThirdPartyVision && !hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置图片理解模型，才能启用第三方图片理解。', '无法启用图片理解', 'warn');
    return;
  }

  if (!Array.isArray(providerStore.antigravityConfigs)) {
    providerStore.antigravityConfigs = [];
  }

  const existing = providerStore.antigravityConfigs.find(c => c.id === editId);
  if (existing) {
    existing.name = name;
    existing.defaultModel = defaultModel;
    existing.apiFormat = apiFormat;
    existing.injectModels = injectModels;
    existing.useThirdPartyVision = useThirdPartyVision;
  }

  const ok = await syncAntigravityConfigUiAfterStoreChange();
  if (ok) {
    closeAntigravityConfigEditor();
    showCustomAlert(`模型「${name}」已成功保存。`, '保存成功', 'success');
  }
}

function deleteAntigravityProviderConfig(providerId) {
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const provider = configs.find(c => c.id === providerId);
  if (!provider) return;
  showCustomConfirm(`确认从 Antigravity 列表中移除「${provider.name || provider.defaultModel}」吗？`, '移除模型', 'warn').then(async ok => {
    if (!ok) return;
    providerStore.antigravityConfigs = providerStore.antigravityConfigs.filter(p => p.id !== providerId);
    _antigravitySelectedSet.delete(providerId);
    await syncAntigravityConfigUiAfterStoreChange();
    if (typeof addLog === 'function') addLog('info', `已移除 Antigravity 模型: ${provider.name || provider.defaultModel}`);
  });
}

function editAntigravityProviderConfig(providerId) {
  openAntigravityConfigEditor(providerId);
}

function openAntigravitySettingsModal() {
  const modal = document.getElementById('antigravitySettingsModal');
  if (modal) modal.classList.add('active');
}

function closeAntigravitySettingsModal() {
  const modal = document.getElementById('antigravitySettingsModal');
  if (modal) modal.classList.remove('active');
}

function saveAntigravitySettingsModal() {
  const select = document.getElementById('modal-antigravity-context-window');
  if (select) {
    const val = select.value;
    showBottomToast(`上下文压缩容量已设为 ${Math.round(parseInt(val, 10) / 1024)}K`, 'success');
  }
  closeAntigravitySettingsModal();
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

const CLAUDE_ROLES = [
  { role: 'sonnet', modelKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL', nameKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', label: 'Sonnet', has1m: true },
  { role: 'opus', modelKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL', nameKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', label: 'Opus', has1m: true },
  { role: 'fable', modelKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL', nameKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', label: 'Fable', has1m: true },
  { role: 'haiku', modelKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', nameKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', label: 'Haiku', has1m: false },
  { role: 'subagent', modelKey: 'CLAUDE_CODE_SUBAGENT_MODEL', nameKey: null, label: 'Subagent', has1m: true },
];

function hasClaude1mMarker(val) {
  return /\[1m\]$/i.test(String(val || '').trim());
}

function stripClaude1mMarker(val) {
  return String(val || '').trim().replace(/\[1m\]$/i, '').trim();
}

function applyClaude1mMarker(val, enabled) {
  const base = stripClaude1mMarker(val);
  if (!base) return '';
  return enabled ? `${base}[1M]` : base;
}

function onClaude1mCheckboxChanged(role, checked) {
  const box = document.getElementById(`claude-1m-box-${role}`);
  if (box) box.classList.toggle('active', !!checked);
  syncClaudeCodeRawConfigFromFields();
}

function setClaude1mCheckbox(role, checked) {
  const cb = document.getElementById(`claude-1m-${role}`);
  if (cb) cb.checked = !!checked;
  const box = document.getElementById(`claude-1m-box-${role}`);
  if (box) box.classList.toggle('active', !!checked);
}

function getClaude1mCheckbox(role) {
  const cb = document.getElementById(`claude-1m-${role}`);
  return !!cb?.checked;
}

function onClaudeRoleFieldInput() {
  syncClaudeCodeRawConfigFromFields();
}

function claudeCodeSettingsFromFields() {
  const baseUrl = String(document.getElementById('claude-code-config-base-url')?.value || '').trim();
  const apiKey = String(document.getElementById('claude-code-config-api-key')?.value || '').trim();

  const settings = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    includeCoAuthoredBy: false,
    env: {},
    permissions: {},
    hooks: {},
    mcpServers: {}
  };

  const env = settings.env;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;

  // 1. 各角色模型
  CLAUDE_ROLES.forEach(r => {
    const idVal = String(document.getElementById(`claude-model-id-${r.role}`)?.value || '').trim();
    const nameVal = String(document.getElementById(`claude-model-name-${r.role}`)?.value || '').trim();
    const use1m = r.has1m ? getClaude1mCheckbox(r.role) : false;

    if (idVal) {
      env[r.modelKey] = applyClaude1mMarker(idVal, use1m);
    }
    if (r.nameKey && (nameVal || idVal)) {
      env[r.nameKey] = stripClaude1mMarker(nameVal || idVal);
    }
  });

  // 2. 默认兜底模型
  const fbVal = String(document.getElementById('claude-code-config-model')?.value || '').trim();
  const fb1m = getClaude1mCheckbox('fallback');
  if (fbVal) {
    env.ANTHROPIC_MODEL = applyClaude1mMarker(fbVal, fb1m);
    settings.model = env.ANTHROPIC_MODEL;
  } else if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    env.ANTHROPIC_MODEL = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    settings.model = env.ANTHROPIC_MODEL;
  }

  // 3. 特性与重试参数
  const maxRetries = document.getElementById('claude-add-max-retries')?.value;
  if (maxRetries != null && maxRetries !== '') {
    const num = parseInt(maxRetries, 10);
    if (!isNaN(num)) env.MAX_RETRIES = String(num);
  }

  return settings;
}

function claudeCodeSettingsTextFromFields() {
  return claudeCodeRawConfigTextFromSettings(claudeCodeSettingsFromFields());
}

function claudeCodeSetRawSettings(settings) {
  codexConfigSetInputValue('claude-code-config-raw-json', claudeCodeRawConfigTextFromSettings(settings));
}

function claudeCodeCreateSettingsFromCurrentFields() {
  return claudeCodeSettingsFromFields();
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
  claudeCodeApplySettingsToRoleForm(settings);
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

globalThis.claudeCodeAvailableModels = [];

function refreshAllClaudeRoleSelects(models = null) {
  if (Array.isArray(models)) {
    const clean = models.map(stripClaude1mMarker).filter(Boolean);
    claudeCodeAvailableModels = [...new Set(clean)];
  }

  const roleConfigs = [
    { containerId: 'claude-role-select-sonnet', hiddenInputId: 'claude-model-id-sonnet', role: 'sonnet' },
    { containerId: 'claude-role-select-opus', hiddenInputId: 'claude-model-id-opus', role: 'opus' },
    { containerId: 'claude-role-select-fable', hiddenInputId: 'claude-model-id-fable', role: 'fable', optional: true },
    { containerId: 'claude-role-select-haiku', hiddenInputId: 'claude-model-id-haiku', role: 'haiku' },
    { containerId: 'claude-role-select-subagent', hiddenInputId: 'claude-model-id-subagent', role: 'subagent' },
    { containerId: 'claude-role-select-fallback', hiddenInputId: 'claude-code-config-model', role: 'fallback' },
  ];

  const sourceId = document.getElementById('claude-code-config-source-id')?.value;
  const p = (providerStore.providers || []).find(x => x.id === sourceId);
  const groupLabel = p?.name ? `供应商【${p.name}】可用模型 (${claudeCodeAvailableModels.length})` : `可用模型列表 (${claudeCodeAvailableModels.length})`;

  const renderFn = typeof globalThis.renderCustomRoleSelect === 'function' ? globalThis.renderCustomRoleSelect : null;

  roleConfigs.forEach(({ containerId, hiddenInputId, role, optional }) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    let hiddenInput = document.getElementById(hiddenInputId);
    if (!hiddenInput) {
      hiddenInput = document.createElement('input');
      hiddenInput.type = 'hidden';
      hiddenInput.id = hiddenInputId;
      container.appendChild(hiddenInput);
    }
    let curVal = stripClaude1mMarker(hiddenInput.value || '');

    // 如果还没有值且非可选，给第一个模型作为默认值
    if (!curVal && !optional && claudeCodeAvailableModels.length) {
      curVal = claudeCodeAvailableModels[0];
      hiddenInput.value = curVal;
    }

    const availableItems = claudeCodeAvailableModels.map(m => ({ id: m, label: m, provider: '' }));
    if (curVal && !availableItems.some(it => it.id === curVal)) {
      availableItems.unshift({ id: curVal, label: curVal, provider: '已保存' });
    }

    if (renderFn) {
      renderFn({
        containerId,
        hiddenInputId,
        role,
        currentValue: curVal,
        groupLabel,
        items: availableItems,
        optional: !!optional,
      });
    }
  });
}

function setClaudeRoleSelectValue(id, val) {
  let hiddenInput = document.getElementById(id);
  const clean = stripClaude1mMarker(val || '');
  if (hiddenInput) {
    hiddenInput.value = clean;
  }
  refreshAllClaudeRoleSelects();
}

function isGenericClaudeRoleName(name = '', role = '') {
  if (!name) return true;
  const s = name.trim().toLowerCase();
  return s === role.toLowerCase() || s.startsWith('claude') || s.includes('sonnet') || s.includes('opus') || s.includes('fable') || s.includes('haiku');
}

async function onClaudeRoleSelectChange(role, value) {
  const hiddenInputId = `claude-model-id-${role}`;
  let hiddenInput = document.getElementById(hiddenInputId);
  if (hiddenInput) {
    hiddenInput.value = value;
  }

  // 联动显示名称：自动更新为选中的模型名称
  const cleanVal = stripClaude1mMarker(value || '');
  const nameInput = document.getElementById(`claude-model-name-${role}`);
  if (nameInput) {
    nameInput.value = cleanVal;
  }

  // 联动 1M 勾选
  const baseUrl = document.getElementById('claude-code-config-base-url')?.value || '';
  const name = document.getElementById('claude-code-config-name')?.value || '';
  const isAnyRouter = isAnyRouterEndpoint(baseUrl, name);
  const roleMeta = CLAUDE_ROLES.find(r => r.role === role);
  if (roleMeta && roleMeta.has1m) {
    setClaude1mCheckbox(role, isAnyRouter && isClaudeModel(value));
  }

  refreshAllClaudeRoleSelects();
  syncClaudeCodeRawConfigFromFields();
}

async function onClaudeFallbackSelectChange(value) {
  let hiddenInput = document.getElementById('claude-code-config-model');
  if (hiddenInput) {
    hiddenInput.value = value;
  }

  const baseUrl = document.getElementById('claude-code-config-base-url')?.value || '';
  const name = document.getElementById('claude-code-config-name')?.value || '';
  const isAnyRouter = isAnyRouterEndpoint(baseUrl, name);
  setClaude1mCheckbox('fallback', isAnyRouter && isClaudeModel(value));

  refreshAllClaudeRoleSelects();
  syncClaudeCodeRawConfigFromFields();
}

function claudeCodeApplySettingsToRoleForm(settings, provider = null) {
  const env = settings && typeof settings === 'object' ? settings.env || {} : {};

  // 收集所有已配置的模型并刷新下拉框
  const modelsInConfig = [];
  CLAUDE_ROLES.forEach(r => {
    if (env[r.modelKey]) modelsInConfig.push(env[r.modelKey]);
  });
  if (env.ANTHROPIC_MODEL) modelsInConfig.push(env.ANTHROPIC_MODEL);
  if (settings?.model) modelsInConfig.push(settings.model);
  if (provider?.defaultModel) modelsInConfig.push(provider.defaultModel);
  if (Array.isArray(provider?.models)) modelsInConfig.push(...provider.models);
  refreshAllClaudeRoleSelects(modelsInConfig);

  // 2. 各角色回填
  CLAUDE_ROLES.forEach(r => {
    const rawModel = env[r.modelKey] || '';
    const rawName = r.nameKey ? (env[r.nameKey] || '') : '';
    const cleanId = stripClaude1mMarker(rawModel);
    const cleanName = stripClaude1mMarker(rawName || cleanId);
    const use1m = r.has1m ? hasClaude1mMarker(rawModel) : false;

    if (cleanId) setClaudeRoleSelectValue(`claude-model-id-${r.role}`, cleanId);
    if (r.nameKey) {
      const nameInput = document.getElementById(`claude-model-name-${r.role}`);
      if (nameInput) nameInput.value = cleanName;
    }
    if (r.has1m) {
      setClaude1mCheckbox(r.role, use1m);
    }
  });

  // 3. 兜底模型回填
  const rawFallback = env.ANTHROPIC_MODEL || settings?.model || provider?.defaultModel || '';
  const cleanFallback = stripClaude1mMarker(rawFallback);
  const fallback1m = hasClaude1mMarker(rawFallback);
  if (cleanFallback) setClaudeRoleSelectValue('claude-code-config-model', cleanFallback);
  setClaude1mCheckbox('fallback', fallback1m);

  // 如果某些角色为空，用 fallback 补齐
  if (cleanFallback) {
    CLAUDE_ROLES.forEach(r => {
      const sel = document.getElementById(`claude-model-id-${r.role}`);
      if (sel && !sel.value) {
        setClaudeRoleSelectValue(`claude-model-id-${r.role}`, cleanFallback);
        if (r.has1m) setClaude1mCheckbox(r.role, fallback1m);
      }
      if (r.nameKey) {
        const nameInput = document.getElementById(`claude-model-name-${r.role}`);
        if (nameInput && !nameInput.value.trim()) {
          nameInput.value = cleanFallback;
        }
      }
    });
  }

  // 4. 重试与特性
  if (env.MAX_RETRIES != null) {
    const maxRetriesEl = document.getElementById('claude-add-max-retries');
    if (maxRetriesEl) maxRetriesEl.value = env.MAX_RETRIES;
  }
}

function claudeCodeExtractModelsFromRoleForm() {
  const models = [];
  CLAUDE_ROLES.forEach(r => {
    const idVal = String(document.getElementById(`claude-model-id-${r.role}`)?.value || '').trim();
    const use1m = r.has1m ? getClaude1mCheckbox(r.role) : false;
    if (idVal && idVal !== '__custom__') models.push(applyClaude1mMarker(idVal, use1m));
  });
  const fbVal = String(document.getElementById('claude-code-config-model')?.value || '').trim();
  const fb1m = getClaude1mCheckbox('fallback');
  if (fbVal && fbVal !== '__custom__') models.push(applyClaude1mMarker(fbVal, fb1m));
  return [...new Set(models.filter(Boolean))];
}

function claudeCodeQuickSetAllModels() {
  const fbVal = document.getElementById('claude-code-config-model')?.value?.trim();
  const sonnetVal = document.getElementById('claude-model-id-sonnet')?.value?.trim();
  const opusVal = document.getElementById('claude-model-id-opus')?.value?.trim();
  const fableVal = document.getElementById('claude-model-id-fable')?.value?.trim();
  const haikuVal = document.getElementById('claude-model-id-haiku')?.value?.trim();
  const subagentVal = document.getElementById('claude-model-id-subagent')?.value?.trim();

  const sourceVal = (fbVal && fbVal !== '__custom__')
    ? fbVal
    : (sonnetVal && sonnetVal !== '__custom__')
    ? sonnetVal
    : (opusVal && opusVal !== '__custom__')
    ? opusVal
    : (fableVal && fableVal !== '__custom__')
    ? fableVal
    : (haikuVal && haikuVal !== '__custom__')
    ? haikuVal
    : (subagentVal && subagentVal !== '__custom__')
    ? subagentVal
    : '';

  if (!sourceVal) {
    showCustomAlert('请先在上方任意角色下拉框或默认兜底模型中选择一个模型。', '未指定模型', 'info');
    return;
  }

  const cleanId = stripClaude1mMarker(sourceVal);
  const baseUrl = document.getElementById('claude-code-config-base-url')?.value || '';
  const name = document.getElementById('claude-code-config-name')?.value || '';
  const isAnyRouter = isAnyRouterEndpoint(baseUrl, name);
  const use1m = isAnyRouter && isClaudeModel(cleanId);

  CLAUDE_ROLES.forEach(r => {
    setClaudeRoleSelectValue(`claude-model-id-${r.role}`, cleanId);
    if (r.nameKey) {
      const nameInput = document.getElementById(`claude-model-name-${r.role}`);
      if (nameInput) nameInput.value = cleanId;
    }
    if (r.has1m) {
      setClaude1mCheckbox(r.role, use1m);
    }
  });

  setClaudeRoleSelectValue('claude-code-config-model', cleanId);
  setClaude1mCheckbox('fallback', use1m);

  syncClaudeCodeRawConfigFromFields();
  if (typeof addLog === 'function') addLog('ok', `已将模型「${cleanId}」一键应用到所有角色`);
  showCustomAlert(`已将「${cleanId}」一键应用到所有角色。`, '设置成功', 'success');
}

function applyClaudeCodeConfigSource(providerId) {
  const source = (providerStore.providers || []).find(p => p && p.id === providerId);
  if (!source) return;
  codexConfigSetInputValue('claude-code-config-source-id', source.id);
  codexConfigSetInputValue('claude-code-config-name', source.name || '');
  const baseUrl = claudeCodeConfigDisplayBaseUrl(source);
  codexConfigSetInputValue('claude-code-config-base-url', baseUrl);
  codexConfigSetInputValue('claude-code-config-api-key', source.apiKey || '');

  const isAnyRouter = isAnyRouterEndpoint(baseUrl, source.name || '');
  const models = codexConfigModelList(source);
  refreshAllClaudeRoleSelects(models);

  const fallbackModel = stripClaude1mMarker(source.defaultModel || models[0] || 'claude-3-7-sonnet-20250219');
  const isClaude = isClaudeModel(fallbackModel);
  const use1m = isAnyRouter && isClaude;

  // 铺满所有角色下拉框
  CLAUDE_ROLES.forEach(r => {
    setClaudeRoleSelectValue(`claude-model-id-${r.role}`, fallbackModel);
    if (r.nameKey) {
      const nameInput = document.getElementById(`claude-model-name-${r.role}`);
      if (nameInput) nameInput.value = fallbackModel;
    }
    if (r.has1m) setClaude1mCheckbox(r.role, use1m);
  });

  setClaudeRoleSelectValue('claude-code-config-model', fallbackModel);
  setClaude1mCheckbox('fallback', use1m);

  claudeCodeConfigSetModelStatus(`已带入 ${models.length} 个模型到下拉框`, 'success');
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
    const isAnyRouter = isAnyRouterEndpoint(baseUrl, document.getElementById('claude-code-config-name')?.value || '');
    let rawModels = result?.models || [];
    let models = codexConfigNormalizeModels(rawModels);
    if (!models.length) throw new Error('接口返回的模型列表为空');

    // 刷新所有下拉框选项
    refreshAllClaudeRoleSelects(models);

    // 同步更新当前选中供应商在界面列表与内存中的模型，并持久化
    const currentSourceId = document.getElementById('claude-code-config-source-id')?.value;
    if (currentSourceId) {
      const pInList = (claudeProviderModels || []).find(p => p.providerId === currentSourceId);
      if (pInList) {
        pInList.models = models.map(m => ({ id: m, name: m }));
      }
      const pInStore = (providerStore.providers || []).find(p => p.id === currentSourceId);
      if (pInStore) {
        pInStore.models = [...models];
        if (typeof persistProviders === 'function') {
          persistProviders();
        }
      }
      renderClaudeAddProviderList();
    }

    // 如果当前各角色全为空，则以第一个模型自动一键铺满
    const currentFb = document.getElementById('claude-code-config-model')?.value?.trim();
    const currentSonnet = document.getElementById('claude-model-id-sonnet')?.value?.trim();
    if ((!currentFb || currentFb === '__custom__') && (!currentSonnet || currentSonnet === '__custom__') && models[0]) {
      const clean = stripClaude1mMarker(models[0]);
      const use1m = isAnyRouter && isClaudeModel(clean);

      CLAUDE_ROLES.forEach(r => {
        setClaudeRoleSelectValue(`claude-model-id-${r.role}`, clean);
        if (r.nameKey) {
          const nameInput = document.getElementById(`claude-model-name-${r.role}`);
          if (nameInput) nameInput.value = clean;
        }
        if (r.has1m) setClaude1mCheckbox(r.role, use1m);
      });
      setClaudeRoleSelectValue('claude-code-config-model', clean);
      setClaude1mCheckbox('fallback', use1m);
    }

    claudeCodeConfigSetModelStatus(`已拉取 ${models.length} 个模型（可在下拉框中直接点选）`, 'success');
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

async function openClaudeCodeAddModal() {
  await openClaudeCodeConfigEditor();
}

function openClaudeCodeProviderAdd() {
  openClaudeCodeConfigEditor();
}

async function initClaudeCodeConfigEditorPage(providerId = '') {
  try {
    claudeProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    claudeProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    claudeProviderModels = claudeProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    claudeProviderModels.unshift(lp);
  }
  claudeAddSearchKw = '';
  const searchInput = document.getElementById('claude-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? claudeCodeConfigProviderById(providerId) : null;
  claudeCodeConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('claude-code-config-page-title');
  const subEl = document.getElementById('claude-code-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · Claude Code' : '添加配置 · Claude Code';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 Claude Code 配置。`
      : '从现有 Anthropic 供应商创建或自由定制一份可切换的 Claude Code 独立配置。';
  }

  codexConfigSetInputValue('claude-code-config-edit-id', provider?.id || '');

  if (provider) {
    claudeAddSelectedProvider = provider.sourceProviderId || null;
    renderClaudeAddProviderList();

    codexConfigSetInputValue('claude-code-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('claude-code-config-name', provider.name || '');
    const baseUrl = claudeCodeConfigDisplayBaseUrl(provider);
    codexConfigSetInputValue('claude-code-config-base-url', baseUrl);
    codexConfigSetInputValue('claude-code-config-api-key', provider.apiKey || '');

    // 回填角色模型与 1M 复选框
    claudeCodeApplySettingsToRoleForm(provider.settingsConfig, provider);

    const sourceProvider = (providerStore.providers || []).find(p => p.id === provider.sourceProviderId);
    const sourceModels = sourceProvider ? codexConfigModelList(sourceProvider) : [];
    const models = codexConfigModelList(provider);
    const allCandidates = [...new Set([...models, ...sourceModels])];
    refreshAllClaudeRoleSelects(allCandidates);
    claudeCodeConfigSetModelStatus(`已加载「${provider.name || provider.id}」配置`, 'success');
    claudeCodeSetRawSettings(provider.settingsConfig || claudeCodeBuildSettingsForProvider(provider, models));
  } else {
    codexConfigSetInputValue('claude-code-config-source-id', '');
    codexConfigSetInputValue('claude-code-config-name', '');
    codexConfigSetInputValue('claude-code-config-base-url', '');
    codexConfigSetInputValue('claude-code-config-api-key', '');
    refreshAllClaudeRoleSelects([]);
    setClaudeRoleSelectValue('claude-code-config-model', '');
    CLAUDE_ROLES.forEach(r => {
      setClaudeRoleSelectValue(`claude-model-id-${r.role}`, '');
      if (r.nameKey) {
        const nameInput = document.getElementById(`claude-model-name-${r.role}`);
        if (nameInput) nameInput.value = '';
      }
      if (r.has1m) setClaude1mCheckbox(r.role, false);
    });
    setClaude1mCheckbox('fallback', false);
    claudeCodeConfigSetModelStatus('请选择左侧供应商带入或手动填写', '');

    const firstProvider = claudeProviderModels[0];
    if (firstProvider) {
      claudeAddSelectedProvider = firstProvider.providerId;
      renderClaudeAddProviderList();
      applyClaudeCodeConfigSource(firstProvider.providerId);
    } else {
      claudeAddSelectedProvider = null;
      renderClaudeAddProviderList();
    }
  }

  await loadPlatformRealConfigFile('claude-code', 'claude-code-config-raw-json');

  window.setTimeout(() => {
    document.getElementById('claude-code-config-name')?.focus();
  }, 50);
}

async function initClaudeAddPage() {
  await initClaudeCodeConfigEditorPage();
}

function onClaudeAddSearch() {
  const input = document.getElementById('claude-add-search');
  claudeAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderClaudeAddProviderList();
}

function renderClaudeAddProviderList() {
  const list = document.getElementById('claude-add-provider-list');
  syncPlatformAddSortControl('claude');
  if (!list) return;
  if (!claudeProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(claudeProviderModels, claudeAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = claudeAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectClaudeAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectClaudeAddProvider(providerId) {
  claudeAddSelectedProvider = providerId;
  renderClaudeAddProviderList();
  applyClaudeCodeConfigSource(providerId);
}

function renderClaudeAddModels() {
  const titleEl = document.getElementById('claude-add-models-title');
  const subEl = document.getElementById('claude-add-models-sub');
  const body = document.getElementById('claude-add-models-list-page');
  if (!body) return;

  if (!claudeAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = claudeProviderModels.find(p => p.providerId === claudeAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要添加到 Claude Code 的模型`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  const claudeConfigs = Array.isArray(providerStore?.claudeCodeConfigs) ? providerStore.claudeCodeConfigs : [];
  const existingConfig = claudeConfigs.find(c => c.sourceProviderId === provider.providerId || c.name === provider.providerName);
  const existingModels = new Set(existingConfig?.models || []);

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models, 'claude');

  body.innerHTML = sortedModels.map((m) => {
    const exists = existingModels.has(m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="claude-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateClaudeAddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateClaudeAddConfirmButton() {
  const btn = document.getElementById('claude-add-confirm-page');
  if (!btn) return;
  const checked = document.querySelectorAll('.claude-add-model-check:checked');
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    label.textContent = checked.length > 0 ? ` 保存选择 (${checked.length})` : ' 保存选择';
  }
}

function claudeAddSelectAll() {
  cbSetAddModelChecks('.claude-add-model-check', true, updateClaudeAddConfirmButton);
}

function claudeAddSelectNone() {
  cbSetAddModelChecks('.claude-add-model-check', false, updateClaudeAddConfirmButton);
}

async function confirmAddClaudeModelsPage() {
  const provider = claudeProviderModels.find(p => p.providerId === claudeAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.claude-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const checkedModelIds = checkedInputs.map(input => input.dataset.modelId);
  const defaultModel = checkedModelIds[0] || '';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1/messages'}` : '');
  const endpoint = claudeCodeConfigEndpointParts(rawBaseUrl);

  const maxRetries = Number(document.getElementById('claude-add-max-retries')?.value || 10);

  if (!Array.isArray(providerStore.claudeCodeConfigs)) providerStore.claudeCodeConfigs = [];

  const sanitizedProvider = grok_sanitize_key(provider.providerId);
  const configId = `claude-code-${sanitizedProvider}`;
  const existingIdx = providerStore.claudeCodeConfigs.findIndex(p =>
    p.id === configId || p.sourceProviderId === provider.providerId
  );
  const existing = existingIdx >= 0 ? providerStore.claudeCodeConfigs[existingIdx] : null;

  const settingsConfig = claudeCodeBuildSettingsForProvider({
    name: provider.providerName,
    apiHost: endpoint.apiHost || provider.apiHost,
    apiPath: endpoint.apiPath || provider.apiPath || '/v1/messages',
    apiKey: provider.apiKey || '',
    settingsConfig: existing?.settingsConfig || null,
  }, checkedModelIds);

  if (settingsConfig && settingsConfig.env) {
    settingsConfig.env.ANTHROPIC_MAX_RETRIES = String(maxRetries);
  }

  const configItem = {
    ...(existing || {}),
    id: existing?.id || configId,
    name: provider.providerName,
    apiHost: endpoint.apiHost || provider.apiHost,
    apiPath: endpoint.apiPath || provider.apiPath || '/v1/messages',
    apiKey: provider.apiKey || '',
    defaultModel,
    models: checkedModelIds,
    settingsConfig,
    sourceProviderId: provider.providerId,
    sourceProviderName: provider.providerName,
  };

  if (existingIdx >= 0) {
    providerStore.claudeCodeConfigs[existingIdx] = configItem;
  } else {
    providerStore.claudeCodeConfigs.push(configItem);
  }

  const ok = await syncClaudeCodeConfigUiAfterStoreChange();
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 Claude Code 配置: ${provider.providerName} (${checkedModelIds.length} 个模型)`);
    showCustomAlert(`已成功保存「${provider.providerName}」的 Claude Code 配置（共 ${checkedModelIds.length} 个模型）。`, '保存成功', 'success');
    navigateTo('platform-claude-code');
    renderClaudeCodeConfigList(platformInfoOf('claude-code') || {});
  }
}

async function openClaudeCodeConfigEditor(providerId = '') {
  resetPasswordInputVisibility('claude-code-config-api-key', 'claude-code-config-api-key-toggle');
  navigateTo('platform-claude-add');
  await initClaudeCodeConfigEditorPage(providerId);
}

function closeClaudeCodeConfigEditor() {
  resetPasswordInputVisibility('claude-code-config-api-key', 'claude-code-config-api-key-toggle');
  document.getElementById('claude-code-config-modal')?.classList.remove('active');
  navigateTo('platform-claude-code');
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
  const isAnyRouter = isAnyRouterEndpoint(baseUrl, name);
  defaultModel = ensureOneMContextMarker(defaultModel, isAnyRouter);
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
  const models = claudeCodeExtractModelsFromRoleForm();
  if (!models.length) {
    showCustomAlert('请至少在角色映射表中输入一个模型（例如 Sonnet 或默认兜底模型）。', '模型未填写', 'warn');
    return;
  }
  if (!defaultModel) {
    defaultModel = models[0];
    codexConfigSetInputValue('claude-code-config-model', defaultModel);
  }

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.claudeCodeConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Claude Code 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('claude-code-config-name')?.focus();
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
  const isCurrent = claudeCodeProviderIsCurrent(provider, info);

  const confirmMsg = isCurrent
    ? `「${provider.name || provider.id}」当前正在生效中。\n\n删除该配置将自动为您恢复为「官方默认配置」。是否确认删除？`
    : `确定要删除 Claude Code 配置「${provider.name || provider.id}」吗？`;

  const okConfirm = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!okConfirm) return;

  if (isCurrent) {
    await restoreClaudeCodeOfficialConfig();
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
    name: '官方默认配置',
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
      deleteAction: `deleteClaudeCodeProviderConfig(${platformJsArg(provider.id)})`,
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
        ${isDefault ? '<span class="opencode-model-default-badge">默认 ✓</span>' : '<span style="font-size:11px;color:var(--text-muted);opacity:0.8;margin-left:auto;">点击设为默认</span>'}
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

async function openOpenCodeAddModal() {
  await openOpenCodeConfigEditor();
}

function openOpenCodeProviderAdd() {
  openOpenCodeConfigEditor();
}

async function initOpenCodeConfigEditorPage(providerId = '') {
  try {
    opencodeProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    opencodeProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    opencodeProviderModels = opencodeProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    opencodeProviderModels.unshift(lp);
  }
  opencodeAddSearchKw = '';
  const searchInput = document.getElementById('opencode-add-search');
  if (searchInput) searchInput.value = '';

  const provider = providerId ? opencodeConfigProviderById(providerId) : null;
  opencodeConfigEditorMode = provider ? 'edit' : 'create';

  const titleEl = document.getElementById('opencode-config-page-title');
  const subEl = document.getElementById('opencode-config-page-sub');
  if (titleEl) {
    titleEl.textContent = provider ? '编辑配置 · OpenCode' : '添加配置 · OpenCode';
  }
  if (subEl) {
    subEl.textContent = provider
      ? `正在编辑「${provider.name || provider.id}」这份 OpenCode 配置。`
      : '从现有供应商创建或自由定制一份独立 OpenCode provider 配置方案。';
  }

  codexConfigSetInputValue('opencode-config-edit-id', provider?.id || '');

  if (provider) {
    opencodeAddSelectedProvider = provider.sourceProviderId || null;
    renderOpenCodeAddProviderList();

    codexConfigSetInputValue('opencode-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('opencode-config-name', provider.name || '');
    codexConfigSetInputValue('opencode-config-base-url', opencodeConfigDisplayBaseUrl(provider));
    codexConfigSetInputValue('opencode-config-api-key', provider.apiKey || '');
    const models = codexConfigModelList(provider);
    codexConfigSetInputValue('opencode-config-model', provider.defaultModel || models[0] || '');
    opencodeConfigSetModels(models, provider.defaultModel || models[0] || '', models.length ? `已保存 ${models.length} 个模型` : '可重新拉取模型列表');
    opencodeSetRawSettings(opencodeBuildSettingsForProvider(provider, models));
  } else {
    codexConfigSetInputValue('opencode-config-source-id', '');
    codexConfigSetInputValue('opencode-config-name', '');
    codexConfigSetInputValue('opencode-config-base-url', '');
    codexConfigSetInputValue('opencode-config-api-key', '');
    codexConfigSetInputValue('opencode-config-model', '');
    opencodeConfigSetModels([], '', '选择供应商后拉取模型列表');

    const firstProvider = opencodeProviderModels[0];
    if (firstProvider) {
      opencodeAddSelectedProvider = firstProvider.providerId;
      renderOpenCodeAddProviderList();
      applyOpenCodeConfigSource(firstProvider.providerId);
    } else {
      opencodeAddSelectedProvider = null;
      renderOpenCodeAddProviderList();
    }
  }

  await loadPlatformRealConfigFile('opencode', 'opencode-config-raw-json');

  window.setTimeout(() => {
    document.getElementById('opencode-config-name')?.focus();
  }, 50);
}

async function initOpenCodeAddPage() {
  await initOpenCodeConfigEditorPage();
}

function onOpenCodeAddSearch() {
  const input = document.getElementById('opencode-add-search');
  opencodeAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderOpenCodeAddProviderList();
}

function renderOpenCodeAddProviderList() {
  const list = document.getElementById('opencode-add-provider-list');
  syncPlatformAddSortControl('opencode');
  if (!list) return;
  if (!opencodeProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(opencodeProviderModels, opencodeAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = opencodeAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectOpenCodeAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectOpenCodeAddProvider(providerId) {
  opencodeAddSelectedProvider = providerId;
  renderOpenCodeAddProviderList();
  applyOpenCodeConfigSource(providerId);
}

function renderOpenCodeAddModels() {
  const titleEl = document.getElementById('opencode-add-models-title');
  const subEl = document.getElementById('opencode-add-models-sub');
  const body = document.getElementById('opencode-add-models-list-page');
  if (!body) return;

  if (!opencodeAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = opencodeProviderModels.find(p => p.providerId === opencodeAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要添加到 OpenCode 的模型`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  const opencodeConfigs = Array.isArray(providerStore?.opencodeConfigs) ? providerStore.opencodeConfigs : [];
  const existingConfig = opencodeConfigs.find(c => c.sourceProviderId === provider.providerId || c.name === provider.providerName);
  const existingModels = new Set(existingConfig?.models || []);

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models);

  body.innerHTML = sortedModels.map((m) => {
    const exists = existingModels.has(m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="opencode-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateOpenCodeAddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateOpenCodeAddConfirmButton() {
  const btn = document.getElementById('opencode-add-confirm-page');
  if (!btn) return;
  const checked = document.querySelectorAll('.opencode-add-model-check:checked');
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    label.textContent = checked.length > 0 ? ` 保存选择 (${checked.length})` : ' 保存选择';
  }
}

function opencodeAddSelectAll() {
  cbSetAddModelChecks('.opencode-add-model-check', true, updateOpenCodeAddConfirmButton);
}

function opencodeAddSelectNone() {
  cbSetAddModelChecks('.opencode-add-model-check', false, updateOpenCodeAddConfirmButton);
}

async function confirmAddOpenCodeModelsPage() {
  const provider = opencodeProviderModels.find(p => p.providerId === opencodeAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.opencode-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const checkedModelIds = checkedInputs.map(input => input.dataset.modelId);
  const defaultModel = checkedModelIds[0] || '';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1'}` : '');
  const endpoint = opencodeConfigEndpointParts(rawBaseUrl);

  if (!Array.isArray(providerStore.opencodeConfigs)) providerStore.opencodeConfigs = [];

  const sanitizedProvider = grok_sanitize_key(provider.providerId);
  const configId = `opencode-${sanitizedProvider}`;
  const existingIdx = providerStore.opencodeConfigs.findIndex(p =>
    p.id === configId || p.sourceProviderId === provider.providerId
  );
  const existing = existingIdx >= 0 ? providerStore.opencodeConfigs[existingIdx] : null;

  const settingsConfig = opencodeBuildSettingsForProvider({
    name: provider.providerName,
    apiHost: endpoint.apiHost || provider.apiHost,
    apiPath: endpoint.apiPath || provider.apiPath || '/v1',
    apiKey: provider.apiKey || '',
    settingsConfig: existing?.settingsConfig || null,
  }, checkedModelIds);

  const configItem = {
    ...(existing || {}),
    id: existing?.id || configId,
    name: provider.providerName,
    apiHost: endpoint.apiHost || provider.apiHost,
    apiPath: endpoint.apiPath || provider.apiPath || '/v1',
    apiKey: provider.apiKey || '',
    defaultModel,
    models: checkedModelIds,
    settingsConfig,
    sourceProviderId: provider.providerId,
    sourceProviderName: provider.providerName,
  };

  if (existingIdx >= 0) {
    providerStore.opencodeConfigs[existingIdx] = configItem;
  } else {
    providerStore.opencodeConfigs.push(configItem);
  }

  const ok = await syncOpenCodeConfigUiAfterStoreChange();
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 OpenCode 配置: ${provider.providerName} (${checkedModelIds.length} 个模型)`);
    showCustomAlert(`已成功保存「${provider.providerName}」的 OpenCode 配置（共 ${checkedModelIds.length} 个模型）。`, '保存成功', 'success');
    navigateTo('platform-opencode');
    renderOpenCodeConfigList(platformInfoOf('opencode') || {});
  }
}

async function openOpenCodeConfigEditor(providerId = '') {
  resetPasswordInputVisibility('opencode-config-api-key', 'opencode-config-api-key-toggle');
  navigateTo('platform-opencode-add');
  await initOpenCodeConfigEditorPage(providerId);
}

function closeOpenCodeConfigEditor() {
  resetPasswordInputVisibility('opencode-config-api-key', 'opencode-config-api-key-toggle');
  document.getElementById('opencode-config-modal')?.classList.remove('active');
  navigateTo('platform-opencode');
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

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.opencodeConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 OpenCode 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('opencode-config-name')?.focus();
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
  const isLive = openCodeProviderIsLive(provider, info);

  const confirmMsg = isLive
    ? `「${provider.name || provider.id}」已加入 OpenCode 运行配置。\n\n删除该配置将自动从 OpenCode 中移除并删除。是否确认？`
    : `确定要删除 OpenCode 配置「${provider.name || provider.id}」吗？`;

  const okConfirm = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!okConfirm) return;

  if (isLive) {
    await removeOpenCodeProviderConfig(providerId);
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

async function restoreOpenCodeOfficialConfig() {
  const info = platformInfoOf('opencode') || {};
  const isOfficial = !info.managedByAnyBridge;
  const message = isOfficial
    ? 'OpenCode 当前已经是官方配置。仍要清理 AnyBridge 写入的托管提供商与当前 model 吗？'
    : '将把 OpenCode 切回官方配置。\n\n这会清除 AnyBridge 写入的第三方提供商与当前 model 设定，恢复使用 OpenCode 官方 Zen / Go 套餐与官方登录凭证（auth.json）。新会话或重启 OpenCode 后生效。';
  const ok = await showCustomConfirm(message, '切回官方配置', 'warn');
  if (!ok) return;

  setPlatformBusy('opencode', true);
  showSwitchProgress('opencode', '正在准备切回官方配置…');
  try {
    const result = await invoke('restore_opencode_official_config');
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'OpenCode 已切回官方配置');
    showCustomAlert(result.message || 'OpenCode 已切回官方配置。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `OpenCode 切回官方失败: ${e}`);
    showCustomAlert(String(e), '切回官方失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('opencode', false);
    renderPlatformDetailStatuses();
  }
}

function renderOpenCodeConfigList(info) {
  const list = document.getElementById('platform-opencode-config-list');
  if (!list) return;

  const providers = platformProviderList('opencode');
  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  const isOfficial = !info.managedByAnyBridge;
  const items = [];

  items.push({
    platformId: 'opencode',
    name: '官方默认配置',
    description: '使用 OpenCode 官方订阅套餐（Zen / Go）与官方登录凭证（opencode auth login），无需配置第三方 API。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: isOfficial,
    currentLabel: '当前使用',
    model: '官方默认 (Zen / Go)',
    endpoint: '~/.config/opencode/opencode.json',
    protocol: 'OpenCode 官方',
    action: 'restoreOpenCodeOfficialConfig()',
    actionLabel: '切回官方',
  });

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
      actionLabel: '切换',
      editAction: `editOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
      deleteAction: `deleteOpenCodeProviderConfig(${platformJsArg(provider.id)})`,
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

// ═══════ Grok Build CLI 配置管理器 ═══════

globalThis.grokConfigSearch = '';
globalThis.grokConfigEditorMode = 'create';

function grok_sanitize_key(key) {
  const s = String(key || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'anybridge';
}

function grokConfigProviderById(id) {
  return (providerStore.grokConfigs || []).find(p => p && p.id === id) || null;
}

function grokConfigSourceProviders() {
  const providers = (providerStore && Array.isArray(providerStore.providers))
    ? providerStore.providers
    : [];
  return providers.filter(p => p && p.enabled !== false && p.apiFormat === 'openai' && !platformIsLocalProxyConfig(p));
}

function renderGrokPageStatus(info) {
  const headline = document.getElementById('platform-grok-headline');
  if (headline) headline.textContent = 'xAI 终端智能体 CLI · 管理自定义模型与端点配置';
  bindRevealPathLabel('grok-config-path-label', info.configPath || platformDef('grok').configHint);
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
  codexConfigSetInputValue('grok-config-name', source.name || '');
  codexConfigSetInputValue('grok-config-base-url', openai_base_url_from_source(source));
  codexConfigSetInputValue('grok-config-api-key', source.apiKey || '');
  codexConfigSetInputValue('grok-config-model', source.defaultModel || '');
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

function renderGrokConfigModelChips(models) {
  const chipsWrap = document.getElementById('grok-config-model-chips');
  if (!chipsWrap) return;
  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (l) => l;
  const list = sortFn(Array.isArray(models) ? models : [], 'grok');
  if (!list.length) {
    chipsWrap.innerHTML = '<span style="font-size:11.5px;color:var(--text-muted);">暂无模型，可手动输入</span>';
    syncGrokRawConfigFromFields();
    return;
  }
  chipsWrap.innerHTML = list.map(m => {
    const id = typeof m === 'string' ? m : (m.id || '');
    return `<button type="button" class="btn-ghost secondary" style="padding: 2px 8px; font-size: 11.5px; height: 26px;" onclick="document.getElementById('grok-config-model').value='${platformEsc(id)}';if(typeof syncGrokRawConfigFromFields==='function')syncGrokRawConfigFromFields();">${platformEsc(id)}</button>`;
  }).join('');
  syncGrokRawConfigFromFields();
}

async function openGrokAddModal() {
  await openGrokConfigEditor();
}

function openGrokConfigAdd() {
  openGrokConfigEditor();
}

async function initGrokConfigEditorPage(providerId = '') {
  try {
    grokProviderModels = await invoke('list_provider_models') || [];
  } catch (e) {
    grokProviderModels = [];
  }
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    grokProviderModels = grokProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    grokProviderModels.unshift(lp);
  }
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
    grokAddSelectedProvider = provider.sourceProviderId || null;
    renderGrokAddProviderList();

    codexConfigSetInputValue('grok-config-source-id', provider.sourceProviderId || '');
    codexConfigSetInputValue('grok-config-name', provider.name || '');
    const url = provider.apiHost ? (provider.apiHost.replace(/\/+$/, '') + (provider.apiPath || '/v1')) : '';
    codexConfigSetInputValue('grok-config-base-url', url);
    codexConfigSetInputValue('grok-config-api-key', provider.apiKey || '');
    codexConfigSetInputValue('grok-config-model', provider.defaultModel || '');
    setGrokConfigBackendRadio(provider.apiBackend || 'chat_completions');

    const source = (providerStore.providers || []).find(p => p.id === provider.sourceProviderId);
    renderGrokConfigModelChips(source ? source.models : [provider.defaultModel]);
  } else {
    codexConfigSetInputValue('grok-config-source-id', '');
    codexConfigSetInputValue('grok-config-name', '');
    codexConfigSetInputValue('grok-config-base-url', '');
    codexConfigSetInputValue('grok-config-api-key', '');
    codexConfigSetInputValue('grok-config-model', '');
    setGrokConfigBackendRadio('chat_completions');

    const firstProvider = grokProviderModels[0];
    if (firstProvider) {
      grokAddSelectedProvider = firstProvider.providerId;
      renderGrokAddProviderList();
      applyGrokConfigSource(firstProvider);
    } else {
      grokAddSelectedProvider = null;
      renderGrokAddProviderList();
      renderGrokConfigModelChips([]);
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
  const list = document.getElementById('grok-add-provider-list');
  syncPlatformAddSortControl('grok');
  if (!list) return;
  if (!grokProviderModels.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无供应商，请先在「供应商」页添加</div>';
    return;
  }
  const filtered = platformAddVisibleProviders(grokProviderModels, grokAddSearchKw);
  if (!filtered.length) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = grokAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectGrokAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
        <span class="cb-add-prov-count">${p.models.length}</span>
      </div>
    `;
  }).join('');
}

function selectGrokAddProvider(providerId) {
  grokAddSelectedProvider = providerId;
  renderGrokAddProviderList();
  const provider = grokProviderModels.find(p => p.providerId === providerId);
  if (provider) {
    applyGrokConfigSource(provider);
    renderGrokConfigModelChips(provider.models || []);
  }
}

function renderGrokAddModels() {
  const titleEl = document.getElementById('grok-add-models-title');
  const subEl = document.getElementById('grok-add-models-sub');
  const body = document.getElementById('grok-add-models-list-page');
  if (!body) return;

  if (!grokAddSelectedProvider) {
    titleEl.textContent = '请选择供应商';
    subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = grokProviderModels.find(p => p.providerId === grokAddSelectedProvider);
  if (!provider) {
    titleEl.textContent = '供应商未找到';
    subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  titleEl.textContent = provider.providerName;
  subEl.textContent = `共 ${provider.models.length} 个模型，勾选要添加到 Grok 的模型`;

  if (!provider.models.length) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型</div>';
    return;
  }

  const grokConfigs = Array.isArray(providerStore?.grokConfigs) ? providerStore.grokConfigs : [];
  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models, 'grok');

  body.innerHTML = sortedModels.map((m) => {
    const exists = grokConfigs.some(cfg =>
      (cfg.sourceProviderId === provider.providerId || cfg.id === `grok-${grok_sanitize_key(provider.providerId)}-${grok_sanitize_key(m.id)}`) && cfg.defaultModel === m.id
    );
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="grok-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateGrokAddConfirmButton">
        ${cbAddModelIdentity(m.id)}
      </label>
    `;
  }).join('');
}

function updateGrokAddConfirmButton() {
  const btn = document.getElementById('grok-add-confirm-page');
  if (!btn) return;
  const checked = document.querySelectorAll('.grok-add-model-check:checked');
  btn.disabled = checked.length === 0;
  const label = btn.querySelector('.model-action-label');
  if (label) {
    label.textContent = checked.length > 0 ? ` 保存选择 (${checked.length})` : ' 保存选择';
  }
}

function grokAddSelectAll() {
  cbSetAddModelChecks('.grok-add-model-check', true, updateGrokAddConfirmButton);
}

function grokAddSelectNone() {
  cbSetAddModelChecks('.grok-add-model-check', false, updateGrokAddConfirmButton);
}

async function confirmAddGrokModelsPage() {
  const provider = grokProviderModels.find(p => p.providerId === grokAddSelectedProvider);
  if (!provider) {
    showCustomAlert('请先在左侧选择供应商。', '未选择供应商', 'warn');
    return;
  }
  const checkedInputs = Array.from(document.querySelectorAll('.grok-add-model-check:checked'));
  if (!checkedInputs.length) {
    showCustomAlert('请至少勾选一个模型。', '未勾选模型', 'warn');
    return;
  }

  const apiBackend = document.getElementById('grok-add-backend')?.value || 'chat_completions';
  const rawBaseUrl = provider.chatUrl || (provider.apiHost ? `${provider.apiHost.replace(/\/+$/, '')}${provider.apiPath || '/v1'}` : '');
  const endpoint = grokConfigEndpointParts(rawBaseUrl);

  if (!Array.isArray(providerStore.grokConfigs)) providerStore.grokConfigs = [];

  checkedInputs.forEach(input => {
    const modelId = input.dataset.modelId;
    const modelName = input.dataset.modelName || modelId;
    const sanitizedProvider = grok_sanitize_key(provider.providerId);
    const sanitizedModel = grok_sanitize_key(modelId);
    const configId = `grok-${sanitizedProvider}-${sanitizedModel}`;

    const existingIdx = providerStore.grokConfigs.findIndex(cfg =>
      cfg.id === configId || (cfg.sourceProviderId === provider.providerId && cfg.defaultModel === modelId)
    );

    const configItem = {
      id: existingIdx >= 0 ? providerStore.grokConfigs[existingIdx].id : configId,
      name: `${provider.providerName} - ${modelName}`,
      apiHost: endpoint.apiHost || provider.apiHost,
      apiPath: endpoint.apiPath || provider.apiPath || '/v1',
      apiKey: provider.apiKey || '',
      defaultModel: modelId,
      apiBackend: apiBackend,
      sourceProviderId: provider.providerId,
      sourceProviderName: provider.providerName,
    };

    if (existingIdx >= 0) {
      providerStore.grokConfigs[existingIdx] = configItem;
    } else {
      providerStore.grokConfigs.push(configItem);
    }
  });

  const ok = await syncGrokConfigUiAfterStoreChange();
  if (ok) {
    if (typeof addLog === 'function') addLog('ok', `已添加 ${checkedInputs.length} 个模型到 Grok 配置`);
    showCustomAlert(`已成功保存 ${checkedInputs.length} 个 Grok 模型配置。`, '保存成功', 'success');
    navigateTo('platform-grok');
    renderGrokConfigList(platformInfoOf('grok') || {});
  }
}

async function openGrokConfigEditor(providerId = '') {
  resetPasswordInputVisibility('grok-config-api-key', 'grok-config-api-key-toggle');
  navigateTo('platform-grok-add');
  await initGrokConfigEditorPage(providerId);
}

function closeGrokConfigEditor() {
  resetPasswordInputVisibility('grok-config-api-key', 'grok-config-api-key-toggle');
  document.getElementById('grok-config-modal')?.classList.remove('active');
  navigateTo('platform-grok');
}

function syncGrokConfigTokenFromSource() {
  const sourceId = document.getElementById('grok-config-source-id')?.value;
  const source = (providerStore.providers || []).find(p => p.id === sourceId);
  if (!source) {
    showCustomAlert('未关联来源供应商，无法自动同步。', '提示', 'info');
    return;
  }
  codexConfigSetInputValue('grok-config-api-key', source.apiKey || '');
  codexConfigSetInputValue('grok-config-base-url', openai_base_url_from_source(source));
  if (source.defaultModel) codexConfigSetInputValue('grok-config-model', source.defaultModel);
  if (typeof addLog === 'function') addLog('info', `已从来源供应商「${source.name}」同步最新配置`);
}

async function syncGrokConfigUiAfterStoreChange() {
  if (typeof persistProviders === 'function') {
    const ok = await persistProviders();
    if (!ok) return false;
  }
  if (typeof renderProviders === 'function') renderProviders();
  if (typeof renderEvalProviderOptions === 'function') renderEvalProviderOptions();
  if (typeof renderModelMap === 'function') await renderModelMap();
  renderGrokConfigList(platformInfoOf('grok') || {});
  renderPlatformProviderOptions();
  return true;
}

async function saveGrokConfigEditor(addAfter = false) {
  const editId = document.getElementById('grok-config-edit-id')?.value.trim();
  const name = document.getElementById('grok-config-name')?.value.trim();
  const rawBaseUrl = document.getElementById('grok-config-base-url')?.value.trim();
  const apiKey = document.getElementById('grok-config-api-key')?.value.trim();
  const defaultModel = document.getElementById('grok-config-model')?.value.trim();
  const apiBackend = document.getElementById('grok-config-backend')?.value.trim() || 'chat_completions';
  const sourceId = document.getElementById('grok-config-source-id')?.value.trim();

  if (!name) {
    showCustomAlert('请输入配置名称。', '无法保存', 'warn');
    return;
  }

  // 避免同名配置混淆校验
  const isDuplicateName = (providerStore.grokConfigs || []).some(
    p => p && p.id !== editId && String(p.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (isDuplicateName) {
    showCustomAlert(`已存在名为「${name}」的 Grok 配置，请更换名称以作区分（例如 ${name}-2）。`, '配置名称重复', 'warn');
    document.getElementById('grok-config-name')?.focus();
    return;
  }
  if (!rawBaseUrl) {
    showCustomAlert('请输入 Base URL。', '无法保存', 'warn');
    return;
  }

  const endpoint = grokConfigEndpointParts(rawBaseUrl);
  const existing = editId ? grokConfigProviderById(editId) : null;
  const source = sourceId ? (providerStore.providers || []).find(p => p && p.id === sourceId) : null;

  const config = {
    ...(existing || {}),
    id: editId || `grok-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    apiHost: endpoint.apiHost,
    apiPath: endpoint.apiPath || '/v1',
    apiKey,
    defaultModel: defaultModel || 'default',
    apiBackend,
    sourceProviderId: sourceId || existing?.sourceProviderId || '',
    sourceProviderName: source?.name || existing?.sourceProviderName || '',
  };

  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  if (!Array.isArray(providerStore.grokConfigs)) providerStore.grokConfigs = [];
  if (editId) {
    const idx = providerStore.grokConfigs.findIndex(p => p.id === editId);
    if (idx >= 0) providerStore.grokConfigs[idx] = config;
    else providerStore.grokConfigs.push(config);
  } else {
    providerStore.grokConfigs.push(config);
  }

  const ok = await syncGrokConfigUiAfterStoreChange();
  if (!ok) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderGrokConfigList(platformInfoOf('grok') || {});
    return;
  }
  closeGrokConfigEditor();
  if (typeof addLog === 'function') addLog('ok', `已保存 Grok 配置: ${name}`);
  if (addAfter) await applyGrokProviderConfig(config.id);
}

function editGrokProviderConfig(providerId) {
  openGrokConfigEditor(providerId);
}

async function deleteGrokProviderConfig(providerId) {
  const provider = grokConfigProviderById(providerId);
  if (!provider) {
    showCustomAlert('配置不存在或尚未加载。', '无法删除', 'warn');
    return;
  }
  const info = platformInfoOf('grok');
  const isCurrent = info && (info.currentProviderId === providerId || info.currentProviderId === grok_sanitize_key(providerId));

  const confirmMsg = isCurrent
    ? `「${provider.name || provider.id}」当前正在生效中。\n\n删除该配置将自动为您恢复为「官方默认配置」。是否确认删除？`
    : `确认删除 Grok 配置「${provider.name || provider.id}」吗？`;

  const ok = await showCustomConfirm(confirmMsg, '删除配置', 'warn');
  if (!ok) return;

  if (isCurrent) {
    await restoreGrokOfficialConfig();
  }

  const previous = typeof cloneProviderStore === 'function'
    ? cloneProviderStore()
    : JSON.parse(JSON.stringify(providerStore || { version: 1, providers: [] }));
  providerStore.grokConfigs = (providerStore.grokConfigs || []).filter(p => p.id !== providerId);
  const synced = await syncGrokConfigUiAfterStoreChange();
  if (!synced) {
    providerStore = typeof cloneProviderStore === 'function'
      ? cloneProviderStore(previous)
      : JSON.parse(JSON.stringify(previous));
    renderGrokConfigList(platformInfoOf('grok') || {});
    return;
  }
  if (typeof addLog === 'function') addLog('info', `已删除 Grok 配置: ${provider.name || provider.id}`);
}

async function applyGrokProviderConfig(providerId) {
  const provider = grokConfigProviderById(providerId);
  const label = provider?.name || providerId;
  const model = provider?.defaultModel || '默认模型';
  const ok = await showCustomConfirm(
    `将把 Grok Build CLI 默认模型切换为「${label}」。\n\n模型：${model}\n配置文件：~/.grok/config.toml\n\n下次在终端启动 grok 即可生效。`,
    '切换 Grok 配置',
    'warn'
  );
  if (!ok) return;

  setPlatformBusy('grok', true);
  showSwitchProgress('grok', '正在写入 Grok 配置文件…');
  try {
    const result = await invoke('switch_platform', { platform: 'grok', providerId });
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Grok 配置切换成功');
    showCustomAlert(result.message || 'Grok 配置切换成功。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Grok 切换失败: ${e}`);
    showCustomAlert(String(e), '切换失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('grok', false);
    renderPlatformDetailStatuses();
  }
}

function onGrokConfigSearch() {
  const input = document.getElementById('grok-config-search');
  grokConfigSearch = input ? input.value : '';
  const info = platformInfoOf('grok');
  if (info) renderGrokConfigList(info);
}

function grokConfigMatchesSearch(config) {
  if (!grokConfigSearch.trim()) return true;
  const kw = grokConfigSearch.trim().toLowerCase();
  return [
    config.name,
    config.model,
    config.endpoint,
    config.description,
  ].some(value => String(value || '').toLowerCase().includes(kw));
}

async function restoreGrokOfficialConfig() {
  const info = platformInfoOf('grok') || {};
  const isOfficial = !info.managedByAnyBridge;
  const message = isOfficial
    ? 'Grok Build 当前已经是官方配置。仍要清理 AnyBridge 写入的托管模型段吗？'
    : '将把 Grok Build 切回官方配置。\n\n这会清理 AnyBridge 写入的自定义端点与默认模型设置，恢复使用 xAI 官方默认登录态与模型。在终端重新运行 grok 即可生效。';
  const ok = await showCustomConfirm(message, '切回官方配置', 'warn');
  if (!ok) return;

  setPlatformBusy('grok', true);
  showSwitchProgress('grok', '正在准备切回官方配置…');
  try {
    const result = await invoke('restore_grok_official_config');
    if (typeof loadProviders === 'function') await loadProviders();
    await refreshPlatforms({ silent: true });
    if (typeof addLog === 'function') addLog('ok', result.message || 'Grok 已切回官方配置');
    showCustomAlert(result.message || 'Grok 已切回官方配置。', '切换完成', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `Grok 切回官方失败: ${e}`);
    showCustomAlert(String(e), '切回官方失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('grok', false);
    renderPlatformDetailStatuses();
  }
}

function renderGrokConfigList(info) {
  const list = document.getElementById('platform-grok-config-list');
  if (!list) return;

  const configs = Array.isArray(providerStore?.grokConfigs) ? providerStore.grokConfigs : [];
  const currentId = info?.currentProviderId || '';
  const isOfficial = !info.managedByAnyBridge;
  const items = [];

  items.push({
    platformId: 'grok',
    name: '官方默认配置',
    description: '使用 Grok Build 官方登录态（grok login）与 xAI 官方内置模型。',
    icon: '官',
    typeLabel: '官方',
    tone: 'official',
    current: isOfficial,
    currentLabel: '当前使用',
    model: '官方默认 (grok-4.5)',
    endpoint: '~/.grok/config.toml',
    protocol: 'xAI 原生',
    action: 'restoreGrokOfficialConfig()',
    actionLabel: '切回官方',
  });

  const grokLocalCard = platformLocalProxyCard('grok', info);
  if (grokLocalCard) items.push(grokLocalCard);

  configs.forEach(cfg => {
    const isCurrent = currentId === cfg.id || currentId === grok_sanitize_key(cfg.id);
    const backendLabel = cfg.apiBackend === 'responses'
      ? 'Responses 协议'
      : cfg.apiBackend === 'messages'
        ? 'Messages 协议'
        : 'Chat Completions 协议';
    const baseUrl = cfg.apiHost ? (cfg.apiHost.replace(/\/+$/, '') + (cfg.apiPath || '/v1')) : '未设置地址';
    items.push({
      platformId: 'grok',
      name: cfg.name || cfg.id,
      description: 'Grok Build 自定义模型配置，写入 ~/.grok/config.toml。',
      typeLabel: isCurrent ? '当前使用' : '第三方',
      tone: isCurrent ? 'third live' : 'third',
      current: isCurrent,
      currentLabel: '当前使用',
      model: cfg.defaultModel || '默认模型未设置',
      endpoint: baseUrl,
      protocol: backendLabel,
      action: `applyGrokProviderConfig(${platformJsArg(cfg.id)})`,
      actionLabel: '切换',
      editAction: `editGrokProviderConfig(${platformJsArg(cfg.id)})`,
      deleteAction: `deleteGrokProviderConfig(${platformJsArg(cfg.id)})`,
    });
  });

  const liveIds = Array.isArray(info?.liveProviderIds) ? info.liveProviderIds : [];
  liveIds
    .filter(id => !configs.some(c => c.id === id || grok_sanitize_key(c.id) === id))
    .forEach(id => {
      const isCurrent = currentId === id;
      items.push({
        platformId: 'grok',
        name: id,
        description: '在 ~/.grok/config.toml 中由手动或外部写入的模型配置。',
        typeLabel: isCurrent ? '当前使用' : '外部配置',
        tone: isCurrent ? 'third live' : 'third external',
        current: isCurrent,
        currentLabel: '当前使用',
        model: '外部模型',
        endpoint: '~/.grok/config.toml',
        protocol: '原生配置',
      });
    });

  const filtered = items.filter(grokConfigMatchesSearch);
  const count = document.getElementById('grok-config-count');
  if (count) count.textContent = String(items.length);

  if (!filtered.length) {
    list.innerHTML = `
      <div class="codex-table-empty">
        <div style="font-size: 14px; font-weight: 600; margin-bottom: 6px;">尚无 Grok 配置</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">点击右上角「+ 添加配置」从已有的供应商一键创建并切换。</div>
        <button class="btn-primary" type="button" data-action="openGrokConfigAdd">+ 添加首个配置</button>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(renderCodexConfigCard).join('');
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

        let restart = null;
        const preserveAuth = codexProviderPreservesOfficialAuth(provider);
        const needInject = codexProviderNeedsInject(provider);
        if (codexDesktopAutomationSupported()) {
          setMessage(preserveAuth
            ? '正在重启 Codex 桌面版（保留官方登录模式）…'
            : needInject
              ? '正在重启 Codex 桌面版并注入自定义模型…'
              : '正在重启 Codex 桌面版（不进行模型注入）…');
          restart = assertSwitchResultOk(
            await invoke('restart_codex_desktop', { managed: true, model: provider.defaultModel || null, injectModels: needInject }),
            'Codex 桌面版重启或注入失败'
          );
        } else {
          setMessage('当前平台不支持自动重启 Codex Desktop，已跳过桌面注入。');
        }

        if (typeof addLog === 'function') {
          addLog('ok', result.message || 'Codex 配置已切换');
          if (restart) {
            addLog('ok', restart.message || (needInject ? 'Codex 桌面版已重启并完成注入' : 'Codex 桌面版已重启'));
          } else {
            addLog('warn', codexDesktopUnsupportedMessage());
          }
        }
        setMessage('正在刷新 Codex 状态…');
        await refreshPlatforms({ silent: true, reloadProviders: false });
        const restartFallback = needInject ? 'Codex 桌面版已重启并完成注入。' : 'Codex 桌面版已重启。';
        return {
          message: `${result.message || 'Codex 配置已切换。'}\n\n${restart ? (restart.message || restartFallback) : codexDesktopUnsupportedMessage()}`
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

async function startCodexWithCdp(injectModels = true) {
  if (!codexDesktopAutomationSupported()) {
    const msg = codexDesktopUnsupportedMessage();
    if (typeof addLog === 'function') addLog('warn', msg);
    showCustomAlert(msg, '当前平台不支持', 'warn');
    return;
  }
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

// ═══════ Cursor BYOK Console (Specs Aligned Architecture) ═══════

globalThis.cursorConsoleBusy = false;
let _cursorCachedStatus = null;
let _cursorModelsList = [];
let _cursorSearchKeyword = '';
let _cursorSelectedSet = new Set();
let _cursorProviderModels = [];
let _cursorAddSelectedProvider = null;
let _cursorAddSelectedModels = new Map(); // providerId -> Set of modelId
let _cursorAddSearchKw = '';
let _cursorAddSortMode = 'default';
let _cursorProviderTagStyle = 'badge';
let _cursorProviderBracketLeft = '[';
let _cursorProviderBracketRight = ']';

function cursorEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cursorPageRoot() {
  return document.getElementById('page-platform-cursor');
}

function cursorEnsureBridge() {
  if (!invoke && typeof bindTauriBridge === 'function') bindTauriBridge();
  if (!invoke) throw new Error('Tauri 通道未就绪，Cursor 接入操作不可用。请从桌面版客户端启动。');
}

function cursorSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function cursorSetBusy(busy, busyText) {
  cursorConsoleBusy = !!busy;
  const mainBtn = document.getElementById('cursor-main-btn');
  const mainBtnText = document.getElementById('cursor-main-btn-text');
  const refreshBtn = document.getElementById('cursorRefreshBtn');
  const restoreBtn = document.getElementById('cursorRestoreBtn');

  if (mainBtn) {
    mainBtn.disabled = !!busy;
    if (busy && busyText && mainBtnText) {
      mainBtnText.textContent = busyText;
    }
  }
  if (refreshBtn) {
    refreshBtn.disabled = !!busy;
    refreshBtn.classList.toggle('is-spinning', !!busy);
  }
  if (restoreBtn && busy) {
    restoreBtn.disabled = true;
  }
}

// 刷新控制台主状态与模型列表
async function cursorRefreshConsole(options = {}) {
  const root = cursorPageRoot();
  if (!root) return;
  const isSilent = !!(options && options.silent);
  if (!isSilent) cursorSetBusy(true);

  try {
    cursorEnsureBridge();

    // 1. 获取 Rust Cursor Core 状态与模型列表（并行请求减少等待时间）
    const [statusRes, modelsRes, tagStyleRes] = await Promise.allSettled([
      invoke('cursor_get_status'),
      invoke('cursor_list_models'),
      invoke('cursor_get_provider_tag_style')
    ]);

    let status = statusRes.status === 'fulfilled' ? statusRes.value : null;
    _cursorCachedStatus = status;

    if (modelsRes.status === 'fulfilled' && Array.isArray(modelsRes.value)) {
      _cursorModelsList = modelsRes.value;
    }

    if (tagStyleRes.status === 'fulfilled' && tagStyleRes.value) {
      const val = tagStyleRes.value;
      if (typeof val === 'object' && val !== null) {
        _cursorProviderTagStyle = val.style || 'badge';
        _cursorProviderBracketLeft = val.bracketLeft ?? '[';
        _cursorProviderBracketRight = val.bracketRight ?? ']';
      } else if (typeof val === 'string') {
        _cursorProviderTagStyle = val;
      }
    }
    cursorUpdateTagStyleSelects(_cursorProviderTagStyle);

    const running = !!status?.running;
    const certReady = !!status?.certificateReady;
    const configuredCount = _cursorModelsList.length;
    const port = status?.controlPort || 17650;
    const actions = Array.isArray(status?.availableActions) ? status.availableActions : [];
    const canEnable = actions.includes('enable');
    const canDisable = actions.includes('disable');
    const canSync = actions.includes('sync');
    const canRepair = actions.includes('repair');

    // 1) 主动作按钮与停止按钮 (对齐 Devin / Windsurf 极简模式)
    const mainBtn = document.getElementById('cursor-main-btn');
    const mainBtnText = document.getElementById('cursor-main-btn-text');
    const restoreBtn = document.getElementById('cursorRestoreBtn');

    if (mainBtn && mainBtnText) {
      const icon = mainBtn.querySelector('.proxy-btn-icon');
      if (running) {
        mainBtn.classList.add('is-connected');
        if (icon) {
          icon.innerHTML = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>';
        }
        mainBtnText.textContent = '已接入';
        mainBtn.setAttribute('aria-label', 'Cursor 已接入 AnyBridge');
      } else if (!certReady && canRepair) {
        mainBtn.classList.remove('is-connected');
        if (icon) {
          icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
        }
        mainBtnText.textContent = '安装证书';
      } else if (configuredCount === 0) {
        mainBtn.classList.remove('is-connected');
        if (icon) {
          icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
        }
        mainBtnText.textContent = '添加模型';
      } else {
        mainBtn.classList.remove('is-connected');
        if (icon) {
          icon.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" />';
        }
        mainBtnText.textContent = '一键接入';
      }
    }

    if (restoreBtn) {
      restoreBtn.disabled = !running;
      restoreBtn.classList.toggle('is-danger', running);
      restoreBtn.setAttribute('aria-label', running ? '停止 Cursor 接入 AnyBridge' : 'Cursor 当前未接入');
    }

    // 2) 更新模型数量与渲染列表
    const countPill = document.getElementById('cursor-model-count');
    if (countPill) {
      countPill.textContent = `共 ${configuredCount} 个`;
    }

    // 清理可能不存在的选中项
    const validIds = new Set(_cursorModelsList.map(m => m.id));
    _cursorSelectedSet = new Set(Array.from(_cursorSelectedSet).filter(id => validIds.has(id)));

    cursorRenderTableRows();
    cursorUpdateBulkActionButtons();

  } catch (err) {
    console.error('[cursor] refresh error:', err);
  } finally {
    if (!isSilent) cursorSetBusy(false);
  }
}

// 渲染表格行数据 (对齐 cb-model-table 与 cb-model-empty)
function cursorRenderTableRows() {
  const tbody = document.getElementById('cursorModelTableBody');
  const empty = document.getElementById('cursor-model-empty');
  const table = document.getElementById('cursor-model-table');
  if (!tbody) return;

  if (!_cursorModelsList || _cursorModelsList.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';

  const list = cursorGetFilteredList();
  const kw = (_cursorSearchKeyword || '').trim();

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 36px 0;">
          未找到匹配「${cursorEsc(kw)}」的 Cursor 模型
        </td>
      </tr>
    `;
    return;
  }

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  let html = '';
  list.forEach(item => {
    const isChecked = _cursorSelectedSet.has(item.id);
    const displayName = (item.displayName || item.exposedModelId || '').trim();
    const providerName = (item.providerName || '未知供应商').trim();
    const isEnabled = item.enabled !== false;
    const isVisionEnabled = item.useThirdPartyVision === true;

    const iconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(item.exposedModelId || item.upstreamModel, { size: 20 })
      : `<span style="color:var(--accent);">✦</span>`;

    const visionTitle = !hasVisionModels
      ? '请先在「代理增强」中配置图片理解模型'
      : (isVisionEnabled ? '已启用第三方图片理解（点击关闭）' : '启用后图片将使用第三方模型理解（点击启用）');

    html += `
      <tr class="${isChecked ? 'cb-model-row-selected is-selected' : ''}" data-binding-id="${cursorEsc(item.id)}" style="min-height: 52px;">
        <td class="cb-select-cell" style="text-align: center; padding-left: 14px;">
          <label class="provider-select-check provider-select-check-table" data-stop data-action="__noop">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="cursorToggleRowSelect('${cursorEsc(item.id)}', this.checked)">
            <span></span>
          </label>
        </td>
        <td class="editable-cell display-name-cell" onclick="cursorStartEditDisplayName(this, '${cursorEsc(item.id)}')" title="点击修改显示名称">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--bg-input);border:1px solid var(--border);flex:0 0 24px;">
              ${iconHtml}
            </div>
            <div style="min-width:0;flex:1;">
              <strong style="font-weight:750;color:var(--text-primary);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cursorEsc(displayName)}">${cursorEsc(displayName)}</strong>
            </div>
          </div>
        </td>
        <td>
          <div class="model-id-copy-wrap" style="display:inline-flex;align-items:center;gap:6px;">
            <code style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);background:var(--bg-input);padding:2px 6px;border-radius:4px;border:1px solid var(--border);">${cursorEsc(item.exposedModelId)}</code>
            <button class="btn-icon model-id-copy-btn" style="width:22px;height:22px;min-width:22px;border:none;background:transparent;" onclick="copyTextToClipboard('${cursorEsc(item.exposedModelId)}', '模型 ID')" title="复制暴露模型 ID">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </td>
        <td>
          <div style="font-size:12.5px;color:var(--text-primary);font-weight:600;">${cursorEsc(providerName)}</div>
        </td>
        <td>
          <div class="model-map-actions">
            <button class="btn-icon model-map-action-btn" onclick="openCursorEditModal('${cursorEsc(item.id)}')" title="编辑模型" aria-label="编辑模型">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon model-map-action-btn danger" onclick="cursorRemoveSingleModel('${cursorEsc(item.id)}', '${cursorEsc(displayName)}')" title="从 Cursor 移除" aria-label="从 Cursor 移除">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${cursorEsc(visionTitle)}">
            <input type="checkbox" ${isVisionEnabled ? 'checked' : ''} onchange="cursorToggleThirdPartyVision('${cursorEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td class="model-map-toggle-cell">
          <label class="toggle-switch" title="${isEnabled ? '已向 Cursor 暴露（点击停用）' : '已停用（点击启用）'}">
            <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="cursorToggleModelEnabled('${cursorEsc(item.id)}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// 获取过滤后的模型列表
function cursorGetFilteredList() {
  const kw = (_cursorSearchKeyword || '').trim().toLowerCase();
  return (_cursorModelsList || []).filter(item => {
    if (!kw) return true;
    const matchName = (item.displayName || '').toLowerCase().includes(kw);
    const matchExposed = (item.exposedModelId || '').toLowerCase().includes(kw);
    const matchProvider = (item.providerName || '').toLowerCase().includes(kw);
    const matchTarget = (item.upstreamModel || '').toLowerCase().includes(kw);
    let matchUrl = false;
    if (providerStore && Array.isArray(providerStore.providers)) {
      const p = providerStore.providers.find(x => x.id === item.providerId);
      if (p && (p.baseUrl || p.apiHost)) {
        matchUrl = String(p.baseUrl || p.apiHost).toLowerCase().includes(kw);
      }
    }
    return matchName || matchExposed || matchProvider || matchTarget || matchUrl;
  });
}

// 就地修改显示名称
function cursorStartEditDisplayName(td, bindingId) {
  if (td.querySelector('input')) return;
  const item = _cursorModelsList.find(x => x.id === bindingId);
  if (!item) return;

  const currName = (item.displayName || item.exposedModelId || '').trim();
  td.innerHTML = `<input type="text" class="input-sm" style="width:100%; text-align:left; font-family:inherit; padding:4px 8px; border-radius:6px; box-shadow:none; outline:none; height:28px; font-size:13px; font-weight:600; color:var(--text-primary); background:var(--bg-card); border:1px solid var(--accent);" value="${cursorEsc(currName)}">`;
  const input = td.querySelector('input');
  if (!input) return;

  input.addEventListener('click', (e) => e.stopPropagation());
  input.focus();
  input.select();

  let finished = false;
  async function finishEdit() {
    if (finished) return;
    finished = true;
    const newVal = input.value.trim();
    if (newVal && newVal !== currName) {
      cursorEnsureBridge();
      try {
        await invoke('cursor_update_model', {
          payload: {
            id: bindingId,
            displayName: newVal
          }
        });
        item.displayName = newVal;
        cursorRefreshConsole({ silent: true }).catch(() => {});
      } catch (e) {
        showCustomAlert('更新显示名失败: ' + e, '保存异常', 'error');
      }
    }
    cursorRenderTableRows();
  }

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishEdit();
    } else if (e.key === 'Escape') {
      finished = true;
      cursorRenderTableRows();
    }
  });
}

// 搜索栏输入联动
function cursorFilterModels(keyword) {
  _cursorSearchKeyword = keyword || '';
  cursorRenderTableRows();
}

// 勾选单行
function cursorToggleRowSelect(bindingId, checked) {
  if (checked) {
    _cursorSelectedSet.add(bindingId);
  } else {
    _cursorSelectedSet.delete(bindingId);
  }
  const tr = document.querySelector(`tr[data-binding-id="${bindingId}"]`);
  if (tr) tr.classList.toggle('is-selected', checked);
  cursorUpdateBulkActionButtons();
}

// 全选 / 取消全选
function cursorToggleSelectAll(checked) {
  _cursorSelectedSet.clear();
  if (checked) {
    const list = cursorGetFilteredList();
    list.forEach(m => _cursorSelectedSet.add(m.id));
  }
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
}

// 选择当前显示的所有模型
function cursorToggleSelectAllVisible() {
  const list = cursorGetFilteredList();
  if (!list.length) return;
  const allSelected = list.every(m => _cursorSelectedSet.has(m.id));
  if (allSelected) {
    list.forEach(m => _cursorSelectedSet.delete(m.id));
  } else {
    list.forEach(m => _cursorSelectedSet.add(m.id));
  }
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
}

// 更新批量操作按钮状态
function cursorUpdateBulkActionButtons() {
  const hasSelected = _cursorSelectedSet.size > 0;
  const enableBtn = document.getElementById('cursor-bulk-enable-btn');
  const disableBtn = document.getElementById('cursor-bulk-disable-btn');
  const visionBtn = document.getElementById('cursor-bulk-vision-btn');
  const removeBtn = document.getElementById('cursor-bulk-remove-btn');
  const selectVisibleBtn = document.getElementById('cursor-bulk-select-visible-btn');
  const selectAllCheckbox = document.getElementById('cursorSelectAll');

  if (enableBtn) enableBtn.disabled = !hasSelected;
  if (disableBtn) disableBtn.disabled = !hasSelected;
  if (visionBtn) visionBtn.disabled = !hasSelected;
  if (removeBtn) removeBtn.disabled = !hasSelected;

  const list = cursorGetFilteredList();
  if (selectVisibleBtn) {
    selectVisibleBtn.disabled = list.length === 0;
  }
  if (selectAllCheckbox && list.length > 0) {
    selectAllCheckbox.checked = list.every(m => _cursorSelectedSet.has(m.id));
  } else if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
  }
}

// 切换单模型第三方图片理解
async function cursorToggleThirdPartyVision(bindingId, enabled) {
  cursorEnsureBridge();
  const item = _cursorModelsList.find(m => m.id === bindingId);
  if (!item) return;

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (enabled && !hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置图片理解模型。', '无法启用', 'warn');
    cursorRenderTableRows();
    return;
  }

  const prev = item.useThirdPartyVision;
  item.useThirdPartyVision = !!enabled;
  cursorRenderTableRows();
  try {
    await invoke('cursor_update_model', {
      payload: {
        id: bindingId,
        useThirdPartyVision: !!enabled
      }
    });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    item.useThirdPartyVision = prev;
    cursorRenderTableRows();
    showCustomAlert('切换第三方图片理解失败: ' + e, '操作异常', 'error');
  }
}

// 批量启用第三方图片理解
async function cursorBulkThirdPartyVisionAction() {
  if (_cursorSelectedSet.size === 0) return;
  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (!hasVisionModels) {
    showCustomAlert('请先在「代理增强」中配置第三方图片理解模型。', '无法启用', 'warn');
    return;
  }

  const ids = Array.from(_cursorSelectedSet);
  cursorEnsureBridge();
  _cursorModelsList.forEach(m => {
    if (_cursorSelectedSet.has(m.id)) {
      m.useThirdPartyVision = true;
    }
  });
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_third_party_vision', { ids, enabled: true });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    console.error('[cursor] bulk set third party vision failed:', e);
    showCustomAlert('批量设置第三方图片理解失败: ' + e, '操作异常', 'error');
  }
}

// 批量启用
async function cursorBulkEnableAction() {
  if (_cursorSelectedSet.size === 0) return;
  cursorEnsureBridge();
  const ids = Array.from(_cursorSelectedSet);
  _cursorModelsList.forEach(m => {
    if (_cursorSelectedSet.has(m.id)) {
      m.enabled = true;
    }
  });
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_enabled', { ids, enabled: true });
    if (typeof addLog === 'function') addLog('ok', `已批量启用 ${ids.length} 个 Cursor 模型`);
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    console.error('[cursor] bulk enable failed:', e);
    showCustomAlert('批量启用失败: ' + e, '操作异常', 'error');
  }
}

// 批量停用
async function cursorBulkDisableAction() {
  if (_cursorSelectedSet.size === 0) return;
  cursorEnsureBridge();
  const ids = Array.from(_cursorSelectedSet);
  _cursorModelsList.forEach(m => {
    if (_cursorSelectedSet.has(m.id)) {
      m.enabled = false;
    }
  });
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_enabled', { ids, enabled: false });
    if (typeof addLog === 'function') addLog('ok', `已批量停用 ${ids.length} 个 Cursor 模型`);
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    console.error('[cursor] bulk disable failed:', e);
    showCustomAlert('批量停用失败: ' + e, '操作异常', 'error');
  }
}

// 批量移除
async function cursorBulkRemoveAction() {
  if (_cursorSelectedSet.size === 0) return;
  const count = _cursorSelectedSet.size;
  const ok = await showCustomConfirm(
    `确定要从 Cursor 移除选中的 ${count} 个模型绑定吗？

注意：此操作仅移除 Cursor 中的选用关系，不会删除统一供应商和共享路由。`,
    '移除模型绑定',
    'warn'
  );
  if (!ok) return;

  cursorEnsureBridge();
  const ids = Array.from(_cursorSelectedSet);
  const prevList = _cursorModelsList.slice();
  _cursorModelsList = _cursorModelsList.filter(m => !_cursorSelectedSet.has(m.id));
  _cursorSelectedSet.clear();
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
  try {
    await invoke('cursor_remove_models', { ids });
    if (typeof addLog === 'function') addLog('ok', `已从 Cursor 移除 ${count} 个模型绑定`);
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    _cursorModelsList = prevList;
    cursorRenderTableRows();
    console.error('[cursor] bulk remove failed:', e);
    showCustomAlert('批量移除失败: ' + e, '移除异常', 'error');
  }
}

// 单个模型启停
async function cursorToggleModelEnabled(bindingId, enabled) {
  cursorEnsureBridge();
  const item = _cursorModelsList.find(m => m.id === bindingId);
  if (!item) return;
  const prev = item.enabled;
  item.enabled = !!enabled;
  cursorRenderTableRows();
  try {
    await invoke('cursor_set_models_enabled', { ids: [bindingId], enabled: !!enabled });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    item.enabled = prev;
    cursorRenderTableRows();
    showCustomAlert('切换状态失败: ' + e, '操作异常', 'error');
  }
}

// 单个模型移除
async function cursorRemoveSingleModel(bindingId, displayName) {
  const ok = await showCustomConfirm(
    `确定要从 Cursor 移除「${displayName}」吗？

此操作仅从 Cursor 列表中移除，不会影响共享路由及其他 IDE。`,
    '移除模型',
    'warn'
  );
  if (!ok) return;

  cursorEnsureBridge();
  const prevList = _cursorModelsList.slice();
  _cursorModelsList = _cursorModelsList.filter(m => m.id !== bindingId);
  _cursorSelectedSet.delete(bindingId);
  cursorRenderTableRows();
  cursorUpdateBulkActionButtons();
  try {
    await invoke('cursor_remove_models', { ids: [bindingId] });
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    _cursorModelsList = prevList;
    cursorRenderTableRows();
    showCustomAlert('移除模型失败: ' + e, '移除异常', 'error');
  }
}

// ═══════ CURSOR 编辑模型模态弹窗 ═══════

function openCursorEditModal(bindingId) {
  const item = _cursorModelsList.find(m => m.id === bindingId);
  if (!item) return;

  const modal = document.getElementById('cursorEditModelModal');
  if (!modal) return;

  document.getElementById('cursorEditBindingId').value = item.id;
  document.getElementById('cursorEditDisplayName').value = item.displayName || '';
  
  const iconEl = document.getElementById('cursorEditModelIcon');
  if (iconEl) {
    iconEl.innerHTML = (typeof renderModelIcon === 'function')
      ? renderModelIcon(item.exposedModelId || item.upstreamModel, { size: 20 })
      : '✦';
  }

  const exposedTextEl = document.getElementById('cursorEditExposedIdText');
  if (exposedTextEl) exposedTextEl.textContent = item.exposedModelId || '--';

  const providerNameEl = document.getElementById('cursorEditProviderName');
  if (providerNameEl) providerNameEl.textContent = item.providerName || 'AnyBridge 共享路由';

  const routeUidEl = document.getElementById('cursorEditRouteUidShort');
  if (routeUidEl) routeUidEl.textContent = item.routeUid ? (item.routeUid.length > 18 ? item.routeUid.slice(0, 18) + '...' : item.routeUid) : '--';

  document.getElementById('cursorEditEnabled').checked = item.enabled !== false;
  const tpvEl = document.getElementById('cursorEditThirdPartyVision');
  if (tpvEl) tpvEl.checked = item.useThirdPartyVision === true;
  document.getElementById('cursorEditReasoningEffort').value = item.overrides?.reasoningEffort || '';
  document.getElementById('cursorEditContextWindow').value = item.overrides?.contextWindowTokens || '';
  document.getElementById('cursorEditMaxTokens').value = item.overrides?.maxCompletionTokens || '';

  modal.classList.add('active');
}

function closeCursorEditModal() {
  const modal = document.getElementById('cursorEditModelModal');
  if (modal) modal.classList.remove('active');
}

async function saveCursorEditModel() {
  const bindingId = document.getElementById('cursorEditBindingId').value;
  if (!bindingId) return;

  const displayName = (document.getElementById('cursorEditDisplayName').value || '').trim();
  const enabled = document.getElementById('cursorEditEnabled').checked;
  const useThirdPartyVision = document.getElementById('cursorEditThirdPartyVision') ? document.getElementById('cursorEditThirdPartyVision').checked : false;
  const reasoningEffort = document.getElementById('cursorEditReasoningEffort').value || null;
  const contextRaw = document.getElementById('cursorEditContextWindow').value;
  const maxRaw = document.getElementById('cursorEditMaxTokens').value;

  const contextWindowTokens = contextRaw ? parseInt(contextRaw, 10) : null;
  const maxCompletionTokens = maxRaw ? parseInt(maxRaw, 10) : null;

  cursorEnsureBridge();
  try {
    await invoke('cursor_update_model', {
      payload: {
        id: bindingId,
        displayName: displayName || null,
        enabled,
        useThirdPartyVision,
        overrides: {
          reasoningEffort: reasoningEffort || null,
          contextWindowTokens: (contextWindowTokens && !isNaN(contextWindowTokens)) ? contextWindowTokens : null,
          maxCompletionTokens: (maxCompletionTokens && !isNaN(maxCompletionTokens)) ? maxCompletionTokens : null
        }
      }
    });

    closeCursorEditModal();
    cursorRefreshConsole({ silent: true }).catch(() => {});
  } catch (e) {
    showCustomAlert('保存修改失败: ' + e, '保存异常', 'error');
  }
}

// ═══════ CURSOR 接入设置模态弹窗 ═══════

function openCursorSettingsModal(initialTab = 'diag') {
  const modal = document.getElementById('cursorSettingsModal');
  if (!modal) return;
  switchCursorSettingsTab(initialTab);
  syncCursorSettingsModalData();
  modal.classList.add('active');
  document.addEventListener('keydown', closeCursorSettingsModalOnEsc);
}

function closeCursorSettingsModal() {
  const modal = document.getElementById('cursorSettingsModal');
  if (modal) modal.classList.remove('active');
  document.removeEventListener('keydown', closeCursorSettingsModalOnEsc);
}

function closeCursorSettingsModalOnEsc(event) {
  if (event.key === 'Escape') closeCursorSettingsModal();
}

function switchCursorSettingsTab(tabName) {
  const tabs = ['diag', 'core', 'cert', 'advanced'];
  tabs.forEach(t => {
    const btn = document.getElementById(`cursor-settings-nav-${t}`);
    const panel = document.getElementById(`cursor-settings-panel-${t}`);
    const isTarget = t === tabName;
    if (btn) btn.classList.toggle('active', isTarget);
    if (panel) {
      panel.classList.toggle('active', isTarget);
      panel.style.display = isTarget ? 'block' : 'none';
    }
  });
}

async function syncCursorSettingsModalData() {
  const status = _cursorCachedStatus;
  const running = !!status?.running;
  const certReady = !!status?.certificateReady;
  const modelCount = Array.isArray(_cursorModelsList) ? _cursorModelsList.length : (status?.configuredModels || 0);

  // 1. 状态诊断标签与说明
  const coreTag = document.getElementById('cursor-diag-core-status-tag');
  const coreDesc = document.getElementById('cursor-diag-core-desc');
  if (coreTag) {
    coreTag.textContent = running ? '运行中 (正常)' : '未运行';
    coreTag.className = `tag ${running ? 'success' : 'secondary'}`;
  }
  if (coreDesc) {
    coreDesc.textContent = running
      ? `Core 进程活跃，控制端口 :${status?.controlPort || 17650} 响应正常`
      : 'Core 进程未启动，点击主界面「一键接入」即可自动拉起';
  }

  const certTag = document.getElementById('cursor-diag-cert-status-tag');
  const certDesc = document.getElementById('cursor-diag-cert-desc');
  if (certTag) {
    certTag.textContent = certReady ? '已受信 (就绪)' : '未安装/未信任';
    certTag.className = `tag ${certReady ? 'success' : 'warn'}`;
  }
  if (certDesc && status?.certificateMessage) {
    certDesc.textContent = status.certificateMessage;
  }

  const countTag = document.getElementById('cursor-diag-model-count-tag');
  if (countTag) {
    countTag.textContent = `${modelCount} 个`;
  }

  // 2. 环境与端口
  const portInput = document.getElementById('cursorCorePortInput');
  if (portInput) {
    portInput.value = status?.controlPort || 17650;
  }

  // 3. IDE 安装路径
  const pathInput = document.getElementById('cursorIdePathInput');
  if (pathInput && !pathInput.value) {
    try {
      if (invoke) {
        const p = await invoke('detect_ide_path', { target: 'cursor' });
        if (p) pathInput.value = p;
      }
    } catch (_) {}
  }

  // 4. 供应商标签展示方式
  cursorUpdateTagStyleSelects(_cursorProviderTagStyle);
}

let _cursorTagMainMode = 'badge'; // 'text' | 'badge' | 'none'
let _cursorTextPosition = 'prefix'; // 'prefix' | 'suffix'

function cursorUpdateTagStyleSelects(style) {
  _cursorProviderTagStyle = style || 'badge';
  if (_cursorProviderTagStyle === 'prefix' || _cursorProviderTagStyle === 'suffix') {
    _cursorTagMainMode = 'text';
    _cursorTextPosition = _cursorProviderTagStyle;
  } else if (_cursorProviderTagStyle === 'none') {
    _cursorTagMainMode = 'none';
  } else {
    _cursorTagMainMode = 'badge';
  }

  const sel = document.getElementById('cursorSettingsTagStyleSelect');
  if (sel && sel.value !== _cursorProviderTagStyle) sel.value = _cursorProviderTagStyle;

  cursorRenderModalState();
}

function cursorRenderModalState() {
  // 1. 更新左栏 3 个单选卡片
  const radios = document.querySelectorAll('input[name="cursorTagMainModeRadio"]');
  radios.forEach(r => {
    r.checked = r.value === _cursorTagMainMode;
    const parent = r.closest('.cursor-tag-style-option');
    if (parent) {
      if (r.checked) {
        parent.style.borderColor = 'var(--accent)';
        parent.style.background = 'rgba(37, 99, 235, 0.05)';
      } else {
        parent.style.borderColor = 'var(--border)';
        parent.style.background = 'var(--bg-card)';
      }
    }
  });

  // 2. 右侧配置区按主模式显隐
  const textCustomPanel = document.getElementById('cursorTextCustomizationPanel');
  const customDisabledTip = document.getElementById('cursorTextCustomDisabledTip');
  const isTextMode = _cursorTagMainMode === 'text';

  if (textCustomPanel) textCustomPanel.style.display = isTextMode ? 'flex' : 'none';
  if (customDisabledTip) {
    customDisabledTip.style.display = isTextMode ? 'none' : 'block';
    const tipTitle = document.getElementById('cursorTextCustomDisabledTitle');
    const tipDesc = document.getElementById('cursorTextCustomDisabledDesc');
    if (_cursorTagMainMode === 'badge') {
      if (tipTitle) tipTitle.textContent = 'Cursor 官方原生徽章';
      if (tipDesc) tipDesc.textContent = '直接使用 Cursor 原生蓝色 Badge 标签，打钩在徽章最右侧，无需额外配置符号。';
    } else if (_cursorTagMainMode === 'none') {
      if (tipTitle) tipTitle.textContent = '纯净极简形式';
      if (tipDesc) tipDesc.textContent = '不显示任何供应商标签或前缀，模型名称保持极致清爽整洁。';
    }
  }

  // 3. 更新位置分段控件高亮 (现代白底卡片滑块质感)
  const prefixBtn = document.getElementById('cursorPosPrefixBtn');
  const suffixBtn = document.getElementById('cursorPosSuffixBtn');
  if (prefixBtn && suffixBtn) {
    const isPrefix = _cursorTextPosition === 'prefix';
    if (isPrefix) {
      prefixBtn.style.background = 'var(--bg-card)';
      prefixBtn.style.color = 'var(--text-primary)';
      prefixBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      prefixBtn.style.fontWeight = '650';

      suffixBtn.style.background = 'transparent';
      suffixBtn.style.color = 'var(--text-secondary)';
      suffixBtn.style.boxShadow = 'none';
      suffixBtn.style.fontWeight = '500';
    } else {
      suffixBtn.style.background = 'var(--bg-card)';
      suffixBtn.style.color = 'var(--text-primary)';
      suffixBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      suffixBtn.style.fontWeight = '650';

      prefixBtn.style.background = 'transparent';
      prefixBtn.style.color = 'var(--text-secondary)';
      prefixBtn.style.boxShadow = 'none';
      prefixBtn.style.fontWeight = '500';
    }
  }

  // 4. 更新括号与实时预览
  cursorSyncBracketUI();
  cursorUpdateSimulationPreview();
}

function cursorUpdateSimulationPreview() {
  const modelNameEl = document.getElementById('cursorSimulationModelName');
  const badgeEl = document.getElementById('cursorSimulationBadge');
  if (!modelNameEl || !badgeEl) return;

  if (_cursorTagMainMode === 'text') {
    badgeEl.style.display = 'none';
    const left = _cursorProviderBracketLeft ?? '[';
    const right = _cursorProviderBracketRight ?? ']';
    const tag = `${left}CPA${right}`;
    if (_cursorTextPosition === 'prefix') {
      modelNameEl.textContent = `${tag} Gemini 3.8 Flash`;
    } else {
      modelNameEl.textContent = `Gemini 3.8 Flash ${tag}`;
    }
  } else if (_cursorTagMainMode === 'badge') {
    modelNameEl.textContent = 'Gemini 3.8 Flash';
    badgeEl.style.display = 'inline-block';
    badgeEl.textContent = 'CPA';
  } else {
    modelNameEl.textContent = 'Gemini 3.8 Flash';
    badgeEl.style.display = 'none';
  }
}

function cursorSyncBracketUI() {
  const left = _cursorProviderBracketLeft ?? '[';
  const right = _cursorProviderBracketRight ?? ']';

  const leftInput = document.getElementById('cursorBracketLeftInput');
  const rightInput = document.getElementById('cursorBracketRightInput');
  const customInputs = document.getElementById('cursorTagBracketCustomInputs');
  if (leftInput && leftInput.value !== left) leftInput.value = left;
  if (rightInput && rightInput.value !== right) rightInput.value = right;

  let matched = 'custom';
  if (left === '[' && right === ']') matched = '[]';
  else if (left === '(' && right === ')') matched = '()';
  else if (left === '【' && right === '】') matched = '【】';
  else if (left === '{' && right === '}') matched = '{}';
  else if (left === '' && right === '') matched = 'none';

  const btns = document.querySelectorAll('#cursorBracketPresetButtons .cursor-bracket-btn');
  btns.forEach(b => {
    const p = b.getAttribute('data-bracket');
    const active = p === matched;
    if (active) {
      b.style.background = 'rgba(37, 99, 235, 0.08)';
      b.style.color = 'var(--accent)';
      b.style.borderColor = 'var(--accent)';
      b.style.boxShadow = '0 0 0 1px rgba(37, 99, 235, 0.2)';
      b.style.fontWeight = '650';
    } else {
      b.style.background = 'var(--bg-card)';
      b.style.color = 'var(--text-secondary)';
      b.style.borderColor = 'var(--border)';
      b.style.boxShadow = 'none';
      b.style.fontWeight = '500';
    }
  });

  if (customInputs) {
    customInputs.style.display = matched === 'custom' ? 'flex' : 'none';
  }
}

function selectCursorBracketPreset(preset) {
  if (preset === '[]') {
    _cursorProviderBracketLeft = '[';
    _cursorProviderBracketRight = ']';
  } else if (preset === '()') {
    _cursorProviderBracketLeft = '(';
    _cursorProviderBracketRight = ')';
  } else if (preset === '【】') {
    _cursorProviderBracketLeft = '【';
    _cursorProviderBracketRight = '】';
  } else if (preset === '{}') {
    _cursorProviderBracketLeft = '{';
    _cursorProviderBracketRight = '}';
  } else if (preset === 'none') {
    _cursorProviderBracketLeft = '';
    _cursorProviderBracketRight = '';
  }
  cursorSyncBracketUI();
  cursorUpdateSimulationPreview();
}

function openCursorTagStyleModal() {
  const modal = document.getElementById('cursorTagStyleModal');
  if (!modal) return;
  cursorUpdateTagStyleSelects(_cursorProviderTagStyle);
  modal.classList.add('active');
  document.addEventListener('keydown', closeCursorTagStyleModalOnEsc);

  // 绑定左栏 3 个主卡片点击
  const options = modal.querySelectorAll('.cursor-tag-style-option');
  options.forEach(opt => {
    opt.onclick = () => {
      const radio = opt.querySelector('input[type="radio"]');
      if (radio) {
        radio.checked = true;
        _cursorTagMainMode = radio.value;
        cursorRenderModalState();
      }
    };
  });

  // 绑定位置按钮：前置 / 后置
  const prefixBtn = document.getElementById('cursorPosPrefixBtn');
  const suffixBtn = document.getElementById('cursorPosSuffixBtn');
  if (prefixBtn) {
    prefixBtn.onclick = (e) => {
      e.stopPropagation();
      _cursorTextPosition = 'prefix';
      cursorRenderModalState();
    };
  }
  if (suffixBtn) {
    suffixBtn.onclick = (e) => {
      e.stopPropagation();
      _cursorTextPosition = 'suffix';
      cursorRenderModalState();
    };
  }

  // 绑定预设括号按钮点击
  const presetBtns = modal.querySelectorAll('#cursorBracketPresetButtons .cursor-bracket-btn');
  presetBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const p = btn.getAttribute('data-bracket');
      if (p === 'custom') {
        const customInputs = document.getElementById('cursorTagBracketCustomInputs');
        if (customInputs) customInputs.style.display = 'flex';
        btn.style.background = 'rgba(37, 99, 235, 0.08)';
        btn.style.color = 'var(--accent)';
        btn.style.borderColor = 'var(--accent)';
        btn.style.boxShadow = '0 0 0 1px rgba(37, 99, 235, 0.2)';
        btn.style.fontWeight = '650';
        presetBtns.forEach(other => {
          if (other !== btn) {
            other.style.background = 'var(--bg-card)';
            other.style.color = 'var(--text-secondary)';
            other.style.borderColor = 'var(--border)';
            other.style.boxShadow = 'none';
            other.style.fontWeight = '500';
          }
        });
        const leftInput = document.getElementById('cursorBracketLeftInput');
        if (leftInput) leftInput.focus();
      } else {
        selectCursorBracketPreset(p);
      }
    };
  });

  // 绑定自定义左右符号输入实时响应
  const leftInput = document.getElementById('cursorBracketLeftInput');
  const rightInput = document.getElementById('cursorBracketRightInput');
  if (leftInput) {
    leftInput.oninput = () => {
      _cursorProviderBracketLeft = leftInput.value;
      cursorUpdateSimulationPreview();
    };
  }
  if (rightInput) {
    rightInput.oninput = () => {
      _cursorProviderBracketRight = rightInput.value;
      cursorUpdateSimulationPreview();
    };
  }
}

function closeCursorTagStyleModal() {
  const modal = document.getElementById('cursorTagStyleModal');
  if (modal) modal.classList.remove('active');
  document.removeEventListener('keydown', closeCursorTagStyleModalOnEsc);
}

function closeCursorTagStyleModalOnEsc(event) {
  if (event.key === 'Escape') closeCursorTagStyleModal();
}

async function saveCursorTagStyleModal() {
  let targetStyle = 'badge';
  if (_cursorTagMainMode === 'text') {
    targetStyle = _cursorTextPosition; // 'prefix' 或 'suffix'
  } else if (_cursorTagMainMode === 'none') {
    targetStyle = 'none';
  } else {
    targetStyle = 'badge';
  }

  const leftInput = document.getElementById('cursorBracketLeftInput');
  const rightInput = document.getElementById('cursorBracketRightInput');
  if (leftInput) _cursorProviderBracketLeft = leftInput.value;
  if (rightInput) _cursorProviderBracketRight = rightInput.value;

  closeCursorTagStyleModal();
  await cursorChangeProviderTagStyle(targetStyle, _cursorProviderBracketLeft, _cursorProviderBracketRight);
}

async function cursorChangeProviderTagStyle(style, bracketLeft, bracketRight) {
  const nextStyle = String(style || 'badge').trim().toLowerCase();
  const bl = bracketLeft ?? _cursorProviderBracketLeft;
  const br = bracketRight ?? _cursorProviderBracketRight;
  _cursorProviderTagStyle = nextStyle;
  _cursorProviderBracketLeft = bl;
  _cursorProviderBracketRight = br;
  cursorUpdateTagStyleSelects(nextStyle);
  if (!invoke) return;

  try {
    cursorSetBusy(true);
    await invoke('cursor_set_provider_tag_style', {
      style: nextStyle,
      bracketLeft: bl,
      bracketRight: br,
    });

    const labelMap = {
      prefix: '前缀形式',
      suffix: '后缀形式',
      badge: '徽章形式',
      none: '纯净形式',
    };
    const styleLabel = labelMap[nextStyle] || nextStyle;
    showCustomAlert(`已将 Cursor 供应商标签展示方式切换为「${styleLabel}」，已自动同步至 Cursor。`, '设置已保存', 'success');
  } catch (err) {
    console.error('[cursor] set provider tag style error:', err);
    showCustomAlert(`保存展示方式失败: ${err?.message || err}`, '保存失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

function onCursorTagStyleChange(event) {
  const target = event?.target;
  if (target) {
    cursorChangeProviderTagStyle(target.value);
  }
}

async function cursorRefreshConsoleAction() {
  await cursorRefreshConsole();
  await syncCursorSettingsModalData();
  showCustomAlert('Cursor 状态数据已最新刷新。', '刷新成功', 'success');
}

async function detectCursorIdePath() {
  const input = document.getElementById('cursorIdePathInput');
  const statusEl = document.getElementById('cursor-ide-path-status');
  if (!invoke) return;
  try {
    const path = await invoke('detect_ide_path', { target: 'cursor' });
    if (path) {
      if (input) input.value = path;
      if (statusEl) statusEl.textContent = '已自动定位 Cursor 可执行文件 ✓';
    } else {
      if (input) input.placeholder = '自动探测失败，请手动指定可执行文件绝对路径';
      if (statusEl) statusEl.textContent = '未探测到默认安装目录或运行中进程，请手动指定';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '探测失败: ' + e;
  }
}

async function saveCursorIdePath() {
  const input = document.getElementById('cursorIdePathInput');
  const statusEl = document.getElementById('cursor-ide-path-status');
  const path = input ? input.value.trim() : '';
  if (!path) {
    showCustomAlert('请先输入或探测 Cursor 安装路径。', '路径为空', 'warn');
    return;
  }
  try {
    if (invoke) {
      await invoke('set_ide_path', { path });
      if (statusEl) statusEl.textContent = '已成功保存 Cursor 路径 ✓';
      showCustomAlert('Cursor 路径已保存。', '保存成功', 'success');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '保存失败: ' + e;
    showCustomAlert(String(e), '保存失败', 'error');
  }
}

async function saveCursorCorePort() {
  const portInput = document.getElementById('cursorCorePortInput');
  const val = portInput ? parseInt(portInput.value.trim(), 10) : 17650;
  if (!val || val < 1024 || val > 65535) {
    showCustomAlert('端口号必须在 1024 ~ 65535 范围内。', '端口无效', 'warn');
    return;
  }
  try {
    if (invoke) {
      const current = (await invoke('load_config')) || {};
      current.CURSOR_CORE_PORT = String(val);
      await invoke('save_config', { values: current });
      showCustomAlert(`Cursor Core 端口已配置为 ${val}。重启 Core 后生效。`, '保存成功', 'success');
    }
  } catch (e) {
    showCustomAlert('保存端口失败: ' + e, '保存失败', 'error');
  }
}

// ═══════ CURSOR 独立添加模型页面 ═══════

async function openCursorAddPage() {
  navigateTo('platform-cursor-add');
  await initCursorAddPage();
}

async function initCursorAddPage() {
  cursorEnsureBridge();
  try {
    const raw = await invoke('cursor_list_provider_models') || [];
    _cursorProviderModels = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[cursor-add] list provider models failed:', e);
    _cursorProviderModels = [];
  }

  // 注入 AnyBridge 本地代理供应商到列表首位
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    if (lp && Array.isArray(lp.models)) {
      lp.models.forEach(m => {
        const already = (_cursorModelsList || []).some(item =>
          item.targetModel === m.id || item.exposedModelId === m.id || item.id === m.id
        );
        m.alreadyAdded = already;
      });
    }
    _cursorProviderModels = _cursorProviderModels.filter(p => !isLocalProxyProviderEntry(p));
    _cursorProviderModels.unshift(lp);
  }

  _cursorAddSelectedProvider = null;
  _cursorAddSelectedModels.clear();
  _cursorAddSearchKw = '';

  const searchInput = document.getElementById('cursor-add-search');
  if (searchInput) searchInput.value = '';

  // 默认选中第一个有模型的供应商（优先排在最前的本地代理或第一项）
  const sorted = platformAddVisibleProviders(_cursorProviderModels, '');
  const firstWithModels = sorted.find(p => p.models && p.models.length > 0);
  if (firstWithModels) {
    _cursorAddSelectedProvider = firstWithModels.providerId;
  }

  renderCursorAddProviderList();
  renderCursorAddModels();
  updateCursorAddConfirmButton();
}

function onCursorAddSearch() {
  const input = document.getElementById('cursor-add-search');
  _cursorAddSearchKw = (input?.value || '').trim().toLowerCase();
  renderCursorAddProviderList();
}

function toggleCursorAddSort(event) {
  togglePlatformAddSortMenu('cursor', event);
}

function chooseCursorAddSortMode(mode) {
  choosePlatformAddSortMode('cursor', mode);
}

function renderCursorAddProviderList() {
  const list = document.getElementById('cursor-add-provider-list');
  syncPlatformAddSortControl('cursor');
  if (!list) return;

  if (!_cursorProviderModels || _cursorProviderModels.length === 0) {
    list.innerHTML = '<div class="cb-add-prov-empty">暂无可用的供应商，请先在「供应商」页添加</div>';
    return;
  }

  const filtered = platformAddVisibleProviders(_cursorProviderModels, _cursorAddSearchKw);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cb-add-prov-empty">没有匹配的供应商</div>';
    return;
  }

  list.innerHTML = filtered.map(p => {
    const initial = (p.providerName || '?').charAt(0).toUpperCase();
    const enabled = p.enabled !== false;
    const isActive = _cursorAddSelectedProvider === p.providerId;
    const isBuiltin = isBuiltinProxyEntry(p);
    const availableCount = (p.models || []).length;
    const alreadyCount = (p.models || []).filter(m => m.alreadyAdded).length;
    const countDisplay = alreadyCount > 0 ? `${alreadyCount}/${availableCount}` : String(availableCount);

    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${cursorEsc(initial)}</span>`;

    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectCursorAddProvider" data-arg="${cursorEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${cursorEsc(p.providerName)}</span>
        <span class="cb-add-prov-count" title="共 ${availableCount} 个模型，其中 ${alreadyCount} 个已添加">${countDisplay}</span>
      </div>
    `;
  }).join('');
}

function selectCursorAddProvider(providerId) {
  _cursorAddSelectedProvider = providerId;
  renderCursorAddProviderList();
  renderCursorAddModels();
  updateCursorAddConfirmButton();
}

function renderCursorAddModels() {
  const titleEl = document.getElementById('cursor-add-models-title');
  const subEl = document.getElementById('cursor-add-models-sub');
  const body = document.getElementById('cursor-add-models-list-page');
  if (!body) return;

  if (!_cursorAddSelectedProvider) {
    if (titleEl) titleEl.textContent = '请选择供应商';
    if (subEl) subEl.textContent = '左侧选择一个供应商，右侧将展示其可用模型';
    body.innerHTML = '<div class="cb-add-models-empty">请从左侧选择一个供应商</div>';
    return;
  }

  const provider = _cursorProviderModels.find(p => p.providerId === _cursorAddSelectedProvider);
  if (!provider) {
    if (titleEl) titleEl.textContent = '供应商未找到';
    if (subEl) subEl.textContent = '';
    body.innerHTML = '<div class="cb-add-models-empty">供应商未找到</div>';
    return;
  }

  if (titleEl) titleEl.textContent = provider.providerName;
  if (subEl) subEl.textContent = `该供应商下共有 ${provider.models.length} 个模型可供添加到 Cursor`;

  const models = provider.models || [];
  if (models.length === 0) {
    body.innerHTML = '<div class="cb-add-models-empty">该供应商暂无模型，请在供应商管理中拉取或添加模型</div>';
    return;
  }

  const selectedForProv = _cursorAddSelectedModels.get(provider.providerId) || new Set();

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(models);

  body.innerHTML = sortedModels.map(m => {
    const isAlready = !!m.alreadyAdded;
    const isSelected = selectedForProv.has(m.id);
    const caps = [];
    if (m.supportsToolCall) caps.push(cbCapabilityPill('cb', 'tool', '工具'));
    if (m.supportsImages) caps.push(cbCapabilityPill('cb', 'image', '图片'));
    if (m.supportsReasoning) caps.push(cbCapabilityPill('cb', 'reason', '推理'));

    return `
      <label class="cb-add-model-row ${isAlready ? 'already-added' : ''}" data-model-id="${cursorEsc(m.id)}">
        <input type="checkbox" class="cb-add-model-check" data-model-id="${cursorEsc(m.id)}" ${isAlready ? 'disabled checked' : (isSelected ? 'checked' : '')} onchange="toggleCursorAddModel('${cursorEsc(provider.providerId)}', '${cursorEsc(m.id)}', this.checked)">
        ${cbAddModelIdentity(m.id)}
        <div class="cb-add-model-caps" style="margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          ${caps.join('')}
          ${isAlready ? '<span class="tag" style="background:rgba(148,163,184,0.15);color:var(--text-muted);font-size:10px;">已添加</span>' : ''}
        </div>
      </label>
    `;
  }).join('');
}

function toggleCursorAddModel(providerId, modelId, isChecked) {
  const provider = _cursorProviderModels.find(p => p.providerId === providerId);
  if (!provider) return;
  const model = (provider.models || []).find(m => m.id === modelId);
  if (!model || model.alreadyAdded) return;

  if (!_cursorAddSelectedModels.has(providerId)) {
    _cursorAddSelectedModels.set(providerId, new Set());
  }
  const set = _cursorAddSelectedModels.get(providerId);
  if (typeof isChecked === 'boolean') {
    if (isChecked) {
      set.add(modelId);
    } else {
      set.delete(modelId);
    }
  } else {
    if (set.has(modelId)) {
      set.delete(modelId);
    } else {
      set.add(modelId);
    }
  }

  updateCursorAddConfirmButton();
}

function cursorAddSelectAll() {
  if (!_cursorAddSelectedProvider) return;
  const provider = _cursorProviderModels.find(p => p.providerId === _cursorAddSelectedProvider);
  if (!provider) return;

  if (!_cursorAddSelectedModels.has(_cursorAddSelectedProvider)) {
    _cursorAddSelectedModels.set(_cursorAddSelectedProvider, new Set());
  }
  const set = _cursorAddSelectedModels.get(_cursorAddSelectedProvider);

  const container = document.getElementById('cursor-add-models-list-page');
  if (container) {
    const checks = container.querySelectorAll('.cb-add-model-check:not(:disabled)');
    checks.forEach(chk => {
      chk.checked = true;
      const mid = chk.dataset.modelId;
      if (mid) set.add(mid);
    });
  } else {
    (provider.models || []).forEach(m => {
      if (!m.alreadyAdded) set.add(m.id);
    });
  }

  updateCursorAddConfirmButton();
}

function cursorAddSelectNone() {
  if (!_cursorAddSelectedProvider) return;
  if (_cursorAddSelectedModels.has(_cursorAddSelectedProvider)) {
    _cursorAddSelectedModels.get(_cursorAddSelectedProvider).clear();
  }
  const container = document.getElementById('cursor-add-models-list-page');
  if (container) {
    const checks = container.querySelectorAll('.cb-add-model-check:not(:disabled)');
    checks.forEach(chk => {
      chk.checked = false;
    });
  }
  updateCursorAddConfirmButton();
}

function updateCursorAddConfirmButton() {
  let totalSelected = 0;
  _cursorAddSelectedModels.forEach(set => {
    totalSelected += set.size;
  });

  const btn = document.getElementById('cursor-add-confirm-page');
  if (btn) {
    btn.disabled = totalSelected === 0;
    const label = btn.querySelector('.model-action-label');
    if (label) {
      label.textContent = totalSelected > 0 ? ` 保存选择 (${totalSelected})` : ' 保存选择';
    }
  }
}

function onCursorAddNamingRuleChange() {
  const prefix = (document.getElementById('cursor-add-prefix')?.value || '').trim();
  const suffix = (document.getElementById('cursor-add-suffix')?.value || '').trim();
  const previewEl = document.getElementById('cursor-add-naming-preview');
  if (previewEl) {
    let name = 'gpt-5.4';
    if (prefix) name = `${prefix} ${name}`;
    if (suffix) name = `${name} ${suffix}`;
    previewEl.textContent = name;
  }
}

async function confirmAddCursorModelsPage() {
  const modelsPayload = [];
  _cursorAddSelectedModels.forEach((modelSet, providerId) => {
    modelSet.forEach(modelId => {
      modelsPayload.push({ providerId, modelId });
    });
  });

  if (modelsPayload.length === 0) return;

  const prefix = (document.getElementById('cursor-add-prefix')?.value || '').trim() || null;
  const suffix = (document.getElementById('cursor-add-suffix')?.value || '').trim() || null;

  const btn = document.getElementById('cursor-add-confirm-page');
  const label = btn ? btn.querySelector('.model-action-label') : null;
  const originalLabel = label ? label.textContent : ' 保存选择';
  if (btn) {
    btn.disabled = true;
    if (label) label.textContent = ' 保存中...';
  }

  cursorEnsureBridge();
  try {
    await invoke('cursor_add_models', {
      req: {
        models: modelsPayload,
        prefix,
        suffix
      }
    });
    _cursorAddSelectedModels.clear();
    navigateTo('platform-cursor');
    cursorRefreshConsole({ silent: true }).catch(err => {
      console.warn('[cursor] background refresh failed:', err);
    });
  } catch (e) {
    console.error('[cursor-add] confirm add failed:', e);
    showCustomAlert('添加模型失败: ' + e, '添加异常', 'error');
    if (btn) {
      btn.disabled = false;
      if (label) label.textContent = originalLabel;
    }
  } finally {
    if (btn && _cursorAddSelectedModels.size === 0) {
      btn.disabled = true;
      if (label) label.textContent = ' 保存选择';
    }
  }
}

// 主按钮动作：智能分流
async function cursorPrimaryAction() {
  if (cursorConsoleBusy) return;
  cursorEnsureBridge();

  const status = _cursorCachedStatus;
  if (!status?.certificateReady) {
    await cursorInstallCertAction();
    return;
  }
  if (_cursorModelsList.length === 0) {
    openCursorAddPage();
    return;
  }
  if (status?.running) {
    await cursorRefreshConsole();
    if (typeof addLog === 'function') addLog('info', 'Cursor 已处于接入状态');
    return;
  }

  await cursorEnableAction();
}

// 启动 Cursor 接入
async function cursorEnableAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true, '正在接入...');
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在启动 Cursor Core 协议网关并配置接入...');
    
    // 执行启用
    const result = await invoke('cursor_enable');
    _cursorCachedStatus = result;
    
    if (typeof addLog === 'function') addLog('ok', `Cursor Core 网关已在端口 ${result.controlPort} 启动，已写入代理设置`);
    await cursorRefreshConsole({ silent: true });

    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('Cursor 接入服务已成功启动并配置！需重启 Cursor 才能生效。', 'cursor', {
        mode: 'proxy',
        detail: '重启后请在右下角模型列表中选择配置好的自备模型。'
      });
    } else {
      showCustomAlert(
        'Cursor Core 接入服务已启动并成功配置！\n\n请重启 Cursor IDE，在右下角模型列表中选择自备模型即可畅享 Agent。',
        '接入成功',
        'success'
      );
    }
  } catch (e) {
    console.error('[cursor] enable failed:', e);
    if (typeof addLog === 'function') addLog('err', 'Cursor 接入失败: ' + e);
    showCustomAlert(String(e), '启动接入失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 还原直连 / 停用
async function cursorDisableAction() {
  if (cursorConsoleBusy) return;

  cursorSetBusy(true, '正在停止...');
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在停止 Cursor Core 并还原设置...');
    
    const result = await invoke('cursor_disable');
    _cursorCachedStatus = result;

    if (typeof addLog === 'function') addLog('ok', 'Cursor 已还原直连状态，Core 网关已安全退出');
    await cursorRefreshConsole({ silent: true });

    if (typeof promptRestartIde === 'function') {
      await promptRestartIde('Cursor 已还原为直连配置，需重启 Cursor 才能生效。', 'cursor', {
        mode: 'direct'
      });
    } else {
      showCustomAlert('Cursor 已成功还原直连配置。重启 Cursor 后配置即可生效。', '还原完成', 'success');
    }
  } catch (e) {
    console.error('[cursor] disable failed:', e);
    if (typeof addLog === 'function') addLog('err', 'Cursor 还原直连失败: ' + e);
    showCustomAlert(String(e), '还原失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 实时热同步最新路由模型
async function cursorSyncRoutesAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在向 Cursor Core 同步最新模型路由...');
    
    const result = await invoke('cursor_sync_routes');
    _cursorCachedStatus = result;
    
    if (typeof addLog === 'function') addLog('ok', `模型路由热同步成功，当前可用模型数: ${result.configuredModels}`);
    await cursorRefreshConsole();
    showCustomAlert(`已将最新 ${result.configuredModels} 个代理模型推送到 Cursor！Cursor 下拉列表将自动生效。`, '同步成功', 'success');
  } catch (e) {
    console.error('[cursor] sync routes failed:', e);
    if (typeof addLog === 'function') addLog('err', '模型同步失败: ' + e);
    showCustomAlert(String(e), '同步失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 重启 Core 服务
async function cursorRestartCoreAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    if (typeof addLog === 'function') addLog('info', '正在重启 Cursor Core 进程...');
    const result = await invoke('cursor_restart');
    _cursorCachedStatus = result;
    if (typeof addLog === 'function') addLog('ok', 'Cursor Core 已成功重启');
    await cursorRefreshConsole();
    showCustomAlert('Cursor Core 服务已成功重启并刷新配置。', '重启成功', 'success');
  } catch (e) {
    console.error('[cursor] restart core failed:', e);
    if (typeof addLog === 'function') addLog('err', '重启 Core 失败: ' + e);
    showCustomAlert(String(e), '重启失败', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 重启 IDE 软件
async function cursorRestartIdeAction() {
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

// 快速预检
async function cursorPreflightAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  const tip = document.getElementById('cursor-diag-tip-text');
  if (tip) tip.textContent = '正在全面诊断 Cursor 接入环境（二进制、证书、代理 Key、模型路由）...';
  try {
    cursorEnsureBridge();
    const result = await invoke('cursor_preflight');
    _cursorCachedStatus = result;
    await cursorRefreshConsole();
    await syncCursorSettingsModalData();
    if (tip) {
      tip.innerHTML = '<span style="color:var(--success);font-weight:600;">✓ 环境预检全部通过：Core 二进制、CA 根证书、本地代理密钥与模型路由均已就绪。</span>';
    }
    showCustomAlert('Cursor Core 接入环境检查通过：\n\n✓ 二进制就绪\n✓ 本地代理 Key 已配置\n✓ AnyBridge 信任证书已就绪\n✓ 代理模型就绪', '预检通过', 'success');
  } catch (e) {
    if (tip) {
      const errStr = typeof escapeHtml === 'function' ? escapeHtml(String(e)) : String(e);
      tip.innerHTML = `<span style="color:var(--danger);font-weight:600;">✗ 预检未通过: ${errStr}</span>`;
    }
    await syncCursorSettingsModalData();
    showCustomAlert(String(e), '预检未通过', 'error');
  } finally {
    cursorSetBusy(false);
  }
}

// 安装/修复证书
async function cursorInstallCertAction() {
  if (cursorConsoleBusy) return;
  cursorSetBusy(true);
  try {
    cursorEnsureBridge();
    const result = await invoke('cert_install');
    if (typeof addLog === 'function') addLog('ok', 'CA 证书安装完成: ' + result);
    await cursorRefreshConsole();
    await syncCursorSettingsModalData();
    showCustomAlert(result || 'AnyBridge Local CA 根证书已安装并信任。', '证书已安装', 'success');
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', 'CA 安装失败: ' + e);
    showCustomAlert(String(e), '证书安装失败', 'error');
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

function cursorOpenProxyLogs() {
  if (typeof openProxyPanel === 'function') {
    openProxyPanel('logs');
  } else {
    navigateTo('proxy');
  }
}

// 保持历史函数兼容性挂载
function cursorStartProxy() { return cursorEnableAction(); }
function cursorSwitchToProxy() { return cursorEnableAction(); }
function cursorRestoreDirect() { return cursorDisableAction(); }
function cursorRestartIde() { return cursorRestartIdeAction(); }
function cursorRunHealthcheck() { return cursorPreflightAction(); }
function cursorInstallCert() { return cursorInstallCertAction(); }
function cursorOpenStats() { return cursorOpenProxyLogs(); }

function openPlatformPage(platformId) {
  navigateTo(`platform-${platformId}`);
  renderPlatformDetailStatuses();
  renderPlatformProviderOptions();
  if (platformId === 'cursor') {
    if (_cursorModelsList && _cursorModelsList.length > 0) {
      cursorRenderTableRows();
    }
    cursorRefreshConsole({ silent: true }).catch(e => {
      if (typeof addLog === 'function') addLog('err', 'Cursor 控制台刷新失败: ' + e);
    });
  } else if (platformId === 'antigravity') {
    antigravityRefreshConsole({ silent: true });
    antigravityRenderTableRows();
  } else if (platformId === 'codebuddy') {
    loadCodeBuddyModels();
  } else if (platformId === 'workbuddy') {
    loadWbModels();
  } else if (platformId === 'zcode') {
    loadZcModels();
  } else if (platformId === 'grok') {
    renderGrokPageStatus(platformInfoOf('grok') || {});
  } else if (platformId === 'claude-desktop') {
    if (typeof loadClaudeDesktopConsole === 'function') {
      loadClaudeDesktopConsole();
    }
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

globalThis._switchProgressUnlisten = null;
globalThis._switchProgressPlatform = null;
globalThis._switchFlowState = null;

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
  // Codex 主 UI 走卡片 applyCodexProviderConfig；这里兜底避免通用入口只写配置不重启。
  // platform-codex-select 可能不存在（卡片 UI），依次回退：store 当前 → select → 首个配置。
  if (platformId === 'codex') {
    const storeId = String(providerStore?.platforms?.codex?.providerId || '').trim();
    const select = document.getElementById('platform-codex-select');
    const selectId = select ? String(select.value || '').trim() : '';
    const firstId = (platformProviderList('codex')[0] || {}).id || '';
    const providerId = storeId || selectId || firstId;
    if (!providerId) {
      showCustomAlert('请先添加一份 Codex 配置。', '无法切换', 'warn');
      return;
    }
    return applyCodexProviderConfig(providerId);
  }

  const def = platformDef(platformId);
  const select = document.getElementById(`platform-${platformId}-select`);
  const providerId = select ? select.value : '';
  if (!providerId) {
    showCustomAlert('请选择一个可用供应商。', '无法切换', 'warn');
    return;
  }

  const provider = platformProviderList(platformId).find(p => p.id === providerId);
  if (!provider) {
    showCustomAlert('供应商不存在或尚未加载。', '无法切换', 'error');
    return;
  }
  const confirmMessage = `将把「${provider.name}」写入 ${def.name} 配置文件，并在首次接管前创建 .byok-bak 备份。`;
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
    if (platformId === 'opencode') renderPlatformDetailStatuses();
    else onPlatformProviderChange(platformId);
  }
}

function codexApplyConfirmMessage(provider) {
  const info = platformInfoOf('codex') || {};
  const from = info.currentProviderName || info.currentProviderId || '当前配置';
  const to = provider.name || provider.id || '目标配置';
  const model = provider.defaultModel || '默认模型';
  // 与 applyCodexProviderConfig / watcher 一致：preserveOfficialAuth 优先禁止 CDP 注入。
  const preserveAuth = codexProviderPreservesOfficialAuth(provider);
  const needsInject = codexProviderNeedsInject(provider);
  const hint = codexDesktopAutomationSupported()
    ? (preserveAuth
      ? '切换后会自动重启 Codex（保留官方登录模式，不进行 CDP 注入）。'
      : needsInject
        ? '切换后会自动重启 Codex，并解锁模型选择器中的第三方模型。'
        : '切换后会自动重启 Codex 生效（不进行模型注入）。')
    : '切换后会写入 Codex 配置；当前平台不支持自动重启 / 桌面注入，请手动重启 Codex 生效。';
  const historyHint = provider.unifySessionHistory === false
    ? '切换后会按当前 model_provider 自动修复会话索引可见性。'
    : '切换后会自动对齐会话索引到统一桶 codex_local_access，历史会话继续可见。';
  return `将把 Codex 从「${from}」切换到「${to}」。\n\n供应商：${to}\n默认模型：${model}\n\n${hint}\n${historyHint}`;
}

async function repairCodexSessionVisibility() {
  const info = platformInfoOf('codex') || {};
  const providerId = (info.codexConfig && info.codexConfig.modelProviderId)
    || info.currentProviderId
    || 'openai';
  const ok = await showCustomConfirm(
    `将把本地 Codex 会话索引（state_5.sqlite）对齐到当前 model_provider「${providerId}」，使历史会话在侧边栏重新可见。\n\n建议先完全关闭 Codex / Codex App，避免数据库被占用。\n\n不会改写会话内容文件（rollout）。若要统一到 codex_local_access，请先切换到开启「统一会话历史」的配置。`,
    '修复会话历史',
    'info'
  );
  if (!ok) return;

  setPlatformBusy('codex', true);
  showSwitchProgress('codex', '正在修复会话历史…');
  try {
    const summary = await invoke('repair_codex_session_visibility');
    const msg = summary && summary.message
      ? `${summary.message}（目标桶：${summary.targetProvider || providerId}，更新 ${summary.updatedSqliteRowCount || 0} 条）`
      : '历史会话可见性修复完成';
    if (typeof addLog === 'function') addLog('ok', msg);
    showCustomAlert(msg, '修复完成', 'success');
    await refreshPlatforms({ silent: true });
  } catch (e) {
    if (typeof addLog === 'function') addLog('err', `修复会话历史失败: ${e}`);
    showCustomAlert(String(e), '修复失败', 'error');
  } finally {
    hideSwitchProgress();
    setPlatformBusy('codex', false);
    renderPlatformDetailStatuses();
  }
}

async function restoreCodexOfficialConfig() {
  const info = platformInfoOf('codex') || {};
  const alreadyOfficial = !!(info.codexConfig && info.codexConfig.isOfficial);
  const autoRestartHint = codexDesktopAutomationSupported()
    ? '切换后会自动重启 Codex（官方模式）。'
    : '切换后请手动重启 Codex；自动重启 Codex Desktop 仅支持 Windows。';
  const message = alreadyOfficial
    ? 'Codex 当前已经是官方默认配置。仍要清理第三方配置吗？'
    : `将把 Codex 切回官方默认配置。\n\n${autoRestartHint}`;
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

        let restart = null;
        if (codexDesktopAutomationSupported()) {
          setMessage('正在重启 Codex 桌面版（官方模式）…');
          restart = assertSwitchResultOk(
            await invoke('restart_codex_desktop', { managed: false, model: null }),
            'Codex 桌面版官方模式重启失败'
          );
        } else {
          setMessage('当前平台不支持自动重启 Codex Desktop，已跳过桌面重启。');
        }

        if (typeof addLog === 'function') {
          addLog('ok', result.message || 'Codex 已切回官方配置');
          if (restart) addLog('ok', restart.message || 'Codex 桌面版已按官方模式重启');
          else addLog('warn', codexDesktopUnsupportedMessage());
        }
        setMessage('正在刷新 Codex 状态…');
        await refreshPlatforms({ silent: true, reloadProviders: false });
        return {
          message: `${result.message || 'Codex 已切回官方配置。'}\n\n${restart ? (restart.message || 'Codex 桌面版已按官方模式重启。') : codexDesktopUnsupportedMessage()}`
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
    if (platformId === 'codex' || platformId === 'opencode' || platformId === 'grok') renderPlatformDetailStatuses();
    else onPlatformProviderChange(platformId);
  }
}

// ═══════ CodeBuddy 自定义模型管理 ═══════

// 表格行工厂（提前声明，避免 TDZ）
globalThis.cbRowFactory = createCbRowFactory('Cb');
globalThis.wbRowFactory = createCbRowFactory('Wb');
globalThis.zcRowFactory = createCbRowFactory('Zc');

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
globalThis.PLATFORM_ADD_SORT_PREFIXES = ['cb', 'wb', 'zc', 'grok', 'opencode', 'codex', 'claude', 'cursor', 'claudeDesktop', 'antigravity'];
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

function platformAddProviderSortedList(list = []) {
  if (!Array.isArray(list)) return [];
  const builtinProxies = [];
  const regularProviders = [];
  for (const p of list) {
    if (isBuiltinProxyEntry(p)) {
      builtinProxies.push(p);
    } else {
      regularProviders.push(p);
    }
  }

  // 内置反代工具始终固定排在最前面：
  // AnyBridge 第一，CPA 第二，插件新增的内置反代工具第三（同级按名称正序）
  builtinProxies.sort((a, b) => {
    const rankA = builtinProxySortRank(a);
    const rankB = builtinProxySortRank(b);
    if (rankA !== rankB) return rankA - rankB;
    return comparePlatformAddProvidersByName(a, b);
  });

  // 常规第三方供应商按当前选中的模式排序
  if (platformAddProviderSortMode === 'name-asc') {
    regularProviders.sort(comparePlatformAddProvidersByName);
  } else if (platformAddProviderSortMode === 'name-desc') {
    regularProviders.sort((a, b) => comparePlatformAddProvidersByName(b, a));
  }

  return [...builtinProxies, ...regularProviders];
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
  renderGrokAddProviderList();
  renderOpenCodeAddProviderList();
  renderCodexAddProviderList();
  renderClaudeAddProviderList();
  renderCursorAddProviderList();
  renderAntigravityAddProviderList();
  if (typeof renderClaudeDesktopSourceList === 'function') {
    const activeId = document.getElementById('claude-desktop-config-source-id')?.value || '';
    renderClaudeDesktopSourceList(activeId);
  }
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
function toggleGrokAddSort(event) { togglePlatformAddSortMenu('grok', event); }
function chooseGrokAddSortMode(mode) { choosePlatformAddSortMode('grok', mode); }
function toggleOpenCodeAddSort(event) { togglePlatformAddSortMenu('opencode', event); }
function chooseOpenCodeAddSortMode(mode) { choosePlatformAddSortMode('opencode', mode); }
function toggleCodexAddSort(event) { togglePlatformAddSortMenu('codex', event); }
function chooseCodexAddSortMode(mode) { choosePlatformAddSortMode('codex', mode); }
function toggleClaudeAddSort(event) { togglePlatformAddSortMenu('claude', event); }
function chooseClaudeAddSortMode(mode) { choosePlatformAddSortMode('claude', mode); }
function toggleClaudeDesktopAddSort(event) { togglePlatformAddSortMenu('claudeDesktop', event); }
function chooseClaudeDesktopAddSortMode(mode) { choosePlatformAddSortMode('claudeDesktop', mode); }
function toggleAntigravityAddSort(event) { togglePlatformAddSortMenu('antigravity', event); }
function chooseAntigravityAddSortMode(mode) { choosePlatformAddSortMode('antigravity', mode); }

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

globalThis.CB_PLATFORM = 'codebuddy';
globalThis.WB_PLATFORM = 'workbuddy';

function cbApplyConfigMeta(prefix, data, fallbackPath) {
  const path = data && data._configPath ? String(data._configPath) : fallbackPath;
  const scope = data && data._configScope ? String(data._configScope) : 'user';
  bindRevealPathLabel(`${prefix}-config-path-label`, path);
  const scopeLabel = document.getElementById(`${prefix}-config-scope-label`);
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
    const platform = btn.getAttribute('data-arg') || '';
    const isCodeBuddy = platform === 'codebuddy';
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

function normalizeBuddyModelsForPlatform(models, platform) {
  return (Array.isArray(models) ? models : []).map((model) => {
    const entry = cloneTencentBuddyJson(model) || {};
    // 新版 WorkBuddy / CodeBuddy 仅识别 vendor === "user" 为自定义模型。
    // 历史写入的供应商名会归到「第三方模型」并可能覆盖官方同名模型。
    entry.vendor = 'user';
    // Buddy UI 并排 name + id；name 缺失或仍是旧 vendor 时回退到 id（不强制覆盖用户自定义展示名）。
    if (!entry.name || entry.name === model?.vendor) {
      entry.name = entry.id || entry.name || 'model';
    }
    if (platform === WB_PLATFORM) {
      // WorkBuddy 在 useCustomProtocol=true 时不再拼接路径，双端同步/保存时必须写回。
      entry.useCustomProtocol = true;
    } else if (platform === CB_PLATFORM && Object.prototype.hasOwnProperty.call(entry, 'useCustomProtocol')) {
      delete entry.useCustomProtocol;
    }
    return entry;
  });
}

async function persistTencentBuddyModels(platform, models, availableModels, scope) {
  if (!invoke) throw new Error('Tauri invoke 未初始化，无法保存 CodeBuddy / WorkBuddy 配置');
  return invoke('save_codebuddy_models', {
    platform,
    models: normalizeBuddyModelsForPlatform(models, platform),
    availableModels,
    scope,
  });
}

function applyTencentBuddySyncedState(models, availableModels, codebuddyMeta, workbuddyMeta) {
  cbModels = cbNormalizeModelsContext(normalizeBuddyModelsForPlatform(models, CB_PLATFORM));
  wbModels = cbNormalizeModelsContext(normalizeBuddyModelsForPlatform(models, WB_PLATFORM));
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
  syncTencentBuddySyncButtons();
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

/** 按模型 ID 推断推荐上下文窗口（token）。优先读 model-context-presets.json。 */
function cbRecommendContextWindow(modelId) {
  if (typeof globalThis.recommendContextWindow === 'function') {
    return globalThis.recommendContextWindow(modelId);
  }
  return 128000;
}

/** 按模型 ID 推断推荐最大输出 token。优先读 model-context-presets.json。 */
function cbRecommendMaxOutputTokens(modelId) {
  if (typeof globalThis.recommendMaxOutputTokens === 'function') {
    return globalThis.recommendMaxOutputTokens(modelId);
  }
  return 8192;
}

/** 是否为历史遗留的默认 128K（可被推荐值覆盖） */
function cbIsLegacyDefaultContext(value) {
  const n = Number(value);
  return Number.isFinite(n) && n === 128000;
}

/**
 * 规范化模型上下文：缺失时填推荐值；
 * 若仍是历史默认 128K 且推荐值更大，则升级到推荐值。
 * 用户手动改成非 128K 的值会保留。
 */
function cbNormalizeModelContext(model) {
  if (!model || typeof model !== 'object') return model;
  const id = model.id || '';
  const recommended = cbRecommendContextWindow(id);
  const recommendedOut = cbRecommendMaxOutputTokens(id);
  const current = model.maxInputTokens;
  if (current == null || current === '' || !Number.isFinite(Number(current)) || Number(current) <= 0) {
    model.maxInputTokens = recommended;
    if (model.maxOutputTokens == null) model.maxOutputTokens = recommendedOut;
    return model;
  }
  if (cbIsLegacyDefaultContext(current) && recommended > 128000) {
    model.maxInputTokens = recommended;
    if (model.maxOutputTokens == null || Number(model.maxOutputTokens) === 8192) {
      model.maxOutputTokens = recommendedOut;
    }
  }
  return model;
}

function cbNormalizeModelsContext(models) {
  if (!Array.isArray(models)) return [];
  return models.map((m) => cbNormalizeModelContext({ ...m }));
}

/** 格式化上下文 token 显示：128000 → 128K，1000000 → 1M */
function cbFormatContextTokens(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000000) {
    const m = n / 1000000;
    const text = Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/\.?0+$/, '');
    return `${text}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    const text = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
    return `${text}K`;
  }
  return String(Math.round(n));
}

function cbBuildModelEntry(provider, modelId, displayName, capabilities, platformId) {
  const isBuddy = platformId === CB_PLATFORM || platformId === WB_PLATFORM;
  const entry = {
    id: modelId,
    // Buddy UI 并排 name + id，name 只写供应商展示名（如 CPA）；ZCode 同样用供应商名。
    name: displayName || provider.providerName || (isBuddy ? (modelId || 'model') : 'Custom'),
    // 新版 Buddy 要求 vendor === "user" 才算自定义模型；ZCode 仍写供应商名用于分组。
    vendor: isBuddy ? 'user' : (provider.providerName || 'Custom'),
    url: platformId === ZC_PLATFORM ? zcProviderBaseUrl(provider) : cbProviderChatUrl(provider),
    apiKey: cbProviderApiKey(provider),
    maxInputTokens: cbRecommendContextWindow(modelId),
    maxOutputTokens: cbRecommendMaxOutputTokens(modelId),
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
  const fn = typeof syncFn === 'function' ? syncFn : (typeof syncFn === 'string' ? window[syncFn] : null);
  if (typeof fn === 'function') fn();
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
  const existingById = new Map(
    currentModels
      .filter(isCurrentProviderModel)
      .map(model => [String(model?.id || ''), model])
  );
  const selectedModels = providerModels
    .filter(model => selectedIds.has(String(model?.id || '')))
    .map(model => {
      const modelId = String(model.id || '');
      const built = cbBuildModelEntry(provider, modelId, provider.providerName, capabilities, platformId);
      const existing = existingById.get(modelId);
      // 已存在的模型：保留用户自定义值；若仍是历史默认 128K，则升级到推荐值
      if (existing) {
        if (existing.maxInputTokens != null) {
          const rec = cbRecommendContextWindow(modelId);
          if (cbIsLegacyDefaultContext(existing.maxInputTokens) && rec > 128000) {
            built.maxInputTokens = rec;
          } else {
            built.maxInputTokens = existing.maxInputTokens;
          }
        }
        if (existing.maxOutputTokens != null) {
          if (Number(existing.maxOutputTokens) === 8192 && built.maxOutputTokens > 8192) {
            // 保留推荐输出上限
          } else {
            built.maxOutputTokens = existing.maxOutputTokens;
          }
        }
        if (existing.temperature != null) built.temperature = existing.temperature;
        if (existing.enabled === false) built.enabled = false;
      }
      return built;
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

globalThis.cbEditCurrent = { prefix: null, index: -1 };

function openCbEditModal(prefix, index) {
  const ref = cbEditModelsRef(prefix);
  const model = ref.models[index];
  if (!model) return;
  cbEditCurrent = { prefix, index };

  const modal = document.getElementById('cb-edit-modal');
  if (!modal) return;

  // Buddy 平台：编辑框展示 name（展示名），vendor 固定为 user 写入时再处理。
  // ZCode：保留 vendor/name 合并编辑。
  const isBuddyEdit = prefix === 'Cb' || prefix === 'Wb';
  const vendorOrName = isBuddyEdit
    ? (model.name || model.id || '')
    : (model.vendor || model.name || '');
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

  const recInput = cbRecommendContextWindow(model.id || '');
  const recOutput = cbRecommendMaxOutputTokens(model.id || '');
  const inputEl = document.getElementById('cb-edit-max-input');
  if (inputEl) inputEl.placeholder = `推荐值: ${recInput}（${cbFormatContextTokens(recInput)}）`;
  const outputEl = document.getElementById('cb-edit-max-output');
  if (outputEl) outputEl.placeholder = `推荐值: ${recOutput}`;

  // 标题展示平台名
  const titleEl = document.getElementById('cb-edit-modal-title');
  if (titleEl) {
    const platformLabel = prefix === 'Cb' ? 'CodeBuddy'      : prefix === 'Zc' ? 'ZCode'
      : 'WorkBuddy';
    titleEl.textContent = `编辑模型 · ${platformLabel}`;
  }
  const vendorLabel = document.querySelector('label[for="cb-edit-vendor"]');
  const vendorInput = document.getElementById('cb-edit-vendor');
  if (vendorLabel) {
    vendorLabel.innerHTML = isBuddyEdit
      ? '展示名 <span style="color:var(--danger);">*</span>'
      : '供应商 <span style="color:var(--danger);">*</span>';
  }
  if (vendorInput) {
    vendorInput.placeholder = isBuddyEdit
      ? '供应商展示名，如 CPA / OpenAI'
      : '模型供应商，如 OpenAI / Google / 黑与白';
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

function cbFillRecommendedContext() {
  const modelId = (document.getElementById('cb-edit-id')?.value || '').trim();
  if (!modelId) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('请先输入模型 ID，再填入推荐值', '提示', 'info');
    }
    return;
  }
  const inputTokens = cbRecommendContextWindow(modelId);
  const outputTokens = cbRecommendMaxOutputTokens(modelId);
  platformSetValue('cb-edit-max-input', inputTokens);
  platformSetValue('cb-edit-max-output', outputTokens);
  const inputEl = document.getElementById('cb-edit-max-input');
  if (inputEl) inputEl.placeholder = `推荐值: ${inputTokens}（${cbFormatContextTokens(inputTokens)}）`;
  const outputEl = document.getElementById('cb-edit-max-output');
  if (outputEl) outputEl.placeholder = `推荐值: ${outputTokens}`;
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已填入推荐设置：上下文 ${cbFormatContextTokens(inputTokens)} / 输出 ${outputTokens}`, 'success');
  }
}

async function saveCbEditFromModal() {
  const { prefix, index } = cbEditCurrent;
  if (!prefix || index < 0) return;
  const ref = cbEditModelsRef(prefix);
  const listRef = cbModelListRef(prefix);
  const model = ref.models[index];
  if (!model) return;

  // 必填字段（4 个）：id / 展示名 / url / apiKey
  const id = (document.getElementById('cb-edit-id')?.value || '').trim();
  const displayName = (document.getElementById('cb-edit-vendor')?.value || '').trim();
  const rawUrl = (document.getElementById('cb-edit-url')?.value || '').trim();
  const url = prefix === 'Zc' ? zcNormalizeBaseUrl(rawUrl) : rawUrl;
  const apiKey = (document.getElementById('cb-edit-key')?.value || '').trim();
  const isBuddyEdit = prefix === 'Cb' || prefix === 'Wb';

  // 必填校验
  const missing = [];
  if (!id) missing.push('模型 ID');
  if (!displayName) missing.push(isBuddyEdit ? '展示名' : '供应商');
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

  // Buddy：vendor 固定 "user"，name 用展示名；ZCode：name/vendor 同值保留旧语义。
  const oldId = model.id || '';
  const entry = {
    id,
    name: displayName,
    vendor: isBuddyEdit ? 'user' : displayName,
    url,
    apiKey,
  };
  if (maxInput != null) entry.maxInputTokens = maxInput;
  if (maxOutput != null) entry.maxOutputTokens = maxOutput;
  if (temperature != null) entry.temperature = temperature;
  if (supportsToolCall) entry.supportsToolCall = true;
  if (supportsImages) entry.supportsImages = true;
  if (supportsReasoning) entry.supportsReasoning = true;

  // WorkBuddy 必须保持 useCustomProtocol；从 CodeBuddy 同步过来的模型也要补写
  if (prefix === 'Wb' || ref.platform === WB_PLATFORM) entry.useCustomProtocol = true;
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
      <td colspan="7">
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
  // Buddy 固定 vendor=user，按 url/name 统计，避免供应商数恒为 1。
  const providerCount = new Set(list.map((m) => {
    if (String(m?.vendor || '') === 'user') return String(m?.url || m?.name || m?.id || 'Custom');
    return String(m?.vendor || m?.url || 'Custom');
  }).filter(Boolean)).size;
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
    const rawModels = Array.isArray(data.models) ? data.models : [];
    cbModels = cbNormalizeModelsContext(normalizeBuddyModelsForPlatform(rawModels, CB_PLATFORM));
    cbAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('cb', data, '~/.codebuddy/models.json');
    cbConfigScope = meta.scope;
    cbConfigPath = meta.path;
    renderCodeBuddyModels();
    // 历史默认 128K 升级，或 vendor 需迁移为 user 时，静默写回配置
    const upgraded = rawModels.some((m, i) => {
      const before = m?.maxInputTokens;
      const after = cbModels[i]?.maxInputTokens;
      return before !== after || String(m?.vendor || '') !== 'user';
    });
    if (upgraded) {
      await saveCodeBuddyModels({ silent: true });
    }
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
      models: normalizeBuddyModelsForPlatform(cbModels, CB_PLATFORM),
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
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="cb-add-prov-icon cb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="cb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="cb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectCbAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="cb-add-prov-name">${platformEsc(p.providerName)}</span>
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

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models);

  body.innerHTML = sortedModels.map((m) => {
    const exists = cbModels.some(model => model.id === m.id);
    return `
      <label class="cb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="cb-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateCbAddConfirmButton">
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
    // Buddy 固定 vendor=user，列表展示优先 name/id，避免全部显示成 "user"。
    const displayName = (model.vendor === 'user'
      ? (model.name || model.id)
      : (model.vendor || model.name || model.id)) || '未命名';
    const selected = cbSelectionSet(prefix).has(cbModelSelectionKey(prefix, model));
    const caps = [];
    if (model.supportsToolCall) caps.push(cbCapabilityPill(cls, 'tool', '工具'));
    if (model.supportsImages) caps.push(cbCapabilityPill(cls, 'image', '图片'));
    if (model.supportsReasoning) caps.push(cbCapabilityPill(cls, 'reason', '推理'));

    const enabled = model.enabled !== false;
    const toggleFn = prefix === 'Cb' ? 'toggleCbModelEnabled'      : prefix === 'Zc' ? 'toggleZcModelEnabled'
      : 'toggleWbModelEnabled';
    const contextTokens = model.maxInputTokens != null ? model.maxInputTokens : null;
    const contextLabel = cbFormatContextTokens(contextTokens);
    const contextTitle = contextTokens != null && Number.isFinite(Number(contextTokens))
      ? `上下文窗口：${Number(contextTokens).toLocaleString()} tokens`
      : '未设置上下文窗口';

    const modelId = String(model.id || '');
    const iconHtml = (typeof renderModelIcon === 'function')
      ? renderModelIcon(modelId)
      : `<div class="model-item-icon fallback">${esc((modelId.charAt(0) || '?').toUpperCase())}</div>`;

    return `
    <tr ${dataAttr}="${index}" class="${selected ? 'cb-model-row-selected' : ''}">
      <td class="cb-select-cell">
        <input type="checkbox" class="cb-model-row-check" aria-label="选择 ${esc(model.id || '模型')}" ${selected ? 'checked' : ''} data-action="toggleCbModelSelection" data-events="change" data-args="[&quot;${prefix}&quot;,${index}]" data-pass-checked>
      </td>
      <td>
        <div class="model-id-copy-wrap">
          ${iconHtml}
          <span class="display-name-cell" title="${esc(model.id || '')}">${esc(model.id || '-')}</span>
          <button class="btn-icon model-id-copy-btn" data-action="copyTextToClipboard" data-args="[&quot;${esc(model.id || '')}&quot;,&quot;模型 ID&quot;]" title="复制模型 ID">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </td>
      <td><span title="${esc(displayName)}">${esc(displayName)}</span></td>
      <td class="${cls}-context-cell">
        <span class="${cls}-context-pill" title="${esc(contextTitle)}">${esc(contextLabel)}</span>
      </td>
      <td><div style="display:flex; gap:6px; flex-wrap:wrap;">${caps.join('') || '<span style="color:var(--text-muted);font-size:12px;">—</span>'}</div></td>
      <td>
        <div class="model-map-actions">
          <button class="btn-icon model-map-action-btn" data-action="openCbEditModal" data-args="[&quot;${prefix}&quot;,${index}]" title="编辑模型" aria-label="编辑模型">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon model-map-action-btn danger" data-action="${deleteFn}" data-args="[${index}]" title="删除模型" aria-label="删除模型">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
      <td class="model-map-toggle-cell">
        <label class="toggle-switch" title="${enabled ? '已启用' : '已停用'}">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-action="${toggleFn}" data-events="change" data-args="[${index}]" data-pass-checked>
          <span class="toggle-slider"></span>
        </label>
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
    else if (platformId === 'antigravity') {
      antigravityRefreshConsole({ silent: true });
      antigravityRenderTableRows();
    }
  };
})();

// Antigravity 拖拽导入处理
window.antigravityDragOver = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('antigravity-drop-zone');
  if (zone) zone.classList.add('drag-over');
};
window.antigravityDragLeave = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('antigravity-drop-zone');
  if (zone) zone.classList.remove('drag-over');
};
window.antigravityDrop = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById('antigravity-drop-zone');
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
      const incoming = Array.isArray(data.models) ? data.models : (Array.isArray(data) ? data : []);
      if (!incoming.length) {
        showCustomAlert('JSON 中未包含模型数组', '导入失败', 'warn');
        return;
      }
      let current = Array.isArray(providerStore?.antigravityConfigs) ? [...providerStore.antigravityConfigs] : [];
      let added = 0;
      incoming.forEach(m => {
        if (!m || !m.id) return;
        if (current.some(c => c.id === m.id)) return;
        current.push({
          id: m.id,
          name: m.name || m.id,
          defaultModel: m.defaultModel || m.model || m.id,
          sourceProviderId: m.sourceProviderId || '',
          sourceProviderName: m.sourceProviderName || '自定义导入',
          apiFormat: m.apiFormat || 'openai',
          enabled: m.enabled !== false,
        });
        added++;
      });
      if (added > 0) {
        providerStore.antigravityConfigs = current;
        if (invoke) {
          invoke('write_provider_store', { store: providerStore }).catch(() => {});
        }
        antigravityRenderTableRows();
        showCustomAlert(`成功导入 ${added} 个模型配置`, '导入成功', 'ok');
      } else {
        showCustomAlert('没有新模型需要导入', '提示', 'info');
      }
    } catch (err) {
      showCustomAlert('解析 JSON 失败: ' + err.message, '解析错误', 'error');
    }
  };
  reader.readAsText(file);
};

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

globalThis.wbModels = [];
globalThis.wbAvailableModels = [];
globalThis.wbConfigScope = 'user';
globalThis.wbConfigPath = '~/.workbuddy/models.json';
globalThis.wbProviderModels = [];
globalThis.wbEditingIndex = -1;
globalThis.wbAddSelectedProvider = null;
globalThis.wbAddSearchKw = '';

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
    const rawModels = Array.isArray(data.models) ? data.models : [];
    wbModels = cbNormalizeModelsContext(normalizeBuddyModelsForPlatform(rawModels, WB_PLATFORM));
    wbAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('wb', data, '~/.workbuddy/models.json');
    wbConfigScope = meta.scope;
    wbConfigPath = meta.path;
    renderWbModels();
    // 历史默认 128K 升级，或 vendor 需迁移为 user 时，静默写回配置
    const upgraded = rawModels.some((m, i) => {
      const before = m?.maxInputTokens;
      const after = wbModels[i]?.maxInputTokens;
      return before !== after || String(m?.vendor || '') !== 'user';
    });
    if (upgraded) {
      await saveWbModels({ silent: true });
    }
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
    wbModels = normalizeBuddyModelsForPlatform(wbModels, WB_PLATFORM);
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
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="wb-add-prov-icon wb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="wb-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="wb-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectWbAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="wb-add-prov-name">${platformEsc(p.providerName)}</span>
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

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models);

  body.innerHTML = sortedModels.map((m) => {
    const exists = wbModels.some(model => model.id === m.id);
    return `
      <label class="wb-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="wb-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateWbAddConfirmButton">
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

globalThis.zcModels = [];
globalThis.zcAvailableModels = [];
globalThis.zcConfigScope = 'user';
globalThis.zcConfigPath = '~/.zcode/v2/config.json';
globalThis.zcProviderModels = [];
globalThis.zcEditingIndex = -1;
globalThis.zcAddSelectedProvider = null;
globalThis.zcAddSearchKw = '';

globalThis.ZC_PLATFORM = 'zcode';

function zcModelRow(model, index) {
  return zcRowFactory(model, index);
}

async function loadZcModels() {
  if (!invoke) return;
  try {
    const data = await invoke('load_codebuddy_models', { platform: ZC_PLATFORM });
    const rawModels = Array.isArray(data.models) ? data.models : [];
    zcModels = cbNormalizeModelsContext(rawModels);
    zcAvailableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
    const meta = cbApplyConfigMeta('zc', data, '~/.zcode/v2/config.json');
    zcConfigScope = meta.scope;
    zcConfigPath = meta.path;
    renderZcModels();
    const upgraded = rawModels.some((m, i) => {
      const before = m?.maxInputTokens;
      const after = zcModels[i]?.maxInputTokens;
      return before !== after;
    });
    if (upgraded) {
      await saveZcModels({ silent: true });
    }
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
    const isBuiltin = isBuiltinProxyEntry(p);
    const iconHtml = isBuiltin
      ? `<span class="wb-add-prov-icon zc-add-prov-icon wb-add-prov-icon-builtin" title="内置本地代理"><span>本地</span><span>代理</span></span>`
      : `<span class="wb-add-prov-icon zc-add-prov-icon">${platformEsc(initial)}</span>`;
    return `
      <div class="wb-add-prov-item zc-add-prov-item ${isActive ? 'active' : ''} ${enabled ? '' : 'disabled'} ${isBuiltin ? 'is-local-proxy' : ''}" data-action="selectZcAddProvider" data-arg="${platformEsc(p.providerId)}">
        ${iconHtml}
        <span class="wb-add-prov-name zc-add-prov-name">${platformEsc(p.providerName)}</span>
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

  const sortFn = typeof sortRoleSelectItems === 'function' ? sortRoleSelectItems : (list) => list;
  const sortedModels = sortFn(provider.models);

  body.innerHTML = sortedModels.map((m) => {
    const exists = zcModels.some(model => zcProviderModelKey(model) === zcProviderModelKeyParts(zcodeProviderId, m.id));
    return `
      <label class="wb-add-model-row zc-add-model-row ${exists ? 'already-added' : ''}" data-existing="${exists ? 'true' : 'false'}">
        <input type="checkbox" class="zc-add-model-check" data-model-id="${platformEsc(m.id)}" data-model-name="${platformEsc(m.name || m.id)}" ${exists ? 'checked' : ''} data-action="cbOnAddModelCheckChanged" data-events="change" data-pass-this data-arg="updateZcAddConfirmButton">
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
    const limit = { context: model.maxInputTokens || cbRecommendContextWindow(model.id) };
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
        maxInputTokens: limit.context || cbRecommendContextWindow(mid),
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

// ---- P3 globalThis mirror (functions/classes) ----
(function mirrorFns(g) {
  g.platformEsc = platformEsc;
  g.platformInfoOf = platformInfoOf;
  g.platformDef = platformDef;
  g.isRevealablePath = isRevealablePath;
  g.revealConfigPath = revealConfigPath;
  g.bindRevealPathLabel = bindRevealPathLabel;
  g.codexDesktopAutomationSupported = codexDesktopAutomationSupported;
  g.codexDesktopUnsupportedMessage = codexDesktopUnsupportedMessage;
  g.platformFormatLabel = platformFormatLabel;
  g.platformLocalProxyConfigId = platformLocalProxyConfigId;
  g.platformIsLocalProxyConfig = platformIsLocalProxyConfig;
  g.platformLocalProxyRuntime = platformLocalProxyRuntime;
  g.openProxyRoutesFromPlatform = openProxyRoutesFromPlatform;
  g.platformLocalProxyCard = platformLocalProxyCard;
  g.upsertById = upsertById;
  g.ensureLocalProxyPlatformConfig = ensureLocalProxyPlatformConfig;
  g.applyLocalProxyPlatformConfig = applyLocalProxyPlatformConfig;
  g.platformProviderList = platformProviderList;
  g.formatPlatformTime = formatPlatformTime;
  g.platformSetText = platformSetText;
  g.platformSetValue = platformSetValue;
  g.platformStatusTag = platformStatusTag;
  g.platformShort = platformShort;
  g.platformJoinUrl = platformJoinUrl;
  g.platformStripSuffix = platformStripSuffix;
  g.codexTargetBaseUrl = codexTargetBaseUrl;
  g.refreshPlatforms = refreshPlatforms;
  g.renderPlatformCards = renderPlatformCards;
  g.renderPlatformCard = renderPlatformCard;
  g.renderPlatformDetailStatuses = renderPlatformDetailStatuses;
  g.renderCodexConfigRows = renderCodexConfigRows;
  g.codexStatusMeta = codexStatusMeta;
  g.claudeCodeStatusMeta = claudeCodeStatusMeta;
  g.openCodeStatusMeta = openCodeStatusMeta;
  g.codexField = codexField;
  g.renderCodexPageStatus = renderCodexPageStatus;
  g.renderClaudeCodePageStatus = renderClaudeCodePageStatus;
  g.renderOpenCodePageStatus = renderOpenCodePageStatus;
  g.toggleCodexToken = toggleCodexToken;
  g.renderCodexTargetSummary = renderCodexTargetSummary;
  g.codexProviderIsCurrent = codexProviderIsCurrent;
  g.codexProviderPreservesOfficialAuth = codexProviderPreservesOfficialAuth;
  g.codexProviderNeedsInject = codexProviderNeedsInject;
  g.syncCodexConfigAuthInjectMutualExclusion = syncCodexConfigAuthInjectMutualExclusion;
  g.onCodexConfigInjectModelsChange = onCodexConfigInjectModelsChange;
  g.onCodexConfigPreserveOfficialAuthChange = onCodexConfigPreserveOfficialAuthChange;
  g.codexConfigMetaLine = codexConfigMetaLine;
  g.platformJsArg = platformJsArg;
  g.codexConfigBadge = codexConfigBadge;
  g.codexConfigProviderById = codexConfigProviderById;
  g.codexConfigSourceProviders = codexConfigSourceProviders;
  g.renderCodexConfigSourceList = renderCodexConfigSourceList;
  g.applyCodexConfigSource = applyCodexConfigSource;
  g.selectCodexConfigSource = selectCodexConfigSource;
  g.onCodexConfigSourceChange = onCodexConfigSourceChange;
  g.codexConfigModelList = codexConfigModelList;
  g.codexConfigParseModels = codexConfigParseModels;
  g.codexConfigNormalizeModels = codexConfigNormalizeModels;
  g.mergeCatalogAndModels = mergeCatalogAndModels;
  g.codexConfigSetModelStatus = codexConfigSetModelStatus;
  g.codexConfigSetFetchLoading = codexConfigSetFetchLoading;
  g.renderCodexModelManager = renderCodexModelManager;
  g.getCodexModelEntries = getCodexModelEntries;
  g.setCodexModelEntriesState = setCodexModelEntriesState;
  g.toggleCodexModelCatalog = toggleCodexModelCatalog;
  g.cancelCodexModelEdit = cancelCodexModelEdit;
  g.selectCodexDefaultModel = selectCodexDefaultModel;
  g.addCodexModelEntry = addCodexModelEntry;
  g.editCodexModelEntry = editCodexModelEntry;
  g.saveCodexModelEdit = saveCodexModelEdit;
  g.removeCodexModelEntry = removeCodexModelEntry;
  g.batchSetCodexModelCatalog = batchSetCodexModelCatalog;
  g.batchSetCodexDefaultModel = batchSetCodexDefaultModel;
  g.codexConfigGetDefaultModel = codexConfigGetDefaultModel;
  g.codexConfigEndpointParts = codexConfigEndpointParts;
  g.fetchCodexConfigModels = fetchCodexConfigModels;
  g.codexConfigDisplayBaseUrl = codexConfigDisplayBaseUrl;
  g.codexConfigSetInputValue = codexConfigSetInputValue;
  g.renderReasoningConfig = renderReasoningConfig;
  g.getReasoningConfig = getReasoningConfig;
  g.codexAgentModelOptions = codexAgentModelOptions;
  g.normalizeCodexAgent = normalizeCodexAgent;
  g.renderCodexAgentsPanel = renderCodexAgentsPanel;
  g.addCodexAgent = addCodexAgent;
  g.removeCodexAgent = removeCodexAgent;
  g.updateCodexAgentField = updateCodexAgentField;
  g.getCodexAgentsConfig = getCodexAgentsConfig;
  g.getCodexAgents = getCodexAgents;
  g.validateCodexAgents = validateCodexAgents;
  g.openCodexConfigEditor = openCodexConfigEditor;
  g.closeCodexConfigEditor = closeCodexConfigEditor;
  g.toggleCodexKeyVisibility = toggleCodexKeyVisibility;
  g.toggleClaudeDesktopKeyVisibility = toggleClaudeDesktopKeyVisibility;
  g.toggleClaudeCodeKeyVisibility = toggleClaudeCodeKeyVisibility;
  g.toggleOpenCodeKeyVisibility = toggleOpenCodeKeyVisibility;
  g.toggleGrokKeyVisibility = toggleGrokKeyVisibility;
  g.togglePasswordVisibility = togglePasswordVisibility;
  g.togglePasswordInputVisibility = togglePasswordInputVisibility;
  g.resetPasswordInputVisibility = resetPasswordInputVisibility;
  g.syncCodexConfigTokenFromSource = syncCodexConfigTokenFromSource;
  g.syncClaudeCodeConfigTokenFromSource = syncClaudeCodeConfigTokenFromSource;
  g.syncOpenCodeConfigTokenFromSource = syncOpenCodeConfigTokenFromSource;
  g.syncCodexConfigUiAfterStoreChange = syncCodexConfigUiAfterStoreChange;
  g.saveCodexConfigEditor = saveCodexConfigEditor;
  g.codexActionIcon = codexActionIcon;
  g.codexReconfigureAction = codexReconfigureAction;
  g.renderCodexConfigCard = renderCodexConfigCard;
  g.deleteCodexProviderConfig = deleteCodexProviderConfig;
  g.editCodexProviderConfig = editCodexProviderConfig;
  g.codexConfigMatchesSearch = codexConfigMatchesSearch;
  g.renderCodexConfigList = renderCodexConfigList;
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
  g.claudeCodeSettingsFromFields = claudeCodeSettingsFromFields;
  g.claudeCodeSettingsTextFromFields = claudeCodeSettingsTextFromFields;
  g.claudeCodeSetRawSettings = claudeCodeSetRawSettings;
  g.claudeCodeBuildSettingsForProvider = claudeCodeBuildSettingsForProvider;
  g.claudeCodeCreateSettingsFromCurrentFields = claudeCodeCreateSettingsFromCurrentFields;
  g.claudeCodeConfigObjectFromRawOrFields = claudeCodeConfigObjectFromRawOrFields;
  g.claudeCodeRawConfigTextFromFields = claudeCodeRawConfigTextFromFields;
  g.syncClaudeCodeRawConfigFromFields = syncClaudeCodeRawConfigFromFields;
  g.claudeCodeApplyRawConfigToFields = claudeCodeApplyRawConfigToFields;
  g.onClaudeCodeRawConfigInput = onClaudeCodeRawConfigInput;
  g.onClaudeCodeDefaultModelInput = onClaudeCodeDefaultModelInput;
  g.renderClaudeCodeConfigSourceList = renderClaudeCodeConfigSourceList;
  g.applyClaudeCodeConfigSource = applyClaudeCodeConfigSource;
  g.selectClaudeCodeConfigSource = selectClaudeCodeConfigSource;
  g.claudeCodeConfigSetModelStatus = claudeCodeConfigSetModelStatus;
  g.claudeCodeConfigSetFetchLoading = claudeCodeConfigSetFetchLoading;
  g.claudeCodeQuickSetAllModels = claudeCodeQuickSetAllModels;
  g.onClaude1mCheckboxChanged = onClaude1mCheckboxChanged;
  g.setClaude1mCheckbox = setClaude1mCheckbox;
  g.getClaude1mCheckbox = getClaude1mCheckbox;
  g.onClaudeRoleFieldInput = onClaudeRoleFieldInput;
  g.onClaudeRoleSelectChange = onClaudeRoleSelectChange;
  g.onClaudeFallbackSelectChange = onClaudeFallbackSelectChange;
  g.refreshAllClaudeRoleSelects = refreshAllClaudeRoleSelects;
  g.setClaudeRoleSelectValue = setClaudeRoleSelectValue;
  g.claudeCodeApplySettingsToRoleForm = claudeCodeApplySettingsToRoleForm;
  g.claudeCodeExtractModelsFromRoleForm = claudeCodeExtractModelsFromRoleForm;
  g.claudeCodeConfigEndpointParts = claudeCodeConfigEndpointParts;
  g.claudeCodeConfigModelEndpointParts = claudeCodeConfigModelEndpointParts;
  g.fetchClaudeCodeConfigModelsWithFormat = fetchClaudeCodeConfigModelsWithFormat;
  g.fetchClaudeCodeConfigModels = fetchClaudeCodeConfigModels;
  g.claudeCodeProviderIsCurrent = claudeCodeProviderIsCurrent;
  g.claudeCodeConfigMatchesSearch = claudeCodeConfigMatchesSearch;
  g.openClaudeCodeProviderAdd = openClaudeCodeProviderAdd;
  g.openClaudeCodeConfigEditor = openClaudeCodeConfigEditor;
  g.closeClaudeCodeConfigEditor = closeClaudeCodeConfigEditor;
  g.syncClaudeCodeConfigUiAfterStoreChange = syncClaudeCodeConfigUiAfterStoreChange;
  g.saveClaudeCodeConfigEditor = saveClaudeCodeConfigEditor;
  g.editClaudeCodeProviderConfig = editClaudeCodeProviderConfig;
  g.deleteClaudeCodeProviderConfig = deleteClaudeCodeProviderConfig;
  g.renderClaudeCodeConfigList = renderClaudeCodeConfigList;
  g.onClaudeCodeConfigSearch = onClaudeCodeConfigSearch;
  g.opencodeConfigProviderById = opencodeConfigProviderById;
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
  g.renderOpenCodeConfigSourceList = renderOpenCodeConfigSourceList;
  g.applyOpenCodeConfigSource = applyOpenCodeConfigSource;
  g.selectOpenCodeConfigSource = selectOpenCodeConfigSource;
  g.opencodeConfigSetModelStatus = opencodeConfigSetModelStatus;
  g.opencodeConfigSetFetchLoading = opencodeConfigSetFetchLoading;
  g.opencodeConfigSetModels = opencodeConfigSetModels;
  g.onOpenCodeSourceSearch = onOpenCodeSourceSearch;
  g.renderOpenCodeConfigModelList = renderOpenCodeConfigModelList;
  g.selectOpenCodeConfigModel = selectOpenCodeConfigModel;
  g.opencodeConfigEndpointParts = opencodeConfigEndpointParts;
  g.fetchOpenCodeConfigModels = fetchOpenCodeConfigModels;
  g.openCodeProviderIsLive = openCodeProviderIsLive;
  g.opencodeConfigMatchesSearch = opencodeConfigMatchesSearch;
  g.openOpenCodeAddModal = openOpenCodeAddModal;
  g.initOpenCodeAddPage = initOpenCodeAddPage;
  g.initOpenCodeConfigEditorPage = initOpenCodeConfigEditorPage;
  g.onOpenCodeAddSearch = onOpenCodeAddSearch;
  g.renderOpenCodeAddProviderList = renderOpenCodeAddProviderList;
  g.selectOpenCodeAddProvider = selectOpenCodeAddProvider;
  g.renderOpenCodeAddModels = renderOpenCodeAddModels;
  g.updateOpenCodeAddConfirmButton = updateOpenCodeAddConfirmButton;
  g.opencodeAddSelectAll = opencodeAddSelectAll;
  g.opencodeAddSelectNone = opencodeAddSelectNone;
  g.confirmAddOpenCodeModelsPage = confirmAddOpenCodeModelsPage;
  g.toggleOpenCodeAddSort = toggleOpenCodeAddSort;
  g.chooseOpenCodeAddSortMode = chooseOpenCodeAddSortMode;
  g.openOpenCodeProviderAdd = openOpenCodeProviderAdd;
  g.openOpenCodeConfigEditor = openOpenCodeConfigEditor;
  g.closeOpenCodeConfigEditor = closeOpenCodeConfigEditor;
  g.syncOpenCodeConfigUiAfterStoreChange = syncOpenCodeConfigUiAfterStoreChange;
  g.saveOpenCodeConfigEditor = saveOpenCodeConfigEditor;
  g.editOpenCodeProviderConfig = editOpenCodeProviderConfig;
  g.deleteOpenCodeProviderConfig = deleteOpenCodeProviderConfig;
  g.renderOpenCodeConfigList = renderOpenCodeConfigList;
  g.onOpenCodeConfigSearch = onOpenCodeConfigSearch;
  g.applyOpenCodeProviderConfig = applyOpenCodeProviderConfig;
  g.removeOpenCodeProviderConfig = removeOpenCodeProviderConfig;
  g.restoreOpenCodeOfficialConfig = restoreOpenCodeOfficialConfig;
  g.renderGrokPageStatus = renderGrokPageStatus;
  g.renderGrokConfigSourceList = renderGrokConfigSourceList;
  g.applyGrokConfigSource = applyGrokConfigSource;
  g.selectGrokConfigSource = selectGrokConfigSource;
  g.openGrokAddModal = openGrokAddModal;
  g.initGrokAddPage = initGrokAddPage;
  g.initGrokConfigEditorPage = initGrokConfigEditorPage;
  g.setGrokConfigBackendRadio = setGrokConfigBackendRadio;
  g.copyRawConfigText = copyRawConfigText;
  g.loadPlatformRealConfigFile = loadPlatformRealConfigFile;
  g.openPlatformRealConfigModal = openPlatformRealConfigModal;
  g.closePlatformRealConfigModal = closePlatformRealConfigModal;
  g.reloadPlatformRealConfigModal = reloadPlatformRealConfigModal;
  g.copyPlatformRealConfigModal = copyPlatformRealConfigModal;
  g.savePlatformRealConfigModal = savePlatformRealConfigModal;
  g.syncCodexRawConfigFromFields = syncCodexRawConfigFromFields;
  g.syncGrokRawConfigFromFields = syncGrokRawConfigFromFields;
  g.onGrokAddSearch = onGrokAddSearch;
  g.renderGrokAddProviderList = renderGrokAddProviderList;
  g.selectGrokAddProvider = selectGrokAddProvider;
  g.renderGrokAddModels = renderGrokAddModels;
  g.updateGrokAddConfirmButton = updateGrokAddConfirmButton;
  g.grokAddSelectAll = grokAddSelectAll;
  g.grokAddSelectNone = grokAddSelectNone;
  g.setGrokAddBackend = setGrokAddBackend;
  g.confirmAddGrokModelsPage = confirmAddGrokModelsPage;
  g.toggleGrokAddSort = toggleGrokAddSort;
  g.chooseGrokAddSortMode = chooseGrokAddSortMode;
  g.openGrokConfigAdd = openGrokConfigAdd;
  g.openGrokConfigEditor = openGrokConfigEditor;
  g.closeGrokConfigEditor = closeGrokConfigEditor;
  g.syncGrokConfigTokenFromSource = syncGrokConfigTokenFromSource;
  g.syncGrokConfigUiAfterStoreChange = syncGrokConfigUiAfterStoreChange;
  g.saveGrokConfigEditor = saveGrokConfigEditor;
  g.editGrokProviderConfig = editGrokProviderConfig;
  g.deleteGrokProviderConfig = deleteGrokProviderConfig;
  g.applyGrokProviderConfig = applyGrokProviderConfig;
  g.onGrokConfigSearch = onGrokConfigSearch;
  g.renderGrokConfigList = renderGrokConfigList;
  g.restoreGrokOfficialConfig = restoreGrokOfficialConfig;
  g.restoreClaudeCodeOfficialConfig = restoreClaudeCodeOfficialConfig;
  g.applyClaudeCodeProviderConfig = applyClaudeCodeProviderConfig;
  g.onCodexConfigSearch = onCodexConfigSearch;
  g.applyCodexProviderConfig = applyCodexProviderConfig;
  g.startCodexWithCdp = startCodexWithCdp;
  g.openClaudeCodeAddModal = openClaudeCodeAddModal;
  g.initClaudeAddPage = initClaudeAddPage;
  g.initClaudeCodeConfigEditorPage = initClaudeCodeConfigEditorPage;
  g.onClaudeAddSearch = onClaudeAddSearch;
  g.renderClaudeAddProviderList = renderClaudeAddProviderList;
  g.selectClaudeAddProvider = selectClaudeAddProvider;
  g.renderClaudeAddModels = renderClaudeAddModels;
  g.updateClaudeAddConfirmButton = updateClaudeAddConfirmButton;
  g.claudeAddSelectAll = claudeAddSelectAll;
  g.claudeAddSelectNone = claudeAddSelectNone;
  g.confirmAddClaudeModelsPage = confirmAddClaudeModelsPage;
  g.toggleClaudeAddSort = toggleClaudeAddSort;
  g.chooseClaudeAddSortMode = chooseClaudeAddSortMode;
  g.toggleClaudeDesktopAddSort = toggleClaudeDesktopAddSort;
  g.chooseClaudeDesktopAddSortMode = chooseClaudeDesktopAddSortMode;
  g.toggleAntigravityAddSort = toggleAntigravityAddSort;
  g.chooseAntigravityAddSortMode = chooseAntigravityAddSortMode;
  g.openClaudeCodeProviderAdd = openClaudeCodeProviderAdd;
  g.openClaudeCodeConfigEditor = openClaudeCodeConfigEditor;
  g.closeClaudeCodeConfigEditor = closeClaudeCodeConfigEditor;
  g.syncClaudeCodeConfigTokenFromSource = syncClaudeCodeConfigTokenFromSource;
  g.syncClaudeCodeConfigUiAfterStoreChange = syncClaudeCodeConfigUiAfterStoreChange;
  g.saveClaudeCodeConfigEditor = saveClaudeCodeConfigEditor;
  g.editClaudeCodeProviderConfig = editClaudeCodeProviderConfig;
  g.deleteClaudeCodeProviderConfig = deleteClaudeCodeProviderConfig;
  g.applyClaudeCodeProviderConfig = applyClaudeCodeProviderConfig;
  g.onClaudeCodeConfigSearch = onClaudeCodeConfigSearch;
  g.renderClaudeCodeConfigList = renderClaudeCodeConfigList;
  g.restoreClaudeCodeOfficialConfig = restoreClaudeCodeOfficialConfig;
  g.openCodexAddModal = openCodexAddModal;
  g.initCodexAddPage = initCodexAddPage;
  g.onCodexAddSearch = onCodexAddSearch;
  g.renderCodexAddProviderList = renderCodexAddProviderList;
  g.selectCodexAddProvider = selectCodexAddProvider;
  g.renderCodexAddModels = renderCodexAddModels;
  g.updateCodexAddConfirmButton = updateCodexAddConfirmButton;
  g.codexAddSelectAll = codexAddSelectAll;
  g.codexAddSelectNone = codexAddSelectNone;
  g.setCodexAddWireApi = setCodexAddWireApi;
  g.setCodexConfigWireApiRadio = setCodexConfigWireApiRadio;
  g.initCodexConfigEditorPage = initCodexConfigEditorPage;
  g.confirmAddCodexModelsPage = confirmAddCodexModelsPage;
  g.toggleCodexAddSort = toggleCodexAddSort;
  g.chooseCodexAddSortMode = chooseCodexAddSortMode;
  g.openCodexProviderAdd = openCodexProviderAdd;
  g.openAntigravityAddPage = openAntigravityAddPage;
  g.openAntigravityAddModal = openAntigravityAddModal;
  g.antigravityRefreshConsole = antigravityRefreshConsole;
  g.renderAntigravityConfigList = renderAntigravityConfigList;
  g.syncAntigravityConfigUiAfterStoreChange = syncAntigravityConfigUiAfterStoreChange;
  g.antigravityPrimaryAction = antigravityPrimaryAction;
  g.antigravityRestoreAction = antigravityRestoreAction;
  g.antigravityFilterModels = antigravityFilterModels;
  g.antigravityToggleSelectAll = antigravityToggleSelectAll;
  g.antigravityToggleSelectAllVisible = antigravityToggleSelectAllVisible;
  g.antigravityToggleRowSelect = antigravityToggleRowSelect;
  g.antigravityBulkEnableAction = antigravityBulkEnableAction;
  g.antigravityBulkDisableAction = antigravityBulkDisableAction;
  g.antigravityBulkThirdPartyVisionAction = antigravityBulkThirdPartyVisionAction;
  g.antigravityBulkRemoveAction = antigravityBulkRemoveAction;
  g.antigravityRenderTableRows = antigravityRenderTableRows;
  g.renderAntigravityPageStatus = renderAntigravityPageStatus;
  g.antigravityRefreshConsole = antigravityRefreshConsole;
  g.antigravityToggleModelEnabled = antigravityToggleModelEnabled;
  g.antigravityToggleThirdPartyVision = antigravityToggleThirdPartyVision;
  g.openAntigravitySettingsModal = openAntigravitySettingsModal;
  g.closeAntigravitySettingsModal = closeAntigravitySettingsModal;
  g.saveAntigravitySettingsModal = saveAntigravitySettingsModal;
  g.selectAntigravityMode = selectAntigravityMode;
  g.syncAntigravityModeUi = syncAntigravityModeUi;
  g.initAntigravityAddPage = initAntigravityAddPage;
  g.onAntigravityAddSearch = onAntigravityAddSearch;
  g.renderAntigravityAddProviderList = renderAntigravityAddProviderList;
  g.selectAntigravityAddProvider = selectAntigravityAddProvider;
  g.renderAntigravityAddModels = renderAntigravityAddModels;
  g.updateAntigravityAddConfirmButton = updateAntigravityAddConfirmButton;
  g.antigravityAddSelectAll = antigravityAddSelectAll;
  g.antigravityAddSelectNone = antigravityAddSelectNone;
  g.confirmAddAntigravityModelsPage = confirmAddAntigravityModelsPage;
  g.openAntigravityConfigEditor = openAntigravityConfigEditor;
  g.closeAntigravityConfigEditor = closeAntigravityConfigEditor;
  g.saveAntigravityConfigEditor = saveAntigravityConfigEditor;
  g.editAntigravityProviderConfig = editAntigravityProviderConfig;
  g.deleteAntigravityProviderConfig = deleteAntigravityProviderConfig;
  g.renderPlatformProviderOptions = renderPlatformProviderOptions;
  g.cursorPageRoot = cursorPageRoot;
  g.cursorEnsureBridge = cursorEnsureBridge;
  g.cursorSetText = cursorSetText;
  g.cursorSetBusy = cursorSetBusy;
  g.cursorRefreshConsole = cursorRefreshConsole;
  g.cursorPrimaryAction = cursorPrimaryAction;
  g.cursorEnableAction = cursorEnableAction;
  g.cursorDisableAction = cursorDisableAction;
  g.cursorSyncRoutesAction = cursorSyncRoutesAction;
  g.cursorRestartCoreAction = cursorRestartCoreAction;
  g.cursorRestartIdeAction = cursorRestartIdeAction;
  g.cursorPreflightAction = cursorPreflightAction;
  g.cursorInstallCertAction = cursorInstallCertAction;
  g.cursorStartProxy = cursorStartProxy;
  g.cursorSwitchToProxy = cursorSwitchToProxy;
  g.cursorRestoreDirect = cursorRestoreDirect;
  g.cursorRestartIde = cursorRestartIde;
  g.cursorRunHealthcheck = cursorRunHealthcheck;
  g.cursorInstallCert = cursorInstallCert;
  g.cursorOpenProxyModels = cursorOpenProxyModels;
  g.cursorOpenProxyLogs = cursorOpenProxyLogs;
  g.cursorOpenStats = cursorOpenStats;
  g.cursorFilterModels = cursorFilterModels;
  g.cursorToggleRowSelect = cursorToggleRowSelect;
  g.cursorToggleSelectAll = cursorToggleSelectAll;
  g.cursorToggleSelectAllVisible = cursorToggleSelectAllVisible;
  g.cursorBulkEnableAction = cursorBulkEnableAction;
  g.cursorBulkDisableAction = cursorBulkDisableAction;
  g.cursorBulkThirdPartyVisionAction = cursorBulkThirdPartyVisionAction;
  g.cursorBulkRemoveAction = cursorBulkRemoveAction;
  g.cursorToggleModelEnabled = cursorToggleModelEnabled;
  g.cursorToggleThirdPartyVision = cursorToggleThirdPartyVision;
  g.cursorStartEditDisplayName = cursorStartEditDisplayName;
  g.cursorRemoveSingleModel = cursorRemoveSingleModel;
  g.openCursorEditModal = openCursorEditModal;
  g.closeCursorEditModal = closeCursorEditModal;
  g.saveCursorEditModel = saveCursorEditModel;
  g.openCursorSettingsModal = openCursorSettingsModal;
  g.closeCursorSettingsModal = closeCursorSettingsModal;
  g.switchCursorSettingsTab = switchCursorSettingsTab;
  g.syncCursorSettingsModalData = syncCursorSettingsModalData;
  g.cursorUpdateTagStyleSelects = cursorUpdateTagStyleSelects;
  g.openCursorTagStyleModal = openCursorTagStyleModal;
  g.closeCursorTagStyleModal = closeCursorTagStyleModal;
  g.saveCursorTagStyleModal = saveCursorTagStyleModal;
  g.selectCursorBracketPreset = selectCursorBracketPreset;
  g.cursorChangeProviderTagStyle = cursorChangeProviderTagStyle;
  g.onCursorTagStyleChange = onCursorTagStyleChange;
  g.cursorRefreshConsoleAction = cursorRefreshConsoleAction;
  g.detectCursorIdePath = detectCursorIdePath;
  g.saveCursorIdePath = saveCursorIdePath;
  g.saveCursorCorePort = saveCursorCorePort;
  g.openCursorAddPage = openCursorAddPage;
  g.initCursorAddPage = initCursorAddPage;
  g.onCursorAddSearch = onCursorAddSearch;
  g.onCursorAddNamingRuleChange = onCursorAddNamingRuleChange;
  g.toggleCursorAddSort = toggleCursorAddSort;
  g.chooseCursorAddSortMode = chooseCursorAddSortMode;
  g.selectCursorAddProvider = selectCursorAddProvider;
  g.toggleCursorAddModel = toggleCursorAddModel;
  g.cursorAddSelectAll = cursorAddSelectAll;
  g.cursorAddSelectNone = cursorAddSelectNone;
  g.confirmAddCursorModelsPage = confirmAddCursorModelsPage;
  g.openPlatformPage = openPlatformPage;
  g.onPlatformProviderChange = onPlatformProviderChange;
  g.setPlatformBusy = setPlatformBusy;
  g.switchFlowErrorText = switchFlowErrorText;
  g.assertSwitchResultOk = assertSwitchResultOk;
  g.runSwitchFlow = runSwitchFlow;
  g.showSwitchProgress = showSwitchProgress;
  g.updateSwitchProgress = updateSwitchProgress;
  g.hideSwitchProgress = hideSwitchProgress;
  g.bindSwitchProgressListener = bindSwitchProgressListener;
  g.applyPlatform = applyPlatform;
  g.codexApplyConfirmMessage = codexApplyConfirmMessage;
  g.restoreCodexOfficialConfig = restoreCodexOfficialConfig;
  g.repairCodexSessionVisibility = repairCodexSessionVisibility;
  g.restorePlatform = restorePlatform;
  g.normalizePlatformAddProviderSortMode = normalizePlatformAddProviderSortMode;
  g.platformAddProviderSortLabel = platformAddProviderSortLabel;
  g.platformAddProviderSortText = platformAddProviderSortText;
  g.comparePlatformAddProvidersByName = comparePlatformAddProvidersByName;
  g.platformAddProviderSortedList = platformAddProviderSortedList;
  g.platformAddProviderSearchHaystack = platformAddProviderSearchHaystack;
  g.platformAddVisibleProviders = platformAddVisibleProviders;
  g.renderPlatformAddProviderLists = renderPlatformAddProviderLists;
  g.setPlatformAddProviderSortMode = setPlatformAddProviderSortMode;
  g.syncPlatformAddSortControl = syncPlatformAddSortControl;
  g.syncAllPlatformAddSortControls = syncAllPlatformAddSortControls;
  g.setPlatformAddSortMenuOpen = setPlatformAddSortMenuOpen;
  g.togglePlatformAddSortMenu = togglePlatformAddSortMenu;
  g.closePlatformAddSortMenus = closePlatformAddSortMenus;
  g.choosePlatformAddSortMode = choosePlatformAddSortMode;
  g.toggleCbAddSort = toggleCbAddSort;
  g.chooseCbAddSortMode = chooseCbAddSortMode;
  g.toggleWbAddSort = toggleWbAddSort;
  g.chooseWbAddSortMode = chooseWbAddSortMode;
  g.toggleZcAddSort = toggleZcAddSort;
  g.chooseZcAddSortMode = chooseZcAddSortMode;
  g.cbApplyConfigMeta = cbApplyConfigMeta;
  g.cbUniqueStrings = cbUniqueStrings;
  g.cbMergeAvailableModels = cbMergeAvailableModels;
  g.tencentBuddyPlatformLabel = tencentBuddyPlatformLabel;
  g.cloneTencentBuddyJson = cloneTencentBuddyJson;
  g.syncTencentBuddySyncButtons = syncTencentBuddySyncButtons;
  g.setTencentBuddySyncEnabled = setTencentBuddySyncEnabled;
  g.tencentBuddyModelId = tencentBuddyModelId;
  g.mergeTencentBuddyModelObject = mergeTencentBuddyModelObject;
  g.mergeTencentBuddyModelState = mergeTencentBuddyModelState;
  g.readTencentBuddyModels = readTencentBuddyModels;
  g.memoryTencentBuddyModels = memoryTencentBuddyModels;
  g.persistTencentBuddyModels = persistTencentBuddyModels;
  g.applyTencentBuddySyncedState = applyTencentBuddySyncedState;
  g.syncTencentBuddyModels = syncTencentBuddyModels;
  g.toggleTencentBuddySync = toggleTencentBuddySync;
  g.cbRemoveAvailableModel = cbRemoveAvailableModel;
  g.cbReplaceAvailableModel = cbReplaceAvailableModel;
  g.cbProviderChatUrl = cbProviderChatUrl;
  g.zcNormalizeBaseUrl = zcNormalizeBaseUrl;
  g.zcProviderBaseUrl = zcProviderBaseUrl;
  g.zcHashId = zcHashId;
  g.zcProviderIdNeedsMigration = zcProviderIdNeedsMigration;
  g.zcProviderIdForModel = zcProviderIdForModel;
  g.zcProviderIdForProvider = zcProviderIdForProvider;
  g.zcProviderModelKeyParts = zcProviderModelKeyParts;
  g.zcProviderModelKey = zcProviderModelKey;
  g.cbModelSelectionKey = cbModelSelectionKey;
  g.cbProviderApiKey = cbProviderApiKey;
  g.cbSelectedCapability = cbSelectedCapability;
  g.cbRecommendContextWindow = cbRecommendContextWindow;
  g.cbRecommendMaxOutputTokens = cbRecommendMaxOutputTokens;
  g.cbFormatContextTokens = cbFormatContextTokens;
  g.cbIsLegacyDefaultContext = cbIsLegacyDefaultContext;
  g.cbNormalizeModelContext = cbNormalizeModelContext;
  g.cbNormalizeModelsContext = cbNormalizeModelsContext;
  g.cbBuildModelEntry = cbBuildModelEntry;
  g.cbAddModelIdentity = cbAddModelIdentity;
  g.cbOnAddModelCheckChanged = cbOnAddModelCheckChanged;
  g.cbSetAddModelChecks = cbSetAddModelChecks;
  g.cbApplyProviderModelSelection = cbApplyProviderModelSelection;
  g.cbIconSvg = cbIconSvg;
  g.cbCapabilityChip = cbCapabilityChip;
  g.cbCapabilityPill = cbCapabilityPill;
  g.cbEditModelsRef = cbEditModelsRef;
  g.openCbEditModal = openCbEditModal;
  g.closeCbEditModal = closeCbEditModal;
  g.cbFillRecommendedContext = cbFillRecommendedContext;
  g.saveCbEditFromModal = saveCbEditFromModal;
  g.cbModelsByClass = cbModelsByClass;
  g.cbModelMatches = cbModelMatches;
  g.cbFilteredModelEntries = cbFilteredModelEntries;
  g.cbNoResultRow = cbNoResultRow;
  g.cbUpdateConsoleStats = cbUpdateConsoleStats;
  g.cbButtonLabelEl = cbButtonLabelEl;
  g.cbGetButtonLabel = cbGetButtonLabel;
  g.cbSetButtonLabel = cbSetButtonLabel;
  g.onCbModelSearch = onCbModelSearch;
  g.onWbModelSearch = onWbModelSearch;
  g.onZcModelSearch = onZcModelSearch;
  g.cbSelectionSet = cbSelectionSet;
  g.cbModelListRef = cbModelListRef;
  g.cbSelectedVisibleEntries = cbSelectedVisibleEntries;
  g.cbPruneSelection = cbPruneSelection;
  g.cbSyncSelectionState = cbSyncSelectionState;
  g.toggleCbModelSelection = toggleCbModelSelection;
  g.toggleCbModelSelectAll = toggleCbModelSelectAll;
  g.cbPersistModelDeletion = cbPersistModelDeletion;
  g.cbDeleteModelByIndex = cbDeleteModelByIndex;
  g.cbDeleteSelectedModels = cbDeleteSelectedModels;
  g.deleteSelectedCbModels = deleteSelectedCbModels;
  g.deleteSelectedWbModels = deleteSelectedWbModels;
  g.deleteSelectedZcModels = deleteSelectedZcModels;
  g.copyCbModelId = copyCbModelId;
  g.cbModelRow = cbModelRow;
  g.loadCodeBuddyModels = loadCodeBuddyModels;
  g.renderCodeBuddyModels = renderCodeBuddyModels;
  g.editCbModel = editCbModel;
  g.cancelCbEdit = cancelCbEdit;
  g.saveCbEdit = saveCbEdit;
  g.deleteCbModel = deleteCbModel;
  g.toggleCbModelEnabled = toggleCbModelEnabled;
  g.saveCodeBuddyModels = saveCodeBuddyModels;
  g.openCodeBuddyAddModal = openCodeBuddyAddModal;
  g.initCbAddPage = initCbAddPage;
  g.onCbAddSearch = onCbAddSearch;
  g.renderCbAddProviderList = renderCbAddProviderList;
  g.selectCbAddProvider = selectCbAddProvider;
  g.renderCbAddModels = renderCbAddModels;
  g.updateCbAddConfirmButton = updateCbAddConfirmButton;
  g.cbAddSelectAll = cbAddSelectAll;
  g.cbAddSelectNone = cbAddSelectNone;
  g.confirmAddCodeBuddyModelsPage = confirmAddCodeBuddyModelsPage;
  g.closeCodeBuddyAddModal = closeCodeBuddyAddModal;
  g.onCbAddProviderChange = onCbAddProviderChange;
  g.confirmAddCodeBuddyModels = confirmAddCodeBuddyModels;
  g.createCbRowFactory = createCbRowFactory;
  g.createCbDropHandlers = createCbDropHandlers;
  g.createCbIoHandlers = createCbIoHandlers;
  g.wbModelRow = wbModelRow;
  g.loadWbModels = loadWbModels;
  g.renderWbModels = renderWbModels;
  g.editWbModel = editWbModel;
  g.cancelWbEdit = cancelWbEdit;
  g.saveWbEdit = saveWbEdit;
  g.deleteWbModel = deleteWbModel;
  g.toggleWbModelEnabled = toggleWbModelEnabled;
  g.saveWbModels = saveWbModels;
  g.openWbAddModal = openWbAddModal;
  g.closeWbAddModal = closeWbAddModal;
  g.onWbAddProviderChange = onWbAddProviderChange;
  g.confirmAddWbModels = confirmAddWbModels;
  g.initWbAddPage = initWbAddPage;
  g.onWbAddSearch = onWbAddSearch;
  g.renderWbAddProviderList = renderWbAddProviderList;
  g.selectWbAddProvider = selectWbAddProvider;
  g.renderWbAddModels = renderWbAddModels;
  g.updateWbAddConfirmButton = updateWbAddConfirmButton;
  g.wbAddSelectAll = wbAddSelectAll;
  g.wbAddSelectNone = wbAddSelectNone;
  g.confirmAddWbModelsPage = confirmAddWbModelsPage;
  g.zcModelRow = zcModelRow;
  g.loadZcModels = loadZcModels;
  g.renderZcModels = renderZcModels;
  g.editZcModel = editZcModel;
  g.cancelZcEdit = cancelZcEdit;
  g.saveZcEdit = saveZcEdit;
  g.deleteZcModel = deleteZcModel;
  g.toggleZcModelEnabled = toggleZcModelEnabled;
  g.saveZcModels = saveZcModels;
  g.openZcAddModal = openZcAddModal;
  g.closeZcAddModal = closeZcAddModal;
  g.onZcAddProviderChange = onZcAddProviderChange;
  g.confirmAddZcModels = confirmAddZcModels;
  g.initZcAddPage = initZcAddPage;
  g.onZcAddSearch = onZcAddSearch;
  g.renderZcAddProviderList = renderZcAddProviderList;
  g.selectZcAddProvider = selectZcAddProvider;
  g.renderZcAddModels = renderZcAddModels;
  g.updateZcAddConfirmButton = updateZcAddConfirmButton;
  g.zcAddSelectAll = zcAddSelectAll;
  g.zcAddSelectNone = zcAddSelectNone;
  g.confirmAddZcModelsPage = confirmAddZcModelsPage;
  g.zcFlatToNative = zcFlatToNative;
  g.zcReasoningEnabled = zcReasoningEnabled;
  g.zcNativeToFlat = zcNativeToFlat;
  g.zcPayloadToFlat = zcPayloadToFlat;

  // ─── 平台页原生重试设置 ───
  async function renderPlatformNativeRetry() {
    if (!invoke) return;
    try {
      const map = await invoke('load_model_map');
      const e = map?.enhancement || {};
      const reqEl = document.getElementById('platform-codex-request-max-retries');
      const streamEl = document.getElementById('platform-codex-stream-max-retries');
      const claudeEl = document.getElementById('platform-claude-max-retries');
      if (reqEl) reqEl.value = e.codexRequestMaxRetries ?? 10;
      if (streamEl) streamEl.value = e.codexStreamMaxRetries ?? 10;
      if (claudeEl) claudeEl.value = e.claudeMaxRetries ?? 10;
    } catch (_) { /* ignore */ }
  }

  async function saveCodexNativeRetry(input) {
    if (!invoke) return;
    const id = input?.id;
    const key = id === 'platform-codex-request-max-retries' ? 'codexRequestMaxRetries'
      : id === 'platform-codex-stream-max-retries' ? 'codexStreamMaxRetries' : null;
    if (!key) return;
    const val = Math.max(0, Math.min(100, parseInt(input.value, 10) || 0));
    input.value = val;
    try {
      const map = await invoke('load_model_map');
      if (!map.enhancement) map.enhancement = {};
      map.enhancement[key] = val;
      await invoke('save_model_map', { map });
      if (globalThis.modelMapStore && globalThis.modelMapStore.enhancement) {
        globalThis.modelMapStore.enhancement[key] = val;
      }
      // 重新应用当前 Codex 配置，让重试值立即写入 config.toml
      const info = platformInfoOf('codex');
      if (info?.currentProviderId && info.managedByAnyBridge) {
        try { await invoke('switch_platform', { platform: 'codex', providerId: info.currentProviderId }); } catch (_) { /* 静默 */ }
      }
      if (typeof addLog === 'function') addLog('ok', `已保存 Codex 原生重试: ${key} = ${val}`);
    } catch (e) {
      if (typeof addLog === 'function') addLog('err', '保存 Codex 原生重试失败: ' + e);
    }
  }

  async function saveClaudeNativeRetry(input) {
    if (!invoke) return;
    const val = Math.max(0, Math.min(15, parseInt(input.value, 10) || 0));
    input.value = val;
    try {
      const map = await invoke('load_model_map');
      if (!map.enhancement) map.enhancement = {};
      map.enhancement.claudeMaxRetries = val;
      await invoke('save_model_map', { map });
      if (globalThis.modelMapStore && globalThis.modelMapStore.enhancement) {
        globalThis.modelMapStore.enhancement.claudeMaxRetries = val;
      }
      // 重新应用当前 Claude Code 配置，让重试值立即写入 settings.json
      const info = platformInfoOf('claude-code');
      if (info?.currentProviderId && info.managedByAnyBridge) {
        try { await invoke('switch_platform', { platform: 'claude-code', providerId: info.currentProviderId }); } catch (_) { /* 静默 */ }
      }
      if (typeof addLog === 'function') addLog('ok', `已保存 Claude Code 原生重试: claudeMaxRetries = ${val}`);
    } catch (e) {
      if (typeof addLog === 'function') addLog('err', '保存 Claude Code 原生重试失败: ' + e);
    }
  }

  g.renderPlatformNativeRetry = renderPlatformNativeRetry;
  g.saveCodexNativeRetry = saveCodexNativeRetry;
  g.saveClaudeNativeRetry = saveClaudeNativeRetry;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        try { antigravityRenderTableRows(); } catch (_) {}
      });
    } else {
      setTimeout(() => {
        try { antigravityRenderTableRows(); } catch (_) {}
      }, 0);
    }
  }
})(globalThis);
