// model-map/failover-modal.js — 多目标故障转移管线链路编辑器与保存
import { escapeHtml, escAttr } from '../ui/dom.js';

// ─── 故障转移配置模态框 ───
globalThis.failoverEditUid = '';
globalThis.failoverDraft = [];   // [{providerId, model, apiFormat?, unlock?}]

function enabledProviders() {
  return (providerStore.providers || []).filter(p => p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p));
}

function routeLabelForValue(value) {
  if (!value || value === AUTO_ROUTE_VALUE) return '自动';
  const unlock = normalizeMappingUnlock(value);
  if (unlock === 'codex') return 'Codex 解锁';
  if (unlock === 'claudeCode') return 'Claude Code 解锁';
  const fmt = normalizeMappingApiFormat(value);
  if (fmt === 'openai') return 'OpenAI';
  if (fmt === 'anthropic') return 'Anthropic';
  if (fmt === 'gemini') return 'Gemini';
  return value || '未设置协议';
}

function targetRouteOptionsForProvider(provider, currentValue) {
  const values = [];
  const add = value => {
    if (value && !values.includes(value)) values.push(value);
  };
  add(AUTO_ROUTE_VALUE);
  if (mappingProviderUnlockEnabled(provider, 'codex')) add('codex');
  if (mappingProviderUnlockEnabled(provider, 'claudeCode')) add('claudeCode');
  add('openai');
  add('anthropic');
  add('gemini');
  add(currentValue === AUTO_ROUTE_VALUE ? AUTO_ROUTE_VALUE : (normalizeMappingUnlock(currentValue) || normalizeMappingApiFormat(currentValue)));
  return values.map(value => ({ value, label: routeLabelForValue(value) }));
}

function openFailoverEditor(uid) {
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!s) return;
  failoverEditUid = uid;
  failoverDraft = targetsWithSlotRoute(s.targets, uid);
  document.getElementById('failoverModalSlot').textContent = s.displayName || originalNameOf(uid);
  renderFailoverRows();
  const modal = document.getElementById('failoverModal');
  if (modal) modal.classList.add('is-open');
}

let activeFoDropdown = null; // 当前展开的下拉框标识: `${key}_${idx}`
const foDropdownSearchMap = {};

function closeAllFoDropdowns() {
  if (activeFoDropdown) {
    activeFoDropdown = null;
    renderFailoverRows();
  }
}

// 全局监听点击外部区域关闭下拉菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('.fo-dropdown')) {
    closeAllFoDropdowns();
  }
});

function toggleFoDropdown(idx, key, e) {
  if (e) e.stopPropagation();
  const targetId = `${key}_${idx}`;
  activeFoDropdown = (activeFoDropdown === targetId) ? null : targetId;
  renderFailoverRows();
  if (activeFoDropdown) {
    // 每次打开都从全新搜索状态开始，避免残留关键字过滤出"假空列表"
    delete foDropdownSearchMap[targetId];
    setTimeout(() => {
      const el = document.querySelector(`.fo-dropdown[data-fo-id="${targetId}"]`);
      const menu = el ? el.querySelector('.fo-dropdown-menu') : null;
      const body = document.querySelector('.failover-modal-body');
      if (menu && body) {
        const menuRect = menu.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        // 如果下拉菜单被 body 底部裁剪，自动平滑向下滚动顶出菜单
        if (menuRect.bottom > bodyRect.bottom - 12) {
          body.scrollBy({ top: menuRect.bottom - bodyRect.bottom + 24, behavior: 'smooth' });
        }
      }
      if (el) {
        const searchInput = el.querySelector('.fo-dropdown-search-input');
        if (searchInput) searchInput.focus();
      }
    }, 30);
  }
}

function selectFoDropdownItem(idx, key, val) {
  activeFoDropdown = null;
  delete foDropdownSearchMap[`${key}_${idx}`];
  updateFailoverRow(idx, key, val);
}

