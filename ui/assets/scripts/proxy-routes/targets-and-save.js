// proxy-routes/targets-and-save.js — 故障转移链目标编辑、备用模型选择与校验保存

function proxyRouteFormatLabel(value) {
  const fmt = normalizeProxyRouteFormat(value);
  if (fmt === 'anthropic') return 'Claude';
  if (fmt === 'openai') return 'OpenAI';
  if (fmt === 'gemini') return 'Gemini';
  return '自动';
}

function proxyRouteTargetRouteLabel(target) {
  const unlock = normalizeProxyRouteUnlock(target?.unlock);
  if (unlock === 'codex') return 'Codex 解锁';
  if (unlock === 'claudeCode') return 'Claude Code 解锁';
  return proxyRouteFormatLabel(target?.apiFormat);
}

function proxyRouteTargetCard(target, idx) {
  const isPrimary = idx === 0;
  const provider = proxyRouteProviderName(target.providerId);
  const model = target.model || '未填写模型';
  const format = proxyRouteTargetRouteLabel(target);
  return `
    <div class="proxy-route-chain-item ${isPrimary ? 'is-primary' : ''}">
      <div class="proxy-route-chain-index">${isPrimary ? '主' : idx}</div>
      <div class="proxy-route-chain-main">
        <strong>${proxyRouteEsc(provider)} / ${proxyRouteEsc(model)}</strong>
        <span>${proxyRouteEsc(format)}${isPrimary ? ' · 当前模型' : ' · 备用模型'}</span>
      </div>
      <div class="proxy-route-chain-actions">
        ${isPrimary ? '' : `
          <button type="button" class="btn-icon model-map-action-btn" data-action="moveProxyRouteTarget" data-args="[${idx},-1]" ${idx === 1 ? 'disabled' : ''} title="上移" aria-label="上移备用模型">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
          </button>
          <button type="button" class="btn-icon model-map-action-btn" data-action="moveProxyRouteTarget" data-args="[${idx},1]" ${idx === proxyRouteDraftTargets.length - 1 ? 'disabled' : ''} title="下移" aria-label="下移备用模型">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <button type="button" class="btn-icon model-map-action-btn danger" data-action="removeProxyRouteTarget" data-args="[${idx}]" title="移除" aria-label="移除备用模型">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </button>
        `}
      </div>
    </div>
  `;
}

function renderProxyRouteTargetsEditor() {
  const wrap = document.getElementById('proxyRouteTargetsEditor');
  if (!wrap) return;
  if (!proxyRouteDraftTargets.length) proxyRouteDraftTargets.push(normalizeProxyRouteTarget({}));
  const backups = proxyRouteDraftTargets
    .map((target, idx) => ({ target, idx }))
    .filter(item => item.idx > 0);
  const primary = proxyRouteDraftTargets[0] || normalizeProxyRouteTarget({});
  wrap.innerHTML = `
    <div class="proxy-route-chain-list">
      ${proxyRouteTargetCard(primary, 0)}
      ${backups.length
        ? backups.map(({ target, idx }) => proxyRouteTargetCard(target, idx)).join('')
        : '<div class="proxy-route-backup-empty">还没有备用模型。添加后会在主模型失败时按顺序尝试。</div>'}
    </div>
  `;
  syncProxyRouteEditorConfirmState();
}

function openProxyRouteBackupPicker() {
  proxyRouteBackupPickerOpen = true;
  const providers = proxyRouteBackupVisibleProviders();
  if (!providers.some(provider => provider.providerId === proxyRouteBackupSelectedProviderId)) {
    proxyRouteBackupSelectedProviderId = providers[0]?.providerId || proxyRouteProviderModels[0]?.providerId || '';
  }
  if (!proxyRouteBackupSelectedModelId) {
    const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
    proxyRouteBackupSelectedModelId = provider?.models?.[0]?.id || '';
  }
  renderProxyRouteBackupPicker();
  document.getElementById('proxy-route-backup-picker-modal')?.classList.add('active');
}

function closeProxyRouteBackupPicker() {
  proxyRouteBackupPickerOpen = false;
  document.getElementById('proxy-route-backup-picker-modal')?.classList.remove('active');
}

function onProxyRouteBackupProviderSearch() {
  proxyRouteBackupProviderSearch = document.getElementById('proxyRouteBackupProviderSearch')?.value || '';
  const providers = proxyRouteBackupVisibleProviders();
  if (!providers.some(provider => provider.providerId === proxyRouteBackupSelectedProviderId)) {
    proxyRouteBackupSelectedProviderId = providers[0]?.providerId || '';
    proxyRouteBackupSelectedModelId = '';
  }
  renderProxyRouteBackupPicker();
}

