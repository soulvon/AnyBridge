// model-map/slot-editor-form.js — 槽位编辑表单校验、上下文窗口推荐与保存提交
import { escapeHtml, escAttr } from '../ui/dom.js';
import { THINKING_EFFORT_OPTIONS } from './slot-editor-catalog.js';

async function openSlotEditor(uid) {
  // 优先加载本地模型槽位，毫秒级秒开页面，绝不阻塞等待远程网络请求
  await ensureIdeModels();
  await ensureInjected();
  // 后台静默尝试同步最新账号模型列表
  syncCurrentIdeModels().catch(() => {});
  const sel = document.getElementById('slot-uid-select');
  const editing = uid ? modelMapStore.slots.find(x => x.modelUid === uid) : null;
  document.getElementById('slotModalTitle').textContent = editing ? '编辑映射' : '添加映射';
  const subtitleEl = document.getElementById('slotModalSubtitle');
  if (subtitleEl) subtitleEl.textContent = editing ? `正在编辑「${originalNameOf(editing.modelUid)}」` : '选择槽位和映射目标';
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
  } else if (uid && (ideModels || []).some(m => m.id === uid) && !used.has(uid)) {
    selectedSlotUid = uid;
    slotWasManuallySelected = true;
    slotCatalogScope = isAccountSlotModel(slotModelOf(uid)) ? 'account' : 'extended';
  } else {
    slotCatalogScope = 'all';
    slotWasManuallySelected = false;
    selectedSlotUid = '';
    if (ideModels && ideModels.length > 0) {
      const firstAvailable = (ideModels || [])
        .filter(m => !used.has(m.id))
        .sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || a.name.localeCompare(b.name))[0];
      if (firstAvailable) selectedSlotUid = firstAvailable.id;
    }
  }

  // 3. 同步至隐藏 select 桥接器
  if (sel) {
    sel.innerHTML = opts || '<option value="">（无可用模型清单）</option>';
    sel.disabled = false;  // 编辑时也允许切换槽位
    if (selectedSlotUid) {
      sel.value = selectedSlotUid;
    } else {
      sel.value = '';
    }
  }

  // 4. 加载已保存的映射列表并绘制右侧平铺目录
  selectedMappingTargets = editing ? targetsWithSlotRoute(editing.targets, editing.modelUid) : [];
  renderMappingModelCatalog();

  // 5. 重绘左侧平铺卡片目录
  renderSlotCatalogList();

  // 设置显示名：编辑态用已保存的自定义名，新建态默认使用映射模型名
  if (editing) {
    document.getElementById('slot-display').value = editing.displayName || '';
    if (editing.displayName && editing.displayName.trim()) {
      const isOriginalName = editing.displayName.trim() === originalNameOf(editing.modelUid);
      slotDisplayNameMode = isOriginalName ? 'original' : 'mapped';
      updateDisplayNameButtons(slotDisplayNameMode);
      // 编辑态保留用户已保存的显示名，不覆盖
      document.getElementById('slot-display').value = editing.displayName;
    } else {
      slotDisplayNameMode = 'original';
      updateDisplayNameButtons('original');
    }
  } else {
    // 新建：默认使用映射模型名
    slotDisplayNameMode = 'mapped';
    applyDisplayNameByMode();
  }
  setSlotContextWindowInput(editing ? editing.contextWindow : null);
  // 思考档位：编辑态取首个 target 的已存值（本页为槽位级统一设置），新建态默认 auto
  const effortSel = document.getElementById('slot-thinking-effort');
  if (effortSel) {
    const savedEffort = String(editing?.targets?.[0]?.thinkingEffort || editing?.targets?.[0]?.thinking_effort || 'auto').toLowerCase();
    effortSel.value = THINKING_EFFORT_OPTIONS.some(([v]) => v === savedEffort) ? savedEffort : 'auto';
  }
  refreshSlotContextRecommendHint();
  // 切到「添加/编辑映射」普通 page，保持顶部 tab 栏可见
  navigateTo('slot-editor');
}

function closeSlotEditor() {
  // 返回模型映射列表
  navigateTo('models');
}

function setSlotContextWindowInput(value) {
  const el = document.getElementById('slot-context-window');
  if (!el) return;
  const n = Number(value);
  el.value = Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : '';
}

