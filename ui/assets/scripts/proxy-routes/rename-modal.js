// proxy-routes/rename-modal.js — 模型名重写规则模板计算、冲突探测与弹窗控制

globalThis.proxyRouteRenameMode = 'simple'; // 'simple' | 'custom'
globalThis.PROXY_ROUTE_RENAME_TEMPLATE_VARS = ['prefix', 'model', 'provider', 'suffix'];

function renderProxyRouteRenameTemplate(tpl, vars) {
  // 多次扫描直到稳定,支持"占位符的值里再嵌占位符"的场景
  // (例如后缀填字面量 {provider},应在渲染时再展开成供应商名)
  let out = String(tpl == null ? '' : tpl);
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let prev = out;
    for (const k of PROXY_ROUTE_RENAME_TEMPLATE_VARS) {
      const re = new RegExp('\\{' + k + '\\}', 'g');
      out = out.replace(re, vars[k] == null ? '' : String(vars[k]));
    }
    if (out === prev) break;
  }
  return out;
}

/** 把 route.id 按命名规则渲染成"对外暴露的 ID"。规则为空或禁用时返回原始 id。*/
function proxyRouteRenderedId(route) {
  if (route?.idFromRenameRule === true || route?.id_from_rename_rule === true) return route.id;
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || null;
  if (!rule || typeof rule !== 'object') return route.id;
  // 规则被禁用 → 保持原始 ID,不拼接(用户明确要求"保持原有模型名")
  if (rule.enabled === false) return route.id;
  const prefix = String(rule.prefix || '');
  const suffix = String(rule.suffix || '');
  const mode = String(rule.mode || 'simple');
  const tpl = mode === 'custom' && rule.template ? String(rule.template) : proxyRouteRenameSimpleTemplate();
  if (!prefix && !suffix && (mode !== 'custom' || !rule.template)) return route.id;
  const providerId = proxyRouteRenameFirstProviderId(route);
  const providerName = providerId ? proxyRouteProviderName(providerId) : '';
  const rendered = renderProxyRouteRenameTemplate(tpl, { prefix, model: route.id, provider: providerName, suffix });
  return rendered || route.id;
}

function proxyRouteRenderedIdForModel(modelId, providerId) {
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || null;
  const rawId = String(modelId || '').trim();
  if (!rawId || !rule || typeof rule !== 'object' || rule.enabled === false) return rawId;
  const prefix = String(rule.prefix || '');
  const suffix = String(rule.suffix || '');
  const mode = String(rule.mode || 'simple');
  const tpl = mode === 'custom' && rule.template ? String(rule.template) : proxyRouteRenameSimpleTemplate();
  if (!prefix && !suffix && (mode !== 'custom' || !rule.template)) return rawId;
  const providerName = providerId ? proxyRouteProviderName(providerId) : '';
  const rendered = renderProxyRouteRenameTemplate(tpl, { prefix, model: rawId, provider: providerName, suffix });
  return String(rendered || rawId).trim();
}

function proxyRouteRenameRuleEnabled() {
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || null;
  return !rule || typeof rule !== 'object' || rule.enabled !== false;
}

function proxyRouteConflictFallbackId(modelId, providerId) {
  const rawId = String(modelId || '').trim();
  if (!rawId) return '';
  const providerName = providerId ? proxyRouteProviderName(providerId) : '';
  return renderProxyRouteRenameTemplate('{model}({provider})', {
    prefix: '',
    model: rawId,
    provider: providerName,
    suffix: '',
  }).trim();
}

function proxyRouteIdForNewModel(providerId, modelId) {
  const rawId = String(modelId || '').trim();
  if (!rawId) return { id: '', idFromRenameRule: false };
  if (!proxyRouteAliasExists(rawId)) return { id: rawId, idFromRenameRule: false };
  let renderedId = proxyRouteRenderedIdForModel(rawId, providerId);
  // 规则启用但尚未配置前缀/后缀时，同名模型默认用 model(provider) 落盘，避免直接跳过。
  if (renderedId === rawId && proxyRouteRenameRuleEnabled()) {
    renderedId = proxyRouteConflictFallbackId(rawId, providerId);
  }
  if (renderedId && renderedId !== rawId && !proxyRouteAliasExists(renderedId)) {
    return { id: renderedId, idFromRenameRule: true };
  }
  return { id: '', idFromRenameRule: false };
}