function selectProxyRouteBackupProvider(providerId) {
  proxyRouteBackupSelectedProviderId = String(providerId || '').trim();
  const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
  if (!provider?.models?.some(model => model.id === proxyRouteBackupSelectedModelId)) {
    proxyRouteBackupSelectedModelId = provider?.models?.[0]?.id || '';
  }
  renderProxyRouteBackupPicker();
}

function selectProxyRouteBackupModel(providerId, modelId) {
  proxyRouteBackupSelectedProviderId = String(providerId || '').trim();
  proxyRouteBackupSelectedModelId = String(modelId || '').trim();
  renderProxyRouteBackupPicker();
}

function proxyRouteTargetKey(target) {
  return `${target.providerId || ''}\n${target.model || ''}`;
}

function addSelectedProxyRouteBackupModel() {
  const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
  const model = proxyRouteProviderModel(proxyRouteBackupSelectedProviderId, proxyRouteBackupSelectedModelId);
  if (!provider || !model) return;
  const target = proxyRouteTargetWithDefaultUnlock({ providerId: provider.providerId, model: model.id, apiFormat: '' });
  const existing = new Set(proxyRouteDraftTargets.map(t => proxyRouteTargetKey(normalizeProxyRouteTarget(t))));
  if (existing.has(proxyRouteTargetKey(target))) {
    showBottomToast('该模型已在当前链路中', 'warn');
    return;
  }
  proxyRouteDraftTargets.push(target);
  proxyRouteBackupSelectedModelId = '';
  renderProxyRouteTargetsEditor();
  closeProxyRouteBackupPicker();
}

function renderProxyRouteBackupPicker() {
  const providerList = document.getElementById('proxyRouteBackupProviderList');
  const modelList = document.getElementById('proxyRouteBackupModelList');
  const title = document.getElementById('proxyRouteBackupProviderTitle');
  const sub = document.getElementById('proxyRouteBackupProviderSub');
  const confirm = document.getElementById('proxyRouteAddBackupConfirmBtn');
  if (!providerList || !modelList) return;
  const providers = proxyRouteBackupVisibleProviders();
  if (!providers.some(provider => provider.providerId === proxyRouteBackupSelectedProviderId)) {
    proxyRouteBackupSelectedProviderId = providers[0]?.providerId || '';
  }
  if (!providers.length) {
    providerList.innerHTML = `<div class="proxy-route-picker-empty">${proxyRouteProviderModels.length ? '没有匹配的供应商或模型' : '暂无可用供应商'}</div>`;
  } else {
    providerList.innerHTML = providers.map(provider => {
      const active = provider.providerId === proxyRouteBackupSelectedProviderId;
      const isLP = isLocalProxyProviderEntry(provider);
      return `
        <button type="button" class="proxy-route-provider-item ${active ? 'active' : ''} ${isLP ? 'is-local-proxy' : ''}" data-action="selectProxyRouteBackupProvider" data-arg="${proxyRouteEsc(provider.providerId)}">
          <span class="proxy-route-provider-icon">${proxyRouteEsc(proxyRouteProviderInitial(provider.providerName))}</span>
          <span class="proxy-route-provider-name">${proxyRouteEsc(provider.providerName || provider.providerId)}${isLP ? '<span class="proxy-route-prov-badge">内置供应商</span>' : ''}</span>
          <span class="proxy-route-provider-count">${Array.isArray(provider.models) ? provider.models.length : 0}</span>
        </button>
      `;
    }).join('');
  }
  const provider = proxyRouteProviderEntry(proxyRouteBackupSelectedProviderId);
  if (!provider) {
    if (title) title.textContent = '请选择供应商';
    if (sub) sub.textContent = '右侧选择要加入备用链路的模型';
    modelList.innerHTML = '<div class="proxy-route-picker-empty">先从左侧选择供应商</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!models.some(model => model.id === proxyRouteBackupSelectedModelId)) {
    proxyRouteBackupSelectedModelId = models[0]?.id || '';
  }
  if (title) title.textContent = provider.providerName || provider.providerId;
  if (sub) sub.textContent = `共 ${models.length} 个模型，选择后添加到备用链路`;
  if (!models.length) {
    modelList.innerHTML = '<div class="proxy-route-picker-empty">该供应商暂无模型</div>';
    if (confirm) confirm.disabled = true;
    return;
  }
  const existing = new Set(proxyRouteDraftTargets.map(t => proxyRouteTargetKey(normalizeProxyRouteTarget(t))));
  modelList.innerHTML = models.map(model => {
    const id = String(model?.id || '').trim();
    const targetKey = proxyRouteTargetKey(normalizeProxyRouteTarget({ providerId: provider.providerId, model: id }));
    const used = existing.has(targetKey);
    const active = id === proxyRouteBackupSelectedModelId;
    return `
      <button type="button" class="proxy-route-model-item ${active ? 'active' : ''} ${used ? 'is-disabled' : ''}"
        ${used ? 'disabled' : ''} data-action="selectProxyRouteBackupModel" data-args="[&quot;${proxyRouteEsc(provider.providerId)}&quot;,&quot;${proxyRouteEsc(id)}&quot;]">
        <span class="proxy-route-model-check">${active || used ? '&#10003;' : ''}</span>
        ${proxyRouteModelIcon(id)}
        <span class="proxy-route-model-name">
          <strong>${proxyRouteEsc(model?.name || id)}</strong>
          <small>${used ? '已在当前链路中' : '添加为备用模型'}</small>
        </span>
      </button>
    `;
  }).join('');
  if (confirm) {
    const selectedKey = proxyRouteTargetKey(normalizeProxyRouteTarget({ providerId: provider.providerId, model: proxyRouteBackupSelectedModelId }));
    confirm.disabled = !proxyRouteBackupSelectedModelId || existing.has(selectedKey);
  }
}