function readSlotContextWindowInput() {
  const el = document.getElementById('slot-context-window');
  if (!el) return null;
  const raw = String(el.value || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function setSlotContextPreset(value) {
  if (value === '' || value == null) {
    setSlotContextWindowInput(null);
    return;
  }
  setSlotContextWindowInput(value);
}

function applySlotContextWindow(slot, contextWindow) {
  if (!slot || typeof slot !== 'object') return;
  if (contextWindow == null) {
    delete slot.contextWindow;
  } else {
    slot.contextWindow = contextWindow;
  }
}

/** 格式化上下文 token：128000 → 128K，1000000 → 1M（与 CodeBuddy 一致） */
function formatSlotContextTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000) {
    const m = n / 1000000;
    const text = Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/\.?0+$/, '');
    return `${text}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    const text = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
    return `${text}K`;
  }
  return String(Math.round(n));
}

/** 推荐上下文的模型 ID：优先首个映射目标 API 模型名 */
function slotContextRecommendModelId() {
  const firstTarget = selectedMappingTargets && selectedMappingTargets[0];
  if (firstTarget && firstTarget.model) return String(firstTarget.model).trim();
  return '';
}

function resolveSlotContextRecommend() {
  const modelId = slotContextRecommendModelId();
  if (!modelId) return null;
  let value = null;
  let source = 'default';
  let note = '';
  if (typeof globalThis.resolveModelContextPreset === 'function') {
    const preset = globalThis.resolveModelContextPreset(modelId) || {};
    const n = Number(preset.maxInputTokens);
    if (Number.isFinite(n) && n > 0) {
      value = Math.trunc(n);
      source = preset.source || 'default';
      note = preset.note || '';
    }
  } else if (typeof globalThis.recommendContextWindow === 'function') {
    const n = Number(globalThis.recommendContextWindow(modelId));
    if (Number.isFinite(n) && n > 0) value = Math.trunc(n);
  }
  if (value == null) return null;
  return { modelId, value, source, note };
}

function refreshSlotContextRecommendHint() {
  const hint = document.getElementById('slot-context-hint');
  const btn = document.getElementById('btn-slot-context-recommend');
  const rec = resolveSlotContextRecommend();
  if (btn) {
    if (rec) {
      const label = formatSlotContextTokens(rec.value) || String(rec.value);
      btn.textContent = `推荐 ${label}`;
      btn.disabled = false;
      btn.title = `按映射模型 ${rec.modelId} 推荐 ${label}`
        + (rec.note ? `\n${rec.note}` : '')
        + '\n（与 CodeBuddy 同源 model-context-presets）';
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    } else {
      btn.textContent = '推荐';
      btn.disabled = true;
      btn.title = '请先选择右侧映射目标模型';
      btn.style.opacity = '0.55';
      btn.style.cursor = 'not-allowed';
    }
  }
  if (hint) {
    if (rec) {
      const label = formatSlotContextTokens(rec.value) || String(rec.value);
      const src = rec.source === 'model' || rec.source === 'pattern' ? '推荐' : '默认';
      hint.textContent = `${src} ${label} · ${rec.modelId}`;
      hint.title = rec.note || 'model-context-presets';
    } else {
      hint.textContent = '留空 = 使用 catalog / 上游原值';
      hint.title = '';
    }
  }
}

function applyRecommendedSlotContextWindow() {
  const rec = resolveSlotContextRecommend();
  if (!rec) {
    if (typeof showBottomToast === 'function') {
      showBottomToast('请先选择映射目标模型', 'warn');
    } else {
      addLog('warn', '请先选择映射目标模型');
    }
    return;
  }
  setSlotContextWindowInput(rec.value);
  const label = formatSlotContextTokens(rec.value) || String(rec.value);
  if (typeof showBottomToast === 'function') {
    showBottomToast(`已填入推荐上下文 ${label}`, 'success');
  }
}

// 读取映射编辑页的思考档位下拉；非法值回落 auto。
function readSlotThinkingEffortInput() {
  const raw = String(document.getElementById('slot-thinking-effort')?.value || 'auto').trim().toLowerCase();
  return THINKING_EFFORT_OPTIONS.some(([v]) => v === raw) ? raw : 'auto';
}

// 槽位编辑页的思考档位是槽位级设置，统一应用到所有选中映射目标。
function applyThinkingEffortToTargets(targets, effort) {
  return (targets || []).map(t => {
    const out = { ...t };
    if (effort && effort !== 'auto') out.thinkingEffort = effort;
    else delete out.thinkingEffort;
    return out;
  });
}

async function saveSlotFromEditor() {
  const editUid = document.getElementById('slot-edit-uid').value;
  const selectedUid = document.getElementById('slot-uid-select').value;
  const uid = selectedUid || editUid;
  const display = document.getElementById('slot-display').value.trim();
  const contextWindow = readSlotContextWindowInput();
  const thinkingEffort = readSlotThinkingEffortInput();
  const supportsImages = true;  // 默认始终启用图片支持
  if (!uid) { addLog('warn', '请选择模型槽位'); return; }

  const previous = cloneModelMapStore();
  if (editUid) {
    // 编辑模式：检查是否切换了槽位
    if (uid !== editUid) {
      // 用户选了不同的槽位，检查新槽位是否已被占用
      if (modelMapStore.slots.some(x => x.modelUid === uid)) {
        showCustomAlert('该槽位已存在映射，请勿重复添加。', '切换失败', 'warn');
        return;
      }
    }
    const s = modelMapStore.slots.find(x => x.modelUid === editUid);
    if (s) {
      s.modelUid = uid;  // 更新槽位 UID（可能和原来一样）
      s.displayName = display;
      s.supportsImages = supportsImages;
      applySlotContextWindow(s, contextWindow);
      s.targets = targetsWithSlotRoute(applyThinkingEffortToTargets(selectedMappingTargets, thinkingEffort), uid);
    }
  } else {
    if (modelMapStore.slots.some(x => x.modelUid === uid)) {
      showCustomAlert('该槽位已存在映射，请勿重复添加。', '添加失败', 'warn');
      return;
    }
    const slot = {
      modelUid: uid,
      displayName: display,
      enabled: true,
      supportsImages,
      useThirdPartyVision: false,
      targets: targetsWithSlotRoute(applyThinkingEffortToTargets(selectedMappingTargets, thinkingEffort), uid)
    };
    applySlotContextWindow(slot, contextWindow);
    modelMapStore.slots.push(slot);
  }
  if (await persistModelMap()) {
    closeSlotEditor();
    await renderModelMap();
    addLog('ok', '已保存映射');
  } else {
    modelMapStore = cloneModelMapStore(previous);
    await renderModelMap();
  }
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.openSlotEditor = openSlotEditor;
  g.closeSlotEditor = closeSlotEditor;
  g.setSlotContextPreset = setSlotContextPreset;
  g.refreshSlotContextRecommendHint = refreshSlotContextRecommendHint;
  g.applyRecommendedSlotContextWindow = applyRecommendedSlotContextWindow;
  g.saveSlotFromEditor = saveSlotFromEditor;
})(globalThis);
