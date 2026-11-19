// model-map/slot-editor-catalog.js — 槽位编辑弹窗目录网格、目标路由与作用域切换
import { escapeHtml, escAttr } from '../ui/dom.js';

// ─── 添加映射模态框 ───
globalThis.selectedSlotUid = '';
globalThis.selectedMappingTargets = []; // [{providerId, model, apiFormat?, unlock?}]
globalThis.slotDisplayNameMode = 'mapped'; // 添加映射时默认使用映射模型名
globalThis.slotCatalogScope = 'account';
globalThis.slotWasManuallySelected = false;
globalThis.AUTO_ROUTE_VALUE = 'auto';

function normalizeMappingUnlock(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === 'codex') return 'codex';
  if (raw === 'claudeCode' || raw === 'claude-code' || raw === 'claude_code') return 'claudeCode';
  return '';
}

function normalizeMappingApiFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic') return 'anthropic';
  return '';
}

function apiFormatForMappingUnlock(unlock) {
  if (unlock === 'codex') return 'openai';
  if (unlock === 'claudeCode') return 'anthropic';
  return '';
}

function mappingProviderUnlockEnabled(p, kind) {
  const unlock = p?.unlocks?.[kind];
  return !!(unlock && unlock.enabled !== false);
}

function targetRouteLabel(target) {
  const unlock = normalizeMappingUnlock(target?.unlock);
  if (unlock === 'codex') return 'Codex 解锁';
  if (unlock === 'claudeCode') return 'Claude Code 解锁';
  const fmt = normalizeMappingApiFormat(target?.apiFormat || target?.api_format);
  if (fmt === 'openai') return 'OpenAI';
  if (fmt === 'anthropic') return 'Anthropic';
  if (fmt === 'gemini') return 'Gemini';
  return '自动';
}

function unlockKindForSlotUid(uid) {
  const provider = String(slotModelOf(uid)?.provider || '').trim().toLowerCase();
  if (provider === 'openai') return 'codex';
  if (provider === 'anthropic') return 'claudeCode';
  const u = String(uid || '').toLowerCase();
  if (u.includes('claude') || u.includes('opus') || u.includes('sonnet') || u.includes('fable') || u.includes('haiku')) return 'claudeCode';
  if (u.includes('gpt') || u.includes('swe') || u.startsWith('o1') || u.startsWith('o3') || u.startsWith('o4')) return 'codex';
  return '';
}

function preferredRouteForSlotTarget(slotUid, providerId) {
  const preferredUnlock = unlockKindForSlotUid(slotUid);
  const p = (providerStore.providers || []).find(x => x.id === providerId);
  if (preferredUnlock && mappingProviderUnlockEnabled(p, preferredUnlock)) return preferredUnlock;
  // 供应商未开启对应解锁时，不硬编码 apiFormat（Claude 槽位≠上游一定是 anthropic）。
  // 返回 AUTO 让运行时根据供应商 apiPath / host 自动推断协议格式。
  return AUTO_ROUTE_VALUE;
}

function applyRouteToTarget(out, routeValue) {
  if (!routeValue || routeValue === AUTO_ROUTE_VALUE) {
    delete out.unlock;
    delete out.apiFormat;
    return out;
  }
  const unlock = normalizeMappingUnlock(routeValue);
  if (unlock) {
    out.unlock = unlock;
    out.apiFormat = apiFormatForMappingUnlock(unlock);
    return out;
  }
  const fmt = normalizeMappingApiFormat(routeValue);
  if (fmt) {
    delete out.unlock;
    out.apiFormat = fmt;
  }
  return out;
}

function targetRouteValue(target, slotUid) {
  const unlock = normalizeMappingUnlock(target?.unlock);
  if (unlock) return unlock;
  const fmt = normalizeMappingApiFormat(target?.apiFormat || target?.api_format);
  if (fmt) return fmt;
  return AUTO_ROUTE_VALUE;
}

// 思考档位选项：auto=跟随 Devin modelUid 解析；off=显式关闭；其余按目标族词表钳制。
export const THINKING_EFFORT_OPTIONS = [
  ['auto', '思考·自动'],
  ['off', '思考·关闭'],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
];

