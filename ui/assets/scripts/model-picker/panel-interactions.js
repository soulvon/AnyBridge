// model-picker/panel-interactions.js — 模型面板筛选标签、搜索、勾选与密钥显隐

export function updateModelFilterTabCounts() {
  const counts = { all: activeModelsList.length, text: 0, image: 0, embedding: 0, audio: 0, video: 0, rerank: 0 };
  for (const m of activeModelsList) {
    const t = classifyModelType(m);
    if (counts[t] !== undefined) counts[t]++;
  }
  for (const [key, count] of Object.entries(counts)) {
    const el = document.getElementById(`count-tab-${key}`);
    if (el) el.textContent = count;
    const tabEl = el ? el.closest('.model-filter-tab') : document.querySelector(`.model-filter-tab[data-arg="${key}"]`);
    if (tabEl && key !== 'all') {
      tabEl.classList.toggle('is-empty', count === 0);
    }
  }
}

function changeModelTab(tab) {
  currentModelTab = tab;
  // 切换 active 样式
  document.querySelectorAll('.model-filter-tab').forEach(el => {
    const isClickedTab = el.getAttribute('data-arg') === tab;
    el.classList.toggle('active', isClickedTab);
  });
  filterModelPanel();
}

function toggleModelSort() {
  modelPanelSortMode = modelPanelSortMode === 'default' ? 'asc' : 'default';
  const btn = document.getElementById('modelFilterSortBtn');
  if (btn) {
    btn.classList.toggle('active', modelPanelSortMode === 'asc');
    btn.title = modelPanelSortMode === 'asc' ? '当前：名称 A-Z 升序（点击切回默认）' : '当前：默认排序（点击切换 A-Z 升序）';
    const label = btn.querySelector('.model-sort-label');
    if (label) {
      label.textContent = modelPanelSortMode === 'asc' ? 'A-Z 已启用' : 'A-Z';
    }
  }
  filterModelPanel();
}

function getModelBadges(modelId) {
  const id = modelId.toLowerCase();
  let badges = '';
  if (/reason|thinking|r1|o1|o3/i.test(id)) {
    badges += `<span class="model-badge-feature" style="background:rgba(245, 158, 11, 0.1); color:#D97706; border:1px solid rgba(245, 158, 11, 0.2);">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px; flex-shrink:0;"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1 0-3.12 3 3 0 0 1 0-4.88 2.5 2.5 0 0 1 0-3.12A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 0-3.12 3 3 0 0 0 0-4.88 2.5 2.5 0 0 0 0-3.12A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
      <span>推理</span>
    </span>`;
  }
  if (/vl|vision|image|paint|dall/i.test(id)) {
    badges += `<span class="model-badge-feature" style="background:rgba(59, 130, 246, 0.1); color:#2563EB; border:1px solid rgba(59, 130, 246, 0.2);">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px; flex-shrink:0;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      <span>视觉</span>
    </span>`;
  }
  if (/online|search|web|pro/i.test(id)) {
    badges += `<span class="model-badge-feature" style="background:rgba(16, 185, 129, 0.1); color:#059669; border:1px solid rgba(16, 185, 129, 0.2);">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px; flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
      <span>联网</span>
    </span>`;
  }
  if (/free/i.test(id)) {
    badges += `<span class="model-badge-feature" style="background:rgba(3, 105, 161, 0.10); color:#0369A1; border:1px solid rgba(3, 105, 161, 0.22);">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px; flex-shrink:0;"><rect x="3" y="8" width="18" height="4" rx="1"></rect><path d="M12 8v13"></path><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"></path><path d="M7.5 8a2.5 2.5 0 0 1 0-5A2.5 2.5 0 0 1 12 5.5a2.5 2.5 0 0 1 4.5-2.5 2.5 2.5 0 0 1 0 5"></path></svg>
      <span>免费</span>
    </span>`;
  }
  if (/embed/i.test(id)) {
    badges += `<span class="model-badge-feature" style="background:rgba(6, 182, 212, 0.1); color:#0891B2; border:1px solid rgba(6, 182, 212, 0.2);">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px; flex-shrink:0;"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
      <span>向量</span>
    </span>`;
  }
  if (/rerank/i.test(id)) {
    badges += `<span class="model-badge-feature" style="background:rgba(236, 72, 153, 0.1); color:#DB2777; border:1px solid rgba(236, 72, 153, 0.2);">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px; flex-shrink:0;"><path d="m3 16 4 4 4-4"></path><path d="M7 20V4"></path><path d="m21 8-4-4-4 4"></path><path d="M17 4v16"></path></svg>
      <span>重排</span>
    </span>`;
  }
  return badges;
}