function updateProxyRouteTarget(index, field, value) {
  if (!proxyRouteDraftTargets[index]) return;
  proxyRouteDraftTargets[index][field] = field === 'apiFormat' ? normalizeProxyRouteFormat(value) : String(value || '').trim();
  if (field === 'providerId' || field === 'apiFormat' || field === 'model' || field === 'unlock') {
    // WithDefaultUnlock 尊重显式 unlock（手动优先），仅在未指定时按格式/模型名智能推导
    proxyRouteDraftTargets[index] = proxyRouteTargetWithDefaultUnlock(proxyRouteDraftTargets[index]);
  }
  // 手动输入模型名时，自动推断能力
  if (field === 'model' && index === 0) {
    const modelId = String(value || '').trim();
    const providerId = proxyRouteDraftTargets[0]?.providerId || '';
    const knownModel = proxyRouteProviderModel(providerId, modelId);
    if (knownModel) {
      if (document.getElementById('proxyRouteCapToolsInput')) document.getElementById('proxyRouteCapToolsInput').checked = knownModel.supportsToolCall === true;
      if (document.getElementById('proxyRouteCapVisionInput')) document.getElementById('proxyRouteCapVisionInput').checked = knownModel.supportsImages === true;
      if (document.getElementById('proxyRouteCapReasoningInput')) document.getElementById('proxyRouteCapReasoningInput').checked = knownModel.supportsReasoning === true;
    } else {
      const reasoningRe = /reason|thinking|r1|o\d|glm|claude|gpt-5/i;
      if (document.getElementById('proxyRouteCapReasoningInput')) document.getElementById('proxyRouteCapReasoningInput').checked = reasoningRe.test(modelId);
    }
  }
  if (index === 0) renderProxyRoutePrimaryTargetEditor();
  renderProxyRouteTargetsEditor();
  renderProxyRouteBackupPicker();
  syncProxyRouteEditorConfirmState();
}

function addProxyRouteTargetRow() {
  openProxyRouteBackupPicker();
}

function removeProxyRouteTarget(index) {
  proxyRouteDraftTargets.splice(index, 1);
  renderProxyRouteTargetsEditor();
  renderProxyRouteBackupPicker();
}

function moveProxyRouteTarget(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= proxyRouteDraftTargets.length) return;
  const item = proxyRouteDraftTargets[index];
  proxyRouteDraftTargets[index] = proxyRouteDraftTargets[next];
  proxyRouteDraftTargets[next] = item;
  renderProxyRouteTargetsEditor();
  renderProxyRouteBackupPicker();
}

