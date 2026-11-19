// platforms/codebuddy.js — CodeBuddy / WorkBuddy 双端读取、规范化与同步切换

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
    path: data && data._configPath ? String(data._configPath) : (typeof platformDef === 'function' ? platformDef(platform).configHint : '') || '',
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

const cbAddApi = createBuddyAddHandlers({
  prefix: 'Cb',
  domPrefix: 'cb',
  platformId: CB_PLATFORM,
  pageSlug: 'codebuddy',
  cssPrefix: 'cb',
  openModalName: 'openCodeBuddyAddModal',
  closeModalName: 'closeCodeBuddyAddModal',
  providerChangeName: 'onCbAddProviderChange',
  legacyConfirmName: 'confirmAddCodeBuddyModels',
  confirmPageName: 'confirmAddCodeBuddyModelsPage',
  renderModelsFnName: 'renderCodeBuddyModels',
  saveModelsFnName: 'saveCodeBuddyModels',
});

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
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
  g.normalizeBuddyModelsForPlatform = normalizeBuddyModelsForPlatform;
  g.persistTencentBuddyModels = persistTencentBuddyModels;
  g.applyTencentBuddySyncedState = applyTencentBuddySyncedState;
  g.syncTencentBuddyModels = syncTencentBuddyModels;
  g.toggleTencentBuddySync = toggleTencentBuddySync;
  g.openCodeBuddyAddModal = cbAddApi.openModal;
  g.closeCodeBuddyAddModal = cbAddApi.closeModal;
  g.onCbAddProviderChange = cbAddApi.onProviderChange;
  g.confirmAddCodeBuddyModels = cbAddApi.legacyConfirm;
  g.initCbAddPage = cbAddApi.initPage;
  g.onCbAddSearch = cbAddApi.onSearch;
  g.renderCbAddProviderList = cbAddApi.renderProviderList;
  g.selectCbAddProvider = cbAddApi.selectProvider;
  g.renderCbAddModels = cbAddApi.renderModels;
  g.updateCbAddConfirmButton = cbAddApi.updateConfirmButton;
  g.cbAddSelectAll = cbAddApi.selectAll;
  g.cbAddSelectNone = cbAddApi.selectNone;
  g.confirmAddCodeBuddyModelsPage = cbAddApi.confirmPage;
})(globalThis);