function toggleModelSearch() {
  modelSearchOpen = !modelSearchOpen;
  const el = document.getElementById('modelPanelSearch');
  const btn = document.getElementById('modelSearchBtn');
  if (el) el.classList.toggle('open', modelSearchOpen);
  if (btn) btn.classList.toggle('active', modelSearchOpen);
  if (modelSearchOpen) {
    const input = document.getElementById('modelSearchInput');
    if (input) input.focus();
  } else {
    clearModelSearch();
  }
}

function clearModelSearch() {
  const input = document.getElementById('modelSearchInput');
  if (input) {
    input.value = '';
    input.focus();
  }
  const clearBtn = document.getElementById('modelSearchClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  filterModelPanel();
}

function providerFetchButtonContent(label, loading = false) {
  if (loading) {
    return `
      <span class="provider-fetch-spinner" aria-hidden="true"></span>
      <span>${escAttr(label)}</span>
    `;
  }
  return `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
    </svg>
    <span>${escAttr(label)}</span>
  `;
}

globalThis.selectedModels = [];
globalThis.editorDraftModelCaps = {};

/**
 * 预设一键预填模型清单：灌进候选面板并全部勾选。
 * Vertex AI 这类拿不到列表接口的供应商专用（Express Key 无 models.list）。
 */
globalThis.applyPresetModels = function (models, defaultModel) {
  const list = (Array.isArray(models) ? models : []).map((m) => String(m || '').trim()).filter(Boolean);
  if (!list.length) return;
  activeModelsList = Array.from(new Set([...list, ...activeModelsList]));
  selectedModels = list.slice();
  if (defaultModel && selectedModels.includes(defaultModel)) {
    selectedModels = [defaultModel, ...selectedModels.filter((m) => m !== defaultModel)];
  }
  modelGroupStates = {};
  updateSelectedModelsUI();
  if (typeof filterModelPanel === 'function') filterModelPanel();
};

function updateSelectedModelsUI() {
  if (typeof sortModelsNaturally === 'function') {
    selectedModels = sortModelsNaturally(selectedModels);
  }
  const leftContainer = document.getElementById('leftSelectedModelsList');
  const leftCount = document.getElementById('leftSelectedCount');
  const rightContainer = document.getElementById('selectedModelTags'); // 兼容旧面板
  const input = document.getElementById('pf-model');

  if (input) {
    input.value = selectedModels[0] || ''; // defaultModel stays backwards compatible (the first one)
  }

  if (leftCount) {
    leftCount.textContent = selectedModels.length;
  }

  // 获取当前编辑中供应商的 modelCaps（合并已有 + 弹窗内探测草稿）
  const editId = document.getElementById('pf-id')?.value;
  const editProvider = editId ? providerStore.providers.find(x => x.id === editId) : null;
  const modelCaps = {
    ...(editProvider?.modelCaps || {}),
    ...editorDraftModelCaps,
  };

  function modelCapBadges(m) {
    const mc = modelCaps[m] || {};
    const badges = [];
    if (mc.vision) badges.push('<span class="selected-model-cap selected-model-cap-vision">视觉</span>');
    if (mc.tools) badges.push('<span class="selected-model-cap selected-model-cap-tools">工具</span>');
    return badges.join(' ');
  }

  if (leftContainer) {
    if (selectedModels.length === 0) {
      leftContainer.innerHTML = `
        <div class="provider-selected-empty">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="16"></line>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
          <span>请在右侧选择或添加支持的模型</span>
        </div>
      `;
    } else {
      leftContainer.innerHTML = selectedModels.map((m, idx) => `
        <div class="selected-model-row">
          <div class="selected-model-main">
            ${renderModelIcon(m)}
            <div class="selected-model-text">
              <div class="selected-model-name-row">
                <div class="selected-model-name-wrap">
                  <span class="selected-model-name" title="${escAttr(m)}">${escAttr(m)}</span>
                  <button type="button" class="btn-icon model-id-copy-btn selected-model-copy-btn" data-action="copyTextToClipboard" data-args="[&quot;${escAttr(m)}&quot;,&quot;模型 ID&quot;]" data-stop onclick="event.stopPropagation()" title="复制模型 ID" aria-label="复制模型 ID">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                </div>
                ${idx === 0 ? '<span class="selected-model-default">默认</span>' : ''}
                ${modelCapBadges(m)}
              </div>
            </div>
          </div>
          <button class="model-panel-btn selected-model-remove" data-action="selectModel" data-arg="${escAttr(m)}" title="移除该模型">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `).join('');
    }
  }

  // 兼容旧标签容器渲染（隐藏状态）
  if (rightContainer) {
    if (selectedModels.length === 0) {
      rightContainer.innerHTML = '<span style="font-size:12px; color:var(--text-muted);">暂无选择模型</span>';
      return;
    }
    rightContainer.innerHTML = selectedModels.map((m, idx) => `
      <div class="selected-model-tag" data-action="selectModel" data-arg="${escAttr(m)}" title="点击移除">
        ${renderModelIcon(m)}
        <span>${escAttr(m)}</span>
        ${idx === 0 ? '<span style="opacity: 0.6; font-size: 12px; margin-left: 2px;">(默认)</span>' : ''}
        <span class="selected-model-tag-close">×</span>
      </div>
    `).join('');
  }
}

function filterModelPanel() {
  const searchInput = document.getElementById('modelSearchInput');
  const query = (searchInput?.value || '').toLowerCase().trim();
  const body = document.getElementById('modelPanelBody');
  if (!body) return;

  const clearBtn = document.getElementById('modelSearchClearBtn');
  if (clearBtn) {
    clearBtn.style.display = query ? 'inline-flex' : 'none';
  }

  // 1. 更新顶部各分类模型数量 Badge
  updateModelFilterTabCounts();

  // 2. 基于搜索字符过滤
  let filtered = query
    ? activeModelsList.filter(m => m.toLowerCase().includes(query))
    : activeModelsList;

  // 3. 基于分类 Tab 过滤 (Cherry Studio 体系)
  if (currentModelTab !== 'all') {
    filtered = filtered.filter(m => classifyModelType(m) === currentModelTab);
  }

  // 4. 基于排序切换 (默认排序 / A-Z 升序)
  if (modelPanelSortMode === 'asc') {
    filtered = [...filtered].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  const groups = groupModels(filtered);

  // 计数徽标必须在所有分支都刷新：列表清空时若不更新，
  // 上一次拉取成功的数字会残留在 DOM 里，让人误以为本次也拉到了。
  const countEl = document.getElementById('modelPanelCount');
  if (countEl) countEl.textContent = `${filtered.length} 个`;

  if (filtered.length === 0) {
    body.innerHTML = '<div class="model-panel-empty">暂无模型，请先拉取或自定义添加</div>';
    return;
  }

  body.innerHTML = Object.entries(groups).map(([groupName, models]) => {
    const isOpen = modelGroupStates[groupName] !== false; // default open
    return `
      <div class="model-group">
        <div class="model-group-header ${isOpen ? 'open' : ''}" data-action="toggleModelGroup" data-arg="${escAttr(groupName)}">
          <div class="model-group-label">
            ${escAttr(groupName)}
            <span class="model-group-count">${models.length}</span>
          </div>
          <div class="model-group-tools" data-action="__noop" data-stop>
            <button class="model-panel-btn model-group-mini-btn" data-action="toggleSelectGroup" data-args="[&quot;${escAttr(groupName)}&quot;,true]">＋ 全选</button>
            <button class="model-panel-btn model-group-mini-btn" data-action="toggleSelectGroup" data-args="[&quot;${escAttr(groupName)}&quot;,false]">－ 清空</button>
            <span class="model-group-chevron" data-action="toggleModelGroup" data-arg="${escAttr(groupName)}">▶</span>
          </div>
        </div>
        <div class="model-group-body ${isOpen ? 'open' : ''}">
          ${models.map(m => {
            const isSelected = selectedModels.includes(m);
            return `
              <div class="model-item ${isSelected ? 'selected' : ''}" data-action="selectModel" data-arg="${escAttr(m)}">
                ${renderModelIcon(m)}
                <div class="model-item-name-wrap">
                  <span class="model-item-name" title="${escAttr(m)}">${escAttr(m)}</span>
                  <button type="button" class="btn-icon model-id-copy-btn model-item-copy-btn" data-action="copyTextToClipboard" data-args="[&quot;${escAttr(m)}&quot;,&quot;模型 ID&quot;]" data-stop onclick="event.stopPropagation()" title="复制模型 ID" aria-label="复制模型 ID">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                </div>
                <div style="display:flex; gap:4px; align-items:center; flex-shrink:0; margin-right:8px;">
                  ${getModelBadges(m)}
                </div>
                <div class="model-item-action">
                  ${isSelected ? `
                    <span class="model-item-checkmark is-selected">✓</span>
                  ` : `
                    <span class="model-item-checkmark">+</span>
                  `}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

function toggleSelectGroup(groupName, selectAll) {
  const query = (document.getElementById('modelSearchInput')?.value || '').toLowerCase().trim();
  let filtered = activeModelsList;
  if (query) {
    filtered = filtered.filter(m => m.toLowerCase().includes(query));
  }
  if (currentModelTab !== 'all') {
    filtered = filtered.filter(m => {
      const id = m.toLowerCase();
      if (currentModelTab === 'reason') return /reason|thinking|r1|o1|o3|coder|math/i.test(id);
      if (currentModelTab === 'vision') return /vl|vision|image|paint|dall/i.test(id);
      if (currentModelTab === 'search') return /online|search|web|pro/i.test(id);
      if (currentModelTab === 'free') return /free/i.test(id);
      if (currentModelTab === 'embed') return /embed/i.test(id);
      if (currentModelTab === 'rerank') return /rerank/i.test(id);
      return true;
    });
  }

  const groups = groupModels(filtered);
  const models = groups[groupName] || [];

  models.forEach(m => {
    const idx = selectedModels.indexOf(m);
    if (selectAll) {
      if (idx < 0) selectedModels.push(m);
    } else {
      if (idx >= 0) selectedModels.splice(idx, 1);
    }
  });

  if (typeof sortModelsNaturally === 'function') {
    selectedModels = sortModelsNaturally(selectedModels);
  }

  updateSelectedModelsUI();
  filterModelPanel();
}

function toggleModelGroup(groupName) {
  modelGroupStates[groupName] = modelGroupStates[groupName] === false ? true : false;
  filterModelPanel();
}

function selectModel(val) {
  const idx = selectedModels.indexOf(val);
  if (idx >= 0) {
    selectedModels.splice(idx, 1);
  } else {
    selectedModels.push(val);
  }
  if (typeof sortModelsNaturally === 'function') {
    selectedModels = sortModelsNaturally(selectedModels);
  }
  updateSelectedModelsUI();
  filterModelPanel(); // re-render to update selection highlight
}

function addCustomModel() {
  const input = document.getElementById('modelCustomInput');
  const val = input?.value?.trim();
  if (!val) return;
  if (!activeModelsList.includes(val)) {
    activeModelsList.push(val);
  }
  if (!selectedModels.includes(val)) {
    selectedModels.push(val);
  }
  if (typeof sortModelsNaturally === 'function') {
    activeModelsList = sortModelsNaturally(activeModelsList);
    selectedModels = sortModelsNaturally(selectedModels);
  }
  updateSelectedModelsUI();
  input.value = '';
  filterModelPanel();
  addLog('ok', `已添加自定义模型: ${val}`);
}

globalThis.EYE_SVG_OPEN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
globalThis.EYE_SVG_CLOSE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`;

function toggleKeyVisibility() {
  const keyInput = document.getElementById('pf-key');
  const btn = document.getElementById('pf-key-toggle');
  if (!keyInput) return;
  if (keyInput.type === 'password') {
    keyInput.type = 'text';
    if (btn) btn.innerHTML = EYE_SVG_CLOSE;
  } else {
    keyInput.type = 'password';
    if (btn) btn.innerHTML = EYE_SVG_OPEN;
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.changeModelTab = changeModelTab;
  g.toggleModelSort = toggleModelSort;
  g.getModelBadges = getModelBadges;
  g.toggleModelSearch = toggleModelSearch;
  g.clearModelSearch = clearModelSearch;
  g.providerFetchButtonContent = providerFetchButtonContent;
  g.updateSelectedModelsUI = updateSelectedModelsUI;
  g.filterModelPanel = filterModelPanel;
  g.toggleSelectGroup = toggleSelectGroup;
  g.toggleModelGroup = toggleModelGroup;
  g.selectModel = selectModel;
  g.addCustomModel = addCustomModel;
  g.toggleKeyVisibility = toggleKeyVisibility;
})(globalThis);