async function saveProxyRouteEditor() {
  // 编辑模式：单条保存
  if (proxyRouteEditingId) {
    const id = String(document.getElementById('proxyRouteIdInput')?.value || '').trim();
    if (!id) {
      showCustomAlert('请填写模型 ID。', '保存失败', 'error');
      return;
    }
    if (proxyRoutesStore.routes.some(route => route.id === id && route.id !== proxyRouteEditingId)) {
      showCustomAlert(`模型已在列表中: ${id}`, '保存失败', 'error');
      return;
    }
    const exposedFormats = ['openai', 'anthropic', 'gemini'];
    const targets = proxyRouteDraftTargets.map(proxyRouteTargetWithDefaultUnlock).filter(t => t.providerId || t.model);
    if (!targets.length) {
      showCustomAlert('请填写上游目标。', '保存失败', 'error');
      return;
    }
    const invalid = targets.find(t => !t.providerId || !t.model);
    if (invalid) {
      showCustomAlert('每个上游目标都必须包含供应商和上游模型。API 格式可以留空自动识别。', '保存失败', 'error');
      return;
    }
    const existingRoute = proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId);
    const route = normalizeProxyRoute({
      id,
      displayName: id,
      idFromRenameRule: existingRoute?.idFromRenameRule === true,
      enabled: existingRoute?.enabled !== false,
      exposedFormats,
      source: proxyRoutesStore.routes.find(item => item.id === proxyRouteEditingId)?.source || 'manual',
      capabilities: {
        stream: document.getElementById('proxyRouteCapStreamInput')?.checked === true,
        tools: document.getElementById('proxyRouteCapToolsInput')?.checked === true,
        vision: document.getElementById('proxyRouteCapVisionInput')?.checked === true,
        reasoning: document.getElementById('proxyRouteCapReasoningInput')?.checked === true,
      },
      enhancement: {
        retry: document.getElementById('proxyRouteRetryInput')?.checked === true,
        autoRouting: document.getElementById('proxyRouteAutoRoutingInput')?.checked === true,
        thirdPartyVision: existingRoute?.enhancement?.thirdPartyVision === true,
        preserveExtraParams: document.getElementById('proxyRoutePreserveExtraParamsInput')?.checked === true,
        rawProviderErrors: document.getElementById('proxyRouteRawProviderErrorsInput')?.checked !== false,
      },
      targets,
    });
    const previous = cloneProxyRoutesStore();
    const btn = document.getElementById('proxyRouteEditorConfirmBtn');
    if (typeof setLoading === 'function') {
      setLoading(btn, '保存中…');
    } else if (btn) {
      btn.disabled = true;
    }
    try {
      const idx = proxyRoutesStore.routes.findIndex(item => item.id === proxyRouteEditingId);
      if (idx >= 0) proxyRoutesStore.routes[idx] = route;
      else proxyRoutesStore.routes.push(route);
      proxyRoutesStore.defaultModelId = '';
      const ok = await saveProxyRoutes({ silent: true });
      if (!ok) {
        proxyRoutesStore = normalizeProxyRoutesStore(previous);
        renderProxyRoutes();
        return;
      }
      closeProxyRouteEditor();
      showBottomToast('模型已保存', 'success');
    } finally {
      if (typeof clearLoading === 'function') clearLoading(btn);
      else if (btn) btn.disabled = false;
      syncProxyRouteEditorConfirmState();
    }
    return;
  }

  // 新建模式：多选批量保存
  if (totalPickedModelCount() === 0) {
    showCustomAlert('请至少勾选一个模型。', '保存失败', 'error');
    return;
  }
  const exposedFormats = ['openai', 'anthropic', 'gemini'];
  const capabilities = {
    stream: document.getElementById('proxyRouteCapStreamInput')?.checked === true,
    tools: document.getElementById('proxyRouteCapToolsInput')?.checked === true,
    vision: document.getElementById('proxyRouteCapVisionInput')?.checked === true,
    reasoning: document.getElementById('proxyRouteCapReasoningInput')?.checked === true,
  };
  const enhancement = {
    retry: document.getElementById('proxyRouteRetryInput')?.checked === true,
    autoRouting: document.getElementById('proxyRouteAutoRoutingInput')?.checked === true,
    thirdPartyVision: false,
    preserveExtraParams: document.getElementById('proxyRoutePreserveExtraParamsInput')?.checked === true,
    rawProviderErrors: document.getElementById('proxyRouteRawProviderErrorsInput')?.checked !== false,
  };
  const previous = cloneProxyRoutesStore();
  let added = 0;
  const skipReasons = [];
  proxyRoutePickedModels.forEach((bucket, providerId) => {
    bucket.forEach(modelId => {
      const model = proxyRouteProviderModel(providerId, modelId);
      if (!model) { skipReasons.push(`${modelId}：供应商模型列表里查不到`); return; }
      if (proxyRouteTargetAlreadyExists(providerId, modelId)) { skipReasons.push(`${modelId}：已在列表中`); return; }
      const idInfo = proxyRouteIdForNewModel(providerId, modelId);
      if (!idInfo.id) { skipReasons.push(`${modelId}：模型 ID 与现有条目冲突，且自动改名后仍冲突`); return; }
      const route = normalizeProxyRoute({
        id: idInfo.id,
        displayName: idInfo.id,
        idFromRenameRule: idInfo.idFromRenameRule,
        enabled: true,
        exposedFormats,
        source: 'manual',
        capabilities: {
          stream: capabilities.stream !== false,
          tools: model.supportsToolCall === true || capabilities.tools === true,
          vision: model.supportsImages === true || capabilities.vision === true,
          reasoning: model.supportsReasoning === true || capabilities.reasoning === true,
        },
        enhancement,
        targets: [proxyRouteTargetWithDefaultUnlock({ providerId, model: modelId, apiFormat: '' })],
      });
      proxyRoutesStore.routes.push(route);
      added++;
    });
  });
  proxyRoutesStore.defaultModelId = '';
  if (!added) {
    closeProxyRouteEditor();
    // 全选几十个模型时提示会很长，弹窗没有滚动条，截断点位避免确认按钮被顶出屏幕
    const shown = skipReasons.slice(0, 5).join('；');
    const rest = skipReasons.length > 5 ? `；……共 ${skipReasons.length} 个` : '';
    showCustomAlert(`没有添加任何模型：${shown}${rest}`, '添加结果', 'warn');
    return;
  }
  const btn = document.getElementById('proxyRouteEditorConfirmBtn');
  if (typeof setLoading === 'function') {
    setLoading(btn, '保存中…');
  } else if (btn) {
    btn.disabled = true;
  }
  try {
    const ok = await saveProxyRoutes({ silent: true });
    if (!ok) {
      proxyRoutesStore = normalizeProxyRoutesStore(previous);
      renderProxyRoutes();
      return;
    }
    closeProxyRouteEditor();
    showBottomToast(`已添加 ${added} 个模型${skipReasons.length ? `（跳过 ${skipReasons.length} 个：${skipReasons[0]}）` : ''}`, 'success');
  } finally {
    if (typeof clearLoading === 'function') clearLoading(btn);
    else if (btn) btn.disabled = false;
    syncProxyRouteEditorConfirmState();
  }
}