function filterFoDropdown(idx, key, text) {
  const targetId = `${key}_${idx}`;
  foDropdownSearchMap[targetId] = (text || '').toLowerCase().trim();
  const listEl = document.querySelector(`.fo-dropdown[data-fo-id="${targetId}"] .fo-dropdown-list`);
  if (!listEl) return;
  const keyword = foDropdownSearchMap[targetId];
  const items = listEl.querySelectorAll('.fo-dropdown-item');
  items.forEach(el => {
    const label = (el.getAttribute('data-item-label') || '').toLowerCase();
    if (!keyword || label.includes(keyword)) {
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  });
}

function renderFoDropdown(idx, key, currentValue, options, isMini, hasSearch, placeholder) {
  const targetId = `${key}_${idx}`;
  const isOpen = activeFoDropdown === targetId;
  const selectedOpt = options.find(o => String(o.value) === String(currentValue));
  const displayText = selectedOpt ? selectedOpt.label : (currentValue || placeholder || '请选择');
  const searchVal = foDropdownSearchMap[targetId] || '';

  const itemsHtml = options.map(opt => {
    const isSelected = String(opt.value) === String(currentValue);
    if (opt.isCustom) {
      return `
        <div class="fo-item-custom-btn" data-action="selectFoDropdownItem" data-args="[${idx},&quot;${key}&quot;,&quot;__custom__&quot;]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>${escAttr(opt.label)}</span>
        </div>
      `;
    }
    const isMatch = !searchVal || opt.label.toLowerCase().includes(searchVal);
    return `
      <div class="fo-dropdown-item ${isSelected ? 'is-selected' : ''}" style="${isMatch ? 'display:flex;' : 'display:none;'}" data-item-label="${escAttr(opt.label)}" data-action="selectFoDropdownItem" data-args="[${idx},&quot;${key}&quot;,&quot;${escAttr(opt.value)}&quot;]">
        <span class="fo-item-label">${escAttr(opt.label)}</span>
        ${isSelected ? `<svg class="fo-item-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="fo-dropdown ${isMini ? 'is-mini' : ''} ${isOpen ? 'is-open' : ''}" data-fo-id="${targetId}">
      <button type="button" class="fo-dropdown-trigger" data-action="toggleFoDropdown" data-args="[${idx},&quot;${key}&quot;]">
        <span class="fo-dropdown-value" title="${escAttr(displayText)}">${escAttr(displayText)}</span>
        <svg class="fo-dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="fo-dropdown-menu" style="${isOpen ? 'display:flex;' : 'display:none;'}">
        ${hasSearch ? `
          <div class="fo-dropdown-search">
            <input type="text" class="fo-dropdown-search-input" placeholder="搜索选项..." value="${escAttr(searchVal)}" data-action="filterFoDropdown" data-events="input" data-args="[${idx},&quot;${key}&quot;]" data-pass-value autocomplete="off" />
          </div>
        ` : ''}
        <div class="fo-dropdown-list">
          ${itemsHtml}
        </div>
      </div>
    </div>
  `;
}

function closeFailoverEditor() {
  activeFoDropdown = null;
  Object.keys(foDropdownSearchMap).forEach(k => delete foDropdownSearchMap[k]);
  const modal = document.getElementById('failoverModal');
  if (modal) modal.classList.remove('is-open');
}

function closeFailoverEditorOnBackdrop(e) {
  if (e && e.target && e.target.id === 'failoverModal') {
    closeFailoverEditor();
  }
}

function renderFailoverRows() {
  const wrap = document.getElementById('failoverRows');
  const empty = document.getElementById('failoverEmpty');
  if (!wrap) return;
  const provs = enabledProviders();
  if (empty) empty.style.display = failoverDraft.length ? 'none' : 'block';

  wrap.innerHTML = failoverDraft.map((row, i) => {
    const isPrimary = i === 0;

    // 供应商选项构建
    const provOpts = provs.map(p => ({ value: p.id, label: p.name }));
    const cur = provs.find(p => p.id === row.providerId);
    if (!cur && row.providerId) {
      provOpts.unshift({ value: row.providerId, label: `（已失效）${row.providerId}` });
    }

    // 模型列表构建
    const modelsOfProv = [];
    if (cur) {
      if (Array.isArray(cur.models) && cur.models.length > 0) {
        modelsOfProv.push(...cur.models);
      } else if (cur.defaultModel) {
        modelsOfProv.push(cur.defaultModel);
      }
    }
    if (row.model && !modelsOfProv.includes(row.model)) {
      modelsOfProv.push(row.model);
    }

    const modelOpts = [
      { value: '', label: '默认模型' },
      ...modelsOfProv.map(m => ({ value: m, label: m })),
      { value: '__custom__', label: '+ 输入自定义模型...', isCustom: true }
    ];

    const badgesHtml = cur
      ? capabilityBadges(cur, true, row.model || cur.defaultModel || null)
      : '';
    const routeValue = targetRouteValue(row, failoverEditUid);
    const routeOpts = targetRouteOptionsForProvider(cur, routeValue).map(opt => ({ value: opt.value, label: opt.label }));
    const effortValue = String(row.thinkingEffort || 'auto').toLowerCase();
    const effortOpts = THINKING_EFFORT_OPTIONS.map(([v, l]) => ({ value: v, label: l }));

    const connectorHtml = i > 0
      ? `<div class="failover-pipeline-connector">
          <span class="failover-connector-pill">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
            前序失败则降级
          </span>
        </div>`
      : '';

    const badgeClass = isPrimary ? 'is-primary' : 'is-backup';
    const badgeText = isPrimary ? '首选主目标' : `备用降级 ${i}`;
    const hintText = isPrimary ? '请求优先由此目标承接' : '仅在前面的目标异常或不可用时自动激活';

    const provDropdownHtml = renderFoDropdown(i, 'providerId', row.providerId, provOpts, false, provOpts.length > 7, '选择供应商');
    const modelDropdownHtml = renderFoDropdown(i, 'model', row.model, modelOpts, false, modelOpts.length > 5, '默认模型');
    const routeDropdownHtml = renderFoDropdown(i, 'route', routeValue, routeOpts, true, false, '自动');
    const effortDropdownHtml = renderFoDropdown(i, 'thinkingEffort', effortValue, effortOpts, true, false, '自动');

    return `
      ${connectorHtml}
      <div class="failover-pipeline-node ${isPrimary ? 'is-primary' : ''}" data-fo-idx="${i}">
        <!-- 头部元信息与操作按钮 -->
        <div class="failover-node-header">
          <div class="failover-node-tag-group">
            <span class="failover-node-badge ${badgeClass}">
              <span>${i + 1}</span>
              <span>${badgeText}</span>
            </span>
            <span class="failover-node-hint">${hintText}</span>
          </div>
          <div class="failover-node-actions">
            <button type="button" class="failover-action-btn" title="上移优先级" data-action="moveFailoverRow" data-args="[${i},-1]" ${i === 0 ? 'disabled' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
            <button type="button" class="failover-action-btn" title="下移优先级" data-action="moveFailoverRow" data-args="[${i},1]" ${i === failoverDraft.length - 1 ? 'disabled' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
            </button>
            <button type="button" class="failover-action-btn danger" title="删除此目标" data-action="removeFailoverRow" data-args="[${i}]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>

        <!-- 核心流向行：供应商 ➔ 目标模型 -->
        <div class="failover-node-main-row">
          <div class="failover-field-item field-prov">
            <span class="failover-field-label">供应商</span>
            ${provDropdownHtml}
          </div>
          <div class="failover-arrow-separator">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
          </div>
          <div class="failover-field-item field-model">
            <span class="failover-field-label">目标模型</span>
            ${modelDropdownHtml}
          </div>
        </div>

        <!-- 辅助参数与能力特性行 -->
        <div class="failover-node-sub-row">
          <div class="failover-sub-controls">
            <div class="failover-mini-field">
              <span class="failover-mini-label">协议</span>
              ${routeDropdownHtml}
            </div>
            <div class="failover-mini-field">
              <span class="failover-mini-label">思考</span>
              ${effortDropdownHtml}
            </div>
          </div>
          ${badgesHtml ? `<div class="failover-caps-inline">${badgesHtml}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function addFailoverRow() {
  const provs = enabledProviders();
  const def = provs[0];
  failoverDraft.push(targetWithPreferredRoute({ providerId: def ? def.id : '', model: def ? (def.defaultModel || '') : '' }, failoverEditUid));
  renderFailoverRows();
}

function updateFailoverRow(idx, key, val) {
  if (!failoverDraft[idx]) return;

  if (key === 'route') {
    applyRouteToTarget(failoverDraft[idx], val);
    renderFailoverRows();
    return;
  }

  if (key === 'model' && val === '__custom__') {
    const oldVal = failoverDraft[idx].model;
    setTimeout(async () => {
      const customVal = await showCustomPrompt('请输入自定义模型 ID：', oldVal, '自定义模型');
      if (customVal && customVal.trim()) {
        failoverDraft[idx].model = customVal.trim();
      } else if (customVal === '') {
        failoverDraft[idx].model = '';
      } else {
        failoverDraft[idx].model = oldVal;
      }
      renderFailoverRows();
    }, 50);
    return;
  }

  failoverDraft[idx][key] = val;
  // 切换供应商时，智能填充模型并更新渲染
  if (key === 'providerId') {
    const p = (providerStore.providers || []).find(x => x.id === val);
    if (p) {
      applyRouteToTarget(failoverDraft[idx], preferredRouteForSlotTarget(failoverEditUid, val));
      const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : (p.defaultModel ? [p.defaultModel] : []);
      // 如果当前模型不在新供应商的可用模型中，则自动切换到新供应商的默认/首个模型
      if (!failoverDraft[idx].model || !models.includes(failoverDraft[idx].model)) {
        failoverDraft[idx].model = p.defaultModel || (models[0] || '');
      }
    } else {
      failoverDraft[idx].model = '';
    }
  }
  renderFailoverRows();
}

function moveFailoverRow(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= failoverDraft.length) return;
  const tmp = failoverDraft[idx];
  failoverDraft[idx] = failoverDraft[j];
  failoverDraft[j] = tmp;
  renderFailoverRows();
}

function removeFailoverRow(idx) {
  failoverDraft.splice(idx, 1);
  renderFailoverRows();
}

async function saveFailoverFromEditor() {
  const s = modelMapStore.slots.find(x => x.modelUid === failoverEditUid);
  if (!s) { closeFailoverEditor(); return; }
  const cleaned = failoverDraft
    .filter(r => r.providerId)
    .map(r => targetWithSlotRoute(r, failoverEditUid));
  const prev = s.targets;
  s.targets = cleaned;
  if (await persistModelMap()) {
    closeFailoverEditor();
    await renderModelMap();
    addLog('ok', '已保存故障转移配置');
  } else {
    s.targets = prev;
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.enabledProviders = enabledProviders;
  g.routeLabelForValue = routeLabelForValue;
  g.targetRouteOptionsForProvider = targetRouteOptionsForProvider;
  g.openFailoverEditor = openFailoverEditor;
  g.toggleFoDropdown = toggleFoDropdown;
  g.selectFoDropdownItem = selectFoDropdownItem;
  g.filterFoDropdown = filterFoDropdown;
  g.closeFailoverEditor = closeFailoverEditor;
  g.closeFailoverEditorOnBackdrop = closeFailoverEditorOnBackdrop;
  g.renderFailoverRows = renderFailoverRows;
  g.addFailoverRow = addFailoverRow;
  g.updateFailoverRow = updateFailoverRow;
  g.moveFailoverRow = moveFailoverRow;
  g.removeFailoverRow = removeFailoverRow;
  g.saveFailoverFromEditor = saveFailoverFromEditor;
})(globalThis);
