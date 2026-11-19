// claude-desktop/role-selects.js — 角色下拉菜单、1M 上下文切换与模型排序
import { getClaudeDesktopModelCandidates, getClaudeDesktopConfigs, ensureDefaultClaudeDesktopConfig, getRouteLabel, escapeHtml } from './console.js';

export function getProviderModelList(provider) {
  if (!provider) return [];
  const sortFn = typeof globalThis.sortRoleSelectItems === 'function' ? globalThis.sortRoleSelectItems : (list) => list;
  if (provider.isLocalProxy || provider.meta?.localProxy || provider.id === 'local-proxy' || provider.id === 'anybridge' || provider.name === 'AnyBridge') {
    const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
    const list = routes.map(r => stripClaudeDesktop1mMarker(r.id)).filter(Boolean);
    return sortFn(list, 'claude');
  }
  const set = new Set();
  if (provider.defaultModel && String(provider.defaultModel).trim()) {
    set.add(stripClaudeDesktop1mMarker(provider.defaultModel));
  }
  if (Array.isArray(provider.models)) {
    provider.models.forEach(m => {
      const id = typeof m === 'string' ? m.trim() : (m?.id || m?.model || '').trim();
      const clean = stripClaudeDesktop1mMarker(id);
      if (clean) set.add(clean);
    });
  }
  if (Array.isArray(provider.modelCatalog)) {
    provider.modelCatalog.forEach(m => {
      const id = (m?.model || m?.id || '').trim();
      const clean = stripClaudeDesktop1mMarker(id);
      if (clean) set.add(clean);
    });
  }
  return sortFn(Array.from(set), 'claude');
}

export function pickBestModelForRole(roleKey, modelList, defaultModel = '') {
  if (!modelList || modelList.length === 0) return defaultModel || '';
  const lowerList = modelList.map(m => ({ raw: m, lower: stripClaudeDesktop1mMarker(m).toLowerCase() }));

  let matchPatterns = [];
  if (roleKey === 'sonnetModel') {
    matchPatterns = ['sonnet', 'k2', 'glm-5', 'glm', 'v3', 'v4', 'plus', 'pro', 'flash', 'chat'];
  } else if (roleKey === 'opusModel') {
    matchPatterns = ['opus', 'r1', 'deepseek', 'o1', 'o3', 'max', 'high', 'pro', 'reasoning'];
  } else if (roleKey === 'haikuModel') {
    matchPatterns = ['haiku', 'mini', 'flash', 'fast', 'turbo', 'lite', 'speed'];
  } else if (roleKey === 'fableModel') {
    matchPatterns = ['fable'];
  }

  for (const pat of matchPatterns) {
    const found = lowerList.find(item => item.lower.includes(pat));
    if (found) return found.raw;
  }

  if (defaultModel && modelList.includes(defaultModel)) return defaultModel;
  return roleKey === 'fableModel' ? '' : (modelList[0] || '');
}

export function hasClaudeDesktop1mMarker(val) {
  return /\[1m\]$/i.test(String(val || '').trim());
}

export function stripClaudeDesktop1mMarker(val) {
  return String(val || '').trim().replace(/\[1m\]$/i, '').trim();
}

export function applyClaudeDesktop1mMarker(val, enabled) {
  const base = stripClaudeDesktop1mMarker(val);
  if (!base) return '';
  return enabled ? `${base}[1m]` : base;
}

export function getClaudeDesktop1m(role) {
  const cb = document.getElementById(`claude-desktop-1m-${role}`);
  return !!cb?.checked;
}

export function setClaudeDesktop1m(role, checked) {
  const cb = document.getElementById(`claude-desktop-1m-${role}`);
  if (cb) cb.checked = !!checked;
  const box = document.getElementById(`claude-desktop-1m-box-${role}`);
  if (box) box.classList.toggle('active', !!checked);
}

function onClaudeDesktop1mChange(role, checked) {
  const box = document.getElementById(`claude-desktop-1m-box-${role}`);
  if (box) box.classList.toggle('active', !!checked);
  syncClaudeDesktopRawConfigFromFields();
}