function proxyRouteRenameSimpleTemplate(prefix, suffix) {
  return `{prefix}{model}{suffix}`;
}

function currentProxyRouteRenameTemplate() {
  if (proxyRouteRenameMode === 'custom') {
    const tplInput = document.getElementById('proxyRouteRenameTemplate');
    return tplInput ? tplInput.value : '';
  }
  return proxyRouteRenameSimpleTemplate();
}

function proxyRouteRenameFirstProviderId(route) {
  if (!route || !Array.isArray(route.targets) || !route.targets.length) return '';
  const first = route.targets.find(t => t && (t.providerId || t.model));
  return String(first?.providerId || '').trim();
}

function computeProxyRouteRenames() {
  // 规则驱动(跟 Devin 显示名设置一样):不改 route.id,只算"如果套规则后的显示 ID"
  const routes = Array.isArray(proxyRoutesStore.routes) ? proxyRoutesStore.routes : [];
  const tpl = currentProxyRouteRenameTemplate();
  const prefixInput = document.getElementById('proxyRouteRenamePrefix');
  const suffixInput = document.getElementById('proxyRouteRenameSuffix');
  const prefix = prefixInput ? prefixInput.value : '';
  const suffix = suffixInput ? suffixInput.value : '';
  const list = routes.map((route) => {
    const providerId = proxyRouteRenameFirstProviderId(route);
    const providerName = providerId ? proxyRouteProviderName(providerId) : '';
    const newIdRaw = route.idFromRenameRule === true
      ? route.id
      : renderProxyRouteRenameTemplate(tpl, {
        prefix,
        model: route.id,
        provider: providerName,
        suffix,
      });
    const newId = String(newIdRaw == null ? '' : newIdRaw).trim();
    const unchanged = newId === route.id;
    // 检测渲染后 ID 重复(两条 route 套规则后变成同一个新 ID)
    return {
      oldId: route.id,
      newId,
      aliases: newId && newId !== route.id ? [route.id, newId] : [route.id],
      route,
      providerName,
      unchanged,
    };
  });
  // 重复检测:运行时同时接受原始 ID 和渲染后 ID，任一别名跨模型碰撞都必须阻止保存。
  const aliasOwners = new Map();
  list.forEach(item => {
    item.aliases.forEach(alias => {
      if (!alias) return;
      if (!aliasOwners.has(alias)) aliasOwners.set(alias, new Set());
      aliasOwners.get(alias).add(item.oldId);
    });
  });
  list.forEach(item => {
    item.duplicate = item.aliases.some(alias => alias && (aliasOwners.get(alias)?.size || 0) > 1);
  });
  return { list, tpl, prefix, suffix };
}

function renderProxyRouteRenamePreview() {
  const preview = document.getElementById('proxyRouteRenamePreview');
  const errorEl = document.getElementById('proxyRouteRenameError');
  const statsEl = document.getElementById('proxyRouteRenameStats');
  const saveBtn = document.getElementById('proxyRouteRenameSaveBtn');
  if (!preview) return;
  const { list } = computeProxyRouteRenames();
  const total = list.length;
  const changed = list.filter(i => !i.unchanged && i.newId);
  const unchanged = list.filter(i => i.unchanged).length;
  const duplicates = list.filter(i => i.duplicate);
  if (statsEl) {
    statsEl.textContent = total
      ? `共 ${total} 个 · 显示改名 ${changed.length} · 不变 ${unchanged}`
      : '暂无模型';
  }
  if (saveBtn) {
    saveBtn.disabled = duplicates.length > 0;
    saveBtn.title = duplicates.length
      ? '暴露模型 ID 存在冲突，需调整规则后才能保存'
      : changed.length
      ? `将保存规则,对外暴露 ${changed.length} 个改名后的 ID`
      : '规则无变化,保存即生效';
  }
  if (errorEl) {
    if (duplicates.length) {
      errorEl.style.display = '';
      errorEl.textContent = `有 ${duplicates.length} 个模型的原始 ID 或显示 ID 发生冲突。为避免客户端请求误路由，请调整规则后再保存。`;
    } else {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }
  }
  if (!total) {
    preview.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:6px 4px;">内置模型列表为空。先在「模型列表」里添加几个模型再批量命名。</div>`;
    return;
  }
  const rows = list.map((item) => {
    const oldHtml = `<span style="color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${proxyRouteEsc(item.oldId)}">${proxyRouteEsc(item.oldId)}</span>`;
    let newHtml;
    let rowStyle = '';
    let badge = '';
    if (item.duplicate) {
      rowStyle = 'background:rgba(220,80,80,0.10);border:1px solid rgba(220,80,80,0.4);';
      newHtml = `<span style="color:#c44;font-weight:700;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${proxyRouteEsc(item.newId)}">${proxyRouteEsc(item.newId)}</span>`;
      badge = '<span style="color:#c44;font-size:12px;margin-left:6px;">⚠ ID 重复</span>';
    } else if (item.unchanged) {
      rowStyle = 'opacity:0.55;';
      newHtml = `<span style="color:var(--text-muted);font-family:var(--font-mono);">(不变)</span>`;
    } else {
      newHtml = `<span style="color:var(--text-primary);font-weight:700;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${proxyRouteEsc(item.newId)}">${proxyRouteEsc(item.newId)}</span>`;
    }
    return `<div style="display:grid;grid-template-columns:minmax(140px,1.1fr) 16px minmax(180px,1.4fr) auto;gap:8px;align-items:center;line-height:1.5;min-width:0;padding:4px 6px;border-radius:6px;${rowStyle}">
      ${oldHtml}
      <span style="color:var(--text-muted);text-align:center;">→</span>
      ${newHtml}
      ${badge}
    </div>`;
  }).join('');
  preview.innerHTML = rows;
}

