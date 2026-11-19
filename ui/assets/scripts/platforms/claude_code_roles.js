// platforms/claude_code_roles.js — Claude Code 角色映射表单与 1M 上下文联动

globalThis.CLAUDE_ROLES = [
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

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.hasClaude1mMarker = hasClaude1mMarker;
  g.stripClaude1mMarker = stripClaude1mMarker;
  g.applyClaude1mMarker = applyClaude1mMarker;
  g.onClaude1mCheckboxChanged = onClaude1mCheckboxChanged;
  g.setClaude1mCheckbox = setClaude1mCheckbox;
  g.getClaude1mCheckbox = getClaude1mCheckbox;
  g.onClaudeRoleFieldInput = onClaudeRoleFieldInput;
  g.claudeCodeSettingsFromFields = claudeCodeSettingsFromFields;
  g.claudeCodeSettingsTextFromFields = claudeCodeSettingsTextFromFields;
  g.claudeCodeSetRawSettings = claudeCodeSetRawSettings;
  g.claudeCodeCreateSettingsFromCurrentFields = claudeCodeCreateSettingsFromCurrentFields;
  g.claudeCodeConfigObjectFromRawOrFields = claudeCodeConfigObjectFromRawOrFields;
  g.claudeCodeRawConfigTextFromFields = claudeCodeRawConfigTextFromFields;
  g.syncClaudeCodeRawConfigFromFields = syncClaudeCodeRawConfigFromFields;
  g.claudeCodeApplyRawConfigToFields = claudeCodeApplyRawConfigToFields;
  g.onClaudeCodeRawConfigInput = onClaudeCodeRawConfigInput;
  g.onClaudeCodeDefaultModelInput = onClaudeCodeDefaultModelInput;
  g.renderClaudeCodeConfigSourceList = renderClaudeCodeConfigSourceList;
  g.refreshAllClaudeRoleSelects = refreshAllClaudeRoleSelects;
  g.setClaudeRoleSelectValue = setClaudeRoleSelectValue;
  g.isGenericClaudeRoleName = isGenericClaudeRoleName;
  g.onClaudeRoleSelectChange = onClaudeRoleSelectChange;
  g.onClaudeFallbackSelectChange = onClaudeFallbackSelectChange;
  g.claudeCodeApplySettingsToRoleForm = claudeCodeApplySettingsToRoleForm;
  g.claudeCodeExtractModelsFromRoleForm = claudeCodeExtractModelsFromRoleForm;
  g.claudeCodeQuickSetAllModels = claudeCodeQuickSetAllModels;
  g.applyClaudeCodeConfigSource = applyClaudeCodeConfigSource;
  g.selectClaudeCodeConfigSource = selectClaudeCodeConfigSource;
})(globalThis);
