// ═══════ MODEL MAP (可编辑槽位映射 + 故障转移链) ═══════
let modelMapStore = { slots: [] };       // load_model_map 结果
let ideModels = null;               // list_ide_models 缓存（数组）
let ideMeta = null;                 // { source, capturedAt, account } 元信息

async function ensureIdeModels() {
  if (ideModels) return ideModels;
  try {
    const res = await invoke('list_ide_models');
    if (res && Array.isArray(res.models)) {
      ideModels = res.models;
      ideMeta = { source: res.source || '', capturedAt: res.captured_at || null, account: res.account || null };
    } else if (Array.isArray(res)) {
      // 兼容旧版返回数组格式
      ideModels = res;
      ideMeta = { source: '', capturedAt: null, account: null };
    } else {
      ideModels = [];
      ideMeta = { source: '', capturedAt: null, account: null };
    }
  } catch (e) {
    addLog('warn', '获取 IDE 模型清单失败: ' + e);
    ideModels = [];
    ideMeta = { source: '', capturedAt: null, account: null };
  }
  return ideModels;
}

async function refreshIdeModels() {
  const btn = document.getElementById('btn-refresh-models');
  try {
    if (btn) { btn.disabled = true; btn.querySelector('span') && (btn.querySelector('span').textContent = '拉取中...'); }
    const target = getTargetIde();
    const info = await invoke('refresh_ide_models', { target });
    ideModels = info.models || [];
    ideMeta = {
      source: 'api',
      capturedAt: Date.now(),
      account: {
        email: info.email,
        plan_name: info.plan_name,
        teams_tier: info.teams_tier,
        daily_remaining: info.daily_remaining,
        weekly_remaining: info.weekly_remaining,
        overage_balance_micros: info.overage_balance_micros,
      },
    };
    // 刷新模态框内的槽位列表
    maybeAutoSelectRecommendedSlot();
    renderSlotCatalogList();
    updateSlotVisionHint();
    addLog('info', `模型列表已更新：${info.email} (${info.plan_name})，${info.models.length} 个模型`);
  } catch (e) {
    addLog('error', '刷新模型列表失败: ' + e);
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('span') && (btn.querySelector('span').textContent = '刷新'); }
  }
}

// 由 modelUid 找原始名（查不到回退到 uid 本身）
function originalNameOf(uid) {
  const m = (ideModels || []).find(x => x.id === uid);
  return m ? m.name : uid;
}

// 渲染单个 target 链，失效（供应商不存在或未启用）的标红 ⚠
function renderTargetChain(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return '<span style="color:var(--warn,#d97706)">未设置 ⚠</span>';
  }
  return `<div class="target-chain">${targets.map((t, i) => {
    const p = (providerStore.providers || []).find(x => x.id === t.providerId);
    const invalid = !p || p.enabled === false;
    const label = p ? p.name : (t.providerId || '?');
    const modelText = `${escAttr(label)}/${escAttr(t.model || '默认模型')}`;
    const badges = p ? capabilityBadges(p, true, t.model || p.defaultModel || null) : '';
    const caps = badges || (invalid ? '<span class="target-cap-muted">供应商不可用</span>' : '<span class="target-cap-muted">未标记能力</span>');
    return `
      <div class="target-chain-item${invalid ? ' invalid' : ''}" title="${invalid ? '供应商不存在或未启用' : '配置故障转移分流目标'}">
        <div class="target-model-line">
          <span class="target-order">${i + 1}</span>
          <span class="target-model-text">${modelText}</span>
          ${invalid ? '<span class="target-warning">⚠</span>' : ''}
        </div>
        <div class="target-cap-line">${caps}</div>
      </div>`;
  }).join('')}</div>`;
}

function renderModelMapSummary(slots) {
  const el = document.getElementById('modelMapSummary');
  if (!el) return;
  const accountCount = (ideModels || []).filter(isAccountSlotModel).length;
  const extendedCount = (ideModels || []).filter(m => !isAccountSlotModel(m)).length;
  const mappedCount = (slots || []).length;
  const riskCount = (slots || []).filter(s => slotVisionAssessment(s.modelUid, s.targets || [], s.supportsImages !== false).state === 'risk').length;
  const pill = (label, value, warn = false) => `<span class="tag" style="background:${warn ? 'rgba(217,119,6,.12)' : 'var(--bg-input)'};color:${warn ? 'var(--warn,#d97706)' : 'var(--text-muted)'};border:1px solid ${warn ? 'rgba(217,119,6,.28)' : 'var(--border)'};font-size:10px;padding:2px 7px;border-radius:7px;font-weight:700;white-space:nowrap;">${label} ${value}</span>`;
  el.innerHTML = [
    pill('当前账号槽位', accountCount),
    pill('内置槽位', extendedCount),
    pill('已映射', mappedCount),
    riskCount ? pill('图片风险', riskCount, true) : '',
  ].filter(Boolean).join('');
}

