// model-picker/endpoint-and-editor.js — 端点格式推断、供应商编辑保存与平台配置同步
import { updateModelFilterTabCounts } from './panel-interactions.js';

function cleanProviderApiPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return '/' + raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

function isGeneratedProviderApiPath(apiFormat, apiPath) {
  const path = cleanProviderApiPath(apiPath).toLowerCase();
  if (!path) return false;
  if (apiFormat === 'gemini') {
    return /^\/v1beta\/models(?:\/[^/]+:(?:stream)?generatecontent)?$/.test(path);
  }
  if (apiFormat === 'openai') {
    return [
      '/v1/chat/completions',
      '/api/v1/chat/completions',
      '/v1/responses',
      '/api/v1/responses',
    ].includes(path);
  }
  return path === '/v1/messages' || path === '/api/v1/messages';
}

function displayProviderApiPath(apiFormat, apiPath) {
  const path = cleanProviderApiPath(apiPath);
  return isGeneratedProviderApiPath(apiFormat, path) ? '' : path;
}

function providerEndpointParts(baseUrl, apiFormat, pathValue) {
  let apiHost = baseUrl;
  let parsedPath = '';
  try {
    const url = new URL(String(baseUrl || '').startsWith('http') ? baseUrl : 'https://' + baseUrl);
    apiHost = url.origin;
    parsedPath = cleanProviderApiPath(url.pathname);
  } catch {
    // Keep the raw host; runtime normalization will still do a final guard.
  }

  const apiPath = parsedPath || displayProviderApiPath(apiFormat, pathValue);

  return { apiHost, apiPath };
}

function providerEndpointDisplayUrl(apiHost, apiPath, apiFormat) {
  const host = String(apiHost || '').trim().replace(/\/+$/, '');
  if (!host) return '';
  const path = displayProviderApiPath(apiFormat, apiPath);
  return `${host}${path}`;
}

function onFormatChange() {
  const fmtEl = document.getElementById('pf-format');
  if (!fmtEl) return;
  const fmt = fmtEl.value;
  const badge = document.getElementById('pf-format-badge');

  // 同步 API 格式徽章（兼容旧版徽章元素）
  if (badge) badge.textContent = fmt === 'gemini' ? 'Gemini' : (fmt === 'openai' ? 'OpenAI' : 'Anthropic');

  // 同步下拉按钮 UI（锁定态显示锁定值，自动态显示带"自动"后缀）
  const lockKey = fmtEl.dataset ? fmtEl.dataset.locked : null;
  if (lockKey === '1') {
    syncFormatDropdownUi(fmt);
  } else {
    syncFormatDropdownUi('auto');
  }

  // 不再根据格式自动改 apiPath；默认端点只在后端发起请求时临时推断。

  // Ensure current selected models are in the list
  selectedModels.forEach(m => {
    if (m && !activeModelsList.includes(m)) {
      activeModelsList.push(m);
    }
  });
  if (typeof sortModelsNaturally === 'function') {
    activeModelsList = sortModelsNaturally(activeModelsList);
  }
  modelGroupStates = {};
  filterModelPanel();
}