function getClaudeDesktopRoleVal(role) {
  const input = document.getElementById(`claude-desktop-config-${role}`);
  const raw = input ? input.value : '';
  if (!raw || raw === '__clear__' || raw === '__custom__') return '';
  return applyClaudeDesktop1mMarker(raw, getClaudeDesktop1m(role));
}

function onClaudeDesktopRoleSelectChange(role, value) {
  const providers = globalThis.providerStore?.providers || [];
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value;
  const name = document.getElementById('claude-desktop-config-name')?.value || '';
  const p = providers.find(x => x.id === sourceId);
  const isAnyRouter = (p?.name || name || p?.apiHost || '').toLowerCase().includes('anyrouter');
  const isClaude = String(value || '').toLowerCase().includes('claude');

  // 联动更新菜单显示名：切换/选择模型时自动将显示名改为选中的模型，方便用户查看并在其基础上修改
  const cleanVal = stripClaudeDesktop1mMarker(value || '');
  const nameInput = document.getElementById(`claude-desktop-config-${role}-name`);
  if (nameInput) {
    nameInput.value = cleanVal;
  }

  setClaudeDesktop1m(role, isAnyRouter && isClaude);

  // 重新渲染该组件的 trigger 与选项选中状态
  populateRoleSelects({
    sourceProviderId: sourceId,
    sonnetModel: document.getElementById('claude-desktop-config-sonnet')?.value,
    opusModel: document.getElementById('claude-desktop-config-opus')?.value,
    haikuModel: document.getElementById('claude-desktop-config-haiku')?.value,
    fableModel: document.getElementById('claude-desktop-config-fable')?.value,
  }, p);

  syncClaudeDesktopRawConfigFromFields();
}

