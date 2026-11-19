// platforms/antigravity_modals.js — Antigravity 配置编辑、删除与设置弹窗
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

  const view = resolveAntigravityConfigView(provider);
  if (editIdEl) editIdEl.value = provider.id || '';
  if (nameEl) nameEl.value = provider.name || '';
  if (modelEl) modelEl.value = provider.defaultModel || '';
  if (apiFormatEl) {
    apiFormatEl.value = provider.sourceProviderId
      ? (view.apiFormatOverride || '')
      : view.apiFormat;
  }
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
  const apiFormat = String(document.getElementById('antigravity-config-api-format')?.value || '').trim().toLowerCase();
  const injectModels = document.getElementById('antigravity-config-inject-models')?.checked !== false;
  const useThirdPartyVision = document.getElementById('antigravity-config-use-third-party-vision')?.checked === true;

  if (!name) {
    showCustomAlert('显示名称不能为空。', '保存失败', 'warn');
    return;
  }

  const hasVisionModels = (modelMapStore?.visionModels?.imageModels?.length || 0) > 0;
  if (useThirdPartyVision && !hasVisionModels) {
    showCustomAlert('请先在「网关增强」中配置图片理解模型，才能启用第三方图片理解。', '无法启用图片理解', 'warn');
    return;
  }

  const ok = await mutateProviderStore(store => {
    if (!Array.isArray(store.antigravityConfigs)) {
      store.antigravityConfigs = [];
    }
    const existing = store.antigravityConfigs.find(c => c.id === editId);
    if (!existing) return false;
    existing.name = name;
    existing.defaultModel = defaultModel;
    if (existing.sourceProviderId) {
      if (apiFormat === 'openai' || apiFormat === 'anthropic' || apiFormat === 'gemini') {
        existing.apiFormatOverride = apiFormat;
      } else {
        delete existing.apiFormatOverride;
      }
      delete existing.apiHost;
      delete existing.apiPath;
      delete existing.apiKey;
      delete existing.apiFormat;
    } else {
      existing.apiFormat = apiFormat || 'openai';
    }
    existing.injectModels = injectModels;
    existing.useThirdPartyVision = useThirdPartyVision;
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });

  if (ok) {
    await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
    closeAntigravityConfigEditor();
    showCustomAlert(`模型「${name}」已成功保存。`, '保存成功', 'success');
  }
}

async function deleteAntigravityProviderConfig(providerId) {
  const configs = Array.isArray(providerStore?.antigravityConfigs) ? providerStore.antigravityConfigs : [];
  const provider = configs.find(c => c.id === providerId);
  if (!provider) return;
  // 删除模型为轻量可逆操作（模型池条目），不再二次确认，直接移除并保存。
  const ok = await mutateProviderStore(store => {
    store.antigravityConfigs = (store.antigravityConfigs || []).filter(p => p.id !== providerId);
  }, {
    onRollback: () => {
      antigravityRenderTableRows();
      antigravityUpdateBulkActionButtons();
    },
  });
  if (!ok) return;
  _antigravitySelectedSet.delete(providerId);
  await syncAntigravityConfigUiAfterStoreChange({ skipPersist: true });
  if (typeof addLog === 'function') addLog('info', `已移除 Antigravity 模型: ${provider.name || provider.defaultModel}`);
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

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openAntigravityConfigEditor = openAntigravityConfigEditor;
  g.closeAntigravityConfigEditor = closeAntigravityConfigEditor;
  g.saveAntigravityConfigEditor = saveAntigravityConfigEditor;
  g.deleteAntigravityProviderConfig = deleteAntigravityProviderConfig;
  g.editAntigravityProviderConfig = editAntigravityProviderConfig;
  g.openAntigravitySettingsModal = openAntigravitySettingsModal;
  g.closeAntigravitySettingsModal = closeAntigravitySettingsModal;
  g.saveAntigravitySettingsModal = saveAntigravitySettingsModal;
})(globalThis);