// ─── 批量重命名（模型 ID 命名规则）───
// 跟 Devin/Windsurf「显示名设置」思路一致:存规则(proxyRouteRenameRule),
// 老路由运行时套用规则。新增同名模型时如果原始 ID/别名已被占用,会把当前规则渲染成
// 一个最终 route.id 并标记 idFromRenameRule,避免同名供应商模型被跳过或后续二次拼接。

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.proxyRouteFormatLabel = proxyRouteFormatLabel;
  g.proxyRouteTargetRouteLabel = proxyRouteTargetRouteLabel;
  g.proxyRouteTargetCard = proxyRouteTargetCard;
  g.renderProxyRouteTargetsEditor = renderProxyRouteTargetsEditor;
  g.openProxyRouteBackupPicker = openProxyRouteBackupPicker;
  g.closeProxyRouteBackupPicker = closeProxyRouteBackupPicker;
  g.onProxyRouteBackupProviderSearch = onProxyRouteBackupProviderSearch;
  g.selectProxyRouteBackupProvider = selectProxyRouteBackupProvider;
  g.selectProxyRouteBackupModel = selectProxyRouteBackupModel;
  g.proxyRouteTargetKey = proxyRouteTargetKey;
  g.addSelectedProxyRouteBackupModel = addSelectedProxyRouteBackupModel;
  g.renderProxyRouteBackupPicker = renderProxyRouteBackupPicker;
  g.updateProxyRouteTarget = updateProxyRouteTarget;
  g.addProxyRouteTargetRow = addProxyRouteTargetRow;
  g.removeProxyRouteTarget = removeProxyRouteTarget;
  g.moveProxyRouteTarget = moveProxyRouteTarget;
  g.saveProxyRouteEditor = saveProxyRouteEditor;
})(globalThis);