// 根据用户填写的 API 地址自动推断格式（明确特征时返回协议；无特征返回 null 供上层按需兜底）
function inferExplicitFormatFromEndpoint(hostValue, pathValue = '') {
  const raw = `${hostValue || ''} ${pathValue || ''}`.trim();
  if (!raw) return null;
  const v = raw.toLowerCase();
  // 先拦截明确的 OpenAI / Anthropic 特征，避免误伤区域 Vertex Claude 或 OpenAI 兼容路径
  if (v.includes('/publishers/anthropic/')
      || v.includes(':rawpredict')
      || v.includes(':streamrawpredict')
      || v.includes('anthropic')
      || v.includes('/v1/messages')) {
    return 'anthropic';
  }
  if (v.includes('/endpoints/openapi')
      || /\/openai(?:\/|\?|$|\s)/.test(v)
      || v.includes('chat/completions')
      || v.includes('/responses')
      || v.includes('/compatible-mode')) {
    return 'openai';
  }
  const isVertexGoogle = v.includes('/publishers/google/models')
    || (/(?:^|\/\/)(?:[a-z0-9-]+-)?aiplatform(?:\.[a-z0-9-]+)?(?:\.rep)?\.googleapis\.com(?:\/|:|\?|$)/.test(v));
  if (v.includes('generativelanguage.googleapis.com')
      || v.includes('gemini')
      || v.includes('/v1beta')
      || v.includes(':generatecontent')
      || v.includes(':streamgeneratecontent')
      || v.includes(':counttokens')
      || isVertexGoogle) {
    return 'gemini';
  }
  if (v.includes('openai')
      || v.includes('dashscope')
      || v.includes('qwen')
      || v.includes('/v1/chat')
      || /\/v1\/?(?:\?|$|\s)/.test(v)) {
    return 'openai';
  }
  return null;
}

// 根据用户填写的 API 地址自动推断格式
function autoDetectFormatFromHost(hostValue) {
  return inferExplicitFormatFromEndpoint(hostValue) || 'anthropic';
}

// 用户输入 URL 时自动识别 + 更新徽章
function onHostChange() {
  const hostEl = document.getElementById('pf-host');
  const fmtEl = document.getElementById('pf-format');
  if (!hostEl || !fmtEl) return;
  // 用户手动锁定为 anthropic / openai 时，URL 变化不自动覆盖
  const locked = fmtEl.dataset && fmtEl.dataset.locked === '1';
  if (locked) return;
  const detected = autoDetectFormatFromHost(hostEl.value);
  if (fmtEl.value !== detected) {
    fmtEl.value = detected;
    onFormatChange();
  }
  // 同步下拉按钮的当前选中态（自动识别模式下随 URL 实时变）
  syncFormatDropdownUi('auto');
}

// 切换下拉显隐
function toggleFormatDropdown(event) {
  if (event) event.stopPropagation();
  const dd = document.getElementById('pfFormatDropdown');
  const trigger = document.getElementById('pfFormatTrigger');
  if (!dd) return;
  const isOpen = dd.style.display === 'flex';
  if (isOpen) {
    dd.style.display = 'none';
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  } else {
    dd.style.display = 'flex';
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }
}