function claudeDesktopQuickSetAllModels() {
  const sonnetVal = stripClaudeDesktop1mMarker(document.getElementById('claude-desktop-config-sonnet')?.value);
  const opusVal = stripClaudeDesktop1mMarker(document.getElementById('claude-desktop-config-opus')?.value);
  const haikuVal = stripClaudeDesktop1mMarker(document.getElementById('claude-desktop-config-haiku')?.value);
  const sourceVal = sonnetVal || opusVal || haikuVal;

  if (!sourceVal || sourceVal === '__clear__' || sourceVal === '__custom__') {
    showCustomAlert('请先在上方任意档位中选择一个有效模型。', '未指定模型', 'info');
    return;
  }

  const providers = globalThis.providerStore?.providers || [];
  const sourceId = document.getElementById('claude-desktop-config-source-id')?.value;
  const name = document.getElementById('claude-desktop-config-name')?.value || '';
  const p = providers.find(x => x.id === sourceId);
  const isAnyRouter = (p?.name || name || p?.apiHost || '').toLowerCase().includes('anyrouter');
  const isClaude = sourceVal.toLowerCase().includes('claude');
  const use1m = isAnyRouter && isClaude;

  ['sonnet', 'opus', 'fable', 'haiku'].forEach(role => {
    const input = document.getElementById(`claude-desktop-config-${role}`);
    if (input) input.value = sourceVal;
    const nameInput = document.getElementById(`claude-desktop-config-${role}-name`);
    if (nameInput) {
      nameInput.value = sourceVal;
    }
    setClaudeDesktop1m(role, use1m);
  });

  populateRoleSelects({
    sourceProviderId: sourceId,
    sonnetModel: sourceVal,
    opusModel: sourceVal,
    haikuModel: sourceVal,
    fableModel: sourceVal,
  }, p);

  syncClaudeDesktopRawConfigFromFields();
  if (typeof addLog === 'function') addLog('ok', `已将模型「${sourceVal}」一键填充到所有 Desktop 角色`);
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已将「${sourceVal}」一键填充到所有角色档位`, 'success');
  }
}

export function closeAllCustomRoleMenus() {
  document.querySelectorAll('.claude-desktop-role-row, .claude-role-row').forEach(row => {
    row.style.zIndex = '';
    row.classList.remove('has-open-select');
  });
  document.querySelectorAll('.claude-desktop-role-card, .claude-code-role-card, .cb-add-models-card, .glass-card').forEach(card => {
    card.style.zIndex = '';
    card.classList.remove('has-open-select');
  });
  document.querySelectorAll('.custom-role-select').forEach(el => {
    el.classList.remove('open');
    el.classList.remove('drop-up');
    const m = el.querySelector('.custom-role-select-menu');
    if (m) m.style.display = 'none';
  });
}

function getModelFamilyRank(modelId) {
  const s = String(modelId || '').toLowerCase();
  // 图像/视频/语音等专用或多模态生成模型沉底
  if (/image|video|imagine|sora|dall-e|tts|speech|audio|embed|moderation/.test(s)) return 70;
  // Claude 平台下核心模型置顶
  if (/claude|opus|sonnet|haiku|fable/.test(s)) return 10;
  // 主流旗舰开发模型
  if (/gpt|chatgpt|^o[134]|\bcodex\b/.test(s)) return 20;
  if (/gemini|gemma/.test(s)) return 30;
  if (/deepseek/.test(s)) return 40;
  if (/grok/.test(s)) return 50;
  if (/qwen|qwq|qvq|glm|chatglm|kimi|moonshot|mistral|llama|minimax|doubao|hunyuan|baichuan|yi|internlm/.test(s)) return 60;
  return 65;
}

function compareModelNames(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (sa === sb) return 0;

  // 相同前缀下的版本号数字倒序（如 gemini-3.8 在 gemini-3.6 前面；gpt-6 在 gpt-5.6 前面；grok-4.6 在 grok-4.5 前面）
  const numRegex = /(\d+(?:\.\d+)*)/;
  const ma = sa.match(numRegex);
  const mb = sb.match(numRegex);
  if (ma && mb) {
    const preA = sa.slice(0, ma.index).toLowerCase();
    const preB = sb.slice(0, mb.index).toLowerCase();
    if (preA === preB) {
      const vaParts = ma[1].split('.').map(n => parseFloat(n) || 0);
      const vbParts = mb[1].split('.').map(n => parseFloat(n) || 0);
      const maxLen = Math.max(vaParts.length, vbParts.length);
      for (let i = 0; i < maxLen; i++) {
        const na = vaParts[i] ?? 0;
        const nb = vbParts[i] ?? 0;
        if (na !== nb) return nb - na; // 版本号高的优先排在前面
      }
    }
  }

  // 默认自然语言字典序
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortRoleSelectItems(items, preferredFamily = 'claude') {
  if (typeof globalThis.sortRoleSelectItems === 'function' && globalThis.sortRoleSelectItems !== sortRoleSelectItems) {
    return globalThis.sortRoleSelectItems(items, preferredFamily);
  }
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const aSaved = (a.provider === '已保存' || a.label === '已保存') ? 1 : 0;
    const bSaved = (b.provider === '已保存' || b.label === '已保存') ? 1 : 0;
    if (aSaved !== bSaved) return bSaved - aSaved;

    const idA = a.id || a.model || String(a);
    const idB = b.id || b.model || String(b);

    const rankA = getModelFamilyRank(idA);
    const rankB = getModelFamilyRank(idB);
    if (rankA !== rankB) return rankA - rankB;

    return compareModelNames(idA, idB);
  });
}

function toggleCustomRoleMenu(containerId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const container = document.getElementById(containerId);
  if (!container) return;
  const wasOpen = container.classList.contains('open');

  // 关闭页面上其他已打开的菜单
  closeAllCustomRoleMenus();

  if (!wasOpen) {
    // 动态智能判断是往上弹还是往下弹
    const rect = container.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    // 当下方剩余空间不足 240px 且上方空间更多时，自动向上弹出
    const isDropUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    if (isDropUp) {
      container.classList.add('drop-up');
    } else {
      container.classList.remove('drop-up');
    }

    container.classList.add('open');
    const parentRow = container.closest('.claude-desktop-role-row') || container.closest('.claude-role-row') || container.closest('div');
    if (parentRow) {
      parentRow.style.zIndex = '1500';
      parentRow.classList.add('has-open-select');
    }
    const parentCard = container.closest('.claude-desktop-role-card') || container.closest('.claude-code-role-card') || container.closest('.cb-add-models-card') || container.closest('.glass-card');
    if (parentCard) {
      parentCard.style.zIndex = '200';
      parentCard.classList.add('has-open-select');
    }
    const menu = container.querySelector('.custom-role-select-menu');
    if (menu) {
      menu.style.display = 'block';
      const list = menu.querySelector('.custom-role-select-list');
      if (list) {
        // 根据弹出方向动态设置最大高度，确保不会被屏幕顶部或底部边缘截断
        const availableSpace = isDropUp ? (spaceAbove - 24) : (spaceBelow - 24);
        const maxHeight = Math.max(140, Math.min(300, Math.floor(availableSpace)));
        list.style.maxHeight = `${maxHeight}px`;
      }
      const searchInput = menu.querySelector('.custom-role-select-search-input');
      if (searchInput) {
        searchInput.value = '';
        filterCustomRoleMenu(containerId, '');
        window.setTimeout(() => searchInput.focus(), 30);
      }
    }
  }
}

function filterCustomRoleMenu(containerId, query) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const q = String(query || '').trim().toLowerCase();
  const opts = container.querySelectorAll('.custom-role-select-opt');
  opts.forEach(opt => {
    const val = (opt.dataset.value || '').toLowerCase();
    const lbl = (opt.dataset.label || '').toLowerCase();
    const match = !q || val.includes(q) || lbl.includes(q);
    opt.style.display = match ? 'flex' : 'none';
  });
}

function selectCustomRoleItem(containerId, hiddenInputId, value, role) {
  const hiddenInput = document.getElementById(hiddenInputId);
  if (hiddenInput) {
    hiddenInput.value = value;
  }
  closeAllCustomRoleMenus();

  if (containerId.startsWith('claude-desktop-')) {
    if (typeof onClaudeDesktopRoleSelectChange === 'function') {
      onClaudeDesktopRoleSelectChange(role, value);
    }
  } else if (containerId.startsWith('grok-subagent-select-')) {
    if (typeof onGrokSubagentModelSelected === 'function') {
      onGrokSubagentModelSelected(containerId, value);
    }
  } else if (role === 'fallback') {
    if (typeof onClaudeFallbackSelectChange === 'function') {
      onClaudeFallbackSelectChange(value);
    }
  } else {
    if (typeof onClaudeRoleSelectChange === 'function') {
      onClaudeRoleSelectChange(role, value);
    }
  }
}

async function promptCustomRoleItem(containerId, hiddenInputId, role) {
  const custom = (typeof showCustomPrompt === 'function')
    ? await showCustomPrompt('请输入实际请求模型 ID（例如 claude-opus-4-7 或 gemini-2.5-pro）：', '自定义模型', '')
    : prompt('请输入实际请求模型 ID：', '');
  if (custom && custom.trim()) {
    const clean = stripClaudeDesktop1mMarker(custom.trim());
    selectCustomRoleItem(containerId, hiddenInputId, clean, role);
  }
}

function renderCustomRoleSelect({
  containerId,
  hiddenInputId,
  role,
  currentValue = '',
  groupLabel = '',
  items = [],
  optional = false,
}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let hiddenInput = document.getElementById(hiddenInputId);
  if (!hiddenInput) {
    hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    hiddenInput.id = hiddenInputId;
    container.appendChild(hiddenInput);
  }
  hiddenInput.value = currentValue || '';

  const cleanVal = stripClaudeDesktop1mMarker(currentValue || '');
  const sortedItems = sortRoleSelectItems(items);
  const matched = sortedItems.find(it => it.id === cleanVal);

  let iconHtml = '';
  let displayText = '';
  let badgeHtml = '';

  if (cleanVal) {
    iconHtml = (typeof renderModelIcon === 'function') ? renderModelIcon(cleanVal) : '';
    displayText = cleanVal;
    if (matched && matched.provider) {
      badgeHtml = `<span class="custom-role-select-badge">${escapeHtml(matched.provider)}</span>`;
    }
  } else if (optional) {
    displayText = '<span style="color:var(--text-muted);">(未启用 / 留空)</span>';
  } else {
    displayText = '<span style="color:var(--text-muted);">请选择真实模型…</span>';
  }

  const triggerHtml = `
    <button type="button" class="custom-role-select-trigger" onclick="toggleCustomRoleMenu('${containerId}', event)">
      <div class="custom-role-select-value">
        ${iconHtml ? `<span class="custom-role-select-icon">${iconHtml}</span>` : ''}
        <span class="custom-role-select-text">${displayText}</span>
        ${badgeHtml}
      </div>
      <svg class="custom-role-select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
  `;

  let searchHtml = '';
  if (sortedItems.length >= 6) {
    searchHtml = `
      <div class="custom-role-select-search-wrap" onclick="event.stopPropagation()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="custom-role-select-search-input" placeholder="搜索模型" oninput="filterCustomRoleMenu('${containerId}', this.value)" autocomplete="off">
      </div>
    `;
  }

  let menuHtml = `
    <div class="custom-role-select-menu" style="display: none;" onclick="event.stopPropagation()">
      ${searchHtml}
      <div class="custom-role-select-list">
  `;

  if (optional) {
    const isSelected = !cleanVal;
    menuHtml += `
      <div class="custom-role-select-opt ${isSelected ? 'selected' : ''}" data-value="" data-label="未启用" onclick="selectCustomRoleItem('${containerId}', '${hiddenInputId}', '', '${role}')">
        <span class="custom-role-select-opt-name" style="color:var(--text-muted);">(未启用 / 留空)</span>
        ${isSelected ? '<span class="custom-role-select-opt-check">✓</span>' : ''}
      </div>
    `;
  }

  if (groupLabel && sortedItems.length > 0) {
    menuHtml += `<div class="custom-role-select-group-title">${escapeHtml(groupLabel)}</div>`;
  }

  sortedItems.forEach(it => {
    const isSelected = it.id === cleanVal;
    const itemIcon = (typeof renderModelIcon === 'function') ? renderModelIcon(it.id) : '';
    const badge = it.provider ? `<span class="custom-role-select-opt-badge">${escapeHtml(it.provider)}</span>` : '';
    menuHtml += `
      <div class="custom-role-select-opt ${isSelected ? 'selected' : ''}" data-value="${escapeHtml(it.id)}" data-label="${escapeHtml(it.label || it.id)}" onclick="selectCustomRoleItem('${containerId}', '${hiddenInputId}', '${escapeHtml(it.id)}', '${role}')">
        <span class="custom-role-select-opt-icon">${itemIcon}</span>
        <span class="custom-role-select-opt-name" title="${escapeHtml(it.id)}">${escapeHtml(it.id)}</span>
        ${badge}
        ${isSelected ? '<span class="custom-role-select-opt-check">✓</span>' : ''}
      </div>
    `;
  });

  menuHtml += `
        <div class="custom-role-select-custom-btn" onclick="promptCustomRoleItem('${containerId}', '${hiddenInputId}', '${role}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <span>自定义输入模型...</span>
        </div>
      </div>
    </div>
  `;

  container.innerHTML = '';
  container.appendChild(hiddenInput);
  container.insertAdjacentHTML('beforeend', triggerHtml + menuHtml);
}

function populateRoleSelects(selectedValues = {}, targetProvider = null) {
  const providers = globalThis.providerStore?.providers || [];
  const p = targetProvider || (selectedValues.sourceProviderId ? providers.find(x => x.id === selectedValues.sourceProviderId) : null);
  const isLocalProxy = !p || p.isLocalProxy || p.meta?.localProxy || p.id === 'local-proxy' || p.id === 'anybridge' || p.name === 'AnyBridge';
  const isAnyRouter = (p?.name || p?.id || p?.apiHost || '').toLowerCase().includes('anyrouter');

  let modelItems = [];
  let groupLabel = '';

  if (isLocalProxy) {
    const routes = (globalThis.proxyRoutesStore?.routes || []).filter(r => r && r.enabled !== false);
    groupLabel = `内置模型路由 (${routes.length})`;
    modelItems = routes.map(r => {
      const cleanId = stripClaudeDesktop1mMarker(r.id);
      const targetProvId = r.targets?.[0]?.providerId;
      const targetProv = targetProvId
        ? ((globalThis.providerStore?.providers || []).find(pr => pr.id === targetProvId)?.name || targetProvId)
        : '';
      return { id: cleanId, label: cleanId, provider: targetProv };
    });
  } else {
    const rawModels = getProviderModelList(p);
    groupLabel = p?.name ? `供应商【${p.name}】模型 (${rawModels.length})` : `当前供应商模型 (${rawModels.length})`;
    modelItems = rawModels.map(m => {
      const cleanId = stripClaudeDesktop1mMarker(m);
      return { id: cleanId, label: cleanId, provider: '' };
    });
  }

  const roles = [
    { key: 'sonnetModel', role: 'sonnet', name: 'Sonnet 主模型' },
    { key: 'opusModel', role: 'opus', name: 'Opus 深度推理' },
    { key: 'haikuModel', role: 'haiku', name: 'Haiku 轻量快速' },
    { key: 'fableModel', role: 'fable', name: 'Fable 扩展模型', optional: true },
  ];

  roles.forEach(({ key, role, optional }) => {
    const containerId = `claude-desktop-role-select-${role}`;
    const hiddenInputId = `claude-desktop-config-${role}`;
    const hiddenInput = document.getElementById(hiddenInputId);
    let rawVal = selectedValues[key] !== undefined ? selectedValues[key] : (hiddenInput ? hiddenInput.value : '');
    let cleanVal = stripClaudeDesktop1mMarker(rawVal);
    let use1m = hasClaudeDesktop1mMarker(rawVal) || (isAnyRouter && String(cleanVal).toLowerCase().includes('claude'));

    // 如果当前选中的值不在列表中且非空，仅在编辑已有配置时作为保留项加入
    const availableItems = [...modelItems];
    const isEditing = !!document.getElementById('claude-desktop-config-edit-id')?.value;
    if (isEditing && cleanVal && !availableItems.some(it => it.id === cleanVal)) {
      availableItems.unshift({ id: cleanVal, label: cleanVal, provider: '已保存' });
    }

    renderCustomRoleSelect({
      containerId,
      hiddenInputId,
      role,
      currentValue: cleanVal,
      groupLabel,
      items: availableItems,
      optional,
    });

    setClaudeDesktop1m(role, use1m);
  });

  syncClaudeDesktopRawConfigFromFields();
}

// 绑定全局点击关闭下拉菜单监听
if (typeof document !== 'undefined' && !window._customRoleSelectGlobalBound) {
  window._customRoleSelectGlobalBound = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-role-select')) {
      closeAllCustomRoleMenus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllCustomRoleMenus();
    }
  });
}

globalThis.onClaudeDesktopRoleSelectChange = onClaudeDesktopRoleSelectChange;
globalThis.onClaudeDesktop1mChange = onClaudeDesktop1mChange;
globalThis.claudeDesktopQuickSetAllModels = claudeDesktopQuickSetAllModels;
globalThis.getClaudeDesktopRoleVal = getClaudeDesktopRoleVal;
globalThis.populateRoleSelects = populateRoleSelects;
globalThis.toggleCustomRoleMenu = toggleCustomRoleMenu;
globalThis.filterCustomRoleMenu = filterCustomRoleMenu;
globalThis.selectCustomRoleItem = selectCustomRoleItem;
globalThis.promptCustomRoleItem = promptCustomRoleItem;
globalThis.renderCustomRoleSelect = renderCustomRoleSelect;