function openProxyRouteRenameModal() {
  const modal = document.getElementById('proxyRouteRenameModal');
  if (!modal) return;
  const prefixInput = document.getElementById('proxyRouteRenamePrefix');
  const suffixInput = document.getElementById('proxyRouteRenameSuffix');
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  const advanced = document.getElementById('proxyRouteRenameAdvanced');
  const enabledInput = document.getElementById('proxyRouteRenameEnabled');
  // 从持久化的规则回填(避免每次打开都得重新输入,导致规则叠加)
  const rule = (typeof modelMapStore !== 'undefined' && modelMapStore && modelMapStore.proxyRouteRenameRule) || {};
  const savedMode = String(rule.mode || 'simple');
  const savedPrefix = String(rule.prefix || '');
  const savedSuffix = String(rule.suffix || '');
  const savedTpl = String(rule.template || '');
  if (prefixInput) prefixInput.value = savedPrefix;
  if (suffixInput) suffixInput.value = savedSuffix;
  if (tplInput) tplInput.value = savedTpl || proxyRouteRenameSimpleTemplate();
  if (enabledInput) enabledInput.checked = rule.enabled !== false;
  proxyRouteRenameMode = savedMode === 'custom' ? 'custom' : 'simple';
  if (advanced) advanced.open = proxyRouteRenameMode === 'custom';
  renderProxyRouteRenamePreview();
  modal.classList.add('is-open');
  setTimeout(() => {
    // 简单模式聚焦前缀;高级模式聚焦模板
    (proxyRouteRenameMode === 'custom' ? tplInput : prefixInput)?.focus();
  }, 30);
}

function closeProxyRouteRenameModal() {
  const modal = document.getElementById('proxyRouteRenameModal');
  if (modal) modal.classList.remove('is-open');
}

/** 命名规则弹窗里的「启用规则」开关:与添加模型弹窗共享同一个 enabled,onchange 立即持久化(同步到添加弹窗的复选框)。*/
async function onProxyRouteRenameEnabledChange() {
  const input = document.getElementById('proxyRouteRenameEnabled');
  if (!input || !modelMapStore) return;
  if (!modelMapStore.proxyRouteRenameRule || typeof modelMapStore.proxyRouteRenameRule !== 'object') {
    modelMapStore.proxyRouteRenameRule = { enabled: true, mode: '', prefix: '', suffix: '', template: '' };
  }
  modelMapStore.proxyRouteRenameRule.enabled = !!input.checked;
  // 同步到添加模型弹窗的复选框(下次打开时会再读,这里手动改 DOM 立即生效)
  const addInput = document.getElementById('proxyRouteEditorRenameApply');
  if (addInput) addInput.checked = !!input.checked;
  if (typeof persistModelMap === 'function') {
    const ok = await persistModelMap();
    if (!ok) addLog('err', '保存规则状态失败');
  }
  // 同步刷新模型列表
  renderProxyRoutes();
}