// 用户在下拉里选了某个格式
function pickApiFormat(format, event) {
  if (event) event.stopPropagation();
  const fmtEl = document.getElementById('pf-format');
  const hostEl = document.getElementById('pf-host');
  if (!fmtEl) return;

  if (format === 'auto') {
    // 切回自动识别：解锁 + 立刻按 URL 重算
    fmtEl.dataset.locked = '0';
    if (hostEl) {
      const detected = autoDetectFormatFromHost(hostEl.value);
      fmtEl.value = detected;
      onFormatChange();
    }
    syncFormatDropdownUi('auto');
  } else {
    // 锁定为 anthropic / openai
    fmtEl.value = format;
    fmtEl.dataset.locked = '1';
    onFormatChange();
    syncFormatDropdownUi(format);
  }
  // 关闭下拉
  const dd = document.getElementById('pfFormatDropdown');
  if (dd) dd.style.display = 'none';
  const trigger = document.getElementById('pfFormatTrigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

// 同步下拉按钮的显示（label + 选项高亮）
function syncFormatDropdownUi(activeFormat) {
  const fmtEl = document.getElementById('pf-format');
  const labelEl = document.getElementById('pfFormatTriggerLabel');
  if (!fmtEl || !labelEl) return;
  // 决定 label 文本：auto 时按 URL 实时显示，锁定时显示锁定值
  let display;
  if (activeFormat === 'auto') {
    fmtEl.dataset.locked = '0';
    // 自动识别模式下只显示「自动」，不暴露具体协议
    display = '自动';
  } else {
    display = activeFormat === 'gemini' ? 'Gemini' : (activeFormat === 'openai' ? 'OpenAI' : 'Anthropic');
  }
  labelEl.textContent = display;
  // 高亮下拉里被选中的项
  document.querySelectorAll('.pf-format-option').forEach(opt => {
    const optFmt = opt.getAttribute('data-format');
    const check = opt.querySelector('.pf-format-check');
    let isActive = false;
    if (activeFormat === 'auto') {
      isActive = optFmt === 'auto';
    } else {
      isActive = optFmt === activeFormat;
    }
    if (check) check.style.display = isActive ? 'inline-block' : 'none';
    if (isActive) {
      opt.style.background = 'var(--accent-light)';
      opt.style.color = 'var(--accent)';
    } else {
      opt.style.background = 'transparent';
      opt.style.color = 'var(--text-primary)';
    }
  });
}

function openProviderEditor(id) {
  if (id) {
    const existing = providerStore.providers.find(x => x.id === id);
    // 仅拦截虚拟内置（AnyBridge 内置供应商）；CPA 等落盘内置允许编辑
    if (existing && isVirtualBuiltinProvider(existing)) {
      showCustomAlert('内置供应商不可编辑。', '无法编辑', 'warn');
      return;
    }
  }
  const title = document.getElementById('providerModalTitle');
  const p = id ? providerStore.providers.find(x => x.id === id) : null;
  document.getElementById('pf-id').value = p ? p.id : '';
  document.getElementById('pf-name').value = p ? p.name : '';
  const host = p ? p.apiHost : '';
  const path = p ? (p.apiPath || '') : '';
  const detectedApiFormat = autoDetectFormatFromHost(`${host}${path}`);
  const savedFormat = p && ['openai', 'anthropic', 'gemini'].includes(p.apiFormat) ? p.apiFormat : '';
  const effectiveFormat = savedFormat || detectedApiFormat;
  const fmtElInit = document.getElementById('pf-format');
  if (fmtElInit) {
    fmtElInit.value = effectiveFormat;
    fmtElInit.dataset.locked = (savedFormat && savedFormat !== detectedApiFormat) ? '1' : '0';
  }

  // Show only the user-facing API URL. Generated default paths stay internal.
  const apiFormat = effectiveFormat;
  document.getElementById('pf-host').value = p ? providerEndpointDisplayUrl(host, path, apiFormat) : host;
  document.getElementById('pf-path').value = p ? displayProviderApiPath(apiFormat, path) : '';
  document.getElementById('pf-key').value = p ? p.apiKey : '';
  document.getElementById('pf-key').type = 'password';
  // 打开编辑页即同步：Vertex 端点禁用「获取模型列表」并常驻说明
  if (typeof globalThis.syncVertexModelListHint === 'function') globalThis.syncVertexModelListHint();
  // 编辑已有 Vertex 卡时同样给出「地区 + 测速」行（从路径反解当前地区）
  if (typeof globalThis.syncVertexRegionPicker === 'function') globalThis.syncVertexRegionPicker();
  const caps = providerCapabilities(p || { apiPath: document.getElementById('pf-path').value });
  const gzipEl = document.getElementById('pf-cap-gzip');
  if (gzipEl) gzipEl.checked = caps.gzip;
  const keyBtn = document.getElementById('pf-key-toggle');
  if (keyBtn) keyBtn.innerHTML = EYE_SVG_OPEN;

  // Load selected models (supports fallback to defaultModel if models array is empty/absent)
  if (p) {
    selectedModels = providerSelectedModels(p);
    editorDraftModelCaps = {};
  } else {
    selectedModels = [];
    editorDraftModelCaps = {};
  }
  updateSelectedModelsUI();

  if (title) title.textContent = p ? '编辑供应商' : '新增供应商';
  const subtitleEl = document.getElementById('providerModalSubtitle');
  if (subtitleEl) subtitleEl.textContent = p ? `正在编辑「${p.name}」` : '配置供应商信息和模型';

  // 预设目录只在新增时露出：编辑态换预设会覆盖用户已填的地址与协议
  if (typeof resetProviderPresetUi === 'function') resetProviderPresetUi(!p);
  // 多密钥池：当前密钥由上方输入框承载，池里只放其余候选
  if (typeof loadEditorApiKeys === 'function') loadEditorApiKeys(p);

  // Start with configured models in list
  activeModelsList = typeof sortModelsNaturally === 'function'
    ? sortModelsNaturally([...selectedModels])
    : [...selectedModels];
  modelGroupStates = {};
  modelSearchOpen = false;
  currentModelTab = 'all';
  modelPanelSortMode = 'default';
  const sortBtn = document.getElementById('modelFilterSortBtn');
  if (sortBtn) {
    sortBtn.classList.remove('active');
    sortBtn.title = '切换模型排序 (默认 / 名称 A-Z)';
    const label = sortBtn.querySelector('.model-sort-label');
    if (label) label.textContent = 'A-Z';
  }
  const clearBtn = document.getElementById('modelSearchClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  updateModelFilterTabCounts();

  // 重置 UI 的 Tab 选中状态
  document.querySelectorAll('.model-filter-tab').forEach(el => {
    const isAllTab = el.getAttribute('data-arg') === 'all';
    el.classList.toggle('active', !!isAllTab);
  });

  const searchInput = document.getElementById('modelSearchInput');
  if (searchInput) searchInput.value = '';

  onFormatChange();
  // 切到「新增/编辑供应商」普通 page，保持顶部 tab 栏可见
  navigateTo('provider-editor');

  // 注册全局点击关闭 API 格式下拉（首次进入时挂一次）
  if (!window._pfFormatDropdownGlobalBound) {
    window._pfFormatDropdownGlobalBound = true;
    window.addEventListener('click', (e) => {
      const dd = document.getElementById('pfFormatDropdown');
      const select = document.getElementById('pfFormatSelect');
      if (!dd || !select) return;
      if (select.contains(e.target)) return;
      if (dd.style.display === 'flex') {
        dd.style.display = 'none';
        const trigger = document.getElementById('pfFormatTrigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Remote model fetching is manual only. Opening the editor must not call provider APIs.
}

function closeProviderEditor() {
  // 返回供应商列表
  navigateTo('providers');
}

async function saveProviderFromEditor() {
  const id = document.getElementById('pf-id').value;
  if (id) {
    const existing = providerStore.providers.find(x => x.id === id);
    // 仅拦截虚拟内置（AnyBridge 内置供应商）；CPA 等落盘内置允许保存
    if (existing && isVirtualBuiltinProvider(existing)) {
      showCustomAlert('内置供应商不可编辑。', '无法保存', 'warn');
      return;
    }
  }
  const name = document.getElementById('pf-name').value.trim();
  const apiFormat = document.getElementById('pf-format').value;
  const baseUrl = document.getElementById('pf-host').value.trim();
  const apiKey = document.getElementById('pf-key').value.trim();

  if (!name || !baseUrl || !apiKey || selectedModels.length === 0) {
    addLog('warn', '请填写名称、地址、密钥并至少选择一个模型');
    return;
  }

  const { apiHost, apiPath } = providerEndpointParts(
    baseUrl,
    apiFormat,
    document.getElementById('pf-path').value
  );

  const defaultModel = selectedModels[0] || '';
  const existingProvider = id ? providerStore.providers.find(x => x.id === id) : null;
  const existingCaps = existingProvider?.capabilities || {};
  const capabilities = {
    ...existingCaps,
    text: true,
    stream: true,
    vision: existingCaps.vision !== false,
    tools: existingCaps.tools !== false,
    gzip: !!document.getElementById('pf-cap-gzip')?.checked,
  };

  // 合并已有 modelCaps + 本次弹窗探测到的草稿能力
  const existingModelCaps = existingProvider?.modelCaps || {};
  const mergedModelCaps = { ...existingModelCaps, ...editorDraftModelCaps };
  const provider = {
    id: id || `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name, apiHost, apiKey, defaultModel,
    apiPath: apiPath || null,
    apiFormat: ['openai', 'anthropic', 'gemini'].includes(apiFormat) ? apiFormat : undefined,
    enabled: true,
    capabilities,
    models: [...selectedModels],
    modelCaps: mergedModelCaps,
    apiKeys: typeof collectEditorApiKeys === 'function' ? collectEditorApiKeys() : [],
  };
  if (existingProvider?.unlocks) provider.unlocks = existingProvider.unlocks;
  if (existingProvider?.meta) provider.meta = existingProvider.meta;

  // 自动同步关联该供应商的所有平台配置（Codex / Claude Code / OpenCode / Antigravity / Grok）
  let syncedPlatformConfigsCount = 0;

  const ok = await mutateProviderStore(store => {
    if (!Array.isArray(store.providers)) store.providers = [];
    if (id) {
      const idx = store.providers.findIndex(x => x.id === id);
      if (idx >= 0) {
        provider.enabled = store.providers[idx].enabled !== false;
        store.providers[idx] = provider;
      } else {
        store.providers.push(provider);
      }
    } else {
      store.providers.push(provider);
    }

    if (!id) return;

    const newEndpoint = providerEndpointParts(
      baseUrl,
      apiFormat,
      document.getElementById('pf-path').value
    );
    const resolvedHost = newEndpoint.apiHost;
    const resolvedPath = newEndpoint.apiPath || (apiFormat === 'gemini' ? '' : '/v1');
    const ccBaseUrl = typeof claudeCodeConfigDisplayBaseUrl === 'function'
      ? claudeCodeConfigDisplayBaseUrl({ apiHost: resolvedHost, apiPath: resolvedPath })
      : `${resolvedHost}${resolvedPath && resolvedPath !== '/' ? resolvedPath : ''}`;
    const ocBaseUrl = typeof opencodeConfigDisplayBaseUrl === 'function'
      ? opencodeConfigDisplayBaseUrl({ apiHost: resolvedHost, apiPath: resolvedPath })
      : `${resolvedHost}${resolvedPath && resolvedPath !== '/' ? resolvedPath : ''}`;

    // 1. 同步 Codex 配置
    if (Array.isArray(store.codexConfigs)) {
      store.codexConfigs.forEach(cfg => {
        if (!cfg) return;
        if (cfg.sourceProviderId === id || (!cfg.sourceProviderId && cfg.name === name)) {
          cfg.sourceProviderId = id;
          cfg.apiKey = apiKey;
          cfg.apiHost = resolvedHost;
          cfg.apiPath = resolvedPath;
          if (resolvedPath && resolvedPath.toLowerCase().includes('/responses')) {
            cfg.wireApi = 'responses';
          } else if (resolvedPath && resolvedPath.toLowerCase().includes('/chat/completions')) {
            cfg.wireApi = 'chat';
          }
          syncedPlatformConfigsCount++;
        }
      });
    }

    // 2. 同步 Claude Code 配置（含 settingsConfig.env，彻底避免旧快照反咬）
    if (Array.isArray(store.claudeCodeConfigs)) {
      store.claudeCodeConfigs.forEach(cfg => {
        if (!cfg) return;
        if (cfg.sourceProviderId === id || (!cfg.sourceProviderId && cfg.name === name)) {
          cfg.sourceProviderId = id;
          cfg.apiKey = apiKey;
          cfg.apiHost = resolvedHost;
          cfg.apiPath = resolvedPath;
          if (cfg.settingsConfig && typeof cfg.settingsConfig === 'object' && !Array.isArray(cfg.settingsConfig)) {
            if (!cfg.settingsConfig.env || typeof cfg.settingsConfig.env !== 'object' || Array.isArray(cfg.settingsConfig.env)) {
              cfg.settingsConfig.env = {};
            }
            cfg.settingsConfig.env.ANTHROPIC_BASE_URL = ccBaseUrl;
            cfg.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = apiKey;
            if ('ANTHROPIC_API_KEY' in cfg.settingsConfig.env) {
              cfg.settingsConfig.env.ANTHROPIC_API_KEY = apiKey;
            }
          }
          syncedPlatformConfigsCount++;
        }
      });
    }

    // 3. 同步 OpenCode 配置（含 settingsConfig.options，彻底避免旧快照反咬）
    if (Array.isArray(store.opencodeConfigs)) {
      store.opencodeConfigs.forEach(cfg => {
        if (!cfg) return;
        if (cfg.sourceProviderId === id || (!cfg.sourceProviderId && cfg.name === name)) {
          cfg.sourceProviderId = id;
          cfg.apiKey = apiKey;
          cfg.apiHost = resolvedHost;
          cfg.apiPath = resolvedPath;
          if (cfg.settingsConfig && typeof cfg.settingsConfig === 'object' && !Array.isArray(cfg.settingsConfig)) {
            if (!cfg.settingsConfig.options || typeof cfg.settingsConfig.options !== 'object' || Array.isArray(cfg.settingsConfig.options)) {
              cfg.settingsConfig.options = {};
            }
            cfg.settingsConfig.options.baseURL = ocBaseUrl;
            cfg.settingsConfig.options.apiKey = apiKey;
          }
          syncedPlatformConfigsCount++;
        }
      });
    }

    // 4. 同步 Antigravity 配置：保持引用关系并清理过时快照字段，连接参数实时读取主供应商
    if (Array.isArray(store.antigravityConfigs)) {
      store.antigravityConfigs.forEach(cfg => {
        if (!cfg) return;
        if (cfg.sourceProviderId === id || (!cfg.sourceProviderId && cfg.name === name)) {
          cfg.sourceProviderId = id;
          cfg.sourceProviderName = name;
          delete cfg.apiKey;
          delete cfg.apiHost;
          delete cfg.apiPath;
          delete cfg.apiFormat;
          syncedPlatformConfigsCount++;
        }
      });
    }

    // 5. 同步 Grok 配置
    if (Array.isArray(store.grokConfigs)) {
      store.grokConfigs.forEach(cfg => {
        if (!cfg) return;
        if (cfg.sourceProviderId === id || (!cfg.sourceProviderId && cfg.name === name)) {
          cfg.sourceProviderId = id;
          cfg.apiKey = apiKey;
          cfg.apiHost = resolvedHost;
          cfg.apiPath = resolvedPath;
          syncedPlatformConfigsCount++;
        }
      });
    }
  });

  if (!ok) return;

  renderProviders();
  renderEvalProviderOptions();
  await renderModelMap();
  closeProviderEditor();
  const syncMsg = syncedPlatformConfigsCount > 0 ? `（已同步 ${syncedPlatformConfigsCount} 个平台配置，下次切换或使用时生效）` : '';
  addLog('ok', `已保存供应商: ${name}${syncMsg}`);
}

function setProviderConnectionText(id, value, tooltip = '') {
  const text = document.getElementById(`conn-text-${id}`);
  if (!text) return;
  const message = String(value || '失败');
  text.textContent = message;
  const title = tooltip || message;
  text.title = title;
  const status = text.closest('.provider-conn-status');
  if (status) status.title = title;
}

async function testProvider(id) {
  if (!invoke) return;
  const p = providerStore.providers.find(x => x.id === id);
  if (!p) return;
  const dot = document.getElementById(`conn-dot-${id}`);
  setProviderConnectionText(id, '测试中…');

  const apiFormat = p.apiFormat
    || (typeof autoDetectFormatFromHost === 'function' ? autoDetectFormatFromHost(`${p.apiHost || ''}${p.apiPath || ''}`) : 'openai')
    || 'openai';

  const selected = typeof providerSelectedModels === 'function' ? providerSelectedModels(p) : (p.models || []);
  // 空白默认模型不能当模型用，否则会发出空模型 ID 让上游只回一句 "Invalid model id: "
  const testModel = String(p.defaultModel || '').trim() || selected[0] || null;

  try {
    const result = await invoke('test_connection', {
      args: {
        host: p.apiHost,
        api_key: p.apiKey,
        path: p.apiPath || null,
        api_format: apiFormat,
        model: testModel,
      }
    });

    // 探测到需 gzip 则自动记录
    if (result && result.capabilities && result.capabilities.gzip !== undefined) {
      await mutateProviderStore(store => {
        const idx = (store.providers || []).findIndex(x => x.id === id);
        if (idx < 0 || store.providers[idx].capabilities?.gzip === result.capabilities.gzip) {
          return false;
        }
        store.providers[idx].capabilities = store.providers[idx].capabilities || {};
        store.providers[idx].capabilities.gzip = result.capabilities.gzip;
      }, { silent: true });
    }

    const msg = typeof result === 'string' ? result : (result.message || '连通 ✓');
    const latencyMs = Number(result && result.latencyMs) || 0;
    if (dot) dot.className = 'conn-dot ok';
    setProviderConnectionText(id, msg, `${p.name} 连通正常 (${msg})`);

    // latencyMs 用于「延迟优先」排序；没有数值时留 0，排序时按「未测」处理
    p.connStatus = { ok: true, text: msg, title: `${p.name} 连通正常 (${msg})`, latencyMs };
    addLog('ok', `${p.name} 连通性测试: ${msg}`);
  } catch (err) {
    const rawErr = String(err || '连接失败');
    if (dot) dot.className = 'conn-dot no';
    setProviderConnectionText(id, '连接失败', `测试失败: ${rawErr}`);

    p.connStatus = { ok: false, text: '连接失败', title: `测试失败: ${rawErr}` };
    addLog('err', `${p.name} 连通性测试失败: ${rawErr}`);
  }
}

// ─── 弹窗内测试连接 ──────────────────────────────────────────────
function setProviderEditorTestButtonState(loading) {
  const btn = document.getElementById('provider-editor-test-btn');
  if (!btn) return;
  const label = btn.querySelector('.provider-editor-test-label') || btn.querySelector('span:last-child');
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
  if (!label) return;
  // 加载态必须动态（开发规范）：静态「测试中...」和卡住没区别
  if (loading) {
    label.innerHTML =
      typeof loadingHtml === 'function' ? loadingHtml('测试中…', 12) : '测试中…';
  } else {
    label.textContent = '测试连接';
  }
}

function showProviderEditorTestToast(message, type = 'info', options = {}) {
  if (typeof showBottomToast === 'function') {
    showBottomToast(message, type, options);
  }
}

// ─── 编辑器结果展示条（T2 测试结果 / T4 拉取结果共用，#providerEditorTestResult / #providerFetchResult）────────

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.cleanProviderApiPath = cleanProviderApiPath;
  g.isGeneratedProviderApiPath = isGeneratedProviderApiPath;
  g.displayProviderApiPath = displayProviderApiPath;
  g.providerEndpointParts = providerEndpointParts;
  g.providerEndpointDisplayUrl = providerEndpointDisplayUrl;
  g.onFormatChange = onFormatChange;
  g.inferExplicitFormatFromEndpoint = inferExplicitFormatFromEndpoint;
  g.autoDetectFormatFromHost = autoDetectFormatFromHost;
  g.onHostChange = onHostChange;
  g.toggleFormatDropdown = toggleFormatDropdown;
  g.pickApiFormat = pickApiFormat;
  g.syncFormatDropdownUi = syncFormatDropdownUi;
  g.openProviderEditor = openProviderEditor;
  g.closeProviderEditor = closeProviderEditor;
  g.saveProviderFromEditor = saveProviderFromEditor;
  g.setProviderConnectionText = setProviderConnectionText;
  g.testProvider = testProvider;
  g.setProviderEditorTestButtonState = setProviderEditorTestButtonState;
  g.showProviderEditorTestToast = showProviderEditorTestToast;
})(globalThis);