function targetWithSlotRoute(target, slotUid) {
  const providerId = String(target?.providerId || '').trim();
  const model = String(target?.model || '').trim();
  const out = { providerId, model };
  applyRouteToTarget(out, targetRouteValue(target, slotUid));
  const apiPath = String(target?.apiPath || target?.api_path || '').trim();
  if (apiPath) out.apiPath = apiPath;
  // 思考档位：auto/空 = 默认行为，不落盘；其余值保留
  const effort = String(target?.thinkingEffort || target?.thinking_effort || '').trim().toLowerCase();
  if (effort && effort !== 'auto') out.thinkingEffort = effort;
  return out;
}

function targetWithPreferredRoute(target, slotUid) {
  const providerId = String(target?.providerId || '').trim();
  const out = targetWithSlotRoute(target, slotUid);
  return applyRouteToTarget(out, preferredRouteForSlotTarget(slotUid, providerId));
}

function targetsWithSlotRoute(targets, slotUid) {
  return (Array.isArray(targets) ? targets : [])
    .filter(t => t && t.providerId)
    .map(t => targetWithSlotRoute(t, slotUid));
}

function getAllProviderModels() {
  const list = [];

  // 1. 内置 AnyBridge 内置供应商模型
  if (typeof localProxyProviderModelsEntry === 'function') {
    const lp = localProxyProviderModelsEntry();
    if (lp && Array.isArray(lp.models) && lp.models.length > 0) {
      lp.models.forEach(m => {
        const modelId = typeof m === 'string' ? m : (m.id || m.name);
        if (modelId) {
          list.push({
            providerId: lp.providerId,
            providerName: lp.providerName || 'AnyBridge',
            model: modelId,
            isLocalProxy: true,
            meta: { localProxy: true, builtin: true }
          });
        }
      });
    }
  }

  // 2. 遍历其他启用的供应商（排除重复的内置供应商）
  (providerStore.providers || []).forEach(p => {
    if (p.enabled !== false && p.meta?.codexConfig !== true && !isLocalProxyProvider(p)) {
      const models = Array.isArray(p.models) && p.models.length > 0 ? p.models : (p.defaultModel ? [p.defaultModel] : []);
      models.forEach(m => {
        const modelId = typeof m === 'string' ? m : (m.id || m.name);
        if (modelId) {
          list.push({
            providerId: p.id,
            providerName: p.name,
            model: modelId,
            meta: p.meta
          });
        }
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

  // 渲染供应商快速筛选栏
  const providerBar = document.getElementById('mappingCatalogProviderBar');
  const providerIds = [...new Set(allModels.map(m => m.providerId))];

  // 排序供应商筛选胶囊：内置供应商（AnyBridge 第一、CPA 第二、其它内置第三）固定靠前排在最前面，其余常规第三方供应商按名称字母正序排序
  providerIds.sort((a, b) => {
    const provA = (providerStore.providers || []).find(p => p.id === a || p.providerId === a)
      || (a === (globalThis.LOCAL_PROXY_PROVIDER_ID || 'anybridge-local-proxy') ? { id: a, name: 'AnyBridge', meta: { localProxy: true } } : { id: a, name: a });
    const provB = (providerStore.providers || []).find(p => p.id === b || p.providerId === b)
      || (b === (globalThis.LOCAL_PROXY_PROVIDER_ID || 'anybridge-local-proxy') ? { id: b, name: 'AnyBridge', meta: { localProxy: true } } : { id: b, name: b });

    const rankA = typeof builtinProxySortRank === 'function' ? builtinProxySortRank(provA) : (typeof isAnyBridgeLocalProxy === 'function' && isAnyBridgeLocalProxy(provA) ? 1 : (typeof isCpaLocalProxy === 'function' && isCpaLocalProxy(provA) ? 2 : 999));
    const rankB = typeof builtinProxySortRank === 'function' ? builtinProxySortRank(provB) : (typeof isAnyBridgeLocalProxy === 'function' && isAnyBridgeLocalProxy(provB) ? 1 : (typeof isCpaLocalProxy === 'function' && isCpaLocalProxy(provB) ? 2 : 999));

    if (rankA !== rankB) return rankA - rankB;
    const nameA = String(provA.name || provA.providerName || a).toLowerCase();
    const nameB = String(provB.name || provB.providerName || b).toLowerCase();
    return nameA.localeCompare(nameB, 'zh-CN');
  });

  if (providerBar) {
    if (providerIds.length > 1) {
      const providerNames = {};
      allModels.forEach(m => { providerNames[m.providerId] = m.providerName; });
      providerBar.innerHTML = `
        <button data-set="mappingCatalogProvider" data-set-value="" data-action="renderMappingModelCatalog" style="height:26px;padding:0 9px;border-radius:6px;border:1px solid ${!mappingCatalogProvider ? 'var(--accent)' : 'var(--border)'};background:${!mappingCatalogProvider ? 'var(--accent-light)' : 'transparent'};color:${!mappingCatalogProvider ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px;font-weight:700;cursor:pointer;">全部 ${allModels.length}</button>
        ${providerIds.map(pid => {
          const prov = (providerStore.providers || []).find(p => p.id === pid || p.providerId === pid) || (pid === (globalThis.LOCAL_PROXY_PROVIDER_ID || 'anybridge-local-proxy') ? { id: pid, name: 'AnyBridge', meta: { localProxy: true } } : { id: pid, name: pid });
          const isBuiltin = typeof isBuiltinProxyEntry === 'function' ? isBuiltinProxyEntry(prov) : ((typeof isAnyBridgeLocalProxy === 'function' && isAnyBridgeLocalProxy(prov)) || (typeof isCpaLocalProxy === 'function' && isCpaLocalProxy(prov)));
          const isSelected = mappingCatalogProvider === pid;
          const count = allModels.filter(m => m.providerId === pid).length;
          const name = providerNames[pid] || pid;
          return `
            <button data-set="mappingCatalogProvider" data-set-value="${escAttr(pid)}" data-action="renderMappingModelCatalog" style="height:26px;padding:0 9px;border-radius:6px;border:1px solid ${isSelected ? 'var(--accent)' : (isBuiltin ? 'rgba(37,99,235,0.28)' : 'var(--border)')};background:${isSelected ? 'var(--accent-light)' : (isBuiltin ? 'rgba(37,99,235,0.06)' : 'transparent')};color:${isSelected ? 'var(--accent)' : (isBuiltin ? 'var(--accent)' : 'var(--text-muted)')};font-size:12px;font-weight:700;cursor:pointer;">${isBuiltin ? '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent);margin-right:4px;vertical-align:middle;"></span>' : ''}${escAttr(name)} ${count}</button>
          `;
        }).join('')}
      `;
      providerBar.style.display = 'flex';
    } else {
      providerBar.style.display = 'none';
    }
  }

  // 过滤 + 排序
  const filtered = allModels
    .filter(item => {
      if (mappingCatalogProvider && item.providerId !== mappingCatalogProvider) return false;
      return !query ||
        item.providerName.toLowerCase().includes(query) ||
        item.model.toLowerCase().includes(query);
    });

  const sortKey = mappingCatalogSort || 'name-asc';
  if (sortKey === 'name-desc') {
    filtered.sort((a, b) => b.model.localeCompare(a.model));
  } else {
    filtered.sort((a, b) => a.model.localeCompare(b.model));
  }

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

    const modelIconHtml = typeof renderModelIcon === 'function'
      ? renderModelIcon(item.model)
      : `<div class="model-item-icon fallback">${globalThis.DEFAULT_MODEL_FALLBACK_SVG || ''}</div>`;

    return `
      <div class="mapping-catalog-item ${isSelected ? 'selected' : ''}"
           data-action="toggleMappingModelTarget" data-args="[&quot;${escAttr(item.providerId)}&quot;,&quot;${escAttr(item.model)}&quot;]"
           style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}; background:${isSelected ? 'var(--accent-light)' : 'var(--bg-card)'}; cursor:pointer; border-radius:10px; gap:12px; transition:all 0.2s; box-shadow:${isSelected ? '0 0 12px var(--accent-glow)' : 'none'};">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          ${modelIconHtml}
          <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
            <span style="font-size:12px; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${escAttr(item.model)}
            </span>
            <span style="font-size:12px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-flex; align-items:center;">
              ${escAttr(item.providerName)}${item.isLocalProxy || (typeof isCpaLocalProxy === 'function' && isCpaLocalProxy({ id: item.providerId, name: item.providerName })) ? '<span style="font-size:12px;margin-left:5px;padding:1px 6px;border-radius:4px;background:rgba(37,99,235,0.1);color:var(--accent);font-weight:700;line-height:1.4;">内置供应商</span>' : ''}
            </span>
          </div>
        </div>
        <div style="flex-shrink:0; display:flex; align-items:center; gap:6px;">
          ${isSelected ? `
            <span class="brand-tag" style="background:${badgeColor}; color:#fff; border:none; padding: 3px 10px; font-size: 12px; font-weight:700; border-radius: var(--radius-pill);">
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
    selectedMappingTargets.push(targetWithPreferredRoute({ providerId, model }, selectedSlotUid));
  }
  renderMappingModelCatalog();
  maybeAutoSelectRecommendedSlot();
  // 映射目标变化时，若当前为「使用映射模型名」则同步显示名
  if (slotDisplayNameMode === 'mapped') {
    applyDisplayNameByMode();
  }
  refreshSlotContextRecommendHint();
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
  if (!slotMatchesScope(recommended, used)) {
    slotCatalogScope = 'all';
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

  // 0. 基于 scope 过滤基础集
  const scoped = (ideModels || []).filter(m => slotMatchesScope(m, used));

  // 渲染品牌快速筛选栏
  const brandBar = document.getElementById('slotCatalogBrandBar');
  const availableBrands = getAvailableBrands(scoped, m => m.name, m => m.id);
  if (brandBar) {
    if (availableBrands.length > 0) {
      brandBar.innerHTML = `
        <button data-set="slotCatalogBrand" data-set-value="" data-action="renderSlotCatalogList" style="height:26px;padding:0 9px;border-radius:6px;border:1px solid ${!slotCatalogBrand ? 'var(--accent)' : 'var(--border)'};background:${!slotCatalogBrand ? 'var(--accent-light)' : 'transparent'};color:${!slotCatalogBrand ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px;font-weight:700;cursor:pointer;">全部</button>
        ${availableBrands.map(b => `
          <button data-set="slotCatalogBrand" data-set-value="${b.id}" data-action="renderSlotCatalogList" style="height:26px;padding:0 9px;border-radius:6px;border:1px solid ${slotCatalogBrand === b.id ? 'var(--accent)' : 'var(--border)'};background:${slotCatalogBrand === b.id ? 'var(--accent-light)' : 'transparent'};color:${slotCatalogBrand === b.id ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px;font-weight:700;cursor:pointer;">${b.label}</button>
        `).join('')}
      `;
      brandBar.style.display = 'flex';
    } else {
      brandBar.style.display = 'none';
    }
  }

  // 1. 基于 query + 品牌 + 排序过滤
  const filtered = scoped
    .filter(m => {
      const hay = `${m.name || ''} ${m.id || ''} ${m.api_id || ''}`.toLowerCase();
      return !query || hay.includes(query);
    })
    .filter(m => {
      if (!slotCatalogBrand) return true;
      return detectModelBrand(m.name, m.id) === slotCatalogBrand;
    });

  // 排序
  const sortKey = slotCatalogSort || 'name-asc';
  if (sortKey === 'name-desc') {
    filtered.sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || b.name.localeCompare(a.name));
  } else {
    filtered.sort((a, b) => slotRecommendationRank(a, used) - slotRecommendationRank(b, used) || a.name.localeCompare(b.name));
  }

  // 2. 统计可用未占用的槽位数量
  const availableCount = filtered.filter(m => !used.has(m.id)).length;
  if (countEl) countEl.textContent = `${availableCount} 可用 / ${filtered.length} 显示`;

  if (filtered.length === 0) {
    if (slotCatalogScope === 'account') {
      const accountTotal = (ideModels || []).filter(isAccountSlotModel).length;
      const emptyTitle = accountTotal > 0
        ? '当前筛选下没有匹配的账号槽位'
        : '还没有当前账号槽位数据';
      const emptyHint = accountTotal > 0
        ? '当前账号已有槽位数据，但被搜索词或品牌筛选过滤掉了。可清空筛选，或先查看全部/内置槽位。'
        : '需要先通过网关抓取 Windsurf 下拉清单，或点击刷新读取当前 IDE 账号模型。';
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;color:var(--text-muted);padding:30px 16px;font-size:12px;line-height:1.55;">
          <div style="font-weight:700;color:var(--text-secondary);">${emptyTitle}</div>
          <div>${emptyHint}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
            <button class="btn-ghost" data-action="refreshIdeModels" style="height:30px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:700;">刷新当前账号</button>
            <button class="btn-primary" data-action="setSlotCatalogScope" data-arg="all" style="height:30px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:700;">查看全部槽位</button>
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
    const takenTag = taken ? `<span class="brand-tag" style="background:var(--bg-secondary); color:var(--text-muted); border: 1px solid var(--border); padding: 2px 7px; font-size: 12px; font-weight:normal;">已绑定</span>` : '';
    const displayId = m.api_id || m.id;
    const visionTag = renderVisionPill(nativeVisionSlotInfo(m.id), true);
    const sourceTag = renderSourcePill(slotSourceInfo(m), true);
    const recommended = !taken && slotRecommendationRank(m, used) < 0;
    const recommendedTag = recommended ? `<span class="brand-tag" style="background:rgba(37,99,235,.10);color:var(--accent);border:1px solid rgba(37,99,235,.22);padding:2px 7px;font-size:12px;font-weight:700;">推荐</span>` : '';

    // 槽位模型图标：优先识别真实品牌 key（兼顾可读名 m.name 与底层 id 如 MODEL_PRIVATE_11）
    const slotIconKey = typeof getModelIconKey === 'function'
      ? (getModelIconKey(m.name) || getModelIconKey(m.id) || getModelIconKey(m.api_id))
      : null;
    const modelIconHtml = typeof renderModelIcon === 'function'
      ? renderModelIcon(slotIconKey || m.name || m.id)
      : `<div class="model-item-icon fallback">${globalThis.DEFAULT_MODEL_FALLBACK_SVG || ''}</div>`;

    const leftIcon = `
      <div class="slot-item-icon-wrap" style="position:relative;width:24px;height:24px;flex-shrink:0;">
        ${modelIconHtml}
        ${isSelected ? '<span style="position:absolute;bottom:-3px;right:-3px;width:16px;height:16px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;box-shadow:0 0 0 1.5px var(--bg-card,#fff);line-height:1;">✓</span>' : ''}
      </div>
    `;

    // 渲染具有极致质感的左侧行卡片，支持选中态发光与锁定态置灰
    return `
      <div class="slot-catalog-item ${isSelected ? 'selected' : ''} ${taken ? 'taken' : ''}"
           ${taken ? '' : `data-action="selectCatalogSlot" data-args="[&quot;${escAttr(m.id)}&quot;,&quot;${escAttr(m.name)}&quot;]"`}
           style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}; background:${isSelected ? 'var(--accent-light)' : 'var(--bg-card)'}; opacity:${taken ? '0.5' : '1'}; cursor:${taken ? 'not-allowed' : 'pointer'}; border-radius:10px; gap:12px; transition:all 0.2s; box-shadow:${isSelected ? '0 0 12px var(--accent-glow)' : 'none'};">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          ${leftIcon}
          <div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0;">
            <span style="font-size:12px; font-weight:600; color:${isSelected ? 'var(--accent)' : 'var(--text-primary)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:all 0.2s;">${escAttr(m.name)}</span>
            <span style="font-size:12px; color:var(--text-muted); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escAttr(displayId)}</span>
          </div>
        </div>
        <div style="flex-shrink:0; display:flex; align-items:center; gap:6px;">
          ${sourceTag}
          ${visionTag}
          ${recommendedTag}
          ${takenTag}
        </div>
      </div>
    `;
  }).join('');
}

function selectCatalogSlot(uid, name) {
  const editingUid = document.getElementById('slot-edit-uid').value;

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

  // 按当前显示名模式同步输入框（默认 mapped：用映射模型名）
  applyDisplayNameByMode();

  // 重新绘制左侧以更新高亮
  renderSlotCatalogList();
}

function useOriginalModelName() {
  slotDisplayNameMode = 'original';
  applyDisplayNameByMode();
}

function useMappedModelName() {
  slotDisplayNameMode = 'mapped';
  applyDisplayNameByMode();
}

function applyDisplayNameByMode() {
  const displayInput = document.getElementById('slot-display');
  if (!displayInput) return;
  if (slotDisplayNameMode === 'mapped') {
    const firstTarget = selectedMappingTargets && selectedMappingTargets[0];
    displayInput.value = firstTarget ? firstTarget.model : '';
  } else {
    const uid = selectedSlotUid || document.getElementById('slot-uid-select')?.value || document.getElementById('slot-edit-uid')?.value;
    displayInput.value = uid ? originalNameOf(uid) : '';
  }
  updateDisplayNameButtons(slotDisplayNameMode);
}

function updateDisplayNameButtons(active) {
  slotDisplayNameMode = active === 'mapped' ? 'mapped' : 'original';
  // 原 "使用原始模型名" / "使用映射模型名" 按钮已从 UI 移除，
  // 仅保留模式状态，用于自动填充 slot-display 输入框。
}

function filterSlotCatalog() {
  renderSlotCatalogList();
}

// ---- P3 globalThis mirror ----
(function mirrorFns(g) {
  g.normalizeMappingUnlock = normalizeMappingUnlock;
  g.normalizeMappingApiFormat = normalizeMappingApiFormat;
  g.apiFormatForMappingUnlock = apiFormatForMappingUnlock;
  g.mappingProviderUnlockEnabled = mappingProviderUnlockEnabled;
  g.targetRouteLabel = targetRouteLabel;
  g.unlockKindForSlotUid = unlockKindForSlotUid;
  g.preferredRouteForSlotTarget = preferredRouteForSlotTarget;
  g.applyRouteToTarget = applyRouteToTarget;
  g.targetRouteValue = targetRouteValue;
  g.targetWithSlotRoute = targetWithSlotRoute;
  g.targetWithPreferredRoute = targetWithPreferredRoute;
  g.targetsWithSlotRoute = targetsWithSlotRoute;
  g.getAllProviderModels = getAllProviderModels;
  g.getProviderLogoClass = getProviderLogoClass;
  g.renderMappingModelCatalog = renderMappingModelCatalog;
  g.toggleMappingModelTarget = toggleMappingModelTarget;
  g.slotCatalogStats = slotCatalogStats;
  g.updateSlotScopeTabs = updateSlotScopeTabs;
  g.setSlotCatalogScope = setSlotCatalogScope;
  g.slotMatchesScope = slotMatchesScope;
  g.slotRecommendationRank = slotRecommendationRank;
  g.pickRecommendedSlot = pickRecommendedSlot;
  g.maybeAutoSelectRecommendedSlot = maybeAutoSelectRecommendedSlot;
  g.renderSlotCatalogList = renderSlotCatalogList;
  g.selectCatalogSlot = selectCatalogSlot;
  g.useOriginalModelName = useOriginalModelName;
  g.useMappedModelName = useMappedModelName;
  g.applyDisplayNameByMode = applyDisplayNameByMode;
  g.updateDisplayNameButtons = updateDisplayNameButtons;
  g.filterSlotCatalog = filterSlotCatalog;
})(globalThis);