function onProxyRouteRenameInput() {
  // 简单模式:用户改了前缀/后缀 → 切回 simple 模式 + 同步模板字段
  proxyRouteRenameMode = 'simple';
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  if (tplInput) tplInput.value = proxyRouteRenameSimpleTemplate();
  const advanced = document.getElementById('proxyRouteRenameAdvanced');
  if (advanced) advanced.open = false;
  renderProxyRouteRenamePreview();
}

function onProxyRouteRenameTemplateInput() {
  // 高级模式:用户改模板 → 切到 custom 模式,前缀/后缀暂时失效
  proxyRouteRenameMode = 'custom';
  renderProxyRouteRenamePreview();
}

function onProxyRouteRenameAdvancedToggle() {
  const advanced = document.getElementById('proxyRouteRenameAdvanced');
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  if (advanced && advanced.open) {
    // 展开时把当前 effective 模板填入
    if (tplInput) tplInput.value = currentProxyRouteRenameTemplate();
    proxyRouteRenameMode = 'custom';
  } else if (advanced && !advanced.open && proxyRouteRenameMode === 'custom') {
    // 收起时切回 simple,同步一份默认模板到 input(避免下次展开拿到旧值)
    if (tplInput) tplInput.value = proxyRouteRenameSimpleTemplate();
    proxyRouteRenameMode = 'simple';
  }
  renderProxyRouteRenamePreview();
}

async function saveProxyRouteRenameFromModal() {
  const saveBtn = document.getElementById('proxyRouteRenameSaveBtn');
  if (saveBtn?.disabled) return;
  const prefixInput = document.getElementById('proxyRouteRenamePrefix');
  const suffixInput = document.getElementById('proxyRouteRenameSuffix');
  const tplInput = document.getElementById('proxyRouteRenameTemplate');
  const enabledInput = document.getElementById('proxyRouteRenameEnabled');
  const currentRule = {
    enabled: enabledInput ? !!enabledInput.checked : true,
    mode: proxyRouteRenameMode,
    prefix: prefixInput ? prefixInput.value : '',
    suffix: suffixInput ? suffixInput.value : '',
    template: tplInput ? tplInput.value : '',
  };
  // 只保存规则(不硬写 route.id,跟 Devin 显示名设置一样)
  // 改规则 = 改模板,旧模板立即失效,新模板立即生效,永远不叠加
  if (modelMapStore) {
    modelMapStore.proxyRouteRenameRule = currentRule;
    if (typeof persistModelMap === 'function') {
      const ok = await persistModelMap();
      if (!ok) {
        showCustomAlert('保存命名规则失败', '保存失败', 'error');
        return;
      }
    }
  }
  addLog('ok', '已保存内置模型命名规则');
  showBottomToast('命名规则已保存', 'success');
  closeProxyRouteRenameModal();
  // 刷新模型列表(渲染时套用规则显示改名后的 ID)
  renderProxyRoutes();
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.renderProxyRouteRenameTemplate = renderProxyRouteRenameTemplate;
  g.proxyRouteRenderedId = proxyRouteRenderedId;
  g.proxyRouteRenderedIdForModel = proxyRouteRenderedIdForModel;
  g.proxyRouteRenameRuleEnabled = proxyRouteRenameRuleEnabled;
  g.proxyRouteConflictFallbackId = proxyRouteConflictFallbackId;
  g.proxyRouteIdForNewModel = proxyRouteIdForNewModel;
  g.proxyRouteRenameSimpleTemplate = proxyRouteRenameSimpleTemplate;
  g.currentProxyRouteRenameTemplate = currentProxyRouteRenameTemplate;
  g.proxyRouteRenameFirstProviderId = proxyRouteRenameFirstProviderId;
  g.computeProxyRouteRenames = computeProxyRouteRenames;
  g.renderProxyRouteRenamePreview = renderProxyRouteRenamePreview;
  g.openProxyRouteRenameModal = openProxyRouteRenameModal;
  g.closeProxyRouteRenameModal = closeProxyRouteRenameModal;
  g.onProxyRouteRenameEnabledChange = onProxyRouteRenameEnabledChange;
  g.onProxyRouteRenameInput = onProxyRouteRenameInput;
  g.onProxyRouteRenameTemplateInput = onProxyRouteRenameTemplateInput;
  g.onProxyRouteRenameAdvancedToggle = onProxyRouteRenameAdvancedToggle;
  g.saveProxyRouteRenameFromModal = saveProxyRouteRenameFromModal;
})(globalThis);