async function renderModelMap() {
  const body = document.getElementById('modelMapBody');
  if (!body) return;
  await ensureIdeModels();
  await ensureInjected();
  try {
    const res = await invoke('load_model_map');
    modelMapStore = (res && Array.isArray(res.slots)) ? res : { slots: [] };
  } catch (e) {
    modelMapStore = { slots: [] };
    addLog('warn', '加载模型映射失败: ' + e);
  }

  // 同步 namePrefix 到输入框
  // 兼容旧 model-map.json（无 injected 字段）
  if (!Array.isArray(modelMapStore.injected)) modelMapStore.injected = [];
  modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
  const badge = document.getElementById('injected-count-badge');
  if (badge) badge.textContent = '模型槽位管理';

  const slots = modelMapStore.slots || [];
  renderModelMapSummary(slots);
  if (slots.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:18px">暂无映射，点击右上角「+ 添加映射」</td></tr>';
    return;
  }

  body.innerHTML = slots.map(s => {
    const orig = originalNameOf(s.modelUid);
    const customName = s.displayName && s.displayName.trim();
    const baseName = customName || orig;
    const prefix = (modelMapStore.namePrefix || '').trim();
    const tpl = (modelMapStore.labelTemplate || '').trim();
    // providerName/apiModel 仅作列表预览(非 100% 等于后端实际渲染,因为多 targets 优先级等细节),
    // 后端改写时才决定最终值;这里给个合理近似
    const firstTarget = (s.targets && s.targets[0]) || null;
    const providerName = firstTarget ? providerNameOf(firstTarget.providerId) : '';
    const apiModel = firstTarget ? firstTarget.model : '';
    const display = renderLabelTemplate(tpl, {
      prefix, label: baseName, provider: providerName, apiModel
    });
    const enabled = s.enabled !== false;
    const chain = (s.targets && s.targets.length)
      ? renderTargetChain(s.targets)
      : `<span style="color:var(--warn,#d97706);cursor:pointer" onclick="openFailoverEditor('${escAttr(s.modelUid)}')">未设置 ⚠ [点击配置]</span>`;
    const vision = slotVisionAssessment(s.modelUid, s.targets || [], s.supportsImages !== false);
    return `
      <tr data-model-uid="${escAttr(s.modelUid)}" data-vision-risk="${vision.state === 'risk' ? '1' : '0'}">
        <td class="editable-cell display-name-cell" onclick="startEditDisplayName(this, '${escAttr(s.modelUid)}')" title="${escAttr(display)}">${escAttr(display)}</td>
        <td>${escAttr(orig)}</td>
        <td class="model-raw-cell model-vision-cell" title="${escAttr(s.modelUid)}">
          ${renderVisionPill(vision, true)}
        </td>
        <td class="model-target-cell" onclick="openFailoverEditor('${escAttr(s.modelUid)}')" title="配置故障转移分流目标">${chain}</td>
        <td><div class="toggle ${enabled ? 'on' : ''}" onclick="toggleSlotEnabled('${escAttr(s.modelUid)}')"></div></td>
        <td>
          <div class="model-map-actions">
            <button class="btn-ghost model-map-action-btn" onclick="openSlotEditor('${escAttr(s.modelUid)}')">编辑</button>
            <button class="btn-ghost model-map-action-btn danger" onclick="deleteSlot('${escAttr(s.modelUid)}')">删除</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  // 渲染后立即应用当前的过滤器与搜索关键字
  filterModelTable();
}

// ─── 双击/点击编辑显示名 ───
function startEditDisplayName(td, uid) {
  if (td.querySelector('input')) return;
  // 编辑时只展示自定义名部分（不含前缀），便于用户修改
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  const orig = originalNameOf(uid);
  const customName = s && s.displayName && s.displayName.trim() ? s.displayName : orig;
  td.innerHTML = `<input type="text" class="input-sm" style="width:100%; text-align:left; font-family:inherit; padding:4px 8px; border-radius:6px; box-shadow:none; outline:none; height:28px;" value="${escAttr(customName)}">`;
  const input = td.querySelector('input');

  // 阻止 input 上的点击事件冒泡，防止重复触发 td.onclick
  input.addEventListener('click', (e) => e.stopPropagation());

  input.focus();
  input.select();

  let finished = false;
  async function finishEdit() {
    if (finished) return;
    finished = true;
    const newVal = input.value.trim();
    const s = modelMapStore.slots.find(x => x.modelUid === uid);
    if (s) {
      const orig = originalNameOf(uid);
      const prevDisplay = s.displayName && s.displayName.trim() ? s.displayName : orig;
      // 只有当新输入的值和当前的显示名（或原名）不同，才更新并保存
      if (newVal !== prevDisplay) {
        const prev = s.displayName;
        // 如果输入的值就是原名，视为清除自定义显示名，保存为空
        s.displayName = (newVal === orig) ? '' : newVal;
        if (await persistModelMap()) {
          addLog('ok', `已更新显示名: ${newVal || orig}`);
        } else {
          s.displayName = prev;
        }
      }
    }
    await renderModelMap();
  }

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishEdit();
    } else if (e.key === 'Escape') {
      finished = true;
      renderModelMap();
    }
  });
}

// ═══════ MODEL FILTERING LOGIC ═══════
let currentModelFilter = 'all';

function setModelFilter(filter) {
  currentModelFilter = filter;

  // 更新 Tab 按钮的激活状态样式
  document.querySelectorAll('.filter-tab-item').forEach(btn => {
    if (btn.dataset.filter === filter) {
      btn.classList.add('active');
      btn.style.background = 'var(--bg-card)';
      btn.style.color = 'var(--text-primary)';
      btn.style.boxShadow = 'var(--shadow-sm)';
    } else {
      btn.classList.remove('active');
      btn.style.background = 'transparent';
      btn.style.color = 'var(--text-muted)';
      btn.style.boxShadow = 'none';
    }
  });

  filterModelTable();
}

function filterModelTable() {
  const searchInput = document.getElementById('model-search-input');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const body = document.getElementById('modelMapBody');
  if (!body) return;

  const rows = body.getElementsByTagName('tr');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // 跳过空数据提示行
    if (row.cells.length === 1 && row.cells[0].colSpan >= 6) {
      continue;
    }

    const display = row.cells[0].textContent.toLowerCase();
    const orig = row.cells[1].textContent.toLowerCase();
    const slot = (row.dataset.modelUid || '').toLowerCase();

    // 搜索匹配
    const matchesSearch = query === '' ||
                          orig.includes(query) ||
                          display.includes(query) ||
                          slot.includes(query);

    // 状态过滤判断
    let matchesFilter = true;
    const isUnset = row.cells[3].textContent.includes('未设置');
    const isVisionRisk = row.dataset.visionRisk === '1';
    const isHijacked = row.cells[4].querySelector('.toggle').classList.contains('on');

    if (currentModelFilter === 'hijacked') {
      matchesFilter = isHijacked;
    } else if (currentModelFilter === 'unset') {
      matchesFilter = isUnset;
    } else if (currentModelFilter === 'vision-risk') {
      matchesFilter = isVisionRisk;
    }

    if (matchesSearch && matchesFilter) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  }
}

async function persistModelMap() {
  try {
    await invoke('save_model_map', { map: modelMapStore });
    return true;
  } catch (e) {
    addLog('err', '保存映射失败: ' + e);
    showCustomAlert('保存映射失败：' + e, '保存失败', 'error');
    return false;
  }
}

// ─── 模型映射显示设置模态框（名称前缀 + 后缀 + 高级模板）───
// 跟 sidecar renderTemplate 保持一致:占位符 {prefix} {label} {provider} {apiModel}
// 模板含 {provider} 且 provider 空 → 「未设置」
const DEFAULT_LABEL_TEMPLATE = '{prefix} {label} ({provider})';
const SIMPLE_LABEL_TEMPLATE_BASE = '{prefix} {label}';
const TEMPLATE_VAR_NAMES = ['prefix', 'label', 'provider', 'apiModel'];
let labelTemplateModalMode = 'simple';

function renderLabelTemplate(tpl, vars) {
  const tmpl = (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
  const hasProvider = /\bprovider\b/.test(tmpl);
  const v = {
    prefix:   vars.prefix   || '',
    label:    vars.label    || '',
    provider: vars.provider || (hasProvider ? '未设置' : ''),
    apiModel: vars.apiModel || '',
  };
  let out = tmpl;
  for (const k of TEMPLATE_VAR_NAMES) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), v[k]);
  }
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

function normalizedLabelTemplate(tpl) {
  return (tpl && tpl.trim()) || DEFAULT_LABEL_TEMPLATE;
}

function composeSimpleLabelTemplate(suffix) {
  const cleanSuffix = (suffix || '').trim();
  return cleanSuffix ? `${SIMPLE_LABEL_TEMPLATE_BASE} ${cleanSuffix}` : SIMPLE_LABEL_TEMPLATE_BASE;
}

function suffixFromSimpleLabelTemplate(tpl) {
  const normalized = normalizedLabelTemplate(tpl);
  const match = normalized.match(/^\{prefix\}\s+\{label\}(.*)$/);
  if (!match) return null;
  return (match[1] || '').trim();
}

function currentModalLabelTemplate() {
  const tplInput = document.getElementById('model-label-template-modal');
  if (labelTemplateModalMode === 'custom') {
    return tplInput ? tplInput.value.trim() : '';
  }
  const suffixInput = document.getElementById('model-name-suffix-modal');
  const suffix = suffixInput ? suffixInput.value.trim() : '';
  return composeSimpleLabelTemplate(suffix);
}

function labelTemplateForStoreFromModal() {
  const tpl = currentModalLabelTemplate();
  return normalizedLabelTemplate(tpl) === DEFAULT_LABEL_TEMPLATE ? '' : tpl.trim();
}

// 取 provider 友好名(从当前 providerStore 找,失败回退 id)
function providerNameOf(pid) {
  if (!pid) return '';
  try {
    const list = (typeof providerStore !== 'undefined' && providerStore && Array.isArray(providerStore.providers)) ? providerStore.providers : [];
    const p = list.find(x => x && x.id === pid);
    return p ? (p.name || pid) : pid;
  } catch { return pid; }
}

// 打开显示设置模态框
function openModelMapSettings() {
  const modal = document.getElementById('modelMapSettingsModal');
  if (!modal) {
    console.error('[openModelMapSettings] modal element not found');
    return;
  }
  // 同步当前配置到 input
  const prefixInput = document.getElementById('model-name-prefix-modal');
  const suffixInput = document.getElementById('model-name-suffix-modal');
  const tplInput = document.getElementById('model-label-template-modal');
  if (prefixInput) prefixInput.value = modelMapStore.namePrefix || '';
  const currentTpl = modelMapStore.labelTemplate || '';
  const simpleSuffix = suffixFromSimpleLabelTemplate(currentTpl);
  labelTemplateModalMode = simpleSuffix === null ? 'custom' : 'simple';
  if (suffixInput) suffixInput.value = simpleSuffix === null ? '' : simpleSuffix;
  if (tplInput) tplInput.value = simpleSuffix === null ? (currentTpl || DEFAULT_LABEL_TEMPLATE) : composeSimpleLabelTemplate(simpleSuffix);
  const advanced = document.getElementById('label-template-advanced');
  if (advanced) advanced.open = labelTemplateModalMode === 'custom';
  // 渲染预览
  updateModalLabelTemplatePreview();
  modal.classList.add('is-open');
}

function closeModelMapSettings() {
  const modal = document.getElementById('modelMapSettingsModal');
  if (modal) modal.classList.remove('is-open');
}

function onModalSimpleLabelInput() {
  labelTemplateModalMode = 'simple';
  const tplInput = document.getElementById('model-label-template-modal');
  const suffixInput = document.getElementById('model-name-suffix-modal');
  if (tplInput) tplInput.value = composeSimpleLabelTemplate(suffixInput ? suffixInput.value : '');
  updateModalLabelTemplatePreview();
}

function onModalAdvancedLabelTemplateInput() {
  labelTemplateModalMode = 'custom';
  updateModalLabelTemplatePreview();
}

function onLabelTemplateAdvancedToggle() {
  const advanced = document.getElementById('label-template-advanced');
  const tplInput = document.getElementById('model-label-template-modal');
  if (advanced && advanced.open && labelTemplateModalMode !== 'custom' && tplInput) {
    tplInput.value = currentModalLabelTemplate();
  }
}

// 兼容旧的事件名
function onModalLabelTemplateInput() {
  updateModalLabelTemplatePreview();
}

// 模态框里输入变化 → 实时刷新预览
function updateModalLabelTemplatePreview() {
  const tplInput = document.getElementById('model-label-template-modal');
  const tpl = currentModalLabelTemplate();
  const preview = document.getElementById('label-template-preview');
  if (!preview) return;
  if (labelTemplateModalMode === 'simple' && tplInput) tplInput.value = tpl;
  const prefixInput = document.getElementById('model-name-prefix-modal');
  const prefix = prefixInput ? prefixInput.value.trim() : '';
  const cases = [
    { from: 'Claude Opus 4.8', label: 'Claude Opus 4.8', provider: '君の公益', apiModel: 'claude-opus-4-8' },
    { from: 'Gemini 3 Flash', label: 'Gemini 3 Flash', provider: '黑鸟白', apiModel: 'gemini-3-flash' },
    { from: 'GLM 5.1', label: 'GLM 5.1', provider: '', apiModel: 'glm-5-1' },
  ];
  const html = cases.map(c => {
    const out = renderLabelTemplate(tpl, { prefix, ...c });
    return `<div style="display:grid;grid-template-columns:minmax(120px,1fr) 16px minmax(220px,1.4fr);gap:8px;align-items:center;line-height:1.5;min-width:0;">
      <span style="color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.from)}</span>
      <span style="color:var(--text-muted);text-align:center;">→</span>
      <span style="color:var(--text-primary);font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(out)}">${escapeHtml(out)}</span>
    </div>`;
  }).join('');
  preview.innerHTML = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">保存后列表会这样显示：</div>${html}`;
}

// 模态框保存按钮:同步两个字段 + 持久化 + 重新渲染列表
async function saveModelMapSettingsFromModal() {
  const prefixInput = document.getElementById('model-name-prefix-modal');
  const suffixInput = document.getElementById('model-name-suffix-modal');
  const tplInput = document.getElementById('model-label-template-modal');
  const newPrefix = prefixInput ? prefixInput.value.trim() : '';
  const newTpl = labelTemplateForStoreFromModal();
  const prevPrefix = modelMapStore.namePrefix || '';
  const prevTpl = modelMapStore.labelTemplate || '';
  let changed = false;
  if (newPrefix !== prevPrefix) { modelMapStore.namePrefix = newPrefix; changed = true; }
  if (newTpl !== prevTpl) { modelMapStore.labelTemplate = newTpl; changed = true; }
  if (!changed) {
    addLog('info', '未改动');
    closeModelMapSettings();
    return;
  }
  if (await persistModelMap()) {
    await renderModelMap();
    const parts = [];
    if (newPrefix !== prevPrefix) parts.push(newPrefix ? `前缀=${newPrefix}` : '清除前缀');
    if (newTpl !== prevTpl) {
      if (labelTemplateModalMode === 'custom') {
        parts.push(newTpl ? `高级格式=${newTpl}` : '默认格式');
      } else {
        const suffix = suffixInput ? suffixInput.value.trim() : '';
        parts.push(suffix ? `后缀=${suffix}` : '清除后缀');
      }
    }
    addLog('ok', '已保存显示设置: ' + parts.join(' / '));
    closeModelMapSettings();
  } else {
    // 持久化失败 → 回滚
    modelMapStore.namePrefix = prevPrefix;
    modelMapStore.labelTemplate = prevTpl;
    if (prefixInput) prefixInput.value = prevPrefix;
    if (tplInput) tplInput.value = prevTpl;
    const prevSuffix = suffixFromSimpleLabelTemplate(prevTpl);
    if (suffixInput) suffixInput.value = prevSuffix === null ? '' : prevSuffix;
    labelTemplateModalMode = prevSuffix === null ? 'custom' : 'simple';
  }
}

// ─── 模型槽位管理（旧字段 injected，解锁 Windsurf 灰色模型）───
// modelMapStore.injected: [{ label, modelUid, providerId, model, supportsImages }]
// 加载时确保存在（兼容旧 model-map.json）
let injectedCatalog = null;     // 128 模型内置目录（首次调用时加载）

const UNLOCK_SCOPE_LABELS = {
  all: '全部槽位',
  common: '常用槽位',
  claude: 'Claude',
  gpt: 'GPT / Codex',
  gemini: 'Gemini',
  code: 'Code / SWE',
  configured: '已配置 BYOK',
};

function normalizeUnlockScope(mode) {
  return Object.prototype.hasOwnProperty.call(UNLOCK_SCOPE_LABELS, mode) ? mode : 'all';
}

function updateSlotPolicySummary() {
  const summary = document.getElementById('slot-policy-summary');
  if (!summary) return;
  const injected = Array.isArray(modelMapStore.injected) ? modelMapStore.injected : [];
  const byokCount = injected.filter(x => x && x.providerId && String(x.model || '').trim()).length;
  const managedCount = injected.length;
  const scope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  const parts = [`解锁范围：${UNLOCK_SCOPE_LABELS[scope] || UNLOCK_SCOPE_LABELS.all}`];
  if (managedCount > 0) parts.push(`托管 ${managedCount}`);
  if (byokCount > 0) parts.push(`BYOK ${byokCount}`);
  summary.textContent = parts.join(' · ');
}

async function setSlotDisplayMode(mode) {
  modelMapStore.unlockScope = normalizeUnlockScope(mode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope; // 兼容旧 sidecar / 旧配置
  const select = document.getElementById('slot-display-mode');
  if (select) select.value = modelMapStore.unlockScope;
  updateSlotPolicySummary();
  addLog('info', '模型槽位解锁范围已切换，保存后生效');
}

function modelSlotSkeletonHtml(rows = 9) {
  const body = Array.from({ length: rows }, (_, idx) => `
    <div class="model-slot-skeleton-row" aria-hidden="true">
      <span class="model-slot-skeleton-check" style="--delay:${idx * 45}ms"></span>
      <span class="model-slot-skeleton-line name" style="--delay:${idx * 45 + 40}ms"></span>
      <span class="model-slot-skeleton-line uid" style="--delay:${idx * 45 + 80}ms"></span>
      <span class="model-slot-skeleton-line provider" style="--delay:${idx * 45 + 120}ms"></span>
      <span class="model-slot-skeleton-line model" style="--delay:${idx * 45 + 160}ms"></span>
    </div>`).join('');
  return `
    <div class="model-slot-skeleton" role="status" aria-label="正在加载模型槽位目录">
      <div class="model-slot-skeleton-header">
        <span></span>
        <span>模型名</span>
        <span>modelUid</span>
        <span>供应商</span>
        <span>model 字段</span>
      </div>
      ${body}
    </div>`;
}

async function ensureInjected() {
  if (injectedCatalog) return injectedCatalog;
  try {
    const res = await invoke('list_windsurf_catalog');
    injectedCatalog = (res && Array.isArray(res.models)) ? res.models : [];
  } catch (e) {
    console.error('加载 Windsurf 模型目录失败:', e);
    injectedCatalog = [];
  }
  return injectedCatalog;
}

async function openInjectedEditor() {
  // 确保 modelMapStore.injected 存在
  if (!Array.isArray(modelMapStore.injected)) modelMapStore.injected = [];
  const modal = document.getElementById('injectedModal');
  const list = document.getElementById('injected-list');
  if (!modal) return;
  modal.classList.add('is-open');
  document.getElementById('injected-search').value = '';
  document.getElementById('injected-filter').value = 'all';
  modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
  const displayMode = document.getElementById('slot-display-mode');
  if (displayMode) displayMode.value = modelMapStore.unlockScope;
  updateSlotPolicySummary();
  if (list) {
    list.innerHTML = modelSlotSkeletonHtml();
  }
  try {
    await renderInjectedList();
  } catch (e) {
    console.error('渲染模型槽位失败:', e);
    addLog('warn', '加载模型槽位管理失败: ' + e);
    if (list) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--warn,#d97706);font-size:12px;">模型槽位目录加载失败，请检查内置 catalog 资源或重启应用。</div>';
    }
  }
}

function closeInjectedEditor() {
  const modal = document.getElementById('injectedModal');
  if (modal) modal.classList.remove('is-open');
}

async function renderInjectedList() {
  const list = document.getElementById('injected-list');
  if (!list) return;
  const catalog = await ensureInjected();
  const injected = modelMapStore.injected || [];
  const injectedByUid = new Map(injected.map(i => [i.modelUid, i]));
  const query = (document.getElementById('injected-search').value || '').toLowerCase().trim();
  const filter = document.getElementById('injected-filter').value;

  // 收集 provider 列表
  let providers = [];
  try {
    const res = await invoke('list_providers');
    providers = (res && Array.isArray(res.providers)) ? res.providers : [];
  } catch (e) {
    console.error('加载供应商列表失败:', e);
  }
  const providerOptions = providers.map(p => `<option value="${escAttr(p.id)}">${escAttr(p.name)}</option>`).join('');

  // 过滤 + 渲染
  const rows = catalog.filter(m => {
    const cur = injectedByUid.get(m.modelUid);
    const byokConfigured = !!(cur && cur.providerId && String(cur.model || '').trim());
    if (filter === 'configured' && !byokConfigured) return false;
    if (filter === 'unconfigured' && byokConfigured) return false;
    if (!query) return true;
    return m.label.toLowerCase().includes(query)
        || m.modelUid.toLowerCase().includes(query)
        || (m.apiId || '').toLowerCase().includes(query);
  });

  updateSlotPolicySummary();
  const badge = document.getElementById('injected-count-badge');
  if (badge) badge.textContent = '模型槽位管理';

  if (rows.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">无匹配模型</div>';
    return;
  }

  list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead style="position:sticky;top:0;background:var(--bg-secondary,#1a1a1a);z-index:1;">
      <tr style="border-bottom:1px solid var(--border);">
        <th style="padding:8px;text-align:left;width:24px;"></th>
        <th style="padding:8px;text-align:left;">模型名</th>
        <th style="padding:8px;text-align:left;width:280px;">modelUid</th>
        <th style="padding:8px;text-align:left;width:160px;">供应商</th>
        <th style="padding:8px;text-align:left;width:160px;">model 字段</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(m => {
        const cur = injectedByUid.get(m.modelUid);
        const isManaged = !!cur;
        const sel = cur && cur.providerId ? cur.providerId : '';
        const mdl = (cur && cur.model) || m.apiId || '';
        const hint = m.noApiIdHint ? `<span style="color:var(--warn,#d97706);font-size:10px;" title="${escAttr(m.noApiIdHint)}">需要手填</span>` : '';
        return `<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:6px 8px;">
            <input type="checkbox" data-uid="${escAttr(m.modelUid)}" ${isManaged ? 'checked' : ''} onchange="onInjectedToggle('${escAttr(m.modelUid)}', this.checked)">
          </td>
          <td style="padding:6px 8px;">
            <div style="font-weight:600;">${escAttr(m.label)}</div>
            ${hint}
          </td>
          <td style="padding:6px 8px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escAttr(m.modelUid)}</td>
          <td style="padding:6px 8px;">
            <select data-uid="${escAttr(m.modelUid)}" data-field="providerId" onchange="onInjectedFieldChange('${escAttr(m.modelUid)}', 'providerId', this.value)" style="width:100%;padding:3px 6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-primary);border-radius:6px;font-size:11px;">
              <option value="">— 未配置 —</option>
              ${providerOptions.replace(`value="${escAttr(sel)}"`, `value="${escAttr(sel)}" selected`)}
            </select>
          </td>
          <td style="padding:6px 8px;">
            <input type="text" data-uid="${escAttr(m.modelUid)}" data-field="model" value="${escAttr(mdl)}" placeholder="${m.apiId ? escAttr(m.apiId) : '如 claude-opus-4-8'}" onblur="onInjectedFieldChange('${escAttr(m.modelUid)}', 'model', this.value)" style="width:100%;padding:3px 6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-primary);border-radius:6px;font-size:11px;font-family:var(--font-mono);">
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function onInjectedToggle(uid, checked) {
  if (!Array.isArray(modelMapStore.injected)) modelMapStore.injected = [];
  let entry = modelMapStore.injected.find(x => x.modelUid === uid);
  if (checked && !entry) {
    // 从 catalog 找
    const m = (injectedCatalog || []).find(x => x.modelUid === uid);
    if (!m) return;
    entry = {
      label: m.label,
      modelUid: m.modelUid,
      providerId: '',
      model: m.apiId || '',
      supportsImages: m.supportsImages !== false,
    };
    modelMapStore.injected.push(entry);
  } else if (!checked && entry) {
    // 取消勾选 = 删除模型槽位配置
    modelMapStore.injected = modelMapStore.injected.filter(x => x.modelUid !== uid);
  }
  updateSlotPolicySummary();
  const badge = document.getElementById('injected-count-badge');
  if (badge) badge.textContent = '模型槽位管理';
}

function onInjectedFieldChange(uid, field, value) {
  let entry = (modelMapStore.injected || []).find(x => x.modelUid === uid);
  if (!entry) return;
  entry[field] = value;
  updateSlotPolicySummary();
}

async function saveInjectedFromEditor() {
  // 校验:已选 providerId 的必须有 model
  modelMapStore.unlockScope = normalizeUnlockScope(modelMapStore.unlockScope || modelMapStore.slotDisplayMode);
  modelMapStore.slotDisplayMode = modelMapStore.unlockScope;
  for (const i of (modelMapStore.injected || [])) {
    if (i.providerId && (!i.model || !i.model.trim())) {
      showCustomAlert(`模型槽位「${i.label}」已选供应商但 model 为空，请填写后再保存`, '保存失败', 'warn');
      return;
    }
  }
  if (await persistModelMap()) {
    addLog('ok', `已保存 ${modelMapStore.injected.length} 个模型槽位配置`);
    closeInjectedEditor();
  }
}

async function toggleSlotEnabled(uid) {
  const key = 'slot:' + uid;
  if (_inFlightToggles.has(key)) return;
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!s) return;
  s.enabled = !(s.enabled !== false);
  _inFlightToggles.add(key);
  try {
    if (await persistModelMap()) { await renderModelMap(); }
    else { s.enabled = !s.enabled; }
  } finally {
    _inFlightToggles.delete(key);
  }
}

async function deleteSlot(uid) {
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!(await showCustomConfirm(`确定删除映射「${s ? (s.displayName || originalNameOf(uid)) : uid}」？`, '删除确认', 'warn'))) return;
  modelMapStore.slots = modelMapStore.slots.filter(x => x.modelUid !== uid);
  if (await persistModelMap()) { await renderModelMap(); addLog('info', '已删除映射'); }
}

// ─── 添加映射模态框 ───
let selectedSlotUid = '';
let selectedMappingTargets = []; // [{providerId, model}]
let slotCatalogScope = 'account';
let slotWasManuallySelected = false;

function getAllProviderModels() {
  const list = [];
  (providerStore.providers || []).forEach(p => {
    if (p.enabled !== false) {
      const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : (p.defaultModel ? [p.defaultModel] : []);
      models.forEach(m => {
        list.push({
          providerId: p.id,
          providerName: p.name,
          model: m
        });
      });
    }
  });
  return list;
}

function getProviderLogoClass(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('anthropic') || lower.includes('claude')) return 'logo-anthropic';
  if (lower.includes('openai')) return 'logo-openai';
  if (lower.includes('deepseek')) return 'logo-deepseek';
  if (lower.includes('gemini') || lower.includes('google')) return 'logo-gemini';
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'logo-kimi';
  if (lower.includes('xai') || lower.includes('grok')) return 'logo-xai';
  if (lower.includes('qwen') || lower.includes('ali')) return 'logo-qwen';
  if (lower.includes('doubao') || lower.includes('bytedance')) return 'logo-doubao';
  return 'logo-openai'; // fallback
}

function renderMappingModelCatalog() {
  const query = (document.getElementById('mappingModelSearch')?.value || '').toLowerCase().trim();
  const body = document.getElementById('mappingModelCatalogBody');
  if (!body) return;

  const allModels = getAllProviderModels();
  const filtered = allModels.filter(item => {
    return !query ||
           item.providerName.toLowerCase().includes(query) ||
           item.model.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    if (allModels.length === 0) {
      body.innerHTML = `
        <div style="text-align:center; color:var(--text-muted); padding:32px 0; font-size:12px;">
          暂无可用映射模型。请先在「供应商」页面添加并启用供应商。
        </div>`;
    } else {
      body.innerHTML = `
        <div style="text-align:center; color:var(--text-muted); padding:32px 0; font-size:12px;">
          暂无匹配的模型
        </div>`;
    }
    return;
  }

  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

  body.innerHTML = filtered.map(item => {
    // Find if selected
    const idx = selectedMappingTargets.findIndex(t => t.providerId === item.providerId && t.model === item.model);
    const isSelected = idx >= 0;

    let badgeText = '';
    let badgeColor = '';
    if (isSelected) {
      if (idx === 0) {
        badgeText = '主映射';
        badgeColor = 'var(--accent)';
      } else {
        badgeText = `备选 ${marks[idx - 1] || idx}`;
        badgeColor = 'var(--accent-secondary)';
      }
    }

    const logoChar = item.providerName.charAt(0).toUpperCase();
    const logoClass = getProviderLogoClass(item.providerName);

    return `
      <div class="mapping-catalog-item ${isSelected ? 'selected' : ''}"
           onclick="toggleMappingModelTarget('${escAttr(item.providerId)}', '${escAttr(item.model)}')"
           style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}; background:${isSelected ? 'var(--accent-light)' : 'var(--bg-card)'}; cursor:pointer; border-radius:10px; gap:12px; transition:all 0.2s; box-shadow:${isSelected ? '0 0 12px var(--accent-glow)' : 'none'};">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          <div class="provider-logo ${logoClass}" style="width:28px; height:28px; font-size:12px; border-radius:6px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-weight:800;">
            ${escAttr(logoChar)}
          </div>
          <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
            <span style="font-size:12px; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${escAttr(item.model)}
            </span>
            <span style="font-size:10px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${escAttr(item.providerName)}
            </span>
          </div>
        </div>
        <div style="flex-shrink:0; display:flex; align-items:center; gap:6px;">
          ${isSelected ? `
            <span class="brand-tag" style="background:${badgeColor}; color:#fff; border:none; padding: 2px 8px; font-size: 10px; font-weight:700; border-radius: var(--radius-pill);">
              ${badgeText}
            </span>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function toggleMappingModelTarget(providerId, model) {
  const idx = selectedMappingTargets.findIndex(t => t.providerId === providerId && t.model === model);
  if (idx >= 0) {
    // Remove
    selectedMappingTargets.splice(idx, 1);
  } else {
    // Add
    selectedMappingTargets.push({ providerId, model });
  }
  renderMappingModelCatalog();
  maybeAutoSelectRecommendedSlot();
  updateSlotVisionHint();
}

function slotCatalogStats(used) {
  const list = ideModels || [];
  return {
    account: list.filter(isAccountSlotModel).length,
    extended: list.filter(m => !isAccountSlotModel(m)).length,
    all: list.length,
    bound: list.filter(m => used.has(m.id)).length,
  };
}

function updateSlotScopeTabs(used) {
  const stats = slotCatalogStats(used);
  const ids = {
    account: 'slotScopeAccountCount',
    extended: 'slotScopeExtendedCount',
    all: 'slotScopeAllCount',
    bound: 'slotScopeBoundCount',
  };
  Object.entries(ids).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = stats[key];
  });
  document.querySelectorAll('.slot-scope-tab').forEach(btn => {
    const active = btn.dataset.scope === slotCatalogScope;
    btn.style.background = active ? 'var(--bg-card)' : 'var(--bg-input)';
    btn.style.color = active ? 'var(--text-primary)' : 'var(--text-muted)';
    btn.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    btn.style.boxShadow = active ? 'var(--shadow-sm)' : 'none';
  });
}

function setSlotCatalogScope(scope) {
  slotCatalogScope = scope || 'account';
  const editUid = document.getElementById('slot-edit-uid')?.value || '';
  if (!editUid) {
    const used = new Set(modelMapStore.slots.map(x => x.modelUid));
    const current = slotModelOf(selectedSlotUid);
    if (!current || !slotMatchesScope(current, used)) {
      const next = (ideModels || [])
        .filter(m => !used.has(m.id) && slotMatchesScope(m, used))
        .sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || a.name.localeCompare(b.name))[0];
      if (next) {
        selectedSlotUid = next.id;
        const selectEl = document.getElementById('slot-uid-select');
        if (selectEl) selectEl.value = next.id;
        slotWasManuallySelected = false;
      }
    }
  }
  renderSlotCatalogList();
  updateSlotVisionHint();
}

function slotMatchesScope(m, used) {
  if (slotCatalogScope === 'account') return isAccountSlotModel(m);
  if (slotCatalogScope === 'extended') return !isAccountSlotModel(m);
  if (slotCatalogScope === 'bound') return used.has(m.id);
  return true;
}

function slotRecommendationRank(m, used) {
  let score = 0;
  if (used.has(m.id)) score += 1000;
  if (isAccountSlotModel(m)) score -= 40;
  const targetVision = targetsSupportVision(selectedMappingTargets);
  const native = nativeVisionSlotInfo(m.id);
  if (targetVision) {
    if (native.ok === true) score -= 80;
    else if (native.ok === false) score += 80;
    else score += 20;
  }
  if (m.common) score -= 5;
  return score;
}

function pickRecommendedSlot(used) {
  const available = (ideModels || []).filter(m => !used.has(m.id));
  const accountAvailable = available.filter(isAccountSlotModel);
  const pool = accountAvailable.length ? accountAvailable : available;
  return pool
    .slice()
    .sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || a.name.localeCompare(b.name))
    [0] || null;
}

function maybeAutoSelectRecommendedSlot() {
  if (slotWasManuallySelected) return;
  const editUid = document.getElementById('slot-edit-uid')?.value || '';
  if (editUid) return;
  const used = new Set(modelMapStore.slots.map(x => x.modelUid));
  const recommended = pickRecommendedSlot(used);
  if (!recommended) return;
  selectedSlotUid = recommended.id;
  const selectEl = document.getElementById('slot-uid-select');
  if (selectEl) selectEl.value = recommended.id;
  if (slotCatalogScope === 'account' && !isAccountSlotModel(recommended)) {
    slotCatalogScope = 'extended';
  }
  renderSlotCatalogList();
}

function renderSlotCatalogList() {
  const query = (document.getElementById('slotCatalogSearch')?.value || '').toLowerCase().trim();
  const body = document.getElementById('slotCatalogBody');
  const countEl = document.getElementById('slotCatalogCount');
  if (!body) return;

  // 重新收集 used 集合
  const editingUid = document.getElementById('slot-edit-uid').value;
  const used = new Set(modelMapStore.slots.map(x => x.modelUid));
  if (editingUid) used.delete(editingUid);
  updateSlotScopeTabs(used);

  // 1. 基于 query 搜索过滤
  const filtered = (ideModels || [])
    .filter(m => slotMatchesScope(m, used))
    .filter(m => {
      const hay = `${m.name || ''} ${m.id || ''} ${m.api_id || ''}`.toLowerCase();
      return !query || hay.includes(query);
    })
    .sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || a.name.localeCompare(b.name));

  // 2. 统计可用未占用的槽位数量
  const availableCount = filtered.filter(m => !used.has(m.id)).length;
  if (countEl) countEl.textContent = `${availableCount} 可用 / ${filtered.length} 显示`;

  if (filtered.length === 0) {
    if (slotCatalogScope === 'account') {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;color:var(--text-muted);padding:30px 16px;font-size:12px;line-height:1.55;">
          <div style="font-weight:700;color:var(--text-secondary);">还没有当前账号槽位数据</div>
          <div>点击刷新可读取当前 IDE 账号实际模型；也可以先查看内置槽位。</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
            <button class="btn-ghost" onclick="refreshIdeModels()" style="height:30px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:700;">刷新当前账号</button>
            <button class="btn-primary" onclick="setSlotCatalogScope('extended')" style="height:30px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:700;">启用内置槽位</button>
          </div>
        </div>`;
    } else {
      body.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:32px 0; font-size:12px;">暂无匹配的槽位</div>';
    }
    return;
  }

  body.innerHTML = filtered.map(m => {
    const isSelected = selectedSlotUid === m.id;
    const taken = used.has(m.id);
    const takenTag = taken ? `<span class="brand-tag" style="background:var(--bg-secondary); color:var(--text-muted); border: 1px solid var(--border); padding: 1px 6px; font-size: 9px; font-weight:normal;">已绑定</span>` : '';
    const displayId = m.api_id || m.id;
    const visionTag = renderVisionPill(nativeVisionSlotInfo(m.id), true);
    const sourceTag = renderSourcePill(slotSourceInfo(m), true);
    const recommended = !taken && slotRecommendationRank(m, used) < 0;
    const recommendedTag = recommended ? `<span class="brand-tag" style="background:rgba(37,99,235,.10);color:var(--accent);border:1px solid rgba(37,99,235,.22);padding:1px 6px;font-size:9px;font-weight:700;">推荐</span>` : '';

    // 渲染具有极致质感的左侧行卡片，支持选中态发光与锁定态置灰
    return `
      <div class="slot-catalog-item ${isSelected ? 'selected' : ''} ${taken ? 'taken' : ''}"
           onclick="${taken ? '' : `selectCatalogSlot('${escAttr(m.id)}', '${escAttr(m.name)}')`}"
           style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}; background:${isSelected ? 'var(--accent-light)' : 'var(--bg-card)'}; opacity:${taken ? '0.5' : '1'}; cursor:${taken ? 'not-allowed' : 'pointer'}; border-radius:10px; gap:12px; transition:all 0.2s; box-shadow:${isSelected ? '0 0 12px var(--accent-glow)' : 'none'};">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          <!-- 槽位精致小魔方图标 -->
          <div style="width:24px; height:24px; border-radius:6px; background:${isSelected ? 'var(--accent)' : 'var(--bg-secondary)'}; color:${isSelected ? '#fff' : 'var(--text-secondary)'}; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.2s;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
          </div>
          <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
            <span style="font-size:12px; font-weight:600; color:${isSelected ? 'var(--accent)' : 'var(--text-primary)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:all 0.2s;">${escAttr(m.name)}</span>
            <span style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escAttr(displayId)}</span>
          </div>
        </div>
        <div style="flex-shrink:0; display:flex; align-items:center; gap:6px;">
          ${sourceTag}
          ${visionTag}
          ${recommendedTag}
          ${takenTag}
          ${isSelected ? `<span style="font-size:13px; color:var(--accent); font-weight:bold; margin-left:4px;">✓</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function selectCatalogSlot(uid, name) {
  const editingUid = document.getElementById('slot-edit-uid').value;
  if (editingUid) return; // 编辑状态下，槽位只读（原逻辑 sel.disabled = true）

  selectedSlotUid = uid;
  slotWasManuallySelected = true;

  // 更新隐藏的 select 元素的值，从而保证 saveSlotFromEditor 的无损兼容性！
  const selectEl = document.getElementById('slot-uid-select');
  if (selectEl) selectEl.value = uid;

  // 更新右侧的立体预览卡片
  const nameEl = document.getElementById('selectedSlotName');
  const idEl = document.getElementById('selectedSlotId');
  if (nameEl) nameEl.textContent = name;
  if (idEl) idEl.textContent = uid;

  // 重新绘制左侧以更新高亮
  renderSlotCatalogList();
  updateSlotVisionHint();
}

function filterSlotCatalog() {
  renderSlotCatalogList();
}

async function openSlotEditor(uid) {
  ideModels = null;
  ideMeta = null;
  await ensureIdeModels();
  await ensureInjected();
  const modal = document.getElementById('slotModal');
  const sel = document.getElementById('slot-uid-select');
  const editing = uid ? modelMapStore.slots.find(x => x.modelUid === uid) : null;
  document.getElementById('slotModalTitle').textContent = editing ? '编辑映射' : '添加映射';
  document.getElementById('slot-edit-uid').value = editing ? editing.modelUid : '';

  // 已被占用的 uid（编辑时排除自身）
  const used = new Set(modelMapStore.slots.map(x => x.modelUid));
  if (editing) used.delete(editing.modelUid);

  const opts = (ideModels || []).map(m => {
    const taken = used.has(m.id) ? ' （已映射）' : '';
    const displayId = m.api_id || m.id;
    return `<option value="${escAttr(m.id)}"${used.has(m.id) ? ' disabled' : ''}>${escAttr(m.name)} · ${escAttr(displayId)}${taken}</option>`;
  }).join('');

  // 1. 重置搜索框
  const searchInput = document.getElementById('slotCatalogSearch');
  if (searchInput) searchInput.value = '';

  const mappingSearch = document.getElementById('mappingModelSearch');
  if (mappingSearch) mappingSearch.value = '';

  // 2. 槽位状态选中管理 (若是编辑态锁定自身，若是新建态默认选中首个空闲槽位)
  if (editing) {
    selectedSlotUid = editing.modelUid;
    slotWasManuallySelected = true;
    slotCatalogScope = slotSourceInfo(editing.modelUid).state === 'account' ? 'account' : 'extended';
  } else {
    slotCatalogScope = 'account';
    slotWasManuallySelected = false;
    selectedSlotUid = '';
    if (ideModels && ideModels.length > 0) {
      const firstAvailable = (ideModels || [])
        .filter(m => isAccountSlotModel(m) && !used.has(m.id))
        .sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || a.name.localeCompare(b.name))[0];
      if (firstAvailable) selectedSlotUid = firstAvailable.id;
    }
  }

  // 3. 同步至隐藏 select 桥接器
  if (sel) {
    sel.innerHTML = opts || '<option value="">（无可用模型清单）</option>';
    sel.disabled = !!editing;
    if (selectedSlotUid) {
      sel.value = selectedSlotUid;
    } else {
      sel.value = '';
    }
  }

  // 4. 加载已保存的映射列表并绘制右侧平铺目录
  selectedMappingTargets = editing ? (editing.targets ? JSON.parse(JSON.stringify(editing.targets)) : []) : [];
  renderMappingModelCatalog();

  // 5. 重绘左侧平铺卡片目录
  renderSlotCatalogList();

  document.getElementById('slot-display').value = editing ? (editing.displayName || '') : '';
  // supportsImages 默认 true（多数视觉模型免勾），旧槽位无此字段时也视为 true
  document.getElementById('slot-supports-images').checked = editing ? (editing.supportsImages !== false) : true;
  if (modal) modal.classList.add('is-open');
  updateSlotVisionHint();
}

function closeSlotEditor() {
  const modal = document.getElementById('slotModal');
  if (modal) modal.classList.remove('is-open');
}

async function saveSlotFromEditor() {
  const editUid = document.getElementById('slot-edit-uid').value;
  const uid = editUid || document.getElementById('slot-uid-select').value;
  const display = document.getElementById('slot-display').value.trim();
  const supportsImages = document.getElementById('slot-supports-images').checked;
  if (!uid) { addLog('warn', '请选择模型槽位'); return; }

  const vision = slotVisionAssessment(uid, selectedMappingTargets, supportsImages);
  if (vision.state === 'risk') {
    const alts = visionSafeAlternatives(uid, 3).map(m => `「${m.name}」`).join('、');
    const suffix = alts ? `\n\n建议改用原生视觉槽：${alts}` : '';
    const ok = await showCustomConfirm(
      `当前槽位「${originalNameOf(uid)}」不适合图片任务，即使目标模型支持 Vision，Windsurf 也可能不会上传图片。\n\n继续保存后，文字聊天仍可用，但看图大概率失败。${suffix}`,
      '图片能力提醒',
      'warn'
    );
    if (!ok) return;
  }

  if (editUid) {
    const s = modelMapStore.slots.find(x => x.modelUid === editUid);
    if (s) {
      s.displayName = display;
      s.supportsImages = supportsImages;
      s.targets = JSON.parse(JSON.stringify(selectedMappingTargets));
    }
  } else {
    if (modelMapStore.slots.some(x => x.modelUid === uid)) {
      showCustomAlert('该槽位已存在映射，请勿重复添加。', '添加失败', 'warn');
      return;
    }
    modelMapStore.slots.push({
      modelUid: uid,
      displayName: display,
      enabled: true,
      supportsImages,
      targets: JSON.parse(JSON.stringify(selectedMappingTargets))
    });
  }
  if (await persistModelMap()) {
    closeSlotEditor();
    await renderModelMap();
    addLog('ok', '已保存映射');
  } else {
    // 保存失败（如 modelUid 重复），回滚新增
    if (!editUid) modelMapStore.slots = modelMapStore.slots.filter(x => x.modelUid !== uid);
  }
}

// ─── 故障转移配置模态框 ───
let failoverEditUid = '';
let failoverDraft = [];   // [{providerId, model}]

function enabledProviders() {
  return (providerStore.providers || []).filter(p => p.enabled !== false);
}

function openFailoverEditor(uid) {
  const s = modelMapStore.slots.find(x => x.modelUid === uid);
  if (!s) return;
  failoverEditUid = uid;
  failoverDraft = (s.targets || []).map(t => ({ providerId: t.providerId, model: t.model }));
  document.getElementById('failoverModalSlot').textContent = s.displayName || originalNameOf(uid);
  renderFailoverRows();
  const modal = document.getElementById('failoverModal');
  if (modal) modal.classList.add('is-open');
}

function closeFailoverEditor() {
  const modal = document.getElementById('failoverModal');
  if (modal) modal.classList.remove('is-open');
}

function renderFailoverRows() {
  const wrap = document.getElementById('failoverRows');
  const empty = document.getElementById('failoverEmpty');
  if (!wrap) return;
  const provs = enabledProviders();
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  if (empty) empty.style.display = failoverDraft.length ? 'none' : 'block';

  wrap.innerHTML = failoverDraft.map((row, i) => {
    const provOpts = provs.map(p =>
      `<option value="${escAttr(p.id)}"${p.id === row.providerId ? ' selected' : ''}>${escAttr(p.name)}</option>`
    ).join('');
    // 当前 providerId 已失效（被禁用/删除）时补一项以保持可见
    const cur = provs.find(p => p.id === row.providerId);
    const invalidOpt = (!cur && row.providerId)
      ? `<option value="${escAttr(row.providerId)}" selected>（已失效）${escAttr(row.providerId)}</option>`
      : '';

    // 获取当前供应商支持的模型列表
    const modelsOfProv = [];
    if (cur) {
      if (Array.isArray(cur.models) && cur.models.length > 0) {
        modelsOfProv.push(...cur.models);
      } else if (cur.defaultModel) {
        modelsOfProv.push(cur.defaultModel);
      }
    }
    // 如果当前配置的模型不在列表中，且不为空，则追加展示，防止丢失已配好的模型
    if (row.model && !modelsOfProv.includes(row.model)) {
      modelsOfProv.push(row.model);
    }

    const modelOpts = modelsOfProv.map(m =>
      `<option value="${escAttr(m)}"${m === row.model ? ' selected' : ''}>${escAttr(m)}</option>`
    ).join('');
    const capLine = cur
      ? `<div style="margin-left:28px; display:flex; gap:4px; flex-wrap:wrap;">${capabilityBadges(cur, true, row.model || cur.defaultModel || null)}</div>`
      : '';

    return `
      <div style="display:flex;flex-direction:column;gap:6px" data-fo-idx="${i}">
        <div style="display:flex;gap:8px;align-items:center">
          <span style="width:20px;text-align:center;color:var(--text-muted)">${marks[i] || (i + 1)}</span>
          <select class="input-sm" style="flex:1" onchange="updateFailoverRow(${i},'providerId',this.value)">${invalidOpt}${provOpts}</select>
          <select class="input-sm" style="flex:1; text-align: left;" onchange="updateFailoverRow(${i},'model',this.value)">
            <option value=""${!row.model ? ' selected' : ''}>默认模型</option>
            ${modelOpts}
            <option value="__custom__">+ 输入自定义模型...</option>
          </select>
          <button class="btn-ghost" title="上移" onclick="moveFailoverRow(${i},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-ghost" title="下移" onclick="moveFailoverRow(${i},1)" ${i === failoverDraft.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn-ghost" title="删除" onclick="removeFailoverRow(${i})">✕</button>
        </div>
        ${capLine}
      </div>`;
  }).join('');
}

function addFailoverRow() {
  const provs = enabledProviders();
  const def = provs[0];
  failoverDraft.push({ providerId: def ? def.id : '', model: def ? (def.defaultModel || '') : '' });
  renderFailoverRows();
}

function updateFailoverRow(idx, key, val) {
  if (!failoverDraft[idx]) return;

  if (key === 'model' && val === '__custom__') {
    const oldVal = failoverDraft[idx].model;
    setTimeout(() => {
      const customVal = prompt('请输入自定义模型 ID：', oldVal);
      if (customVal && customVal.trim()) {
        failoverDraft[idx].model = customVal.trim();
      } else if (customVal === '') {
        failoverDraft[idx].model = '';
      } else {
        // 用户点击取消，恢复旧值
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
      const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : (p.defaultModel ? [p.defaultModel] : []);
      // 如果当前模型不在新供应商的可用模型中，则自动切换到新供应商的默认/首个模型
      if (!failoverDraft[idx].model || !models.includes(failoverDraft[idx].model)) {
        failoverDraft[idx].model = p.defaultModel || (models[0] || '');
      }
    } else {
      failoverDraft[idx].model = '';
    }
    renderFailoverRows();
  }
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
    .map(r => ({ providerId: r.providerId, model: (r.model || '').trim() }));
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
